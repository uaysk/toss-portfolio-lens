import { describe, expect, it } from "vitest";
import {
  buildParetoFrontier,
  buildWalkForwardWindows,
  optimizePortfolio,
  type PortfolioCandidate,
} from "./optimization-service.js";

function date(index: number): string {
  return new Date(Date.UTC(2024, 0, 1 + index)).toISOString().slice(0, 10);
}

function series(key: string, drift: number, phase: number) {
  let value = 100;
  return {
    key,
    label: key,
    points: Array.from({ length: 90 }, (_, index) => {
      value *= 1 + drift + Math.sin(index / 5 + phase) * 0.004;
      return { date: date(index), value };
    }),
  };
}

describe("portfolio optimization regressions", () => {
  it("같은 seed와 candidate budget에서 결정론적인 후보 비중을 생성한다", () => {
    const input = {
      objective: "robust_score" as const,
      priceSeries: [series("A", 0.001, 0), series("B", 0.0005, 1), series("C", 0.0008, 2)],
      constraints: { minWeight: 0, maxWeight: 0.8, maxAssets: 3 },
      seed: 12345,
      candidateBudget: 40,
      minimumSamples: 20,
    };
    const first = optimizePortfolio(input);
    const second = optimizePortfolio(input);
    expect(first.candidateCount).toBeGreaterThan(0);
    expect(first.bestByObjective.max_cagr?.metrics.cagr).toEqual(expect.any(Number));
    expect(first.bestByObjective.max_total_return?.metrics.totalReturn).toEqual(expect.any(Number));
    expect(first.candidates[0].metrics).toMatchObject({
      return: first.candidates[0].metrics.cagr,
      period: expect.objectContaining({ role: "screening_full", observationCount: 89 }),
    });
    expect(first.candidates).toEqual(second.candidates);
    expect(first.bestByObjective).toEqual(second.bestByObjective);
    expect(optimizePortfolio({ ...input, seed: 54321 }).candidates).not.toEqual(first.candidates);
  });

  it("필수·제외 충돌을 거부하고 종목별 비중 제약을 지킨다", () => {
    const priceSeries = [series("A", 0.001, 0), series("B", 0.0005, 1), series("C", 0.0008, 2)];
    expect(() => optimizePortfolio({
      objective: "robust_score",
      priceSeries,
      constraints: { requiredAssets: ["A"], excludedAssets: ["A"] },
      candidateBudget: 10,
    })).toThrow("필수 자산");

    const result = optimizePortfolio({
      objective: "robust_score",
      priceSeries,
      constraints: { minWeights: { A: 0.2 }, maxWeights: { A: 0.4 }, maxAssets: 3 },
      seed: 7,
      candidateBudget: 25,
    });
    expect(result.candidates.every((candidate) => candidate.weights.A >= 0.2 && candidate.weights.A <= 0.4)).toBe(true);
  });

  it("수익·위험·회전율·비용의 비지배 후보만 Pareto frontier에 남긴다", () => {
    const candidate = (name: string, values: Partial<PortfolioCandidate["metrics"]>): PortfolioCandidate => ({
      weights: { [name]: 1 },
      sampleCount: 100,
      metrics: {
        cagr: 0.1, totalReturn: 0.1,
        sharpe: 1, sortino: 1, calmar: 1, volatility: 0.1, cvar: -0.1,
        informationRatio: null, robustScore: 1, return: 0.1, maxDrawdown: -0.1,
        turnover: 0.1, transactionCost: 0.001, ...values,
        period: { observationCount: 100, role: "screening_full" },
      },
    });
    const strong = candidate("strong", { return: 0.2, volatility: 0.08, maxDrawdown: -0.08, cvar: -0.08, turnover: 0.05, transactionCost: 0.0005 });
    const dominated = candidate("dominated", { return: 0.1, volatility: 0.12, maxDrawdown: -0.12, cvar: -0.12, turnover: 0.2, transactionCost: 0.002 });
    const tradeoff = candidate("tradeoff", { return: 0.25, volatility: 0.2, maxDrawdown: -0.2, cvar: -0.2, turnover: 0.3, transactionCost: 0.003 });
    expect(buildParetoFrontier([strong, dominated, tradeoff])).toEqual([strong, tradeoff]);
  });

  it("walk-forward 학습 구간과 다음 OOS 구간을 겹치지 않게 생성한다", () => {
    const windows = buildWalkForwardWindows(30, {
      trainWindow: 15,
      testWindow: 5,
      step: 5,
      minimumTrainObservations: 10,
      minimumTestObservations: 5,
    });
    expect(windows).toHaveLength(3);
    for (const window of windows) {
      expect(window.trainEndIndex).toBeLessThan(window.testStartIndex);
      expect(window.trainCount).toBe(15);
      expect(window.testCount).toBe(5);
    }
  });

  it("rolling·anchored fold에 gap·embargo·fold cap을 동일하게 적용한다", () => {
    const rolling = buildWalkForwardWindows(240, {
      mode: "walk_forward",
      windowMode: "rolling",
      trainWindow: 60,
      testWindow: 20,
      step: 10,
      foldCount: 4,
      gap: 3,
      embargo: 5,
    });
    expect(rolling).toHaveLength(4);
    expect(rolling.map((fold) => fold.trainStartIndex)).toEqual([0, 25, 50, 75]);
    for (const [index, fold] of rolling.entries()) {
      expect(fold.testStartIndex).toBe(fold.trainEndIndex + 1 + 3);
      if (index > 0) expect(fold.testStartIndex).toBeGreaterThanOrEqual(rolling[index - 1]!.testEndIndex + 1 + 5);
    }

    const anchored = buildWalkForwardWindows(240, {
      mode: "walk_forward",
      windowMode: "anchored",
      trainWindow: 60,
      testWindow: 20,
      step: 10,
      foldCount: 4,
      gap: 3,
      embargo: 5,
    });
    expect(anchored).toHaveLength(4);
    expect(anchored.every((fold) => fold.trainStartIndex === 0)).toBe(true);
    expect(anchored[1]!.trainCount).toBeGreaterThan(anchored[0]!.trainCount);
  });

  it("기존 fraction holdout을 유지하고 다중 OOS fold 구성요소·coverage를 공개한다", () => {
    const holdout = buildWalkForwardWindows(100, {
      mode: "holdout",
      trainFraction: 0.75,
      testFraction: 0.2,
      gap: 3,
      minimumTrainObservations: 20,
      minimumTestObservations: 5,
    });
    expect(holdout).toHaveLength(1);
    expect(holdout[0]).toMatchObject({ mode: "holdout", trainCount: 75, testCount: 20, gap: 3 });
    expect(holdout[0]!.testStartIndex - holdout[0]!.trainEndIndex - 1).toBe(3);

    const result = optimizePortfolio({
      objective: "robust_score",
      priceSeries: [series("A", 0.001, 0), series("B", 0.0005, 1), series("C", 0.0008, 2)],
      constraints: { minWeight: 0, maxWeight: 0.8, maxAssets: 3 },
      seed: 12345,
      candidateBudget: 20,
      minimumSamples: 5,
      walkForwardConfig: {
        mode: "walk_forward",
        windowMode: "anchored",
        trainWindow: 30,
        testWindow: 10,
        step: 10,
        foldCount: 4,
        gap: 2,
        embargo: 3,
      },
    });
    expect(result.candidates.length).toBeGreaterThan(0);
    for (const candidate of result.candidates) {
      expect(candidate.sampleCount).toBe(30);
      expect(candidate.walkForwardSignal).toMatchObject({
        mode: "walk_forward",
        windowMode: "anchored",
        foldCount: 4,
        scoredFoldCount: 4,
      });
      expect(candidate.walkForwardTestCoverage).toBeCloseTo(40 / 89);
      expect(candidate.robustScoreDetail).toMatchObject({
        validation: { mode: "walk_forward", windowMode: "anchored", foldCount: 4, scoredFoldCount: 4 },
      });
    }
  });
});
