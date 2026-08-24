import { describe, expect, it } from "vitest";
import {
  calculateAdvancedAnalytics,
  type AssetDailyReturnDetail,
  type PortfolioReturnDetail,
} from "./advanced-metrics.js";
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

  it("서로 다른 관측일을 가진 자산의 공분산·상관을 같은 교집합 표본으로 재사용한다", () => {
    const asset = (key: string, value: number, contribution: number): AssetDailyReturnDetail => ({
      key,
      totalReturn: value,
      localReturn: value,
      fxReturn: 0,
      contribution,
      localContribution: contribution,
      fxContribution: 0,
    });
    const daily: PortfolioReturnDetail["daily"] = [
      { date: "2026-01-02", value: 0.011, assets: [asset("KRX:A", 0.01, 0.005), asset("KRX:B", 0.02, 0.006)] },
      { date: "2026-01-03", value: 0.007, assets: [asset("KRX:A", 0.02, 0.01), asset("KRX:C", -0.02, -0.003)] },
      { date: "2026-01-04", value: 0.0285, assets: [asset("KRX:A", 0.03, 0.015), asset("KRX:B", 0.06, 0.018), asset("KRX:C", -0.03, -0.0045)] },
      { date: "2026-01-05", value: 0.038, assets: [asset("KRX:A", 0.04, 0.02), asset("KRX:B", 0.08, 0.024), asset("KRX:C", -0.04, -0.006)] },
    ];
    const detail: PortfolioReturnDetail = {
      returns: daily.map(({ date, value }) => ({ date, value })),
      daily,
      expectedReturnObservations: daily.length,
      requiredPriceObservations: 16,
      missingPriceObservations: 5,
      requiredFxObservations: 0,
      missingFxObservations: 0,
    };
    const weights = { "KRX:A": 50, "KRX:B": 30, "KRX:C": 15, "KRX:D": 5 };
    const history: PortfolioHistory = {
      accountId: "account",
      currency: "KRW",
      range: "all",
      generatedAt: "2026-01-05",
      series: Object.keys(weights).map((key) => ({
        key,
        symbol: key.slice(4),
        name: key.slice(4),
        market: "KRX",
        currency: "KRW",
        averageWeight: weights[key as keyof typeof weights],
      })),
      points: [
        { date: "2026-01-01", capturedAt: "2026-01-01", totalValue: 100, values: weights },
        { date: "2026-01-05", capturedAt: "2026-01-05", totalValue: 104, values: weights },
      ],
    };

    const result = calculateAdvancedAnalytics({
      detail,
      history,
      candles: [],
      benchmarks: [],
      orders: [],
      datedOrders: [],
      fromDate: "2026-01-01",
      toDate: "2026-01-05",
      riskFreeRatePercent: 0,
      totalBuyAmount: 0,
      totalSellAmount: 0,
      commission: 0,
      tax: 0,
      averageValue: 100,
      estimatedReturnPercent: 0,
      convertAmount: (value) => value,
    });

    expect(result.correlations.values).toEqual([
      [1, 1, -1, null],
      [1, 1, -1, null],
      [-1, -1, 1, null],
      [null, null, null, 1],
    ]);
    expect(result.riskContributions.find((item) => item.key === "KRX:D")).toMatchObject({
      annualizedVolatilityPercent: null,
      riskContributionPercent: 0,
      correlationToPortfolio: null,
    });
  });
});
