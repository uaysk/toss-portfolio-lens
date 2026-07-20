import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { TechnicalAnalysisWorkerResultSchema } from "./technical-analysis-contract.js";

export const TECHNICAL_STRATEGY_SCHEMA_VERSION = "technical-strategy/v1" as const;
export const TECHNICAL_STRATEGY_RESULT_SCHEMA_VERSION = "technical-strategy-result/v1" as const;
export const TECHNICAL_STRATEGY_CACHE_SCHEMA_VERSION = "technical-strategy-cache/v1" as const;
export const MAX_TECHNICAL_CONDITION_DEPTH = 16;
export const MAX_TECHNICAL_CONDITION_NODES = 256;
export const MAX_TECHNICAL_HOLDING_OR_COOLDOWN = 10_000;

const finite = z.number().finite();
const nullableFinite = finite.nullable();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, "유효한 ISO 날짜가 필요합니다.");
const state = z.enum(["active", "inactive"]);
const weights = z.record(z.string().min(1).max(128), finite.min(0).max(100));
const backtestPoint = z.object({
  date,
  balance: finite,
  growth: finite,
  benchmarkGrowth: finite.optional(),
  drawdownPercent: finite,
  investedBalance: finite.optional(),
  cashBalance: finite.optional(),
  unitPrice: finite.optional(),
}).passthrough();
const backtestContribution = z.object({
  symbol: z.string().min(1),
  name: z.string(),
  market: z.string().min(1),
  currency: z.string().min(1),
  weight: finite,
  endingValue: finite,
  profitLoss: finite,
  contributionPercent: finite,
  timeLinkedContributionPercent: finite,
  localPriceContributionPercent: finite,
  fxContributionPercent: finite,
  upRegimeContributionPercent: finite,
  downRegimeContributionPercent: finite,
  assetReturnPercent: finite,
}).passthrough();
const backtestAsset = z.object({
  symbol: z.string().min(1),
  name: z.string().min(1),
  market: z.string().min(1),
  currency: z.enum(["KRW", "USD"]),
  listDate: date,
  weight: finite.min(0).max(100),
}).passthrough();
const backtestConfigAsset = z.object({
  symbol: z.string().min(1),
  weight: finite.min(0).max(100),
  lotSize: finite.positive().optional(),
  delistDate: date.optional(),
  universeMemberFrom: date.optional(),
  universeMemberTo: date.optional(),
}).strict();
const executionPolicy = z.object({
  cashTargetPercent: finite.min(0).max(100),
  quantityMode: z.enum(["fractional", "whole"]),
  cashFlowRebalanceMode: z.enum(["target_weights", "drift_reduction", "full"]),
  tradeDatePolicy: z.literal("next_common_observation"),
  cashAnnualYieldPercent: finite.min(-100).max(100),
}).passthrough();
const finalizedBacktestConfig = z.object({
  assets: z.array(backtestConfigAsset).min(1).max(20),
  startDate: date,
  endDate: date,
  initialAmount: finite.positive(),
  monthlyCashFlow: finite,
  cashFlowFrequency: z.enum(["monthly", "quarterly", "annually"]),
  cashFlowTiming: z.enum(["period_start", "period_end"]),
  rebalanceFrequency: z.enum(["none", "monthly", "quarterly", "annually", "threshold"]),
  rebalanceThresholdPercent: finite.optional(),
  riskFreeRatePercent: finite,
  transactionCostBps: finite.nonnegative(),
  cashFlows: z.array(z.unknown()),
  targetWeightSchedule: z.array(z.unknown()),
  execution: executionPolicy,
  realism: z.record(z.string(), z.unknown()),
  currencyMode: z.enum(["local", "KRW"]),
  baseCurrency: z.literal("KRW"),
  benchmark: z.enum(["NONE", "KOSPI", "KOSDAQ", "NASDAQ100", "SP500", "CUSTOM"]),
  benchmarkSymbol: z.string().optional(),
  requestedStartDate: date,
  latestMetadataListDate: date,
  effectiveStartDate: date,
  effectiveEndDate: date,
}).passthrough();
const comparableMetrics = z.object({
  totalReturnPercent: finite,
  cagrPercent: nullableFinite,
  annualizedVolatilityPercent: nullableFinite,
  maxDrawdownPercent: finite,
  maxDrawdownDays: z.number().int().nonnegative(),
  sharpeRatio: nullableFinite,
  sortinoRatio: nullableFinite,
  calmarRatio: nullableFinite,
  bestDailyReturnPercent: nullableFinite,
  worstDailyReturnPercent: nullableFinite,
  positiveDaysPercent: nullableFinite,
  bestYearPercent: nullableFinite,
  worstYearPercent: nullableFinite,
  positiveMonthsPercent: nullableFinite,
}).strict();
const backtestMetrics = comparableMetrics.extend({
  finalBalance: finite,
  totalContributions: finite,
  totalWithdrawals: finite,
  endingCashBalance: finite,
  endingCashWeightPercent: finite,
  investedBalance: finite,
  totalTransactionCosts: finite,
  totalDividendIncome: finite,
  totalDividendTaxes: finite,
  netProfitLoss: finite,
  moneyWeightedReturnPercent: nullableFinite,
}).passthrough();
const backtestTrade = z.object({
  date,
  symbol: z.string().min(1),
  side: z.enum(["BUY", "SELL"]),
  amount: finite.nonnegative(),
  quantity: finite.nonnegative(),
  price: finite.nonnegative(),
  reason: z.string().min(1),
  transactionCost: finite.nonnegative(),
  commission: finite.nonnegative(),
  tax: finite.nonnegative(),
  slippageCost: finite.nonnegative(),
  marketImpactCost: finite.nonnegative(),
  participationRatePercent: finite.optional(),
  netCashImpact: finite,
  trigger: z.string(),
  lotSize: finite.positive(),
}).passthrough();
const appliedCashFlow = z.object({
  scheduledDate: date,
  effectiveDate: date,
  amount: finite,
  source: z.string().min(1),
  memo: z.string().optional(),
}).strict();
const dividend = z.object({
  date,
  symbol: z.string().min(1),
  quantity: finite.nonnegative(),
  amountPerShare: finite,
  grossAmount: finite,
  tax: finite,
  netAmount: finite,
}).strict();
const backtestDataQuality = z.object({
  alignmentPolicy: z.literal("carry_forward_for_valuation"),
  commonReturnPolicy: z.literal("inner_join"),
  alignedValuationDays: z.number().int().nonnegative(),
  commonReturnObservations: z.number().int().nonnegative(),
  carryForwardByAsset: z.array(z.object({ symbol: z.string().min(1), count: z.number().int().nonnegative() }).strict()),
  benchmarkCarryForwardCount: z.number().int().nonnegative(),
  dividendStatus: z.string().min(1),
  liquidityStatus: z.string().min(1),
  liquidityTradeObservations: z.number().int().nonnegative(),
  missingLiquidityObservations: z.number().int().nonnegative(),
  pointInTimeUniverseStatus: z.string().min(1),
  warnings: z.array(z.string()),
  instrumentDateConsistency: z.array(z.unknown()),
}).passthrough();
const advancedAnalytics = z.object({
  rolling: z.array(z.object({ date }).passthrough()),
  drawdowns: z.object({
    points: z.array(z.object({ date, drawdownPercent: finite }).strict()),
    episodes: z.array(z.unknown()),
    currentUnderwaterDays: z.number().int().nonnegative(),
    averageDrawdownPercent: nullableFinite,
    ulcerIndex: nullableFinite,
    worst20DayReturnPercent: nullableFinite,
    worst60DayReturnPercent: nullableFinite,
  }).passthrough(),
  tailRisk: z.object({
    historicalVar95Percent: nullableFinite,
    expectedShortfall95Percent: nullableFinite,
    lossDaysPercent: nullableFinite,
    averageGainPercent: nullableFinite,
    averageLossPercent: nullableFinite,
    gainLossRatio: nullableFinite,
    skewness: nullableFinite,
    excessKurtosis: nullableFinite,
    maxConsecutiveGainDays: z.number().int().nonnegative(),
    maxConsecutiveLossDays: z.number().int().nonnegative(),
  }).passthrough(),
  monthlyReturns: z.array(z.object({ month: z.string().min(1), returnPercent: finite }).strict()),
  riskContributions: z.array(z.object({
    key: z.string().min(1), symbol: z.string().min(1), name: z.string(),
    averageWeightPercent: finite, endingWeightPercent: finite,
    annualizedVolatilityPercent: nullableFinite, riskContributionPercent: nullableFinite,
    correlationToPortfolio: nullableFinite,
  }).passthrough()),
  exposure: z.object({
    krwWeightPercent: finite, usdWeightPercent: finite, domesticWeightPercent: finite,
    overseasWeightPercent: finite, top1WeightPercent: finite, top5WeightPercent: finite,
    top10WeightPercent: finite, hhi: finite, effectivePositions: nullableFinite,
    diversificationBenefitPercent: nullableFinite,
  }).passthrough(),
  costEfficiency: z.object({
    transactionCostBps: finite, turnoverPercent: nullableFinite, totalTradedAmount: finite,
    ongoingTradedAmount: finite, estimatedTotalCost: finite, actualTotalCost: finite,
    costDragPercent: nullableFinite, grossReturnPercent: nullableFinite,
    netEstimatedReturnPercent: finite, netReturnPercent: finite,
    costsDeductedFromPath: z.boolean(), method: z.string().min(1),
    averageTradeAmount: nullableFinite, buySellAmountRatio: nullableFinite,
    tradeCount: z.number().int().nonnegative(), monthly: z.array(z.unknown()),
  }).passthrough(),
  tradeBehavior: z.object({
    estimatedRealizedProfitLoss: finite, estimatedWinRatePercent: nullableFinite,
    estimatedProfitFactor: nullableFinite, estimatedAverageHoldingDays: nullableFinite,
    matchedSellCount: z.number().int().nonnegative(), unmatchedSellCount: z.number().int().nonnegative(),
    buyCount: z.number().int().nonnegative(), sellCount: z.number().int().nonnegative(),
  }).passthrough(),
  dataQuality: z.object({
    confidence: z.enum(["high", "medium", "limited"]), observationDays: z.number().int().nonnegative(),
    returnObservationDays: z.number().int().nonnegative(), requestedCalendarDays: z.number().int().nonnegative(),
    effectiveStartDate: date, effectiveEndDate: date, commonCoveragePercent: finite,
    carriedForwardObservations: z.number().int().nonnegative(), benchmarkObservations: z.number().int().nonnegative(),
    assets: z.array(z.unknown()), notes: z.array(z.string()),
  }).passthrough(),
}).passthrough();

export const TechnicalSignalSchema = z.object({
  signal_id: z.string().min(1).max(128),
  transition: z.enum(["activate", "deactivate"]),
  calculation_date: date,
  signal_date: date,
  planned_trade_date: date.nullable(),
  actual_application_date: date.nullable(),
  from_state: state,
  to_state: state,
  target_weights: weights,
  cash_target_percent: finite.min(0).max(100),
  status: z.enum(["planned", "applied", "no_safe_trade_date"]),
}).strict().superRefine((signal, context) => {
  if ((signal.transition === "activate" && (signal.from_state !== "inactive" || signal.to_state !== "active"))
    || (signal.transition === "deactivate" && (signal.from_state !== "active" || signal.to_state !== "inactive"))) {
    context.addIssue({ code: "custom", path: ["transition"], message: "transition과 from/to state가 일치하지 않습니다." });
  }
  if (signal.calculation_date !== signal.signal_date) {
    context.addIssue({ code: "custom", path: ["signal_date"], message: "종가 신호일과 계산 기준일이 일치해야 합니다." });
  }
  if (signal.planned_trade_date !== null && signal.planned_trade_date <= signal.calculation_date) {
    context.addIssue({ code: "custom", path: ["planned_trade_date"], message: "예정 거래일은 계산 기준일보다 엄격히 뒤여야 합니다." });
  }
  if (signal.actual_application_date !== null && signal.planned_trade_date === null) {
    context.addIssue({ code: "custom", path: ["actual_application_date"], message: "예정 거래일 없이 실제 적용일을 반환할 수 없습니다." });
  }
  if (signal.actual_application_date !== null && signal.planned_trade_date !== null
    && signal.actual_application_date < signal.planned_trade_date) {
    context.addIssue({ code: "custom", path: ["actual_application_date"], message: "실제 적용일은 예정 거래일보다 빠를 수 없습니다." });
  }
  if (signal.status === "no_safe_trade_date" && signal.planned_trade_date !== null) {
    context.addIssue({ code: "custom", path: ["status"], message: "안전 거래일 없음 상태에는 예정 거래일이 없어야 합니다." });
  }
  if (signal.status === "planned" && (signal.planned_trade_date === null || signal.actual_application_date !== null)) {
    context.addIssue({ code: "custom", path: ["status"], message: "planned 상태의 날짜 조합이 올바르지 않습니다." });
  }
  if (signal.status === "applied" && (signal.planned_trade_date === null || signal.actual_application_date === null)) {
    context.addIssue({ code: "custom", path: ["status"], message: "applied 상태에는 예정·실제 적용일이 모두 필요합니다." });
  }
});

export const TechnicalTargetWeightScheduleSchema = z.object({
  date,
  weights,
  cashTargetPercent: finite.min(0).max(100),
  regime: z.string().min(1).max(80).optional(),
  action: z.string().min(1).max(128).optional(),
}).strict();

export const AppliedTargetWeightScheduleSchema = z.object({
  scheduledDate: date,
  effectiveDate: date,
  weights,
  cashTargetPercent: finite.min(0).max(100),
  regime: z.string().min(1).max(80).optional(),
  action: z.string().min(1).max(128).optional(),
}).strict();

export const TechnicalStrategyDiagnosticsSchema = z.object({
  validation: z.literal("passed"),
  condition_value_policy: z.string().min(1),
  between_policy: z.string().min(1),
  crossing_policy: z.string().min(1),
  signal_timing_policy: z.string().min(1),
  safe_trade_date_source: z.string().min(1),
  evaluation_start_date: date,
  evaluation_end_date: date,
  safe_trade_date_count: z.number().int().nonnegative(),
  condition_node_count: z.number().int().min(1).max(MAX_TECHNICAL_CONDITION_NODES),
  active_unknown_count: z.number().int().nonnegative(),
  inactive_unknown_count: z.number().int().nonnegative(),
  minimum_holding_suppressed_count: z.number().int().nonnegative(),
  cooldown_suppressed_count: z.number().int().nonnegative(),
  pending_suppressed_count: z.number().int().nonnegative(),
}).strict();

export const TechnicalStrategyEvaluationSchema = z.object({
  schema_version: z.literal(TECHNICAL_STRATEGY_RESULT_SCHEMA_VERSION),
  strategy_schema_version: z.literal(TECHNICAL_STRATEGY_SCHEMA_VERSION),
  initial_state: state,
  signals: z.array(TechnicalSignalSchema).max(10_000),
  target_weight_schedule: z.array(TechnicalTargetWeightScheduleSchema).max(10_000),
  diagnostics: TechnicalStrategyDiagnosticsSchema,
}).strict();

/**
 * The ledger result already has a large stable public shape. Keep that body
 * forward-compatible while validating every field used for signal provenance
 * and UI rendering at the UDS/external-worker trust boundary.
 */
export const TechnicalStrategyBacktestResultSchema = z.object({
  generatedAt: z.string().datetime(),
  baseCurrency: z.literal("KRW"),
  currencyMethod: z.enum(["KRW_FX_CONVERTED", "LOCAL_RETURN"]),
  config: finalizedBacktestConfig,
  assets: z.array(backtestAsset).min(1),
  warnings: z.array(z.string()),
  requestedStartDate: date,
  effectiveStartDate: date,
  endDate: date,
  metrics: backtestMetrics,
  benchmarkMetrics: comparableMetrics.optional(),
  points: z.array(backtestPoint),
  annualReturns: z.array(z.object({ year: z.number().int(), returnPercent: finite }).strict()),
  contributions: z.array(backtestContribution),
  trades: z.array(backtestTrade),
  cashFlows: z.array(appliedCashFlow),
  dividends: z.array(dividend),
  execution: executionPolicy,
  dataQuality: backtestDataQuality,
  advanced: advancedAnalytics,
  correlations: z.object({ assets: z.array(z.unknown()), values: z.array(z.array(finite.nullable())) }).passthrough(),
  targetWeightSchedule: z.array(AppliedTargetWeightScheduleSchema),
}).passthrough();

export const TechnicalStrategyWorkerResultSchema = z.object({
  technical_analysis: TechnicalAnalysisWorkerResultSchema,
  technical_strategy: TechnicalStrategyEvaluationSchema,
  backtest: TechnicalStrategyBacktestResultSchema.optional(),
}).strict().superRefine((result, context) => {
  const combined = result.backtest !== undefined;
  if (result.technical_analysis.response_mode !== "full_series") {
    context.addIssue({ code: "custom", path: ["technical_analysis", "response_mode"], message: "기술 신호 평가는 full_series 결과가 필요합니다." });
  }
  const signalIds = result.technical_strategy.signals.map((signal) => signal.signal_id);
  if (new Set(signalIds).size !== signalIds.length) {
    context.addIssue({ code: "custom", path: ["technical_strategy", "signals"], message: "signal_id는 중복될 수 없습니다." });
  }
  const technicalScheduleKeys = result.technical_strategy.target_weight_schedule.map((entry) => `${entry.date}\u0000${entry.action ?? ""}`);
  if (new Set(technicalScheduleKeys).size !== technicalScheduleKeys.length) {
    context.addIssue({ code: "custom", path: ["technical_strategy", "target_weight_schedule"], message: "기술 target schedule date/action은 중복될 수 없습니다." });
  }
  const ledgerScheduleKeys = result.backtest?.targetWeightSchedule.map((entry) => `${entry.scheduledDate}\u0000${entry.action ?? ""}`) ?? [];
  if (new Set(ledgerScheduleKeys).size !== ledgerScheduleKeys.length) {
    context.addIssue({ code: "custom", path: ["backtest", "targetWeightSchedule"], message: "ledger schedule scheduledDate/action은 중복될 수 없습니다." });
  }
  const plannedSignals = result.technical_strategy.signals.filter((signal) => signal.planned_trade_date !== null);
  if (result.technical_strategy.target_weight_schedule.length !== plannedSignals.length) {
    context.addIssue({ code: "custom", path: ["technical_strategy", "target_weight_schedule"], message: "기술 신호와 target schedule 개수가 일치하지 않습니다." });
  }
  if (combined && result.backtest!.targetWeightSchedule.length !== plannedSignals.length) {
    context.addIssue({ code: "custom", path: ["backtest", "targetWeightSchedule"], message: "기술 신호와 ledger schedule 개수가 일치하지 않습니다." });
  }
  for (const [index, signal] of result.technical_strategy.signals.entries()) {
    if (combined && signal.status === "planned") {
      context.addIssue({ code: "custom", path: ["technical_strategy", "signals", index, "status"], message: "combined run은 planned 신호를 반환할 수 없습니다." });
    }
    if (!combined && signal.status === "applied") {
      context.addIssue({ code: "custom", path: ["technical_strategy", "signals", index, "status"], message: "signal-only run은 applied 신호를 반환할 수 없습니다." });
    }
    const technicalSchedule = signal.planned_trade_date === null ? undefined : result.technical_strategy.target_weight_schedule.find((entry) => (
      entry.date === signal.planned_trade_date && entry.action === signal.signal_id
    ));
    if (signal.planned_trade_date !== null && (!technicalSchedule
      || !isDeepStrictEqual(technicalSchedule.weights, signal.target_weights)
      || technicalSchedule.cashTargetPercent !== signal.cash_target_percent
      || technicalSchedule.regime !== signal.to_state)) {
      context.addIssue({ code: "custom", path: ["technical_strategy", "target_weight_schedule"], message: "신호와 기술 target schedule의 날짜·action·regime·allocation이 일치하지 않습니다." });
    }
    if (!combined || signal.status !== "applied") continue;
    const applied = result.backtest!.targetWeightSchedule.find((entry) => (
      entry.scheduledDate === signal.planned_trade_date && entry.action === signal.signal_id
    ));
    if (!applied || applied.effectiveDate !== signal.actual_application_date
      || !technicalSchedule
      || !isDeepStrictEqual(applied.weights, technicalSchedule.weights)
      || applied.cashTargetPercent !== technicalSchedule.cashTargetPercent
      || applied.regime !== technicalSchedule.regime) {
      context.addIssue({ code: "custom", path: ["technical_strategy", "signals", index], message: "신호의 예정·실제 적용일이 ledger schedule과 일치하지 않습니다." });
    }
  }
});

export type TechnicalStrategyWorkerResult = z.infer<typeof TechnicalStrategyWorkerResultSchema>;
export type TechnicalStrategyEvaluation = z.infer<typeof TechnicalStrategyEvaluationSchema>;
