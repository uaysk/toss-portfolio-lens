export type ProviderHeaders = Headers | Readonly<Record<string, string | undefined>>;

export type AdaptiveRateLimiterConfig = {
  initialIntervalMs: number;
  minimumIntervalMs: number;
  maximumIntervalMs: number;
  maximumHeaderDelayMs: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
};

export type RateLimitSnapshot = {
  intervalMs: number;
  blockedUntil: number;
  observedLimit?: number;
  observedRemaining?: number;
  observedResetAt?: number;
};

export type RetryConfig = {
  maxAttempts: number;
  baseDelayMs: number;
  maximumDelayMs: number;
  jitterRatio: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
};

export type TtlCacheConfig = {
  maximumEntries: number;
  now?: () => number;
};

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function assertNonNegativeFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative finite number.`);
}

function header(headers: ProviderHeaders | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

function finiteInteger(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value.trim())) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function resetAtFromHeader(value: string | undefined, now: number): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || parsed < 0) return undefined;
    if (parsed >= 1_000_000_000_000) return parsed;
    return parsed >= 1_000_000_000 ? parsed * 1_000 : now + parsed * 1_000;
  }
  const date = Date.parse(trimmed);
  return Number.isFinite(date) ? date : undefined;
}

export function retryAfterMilliseconds(
  headers: ProviderHeaders | undefined,
  now: number,
  maximumDelayMs: number,
): number | undefined {
  assertNonNegativeFinite("maximumDelayMs", maximumDelayMs);
  const value = header(headers, "retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  const raw = Number.isFinite(seconds) && seconds >= 0
    ? seconds * 1_000
    : Math.max(0, Date.parse(value) - now);
  return Number.isFinite(raw) ? Math.min(raw, maximumDelayMs) : undefined;
}

export class ProviderRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
    public readonly retryable: boolean,
    public readonly headers?: ProviderHeaders,
  ) {
    super(message);
    this.name = "ProviderRequestError";
  }
}

export class AdaptiveRateLimiter {
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private intervalMs: number;
  private nextRequestAt = 0;
  private blockedUntil = 0;
  private observedLimit?: number;
  private observedRemaining?: number;
  private observedResetAt?: number;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly config: AdaptiveRateLimiterConfig) {
    assertNonNegativeFinite("initialIntervalMs", config.initialIntervalMs);
    assertNonNegativeFinite("minimumIntervalMs", config.minimumIntervalMs);
    assertNonNegativeFinite("maximumIntervalMs", config.maximumIntervalMs);
    assertNonNegativeFinite("maximumHeaderDelayMs", config.maximumHeaderDelayMs);
    if (config.maximumIntervalMs < config.minimumIntervalMs
      || config.initialIntervalMs < config.minimumIntervalMs
      || config.initialIntervalMs > config.maximumIntervalMs) {
      throw new Error("Adaptive rate limiter intervals are inconsistent.");
    }
    this.now = config.now ?? Date.now;
    this.sleep = config.sleep ?? defaultSleep;
    this.intervalMs = config.initialIntervalMs;
  }

  async acquire(): Promise<void> {
    let release = (): void => undefined;
    const previous = this.queue;
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const current = this.now();
      const readyAt = Math.max(this.nextRequestAt, this.blockedUntil);
      if (readyAt > current) await this.sleep(readyAt - current);
      this.nextRequestAt = Math.max(this.now(), readyAt) + this.intervalMs;
    } finally {
      release();
    }
  }

  observe(headers: ProviderHeaders | undefined): void {
    const current = this.now();
    const limit = finiteInteger(header(headers, "x-ratelimit-limit") ?? header(headers, "x-rate-limit-limit"));
    const remaining = finiteInteger(
      header(headers, "x-ratelimit-remaining") ?? header(headers, "x-rate-limit-remaining"),
    );
    const resetAt = resetAtFromHeader(
      header(headers, "x-ratelimit-reset") ?? header(headers, "x-rate-limit-reset"),
      current,
    );
    if (limit !== undefined) this.observedLimit = limit;
    if (remaining !== undefined) this.observedRemaining = remaining;
    if (resetAt !== undefined) this.observedResetAt = resetAt;

    if (resetAt !== undefined && resetAt > current && remaining !== undefined) {
      const delayToReset = Math.min(resetAt - current, this.config.maximumHeaderDelayMs);
      if (remaining === 0) {
        this.blockedUntil = Math.max(this.blockedUntil, current + delayToReset);
      } else {
        const adaptiveInterval = delayToReset / remaining;
        this.intervalMs = Math.max(
          this.config.minimumIntervalMs,
          Math.min(adaptiveInterval, this.config.maximumIntervalMs),
        );
      }
    }

    const retryAfter = retryAfterMilliseconds(headers, current, this.config.maximumHeaderDelayMs);
    if (retryAfter !== undefined) this.blockedUntil = Math.max(this.blockedUntil, current + retryAfter);
  }

  snapshot(): RateLimitSnapshot {
    return {
      intervalMs: this.intervalMs,
      blockedUntil: this.blockedUntil,
      ...(this.observedLimit === undefined ? {} : { observedLimit: this.observedLimit }),
      ...(this.observedRemaining === undefined ? {} : { observedRemaining: this.observedRemaining }),
      ...(this.observedResetAt === undefined ? {} : { observedResetAt: this.observedResetAt }),
    };
  }
}

export async function retryWithBackoff<T>(
  operation: (attempt: number) => Promise<T>,
  config: RetryConfig,
  shouldRetry: (error: unknown) => { retryable: boolean; headers?: ProviderHeaders } = (error) => ({
    retryable: error instanceof ProviderRequestError && error.retryable,
    ...(error instanceof ProviderRequestError && error.headers ? { headers: error.headers } : {}),
  }),
): Promise<T> {
  if (!Number.isInteger(config.maxAttempts) || config.maxAttempts <= 0) {
    throw new Error("maxAttempts must be a positive integer.");
  }
  assertNonNegativeFinite("baseDelayMs", config.baseDelayMs);
  assertNonNegativeFinite("maximumDelayMs", config.maximumDelayMs);
  if (config.maximumDelayMs < config.baseDelayMs) throw new Error("maximumDelayMs must be at least baseDelayMs.");
  if (!Number.isFinite(config.jitterRatio) || config.jitterRatio < 0 || config.jitterRatio > 1) {
    throw new Error("jitterRatio must be between zero and one.");
  }
  const now = config.now ?? Date.now;
  const sleep = config.sleep ?? defaultSleep;
  const random = config.random ?? Math.random;

  for (let attempt = 0; attempt < config.maxAttempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      const decision = shouldRetry(error);
      if (!decision.retryable || attempt + 1 >= config.maxAttempts) throw error;
      const exponential = Math.min(config.baseDelayMs * 2 ** attempt, config.maximumDelayMs);
      const providerDelay = retryAfterMilliseconds(decision.headers, now(), config.maximumDelayMs);
      const jitterMultiplier = 1 - config.jitterRatio + random() * config.jitterRatio * 2;
      const delay = providerDelay ?? Math.min(config.maximumDelayMs, Math.max(0, exponential * jitterMultiplier));
      await sleep(delay);
    }
  }
  throw new Error("Retry loop exhausted unexpectedly.");
}

export class TtlCache<K, V> {
  private readonly now: () => number;
  private readonly values = new Map<K, { value: V; expiresAt: number }>();
  private readonly inFlight = new Map<K, Promise<V>>();

  constructor(private readonly config: TtlCacheConfig) {
    if (!Number.isInteger(config.maximumEntries) || config.maximumEntries <= 0) {
      throw new Error("maximumEntries must be a positive integer.");
    }
    this.now = config.now ?? Date.now;
  }

  get(key: K): V | undefined {
    const item = this.values.get(key);
    if (!item) return undefined;
    if (item.expiresAt <= this.now()) {
      this.values.delete(key);
      return undefined;
    }
    this.values.delete(key);
    this.values.set(key, item);
    return item.value;
  }

  set(key: K, value: V, ttlMs: number): void {
    assertNonNegativeFinite("ttlMs", ttlMs);
    if (ttlMs === 0) return;
    this.values.delete(key);
    this.values.set(key, { value, expiresAt: this.now() + ttlMs });
    while (this.values.size > this.config.maximumEntries) {
      const oldest = this.values.keys().next().value as K | undefined;
      if (oldest === undefined) break;
      this.values.delete(oldest);
    }
  }

  async getOrLoad(key: K, ttlMs: number, loader: () => Promise<V>): Promise<V> {
    const cached = this.get(key);
    if (cached !== undefined) return cached;
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const task = loader();
    this.inFlight.set(key, task);
    try {
      const value = await task;
      this.set(key, value, ttlMs);
      return value;
    } finally {
      if (this.inFlight.get(key) === task) this.inFlight.delete(key);
    }
  }

  clear(): void {
    this.values.clear();
  }
}
