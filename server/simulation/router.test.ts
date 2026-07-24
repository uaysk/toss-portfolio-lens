import { describe, expect, it, vi } from "vitest";
import { createSimulationRouter, type SimulationRouterService } from "./router.js";

const RUN_ID = "550e8400-e29b-41d4-a716-446655440000";

function mockResponse() {
  const response: Record<string, ReturnType<typeof vi.fn>> = {
    setHeader: vi.fn(),
    status: vi.fn(),
    json: vi.fn(),
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
  }) => candidate.route?.path === path);
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
    start: vi.fn().mockResolvedValue({ run: { id: RUN_ID, status: "running" } }),
    current: vi.fn().mockResolvedValue({ run: { id: RUN_ID, status: "running" } }),
    get: vi.fn().mockResolvedValue({ run: { id: RUN_ID, status: "running" } }),
    cancel: vi.fn().mockResolvedValue({ run: { id: RUN_ID, status: "cancel_requested" } }),
    ...overrides,
  };
}

function router(input?: {
  enabled?: boolean;
  service?: SimulationRouterService;
  ownerSubject?: string;
}) {
  const authenticate = vi.fn((_request, _response, next) => next());
  return {
    authenticate,
    value: createSimulationRouter({
      authenticate,
      service: input?.service,
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
    expect(paths).toEqual(["/status", "/runs", "/runs/current", "/runs/:runId", "/runs/:runId/cancel"]);
    expect(paths.some((path) => /order|mcp/i.test(String(path)))).toBe(false);
  });

  it("reports disabled status without invoking a service and returns 503 for execution", async () => {
    const created = router({ enabled: false });
    const statusResponse = mockResponse();
    await routeHandler(created.value, "/status", "get")({}, statusResponse);
    expect(statusResponse.json).toHaveBeenCalledWith(expect.objectContaining({
      enabled: false,
      capabilities: expect.objectContaining({ realOrder: false, mcp: false }),
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
      body: { initialCash: 1_000_000, durationMinutes: 30, symbolCount: 2 },
    }, response);

    expect(api.start).toHaveBeenCalledWith({
      marketCountry: "KR",
      criterion: "trading_amount",
      initialCash: 1_000_000,
      durationMinutes: 30,
      symbolCount: 2,
      preset: "risk_management",
      costs: {
        commissionBpsPerSide: 1.5,
        taxBpsOnExit: 18,
        spreadBpsRoundTrip: 5,
        slippageBpsPerSide: 2,
      },
    }, "owner");
    expect(response.status).toHaveBeenCalledWith(202);
  });

  it("returns 400 without starting when the strict request is invalid", async () => {
    const api = service();
    const created = router({ service: api });
    const response = mockResponse();
    await routeHandler(created.value, "/runs", "post")({
      body: {
        initialCash: 99_999,
        durationMinutes: 391,
        symbolCount: 3,
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

  it("returns 404 for an absent run and 400 for an invalid run id", async () => {
    const api = service({
      get: vi.fn().mockResolvedValue(undefined),
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

    const invalidResponse = mockResponse();
    await routeHandler(created.value, "/runs/:runId", "get")({
      params: { runId: "not-a-run-id" },
    }, invalidResponse);
    expect(invalidResponse.status).toHaveBeenCalledWith(400);
    expect(api.get).toHaveBeenCalledTimes(1);
  });
});
