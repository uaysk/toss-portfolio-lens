import { describe, expect, it, vi } from "vitest";
import {
  AdaptiveRateLimiter,
  ProviderRequestError,
  TtlCache,
  retryWithBackoff,
  retryAfterMilliseconds,
} from "./rate-limiter.js";

describe("AdaptiveRateLimiter", () => {
  it("paces queued calls and adapts to provider remaining/reset headers", async () => {
    let now = 1_000;
    const sleep = vi.fn(async (milliseconds: number) => {
      now += milliseconds;
    });
    const limiter = new AdaptiveRateLimiter({
      initialIntervalMs: 100,
      minimumIntervalMs: 20,
      maximumIntervalMs: 2_000,
      maximumHeaderDelayMs: 10_000,
      now: () => now,
      sleep,
    });

    await limiter.acquire();
    limiter.observe({
      "X-RateLimit-Limit": "10",
      "X-RateLimit-Remaining": "2",
      "X-RateLimit-Reset": "1",
    });
    expect(limiter.snapshot()).toMatchObject({
      intervalMs: 500,
      observedLimit: 10,
      observedRemaining: 2,
      observedResetAt: 2_000,
    });
    await limiter.acquire();
    await limiter.acquire();
    expect(sleep.mock.calls.map(([value]) => value)).toEqual([100, 500]);
  });

  it("blocks on exhausted quota and Retry-After without exceeding configured cap", async () => {
    let now = 5_000;
    const sleep = vi.fn(async (milliseconds: number) => {
      now += milliseconds;
    });
    const limiter = new AdaptiveRateLimiter({
      initialIntervalMs: 0,
      minimumIntervalMs: 0,
      maximumIntervalMs: 1_000,
      maximumHeaderDelayMs: 2_500,
      now: () => now,
      sleep,
    });
    limiter.observe({
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": "30",
      "retry-after": "20",
    });
    await limiter.acquire();
    expect(sleep).toHaveBeenCalledWith(2_500);
    expect(limiter.snapshot().blockedUntil).toBe(7_500);
  });

  it("parses both seconds and HTTP-date Retry-After values", () => {
    expect(retryAfterMilliseconds({ "retry-after": "1.5" }, 1_000, 5_000)).toBe(1_500);
    expect(retryAfterMilliseconds({ "retry-after": new Date(4_000).toUTCString() }, 1_000, 5_000)).toBe(3_000);
    expect(retryAfterMilliseconds({ "retry-after": "invalid" }, 1_000, 5_000)).toBeUndefined();
  });
});
describe("retryWithBackoff", () => {
  it("uses configured exponential delays and attempt count", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const operation = vi.fn(async () => {
      if (operation.mock.calls.length < 3) throw new ProviderRequestError("busy", 503, "busy", true);
      return "ok";
    });
    await expect(retryWithBackoff(operation, {
      maxAttempts: 4,
      baseDelayMs: 25,
      maximumDelayMs: 100,
      jitterRatio: 0,
      sleep,
    })).resolves.toBe("ok");
    expect(sleep.mock.calls.map(([value]) => value)).toEqual([25, 50]);
  });

  it("prefers Retry-After and does not retry terminal failures", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    let attempts = 0;
    await expect(retryWithBackoff(async () => {
      attempts += 1;
      if (attempts === 1) throw new ProviderRequestError("limited", 429, "limited", true, { "retry-after": "2" });
      return 7;
    }, {
      maxAttempts: 2,
      baseDelayMs: 10,
      maximumDelayMs: 5_000,
      jitterRatio: 0,
      sleep,
      now: () => 0,
    })).resolves.toBe(7);
    expect(sleep).toHaveBeenCalledWith(2_000);

    const terminal = new ProviderRequestError("bad", 400, "bad", false);
    await expect(retryWithBackoff(async () => { throw terminal; }, {
      maxAttempts: 3,
      baseDelayMs: 10,
      maximumDelayMs: 20,
      jitterRatio: 0,
      sleep,
    })).rejects.toBe(terminal);
  });
});

describe("TtlCache", () => {
  it("coalesces in-flight loads, expires values and evicts least recently used entries", async () => {
    let now = 0;
    const cache = new TtlCache<string, number>({ maximumEntries: 2, now: () => now });
    let resolve!: (value: number) => void;
    const loader = vi.fn(() => new Promise<number>((done) => { resolve = done; }));
    const first = cache.getOrLoad("a", 100, loader);
    const second = cache.getOrLoad("a", 100, loader);
    resolve(1);
    await expect(Promise.all([first, second])).resolves.toEqual([1, 1]);
    expect(loader).toHaveBeenCalledTimes(1);
    cache.set("b", 2, 100);
    expect(cache.get("a")).toBe(1);
    cache.set("c", 3, 100);
    expect(cache.get("b")).toBeUndefined();
    now = 101;
    expect(cache.get("a")).toBeUndefined();
  });
});
