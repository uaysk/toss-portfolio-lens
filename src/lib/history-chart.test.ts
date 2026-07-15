import { describe, expect, it } from "vitest";
import { buildValueChartData, filterPortfolioHistory } from "./history-chart";
import type { PortfolioHistory } from "@/types";

describe("buildValueChartData", () => {
  it("종목 비중을 평가금으로 변환해 스택 합계가 전체 평가금이 되게 한다", () => {
    const history: PortfolioHistory = {
      accountId: "account-1",
      currency: "KRW",
      range: "30d",
      generatedAt: "2026-07-15T00:00:00.000Z",
      series: [
        { key: "KRX:AAA", symbol: "AAA", name: "에이", market: "KRX", averageWeight: 60 },
        { key: "KRX:BBB", symbol: "BBB", name: "비", market: "KRX", averageWeight: 40 },
      ],
      points: [{
        date: "2026-07-15",
        capturedAt: "2026-07-15T00:00:00.000Z",
        totalValue: 2_000_000,
        values: { "KRX:AAA": 60, "KRX:BBB": 40 },
      }],
    };

    const [point] = buildValueChartData(history);
    expect(point.series0).toBe(1_200_000);
    expect(point.series1).toBe(800_000);
    expect(Number(point.series0) + Number(point.series1)).toBe(point.totalValue);
  });

  it("숨긴 종목을 제거하고 남은 종목의 평가금과 비중을 다시 계산한다", () => {
    const history: PortfolioHistory = {
      accountId: "account-1",
      currency: "KRW",
      range: "30d",
      generatedAt: "2026-07-15T00:00:00.000Z",
      series: [
        { key: "KRX:AAA", symbol: "AAA", name: "에이", market: "KRX", averageWeight: 60 },
        { key: "KRX:BBB", symbol: "BBB", name: "비", market: "KRX", averageWeight: 40 },
      ],
      points: [{
        date: "2026-07-15",
        capturedAt: "2026-07-15T00:00:00.000Z",
        totalValue: 2_000_000,
        values: { "KRX:AAA": 60, "KRX:BBB": 40 },
      }],
    };

    const filtered = filterPortfolioHistory(history, new Set(["KRX:AAA"]));
    expect(filtered.series).toEqual([
      { key: "KRX:BBB", symbol: "BBB", name: "비", market: "KRX", averageWeight: 100 },
    ]);
    expect(filtered.points[0]).toMatchObject({
      totalValue: 800_000,
      values: { "KRX:BBB": 100 },
    });
    expect(buildValueChartData(filtered)[0].series0).toBe(800_000);
  });
});
