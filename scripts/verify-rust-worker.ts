import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { simulateBacktest, type BacktestSimulationInput } from "../server/backtest-engine.js";
import { optimizePortfolio } from "../server/services/optimization-service.js";
import { buildSyntheticFixture } from "./benchmark-compute.js";

const binary = fileURLToPath(new URL("../worker/rust/target/release/portfolio-lens-worker", import.meta.url));

function serializable(input: BacktestSimulationInput): Record<string, unknown> {
  return JSON.parse(JSON.stringify({ ...input, prices: Object.fromEntries(input.prices) })) as Record<string, unknown>;
}

function rust(command: "backtest-json" | "optimize-json" | "monte-carlo-json", input: unknown): { value: any; processMs: number } {
  const started = performance.now();
  const child = spawnSync(binary, [command], {
    input: JSON.stringify(input), encoding: "utf8", maxBuffer: 256 * 1024 * 1024,
  });
  const processMs = performance.now() - started;
  if (child.status !== 0) throw new Error(`Rust ${command} failed: ${child.stderr || child.stdout}`);
  return { value: JSON.parse(child.stdout), processMs };
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
    dataQuality: value.dataQuality,
  };
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
const nodeOptimizationStarted = performance.now();
const nodeOptimization = optimizePortfolio(fixture.optimization);
const nodeOptimizationMs = performance.now() - nodeOptimizationStarted;
const rustOptimization = rust("optimize-json", fixture.optimization);
const optimizationDifference: Difference = { compared: 0, maxAbsolute: 0, maxRelative: 0 };
compare(nodeOptimization, rustOptimization.value, "$optimization", optimizationDifference, 1e-8, 1e-9);

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
assert(Math.abs(feature.metrics.finalBalance - (feature.metrics.endingCashBalance + feature.metrics.investedBalance)) < 0.011);

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

process.stdout.write(`${JSON.stringify({
  schemaVersion: "rust-worker-verification-v1",
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
  },
  monteCarlo: {
    deterministic: true,
    pathCount: monteFirst.value.pathCount,
    processMs: monteFirst.processMs,
    probabilities: monteFirst.value.probabilities,
  },
}, null, 2)}\n`);
