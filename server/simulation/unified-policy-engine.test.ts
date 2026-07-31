import { describe, expect, it } from "vitest";
import type { SimulationModelPlanEntry } from "./contracts.js";
import {
  normalizeModelEvidence,
  type ModelEvidence,
} from "./model-evidence.js";
import type { RustMarketEvidenceV2 } from "./technical-indicator-evidence.js";
import {
  decideUnifiedSimulationPolicy,
  type UnifiedPolicyInput,
} from "./unified-policy-engine.js";

const ORIGIN = "2026-07-28T00:00:00.000Z";

const PLAN: SimulationModelPlanEntry[] = [
  {
    symbol: "BTCUSDT",
    modelLane: "chronos2",
    role: "primary",
    required: true,
    preferredHorizonsMinutes: [15, 30, 60],
  },
  {
    symbol: "BTCUSDT",
    modelLane: "fincast",
    role: "veto",
    required: true,
    preferredHorizonsMinutes: [15, 30, 60],
  },
  {
    symbol: "BTCUSDT",
    modelLane: "chronos2",
    role: "shadow",
    required: false,
    preferredHorizonsMinutes: [15, 30, 60],
  },
];

function evidence(input: {
  lane: ModelEvidence["modelLane"];
  role: ModelEvidence["role"];
  horizon?: 15 | 30 | 60;
  quantiles?: Record<number, number>;
}): ModelEvidence {
  return normalizeModelEvidence({
    modelLane: input.lane,
    modelId: input.lane === "chronos2" ? "amazon/chronos-2" : input.lane,
    modelRevision: "test-revision",
    role: input.role,
    symbol: "BTCUSDT",
    originAt: ORIGIN,
    horizonMinutes: input.horizon ?? 30,
    quantiles: input.quantiles ?? {
      0.01: -0.002,
      0.05: 0,
      0.1: 0.002,
      0.5: 0.012,
      0.9: 0.02,
      0.95: 0.025,
      0.99: 0.03,
    },
    calibrationId: `${input.lane}:BTCUSDT:${input.horizon ?? 30}`,
    calibrationStatus: "ready",
    calibrationAge: 2,
    featureProfile: "causal-test-v1",
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
      commissionBps: 1,
      spreadBps: 1,
      slippageBps: 1,
      fundingBps: 0,
      safetyMarginBps: 1,
    },
  });
}

const RUST: RustMarketEvidenceV2 = {
  schemaVersion: "rust-market-evidence/v2",
  trendScore: 0.7,
  momentumScore: 0.5,
  breakoutScore: 0.4,
  choppiness: 35,
  normalizedAtr: 0.01,
  realizedVolatility: 0.01,
  dayRangeRatio: 0.03,
  bollingerWidthExpansion: 1.2,
  relativeVolume: 1.5,
  tradingAmount: 100_000_000,
  spreadBps: 2,
  orderbookDepth: 1_000_000,
  orderbookImbalance: 0.2,
  executionStrength: 0.4,
  liquidityQuality: 0.9,
  exitRisk: 0.1,
  sessionVwap: 100,
  openingRange5: 1,
  openingRange15: 2,
  openingRange30: 3,
  timeOfDayRelativeVolume: 1.2,
  benchmarkRelativeStrength: 0.1,
  quoteFreshnessMs: 0,
  regime: "trend",
  passedGates: ["data", "liquidity"],
  blockedGates: [],
  unavailableFields: ["open_interest"],
  originAt: ORIGIN,
  observedAt: ORIGIN,
};

function policyInput(modelEvidence: ModelEvidence[]): UnifiedPolicyInput {
  return {
    simulationCase: "btc_eth",
    symbol: "BTCUSDT",
    originAt: ORIGIN,
    modelPlan: PLAN,
    modelEvidence,
    rustEvidence: RUST,
    costs: {
      commissionBps: 1,
      spreadBps: 1,
      slippageBps: 1,
      fundingBps: 0,
      safetyMarginBps: 1,
    },
    state: {
      currentDirection: "cash",
      tradeTimestamps: [],
      dailyTurnoverRate: 0,
    },
    sizing: {
      equity: 10_000,
      volatilityTargetRate: 0.01,
      lossBudgetRate: 0.005,
      bookParticipationRate: 0.01,
      symbolExposureCapRate: 0.5,
      grossExposureCapRate: 1,
      marginUsageCapRate: 0.2,
      maximumLeverage: 3,
    },
    circuit: {
      dailyLossRate: 0,
      consecutiveLosses: 0,
      referenceSpreadBps: 2,
      referenceDepth: 1_000_000,
      realizedVolatilityBaseline: 0.01,
      priceGapRate: 0,
      missingData: false,
    },
  };
}

describe("unified simulation policy", () => {
  it("uses a strong veto but does not block a weak opposing forecast", () => {
    const primary = evidence({ lane: "chronos2", role: "primary" });
    const weakVeto = evidence({
      lane: "fincast",
      role: "veto",
      quantiles: { 0.1: -0.003, 0.5: 0.001, 0.9: 0.008 },
    });
    const weak = decideUnifiedSimulationPolicy(policyInput([primary, weakVeto]));
    expect(weak.veto.vetoed).toBe(false);
    expect(weak.direction).toBe("long");
    expect(weak.pNetLong).toBeGreaterThan(0.6);

    const strongVeto = evidence({
      lane: "fincast",
      role: "veto",
      quantiles: { 0.1: -0.04, 0.5: -0.02, 0.9: -0.004 },
    });
    const strong = decideUnifiedSimulationPolicy(policyInput([primary, strongVeto]));
    expect(strong.veto.vetoed).toBe(true);
    expect(strong.direction).toBe("cash");
    expect(strong.veto.reasons).toContain("STRONG_OPPOSITE_NET_PROBABILITY");
  });

  it("keeps shadow output out of the decision and fails closed when required veto is absent", () => {
    const primary = evidence({ lane: "chronos2", role: "primary" });
    const veto = evidence({
      lane: "fincast",
      role: "veto",
      quantiles: { 0.1: -0.002, 0.5: 0.002, 0.9: 0.01 },
    });
    const bullishShadow = evidence({ lane: "chronos2", role: "shadow" });
    const bearishShadow = evidence({
      lane: "chronos2",
      role: "shadow",
      quantiles: { 0.1: -0.03, 0.5: -0.02, 0.9: -0.01 },
    });
    const first = decideUnifiedSimulationPolicy(policyInput([primary, veto, bullishShadow]));
    const second = decideUnifiedSimulationPolicy(policyInput([primary, veto, bearishShadow]));
    expect(first.direction).toBe(second.direction);
    expect(first.selectedHorizonMinutes).toBe(second.selectedHorizonMinutes);
    expect(first.expectedNetReturn).toBe(second.expectedNetReturn);

    const missingVeto = decideUnifiedSimulationPolicy(policyInput([primary]));
    expect(missingVeto.direction).toBe("cash");
    expect(missingVeto.veto.reasons).toContain("REQUIRED_VETO_MODEL_UNAVAILABLE");
  });

  it("does not label an available required veto unavailable when primary has no edge", () => {
    const noEdgePrimary = evidence({
      lane: "chronos2",
      role: "primary",
      quantiles: { 0.1: -0.0001, 0.5: 0, 0.9: 0.0001 },
    });
    const availableVeto = evidence({
      lane: "fincast",
      role: "veto",
      quantiles: { 0.1: -0.0002, 0.5: 0, 0.9: 0.0002 },
    });
    const decision = decideUnifiedSimulationPolicy(
      policyInput([noEdgePrimary, availableVeto]),
    );

    expect(decision.direction).toBe("cash");
    expect(decision.reasons).toContain("NO_COST_ADJUSTED_EDGE");
    expect(decision.veto.evaluated).toBe(false);
    expect(decision.veto.vetoed).toBe(false);
    expect(decision.veto.reasons).not.toContain("REQUIRED_VETO_MODEL_UNAVAILABLE");
  });

  it("selects dynamic horizons with hysteresis and sizes by the smallest risk bound", () => {
    const veto15 = evidence({
      lane: "fincast",
      role: "veto",
      horizon: 15,
      quantiles: { 0.1: -0.002, 0.5: 0.001, 0.9: 0.008 },
    });
    const veto30 = evidence({
      lane: "fincast",
      role: "veto",
      horizon: 30,
      quantiles: { 0.1: -0.002, 0.5: 0.001, 0.9: 0.008 },
    });
    const input = policyInput([
      evidence({
        lane: "chronos2",
        role: "primary",
        horizon: 15,
        quantiles: { 0.1: 0.001, 0.5: 0.01, 0.9: 0.018 },
      }),
      evidence({
        lane: "chronos2",
        role: "primary",
        horizon: 30,
        quantiles: { 0.1: 0.002, 0.5: 0.014, 0.9: 0.022 },
      }),
      veto15,
      veto30,
    ]);
    input.state.lastHorizonMinutes = 15;
    input.state.lastHorizonScore = 1_000;
    input.sizing.volatilityTargetRate = 0.02;
    input.sizing.symbolExposureCapRate = 2;
    input.sizing.grossExposureCapRate = 3;
    input.sizing.marginUsageCapRate = 0.5;
    const result = decideUnifiedSimulationPolicy(input);
    expect(result.selectedHorizonMinutes).toBe(15);
    expect(result.positionSizing.selectedNotional).toBe(
      Math.min(...Object.values(result.positionSizing.limits)),
    );
    expect(result.positionSizing.limitingFactor).toBe("orderbookParticipation");
  });

  it("is deterministic for forward/backtest parity inputs and exposes circuit-breaker releases", () => {
    const input = policyInput([
      evidence({ lane: "chronos2", role: "primary" }),
      evidence({
        lane: "fincast",
        role: "veto",
        quantiles: { 0.1: -0.002, 0.5: 0.001, 0.9: 0.008 },
      }),
    ]);
    expect(decideUnifiedSimulationPolicy(structuredClone(input)))
      .toEqual(decideUnifiedSimulationPolicy(structuredClone(input)));
    input.circuit.dailyLossRate = 0.04;
    const stopped = decideUnifiedSimulationPolicy(input);
    expect(stopped.circuitBreaker.active).toBe(true);
    expect(stopped.direction).toBe("cash");
    expect(stopped.circuitBreaker.releaseConditions).toContain("CLEAR_DAILY_LOSS_LIMIT");
  });
});
