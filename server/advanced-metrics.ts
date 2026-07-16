import type { BenchmarkPricePoint, PortfolioHistory } from "./history.js";
import type { HistoricalOrder } from "./toss.js";

const TRADING_DAYS_PER_YEAR = 252;

export type AdvancedBenchmarkKey = "KOSPI" | "KOSDAQ" | "NASDAQ100" | "SP500";
export type DailyReturnPoint = { date: string; value: number };

export type AssetDailyReturnDetail = {
  key: string;
  totalReturn: number;
  localReturn: number;
  fxReturn: number;
  contribution: number;
  localContribution: number;
  fxContribution: number;
};

export type PortfolioReturnDetail = {
  returns: DailyReturnPoint[];
  daily: Array<{
    date: string;
    value: number;
    assets: AssetDailyReturnDetail[];
  }>;
  expectedReturnObservations: number;
  requiredPriceObservations: number;
  missingPriceObservations: number;
  requiredFxObservations: number;
  missingFxObservations: number;
};

export type BenchmarkComparisonMetric = {
  key: AdvancedBenchmarkKey;
  observations: number;
  returnPercent: number | null;
  excessReturnPercent: number | null;
  trackingErrorPercent: number | null;
  informationRatio: number | null;
  beta: number | null;
  alphaPercent: number | null;
  correlation: number | null;
  upsideCapturePercent: number | null;
  downsideCapturePercent: number | null;
  dailyWinRatePercent: number | null;
  monthlyWinRatePercent: number | null;
  relativeMaxDrawdownPercent: number | null;
};

export type RollingMetricPoint = {
  date: string;
  return20d: number | null;
  return60d: number | null;
  return120d: number | null;
  return252d: number | null;
  volatility60d: number | null;
  sharpe60d: number | null;
  benchmarkExcess60d: Partial<Record<AdvancedBenchmarkKey, number>>;
  benchmarkBeta60d: Partial<Record<AdvancedBenchmarkKey, number>>;
  benchmarkCorrelation60d: Partial<Record<AdvancedBenchmarkKey, number>>;
};

export type DrawdownPoint = { date: string; drawdownPercent: number };
export type DrawdownEpisode = {
  startDate: string;
  troughDate: string;
  recoveryDate?: string;
  depthPercent: number;
  durationDays: number;
  recoveryDays?: number;
};

export type RiskContribution = {
  key: string;
  symbol: string;
  name: string;
  weightPercent: number;
  annualizedVolatilityPercent: number | null;
  riskContributionPercent: number | null;
  correlationToPortfolio: number | null;
};

export type CorrelationMatrix = {
  assets: Array<{ key: string; symbol: string; name: string }>;
  values: Array<Array<number | null>>;
};

export type AdvancedAnalytics = {
  benchmarkComparisons: BenchmarkComparisonMetric[];
  rolling: RollingMetricPoint[];
  drawdowns: {
    points: DrawdownPoint[];
    episodes: DrawdownEpisode[];
    currentUnderwaterDays: number;
    averageDrawdownPercent: number | null;
    ulcerIndex: number | null;
    worst20DayReturnPercent: number | null;
    worst60DayReturnPercent: number | null;
  };
  tailRisk: {
    historicalVar95Percent: number | null;
    expectedShortfall95Percent: number | null;
    lossDaysPercent: number | null;
    averageGainPercent: number | null;
    averageLossPercent: number | null;
    gainLossRatio: number | null;
    skewness: number | null;
    excessKurtosis: number | null;
    maxConsecutiveGainDays: number;
    maxConsecutiveLossDays: number;
  };
  monthlyReturns: Array<{ month: string; returnPercent: number }>;
  attributionByKey: Record<string, {
    timeLinkedContributionPercent: number;
    localPriceContributionPercent: number;
    fxContributionPercent: number;
  }>;
  riskContributions: RiskContribution[];
  correlations: CorrelationMatrix;
  exposure: {
    krwWeightPercent: number;
    usdWeightPercent: number;
    domesticWeightPercent: number;
    overseasWeightPercent: number;
    top1WeightPercent: number;
    top5WeightPercent: number;
    top10WeightPercent: number;
    diversificationBenefitPercent: number | null;
  };
  costEfficiency: {
    costDragPercent: number | null;
    grossEstimatedReturnPercent: number | null;
    costPerTradedAmountBps: number | null;
    averageTradeAmount: number | null;
    buySellAmountRatio: number | null;
    monthly: Array<{
      month: string;
      turnoverPercent: number;
      tradeCount: number;
      cost: number;
    }>;
  };
  tradeBehavior: {
    estimatedRealizedProfitLoss: number;
    estimatedWinRatePercent: number | null;
    estimatedProfitFactor: number | null;
    estimatedAverageHoldingDays: number | null;
    matchedSellCount: number;
    unmatchedSellCount: number;
  };
};

type BenchmarkInput = { key: AdvancedBenchmarkKey; points: BenchmarkPricePoint[] };
type DatedOrder = { order: HistoricalOrder; date: string };

function round(value: number, digits = 4): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function daysBetween(from: string, to: string): number {
  return Math.max(0, Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000));
}

function average(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function sampleStandardDeviation(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = average(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1));
}

function sampleCovariance(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length);
  if (length < 2) return 0;
  const leftValues = left.slice(0, length);
  const rightValues = right.slice(0, length);
  const leftMean = average(leftValues);
  const rightMean = average(rightValues);
  return leftValues.reduce((sum, value, index) => sum + (value - leftMean) * (rightValues[index] - rightMean), 0) / (length - 1);
}

function correlation(left: number[], right: number[]): number | null {
  const length = Math.min(left.length, right.length);
  if (length < 2) return null;
  const leftValues = left.slice(0, length);
  const rightValues = right.slice(0, length);
  const denominator = sampleStandardDeviation(leftValues) * sampleStandardDeviation(rightValues);
  return denominator > 0 ? round(sampleCovariance(leftValues, rightValues) / denominator, 6) : null;
}

function compoundedReturn(values: number[]): number | null {
  if (!values.length) return null;
  return values.reduce((value, item) => value * (1 + item), 1) - 1;
}

function percentile(values: number[], probability: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(sorted.length * probability) - 1);
  return sorted[index];
}

function longestStreak(values: number[], predicate: (value: number) => boolean): number {
  let current = 0;
  let maximum = 0;
  for (const value of values) {
    current = predicate(value) ? current + 1 : 0;
    maximum = Math.max(maximum, current);
  }
  return maximum;
}

function rollingReturn(values: number[], endIndex: number, window: number): number | null {
  if (endIndex + 1 < window) return null;
  return compoundedReturn(values.slice(endIndex + 1 - window, endIndex + 1));
}

function monthlyReturnSeries(returns: DailyReturnPoint[]): Array<{ month: string; returnPercent: number }> {
  const months = new Map<string, number[]>();
  for (const item of returns) {
    const month = item.date.slice(0, 7);
    const values = months.get(month) ?? [];
    values.push(item.value);
    months.set(month, values);
  }
  return Array.from(months, ([month, values]) => ({
    month,
    returnPercent: round((compoundedReturn(values) ?? 0) * 100),
  })).sort((left, right) => left.month.localeCompare(right.month));
}

function benchmarkPairs(
  returns: DailyReturnPoint[],
  points: BenchmarkPricePoint[],
  baseDate: string,
): Array<{ date: string; portfolio: number; benchmark: number }> {
  const sorted = [...points].filter((point) => point.close > 0).sort((left, right) => left.date.localeCompare(right.date));
  if (!sorted.length || !returns.length) return [];
  let cursor = 0;
  let latestClose: number | undefined;
  let previousClose: number | undefined;
  const result: Array<{ date: string; portfolio: number; benchmark: number }> = [];
  const dates = [baseDate, ...returns.map((item) => item.date)];
  for (let index = 0; index < dates.length; index += 1) {
    const date = dates[index];
    while (cursor < sorted.length && sorted[cursor].date <= date) {
      latestClose = sorted[cursor].close;
      cursor += 1;
    }
    if (index === 0) {
      previousClose = latestClose;
      continue;
    }
    const portfolioReturn = returns[index - 1];
    if (latestClose && previousClose && previousClose > 0 && portfolioReturn?.date === date) {
      result.push({ date, portfolio: portfolioReturn.value, benchmark: latestClose / previousClose - 1 });
    }
    if (latestClose) previousClose = latestClose;
  }
  return result;
}

function relativeMaxDrawdown(pairs: Array<{ portfolio: number; benchmark: number }>): number | null {
  if (!pairs.length) return null;
  let value = 1;
  let peak = 1;
  let maximum = 0;
  for (const pair of pairs) {
    if (pair.benchmark <= -1) continue;
    value *= (1 + pair.portfolio) / (1 + pair.benchmark);
    peak = Math.max(peak, value);
    maximum = Math.min(maximum, value / peak - 1);
  }
  return round(maximum * 100);
}

function calculateBenchmarkComparison(
  benchmark: BenchmarkInput,
  returns: DailyReturnPoint[],
  baseDate: string,
  riskFreeRatePercent: number,
): BenchmarkComparisonMetric {
  const pairs = benchmarkPairs(returns, benchmark.points, baseDate);
  const portfolioValues = pairs.map((pair) => pair.portfolio);
  const benchmarkValues = pairs.map((pair) => pair.benchmark);
  const activeValues = pairs.map((pair) => pair.portfolio - pair.benchmark);
  const activeDeviation = sampleStandardDeviation(activeValues);
  const benchmarkVariance = sampleStandardDeviation(benchmarkValues) ** 2;
  const beta = benchmarkVariance > 0 ? sampleCovariance(portfolioValues, benchmarkValues) / benchmarkVariance : null;
  const dailyRiskFree = (1 + riskFreeRatePercent / 100) ** (1 / TRADING_DAYS_PER_YEAR) - 1;
  const alpha = beta === null
    ? null
    : ((average(portfolioValues) - dailyRiskFree) - beta * (average(benchmarkValues) - dailyRiskFree)) * TRADING_DAYS_PER_YEAR;
  const upsidePairs = pairs.filter((pair) => pair.benchmark > 0);
  const downsidePairs = pairs.filter((pair) => pair.benchmark < 0);
  const months = new Map<string, Array<{ portfolio: number; benchmark: number }>>();
  for (const pair of pairs) {
    const month = pair.date.slice(0, 7);
    const values = months.get(month) ?? [];
    values.push(pair);
    months.set(month, values);
  }
  const monthlyWins = Array.from(months.values()).filter((items) => {
    const portfolioReturn = compoundedReturn(items.map((item) => item.portfolio)) ?? 0;
    const benchmarkReturn = compoundedReturn(items.map((item) => item.benchmark)) ?? 0;
    return portfolioReturn > benchmarkReturn;
  }).length;
  const portfolioReturn = compoundedReturn(portfolioValues);
  const benchmarkReturn = compoundedReturn(benchmarkValues);
  const capture = (selected: typeof pairs) => {
    const benchmarkMean = average(selected.map((pair) => pair.benchmark));
    return selected.length && benchmarkMean !== 0
      ? round((average(selected.map((pair) => pair.portfolio)) / benchmarkMean) * 100)
      : null;
  };
  return {
    key: benchmark.key,
    observations: pairs.length,
    returnPercent: benchmarkReturn === null ? null : round(benchmarkReturn * 100),
    excessReturnPercent: portfolioReturn === null || benchmarkReturn === null
      ? null
      : round((portfolioReturn - benchmarkReturn) * 100),
    trackingErrorPercent: pairs.length > 1 ? round(activeDeviation * Math.sqrt(TRADING_DAYS_PER_YEAR) * 100) : null,
    informationRatio: pairs.length > 1 && activeDeviation > 0
      ? round((average(activeValues) / activeDeviation) * Math.sqrt(TRADING_DAYS_PER_YEAR))
      : null,
    beta: beta === null ? null : round(beta),
    alphaPercent: alpha === null ? null : round(alpha * 100),
    correlation: correlation(portfolioValues, benchmarkValues),
    upsideCapturePercent: capture(upsidePairs),
    downsideCapturePercent: capture(downsidePairs),
    dailyWinRatePercent: pairs.length
      ? round((pairs.filter((pair) => pair.portfolio > pair.benchmark).length / pairs.length) * 100)
      : null,
    monthlyWinRatePercent: months.size ? round((monthlyWins / months.size) * 100) : null,
    relativeMaxDrawdownPercent: relativeMaxDrawdown(pairs),
  };
}

function buildRollingMetrics(
  returns: DailyReturnPoint[],
  benchmarks: BenchmarkInput[],
  baseDate: string,
  riskFreeRatePercent: number,
): RollingMetricPoint[] {
  const values = returns.map((item) => item.value);
  const dailyRiskFree = (1 + riskFreeRatePercent / 100) ** (1 / TRADING_DAYS_PER_YEAR) - 1;
  const pairMaps = new Map(benchmarks.map((benchmark) => [
    benchmark.key,
    new Map(benchmarkPairs(returns, benchmark.points, baseDate).map((pair) => [pair.date, pair])),
  ]));
  return returns.map((item, index) => {
    const sixty = index + 1 >= 60 ? values.slice(index - 59, index + 1) : [];
    const standardDeviation = sampleStandardDeviation(sixty);
    const benchmarkExcess60d: RollingMetricPoint["benchmarkExcess60d"] = {};
    const benchmarkBeta60d: RollingMetricPoint["benchmarkBeta60d"] = {};
    const benchmarkCorrelation60d: RollingMetricPoint["benchmarkCorrelation60d"] = {};
    if (sixty.length === 60) {
      for (const benchmark of benchmarks) {
        const pairMap = pairMaps.get(benchmark.key)!;
        const pairs = returns.slice(index - 59, index + 1)
          .map((returnPoint) => pairMap.get(returnPoint.date))
          .filter((pair): pair is NonNullable<typeof pair> => Boolean(pair));
        if (pairs.length < 40) continue;
        const portfolioValues = pairs.map((pair) => pair.portfolio);
        const benchmarkValues = pairs.map((pair) => pair.benchmark);
        const benchmarkVariance = sampleStandardDeviation(benchmarkValues) ** 2;
        const portfolioReturn = compoundedReturn(portfolioValues);
        const benchmarkReturn = compoundedReturn(benchmarkValues);
        if (portfolioReturn !== null && benchmarkReturn !== null) {
          benchmarkExcess60d[benchmark.key] = round((portfolioReturn - benchmarkReturn) * 100);
        }
        if (benchmarkVariance > 0) {
          benchmarkBeta60d[benchmark.key] = round(sampleCovariance(portfolioValues, benchmarkValues) / benchmarkVariance);
        }
        const correlationValue = correlation(portfolioValues, benchmarkValues);
        if (correlationValue !== null) benchmarkCorrelation60d[benchmark.key] = correlationValue;
      }
    }
    const percent = (value: number | null) => value === null ? null : round(value * 100);
    return {
      date: item.date,
      return20d: percent(rollingReturn(values, index, 20)),
      return60d: percent(rollingReturn(values, index, 60)),
      return120d: percent(rollingReturn(values, index, 120)),
      return252d: percent(rollingReturn(values, index, 252)),
      volatility60d: sixty.length === 60 ? round(standardDeviation * Math.sqrt(TRADING_DAYS_PER_YEAR) * 100) : null,
      sharpe60d: sixty.length === 60 && standardDeviation > 0
        ? round(((average(sixty) - dailyRiskFree) / standardDeviation) * Math.sqrt(TRADING_DAYS_PER_YEAR))
        : null,
      benchmarkExcess60d,
      benchmarkBeta60d,
      benchmarkCorrelation60d,
    };
  });
}

function buildDrawdownAnalytics(returns: DailyReturnPoint[], baseDate: string): AdvancedAnalytics["drawdowns"] {
  let value = 1;
  let peak = 1;
  let peakDate = baseDate;
  let currentEpisode: DrawdownEpisode | undefined;
  const points: DrawdownPoint[] = [{ date: baseDate, drawdownPercent: 0 }];
  const episodes: DrawdownEpisode[] = [];
  for (const item of returns) {
    value *= 1 + item.value;
    if (value >= peak) {
      if (currentEpisode) {
        currentEpisode.recoveryDate = item.date;
        currentEpisode.durationDays = daysBetween(currentEpisode.startDate, item.date);
        currentEpisode.recoveryDays = daysBetween(currentEpisode.troughDate, item.date);
        episodes.push(currentEpisode);
        currentEpisode = undefined;
      }
      peak = value;
      peakDate = item.date;
    } else {
      const drawdown = value / peak - 1;
      if (!currentEpisode) {
        currentEpisode = {
          startDate: peakDate,
          troughDate: item.date,
          depthPercent: round(drawdown * 100),
          durationDays: daysBetween(peakDate, item.date),
        };
      } else {
        currentEpisode.durationDays = daysBetween(currentEpisode.startDate, item.date);
        if (drawdown < currentEpisode.depthPercent / 100) {
          currentEpisode.depthPercent = round(drawdown * 100);
          currentEpisode.troughDate = item.date;
        }
      }
    }
    points.push({ date: item.date, drawdownPercent: round((value / peak - 1) * 100) });
  }
  if (currentEpisode) episodes.push(currentEpisode);
  const negativeDrawdowns = points.map((point) => point.drawdownPercent).filter((value) => value < 0);
  const pathValues = returns.map((item) => item.value);
  const worstWindow = (window: number): number | null => {
    const values = pathValues.map((_, index) => rollingReturn(pathValues, index, window)).filter((value): value is number => value !== null);
    return values.length ? round(Math.min(...values) * 100) : null;
  };
  return {
    points,
    episodes: [...episodes].sort((left, right) => left.depthPercent - right.depthPercent).slice(0, 5),
    currentUnderwaterDays: currentEpisode ? daysBetween(currentEpisode.startDate, returns.at(-1)?.date ?? baseDate) : 0,
    averageDrawdownPercent: negativeDrawdowns.length ? round(average(negativeDrawdowns)) : null,
    ulcerIndex: negativeDrawdowns.length
      ? round(Math.sqrt(average(negativeDrawdowns.map((drawdown) => drawdown ** 2))))
      : null,
    worst20DayReturnPercent: worstWindow(20),
    worst60DayReturnPercent: worstWindow(60),
  };
}

function buildTailRisk(returns: DailyReturnPoint[]): AdvancedAnalytics["tailRisk"] {
  const values = returns.map((item) => item.value);
  const gains = values.filter((value) => value > 0);
  const losses = values.filter((value) => value < 0);
  const var95 = percentile(values, 0.05);
  const tail = var95 === null ? [] : values.filter((value) => value <= var95);
  const mean = average(values);
  const standardDeviation = sampleStandardDeviation(values);
  const skewness = values.length >= 3 && standardDeviation > 0
    ? average(values.map((value) => ((value - mean) / standardDeviation) ** 3))
    : null;
  const excessKurtosis = values.length >= 4 && standardDeviation > 0
    ? average(values.map((value) => ((value - mean) / standardDeviation) ** 4)) - 3
    : null;
  const averageGain = gains.length ? average(gains) : null;
  const averageLoss = losses.length ? average(losses) : null;
  return {
    historicalVar95Percent: var95 === null ? null : round(var95 * 100),
    expectedShortfall95Percent: tail.length ? round(average(tail) * 100) : null,
    lossDaysPercent: values.length ? round((losses.length / values.length) * 100) : null,
    averageGainPercent: averageGain === null ? null : round(averageGain * 100),
    averageLossPercent: averageLoss === null ? null : round(averageLoss * 100),
    gainLossRatio: averageGain !== null && averageLoss !== null && averageLoss !== 0
      ? round(averageGain / Math.abs(averageLoss))
      : null,
    skewness: skewness === null ? null : round(skewness),
    excessKurtosis: excessKurtosis === null ? null : round(excessKurtosis),
    maxConsecutiveGainDays: longestStreak(values, (value) => value > 0),
    maxConsecutiveLossDays: longestStreak(values, (value) => value < 0),
  };
}

function buildAttribution(detail: PortfolioReturnDetail): AdvancedAnalytics["attributionByKey"] {
  const result: AdvancedAnalytics["attributionByKey"] = {};
  for (const day of detail.daily) {
    const keys = new Set([...Object.keys(result), ...day.assets.map((asset) => asset.key)]);
    for (const key of keys) {
      const previous = result[key] ?? {
        timeLinkedContributionPercent: 0,
        localPriceContributionPercent: 0,
        fxContributionPercent: 0,
      };
      const asset = day.assets.find((candidate) => candidate.key === key);
      result[key] = {
        timeLinkedContributionPercent: previous.timeLinkedContributionPercent * (1 + day.value)
          + (asset?.contribution ?? 0) * 100,
        localPriceContributionPercent: previous.localPriceContributionPercent * (1 + day.value)
          + (asset?.localContribution ?? 0) * 100,
        fxContributionPercent: previous.fxContributionPercent * (1 + day.value)
          + (asset?.fxContribution ?? 0) * 100,
      };
    }
  }
  return Object.fromEntries(Object.entries(result).map(([key, value]) => [key, {
    timeLinkedContributionPercent: round(value.timeLinkedContributionPercent),
    localPriceContributionPercent: round(value.localPriceContributionPercent),
    fxContributionPercent: round(value.fxContributionPercent),
  }]));
}

function seriesReturnMaps(detail: PortfolioReturnDetail): Map<string, Map<string, number>> {
  const result = new Map<string, Map<string, number>>();
  for (const day of detail.daily) {
    for (const asset of day.assets) {
      const values = result.get(asset.key) ?? new Map<string, number>();
      values.set(day.date, asset.totalReturn);
      result.set(asset.key, values);
    }
  }
  return result;
}

function pairedReturns(left: Map<string, number>, right: Map<string, number>): [number[], number[]] {
  const dates = Array.from(left.keys()).filter((date) => right.has(date)).sort();
  return [dates.map((date) => left.get(date)!), dates.map((date) => right.get(date)!)];
}

function buildRiskAnalytics(
  history: PortfolioHistory,
  detail: PortfolioReturnDetail,
): Pick<AdvancedAnalytics, "riskContributions" | "correlations" | "exposure"> {
  const latest = history.points.at(-1);
  const weights = new Map(history.series.map((series) => [series.key, Math.max(0, latest?.values[series.key] ?? 0) / 100]));
  const activeSeries = history.series
    .filter((series) => (weights.get(series.key) ?? 0) > 0)
    .sort((left, right) => (weights.get(right.key) ?? 0) - (weights.get(left.key) ?? 0));
  const returnMaps = seriesReturnMaps(detail);
  const covariance = (leftKey: string, rightKey: string): number => {
    const left = returnMaps.get(leftKey);
    const right = returnMaps.get(rightKey);
    if (!left || !right) return 0;
    const [leftValues, rightValues] = pairedReturns(left, right);
    return sampleCovariance(leftValues, rightValues);
  };
  let portfolioVariance = 0;
  for (const left of activeSeries) {
    for (const right of activeSeries) {
      portfolioVariance += (weights.get(left.key) ?? 0) * (weights.get(right.key) ?? 0) * covariance(left.key, right.key);
    }
  }
  const portfolioMap = new Map(detail.returns.map((item) => [item.date, item.value]));
  const riskContributions = activeSeries.map((series) => {
    const weight = weights.get(series.key) ?? 0;
    const marginalVariance = activeSeries.reduce((sum, other) => (
      sum + (weights.get(other.key) ?? 0) * covariance(series.key, other.key)
    ), 0);
    const ownReturns = returnMaps.get(series.key) ?? new Map();
    const [assetValues, portfolioValues] = pairedReturns(ownReturns, portfolioMap);
    const volatility = sampleStandardDeviation(Array.from(ownReturns.values()));
    return {
      key: series.key,
      symbol: series.symbol,
      name: series.name,
      weightPercent: round(weight * 100),
      annualizedVolatilityPercent: ownReturns.size > 1 ? round(volatility * Math.sqrt(TRADING_DAYS_PER_YEAR) * 100) : null,
      riskContributionPercent: portfolioVariance > 0 ? round((weight * marginalVariance / portfolioVariance) * 100) : null,
      correlationToPortfolio: correlation(assetValues, portfolioValues),
    };
  }).sort((left, right) => (right.riskContributionPercent ?? -Infinity) - (left.riskContributionPercent ?? -Infinity));
  const correlationSeries = activeSeries.slice(0, 10);
  const correlations: CorrelationMatrix = {
    assets: correlationSeries.map((series) => ({ key: series.key, symbol: series.symbol, name: series.name })),
    values: correlationSeries.map((left) => correlationSeries.map((right) => {
      if (left.key === right.key) return 1;
      const leftReturns = returnMaps.get(left.key);
      const rightReturns = returnMaps.get(right.key);
      if (!leftReturns || !rightReturns) return null;
      const [leftValues, rightValues] = pairedReturns(leftReturns, rightReturns);
      return correlation(leftValues, rightValues);
    })),
  };
  const sortedWeights = activeSeries.map((series) => weights.get(series.key) ?? 0).sort((left, right) => right - left);
  const sumTop = (count: number) => round(sortedWeights.slice(0, count).reduce((sum, weight) => sum + weight, 0) * 100);
  const krwWeight = activeSeries.filter((series) => series.currency === "KRW").reduce((sum, series) => sum + (weights.get(series.key) ?? 0), 0);
  const individualVolatility = activeSeries.reduce((sum, series) => {
    const values = Array.from(returnMaps.get(series.key)?.values() ?? []);
    return sum + (weights.get(series.key) ?? 0) * sampleStandardDeviation(values);
  }, 0);
  const portfolioVolatility = Math.sqrt(Math.max(0, portfolioVariance));
  return {
    riskContributions,
    correlations,
    exposure: {
      krwWeightPercent: round(krwWeight * 100),
      usdWeightPercent: round((1 - krwWeight) * 100),
      domesticWeightPercent: round(krwWeight * 100),
      overseasWeightPercent: round((1 - krwWeight) * 100),
      top1WeightPercent: sumTop(1),
      top5WeightPercent: sumTop(5),
      top10WeightPercent: sumTop(10),
      diversificationBenefitPercent: individualVolatility > 0 && portfolioVariance > 0
        ? round((1 - portfolioVolatility / individualVolatility) * 100)
        : null,
    },
  };
}

function buildTradeBehavior(
  orders: DatedOrder[],
  fromDate: string,
  toDate: string,
  convertAmount: (value: number, currency: string, date: string) => number,
): AdvancedAnalytics["tradeBehavior"] {
  type Lot = { quantity: number; unitCost: number; date: string };
  const lots = new Map<string, Lot[]>();
  const realized: Array<{ profitLoss: number; quantity: number; holdingDays: number }> = [];
  let matchedSellCount = 0;
  let unmatchedSellCount = 0;
  for (const { order, date } of orders.filter((item) => item.date <= toDate)) {
    if (order.filledQuantity <= 0) continue;
    const key = `${order.currency}:${order.symbol}`;
    const orderLots = lots.get(key) ?? [];
    const gross = convertAmount(order.filledAmount, order.currency, date);
    const costs = convertAmount(order.commission + order.tax, order.currency, date);
    if (gross <= 0) continue;
    if (order.side !== "SELL") {
      orderLots.push({ quantity: order.filledQuantity, unitCost: (gross + costs) / order.filledQuantity, date });
      lots.set(key, orderLots);
      continue;
    }
    let remaining = order.filledQuantity;
    let matchedQuantity = 0;
    let costBasis = 0;
    let holdingDaysWeighted = 0;
    while (remaining > 0.0000001 && orderLots.length) {
      const lot = orderLots[0];
      const quantity = Math.min(remaining, lot.quantity);
      matchedQuantity += quantity;
      costBasis += quantity * lot.unitCost;
      holdingDaysWeighted += quantity * daysBetween(lot.date, date);
      remaining -= quantity;
      lot.quantity -= quantity;
      if (lot.quantity <= 0.0000001) orderLots.shift();
    }
    lots.set(key, orderLots);
    if (date < fromDate) continue;
    if (matchedQuantity <= 0 || remaining > 0.0000001) {
      unmatchedSellCount += 1;
      continue;
    }
    const matchedProceeds = (gross - costs) * (matchedQuantity / order.filledQuantity);
    realized.push({
      profitLoss: matchedProceeds - costBasis,
      quantity: matchedQuantity,
      holdingDays: holdingDaysWeighted / matchedQuantity,
    });
    matchedSellCount += 1;
  }
  const profits = realized.filter((item) => item.profitLoss > 0).reduce((sum, item) => sum + item.profitLoss, 0);
  const losses = realized.filter((item) => item.profitLoss < 0).reduce((sum, item) => sum + item.profitLoss, 0);
  const totalQuantity = realized.reduce((sum, item) => sum + item.quantity, 0);
  return {
    estimatedRealizedProfitLoss: round(realized.reduce((sum, item) => sum + item.profitLoss, 0), 2),
    estimatedWinRatePercent: realized.length
      ? round((realized.filter((item) => item.profitLoss > 0).length / realized.length) * 100)
      : null,
    estimatedProfitFactor: losses < 0 ? round(profits / Math.abs(losses)) : profits > 0 ? null : null,
    estimatedAverageHoldingDays: totalQuantity > 0
      ? round(realized.reduce((sum, item) => sum + item.holdingDays * item.quantity, 0) / totalQuantity, 1)
      : null,
    matchedSellCount,
    unmatchedSellCount,
  };
}

function buildCostEfficiency({
  datedOrders,
  candles,
  fromDate,
  toDate,
  totalBuyAmount,
  totalSellAmount,
  commission,
  tax,
  averageValue,
  estimatedReturnPercent,
  convertAmount,
}: {
  datedOrders: DatedOrder[];
  candles: Array<{ date: string; close: number }>;
  fromDate: string;
  toDate: string;
  totalBuyAmount: number;
  totalSellAmount: number;
  commission: number;
  tax: number;
  averageValue: number;
  estimatedReturnPercent: number | null;
  convertAmount: (value: number, currency: string, date: string) => number;
}): AdvancedAnalytics["costEfficiency"] {
  const totalCost = commission + tax;
  const tradedAmount = totalBuyAmount + totalSellAmount;
  const periodDatedOrders = datedOrders.filter((item) => item.date >= fromDate && item.date <= toDate);
  const monthValues = new Map<string, number[]>();
  for (const candle of candles) {
    const month = candle.date.slice(0, 7);
    const values = monthValues.get(month) ?? [];
    values.push(candle.close);
    monthValues.set(month, values);
  }
  const monthOrders = new Map<string, { amount: number; cost: number; count: number }>();
  for (const { order, date } of periodDatedOrders) {
    const month = date.slice(0, 7);
    const value = monthOrders.get(month) ?? { amount: 0, cost: 0, count: 0 };
    value.amount += convertAmount(order.filledAmount, order.currency, date);
    value.cost += convertAmount(order.commission + order.tax, order.currency, date);
    value.count += 1;
    monthOrders.set(month, value);
  }
  const monthly = Array.from(new Set([...monthValues.keys(), ...monthOrders.keys()])).sort().map((month) => {
    const orders = monthOrders.get(month) ?? { amount: 0, cost: 0, count: 0 };
    const monthlyAverage = average(monthValues.get(month) ?? []);
    return {
      month,
      turnoverPercent: monthlyAverage > 0 ? round((orders.amount / (2 * monthlyAverage)) * 100) : 0,
      tradeCount: orders.count,
      cost: round(orders.cost, 2),
    };
  });
  const costDragPercent = averageValue > 0 ? round((totalCost / averageValue) * 100) : null;
  return {
    costDragPercent,
    grossEstimatedReturnPercent: estimatedReturnPercent === null || costDragPercent === null
      ? null
      : round(estimatedReturnPercent + costDragPercent),
    costPerTradedAmountBps: tradedAmount > 0 ? round((totalCost / tradedAmount) * 10_000, 2) : null,
    averageTradeAmount: periodDatedOrders.length ? round(tradedAmount / periodDatedOrders.length, 2) : null,
    buySellAmountRatio: totalSellAmount > 0 ? round(totalBuyAmount / totalSellAmount) : null,
    monthly,
  };
}

export function calculateAdvancedAnalytics({
  detail,
  history,
  candles,
  benchmarks,
  orders,
  datedOrders,
  fromDate,
  toDate,
  riskFreeRatePercent,
  totalBuyAmount,
  totalSellAmount,
  commission,
  tax,
  averageValue,
  estimatedReturnPercent,
  convertAmount,
}: {
  detail: PortfolioReturnDetail;
  history: PortfolioHistory;
  candles: Array<{ date: string; close: number }>;
  benchmarks: BenchmarkInput[];
  orders: HistoricalOrder[];
  datedOrders: DatedOrder[];
  fromDate: string;
  toDate: string;
  riskFreeRatePercent: number;
  totalBuyAmount: number;
  totalSellAmount: number;
  commission: number;
  tax: number;
  averageValue: number;
  estimatedReturnPercent: number | null;
  convertAmount: (value: number, currency: string, date: string) => number;
}): AdvancedAnalytics {
  const baseDate = history.points[0]?.date ?? fromDate;
  const riskAnalytics = buildRiskAnalytics(history, detail);
  return {
    benchmarkComparisons: benchmarks.map((benchmark) => calculateBenchmarkComparison(
      benchmark,
      detail.returns,
      baseDate,
      riskFreeRatePercent,
    )),
    rolling: buildRollingMetrics(detail.returns, benchmarks, baseDate, riskFreeRatePercent),
    drawdowns: buildDrawdownAnalytics(detail.returns, baseDate),
    tailRisk: buildTailRisk(detail.returns),
    monthlyReturns: monthlyReturnSeries(detail.returns),
    attributionByKey: buildAttribution(detail),
    ...riskAnalytics,
    costEfficiency: buildCostEfficiency({
      datedOrders,
      candles,
      fromDate,
      toDate,
      totalBuyAmount,
      totalSellAmount,
      commission,
      tax,
      averageValue,
      estimatedReturnPercent,
      convertAmount,
    }),
    tradeBehavior: buildTradeBehavior(
      datedOrders.length ? datedOrders : orders.map((order) => ({ order, date: "" })),
      fromDate,
      toDate,
      convertAmount,
    ),
  };
}
