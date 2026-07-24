import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PortfolioAnalysisService } from "../analysis.js";
import { createApp } from "../app.js";
import type { HistoricalPortfolioBackfill } from "../backfill.js";
import type { PortfolioBacktestService } from "../backtest.js";
import type { PortfolioHistoryStore } from "../history.js";
import type { BacktestService } from "../services/backtest-service.js";
import type { TossClient } from "../toss.js";
import { createPortfolioDataRouter } from "./portfolio-data.js";

const servers: Server[] = [];

function dependencies(input: {
  historyStore?: Partial<PortfolioHistoryStore>;
  backtests?: Partial<BacktestService>;
} = {}): Parameters<typeof createPortfolioDataRouter>[0] {
  return {
    authenticate: (_request, _response, next) => next(),
    toss: {} as TossClient,
    historyStore: input.historyStore as PortfolioHistoryStore,
    historicalBackfill: {} as HistoricalPortfolioBackfill,
    portfolioAnalysis: {} as PortfolioAnalysisService,
    portfolioBacktest: {} as PortfolioBacktestService,
    backtests: input.backtests as BacktestService,
  };
}

async function start(
  routeDependencies: Parameters<typeof createPortfolioDataRouter>[0],
): Promise<string> {
  const router = createPortfolioDataRouter(routeDependencies);
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

describe("portfolio data routes", () => {
  it("rejects an invalid history range before calling storage", async () => {
    const getHistory = vi.fn();
    const baseUrl = await start(dependencies({
      historyStore: { getHistory },
    }));

    const response = await fetch(
      `${baseUrl}/api/portfolio/history?account=account-1&currency=KRW&range=all&from=2026-07-25&to=2026-07-24`,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "invalid-history-query",
        message: "account, currency(ALL/KRW/USD), range와 from/to(YYYY-MM-DD) 값을 확인해 주세요.",
      },
    });
    expect(getHistory).not.toHaveBeenCalled();
  });

  it("forwards an inclusive custom history range without changing the response", async () => {
    const payload = { currency: "KRW", series: [] };
    const getHistory = vi.fn(async (
      ..._arguments: Parameters<PortfolioHistoryStore["getHistory"]>
    ): Promise<Awaited<ReturnType<PortfolioHistoryStore["getHistory"]>>> => (
      payload as unknown as Awaited<ReturnType<PortfolioHistoryStore["getHistory"]>>
    ));
    const baseUrl = await start(dependencies({
      historyStore: { getHistory },
    }));

    const response = await fetch(
      `${baseUrl}/api/portfolio/history?account=account-1&currency=KRW&range=all&from=2026-07-01&to=2026-07-24`,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(payload);
    expect(getHistory).toHaveBeenCalledExactlyOnceWith(
      "account-1",
      "KRW",
      "all",
      expect.any(Date),
      { from: "2026-07-01", to: "2026-07-24" },
    );
  });

  it("preserves backtest result fields and run metadata", async () => {
    const runRawWithMetadata = vi.fn(async (
      ..._arguments: Parameters<BacktestService["runRawWithMetadata"]>
    ): Promise<Awaited<ReturnType<BacktestService["runRawWithMetadata"]>>> => ({
      result: {
        schemaVersion: "1.0",
        finalBalance: 1_100_000,
      },
      runId: "run-1",
      reused: false,
    } as unknown as Awaited<ReturnType<BacktestService["runRawWithMetadata"]>>));
    const baseUrl = await start(dependencies({
      backtests: { runRawWithMetadata },
    }));

    const response = await fetch(`${baseUrl}/api/portfolio/backtest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        assets: [{ symbol: "005930", weight: 100 }],
        startDate: "2026-01-01",
        endDate: "2026-06-30",
        initialAmount: 1_000_000,
        monthlyCashFlow: 0,
        rebalanceFrequency: "none",
        benchmark: "NONE",
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      schemaVersion: "1.0",
      finalBalance: 1_100_000,
      runId: "run-1",
      reused: false,
    });
    expect(runRawWithMetadata).toHaveBeenCalledOnce();
    expect(runRawWithMetadata.mock.calls[0]?.[0]).toMatchObject({
      ownerSubject: "owner",
      request: {
        assets: [{ symbol: "005930", weight: 100 }],
        startDate: "2026-01-01",
        endDate: "2026-06-30",
      },
    });
  });
});
