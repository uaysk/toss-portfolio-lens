import type { PortfolioBacktestService, BacktestRunRequest } from "../../backtest.js";
import type { InstrumentService } from "../../services/instrument-service.js";
import type { MarketDataService } from "../../services/market-data-service.js";
import type { AnalyticsService } from "../../services/analytics-service.js";
import type { ReturnSeriesService, LoadedReturnSeries } from "../../services/return-series-service.js";
import type { BacktestService } from "../../services/backtest-service.js";
import type { RunService } from "../../services/run-service.js";
import type { ArtifactService } from "../../services/artifact-service.js";
import type { PortfolioService } from "../../services/portfolio-service.js";
import type { ReportService } from "../../services/report-service.js";
import type { OptimizationRepository } from "../../repositories/optimization-repository.js";
import type { RunRepository, PortfolioRunKind, PortfolioRunRecord } from "../../repositories/run-repository.js";
import type { PresetService } from "../../services/preset-service.js";
import { PRESET_EXPORT_SCHEMA_VERSION, PresetValidationError } from "../../services/preset-service.js";
import { PresetRevisionConflictError, type PresetSource } from "../../repositories/preset-repository.js";
import {
  analyzePairedReturnSeries,
  analyzeReturnSeries,
  alignReturnSeries,
  convertPricesToReturns,
  type PriceSeriesInput,
  type ReturnSeriesInput,
} from "../../services/quant-math.js";
import {
  buildParetoFrontier,
  buildWalkForwardWindows,
  optimizePortfolio,
  type OptimizationInput,
  type OptimizationOutput,
  type OptimizationObjective,
  type PortfolioCandidate,
} from "../../services/optimization-service.js";
import { envelope, HISTORICAL_LIMITATION, PORTFOLIO_ENGINE_VERSION, requestHash, ServiceError } from "../../services/service-envelope.js";
import type { McpResourceRegistry } from "../resources.js";
import { resolvedPresetExecutionSchemas, type ToolName } from "../schemas.js";
import type { RustComputeClient } from "../../worker/rust-client.js";
import type { ArtifactType } from "../../repositories/artifact-repository.js";
import { isArtifactType } from "../../repositories/artifact-repository.js";
import { analyzePortfolioExposures } from "../../services/exposure-service.js";
import { ResearchReportService } from "../../services/research-report-service.js";
import { buildInfo } from "../../build-info.js";
import { randomUUID } from "node:crypto";
import { enforceToolRequestLimits } from "../../services/tool-request-limits.js";

export type ToolHandler = (input: unknown, ownerSubject: string) => Promise<unknown>;

export type McpToolDependencies = {
  instruments: InstrumentService;
  marketData: MarketDataService;
  analytics: AnalyticsService;
  returnSeries: ReturnSeriesService;
  backtests: BacktestService;
  backtestEngine: PortfolioBacktestService;
  runs: RunService;
  artifacts: ArtifactService;
  portfolio: PortfolioService;
  reports: ReportService;
  runRepository: RunRepository;
  presets: PresetService;
  researchReports: ResearchReportService;
  optimizationRepository: OptimizationRepository;
  resources: McpResourceRegistry;
  rustCompute?: RustComputeClient;
  maxCandidateBudget: number;
  maxAssets: number;
  maxDateRangeYears: number;
};

type GenericInput = Record<string, unknown>;

function object(input: unknown): GenericInput {
  return input as GenericInput;
}

function rustTaskResult(output: Awaited<ReturnType<RustComputeClient["compute"]>>) {
  return {
    summary: output.summary,
    result: output.result,
    warnings: output.warnings,
    artifacts: output.artifacts.map((artifact) => ({
      type: artifact.type as ArtifactType,
      content: artifact.content,
      rowCount: artifact.row_count,
    })),
  };
}

function requireRust(dependencies: McpToolDependencies): RustComputeClient {
  if (!dependencies.rustCompute) {
    throw new ServiceError({
      code: "RUST_COMPUTE_UNAVAILABLE",
      message: "이 계산은 Rust compute 실행 모드에서만 사용할 수 있습니다.",
      retryable: true,
    });
  }
  return dependencies.rustCompute;
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function stressRequest(baseInput: BacktestRunRequest, scenario: GenericInput): BacktestRunRequest {
  const base = { ...baseInput };
  const exclude = new Set((scenario.excludeSymbols as string[] | undefined) ?? []);
  const assets = base.assets.filter((asset) => !exclude.has(asset.symbol));
  const total = assets.reduce((sum, asset) => sum + asset.weight, 0);
  if (!assets.length || total <= 0) {
    throw new ServiceError({ code: "EMPTY_STRESS_PORTFOLIO", message: "stress scenario가 모든 종목을 제외할 수 없습니다.", retryable: false });
  }
  const cashTarget = base.execution?.cashTargetPercent ?? 0;
  return {
    ...base,
    assets: assets.map((asset) => ({ ...asset, weight: asset.weight / total * (100 - cashTarget) })),
    ...(scenario.startDate !== undefined ? { startDate: String(scenario.startDate) } : {}),
    ...(scenario.endDate !== undefined ? { endDate: String(scenario.endDate) } : {}),
    ...(scenario.transactionCostBps !== undefined ? { transactionCostBps: Number(scenario.transactionCostBps) } : {}),
    ...(scenario.monthlyCashFlow !== undefined ? { monthlyCashFlow: Number(scenario.monthlyCashFlow) } : {}),
    ...(scenario.cashFlowFrequency ? { cashFlowFrequency: scenario.cashFlowFrequency as NonNullable<BacktestRunRequest["cashFlowFrequency"]> } : {}),
    ...(scenario.cashFlowTiming ? { cashFlowTiming: scenario.cashFlowTiming as NonNullable<BacktestRunRequest["cashFlowTiming"]> } : {}),
    ...(scenario.currencyMode ? { currencyMode: scenario.currencyMode as "local" | "KRW" } : {}),
    ...(scenario.rebalanceFrequency ? { rebalanceFrequency: scenario.rebalanceFrequency as BacktestRunRequest["rebalanceFrequency"] } : {}),
    ...(scenario.rebalanceThresholdPercent !== undefined ? { rebalanceThresholdPercent: Number(scenario.rebalanceThresholdPercent) } : {}),
  };
}

function runResultEnvelope(run: {
  id: string;
  kind: string;
  status: string;
  progress: number;
  completedCandidates: number;
  totalCandidates: number;
  currentValidationWindow?: string;
  dataRevision: string;
  warnings: string[];
  input: unknown;
  summary?: unknown;
  result?: unknown;
  error?: unknown;
}, request: unknown, artifactIndex: unknown[] = [], includeStoredResult = true) {
  return envelope({
    request,
    dataRevision: run.dataRevision,
    warnings: run.warnings,
    dataQuality: {},
    result: {
      run_id: run.id,
      kind: run.kind,
      status: run.status,
      progress: run.progress,
      completed_candidates: run.completedCandidates,
      total_candidates: run.totalCandidates,
      current_validation_window: run.currentValidationWindow,
      summary: run.summary,
      ...(includeStoredResult ? { result: run.result } : {}),
      error: run.error,
      artifact_index: artifactIndex,
    },
  });
}

function optimizationInput(
  value: GenericInput,
  loaded: LoadedReturnSeries,
  includeRobustValidation = true,
): OptimizationInput {
  const assetCount = Array.isArray(value.symbols) ? value.symbols.length : loaded.prices.length;
  return {
    priceSeries: loaded.prices.slice(0, assetCount),
    benchmarkPriceSeries: value.benchmark ? loaded.prices[assetCount] : undefined,
    benchmark: value.benchmark ? loaded.returns[assetCount] : undefined,
    constraints: {
      minWeight: Number(value.minWeight),
      maxWeight: Number(value.maxWeight),
      minWeights: value.minWeights as Record<string, number>,
      maxWeights: value.maxWeights as Record<string, number>,
      maxAssets: Number(value.maxAssets ?? loaded.prices.length),
      requiredAssets: value.requiredAssets as string[],
      excludedAssets: value.excludedAssets as string[],
      maxDrawdown: value.maxDrawdown as number | undefined,
      targetReturn: value.targetReturn as number | undefined,
      maxTurnover: value.maxTurnover as number | undefined,
      currentWeights: value.currentWeights as Record<string, number>,
    },
    seed: Number(value.seed),
    candidateBudget: Number(value.candidateBudget),
    riskFreeRatePercent: Number(value.riskFreeRatePercent),
    transactionCostBps: Number(value.transactionCostBps),
    algorithm: value.algorithm as OptimizationInput["algorithm"],
    covarianceEstimator: value.covarianceEstimator as OptimizationInput["covarianceEstimator"],
    baselines: value.baselines as OptimizationInput["baselines"],
    assetGroups: value.assetGroups as OptimizationInput["assetGroups"],
    groupConstraints: value.groupConstraints as OptimizationInput["groupConstraints"],
    robustScoreWeights: value.robustScoreWeights as Record<string, number>,
    walkForwardConfig: includeRobustValidation
      ? value.robustValidation as OptimizationInput["walkForwardConfig"]
      : undefined,
    ledgerValidationBudget: Number((value.ledgerValidation as GenericInput | undefined)?.budget ?? 32),
    regimePolicySearch: value.regimePolicySearch as OptimizationInput["regimePolicySearch"],
  };
}

async function optimizationLedgerTemplate(
  dependencies: McpToolDependencies,
  value: GenericInput,
): Promise<{ simulation?: unknown; warnings: string[] }> {
  const validation = value.ledgerValidation as GenericInput | undefined;
  if (!validation || validation.enabled === false) return { warnings: [] };
  const symbols = value.symbols as string[];
  const cashTargetPercent = Number(validation.cashTargetPercent ?? 0);
  const invested = 100 - cashTargetPercent;
  const lotSizes = validation.lotSizes as Record<string, number> | undefined;
  const request: BacktestRunRequest = {
    assets: symbols.map((symbol) => ({
      symbol,
      weight: invested / symbols.length,
      lotSize: lotSizes?.[symbol] ?? 1,
    })),
    startDate: String(value.fromDate),
    endDate: String(value.toDate),
    initialAmount: Number(validation.initialAmount ?? 100_000_000),
    monthlyCashFlow: 0,
    cashFlowFrequency: "monthly",
    cashFlowTiming: "period_start",
    rebalanceFrequency: validation.rebalanceFrequency as BacktestRunRequest["rebalanceFrequency"],
    ...(validation.rebalanceThresholdPercent !== undefined
      ? { rebalanceThresholdPercent: Number(validation.rebalanceThresholdPercent) }
      : {}),
    riskFreeRatePercent: Number(value.riskFreeRatePercent),
    transactionCostBps: Number(value.transactionCostBps),
    cashFlows: [],
    execution: {
      cashTargetPercent,
      quantityMode: validation.quantityMode as "fractional" | "whole",
      cashFlowRebalanceMode: "target_weights",
      tradeDatePolicy: "next_common_observation",
      cashAnnualYieldPercent: 0,
    },
    currencyMode: value.currencyMode as "local" | "KRW",
    benchmark: "NONE",
  };
  const prepared = await dependencies.backtestEngine.prepare(request);
  return { simulation: prepared.simulation, warnings: prepared.responseContext.warnings };
}

function candidateSignature(candidate: PortfolioCandidate): string {
  return JSON.stringify(Object.entries(candidate.weights).sort(([a], [b]) => a.localeCompare(b)));
}

async function persistOptimization(
  dependencies: McpToolDependencies,
  runId: string,
  objective: OptimizationObjective,
  seed: number,
  budget: number,
  settings: unknown,
  candidates: PortfolioCandidate[],
  frontier: PortfolioCandidate[],
): Promise<void> {
  await dependencies.optimizationRepository.createRun({
    runId,
    objective,
    seed,
    candidateBudget: budget,
    objectiveVersion: PORTFOLIO_ENGINE_VERSION,
    settings,
  });
  const pareto = new Set(frontier.map(candidateSignature));
  const unique = new Map<string, {
    runId: string;
    rank: number;
    weights: Record<string, number>;
    metrics: PortfolioCandidate["metrics"];
    score: number;
    pareto: boolean;
  }>();
  for (const [index, candidate] of candidates.entries()) {
    const signature = candidateSignature(candidate);
    const previous = unique.get(signature);
    const row = {
      runId,
      rank: index + 1,
      weights: candidate.weights,
      metrics: candidate.metrics,
      score: candidate.metrics.robustScore ?? Number.NEGATIVE_INFINITY,
      pareto: pareto.has(signature),
    };
    if (!previous) unique.set(signature, row);
    else if (row.pareto && !previous.pareto) unique.set(signature, { ...previous, pareto: true });
  }
  await dependencies.optimizationRepository.putCandidates([...unique.values()]);
}

function returnsToPrices(series: ReturnSeriesInput, start: number, end: number): PriceSeriesInput {
  const selected = series.points.slice(start, end + 1);
  if (!selected.length) return { key: series.key, label: series.label, points: [] };
  let price = 100;
  const points = [{ date: addDays(selected[0].date, -1), value: price }];
  for (const point of selected) {
    price *= 1 + point.value;
    points.push({ date: point.date, value: price });
  }
  return { key: series.key, label: series.label, points };
}

function portfolioReturns(
  aligned: ReturnType<typeof alignReturnSeries>,
  weights: Record<string, number>,
  start: number,
  end: number,
): ReturnSeriesInput {
  return {
    key: "oos-portfolio",
    label: "OOS portfolio",
    points: aligned.dates.slice(start, end + 1).map((date, relative) => ({
      date,
      value: Object.entries(weights).reduce((sum, [symbol, weight]) => (
        sum + weight * (aligned.byKey[symbol]?.[start + relative] ?? 0)
      ), 0),
    })),
  };
}

function normalizedWeights(keys: string[], input?: Record<string, number>): Record<string, number> {
  const values = Object.fromEntries(keys.map((key) => [key, Math.max(0, Number(input?.[key] ?? (input ? 0 : 1)))]));
  const total = Object.values(values).reduce((sum, value) => sum + value, 0);
  if (!(total > 0)) return Object.fromEntries(keys.map((key) => [key, 1 / keys.length]));
  return Object.fromEntries(keys.map((key) => [key, values[key] / total]));
}

function weightedReturns(
  series: ReturnSeriesInput[],
  weights: Record<string, number>,
  key: string,
  label: string,
): ReturnSeriesInput {
  const aligned = alignReturnSeries(series);
  return {
    key,
    label,
    points: aligned.dates.map((date, index) => ({
      date,
      value: aligned.keys.reduce((sum, seriesKey) => sum + (weights[seriesKey] ?? 0) * aligned.byKey[seriesKey][index], 0),
    })),
  };
}

function drawdownPath(series: ReturnSeriesInput): ReturnSeriesInput {
  let growth = 1;
  let peak = 1;
  return {
    key: `${series.key}:drawdown`,
    label: `${series.label} drawdown`,
    points: series.points.map((point) => {
      growth *= 1 + point.value;
      peak = Math.max(peak, growth);
      return { date: point.date, value: peak > 0 ? growth / peak - 1 : 0 };
    }),
  };
}

function riskSnapshot(analysis: ReturnType<typeof analyzeReturnSeries>) {
  return {
    cagr: analysis.cagr,
    annualized_volatility: analysis.annualizedVolatility,
    max_drawdown: analysis.maxDrawdown,
    cvar_95: analysis.conditionalValueAtRisk95,
    sharpe_ratio: analysis.sharpeRatio,
    sortino_ratio: analysis.sortinoRatio,
    observations: analysis.observations,
  };
}

function numericDistribution(values: number[]) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return { minimum: null, median: null, maximum: null };
  const middle = Math.floor(sorted.length / 2);
  return {
    minimum: sorted[0],
    median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    maximum: sorted.at(-1)!,
  };
}

function metricDistributions(rows: Array<{ metrics: Record<string, unknown> }>) {
  const keys = [
    "cagrPercent",
    "annualizedVolatilityPercent",
    "maxDrawdownPercent",
    "cvar95Percent",
    "sharpeRatio",
    "sortinoRatio",
  ];
  return Object.fromEntries(keys.map((key) => [
    key,
    numericDistribution(rows.map((row) => Number(row.metrics[key])).filter(Number.isFinite)),
  ]));
}

const REPLAY_TOOL_BY_KIND: Record<PortfolioRunKind, ToolName> = {
  backtest: "run_portfolio_backtest",
  optimization: "optimize_portfolio",
  walk_forward: "walk_forward_optimize",
  stress_test: "stress_test_portfolio",
  weight_sensitivity: "analyze_weight_sensitivity",
  start_date_sensitivity: "analyze_start_date_sensitivity",
  rebalance_sensitivity: "analyze_rebalance_sensitivity",
  cash_flow_sensitivity: "analyze_cash_flow_sensitivity",
  monte_carlo: "simulate_portfolio_monte_carlo",
  outlook: "analyze_portfolio_outlook",
  exposure_analysis: "analyze_portfolio_exposures",
  pareto_frontier: "build_pareto_frontier",
  research_report: "generate_research_report",
};

function serviceNotFound(entity: "run" | "preset", id: string): ServiceError {
  return new ServiceError({
    code: entity === "run" ? "RUN_NOT_FOUND" : "PRESET_NOT_FOUND",
    message: entity === "run" ? "run을 찾을 수 없습니다." : "preset을 찾을 수 없습니다.",
    retryable: false,
    details: { id },
  });
}

async function presetOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof PresetRevisionConflictError) {
      throw new ServiceError({
        code: "PRESET_REVISION_CONFLICT",
        message: "preset이 다른 요청에서 변경되었습니다. 최신 revision을 다시 조회해 주세요.",
        retryable: false,
        details: {
          preset_id: error.presetId,
          expected_revision: error.expectedRevision,
          current_revision: error.currentRevision,
        },
      });
    }
    if (error instanceof PresetValidationError) {
      throw new ServiceError({
        code: "INVALID_PRESET",
        message: error.message,
        retryable: false,
        ...(error.field ? { field: error.field } : {}),
      });
    }
    throw error;
  }
}

function runListArchived(value: unknown): boolean | "all" {
  if (value === "all") return "all";
  return value === "archived";
}

function eventCursor(value: unknown): { after: number; afterId?: string } | undefined {
  if (value === undefined) return undefined;
  const raw = String(value);
  if (/^\d{1,16}$/.test(raw)) return { after: Number(raw) };
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as { after?: unknown; id?: unknown };
    if (!Number.isSafeInteger(parsed.after) || Number(parsed.after) < 0) throw new Error("invalid timestamp");
    if (parsed.id === undefined) return { after: Number(parsed.after) };
    if (typeof parsed.id !== "string" || parsed.id.length < 1 || parsed.id.length > 64) throw new Error("invalid event id");
    return { after: Number(parsed.after), afterId: parsed.id };
  } catch {
    throw new ServiceError({ code: "INVALID_EVENT_CURSOR", message: "run event cursor가 올바르지 않습니다.", retryable: false, field: "cursor" });
  }
}

function runManifest(run: PortfolioRunRecord, artifacts: Awaited<ReturnType<ArtifactService["list"]>>) {
  return {
    schema_version: "portfolio-lens-run-manifest/v1",
    captured_at: new Date(run.createdAt).toISOString(),
    finalized: false,
    run: {
      id: run.id,
      kind: run.kind,
      request_hash: run.requestHash,
      data_revision: run.dataRevision,
      engine_version: run.engineVersion,
      status: run.status,
      input: run.input,
      created_at: run.createdAt,
      started_at: run.startedAt,
      finished_at: run.finishedAt,
      replay_of: run.replayOf,
    },
    build: buildInfo(),
    reproducibility: {
      deterministic_when: "동일 seed, 정규화 입력, data revision, 엔진·worker schema 버전이 동일할 때",
      seed: recordValue(run.input)?.seed ?? null,
      artifact_checksums: artifacts.map((artifact) => ({
        type: artifact.type,
        checksum: artifact.checksum,
        rows: artifact.rowCount,
        bytes: artifact.byteCount,
        schema_version: artifact.schemaVersion,
      })),
    },
  };
}

function finalizedRunManifest(
  base: unknown,
  run: PortfolioRunRecord,
  artifacts: Awaited<ReturnType<ArtifactService["list"]>>,
) {
  const stored = recordValue(base) ?? {};
  const storedRun = recordValue(stored.run) ?? {};
  const reproducibility = recordValue(stored.reproducibility) ?? {};
  const coreArtifacts = artifacts.filter((artifact) => artifact.type !== "research-report");
  return {
    ...stored,
    schema_version: "portfolio-lens-run-manifest/v1",
    finalized: true,
    finalized_at: new Date(run.finishedAt ?? run.updatedAt).toISOString(),
    run: {
      ...storedRun,
      id: run.id,
      kind: run.kind,
      request_hash: run.requestHash,
      data_revision: run.dataRevision,
      engine_version: run.engineVersion,
      status: run.status,
      input: run.input,
      created_at: run.createdAt,
      started_at: run.startedAt,
      finished_at: run.finishedAt,
      replay_of: run.replayOf,
    },
    reproducibility: {
      ...reproducibility,
      artifact_checksums: coreArtifacts.map((artifact) => ({
        type: artifact.type,
        checksum: artifact.checksum,
        rows: artifact.rowCount,
        bytes: artifact.byteCount,
        schema_version: artifact.schemaVersion,
      })),
    },
  };
}

function recordValue(value: unknown): GenericInput | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as GenericInput : undefined;
}

type PresetExecutionTool = "validate_backtest_config" | "run_portfolio_backtest" | "optimize_portfolio" | "walk_forward_optimize";

const BACKTEST_PRESET_FIELDS = [
  "assets", "startDate", "endDate", "initialAmount", "monthlyCashFlow", "cashFlowFrequency",
  "cashFlowTiming", "rebalanceFrequency", "rebalanceThresholdPercent", "riskFreeRatePercent",
  "transactionCostBps", "cashFlows", "targetWeightSchedule", "execution", "realism", "currencyMode",
  "baseCurrency", "benchmark", "benchmarkSymbol", "report",
] as const;
const OPTIMIZATION_PRESET_FIELDS = [
  "symbols", "fromDate", "toDate", "benchmark", "currencyMode", "objective", "minWeight", "maxWeight",
  "minWeights", "maxWeights", "maxAssets", "requiredAssets", "excludedAssets", "maxDrawdown", "targetReturn",
  "maxTurnover", "currentWeights", "transactionCostBps", "riskFreeRatePercent", "seed", "candidateBudget",
  "algorithm", "covarianceEstimator", "baselines", "assetGroups", "groupConstraints", "robustScoreWeights",
  "robustValidation", "ledgerValidation", "regimePolicySearch", "mode", "trainWindow", "testWindow", "step",
  "gap", "embargo", "foldCandidateBudget", "seeds",
] as const;
const BACKTEST_DEEP_OVERRIDE_FIELDS = new Set(["execution", "realism", "report"]);
const OPTIMIZATION_DEEP_OVERRIDE_FIELDS = new Set(["robustValidation", "ledgerValidation", "regimePolicySearch"]);

function selectedFields(source: GenericInput, fields: readonly string[]): GenericInput {
  return Object.fromEntries(fields.flatMap((field) => source[field] === undefined ? [] : [[field, source[field]]]));
}

function deepMergeRecords(base: GenericInput, override: GenericInput): GenericInput {
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const baseRecord = recordValue(result[key]);
    const overrideRecord = recordValue(value);
    result[key] = baseRecord && overrideRecord ? deepMergeRecords(baseRecord, overrideRecord) : value;
  }
  return result;
}

function mergePresetOverrides(base: GenericInput, overrides: GenericInput, deepFields: ReadonlySet<string>): GenericInput {
  const result = { ...base, ...overrides };
  for (const field of deepFields) {
    const baseRecord = recordValue(base[field]);
    const overrideRecord = recordValue(overrides[field]);
    if (baseRecord && overrideRecord) result[field] = deepMergeRecords(baseRecord, overrideRecord);
  }
  return result;
}

function normalizedWeightRecord(value: unknown): Record<string, number> | undefined {
  const source = recordValue(value);
  if (!source) return undefined;
  const entries = Object.entries(source).filter((entry): entry is [string, number] => (
    typeof entry[1] === "number" && Number.isFinite(entry[1]) && entry[1] >= 0
  ));
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function normalizedBacktestPreset(config: GenericInput): GenericInput {
  const period = recordValue(config.period);
  const weights = normalizedWeightRecord(config.defaultWeights) ?? normalizedWeightRecord(config.weights);
  const symbols = Array.isArray(config.symbols)
    ? config.symbols.filter((item): item is string => typeof item === "string")
    : Object.keys(weights ?? {});
  const cashWeight = typeof config.cashWeight === "number" && Number.isFinite(config.cashWeight)
    ? (config.cashWeight <= 1 ? config.cashWeight * 100 : config.cashWeight)
    : undefined;
  const storedExecution = recordValue(config.execution);
  const benchmark = typeof config.benchmark === "string" ? config.benchmark.toUpperCase() : undefined;
  const result: GenericInput = {
    ...selectedFields(config, BACKTEST_PRESET_FIELDS),
    ...(typeof period?.startDate === "string" && config.startDate === undefined ? { startDate: period.startDate } : {}),
    ...(typeof period?.endDate === "string" && config.endDate === undefined ? { endDate: period.endDate } : {}),
  };
  if (!Array.isArray(result.assets) && weights && symbols.length) {
    const weightTotal = Object.values(weights).reduce((sum, item) => sum + item, 0);
    const scale = weightTotal <= 1.000_001 ? 100 : 1;
    result.assets = symbols
      .filter((symbol) => (weights[symbol] ?? 0) > 0)
      .map((symbol) => ({ symbol, weight: (weights[symbol] ?? 0) * scale }));
  }
  if (cashWeight !== undefined && storedExecution?.cashTargetPercent === undefined) {
    result.execution = { ...(storedExecution ?? {}), cashTargetPercent: cashWeight };
  }
  if (benchmark && !["NONE", "KOSPI", "KOSDAQ", "NASDAQ100", "SP500", "CUSTOM"].includes(benchmark)) {
    result.benchmark = "CUSTOM";
    result.benchmarkSymbol = benchmark;
  }
  return result;
}

function normalizedOptimizationPreset(config: GenericInput): GenericInput {
  const period = recordValue(config.period);
  const constraints = recordValue(config.optimizationConstraints) ?? {};
  const assets = Array.isArray(config.assets)
    ? config.assets.map(recordValue).filter((item): item is GenericInput => Boolean(item))
    : [];
  const weights = normalizedWeightRecord(config.defaultWeights)
    ?? normalizedWeightRecord(config.weights)
    ?? (assets.length ? Object.fromEntries(assets
      .filter((item) => typeof item.symbol === "string" && typeof item.weight === "number")
      .map((item) => [String(item.symbol), Number(item.weight) / 100])) : undefined);
  const symbols = Array.isArray(config.symbols)
    ? config.symbols.filter((item): item is string => typeof item === "string")
    : assets.map((item) => item.symbol).filter((item): item is string => typeof item === "string");
  const benchmark = config.benchmark === "CUSTOM" && typeof config.benchmarkSymbol === "string"
    ? config.benchmarkSymbol
    : config.benchmark === "NONE" ? undefined : config.benchmark;
  return {
    ...selectedFields(constraints, OPTIMIZATION_PRESET_FIELDS),
    ...selectedFields(config, OPTIMIZATION_PRESET_FIELDS),
    ...(symbols.length && config.symbols === undefined ? { symbols } : {}),
    ...(weights && config.currentWeights === undefined ? { currentWeights: weights } : {}),
    ...(typeof period?.startDate === "string" && config.fromDate === undefined ? { fromDate: period.startDate } : {}),
    ...(typeof period?.endDate === "string" && config.toDate === undefined ? { toDate: period.endDate } : {}),
    ...(benchmark !== undefined ? { benchmark } : {}),
  };
}

export async function resolvePresetExecution(
  dependencies: McpToolDependencies,
  ownerSubject: string,
  input: GenericInput,
  tool: PresetExecutionTool,
  options: { markUsed?: boolean } = {},
): Promise<GenericInput> {
  const {
    _replayNonce,
    _replayOf,
    ...publicInput
  } = input;
  const replayMetadata = {
    ...(_replayNonce !== undefined ? { _replayNonce } : {}),
    ...(_replayOf !== undefined ? { _replayOf } : {}),
  };
  if (typeof publicInput.presetId !== "string") {
    const resolved = { ...object(resolvedPresetExecutionSchemas[tool].parse(publicInput)), ...replayMetadata };
    enforceToolRequestLimits(resolved, dependencies);
    return resolved;
  }
  const preset = await presetOperation(() => dependencies.presets.get(publicInput.presetId as string, ownerSubject));
  if (!preset) throw serviceNotFound("preset", publicInput.presetId);
  const stored = recordValue(preset.config);
  if (!stored) {
    throw new ServiceError({ code: "INVALID_PRESET_CONFIG", message: "실행할 preset config가 객체가 아닙니다.", retryable: false, details: { preset_id: preset.id } });
  }
  const { presetId: _presetId, ...overrides } = publicInput;
  const normalized = tool === "run_portfolio_backtest" || tool === "validate_backtest_config"
    ? normalizedBacktestPreset(stored)
    : normalizedOptimizationPreset(stored);
  const candidate = mergePresetOverrides(
    normalized,
    overrides,
    tool === "run_portfolio_backtest" || tool === "validate_backtest_config"
      ? BACKTEST_DEEP_OVERRIDE_FIELDS
      : OPTIMIZATION_DEEP_OVERRIDE_FIELDS,
  );
  if (tool === "validate_backtest_config") delete candidate.report;
  const parsed = resolvedPresetExecutionSchemas[tool].safeParse(candidate);
  if (!parsed.success) {
    throw new ServiceError({
      code: "INVALID_PRESET_EXECUTION_CONFIG",
      message: "preset과 요청 override를 병합한 실행 설정이 올바르지 않습니다.",
      retryable: false,
      details: {
        preset_id: preset.id,
        preset_revision: preset.revision,
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
      },
    });
  }
  const resolved = { ...object(parsed.data), ...replayMetadata };
  enforceToolRequestLimits(resolved, dependencies);
  if (tool !== "validate_backtest_config" && options.markUsed !== false) {
    const used = await presetOperation(() => dependencies.presets.markUsed(preset.id, ownerSubject));
    if (!used) throw serviceNotFound("preset", preset.id);
  }
  return resolved;
}

async function resolvedPresetConfig(
  dependencies: McpToolDependencies,
  ownerSubject: string,
  value: GenericInput,
  fallback?: unknown,
): Promise<{ config: unknown; source: PresetSource }> {
  const source = (recordValue(value.source) ?? { type: "manual" }) as PresetSource;
  const explicit = recordValue(value.config);
  const symbols = Array.isArray(value.symbols)
    ? (value.symbols as unknown[]).filter((item): item is string => typeof item === "string")
    : undefined;
  if (explicit) return {
    config: symbols ? { ...explicit, symbols } : explicit,
    source,
  };
  if (source.type === "run") {
    const run = await dependencies.runRepository.get(String(source.runId), ownerSubject);
    if (!run) throw serviceNotFound("run", String(source.runId));
    const base = recordValue(run.input) ?? { input: run.input };
    return { config: symbols ? { ...base, symbols } : base, source };
  }
  if (source.type === "optimization_candidate" || source.type === "pareto_candidate") {
    const runId = String(source.runId);
    const run = await dependencies.runRepository.get(runId, ownerSubject);
    if (!run) throw serviceNotFound("run", runId);
    if (run.kind !== "optimization") {
      throw new ServiceError({ code: "INVALID_RUN_KIND", message: "최적화 후보 preset에는 optimization run이 필요합니다.", retryable: false });
    }
    const index = Math.max(0, Number(source.candidateIndex ?? 0));
    const candidate = await dependencies.optimizationRepository.getCandidateAt(
      runId,
      index,
      source.type === "pareto_candidate",
    );
    if (!candidate) {
      throw new ServiceError({ code: "CANDIDATE_NOT_FOUND", message: "저장할 최적화 후보를 찾을 수 없습니다.", retryable: false });
    }
    return {
      config: {
        symbols: Object.keys(candidate.weights),
        weights: candidate.weights,
        optimization_run_id: runId,
        candidate_id: candidate.id,
        candidate_rank: candidate.rank,
        metrics: candidate.metrics,
      },
      source,
    };
  }
  if (source.type === "current_portfolio") {
    const holdings = Array.isArray(source.holdings) ? source.holdings : [];
    const holdingRecords = holdings.map(recordValue).filter((item): item is GenericInput => Boolean(item));
    const explicitWeights = Object.fromEntries(holdingRecords
      .filter((item) => typeof item.symbol === "string" && typeof item.weight === "number")
      .map((item) => [String(item.symbol), Number(item.weight)]));
    const currencies = new Set(holdingRecords.map((item) => item.currency).filter((item): item is string => typeof item === "string"));
    const evaluationTotal = holdingRecords.reduce((sum, item) => sum + (typeof item.evaluationAmount === "number" ? item.evaluationAmount : 0), 0);
    const sameCurrencyWeights = currencies.size <= 1 && evaluationTotal > 0
      ? Object.fromEntries(holdingRecords
        .filter((item) => typeof item.symbol === "string" && typeof item.evaluationAmount === "number")
        .map((item) => [String(item.symbol), Number(item.evaluationAmount) / evaluationTotal]))
      : undefined;
    const defaultWeights = Object.keys(explicitWeights).length === holdingRecords.length
      ? explicitWeights
      : sameCurrencyWeights;
    return {
      config: {
        symbols: symbols ?? holdings.map((item) => recordValue(item)?.symbol).filter((item): item is string => typeof item === "string"),
        holdings,
        ...(defaultWeights ? { defaultWeights } : {}),
        ...(typeof recordValue(source.summary)?.cashWeight === "number"
          ? { cashWeight: Number(recordValue(source.summary)?.cashWeight) }
          : {}),
        benchmark: recordValue(source.summary)?.benchmark,
        sourceAsOf: source.asOf,
        dataQuality: {
          defaultWeights: defaultWeights ? "available" : "unavailable",
          cashWeight: typeof recordValue(source.summary)?.cashWeight === "number" ? "available" : "unavailable",
          ...(!defaultWeights && currencies.size > 1
            ? { warning: "다중 통화 보유 평가액에 공통 기준통화 환산값이 없어 기본 비중을 추정하지 않았습니다." }
            : {}),
        },
      },
      source,
    };
  }
  if (fallback !== undefined) {
    const base = recordValue(fallback) ?? { value: fallback };
    return { config: symbols ? { ...base, symbols } : base, source };
  }
  return { config: { symbols: symbols ?? [] }, source };
}

function importDocument(value: unknown): {
  name: string;
  description: string;
  config: unknown;
  tags: string[];
  source: PresetSource;
} {
  let parsed = value;
  if (typeof value === "string") {
    try { parsed = JSON.parse(value) as unknown; } catch {
      throw new ServiceError({ code: "INVALID_PRESET_IMPORT", message: "preset 가져오기 JSON을 해석할 수 없습니다.", retryable: false });
    }
  }
  const root = recordValue(parsed);
  const preset = recordValue(root?.preset);
  if (!root || root.schema_version !== PRESET_EXPORT_SCHEMA_VERSION || !preset || typeof preset.name !== "string") {
    throw new ServiceError({ code: "INVALID_PRESET_IMPORT", message: "지원하지 않는 preset export 문서입니다.", retryable: false });
  }
  return {
    name: preset.name,
    description: typeof preset.description === "string" ? preset.description : "",
    config: preset.config,
    tags: Array.isArray(preset.tags) ? preset.tags.filter((tag): tag is string => typeof tag === "string") : [],
    source: (recordValue(preset.source) ?? { type: "unknown" }) as PresetSource,
  };
}

function nestedRunId(value: unknown, depth = 0): string | undefined {
  if (depth > 5) return undefined;
  const source = recordValue(value);
  if (!source) return undefined;
  const direct = source.run_id ?? source.runId;
  if (typeof direct === "string") return direct;
  return nestedRunId(source.result, depth + 1) ?? nestedRunId(source.run, depth + 1);
}

async function walkForward(value: GenericInput, loaded: LoadedReturnSeries, context: {
  updateProgress: (progress: number, detail?: Record<string, unknown>) => Promise<void>;
  throwIfCancelled: () => Promise<void>;
}) {
  const assetCount = (value.symbols as string[]).length;
  const assetReturns = loaded.returns.slice(0, assetCount);
  const benchmarkReturns = value.benchmark ? loaded.returns[assetCount] : undefined;
  const aligned = alignReturnSeries(assetReturns);
  const windows = buildWalkForwardWindows(aligned.dates.length, {
    trainWindow: Number(value.trainWindow),
    testWindow: Number(value.testWindow),
    step: Number(value.step),
  });
  if (!windows.length) throw new ServiceError({ code: "INSUFFICIENT_WALK_FORWARD_DATA", message: "학습·검증 구간을 만들 데이터가 부족합니다.", retryable: false });
  const totalBudget = Number(value.candidateBudget);
  if (totalBudget < windows.length) {
    throw new ServiceError({
      code: "CANDIDATE_BUDGET_TOO_SMALL",
      message: `Walk-forward ${windows.length}개 구간을 모두 검증하려면 candidate budget이 최소 ${windows.length}이어야 합니다.`,
      retryable: false,
      field: "candidateBudget",
    });
  }
  const selected: Array<{ window: unknown; weights: Record<string, number>; oos: ReturnType<typeof analyzeReturnSeries> }> = [];
  const selectionCounts = new Map<string, number>();
  const baseFoldBudget = Math.floor(totalBudget / windows.length);
  const budgetRemainder = totalBudget % windows.length;
  let completedCandidates = 0;
  const objective = value.objective as OptimizationObjective;
  for (let index = 0; index < windows.length; index += 1) {
    await context.throwIfCancelled();
    const window = windows[index];
    const trainStart = aligned.dates[window.trainStartIndex];
    const trainEnd = aligned.dates[window.trainEndIndex];
    const alignedTrainingReturns = assetReturns.map((series): ReturnSeriesInput => ({
      key: series.key,
      label: series.label,
      points: aligned.dates.slice(window.trainStartIndex, window.trainEndIndex + 1).map((date, relative) => ({
        date,
        value: aligned.byKey[series.key][window.trainStartIndex + relative],
      })),
    }));
    const trainingPrices = alignedTrainingReturns.map((series) => returnsToPrices(series, 0, series.points.length - 1));
    const trainingBenchmark = benchmarkReturns ? {
      ...benchmarkReturns,
      points: benchmarkReturns.points.filter((point) => point.date >= trainStart && point.date <= trainEnd),
    } : undefined;
    const foldBudget = baseFoldBudget + (index < budgetRemainder ? 1 : 0);
    const output = optimizePortfolio({
      ...optimizationInput(value, { ...loaded, prices: trainingPrices }, false),
      priceSeries: trainingPrices,
      benchmark: trainingBenchmark,
      candidateBudget: foldBudget,
      seed: Number(value.seed) + index,
    });
    const best = output.bestByObjective[objective];
    if (!best) continue;
    const oos = analyzeReturnSeries(portfolioReturns(aligned, best.weights, window.testStartIndex, window.testEndIndex));
    for (const symbol of Object.keys(best.weights)) selectionCounts.set(symbol, (selectionCounts.get(symbol) ?? 0) + 1);
    selected.push({
      window: {
        ...window,
        trainStart: aligned.dates[window.trainStartIndex],
        trainEnd: aligned.dates[window.trainEndIndex],
        testStart: aligned.dates[window.testStartIndex],
        testEnd: aligned.dates[window.testEndIndex],
      },
      weights: best.weights,
      oos,
    });
    completedCandidates += foldBudget;
    await context.updateProgress(completedCandidates / totalBudget, {
      completedCandidates,
      totalCandidates: totalBudget,
      currentValidationWindow: `${index + 1}/${windows.length}`,
    });
  }
  const weightChanges = selected.slice(1).map((fold, index) => {
    const previous = selected[index].weights;
    const keys = new Set([...Object.keys(previous), ...Object.keys(fold.weights)]);
    return 0.5 * Array.from(keys).reduce((sum, key) => sum + Math.abs((previous[key] ?? 0) - (fold.weights[key] ?? 0)), 0);
  });
  const worst = [...selected].sort((a, b) => (a.oos.sharpeRatio ?? -Infinity) - (b.oos.sharpeRatio ?? -Infinity))[0];
  return {
    folds: selected,
    worst_validation_window: worst?.window ?? null,
    weight_stability: weightChanges.length ? 1 - weightChanges.reduce((sum, item) => sum + item, 0) / weightChanges.length : null,
    selection_frequency: Object.fromEntries(Array.from(selectionCounts, ([symbol, count]) => [symbol, count / Math.max(1, selected.length)])),
    oos_summary: {
      fold_count: selected.length,
      average_sharpe: selected.length ? selected.reduce((sum, fold) => sum + (fold.oos.sharpeRatio ?? 0), 0) / selected.length : null,
      worst_sharpe: worst?.oos.sharpeRatio ?? null,
    },
  };
}

export function createToolHandlers(dependencies: McpToolDependencies): Record<ToolName, ToolHandler> {
  const handlers: Record<ToolName, ToolHandler> = {
    search_instruments: async (input) => {
      const value = object(input);
      const result = await dependencies.instruments.search(value as never);
      const revision = await dependencies.marketData.repository.dataRevision();
      return envelope({ request: value, dataRevision: revision, result: { instruments: result }, dataQuality: { result_count: result.length } });
    },
    get_data_availability: async (input) => {
      const value = object(input);
      const result = await dependencies.marketData.getDataAvailability(value.symbols as string[], Boolean(value.adjusted));
      return envelope({
        request: value,
        dataRevision: result.dataRevision,
        effectivePeriod: result.commonPeriod,
        assumptions: ["결측은 공통 cache 기간의 전체 종목 관측일 합집합 대비 해당 종목 미관측일입니다."],
        result,
        dataQuality: { assets: result.assets.length, common_observations: result.commonObservations, union_observations: result.unionObservations },
      });
    },
    get_price_series: async (input, ownerSubject) => {
      const value = object(input);
      const series = await dependencies.marketData.getPriceSeries(value as never);
      const sizeRequiresResource = dependencies.artifacts.shouldExternalize(series.points, series.points.length);
      const externalize = value.outputMode === "resource" || sizeRequiresResource;
      const descriptor = externalize
        ? dependencies.resources.storeMarket(
            envelope({ request: value, dataRevision: series.dataRevision, result: {} }).request_hash,
            series.points,
            series.dataRevision,
            ownerSubject,
          )
        : undefined;
      return envelope({
        request: value,
        dataRevision: series.dataRevision,
        requestedPeriod: series.requestedPeriod,
        effectivePeriod: series.effectivePeriod,
        assumptions: series.assumptions,
        warnings: [
          ...series.warnings,
          ...(sizeRequiresResource && value.outputMode === "inline" ? ["요청한 inline 크기가 안전 상한을 넘어 resource로 분리했습니다."] : []),
        ],
        dataQuality: series.dataQuality,
        result: {
          instrument: series.instrument,
          interval: series.interval,
          adjusted: series.adjusted,
          currency_mode: series.currencyMode,
          currency: series.currency,
          ...(descriptor ? { resource: descriptor } : { points: series.points }),
        },
      });
    },
    analyze_instrument: async (input, ownerSubject) => {
      const value = object(input);
      const response = await dependencies.analytics.analyzeInstrument(value as never);
      const rolling = response.result.rolling_correlation;
      if (rolling && dependencies.artifacts.shouldExternalize(rolling, rolling.length)) {
        response.result.rolling_correlation = [];
        (response.result as GenericInput).rolling_correlation_resource = dependencies.resources.storeMarket(
          requestHash({ tool: "analyze_instrument", request: value, artifact: "rolling-correlation" }),
          rolling,
          response.data_revision,
          ownerSubject,
        );
        response.warnings.push("대용량 rolling correlation은 resource로 분리했습니다.");
      }
      return response;
    },
    analyze_asset_relationship: async (input, ownerSubject) => {
      const value = object(input);
      const response = await dependencies.analytics.relationships(value as never);
      const rolling = response.result.pairs.flatMap((pair) => pair.rollingCorrelation.map((point) => ({
        comparison: pair.key,
        ...point,
      })));
      if (dependencies.artifacts.shouldExternalize(rolling, rolling.length)) {
        for (const pair of response.result.pairs) pair.rollingCorrelation = [];
        (response.result as GenericInput).rolling_correlation_resource = dependencies.resources.storeMarket(
          requestHash({ tool: "analyze_asset_relationship", request: value, artifact: "rolling-correlation" }),
          rolling,
          response.data_revision,
          ownerSubject,
        );
        response.warnings.push("대용량 rolling correlation은 resource로 분리했습니다.");
      }
      return response;
    },
    get_correlation_matrix: (input) => dependencies.analytics.correlationMatrix(object(input) as never),
    validate_backtest_config: async (input, ownerSubject) => {
      const value = await resolvePresetExecution(dependencies, ownerSubject, object(input), "validate_backtest_config");
      return dependencies.backtests.validate(value as never);
    },
    run_portfolio_backtest: async (input, ownerSubject) => {
      const value = await resolvePresetExecution(dependencies, ownerSubject, object(input), "run_portfolio_backtest");
      return dependencies.backtests.run({ ownerSubject, request: value as never });
    },
    compare_backtests: async (input, ownerSubject) => {
      const value = object(input);
      const runs = await Promise.all((value.runIds as string[]).map((id) => dependencies.runs.get(id, ownerSubject)));
      if (runs.some((run) => !run)) throw new ServiceError({ code: "RUN_NOT_FOUND", message: "비교할 run 일부를 찾을 수 없습니다.", retryable: false });
      const completed = runs.filter((run): run is NonNullable<typeof run> => run?.status === "completed");
      if (completed.length < 2) throw new ServiceError({ code: "INSUFFICIENT_COMPLETED_RUNS", message: "완료된 백테스트 run이 2개 이상 필요합니다.", retryable: false });
      if (completed.some((run) => run.kind !== "backtest")) throw new ServiceError({ code: "INVALID_RUN_KIND", message: "백테스트 run만 비교할 수 있습니다.", retryable: false });
      const comparable = completed.map((run) => {
        const summary = (run.summary ?? {}) as Record<string, unknown>;
        const result = (run.result ?? {}) as {
          annualReturns?: Array<{ year: number; returnPercent: number }>;
          advanced?: { costEfficiency?: { estimatedTotalCost?: number; costDragPercent?: number } };
          dataQuality?: unknown;
          effectiveStartDate?: string;
          endDate?: string;
        };
        const annual = (result.annualReturns ?? []).map((item) => item.returnPercent).filter(Number.isFinite);
        const annualAverage = annual.length ? annual.reduce((sum, item) => sum + item, 0) / annual.length : null;
        const annualDispersion = annual.length > 1
          ? Math.sqrt(annual.reduce((sum, item) => sum + (item - (annualAverage ?? 0)) ** 2, 0) / (annual.length - 1))
          : null;
        return {
          run_id: run.id,
          request_hash: run.requestHash,
          data_revision: run.dataRevision,
          requested_period: (run.input as { startDate?: string; endDate?: string } | undefined),
          effective_period: result.effectiveStartDate && result.endDate ? { from: result.effectiveStartDate, to: result.endDate } : null,
          summary,
          stability: {
            annual_periods: annual.length,
            average_annual_return_percent: annualAverage,
            annual_return_dispersion_percent: annualDispersion,
            worst_annual_return_percent: annual.length ? Math.min(...annual) : null,
          },
          cost: result.advanced?.costEfficiency ?? null,
          data_quality: result.dataQuality ?? null,
          warnings: run.warnings,
        };
      });
      const metricDefinitions = [
        { key: "cagrPercent", higher: true },
        { key: "annualizedVolatilityPercent", higher: false },
        { key: "maxDrawdownPercent", higher: true },
        { key: "sharpeRatio", higher: true },
        { key: "sortinoRatio", higher: true },
        { key: "calmarRatio", higher: true },
      ] as const;
      const rankings = Object.fromEntries(metricDefinitions.map((metric) => [
        metric.key,
        [...comparable]
          .filter((item) => Number.isFinite(Number(item.summary[metric.key])))
          .sort((left, right) => metric.higher
            ? Number(right.summary[metric.key]) - Number(left.summary[metric.key])
            : Number(left.summary[metric.key]) - Number(right.summary[metric.key]))
          .map((item, index) => ({ rank: index + 1, run_id: item.run_id, value: Number(item.summary[metric.key]) })),
      ]));
      const dominates = (left: typeof comparable[number], right: typeof comparable[number]) => {
        const leftValues = [
          Number(left.summary.cagrPercent ?? -Infinity),
          -Math.abs(Number(left.summary.annualizedVolatilityPercent ?? Infinity)),
          -Math.abs(Number(left.summary.maxDrawdownPercent ?? Infinity)),
          -Number(left.cost?.estimatedTotalCost ?? 0),
        ];
        const rightValues = [
          Number(right.summary.cagrPercent ?? -Infinity),
          -Math.abs(Number(right.summary.annualizedVolatilityPercent ?? Infinity)),
          -Math.abs(Number(right.summary.maxDrawdownPercent ?? Infinity)),
          -Number(right.cost?.estimatedTotalCost ?? 0),
        ];
        return leftValues.every((item, index) => item >= rightValues[index])
          && leftValues.some((item, index) => item > rightValues[index]);
      };
      const paretoRunIds = comparable
        .filter((candidate) => !comparable.some((other) => other.run_id !== candidate.run_id && dominates(other, candidate)))
        .map((candidate) => candidate.run_id);
      const inputSignatures = comparable.map((item) => {
        const assets = ((completed.find((run) => run.id === item.run_id)?.input as { assets?: Array<{ symbol: string; weight: number }> } | undefined)?.assets ?? [])
          .map((asset) => [asset.symbol, asset.weight] as const)
          .sort(([left], [right]) => left.localeCompare(right));
        return { run_id: item.run_id, signature: JSON.stringify(assets) };
      });
      const duplicateCandidates = inputSignatures.flatMap((left, index) => inputSignatures.slice(index + 1)
        .filter((right) => right.signature === left.signature)
        .map((right) => ({ left_run_id: left.run_id, right_run_id: right.run_id, reason: "same_assets_and_weights" })));
      const revisions = new Set(completed.map((run) => run.dataRevision));
      return envelope({
        request: value,
        dataRevision: requestHash(Array.from(revisions).sort()),
        warnings: revisions.size > 1 ? ["run 사이에 data revision이 달라 직접 비교 시 주의가 필요합니다."] : [],
        result: {
          runs: comparable,
          rankings,
          pareto_run_ids: paretoRunIds,
          duplicate_candidates: duplicateCandidates,
          cost_range: {
            minimum: Math.min(...comparable.map((item) => Number(item.cost?.estimatedTotalCost ?? 0))),
            maximum: Math.max(...comparable.map((item) => Number(item.cost?.estimatedTotalCost ?? 0))),
          },
        },
        dataQuality: { completed: completed.length, requested: runs.length, distinct_data_revisions: revisions.size },
      });
    },
    get_backtest_artifact: async (input, ownerSubject) => {
      const value = object(input);
      const run = await dependencies.runs.get(String(value.runId), ownerSubject);
      if (!run) throw new ServiceError({ code: "RUN_NOT_FOUND", message: "run을 찾을 수 없습니다.", retryable: false });
      if (run.kind !== "backtest") throw new ServiceError({ code: "INVALID_RUN_KIND", message: "백테스트 run의 artifact만 조회할 수 있습니다.", retryable: false });
      const artifact = await dependencies.artifacts.get(run.id, value.type as never);
      if (!artifact) throw new ServiceError({ code: "ARTIFACT_NOT_FOUND", message: "artifact를 찾을 수 없습니다.", retryable: false });
      const inline = !dependencies.artifacts.shouldExternalize(artifact.content, artifact.descriptor.rowCount);
      return envelope({ request: value, dataRevision: run.dataRevision, result: { descriptor: artifact.descriptor, ...(inline ? { data: artifact.content } : {}) }, dataQuality: {} });
    },
    get_run_artifact: async (input, ownerSubject) => {
      const value = object(input);
      const run = await dependencies.runs.get(String(value.runId), ownerSubject);
      if (!run) throw new ServiceError({ code: "RUN_NOT_FOUND", message: "run을 찾을 수 없습니다.", retryable: false });
      const type = String(value.type);
      if (!isArtifactType(type)) throw new ServiceError({ code: "ARTIFACT_TYPE_NOT_FOUND", message: "지원하지 않는 artifact type입니다.", retryable: false });
      const artifact = await dependencies.artifacts.get(run.id, type);
      if (!artifact) throw new ServiceError({ code: "ARTIFACT_NOT_FOUND", message: "artifact를 찾을 수 없습니다.", retryable: false });
      const inline = !dependencies.artifacts.shouldExternalize(artifact.content, artifact.descriptor.rowCount);
      return envelope({ request: value, dataRevision: run.dataRevision, result: { descriptor: artifact.descriptor, ...(inline ? { data: artifact.content } : {}) }, dataQuality: {} });
    },
    get_current_portfolio: async (input) => {
      const value = object(input);
      const result = await dependencies.portfolio.current(value.accountSelector as string | undefined);
      return envelope({ request: value, dataRevision: result.generated_at, result, assumptions: ["계좌 번호와 금액은 반환하지 않습니다."], dataQuality: {} });
    },
    analyze_portfolio_exposures: async (input, ownerSubject) => {
      const value = object(input);
      const calculate = () => analyzePortfolioExposures(value.assets as never, Boolean(value.lookThrough));
      if (value.executionMode === "async") {
        const queued = await dependencies.runs.enqueue({
          ownerSubject,
          kind: "exposure_analysis",
          config: value,
          dataRevision: "user-supplied-exposure-snapshot",
          totalCandidates: 1,
          allowInlineInExternal: true,
          task: async (context) => {
            await context.throwIfCancelled();
            const analysis = calculate();
            await context.throwIfCancelled();
            await context.updateProgress(1, { completedCandidates: 1, totalCandidates: 1 });
            return {
              summary: {
                asset_count: Array.isArray(value.assets) ? value.assets.length : 0,
                data_quality: analysis.dataQuality,
              },
              result: analysis,
              warnings: analysis.warnings,
              artifacts: [{ type: "portfolio-exposures", content: analysis, rowCount: 1 }],
            };
          },
        });
        return runResultEnvelope(queued.run, value);
      }
      const analysis = calculate();
      return envelope({
        request: value,
        dataRevision: "user-supplied-exposure-snapshot",
        assumptions: ["노출 metadata와 ETF 구성종목은 요청에 제공된 snapshot만 사용하며 미제공 필드를 추정하지 않습니다."],
        warnings: analysis.warnings,
        dataQuality: analysis.dataQuality,
        result: analysis,
      });
    },
    find_diversifying_assets: async (input) => {
      const value = object(input);
      const base = Array.from(new Set(value.baseSymbols as string[]));
      const cachedUniverse = value.candidateSymbols as string[] | undefined
        ?? (await dependencies.marketData.repository.listUniverse(500)).map((item) => item.symbol);
      const candidateCapacity = Math.max(0, Math.min(19, dependencies.maxAssets - base.length));
      const candidates = Array.from(new Set(cachedUniverse)).filter((item) => !base.includes(item)).slice(0, candidateCapacity);
      if (!candidates.length) throw new ServiceError({ code: "EMPTY_CANDIDATE_UNIVERSE", message: "분석할 후보 자산이 없습니다.", retryable: false });
      const loaded = await dependencies.returnSeries.load({
        symbols: [...base, ...candidates],
        fromDate: String(value.fromDate),
        toDate: String(value.toDate),
        currencyMode: value.currencyMode as "local" | "KRW",
        adjusted: true,
      });
      const baseReturns = loaded.returns.slice(0, base.length);
      const basePortfolio = weightedReturns(
        baseReturns,
        normalizedWeights(base, value.baseWeights as Record<string, number> | undefined),
        "__base_portfolio__",
        "기준 포트폴리오",
      );
      const baseSummary = analyzeReturnSeries(basePortfolio, { minimumObservations: 2 });
      const candidateWeight = Number(value.candidateWeight);
      const maximum = Number(value.maximumCorrelation);
      const ranked = candidates.map((candidate, index) => {
        const candidateSeries = loaded.returns[base.length + index];
        const relationship = analyzePairedReturnSeries(basePortfolio, candidateSeries, { minimumObservations: 2 });
        const standalone = analyzeReturnSeries(candidateSeries, { minimumObservations: 2 });
        const mixed = weightedReturns(
          [basePortfolio, candidateSeries],
          { [basePortfolio.key]: 1 - candidateWeight, [candidateSeries.key]: candidateWeight },
          `__mixed_${candidate}__`,
          `${candidate} 혼합 포트폴리오`,
        );
        const mixedSummary = analyzeReturnSeries(mixed, { minimumObservations: 2 });
        const baseVariance = (baseSummary.annualizedVolatility ?? 0) ** 2;
        const mixedVariance = (mixedSummary.annualizedVolatility ?? 0) ** 2;
        return {
          symbol: candidate,
          correlation: relationship.pearsonCorrelation,
          down_market_correlation: relationship.downCorrelation,
          beta: relationship.beta,
          observations: relationship.observations,
          candidate_metrics: riskSnapshot(standalone),
          expected_variance_effect: {
            candidate_weight: candidateWeight,
            base_variance: baseVariance,
            mixed_variance: mixedVariance,
            variance_reduction: baseVariance - mixedVariance,
            volatility_reduction: (baseSummary.annualizedVolatility ?? 0) - (mixedSummary.annualizedVolatility ?? 0),
          },
          mixed_portfolio_metrics: riskSnapshot(mixedSummary),
        };
      })
        .filter((candidate) => (candidate.correlation ?? Infinity) <= maximum)
        .sort((left, right) => (
          right.expected_variance_effect.variance_reduction - left.expected_variance_effect.variance_reduction
          || Math.abs(left.down_market_correlation ?? 1) - Math.abs(right.down_market_correlation ?? 1)
        ))
        .slice(0, Number(value.limit));
      return envelope({
        request: value,
        dataRevision: loaded.dataRevision,
        requestedPeriod: loaded.requestedPeriod,
        effectivePeriod: loaded.effectivePeriod,
        assumptions: ["수정주가 수익률을 공통 관측일로 정렬했습니다.", "분산효과는 기준 포트폴리오에 후보를 지정 비중으로 혼합한 역사적 분산 변화입니다."],
        warnings: [
          ...loaded.warnings,
          ...(!value.candidateSymbols ? ["전체 시장이 아니라 현재 cache에 명시적으로 존재하는 제한된 universe만 사용했습니다."] : []),
        ],
        result: {
          base_portfolio_metrics: riskSnapshot(baseSummary),
          candidates: ranked,
          universe: value.candidateSymbols ? "explicit" : "cached_only",
          universe_size: candidates.length,
        },
        dataQuality: { ...loaded.dataQuality, analyzed_candidates: candidates.length },
      });
    },
    analyze_market_regimes: async (input, ownerSubject) => {
      const value = object(input);
      const response = await dependencies.analytics.marketRegimes(value as never);
      const observations = response.result.observations;
      if (dependencies.artifacts.shouldExternalize(observations, observations.length)) {
        response.result.observations = [];
        (response.result as GenericInput).observations_resource = dependencies.resources.storeMarket(
          requestHash({ tool: "analyze_market_regimes", request: value, artifact: "observations" }),
          observations,
          response.data_revision,
          ownerSubject,
        );
        response.warnings.push("대용량 regime 관측값은 resource로 분리했습니다.");
      }
      return response;
    },
    analyze_return_contribution: async (input, ownerSubject) => {
      const value = object(input);
      const run = await dependencies.runs.get(String(value.runId), ownerSubject);
      if (!run?.result) throw new ServiceError({ code: "RUN_RESULT_NOT_FOUND", message: "완료된 run 결과가 없습니다.", retryable: false });
      if (run.kind !== "backtest") throw new ServiceError({ code: "INVALID_RUN_KIND", message: "백테스트 run의 수익 기여만 조회할 수 있습니다.", retryable: false });
      const result = run.result as { contributions?: unknown; advanced?: { riskContributions?: unknown } };
      return envelope({
        request: value,
        dataRevision: run.dataRevision,
        assumptions: ["상승·하락 regime은 해당 일자의 포트폴리오 수익률이 각각 0 이상·미만인지로 구분합니다."],
        result: { contributions: result.contributions, risk_contributions: result.advanced?.riskContributions },
        dataQuality: {},
      });
    },
    optimize_portfolio: async (input, ownerSubject) => {
      const value = await resolvePresetExecution(dependencies, ownerSubject, object(input), "optimize_portfolio");
      if (dependencies.runs.executionMode === "inline" && (
        value.algorithm !== "random_search"
        || (value.groupConstraints as unknown[]).length > 0
        || Object.keys(value.robustScoreWeights as Record<string, number>).length > 0
        || recordValue(value.regimePolicySearch)?.enabled === true
      )) {
        throw new ServiceError({
          code: "RUST_ADVANCED_OPTIMIZER_REQUIRED",
          message: "고급 optimizer 알고리즘·그룹 제약·사용자 robust score·국면 정책은 rust_socket 또는 external Rust worker 실행 모드가 필요합니다.",
          retryable: false,
        });
      }
      const symbols = [...value.symbols as string[], ...(value.benchmark ? [String(value.benchmark)] : [])];
      const loaded = await dependencies.returnSeries.load({ symbols, fromDate: String(value.fromDate), toDate: String(value.toDate), currencyMode: value.currencyMode as never, adjusted: true });
      const budget = Math.min(Number(value.candidateBudget), dependencies.maxCandidateBudget);
      value.candidateBudget = budget;
      const ledger = dependencies.runs.executionMode === "inline"
        ? { warnings: [
          "inline 호환 엔진은 legacy random-search 계산만 수행하며 Ledoit–Wolf, 기준 포트폴리오, IS/OOS robust score 분리와 2단계 ledger 재검증은 Rust 실행 모드가 필요합니다.",
        ] }
        : await optimizationLedgerTemplate(dependencies, value);
      const workerPayload = {
        optimization: {
          ...optimizationInput(value, loaded),
          ...(ledger.simulation ? { ledgerTemplate: ledger.simulation } : {}),
        },
        objective: value.objective,
        market_warnings: [...loaded.warnings, ...ledger.warnings],
        settings: value,
      };
      const queued = dependencies.runs.executionMode === "external"
        ? await dependencies.runs.enqueueExternal({
          ownerSubject,
          kind: "optimization",
          config: value,
          dataRevision: loaded.dataRevision,
          totalCandidates: budget,
          payload: workerPayload,
        })
        : dependencies.runs.executionMode === "rust_socket"
          ? await dependencies.runs.enqueue({
            ownerSubject,
            kind: "optimization",
            config: value,
            dataRevision: loaded.dataRevision,
            totalCandidates: budget,
            task: async (context) => {
              await context.throwIfCancelled();
              const output = await requireRust(dependencies).compute<OptimizationOutput>("optimization", workerPayload, { signal: context.signal });
              const candidates = output.artifacts.find((artifact) => artifact.type === "candidates")?.content as PortfolioCandidate[] | undefined
                ?? output.result.candidates;
              const frontier = output.artifacts.find((artifact) => artifact.type === "worker-pareto-frontier")?.content as PortfolioCandidate[] | undefined
                ?? output.result.paretoFrontier;
              await persistOptimization(dependencies, context.runId, value.objective as OptimizationObjective, Number(value.seed), budget, value, candidates, frontier);
              await context.updateProgress(1, { completedCandidates: candidates.length, totalCandidates: budget });
              return rustTaskResult(output);
            },
          })
        : await dependencies.runs.enqueue({
          ownerSubject,
          kind: "optimization",
          config: value,
          dataRevision: loaded.dataRevision,
          totalCandidates: budget,
          task: async (context) => {
            await context.throwIfCancelled();
            const output = optimizePortfolio(optimizationInput(value, loaded, false));
            await persistOptimization(dependencies, context.runId, value.objective as OptimizationObjective, Number(value.seed), budget, value, output.candidates, output.paretoFrontier);
            await context.updateProgress(1, { completedCandidates: output.candidateCount, totalCandidates: budget });
            return {
              summary: { best: output.bestByObjective[value.objective as OptimizationObjective], candidate_count: output.candidateCount, pareto_count: output.paretoFrontier.length },
              result: { ...output, candidates: output.candidates.slice(0, 20), paretoFrontier: output.paretoFrontier.slice(0, 100) },
              warnings: [...loaded.warnings, ...output.warnings],
              artifacts: [{ type: "candidates", content: output.candidates, rowCount: output.candidates.length }],
            };
          },
        });
      return runResultEnvelope(queued.run, value);
    },
    walk_forward_optimize: async (input, ownerSubject) => {
      const value = await resolvePresetExecution(dependencies, ownerSubject, object(input), "walk_forward_optimize");
      if (dependencies.runs.executionMode === "inline" && (
        value.algorithm !== "random_search"
        || value.mode !== "rolling"
        || Number(value.gap) !== 0
        || Number(value.embargo) !== 0
        || (value.seeds as number[]).length !== 1
        || (value.groupConstraints as unknown[]).length > 0
        || Object.keys(value.robustScoreWeights as Record<string, number>).length > 0
        || recordValue(value.regimePolicySearch)?.enabled === true
      )) {
        throw new ServiceError({
          code: "RUST_ADVANCED_WALK_FORWARD_REQUIRED",
          message: "anchored·gap·embargo·다중 seed Walk-forward와 고급 optimizer 옵션은 rust_socket 또는 external Rust worker 실행 모드가 필요합니다.",
          retryable: false,
        });
      }
      value.candidateBudget = Math.min(Number(value.candidateBudget), dependencies.maxCandidateBudget);
      const symbols = [...value.symbols as string[], ...(value.benchmark ? [String(value.benchmark)] : [])];
      const loaded = await dependencies.returnSeries.load({ symbols, fromDate: String(value.fromDate), toDate: String(value.toDate), currencyMode: value.currencyMode as never, adjusted: true });
      const observationCount = Math.max(0, (loaded.prices[0]?.points.length ?? 1) - 1);
      const firstTestStart = Number(value.trainWindow) + Number(value.gap);
      const foldAdvance = Math.max(Number(value.step), Number(value.testWindow) + Number(value.embargo));
      const foldCount = observationCount >= firstTestStart + Number(value.testWindow)
        ? 1 + Math.floor((observationCount - firstTestStart - Number(value.testWindow)) / Math.max(1, foldAdvance))
        : 0;
      const seedCount = (value.seeds as number[]).length;
      if (foldCount > 0) {
        const maximumPerFold = Math.floor(dependencies.maxCandidateBudget / foldCount);
        if (maximumPerFold < seedCount) {
          throw new ServiceError({ code: "CANDIDATE_BUDGET_LIMIT", message: "Walk-forward fold와 seed 수가 전체 후보 예산 상한을 초과합니다.", retryable: false });
        }
        if (Number(value.foldCandidateBudget) > maximumPerFold) {
          loaded.warnings.push(`fold별 후보 예산을 전체 안전 상한에 맞춰 ${maximumPerFold}개로 조정했습니다.`);
          value.foldCandidateBudget = maximumPerFold;
        }
        value.candidateBudget = Number(value.foldCandidateBudget) * foldCount;
      }
      const workerPayload = {
        optimization: optimizationInput(value, loaded),
        objective: value.objective,
        walkForwardConfig: {
          mode: value.mode,
          trainWindow: value.trainWindow,
          testWindow: value.testWindow,
          step: value.step,
          gap: value.gap,
          embargo: value.embargo,
          foldCandidateBudget: value.foldCandidateBudget,
          seeds: value.seeds,
          minimumTrainObservations: Math.min(Number(value.trainWindow), 20),
          minimumTestObservations: Math.min(Number(value.testWindow), 5),
        },
        market_warnings: loaded.warnings,
      };
      const queued = dependencies.runs.executionMode === "external"
        ? await dependencies.runs.enqueueExternal({
          ownerSubject,
          kind: "walk_forward",
          config: value,
          dataRevision: loaded.dataRevision,
          totalCandidates: Number(value.candidateBudget),
          payload: workerPayload,
        })
        : dependencies.runs.executionMode === "rust_socket"
          ? await dependencies.runs.enqueue({
            ownerSubject,
            kind: "walk_forward",
            config: value,
            dataRevision: loaded.dataRevision,
            totalCandidates: Number(value.candidateBudget),
            task: async (context) => {
              await context.throwIfCancelled();
              const output = await requireRust(dependencies).compute("walk_forward", workerPayload, { signal: context.signal });
              await context.updateProgress(1, { completedCandidates: Number(value.candidateBudget), totalCandidates: Number(value.candidateBudget) });
              return rustTaskResult(output);
            },
          })
        : await dependencies.runs.enqueue({
        ownerSubject,
        kind: "walk_forward",
        config: value,
        dataRevision: loaded.dataRevision,
        totalCandidates: Number(value.candidateBudget),
        task: async (context) => {
          const result = await walkForward(value, loaded, context as never);
          return {
            summary: result.oos_summary,
            result,
            warnings: loaded.warnings,
            artifacts: [{ type: "walk-forward", content: result.folds, rowCount: result.folds.length }],
          };
        },
      });
      return runResultEnvelope(queued.run, value);
    },
    stress_test_portfolio: async (input, ownerSubject) => {
      const value = object(input);
      const scenarios = value.scenarios as Array<GenericInput>;
      const requests = scenarios.map((scenario): BacktestRunRequest => {
        const base = { ...value.baseConfig as BacktestRunRequest };
        const exclude = new Set((scenario.excludeSymbols as string[] | undefined) ?? []);
        const assets = base.assets.filter((asset) => !exclude.has(asset.symbol));
        const total = assets.reduce((sum, asset) => sum + asset.weight, 0);
        if (!assets.length || total <= 0) {
          throw new ServiceError({ code: "EMPTY_STRESS_PORTFOLIO", message: "stress scenario가 모든 종목을 제외할 수 없습니다.", retryable: false });
        }
        const cashTarget = base.execution?.cashTargetPercent ?? 0;
        return {
          ...base,
          assets: assets.map((asset) => ({ ...asset, weight: asset.weight / total * (100 - cashTarget) })),
          ...(scenario.startDate !== undefined ? { startDate: String(scenario.startDate) } : {}),
          ...(scenario.endDate !== undefined ? { endDate: String(scenario.endDate) } : {}),
          ...(scenario.transactionCostBps !== undefined ? { transactionCostBps: Number(scenario.transactionCostBps) } : {}),
          ...(scenario.monthlyCashFlow !== undefined ? { monthlyCashFlow: Number(scenario.monthlyCashFlow) } : {}),
          ...(scenario.cashFlowFrequency ? { cashFlowFrequency: scenario.cashFlowFrequency as NonNullable<BacktestRunRequest["cashFlowFrequency"]> } : {}),
          ...(scenario.cashFlowTiming ? { cashFlowTiming: scenario.cashFlowTiming as NonNullable<BacktestRunRequest["cashFlowTiming"]> } : {}),
          ...(scenario.currencyMode ? { currencyMode: scenario.currencyMode as "local" | "KRW" } : {}),
          ...(scenario.rebalanceFrequency ? { rebalanceFrequency: scenario.rebalanceFrequency as BacktestRunRequest["rebalanceFrequency"] } : {}),
          ...(scenario.rebalanceThresholdPercent !== undefined ? { rebalanceThresholdPercent: Number(scenario.rebalanceThresholdPercent) } : {}),
        };
      });
      const preparedScenarios: Array<{ id: string; name: unknown; config: BacktestRunRequest; simulation: unknown }> = [];
      const preparationWarnings: string[] = [];
      if (dependencies.runs.executionMode === "external" || dependencies.runs.executionMode === "rust_socket") {
        for (let index = 0; index < requests.length; index += 1) {
          const prepared = await dependencies.backtestEngine.prepare(requests[index]);
          preparationWarnings.push(...prepared.responseContext.warnings);
          preparedScenarios.push({
            id: `stress-${index + 1}`,
            name: scenarios[index].name,
            config: requests[index],
            simulation: prepared.simulation,
          });
        }
      }
      const revision = await dependencies.marketData.repository.dataRevision();
      const workerPayload = { scenarios: preparedScenarios, market_warnings: Array.from(new Set(preparationWarnings)) };
      const queued = dependencies.runs.executionMode === "external"
        ? await dependencies.runs.enqueueExternal({
          ownerSubject,
          kind: "stress_test",
          config: value,
          dataRevision: revision,
          totalCandidates: scenarios.length,
          payload: workerPayload,
        })
        : dependencies.runs.executionMode === "rust_socket"
          ? await dependencies.runs.enqueue({
            ownerSubject,
            kind: "stress_test",
            config: value,
            dataRevision: revision,
            totalCandidates: scenarios.length,
            task: async (context) => {
              await context.throwIfCancelled();
              const output = await requireRust(dependencies).compute("stress_test", workerPayload, { signal: context.signal });
              await context.updateProgress(1, { completedCandidates: scenarios.length, totalCandidates: scenarios.length });
              return rustTaskResult(output);
            },
          })
        : await dependencies.runs.enqueue({
        ownerSubject,
        kind: "stress_test",
        config: value,
        dataRevision: revision,
        totalCandidates: scenarios.length,
        task: async (context) => {
          const results = [];
          const warnings: string[] = [];
          for (let index = 0; index < scenarios.length; index += 1) {
            await context.throwIfCancelled();
            const scenario = scenarios[index];
            const base = { ...value.baseConfig as BacktestRunRequest };
            const exclude = new Set((scenario.excludeSymbols as string[] | undefined) ?? []);
            const assets = base.assets.filter((asset) => !exclude.has(asset.symbol));
            const total = assets.reduce((sum, asset) => sum + asset.weight, 0);
            if (!assets.length || total <= 0) {
              throw new ServiceError({
                code: "EMPTY_STRESS_PORTFOLIO",
                message: "stress scenario가 모든 종목을 제외할 수 없습니다.",
                retryable: false,
              });
            }
            const request = {
              ...base,
              assets: assets.map((asset) => ({ ...asset, weight: asset.weight / total * 100 })),
              ...(scenario.startDate !== undefined ? { startDate: String(scenario.startDate) } : {}),
              ...(scenario.endDate !== undefined ? { endDate: String(scenario.endDate) } : {}),
              ...(scenario.transactionCostBps !== undefined ? { transactionCostBps: Number(scenario.transactionCostBps) } : {}),
              ...(scenario.monthlyCashFlow !== undefined ? { monthlyCashFlow: Number(scenario.monthlyCashFlow) } : {}),
              ...(scenario.cashFlowFrequency ? { cashFlowFrequency: scenario.cashFlowFrequency as NonNullable<BacktestRunRequest["cashFlowFrequency"]> } : {}),
              ...(scenario.cashFlowTiming ? { cashFlowTiming: scenario.cashFlowTiming as NonNullable<BacktestRunRequest["cashFlowTiming"]> } : {}),
              ...(scenario.currencyMode ? { currencyMode: scenario.currencyMode as "local" | "KRW" } : {}),
              ...(scenario.rebalanceFrequency ? { rebalanceFrequency: scenario.rebalanceFrequency as BacktestRunRequest["rebalanceFrequency"] } : {}),
              ...(scenario.rebalanceThresholdPercent !== undefined ? { rebalanceThresholdPercent: Number(scenario.rebalanceThresholdPercent) } : {}),
            };
            const result = await dependencies.backtestEngine.run(request);
            const summary = {
              ...result.metrics,
              cvar95Percent: result.advanced.tailRisk.expectedShortfall95Percent,
            };
            results.push({ name: scenario.name, summary, data_quality: result.dataQuality, warnings: result.warnings });
            warnings.push(...result.warnings.map((warning) => `${scenario.name}: ${warning}`));
            await context.updateProgress((index + 1) / scenarios.length, { completedCandidates: index + 1, totalCandidates: scenarios.length });
          }
          return { summary: { scenario_count: results.length }, result: { scenarios: results }, warnings: Array.from(new Set(warnings)), artifacts: [{ type: "result", content: { scenarios: results }, rowCount: results.length }] };
        },
      });
      return runResultEnvelope(queued.run, value);
    },
    build_pareto_frontier: async (input, ownerSubject) => {
      const value = object(input);
      const run = await dependencies.runs.get(String(value.runId), ownerSubject);
      if (!run) throw new ServiceError({ code: "RUN_NOT_FOUND", message: "run을 찾을 수 없습니다.", retryable: false });
      if (run.kind !== "optimization") throw new ServiceError({ code: "INVALID_RUN_KIND", message: "최적화 run이 필요합니다.", retryable: false });
      if (value.executionMode === "async") {
        const queued = await dependencies.runs.enqueue({
          ownerSubject,
          kind: "pareto_frontier",
          config: value,
          dataRevision: run.dataRevision,
          totalCandidates: Number(value.limit),
          allowInlineInExternal: true,
          task: async (context) => {
            await context.throwIfCancelled();
            const candidates = await dependencies.optimizationRepository.listParetoCandidates(run.id, Number(value.limit));
            await context.throwIfCancelled();
            await context.updateProgress(1, { completedCandidates: candidates.length, totalCandidates: Number(value.limit) });
            const result = { candidates };
            return {
              summary: { loaded: candidates.length, source_run_id: run.id },
              result,
              artifacts: [{ type: "pareto-frontier", content: result, rowCount: candidates.length }],
            };
          },
        });
        return runResultEnvelope(queued.run, value);
      }
      const candidates = await dependencies.optimizationRepository.listParetoCandidates(run.id, Number(value.limit));
      return envelope({ request: value, dataRevision: run.dataRevision, result: { candidates }, dataQuality: { loaded: candidates.length } });
    },
    find_redundant_assets: async (input) => {
      const value = object(input);
      const symbols = value.symbols as string[];
      const loaded = await dependencies.returnSeries.load({
        symbols,
        fromDate: String(value.fromDate),
        toDate: String(value.toDate),
        currencyMode: value.currencyMode as "local" | "KRW",
        adjusted: true,
      });
      const fullPortfolio = weightedReturns(loaded.returns, normalizedWeights(symbols), "__full_portfolio__", "전체 동일비중 포트폴리오");
      const fullRisk = analyzeReturnSeries(fullPortfolio, { minimumObservations: 2 });
      const removalImpact = Object.fromEntries(symbols.map((removed) => {
        const kept = loaded.returns.filter((series) => series.key !== removed);
        const remaining = weightedReturns(kept, normalizedWeights(kept.map((series) => series.key)), `__without_${removed}__`, `${removed} 제외 포트폴리오`);
        const analysis = analyzeReturnSeries(remaining, { minimumObservations: 2 });
        return [removed, {
          before: riskSnapshot(fullRisk),
          after: riskSnapshot(analysis),
          volatility_change: (analysis.annualizedVolatility ?? 0) - (fullRisk.annualizedVolatility ?? 0),
          cagr_change: (analysis.cagr ?? 0) - (fullRisk.cagr ?? 0),
          max_drawdown_change: (analysis.maxDrawdown ?? 0) - (fullRisk.maxDrawdown ?? 0),
        }];
      }));
      const pairDetails = [];
      for (let left = 0; left < loaded.returns.length; left += 1) {
        for (let right = left + 1; right < loaded.returns.length; right += 1) {
          const relationship = analyzePairedReturnSeries(loaded.returns[left], loaded.returns[right], { minimumObservations: 2 });
          const drawdowns = analyzePairedReturnSeries(drawdownPath(loaded.returns[left]), drawdownPath(loaded.returns[right]), { minimumObservations: 2 });
          const correlation = relationship.pearsonCorrelation;
          const betaDistance = relationship.beta === null ? null : Math.abs(relationship.beta - 1);
          const drawdownCorrelation = drawdowns.pearsonCorrelation;
          const redundant = correlation !== null
            && Math.abs(correlation) >= Number(value.correlationThreshold)
            && betaDistance !== null
            && betaDistance <= Number(value.betaTolerance)
            && drawdownCorrelation !== null
            && drawdownCorrelation >= Number(value.drawdownCorrelationThreshold);
          pairDetails.push({
            left: loaded.returns[left].key,
            right: loaded.returns[right].key,
            correlation,
            beta: relationship.beta,
            beta_distance_from_one: betaDistance,
            drawdown_path_correlation: drawdownCorrelation,
            observations: relationship.observations,
            redundant,
            removal_impact: {
              [loaded.returns[left].key]: removalImpact[loaded.returns[left].key],
              [loaded.returns[right].key]: removalImpact[loaded.returns[right].key],
            },
          });
        }
      }
      return envelope({
        request: value,
        dataRevision: loaded.dataRevision,
        requestedPeriod: loaded.requestedPeriod,
        effectivePeriod: loaded.effectivePeriod,
        assumptions: ["수정주가 수익률과 동일비중 기준 제거 영향을 사용했습니다.", "중복 판정은 상관·Beta 1 근접도·낙폭 경로 상관을 모두 충족해야 합니다."],
        warnings: loaded.warnings,
        result: {
          redundant_pairs: pairDetails.filter((pair) => pair.redundant),
          pair_details: pairDetails,
          removal_impact_by_asset: removalImpact,
        },
        dataQuality: loaded.dataQuality,
      });
    },
    analyze_rebalance_plan: async (input) => {
      const value = object(input);
      const current = value.currentWeights as Record<string, number>;
      const target = value.targetWeights as Record<string, number>;
      const symbols = Array.from(new Set([...Object.keys(current), ...Object.keys(target)])).sort();
      const loaded = value.fromDate && value.toDate ? await dependencies.returnSeries.load({
        symbols,
        fromDate: String(value.fromDate),
        toDate: String(value.toDate),
        currencyMode: value.currencyMode as "local" | "KRW",
        adjusted: true,
      }) : undefined;
      const currentRisk = loaded
        ? analyzeReturnSeries(weightedReturns(loaded.returns, normalizedWeights(symbols, current), "__current__", "현재 비중"), { minimumObservations: 2 })
        : undefined;
      const targetRisk = loaded
        ? analyzeReturnSeries(weightedReturns(loaded.returns, normalizedWeights(symbols, target), "__target__", "목표 비중"), { minimumObservations: 2 })
        : undefined;
      const portfolioValue = value.portfolioValue === undefined ? undefined : Number(value.portfolioValue);
      const changes = symbols.map((symbol) => {
        const change = (target[symbol] ?? 0) - (current[symbol] ?? 0);
        return {
          symbol,
          current: current[symbol] ?? 0,
          target: target[symbol] ?? 0,
          change,
          action: change > 0 ? "buy" : change < 0 ? "sell" : "hold",
          ...(portfolioValue !== undefined ? { notional_change: change * portfolioValue } : {}),
        };
      });
      const turnover = 0.5 * changes.reduce((sum, item) => sum + Math.abs(item.change), 0);
      const costRate = turnover * Number(value.transactionCostBps) / 10_000;
      const difference = (after: number | null | undefined, before: number | null | undefined) => after == null || before == null ? null : after - before;
      return envelope({
        request: value,
        dataRevision: loaded?.dataRevision ?? "not-applicable",
        requestedPeriod: loaded?.requestedPeriod,
        effectivePeriod: loaded?.effectivePeriod,
        assumptions: [
          ...(loaded ? ["수정주가 수익률의 실제 공통 관측일로 리밸런싱 전후 위험을 비교합니다."] : []),
          "주문 수량이나 주문 요청을 생성하지 않습니다.",
        ],
        warnings: [
          ...(loaded?.warnings ?? []),
          ...(!loaded ? ["기간을 지정하지 않아 리밸런싱 전후 위험 차이는 계산하지 않았습니다."] : []),
        ],
        result: {
          changes,
          turnover,
          estimated_cost_rate: costRate,
          estimated_cost: portfolioValue === undefined ? null : costRate * portfolioValue,
          risk_before: currentRisk ? riskSnapshot(currentRisk) : null,
          risk_after: targetRisk ? riskSnapshot(targetRisk) : null,
          risk_change: {
            cagr: difference(targetRisk?.cagr, currentRisk?.cagr),
            annualized_volatility: difference(targetRisk?.annualizedVolatility, currentRisk?.annualizedVolatility),
            max_drawdown: difference(targetRisk?.maxDrawdown, currentRisk?.maxDrawdown),
            cvar_95: difference(targetRisk?.conditionalValueAtRisk95, currentRisk?.conditionalValueAtRisk95),
            sharpe_ratio: difference(targetRisk?.sharpeRatio, currentRisk?.sharpeRatio),
          },
          order_generated: false,
        },
        dataQuality: loaded?.dataQuality ?? { risk_comparison: "not_requested" },
      });
    },
    analyze_weight_sensitivity: (input, ownerSubject) => enqueueSensitivity(dependencies, "weight_sensitivity", object(input), ownerSubject),
    analyze_start_date_sensitivity: (input, ownerSubject) => enqueueSensitivity(dependencies, "start_date_sensitivity", object(input), ownerSubject),
    analyze_rebalance_sensitivity: (input, ownerSubject) => enqueueSensitivity(dependencies, "rebalance_sensitivity", object(input), ownerSubject),
    analyze_cash_flow_sensitivity: (input, ownerSubject) => enqueueSensitivity(dependencies, "cash_flow_sensitivity", object(input), ownerSubject),
    simulate_portfolio_monte_carlo: async (input, ownerSubject) => {
      if (dependencies.runs.executionMode === "inline") {
        throw new ServiceError({
          code: "RUST_COMPUTE_REQUIRED",
          message: "Monte Carlo는 rust_socket 또는 external Rust worker 실행 모드가 필요합니다.",
          retryable: false,
        });
      }
      const value = object(input);
      const loaded = await dependencies.returnSeries.load({
        symbols: value.symbols as string[],
        fromDate: String(value.fromDate),
        toDate: String(value.toDate),
        currencyMode: value.currencyMode as "local" | "KRW",
        adjusted: true,
      });
      const payload = {
        monte_carlo: {
          ...value,
          priceSeries: loaded.prices,
        },
        market_warnings: loaded.warnings,
      };
      const dispatched = dependencies.runs.executionMode === "external"
        ? await dependencies.runs.enqueueExternal({
          ownerSubject,
          kind: "monte_carlo",
          config: value,
          dataRevision: loaded.dataRevision,
          totalCandidates: Number(value.pathCount),
          payload,
        })
        : await dependencies.runs.enqueue({
          ownerSubject,
          kind: "monte_carlo",
          config: value,
          dataRevision: loaded.dataRevision,
          totalCandidates: Number(value.pathCount),
          task: async (context) => {
            await context.throwIfCancelled();
            const output = await requireRust(dependencies).compute("monte_carlo", payload, { signal: context.signal });
            await context.updateProgress(1, { completedCandidates: Number(value.pathCount), totalCandidates: Number(value.pathCount) });
            return rustTaskResult(output);
          },
        });
      return runResultEnvelope(dispatched.run, value);
    },
    analyze_portfolio_outlook: async (input, ownerSubject) => {
      if (dependencies.runs.executionMode === "inline") {
        throw new ServiceError({
          code: "RUST_COMPOSITE_OUTLOOK_REQUIRED",
          message: "통합 outlook은 rust_socket 또는 external Rust worker 실행 모드가 필요합니다.",
          retryable: false,
        });
      }
      const value = object(input);
      const base = value.baseConfig as BacktestRunRequest;
      const optimizationSettings = value.optimization as GenericInput;
      const assetSymbols = base.assets.map((asset) => asset.symbol);
      const requestedBenchmark = typeof optimizationSettings.benchmark === "string"
        ? optimizationSettings.benchmark.trim().toUpperCase()
        : undefined;
      const symbols = [
        ...assetSymbols,
        ...(requestedBenchmark ? [requestedBenchmark] : []),
      ];
      const loaded = await dependencies.returnSeries.load({
        symbols,
        fromDate: base.startDate,
        toDate: base.endDate,
        currencyMode: base.currencyMode ?? "KRW",
        adjusted: true,
      });
      const preparedBase = await dependencies.backtestEngine.prepare(base);
      if (!requestedBenchmark && preparedBase.simulation.benchmark) {
        const source = preparedBase.simulation.benchmark;
        const benchmarkPriceSeries: PriceSeriesInput = {
          key: preparedBase.responseContext.benchmark?.symbol ?? source.key,
          label: source.name,
          points: source.prices.map((point) => ({ date: point.date, value: point.close })),
        };
        loaded.prices.push(benchmarkPriceSeries);
        loaded.returns.push(convertPricesToReturns(benchmarkPriceSeries));
        loaded.dataRevision = requestHash({
          assets: loaded.dataRevision,
          benchmark: benchmarkPriceSeries,
        });
      }
      const benchmarkKey = requestedBenchmark
        ?? preparedBase.responseContext.benchmark?.symbol;
      const walkForwardSettings = value.walkForward as GenericInput;
      const monteCarloSettings = value.monteCarlo as GenericInput;
      const sensitivitySettings = value.sensitivity as GenericInput;
      const marketRegimeSettings = value.marketRegime as GenericInput;
      const confidenceWeights = value.confidenceWeights as { oos: number; monteCarloCalibration: number; dataQuality: number };
      const optimizationBudget = Math.min(Number(optimizationSettings.candidateBudget), dependencies.maxCandidateBudget);
      if (optimizationBudget < Number(optimizationSettings.candidateBudget)) {
        loaded.warnings.push(`최적화 후보 예산을 안전 상한 ${optimizationBudget}개로 조정했습니다.`);
      }
      const currentWeights = Object.fromEntries(base.assets.map((asset) => [asset.symbol, asset.weight / 100]));
      const optimizationValue: GenericInput = {
        symbols: assetSymbols,
        fromDate: base.startDate,
        toDate: base.endDate,
        currencyMode: base.currencyMode ?? "KRW",
        objective: optimizationSettings.objective,
        ...(benchmarkKey ? { benchmark: benchmarkKey } : {}),
        algorithm: optimizationSettings.algorithm,
        covarianceEstimator: optimizationSettings.covarianceEstimator,
        candidateBudget: optimizationBudget,
        minWeight: optimizationSettings.minWeight,
        maxWeight: optimizationSettings.maxWeight,
        minWeights: {}, maxWeights: {}, maxAssets: assetSymbols.length,
        requiredAssets: [], excludedAssets: [], currentWeights,
        transactionCostBps: base.transactionCostBps ?? 0,
        riskFreeRatePercent: base.riskFreeRatePercent ?? 0,
        seed: (walkForwardSettings.seeds as number[])[0],
        baselines: optimizationSettings.baselines,
        assetGroups: optimizationSettings.assetGroups,
        groupConstraints: optimizationSettings.groupConstraints,
        robustScoreWeights: optimizationSettings.robustScoreWeights,
        robustValidation: optimizationSettings.robustValidation,
        ledgerValidation: { budget: optimizationSettings.ledgerValidationBudget },
        regimePolicySearch: optimizationSettings.regimePolicySearch,
      };
      const optimizationPayload = {
        optimization: {
          ...optimizationInput(optimizationValue, loaded),
          ledgerTemplate: preparedBase.simulation,
          ledgerValidationBudget: optimizationSettings.ledgerValidationBudget,
        },
        objective: optimizationSettings.objective,
        market_warnings: [...loaded.warnings, ...preparedBase.responseContext.warnings],
      };
      const observations = Math.max(0, (loaded.prices[0]?.points.length ?? 1) - 1);
      const firstTestStart = Number(walkForwardSettings.trainWindow) + Number(walkForwardSettings.gap);
      const foldAdvance = Math.max(Number(walkForwardSettings.step), Number(walkForwardSettings.testWindow) + Number(walkForwardSettings.embargo));
      const estimatedFolds = Math.max(1, observations >= firstTestStart + Number(walkForwardSettings.testWindow)
        ? 1 + Math.floor((observations - firstTestStart - Number(walkForwardSettings.testWindow)) / Math.max(1, foldAdvance))
        : 0);
      const seedCount = (walkForwardSettings.seeds as number[]).length;
      const maximumFoldBudget = Math.floor(dependencies.maxCandidateBudget / estimatedFolds);
      if (maximumFoldBudget < seedCount) {
        throw new ServiceError({ code: "CANDIDATE_BUDGET_LIMIT", message: "Outlook Walk-forward fold와 seed 수가 전체 후보 예산 상한을 초과합니다.", retryable: false });
      }
      const foldCandidateBudget = Math.min(Number(walkForwardSettings.foldCandidateBudget), maximumFoldBudget);
      if (foldCandidateBudget < Number(walkForwardSettings.foldCandidateBudget)) {
        loaded.warnings.push(`Outlook fold별 후보 예산을 안전 상한에 맞춰 ${foldCandidateBudget}개로 조정했습니다.`);
      }
      const walkForwardPayload = {
        optimization: {
          ...optimizationInput({
            ...optimizationValue,
            candidateBudget: foldCandidateBudget * estimatedFolds,
          }, loaded),
        },
        objective: optimizationSettings.objective,
        walkForwardConfig: {
          trainWindow: walkForwardSettings.trainWindow,
          testWindow: walkForwardSettings.testWindow,
          step: walkForwardSettings.step,
          mode: walkForwardSettings.mode,
          gap: walkForwardSettings.gap,
          embargo: walkForwardSettings.embargo,
          minimumTrainObservations: Math.min(Number(walkForwardSettings.trainWindow), 20),
          minimumTestObservations: Math.min(Number(walkForwardSettings.testWindow), 5),
          seeds: walkForwardSettings.seeds,
          foldCandidateBudget,
          ledgerTemplate: preparedBase.simulation,
        },
        market_warnings: loaded.warnings,
      };
      const investedWeight = base.assets.reduce((sum, asset) => sum + asset.weight, 0);
      const monteCarloPayload = {
        monte_carlo: {
          ...monteCarloSettings,
          priceSeries: loaded.prices.slice(0, assetSymbols.length),
          weights: Object.fromEntries(base.assets.map((asset) => [asset.symbol, asset.weight / investedWeight])),
          initialAmount: base.initialAmount,
          periodicCashFlow: monteCarloSettings.periodicCashFlow ?? base.monthlyCashFlow,
          cashFlowFrequencyDays: monteCarloSettings.cashFlowFrequencyDays
            ?? (base.cashFlowFrequency === "annually" ? 252 : base.cashFlowFrequency === "quarterly" ? 63 : 21),
          transactionCostBps: monteCarloSettings.transactionCostBps ?? base.transactionCostBps ?? 0,
          cashWeight: monteCarloSettings.cashWeight ?? (base.execution?.cashTargetPercent ?? 0) / 100,
          cashAnnualYieldPercent: monteCarloSettings.cashAnnualYieldPercent ?? base.execution?.cashAnnualYieldPercent ?? 0,
          quantityMode: monteCarloSettings.quantityMode ?? base.execution?.quantityMode ?? "fractional",
          lotSizes: {
            ...Object.fromEntries(base.assets.map((asset) => [asset.symbol, asset.lotSize ?? 1])),
            ...(monteCarloSettings.lotSizes as Record<string, number>),
          },
        },
        market_warnings: loaded.warnings,
      };
      const stressInputs = (value.stressScenarios as GenericInput[]).map((scenario) => stressRequest(base, scenario));
      const preparedStress = [];
      for (let index = 0; index < stressInputs.length; index += 1) {
        const prepared = await dependencies.backtestEngine.prepare(stressInputs[index]);
        preparedStress.push({
          id: `outlook-stress-${index + 1}`,
          name: String((value.stressScenarios as GenericInput[])[index]?.name ?? `시나리오 ${index + 1}`),
          config: stressInputs[index],
          simulation: prepared.simulation,
        });
      }
      if (sensitivitySettings.enabled !== false) {
        const sensitivityDefinitions: Array<{
          name: string;
          dimension: string;
          request: BacktestRunRequest;
        }> = [{ name: "민감도 기준", dimension: "baseline", request: base }];
        const transactionCostShockBps = Number(sensitivitySettings.transactionCostShockBps);
        if (transactionCostShockBps > 0) {
          sensitivityDefinitions.push({
            name: `거래비용 +${transactionCostShockBps}bp`,
            dimension: "transaction_cost",
            request: { ...base, transactionCostBps: Math.min(500, (base.transactionCostBps ?? 0) + transactionCostShockBps) },
          });
        }
        if (sensitivitySettings.includeZeroCashFlow !== false && base.monthlyCashFlow !== 0) {
          sensitivityDefinitions.push({
            name: "정기 현금흐름 없음",
            dimension: "cash_flow",
            request: { ...base, monthlyCashFlow: 0 },
          });
        }
        for (const mode of Array.from(new Set(sensitivitySettings.rebalanceModes as BacktestRunRequest["rebalanceFrequency"][]))) {
          if (mode === base.rebalanceFrequency) continue;
          sensitivityDefinitions.push({
            name: `리밸런싱 ${mode}`,
            dimension: "rebalance",
            request: { ...base, rebalanceFrequency: mode, rebalanceThresholdPercent: undefined },
          });
        }
        for (let index = 0; index < sensitivityDefinitions.length; index += 1) {
          const definition = sensitivityDefinitions[index];
          const prepared = await dependencies.backtestEngine.prepare(definition.request);
          preparedStress.push({
            id: `outlook-sensitivity-${index + 1}`,
            name: definition.name,
            config: {
              ...definition.request,
              outlookScenarioKind: "sensitivity",
              sensitivityDimension: definition.dimension,
            },
            simulation: prepared.simulation,
          });
        }
        loaded.warnings.push(`Outlook 민감도 ${sensitivityDefinitions.length}개를 동일한 실제 ledger로 검증했습니다.`);
      }
      const stressPayload = { scenarios: preparedStress, market_warnings: loaded.warnings };
      const totalWork = (optimizationSettings.enabled === false ? 0 : optimizationBudget)
        + Number(monteCarloSettings.pathCount)
        + foldCandidateBudget * estimatedFolds
        + preparedStress.length;
      const outlookPayload = {
        optimization: optimizationSettings.enabled === false ? { enabled: false } : optimizationPayload,
        walk_forward: walkForwardPayload,
        monte_carlo: monteCarloPayload,
        stress: stressPayload,
        market_regime: marketRegimeSettings,
        confidence_weights: confidenceWeights,
        market_warnings: [...loaded.warnings, ...preparedBase.responseContext.warnings],
      };
      const queued = dependencies.runs.executionMode === "external"
        ? await dependencies.runs.enqueueExternal({
          ownerSubject,
          kind: "outlook",
          config: value,
          dataRevision: loaded.dataRevision,
          totalCandidates: totalWork,
          payload: outlookPayload,
        })
        : await dependencies.runs.enqueue({
          ownerSubject,
          kind: "outlook",
          config: value,
          dataRevision: loaded.dataRevision,
          totalCandidates: totalWork,
          task: async (context) => {
            await context.throwIfCancelled();
            const output = await requireRust(dependencies).compute("outlook", outlookPayload, { signal: context.signal });
            await context.throwIfCancelled();
            await context.updateProgress(1, { completedCandidates: totalWork, totalCandidates: totalWork });
            return rustTaskResult(output);
          },
        });
      return runResultEnvelope(queued.run, value);
    },
    explain_data_quality: (input) => dependencies.analytics.dataQuality(object(input) as never),
    get_run_status: async (input, ownerSubject) => {
      const value = object(input);
      const run = await dependencies.runs.get(String(value.runId), ownerSubject);
      if (!run) throw new ServiceError({ code: "RUN_NOT_FOUND", message: "run을 찾을 수 없습니다.", retryable: false });
      return runResultEnvelope(run, value, [], false);
    },
    cancel_run: async (input, ownerSubject) => {
      const value = object(input);
      const cancelled = await dependencies.runs.cancel(String(value.runId), ownerSubject);
      const run = await dependencies.runs.get(String(value.runId), ownerSubject);
      if (!run) throw new ServiceError({ code: "RUN_NOT_FOUND", message: "run을 찾을 수 없습니다.", retryable: false });
      const result = runResultEnvelope(run, value, [], false) as { result: GenericInput };
      result.result.cancel_requested = cancelled;
      return result;
    },
    get_run_result: async (input, ownerSubject) => {
      const value = object(input);
      const run = await dependencies.runs.get(String(value.runId), ownerSubject);
      if (!run) throw new ServiceError({ code: "RUN_NOT_FOUND", message: "run을 찾을 수 없습니다.", retryable: false });
      const artifactIndex = await dependencies.artifacts.list(run.id);
      const shouldExternalize = dependencies.artifacts.shouldExternalize(run.result);
      const response = runResultEnvelope(run, value, artifactIndex, !shouldExternalize) as { result: GenericInput; warnings: string[] };
      if (shouldExternalize) {
        response.result.result_externalized = true;
        response.warnings.push("대용량 실행 결과는 artifact index의 resource URI로 조회해야 합니다.");
      }
      return response;
    },
    list_runs: async (input, ownerSubject) => {
      const value = object(input);
      const listed = await dependencies.runRepository.list({
        ownerSubject,
        ...(value.query ? { search: String(value.query) } : {}),
        kinds: value.kinds as PortfolioRunKind[],
        statuses: value.statuses as never,
        tags: value.tags as string[],
        archived: runListArchived(value.archived),
        ...(value.cursor ? { cursor: String(value.cursor) } : {}),
        limit: Number(value.limit),
      });
      return envelope({
        request: value,
        dataRevision: "multiple-runs",
        result: { items: listed.items, runs: listed.items, next_cursor: listed.nextCursor, nextCursor: listed.nextCursor },
        dataQuality: { returned: listed.items.length, persistent: true },
      });
    },
    get_run_events: async (input, ownerSubject) => {
      const value = object(input);
      const runId = String(value.runId);
      const run = await dependencies.runRepository.get(runId, ownerSubject);
      if (!run) throw serviceNotFound("run", runId);
      const limit = Number(value.limit);
      const cursor = eventCursor(value.cursor);
      const events = await dependencies.runRepository.getEvents(runId, ownerSubject, {
        ...cursor,
        limit,
      });
      const nextCursor = events.length === limit && events.length
        ? Buffer.from(JSON.stringify({
            after: events.at(-1)!.createdAt,
            id: events.at(-1)!.id,
          }), "utf8").toString("base64url")
        : undefined;
      return envelope({
        request: value,
        dataRevision: run.dataRevision,
        result: { run_id: run.id, events, next_cursor: nextCursor, nextCursor },
        dataQuality: { event_count: events.length, persistent: true },
      });
    },
    export_run_manifest: async (input, ownerSubject) => {
      const value = object(input);
      const runId = String(value.runId);
      const run = await dependencies.runRepository.get(runId, ownerSubject);
      if (!run) throw serviceNotFound("run", runId);
      const artifacts = await dependencies.artifacts.list(run.id);
      const existing = await dependencies.runRepository.getManifest(runId, ownerSubject);
      const capture = existing ?? await dependencies.runRepository.storeManifest(
        runId,
        ownerSubject,
        runManifest(run, artifacts),
      );
      const manifest = recordValue(capture)?.finalized === true
        ? capture
        : await dependencies.runRepository.finalizeManifest(
          runId,
          ownerSubject,
          finalizedRunManifest(capture, run, artifacts),
        );
      return envelope({
        request: value,
        dataRevision: run.dataRevision,
        result: { run_id: run.id, manifest, immutable: true },
        dataQuality: { manifest: "stored", immutable: true },
      });
    },
    update_run: async (input, ownerSubject) => {
      const value = object(input);
      const runId = String(value.runId);
      if (!await dependencies.runRepository.get(runId, ownerSubject)) throw serviceNotFound("run", runId);
      if (value.name !== undefined) await dependencies.runRepository.rename(runId, ownerSubject, String(value.name));
      if (value.tags !== undefined) await dependencies.runRepository.setTags(runId, ownerSubject, value.tags as string[]);
      if (value.archived !== undefined) {
        if (value.archived) await dependencies.runRepository.archive(runId, ownerSubject);
        else await dependencies.runRepository.unarchive(runId, ownerSubject);
      }
      const run = await dependencies.runRepository.get(runId, ownerSubject);
      if (!run) throw serviceNotFound("run", runId);
      return envelope({ request: value, dataRevision: run.dataRevision, result: { run }, dataQuality: { persistent: true } });
    },
    duplicate_run: async (input, ownerSubject) => {
      const value = object(input);
      const runId = String(value.runId);
      const source = await dependencies.runRepository.get(runId, ownerSubject);
      if (!source) throw serviceNotFound("run", runId);
      if (["queued", "running", "cancel_requested"].includes(source.status)) {
        throw new ServiceError({ code: "RUN_NOT_TERMINAL", message: "진행 중인 run은 완료·실패·취소 후 복제할 수 있습니다.", retryable: false });
      }
      const clone = await dependencies.runRepository.create({
        kind: source.kind,
        ownerSubject,
        requestHash: requestHash({ duplicate_of: source.id, nonce: randomUUID() }),
        dataRevision: source.dataRevision,
        engineVersion: source.engineVersion,
        config: source.input,
        totalCandidates: source.totalCandidates,
        name: (value.name ? String(value.name) : `${source.name ?? source.kind} 복사본`).slice(0, 200),
        tags: source.tags,
        replayOf: source.id,
        manifest: {
          ...(recordValue(source.manifest) ?? runManifest(source, [])),
          finalized: false,
          duplicated_from: source.id,
        },
      });
      if (!await dependencies.runRepository.markRunning(clone.id)) {
        throw new ServiceError({ code: "RUN_DUPLICATE_FAILED", message: "run 복제 레코드를 준비하지 못했습니다.", retryable: true });
      }
      let optimizationCandidatesCopied = 0;
      if (source.status === "completed") {
        const descriptors = await dependencies.artifacts.list(source.id);
        for (const descriptor of descriptors) {
          const artifact = await dependencies.artifacts.get(source.id, descriptor.type);
          if (artifact) await dependencies.artifacts.put({
            runId: clone.id,
            type: descriptor.type,
            content: artifact.content,
            rowCount: descriptor.rowCount,
            dataRevision: source.dataRevision,
          });
        }
        if (source.kind === "optimization") {
          const settings = recordValue(source.input) ?? {};
          const candidateCount = await dependencies.optimizationRepository.candidateCount(source.id);
          const candidates = await dependencies.optimizationRepository.listCandidates(source.id, Math.max(1, candidateCount));
          await dependencies.optimizationRepository.createRun({
            runId: clone.id,
            objective: String(settings.objective ?? "robust_score"),
            seed: String(settings.seed ?? "unknown"),
            candidateBudget: Number(settings.candidateBudget ?? candidates.length),
            objectiveVersion: source.engineVersion,
            settings,
          });
          await dependencies.optimizationRepository.putCandidates(candidates.map((candidate) => ({
            runId: clone.id,
            rank: candidate.rank,
            weights: candidate.weights,
            metrics: candidate.metrics,
            score: candidate.score,
            pareto: candidate.pareto,
          })));
          optimizationCandidatesCopied = candidates.length;
        }
        await dependencies.runRepository.complete(clone.id, source.summary, source.result, source.warnings);
      } else if (source.status === "cancelled") {
        await dependencies.runRepository.cancel(clone.id, source.summary, source.warnings);
      } else {
        await dependencies.runRepository.fail(clone.id, source.error, source.warnings);
      }
      await dependencies.runRepository.addEvent(clone.id, "duplicated_from", { run_id: source.id });
      const stored = await dependencies.runRepository.get(clone.id, ownerSubject);
      if (!stored) throw serviceNotFound("run", clone.id);
      return envelope({
        request: value,
        dataRevision: stored.dataRevision,
        result: { run: stored, duplicated_from: source.id },
        dataQuality: {
          artifacts_copied: source.status === "completed",
          optimization_candidates_copied: optimizationCandidatesCopied,
        },
      });
    },
    delete_run: async (input, ownerSubject) => {
      const value = object(input);
      const runId = String(value.runId);
      const run = await dependencies.runRepository.get(runId, ownerSubject);
      if (!run) throw serviceNotFound("run", runId);
      const deleted = await dependencies.runRepository.softDelete(runId, ownerSubject);
      if (!deleted) {
        throw new ServiceError({ code: "RUN_NOT_TERMINAL", message: "진행 중인 run은 취소·종료 후 삭제할 수 있습니다.", retryable: false });
      }
      return envelope({ request: value, dataRevision: run.dataRevision, result: { run_id: runId, deleted: true }, dataQuality: { soft_delete: true } });
    },
    rerun_run: async (input, ownerSubject) => {
      const value = object(input);
      const runId = String(value.runId);
      const source = await dependencies.runRepository.get(runId, ownerSubject);
      if (!source) throw serviceNotFound("run", runId);
      if (["queued", "running", "cancel_requested"].includes(source.status)) {
        throw new ServiceError({ code: "RUN_ALREADY_ACTIVE", message: "진행 중인 run은 다시 실행할 수 없습니다.", retryable: false });
      }
      const storedInput = recordValue(source.input);
      if (!storedInput) {
        throw new ServiceError({ code: "RUN_INPUT_UNAVAILABLE", message: "재실행할 저장 입력이 없습니다.", retryable: false });
      }
      const replayInput = { ...storedInput, _replayNonce: randomUUID(), _replayOf: source.id };
      const invoked = await handlers[REPLAY_TOOL_BY_KIND[source.kind]](replayInput, ownerSubject);
      const replayId = nestedRunId(invoked);
      if (!replayId || replayId === source.id) {
        throw new ServiceError({ code: "RUN_REPLAY_FAILED", message: "새 재실행 run을 만들지 못했습니다.", retryable: true });
      }
      if (source.name) await dependencies.runRepository.rename(replayId, ownerSubject, `${source.name} 재실행`);
      if (source.tags.length) await dependencies.runRepository.setTags(replayId, ownerSubject, source.tags);
      await dependencies.runRepository.linkReplay(replayId, ownerSubject, source.id);
      const replay = await dependencies.runRepository.get(replayId, ownerSubject);
      if (!replay) throw serviceNotFound("run", replayId);
      return envelope({
        request: value,
        dataRevision: replay.dataRevision,
        result: { run: replay, replay_of: source.id },
        dataQuality: { fresh_execution: true },
      });
    },
    list_portfolio_presets: async (input, ownerSubject) => {
      const value = object(input);
      const listed = await presetOperation(() => dependencies.presets.list({
        ownerSubject,
        ...(value.query ? { search: String(value.query) } : {}),
        tags: value.tags as string[],
        ...(value.cursor ? { cursor: String(value.cursor) } : {}),
        limit: Number(value.limit),
      }));
      return envelope({
        request: value,
        dataRevision: "preset-library",
        result: { items: listed.items, presets: listed.items, next_cursor: listed.nextCursor, nextCursor: listed.nextCursor },
        dataQuality: { returned: listed.items.length, persistent: true },
      });
    },
    get_portfolio_preset: async (input, ownerSubject) => {
      const value = object(input);
      const presetId = String(value.presetId);
      const preset = await presetOperation(() => dependencies.presets.get(presetId, ownerSubject));
      if (!preset) throw serviceNotFound("preset", presetId);
      const history = value.includeHistory
        ? await presetOperation(() => dependencies.presets.history(presetId, ownerSubject))
        : undefined;
      return envelope({ request: value, dataRevision: "preset-library", result: { preset, history }, dataQuality: { persistent: true, revision: preset.revision } });
    },
    create_portfolio_preset: async (input, ownerSubject) => {
      const value = object(input);
      const resolved = await resolvedPresetConfig(dependencies, ownerSubject, value);
      const preset = await presetOperation(() => dependencies.presets.create({
        ownerSubject,
        name: String(value.name),
        description: String(value.description ?? ""),
        config: resolved.config,
        tags: value.tags as string[],
        source: resolved.source,
      }));
      return envelope({ request: value, dataRevision: "preset-library", result: { preset }, dataQuality: { persistent: true, revision: preset.revision } });
    },
    update_portfolio_preset: async (input, ownerSubject) => {
      const value = object(input);
      const presetId = String(value.presetId);
      const current = await presetOperation(() => dependencies.presets.get(presetId, ownerSubject));
      if (!current) throw serviceNotFound("preset", presetId);
      const needsConfig = value.config !== undefined || value.symbols !== undefined || value.source !== undefined;
      const resolved = needsConfig
        ? await resolvedPresetConfig(dependencies, ownerSubject, value, current.config)
        : undefined;
      const preset = await presetOperation(() => dependencies.presets.update({
        id: presetId,
        ownerSubject,
        expectedRevision: Number(value.revision),
        ...(value.name !== undefined ? { name: String(value.name) } : {}),
        ...(value.description !== undefined ? { description: String(value.description) } : {}),
        ...(resolved ? { config: resolved.config } : {}),
        ...(value.tags !== undefined ? { tags: value.tags as string[] } : {}),
        ...(value.source !== undefined && resolved ? { source: resolved.source } : {}),
      }));
      return envelope({ request: value, dataRevision: "preset-library", result: { preset }, dataQuality: { persistent: true, revision: preset.revision } });
    },
    duplicate_portfolio_preset: async (input, ownerSubject) => {
      const value = object(input);
      const presetId = String(value.presetId);
      const source = await dependencies.presets.get(presetId, ownerSubject);
      if (!source) throw serviceNotFound("preset", presetId);
      const preset = await presetOperation(() => dependencies.presets.duplicate({
        id: presetId,
        ownerSubject,
        name: (value.name ? String(value.name) : `${source.name} 복사본`).slice(0, 200),
      }));
      return envelope({ request: value, dataRevision: "preset-library", result: { preset, duplicated_from: presetId }, dataQuality: { persistent: true } });
    },
    delete_portfolio_preset: async (input, ownerSubject) => {
      const value = object(input);
      const presetId = String(value.presetId);
      const deleted = await presetOperation(() => dependencies.presets.delete({ id: presetId, ownerSubject }));
      if (!deleted) throw serviceNotFound("preset", presetId);
      return envelope({ request: value, dataRevision: "preset-library", result: { preset_id: presetId, deleted: true }, dataQuality: { soft_delete: true } });
    },
    import_portfolio_presets: async (input, ownerSubject) => {
      const value = object(input);
      const mode = String(value.conflictMode ?? "rename");
      const imported = importDocument(value.document);
      const matches = await presetOperation(() => dependencies.presets.list({ ownerSubject, search: imported.name, limit: 100 }));
      const existing = matches.items.find((preset) => preset.name === imported.name);
      let preset;
      if (existing && mode === "skip") {
        preset = existing;
      } else if (existing && mode === "replace") {
        preset = await presetOperation(() => dependencies.presets.update({
          id: existing.id,
          ownerSubject,
          expectedRevision: existing.revision,
          description: imported.description,
          config: imported.config,
          tags: imported.tags,
          source: { type: "import", originalSource: imported.source },
        }));
      } else {
        let renamed: string | undefined;
        if (existing) {
          const used = new Set(matches.items.map((preset) => preset.name));
          renamed = `${imported.name} 가져오기`;
          let suffix = 2;
          while (used.has(renamed)) renamed = `${imported.name} 가져오기 ${suffix++}`;
        }
        preset = await presetOperation(() => dependencies.presets.importPreset({
          ownerSubject,
          payload: value.document,
          ...(renamed ? { name: renamed } : {}),
        }));
      }
      return envelope({
        request: value,
        dataRevision: "preset-library",
        result: { preset, conflict_mode: mode, skipped: Boolean(existing && mode === "skip") },
        dataQuality: { persistent: true, revision: preset.revision },
      });
    },
    export_portfolio_preset: async (input, ownerSubject) => {
      const value = object(input);
      const presetId = String(value.presetId);
      const document = await presetOperation(() => dependencies.presets.exportPreset(presetId, ownerSubject));
      if (!document) throw serviceNotFound("preset", presetId);
      return envelope({ request: value, dataRevision: "preset-library", result: { preset_id: presetId, document }, dataQuality: { portable_schema: PRESET_EXPORT_SCHEMA_VERSION } });
    },
    generate_backtest_report: async (input, ownerSubject) => {
      const value = object(input);
      const run = await dependencies.runs.get(String(value.runId), ownerSubject);
      if (!run) throw new ServiceError({ code: "RUN_NOT_FOUND", message: "run을 찾을 수 없습니다.", retryable: false });
      if (run.kind !== "backtest") throw new ServiceError({ code: "INVALID_RUN_KIND", message: "백테스트 run이 필요합니다.", retryable: false });
      const report = await dependencies.backtests.generateReport({ ownerSubject, run, reportConfig: { failureMode: value.failureMode } });
      return envelope({ request: value, dataRevision: run.dataRevision, result: { report }, dataQuality: {} });
    },
    generate_research_report: async (input, ownerSubject) => {
      const value = object(input);
      const runId = String(value.runId);
      const run = await dependencies.runs.get(runId, ownerSubject);
      if (!run) throw serviceNotFound("run", runId);
      if (run.status !== "completed") {
        throw new ServiceError({ code: "RUN_NOT_COMPLETE", message: "연구 보고서는 완료된 run에서 생성할 수 있습니다.", retryable: false });
      }
      const format = value.format as "json" | "markdown";
      const buildReport = async (throwIfCancelled?: () => Promise<void>) => {
        const descriptors = (await dependencies.artifacts.list(runId)).filter((item) => item.type !== "research-report");
        const sourceArtifacts = [];
        for (const descriptor of descriptors) {
          await throwIfCancelled?.();
          const stored = await dependencies.artifacts.get(runId, descriptor.type);
          if (stored) sourceArtifacts.push(stored);
        }
        await throwIfCancelled?.();
        const document = dependencies.researchReports.build({
          run,
          artifacts: sourceArtifacts,
          ...(value.title ? { title: String(value.title) } : {}),
        });
        return { document, content: dependencies.researchReports.render(document, format) };
      };
      if (value.executionMode === "async") {
        const queued = await dependencies.runs.enqueue({
          ownerSubject,
          kind: "research_report",
          config: value,
          dataRevision: run.dataRevision,
          totalCandidates: 1,
          allowInlineInExternal: true,
          task: async (context) => {
            const { document, content } = await buildReport(context.throwIfCancelled);
            await context.updateProgress(1, { completedCandidates: 1, totalCandidates: 1 });
            return {
              summary: {
                source_run_id: runId,
                format,
                data_quality: document.data_quality,
              },
              result: {
                run_id: context.runId,
                source_run_id: runId,
                format,
                report: content,
                artifact_uri: `portfolio://runs/${context.runId}/artifacts/research-report`,
              },
              warnings: document.data_quality.warnings,
              artifacts: [{
                type: "research-report",
                content: { format, document: content, metadata: document },
                rowCount: 1,
              }],
            };
          },
        });
        await dependencies.runRepository.addEvent(runId, "research_report_queued", {
          format,
          report_run_id: queued.run.id,
          reused: queued.reused,
        });
        return runResultEnvelope(queued.run, value);
      }
      const { document, content } = await buildReport();
      const artifact = await dependencies.artifacts.put({
        runId,
        type: "research-report",
        content: { format, document: content, metadata: document },
        rowCount: 1,
        dataRevision: run.dataRevision,
      });
      await dependencies.runRepository.addEvent(runId, "research_report_generated", { format, artifact_id: artifact.id });
      return envelope({
        request: value,
        dataRevision: run.dataRevision,
        result: { run_id: runId, format, report: content, artifact },
        warnings: document.data_quality.warnings,
        dataQuality: document.data_quality,
      });
    },
    get_report: async (input, ownerSubject) => {
      const value = object(input);
      const report = await dependencies.reports.get(String(value.reportId), ownerSubject);
      if (!report) throw new ServiceError({ code: "REPORT_NOT_FOUND", message: "보고서를 찾을 수 없습니다.", retryable: false });
      return envelope({ request: value, dataRevision: report.data_revision, result: { report }, dataQuality: {} });
    },
  };
  return handlers;
}

async function enqueueSensitivity(
  dependencies: McpToolDependencies,
  kind: "weight_sensitivity" | "start_date_sensitivity" | "rebalance_sensitivity" | "cash_flow_sensitivity",
  value: GenericInput,
  ownerSubject: string,
) {
  const base = value.baseConfig as BacktestRunRequest;
  const investedTargetPercent = 100 - (base.execution?.cashTargetPercent ?? 0);
  const scenarios: BacktestRunRequest[] = [];
  if (kind === "weight_sensitivity") {
    const target = String(value.targetSymbol);
    for (const targetWeight of value.targetWeights as number[]) {
      if (targetWeight * 100 > investedTargetPercent + 0.01) {
        throw new ServiceError({ code: "TARGET_WEIGHT_EXCEEDS_INVESTED_TARGET", message: "대상 비중이 현금 목표를 제외한 투자 가능 비중보다 큽니다.", retryable: false });
      }
      const current = base.assets.find((asset) => asset.symbol === target);
      if (!current) throw new ServiceError({ code: "TARGET_ASSET_NOT_FOUND", message: "민감도 대상 종목이 포트폴리오에 없습니다.", retryable: false });
      const others = base.assets.filter((asset) => asset.symbol !== target);
      const otherTotal = others.reduce((sum, asset) => sum + asset.weight, 0);
      const adjustedAssets = [
        ...(targetWeight > 0 ? [{ symbol: target, weight: targetWeight * 100, lotSize: current.lotSize }] : []),
        ...others
          .map((asset) => ({ ...asset, weight: otherTotal > 0 ? asset.weight / otherTotal * (investedTargetPercent - targetWeight * 100) : 0 }))
          .filter((asset) => asset.weight > 0),
      ];
      scenarios.push({
        ...base,
        assets: adjustedAssets,
      });
    }
  } else if (kind === "start_date_sensitivity") {
    for (const offset of value.offsetsDays as number[]) {
      const startDate = addDays(base.startDate, offset);
      if (startDate > base.endDate) {
        throw new ServiceError({ code: "INVALID_START_DATE_SCENARIO", message: "민감도 시작일이 종료일보다 늦습니다.", retryable: false });
      }
      scenarios.push({ ...base, startDate });
    }
  } else if (kind === "rebalance_sensitivity") {
    for (const mode of value.modes as BacktestRunRequest["rebalanceFrequency"][]) scenarios.push({ ...base, rebalanceFrequency: mode, ...(mode === "threshold" ? { rebalanceThresholdPercent: Number(value.thresholdPercent) } : {}) });
  } else {
    for (const amount of value.monthlyAmounts as number[]) {
      for (const frequency of value.frequencies as NonNullable<BacktestRunRequest["cashFlowFrequency"]>[]) {
        for (const timing of value.timings as NonNullable<BacktestRunRequest["cashFlowTiming"]>[]) {
          scenarios.push({
            ...base,
            monthlyCashFlow: amount,
            cashFlowFrequency: frequency,
            cashFlowTiming: timing,
          });
        }
      }
    }
  }
  const preparedScenarios: Array<{ id: string; name: string; config: BacktestRunRequest; simulation: unknown }> = [];
  const preparationWarnings: string[] = [];
  if (dependencies.runs.executionMode === "external" || dependencies.runs.executionMode === "rust_socket") {
    for (let index = 0; index < scenarios.length; index += 1) {
      const prepared = await dependencies.backtestEngine.prepare(scenarios[index]);
      preparationWarnings.push(...prepared.responseContext.warnings);
      preparedScenarios.push({
        id: `s-${String(index + 1).padStart(4, "0")}`,
        name: `${kind}-${index + 1}`,
        config: scenarios[index],
        simulation: prepared.simulation,
      });
    }
  }
  const dataRevision = await dependencies.marketData.repository.dataRevision();
  const workerPayload = { scenarios: preparedScenarios, market_warnings: Array.from(new Set(preparationWarnings)) };
  const queued = dependencies.runs.executionMode === "external"
    ? await dependencies.runs.enqueueExternal({
      ownerSubject,
      kind,
      config: value,
      dataRevision,
      totalCandidates: scenarios.length,
      payload: workerPayload,
    })
    : dependencies.runs.executionMode === "rust_socket"
      ? await dependencies.runs.enqueue({
        ownerSubject,
        kind,
        config: value,
        dataRevision,
        totalCandidates: scenarios.length,
        task: async (context) => {
          await context.throwIfCancelled();
          const output = await requireRust(dependencies).compute(kind, workerPayload, { signal: context.signal });
          await context.updateProgress(1, { completedCandidates: scenarios.length, totalCandidates: scenarios.length });
          return rustTaskResult(output);
        },
      })
    : await dependencies.runs.enqueue({
    ownerSubject,
    kind,
    config: value,
    dataRevision,
    totalCandidates: scenarios.length,
    task: async (context) => {
      const results = [];
      for (let index = 0; index < scenarios.length; index += 1) {
        await context.throwIfCancelled();
        const result = await dependencies.backtestEngine.run(scenarios[index]);
        results.push({
          config: scenarios[index],
          metrics: {
            ...result.metrics,
            cvar95Percent: result.advanced.tailRisk.expectedShortfall95Percent,
          },
          data_quality: result.dataQuality,
        });
        await context.updateProgress((index + 1) / scenarios.length, { completedCandidates: index + 1, totalCandidates: scenarios.length });
      }
      const distributions = metricDistributions(results);
      const result = { scenarios: results, distributions, limitation: HISTORICAL_LIMITATION };
      return {
        summary: { scenario_count: results.length, distributions },
        result,
        artifacts: [{ type: "result", content: result, rowCount: results.length }],
      };
    },
  });
  return runResultEnvelope(queued.run, value);
}
