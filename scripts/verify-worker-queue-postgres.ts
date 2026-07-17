import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { openPostgresDatabase } from "../server/database.js";
import { RunJobRepository } from "../server/repositories/run-job-repository.js";
import { RunRepository, type PortfolioRunKind } from "../server/repositories/run-repository.js";
import { WORKER_PAYLOAD_SCHEMA_VERSION, type WorkerInput, type WorkerOutput } from "../server/worker/contracts.js";

const database = await openPostgresDatabase({
  host: process.env.POSTGRES_TEST_HOST || "127.0.0.1",
  port: Number.parseInt(process.env.POSTGRES_TEST_PORT || "35433", 10),
  user: process.env.POSTGRES_TEST_USER || "portfolio_test",
  password: process.env.POSTGRES_TEST_PASSWORD || "integration-password",
  database: process.env.POSTGRES_TEST_DATABASE || "portfolio_lens_test",
  connectTimeoutMs: 5_000,
});

const runs = new RunRepository(database);
const jobs = new RunJobRepository(database);
await runs.initialize();
await jobs.initialize();
await jobs.initialize();
for (let pass = 0; pass < 10; pass += 1) {
  const recovered = await jobs.recoverExpiredLeases(Date.now(), 1_000);
  if (recovered.requeued + recovered.failed + recovered.cancelled === 0) break;
}

let counter = 0;
const suiteId = randomUUID();
async function createJob(input: {
  kind?: PortfolioRunKind;
  priority?: number;
  maxAttempts?: number;
  deadlineAt?: number;
  now?: number;
} = {}) {
  counter += 1;
  const now = input.now ?? 1_000_000 + counter * 10_000;
  const kind = input.kind ?? "optimization";
  const requestHash = createHash("sha256").update(`${suiteId}:${counter}`).digest("hex");
  const run = await runs.create({
    kind,
    ownerSubject: `worker-queue-test-${suiteId}-${counter}`,
    requestHash,
    dataRevision: "synthetic-v1",
    engineVersion: "python-worker-test-v1",
    config: { counter },
    totalCandidates: 10,
    now,
  });
  const payload: WorkerInput = {
    schema_version: WORKER_PAYLOAD_SCHEMA_VERSION,
    engine_version: run.engineVersion,
    run_id: run.id,
    job_kind: kind,
    data_revision: run.dataRevision,
    request_hash: requestHash,
    payload: { counter },
  };
  const artifact = await jobs.putInput(payload, now);
  const job = await jobs.enqueue({
    runId: run.id,
    kind,
    inputArtifactId: artifact.id,
    priority: input.priority,
    maxAttempts: input.maxAttempts,
    availableAt: now,
    deadlineAt: input.deadlineAt ?? now + 10_000_000,
    now,
  });
  return { run, job, payload, now };
}

try {
  const tableRows = await database.query<{ table_name: string }>(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('portfolio_run_jobs', 'portfolio_worker_artifacts')
  `);
  assert.deepEqual(new Set(tableRows.map((row) => row.table_name)), new Set([
    "portfolio_run_jobs",
    "portfolio_worker_artifacts",
  ]));

  counter += 1;
  const identityNow = 900_000;
  const identityHash = createHash("sha256").update(`${suiteId}:identity`).digest("hex");
  const identityRun = await runs.create({
    kind: "optimization",
    ownerSubject: `worker-queue-test-${suiteId}-identity`,
    requestHash: identityHash,
    dataRevision: "synthetic-v1",
    engineVersion: "python-worker-test-v1",
    config: { identity: true },
    now: identityNow,
  });
  const identityArtifact = await jobs.putInput({
    schema_version: WORKER_PAYLOAD_SCHEMA_VERSION,
    engine_version: identityRun.engineVersion,
    run_id: identityRun.id,
    job_kind: identityRun.kind,
    data_revision: identityRun.dataRevision,
    request_hash: identityHash,
    payload: { identity: true },
  }, identityNow);
  await assert.rejects(jobs.enqueue({
    runId: identityRun.id,
    kind: "backtest",
    inputArtifactId: identityArtifact.id,
    deadlineAt: identityNow + 10_000,
    now: identityNow,
  }), /immutable input artifact/);
  await runs.fail(identityRun.id, { code: "IDENTITY_FENCING_VERIFIED" }, [], identityNow + 1);

  const contentionJobs = await Promise.all([
    createJob({ priority: 0 }),
    createJob({ priority: -1 }),
    createJob({ priority: 1 }),
  ]);
  const claims = await Promise.all([
    jobs.claim("worker-a", 5_000, 2_000_000),
    jobs.claim("worker-b", 5_000, 2_000_000),
    jobs.claim("worker-c", 5_000, 2_000_000),
    jobs.claim("worker-d", 5_000, 2_000_000),
  ]);
  const claimed = claims.filter((job): job is NonNullable<typeof job> => Boolean(job));
  assert.equal(claimed.length, 3);
  assert.equal(new Set(claimed.map((job) => job.runId)).size, 3);
  assert.deepEqual(new Set(claimed.map((job) => job.runId)), new Set(contentionJobs.map((item) => item.run.id)));
  assert.deepEqual(claimed.map((job) => job.priority).sort((left, right) => left - right), [-1, 0, 1]);
  for (const claim of claimed) {
    assert.equal((await jobs.heartbeat(claim.runId, "wrong-lease", 5_000, 2_000_100)).renewed, false);
    assert.equal((await jobs.heartbeat(claim.runId, claim.leaseOwner!, 5_000, 2_000_100)).renewed, true);
    assert.equal((await jobs.fail({
      runId: claim.runId,
      leaseOwner: claim.leaseOwner!,
      error: { code: "TEST_END" },
      retryable: false,
      now: 2_000_200,
    })), "failed");
  }

  const queuedCancellation = await createJob();
  assert.equal(await jobs.cancel(queuedCancellation.run.id, queuedCancellation.run.ownerSubject, queuedCancellation.now + 1), "cancelled");
  assert.equal((await jobs.get(queuedCancellation.run.id))?.state, "cancelled");
  assert.equal((await runs.get(queuedCancellation.run.id))?.status, "cancelled");

  const runningCancellation = await createJob({ now: 3_000_000 });
  const runningClaim = await jobs.claim("worker-cancel", 5_000, 3_000_100);
  assert.equal(runningClaim?.runId, runningCancellation.run.id);
  assert.equal(await jobs.cancel(runningCancellation.run.id, runningCancellation.run.ownerSubject, 3_000_200), "requested");
  assert.equal((await jobs.heartbeat(runningClaim.runId, runningClaim.leaseOwner!, 5_000, 3_000_300)).cancellationRequested, true);
  const cancelledOutput: WorkerOutput = {
    schema_version: WORKER_PAYLOAD_SCHEMA_VERSION,
    engine_version: runningCancellation.run.engineVersion,
    run_id: runningCancellation.run.id,
    job_kind: runningCancellation.run.kind,
    status: "completed",
    summary: {},
    result: {},
    warnings: [],
  };
  assert.equal(await jobs.complete({
    runId: runningCancellation.run.id,
    leaseOwner: runningClaim.leaseOwner!,
    output: cancelledOutput,
    dataRevision: runningCancellation.run.dataRevision,
    now: 3_000_400,
  }), "cancelled");
  assert.equal((await jobs.get(runningCancellation.run.id))?.state, "cancelled");

  const recoverable = await createJob({ maxAttempts: 2, now: 4_000_000 });
  const recoverableClaim = await jobs.claim("worker-stale", 1_000, 4_000_100);
  assert.equal(recoverableClaim?.runId, recoverable.run.id);
  await jobs.recoverExpiredLeases(4_000_500);
  assert.equal((await jobs.get(recoverable.run.id))?.state, "running");
  assert.equal(await jobs.fail({
    runId: recoverable.run.id,
    leaseOwner: recoverableClaim.leaseOwner!,
    error: { code: "STALE_WORKER_MUST_NOT_COMMIT" },
    retryable: false,
    now: 4_001_101,
  }), "lost");
  await jobs.recoverExpiredLeases(4_001_101);
  assert.equal((await jobs.get(recoverable.run.id))?.state, "queued");

  const exhaustedClaim = await jobs.claim("worker-stale-2", 1_000, 4_001_200);
  assert.equal(exhaustedClaim?.runId, recoverable.run.id);
  await jobs.recoverExpiredLeases(4_002_201);
  assert.equal((await runs.get(recoverable.run.id))?.status, "failed");

  const completed = await createJob({ kind: "backtest", now: 5_000_000 });
  const completedClaim = await jobs.claim("worker-complete", 5_000, 5_000_100);
  assert.equal(completedClaim?.runId, completed.run.id);
  const output: WorkerOutput = {
    schema_version: WORKER_PAYLOAD_SCHEMA_VERSION,
    engine_version: completed.run.engineVersion,
    run_id: completed.run.id,
    job_kind: completed.run.kind,
    status: "completed",
    summary: { totalReturnPercent: 1.25 },
    result: { points: [{ date: "2026-01-01", balance: 100 }] },
    warnings: [],
  };
  assert.equal(await jobs.complete({
    runId: completed.run.id,
    leaseOwner: completedClaim.leaseOwner!,
    output,
    dataRevision: completed.run.dataRevision,
    now: 5_000_200,
  }), "completed");
  assert.equal(await jobs.complete({
    runId: completed.run.id,
    leaseOwner: completedClaim.leaseOwner!,
    output,
    dataRevision: completed.run.dataRevision,
    now: 5_000_300,
  }), "lost");
  assert.deepEqual((await jobs.getOutput(completed.run.id))?.value, output);
  const [outputCount] = await database.query<{ count: number }>(`
    SELECT COUNT(*) AS count FROM portfolio_worker_artifacts
    WHERE run_id = ? AND artifact_role = 'output'
  `, [completed.run.id]);
  const [eventCount] = await database.query<{ count: number }>(`
    SELECT COUNT(*) AS count FROM portfolio_run_events
    WHERE run_id = ? AND event_type = 'worker_completed'
  `, [completed.run.id]);
  assert.equal(Number(outputCount?.count), 1);
  assert.equal(Number(eventCount?.count), 1);

  const duplicate = await createJob({ now: 6_000_000 });
  await jobs.enqueue({
    runId: duplicate.run.id,
    kind: duplicate.run.kind,
    inputArtifactId: duplicate.job.inputArtifactId,
    now: 6_000_001,
  });
  const [enqueueEvents] = await database.query<{ count: number }>(`
    SELECT COUNT(*) AS count FROM portfolio_run_events
    WHERE run_id = ? AND event_type = 'external_enqueued'
  `, [duplicate.run.id]);
  assert.equal(Number(enqueueEvents?.count), 1);
  assert.equal(await jobs.cancel(duplicate.run.id, duplicate.run.ownerSubject, 6_000_002), "cancelled");

  const deadlineJob = await createJob({ now: 7_000_000, deadlineAt: 7_000_200 });
  const deadlineClaim = await jobs.claim("worker-deadline", 5_000, 7_000_100);
  assert.equal(deadlineClaim?.runId, deadlineJob.run.id);
  assert.equal((await jobs.heartbeat(
    deadlineClaim.runId,
    deadlineClaim.leaseOwner!,
    5_000,
    7_000_201,
  )).renewed, false);
  const deadlineRecovery = await jobs.recoverExpiredLeases(7_000_201);
  assert.equal(deadlineRecovery.failed, 1);
  assert.deepEqual((await runs.get(deadlineJob.run.id))?.error, {
    code: "RUN_DEADLINE_EXCEEDED",
    message: "external compute job의 절대 실행 시간을 초과했습니다.",
    retryable: true,
  });

  const retryNow = 8_000_000;
  assert.equal(await jobs.retryTerminal({
    runId: duplicate.run.id,
    ownerSubject: duplicate.run.ownerSubject,
    totalCandidates: 10,
    maxAttempts: 2,
    deadlineAt: retryNow + 10_000,
    now: retryNow,
  }), true);
  assert.deepEqual(await jobs.get(duplicate.run.id), {
    ...duplicate.job,
    state: "queued",
    availableAt: retryNow,
    deadlineAt: retryNow + 10_000,
    attemptCount: 0,
    maxAttempts: 2,
    updatedAt: retryNow,
  });
  assert.deepEqual(await runs.get(duplicate.run.id), {
    ...duplicate.run,
    status: "queued",
    progress: 0,
    completedCandidates: 0,
    totalCandidates: 10,
    warnings: [],
    updatedAt: retryNow,
  });
  assert.equal(await jobs.retryTerminal({
    runId: duplicate.run.id,
    ownerSubject: duplicate.run.ownerSubject,
    deadlineAt: retryNow + 20_000,
    now: retryNow + 1,
  }), false);
  assert.equal(await jobs.cancel(duplicate.run.id, duplicate.run.ownerSubject, retryNow + 2), "cancelled");

  assert.equal(await jobs.retryTerminal({
    runId: deadlineJob.run.id,
    ownerSubject: deadlineJob.run.ownerSubject,
    deadlineAt: retryNow + 30_000,
    now: retryNow + 3,
  }), true);
  assert.equal((await jobs.get(deadlineJob.run.id))?.state, "queued");
  assert.equal((await runs.get(deadlineJob.run.id))?.error, undefined);
  assert.equal(await jobs.cancel(deadlineJob.run.id, deadlineJob.run.ownerSubject, retryNow + 4), "cancelled");

  assert.equal(await jobs.retryTerminal({
    runId: completed.run.id,
    ownerSubject: completed.run.ownerSubject,
    deadlineAt: retryNow + 40_000,
    now: retryNow + 5,
  }), false);
  assert.equal(await jobs.retryTerminal({
    runId: duplicate.run.id,
    ownerSubject: "wrong-owner",
    deadlineAt: retryNow + 50_000,
    now: retryNow + 6,
  }), false);

  console.info(JSON.stringify({
    schema: WORKER_PAYLOAD_SCHEMA_VERSION,
    concurrentClaims: claimed.length,
    duplicateFinalArtifacts: Number(outputCount?.count) - 1,
    staleRecovery: "requeue-then-fail",
    cancellation: "queued-and-running",
    durableDeadline: "heartbeat-fenced-and-terminally-failed",
    jobIdentity: "run-kind-fenced",
    terminalRetry: "cancelled-and-failed-reset-then-requeued",
  }));
} finally {
  await database.close();
}
