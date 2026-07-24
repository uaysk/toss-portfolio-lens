export type HistoryCurrency = "KRW" | "USD";
export type HistoryRange = "7d" | "30d" | "90d" | "all";

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
    origin?: "LIVE" | "HISTORICAL";
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
