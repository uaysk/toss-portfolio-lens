import { describe, expect, it, vi } from "vitest";
import {
  FinCastMicroCandleAggregator,
  aggregateTradesToMicroBars,
  loadFinCastMicroContext,
  normalizeBinanceAggregateTrades,
} from "./fincast-micro-candles.js";
import type { BinanceRestAggregateTradeRequest } from "./binance-market-data.js";

const START = Date.parse("2026-07-26T00:00:00.000Z");

function denseAggregateTradeFixture(input: {
  startTime: number;
  endTime: number;
  count: number;
}) {
  const timestampForId = (id: number): number => (
    input.startTime + Math.floor(
      ((id - 1) * (input.endTime - input.startTime))
      / Math.max(1, input.count - 1),
    )
  );
  const firstIdAtOrAfter = (timestamp: number): number => {
    let low = 1;
    let high = input.count + 1;
    while (low < high) {
      const midpoint = low + Math.floor((high - low) / 2);
      if (midpoint <= input.count && timestampForId(midpoint) < timestamp) {
        low = midpoint + 1;
      } else {
        high = midpoint;
      }
    }
    return low;
  };
  return vi.fn(async (request: BinanceRestAggregateTradeRequest) => {
    const firstId = request.fromId ?? firstIdAtOrAfter(
      request.startTime ?? input.startTime,
    );
    const limit = request.limit ?? 500;
    const result: Array<Record<string, unknown>> = [];
    for (
      let id = Math.max(1, firstId);
      id <= input.count && result.length < limit;
      id += 1
    ) {
      const executedAt = timestampForId(id);
      if (request.fromId === undefined && request.endTime !== undefined
        && executedAt > request.endTime) {
        break;
      }
      result.push({
        a: id,
        p: String(100 + (id % 10) / 100),
        q: "0.001",
        T: executedAt,
        m: id % 2 === 0,
      });
    }
    return result;
  });
}

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

  it("uses an exact-cap look-ahead without dropping or duplicating trades", async () => {
    vi.useFakeTimers();
    try {
      const aggregateTrades = denseAggregateTradeFixture({
        startTime: START,
        endTime: START + 29_999,
        count: 256_000,
      });
      const pending = loadFinCastMicroContext({
        symbol: "BTCUSDT",
        intervalSeconds: 30,
        contextBars: 1,
        endTime: START + 30_000,
        aggregateTrades,
      });
      await vi.runAllTimersAsync();
      const bars = await pending;

      expect(bars).toHaveLength(1);
      expect(bars[0]?.tradeCount).toBe(256_000);
      expect(aggregateTrades).toHaveBeenCalledTimes(257);
      expect(aggregateTrades.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({
        fromId: 256_001,
        limit: 1_000,
      }));
      expect(aggregateTrades.mock.calls.filter(
        ([request]) => request.fromId === undefined,
      )).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  }, 30_000);

  it("adaptively splits a window denser than 256 pages with bounded results", async () => {
    vi.useFakeTimers();
    try {
      const aggregateTrades = denseAggregateTradeFixture({
        startTime: START,
        endTime: START + 59_999,
        count: 256_001,
      });
      const pending = loadFinCastMicroContext({
        symbol: "EULUSDT",
        intervalSeconds: 30,
        contextBars: 2,
        endTime: START + 60_000,
        aggregateTrades,
      });
      await vi.runAllTimersAsync();
      const bars = await pending;

      expect(bars).toHaveLength(2);
      expect(bars.reduce((sum, bar) => sum + bar.tradeCount, 0)).toBe(256_001);
      expect(aggregateTrades.mock.calls.length).toBeGreaterThan(256);
      const boundedStarts = aggregateTrades.mock.calls
        .map(([request]) => request)
        .filter((request) => request.fromId === undefined)
        .map((request) => request.startTime);
      expect(boundedStarts).toEqual(expect.arrayContaining([
        START,
        START + 30_000,
      ]));
    } finally {
      vi.useRealTimers();
    }
  }, 30_000);

  it("keeps adjacent initial-window boundaries disjoint", async () => {
    const trades = [
      { a: 1, p: "100", q: "1", T: START + 1, m: false },
      { a: 2, p: "101", q: "1", T: START + 899_999, m: false },
      { a: 3, p: "102", q: "1", T: START + 900_000, m: false },
      { a: 4, p: "103", q: "1", T: START + 1_799_999, m: false },
      { a: 5, p: "104", q: "1", T: START + 1_800_000, m: false },
      { a: 6, p: "105", q: "1", T: START + 1_859_999, m: false },
    ];
    const aggregateTrades = vi.fn(async (request: BinanceRestAggregateTradeRequest) => (
      trades.filter((trade) => (
        trade.T >= (request.startTime ?? Number.NEGATIVE_INFINITY)
        && trade.T <= (request.endTime ?? Number.POSITIVE_INFINITY)
        && trade.a >= (request.fromId ?? 0)
      )).slice(0, request.limit)
    ));
    const bars = await loadFinCastMicroContext({
      symbol: "BTCUSDT",
      intervalSeconds: 30,
      contextBars: 62,
      endTime: START + 1_860_000,
      initialPrice: 99,
      aggregateTrades,
    });

    expect(bars).toHaveLength(62);
    expect(bars.reduce((sum, bar) => sum + bar.tradeCount, 0)).toBe(6);
    expect(aggregateTrades.mock.calls.map(([request]) => ({
      startTime: request.startTime,
      endTime: request.endTime,
    }))).toEqual([
      { startTime: START, endTime: START + 899_999 },
      { startTime: START + 900_000, endTime: START + 1_799_999 },
      { startTime: START + 1_800_000, endTime: START + 1_859_999 },
    ]);
  });

  it("aborts a paced page wait and removes its listener and timer", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const reason = new Error("cancel dense recovery");
      const removeListener = vi.spyOn(controller.signal, "removeEventListener");
      const aggregateTrades = vi.fn(async () => Array.from(
        { length: 1_000 },
        (_, offset) => ({
          a: offset + 1,
          p: "100",
          q: "1",
          T: START + offset,
          m: false,
        }),
      ));
      const pending = loadFinCastMicroContext({
        symbol: "BTCUSDT",
        intervalSeconds: 30,
        contextBars: 1,
        endTime: START + 30_000,
        signal: controller.signal,
        aggregateTrades,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(1);

      controller.abort(reason);

      await expect(pending).rejects.toBe(reason);
      expect(aggregateTrades).toHaveBeenCalledTimes(1);
      expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
