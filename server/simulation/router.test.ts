import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  createSimulationRouter,
  type SimulationRouterDependencies,
  type SimulationRouterService,
} from "./router.js";
import { SimulationRunEventHub } from "./run-event-stream.js";

const RUN_ID = "550e8400-e29b-41d4-a716-446655440000";

function mockResponse() {
  const emitter = new EventEmitter();
  const response = {
    setHeader: vi.fn(),
    status: vi.fn(),
    json: vi.fn(),
    write: vi.fn((_chunk: unknown) => true),
    flushHeaders: vi.fn(),
    end: vi.fn(),
    on: vi.fn((name: string, listener: (...args: unknown[]) => void) => {
      emitter.on(name, listener);
      return response;
    }),
    once: vi.fn((name: string, listener: (...args: unknown[]) => void) => {
      emitter.once(name, listener);
      return response;
    }),
    off: vi.fn((name: string, listener: (...args: unknown[]) => void) => {
      emitter.off(name, listener);
      return response;
    }),
    emit: emitter.emit.bind(emitter),
    writableEnded: false,
    destroyed: false,
  };
  response.status.mockReturnValue(response);
  response.json.mockReturnValue(response);
  return response;
}

function routeHandler(
  router: ReturnType<typeof createSimulationRouter>,
  path: string,
  method: "get" | "post",
) {
  const layer = router.stack.find((candidate: {
    route?: { path?: string; stack?: Array<{ method?: string; handle: (...args: never[]) => unknown }> };
  }) => candidate.route?.path === path
    && candidate.route.stack?.some((entry) => entry.method === method));
  const route = layer?.route?.stack?.find((candidate) => candidate.method === method);
  if (!route) throw new Error(`Missing ${method.toUpperCase()} ${path}`);
  return route.handle as unknown as (
    request: Record<string, unknown>,
    response: ReturnType<typeof mockResponse>,
  ) => Promise<void>;
}

function service(overrides: Partial<SimulationRouterService> = {}): SimulationRouterService {
  return {
    status: vi.fn().mockResolvedValue({ enabled: true, capabilities: { realOrder: false, mcp: false } }),
    candidates: vi.fn().mockResolvedValue({
      scannerSnapshotId: "a".repeat(64),
      generatedAt: "2026-07-25T00:00:00.000Z",
      candidates: [],
    }),
    start: vi.fn().mockResolvedValue({ run: { id: RUN_ID, status: "running" } }),
    current: vi.fn().mockResolvedValue({ run: { id: RUN_ID, status: "running" } }),
    list: vi.fn().mockResolvedValue({ items: [{ runId: RUN_ID, status: "running" }] }),
    get: vi.fn().mockResolvedValue({ run: { id: RUN_ID, status: "running" } }),
    report: vi.fn().mockResolvedValue({ run: { runId: RUN_ID }, report: { tradeCount: 0 } }),
    cancel: vi.fn().mockResolvedValue({ run: { id: RUN_ID, status: "cancel_requested" } }),
    ...overrides,
  };
}

function router(input?: {
  enabled?: boolean;
  service?: SimulationRouterService;
  ownerSubject?: string;
  events?: SimulationRunEventHub;
  sseConnections?: SimulationRouterDependencies["sseConnections"];
}) {
  const authenticate = vi.fn((_request, _response, next) => next());
  return {
    authenticate,
    value: createSimulationRouter({
      authenticate,
      service: input?.service,
      events: input?.events,
      sseConnections: input?.sseConnections,
      config: {
        enabled: input?.enabled ?? true,
        maxDurationMinutes: 390,
        ...(input?.ownerSubject ? { ownerSubject: input.ownerSubject } : {}),
      },
    }),
  };
}

describe("AI paper simulation session-only router", () => {
  it("registers only the dedicated dashboard routes behind session authentication", () => {
    const created = router({ enabled: false });
    expect(created.value.stack[0]?.handle).toBe(created.authenticate);
    const next = vi.fn();
    created.value.stack[0]!.handle({} as never, {} as never, next);
    expect(created.authenticate).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(1);

    const paths = created.value.stack
      .map((layer: { route?: { path?: string } }) => layer.route?.path)
      .filter(Boolean);
    expect(paths).toEqual([
      "/status",
      "/candidates",
      "/runs",
      "/runs",
      "/runs/current",
      "/runs/:runId/report",
      "/runs/:runId/events",
      "/runs/:runId",
      "/runs/:runId/cancel",
    ]);
    expect(paths.some((path) => /order|mcp/i.test(String(path)))).toBe(false);
  });

  it("replays only revisions after Last-Event-ID, emits terminal, and cleans up disconnects", async () => {
    const events = new SimulationRunEventHub();
    events.publishSnapshot({
      runId: RUN_ID,
      ownerSubject: "owner",
      status: "running",
      payload: { snapshot: { progress: 0 } },
    });
    events.publishProgress({
      runId: RUN_ID,
      ownerSubject: "owner",
      status: "running",
      payload: { progress: 0.5 },
    });
    events.publishTerminal({
      runId: RUN_ID,
      ownerSubject: "owner",
      status: "completed",
      payload: { snapshot: { progress: 1 } },
    });
    const unregister = vi.fn();
    const tracker = {
      track: vi.fn(() => unregister),
    };
    const created = router({
      service: service({
        get: vi.fn().mockResolvedValue({
          run: { id: RUN_ID, status: "completed" },
          snapshot: { phase: "completed", progress: 1 },
        }),
      }),
      events,
      sseConnections: tracker as never,
    });
    const requestEvents = new EventEmitter();
    const request = Object.assign(requestEvents, {
      params: { runId: RUN_ID },
      query: {},
      get: (name: string) => name.toLowerCase() === "last-event-id" ? "1" : undefined,
    });
    const response = mockResponse();

    await routeHandler(created.value, "/runs/:runId/events", "get")(
      request as unknown as Record<string, unknown>,
      response,
    );

    const output = response.write.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(output).not.toContain("id: 1\n");
    expect(output).toContain("id: 2\nevent: progress");
    expect(output).toContain("id: 3\nevent: terminal");
    expect(output).toContain("\"schemaVersion\":1");
    expect(output).toContain("\"payload\":");
    expect(output).not.toContain("\"data\":");
    expect(response.flushHeaders).toHaveBeenCalledTimes(1);
    expect(events.telemetry.activeConnections).toBe(1);
    expect(tracker.track).toHaveBeenCalledTimes(1);

    requestEvents.emit("close");
    expect(events.telemetry.activeConnections).toBe(0);
    expect(unregister).toHaveBeenCalledTimes(1);
  });

  it("reports disabled status without invoking a service and returns 503 for execution", async () => {
    const created = router({ enabled: false });
    const statusResponse = mockResponse();
    await routeHandler(created.value, "/status", "get")({}, statusResponse);
    expect(statusResponse.json).toHaveBeenCalledWith(expect.objectContaining({
      enabled: false,
      capabilities: expect.objectContaining({
        realOrder: false,
        mcp: false,
        orderApiDependency: false,
      }),
    }));
    expect(statusResponse.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store, max-age=0");

    const startResponse = mockResponse();
    await routeHandler(created.value, "/runs", "post")({ body: {} }, startResponse);
    expect(startResponse.status).toHaveBeenCalledWith(503);
    expect(startResponse.json).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.objectContaining({ code: "simulation-disabled" }),
    }));
  });

  it("validates and starts a simulation with defaults under the configured owner", async () => {
    const api = service();
    const created = router({ service: api });
    const response = mockResponse();
    await routeHandler(created.value, "/runs", "post")({
      body: {
        initialCash: 1_000_000,
        durationMinutes: 30,
        selection: { mode: "auto", symbolCount: 2 },
      },
    }, response);

    expect(api.start).toHaveBeenCalledWith({
      contractVersion: "ai-paper-simulation/v8",
      sourceContractVersion: "ai-paper-simulation/v7",
      marketCountry: "KR",
      market: { kind: "stock", country: "KR" },
      initialCash: 1_000_000,
      durationMinutes: 30,
      selection: {
        mode: "auto",
        criterion: "trading_amount",
        symbolCount: 2,
      },
      preset: "risk_management",
      riskTolerance: 50,
      costs: {
        commissionBpsPerSide: 1.5,
        taxBpsOnExit: 20,
        spreadBpsRoundTrip: 5,
        slippageBpsPerSide: 2,
      },
      modelLanes: ["fincast"],
      modelPlan: [{
        symbol: "*",
        modelLane: "fincast",
        role: "primary",
        required: true,
        preferredHorizonsMinutes: [15, 30, 60],
      }],
      fincastCandleSeconds: 60,
      execution: { mode: "paper" },
    }, "owner");
    expect(response.status).toHaveBeenCalledWith(202);
  });

  it("accepts the explicit v8 BTC·ETH modelPlan emitted by the simulation UI", async () => {
    const api = service();
    const created = router({ service: api });
    const response = mockResponse();
    await routeHandler(created.value, "/runs", "post")({
      body: {
        contractVersion: "ai-paper-simulation/v8",
        simulationCase: "btc_eth",
        market: {
          kind: "crypto_futures",
          venue: "BINANCE_USDM",
          quoteAsset: "USDT",
          contractType: "PERPETUAL",
        },
        initialCash: 10_000,
        durationMinutes: 120,
        selection: { mode: "manual", symbols: ["BTCUSDT", "ETHUSDT"] },
        strategy: { mode: "single" },
        preset: "risk_management",
        riskTolerance: 25,
        costs: {
          commissionBpsPerSide: 4,
          taxBpsOnExit: 0,
          spreadBpsRoundTrip: 2,
          slippageBpsPerSide: 1,
        },
        riskLimits: {
          riskPerTradeRate: 0.005,
          dailyLossLimitRate: 0.03,
          maximumLeverage: 15,
          grossExposureLimitRate: 1.5,
          marginUsageLimitRate: 0.2,
          liquidationBufferMultiple: 2,
        },
        modelLanes: ["chronos2", "fincast"],
        modelPlan: [
          {
            symbol: "BTCUSDT",
            modelLane: "chronos2",
            role: "primary",
            required: true,
            preferredHorizonsMinutes: [30, 60, 15],
          },
          {
            symbol: "BTCUSDT",
            modelLane: "fincast",
            role: "veto",
            required: true,
            preferredHorizonsMinutes: [30, 60, 15],
          },
          {
            symbol: "ETHUSDT",
            modelLane: "fincast",
            role: "primary",
            required: true,
            preferredHorizonsMinutes: [15, 30, 60],
          },
          {
            symbol: "ETHUSDT",
            modelLane: "chronos2",
            role: "shadow",
            required: false,
            preferredHorizonsMinutes: [15, 30, 60],
          },
        ],
        fincastCandleSeconds: 60,
        execution: { mode: "paper" },
      },
    }, response);

    expect(api.start).toHaveBeenCalledWith(expect.objectContaining({
      contractVersion: "ai-paper-simulation/v8",
      sourceContractVersion: "ai-paper-simulation/v8",
      simulationCase: "btc_eth",
      modelLanes: ["chronos2", "fincast"],
      modelPlan: expect.arrayContaining([
        expect.objectContaining({ symbol: "BTCUSDT", modelLane: "chronos2", role: "primary" }),
        expect.objectContaining({ symbol: "BTCUSDT", modelLane: "fincast", role: "veto" }),
        expect.objectContaining({ symbol: "ETHUSDT", modelLane: "fincast", role: "primary" }),
        expect.objectContaining({ symbol: "ETHUSDT", modelLane: "chronos2", role: "shadow" }),
      ]),
    }), "owner");
    expect(response.status).toHaveBeenCalledWith(202);
  });

  it("returns a bounded crypto candidate snapshot using the requested criterion", async () => {
    const api = service();
    const created = router({ service: api });
    const response = mockResponse();
    await routeHandler(created.value, "/candidates", "get")({
      query: { criterion: "volatility" },
    }, response);
    expect(api.candidates).toHaveBeenCalledWith({ criterion: "volatility" }, "owner");
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      scannerSnapshotId: "a".repeat(64),
      candidates: [],
    }));
  });

  it("returns 400 without starting when the strict request is invalid", async () => {
    const api = service();
    const created = router({ service: api });
    const response = mockResponse();
    await routeHandler(created.value, "/runs", "post")({
      body: {
        initialCash: 99_999,
        durationMinutes: 391,
        selection: { mode: "auto", symbolCount: 3 },
        realOrder: true,
      },
    }, response);
    expect(api.start).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.objectContaining({ code: "invalid-simulation-request" }),
    }));
  });

  it("gets and cancels an owned simulation run", async () => {
    const api = service();
    const created = router({ service: api, ownerSubject: "dashboard-owner" });
    const getResponse = mockResponse();
    await routeHandler(created.value, "/runs/:runId", "get")({
      params: { runId: RUN_ID },
    }, getResponse);
    expect(api.get).toHaveBeenCalledWith(RUN_ID, "dashboard-owner");
    expect(getResponse.json).toHaveBeenCalledWith({ run: { id: RUN_ID, status: "running" } });

    const cancelResponse = mockResponse();
    await routeHandler(created.value, "/runs/:runId/cancel", "post")({
      params: { runId: RUN_ID },
    }, cancelResponse);
    expect(api.cancel).toHaveBeenCalledWith(RUN_ID, "dashboard-owner");
    expect(cancelResponse.json).toHaveBeenCalledWith({
      run: { id: RUN_ID, status: "cancel_requested" },
    });
  });

  it("restores the current owner run without requiring a browser-stored run id", async () => {
    const api = service();
    const created = router({ service: api, ownerSubject: "dashboard-owner" });
    const response = mockResponse();
    await routeHandler(created.value, "/runs/current", "get")({}, response);
    expect(api.current).toHaveBeenCalledWith("dashboard-owner");
    expect(response.json).toHaveBeenCalledWith({ run: { id: RUN_ID, status: "running" } });

    const absent = service({ current: vi.fn().mockResolvedValue(undefined) });
    const absentResponse = mockResponse();
    await routeHandler(router({ service: absent }).value, "/runs/current", "get")({}, absentResponse);
    expect(absentResponse.json).toHaveBeenCalledWith({ run: null, snapshot: null });
  });

  it("lists only the configured owner's history with bounded status filters", async () => {
    const api = service();
    const created = router({ service: api, ownerSubject: "dashboard-owner" });
    const response = mockResponse();
    await routeHandler(created.value, "/runs", "get")({
      query: {
        limit: "12",
        cursor: "opaque-cursor",
        status: ["completed", "failed", "completed"],
      },
    }, response);

    expect(api.list).toHaveBeenCalledWith({
      limit: 12,
      cursor: "opaque-cursor",
      statuses: ["completed", "failed"],
    }, "dashboard-owner");
    expect(response.json).toHaveBeenCalledWith({
      items: [{ runId: RUN_ID, status: "running" }],
    });
    expect(response.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store, max-age=0");
  });

  it("returns an owned run report and rejects invalid history filters", async () => {
    const api = service();
    const created = router({ service: api, ownerSubject: "dashboard-owner" });
    const reportResponse = mockResponse();
    await routeHandler(created.value, "/runs/:runId/report", "get")({
      params: { runId: RUN_ID },
    }, reportResponse);
    expect(api.report).toHaveBeenCalledWith(RUN_ID, "dashboard-owner");
    expect(reportResponse.json).toHaveBeenCalledWith({
      run: { runId: RUN_ID },
      report: { tradeCount: 0 },
    });

    const invalidResponse = mockResponse();
    await routeHandler(created.value, "/runs", "get")({
      query: { limit: "51", status: "completed,unknown" },
    }, invalidResponse);
    expect(invalidResponse.status).toHaveBeenCalledWith(400);
    expect(api.list).toHaveBeenCalledTimes(0);
  });

  it("returns 404 for an absent run and 400 for an invalid run id", async () => {
    const api = service({
      get: vi.fn().mockResolvedValue(undefined),
      report: vi.fn().mockResolvedValue(undefined),
      cancel: vi.fn().mockResolvedValue(false),
    });
    const created = router({ service: api });

    const missingResponse = mockResponse();
    await routeHandler(created.value, "/runs/:runId", "get")({
      params: { runId: RUN_ID },
    }, missingResponse);
    expect(missingResponse.status).toHaveBeenCalledWith(404);

    const cancelledResponse = mockResponse();
    await routeHandler(created.value, "/runs/:runId/cancel", "post")({
      params: { runId: RUN_ID },
    }, cancelledResponse);
    expect(cancelledResponse.status).toHaveBeenCalledWith(404);

    const missingReportResponse = mockResponse();
    await routeHandler(created.value, "/runs/:runId/report", "get")({
      params: { runId: RUN_ID },
    }, missingReportResponse);
    expect(missingReportResponse.status).toHaveBeenCalledWith(404);

    const invalidResponse = mockResponse();
    await routeHandler(created.value, "/runs/:runId", "get")({
      params: { runId: "not-a-run-id" },
    }, invalidResponse);
    expect(invalidResponse.status).toHaveBeenCalledWith(400);
    expect(api.get).toHaveBeenCalledTimes(1);
  });
});
