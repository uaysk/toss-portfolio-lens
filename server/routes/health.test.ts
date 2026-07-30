import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { createHealthRouter, type HealthRouteDependencies } from "./health.js";

const servers: Server[] = [];

async function startServer(dependencies: HealthRouteDependencies): Promise<string> {
  const app = createApp({
    trustProxy: [],
    routeRegistrars: [
      (application) => application.use(createHealthRouter(dependencies)),
    ],
  });
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Health test server address is unavailable.");
  }
  return `http://127.0.0.1:${address.port}`;
}

function dependencies(
  overrides: Partial<HealthRouteDependencies> = {},
): HealthRouteDependencies {
  return {
    storageBackend: "sqlite",
    reportStorageBackend: "local",
    reportGenerationConfigured: false,
    exchangeRateFallback: "disabled",
    mcpEnabled: false,
    mcpAuthMode: "oauth",
    buildInfo: () => ({ gitSha: "test" }),
    executionMode: "rust_socket",
    rustSocketPath: "/tmp/compute.sock",
    rustSchedulerSnapshot: () => ({
      capacity: 2,
      active: 1,
      queued: 3,
      maxQueued: 32,
      rejectedTotal: 4,
      queueDelayMs: {
        sampleCount: 8,
        p50Ms: 2,
        p95Ms: 12,
        p99Ms: 15,
        maxMs: 15,
      },
    }),
    eventLoopLagSnapshot: () => ({
      sampleCount: 10,
      p95Ms: 1,
      p99Ms: 2,
      maxMs: 3,
    }),
    runtimeTelemetrySnapshot: () => ({
      windowMs: 300_000,
      http: { active: 1, latencyMs: { sampleCount: 2, p95Ms: 8 } },
      artifacts: { writes: 1, bytes: 1_024 },
    }),
    portfolioLiveSnapshot: () => ({
      capacity: 128,
      hubs: 2,
      activeHubs: 1,
      subscribers: 3,
      refreshesTotal: 10,
      changedTotal: 2,
      unchangedTotal: 8,
      rejectedTotal: 0,
      errorsTotal: 0,
    }),
    simulationEnabled: true,
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
});

describe("health route", () => {
  it("exposes additive Rust scheduler capacity and bounded queue telemetry", async () => {
    const baseUrl = await startServer(dependencies());
    const response = await fetch(`${baseUrl}/api/health`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "ok",
      runtime: {
        windowMs: 300_000,
        http: { active: 1 },
        artifacts: { writes: 1, bytes: 1_024 },
      },
      compute: {
        executionMode: "rust_socket",
        rustSocket: "/tmp/compute.sock",
        scheduler: {
          capacity: 2,
          active: 1,
          queued: 3,
          maxQueued: 32,
          rejectedTotal: 4,
          queueDelayMs: {
            sampleCount: 8,
            p50Ms: 2,
            p95Ms: 12,
            p99Ms: 15,
            maxMs: 15,
          },
        },
      },
      portfolio: {
        live: {
          capacity: 128,
          hubs: 2,
          activeHubs: 1,
          subscribers: 3,
          changedTotal: 2,
        },
      },
    });
  });

  it("does not read or expose Rust-only scheduler state in inline mode", async () => {
    const rustSchedulerSnapshot = vi.fn(() => ({ capacity: 2 }));
    const baseUrl = await startServer(dependencies({
      executionMode: "inline",
      rustSchedulerSnapshot,
    }));
    const response = await fetch(`${baseUrl}/api/health`);
    const body = await response.json() as { compute: Record<string, unknown> };

    expect(body.compute).not.toHaveProperty("rustSocket");
    expect(body.compute).not.toHaveProperty("scheduler");
    expect(rustSchedulerSnapshot).not.toHaveBeenCalled();
  });
});
