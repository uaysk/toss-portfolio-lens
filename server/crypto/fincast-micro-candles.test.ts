import { describe, expect, it, vi } from "vitest";
import {
  FinCastMicroCandleAggregator,
  aggregateTradesToMicroBars,
  loadFinCastMicroContext,
  normalizeBinanceAggregateTrades,
} from "./fincast-micro-candles.js";

const START = Date.parse("2026-07-26T00:00:00.000Z");

describe("FinCast aggregate-trade micro candles", () => {
  it("normalizes, orders, and deduplicates Binance aggregate trades", () => {
    expect(normalizeBinanceAggregateTrades([
      { a: 2, p: "102", q: "2", T: START + 20_000, m: true },
      { a: 1, p: "100", q: "1", T: START + 1_000, m: false },
      { a: 2, p: "999", q: "1", T: START + 20_000, m: false },
      { a: "bad", p: "1", q: "1", T: START },
    ])).toEqual([
      expect.objectContaining({ aggregateTradeId: 1, price: 100 }),
      expect.objectContaining({ aggregateTradeId: 2, price: 999 }),
    ]);
  });

  it("aggregates exact 15-second OHLCV and fills no-trade gaps causally", () => {
    const bars = aggregateTradesToMicroBars({
      symbol: "btcusdt",
      intervalSeconds: 15,
      startTime: START,
      endTime: START + 44_999,
      trades: [
        { aggregateTradeId: 1, price: 100, quantity: 1, executedAt: START + 1_000, buyerWasMaker: false },
        { aggregateTradeId: 2, price: 102, quantity: 2, executedAt: START + 14_999, buyerWasMaker: true },
        { aggregateTradeId: 3, price: 99, quantity: 3, executedAt: START + 31_000, buyerWasMaker: false },
      ],
    });
    expect(bars).toEqual([
      expect.objectContaining({
        symbol: "BTCUSDT",
        interval: "15s",
        open: 100,
        high: 102,
        low: 100,
        close: 102,
        volume: 3,
        tradeCount: 2,
      }),
      expect.objectContaining({
        open: 102,
        high: 102,
        low: 102,
        close: 102,
        volume: 0,
        tradeCount: 0,
      }),
      expect.objectContaining({
        open: 99,
        high: 99,
        low: 99,
        close: 99,
        volume: 3,
        tradeCount: 1,
      }),
    ]);
  });

  it("emits only completed live buckets and ignores duplicate trade IDs", () => {
    const aggregator = new FinCastMicroCandleAggregator("BTCUSDT", 30);
    expect(aggregator.accept({
      aggregateTradeId: 1,
      price: 100,
      quantity: 1,
      executedAt: START + 1_000,
      buyerWasMaker: false,
    })).toEqual([]);
    expect(aggregator.accept({
      aggregateTradeId: 1,
      price: 101,
      quantity: 1,
      executedAt: START + 2_000,
      buyerWasMaker: false,
    })).toEqual([]);
    expect(aggregator.accept({
      aggregateTradeId: 2,
      price: 103,
      quantity: 1,
      executedAt: START + 61_000,
      buyerWasMaker: false,
    })).toEqual([
      expect.objectContaining({ openTime: START, close: 100, final: true }),
      expect.objectContaining({ openTime: START + 30_000, close: 100, volume: 0 }),
    ]);
  });

  it("pages REST trades and returns an exact bounded context", async () => {
    const aggregateTrades = vi.fn(async () => [
      { a: 1, p: "100", q: "1", T: START + 1_000, m: false },
      { a: 2, p: "101", q: "1", T: START + 31_000, m: false },
    ]);
    const bars = await loadFinCastMicroContext({
      symbol: "BTCUSDT",
      intervalSeconds: 30,
      contextBars: 2,
      endTime: START + 60_000,
      aggregateTrades,
    });
    expect(bars).toHaveLength(2);
    expect(bars.map((bar) => bar.close)).toEqual([100, 101]);
    expect(aggregateTrades).toHaveBeenCalledWith(expect.objectContaining({
      symbol: "BTCUSDT",
      limit: 1_000,
    }));
  });
});
