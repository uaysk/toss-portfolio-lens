import { describe, expect, it } from "vitest";
import { reconstructDailyPortfolio, tradeDate } from "./backfill.js";
import type { HistoricalOrder, Holding, InstrumentInfo } from "./toss.js";

function order(
  orderId: string,
  symbol: string,
  side: "BUY" | "SELL",
  quantity: number,
  price: number,
  filledAt: string,
): HistoricalOrder {
  return {
    orderId,
    symbol,
    side,
    currency: "KRW",
    status: "CLOSED",
    orderedAt: filledAt,
    filledAt,
    filledQuantity: quantity,
    averageFilledPrice: price,
    filledAmount: quantity * price,
    commission: 0,
    tax: 0,
  };
}

function holding(symbol: string, quantity: number): Holding {
  return {
    symbol,
    name: symbol,
    market: "KRX",
    currency: "KRW",
    quantity,
    availableQuantity: quantity,
    averagePrice: 0,
    currentPrice: 0,
    purchaseAmount: 0,
    evaluationAmount: 0,
    profitLoss: 0,
    profitRate: 0,
    dailyProfitLoss: 0,
    dailyProfitRate: 0,
  };
}

function instrument(symbol: string): InstrumentInfo {
  return { symbol, name: symbol, market: "KRX", currency: "KRW" };
}

describe("reconstructDailyPortfolio", () => {
  it("매수·매도를 날짜별로 반영하고 휴일에는 최근 종가를 이어 쓴다", () => {
    const orders = [
      order("1", "AAA", "BUY", 10, 100, "2026-07-03T10:00:00+09:00"),
      order("2", "AAA", "SELL", 5, 110, "2026-07-04T10:00:00+09:00"),
      order("3", "BBB", "BUY", 2, 50, "2026-07-04T10:01:00+09:00"),
    ];
    const result = reconstructDailyPortfolio({
      orders,
      currentHoldings: [holding("AAA", 5), holding("BBB", 2)],
      instruments: new Map([
        ["KRW:AAA", instrument("AAA")],
        ["KRW:BBB", instrument("BBB")],
      ]),
      prices: new Map([
        ["KRW:AAA", new Map([["2026-07-03", 100], ["2026-07-04", 110]])],
        ["KRW:BBB", new Map([["2026-07-04", 50]])],
      ]),
      fromDate: "2026-07-03",
      toDate: "2026-07-05",
    });

    expect(result).toMatchObject({ reconciledSymbols: 2, discrepancySymbols: 0 });
    expect(result.snapshots).toHaveLength(3);
    expect(result.snapshots[0].items).toMatchObject([{ symbol: "AAA", evaluationAmount: 1000 }]);
    expect(result.snapshots[1].items).toEqual(expect.arrayContaining([
      expect.objectContaining({ symbol: "AAA", evaluationAmount: 550 }),
      expect.objectContaining({ symbol: "BBB", evaluationAmount: 100 }),
    ]));
    expect(result.snapshots[2].items).toEqual(result.snapshots[1].items);
  });

  it("현재 보유량과 체결 합계의 차이를 시작 수량으로 보정한다", () => {
    const result = reconstructDailyPortfolio({
      orders: [order("1", "AAA", "BUY", 10, 100, "2026-07-03T10:00:00+09:00")],
      currentHoldings: [holding("AAA", 12)],
      instruments: new Map([["KRW:AAA", instrument("AAA")]]),
      prices: new Map([["KRW:AAA", new Map([["2026-07-03", 100]])]]),
      fromDate: "2026-07-03",
      toDate: "2026-07-03",
    });

    expect(result.discrepancySymbols).toBe(1);
    expect(result.snapshots[0].items[0].evaluationAmount).toBe(1200);
  });

  it("시간대가 있는 체결 시각을 KST 날짜로 변환한다", () => {
    expect(tradeDate(order("1", "AAA", "BUY", 1, 1, "2026-07-02T16:00:00Z"))).toBe("2026-07-03");
  });
});
