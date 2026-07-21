import { describe, expect, it } from "vitest";
import {
  adaptKisExecution,
  adaptKisMinuteBars,
  adaptKisOrderbook,
  adaptKisVolumeRankings,
} from "./kis-common-adapter.js";

const providerTimestamp = "2026-07-21T09:01:00+09:00";

describe("KIS common contract adapters", () => {
  it("converts KIS percentage changes to common ratios", () => {
    const result = adaptKisVolumeRankings({
      items: [{
        symbol: "005930",
        name: "삼성전자",
        rank: 1,
        price: 80_000,
        changeAmount: 800,
        changeRate: 1.25,
        accumulatedVolume: 100,
        accumulatedTradingAmount: 8_000_000,
      }],
      quality: "available",
      diagnostics: [],
      providerTimestamp,
    });
    expect(result.items[0]).toMatchObject({
      provider: "kis",
      changeRateRatio: 0.0125,
      currency: "KRW",
      marketCountry: "KR",
    });
    expect(result.quality.status).toBe("available");
  });

  it("maps compact session dates but does not mistake cumulative amount for minute amount", () => {
    const result = adaptKisMinuteBars({
      items: [{
        symbol: "005930",
        sessionDate: "20260721",
        timestamp: "2026-07-21T09:00:00+09:00",
        open: 100,
        high: 102,
        low: 99,
        close: 101,
        volume: 5,
        accumulatedTradingAmount: 1_000_000,
        status: "final",
        source: "kis_rest_recovery",
      }],
      quality: "partial",
      diagnostics: [{ index: 2, code: "malformed-row", fields: ["volume"], message: "invalid" }],
      providerTimestamp,
    });
    expect(result.items[0]).toMatchObject({ sessionDate: "2026-07-21", volume: 5 });
    expect(result.items[0]).not.toHaveProperty("tradingAmount");
    expect(result.quality).toMatchObject({ status: "partial", missing: ["row:volume"] });
  });

  it("adapts executions with deterministic provider IDs and delta trading amount", () => {
    const trade = adaptKisExecution({
      type: "execution",
      trId: "H0STCNT0",
      market: "KRX",
      symbol: "005930",
      eventId: "kis:event:1",
      providerTimestamp,
      receivedAt: providerTimestamp,
      sessionDate: "20260721",
      tradeTime: "090100",
      price: 100,
      executionVolume: 3,
      accumulatedVolume: 50,
      accumulatedTradingAmount: 5_000,
      askPrice1: 101,
      bidPrice1: 100,
      executionStrength: 110,
      tradingHalted: false,
    });
    expect(trade).toMatchObject({
      eventId: "kis:event:1",
      eventIdSource: "provider",
      tradingAmount: 300,
      cumulativeVolume: 50,
      side: "unknown",
    });
  });

  it("normalizes orderbook price ordering", () => {
    const book = adaptKisOrderbook({
      type: "orderbook",
      trId: "H0STASP0",
      market: "KRX",
      symbol: "005930",
      providerTimestamp,
      receivedAt: providerTimestamp,
      sessionDate: "20260721",
      quoteTime: "090100",
      timestampDateSource: "received-session-date",
      asks: [{ level: 2, price: 102, quantity: 2 }, { level: 1, price: 101, quantity: 1 }],
      bids: [{ level: 2, price: 99, quantity: 4 }, { level: 1, price: 100, quantity: 3 }],
      totalAskQuantity: 3,
      totalBidQuantity: 7,
    });
    expect(book.asks.map(({ price }) => price)).toEqual([101, 102]);
    expect(book.bids.map(({ price }) => price)).toEqual([100, 99]);
  });
});
