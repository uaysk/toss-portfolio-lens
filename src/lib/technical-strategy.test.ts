import { describe, expect, it } from "vitest";
import type { BacktestRunConfiguration } from "@/types";
import {
  MAX_TECHNICAL_STRATEGY_SYMBOLS,
  buildTechnicalStrategyEndpointRequest,
  createDefaultTechnicalStrategy,
  defaultTechnicalStrategyAnalysisSubset,
  normalizeTechnicalStrategyPresetConfig,
  reconcileTechnicalStrategySelection,
  subsetTechnicalStrategyAnalysis,
  technicalConditionDepth,
  technicalConditionNodeCount,
  technicalIndicatorReferenceOptions,
  technicalSignalStatusLabel,
  technicalStrategySourceMatchesBacktest,
  technicalStrategySubsetIssue,
  unwrapTechnicalStrategyRun,
  validateTechnicalStrategyDraft,
  type TechnicalCondition,
  type TechnicalStrategyAnalysis,
} from "./technical-strategy";

const analysis: TechnicalStrategyAnalysis = {
  symbols: ["AAA", "BBB"],
  fromDate: "2025-01-01",
  toDate: "2026-07-21",
  interval: "1d",
  adjusted: true,
  currencyMode: "KRW",
  responseMode: "full_series",
  indicators: [
    { id: "sma-primary", kind: "sma" },
    { id: "rsi-bbb", kind: "rsi", parameters: { period: 14 }, instrumentKeys: ["BBB"] },
  ],
};

function backtest(): BacktestRunConfiguration {
  return {
    assets: [{ symbol: "AAA", weight: 50 }, { symbol: "BBB", weight: 50 }],
    startDate: analysis.fromDate,
    endDate: analysis.toDate,
    initialAmount: 10_000_000,
    monthlyCashFlow: 0,
    cashFlowFrequency: "monthly",
    cashFlowTiming: "period_start",
    rebalanceFrequency: "annually",
    riskFreeRatePercent: 0,
    transactionCostBps: 0,
    currencyMode: "KRW",
    baseCurrency: "KRW",
    cashFlows: [],
    targetWeightSchedule: [{ date: "2026-01-02", weights: { AAA: 60, BBB: 40 }, cashTargetPercent: 0 }],
    execution: {
      cashTargetPercent: 0,
      quantityMode: "fractional",
      cashFlowRebalanceMode: "target_weights",
      tradeDatePolicy: "next_common_observation",
      cashAnnualYieldPercent: 0,
    },
    benchmark: "NONE",
  };
}

describe("technical strategy UI contract", () => {
  it("derives only indicator outputs available for each targeted instrument", () => {
    expect(technicalIndicatorReferenceOptions(analysis).map((option) => [option.instrumentKey, option.indicatorId, option.field])).toEqual([
      ["AAA", "sma-primary", "value"],
      ["BBB", "sma-primary", "value"],
      ["BBB", "rsi-bbb", "value"],
    ]);
  });

  it("accepts every typed operator and all three operand kinds without evaluating them", () => {
    const indicator = { type: "indicator" as const, instrumentKey: "AAA", indicatorId: "sma-primary", field: "value" };
    const bar = { type: "bar" as const, instrumentKey: "AAA", field: "close" as const };
    const constant = { type: "constant" as const, value: 50 };
    const conditions: TechnicalCondition[] = [
      { operator: "greater_than", left: indicator, right: constant },
      { operator: "less_than", left: bar, right: indicator },
      { operator: "crosses_above", left: indicator, right: bar },
      { operator: "crosses_below", left: bar, right: constant },
      { operator: "between", value: indicator, lower: { type: "constant", value: 30 }, upper: constant },
      { operator: "all", conditions: [{ operator: "greater_than", left: indicator, right: constant }] },
      { operator: "any", conditions: [{ operator: "less_than", left: bar, right: constant }] },
      { operator: "not", condition: { operator: "greater_than", left: indicator, right: constant } },
    ];
    for (const condition of conditions) {
      const strategy = { ...createDefaultTechnicalStrategy(analysis), entryCondition: condition };
      expect(validateTechnicalStrategyDraft(analysis, strategy), condition.operator).toEqual([]);
    }
  });

  it("counts recursive logical nodes and rejects invalid references and bounds", () => {
    const condition: TechnicalCondition = {
      operator: "all",
      conditions: [
        createDefaultTechnicalStrategy(analysis).entryCondition,
        { operator: "not", condition: { operator: "between", value: { type: "bar", instrumentKey: "AAA", field: "close" }, lower: { type: "constant", value: 10 }, upper: { type: "constant", value: 5 } } },
      ],
    };
    expect(technicalConditionNodeCount(condition)).toBe(4);
    expect(technicalConditionDepth(condition)).toBe(3);
    const errors = validateTechnicalStrategyDraft(analysis, { ...createDefaultTechnicalStrategy(analysis), entryCondition: condition });
    expect(errors).toContain("entryCondition.conditions[1].condition: between 하한은 상한보다 작아야 합니다.");
    expect(validateTechnicalStrategyDraft(analysis, {
      ...createDefaultTechnicalStrategy(analysis),
      exitCondition: {
        operator: "greater_than",
        left: { type: "indicator", instrumentKey: "AAA", indicatorId: "rsi-bbb", field: "value" },
        right: { type: "constant", value: 50 },
      },
    })[0]).toContain("선택한 종목·지표에 없는 출력 참조");
  });

  it("requires both state allocations to contain exactly every symbol and total 100%", () => {
    const valid = createDefaultTechnicalStrategy(analysis, { AAA: 60, BBB: 30 });
    expect(valid.allocations.active).toEqual({ weights: { AAA: 60, BBB: 30 }, cashPercent: 10 });
    expect(valid.allocations.inactive).toEqual({ weights: { AAA: 0, BBB: 0 }, cashPercent: 100 });
    expect(validateTechnicalStrategyDraft(analysis, valid)).toEqual([]);
    expect(validateTechnicalStrategyDraft(analysis, {
      ...valid,
      allocations: { ...valid.allocations, active: { weights: { AAA: 80, BBB: 30 }, cashPercent: 0 } },
    })).toContain("active 종목 비중과 현금 비중 합계는 100%여야 합니다.");
  });

  it("subsets a chart universe explicitly and never truncates a 21-symbol strategy", () => {
    const large: TechnicalStrategyAnalysis = {
      ...analysis,
      symbols: Array.from({ length: MAX_TECHNICAL_STRATEGY_SYMBOLS + 1 }, (_, index) => `T${String(index).padStart(2, "0")}`),
      indicators: [{ id: "sma-primary", kind: "sma" }],
    };
    expect(subsetTechnicalStrategyAnalysis(large, large.symbols)).toBeUndefined();
    expect(subsetTechnicalStrategyAnalysis(large, large.symbols.slice(0, 20))?.symbols).toEqual(large.symbols.slice(0, 20));
    expect(subsetTechnicalStrategyAnalysis(analysis, ["BBB"])?.indicators).toEqual([
      { id: "sma-primary", kind: "sma" },
      { id: "rsi-bbb", kind: "rsi", parameters: { period: 14 } },
    ]);
  });

  it("벤치마크 의존 종목 없는 subset을 거부하고 기본 20종목에는 의존 종목을 포함한다", () => {
    const symbols = Array.from({ length: 21 }, (_, index) => `T${String(index).padStart(2, "0")}`);
    const benchmarkAnalysis: TechnicalStrategyAnalysis = {
      ...analysis,
      symbols,
      indicators: [{
        id: "relative-primary",
        kind: "benchmark_relative_strength",
        parameters: { benchmark_key: "T20" },
      }],
    };
    expect(technicalStrategySubsetIssue(benchmarkAnalysis, symbols.slice(0, 20)))
      .toBe("벤치마크 상대강도 계산에 필요한 T20 종목을 전략 선택에 포함해 주세요.");
    expect(subsetTechnicalStrategyAnalysis(benchmarkAnalysis, symbols.slice(0, 20))).toBeUndefined();
    const defaultSubset = defaultTechnicalStrategyAnalysisSubset(benchmarkAnalysis);
    expect(defaultSubset?.symbols).toHaveLength(20);
    expect(defaultSubset?.symbols).toContain("T20");
    expect(defaultSubset?.indicators[0].parameters?.benchmark_key).toBe("T20");
  });

  it("chart universe 변경 시 선택은 교집합만 유지하고 새 종목을 자동 추가하지 않는다", () => {
    expect(reconcileTechnicalStrategySelection(["OLD", "BBB", "BBB", "AAA"], ["AAA", "BBB", "NEW"]))
      .toEqual(["BBB", "AAA"]);
    expect(reconcileTechnicalStrategySelection(["PRESET-ONLY"], ["AAA", "NEW"]))
      .toEqual([]);
  });

  it("signal 처리 상태를 예정·적용·안전 거래일 없음으로 구분한다", () => {
    expect(technicalSignalStatusLabel("planned")).toBe("거래 예정");
    expect(technicalSignalStatusLabel("applied")).toBe("ledger 적용");
    expect(technicalSignalStatusLabel("no_safe_trade_date")).toBe("안전 거래일 없음");
  });

  it("source warm-up 시작은 허용하지만 종료일은 backtest와 정확히 일치해야 한다", () => {
    const input = { symbols: ["AAA", "BBB"], startDate: "2025-02-01", endDate: analysis.toDate, currencyMode: "KRW" as const };
    expect(technicalStrategySourceMatchesBacktest(analysis, input)).toBe(true);
    expect(technicalStrategySourceMatchesBacktest(analysis, { ...input, endDate: "2026-07-20" })).toBe(false);
    expect(technicalStrategySourceMatchesBacktest({ ...analysis, fromDate: "2025-03-01" }, input)).toBe(false);
  });

  it("round-trips a hostile-safe technical signal preset and rejects unknown or oversized content", () => {
    const strategy = createDefaultTechnicalStrategy(analysis);
    const config = { schemaVersion: 1, presetType: "technical_signal_strategy", analysis, strategy };
    expect(normalizeTechnicalStrategyPresetConfig(config)).toEqual(config);
    expect(normalizeTechnicalStrategyPresetConfig({ ...config, strategy: { ...strategy, entryCondition: { operator: "made_up" } } })).toBeUndefined();
    expect(normalizeTechnicalStrategyPresetConfig({ ...config, analysis: { ...analysis, symbols: Array.from({ length: 21 }, (_, index) => `X${index}`) } })).toBeUndefined();
    expect(normalizeTechnicalStrategyPresetConfig({ ...config, strategy: { ...strategy, allocations: { ...strategy.allocations, active: { weights: { AAA: 100 }, cashPercent: 0 } } } })).toBeUndefined();
  });

  it("builds the combined endpoint body and does not let the browser provide a competing schedule", () => {
    const strategy = createDefaultTechnicalStrategy(analysis);
    const request = buildTechnicalStrategyEndpointRequest({ analysis, strategy, backtest: backtest() });
    expect(request).toEqual({
      analysis,
      strategy,
      backtest: expect.objectContaining({ rebalanceFrequency: "none", targetWeightSchedule: [] }),
    });
    expect(request.strategy).not.toHaveProperty("active_when");
    expect(request.strategy.entryCondition).toBe(strategy.entryCondition);
  });

  it("preserves the four server dates and a null application date without client projection", () => {
    const raw = {
      result: {
        run_id: "run-1",
        technical_strategy: {
          signals: [{
            signal_id: "signal-1",
            calculation_date: "2026-07-17",
            signal_date: "2026-07-17",
            planned_trade_date: "2026-07-20",
            actual_application_date: null,
            from_state: "inactive",
            to_state: "active",
            target_weights: { AAA: 50, BBB: 50 },
            cash_target_percent: 0,
            status: "planned",
          }],
        },
      },
    };
    const payload = unwrapTechnicalStrategyRun(raw);
    expect(payload?.technical_strategy.signals[0]).toEqual(raw.result.technical_strategy.signals[0]);
    expect(payload?.technical_strategy.signals[0].actual_application_date).toBeNull();
  });
});
