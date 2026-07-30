import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RustComputeBusyError,
  RustComputeScheduler,
} from "./rust-compute-scheduler.js";

type Deferred<T = void> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
};

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
});

describe("RustComputeScheduler", () => {
  it("bounds active work, starts queued work FIFO, and records queue delay", async () => {
    let now = 1_000;
    const scheduler = new RustComputeScheduler({
      maxActive: 2,
      maxQueued: 3,
      queueTimeoutMs: 1_000,
      now: () => now,
    });
    const releases = [deferred(), deferred(), deferred()];
    const started: number[] = [];
    const tasks = releases.map((release, index) => scheduler.schedule(async () => {
      started.push(index);
      await release.promise;
      return index;
    }));

    await flush();
    expect(started).toEqual([0, 1]);
    expect(scheduler.snapshot()).toMatchObject({
      capacity: 2,
      active: 2,
      queued: 1,
      maxQueued: 3,
      rejectedTotal: 0,
    });

    now += 25;
    releases[0]!.resolve();
    await expect(tasks[0]).resolves.toBe(0);
    await flush();
    expect(started).toEqual([0, 1, 2]);
    expect(scheduler.snapshot().queueDelayMs).toMatchObject({
      sampleCount: 3,
      p99Ms: 25,
      maxMs: 25,
    });

    releases[1]!.resolve();
    releases[2]!.resolve();
    await expect(Promise.all(tasks)).resolves.toEqual([0, 1, 2]);
    scheduler.close();
  });

  it("rejects queue overflow with retryable RUST_COMPUTE_BUSY", async () => {
    const scheduler = new RustComputeScheduler({
      maxActive: 1,
      maxQueued: 1,
      queueTimeoutMs: 1_000,
    });
    const active = deferred();
    const first = scheduler.schedule(() => active.promise);
    const queued = scheduler.schedule(async () => "queued");
    const rejected = scheduler.schedule(async () => "rejected");

    await expect(rejected).rejects.toMatchObject({
      detail: {
        code: "RUST_COMPUTE_BUSY",
        retryable: true,
        details: { reason: "queue_full", retry_after_seconds: 1 },
      },
      retryAfterSeconds: 1,
    });
    expect(scheduler.snapshot()).toMatchObject({
      active: 1,
      queued: 1,
      rejectedTotal: 1,
    });

    active.resolve();
    await first;
    await expect(queued).resolves.toBe("queued");
    scheduler.close();
  });

  it("keeps active work bounded under ten-times-capacity load", async () => {
    const scheduler = new RustComputeScheduler({
      maxActive: 2,
      maxQueued: 6,
      queueTimeoutMs: 1_000,
    });
    const gate = deferred();
    let active = 0;
    let maximumActive = 0;
    const outcomes = Array.from({ length: 20 }, (_, index) => scheduler
      .schedule(async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await gate.promise;
        active -= 1;
        return index;
      })
      .catch((error: unknown) => error));

    await flush();
    expect(scheduler.snapshot()).toMatchObject({
      capacity: 2,
      active: 2,
      queued: 6,
      rejectedTotal: 12,
    });

    gate.resolve();
    const results = await Promise.all(outcomes);
    expect(maximumActive).toBe(2);
    expect(results.filter((result) => result instanceof RustComputeBusyError)).toHaveLength(12);
    expect(scheduler.snapshot()).toMatchObject({ active: 0, queued: 0 });
    scheduler.close();
  });

  it("times out queued work without interrupting active work", async () => {
    vi.useFakeTimers();
    const scheduler = new RustComputeScheduler({
      maxActive: 1,
      maxQueued: 1,
      queueTimeoutMs: 30,
    });
    const active = deferred();
    const first = scheduler.schedule(() => active.promise);
    const queued = scheduler.schedule(async () => "queued");
    const rejection = expect(queued).rejects.toBeInstanceOf(RustComputeBusyError);

    await vi.advanceTimersByTimeAsync(30);
    await rejection;
    expect(scheduler.snapshot()).toMatchObject({
      active: 1,
      queued: 0,
      rejectedTotal: 1,
    });

    active.resolve();
    await first;
    scheduler.close();
  });

  it("removes a cancelled waiter and preserves unrelated work", async () => {
    const scheduler = new RustComputeScheduler({
      maxActive: 1,
      maxQueued: 2,
      queueTimeoutMs: 1_000,
    });
    const active = deferred();
    const first = scheduler.schedule(() => active.promise);
    const controller = new AbortController();
    const cancellation = new Error("cancel queued request");
    const cancelled = scheduler.schedule(async () => "cancelled", {
      signal: controller.signal,
    });
    const unrelated = scheduler.schedule(async () => "unrelated");

    controller.abort(cancellation);
    await expect(cancelled).rejects.toBe(cancellation);
    expect(scheduler.snapshot()).toMatchObject({
      active: 1,
      queued: 1,
      rejectedTotal: 0,
    });

    active.resolve();
    await first;
    await expect(unrelated).resolves.toBe("unrelated");
    scheduler.close();
  });

  it("rejects queued work on close and bounds rolling telemetry samples", async () => {
    let now = 1_000;
    const scheduler = new RustComputeScheduler({
      maxActive: 1,
      maxQueued: 2,
      queueTimeoutMs: 1_000,
      telemetryWindowMs: 10,
      maxTelemetrySamples: 2,
      now: () => now,
    });
    const active = deferred();
    const first = scheduler.schedule(() => active.promise);
    const queued = scheduler.schedule(async () => "queued");
    const closeError = new Error("synthetic close");

    scheduler.close(closeError);
    await expect(queued).rejects.toBe(closeError);
    await expect(scheduler.schedule(async () => "late")).rejects.toThrow("scheduler closed");

    active.resolve();
    await first;
    now += 11;
    expect(scheduler.snapshot().queueDelayMs.sampleCount).toBe(0);
  });
});
