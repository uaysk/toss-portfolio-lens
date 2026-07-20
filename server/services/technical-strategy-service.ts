import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { BacktestRunRequest, PortfolioBacktestService } from "../backtest.js";
import { isArtifactType, type ArtifactType } from "../repositories/artifact-repository.js";
import type { ArtifactService } from "./artifact-service.js";
import {
  backtestArtifacts,
  type BacktestRunResult,
  type BacktestService,
  type SharedBacktestRequest,
} from "./backtest-service.js";
import type { MarketDataService } from "./market-data-service.js";
import type { RunService } from "./run-service.js";
import { canonicalJson } from "../worker/contracts.js";
import type { RustComputeClient } from "../worker/rust-client.js";
import { WorkerMetricsContentSchema } from "../worker/contracts.js";
import { envelope, ServiceError } from "./service-envelope.js";
import {
  TECHNICAL_INDICATOR_ENGINE_VERSION,
  TECHNICAL_INDICATOR_OUTPUT_FIELDS,
} from "./technical-analysis-contract.js";
import {
  normalizeTechnicalAnalysisRequest,
  type PreparedTechnicalAnalysis,
  type TechnicalAnalysisRequest,
  type TechnicalAnalysisService,
} from "./technical-analysis-service.js";
import {
  MAX_TECHNICAL_CONDITION_DEPTH,
  MAX_TECHNICAL_CONDITION_NODES,
  TECHNICAL_STRATEGY_CACHE_SCHEMA_VERSION,
  TECHNICAL_STRATEGY_SCHEMA_VERSION,
  TechnicalStrategyWorkerResultSchema,
  type TechnicalStrategyWorkerResult,
} from "./technical-strategy-contract.js";

type TechnicalStrategyOperand =
  | { type: "indicator"; instrumentKey: string; indicatorId: string; field: string }
  | { type: "bar"; instrumentKey: string; field: "open" | "high" | "low" | "close" | "volume" }
  | { type: "constant"; value: number };

export type TechnicalStrategyCondition =
  | { operator: "greater_than" | "less_than" | "crosses_above" | "crosses_below"; left: TechnicalStrategyOperand; right: TechnicalStrategyOperand }
  | { operator: "between"; value: TechnicalStrategyOperand; lower: TechnicalStrategyOperand; upper: TechnicalStrategyOperand }
  | { operator: "all" | "any"; conditions: TechnicalStrategyCondition[] }
  | { operator: "not"; condition: TechnicalStrategyCondition };

export type TechnicalStrategyDefinition = {
  schemaVersion: typeof TECHNICAL_STRATEGY_SCHEMA_VERSION;
  id: string;
  entryCondition: TechnicalStrategyCondition;
  exitCondition: TechnicalStrategyCondition;
  minimumHoldingPeriod: number;
  cooldownPeriod: number;
  initialState: "active" | "inactive";
  allocations: {
    active: { weights: Record<string, number>; cashPercent: number };
    inactive: { weights: Record<string, number>; cashPercent: number };
  };
};

export type TechnicalSignalAnalysisRequest = {
  analysis: TechnicalAnalysisRequest;
  strategy: TechnicalStrategyDefinition;
};

export type TechnicalStrategyBacktestRequest = TechnicalSignalAnalysisRequest & {
  backtest: SharedBacktestRequest;
};

type WorkerOperand =
  | { type: "indicator"; instrument_key: string; indicator_id: string; field: string }
  | { type: "bar"; instrument_key: string; field: "open" | "high" | "low" | "close" | "volume" }
  | { type: "constant"; value: number };

type WorkerCondition =
  | { operator: "greater_than" | "less_than" | "crosses_above" | "crosses_below"; left: WorkerOperand; right: WorkerOperand }
  | { operator: "between"; value: WorkerOperand; lower: WorkerOperand; upper: WorkerOperand }
  | { operator: "all" | "any"; conditions: WorkerCondition[] }
  | { operator: "not"; condition: WorkerCondition };

type WorkerStrategy = {
  schema_version: typeof TECHNICAL_STRATEGY_SCHEMA_VERSION;
  initial_state: "active" | "inactive";
  active_when: WorkerCondition;
  inactive_when: WorkerCondition;
  minimum_holding_period: number;
  cooldown_period: number;
  allocations: {
    active: { weights: Record<string, number>; cash_target_percent: number };
    inactive: { weights: Record<string, number>; cash_target_percent: number };
  };
};

type StrategyPayload = {
  technical_analysis: PreparedTechnicalAnalysis["payload"]["technical_analysis"];
  strategy: WorkerStrategy;
  simulation?: Record<string, unknown>;
  response_context?: Record<string, unknown>;
  safe_trade_dates?: string[];
  evaluation_start_date?: string;
  evaluation_end_date?: string;
};

function invalid(field: string, message: string): never {
  throw new ServiceError({
    code: "INVALID_TECHNICAL_STRATEGY_REQUEST",
    message,
    retryable: false,
    field,
  });
}

function workerOperand(operand: TechnicalStrategyOperand): WorkerOperand {
  if (operand.type === "constant") return { type: "constant", value: operand.value };
  if (operand.type === "bar") {
    return { type: "bar", instrument_key: operand.instrumentKey, field: operand.field };
  }
  return {
    type: "indicator",
    instrument_key: operand.instrumentKey,
    indicator_id: operand.indicatorId,
    field: operand.field,
  };
}

function workerCondition(condition: TechnicalStrategyCondition): WorkerCondition {
  if (condition.operator === "all" || condition.operator === "any") {
    return { operator: condition.operator, conditions: condition.conditions.map(workerCondition) };
  }
  if (condition.operator === "not") return { operator: "not", condition: workerCondition(condition.condition) };
  if (condition.operator === "between") {
    return {
      operator: "between",
      value: workerOperand(condition.value),
      lower: workerOperand(condition.lower),
      upper: workerOperand(condition.upper),
    };
  }
  const comparison = condition as Extract<TechnicalStrategyCondition, { left: TechnicalStrategyOperand }>;
  return {
    operator: condition.operator,
    left: workerOperand(comparison.left),
    right: workerOperand(comparison.right),
  };
}

function normalizedWeights(value: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(value)
    .map(([symbol, weight]) => [symbol.trim().toUpperCase(), weight] as const)
    .sort(([left], [right]) => left.localeCompare(right)));
}

function workerStrategy(strategy: TechnicalStrategyDefinition): WorkerStrategy {
  return {
    schema_version: strategy.schemaVersion,
    initial_state: strategy.initialState,
    active_when: workerCondition(strategy.entryCondition),
    inactive_when: workerCondition(strategy.exitCondition),
    minimum_holding_period: strategy.minimumHoldingPeriod,
    cooldown_period: strategy.cooldownPeriod,
    allocations: {
      active: {
        weights: normalizedWeights(strategy.allocations.active.weights),
        cash_target_percent: strategy.allocations.active.cashPercent,
      },
      inactive: {
        weights: normalizedWeights(strategy.allocations.inactive.weights),
        cash_target_percent: strategy.allocations.inactive.cashPercent,
      },
    },
  };
}

function conditionNodes(condition: TechnicalStrategyCondition, depth = 1): { count: number; depth: number } {
  if (condition.operator === "not") {
    const child = conditionNodes(condition.condition, depth + 1);
    return { count: child.count + 1, depth: Math.max(depth, child.depth) };
  }
  if (condition.operator === "all" || condition.operator === "any") {
    return condition.conditions.reduce((summary, child) => {
      const nested = conditionNodes(child, depth + 1);
      return { count: summary.count + nested.count, depth: Math.max(summary.depth, nested.depth) };
    }, { count: 1, depth });
  }
  return { count: 1, depth };
}

function conditionOperands(condition: TechnicalStrategyCondition): TechnicalStrategyOperand[] {
  if (condition.operator === "not") return conditionOperands(condition.condition);
  if (condition.operator === "all" || condition.operator === "any") return condition.conditions.flatMap(conditionOperands);
  if (condition.operator === "between") return [condition.value, condition.lower, condition.upper];
  const comparison = condition as Extract<TechnicalStrategyCondition, { left: TechnicalStrategyOperand }>;
  return [comparison.left, comparison.right];
}

function conditionVolumeSymbols(request: TechnicalSignalAnalysisRequest): string[] {
  return Array.from(new Set([
    ...conditionOperands(request.strategy.entryCondition),
    ...conditionOperands(request.strategy.exitCondition),
  ].flatMap((operand) => operand.type === "bar" && operand.field === "volume"
    ? [operand.instrumentKey.trim().toUpperCase()]
    : []))).sort((left, right) => left.localeCompare(right));
}

function validateStrategyReferences(request: TechnicalSignalAnalysisRequest): void {
  const normalized = normalizeTechnicalAnalysisRequest(request.analysis).publicRequest;
  if (normalized.responseMode !== "full_series") invalid("analysis.responseMode", "기술 신호 조건 평가는 full_series 지표가 필요합니다.");
  const definitions = new Map(normalized.indicators.map((definition) => [definition.id, definition]));
  const symbols = new Set(normalized.symbols);
  const entry = conditionNodes(request.strategy.entryCondition);
  const exit = conditionNodes(request.strategy.exitCondition);
  if (Math.max(entry.depth, exit.depth) > MAX_TECHNICAL_CONDITION_DEPTH) invalid("strategy", `조건 트리 깊이는 최대 ${MAX_TECHNICAL_CONDITION_DEPTH}입니다.`);
  if (entry.count + exit.count > MAX_TECHNICAL_CONDITION_NODES) invalid("strategy", `조건 노드는 최대 ${MAX_TECHNICAL_CONDITION_NODES}개입니다.`);
  for (const operand of [
    ...conditionOperands(request.strategy.entryCondition),
    ...conditionOperands(request.strategy.exitCondition),
  ]) {
    if (operand.type === "constant") {
      if (!Number.isFinite(operand.value)) invalid("strategy", "조건 상수는 유한한 숫자여야 합니다.");
      continue;
    }
    const key = operand.instrumentKey.toUpperCase();
    if (!symbols.has(key)) invalid("strategy", `조건이 분석 종목에 없는 instrument를 참조합니다: ${key}`);
    if (operand.type !== "indicator") continue;
    const definition = definitions.get(operand.indicatorId);
    if (!definition) invalid("strategy", `조건이 정의되지 않은 지표를 참조합니다: ${operand.indicatorId}`);
    if (definition.kind === "volume_profile") invalid("strategy", "Volume Profile은 시점별 기술 신호 조건에서 참조할 수 없습니다.");
    if (definition.instrumentKeys && !definition.instrumentKeys.includes(key)) invalid("strategy", `${operand.indicatorId} 지표의 계산 대상에 ${key}가 없습니다.`);
    if (!(TECHNICAL_INDICATOR_OUTPUT_FIELDS[definition.kind] as readonly string[]).includes(operand.field)) {
      invalid("strategy", `${definition.kind} 지표에 ${operand.field} 출력 field가 없습니다.`);
    }
  }
  for (const state of ["active", "inactive"] as const) {
    const allocation = request.strategy.allocations[state];
    const weights = normalizedWeights(allocation.weights);
    if (Object.keys(weights).length !== symbols.size || Object.keys(weights).some((symbol) => !symbols.has(symbol))) {
      invalid(`strategy.allocations.${state}.weights`, "allocation은 분석 종목을 빠짐없이 정확히 포함해야 합니다.");
    }
    const total = Object.values(weights).reduce((sum, weight) => sum + weight, 0) + allocation.cashPercent;
    if (Object.values(weights).some((weight) => !Number.isFinite(weight) || weight < 0 || weight > 100)
      || !Number.isFinite(allocation.cashPercent) || allocation.cashPercent < 0 || allocation.cashPercent > 100
      || Math.abs(total - 100) > 0.01) {
      invalid(`strategy.allocations.${state}`, "종목과 현금 allocation은 각각 0~100%이고 합계가 100%여야 합니다.");
    }
  }
}

function validateBacktestLink(request: TechnicalStrategyBacktestRequest): void {
  validateStrategyReferences(request);
  if (request.backtest.targetWeightSchedule?.length) invalid("backtest.targetWeightSchedule", "기술 신호 schedule은 Rust worker만 생성할 수 있습니다.");
  if (request.backtest.rebalanceFrequency !== "none") invalid("backtest.rebalanceFrequency", "기술 신호 전략은 별도 정기 리밸런싱을 함께 사용할 수 없습니다.");
  if (request.backtest.report?.enabled) invalid("backtest.report.enabled", "기술 신호 combined run에서는 별도 보고서 생성을 지원하지 않습니다.");
  const analysis = normalizeTechnicalAnalysisRequest(request.analysis).publicRequest;
  const assets = request.backtest.assets.map((asset) => asset.symbol.trim().toUpperCase());
  const expected = new Set(analysis.symbols);
  if (new Set(assets).size !== expected.size || assets.some((symbol) => !expected.has(symbol))) {
    invalid("backtest.assets", "백테스트 종목은 기술 분석·allocation 종목과 정확히 일치해야 합니다.");
  }
  const initialAllocation = request.strategy.allocations[request.strategy.initialState];
  const initialWeights = normalizedWeights(initialAllocation.weights);
  if (request.backtest.assets.some((asset) => asset.weight !== initialWeights[asset.symbol.trim().toUpperCase()])
    || (request.backtest.execution?.cashTargetPercent ?? 0) !== initialAllocation.cashPercent) {
    invalid("backtest.assets", "백테스트 초기 종목·현금 비중은 strategy.initialState allocation과 정확히 일치해야 합니다.");
  }
  if (!analysis.adjusted) invalid("analysis.adjusted", "기술 신호 백테스트는 수정주가를 사용해야 합니다.");
  if (analysis.currencyMode !== (request.backtest.currencyMode ?? "KRW")) invalid("analysis.currencyMode", "기술 분석과 백테스트의 통화 기준이 같아야 합니다.");
  if (analysis.fromDate > request.backtest.startDate || analysis.toDate !== request.backtest.endDate) {
    invalid("analysis.fromDate", "지표 기간은 백테스트 시작일 이전부터 동일 종료일까지여야 합니다.");
  }
}

export function technicalStrategyDataRevision(value: unknown): string {
  return createHash("sha256")
    .update(canonicalJson({ schema_version: "technical-strategy-data/v1", value }))
    .digest("hex");
}

function parsedResult(
  value: unknown,
  expectedMode: "signal_only" | "backtest",
  request: TechnicalSignalAnalysisRequest | TechnicalStrategyBacktestRequest,
): TechnicalStrategyWorkerResult {
  const parsed = TechnicalStrategyWorkerResultSchema.safeParse(value);
  if (!parsed.success) {
    throw new ServiceError({
      code: "INVALID_TECHNICAL_STRATEGY_RESULT",
      message: "Rust 기술 신호 전략 결과 계약이 올바르지 않습니다.",
      retryable: false,
      details: { issues: parsed.error.issues.slice(0, 20).map((issue) => ({ path: issue.path.join("."), message: issue.message })) },
    });
  }
  const result = parsed.data;
  const mismatch = (message: string, details?: Record<string, unknown>): never => {
    throw new ServiceError({
      code: "INVALID_TECHNICAL_STRATEGY_RESULT",
      message,
      retryable: false,
      ...(details ? { details } : {}),
    });
  };
  if ((expectedMode === "backtest") !== (result.backtest !== undefined)) {
    mismatch("기술 전략 실행 mode와 Rust backtest 결과 존재 여부가 일치하지 않습니다.", {
      expected_mode: expectedMode,
      has_backtest: result.backtest !== undefined,
    });
  }
  if (result.technical_strategy.initial_state !== request.strategy.initialState) {
    mismatch("Rust 기술 전략 initial state가 요청과 일치하지 않습니다.");
  }
  for (const signal of result.technical_strategy.signals) {
    const expected = request.strategy.allocations[signal.to_state];
    if (!isDeepStrictEqual(signal.target_weights, normalizedWeights(expected.weights))
      || signal.cash_target_percent !== expected.cashPercent) {
      mismatch("Rust 기술 신호 allocation이 요청 strategy allocation과 일치하지 않습니다.", { signal_id: signal.signal_id });
    }
  }
  if (expectedMode === "backtest") {
    const backtestRequest = (request as TechnicalStrategyBacktestRequest).backtest;
    const backtest = result.backtest!;
    const config = backtest.config;
    const expectedAssets = backtestRequest.assets
      .map((asset) => ({ symbol: asset.symbol.trim().toUpperCase(), weight: asset.weight }))
      .sort((left, right) => left.symbol.localeCompare(right.symbol));
    const configAssets = config.assets
      .map((asset) => ({ symbol: asset.symbol.trim().toUpperCase(), weight: asset.weight }))
      .sort((left, right) => left.symbol.localeCompare(right.symbol));
    const resultAssets = backtest.assets
      .map((asset) => ({ symbol: asset.symbol.trim().toUpperCase(), weight: asset.weight }))
      .sort((left, right) => left.symbol.localeCompare(right.symbol));
    if (!isDeepStrictEqual(configAssets, expectedAssets) || !isDeepStrictEqual(resultAssets, expectedAssets)
      || config.startDate !== backtestRequest.startDate || config.endDate !== backtestRequest.endDate
      || config.requestedStartDate !== backtestRequest.startDate || backtest.requestedStartDate !== backtestRequest.startDate
      || config.initialAmount !== backtestRequest.initialAmount || config.monthlyCashFlow !== backtestRequest.monthlyCashFlow
      || config.rebalanceFrequency !== backtestRequest.rebalanceFrequency
      || config.currencyMode !== (backtestRequest.currencyMode ?? "KRW")
      || config.benchmark !== backtestRequest.benchmark
      || config.execution.cashTargetPercent !== (backtestRequest.execution?.cashTargetPercent ?? 0)) {
      mismatch("finalized backtest config·asset provenance가 요청과 일치하지 않습니다.");
    }
  }
  return result;
}

function expectedArtifacts(result: TechnicalStrategyWorkerResult): Array<{ type: ArtifactType; content: unknown; rowCount?: number }> {
  const expected: Array<{ type: ArtifactType; content: unknown; rowCount?: number }> = [
    { type: "technical-indicators", content: result.technical_analysis.calculations, rowCount: result.technical_analysis.calculations.length },
    { type: "technical-signals", content: result.technical_strategy.signals, rowCount: result.technical_strategy.signals.length },
    {
      type: "technical-diagnostics",
      content: {
        indicator: result.technical_analysis.diagnostics,
        strategy: result.technical_strategy.diagnostics,
      },
      rowCount: 1,
    },
  ];
  if (result.backtest) expected.push(...backtestArtifacts(result.backtest as unknown as BacktestRunResult));
  return expected;
}

function validatedArtifacts(
  output: Awaited<ReturnType<RustComputeClient["compute"]>>,
  result: TechnicalStrategyWorkerResult,
): Array<{ type: ArtifactType; content: unknown; rowCount?: number }> {
  const expected = expectedArtifacts(result);
  const byType = new Map<string, typeof output.artifacts>();
  for (const artifact of output.artifacts) {
    const items = byType.get(artifact.type) ?? [];
    items.push(artifact);
    byType.set(artifact.type, items);
  }
  for (const artifact of expected) {
    const actual = byType.get(artifact.type);
    if (actual?.length !== 1 || actual[0]!.row_count !== artifact.rowCount
      || !isDeepStrictEqual(actual[0]!.content, artifact.content)) {
      throw new ServiceError({
        code: "INVALID_TECHNICAL_STRATEGY_ARTIFACT",
        message: `${artifact.type} artifact가 canonical Rust 결과와 일치하지 않습니다.`,
        retryable: false,
      });
    }
  }
  const metrics = byType.get("worker-metrics");
  if (metrics?.length !== 1 || metrics[0]!.row_count !== 1
    || !WorkerMetricsContentSchema.safeParse(metrics[0]!.content).success) {
    throw new ServiceError({
      code: "INVALID_TECHNICAL_STRATEGY_ARTIFACT",
      message: "Rust 기술 신호 전략 worker-metrics artifact 계약이 올바르지 않습니다.",
      retryable: false,
    });
  }
  if (byType.size !== expected.length + 1 || output.artifacts.length !== expected.length + 1) {
    throw new ServiceError({
      code: "INVALID_TECHNICAL_STRATEGY_ARTIFACT",
      message: "Rust 기술 신호 전략 artifact type 집합이 계약과 일치하지 않습니다.",
      retryable: false,
    });
  }
  return output.artifacts.map((artifact) => {
    if (!isArtifactType(artifact.type)) {
      throw new ServiceError({ code: "INVALID_TECHNICAL_STRATEGY_ARTIFACT", message: `등록되지 않은 artifact type입니다: ${artifact.type}`, retryable: false });
    }
    return { type: artifact.type, content: artifact.content, rowCount: artifact.row_count };
  });
}

export class TechnicalStrategyService {
  constructor(
    private readonly technicalAnalysis: TechnicalAnalysisService,
    private readonly backtestEngine: PortfolioBacktestService,
    private readonly backtests: BacktestService,
    private readonly marketData: MarketDataService,
    private readonly runs: RunService,
    private readonly artifacts: ArtifactService,
    private readonly rustCompute?: RustComputeClient,
  ) {}

  async validate(input: { ownerSubject: string; request: TechnicalStrategyBacktestRequest }): Promise<ReturnType<typeof envelope>> {
    validateBacktestLink(input.request);
    const [availability, backtestValidation] = await Promise.all([
      this.marketData.getDataAvailability(input.request.analysis.symbols, input.request.analysis.adjusted),
      this.backtests.validate(input.request.backtest),
    ]);
    const backtestResult = backtestValidation.result as { valid?: boolean; errors?: unknown[] };
    const errors = Array.isArray(backtestResult.errors) ? backtestResult.errors : [];
    const periodOverlaps = Boolean(availability.commonPeriod
      && input.request.analysis.toDate >= availability.commonPeriod.from
      && input.request.analysis.fromDate <= availability.commonPeriod.to);
    if (!periodOverlaps) errors.push({ field: "analysis.fromDate", message: "지표 요청 기간과 공통 데이터 기간이 겹치지 않습니다." });
    return envelope({
      request: input.request,
      dataRevision: availability.dataRevision,
      requestedPeriod: { from: input.request.analysis.fromDate, to: input.request.analysis.toDate },
      ...(availability.commonPeriod ? { effectivePeriod: availability.commonPeriod } : {}),
      assumptions: ["검증은 Rust 지표 계산이나 ledger 시뮬레이션을 실행하지 않습니다."],
      warnings: backtestValidation.warnings,
      dataQuality: {
        technical_assets: availability.assets,
        common_observations: availability.commonObservations,
        condition_node_limit: MAX_TECHNICAL_CONDITION_NODES,
        condition_depth_limit: MAX_TECHNICAL_CONDITION_DEPTH,
      },
      result: { valid: backtestResult.valid === true && errors.length === 0, errors, availability },
    });
  }

  analyzeSignals(input: {
    ownerSubject: string;
    request: TechnicalSignalAnalysisRequest;
    cacheNonce?: string;
  }): Promise<ReturnType<typeof envelope>> {
    validateStrategyReferences(input.request);
    return this.execute({ ...input, mode: "signal_only" });
  }

  runBacktest(input: {
    ownerSubject: string;
    request: TechnicalStrategyBacktestRequest;
    cacheNonce?: string;
  }): Promise<ReturnType<typeof envelope>> {
    validateBacktestLink(input.request);
    return this.execute({ ...input, mode: "backtest" });
  }

  private async execute(input: {
    ownerSubject: string;
    request: TechnicalSignalAnalysisRequest | TechnicalStrategyBacktestRequest;
    mode: "signal_only" | "backtest";
    cacheNonce?: string;
  }): Promise<ReturnType<typeof envelope>> {
    if (this.runs.executionMode === "inline") {
      throw new ServiceError({ code: "RUST_COMPUTE_REQUIRED", message: "기술 신호 전략은 Rust compute 실행 모드에서만 사용할 수 있습니다.", retryable: false });
    }
    if (this.runs.executionMode === "rust_socket" && !this.rustCompute) {
      throw new ServiceError({ code: "RUST_COMPUTE_UNAVAILABLE", message: "기술 신호 전략 Rust compute client가 초기화되지 않았습니다.", retryable: true });
    }
    const prepared = await this.technicalAnalysis.prepare(input.request.analysis, {
      requireVolumeSymbols: conditionVolumeSymbols(input.request),
    });
    const strategy = workerStrategy(input.request.strategy);
    const payload: StrategyPayload = {
      technical_analysis: prepared.payload.technical_analysis,
      strategy,
    };
    let backtestRequest: SharedBacktestRequest | undefined;
    if (input.mode === "backtest") {
      backtestRequest = (input.request as TechnicalStrategyBacktestRequest).backtest;
      const { report: _report, ...workerBacktest } = backtestRequest;
      const backtest = await this.backtestEngine.prepare(workerBacktest as BacktestRunRequest);
      payload.simulation = backtest.simulation as unknown as Record<string, unknown>;
      payload.response_context = backtest.responseContext as unknown as Record<string, unknown>;
    } else {
      const safeTradeDates = await this.technicalAnalysis.safeTradeDates(prepared);
      if (!safeTradeDates.length) invalid("analysis", "신호를 적용할 공통 일별 실제 관측일이 없습니다.");
      payload.safe_trade_dates = safeTradeDates;
      payload.evaluation_start_date = input.request.analysis.fromDate;
      payload.evaluation_end_date = input.request.analysis.toDate;
    }
    const simulationMarketInputs = payload.simulation ? {
      assets: payload.simulation.assets,
      prices: payload.simulation.prices,
      observedDates: payload.simulation.observedDates,
      benchmark: payload.simulation.benchmark && typeof payload.simulation.benchmark === "object"
        ? {
            prices: (payload.simulation.benchmark as Record<string, unknown>).prices,
            observedDates: (payload.simulation.benchmark as Record<string, unknown>).observedDates,
          }
        : undefined,
    } : undefined;
    const dataRevision = technicalStrategyDataRevision({
      technical_data_revision: prepared.dataRevision,
      instruments: prepared.instruments,
      ...(simulationMarketInputs ? { simulation_market_inputs: simulationMarketInputs } : { safe_trade_dates: payload.safe_trade_dates }),
    });
    const cacheConfig = {
      cacheSchemaVersion: TECHNICAL_STRATEGY_CACHE_SCHEMA_VERSION,
      indicator_engine_version: TECHNICAL_INDICATOR_ENGINE_VERSION,
      mode: input.mode,
      analysis: prepared.normalized.publicRequest,
      strategy: input.request.strategy,
      ...(backtestRequest ? { backtest: backtestRequest } : {}),
      ...(input.cacheNonce ? { _replayNonce: input.cacheNonce } : {}),
    };
    const executed = this.runs.executionMode === "external"
      ? await this.runs.executeExternal({
          ownerSubject: input.ownerSubject,
          kind: "technical_strategy",
          config: cacheConfig,
          dataRevision,
          payload,
        })
      : await this.runs.execute({
          ownerSubject: input.ownerSubject,
          kind: "technical_strategy",
          config: cacheConfig,
          dataRevision,
          task: async (context) => {
            await context.throwIfCancelled();
            const output = await this.rustCompute!.compute("technical_strategy", payload, { includeArtifacts: true, signal: context.signal });
            const result = parsedResult(output.result, input.mode, input.request);
            return {
              summary: output.summary,
              result,
              warnings: Array.from(new Set([...prepared.marketWarnings, ...output.warnings])),
              artifacts: validatedArtifacts(output, result),
            };
          },
        });
    if (executed.run.result === undefined) {
      throw new ServiceError({ code: "TECHNICAL_STRATEGY_RESULT_NOT_FOUND", message: "완료된 기술 신호 전략 결과를 찾을 수 없습니다.", retryable: true, details: { run_id: executed.run.id } });
    }
    const result = parsedResult(executed.run.result, input.mode, input.request);
    const artifactIndex = await this.artifacts.list(executed.run.id);
    const backtest = result.backtest as (BacktestRunResult & { generatedAt?: string }) | undefined;
    return envelope({
      request: input.request,
      dataRevision,
      generatedAt: backtest?.generatedAt,
      requestedPeriod: { from: input.request.analysis.fromDate, to: input.request.analysis.toDate },
      ...(prepared.effectivePeriod ? { effectivePeriod: prepared.effectivePeriod } : {}),
      assumptions: [
        "조건은 선택 봉 종가가 확정된 뒤 평가하며 예정 거래일은 계산 기준일보다 엄격히 뒤인 첫 공통 실제 관측일입니다.",
        "unknown 조건값은 true로 간주하지 않으며 브라우저와 Node.js는 지표·신호를 재계산하지 않습니다.",
        "결과는 역사적 시뮬레이션이며 주문을 생성하거나 실행하지 않습니다.",
      ],
      warnings: Array.from(new Set([...prepared.marketWarnings, ...executed.run.warnings])),
      dataQuality: {
        mode: input.mode,
        technical_data_revision: prepared.dataRevision,
        signal_count: result.technical_strategy.signals.length,
        planned_signal_count: result.technical_strategy.signals.filter((signal) => signal.status === "planned").length,
        applied_signal_count: result.technical_strategy.signals.filter((signal) => signal.status === "applied").length,
        no_safe_trade_date_count: result.technical_strategy.signals.filter((signal) => signal.status === "no_safe_trade_date").length,
        safe_trade_date_count: result.technical_strategy.diagnostics.safe_trade_date_count,
      },
      result: {
        run_id: executed.run.id,
        reused: executed.reused,
        technical_analysis: result.technical_analysis,
        technical_strategy: result.technical_strategy,
        ...(result.backtest ? { backtest: result.backtest } : {}),
        artifact_index: artifactIndex,
      },
    });
  }
}
