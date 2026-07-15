import { holdingKey } from "@/lib/stock-appearance";
import type { Holding, PortfolioHistorySeries } from "@/types";

export const HIDDEN_STOCKS_STORAGE_KEY = "portfolio-hidden-stocks";

export type VisibilityStock = {
  key: string;
  symbol: string;
  name: string;
  market: string;
  isCurrent: boolean;
  averageWeight?: number;
};

export function buildVisibilityStocks(
  holdings: Holding[],
  historySeries: PortfolioHistorySeries[],
): VisibilityStock[] {
  const stocks: VisibilityStock[] = holdings.map((holding) => ({
    key: holdingKey(holding),
    symbol: holding.symbol,
    name: holding.name,
    market: holding.market,
    isCurrent: true,
  }));
  const seen = new Set(stocks.map((stock) => stock.key));

  for (const item of historySeries) {
    if (seen.has(item.key)) continue;
    stocks.push({
      key: item.key,
      symbol: item.symbol,
      name: item.name,
      market: item.market,
      isCurrent: false,
      averageWeight: item.averageWeight,
    });
    seen.add(item.key);
  }
  return stocks;
}

export function parseHiddenStockKeys(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return [];
    return Array.from(new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter((item) => item.length > 0 && item.length <= 100),
    )).slice(0, 500);
  } catch {
    return [];
  }
}

export function serializeHiddenStockKeys(keys: Iterable<string>): string {
  return JSON.stringify(Array.from(new Set(keys)).sort());
}
