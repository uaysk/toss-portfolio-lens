import { afterEach, describe, expect, it, vi } from "vitest";
import { PortfolioBacktestService } from "./backtest.js";
import { PortfolioHistoryStore } from "./history.js";
import type { DailyCandle, InstrumentInfo, Portfolio, TossClient } from "./toss.js";

const instruments: InstrumentInfo[] = [
  { symbol: "005930", name: "국내 종목", market: "KRX", currency: "KRW", listDate: "1975-06-11", securityType: "STOCK", status: "ACTIVE" },
  { symbol: "AAPL", name: "미국 종목", market: "NASDAQ", currency: "USD", listDate: "1980-12-12", securityType: "STOCK", status: "ACTIVE" },
];

function candle(symbol: string, currency: "KRW" | "USD", date: string, closePrice: number): DailyCandle {
  return {
    symbol,
    date,
    timestamp: `${date}T00:00:00+09:00`,
    currency,
    openPrice: closePrice,
    highPrice: closePrice,
    lowPrice: closePrice,
    closePrice,
  };
}

function currentPortfolio(): Portfolio {
  const account = { id: "account-1", name: "계좌", label: "계좌", type: "STOCK" };
  return {
    asOf: "2026-07-15T00:00:00+09:00",
    accounts: [account],
    selectedAccountId: account.id,
    account,
    summary: {
      evaluationAmount: { KRW: 600, USD: 1 },
      purchaseAmount: { KRW: 600, USD: 1 },
      profitLoss: { KRW: 0, USD: 0 },
      dailyProfitLoss: { KRW: 0, USD: 0 },
      profitRate: 0,
      dailyProfitRate: 0,
      positionCount: 2,
    },
    holdings: instruments.map((instrument, index) => ({
      symbol: instrument.symbol,
      name: instrument.name,
      market: instrument.market,
      currency: instrument.currency as "KRW" | "USD",
      quantity: 1,
      availableQuantity: 1,
      averagePrice: index === 0 ? 600 : 1,
      currentPrice: index === 0 ? 600 : 1,
      purchaseAmount: index === 0 ? 600 : 1,
      evaluationAmount: index === 0 ? 600 : 1,
      profitLoss: 0,
      profitRate: 0,
      dailyProfitLoss: 0,
      dailyProfitRate: 0,
    })),
  };
}

describe("PortfolioBacktestService", () => {
  const stores: PortfolioHistoryStore[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(stores.splice(0).map((store) => store.close()));
  });

  it("현재 국내·해외 보유 종목을 원화 비중으로 불러오고 가장 늦은 상장일을 기본값으로 정한다", async () => {
    const toss = {
      getPortfolio: vi.fn().mockResolvedValue(currentPortfolio()),
      getInstruments: vi.fn().mockResolvedValue(instruments),
      getUsdKrwExchangeRate: vi.fn().mockResolvedValue({ date: "2026-07-15", rate: 1_400, timestamp: "2026-07-15T00:00:00+09:00" }),
    } as unknown as TossClient;
    const store = await PortfolioHistoryStore.openSqlite(":memory:");
    stores.push(store);

    const result = await new PortfolioBacktestService(toss, store).currentPortfolio("account-1");

    expect(result.assets.map((asset) => ({ symbol: asset.symbol, weight: asset.weight }))).toEqual([
      { symbol: "005930", weight: 30 },
      { symbol: "AAPL", weight: 70 },
    ]);
    expect(result.defaultStartDate).toBe("1980-12-12");
    expect(result.initialAmount).toBe(2_000);
  });

  it("요청 시작일이 이르면 가장 늦은 상장일로 보정하고 수정주가 일봉으로 실행한다", async () => {
    const customInstruments: InstrumentInfo[] = [
      { ...instruments[0], listDate: "2020-01-01" },
      { ...instruments[1], listDate: "2020-01-02" },
    ];
    const toss = {
      getInstruments: vi.fn().mockResolvedValue(customInstruments),
      getDailyCandles: vi.fn().mockImplementation(async (symbol: string, _before?: string, adjusted?: boolean) => ({
        candles: symbol === "005930"
          ? [candle(symbol, "KRW", "2020-01-02", 100), candle(symbol, "KRW", "2020-01-03", 110)]
          : [candle(symbol, "USD", "2020-01-02", 100), candle(symbol, "USD", "2020-01-03", 100)],
        nextBefore: undefined,
        adjusted,
      })),
    } as unknown as TossClient;
    const store = await PortfolioHistoryStore.openSqlite(":memory:");
    stores.push(store);

    const result = await new PortfolioBacktestService(toss, store).run({
      assets: [{ symbol: "005930", weight: 50 }, { symbol: "AAPL", weight: 50 }],
      startDate: "2019-01-01",
      endDate: "2020-01-03",
      initialAmount: 1_000_000,
      monthlyCashFlow: 0,
      rebalanceFrequency: "none",
      riskFreeRatePercent: 2.5,
      transactionCostBps: 15,
      benchmark: "NONE",
    });

    expect(result.config.latestListDate).toBe("2020-01-02");
    expect(result.effectiveStartDate).toBe("2020-01-02");
    expect(result.metrics.totalReturnPercent).toBe(5);
    expect(result.config).toMatchObject({ riskFreeRatePercent: 2.5, transactionCostBps: 15 });
    expect(result.advanced.costEfficiency).toMatchObject({ transactionCostBps: 15, tradeCount: 2 });
    expect(result.advanced.costEfficiency.estimatedTotalCost).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain("2020-01-02");
    expect(vi.mocked(toss.getDailyCandles)).toHaveBeenCalledWith("005930", undefined, true);
  });

  it("국내·해외 개별 종목을 벤치마크로 선택하고 비교 지표를 반환한다", async () => {
    const toss = {
      getInstruments: vi.fn().mockImplementation(async (symbols: string[]) => (
        instruments.filter((instrument) => symbols.includes(instrument.symbol))
      )),
      getDailyCandles: vi.fn().mockImplementation(async (symbol: string, _before?: string, adjusted?: boolean) => ({
        candles: symbol === "005930"
          ? [candle(symbol, "KRW", "2026-01-02", 100), candle(symbol, "KRW", "2026-01-03", 110)]
          : [candle(symbol, "USD", "2026-01-02", 100), candle(symbol, "USD", "2026-01-03", 90)],
        nextBefore: undefined,
        adjusted,
      })),
    } as unknown as TossClient;
    const store = await PortfolioHistoryStore.openSqlite(":memory:");
    stores.push(store);

    const result = await new PortfolioBacktestService(toss, store).run({
      assets: [{ symbol: "005930", weight: 100 }],
      startDate: "2026-01-02",
      endDate: "2026-01-03",
      initialAmount: 1_000_000,
      monthlyCashFlow: 0,
      rebalanceFrequency: "none",
      benchmark: "CUSTOM",
      benchmarkSymbol: "aapl",
    });

    expect(result.benchmark).toEqual({ key: "CUSTOM", name: "미국 종목", symbol: "AAPL" });
    expect(result.benchmarkMetrics?.totalReturnPercent).toBe(-10);
    expect(result.config.benchmarkSymbol).toBe("AAPL");
    expect(vi.mocked(toss.getDailyCandles)).toHaveBeenCalledWith("AAPL", undefined, true);
  });
});
