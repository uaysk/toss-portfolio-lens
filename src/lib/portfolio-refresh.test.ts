import { describe, expect, it } from "vitest";
import {
  PORTFOLIO_FALLBACK_INITIAL_MS,
  PORTFOLIO_FALLBACK_MAX_MS,
  PORTFOLIO_REFRESH_INTERVAL_MS,
  nextPortfolioFallbackDelay,
  portfolioRequestUrl,
  shouldRefreshPortfolioInBackground,
} from "./portfolio-refresh";

describe("portfolio auto refresh", () => {
  it("1초 주기와 일반/강제 갱신 URL을 제공한다", () => {
    expect(PORTFOLIO_REFRESH_INTERVAL_MS).toBe(1_000);
    expect(portfolioRequestUrl("account-1")).toBe("/api/portfolio?account=account-1");
    expect(portfolioRequestUrl("account-1", true)).toBe("/api/portfolio?account=account-1&refresh=1");
    expect(portfolioRequestUrl("account-1", false, false))
      .toBe("/api/portfolio?account=account-1&snapshot=0");
  });

  it("문서가 hidden이면 background polling을 건너뛴다", () => {
    expect(shouldRefreshPortfolioInBackground("visible")).toBe(true);
    expect(shouldRefreshPortfolioInBackground("hidden")).toBe(false);
  });

  it("SSE fallback polling을 5초에서 30초까지 제한한다", () => {
    expect(PORTFOLIO_FALLBACK_INITIAL_MS).toBe(5_000);
    expect(nextPortfolioFallbackDelay(5_000)).toBe(10_000);
    expect(nextPortfolioFallbackDelay(20_000)).toBe(PORTFOLIO_FALLBACK_MAX_MS);
    expect(nextPortfolioFallbackDelay(30_000)).toBe(PORTFOLIO_FALLBACK_MAX_MS);
  });
});
