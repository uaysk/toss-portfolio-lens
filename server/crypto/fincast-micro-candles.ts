import type {
  BinanceKline,
  BinanceRestAggregateTradeRequest,
} from "./binance-market-data.js";

type UnknownRecord = Record<string, unknown>;

export type BinanceAggregateTrade = {
  aggregateTradeId: number;
  price: number;
  quantity: number;
  executedAt: number;
  buyerWasMaker: boolean;
};

export type FinCastMicroCandleSeconds = 15 | 30;

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

function nonNegativeInteger(value: unknown): number | undefined {
  const parsed = finite(value);
  return parsed !== undefined
    && Number.isSafeInteger(parsed)
    && parsed >= 0
    ? parsed
    : undefined;
}

export function normalizeBinanceAggregateTrades(payload: unknown): BinanceAggregateTrade[] {
  if (!Array.isArray(payload)) return [];
  const byId = new Map<number, BinanceAggregateTrade>();
  for (const value of payload) {
    const source = record(value);
    const aggregateTradeId = nonNegativeInteger(source?.a);
    const price = positive(source?.p);
    const quantity = positive(source?.q);
    const executedAt = nonNegativeInteger(source?.T);
    if (
      aggregateTradeId === undefined
      || price === undefined
      || quantity === undefined
      || executedAt === undefined
    ) continue;
    byId.set(aggregateTradeId, {
      aggregateTradeId,
      price,
      quantity,
      executedAt,
      buyerWasMaker: source?.m === true,
    });
  }
  return [...byId.values()].sort((left, right) => (
    left.executedAt - right.executedAt
    || left.aggregateTradeId - right.aggregateTradeId
  ));
}

function intervalMs(seconds: FinCastMicroCandleSeconds): number {
  return seconds * 1_000;
}

function emptyBar(
  symbol: string,
  openTime: number,
  seconds: FinCastMicroCandleSeconds,
  price: number,
): BinanceKline {
  const duration = intervalMs(seconds);
  return {
    symbol,
    interval: `${seconds}s`,
    openTime,
    closeTime: openTime + duration - 1,
    open: price,
    high: price,
    low: price,
    close: price,
    volume: 0,
    quoteVolume: 0,
    tradeCount: 0,
    final: true,
  };
}

export function aggregateTradesToMicroBars(input: {
  symbol: string;
  trades: readonly BinanceAggregateTrade[];
  intervalSeconds: FinCastMicroCandleSeconds;
  startTime: number;
  endTime: number;
  initialPrice?: number;
}): BinanceKline[] {
  const symbol = input.symbol.trim().toUpperCase();
  const duration = intervalMs(input.intervalSeconds);
  if (!symbol || !Number.isSafeInteger(input.startTime) || !Number.isSafeInteger(input.endTime)
    || input.endTime < input.startTime) {
    throw new Error("FinCast micro-candle aggregation range is invalid.");
  }
  const firstOpen = Math.floor(input.startTime / duration) * duration;
  const lastOpen = Math.floor(input.endTime / duration) * duration;
  const trades = [...input.trades]
    .filter((trade) => trade.executedAt >= firstOpen && trade.executedAt <= input.endTime)
    .sort((left, right) => (
      left.executedAt - right.executedAt
      || left.aggregateTradeId - right.aggregateTradeId
    ));
  let tradeIndex = 0;
  let previousClose = input.initialPrice;
  const bars: BinanceKline[] = [];
  for (let openTime = firstOpen; openTime <= lastOpen; openTime += duration) {
    const bucketEnd = openTime + duration;
    const bucket: BinanceAggregateTrade[] = [];
    while (tradeIndex < trades.length && trades[tradeIndex]!.executedAt < bucketEnd) {
      bucket.push(trades[tradeIndex]!);
      tradeIndex += 1;
    }
    if (!bucket.length) {
      if (previousClose !== undefined && previousClose > 0) {
        bars.push(emptyBar(symbol, openTime, input.intervalSeconds, previousClose));
      }
      continue;
    }
    const open = bucket[0]!.price;
    const close = bucket.at(-1)!.price;
    const volume = bucket.reduce((sum, trade) => sum + trade.quantity, 0);
    bars.push({
      symbol,
      interval: `${input.intervalSeconds}s`,
      openTime,
      closeTime: bucketEnd - 1,
      open,
      high: Math.max(...bucket.map((trade) => trade.price)),
      low: Math.min(...bucket.map((trade) => trade.price)),
      close,
      volume,
      quoteVolume: bucket.reduce(
        (sum, trade) => sum + trade.price * trade.quantity,
        0,
      ),
      tradeCount: bucket.length,
      final: true,
    });
    previousClose = close;
  }
  return bars;
}

export class FinCastMicroCandleAggregator {
  private current: BinanceKline | undefined;
  private lastTradeId = Number.NEGATIVE_INFINITY;
  private previousClose: number | undefined;
  private previousOpenTime: number | undefined;

  constructor(
    private readonly symbol: string,
    private readonly intervalSeconds: FinCastMicroCandleSeconds,
    seed?: BinanceKline,
  ) {
    if (seed) {
      this.previousClose = seed.close;
      this.previousOpenTime = seed.openTime;
    }
  }

  accept(trade: BinanceAggregateTrade): BinanceKline[] {
    if (trade.aggregateTradeId <= this.lastTradeId) return [];
    this.lastTradeId = trade.aggregateTradeId;
    const duration = intervalMs(this.intervalSeconds);
    const openTime = Math.floor(trade.executedAt / duration) * duration;
    if (!this.current) {
      const completed: BinanceKline[] = [];
      if (this.previousClose !== undefined && this.previousOpenTime !== undefined) {
        for (
          let gapOpen = this.previousOpenTime + duration;
          gapOpen < openTime;
          gapOpen += duration
        ) {
          completed.push(emptyBar(
            this.symbol,
            gapOpen,
            this.intervalSeconds,
            this.previousClose,
          ));
        }
      }
      this.current = {
        symbol: this.symbol,
        interval: `${this.intervalSeconds}s`,
        openTime,
        closeTime: openTime + duration - 1,
        open: trade.price,
        high: trade.price,
        low: trade.price,
        close: trade.price,
        volume: trade.quantity,
        quoteVolume: trade.price * trade.quantity,
        tradeCount: 1,
        final: false,
      };
      return completed;
    }
    if (openTime < this.current.openTime) return [];
    if (openTime === this.current.openTime) {
      this.current.high = Math.max(this.current.high, trade.price);
      this.current.low = Math.min(this.current.low, trade.price);
      this.current.close = trade.price;
      this.current.volume += trade.quantity;
      this.current.quoteVolume += trade.price * trade.quantity;
      this.current.tradeCount += 1;
      return [];
    }
    const completed = [{ ...this.current, final: true }];
    let previousClose = this.current.close;
    for (
      let gapOpen = this.current.openTime + duration;
      gapOpen < openTime;
      gapOpen += duration
    ) {
      const gap = emptyBar(this.symbol, gapOpen, this.intervalSeconds, previousClose);
      completed.push(gap);
      previousClose = gap.close;
    }
    this.current = {
      symbol: this.symbol,
      interval: `${this.intervalSeconds}s`,
      openTime,
      closeTime: openTime + duration - 1,
      open: trade.price,
      high: trade.price,
      low: trade.price,
      close: trade.price,
      volume: trade.quantity,
      quoteVolume: trade.price * trade.quantity,
      tradeCount: 1,
      final: false,
    };
    this.previousClose = completed.at(-1)!.close;
    this.previousOpenTime = completed.at(-1)!.openTime;
    return completed;
  }
}

export async function loadFinCastMicroContext(input: {
  symbol: string;
  intervalSeconds: FinCastMicroCandleSeconds;
  contextBars: number;
  endTime: number;
  initialPrice?: number;
  signal?: AbortSignal;
  aggregateTrades(request: BinanceRestAggregateTradeRequest): Promise<unknown>;
}): Promise<BinanceKline[]> {
  const duration = intervalMs(input.intervalSeconds);
  const finalBucketOpen = Math.floor((input.endTime - 1) / duration) * duration;
  const startTime = finalBucketOpen - (input.contextBars - 1) * duration;
  const trades: BinanceAggregateTrade[] = [];
  const maximumWindowMs = 59 * 60_000;
  for (let windowStart = startTime; windowStart <= input.endTime; windowStart += maximumWindowMs) {
    const windowEnd = Math.min(input.endTime, windowStart + maximumWindowMs - 1);
    let fromId: number | undefined;
    for (let page = 0; page < 256; page += 1) {
      if (input.signal?.aborted) {
        throw input.signal.reason instanceof Error
          ? input.signal.reason
          : new Error("FinCast micro-candle recovery was aborted.");
      }
      const raw = await input.aggregateTrades({
        symbol: input.symbol,
        ...(fromId === undefined
          ? { startTime: windowStart, endTime: windowEnd }
          : { fromId }),
        limit: 1_000,
      });
      const normalized = normalizeBinanceAggregateTrades(raw);
      const withinWindow = normalized.filter(
        (trade) => trade.executedAt >= windowStart && trade.executedAt <= windowEnd,
      );
      trades.push(...withinWindow);
      if (normalized.length < 1_000) break;
      const last = normalized.at(-1)!;
      if (last.executedAt > windowEnd) break;
      const nextId = last.aggregateTradeId + 1;
      if (fromId !== undefined && nextId <= fromId) {
        throw new Error("Binance aggregate-trade pagination did not advance.");
      }
      fromId = nextId;
      // The endpoint costs 20 request-weight units. Pace dense-symbol paging
      // below 120 calls/minute instead of bursting through Binance's public
      // market-data budget during the one-time context recovery.
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          clearTimeout(timer);
          reject(input.signal?.reason instanceof Error
            ? input.signal.reason
            : new Error("FinCast micro-candle recovery was aborted."));
        };
        const timer = setTimeout(() => {
          input.signal?.removeEventListener("abort", onAbort);
          resolve();
        }, 550);
        input.signal?.addEventListener("abort", onAbort, { once: true });
      });
      if (page === 255) {
        throw new Error("Binance aggregate-trade pagination exceeded the safety limit.");
      }
    }
  }
  const normalized = [...new Map(
    trades.map((trade) => [trade.aggregateTradeId, trade]),
  ).values()].sort((left, right) => (
    left.executedAt - right.executedAt
    || left.aggregateTradeId - right.aggregateTradeId
  ));
  const bars = aggregateTradesToMicroBars({
    symbol: input.symbol,
    trades: normalized,
    intervalSeconds: input.intervalSeconds,
    startTime,
    endTime: finalBucketOpen + duration - 1,
    initialPrice: input.initialPrice,
  }).slice(-input.contextBars);
  if (bars.length !== input.contextBars) {
    throw new Error(`FinCast ${input.intervalSeconds}s context is incomplete.`);
  }
  return bars;
}
