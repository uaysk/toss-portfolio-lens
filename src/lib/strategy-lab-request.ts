import { normalizedBacktestWeights, parseNumberList } from "@/lib/backtest-config";
import type { BacktestQuantityMode, BacktestRebalanceFrequency, BacktestRunConfiguration } from "@/types";

export const optimizationAlgorithms = [
  "random_search",
  "differential_evolution",
  "cma_es",
  "nsga_ii",
  "direct_cvar",
] as const;

export const optimizerBaselines = [
  "equal_weight",
  "current_weight",
  "inverse_volatility",
  "minimum_variance",
  "risk_parity",
  "hrp",
  "herc",
] as const;

export type OptimizationAlgorithm = typeof optimizationAlgorithms[number];
export type CovarianceEstimator = "sample" | "ledoit_wolf";
export type OptimizerBaseline = typeof optimizerBaselines[number];
export type RegimePolicyMethod = "auto" | "dynamic_programming" | "mcts";
export type WalkForwardMode = "rolling" | "anchored";
export type RobustValidationMode = "holdout" | "walk_forward";
export type MonteCarloMethod = "moving_block" | "stationary" | "regime_conditioned" | "student_t";
export type AssetGroupDimension = "sector" | "industry" | "country" | "currency" | "assetType";
export type AssetGroupMetadata = Partial<Record<AssetGroupDimension, string>>;
export type GroupConstraintInput = {
  dimension: AssetGroupDimension;
  group: string;
  minWeightPercent: number;
  maxWeightPercent: number;
};
export type ExposureConstituent = {
  symbol: string;
  weight: number;
  sector?: string;
  industry?: string;
  country?: string;
  currency?: string;
  assetType?: string;
  hedged?: boolean;
  factors?: Record<string, number>;
};
export type ExposureAssetRequestInput = {
  symbol: string;
  weight: number;
  currency: string;
  sector?: string;
  industry?: string;
  country?: string;
  assetType?: string;
  hedged?: boolean;
  factors: Record<string, number>;
  constituents: ExposureConstituent[];
};
export type DraftParseResult<T> = { value: T; error?: string };

type OptimizationControls = {
  objective: string;
  benchmark?: string;
  candidateBudget: number;
  seed: number;
  minWeightPercent: number;
  maxWeightPercent: number;
  minWeightsPercent: Record<string, number>;
  maxWeightsPercent: Record<string, number>;
  maxAssets: number;
  requiredAssets: string[];
  excludedAssets: string[];
  maxDrawdownPercent?: number;
  targetReturnPercent?: number;
  maxTurnoverPercent?: number;
  algorithm: OptimizationAlgorithm;
  covarianceEstimator: CovarianceEstimator;
  baselines: OptimizerBaseline[];
  ledgerValidationBudget: number;
  ledgerQuantityMode: BacktestQuantityMode;
  regimePolicyEnabled: boolean;
  regimePolicyMethod: RegimePolicyMethod;
  assetGroups: Record<string, AssetGroupMetadata>;
  groupConstraints: GroupConstraintInput[];
  robustScoreWeights: Record<string, number>;
  robustValidationEnabled?: boolean;
  robustValidationMode?: RobustValidationMode;
  robustValidationWindowMode?: WalkForwardMode;
  robustValidationTestPercent?: number;
  robustValidationTrainWindow?: number;
  robustValidationTestWindow?: number;
  robustValidationStep?: number;
  robustValidationFoldCount?: number;
  robustValidationGap?: number;
  robustValidationEmbargo?: number;
};

export type WalkForwardControls = {
  mode: WalkForwardMode;
  trainWindow: number;
  testWindow: number;
  step: number;
  gap: number;
  embargo: number;
  foldCandidateBudget: number;
  seed: number;
  additionalSeeds: string;
};

export type MonteCarloControls = {
  method: MonteCarloMethod;
  horizonDays: number;
  pathCount: number;
  blockLength: number;
  seed: number;
  goalAmount?: number;
  quantiles: number[];
  samplePathCount: number;
  rebalanceFrequency: BacktestRebalanceFrequency;
  rebalanceThresholdPercent?: number;
  cashWeightPercent: number;
  cashAnnualYieldPercent: number;
  transactionCostBps: number;
  periodicCashFlow: number;
  cashFlowFrequencyDays: number;
  inflationAnnualPercent: number;
  quantityMode: BacktestQuantityMode;
  lotSizes: Record<string, number>;
  calibrationOrigins: number;
};

function optionalPercent(value: number | undefined): number | undefined {
  return value === undefined || !Number.isFinite(value) ? undefined : value / 100;
}

export function walkForwardSeeds(seed: number, additionalSeeds: string): number[] {
  return Array.from(new Set([
    seed,
    ...parseNumberList(additionalSeeds),
  ].filter((value) => Number.isSafeInteger(value) && value >= 0)));
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parseRobustScoreWeightsDraft(draft: string): DraftParseResult<Record<string, number>> {
  if (!draft.trim()) return { value: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(draft);
  } catch {
    return { value: {}, error: "강건 점수 가중치는 유효한 JSON 객체여야 합니다." };
  }
  if (!plainRecord(parsed)) return { value: {}, error: "강건 점수 가중치는 JSON 객체여야 합니다." };
  const allowed = new Set([
    "sharpe", "sortino", "calmar", "volatility", "cvar", "informationRatio",
    "oosAverageSharpe", "oosWorstSharpe", "oosAverageCvar",
    "inSampleSharpe", "inSampleSortino", "inSampleCalmar", "inSampleVolatility",
    "inSampleCvar", "inSampleInformationRatio", "averageSharpe", "worstSharpe", "averageCvar",
  ]);
  const value: Record<string, number> = {};
  for (const [rawKey, rawValue] of Object.entries(parsed)) {
    const key = rawKey.trim();
    if (!allowed.has(key)) {
      return { value: {}, error: `지원하지 않는 강건 점수 구성요소입니다: ${key || "(빈 키)"}` };
    }
    if (typeof rawValue !== "number" || !Number.isFinite(rawValue) || rawValue < 0 || rawValue > 1) {
      return { value: {}, error: "강건 점수 가중치는 0~1의 유한한 숫자여야 합니다." };
    }
    value[key] = rawValue;
  }
  if (Object.keys(value).length && !Object.values(value).some((item) => item > 0)) {
    return { value: {}, error: "비어 있지 않은 강건 점수 가중치는 하나 이상이 0보다 커야 합니다." };
  }
  return { value };
}

export function parseExposureConstituentsDraft(draft: string): DraftParseResult<ExposureConstituent[]> {
  if (!draft.trim()) return { value: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(draft);
  } catch {
    return { value: [], error: "구성종목은 유효한 JSON 배열이어야 합니다." };
  }
  if (!Array.isArray(parsed) || parsed.length > 5_000) {
    return { value: [], error: "구성종목은 최대 5,000개의 JSON 배열이어야 합니다." };
  }
  const allowed = new Set(["symbol", "weight", "sector", "industry", "country", "currency", "assetType", "hedged", "factors"]);
  const result: ExposureConstituent[] = [];
  for (const [index, item] of parsed.entries()) {
    if (!plainRecord(item) || Object.keys(item).some((key) => !allowed.has(key))) {
      return { value: [], error: `${index + 1}번째 구성종목에 지원하지 않는 필드가 있습니다.` };
    }
    const symbol = typeof item.symbol === "string" ? item.symbol.trim().toUpperCase() : "";
    const weight = item.weight;
    if (!/^[A-Z0-9.-]{1,32}$/.test(symbol) || typeof weight !== "number" || !Number.isFinite(weight) || weight <= 0 || weight > 1) {
      return { value: [], error: `${index + 1}번째 구성종목의 symbol 또는 0~1 weight가 올바르지 않습니다.` };
    }
    const output: ExposureConstituent = { symbol, weight };
    for (const key of ["sector", "industry", "country", "currency", "assetType"] as const) {
      const raw = item[key];
      if (raw === undefined) continue;
      if (typeof raw !== "string" || !raw.trim()) return { value: [], error: `${index + 1}번째 구성종목의 ${key}가 올바르지 않습니다.` };
      const normalized = key === "currency" ? raw.trim().toUpperCase() : raw.trim();
      if ((key === "currency" && !/^[A-Z]{3}$/.test(normalized))
        || (key === "country" && (normalized.length < 2 || normalized.length > 100))
        || ((key === "sector" || key === "industry" || key === "assetType") && normalized.length > 100)) {
        return { value: [], error: `${index + 1}번째 구성종목의 ${key} 형식이 올바르지 않습니다.` };
      }
      output[key] = normalized;
    }
    if (item.hedged !== undefined) {
      if (typeof item.hedged !== "boolean") return { value: [], error: `${index + 1}번째 구성종목의 hedged는 boolean이어야 합니다.` };
      output.hedged = item.hedged;
    }
    if (item.factors !== undefined) {
      if (!plainRecord(item.factors)) return { value: [], error: `${index + 1}번째 구성종목의 factors는 숫자 객체여야 합니다.` };
      const factors: Record<string, number> = {};
      for (const [rawFactor, rawValue] of Object.entries(item.factors)) {
        const factor = rawFactor.trim();
        if (!factor || factor.length > 80 || typeof rawValue !== "number" || !Number.isFinite(rawValue)) {
          return { value: [], error: `${index + 1}번째 구성종목의 factor 이름 또는 값이 올바르지 않습니다.` };
        }
        if (factor in factors) return { value: [], error: `${index + 1}번째 구성종목에 중복 factor가 있습니다: ${factor}` };
        factors[factor] = rawValue;
      }
      output.factors = factors;
    }
    result.push(output);
  }
  if (result.reduce((sum, item) => sum + item.weight, 0) > 1 + 1e-12) {
    return { value: [], error: "구성종목 비중 합계는 1을 초과할 수 없습니다." };
  }
  return { value: result };
}

export function buildExposureAnalysisRequest(
  assets: ExposureAssetRequestInput[],
  lookThrough: boolean,
  executionMode: "sync" | "async" = "async",
): Record<string, unknown> {
  return {
    assets: assets.map((asset) => ({
      symbol: asset.symbol.trim().toUpperCase(),
      weight: asset.weight,
      currency: asset.currency.trim().toUpperCase(),
      ...(asset.sector?.trim() ? { sector: asset.sector.trim() } : {}),
      ...(asset.industry?.trim() ? { industry: asset.industry.trim() } : {}),
      ...(asset.country?.trim() ? { country: asset.country.trim() } : {}),
      ...(asset.assetType?.trim() ? { assetType: asset.assetType.trim() } : {}),
      ...(asset.hedged !== undefined ? { hedged: asset.hedged } : {}),
      factors: asset.factors,
      constituents: asset.constituents,
    })),
    lookThrough,
    executionMode,
  };
}

function regimePolicyPayload(controls: Pick<OptimizationControls,
  "regimePolicyEnabled" | "regimePolicyMethod" | "baselines"
>) {
  return {
    enabled: controls.regimePolicyEnabled,
    method: controls.regimePolicyMethod,
    baselineActions: controls.baselines,
  };
}

function robustValidationPayload(controls: Pick<OptimizationControls,
  "robustValidationEnabled" | "robustValidationMode" | "robustValidationWindowMode"
  | "robustValidationTestPercent" | "robustValidationTrainWindow" | "robustValidationTestWindow"
  | "robustValidationStep" | "robustValidationFoldCount" | "robustValidationGap"
  | "robustValidationEmbargo"
>) {
  const mode = controls.robustValidationMode ?? "walk_forward";
  const testPercent = Math.min(50, Math.max(5, controls.robustValidationTestPercent ?? 20));
  const gap = Math.max(0, Math.floor(controls.robustValidationGap ?? 0));
  if (mode === "holdout") {
    return {
      enabled: controls.robustValidationEnabled ?? true,
      mode,
      trainFraction: (100 - testPercent) / 100,
      testFraction: testPercent / 100,
      gap,
    };
  }
  return {
    enabled: controls.robustValidationEnabled ?? true,
    mode,
    windowMode: controls.robustValidationWindowMode ?? "rolling",
    trainWindow: Math.max(20, Math.floor(controls.robustValidationTrainWindow ?? 126)),
    testWindow: Math.max(5, Math.floor(controls.robustValidationTestWindow ?? 21)),
    step: Math.max(1, Math.floor(controls.robustValidationStep ?? 21)),
    foldCount: Math.max(2, Math.floor(controls.robustValidationFoldCount ?? 5)),
    gap,
    embargo: Math.max(0, Math.floor(controls.robustValidationEmbargo ?? 0)),
  };
}

export function buildOptimizationRequest(
  baseConfig: BacktestRunConfiguration,
  controls: OptimizationControls,
): Record<string, unknown> {
  const benchmark = controls.benchmark?.trim().toUpperCase();
  return {
    symbols: baseConfig.assets.map((asset) => asset.symbol),
    fromDate: baseConfig.startDate,
    toDate: baseConfig.endDate,
    currencyMode: baseConfig.currencyMode,
    ...(benchmark ? { benchmark } : {}),
    objective: controls.objective,
    minWeight: controls.minWeightPercent / 100,
    maxWeight: controls.maxWeightPercent / 100,
    minWeights: Object.fromEntries(Object.entries(controls.minWeightsPercent)
      .filter(([, value]) => Number.isFinite(value) && value >= 0)
      .map(([symbol, value]) => [symbol, value / 100])),
    maxWeights: Object.fromEntries(Object.entries(controls.maxWeightsPercent)
      .filter(([, value]) => Number.isFinite(value) && value >= 0)
      .map(([symbol, value]) => [symbol, value / 100])),
    maxAssets: controls.maxAssets,
    requiredAssets: controls.requiredAssets,
    excludedAssets: controls.excludedAssets,
    ...(controls.maxDrawdownPercent !== undefined ? { maxDrawdown: optionalPercent(controls.maxDrawdownPercent) } : {}),
    ...(controls.targetReturnPercent !== undefined ? { targetReturn: optionalPercent(controls.targetReturnPercent) } : {}),
    ...(controls.maxTurnoverPercent !== undefined ? { maxTurnover: optionalPercent(controls.maxTurnoverPercent) } : {}),
    currentWeights: normalizedBacktestWeights(baseConfig),
    transactionCostBps: baseConfig.transactionCostBps,
    riskFreeRatePercent: baseConfig.riskFreeRatePercent,
    seed: controls.seed,
    candidateBudget: controls.candidateBudget,
    algorithm: controls.algorithm,
    covarianceEstimator: controls.covarianceEstimator,
    baselines: controls.baselines,
    assetGroups: controls.assetGroups,
    groupConstraints: controls.groupConstraints.map((item) => ({
      dimension: item.dimension,
      group: item.group.trim(),
      minWeight: item.minWeightPercent / 100,
      maxWeight: item.maxWeightPercent / 100,
    })),
    robustScoreWeights: controls.robustScoreWeights,
    robustValidation: robustValidationPayload(controls),
    ledgerValidation: {
      enabled: true,
      budget: controls.ledgerValidationBudget,
      initialAmount: baseConfig.initialAmount,
      rebalanceFrequency: baseConfig.rebalanceFrequency,
      ...(baseConfig.rebalanceFrequency === "threshold" && baseConfig.rebalanceThresholdPercent !== undefined
        ? { rebalanceThresholdPercent: baseConfig.rebalanceThresholdPercent }
        : {}),
      cashTargetPercent: baseConfig.execution.cashTargetPercent,
      quantityMode: controls.ledgerQuantityMode,
      lotSizes: Object.fromEntries(baseConfig.assets.map((asset) => [asset.symbol, asset.lotSize ?? 1])),
    },
    regimePolicySearch: regimePolicyPayload(controls),
  };
}

export function buildWalkForwardRequest(
  optimizationRequest: Record<string, unknown>,
  controls: WalkForwardControls,
): Record<string, unknown> {
  return {
    ...optimizationRequest,
    mode: controls.mode,
    trainWindow: controls.trainWindow,
    testWindow: controls.testWindow,
    step: controls.step,
    gap: controls.gap,
    embargo: controls.embargo,
    foldCandidateBudget: controls.foldCandidateBudget,
    seeds: walkForwardSeeds(controls.seed, controls.additionalSeeds),
  };
}

export function buildOutlookOptimizationPayload(
  controls: Pick<OptimizationControls,
    "objective" | "benchmark" | "candidateBudget" | "minWeightPercent" | "maxWeightPercent" | "algorithm"
    | "covarianceEstimator" | "ledgerValidationBudget" | "regimePolicyEnabled" | "regimePolicyMethod" | "baselines"
    | "assetGroups" | "groupConstraints" | "robustScoreWeights"
    | "robustValidationEnabled" | "robustValidationMode" | "robustValidationWindowMode"
    | "robustValidationTestPercent" | "robustValidationTrainWindow" | "robustValidationTestWindow"
    | "robustValidationStep" | "robustValidationFoldCount" | "robustValidationGap"
    | "robustValidationEmbargo"
  > & { enabled: boolean },
): Record<string, unknown> {
  const benchmark = controls.benchmark?.trim().toUpperCase();
  return {
    enabled: controls.enabled,
    ...(benchmark ? { benchmark } : {}),
    objective: controls.objective,
    algorithm: controls.algorithm,
    covarianceEstimator: controls.covarianceEstimator,
    candidateBudget: Math.max(10, controls.candidateBudget),
    ledgerValidationBudget: controls.ledgerValidationBudget,
    minWeight: controls.minWeightPercent / 100,
    maxWeight: controls.maxWeightPercent / 100,
    groupConstraints: controls.groupConstraints.map((item) => ({
      dimension: item.dimension,
      group: item.group.trim(),
      minWeight: item.minWeightPercent / 100,
      maxWeight: item.maxWeightPercent / 100,
    })),
    assetGroups: controls.assetGroups,
    baselines: controls.baselines,
    robustScoreWeights: controls.robustScoreWeights,
    robustValidation: robustValidationPayload(controls),
    regimePolicySearch: regimePolicyPayload({
      ...controls,
      regimePolicyEnabled: controls.enabled && controls.regimePolicyEnabled,
    }),
  };
}

export function buildWalkForwardPayload(controls: WalkForwardControls): Record<string, unknown> {
  return {
    mode: controls.mode,
    trainWindow: controls.trainWindow,
    testWindow: controls.testWindow,
    step: controls.step,
    gap: controls.gap,
    embargo: controls.embargo,
    foldCandidateBudget: controls.foldCandidateBudget,
    seeds: walkForwardSeeds(controls.seed, controls.additionalSeeds),
  };
}

function monteCarloPolicyPayload(controls: MonteCarloControls): Record<string, unknown> {
  return {
    method: controls.method,
    horizonDays: controls.horizonDays,
    pathCount: controls.pathCount,
    blockLength: controls.blockLength,
    seed: controls.seed,
    ...(controls.goalAmount !== undefined && Number.isFinite(controls.goalAmount) ? { goalAmount: controls.goalAmount } : {}),
    quantiles: controls.quantiles,
    samplePathCount: controls.samplePathCount,
    rebalanceFrequency: controls.rebalanceFrequency,
    ...(controls.rebalanceFrequency === "threshold" && controls.rebalanceThresholdPercent !== undefined
      ? { rebalanceThresholdPercent: controls.rebalanceThresholdPercent }
      : {}),
    cashWeight: controls.cashWeightPercent / 100,
    cashAnnualYieldPercent: controls.cashAnnualYieldPercent,
    transactionCostBps: controls.transactionCostBps,
    periodicCashFlow: controls.periodicCashFlow,
    cashFlowFrequencyDays: controls.cashFlowFrequencyDays,
    inflationAnnualPercent: controls.inflationAnnualPercent,
    quantityMode: controls.quantityMode,
    lotSizes: controls.lotSizes,
    calibrationOrigins: controls.calibrationOrigins,
  };
}

export function buildMonteCarloRequest(
  baseConfig: BacktestRunConfiguration,
  controls: MonteCarloControls,
): Record<string, unknown> {
  return {
    symbols: baseConfig.assets.map((asset) => asset.symbol),
    weights: normalizedBacktestWeights(baseConfig),
    fromDate: baseConfig.startDate,
    toDate: baseConfig.endDate,
    currencyMode: baseConfig.currencyMode,
    initialAmount: baseConfig.initialAmount,
    ...monteCarloPolicyPayload(controls),
  };
}

export function buildOutlookMonteCarloPayload(controls: MonteCarloControls): Record<string, unknown> {
  return monteCarloPolicyPayload(controls);
}

export function withQuantityMode(
  baseConfig: BacktestRunConfiguration,
  quantityMode: BacktestQuantityMode,
): BacktestRunConfiguration {
  return {
    ...baseConfig,
    execution: { ...baseConfig.execution, quantityMode },
  };
}
