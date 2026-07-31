import type { PriceSeriesInput, ReturnSeriesInput } from "../services/quant-math.js";

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
  cagr: number | null;
  totalReturn: number | null;
  sharpe: number | null;
  sortino: number | null;
  calmar: number | null;
  volatility: number | null;
  cvar: number | null;
  informationRatio: number | null;
  robustScore: number | null;
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
