import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteDatabase } from "../../database.js";
import { PresetRepository } from "../../repositories/preset-repository.js";
import { PresetService } from "../../services/preset-service.js";
import { ServiceError } from "../../services/service-envelope.js";
import { toolSchemas } from "../schemas.js";
import { createToolHandlers, type McpToolDependencies } from "./handlers.js";

describe("preset-backed execution", () => {
  let database: SqliteDatabase | undefined;

  afterEach(async () => {
    await database?.close();
    database = undefined;
  });

  async function presets(): Promise<PresetService> {
    database = new SqliteDatabase(":memory:");
    const service = new PresetService(new PresetRepository(database));
    await service.initialize();
    return service;
  }

  it("조회는 lastUsedAt을 바꾸지 않고 실제 백테스트 실행은 저장 config와 override를 병합한다", async () => {
    const service = await presets();
    const stored = await service.create({
      ownerSubject: "owner-a",
      name: "현금 포함 60/30",
      config: {
        symbols: ["AAA", "BBB"],
        defaultWeights: { AAA: 0.6, BBB: 0.3 },
        cashWeight: 0.1,
        benchmark: "SPY",
        period: { startDate: "2024-01-01", endDate: "2024-12-31" },
        rebalanceFrequency: "quarterly",
        transactionCostBps: 7,
        execution: { quantityMode: "whole", cashAnnualYieldPercent: 3 },
        realism: { costs: { sellTaxBps: 18, fixedSlippageBps: 4 } },
      },
      source: { type: "manual" },
      now: 100,
    });
    const run = vi.fn(async (input: unknown) => input);
    const validate = vi.fn(async (input: unknown) => input);
    const handlers = createToolHandlers({
      presets: service,
      backtests: { run, validate },
    } as unknown as McpToolDependencies);

    await handlers.get_portfolio_preset({ presetId: stored.id, includeHistory: false }, "owner-a");
    expect((await service.get(stored.id, "owner-a"))?.lastUsedAt).toBeUndefined();

    const validationInput = toolSchemas.validate_backtest_config.parse({
      presetId: stored.id,
      initialAmount: 1_000_000,
      rebalanceFrequency: "monthly",
    });
    await handlers.validate_backtest_config(validationInput, "owner-a");
    expect((await service.get(stored.id, "owner-a"))?.lastUsedAt).toBeUndefined();

    const executionInput = toolSchemas.run_portfolio_backtest.parse({
      presetId: stored.id,
      initialAmount: 1_000_000,
      rebalanceFrequency: "monthly",
      transactionCostBps: 25,
      execution: { cashAnnualYieldPercent: 4 },
      realism: { costs: { fixedSlippageBps: 9 } },
    });
    expect(executionInput).not.toHaveProperty("monthlyCashFlow");
    await handlers.run_portfolio_backtest(executionInput, "owner-a");

    expect(run).toHaveBeenCalledWith({
      ownerSubject: "owner-a",
      request: expect.objectContaining({
        assets: [
          expect.objectContaining({ symbol: "AAA", weight: 60 }),
          expect.objectContaining({ symbol: "BBB", weight: 30 }),
        ],
        startDate: "2024-01-01",
        endDate: "2024-12-31",
        initialAmount: 1_000_000,
        monthlyCashFlow: 0,
        rebalanceFrequency: "monthly",
        transactionCostBps: 25,
        benchmark: "CUSTOM",
        benchmarkSymbol: "SPY",
        execution: expect.objectContaining({ cashTargetPercent: 10, quantityMode: "whole", cashAnnualYieldPercent: 4 }),
        realism: expect.objectContaining({ costs: expect.objectContaining({ sellTaxBps: 18, fixedSlippageBps: 9 }) }),
      }),
    });
    expect((await service.get(stored.id, "owner-a"))?.lastUsedAt).toEqual(expect.any(Number));
  });

  it("최적화 preset의 공통 필드와 optimizationConstraints를 사용하고 요청 필드를 우선한다", async () => {
    const service = await presets();
    const stored = await service.create({
      ownerSubject: "owner-a",
      name: "CVaR 연구",
      config: {
        symbols: ["AAA", "BBB"],
        defaultWeights: { AAA: 0.55, BBB: 0.45 },
        benchmark: "SPY",
        period: { startDate: "2023-01-01", endDate: "2024-12-31" },
        transactionCostBps: 4,
        optimizationConstraints: {
          objective: "min_cvar",
          algorithm: "direct_cvar",
          candidateBudget: 50,
          ledgerValidation: { enabled: false },
        },
      },
      source: { type: "manual" },
    });
    const dates = Array.from({ length: 40 }, (_, index) => `2024-02-${String(index % 28 + 1).padStart(2, "0")}`);
    const load = vi.fn(async ({ symbols }: { symbols: string[] }) => ({
      prices: symbols.map((symbol, symbolIndex) => ({
        key: symbol,
        label: symbol,
        points: dates.map((date, index) => ({ date, value: 100 + symbolIndex + index })),
      })),
      returns: symbols.map((symbol) => ({
        key: symbol,
        label: symbol,
        points: dates.slice(1).map((date) => ({ date, value: 0.001 })),
      })),
      dataRevision: "preset-test-revision",
      requestedPeriod: { from: "2023-01-01", to: "2024-12-31" },
      effectivePeriod: { from: dates[0], to: dates.at(-1) },
      warnings: [],
      dataQuality: {},
    }));
    const enqueueExternal = vi.fn(async (input: Record<string, unknown>) => ({
      run: {
        id: "00000000-0000-4000-8000-000000000123",
        kind: "optimization",
        status: "queued",
        progress: 0,
        completedCandidates: 0,
        totalCandidates: input.totalCandidates as number,
        dataRevision: input.dataRevision as string,
        warnings: [],
        input: input.config,
      },
    }));
    const handlers = createToolHandlers({
      presets: service,
      returnSeries: { load },
      runs: { executionMode: "external", enqueueExternal },
      maxCandidateBudget: 10_000,
    } as unknown as McpToolDependencies);
    const parsed = toolSchemas.optimize_portfolio.parse({
      presetId: stored.id,
      candidateBudget: 12,
      ledgerValidation: { budget: 8 },
    });
    expect(parsed).not.toHaveProperty("algorithm");
    await handlers.optimize_portfolio(parsed, "owner-a");

    expect(load).toHaveBeenCalledWith(expect.objectContaining({ symbols: ["AAA", "BBB", "SPY"] }));
    expect(enqueueExternal).toHaveBeenCalledWith(expect.objectContaining({
      config: expect.objectContaining({
        symbols: ["AAA", "BBB"],
        fromDate: "2023-01-01",
        toDate: "2024-12-31",
        objective: "min_cvar",
        algorithm: "direct_cvar",
        candidateBudget: 12,
        currentWeights: { AAA: 0.55, BBB: 0.45 },
        ledgerValidation: expect.objectContaining({ enabled: false, budget: 8 }),
      }),
      totalCandidates: 12,
      payload: expect.objectContaining({
        objective: "min_cvar",
        optimization: expect.objectContaining({ objective: "min_cvar" }),
      }),
    }));
    expect((await service.get(stored.id, "owner-a"))?.lastUsedAt).toEqual(expect.any(Number));
  });

  it.each([
    ["max_cagr", "differential_evolution"],
    ["max_total_return", "cma_es"],
  ] as const)("%s/%s 목표를 일반·Walk-forward worker 내부 입력에도 전달한다", async (objective, algorithm) => {
    const dates = Array.from({ length: 80 }, (_, index) => (
      new Date(Date.UTC(2024, 0, index + 1)).toISOString().slice(0, 10)
    ));
    const load = vi.fn(async ({ symbols }: { symbols: string[] }) => ({
      prices: symbols.map((symbol, symbolIndex) => ({
        key: symbol,
        label: symbol,
        points: dates.map((date, index) => ({ date, value: 100 + symbolIndex + index })),
      })),
      returns: symbols.map((symbol) => ({
        key: symbol,
        label: symbol,
        points: dates.slice(1).map((date) => ({ date, value: 0.001 })),
      })),
      dataRevision: `objective-${objective}`,
      requestedPeriod: { from: dates[0], to: dates.at(-1)! },
      effectivePeriod: { from: dates[0], to: dates.at(-1)! },
      warnings: [],
      dataQuality: {},
    }));
    const enqueueExternal = vi.fn(async (input: Record<string, unknown>) => ({
      run: {
        id: "00000000-0000-4000-8000-000000000456",
        kind: input.kind,
        status: "queued",
        progress: 0,
        completedCandidates: 0,
        totalCandidates: input.totalCandidates as number,
        dataRevision: input.dataRevision as string,
        warnings: [],
        input: input.config,
      },
    }));
    const handlers = createToolHandlers({
      returnSeries: { load },
      runs: { executionMode: "external", enqueueExternal },
      maxCandidateBudget: 10_000,
    } as unknown as McpToolDependencies);
    const common = {
      symbols: ["AAA", "BBB"],
      fromDate: dates[0],
      toDate: dates.at(-1)!,
      currencyMode: "local" as const,
      objective,
      algorithm,
      candidateBudget: 20,
      ledgerValidation: { enabled: false },
    };

    await handlers.optimize_portfolio(toolSchemas.optimize_portfolio.parse(common), "owner-a");
    const optimizationCall = enqueueExternal.mock.calls.at(-1)![0] as {
      payload: { objective: string; optimization: { objective: string } };
    };
    expect(optimizationCall.payload.objective).toBe(objective);
    expect(optimizationCall.payload.optimization.objective).toBe(objective);

    await handlers.walk_forward_optimize(toolSchemas.walk_forward_optimize.parse({
      ...common,
      trainWindow: 20,
      testWindow: 5,
      step: 5,
      foldCandidateBudget: 2,
      seeds: [17],
    }), "owner-a");
    const walkForwardCall = enqueueExternal.mock.calls.at(-1)![0] as {
      payload: { objective: string; optimization: { objective: string } };
    };
    expect(walkForwardCall.payload.objective).toBe(objective);
    expect(walkForwardCall.payload.optimization.objective).toBe(objective);
  });

  it("백테스트·최적화·Walk-forward schema가 preset-only 입력과 기존 전체 입력을 함께 받는다", () => {
    const presetId = "00000000-0000-4000-8000-000000000999";
    expect(toolSchemas.run_portfolio_backtest.safeParse({ presetId }).success).toBe(true);
    expect(toolSchemas.optimize_portfolio.safeParse({ presetId }).success).toBe(true);
    expect(toolSchemas.walk_forward_optimize.safeParse({ presetId }).success).toBe(true);
    expect(toolSchemas.walk_forward_optimize.parse({ presetId, foldCandidateBudget: 7 }))
      .toEqual({ presetId, foldCandidateBudget: 7 });
    expect(toolSchemas.run_portfolio_backtest.safeParse({
      assets: [{ symbol: "AAA", weight: 100 }],
      startDate: "2024-01-01",
      endDate: "2024-12-31",
      initialAmount: 1_000_000,
    }).success).toBe(true);
  });

  it("기술 신호 preset을 deep override하고 validate는 미사용, 실행은 lastUsedAt을 갱신한다", async () => {
    const service = await presets();
    const stored = await service.create({
      ownerSubject: "owner-a",
      name: "기술 신호 전략",
      config: {
        analysis: {
          symbols: ["AAA"], fromDate: "2023-01-01", toDate: "2024-12-31", interval: "1d",
          adjusted: true, currencyMode: "KRW", responseMode: "full_series",
          indicators: [{ id: "sma-main", kind: "sma", parameters: { period: 20 } }],
        },
        strategy: {
          schemaVersion: "technical-strategy/v1", id: "trend-main",
          entryCondition: { operator: "greater_than", left: { type: "indicator", instrumentKey: "AAA", indicatorId: "sma-main", field: "value" }, right: { type: "constant", value: 10 } },
          exitCondition: { operator: "less_than", left: { type: "bar", instrumentKey: "AAA", field: "close" }, right: { type: "constant", value: 8 } },
          minimumHoldingPeriod: 0, cooldownPeriod: 0, initialState: "inactive",
          allocations: { active: { weights: { AAA: 100 }, cashPercent: 0 }, inactive: { weights: { AAA: 0 }, cashPercent: 100 } },
        },
        backtest: {
          assets: [{ symbol: "AAA", weight: 0 }], startDate: "2024-01-01", endDate: "2024-12-31",
          initialAmount: 1_000_000, monthlyCashFlow: 0, rebalanceFrequency: "none", benchmark: "NONE",
          currencyMode: "KRW", execution: { cashTargetPercent: 100, cashAnnualYieldPercent: 2 },
        },
      },
      source: { type: "manual" },
    });
    const validate = vi.fn(async (input: unknown) => input);
    const runBacktest = vi.fn(async (input: unknown) => input);
    const analyzeSignals = vi.fn(async (input: unknown) => input);
    const handlers = createToolHandlers({
      presets: service,
      technicalStrategies: { validate, runBacktest, analyzeSignals },
      maxAssets: 20,
      maxDateRangeYears: 20,
    } as unknown as McpToolDependencies);

    await handlers.validate_technical_strategy(toolSchemas.validate_technical_strategy.parse({
      presetId: stored.id,
      strategy: { minimumHoldingPeriod: 5 },
      backtest: { initialAmount: 2_000_000, execution: { cashAnnualYieldPercent: 4 } },
    }), "owner-a");
    expect((await service.get(stored.id, "owner-a"))?.lastUsedAt).toBeUndefined();
    expect(validate).toHaveBeenCalledWith({
      ownerSubject: "owner-a",
      request: expect.objectContaining({
        strategy: expect.objectContaining({ id: "trend-main", minimumHoldingPeriod: 5 }),
        backtest: expect.objectContaining({
          initialAmount: 2_000_000,
          execution: expect.objectContaining({ cashTargetPercent: 100, cashAnnualYieldPercent: 4 }),
        }),
      }),
    });

    await handlers.run_technical_strategy_backtest(toolSchemas.run_technical_strategy_backtest.parse({
      presetId: stored.id,
      analysis: { fromDate: "2022-01-01" },
    }), "owner-a");
    expect(runBacktest).toHaveBeenCalledWith({
      ownerSubject: "owner-a",
      request: expect.objectContaining({ analysis: expect.objectContaining({ fromDate: "2022-01-01", symbols: ["AAA"] }) }),
    });
    expect((await service.get(stored.id, "owner-a"))?.lastUsedAt).toEqual(expect.any(Number));

    await handlers.analyze_technical_signals(toolSchemas.analyze_technical_signals.parse({ presetId: stored.id }), "owner-a");
    expect(analyzeSignals).toHaveBeenCalledWith({
      ownerSubject: "owner-a",
      request: expect.objectContaining({ analysis: expect.any(Object), strategy: expect.any(Object) }),
    });
  });

  it("최적화 market-data preflight 실패를 failed run과 event로 영구 기록한다", async () => {
    const runId = "00000000-0000-4000-8000-000000000777";
    const recordPreflightFailure = vi.fn().mockResolvedValue({
      created: true,
      run: {
        id: runId,
        kind: "optimization",
        ownerSubject: "owner-a",
        requestHash: "request-hash",
        dataRevision: "market-revision",
        engineVersion: "engine-test",
        status: "failed",
        progress: 0,
        completedCandidates: 0,
        totalCandidates: 20,
        input: {},
        warnings: [],
        tags: [],
        createdAt: 1,
        updatedAt: 1,
      },
    });
    const upstream = new ServiceError({
      code: "FX_HISTORY_UNAVAILABLE",
      message: "과거 환율이 없습니다.",
      retryable: false,
      details: {
        symbol: "AAA",
        fx_pair: "USD/KRW",
        missing_observation_count: 250,
      },
    });
    const handlers = createToolHandlers({
      returnSeries: { load: vi.fn().mockRejectedValue(upstream) },
      marketData: { repository: { dataRevision: vi.fn().mockResolvedValue("market-revision") } },
      runs: { executionMode: "rust_socket", recordPreflightFailure },
      maxCandidateBudget: 10_000,
    } as unknown as McpToolDependencies);
    const parsed = toolSchemas.optimize_portfolio.parse({
      symbols: ["AAA", "BBB"],
      fromDate: "2021-01-01",
      toDate: "2026-01-01",
      objective: "robust_score",
      candidateBudget: 20,
      currencyMode: "KRW",
    });

    await expect(handlers.optimize_portfolio(parsed, "owner-a")).rejects.toMatchObject({
      detail: {
        code: "FX_HISTORY_UNAVAILABLE",
        details: expect.objectContaining({
          run_id: runId,
          request_hash: "request-hash",
          phase: "market_data",
          diagnostic_run_created: true,
          diagnostic_run_status: "failed",
        }),
      },
    });
    expect(recordPreflightFailure).toHaveBeenCalledWith(expect.objectContaining({
      ownerSubject: "owner-a",
      kind: "optimization",
      totalCandidates: 20,
      error: expect.objectContaining({
        code: "FX_HISTORY_UNAVAILABLE",
        worker_started: false,
        completed_candidate_count: 0,
      }),
    }));
  });

  it("preflight 진단 run이 이미 있으면 기존 ID와 당시 상태를 오류 상세에 구분한다", async () => {
    const existingRunId = "00000000-0000-4000-8000-000000000778";
    const upstream = new ServiceError({
      code: "FX_HISTORY_UNAVAILABLE",
      message: "과거 환율이 없습니다.",
      retryable: false,
    });
    const recordPreflightFailure = vi.fn().mockResolvedValue({
      created: false,
      run: {
        id: existingRunId,
        kind: "optimization",
        ownerSubject: "owner-a",
        requestHash: "existing-request-hash",
        dataRevision: "market-revision",
        engineVersion: "engine-test",
        status: "running",
        progress: 0.4,
        completedCandidates: 8,
        totalCandidates: 20,
        input: {},
        warnings: [],
        tags: [],
        createdAt: 1,
        updatedAt: 2,
      },
    });
    const handlers = createToolHandlers({
      returnSeries: { load: vi.fn().mockRejectedValue(upstream) },
      marketData: { repository: { dataRevision: vi.fn().mockResolvedValue("market-revision") } },
      runs: { executionMode: "rust_socket", recordPreflightFailure },
      maxCandidateBudget: 10_000,
    } as unknown as McpToolDependencies);
    const parsed = toolSchemas.optimize_portfolio.parse({
      symbols: ["AAA", "BBB"],
      fromDate: "2021-01-01",
      toDate: "2026-01-01",
      candidateBudget: 20,
      currencyMode: "KRW",
    });

    await expect(handlers.optimize_portfolio(parsed, "owner-a")).rejects.toMatchObject({
      detail: {
        details: expect.objectContaining({
          run_id: existingRunId,
          diagnostic_run_created: false,
          diagnostic_run_status: "running",
          existing_run_id: existingRunId,
          existing_run_status: "running",
        }),
      },
    });
  });
});
