import { describe, expect, it } from "vitest";
import type {
  NormalizedPairModelOutput,
  NormalizedPairModelSet,
} from "./model-output-normalization.js";
import {
  DEFAULT_PAIR_ENSEMBLE_POLICY_PROFILE,
  evaluatePairEnsemble,
  type PairEnsembleInput,
  type PairEnsemblePolicyProfile,
} from "./ensemble-policy.js";
import { getPairCatalogEntry } from "./pair-catalog.js";

const ORIGIN = "2026-07-24T14:30:00.000Z";
const DECISION_AT = "2026-07-24T14:30:05.000Z";

function model(
  component: "chronos2" | "kronos",
  medianReturn = 0.012,
  upProbability = 0.72,
): NormalizedPairModelOutput {
  return {
    normalizationVersion: "pair-model-normalization/v1",
    component,
    status: "available",
    reasonCodes: [],
    signalSymbol: "TSLA",
    horizonMinutes: 5,
    inputEndAt: ORIGIN,
    generatedAt: component === "chronos2"
      ? "2026-07-24T14:30:01.000Z"
      : "2026-07-24T14:30:02.000Z",
    targetTimestamp: "2026-07-24T14:35:00.000Z",
    medianReturn,
    q10Return: medianReturn - 0.01,
    q90Return: medianReturn + 0.01,
    upProbability,
    downProbability: 1 - upProbability,
    uncertaintyWidth: 0.02,
    expectedVolatility: 0.01,
    calibration: { status: "good" },
    inputQuality: { status: "good", warnings: [] },
    provenance: {
      modelId: component === "chronos2"
        ? "amazon/chronos-2"
        : "NeoQuasar/Kronos-small",
      modelRevision: "revision-a",
      device: "cuda",
      loaded: true,
    },
    rawOutput: { component },
  };
}

function models(
  chronos = model("chronos2"),
  kronos = model("kronos"),
): NormalizedPairModelSet {
  return {
    normalizationVersion: "pair-model-normalization/v1",
    signalSymbol: "TSLA",
    expectedOrigin: ORIGIN,
    alignedOrigin: ORIGIN,
    alignmentStatus: "aligned",
    reasonCodes: [],
    chronos2: chronos,
    kronos,
    rawResponse: {},
  };
}

function input(overrides: Partial<PairEnsembleInput> = {}): PairEnsembleInput {
  return {
    pair: getPairCatalogEntry("tsla-tsll-tslq"),
    models: models(),
    rust: {
      status: "entry_candidate",
      signalOriginAt: ORIGIN,
      observedAt: "2026-07-24T14:30:03.000Z",
      earliestEligibleAt: "2026-07-24T14:30:01.000Z",
      technicalSignal: 1,
      multiTimeframeAgreement: "aligned_bullish",
      confidence: 1,
      chartPatternBias: "bullish",
      dataQuality: "good",
    },
    currentDirection: "cash",
    decisionAt: DECISION_AT,
    riskTolerance: 70,
    costs: {
      commissionBpsPerSide: 1.5,
      taxBpsOnExit: 0,
      spreadBpsRoundTrip: 5,
      slippageBpsPerSide: 2,
      switchCostBps: 10,
    },
    market: {
      session: "regular",
      dataQuality: "good",
      quotes: {
        bull: { status: "available", observedAt: "2026-07-24T14:30:04.000Z", spreadBps: 8 },
        bear: { status: "available", observedAt: "2026-07-24T14:30:04.000Z", spreadBps: 9 },
      },
    },
    ...overrides,
  };
}

describe("pair ensemble policy", () => {
  it("enters with the highest confidence when both models and Rust agree", () => {
    const decision = evaluatePairEnsemble(input());
    expect(decision).toMatchObject({
      direction: "bull",
      executionSymbol: "TSLL",
      leverageMultiplier: 2,
      decisionKind: "enter",
      degraded: false,
      origin: ORIGIN,
      eligibleAfter: DECISION_AT,
      weights: { chronos2: 0.35, kronos: 0.35, rust: 0.3 },
    });
    expect(decision.reasonCodes).toContain("full_ensemble_available");
    expect(decision.finalScores.bull).toBeGreaterThan(decision.finalScores.bear);
  });

  it("chooses cash without weighted arbitration when AI directions conflict", () => {
    const conflicting = models(
      model("chronos2", 0.015, 0.75),
      model("kronos", -0.015, 0.25),
    );
    const decision = evaluatePairEnsemble(input({ models: conflicting }));
    expect(decision.direction).toBe("cash");
    expect(decision.reasonCodes).toContain("ai_model_direction_conflict");
  });

  it("prioritizes liquidation when Rust returns exit_candidate for a held pair", () => {
    const base = input({ currentDirection: "bull" });
    const decision = evaluatePairEnsemble({
      ...base,
      rust: {
        ...base.rust,
        status: "exit_candidate",
        technicalSignal: -1,
        multiTimeframeAgreement: "aligned_bearish",
        chartPatternBias: "bearish",
      },
    });
    expect(decision).toMatchObject({
      direction: "cash",
      decisionKind: "exit",
    });
    expect(decision.reasonCodes).toContain("rust_exit_candidate");
  });

  it("does not redistribute a missing model weight and defaults degraded mode to cash", () => {
    const missing = {
      ...model("kronos"),
      status: "unavailable" as const,
      reasonCodes: ["model_run_missing"],
    };
    const decision = evaluatePairEnsemble(input({ models: models(model("chronos2"), missing) }));
    expect(decision.direction).toBe("cash");
    expect(decision.reasonCodes).toContain("degraded_mode_disabled");
    expect(decision.weights).toEqual({ chronos2: 0.35, kronos: 0.35, rust: 0.3 });
  });

  it("requires a higher threshold plus Rust agreement when degraded mode is explicitly enabled", () => {
    const profile: PairEnsemblePolicyProfile = {
      ...DEFAULT_PAIR_ENSEMBLE_POLICY_PROFILE,
      weights: { ...DEFAULT_PAIR_ENSEMBLE_POLICY_PROFILE.weights },
      modelScoreWeights: { ...DEFAULT_PAIR_ENSEMBLE_POLICY_PROFILE.modelScoreWeights },
      allowDegradedMode: true,
      degradedEntryScoreThreshold: 0.45,
    };
    const missing = {
      ...model("kronos"),
      status: "unavailable" as const,
      reasonCodes: ["model_run_missing"],
    };
    const fullModels = models(model("chronos2", 0.025, 0.8), missing);
    const {
      alignedOrigin: _alignedOrigin,
      ...withoutAlignedOrigin
    } = fullModels;
    const degradedModels = {
      ...withoutAlignedOrigin,
      alignmentStatus: "unavailable" as const,
    };
    const decision = evaluatePairEnsemble(input({
      models: degradedModels,
      profile,
    }));
    expect(decision.direction).toBe("bull");
    expect(decision.degraded).toBe(true);
    expect(decision.weights.kronos).toBe(0.35);
    expect(decision.reasonCodes).toContain(
      "degraded_threshold_applied_without_weight_redistribution",
    );
  });

  it("fails closed for origin mismatch, stale data, missing quote, wide spread, and cooldown", () => {
    const cases: PairEnsembleInput[] = [
      {
        ...input(),
        rust: { ...input().rust, signalOriginAt: "2026-07-24T14:29:00.000Z" },
      },
      {
        ...input(),
        market: { ...input().market, dataQuality: "stale" },
      },
      {
        ...input(),
        market: { ...input().market, quotes: {} },
      },
      {
        ...input(),
        market: {
          ...input().market,
          quotes: {
            ...input().market.quotes,
            bull: {
              status: "available",
              observedAt: "2026-07-24T14:30:04.000Z",
              spreadBps: 100,
            },
          },
        },
      },
      {
        ...input(),
        currentDirection: "bear",
        cooldownUntil: "2026-07-24T14:35:00.000Z",
      },
    ];
    for (const value of cases) expect(evaluatePairEnsemble(value).direction).toBe("cash");
  });

  it("requires fresh and bounded quotes for both execution legs before scoring", () => {
    const base = input();
    for (const bear of [
      undefined,
      {
        status: "available" as const,
        observedAt: "2026-07-24T14:29:00.000Z",
        spreadBps: 9,
      },
      {
        status: "available" as const,
        observedAt: "2026-07-24T14:30:04.000Z",
        spreadBps: 100,
      },
    ]) {
      const decision = evaluatePairEnsemble({
        ...base,
        market: {
          ...base.market,
          dataQuality: bear ? "good" : "partial",
          quotes: {
            bull: base.market.quotes.bull,
            ...(bear ? { bear } : {}),
          },
        },
      });
      expect(decision.direction).toBe("cash");
    }
  });
});
