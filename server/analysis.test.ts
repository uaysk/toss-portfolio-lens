import { describe, expect, it } from "vitest";
import {
  analysisStartDate,
  buildPositionWeightedReturns,
  combinePortfolioCandles,
  combinePortfolioHistories,
  parseBenchmarkKeys,
} from "./analysis.js";
import { PortfolioHistoryStore, type PortfolioHistory } from "./history.js";

describe("portfolio analysis query", () => {
  it("기간 프리셋을 KST 달력 일수로 변환하고 첫 거래일을 넘지 않는다", () => {
    expect(analysisStartDate("30d", "2026-07-15")).toBe("2026-06-16");
    expect(analysisStartDate("90d", "2026-07-15", "2026-06-20")).toBe("2026-06-20");
    expect(analysisStartDate("all", "2026-07-15", "2025-03-31")).toBe("2025-03-31");
  });

  it("허용된 비교 지수만 중복 없이 선택한다", () => {
    expect(parseBenchmarkKeys("KOSPI,nasdaq100,KOSPI")).toEqual(["KOSPI", "NASDAQ100"]);
    expect(parseBenchmarkKeys(undefined)).toEqual(["KOSPI", "KOSDAQ", "NASDAQ100", "SP500"]);
    expect(() => parseBenchmarkKeys("DOW")).toThrow("지원하는 비교 지수");
  });

  it("국내·해외 평가금을 해당일 환율로 원화 환산해 한 시계열로 합친다", () => {
    const base = {
      accountId: "account-1",
      range: "all" as const,
      generatedAt: "2026-07-02T00:00:00.000Z",
      fromDate: "2026-07-01",
      toDate: "2026-07-02",
    };
    const krw: PortfolioHistory = {
      ...base,
      currency: "KRW",
      series: [{ key: "KRX:AAA", symbol: "AAA", name: "국내", market: "KRX", currency: "KRW", averageWeight: 100 }],
      points: [
        { date: "2026-07-01", capturedAt: base.generatedAt, totalValue: 1_000, values: { "KRX:AAA": 100 } },
        { date: "2026-07-02", capturedAt: base.generatedAt, totalValue: 1_100, values: { "KRX:AAA": 100 } },
      ],
    };
    const usd: PortfolioHistory = {
      ...base,
      currency: "USD",
      series: [{ key: "NASDAQ:US", symbol: "US", name: "해외", market: "NASDAQ", currency: "USD", averageWeight: 100 }],
      points: [
        { date: "2026-07-01", capturedAt: base.generatedAt, totalValue: 10, values: { "NASDAQ:US": 100 } },
        { date: "2026-07-02", capturedAt: base.generatedAt, totalValue: 11, values: { "NASDAQ:US": 100 } },
      ],
    };
    const rates = new Map([["2026-07-01", 1_400], ["2026-07-02", 1_410]]);
    const combined = combinePortfolioHistories(krw, usd, rates);
    expect(combined.points.map((point) => point.totalValue)).toEqual([15_000, 16_610]);
    expect(combined.points[0].values["NASDAQ:US"]).toBeCloseTo(93.3333, 3);

    expect(combinePortfolioCandles(
      [{ date: "2026-07-01", open: 900, high: 1_100, low: 850, close: 1_000 }],
      [{ date: "2026-07-01", open: 9, high: 11, low: 8, close: 10 }],
      combined,
      krw,
      usd,
      rates,
    )).toEqual([{ date: "2026-07-01", open: 13_500, high: 16_500, low: 12_050, close: 15_000 }]);
  });

  it("전일 국내·해외 비중으로 가격과 환율의 일간수익률을 가중한다", async () => {
    const store = await PortfolioHistoryStore.openSqlite(":memory:");
    try {
      await store.upsertInstruments([
        { symbol: "AAA", name: "국내", market: "KRX", currency: "KRW" },
        { symbol: "US", name: "해외", market: "NASDAQ", currency: "USD" },
      ]);
      await store.upsertDailyPrices("KRW:AAA", [
        { symbol: "AAA", date: "2026-07-01", timestamp: "2026-07-01", currency: "KRW", openPrice: 100, highPrice: 100, lowPrice: 100, closePrice: 100 },
        { symbol: "AAA", date: "2026-07-02", timestamp: "2026-07-02", currency: "KRW", openPrice: 110, highPrice: 110, lowPrice: 110, closePrice: 110 },
      ]);
      await store.upsertDailyPrices("USD:US", [
        { symbol: "US", date: "2026-07-01", timestamp: "2026-07-01", currency: "USD", openPrice: 10, highPrice: 10, lowPrice: 10, closePrice: 10 },
        { symbol: "US", date: "2026-07-02", timestamp: "2026-07-02", currency: "USD", openPrice: 11, highPrice: 11, lowPrice: 11, closePrice: 11 },
      ]);
      const history: PortfolioHistory = {
        accountId: "account-1", currency: "KRW", range: "all", generatedAt: "2026-07-02",
        series: [
          { key: "KRX:AAA", symbol: "AAA", name: "국내", market: "KRX", currency: "KRW", averageWeight: 50 },
          { key: "NASDAQ:US", symbol: "US", name: "해외", market: "NASDAQ", currency: "USD", averageWeight: 50 },
        ],
        points: [
          { date: "2026-07-01", capturedAt: "2026-07-01", totalValue: 2_000, values: { "KRX:AAA": 50, "NASDAQ:US": 50 } },
          { date: "2026-07-02", capturedAt: "2026-07-02", totalValue: 2_200, values: { "KRX:AAA": 50, "NASDAQ:US": 50 } },
        ],
      };
      const result = await buildPositionWeightedReturns(history, store, new Map([
        ["2026-07-01", 1_400], ["2026-07-02", 1_410],
      ]));
      expect(result).toHaveLength(1);
      expect(result[0].value).toBeCloseTo(0.10392857, 7);
    } finally {
      await store.close();
    }
  });
});
