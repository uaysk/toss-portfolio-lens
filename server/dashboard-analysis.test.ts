import { describe, expect, it } from "vitest";
import { dashboardAnalysisError, isDashboardAnalysisOperation, parseDashboardRunId } from "./dashboard-analysis.js";
import { BacktestValidationError } from "./backtest-engine.js";
import { TossApiError } from "./toss.js";

describe("dashboard advanced analysis contract", () => {
  it("고정된 Rust 분석 작업만 허용한다", () => {
    expect(isDashboardAnalysisOperation("monte-carlo")).toBe(true);
    expect(isDashboardAnalysisOperation("compare-backtests")).toBe(true);
    expect(isDashboardAnalysisOperation("rebalance-plan")).toBe(true);
    expect(isDashboardAnalysisOperation("market-regimes")).toBe(true);
    expect(isDashboardAnalysisOperation("get_report")).toBe(false);
  });

  it("run id는 UUID만 허용하고 구조화된 400 오류로 바꾼다", () => {
    let caught: unknown;
    try { parseDashboardRunId("not-a-run-id"); } catch (error) { caught = error; }
    expect(dashboardAnalysisError(caught)).toMatchObject({
      status: 400,
      body: { error: { code: "invalid-analysis-request" } },
    });
  });

  it("도메인 검증과 upstream 오류를 generic 500으로 숨기지 않는다", () => {
    expect(dashboardAnalysisError(new BacktestValidationError("종목 데이터가 없습니다."))).toMatchObject({
      status: 400,
      body: { error: { code: "invalid-backtest", message: "종목 데이터가 없습니다." } },
    });
    expect(dashboardAnalysisError(new TossApiError("요청이 너무 많습니다.", 429, "RATE_LIMIT"))).toMatchObject({
      status: 429,
      body: { error: { code: "RATE_LIMIT", retryable: true } },
    });
  });
});
