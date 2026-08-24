import { performance } from "node:perf_hooks";
import { durationQuantiles } from "./duration-quantiles.js";
import { FixedRing } from "../fixed-ring.js";

export type EventLoopLagSnapshot = {
  sampleCount: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
};

export class EventLoopLagMonitor {
  private readonly samples: FixedRing<number>;
  private timer: NodeJS.Timeout | undefined;
  private expectedAt = 0;

  constructor(
    private readonly intervalMs = 250,
    private readonly maximumSamples = 1_200,
  ) {
    if (!Number.isFinite(this.intervalMs) || this.intervalMs < 1) {
      throw new TypeError("Event loop sample interval must be a positive number.");
    }
    this.samples = new FixedRing(this.maximumSamples);
  }

  start(): void {
    if (this.timer) return;
    this.expectedAt = performance.now() + this.intervalMs;
    this.timer = setInterval(() => {
      const now = performance.now();
      this.samples.push(Math.max(0, now - this.expectedAt));
      this.expectedAt = now + this.intervalMs;
    }, this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  snapshot(): EventLoopLagSnapshot {
    const { sampleCount, p95Ms, p99Ms, maxMs } = durationQuantiles(
      this.samples.values(),
      (sample) => sample,
    );
    return {
      sampleCount,
      p95Ms,
      p99Ms,
      maxMs,
    };
  }
}
