import { afterEach, describe, expect, it } from "vitest";
import { isHistoryDate, kstDateString, PortfolioHistoryStore } from "./history.js";
import type { HistoricalOrder, Holding, Portfolio } from "./toss.js";

function holding(symbol: string, evaluationAmount: number, currency = "KRW"): Holding {
  return {
    symbol,
    name: symbol,
    market: currency === "USD" ? "NASDAQ" : "KRX",
    currency,
    quantity: 1,
    availableQuantity: 1,
    averagePrice: evaluationAmount,
    currentPrice: evaluationAmount,
    purchaseAmount: evaluationAmount,
    evaluationAmount,
    profitLoss: 0,
    profitRate: 0,
    dailyProfitLoss: 0,
    dailyProfitRate: 0,
  };
}

function portfolio(holdings: Holding[]): Portfolio {
  const account = { id: "account-1", name: "계좌", label: "계좌", type: "종합매매" };
  return {
    asOf: new Date().toISOString(),
    accounts: [account],
    selectedAccountId: account.id,
    account,
    summary: {
      evaluationAmount: { KRW: 0, USD: 0 },
      purchaseAmount: { KRW: 0, USD: 0 },
      profitLoss: { KRW: 0, USD: 0 },
      dailyProfitLoss: { KRW: 0, USD: 0 },
      profitRate: 0,
      dailyProfitRate: 0,
      positionCount: holdings.length,
    },
    holdings,
  };
}

describe("PortfolioHistoryStore", () => {
  const stores: PortfolioHistoryStore[] = [];

  afterEach(() => {
    stores.splice(0).forEach((store) => store.close());
  });

  it("KST 날짜 경계를 사용한다", () => {
    expect(kstDateString(new Date("2026-07-14T15:00:00.000Z"))).toBe("2026-07-15");
    expect(isHistoryDate("2024-02-29")).toBe(true);
    expect(isHistoryDate("2026-02-29")).toBe(false);
  });

  it("WTS 추출 거래를 저장하고 같은 거래를 중복 저장하지 않는다", () => {
    const store = new PortfolioHistoryStore(":memory:");
    stores.push(store);
    const entries = [{
      date: "2026-07-14",
      time: "09:14",
      occurredAt: "2026-07-14T09:14:00+09:00",
      title: "샘플전자 12주",
      category: "구매",
      kind: "BUY" as const,
      currency: "KRW" as const,
      amount: -120_600,
      balance: 879_400,
      instrumentName: "샘플전자",
      quantity: 12,
    }];

    expect(store.importCashLedgerEntries("account-1", entries)).toMatchObject({ imported: 1, skipped: 0, total: 1 });
    expect(store.importCashLedgerEntries("account-1", entries)).toMatchObject({ imported: 0, skipped: 1, total: 1 });
    expect(store.getCashLedgerSummary("account-1")).toMatchObject({
      total: 1,
      earliestDate: "2026-07-14",
      latestDate: "2026-07-14",
      entries,
    });
  });

  it("같은 날 기록은 갱신하고 날짜별 종목 비중을 반환한다", () => {
    const store = new PortfolioHistoryStore(":memory:");
    stores.push(store);

    store.recordPortfolio(
      portfolio([holding("AAA", 60), holding("BBB", 40)]),
      new Date("2026-07-14T02:00:00.000Z"),
    );
    store.recordPortfolio(
      portfolio([holding("AAA", 30), holding("BBB", 70)]),
      new Date("2026-07-14T10:00:00.000Z"),
    );
    store.recordPortfolio(
      portfolio([holding("AAA", 50), holding("CCC", 50), holding("US1", 200, "USD")]),
      new Date("2026-07-15T10:00:00.000Z"),
    );

    const history = store.getHistory("account-1", "KRW", "all", new Date("2026-07-16T00:00:00.000Z"));
    expect(history.points).toHaveLength(2);
    expect(history.series.map((item) => item.symbol)).toEqual(["AAA", "BBB", "CCC"]);
    expect(history.points[0]).toMatchObject({
      date: "2026-07-14",
      totalValue: 100,
      values: { "KRX:AAA": 30, "KRX:BBB": 70, "KRX:CCC": 0 },
    });
    expect(history.points[1]).toMatchObject({
      date: "2026-07-15",
      totalValue: 100,
      values: { "KRX:AAA": 50, "KRX:BBB": 0, "KRX:CCC": 50 },
    });
  });

  it("원본 주문·일봉·복원 상태와 계산된 과거 스냅샷을 저장한다", () => {
    const store = new PortfolioHistoryStore(":memory:");
    stores.push(store);
    const order: HistoricalOrder = {
      orderId: "order-1",
      symbol: "AAA",
      side: "BUY",
      currency: "KRW",
      status: "CLOSED",
      orderedAt: "2026-07-01T09:00:00+09:00",
      filledAt: "2026-07-01T09:01:00+09:00",
      filledQuantity: 2,
      averageFilledPrice: 100,
      filledAmount: 200,
      commission: 1,
      tax: 0,
    };

    expect(store.upsertOrders("account-1", [order])).toBe(1);
    expect(store.getOrders("account-1")).toEqual([order]);
    store.upsertInstruments([{ symbol: "AAA", name: "에이", market: "KRX", currency: "KRW" }]);
    store.upsertDailyPrices("KRW:AAA", [{
      symbol: "AAA",
      date: "2026-07-01",
      timestamp: "2026-07-01T00:00:00+09:00",
      currency: "KRW",
      openPrice: 100,
      highPrice: 115,
      lowPrice: 95,
      closePrice: 110,
    }]);
    expect(store.getDailyPrices(["KRW:AAA"], "2026-07-01", "2026-07-02").get("KRW:AAA")?.get("2026-07-01"))
      .toBe(110);
    store.upsertExchangeRate("2026-07-01", 1387.25, "2026-07-01T15:30:00+09:00");
    expect(store.getExchangeRates("2026-07-01", "2026-07-02").get("2026-07-01")).toBe(1387.25);

    expect(store.replaceHistoricalSnapshots("account-1", [{
      date: "2026-07-01",
      capturedAt: Date.parse("2026-07-01T14:59:59.999Z"),
      items: [{
        symbol: "AAA",
        name: "에이",
        market: "KRX",
        currency: "KRW",
        evaluationAmount: 220,
      }],
    }], "2026-07-02")).toBe(1);
    expect(store.getHistory("account-1", "KRW", "all").points[0]).toMatchObject({
      date: "2026-07-01",
      totalValue: 220,
      values: { "KRX:AAA": 100 },
    });
    expect(store.getPortfolioAnalysisCandles(
      "account-1",
      "KRW",
      "2026-07-01",
      "2026-07-01",
    )).toEqual([{
      date: "2026-07-01",
      open: 200,
      high: 230,
      low: 190,
      close: 220,
    }]);

    const status = store.updateBackfillStatus("account-1", {
      status: "complete",
      phase: "complete",
      firstTradeDate: "2026-07-01",
      lastBackfilledDate: "2026-07-01",
      ordersImported: 1,
      symbolsTotal: 1,
      symbolsProcessed: 1,
      pricesImported: 1,
      snapshotsCreated: 1,
      reconciledSymbols: 1,
    });
    expect(status).toMatchObject({ status: "complete", ordersImported: 1, snapshotsCreated: 1 });
    expect(store.getBackfillStatus("account-1")).toMatchObject({
      firstTradeDate: "2026-07-01",
      lastBackfilledDate: "2026-07-01",
    });
  });

  it("사용자가 지정한 시작일과 종료일을 포함해 조회하고 해당 기간의 과거 종목을 반환한다", () => {
    const store = new PortfolioHistoryStore(":memory:");
    stores.push(store);
    store.replaceHistoricalSnapshots("account-1", [
      {
        date: "2026-07-01",
        capturedAt: Date.parse("2026-07-01T14:59:59.999Z"),
        items: [{ symbol: "SOLD", name: "매도 종목", market: "KRX", currency: "KRW", evaluationAmount: 100 }],
      },
      {
        date: "2026-07-02",
        capturedAt: Date.parse("2026-07-02T14:59:59.999Z"),
        items: [
          { symbol: "SOLD", name: "매도 종목", market: "KRX", currency: "KRW", evaluationAmount: 40 },
          { symbol: "KEEP", name: "보유 종목", market: "KRX", currency: "KRW", evaluationAmount: 60 },
        ],
      },
      {
        date: "2026-07-03",
        capturedAt: Date.parse("2026-07-03T14:59:59.999Z"),
        items: [{ symbol: "KEEP", name: "보유 종목", market: "KRX", currency: "KRW", evaluationAmount: 120 }],
      },
    ], "2026-07-04");

    const selected = store.getHistory(
      "account-1",
      "KRW",
      "all",
      new Date("2026-07-15T00:00:00.000Z"),
      { from: "2026-07-02", to: "2026-07-03" },
    );
    expect(selected.points.map((point) => point.date)).toEqual(["2026-07-02", "2026-07-03"]);
    expect(selected.series.map((item) => item.symbol)).toEqual(["KEEP", "SOLD"]);
    expect(selected).toMatchObject({ fromDate: "2026-07-02", toDate: "2026-07-03" });

    const afterSale = store.getHistory(
      "account-1",
      "KRW",
      "all",
      new Date("2026-07-15T00:00:00.000Z"),
      { from: "2026-07-03", to: "2026-07-03" },
    );
    expect(afterSale.series.map((item) => item.symbol)).toEqual(["KEEP"]);
  });

  it("현재 해외 보유가 없어도 과거 USD 종목 기록을 반환한다", () => {
    const store = new PortfolioHistoryStore(":memory:");
    stores.push(store);
    store.replaceHistoricalSnapshots("account-1", [
      {
        date: "2026-01-02",
        capturedAt: Date.parse("2026-01-02T14:59:59.999Z"),
        items: [{
          symbol: "PAST-US",
          name: "과거 해외 종목",
          market: "NASDAQ",
          currency: "USD",
          evaluationAmount: 250,
        }],
      },
      {
        date: "2026-01-03",
        capturedAt: Date.parse("2026-01-03T14:59:59.999Z"),
        items: [],
      },
    ], "2026-01-04");

    const history = store.getHistory("account-1", "USD", "all");
    expect(history.series).toEqual([expect.objectContaining({ symbol: "PAST-US", market: "NASDAQ" })]);
    expect(history.points.map((point) => point.totalValue)).toEqual([250, 0]);
  });
});
