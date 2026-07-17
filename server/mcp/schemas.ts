import { z } from "zod";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, "유효한 YYYY-MM-DD 날짜가 필요합니다.");
const symbol = z.string().trim().regex(/^[A-Za-z0-9.-]{1,32}$/).transform((value) => value.toUpperCase());
const runId = z.string().uuid();
const currencyMode = z.enum(["local", "KRW"]).default("KRW");
const period = { fromDate: date, toDate: date };
const weight = z.number().finite().gt(0).max(100);
const weights = z.record(symbol, z.number().finite().min(0).max(1));
const asset = z.object({
  symbol,
  weight,
  lotSize: z.number().finite().positive().max(1_000_000).default(1),
}).strict();
const customCashFlow = z.object({
  date,
  amount: z.number().finite().min(-1_000_000_000_000).max(1_000_000_000_000),
  memo: z.string().trim().max(200).optional(),
}).strict();
const executionPolicy = z.object({
  cashTargetPercent: z.number().finite().min(0).max(100).default(0),
  quantityMode: z.enum(["fractional", "whole"]).default("fractional"),
  cashFlowRebalanceMode: z.enum(["target_weights", "drift_reduction", "full"]).default("target_weights"),
  tradeDatePolicy: z.literal("next_common_observation").default("next_common_observation"),
  cashAnnualYieldPercent: z.number().finite().min(-100).max(100).default(0),
}).strict().default({
  cashTargetPercent: 0,
  quantityMode: "fractional",
  cashFlowRebalanceMode: "target_weights",
  tradeDatePolicy: "next_common_observation",
  cashAnnualYieldPercent: 0,
});
const report = z.object({
  enabled: z.boolean().default(false),
  failure_mode: z.enum(["warn", "fail"]).default("warn"),
}).strict().default({ enabled: false, failure_mode: "warn" });
const backtestBase = z.object({
  assets: z.array(asset).min(1).max(20),
  startDate: date,
  endDate: date,
  initialAmount: z.number().finite().min(10_000).max(10_000_000_000_000),
  monthlyCashFlow: z.number().finite().min(-1_000_000_000_000).max(1_000_000_000_000).default(0),
  cashFlowFrequency: z.enum(["monthly", "quarterly", "annually"]).default("monthly"),
  cashFlowTiming: z.enum(["period_start", "period_end"]).default("period_start"),
  rebalanceFrequency: z.enum(["none", "monthly", "quarterly", "annually", "threshold"]).default("none"),
  rebalanceThresholdPercent: z.number().finite().min(0.1).max(50).optional(),
  riskFreeRatePercent: z.number().finite().min(-10).max(50).default(0),
  transactionCostBps: z.number().finite().min(0).max(500).default(0),
  cashFlows: z.array(customCashFlow).max(1_000).default([]),
  execution: executionPolicy,
  currencyMode,
  baseCurrency: z.literal("KRW").default("KRW"),
  benchmark: z.enum(["NONE", "KOSPI", "KOSDAQ", "NASDAQ100", "SP500", "CUSTOM"]).default("NONE"),
  benchmarkSymbol: symbol.optional(),
  report,
}).strict();
function refineBacktest(value: Pick<z.infer<typeof backtestBase>,
  "assets" | "startDate" | "endDate" | "benchmark" | "benchmarkSymbol" | "rebalanceFrequency" | "rebalanceThresholdPercent" | "execution" | "cashFlows"
>, context: z.RefinementCtx): void {
  const total = value.assets.reduce((sum, item) => sum + item.weight, 0);
  if (Math.abs(total + value.execution.cashTargetPercent - 100) > 0.01) context.addIssue({ code: "custom", path: ["assets"], message: "종목과 현금 목표 비중 합계는 100%여야 합니다." });
  if (new Set(value.assets.map((item) => item.symbol)).size !== value.assets.length) context.addIssue({ code: "custom", path: ["assets"], message: "중복 종목을 제거해 주세요." });
  if (value.startDate > value.endDate) context.addIssue({ code: "custom", path: ["startDate"], message: "시작일은 종료일보다 늦을 수 없습니다." });
  if (value.benchmark === "CUSTOM" && !value.benchmarkSymbol) context.addIssue({ code: "custom", path: ["benchmarkSymbol"], message: "CUSTOM 벤치마크 종목이 필요합니다." });
  if (value.rebalanceFrequency === "threshold" && value.rebalanceThresholdPercent === undefined) context.addIssue({ code: "custom", path: ["rebalanceThresholdPercent"], message: "threshold 기준이 필요합니다." });
  for (const [index, flow] of value.cashFlows.entries()) {
    if (flow.date < value.startDate) context.addIssue({ code: "custom", path: ["cashFlows", index, "date"], message: "현금흐름 날짜는 시작일 이상이어야 합니다." });
    if (flow.date > value.endDate) context.addIssue({ code: "custom", path: ["cashFlows", index, "date"], message: "현금흐름 날짜는 종료일 이하여야 합니다." });
  }
}
const backtest = backtestBase.superRefine(refineBacktest);
const backtestWithoutReport = backtestBase.omit({ report: true }).superRefine(refineBacktest);
const optimizationBase = z.object({
  symbols: z.array(symbol).min(2).max(20),
  ...period,
  benchmark: symbol.optional(),
  currencyMode,
  objective: z.enum(["max_sharpe", "max_sortino", "max_calmar", "min_volatility", "min_cvar", "max_information_ratio", "robust_score"]).default("robust_score"),
  minWeight: z.number().finite().min(0).max(1).default(0),
  maxWeight: z.number().finite().min(0).max(1).default(1),
  minWeights: z.record(symbol, z.number().finite().min(0).max(1)).default({}),
  maxWeights: z.record(symbol, z.number().finite().min(0).max(1)).default({}),
  maxAssets: z.number().int().min(1).max(20).optional(),
  requiredAssets: z.array(symbol).max(20).default([]),
  excludedAssets: z.array(symbol).max(20).default([]),
  maxDrawdown: z.number().finite().min(0).max(1).optional(),
  targetReturn: z.number().finite().min(-1).max(10).optional(),
  maxTurnover: z.number().finite().min(0).max(2).optional(),
  currentWeights: weights.default({}),
  transactionCostBps: z.number().finite().min(0).max(500).default(0),
  riskFreeRatePercent: z.number().finite().min(-10).max(50).default(0),
  seed: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(12_345),
  candidateBudget: z.number().int().min(1).max(10_000).default(500),
}).strict();
function refineOptimization(value: z.infer<typeof optimizationBase>, context: z.RefinementCtx): void {
  if (value.fromDate > value.toDate) context.addIssue({ code: "custom", path: ["fromDate"], message: "시작일이 종료일보다 늦습니다." });
  if (value.minWeight > value.maxWeight) context.addIssue({ code: "custom", path: ["minWeight"], message: "최소 비중이 최대 비중보다 큽니다." });
  if (value.objective === "max_information_ratio" && !value.benchmark) context.addIssue({ code: "custom", path: ["benchmark"], message: "Information Ratio 최적화에는 벤치마크가 필요합니다." });
  const required = new Set(value.requiredAssets);
  const excluded = new Set(value.excludedAssets);
  for (const item of required) {
    if (excluded.has(item)) context.addIssue({ code: "custom", path: ["requiredAssets"], message: `${item}은 필수·제외 종목에 동시에 포함될 수 없습니다.` });
    if (!value.symbols.includes(item)) context.addIssue({ code: "custom", path: ["requiredAssets"], message: `${item}은 최적화 종목 목록에 없습니다.` });
  }
}
const optimization = optimizationBase.superRefine(refineOptimization);
const diversifyingAssets = z.object({
  baseSymbols: z.array(symbol).min(1).max(19),
  baseWeights: weights.optional(),
  candidateSymbols: z.array(symbol).min(1).max(19).optional(),
  ...period,
  currencyMode,
  maximumCorrelation: z.number().finite().min(-1).max(1).default(0.35),
  candidateWeight: z.number().finite().min(0.01).max(0.5).default(0.2),
  limit: z.number().int().min(1).max(19).default(10),
}).strict().superRefine((value, context) => {
  if (value.fromDate > value.toDate) context.addIssue({ code: "custom", path: ["fromDate"], message: "시작일이 종료일보다 늦습니다." });
  if (value.candidateSymbols && new Set([...value.baseSymbols, ...value.candidateSymbols]).size > 20) {
    context.addIssue({ code: "custom", path: ["candidateSymbols"], message: "기준 자산과 후보 자산은 합계 20개 이하여야 합니다." });
  }
  if (value.baseWeights) {
    const total = value.baseSymbols.reduce((sum, item) => sum + (value.baseWeights?.[item] ?? 0), 0);
    if (Math.abs(total - 1) > 0.0001) context.addIssue({ code: "custom", path: ["baseWeights"], message: "기준 자산 비중 합계는 1이어야 합니다." });
  }
});
const stressScenario = z.object({
  name: z.string().min(1).max(80),
  startDate: date.optional(),
  endDate: date.optional(),
  transactionCostBps: z.number().min(0).max(500).optional(),
  monthlyCashFlow: z.number().min(-1e12).max(1e12).optional(),
  cashFlowFrequency: z.enum(["monthly", "quarterly", "annually"]).optional(),
  cashFlowTiming: z.enum(["period_start", "period_end"]).optional(),
  currencyMode: z.enum(["local", "KRW"]).optional(),
  rebalanceFrequency: z.enum(["none", "monthly", "quarterly", "annually", "threshold"]).optional(),
  rebalanceThresholdPercent: z.number().finite().min(0.1).max(50).optional(),
  excludeSymbols: z.array(symbol).max(19).optional(),
}).strict().superRefine((value, context) => {
  if (value.startDate && value.endDate && value.startDate > value.endDate) {
    context.addIssue({ code: "custom", path: ["startDate"], message: "위기 구간 시작일이 종료일보다 늦습니다." });
  }
  if (value.rebalanceFrequency === "threshold" && value.rebalanceThresholdPercent === undefined) {
    context.addIssue({ code: "custom", path: ["rebalanceThresholdPercent"], message: "threshold 기준이 필요합니다." });
  }
});
const rebalancePlan = z.object({
  currentWeights: weights,
  targetWeights: weights,
  fromDate: date.optional(),
  toDate: date.optional(),
  currencyMode,
  portfolioValue: z.number().finite().positive().optional(),
  transactionCostBps: z.number().finite().min(0).max(500).default(0),
}).strict().superRefine((value, context) => {
  if (Boolean(value.fromDate) !== Boolean(value.toDate)) context.addIssue({ code: "custom", path: ["fromDate"], message: "위험 비교 기간의 시작일과 종료일을 함께 입력해야 합니다." });
  if (value.fromDate && value.toDate && value.fromDate > value.toDate) context.addIssue({ code: "custom", path: ["fromDate"], message: "시작일이 종료일보다 늦습니다." });
  for (const field of ["currentWeights", "targetWeights"] as const) {
    const total = Object.values(value[field]).reduce((sum, item) => sum + item, 0);
    if (Math.abs(total - 1) > 0.0001) context.addIssue({ code: "custom", path: [field], message: "비중 합계는 1이어야 합니다." });
  }
});

export const outputEnvelopeSchema = z.object({
  schema_version: z.string(),
  generated_at: z.string(),
  engine_version: z.string(),
  data_revision: z.string(),
  request_hash: z.string(),
  assumptions: z.array(z.string()),
  warnings: z.array(z.string()),
  data_quality: z.record(z.string(), z.unknown()),
  result: z.unknown(),
}).catchall(z.unknown());

export const toolSchemas = {
  search_instruments: z.object({ query: z.string().trim().min(1).max(80), market: z.string().trim().max(32).optional(), assetType: z.string().trim().max(32).optional(), limit: z.number().int().min(1).max(100).default(20) }).strict(),
  get_data_availability: z.object({ symbols: z.array(symbol).min(1).max(20), adjusted: z.boolean().default(true) }).strict(),
  get_price_series: z.object({ symbol, ...period, interval: z.enum(["1d", "1w", "1mo"]).default("1d"), adjusted: z.boolean().default(true), currencyMode, outputMode: z.enum(["inline", "resource", "auto"]).default("auto") }).strict(),
  analyze_instrument: z.object({ symbol, benchmark: symbol.optional(), ...period, currencyMode, riskFreeRatePercent: z.number().finite().min(-10).max(50).default(0), rollingWindow: z.number().int().min(2).max(1_000).default(60) }).strict(),
  analyze_asset_relationship: z.object({ base: symbol, comparisons: z.array(symbol).min(1).max(19), ...period, currencyMode, method: z.enum(["pearson", "spearman"]).default("pearson"), rollingWindow: z.number().int().min(2).max(1_000).default(60), riskFreeRatePercent: z.number().finite().min(-10).max(50).default(0) }).strict(),
  get_correlation_matrix: z.object({ symbols: z.array(symbol).min(2).max(20), ...period, currencyMode, method: z.enum(["pearson", "spearman"]).default("pearson") }).strict(),
  validate_backtest_config: backtestWithoutReport,
  run_portfolio_backtest: backtest,
  compare_backtests: z.object({ runIds: z.array(runId).min(2).max(20) }).strict(),
  get_backtest_artifact: z.object({ runId, type: z.enum(["equity", "drawdown", "holdings", "trades", "cash-ledger", "cash-flows", "rolling", "correlation", "risk-contribution", "monthly-returns"]) }).strict(),
  get_current_portfolio: z.object({ accountSelector: z.string().trim().min(8).max(128).optional() }).strict(),
  find_diversifying_assets: diversifyingAssets,
  analyze_market_regimes: z.object({ benchmark: symbol, ...period, currencyMode, volatilityWindow: z.number().int().min(5).max(252).default(20) }).strict(),
  analyze_return_contribution: z.object({ runId }).strict(),
  optimize_portfolio: optimization,
  walk_forward_optimize: optimizationBase.extend({ trainWindow: z.number().int().min(20).max(5_000).default(252), testWindow: z.number().int().min(5).max(2_000).default(63), step: z.number().int().min(1).max(2_000).default(63) }).strict().superRefine(refineOptimization),
  stress_test_portfolio: z.object({ baseConfig: backtestWithoutReport, scenarios: z.array(stressScenario).min(1).max(50) }).strict(),
  build_pareto_frontier: z.object({ runId, limit: z.number().int().min(1).max(1_000).default(100) }).strict(),
  find_redundant_assets: z.object({ symbols: z.array(symbol).min(2).max(20), ...period, currencyMode, correlationThreshold: z.number().finite().min(0).max(1).default(0.9), betaTolerance: z.number().finite().min(0).max(2).default(0.2), drawdownCorrelationThreshold: z.number().finite().min(0).max(1).default(0.8) }).strict(),
  analyze_rebalance_plan: rebalancePlan,
  analyze_weight_sensitivity: z.object({ baseConfig: backtestWithoutReport, targetSymbol: symbol, targetWeights: z.array(z.number().finite().min(0).max(1)).min(2).max(30) }).strict(),
  analyze_start_date_sensitivity: z.object({ baseConfig: backtestWithoutReport, offsetsDays: z.array(z.number().int().min(-3_650).max(3_650)).min(1).max(60) }).strict(),
  analyze_rebalance_sensitivity: z.object({ baseConfig: backtestWithoutReport, modes: z.array(z.enum(["none", "monthly", "quarterly", "annually", "threshold"])).min(1).max(5), thresholdPercent: z.number().finite().min(0.1).max(50).default(5) }).strict(),
  analyze_cash_flow_sensitivity: z.object({ baseConfig: backtestWithoutReport, monthlyAmounts: z.array(z.number().finite().min(-1e12).max(1e12)).min(1).max(20), frequencies: z.array(z.enum(["monthly", "quarterly", "annually"])).min(1).max(3).default(["monthly"]), timings: z.array(z.enum(["period_start", "period_end"])).min(1).max(2).default(["period_start"]) }).strict(),
  simulate_portfolio_monte_carlo: z.object({
    symbols: z.array(symbol).min(1).max(20),
    weights: weights,
    ...period,
    currencyMode,
    initialAmount: z.number().finite().positive().max(10_000_000_000_000),
    horizonDays: z.number().int().min(1).max(25_200).default(252),
    pathCount: z.number().int().min(100).max(100_000).default(10_000),
    blockLength: z.number().int().min(1).max(252).default(20),
    seed: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(12_345),
    goalAmount: z.number().finite().positive().max(100_000_000_000_000).optional(),
    quantiles: z.array(z.number().finite().gt(0).lt(1)).min(1).max(19).default([0.05, 0.25, 0.5, 0.75, 0.95]),
    samplePathCount: z.number().int().min(0).max(100).default(10),
  }).strict().superRefine((value, context) => {
    if (value.fromDate > value.toDate) context.addIssue({ code: "custom", path: ["fromDate"], message: "시작일이 종료일보다 늦습니다." });
    const total = value.symbols.reduce((sum, item) => sum + (value.weights[item] ?? 0), 0);
    if (Math.abs(total - 1) > 0.0001) context.addIssue({ code: "custom", path: ["weights"], message: "선택 종목 비중 합계는 1이어야 합니다." });
    if (value.pathCount * value.horizonDays > 25_000_000) context.addIssue({ code: "custom", path: ["pathCount"], message: "pathCount × horizonDays는 25,000,000 이하여야 합니다." });
    if ((new Set(value.quantiles).size + value.samplePathCount) * (value.horizonDays + 1) > 1_000_000) context.addIssue({ code: "custom", path: ["samplePathCount"], message: "요청한 percentile/sample path 출력점은 1,000,000개 이하여야 합니다." });
  }),
  explain_data_quality: z.object({ symbols: z.array(symbol).min(1).max(20), benchmark: symbol.optional(), ...period, adjusted: z.boolean().default(true), currencyMode }).strict().superRefine((value, context) => {
    if (value.fromDate > value.toDate) context.addIssue({ code: "custom", path: ["fromDate"], message: "시작일이 종료일보다 늦습니다." });
    if (new Set([...value.symbols, ...(value.benchmark ? [value.benchmark] : [])]).size > 20) context.addIssue({ code: "custom", path: ["benchmark"], message: "벤치마크를 포함한 종목 수는 20개 이하여야 합니다." });
  }),
  get_run_status: z.object({ runId }).strict(),
  cancel_run: z.object({ runId }).strict(),
  get_run_result: z.object({ runId }).strict(),
  generate_backtest_report: z.object({ runId, failureMode: z.enum(["warn", "fail"]).default("fail") }).strict(),
  get_report: z.object({ reportId: z.string().uuid() }).strict(),
} as const;

export type ToolName = keyof typeof toolSchemas;
