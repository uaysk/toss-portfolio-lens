import { describe, expect, it } from "vitest";
import {
  NormalizedMinuteCandleSchema,
  NormalizedOrderbookSchema,
  NormalizedTradeSchema,
  createScannerRequestSchema,
  isoTimestampSchema,
} from "./contracts.js";

describe("scalping contracts", () => {
  it("requires RFC3339 timestamps with explicit offsets", () => {
    expect(isoTimestampSchema.parse("2026-07-21T09:00:00+09:00")).toBe("2026-07-21T09:00:00+09:00");
    expect(isoTimestampSchema.parse("2026-07-21T00:00:00Z")).toBe("2026-07-21T00:00:00Z");
    expect(() => isoTimestampSchema.parse("2026-07-21T09:00:00")).toThrow();
    expect(() => isoTimestampSchema.parse("not-a-date")).toThrow();
  });

  it("rejects unknown properties and invalid OHLC bounds", () => {
    const base = {
      provider: "toss",
      symbol: "005930",
      timestamp: "2026-07-21T09:00:00+09:00",
      sessionDate: "2026-07-21",
      interval: "1m",
      status: "final",
      open: 100,
      high: 102,
      low: 99,
      close: 101,
      volume: 50,
    } as const;
    expect(NormalizedMinuteCandleSchema.parse(base).close).toBe(101);
    expect(() => NormalizedMinuteCandleSchema.parse({ ...base, high: 100 })).toThrow(/high must bound/);
    expect(() => NormalizedMinuteCandleSchema.parse({ ...base, secret: "must-not-pass" })).toThrow();
  });

  it("requires best-to-worst orderbook ordering", () => {
    const base = {
      provider: "kis",
      symbol: "AAPL",
      market: "US",
      exchange: "NAS",
      sessionFeed: "standard",
      sessionDate: "2026-07-21",
      observedAt: "2026-07-21T09:00:00+09:00",
      receivedAt: "2026-07-21T00:00:00Z",
      asks: [{ price: 101, quantity: 10 }, { price: 102, quantity: 20 }],
      bids: [{ price: 100, quantity: 30 }, { price: 99, quantity: 40 }],
    } as const;
    expect(NormalizedOrderbookSchema.parse(base)).toMatchObject({
      market: "US",
      exchange: "NAS",
      sessionFeed: "standard",
      sessionDate: "2026-07-21",
      receivedAt: "2026-07-21T00:00:00Z",
      asks: expect.any(Array),
    });
    expect(() => NormalizedOrderbookSchema.parse({ ...base, asks: [...base.asks].reverse() })).toThrow(/asks must be ordered/);
    expect(() => NormalizedOrderbookSchema.parse({ ...base, bids: [...base.bids].reverse() })).toThrow(/bids must be ordered/);
    expect(() => NormalizedOrderbookSchema.parse({ ...base, sessionFeed: "overnight" })).toThrow();
  });

  it("preserves only canonical KIS market venues on realtime contracts", () => {
    const trade = {
      provider: "kis",
      symbol: "005930",
      market: "NXT",
      eventId: "kis:nxt:1",
      eventIdSource: "provider",
      executedAt: "2026-07-21T16:01:00+09:00",
      receivedAt: "2026-07-21T07:01:00Z",
      sessionDate: "2026-07-21",
      price: 101,
      quantity: 2,
      side: "unknown",
      cumulativeTradingAmount: 1_000,
      executionClassCode: "1",
      bestBidPrice: 100,
      bestAskPrice: 102,
    } as const;
    expect(NormalizedTradeSchema.parse(trade)).toMatchObject({
      market: "NXT",
      receivedAt: "2026-07-21T07:01:00Z",
      sessionDate: "2026-07-21",
      cumulativeTradingAmount: 1_000,
      executionClassCode: "1",
      bestBidPrice: 100,
      bestAskPrice: 102,
    });
    expect(() => NormalizedTradeSchema.parse({ ...trade, market: "AFTERMARKET" })).toThrow();
    expect(() => NormalizedTradeSchema.parse({ ...trade, unknownProvenance: "must-not-pass" })).toThrow();
  });

  it("uses configured scanner count limits", () => {
    const schema = createScannerRequestSchema({ minimumTopCount: 3, maximumTopCount: 17 });
    expect(schema.parse({ criterion: "volume", topCount: 3 })).toEqual({
      marketCountry: "KR", criterion: "volume", topCount: 3,
    });
    expect(schema.parse({ marketCountry: "US", criterion: "volume", topCount: 3 })).toEqual({
      marketCountry: "US", criterion: "volume", topCount: 3,
    });
    expect(() => schema.parse({ marketCountry: "JP", criterion: "volume", topCount: 3 })).toThrow();
    expect(() => schema.parse({ criterion: "volume", topCount: 2 })).toThrow();
    expect(() => schema.parse({ criterion: "volume", topCount: 18 })).toThrow();
    expect(() => createScannerRequestSchema({ minimumTopCount: 10, maximumTopCount: 5 })).toThrow();
  });
});
