import { describe, expect, it } from "vitest";
import { analysisPeriodChange, buildAnalysisChartData } from "@/lib/analysis-chart";
import type { PortfolioAnalysis } from "@/types";

describe("analysis chart data", () => {
  it("포트폴리오 OHLC와 비교 지수를 시작점 대비 수익률로 정렬한다", () => {
    const analysis: PortfolioAnalysis = {
      accountId: "account-1",
      currency: "KRW",
      range: "30d",
      generatedAt: "2026-07-15T00:00:00.000Z",
      fromDate: "2026-07-01",
      toDate: "2026-07-03",
      estimatedOhlc: true,
      ohlcBackfillComplete: true,
      candles: [
        { date: "2026-07-01", open: 100, high: 112, low: 95, close: 110 },
        { date: "2026-07-03", open: 110, high: 125, low: 108, close: 120 },
      ],
      benchmarks: [{
        key: "KOSPI",
        name: "KOSPI",
        points: [
          { date: "2026-07-01", close: 1000 },
          { date: "2026-07-02", close: 1050 },
        ],
      }],
      benchmarkErrors: [],
    };

    const points = buildAnalysisChartData(analysis);
    expect(points[0]).toMatchObject({ candleRange: [95, 112], benchmarkValues: { KOSPI: 0 } });
    expect(points[1]).toMatchObject({ benchmarkValues: { KOSPI: 5 } });
    expect(analysisPeriodChange(points)).toBe(20);
  });
});
