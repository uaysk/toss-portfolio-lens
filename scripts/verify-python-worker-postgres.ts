import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { openPostgresDatabase } from "../server/database.js";
import { ArtifactRepository } from "../server/repositories/artifact-repository.js";
import { OptimizationRepository } from "../server/repositories/optimization-repository.js";
import { RunJobRepository } from "../server/repositories/run-job-repository.js";
import { RunRepository } from "../server/repositories/run-repository.js";
import { ArtifactService } from "../server/services/artifact-service.js";
import { RunService } from "../server/services/run-service.js";
import { WORKER_PAYLOAD_SCHEMA_VERSION, type WorkerInput } from "../server/worker/contracts.js";

const host = process.env.POSTGRES_TEST_HOST || "127.0.0.1";
const port = Number.parseInt(process.env.POSTGRES_TEST_PORT || "35433", 10);
const user = process.env.POSTGRES_TEST_USER || "portfolio_test";
const password = process.env.POSTGRES_TEST_PASSWORD || "integration-password";
const databaseName = process.env.POSTGRES_TEST_DATABASE || "portfolio_lens_test";
const conninfo = `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(databaseName)}`;

const database = await openPostgresDatabase({
  host,
  port,
  user,
  password,
  database: databaseName,
  connectTimeoutMs: 5_000,
});
const runRepository = new RunRepository(database);
const artifactRepository = new ArtifactRepository(database);
const optimizationRepository = new OptimizationRepository(database);
const jobs = new RunJobRepository(database);
await runRepository.initialize();
await artifactRepository.initialize();
await optimizationRepository.initialize();
await jobs.initialize();
const artifacts = new ArtifactService(artifactRepository, 100, 256_000);
const runs = new RunService(runRepository, artifacts, 1, 4, {
  executionMode: "external",
  jobRepository: jobs,
  resultPollMs: 25,
  resultDeadlineMs: 30_000,
  optimizationRepository,
});
await runs.initialize();

const worker = spawn("uv", ["run", "--frozen", "portfolio-compute-worker", "run"], {
  cwd: new URL("../worker/python", import.meta.url),
  env: {
    ...process.env,
    UV_CACHE_DIR: process.env.UV_CACHE_DIR ?? "/tmp/tpl-uv-cache",
    POSTGRES_URL: conninfo,
    PYTHON_WORKER_ID: `integration-${randomUUID()}`,
    PYTHON_WORKER_POLL_MS: "25",
    PYTHON_WORKER_LEASE_MS: "6000",
    PYTHON_WORKER_HEARTBEAT_MS: "1000",
    PYTHON_WORKER_RECOVERY_MS: "1000",
    PYTHON_WORKER_CANDIDATE_BATCH_SIZE: "128",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let workerStderr = "";
worker.stderr.setEncoding("utf8");
worker.stderr.on("data", (chunk: string) => { workerStderr += chunk; });

function day(index: number): string {
  return new Date(Date.UTC(2025, 0, 1 + index)).toISOString().slice(0, 10);
}

function prices(key: string, phase: number) {
  let value = 100 + phase * 10;
  return {
    key,
    label: key,
    points: Array.from({ length: 180 }, (_, index) => {
      value *= 1 + 0.0003 + Math.sin(index / 13 + phase) * 0.004;
      return { date: day(index), value };
    }),
  };
}

try {
  const suite = randomUUID();
  const backtest = await runs.executeExternal({
    ownerSubject: `python-worker-e2e-${suite}`,
    kind: "backtest",
    config: { suite, kind: "backtest" },
    dataRevision: `synthetic-${suite}`,
    payload: {
      simulation: {
        assets: [
          { symbol: "A", name: "Asset A", market: "KRX", currency: "KRW", listDate: day(0), weight: 60 },
          { symbol: "B", name: "Asset B", market: "NASDAQ", currency: "USD", listDate: day(0), weight: 40 },
        ],
        prices: {
          "KRW:A": prices("A", 0.2).points.map((point) => ({ date: point.date, close: point.value, localClose: point.value, fxRate: 1 })),
          "USD:B": prices("B", 1.3).points.map((point, index) => ({
            date: point.date,
            close: point.value * (1_100 + index * 0.2),
            localClose: point.value,
            fxRate: 1_100 + index * 0.2,
          })),
        },
        requestedStartDate: day(0),
        endDate: day(179),
        initialAmount: 10_000_000,
        monthlyCashFlow: 100_000,
        rebalanceFrequency: "quarterly",
        riskFreeRatePercent: 2,
        transactionCostBps: 10,
      },
      response_context: {
        effective_requested_start: day(0),
        currency_method: "KRW_FX_CONVERTED",
        config: { suite, effectiveStartDate: "worker-overwrites", effectiveEndDate: "worker-overwrites" },
        assets: [
          { symbol: "A", name: "Asset A", market: "KRX", currency: "KRW", listDate: day(0), weight: 60 },
          { symbol: "B", name: "Asset B", market: "NASDAQ", currency: "USD", listDate: day(0), weight: 40 },
        ],
        warnings: ["integration-warning"],
      },
    },
  });
  assert.equal(backtest.run.status, "completed");
  assert.equal((backtest.run.result as { points: unknown[] }).points.length, 180);
  assert.deepEqual(backtest.run.warnings, ["integration-warning"]);
  assert.deepEqual((await artifacts.list(backtest.run.id)).map((item) => item.type), [
    "correlation",
    "drawdown",
    "equity",
    "holdings",
    "monthly-returns",
    "risk-contribution",
    "rolling",
    "trades",
  ]);
  await database.run("DELETE FROM portfolio_backtest_artifacts WHERE run_id = ?", [backtest.run.id]);
  assert.equal((await artifacts.list(backtest.run.id)).length, 0);
  assert.equal((await runs.findReusable({
    ownerSubject: backtest.run.ownerSubject,
    kind: "backtest",
    config: { suite, kind: "backtest" },
    dataRevision: backtest.run.dataRevision,
  }))?.id, backtest.run.id);
  assert.equal((await artifacts.list(backtest.run.id)).length, 8);

  const optimizationInput = {
    priceSeries: [prices("A", 0.2), prices("B", 1.3), prices("C", 2.4)],
    constraints: { minWeight: 0, maxWeight: 0.8, maxAssets: 3 },
    seed: 12345,
    candidateBudget: 120,
    riskFreeRatePercent: 2,
    transactionCostBps: 10,
  };
  const optimization = await runs.enqueueExternal({
    ownerSubject: `python-worker-e2e-${suite}`,
    kind: "optimization",
    config: { suite, kind: "optimization" },
    dataRevision: `synthetic-${suite}`,
    totalCandidates: 120,
    payload: {
      optimization: optimizationInput,
      objective: "max_sharpe",
      market_warnings: ["market-warning"],
      settings: { source: "integration" },
    },
  });
  let completed = optimization.run;
  const deadline = Date.now() + 30_000;
  while (completed.status !== "completed" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    completed = (await runs.get(completed.id, completed.ownerSubject)) ?? completed;
    if (completed.status === "failed" || completed.status === "cancelled") break;
  }
  assert.equal(completed.status, "completed");
  assert.equal((completed.summary as { candidate_count: number }).candidate_count, 120);
  assert.equal((await optimizationRepository.candidateCount(completed.id)), 120);
  assert.equal((await artifacts.get(completed.id, "candidates"))?.descriptor.rowCount, 120);
  assert.equal((await jobs.getOutput(completed.id))?.value.warnings[0], "market-warning");

  const invalid = await runs.enqueueExternal({
    ownerSubject: `python-worker-invalid-${suite}`,
    kind: "optimization",
    config: { suite, kind: "invalid" },
    dataRevision: `synthetic-${suite}`,
    maxAttempts: 1,
    payload: { optimization: "not-an-object", objective: "max_sharpe" },
  });
  let invalidRun = invalid.run;
  const invalidDeadline = Date.now() + 30_000;
  while (invalidRun.status !== "failed" && Date.now() < invalidDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    invalidRun = (await runRepository.get(invalidRun.id, invalidRun.ownerSubject)) ?? invalidRun;
  }
  assert.equal(invalidRun.status, "failed");
  assert.equal((invalidRun.error as { code?: string }).code, "INVALID_WORKER_INPUT");

  const cancellable = await runs.enqueueExternal({
    ownerSubject: `python-worker-cancel-${suite}`,
    kind: "optimization",
    config: { suite, kind: "cancel" },
    dataRevision: `synthetic-${suite}`,
    totalCandidates: 5_000,
    payload: {
      optimization: { ...optimizationInput, candidateBudget: 5_000, seed: 98_765 },
      objective: "robust_score",
      market_warnings: [],
      settings: { source: "cancellation-integration" },
    },
  });
  let cancellableJob = await jobs.get(cancellable.run.id);
  const cancellationDeadline = Date.now() + 30_000;
  while (cancellableJob?.state === "queued" && Date.now() < cancellationDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    cancellableJob = await jobs.get(cancellable.run.id);
  }
  assert.equal(cancellableJob?.state, "running");
  assert.equal(await runs.cancel(cancellable.run.id, cancellable.run.ownerSubject), true);
  let cancelledRun = cancellable.run;
  while (cancelledRun.status !== "cancelled" && Date.now() < cancellationDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    cancelledRun = (await runRepository.get(cancelledRun.id, cancelledRun.ownerSubject)) ?? cancelledRun;
  }
  assert.equal(cancelledRun.status, "cancelled");
  assert.equal((await jobs.get(cancelledRun.id))?.state, "cancelled");

  const deadlineRuns = new RunService(runRepository, artifacts, 1, 4, {
    executionMode: "external",
    jobRepository: jobs,
    runDeadlineMs: 400,
    resultPollMs: 25,
    resultDeadlineMs: 30_000,
    optimizationRepository,
  });
  const deadlineRun = await deadlineRuns.enqueueExternal({
    ownerSubject: `python-worker-deadline-${suite}`,
    kind: "optimization",
    config: { suite, kind: "deadline" },
    dataRevision: `synthetic-${suite}`,
    totalCandidates: 5_000,
    payload: {
      optimization: { ...optimizationInput, candidateBudget: 5_000, seed: 55_555 },
      objective: "robust_score",
      market_warnings: [],
      settings: { source: "deadline-integration" },
    },
  });
  let deadlineJob = await jobs.get(deadlineRun.run.id);
  const workerClaimDeadline = Date.now() + 5_000;
  while (deadlineJob?.state === "queued" && Date.now() < workerClaimDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    deadlineJob = await jobs.get(deadlineRun.run.id);
  }
  assert.equal(deadlineJob?.state, "running");
  let expiredRun = deadlineRun.run;
  const terminalDeadline = Date.now() + 10_000;
  while (expiredRun.status !== "failed" && Date.now() < terminalDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    expiredRun = (await runRepository.get(expiredRun.id, expiredRun.ownerSubject)) ?? expiredRun;
  }
  assert.equal(expiredRun.status, "failed");
  assert.equal((expiredRun.error as { code?: string }).code, "RUN_DEADLINE_EXCEEDED");
  assert.equal((await jobs.get(expiredRun.id))?.state, "failed");

  const unsupportedRun = await runRepository.create({
    kind: "optimization",
    ownerSubject: `python-worker-version-${suite}`,
    requestHash: "f".repeat(64),
    dataRevision: `synthetic-${suite}`,
    engineVersion: "unsupported-engine-v0",
    config: { suite, kind: "unsupported-engine" },
  });
  const unsupportedInput: WorkerInput = {
    schema_version: WORKER_PAYLOAD_SCHEMA_VERSION,
    engine_version: unsupportedRun.engineVersion,
    run_id: unsupportedRun.id,
    job_kind: "optimization",
    data_revision: unsupportedRun.dataRevision,
    request_hash: unsupportedRun.requestHash,
    payload: { optimization: optimizationInput, objective: "robust_score" },
  };
  const unsupportedArtifact = await jobs.putInput(unsupportedInput);
  await jobs.enqueue({
    runId: unsupportedRun.id,
    kind: unsupportedRun.kind,
    inputArtifactId: unsupportedArtifact.id,
    deadlineAt: Date.now() + 5_000,
  });
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal((await jobs.get(unsupportedRun.id))?.state, "queued");
  assert.equal(await jobs.cancel(unsupportedRun.id, unsupportedRun.ownerSubject), "cancelled");

  process.stdout.write(`${JSON.stringify({
    schema: "python-worker-e2e-v1",
    backtest: { status: backtest.run.status, artifacts: 8 },
    optimization: { status: completed.status, candidates: 120 },
    invalidPayload: invalidRun.status,
    cancellation: cancelledRun.status,
    durableDeadline: expiredRun.status,
    incompatibleEngine: "not-claimed",
    workerExitBeforeStop: worker.exitCode,
  })}\n`);
} finally {
  worker.kill("SIGTERM");
  if (worker.exitCode === null) {
    await Promise.race([once(worker, "exit"), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  }
  await database.close();
  if (worker.exitCode && worker.exitCode !== 0 && worker.exitCode !== 143) {
    throw new Error(`Python worker exited with ${worker.exitCode}: ${workerStderr}`);
  }
}
