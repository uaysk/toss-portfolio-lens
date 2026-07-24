import { describe, expect, it } from "vitest";
import {
  PORTFOLIO_REFRESH_INTERVAL_MS,
  portfolioRequestUrl,
  shouldRefreshPortfolioInBackground,
} from "./portfolio-refresh";

describe("portfolio auto refresh", () => {
  it("5초 주기와 일반/강제 갱신 URL을 제공한다", () => {
    expect(PORTFOLIO_REFRESH_INTERVAL_MS).toBe(5_000);
    expect(portfolioRequestUrl("account-1")).toBe("/api/portfolio?account=account-1");
    expect(portfolioRequestUrl("account-1", true)).toBe("/api/portfolio?account=account-1&refresh=1");
    expect(portfolioRequestUrl("account-1", false, false))
      .toBe("/api/portfolio?account=account-1&snapshot=0");
  });

  it("문서가 hidden이면 background polling을 건너뛴다", () => {
    expect(shouldRefreshPortfolioInBackground("visible")).toBe(true);
    expect(shouldRefreshPortfolioInBackground("hidden")).toBe(false);
  });
});
