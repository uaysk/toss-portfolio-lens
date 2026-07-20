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

  it("현재 국내·해외 보유 종목을 원화 비중으로 불러오고 listDate와 무관한 5년 요청 기간을 기본값으로 정한다", async () => {
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
    const expectedStart = new Date(`${result.defaultEndDate}T00:00:00Z`);
    expectedStart.setUTCFullYear(expectedStart.getUTCFullYear() - 5);
    expect(result.defaultStartDate).toBe(expectedStart.toISOString().slice(0, 10));
    expect(result.initialAmount).toBe(2_000);
  });

  it("공급자 listDate보다 이른 실제 가격이 있으면 기간을 자르지 않고 충돌을 명시한다", async () => {
    const customInstruments: InstrumentInfo[] = [
      { ...instruments[0], listDate: "2020-01-01" },
      { ...instruments[1], listDate: "2024-11-26" },
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
      getUsdKrwExchangeRate: vi.fn().mockImplementation(async (date: string) => ({
        date,
        rate: 1,
        timestamp: `${date}T15:30:00+09:00`,
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

    expect(result.config.latestMetadataListDate).toBe("2024-11-26");
    expect(result.effectiveStartDate).toBe("2020-01-02");
    expect(result.metrics.totalReturnPercent).toBe(5);
    expect(result.config).toMatchObject({ riskFreeRatePercent: 2.5, transactionCostBps: 15 });
    expect(result.advanced.costEfficiency).toMatchObject({ transactionCostBps: 15, tradeCount: 2 });
    expect(result.advanced.costEfficiency.estimatedTotalCost).toBeGreaterThan(0);
    expect(result.warnings.join(" ")).toContain("AAPL 가격 첫 관측일 2020-01-02");
    expect(result.dataQuality.instrumentDateConsistency).toEqual(expect.arrayContaining([
      {
        symbol: "AAPL",
        firstObservationDate: "2020-01-02",
        metadataListDate: "2024-11-26",
        status: "price_precedes_metadata",
      },
    ]));
    expect(vi.mocked(toss.getDailyCandles)).toHaveBeenCalledWith("005930", undefined, true);
  });

  it("기술 전략의 inactive 시작을 위해 0% 종목과 100% 현금 초기 상태를 Rust 입력으로 준비한다", async () => {
    const toss = {
      getInstruments: vi.fn().mockResolvedValue([instruments[0]]),
      getDailyCandles: vi.fn().mockResolvedValue({
        candles: [candle("005930", "KRW", "2024-01-02", 100), candle("005930", "KRW", "2024-01-03", 110)],
        nextBefore: undefined,
        adjusted: true,
      }),
    } as unknown as TossClient;
    const store = await PortfolioHistoryStore.openSqlite(":memory:");
    stores.push(store);
    const service = new PortfolioBacktestService(toss, store);
    const request = {
      assets: [{ symbol: "005930", weight: 0 }],
      startDate: "2024-01-02",
      endDate: "2024-01-03",
      initialAmount: 1_000_000,
      monthlyCashFlow: 0,
      rebalanceFrequency: "none" as const,
      benchmark: "NONE" as const,
      execution: { cashTargetPercent: 100 },
    };

    const prepared = await service.prepare(request);

    expect(prepared.simulation.assets).toMatchObject([{ symbol: "005930", weight: 0 }]);
    expect(prepared.simulation.execution?.cashTargetPercent).toBe(100);
    expect(prepared.responseContext.config).toMatchObject({
      assets: [{ symbol: "005930", weight: 0 }],
      execution: { cashTargetPercent: 100 },
    });
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
      getUsdKrwExchangeRate: vi.fn().mockImplementation(async (date: string) => ({
        date,
        rate: 1,
        timestamp: `${date}T15:30:00+09:00`,
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

  it("늦게 시작하는 USD 자산 이전의 KRW-only 날짜에는 환율을 조회하지 않는다", async () => {
    const getUsdKrwExchangeRate = vi.fn().mockImplementation(async (date: string) => ({
      date,
      rate: 1_300,
      timestamp: `${date}T15:30:00+09:00`,
    }));
    const toss = {
      getInstruments: vi.fn().mockResolvedValue(instruments),
      getDailyCandles: vi.fn().mockImplementation(async (symbol: string, _before?: string, adjusted?: boolean) => ({
        candles: symbol === "005930"
          ? [
            candle(symbol, "KRW", "2024-01-01", 100),
            candle(symbol, "KRW", "2024-01-02", 101),
            candle(symbol, "KRW", "2024-01-03", 102),
            candle(symbol, "KRW", "2024-01-04", 103),
          ]
          : [
            candle(symbol, "USD", "2024-01-03", 100),
            candle(symbol, "USD", "2024-01-04", 101),
          ],
        nextBefore: undefined,
        adjusted,
      })),
      getUsdKrwExchangeRate,
    } as unknown as TossClient;
    const store = await PortfolioHistoryStore.openSqlite(":memory:");
    stores.push(store);

    const result = await new PortfolioBacktestService(toss, store).run({
      assets: [{ symbol: "005930", weight: 50 }, { symbol: "AAPL", weight: 50 }],
      startDate: "2024-01-01",
      endDate: "2024-01-04",
      initialAmount: 1_000_000,
      monthlyCashFlow: 0,
      rebalanceFrequency: "none",
      benchmark: "NONE",
      currencyMode: "KRW",
    });

    expect(result.effectiveStartDate).toBe("2024-01-03");
    expect(getUsdKrwExchangeRate.mock.calls.map(([date]) => date)).toEqual(["2024-01-03", "2024-01-04"]);
  });

  it("늦게 시작하는 USD 벤치마크 이전의 KRW-only 날짜에는 환율을 조회하지 않는다", async () => {
    const getUsdKrwExchangeRate = vi.fn().mockImplementation(async (date: string) => ({
      date,
      rate: 1_300,
      timestamp: `${date}T15:30:00+09:00`,
    }));
    const toss = {
      getInstruments: vi.fn().mockImplementation(async (symbols: string[]) => (
        instruments.filter((instrument) => symbols.includes(instrument.symbol))
      )),
      getDailyCandles: vi.fn().mockImplementation(async (symbol: string, _before?: string, adjusted?: boolean) => ({
        candles: symbol === "005930"
          ? [
            candle(symbol, "KRW", "2024-01-01", 100),
            candle(symbol, "KRW", "2024-01-02", 101),
            candle(symbol, "KRW", "2024-01-03", 102),
            candle(symbol, "KRW", "2024-01-04", 103),
          ]
          : [
            candle(symbol, "USD", "2024-01-03", 100),
            candle(symbol, "USD", "2024-01-04", 101),
          ],
        nextBefore: undefined,
        adjusted,
      })),
      getUsdKrwExchangeRate,
    } as unknown as TossClient;
    const store = await PortfolioHistoryStore.openSqlite(":memory:");
    stores.push(store);

    const result = await new PortfolioBacktestService(toss, store).run({
      assets: [{ symbol: "005930", weight: 100 }],
      startDate: "2024-01-01",
      endDate: "2024-01-04",
      initialAmount: 1_000_000,
      monthlyCashFlow: 0,
      rebalanceFrequency: "none",
      benchmark: "CUSTOM",
      benchmarkSymbol: "AAPL",
      currencyMode: "KRW",
    });

    expect(result.effectiveStartDate).toBe("2024-01-03");
    expect(getUsdKrwExchangeRate.mock.calls.map(([date]) => date)).toEqual(["2024-01-03", "2024-01-04"]);
  });

  it("필요 가격 시계열이 비어 있으면 환율 조회 전에 가격 이력 오류를 반환한다", async () => {
    const getUsdKrwExchangeRate = vi.fn();
    const toss = {
      getInstruments: vi.fn().mockResolvedValue([instruments[1]]),
      getDailyCandles: vi.fn().mockResolvedValue({ candles: [], nextBefore: undefined, adjusted: true }),
      getUsdKrwExchangeRate,
    } as unknown as TossClient;
    const store = await PortfolioHistoryStore.openSqlite(":memory:");
    stores.push(store);

    await expect(new PortfolioBacktestService(toss, store).run({
      assets: [{ symbol: "AAPL", weight: 100 }],
      startDate: "2024-01-01",
      endDate: "2024-01-04",
      initialAmount: 1_000_000,
      monthlyCashFlow: 0,
      rebalanceFrequency: "none",
      benchmark: "NONE",
      currencyMode: "KRW",
    })).rejects.toThrow("미국 종목의 선택 기간 일봉이 없습니다.");
    expect(getUsdKrwExchangeRate).not.toHaveBeenCalled();
  });

  it("미국 종목의 전체 기간 USD/KRW 경로를 반영하고 현지가격·환율 기여를 분리한다", async () => {
    const usd = instruments[1];
    const toss = {
      getInstruments: vi.fn().mockResolvedValue([usd]),
      getDailyCandles: vi.fn().mockResolvedValue({
        candles: [
          candle("AAPL", "USD", "2024-01-02", 100),
          candle("AAPL", "USD", "2024-01-03", 100),
        ],
        nextBefore: undefined,
        adjusted: true,
      }),
      getUsdKrwExchangeRate: vi.fn().mockImplementation(async (date: string) => ({
        date,
        rate: date === "2024-01-02" ? 1_000 : 1_100,
        timestamp: `${date}T15:30:00+09:00`,
      })),
    } as unknown as TossClient;
    const store = await PortfolioHistoryStore.openSqlite(":memory:");
    stores.push(store);
    const service = new PortfolioBacktestService(toss, store);
    const base = {
      assets: [{ symbol: "AAPL", weight: 100 }],
      startDate: "2024-01-02",
      endDate: "2024-01-03",
      initialAmount: 1_000_000,
      monthlyCashFlow: 0,
      rebalanceFrequency: "none" as const,
      benchmark: "NONE" as const,
    };

    const krw = await service.run({ ...base, currencyMode: "KRW" });
    const local = await service.run({ ...base, currencyMode: "local" });
    expect(krw.metrics.totalReturnPercent).toBeCloseTo(10, 8);
    expect(local.metrics.totalReturnPercent).toBeCloseTo(0, 8);
    expect(krw.contributions[0].localPriceContributionPercent).toBeCloseTo(0, 8);
    expect(krw.contributions[0].fxContributionPercent).toBeCloseTo(10, 8);
    expect(krw.dataQuality.commonReturnPolicy).toBe("inner_join");
  });

  it("미국 휴장일의 환율 변동은 KRW 평가 경로에만 반영하고 실제 공통 관측일로 세지 않는다", async () => {
    const toss = {
      getInstruments: vi.fn().mockResolvedValue(instruments),
      getDailyCandles: vi.fn().mockImplementation(async (symbol: string, _before?: string, adjusted?: boolean) => ({
        candles: symbol === "005930"
          ? [
            candle(symbol, "KRW", "2024-01-02", 100),
            candle(symbol, "KRW", "2024-01-03", 100),
            candle(symbol, "KRW", "2024-01-04", 100),
          ]
          : [
            candle(symbol, "USD", "2024-01-02", 100),
            candle(symbol, "USD", "2024-01-04", 100),
          ],
        nextBefore: undefined,
        adjusted,
      })),
      getUsdKrwExchangeRate: vi.fn().mockImplementation(async (date: string) => ({
        date,
        rate: date === "2024-01-02" ? 1_000 : 1_100,
        timestamp: `${date}T15:30:00+09:00`,
      })),
    } as unknown as TossClient;
    const store = await PortfolioHistoryStore.openSqlite(":memory:");
    stores.push(store);

    const result = await new PortfolioBacktestService(toss, store).run({
      assets: [{ symbol: "005930", weight: 50 }, { symbol: "AAPL", weight: 50 }],
      startDate: "2024-01-02",
      endDate: "2024-01-04",
      initialAmount: 1_000_000,
      monthlyCashFlow: 0,
      rebalanceFrequency: "none",
      benchmark: "NONE",
      currencyMode: "KRW",
    });

    expect(result.metrics.totalReturnPercent).toBeCloseTo(5, 8);
    expect(result.dataQuality.commonReturnObservations).toBe(1);
    expect(result.dataQuality.carryForwardByAsset).toEqual(expect.arrayContaining([
      { symbol: "AAPL", count: 1 },
    ]));
    expect(result.points.map((point) => point.date)).toContain("2024-01-03");
  });
});
