import { describe, expect, it, vi } from "vitest";
import { SharedComputationRegistry } from "./shared-computation-registry.js";

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
});
