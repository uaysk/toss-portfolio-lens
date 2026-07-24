import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { ReportGenerationError } from "../report-ai.js";
import { createReportsRouter } from "./reports.js";

const servers: Server[] = [];
const reportId = "123e4567-e89b-42d3-a456-426614174000";

type AnalysisFixture = { kind: "analysis"; accountId: string };
type BacktestFixture = { kind: "backtest"; requestedStartDate: string };
type StoredFixture = { id: string; kind: "analysis" };

function routeDependencies() {
  const analysis: AnalysisFixture = { kind: "analysis", accountId: "account-1" };
  const backtest: BacktestFixture = { kind: "backtest", requestedStartDate: "2026-01-01" };
  const stored: StoredFixture = { id: reportId, kind: "analysis" };
  return {
    analysis,
    backtest,
    stored,
    portfolioAnalysis: {
      getAnalysis: vi.fn(async () => analysis),
    },
    backtests: {
      runRaw: vi.fn(async () => backtest),
    },
    portfolioReports: {
      storageBackend: "local" as const,
      createAnalysis: vi.fn(async () => ({
        id: reportId,
        createdAt: "2026-07-24T00:00:00.000Z",
      })),
      createBacktest: vi.fn(async () => ({
        id: reportId,
        createdAt: "2026-07-24T00:00:00.000Z",
      })),
      get: vi.fn(async () => stored as StoredFixture | undefined),
      publicUrl: vi.fn((id: string) => `https://example.test/reports/${id}`),
    },
  };
}

async function startServer(router: ReturnType<typeof createReportsRouter>): Promise<string> {
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

describe("report routes", () => {
  it("creates an analysis report with the existing status and JSON fields", async () => {
    const dependencies = routeDependencies();
    const router = createReportsRouter({
      ...dependencies,
      authenticate: (_request, _response, next) => next(),
      today: () => "2026-07-24",
    });
    const baseUrl = await startServer(router);

    const response = await fetch(`${baseUrl}/api/reports/portfolio-analysis`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        account: "account-1",
        range: "30d",
        from: "2026-06-25",
        to: "2026-07-24",
        riskFreeRate: 2.5,
        benchmarks: "",
      }),
    });

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
    expect(await response.json()).toEqual({
      id: reportId,
      url: `https://example.test/reports/${reportId}`,
      createdAt: "2026-07-24T00:00:00.000Z",
      storage: "local",
    });
    expect(dependencies.portfolioAnalysis.getAnalysis).toHaveBeenCalledExactlyOnceWith({
      accountId: "account-1",
      range: "30d",
      fromDate: "2026-06-25",
      toDate: "2026-07-24",
      benchmarkKeys: [],
      riskFreeRatePercent: 2.5,
    });
    expect(dependencies.portfolioReports.createAnalysis)
      .toHaveBeenCalledExactlyOnceWith(dependencies.analysis);
  });

  it("parses the backtest body at the HTTP boundary and preserves the creation response", async () => {
    const dependencies = routeDependencies();
    const router = createReportsRouter({
      ...dependencies,
      authenticate: (_request, _response, next) => next(),
    });
    const baseUrl = await startServer(router);

    const response = await fetch(`${baseUrl}/api/reports/backtest`, {
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

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      id: reportId,
      url: `https://example.test/reports/${reportId}`,
      createdAt: "2026-07-24T00:00:00.000Z",
      storage: "local",
    });
    expect(dependencies.backtests.runRaw).toHaveBeenCalledExactlyOnceWith({
      ownerSubject: "owner",
      request: {
        assets: [{ symbol: "005930", weight: 100 }],
        startDate: "2026-01-01",
        endDate: "2026-06-30",
        initialAmount: 1_000_000,
        monthlyCashFlow: 0,
        cashFlowFrequency: "monthly",
        cashFlowTiming: "period_start",
        riskFreeRatePercent: 0,
        transactionCostBps: 0,
        currencyMode: "KRW",
        baseCurrency: "KRW",
        rebalanceFrequency: "none",
        cashFlows: [],
        targetWeightSchedule: [],
        execution: undefined,
        benchmark: "NONE",
      },
    });
    expect(dependencies.portfolioReports.createBacktest)
      .toHaveBeenCalledExactlyOnceWith(dependencies.backtest);
  });

  it("keeps validation, authentication, and public report lookup contracts distinct", async () => {
    const dependencies = routeDependencies();
    const authenticate = vi.fn((_request, response, _next) => {
      response.status(401).json({
        error: { code: "authentication-required", message: "로그인이 필요합니다." },
      });
    });
    const protectedRouter = createReportsRouter({ ...dependencies, authenticate });
    const publicRouter = createReportsRouter({
      ...dependencies,
      authenticate: (_request, _response, next) => next(),
      today: () => "2026-07-24",
    });
    const protectedBaseUrl = await startServer(protectedRouter);
    const publicBaseUrl = await startServer(publicRouter);

    const unauthorized = await fetch(`${protectedBaseUrl}/api/reports/backtest`, { method: "POST" });
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toEqual({
      error: { code: "authentication-required", message: "로그인이 필요합니다." },
    });

    const invalid = await fetch(`${publicBaseUrl}/api/reports/portfolio-analysis`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        account: "",
        range: "30d",
        from: "2026-06-25",
        to: "2026-07-24",
      }),
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({
      error: {
        code: "invalid-report-range",
        message: "계좌와 보고서 분석 기간을 확인해 주세요.",
      },
    });

    const malformedId = await fetch(`${publicBaseUrl}/api/reports/not-a-report-id`);
    expect(malformedId.status).toBe(404);
    expect(await malformedId.json()).toEqual({
      error: { code: "report-not-found", message: "보고서를 찾을 수 없습니다." },
    });
    const found = await fetch(`${publicBaseUrl}/api/reports/${reportId}`);
    expect(found.status).toBe(200);
    expect(await found.json()).toEqual(dependencies.stored);
  });

  it("preserves report generation status without exposing unexpected internal details", async () => {
    const dependencies = routeDependencies();
    dependencies.portfolioReports.createAnalysis.mockRejectedValueOnce(
      new ReportGenerationError("보고서 공급자를 잠시 사용할 수 없습니다.", true),
    );
    const router = createReportsRouter({
      ...dependencies,
      authenticate: (_request, _response, next) => next(),
      today: () => "2026-07-24",
    });
    const baseUrl = await startServer(router);
    const response = await fetch(`${baseUrl}/api/reports/portfolio-analysis`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        account: "account-1",
        range: "30d",
        from: "2026-06-25",
        to: "2026-07-24",
        benchmarks: "",
      }),
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: {
        code: "report-generation-failed",
        message: "보고서 공급자를 잠시 사용할 수 없습니다.",
      },
    });
  });
});
