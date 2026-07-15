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

export type CashLedgerEntry = {
  date: string;
  time: string;
  occurredAt: string;
  title: string;
  category: string;
  kind: "BUY" | "SELL" | "DEPOSIT" | "WITHDRAWAL" | "EXCHANGE_IN" | "EXCHANGE_OUT" | "DIVIDEND" | "FEE" | "OTHER";
  currency: HistoryCurrency;
  amount: number;
  balance: number;
  instrumentName?: string;
  quantity?: number;
};

export type CashLedgerSummary = {
  accountId: string;
  total: number;
  earliestDate?: string;
  latestDate?: string;
  entries: CashLedgerEntry[];
};

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
