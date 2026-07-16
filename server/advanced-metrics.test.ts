import { describe, expect, it } from "vitest";
import { calculateAdvancedAnalytics, type PortfolioReturnDetail } from "./advanced-metrics.js";
import type { PortfolioHistory } from "./history.js";

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

describe("advanced portfolio analytics", () => {
  it("롤링·벤치마크·낙폭·꼬리위험·기여도·위험기여를 같은 일간수익률로 계산한다", () => {
    const baseDate = "2026-01-01";
    const returns = Array.from({ length: 70 }, (_, index) => ({
      date: addDays(baseDate, index + 1),
      value: index % 5 === 4 ? -0.012 : 0.006,
    }));
    const detail: PortfolioReturnDetail = {
      returns,
      daily: returns.map((point, index) => ({
        ...point,
        assets: [
          {
            key: "KRX:AAA", totalReturn: index % 5 === 4 ? -0.02 : 0.008, localReturn: index % 5 === 4 ? -0.02 : 0.008,
            fxReturn: 0, contribution: index % 5 === 4 ? -0.012 : 0.0048, localContribution: index % 5 === 4 ? -0.012 : 0.0048, fxContribution: 0,
          },
          {
            key: "NASDAQ:BBB", totalReturn: index % 5 === 4 ? 0 : 0.003, localReturn: index % 5 === 4 ? 0 : 0.002,
            fxReturn: index % 5 === 4 ? 0 : 0.000998, contribution: index % 5 === 4 ? 0 : 0.0012,
            localContribution: index % 5 === 4 ? 0 : 0.0008, fxContribution: index % 5 === 4 ? 0 : 0.0004,
          },
        ],
      })),
      expectedReturnObservations: 70,
      requiredPriceObservations: 140,
      missingPriceObservations: 0,
      requiredFxObservations: 70,
      missingFxObservations: 0,
    };
    const history: PortfolioHistory = {
      accountId: "account", currency: "KRW", range: "all", generatedAt: "2026-03-12",
      series: [
        { key: "KRX:AAA", symbol: "AAA", name: "에이", market: "KRX", currency: "KRW", averageWeight: 60 },
        { key: "NASDAQ:BBB", symbol: "BBB", name: "비", market: "NASDAQ", currency: "USD", averageWeight: 40 },
      ],
      points: [
        { date: baseDate, capturedAt: baseDate, totalValue: 100, values: { "KRX:AAA": 60, "NASDAQ:BBB": 40 } },
        { date: addDays(baseDate, 70), capturedAt: addDays(baseDate, 70), totalValue: 120, values: { "KRX:AAA": 60, "NASDAQ:BBB": 40 } },
      ],
    };
    let benchmarkClose = 100;
    const benchmarkPoints = [{ date: baseDate, close: benchmarkClose }, ...returns.map((point, index) => {
      benchmarkClose *= 1 + (index % 4 === 3 ? -0.004 : 0.003);
      return { date: point.date, close: benchmarkClose };
    })];

    const result = calculateAdvancedAnalytics({
      detail,
      history,
      candles: returns.map((point, index) => ({ date: point.date, close: 100 + index })),
      benchmarks: [{ key: "KOSPI", points: benchmarkPoints }],
      orders: [],
      datedOrders: [],
      fromDate: baseDate,
      toDate: returns.at(-1)!.date,
      riskFreeRatePercent: 3,
      totalBuyAmount: 0,
      totalSellAmount: 0,
      commission: 0,
      tax: 0,
      averageValue: 100,
      estimatedReturnPercent: 10,
      convertAmount: (value) => value,
    });

    expect(result.benchmarkComparisons[0].observations).toBe(70);
    expect(result.benchmarkComparisons[0].trackingErrorPercent).not.toBeNull();
    expect(result.rolling.at(-1)?.return60d).not.toBeNull();
    expect(result.drawdowns.points).toHaveLength(71);
    expect(result.tailRisk.historicalVar95Percent).toBe(-1.2);
    expect(result.monthlyReturns.length).toBeGreaterThan(1);
    expect(result.attributionByKey["NASDAQ:BBB"].fxContributionPercent).toBeGreaterThan(0);
    expect(result.riskContributions).toHaveLength(2);
    expect(result.correlations.assets.map((asset) => asset.name)).toEqual(["에이", "비"]);
    expect(result.exposure.usdWeightPercent).toBe(40);
  });
});
