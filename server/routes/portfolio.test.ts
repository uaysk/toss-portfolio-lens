import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
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

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  })));
});

describe("portfolio route", () => {
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
