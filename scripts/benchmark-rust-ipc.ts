import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { simulateBacktest } from "../server/backtest-engine.js";
import { optimizePortfolio } from "../server/services/optimization-service.js";
import { RustComputeClient } from "../server/worker/rust-client.js";
import { buildSyntheticFixture } from "./benchmark-compute.js";

const binary = fileURLToPath(new URL("../worker/rust/target/release/portfolio-lens-worker", import.meta.url));
const pythonDirectory = fileURLToPath(new URL("../worker/python", import.meta.url));

function percentile(values: number[], probability: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * probability) - 1))] ?? 0;
}

function round(value: number, digits = 3): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function timing(values: number[]) {
  return {
    iterations: values.length,
    p50Ms: round(percentile(values, 0.5)),
    p95Ms: round(percentile(values, 0.95)),
    minMs: round(Math.min(...values)),
    maxMs: round(Math.max(...values)),
  };
}

function plain(value: unknown): unknown {
  if (value instanceof Map) return Object.fromEntries(Array.from(value, ([key, item]) => [String(key), plain(item)]));
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plain(item)]));
  return value;
}

function pythonCompute(kind: "backtest" | "optimization", payload: unknown, iterations: number): { durations: number[]; processMs: number } {
  const code = kind === "backtest"
    ? "import json,sys,time; from portfolio_worker.backtest_engine import simulate_backtest; d=json.load(sys.stdin); f=lambda:simulate_backtest(d['payload']); f(); a=[]; [(lambda s: (f(),a.append((time.perf_counter()-s)*1000)))(time.perf_counter()) for _ in range(d['iterations'])]; print(json.dumps(a))"
    : "import json,sys,time; from portfolio_worker.optimization import optimize_portfolio; d=json.load(sys.stdin); f=lambda:optimize_portfolio(d['payload'],batch_size=512); f(); a=[]; [(lambda s: (f(),a.append((time.perf_counter()-s)*1000)))(time.perf_counter()) for _ in range(d['iterations'])]; print(json.dumps(a))";
  const started = performance.now();
  const child = spawnSync("uv", ["run", "--frozen", "python", "-c", code], {
    cwd: pythonDirectory,
    env: { ...process.env, UV_CACHE_DIR: process.env.UV_CACHE_DIR ?? "/tmp/tpl-uv-cache" },
    input: JSON.stringify({ payload: plain(payload), iterations }),
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  const processMs = performance.now() - started;
  if (child.status !== 0) throw new Error(`Python ${kind} benchmark failed: ${child.stderr || child.stdout}`);
  return { durations: JSON.parse(child.stdout) as number[], processMs };
}

async function waitForSocket(socketPath: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (existsSync(socketPath)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Rust UDS worker did not create its socket");
}

const dayCount = Math.max(90, Math.min(5_000, Number(process.env.BENCH_DAYS ?? 1_260)));
const candidateBudget = Math.max(10, Math.min(10_000, Number(process.env.BENCH_CANDIDATES ?? 1_000)));
const backtestIterations = Math.max(3, Math.min(100, Number(process.env.BENCH_BACKTEST_ITERATIONS ?? 10)));
const optimizationIterations = Math.max(2, Math.min(20, Number(process.env.BENCH_OPTIMIZATION_ITERATIONS ?? 3)));
const fixture = buildSyntheticFixture(dayCount);
fixture.backtest.transactionCostBps = 0;
fixture.optimization.transactionCostBps = 0;
fixture.optimization.candidateBudget = candidateBudget;

simulateBacktest(fixture.backtest);
optimizePortfolio({ ...fixture.optimization, candidateBudget: 20 });
const nodeBacktest: number[] = [];
const nodeBacktestJsonRoundTrip: number[] = [];
for (let index = 0; index < backtestIterations; index += 1) {
  const started = performance.now();
  const result = simulateBacktest(fixture.backtest);
  const computed = performance.now();
  nodeBacktest.push(computed - started);
  JSON.parse(JSON.stringify(result));
  nodeBacktestJsonRoundTrip.push(performance.now() - started);
}
const nodeOptimization: number[] = [];
const nodeOptimizationJsonRoundTrip: number[] = [];
for (let index = 0; index < optimizationIterations; index += 1) {
  const started = performance.now();
  const result = optimizePortfolio(fixture.optimization);
  const computed = performance.now();
  nodeOptimization.push(computed - started);
  JSON.parse(JSON.stringify(result));
  nodeOptimizationJsonRoundTrip.push(performance.now() - started);
}

const pythonBacktest = pythonCompute("backtest", fixture.backtest, backtestIterations);
const pythonOptimization = pythonCompute("optimization", fixture.optimization, optimizationIterations);

const socketPath = path.join("/tmp", `portfolio-lens-rust-bench-${process.pid}.sock`);
const worker = spawn(binary, ["serve", "--socket", socketPath], { stdio: ["ignore", "ignore", "pipe"] });
let workerStderr = "";
worker.stderr.setEncoding("utf8");
worker.stderr.on("data", (chunk: string) => { workerStderr += chunk; });
const client = new RustComputeClient({ socketPath, poolSize: 1, timeoutMs: 600_000 });
try {
  await waitForSocket(socketPath);
  await client.compute("backtest", { simulation: fixture.backtest }, { includeArtifacts: false });
  await client.compute("optimization", { optimization: { ...fixture.optimization, candidateBudget: 20 }, objective: "robust_score" });
  const rustBacktestRoundTrip: number[] = [];
  const rustBacktestCompute: number[] = [];
  const rustBacktestRequestDecode: number[] = [];
  const rustBacktestWorkerElapsed: number[] = [];
  let rustBacktestResultBytes = 0;
  for (let index = 0; index < backtestIterations; index += 1) {
    const started = performance.now();
    const output = await client.compute("backtest", { simulation: fixture.backtest }, { includeArtifacts: false });
    rustBacktestRoundTrip.push(performance.now() - started);
    rustBacktestResultBytes = Buffer.byteLength(JSON.stringify(output.result));
    const metrics = output.artifacts.find((artifact) => artifact.type === "worker-metrics")?.content as {
      compute_ms?: number;
      request_decode_ms?: number;
      worker_elapsed_ms?: number;
    } | undefined;
    if (metrics?.compute_ms === undefined || metrics.request_decode_ms === undefined || metrics.worker_elapsed_ms === undefined) {
      throw new Error("Rust UDS worker metrics missing");
    }
    rustBacktestCompute.push(metrics.compute_ms);
    rustBacktestRequestDecode.push(metrics.request_decode_ms);
    rustBacktestWorkerElapsed.push(metrics.worker_elapsed_ms);
  }
  const rustOptimizationRoundTrip: number[] = [];
  const rustOptimizationCompute: number[] = [];
  const rustOptimizationRequestDecode: number[] = [];
  const rustOptimizationWorkerElapsed: number[] = [];
  for (let index = 0; index < optimizationIterations; index += 1) {
    const started = performance.now();
    const output = await client.compute("optimization", { optimization: fixture.optimization, objective: "robust_score" });
    rustOptimizationRoundTrip.push(performance.now() - started);
    const metrics = output.artifacts.find((artifact) => artifact.type === "worker-metrics")?.content as {
      compute_ms?: number;
      request_decode_ms?: number;
      worker_elapsed_ms?: number;
    } | undefined;
    if (metrics?.compute_ms === undefined || metrics.request_decode_ms === undefined || metrics.worker_elapsed_ms === undefined) {
      throw new Error("Rust UDS worker metrics missing");
    }
    rustOptimizationCompute.push(metrics.compute_ms);
    rustOptimizationRequestDecode.push(metrics.request_decode_ms);
    rustOptimizationWorkerElapsed.push(metrics.worker_elapsed_ms);
  }

  const nodeBacktestP50 = percentile(nodeBacktest, 0.5);
  const nodeOptimizationP50 = percentile(nodeOptimization, 0.5);
  const pythonBacktestP50 = percentile(pythonBacktest.durations, 0.5);
  const pythonOptimizationP50 = percentile(pythonOptimization.durations, 0.5);
  const rustBacktestP50 = percentile(rustBacktestCompute, 0.5);
  const rustOptimizationP50 = percentile(rustOptimizationCompute, 0.5);
  process.stdout.write(`${JSON.stringify({
    schemaVersion: "rust-ipc-benchmark-v2",
    generatedAt: new Date().toISOString(),
    environment: {
      platform: `${process.platform}-${process.arch}`,
      cpu: os.cpus()[0]?.model ?? "unknown",
      logicalCores: os.cpus().length,
      node: process.version,
      python: "3.12",
      rust: "1.97.0",
      rayonThreads: process.env.RAYON_NUM_THREADS ?? "logical-core-default",
      ipc: "persistent-unix-domain-socket-length-prefixed-json-v2",
    },
    fixture: { dayCount, assetCount: fixture.backtest.assets.length, candidateBudget, backtestIterations, optimizationIterations },
    comparisonBasis: {
      backtest: "Node legacy projection and feature-complete Rust ledger share the same core numeric fixture; Rust additionally computes cash/cost/XIRR/full analytics.",
      optimization: "Node, Python, and Rust evaluate the same deterministic candidate fixture; Node/Rust numeric parity is verified separately.",
      rustUdsRoundTrip: "End-to-end Node stringify + UDS frame + Rust decode/compute/encode + Node parse.",
    },
    backtest: {
      nodeCompute: timing(nodeBacktest),
      nodeJsonRoundTrip: timing(nodeBacktestJsonRoundTrip),
      pythonCompute: timing(pythonBacktest.durations),
      pythonProcessTotalMs: round(pythonBacktest.processMs),
      rustCompute: timing(rustBacktestCompute),
      rustRequestDecode: timing(rustBacktestRequestDecode),
      rustWorkerElapsed: timing(rustBacktestWorkerElapsed),
      rustUdsRoundTrip: timing(rustBacktestRoundTrip),
      resultBytes: { node: Buffer.byteLength(JSON.stringify(simulateBacktest(fixture.backtest))), rust: rustBacktestResultBytes },
      speedup: {
        rustVsNodeCompute: round(nodeBacktestP50 / rustBacktestP50),
        rustVsPythonCompute: round(pythonBacktestP50 / rustBacktestP50),
        rustUdsVsNodeCompute: round(nodeBacktestP50 / percentile(rustBacktestRoundTrip, 0.5)),
        rustUdsVsNodeJsonRoundTrip: round(percentile(nodeBacktestJsonRoundTrip, 0.5) / percentile(rustBacktestRoundTrip, 0.5)),
      },
    },
    optimization: {
      nodeCompute: timing(nodeOptimization),
      nodeJsonRoundTrip: timing(nodeOptimizationJsonRoundTrip),
      pythonCompute: timing(pythonOptimization.durations),
      pythonProcessTotalMs: round(pythonOptimization.processMs),
      rustCompute: timing(rustOptimizationCompute),
      rustRequestDecode: timing(rustOptimizationRequestDecode),
      rustWorkerElapsed: timing(rustOptimizationWorkerElapsed),
      rustUdsRoundTrip: timing(rustOptimizationRoundTrip),
      speedup: {
        rustVsNodeCompute: round(nodeOptimizationP50 / rustOptimizationP50),
        rustVsPythonCompute: round(pythonOptimizationP50 / rustOptimizationP50),
        rustUdsVsNodeCompute: round(nodeOptimizationP50 / percentile(rustOptimizationRoundTrip, 0.5)),
        rustUdsVsNodeJsonRoundTrip: round(percentile(nodeOptimizationJsonRoundTrip, 0.5) / percentile(rustOptimizationRoundTrip, 0.5)),
      },
    },
  }, null, 2)}\n`);
} finally {
  client.close();
  worker.kill("SIGTERM");
  await new Promise<void>((resolve) => worker.once("exit", () => resolve()));
  if (worker.exitCode && worker.exitCode !== 143) throw new Error(`Rust UDS worker exited ${worker.exitCode}: ${workerStderr}`);
}
