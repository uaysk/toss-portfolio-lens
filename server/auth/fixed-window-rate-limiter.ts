export type FixedWindowRateLimitDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason: "request-limit" | "source-capacity";
      retryAfterSeconds: number;
    };

type FixedWindowBucket = {
  count: number;
  resetAt: number;
};

export class BoundedFixedWindowRateLimiter {
  private readonly buckets = new Map<string, FixedWindowBucket>();
  private readonly now: () => number;
  private readonly cleanupBatchSize: number;

  constructor(private readonly config: {
    maximumRequests: number;
    windowMs: number;
    maximumEntries: number;
    cleanupBatchSize?: number;
    now?: () => number;
  }) {
    if (
      !Number.isInteger(config.maximumRequests) || config.maximumRequests < 1
      || !Number.isInteger(config.windowMs) || config.windowMs < 1
      || !Number.isInteger(config.maximumEntries) || config.maximumEntries < 1
      || (config.cleanupBatchSize !== undefined
        && (!Number.isInteger(config.cleanupBatchSize) || config.cleanupBatchSize < 1))
    ) {
      throw new Error("Fixed-window rate limiter configuration is invalid.");
    }
    this.now = config.now ?? Date.now;
    this.cleanupBatchSize = config.cleanupBatchSize ?? 32;
  }

  check(key: string): FixedWindowRateLimitDecision {
    const now = this.now();
    this.cleanupExpired(now);
    let bucket = this.buckets.get(key);
    if (bucket && bucket.resetAt <= now) {
      this.buckets.delete(key);
      bucket = undefined;
    }
    if (!bucket) {
      if (this.buckets.size >= this.config.maximumEntries) {
        const earliestResetAt = this.buckets.values().next().value?.resetAt
          ?? now + this.config.windowMs;
        return {
          allowed: false,
          reason: "source-capacity",
          retryAfterSeconds: this.retryAfterSeconds(earliestResetAt, now),
        };
      }
      bucket = { count: 0, resetAt: now + this.config.windowMs };
      this.buckets.set(key, bucket);
    }
    if (bucket.count >= this.config.maximumRequests) {
      return {
        allowed: false,
        reason: "request-limit",
        retryAfterSeconds: this.retryAfterSeconds(bucket.resetAt, now),
      };
    }
    bucket.count += 1;
    return { allowed: true };
  }

  get size(): number {
    this.cleanupExpired(this.now());
    return this.buckets.size;
  }

  private cleanupExpired(now: number): void {
    let inspected = 0;
    for (const [key, bucket] of this.buckets) {
      if (inspected >= this.cleanupBatchSize) break;
      inspected += 1;
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }

  private retryAfterSeconds(resetAt: number, now: number): number {
    return Math.max(1, Math.ceil((resetAt - now) / 1_000));
  }
}
