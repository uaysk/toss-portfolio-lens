import { z } from "zod";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, "유효한 YYYY-MM-DD 날짜가 필요합니다.");
const symbol = z.string().trim().regex(/^[A-Za-z0-9.-]{1,32}$/).transform((value) => value.toUpperCase());
const runId = z.string().uuid();
const presetId = z.string().uuid();
const tag = z.string().trim().min(1).max(40);
const executionMode = z.enum(["sync", "async"]).optional();
const currencyMode = z.enum(["local", "KRW"]).default("KRW");
const period = { fromDate: date, toDate: date };
const weight = z.number().finite().gt(0).max(100);
const weights = z.record(symbol, z.number().finite().min(0).max(1));
const asset = z.object({
  symbol,
  weight,
  lotSize: z.number().finite().positive().max(1_000_000).default(1),
  delistDate: date.optional(),
  universeMemberFrom: date.optional(),
  universeMemberTo: date.optional(),
}).strict();
const customCashFlow = z.object({
  date,
  amount: z.number().finite().min(-1_000_000_000_000).max(1_000_000_000_000),
  memo: z.string().trim().max(200).optional(),
}).strict();
const targetWeightScheduleEntry = z.object({
  date,
  weights: z.record(symbol, z.number().finite().min(0).max(100)),
  cashTargetPercent: z.number().finite().min(0).max(100).default(0),
  regime: z.string().trim().min(1).max(80).optional(),
  action: z.string().trim().min(1).max(80).optional(),
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
const realismPolicy = z.object({
  costs: z.object({
    commissionBps: z.number().finite().min(0).max(5_000).optional(),
    sellTaxBps: z.number().finite().min(0).max(5_000).default(0),
    fixedSlippageBps: z.number().finite().min(0).max(5_000).default(0),
    marketImpactCoefficient: z.number().finite().min(0).max(1).default(0),
    marketImpactExponent: z.number().finite().min(0.1).max(2).default(0.5),
    maxParticipationRatePercent: z.number().finite().gt(0).max(100).optional(),
    minimumFee: z.number().finite().min(0).max(1_000_000_000).default(0),
    dividendTaxBps: z.number().finite().min(0).max(10_000).default(0),
  }).strict().default({
    sellTaxBps: 0,
    fixedSlippageBps: 0,
    marketImpactCoefficient: 0,
    marketImpactExponent: 0.5,
    minimumFee: 0,
    dividendTaxBps: 0,
  }),
  dividendMode: z.enum(["adjusted_price_only", "cash"]).default("adjusted_price_only"),
  enforcePointInTimeUniverse: z.boolean().default(false),
}).strict().default({
  costs: {
    sellTaxBps: 0,
    fixedSlippageBps: 0,
    marketImpactCoefficient: 0,
    marketImpactExponent: 0.5,
    minimumFee: 0,
    dividendTaxBps: 0,
  },
  dividendMode: "adjusted_price_only",
  enforcePointInTimeUniverse: false,
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
  targetWeightSchedule: z.array(targetWeightScheduleEntry).max(10_000).default([]),
  execution: executionPolicy,
  realism: realismPolicy,
  currencyMode,
  baseCurrency: z.literal("KRW").default("KRW"),
  benchmark: z.enum(["NONE", "KOSPI", "KOSDAQ", "NASDAQ100", "SP500", "CUSTOM"]).default("NONE"),
  benchmarkSymbol: symbol.optional(),
  report,
}).strict();
function refineBacktest(value: Pick<z.infer<typeof backtestBase>,
  "assets" | "startDate" | "endDate" | "benchmark" | "benchmarkSymbol" | "rebalanceFrequency" | "rebalanceThresholdPercent" | "execution" | "realism" | "cashFlows" | "targetWeightSchedule"
>, context: z.RefinementCtx): void {
  const total = value.assets.reduce((sum, item) => sum + item.weight, 0);
  if (Math.abs(total + value.execution.cashTargetPercent - 100) > 0.01) context.addIssue({ code: "custom", path: ["assets"], message: "종목과 현금 목표 비중 합계는 100%여야 합니다." });
  if (new Set(value.assets.map((item) => item.symbol)).size !== value.assets.length) context.addIssue({ code: "custom", path: ["assets"], message: "중복 종목을 제거해 주세요." });
  for (const [index, item] of value.assets.entries()) {
    if (item.delistDate && item.delistDate < value.startDate) context.addIssue({ code: "custom", path: ["assets", index, "delistDate"], message: "상장폐지일은 백테스트 시작일 이상이어야 합니다." });
    if (item.universeMemberFrom && item.universeMemberTo && item.universeMemberFrom > item.universeMemberTo) context.addIssue({ code: "custom", path: ["assets", index, "universeMemberFrom"], message: "universe 편입일은 제외일보다 늦을 수 없습니다." });
    if (value.realism.enforcePointInTimeUniverse && (!item.universeMemberFrom || !item.universeMemberTo
      || item.universeMemberFrom >= item.universeMemberTo || item.universeMemberFrom > value.endDate
      || item.universeMemberTo <= value.startDate || (item.delistDate !== undefined && item.delistDate <= item.universeMemberFrom))) {
      context.addIssue({ code: "custom", path: ["assets", index], message: "PIT 강제 시 분석 기간과 겹치는 [편입일, 제외일) 구간이 필요합니다." });
    }
  }
  if (value.startDate > value.endDate) context.addIssue({ code: "custom", path: ["startDate"], message: "시작일은 종료일보다 늦을 수 없습니다." });
  if (value.benchmark === "CUSTOM" && !value.benchmarkSymbol) context.addIssue({ code: "custom", path: ["benchmarkSymbol"], message: "CUSTOM 벤치마크 종목이 필요합니다." });
  if (value.rebalanceFrequency === "threshold" && value.rebalanceThresholdPercent === undefined) context.addIssue({ code: "custom", path: ["rebalanceThresholdPercent"], message: "threshold 기준이 필요합니다." });
  for (const [index, flow] of value.cashFlows.entries()) {
    if (flow.date < value.startDate) context.addIssue({ code: "custom", path: ["cashFlows", index, "date"], message: "현금흐름 날짜는 시작일 이상이어야 합니다." });
    if (flow.date > value.endDate) context.addIssue({ code: "custom", path: ["cashFlows", index, "date"], message: "현금흐름 날짜는 종료일 이하여야 합니다." });
  }
  const assetSymbols = new Set(value.assets.map((item) => item.symbol));
  const scheduleDates = new Set<string>();
  for (const [index, entry] of value.targetWeightSchedule.entries()) {
    if (entry.date < value.startDate || entry.date > value.endDate) context.addIssue({ code: "custom", path: ["targetWeightSchedule", index, "date"], message: "목표비중 적용일은 백테스트 기간 안이어야 합니다." });
    if (scheduleDates.has(entry.date)) context.addIssue({ code: "custom", path: ["targetWeightSchedule", index, "date"], message: "같은 날짜의 목표비중 정책은 하나만 허용됩니다." });
    scheduleDates.add(entry.date);
    const scheduleSymbols = Object.keys(entry.weights);
    if (scheduleSymbols.length !== assetSymbols.size || scheduleSymbols.some((item) => !assetSymbols.has(item))) context.addIssue({ code: "custom", path: ["targetWeightSchedule", index, "weights"], message: "각 목표비중 정책은 구성 종목을 빠짐없이 정확히 포함해야 합니다." });
    const scheduleTotal = Object.values(entry.weights).reduce((sum, item) => sum + item, 0);
    if (Math.abs(scheduleTotal + entry.cashTargetPercent - 100) > 0.01) context.addIssue({ code: "custom", path: ["targetWeightSchedule", index, "weights"], message: "정책의 종목과 현금 목표 비중 합계는 100%여야 합니다." });
  }
}
const backtest = backtestBase.superRefine(refineBacktest);
const backtestWithoutReportBase = backtestBase.omit({ report: true });
const backtestWithoutReport = backtestWithoutReportBase.superRefine(refineBacktest);
function presetOverrideField(schema: z.ZodType): z.ZodType {
  const unwrapped = schema instanceof z.ZodDefault ? schema.removeDefault() : schema;
  if (!(unwrapped instanceof z.ZodObject)) return unwrapped as z.ZodType;
  return z.object(Object.fromEntries(Object.entries(unwrapped.shape).map(([key, child]) => [
    key,
    z.optional(presetOverrideField(child as z.ZodType)),
  ])) as z.ZodRawShape).strict();
}
function presetOverrideObject(shape: z.ZodRawShape): z.ZodObject<z.ZodRawShape> {
  return z.object(Object.fromEntries(Object.entries(shape).map(([key, schema]) => [
    key,
    z.optional(presetOverrideField(schema as z.ZodType)),
  ])) as z.ZodRawShape);
}
function validateResolvedExecution(schema: z.ZodType, value: unknown, context: z.RefinementCtx): void {
  const parsed = schema.safeParse(value);
  if (parsed.success) return;
  for (const issue of parsed.error.issues) {
    context.addIssue({ code: "custom", path: issue.path, message: issue.message });
  }
}
const backtestExecution = presetOverrideObject(backtestBase.shape).extend({
  presetId: presetId.optional(),
}).strict().superRefine((value, context) => {
  if (!value.presetId) validateResolvedExecution(backtest, value, context);
});
const backtestValidationExecution = presetOverrideObject(backtestWithoutReportBase.shape).extend({
  presetId: presetId.optional(),
}).strict().superRefine((value, context) => {
  if (!value.presetId) validateResolvedExecution(backtestWithoutReport, value, context);
});
const optimizerBaseline = z.enum([
  "equal_weight", "current_weight", "inverse_volatility", "minimum_variance",
  "risk_parity", "hrp", "herc",
]);
const robustScoreComponent = z.enum([
  "sharpe", "sortino", "calmar", "volatility", "cvar", "informationRatio",
  "oosAverageSharpe", "oosWorstSharpe", "oosAverageCvar",
  "inSampleSharpe", "inSampleSortino", "inSampleCalmar", "inSampleVolatility",
  "inSampleCvar", "inSampleInformationRatio", "averageSharpe", "worstSharpe", "averageCvar",
]);
const robustScoreWeights = z.partialRecord(
  robustScoreComponent,
  z.number().finite().min(0).max(1),
).superRefine((value, context) => {
  if (Object.keys(value).length && !Object.values(value).some((item) => item > 0)) {
    context.addIssue({ code: "custom", path: [], message: "비어 있지 않은 robust score 가중치는 하나 이상이 0보다 커야 합니다." });
  }
}).default({});
const robustValidation = z.object({
  enabled: z.boolean().default(true),
  mode: z.enum(["holdout", "walk_forward"]).default("walk_forward"),
  windowMode: z.enum(["rolling", "anchored"]).default("rolling"),
  trainFraction: z.number().finite().min(0.1).max(0.95).default(0.8),
  testFraction: z.number().finite().min(0.05).max(0.5).default(0.2),
  trainWindow: z.number().int().min(2).max(5_000).default(126),
  testWindow: z.number().int().min(1).max(2_000).default(21),
  step: z.number().int().min(1).max(2_000).default(21),
  foldCount: z.number().int().min(2).max(100).default(5),
  gap: z.number().int().min(0).max(1_000).default(0),
  embargo: z.number().int().min(0).max(1_000).default(0),
  minimumTrainObservations: z.number().int().min(2).max(5_000).default(20),
  minimumTestObservations: z.number().int().min(1).max(2_000).default(5),
}).strict().superRefine((value, context) => {
  if (value.mode === "holdout" && value.trainFraction + value.testFraction > 1) {
    context.addIssue({ code: "custom", path: ["trainFraction"], message: "inner train/test 비율 합계는 1 이하여야 합니다." });
  }
  if (value.mode === "walk_forward" && value.minimumTrainObservations > value.trainWindow) {
    context.addIssue({ code: "custom", path: ["minimumTrainObservations"], message: "최소 학습 관측치는 trainWindow 이하여야 합니다." });
  }
  if (value.mode === "walk_forward" && value.minimumTestObservations > value.testWindow) {
    context.addIssue({ code: "custom", path: ["minimumTestObservations"], message: "최소 OOS 관측치는 testWindow 이하여야 합니다." });
  }
}).default({
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
const regimePolicySearch = z.object({
  enabled: z.boolean().default(false),
  method: z.enum(["auto", "dynamic_programming", "mcts"]).default("auto"),
  states: z.union([
    z.number().int().min(2).max(8),
    z.array(z.string().trim().min(1).max(80)).min(2).max(8),
  ]).default(3),
  baselineActions: z.array(optimizerBaseline).min(1).max(7).optional(),
  lookback: z.number().int().min(5).max(1_260).default(63),
  rebalanceEvery: z.number().int().min(1).max(504).default(21),
  trainFraction: z.number().finite().min(0.5).max(0.9).default(0.7),
  minimumTrainingDecisions: z.number().int().min(2).max(1_000).optional(),
  maxDepth: z.number().int().min(1).max(128).default(12),
  rollouts: z.number().int().min(16).max(100_000).default(512),
  explorationConstant: z.number().finite().min(0).max(10).default(Math.SQRT2),
  discount: z.number().finite().min(0.5).max(1).default(0.98),
  switchingCostBps: z.number().finite().min(0).max(500).optional(),
  ledgerValidationBudget: z.number().int().min(1).max(16).default(3),
}).strict().default({
  enabled: false,
  method: "auto",
  states: 3,
  lookback: 63,
  rebalanceEvery: 21,
  trainFraction: 0.7,
  maxDepth: 12,
  rollouts: 512,
  explorationConstant: Math.SQRT2,
  discount: 0.98,
  ledgerValidationBudget: 3,
});
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
  algorithm: z.enum(["random_search", "differential_evolution", "cma_es", "nsga_ii", "direct_cvar"]).default("random_search"),
  covarianceEstimator: z.enum(["sample", "ledoit_wolf"]).default("ledoit_wolf"),
  baselines: z.array(optimizerBaseline).min(1).max(7).default(["equal_weight", "current_weight", "inverse_volatility", "minimum_variance", "risk_parity", "hrp", "herc"]),
  assetGroups: z.record(symbol, z.object({
    sector: z.string().trim().min(1).max(80).optional(),
    industry: z.string().trim().min(1).max(80).optional(),
    country: z.string().trim().min(2).max(80).optional(),
    currency: z.string().trim().regex(/^[A-Z]{3}$/).optional(),
    assetType: z.string().trim().min(1).max(80).optional(),
  }).strict()).default({}),
  groupConstraints: z.array(z.object({
    dimension: z.enum(["sector", "industry", "country", "currency", "assetType"]),
    group: z.string().trim().min(1).max(80),
    minWeight: z.number().finite().min(0).max(1).default(0),
    maxWeight: z.number().finite().min(0).max(1).default(1),
  }).strict()).max(100).default([]),
  robustScoreWeights,
  robustValidation,
  ledgerValidation: z.object({
    enabled: z.boolean().default(true),
    budget: z.number().int().min(1).max(128).default(32),
    initialAmount: z.number().finite().min(10_000).max(10_000_000_000_000).default(100_000_000),
    rebalanceFrequency: z.enum(["none", "monthly", "quarterly", "annually", "threshold"]).default("none"),
    rebalanceThresholdPercent: z.number().finite().min(0.1).max(50).optional(),
    cashTargetPercent: z.number().finite().min(0).max(99).default(0),
    quantityMode: z.enum(["fractional", "whole"]).default("fractional"),
    lotSizes: z.record(symbol, z.number().finite().positive().max(1_000_000)).default({}),
  }).strict().default({
    enabled: true,
    budget: 32,
    initialAmount: 100_000_000,
    rebalanceFrequency: "none",
    cashTargetPercent: 0,
    quantityMode: "fractional",
    lotSizes: {},
  }),
  regimePolicySearch,
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
  for (const [index, constraint] of value.groupConstraints.entries()) {
    if (constraint.minWeight > constraint.maxWeight) context.addIssue({ code: "custom", path: ["groupConstraints", index, "minWeight"], message: "그룹 최소 비중이 최대 비중보다 큽니다." });
  }
  if (value.ledgerValidation.rebalanceFrequency === "threshold" && value.ledgerValidation.rebalanceThresholdPercent === undefined) {
    context.addIssue({ code: "custom", path: ["ledgerValidation", "rebalanceThresholdPercent"], message: "ledger threshold 기준이 필요합니다." });
  }
  if (value.regimePolicySearch.enabled && !value.ledgerValidation.enabled) {
    context.addIssue({ code: "custom", path: ["ledgerValidation", "enabled"], message: "국면 정책 탐색은 실제 ledger 재검증이 필요합니다." });
  }
  if (Array.isArray(value.regimePolicySearch.states)
    && new Set(value.regimePolicySearch.states).size !== value.regimePolicySearch.states.length) {
    context.addIssue({ code: "custom", path: ["regimePolicySearch", "states"], message: "국면 상태 이름은 중복될 수 없습니다." });
  }
}
const optimization = optimizationBase.superRefine(refineOptimization);
const optimizationExecution = presetOverrideObject(optimizationBase.shape).extend({
  presetId: presetId.optional(),
}).strict().superRefine((value, context) => {
  if (!value.presetId) validateResolvedExecution(optimization, value, context);
});
const walkForwardFields = {
  mode: z.enum(["rolling", "anchored"]).default("rolling"),
  trainWindow: z.number().int().min(20).max(5_000).default(252),
  testWindow: z.number().int().min(5).max(2_000).default(63),
  step: z.number().int().min(1).max(2_000).default(63),
  gap: z.number().int().min(0).max(1_000).default(0),
  embargo: z.number().int().min(0).max(1_000).default(0),
  foldCandidateBudget: z.number().int().min(1).max(10_000).default(100),
  seeds: z.array(z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)).min(1).max(20).default([12_345]),
};
const walkForwardBase = optimizationBase.extend(walkForwardFields).strict();
function refineWalkForward(value: z.infer<typeof walkForwardBase>, context: z.RefinementCtx): void {
  refineOptimization(value, context);
  if (new Set(value.seeds).size !== value.seeds.length) context.addIssue({ code: "custom", path: ["seeds"], message: "Walk-forward seed는 중복될 수 없습니다." });
  if (value.foldCandidateBudget < value.seeds.length) context.addIssue({ code: "custom", path: ["foldCandidateBudget"], message: "fold 후보 예산은 seed 수 이상이어야 합니다." });
}
const walkForwardResolved = walkForwardBase.superRefine(refineWalkForward);
const walkForwardExecution = presetOverrideObject(walkForwardBase.shape).extend({
  presetId: presetId.optional(),
}).strict().superRefine((value, context) => {
  if (!value.presetId) validateResolvedExecution(walkForwardResolved, value, context);
});

export const resolvedPresetExecutionSchemas = {
  validate_backtest_config: backtestWithoutReport,
  run_portfolio_backtest: backtest,
  optimize_portfolio: optimization,
  walk_forward_optimize: walkForwardResolved,
} as const;
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

const runListFilter = z.object({
  query: z.string().trim().max(120).optional(),
  kinds: z.array(z.enum(["backtest", "optimization", "walk_forward", "stress_test", "weight_sensitivity", "start_date_sensitivity", "rebalance_sensitivity", "cash_flow_sensitivity", "monte_carlo", "outlook", "exposure_analysis", "pareto_frontier", "research_report"])).max(13).default([]),
  statuses: z.array(z.enum(["queued", "running", "cancel_requested", "cancelled", "completed", "failed"])).max(6).default([]),
  tags: z.array(tag).max(20).default([]),
  archived: z.enum(["active", "archived", "all"]).default("active"),
  cursor: z.string().trim().max(200).optional(),
  limit: z.number().int().min(1).max(100).default(25),
}).strict();

const currentPortfolioPresetSource = z.object({
  type: z.literal("current_portfolio"),
  accountId: z.string().trim().min(1).max(128).optional(),
  accountLabel: z.string().trim().min(1).max(200).optional(),
  asOf: z.string().trim().max(64).optional(),
  holdings: z.array(z.object({
    symbol,
    name: z.string().trim().min(1).max(200).optional(),
    market: z.string().trim().min(1).max(80).optional(),
    currency: z.string().trim().regex(/^[A-Z]{3}$/).optional(),
    quantity: z.number().finite().nonnegative().optional(),
    evaluationAmount: z.number().finite().nonnegative().optional(),
    weight: z.number().finite().min(0).max(1).optional(),
  }).strict()).min(1).max(100),
  summary: z.record(z.string(), z.unknown()).optional(),
}).strict();
const presetSource = z.discriminatedUnion("type", [
  currentPortfolioPresetSource,
  z.object({ type: z.literal("run"), runId }).strict(),
  z.object({ type: z.literal("optimization_candidate"), runId, candidateIndex: z.number().int().nonnegative().max(100_000) }).strict(),
  z.object({ type: z.literal("pareto_candidate"), runId, candidateIndex: z.number().int().nonnegative().max(100_000) }).strict(),
  z.object({ type: z.literal("manual") }).strict(),
]);
const presetFields = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2_000).default(""),
  tags: z.array(tag).max(20).default([]),
  symbols: z.array(symbol).max(100).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  source: presetSource.optional(),
}).strict();
const presetCreate = presetFields.superRefine((value, context) => {
  if (!value.config && !value.source) context.addIssue({ code: "custom", path: ["config"], message: "config 또는 source가 필요합니다." });
});
const presetUpdate = presetFields.partial().extend({
  presetId,
  revision: z.number().int().positive(),
}).strict().superRefine((value, context) => {
  if (value.name === undefined && value.description === undefined && value.tags === undefined
    && value.symbols === undefined && value.config === undefined && value.source === undefined) {
    context.addIssue({ code: "custom", path: [], message: "변경할 preset 필드가 필요합니다." });
  }
});

const outlook = z.object({
  baseConfig: backtestWithoutReport,
  optimization: z.object({
    enabled: z.boolean().default(true),
    benchmark: symbol.optional(),
    objective: optimizationBase.shape.objective,
    algorithm: optimizationBase.shape.algorithm,
    covarianceEstimator: optimizationBase.shape.covarianceEstimator,
    candidateBudget: z.number().int().min(10).max(10_000).default(500),
    ledgerValidationBudget: z.number().int().min(1).max(128).default(32),
    minWeight: z.number().finite().min(0).max(1).default(0),
    maxWeight: z.number().finite().min(0).max(1).default(1),
    groupConstraints: optimizationBase.shape.groupConstraints,
    assetGroups: optimizationBase.shape.assetGroups,
    baselines: optimizationBase.shape.baselines,
    robustScoreWeights: optimizationBase.shape.robustScoreWeights,
    robustValidation,
    regimePolicySearch,
  }).strict().default({
    enabled: true,
    objective: "robust_score",
    algorithm: "random_search",
    covarianceEstimator: "ledoit_wolf",
    candidateBudget: 500,
    ledgerValidationBudget: 32,
    minWeight: 0,
    maxWeight: 1,
    groupConstraints: [],
    assetGroups: {},
    baselines: ["equal_weight", "current_weight", "inverse_volatility", "minimum_variance", "risk_parity", "hrp", "herc"],
    robustScoreWeights: {},
    robustValidation: {
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
    },
    regimePolicySearch: {
      enabled: false,
      method: "auto",
      states: 3,
      lookback: 63,
      rebalanceEvery: 21,
      trainFraction: 0.7,
      maxDepth: 12,
      rollouts: 512,
      explorationConstant: Math.SQRT2,
      discount: 0.98,
      ledgerValidationBudget: 3,
    },
  }),
  walkForward: z.object({
    mode: z.enum(["rolling", "anchored"]).default("rolling"),
    trainWindow: z.number().int().min(20).max(5_000).default(252),
    testWindow: z.number().int().min(5).max(2_000).default(63),
    step: z.number().int().min(1).max(2_000).default(63),
    gap: z.number().int().min(0).max(1_000).default(0),
    embargo: z.number().int().min(0).max(1_000).default(0),
    foldCandidateBudget: z.number().int().min(1).max(10_000).default(100),
    seeds: z.array(z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)).min(1).max(20).default([12_345]),
  }).strict().default({ mode: "rolling", trainWindow: 252, testWindow: 63, step: 63, gap: 0, embargo: 0, foldCandidateBudget: 100, seeds: [12_345] }),
  monteCarlo: z.object({
    method: z.enum(["moving_block", "stationary", "regime_conditioned", "student_t"]).default("moving_block"),
    stationaryRestartProbability: z.number().finite().gt(0).lte(1).optional(),
    studentTDegreesOfFreedom: z.number().finite().gt(2).max(100).default(7),
    horizonDays: z.number().int().min(1).max(25_200).default(252),
    pathCount: z.number().int().min(100).max(100_000).default(10_000),
    blockLength: z.number().int().min(1).max(252).default(20),
    seed: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(12_345),
    goalAmount: z.number().finite().positive().max(100_000_000_000_000).optional(),
    inflationAnnualPercent: z.number().finite().min(-20).max(100).default(0),
    periodicCashFlow: z.number().finite().min(-1e12).max(1e12).optional(),
    cashFlowFrequencyDays: z.number().int().min(1).max(25_200).optional(),
    transactionCostBps: z.number().finite().min(0).max(500).optional(),
    rebalanceFrequency: z.enum(["none", "monthly", "quarterly", "annually", "threshold"]).default("quarterly"),
    rebalanceThresholdPercent: z.number().finite().min(0.1).max(50).optional(),
    cashWeight: z.number().finite().min(0).max(1).optional(),
    cashAnnualYieldPercent: z.number().finite().min(-100).max(100).optional(),
    quantityMode: z.enum(["fractional", "whole"]).optional(),
    lotSizes: z.record(symbol, z.number().finite().positive().max(1_000_000)).default({}),
    quantiles: z.array(z.number().finite().gt(0).lt(1)).min(1).max(19).default([0.05, 0.25, 0.5, 0.75, 0.95]),
    samplePathCount: z.number().int().min(0).max(100).default(10),
    calibrationOrigins: z.number().int().min(0).max(100).default(12),
  }).strict().default({
    method: "moving_block", studentTDegreesOfFreedom: 7, horizonDays: 252, pathCount: 10_000, blockLength: 20,
    seed: 12_345, inflationAnnualPercent: 0,
    rebalanceFrequency: "quarterly", lotSizes: {},
    quantiles: [0.05, 0.25, 0.5, 0.75, 0.95], samplePathCount: 10, calibrationOrigins: 12,
  }),
  stressScenarios: z.array(stressScenario).min(1).max(50).default([{ name: "기준 시나리오" }]),
  sensitivity: z.object({
    enabled: z.boolean().default(true),
    transactionCostShockBps: z.number().finite().min(0).max(500).default(25),
    includeZeroCashFlow: z.boolean().default(true),
    rebalanceModes: z.array(z.enum(["none", "monthly", "quarterly", "annually"])).min(1).max(4).default(["none", "quarterly"]),
  }).strict().default({
    enabled: true,
    transactionCostShockBps: 25,
    includeZeroCashFlow: true,
    rebalanceModes: ["none", "quarterly"],
  }),
  marketRegime: z.object({
    enabled: z.boolean().default(true),
    lookback: z.number().int().min(5).max(252).default(20),
  }).strict().default({ enabled: true, lookback: 20 }),
  confidenceWeights: z.object({
    oos: z.number().finite().min(0).max(1).default(0.45),
    monteCarloCalibration: z.number().finite().min(0).max(1).default(0.35),
    dataQuality: z.number().finite().min(0).max(1).default(0.20),
  }).strict().default({ oos: 0.45, monteCarloCalibration: 0.35, dataQuality: 0.20 }),
}).strict().superRefine((value, context) => {
  if (value.monteCarlo.pathCount * value.monteCarlo.horizonDays > 25_000_000) context.addIssue({ code: "custom", path: ["monteCarlo", "pathCount"], message: "pathCount × horizonDays는 25,000,000 이하여야 합니다." });
  if ((new Set(value.monteCarlo.quantiles).size + value.monteCarlo.samplePathCount) * (value.monteCarlo.horizonDays + 1) > 1_000_000) context.addIssue({ code: "custom", path: ["monteCarlo", "samplePathCount"], message: "요청한 percentile/sample path 출력점은 1,000,000개 이하여야 합니다." });
  if (value.monteCarlo.rebalanceFrequency === "threshold" && value.monteCarlo.rebalanceThresholdPercent === undefined) context.addIssue({ code: "custom", path: ["monteCarlo", "rebalanceThresholdPercent"], message: "threshold 기준이 필요합니다." });
  if (value.monteCarlo.cashWeight !== undefined && value.monteCarlo.cashWeight >= 1) context.addIssue({ code: "custom", path: ["monteCarlo", "cashWeight"], message: "투자자산 비중을 남기려면 현금 비중은 1보다 작아야 합니다." });
  if (new Set(value.walkForward.seeds).size !== value.walkForward.seeds.length) context.addIssue({ code: "custom", path: ["walkForward", "seeds"], message: "Walk-forward seed는 중복될 수 없습니다." });
  if (new Set(value.sensitivity.rebalanceModes).size !== value.sensitivity.rebalanceModes.length) context.addIssue({ code: "custom", path: ["sensitivity", "rebalanceModes"], message: "민감도 리밸런싱 방식은 중복될 수 없습니다." });
  if (value.walkForward.foldCandidateBudget < value.walkForward.seeds.length) context.addIssue({ code: "custom", path: ["walkForward", "foldCandidateBudget"], message: "fold 후보 예산은 seed 수 이상이어야 합니다." });
  const confidenceTotal = value.confidenceWeights.oos + value.confidenceWeights.monteCarloCalibration + value.confidenceWeights.dataQuality;
  if (!(confidenceTotal > 0)) context.addIssue({ code: "custom", path: ["confidenceWeights"], message: "신뢰도 가중치 중 하나 이상은 0보다 커야 합니다." });
  if (!value.optimization.enabled && value.optimization.regimePolicySearch.enabled) context.addIssue({ code: "custom", path: ["optimization", "regimePolicySearch", "enabled"], message: "최적화를 끈 상태에서는 국면 정책을 탐색할 수 없습니다." });
  if (value.optimization.objective === "max_information_ratio"
    && !value.optimization.benchmark && value.baseConfig.benchmark === "NONE") {
    context.addIssue({ code: "custom", path: ["optimization", "benchmark"], message: "Information Ratio 전망에는 최적화 또는 baseConfig 벤치마크가 필요합니다." });
  }
  if (value.optimization.benchmark
    && !value.baseConfig.assets.some((asset) => asset.symbol === value.optimization.benchmark)
    && value.baseConfig.assets.length >= 20) {
    context.addIssue({ code: "custom", path: ["optimization", "benchmark"], message: "벤치마크를 포함한 시계열 수는 20개 이하여야 합니다." });
  }
});

const exposureAsset = z.object({
  symbol,
  weight: z.number().finite().gt(0).max(1),
  currency: z.string().trim().regex(/^[A-Z]{3}$/),
  sector: z.string().trim().min(1).max(100).optional(),
  industry: z.string().trim().min(1).max(100).optional(),
  country: z.string().trim().min(2).max(100).optional(),
  assetType: z.string().trim().min(1).max(100).optional(),
  hedged: z.boolean().optional(),
  factors: z.record(z.string().trim().min(1).max(80), z.number().finite()).default({}),
  constituents: z.array(z.object({
    symbol,
    weight: z.number().finite().gt(0).max(1),
    sector: z.string().trim().min(1).max(100).optional(),
    industry: z.string().trim().min(1).max(100).optional(),
    country: z.string().trim().min(2).max(100).optional(),
    currency: z.string().trim().regex(/^[A-Z]{3}$/).optional(),
    assetType: z.string().trim().min(1).max(100).optional(),
    hedged: z.boolean().optional(),
    factors: z.record(z.string().trim().min(1).max(80), z.number().finite()).default({}),
  }).strict()).max(5_000).optional(),
}).strict().superRefine((value, context) => {
  const constituentWeight = value.constituents?.reduce((sum, item) => sum + item.weight, 0) ?? 0;
  if (constituentWeight > 1 + 1e-12) {
    context.addIssue({ code: "custom", path: ["constituents"], message: "구성종목 비중 합계는 1을 초과할 수 없습니다." });
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
  validate_backtest_config: backtestValidationExecution,
  run_portfolio_backtest: backtestExecution,
  compare_backtests: z.object({ runIds: z.array(runId).min(2).max(20) }).strict(),
  get_backtest_artifact: z.object({ runId, type: z.enum(["equity", "drawdown", "holdings", "trades", "cash-ledger", "cash-flows", "dividends", "target-weight-schedule", "data-quality", "rolling", "correlation", "risk-contribution", "monthly-returns"]) }).strict(),
  get_run_artifact: z.object({ runId, type: z.string().trim().min(1).max(64) }).strict(),
  get_current_portfolio: z.object({ accountSelector: z.string().trim().min(8).max(128).optional() }).strict(),
  find_diversifying_assets: diversifyingAssets,
  analyze_market_regimes: z.object({ benchmark: symbol, ...period, currencyMode, volatilityWindow: z.number().int().min(5).max(252).default(20) }).strict(),
  analyze_return_contribution: z.object({ runId }).strict(),
  optimize_portfolio: optimizationExecution,
  walk_forward_optimize: walkForwardExecution,
  stress_test_portfolio: z.object({ baseConfig: backtestWithoutReport, scenarios: z.array(stressScenario).min(1).max(50) }).strict(),
  build_pareto_frontier: z.object({ runId, limit: z.number().int().min(1).max(1_000).default(100), executionMode }).strict(),
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
    method: z.enum(["moving_block", "stationary", "regime_conditioned", "student_t"]).default("moving_block"),
    stationaryRestartProbability: z.number().finite().gt(0).lte(1).optional(),
    studentTDegreesOfFreedom: z.number().finite().gt(2).max(100).default(7),
    rebalanceFrequency: z.enum(["none", "monthly", "quarterly", "annually", "threshold"]).default("none"),
    rebalanceThresholdPercent: z.number().finite().min(0.1).max(50).optional(),
    cashWeight: z.number().finite().min(0).max(1).default(0),
    cashAnnualYieldPercent: z.number().finite().min(-100).max(100).default(0),
    transactionCostBps: z.number().finite().min(0).max(500).default(0),
    periodicCashFlow: z.number().finite().min(-1e12).max(1e12).default(0),
    cashFlowFrequencyDays: z.number().int().min(1).max(25_200).default(21),
    inflationAnnualPercent: z.number().finite().min(-20).max(100).default(0),
    quantityMode: z.enum(["fractional", "whole"]).default("fractional"),
    lotSizes: z.record(symbol, z.number().finite().positive().max(1_000_000)).default({}),
    calibrationOrigins: z.number().int().min(0).max(100).default(0),
  }).strict().superRefine((value, context) => {
    if (value.fromDate > value.toDate) context.addIssue({ code: "custom", path: ["fromDate"], message: "시작일이 종료일보다 늦습니다." });
    const total = value.symbols.reduce((sum, item) => sum + (value.weights[item] ?? 0), 0);
    if (Math.abs(total - 1) > 0.0001) context.addIssue({ code: "custom", path: ["weights"], message: "선택 종목 비중 합계는 1이어야 합니다." });
    if (value.pathCount * value.horizonDays > 25_000_000) context.addIssue({ code: "custom", path: ["pathCount"], message: "pathCount × horizonDays는 25,000,000 이하여야 합니다." });
    if ((new Set(value.quantiles).size + value.samplePathCount) * (value.horizonDays + 1) > 1_000_000) context.addIssue({ code: "custom", path: ["samplePathCount"], message: "요청한 percentile/sample path 출력점은 1,000,000개 이하여야 합니다." });
    if (value.rebalanceFrequency === "threshold" && value.rebalanceThresholdPercent === undefined) context.addIssue({ code: "custom", path: ["rebalanceThresholdPercent"], message: "threshold 기준이 필요합니다." });
    if (value.cashWeight >= 1) context.addIssue({ code: "custom", path: ["cashWeight"], message: "투자자산 비중을 남기려면 현금 비중은 1보다 작아야 합니다." });
  }),
  analyze_portfolio_outlook: outlook,
  analyze_portfolio_exposures: z.object({ assets: z.array(exposureAsset).min(1).max(100), lookThrough: z.boolean().default(true), executionMode }).strict().superRefine((value, context) => {
    const total = value.assets.reduce((sum, item) => sum + item.weight, 0);
    if (Math.abs(total - 1) > 0.0001) context.addIssue({ code: "custom", path: ["assets"], message: "자산 비중 합계는 1이어야 합니다." });
  }),
  explain_data_quality: z.object({ symbols: z.array(symbol).min(1).max(20), benchmark: symbol.optional(), ...period, adjusted: z.boolean().default(true), currencyMode }).strict().superRefine((value, context) => {
    if (value.fromDate > value.toDate) context.addIssue({ code: "custom", path: ["fromDate"], message: "시작일이 종료일보다 늦습니다." });
    if (new Set([...value.symbols, ...(value.benchmark ? [value.benchmark] : [])]).size > 20) context.addIssue({ code: "custom", path: ["benchmark"], message: "벤치마크를 포함한 종목 수는 20개 이하여야 합니다." });
  }),
  get_run_status: z.object({ runId }).strict(),
  cancel_run: z.object({ runId }).strict(),
  get_run_result: z.object({ runId }).strict(),
  list_runs: runListFilter,
  get_run_events: z.object({ runId, cursor: z.string().trim().max(200).optional(), limit: z.number().int().min(1).max(200).default(100) }).strict(),
  export_run_manifest: z.object({ runId }).strict(),
  update_run: z.object({ runId, name: z.string().trim().min(1).max(120).optional(), tags: z.array(tag).max(20).optional(), archived: z.boolean().optional() }).strict().refine((value) => value.name !== undefined || value.tags !== undefined || value.archived !== undefined, "변경할 필드가 필요합니다."),
  duplicate_run: z.object({ runId, name: z.string().trim().min(1).max(120).optional() }).strict(),
  delete_run: z.object({ runId }).strict(),
  rerun_run: z.object({ runId }).strict(),
  list_portfolio_presets: z.object({ query: z.string().trim().max(120).optional(), tags: z.array(tag).max(20).default([]), cursor: z.string().trim().max(200).optional(), limit: z.number().int().min(1).max(100).default(25) }).strict(),
  get_portfolio_preset: z.object({ presetId, includeHistory: z.boolean().default(false) }).strict(),
  create_portfolio_preset: presetCreate,
  update_portfolio_preset: presetUpdate,
  duplicate_portfolio_preset: z.object({ presetId, name: z.string().trim().min(1).max(120).optional() }).strict(),
  delete_portfolio_preset: z.object({ presetId }).strict(),
  import_portfolio_presets: z.object({ document: z.unknown(), conflictMode: z.enum(["rename", "replace", "skip"]).default("rename") }).strict(),
  export_portfolio_preset: z.object({ presetId }).strict(),
  generate_backtest_report: z.object({ runId, failureMode: z.enum(["warn", "fail"]).default("fail") }).strict(),
  generate_research_report: z.object({ runId, format: z.enum(["json", "markdown"]).default("markdown"), title: z.string().trim().min(1).max(200).optional(), executionMode }).strict(),
  get_report: z.object({ reportId: z.string().uuid() }).strict(),
} as const;

export type ToolName = keyof typeof toolSchemas;
