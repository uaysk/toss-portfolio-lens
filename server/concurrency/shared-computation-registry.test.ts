import { describe, expect, it, vi } from "vitest";
import {
  SharedComputationCapacityError,
  SharedComputationRegistry,
} from "./shared-computation-registry.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("SharedComputationRegistry", () => {
  it("shares equivalent work while cancelling only the departing subscriber", async () => {
    const registry = new SharedComputationRegistry();
    const work = deferred<number>();
    const upstreamSignals: AbortSignal[] = [];
    const factory = vi.fn((signal: AbortSignal) => {
      upstreamSignals.push(signal);
      return work.promise;
    });
    const firstController = new AbortController();
    const firstCancellation = new Error("first caller left");
    const first = registry.run("same", factory, firstController.signal);
    const second = registry.run("same", factory);

    await Promise.resolve();
    firstController.abort(firstCancellation);
    await expect(first).rejects.toBe(firstCancellation);
    expect(upstreamSignals[0]?.aborted).toBe(false);

    work.resolve(7);
    await expect(second).resolves.toBe(7);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(registry.size).toBe(0);
  });

  it("aborts upstream work after the final subscriber leaves", async () => {
    const registry = new SharedComputationRegistry();
    const upstreamAborted = deferred<unknown>();
    const factory = vi.fn((signal: AbortSignal) => new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        upstreamAborted.resolve(signal.reason);
        reject(signal.reason);
      }, { once: true });
    }));
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = registry.run("same", factory, firstController.signal);
    const second = registry.run("same", factory, secondController.signal);
    await Promise.resolve();

    firstController.abort(new Error("first"));
    await expect(first).rejects.toThrow("first");
    expect(registry.size).toBe(1);

    secondController.abort(new Error("second"));
    await expect(second).rejects.toThrow("second");
    await expect(upstreamAborted.promise).resolves.toBeInstanceOf(Error);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(registry.size).toBe(0);
  });

  it("does not start work for an already-aborted caller", async () => {
    const registry = new SharedComputationRegistry();
    const controller = new AbortController();
    const reason = new Error("already cancelled");
    controller.abort(reason);
    const factory = vi.fn(async () => 1);

    await expect(registry.run("cancelled", factory, controller.signal)).rejects.toBe(reason);
    expect(factory).not.toHaveBeenCalled();
    expect(registry.size).toBe(0);
  });

  it("fails fast for a new key at capacity while continuing to share admitted work", async () => {
    const registry = new SharedComputationRegistry({ maximumEntries: 1 });
    const work = deferred<number>();
    const admittedFactory = vi.fn(() => work.promise);
    const rejectedFactory = vi.fn(async () => 2);
    const first = registry.run("admitted", admittedFactory);
    const shared = registry.run("admitted", admittedFactory);

    await expect(registry.run("distinct", rejectedFactory)).rejects.toMatchObject({
      name: "SharedComputationCapacityError",
      maximumEntries: 1,
      retryAfterSeconds: 1,
    });
    expect(rejectedFactory).not.toHaveBeenCalled();
    expect(registry.size).toBe(1);

    work.resolve(1);
    await expect(Promise.all([first, shared])).resolves.toEqual([1, 1]);
    expect(admittedFactory).toHaveBeenCalledTimes(1);
    expect(registry.size).toBe(0);
    await expect(registry.run("distinct", rejectedFactory)).resolves.toBe(2);
  });

  it("keeps non-cooperative cancelled work charged against capacity until it settles", async () => {
    const registry = new SharedComputationRegistry({ maximumEntries: 1 });
    const lingering = deferred<number>();
    const controller = new AbortController();
    const first = registry.run("first", () => lingering.promise, controller.signal);
    await Promise.resolve();

    controller.abort(new Error("caller left"));
    await expect(first).rejects.toThrow("caller left");
    expect(registry.size).toBe(1);
    const nextFactory = vi.fn(async () => 2);
    await expect(registry.run("next", nextFactory)).rejects.toBeInstanceOf(
      SharedComputationCapacityError,
    );
    expect(nextFactory).not.toHaveBeenCalled();

    lingering.resolve(1);
    await vi.waitFor(() => expect(registry.size).toBe(0));
    await expect(registry.run("next", nextFactory)).resolves.toBe(2);
  });

  it("rejects new work after close and validates its capacity", async () => {
    expect(() => new SharedComputationRegistry({ maximumEntries: 0 })).toThrow(
      "maximumEntries must be a positive safe integer",
    );
    const registry = new SharedComputationRegistry();
    const reason = new Error("shutdown");
    registry.close(reason);

    await expect(registry.run("after-close", async () => 1)).rejects.toBe(reason);
    expect(registry.size).toBe(0);
  });
});
