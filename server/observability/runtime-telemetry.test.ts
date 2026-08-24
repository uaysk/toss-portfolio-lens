import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { RuntimeTelemetry } from "./runtime-telemetry.js";

class TestResponse extends EventEmitter {
  getHeader(): undefined {
    return undefined;
  }

  off(event: string, listener: (...args: unknown[]) => void): this {
    return super.off(event, listener);
  }
}

describe("RuntimeTelemetry", () => {
  it("keeps bounded rolling HTTP and artifact telemetry without request labels", () => {
    let wall = 1_000;
    let monotonic = 10;
    const telemetry = new RuntimeTelemetry({
      windowMs: 300,
      maxSamples: 2,
      wallNow: () => wall,
      monotonicNow: () => monotonic,
    });
    const response = new TestResponse();

    telemetry.middleware(
      {} as never,
      response as never,
      () => undefined,
    );
    expect(telemetry.snapshot().http.active).toBe(1);
    monotonic = 22.5;
    response.emit("finish");
    response.emit("close");

    telemetry.recordArtifactWrite({
      byteCount: 1_048_576,
      serializationMs: 8,
      storageMs: 3,
      offloaded: true,
    });
    telemetry.recordArtifactWrite({
      byteCount: 512,
      serializationMs: 2,
      storageMs: 1,
      offloaded: false,
    });

    expect(telemetry.snapshot()).toEqual({
      windowMs: 300,
      http: {
        active: 0,
        latencyMs: {
          sampleCount: 1,
          p50Ms: 12.5,
          p95Ms: 12.5,
          p99Ms: 12.5,
          maxMs: 12.5,
        },
      },
      artifacts: {
        writes: 2,
        bytes: 1_049_088,
        offloadedWrites: 1,
        serializationMs: {
          sampleCount: 2,
          p50Ms: 2,
          p95Ms: 8,
          p99Ms: 8,
          maxMs: 8,
        },
        storageMs: {
          sampleCount: 2,
          p50Ms: 1,
          p95Ms: 3,
          p99Ms: 3,
          maxMs: 3,
        },
      },
    });

    wall = 1_301;
    expect(telemetry.snapshot().artifacts.writes).toBe(0);
    expect(telemetry.snapshot().http.latencyMs.sampleCount).toBe(0);
  });

  it("retains the newest samples at capacity without changing the time window", () => {
    const telemetry = new RuntimeTelemetry({
      windowMs: 1_000,
      maxSamples: 2,
      wallNow: () => 1_000,
    });
    for (const byteCount of [1, 2, 4]) {
      telemetry.recordArtifactWrite({
        byteCount,
        serializationMs: byteCount,
        storageMs: byteCount,
        offloaded: false,
      });
    }

    expect(telemetry.snapshot().artifacts).toMatchObject({
      writes: 2,
      bytes: 6,
    });
  });
});
