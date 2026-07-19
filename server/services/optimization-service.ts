import {
  analyzePairedReturnSeries,
  analyzeReturnSeries,
  alignReturnSeries,
  convertPricesToReturns,
  createDeterministicRng,
  type PriceSeriesInput,
  type ReturnSeriesInput,
} from "./quant-math.js";

export type OptimizationObjective =
  | "max_cagr"
  | "max_total_return"
  | "max_sharpe"
  | "max_sortino"
  | "max_calmar"
  | "min_volatility"
  | "min_cvar"
  | "max_information_ratio"
  | "robust_score";

export type PortfolioConstraint = {
  minWeight: number;
  maxWeight: number;
  requiredAssets: string[];
  excludedAssets: string[];
  maxAssets: number;
  minWeights: Record<string, number>;
  maxWeights: Record<string, number>;
  maxDrawdown: number;
  targetReturn: number;
  maxTurnover: number;
  currentWeights: Record<string, number>;
};

export type OptimizationInput = {
  objective: OptimizationObjective;
  priceSeries: PriceSeriesInput[];
  /** Raw prices used by rolling OOS evaluation. `benchmark` remains return observations. */
  benchmarkPriceSeries?: PriceSeriesInput;
  benchmark?: ReturnSeriesInput;
  constraints: Partial<PortfolioConstraint>;
  seed?: number;
  candidateBudget?: number;
  riskFreeRatePercent?: number;
  confidence?: number;
  minimumSamples?: number;
  annualization?: number;
  walkForwardConfig?: WalkForwardConfig;
  transactionCostBps?: number;
  algorithm?: "random_search" | "differential_evolution" | "cma_es" | "nsga_ii" | "direct_cvar";
  covarianceEstimator?: "sample" | "ledoit_wolf";
  baselines?: Array<"equal_weight" | "current_weight" | "inverse_volatility" | "minimum_variance" | "risk_parity" | "hrp" | "herc">;
  assetGroups?: Record<string, Partial<Record<"sector" | "industry" | "country" | "currency" | "assetType", string>>>;
  groupConstraints?: Array<{
    dimension: "sector" | "industry" | "country" | "currency" | "assetType";
    group: string;
    minWeight: number;
    maxWeight: number;
  }>;
  robustScoreWeights?: Record<string, number>;
  ledgerTemplate?: unknown;
  ledgerValidationBudget?: number;
  regimePolicySearch?: {
    enabled: boolean;
    method: "auto" | "dynamic_programming" | "mcts";
    states: number | string[];
    baselineActions?: NonNullable<OptimizationInput["baselines"]>;
    lookback: number;
    rebalanceEvery: number;
    trainFraction: number;
    minimumTrainingDecisions?: number;
    maxDepth: number;
    rollouts: number;
    explorationConstant: number;
    discount: number;
    switchingCostBps?: number;
    ledgerValidationBudget: number;
  };
};

export type CandidateMetricSet = {
  /** Net CAGR over `period`; `return` remains a compatibility alias. */
  cagr: number | null;
  /** Net compounded return over the exact same `period`. */
  totalReturn: number | null;
  sharpe: number | null;
  sortino: number | null;
  calmar: number | null;
  volatility: number | null;
  cvar: number | null;
  informationRatio: number | null;
  robustScore: number | null;
  return: number | null;
  maxDrawdown: number | null;
  turnover: number;
  transactionCost: number;
  period: {
    from?: string;
    to?: string;
    observationCount: number;
    role: "screening_train" | "screening_full" | "oos" | "ledger_full";
  };
};

export type PortfolioCandidate = {
  weights: Record<string, number>;
  sampleCount: number;
  metrics: CandidateMetricSet;
  walkForwardTestCoverage?: number;
  walkForwardSignal?: {
    status?: "not_requested" | "disabled" | "not_evaluated" | "completed";
    reason?: "validation_disabled" | "no_valid_folds";
    mode?: "holdout" | "walk_forward";
    windowMode?: "rolling" | "anchored";
    foldCount?: number;
    scoredFoldCount?: number;
    scoredSharpeFoldCount?: number;
    scoredCvarFoldCount?: number;
    averageSharpe: number | null;
    worstSharpe: number | null;
    averageCvar: number | null;
  };
  robustScoreDetail?: unknown;
  baseline?: string;
  algorithm?: string;
  validationStatus?: string;
  validationReason?: string;
  ledgerValidationStatus?: string;
  screeningRank?: number;
  ledgerRank?: number;
  rankChange?: number;
  screeningMetrics?: CandidateMetricSet;
  ledgerMetrics?: Record<string, unknown>;
  metricDelta?: Record<string, number | null>;
};

export type OptimizationOutput = {
  warnings: string[];
  seed: number;
  sampledAssets: string[];
  candidateCount: number;
  candidates: PortfolioCandidate[];
  paretoFrontier: PortfolioCandidate[];
  bestByObjective: Record<OptimizationObjective, PortfolioCandidate | null>;
  futureLeakageWarning?: string;
};

export type WeightedAlignedFrame = {
  ids: string[];
  dates: string[];
  byId: Record<string, number[]>;
};

export type WalkForwardWindow = {
  trainStartIndex: number;
  trainEndIndex: number;
  testStartIndex: number;
  testEndIndex: number;
  trainStart: string;
  trainEnd: string;
  testStart: string;
  testEnd: string;
  trainCount: number;
  testCount: number;
  gap?: number;
  embargo?: number;
  mode?: "holdout" | "walk_forward";
  windowMode?: "rolling" | "anchored";
  foldIndex?: number;
};

export type WalkForwardConfig = {
  enabled?: boolean;
  mode?: "holdout" | "walk_forward";
  windowMode?: "rolling" | "anchored";
  trainFraction?: number;
  testFraction?: number;
  gap?: number;
  embargo?: number;
  trainWindow?: number;
  testWindow?: number;
  step?: number;
  foldCount?: number;
  minimumTrainObservations?: number;
  minimumTestObservations?: number;
};

export type WalkForwardFold = WalkForwardWindow & {
  trainCoverageRatio: number;
  testCoverageRatio: number;
};

export type WalkForwardInput = {
  totalLength: number;
  config?: WalkForwardConfig;
  minimumCoverage?: number;
};

function normalizePositiveInt(value: unknown, fallback: number, minimum = 1, maximum = Number.MAX_SAFE_INTEGER): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(numeric)));
}

function normalizeDecimal(value: unknown, fallback: number, minimum = 0, maximum = 1): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(minimum, Math.min(maximum, numeric));
}

function normalizeWalkForwardConfig(config: WalkForwardConfig = {}): {
  mode: "holdout" | "walk_forward";
  windowMode: "rolling" | "anchored";
  trainFraction: number;
  testFraction: number;
  trainWindow: number;
  testWindow: number;
  step: number;
  foldCount: number;
  gap: number;
  embargo: number;
  minimumTrainObservations: number;
  minimumTestObservations: number;
} {
  const mode = config.mode ?? "walk_forward";
  const windowMode = config.windowMode ?? "rolling";
  const trainFraction = normalizeDecimal(config.trainFraction, 0.8, 0.1, 0.95);
  const testFraction = normalizeDecimal(config.testFraction, 0.2, 0.05, 0.5);
  const trainWindow = normalizePositiveInt(config.trainWindow, 126, 2, 10_000);
  const testWindow = normalizePositiveInt(config.testWindow, 21, 1, 10_000);
  const step = Math.max(1, normalizePositiveInt(config.step, Math.max(1, testWindow), 1, 10_000));
  const foldCount = normalizePositiveInt(config.foldCount, 5, 2, 100);
  const gap = normalizePositiveInt(config.gap, 0, 0, 10_000);
  const embargo = normalizePositiveInt(config.embargo, 0, 0, 10_000);
  const minimumTrainObservations = normalizePositiveInt(
    config.minimumTrainObservations,
    Math.max(2, Math.floor(trainWindow * 0.5)),
    1,
    trainWindow,
  );
  const minimumTestObservations = normalizePositiveInt(
    config.minimumTestObservations,
    Math.max(1, Math.floor(testWindow * 0.5)),
    1,
    testWindow,
  );
  return {
    mode,
    windowMode,
    trainFraction,
    testFraction,
    trainWindow,
    testWindow,
    step,
    foldCount,
    gap,
    embargo,
    minimumTrainObservations,
    minimumTestObservations,
  };
}

function normalizeConstraints(constraints: OptimizationInput["constraints"], assetCount: number): {
  parsed: PortfolioConstraint;
  warnings: string[];
} {
  const warnings: string[] = [];
  const required = Array.from(new Set((constraints.requiredAssets ?? []).filter((asset) => typeof asset === "string" && asset.trim().length > 0)));
  const excluded = Array.from(new Set((constraints.excludedAssets ?? []).filter((asset) => typeof asset === "string" && asset.trim().length > 0)));
  const maxAssets = normalizePositiveInt(constraints.maxAssets, assetCount, 1, Math.max(1, assetCount));
  const minWeight = normalizeDecimal(constraints.minWeight, 0, 0, 1);
  const maxWeight = normalizeDecimal(constraints.maxWeight, 1, 0, 1);

  const clamped = {
    minWeight,
    maxWeight,
    requiredAssets: required,
    excludedAssets: excluded,
    maxAssets,
    minWeights: Object.fromEntries(Object.entries(constraints.minWeights ?? {}).map(([id, value]) => [
      id,
      normalizeDecimal(value, minWeight, 0, 1),
    ])),
    maxWeights: Object.fromEntries(Object.entries(constraints.maxWeights ?? {}).map(([id, value]) => [
      id,
      normalizeDecimal(value, maxWeight, 0, 1),
    ])),
    maxDrawdown: Number.isFinite(constraints.maxDrawdown) ? Math.abs(constraints.maxDrawdown!) : 1,
    targetReturn: Number.isFinite(constraints.targetReturn) ? constraints.targetReturn! : Number.NEGATIVE_INFINITY,
    maxTurnover: Number.isFinite(constraints.maxTurnover) ? Math.max(0, constraints.maxTurnover!) : 1,
    currentWeights: constraints.currentWeights ?? {},
  };

  if (clamped.maxWeight < clamped.minWeight) {
    warnings.push("최대 비중이 최소 비중보다 작아 최소 비중을 최대 비중에 맞춥니다.");
    clamped.maxWeight = clamped.minWeight;
  }

  if (clamped.maxAssets > assetCount) {
    clamped.maxAssets = Math.max(1, assetCount);
    warnings.push("최대 자산 수가 전체 후보 수보다 커서 전체 수로 보정했습니다.");
  }

  return { parsed: clamped, warnings };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function buildAlignedFrame(series: PriceSeriesInput[]): WeightedAlignedFrame {
  const returns = series.map(convertPricesToReturns);
  const aligned = alignReturnSeries(returns);
  return {
    ids: aligned.keys,
    dates: aligned.dates,
    byId: aligned.byKey,
  };
}

function sliceAlignedFrame(frame: WeightedAlignedFrame, start: number, end: number): WeightedAlignedFrame {
  const safeStart = Math.max(0, Math.min(frame.dates.length, start));
  const safeEnd = Math.max(safeStart, Math.min(frame.dates.length, end + 1));
  return {
    ids: [...frame.ids],
    dates: frame.dates.slice(safeStart, safeEnd),
    byId: Object.fromEntries(frame.ids.map((id) => [id, frame.byId[id]!.slice(safeStart, safeEnd)])),
  };
}

function buildPortfolioReturnSeries(frame: WeightedAlignedFrame, weights: Record<string, number>): ReturnSeriesInput {
  const active = Object.entries(weights).filter(([, weight]) => weight > 0);
  const points: Array<{ date: string; value: number }> = [];

  for (let dateIndex = 0; dateIndex < frame.dates.length; dateIndex += 1) {
    let value = 0;
    for (const [id, weight] of active) {
      const raw = frame.byId[id]?.[dateIndex];
      if (!Number.isFinite(raw)) {
        value = Number.NaN;
        break;
      }
      value += weight * raw;
    }
    if (Number.isFinite(value)) {
      points.push({ date: frame.dates[dateIndex]!, value });
    }
  }

  return {
    key: "portfolio",
    label: "portfolio",
    points,
  };
}

function signatureFromWeights(weights: Record<string, number>): string {
  return Object.entries(weights)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}:${value.toFixed(12)}`)
    .join("|");
}

function buildCandidateWeights(
  rng: ReturnType<typeof createDeterministicRng>,
  eligible: string[],
  required: string[],
  constraints: PortfolioConstraint,
): Record<string, number> | null {
  const requiredSet = new Set([
    ...required,
    ...Object.entries(constraints.minWeights)
      .filter(([, minimum]) => minimum > 0)
      .map(([id]) => id),
  ]);
  const filtered = eligible.filter((id) => !constraints.excludedAssets.includes(id));
  const available = filtered.filter((id) => id.length > 0);

  if (!available.length) return null;

  const mandatory = available.filter((id) => requiredSet.has(id));
  if (mandatory.length > constraints.maxAssets) return null;

  const maxCount = Math.min(constraints.maxAssets, available.length);
  const minCount = Math.max(mandatory.length, 1);
  const chosenCount = minCount + rng.nextInt(maxCount - minCount + 1);

  const candidateIds: string[] = [...mandatory];
  const shuffled = [...available];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swap = rng.nextInt(index + 1);
    [shuffled[index], shuffled[swap]] = [shuffled[swap], shuffled[index]];
  }
  for (const id of shuffled) {
    if (candidateIds.includes(id)) continue;
    if (candidateIds.length >= chosenCount) break;
    candidateIds.push(id);
  }

  if (candidateIds.length === 0) return null;

  const minimums = Object.fromEntries(candidateIds.map((id) => [
    id,
    Math.max(constraints.minWeight, constraints.minWeights[id] ?? 0),
  ]));
  const maximums = Object.fromEntries(candidateIds.map((id) => [
    id,
    Math.min(constraints.maxWeight, constraints.maxWeights[id] ?? 1),
  ]));
  if (candidateIds.some((id) => minimums[id]! > maximums[id]!)) return null;
  const minimumTotal = candidateIds.reduce((sum, id) => sum + minimums[id]!, 0);
  const maximumTotal = candidateIds.reduce((sum, id) => sum + maximums[id]!, 0);
  if (minimumTotal > 1 + 1e-12 || maximumTotal < 1 - 1e-12) return null;

  const candidate: Record<string, number> = Object.fromEntries(candidateIds.map((id) => [id, minimums[id]!]));
  let residual = 1 - minimumTotal;
  for (let iteration = 0; residual > 1e-12 && iteration < 100; iteration += 1) {
    const active = candidateIds.filter((id) => maximums[id]! - candidate[id]! > 1e-12);
    if (!active.length) return null;
    const raw = active.map(() => 1 + rng.next());
    const rawTotal = raw.reduce((sum, value) => sum + value, 0);
    let distributed = 0;
    for (let index = 0; index < active.length; index += 1) {
      const id = active[index]!;
      const capacity = maximums[id]! - candidate[id]!;
      const addition = Math.min(capacity, residual * raw[index]! / rawTotal);
      candidate[id] += addition;
      distributed += addition;
    }
    if (distributed <= 1e-14) return null;
    residual -= distributed;
  }
  if (residual > 1e-9) return null;
  return candidate;
}

function safeTanH(value: number): number {
  return Math.tanh(value);
}

function evaluateWalkForwardCandidate(
  portfolio: ReturnSeriesInput,
  benchmark: ReturnSeriesInput | undefined,
  windows: WalkForwardWindow[],
  options: {
    annualization?: number;
    confidence?: number;
    minimumSamples: number;
    riskFreeRatePercent: number;
    transactionCost: number;
    validationConfig?: WalkForwardConfig;
  },
): { coverageRatio: number; signal: {
  status: "not_requested" | "disabled" | "not_evaluated" | "completed";
  reason?: "validation_disabled" | "no_valid_folds";
  mode: "holdout" | "walk_forward";
  windowMode: "rolling" | "anchored";
  foldCount: number;
  scoredFoldCount: number;
  scoredSharpeFoldCount: number;
  scoredCvarFoldCount: number;
  averageSharpe: number | null;
  worstSharpe: number | null;
  averageCvar: number | null;
} } {
  const requested = options.validationConfig !== undefined;
  const enabled = requested && options.validationConfig?.enabled !== false;
  const status = !requested ? "not_requested" : !enabled ? "disabled" : !windows.length ? "not_evaluated" : "completed";
  const reason = status === "disabled" ? "validation_disabled" : status === "not_evaluated" ? "no_valid_folds" : undefined;
  const mode = windows[0]?.mode ?? options.validationConfig?.mode ?? "holdout";
  const windowMode = windows[0]?.windowMode ?? options.validationConfig?.windowMode ?? "rolling";
  if (!windows.length) {
    return {
      coverageRatio: 0,
      signal: {
        status,
        ...(reason ? { reason } : {}),
        mode,
        windowMode,
        foldCount: 0,
        scoredFoldCount: 0,
        scoredSharpeFoldCount: 0,
        scoredCvarFoldCount: 0,
        averageSharpe: null,
        worstSharpe: null,
        averageCvar: null,
      },
    };
  }

  const annualization = options.annualization;
  const confidence = options.confidence;
  const minimum = options.minimumSamples;
  const sharpeValues: number[] = [];
  const cvarValues: number[] = [];
  const uniqueTestObservations = new Set<number>();

  for (const window of windows) {
    const testPoints = portfolio.points
      .slice(window.testStartIndex, window.testEndIndex + 1)
      .map((point, index) => index === 0
        ? { ...point, value: (1 - options.transactionCost) * (1 + point.value) - 1 }
        : point);
    if (!testPoints.length) continue;
    const testSeries: ReturnSeriesInput = {
      key: portfolio.key,
      label: portfolio.label,
      points: testPoints,
    };
    const testStats = analyzeReturnSeries(testSeries, {
      annualization,
      confidence,
      minimumObservations: minimum,
      riskFreeRatePercent: options.riskFreeRatePercent,
    });

    if (testStats.observations >= minimum && testStats.sharpeRatio !== null) {
      sharpeValues.push(testStats.sharpeRatio);
    }
    if (testStats.observations >= minimum && testStats.conditionalValueAtRisk95 !== null) {
      cvarValues.push(testStats.conditionalValueAtRisk95);
    }

    for (let index = window.testStartIndex; index <= window.testEndIndex; index += 1) {
      uniqueTestObservations.add(index);
    }

    if (benchmark) {
      const testBenchPoints = benchmark.points.slice(window.testStartIndex, window.testEndIndex + 1);
      if (testBenchPoints.length) {
        const testBench: ReturnSeriesInput = {
          key: benchmark.key,
          label: benchmark.label,
          points: testBenchPoints,
        };
        analyzePairedReturnSeries(testSeries, testBench, {
          annualization,
          confidence,
          minimumObservations: minimum,
          riskFreeRatePercent: options.riskFreeRatePercent,
        });
      }
    }
  }

  const average = (values: number[]): number | null => {
    if (!values.length) return null;
    return values.reduce((acc, value) => acc + value, 0) / values.length;
  };

  const averageSharpe = average(sharpeValues);
  const averageCvar = average(cvarValues);
  const worstSharpe = sharpeValues.length ? Math.min(...sharpeValues) : null;

  return {
    coverageRatio: Math.min(1, uniqueTestObservations.size / Math.max(1, portfolio.points.length)),
    signal: {
      status,
      ...(reason ? { reason } : {}),
      mode,
      windowMode,
      foldCount: windows.length,
      scoredFoldCount: Math.max(sharpeValues.length, cvarValues.length),
      scoredSharpeFoldCount: sharpeValues.length,
      scoredCvarFoldCount: cvarValues.length,
      averageSharpe,
      worstSharpe,
      averageCvar,
    },
  };
}

function evaluatePortfolioCandidate(
  frame: WeightedAlignedFrame,
  weights: Record<string, number>,
  benchmark: ReturnSeriesInput | undefined,
  options: {
    annualization?: number;
    confidence?: number;
    minimumSamples: number;
    riskFreeRatePercent: number;
    walkForwardWindows: WalkForwardWindow[];
    oosFrame?: WeightedAlignedFrame;
    constraints: PortfolioConstraint;
    transactionCostBps: number;
    walkForwardConfig?: WalkForwardConfig;
  },
): PortfolioCandidate {
  const grossPortfolio = buildPortfolioReturnSeries(frame, weights);
  const targetWeight = frame.ids.reduce((sum, id) => sum + (weights[id] ?? 0), 0);
  const currentWeight = frame.ids.reduce((sum, id) => sum + (options.constraints.currentWeights[id] ?? 0), 0);
  const assetTurnover = frame.ids.reduce(
    (sum, id) => sum + Math.abs((weights[id] ?? 0) - (options.constraints.currentWeights[id] ?? 0)),
    0,
  );
  const cashTurnover = Math.abs((1 - targetWeight) - (1 - currentWeight));
  const turnover = 0.5 * (assetTurnover + cashTurnover);
  const transactionCost = turnover * options.transactionCostBps / 10_000;
  const portfolio: ReturnSeriesInput = {
    ...grossPortfolio,
    points: grossPortfolio.points.map((point, index) => index === 0
      ? { ...point, value: (1 - transactionCost) * (1 + point.value) - 1 }
      : point),
  };
  const stats = analyzeReturnSeries(portfolio, {
    annualization: options.annualization,
    confidence: options.confidence,
    minimumObservations: options.minimumSamples,
    riskFreeRatePercent: options.riskFreeRatePercent,
  });

  const pair = benchmark
    ? analyzePairedReturnSeries(portfolio, benchmark, {
      annualization: options.annualization,
      confidence: options.confidence,
      minimumObservations: options.minimumSamples,
      riskFreeRatePercent: options.riskFreeRatePercent,
    })
    : null;

  const oosPortfolio = buildPortfolioReturnSeries(options.oosFrame ?? frame, weights);
  const walkForward = evaluateWalkForwardCandidate(oosPortfolio, benchmark, options.walkForwardWindows, {
    annualization: options.annualization,
    confidence: options.confidence,
    minimumSamples: options.minimumSamples,
    riskFreeRatePercent: options.riskFreeRatePercent,
    transactionCost,
    validationConfig: options.walkForwardConfig,
  });

  const metrics: CandidateMetricSet = {
    cagr: stats.cagr,
    totalReturn: stats.cumulativeReturn,
    sharpe: stats.sharpeRatio,
    sortino: stats.sortinoRatio,
    calmar: stats.calmarRatio,
    volatility: stats.annualizedVolatility,
    cvar: stats.conditionalValueAtRisk95,
    informationRatio: pair?.informationRatio ?? null,
    robustScore: null,
    return: stats.cagr,
    maxDrawdown: stats.maxDrawdown,
    turnover,
    transactionCost,
    period: {
      ...(frame.dates[0] ? { from: frame.dates[0] } : {}),
      ...(frame.dates.at(-1) ? { to: frame.dates.at(-1)! } : {}),
      observationCount: stats.observations,
      role: options.walkForwardWindows.length ? "screening_train" : "screening_full",
    },
  };

  const robustValues = [
    metrics.sharpe,
    metrics.sortino,
    metrics.calmar,
    metrics.volatility,
    metrics.cvar,
    metrics.informationRatio,
    walkForward.signal.averageSharpe,
    walkForward.signal.worstSharpe,
    walkForward.signal.averageCvar,
  ];
  let robustScoreDetail: Record<string, unknown> | undefined;

  if (robustValues.some((value): value is number => Number.isFinite(value))) {
    const sharpeScore = metrics.sharpe === null ? 0 : safeTanH(metrics.sharpe / 2);
    const sortinoScore = metrics.sortino === null ? 0 : safeTanH(metrics.sortino / 2);
    const calmarScore = metrics.calmar === null ? 0 : safeTanH(metrics.calmar);
    const volatilityScore = metrics.volatility === null ? 0 : 1 / (1 + metrics.volatility);
    const cvarScore = metrics.cvar === null ? 0 : 1 / (1 + Math.abs(metrics.cvar));
    const informationScore = metrics.informationRatio === null ? 0 : safeTanH(metrics.informationRatio / 2);
    const wfAverageSharpe = walkForward.signal.averageSharpe === null ? 0 : safeTanH(walkForward.signal.averageSharpe / 2);
    const wfWorstSharpe = walkForward.signal.worstSharpe === null ? 0 : safeTanH(walkForward.signal.worstSharpe / 2);
    const wfCvarScore = walkForward.signal.averageCvar === null ? 0 : 1 / (1 + Math.abs(walkForward.signal.averageCvar));

    metrics.robustScore = (
      0.16 * sharpeScore +
      0.14 * sortinoScore +
      0.12 * calmarScore +
      0.12 * volatilityScore +
      0.12 * cvarScore +
      0.08 * informationScore +
      0.1 * wfAverageSharpe +
      0.1 * wfWorstSharpe +
      0.06 * wfCvarScore
    );
    if (!Number.isFinite(metrics.robustScore)) {
      metrics.robustScore = null;
    }
    const components = [
      { name: "sharpe", source: "in_sample", raw: metrics.sharpe, normalized: metrics.sharpe === null ? null : sharpeScore, weight: 0.16 },
      { name: "sortino", source: "in_sample", raw: metrics.sortino, normalized: metrics.sortino === null ? null : sortinoScore, weight: 0.14 },
      { name: "calmar", source: "in_sample", raw: metrics.calmar, normalized: metrics.calmar === null ? null : calmarScore, weight: 0.12 },
      { name: "volatility", source: "in_sample", raw: metrics.volatility, normalized: metrics.volatility === null ? null : volatilityScore, weight: 0.12 },
      { name: "cvar", source: "in_sample", raw: metrics.cvar, normalized: metrics.cvar === null ? null : cvarScore, weight: 0.12 },
      { name: "informationRatio", source: "in_sample", raw: metrics.informationRatio, normalized: metrics.informationRatio === null ? null : informationScore, weight: 0.08 },
      { name: "oosAverageSharpe", source: "oos", raw: walkForward.signal.averageSharpe, normalized: walkForward.signal.averageSharpe === null ? null : wfAverageSharpe, weight: 0.10 },
      { name: "oosWorstSharpe", source: "oos", raw: walkForward.signal.worstSharpe, normalized: walkForward.signal.worstSharpe === null ? null : wfWorstSharpe, weight: 0.10 },
      { name: "oosAverageCvar", source: "oos", raw: walkForward.signal.averageCvar, normalized: walkForward.signal.averageCvar === null ? null : wfCvarScore, weight: 0.06 },
    ].map((component) => ({
      ...component,
      available: component.normalized !== null,
      contribution: (component.normalized ?? 0) * component.weight,
    }));
    const componentScore = (source: "in_sample" | "oos") => {
      const available = components.filter((component) => component.source === source && component.available);
      const availableWeight = available.reduce((sum, component) => sum + component.weight, 0);
      return availableWeight > 0
        ? available.reduce((sum, component) => sum + component.contribution, 0) / availableWeight
        : null;
    };
    robustScoreDetail = {
      score: metrics.robustScore,
      inSampleScore: componentScore("in_sample"),
      outOfSampleScore: componentScore("oos"),
      configuredWeight: 1,
      availableWeight: components.filter((component) => component.available).reduce((sum, component) => sum + component.weight, 0),
      coverage: walkForward.coverageRatio,
      components,
      validation: {
        status: walkForward.signal.status,
        ...(walkForward.signal.reason ? { reason: walkForward.signal.reason } : {}),
        mode: walkForward.signal.mode,
        windowMode: walkForward.signal.windowMode,
        foldCount: walkForward.signal.foldCount,
        scoredFoldCount: walkForward.signal.scoredFoldCount,
        scoredSharpeFoldCount: walkForward.signal.scoredSharpeFoldCount,
        scoredCvarFoldCount: walkForward.signal.scoredCvarFoldCount,
        coverage: walkForward.coverageRatio,
        componentCoverage: {
          oosAverageSharpe: walkForward.signal.foldCount > 0 ? walkForward.signal.scoredSharpeFoldCount / walkForward.signal.foldCount : 0,
          oosWorstSharpe: walkForward.signal.foldCount > 0 ? walkForward.signal.scoredSharpeFoldCount / walkForward.signal.foldCount : 0,
          oosAverageCvar: walkForward.signal.foldCount > 0 ? walkForward.signal.scoredCvarFoldCount / walkForward.signal.foldCount : 0,
        },
        leakageControl: "candidate_weights_fit_on_first_fold_train_only",
      },
    };
  }

  return {
    weights,
    sampleCount: stats.observations,
    validationStatus: walkForward.signal.status,
    ...(walkForward.signal.reason ? { validationReason: walkForward.signal.reason } : {}),
    metrics,
    walkForwardTestCoverage: walkForward.coverageRatio,
    walkForwardSignal: {
      status: walkForward.signal.status,
      ...(walkForward.signal.reason ? { reason: walkForward.signal.reason } : {}),
      mode: walkForward.signal.mode,
      windowMode: walkForward.signal.windowMode,
      foldCount: walkForward.signal.foldCount,
      scoredFoldCount: walkForward.signal.scoredFoldCount,
      scoredSharpeFoldCount: walkForward.signal.scoredSharpeFoldCount,
      scoredCvarFoldCount: walkForward.signal.scoredCvarFoldCount,
      averageSharpe: walkForward.signal.averageSharpe,
      worstSharpe: walkForward.signal.worstSharpe,
      averageCvar: walkForward.signal.averageCvar,
    },
    robustScoreDetail,
  };
}

function better(left: CandidateMetricSet, right: CandidateMetricSet, objective: OptimizationObjective): boolean {
  const leftValue = {
    max_cagr: left.cagr,
    max_total_return: left.totalReturn,
    max_sharpe: left.sharpe,
    max_sortino: left.sortino,
    max_calmar: left.calmar,
    min_volatility: left.volatility,
    min_cvar: left.cvar,
    max_information_ratio: left.informationRatio,
    robust_score: left.robustScore,
  }[objective];

  const rightValue = {
    max_cagr: right.cagr,
    max_total_return: right.totalReturn,
    max_sharpe: right.sharpe,
    max_sortino: right.sortino,
    max_calmar: right.calmar,
    min_volatility: right.volatility,
    min_cvar: right.cvar,
    max_information_ratio: right.informationRatio,
    robust_score: right.robustScore,
  }[objective];

  if (leftValue === null || rightValue === null) return false;

  if (objective === "min_volatility") {
    return leftValue < rightValue;
  }
  if (objective === "min_cvar") return Math.abs(leftValue) < Math.abs(rightValue);
  return leftValue > rightValue;
}

function dominates(left: CandidateMetricSet, right: CandidateMetricSet): boolean {
  let strictlyBetter = false;
  const dimensions: Array<[number | null, number | null, "max" | "min"]> = [
    [left.return, right.return, "max"],
    [left.volatility, right.volatility, "min"],
    [left.maxDrawdown === null ? null : Math.abs(left.maxDrawdown), right.maxDrawdown === null ? null : Math.abs(right.maxDrawdown), "min"],
    [left.cvar === null ? null : Math.abs(left.cvar), right.cvar === null ? null : Math.abs(right.cvar), "min"],
    [left.turnover, right.turnover, "min"],
    [left.transactionCost, right.transactionCost, "min"],
  ];
  let comparable = 0;
  for (const [leftValue, rightValue, direction] of dimensions) {
    if (leftValue === null || rightValue === null) continue;
    comparable += 1;
    if (direction === "min") {
      if (leftValue > rightValue) return false;
      if (leftValue < rightValue) strictlyBetter = true;
    } else {
      if (leftValue < rightValue) return false;
      if (leftValue > rightValue) strictlyBetter = true;
    }
  }
  return comparable > 0 && strictlyBetter;
}

export function buildParetoFrontier(candidates: PortfolioCandidate[]): PortfolioCandidate[] {
  const frontier: PortfolioCandidate[] = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index]!;
    let dominated = false;
    for (let test = 0; test < candidates.length; test += 1) {
      if (index === test) continue;
      if (dominates(candidates[test]!.metrics, candidate.metrics)) {
        dominated = true;
        break;
      }
    }
    if (!dominated) frontier.push(candidate);
  }

  return frontier;
}

export function optimizePortfolio(input: OptimizationInput): OptimizationOutput {
  const warnings: string[] = [];
  const seed = normalizePositiveInt(input.seed, 0xC0FFEE, 0, Number.MAX_SAFE_INTEGER);
  const rng = createDeterministicRng(seed);

  const minSamples = normalizePositiveInt(input.minimumSamples, 2, 2, 3650);
  const annualization = Number.isFinite(input.annualization as number) && (input.annualization ?? 0) > 0
    ? input.annualization
    : undefined;
  const confidence = input.confidence;
  const riskFreeRatePercent = normalizeDecimal(input.riskFreeRatePercent, 0, -100, 100);

  if (!Array.isArray(input.priceSeries) || input.priceSeries.length < 2) {
    warnings.push("최소 2개 이상의 자산이 필요합니다.");
  }

  const walkForwardWindows: WalkForwardWindow[] = [];
  let futureLeakageWarning: string | undefined;
  if (!input.walkForwardConfig) {
    futureLeakageWarning = "walk-forward 설정이 없어 전 구간 최적화입니다. 미래 누수(look-ahead) 위험이 존재합니다.";
  }

  const aligned = buildAlignedFrame(input.priceSeries);
  if (input.walkForwardConfig) {
    walkForwardWindows.push(...buildWalkForwardWindows(aligned.dates.length, input.walkForwardConfig));
  }
  const firstValidationWindow = walkForwardWindows[0];
  const trainingAligned = firstValidationWindow
    ? sliceAlignedFrame(aligned, firstValidationWindow.trainStartIndex, firstValidationWindow.trainEndIndex)
    : aligned;

  if (!aligned.dates.length) {
    warnings.push("공통 기간 교집합 데이터가 없습니다.");
  }

  const constraintBase = normalizeConstraints(input.constraints, aligned.ids.length);
  warnings.push(...constraintBase.warnings);
  const constraints = constraintBase.parsed;

  const availableAssets = aligned.ids.filter((id) => !constraints.excludedAssets.includes(id));
  const requiredAssets = Array.from(new Set([
    ...constraints.requiredAssets,
    ...Object.entries(constraints.minWeights).filter(([, minimum]) => minimum > 0).map(([id]) => id),
  ]));
  const requiredInScope = requiredAssets.filter((id) => availableAssets.includes(id));

  if (requiredInScope.length !== requiredAssets.length) {
    throw new Error("필수 자산이 후보군에 없거나 제외 자산과 충돌합니다.");
  }
  if (constraints.maxAssets > availableAssets.length) {
    warnings.push("maxAssets가 사용 가능한 자산 수보다 커서 조정했습니다.");
  }

  const candidateBudget = normalizePositiveInt(input.candidateBudget, 500, 1, 10_000);
  const benchmark = input.benchmark;
  const maxAttempts = candidateBudget * 40;
  const seenSignatures = new Set<string>();

  const candidates: PortfolioCandidate[] = [];
  const objectives: OptimizationObjective[] = [
    "max_cagr",
    "max_total_return",
    "max_sharpe",
    "max_sortino",
    "max_calmar",
    "min_volatility",
    "min_cvar",
    "max_information_ratio",
    "robust_score",
  ];

  const bestByObjective: Record<OptimizationObjective, PortfolioCandidate | null> = {
    max_cagr: null,
    max_total_return: null,
    max_sharpe: null,
    max_sortino: null,
    max_calmar: null,
    min_volatility: null,
    min_cvar: null,
    max_information_ratio: null,
    robust_score: null,
  };

  for (let attempt = 0; attempt < maxAttempts && candidates.length < candidateBudget; attempt += 1) {
    const weights = buildCandidateWeights(rng, availableAssets, requiredInScope, constraints);
    if (!weights) continue;

    const sig = signatureFromWeights(weights);
    if (seenSignatures.has(sig)) continue;
    seenSignatures.add(sig);

    const candidate = evaluatePortfolioCandidate(trainingAligned, weights, benchmark, {
      annualization,
      confidence,
      minimumSamples: minSamples,
      riskFreeRatePercent,
      walkForwardWindows,
      oosFrame: walkForwardWindows.length ? aligned : undefined,
      constraints,
      transactionCostBps: Math.max(0, Math.min(500, input.transactionCostBps ?? 0)),
      walkForwardConfig: input.walkForwardConfig,
    });

    const perAssetValid = Object.entries(candidate.weights).every(([id, weight]) => (
      weight >= (constraints.minWeights[id] ?? constraints.minWeight)
      && weight <= (constraints.maxWeights[id] ?? constraints.maxWeight)
    )) && Object.entries(constraints.minWeights).every(([id, minimum]) => (candidate.weights[id] ?? 0) >= minimum);
    if (!perAssetValid
      || (candidate.metrics.maxDrawdown !== null && Math.abs(candidate.metrics.maxDrawdown) > constraints.maxDrawdown)
      || (candidate.metrics.return !== null && candidate.metrics.return < constraints.targetReturn)
      || candidate.metrics.turnover > constraints.maxTurnover) {
      continue;
    }

    candidates.push(candidate);

    for (const objective of objectives) {
      const current = bestByObjective[objective];
      if (!current || better(candidate.metrics, current.metrics, objective)) {
        bestByObjective[objective] = candidate;
      }
    }

    if (walkForwardWindows.length === 0 && candidate.sampleCount < minSamples) {
      warnings.push(`샘플수가 부족한 조합이 생성되었습니다. (${candidate.sampleCount}개) 경고 반영.`);
    }
  }

  if (!candidates.length) {
    warnings.push("조건을 만족하는 후보가 없습니다. 제약값/샘플수/예산을 완화하세요.");
  }

  const paretoFrontier = buildParetoFrontier(candidates);
  const sortedCandidates = [...candidates].sort((left, right) => {
    const leftScore = left.metrics.robustScore;
    const rightScore = right.metrics.robustScore;
    if (leftScore === null && rightScore === null) return 0;
    if (leftScore === null) return 1;
    if (rightScore === null) return -1;
    return rightScore - leftScore;
  });

  if (walkForwardWindows.length === 0) {
    const requiredTrain = normalizeWalkForwardConfig(input.walkForwardConfig).minimumTrainObservations;
    if (aligned.dates.length > 0 && aligned.dates.length < requiredTrain) {
      warnings.push("walk-forward가 없고 표본 수가 작아 신뢰도가 낮습니다.");
    }
  }

  return {
    warnings,
    seed,
    sampledAssets: availableAssets,
    candidateCount: sortedCandidates.length,
    candidates: sortedCandidates,
    paretoFrontier,
    bestByObjective,
    futureLeakageWarning,
  };
}

export function buildWalkForwardWindows(totalLength: number, config: WalkForwardConfig = {}): WalkForwardWindow[] {
  const safeLength = normalizePositiveInt(totalLength, 0, 0, 10_000_000);
  const normalized = normalizeWalkForwardConfig(config);
  const windows: WalkForwardWindow[] = [];

  if (safeLength === 0) return windows;
  if (config.enabled === false) return windows;
  if (normalized.mode === "holdout") {
    if (safeLength < normalized.minimumTrainObservations + normalized.minimumTestObservations + normalized.gap) return windows;
    const available = safeLength - normalized.gap;
    const requestedTest = Math.max(
      normalized.minimumTestObservations,
      Math.min(available - normalized.minimumTrainObservations, Math.round(safeLength * normalized.testFraction)),
    );
    const testStart = safeLength - requestedTest;
    const testEnd = safeLength - 1;
    const trainEnd = testStart - normalized.gap - 1;
    const maximumTrain = trainEnd + 1;
    const requestedTrain = Math.max(
      normalized.minimumTrainObservations,
      Math.min(maximumTrain, Math.round(safeLength * normalized.trainFraction)),
    );
    const trainStart = maximumTrain - requestedTrain;
    return [{
      foldIndex: 0,
      trainStartIndex: trainStart,
      trainEndIndex: trainEnd,
      testStartIndex: testStart,
      testEndIndex: testEnd,
      trainStart: `index-${trainStart}`,
      trainEnd: `index-${trainEnd}`,
      testStart: `index-${testStart}`,
      testEnd: `index-${testEnd}`,
      trainCount: requestedTrain,
      testCount: requestedTest,
      gap: normalized.gap,
      embargo: 0,
      mode: "holdout",
    }];
  }

  const advance = Math.max(normalized.step, normalized.testWindow + normalized.embargo);
  for (let offset = 0; windows.length < normalized.foldCount; offset += advance) {
    const trainStart = normalized.windowMode === "anchored" ? 0 : offset;
    const trainEnd = offset + normalized.trainWindow - 1;
    const testStart = trainEnd + 1 + normalized.gap;
    const testEnd = testStart + normalized.testWindow - 1;
    if (testEnd >= safeLength) break;

    const trainCount = trainEnd - trainStart + 1;
    const testCount = testEnd - testStart + 1;
    if (trainCount < normalized.minimumTrainObservations || testCount < normalized.minimumTestObservations) continue;

    windows.push({
      foldIndex: windows.length,
      trainStartIndex: trainStart,
      trainEndIndex: trainEnd,
      testStartIndex: testStart,
      testEndIndex: testEnd,
      trainStart: `index-${trainStart}`,
      trainEnd: `index-${trainEnd}`,
      testStart: `index-${testStart}`,
      testEnd: `index-${testEnd}`,
      trainCount,
      testCount,
      gap: normalized.gap,
      embargo: normalized.embargo,
      mode: "walk_forward",
      windowMode: normalized.windowMode,
    });
  }

  return windows;
}

export function optimizeWalkForward(input: WalkForwardInput): {
  windows: WalkForwardFold[];
  warnings: string[];
  robustCoverage: number;
} {
  const warnings: string[] = [];
  const totalLength = normalizePositiveInt(input.totalLength, 0, 0, 10_000_000);
  const config = normalizeWalkForwardConfig(input.config ?? {});
  if (totalLength <= 0) {
    warnings.push("총 기간 길이가 0이므로 walk-forward 구간을 생성할 수 없습니다.");
  }
  if (totalLength > 0 && totalLength < config.trainWindow + config.testWindow) {
    warnings.push("총 기간이 학습/검증 윈도우 합보다 작아 walk-forward 구간이 적게 생성될 수 있습니다.");
  }

  const windowsBase = buildWalkForwardWindows(totalLength, input.config ?? {});
  const windows: WalkForwardFold[] = windowsBase.map((window) => ({
    ...window,
    trainCoverageRatio: window.trainCount / Math.max(1, totalLength),
    testCoverageRatio: window.testCount / Math.max(1, totalLength),
  }));

  const robustCoverage = totalLength > 0
    ? windows.reduce((acc, window) => acc + window.testCoverageRatio, 0)
    : 0;

  if (!windows.length) {
    warnings.push("설정값으로 walk-forward 구간이 생성되지 않았습니다.");
  }
  if (input.minimumCoverage !== undefined && robustCoverage < input.minimumCoverage) {
    warnings.push("요청한 minimumCoverage를 만족하지 못했습니다.");
  }

  return {
    windows,
    warnings,
    robustCoverage,
  };
}
