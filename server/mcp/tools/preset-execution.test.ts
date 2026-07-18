import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteDatabase } from "../../database.js";
import { PresetRepository } from "../../repositories/preset-repository.js";
import { PresetService } from "../../services/preset-service.js";
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
    }));
    expect((await service.get(stored.id, "owner-a"))?.lastUsedAt).toEqual(expect.any(Number));
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
});
