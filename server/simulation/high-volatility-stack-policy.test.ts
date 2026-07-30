import { describe, expect, it } from "vitest";
import {
  normalizeModelEvidence,
  type ModelEvidence,
} from "./model-evidence.js";
import type { RustMarketEvidenceV2 } from "./technical-indicator-evidence.js";
import {
  assessHighVolatilityHorizons,
  classifyCausalVolatilityRegime,
  fitVetoProbabilityCalibration,
  scoreHighVolatilityRustQuality,
  selectHighVolatilityCandidates,
  type VetoProbabilityCalibrationSample,
} from "./high-volatility-stack-policy.js";

const ORIGIN = "2026-07-29T00:00:00.000Z";

function rust(
  overrides: Partial<RustMarketEvidenceV2> = {},
): RustMarketEvidenceV2 {
  return {
    schemaVersion: "rust-market-evidence/v2",
    trendScore: 0.7,
    momentumScore: 0.4,
    breakoutScore: 0.5,
    choppiness: 35,
    normalizedAtr: 0.02,
    realizedVolatility: 0.03,
    dayRangeRatio: 0.08,
    bollingerWidthExpansion: 1.1,
    relativeVolume: 1.4,
    tradingAmount: 100_000_000,
    spreadBps: 2,
    orderbookDepth: 2_000_000,
    orderbookImbalance: 0.1,
    executionStrength: 0.3,
    liquidityQuality: 0.9,
    exitRisk: 0.1,
    sessionVwap: null,
    openingRange5: null,
    openingRange15: null,
    openingRange30: null,
    timeOfDayRelativeVolume: 1.2,
    benchmarkRelativeStrength: 0.01,
    quoteFreshnessMs: 1,
    regime: "trend",
    passedGates: ["data", "liquidity"],
    blockedGates: [],
    unavailableFields: [],
    originAt: ORIGIN,
    observedAt: ORIGIN,
    ...overrides,
  };
}

function primary(
  symbol: string,
  horizonMinutes: 15 | 30 | 60,
  median: number,
): ModelEvidence {
  return normalizeModelEvidence({
    modelLane: "chronos2",
    modelId: "amazon/chronos-2",
    modelRevision: "pinned",
    role: "primary",
    symbol,
    originAt: ORIGIN,
    horizonMinutes,
    quantiles: {
      0.01: median - 0.012,
      0.05: median - 0.009,
      0.1: median - 0.006,
      0.5: median,
      0.9: median + 0.006,
      0.95: median + 0.009,
      0.99: median + 0.012,
    },
    calibrationId: `test:${symbol}:${horizonMinutes}`,
    calibrationStatus: "ready",
    calibrationAge: 5,
    featureProfile: "compact_causal_v1",
    dataQuality: {
      status: "ok",
      finalizedOnly: true,
      stale: false,
      missingRate: 0,
      unavailableFeatures: [],
      warnings: [],
    },
    generatedAt: ORIGIN,
    latencyMs: 1,
    inputOrigin: "deterministic_test",
    costs: {
      commissionBps: 8,
      spreadBps: 2,
      slippageBps: 2,
      fundingBps: 0,
      safetyMarginBps: 1,
    },
  });
}

describe("high-volatility stack policy", () => {
  it("uses Rust as a soft non-directional quality score", () => {
    const bullish = scoreHighVolatilityRustQuality(rust({ trendScore: 0.9 }));
    const bearish = scoreHighVolatilityRustQuality(rust({ trendScore: -0.9 }));
    const weakLiquidity = scoreHighVolatilityRustQuality(rust({
      liquidityQuality: 0.1,
      exitRisk: 0.8,
      choppiness: 70,
      bollingerWidthExpansion: -0.5,
    }));

    expect(bullish.score).toBe(bearish.score);
    expect(bullish.score).toBeGreaterThan(weakLiquidity.score);
  });

  it("keeps 15/30m available and qualifies 60m only through the strict gate", () => {
    const qualified = assessHighVolatilityHorizons({
      rustEvidence: rust(),
      adx: 30,
      fundingRate: 0.0001,
      basisRate: 0.001,
    });
    expect(qualified[5]?.entryAllowed).toBe(false);
    expect(qualified[15]?.entryAllowed).toBe(true);
    expect(qualified[30]?.entryAllowed).toBe(true);
    expect(qualified[60]?.entryAllowed).toBe(true);

    const unqualified = assessHighVolatilityHorizons({
      rustEvidence: rust({
        choppiness: 62,
        bollingerWidthExpansion: -0.1,
      }),
      adx: 18,
      fundingRate: 0.001,
      basisRate: 0.02,
    });
    expect(unqualified[60]?.entryAllowed).toBe(false);
    expect(unqualified[60]?.blockedGates).toEqual(expect.arrayContaining([
      "ADX_25",
      "FUNDING_NORMAL",
      "BASIS_NORMAL",
      "CHOPPINESS_55",
      "BB_WIDTH_EXPANDING",
    ]));
  });

  it("ranks scanner finalists by cost-adjusted Chronos edge and Rust quality", () => {
    const selected = selectHighVolatilityCandidates([
      {
        symbol: "RAW1USDT",
        scannerRank: 1,
        scannerScore: 0.95,
        primaryEvidence: [primary("RAW1USDT", 30, 0.003)],
        rustEvidence: rust({
          liquidityQuality: 0.2,
          exitRisk: 0.8,
          choppiness: 70,
        }),
        adx: 30,
        fundingRate: 0,
        basisRate: 0,
      },
      {
        symbol: "EDGEUSDT",
        scannerRank: 2,
        scannerScore: 0.8,
        primaryEvidence: [primary("EDGEUSDT", 30, 0.008)],
        rustEvidence: rust(),
        adx: 30,
        fundingRate: 0,
        basisRate: 0,
      },
    ], 1);

    expect(selected.selectedSymbols).toEqual(["EDGEUSDT"]);
    expect(selected.candidates[0]?.selectedHorizonMinutes).toBe(30);
  });

  it("classifies regimes from past values only", () => {
    const history = Array.from({ length: 30 }, (_, index) => index + 1);
    expect(classifyCausalVolatilityRegime(history, 2)).toBe("low");
    expect(classifyCausalVolatilityRegime(history, 15)).toBe("normal");
    expect(classifyCausalVolatilityRegime(history, 29)).toBe("high");
    expect(classifyCausalVolatilityRegime(history.slice(0, 23), 100)).toBe("normal");
  });

  it("calibrates FinCast veto by symbol, horizon, regime without future samples", () => {
    const samples: VetoProbabilityCalibrationSample[] = Array.from(
      { length: 16 },
      (_, index) => ({
        modelLane: "fincast",
        symbol: "ZECUSDT",
        horizonMinutes: 30,
        volatilityRegime: "high",
        direction: "short",
        originAt: new Date(Date.parse(ORIGIN) - (index + 2) * 60 * 60_000).toISOString(),
        resolvedAt: new Date(Date.parse(ORIGIN) - (index + 1) * 60 * 60_000).toISOString(),
        rawProbability: 0.75,
        outcome: 1 as const,
      }),
    );
    samples.push({
      ...samples[0]!,
      originAt: new Date(Date.parse(ORIGIN) + 60_000).toISOString(),
      resolvedAt: new Date(Date.parse(ORIGIN) + 3_600_000).toISOString(),
      outcome: 0,
    });
    const result = fitVetoProbabilityCalibration(samples, {
      modelLane: "fincast",
      symbol: "ZECUSDT",
      horizonMinutes: 30,
      volatilityRegime: "high",
      direction: "short",
      originAt: ORIGIN,
      rawProbability: 0.75,
    });

    expect(result.status).toBe("ready");
    expect(result.scope).toBe("symbol_horizon_regime");
    expect(result.sampleCount).toBe(16);
    expect(result.usedSampleOrigins.every(
      (value) => Date.parse(value) < Date.parse(ORIGIN),
    )).toBe(true);
    expect(result.calibratedProbability).toBeGreaterThan(0.75);
  });
});
