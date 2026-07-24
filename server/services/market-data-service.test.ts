import { afterEach, describe, expect, it, vi } from "vitest";
import { PortfolioHistoryStore } from "../history.js";
import { TossApiError, type DailyCandle, type TossClient } from "../toss.js";
import type { KisExchangeRateProvider } from "../kis-exchange-rate.js";
import { MarketDataService } from "./market-data-service.js";

function candle(date: string, open: number, high: number, low: number, close: number, volume?: number): DailyCandle {
  return {
    symbol: "005930",
    date,
    timestamp: `${date}T15:30:00+09:00`,
    currency: "KRW",
    openPrice: open,
    highPrice: high,
    lowPrice: low,
    closePrice: close,
    ...(volume === undefined ? {} : { volume }),
  };
}

describe("MarketDataService", () => {
  const stores: PortfolioHistoryStore[] = [];

  afterEach(async () => {
    await Promise.all(stores.splice(0).map((store) => store.close()));
  });

  it("수정·비수정 candle을 분리하고 주봉·월봉 OHLC를 일봉 cache에서 집계한다", async () => {
    const base = [
      candle("2024-01-30", 100, 110, 90, 105, 100),
      candle("2024-01-31", 106, 115, 95, 110, 200),
      candle("2024-02-01", 111, 120, 100, 115, 300),
      candle("2024-02-02", 116, 125, 105, 120, 400),
    ];
    const toss = {
      getInstruments: vi.fn().mockResolvedValue([{
        symbol: "005930", name: "삼성전자", market: "KRX", currency: "KRW",
        listDate: "1975-06-11", securityType: "STOCK", status: "ACTIVE",
      }]),
      getDailyCandles: vi.fn().mockImplementation(async (_symbol: string, _before: string | undefined, adjusted: boolean) => ({
        candles: adjusted ? base : base.map((item) => ({
          ...item,
          openPrice: item.openPrice * 2,
          highPrice: item.highPrice * 2,
          lowPrice: item.lowPrice * 2,
          closePrice: item.closePrice * 2,
        })),
      })),
    } as unknown as TossClient;
    const store = await PortfolioHistoryStore.openSqlite(":memory:");
    stores.push(store);
    const service = new MarketDataService(toss, store);

    const weekly = await service.getPriceSeries({
      symbol: "005930", fromDate: "2024-01-30", toDate: "2024-02-02",
      interval: "1w", adjusted: true, currencyMode: "KRW",
    });
    expect(weekly.points).toHaveLength(1);
    expect(weekly.points[0]).toMatchObject({
      periodStart: "2024-01-30", periodEnd: "2024-02-02", observations: 4,
      open: 100, high: 125, low: 90, close: 120, volume: 1_000,
    });
    expect(weekly.dataQuality).toMatchObject({
      observations: 4,
      outputObservations: 1,
      volumeObservations: 1,
      missingVolumeObservations: 0,
      volumeCoverage: 1,
      volumeStatus: "available",
      sourceDailyVolumeObservations: 4,
      sourceDailyMissingVolumeObservations: 0,
      sourceDailyVolumeCoverage: 1,
      sourceDailyVolumeStatus: "available",
    });

    const monthly = await service.getPriceSeries({
      symbol: "005930", fromDate: "2024-01-30", toDate: "2024-02-02",
      interval: "1mo", adjusted: true, currencyMode: "KRW",
    });
    expect(monthly.points.map((point) => ({
      start: point.periodStart, end: point.periodEnd, observations: point.observations,
      open: point.open, high: point.high, low: point.low, close: point.close, volume: point.volume,
    }))).toEqual([
      { start: "2024-01-30", end: "2024-01-31", observations: 2, open: 100, high: 115, low: 90, close: 110, volume: 300 },
      { start: "2024-02-01", end: "2024-02-02", observations: 2, open: 111, high: 125, low: 100, close: 120, volume: 700 },
    ]);

    const unadjusted = await service.getPriceSeries({
      symbol: "005930", fromDate: "2024-01-30", toDate: "2024-02-02",
      interval: "1d", adjusted: false, currencyMode: "KRW",
    });
    expect(unadjusted.points[0].close).toBe(210);
    expect(unadjusted.adjusted).toBe(false);
    expect(vi.mocked(toss.getDailyCandles)).toHaveBeenCalledWith("005930", undefined, true);
    expect(vi.mocked(toss.getDailyCandles)).toHaveBeenCalledWith("005930", undefined, false);
    const availability = await service.getDataAvailability(["005930"], true);
    expect(availability.assets[0]).toMatchObject({
      symbol: "005930",
      observations: 4,
      volumeObservations: 4,
      missingVolumeObservations: 0,
      volumeCoverage: 1,
      volumeStatus: "available",
    });
  });

  it.each([
    ["partial", [100, undefined], 1, 1, 0.5],
    ["volume_unavailable", [undefined, undefined], 0, 2, 0],
  ] as const)("일봉 거래량 coverage를 %s로 보존하고 불완전한 주봉은 effective volume_unavailable로 구분한다", async (
    expectedSourceStatus,
    volumes,
    expectedObserved,
    expectedMissing,
    expectedCoverage,
  ) => {
    const toss = {
      getInstruments: vi.fn().mockResolvedValue([{
        symbol: "005930", name: "삼성전자", market: "KRX", currency: "KRW",
        securityType: "STOCK", status: "ACTIVE",
      }]),
      getDailyCandles: vi.fn().mockResolvedValue({
        candles: [
          candle("2024-01-02", 100, 110, 90, 105, volumes[0]),
          candle("2024-01-03", 105, 115, 95, 110, volumes[1]),
        ],
      }),
    } as unknown as TossClient;
    const store = await PortfolioHistoryStore.openSqlite(":memory:");
    stores.push(store);

    const service = new MarketDataService(toss, store);
    const result = await service.getPriceSeries({
      symbol: "005930",
      fromDate: "2024-01-02",
      toDate: "2024-01-03",
      interval: "1w",
      adjusted: true,
      currencyMode: "KRW",
      requireVolume: true,
    });

    expect(result.points[0]?.volume).toBeNull();
    expect(result.dataQuality).toMatchObject({
      observations: 2,
      outputObservations: 1,
      volumeObservations: 0,
      missingVolumeObservations: 1,
      volumeCoverage: 0,
      volumeStatus: "volume_unavailable",
      sourceDailyVolumeObservations: expectedObserved,
      sourceDailyMissingVolumeObservations: expectedMissing,
      sourceDailyVolumeCoverage: expectedCoverage,
      sourceDailyVolumeStatus: expectedSourceStatus,
    });
    expect(result.warnings.join(" ")).toContain("unavailable");
  });

  it("기존 OHLC cache에 volume이 없으면 거래량 지표 요청에서 provider 값을 보강한다", async () => {
    const store = await PortfolioHistoryStore.openSqlite(":memory:");
    stores.push(store);
    await store.upsertMarketCandles("stock", "005930", "1d", true, [
      candle("2024-01-02", 100, 110, 90, 105),
      candle("2024-01-03", 105, 115, 95, 110),
    ], 1_000);
    const toss = {
      getInstruments: vi.fn().mockResolvedValue([{
        symbol: "005930", name: "삼성전자", market: "KRX", currency: "KRW",
        securityType: "STOCK", status: "ACTIVE",
      }]),
      getDailyCandles: vi.fn().mockResolvedValue({
        candles: [
          candle("2024-01-02", 100, 110, 90, 105, 1_000),
          candle("2024-01-03", 105, 115, 95, 110, 2_000),
        ],
      }),
    } as unknown as TossClient;

    const service = new MarketDataService(toss, store);
    const result = await service.getPriceSeries({
      symbol: "005930",
      fromDate: "2024-01-02",
      toDate: "2024-01-03",
      adjusted: true,
      currencyMode: "KRW",
      requireVolume: true,
    });

    expect(toss.getDailyCandles).toHaveBeenCalledOnce();
    expect(result.points.map((point) => point.volume)).toEqual([1_000, 2_000]);
    expect(result.dataQuality.volumeStatus).toBe("available");

    const cached = await service.repository.getCandles({
      symbol: "005930",
      adjusted: true,
      fromDate: "2024-01-02",
      toDate: "2024-01-03",
    });
    await store.upsertMarketCandles("stock", "005930", "1d", true, [
      candle("2024-01-02", 100, 110, 90, 105, 2_000),
      candle("2024-01-03", 105, 115, 95, 110, 1_000),
    ], cached[0]!.updatedAt);
    const redistributed = await service.getPriceSeries({
      symbol: "005930",
      fromDate: "2024-01-02",
      toDate: "2024-01-03",
      adjusted: true,
      currencyMode: "KRW",
      requireVolume: true,
    });
    expect(redistributed.points.map((point) => point.volume)).toEqual([2_000, 1_000]);
    expect(redistributed.dataRevision).not.toBe(result.dataRevision);
  });

  it("가격 첫 관측일이 metadata listDate보다 빠르면 data-quality 충돌을 반환한다", async () => {
    const toss = {
      getInstruments: vi.fn().mockResolvedValue([{
        symbol: "PLTR", name: "Palantir", market: "NASDAQ", currency: "USD",
        listDate: "2024-11-26", securityType: "STOCK", status: "ACTIVE",
      }]),
      getDailyCandles: vi.fn().mockResolvedValue({
        candles: [
          { ...candle("2021-04-15", 20, 21, 19, 20), symbol: "PLTR", currency: "USD" },
          { ...candle("2021-04-16", 21, 22, 20, 21), symbol: "PLTR", currency: "USD" },
        ],
      }),
    } as unknown as TossClient;
    const store = await PortfolioHistoryStore.openSqlite(":memory:");
    stores.push(store);
    const result = await new MarketDataService(toss, store).getPriceSeries({
      symbol: "PLTR", fromDate: "2021-04-15", toDate: "2021-04-16",
      interval: "1d", adjusted: true, currencyMode: "local",
    });

    expect(result.dataQuality).toMatchObject({
      firstObservationDate: "2021-04-15",
      metadataListDate: "2024-11-26",
      listingDateConsistency: "price_precedes_metadata",
    });
    expect(result.warnings.join(" ")).toContain("listDate 2024-11-26보다 빠릅니다");
  });

  it("과거 USD/KRW가 공급되지 않으면 symbol과 가용 기간이 있는 구조화 오류를 반환한다", async () => {
    const toss = {
      getInstruments: vi.fn().mockResolvedValue([{
        symbol: "NVDA", name: "NVIDIA", market: "NASDAQ", currency: "USD",
        listDate: "1999-01-22", securityType: "STOCK", status: "ACTIVE",
      }]),
      getDailyCandles: vi.fn().mockResolvedValue({
        candles: [
          { ...candle("2021-04-15", 100, 101, 99, 100), symbol: "NVDA", currency: "USD" },
        ],
      }),
      getUsdKrwExchangeRate: vi.fn().mockRejectedValue(
        new TossApiError("환율정보가 존재하지 않아요", 404, "exchange-rate-not-found", "fx-request-id"),
      ),
    } as unknown as TossClient;
    const store = await PortfolioHistoryStore.openSqlite(":memory:");
    stores.push(store);
    const service = new MarketDataService(toss, store);

    await expect(service.getPriceSeries({
      symbol: "NVDA", fromDate: "2021-04-15", toDate: "2026-07-17",
      interval: "1d", adjusted: true, currencyMode: "KRW",
    })).rejects.toMatchObject({
      detail: {
        code: "FX_HISTORY_UNAVAILABLE",
        retryable: false,
        details: {
          symbol: "NVDA",
          fx_pair: "USD/KRW",
          requested_period: { from: "2021-04-15", to: "2026-07-17" },
          missing_observation_count: 1,
          upstream: {
            status: 404,
            code: "exchange-rate-not-found",
            request_id: "fx-request-id",
          },
        },
      },
    });
    expect(vi.mocked(toss.getUsdKrwExchangeRate)).toHaveBeenCalledTimes(8);
  });

  it("Toss에 과거 환율이 없으면 KIS 일별 환율로 캐시를 보완한다", async () => {
    const toss = {
      getInstruments: vi.fn().mockResolvedValue([{
        symbol: "AAPL", name: "Apple", market: "NASDAQ", currency: "USD",
        listDate: "1980-12-12", securityType: "STOCK", status: "ACTIVE",
      }]),
      getDailyCandles: vi.fn().mockResolvedValue({
        candles: [
          { ...candle("2022-08-03", 160, 162, 159, 161), symbol: "AAPL", currency: "USD" },
          { ...candle("2022-08-04", 161, 165, 160, 164), symbol: "AAPL", currency: "USD" },
        ],
      }),
      getUsdKrwExchangeRate: vi.fn().mockRejectedValue(
        new TossApiError("환율정보가 존재하지 않아요", 404, "exchange-rate-not-found"),
      ),
    } as unknown as TossClient;
    const fallback = {
      getUsdKrwExchangeRates: vi.fn().mockResolvedValue([
        { date: "2022-08-02", rate: 1_310, timestamp: "2022-08-02T15:30:00+09:00" },
        { date: "2022-08-03", rate: 1_312, timestamp: "2022-08-03T15:30:00+09:00" },
        { date: "2022-08-04", rate: 1_315, timestamp: "2022-08-04T15:30:00+09:00" },
      ]),
    } satisfies KisExchangeRateProvider;
    const store = await PortfolioHistoryStore.openSqlite(":memory:");
    stores.push(store);

    const result = await new MarketDataService(toss, store, fallback).getPriceSeries({
      symbol: "AAPL", fromDate: "2022-08-03", toDate: "2022-08-04",
      interval: "1d", adjusted: true, currencyMode: "KRW",
    });

    expect(result.points.map((point) => point.fxRate)).toEqual([1_312, 1_315]);
    expect(fallback.getUsdKrwExchangeRates).toHaveBeenCalledWith("2022-07-27", "2022-08-04");
    expect(await store.getExchangeRates("2022-08-02", "2022-08-04")).toEqual(new Map([
      ["2022-08-02", 1_310],
      ["2022-08-03", 1_312],
      ["2022-08-04", 1_315],
    ]));
  });

  it.each([
    [1, "2024-01-03"],
    [7, "2024-01-09"],
  ] as const)("유효한 선행 환율을 %i일까지 carry-forward한다 (%s)", async (_carryDays, lastDate) => {
    const toss = {
      getInstruments: vi.fn().mockResolvedValue([{
        symbol: "NVDA", name: "NVIDIA", market: "NASDAQ", currency: "USD",
        listDate: "1999-01-22", securityType: "STOCK", status: "ACTIVE",
      }]),
      getDailyCandles: vi.fn().mockResolvedValue({
        candles: [
          { ...candle("2024-01-02", 100, 101, 99, 100), symbol: "NVDA", currency: "USD" },
          { ...candle(lastDate, 101, 102, 100, 101), symbol: "NVDA", currency: "USD" },
        ],
      }),
      getUsdKrwExchangeRate: vi.fn().mockImplementation(async (date: string) => {
        if (date === "2024-01-02") {
          return { date, rate: 1_300, timestamp: `${date}T15:30:00+09:00` };
        }
        throw new TossApiError("환율정보가 존재하지 않아요", 404, "exchange-rate-not-found");
      }),
    } as unknown as TossClient;
    const store = await PortfolioHistoryStore.openSqlite(":memory:");
    stores.push(store);
    const result = await new MarketDataService(toss, store).getPriceSeries({
      symbol: "NVDA", fromDate: "2024-01-02", toDate: lastDate,
      interval: "1d", adjusted: true, currencyMode: "KRW",
    });

    expect(result.points.map((point) => point.fxRate)).toEqual([1_300, 1_300]);
    expect(result.dataQuality).toMatchObject({
      missingFxObservations: 0,
      carriedFxObservations: 1,
    });
  });

  it("환율 carry-forward가 8일째 필요하면 최초 미커버 날짜를 구조화 오류로 반환한다", async () => {
    const toss = {
      getInstruments: vi.fn().mockResolvedValue([{
        symbol: "NVDA", name: "NVIDIA", market: "NASDAQ", currency: "USD",
        listDate: "1999-01-22", securityType: "STOCK", status: "ACTIVE",
      }]),
      getDailyCandles: vi.fn().mockResolvedValue({
        candles: [
          { ...candle("2024-01-02", 100, 101, 99, 100), symbol: "NVDA", currency: "USD" },
          { ...candle("2024-01-10", 101, 102, 100, 101), symbol: "NVDA", currency: "USD" },
        ],
      }),
      getUsdKrwExchangeRate: vi.fn().mockImplementation(async (date: string) => {
        if (date === "2024-01-02") {
          return { date, rate: 1_300, timestamp: `${date}T15:30:00+09:00` };
        }
        throw new TossApiError("환율정보가 존재하지 않아요", 404, "exchange-rate-not-found");
      }),
    } as unknown as TossClient;
    const store = await PortfolioHistoryStore.openSqlite(":memory:");
    stores.push(store);

    await expect(new MarketDataService(toss, store).getPriceSeries({
      symbol: "NVDA", fromDate: "2024-01-02", toDate: "2024-01-10",
      interval: "1d", adjusted: true, currencyMode: "KRW",
    })).rejects.toMatchObject({
      detail: {
        code: "FX_HISTORY_UNAVAILABLE",
        retryable: false,
        details: {
          symbol: "NVDA",
          last_valid_fx_date: "2024-01-02",
          first_uncovered_date: "2024-01-10",
          carry_forward_days: 8,
          carry_forward_limit_days: 7,
        },
      },
    });
  });
});
