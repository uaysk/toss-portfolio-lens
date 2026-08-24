import type { RequestHandler } from "express";
import { durationQuantiles, type DurationQuantiles } from "./duration-quantiles.js";
import { FixedRing } from "../fixed-ring.js";

export type { DurationQuantiles } from "./duration-quantiles.js";

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

/**
 * Process-local, bounded telemetry for overload diagnosis. It deliberately
 * carries no route, owner, account, symbol, or run identifiers.
 */
export class RuntimeTelemetry implements ArtifactWriteTelemetry {
  private readonly httpSamples: FixedRing<TimedSample>;
  private readonly artifactSamples: FixedRing<ArtifactSample>;
  private readonly windowMs: number;
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
    const maxSamples = Math.max(1, Math.trunc(options.maxSamples ?? DEFAULT_MAX_SAMPLES));
    this.httpSamples = new FixedRing(maxSamples);
    this.artifactSamples = new FixedRing(maxSamples);
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
  }

  snapshot(): RuntimeTelemetrySnapshot {
    const minimumAt = this.wallNow() - this.windowMs;
    const httpSamples = this.httpSamples.values().filter((sample) => sample.at >= minimumAt);
    const artifactSamples = this.artifactSamples.values().filter((sample) => sample.at >= minimumAt);
    return {
      windowMs: this.windowMs,
      http: {
        active: this.activeHttp,
        latencyMs: durationQuantiles(httpSamples, (sample) => sample.durationMs),
      },
      artifacts: {
        writes: artifactSamples.length,
        bytes: artifactSamples.reduce((sum, sample) => sum + sample.byteCount, 0),
        offloadedWrites: artifactSamples.reduce(
          (sum, sample) => sum + Number(sample.offloaded),
          0,
        ),
        serializationMs: durationQuantiles(artifactSamples, (sample) => sample.durationMs),
        storageMs: durationQuantiles(artifactSamples, (sample) => sample.storageMs),
      },
    };
  }
}
