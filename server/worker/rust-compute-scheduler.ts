import { ServiceError } from "../services/service-envelope.js";
import { durationQuantiles, type DurationQuantiles } from "../observability/duration-quantiles.js";
import { FixedRing } from "../fixed-ring.js";

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
  previous?: QueuedOperation;
  next?: QueuedOperation;
  queued: boolean;
};

export type RustComputeQueueDelaySnapshot = DurationQuantiles;

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

export class RustComputeScheduler {
  private queueHead: QueuedOperation | undefined;
  private queueTail: QueuedOperation | undefined;
  private queuedCount = 0;
  private readonly queueDelaySamples: FixedRing<QueueDelaySample>;
  private readonly capacity: number;
  private readonly maxQueued: number;
  private readonly queueTimeoutMs: number;
  private readonly telemetryWindowMs: number;
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
    const maxTelemetrySamples = Math.max(
      1,
      Math.trunc(input.maxTelemetrySamples ?? DEFAULT_MAX_TELEMETRY_SAMPLES),
    );
    this.queueDelaySamples = new FixedRing(maxTelemetrySamples);
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
    if (this.queuedCount >= this.maxQueued) {
      this.rejectedTotal += 1;
      return Promise.reject(new RustComputeBusyError("queue_full"));
    }

    return new Promise<T>((resolve, reject) => {
      let queued!: QueuedOperation;
      const remove = (): boolean => this.removeQueued(queued);
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
        queued: false,
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
      this.enqueue(queued);
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
    const minimumAt = this.now() - this.telemetryWindowMs;
    const queueDelaySamples = this.queueDelaySamples.values()
      .filter((sample) => sample.at >= minimumAt);
    return {
      capacity: this.capacity,
      active: this.active,
      queued: this.queuedCount,
      maxQueued: this.maxQueued,
      rejectedTotal: this.rejectedTotal,
      queueDelayMs: durationQuantiles(queueDelaySamples, (sample) => sample.delayMs),
    };
  }

  close(error = new Error("Rust compute scheduler closed")): void {
    if (this.closed) return;
    this.closed = true;
    for (let queued = this.shiftQueued(); queued; queued = this.shiftQueued()) {
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
    while (!this.closed && this.active < this.capacity && this.queuedCount > 0) {
      const queued = this.shiftQueued()!;
      queued.start();
    }
  }

  private recordQueueDelay(delayMs: number): void {
    const now = this.now();
    this.queueDelaySamples.push({ at: now, delayMs });
  }

  private enqueue(queued: QueuedOperation): void {
    queued.previous = this.queueTail;
    queued.next = undefined;
    queued.queued = true;
    if (this.queueTail) this.queueTail.next = queued;
    else this.queueHead = queued;
    this.queueTail = queued;
    this.queuedCount += 1;
  }

  private shiftQueued(): QueuedOperation | undefined {
    const queued = this.queueHead;
    if (queued) this.removeQueued(queued);
    return queued;
  }

  private removeQueued(queued: QueuedOperation): boolean {
    if (!queued.queued) return false;
    if (queued.previous) queued.previous.next = queued.next;
    else this.queueHead = queued.next;
    if (queued.next) queued.next.previous = queued.previous;
    else this.queueTail = queued.previous;
    queued.previous = undefined;
    queued.next = undefined;
    queued.queued = false;
    this.queuedCount -= 1;
    return true;
  }
}
