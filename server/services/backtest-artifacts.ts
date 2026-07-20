import type { ArtifactType } from "../repositories/artifact-repository.js";

export type BacktestArtifactResult = {
  points: Array<{
    date: string;
    drawdownPercent: number;
    balance: number;
    investedBalance?: number;
    cashBalance?: number;
    unitPrice?: number;
  }>;
  contributions: Array<{
    symbol: string;
    name: string;
    currency: string;
    endingValue: number;
  }>;
  endDate: string;
  metrics: { finalBalance: number } & Record<string, unknown>;
  trades: unknown[];
  cashFlows?: unknown[];
  dividends?: unknown[];
  targetWeightSchedule?: unknown[];
  dataQuality: unknown;
  correlations: { assets: unknown[] } & Record<string, unknown>;
  advanced: {
    rolling: unknown[];
    riskContributions: unknown[];
    monthlyReturns: unknown[];
  } & Record<string, unknown>;
};

export function backtestArtifacts(result: BacktestArtifactResult): Array<{ type: ArtifactType; content: unknown; rowCount?: number }> {
  return [
    { type: "equity", content: result.points, rowCount: result.points.length },
    {
      type: "drawdown",
      content: result.points.map((point) => ({ date: point.date, drawdownPercent: point.drawdownPercent })),
      rowCount: result.points.length,
    },
    {
      type: "holdings",
      content: result.contributions.map((item) => ({
        date: result.endDate,
        symbol: item.symbol,
        name: item.name,
        currency: item.currency,
        ending_value: item.endingValue,
        ending_weight: result.metrics.finalBalance > 0 ? item.endingValue / result.metrics.finalBalance : 0,
      })),
      rowCount: result.contributions.length,
    },
    { type: "trades", content: result.trades, rowCount: result.trades.length },
    {
      type: "cash-ledger",
      content: result.points.map((point) => ({
        date: point.date,
        balance: point.balance,
        investedBalance: point.investedBalance,
        cashBalance: point.cashBalance,
        unitPrice: point.unitPrice,
      })),
      rowCount: result.points.length,
    },
    { type: "cash-flows", content: result.cashFlows ?? [], rowCount: result.cashFlows?.length ?? 0 },
    { type: "dividends", content: result.dividends ?? [], rowCount: result.dividends?.length ?? 0 },
    { type: "target-weight-schedule", content: result.targetWeightSchedule ?? [], rowCount: result.targetWeightSchedule?.length ?? 0 },
    { type: "data-quality", content: result.dataQuality, rowCount: 1 },
    { type: "rolling", content: result.advanced.rolling, rowCount: result.advanced.rolling.length },
    { type: "correlation", content: result.correlations, rowCount: result.correlations.assets.length },
    { type: "risk-contribution", content: result.advanced.riskContributions, rowCount: result.advanced.riskContributions.length },
    { type: "monthly-returns", content: result.advanced.monthlyReturns, rowCount: result.advanced.monthlyReturns.length },
  ];
}
