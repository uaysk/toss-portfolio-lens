import { describe, expect, it } from "vitest";
import {
  DEFAULT_PAIR_ENSEMBLE_POLICY_PROFILE,
  evaluatePairEnsemble,
  type PairEnsembleInput,
} from "./ensemble-policy.js";
import {
  createPairDecisionProvenance,
  verifyPairDecisionReplay,
} from "./decision-provenance.js";
import type { NormalizedPairModelOutput } from "./model-output-normalization.js";
import { getPairCatalogEntry } from "./pair-catalog.js";

const ORIGIN = "2026-07-24T14:30:00.000Z";

function model(component: "chronos2" | "kronos"): NormalizedPairModelOutput {
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
    medianReturn: 0.015,
    q10Return: 0,
    q90Return: 0.03,
    upProbability: 0.75,
    downProbability: 0.25,
    uncertaintyWidth: 0.03,
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
    rawOutput: {
      model: component,
      quantiles: [0, 0.015, 0.03],
    },
  };
}

function ensembleInput(): PairEnsembleInput {
  return {
    pair: getPairCatalogEntry("tsla-tsll-tslq"),
    models: {
      normalizationVersion: "pair-model-normalization/v1",
      signalSymbol: "TSLA",
      expectedOrigin: ORIGIN,
      alignedOrigin: ORIGIN,
      alignmentStatus: "aligned",
      reasonCodes: [],
      chronos2: model("chronos2"),
      kronos: model("kronos"),
      rawResponse: { requestId: "request-a" },
    },
    rust: {
      status: "entry_candidate",
      signalOriginAt: ORIGIN,
      observedAt: "2026-07-24T14:30:03.000Z",
      technicalSignal: 1,
      multiTimeframeAgreement: "aligned_bullish",
      confidence: 1,
      chartPatternBias: "bullish",
      chartPatterns: ["bullish_engulfing"],
      dataQuality: "good",
      rawOutput: { status: "entry_candidate", origin: ORIGIN },
    },
    currentDirection: "cash",
    decisionAt: "2026-07-24T14:30:05.000Z",
    riskTolerance: 75,
    costs: {
      commissionBpsPerSide: 1,
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
    profile: {
      ...DEFAULT_PAIR_ENSEMBLE_POLICY_PROFILE,
      weights: { ...DEFAULT_PAIR_ENSEMBLE_POLICY_PROFILE.weights },
      modelScoreWeights: { ...DEFAULT_PAIR_ENSEMBLE_POLICY_PROFILE.modelScoreWeights },
    },
  };
}

describe("pair decision provenance", () => {
  it("stores raw components, fixed weights, scores, reasons, and deterministic replay evidence", () => {
    const input = ensembleInput();
    const decision = evaluatePairEnsemble(input);
    const first = createPairDecisionProvenance({
      ensembleInput: input,
      decision,
      sizing: { quantity: 10, sizingVersion: "pair-exposure-sizing/v1" },
    });
    const second = createPairDecisionProvenance({
      ensembleInput: input,
      decision,
      sizing: { sizingVersion: "pair-exposure-sizing/v1", quantity: 10 },
    });
    expect(first.decisionId).toBe(second.decisionId);
    expect(first).toMatchObject({
      pairId: "tsla-tsll-tslq",
      signalSymbol: "TSLA",
      executionSymbol: "TSLL",
      direction: "bull",
      origin: ORIGIN,
      weights: { chronos2: 0.35, kronos: 0.35, rust: 0.3 },
      rawInputs: {
        chronos2: { model: "chronos2" },
        kronos: { model: "kronos" },
        rust: { status: "entry_candidate" },
      },
    });
    expect(first.components).toHaveProperty("chronos2Bull");
    expect(first.reasons).toContain("ai_models_direction_agree");
    expect(verifyPairDecisionReplay(first)).toMatchObject({
      valid: true,
      reasonCodes: [],
    });
  });

  it("rejects a decision that was not produced by the supplied inputs", () => {
    const input = ensembleInput();
    const decision = evaluatePairEnsemble(input);
    expect(() => createPairDecisionProvenance({
      ensembleInput: input,
      decision: { ...decision, direction: "cash" },
    })).toThrow(/does not reproduce/);
  });

  it("detects raw input, decision, and sizing mutation", () => {
    const input = ensembleInput();
    const provenance = createPairDecisionProvenance({
      ensembleInput: input,
      decision: evaluatePairEnsemble(input),
      sizing: { quantity: 10 },
    });
    provenance.replayInput.models.chronos2.rawOutput = { mutated: true };
    provenance.decision.reasonCodes.push("mutated");
    provenance.sizing = { quantity: 11 };
    const verified = verifyPairDecisionReplay(provenance);
    expect(verified.valid).toBe(false);
    expect(verified.reasonCodes).toEqual(expect.arrayContaining([
      "input_digest_mismatch",
      "decision_digest_mismatch",
      "sizing_digest_mismatch",
      "policy_replay_mismatch",
    ]));
  });
});
