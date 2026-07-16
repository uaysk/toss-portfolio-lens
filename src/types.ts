export type Account = {
  id: string;
  name: string;
  label: string;
  type: string;
};

export type Holding = {
  symbol: string;
  name: string;
  market: string;
  currency: string;
  quantity: number;
  availableQuantity: number;
  averagePrice: number;
  currentPrice: number;
  purchaseAmount: number;
  evaluationAmount: number;
  profitLoss: number;
  profitRate: number;
  dailyProfitLoss: number;
  dailyProfitRate: number;
};

export type CurrencyAmounts = {
  KRW: number;
  USD: number;
};

export type Portfolio = {
  asOf: string;
  accounts: Account[];
  selectedAccountId: string;
  account: Account;
  summary: {
    evaluationAmount: CurrencyAmounts;
    purchaseAmount: CurrencyAmounts;
    profitLoss: CurrencyAmounts;
    dailyProfitLoss: CurrencyAmounts;
    profitRate: number;
    dailyProfitRate: number;
    positionCount: number;
  };
  holdings: Holding[];
};

export type ApiError = {
  error?: {
    code?: string;
    message?: string;
    requestId?: string;
  };
};

export type Theme = "dark" | "light";
export type HistoryCurrency = "KRW" | "USD";
export type HistoryRange = "7d" | "30d" | "90d" | "all";
export type AnalysisRange = "30d" | "90d" | "1y" | "all";
export type BenchmarkKey = "KOSPI" | "KOSDAQ" | "NASDAQ100" | "SP500";

export type PortfolioHistorySeries = {
  key: string;
  symbol: string;
  name: string;
  market: string;
  currency: HistoryCurrency;
  averageWeight: number;
};

export type PortfolioHistory = {
  accountId: string;
  currency: HistoryCurrency;
  includesCurrencies?: HistoryCurrency[];
  range: HistoryRange;
  generatedAt: string;
  firstSnapshotDate?: string;
  fromDate?: string;
  toDate?: string;
  series: PortfolioHistorySeries[];
  points: Array<{
    date: string;
    capturedAt: string;
    totalValue: number;
    values: Record<string, number>;
  }>;
};

export type BackfillStatus = {
  accountId: string;
  status: "idle" | "running" | "complete" | "partial" | "error";
  phase: "waiting" | "orders" | "instruments" | "prices" | "reconstructing" | "complete";
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
  firstTradeDate?: string;
  lastBackfilledDate?: string;
  ordersImported: number;
  symbolsTotal: number;
  symbolsProcessed: number;
  pricesImported: number;
  snapshotsCreated: number;
  reconciledSymbols: number;
  discrepancySymbols: number;
  failedSymbols: number;
  message?: string;
};

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
    riskFreeRatePercent: 0;
  };
  contributions: Array<{
    key: string;
    symbol: string;
    name: string;
    market: string;
    currency: HistoryCurrency;
    estimatedProfitLoss: number;
    contributionPercent: number;
  }>;
};

export type BacktestRebalanceFrequency = "none" | "monthly" | "quarterly" | "annually";
export type BacktestBenchmarkKey = "NONE" | "KOSPI" | "KOSDAQ" | "NASDAQ100" | "SP500" | "CUSTOM";

export type BacktestComparableMetrics = {
  totalReturnPercent: number;
  cagrPercent: number | null;
  annualizedVolatilityPercent: number | null;
  maxDrawdownPercent: number;
  maxDrawdownDays: number;
  sharpeRatio: number | null;
  sortinoRatio: number | null;
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
  currentValueKrw?: number;
};

export type CurrentBacktestPortfolio = {
  accountId: string;
  assets: Array<BacktestAsset & { currentValueKrw: number }>;
  defaultStartDate: string;
  defaultEndDate: string;
  initialAmount: number;
};

export type BacktestResult = {
  generatedAt: string;
  baseCurrency: "KRW";
  currencyMethod: "LOCAL_RETURN";
  requestedStartDate: string;
  effectiveStartDate: string;
  endDate: string;
  config: {
    assets: Array<{ symbol: string; weight: number }>;
    startDate: string;
    endDate: string;
    initialAmount: number;
    monthlyCashFlow: number;
    rebalanceFrequency: BacktestRebalanceFrequency;
    benchmark: BacktestBenchmarkKey;
    benchmarkSymbol?: string;
    requestedStartDate: string;
    latestListDate: string;
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
    assetReturnPercent: number;
  }>;
  correlations: {
    assets: Array<{ symbol: string; name: string }>;
    values: Array<Array<number | null>>;
  };
};

export type ReportStance = "strong" | "balanced" | "cautious" | "high-risk";

export type ReportNarrative = {
  score: number;
  stance: ReportStance;
  summary: string;
  strengths: [string, string, string];
  risks: [string, string, string];
  actions: [string, string, string];
  methodology: string;
};

type ReportBase = {
  schemaVersion: 1;
  templateVersion: "portfolio-report-v1";
  id: string;
  createdAt: string;
  title: string;
  period: { from: string; to: string };
  narrative: ReportNarrative;
};

export type AnalysisReport = ReportBase & {
  kind: "analysis";
  data: Omit<PortfolioAnalysis, "accountId">;
};

export type BacktestReport = ReportBase & {
  kind: "backtest";
  data: BacktestResult;
};

export type StoredReport = AnalysisReport | BacktestReport;

export type ReportCreateResponse = {
  id: string;
  url: string;
  createdAt: string;
  storage: "local" | "s3";
};
