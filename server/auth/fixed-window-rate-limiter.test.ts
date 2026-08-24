import { describe, expect, it } from "vitest";
import { BoundedFixedWindowRateLimiter } from "./fixed-window-rate-limiter";

describe("BoundedFixedWindowRateLimiter", () => {
  it("limits requests per source and resets the fixed window", () => {
    let now = 1_000;
    const limiter = new BoundedFixedWindowRateLimiter({
      maximumRequests: 2,
      windowMs: 10_000,
      maximumEntries: 4,
      now: () => now,
    });

    expect(limiter.check("one")).toEqual({ allowed: true });
    expect(limiter.check("one")).toEqual({ allowed: true });
    expect(limiter.check("one")).toEqual({
      allowed: false,
      reason: "request-limit",
      retryAfterSeconds: 10,
    });
    now += 10_000;
    expect(limiter.check("one")).toEqual({ allowed: true });
  });

  it("keeps the source map bounded and reuses expired capacity", () => {
    let now = 1_000;
    const limiter = new BoundedFixedWindowRateLimiter({
      maximumRequests: 10,
      windowMs: 5_000,
      maximumEntries: 2,
      cleanupBatchSize: 1,
      now: () => now,
    });

    expect(limiter.check("one")).toEqual({ allowed: true });
    expect(limiter.check("two")).toEqual({ allowed: true });
    expect(limiter.check("three")).toEqual({
      allowed: false,
      reason: "source-capacity",
      retryAfterSeconds: 5,
    });
    expect(limiter.size).toBe(2);

    now += 5_000;
    expect(limiter.check("three")).toEqual({ allowed: true });
    expect(limiter.size).toBeLessThanOrEqual(2);
  });

  it("rejects invalid capacity configuration", () => {
    expect(() => new BoundedFixedWindowRateLimiter({
      maximumRequests: 0,
      windowMs: 1,
      maximumEntries: 1,
    })).toThrow("configuration");
  });
});
