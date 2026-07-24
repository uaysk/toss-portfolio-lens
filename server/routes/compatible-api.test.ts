import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import type { PortfolioHistoryStore } from "../history.js";
import type { TossClient } from "../toss.js";
import { createCompatibleApiRouter } from "./compatible-api.js";

const servers: Server[] = [];

async function start(input: {
  toss?: Partial<TossClient>;
  historyStore?: Partial<PortfolioHistoryStore>;
  authenticate?: Parameters<typeof createCompatibleApiRouter>[0]["authenticate"];
} = {}): Promise<string> {
  const router = createCompatibleApiRouter({
    authenticate: input.authenticate ?? ((_request, _response, next) => next()),
    toss: input.toss as TossClient,
    historyStore: {
      getCachedCandleResponse: vi.fn(async () => undefined),
      cacheCandleResponse: vi.fn(async () => undefined),
      ...input.historyStore,
    } as PortfolioHistoryStore,
    candleCacheLatestTtlMs: 1_000,
  });
  const app = createApp({
    trustProxy: [],
    routeRegistrars: [
      (application) => application.use(router),
      (application) => application.use("/api", (_request, response) => {
        response.status(404).json({ error: { code: "api-not-found" } });
      }),
    ],
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

describe("read-only compatible API router", () => {
  it("keeps authentication in front of every compatible endpoint", async () => {
    const getCompatibleAccounts = vi.fn(async () => ({ accounts: [] }));
    const baseUrl = await start({
      toss: { getCompatibleAccounts } as Partial<TossClient>,
      authenticate: (_request, response) => {
        response.status(401).json({ error: { code: "unauthorized" } });
      },
    });

    const response = await fetch(`${baseUrl}/api/v1/accounts`);

    expect(response.status).toBe(401);
    expect(getCompatibleAccounts).not.toHaveBeenCalled();
  });

  it("preserves account-header validation and the read-only allowlist fallback", async () => {
    const baseUrl = await start({ toss: {} });

    const holdings = await fetch(`${baseUrl}/api/v1/holdings`);
    expect(holdings.status).toBe(400);
    expect(await holdings.json()).toEqual({
      error: {
        code: "account-header-required",
        message: "X-Tossinvest-Account 헤더가 필요합니다.",
      },
    });

    const unsupported = await fetch(`${baseUrl}/api/v1/orders`, { method: "POST" });
    expect(unsupported.status).toBe(404);
    expect(unsupported.headers.get("content-type")).toContain("application/json");
    expect(await unsupported.json()).toEqual({
      error: {
        code: "operation-not-supported",
        message: "이 호환 API는 허용된 조회 전용 기능만 제공합니다.",
      },
    });
  });

  it("serves a cached candle response without calling the upstream provider", async () => {
    const payload = {
      candles: [{
        timestamp: "2026-07-24T00:00:00.000Z",
        open: 100,
        high: 101,
        low: 99,
        close: 100,
        volume: 10,
      }],
    };
    const getReadOnlyMarketData = vi.fn();
    const baseUrl = await start({
      toss: { getReadOnlyMarketData } as Partial<TossClient>,
      historyStore: {
        getCachedCandleResponse: vi.fn(async () => payload),
      },
    });

    const response = await fetch(
      `${baseUrl}/api/v1/candles?symbol=005930&interval=1d&count=1&adjusted=false`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-portfolio-candle-cache")).toBe("HIT");
    expect(await response.json()).toEqual(payload);
    expect(getReadOnlyMarketData).not.toHaveBeenCalled();
  });
});
