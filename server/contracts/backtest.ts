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
    actualTotalCost: number;
    costDragPercent: number | null;
    grossReturnPercent: number | null;
    netEstimatedReturnPercent: number;
    netReturnPercent: number;
    costsDeductedFromPath: boolean;
    method: "actual_path_deduction";
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
