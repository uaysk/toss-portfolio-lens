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

export function normalizeClientIp(value: string | undefined): string {
  const candidate = value?.trim().replace(/^\[|\]$/g, "") ?? "";
  if (!candidate) return "unknown";
  const mappedIpv4 = candidate.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i)?.[1];
  if (mappedIpv4 && isIP(mappedIpv4) === 4) return mappedIpv4;
  const version = isIP(candidate);
  if (version === 4) return candidate;
  if (version === 6) return canonicalIpv6(candidate);
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
    if (!state || state.count < this.config.maximumAttempts) return { allowed: true };
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((state.resetAt - now) / 1_000)),
    };
  }

  recordFailure(key: string): void {
    const now = this.now();
    this.cleanupExpired(now);
    const previous = this.attempts.get(key);
    const state = previous ?? { count: 0, resetAt: now + this.config.windowMs };
    state.count += 1;
    this.attempts.delete(key);
    this.attempts.set(key, state);
    while (this.attempts.size > this.config.maximumEntries) {
      const oldest = this.attempts.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.attempts.delete(oldest);
    }
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
