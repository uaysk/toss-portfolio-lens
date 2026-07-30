import { ServiceError } from "../services/service-envelope.js";

const DEFAULT_TELEMETRY_WINDOW_MS = 5 * 60_000;
const DEFAULT_MAX_TELEMETRY_SAMPLES = 4_096;

type QueueDelaySample = {
  at: number;
  delayMs: number;
};

type QueuedOperation = {
  enqueuedAt: number;
  signal?: AbortSignal;
  timer: NodeJS.Timeout;
  cleanupAbort?: () => void;
  start: () => void;
  reject: (error: Error) => void;
};

export type RustComputeQueueDelaySnapshot = {
  sampleCount: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
};

export type RustComputeSchedulerSnapshot = {
  capacity: number;
  active: number;
  queued: number;
  maxQueued: number;
  rejectedTotal: number;
  queueDelayMs: RustComputeQueueDelaySnapshot;
};

export class RustComputeBusyError extends ServiceError {
  readonly retryAfterSeconds = 1;

  constructor(reason: "queue_full" | "queue_timeout") {
    super({
      code: "RUST_COMPUTE_BUSY",
      message: reason === "queue_full"
        ? "Rust compute 대기열이 가득 찼습니다. 잠시 후 다시 시도해 주세요."
        : "Rust compute 대기 시간이 제한을 초과했습니다. 잠시 후 다시 시도해 주세요.",
      retryable: true,
      details: {
        reason,
        retry_after_seconds: 1,
      },
    });
    this.name = "RustComputeBusyError";
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Rust compute 요청이 취소되었습니다.");
}

function percentile(values: readonly number[], ratio: number): number {
  if (!values.length) return 0;
  const index = Math.min(
    values.length - 1,
    Math.max(0, Math.ceil(values.length * ratio) - 1),
  );
  return values[index]!;
}

function rounded(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

export class RustComputeScheduler {
  private readonly queue: QueuedOperation[] = [];
  private readonly queueDelaySamples: QueueDelaySample[] = [];
  private readonly capacity: number;
  private readonly maxQueued: number;
  private readonly queueTimeoutMs: number;
  private readonly telemetryWindowMs: number;
  private readonly maxTelemetrySamples: number;
  private readonly now: () => number;
  private active = 0;
  private rejectedTotal = 0;
  private closed = false;

  constructor(input: {
    maxActive: number;
    maxQueued?: number;
    queueTimeoutMs?: number;
    telemetryWindowMs?: number;
    maxTelemetrySamples?: number;
    now?: () => number;
  }) {
    this.capacity = Math.max(1, Math.min(32, Math.trunc(input.maxActive)));
    this.maxQueued = Math.max(0, Math.min(10_000, Math.trunc(input.maxQueued ?? 32)));
    this.queueTimeoutMs = Math.max(1, Math.min(3_600_000, Math.trunc(input.queueTimeoutMs ?? 30_000)));
    this.telemetryWindowMs = Math.max(
      1,
      Math.trunc(input.telemetryWindowMs ?? DEFAULT_TELEMETRY_WINDOW_MS),
    );
    this.maxTelemetrySamples = Math.max(
      1,
      Math.trunc(input.maxTelemetrySamples ?? DEFAULT_MAX_TELEMETRY_SAMPLES),
    );
    this.now = input.now ?? Date.now;
  }

  schedule<T>(
    operation: () => Promise<T>,
    options: { signal?: AbortSignal } = {},
  ): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error("Rust compute scheduler closed"));
    }
    if (options.signal?.aborted) {
      return Promise.reject(abortReason(options.signal));
    }
    if (this.active < this.capacity) {
      this.recordQueueDelay(0);
      return this.start(operation);
    }
    if (this.queue.length >= this.maxQueued) {
      this.rejectedTotal += 1;
      return Promise.reject(new RustComputeBusyError("queue_full"));
    }

    return new Promise<T>((resolve, reject) => {
      let queued!: QueuedOperation;
      const remove = (): boolean => {
        const index = this.queue.indexOf(queued);
        if (index < 0) return false;
        this.queue.splice(index, 1);
        return true;
      };
      const timer = setTimeout(() => {
        if (!remove()) return;
        queued.cleanupAbort?.();
        this.rejectedTotal += 1;
        reject(new RustComputeBusyError("queue_timeout"));
      }, this.queueTimeoutMs);
      timer.unref();
      queued = {
        enqueuedAt: this.now(),
        signal: options.signal,
        timer,
        reject,
        start: () => {
          clearTimeout(timer);
          queued.cleanupAbort?.();
          if (options.signal?.aborted) {
            reject(abortReason(options.signal));
            return;
          }
          this.recordQueueDelay(Math.max(0, this.now() - queued.enqueuedAt));
          void this.start(operation).then(resolve, reject);
        },
      };
      if (options.signal) {
        const onAbort = () => {
          if (!remove()) return;
          clearTimeout(timer);
          reject(abortReason(options.signal!));
        };
        options.signal.addEventListener("abort", onAbort, { once: true });
        queued.cleanupAbort = () => options.signal!.removeEventListener("abort", onAbort);
      }
      this.queue.push(queued);
      if (options.signal?.aborted) {
        const error = abortReason(options.signal);
        if (remove()) {
          clearTimeout(timer);
          queued.cleanupAbort?.();
          reject(error);
        }
      }
    });
  }

  snapshot(): RustComputeSchedulerSnapshot {
    this.pruneQueueDelaySamples();
    const values = this.queueDelaySamples
      .map((sample) => sample.delayMs)
      .sort((left, right) => left - right);
    return {
      capacity: this.capacity,
      active: this.active,
      queued: this.queue.length,
      maxQueued: this.maxQueued,
      rejectedTotal: this.rejectedTotal,
      queueDelayMs: {
        sampleCount: values.length,
        p50Ms: rounded(percentile(values, 0.5)),
        p95Ms: rounded(percentile(values, 0.95)),
        p99Ms: rounded(percentile(values, 0.99)),
        maxMs: rounded(values.at(-1) ?? 0),
      },
    };
  }

  close(error = new Error("Rust compute scheduler closed")): void {
    if (this.closed) return;
    this.closed = true;
    for (const queued of this.queue.splice(0)) {
      clearTimeout(queued.timer);
      queued.cleanupAbort?.();
      queued.reject(error);
    }
  }

  private start<T>(operation: () => Promise<T>): Promise<T> {
    this.active += 1;
    return Promise.resolve()
      .then(operation)
      .finally(() => {
        this.active -= 1;
        this.drain();
      });
  }

  private drain(): void {
    while (!this.closed && this.active < this.capacity && this.queue.length) {
      const queued = this.queue.shift()!;
      queued.start();
    }
  }

  private recordQueueDelay(delayMs: number): void {
    const now = this.now();
    this.queueDelaySamples.push({ at: now, delayMs });
    this.pruneQueueDelaySamples(now);
    if (this.queueDelaySamples.length > this.maxTelemetrySamples) {
      this.queueDelaySamples.splice(
        0,
        this.queueDelaySamples.length - this.maxTelemetrySamples,
      );
    }
  }

  private pruneQueueDelaySamples(now = this.now()): void {
    const minimumAt = now - this.telemetryWindowMs;
    let expired = 0;
    while (
      expired < this.queueDelaySamples.length
      && this.queueDelaySamples[expired]!.at < minimumAt
    ) {
      expired += 1;
    }
    if (expired > 0) this.queueDelaySamples.splice(0, expired);
  }
}
