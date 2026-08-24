import type { BinanceMarketEvent } from "./binance-market-data.js";

type AggregateTrade = Extract<BinanceMarketEvent, { kind: "agg_trade" }>;

export type AggregateTradeWindowStats = {
  count: number;
  observedAt: number;
  buyVolume: number;
  sellVolume: number;
};

/**
 * A time-ordered trailing window that avoids shifting the live trade array for
 * every expired observation. Old prefixes are compacted in bounded batches,
 * while inference summaries scan the retained window once without temporary
 * filter/map arrays.
 */
export class AggregateTradeWindow {
  private readonly trades: AggregateTrade[] = [];
  private head = 0;

  constructor(
    private readonly retentionMs: number,
    private readonly compactionThreshold = 1_024,
  ) {
    if (!Number.isSafeInteger(retentionMs) || retentionMs < 1) {
      throw new Error("Aggregate trade retention must be a positive safe integer.");
    }
    if (!Number.isSafeInteger(compactionThreshold) || compactionThreshold < 1) {
      throw new Error("Aggregate trade compaction threshold must be a positive safe integer.");
    }
  }

  push(trade: AggregateTrade): void {
    this.trades.push(trade);
    const cutoff = trade.executedAt - this.retentionMs;
    while (this.trades[this.head]?.executedAt < cutoff) this.head += 1;
    if (this.head >= this.compactionThreshold && this.head * 2 >= this.trades.length) {
      this.trades.splice(0, this.head);
      this.head = 0;
    }
  }

  summarize(afterExclusive: number, throughInclusive: number): AggregateTradeWindowStats | undefined {
    let count = 0;
    let observedAt = Number.NEGATIVE_INFINITY;
    let buyVolume = 0;
    let sellVolume = 0;
    for (let index = this.head; index < this.trades.length; index += 1) {
      const trade = this.trades[index]!;
      if (trade.executedAt <= afterExclusive || trade.executedAt > throughInclusive) continue;
      count += 1;
      observedAt = Math.max(observedAt, trade.executedAt);
      if (trade.buyerWasMaker) sellVolume += trade.quantity;
      else buyVolume += trade.quantity;
    }
    return count ? { count, observedAt, buyVolume, sellVolume } : undefined;
  }

  clear(): void {
    this.trades.length = 0;
    this.head = 0;
  }

  get retainedCount(): number {
    return this.trades.length - this.head;
  }

  /** Visible for bounded-memory regression coverage. */
  get allocatedCount(): number {
    return this.trades.length;
  }
}
