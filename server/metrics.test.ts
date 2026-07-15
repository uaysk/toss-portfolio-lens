import { describe, expect, it } from "vitest";
import { calculatePortfolioAnalytics } from "./metrics.js";
import type { PortfolioHistory } from "./history.js";

describe("portfolio analytics", () => {
  it("체결 순액을 평가금 변화에서 제거해 성과·위험·비용 지표를 계산한다", () => {
    const history: PortfolioHistory = {
      accountId: "account-1",
      currency: "KRW",
      range: "all",
      generatedAt: "2026-07-03T00:00:00.000Z",
      fromDate: "2026-07-01",
      toDate: "2026-07-03",
      series: [{ key: "KRX:AAA", symbol: "AAA", name: "에이", market: "KRX", currency: "KRW", averageWeight: 100 }],
      points: [
        { date: "2026-07-01", capturedAt: "2026-07-01T00:00:00Z", totalValue: 100, values: { "KRX:AAA": 100 } },
        { date: "2026-07-02", capturedAt: "2026-07-02T00:00:00Z", totalValue: 160, values: { "KRX:AAA": 100 } },
        { date: "2026-07-03", capturedAt: "2026-07-03T00:00:00Z", totalValue: 144, values: { "KRX:AAA": 100 } },
      ],
    };
    const result = calculatePortfolioAnalytics({
      history,
      candles: [
        { date: "2026-07-01", open: 100, high: 100, low: 100, close: 100 },
        { date: "2026-07-02", open: 160, high: 160, low: 160, close: 160 },
        { date: "2026-07-03", open: 144, high: 144, low: 144, close: 144 },
      ],
      orders: [{
        orderId: "buy-1", symbol: "AAA", side: "BUY", currency: "KRW", status: "CLOSED",
        orderedAt: "2026-07-02T09:00:00+09:00", filledAt: "2026-07-02T09:01:00+09:00",
        filledQuantity: 1, averageFilledPrice: 50, filledAmount: 50, commission: 1, tax: 0,
      }],
      exchangeRates: new Map(),
      benchmarks: [{ key: "KOSPI", points: [{ date: "2026-07-01", close: 100 }, { date: "2026-07-03", close: 105 }] }],
    });

    expect(result.metrics.estimatedReturnPercent).toBeCloseTo(-1, 6);
    expect(result.metrics.maxDrawdownPercent).toBe(-10);
    expect(result.metrics.benchmarkReturns.KOSPI).toBe(5);
    expect(result.metrics.excessReturns.KOSPI).toBe(-6);
    expect(result.metrics.top3WeightPercent).toBe(100);
    expect(result.metrics.hhi).toBe(1);
    expect(result.metrics.tradeCount).toBe(1);
    expect(result.metrics.commission).toBe(1);
    expect(result.contributions[0].estimatedProfitLoss).toBe(-6);
  });
});
