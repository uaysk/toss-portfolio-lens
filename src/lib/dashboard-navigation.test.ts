import { describe, expect, it } from "vitest";
import { dashboardHash, dashboardViewFromHash } from "./dashboard-navigation";

describe("dashboard navigation", () => {
  it.each([
    ["overview", "#overview"],
    ["analysis", "#analysis"],
    ["technical", "#technical-analysis"],
    ["backtest", "#backtest"],
    ["optimization", "#optimization"],
    ["library", "#library"],
  ] as const)("%s 화면과 hash를 왕복한다", (view, hash) => {
    expect(dashboardHash(view)).toBe(hash);
    expect(dashboardViewFromHash(hash)).toBe(view);
  });

  it("알 수 없는 hash는 포트폴리오 화면으로 되돌린다", () => {
    expect(dashboardViewFromHash("#unknown")).toBe("overview");
  });
});
