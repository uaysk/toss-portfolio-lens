import { describe, expect, it } from "vitest";
import {
  evaluateEconomicEquivalence,
  reasonDifferenceCauseCodes,
  routingTraceReason,
} from "./compare-fincast-p40-policy-regression.js";

describe("FinCast backend reason and economic comparison", () => {
  it("attributes boundary, score, ordering, CDF, plateau, and reason-only drift", () => {
    expect(reasonDifferenceCauseCodes({
      scenario: "entry",
      thresholdCrossed: true,
      referenceScore: 0.01,
      candidateScore: -0.01,
      selectionChanged: true,
      referenceSegment: {
        index: 2,
        leftQuantile: 0.1,
        rightQuantile: 0.25,
        leftPrice: 100,
        rightPrice: 100.0005,
        widthRate: 0.000005,
        baseOffsetRate: 0.000002,
      },
      candidateSegment: {
        index: 3,
        leftQuantile: 0.25,
        rightQuantile: 0.5,
        leftPrice: 100,
        rightPrice: 101,
        widthRate: 0.01,
        baseOffsetRate: 0,
      },
      referenceProjectedPrices: [99, 100, 100, 100.0005, 101],
      candidateProjectedPrices: [99, 100, 100.1, 101, 102],
      referenceReasons: ["entry_probability_threshold_not_met"],
      candidateReasons: [],
      reasonMismatch: true,
      actionMismatch: false,
    })).toEqual([
      "entry_probability_threshold_crossing",
      "risk_adjusted_score_sign_crossing",
      "selection_order_swap",
      "projected_cdf_segment_change",
      "interior_quantile_plateau_or_narrow_cdf_segment",
      "reason_only_no_action_change",
    ]);
  });

  it("ignores intentional tail clamps and isolates the directional 50% boundary", () => {
    expect(reasonDifferenceCauseCodes({
      scenario: "entry",
      thresholdCrossed: false,
      referenceScore: 0.1,
      candidateScore: 0.1,
      selectionChanged: false,
      referenceSegment: null,
      candidateSegment: null,
      referenceProjectedPrices: [99, 99, 100, 101, 102, 103, 103],
      candidateProjectedPrices: [99, 99, 100.1, 101, 102, 103, 103],
      referenceReasons: ["model_down_probability_not_below_up_probability"],
      candidateReasons: [],
      reasonMismatch: true,
      actionMismatch: false,
    })).toEqual([
      "directional_probability_50pct_crossing",
      "reason_only_no_action_change",
    ]);
  });

  it("labels non-boundary numerical drift explicitly", () => {
    expect(reasonDifferenceCauseCodes({
      scenario: "exit",
      thresholdCrossed: false,
      referenceScore: 0.1,
      candidateScore: 0.10001,
      selectionChanged: false,
      referenceSegment: null,
      candidateSegment: null,
      referenceProjectedPrices: [99, 100, 101],
      candidateProjectedPrices: [99, 100.001, 101],
      referenceReasons: [],
      candidateReasons: [],
      reasonMismatch: false,
      actionMismatch: false,
    })).toEqual(["numeric_drift_without_boundary_crossing"]);
  });

  it("applies conservative return, drawdown, and decision mismatch limits", () => {
    expect(evaluateEconomicEquivalence({
      maximumAbsoluteTotalReturnDelta: 0.0001,
      maximumAbsoluteDrawdownDelta: 0.0001,
      decisionMismatchCount: 1,
      decisionCount: 1_000,
    })).toEqual({
      passed: true,
      decisionMismatchRate: 0.001,
    });
    expect(evaluateEconomicEquivalence({
      maximumAbsoluteTotalReturnDelta: 0.0001001,
      maximumAbsoluteDrawdownDelta: 0.0001,
      decisionMismatchCount: 1,
      decisionCount: 1_000,
    }).passed).toBe(false);
    expect(() => evaluateEconomicEquivalence({
      maximumAbsoluteTotalReturnDelta: 0,
      maximumAbsoluteDrawdownDelta: 0,
      decisionMismatchCount: 2,
      decisionCount: 1,
    })).toThrow("economic equivalence inputs are invalid");
  });

  it("does not describe a dense Chronos-2 challenger as a TensorRT router", () => {
    expect(routingTraceReason("chronos2_gpu_gather")).toContain(
      "dense feed-forward blocks",
    );
    expect(routingTraceReason("chronos2_gpu_gather")).not.toContain("TensorRT");
    expect(routingTraceReason("tensorrt_fp32")).toContain("TensorRT");
  });
});
