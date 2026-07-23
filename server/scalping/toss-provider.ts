import type { MarketQuery, ReadOnlyMarketFeature } from "../market.js";
import {
  NormalizedMinuteCandleSchema,
  NormalizedOrderbookSchema,
  NormalizedPriceSchema,
  NormalizedRankingSchema,
  NormalizedTradeSchema,
  NormalizedWarningSchema,
  isoTimestampSchema,
  normalizeUsExchange,
  sessionDateSchema,
  type MarketCountry,
  type NormalizedMinuteCandle,
  type NormalizedOrderbook,
  type NormalizedPrice,
  type NormalizedRanking,
  type NormalizedTrade,
  type NormalizedWarning,
  type ScannerCriterion,
} from "./contracts.js";
import {
  AdaptiveRateLimiter,
  ProviderRequestError,
  TtlCache,
  retryWithBackoff,
  type AdaptiveRateLimiterConfig,
  type ProviderHeaders,
  type RetryConfig,
} from "./rate-limiter.js";
import {
  DEFAULT_US_EXTENDED_SESSION_WINDOWS,
  marketTradingSessionDate,
} from "./market-session.js";

type UnknownRecord = Record<string, unknown>;

export type TossRawMarketResponse = {
  feature: ReadOnlyMarketFeature;
  upstreamPath: string;
  fetchedAt: string;
  data: unknown;
  headers?: ProviderHeaders;
};

export type TossRawMarketClient = {
  getReadOnlyMarketData(feature: ReadOnlyMarketFeature, query: MarketQuery): Promise<TossRawMarketResponse>;
};

export type TossRateLimitGroup = "ranking" | "market_data" | "chart" | "stock" | "market_info";
export type TossRankingCriterion = Extract<ScannerCriterion, "trading_amount" | "volume"> | "change_rate";

export type TossMarketSessionPeriod = { startAt: string; endAt: string };

export type TossMarketCalendarDay = {
  marketCountry: MarketCountry;
  sessionDate: string;
  dayMarket: TossMarketSessionPeriod | null;
  preMarket: TossMarketSessionPeriod | null;
  regularMarket: TossMarketSessionPeriod | null;
  afterMarket: TossMarketSessionPeriod | null;
};

export type TossProviderConfig = {
  rankingMaximumCount: number;
  pricesBatchSize: number;
  candlesMaximumCount: number;
  tradesMaximumCount: number;
  cacheMaximumEntries: number;
  cacheTtlMs: {
    rankings: number;
    prices: number;
    candles: number;
    orderbook: number;
    trades: number;
    warnings: number;
    calendar: number;
  };
  retry: RetryConfig;
  rateLimits: Record<TossRateLimitGroup, AdaptiveRateLimiterConfig>;
  now?: () => number;
};

export class TossProviderContractError extends Error {
  constructor(public readonly feature: string, message: string) {
    super(`Invalid Toss ${feature} response: ${message}`);
    this.name = "TossProviderContractError";
  }
}

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function resultValue(payload: unknown): unknown {
  if (!isRecord(payload)) return payload;
  return payload.result ?? payload.data ?? payload;
}

function resultRecord(payload: unknown, feature: string): UnknownRecord {
  const value = resultValue(payload);
  if (!isRecord(value)) throw new TossProviderContractError(feature, "expected an object result");
  return value;
}

function rows(payload: unknown, feature: string, keys: string[]): UnknownRecord[] {
  const value = resultValue(payload);
  if (Array.isArray(value)) {
    if (!value.every(isRecord)) throw new TossProviderContractError(feature, "result array contains a non-object row");
    return value;
  }
  if (!isRecord(value)) throw new TossProviderContractError(feature, "expected an object or array result");
  for (const key of keys) {
    if (value[key] !== undefined) {
      if (!Array.isArray(value[key]) || !(value[key] as unknown[]).every(isRecord)) {
        throw new TossProviderContractError(feature, `${key} must be an object array`);
      }
      return value[key] as UnknownRecord[];
    }
  }
  throw new TossProviderContractError(feature, `missing ${keys.join("/")} array`);
}

function pick(record: UnknownRecord, keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) return record[key];
  }
  return undefined;
}

function text(record: UnknownRecord, keys: string[]): string | undefined {
  const value = pick(record, keys);
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return undefined;
}

function numberValue(record: UnknownRecord, keys: string[]): number | undefined {
  const value = pick(record, keys);
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/[,%\s]/g, "");
  if (!normalized) return undefined;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function requiredText(record: UnknownRecord, keys: string[], feature: string, field: string): string {
  const value = text(record, keys);
  if (!value) throw new TossProviderContractError(feature, `${field} is missing`);
  return value;
}

function requiredNumber(record: UnknownRecord, keys: string[], feature: string, field: string): number {
  const value = numberValue(record, keys);
  if (value === undefined) throw new TossProviderContractError(feature, `${field} is missing or non-numeric`);
  return value;
}

function timestamp(value: unknown, feature: string, field: string): string {
  const candidate = typeof value === "string" ? value.trim() : "";
  const parsed = isoTimestampSchema.safeParse(candidate);
  if (!parsed.success) throw new TossProviderContractError(feature, `${field} must be an RFC3339 timestamp`);
  return parsed.data;
}

function sessionDateAt(value: string, marketCountry: MarketCountry): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: marketCountry === "US" ? "America/New_York" : "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(value));
  const fields = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${fields.year}-${fields.month}-${fields.day}`;
}

function calendarDayOffset(value: string, sessionDate: string, marketCountry: MarketCountry): number {
  const localDate = sessionDateAt(value, marketCountry);
  const localEpoch = Date.parse(`${localDate}T00:00:00.000Z`);
  const sessionEpoch = Date.parse(`${sessionDate}T00:00:00.000Z`);
  if (!Number.isFinite(localEpoch) || !Number.isFinite(sessionEpoch)) {
    throw new TossProviderContractError("market-calendar", "session date offset could not be resolved");
  }
  return Math.round((localEpoch - sessionEpoch) / 86_400_000);
}

function calendarPeriod(
  container: UnknownRecord,
  field: "dayMarket" | "preMarket" | "regularMarket" | "afterMarket",
  fieldPrefix: string,
  marketCountry: MarketCountry,
  sessionDate: string,
  expectedStartOffset: -1 | 0,
  expectedEndOffset: 0,
): TossMarketSessionPeriod | null {
  const value = container[field];
  if (value === null) return null;
  if (!isRecord(value)) {
    throw new TossProviderContractError("market-calendar", `${fieldPrefix}.${field} must be an object or null`);
  }
  const startAt = timestamp(value.startTime, "market-calendar", `${fieldPrefix}.${field}.startTime`);
  const endAt = timestamp(value.endTime, "market-calendar", `${fieldPrefix}.${field}.endTime`);
  if (Date.parse(startAt) >= Date.parse(endAt)) {
    throw new TossProviderContractError("market-calendar", `${field} start must precede end`);
  }
  if (calendarDayOffset(startAt, sessionDate, marketCountry) !== expectedStartOffset
    || calendarDayOffset(endAt, sessionDate, marketCountry) !== expectedEndOffset) {
    throw new TossProviderContractError("market-calendar", `${field} timestamps do not match today.date`);
  }
  return { startAt, endAt };
}

function parseWithContract<T>(
  feature: string,
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } } },
  value: unknown,
): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  throw new TossProviderContractError(feature, `${issue?.path.join(".") || "value"}: ${issue?.message || "invalid"}`);
}

function currency(record: UnknownRecord, marketCountry: MarketCountry, feature: string): string {
  const value = requiredText(record, ["currency", "currencyCode"], feature, "currency").toUpperCase();
  if ((marketCountry === "KR" && value !== "KRW") || (marketCountry === "US" && value !== "USD")) {
    throw new TossProviderContractError(feature, `currency ${value} does not match market ${marketCountry}`);
  }
  return value;
}

function normalizeTossMarketCalendarDay(
  payload: unknown,
  marketCountry: MarketCountry,
  requestedDate: string,
): TossMarketCalendarDay {
  const feature = "market-calendar";
  const result = resultRecord(payload, feature);
  const today = result.today;
  if (!isRecord(today)) throw new TossProviderContractError(feature, "today must be an object");
  const providerDate = requiredText(today, ["date"], feature, "today.date");
  if (providerDate !== requestedDate || !sessionDateSchema.safeParse(providerDate).success) {
    throw new TossProviderContractError(feature, "today.date does not match the requested date");
  }

  // Toss exposes the KR integrated KRX/NXT day below `integrated`, while the
  // US calendar exposes four nullable top-level sessions. Do not fall back
  // between these shapes: accepting the other country's shape could turn a
  // malformed response into an apparently confirmed trading session.
  const container = marketCountry === "KR" ? today.integrated : today;
  if (container === null) {
    if (marketCountry !== "KR") {
      throw new TossProviderContractError(feature, "today must contain US market-session states");
    }
    return {
      marketCountry, sessionDate: providerDate,
      dayMarket: null, preMarket: null, regularMarket: null, afterMarket: null,
    };
  }
  if (!isRecord(container)) {
    throw new TossProviderContractError(
      feature,
      marketCountry === "KR" ? "today.integrated must be an object or null" : "today must be an object",
    );
  }

  if (marketCountry === "KR") {
    if (!isRecord(container.regularMarket)) {
      throw new TossProviderContractError(feature, "today.integrated.regularMarket must be an object");
    }
    return {
      marketCountry,
      sessionDate: providerDate,
      dayMarket: null,
      preMarket: null,
      regularMarket: calendarPeriod(container, "regularMarket", "today.integrated", "KR", providerDate, 0, 0),
      afterMarket: null,
    };
  }

  const dayMarket = calendarPeriod(container, "dayMarket", "today", "US", providerDate, -1, 0);
  const preMarket = calendarPeriod(container, "preMarket", "today", "US", providerDate, 0, 0);
  const regularMarket = calendarPeriod(container, "regularMarket", "today", "US", providerDate, 0, 0);
  const afterMarket = calendarPeriod(container, "afterMarket", "today", "US", providerDate, 0, 0);
  const ordered = [dayMarket, preMarket, regularMarket, afterMarket].filter(
    (period): period is TossMarketSessionPeriod => period !== null,
  );
  for (let index = 1; index < ordered.length; index += 1) {
    if (Date.parse(ordered[index]!.startAt) < Date.parse(ordered[index - 1]!.endAt)) {
      throw new TossProviderContractError(feature, "US market sessions must be ordered and non-overlapping");
    }
  }
  return { marketCountry, sessionDate: providerDate, dayMarket, preMarket, regularMarket, afterMarket };
}

export function normalizeTossRankings(
  payload: unknown,
  fetchedAt: string,
  marketCountry: MarketCountry,
): NormalizedRanking[] {
  const feature = "rankings";
  const result = resultRecord(payload, feature);
  const list = rows(payload, feature, ["rankings", "items"]);
  if (!list.length) return [];
  const rankedAt = timestamp(result.rankedAt ?? fetchedAt, feature, "rankedAt");
  return list.map((row) => {
    // OpenAPI v1.2.4 nests last/base/change values under `price`; retain the
    // scalar aliases for compatibility with older recorded fixtures.
    const price = isRecord(row.price) ? row.price : row;
    const basePrice = numberValue(price, ["basePrice", "previousClosePrice"]);
    const changeRateRatio = numberValue(price, ["changeRate", "changeRateRatio"])
      ?? numberValue(row, ["changeRate", "changeRateRatio"]);
    const volume = numberValue(row, ["tradingVolume", "volume", "accumulatedVolume"]);
    const tradingAmount = numberValue(row, ["tradingAmount", "accumulatedTradingAmount"]);
    const exchange = marketCountry === "US"
      ? normalizeUsExchange(pick(row, ["exchange", "exchangeCode", "market", "marketCode"]))
      : undefined;
    return parseWithContract(feature, NormalizedRankingSchema, {
      provider: "toss",
      symbol: requiredText(row, ["symbol", "stockCode", "code"], feature, "symbol"),
      ...(text(row, ["name", "stockName", "symbolName"]) ? { name: text(row, ["name", "stockName", "symbolName"]) } : {}),
      marketCountry,
      ...(exchange ? { exchange } : {}),
      currency: currency(row, marketCountry, feature),
      rank: requiredNumber(row, ["rank", "ranking"], feature, "rank"),
      rankedAt,
      price: requiredNumber(price, ["lastPrice", "price", "currentPrice", "closePrice"], feature, "price"),
      ...(basePrice === undefined ? {} : { basePrice }),
      ...(changeRateRatio === undefined ? {} : { changeRateRatio }),
      ...(volume === undefined ? {} : { volume }),
      ...(tradingAmount === undefined ? {} : { tradingAmount }),
    });
  });
}

export function normalizeTossPrices(payload: unknown, fetchedAt: string): NormalizedPrice[] {
  const feature = "prices";
  return rows(payload, feature, ["prices", "items"]).map((row) => {
    const rawCurrency = requiredText(row, ["currency", "currencyCode"], feature, "currency").toUpperCase();
    return parseWithContract(feature, NormalizedPriceSchema, {
      provider: "toss",
      symbol: requiredText(row, ["symbol", "stockCode", "code"], feature, "symbol"),
      currency: rawCurrency,
      observedAt: timestamp(pick(row, ["timestamp", "dateTime", "updatedAt"]) ?? fetchedAt, feature, "observedAt"),
      price: requiredNumber(row, ["lastPrice", "price", "currentPrice", "closePrice"], feature, "price"),
      ...(numberValue(row, ["basePrice", "previousClosePrice"]) === undefined ? {} : {
        basePrice: numberValue(row, ["basePrice", "previousClosePrice"]),
      }),
      ...(numberValue(row, ["changeRate", "changeRateRatio"]) === undefined ? {} : {
        changeRateRatio: numberValue(row, ["changeRate", "changeRateRatio"]),
      }),
      ...(numberValue(row, ["volume", "accumulatedVolume"]) === undefined ? {} : {
        volume: numberValue(row, ["volume", "accumulatedVolume"]),
      }),
      ...(numberValue(row, ["tradingAmount", "accumulatedTradingAmount"]) === undefined ? {} : {
        tradingAmount: numberValue(row, ["tradingAmount", "accumulatedTradingAmount"]),
      }),
    });
  });
}

export function normalizeTossMinuteCandles(
  payload: unknown,
  symbol: string,
  marketCountry: MarketCountry = "KR",
): NormalizedMinuteCandle[] {
  const feature = "candles";
  return rows(payload, feature, ["candles", "items"]).map((row) => {
    const observedAt = timestamp(pick(row, ["timestamp", "dateTime", "time"]), feature, "timestamp");
    const suppliedSessionDate = text(row, ["date", "businessDate", "tradeDate"]);
    const normalizedSessionDate = marketCountry === "US"
      ? marketTradingSessionDate(observedAt, "US", DEFAULT_US_EXTENDED_SESSION_WINDOWS)
        ?? suppliedSessionDate ?? sessionDateAt(observedAt, marketCountry)
      : suppliedSessionDate ?? sessionDateAt(observedAt, marketCountry);
    return parseWithContract(feature, NormalizedMinuteCandleSchema, {
      provider: "toss",
      symbol,
      timestamp: observedAt,
      sessionDate: normalizedSessionDate,
      interval: "1m",
      status: "unknown",
      open: requiredNumber(row, ["open", "openPrice", "openingPrice"], feature, "open"),
      high: requiredNumber(row, ["high", "highPrice", "highestPrice"], feature, "high"),
      low: requiredNumber(row, ["low", "lowPrice", "lowestPrice"], feature, "low"),
      close: requiredNumber(row, ["close", "closePrice", "closingPrice", "price"], feature, "close"),
      ...(numberValue(row, ["volume"]) === undefined ? {} : { volume: numberValue(row, ["volume"]) }),
      ...(numberValue(row, ["tradingAmount", "amount"]) === undefined ? {} : {
        tradingAmount: numberValue(row, ["tradingAmount", "amount"]),
      }),
    });
  }).sort((left, right) => left.timestamp.localeCompare(right.timestamp));
}

function orderbookLevels(record: UnknownRecord, side: "ask" | "bid", feature: string) {
  const array = record[side === "ask" ? "asks" : "bids"];
  let levels: UnknownRecord[] = [];
  if (array !== undefined) {
    if (!Array.isArray(array) || !array.every(isRecord)) {
      throw new TossProviderContractError(feature, `${side}s must be an object array`);
    }
    levels = array;
  } else {
    const indexed = new Map<number, UnknownRecord>();
    for (const [key, value] of Object.entries(record)) {
      const match = key.match(new RegExp(`^${side}(?:Price|Quantity)(\\d+)$`, "i"));
      if (!match) continue;
      const index = Number(match[1]);
      const current = indexed.get(index) ?? {};
      current[key.toLowerCase().includes("price") ? "price" : "quantity"] = value;
      indexed.set(index, current);
    }
    levels = Array.from(indexed.entries()).sort(([left], [right]) => left - right).map(([, level]) => level);
  }
  if (!levels.length) throw new TossProviderContractError(feature, `${side} levels are missing`);
  return levels.map((level) => ({
    price: requiredNumber(level, ["price", `${side}Price`], feature, `${side}.price`),
    quantity: requiredNumber(level, ["quantity", "volume", "remainingQuantity", `${side}Quantity`], feature, `${side}.quantity`),
  })).sort((left, right) => side === "ask" ? left.price - right.price : right.price - left.price);
}

export function normalizeTossOrderbook(payload: unknown, symbol: string, fetchedAt: string): NormalizedOrderbook {
  const feature = "orderbook";
  const result = resultRecord(payload, feature);
  return parseWithContract(feature, NormalizedOrderbookSchema, {
    provider: "toss",
    symbol: text(result, ["symbol", "stockCode"]) ?? symbol,
    observedAt: timestamp(pick(result, ["timestamp", "dateTime", "updatedAt"]) ?? fetchedAt, feature, "observedAt"),
    asks: orderbookLevels(result, "ask", feature),
    bids: orderbookLevels(result, "bid", feature),
    ...(numberValue(result, ["totalAskQuantity", "askTotalQuantity"]) === undefined ? {} : {
      totalAskQuantity: numberValue(result, ["totalAskQuantity", "askTotalQuantity"]),
    }),
    ...(numberValue(result, ["totalBidQuantity", "bidTotalQuantity"]) === undefined ? {} : {
      totalBidQuantity: numberValue(result, ["totalBidQuantity", "bidTotalQuantity"]),
    }),
  });
}

export function normalizeTossTrades(payload: unknown, symbol: string): NormalizedTrade[] {
  const feature = "trades";
  return rows(payload, feature, ["trades", "items"]).map((row, index) => {
    const executedAt = timestamp(pick(row, ["executedAt", "timestamp", "dateTime", "time"]), feature, "executedAt");
    const price = requiredNumber(row, ["price", "executionPrice", "tradePrice"], feature, "price");
    const quantity = requiredNumber(row, ["volume", "quantity", "executionQuantity", "tradeVolume"], feature, "quantity");
    const rawSide = text(row, ["side", "tradeSide"])?.toLowerCase();
    const side = rawSide === "buy" || rawSide === "bid" || rawSide === "b"
      ? "buy"
      : rawSide === "sell" || rawSide === "ask" || rawSide === "s" ? "sell" : "unknown";
    const cumulativeVolume = numberValue(row, ["cumulativeVolume", "accumulatedVolume"]);
    const eventId = text(row, ["id", "tradeId", "executionId"])
      ?? [symbol, executedAt, price, quantity, cumulativeVolume ?? "na", index].join(":");
    return parseWithContract(feature, NormalizedTradeSchema, {
      provider: "toss",
      symbol: text(row, ["symbol", "stockCode"]) ?? symbol,
      eventId,
      eventIdSource: text(row, ["id", "tradeId", "executionId"]) ? "provider" : "composite",
      executedAt,
      price,
      quantity,
      ...(numberValue(row, ["tradingAmount", "amount"]) === undefined ? {} : {
        tradingAmount: numberValue(row, ["tradingAmount", "amount"]),
      }),
      side,
      ...(cumulativeVolume === undefined ? {} : { cumulativeVolume }),
      ...(numberValue(row, ["executionStrength", "tradeStrength"]) === undefined ? {} : {
        executionStrength: numberValue(row, ["executionStrength", "tradeStrength"]),
      }),
    });
  }).sort((left, right) => left.executedAt.localeCompare(right.executedAt));
}

export function normalizeTossWarnings(payload: unknown, symbol: string, fetchedAt: string): NormalizedWarning[] {
  const feature = "warnings";
  const value = resultValue(payload);
  if (isRecord(value) && value.warnings === undefined && value.items === undefined && Object.keys(value).length === 0) return [];
  return rows(payload, feature, ["warnings", "items"]).map((row) => {
    const rawSeverity = text(row, ["severity", "level"])?.toLowerCase();
    const severity = rawSeverity === "info" || rawSeverity === "warning" || rawSeverity === "blocking"
      ? rawSeverity
      : "unknown";
    return parseWithContract(feature, NormalizedWarningSchema, {
      provider: "toss",
      symbol: text(row, ["symbol", "stockCode"]) ?? symbol,
      code: requiredText(row, ["code", "type", "warningType"], feature, "code"),
      ...(text(row, ["message", "description", "name"]) ? { message: text(row, ["message", "description", "name"]) } : {}),
      severity,
      observedAt: timestamp(pick(row, ["timestamp", "updatedAt"]) ?? fetchedAt, feature, "observedAt"),
    });
  });
}

function validatePositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
}

function validateTtl(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative finite number.`);
}

function stableKey(feature: string, query: MarketQuery): string {
  return `${feature}?${Object.entries(query).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join("&")}`;
}

export class TossScalpingProvider {
  private readonly limiters: Record<TossRateLimitGroup, AdaptiveRateLimiter>;
  private readonly cache: TtlCache<string, TossRawMarketResponse>;

  constructor(
    private readonly client: TossRawMarketClient,
    private readonly config: TossProviderConfig,
  ) {
    validatePositiveInteger("rankingMaximumCount", config.rankingMaximumCount);
    validatePositiveInteger("pricesBatchSize", config.pricesBatchSize);
    validatePositiveInteger("candlesMaximumCount", config.candlesMaximumCount);
    validatePositiveInteger("tradesMaximumCount", config.tradesMaximumCount);
    validatePositiveInteger("cacheMaximumEntries", config.cacheMaximumEntries);
    for (const [name, value] of Object.entries(config.cacheTtlMs)) validateTtl(`${name} cache TTL`, value);
    this.limiters = {
      ranking: new AdaptiveRateLimiter(config.rateLimits.ranking),
      market_data: new AdaptiveRateLimiter(config.rateLimits.market_data),
      chart: new AdaptiveRateLimiter(config.rateLimits.chart),
      stock: new AdaptiveRateLimiter(config.rateLimits.stock),
      market_info: new AdaptiveRateLimiter(config.rateLimits.market_info),
    };
    this.cache = new TtlCache({ maximumEntries: config.cacheMaximumEntries, now: config.now });
  }

  private async request(
    feature: ReadOnlyMarketFeature,
    query: MarketQuery,
    group: TossRateLimitGroup,
    ttlMs: number,
    bypassCache = false,
  ): Promise<TossRawMarketResponse> {
    const cacheKey = stableKey(feature, query);
    if (bypassCache) this.cache.delete(cacheKey);
    return this.cache.getOrLoad(cacheKey, ttlMs, async () => retryWithBackoff(async () => {
      const limiter = this.limiters[group];
      await limiter.acquire();
      try {
        const response = await this.client.getReadOnlyMarketData(feature, query);
        limiter.observe(response.headers);
        return response;
      } catch (error) {
        const candidate = error as { status?: unknown; code?: unknown; retryable?: unknown; headers?: ProviderHeaders };
        limiter.observe(candidate.headers);
        if (error instanceof ProviderRequestError) throw error;
        const status = typeof candidate.status === "number" ? candidate.status : 0;
        const retryable = candidate.retryable === true || status === 429 || status >= 500 || status === 0;
        throw new ProviderRequestError(
          error instanceof Error ? error.message : "Toss provider request failed.",
          status,
          typeof candidate.code === "string" ? candidate.code : "provider-error",
          retryable,
          candidate.headers,
        );
      }
    }, this.config.retry));
  }

  async getRankings(
    criterion: TossRankingCriterion,
    count: number,
    marketCountry: MarketCountry = "KR",
  ): Promise<NormalizedRanking[]> {
    if (!Number.isInteger(count) || count <= 0 || count > this.config.rankingMaximumCount) {
      throw new Error(`Ranking count must be between 1 and ${this.config.rankingMaximumCount}.`);
    }
    const response = await this.request("rankings", {
      type: criterion === "trading_amount" ? "MARKET_TRADING_AMOUNT"
        : criterion === "volume" ? "MARKET_TRADING_VOLUME" : "TOP_GAINERS",
      marketCountry,
      duration: criterion === "change_rate" ? "1d" : "realtime",
      excludeInvestmentCaution: "false",
      count: String(count),
    }, "ranking", this.config.cacheTtlMs.rankings);
    return normalizeTossRankings(response.data, response.fetchedAt, marketCountry);
  }

  async getPrices(symbols: string[]): Promise<NormalizedPrice[]> {
    const unique = Array.from(new Set(symbols.map((symbol) => symbol.trim()).filter(Boolean)));
    const output: NormalizedPrice[] = [];
    for (let offset = 0; offset < unique.length; offset += this.config.pricesBatchSize) {
      const batch = unique.slice(offset, offset + this.config.pricesBatchSize);
      const response = await this.request("prices", { symbols: batch.join(",") }, "market_data", this.config.cacheTtlMs.prices);
      output.push(...normalizeTossPrices(response.data, response.fetchedAt));
    }
    return output;
  }

  async getMinuteCandles(
    symbol: string,
    count: number,
    before?: string,
    marketCountry: MarketCountry = "KR",
    options: { bypassCache?: boolean } = {},
  ): Promise<NormalizedMinuteCandle[]> {
    if (!Number.isInteger(count) || count <= 0 || count > this.config.candlesMaximumCount) {
      throw new Error(`Candle count must be between 1 and ${this.config.candlesMaximumCount}.`);
    }
    if (before !== undefined) timestamp(before, "candles", "before");
    const response = await this.request("candles", {
      symbol,
      interval: "1m",
      count: String(count),
      adjusted: "false",
      ...(before ? { before } : {}),
    }, "chart", this.config.cacheTtlMs.candles, options.bypassCache === true);
    return normalizeTossMinuteCandles(response.data, symbol, marketCountry);
  }

  async getOrderbook(symbol: string): Promise<NormalizedOrderbook> {
    const response = await this.request("orderbook", { symbol }, "market_data", this.config.cacheTtlMs.orderbook);
    return normalizeTossOrderbook(response.data, symbol, response.fetchedAt);
  }

  async getTrades(symbol: string, count: number): Promise<NormalizedTrade[]> {
    if (!Number.isInteger(count) || count <= 0 || count > this.config.tradesMaximumCount) {
      throw new Error(`Trade count must be between 1 and ${this.config.tradesMaximumCount}.`);
    }
    const response = await this.request("trades", { symbol, count: String(count) }, "market_data", this.config.cacheTtlMs.trades);
    return normalizeTossTrades(response.data, symbol);
  }

  async getWarnings(symbol: string): Promise<NormalizedWarning[]> {
    const response = await this.request("warnings", { symbol }, "stock", this.config.cacheTtlMs.warnings);
    return normalizeTossWarnings(response.data, symbol, response.fetchedAt);
  }

  async getMarketCalendar(
    marketCountry: MarketCountry,
    sessionDate: string,
  ): Promise<TossMarketCalendarDay> {
    const parsedDate = sessionDateSchema.safeParse(sessionDate);
    if (!parsedDate.success) throw new Error("Market calendar date must be YYYY-MM-DD.");
    const response = await this.request("market-calendar", {
      country: marketCountry,
      date: parsedDate.data,
    }, "market_info", this.config.cacheTtlMs.calendar);
    return normalizeTossMarketCalendarDay(response.data, marketCountry, parsedDate.data);
  }

  rateLimitSnapshot(group: TossRateLimitGroup) {
    return this.limiters[group].snapshot();
  }
}
