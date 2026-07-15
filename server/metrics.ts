import type {
  BenchmarkPricePoint,
  PortfolioAnalysisCandle,
  PortfolioHistory,
} from "./history.js";
import { kstDateString } from "./history.js";
import type { HistoricalOrder } from "./toss.js";

const TRADING_DAYS_PER_YEAR = 252;

export type BenchmarkMetricKey = "KOSPI" | "KOSDAQ" | "NASDAQ100" | "SP500";

export type PortfolioAnalyticsMetrics = {
  valuationChangePercent: number;
  estimatedReturnPercent: number | null;
  annualizedReturnPercent: number | null;
  annualizedVolatilityPercent: number | null;
  maxDrawdownPercent: number | null;
  currentDrawdownPercent: number | null;
  maxDrawdownDays: number | null;
  sharpeRatio: number | null;
  sortinoRatio: number | null;
  calmarRatio: number | null;
  top3WeightPercent: number;
  hhi: number;
  effectivePositions: number;
  benchmarkReturns: Partial<Record<BenchmarkMetricKey, number>>;
  excessReturns: Partial<Record<BenchmarkMetricKey, number>>;
  totalBuyAmount: number;
  totalSellAmount: number;
  commission: number;
  tax: number;
  turnoverPercent: number;
  tradeCount: number;
  riskFreeRatePercent: 0;
};

export type PortfolioContribution = {
  key: string;
  symbol: string;
  name: string;
  market: string;
  currency: "KRW" | "USD";
  estimatedProfitLoss: number;
  contributionPercent: number;
};

export type PortfolioDailyReturn = { date: string; value: number };

type BenchmarkInput = {
  key: BenchmarkMetricKey;
  points: BenchmarkPricePoint[];
};

function round(value: number, digits = 4): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function safeRatio(value: number): number | null {
  return Number.isFinite(value) ? round(value) : null;
}

function daysBetween(from: string, to: string): number {
  return Math.max(0, Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000));
}

export function analysisOrderDate(order: HistoricalOrder): string {
  const timestamp = order.filledAt || order.orderedAt;
  if (!timestamp) return "";
  const parsed = new Date(timestamp);
  if (!Number.isNaN(parsed.getTime()) && /(?:Z|[+-]\d{2}:?\d{2})$/i.test(timestamp)) {
    return kstDateString(parsed);
  }
  return timestamp.match(/^(\d{4}-\d{2}-\d{2})/)?.[1] ?? "";
}

function convertedAmount(value: number, currency: string, date: string, exchangeRates: ReadonlyMap<string, number>): number {
  if (currency !== "USD") return value;
  const rate = exchangeRates.get(date);
  return rate && rate > 0 ? value * rate : 0;
}

function dailyReturns(
  candles: PortfolioAnalysisCandle[],
  orders: HistoricalOrder[],
  exchangeRates: ReadonlyMap<string, number>,
): Array<{ date: string; value: number }> {
  const sortedCandles = [...candles].sort((left, right) => left.date.localeCompare(right.date));
  const datedOrders = orders
    .map((order) => ({ order, date: analysisOrderDate(order) }))
    .filter((item) => item.date);
  const result: Array<{ date: string; value: number }> = [];
  for (let index = 1; index < sortedCandles.length; index += 1) {
    const previous = sortedCandles[index - 1];
    const current = sortedCandles[index];
    if (previous.close <= 0) continue;
    const netPurchaseFlow = datedOrders.reduce((sum, item) => {
      if (item.date <= previous.date || item.date > current.date) return sum;
      const amount = convertedAmount(item.order.filledAmount, item.order.currency, item.date, exchangeRates);
      return sum + (item.order.side === "SELL" ? -amount : amount);
    }, 0);
    const value = (current.close - previous.close - netPurchaseFlow) / previous.close;
    if (Number.isFinite(value) && value > -1) result.push({ date: current.date, value });
  }
  return result;
}

function benchmarkReturn(points: BenchmarkPricePoint[]): number | undefined {
  const sorted = [...points].filter((point) => point.close > 0).sort((left, right) => left.date.localeCompare(right.date));
  if (sorted.length < 2) return undefined;
  return round(((sorted.at(-1)!.close / sorted[0].close) - 1) * 100);
}

function concentrationMetrics(history: PortfolioHistory): Pick<PortfolioAnalyticsMetrics, "top3WeightPercent" | "hhi" | "effectivePositions"> {
  const latest = history.points.at(-1);
  const weights = latest
    ? history.series.map((series) => Math.max(0, latest.values[series.key] ?? 0) / 100).filter((weight) => weight > 0)
    : [];
  const hhi = weights.reduce((sum, weight) => sum + weight ** 2, 0);
  return {
    top3WeightPercent: round(weights.sort((left, right) => right - left).slice(0, 3).reduce((sum, weight) => sum + weight, 0) * 100),
    hhi: round(hhi, 6),
    effectivePositions: hhi > 0 ? round(1 / hhi, 2) : 0,
  };
}

export function calculatePortfolioAnalytics({
  candles,
  history,
  orders,
  exchangeRates,
  benchmarks,
  returnSeries,
}: {
  candles: PortfolioAnalysisCandle[];
  history: PortfolioHistory;
  orders: HistoricalOrder[];
  exchangeRates: ReadonlyMap<string, number>;
  benchmarks: BenchmarkInput[];
  returnSeries?: PortfolioDailyReturn[];
}): { metrics: PortfolioAnalyticsMetrics; contributions: PortfolioContribution[] } {
  const sortedCandles = [...candles].sort((left, right) => left.date.localeCompare(right.date));
  const firstCandle = sortedCandles[0];
  const lastCandle = sortedCandles.at(-1);
  const valuationChangePercent = firstCandle && lastCandle && firstCandle.open > 0
    ? round(((lastCandle.close / firstCandle.open) - 1) * 100)
    : 0;
  const returns = returnSeries ?? dailyReturns(sortedCandles, orders, exchangeRates);
  const cumulativeMultiplier = returns.reduce((value, item) => value * (1 + item.value), 1);
  const estimatedReturnPercent = returns.length ? round((cumulativeMultiplier - 1) * 100) : null;
  const annualizedReturnPercent = returns.length && cumulativeMultiplier > 0
    ? round((cumulativeMultiplier ** (TRADING_DAYS_PER_YEAR / returns.length) - 1) * 100)
    : null;
  const mean = returns.length ? returns.reduce((sum, item) => sum + item.value, 0) / returns.length : 0;
  const variance = returns.length > 1
    ? returns.reduce((sum, item) => sum + (item.value - mean) ** 2, 0) / (returns.length - 1)
    : 0;
  const standardDeviation = Math.sqrt(variance);
  const downsideDeviation = returns.length
    ? Math.sqrt(returns.reduce((sum, item) => sum + Math.min(item.value, 0) ** 2, 0) / returns.length)
    : 0;

  let indexValue = 1;
  let peakValue = 1;
  let peakDate = sortedCandles[0]?.date ?? "";
  let maxDrawdown = 0;
  let currentDrawdown = 0;
  let maxDrawdownDays = 0;
  for (const item of returns) {
    indexValue *= 1 + item.value;
    if (indexValue >= peakValue) {
      peakValue = indexValue;
      peakDate = item.date;
      currentDrawdown = 0;
    } else {
      currentDrawdown = (indexValue / peakValue) - 1;
      if (currentDrawdown < maxDrawdown) maxDrawdown = currentDrawdown;
      maxDrawdownDays = Math.max(maxDrawdownDays, daysBetween(peakDate, item.date));
    }
  }

  const metricFromDate = history.fromDate ?? history.points[0]?.date ?? "";
  const metricToDate = history.toDate ?? history.points.at(-1)?.date ?? "";
  const periodOrders = orders
    .map((order) => ({ order, date: analysisOrderDate(order) }))
    .filter((item) => item.date >= metricFromDate && item.date <= metricToDate);
  let totalBuyAmount = 0;
  let totalSellAmount = 0;
  let commission = 0;
  let tax = 0;
  for (const { order, date } of periodOrders) {
    const filledAmount = convertedAmount(order.filledAmount, order.currency, date, exchangeRates);
    if (order.side === "SELL") totalSellAmount += filledAmount;
    else totalBuyAmount += filledAmount;
    commission += convertedAmount(order.commission, order.currency, date, exchangeRates);
    tax += convertedAmount(order.tax, order.currency, date, exchangeRates);
  }
  const averageValue = sortedCandles.length
    ? sortedCandles.reduce((sum, candle) => sum + candle.close, 0) / sortedCandles.length
    : 0;

  const benchmarkReturns: Partial<Record<BenchmarkMetricKey, number>> = {};
  const excessReturns: Partial<Record<BenchmarkMetricKey, number>> = {};
  for (const benchmark of benchmarks) {
    const value = benchmarkReturn(benchmark.points);
    if (value === undefined) continue;
    benchmarkReturns[benchmark.key] = value;
    if (estimatedReturnPercent !== null) excessReturns[benchmark.key] = round(estimatedReturnPercent - value);
  }

  const firstPoint = history.points[0];
  const lastPoint = history.points.at(-1);
  const baseValue = firstPoint?.totalValue ?? 0;
  const contributions = history.series.map((series) => {
    const startValue = firstPoint ? firstPoint.totalValue * ((firstPoint.values[series.key] ?? 0) / 100) : 0;
    const endValue = lastPoint ? lastPoint.totalValue * ((lastPoint.values[series.key] ?? 0) / 100) : 0;
    let netPurchaseFlow = 0;
    for (const { order, date } of periodOrders) {
      if (date <= (firstPoint?.date ?? "") || order.symbol !== series.symbol || order.currency !== series.currency) continue;
      const amount = convertedAmount(order.filledAmount, order.currency, date, exchangeRates);
      netPurchaseFlow += order.side === "SELL" ? -amount : amount;
    }
    const estimatedProfitLoss = endValue - startValue - netPurchaseFlow;
    return {
      key: series.key,
      symbol: series.symbol,
      name: series.name,
      market: series.market,
      currency: series.currency,
      estimatedProfitLoss: round(estimatedProfitLoss, 2),
      contributionPercent: baseValue > 0 ? round((estimatedProfitLoss / baseValue) * 100) : 0,
    } satisfies PortfolioContribution;
  }).filter((item) => Math.abs(item.estimatedProfitLoss) >= 0.01)
    .sort((left, right) => Math.abs(right.estimatedProfitLoss) - Math.abs(left.estimatedProfitLoss))
    .slice(0, 8);

  const concentration = concentrationMetrics(history);
  const annualizedVolatilityPercent = returns.length > 1 ? round(standardDeviation * Math.sqrt(TRADING_DAYS_PER_YEAR) * 100) : null;
  const sharpeRatio = returns.length > 1 && standardDeviation > 0
    ? safeRatio((mean / standardDeviation) * Math.sqrt(TRADING_DAYS_PER_YEAR))
    : null;
  const sortinoRatio = returns.length && downsideDeviation > 0
    ? safeRatio((mean / downsideDeviation) * Math.sqrt(TRADING_DAYS_PER_YEAR))
    : null;
  const calmarRatio = annualizedReturnPercent !== null && maxDrawdown < 0
    ? safeRatio((annualizedReturnPercent / 100) / Math.abs(maxDrawdown))
    : null;

  return {
    metrics: {
      valuationChangePercent,
      estimatedReturnPercent,
      annualizedReturnPercent,
      annualizedVolatilityPercent,
      maxDrawdownPercent: returns.length ? round(maxDrawdown * 100) : null,
      currentDrawdownPercent: returns.length ? round(currentDrawdown * 100) : null,
      maxDrawdownDays: returns.length ? maxDrawdownDays : null,
      sharpeRatio,
      sortinoRatio,
      calmarRatio,
      ...concentration,
      benchmarkReturns,
      excessReturns,
      totalBuyAmount: round(totalBuyAmount, 2),
      totalSellAmount: round(totalSellAmount, 2),
      commission: round(commission, 2),
      tax: round(tax, 2),
      turnoverPercent: averageValue > 0 ? round(((totalBuyAmount + totalSellAmount) / (2 * averageValue)) * 100) : 0,
      tradeCount: periodOrders.length,
      riskFreeRatePercent: 0,
    },
    contributions,
  };
}
