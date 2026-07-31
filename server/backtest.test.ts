import { afterEach, describe, expect, it, vi } from "vitest";
import { PortfolioBacktestService, type BacktestRunRequest } from "./backtest.js";
import { BacktestValidationError } from "./contracts/backtest.js";
import { PortfolioHistoryStore } from "./history.js";
import { openTestHistoryStore } from "../test-support/history-store.js";
import type { DailyCandle, InstrumentInfo, Portfolio, TossClient } from "./toss.js";

const instruments: InstrumentInfo[] = [
  {
    symbol: "005930",
    name: "국내 종목",
    market: "KRX",
    currency: "KRW",
    listDate: "1975-06-11",
    securityType: "STOCK",
    status: "ACTIVE",
  },
  {
    symbol: "AAPL",
    name: "미국 종목",
    market: "NASDAQ",
    currency: "USD",
    listDate: "1980-12-12",
    securityType: "STOCK",
    status: "ACTIVE",
  },
];

function candle(
  symbol: string,
  currency: "KRW" | "USD",
  date: string,
  closePrice: number,
): DailyCandle {
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

const request: BacktestRunRequest = {
  assets: [{ symbol: "005930", weight: 50 }, { symbol: "AAPL", weight: 50 }],
  startDate: "2020-01-01",
  endDate: "2020-01-03",
  initialAmount: 1_000_000,
  monthlyCashFlow: 0,
  rebalanceFrequency: "none",
  riskFreeRatePercent: 2.5,
  transactionCostBps: 15,
  benchmark: "NONE",
};

describe("PortfolioBacktestService data preparation", () => {
  const stores: PortfolioHistoryStore[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(stores.splice(0).map((store) => store.close()));
  });

  it("builds current KRW weights without running a TypeScript simulation", async () => {
    const toss = {
      getPortfolio: vi.fn().mockResolvedValue(currentPortfolio()),
      getInstruments: vi.fn().mockResolvedValue(instruments),
      getUsdKrwExchangeRate: vi.fn().mockResolvedValue({
        date: "2026-07-15",
        rate: 1_400,
        timestamp: "2026-07-15T00:00:00+09:00",
      }),
    } as unknown as TossClient;
    const store = await openTestHistoryStore();
    stores.push(store);

    const result = await new PortfolioBacktestService(toss, store).currentPortfolio("account-1");

    expect(result.assets.map(({ symbol, weight }) => ({ symbol, weight }))).toEqual([
      { symbol: "005930", weight: 30 },
      { symbol: "AAPL", weight: 70 },
    ]);
    expect(result.initialAmount).toBe(2_000);
  });

  it("prepares canonical Rust input, observed dates, FX and response context", async () => {
    const getUsdKrwExchangeRate = vi.fn().mockImplementation(async (date: string) => ({
      date,
      rate: date === "2020-01-02" ? 1_100 : 1_120,
      timestamp: `${date}T15:30:00+09:00`,
    }));
    const toss = {
      getInstruments: vi.fn().mockResolvedValue(instruments),
      getDailyCandles: vi.fn().mockImplementation(async (
        symbol: string,
        _before?: string,
        adjusted?: boolean,
      ) => ({
        candles: [
          candle(symbol, symbol === "AAPL" ? "USD" : "KRW", "2020-01-02", 100),
          candle(symbol, symbol === "AAPL" ? "USD" : "KRW", "2020-01-03", 110),
        ],
        nextBefore: undefined,
        adjusted,
      })),
      getUsdKrwExchangeRate,
    } as unknown as TossClient;
    const store = await openTestHistoryStore();
    stores.push(store);

    const prepared = await new PortfolioBacktestService(toss, store).prepare(request);

    expect([...prepared.simulation.prices.keys()].sort()).toEqual(["KRW:005930", "USD:AAPL"]);
    expect(prepared.simulation.observedDates?.get("USD:AAPL")).toEqual([
      "2020-01-02",
      "2020-01-03",
    ]);
    expect(prepared.responseContext.config).toMatchObject({
      requestedStartDate: "2020-01-01",
      latestMetadataListDate: "1980-12-12",
    });
    expect(getUsdKrwExchangeRate).toHaveBeenCalledTimes(2);
  });

  it("fails before FX preparation when a required price series is empty", async () => {
    const getUsdKrwExchangeRate = vi.fn();
    const toss = {
      getInstruments: vi.fn().mockResolvedValue(instruments),
      getDailyCandles: vi.fn().mockResolvedValue({ candles: [], nextBefore: undefined }),
      getUsdKrwExchangeRate,
    } as unknown as TossClient;
    const store = await openTestHistoryStore();
    stores.push(store);

    await expect(new PortfolioBacktestService(toss, store).prepare(request))
      .rejects.toBeInstanceOf(BacktestValidationError);
    expect(getUsdKrwExchangeRate).not.toHaveBeenCalled();
  });
});
