import { describe, expect, it } from "vitest";
import {
  DEFAULT_PAIR_ENSEMBLE_POLICY_PROFILE,
  evaluatePairEnsemble,
  validatePairEnsemblePolicyProfile,
  type PairEnsembleInput,
  type PairRustTechnicalInput,
} from "./ensemble-policy.js";
import {
  PAIR_MODEL_NORMALIZATION_VERSION,
  type NormalizedPairModelOutput,
  type NormalizedPairModelSet,
} from "./model-output-normalization.js";
import { getPairCatalogEntry } from "./pair-catalog.js";

const ORIGIN = "2026-07-24T14:30:00.000Z";
const GENERATED = "2026-07-24T14:30:03.000Z";
const DECISION = "2026-07-24T14:30:05.000Z";

function model(
  medianReturn = 0.015,
  upProbability = 0.75,
  status: NormalizedPairModelOutput["status"] = "available",
): NormalizedPairModelOutput {
  return {
    normalizationVersion: PAIR_MODEL_NORMALIZATION_VERSION,
    component: "kronos",
    status,
    reasonCodes: status === "available" ? [] : [`model_${status}`],
    signalSymbol: "TSLA",
    horizonMinutes: 5,
    inputEndAt: ORIGIN,
    generatedAt: GENERATED,
    targetTimestamp: "2026-07-24T14:35:00.000Z",
    medianReturn,
    q10Return: medianReturn - 0.01,
    q90Return: medianReturn + 0.01,
    uncertaintyWidth: 0.02,
    upProbability,
    downProbability: 1 - upProbability,
    flatProbability: 0,
    expectedVolatility: 0.01,
    calibration: { status: "good", brierScore: 0.1 },
    inputQuality: {
      status: status === "degraded" ? "partial" : "good",
      warnings: [],
    },
    provenance: {
      modelId: "NeoQuasar/Kronos-base",
      modelRevision: "2b554741eca47781b64468546e77fef3e85130e6",
      device: "cuda",
      deviceName: "Tesla P40",
      latencyMs: 180,
      loaded: status !== "unavailable",
    },
    rawOutput: { role: "kronos_base" },
  };
}

function models(kronos = model()): NormalizedPairModelSet {
  return {
    normalizationVersion: PAIR_MODEL_NORMALIZATION_VERSION,
    signalSymbol: "TSLA",
    expectedOrigin: ORIGIN,
    alignedOrigin: ORIGIN,
    alignmentStatus: "aligned",
    reasonCodes: [],
    kronos,
    rawResponse: {},
  };
}

function rust(
  overrides: Partial<PairRustTechnicalInput> = {},
): PairRustTechnicalInput {
  return {
    status: "entry_candidate",
    signalOriginAt: ORIGIN,
    observedAt: "2026-07-24T14:30:04.000Z",
    earliestEligibleAt: "2026-07-24T14:30:04.000Z",
    technicalSignal: 1,
    multiTimeframeAgreement: "aligned_bullish",
    confidence: 0.9,
    chartPatternBias: "bullish",
    dataQuality: "good",
    rawOutput: { status: "entry_candidate" },
    ...overrides,
  };
}

function input(overrides: Partial<PairEnsembleInput> = {}): PairEnsembleInput {
  return {
    pair: getPairCatalogEntry("tsla-tsll-tslq"),
    models: models(),
    rust: rust(),
    currentDirection: "cash",
    decisionAt: DECISION,
    riskTolerance: 100,
    costs: {
      commissionBpsPerSide: 0.5,
      taxBpsOnExit: 0,
      spreadBpsRoundTrip: 5,
      slippageBpsPerSide: 2,
      switchCostBps: 5,
    },
    market: {
      session: "regular",
      dataQuality: "good",
      quotes: {
        bull: { status: "available", observedAt: DECISION, spreadBps: 4 },
        bear: { status: "available", observedAt: DECISION, spreadBps: 4 },
      },
    },
    ...overrides,
  };
}

describe("Kronos-base and Rust pair ensemble policy", () => {
  it("uses an explicit aggressive versioned profile without hidden weight redistribution", () => {
    expect(validatePairEnsemblePolicyProfile(
      structuredClone(DEFAULT_PAIR_ENSEMBLE_POLICY_PROFILE),
    )).toMatchObject({
      policyVersion: "pair-ensemble-policy/v3",
      profileId: "aggressive-kronos-rust-v3",
      weights: { kronos: 0.72, rust: 0.28 },
      entryScoreThreshold: 0.045,
      holdScoreThreshold: 0.01,
      minimumScoreMargin: 0.015,
      cooldownMs: 60_000,
    });
    expect(() => validatePairEnsemblePolicyProfile({
      ...structuredClone(DEFAULT_PAIR_ENSEMBLE_POLICY_PROFILE),
      holdScoreThreshold: 0.1,
    })).toThrow(/profile values/);
  });

  it("enters the leveraged bull leg when Kronos-base and Rust agree", () => {
    const decision = evaluatePairEnsemble(input());
    expect(decision).toMatchObject({
      direction: "bull",
      executionSymbol: "TSLL",
      leverageMultiplier: 2,
      decisionKind: "enter",
      degraded: false,
      origin: ORIGIN,
      eligibleAfter: DECISION,
      weights: { kronos: 0.72, rust: 0.28 },
    });
    expect(decision.reasonCodes).toEqual(expect.arrayContaining([
      "kronos_direction_actionable",
      "rust_direction_supports_ai",
      "cost_and_uncertainty_adjusted_score_passed",
    ]));
  });

  it("uses Rust indicator direction/risk and Kronos target-before-stop evidence", () => {
    const base = model();
    const favorable = {
      ...base,
      targetStop: {
        status: "available" as const,
        targetFirstProbabilityLower: 0.7,
        targetFirstProbabilityUpper: 0.8,
        stopFirstProbabilityLower: 0.1,
        stopFirstProbabilityUpper: 0.2,
      },
    };
    const decision = evaluatePairEnsemble(input({
      models: models(favorable),
      rust: rust({
        indicatorDirectionalScore: 0.8,
        indicatorRiskScale: 0.7,
        indicatorCount: 20,
        indicatorComponents: { "group:trend": 0.8 },
      }),
    }));
    expect(decision.direction).toBe("bull");
    expect(decision.componentScores.kronos.bull)
      .toBeGreaterThan(evaluatePairEnsemble(input()).componentScores.kronos.bull);
    expect(decision.componentScores.rust.bull).toBeGreaterThan(0);
    expect(decision.exposureScale).toBeLessThanOrEqual(0.7);
  });

  it("uses structural-pattern strength directionally without letting liquidity risk rewrite direction", () => {
    const neutralBase = {
      status: "watch" as const,
      technicalSignal: 0 as const,
      multiTimeframeAgreement: "mixed",
      chartPatternBias: "bullish" as const,
    };
    const weakPattern = evaluatePairEnsemble(input({
      rust: rust({
        ...neutralBase,
        chartPatternStrength: 0.2,
        indicatorRiskScale: 1,
      }),
    }));
    const strongPattern = evaluatePairEnsemble(input({
      rust: rust({
        ...neutralBase,
        chartPatternStrength: 0.9,
        indicatorRiskScale: 1,
      }),
    }));
    expect(strongPattern.componentScores.rust.bull)
      .toBeGreaterThan(weakPattern.componentScores.rust.bull);

    const fullLiquidity = evaluatePairEnsemble(input({
      rust: rust({ indicatorRiskScale: 1 }),
    }));
    const thinLiquidity = evaluatePairEnsemble(input({
      rust: rust({ indicatorRiskScale: 0.2 }),
    }));
    expect(thinLiquidity.componentScores.rust).toEqual(fullLiquidity.componentScores.rust);
    expect(thinLiquidity.direction).toBe(fullLiquidity.direction);
    expect(thinLiquidity.exposureScale).toBeLessThan(fullLiquidity.exposureScale);
  });

  it("preserves opposing Rust evidence even when scanner liquidity scales exposure to zero", () => {
    const opposing = {
      status: "watch" as const,
      technicalSignal: 0 as const,
      multiTimeframeAgreement: "mixed",
      chartPatternBias: "neutral" as const,
      indicatorDirectionalScore: -1,
    };
    const liquid = evaluatePairEnsemble(input({
      rust: rust({ ...opposing, indicatorRiskScale: 1 }),
    }));
    const illiquid = evaluatePairEnsemble(input({
      rust: rust({ ...opposing, indicatorRiskScale: 0 }),
    }));
    expect(illiquid.componentScores.rust).toEqual(liquid.componentScores.rust);
    expect(illiquid.direction).toBe(liquid.direction);
  });

  it("penalizes unreliable paths and unresolved target-stop outcomes", () => {
    const reliable = model();
    reliable.validPathCount = 100;
    reliable.invalidPathCount = 0;
    reliable.targetStop = {
      status: "available",
      targetFirstProbabilityLower: 0.7,
      targetFirstProbabilityUpper: 0.7,
      stopFirstProbabilityLower: 0.2,
      stopFirstProbabilityUpper: 0.2,
      ambiguousProbability: 0,
      neitherProbability: 0.1,
    };
    const unreliable = model();
    unreliable.validPathCount = 10;
    unreliable.invalidPathCount = 90;
    unreliable.targetStop = {
      status: "available",
      targetFirstProbabilityLower: 0.4,
      targetFirstProbabilityUpper: 0.7,
      stopFirstProbabilityLower: 0.1,
      stopFirstProbabilityUpper: 0.4,
      ambiguousProbability: 0.3,
      neitherProbability: 0.2,
    };
    const reliableDecision = evaluatePairEnsemble(input({ models: models(reliable) }));
    const unreliableDecision = evaluatePairEnsemble(input({ models: models(unreliable) }));
    expect(reliableDecision.componentScores.kronos.pathReliability).toBe(1);
    expect(unreliableDecision.componentScores.kronos.pathReliability).toBe(0.1);
    expect(unreliableDecision.componentScores.kronos.bull)
      .toBeLessThan(reliableDecision.componentScores.kronos.bull);
  });

  it("allows a high-risk reduced entry while Rust watch is genuinely neutral", () => {
    const decision = evaluatePairEnsemble(input({
      rust: rust({
        status: "watch",
        technicalSignal: 0,
        multiTimeframeAgreement: "mixed",
        chartPatternBias: "neutral",
        confidence: 0.8,
      }),
    }));
    expect(decision).toMatchObject({
      direction: "bull",
      exposureScale: 0.8,
      degraded: false,
    });
    expect(decision.reasonCodes).toContain("rust_neutral_reduced_exposure");
  });

  it("chooses cash when Rust has a real opposing direction", () => {
    const decision = evaluatePairEnsemble(input({
      rust: rust({
        status: "exit_candidate",
        technicalSignal: -1,
        multiTimeframeAgreement: "aligned_bearish",
        chartPatternBias: "bearish",
      }),
    }));
    expect(decision.direction).toBe("cash");
    expect(decision.reasonCodes).toContain("rust_direction_conflict");
  });

  it("prioritizes liquidation for Rust exit and nonpositive held net return", () => {
    const rustExit = evaluatePairEnsemble(input({
      currentDirection: "bull",
      rust: rust({ status: "exit_candidate" }),
    }));
    expect(rustExit).toMatchObject({ direction: "cash", decisionKind: "exit" });
    expect(rustExit.reasonCodes).toContain("rust_exit_candidate");

    const negative = evaluatePairEnsemble(input({
      currentDirection: "bull",
      models: models(model(-0.002, 0.4)),
      rust: rust({ status: "hold" }),
    }));
    expect(negative.direction).toBe("cash");
    expect(negative.reasonCodes).toContain(
      "held_direction_net_expected_return_nonpositive",
    );
  });

  it("fails closed for unavailable/degraded models and origin mismatch", () => {
    const unavailable = evaluatePairEnsemble(input({
      models: models(model(0.015, 0.75, "unavailable")),
    }));
    expect(unavailable.direction).toBe("cash");
    expect(unavailable.reasonCodes).toContain("kronos_model_unavailable");
    expect(unavailable.weights).toEqual({ kronos: 0.72, rust: 0.28 });

    const degraded = evaluatePairEnsemble(input({
      models: models(model(0.015, 0.75, "degraded")),
    }));
    expect(degraded).toMatchObject({ direction: "cash", degraded: true });
    expect(degraded.reasonCodes).toContain("kronos_model_degraded");

    const misaligned = models();
    misaligned.alignmentStatus = "misaligned";
    delete misaligned.alignedOrigin;
    expect(evaluatePairEnsemble(input({ models: misaligned })).reasonCodes).toContain(
      "model_origin_not_aligned",
    );
  });

  it("fails closed for stale/missing quotes, session boundary, and cooldown", () => {
    const staleMarket = structuredClone(input().market);
    staleMarket.quotes.bull!.observedAt = "2026-07-24T14:29:00.000Z";
    expect(evaluatePairEnsemble(input({ market: staleMarket })).reasonCodes).toContain(
      "execution_quote_stale",
    );

    const missingMarket = structuredClone(input().market);
    delete missingMarket.quotes.bear;
    expect(evaluatePairEnsemble(input({ market: missingMarket })).reasonCodes).toContain(
      "execution_quote_unavailable",
    );

    expect(evaluatePairEnsemble(input({
      market: { ...input().market, session: "session_boundary" },
    })).reasonCodes).toContain("session_not_allowed");

    expect(evaluatePairEnsemble(input({
      cooldownUntil: "2026-07-24T14:31:00.000Z",
    })).reasonCodes).toContain("cooldown_active");
  });
});
