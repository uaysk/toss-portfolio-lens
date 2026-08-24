import { describe, expect, it } from "vitest";
import type { BinanceMarketEvent } from "./binance-market-data.js";
import { AggregateTradeWindow } from "./aggregate-trade-window.js";

function trade(
  executedAt: number,
  quantity: number,
  buyerWasMaker: boolean,
): Extract<BinanceMarketEvent, { kind: "agg_trade" }> {
  return {
    kind: "agg_trade",
    source: "binance_ws",
    symbol: "BTCUSDT",
    aggregateTradeId: String(executedAt),
    price: 100,
    quantity,
    executedAt,
    buyerWasMaker,
    receivedAt: executedAt,
  };
}

describe("AggregateTradeWindow", () => {
  it("matches the causal open/closed interval and aggregates it in one pass", () => {
    const window = new AggregateTradeWindow(120_000, 4);
    window.push(trade(60_000, 1, false));
    window.push(trade(90_000, 2, true));
    window.push(trade(120_000, 3, false));
    window.push(trade(150_000, 4, true));

    expect(window.summarize(90_000, 150_000)).toEqual({
      count: 2,
      observedAt: 150_000,
      buyVolume: 3,
      sellVolume: 4,
    });
    expect(window.summarize(150_000, 180_000)).toBeUndefined();
  });

  it("amortizes expiry compaction and bounds stale allocated prefixes", () => {
    const window = new AggregateTradeWindow(10, 8);
    for (let timestamp = 0; timestamp < 10_000; timestamp += 1) {
      window.push(trade(timestamp, 1, false));
    }

    expect(window.retainedCount).toBe(11);
    expect(window.allocatedCount).toBeLessThan(32);
    expect(window.summarize(9_988, 9_999)).toEqual({
      count: 11,
      observedAt: 9_999,
      buyVolume: 11,
      sellVolume: 0,
    });

    window.clear();
    expect(window.retainedCount).toBe(0);
    expect(window.allocatedCount).toBe(0);
  });
});
