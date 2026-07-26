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

const AGGREGATE_TRADE_PAGE_SIZE = 1_000;
const AGGREGATE_TRADE_MAX_DATA_PAGES_PER_WINDOW = 256;
const AGGREGATE_TRADE_INITIAL_WINDOW_MS = 15 * 60_000;
const AGGREGATE_TRADE_PAGE_DELAY_MS = 550;

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
  const contextEndTime = finalBucketOpen + duration - 1;
  const buckets = new Map<number, BinanceKline>();
  let aggregateTradeRequestStarted = false;

  const abortError = (): Error => (
    input.signal?.reason instanceof Error
      ? input.signal.reason
      : new Error("FinCast micro-candle recovery was aborted.")
  );
  const cancellationCheckpoint = (): void => {
    if (input.signal?.aborted) throw abortError();
  };
  const waitForRequestBudget = async (): Promise<void> => {
    cancellationCheckpoint();
    if (!aggregateTradeRequestStarted) {
      aggregateTradeRequestStarted = true;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const onAbort = () => {
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", onAbort);
        reject(abortError());
      };
      timer = setTimeout(() => {
        input.signal?.removeEventListener("abort", onAbort);
        resolve();
      }, AGGREGATE_TRADE_PAGE_DELAY_MS);
      input.signal?.addEventListener("abort", onAbort, { once: true });
    });
    cancellationCheckpoint();
  };
  const fetchPage = async (
    request: BinanceRestAggregateTradeRequest,
  ): Promise<BinanceAggregateTrade[]> => {
    await waitForRequestBudget();
    cancellationCheckpoint();
    return normalizeBinanceAggregateTrades(await input.aggregateTrades(request));
  };
  const mergeWindowTrades = (trades: readonly BinanceAggregateTrade[]): void => {
    for (const trade of trades) {
      if (trade.executedAt < startTime || trade.executedAt > contextEndTime) continue;
      const openTime = Math.floor(trade.executedAt / duration) * duration;
      const existing = buckets.get(openTime);
      if (existing) {
        existing.high = Math.max(existing.high, trade.price);
        existing.low = Math.min(existing.low, trade.price);
        existing.close = trade.price;
        existing.volume += trade.quantity;
        existing.quoteVolume += trade.price * trade.quantity;
        existing.tradeCount += 1;
        continue;
      }
      buckets.set(openTime, {
        symbol: input.symbol.trim().toUpperCase(),
        interval: `${input.intervalSeconds}s`,
        openTime,
        closeTime: openTime + duration - 1,
        open: trade.price,
        high: trade.price,
        low: trade.price,
        close: trade.price,
        volume: trade.quantity,
        quoteVolume: trade.price * trade.quantity,
        tradeCount: 1,
        final: true,
      });
    }
  };

  type WindowResult =
    | { kind: "complete"; trades: BinanceAggregateTrade[] }
    | { kind: "split_required" };
  const fetchBoundedWindow = async (
    windowStart: number,
    windowEnd: number,
  ): Promise<WindowResult> => {
    const windowTrades: BinanceAggregateTrade[] = [];
    let fromId: number | undefined;
    for (let page = 0; ; page += 1) {
      cancellationCheckpoint();
      const normalized = await fetchPage({
        symbol: input.symbol,
        ...(fromId === undefined
          ? { startTime: windowStart, endTime: windowEnd }
          : { fromId }),
        limit: AGGREGATE_TRADE_PAGE_SIZE,
      });
      const withinWindow = normalized.filter(
        (trade) => trade.executedAt >= windowStart && trade.executedAt <= windowEnd,
      );

      // A look-ahead page distinguishes an exact 256-page range from a
      // genuinely denser range. Dense ranges are bisected and retried instead
      // of raising a false safety-limit failure or growing raw-trade memory.
      if (page >= AGGREGATE_TRADE_MAX_DATA_PAGES_PER_WINDOW) {
        return withinWindow.length
          ? { kind: "split_required" }
          : { kind: "complete", trades: windowTrades };
      }
      windowTrades.push(...withinWindow);
      if (normalized.length < AGGREGATE_TRADE_PAGE_SIZE) {
        return { kind: "complete", trades: windowTrades };
      }
      const last = normalized.at(-1)!;
      if (last.executedAt > windowEnd) {
        return { kind: "complete", trades: windowTrades };
      }
      const nextId = last.aggregateTradeId + 1;
      if (fromId !== undefined && nextId <= fromId) {
        throw new Error("Binance aggregate-trade pagination did not advance.");
      }
      fromId = nextId;
    }
  };
  const loadAdaptiveWindow = async (
    windowStart: number,
    windowEnd: number,
  ): Promise<void> => {
    const result = await fetchBoundedWindow(windowStart, windowEnd);
    if (result.kind === "complete") {
      mergeWindowTrades(result.trades);
      return;
    }
    if (windowStart >= windowEnd) {
      throw new Error(
        "Binance aggregate-trade density exceeds the minimum adaptive window.",
      );
    }
    const midpoint = windowStart + Math.floor((windowEnd - windowStart) / 2);
    await loadAdaptiveWindow(windowStart, midpoint);
    await loadAdaptiveWindow(midpoint + 1, windowEnd);
  };

  // Fifteen-minute initial slices keep ordinary high-volume symbols well below
  // the bounded page buffer. Exceptionally dense slices are recursively split
  // without changing timestamp ordering or the causal context boundary.
  for (
    let windowStart = startTime;
    windowStart <= contextEndTime;
    windowStart += AGGREGATE_TRADE_INITIAL_WINDOW_MS
  ) {
    const windowEnd = Math.min(
      contextEndTime,
      windowStart + AGGREGATE_TRADE_INITIAL_WINDOW_MS - 1,
    );
    await loadAdaptiveWindow(windowStart, windowEnd);
  }

  const bars: BinanceKline[] = [];
  let previousClose = input.initialPrice;
  for (
    let openTime = startTime;
    openTime <= finalBucketOpen;
    openTime += duration
  ) {
    const populated = buckets.get(openTime);
    if (populated) {
      bars.push(populated);
      previousClose = populated.close;
    } else if (previousClose !== undefined && previousClose > 0) {
      bars.push(emptyBar(
        input.symbol.trim().toUpperCase(),
        openTime,
        input.intervalSeconds,
        previousClose,
      ));
    }
  }
  if (bars.length !== input.contextBars) {
    throw new Error(`FinCast ${input.intervalSeconds}s context is incomplete.`);
  }
  return bars;
}
