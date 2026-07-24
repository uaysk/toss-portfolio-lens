export type BacktestRebalanceFrequency = "none" | "monthly" | "quarterly" | "annually" | "threshold";
export type BacktestCashFlowFrequency = "monthly" | "quarterly" | "annually";
export type BacktestCashFlowTiming = "period_start" | "period_end";
export type BacktestQuantityMode = "fractional" | "whole";
export type BacktestCashFlowRebalanceMode = "target_weights" | "drift_reduction" | "full";
export type BacktestBenchmarkKey = "NONE" | "KOSPI" | "KOSDAQ" | "NASDAQ100" | "SP500" | "CUSTOM";

export type BacktestCustomCashFlow = {
  date: string;
  amount: number;
  memo?: string;
};

export type BacktestRealismPolicy = {
  costs: {
    commissionBps?: number;
    sellTaxBps: number;
    fixedSlippageBps: number;
    marketImpactCoefficient: number;
    marketImpactExponent: number;
    maxParticipationRatePercent?: number;
    minimumFee: number;
    dividendTaxBps: number;
  };
  dividendMode: "adjusted_price_only" | "cash";
  enforcePointInTimeUniverse: boolean;
};

export type BacktestTargetWeightScheduleEntry = {
  date: string;
  weights: Record<string, number>;
  cashTargetPercent: number;
  regime?: string;
  action?: string;
};

export type BacktestExecutionPolicy = {
  cashTargetPercent: number;
  quantityMode: BacktestQuantityMode;
  cashFlowRebalanceMode: BacktestCashFlowRebalanceMode;
  tradeDatePolicy: "next_common_observation";
  cashAnnualYieldPercent: number;
};

export type BacktestRunConfiguration = {
  assets: Array<{
    symbol: string;
    weight: number;
    lotSize?: number;
    delistDate?: string;
    universeMemberFrom?: string;
    universeMemberTo?: string;
  }>;
  startDate: string;
  endDate: string;
  initialAmount: number;
  monthlyCashFlow: number;
  cashFlowFrequency: BacktestCashFlowFrequency;
  cashFlowTiming: BacktestCashFlowTiming;
  rebalanceFrequency: BacktestRebalanceFrequency;
  rebalanceThresholdPercent?: number;
  riskFreeRatePercent: number;
  transactionCostBps: number;
  currencyMode: "local" | "KRW";
  baseCurrency: "KRW";
  cashFlows: BacktestCustomCashFlow[];
  targetWeightSchedule?: BacktestTargetWeightScheduleEntry[];
  execution: BacktestExecutionPolicy;
  realism?: BacktestRealismPolicy;
  benchmark: BacktestBenchmarkKey;
  benchmarkSymbol?: string;
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

export type BacktestInstrument = {
  symbol: string;
  name: string;
  market: string;
  currency: "KRW" | "USD";
  listDate: string;
  securityType: string;
  status: string;
};

export type BacktestAsset = BacktestInstrument & {
  weight: number;
  lotSize?: number;
  delistDate?: string;
  universeMemberFrom?: string;
  universeMemberTo?: string;
  currentValueKrw?: number;
};

export type CurrentBacktestPortfolio = {
  accountId: string;
  assets: Array<BacktestAsset & { currentValueKrw: number }>;
  defaultStartDate: string;
  defaultEndDate: string;
  initialAmount: number;
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

export type BacktestResult = {
  runId?: string;
  reused?: boolean;
  generatedAt: string;
  baseCurrency: "KRW";
  currencyMethod: "KRW_FX_CONVERTED" | "LOCAL_RETURN";
  requestedStartDate: string;
  effectiveStartDate: string;
  endDate: string;
  config: BacktestRunConfiguration & {
    requestedStartDate: string;
    latestMetadataListDate: string;
    effectiveStartDate: string;
    effectiveEndDate: string;
  };
  assets: BacktestAsset[];
  benchmark?: { key: BacktestBenchmarkKey; name: string; symbol: string };
  warnings: string[];
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
    timeLinkedContributionPercent?: number;
    localPriceContributionPercent?: number;
    fxContributionPercent?: number;
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
    netCashImpact?: number;
    trigger?: string;
    lotSize?: number;
  }>;
  cashFlows?: Array<{
    scheduledDate: string;
    effectiveDate: string;
    amount: number;
    source: string;
    memo?: string;
  }>;
  execution?: BacktestExecutionPolicy;
  dataQuality: {
    alignmentPolicy: "carry_forward_for_valuation";
    commonReturnPolicy: "inner_join";
    alignedValuationDays: number;
    commonReturnObservations: number;
    carryForwardByAsset: Array<{ symbol: string; count: number }>;
    benchmarkCarryForwardCount: number;
  };
  advanced?: BacktestAdvancedAnalytics;
};
