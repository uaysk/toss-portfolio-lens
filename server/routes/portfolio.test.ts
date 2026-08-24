import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import type { PortfolioEventV1 } from "../contracts/portfolio-events.js";
import { SseConnectionTracker } from "../lifecycle.js";
import { PortfolioLiveHub } from "../portfolio/live-hub.js";
import type { Portfolio } from "../toss.js";
import { TossApiError } from "../toss.js";
import { createPortfolioRouter } from "./portfolio.js";

const servers: Server[] = [];

const portfolio: Portfolio = {
  asOf: "2026-07-24T00:00:00.000Z",
  accounts: [{ id: "account-1", name: "기본 계좌", label: "기본 계좌", type: "STOCK" }],
  selectedAccountId: "account-1",
  account: { id: "account-1", name: "기본 계좌", label: "기본 계좌", type: "STOCK" },
  summary: {
    evaluationAmount: { KRW: 1_000_000, USD: 0 },
    purchaseAmount: { KRW: 900_000, USD: 0 },
    profitLoss: { KRW: 100_000, USD: 0 },
    dailyProfitLoss: { KRW: 10_000, USD: 0 },
    profitRate: 11.1111,
    dailyProfitRate: 1,
    positionCount: 0,
  },
  holdings: [],
};

async function startServer(routeRegistrars: Parameters<typeof createApp>[0]["routeRegistrars"]): Promise<string> {
  const app = createApp({ trustProxy: [], routeRegistrars });
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server address is unavailable.");
  return `http://127.0.0.1:${address.port}`;
}

function directSseRequest() {
  return Object.assign(new EventEmitter(), {
    destroyed: false,
    query: { account: "account-1" },
    get: vi.fn().mockReturnValue(undefined),
  });
}

function directSseResponse() {
  const response = Object.assign(new EventEmitter(), {
    destroyed: false,
    writableEnded: false,
    status: vi.fn(),
    setHeader: vi.fn(),
    json: vi.fn(),
    flushHeaders: vi.fn(),
    write: vi.fn().mockReturnValue(true),
    end: vi.fn(),
  });
  response.status.mockReturnValue(response);
  response.json.mockReturnValue(response);
  return response;
}

function portfolioEventHandler(router: ReturnType<typeof createPortfolioRouter>) {
  const route = router.stack.find(
    (layer: { route?: { path?: string } }) => layer.route?.path === "/api/portfolio/events",
  ) as any;
  return route.route.stack.at(-1).handle as (
    request: unknown,
    response: unknown,
  ) => Promise<void>;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  })));
});

describe("portfolio route", () => {
  it("shares event serialization across synchronous subscribers without retaining it", async () => {
    const listeners: Array<(event: PortfolioEventV1) => void> = [];
    const release = vi.fn();
    const payloadToJson = vi.fn(() => portfolio);
    const event: PortfolioEventV1 = {
      schemaVersion: 1,
      accountId: "account-1",
      revision: 1,
      emittedAt: "2026-07-24T00:00:00.000Z",
      type: "changed",
      payload: {
        toJSON: payloadToJson,
      } as unknown as Portfolio,
    };
    const live = {
      subscribe: vi.fn((_owner, _account, listener: (value: PortfolioEventV1) => void) => {
        listeners.push(listener);
        return { ready: Promise.resolve(event), release };
      }),
      snapshotAfter: vi.fn().mockReturnValue(undefined),
    };
    const router = createPortfolioRouter({
      authenticate: (_request, _response, next) => next(),
      getPortfolio: vi.fn(async () => portfolio),
      recordPortfolio: vi.fn(async () => undefined),
      live: live as never,
    });
    const handler = portfolioEventHandler(router);
    const requests = [directSseRequest(), directSseRequest()];
    const responses = [directSseResponse(), directSseResponse()];
    await Promise.all(requests.map((request, index) => handler(request, responses[index])));

    listeners[0](event);
    listeners[1](event);

    expect(payloadToJson).toHaveBeenCalledTimes(1);
    expect(responses[0].write).toHaveBeenCalledWith(responses[1].write.mock.calls[0][0]);

    await Promise.resolve();
    event.revision = 2;
    listeners[0](event);
    expect(payloadToJson).toHaveBeenCalledTimes(2);

    requests.forEach((request) => request.emit("close"));
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("returns 503 before SSE headers or portfolio subscription when the shared cap is full", async () => {
    const tracker = new SseConnectionTracker({ maximumConnections: 1 });
    const held = directSseResponse();
    const releaseHeld = tracker.track(held as never, vi.fn());
    const live = {
      subscribe: vi.fn(),
      snapshotAfter: vi.fn(),
    };
    const router = createPortfolioRouter({
      authenticate: (_request, _response, next) => next(),
      getPortfolio: vi.fn(async () => portfolio),
      recordPortfolio: vi.fn(async () => undefined),
      live: live as never,
      sseConnections: tracker,
    });
    const response = directSseResponse();

    await portfolioEventHandler(router)(directSseRequest(), response);

    expect(response.status).toHaveBeenCalledWith(503);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.objectContaining({ code: "SSE_CONNECTION_BUSY", retryable: true }),
    }));
    expect(response.flushHeaders).not.toHaveBeenCalled();
    expect(response.setHeader).not.toHaveBeenCalledWith(
      "Content-Type",
      "text/event-stream; charset=utf-8",
    );
    expect(live.subscribe).not.toHaveBeenCalled();
    releaseHeld();
  });

  it("releases the shared slot before returning the portfolio hub capacity error", async () => {
    const live = new PortfolioLiveHub({
      getPortfolio: vi.fn(async () => portfolio),
      refreshIntervalMs: 10_000,
      maxListenersPerHub: 1,
    });
    const held = live.subscribe("owner", "account-1", vi.fn());
    await held.ready;
    const tracker = new SseConnectionTracker({ maximumConnections: 1 });
    const router = createPortfolioRouter({
      authenticate: (_request, _response, next) => next(),
      getPortfolio: vi.fn(async () => portfolio),
      recordPortfolio: vi.fn(async () => undefined),
      live,
      sseConnections: tracker,
    });
    const response = directSseResponse();
    let activeAt503 = -1;
    response.status.mockImplementation((status: number) => {
      if (status === 503) activeAt503 = tracker.size;
      return response;
    });

    await portfolioEventHandler(router)(directSseRequest(), response);

    expect(activeAt503).toBe(0);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.objectContaining({ code: "PORTFOLIO_LIVE_BUSY", retryable: true }),
    }));
    expect(response.flushHeaders).not.toHaveBeenCalled();
    expect(tracker.telemetry).toMatchObject({
      activeConnections: 0,
      acceptedConnectionsTotal: 1,
      rejectedConnectionsTotal: 0,
    });
    expect(live.telemetry.subscribers).toBe(1);
    held.release();
    await live.close();
  });

  it("registers through createApp, forwards query flags, and preserves the exact response", async () => {
    const getPortfolio = vi.fn(async () => portfolio);
    const recordPortfolio = vi.fn(async () => undefined);
    const router = createPortfolioRouter({
      authenticate: (_request, _response, next) => next(),
      getPortfolio,
      recordPortfolio,
    });
    const baseUrl = await startServer([
      (app) => app.use(router),
      (app) => app.use("/api", (_request, response) => response.status(404).json({ fallback: true })),
    ]);

    const response = await fetch(`${baseUrl}/api/portfolio?account=account-1&refresh=1&snapshot=0`);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
    expect(await response.json()).toEqual(portfolio);
    expect(getPortfolio).toHaveBeenCalledExactlyOnceWith("account-1", true);
    expect(recordPortfolio).not.toHaveBeenCalled();
  });

  it("records a snapshot by default without failing the portfolio response when persistence fails", async () => {
    const persistenceError = new Error("database unavailable");
    const logError = vi.fn();
    const router = createPortfolioRouter({
      authenticate: (_request, _response, next) => next(),
      getPortfolio: vi.fn(async () => portfolio),
      recordPortfolio: vi.fn(async () => {
        throw persistenceError;
      }),
      logError,
    });
    const baseUrl = await startServer([(app) => app.use(router)]);

    const response = await fetch(`${baseUrl}/api/portfolio`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(portfolio);
    expect(logError).toHaveBeenCalledExactlyOnceWith("history", persistenceError);
  });

  it("preserves upstream status and requestId while sanitizing unexpected failures", async () => {
    const upstreamRouter = createPortfolioRouter({
      authenticate: (_request, _response, next) => next(),
      getPortfolio: vi.fn(async () => {
        throw new TossApiError("요청 한도를 초과했습니다.", 429, "rate-limited", "request-123");
      }),
      recordPortfolio: vi.fn(async () => undefined),
    });
    const unexpectedLog = vi.fn();
    const unexpectedRouter = createPortfolioRouter({
      authenticate: (_request, _response, next) => next(),
      getPortfolio: vi.fn(async () => {
        throw new Error("private upstream detail");
      }),
      recordPortfolio: vi.fn(async () => undefined),
      logError: unexpectedLog,
    });
    const upstreamBaseUrl = await startServer([(app) => app.use(upstreamRouter)]);
    const unexpectedBaseUrl = await startServer([(app) => app.use(unexpectedRouter)]);

    const upstreamResponse = await fetch(`${upstreamBaseUrl}/api/portfolio`);
    expect(upstreamResponse.status).toBe(429);
    expect(await upstreamResponse.json()).toEqual({
      error: {
        code: "rate-limited",
        message: "요청 한도를 초과했습니다.",
        requestId: "request-123",
      },
    });

    const unexpectedResponse = await fetch(`${unexpectedBaseUrl}/api/portfolio`);
    expect(unexpectedResponse.status).toBe(502);
    const unexpectedPayload = await unexpectedResponse.json();
    expect(unexpectedPayload).toEqual({
      error: {
        code: "portfolio-unavailable",
        message: "포트폴리오를 불러오는 중 예기치 못한 오류가 발생했습니다.",
      },
    });
    expect(JSON.stringify(unexpectedPayload)).not.toContain("private upstream detail");
    expect(unexpectedLog).toHaveBeenCalledOnce();
  });

  it("resets a future SSE cursor to the current safe revision and tracks disconnects", async () => {
    const live = new PortfolioLiveHub({
      getPortfolio: vi.fn(async () => portfolio),
      refreshIntervalMs: 10_000,
    });
    const sseConnections = new SseConnectionTracker();
    const router = createPortfolioRouter({
      authenticate: (_request, _response, next) => next(),
      getPortfolio: vi.fn(async () => portfolio),
      recordPortfolio: vi.fn(async () => undefined),
      live,
      sseConnections,
      heartbeatMs: 1_000,
    });
    const baseUrl = await startServer([(app) => app.use(router)]);
    const abort = new AbortController();

    const response = await fetch(
      `${baseUrl}/api/portfolio/events?account=account-1&lastEventId=${Number.MAX_SAFE_INTEGER}`,
      { signal: abort.signal },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(sseConnections.size).toBe(1);
    const reader = response.body!.getReader();
    const read = await reader.read();
    const chunk = new TextDecoder().decode(read.value);
    expect(chunk).toContain("id: 1");
    expect(chunk).not.toContain(`id: ${Number.MAX_SAFE_INTEGER}`);
    expect(chunk).toContain("event: snapshot");
    expect(chunk).toContain('"schemaVersion":1');
    expect(chunk).toContain('"selectedAccountId":"account-1"');

    abort.abort();
    await reader.cancel().catch(() => undefined);
    await vi.waitFor(() => expect(sseConnections.size).toBe(0), { timeout: 1_000 });
    await live.close();
  });
});
