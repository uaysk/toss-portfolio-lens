import { afterEach, describe, expect, it, vi } from "vitest";
import { EventLoopLagMonitor } from "./event-loop-monitor.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("EventLoopLagMonitor", () => {
  it("최근 표본의 p95/p99/max를 노출하고 중복 start를 허용한다", async () => {
    vi.useFakeTimers();
    const monitor = new EventLoopLagMonitor(10, 3);
    monitor.start();
    monitor.start();
    await vi.advanceTimersByTimeAsync(50);
    const snapshot = monitor.snapshot();
    expect(snapshot.sampleCount).toBe(3);
    expect(snapshot.p95Ms).toBeGreaterThanOrEqual(0);
    expect(snapshot.p99Ms).toBeGreaterThanOrEqual(snapshot.p95Ms);
    expect(snapshot.maxMs).toBeGreaterThanOrEqual(snapshot.p99Ms);
    monitor.stop();
  });
});
