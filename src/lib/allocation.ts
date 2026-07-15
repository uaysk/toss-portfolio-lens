import { holdingKey } from "@/lib/stock-appearance";
import type { Holding, HistoryCurrency } from "@/types";

export const ALLOCATION_STOCK_LIMIT = 10;

export type AllocationItem = {
  key: string;
  name: string;
  symbol: string;
  value: number;
};

export function buildAllocation(
  holdings: Holding[],
  currency: HistoryCurrency,
  limit = ALLOCATION_STOCK_LIMIT,
): AllocationItem[] {
  const sorted = holdings
    .filter((holding) => holding.currency === currency && holding.evaluationAmount > 0)
    .slice()
    .sort((a, b) => b.evaluationAmount - a.evaluationAmount);
  const top = sorted.slice(0, limit).map((holding) => ({
    key: holdingKey(holding),
    name: holding.name,
    symbol: holding.symbol,
    value: holding.evaluationAmount,
  }));
  const rest = sorted.slice(limit).reduce((sum, holding) => sum + holding.evaluationAmount, 0);
  if (rest > 0) top.push({ key: "OTHER", name: "기타", symbol: "OTHER", value: rest });
  return top;
}
