import { describe, expect, it } from "vitest";
import {
  adaptKisExecution,
  adaptKisMinuteBars,
  adaptKisOrderbook,
  adaptKisOverseasRankings,
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

  it("maps US rankings with exchange/USD and preserves per-minute overseas turnover", () => {
    const ranking = adaptKisOverseasRankings({
      items: [{
        symbol: "AAPL", name: "Apple Inc", exchange: "NAS", rank: 1, price: 212.5,
        changeAmount: 2.5, changeRate: 1.25, accumulatedVolume: 1_000,
        accumulatedTradingAmount: 212_500,
      }],
      quality: "available",
      diagnostics: [],
      providerTimestamp,
    });
    expect(ranking.items[0]).toMatchObject({
      marketCountry: "US", exchange: "NAS", currency: "USD", changeRateRatio: 0.0125,
    });

    const candles = adaptKisMinuteBars({
      items: [{
        symbol: "AAPL", sessionDate: "20260721", timestamp: "2026-07-21T13:30:00.000Z",
        open: 100, high: 102, low: 99, close: 101, volume: 5, tradingAmount: 505,
        status: "final", source: "kis_rest_recovery",
      }],
      quality: "available",
      diagnostics: [],
      providerTimestamp,
    });
    expect(candles.items[0]).toMatchObject({ tradingAmount: 505 });
  });

  it("adapts executions with deterministic provider IDs and delta trading amount", () => {
    const trade = adaptKisExecution({
      type: "execution",
      trId: "H0STCNT0",
      market: "NXT",
      marketCountry: "KR",
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
      market: "NXT",
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
      market: "INTEGRATED",
      marketCountry: "KR",
      symbol: "005930",
      providerTimestamp,
      receivedAt: providerTimestamp,
      sessionDate: "20260721",
      quoteTime: "090100",
      timestampDateSource: "received-session-date",
      depth: "ten_level",
      asks: [{ level: 2, price: 102, quantity: 2 }, { level: 1, price: 101, quantity: 1 }],
      bids: [{ level: 2, price: 99, quantity: 4 }, { level: 1, price: 100, quantity: 3 }],
      totalAskQuantity: 3,
      totalBidQuantity: 7,
    });
    expect(book.market).toBe("INTEGRATED");
    expect(book.asks.map(({ price }) => price)).toEqual([101, 102]);
    expect(book.bids.map(({ price }) => price)).toEqual([100, 99]);
  });
});
