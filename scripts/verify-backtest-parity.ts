import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { simulateBacktest, type BacktestPricePoint, type BacktestSimulationInput } from "../server/backtest-engine.js";

const ABSOLUTE_TOLERANCE = 1e-8;
const RELATIVE_TOLERANCE = 1e-9;

function isoDate(index: number): string {
  return new Date(Date.UTC(2020, 0, 1 + index)).toISOString().slice(0, 10);
}

function patternedPoints(input: {
  days: number;
  base: number;
  phase: number;
  drift: number;
  skip?: (index: number) => boolean;
  usd?: boolean;
}): BacktestPricePoint[] {
  let local = input.base;
  const points: BacktestPricePoint[] = [];
  for (let index = 0; index < input.days; index += 1) {
    local *= Math.max(0.8, 1 + input.drift + Math.sin(index / 11 + input.phase) * 0.007
      + Math.cos(index / 43 + input.phase) * 0.0025);
    if (input.skip?.(index)) continue;
    const fxRate = input.usd ? 1_080 + index * 0.11 + Math.sin(index / 29) * 27 : 1;
    points.push({ date: isoDate(index), close: local * fxRate, localClose: local, fxRate });
  }
  return points;
}

function benchmarkPoints(days: number, skip?: (index: number) => boolean): BacktestPricePoint[] {
  let close = 100;
  const points: BacktestPricePoint[] = [];
  for (let index = 0; index < days; index += 1) {
    close *= 1 + 0.0003 + Math.sin(index / 17) * 0.004 + Math.cos(index / 61) * 0.0015;
    if (!skip?.(index)) points.push({ date: isoDate(index), close });
  }
  return points;
}

function flatFixture(): BacktestSimulationInput {
  return {
    assets: [{ symbol: "FLAT", name: "Flat", market: "KRX", currency: "KRW", listDate: isoDate(0), weight: 100 }],
    prices: new Map([["KRW:FLAT", [0, 1, 2, 3].map((index) => ({ date: isoDate(index), close: 100 }))]]),
    requestedStartDate: isoDate(0),
    endDate: isoDate(3),
    initialAmount: 1_000_000,
    monthlyCashFlow: 0,
    rebalanceFrequency: "none",
  };
}

function complexFixture(monthlyCashFlow: number, timing: "period_start" | "period_end"): BacktestSimulationInput {
  const days = 420;
  return {
    assets: [
      { symbol: "KR1", name: "Korean 1", market: "KRX", currency: "KRW", listDate: isoDate(0), weight: 35 },
      { symbol: "US1", name: "US 1", market: "NASDAQ", currency: "USD", listDate: isoDate(3), weight: 40 },
      { symbol: "KR2", name: "Korean 2", market: "KRX", currency: "KRW", listDate: isoDate(6), weight: 25 },
    ],
    prices: new Map([
      ["KRW:KR1", patternedPoints({ days, base: 80, phase: 0.1, drift: 0.00031, skip: (index) => index % 31 === 0 })],
      ["USD:US1", patternedPoints({ days, base: 110, phase: 1.2, drift: 0.00039, usd: true, skip: (index) => index < 3 || index % 37 === 0 })],
      ["KRW:KR2", patternedPoints({ days, base: 65, phase: 2.1, drift: 0.0002, skip: (index) => index < 6 || index % 43 === 0 })],
    ]),
    requestedStartDate: isoDate(0),
    endDate: isoDate(days - 1),
    initialAmount: 80_000_000,
    monthlyCashFlow,
    cashFlowFrequency: "quarterly",
    cashFlowTiming: timing,
    rebalanceFrequency: "quarterly",
    riskFreeRatePercent: 2.4,
    transactionCostBps: 17,
    benchmark: { key: "BM", name: "Synthetic benchmark", prices: benchmarkPoints(days, (index) => index < 2 || index % 29 === 0) },
  };
}

function longFixture(): BacktestSimulationInput {
  const days = 1_205;
  return {
    assets: [
      { symbol: "A", name: "A", market: "KRX", currency: "KRW", listDate: isoDate(0), weight: 55 },
      { symbol: "B", name: "B", market: "NASDAQ", currency: "USD", listDate: isoDate(0), weight: 45 },
    ],
    prices: new Map([
      ["KRW:A", patternedPoints({ days, base: 100, phase: 0.2, drift: 0.0002 })],
      ["USD:B", patternedPoints({ days, base: 70, phase: 2.0, drift: 0.00032, usd: true })],
    ]),
    requestedStartDate: isoDate(0),
    endDate: isoDate(days - 1),
    initialAmount: 50_000_000,
    monthlyCashFlow: 0,
    rebalanceFrequency: "threshold",
    rebalanceThresholdPercent: 2.5,
    riskFreeRatePercent: 1.75,
    transactionCostBps: 9,
    benchmark: { key: "LONG", name: "Long benchmark", prices: benchmarkPoints(days) },
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

function serializable(input: BacktestSimulationInput): Record<string, unknown> {
  return JSON.parse(JSON.stringify({ ...input, prices: Object.fromEntries(input.prices) })) as Record<string, unknown>;
}

function pythonBacktest(input: BacktestSimulationInput): { output: unknown; durationMs: number } {
  const started = performance.now();
  const child = spawnSync("uv", ["run", "--frozen", "portfolio-compute-worker", "backtest-json"], {
    cwd: new URL("../worker/python", import.meta.url),
    env: { ...process.env, UV_CACHE_DIR: process.env.UV_CACHE_DIR ?? "/tmp/tpl-uv-cache" },
    input: JSON.stringify(serializable(input)),
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
  const durationMs = performance.now() - started;
  if (child.status !== 0) throw new Error(`Python backtest failed: ${child.stderr || child.stdout}`);
  return { output: JSON.parse(child.stdout) as unknown, durationMs };
}

const fixtures: Array<[string, BacktestSimulationInput]> = [
  ["flat-minimal", flatFixture()],
  ["positive-quarterly-start", complexFixture(450_000, "period_start")],
  ["negative-quarterly-end", complexFixture(-225_000, "period_end")],
  ["long-threshold-downsample", longFixture()],
];
const reports = fixtures.map(([name, input]) => {
  const nodeStarted = performance.now();
  const node = JSON.parse(JSON.stringify(simulateBacktest(input))) as ReturnType<typeof simulateBacktest>;
  const nodeDurationMs = performance.now() - nodeStarted;
  const python = pythonBacktest(input);
  const result: Comparison = { numbers: 0, maxAbsolute: 0, maxRelative: 0 };
  compare(node, python.output, "$", result);
  return {
    case: name,
    points: node.points.length,
    trades: node.trades.length,
    comparedNumbers: result.numbers,
    maxAbsoluteError: result.maxAbsolute,
    maxRelativeError: result.maxRelative,
    nodeMs: Math.round(nodeDurationMs * 1_000) / 1_000,
    pythonProcessMs: Math.round(python.durationMs * 1_000) / 1_000,
  };
});
process.stdout.write(`${JSON.stringify({ absoluteTolerance: ABSOLUTE_TOLERANCE, relativeTolerance: RELATIVE_TOLERANCE, reports }, null, 2)}\n`);
