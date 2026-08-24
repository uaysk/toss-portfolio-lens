import { isIP } from "node:net";

export type LoginAttemptLimiterConfig = {
  maximumAttempts: number;
  windowMs: number;
  maximumEntries: number;
  now?: () => number;
};

export type LoginAttemptDecision =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

type AttemptState = {
  count: number;
  resetAt: number;
};

function canonicalIpv6(value: string): string {
  try {
    return new URL(`http://[${value}]/`).hostname.slice(1, -1);
  } catch {
    return value.toLowerCase();
  }
}

function mappedIpv4FromCanonicalIpv6(value: string): string | undefined {
  const mapped = value.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (!mapped) return undefined;
  const high = Number.parseInt(mapped[1]!, 16);
  const low = Number.parseInt(mapped[2]!, 16);
  return [high >>> 8, high & 0xff, low >>> 8, low & 0xff].join(".");
}

export function normalizeClientIp(value: string | undefined): string {
  const candidate = value?.trim().replace(/^\[|\]$/g, "") ?? "";
  if (!candidate) return "unknown";
  const mappedIpv4 = candidate.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i)?.[1];
  if (mappedIpv4 && isIP(mappedIpv4) === 4) return mappedIpv4;
  const version = isIP(candidate);
  if (version === 4) return candidate;
  if (version === 6) {
    const canonical = canonicalIpv6(candidate);
    return mappedIpv4FromCanonicalIpv6(canonical) ?? canonical;
  }
  return "unknown";
}

export class LoginAttemptLimiter {
  private readonly attempts = new Map<string, AttemptState>();
  private readonly now: () => number;

  constructor(private readonly config: LoginAttemptLimiterConfig) {
    if (!Number.isInteger(config.maximumAttempts) || config.maximumAttempts < 1
      || !Number.isInteger(config.windowMs) || config.windowMs < 1
      || !Number.isInteger(config.maximumEntries) || config.maximumEntries < 1) {
      throw new Error("Login attempt limiter configuration is invalid.");
    }
    this.now = config.now ?? Date.now;
  }

  check(key: string): LoginAttemptDecision {
    const now = this.now();
    this.cleanupExpired(now);
    const state = this.attempts.get(key);
    if (state) {
      if (state.count < this.config.maximumAttempts) return { allowed: true };
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((state.resetAt - now) / 1_000)),
      };
    }
    if (this.attempts.size < this.config.maximumEntries) return { allowed: true };

    // Never evict an active failure record to make room for a new source. In
    // particular, doing so would let distributed source churn remove an IP
    // that has already reached the attempt limit. Capacity therefore fails
    // closed until the first active window expires.
    let earliestResetAt = now + this.config.windowMs;
    for (const attempt of this.attempts.values()) {
      earliestResetAt = Math.min(earliestResetAt, attempt.resetAt);
    }
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((earliestResetAt - now) / 1_000)),
    };
  }

  recordFailure(key: string): void {
    const now = this.now();
    this.cleanupExpired(now);
    const previous = this.attempts.get(key);
    if (!previous && this.attempts.size >= this.config.maximumEntries) return;
    const state = previous ?? { count: 0, resetAt: now + this.config.windowMs };
    state.count += 1;
    this.attempts.delete(key);
    this.attempts.set(key, state);
  }

  reset(key: string): void {
    this.attempts.delete(key);
  }

  get size(): number {
    this.cleanupExpired(this.now());
    return this.attempts.size;
  }

  private cleanupExpired(now: number): void {
    for (const [key, state] of this.attempts) {
      if (state.resetAt <= now) this.attempts.delete(key);
    }
  }
}
