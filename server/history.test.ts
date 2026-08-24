import { afterEach, describe, expect, it } from "vitest";
import { isHistoryDate, kstDateString, PortfolioHistoryStore } from "./history.js";
import { openTestHistoryStore } from "../test-support/history-store.js";
import { PGliteDatabase } from "../test-support/pglite-database.js";
import type { DatabaseRow, RelationalDatabase, RunResult } from "./database.js";
import { MarketDataRepository } from "./repositories/market-data-repository.js";
import type { HistoricalOrder, Holding, Portfolio } from "./toss.js";

class RecordingDatabase implements RelationalDatabase {
  constructor(
    private readonly delegate: RelationalDatabase,
    readonly statements: string[] = [],
    readonly queries: string[] = [],
  ) {}

  query<T extends DatabaseRow>(sql: string, parameters?: unknown[]): Promise<T[]> {
    this.queries.push(sql);
    return this.delegate.query<T>(sql, parameters);
  }

  run(sql: string, parameters?: unknown[]): Promise<RunResult> {
    this.statements.push(sql);
    return this.delegate.run(sql, parameters);
  }

  transaction<T>(work: (database: RelationalDatabase) => Promise<T>): Promise<T> {
    return this.delegate.transaction((database) => work(new RecordingDatabase(database, this.statements, this.queries)));
  }

  close(): Promise<void> {
    return this.delegate.close();
  }
}

class TransactionCountingDatabase implements RelationalDatabase {
  transactionCount = 0;

  constructor(private readonly delegate: RelationalDatabase) {}

  query<T extends DatabaseRow>(sql: string, parameters?: unknown[]): Promise<T[]> {
    return this.delegate.query<T>(sql, parameters);
  }

  run(sql: string, parameters?: unknown[]): Promise<RunResult> {
    return this.delegate.run(sql, parameters);
  }

  transaction<T>(work: (database: RelationalDatabase) => Promise<T>): Promise<T> {
    this.transactionCount += 1;
    return this.delegate.transaction((database) => work(new TransactionCountingDatabase(database)));
  }

  close(): Promise<void> {
    return this.delegate.close();
  }
}

class FailingMarketCandleDatabase implements RelationalDatabase {
  constructor(private readonly delegate: RelationalDatabase) {}

  query<T extends DatabaseRow>(sql: string, parameters?: unknown[]): Promise<T[]> {
    return this.delegate.query<T>(sql, parameters);
  }

  run(sql: string, parameters?: unknown[]): Promise<RunResult> {
    if (
      sql.includes("INSERT INTO portfolio_market_candles")
      && sql.includes("SELECT * FROM UNNEST")
    ) {
      throw new Error("simulated common-candle write failure");
    }
    return this.delegate.run(sql, parameters);
  }

  transaction<T>(work: (database: RelationalDatabase) => Promise<T>): Promise<T> {
    return this.delegate.transaction((database) => work(new FailingMarketCandleDatabase(database)));
  }

  close(): Promise<void> {
    return this.delegate.close();
  }
}

function legacyCommonCandleBackfillCount(statements: readonly string[]): number {
  return statements.filter((statement) => (
    statement.includes("INSERT INTO portfolio_market_candles")
    && statement.includes("SELECT")
  )).length;
}

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

  afterEach(async () => {
    await Promise.all(stores.splice(0).map((store) => store.close()));
  });

  it("KST 날짜 경계를 사용한다", () => {
    expect(kstDateString(new Date("2026-07-14T15:00:00.000Z"))).toBe("2026-07-15");
    expect(isHistoryDate("2024-02-29")).toBe(true);
    expect(isHistoryDate("2026-02-29")).toBe(false);
  });

  it("빈 batch 저장은 PostgreSQL transaction 왕복 없이 즉시 반환한다", async () => {
    const database = new TransactionCountingDatabase(new PGliteDatabase());
    const store = await PortfolioHistoryStore.open(database);
    stores.push(store);
    database.transactionCount = 0;

    await expect(store.upsertMarketCandles("stock", "EMPTY", "1d", false, []))
      .resolves.toBe(0);
    await expect(store.upsertOrders("account-1", [])).resolves.toBe(0);
    await expect(store.upsertInstruments([])).resolves.toBe(0);
    await expect(store.upsertDailyPrices("KRW:EMPTY", [])).resolves.toBe(0);
    await expect(store.upsertBacktestPrices("KRW:EMPTY", [])).resolves.toBe(0);
    await expect(store.upsertBenchmarkPrices("KOSPI", [])).resolves.toBe(0);

    expect(database.transactionCount).toBe(0);
  });

  it("두 번째 startup에서는 legacy common-candle backfill을 다시 실행하지 않는다", async () => {
    const database = new RecordingDatabase(new PGliteDatabase());
    const first = await PortfolioHistoryStore.open(database);
    stores.push(first);
    expect(legacyCommonCandleBackfillCount(database.statements)).toBe(3);

    database.statements.length = 0;
    await PortfolioHistoryStore.open(database);

    expect(legacyCommonCandleBackfillCount(database.statements)).toBe(0);
  });

  it("legacy 가격과 공통 candle 이중 쓰기를 한 트랜잭션으로 유지한다", async () => {
    const database = new FailingMarketCandleDatabase(new PGliteDatabase());
    const store = await PortfolioHistoryStore.open(database);
    stores.push(store);
    await store.upsertInstruments([{
      symbol: "AAA",
      name: "에이",
      market: "KRX",
      currency: "KRW",
    }]);
    const candle = [{
      symbol: "AAA",
      date: "2026-08-23",
      timestamp: "2026-08-23T00:00:00+09:00",
      currency: "KRW",
      openPrice: 100,
      highPrice: 110,
      lowPrice: 90,
      closePrice: 105,
    }];

    await expect(store.upsertDailyPrices("KRW:AAA", candle)).rejects.toThrow("common-candle");
    await expect(store.upsertBacktestPrices("KRW:AAA", candle)).rejects.toThrow("common-candle");
    await expect(store.upsertBenchmarkPrices("KOSPI", candle)).rejects.toThrow("common-candle");

    for (const table of [
      "portfolio_daily_prices",
      "portfolio_backtest_prices",
      "portfolio_benchmark_prices",
      "portfolio_market_candles",
    ]) {
      const [{ count }] = await database.query<{ count: number | string }>(
        `SELECT COUNT(*) AS count FROM ${table}`,
      );
      expect(Number(count), table).toBe(0);
    }
  });

  it("여러 종목의 일봉 coverage를 한 쿼리로 조회하고 불완전 OHLC를 조기 판별한다", async () => {
    const database = new RecordingDatabase(new PGliteDatabase());
    const store = await PortfolioHistoryStore.open(database);
    stores.push(store);
    const candle = (symbol: string, date: string) => ({
      symbol,
      date,
      timestamp: `${date}T00:00:00+09:00`,
      currency: "KRW",
      openPrice: 100,
      highPrice: 110,
      lowPrice: 90,
      closePrice: 105,
    });
    await store.upsertInstruments([
      { symbol: "AAA", name: "에이", market: "KRX", currency: "KRW" },
      { symbol: "BBB", name: "비", market: "KRX", currency: "KRW" },
    ]);
    await store.upsertDailyPrices("KRW:AAA", [candle("AAA", "2026-08-21"), candle("AAA", "2026-08-22")]);
    await store.upsertDailyPrices("KRW:BBB", [candle("BBB", "2026-08-20")]);
    await database.run(`
      UPDATE portfolio_daily_prices SET open_price = NULL
      WHERE instrument_key = 'KRW:BBB'
    `);

    database.queries.length = 0;
    await expect(store.getDailyPriceCoverage(["KRW:AAA", "KRW:BBB", "KRW:AAA"]))
      .resolves.toEqual(new Map([
        ["KRW:AAA", { earliest: "2026-08-21", latest: "2026-08-22", incompleteOhlc: false }],
        ["KRW:BBB", { earliest: "2026-08-20", latest: "2026-08-20", incompleteOhlc: true }],
      ]));
    expect(database.queries).toHaveLength(1);
    expect(database.queries[0]).toContain("instrument_key = ANY(?::text[])");
    expect(database.queries[0]).toContain("GROUP BY instrument_key");

    database.queries.length = 0;
    await expect(store.hasIncompleteDailyOhlc()).resolves.toBe(true);
    expect(database.queries).toHaveLength(1);
    expect(database.queries[0]).toContain("LIMIT 1");
  });

  it("같은 날 기록은 갱신하고 날짜별 종목 비중을 반환한다", async () => {
    const store = await openTestHistoryStore();
    stores.push(store);

    await store.recordPortfolio(
      portfolio([holding("AAA", 60), holding("BBB", 40)]),
      new Date("2026-07-14T02:00:00.000Z"),
    );
    await store.recordPortfolio(
      portfolio([holding("AAA", 30), holding("BBB", 70)]),
      new Date("2026-07-14T10:00:00.000Z"),
    );
    await store.recordPortfolio(
      portfolio([holding("AAA", 50), holding("CCC", 50), holding("US1", 200, "USD")]),
      new Date("2026-07-15T10:00:00.000Z"),
    );

    const history = await store.getHistory("account-1", "KRW", "all", new Date("2026-07-16T00:00:00.000Z"));
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

  it("원본 주문·일봉·복원 상태와 계산된 과거 스냅샷을 저장한다", async () => {
    const database = new RecordingDatabase(new PGliteDatabase());
    const store = await PortfolioHistoryStore.open(database);
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

    expect(await store.upsertOrders("account-1", [order])).toBe(1);
    expect(await store.getOrders("account-1")).toEqual([order]);
    await store.upsertInstruments([{ symbol: "AAA", name: "에이", market: "KRX", currency: "KRW" }]);
    await store.upsertDailyPrices("KRW:AAA", [{
      symbol: "AAA",
      date: "2026-07-01",
      timestamp: "2026-07-01T00:00:00+09:00",
      currency: "KRW",
      openPrice: 100,
      highPrice: 115,
      lowPrice: 95,
      closePrice: 110,
    }]);
    expect((await store.getDailyPrices(["KRW:AAA"], "2026-07-01", "2026-07-02")).get("KRW:AAA")?.get("2026-07-01"))
      .toBe(110);
    await store.upsertBacktestPrices("KRW:AAA", [{
      symbol: "AAA",
      date: "2026-07-01",
      timestamp: "2026-07-01T00:00:00+09:00",
      currency: "KRW",
      openPrice: 100,
      highPrice: 115,
      lowPrice: 95,
      closePrice: 108,
    }]);
    expect(await store.getBacktestPriceBounds("KRW:AAA")).toEqual({
      earliest: "2026-07-01",
      latest: "2026-07-01",
    });
    expect((await store.getBacktestPrices(["KRW:AAA"], "2026-07-01", "2026-07-02")).get("KRW:AAA"))
      .toEqual([{ date: "2026-07-01", close: 108 }]);
    database.statements.length = 0;
    await expect(store.upsertExchangeRates([], 1_000)).resolves.toBe(0);
    expect(database.statements).toHaveLength(0);
    await expect(store.upsertExchangeRates([
      { date: "2026-07-01", rate: 1_387.25, timestamp: "2026-07-01T15:30:00+09:00" },
      { date: "2026-07-02", rate: 1_382.5, timestamp: "2026-07-02T15:30:00+09:00" },
      { date: "2026-07-03", rate: 1_379.75, timestamp: "2026-07-03T15:30:00+09:00" },
    ], 1_000)).resolves.toBe(3);
    expect(database.statements.filter((statement) => (
      statement.includes("INSERT INTO portfolio_exchange_rates")
      && statement.includes("FROM UNNEST")
    ))).toHaveLength(1);
    expect(await store.getExchangeRates("2026-07-01", "2026-07-03")).toEqual(new Map([
      ["2026-07-01", 1_387.25],
      ["2026-07-02", 1_382.5],
      ["2026-07-03", 1_379.75],
    ]));
    database.statements.length = 0;
    await store.upsertExchangeRates([
      { date: "2026-07-03", rate: 1_380, timestamp: "2026-07-03T15:31:00+09:00" },
      { date: "2026-07-03", rate: 1_381, timestamp: "2026-07-03T15:32:00+09:00" },
    ], 2_222);
    expect(database.statements.filter((statement) => (
      statement.includes("INSERT INTO portfolio_exchange_rates")
    ))).toHaveLength(2);
    const [updatedRate] = await database.query<{
      rate: number;
      timestamp: string;
      updated_at: number | string;
    }>(`
      SELECT rate, timestamp, updated_at
      FROM portfolio_exchange_rates
      WHERE rate_date = '2026-07-03'
    `);
    expect(updatedRate).toMatchObject({
      rate: 1_381,
      timestamp: "2026-07-03T15:32:00+09:00",
    });
    expect(Number(updatedRate?.updated_at)).toBe(2_222);

    expect(await store.replaceHistoricalSnapshots("account-1", [{
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
    expect((await store.getHistory("account-1", "KRW", "all")).points[0]).toMatchObject({
      date: "2026-07-01",
      totalValue: 220,
      values: { "KRX:AAA": 100 },
    });
    expect(await store.getPortfolioAnalysisCandles(
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

    const status = await store.updateBackfillStatus("account-1", {
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
    expect(await store.getBackfillStatus("account-1")).toMatchObject({
      firstTradeDate: "2026-07-01",
      lastBackfilledDate: "2026-07-01",
    });
  });

  it("사용자가 지정한 시작일과 종료일을 포함해 조회하고 해당 기간의 과거 종목을 반환한다", async () => {
    const store = await openTestHistoryStore();
    stores.push(store);
    await store.replaceHistoricalSnapshots("account-1", [
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

    const selected = await store.getHistory(
      "account-1",
      "KRW",
      "all",
      new Date("2026-07-15T00:00:00.000Z"),
      { from: "2026-07-02", to: "2026-07-03" },
    );
    expect(selected.points.map((point) => point.date)).toEqual(["2026-07-02", "2026-07-03"]);
    expect(selected.series.map((item) => item.symbol)).toEqual(["KEEP", "SOLD"]);
    expect(selected).toMatchObject({ fromDate: "2026-07-02", toDate: "2026-07-03" });

    const afterSale = await store.getHistory(
      "account-1",
      "KRW",
      "all",
      new Date("2026-07-15T00:00:00.000Z"),
      { from: "2026-07-03", to: "2026-07-03" },
    );
    expect(afterSale.series.map((item) => item.symbol)).toEqual(["KEEP"]);
  });

  it("현재 해외 보유가 없어도 과거 USD 종목 기록을 반환한다", async () => {
    const store = await openTestHistoryStore();
    stores.push(store);
    await store.replaceHistoricalSnapshots("account-1", [
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

    const history = await store.getHistory("account-1", "USD", "all");
    expect(history.series).toEqual([expect.objectContaining({ symbol: "PAST-US", market: "NASDAQ" })]);
    expect(history.points.map((point) => point.totalValue)).toEqual([250, 0]);
  });

  it("candle 원본 응답과 정규화 OHLC를 공통 캐시에 저장한다", async () => {
    const store = await openTestHistoryStore();
    stores.push(store);
    const payload = {
      result: {
        candles: [{ timestamp: "2026-07-01T00:00:00+09:00", closePrice: "73500", volume: "12345678" }],
        nextBefore: "2026-06-30T00:00:00+09:00",
      },
    };
    await store.cacheCandleResponse({
      requestKey: "request-1",
      feature: "candles",
      requestPath: "/api/v1/candles?symbol=005930&interval=1d&before=2026-07-02T00%3A00%3A00%2B09%3A00",
      source: "stock",
      symbol: "005930",
      interval: "1d",
      adjusted: false,
      payload,
      candles: [{
        symbol: "005930",
        date: "2026-07-01",
        timestamp: "2026-07-01T00:00:00+09:00",
        currency: "KRW",
        openPrice: 72000,
        highPrice: 74000,
        lowPrice: 71500,
        closePrice: 73500,
        volume: 12_345_678,
      }],
      fetchedAt: 1000,
      expiresAt: 0,
    });

    expect(await store.getCachedCandleResponse("request-1", 10_000)).toEqual(payload);
    expect(await store.getMarketCandleCount()).toBe(1);
    await expect(new MarketDataRepository(store.relationalDatabase).getCandles({
      symbol: "005930",
      adjusted: false,
      fromDate: "2026-07-01",
      toDate: "2026-07-01",
    })).resolves.toEqual([expect.objectContaining({
      date: "2026-07-01",
      volume: 12_345_678,
    })]);

    await store.cacheCandleResponse({
      requestKey: "expired",
      feature: "indicator-candles",
      requestPath: "/api/v1/market-indicators/KOSPI/candles?interval=1d",
      source: "indicator",
      symbol: "KOSPI",
      interval: "1d",
      adjusted: false,
      payload,
      candles: [],
      fetchedAt: 1000,
      expiresAt: 2000,
    });
    expect(await store.getCachedCandleResponse("expired", 2000)).toBeUndefined();
  });
});
