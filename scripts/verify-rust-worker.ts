import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { simulateBacktest, type BacktestSimulationInput } from "../server/backtest-engine.js";
import { optimizePortfolio } from "../server/services/optimization-service.js";
import { PORTFOLIO_ENGINE_VERSION } from "../server/services/service-envelope.js";
import {
  canonicalJson,
  WORKER_PAYLOAD_SCHEMA_VERSION,
  WorkerOutputSchema,
  type WorkerInput,
} from "../server/worker/contracts.js";
import { buildSyntheticFixture } from "./benchmark-compute.js";

const binary = fileURLToPath(new URL("../worker/rust/target/release/portfolio-lens-worker", import.meta.url));

function serializable(input: BacktestSimulationInput): Record<string, unknown> {
  return JSON.parse(JSON.stringify({ ...input, prices: Object.fromEntries(input.prices) })) as Record<string, unknown>;
}

type RustCommand = "backtest-json" | "optimize-json" | "monte-carlo-json" | "compute-json";

function rust(
  command: RustCommand,
  input: unknown,
  jobKind?: WorkerInput["job_kind"],
): { value: any; processMs: number } {
  const started = performance.now();
  const args = command === "compute-json" ? [command, assertJobKind(jobKind)] : [command];
  const child = spawnSync(binary, args, {
    input: JSON.stringify(input), encoding: "utf8", maxBuffer: 256 * 1024 * 1024,
  });
  const processMs = performance.now() - started;
  if (child.status !== 0) throw new Error(`Rust ${command} failed: ${child.stderr || child.stdout}`);
  return { value: JSON.parse(child.stdout), processMs };
}

function assertJobKind(value: WorkerInput["job_kind"] | undefined): WorkerInput["job_kind"] {
  assert(value, "compute-json requires a job kind");
  return value;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function closeTo(left: number, right: number, tolerance: number, message: string): void {
  assert(Math.abs(left - right) <= tolerance, `${message}: ${left} != ${right}`);
}

function probability(value: unknown, message: string): void {
  assert(typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100, message);
}

type Difference = { compared: number; maxAbsolute: number; maxRelative: number };
function compare(left: unknown, right: unknown, path: string, difference: Difference, absoluteTolerance = 1e-7, relativeTolerance = 1e-9): void {
  if (typeof left === "number" && typeof right === "number") {
    const absolute = Math.abs(left - right);
    const relative = absolute / Math.max(Math.abs(left), Math.abs(right), Number.MIN_VALUE);
    difference.compared += 1;
    difference.maxAbsolute = Math.max(difference.maxAbsolute, absolute);
    difference.maxRelative = Math.max(difference.maxRelative, relative);
    if (absolute > absoluteTolerance && relative > relativeTolerance) throw new Error(`${path}: ${left} != ${right} (abs=${absolute}, rel=${relative})`);
    return;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    assert(Array.isArray(left) && Array.isArray(right), `${path}: array type mismatch`);
    assert.equal(left.length, right.length, `${path}: array length mismatch`);
    left.forEach((item, index) => compare(item, right[index], `${path}[${index}]`, difference, absoluteTolerance, relativeTolerance));
    return;
  }
  if (left && right && typeof left === "object" && typeof right === "object") {
    const leftObject = left as Record<string, unknown>;
    const rightObject = right as Record<string, unknown>;
    assert.deepEqual(Object.keys(leftObject).sort(), Object.keys(rightObject).sort(), `${path}: keys mismatch`);
    for (const key of Object.keys(leftObject)) compare(leftObject[key], rightObject[key], `${path}.${key}`, difference, absoluteTolerance, relativeTolerance);
    return;
  }
  assert.equal(left, right, `${path}: value mismatch`);
}

function legacyBacktestProjection(value: any) {
  const comparable = [
    "totalReturnPercent", "cagrPercent", "annualizedVolatilityPercent", "maxDrawdownPercent", "maxDrawdownDays",
    "sharpeRatio", "sortinoRatio", "calmarRatio", "bestDailyReturnPercent", "worstDailyReturnPercent",
    "positiveDaysPercent", "bestYearPercent", "worstYearPercent", "positiveMonthsPercent", "finalBalance",
    "totalContributions", "totalWithdrawals",
  ];
  const contribution = [
    "symbol", "name", "market", "currency", "weight", "endingValue", "profitLoss", "contributionPercent",
    "timeLinkedContributionPercent", "localPriceContributionPercent", "fxContributionPercent",
    "upRegimeContributionPercent", "downRegimeContributionPercent", "assetReturnPercent",
  ];
  const dataQuality = [
    "alignmentPolicy", "commonReturnPolicy", "alignedValuationDays", "commonReturnObservations",
    "carryForwardByAsset", "benchmarkCarryForwardCount",
  ];
  return {
    requestedStartDate: value.requestedStartDate,
    effectiveStartDate: value.effectiveStartDate,
    endDate: value.endDate,
    points: value.points.map((point: any) => ({
      date: point.date, balance: point.balance, growth: point.growth,
      ...(point.benchmarkGrowth !== undefined ? { benchmarkGrowth: point.benchmarkGrowth } : {}),
      drawdownPercent: point.drawdownPercent,
    })),
    metrics: Object.fromEntries(comparable.map((key) => [key, value.metrics[key]])),
    benchmarkMetrics: value.benchmarkMetrics
      ? Object.fromEntries(comparable.filter((key) => !["finalBalance", "totalContributions", "totalWithdrawals"].includes(key)).map((key) => [key, value.benchmarkMetrics[key]]))
      : undefined,
    annualReturns: value.annualReturns,
    contributions: value.contributions.map((item: any) => Object.fromEntries(contribution.map((key) => [key, item[key]]))),
    correlations: value.correlations,
    // The Node fallback intentionally exposes only the legacy price-alignment quality
    // contract. Rust appends provider/realism quality fields, so golden parity must keep
    // comparing the common surface while the extended fields are asserted separately.
    dataQuality: Object.fromEntries(dataQuality.map((key) => [key, value.dataQuality[key]])),
  };
}

function legacyOptimizationCandidateProjection(value: any): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  const metrics = [
    "sharpe", "sortino", "calmar", "volatility", "cvar", "informationRatio", "robustScore",
    "return", "maxDrawdown", "turnover", "transactionCost",
  ];
  return {
    weights: value.weights,
    sampleCount: value.sampleCount,
    metrics: Object.fromEntries(metrics.map((key) => [key, value.metrics[key]])),
    walkForwardTestCoverage: value.walkForwardTestCoverage,
    walkForwardSignal: value.walkForwardSignal,
  };
}

function legacyOptimizationProjection(value: any) {
  return {
    warnings: value.warnings,
    seed: value.seed,
    sampledAssets: value.sampledAssets,
    candidateCount: value.candidateCount,
    candidates: value.candidates.map(legacyOptimizationCandidateProjection),
    paretoFrontier: value.paretoFrontier.map(legacyOptimizationCandidateProjection),
    bestByObjective: Object.fromEntries(Object.entries(value.bestByObjective)
      .map(([key, candidate]) => [key, legacyOptimizationCandidateProjection(candidate)])),
    futureLeakageWarning: value.futureLeakageWarning,
  };
}

function assertBacktestLedger(value: any, quantityMode: "fractional" | "whole"): void {
  assert(value.points.length > 0, "backtest ledger must contain valuation points");
  for (const point of value.points) {
    assert(point.cashBalance >= -0.011, `cash balance became negative on ${point.date}`);
    closeTo(point.balance, point.cashBalance + point.investedBalance, 0.011, `point ledger conservation on ${point.date}`);
  }
  closeTo(
    value.metrics.finalBalance,
    value.metrics.endingCashBalance + value.metrics.investedBalance,
    0.011,
    "terminal ledger conservation",
  );
  const tradeCosts = value.trades.reduce((sum: number, trade: any) => sum + trade.transactionCost, 0);
  // Each public trade is rounded independently while the aggregate metric preserves the
  // unrounded ledger total, so the admissible display-rounding error grows with trade count.
  closeTo(tradeCosts, value.metrics.totalTransactionCosts, Math.max(0.011, value.trades.length * 0.011), "trade cost ledger total");
  for (const trade of value.trades) {
    assert(trade.amount >= 0 && trade.transactionCost >= 0, "trade notionals and costs must be non-negative");
    closeTo(
      trade.transactionCost,
      trade.commission + trade.tax + trade.slippageCost + trade.marketImpactCost,
      0.011,
      `trade cost components for ${trade.symbol} on ${trade.date}`,
    );
    if (quantityMode === "whole") {
      closeTo(trade.quantity / trade.lotSize, Math.round(trade.quantity / trade.lotSize), 1e-9, "whole-lot quantity");
    }
  }
}

function workerInput(
  jobKind: WorkerInput["job_kind"],
  payload: Record<string, unknown>,
  dataRevision = "synthetic-revision-a",
): WorkerInput {
  return {
    schema_version: WORKER_PAYLOAD_SCHEMA_VERSION,
    engine_version: PORTFOLIO_ENGINE_VERSION,
    run_id: "golden-reproducibility-run",
    job_kind: jobKind,
    data_revision: dataRevision,
    request_hash: sha256(payload),
    payload,
  };
}

function assertWalkForwardContract(value: any, expectedMode: "rolling" | "anchored"): void {
  assert.equal(value.configuration.mode, expectedMode);
  assert(value.folds.length > 1, "walk-forward must produce multiple OOS folds");
  assert(value.oosSummary.coverage > 0 && value.oosSummary.coverage <= 1, "OOS coverage must be unique and capped");
  assert.equal(value.oosSummary.coveredObservationCount, value.stitchedOosEquity.length);
  assert.equal(new Set(value.stitchedOosEquity.map((point: any) => point.date)).size, value.stitchedOosEquity.length);
  assert(Number.isFinite(value.oosSummary.cagr));
  assert(Number.isFinite(value.oosSummary.maxDrawdown));
  assert(value.oosSummary.sharpe === null || Number.isFinite(value.oosSummary.sharpe));
  assert(value.oosSummary.informationRatio === null || Number.isFinite(value.oosSummary.informationRatio));
  assert(value.oosSummary.benchmarkWinRate === null
    || (value.oosSummary.benchmarkWinRate >= 0 && value.oosSummary.benchmarkWinRate <= 1));
  assert.equal(value.seedStability.deterministic, true);
  assert(value.seedStability.seedCount >= 1);
  for (const [index, fold] of value.folds.entries()) {
    assert(fold.trainEndIndex + fold.gap < fold.testStartIndex, `fold ${index} violates the purge gap`);
    assert(fold.trainEndIndex < fold.testStartIndex, `fold ${index} trains on OOS observations`);
    assert.equal(fold.seedRuns.reduce((sum: number, run: any) => sum + run.candidateBudget, 0), fold.foldCandidateBudget);
    assert(fold.seedRuns.every((run: any) => run.effectiveSeed >= run.configuredSeed));
    if (expectedMode === "anchored") assert.equal(fold.trainStartIndex, 0);
    if (index > 0) {
      assert(value.folds[index - 1].testEndIndex < fold.testStartIndex, `fold ${index} overlaps prior OOS data`);
    }
  }
}

const fixture = buildSyntheticFixture(420);
fixture.backtest.transactionCostBps = 0;
const nodeBacktestStarted = performance.now();
const nodeBacktest = simulateBacktest(fixture.backtest);
const nodeBacktestMs = performance.now() - nodeBacktestStarted;
const rustBacktest = rust("backtest-json", serializable(fixture.backtest));
const backtestDifference: Difference = { compared: 0, maxAbsolute: 0, maxRelative: 0 };
compare(legacyBacktestProjection(nodeBacktest), legacyBacktestProjection(rustBacktest.value), "$backtest", backtestDifference);

fixture.optimization.candidateBudget = 120;
// Baseline injection is a Rust v2 contract. Disable it only for the legacy random-search
// golden so both implementations visit the exact same seeded candidate stream.
fixture.optimization.baselines = [];
const nodeOptimizationStarted = performance.now();
const nodeOptimization = optimizePortfolio(fixture.optimization);
const nodeOptimizationMs = performance.now() - nodeOptimizationStarted;
const rustOptimization = rust("optimize-json", fixture.optimization);
const optimizationDifference: Difference = { compared: 0, maxAbsolute: 0, maxRelative: 0 };
compare(
  legacyOptimizationProjection(nodeOptimization),
  legacyOptimizationProjection(rustOptimization.value),
  "$optimization",
  optimizationDifference,
  1e-8,
  1e-9,
);

const featureInput = {
  assets: [{ symbol: "AAA", name: "AAA", market: "KRX", currency: "KRW", listDate: "2024-01-02", weight: 80, lotSize: 1 }],
  prices: { "KRW:AAA": [
    { date: "2024-01-02", close: 300, localClose: 300, fxRate: 1 },
    { date: "2024-01-03", close: 330, localClose: 330, fxRate: 1 },
    { date: "2024-01-04", close: 330, localClose: 330, fxRate: 1 },
  ] },
  requestedStartDate: "2024-01-02", endDate: "2024-01-04", initialAmount: 1_000,
  monthlyCashFlow: 0, rebalanceFrequency: "threshold", rebalanceThresholdPercent: 1,
  transactionCostBps: 100,
  cashFlows: [{ date: "2024-01-03", amount: 100, memo: "deposit" }],
  execution: { cashTargetPercent: 20, quantityMode: "whole", cashFlowRebalanceMode: "drift_reduction", tradeDatePolicy: "next_common_observation", cashAnnualYieldPercent: 0 },
};
const feature = rust("backtest-json", featureInput).value;
assert.equal(feature.points[0].balance, 994);
assert.equal(feature.trades[0].quantity, 2);
assert.equal(feature.trades[0].transactionCost, 6);
assert.equal(feature.points[0].cashBalance, 394);
assert.equal(feature.cashFlows[0].scheduledDate, "2024-01-03");
assert.equal(feature.cashFlows[0].effectiveDate, "2024-01-03");
assert(feature.metrics.totalTransactionCosts >= 6);
assert(Number.isFinite(feature.metrics.moneyWeightedReturnPercent));
assertBacktestLedger(feature, "whole");
for (const key of [
  "dividendStatus", "liquidityStatus", "liquidityTradeObservations", "missingLiquidityObservations",
  "pointInTimeUniverseStatus", "warnings",
]) {
  assert(Object.hasOwn(feature.dataQuality, key), `extended Rust data-quality field is missing: ${key}`);
}
assert(Array.isArray(feature.dataQuality.warnings));

// Exercise the execution ledger over multiple deterministic schedules/cost surfaces. This
// intentionally behaves like a small property suite rather than pinning a single fixture.
const ledgerPropertyCases = Array.from({ length: 4 }, (_, caseIndex) => {
  const dates = Array.from({ length: 24 }, (_, index) => (
    new Date(Date.UTC(2024, 0, 2 + index)).toISOString().slice(0, 10)
  ));
  const pricePoints = (symbolIndex: number) => dates.map((date, index) => {
    const close = 100 + symbolIndex * 70 + index * (1.2 + caseIndex * 0.1)
      + Math.sin(index / (2.5 + symbolIndex) + caseIndex) * (3 + symbolIndex);
    return {
      date,
      close,
      localClose: close,
      fxRate: 1,
      volume: 500_000 + index * 1_000,
      ...(symbolIndex === 0 && index === 15 ? { cashDividend: 0.75 } : {}),
    };
  });
  return {
    assets: [
      { symbol: "AAA", name: "AAA", market: "KRX", currency: "KRW", listDate: dates[0], weight: 45, lotSize: 2, universeMemberFrom: dates[0], universeMemberTo: dates.at(-1) },
      { symbol: "BBB", name: "BBB", market: "KRX", currency: "KRW", listDate: dates[0], weight: 45, lotSize: 5, universeMemberFrom: dates[0], universeMemberTo: dates.at(-1) },
    ],
    prices: { "KRW:AAA": pricePoints(0), "KRW:BBB": pricePoints(1) },
    requestedStartDate: dates[0],
    endDate: dates.at(-1),
    initialAmount: 1_000_000 + caseIndex * 250_000,
    monthlyCashFlow: 0,
    rebalanceFrequency: caseIndex % 2 === 0 ? "threshold" : "monthly",
    rebalanceThresholdPercent: 2 + caseIndex,
    transactionCostBps: 5 + caseIndex,
    cashFlows: [
      { date: dates[5], amount: 5_000 + caseIndex * 500, memo: "property deposit" },
      { date: dates[12], amount: -(2_000 + caseIndex * 250), memo: "property withdrawal" },
    ],
    targetWeightSchedule: [{
      date: dates[8],
      weights: { AAA: 55 - caseIndex, BBB: 35 + caseIndex },
      cashTargetPercent: 10,
      regime: caseIndex % 2 === 0 ? "risk_on" : "risk_off",
      action: "scheduled_property_rebalance",
    }],
    execution: {
      cashTargetPercent: 10,
      quantityMode: "whole",
      cashFlowRebalanceMode: caseIndex % 2 === 0 ? "drift_reduction" : "target_weights",
      tradeDatePolicy: "next_common_observation",
      cashAnnualYieldPercent: 2,
    },
    realism: {
      costs: {
        commissionBps: 3 + caseIndex,
        sellTaxBps: 2,
        fixedSlippageBps: 1,
        marketImpactCoefficient: 0.002,
        marketImpactExponent: 0.5,
        maxParticipationRatePercent: 20,
        minimumFee: 1,
        dividendTaxBps: 1500,
      },
      dividendMode: "cash",
      enforcePointInTimeUniverse: true,
    },
  };
});
const ledgerPropertyResults = ledgerPropertyCases.map((input) => rust("backtest-json", input).value);
for (const result of ledgerPropertyResults) {
  assertBacktestLedger(result, "whole");
  assert.equal(result.targetWeightSchedule.length, 1);
  assert.equal(result.targetWeightSchedule[0].effectiveDate, result.targetWeightSchedule[0].scheduledDate);
  assert(result.metrics.totalDividendIncome > 0);
  assert(result.metrics.totalDividendTaxes > 0);
  assert.equal(result.dataQuality.liquidityStatus, "provider_supplied");
}
const nodeScheduleInput = {
  ...ledgerPropertyCases[0],
  prices: new Map(Object.entries(ledgerPropertyCases[0].prices)),
} as unknown as BacktestSimulationInput;
assert.throws(() => simulateBacktest(nodeScheduleInput), /Rust worker/);

const baselineNames = [
  "equal_weight", "current_weight", "inverse_volatility", "minimum_variance", "risk_parity", "hrp", "herc",
] as const;
const assetGroups = Object.fromEntries(fixture.optimization.priceSeries.map((item, index) => [item.key, {
  sector: index % 2 === 0 ? "growth" : "defensive",
  industry: `industry-${index % 3}`,
  country: item.key.startsWith("KR") ? "KR" : "US",
  currency: item.key.startsWith("KR") ? "KRW" : "USD",
  assetType: "equity",
}]));
const ledgerTemplate = serializable({
  ...fixture.backtest,
  initialAmount: 10_000_000,
  monthlyCashFlow: 0,
  transactionCostBps: 10,
  benchmark: undefined,
  execution: {
    cashTargetPercent: 5,
    quantityMode: "fractional",
    cashFlowRebalanceMode: "target_weights",
    tradeDatePolicy: "next_common_observation",
    cashAnnualYieldPercent: 1,
  },
});
const advancedOptimizationInput = {
  ...fixture.optimization,
  candidateBudget: 36,
  minimumSamples: 20,
  seed: 918_273,
  algorithm: "nsga_ii",
  covarianceEstimator: "ledoit_wolf",
  baselines: [...baselineNames],
  assetGroups,
  groupConstraints: [
    { dimension: "sector", group: "growth", minWeight: 0.15, maxWeight: 0.75 },
    { dimension: "country", group: "KR", minWeight: 0.10, maxWeight: 0.80 },
  ],
  robustScoreWeights: { inSampleSharpe: 0.2, oosAverageSharpe: 0.2, oosWorstSharpe: 0.2 },
  walkForwardConfig: {
    trainWindow: 252, testWindow: 42, step: 42,
    minimumTrainObservations: 60, minimumTestObservations: 20,
  },
  ledgerTemplate,
  ledgerValidationBudget: 5,
  regimePolicySearch: {
    enabled: true,
    method: "mcts",
    states: ["risk_off", "neutral", "risk_on"],
    baselineActions: ["equal_weight", "inverse_volatility", "risk_parity"],
    lookback: 42,
    rebalanceEvery: 21,
    trainFraction: 0.6,
    minimumTrainingDecisions: 6,
    maxDepth: 6,
    rollouts: 64,
    explorationConstant: Math.SQRT2,
    discount: 0.98,
    switchingCostBps: 5,
    ledgerValidationBudget: 2,
  },
};
const advancedOptimization = rust("optimize-json", advancedOptimizationInput);
const repeatedAdvancedOptimization = rust("optimize-json", advancedOptimizationInput);
assert.deepEqual(advancedOptimization.value, repeatedAdvancedOptimization.value);
const advanced = advancedOptimization.value;
assert.equal(advanced.algorithm, "nsga_ii");
assert.equal(advanced.algorithmDetails.deterministic, true);
assert.equal(advanced.covarianceEstimator, "ledoit_wolf");
assert.deepEqual(advanced.baselines, baselineNames);
assert.equal(advanced.screeningCandidateCount, advanced.candidateCount);
assert(advanced.baselineCandidateCount > 0 && advanced.baselineCandidateCount <= baselineNames.length);
assert.equal(advanced.paretoComputation, "typed_incremental_with_exact_missing_metric_fallback");
assert(advanced.paretoFrontier.length <= advanced.candidates.length);
assert.equal(advanced.ledgerValidation.selectedCount, 5);
assert.equal(advanced.ledgerValidation.completedCount + advanced.ledgerValidation.failedCount, 5);
assert.equal(advanced.ledgerValidatedCandidates.length, advanced.ledgerValidation.completedCount);
assert.equal(advanced.ledgerValidation.selectionPolicy, "pareto_then_screening_rank");
const robustDetail = advanced.candidates[0].robustScoreDetail;
assert(Number.isFinite(robustDetail.inSampleScore));
assert(Number.isFinite(robustDetail.outOfSampleScore));
assert(robustDetail.coverage > 0 && robustDetail.coverage <= 1);
assert.equal(robustDetail.components.length, 9);
closeTo(Object.values(robustDetail.weights).reduce((sum: number, value: any) => sum + value, 0), 1, 1e-12, "robust-score weight normalization");
closeTo(robustDetail.score, advanced.candidates[0].metrics.robustScore, 1e-12, "robust-score detail total");
for (const candidate of advanced.candidates) {
  closeTo(Object.values(candidate.weights).reduce((sum: number, value: any) => sum + value, 0), 1, 1e-8, "candidate weight sum");
  const growthWeight = Object.entries(candidate.weights)
    .filter(([key]) => assetGroups[key].sector === "growth")
    .reduce((sum, [, value]) => sum + Number(value), 0);
  assert(growthWeight >= 0.15 - 1e-8 && growthWeight <= 0.75 + 1e-8, "sector group constraint");
}
for (const candidate of advanced.ledgerValidatedCandidates) {
  assert.equal(candidate.validationStatus, "completed");
  assert(Number.isInteger(candidate.screeningRank) && Number.isInteger(candidate.ledgerRank));
  assert(Number.isInteger(candidate.rankChange));
  assert(candidate.screeningMetrics && candidate.ledgerMetrics && candidate.metricDelta);
}
const regimePolicy = advanced.regimePolicySearch;
assert.equal(regimePolicy.enabled, true);
assert.equal(regimePolicy.status, "completed");
assert.equal(regimePolicy.requestedMethod, "mcts");
assert.equal(regimePolicy.effectiveMethod, "mcts");
assert.equal(regimePolicy.implementation, "uct_tree_search_empirical_markov_model");
assert.equal(regimePolicy.deterministic, true);
assert.equal(regimePolicy.noLookahead.policyFrozenForOos, true);
assert(regimePolicy.oosCoverage > 0 && regimePolicy.oosCoverage <= 1);
assert(regimePolicy.trainingDecisionCount >= 6 && regimePolicy.oosDecisionCount > 0);
assert.equal(regimePolicy.ledgerValidation.selectedCount, 2);
assert.equal(regimePolicy.ledgerValidation.completedCount, 2);
assert(regimePolicy.policies.some((policy: any) => policy.id.startsWith("adaptive:")));
assert(Array.isArray(advanced.regimePolicyArtifact) && advanced.regimePolicyArtifact.length > 0);
for (const policy of advanced.regimePolicyArtifact) {
  for (const decision of policy.oosDecisionTrace) {
    assert(decision.signalCutoffDate < decision.date, "regime policy consumed a same/future-date signal");
  }
}
const optimizationWorkerOutput = WorkerOutputSchema.parse(rust(
  "compute-json",
  workerInput("optimization", { optimization: advancedOptimizationInput, objective: "robust_score" }),
  "optimization",
).value);
assert.equal((optimizationWorkerOutput.result as any).regimePolicyArtifact, undefined);
assert(optimizationWorkerOutput.artifacts?.some((artifact) => artifact.type === "regime-policy"));
const optimizerAlgorithms = ["random_search", "differential_evolution", "cma_es", "nsga_ii", "direct_cvar"] as const;
const optimizerMethodTimings: Record<string, number> = {};
for (const algorithm of optimizerAlgorithms) {
  const result = algorithm === "nsga_ii"
    ? advancedOptimization
    : rust("optimize-json", {
      ...fixture.optimization,
      algorithm,
      covarianceEstimator: "ledoit_wolf",
      candidateBudget: 20,
      baselines: [],
      ledgerTemplate: undefined,
      ledgerValidationBudget: 3,
    });
  assert.equal(result.value.algorithm, algorithm);
  assert.equal(result.value.algorithmDetails.deterministic, true);
  assert(result.value.candidateCount > 0);
  optimizerMethodTimings[algorithm] = result.processMs;
}

const monteInput = {
  priceSeries: fixture.optimization.priceSeries,
  weights: Object.fromEntries(fixture.optimization.priceSeries.map((item) => [item.key, 1 / fixture.optimization.priceSeries.length])),
  initialAmount: 100_000_000, horizonDays: 252, pathCount: 2_000, blockLength: 20,
  seed: 88_001, goalAmount: 120_000_000, quantiles: [0.05, 0.5, 0.95], samplePathCount: 3,
};
const monteFirst = rust("monte-carlo-json", monteInput);
const monteSecond = rust("monte-carlo-json", monteInput);
assert.deepEqual(monteFirst.value, monteSecond.value);
assert.equal(monteFirst.value.method, "correlated_moving_block_bootstrap");
assert.equal(monteFirst.value.pathCount, 2_000);

const monteMethods = {
  moving_block: "correlated_moving_block_bootstrap",
  stationary: "correlated_stationary_bootstrap",
  regime_conditioned: "correlated_regime_conditioned_bootstrap",
  student_t: "fitted_multivariate_student_t",
} as const;
const monteMethodResults: Record<string, { processMs: number; result: any }> = {};
for (const [method, expectedLabel] of Object.entries(monteMethods)) {
  const input = {
    ...monteInput,
    method,
    initialAmount: 10_000_000,
    horizonDays: 84,
    pathCount: 300,
    blockLength: 12,
    seed: 42_000 + method.length,
    goalAmount: 12_000_000,
    quantiles: [0.05, 0.5, 0.95],
    samplePathCount: 2,
    cashWeight: 0.15,
    cashAnnualYieldPercent: 2,
    transactionCostBps: 12,
    periodicCashFlow: -3_000_000,
    cashFlowFrequencyDays: 21,
    inflationAnnualPercent: 3,
    rebalanceFrequency: "monthly",
    quantityMode: "whole",
    lotSizes: Object.fromEntries(fixture.optimization.priceSeries.map((item, index) => [item.key, index % 2 === 0 ? 2 : 5])),
    calibrationOrigins: 2,
  };
  const first = rust("monte-carlo-json", input);
  const second = rust("monte-carlo-json", input);
  assert.deepEqual(first.value, second.value, `${method} must be seed deterministic`);
  const result = first.value;
  assert.equal(result.method, expectedLabel);
  assert.equal(result.ledger.quantityMode, "whole");
  assert(result.ledger.maximumConservationError <= 1e-6);
  closeTo(
    result.ledger.terminalCash.mean + result.ledger.terminalInvested.mean,
    result.distributions.terminalBalance.mean,
    1e-6,
    `${method} terminal cash/invested conservation`,
  );
  assert(result.ledger.withdrawals.mean > 0);
  assert(result.ledger.transactionCosts.mean >= 0);
  probability(result.probabilities.terminalLossProbabilityPercent, `${method} loss probability`);
  probability(result.probabilities.terminalGoalProbabilityPercent, `${method} goal probability`);
  probability(result.probabilities.everDepletedProbabilityPercent, `${method} depletion probability`);
  assert.equal(result.calibration.status, "available");
  assert.equal(result.calibration.evaluatedOrigins, 2);
  probability(result.calibration.coveragePercent, `${method} calibration coverage`);
  assert(Number.isFinite(result.calibration.biasPercent));
  assert(result.calibration.observations.every((item: any) => item.originDate < item.targetDate));
  assert.equal(result.percentilePaths.length, 3);
  assert.equal(result.samplePaths.length, 2);
  monteMethodResults[method] = { processMs: first.processMs, result };
}

const reproducibilityPayload = { monte_carlo: {
  ...monteInput,
  horizonDays: 63,
  pathCount: 400,
  blockLength: 10,
  samplePathCount: 2,
  calibrationOrigins: 1,
} };
const reproducibilityInput = workerInput("monte_carlo", reproducibilityPayload);
const reproducibilityFirst = WorkerOutputSchema.parse(rust("compute-json", reproducibilityInput, "monte_carlo").value);
const reproducibilitySecond = WorkerOutputSchema.parse(rust("compute-json", reproducibilityInput, "monte_carlo").value);
assert.deepEqual(reproducibilityFirst, reproducibilitySecond);
const revisionChanged = WorkerOutputSchema.parse(rust(
  "compute-json",
  workerInput("monte_carlo", reproducibilityPayload, "synthetic-revision-b"),
  "monte_carlo",
).value);
assert.deepEqual(reproducibilityFirst.result, revisionChanged.result);
assert.deepEqual(reproducibilityFirst.summary, revisionChanged.summary);
assert.deepEqual(reproducibilityFirst.artifacts, revisionChanged.artifacts);
assert.equal(reproducibilityFirst.payload_hash, revisionChanged.payload_hash);
assert.notEqual(reproducibilityFirst.data_revision, revisionChanged.data_revision);
const seedChangedPayload = clone(reproducibilityPayload);
seedChangedPayload.monte_carlo.seed += 1;
const seedChanged = WorkerOutputSchema.parse(rust(
  "compute-json",
  workerInput("monte_carlo", seedChangedPayload),
  "monte_carlo",
).value);
assert.notDeepEqual(reproducibilityFirst.result, seedChanged.result);
assert.notEqual(reproducibilityFirst.payload_hash, seedChanged.payload_hash);

const benchmarkPrices = {
  key: "SYNTH",
  label: "Synthetic benchmark",
  points: fixture.backtest.benchmark!.prices.map((point) => ({ date: point.date, value: point.close })),
};
const walkForwardPayload = {
  optimization: {
    ...fixture.optimization,
    benchmark: benchmarkPrices,
    candidateBudget: 72,
    seed: 7_777,
    baselines: [],
    algorithm: "random_search",
    covarianceEstimator: "ledoit_wolf",
    ledgerTemplate: undefined,
  },
  objective: "max_sharpe",
  walkForwardConfig: {
    mode: "rolling",
    trainWindow: 120,
    testWindow: 40,
    step: 40,
    gap: 5,
    embargo: 5,
    minimumTrainObservations: 80,
    minimumTestObservations: 20,
    foldCandidateBudget: 12,
    seeds: [101, 202],
  },
};
const rollingOutput = WorkerOutputSchema.parse(rust("compute-json", walkForwardPayload, "walk_forward").value);
const rollingRepeated = WorkerOutputSchema.parse(rust("compute-json", walkForwardPayload, "walk_forward").value);
assert.deepEqual(rollingOutput, rollingRepeated);
const rolling = rollingOutput.result as any;
assertWalkForwardContract(rolling, "rolling");
const anchoredPayload = clone(walkForwardPayload);
anchoredPayload.walkForwardConfig.mode = "anchored";
const anchoredOutput = WorkerOutputSchema.parse(rust("compute-json", anchoredPayload, "walk_forward").value);
assertWalkForwardContract(anchoredOutput.result, "anchored");

// Change only the first fold's first OOS price. Training selection must remain byte-for-byte
// identical while realized OOS performance changes, which catches common look-ahead bugs.
const leakageProbePayload = clone(walkForwardPayload);
const firstFold = rolling.folds[0];
const selectedAsset = Object.entries(firstFold.weights)
  .sort((left: any, right: any) => right[1] - left[1])[0]![0];
const selectedSeries = leakageProbePayload.optimization.priceSeries.find((item) => item.key === selectedAsset)!;
selectedSeries.points[firstFold.testStartIndex + 1]!.value *= 1.35;
const leakageProbe = WorkerOutputSchema.parse(rust("compute-json", leakageProbePayload, "walk_forward").value).result as any;
assert.deepEqual(leakageProbe.folds[0].weights, firstFold.weights);
assert.equal(leakageProbe.folds[0].selectedSeed, firstFold.selectedSeed);
assert.deepEqual(leakageProbe.folds[0].selected, firstFold.selected);
assert.notEqual(leakageProbe.folds[0].oos.return, firstFold.oos.return);

process.stdout.write(`${JSON.stringify({
  schemaVersion: "rust-worker-verification-v2",
  generatedAt: new Date().toISOString(),
  legacyParity: {
    backtest: { ...backtestDifference, nodeMs: nodeBacktestMs, rustProcessMs: rustBacktest.processMs },
    optimization: { ...optimizationDifference, nodeMs: nodeOptimizationMs, rustProcessMs: rustOptimization.processMs },
  },
  featureInvariants: {
    initialBalanceAfterCost: feature.points[0].balance,
    endingCashBalance: feature.metrics.endingCashBalance,
    investedBalance: feature.metrics.investedBalance,
    finalBalance: feature.metrics.finalBalance,
    totalTransactionCosts: feature.metrics.totalTransactionCosts,
    moneyWeightedReturnPercent: feature.metrics.moneyWeightedReturnPercent,
    tradeCount: feature.trades.length,
    appliedCashFlowCount: feature.cashFlows.length,
    propertyCaseCount: ledgerPropertyResults.length,
    targetScheduleApplied: ledgerPropertyResults.every((result) => result.targetWeightSchedule.length === 1),
    wholeLotConservation: true,
    extendedDataQuality: Object.keys(feature.dataQuality).sort(),
  },
  optimizationV2: {
    deterministic: true,
    algorithm: advanced.algorithm,
    covarianceEstimator: advanced.covarianceEstimator,
    candidateCount: advanced.candidateCount,
    baselineCandidateCount: advanced.baselineCandidateCount,
    paretoCount: advanced.paretoFrontier.length,
    ledgerValidation: advanced.ledgerValidation,
    robustScore: {
      inSampleScore: robustDetail.inSampleScore,
      outOfSampleScore: robustDetail.outOfSampleScore,
      coverage: robustDetail.coverage,
      availableWeight: robustDetail.availableWeight,
      componentCount: robustDetail.components.length,
    },
    regimePolicy: {
      method: regimePolicy.effectiveMethod,
      status: regimePolicy.status,
      decisionCount: regimePolicy.decisionCount,
      oosCoverage: regimePolicy.oosCoverage,
      ledgerValidation: regimePolicy.ledgerValidation,
      artifactExternalized: optimizationWorkerOutput.artifacts?.some((artifact) => artifact.type === "regime-policy") ?? false,
    },
    methodProcessMs: optimizerMethodTimings,
    processMs: advancedOptimization.processMs,
  },
  monteCarlo: {
    deterministic: true,
    pathCount: monteFirst.value.pathCount,
    processMs: monteFirst.processMs,
    probabilities: monteFirst.value.probabilities,
    methods: Object.fromEntries(Object.entries(monteMethodResults).map(([method, value]) => [method, {
      processMs: value.processMs,
      depletionProbabilityPercent: value.result.probabilities.everDepletedProbabilityPercent,
      calibrationCoveragePercent: value.result.calibration.coveragePercent,
      calibrationBiasPercent: value.result.calibration.biasPercent,
      maximumConservationError: value.result.ledger.maximumConservationError,
    }])),
  },
  reproducibility: {
    sameSeedInputRevisionExact: true,
    dataRevisionIndependentComputation: true,
    seedSensitive: true,
    payloadHash: reproducibilityFirst.payload_hash,
  },
  walkForward: {
    deterministic: true,
    rollingFoldCount: rolling.folds.length,
    anchoredFoldCount: (anchoredOutput.result as any).folds.length,
    rollingCoverage: rolling.oosSummary.coverage,
    anchoredCoverage: (anchoredOutput.result as any).oosSummary.coverage,
    gap: rolling.configuration.gap,
    embargo: rolling.configuration.embargo,
    seedCount: rolling.seedStability.seedCount,
    oosLeakageProbe: "training_selection_unchanged_oos_result_changed",
  },
}, null, 2)}\n`);
