import { performance } from "node:perf_hooks";

export type EventLoopLagSnapshot = {
  sampleCount: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
};

function percentile(values: number[], ratio: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index]!;
}

function rounded(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

export class EventLoopLagMonitor {
  private readonly samples: number[] = [];
  private timer: NodeJS.Timeout | undefined;
  private expectedAt = 0;

  constructor(
    private readonly intervalMs = 250,
    private readonly maximumSamples = 240,
  ) {}

  start(): void {
    if (this.timer) return;
    this.expectedAt = performance.now() + this.intervalMs;
    this.timer = setInterval(() => {
      const now = performance.now();
      this.samples.push(Math.max(0, now - this.expectedAt));
      if (this.samples.length > this.maximumSamples) {
        this.samples.splice(0, this.samples.length - this.maximumSamples);
      }
      this.expectedAt = now + this.intervalMs;
    }, this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  snapshot(): EventLoopLagSnapshot {
    return {
      sampleCount: this.samples.length,
      p95Ms: rounded(percentile(this.samples, 0.95)),
      p99Ms: rounded(percentile(this.samples, 0.99)),
      maxMs: rounded(this.samples.length ? Math.max(...this.samples) : 0),
    };
  }
}
