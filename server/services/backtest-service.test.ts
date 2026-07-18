import { describe, expect, it, vi } from "vitest";
import { BacktestService, type SharedBacktestRequest } from "./backtest-service.js";
import { ServiceError } from "./service-envelope.js";

const request: SharedBacktestRequest = {
  assets: [{ symbol: "AAA", weight: 100 }],
  startDate: "2024-01-01",
  endDate: "2024-01-03",
  initialAmount: 1_000_000,
  monthlyCashFlow: 0,
  rebalanceFrequency: "none",
  benchmark: "NONE",
  currencyMode: "KRW",
};

const calculated = {
  generatedAt: "2024-01-04T00:00:00.000Z",
  effectiveStartDate: "2024-01-01",
  endDate: "2024-01-03",
  metrics: { totalReturnPercent: 1 },
  benchmarkMetrics: undefined,
  contributions: [],
  points: [{ date: "2024-01-01", drawdownPercent: 0 }],
  trades: [],
  correlations: { assets: [] },
  advanced: { rolling: [], riskContributions: [], monthlyReturns: [] },
  warnings: [],
  dataQuality: { commonObservations: 1 },
};

function setup(reportGenerate = vi.fn(), executionMode: "inline" | "external" = "inline") {
  const prepared = {
    simulation: { assets: [], prices: new Map(), requestedStartDate: "2024-01-01", endDate: "2024-01-03" },
    responseContext: { effective_requested_start: "2024-01-01", warnings: [] },
  };
  const engine = {
    run: vi.fn().mockResolvedValue(calculated),
    prepare: vi.fn().mockResolvedValue(prepared),
  };
  const marketData = { repository: { dataRevision: vi.fn().mockResolvedValue("revision-1") } };
  const runs = {
    executionMode,
    findReusable: vi.fn().mockResolvedValue(undefined),
    execute: vi.fn().mockImplementation(async ({ task }) => {
      await task();
      return {
        reused: false,
        run: {
          id: "00000000-0000-4000-8000-000000000001",
          requestHash: "engine-aware-request-hash",
          engineVersion: "engine-v1",
          dataRevision: "revision-1",
          result: calculated,
          warnings: [],
        },
      };
    }),
    executeExternal: vi.fn().mockResolvedValue({
      reused: false,
      run: {
        id: "00000000-0000-4000-8000-000000000001",
        requestHash: "engine-aware-request-hash",
        engineVersion: "engine-v1",
        dataRevision: "revision-1",
        result: calculated,
        warnings: [],
      },
    }),
  };
  const artifacts = { list: vi.fn().mockResolvedValue([]) };
  const reports = { generateBacktest: reportGenerate };
  const service = new BacktestService(
    engine as never,
    marketData as never,
    runs as never,
    artifacts as never,
    reports as never,
  );
  return { service, engine, runs, reportGenerate };
}

describe("BacktestService report option", () => {
  it.each([
    ["옵션 생략", request],
    ["enabled=false", { ...request, report: { enabled: false, failure_mode: "warn" as const } }],
  ])("%s이면 report generator를 호출하지 않는다", async (_name, value) => {
    const context = setup();
    const result = await context.service.run({ ownerSubject: "owner", request: value });
    expect(context.reportGenerate).not.toHaveBeenCalled();
    expect(result.result.report).toEqual({ requested: false, generated: false });
  });

  it("동일 request hash와 현재 data revision의 완료 run은 엔진 재계산 없이 재사용한다", async () => {
    const context = setup();
    context.runs.findReusable.mockResolvedValue({
      id: "00000000-0000-4000-8000-000000000001",
      status: "completed",
      dataRevision: "revision-1",
      result: calculated,
      warnings: [],
    });

    const result = await context.service.run({ ownerSubject: "owner", request });

    expect(context.engine.run).not.toHaveBeenCalled();
    expect(context.runs.execute).not.toHaveBeenCalled();
    expect(result.result.reused).toBe(true);
  });

  it("enabled=true이면 완료된 동일 run으로 보고서를 한 번 생성하고 URL을 반환한다", async () => {
    const generate = vi.fn().mockResolvedValue({
      id: "00000000-0000-4000-8000-000000000002",
      url: "https://portfolio.example/reports/00000000-0000-4000-8000-000000000002",
      reused: true,
    });
    const context = setup(generate);
    const result = await context.service.run({
      ownerSubject: "owner",
      request: { ...request, report: { enabled: true, failure_mode: "warn" } },
    });
    expect(generate).toHaveBeenCalledOnce();
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({
      backtestRequestHash: "engine-aware-request-hash",
    }));
    expect(result.result.report).toMatchObject({ generated: true, reused: true, url: expect.stringContaining("/reports/") });
  });

  it("failure_mode=warn은 백테스트 성공과 run을 보존하고 오류를 구조화한다", async () => {
    const context = setup(vi.fn().mockRejectedValue(new Error("credential=must-not-leak")));
    const result = await context.service.run({
      ownerSubject: "owner",
      request: { ...request, report: { enabled: true, failure_mode: "warn" } },
    });
    expect(context.runs.execute).toHaveBeenCalledOnce();
    expect(result.result.report).toMatchObject({
      generated: false,
      status: "failed",
      error: { code: "REPORT_GENERATION_FAILED", retryable: true },
    });
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
  });

  it("failure_mode=fail은 run 계산 후 오류를 반환하되 저장된 run을 삭제하지 않는다", async () => {
    const context = setup(vi.fn().mockRejectedValue(new Error("writer failed")));
    await expect(context.service.run({
      ownerSubject: "owner",
      request: { ...request, report: { enabled: true, failure_mode: "fail" } },
    })).rejects.toBeInstanceOf(ServiceError);
    expect(context.runs.execute).toHaveBeenCalledOnce();
  });

  it("external 모드는 Node 준비 snapshot만 durable worker payload로 전달한다", async () => {
    const context = setup(vi.fn(), "external");
    const result = await context.service.runRaw({ ownerSubject: "owner", request });

    expect(context.engine.run).not.toHaveBeenCalled();
    expect(context.engine.prepare).toHaveBeenCalledWith(request);
    expect(context.runs.execute).not.toHaveBeenCalled();
    expect(context.runs.executeExternal).toHaveBeenCalledWith(expect.objectContaining({
      kind: "backtest",
      dataRevision: "revision-1",
      payload: expect.objectContaining({
        simulation: expect.objectContaining({ prices: expect.any(Map) }),
        response_context: expect.objectContaining({ effective_requested_start: "2024-01-01" }),
      }),
    }));
    expect(result).toBe(calculated);
  });

  it("Web UI 비교를 위해 raw 결과와 영속 run id를 함께 반환한다", async () => {
    const context = setup();
    const completed = await context.service.runRawWithMetadata({ ownerSubject: "dashboard-http", request });

    expect(completed).toEqual({
      runId: "00000000-0000-4000-8000-000000000001",
      reused: false,
      result: calculated,
    });
  });
});
