import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AuthenticationError,
  NotFoundError,
  ProviderUnavailableError,
  RateLimitError,
  ValidationError,
  mapScalpingError,
} from "./domain-errors.js";

describe("mapScalpingError", () => {
  it.each([
    [new ValidationError(), 400, "invalid-scalping-request"],
    [new AuthenticationError(), 401, "scalping-authentication-required"],
    [new AuthenticationError("권한이 없습니다.", { forbidden: true }), 403, "scalping-forbidden"],
    [new NotFoundError(), 404, "scalping-resource-not-found"],
    [new ProviderUnavailableError(), 503, "scalping-provider-unavailable"],
    [new ProviderUnavailableError("상위 제공자 응답이 올바르지 않습니다.", { badGateway: true }), 502, "scalping-provider-unavailable"],
  ])("maps a typed error without inspecting its message", (error, status, code) => {
    const mapped = mapScalpingError(error);
    expect(mapped.status).toBe(status);
    expect(mapped.body.error.code).toBe(code);
  });

  it("maps Zod validation failures to a sanitized 400 response", () => {
    const failure = z.object({ symbols: z.array(z.string()).min(1) }).safeParse({ symbols: [] });
    if (failure.success) throw new Error("expected validation failure");

    const mapped = mapScalpingError(failure.error);
    expect(mapped.status).toBe(400);
    expect(mapped.body.error).toMatchObject({
      code: "invalid-scalping-request",
      message: "단타 보조 요청 값을 확인해 주세요.",
    });
    expect(mapped.body.error.issues).toEqual([
      expect.objectContaining({ path: ["symbols"] }),
    ]);
  });

  it("preserves Retry-After for typed rate limits", () => {
    const mapped = mapScalpingError(new RateLimitError(17));
    expect(mapped.status).toBe(429);
    expect(mapped.headers).toEqual({ "Retry-After": "17" });
  });

  it("does not expose unexpected provider or internal messages", () => {
    const privateDetail = "upstream failed with a private provider detail";
    const mapped = mapScalpingError(new Error(privateDetail));
    expect(mapped.status).toBe(503);
    expect(JSON.stringify(mapped.body)).not.toContain(privateDetail);
    expect(mapped.body.error).toEqual({
      code: "scalping-unavailable",
      message: "단타 보조 데이터를 처리하지 못했습니다.",
    });
  });
});
