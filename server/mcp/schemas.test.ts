import { describe, expect, it } from "vitest";
import { resolvedPresetExecutionSchemas, toolSchemas } from "./schemas.js";

const base = {
  assets: [
    { symbol: "AAA", weight: 50 },
    { symbol: "BBB", weight: 50 },
  ],
  startDate: "2024-01-01",
  endDate: "2024-12-31",
  initialAmount: 100_000,
  monthlyCashFlow: 0,
  rebalanceFrequency: "none",
  benchmark: "NONE",
};

describe("backtest policy schemas", () => {
  it("모든 자산을 포함하는 날짜별 목표비중 정책을 정규화한다", () => {
    const parsed = toolSchemas.run_portfolio_backtest.parse({
      ...base,
      targetWeightSchedule: [{
        date: "2024-06-03",
        weights: { aaa: 20, bbb: 70 },
        cashTargetPercent: 10,
        regime: "risk_off",
      }],
    });
    expect(parsed.targetWeightSchedule[0]).toMatchObject({
      weights: { AAA: 20, BBB: 70 },
      cashTargetPercent: 10,
      regime: "risk_off",
    });
  });

  it("누락 종목·잘못된 합계와 중복 날짜를 거부한다", () => {
    expect(() => toolSchemas.run_portfolio_backtest.parse({
      ...base,
      targetWeightSchedule: [
        { date: "2024-06-03", weights: { AAA: 100 } },
        { date: "2024-06-03", weights: { AAA: 40, BBB: 40 } },
      ],
    })).toThrow();
  });

  it("PIT 강제 시 명시적 [편입일, 제외일) 구간을 요구한다", () => {
    expect(() => toolSchemas.run_portfolio_backtest.parse({
      ...base,
      realism: { enforcePointInTimeUniverse: true },
    })).toThrow();

    const parsed = toolSchemas.run_portfolio_backtest.parse({
      ...base,
      assets: [
        { symbol: "AAA", weight: 50, universeMemberFrom: "2023-01-01", universeMemberTo: "2025-01-01" },
        { symbol: "BBB", weight: 50, universeMemberFrom: "2024-06-01", universeMemberTo: "2025-01-01" },
      ],
      realism: { enforcePointInTimeUniverse: true },
    });
    expect(parsed.realism.enforcePointInTimeUniverse).toBe(true);
  });
});

describe("optimizer validation schemas", () => {
  const optimization = {
    symbols: ["AAA", "BBB"],
    fromDate: "2020-01-01",
    toDate: "2024-12-31",
  };

  it("국면 정책과 고급 optimizer 구성을 Rust 계약 이름으로 보존한다", () => {
    const input = {
      ...optimization,
      algorithm: "nsga_ii",
      covarianceEstimator: "ledoit_wolf",
      regimePolicySearch: {
        enabled: true,
        method: "mcts",
        states: ["risk_on", "neutral", "risk_off"],
        baselineActions: ["equal_weight", "risk_parity", "hrp"],
      },
    } as const;
    expect(toolSchemas.optimize_portfolio.parse(input).regimePolicySearch).not.toHaveProperty("lookback");
    const parsed = resolvedPresetExecutionSchemas.optimize_portfolio.parse(input);
    expect(parsed.regimePolicySearch).toMatchObject({
      enabled: true,
      method: "mcts",
      states: ["risk_on", "neutral", "risk_off"],
      lookback: 63,
      ledgerValidationBudget: 3,
    });
  });

  it("Walk-forward fold 예산과 seed 유일성을 강제한다", () => {
    expect(() => toolSchemas.walk_forward_optimize.parse({
      ...optimization,
      foldCandidateBudget: 1,
      seeds: [7, 7],
    })).toThrow();
  });

  it("공개되지 않은 robust score 키와 전부 0인 사용자 가중치를 거부한다", () => {
    expect(() => toolSchemas.optimize_portfolio.parse({
      ...optimization,
      robustScoreWeights: { sharpTypo: 0.5 },
    })).toThrow();
    expect(() => toolSchemas.optimize_portfolio.parse({
      ...optimization,
      robustScoreWeights: { sharpe: 0, oosAverageSharpe: 0 },
    })).toThrow();
  });

  it("다중 inner walk-forward를 기본 적용하고 기존 holdout과 분할 검증을 보존한다", () => {
    expect(toolSchemas.optimize_portfolio.parse(optimization).robustValidation).toBeUndefined();
    const parsed = resolvedPresetExecutionSchemas.optimize_portfolio.parse(optimization);
    expect(parsed.robustValidation).toEqual({
      enabled: true,
      mode: "walk_forward",
      windowMode: "rolling",
      trainFraction: 0.8,
      testFraction: 0.2,
      trainWindow: 126,
      testWindow: 21,
      step: 21,
      foldCount: 5,
      gap: 0,
      embargo: 0,
      minimumTrainObservations: 20,
      minimumTestObservations: 5,
    });
    expect(resolvedPresetExecutionSchemas.optimize_portfolio.parse({
      ...optimization,
      robustValidation: { mode: "holdout", trainFraction: 0.75, testFraction: 0.2, gap: 3 },
    }).robustValidation).toMatchObject({
      mode: "holdout",
      trainFraction: 0.75,
      testFraction: 0.2,
      gap: 3,
    });
    expect(resolvedPresetExecutionSchemas.optimize_portfolio.parse({
      ...optimization,
      robustValidation: {
        mode: "walk_forward", windowMode: "anchored", trainWindow: 84,
        testWindow: 21, step: 21, foldCount: 4, gap: 2, embargo: 5,
      },
    }).robustValidation).toMatchObject({
      mode: "walk_forward", windowMode: "anchored", trainWindow: 84,
      testWindow: 21, step: 21, foldCount: 4, gap: 2, embargo: 5,
    });
    expect(() => toolSchemas.optimize_portfolio.parse({
      ...optimization,
      robustValidation: { mode: "holdout", trainFraction: 0.8, testFraction: 0.3 },
    })).toThrow("inner train/test 비율 합계는 1 이하여야 합니다");
  });

  it("CAGR와 동일기간 누적수익률 목적함수를 직접 표현한다", () => {
    expect(toolSchemas.optimize_portfolio.safeParse({
      ...optimization,
      objective: "max_cagr",
    }).success).toBe(true);
    expect(toolSchemas.optimize_portfolio.safeParse({
      ...optimization,
      objective: "max_total_return",
    }).success).toBe(true);
  });
});

describe("exposure look-through schemas", () => {
  it("구성종목 메타데이터를 보존하고 100% 이하의 잔여 UNKNOWN을 허용한다", () => {
    const parsed = toolSchemas.analyze_portfolio_exposures.parse({
      assets: [{
        symbol: "ETF", weight: 1, currency: "USD", assetType: "ETF",
        constituents: [{
          symbol: "AAA", weight: 0.8, assetType: "STOCK", hedged: true,
          factors: { value: 0.4 },
        }],
      }],
    });
    expect(parsed.assets[0]?.constituents?.[0]).toMatchObject({
      assetType: "STOCK", hedged: true, factors: { value: 0.4 },
    });
    expect(parsed.executionMode).toBeUndefined();
    expect(toolSchemas.analyze_portfolio_exposures.parse({
      assets: [{ symbol: "AAA", weight: 1, currency: "USD" }],
      executionMode: "async",
    }).executionMode).toBe("async");
  });

  it("구성종목 비중 합계가 100%를 넘으면 거부한다", () => {
    expect(() => toolSchemas.analyze_portfolio_exposures.parse({
      assets: [{
        symbol: "ETF", weight: 1, currency: "USD",
        constituents: [{ symbol: "AAA", weight: 0.7 }, { symbol: "BBB", weight: 0.4 }],
      }],
    })).toThrow("구성종목 비중 합계는 1을 초과할 수 없습니다");
  });
});

describe("derived async execution schemas", () => {
  const id = "11111111-1111-4111-8111-111111111111";

  it("동기 기본값과 선택적 비동기 run 모드를 보존한다", () => {
    expect(toolSchemas.build_pareto_frontier.parse({ runId: id }).executionMode).toBeUndefined();
    expect(toolSchemas.build_pareto_frontier.parse({ runId: id, executionMode: "async" }).executionMode).toBe("async");
    expect(toolSchemas.generate_research_report.parse({ runId: id }).executionMode).toBeUndefined();
    expect(toolSchemas.generate_research_report.parse({ runId: id, executionMode: "async" }).executionMode).toBe("async");
  });
});

describe("outlook composite schema", () => {
  it("실제 ledger 민감도 기본 정책과 사용자 설정을 보존한다", () => {
    const defaults = toolSchemas.analyze_portfolio_outlook.parse({ baseConfig: base });
    expect(defaults.optimization.robustValidation).toMatchObject({
      enabled: true,
      mode: "walk_forward",
      windowMode: "rolling",
      foldCount: 5,
    });
    expect(defaults.sensitivity).toEqual({
      enabled: true,
      transactionCostShockBps: 25,
      includeZeroCashFlow: true,
      rebalanceModes: ["none", "quarterly"],
    });
    expect(defaults.marketRegime).toEqual({ enabled: true, lookback: 20 });
    const configured = toolSchemas.analyze_portfolio_outlook.parse({
      baseConfig: base,
      sensitivity: {
        enabled: true,
        transactionCostShockBps: 50,
        includeZeroCashFlow: false,
        rebalanceModes: ["monthly", "annually"],
      },
    });
    expect(configured.sensitivity.transactionCostShockBps).toBe(50);
  });

  it("Information Ratio 벤치마크와 과거정보 국면 설정을 검증한다", () => {
    expect(() => toolSchemas.analyze_portfolio_outlook.parse({
      baseConfig: base,
      optimization: { objective: "max_information_ratio" },
    })).toThrow();
    const configured = toolSchemas.analyze_portfolio_outlook.parse({
      baseConfig: base,
      optimization: { objective: "max_information_ratio", benchmark: "spy" },
      marketRegime: { enabled: true, lookback: 63 },
    });
    expect(configured.optimization.benchmark).toBe("SPY");
    expect(configured.marketRegime.lookback).toBe(63);
  });
});
