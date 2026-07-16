import {
  calculateBacktestAdvancedAnalytics,
  type BacktestAdvancedAnalytics,
  type BacktestTradeEvent,
} from "./backtest-analytics.js";

export type BacktestRebalanceFrequency = "none" | "monthly" | "quarterly" | "annually";

export type BacktestAssetDefinition = {
  symbol: string;
  name: string;
  market: string;
  currency: "KRW" | "USD";
  listDate: string;
  weight: number;
};

export type BacktestPricePoint = {
  date: string;
  close: number;
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
  requestedStartDate: string;
  endDate: string;
  initialAmount: number;
  monthlyCashFlow: number;
  rebalanceFrequency: BacktestRebalanceFrequency;
  riskFreeRatePercent?: number;
  transactionCostBps?: number;
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
  }>;
  metrics: BacktestComparableMetrics & {
    finalBalance: number;
    totalContributions: number;
    totalWithdrawals: number;
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
    assetReturnPercent: number;
  }>;
  correlations: {
    assets: Array<{ symbol: string; name: string }>;
    values: Array<Array<number | null>>;
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

function shouldRebalance(previousDate: string, currentDate: string, frequency: BacktestRebalanceFrequency): boolean {
  if (frequency === "none") return false;
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

function downsample<T>(values: T[], maximum = 1_200): T[] {
  if (values.length <= maximum) return values;
  const result: T[] = [values[0]];
  const step = (values.length - 1) / (maximum - 1);
  for (let index = 1; index < maximum - 1; index += 1) {
    result.push(values[Math.round(index * step)]);
  }
  result.push(values.at(-1)!);
  return result;
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
  if (input.assets.length < 1 || input.assets.length > 20) {
    throw new BacktestValidationError("백테스트 종목은 1~20개까지 구성할 수 있습니다.");
  }
  if (!Number.isFinite(input.initialAmount) || input.initialAmount <= 0) {
    throw new BacktestValidationError("초기 투자금은 0보다 커야 합니다.");
  }
  const riskFreeRatePercent = input.riskFreeRatePercent ?? 0;
  const transactionCostBps = input.transactionCostBps ?? 0;
  if (!Number.isFinite(riskFreeRatePercent) || riskFreeRatePercent < -10 || riskFreeRatePercent > 50) {
    throw new BacktestValidationError("무위험수익률은 -10% 이상 50% 이하로 입력해 주세요.");
  }
  if (!Number.isFinite(transactionCostBps) || transactionCostBps < 0 || transactionCostBps > 500) {
    throw new BacktestValidationError("거래비용은 0bp 이상 500bp 이하로 입력해 주세요.");
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
  if (input.benchmark && !benchmarkSeries.length) {
    throw new BacktestValidationError(`${input.benchmark.name}의 선택 기간 일봉이 없습니다.`);
  }

  const allDates = Array.from(new Set([
    ...seriesByAsset.flatMap((series) => series.map((point) => point.date)),
    ...benchmarkSeries.map((point) => point.date),
  ])).sort();
  const assetCursors = input.assets.map(() => 0);
  const assetCloses = input.assets.map(() => 0);
  let benchmarkCursor = 0;
  let benchmarkClose = 0;
  const aligned: Array<{ date: string; closes: number[]; benchmarkClose?: number }> = [];
  for (const date of allDates) {
    for (let assetIndex = 0; assetIndex < seriesByAsset.length; assetIndex += 1) {
      const series = seriesByAsset[assetIndex];
      while (assetCursors[assetIndex] < series.length && series[assetCursors[assetIndex]].date <= date) {
        assetCloses[assetIndex] = series[assetCursors[assetIndex]].close;
        assetCursors[assetIndex] += 1;
      }
    }
    while (benchmarkCursor < benchmarkSeries.length && benchmarkSeries[benchmarkCursor].date <= date) {
      benchmarkClose = benchmarkSeries[benchmarkCursor].close;
      benchmarkCursor += 1;
    }
    if (assetCloses.every((close) => close > 0) && (!input.benchmark || benchmarkClose > 0)) {
      aligned.push({
        date,
        closes: [...assetCloses],
        ...(input.benchmark ? { benchmarkClose } : {}),
      });
    }
  }
  if (aligned.length < 2) throw new BacktestValidationError("모든 종목에 공통으로 존재하는 일봉이 2개 이상 필요합니다.");

  const weights = input.assets.map((asset) => asset.weight / 100);
  let positionValues = weights.map((weight) => input.initialAmount * weight);
  const marketProfitByAsset = input.assets.map(() => 0);
  const linkedContributionByAsset = input.assets.map(() => 0);
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
    for (let assetIndex = 0; assetIndex < input.assets.length; assetIndex += 1) {
      const assetReturn = current.closes[assetIndex] / previous.closes[assetIndex] - 1;
      assetReturns[assetIndex].push(assetReturn);
      dailyContributions[assetIndex] = beforeMarket > 0
        ? (positionValues[assetIndex] / beforeMarket) * assetReturn
        : 0;
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
    }
    if (input.benchmark) {
      benchmarkReturns.push((current.benchmarkClose ?? benchmarkBase) / (previous.benchmarkClose ?? benchmarkBase) - 1);
    }

    if (yearMonth(previous.date) !== yearMonth(current.date) && input.monthlyCashFlow !== 0) {
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

    if (shouldRebalance(previous.date, current.date, input.rebalanceFrequency)) {
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
      localPriceContributionPercent: round(linkedContributionByAsset[index]),
      fxContributionPercent: 0,
      assetReturnPercent: round((lastPrice / firstPrice - 1) * 100),
    };
  }).sort((left, right) => right.contributionPercent - left.contributionPercent);

  const correlations = input.assets.map((_, leftIndex) => (
    input.assets.map((__, rightIndex) => leftIndex === rightIndex ? 1 : pearson(assetReturns[leftIndex], assetReturns[rightIndex]))
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
        observations: benchmarkSeries.filter((point) => point.date >= effectiveStartDate && point.date <= effectiveEndDate).length,
      },
    } : {}),
    averageWeights,
    endingWeights,
    trades,
    balances: fullPoints.map((point) => ({ date: point.date, value: point.balance })),
    transactionCostBps,
    riskFreeRatePercent,
    grossReturnPercent: portfolioSummary.metrics.totalReturnPercent,
    priceCoverage: seriesByAsset.map((series) => {
      const observations = series.filter((point) => point.date >= effectiveStartDate && point.date <= effectiveEndDate);
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
    points: downsample(fullPoints),
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
    advanced,
  };
}
