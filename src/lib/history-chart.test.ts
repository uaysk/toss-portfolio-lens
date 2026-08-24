import { describe, expect, it } from "vitest";
import {
  buildValueChartData,
  filterPortfolioHistory,
  HISTORY_BACKFILL_IDLE_POLL_MS,
  HISTORY_BACKFILL_MAX_RETRY_MS,
  HISTORY_BACKFILL_RUNNING_POLL_MS,
  portfolioHistoryBackfillPollDelay,
  portfolioHistoryBackfillRetryDelay,
  shouldPollPortfolioHistoryBackfill,
} from "./history-chart";
import type { PortfolioHistory } from "@/types";

describe("buildValueChartData", () => {
  it.each([
    ["idle", true],
    ["running", true],
    ["complete", false],
    ["partial", false],
    ["error", false],
  ] as const)("backfill %s 상태의 polling 여부를 고정한다", (status, expected) => {
    expect(shouldPollPortfolioHistoryBackfill(status)).toBe(expected);
  });

  it("브라우저 탭이 숨겨지면 진행 중인 backfill polling을 멈춘다", () => {
    expect(shouldPollPortfolioHistoryBackfill("running", "hidden")).toBe(false);
    expect(shouldPollPortfolioHistoryBackfill("idle", "hidden")).toBe(false);
    expect(shouldPollPortfolioHistoryBackfill("running", "visible")).toBe(true);
  });

  it("진행 중 상태는 2초, 유휴 상태는 5초 간격으로 조회한다", () => {
    expect(portfolioHistoryBackfillPollDelay("running")).toBe(HISTORY_BACKFILL_RUNNING_POLL_MS);
    expect(portfolioHistoryBackfillPollDelay("idle")).toBe(HISTORY_BACKFILL_IDLE_POLL_MS);
    expect(portfolioHistoryBackfillPollDelay("complete")).toBeUndefined();
    expect(portfolioHistoryBackfillPollDelay("partial")).toBeUndefined();
    expect(portfolioHistoryBackfillPollDelay("error")).toBeUndefined();
  });

  it("상태 조회 실패는 5초부터 지수 backoff하고 30초로 제한한다", () => {
    expect(portfolioHistoryBackfillRetryDelay(1)).toBe(HISTORY_BACKFILL_IDLE_POLL_MS);
    expect(portfolioHistoryBackfillRetryDelay(2)).toBe(10_000);
    expect(portfolioHistoryBackfillRetryDelay(3)).toBe(20_000);
    expect(portfolioHistoryBackfillRetryDelay(4)).toBe(HISTORY_BACKFILL_MAX_RETRY_MS);
    expect(portfolioHistoryBackfillRetryDelay(20)).toBe(HISTORY_BACKFILL_MAX_RETRY_MS);
  });

  it("종목 비중을 평가금으로 변환해 스택 합계가 전체 평가금이 되게 한다", () => {
    const history: PortfolioHistory = {
      accountId: "account-1",
      currency: "KRW",
      range: "30d",
      generatedAt: "2026-07-15T00:00:00.000Z",
      series: [
        { key: "KRX:AAA", symbol: "AAA", name: "에이", market: "KRX", currency: "KRW", averageWeight: 60 },
        { key: "KRX:BBB", symbol: "BBB", name: "비", market: "KRX", currency: "KRW", averageWeight: 40 },
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
        { key: "KRX:AAA", symbol: "AAA", name: "에이", market: "KRX", currency: "KRW", averageWeight: 60 },
        { key: "KRX:BBB", symbol: "BBB", name: "비", market: "KRX", currency: "KRW", averageWeight: 40 },
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
      { key: "KRX:BBB", symbol: "BBB", name: "비", market: "KRX", currency: "KRW", averageWeight: 100 },
    ]);
    expect(filtered.points[0]).toMatchObject({
      totalValue: 800_000,
      values: { "KRX:BBB": 100 },
    });
    expect(buildValueChartData(filtered)[0].series0).toBe(800_000);
  });
});
