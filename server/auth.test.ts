import { describe, expect, it } from "vitest";
import {
  hasValidReadOnlyApiSecret,
  passwordsMatch,
} from "./auth.js";

describe("read-only compatible API authentication", () => {
  it("DASHBOARD_PASSWORD 자체를 Bearer 토큰으로 허용한다", () => {
    const dashboardPassword = "dashboard-password";
    expect(hasValidReadOnlyApiSecret(`Bearer ${dashboardPassword}`, dashboardPassword)).toBe(true);
    expect(hasValidReadOnlyApiSecret("Bearer wrong", dashboardPassword)).toBe(false);
    expect(hasValidReadOnlyApiSecret(dashboardPassword, dashboardPassword)).toBe(false);
  });

  it("API 비밀값 비교에도 일정 시간 비교 함수를 사용할 수 있다", () => {
    expect(passwordsMatch("dashboard-password", "dashboard-password")).toBe(true);
    expect(passwordsMatch("wrong", "dashboard-password")).toBe(false);
  });
});
