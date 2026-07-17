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
import {
  analyzePairedReturnSeries,
  analyzeReturnSeries,
  alignReturnSeries,
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
import type { ToolName } from "../schemas.js";
import type { RustComputeClient } from "../../worker/rust-client.js";
import type { ArtifactType } from "../../repositories/artifact-repository.js";

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

function optimizationInput(value: GenericInput, loaded: LoadedReturnSeries): OptimizationInput {
  const assetCount = Array.isArray(value.symbols) ? value.symbols.length : loaded.prices.length;
  return {
    priceSeries: loaded.prices.slice(0, assetCount),
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
  };
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
  await dependencies.optimizationRepository.putCandidates(candidates.map((candidate, index) => {
    return {
      runId,
      rank: index + 1,
      weights: candidate.weights,
      metrics: candidate.metrics,
      score: candidate.metrics.robustScore ?? Number.NEGATIVE_INFINITY,
      pareto: pareto.has(candidateSignature(candidate)),
    };
  }));
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
      ...optimizationInput(value, { ...loaded, prices: trainingPrices }),
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
  return {
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
    validate_backtest_config: (input) => dependencies.backtests.validate(object(input) as never),
    run_portfolio_backtest: (input, ownerSubject) => dependencies.backtests.run({ ownerSubject, request: object(input) as never }),
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
    get_current_portfolio: async (input) => {
      const value = object(input);
      const result = await dependencies.portfolio.current(value.accountSelector as string | undefined);
      return envelope({ request: value, dataRevision: result.generated_at, result, assumptions: ["계좌 번호와 금액은 반환하지 않습니다."], dataQuality: {} });
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
      const value = object(input);
      const symbols = [...value.symbols as string[], ...(value.benchmark ? [String(value.benchmark)] : [])];
      const loaded = await dependencies.returnSeries.load({ symbols, fromDate: String(value.fromDate), toDate: String(value.toDate), currencyMode: value.currencyMode as never, adjusted: true });
      const budget = Math.min(Number(value.candidateBudget), dependencies.maxCandidateBudget);
      value.candidateBudget = budget;
      const workerPayload = {
        optimization: optimizationInput(value, loaded),
        objective: value.objective,
        market_warnings: loaded.warnings,
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
              const output = await requireRust(dependencies).compute<OptimizationOutput>("optimization", workerPayload);
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
            const output = optimizePortfolio(optimizationInput(value, loaded));
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
      const value = object(input);
      value.candidateBudget = Math.min(Number(value.candidateBudget), dependencies.maxCandidateBudget);
      const symbols = [...value.symbols as string[], ...(value.benchmark ? [String(value.benchmark)] : [])];
      const loaded = await dependencies.returnSeries.load({ symbols, fromDate: String(value.fromDate), toDate: String(value.toDate), currencyMode: value.currencyMode as never, adjusted: true });
      const workerPayload = {
        optimization: optimizationInput(value, loaded),
        objective: value.objective,
        walkForwardConfig: {
          trainWindow: value.trainWindow,
          testWindow: value.testWindow,
          step: value.step,
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
              const output = await requireRust(dependencies).compute("walk_forward", workerPayload);
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
              const output = await requireRust(dependencies).compute("stress_test", workerPayload);
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
          return { summary: { scenario_count: results.length }, result: { scenarios: results }, warnings: Array.from(new Set(warnings)), artifacts: [{ type: "result", content: results, rowCount: results.length }] };
        },
      });
      return runResultEnvelope(queued.run, value);
    },
    build_pareto_frontier: async (input, ownerSubject) => {
      const value = object(input);
      const run = await dependencies.runs.get(String(value.runId), ownerSubject);
      if (!run) throw new ServiceError({ code: "RUN_NOT_FOUND", message: "run을 찾을 수 없습니다.", retryable: false });
      if (run.kind !== "optimization") throw new ServiceError({ code: "INVALID_RUN_KIND", message: "최적화 run이 필요합니다.", retryable: false });
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
          priceSeries: loaded.prices,
          weights: value.weights,
          initialAmount: value.initialAmount,
          horizonDays: value.horizonDays,
          pathCount: value.pathCount,
          blockLength: value.blockLength,
          seed: value.seed,
          goalAmount: value.goalAmount,
          quantiles: value.quantiles,
          samplePathCount: value.samplePathCount,
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
            const output = await requireRust(dependencies).compute("monte_carlo", payload);
            await context.updateProgress(1, { completedCandidates: Number(value.pathCount), totalCandidates: Number(value.pathCount) });
            return rustTaskResult(output);
          },
        });
      return runResultEnvelope(dispatched.run, value);
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
    generate_backtest_report: async (input, ownerSubject) => {
      const value = object(input);
      const run = await dependencies.runs.get(String(value.runId), ownerSubject);
      if (!run) throw new ServiceError({ code: "RUN_NOT_FOUND", message: "run을 찾을 수 없습니다.", retryable: false });
      if (run.kind !== "backtest") throw new ServiceError({ code: "INVALID_RUN_KIND", message: "백테스트 run이 필요합니다.", retryable: false });
      const report = await dependencies.backtests.generateReport({ ownerSubject, run, reportConfig: { failureMode: value.failureMode } });
      return envelope({ request: value, dataRevision: run.dataRevision, result: { report }, dataQuality: {} });
    },
    get_report: async (input, ownerSubject) => {
      const value = object(input);
      const report = await dependencies.reports.get(String(value.reportId), ownerSubject);
      if (!report) throw new ServiceError({ code: "REPORT_NOT_FOUND", message: "보고서를 찾을 수 없습니다.", retryable: false });
      return envelope({ request: value, dataRevision: report.data_revision, result: { report }, dataQuality: {} });
    },
  };
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
          const output = await requireRust(dependencies).compute(kind, workerPayload);
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
      return {
        summary: { scenario_count: results.length, distributions: metricDistributions(results) },
        result: { scenarios: results, distributions: metricDistributions(results), limitation: HISTORICAL_LIMITATION },
        artifacts: [{ type: "result", content: results, rowCount: results.length }],
      };
    },
  });
  return runResultEnvelope(queued.run, value);
}
