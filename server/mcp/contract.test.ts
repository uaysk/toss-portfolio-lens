import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpServer } from "./server.js";
import { toolSchemas, type ToolName } from "./schemas.js";
import { toolMetadata } from "./tools/metadata.js";
import { createToolHandlers, type McpToolDependencies } from "./tools/handlers.js";
import { envelope } from "../services/service-envelope.js";

const expectedTools: ToolName[] = [
  "search_instruments", "get_data_availability", "get_price_series", "analyze_instrument",
  "analyze_asset_relationship", "get_correlation_matrix", "validate_backtest_config",
  "run_portfolio_backtest", "compare_backtests", "get_backtest_artifact", "get_current_portfolio",
  "find_diversifying_assets", "analyze_market_regimes", "analyze_return_contribution",
  "optimize_portfolio", "walk_forward_optimize", "stress_test_portfolio", "build_pareto_frontier",
  "find_redundant_assets", "analyze_rebalance_plan", "analyze_weight_sensitivity",
  "analyze_start_date_sensitivity", "analyze_rebalance_sensitivity", "analyze_cash_flow_sensitivity",
  "explain_data_quality", "get_run_status", "cancel_run", "get_run_result",
  "generate_backtest_report", "get_report",
];

const baseBacktest = {
  assets: [{ symbol: "AAA", weight: 60 }, { symbol: "BBB", weight: 40 }],
  startDate: "2024-01-01",
  endDate: "2024-12-31",
  initialAmount: 1_000_000,
  monthlyCashFlow: 0,
  rebalanceFrequency: "none",
  benchmark: "NONE",
};
const optimization = {
  symbols: ["AAA", "BBB"],
  fromDate: "2024-01-01",
  toDate: "2024-12-31",
  objective: "robust_score",
  candidateBudget: 20,
};
const run1 = "00000000-0000-4000-8000-000000000001";
const run2 = "00000000-0000-4000-8000-000000000002";
const reportId = "00000000-0000-4000-8000-000000000003";
const optimizationRun = "00000000-0000-4000-8000-000000000004";
const validToolInputs: Record<ToolName, Record<string, unknown>> = {
  search_instruments: { query: "AAA" },
  get_data_availability: { symbols: ["AAA", "BBB"] },
  get_price_series: { symbol: "AAA", fromDate: "2024-01-01", toDate: "2024-12-31" },
  analyze_instrument: { symbol: "AAA", fromDate: "2024-01-01", toDate: "2024-12-31" },
  analyze_asset_relationship: { base: "AAA", comparisons: ["BBB"], fromDate: "2024-01-01", toDate: "2024-12-31" },
  get_correlation_matrix: { symbols: ["AAA", "BBB"], fromDate: "2024-01-01", toDate: "2024-12-31" },
  validate_backtest_config: baseBacktest,
  run_portfolio_backtest: baseBacktest,
  compare_backtests: { runIds: [run1, run2] },
  get_backtest_artifact: { runId: run1, type: "equity" },
  get_current_portfolio: {},
  find_diversifying_assets: { baseSymbols: ["AAA"], candidateSymbols: ["BBB"], fromDate: "2024-01-01", toDate: "2024-12-31" },
  analyze_market_regimes: { benchmark: "AAA", fromDate: "2024-01-01", toDate: "2024-12-31" },
  analyze_return_contribution: { runId: run1 },
  optimize_portfolio: optimization,
  walk_forward_optimize: { ...optimization, trainWindow: 20, testWindow: 5, step: 5 },
  stress_test_portfolio: { baseConfig: baseBacktest, scenarios: [{ name: "비용 충격", transactionCostBps: 50 }] },
  build_pareto_frontier: { runId: optimizationRun },
  find_redundant_assets: { symbols: ["AAA", "BBB"], fromDate: "2024-01-01", toDate: "2024-12-31" },
  analyze_rebalance_plan: { currentWeights: { AAA: 0.6, BBB: 0.4 }, targetWeights: { AAA: 0.5, BBB: 0.5 } },
  analyze_weight_sensitivity: { baseConfig: baseBacktest, targetSymbol: "AAA", targetWeights: [0.4, 0.6] },
  analyze_start_date_sensitivity: { baseConfig: baseBacktest, offsetsDays: [0, 30] },
  analyze_rebalance_sensitivity: { baseConfig: baseBacktest, modes: ["none", "quarterly"] },
  analyze_cash_flow_sensitivity: { baseConfig: baseBacktest, monthlyAmounts: [0, 100_000] },
  explain_data_quality: { symbols: ["AAA", "BBB"], fromDate: "2024-01-01", toDate: "2024-12-31" },
  get_run_status: { runId: run1 },
  cancel_run: { runId: run1 },
  get_run_result: { runId: run1 },
  generate_backtest_report: { runId: run1 },
  get_report: { reportId },
};

describe("MCP tool contract", () => {
  let server: McpServer | undefined;
  let client: Client | undefined;

  afterEach(async () => {
    await client?.close().catch(() => undefined);
    await server?.close().catch(() => undefined);
  });

  it("tools/list에 정확히 30개 도구와 schema, securitySchemes, annotations를 노출한다", async () => {
    const resources = { register: vi.fn() };
    const dependencies = {
      resources,
      maxCandidateBudget: 10_000,
      maxAssets: 20,
      maxDateRangeYears: 20,
    } as unknown as McpToolDependencies;
    server = createMcpServer({
      dependencies,
      authMode: "none",
      resourceMetadataUrl: "http://127.0.0.1/.well-known/oauth-protected-resource",
    });
    client = new Client({ name: "contract-test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual(expectedTools);
    expect(resources.register).toHaveBeenCalledOnce();
    for (const tool of listed.tools) {
      expect(tool.title).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toBeTruthy();
      expect(tool.outputSchema).toBeTruthy();
      expect(tool.annotations).toMatchObject({
        readOnlyHint: expect.any(Boolean),
        openWorldHint: expect.any(Boolean),
        destructiveHint: false,
      });
      expect(tool._meta?.securitySchemes).toEqual(expect.any(Array));
    }
  });

  it("모든 도구에 한국어 metadata, OAuth scope와 세 annotations가 정의되어 있다", () => {
    expect(Object.keys(toolSchemas)).toEqual(expectedTools);
    expect(Object.keys(toolMetadata)).toEqual(expectedTools);
    for (const name of expectedTools) {
      const metadata = toolMetadata[name];
      expect(metadata.title).toMatch(/[가-힣]/);
      expect(metadata.description).toMatch(/[가-힣]/);
      expect(metadata.scopes.length).toBeGreaterThan(0);
      expect(metadata.annotations).toEqual(expect.objectContaining({
        readOnlyHint: expect.any(Boolean),
        openWorldHint: expect.any(Boolean),
        destructiveHint: false,
      }));
    }
  });

  it("30개 도구의 대표 유효 입력과 enum·날짜·비중·상한 오류를 스키마에서 검증한다", () => {
    for (const name of expectedTools) {
      expect(toolSchemas[name].safeParse(validToolInputs[name]).success, name).toBe(true);
      expect(toolSchemas[name].safeParse({ ...validToolInputs[name], unexpectedField: true }).success, name).toBe(false);
    }
    expect(toolSchemas.get_price_series.safeParse({ ...validToolInputs.get_price_series, interval: "2d" }).success).toBe(false);
    expect(toolSchemas.get_price_series.safeParse({ ...validToolInputs.get_price_series, fromDate: "2024-02-31" }).success).toBe(false);
    expect(toolSchemas.run_portfolio_backtest.safeParse({ ...baseBacktest, assets: [{ symbol: "AAA", weight: 99 }] }).success).toBe(false);
    expect(toolSchemas.optimize_portfolio.safeParse({ ...optimization, candidateBudget: 10_001 }).success).toBe(false);
    expect(toolSchemas.optimize_portfolio.safeParse({ ...optimization, objective: "max_information_ratio" }).success).toBe(false);
  });

  it("30개 handler가 합성 서비스와 저장소에서 유효 입력을 처리하고 공통 envelope를 반환한다", async () => {
    const dates = Array.from({ length: 80 }, (_, index) => new Date(Date.UTC(2024, 0, 2 + index)).toISOString().slice(0, 10));
    const loaded = (symbols: string[]) => ({
      prices: symbols.map((symbol, symbolIndex) => ({
        key: symbol,
        label: symbol,
        points: dates.map((date, index) => ({ date, value: 100 * (1 + symbolIndex * 0.001 + index * 0.0005) })),
      })),
      returns: symbols.map((symbol, symbolIndex) => ({
        key: symbol,
        label: symbol,
        points: dates.slice(1).map((date, index) => ({ date, value: Math.sin(index / (5 + symbolIndex)) * 0.01 + 0.0002 })),
      })),
      dataRevision: "synthetic-revision",
      requestedPeriod: { from: "2024-01-01", to: "2024-12-31" },
      effectivePeriod: { from: dates[0], to: dates.at(-1)! },
      warnings: [],
      dataQuality: { synthetic: true },
    });
    const relationship = {
      baseSummary: {},
      pairs: [{
        key: "BBB",
        label: "BBB",
        commonPeriod: { startDate: dates[1], endDate: dates.at(-1)! },
        observations: 79,
        singleAssetSummary: {},
        pairedSummary: { pearsonCorrelation: 0.2, downCorrelation: 0.1 },
        rollingCorrelation: [],
        warnings: [],
      }],
      correlationMatrix: { keys: ["AAA", "BBB"], correlation: [[1, 0.2], [0.2, 1]], observations: [[79, 79], [79, 79]] },
      lowCorrelationCandidates: [],
      duplicateCandidates: [],
      dataQuality: {},
      warnings: [],
    };
    const storedResult = {
      effectiveStartDate: "2024-01-02",
      endDate: "2024-12-31",
      annualReturns: [{ year: 2024, returnPercent: 8 }],
      contributions: [{ symbol: "AAA", timeLinkedContributionPercent: 8, upRegimeContributionPercent: 10, downRegimeContributionPercent: -2 }],
      advanced: {
        costEfficiency: { estimatedTotalCost: 100, costDragPercent: 0.01 },
        riskContributions: [{ symbol: "AAA", riskContributionPercent: 100 }],
      },
      dataQuality: { commonReturnObservations: 79 },
    };
    const runRecord = (id: string, kind: "backtest" | "optimization", cagrPercent: number) => ({
      id,
      kind,
      ownerSubject: "owner",
      requestHash: `hash-${id}`,
      dataRevision: "synthetic-revision",
      engineVersion: "engine-test",
      status: "completed",
      progress: 1,
      completedCandidates: 20,
      totalCandidates: 20,
      input: { ...baseBacktest },
      summary: { cagrPercent, annualizedVolatilityPercent: 10, maxDrawdownPercent: -5, sharpeRatio: 1 },
      result: storedResult,
      warnings: [],
      createdAt: 1,
      updatedAt: 2,
    });
    const records = new Map([
      [run1, runRecord(run1, "backtest", 8)],
      [run2, runRecord(run2, "backtest", 7)],
      [optimizationRun, runRecord(optimizationRun, "optimization", 6)],
    ]);
    const simpleEnvelope = (request: unknown, result: unknown) => envelope({ request, dataRevision: "synthetic-revision", result, dataQuality: { synthetic: true } });
    let queuedIndex = 0;
    const dependencies = {
      instruments: { search: vi.fn().mockResolvedValue([{ symbol: "AAA", name: "합성 자산", market: "TEST", currency: "KRW", assetType: "ETF", listDate: "2020-01-01" }]) },
      marketData: {
        repository: {
          dataRevision: vi.fn().mockResolvedValue("synthetic-revision"),
          listUniverse: vi.fn().mockResolvedValue([{ symbol: "BBB" }]),
        },
        getDataAvailability: vi.fn().mockResolvedValue({
          assets: [{ symbol: "AAA", observations: 80, commonObservations: 80, missingObservations: 0, observationRate: 1, adjustedSupported: true }],
          commonPeriod: { from: dates[0], to: dates.at(-1)! },
          commonObservations: 80,
          unionObservations: 80,
          dataRevision: "synthetic-revision",
        }),
        getPriceSeries: vi.fn().mockResolvedValue({
          instrument: { symbol: "AAA", name: "AAA", market: "TEST", currency: "KRW", assetType: "ETF" },
          interval: "1d",
          adjusted: true,
          currencyMode: "KRW",
          currency: "KRW",
          points: [{ date: dates[0], periodStart: dates[0], periodEnd: dates[0], observations: 1, open: 100, high: 101, low: 99, close: 100, localOpen: 100, localHigh: 101, localLow: 99, localClose: 100, fxRate: 1 }],
          requestedPeriod: { from: "2024-01-01", to: "2024-12-31" },
          effectivePeriod: { from: dates[0], to: dates[0] },
          dataRevision: "synthetic-revision",
          assumptions: [],
          warnings: [],
          dataQuality: { observations: 1, missingFxObservations: 0, carriedFxObservations: 0 },
        }),
      },
      analytics: {
        analyzeInstrument: vi.fn().mockImplementation((request) => simpleEnvelope(request, { instrument: {}, rolling_correlation: [] })),
        relationships: vi.fn().mockImplementation((request) => simpleEnvelope(request, structuredClone(relationship))),
        correlationMatrix: vi.fn().mockImplementation((request) => simpleEnvelope(request, relationship.correlationMatrix)),
        marketRegimes: vi.fn().mockImplementation((request) => simpleEnvelope(request, { thresholds: {}, regimes: [], observations: [] })),
        dataQuality: vi.fn().mockImplementation((request) => simpleEnvelope(request, { confidence: "high" })),
      },
      returnSeries: { load: vi.fn().mockImplementation(({ symbols }) => Promise.resolve(loaded(symbols))) },
      backtests: {
        validate: vi.fn().mockImplementation((request) => simpleEnvelope(request, { valid: true, errors: [] })),
        run: vi.fn().mockImplementation(({ request }) => simpleEnvelope(request, { run_id: run1, summary: {} })),
        generateReport: vi.fn().mockResolvedValue({ id: reportId, run_id: run1, type: "backtest", created_at: "2024-01-01T00:00:00.000Z", url: `https://portfolio.example/reports/${reportId}`, data_revision: "synthetic-revision", reused: false }),
      },
      backtestEngine: { run: vi.fn().mockResolvedValue({ metrics: {}, advanced: { tailRisk: { historicalCvar95Percent: -2 } }, dataQuality: {}, warnings: [] }) },
      runs: {
        get: vi.fn().mockImplementation((id) => Promise.resolve(records.get(id))),
        cancel: vi.fn().mockResolvedValue(true),
        enqueue: vi.fn().mockImplementation(({ kind, config, totalCandidates = 0 }) => Promise.resolve({
          reused: false,
          run: {
            id: `00000000-0000-4000-8000-${String(100 + queuedIndex++).padStart(12, "0")}`,
            kind,
            status: "queued",
            progress: 0,
            completedCandidates: 0,
            totalCandidates,
            dataRevision: "synthetic-revision",
            warnings: [],
            input: config,
          },
        })),
      },
      artifacts: {
        shouldExternalize: vi.fn().mockReturnValue(false),
        get: vi.fn().mockResolvedValue({ descriptor: { uri: `backtest://runs/${run1}/equity`, rowCount: 1 }, content: [{ date: dates[0], value: 1 }] }),
        list: vi.fn().mockResolvedValue([]),
      },
      portfolio: { current: vi.fn().mockResolvedValue({ account_selector: "acct_opaque", assets: [{ symbol: "AAA", weight_percent: 100 }], generated_at: "2024-01-01T00:00:00.000Z" }) },
      reports: { get: vi.fn().mockResolvedValue({ id: reportId, run_id: run1, type: "backtest", created_at: "2024-01-01T00:00:00.000Z", url: `https://portfolio.example/reports/${reportId}`, data_revision: "synthetic-revision", reused: false }) },
      optimizationRepository: {
        listParetoCandidates: vi.fn().mockResolvedValue([{ weights: { AAA: 0.5, BBB: 0.5 }, pareto: true }]),
      },
      resources: { register: vi.fn(), storeMarket: vi.fn().mockReturnValue({ uri: "market://series/synthetic" }) },
      maxCandidateBudget: 10_000,
      maxAssets: 20,
      maxDateRangeYears: 20,
    } as unknown as McpToolDependencies;
    const handlers = createToolHandlers(dependencies);

    for (const name of expectedTools) {
      const parsed = toolSchemas[name].parse(validToolInputs[name]);
      const result = await handlers[name](parsed, "owner") as Record<string, unknown>;
      expect(result, name).toMatchObject({ schema_version: "1.0", engine_version: expect.any(String), warnings: expect.any(Array), result: expect.anything() });
      const serialized = JSON.stringify(result);
      expect(serialized, name).not.toMatch(/CLIENT_SECRET|account-1|must-not-leak-token/i);
    }
  });

  it("30개 도구가 각자의 OAuth scope 부족을 challenge로 반환하고 민감값을 노출하지 않는다", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const dependencies = {
      resources: { register: vi.fn() },
      maxCandidateBudget: 10_000,
      maxAssets: 20,
      maxDateRangeYears: 20,
    } as unknown as McpToolDependencies;
    server = createMcpServer({ dependencies, authMode: "oauth", resourceMetadataUrl: "https://portfolio.example/.well-known/oauth-protected-resource" });
    client = new Client({ name: "scope-matrix-test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const send = clientTransport.send.bind(clientTransport);
    clientTransport.send = (message, options) => send(message, {
      ...options,
      authInfo: {
        token: "must-not-leak-token",
        clientId: "chatgpt-client",
        scopes: [],
        expiresAt: Math.floor(Date.now() / 1_000) + 60,
        resource: new URL("https://portfolio.example/mcp"),
        extra: { sub: "owner" },
      },
    });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    for (const name of expectedTools) {
      const result = await client.callTool({ name, arguments: validToolInputs[name] });
      expect(result.isError, name).toBe(true);
      expect(result._meta?.["mcp/www_authenticate"], name).toEqual([
        expect.stringContaining(toolMetadata[name].scopes[0]),
      ]);
      expect(JSON.stringify(result), name).not.toContain("must-not-leak-token");
    }
    expect(info).toHaveBeenCalledTimes(30);
    info.mockRestore();
  });

  it("로컬 계산 도구의 유효 입력은 공통 envelope를 반환하고 잘못된 비중은 거부한다", async () => {
    const dependencies = {
      resources: { register: vi.fn() },
      returnSeries: {
        load: vi.fn().mockResolvedValue({
          returns: [
            { key: "AAA", label: "AAA", points: [{ date: "2025-01-03", value: 0.01 }, { date: "2025-01-06", value: -0.005 }] },
            { key: "BBB", label: "BBB", points: [{ date: "2025-01-03", value: -0.002 }, { date: "2025-01-06", value: 0.008 }] },
          ],
          dataRevision: "test-revision",
          requestedPeriod: { from: "2025-01-01", to: "2025-01-31" },
          effectivePeriod: { from: "2025-01-03", to: "2025-01-06" },
          warnings: [],
          dataQuality: {},
        }),
      },
      maxCandidateBudget: 10_000,
      maxAssets: 20,
      maxDateRangeYears: 20,
    } as unknown as McpToolDependencies;
    server = createMcpServer({ dependencies, authMode: "none", resourceMetadataUrl: "http://localhost/metadata" });
    client = new Client({ name: "tool-test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const result = await client.callTool({
      name: "analyze_rebalance_plan",
      arguments: {
        currentWeights: { AAA: 0.6, BBB: 0.4 },
        targetWeights: { AAA: 0.5, BBB: 0.5 },
        fromDate: "2025-01-01",
        toDate: "2025-01-31",
        transactionCostBps: 10,
      },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      schema_version: "1.0",
      engine_version: expect.any(String),
      warnings: expect.arrayContaining([expect.stringContaining("미래 성과")]),
      result: { order_generated: false },
    });

    const invalid = await client.callTool({
      name: "analyze_rebalance_plan",
      arguments: { currentWeights: { AAA: 1.5 }, targetWeights: { AAA: 1 } },
    });
    expect(invalid.isError).toBe(true);
  });

  it("report.enabled=true에서 report scope가 없으면 계산 전에 challenge를 반환한다", async () => {
    const run = vi.fn();
    const dependencies = {
      backtests: { run },
      resources: { register: vi.fn() },
      maxCandidateBudget: 10_000,
      maxAssets: 20,
      maxDateRangeYears: 20,
    } as unknown as McpToolDependencies;
    server = createMcpServer({ dependencies, authMode: "oauth", resourceMetadataUrl: "https://portfolio.example/.well-known/oauth-protected-resource" });
    client = new Client({ name: "scope-test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const send = clientTransport.send.bind(clientTransport);
    clientTransport.send = (message, options) => send(message, {
      ...options,
      authInfo: {
        token: "redacted-test-token",
        clientId: "chatgpt-client",
        scopes: ["backtest:run"],
        expiresAt: Math.floor(Date.now() / 1_000) + 60,
        resource: new URL("https://portfolio.example/mcp"),
        extra: { sub: "owner" },
      },
    });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const result = await client.callTool({
      name: "run_portfolio_backtest",
      arguments: {
        assets: [{ symbol: "AAA", weight: 100 }],
        startDate: "2024-01-01",
        endDate: "2024-12-31",
        initialAmount: 1_000_000,
        report: { enabled: true, failure_mode: "warn" },
      },
    });
    expect(result.isError).toBe(true);
    expect(result._meta?.["mcp/www_authenticate"]).toEqual([
      expect.stringContaining("report:generate"),
    ]);
    expect(run).not.toHaveBeenCalled();
  });
});
