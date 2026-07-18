import { describe, expect, it } from "vitest";
import { combinePortfolioOutlook } from "./outlook-service.js";

describe("portfolio outlook combiner", () => {
  it("OOS·Monte Carlo·stress를 결합하고 누락 calibration을 경고한다", () => {
    const result = combinePortfolioOutlook({
      walkForward: { folds: [
        { testEnd: "2024-03-01", trainCount: 20, oos: { return: 0.1, sampleCount: 5 } },
        { testEnd: "2024-04-01", trainCount: 20, oos: { return: -0.05, sampleCount: 5 } },
      ] },
      monteCarlo: {
        distributions: { terminalBalance: { percentiles: [{ quantile: 0.5, value: 110 }] } },
        probabilities: { terminalLossProbabilityPercent: 30, everDepletedProbabilityPercent: 2 },
      },
      stress: { scenarios: [
        { id: "up", metrics: { totalReturnPercent: 10 } },
        { id: "down", metrics: { totalReturnPercent: -20 } },
      ] },
      confidenceWeights: { oos: 0.45, monteCarloCalibration: 0.35, dataQuality: 0.2 },
    });
    expect(result.oos.stitchedEquity.at(-1)?.equity).toBeCloseTo(1.045);
    expect(result.future.terminalBalanceQuantiles).toEqual([{ quantile: 0.5, balance: 110 }]);
    expect((result.stress.worstScenario as { id: string }).id).toBe("down");
    expect(result.confidence.availableWeight).toBeCloseTo(0.65);
    expect(result.warnings).toEqual([expect.stringContaining("calibration")]);
  });
});
