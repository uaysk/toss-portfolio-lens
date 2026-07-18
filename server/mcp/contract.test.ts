import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpServer } from "./server.js";
import { toolSchemas, type ToolName } from "./schemas.js";
import { toolMetadata } from "./tools/metadata.js";
import { createToolHandlers, type McpToolDependencies } from "./tools/handlers.js";
import { envelope } from "../services/service-envelope.js";
import { canonicalJson } from "../build-info.js";
import { ResearchReportService } from "../services/research-report-service.js";

type GeneratedTool = {
  name: ToolName;
  inputSchemaHash: string;
  outputSchemaHash: string;
  title: string;
  description: string;
  scopes: string[];
  annotations: { readOnlyHint: boolean; openWorldHint: boolean; destructiveHint: boolean };
};
type GeneratedContract = { formatVersion: number; toolCount: number; schemaHash: string; tools: GeneratedTool[] };
const expectedContract = JSON.parse(readFileSync(new URL("./generated-contract.json", import.meta.url), "utf8")) as GeneratedContract;
const expectedTools = expectedContract.tools.map((tool) => tool.name);

function schemaHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalJson(value))).digest("hex");
}

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
const preset1 = "00000000-0000-4000-8000-000000000005";
const preset2 = "00000000-0000-4000-8000-000000000006";
const presetDocument = {
  schema_version: "portfolio-lens-preset/v1",
  exported_at: "2024-01-01T00:00:00.000Z",
  preset: {
    name: "가져온 프리셋",
    description: "contract fixture",
    config: { symbols: ["AAA", "BBB"], weights: { AAA: 0.5, BBB: 0.5 } },
    tags: ["imported"],
    source: { type: "manual" },
  },
};
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
  get_run_artifact: { runId: run1, type: "result" },
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
  simulate_portfolio_monte_carlo: {
    symbols: ["AAA", "BBB"], weights: { AAA: 0.6, BBB: 0.4 },
    fromDate: "2024-01-01", toDate: "2024-12-31", initialAmount: 1_000_000,
    pathCount: 100, horizonDays: 20, blockLength: 5,
  },
  analyze_portfolio_outlook: { baseConfig: baseBacktest },
  analyze_portfolio_exposures: {
    assets: [
      { symbol: "AAA", weight: 0.6, currency: "KRW", sector: "기술" },
      { symbol: "BBB", weight: 0.4, currency: "USD", country: "US" },
    ],
  },
  explain_data_quality: { symbols: ["AAA", "BBB"], fromDate: "2024-01-01", toDate: "2024-12-31" },
  get_run_status: { runId: run1 },
  cancel_run: { runId: run1 },
  get_run_result: { runId: run1 },
  list_runs: {},
  get_run_events: { runId: run1 },
  export_run_manifest: { runId: run1 },
  update_run: { runId: run1, name: "대표 run", tags: ["saved"] },
  duplicate_run: { runId: run1, name: "복제 run" },
  delete_run: { runId: run2 },
  rerun_run: { runId: optimizationRun },
  list_portfolio_presets: {},
  get_portfolio_preset: { presetId: preset1, includeHistory: true },
  create_portfolio_preset: {
    name: "신규 프리셋", symbols: ["AAA", "BBB"],
    config: { weights: { AAA: 0.5, BBB: 0.5 } }, source: { type: "manual" },
  },
  update_portfolio_preset: { presetId: preset1, revision: 1, description: "수정" },
  duplicate_portfolio_preset: { presetId: preset1, name: "프리셋 복사본" },
  delete_portfolio_preset: { presetId: preset2 },
  import_portfolio_presets: { document: presetDocument, conflictMode: "rename" },
  export_portfolio_preset: { presetId: preset1 },
  generate_backtest_report: { runId: run1 },
  generate_research_report: { runId: run1, format: "markdown" },
  get_report: { reportId },
};

describe("MCP tool contract", () => {
  let server: McpServer | undefined;
  let client: Client | undefined;

  afterEach(async () => {
    await client?.close().catch(() => undefined);
    await server?.close().catch(() => undefined);
  });

  it("tools/list가 생성된 50개 contract와 이름·schema·metadata exact-match한다", async () => {
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
    expect(listed.tools).toHaveLength(expectedContract.toolCount);
    expect(resources.register).toHaveBeenCalledOnce();
    for (const tool of listed.tools) {
      const expected = expectedContract.tools.find((item) => item.name === tool.name)!;
      expect(tool.title, tool.name).toBe(expected.title);
      expect(tool.description, tool.name).toBe(expected.description);
      expect(tool.inputSchema).toBeTruthy();
      expect(schemaHash(tool.inputSchema), tool.name).toBe(expected.inputSchemaHash);
      expect(tool.outputSchema).toBeTruthy();
      expect(schemaHash(tool.outputSchema), tool.name).toBe(expected.outputSchemaHash);
      expect(tool.annotations, tool.name).toMatchObject(expected.annotations);
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
      expect(metadata.annotations).toEqual(expectedContract.tools.find((tool) => tool.name === name)?.annotations);
    }
  });

  it("50개 도구의 대표 유효 입력과 enum·날짜·비중·상한 오류를 스키마에서 검증한다", () => {
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

  it("50개 handler가 합성 서비스와 저장소에서 유효 입력을 처리하고 공통 envelope를 반환한다", async () => {
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
    const runRecord = (id: string, kind: "backtest" | "optimization", cagrPercent: number, input: Record<string, unknown> = baseBacktest) => ({
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
      input: structuredClone(input),
      summary: { cagrPercent, annualizedVolatilityPercent: 10, maxDrawdownPercent: -5, sharpeRatio: 1 },
      result: storedResult,
      warnings: [] as string[],
      tags: [] as string[],
      createdAt: 1,
      updatedAt: 2,
    });
    const records = new Map([
      [run1, runRecord(run1, "backtest", 8)],
      [run2, runRecord(run2, "backtest", 7)],
      [optimizationRun, runRecord(optimizationRun, "optimization", 6, optimization)],
    ]);
    const manifests = new Map<string, unknown>();
    const runEvents = new Map<string, Array<{ id: string; runId: string; type: string; detail: unknown; createdAt: number }>>([
      [run1, [{ id: "event-1", runId: run1, type: "completed", detail: {}, createdAt: 2 }]],
    ]);
    const presetState = new Map<string, {
      id: string; ownerSubject: string; name: string; description: string; config: unknown;
      tags: string[]; source: Record<string, unknown>; revision: number; createdAt: number; updatedAt: number;
    }>([
      [preset1, { id: preset1, ownerSubject: "owner", name: "기본 프리셋", description: "", config: { symbols: ["AAA", "BBB"] }, tags: [], source: { type: "manual" }, revision: 1, createdAt: 1, updatedAt: 1 }],
      [preset2, { id: preset2, ownerSubject: "owner", name: "삭제 프리셋", description: "", config: { symbols: ["AAA"] }, tags: [], source: { type: "manual" }, revision: 1, createdAt: 1, updatedAt: 1 }],
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
      backtestEngine: {
        run: vi.fn().mockResolvedValue({ metrics: {}, advanced: { tailRisk: { historicalCvar95Percent: -2 } }, dataQuality: {}, warnings: [] }),
        prepare: vi.fn().mockImplementation((request) => Promise.resolve({
          simulation: { assets: request.assets, price_series: [] },
          responseContext: { warnings: [], dataQuality: { synthetic: true } },
        })),
      },
      runs: {
        executionMode: "rust_socket",
        get: vi.fn().mockImplementation((id) => Promise.resolve(records.get(id))),
        cancel: vi.fn().mockResolvedValue(true),
        enqueue: vi.fn().mockImplementation(({ kind, config, totalCandidates = 0 }) => Promise.resolve({
          reused: false,
          run: (() => {
            const run = {
            id: `00000000-0000-4000-8000-${String(100 + queuedIndex++).padStart(12, "0")}`,
            kind,
            ownerSubject: "owner",
            requestHash: `queued-${queuedIndex}`,
            status: "queued",
            progress: 0,
            completedCandidates: 0,
            totalCandidates,
            dataRevision: "synthetic-revision",
            engineVersion: "engine-test",
            warnings: [],
            tags: [],
            input: config,
            createdAt: 3,
            updatedAt: 3,
          };
            records.set(run.id, run as never);
            return run;
          })(),
        })),
      },
      artifacts: (() => {
        const stored = new Map<string, { descriptor: Record<string, unknown>; content: unknown }>();
        const descriptor = (runId: string, type: string, content: unknown) => ({
          id: `${runId}-${type}`,
          runId,
          type,
          uri: `portfolio://runs/${runId}/artifacts/${type}`,
          format: "application/json",
          rowCount: Array.isArray(content) ? content.length : 1,
          byteCount: JSON.stringify(content).length,
          checksum: "a".repeat(64),
          generatedAt: "2024-01-01T00:00:00.000Z",
          schemaVersion: "1.0",
          dataRevision: "synthetic-revision",
        });
        for (const type of ["equity", "result"] as const) {
          const content = type === "equity" ? [{ date: dates[0], value: 1 }] : storedResult;
          stored.set(`${run1}:${type}`, { descriptor: descriptor(run1, type, content), content });
        }
        return {
        shouldExternalize: vi.fn().mockReturnValue(false),
          get: vi.fn().mockImplementation((runId, type) => Promise.resolve(stored.get(`${runId}:${type}`))),
          list: vi.fn().mockImplementation((runId) => Promise.resolve(
            Array.from(stored.values()).filter((item) => item.descriptor.runId === runId).map((item) => item.descriptor),
          )),
          put: vi.fn().mockImplementation(({ runId, type, content }) => {
            const next = descriptor(runId, type, content);
            stored.set(`${runId}:${type}`, { descriptor: next, content });
            return Promise.resolve(next);
          }),
        };
      })(),
      portfolio: { current: vi.fn().mockResolvedValue({ account_selector: "acct_opaque", assets: [{ symbol: "AAA", weight_percent: 100 }], generated_at: "2024-01-01T00:00:00.000Z" }) },
      reports: { get: vi.fn().mockResolvedValue({ id: reportId, run_id: run1, type: "backtest", created_at: "2024-01-01T00:00:00.000Z", url: `https://portfolio.example/reports/${reportId}`, data_revision: "synthetic-revision", reused: false }) },
      optimizationRepository: {
        listParetoCandidates: vi.fn().mockResolvedValue([{ weights: { AAA: 0.5, BBB: 0.5 }, pareto: true }]),
        listCandidates: vi.fn().mockResolvedValue([{ id: "candidate-1", runId: optimizationRun, rank: 1, weights: { AAA: 0.5, BBB: 0.5 }, metrics: {}, score: 1, pareto: true, createdAt: 1 }]),
        createRun: vi.fn().mockResolvedValue(undefined),
        putCandidates: vi.fn().mockResolvedValue(undefined),
      },
      runRepository: {
        get: vi.fn().mockImplementation((id, owner) => Promise.resolve(owner === "owner" ? records.get(id) : undefined)),
        list: vi.fn().mockImplementation(({ ownerSubject, archived }) => Promise.resolve({
          items: ownerSubject === "owner"
            ? Array.from(records.values()).filter((run) => archived === "all" || archived === Boolean((run as { archivedAt?: number }).archivedAt))
            : [],
        })),
        getEvents: vi.fn().mockImplementation((id) => Promise.resolve(runEvents.get(id) ?? [])),
        getManifest: vi.fn().mockImplementation((id) => Promise.resolve(manifests.get(id))),
        storeManifest: vi.fn().mockImplementation((id, _owner, manifest) => {
          if (!manifests.has(id)) manifests.set(id, manifest);
          return Promise.resolve(manifests.get(id));
        }),
        finalizeManifest: vi.fn().mockImplementation((id, _owner, manifest) => {
          const existing = manifests.get(id) as { finalized?: boolean } | undefined;
          if (!existing?.finalized) manifests.set(id, manifest);
          return Promise.resolve(manifests.get(id));
        }),
        rename: vi.fn().mockImplementation((id, _owner, name) => {
          const run = records.get(id);
          if (run) Object.assign(run, { name });
          return Promise.resolve(run);
        }),
        setTags: vi.fn().mockImplementation((id, _owner, tags) => {
          const run = records.get(id);
          if (run) Object.assign(run, { tags });
          return Promise.resolve(run);
        }),
        archive: vi.fn().mockImplementation((id) => {
          const run = records.get(id);
          if (run) Object.assign(run, { archivedAt: 4 });
          return Promise.resolve(run);
        }),
        unarchive: vi.fn().mockImplementation((id) => {
          const run = records.get(id);
          if (run) delete (run as { archivedAt?: number }).archivedAt;
          return Promise.resolve(run);
        }),
        create: vi.fn().mockImplementation((input) => {
          const id = `00000000-0000-4000-8000-${String(500 + queuedIndex++).padStart(12, "0")}`;
          const run = {
            id, kind: input.kind, ownerSubject: input.ownerSubject, requestHash: input.requestHash,
            dataRevision: input.dataRevision, engineVersion: input.engineVersion, status: "queued",
            progress: 0, completedCandidates: 0, totalCandidates: input.totalCandidates ?? 0,
            input: input.config, warnings: [], tags: input.tags ?? [], replayOf: input.replayOf,
            createdAt: 4, updatedAt: 4,
          };
          records.set(id, run as never);
          return Promise.resolve(run);
        }),
        markRunning: vi.fn().mockImplementation((id) => {
          const run = records.get(id);
          if (run) Object.assign(run, { status: "running" });
          return Promise.resolve(Boolean(run));
        }),
        complete: vi.fn().mockImplementation((id, summary, stored) => {
          const run = records.get(id);
          if (run) Object.assign(run, { status: "completed", progress: 1, summary, result: stored });
          return Promise.resolve();
        }),
        cancel: vi.fn().mockImplementation((id, summary) => {
          const run = records.get(id);
          if (run) Object.assign(run, { status: "cancelled", summary });
          return Promise.resolve();
        }),
        fail: vi.fn().mockImplementation((id, error) => {
          const run = records.get(id);
          if (run) Object.assign(run, { status: "failed", error });
          return Promise.resolve();
        }),
        addEvent: vi.fn().mockImplementation((id, type, detail) => {
          const events = runEvents.get(id) ?? [];
          events.push({ id: `event-${events.length + 1}`, runId: id, type, detail, createdAt: 5 });
          runEvents.set(id, events);
          return Promise.resolve();
        }),
        linkReplay: vi.fn().mockImplementation((id, owner, sourceRunId) => {
          const run = records.get(id);
          if (!run || run.ownerSubject !== owner || !records.has(sourceRunId)) return Promise.resolve(false);
          Object.assign(run, { replayOf: sourceRunId });
          return Promise.resolve(true);
        }),
        softDelete: vi.fn().mockImplementation((id, owner) => {
          const run = records.get(id);
          if (!run || run.ownerSubject !== owner) return Promise.resolve(false);
          records.delete(id);
          return Promise.resolve(true);
        }),
      },
      presets: {
        list: vi.fn().mockImplementation(({ ownerSubject, search }) => Promise.resolve({
          items: Array.from(presetState.values()).filter((preset) => preset.ownerSubject === ownerSubject
            && (!search || preset.name.includes(search))),
        })),
        get: vi.fn().mockImplementation((id, owner) => Promise.resolve(presetState.get(id)?.ownerSubject === owner ? presetState.get(id) : undefined)),
        markUsed: vi.fn().mockImplementation((id, owner) => Promise.resolve(presetState.get(id)?.ownerSubject === owner ? presetState.get(id) : undefined)),
        history: vi.fn().mockImplementation((id, owner) => Promise.resolve(
          presetState.get(id)?.ownerSubject === owner ? [{ id: "version-1", presetId: id, revision: 1, snapshot: presetState.get(id), createdAt: 1 }] : [],
        )),
        create: vi.fn().mockImplementation((input) => {
          const id = `00000000-0000-4000-8000-${String(700 + presetState.size).padStart(12, "0")}`;
          const preset = { id, ownerSubject: input.ownerSubject, name: input.name, description: input.description ?? "", config: input.config, tags: input.tags ?? [], source: input.source ?? { type: "manual" }, revision: 1, createdAt: 2, updatedAt: 2 };
          presetState.set(id, preset);
          return Promise.resolve(preset);
        }),
        update: vi.fn().mockImplementation((input) => {
          const current = presetState.get(input.id)!;
          const preset = { ...current, ...input, revision: current.revision + 1, updatedAt: 3 };
          presetState.set(input.id, preset);
          return Promise.resolve(preset);
        }),
        duplicate: vi.fn().mockImplementation((input) => {
          const current = presetState.get(input.id)!;
          const id = `00000000-0000-4000-8000-${String(800 + presetState.size).padStart(12, "0")}`;
          const preset = { ...current, id, name: input.name ?? `${current.name} 복사본`, source: { type: "preset", presetId: current.id, revision: current.revision }, revision: 1 };
          presetState.set(id, preset);
          return Promise.resolve(preset);
        }),
        delete: vi.fn().mockImplementation(({ id, ownerSubject }) => Promise.resolve(Boolean(presetState.get(id)?.ownerSubject === ownerSubject && presetState.delete(id)))),
        importPreset: vi.fn().mockImplementation(({ ownerSubject, payload, name }) => {
          const document = payload as typeof presetDocument;
          const id = `00000000-0000-4000-8000-${String(900 + presetState.size).padStart(12, "0")}`;
          const preset = { id, ownerSubject, name: name ?? document.preset.name, description: document.preset.description, config: document.preset.config, tags: document.preset.tags, source: { type: "import" }, revision: 1, createdAt: 4, updatedAt: 4 };
          presetState.set(id, preset);
          return Promise.resolve(preset);
        }),
        exportPreset: vi.fn().mockImplementation((id, owner) => {
          const preset = presetState.get(id);
          return Promise.resolve(preset?.ownerSubject === owner ? {
            schema_version: "portfolio-lens-preset/v1", exported_at: "2024-01-01T00:00:00.000Z",
            preset: { name: preset.name, description: preset.description, config: preset.config, tags: preset.tags, source: preset.source },
          } : undefined);
        }),
      },
      researchReports: new ResearchReportService(),
      resources: { register: vi.fn(), storeMarket: vi.fn().mockReturnValue({ uri: "market://series/synthetic" }) },
      maxCandidateBudget: 10_000,
      maxAssets: 20,
      maxDateRangeYears: 20,
    } as unknown as McpToolDependencies;
    const handlers = createToolHandlers(dependencies);

    for (const name of expectedTools) {
      const parsed = toolSchemas[name].parse(validToolInputs[name]);
      const result = await handlers[name](parsed, "owner") as Record<string, unknown>;
      expect(result, name).toMatchObject({ schema_version: "1.1", engine_version: expect.any(String), warnings: expect.any(Array), result: expect.anything() });
      const serialized = JSON.stringify(result);
      expect(serialized, name).not.toMatch(/CLIENT_SECRET|account-1|must-not-leak-token/i);
    }
  });

  it("50개 도구가 각자의 OAuth scope 부족을 challenge로 반환하고 민감값을 노출하지 않는다", async () => {
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
    expect(info).toHaveBeenCalledTimes(expectedContract.toolCount);
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
      schema_version: "1.1",
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

  it("직접 요청 또는 preset의 report.enabled=true에서 report scope가 없으면 계산 전에 challenge를 반환한다", async () => {
    const run = vi.fn();
    const presetId = "00000000-0000-4000-8000-000000000777";
    const dependencies = {
      backtests: { run },
      presets: {
        get: vi.fn().mockResolvedValue({
          id: presetId,
          revision: 1,
          config: {
            assets: [{ symbol: "AAA", weight: 100 }],
            startDate: "2024-01-01",
            endDate: "2024-12-31",
            initialAmount: 1_000_000,
            report: { enabled: true, failure_mode: "warn" },
          },
        }),
      },
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
    const presetResult = await client.callTool({
      name: "run_portfolio_backtest",
      arguments: { presetId },
    });
    expect(presetResult.isError).toBe(true);
    expect(presetResult._meta?.["mcp/www_authenticate"]).toEqual([
      expect.stringContaining("report:generate"),
    ]);
    expect(dependencies.presets.get).toHaveBeenCalledOnce();
    expect(run).not.toHaveBeenCalled();
  });

  it("파생 async run만 기존 backtest scope를 추가로 요구하고 동기 조회 권한은 보존한다", async () => {
    const dependencies = {
      resources: { register: vi.fn() },
      maxCandidateBudget: 10_000,
      maxAssets: 20,
      maxDateRangeYears: 20,
    } as unknown as McpToolDependencies;
    server = createMcpServer({
      dependencies,
      authMode: "oauth",
      resourceMetadataUrl: "https://portfolio.example/.well-known/oauth-protected-resource",
    });
    client = new Client({ name: "derived-scope-test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const send = clientTransport.send.bind(clientTransport);
    clientTransport.send = (message, options) => send(message, {
      ...options,
      authInfo: {
        token: "redacted-test-token",
        clientId: "chatgpt-client",
        scopes: ["market:read"],
        expiresAt: Math.floor(Date.now() / 1_000) + 60,
        resource: new URL("https://portfolio.example/mcp"),
        extra: { sub: "owner" },
      },
    });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const assets = [{ symbol: "AAA", weight: 1, currency: "USD" }];

    const synchronous = await client.callTool({
      name: "analyze_portfolio_exposures",
      arguments: { assets, executionMode: "sync" },
    });
    expect(synchronous.isError).not.toBe(true);

    const asynchronous = await client.callTool({
      name: "analyze_portfolio_exposures",
      arguments: { assets, executionMode: "async" },
    });
    expect(asynchronous.isError).toBe(true);
    expect(asynchronous._meta?.["mcp/www_authenticate"]).toEqual([
      expect.stringContaining("backtest:run"),
    ]);
  });
});
