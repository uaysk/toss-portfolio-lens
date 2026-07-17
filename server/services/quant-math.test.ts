import { describe, expect, it } from "vitest";
import {
  alignReturnSeries,
  analyzePairedReturnSeries,
  analyzeReturnSeries,
  buildCorrelationMatrix,
  buildRollingCorrelation,
  convertPricesToReturns,
  type ReturnSeriesInput,
} from "./quant-math.js";

function returns(key: string, values: Array<[string, number]>): ReturnSeriesInput {
  return { key, label: key, points: values.map(([date, value]) => ({ date, value })) };
}

describe("quant math regressions", () => {
  it("한국·미국 휴장일을 carry-forward하지 않고 실제 공통 관측일만 inner join한다", () => {
    const aligned = alignReturnSeries([
      returns("KR", [["2024-01-02", 0.01], ["2024-01-03", 0.02], ["2024-01-04", 0.03]]),
      returns("US", [["2024-01-02", -0.01], ["2024-01-04", 0.04], ["2024-01-05", 0.02]]),
    ]);
    expect(aligned.dates).toEqual(["2024-01-02", "2024-01-04"]);
    expect(aligned.byKey.KR).toEqual([0.01, 0.03]);
    expect(aligned.byKey.US).toEqual([-0.01, 0.04]);
  });

  it("Pearson, Spearman, rolling correlation과 상대 위험 지표를 계산한다", () => {
    const benchmark = returns("B", [
      ["2024-01-02", -0.02], ["2024-01-03", -0.01], ["2024-01-04", 0.01],
      ["2024-01-05", 0.02], ["2024-01-06", 0.03],
    ]);
    const asset = returns("A", benchmark.points.map((point) => [point.date, point.value * 2] as [string, number]));
    const paired = analyzePairedReturnSeries(asset, benchmark, { annualization: 252 });
    expect(paired.observations).toBe(5);
    expect(paired.pearsonCorrelation).toBeCloseTo(1, 12);
    expect(paired.spearmanCorrelation).toBeCloseTo(1, 12);
    expect(paired.beta).toBeCloseTo(2, 12);
    expect(paired.rSquared).toBeCloseTo(1, 12);
    expect(paired.trackingError).toBeGreaterThan(0);
    expect(paired.upCorrelation).toBeCloseTo(1, 12);
    expect(paired.downCorrelation).toBeCloseTo(1, 12);
    const rolling = buildRollingCorrelation(asset, benchmark, 3);
    expect(rolling.slice(0, 2).every((point) => point.value === null)).toBe(true);
    expect(rolling.at(-1)?.value).toBeCloseTo(1, 12);
  });

  it("전체 자산 공통 표본으로 correlation matrix를 만들고 순위 동률 Spearman을 처리한다", () => {
    const first = returns("A", [["2024-01-02", 1], ["2024-01-03", 1], ["2024-01-04", 2], ["2024-01-05", 3]]);
    const second = returns("B", [["2024-01-02", 10], ["2024-01-03", 10], ["2024-01-04", 20], ["2024-01-05", 30]]);
    const third = returns("C", [["2024-01-02", 4], ["2024-01-04", 2], ["2024-01-05", 1], ["2024-01-06", 0]]);
    const matrix = buildCorrelationMatrix([first, second, third], { method: "spearman" });
    expect(matrix.observations.flat()).toEqual(Array(9).fill(3));
    expect(matrix.correlation[0][1]).toBeCloseTo(1, 12);
    expect(matrix.correlation[0][2]).toBeCloseTo(-1, 12);
  });

  it("성과·낙폭·tail risk를 유한값으로 계산하고 잘못된 날짜를 경고한다", () => {
    const result = analyzeReturnSeries(returns("A", [
      ["2024-01-02", 0.1], ["2024-01-03", -0.05], ["2024-01-04", 0.03],
      ["2024-99-99", 0.5], ["2024-01-05", -0.01], ["2024-01-06", 0.02],
    ]), { annualization: 252, riskFreeRatePercent: 0 });
    expect(result.cumulativeReturn).toBeCloseTo(1.1 * 0.95 * 1.03 * 0.99 * 1.02 - 1, 12);
    expect(result.maxDrawdown).toBeLessThan(0);
    expect(result.calmarRatio).toBeGreaterThan(0);
    expect(result.valueAtRisk95).not.toBeNull();
    expect(result.conditionalValueAtRisk95).not.toBeNull();
    expect(result.warnings).toEqual(expect.arrayContaining([expect.stringContaining("비정상 날짜 1건")]));
  });

  it("가격을 수정주가 수익률로 변환한다", () => {
    const converted = convertPricesToReturns({
      key: "A",
      label: "A",
      points: [
        { date: "2024-01-01", value: 100 },
        { date: "2024-01-02", value: 110 },
        { date: "2024-01-03", value: 99 },
      ],
    }).points;
    expect(converted.map((point) => point.date)).toEqual(["2024-01-02", "2024-01-03"]);
    expect(converted[0].value).toBeCloseTo(0.1, 12);
    expect(converted[1].value).toBeCloseTo(-0.1, 12);
  });
});
