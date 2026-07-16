import { describe, expect, it } from "vitest";
import { analysisComparisonDomain, analysisPeriodChange, buildAnalysisChartData } from "@/lib/analysis-chart";
import type { PortfolioAnalysis } from "@/types";

describe("analysis chart data", () => {
  it("포트폴리오 OHLC와 비교 지수를 시작점 대비 수익률로 정렬한다", () => {
    const analysis: PortfolioAnalysis = {
      accountId: "account-1",
      currency: "KRW",
      baseCurrency: "KRW",
      includesCurrencies: ["KRW", "USD"],
      range: "30d",
      generatedAt: "2026-07-15T00:00:00.000Z",
      fromDate: "2026-07-01",
      toDate: "2026-07-03",
      estimatedOhlc: true,
      ohlcBackfillComplete: true,
      fxBackfillComplete: true,
      candles: [
        { date: "2026-07-01", open: 100, high: 112, low: 95, close: 110 },
        { date: "2026-07-03", open: 110, high: 125, low: 108, close: 120 },
      ],
      benchmarks: [
        {
          key: "KOSPI",
          name: "KOSPI",
          baseCurrency: "KRW",
          currencyAdjusted: false,
          points: [
            { date: "2026-07-01", close: 1000 },
            { date: "2026-07-02", close: 1050 },
          ],
        },
        {
          key: "NASDAQ100",
          name: "나스닥 100",
          baseCurrency: "KRW",
          currencyAdjusted: true,
          points: [{ date: "2026-07-02", close: 500 }],
        },
      ],
      benchmarkErrors: [],
      metrics: {
        valuationChangePercent: 20,
        estimatedReturnPercent: 20,
        timeWeightedReturnPercent: 20,
        moneyWeightedReturnPercent: 20,
        annualizedReturnPercent: 20,
        annualizedVolatilityPercent: 10,
        maxDrawdownPercent: -5,
        currentDrawdownPercent: 0,
        maxDrawdownDays: 1,
        sharpeRatio: 1,
        sortinoRatio: 1,
        calmarRatio: 1,
        top3WeightPercent: 100,
        hhi: 1,
        effectivePositions: 1,
        benchmarkReturns: { KOSPI: 5 },
        excessReturns: { KOSPI: 15 },
        totalBuyAmount: 0,
        totalSellAmount: 0,
        netInvestedAmount: 100,
        estimatedProfitLoss: 20,
        commission: 0,
        tax: 0,
        turnoverPercent: 0,
        tradeCount: 0,
        riskFreeRatePercent: 0,
        bestDailyReturnPercent: 2,
        worstDailyReturnPercent: -1,
        positiveDaysPercent: 50,
      },
      contributions: [],
      benchmarkComparisons: [],
      rolling: [],
      drawdowns: {
        points: [], episodes: [], currentUnderwaterDays: 0, averageDrawdownPercent: null,
        ulcerIndex: null, worst20DayReturnPercent: null, worst60DayReturnPercent: null,
      },
      tailRisk: {
        historicalVar95Percent: null, expectedShortfall95Percent: null, lossDaysPercent: null,
        averageGainPercent: null, averageLossPercent: null, gainLossRatio: null, skewness: null,
        excessKurtosis: null, maxConsecutiveGainDays: 0, maxConsecutiveLossDays: 0,
      },
      monthlyReturns: [],
      attributionByKey: {},
      riskContributions: [],
      correlations: { assets: [], values: [] },
      exposure: {
        krwWeightPercent: 100, usdWeightPercent: 0, domesticWeightPercent: 100, overseasWeightPercent: 0,
        top1WeightPercent: 100, top5WeightPercent: 100, top10WeightPercent: 100, diversificationBenefitPercent: null,
      },
      costEfficiency: {
        costDragPercent: null, grossEstimatedReturnPercent: null, costPerTradedAmountBps: null,
        averageTradeAmount: null, buySellAmountRatio: null, monthly: [],
      },
      tradeBehavior: {
        estimatedRealizedProfitLoss: 0, estimatedWinRatePercent: null, estimatedProfitFactor: null,
        estimatedAverageHoldingDays: null, matchedSellCount: 0, unmatchedSellCount: 0,
      },
      dataQuality: {
        confidence: "high", historyDays: 2, returnObservationDays: 1, expectedReturnObservationDays: 1, returnCoveragePercent: 100,
        requiredPriceObservations: 1, missingPriceObservations: 0, priceCoveragePercent: 100,
        requiredFxObservations: 0, missingFxObservations: 0, fxCoveragePercent: 100,
        liveSnapshotDays: 2, reconstructedSnapshotDays: 0, backfillStatus: "complete", failedSymbols: 0, notes: [],
      },
    };

    const points = buildAnalysisChartData(analysis);
    expect(points[0]).toMatchObject({
      normalizedClose: 0,
      candleRange: [-13.6364, 1.8182],
      benchmarkValues: { KOSPI: 0, NASDAQ100: 0 },
    });
    expect(points[1]).toMatchObject({
      normalizedClose: 9.0909,
      benchmarkValues: { KOSPI: 5, NASDAQ100: 0 },
    });
    expect(analysisPeriodChange(points)).toBe(20);
    const domain = analysisComparisonDomain(points, new Set(["KOSPI", "NASDAQ100"]));
    expect(domain[0]).toBeLessThan(points[0].normalizedLow);
    expect(domain[1]).toBeGreaterThan(points[1].normalizedHigh);
  });
});
