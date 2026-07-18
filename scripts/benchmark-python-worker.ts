import assert from "node:assert/strict";
import { spawn, fork } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { openPostgresDatabase } from "../server/database.js";
import { ArtifactRepository } from "../server/repositories/artifact-repository.js";
import { OptimizationRepository } from "../server/repositories/optimization-repository.js";
import { RunJobRepository } from "../server/repositories/run-job-repository.js";
import { RunRepository, type PortfolioRunRecord } from "../server/repositories/run-repository.js";
import { ArtifactService } from "../server/services/artifact-service.js";
import { RunService } from "../server/services/run-service.js";
import { buildSyntheticFixture } from "./benchmark-compute.js";

type ProbeResult = {
  requests: number;
  completed: number;
  timeouts: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
};

function percentile(values: number[], probability: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * probability) - 1))]!;
}

function round(value: number, digits = 3): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function timing(values: number[]) {
  return {
    p50Ms: round(percentile(values, 0.5)),
    p95Ms: round(percentile(values, 0.95)),
    maxMs: round(Math.max(...values)),
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
        const promise = fetch(message.url!, { signal: AbortSignal.timeout(2_000) })
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
        process.send?.({
          type: "result",
          result: {
            requests,
            completed: latencies.length,
            timeouts,
            p50Ms: round(percentile(latencies, 0.5)),
            p95Ms: round(percentile(latencies, 0.95)),
            p99Ms: round(percentile(latencies, 0.99)),
            maxMs: round(latencies.length ? Math.max(...latencies) : 0),
          } satisfies ProbeResult,
        });
      });
    }
  });
  process.send?.({ type: "booted" });
}

if (process.argv.includes("--probe-child")) {
  await runProbeChild();
} else {
  const host = process.env.POSTGRES_TEST_HOST || "127.0.0.1";
  const port = Number.parseInt(process.env.POSTGRES_TEST_PORT || "35433", 10);
  const user = process.env.POSTGRES_TEST_USER || "portfolio_test";
  const password = process.env.POSTGRES_TEST_PASSWORD || "integration-password";
  const databaseName = process.env.POSTGRES_TEST_DATABASE || "portfolio_lens_test";
  const conninfo = `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(databaseName)}`;
  const database = await openPostgresDatabase({ host, port, user, password, database: databaseName, connectTimeoutMs: 5_000 });
  const runRepository = new RunRepository(database);
  const artifactRepository = new ArtifactRepository(database);
  const optimizationRepository = new OptimizationRepository(database);
  const jobs = new RunJobRepository(database);
  await runRepository.initialize();
  await artifactRepository.initialize();
  await optimizationRepository.initialize();
  await jobs.initialize();
  const artifacts = new ArtifactService(artifactRepository, 1_000, 204_800);
  const runs = new RunService(runRepository, artifacts, 1, 20, {
    executionMode: "external",
    jobRepository: jobs,
    resultPollMs: 20,
    resultDeadlineMs: 60_000,
    optimizationRepository,
  });
  await runs.initialize();
  const abandoned = await database.query<{ run_id: string; owner_subject: string }>(`
    SELECT run_id, owner_subject FROM portfolio_backtest_runs
    WHERE owner_subject LIKE 'benchmark-%' AND status IN ('queued', 'cancel_requested')
  `);
  for (const run of abandoned) await jobs.cancel(run.run_id, run.owner_subject);
  const worker = spawn("uv", ["run", "--frozen", "portfolio-compute-worker", "run"], {
    cwd: new URL("../worker/python", import.meta.url),
    env: {
      ...process.env,
      UV_CACHE_DIR: process.env.UV_CACHE_DIR ?? "/tmp/tpl-uv-cache",
      POSTGRES_URL: conninfo,
      PYTHON_WORKER_ID: `benchmark-${randomUUID()}`,
      PYTHON_WORKER_POLL_MS: "25",
      PYTHON_WORKER_LEASE_MS: "10000",
      PYTHON_WORKER_HEARTBEAT_MS: "2000",
      PYTHON_WORKER_RECOVERY_MS: "2000",
      PYTHON_WORKER_CANDIDATE_BATCH_SIZE: "512",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let workerStderr = "";
  worker.stderr.setEncoding("utf8");
  worker.stderr.on("data", (chunk: string) => { workerStderr += chunk; });
  const suite = randomUUID();
  const fixture = buildSyntheticFixture(1_260);

  const waitCompleted = async (run: PortfolioRunRecord, timeoutMs = 60_000): Promise<PortfolioRunRecord> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const current = await runRepository.get(run.id, run.ownerSubject);
      if (!current) throw new Error("benchmark run disappeared");
      if (current.status === "completed") return current;
      if (current.status === "failed" || current.status === "cancelled") {
        throw new Error(`benchmark run terminated: ${current.status} ${JSON.stringify(current.error)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("benchmark run deadline exceeded");
  };

  const workerMetric = async (runId: string) => {
    const output = await jobs.getOutput(runId);
    const artifact = output?.value.artifacts?.find((item) => item.type === "worker-metrics");
    if (!artifact || typeof artifact.content !== "object" || !artifact.content) throw new Error("worker metrics missing");
    return artifact.content as { compute_ms: number; max_rss_bytes: number; attempt: number };
  };

  const enqueueOptimization = async (label: string, seed: number) => {
    const started = performance.now();
    const dispatched = await runs.enqueueExternal({
      ownerSubject: `benchmark-${suite}-${label}`,
      kind: "optimization",
      config: { label, seed, candidateBudget: 1_000 },
      dataRevision: `synthetic-${suite}`,
      totalCandidates: 1_000,
      payload: {
        optimization: { ...fixture.optimization, seed, candidateBudget: 1_000 },
        objective: "robust_score",
        market_warnings: [],
        settings: { label, seed, candidateBudget: 1_000 },
      },
    });
    const enqueueMs = performance.now() - started;
    const queuedAt = performance.now();
    const completed = await waitCompleted(dispatched.run);
    return { run: completed, enqueueMs, queueAndComputeMs: performance.now() - queuedAt, metric: await workerMetric(completed.id) };
  };

  try {
    await enqueueOptimization("warmup", 8_001);
    const backtestDurations: number[] = [];
    const backtestCompute: number[] = [];
    for (let index = 0; index < 5; index += 1) {
      const started = performance.now();
      const dispatched = await runs.enqueueExternal({
        ownerSubject: `benchmark-${suite}-backtest-${index}`,
        kind: "backtest",
        config: { index, kind: "backtest" },
        dataRevision: `synthetic-${suite}`,
        payload: {
          simulation: fixture.backtest,
        },
      });
      const completed = await waitCompleted(dispatched.run);
      backtestDurations.push(performance.now() - started);
      backtestCompute.push((await workerMetric(completed.id)).compute_ms);
    }

    const optimizationRuns = [];
    for (let index = 0; index < 3; index += 1) optimizationRuns.push(await enqueueOptimization(`measure-${index}`, 73_421 + index));
    const materializeStarted = performance.now();
    await runs.get(optimizationRuns[0]!.run.id, optimizationRuns[0]!.run.ownerSubject);
    const materializeMs = performance.now() - materializeStarted;
    assert.equal(await optimizationRepository.candidateCount(optimizationRuns[0]!.run.id), 1_000);

    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{\"ok\":true}");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("health benchmark address unavailable");
    const probe = fork(fileURLToPath(import.meta.url), ["--probe-child"], {
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    });
    await new Promise<void>((resolve) => probe.on("message", (message: { type?: string }) => {
      if (message.type === "booted") resolve();
    }));
    const ready = new Promise<void>((resolve) => probe.on("message", (message: { type?: string }) => {
      if (message.type === "ready") resolve();
    }));
    probe.send({ type: "start", url: `http://127.0.0.1:${address.port}/health`, intervalMs: 25 });
    await ready;
    const eventLoop = monitorEventLoopDelay({ resolution: 10 });
    eventLoop.enable();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const concurrentStarted = performance.now();
    const concurrent = await Promise.all([
      enqueueOptimization("concurrent-a", 90_001),
      enqueueOptimization("concurrent-b", 90_002),
    ]);
    const concurrentWallMs = performance.now() - concurrentStarted;
    await new Promise((resolve) => setTimeout(resolve, 50));
    eventLoop.disable();
    const probeResult = new Promise<ProbeResult>((resolve) => probe.on("message", (message: { type?: string; result?: ProbeResult }) => {
      if (message.type === "result" && message.result) resolve(message.result);
    }));
    probe.send({ type: "stop" });
    const health = await probeResult;
    probe.disconnect();
    await once(probe, "exit");
    server.close();
    await once(server, "close");

    const baseline = JSON.parse(readFileSync(new URL("../benchmarks/results/node-inline-baseline-2026-07-17.json", import.meta.url), "utf8")) as {
      phases: { backtest: { p50Ms: number }; optimization: { p50Ms: number } };
      responsiveness: { health: { p95Ms: number; timeouts: number }; eventLoop: { p99Ms: number } };
    };
    const optimizationCompute = optimizationRuns.map((item) => item.metric.compute_ms);
    const optimizationEndToEnd = optimizationRuns.map((item) => item.queueAndComputeMs + item.enqueueMs);
    const input = await jobs.getInput(optimizationRuns[0]!.run.id);
    const output = await jobs.getOutput(optimizationRuns[0]!.run.id);
    const result = {
      schemaVersion: "compute-benchmark-v1",
      generatedAt: new Date().toISOString(),
      engine: "python-worker-external",
      environment: {
        platform: `${process.platform}-${process.arch}`,
        node: process.version,
        python: "3.12",
        cpu: os.cpus()[0]?.model ?? "unknown",
        logicalCores: os.cpus().length,
        workerReplicas: 1,
      },
      fixture: { dayCount: 1_260, assetCount: fixture.backtest.assets.length, candidateBudget: 1_000 },
      phases: {
        backtestWorkerCompute: timing(backtestCompute),
        backtestEndToEnd: timing(backtestDurations),
        optimizationWorkerCompute: timing(optimizationCompute),
        optimizationEndToEnd: timing(optimizationEndToEnd),
        enqueue: timing(optimizationRuns.map((item) => item.enqueueMs)),
        nodeMaterializationMs: round(materializeMs),
        inputArtifactBytes: input?.artifact.byteCount ?? 0,
        outputArtifactBytes: output?.artifact.byteCount ?? 0,
      },
      responsiveness: {
        concurrentJobs: 2,
        concurrentWallMs: round(concurrentWallMs),
        workerComputeMs: concurrent.map((item) => round(item.metric.compute_ms)),
        health,
        eventLoop: {
          p95Ms: round(eventLoop.percentile(95) / 1_000_000),
          p99Ms: round(eventLoop.percentile(99) / 1_000_000),
          maxMs: round(eventLoop.max / 1_000_000),
        },
      },
      comparison: {
        backtestComputeSpeedup: round(baseline.phases.backtest.p50Ms / percentile(backtestCompute, 0.5)),
        optimizationComputeSpeedup: round(baseline.phases.optimization.p50Ms / percentile(optimizationCompute, 0.5)),
        healthP95BeforeMs: baseline.responsiveness.health.p95Ms,
        healthP95AfterMs: health.p95Ms,
        healthTimeoutsBefore: baseline.responsiveness.health.timeouts,
        healthTimeoutsAfter: health.timeouts,
        eventLoopP99BeforeMs: baseline.responsiveness.eventLoop.p99Ms,
        eventLoopP99AfterMs: round(eventLoop.percentile(99) / 1_000_000),
      },
      process: {
        workerMaxRssBytes: Math.max(...optimizationRuns.map((item) => item.metric.max_rss_bytes)),
        nodeRssBytes: process.memoryUsage().rss,
      },
    };
    const outputPath = new URL("../benchmarks/results/python-worker-external-2026-07-17.json", import.meta.url);
    writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    worker.kill("SIGTERM");
    if (worker.exitCode === null) {
      await Promise.race([once(worker, "exit"), new Promise((resolve) => setTimeout(resolve, 5_000))]);
    }
    await database.close();
    if (worker.exitCode && worker.exitCode !== 0 && worker.exitCode !== 143) {
      throw new Error(`Python benchmark worker exited with ${worker.exitCode}: ${workerStderr}`);
    }
  }
}
