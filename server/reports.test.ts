import { describe, expect, it, vi } from "vitest";
import type { PortfolioAnalysis } from "./analysis.js";
import type { ReportNarrative } from "./report-ai.js";
import type { ReportStorage } from "./report-storage.js";
import { analysisEvaluationInput, PortfolioReportService } from "./reports.js";

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
  };
}

describe("portfolio reports", () => {
  it("LLM 입력에서 계좌 식별자를 제외하고 추정 한계를 명시한다", () => {
    const { accountId: _accountId, ...analysis } = analysisFixture();
    const input = JSON.stringify(analysisEvaluationInput(analysis));
    expect(input).not.toContain("private-account-id");
    expect(input).toContain("입출금");
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
