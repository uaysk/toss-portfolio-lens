import { describe, expect, it } from "vitest";
import {
  LoginAttemptLimiter,
  normalizeClientIp,
} from "./login-attempt-limiter.js";

describe("LoginAttemptLimiter", () => {
  it("blocks after the configured failures and resets at the end of the window", () => {
    let now = 10_000;
    const limiter = new LoginAttemptLimiter({
      maximumAttempts: 2,
      windowMs: 5_000,
      maximumEntries: 10,
      now: () => now,
    });

    expect(limiter.check("127.0.0.1")).toEqual({ allowed: true });
    limiter.recordFailure("127.0.0.1");
    limiter.recordFailure("127.0.0.1");
    expect(limiter.check("127.0.0.1")).toEqual({
      allowed: false,
      retryAfterSeconds: 5,
    });

    now = 14_001;
    expect(limiter.check("127.0.0.1")).toEqual({
      allowed: false,
      retryAfterSeconds: 1,
    });
    now = 15_000;
    expect(limiter.check("127.0.0.1")).toEqual({ allowed: true });
    expect(limiter.size).toBe(0);
  });

  it("clears the key after a successful login", () => {
    const limiter = new LoginAttemptLimiter({
      maximumAttempts: 1,
      windowMs: 60_000,
      maximumEntries: 10,
      now: () => 0,
    });
    limiter.recordFailure("2001:db8::1");
    expect(limiter.check("2001:db8::1").allowed).toBe(false);
    limiter.reset("2001:db8::1");
    expect(limiter.check("2001:db8::1")).toEqual({ allowed: true });
  });

  it("never grows beyond the configured maximum under unique-IP traffic", () => {
    const limiter = new LoginAttemptLimiter({
      maximumAttempts: 5,
      windowMs: 60_000,
      maximumEntries: 3,
      now: () => 0,
    });
    for (let index = 0; index < 1_000; index += 1) {
      limiter.recordFailure(`client-${index}`);
      expect(limiter.size).toBeLessThanOrEqual(3);
    }
    expect(limiter.size).toBe(3);
  });

  it("normalizes IPv4, IPv4-mapped IPv6 and equivalent IPv6 spellings", () => {
    expect(normalizeClientIp("127.0.0.1")).toBe("127.0.0.1");
    expect(normalizeClientIp("::ffff:127.0.0.1")).toBe("127.0.0.1");
    expect(normalizeClientIp("2001:0db8:0:0:0:0:0:1")).toBe("2001:db8::1");
    expect(normalizeClientIp("[2001:db8::1]")).toBe("2001:db8::1");
    expect(normalizeClientIp("not-an-ip")).toBe("unknown");
    expect(normalizeClientIp(undefined)).toBe("unknown");
  });
});
