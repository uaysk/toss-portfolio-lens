import { describe, expect, it } from "vitest";
import type {
  InstrumentState,
  NormalizedOrderbook,
  NormalizedPrice,
  NormalizedRanking,
  NormalizedWarning,
  VolatilityInputs,
} from "./contracts.js";
import { ScalpingScanner, type ScannerConfig, type ScannerSnapshot } from "./scanner-service.js";

const observedAt = "2026-07-21T09:00:00+09:00";
const now = Date.parse("2026-07-21T09:01:00+09:00");

function config(overrides: Partial<ScannerConfig> = {}): ScannerConfig {
  return {
    minimumTopCount: 1,
    maximumTopCount: 50,
    minimumVolume: 0,
    minimumTradingAmount: 0,
    maximumSpreadBps: 1_000,
    filterLowLiquidity: true,
    filterWideSpread: true,
    blockingWarningCodes: ["INVESTMENT_RISK"],
    cautionWarningCodes: ["INVESTMENT_CAUTION"],
    minimumVolatilityComponents: 3,
    volatilityWeights: {
      realizedVolatility: 1,
      normalizedAtr: 1,
      dayRangeRatio: 1,
      bollingerWidthExpansion: 1,
      relativeVolume: 1,
      tradingAmount: 1,
      spreadBps: 1,
    },
    providerPrecedence: ["kis", "toss"],
    staleAfterMs: 60_000,
    now: () => now,
    ...overrides,
  };
}

function ranking(
  provider: "toss" | "kis",
  symbol: string,
  rank: number,
  values: Partial<NormalizedRanking> = {},
): NormalizedRanking {
  return {
    provider,
    symbol,
    name: `name-${symbol}`,
    marketCountry: "KR",
    currency: "KRW",
    rank,
    rankedAt: observedAt,
    price: 100,
    volume: 100,
    tradingAmount: 10_000,
    ...values,
  };
}

function price(symbol: string, values: Partial<NormalizedPrice> = {}): NormalizedPrice {
  return {
    provider: "toss",
    symbol,
    currency: "KRW",
    observedAt,
    price: 100,
    ...values,
  };
}

function book(symbol: string, ask: number, bid: number): NormalizedOrderbook {
  return {
    provider: "kis",
    symbol,
    observedAt,
    asks: [{ price: ask, quantity: 10 }],
    bids: [{ price: bid, quantity: 10 }],
  };
}

function state(symbol: string, values: Partial<InstrumentState> = {}): InstrumentState {
  return {
    symbol,
    suspended: false,
    managed: false,
    liquidationTrading: false,
    investmentCaution: false,
    unsupported: false,
    reasons: [],
    ...values,
  };
}

function snapshot(values: Partial<ScannerSnapshot> = {}): ScannerSnapshot {
  return {
    rankings: [],
    prices: [],
    orderbooks: [],
    warnings: [],
    instrumentStates: [],
    volatilityInputs: {},
    ...values,
  };
}

describe("ScalpingScanner", () => {
  it("merges provider candidates, prefers configured live prices and sorts by amount", () => {
    const scanner = new ScalpingScanner(config());
    const result = scanner.scan({ criterion: "trading_amount", topCount: 2 }, snapshot({
      rankings: [
        ranking("toss", "A", 2, { tradingAmount: 20_000 }),
        ranking("kis", "A", 1, { tradingAmount: 19_000 }),
        ranking("kis", "B", 2, { tradingAmount: 30_000 }),
      ],
      prices: [price("A", { price: 123, tradingAmount: 40_000 })],
      orderbooks: [book("A", 101, 100), book("B", 101, 100)],
      warnings: [{
        provider: "toss",
        symbol: "A",
        code: "INVESTMENT_CAUTION",
        severity: "unknown",
        observedAt,
      }],
    }));
    expect(result.candidates.map(({ symbol }) => symbol)).toEqual(["A", "B"]);
    expect(result.candidates[0]).toMatchObject({
      price: 123,
      tradingAmount: 40_000,
      providerRanks: { toss: 2, kis: 1 },
      filtered: false,
      quality: { status: "available", reasons: ["caution:INVESTMENT_CAUTION"] },
    });
  });

  it("filters halted, low-liquidity and excessive-spread candidates without fabricating missing values", () => {
    const scanner = new ScalpingScanner(config({
      minimumVolume: 50,
      minimumTradingAmount: 5_000,
      maximumSpreadBps: 50,
    }));
    const result = scanner.scan({ criterion: "volume", topCount: 5 }, snapshot({
      rankings: [
        ranking("kis", "HALT", 1),
        ranking("kis", "LOW", 2, { volume: 10, tradingAmount: 100 }),
        ranking("kis", "WIDE", 3),
        ranking("kis", "MISSING", 4, { volume: undefined, tradingAmount: undefined }),
      ],
      orderbooks: [book("HALT", 101, 100), book("LOW", 101, 100), book("WIDE", 110, 100)],
      instrumentStates: [state("HALT", { suspended: true })],
    }));
    expect(result.excluded.find(({ symbol }) => symbol === "HALT")?.filterReasons).toContain("trading_suspended");
    expect(result.excluded.find(({ symbol }) => symbol === "LOW")?.filterReasons).toEqual(expect.arrayContaining([
      "low_volume",
      "low_trading_amount",
    ]));
    expect(result.excluded.find(({ symbol }) => symbol === "WIDE")?.filterReasons).toContain("wide_spread");
    const missing = result.candidates.find(({ symbol }) => symbol === "MISSING")!;
    expect(missing.volume).toBeUndefined();
    expect(missing.quality).toMatchObject({
      status: "partial",
      missing: expect.arrayContaining(["volume", "trading_amount", "spread", "ranking_metric_volume"]),
    });
  });

  it("builds cross-sectional volatility scores from supplied Rust/provider components", () => {
    const scanner = new ScalpingScanner(config({ minimumVolatilityComponents: 4 }));
    const high: VolatilityInputs = {
      realizedVolatility: 10,
      normalizedAtr: 9,
      dayRangeRatio: 8,
      bollingerWidthExpansion: 7,
      relativeVolume: 6,
    };
    const low: VolatilityInputs = {
      realizedVolatility: 1,
      normalizedAtr: 2,
      dayRangeRatio: 1,
      bollingerWidthExpansion: 2,
      relativeVolume: 1,
    };
    const result = scanner.scan({ criterion: "volatility", topCount: 3 }, snapshot({
      rankings: [ranking("kis", "HIGH", 2), ranking("kis", "LOW", 1), ranking("kis", "SHORT", 3)],
      orderbooks: [book("HIGH", 101, 100), book("LOW", 101, 100)],
      volatilityInputs: { HIGH: high, LOW: low, SHORT: { realizedVolatility: 3 } },
    }));
    expect(result.candidates.map(({ symbol }) => symbol)).toEqual(["HIGH", "LOW", "SHORT"]);
    expect(result.candidates[0]!.volatilityScore).toBeGreaterThan(result.candidates[1]!.volatilityScore!);
    expect(result.candidates[2]).not.toHaveProperty("volatilityScore");
    expect(result.candidates[2]).toMatchObject({ quality: { status: "insufficient_history" } });
  });

  it("retains unknown warnings as diagnostics and blocks configured warning codes", () => {
    const warnings: NormalizedWarning[] = [
      { provider: "toss", symbol: "BLOCK", code: "INVESTMENT_RISK", severity: "unknown", observedAt },
      { provider: "toss", symbol: "NEW", code: "UNRECOGNIZED", severity: "unknown", observedAt },
    ];
    const result = new ScalpingScanner(config()).scan({ criterion: "volume", topCount: 2 }, snapshot({
      rankings: [ranking("toss", "BLOCK", 1), ranking("toss", "NEW", 2)],
      warnings,
      orderbooks: [book("BLOCK", 101, 100), book("NEW", 101, 100)],
    }));
    expect(result.excluded[0]?.filterReasons).toContain("warning:INVESTMENT_RISK");
    expect(result.candidates[0]?.warnings[0]?.code).toBe("UNRECOGNIZED");
  });

  it("reports stale and missing-source quality using configured thresholds", () => {
    const scanner = new ScalpingScanner(config({ staleAfterMs: 10 }));
    const result = scanner.scan({ criterion: "volume", topCount: 2 }, snapshot({
      rankings: [ranking("toss", "A", 1)],
      sourceErrors: { kis: "provider unavailable" },
    }));
    expect(result.candidates[0]?.quality.status).toBe("stale");
    expect(result.quality).toMatchObject({
      status: "partial",
      missing: ["kis_source"],
      reasons: expect.arrayContaining(["kis_source_unavailable", "only 1/2 eligible candidates"]),
    });
  });

  it("validates configured top-count bounds", () => {
    const scanner = new ScalpingScanner(config({ minimumTopCount: 5, maximumTopCount: 12 }));
    expect(() => scanner.scan({ criterion: "volume", topCount: 4 }, snapshot())).toThrow();
    expect(() => scanner.scan({ criterion: "volume", topCount: 13 }, snapshot())).toThrow();
  });
});
