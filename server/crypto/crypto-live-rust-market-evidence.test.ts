import { describe, expect, it } from "vitest";
import type { RustMarketEvidenceV2 } from "../simulation/technical-indicator-evidence.js";
import {
  CRYPTO_LIVE_RUST_MARKET_EVIDENCE_SCHEMA_VERSION,
  composeCryptoLiveRustMarketEvidence,
} from "./crypto-rust-technical.js";

const TECHNICAL_ORIGIN = "2026-07-29T12:00:00.000Z";

function baseEvidence(
  overrides: Partial<RustMarketEvidenceV2> = {},
): RustMarketEvidenceV2 {
  return {
    schemaVersion: "rust-market-evidence/v2",
    trendScore: 0.7,
    momentumScore: 0.4,
    breakoutScore: 0.6,
    choppiness: 35,
    normalizedAtr: 1.2,
    realizedVolatility: 0.03,
    dayRangeRatio: 0.04,
    bollingerWidthExpansion: 1.1,
    relativeVolume: 1.25,
    tradingAmount: 5_000_000,
    spreadBps: null,
    orderbookDepth: null,
    orderbookImbalance: null,
    executionStrength: null,
    liquidityQuality: null,
    exitRisk: 0.16,
    sessionVwap: null,
    openingRange5: null,
    openingRange15: null,
    openingRange30: null,
    timeOfDayRelativeVolume: null,
    benchmarkRelativeStrength: null,
    quoteFreshnessMs: null,
    regime: "trend",
    passedGates: ["FINALIZED_BAR", "DATA_QUALITY"],
    blockedGates: [
      "SPREAD_UNAVAILABLE",
      "LIQUIDITY_UNAVAILABLE",
      "QUOTE_FRESHNESS_UNAVAILABLE",
    ],
    unavailableFields: [
      "spreadBps",
      "orderbookDepth",
      "orderbookImbalance",
      "executionStrength",
      "liquidityQuality",
      "quoteFreshnessMs",
    ],
    originAt: TECHNICAL_ORIGIN,
    observedAt: TECHNICAL_ORIGIN,
    ...overrides,
  };
}

describe("composeCryptoLiveRustMarketEvidence", () => {
  it("combines finalized Rust indicators with causal live book and trade snapshots", () => {
    const base = baseEvidence();
    const before = structuredClone(base);
    const result = composeCryptoLiveRustMarketEvidence({
      baseEvidence: base,
      decisionOriginAt: "2026-07-29T12:00:05.000Z",
      bookTicker: {
        observedAt: "2026-07-29T12:00:04.000Z",
        bidPrice: 100,
        bidQuantity: 1_000,
        askPrice: 100.1,
        askQuantity: 1_500,
      },
      tradeStats: {
        observedAt: "2026-07-29T12:00:03.000Z",
        buyVolume: 6,
        sellVolume: 4,
      },
    });

    expect(result.schemaVersion).toBe(
      CRYPTO_LIVE_RUST_MARKET_EVIDENCE_SCHEMA_VERSION,
    );
    expect(result.technicalOriginAt).toBe(TECHNICAL_ORIGIN);
    expect(result.decisionOriginAt).toBe("2026-07-29T12:00:05.000Z");
    expect(result.microstructureObservedAt).toBe("2026-07-29T12:00:04.000Z");
    expect(result.marketEvidence).toMatchObject({
      originAt: "2026-07-29T12:00:05.000Z",
      observedAt: "2026-07-29T12:00:04.000Z",
      orderbookDepth: 250_125,
      orderbookImbalance: -0.2,
      executionStrength: 0.2,
      quoteFreshnessMs: 1_000,
    });
    expect(result.marketEvidence.spreadBps).toBeCloseTo(9.9950025, 8);
    expect(result.marketEvidence.liquidityQuality).toBeCloseTo(0.93336665, 8);
    expect(result.marketEvidence.exitRisk).toBeCloseTo(0.22330002, 8);
    expect(result.marketEvidence.passedGates).toEqual(expect.arrayContaining([
      "FINALIZED_BAR",
      "DATA_QUALITY",
      "SPREAD",
      "LIQUIDITY",
      "QUOTE_FRESHNESS",
    ]));
    expect(result.marketEvidence.blockedGates).toEqual([]);
    expect(result.marketEvidence.unavailableFields).not.toEqual(expect.arrayContaining([
      "spreadBps",
      "orderbookDepth",
      "orderbookImbalance",
      "executionStrength",
      "liquidityQuality",
      "quoteFreshnessMs",
    ]));
    expect(base).toEqual(before);
  });

  it("rejects future microstructure instead of allowing lookahead", () => {
    expect(() => composeCryptoLiveRustMarketEvidence({
      baseEvidence: baseEvidence(),
      decisionOriginAt: "2026-07-29T12:00:05.000Z",
      bookTicker: {
        observedAt: "2026-07-29T12:00:05.001Z",
        bidPrice: 100,
        bidQuantity: 1,
        askPrice: 101,
        askQuantity: 1,
      },
    })).toThrow("book ticker exceeds the decision origin");
  });

  it("ages a cached causal quote against the new decision origin", () => {
    const result = composeCryptoLiveRustMarketEvidence({
      baseEvidence: baseEvidence({
        spreadBps: 5,
        orderbookDepth: 300_000,
        orderbookImbalance: 0.1,
        liquidityQuality: 0.9,
        quoteFreshnessMs: 1_000,
        passedGates: [
          "FINALIZED_BAR",
          "DATA_QUALITY",
          "SPREAD",
          "LIQUIDITY",
          "QUOTE_FRESHNESS",
        ],
        blockedGates: [],
        unavailableFields: ["executionStrength"],
      }),
      decisionOriginAt: "2026-07-29T12:01:05.000Z",
    });

    expect(result.marketEvidence.quoteFreshnessMs).toBe(66_000);
    expect(result.marketEvidence.blockedGates).toContain("QUOTE_STALE");
    expect(result.marketEvidence.passedGates).not.toContain("QUOTE_FRESHNESS");
  });
});
