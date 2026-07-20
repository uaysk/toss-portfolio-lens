import { describe, expect, it, vi } from "vitest";
import { backtestArtifacts } from "./backtest-artifacts.js";
import {
  TECHNICAL_STRATEGY_SCHEMA_VERSION,
  TechnicalStrategyWorkerResultSchema,
  type TechnicalStrategyWorkerResult,
} from "./technical-strategy-contract.js";
import {
  TechnicalStrategyService,
  technicalStrategyDataRevision,
  type TechnicalSignalAnalysisRequest,
  type TechnicalStrategyBacktestRequest,
  type TechnicalStrategyCondition,
} from "./technical-strategy-service.js";

const analysis = {
  symbols: ["AAA"],
  fromDate: "2024-01-01",
  toDate: "2024-01-03",
  interval: "1d",
  adjusted: true,
  currencyMode: "KRW",
  responseMode: "full_series",
  indicators: [{ id: "sma-main", kind: "sma", parameters: { period: 1 } }],
} as const;

const strategy = {
  schemaVersion: TECHNICAL_STRATEGY_SCHEMA_VERSION,
  id: "trend-main",
  entryCondition: {
    operator: "all",
    conditions: [
      {
        operator: "crosses_above",
        left: { type: "indicator", instrumentKey: "AAA", indicatorId: "sma-main", field: "value" },
        right: { type: "constant", value: 10 },
      },
      {
        operator: "not",
        condition: {
          operator: "between",
          value: { type: "bar", instrumentKey: "AAA", field: "close" },
          lower: { type: "constant", value: 0 },
          upper: { type: "constant", value: 5 },
        },
      },
    ],
  },
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
} as const;

const calculation = {
  instrument_key: "AAA",
  indicator_id: "sma-main",
  kind: "sma",
  parameters: { period: 1 },
  availability: { status: "available", reason: "calculated" },
  warmup: { required_observations: 1, observed_observations: 3, state: "ready", first_available_date: "2024-01-01" },
  points: [
    { date: "2024-01-01", state: "available", values: { value: 9 } },
    { date: "2024-01-02", state: "available", values: { value: 11 } },
    { date: "2024-01-03", state: "available", values: { value: 12 } },
  ],
} as const;

const technicalAnalysisResult = {
  schema_version: "technical-analysis-result/v1",
  indicator_engine_version: "technical-indicators/1.5.0",
  response_mode: "full_series",
  adjustment_policy: "adjusted",
  calculations: [calculation],
  diagnostics: { validation: "passed" },
} as const;

const diagnostics = {
  validation: "passed",
  condition_value_policy: "unknown_is_false",
  between_policy: "inclusive",
  crossing_policy: "previous_and_current_available",
  signal_timing_policy: "next_safe_trade_date",
  safe_trade_date_source: "common_observation_dates",
  evaluation_start_date: "2024-01-01",
  evaluation_end_date: "2024-01-03",
  safe_trade_date_count: 3,
  condition_node_count: 7,
  active_unknown_count: 0,
  inactive_unknown_count: 0,
  minimum_holding_suppressed_count: 0,
  cooldown_suppressed_count: 0,
  pending_suppressed_count: 0,
} as const;

function strategyResult(mode: "signal_only" | "backtest"): TechnicalStrategyWorkerResult {
  const applied = mode === "backtest";
  const signal = {
    signal_id: "signal-1",
    transition: "activate" as const,
    calculation_date: "2024-01-02",
    signal_date: "2024-01-02",
    planned_trade_date: "2024-01-03",
    actual_application_date: applied ? "2024-01-03" : null,
    from_state: "inactive" as const,
    to_state: "active" as const,
    target_weights: { AAA: 100 },
    cash_target_percent: 0,
    status: applied ? "applied" as const : "planned" as const,
  };
  const technicalStrategy = {
    schema_version: "technical-strategy-result/v1" as const,
    strategy_schema_version: TECHNICAL_STRATEGY_SCHEMA_VERSION,
    initial_state: "inactive" as const,
    signals: [signal],
    target_weight_schedule: [{
      date: "2024-01-03",
      weights: { AAA: 100 },
      cashTargetPercent: 0,
      regime: "active",
      action: "signal-1",
    }],
    diagnostics,
  };
  if (!applied) return { technical_analysis: technicalAnalysisResult, technical_strategy: technicalStrategy };
  return {
    technical_analysis: technicalAnalysisResult,
    technical_strategy: technicalStrategy,
    backtest: {
      generatedAt: "2024-01-04T00:00:00.000Z",
      baseCurrency: "KRW",
      currencyMethod: "KRW_FX_CONVERTED",
      config: {
        assets: [{ symbol: "AAA", weight: 0, lotSize: 1 }],
        startDate: "2024-01-01", endDate: "2024-01-03", initialAmount: 1_000_000,
        monthlyCashFlow: 0, cashFlowFrequency: "monthly", cashFlowTiming: "period_start",
        rebalanceFrequency: "none", riskFreeRatePercent: 0, transactionCostBps: 0,
        cashFlows: [], targetWeightSchedule: [],
        execution: {
          cashTargetPercent: 100, quantityMode: "fractional", cashFlowRebalanceMode: "target_weights",
          tradeDatePolicy: "next_common_observation", cashAnnualYieldPercent: 0,
        },
        realism: {}, currencyMode: "KRW", baseCurrency: "KRW", benchmark: "NONE",
        requestedStartDate: "2024-01-01", latestMetadataListDate: "2020-01-01",
        effectiveStartDate: "2024-01-01", effectiveEndDate: "2024-01-03",
      },
      assets: [{ symbol: "AAA", name: "Alpha", market: "TEST", currency: "KRW", listDate: "2020-01-01", weight: 0 }],
      warnings: [],
      requestedStartDate: "2024-01-01",
      effectiveStartDate: "2024-01-01",
      endDate: "2024-01-03",
      metrics: {
        totalReturnPercent: 1, cagrPercent: 1, annualizedVolatilityPercent: 0,
        maxDrawdownPercent: 0, maxDrawdownDays: 0, sharpeRatio: null, sortinoRatio: null,
        calmarRatio: null, bestDailyReturnPercent: 1, worstDailyReturnPercent: 1,
        positiveDaysPercent: 100, bestYearPercent: 1, worstYearPercent: 1, positiveMonthsPercent: 100,
        finalBalance: 1_010_000, totalContributions: 1_000_000, totalWithdrawals: 0,
        endingCashBalance: 0, endingCashWeightPercent: 0, investedBalance: 1_010_000,
        totalTransactionCosts: 0, totalDividendIncome: 0, totalDividendTaxes: 0,
        netProfitLoss: 10_000, moneyWeightedReturnPercent: 1,
      },
      points: [{
        date: "2024-01-03", balance: 1_010_000, growth: 1.01, drawdownPercent: 0,
        investedBalance: 1_010_000, cashBalance: 0, unitPrice: 101,
      }],
      annualReturns: [{ year: 2024, returnPercent: 1 }],
      contributions: [{
        symbol: "AAA", name: "Alpha", market: "TEST", currency: "KRW", weight: 0,
        endingValue: 1_010_000, profitLoss: 10_000, contributionPercent: 1,
        timeLinkedContributionPercent: 1, localPriceContributionPercent: 1, fxContributionPercent: 0,
        upRegimeContributionPercent: 1, downRegimeContributionPercent: 0, assetReturnPercent: 1,
      }],
      trades: [],
      cashFlows: [],
      dividends: [],
      execution: {
        cashTargetPercent: 100, quantityMode: "fractional", cashFlowRebalanceMode: "target_weights",
        tradeDatePolicy: "next_common_observation", cashAnnualYieldPercent: 0,
      },
      dataQuality: {
        alignmentPolicy: "carry_forward_for_valuation", commonReturnPolicy: "inner_join",
        alignedValuationDays: 3, commonReturnObservations: 2, carryForwardByAsset: [{ symbol: "AAA", count: 0 }],
        benchmarkCarryForwardCount: 0, dividendStatus: "adjusted_price_policy", liquidityStatus: "not_requested",
        liquidityTradeObservations: 0, missingLiquidityObservations: 0,
        pointInTimeUniverseStatus: "not_enforced", warnings: [], instrumentDateConsistency: [],
      },
      correlations: { assets: [], values: [] },
      advanced: {
        rolling: [],
        drawdowns: {
          points: [{ date: "2024-01-03", drawdownPercent: 0 }], episodes: [], currentUnderwaterDays: 0,
          averageDrawdownPercent: 0, ulcerIndex: 0, worst20DayReturnPercent: null, worst60DayReturnPercent: null,
        },
        tailRisk: {
          historicalVar95Percent: null, expectedShortfall95Percent: null, lossDaysPercent: 0,
          averageGainPercent: 1, averageLossPercent: null, gainLossRatio: null, skewness: null,
          excessKurtosis: null, maxConsecutiveGainDays: 1, maxConsecutiveLossDays: 0,
        },
        riskContributions: [], monthlyReturns: [{ month: "2024-01", returnPercent: 1 }],
        exposure: {
          krwWeightPercent: 100, usdWeightPercent: 0, domesticWeightPercent: 100, overseasWeightPercent: 0,
          top1WeightPercent: 100, top5WeightPercent: 100, top10WeightPercent: 100, hhi: 1,
          effectivePositions: 1, diversificationBenefitPercent: 0,
        },
        costEfficiency: {
          transactionCostBps: 0, turnoverPercent: 0, totalTradedAmount: 0, ongoingTradedAmount: 0,
          estimatedTotalCost: 0, actualTotalCost: 0, costDragPercent: 0, grossReturnPercent: 1,
          netEstimatedReturnPercent: 1, netReturnPercent: 1, costsDeductedFromPath: true,
          method: "actual_path_deduction", averageTradeAmount: null, buySellAmountRatio: null,
          tradeCount: 0, monthly: [],
        },
        tradeBehavior: {
          estimatedRealizedProfitLoss: 0, estimatedWinRatePercent: null, estimatedProfitFactor: null,
          estimatedAverageHoldingDays: null, matchedSellCount: 0, unmatchedSellCount: 0, buyCount: 0, sellCount: 0,
        },
        dataQuality: {
          confidence: "limited", observationDays: 3, returnObservationDays: 2, requestedCalendarDays: 3,
          effectiveStartDate: "2024-01-01", effectiveEndDate: "2024-01-03", commonCoveragePercent: 100,
          carriedForwardObservations: 0, benchmarkObservations: 0, assets: [], notes: [],
        },
      },
      targetWeightSchedule: [{
        scheduledDate: "2024-01-03",
        effectiveDate: "2024-01-03",
        weights: { AAA: 100 },
        cashTargetPercent: 0,
        regime: "active",
        action: "signal-1",
      }],
    },
  };
}

function workerOutput(result: TechnicalStrategyWorkerResult) {
  return {
    result,
    summary: { signal_count: 1 },
    warnings: [],
    artifacts: [
      ...(result.backtest ? backtestArtifacts(result.backtest) : []).map((artifact) => ({
        type: artifact.type,
        content: artifact.content,
        row_count: artifact.rowCount,
      })),
      { type: "technical-indicators", content: result.technical_analysis.calculations, row_count: 1 },
      { type: "technical-signals", content: result.technical_strategy.signals, row_count: 1 },
      {
        type: "technical-diagnostics",
        content: { indicator: result.technical_analysis.diagnostics, strategy: result.technical_strategy.diagnostics },
        row_count: 1,
      },
      {
        type: "worker-metrics",
        content: {
          compute_ms: 2,
          engine: "portfolio-lens-rust-2026.07.5",
          ipc: "unix_domain_socket_length_frame_v2",
          cancellation: "peer_disconnect_cooperative_checkpoints",
        },
        row_count: 1,
      },
    ],
  };
}

function harness(mode: "signal_only" | "backtest" = "signal_only") {
  const result = strategyResult(mode);
  const prepared = {
    normalized: { publicRequest: analysis, workerIndicators: [{ id: "sma-main", kind: "sma", parameters: { period: 1 } }] },
    orderedSeries: [],
    instruments: [{
      key: "AAA", symbol: "AAA", market: "TEST", currency: "KRW", instrument_type: "stock",
      bars: [
        { date: "2024-01-01", open: 9, high: 10, low: 8, close: 9, volume: null },
        { date: "2024-01-02", open: 11, high: 12, low: 10, close: 11, volume: null },
        { date: "2024-01-03", open: 12, high: 13, low: 11, close: 12, volume: null },
      ],
    }],
    payload: { technical_analysis: { schema_version: "technical-analysis/v1", response_mode: "full_series", adjustment_policy: "adjusted", instruments: [], indicators: [] } },
    dataRevision: "technical-data-revision",
    marketWarnings: [],
    workUnits: 3,
    effectivePeriod: { from: "2024-01-01", to: "2024-01-03" },
  };
  const technicalAnalysis = {
    prepare: vi.fn().mockResolvedValue(prepared),
    safeTradeDates: vi.fn().mockResolvedValue(["2024-01-01", "2024-01-02", "2024-01-03"]),
  };
  const rustCompute = { compute: vi.fn().mockResolvedValue(workerOutput(result)) };
  const artifacts = { list: vi.fn().mockResolvedValue([{ type: "technical-signals" }]) };
  const runs = {
    executionMode: "rust_socket",
    execute: vi.fn(async (input: Record<string, any>) => {
      const completed = await input.task({
        throwIfCancelled: vi.fn().mockResolvedValue(undefined),
        signal: new AbortController().signal,
      });
      return {
        run: {
          id: mode === "backtest" ? "strategy-backtest-run" : "signal-run",
          dataRevision: input.dataRevision,
          result: completed.result,
          warnings: completed.warnings,
        },
        reused: false,
      };
    }),
  };
  const backtestEngine = {
    prepare: vi.fn().mockResolvedValue({ simulation: { prices: { AAA: [] }, observedDates: ["2024-01-03"] }, responseContext: { assets: [] } }),
  };
  const backtests = {
    validate: vi.fn().mockResolvedValue({ result: { valid: true, errors: [] }, warnings: [] }),
  };
  const marketData = {
    getDataAvailability: vi.fn().mockResolvedValue({
      dataRevision: "availability-revision",
      commonPeriod: { from: "2024-01-01", to: "2024-01-03" },
      commonObservations: 3,
      assets: [],
    }),
  };
  return {
    service: new TechnicalStrategyService(
      technicalAnalysis as never,
      backtestEngine as never,
      backtests as never,
      marketData as never,
      runs as never,
      artifacts as never,
      rustCompute as never,
    ),
    technicalAnalysis,
    backtestEngine,
    backtests,
    marketData,
    runs,
    rustCompute,
  };
}

const backtest = {
  assets: [{ symbol: "AAA", weight: 0 }],
  startDate: "2024-01-01",
  endDate: "2024-01-03",
  initialAmount: 1_000_000,
  monthlyCashFlow: 0,
  rebalanceFrequency: "none",
  benchmark: "NONE",
  currencyMode: "KRW",
  execution: { cashTargetPercent: 100 },
} as const;

describe("TechnicalStrategyService", () => {
  it("combined trust boundary는 finalized backtest 필수 shape와 signal↔technical↔ledger schedule allocation parity를 강제한다", () => {
    const valid = strategyResult("backtest");
    expect(TechnicalStrategyWorkerResultSchema.safeParse(valid).success).toBe(true);

    const missingConfig = structuredClone(valid) as Record<string, any>;
    delete missingConfig.backtest.config;
    expect(TechnicalStrategyWorkerResultSchema.safeParse(missingConfig).success).toBe(false);

    const incompleteMetrics = structuredClone(valid) as Record<string, any>;
    incompleteMetrics.backtest.metrics = { finalBalance: 1_010_000 };
    expect(TechnicalStrategyWorkerResultSchema.safeParse(incompleteMetrics).success).toBe(false);

    const technicalMismatch = structuredClone(valid) as Record<string, any>;
    technicalMismatch.technical_strategy.target_weight_schedule[0].weights.AAA = 0;
    expect(TechnicalStrategyWorkerResultSchema.safeParse(technicalMismatch).success).toBe(false);

    const ledgerMismatch = structuredClone(valid) as Record<string, any>;
    ledgerMismatch.backtest.targetWeightSchedule[0].weights.AAA = 0;
    expect(TechnicalStrategyWorkerResultSchema.safeParse(ledgerMismatch).success).toBe(false);

    const stateMismatch = structuredClone(valid) as Record<string, any>;
    stateMismatch.backtest.targetWeightSchedule[0].regime = "inactive";
    expect(TechnicalStrategyWorkerResultSchema.safeParse(stateMismatch).success).toBe(false);

    const duplicates = structuredClone(valid) as Record<string, any>;
    duplicates.technical_strategy.signals.push(structuredClone(duplicates.technical_strategy.signals[0]));
    duplicates.technical_strategy.target_weight_schedule.push(structuredClone(duplicates.technical_strategy.target_weight_schedule[0]));
    duplicates.backtest.targetWeightSchedule.push(structuredClone(duplicates.backtest.targetWeightSchedule[0]));
    expect(TechnicalStrategyWorkerResultSchema.safeParse(duplicates).success).toBe(false);

    const latestSummary = structuredClone(valid) as Record<string, any>;
    latestSummary.technical_analysis.response_mode = "latest_summary";
    for (const item of latestSummary.technical_analysis.calculations) {
      item.latest = item.points.at(-1);
      delete item.points;
    }
    expect(TechnicalStrategyWorkerResultSchema.safeParse(latestSummary).success).toBe(false);
  });

  it("resolved asset metadata 변경은 data revision을 바꾸되 전략 config 자체는 revision에 섞지 않는다", () => {
    const market = { prices: { AAA: [] }, observedDates: ["2024-01-03"] };
    const first = technicalStrategyDataRevision({
      technical_data_revision: "technical-data",
      simulation_market_inputs: { ...market, assets: [{ symbol: "AAA", name: "Alpha", market: "KRX", currency: "KRW", listDate: "2020-01-01" }] },
    });
    const metadataChanged = technicalStrategyDataRevision({
      technical_data_revision: "technical-data",
      simulation_market_inputs: { ...market, assets: [{ symbol: "AAA", name: "Alpha renamed", market: "KRX", currency: "KRW", listDate: "2020-01-01" }] },
    });
    const sameData = technicalStrategyDataRevision({
      technical_data_revision: "technical-data",
      simulation_market_inputs: { ...market, assets: [{ symbol: "AAA", name: "Alpha", market: "KRX", currency: "KRW", listDate: "2020-01-01" }] },
    });
    expect(metadataChanged).not.toBe(first);
    expect(sameData).toBe(first);
  });

  it("signal-only 요청을 exact snake_case 단일 batch로 변환하고 config와 data revision을 분리한다", async () => {
    const { service, technicalAnalysis, runs, rustCompute } = harness();
    const request: TechnicalSignalAnalysisRequest = { analysis: analysis as never, strategy: strategy as never };

    const first = await service.analyzeSignals({ ownerSubject: "owner-a", request });
    await service.analyzeSignals({
      ownerSubject: "owner-a",
      request: { ...request, strategy: { ...request.strategy, minimumHoldingPeriod: 9 } },
    });

    expect(technicalAnalysis.prepare).toHaveBeenCalledTimes(2);
    expect(technicalAnalysis.safeTradeDates).toHaveBeenCalledTimes(2);
    const [, payload] = vi.mocked(rustCompute.compute).mock.calls[0]!;
    expect(payload).toMatchObject({
      strategy: {
        schema_version: "technical-strategy/v1",
        initial_state: "inactive",
        minimum_holding_period: 2,
        cooldown_period: 1,
        active_when: {
          operator: "all",
          conditions: [
            {
              operator: "crosses_above",
              left: { type: "indicator", instrument_key: "AAA", indicator_id: "sma-main", field: "value" },
            },
            {
              operator: "not",
              condition: { operator: "between", value: { type: "bar", instrument_key: "AAA", field: "close" } },
            },
          ],
        },
        allocations: {
          active: { weights: { AAA: 100 }, cash_target_percent: 0 },
          inactive: { weights: { AAA: 0 }, cash_target_percent: 100 },
        },
      },
      safe_trade_dates: ["2024-01-01", "2024-01-02", "2024-01-03"],
      evaluation_start_date: "2024-01-01",
      evaluation_end_date: "2024-01-03",
    });
    expect((payload as Record<string, unknown>).simulation).toBeUndefined();
    expect((payload as { strategy: Record<string, unknown> }).strategy).not.toHaveProperty("id");
    const executions = vi.mocked(runs.execute).mock.calls.map(([input]) => input as Record<string, any>);
    expect(executions[0]!.dataRevision).toBe(executions[1]!.dataRevision);
    expect(executions[0]!.config.strategy.minimumHoldingPeriod).toBe(2);
    expect(executions[1]!.config.strategy.minimumHoldingPeriod).toBe(9);
    expect(first.result).toMatchObject({
      run_id: "signal-run",
      technical_strategy: { signals: [{ calculation_date: "2024-01-02", signal_date: "2024-01-02", planned_trade_date: "2024-01-03", actual_application_date: null }] },
      artifact_index: [{ type: "technical-signals" }],
    });
  });

  it("combined 요청은 기존 prepare simulation을 사용하고 signal 날짜와 ledger 적용일을 함께 반환한다", async () => {
    const { service, backtestEngine, technicalAnalysis, rustCompute } = harness("backtest");
    const request: TechnicalStrategyBacktestRequest = { analysis: analysis as never, strategy: strategy as never, backtest: backtest as never };

    const response = await service.runBacktest({ ownerSubject: "owner-a", request });

    expect(backtestEngine.prepare).toHaveBeenCalledOnce();
    expect(technicalAnalysis.safeTradeDates).not.toHaveBeenCalled();
    const [, payload] = vi.mocked(rustCompute.compute).mock.calls[0]!;
    expect(payload).toMatchObject({ simulation: { observedDates: ["2024-01-03"] }, response_context: { assets: [] } });
    expect(payload).not.toHaveProperty("safe_trade_dates");
    expect(response.result).toMatchObject({
      run_id: "strategy-backtest-run",
      technical_strategy: { signals: [{
        calculation_date: "2024-01-02",
        signal_date: "2024-01-02",
        planned_trade_date: "2024-01-03",
        actual_application_date: "2024-01-03",
        status: "applied",
      }] },
      backtest: { targetWeightSchedule: [{ scheduledDate: "2024-01-03", effectiveDate: "2024-01-03", action: "signal-1" }] },
    });
  });

  it("bar.volume 조건 종목은 signal-only와 combined 모두 TA prepare에 volume 필수 대상으로 전달한다", async () => {
    const volumeStrategy = {
      ...strategy,
      exitCondition: {
        operator: "less_than",
        left: { type: "bar", instrumentKey: "AAA", field: "volume" },
        right: { type: "constant", value: 1_000 },
      },
    } as const;
    const signalHarness = harness();
    await signalHarness.service.analyzeSignals({
      ownerSubject: "owner-a",
      request: { analysis: analysis as never, strategy: volumeStrategy as never },
    });
    expect(signalHarness.technicalAnalysis.prepare).toHaveBeenCalledWith(analysis, { requireVolumeSymbols: ["AAA"] });

    const combinedHarness = harness("backtest");
    await combinedHarness.service.runBacktest({
      ownerSubject: "owner-a",
      request: { analysis: analysis as never, strategy: volumeStrategy as never, backtest: backtest as never },
    });
    expect(combinedHarness.technicalAnalysis.prepare).toHaveBeenCalledWith(analysis, { requireVolumeSymbols: ["AAA"] });
  });

  it("요청 mode와 backtest 존재 여부, 요청 allocation/config provenance가 다른 Rust 결과를 거부한다", async () => {
    const signalHarness = harness();
    vi.mocked(signalHarness.rustCompute.compute).mockResolvedValue(workerOutput(strategyResult("backtest")) as never);
    await expect(signalHarness.service.analyzeSignals({
      ownerSubject: "owner-a",
      request: { analysis: analysis as never, strategy: strategy as never },
    })).rejects.toMatchObject({ detail: { code: "INVALID_TECHNICAL_STRATEGY_RESULT" } });

    const combinedHarness = harness("backtest");
    vi.mocked(combinedHarness.rustCompute.compute).mockResolvedValue(workerOutput(strategyResult("signal_only")) as never);
    await expect(combinedHarness.service.runBacktest({
      ownerSubject: "owner-a",
      request: { analysis: analysis as never, strategy: strategy as never, backtest: backtest as never },
    })).rejects.toMatchObject({ detail: { code: "INVALID_TECHNICAL_STRATEGY_RESULT" } });

    const forgedAllocation = structuredClone(strategyResult("signal_only")) as Record<string, any>;
    forgedAllocation.technical_strategy.signals[0].target_weights = { AAA: 0 };
    forgedAllocation.technical_strategy.signals[0].cash_target_percent = 100;
    forgedAllocation.technical_strategy.target_weight_schedule[0].weights = { AAA: 0 };
    forgedAllocation.technical_strategy.target_weight_schedule[0].cashTargetPercent = 100;
    const allocationHarness = harness();
    vi.mocked(allocationHarness.rustCompute.compute).mockResolvedValue(workerOutput(forgedAllocation as never) as never);
    await expect(allocationHarness.service.analyzeSignals({
      ownerSubject: "owner-a",
      request: { analysis: analysis as never, strategy: strategy as never },
    })).rejects.toMatchObject({ detail: { code: "INVALID_TECHNICAL_STRATEGY_RESULT" } });

    const forgedConfig = structuredClone(strategyResult("backtest")) as Record<string, any>;
    forgedConfig.backtest.config.initialAmount = 2_000_000;
    const configHarness = harness("backtest");
    vi.mocked(configHarness.rustCompute.compute).mockResolvedValue(workerOutput(forgedConfig as never) as never);
    await expect(configHarness.service.runBacktest({
      ownerSubject: "owner-a",
      request: { analysis: analysis as never, strategy: strategy as never, backtest: backtest as never },
    })).rejects.toMatchObject({ detail: { code: "INVALID_TECHNICAL_STRATEGY_RESULT" } });
  });

  it("validate는 가용성과 기존 backtest validator만 호출하고 Rust 계산을 실행하지 않는다", async () => {
    const { service, marketData, backtests, technicalAnalysis, rustCompute } = harness("backtest");
    const response = await service.validate({
      ownerSubject: "owner-a",
      request: { analysis: analysis as never, strategy: strategy as never, backtest: backtest as never },
    });

    expect(response.result).toMatchObject({ valid: true, errors: [] });
    expect(marketData.getDataAvailability).toHaveBeenCalledOnce();
    expect(backtests.validate).toHaveBeenCalledOnce();
    expect(technicalAnalysis.prepare).not.toHaveBeenCalled();
    expect(rustCompute.compute).not.toHaveBeenCalled();
  });

  it("service 경계에서도 잘못된 ref/profile/depth/nodes/allocation과 사용자 schedule·정기 rebalance를 거부한다", () => {
    const { service, technicalAnalysis } = harness();
    const baseRequest: TechnicalSignalAnalysisRequest = { analysis: analysis as never, strategy: strategy as never };
    const invalidRef = {
      ...baseRequest,
      strategy: { ...baseRequest.strategy, entryCondition: {
        operator: "greater_than", left: { type: "indicator", instrumentKey: "AAA", indicatorId: "missing", field: "value" }, right: { type: "constant", value: 1 },
      } as TechnicalStrategyCondition },
    };
    expect(() => service.analyzeSignals({ ownerSubject: "owner-a", request: invalidRef })).toThrow(/정의되지 않은 지표/);

    const profile = {
      ...baseRequest,
      analysis: { ...analysis, indicators: [{ id: "profile", kind: "volume_profile" }] } as never,
      strategy: { ...baseRequest.strategy, entryCondition: {
        operator: "greater_than", left: { type: "indicator", instrumentKey: "AAA", indicatorId: "profile", field: "point_of_control" }, right: { type: "constant", value: 1 },
      } as TechnicalStrategyCondition },
    };
    expect(() => service.analyzeSignals({ ownerSubject: "owner-a", request: profile })).toThrow(/Volume Profile/);

    let deep: TechnicalStrategyCondition = strategy.exitCondition as TechnicalStrategyCondition;
    for (let index = 0; index < 17; index += 1) deep = { operator: "not", condition: deep };
    expect(() => service.analyzeSignals({ ownerSubject: "owner-a", request: {
      ...baseRequest, strategy: { ...baseRequest.strategy, entryCondition: deep },
    } })).toThrow(/깊이/);

    const leaf = strategy.exitCondition as TechnicalStrategyCondition;
    const many: TechnicalStrategyCondition = { operator: "all", conditions: Array.from({ length: 255 }, () => leaf) };
    expect(() => service.analyzeSignals({ ownerSubject: "owner-a", request: {
      ...baseRequest, strategy: { ...baseRequest.strategy, entryCondition: many },
    } })).toThrow(/노드/);

    expect(() => service.analyzeSignals({ ownerSubject: "owner-a", request: {
      ...baseRequest,
      strategy: { ...baseRequest.strategy, allocations: { ...baseRequest.strategy.allocations, inactive: { weights: { AAA: 1 }, cashPercent: 100 } } },
    } })).toThrow(/합계/);

    expect(() => service.runBacktest({ ownerSubject: "owner-a", request: {
      ...baseRequest, backtest: { ...backtest, targetWeightSchedule: [{ date: "2024-01-02", weights: { AAA: 100 }, cashTargetPercent: 0 }] } as never,
    } })).toThrow(/worker만 생성/);
    expect(() => service.runBacktest({ ownerSubject: "owner-a", request: {
      ...baseRequest, backtest: { ...backtest, rebalanceFrequency: "monthly" } as never,
    } })).toThrow(/정기 리밸런싱/);
    expect(() => service.runBacktest({ ownerSubject: "owner-a", request: {
      ...baseRequest, backtest: { ...backtest, assets: [{ symbol: "AAA", weight: 100 }], execution: { cashTargetPercent: 0 } } as never,
    } })).toThrow(/initialState allocation/);
    expect(technicalAnalysis.prepare).not.toHaveBeenCalled();
  });
});
