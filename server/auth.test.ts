import { describe, expect, it } from "vitest";
import type { Request } from "express";
import {
  clearSessionCookie,
  createSessionCookie,
  hasValidReadOnlyApiSecret,
  passwordsMatch,
} from "./auth.js";

describe("read-only compatible API authentication", () => {
  it("별도 읽기 전용 secret만 올바른 Bearer 토큰으로 허용한다", () => {
    const readOnlyApiToken = "dedicated-read-only-token";
    expect(hasValidReadOnlyApiSecret(`Bearer ${readOnlyApiToken}`, readOnlyApiToken)).toBe(true);
    expect(hasValidReadOnlyApiSecret("Bearer dashboard-password", readOnlyApiToken)).toBe(false);
    expect(hasValidReadOnlyApiSecret("Bearer wrong", readOnlyApiToken)).toBe(false);
    expect(hasValidReadOnlyApiSecret(readOnlyApiToken, readOnlyApiToken)).toBe(false);
    expect(hasValidReadOnlyApiSecret(undefined, readOnlyApiToken)).toBe(false);
  });

  it("API 비밀값 비교에도 일정 시간 비교 함수를 사용할 수 있다", () => {
    expect(passwordsMatch("dashboard-password", "dashboard-password")).toBe(true);
    expect(passwordsMatch("wrong", "dashboard-password")).toBe(false);
  });

  it("신뢰되지 않은 프록시 헤더 대신 외부 URL 정책으로 Secure 쿠키를 결정한다", () => {
    const request = {
      secure: false,
      get: (name: string) => name.toLowerCase() === "x-forwarded-proto" ? "https" : undefined,
    } as Request;

    expect(createSessionCookie(request, "session-secret")).not.toContain("; Secure");
    expect(createSessionCookie(request, "session-secret", true)).toContain("; Secure");
    expect(clearSessionCookie(request, true)).toContain("; Secure");
  });
});
