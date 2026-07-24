import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import type { McpResourceRegistry } from "../mcp/resources.js";
import type { McpToolDependencies } from "../mcp/tools/handlers.js";
import type { ArtifactService } from "../services/artifact-service.js";
import type { RunService } from "../services/run-service.js";
import type { TechnicalTradeMarkerService } from "../services/technical-trade-marker-service.js";
import { createDashboardToolsRouter } from "./dashboard-tools.js";

const servers: Server[] = [];

function dependencies(input: {
  runGet?: RunService["get"];
  getMarkers?: TechnicalTradeMarkerService["getMarkers"];
} = {}): Parameters<typeof createDashboardToolsRouter>[0] {
  const runs = {
    get: input.runGet ?? vi.fn(async () => undefined),
    cancel: vi.fn(async () => false),
  } as unknown as RunService;
  const artifacts = {
    shouldExternalize: vi.fn(() => false),
    list: vi.fn(async () => []),
    get: vi.fn(async () => undefined),
  } as unknown as ArtifactService;
  const resources = {
    getMarket: vi.fn(() => undefined),
  } as unknown as McpResourceRegistry;
  return {
    authenticate: (_request, _response, next) => next(),
    tools: {
      runs,
      artifacts,
      resources,
    } as McpToolDependencies,
    technicalTradeMarkerService: {
      getMarkers: input.getMarkers ?? vi.fn(async () => ({ markers: [] })),
    } as unknown as TechnicalTradeMarkerService,
  };
}

async function start(
  routeDependencies: Parameters<typeof createDashboardToolsRouter>[0],
): Promise<string> {
  const router = createDashboardToolsRouter(routeDependencies);
  const app = createApp({
    trustProxy: [],
    routeRegistrars: [(application) => application.use(router)],
  });
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server address is unavailable.");
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
});

describe("dashboard tools routes", () => {
  it("rejects tools outside the existing MCP inventory", async () => {
    const baseUrl = await start(dependencies());

    const response = await fetch(`${baseUrl}/api/portfolio/tools/place_order`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: {
        code: "TOOL_NOT_FOUND",
        message: "지원하지 않는 portfolio 도구입니다.",
      },
    });
  });

  it("preserves owner-scoped run lookup and its not-found response", async () => {
    const runGet = vi.fn(async () => undefined);
    const baseUrl = await start(dependencies({ runGet }));
    const runId = "123e4567-e89b-42d3-a456-426614174000";

    const response = await fetch(`${baseUrl}/api/portfolio/advanced/runs/${runId}`);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: {
        code: "RUN_NOT_FOUND",
        message: "실행 기록을 찾을 수 없습니다.",
      },
    });
    expect(runGet).toHaveBeenCalledExactlyOnceWith(runId, "owner");
  });

  it("normalizes technical marker symbols at the HTTP boundary", async () => {
    const payload = { markers: [{ symbol: "005930" }] };
    const getMarkers = vi.fn(async (
      ..._arguments: Parameters<TechnicalTradeMarkerService["getMarkers"]>
    ): Promise<Awaited<ReturnType<TechnicalTradeMarkerService["getMarkers"]>>> => (
      payload as unknown as Awaited<ReturnType<TechnicalTradeMarkerService["getMarkers"]>>
    ));
    const baseUrl = await start(dependencies({ getMarkers }));

    const response = await fetch(
      `${baseUrl}/api/portfolio/technical/trades?account=account-1&symbols=005930,aapl&from=2026-07-01`,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(payload);
    expect(getMarkers).toHaveBeenCalledExactlyOnceWith({
      accountId: "account-1",
      fromDate: "2026-07-01",
      symbols: ["005930", "AAPL"],
    });
  });
});
