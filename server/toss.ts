import type { AppConfig } from "./env.js";
import { buildReadOnlyMarketPath, type MarketQuery, type ReadOnlyMarketFeature } from "./market.js";
import {
  buildReadOnlyOrderDetailPath,
  buildReadOnlyOrderListPath,
  type OrderHistoryQuery,
} from "./orders.js";

type UnknownRecord = Record<string, unknown>;

export type Account = {
  id: string;
  name: string;
  label: string;
  type: string;
};

export type Holding = {
  symbol: string;
  name: string;
  market: string;
  currency: string;
  quantity: number;
  availableQuantity: number;
  averagePrice: number;
  currentPrice: number;
  purchaseAmount: number;
  evaluationAmount: number;
  profitLoss: number;
  profitRate: number;
  dailyProfitLoss: number;
  dailyProfitRate: number;
};

export type CurrencyAmounts = {
  KRW: number;
  USD: number;
};

export type Portfolio = {
  asOf: string;
  accounts: Account[];
  selectedAccountId: string;
  account: Account;
  summary: {
    evaluationAmount: CurrencyAmounts;
    purchaseAmount: CurrencyAmounts;
    profitLoss: CurrencyAmounts;
    dailyProfitLoss: CurrencyAmounts;
    profitRate: number;
    dailyProfitRate: number;
    positionCount: number;
  };
  holdings: Holding[];
};

export type HistoricalOrder = {
  orderId: string;
  symbol: string;
  side: string;
  currency: string;
  status: string;
  orderedAt: string;
  filledAt: string;
  filledQuantity: number;
  averageFilledPrice: number;
  filledAmount: number;
  commission: number;
  tax: number;
};

export type OrderPage = {
  orders: HistoricalOrder[];
  nextCursor?: string;
  hasNext: boolean;
};

export type DailyCandle = {
  symbol: string;
  date: string;
  timestamp: string;
  currency: string;
  openPrice: number;
  highPrice: number;
  lowPrice: number;
  closePrice: number;
};

export type ExchangeRate = {
  date: string;
  rate: number;
  timestamp: string;
};

export type CandlePage = {
  candles: DailyCandle[];
  nextBefore?: string;
};

export type InstrumentInfo = {
  symbol: string;
  name: string;
  market: string;
  currency: string;
};

export type ReadOnlyMarketResponse = {
  feature: ReadOnlyMarketFeature;
  upstreamPath: string;
  fetchedAt: string;
  data: unknown;
};

type TokenCache = {
  accessToken: string;
  expiresAt: number;
};

type CacheEntry<T> = {
  value: T;
  expiresAt: number;
};

export class TossApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
    public readonly requestId?: string,
  ) {
    super(message);
    this.name = "TossApiError";
  }
}

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function pick(record: UnknownRecord, keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) return record[key];
  }
  return undefined;
}

function stringFrom(record: UnknownRecord, keys: string[], fallback = ""): string {
  const value = pick(record, keys);
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return fallback;
}

function numberFrom(record: UnknownRecord, keys: string[], fallback = 0): number {
  const value = pick(record, keys);
  if (typeof value === "number") return Number.isFinite(value) ? value : fallback;
  if (typeof value === "string") {
    const normalized = value.replace(/[,%\s]/g, "");
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

function numberValue(value: unknown, fallback = 0): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : fallback;
  if (typeof value === "string") {
    const parsed = Number(value.replace(/[,%\s]/g, ""));
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

function childRecord(record: UnknownRecord, key: string): UnknownRecord {
  return isRecord(record[key]) ? record[key] : {};
}

function rateToPercent(value: unknown): number {
  return Math.round(numberValue(value) * 100 * 100_000_000) / 100_000_000;
}

function currencyAmounts(value: unknown): CurrencyAmounts {
  if (!isRecord(value)) return { KRW: 0, USD: 0 };
  return {
    KRW: numberValue(value.krw ?? value.KRW),
    USD: numberValue(value.usd ?? value.USD),
  };
}

function collectArrays(value: unknown, depth = 0): UnknownRecord[][] {
  if (depth > 4) return [];
  if (Array.isArray(value)) {
    const records = value.filter(isRecord);
    const nested = value.flatMap((item) => collectArrays(item, depth + 1));
    return records.length ? [records, ...nested] : nested;
  }
  if (!isRecord(value)) return [];
  return Object.values(value).flatMap((item) => collectArrays(item, depth + 1));
}

function collectRecords(value: unknown, depth = 0): UnknownRecord[] {
  if (depth > 4) return [];
  if (Array.isArray(value)) return value.flatMap((item) => collectRecords(item, depth + 1));
  if (!isRecord(value)) return [];
  return [value, ...Object.values(value).flatMap((item) => collectRecords(item, depth + 1))];
}

function hasAnyKey(record: UnknownRecord, keys: string[]): boolean {
  return keys.some((key) => record[key] !== undefined);
}

const accountIdKeys = ["accountSeq", "accountId", "id", "seq", "accountNumber", "accountNo"];
const symbolKeys = ["symbol", "stockCode", "code", "ticker", "stockSymbol"];
const summaryKeys = [
  "totalEvaluationAmount",
  "totalEvaluatedAmount",
  "totalValuationAmount",
  "totalPurchaseAmount",
  "totalProfitLoss",
  "totalProfitLossAmount",
  "totalProfitAmount",
  "evaluationAmount",
];

function bestArray(payload: unknown, kind: "account" | "holding"): UnknownRecord[] {
  const arrays = collectArrays(payload);
  const keys = kind === "account" ? accountIdKeys : symbolKeys;
  const best = arrays
    .map((items) => ({
      items,
      score: items.reduce((score, item) => score + (hasAnyKey(item, keys) ? 1 : 0), 0),
    }))
    .sort((a, b) => b.score - a.score || b.items.length - a.items.length)[0];
  return best?.items.filter((item) => hasAnyKey(item, keys)) ?? [];
}

function maskAccountNumber(value: string): string {
  const compact = value.replace(/\s/g, "");
  if (compact.length < 5) return value;
  return "•••• " + compact.slice(-4);
}

function normalizeAccount(record: UnknownRecord, index: number): Account {
  const id = stringFrom(record, accountIdKeys, String(index + 1));
  const name = stringFrom(
    record,
    ["accountName", "name", "displayName", "productName", "accountTypeName"],
    "투자 계좌 " + (index + 1),
  );
  const accountNumber = stringFrom(record, ["accountNumber", "accountNo", "number"]);
  const rawType = stringFrom(record, ["accountType", "type", "productType", "accountTypeName"], "BROKERAGE");
  const accountTypes: Record<string, string> = {
    BROKERAGE: "종합매매",
    OVERSEAS_DERIVATIVES: "해외파생",
    PENSION_SAVINGS: "연금저축",
    RESHORING_INVESTMENT: "국내복귀투자",
  };
  const type = accountTypes[rawType] || rawType;
  return {
    id,
    name,
    type,
    label: accountNumber ? name + " · " + maskAccountNumber(accountNumber) : name,
  };
}

function normalizeMarket(value: string): string {
  const upper = value.toUpperCase();
  if (["KR", "KRX", "KOSPI", "KOSDAQ", "NXT"].includes(upper)) return upper === "KR" ? "KRX" : upper;
  if (["US", "NASDAQ", "NYSE", "AMEX"].includes(upper)) return upper === "US" ? "미국" : upper;
  return value || "기타";
}

function normalizeCurrency(value: string, market: string): string {
  const upper = value.toUpperCase();
  if (upper === "KRW" || upper === "USD") return upper;
  return ["미국", "NASDAQ", "NYSE", "AMEX"].includes(market) ? "USD" : "KRW";
}

function resultRecord(payload: unknown): UnknownRecord {
  return isRecord(payload) && isRecord(payload.result) ? payload.result : {};
}

function exactArray(record: UnknownRecord, keys: string[]): UnknownRecord[] {
  for (const key of keys) {
    if (Array.isArray(record[key])) return record[key].filter(isRecord);
  }
  return [];
}

function normalizeTimestamp(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = value < 10_000_000_000 ? value * 1000 : value;
    return new Date(milliseconds).toISOString();
  }
  return "";
}

function dateFromTimestamp(value: string): string {
  const match = value.match(/^(\d{4}-\d{2}-\d{2})/);
  return match?.[1] ?? "";
}

export function normalizeOrderPage(payload: unknown): OrderPage {
  const result = resultRecord(payload);
  const records = exactArray(result, ["orders", "items"]);
  const orders = records.map((record, index) => {
    const execution = childRecord(record, "execution");
    const orderedAt = normalizeTimestamp(pick(record, ["orderedAt", "createdAt", "orderAt"]));
    const filledAt = normalizeTimestamp(pick(execution, ["filledAt", "executedAt", "completedAt"]))
      || normalizeTimestamp(pick(record, ["filledAt", "executedAt", "completedAt"]));
    const symbol = stringFrom(record, symbolKeys);
    const side = stringFrom(record, ["side", "orderSide", "tradeType"]).toUpperCase();
    const filledQuantity = numberFrom(execution, ["filledQuantity", "executedQuantity", "quantity"])
      || numberFrom(record, ["filledQuantity", "executedQuantity"]);
    const averageFilledPrice = numberFrom(execution, ["averageFilledPrice", "averagePrice", "filledPrice"])
      || numberFrom(record, ["averageFilledPrice", "filledPrice"]);
    const explicitId = stringFrom(record, ["id", "orderId", "orderSeq", "orderNumber"]);
    return {
      orderId: explicitId || [symbol, side, orderedAt, filledAt, filledQuantity, index].join(":"),
      symbol,
      side,
      currency: stringFrom(record, ["currency", "currencyCode"]).toUpperCase(),
      status: stringFrom(record, ["status", "orderStatus"]).toUpperCase(),
      orderedAt,
      filledAt,
      filledQuantity,
      averageFilledPrice,
      filledAmount: numberFrom(execution, ["filledAmount", "executedAmount", "amount"], averageFilledPrice * filledQuantity),
      commission: numberFrom(execution, ["commission", "commissionAmount", "fee"]),
      tax: numberFrom(execution, ["tax", "taxAmount"]),
    } satisfies HistoricalOrder;
  });
  const nextCursor = stringFrom(result, ["nextCursor", "cursor"]) || undefined;
  return {
    orders,
    nextCursor,
    hasNext: Boolean(result.hasNext ?? result.hasMore ?? nextCursor),
  };
}

export function normalizeCandlePage(payload: unknown, symbol: string): CandlePage {
  const result = resultRecord(payload);
  const records = exactArray(result, ["candles", "items"]);
  const candles = records.map((record) => {
    const timestamp = normalizeTimestamp(pick(record, ["timestamp", "dateTime", "time", "date"]));
    const explicitDate = stringFrom(record, ["date", "businessDate", "tradeDate"]);
    const closePrice = numberFrom(record, ["close", "closePrice", "closingPrice", "price"]);
    const openPrice = numberFrom(record, ["open", "openPrice", "openingPrice"], closePrice);
    const highPrice = numberFrom(record, ["high", "highPrice", "highestPrice"], Math.max(openPrice, closePrice));
    const lowPrice = numberFrom(record, ["low", "lowPrice", "lowestPrice"], Math.min(openPrice, closePrice));
    return {
      symbol,
      date: dateFromTimestamp(explicitDate) || dateFromTimestamp(timestamp),
      timestamp,
      currency: stringFrom(record, ["currency", "currencyCode"]).toUpperCase(),
      openPrice,
      highPrice: Math.max(highPrice, openPrice, closePrice),
      lowPrice: Math.min(lowPrice, openPrice, closePrice),
      closePrice,
    } satisfies DailyCandle;
  }).filter((candle) => candle.date && candle.closePrice > 0);
  return {
    candles,
    nextBefore: stringFrom(result, ["nextBefore", "before"]) || undefined,
  };
}

export function normalizeExchangeRatePayload(payload: unknown, date: string): ExchangeRate {
  const candidates = collectRecords(payload)
    .map((record) => ({
      record,
      rate: numberFrom(record, ["rate", "midRate", "exchangeRate", "basePrice"]),
    }))
    .filter((candidate) => candidate.rate > 100 && candidate.rate < 10_000)
    .sort((left, right) => {
      const leftScore = Number(left.record.midRate !== undefined) + Number(left.record.rate !== undefined) * 2;
      const rightScore = Number(right.record.midRate !== undefined) + Number(right.record.rate !== undefined) * 2;
      return rightScore - leftScore;
    });
  const selected = candidates[0];
  if (!selected) {
    throw new TossApiError("USD/KRW 환율 응답 형식이 올바르지 않습니다.", 502, "invalid-exchange-rate-response");
  }
  return {
    date,
    rate: selected.rate,
    timestamp: stringFrom(selected.record, ["dateTime", "timestamp", "updatedAt"], `${date}T15:30:00+09:00`),
  };
}

export function normalizeInstrumentsPayload(payload: unknown): InstrumentInfo[] {
  const directResult = isRecord(payload) && Array.isArray(payload.result) ? payload.result.filter(isRecord) : [];
  const result = resultRecord(payload);
  const records = directResult.length ? directResult : exactArray(result, ["stocks", "items", "instruments"]);
  return records.map((record) => {
    const rawMarket = stringFrom(record, ["market", "marketCountry", "exchange", "exchangeCode", "marketCode"]);
    const market = normalizeMarket(rawMarket);
    return {
      symbol: stringFrom(record, symbolKeys),
      name: stringFrom(record, ["name", "stockName", "symbolName", "instrumentName", "securityName"]),
      market,
      currency: normalizeCurrency(stringFrom(record, ["currency", "currencyCode"]), market),
    } satisfies InstrumentInfo;
  }).filter((instrument) => instrument.symbol);
}

function normalizeHolding(record: UnknownRecord, index: number): Holding {
  const market = normalizeMarket(stringFrom(record, ["marketCountry", "market", "exchange", "marketCode", "exchangeCode"]));
  const quantity = numberFrom(record, ["quantity", "holdingQuantity", "balanceQuantity", "ownedQuantity", "qty"]);
  const averagePrice = numberFrom(record, [
    "averagePrice",
    "averagePurchasePrice",
    "purchaseAveragePrice",
    "avgPrice",
    "costPrice",
  ]);
  const currentPrice = numberFrom(record, ["currentPrice", "price", "marketPrice", "lastPrice"]);
  const marketValue = childRecord(record, "marketValue");
  const profitLossRecord = childRecord(record, "profitLoss");
  const dailyProfitLossRecord = childRecord(record, "dailyProfitLoss");
  const rawPurchaseAmount = numberValue(marketValue.purchaseAmount) || numberFrom(record, [
    "purchaseAmount",
    "totalPurchaseAmount",
    "costAmount",
    "acquisitionAmount",
    "investmentAmount",
  ]);
  const rawEvaluationAmount = numberValue(marketValue.amount) || numberFrom(record, [
    "evaluationAmount",
    "evaluatedAmount",
    "valuationAmount",
    "marketValue",
    "currentAmount",
    "balanceAmount",
  ]);
  const purchaseAmount = rawPurchaseAmount || averagePrice * quantity;
  const evaluationAmount = rawEvaluationAmount || currentPrice * quantity;
  const rawProfitLoss = numberValue(profitLossRecord.amount) || numberFrom(record, [
    "profitLoss",
    "profitLossAmount",
    "profitAmount",
    "gainLoss",
    "unrealizedProfitLoss",
    "unrealizedPnl",
  ]);
  const profitLoss = rawProfitLoss || evaluationAmount - purchaseAmount;
  const calculatedRate = purchaseAmount !== 0 ? (profitLoss / purchaseAmount) * 100 : 0;
  const providedRate = profitLossRecord.rate !== undefined
    ? rateToPercent(profitLossRecord.rate)
    : numberFrom(record, ["profitRate", "profitLossRate", "returnRate", "earningRate", "rateOfReturn"]);

  return {
    symbol: stringFrom(record, symbolKeys, "POSITION-" + (index + 1)),
    name: stringFrom(record, ["name", "stockName", "symbolName", "instrumentName", "securityName"], "이름 없는 종목"),
    market,
    currency: normalizeCurrency(stringFrom(record, ["currency", "currencyCode"]), market),
    quantity,
    availableQuantity: numberFrom(
      record,
      ["availableQuantity", "sellableQuantity", "tradableQuantity", "orderableQuantity"],
      quantity,
    ),
    averagePrice,
    currentPrice,
    purchaseAmount,
    evaluationAmount,
    profitLoss,
    profitRate: purchaseAmount !== 0 ? calculatedRate : providedRate,
    dailyProfitLoss: numberValue(dailyProfitLossRecord.amount),
    dailyProfitRate: rateToPercent(dailyProfitLossRecord.rate),
  };
}

function bestSummary(payload: unknown): UnknownRecord | undefined {
  return collectRecords(payload)
    .map((record) => ({
      record,
      score: summaryKeys.reduce((score, key) => score + (record[key] !== undefined ? 1 : 0), 0),
    }))
    .sort((a, b) => b.score - a.score)[0]?.record;
}

function describeShape(value: unknown, depth = 0): unknown {
  if (depth > 3) return typeof value;
  if (Array.isArray(value)) {
    return { kind: "array", length: value.length, item: value.length ? describeShape(value[0], depth + 1) : null };
  }
  if (!isRecord(value)) return typeof value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, describeShape(child, depth + 1)]));
}

export function normalizeHoldingsPayload(payload: unknown): {
  holdings: Holding[];
  summary: Portfolio["summary"];
} {
  const result = isRecord(payload) && isRecord(payload.result) ? payload.result : {};
  const exactItems = Array.isArray(result.items) ? result.items.filter(isRecord) : [];
  const holdings = (exactItems.length ? exactItems : bestArray(payload, "holding"))
    .map(normalizeHolding)
    .filter((holding) => holding.quantity !== 0 || holding.evaluationAmount !== 0)
    .sort((a, b) => b.evaluationAmount - a.evaluationAmount);

  const summaryRecord = Object.keys(result).length ? result : bestSummary(payload) ?? {};
  const marketValue = childRecord(summaryRecord, "marketValue");
  const profitLossRecord = childRecord(summaryRecord, "profitLoss");
  const dailyProfitLossRecord = childRecord(summaryRecord, "dailyProfitLoss");

  return {
    holdings,
    summary: {
      purchaseAmount: currencyAmounts(summaryRecord.totalPurchaseAmount),
      evaluationAmount: currencyAmounts(marketValue.amount),
      profitLoss: currencyAmounts(profitLossRecord.amount),
      dailyProfitLoss: currencyAmounts(dailyProfitLossRecord.amount),
      profitRate: rateToPercent(profitLossRecord.rate),
      dailyProfitRate: rateToPercent(dailyProfitLossRecord.rate),
      positionCount: holdings.length,
    },
  };
}

export class TossClient {
  private tokenCache?: TokenCache;
  private accountsCache?: CacheEntry<Account[]>;
  private readonly portfolioCache = new Map<string, CacheEntry<Portfolio>>();

  constructor(private readonly config: AppConfig) {}

  private async getAccessToken(): Promise<string> {
    if (this.tokenCache && this.tokenCache.expiresAt > Date.now() + 60_000) {
      return this.tokenCache.accessToken;
    }

    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
    });
    const response = await fetch(this.config.tossApiBaseUrl + "/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    const payload = await this.readResponse(response);
    if (!response.ok) throw this.toApiError(response, payload, "토스증권 인증에 실패했습니다.");

    if (!isRecord(payload)) throw new TossApiError("토큰 응답 형식이 올바르지 않습니다.", 502, "invalid-token-response");
    const accessToken = stringFrom(payload, ["access_token", "accessToken", "token"]);
    const expiresIn = numberFrom(payload, ["expires_in", "expiresIn"], 3600);
    if (!accessToken) throw new TossApiError("토큰 응답에 access_token이 없습니다.", 502, "invalid-token-response");

    this.tokenCache = {
      accessToken,
      expiresAt: Date.now() + Math.max(expiresIn, 120) * 1000,
    };
    return accessToken;
  }

  private async readResponse(response: Response): Promise<unknown> {
    const text = await response.text();
    if (!text) return {};
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return { message: text.slice(0, 300) };
    }
  }

  private toApiError(response: Response, payload: unknown, fallback: string): TossApiError {
    const error = isRecord(payload) && isRecord(payload.error) ? payload.error : isRecord(payload) ? payload : {};
    const oauthCode = isRecord(payload) && typeof payload.error === "string" ? payload.error : "";
    const code = oauthCode || stringFrom(error, ["code"], "upstream-" + response.status);
    const oauthMessages: Record<string, string> = {
      invalid_client: "토스증권 Open API 자격증명이 올바르지 않거나 클라이언트가 비활성 상태입니다.",
      access_denied: "현재 서버 IP가 토스증권 Open API 허용 목록에 없습니다.",
      invalid_request: "토스증권 인증 요청 형식이 올바르지 않습니다.",
      unsupported_grant_type: "토스증권이 Client Credentials 인증 방식을 허용하지 않았습니다.",
    };
    const message = oauthMessages[oauthCode] || stringFrom(error, ["message", "error_description"], fallback);
    const requestId =
      stringFrom(error, ["requestId"]) || response.headers.get("x-request-id") || response.headers.get("x-amz-cf-id") || undefined;
    return new TossApiError(message || fallback, response.status, code, requestId);
  }

  private async get(path: string, accountId?: string): Promise<unknown> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const accessToken = await this.getAccessToken();
        const headers: Record<string, string> = {
          Authorization: "Bearer " + accessToken,
          Accept: "application/json",
        };
        if (accountId) headers["X-Tossinvest-Account"] = accountId;

        const response = await fetch(this.config.tossApiBaseUrl + path, {
          headers,
          signal: AbortSignal.timeout(15_000),
        });
        const payload = await this.readResponse(response);

        if (process.env.DEBUG_TOSS_SCHEMA === "true") {
          console.info("[toss-schema] " + path, JSON.stringify(describeShape(payload)));
        }

        if (response.ok) return payload;
        const apiError = this.toApiError(response, payload, "토스증권 데이터를 불러오지 못했습니다.");
        lastError = apiError;
        if (response.status === 401 && attempt === 0) {
          this.tokenCache = undefined;
          continue;
        }
        if ((response.status === 429 || response.status >= 500) && attempt < 3) {
          const retryAfter = Number.parseFloat(response.headers.get("retry-after") ?? "");
          const delay = Number.isFinite(retryAfter)
            ? Math.max(250, Math.min(retryAfter * 1000, 5_000))
            : Math.min(400 * 2 ** attempt, 3_200);
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
        throw apiError;
      } catch (error) {
        lastError = error;
        if (error instanceof TossApiError || attempt >= 3) throw error;
        await new Promise((resolve) => setTimeout(resolve, Math.min(400 * 2 ** attempt, 3_200)));
      }
    }
    throw lastError;
  }

  async getAccounts(force = false): Promise<Account[]> {
    if (!force && this.accountsCache && this.accountsCache.expiresAt > Date.now()) {
      return this.accountsCache.value;
    }
    const payload = await this.get("/api/v1/accounts");
    const accounts = bestArray(payload, "account").map(normalizeAccount);
    if (!accounts.length) {
      throw new TossApiError("조회 가능한 토스증권 계좌가 없습니다.", 404, "accounts-empty");
    }
    this.accountsCache = { value: accounts, expiresAt: Date.now() + 60_000 };
    return accounts;
  }

  async getPortfolio(requestedAccountId?: string, force = false, refreshAccounts = force): Promise<Portfolio> {
    const accounts = await this.getAccounts(refreshAccounts);
    const account = requestedAccountId
      ? accounts.find((candidate) => candidate.id === requestedAccountId)
      : accounts[0];
    if (!account) throw new TossApiError("선택한 계좌를 찾을 수 없습니다.", 400, "invalid-account");

    const cached = this.portfolioCache.get(account.id);
    if (!force && cached && cached.expiresAt > Date.now()) return cached.value;

    const payload = await this.get("/api/v1/holdings", account.id);
    const normalized = normalizeHoldingsPayload(payload);

    const portfolio: Portfolio = {
      asOf: new Date().toISOString(),
      accounts,
      selectedAccountId: account.id,
      account,
      summary: normalized.summary,
      holdings: normalized.holdings,
    };

    this.portfolioCache.set(account.id, { value: portfolio, expiresAt: Date.now() + 4_000 });
    return portfolio;
  }

  async getClosedOrders(accountId: string, cursor?: string): Promise<OrderPage> {
    const params = new URLSearchParams({ status: "CLOSED", limit: "100" });
    if (cursor) params.set("cursor", cursor);
    return normalizeOrderPage(await this.get("/api/v1/orders?" + params.toString(), accountId));
  }

  async getDailyCandles(symbol: string, before?: string, adjusted = false): Promise<CandlePage> {
    const params = new URLSearchParams({
      symbol,
      interval: "1d",
      count: "200",
      adjusted: String(adjusted),
    });
    if (before) params.set("before", before);
    return normalizeCandlePage(await this.get("/api/v1/candles?" + params.toString()), symbol);
  }

  async getMarketIndicatorDailyCandles(symbol: "KOSPI" | "KOSDAQ", before?: string): Promise<CandlePage> {
    const params = new URLSearchParams({ interval: "1d", count: "200" });
    if (before) params.set("before", before);
    return normalizeCandlePage(
      await this.get(`/api/v1/market-indicators/${symbol}/candles?${params.toString()}`),
      symbol,
    );
  }

  async getUsdKrwExchangeRate(date: string): Promise<ExchangeRate> {
    const params = new URLSearchParams({
      dateTime: `${date}T15:30:00+09:00`,
      baseCurrency: "USD",
      quoteCurrency: "KRW",
    });
    return normalizeExchangeRatePayload(
      await this.get("/api/v1/exchange-rate?" + params.toString()),
      date,
    );
  }

  async getInstruments(symbols: string[]): Promise<InstrumentInfo[]> {
    if (!symbols.length) return [];
    const unique = Array.from(new Set(symbols));
    const instruments: InstrumentInfo[] = [];
    for (let index = 0; index < unique.length; index += 200) {
      const params = new URLSearchParams({ symbols: unique.slice(index, index + 200).join(",") });
      instruments.push(...normalizeInstrumentsPayload(await this.get("/api/v1/stocks?" + params.toString())));
    }
    return instruments;
  }

  async getReadOnlyMarketData(
    feature: ReadOnlyMarketFeature,
    query: MarketQuery,
  ): Promise<ReadOnlyMarketResponse> {
    const upstreamPath = buildReadOnlyMarketPath(feature, query);
    const data = await this.get(upstreamPath);
    return {
      feature,
      upstreamPath,
      fetchedAt: new Date().toISOString(),
      data,
    };
  }

  async getCompatibleAccounts(): Promise<unknown> {
    return this.get("/api/v1/accounts");
  }

  async getCompatibleHoldings(accountId: string): Promise<unknown> {
    return this.get("/api/v1/holdings", accountId);
  }

  async getCompatibleOrders(accountId: string, query: OrderHistoryQuery): Promise<unknown> {
    return this.get(buildReadOnlyOrderListPath(query), accountId);
  }

  async getCompatibleOrder(accountId: string, orderId: string, query: OrderHistoryQuery): Promise<unknown> {
    return this.get(buildReadOnlyOrderDetailPath(orderId, query), accountId);
  }
}
