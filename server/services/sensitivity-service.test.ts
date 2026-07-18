import { describe, expect, it, vi } from "vitest";
import { runSensitivityAnalysis } from "./sensitivity-service.js";

describe("sensitivity analysis regressions", () => {
  it("시작일·리밸런싱·현금흐름 조합을 중복 교차하지 않고 metadata index를 보존한다", async () => {
    const result = await runSensitivityAnalysis({
      baseWeights: { A: 0.6, B: 0.4 },
      baseStartDate: "2024-01-01",
      endDate: "2024-12-31",
      weightScenarioCount: 1,
      startDateOffsets: [0, 1],
      rebalanceModes: ["none", "monthly"],
      baseCashFlows: [{ date: "2024-02-01", amount: 100 }],
      cashFlowStressMultipliers: [0.5, 1],
      scenarioLimit: 20,
    }, (scenario) => scenario.label);
    expect(result.scenarios).toHaveLength(8);
    expect(new Set(result.scenarios.map((item) => item.scenario.label)).size).toBe(8);
    expect(result.scenarios.every((item) => Number.isInteger(item.scenario.metadata.cashFlowIndex))).toBe(true);
    expect(result.scenarios.every((item) => item.scenario.rebalancePlan.dates[0] === item.scenario.startDate)).toBe(true);
  });

  it("명시한 종목 비중 범위와 seed를 재현하고 cancellation을 확인한다", async () => {
    const options = {
      baseWeights: { A: 0.6, B: 0.4 },
      baseStartDate: "2024-01-01",
      endDate: "2024-12-31",
      targetAsset: "A",
      targetWeights: [0.2, 0.5, 0.8],
      rebalanceModes: ["none" as const],
      scenarioLimit: 10,
      seed: 99,
    };
    const first = await runSensitivityAnalysis(options, (scenario) => scenario.baseWeights.A);
    const second = await runSensitivityAnalysis(options, (scenario) => scenario.baseWeights.A);
    expect(first).toEqual(second);
    expect(first.scenarios.map((item) => item.scenario.baseWeights.A)).toEqual([0.2, 0.5, 0.8]);

    const cancelled = vi.fn().mockResolvedValue(true);
    await expect(runSensitivityAnalysis({ ...options, isCancelled: cancelled }, () => 1)).rejects.toThrow("취소");
    expect(cancelled).toHaveBeenCalled();
  });
});
