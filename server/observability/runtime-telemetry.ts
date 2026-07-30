import type { RequestHandler } from "express";

const DEFAULT_WINDOW_MS = 5 * 60_000;
const DEFAULT_MAX_SAMPLES = 4_096;

type TimedSample = {
  at: number;
  durationMs: number;
};

type ArtifactSample = TimedSample & {
  byteCount: number;
  storageMs: number;
  offloaded: boolean;
};

export type DurationQuantiles = {
  sampleCount: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
};

export type RuntimeTelemetrySnapshot = {
  windowMs: number;
  http: {
    active: number;
    latencyMs: DurationQuantiles;
  };
  artifacts: {
    writes: number;
    bytes: number;
    offloadedWrites: number;
    serializationMs: DurationQuantiles;
    storageMs: DurationQuantiles;
  };
};

export type ArtifactWriteTelemetry = {
  recordArtifactWrite(input: {
    byteCount: number;
    serializationMs: number;
    storageMs: number;
    offloaded: boolean;
  }): void;
};

function rounded(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function percentile(values: readonly number[], ratio: number): number {
  if (!values.length) return 0;
  const index = Math.min(
    values.length - 1,
    Math.max(0, Math.ceil(values.length * ratio) - 1),
  );
  return values[index]!;
}

function quantiles(samples: readonly TimedSample[]): DurationQuantiles {
  const values = samples
    .map((sample) => sample.durationMs)
    .sort((left, right) => left - right);
  return {
    sampleCount: values.length,
    p50Ms: rounded(percentile(values, 0.5)),
    p95Ms: rounded(percentile(values, 0.95)),
    p99Ms: rounded(percentile(values, 0.99)),
    maxMs: rounded(values.at(-1) ?? 0),
  };
}

function prune<T extends { at: number }>(
  samples: T[],
  minimumAt: number,
  maxSamples: number,
): void {
  let expired = 0;
  while (expired < samples.length && samples[expired]!.at < minimumAt) {
    expired += 1;
  }
  if (expired > 0) samples.splice(0, expired);
  if (samples.length > maxSamples) {
    samples.splice(0, samples.length - maxSamples);
  }
}

/**
 * Process-local, bounded telemetry for overload diagnosis. It deliberately
 * carries no route, owner, account, symbol, or run identifiers.
 */
export class RuntimeTelemetry implements ArtifactWriteTelemetry {
  private readonly httpSamples: TimedSample[] = [];
  private readonly artifactSamples: ArtifactSample[] = [];
  private readonly windowMs: number;
  private readonly maxSamples: number;
  private readonly wallNow: () => number;
  private readonly monotonicNow: () => number;
  private activeHttp = 0;

  readonly middleware: RequestHandler = (_request, response, next) => {
    const startedAt = this.monotonicNow();
    this.activeHttp += 1;
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      response.off("finish", settle);
      response.off("close", settle);
      this.activeHttp = Math.max(0, this.activeHttp - 1);
      const contentType = response.getHeader("Content-Type");
      if (typeof contentType === "string" && contentType.startsWith("text/event-stream")) {
        return;
      }
      this.httpSamples.push({
        at: this.wallNow(),
        durationMs: Math.max(0, this.monotonicNow() - startedAt),
      });
      this.prune();
    };
    response.once("finish", settle);
    response.once("close", settle);
    next();
  };

  constructor(options: {
    windowMs?: number;
    maxSamples?: number;
    wallNow?: () => number;
    monotonicNow?: () => number;
  } = {}) {
    this.windowMs = Math.max(1, Math.trunc(options.windowMs ?? DEFAULT_WINDOW_MS));
    this.maxSamples = Math.max(1, Math.trunc(options.maxSamples ?? DEFAULT_MAX_SAMPLES));
    this.wallNow = options.wallNow ?? Date.now;
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
  }

  recordArtifactWrite(input: {
    byteCount: number;
    serializationMs: number;
    storageMs: number;
    offloaded: boolean;
  }): void {
    this.artifactSamples.push({
      at: this.wallNow(),
      byteCount: Math.max(0, Math.trunc(input.byteCount)),
      durationMs: Math.max(0, input.serializationMs),
      storageMs: Math.max(0, input.storageMs),
      offloaded: input.offloaded,
    });
    this.prune();
  }

  snapshot(): RuntimeTelemetrySnapshot {
    this.prune();
    return {
      windowMs: this.windowMs,
      http: {
        active: this.activeHttp,
        latencyMs: quantiles(this.httpSamples),
      },
      artifacts: {
        writes: this.artifactSamples.length,
        bytes: this.artifactSamples.reduce((sum, sample) => sum + sample.byteCount, 0),
        offloadedWrites: this.artifactSamples.reduce(
          (sum, sample) => sum + Number(sample.offloaded),
          0,
        ),
        serializationMs: quantiles(this.artifactSamples),
        storageMs: quantiles(
          this.artifactSamples.map((sample) => ({
            at: sample.at,
            durationMs: sample.storageMs,
          })),
        ),
      },
    };
  }

  private prune(): void {
    const minimumAt = this.wallNow() - this.windowMs;
    prune(this.httpSamples, minimumAt, this.maxSamples);
    prune(this.artifactSamples, minimumAt, this.maxSamples);
  }
}
