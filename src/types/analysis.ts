import type { BackfillStatus, HistoryCurrency } from "./history";

export type AnalysisRange = "30d" | "90d" | "1y" | "all";
export type BenchmarkKey = "KOSPI" | "KOSDAQ" | "NASDAQ100" | "SP500";

export type PortfolioAnalysis = {
  accountId: string;
  currency: "KRW";
  baseCurrency: "KRW";
  includesCurrencies: ["KRW", "USD"];
  range: AnalysisRange;
  generatedAt: string;
  fromDate: string;
  toDate: string;
  estimatedOhlc: true;
  ohlcBackfillComplete: boolean;
  fxBackfillComplete: boolean;
  candles: Array<{
    date: string;
    open: number;
    high: number;
    low: number;
    close: number;
  }>;
  benchmarks: Array<{
    key: BenchmarkKey;
    name: string;
    proxySymbol?: string;
    baseCurrency: "KRW";
    currencyAdjusted: boolean;
    points: Array<{ date: string; close: number }>;
  }>;
  benchmarkErrors: Array<{ key: BenchmarkKey; message: string }>;
  metrics: {
    valuationChangePercent: number;
    estimatedReturnPercent: number | null;
    timeWeightedReturnPercent: number | null;
    moneyWeightedReturnPercent: number | null;
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
    benchmarkReturns: Partial<Record<BenchmarkKey, number>>;
    excessReturns: Partial<Record<BenchmarkKey, number>>;
    totalBuyAmount: number;
    totalSellAmount: number;
    commission: number;
    tax: number;
    turnoverPercent: number;
    tradeCount: number;
    netInvestedAmount: number;
    estimatedProfitLoss: number;
    bestDailyReturnPercent: number | null;
    worstDailyReturnPercent: number | null;
    positiveDaysPercent: number | null;
    riskFreeRatePercent: number;
  };
  contributions: Array<{
    key: string;
    symbol: string;
    name: string;
    market: string;
    currency: HistoryCurrency;
    estimatedProfitLoss: number;
    contributionPercent: number;
    timeLinkedContributionPercent: number;
    localPriceContributionPercent: number;
    fxContributionPercent: number;
  }>;
  benchmarkComparisons: Array<{
    key: BenchmarkKey;
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
  }>;
  rolling: Array<{
    date: string;
    return20d: number | null;
    return60d: number | null;
    return120d: number | null;
    return252d: number | null;
    volatility60d: number | null;
    sharpe60d: number | null;
    benchmarkExcess60d: Partial<Record<BenchmarkKey, number>>;
    benchmarkBeta60d: Partial<Record<BenchmarkKey, number>>;
    benchmarkCorrelation60d: Partial<Record<BenchmarkKey, number>>;
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
  attributionByKey: Record<string, {
    timeLinkedContributionPercent: number;
    localPriceContributionPercent: number;
    fxContributionPercent: number;
  }>;
  riskContributions: Array<{
    key: string;
    symbol: string;
    name: string;
    weightPercent: number;
    annualizedVolatilityPercent: number | null;
    riskContributionPercent: number | null;
    correlationToPortfolio: number | null;
  }>;
  correlations: {
    assets: Array<{ key: string; symbol: string; name: string }>;
    values: Array<Array<number | null>>;
  };
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
    monthly: Array<{ month: string; turnoverPercent: number; tradeCount: number; cost: number }>;
  };
  tradeBehavior: {
    estimatedRealizedProfitLoss: number;
    estimatedWinRatePercent: number | null;
    estimatedProfitFactor: number | null;
    estimatedAverageHoldingDays: number | null;
    matchedSellCount: number;
    unmatchedSellCount: number;
  };
  dataQuality: {
    confidence: "high" | "medium" | "limited";
    historyDays: number;
    returnObservationDays: number;
    expectedReturnObservationDays: number;
    returnCoveragePercent: number;
    requiredPriceObservations: number;
    missingPriceObservations: number;
    priceCoveragePercent: number;
    requiredFxObservations: number;
    missingFxObservations: number;
    fxCoveragePercent: number;
    liveSnapshotDays: number;
    reconstructedSnapshotDays: number;
    backfillStatus: BackfillStatus["status"];
    failedSymbols: number;
    notes: string[];
  };
};
