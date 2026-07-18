import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { optimizePortfolio, type OptimizationInput } from "../server/services/optimization-service.js";

const ABSOLUTE_TOLERANCE = 1e-8;
const RELATIVE_TOLERANCE = 1e-9;

function isoDate(index: number): string {
  return new Date(Date.UTC(2022, 0, 1 + index)).toISOString().slice(0, 10);
}

function fixture(withWalkForward: boolean): OptimizationInput {
  const definitions = [
    { key: "A", phase: 0.1, drift: 0.00035 },
    { key: "B", phase: 0.8, drift: 0.00022 },
    { key: "C", phase: 1.5, drift: 0.00041 },
    { key: "D", phase: 2.2, drift: 0.00018 },
    { key: "E", phase: 2.9, drift: 0.00029 },
  ];
  const prices = definitions.map((definition, assetIndex) => {
    let price = 80 + assetIndex * 19;
    const points = [];
    for (let index = 0; index < 320; index += 1) {
      price *= 1 + definition.drift
        + Math.sin(index / (9 + assetIndex) + definition.phase) * 0.006
        + Math.cos(index / (31 + assetIndex * 2) + definition.phase) * 0.002;
      if ((assetIndex === 1 && index % 37 === 0) || (assetIndex === 3 && index % 53 === 0)) continue;
      points.push({ date: isoDate(index), value: price });
    }
    return { key: definition.key, label: definition.key, points };
  });
  const commonDates = new Set(prices[0]!.points.slice(1).map((point) => point.date));
  let benchmark = 0.0001;
  const benchmarkPoints = Array.from({ length: 319 }, (_, index) => {
    benchmark = 0.00025 + Math.sin(index / 13) * 0.0035 + Math.cos(index / 47) * 0.001;
    return { date: isoDate(index + 1), value: benchmark };
  }).filter((point) => commonDates.has(point.date));
  return {
    priceSeries: prices,
    benchmark: { key: "BM", label: "Benchmark", points: benchmarkPoints },
    constraints: {
      minWeight: 0,
      maxWeight: 0.65,
      maxAssets: 5,
      minWeights: { A: 0.05 },
      maxWeights: { C: 0.45 },
      currentWeights: { A: 0.2, B: 0.2, C: 0.2, D: 0.2, E: 0.2 },
      maxTurnover: 1,
    },
    seed: 73_421,
    candidateBudget: 120,
    riskFreeRatePercent: 2.5,
    confidence: 0.95,
    minimumSamples: 20,
    annualization: 252,
    transactionCostBps: 12,
    ...(withWalkForward ? {
      walkForwardConfig: {
        trainWindow: 120,
        testWindow: 40,
        step: 40,
        minimumTrainObservations: 100,
        minimumTestObservations: 30,
      },
    } : {}),
  };
}

type Comparison = { numbers: number; maxAbsolute: number; maxRelative: number };

function compare(left: unknown, right: unknown, path: string, result: Comparison): void {
  if (typeof left === "number" && typeof right === "number") {
    const absolute = Math.abs(left - right);
    const relative = absolute / Math.max(Math.abs(left), Math.abs(right), Number.MIN_VALUE);
    result.numbers += 1;
    result.maxAbsolute = Math.max(result.maxAbsolute, absolute);
    result.maxRelative = Math.max(result.maxRelative, relative);
    if (absolute > ABSOLUTE_TOLERANCE && relative > RELATIVE_TOLERANCE) {
      throw new Error(`${path}: numeric mismatch (${left} vs ${right}, abs=${absolute}, rel=${relative})`);
    }
    return;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      throw new Error(`${path}: array mismatch (${Array.isArray(left) ? left.length : "not-array"} vs ${Array.isArray(right) ? right.length : "not-array"})`);
    }
    left.forEach((value, index) => compare(value, right[index], `${path}[${index}]`, result));
    return;
  }
  if (left && right && typeof left === "object" && typeof right === "object") {
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const leftKeys = Object.keys(leftRecord).sort();
    const rightKeys = Object.keys(rightRecord).sort();
    if (JSON.stringify(leftKeys) !== JSON.stringify(rightKeys)) {
      throw new Error(`${path}: object keys mismatch (${leftKeys.join(",")} vs ${rightKeys.join(",")})`);
    }
    for (const key of leftKeys) compare(leftRecord[key], rightRecord[key], `${path}.${key}`, result);
    return;
  }
  if (!Object.is(left, right)) throw new Error(`${path}: value mismatch (${String(left)} vs ${String(right)})`);
}

function pythonOptimization(input: OptimizationInput): { output: unknown; durationMs: number } {
  const started = performance.now();
  const child = spawnSync("uv", ["run", "--frozen", "portfolio-compute-worker", "optimize-json"], {
    cwd: new URL("../worker/python", import.meta.url),
    env: { ...process.env, UV_CACHE_DIR: process.env.UV_CACHE_DIR ?? "/tmp/tpl-uv-cache" },
    input: JSON.stringify(input),
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
  const durationMs = performance.now() - started;
  if (child.status !== 0) throw new Error(`Python optimizer failed: ${child.stderr || child.stdout}`);
  return { output: JSON.parse(child.stdout) as unknown, durationMs };
}

const reports = [];
for (const withWalkForward of [false, true]) {
  const input = fixture(withWalkForward);
  const nodeStarted = performance.now();
  const node = JSON.parse(JSON.stringify(optimizePortfolio(input))) as ReturnType<typeof optimizePortfolio>;
  const nodeDurationMs = performance.now() - nodeStarted;
  const python = pythonOptimization(input);
  const result: Comparison = { numbers: 0, maxAbsolute: 0, maxRelative: 0 };
  compare(node, python.output, "$", result);
  reports.push({
    case: withWalkForward ? "walk-forward" : "full-period",
    candidateCount: node.candidateCount,
    paretoCount: node.paretoFrontier.length,
    comparedNumbers: result.numbers,
    maxAbsoluteError: result.maxAbsolute,
    maxRelativeError: result.maxRelative,
    nodeMs: Math.round(nodeDurationMs * 1_000) / 1_000,
    pythonProcessMs: Math.round(python.durationMs * 1_000) / 1_000,
  });
}
process.stdout.write(`${JSON.stringify({ absoluteTolerance: ABSOLUTE_TOLERANCE, relativeTolerance: RELATIVE_TOLERANCE, reports }, null, 2)}\n`);
