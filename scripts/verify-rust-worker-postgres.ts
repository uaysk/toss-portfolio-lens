import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { openPostgresDatabase } from "../server/database.js";
import { ArtifactRepository } from "../server/repositories/artifact-repository.js";
import { OptimizationRepository } from "../server/repositories/optimization-repository.js";
import { RunJobRepository } from "../server/repositories/run-job-repository.js";
import { RunRepository, type PortfolioRunRecord } from "../server/repositories/run-repository.js";
import { ArtifactService } from "../server/services/artifact-service.js";
import { PORTFOLIO_ENGINE_VERSION } from "../server/services/service-envelope.js";
import { RunService } from "../server/services/run-service.js";
import {
  WORKER_PAYLOAD_SCHEMA_VERSION,
  type WorkerInput,
} from "../server/worker/contracts.js";

const host = process.env.POSTGRES_TEST_HOST || "127.0.0.1";
const port = Number.parseInt(process.env.POSTGRES_TEST_PORT || "35433", 10);
const user = process.env.POSTGRES_TEST_USER || "portfolio_test";
const password = process.env.POSTGRES_TEST_PASSWORD || "integration-password";
const databaseName = process.env.POSTGRES_TEST_DATABASE || "portfolio_lens_test";
const conninfo = `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(databaseName)}`;
const workerBinary = fileURLToPath(new URL("../worker/rust/target/release/portfolio-lens-worker", import.meta.url));

if (!existsSync(workerBinary)) {
  throw new Error(`Rust release worker가 없습니다: ${workerBinary} (cargo build --release --locked를 먼저 실행하세요.)`);
}

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

const worker = spawn(workerBinary, ["run"], {
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  env: {
    ...process.env,
    POSTGRES_URL: conninfo,
    WORKER_ID: `rust-postgres-e2e-${randomUUID()}`,
    WORKER_POLL_MS: "25",
    WORKER_LEASE_MS: "6000",
    WORKER_HEARTBEAT_MS: "500",
    WORKER_RECOVERY_MS: "1000",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let workerStderr = "";
worker.stderr.setEncoding("utf8");
worker.stderr.on("data", (chunk: string) => {
  workerStderr = `${workerStderr}${chunk}`.slice(-16_384);
});

function day(index: number): string {
  return new Date(Date.UTC(2025, 0, 1 + index)).toISOString().slice(0, 10);
}

function priceSeries(key: string, phase: number) {
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

async function waitForStatus(
  runId: string,
  ownerSubject: string,
  terminal: ReadonlySet<PortfolioRunRecord["status"]>,
  timeoutMs = 30_000,
): Promise<PortfolioRunRecord> {
  const deadline = Date.now() + timeoutMs;
  let current = await runs.get(runId, ownerSubject);
  while (current && !terminal.has(current.status) && Date.now() < deadline) {
    if (worker.exitCode !== null || worker.signalCode !== null) {
      throw new Error(`Rust worker가 실행 도중 종료되었습니다: ${worker.exitCode ?? worker.signalCode}\n${workerStderr}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
    current = await runs.get(runId, ownerSubject);
  }
  if (!current || !terminal.has(current.status)) {
    const job = await jobs.get(runId);
    throw new Error(`run ${runId}이 제한 시간 안에 종료되지 않았습니다: ${JSON.stringify({ run: current, job, workerStderr })}`);
  }
  return current;
}

async function waitForJobState(
  runId: string,
  expected: "running" | "completed" | "failed" | "cancelled",
  timeoutMs = 10_000,
) {
  const deadline = Date.now() + timeoutMs;
  let current = await jobs.get(runId);
  while (current?.state !== expected && Date.now() < deadline) {
    if (worker.exitCode !== null || worker.signalCode !== null) {
      throw new Error(`Rust worker가 job 대기 중 종료되었습니다: ${worker.exitCode ?? worker.signalCode}\n${workerStderr}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    current = await jobs.get(runId);
  }
  assert.equal(current?.state, expected, `run ${runId} job state가 ${expected}에 도달해야 합니다.`);
  return current;
}

async function verifyDurableOutputIdentity(run: PortfolioRunRecord) {
  const storedInput = await jobs.getInput(run.id);
  const storedOutput = await jobs.getOutput(run.id);
  assert.ok(storedInput, "durable worker input artifact가 있어야 합니다.");
  assert.ok(storedOutput, "durable worker output artifact가 있어야 합니다.");

  assert.equal(storedInput.value.run_id, run.id);
  assert.equal(storedInput.value.job_kind, run.kind);
  assert.equal(storedInput.value.engine_version, run.engineVersion);
  assert.equal(storedInput.value.data_revision, run.dataRevision);
  assert.equal(storedInput.value.request_hash, run.requestHash);

  assert.equal(storedOutput.value.status, "completed");
  assert.equal(storedOutput.value.run_id, run.id);
  assert.equal(storedOutput.value.job_kind, run.kind);
  assert.equal(storedOutput.value.engine_version, PORTFOLIO_ENGINE_VERSION);
  assert.equal(storedOutput.value.data_revision, run.dataRevision);
  assert.equal(storedOutput.value.request_hash, run.requestHash);
  assert.match(storedOutput.value.payload_hash ?? "", /^[a-f0-9]{64}$/);

  const source = gunzipSync(storedOutput.artifact.content);
  assert.equal(storedOutput.artifact.byteCount, storedOutput.artifact.content.byteLength);
  assert.equal(storedOutput.artifact.uncompressedByteCount, source.byteLength);
  assert.equal(createHash("sha256").update(source).digest("hex"), storedOutput.artifact.checksum);
  assert.equal(storedOutput.artifact.role, "output");
  assert.equal(storedOutput.artifact.schemaVersion, WORKER_PAYLOAD_SCHEMA_VERSION);
  assert.equal(storedOutput.artifact.dataRevision, run.dataRevision);

  return storedOutput;
}

try {
  const suite = randomUUID();
  const assetA = priceSeries("KRW:A", 0.2);
  const assetB = priceSeries("USD:B", 1.3);
  const assetC = priceSeries("KRW:C", 2.4);
  const backtestOwner = `rust-worker-backtest-${suite}`;
  const backtest = await runs.executeExternal({
    ownerSubject: backtestOwner,
    kind: "backtest",
    config: { suite, kind: "backtest", engine: "rust-postgres" },
    dataRevision: `synthetic-rust-${suite}`,
    payload: {
      simulation: {
        assets: [
          { symbol: "A", name: "Asset A", market: "KRX", currency: "KRW", listDate: day(0), weight: 55 },
          { symbol: "B", name: "Asset B", market: "NASDAQ", currency: "USD", listDate: day(0), weight: 35 },
        ],
        prices: {
          "KRW:A": assetA.points.map((point) => ({
            date: point.date,
            close: point.value,
            localClose: point.value,
            fxRate: 1,
          })),
          "USD:B": assetB.points.map((point, index) => {
            const fxRate = 1_100 + index * 0.35;
            return {
              date: point.date,
              close: point.value * fxRate,
              localClose: point.value,
              fxRate,
            };
          }),
        },
        requestedStartDate: day(0),
        endDate: day(179),
        initialAmount: 10_000_000,
        monthlyCashFlow: 100_000,
        cashFlowFrequency: "monthly",
        cashFlowTiming: "period_start",
        cashFlows: [
          { date: day(45), amount: 400_000, memo: "bonus contribution" },
          { date: day(75), amount: -250_000, memo: "planned withdrawal" },
        ],
        rebalanceFrequency: "quarterly",
        rebalanceThresholdPercent: 4,
        riskFreeRatePercent: 2,
        transactionCostBps: 12,
        execution: {
          cashTargetPercent: 10,
          quantityMode: "whole",
          cashFlowRebalanceMode: "drift_reduction",
          tradeDatePolicy: "next_common_observation",
          cashAnnualYieldPercent: 1.5,
        },
      },
      response_context: {
        effective_requested_start: day(0),
        currency_method: "KRW_HISTORICAL_FX",
        config: { suite, source: "rust-postgres-e2e" },
        assets: [
          { symbol: "A", name: "Asset A", market: "KRX", currency: "KRW", listDate: day(0), weight: 55 },
          { symbol: "B", name: "Asset B", market: "NASDAQ", currency: "USD", listDate: day(0), weight: 35 },
        ],
        warnings: ["rust-postgres-backtest-warning"],
      },
    },
  });
  assert.equal(backtest.run.status, "completed");
  assert.equal(backtest.run.engineVersion, PORTFOLIO_ENGINE_VERSION);
  const backtestResult = backtest.run.result as {
    points: unknown[];
    trades: unknown[];
    cashFlows: unknown[];
    metrics: { totalTransactionCosts: number; moneyWeightedReturnPercent: number | null };
  };
  assert.equal(backtestResult.points.length, 180);
  assert.ok(backtestResult.trades.length > 2);
  assert.ok(backtestResult.cashFlows.length > 2);
  assert.ok(backtestResult.metrics.totalTransactionCosts > 0);
  assert.notEqual(backtestResult.metrics.moneyWeightedReturnPercent, null);
  assert.deepEqual(backtest.run.warnings, ["rust-postgres-backtest-warning"]);
  assert.deepEqual((await artifacts.list(backtest.run.id)).map((item) => item.type), [
    "cash-flows",
    "cash-ledger",
    "correlation",
    "drawdown",
    "equity",
    "holdings",
    "monthly-returns",
    "risk-contribution",
    "rolling",
    "trades",
  ]);
  const backtestOutput = await verifyDurableOutputIdentity(backtest.run);
  assert.ok(backtestOutput.value.artifacts?.some((artifact) => artifact.type === "worker-metrics"));

  const optimizationInput = {
    priceSeries: [assetA, assetB, assetC],
    constraints: {
      minWeight: 0,
      maxWeight: 0.8,
      maxAssets: 3,
      currentWeights: { "KRW:A": 0.5, "USD:B": 0.3, "KRW:C": 0.2 },
      maxTurnover: 1,
    },
    seed: 12_345,
    candidateBudget: 120,
    minimumSamples: 30,
    riskFreeRatePercent: 2,
    transactionCostBps: 12,
  };
  const optimizationOwner = `rust-worker-optimization-${suite}`;
  const optimization = await runs.enqueueExternal({
    ownerSubject: optimizationOwner,
    kind: "optimization",
    config: { suite, kind: "optimization", engine: "rust-postgres" },
    dataRevision: `synthetic-rust-${suite}`,
    totalCandidates: 120,
    payload: {
      optimization: optimizationInput,
      objective: "max_sharpe",
      market_warnings: ["rust-postgres-market-warning"],
      settings: { source: "rust-postgres-e2e" },
    },
  });
  const completedOptimization = await waitForStatus(
    optimization.run.id,
    optimizationOwner,
    new Set(["completed", "failed", "cancelled"]),
  );
  assert.equal(completedOptimization.status, "completed");
  assert.equal((completedOptimization.summary as { candidate_count: number }).candidate_count, 120);
  assert.equal((await optimizationRepository.candidateCount(completedOptimization.id)), 120);
  assert.equal((await optimizationRepository.listCandidates(completedOptimization.id, 5)).length, 5);
  assert.equal((await artifacts.get(completedOptimization.id, "candidates"))?.descriptor.rowCount, 120);
  const optimizationOutput = await verifyDurableOutputIdentity(completedOptimization);
  assert.equal(optimizationOutput.value.warnings[0], "rust-postgres-market-warning");
  assert.equal(
    optimizationOutput.value.artifacts?.find((artifact) => artifact.type === "candidates")?.row_count,
    120,
  );

  const invalidOwner = `rust-worker-invalid-${suite}`;
  const invalid = await runs.enqueueExternal({
    ownerSubject: invalidOwner,
    kind: "optimization",
    config: { suite, kind: "invalid-rust-input" },
    dataRevision: `synthetic-rust-${suite}`,
    maxAttempts: 1,
    payload: { optimization: "not-an-object", objective: "max_sharpe" },
  });
  const invalidRun = await waitForStatus(
    invalid.run.id,
    invalidOwner,
    new Set(["failed", "cancelled", "completed"]),
  );
  assert.equal(invalidRun.status, "failed");
  assert.equal((invalidRun.error as { code?: string }).code, "INVALID_WORKER_INPUT");
  assert.equal((await jobs.get(invalidRun.id))?.state, "failed");
  assert.equal((await jobs.get(invalidRun.id))?.attemptCount, 1);
  assert.equal(await jobs.getOutput(invalidRun.id), undefined);

  const cancellationOwner = `rust-worker-queued-cancel-${suite}`;
  const cancellationHash = createHash("sha256").update(`${suite}:queued-cancellation`).digest("hex");
  const cancellableRun = await runRepository.create({
    kind: "optimization",
    ownerSubject: cancellationOwner,
    requestHash: cancellationHash,
    dataRevision: `synthetic-rust-${suite}`,
    engineVersion: PORTFOLIO_ENGINE_VERSION,
    config: { suite, kind: "queued-cancellation" },
    totalCandidates: 120,
  });
  const cancellationInput: WorkerInput = {
    schema_version: WORKER_PAYLOAD_SCHEMA_VERSION,
    engine_version: cancellableRun.engineVersion,
    run_id: cancellableRun.id,
    job_kind: "optimization",
    data_revision: cancellableRun.dataRevision,
    request_hash: cancellableRun.requestHash,
    payload: { optimization: optimizationInput, objective: "robust_score" },
  };
  const cancellationArtifact = await jobs.putInput(cancellationInput);
  const cancellationNow = Date.now();
  await jobs.enqueue({
    runId: cancellableRun.id,
    kind: cancellableRun.kind,
    inputArtifactId: cancellationArtifact.id,
    availableAt: cancellationNow + 60_000,
    deadlineAt: cancellationNow + 120_000,
  });
  assert.equal((await jobs.get(cancellableRun.id))?.attemptCount, 0);
  assert.equal(await jobs.cancel(cancellableRun.id, cancellationOwner), "cancelled");
  assert.equal((await jobs.get(cancellableRun.id))?.state, "cancelled");
  assert.equal((await runRepository.get(cancellableRun.id, cancellationOwner))?.status, "cancelled");
  assert.equal((await jobs.get(cancellableRun.id))?.attemptCount, 0);

  const runningCancellationOwner = `rust-worker-running-cancel-${suite}`;
  const runningCancellation = await runs.enqueueExternal({
    ownerSubject: runningCancellationOwner,
    kind: "monte_carlo",
    config: { suite, kind: "running-cancellation" },
    dataRevision: `synthetic-rust-${suite}`,
    totalCandidates: 100_000,
    payload: {
      monte_carlo: {
        priceSeries: [assetA, assetB],
        weights: { "KRW:A": 0.5, "USD:B": 0.5 },
        initialAmount: 10_000_000,
        horizonDays: 250,
        pathCount: 100_000,
        blockLength: 10,
        seed: 42,
        quantiles: [0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95],
        samplePathCount: 0,
      },
    },
  });
  await waitForJobState(runningCancellation.run.id, "running");
  const cancellationStarted = performance.now();
  assert.equal(await runs.cancel(runningCancellation.run.id, runningCancellationOwner), true);
  const cancelledDuringCompute = await waitForStatus(
    runningCancellation.run.id,
    runningCancellationOwner,
    new Set(["cancelled", "completed", "failed"]),
    5_000,
  );
  const runningCancellationMs = performance.now() - cancellationStarted;
  assert.equal(cancelledDuringCompute.status, "cancelled");
  assert.ok(runningCancellationMs < 2_000, `running cancellation은 2초 안에 반영되어야 합니다: ${runningCancellationMs}ms`);
  assert.equal(await jobs.getOutput(runningCancellation.run.id), undefined);
  assert.equal((await jobs.get(runningCancellation.run.id))?.attemptCount, 1);

  const afterCancellationOwner = `rust-worker-after-cancel-${suite}`;
  const afterCancellation = await runs.enqueueExternal({
    ownerSubject: afterCancellationOwner,
    kind: "optimization",
    config: { suite, kind: "after-running-cancellation" },
    dataRevision: `synthetic-rust-${suite}`,
    totalCandidates: 12,
    payload: {
      optimization: { ...optimizationInput, candidateBudget: 12 },
      objective: "max_sharpe",
    },
  });
  const afterCancellationRun = await waitForStatus(
    afterCancellation.run.id,
    afterCancellationOwner,
    new Set(["completed", "failed", "cancelled"]),
  );
  assert.equal(afterCancellationRun.status, "completed");

  process.stdout.write(`${JSON.stringify({
    schema: "rust-worker-postgres-e2e-v1",
    engine: PORTFOLIO_ENGINE_VERSION,
    backtest: {
      status: backtest.run.status,
      points: backtestResult.points.length,
      publicArtifacts: 10,
      checksum: backtestOutput.artifact.checksum,
    },
    optimization: {
      status: completedOptimization.status,
      candidates: 120,
      checksum: optimizationOutput.artifact.checksum,
    },
    invalidPayload: invalidRun.status,
    queuedCancellation: "cancelled",
    runningCancellation: {
      status: cancelledDuringCompute.status,
      latencyMs: Number(runningCancellationMs.toFixed(3)),
      outputArtifact: false,
    },
    nextJobAfterCancellation: afterCancellationRun.status,
    workerExitBeforeStop: worker.exitCode,
  })}\n`);
} finally {
  worker.kill("SIGTERM");
  if (worker.exitCode === null && worker.signalCode === null) {
    await Promise.race([once(worker, "exit"), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  }
  await database.close();
  if (worker.exitCode !== null && worker.exitCode !== 0) {
    throw new Error(`Rust worker exited with ${worker.exitCode}: ${workerStderr}`);
  }
}
