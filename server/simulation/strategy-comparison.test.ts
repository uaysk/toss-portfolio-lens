import { describe, expect, it } from "vitest";
import {
  comparePairStrategies,
  isNonOverlappingPairComparisonOrigin,
  selectBestExecutablePairOutcome,
  type PairStrategyComparisonObservation,
} from "./strategy-comparison.js";

function observation(
  index: number,
  overrides: Partial<PairStrategyComparisonObservation> = {},
): PairStrategyComparisonObservation {
  const minute = 30 + index * 5;
  const origin = `2026-07-24T14:${String(minute).padStart(2, "0")}:00.000Z`;
  return {
    observationId: `origin-${index}`,
    origin,
    eligibleAfter: `2026-07-24T14:${String(minute).padStart(2, "0")}:05.000Z`,
    targetTimestamp: `2026-07-24T14:${String(minute + 4).padStart(2, "0")}:59.000Z`,
    actualDirection: index === 0 ? "bull" : "bear",
    actualExecutionSymbol: index === 0 ? "TSLL" : "TSLQ",
    executableOutcomes: {
      bull: { executionSymbol: "TSLL", grossReturn: index === 0 ? 0.03 : -0.02 },
      bear: { executionSymbol: "TSLQ", grossReturn: index === 0 ? -0.025 : 0.025 },
    },
    lanes: {
      kronos: {
        status: "available",
        direction: index === 0 ? "bull" : "bear",
        executionSymbol: index === 0 ? "TSLL" : "TSLQ",
        directionProbability: 0.65,
        calibrationStatus: "good",
        latencyMs: 180,
      },
      rust: {
        status: "available",
        direction: index === 0 ? "bull" : "cash",
        executionSymbol: index === 0 ? "TSLL" : null,
        calibrationStatus: "unavailable",
        latencyMs: 8,
      },
      ensemble: {
        status: "available",
        direction: index === 0 ? "bull" : "bear",
        executionSymbol: index === 0 ? "TSLL" : "TSLQ",
        directionProbability: 0.75,
        calibrationStatus: "good",
        latencyMs: 310,
      },
    },
    ...overrides,
  };
}

const input = {
  conditionId: "same-origin-cost-price-window-v1",
  initialCapital: 100_000,
  costs: {
    commissionBpsPerSide: 1,
    taxBpsOnExit: 0,
    spreadBpsRoundTrip: 5,
    slippageBpsPerSide: 2,
    switchCostBps: 10,
  },
  executionPolicyId: "next-observed-after-common-eligibility/v1",
  observations: [observation(0), observation(1)],
} as const;

describe("pair strategy comparison", () => {
  it("labels the realized direction from the best positive execution-ETF net outcome", () => {
    expect(selectBestExecutablePairOutcome({
      bull: { executionSymbol: "TSLL", grossReturn: 0.004 },
      bear: { executionSymbol: "TSLQ", grossReturn: 0.009 },
    }, input.costs)).toMatchObject({
      direction: "bear",
      executionSymbol: "TSLQ",
      netReturns: { bull: 0.0029, bear: 0.0079, cash: 0 },
    });

    expect(selectBestExecutablePairOutcome({
      bull: { executionSymbol: "TSLL", grossReturn: 0.001 },
      bear: { executionSymbol: "TSLQ", grossReturn: -0.002 },
    }, input.costs)).toMatchObject({
      direction: "cash",
      executionSymbol: null,
    });

    expect(selectBestExecutablePairOutcome({
      bull: { executionSymbol: "TSLL", grossReturn: 0.005 },
      bear: { executionSymbol: "TSLQ", grossReturn: 0.005 },
    }, input.costs)).toMatchObject({
      direction: "cash",
      executionSymbol: null,
    });
  });

  it("compares all lanes on one explicit origin, cost, price, and period condition", () => {
    const result = comparePairStrategies(input);
    expect(result).toMatchObject({
      conditionId: input.conditionId,
      sameOrigin: true,
      sameCosts: true,
      sameExecutionPolicy: true,
      common: { originCount: 2, initialCapital: 100_000 },
    });
    expect(Object.keys(result.lanes)).toEqual(["kronos", "rust", "ensemble"]);
    expect(result.lanes.ensemble).toMatchObject({
      status: "available",
      analyticalOnly: true,
      bullCount: 1,
      bearCount: 1,
      directionAccuracy: 1,
      executionSelectionAccuracy: 1,
      tradeCount: 2,
    });
    expect(result.lanes.kronos.analyticalOnly).toBe(true);
    expect(result.lanes.ensemble.netReturn).toBeLessThan(
      result.lanes.ensemble.cumulativeReturn,
    );
    expect(result.lanes.ensemble.netProfit).toBe(
      Math.round(result.lanes.ensemble.netReturn * input.initialCapital * 1e9) / 1e9,
    );
  });

  it("reports unavailable/calibration ratios and model latency without fabricating results", () => {
    const missing = observation(1);
    missing.lanes.kronos = {
      status: "unavailable",
      unavailableReason: "model_cache_missing",
      calibrationStatus: "unavailable",
      latencyMs: 10,
    };
    const result = comparePairStrategies({ ...input, observations: [observation(0), missing] });
    expect(result.lanes.kronos).toMatchObject({
      status: "partial",
      availableCount: 1,
      unavailableCount: 1,
      unavailableRate: 0.5,
      calibrationUnavailableRate: 0.5,
      averageLatencyMs: 95,
    });
    expect(result.lanes.rust.calibrationUnavailableRate).toBe(1);
  });

  it("deducts identical costs and adds transition cost only on direction switches", () => {
    const result = comparePairStrategies(input);
    expect(result.lanes.ensemble.totalCosts).toBeGreaterThan(
      result.lanes.rust.totalCosts,
    );
    expect(result.lanes.ensemble.transitionCount).toBe(2);
    expect(result.lanes.rust.transitionCount).toBe(2);
  });

  it("rejects missing lane status, duplicate origins, and non-common execution symbols", () => {
    const missing = observation(0) as unknown as {
      lanes: Partial<PairStrategyComparisonObservation["lanes"]>;
    };
    delete missing.lanes.kronos;
    expect(() => comparePairStrategies({
      ...input,
      observations: [missing as PairStrategyComparisonObservation],
    })).toThrow(/explicit kronos lane status/);
    expect(() => comparePairStrategies({
      ...input,
      observations: [observation(0), observation(0)],
    })).toThrow(/Duplicate comparison observation/);
    const wrong = observation(0);
    expect(wrong.lanes.ensemble.status).toBe("available");
    if (wrong.lanes.ensemble.status !== "available") {
      throw new Error("fixture must provide an available ensemble lane");
    }
    wrong.lanes.ensemble = {
      ...wrong.lanes.ensemble,
      executionSymbol: "WRONG",
    };
    expect(() => comparePairStrategies({
      ...input,
      observations: [wrong],
    })).toThrow(/common executable instrument/);
  });

  it("admits only origins at or after every prior evaluation target", () => {
    const existing = [{ targetTimestamp: "2026-07-24T14:35:00.000Z" }];
    expect(isNonOverlappingPairComparisonOrigin(
      existing,
      "2026-07-24T14:34:59.999Z",
    )).toBe(false);
    expect(isNonOverlappingPairComparisonOrigin(
      existing,
      "2026-07-24T14:35:00.000Z",
    )).toBe(true);
  });
});
