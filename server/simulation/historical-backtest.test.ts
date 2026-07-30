import { describe, expect, it } from "vitest";
import type { SimulationModelPlanEntry } from "./contracts.js";
import {
  normalizeHistoricalBacktestArtifact,
  runHistoricalSimulationBacktest,
  type HistoricalDecisionOrigin,
} from "./historical-backtest.js";
import { normalizeModelEvidence, type ModelEvidence } from "./model-evidence.js";
import type { RustMarketEvidenceV2 } from "./technical-indicator-evidence.js";
import { decideUnifiedSimulationPolicy } from "./unified-policy-engine.js";

const costs = {
  commissionBps: 4,
  spreadBps: 3,
  slippageBps: 2,
  fundingBps: 0,
  safetyMarginBps: 2,
};

const modelPlan: SimulationModelPlanEntry[] = [{
  symbol: "ETHUSDT",
  modelLane: "fincast",
  role: "primary",
  required: true,
  preferredHorizonsMinutes: [15, 30],
}];

function evidence(originAt: string): ModelEvidence {
  return normalizeModelEvidence({
    modelLane: "fincast",
    modelId: "Vincent05R/FinCast",
    modelRevision: "pinned",
    role: "primary",
    symbol: "ETHUSDT",
    originAt,
    horizonMinutes: 15,
    quantiles: {
      0.01: -0.014,
      0.05: -0.009,
      0.1: -0.005,
      0.5: 0.01,
      0.9: 0.025,
      0.95: 0.032,
      0.99: 0.05,
    },
    calibrationId: "fincast:ETHUSDT:15m:normal",
    calibrationStatus: "ready",
    calibrationAge: 12,
    featureProfile: "compact_causal_v1",
    dataQuality: {
      status: "ok",
      finalizedOnly: true,
      stale: false,
      missingRate: 0,
      unavailableFeatures: [],
      warnings: [],
    },
    generatedAt: originAt,
    latencyMs: 5,
    inputOrigin: "deterministic_test",
    costs,
  });
}

function rust(originAt: string): RustMarketEvidenceV2 {
  return {
    schemaVersion: "rust-market-evidence/v2",
    trendScore: 0.7,
    momentumScore: 0.6,
    breakoutScore: 0.5,
    choppiness: 25,
    normalizedAtr: 0.01,
    realizedVolatility: 0.01,
    dayRangeRatio: 0.02,
    bollingerWidthExpansion: 0.4,
    relativeVolume: 1.5,
    tradingAmount: 50_000_000,
    spreadBps: 2,
    orderbookDepth: 1_000_000,
    orderbookImbalance: 0.2,
    executionStrength: 0.6,
    liquidityQuality: 0.9,
    exitRisk: 0.1,
    sessionVwap: 2_000,
    openingRange5: 0.004,
    openingRange15: 0.008,
    openingRange30: 0.012,
    timeOfDayRelativeVolume: 1.2,
    benchmarkRelativeStrength: 0.1,
    quoteFreshnessMs: 0,
    regime: "trending",
    passedGates: ["ADX", "LIQUIDITY"],
    blockedGates: [],
    unavailableFields: [],
    originAt,
    observedAt: originAt,
  };
}

function origins(): HistoricalDecisionOrigin[] {
  return Array.from({ length: 4 }, (_, index) => {
    const originAt = new Date(Date.UTC(2026, 6, 28, 0, index * 15)).toISOString();
    const fillAt = new Date(Date.UTC(2026, 6, 28, 0, index * 15 + 5)).toISOString();
    return {
      originAt,
      fillAt,
      signalSymbol: "ETHUSDT",
      executionSymbols: {
        long: "ETHUSDT",
        short: "ETHUSDT",
      },
      pricesAtFill: { ETHUSDT: 2_000 + index * 10 },
      modelPlan,
      modelEvidence: [evidence(originAt)],
      rustEvidence: rust(originAt),
      costs,
      baselineDirection: "long",
      actualTargetReturns: { 15: 0.005 },
    };
  });
}

describe("historical unified simulation backtest", () => {
  it("uses the exact forward policy function and only fills after the origin", () => {
    const input = {
      simulationCase: "btc_eth" as const,
      symbol: "ETHUSDT",
      seed: 42,
      initialEquity: 10_000,
      origins: origins(),
      costStressMultiplier: 1,
    };
    const result = runHistoricalSimulationBacktest(input);
    const replayDecision = result.decisions.find(
      (decision) => decision.lane === "final_policy",
    )?.unifiedDecision;
    const direct = decideUnifiedSimulationPolicy({
      simulationCase: "btc_eth",
      symbol: "ETHUSDT",
      originAt: input.origins[0]!.originAt,
      modelPlan,
      modelEvidence: input.origins[0]!.modelEvidence,
      rustEvidence: input.origins[0]!.rustEvidence,
      costs,
      state: {
        currentDirection: "cash",
        tradeTimestamps: [],
        dailyTurnoverRate: 0,
      },
      sizing: {
        equity: 10_000,
        volatilityTargetRate: 0.01,
        lossBudgetRate: 0.01,
        bookParticipationRate: 0.01,
        symbolExposureCapRate: 0.5,
        grossExposureCapRate: 0.75,
        marginUsageCapRate: 0.5,
        maximumLeverage: 1.5,
      },
      circuit: {
        dailyLossRate: 0,
        consecutiveLosses: 0,
        missingData: false,
      },
    });
    expect(replayDecision).toEqual(direct);
    expect(result.integrity).toMatchObject({
      originFillSeparated: true,
      sameBarRetroactiveFill: false,
      pointInTimeTraining: true,
    });
    expect(result.fills.every(
      (fill) => Date.parse(fill.filledAt) > Date.parse(fill.originAt),
    )).toBe(true);
  });

  it("is deterministic, serializable, and applies spread/slippage stress", () => {
    const base = runHistoricalSimulationBacktest({
      simulationCase: "btc_eth",
      symbol: "ETHUSDT",
      seed: 7,
      initialEquity: 10_000,
      origins: origins(),
      costStressMultiplier: 1,
    });
    const repeated = runHistoricalSimulationBacktest({
      simulationCase: "btc_eth",
      symbol: "ETHUSDT",
      seed: 7,
      initialEquity: 10_000,
      origins: origins(),
      costStressMultiplier: 1,
    });
    const stressed = runHistoricalSimulationBacktest({
      simulationCase: "btc_eth",
      symbol: "ETHUSDT",
      seed: 7,
      initialEquity: 10_000,
      origins: origins(),
      costStressMultiplier: 2,
    });
    expect({
      ...repeated,
      offlineThroughputOriginsPerSecond: 0,
    }).toEqual({
      ...base,
      offlineThroughputOriginsPerSecond: 0,
    });
    expect(stressed.lanes.final_policy.totalCosts)
      .toBeGreaterThan(base.lanes.final_policy.totalCosts);
    const parsed = normalizeHistoricalBacktestArtifact(
      JSON.parse(JSON.stringify(base)),
    );
    expect(parsed?.schemaVersion).toBe("historical-simulation-backtest/v1");
    expect(normalizeHistoricalBacktestArtifact({ schemaVersion: "legacy" })).toBeUndefined();
  });

  it("measures model availability by origin rather than by horizon rows", () => {
    const multiHorizonOrigins = origins().map((origin, index) => ({
      ...origin,
      modelEvidence: index === 0
        ? []
        : [
            evidence(origin.originAt),
            {
              ...evidence(origin.originAt),
              horizonMinutes: 30,
              calibrationId: "fincast:ETHUSDT:30m:normal",
            } satisfies ModelEvidence,
          ],
      actualTargetReturns: { 15: 0.005, 30: 0.008 },
    }));
    const result = runHistoricalSimulationBacktest({
      simulationCase: "btc_eth",
      symbol: "ETHUSDT",
      seed: 7,
      initialEquity: 10_000,
      origins: multiHorizonOrigins,
      costStressMultiplier: 1,
    });
    expect(result.modelMetrics).toMatchObject([{
      modelLane: "fincast",
      role: "primary",
      observationCount: 6,
      unavailableRatio: 0.25,
    }]);
  });

  it("rejects same-bar fills and future evidence", () => {
    const origin = origins()[0]!;
    expect(() => runHistoricalSimulationBacktest({
      simulationCase: "btc_eth",
      symbol: "ETHUSDT",
      seed: 1,
      initialEquity: 10_000,
      origins: [{ ...origin, fillAt: origin.originAt }],
      costStressMultiplier: 1,
    })).toThrow("fillAt must be strictly after originAt");

    const futureAt = "2026-07-29T00:00:00.000Z";
    expect(() => runHistoricalSimulationBacktest({
      simulationCase: "btc_eth",
      symbol: "ETHUSDT",
      seed: 1,
      initialEquity: 10_000,
      origins: [{
        ...origin,
        modelEvidence: [{ ...origin.modelEvidence[0]!, originAt: futureAt }],
      }],
      costStressMultiplier: 1,
    })).toThrow("future model evidence");
  });

  it("does not report empty scanner selections as perfect stability", () => {
    const empty = runHistoricalSimulationBacktest({
      simulationCase: "high_vol_crypto",
      symbol: "ETHUSDT",
      seed: 1,
      initialEquity: 10_000,
      origins: origins().map((origin) => ({
        ...origin,
        scannerSelectedSymbols: [],
      })),
      costStressMultiplier: 1,
    });
    expect(empty.scannerSelectionStability).toBeNull();

    const selected = runHistoricalSimulationBacktest({
      simulationCase: "high_vol_crypto",
      symbol: "ETHUSDT",
      seed: 1,
      initialEquity: 10_000,
      origins: origins().map((origin, index) => ({
        ...origin,
        scannerSelectedSymbols: index < 2 ? ["ETHUSDT"] : ["SOLUSDT"],
      })),
      costStressMultiplier: 1,
    });
    expect(selected.scannerSelectionStability).toBeCloseTo(2 / 3);
  });
});
