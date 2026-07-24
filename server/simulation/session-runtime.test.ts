import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanupSimulationRuntime,
  combinedRelease,
  type SimulationRuntimeHandles,
} from "./session-runtime.js";

afterEach(() => {
  vi.useRealTimers();
});

function nodeTimeout(callback: () => void, delayMs: number): NodeJS.Timeout {
  return setTimeout(callback, delayMs) as unknown as NodeJS.Timeout;
}

function nodeInterval(callback: () => void, delayMs: number): NodeJS.Timeout {
  return setInterval(callback, delayMs) as unknown as NodeJS.Timeout;
}

describe("simulation runtime handles", () => {
  it("clears every timer, resolves retry waits, aborts, and releases idempotently", () => {
    vi.useFakeTimers();
    const endCallback = vi.fn();
    const progressCallback = vi.fn();
    const retryCallback = vi.fn();
    const retryResolve = vi.fn();
    let releaseCalls = 0;
    const release = vi.fn(() => {
      releaseCalls += 1;
      if (releaseCalls === 1) throw new Error("temporary unsubscribe failure");
    });
    const abort = new AbortController();
    const handles: SimulationRuntimeHandles = {
      release,
      selectionRetryTimer: nodeTimeout(retryCallback, 10),
      selectionRetryResolve: retryResolve,
      endTimer: nodeTimeout(endCallback, 10),
      progressTimer: nodeInterval(progressCallback, 10),
      decisionAbort: abort,
      analysisQueued: true,
    };

    expect(cleanupSimulationRuntime(handles, new Error("cancelled"))).toEqual({});
    expect(release).toHaveBeenCalledTimes(2);
    expect(retryResolve).toHaveBeenCalledTimes(1);
    expect(abort.signal.aborted).toBe(true);
    expect(handles).toMatchObject({
      selectionRetryTimer: undefined,
      selectionRetryResolve: undefined,
      endTimer: undefined,
      progressTimer: undefined,
      analysisQueued: false,
      release: undefined,
    });

    vi.advanceTimersByTime(100);
    expect(retryCallback).not.toHaveBeenCalled();
    expect(endCallback).not.toHaveBeenCalled();
    expect(progressCallback).not.toHaveBeenCalled();

    expect(cleanupSimulationRuntime(handles, new Error("duplicate cleanup"))).toEqual({});
    expect(release).toHaveBeenCalledTimes(2);
    expect(retryResolve).toHaveBeenCalledTimes(1);
  });

  it("runs every release and reports a bounded aggregate failure", () => {
    const first = vi.fn(() => {
      throw new Error("first");
    });
    const second = vi.fn();
    const release = combinedRelease(first, second);

    expect(release).toThrow(AggregateError);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("returns the release error only after the single retry is exhausted", () => {
    const release = vi.fn(() => {
      throw new Error("persistent unsubscribe failure");
    });
    const handles: SimulationRuntimeHandles = {
      release,
      decisionAbort: new AbortController(),
      analysisQueued: false,
    };

    const result = cleanupSimulationRuntime(handles, new Error("failed"));
    expect(release).toHaveBeenCalledTimes(2);
    expect(result.releaseError).toBeInstanceOf(AggregateError);
    expect(handles.release).toBeUndefined();
  });
});
