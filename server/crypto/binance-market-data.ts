import {
  DERIVATIVES_TRADING_USDS_FUTURES_WS_STREAMS_PROD_URL,
  DerivativesTradingUsdsFutures,
  DerivativesTradingUsdsFuturesRestAPI,
} from "@binance/derivatives-trading-usds-futures";
import {
  BINANCE_MINIMUM_LISTING_AGE_MS,
  type BinanceInstrumentRules,
} from "./contracts.js";

type UnknownRecord = Record<string, unknown>;

export type BinanceKline = {
  symbol: string;
  interval: "1m";
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quoteVolume: number;
  tradeCount: number;
  final: boolean;
};

export type BinanceTicker24h = {
  symbol: string;
  lastPrice: number;
  priceChangePercent: number;
  volume: number;
  quoteVolume: number;
  closeTime: number;
};

export type BinanceBookTicker = {
  symbol: string;
  bidPrice: number;
  bidQuantity: number;
  askPrice: number;
  askQuantity: number;
  eventTime: number;
};

export type BinanceMarketEvent =
  | ({ kind: "kline"; source: "binance_ws"; receivedAt: number } & BinanceKline)
  | {
    kind: "agg_trade";
    source: "binance_ws";
    symbol: string;
    aggregateTradeId: string;
    price: number;
    quantity: number;
    executedAt: number;
    buyerWasMaker: boolean;
    receivedAt: number;
  }
  | ({ kind: "book_ticker"; source: "binance_ws"; receivedAt: number } & BinanceBookTicker)
  | {
    kind: "mark_price";
    source: "binance_ws";
    symbol: string;
    markPrice: number;
    indexPrice: number;
    fundingRate: number;
    nextFundingTime: number;
    eventTime: number;
    receivedAt: number;
  };

export type BinanceRestKlineRequest = {
  symbol: string;
  startTime?: number;
  endTime?: number;
  limit?: number;
};

export interface BinanceRestMarketData {
  exchangeInformation(): Promise<unknown>;
  klines(input: BinanceRestKlineRequest): Promise<unknown>;
  tickers24h(): Promise<unknown>;
  bookTickers(): Promise<unknown>;
}

function record(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : undefined;
}

function finite(value: unknown): number | undefined {
  if (typeof value === "bigint") return Number(value);
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function positive(value: unknown): number | undefined {
  const parsed = finite(value);
  return parsed !== undefined && parsed > 0 ? parsed : undefined;
}

function nonNegative(value: unknown): number | undefined {
  const parsed = finite(value);
  return parsed !== undefined && parsed >= 0 ? parsed : undefined;
}

function upper(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toUpperCase();
  return normalized || undefined;
}

function filterValue(
  filters: readonly unknown[],
  filterTypes: readonly string[],
  keys: readonly string[],
): number | undefined {
  for (const item of filters) {
    const candidate = record(item);
    if (!candidate || !filterTypes.includes(upper(candidate.filterType) ?? "")) continue;
    for (const key of keys) {
      const parsed = positive(candidate[key]);
      if (parsed !== undefined) return parsed;
    }
  }
  return undefined;
}

export function normalizeBinanceUniverse(
  exchangeInformation: unknown,
  now = Date.now(),
): BinanceInstrumentRules[] {
  const payload = record(exchangeInformation);
  const symbols = Array.isArray(payload?.symbols) ? payload.symbols : [];
  const minimumOnboardDate = now - BINANCE_MINIMUM_LISTING_AGE_MS;
  const result: BinanceInstrumentRules[] = [];
  for (const item of symbols) {
    const symbolInfo = record(item);
    if (!symbolInfo) continue;
    const symbol = upper(symbolInfo.symbol);
    const baseAsset = upper(symbolInfo.baseAsset);
    const quoteAsset = upper(symbolInfo.quoteAsset);
    const marginAsset = upper(symbolInfo.marginAsset);
    const contractType = upper(symbolInfo.contractType);
    const status = upper(symbolInfo.status);
    const onboardDate = nonNegative(symbolInfo.onboardDate);
    if (!symbol || !baseAsset || status !== "TRADING" || contractType !== "PERPETUAL"
      || quoteAsset !== "USDT" || marginAsset !== "USDT"
      || onboardDate === undefined || onboardDate > minimumOnboardDate) {
      continue;
    }
    const filters = Array.isArray(symbolInfo.filters) ? symbolInfo.filters : [];
    const tickSize = filterValue(filters, ["PRICE_FILTER"], ["tickSize"]);
    // Runtime entries and reductions are MARKET orders. Binance may publish
    // different market and limit quantity grids, so prefer MARKET_LOT_SIZE
    // regardless of the filter array's order and fall back only when absent.
    const marketStepSize = filterValue(filters, ["MARKET_LOT_SIZE"], ["stepSize"]);
    const lotStepSize = filterValue(filters, ["LOT_SIZE"], ["stepSize"]);
    const stepSize = marketStepSize ?? lotStepSize;
    if (tickSize === undefined || stepSize === undefined) continue;
    result.push({
      symbol,
      baseAsset,
      quoteAsset: "USDT",
      marginAsset: "USDT",
      contractType: "PERPETUAL",
      onboardDate,
      tickSize,
      stepSize,
      minQuantity: filterValue(filters, ["MARKET_LOT_SIZE"], ["minQty"])
        ?? filterValue(filters, ["LOT_SIZE"], ["minQty"])
        ?? 0,
      minNotional: filterValue(filters, ["MIN_NOTIONAL", "NOTIONAL"], ["notional", "minNotional"]) ?? 0,
      // Binance documents exchangeInfo.maintMarginPercent as an ignored
      // compatibility field. Only the signed USER_DATA bracket endpoint can
      // resolve an account-applicable rate. Keep public-universe rules
      // explicitly unavailable so execution layers can fail closed.
      maintenanceMarginRate: 1,
      maintenanceMarginSource: "unavailable",
    });
  }
  return result.sort((left, right) => left.symbol.localeCompare(right.symbol));
}

function normalizeKlineTuple(
  symbol: string,
  raw: unknown,
  authoritativeNow: number,
): BinanceKline | undefined {
  if (!Array.isArray(raw) || raw.length < 11) return undefined;
  const openTime = nonNegative(raw[0]);
  const open = positive(raw[1]);
  const high = positive(raw[2]);
  const low = positive(raw[3]);
  const close = positive(raw[4]);
  const volume = nonNegative(raw[5]);
  const closeTime = nonNegative(raw[6]);
  const quoteVolume = nonNegative(raw[7]);
  const tradeCount = nonNegative(raw[8]);
  if ([openTime, open, high, low, close, volume, closeTime, quoteVolume, tradeCount]
    .some((value) => value === undefined)) {
    return undefined;
  }
  if (high! < Math.max(open!, close!) || low! > Math.min(open!, close!) || low! > high!) {
    return undefined;
  }
  return {
    symbol,
    interval: "1m",
    openTime: openTime!,
    closeTime: closeTime!,
    open: open!,
    high: high!,
    low: low!,
    close: close!,
    volume: volume!,
    quoteVolume: quoteVolume!,
    tradeCount: Math.trunc(tradeCount!),
    // REST has no close flag. Only time strictly after the exchange close time
    // is authoritative enough to call the interval final.
    final: closeTime! < authoritativeNow,
  };
}

export function normalizeRestKlines(
  symbol: string,
  payload: unknown,
  authoritativeNow = Date.now(),
): BinanceKline[] {
  const normalizedSymbol = upper(symbol);
  if (!normalizedSymbol || !Array.isArray(payload)) return [];
  return payload
    .map((item) => normalizeKlineTuple(normalizedSymbol, item, authoritativeNow))
    .filter((item): item is BinanceKline => item !== undefined)
    .sort((left, right) => left.openTime - right.openTime);
}

export function normalizeTicker24h(payload: unknown): BinanceTicker24h[] {
  const entries = Array.isArray(payload) ? payload : [payload];
  return entries.flatMap((item): BinanceTicker24h[] => {
    const ticker = record(item);
    if (!ticker) return [];
    const symbol = upper(ticker.symbol);
    const lastPrice = positive(ticker.lastPrice);
    const priceChangePercent = finite(ticker.priceChangePercent);
    const volume = nonNegative(ticker.volume);
    const quoteVolume = nonNegative(ticker.quoteVolume);
    const closeTime = nonNegative(ticker.closeTime);
    if (!symbol || lastPrice === undefined || priceChangePercent === undefined
      || volume === undefined || quoteVolume === undefined || closeTime === undefined) {
      return [];
    }
    return [{ symbol, lastPrice, priceChangePercent, volume, quoteVolume, closeTime }];
  });
}

export function normalizeBookTickers(payload: unknown, observedAt = Date.now()): BinanceBookTicker[] {
  const entries = Array.isArray(payload) ? payload : [payload];
  return entries.flatMap((item): BinanceBookTicker[] => {
    const ticker = record(item);
    if (!ticker) return [];
    const symbol = upper(ticker.symbol);
    const bidPrice = positive(ticker.bidPrice);
    const bidQuantity = nonNegative(ticker.bidQty);
    const askPrice = positive(ticker.askPrice);
    const askQuantity = nonNegative(ticker.askQty);
    const eventTime = nonNegative(ticker.time) ?? observedAt;
    if (!symbol || bidPrice === undefined || bidQuantity === undefined
      || askPrice === undefined || askQuantity === undefined || askPrice < bidPrice) {
      return [];
    }
    return [{ symbol, bidPrice, bidQuantity, askPrice, askQuantity, eventTime }];
  });
}

type RestResponse = { data(): unknown | Promise<unknown> };

export class OfficialBinanceUsdmRestMarketData implements BinanceRestMarketData {
  private readonly client: DerivativesTradingUsdsFutures;

  constructor(timeoutMs = 5_000) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) {
      throw new Error("Binance REST timeout must be between 100 and 30000ms.");
    }
    this.client = new DerivativesTradingUsdsFutures({
      configurationRestAPI: {
        // The generated SDK types require the field even for public endpoints.
        // An empty value is never sent as a signed credential.
        apiKey: "",
        timeout: timeoutMs,
        // Market data reads are retried by the scanner coordinator only after
        // rate-limit/backoff classification. Disable opaque SDK retries.
        retries: 0,
      },
    });
  }

  private async data(response: Promise<RestResponse>): Promise<unknown> {
    return (await response).data();
  }

  exchangeInformation(): Promise<unknown> {
    return this.data(this.client.restAPI.exchangeInformation());
  }

  klines(input: BinanceRestKlineRequest): Promise<unknown> {
    const symbol = upper(input.symbol);
    if (!symbol) throw new Error("Binance kline symbol is required.");
    const limit = Math.max(1, Math.min(1_024, Math.trunc(input.limit ?? 1_024)));
    return this.data(this.client.restAPI.klineCandlestickData({
      symbol,
      interval: DerivativesTradingUsdsFuturesRestAPI
        .KlineCandlestickDataIntervalEnum.INTERVAL_1m,
      limit,
      ...(input.startTime !== undefined ? { startTime: input.startTime } : {}),
      ...(input.endTime !== undefined ? { endTime: input.endTime } : {}),
    }));
  }

  tickers24h(): Promise<unknown> {
    return this.data(this.client.restAPI.ticker24hrPriceChangeStatistics());
  }

  bookTickers(): Promise<unknown> {
    return this.data(this.client.restAPI.symbolOrderBookTicker());
  }
}

function unwrapWebsocketPayload(raw: unknown): unknown {
  if (Buffer.isBuffer(raw)) return unwrapWebsocketPayload(raw.toString("utf8"));
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return undefined;
    }
  }
  const wrapper = record(raw);
  if (wrapper && "data" in wrapper) return unwrapWebsocketPayload(wrapper.data);
  return raw;
}

export function normalizeBinanceWebsocketEvent(
  raw: unknown,
  receivedAt = Date.now(),
): BinanceMarketEvent | undefined {
  const payload = record(unwrapWebsocketPayload(raw));
  if (!payload) return undefined;
  const eventType = typeof payload.e === "string" ? payload.e : undefined;
  const symbol = upper(payload.s);
  if (!symbol) return undefined;

  if (eventType === "kline") {
    const kline = record(payload.k);
    const openTime = nonNegative(kline?.t);
    const closeTime = nonNegative(kline?.T);
    const open = positive(kline?.o);
    const high = positive(kline?.h);
    const low = positive(kline?.l);
    const close = positive(kline?.c);
    const volume = nonNegative(kline?.v);
    const quoteVolume = nonNegative(kline?.q);
    const tradeCount = nonNegative(kline?.n);
    if ([openTime, closeTime, open, high, low, close, volume, quoteVolume, tradeCount]
      .some((value) => value === undefined) || kline?.i !== "1m") {
      return undefined;
    }
    return {
      kind: "kline",
      source: "binance_ws",
      symbol,
      interval: "1m",
      openTime: openTime!,
      closeTime: closeTime!,
      open: open!,
      high: high!,
      low: low!,
      close: close!,
      volume: volume!,
      quoteVolume: quoteVolume!,
      tradeCount: Math.trunc(tradeCount!),
      final: kline?.x === true,
      receivedAt,
    };
  }
  if (eventType === "aggTrade") {
    const price = positive(payload.p);
    const quantity = positive(payload.q);
    const executedAt = nonNegative(payload.T);
    const aggregateTradeId = finite(payload.a);
    if (price === undefined || quantity === undefined || executedAt === undefined
      || aggregateTradeId === undefined) return undefined;
    return {
      kind: "agg_trade",
      source: "binance_ws",
      symbol,
      aggregateTradeId: String(Math.trunc(aggregateTradeId)),
      price,
      quantity,
      executedAt,
      buyerWasMaker: payload.m === true,
      receivedAt,
    };
  }
  if (eventType === "bookTicker" || (
    payload.b !== undefined && payload.a !== undefined
    && payload.B !== undefined && payload.A !== undefined
  )) {
    const bidPrice = positive(payload.b);
    const bidQuantity = nonNegative(payload.B);
    const askPrice = positive(payload.a);
    const askQuantity = nonNegative(payload.A);
    const eventTime = nonNegative(payload.E) ?? receivedAt;
    if (bidPrice === undefined || bidQuantity === undefined || askPrice === undefined
      || askQuantity === undefined || askPrice < bidPrice) return undefined;
    return {
      kind: "book_ticker",
      source: "binance_ws",
      symbol,
      bidPrice,
      bidQuantity,
      askPrice,
      askQuantity,
      eventTime,
      receivedAt,
    };
  }
  if (eventType === "markPriceUpdate") {
    const markPrice = positive(payload.p);
    const indexPrice = positive(payload.i);
    const fundingRate = finite(payload.r);
    const nextFundingTime = nonNegative(payload.T);
    const eventTime = nonNegative(payload.E) ?? receivedAt;
    if (markPrice === undefined || indexPrice === undefined || fundingRate === undefined
      || nextFundingTime === undefined) return undefined;
    return {
      kind: "mark_price",
      source: "binance_ws",
      symbol,
      markPrice,
      indexPrice,
      fundingRate,
      nextFundingTime,
      eventTime,
      receivedAt,
    };
  }
  return undefined;
}

export function isModelDecisionEvent(event: BinanceMarketEvent): boolean {
  return event.kind === "kline" && event.final;
}

type StoredKline = BinanceKline & { source: "binance_rest" | "binance_ws" };

export class CausalBinanceKlineStore {
  private readonly bars = new Map<string, StoredKline>();

  applyRest(
    symbol: string,
    payload: unknown,
    authoritativeNow = Date.now(),
  ): BinanceKline[] {
    const accepted: BinanceKline[] = [];
    for (const bar of normalizeRestKlines(symbol, payload, authoritativeNow)) {
      const key = `${bar.symbol}:${bar.openTime}`;
      const current = this.bars.get(key);
      // A confirmed websocket bar is direct evidence. Gap recovery must never
      // replace it with a later REST view of the same interval.
      if (current?.source === "binance_ws" && current.final) continue;
      this.bars.set(key, { ...bar, source: "binance_rest" });
      accepted.push(bar);
    }
    return accepted;
  }

  applyWebsocket(event: BinanceMarketEvent): void {
    if (event.kind !== "kline") return;
    const key = `${event.symbol}:${event.openTime}`;
    const current = this.bars.get(key);
    if (current?.source === "binance_ws" && current.final && !event.final) return;
    this.bars.set(key, { ...event, source: "binance_ws" });
  }

  list(symbol: string, finalOnly = true): StoredKline[] {
    const normalizedSymbol = upper(symbol);
    return Array.from(this.bars.values())
      .filter((bar) => bar.symbol === normalizedSymbol && (!finalOnly || bar.final))
      .sort((left, right) => left.openTime - right.openTime)
      .map((bar) => ({ ...bar }));
  }
}

export type BinanceWebsocketSubscription = {
  close(): Promise<void>;
};

export type BinancePublicStreamConnectionState = {
  status: "connected" | "reconnecting";
  generation: number;
  reconnectAttempt: number;
  error?: unknown;
};

export interface BinancePublicStreamConnection {
  on(event: "message", listener: (raw: unknown) => void): unknown;
  on(event: "error", listener: (error: unknown) => void): unknown;
  on(event: "close", listener: () => void): unknown;
  disconnect(): Promise<void>;
}

export type BinancePublicStreamConnectionFactory = (
  streams: readonly string[],
) => Promise<BinancePublicStreamConnection>;

export type BinanceReconnectClock = {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
};

export type OfficialBinanceUsdmPublicStreamsOptions = {
  connectionFactory?: BinancePublicStreamConnectionFactory;
  clock?: BinanceReconnectClock;
  maxReconnectAttempts?: number;
  initialReconnectDelayMs?: number;
  maximumReconnectDelayMs?: number;
  isRecoverableError?: (error: unknown) => boolean;
};

const SYSTEM_RECONNECT_CLOCK: BinanceReconnectClock = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}.`);
  }
  return resolved;
}

export class OfficialBinanceUsdmPublicStreams {
  private readonly connectionFactory: BinancePublicStreamConnectionFactory;
  private readonly clock: BinanceReconnectClock;
  private readonly maxReconnectAttempts: number;
  private readonly initialReconnectDelayMs: number;
  private readonly maximumReconnectDelayMs: number;
  private readonly isRecoverableError: (error: unknown) => boolean;

  constructor(options: OfficialBinanceUsdmPublicStreamsOptions = {}) {
    this.clock = options.clock ?? SYSTEM_RECONNECT_CLOCK;
    this.maxReconnectAttempts = boundedInteger(
      options.maxReconnectAttempts,
      5,
      0,
      20,
      "Binance maximum reconnect attempts",
    );
    this.initialReconnectDelayMs = boundedInteger(
      options.initialReconnectDelayMs,
      500,
      1,
      60_000,
      "Binance initial reconnect delay",
    );
    this.maximumReconnectDelayMs = boundedInteger(
      options.maximumReconnectDelayMs,
      8_000,
      this.initialReconnectDelayMs,
      300_000,
      "Binance maximum reconnect delay",
    );
    this.isRecoverableError = options.isRecoverableError ?? (() => true);
    this.connectionFactory = options.connectionFactory ?? (async (streams) => {
      const client = new DerivativesTradingUsdsFutures({
        configurationWebsocketStreams: {
          wsURL: DERIVATIVES_TRADING_USDS_FUTURES_WS_STREAMS_PROD_URL,
        },
      });
      return client.websocketStreams.connect({ stream: [...streams] });
    });
  }

  async subscribe(
    symbols: readonly string[],
    onEvent: (event: BinanceMarketEvent) => void,
    onDisconnect?: (error?: unknown) => void,
    onState?: (state: BinancePublicStreamConnectionState) => void,
  ): Promise<BinanceWebsocketSubscription> {
    const normalized = Array.from(new Set(symbols.map(upper).filter(
      (symbol): symbol is string => symbol !== undefined,
    )));
    if (!normalized.length) throw new Error("At least one Binance symbol is required.");
    const streams = normalized.flatMap((symbol) => {
      const lower = symbol.toLowerCase();
      return [
        `${lower}@kline_1m`,
        `${lower}@aggTrade`,
        `${lower}@bookTicker`,
        `${lower}@markPrice@1s`,
      ];
    });

    let closed = false;
    let terminalNotified = false;
    let generation = 0;
    let reconnectAttempts = 0;
    let reconnectTimer: unknown;
    let reconnectTask: Promise<void> | undefined;
    let activeConnection: BinancePublicStreamConnection | undefined;
    let closePromise: Promise<void> | undefined;
    const disconnects = new WeakMap<object, Promise<void>>();

    const disconnectOnce = (
      connection: BinancePublicStreamConnection | undefined,
    ): Promise<void> => {
      if (!connection) return Promise.resolve();
      const existing = disconnects.get(connection);
      if (existing) return existing;
      const pending = Promise.resolve().then(() => connection.disconnect());
      disconnects.set(connection, pending);
      return pending;
    };

    const notifyTerminal = (
      error: unknown,
      expectedGeneration: number,
    ): void => {
      if (closed || terminalNotified || expectedGeneration !== generation) return;
      terminalNotified = true;
      generation += 1;
      const connection = activeConnection;
      void disconnectOnce(connection).catch(() => undefined);
      onDisconnect?.(error);
    };

    const install = (
      connection: BinancePublicStreamConnection,
      connectionGeneration: number,
      scheduleReconnect: (error: unknown, expectedGeneration: number) => void,
    ): void => {
      connection.on("message", (raw: unknown) => {
        if (closed || terminalNotified || connectionGeneration !== generation
          || reconnectTimer !== undefined) return;
        const event = normalizeBinanceWebsocketEvent(raw);
        if (event) {
          // A successful TCP/WebSocket handshake alone is not evidence of a
          // healthy market stream. Reset the failure budget only after Binance
          // delivers a valid event, so a connect/close loop remains bounded.
          reconnectAttempts = 0;
          onEvent(event);
        }
      });
      connection.on("error", (error: unknown) => {
        scheduleReconnect(error, connectionGeneration);
      });
      connection.on("close", () => {
        scheduleReconnect(undefined, connectionGeneration);
      });
    };

    const scheduleReconnect = (
      error: unknown,
      expectedGeneration: number,
    ): void => {
      if (closed || terminalNotified || expectedGeneration !== generation
        || reconnectTimer !== undefined) {
        return;
      }
      if ((error !== undefined && !this.isRecoverableError(error))
        || reconnectAttempts >= this.maxReconnectAttempts) {
        notifyTerminal(error, expectedGeneration);
        return;
      }
      onState?.({
        status: "reconnecting",
        generation: expectedGeneration,
        reconnectAttempt: reconnectAttempts + 1,
        ...(error === undefined ? {} : { error }),
      });
      const delayMs = Math.min(
        this.maximumReconnectDelayMs,
        this.initialReconnectDelayMs * (2 ** reconnectAttempts),
      );
      reconnectTimer = this.clock.setTimeout(() => {
        reconnectTimer = undefined;
        reconnectTask = reconnect(expectedGeneration)
          .finally(() => {
            reconnectTask = undefined;
          });
      }, delayMs);
    };

    const reconnect = async (expectedGeneration: number): Promise<void> => {
      if (closed || terminalNotified || expectedGeneration !== generation) return;
      generation += 1;
      const reconnectGeneration = generation;
      const previous = activeConnection;
      activeConnection = undefined;
      await disconnectOnce(previous).catch(() => undefined);
      if (closed || terminalNotified || reconnectGeneration !== generation) return;
      reconnectAttempts += 1;
      let connection: BinancePublicStreamConnection;
      try {
        connection = await this.connectionFactory(streams);
      } catch (error) {
        if (closed || terminalNotified || reconnectGeneration !== generation) return;
        if (!this.isRecoverableError(error)
          || reconnectAttempts >= this.maxReconnectAttempts) {
          notifyTerminal(error, reconnectGeneration);
          return;
        }
        scheduleReconnect(error, reconnectGeneration);
        return;
      }
      if (closed || terminalNotified || reconnectGeneration !== generation) {
        await disconnectOnce(connection).catch(() => undefined);
        return;
      }
      activeConnection = connection;
      install(connection, reconnectGeneration, scheduleReconnect);
      onState?.({
        status: "connected",
        generation: reconnectGeneration,
        reconnectAttempt: reconnectAttempts,
      });
    };

    const initialGeneration = generation + 1;
    generation = initialGeneration;
    activeConnection = await this.connectionFactory(streams);
    install(activeConnection, initialGeneration, scheduleReconnect);
    onState?.({
      status: "connected",
      generation: initialGeneration,
      reconnectAttempt: 0,
    });

    return {
      close: () => {
        if (closePromise) return closePromise;
        closed = true;
        terminalNotified = true;
        generation += 1;
        if (reconnectTimer !== undefined) {
          this.clock.clearTimeout(reconnectTimer);
          reconnectTimer = undefined;
        }
        const connection = activeConnection;
        activeConnection = undefined;
        closePromise = (async () => {
          await Promise.all([
            disconnectOnce(connection),
            reconnectTask ?? Promise.resolve(),
          ]);
        })();
        return closePromise;
      },
    };
  }
}
