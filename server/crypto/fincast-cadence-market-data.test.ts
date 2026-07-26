import { describe, expect, it, vi } from "vitest";
import type { BinanceRestAggregateTradeRequest } from "./binance-market-data.js";
import { loadFinCastCadenceMarketData } from "./fincast-cadence-market-data.js";

const START = Date.parse("2026-07-26T00:00:00.000Z");

function aggregateTradeFixture(input: {
  count: number;
  startTime?: number;
  endTime?: number;
}) {
  const startTime = input.startTime ?? START;
  const endTime = input.endTime ?? START + 29_999;
  const timestampForId = (id: number): number => (
    startTime + Math.floor(
      ((id - 1) * (endTime - startTime))
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
    const firstId = request.fromId ?? firstIdAtOrAfter(request.startTime ?? startTime);
    const result: Array<Record<string, unknown>> = [];
    for (
      let id = firstId;
      id <= input.count && result.length < (request.limit ?? 1_000);
      id += 1
    ) {
      const executedAt = timestampForId(id);
      if (
        request.fromId === undefined
        && request.endTime !== undefined
        && executedAt > request.endTime
      ) break;
      result.push({
        a: id,
        p: String(100 + id / 1_000_000),
        q: "0.001",
        T: executedAt,
        m: id % 2 === 0,
      });
    }
    return result;
  });
}

describe("FinCast cadence aggregate-trade market data", () => {
  it("uses one raw trade pass to construct aligned 15s and 30s bars", async () => {
    const aggregateTrades = vi.fn(async () => [
      { a: 1, p: "100", q: "1", T: START + 1_000, m: false },
      { a: 2, p: "101", q: "2", T: START + 16_000, m: true },
      { a: 3, p: "99", q: "3", T: START + 46_000, m: false },
    ]);
    const result = await loadFinCastCadenceMarketData({
      symbol: "btcusdt",
      startTime: START,
      endExclusive: START + 60_000,
      initialPrice: 98,
      aggregateTrades,
      pageDelayMs: 0,
    });

    expect(aggregateTrades).toHaveBeenCalledTimes(1);
    expect(result.aggregateTradeCount).toBe(3);
    expect(result.bars15s).toHaveLength(4);
    expect(result.bars30s).toHaveLength(2);
    expect(result.bars15s.map((bar) => bar.close)).toEqual([100, 101, 101, 99]);
    expect(result.bars30s.map((bar) => bar.close)).toEqual([101, 99]);
    expect(result.bars15s.reduce((sum, bar) => sum + bar.tradeCount, 0)).toBe(3);
    expect(result.bars30s.reduce((sum, bar) => sum + bar.tradeCount, 0)).toBe(3);
  });

  it("uses an exact-cap look-ahead without incorrectly splitting the leaf", async () => {
    const aggregateTrades = aggregateTradeFixture({ count: 2_000 });
    const result = await loadFinCastCadenceMarketData({
      symbol: "EULUSDT",
      startTime: START,
      endExclusive: START + 30_000,
      initialPrice: 100,
      aggregateTrades,
      maximumPagesPerLeaf: 2,
      pageDelayMs: 0,
    });

    expect(aggregateTrades).toHaveBeenCalledTimes(3);
    expect(result.adaptiveSplitCount).toBe(0);
    expect(result.aggregateTradeCount).toBe(2_000);
    expect(result.bars30s[0]?.tradeCount).toBe(2_000);
  });

  it("adaptively splits only a genuinely over-cap dense leaf and deduplicates results", async () => {
    const aggregateTrades = aggregateTradeFixture({ count: 2_001 });
    const result = await loadFinCastCadenceMarketData({
      symbol: "EULUSDT",
      startTime: START,
      endExclusive: START + 30_000,
      initialPrice: 100,
      aggregateTrades,
      maximumPagesPerLeaf: 2,
      pageDelayMs: 0,
    });

    expect(result.adaptiveSplitCount).toBe(1);
    expect(result.aggregateTradeCount).toBe(2_001);
    expect(result.bars15s.reduce((sum, bar) => sum + bar.tradeCount, 0)).toBe(2_001);
    expect(result.bars30s[0]?.tradeCount).toBe(2_001);
  });

  it("paces every REST request after the first across time-window boundaries", async () => {
    const aggregateTrades = vi.fn(async () => []);
    const pace = vi.fn(async () => undefined);
    await loadFinCastCadenceMarketData({
      symbol: "BTCUSDT",
      startTime: START,
      endExclusive: START + 30 * 60_000,
      initialPrice: 100,
      aggregateTrades,
      pageDelayMs: 550,
      pace,
    });

    expect(aggregateTrades).toHaveBeenCalledTimes(2);
    expect(pace).toHaveBeenCalledTimes(1);
    expect(pace).toHaveBeenCalledWith(550, undefined);
  });
});
