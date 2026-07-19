import {
  calculateBacktestAdvancedAnalytics,
  type BacktestAdvancedAnalytics,
  type BacktestTradeEvent,
} from "./backtest-analytics.js";

export type BacktestRebalanceFrequency = "none" | "monthly" | "quarterly" | "annually" | "threshold";
export type BacktestCashFlowFrequency = "monthly" | "quarterly" | "annually";
export type BacktestCashFlowTiming = "period_start" | "period_end";

export type BacktestAssetDefinition = {
  symbol: string;
  name: string;
  market: string;
  currency: "KRW" | "USD";
  listDate: string;
  weight: number;
  lotSize?: number;
  delistDate?: string;
  universeMemberFrom?: string;
  universeMemberTo?: string;
};

export type BacktestPricePoint = {
  date: string;
  close: number;
  localClose?: number;
  fxRate?: number;
  volume?: number;
  cashDividend?: number;
};

export type BacktestRealismPolicy = {
  costs?: {
    commissionBps?: number;
    sellTaxBps?: number;
    fixedSlippageBps?: number;
    marketImpactCoefficient?: number;
    marketImpactExponent?: number;
    maxParticipationRatePercent?: number;
    minimumFee?: number;
    dividendTaxBps?: number;
  };
  dividendMode?: "adjusted_price_only" | "cash";
  enforcePointInTimeUniverse?: boolean;
};

export type BacktestTargetWeightScheduleEntry = {
  date: string;
  weights: Record<string, number>;
  cashTargetPercent?: number;
  regime?: string;
  action?: string;
};

export type BacktestBenchmarkDefinition = {
  key: string;
  name: string;
  prices: BacktestPricePoint[];
};

export type BacktestComparableMetrics = {
  totalReturnPercent: number;
  cagrPercent: number | null;
  annualizedVolatilityPercent: number | null;
  maxDrawdownPercent: number;
  maxDrawdownDays: number;
  sharpeRatio: number | null;
  sortinoRatio: number | null;
  calmarRatio: number | null;
  bestDailyReturnPercent: number | null;
  worstDailyReturnPercent: number | null;
  positiveDaysPercent: number | null;
  bestYearPercent: number | null;
  worstYearPercent: number | null;
  positiveMonthsPercent: number | null;
};

export type BacktestSimulationInput = {
  assets: BacktestAssetDefinition[];
  prices: ReadonlyMap<string, BacktestPricePoint[]>;
  observedDates?: ReadonlyMap<string, string[]>;
  requestedStartDate: string;
  endDate: string;
  initialAmount: number;
  monthlyCashFlow: number;
  cashFlowFrequency?: BacktestCashFlowFrequency;
  cashFlowTiming?: BacktestCashFlowTiming;
  rebalanceFrequency: BacktestRebalanceFrequency;
  riskFreeRatePercent?: number;
  transactionCostBps?: number;
  rebalanceThresholdPercent?: number;
  cashFlows?: Array<{ date: string; amount: number; memo?: string }>;
  targetWeightSchedule?: BacktestTargetWeightScheduleEntry[];
  execution?: {
    cashTargetPercent?: number;
    quantityMode?: "fractional" | "whole";
    cashFlowRebalanceMode?: "target_weights" | "drift_reduction" | "full";
    tradeDatePolicy?: "next_common_observation";
    cashAnnualYieldPercent?: number;
  };
  realism?: BacktestRealismPolicy;
  benchmark?: BacktestBenchmarkDefinition;
};

export type BacktestSimulationResult = {
  requestedStartDate: string;
  effectiveStartDate: string;
  endDate: string;
  points: Array<{
    date: string;
    balance: number;
    growth: number;
    benchmarkGrowth?: number;
    drawdownPercent: number;
    cashBalance?: number;
    investedBalance?: number;
    unitPrice?: number;
  }>;
  metrics: BacktestComparableMetrics & {
    finalBalance: number;
    totalContributions: number;
    totalWithdrawals: number;
    endingCashBalance?: number;
    endingCashWeightPercent?: number;
    investedBalance?: number;
    totalTransactionCosts?: number;
    totalDividendIncome?: number;
    totalDividendTaxes?: number;
    netProfitLoss?: number;
    moneyWeightedReturnPercent?: number | null;
  };
  benchmarkMetrics?: BacktestComparableMetrics;
  annualReturns: Array<{ year: number; returnPercent: number }>;
  contributions: Array<{
    symbol: string;
    name: string;
    market: string;
    currency: "KRW" | "USD";
    weight: number;
    endingValue: number;
    profitLoss: number;
    contributionPercent: number;
    timeLinkedContributionPercent: number;
    localPriceContributionPercent: number;
    fxContributionPercent: number;
    upRegimeContributionPercent: number;
    downRegimeContributionPercent: number;
    assetReturnPercent: number;
  }>;
  correlations: {
    assets: Array<{ symbol: string; name: string }>;
    values: Array<Array<number | null>>;
  };
  trades: Array<{
    date: string;
    symbol: string;
    side: "BUY" | "SELL";
    amount: number;
    quantity: number;
    price: number;
    reason: string;
    transactionCost?: number;
    commission?: number;
    tax?: number;
    slippageCost?: number;
    marketImpactCost?: number;
    participationRatePercent?: number;
    netCashImpact?: number;
    trigger?: string;
    lotSize?: number;
  }>;
  cashFlows?: Array<{ scheduledDate: string; effectiveDate: string; amount: number; source: string; memo?: string }>;
  targetWeightSchedule?: Array<{
    scheduledDate: string;
    effectiveDate: string;
    weights: Record<string, number>;
    cashTargetPercent: number;
    regime?: string;
    action?: string;
  }>;
  dividends?: Array<{
    date: string;
    symbol: string;
    quantity: number;
    amountPerShare: number;
    grossAmount: number;
    tax: number;
    netAmount: number;
  }>;
  execution?: NonNullable<BacktestSimulationInput["execution"]>;
  dataQuality: {
    alignmentPolicy: "carry_forward_for_valuation";
    commonReturnPolicy: "inner_join";
    alignedValuationDays: number;
    commonReturnObservations: number;
    carryForwardByAsset: Array<{ symbol: string; count: number }>;
    benchmarkCarryForwardCount: number;
    dividendStatus?: "adjusted_price_policy" | "provider_supplied" | "unavailable";
    liquidityStatus?: "not_requested" | "provider_supplied" | "partial_or_unavailable";
    liquidityTradeObservations?: number;
    missingLiquidityObservations?: number;
    pointInTimeUniverseStatus?: "explicit_input_enforced" | "provider_supplied_enforced" | "not_enforced";
    warnings?: string[];
  };
  advanced: BacktestAdvancedAnalytics;
};

export class BacktestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BacktestValidationError";
  }
}

function keyForAsset(asset: Pick<BacktestAssetDefinition, "currency" | "symbol">): string {
  return `${asset.currency}:${asset.symbol}`;
}

function round(value: number, digits = 4): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function dateDays(from: string, to: string): number {
  return Math.max(0, Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000));
}

function yearMonth(date: string): string {
  return date.slice(0, 7);
}

function cashFlowDue(
  previousDate: string,
  currentDate: string,
  nextDate: string | undefined,
  frequency: BacktestCashFlowFrequency,
  timing: BacktestCashFlowTiming,
): boolean {
  const month = Number(currentDate.slice(5, 7));
  const interval = frequency === "monthly" ? 1 : frequency === "quarterly" ? 3 : 12;
  if (timing === "period_start") {
    if (yearMonth(previousDate) === yearMonth(currentDate)) return false;
    return (month - 1) % interval === 0;
  }
  const atObservedPeriodEnd = !nextDate || yearMonth(currentDate) !== yearMonth(nextDate);
  return atObservedPeriodEnd && month % interval === 0;
}

function shouldRebalance(previousDate: string, currentDate: string, frequency: BacktestRebalanceFrequency): boolean {
  if (frequency === "none" || frequency === "threshold") return false;
  const previousYear = Number(previousDate.slice(0, 4));
  const currentYear = Number(currentDate.slice(0, 4));
  if (frequency === "annually") return previousYear !== currentYear;
  const previousMonth = Number(previousDate.slice(5, 7));
  const currentMonth = Number(currentDate.slice(5, 7));
  if (frequency === "quarterly") {
    return previousYear !== currentYear || Math.floor((previousMonth - 1) / 3) !== Math.floor((currentMonth - 1) / 3);
  }
  return previousYear !== currentYear || previousMonth !== currentMonth;
}

function commonObservedReturns(
  seriesByAsset: BacktestPricePoint[][],
  observedByAsset: ReadonlySet<string>[],
): { returns: number[][]; observations: number } {
  if (!seriesByAsset.length) return { returns: [], observations: 0 };
  const maps = seriesByAsset.map((series, index) => new Map(
    series.filter((point) => observedByAsset[index].has(point.date)).map((point) => [point.date, point.close]),
  ));
  const commonDates = Array.from(observedByAsset[0])
    .filter((date) => maps.every((values) => values.has(date)))
    .sort();
  const returns = seriesByAsset.map(() => [] as number[]);
  for (let index = 1; index < commonDates.length; index += 1) {
    const previousDate = commonDates[index - 1];
    const currentDate = commonDates[index];
    for (let assetIndex = 0; assetIndex < maps.length; assetIndex += 1) {
      const previous = maps[assetIndex].get(previousDate) ?? 0;
      const current = maps[assetIndex].get(currentDate) ?? 0;
      if (previous > 0 && current > 0) returns[assetIndex].push(current / previous - 1);
    }
  }
  return { returns, observations: Math.max(0, commonDates.length - 1) };
}

function standardDeviation(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function pearson(left: number[], right: number[]): number | null {
  if (left.length !== right.length || left.length < 2) return null;
  const leftMean = left.reduce((sum, value) => sum + value, 0) / left.length;
  const rightMean = right.reduce((sum, value) => sum + value, 0) / right.length;
  let covariance = 0;
  let leftVariance = 0;
  let rightVariance = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftDelta = left[index] - leftMean;
    const rightDelta = right[index] - rightMean;
    covariance += leftDelta * rightDelta;
    leftVariance += leftDelta ** 2;
    rightVariance += rightDelta ** 2;
  }
  const denominator = Math.sqrt(leftVariance * rightVariance);
  return denominator > 0 ? round(covariance / denominator, 4) : null;
}

function summarizeGrowthSeries(
  points: Array<{ date: string; value: number }>,
  dailyReturns: number[],
  riskFreeRatePercent: number,
): { metrics: BacktestComparableMetrics; annualReturns: Array<{ year: number; returnPercent: number }> } {
  const initialValue = points[0].value;
  const finalValue = points.at(-1)!.value;
  let peak = initialValue;
  let peakDate = points[0].date;
  let maxDrawdown = 0;
  let maxDrawdownDays = 0;
  for (const point of points) {
    if (point.value >= peak) {
      peak = point.value;
      peakDate = point.date;
    }
    const drawdown = peak > 0 ? point.value / peak - 1 : 0;
    if (drawdown < maxDrawdown) maxDrawdown = drawdown;
    if (drawdown < 0) maxDrawdownDays = Math.max(maxDrawdownDays, dateDays(peakDate, point.date));
  }

  const annualReturns: Array<{ year: number; returnPercent: number }> = [];
  const yearEndPoints = new Map<string, (typeof points)[number]>();
  for (const point of points) yearEndPoints.set(point.date.slice(0, 4), point);
  let previousYearValue = initialValue;
  for (const [year, point] of Array.from(yearEndPoints.entries()).sort()) {
    annualReturns.push({ year: Number(year), returnPercent: round((point.value / previousYearValue - 1) * 100) });
    previousYearValue = point.value;
  }

  const monthEndPoints = new Map<string, (typeof points)[number]>();
  for (const point of points) monthEndPoints.set(yearMonth(point.date), point);
  let previousMonthValue = initialValue;
  const monthlyReturns: number[] = [];
  for (const point of Array.from(monthEndPoints.values())) {
    monthlyReturns.push(point.value / previousMonthValue - 1);
    previousMonthValue = point.value;
  }

  const elapsedYears = dateDays(points[0].date, points.at(-1)!.date) / 365.25;
  const totalReturn = finalValue / initialValue - 1;
  const dailyVolatility = standardDeviation(dailyReturns);
  const meanDailyReturn = dailyReturns.length
    ? dailyReturns.reduce((sum, value) => sum + value, 0) / dailyReturns.length
    : 0;
  const dailyRiskFree = (1 + riskFreeRatePercent / 100) ** (1 / 252) - 1;
  const excessReturns = dailyReturns.map((value) => value - dailyRiskFree);
  const meanDailyExcessReturn = excessReturns.length
    ? excessReturns.reduce((sum, value) => sum + value, 0) / excessReturns.length
    : 0;
  const downsideDeviation = excessReturns.length
    ? Math.sqrt(excessReturns.reduce((sum, value) => sum + Math.min(value, 0) ** 2, 0) / excessReturns.length)
    : 0;
  const cagrPercent = elapsedYears > 0 && finalValue > 0
    ? round(((finalValue / initialValue) ** (1 / elapsedYears) - 1) * 100)
    : null;
  const maxDrawdownPercent = round(maxDrawdown * 100);

  return {
    metrics: {
      totalReturnPercent: round(totalReturn * 100),
      cagrPercent,
      annualizedVolatilityPercent: dailyReturns.length > 1
        ? round(dailyVolatility * Math.sqrt(252) * 100)
        : null,
      maxDrawdownPercent,
      maxDrawdownDays,
      sharpeRatio: dailyVolatility > 0 ? round((meanDailyExcessReturn / dailyVolatility) * Math.sqrt(252)) : null,
      sortinoRatio: downsideDeviation > 0 ? round((meanDailyExcessReturn / downsideDeviation) * Math.sqrt(252)) : null,
      calmarRatio: cagrPercent !== null && maxDrawdownPercent < 0 ? round(cagrPercent / Math.abs(maxDrawdownPercent)) : null,
      bestDailyReturnPercent: dailyReturns.length ? round(Math.max(...dailyReturns) * 100) : null,
      worstDailyReturnPercent: dailyReturns.length ? round(Math.min(...dailyReturns) * 100) : null,
      positiveDaysPercent: dailyReturns.length
        ? round((dailyReturns.filter((value) => value > 0).length / dailyReturns.length) * 100)
        : null,
      bestYearPercent: annualReturns.length ? Math.max(...annualReturns.map((item) => item.returnPercent)) : null,
      worstYearPercent: annualReturns.length ? Math.min(...annualReturns.map((item) => item.returnPercent)) : null,
      positiveMonthsPercent: monthlyReturns.length
        ? round((monthlyReturns.filter((value) => value > 0).length / monthlyReturns.length) * 100)
        : null,
    },
    annualReturns,
  };
}

export function simulateBacktest(input: BacktestSimulationInput): BacktestSimulationResult {
  if (input.targetWeightSchedule?.length) {
    throw new BacktestValidationError("시점별 목표비중 정책은 Rust worker 실행 모드가 필요합니다.");
  }
  const execution = input.execution;
  if (execution && ((execution.cashTargetPercent ?? 0) !== 0
    || execution.quantityMode === "whole"
    || (execution.cashFlowRebalanceMode !== undefined && execution.cashFlowRebalanceMode !== "target_weights")
    || (execution.cashAnnualYieldPercent ?? 0) !== 0)) {
    throw new BacktestValidationError("현금 목표·정수 수량·현금수익률 실행 정책은 Rust worker 실행 모드가 필요합니다.");
  }
  const realism = input.realism;
  const realismCosts = realism?.costs;
  if (realism && (realism.dividendMode === "cash" || realism.enforcePointInTimeUniverse
    || (realismCosts?.commissionBps ?? 0) > 0
    || (realismCosts?.sellTaxBps ?? 0) > 0
    || (realismCosts?.fixedSlippageBps ?? 0) > 0
    || (realismCosts?.marketImpactCoefficient ?? 0) > 0
    || realismCosts?.maxParticipationRatePercent !== undefined
    || (realismCosts?.minimumFee ?? 0) > 0
    || (realismCosts?.dividendTaxBps ?? 0) > 0)) {
    throw new BacktestValidationError("고급 배당·세금·유동성·point-in-time 현실성 모형은 Rust worker 실행 모드가 필요합니다.");
  }
  if (input.assets.length < 1 || input.assets.length > 20) {
    throw new BacktestValidationError("백테스트 종목은 1~20개까지 구성할 수 있습니다.");
  }
  if (!Number.isFinite(input.initialAmount) || input.initialAmount <= 0) {
    throw new BacktestValidationError("초기 투자금은 0보다 커야 합니다.");
  }
  const riskFreeRatePercent = input.riskFreeRatePercent ?? 0;
  const transactionCostBps = input.transactionCostBps ?? 0;
  const rebalanceThresholdPercent = input.rebalanceThresholdPercent ?? 5;
  const cashFlowFrequency = input.cashFlowFrequency ?? "monthly";
  const cashFlowTiming = input.cashFlowTiming ?? "period_start";
  if (!Number.isFinite(riskFreeRatePercent) || riskFreeRatePercent < -10 || riskFreeRatePercent > 50) {
    throw new BacktestValidationError("무위험수익률은 -10% 이상 50% 이하로 입력해 주세요.");
  }
  if (!Number.isFinite(transactionCostBps) || transactionCostBps < 0 || transactionCostBps > 500) {
    throw new BacktestValidationError("거래비용은 0bp 이상 500bp 이하로 입력해 주세요.");
  }
  if (input.rebalanceFrequency === "threshold"
    && (!Number.isFinite(rebalanceThresholdPercent) || rebalanceThresholdPercent < 0.1 || rebalanceThresholdPercent > 50)) {
    throw new BacktestValidationError("threshold 리밸런싱 기준은 0.1% 이상 50% 이하로 입력해 주세요.");
  }
  const weightTotal = input.assets.reduce((sum, asset) => sum + asset.weight, 0);
  if (input.assets.some((asset) => !Number.isFinite(asset.weight) || asset.weight <= 0) || Math.abs(weightTotal - 100) > 0.01) {
    throw new BacktestValidationError("종목 비중 합계는 100%여야 합니다.");
  }

  const seriesByAsset = input.assets.map((asset) => {
    const series = [...(input.prices.get(keyForAsset(asset)) ?? [])]
      .filter((point) => point.date >= input.requestedStartDate && point.date <= input.endDate && point.close > 0)
      .sort((left, right) => left.date.localeCompare(right.date));
    if (!series.length) throw new BacktestValidationError(`${asset.name}의 선택 기간 일봉이 없습니다.`);
    return series;
  });
  const benchmarkSeries = input.benchmark
    ? [...input.benchmark.prices]
      .filter((point) => point.date >= input.requestedStartDate && point.date <= input.endDate && point.close > 0)
      .sort((left, right) => left.date.localeCompare(right.date))
    : [];
  const observedByAsset = input.assets.map((asset, index) => new Set(
    input.observedDates?.get(keyForAsset(asset)) ?? seriesByAsset[index].map((point) => point.date),
  ));
  const benchmarkObserved = new Set(
    input.benchmark ? input.observedDates?.get(input.benchmark.key) ?? benchmarkSeries.map((point) => point.date) : [],
  );
  if (input.benchmark && !benchmarkSeries.length) {
    throw new BacktestValidationError(`${input.benchmark.name}의 선택 기간 일봉이 없습니다.`);
  }

  const allDates = Array.from(new Set([
    ...seriesByAsset.flatMap((series) => series.map((point) => point.date)),
    ...benchmarkSeries.map((point) => point.date),
  ])).sort();
  const assetCursors = input.assets.map(() => 0);
  const assetPoints: Array<BacktestPricePoint | undefined> = input.assets.map(() => undefined);
  const assetLastObservedDates = input.assets.map(() => "");
  const assetCarryForwardCounts = input.assets.map(() => 0);
  let benchmarkCursor = 0;
  let benchmarkPoint: BacktestPricePoint | undefined;
  let benchmarkLastObservedDate = "";
  let benchmarkCarryForwardCount = 0;
  const aligned: Array<{
    date: string;
    closes: number[];
    localCloses: number[];
    fxRates: number[];
    benchmarkClose?: number;
  }> = [];
  for (const date of allDates) {
    for (let assetIndex = 0; assetIndex < seriesByAsset.length; assetIndex += 1) {
      const series = seriesByAsset[assetIndex];
      while (assetCursors[assetIndex] < series.length && series[assetCursors[assetIndex]].date <= date) {
        assetPoints[assetIndex] = series[assetCursors[assetIndex]];
        if (observedByAsset[assetIndex].has(series[assetCursors[assetIndex]].date)) {
          assetLastObservedDates[assetIndex] = series[assetCursors[assetIndex]].date;
        }
        assetCursors[assetIndex] += 1;
      }
    }
    while (benchmarkCursor < benchmarkSeries.length && benchmarkSeries[benchmarkCursor].date <= date) {
      benchmarkPoint = benchmarkSeries[benchmarkCursor];
      if (benchmarkObserved.has(benchmarkSeries[benchmarkCursor].date)) {
        benchmarkLastObservedDate = benchmarkSeries[benchmarkCursor].date;
      }
      benchmarkCursor += 1;
    }
    if (assetPoints.every((point) => (point?.close ?? 0) > 0) && (!input.benchmark || (benchmarkPoint?.close ?? 0) > 0)) {
      for (let assetIndex = 0; assetIndex < assetLastObservedDates.length; assetIndex += 1) {
        if (assetLastObservedDates[assetIndex] !== date) assetCarryForwardCounts[assetIndex] += 1;
      }
      if (input.benchmark && benchmarkLastObservedDate !== date) benchmarkCarryForwardCount += 1;
      aligned.push({
        date,
        closes: assetPoints.map((point) => point!.close),
        localCloses: assetPoints.map((point) => point!.localClose ?? point!.close),
        fxRates: assetPoints.map((point) => point!.fxRate ?? 1),
        ...(input.benchmark ? { benchmarkClose: benchmarkPoint!.close } : {}),
      });
    }
  }
  if (aligned.length < 2) throw new BacktestValidationError("모든 종목에 공통으로 존재하는 일봉이 2개 이상 필요합니다.");

  const weights = input.assets.map((asset) => asset.weight / 100);
  let positionValues = weights.map((weight) => input.initialAmount * weight);
  const marketProfitByAsset = input.assets.map(() => 0);
  const linkedContributionByAsset = input.assets.map(() => 0);
  const linkedLocalContributionByAsset = input.assets.map(() => 0);
  const linkedFxContributionByAsset = input.assets.map(() => 0);
  const linkedUpRegimeContributionByAsset = input.assets.map(() => 0);
  const linkedDownRegimeContributionByAsset = input.assets.map(() => 0);
  const weightSums = input.assets.map(() => 0);
  let weightObservationCount = 0;
  let totalContributions = input.initialAmount;
  let totalWithdrawals = 0;
  let growth = input.initialAmount;
  let peak = growth;
  let peakDate = aligned[0].date;
  let maxDrawdown = 0;
  let maxDrawdownDays = 0;
  const portfolioReturns: number[] = [];
  const benchmarkReturns: number[] = [];
  const assetReturns = input.assets.map(() => [] as number[]);
  const trades: BacktestTradeEvent[] = input.assets.map((_, assetIndex) => ({
    date: aligned[0].date,
    assetIndex,
    side: "BUY" as const,
    amount: positionValues[assetIndex],
    quantity: positionValues[assetIndex] / aligned[0].closes[assetIndex],
    price: aligned[0].closes[assetIndex],
    reason: "initial" as const,
  }));
  const portfolioGrowthSeries = [{ date: aligned[0].date, value: growth }];
  const benchmarkGrowthSeries = input.benchmark
    ? [{ date: aligned[0].date, value: input.initialAmount }]
    : [];
  const fullPoints: BacktestSimulationResult["points"] = [{
    date: aligned[0].date,
    balance: round(input.initialAmount, 2),
    growth: round(growth, 2),
    ...(input.benchmark ? { benchmarkGrowth: round(input.initialAmount, 2) } : {}),
    drawdownPercent: 0,
  }];
  const benchmarkBase = aligned[0].benchmarkClose ?? 0;

  for (let dateIndex = 1; dateIndex < aligned.length; dateIndex += 1) {
    const previous = aligned[dateIndex - 1];
    const current = aligned[dateIndex];
    const beforeMarket = positionValues.reduce((sum, value) => sum + value, 0);
    for (let assetIndex = 0; assetIndex < input.assets.length; assetIndex += 1) {
      weightSums[assetIndex] += beforeMarket > 0 ? positionValues[assetIndex] / beforeMarket : 0;
    }
    weightObservationCount += 1;
    const dailyContributions = input.assets.map(() => 0);
    const dailyLocalContributions = input.assets.map(() => 0);
    const dailyFxContributions = input.assets.map(() => 0);
    for (let assetIndex = 0; assetIndex < input.assets.length; assetIndex += 1) {
      const assetReturn = current.closes[assetIndex] / previous.closes[assetIndex] - 1;
      const localReturn = current.localCloses[assetIndex] / previous.localCloses[assetIndex] - 1;
      const fxReturn = current.fxRates[assetIndex] / previous.fxRates[assetIndex] - 1;
      const positionWeight = beforeMarket > 0 ? positionValues[assetIndex] / beforeMarket : 0;
      assetReturns[assetIndex].push(assetReturn);
      dailyContributions[assetIndex] = positionWeight * assetReturn;
      dailyLocalContributions[assetIndex] = positionWeight * localReturn;
      dailyFxContributions[assetIndex] = positionWeight * (1 + localReturn) * fxReturn;
      marketProfitByAsset[assetIndex] += positionValues[assetIndex] * assetReturn;
      positionValues[assetIndex] *= 1 + assetReturn;
    }
    const afterMarket = positionValues.reduce((sum, value) => sum + value, 0);
    const portfolioReturn = beforeMarket > 0 ? afterMarket / beforeMarket - 1 : 0;
    portfolioReturns.push(portfolioReturn);
    growth *= 1 + portfolioReturn;
    for (let assetIndex = 0; assetIndex < input.assets.length; assetIndex += 1) {
      linkedContributionByAsset[assetIndex] = linkedContributionByAsset[assetIndex] * (1 + portfolioReturn)
        + dailyContributions[assetIndex] * 100;
      linkedLocalContributionByAsset[assetIndex] = linkedLocalContributionByAsset[assetIndex] * (1 + portfolioReturn)
        + dailyLocalContributions[assetIndex] * 100;
      linkedFxContributionByAsset[assetIndex] = linkedFxContributionByAsset[assetIndex] * (1 + portfolioReturn)
        + dailyFxContributions[assetIndex] * 100;
      linkedUpRegimeContributionByAsset[assetIndex] = linkedUpRegimeContributionByAsset[assetIndex] * (1 + portfolioReturn)
        + (portfolioReturn >= 0 ? dailyContributions[assetIndex] * 100 : 0);
      linkedDownRegimeContributionByAsset[assetIndex] = linkedDownRegimeContributionByAsset[assetIndex] * (1 + portfolioReturn)
        + (portfolioReturn < 0 ? dailyContributions[assetIndex] * 100 : 0);
    }
    if (input.benchmark) {
      benchmarkReturns.push((current.benchmarkClose ?? benchmarkBase) / (previous.benchmarkClose ?? benchmarkBase) - 1);
    }

    if (input.monthlyCashFlow !== 0 && cashFlowDue(
      previous.date,
      current.date,
      aligned[dateIndex + 1]?.date,
      cashFlowFrequency,
      cashFlowTiming,
    )) {
      const flow = input.monthlyCashFlow;
      if (afterMarket + flow <= 0) throw new BacktestValidationError("정기 인출금이 포트폴리오 잔액보다 큽니다.");
      if (flow > 0) {
        for (let assetIndex = 0; assetIndex < positionValues.length; assetIndex += 1) {
          const allocation = flow * weights[assetIndex];
          trades.push({
            date: current.date,
            assetIndex,
            side: "BUY",
            amount: allocation,
            quantity: allocation / current.closes[assetIndex],
            price: current.closes[assetIndex],
            reason: "cash-flow",
          });
          positionValues[assetIndex] += allocation;
        }
        totalContributions += flow;
      } else {
        const withdrawal = Math.abs(flow);
        for (let assetIndex = 0; assetIndex < positionValues.length; assetIndex += 1) {
          const allocation = withdrawal * (positionValues[assetIndex] / afterMarket);
          trades.push({
            date: current.date,
            assetIndex,
            side: "SELL",
            amount: allocation,
            quantity: allocation / current.closes[assetIndex],
            price: current.closes[assetIndex],
            reason: "cash-flow",
          });
          positionValues[assetIndex] -= allocation;
        }
        totalWithdrawals += withdrawal;
      }
    }

    const currentTotal = positionValues.reduce((sum, value) => sum + value, 0);
    const thresholdTriggered = input.rebalanceFrequency === "threshold" && currentTotal > 0
      && positionValues.some((value, index) => Math.abs(value / currentTotal - weights[index]) >= rebalanceThresholdPercent / 100);
    if (shouldRebalance(previous.date, current.date, input.rebalanceFrequency) || thresholdTriggered) {
      const total = positionValues.reduce((sum, value) => sum + value, 0);
      const targets = weights.map((weight) => total * weight);
      for (let assetIndex = 0; assetIndex < positionValues.length; assetIndex += 1) {
        const difference = targets[assetIndex] - positionValues[assetIndex];
        if (Math.abs(difference) <= 0.000001) continue;
        trades.push({
          date: current.date,
          assetIndex,
          side: difference > 0 ? "BUY" : "SELL",
          amount: Math.abs(difference),
          quantity: Math.abs(difference) / current.closes[assetIndex],
          price: current.closes[assetIndex],
          reason: "rebalance",
        });
      }
      positionValues = targets;
    }

    if (growth >= peak) {
      peak = growth;
      peakDate = current.date;
    }
    const drawdown = peak > 0 ? growth / peak - 1 : 0;
    if (drawdown < maxDrawdown) maxDrawdown = drawdown;
    if (drawdown < 0) maxDrawdownDays = Math.max(maxDrawdownDays, dateDays(peakDate, current.date));
    const balance = positionValues.reduce((sum, value) => sum + value, 0);
    const benchmarkGrowth = input.benchmark && benchmarkBase > 0
      ? input.initialAmount * ((current.benchmarkClose ?? benchmarkBase) / benchmarkBase)
      : undefined;
    portfolioGrowthSeries.push({ date: current.date, value: growth });
    if (benchmarkGrowth !== undefined) benchmarkGrowthSeries.push({ date: current.date, value: benchmarkGrowth });
    fullPoints.push({
      date: current.date,
      balance: round(balance, 2),
      growth: round(growth, 2),
      ...(benchmarkGrowth !== undefined ? { benchmarkGrowth: round(benchmarkGrowth, 2) } : {}),
      drawdownPercent: round(drawdown * 100),
    });
  }

  const portfolioSummary = summarizeGrowthSeries(portfolioGrowthSeries, portfolioReturns, riskFreeRatePercent);
  const benchmarkSummary = input.benchmark
    ? summarizeGrowthSeries(benchmarkGrowthSeries, benchmarkReturns, riskFreeRatePercent)
    : undefined;

  const contributions = input.assets.map((asset, index) => {
    const profitLoss = marketProfitByAsset[index];
    const firstPrice = aligned[0].closes[index];
    const lastPrice = aligned.at(-1)!.closes[index];
    return {
      symbol: asset.symbol,
      name: asset.name,
      market: asset.market,
      currency: asset.currency,
      weight: round(asset.weight, 4),
      endingValue: round(positionValues[index], 2),
      profitLoss: round(profitLoss, 2),
      contributionPercent: round((profitLoss / input.initialAmount) * 100),
      timeLinkedContributionPercent: round(linkedContributionByAsset[index]),
      localPriceContributionPercent: round(linkedLocalContributionByAsset[index]),
      fxContributionPercent: round(linkedFxContributionByAsset[index]),
      upRegimeContributionPercent: round(linkedUpRegimeContributionByAsset[index]),
      downRegimeContributionPercent: round(linkedDownRegimeContributionByAsset[index]),
      assetReturnPercent: round((lastPrice / firstPrice - 1) * 100),
    };
  }).sort((left, right) => right.contributionPercent - left.contributionPercent);

  const commonReturns = commonObservedReturns(seriesByAsset, observedByAsset);
  const correlations = input.assets.map((_, leftIndex) => (
    input.assets.map((__, rightIndex) => leftIndex === rightIndex
      ? 1
      : pearson(commonReturns.returns[leftIndex], commonReturns.returns[rightIndex]))
  ));
  const finalBalance = positionValues.reduce((sum, value) => sum + value, 0);
  const endingWeights = positionValues.map((value) => finalBalance > 0 ? value / finalBalance : 0);
  const averageWeights = weightSums.map((value) => weightObservationCount > 0 ? value / weightObservationCount : 0);
  const effectiveStartDate = aligned[0].date;
  const effectiveEndDate = aligned.at(-1)!.date;
  const advanced = calculateBacktestAdvancedAnalytics({
    assets: input.assets,
    baseDate: effectiveStartDate,
    effectiveEndDate,
    requestedStartDate: input.requestedStartDate,
    returns: portfolioReturns.map((value, index) => ({ date: aligned[index + 1].date, value })),
    assetReturns,
    ...(input.benchmark ? {
      benchmark: {
        key: input.benchmark.key,
        name: input.benchmark.name,
        returns: benchmarkReturns,
        observations: benchmarkSeries.filter((point) => (
          point.date >= effectiveStartDate
          && point.date <= effectiveEndDate
          && benchmarkObserved.has(point.date)
        )).length,
      },
    } : {}),
    averageWeights,
    endingWeights,
    trades,
    balances: fullPoints.map((point) => ({ date: point.date, value: point.balance })),
    transactionCostBps,
    riskFreeRatePercent,
    grossReturnPercent: portfolioSummary.metrics.totalReturnPercent,
    priceCoverage: seriesByAsset.map((series, assetIndex) => {
      const observations = series.filter((point) => (
        point.date >= effectiveStartDate
        && point.date <= effectiveEndDate
        && observedByAsset[assetIndex].has(point.date)
      ));
      return {
        observations: observations.length,
        alignedDays: aligned.length,
        firstDate: observations[0]?.date ?? effectiveStartDate,
        lastDate: observations.at(-1)?.date ?? effectiveEndDate,
      };
    }),
  });

  return {
    requestedStartDate: input.requestedStartDate,
    effectiveStartDate,
    endDate: effectiveEndDate,
    points: fullPoints,
    metrics: {
      finalBalance: round(finalBalance, 2),
      totalContributions: round(totalContributions, 2),
      totalWithdrawals: round(totalWithdrawals, 2),
      ...portfolioSummary.metrics,
    },
    ...(benchmarkSummary ? { benchmarkMetrics: benchmarkSummary.metrics } : {}),
    annualReturns: portfolioSummary.annualReturns,
    contributions,
    correlations: {
      assets: input.assets.map((asset) => ({ symbol: asset.symbol, name: asset.name })),
      values: correlations,
    },
    trades: trades.map((trade) => ({
      date: trade.date,
      symbol: input.assets[trade.assetIndex].symbol,
      side: trade.side,
      amount: round(trade.amount, 2),
      quantity: round(trade.quantity, 8),
      price: round(trade.price, 6),
      reason: trade.reason,
    })),
    dataQuality: {
      alignmentPolicy: "carry_forward_for_valuation",
      commonReturnPolicy: "inner_join",
      alignedValuationDays: aligned.length,
      commonReturnObservations: commonReturns.observations,
      carryForwardByAsset: input.assets.map((asset, index) => ({
        symbol: asset.symbol,
        count: assetCarryForwardCounts[index],
      })),
      benchmarkCarryForwardCount,
    },
    advanced,
  };
}
