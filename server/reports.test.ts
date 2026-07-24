import { describe, expect, it, vi } from "vitest";
import type { PortfolioAnalysis } from "./analysis.js";
import type { ReportNarrative } from "./report-ai.js";
import type { ReportStorage } from "./report-storage.js";
import { analysisEvaluationInput, backtestEvaluationInput, PortfolioReportService } from "./reports.js";

const narrative: ReportNarrative = {
  score: 70,
  stance: "balanced",
  summary: "성과와 위험이 균형을 보이지만 데이터의 추정 한계를 함께 확인해야 합니다.",
  strengths: ["누적 성과가 양수입니다.", "낙폭이 제한적입니다.", "시장 비교가 포함됐습니다."],
  risks: ["집중도를 점검해야 합니다.", "입출금 정보가 없습니다.", "일부 수치가 추정값입니다."],
  actions: ["집중도를 정기 점검하세요.", "기간을 바꿔 비교하세요.", "실제 명세와 함께 확인하세요."],
  methodology: "제공된 포트폴리오 수치와 데이터 품질 정보만 사용했습니다.",
};

function analysisFixture(): PortfolioAnalysis {
  return {
    accountId: "private-account-id",
    currency: "KRW",
    baseCurrency: "KRW",
    includesCurrencies: ["KRW", "USD"],
    range: "30d",
    generatedAt: "2026-07-16T00:00:00.000Z",
    fromDate: "2026-06-17",
    toDate: "2026-07-16",
    estimatedOhlc: true,
    ohlcBackfillComplete: true,
    fxBackfillComplete: true,
    candles: [
      { date: "2026-06-17", open: 100, high: 101, low: 99, close: 100 },
      { date: "2026-07-16", open: 109, high: 111, low: 108, close: 110 },
    ],
    benchmarks: [],
    benchmarkErrors: [],
    metrics: {
      valuationChangePercent: 10,
      estimatedReturnPercent: 10,
      timeWeightedReturnPercent: 9,
      moneyWeightedReturnPercent: 8,
      annualizedReturnPercent: 20,
      annualizedVolatilityPercent: 15,
      maxDrawdownPercent: -5,
      currentDrawdownPercent: -1,
      maxDrawdownDays: 4,
      sharpeRatio: 1.2,
      sortinoRatio: 1.7,
      calmarRatio: 4,
      top3WeightPercent: 75,
      hhi: 0.3,
      effectivePositions: 3.33,
      benchmarkReturns: {},
      excessReturns: {},
      totalBuyAmount: 100,
      totalSellAmount: 20,
      commission: 1,
      tax: 1,
      turnoverPercent: 30,
      tradeCount: 3,
      netInvestedAmount: 80,
      estimatedProfitLoss: 10,
      bestDailyReturnPercent: 3,
      worstDailyReturnPercent: -2,
      positiveDaysPercent: 60,
      riskFreeRatePercent: 0,
    },
    contributions: [],
    benchmarkComparisons: [],
    rolling: [],
    drawdowns: {
      points: [],
      episodes: [],
      currentUnderwaterDays: 0,
      averageDrawdownPercent: null,
      ulcerIndex: null,
      worst20DayReturnPercent: null,
      worst60DayReturnPercent: null,
    },
    tailRisk: {
      historicalVar95Percent: null,
      expectedShortfall95Percent: null,
      lossDaysPercent: null,
      averageGainPercent: null,
      averageLossPercent: null,
      gainLossRatio: null,
      skewness: null,
      excessKurtosis: null,
      maxConsecutiveGainDays: 0,
      maxConsecutiveLossDays: 0,
    },
    monthlyReturns: [],
    attributionByKey: {},
    riskContributions: [],
    correlations: { assets: [], values: [] },
    exposure: {
      krwWeightPercent: 100,
      usdWeightPercent: 0,
      domesticWeightPercent: 100,
      overseasWeightPercent: 0,
      top1WeightPercent: 100,
      top5WeightPercent: 100,
      top10WeightPercent: 100,
      diversificationBenefitPercent: null,
    },
    costEfficiency: {
      costDragPercent: null,
      grossEstimatedReturnPercent: null,
      costPerTradedAmountBps: null,
      averageTradeAmount: null,
      buySellAmountRatio: null,
      monthly: [],
    },
    tradeBehavior: {
      estimatedRealizedProfitLoss: 0,
      estimatedWinRatePercent: null,
      estimatedProfitFactor: null,
      estimatedAverageHoldingDays: null,
      matchedSellCount: 0,
      unmatchedSellCount: 0,
    },
    dataQuality: {
      confidence: "high",
      historyDays: 30,
      returnObservationDays: 29,
      expectedReturnObservationDays: 29,
      returnCoveragePercent: 100,
      requiredPriceObservations: 2,
      missingPriceObservations: 0,
      priceCoveragePercent: 100,
      requiredFxObservations: 1,
      missingFxObservations: 0,
      fxCoveragePercent: 100,
      liveSnapshotDays: 2,
      reconstructedSnapshotDays: 0,
      backfillStatus: "complete",
      failedSymbols: 0,
      notes: [],
    },
  };
}

describe("portfolio reports", () => {
  it("LLM 입력에서 계좌 식별자를 제외하고 추정 한계를 명시한다", () => {
    const { accountId: _accountId, ...analysis } = analysisFixture();
    const input = JSON.stringify(analysisEvaluationInput(analysis));
    expect(input).not.toContain("private-account-id");
    expect(input).toContain("입출금");
  });

  it("포트폴리오 분석의 모든 고급 지표 범주와 상세 성과귀속을 LLM 입력에 포함한다", () => {
    const { accountId: _accountId, ...base } = analysisFixture();
    const analysis = {
      ...base,
      rolling: [{
        date: "2026-07-16", return20d: 20.123, return60d: 60.123, return120d: 120.123,
        return252d: 252.123, volatility60d: 15.123, sharpe60d: 1.123,
        benchmarkExcess60d: { KOSPI: 2.123 }, benchmarkBeta60d: { KOSPI: 0.923 },
        benchmarkCorrelation60d: { KOSPI: 0.823 },
      }],
      correlations: { assets: [{ key: "KRX:TEST", symbol: "TEST", name: "상관표식" }], values: [[1]] },
      contributions: [{
        key: "KRX:TEST", symbol: "TEST", name: "기여표식", market: "KRX", currency: "KRW" as const,
        estimatedProfitLoss: 100, contributionPercent: 1.1, timeLinkedContributionPercent: 2.222,
        localPriceContributionPercent: 3.333, fxContributionPercent: 4.444,
      }],
      attributionByKey: { "KRX:TEST": { timeLinkedContributionPercent: 2.222, localPriceContributionPercent: 3.333, fxContributionPercent: 4.444 } },
      riskContributions: [{ key: "KRX:TEST", symbol: "TEST", name: "위험표식", weightPercent: 100, annualizedVolatilityPercent: 15, riskContributionPercent: 100, correlationToPortfolio: 1 }],
    };
    const input = analysisEvaluationInput(analysis);
    expect(input).toMatchObject({
      rollingAnalytics: { latest: { return252d: 252.123 }, history: [{ benchmarkCorrelation60d: { KOSPI: 0.823 } }] },
      correlations: { assets: [{ name: "상관표식" }] },
      performanceContributions: [{ timeLinkedContributionPercent: 2.222, localPriceContributionPercent: 3.333, fxContributionPercent: 4.444 }],
      attributionByKey: { "KRX:TEST": { fxContributionPercent: 4.444 } },
      riskContributions: [{ name: "위험표식" }],
    });
  });

  it("백테스트의 설정·상관관계·고급 지표 전체를 LLM 입력에 포함한다", () => {
    const backtest = {
      generatedAt: "2026-07-16T00:00:00.000Z", effectiveStartDate: "2026-01-01", endDate: "2026-07-16", baseCurrency: "KRW",
      currencyMethod: "LOCAL_RETURN", config: { initialAmount: 1_000_000, transactionCostBps: 12.34, requestedStartDate: "2025-01-01" },
      assets: [{ symbol: "TEST", name: "자산표식", currentValueKrw: 123_456 }], benchmark: { key: "KOSPI", name: "KOSPI", symbol: "KOSPI" },
      metrics: { totalReturnPercent: 12.345 }, benchmarkMetrics: { totalReturnPercent: 6.789 }, annualReturns: [{ year: 2026, returnPercent: 12.345 }],
      contributions: [{ symbol: "TEST", timeLinkedContributionPercent: 9.876, fxContributionPercent: 1.234 }],
      correlations: { assets: [{ symbol: "TEST", name: "상관표식" }], values: [[1]] },
      advanced: { rolling: [{ date: "2026-07-16", return252d: 25.252 }], dataQuality: { confidence: "high" } },
      points: [{ date: "2026-01-01", growth: 100, benchmarkGrowth: 100, drawdownPercent: 0 }], warnings: ["경고표식"],
    } as unknown as Parameters<typeof backtestEvaluationInput>[0];
    const input = backtestEvaluationInput(backtest);
    expect(input).toMatchObject({
      assumptions: { transactionCostBps: 12.34, requestedStartDate: "2025-01-01", currencyMethod: "LOCAL_RETURN" },
      assets: [{ name: "자산표식", currentValueKrw: 123_456 }],
      correlations: { assets: [{ name: "상관표식" }] },
      performanceContributions: [{ timeLinkedContributionPercent: 9.876, fxContributionPercent: 1.234 }],
      advancedAnalytics: { rolling: [{ return252d: 25.252 }], dataQuality: { confidence: "high" } },
    });
  });

  it("생성된 공개 보고서에서 계좌 식별자를 제거한다", async () => {
    let stored: unknown;
    const storage: ReportStorage = {
      backend: "local",
      put: vi.fn(async (_id, document) => { stored = document; }),
      get: vi.fn(async () => stored),
    };
    const writer = { evaluate: vi.fn(async () => narrative) };
    const service = new PortfolioReportService(storage, "https://tpl.uaysk.com", writer);
    const report = await service.createAnalysis(analysisFixture());
    expect(report.data).not.toHaveProperty("accountId");
    expect(service.publicUrl(report.id)).toBe(`https://tpl.uaysk.com/reports/${report.id}`);
    await expect(service.get(report.id)).resolves.toMatchObject({ id: report.id, kind: "analysis" });
  });
});
