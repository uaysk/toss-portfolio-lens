import { createHash } from "node:crypto";
import type {
  BinanceKline,
  BinanceRestAggregateTradeRequest,
} from "./binance-market-data.js";
import {
  normalizeBinanceAggregateTrades,
  type BinanceAggregateTrade,
} from "./fincast-micro-candles.js";

const SECOND_MS = 1_000;
const MAXIMUM_BINANCE_WINDOW_MS = 15 * 60_000;
const DEFAULT_MAXIMUM_PAGES_PER_LEAF = 256;
const DEFAULT_PAGE_DELAY_MS = 550;
const BINANCE_AGGREGATE_TRADE_PAGE_SIZE = 1_000;
const BINANCE_AGGREGATE_TRADE_REQUEST_WEIGHT = 20;

export type FinCastCadenceMarketData = {
  bars15s: BinanceKline[];
  bars30s: BinanceKline[];
  aggregateTradeDigest: string;
  aggregateTradeCount: number;
  requestCount: number;
  requestWeight: number;
  adaptiveSplitCount: number;
};

export type FinCastCadenceMarketDataInput = {
  symbol: string;
  startTime: number;
  endExclusive: number;
  initialPrice: number;
  signal?: AbortSignal;
  maximumPagesPerLeaf?: number;
  pageDelayMs?: number;
  aggregateTrades(request: BinanceRestAggregateTradeRequest): Promise<unknown>;
  pace?(delayMs: number, signal?: AbortSignal): Promise<void>;
};

type MutableBar = {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quoteVolume: number;
  tradeCount: number;
};

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("FinCast cadence market-data recovery was aborted.");
}

async function defaultPace(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw abortError(signal);
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal!));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function normalizedSymbol(value: string): string {
  const symbol = value.trim().toUpperCase();
  if (!/^[A-Z0-9]{2,32}$/.test(symbol) || !symbol.endsWith("USDT")) {
    throw new Error("FinCast cadence market data requires a Binance USDT symbol.");
  }
  return symbol;
}

function exactPayload(payload: unknown): BinanceAggregateTrade[] {
  if (!Array.isArray(payload)) {
    throw new Error("Binance aggregate-trade payload is not an array.");
  }
  const normalized = normalizeBinanceAggregateTrades(payload);
  if (normalized.length !== payload.length) {
    throw new Error("Binance aggregate-trade payload contains invalid or duplicate records.");
  }
  return normalized;
}

class MicroBarAccumulator {
  private readonly durationMs: number;
  private readonly byOpenTime = new Map<number, MutableBar>();

  constructor(
    private readonly symbol: string,
    seconds: 15 | 30,
    private readonly startTime: number,
    private readonly endExclusive: number,
    private readonly initialPrice: number,
  ) {
    this.durationMs = seconds * SECOND_MS;
  }

  accept(trade: BinanceAggregateTrade): void {
    if (trade.executedAt < this.startTime || trade.executedAt >= this.endExclusive) return;
    const openTime = Math.floor(trade.executedAt / this.durationMs) * this.durationMs;
    const existing = this.byOpenTime.get(openTime);
    if (!existing) {
      this.byOpenTime.set(openTime, {
        open: trade.price,
        high: trade.price,
        low: trade.price,
        close: trade.price,
        volume: trade.quantity,
        quoteVolume: trade.price * trade.quantity,
        tradeCount: 1,
      });
      return;
    }
    existing.high = Math.max(existing.high, trade.price);
    existing.low = Math.min(existing.low, trade.price);
    existing.close = trade.price;
    existing.volume += trade.quantity;
    existing.quoteVolume += trade.price * trade.quantity;
    existing.tradeCount += 1;
  }

  bars(): BinanceKline[] {
    const interval = `${this.durationMs / SECOND_MS}s` as "15s" | "30s";
    const result: BinanceKline[] = [];
    let previousClose = this.initialPrice;
    for (
      let openTime = this.startTime;
      openTime < this.endExclusive;
      openTime += this.durationMs
    ) {
      const source = this.byOpenTime.get(openTime);
      if (source) previousClose = source.close;
      result.push({
        symbol: this.symbol,
        interval,
        openTime,
        closeTime: openTime + this.durationMs - 1,
        open: source?.open ?? previousClose,
        high: source?.high ?? previousClose,
        low: source?.low ?? previousClose,
        close: source?.close ?? previousClose,
        volume: source?.volume ?? 0,
        quoteVolume: source?.quoteVolume ?? 0,
        tradeCount: source?.tradeCount ?? 0,
        final: true,
      });
    }
    return result;
  }
}

function updateTradeDigest(hash: ReturnType<typeof createHash>, trade: BinanceAggregateTrade): void {
  hash.update(
    `${trade.aggregateTradeId}\u0000${trade.executedAt}\u0000${trade.price}`
      + `\u0000${trade.quantity}\u0000${Number(trade.buyerWasMaker)}\n`,
  );
}

export async function loadFinCastCadenceMarketData(
  input: FinCastCadenceMarketDataInput,
): Promise<FinCastCadenceMarketData> {
  const symbol = normalizedSymbol(input.symbol);
  const startTime = boundedInteger(
    input.startTime,
    0,
    Number.MAX_SAFE_INTEGER,
    "FinCast cadence startTime",
  );
  const endExclusive = boundedInteger(
    input.endExclusive,
    startTime + 1,
    Number.MAX_SAFE_INTEGER,
    "FinCast cadence endExclusive",
  );
  if (startTime % 30_000 !== 0 || endExclusive % 30_000 !== 0) {
    throw new Error("FinCast cadence aggregate-trade range must align to 30-second boundaries.");
  }
  if (!Number.isFinite(input.initialPrice) || input.initialPrice <= 0) {
    throw new Error("FinCast cadence initialPrice must be positive and finite.");
  }
  const maximumPagesPerLeaf = boundedInteger(
    input.maximumPagesPerLeaf ?? DEFAULT_MAXIMUM_PAGES_PER_LEAF,
    2,
    256,
    "FinCast cadence maximumPagesPerLeaf",
  );
  const pageDelayMs = boundedInteger(
    input.pageDelayMs ?? DEFAULT_PAGE_DELAY_MS,
    0,
    60_000,
    "FinCast cadence pageDelayMs",
  );
  const pace = input.pace ?? defaultPace;
  const bars15 = new MicroBarAccumulator(
    symbol,
    15,
    startTime,
    endExclusive,
    input.initialPrice,
  );
  const bars30 = new MicroBarAccumulator(
    symbol,
    30,
    startTime,
    endExclusive,
    input.initialPrice,
  );
  const hash = createHash("sha256");
  let aggregateTradeCount = 0;
  let requestCount = 0;
  let adaptiveSplitCount = 0;
  let lastTradeId = Number.NEGATIVE_INFINITY;
  let lastExecutedAt = Number.NEGATIVE_INFINITY;

  const consume = (trades: readonly BinanceAggregateTrade[]): void => {
    for (const trade of trades) {
      if (trade.aggregateTradeId <= lastTradeId || trade.executedAt < lastExecutedAt) {
        throw new Error("Binance aggregate-trade history is duplicated or out of order.");
      }
      lastTradeId = trade.aggregateTradeId;
      lastExecutedAt = trade.executedAt;
      aggregateTradeCount += 1;
      updateTradeDigest(hash, trade);
      bars15.accept(trade);
      bars30.accept(trade);
    }
  };

  const fetchLeaf = async (
    windowStart: number,
    windowEnd: number,
  ): Promise<BinanceAggregateTrade[] | undefined> => {
    const trades: BinanceAggregateTrade[] = [];
    let fromId: number | undefined;
    for (let page = 0; page < maximumPagesPerLeaf; page += 1) {
      if (input.signal?.aborted) throw abortError(input.signal);
      if (requestCount > 0) await pace(pageDelayMs, input.signal);
      const payload = await input.aggregateTrades({
        symbol,
        ...(fromId === undefined
          ? { startTime: windowStart, endTime: windowEnd }
          : { fromId }),
        limit: BINANCE_AGGREGATE_TRADE_PAGE_SIZE,
      });
      requestCount += 1;
      const normalized = exactPayload(payload);
      const withinWindow = normalized.filter((trade) => (
        trade.executedAt >= windowStart && trade.executedAt <= windowEnd
      ));
      trades.push(...withinWindow);
      if (normalized.length < BINANCE_AGGREGATE_TRADE_PAGE_SIZE) return trades;
      const last = normalized.at(-1)!;
      if (last.executedAt > windowEnd) return trades;
      const nextId = last.aggregateTradeId + 1;
      if (fromId !== undefined && nextId <= fromId) {
        throw new Error("Binance aggregate-trade pagination did not advance.");
      }
      fromId = nextId;
    }
    // A full final data page is not itself proof that the safety cap was
    // exceeded. Fetch one paced look-ahead page and split only when that page
    // still contains a trade inside the bounded time window.
    if (input.signal?.aborted) throw abortError(input.signal);
    if (requestCount > 0) await pace(pageDelayMs, input.signal);
    const lookAheadPayload = await input.aggregateTrades({
      symbol,
      fromId,
      limit: BINANCE_AGGREGATE_TRADE_PAGE_SIZE,
    });
    requestCount += 1;
    const lookAhead = exactPayload(lookAheadPayload);
    if (!lookAhead.some((trade) => (
      trade.executedAt >= windowStart && trade.executedAt <= windowEnd
    ))) {
      return trades;
    }
    return undefined;
  };

  const fetchAdaptive = async (windowStart: number, windowEnd: number): Promise<void> => {
    const leaf = await fetchLeaf(windowStart, windowEnd);
    if (leaf) {
      consume(leaf);
      return;
    }
    if (windowStart >= windowEnd) {
      throw new Error("Binance aggregate-trade density exceeds the minimum safe time slice.");
    }
    adaptiveSplitCount += 1;
    const midpoint = windowStart + Math.floor((windowEnd - windowStart) / 2);
    await fetchAdaptive(windowStart, midpoint);
    await fetchAdaptive(midpoint + 1, windowEnd);
  };

  for (
    let windowStart = startTime;
    windowStart < endExclusive;
    windowStart += MAXIMUM_BINANCE_WINDOW_MS
  ) {
    const windowEnd = Math.min(
      endExclusive - 1,
      windowStart + MAXIMUM_BINANCE_WINDOW_MS - 1,
    );
    await fetchAdaptive(windowStart, windowEnd);
  }

  const bars15s = bars15.bars();
  const bars30s = bars30.bars();
  if (
    bars15s.length !== (endExclusive - startTime) / 15_000
    || bars30s.length !== (endExclusive - startTime) / 30_000
  ) {
    throw new Error("FinCast cadence micro-bar aggregation produced an incomplete range.");
  }
  return {
    bars15s,
    bars30s,
    aggregateTradeDigest: hash.digest("hex"),
    aggregateTradeCount,
    requestCount,
    requestWeight: requestCount * BINANCE_AGGREGATE_TRADE_REQUEST_WEIGHT,
    adaptiveSplitCount,
  };
}
