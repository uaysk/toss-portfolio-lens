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
    expect(parsed).toMatchObject({
      targetWeightSchedule: [{
        weights: { AAA: 20, BBB: 70 },
        cashTargetPercent: 10,
        regime: "risk_off",
      }],
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
    expect(parsed).toMatchObject({
      realism: { enforcePointInTimeUniverse: true },
    });
  });
});

describe("technical analysis schema", () => {
  const request = {
    symbols: ["aaa", "BBB"],
    fromDate: "2024-01-01",
    toDate: "2024-12-31",
    interval: "1d",
    adjusted: true,
    currencyMode: "KRW",
    responseMode: "full_series",
    indicators: [
      { id: "sma-main", kind: "sma", parameters: { period: 20 }, instrumentKeys: ["aaa", "BBB"] },
    ],
  } as const;

  it("공개 batch 입력을 strict하게 정규화하고 31개 exact kind만 허용한다", () => {
    const parsed = toolSchemas.analyze_technical_signals.parse(request);
    expect(parsed.symbols).toEqual(["AAA", "BBB"]);
    expect(parsed).toMatchObject({
      indicators: [{ instrumentKeys: ["AAA", "BBB"] }],
    });
    expect(toolSchemas.analyze_technical_signals.safeParse({
      ...request,
      indicators: [{ id: "unknown", kind: "not_an_indicator" }],
    }).success).toBe(false);
    expect(toolSchemas.analyze_technical_signals.safeParse({ ...request, unexpected: true }).success).toBe(false);
  });

  it("기간·중복 symbol/id·instrument 범위와 primitive parameter를 검증한다", () => {
    expect(toolSchemas.analyze_technical_signals.safeParse({ ...request, fromDate: "2025-01-01" }).success).toBe(false);
    expect(toolSchemas.analyze_technical_signals.safeParse({ ...request, symbols: ["aaa", "AAA"] }).success).toBe(false);
    expect(toolSchemas.analyze_technical_signals.safeParse({
      ...request,
      indicators: [{ id: "same", kind: "sma" }, { id: "same", kind: "ema" }],
    }).success).toBe(false);
    expect(toolSchemas.analyze_technical_signals.safeParse({
      ...request,
      indicators: [{ id: "sma-main", kind: "sma", instrumentKeys: ["MISSING"] }],
    }).success).toBe(false);
    expect(toolSchemas.analyze_technical_signals.safeParse({
      ...request,
      indicators: [{ id: "sma-main", kind: "sma", parameters: { period: { invalid: true } } }],
    }).success).toBe(false);
  });

  it("Volume Profile은 한 종목·한 정의로만 허용하고 focused target을 정규화한다", () => {
    const focused = {
      ...request,
      symbols: ["aaa"],
      indicators: [{ id: "profile", kind: "volume_profile", instrumentKeys: ["aaa"] }],
    } as const;
    expect(toolSchemas.analyze_technical_signals.parse(focused)).toMatchObject({
      symbols: ["AAA"],
      indicators: [{ kind: "volume_profile", instrumentKeys: ["AAA"] }],
    });
    expect(toolSchemas.analyze_technical_signals.safeParse({
      ...request,
      indicators: [{ id: "profile", kind: "volume_profile" }],
    }).success).toBe(false);
    expect(toolSchemas.analyze_technical_signals.safeParse({
      ...focused,
      indicators: [{ id: "profile-a", kind: "volume_profile" }, { id: "profile-b", kind: "volume_profile" }],
    }).success).toBe(false);
    expect(toolSchemas.analyze_technical_signals.safeParse({
      ...focused,
      indicators: [{ id: "profile", kind: "volume_profile" }, { id: "sma", kind: "sma" }],
    }).success).toBe(false);
  });

  it("run 목록에서 technical_analysis kind를 필터링할 수 있다", () => {
    expect(toolSchemas.list_runs.parse({ kinds: ["technical_analysis"] }).kinds).toEqual(["technical_analysis"]);
  });
});

describe("technical signal strategy schemas", () => {
  const condition = {
    operator: "crosses_above",
    left: { type: "indicator", instrumentKey: "AAA", indicatorId: "sma-main", field: "value" },
    right: { type: "constant", value: 10 },
  } as const;
  const strategyRequest = {
    analysis: {
      symbols: ["AAA"],
      fromDate: "2023-01-01",
      toDate: "2024-12-31",
      interval: "1d",
      adjusted: true,
      currencyMode: "KRW",
      responseMode: "full_series",
      indicators: [{ id: "sma-main", kind: "sma", parameters: { period: 20 } }],
    },
    strategy: {
      schemaVersion: "technical-strategy/v1",
      id: "trend-main",
      entryCondition: condition,
      exitCondition: {
        operator: "less_than",
        left: { type: "bar", instrumentKey: "AAA", field: "close" },
        right: { type: "constant", value: 8 },
      },
      minimumHoldingPeriod: 2,
      cooldownPeriod: 1,
      initialState: "inactive",
      allocations: {
        active: { weights: { AAA: 100 }, cashPercent: 0 },
        inactive: { weights: { AAA: 0 }, cashPercent: 100 },
      },
    },
  } as const;
  const technicalBacktest = {
    assets: [{ symbol: "AAA", weight: 0 }],
    startDate: "2024-01-01",
    endDate: "2024-12-31",
    initialAmount: 1_000_000,
    monthlyCashFlow: 0,
    rebalanceFrequency: "none",
    benchmark: "NONE",
    currencyMode: "KRW",
    execution: { cashTargetPercent: 100 },
  } as const;

  it("signal-only와 cash-only 초기 combined 전략을 허용하고 preset-only 실행도 표현한다", () => {
    expect(toolSchemas.analyze_technical_signals.safeParse(strategyRequest).success).toBe(true);
    expect(toolSchemas.run_technical_strategy_backtest.safeParse({ ...strategyRequest, backtest: technicalBacktest }).success).toBe(true);
    expect(toolSchemas.run_portfolio_backtest.safeParse(technicalBacktest).success).toBe(true);
    const presetId = "00000000-0000-4000-8000-000000000888";
    expect(toolSchemas.analyze_technical_signals.safeParse({ presetId }).success).toBe(true);
    expect(toolSchemas.validate_technical_strategy.safeParse({ presetId }).success).toBe(true);
    expect(toolSchemas.run_technical_strategy_backtest.safeParse({ presetId }).success).toBe(true);
    expect(toolSchemas.list_runs.parse({ kinds: ["technical_strategy"] }).kinds).toEqual(["technical_strategy"]);
  });

  it("정의되지 않은 지표·field·instrument와 Volume Profile 조건 참조를 거부한다", () => {
    const withOperand = (left: Record<string, unknown>, indicators = strategyRequest.analysis.indicators) => ({
      ...strategyRequest,
      analysis: { ...strategyRequest.analysis, indicators },
      strategy: { ...strategyRequest.strategy, entryCondition: { operator: "greater_than", left, right: { type: "constant", value: 1 } } },
    });
    expect(toolSchemas.analyze_technical_signals.safeParse(withOperand({ type: "indicator", instrumentKey: "AAA", indicatorId: "missing", field: "value" })).success).toBe(false);
    expect(toolSchemas.analyze_technical_signals.safeParse(withOperand({ type: "indicator", instrumentKey: "AAA", indicatorId: "sma-main", field: "histogram" })).success).toBe(false);
    expect(toolSchemas.analyze_technical_signals.safeParse(withOperand({ type: "bar", instrumentKey: "MISSING", field: "close" })).success).toBe(false);
    expect(toolSchemas.analyze_technical_signals.safeParse(withOperand(
      { type: "indicator", instrumentKey: "AAA", indicatorId: "profile", field: "point_of_control" },
      [{ id: "profile", kind: "volume_profile" }] as never,
    )).success).toBe(false);
  });

  it("조건 깊이·전체 노드·allocation exact 합계를 제한한다", () => {
    let deep: Record<string, unknown> = strategyRequest.strategy.exitCondition;
    for (let index = 0; index < 17; index += 1) deep = { operator: "not", condition: deep };
    expect(toolSchemas.analyze_technical_signals.safeParse({
      ...strategyRequest,
      strategy: { ...strategyRequest.strategy, entryCondition: deep },
    }).success).toBe(false);
    expect(toolSchemas.analyze_technical_signals.safeParse({
      ...strategyRequest,
      strategy: {
        ...strategyRequest.strategy,
        entryCondition: { operator: "all", conditions: Array.from({ length: 255 }, () => strategyRequest.strategy.exitCondition) },
      },
    }).success).toBe(false);
    expect(toolSchemas.analyze_technical_signals.safeParse({
      ...strategyRequest,
      strategy: {
        ...strategyRequest.strategy,
        allocations: { ...strategyRequest.strategy.allocations, inactive: { weights: { AAA: 1 }, cashPercent: 100 } },
      },
    }).success).toBe(false);
  });

  it("사용자 target schedule·정기 rebalance·report와 분석/ledger 불일치를 거부한다", () => {
    const combined = { ...strategyRequest, backtest: technicalBacktest };
    expect(toolSchemas.run_technical_strategy_backtest.safeParse({
      ...combined,
      backtest: { ...technicalBacktest, targetWeightSchedule: [{ date: "2024-02-01", weights: { AAA: 100 }, cashTargetPercent: 0 }] },
    }).success).toBe(false);
    expect(toolSchemas.run_technical_strategy_backtest.safeParse({
      ...combined, backtest: { ...technicalBacktest, rebalanceFrequency: "monthly" },
    }).success).toBe(false);
    expect(toolSchemas.run_technical_strategy_backtest.safeParse({
      ...combined, backtest: { ...technicalBacktest, report: { enabled: true } },
    }).success).toBe(false);
    expect(toolSchemas.run_technical_strategy_backtest.safeParse({
      ...combined, analysis: { ...strategyRequest.analysis, adjusted: false },
    }).success).toBe(false);
    expect(toolSchemas.run_technical_strategy_backtest.safeParse({
      ...combined,
      backtest: { ...technicalBacktest, assets: [{ symbol: "AAA", weight: 100 }], execution: { cashTargetPercent: 0 } },
    }).success).toBe(false);
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
