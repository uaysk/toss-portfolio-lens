import { fork } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { simulateBacktest, type BacktestSimulationInput } from "../server/backtest-engine.js";
import { SqliteDatabase } from "../server/database.js";
import { ArtifactRepository } from "../server/repositories/artifact-repository.js";
import { RunRepository } from "../server/repositories/run-repository.js";
import { optimizePortfolio, type OptimizationInput } from "../server/services/optimization-service.js";

type ProbeResult = {
  requests: number;
  completed: number;
  timeouts: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
};

type Fixture = {
  backtest: BacktestSimulationInput;
  optimization: OptimizationInput;
};

function percentile(values: number[], percentileValue: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * percentileValue) - 1));
  return sorted[index]!;
}

function round(value: number, digits = 3): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function summary(values: number[]) {
  return {
    p50Ms: round(percentile(values, 0.5)),
    p95Ms: round(percentile(values, 0.95)),
    maxMs: round(Math.max(...values)),
  };
}

function date(index: number): string {
  return new Date(Date.UTC(2018, 0, 1 + index)).toISOString().slice(0, 10);
}

export function buildSyntheticFixture(dayCount = 1_260): Fixture {
  const definitions = [
    { symbol: "KR1", currency: "KRW" as const, weight: 18, phase: 0.1, drift: 0.00035 },
    { symbol: "KR2", currency: "KRW" as const, weight: 16, phase: 0.8, drift: 0.00028 },
    { symbol: "KR3", currency: "KRW" as const, weight: 15, phase: 1.6, drift: 0.00022 },
    { symbol: "KR4", currency: "KRW" as const, weight: 14, phase: 2.4, drift: 0.00018 },
    { symbol: "US1", currency: "USD" as const, weight: 13, phase: 0.4, drift: 0.00042 },
    { symbol: "US2", currency: "USD" as const, weight: 10, phase: 1.2, drift: 0.00038 },
    { symbol: "US3", currency: "USD" as const, weight: 8, phase: 2.0, drift: 0.00031 },
    { symbol: "US4", currency: "USD" as const, weight: 6, phase: 2.8, drift: 0.00026 },
  ];
  const prices = new Map<string, Array<{ date: string; close: number; localClose: number; fxRate: number }>>();
  const optimizationSeries: OptimizationInput["priceSeries"] = [];

  for (const [assetIndex, definition] of definitions.entries()) {
    let localClose = 80 + assetIndex * 13;
    const points = [];
    for (let index = 0; index < dayCount; index += 1) {
      const cyclical = Math.sin(index / (11 + assetIndex) + definition.phase) * 0.006;
      const secondary = Math.cos(index / (37 + assetIndex * 2) + definition.phase) * 0.0025;
      localClose *= Math.max(0.85, 1 + definition.drift + cyclical + secondary);
      const fxRate = definition.currency === "USD"
        ? 1_080 + index * 0.09 + Math.sin(index / 29) * 24
        : 1;
      points.push({ date: date(index), close: localClose * fxRate, localClose, fxRate });
    }
    prices.set(`${definition.currency}:${definition.symbol}`, points);
    optimizationSeries.push({
      key: definition.symbol,
      label: definition.symbol,
      points: points.map((point) => ({ date: point.date, value: point.close })),
    });
  }

  let benchmarkClose = 100;
  const benchmark = Array.from({ length: dayCount }, (_, index) => {
    benchmarkClose *= 1 + 0.0003 + Math.sin(index / 17) * 0.0045 + Math.cos(index / 53) * 0.0015;
    return { date: date(index), close: benchmarkClose };
  });

  return {
    backtest: {
      assets: definitions.map((definition) => ({
        symbol: definition.symbol,
        name: definition.symbol,
        market: definition.currency === "KRW" ? "KRX" : "NASDAQ",
        currency: definition.currency,
        listDate: date(0),
        weight: definition.weight,
      })),
      prices,
      requestedStartDate: date(0),
      endDate: date(dayCount - 1),
      initialAmount: 100_000_000,
      monthlyCashFlow: 750_000,
      cashFlowFrequency: "monthly",
      cashFlowTiming: "period_start",
      rebalanceFrequency: "quarterly",
      riskFreeRatePercent: 2.5,
      transactionCostBps: 12,
      rebalanceThresholdPercent: 5,
      benchmark: { key: "SYNTH", name: "Synthetic benchmark", prices: benchmark },
    },
    optimization: {
      priceSeries: optimizationSeries,
      benchmark: {
        key: "SYNTH",
        label: "Synthetic benchmark",
        points: benchmark.slice(1).map((point, index) => ({
          date: point.date,
          value: point.close / benchmark[index]!.close - 1,
        })),
      },
      constraints: { minWeight: 0, maxWeight: 0.6, maxAssets: definitions.length },
      seed: 73_421,
      candidateBudget: 1_000,
      riskFreeRatePercent: 2.5,
      confidence: 0.95,
      minimumSamples: 60,
      annualization: 252,
      transactionCostBps: 12,
    },
  };
}

async function runProbeChild(): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const pending = new Set<Promise<void>>();
  const latencies: number[] = [];
  let requests = 0;
  let timeouts = 0;

  process.on("message", (message: { type?: string; url?: string; intervalMs?: number } | undefined) => {
    if (message?.type === "start" && message.url) {
      const issue = () => {
        requests += 1;
        const started = performance.now();
        const promise = fetch(message.url!, { signal: AbortSignal.timeout(6_000) })
          .then(async (response) => {
            await response.arrayBuffer();
            if (!response.ok) throw new Error(`health ${response.status}`);
            latencies.push(performance.now() - started);
          })
          .catch((error: unknown) => {
            if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) timeouts += 1;
          })
          .finally(() => pending.delete(promise));
        pending.add(promise);
      };
      issue();
      timer = setInterval(issue, message.intervalMs ?? 25);
      process.send?.({ type: "ready" });
      return;
    }
    if (message?.type === "stop") {
      if (timer) clearInterval(timer);
      void Promise.allSettled([...pending]).then(() => {
        const result: ProbeResult = {
          requests,
          completed: latencies.length,
          timeouts,
          p50Ms: round(percentile(latencies, 0.5)),
          p95Ms: round(percentile(latencies, 0.95)),
          p99Ms: round(percentile(latencies, 0.99)),
          maxMs: round(latencies.length ? Math.max(...latencies) : 0),
        };
        process.send?.({ type: "result", result });
      });
    }
  });
  process.send?.({ type: "booted" });
}

async function healthAndEventLoopBenchmark(work: () => void): Promise<{
  computeMs: number;
  health: ProbeResult;
  eventLoop: { p95Ms: number; p99Ms: number; maxMs: number };
}> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{\"ok\":true}");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("benchmark health server address not available");

  const child = fork(fileURLToPath(import.meta.url), ["--probe-child"], {
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  const booted = new Promise<void>((resolve) => {
    child.on("message", (message: { type?: string }) => {
      if (message.type === "booted") resolve();
    });
  });
  await booted;
  const ready = new Promise<void>((resolve) => {
    child.on("message", (message: { type?: string }) => {
      if (message.type === "ready") resolve();
    });
  });
  child.send({ type: "start", url: `http://127.0.0.1:${address.port}/health`, intervalMs: 25 });
  await ready;
  await new Promise((resolve) => setTimeout(resolve, 75));

  const delay = monitorEventLoopDelay({ resolution: 10 });
  delay.enable();
  await new Promise((resolve) => setTimeout(resolve, 30));
  const started = performance.now();
  work();
  const computeMs = performance.now() - started;
  await new Promise((resolve) => setTimeout(resolve, 75));
  delay.disable();

  const result = new Promise<ProbeResult>((resolve) => {
    child.on("message", (message: { type?: string; result?: ProbeResult }) => {
      if (message.type === "result" && message.result) resolve(message.result);
    });
  });
  child.send({ type: "stop" });
  const health = await result;
  child.disconnect();
  await once(child, "exit");
  server.close();
  await once(server, "close");
  return {
    computeMs: round(computeMs),
    health,
    eventLoop: {
      p95Ms: round(delay.percentile(95) / 1_000_000),
      p99Ms: round(delay.percentile(99) / 1_000_000),
      maxMs: round(delay.max / 1_000_000),
    },
  };
}

async function benchmark(): Promise<void> {
  const candidateBudget = Math.max(10, Math.min(10_000, Number(process.env.BENCH_CANDIDATES ?? 1_000)));
  const dayCount = Math.max(90, Math.min(5_000, Number(process.env.BENCH_DAYS ?? 1_260)));
  const backtestIterations = Math.max(3, Math.min(100, Number(process.env.BENCH_BACKTEST_ITERATIONS ?? 12)));
  const optimizationIterations = Math.max(2, Math.min(20, Number(process.env.BENCH_OPTIMIZATION_ITERATIONS ?? 4)));
  const startedPreparation = performance.now();
  const fixture = buildSyntheticFixture(dayCount);
  fixture.optimization.candidateBudget = candidateBudget;
  const inputPreparationMs = performance.now() - startedPreparation;

  simulateBacktest(fixture.backtest);
  optimizePortfolio({ ...fixture.optimization, candidateBudget: Math.min(20, candidateBudget) });

  const cpuBefore = process.cpuUsage();
  const backtestDurations: number[] = [];
  let backtestResult: ReturnType<typeof simulateBacktest> | undefined;
  for (let index = 0; index < backtestIterations; index += 1) {
    const started = performance.now();
    backtestResult = simulateBacktest(fixture.backtest);
    backtestDurations.push(performance.now() - started);
  }

  const optimizationDurations: number[] = [];
  let optimizationResult: ReturnType<typeof optimizePortfolio> | undefined;
  for (let index = 0; index < optimizationIterations; index += 1) {
    const started = performance.now();
    optimizationResult = optimizePortfolio(fixture.optimization);
    optimizationDurations.push(performance.now() - started);
  }
  if (!backtestResult || !optimizationResult) throw new Error("benchmark result missing");

  const serializeStarted = performance.now();
  const serialized = JSON.stringify({ backtest: backtestResult, optimization: optimizationResult });
  const serializationMs = performance.now() - serializeStarted;

  const database = new SqliteDatabase(":memory:");
  const runRepository = new RunRepository(database);
  const artifactRepository = new ArtifactRepository(database);
  await runRepository.initialize();
  await artifactRepository.initialize();
  const storageStarted = performance.now();
  const run = await runRepository.create({
    kind: "optimization",
    ownerSubject: "benchmark",
    requestHash: "benchmark-request",
    dataRevision: "synthetic-v1",
    engineVersion: "node-baseline",
    config: { candidateBudget, dayCount },
    totalCandidates: optimizationResult.candidateCount,
  });
  await runRepository.markRunning(run.id);
  const descriptor = await artifactRepository.put({
    runId: run.id,
    type: "candidates",
    content: optimizationResult.candidates,
    rowCount: optimizationResult.candidateCount,
    schemaVersion: "benchmark-v1",
    dataRevision: "synthetic-v1",
  });
  await runRepository.complete(run.id, { candidateCount: optimizationResult.candidateCount }, optimizationResult);
  const artifactStorageMs = performance.now() - storageStarted;
  await database.close();

  const health = await healthAndEventLoopBenchmark(() => {
    optimizePortfolio(fixture.optimization);
  });
  const cpu = process.cpuUsage(cpuBefore);
  const maxRssBytes = process.resourceUsage().maxRSS * 1_024;
  const optimizationTotalMs = optimizationDurations.reduce((sum, value) => sum + value, 0);

  const output = {
    schemaVersion: "compute-benchmark-v1",
    generatedAt: new Date().toISOString(),
    engine: "node-inline",
    environment: {
      platform: `${process.platform}-${process.arch}`,
      node: process.version,
      cpu: os.cpus()[0]?.model ?? "unknown",
      logicalCores: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
    },
    fixture: {
      dayCount,
      assetCount: fixture.backtest.assets.length,
      candidateBudget,
      backtestIterations,
      optimizationIterations,
    },
    phases: {
      inputPreparationMs: round(inputPreparationMs),
      backtest: summary(backtestDurations),
      optimization: {
        ...summary(optimizationDurations),
        candidatesPerSecond: round(optimizationResult.candidateCount * optimizationIterations / (optimizationTotalMs / 1_000)),
        producedCandidates: optimizationResult.candidateCount,
      },
      serializationMs: round(serializationMs),
      serializedBytes: Buffer.byteLength(serialized),
      artifactStorageMs: round(artifactStorageMs),
      artifactBytes: descriptor.byteCount,
    },
    responsiveness: health,
    process: {
      cpuUserMs: round(cpu.user / 1_000),
      cpuSystemMs: round(cpu.system / 1_000),
      rssBytes: process.memoryUsage().rss,
      maxRssBytes,
    },
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--probe-child")) {
    await runProbeChild();
  } else {
    await benchmark();
  }
}
