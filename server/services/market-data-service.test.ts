import { afterEach, describe, expect, it, vi } from "vitest";
import { PortfolioHistoryStore } from "../history.js";
import type { DailyCandle, TossClient } from "../toss.js";
import { MarketDataService } from "./market-data-service.js";

function candle(date: string, open: number, high: number, low: number, close: number): DailyCandle {
  return {
    symbol: "005930",
    date,
    timestamp: `${date}T15:30:00+09:00`,
    currency: "KRW",
    openPrice: open,
    highPrice: high,
    lowPrice: low,
    closePrice: close,
  };
}

describe("MarketDataService", () => {
  const stores: PortfolioHistoryStore[] = [];

  afterEach(async () => {
    await Promise.all(stores.splice(0).map((store) => store.close()));
  });

  it("수정·비수정 candle을 분리하고 주봉·월봉 OHLC를 일봉 cache에서 집계한다", async () => {
    const base = [
      candle("2024-01-30", 100, 110, 90, 105),
      candle("2024-01-31", 106, 115, 95, 110),
      candle("2024-02-01", 111, 120, 100, 115),
      candle("2024-02-02", 116, 125, 105, 120),
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
      open: 100, high: 125, low: 90, close: 120,
    });

    const monthly = await service.getPriceSeries({
      symbol: "005930", fromDate: "2024-01-30", toDate: "2024-02-02",
      interval: "1mo", adjusted: true, currencyMode: "KRW",
    });
    expect(monthly.points.map((point) => ({
      start: point.periodStart, end: point.periodEnd, observations: point.observations,
      open: point.open, high: point.high, low: point.low, close: point.close,
    }))).toEqual([
      { start: "2024-01-30", end: "2024-01-31", observations: 2, open: 100, high: 115, low: 90, close: 110 },
      { start: "2024-02-01", end: "2024-02-02", observations: 2, open: 111, high: 125, low: 100, close: 120 },
    ]);

    const unadjusted = await service.getPriceSeries({
      symbol: "005930", fromDate: "2024-01-30", toDate: "2024-02-02",
      interval: "1d", adjusted: false, currencyMode: "KRW",
    });
    expect(unadjusted.points[0].close).toBe(210);
    expect(unadjusted.adjusted).toBe(false);
    expect(vi.mocked(toss.getDailyCandles)).toHaveBeenCalledWith("005930", undefined, true);
    expect(vi.mocked(toss.getDailyCandles)).toHaveBeenCalledWith("005930", undefined, false);
  });
});
