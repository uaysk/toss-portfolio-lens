const TRADING_DAYS_PER_YEAR = 252;

export type BacktestReturnPoint = { date: string; value: number };

export type BacktestTradeEvent = {
  date: string;
  assetIndex: number;
  side: "BUY" | "SELL";
  amount: number;
  quantity: number;
  price: number;
  reason: "initial" | "cash-flow" | "rebalance";
};

export type BacktestAdvancedAnalytics = {
  benchmarkComparison?: {
    key: string;
    name: string;
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
  rolling: Array<{
    date: string;
    return20d: number | null;
    return60d: number | null;
    return120d: number | null;
    return252d: number | null;
    volatility60d: number | null;
    sharpe60d: number | null;
    benchmarkExcess60d: number | null;
    benchmarkBeta60d: number | null;
    benchmarkCorrelation60d: number | null;
  }>;
  drawdowns: {
    points: Array<{ date: string; drawdownPercent: number }>;
    episodes: Array<{
      startDate: string;
      troughDate: string;
      recoveryDate?: string;
      depthPercent: number;
      durationDays: number;
      recoveryDays?: number;
    }>;
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
  riskContributions: Array<{
    key: string;
    symbol: string;
    name: string;
    averageWeightPercent: number;
    endingWeightPercent: number;
    annualizedVolatilityPercent: number | null;
    riskContributionPercent: number | null;
    correlationToPortfolio: number | null;
  }>;
  exposure: {
    krwWeightPercent: number;
    usdWeightPercent: number;
    domesticWeightPercent: number;
    overseasWeightPercent: number;
    top1WeightPercent: number;
    top5WeightPercent: number;
    top10WeightPercent: number;
    hhi: number;
    effectivePositions: number | null;
    diversificationBenefitPercent: number | null;
  };
  costEfficiency: {
    transactionCostBps: number;
    turnoverPercent: number | null;
    totalTradedAmount: number;
    ongoingTradedAmount: number;
    estimatedTotalCost: number;
    costDragPercent: number | null;
    grossReturnPercent: number;
    netEstimatedReturnPercent: number | null;
    averageTradeAmount: number | null;
    buySellAmountRatio: number | null;
    tradeCount: number;
    monthly: Array<{
      month: string;
      turnoverPercent: number;
      tradeCount: number;
      tradedAmount: number;
      estimatedCost: number;
    }>;
  };
  tradeBehavior: {
    estimatedRealizedProfitLoss: number;
    estimatedWinRatePercent: number | null;
    estimatedProfitFactor: number | null;
    estimatedAverageHoldingDays: number | null;
    matchedSellCount: number;
    unmatchedSellCount: number;
    buyCount: number;
    sellCount: number;
  };
  dataQuality: {
    confidence: "high" | "medium" | "limited";
    observationDays: number;
    returnObservationDays: number;
    requestedCalendarDays: number;
    effectiveStartDate: string;
    effectiveEndDate: string;
    commonCoveragePercent: number;
    carriedForwardObservations: number;
    benchmarkObservations: number;
    assets: Array<{
      key: string;
      symbol: string;
      name: string;
      observations: number;
      alignedDays: number;
      coveragePercent: number;
      firstDate: string;
      lastDate: string;
    }>;
    notes: string[];
  };
};

type AnalyticsAsset = {
  symbol: string;
  name: string;
  market: string;
  currency: "KRW" | "USD";
};

function round(value: number, digits = 4): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function average(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function standardDeviation(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = average(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1));
}

function covariance(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length);
  if (length < 2) return 0;
  const leftValues = left.slice(0, length);
  const rightValues = right.slice(0, length);
  const leftMean = average(leftValues);
  const rightMean = average(rightValues);
  return leftValues.reduce((sum, value, index) => (
    sum + (value - leftMean) * (rightValues[index] - rightMean)
  ), 0) / (length - 1);
}

function correlation(left: number[], right: number[]): number | null {
  const denominator = standardDeviation(left) * standardDeviation(right);
  return denominator > 0 ? round(covariance(left, right) / denominator, 6) : null;
}

function compoundedReturn(values: number[]): number | null {
  return values.length ? values.reduce((value, item) => value * (1 + item), 1) - 1 : null;
}

function rollingReturn(values: number[], endIndex: number, window: number): number | null {
  return endIndex + 1 >= window ? compoundedReturn(values.slice(endIndex + 1 - window, endIndex + 1)) : null;
}

function daysBetween(from: string, to: string): number {
  return Math.max(0, Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000));
}

function percentile(values: number[], probability: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * probability) - 1)];
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

function monthlyReturns(returns: BacktestReturnPoint[]): Array<{ month: string; returnPercent: number }> {
  const byMonth = new Map<string, number[]>();
  for (const item of returns) {
    const month = item.date.slice(0, 7);
    const values = byMonth.get(month) ?? [];
    values.push(item.value);
    byMonth.set(month, values);
  }
  return Array.from(byMonth, ([month, values]) => ({
    month,
    returnPercent: round((compoundedReturn(values) ?? 0) * 100),
  })).sort((left, right) => left.month.localeCompare(right.month));
}

function relativeMaxDrawdown(portfolio: number[], benchmark: number[]): number | null {
  if (!portfolio.length || portfolio.length !== benchmark.length) return null;
  let value = 1;
  let peak = 1;
  let maximum = 0;
  for (let index = 0; index < portfolio.length; index += 1) {
    if (benchmark[index] <= -1) continue;
    value *= (1 + portfolio[index]) / (1 + benchmark[index]);
    peak = Math.max(peak, value);
    maximum = Math.min(maximum, value / peak - 1);
  }
  return round(maximum * 100);
}

function benchmarkComparison({
  key,
  name,
  portfolio,
  benchmark,
  dates,
  riskFreeRatePercent,
}: {
  key: string;
  name: string;
  portfolio: number[];
  benchmark: number[];
  dates: string[];
  riskFreeRatePercent: number;
}): NonNullable<BacktestAdvancedAnalytics["benchmarkComparison"]> {
  const active = portfolio.map((value, index) => value - benchmark[index]);
  const trackingError = standardDeviation(active);
  const benchmarkVariance = standardDeviation(benchmark) ** 2;
  const beta = benchmarkVariance > 0 ? covariance(portfolio, benchmark) / benchmarkVariance : null;
  const dailyRiskFree = (1 + riskFreeRatePercent / 100) ** (1 / TRADING_DAYS_PER_YEAR) - 1;
  const alpha = beta === null
    ? null
    : ((average(portfolio) - dailyRiskFree) - beta * (average(benchmark) - dailyRiskFree)) * TRADING_DAYS_PER_YEAR;
  const upside = benchmark.map((value, index) => ({ portfolio: portfolio[index], benchmark: value })).filter((item) => item.benchmark > 0);
  const downside = benchmark.map((value, index) => ({ portfolio: portfolio[index], benchmark: value })).filter((item) => item.benchmark < 0);
  const capture = (values: typeof upside): number | null => {
    const benchmarkMean = average(values.map((item) => item.benchmark));
    return values.length && benchmarkMean !== 0
      ? round((average(values.map((item) => item.portfolio)) / benchmarkMean) * 100)
      : null;
  };
  const months = new Map<string, number[]>();
  for (let index = 0; index < dates.length; index += 1) {
    const month = dates[index].slice(0, 7);
    const indices = months.get(month) ?? [];
    indices.push(index);
    months.set(month, indices);
  }
  const monthlyWins = Array.from(months.values()).filter((indices) => (
    (compoundedReturn(indices.map((index) => portfolio[index])) ?? 0)
      > (compoundedReturn(indices.map((index) => benchmark[index])) ?? 0)
  )).length;
  const portfolioReturn = compoundedReturn(portfolio);
  const benchmarkReturn = compoundedReturn(benchmark);
  return {
    key,
    name,
    observations: portfolio.length,
    returnPercent: benchmarkReturn === null ? null : round(benchmarkReturn * 100),
    excessReturnPercent: portfolioReturn === null || benchmarkReturn === null
      ? null
      : round((portfolioReturn - benchmarkReturn) * 100),
    trackingErrorPercent: portfolio.length > 1 ? round(trackingError * Math.sqrt(TRADING_DAYS_PER_YEAR) * 100) : null,
    informationRatio: trackingError > 0 ? round((average(active) / trackingError) * Math.sqrt(TRADING_DAYS_PER_YEAR)) : null,
    beta: beta === null ? null : round(beta),
    alphaPercent: alpha === null ? null : round(alpha * 100),
    correlation: correlation(portfolio, benchmark),
    upsideCapturePercent: capture(upside),
    downsideCapturePercent: capture(downside),
    dailyWinRatePercent: portfolio.length
      ? round((portfolio.filter((value, index) => value > benchmark[index]).length / portfolio.length) * 100)
      : null,
    monthlyWinRatePercent: months.size ? round((monthlyWins / months.size) * 100) : null,
    relativeMaxDrawdownPercent: relativeMaxDrawdown(portfolio, benchmark),
  };
}

function rollingAnalytics(
  returns: BacktestReturnPoint[],
  benchmarkReturns: number[] | undefined,
  riskFreeRatePercent: number,
): BacktestAdvancedAnalytics["rolling"] {
  const values = returns.map((item) => item.value);
  const dailyRiskFree = (1 + riskFreeRatePercent / 100) ** (1 / TRADING_DAYS_PER_YEAR) - 1;
  return returns.map((item, index) => {
    const sixty = index + 1 >= 60 ? values.slice(index - 59, index + 1) : [];
    const benchmarkSixty = benchmarkReturns && index + 1 >= 60
      ? benchmarkReturns.slice(index - 59, index + 1)
      : [];
    const volatility = standardDeviation(sixty);
    const benchmarkVariance = standardDeviation(benchmarkSixty) ** 2;
    const percent = (value: number | null) => value === null ? null : round(value * 100);
    const portfolioSixtyReturn = compoundedReturn(sixty);
    const benchmarkSixtyReturn = compoundedReturn(benchmarkSixty);
    return {
      date: item.date,
      return20d: percent(rollingReturn(values, index, 20)),
      return60d: percent(rollingReturn(values, index, 60)),
      return120d: percent(rollingReturn(values, index, 120)),
      return252d: percent(rollingReturn(values, index, 252)),
      volatility60d: sixty.length === 60 ? round(volatility * Math.sqrt(TRADING_DAYS_PER_YEAR) * 100) : null,
      sharpe60d: sixty.length === 60 && volatility > 0
        ? round(((average(sixty) - dailyRiskFree) / volatility) * Math.sqrt(TRADING_DAYS_PER_YEAR))
        : null,
      benchmarkExcess60d: portfolioSixtyReturn !== null && benchmarkSixtyReturn !== null
        ? round((portfolioSixtyReturn - benchmarkSixtyReturn) * 100)
        : null,
      benchmarkBeta60d: sixty.length === 60 && benchmarkVariance > 0
        ? round(covariance(sixty, benchmarkSixty) / benchmarkVariance)
        : null,
      benchmarkCorrelation60d: sixty.length === 60 ? correlation(sixty, benchmarkSixty) : null,
    };
  });
}

function drawdownAnalytics(returns: BacktestReturnPoint[], baseDate: string): BacktestAdvancedAnalytics["drawdowns"] {
  type Episode = BacktestAdvancedAnalytics["drawdowns"]["episodes"][number];
  let value = 1;
  let peak = 1;
  let peakDate = baseDate;
  let current: Episode | undefined;
  const points = [{ date: baseDate, drawdownPercent: 0 }];
  const episodes: Episode[] = [];
  for (const item of returns) {
    value *= 1 + item.value;
    if (value >= peak) {
      if (current) {
        current.recoveryDate = item.date;
        current.durationDays = daysBetween(current.startDate, item.date);
        current.recoveryDays = daysBetween(current.troughDate, item.date);
        episodes.push(current);
        current = undefined;
      }
      peak = value;
      peakDate = item.date;
    } else {
      const drawdown = value / peak - 1;
      if (!current) {
        current = {
          startDate: peakDate,
          troughDate: item.date,
          depthPercent: round(drawdown * 100),
          durationDays: daysBetween(peakDate, item.date),
        };
      } else {
        current.durationDays = daysBetween(current.startDate, item.date);
        if (drawdown < current.depthPercent / 100) {
          current.depthPercent = round(drawdown * 100);
          current.troughDate = item.date;
        }
      }
    }
    points.push({ date: item.date, drawdownPercent: round((value / peak - 1) * 100) });
  }
  if (current) episodes.push(current);
  const negative = points.map((point) => point.drawdownPercent).filter((value) => value < 0);
  const values = returns.map((item) => item.value);
  const worstWindow = (window: number): number | null => {
    const candidates = values.map((_, index) => rollingReturn(values, index, window)).filter((value): value is number => value !== null);
    return candidates.length ? round(Math.min(...candidates) * 100) : null;
  };
  return {
    points,
    episodes: [...episodes].sort((left, right) => left.depthPercent - right.depthPercent).slice(0, 5),
    currentUnderwaterDays: current ? daysBetween(current.startDate, returns.at(-1)?.date ?? baseDate) : 0,
    averageDrawdownPercent: negative.length ? round(average(negative)) : null,
    ulcerIndex: negative.length ? round(Math.sqrt(average(negative.map((drawdown) => drawdown ** 2)))) : null,
    worst20DayReturnPercent: worstWindow(20),
    worst60DayReturnPercent: worstWindow(60),
  };
}

function tailRiskAnalytics(returns: number[]): BacktestAdvancedAnalytics["tailRisk"] {
  const gains = returns.filter((value) => value > 0);
  const losses = returns.filter((value) => value < 0);
  const valueAtRisk = percentile(returns, 0.05);
  const tail = valueAtRisk === null ? [] : returns.filter((value) => value <= valueAtRisk);
  const mean = average(returns);
  const deviation = standardDeviation(returns);
  const averageGain = gains.length ? average(gains) : null;
  const averageLoss = losses.length ? average(losses) : null;
  return {
    historicalVar95Percent: valueAtRisk === null ? null : round(valueAtRisk * 100),
    expectedShortfall95Percent: tail.length ? round(average(tail) * 100) : null,
    lossDaysPercent: returns.length ? round((losses.length / returns.length) * 100) : null,
    averageGainPercent: averageGain === null ? null : round(averageGain * 100),
    averageLossPercent: averageLoss === null ? null : round(averageLoss * 100),
    gainLossRatio: averageGain !== null && averageLoss !== null && averageLoss !== 0
      ? round(averageGain / Math.abs(averageLoss))
      : null,
    skewness: returns.length >= 3 && deviation > 0
      ? round(average(returns.map((value) => ((value - mean) / deviation) ** 3)))
      : null,
    excessKurtosis: returns.length >= 4 && deviation > 0
      ? round(average(returns.map((value) => ((value - mean) / deviation) ** 4)) - 3)
      : null,
    maxConsecutiveGainDays: longestStreak(returns, (value) => value > 0),
    maxConsecutiveLossDays: longestStreak(returns, (value) => value < 0),
  };
}

function riskAnalytics({
  assets,
  assetReturns,
  portfolioReturns,
  averageWeights,
  endingWeights,
}: {
  assets: AnalyticsAsset[];
  assetReturns: number[][];
  portfolioReturns: number[];
  averageWeights: number[];
  endingWeights: number[];
}): Pick<BacktestAdvancedAnalytics, "riskContributions" | "exposure"> {
  let portfolioVariance = 0;
  for (let left = 0; left < assets.length; left += 1) {
    for (let right = 0; right < assets.length; right += 1) {
      portfolioVariance += averageWeights[left] * averageWeights[right] * covariance(assetReturns[left], assetReturns[right]);
    }
  }
  const riskContributions = assets.map((asset, index) => {
    const marginalVariance = assets.reduce((sum, _, otherIndex) => (
      sum + averageWeights[otherIndex] * covariance(assetReturns[index], assetReturns[otherIndex])
    ), 0);
    const volatility = standardDeviation(assetReturns[index]);
    return {
      key: `${asset.currency}:${asset.symbol}`,
      symbol: asset.symbol,
      name: asset.name,
      averageWeightPercent: round(averageWeights[index] * 100),
      endingWeightPercent: round(endingWeights[index] * 100),
      annualizedVolatilityPercent: assetReturns[index].length > 1
        ? round(volatility * Math.sqrt(TRADING_DAYS_PER_YEAR) * 100)
        : null,
      riskContributionPercent: portfolioVariance > 0
        ? round((averageWeights[index] * marginalVariance / portfolioVariance) * 100)
        : null,
      correlationToPortfolio: correlation(assetReturns[index], portfolioReturns),
    };
  }).sort((left, right) => (right.riskContributionPercent ?? -Infinity) - (left.riskContributionPercent ?? -Infinity));
  const sortedWeights = [...endingWeights].sort((left, right) => right - left);
  const sumTop = (count: number) => round(sortedWeights.slice(0, count).reduce((sum, weight) => sum + weight, 0) * 100);
  const krwWeight = assets.reduce((sum, asset, index) => sum + (asset.currency === "KRW" ? endingWeights[index] : 0), 0);
  const hhi = endingWeights.reduce((sum, weight) => sum + weight ** 2, 0);
  const weightedIndividualVolatility = assets.reduce((sum, _, index) => (
    sum + averageWeights[index] * standardDeviation(assetReturns[index])
  ), 0);
  const portfolioVolatility = Math.sqrt(Math.max(0, portfolioVariance));
  return {
    riskContributions,
    exposure: {
      krwWeightPercent: round(krwWeight * 100),
      usdWeightPercent: round((1 - krwWeight) * 100),
      domesticWeightPercent: round(krwWeight * 100),
      overseasWeightPercent: round((1 - krwWeight) * 100),
      top1WeightPercent: sumTop(1),
      top5WeightPercent: sumTop(5),
      top10WeightPercent: sumTop(10),
      hhi: round(hhi, 6),
      effectivePositions: hhi > 0 ? round(1 / hhi, 2) : null,
      diversificationBenefitPercent: weightedIndividualVolatility > 0 && portfolioVariance > 0
        ? round((1 - portfolioVolatility / weightedIndividualVolatility) * 100)
        : null,
    },
  };
}

function costAnalytics({
  trades,
  balances,
  transactionCostBps,
  grossReturnPercent,
}: {
  trades: BacktestTradeEvent[];
  balances: Array<{ date: string; value: number }>;
  transactionCostBps: number;
  grossReturnPercent: number;
}): BacktestAdvancedAnalytics["costEfficiency"] {
  const totalTradedAmount = trades.reduce((sum, trade) => sum + trade.amount, 0);
  const ongoingTrades = trades.filter((trade) => trade.reason !== "initial");
  const ongoingTradedAmount = ongoingTrades.reduce((sum, trade) => sum + trade.amount, 0);
  const totalBuyAmount = trades.filter((trade) => trade.side === "BUY").reduce((sum, trade) => sum + trade.amount, 0);
  const totalSellAmount = trades.filter((trade) => trade.side === "SELL").reduce((sum, trade) => sum + trade.amount, 0);
  const averageValue = average(balances.map((point) => point.value));
  const estimatedTotalCost = totalTradedAmount * transactionCostBps / 10_000;
  const costDragPercent = averageValue > 0 ? (estimatedTotalCost / averageValue) * 100 : null;
  const valuesByMonth = new Map<string, number[]>();
  for (const point of balances) {
    const month = point.date.slice(0, 7);
    const values = valuesByMonth.get(month) ?? [];
    values.push(point.value);
    valuesByMonth.set(month, values);
  }
  const tradesByMonth = new Map<string, BacktestTradeEvent[]>();
  for (const trade of trades) {
    const month = trade.date.slice(0, 7);
    const values = tradesByMonth.get(month) ?? [];
    values.push(trade);
    tradesByMonth.set(month, values);
  }
  const monthly = Array.from(new Set([...valuesByMonth.keys(), ...tradesByMonth.keys()])).sort().map((month) => {
    const monthTrades = tradesByMonth.get(month) ?? [];
    const tradedAmount = monthTrades.reduce((sum, trade) => sum + trade.amount, 0);
    const averageMonthValue = average(valuesByMonth.get(month) ?? []);
    return {
      month,
      turnoverPercent: averageMonthValue > 0 ? round((tradedAmount / (2 * averageMonthValue)) * 100) : 0,
      tradeCount: monthTrades.length,
      tradedAmount: round(tradedAmount, 2),
      estimatedCost: round(tradedAmount * transactionCostBps / 10_000, 2),
    };
  });
  return {
    transactionCostBps: round(transactionCostBps, 2),
    turnoverPercent: averageValue > 0 ? round((ongoingTradedAmount / (2 * averageValue)) * 100) : null,
    totalTradedAmount: round(totalTradedAmount, 2),
    ongoingTradedAmount: round(ongoingTradedAmount, 2),
    estimatedTotalCost: round(estimatedTotalCost, 2),
    costDragPercent: costDragPercent === null ? null : round(costDragPercent),
    grossReturnPercent: round(grossReturnPercent),
    netEstimatedReturnPercent: costDragPercent === null ? null : round(grossReturnPercent - costDragPercent),
    averageTradeAmount: trades.length ? round(totalTradedAmount / trades.length, 2) : null,
    buySellAmountRatio: totalSellAmount > 0 ? round(totalBuyAmount / totalSellAmount) : null,
    tradeCount: trades.length,
    monthly,
  };
}

function tradeBehaviorAnalytics(trades: BacktestTradeEvent[]): BacktestAdvancedAnalytics["tradeBehavior"] {
  type Lot = { quantity: number; unitCost: number; date: string };
  const lots = new Map<number, Lot[]>();
  const realized: Array<{ profitLoss: number; quantity: number; holdingDays: number }> = [];
  let matchedSellCount = 0;
  let unmatchedSellCount = 0;
  for (const trade of trades) {
    const assetLots = lots.get(trade.assetIndex) ?? [];
    if (trade.side === "BUY") {
      if (trade.quantity > 0) assetLots.push({ quantity: trade.quantity, unitCost: trade.amount / trade.quantity, date: trade.date });
      lots.set(trade.assetIndex, assetLots);
      continue;
    }
    let remaining = trade.quantity;
    let matchedQuantity = 0;
    let costBasis = 0;
    let weightedHoldingDays = 0;
    while (remaining > 0.0000001 && assetLots.length) {
      const lot = assetLots[0];
      const quantity = Math.min(remaining, lot.quantity);
      matchedQuantity += quantity;
      costBasis += quantity * lot.unitCost;
      weightedHoldingDays += quantity * daysBetween(lot.date, trade.date);
      remaining -= quantity;
      lot.quantity -= quantity;
      if (lot.quantity <= 0.0000001) assetLots.shift();
    }
    lots.set(trade.assetIndex, assetLots);
    if (matchedQuantity <= 0 || remaining > 0.0000001) {
      unmatchedSellCount += 1;
      continue;
    }
    realized.push({
      profitLoss: trade.amount * (matchedQuantity / trade.quantity) - costBasis,
      quantity: matchedQuantity,
      holdingDays: weightedHoldingDays / matchedQuantity,
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
    estimatedProfitFactor: losses < 0 ? round(profits / Math.abs(losses)) : null,
    estimatedAverageHoldingDays: totalQuantity > 0
      ? round(realized.reduce((sum, item) => sum + item.holdingDays * item.quantity, 0) / totalQuantity, 1)
      : null,
    matchedSellCount,
    unmatchedSellCount,
    buyCount: trades.filter((trade) => trade.side === "BUY").length,
    sellCount: trades.filter((trade) => trade.side === "SELL").length,
  };
}

export function calculateBacktestAdvancedAnalytics({
  assets,
  baseDate,
  effectiveEndDate,
  requestedStartDate,
  returns,
  assetReturns,
  benchmark,
  averageWeights,
  endingWeights,
  trades,
  balances,
  transactionCostBps,
  riskFreeRatePercent,
  grossReturnPercent,
  priceCoverage,
}: {
  assets: AnalyticsAsset[];
  baseDate: string;
  effectiveEndDate: string;
  requestedStartDate: string;
  returns: BacktestReturnPoint[];
  assetReturns: number[][];
  benchmark?: { key: string; name: string; returns: number[]; observations: number };
  averageWeights: number[];
  endingWeights: number[];
  trades: BacktestTradeEvent[];
  balances: Array<{ date: string; value: number }>;
  transactionCostBps: number;
  riskFreeRatePercent: number;
  grossReturnPercent: number;
  priceCoverage: Array<{ observations: number; alignedDays: number; firstDate: string; lastDate: string }>;
}): BacktestAdvancedAnalytics {
  const returnValues = returns.map((item) => item.value);
  const risk = riskAnalytics({ assets, assetReturns, portfolioReturns: returnValues, averageWeights, endingWeights });
  const assetQuality = assets.map((asset, index) => {
    const coverage = priceCoverage[index];
    return {
      key: `${asset.currency}:${asset.symbol}`,
      symbol: asset.symbol,
      name: asset.name,
      observations: coverage.observations,
      alignedDays: coverage.alignedDays,
      coveragePercent: coverage.alignedDays > 0 ? round((coverage.observations / coverage.alignedDays) * 100) : 0,
      firstDate: coverage.firstDate,
      lastDate: coverage.lastDate,
    };
  });
  const carriedForwardObservations = assetQuality.reduce((sum, item) => sum + Math.max(0, item.alignedDays - item.observations), 0);
  const commonCoveragePercent = assetQuality.length
    ? round(Math.min(...assetQuality.map((item) => item.coveragePercent)))
    : 0;
  const confidence: BacktestAdvancedAnalytics["dataQuality"]["confidence"] = returns.length >= 60 && commonCoveragePercent >= 85
    ? "high"
    : returns.length >= 20 && commonCoveragePercent >= 65
      ? "medium"
      : "limited";
  const notes = [
    "서로 다른 시장의 휴장일은 직전 수정주가를 이월해 공통 일자에 정렬했습니다.",
    "해외 종목은 현지 통화 수정주가 수익률을 사용하며 과거 환율 변화는 포함하지 않습니다.",
  ];
  if (baseDate > requestedStartDate) notes.unshift(`공통 일봉이 시작되는 ${baseDate}부터 계산했습니다.`);
  return {
    ...(benchmark ? {
      benchmarkComparison: benchmarkComparison({
        key: benchmark.key,
        name: benchmark.name,
        portfolio: returnValues,
        benchmark: benchmark.returns,
        dates: returns.map((item) => item.date),
        riskFreeRatePercent,
      }),
    } : {}),
    rolling: rollingAnalytics(returns, benchmark?.returns, riskFreeRatePercent),
    drawdowns: drawdownAnalytics(returns, baseDate),
    tailRisk: tailRiskAnalytics(returnValues),
    monthlyReturns: monthlyReturns(returns),
    ...risk,
    costEfficiency: costAnalytics({ trades, balances, transactionCostBps, grossReturnPercent }),
    tradeBehavior: tradeBehaviorAnalytics(trades),
    dataQuality: {
      confidence,
      observationDays: returns.length + 1,
      returnObservationDays: returns.length,
      requestedCalendarDays: daysBetween(requestedStartDate, effectiveEndDate) + 1,
      effectiveStartDate: baseDate,
      effectiveEndDate,
      commonCoveragePercent,
      carriedForwardObservations,
      benchmarkObservations: benchmark?.observations ?? 0,
      assets: assetQuality,
      notes,
    },
  };
}
