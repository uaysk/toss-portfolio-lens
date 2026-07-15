import { describe, expect, it } from "vitest";
import { ALLOCATION_STOCK_LIMIT, buildAllocation } from "./allocation";
import type { Holding } from "@/types";

function holding(index: number, currency: "KRW" | "USD" = "KRW"): Holding {
  return {
    symbol: `STOCK${index}`,
    name: `종목 ${index}`,
    market: currency === "USD" ? "NASDAQ" : "KRX",
    currency,
    quantity: 1,
    availableQuantity: 1,
    averagePrice: index,
    currentPrice: index,
    purchaseAmount: index,
    evaluationAmount: index,
    profitLoss: 0,
    profitRate: 0,
    dailyProfitLoss: 0,
    dailyProfitRate: 0,
  };
}

describe("buildAllocation", () => {
  it("선택 통화의 상위 10종목과 나머지 합계를 표시한다", () => {
    const allocation = buildAllocation([
      ...Array.from({ length: 12 }, (_, index) => holding(index + 1)),
      holding(100, "USD"),
    ], "KRW");

    expect(ALLOCATION_STOCK_LIMIT).toBe(10);
    expect(allocation).toHaveLength(11);
    expect(allocation.slice(0, 10).map((item) => item.symbol)).toEqual([
      "STOCK12", "STOCK11", "STOCK10", "STOCK9", "STOCK8",
      "STOCK7", "STOCK6", "STOCK5", "STOCK4", "STOCK3",
    ]);
    expect(allocation[10]).toMatchObject({ key: "OTHER", value: 3 });
  });
});
