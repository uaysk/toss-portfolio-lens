import { randomUUID } from "node:crypto";
import type { RelationalDatabase } from "../database.js";
import type { PortfolioRunKind } from "./run-repository.js";
import {
  decodeWorkerArtifact,
  encodeWorkerArtifact,
  WORKER_ARTIFACT_ENCODING,
  WORKER_ARTIFACT_FORMAT,
  WORKER_PAYLOAD_SCHEMA_VERSION,
  WorkerInputSchema,
  WorkerOutputSchema,
  type WorkerInput,
  type WorkerOutput,
} from "../worker/contracts.js";

export type RunJobState = "queued" | "running" | "completed" | "failed" | "cancelled";
export type WorkerArtifactRole = "input" | "output";

export type RunJobRecord = {
  runId: string;
  kind: PortfolioRunKind;
  payloadSchemaVersion: string;
  priority: number;
  state: RunJobState;
  availableAt: number;
  deadlineAt: number;
  leaseOwner?: string;
  leaseExpiresAt?: number;
  heartbeatAt?: number;
  attemptCount: number;
  maxAttempts: number;
  inputArtifactId: string;
  resultArtifactId?: string;
  lastError?: unknown;
  createdAt: number;
  updatedAt: number;
  finishedAt?: number;
};

export type WorkerArtifactRecord = {
  id: string;
  runId: string;
  role: WorkerArtifactRole;
  format: typeof WORKER_ARTIFACT_FORMAT;
  contentEncoding: typeof WORKER_ARTIFACT_ENCODING;
  content: Buffer;
  byteCount: number;
  uncompressedByteCount: number;
  checksum: string;
  schemaVersion: string;
  dataRevision: string;
  createdAt: number;
};

type JobRow = {
  run_id: string;
  job_kind: PortfolioRunKind;
  payload_schema_version: string;
  priority: number;
  state: RunJobState;
  available_at: number | string;
  deadline_at: number | string;
  lease_owner: string | null;
  lease_expires_at: number | string | null;
  heartbeat_at: number | string | null;
  attempt_count: number;
  max_attempts: number;
  input_artifact_id: string;
  result_artifact_id: string | null;
  last_error_json: string | null;
  created_at: number | string;
  updated_at: number | string;
  finished_at: number | string | null;
};

type ArtifactRow = {
  artifact_id: string;
  run_id: string;
  artifact_role: WorkerArtifactRole;
  format: typeof WORKER_ARTIFACT_FORMAT;
  content_encoding: typeof WORKER_ARTIFACT_ENCODING;
  content: Buffer | Uint8Array;
  byte_count: number | string;
  uncompressed_byte_count: number | string;
  checksum: string;
  schema_version: string;
  data_revision: string;
  created_at: number | string;
};

function parseJson(value: string | null): unknown {
  if (value === null) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return { code: "CORRUPT_JOB_ERROR", retryable: false };
  }
}

function jobRecord(row: JobRow): RunJobRecord {
  return {
    runId: row.run_id,
    kind: row.job_kind,
    payloadSchemaVersion: row.payload_schema_version,
    priority: Number(row.priority),
    state: row.state,
    availableAt: Number(row.available_at),
    deadlineAt: Number(row.deadline_at),
    ...(row.lease_owner ? { leaseOwner: row.lease_owner } : {}),
    ...(row.lease_expires_at !== null ? { leaseExpiresAt: Number(row.lease_expires_at) } : {}),
    ...(row.heartbeat_at !== null ? { heartbeatAt: Number(row.heartbeat_at) } : {}),
    attemptCount: Number(row.attempt_count),
    maxAttempts: Number(row.max_attempts),
    inputArtifactId: row.input_artifact_id,
    ...(row.result_artifact_id ? { resultArtifactId: row.result_artifact_id } : {}),
    ...(row.last_error_json ? { lastError: parseJson(row.last_error_json) } : {}),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    ...(row.finished_at !== null ? { finishedAt: Number(row.finished_at) } : {}),
  };
}

function artifactRecord(row: ArtifactRow): WorkerArtifactRecord {
  return {
    id: row.artifact_id,
    runId: row.run_id,
    role: row.artifact_role,
    format: row.format,
    contentEncoding: row.content_encoding,
    content: Buffer.from(row.content),
    byteCount: Number(row.byte_count),
    uncompressedByteCount: Number(row.uncompressed_byte_count),
    checksum: row.checksum,
    schemaVersion: row.schema_version,
    dataRevision: row.data_revision,
    createdAt: Number(row.created_at),
  };
}

function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export class RunJobRepository {
  constructor(private readonly database: RelationalDatabase) {}

  private assertPostgres(): void {
    if (this.database.dialect !== "postgres") {
      throw new Error("외부 Rust compute queue는 PostgreSQL에서만 사용할 수 있습니다.");
    }
  }

  async initialize(): Promise<void> {
    this.assertPostgres();
    await this.database.run(`
      CREATE TABLE IF NOT EXISTS portfolio_worker_artifacts (
        artifact_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES portfolio_backtest_runs(run_id) ON DELETE CASCADE,
        artifact_role TEXT NOT NULL CHECK (artifact_role IN ('input', 'output')),
        format TEXT NOT NULL CHECK (format = 'application/json'),
        content_encoding TEXT NOT NULL CHECK (content_encoding = 'gzip'),
        content BYTEA NOT NULL,
        byte_count BIGINT NOT NULL CHECK (byte_count >= 0),
        uncompressed_byte_count BIGINT NOT NULL CHECK (uncompressed_byte_count >= 0),
        checksum TEXT NOT NULL,
        schema_version TEXT NOT NULL,
        data_revision TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        UNIQUE(run_id, artifact_role)
      )
    `);
    await this.database.run(`
      CREATE TABLE IF NOT EXISTS portfolio_run_jobs (
        run_id TEXT PRIMARY KEY REFERENCES portfolio_backtest_runs(run_id) ON DELETE CASCADE,
        job_kind TEXT NOT NULL,
        payload_schema_version TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
        available_at BIGINT NOT NULL,
        deadline_at BIGINT NOT NULL,
        lease_owner TEXT,
        lease_expires_at BIGINT,
        heartbeat_at BIGINT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        input_artifact_id TEXT NOT NULL REFERENCES portfolio_worker_artifacts(artifact_id),
        result_artifact_id TEXT REFERENCES portfolio_worker_artifacts(artifact_id),
        last_error_json TEXT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        finished_at BIGINT,
        CHECK (max_attempts > 0 AND attempt_count >= 0 AND attempt_count <= max_attempts),
        CHECK (
          (state = 'running' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
          OR (state <> 'running' AND lease_owner IS NULL AND lease_expires_at IS NULL)
        ),
        CHECK (
          (state IN ('completed', 'failed', 'cancelled') AND finished_at IS NOT NULL)
          OR (state IN ('queued', 'running') AND finished_at IS NULL)
        )
      )
    `);
    await this.database.run("ALTER TABLE portfolio_run_jobs ADD COLUMN IF NOT EXISTS deadline_at BIGINT");
    await this.database.run(`
      UPDATE portfolio_run_jobs SET deadline_at = created_at + 120000
      WHERE deadline_at IS NULL
    `);
    await this.database.run("ALTER TABLE portfolio_run_jobs ALTER COLUMN deadline_at SET NOT NULL");
    await this.database.run(`
      CREATE INDEX IF NOT EXISTS idx_portfolio_run_jobs_claim
      ON portfolio_run_jobs(priority ASC, available_at ASC, created_at ASC)
      WHERE state = 'queued'
    `);
    await this.database.run(`
      CREATE INDEX IF NOT EXISTS idx_portfolio_run_jobs_stale
      ON portfolio_run_jobs(lease_expires_at)
      WHERE state = 'running'
    `);
    await this.database.run(`
      CREATE INDEX IF NOT EXISTS idx_portfolio_run_jobs_deadline
      ON portfolio_run_jobs(deadline_at)
      WHERE state IN ('queued', 'running')
    `);
  }

  async putInput(input: WorkerInput, now = Date.now()): Promise<WorkerArtifactRecord> {
    this.assertPostgres();
    const parsed = WorkerInputSchema.parse(input);
    const [run] = await this.database.query<{
      run_kind: PortfolioRunKind;
      request_hash: string;
      data_revision: string;
      engine_version: string;
    }>(`
      SELECT run_kind, request_hash, data_revision, engine_version
      FROM portfolio_backtest_runs WHERE run_id = ?
    `, [parsed.run_id]);
    if (!run || run.run_kind !== parsed.job_kind || run.request_hash !== parsed.request_hash
      || run.data_revision !== parsed.data_revision || run.engine_version !== parsed.engine_version) {
      throw new Error("worker input이 durable run의 job/request/data/engine identity와 일치하지 않습니다.");
    }
    return this.putArtifact(this.database, "input", parsed, parsed.data_revision, now);
  }

  async getInput(runId: string): Promise<{ artifact: WorkerArtifactRecord; value: WorkerInput } | undefined> {
    const artifact = await this.getArtifactForRun(runId, "input");
    if (!artifact) return undefined;
    return {
      artifact,
      value: WorkerInputSchema.parse(decodeWorkerArtifact(artifact.content, artifact.checksum, artifact)),
    };
  }

  async getOutput(runId: string): Promise<{ artifact: WorkerArtifactRecord; value: WorkerOutput } | undefined> {
    const artifact = await this.getArtifactForRun(runId, "output");
    if (!artifact) return undefined;
    return {
      artifact,
      value: WorkerOutputSchema.parse(decodeWorkerArtifact(artifact.content, artifact.checksum, artifact)),
    };
  }

  async enqueue(input: {
    runId: string;
    kind: PortfolioRunKind;
    inputArtifactId: string;
    priority?: number;
    maxAttempts?: number;
    availableAt?: number;
    deadlineAt?: number;
    now?: number;
  }): Promise<RunJobRecord> {
    this.assertPostgres();
    const now = input.now ?? Date.now();
    const priority = Math.max(-100, Math.min(100, Math.trunc(input.priority ?? 0)));
    const maxAttempts = Math.max(1, Math.min(10, Math.trunc(input.maxAttempts ?? 3)));
    const deadlineAt = Math.trunc(input.deadlineAt ?? now + 120_000);
    if (deadlineAt <= now) throw new Error("external compute job deadline은 enqueue 시각보다 늦어야 합니다.");
    await this.database.transaction(async (database) => {
      const [artifact] = await database.query<{
        run_id: string;
        artifact_role: string;
        durable_run_kind: PortfolioRunKind;
      }>(`
        SELECT artifact.run_id, artifact.artifact_role, run.run_kind AS durable_run_kind
        FROM portfolio_worker_artifacts artifact
        JOIN portfolio_backtest_runs run ON run.run_id = artifact.run_id
        WHERE artifact.artifact_id = ? FOR SHARE OF artifact, run
      `, [input.inputArtifactId]);
      if (!artifact || artifact.run_id !== input.runId || artifact.artifact_role !== "input"
        || artifact.durable_run_kind !== input.kind) {
        throw new Error("job과 일치하는 immutable input artifact가 필요합니다.");
      }
      const inserted = await database.run(`
        INSERT INTO portfolio_run_jobs (
          run_id, job_kind, payload_schema_version, priority, state, available_at,
          deadline_at, attempt_count, max_attempts, input_artifact_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'queued', ?, ?, 0, ?, ?, ?, ?)
        ON CONFLICT(run_id) DO NOTHING
      `, [
        input.runId,
        input.kind,
        WORKER_PAYLOAD_SCHEMA_VERSION,
        priority,
        input.availableAt ?? now,
        deadlineAt,
        maxAttempts,
        input.inputArtifactId,
        now,
        now,
      ]);
      if (inserted.affectedRows === 1) {
        await this.addEvent(database, input.runId, "external_enqueued", {
          kind: input.kind,
          priority,
          max_attempts: maxAttempts,
          deadline_at: deadlineAt,
        }, now);
      }
    });
    const stored = await this.get(input.runId);
    if (!stored) throw new Error("external compute job을 생성하지 못했습니다.");
    if (stored.kind !== input.kind || stored.inputArtifactId !== input.inputArtifactId) {
      throw new Error("동일 run에 다른 external compute job이 이미 존재합니다.");
    }
    return stored;
  }

  async get(runId: string): Promise<RunJobRecord | undefined> {
    this.assertPostgres();
    const [row] = await this.database.query<JobRow>("SELECT * FROM portfolio_run_jobs WHERE run_id = ?", [runId]);
    return row ? jobRecord(row) : undefined;
  }

  async claim(workerId: string, leaseMs: number, now = Date.now()): Promise<RunJobRecord | undefined> {
    this.assertPostgres();
    if (!workerId.trim()) throw new Error("worker id가 필요합니다.");
    const safeLeaseMs = Math.max(1_000, Math.min(600_000, Math.trunc(leaseMs)));
    return this.database.transaction(async (database) => {
      const [selected] = await database.query<JobRow>(`
        SELECT job.*
        FROM portfolio_run_jobs job
        JOIN portfolio_backtest_runs run ON run.run_id = job.run_id
        WHERE job.state = 'queued' AND job.available_at <= ?
          AND job.deadline_at > ? AND job.attempt_count < job.max_attempts
          AND run.status = 'queued' AND job.job_kind = run.run_kind
        ORDER BY job.priority ASC, job.available_at ASC, job.created_at ASC
        FOR UPDATE OF job, run SKIP LOCKED
        LIMIT 1
      `, [now, now]);
      if (!selected) return undefined;
      const leaseOwner = `${workerId.slice(0, 96)}:${randomUUID()}`;
      const leaseExpiresAt = now + safeLeaseMs;
      const updatedJob = await database.run(`
        UPDATE portfolio_run_jobs
        SET state = 'running', lease_owner = ?, lease_expires_at = ?, heartbeat_at = ?,
            attempt_count = attempt_count + 1, updated_at = ?
        WHERE run_id = ? AND state = 'queued'
      `, [leaseOwner, leaseExpiresAt, now, now, selected.run_id]);
      const updatedRun = await database.run(`
        UPDATE portfolio_backtest_runs
        SET status = 'running', started_at = COALESCE(started_at, ?), updated_at = ?
        WHERE run_id = ? AND status = 'queued'
      `, [now, now, selected.run_id]);
      if (updatedJob.affectedRows !== 1 || updatedRun.affectedRows !== 1) {
        throw new Error("job claim 상태 전이가 충돌했습니다.");
      }
      await this.addEvent(database, selected.run_id, "worker_claimed", {
        worker_id: workerId.slice(0, 96),
        lease_expires_at: leaseExpiresAt,
      }, now);
      const [claimed] = await database.query<JobRow>("SELECT * FROM portfolio_run_jobs WHERE run_id = ?", [selected.run_id]);
      return claimed ? jobRecord(claimed) : undefined;
    });
  }

  async heartbeat(runId: string, leaseOwner: string, leaseMs: number, now = Date.now()): Promise<{
    renewed: boolean;
    cancellationRequested: boolean;
  }> {
    this.assertPostgres();
    const safeLeaseMs = Math.max(1_000, Math.min(600_000, Math.trunc(leaseMs)));
    const result = await this.database.run(`
      UPDATE portfolio_run_jobs
      SET heartbeat_at = ?, lease_expires_at = ?, updated_at = ?
      WHERE run_id = ? AND state = 'running' AND lease_owner = ? AND lease_expires_at > ?
        AND deadline_at > ?
    `, [now, now + safeLeaseMs, now, runId, leaseOwner, now, now]);
    if (result.affectedRows !== 1) return { renewed: false, cancellationRequested: false };
    const [run] = await this.database.query<{ status: string }>(
      "SELECT status FROM portfolio_backtest_runs WHERE run_id = ?",
      [runId],
    );
    return { renewed: true, cancellationRequested: run?.status === "cancel_requested" };
  }

  async updateProgress(input: {
    runId: string;
    leaseOwner: string;
    progress: number;
    completedCandidates?: number;
    totalCandidates?: number;
    currentValidationWindow?: string;
    now?: number;
  }): Promise<boolean> {
    this.assertPostgres();
    const now = input.now ?? Date.now();
    const result = await this.database.run(`
      UPDATE portfolio_backtest_runs run
      SET progress = ?, completed_candidates = COALESCE(?, completed_candidates),
          total_candidates = COALESCE(?, total_candidates), current_validation_window = ?, updated_at = ?
      WHERE run.run_id = ? AND run.status IN ('running', 'cancel_requested')
        AND EXISTS (
          SELECT 1 FROM portfolio_run_jobs job
          WHERE job.run_id = run.run_id AND job.state = 'running'
            AND job.lease_owner = ? AND job.lease_expires_at > ? AND job.deadline_at > ?
        )
    `, [
      Math.max(0, Math.min(1, input.progress)),
      input.completedCandidates,
      input.totalCandidates,
      input.currentValidationWindow,
      now,
      input.runId,
      input.leaseOwner,
      now,
      now,
    ]);
    return result.affectedRows === 1;
  }

  async complete(input: {
    runId: string;
    leaseOwner: string;
    output: WorkerOutput;
    dataRevision: string;
    now?: number;
  }): Promise<"completed" | "cancelled" | "lost"> {
    this.assertPostgres();
    const now = input.now ?? Date.now();
    const output = WorkerOutputSchema.parse(input.output);
    if (output.run_id !== input.runId || output.status !== "completed") {
      throw new Error("완료 output의 run/status가 일치하지 않습니다.");
    }
    return this.database.transaction(async (database) => {
      const [row] = await database.query<JobRow & {
        run_status: string;
        run_engine_version: string;
        run_data_revision: string;
        durable_run_kind: PortfolioRunKind;
      }>(`
        SELECT job.*, run.status AS run_status, run.engine_version AS run_engine_version,
               run.data_revision AS run_data_revision, run.run_kind AS durable_run_kind
        FROM portfolio_run_jobs job
        JOIN portfolio_backtest_runs run ON run.run_id = job.run_id
        WHERE job.run_id = ?
        FOR UPDATE OF job, run
      `, [input.runId]);
      if (!row || row.state !== "running" || row.lease_owner !== input.leaseOwner
        || Number(row.lease_expires_at ?? 0) <= now || Number(row.deadline_at) <= now) return "lost";
      if (output.engine_version !== row.run_engine_version || output.job_kind !== row.job_kind
        || output.job_kind !== row.durable_run_kind
        || input.dataRevision !== row.run_data_revision) {
        throw new Error("worker output이 claimed run의 engine/job/data revision과 일치하지 않습니다.");
      }
      if (row.run_status === "cancel_requested") {
        await this.transitionCancelled(database, input.runId, now, "worker_observed_cancellation");
        return "cancelled";
      }
      if (row.run_status !== "running") return "lost";
      const artifact = await this.putArtifact(database, "output", output, input.dataRevision, now);
      const runUpdate = await database.run(`
        UPDATE portfolio_backtest_runs
        SET status = 'completed', progress = 1, summary_json = ?, result_json = ?,
            warnings_json = ?, error_json = NULL, finished_at = ?, updated_at = ?
        WHERE run_id = ? AND status = 'running'
      `, [json(output.summary), json(output.result), json(output.warnings), now, now, input.runId]);
      if (runUpdate.affectedRows !== 1) throw new Error("run 완료 상태 전이가 충돌했습니다.");
      await database.run(`
        UPDATE portfolio_run_jobs
        SET state = 'completed', result_artifact_id = ?, lease_owner = NULL,
            lease_expires_at = NULL, heartbeat_at = ?, finished_at = ?, updated_at = ?
        WHERE run_id = ? AND state = 'running' AND lease_owner = ?
      `, [artifact.id, now, now, now, input.runId, input.leaseOwner]);
      await this.addEvent(database, input.runId, "worker_completed", {
        result_artifact_id: artifact.id,
        checksum: artifact.checksum,
      }, now);
      return "completed";
    });
  }

  async fail(input: {
    runId: string;
    leaseOwner: string;
    error: unknown;
    retryable: boolean;
    retryDelayMs?: number;
    now?: number;
  }): Promise<"requeued" | "failed" | "cancelled" | "lost"> {
    this.assertPostgres();
    const now = input.now ?? Date.now();
    return this.database.transaction(async (database) => {
      const [row] = await database.query<JobRow & { run_status: string }>(`
        SELECT job.*, run.status AS run_status
        FROM portfolio_run_jobs job
        JOIN portfolio_backtest_runs run ON run.run_id = job.run_id
        WHERE job.run_id = ?
        FOR UPDATE OF job, run
      `, [input.runId]);
      if (!row || row.state !== "running" || row.lease_owner !== input.leaseOwner
        || Number(row.lease_expires_at ?? 0) <= now || Number(row.deadline_at) <= now) return "lost";
      if (row.run_status === "cancel_requested") {
        await this.transitionCancelled(database, input.runId, now, "worker_observed_cancellation");
        return "cancelled";
      }
      if (input.retryable && Number(row.attempt_count) < Number(row.max_attempts)) {
        await database.run(`
          UPDATE portfolio_run_jobs
          SET state = 'queued', available_at = ?, lease_owner = NULL, lease_expires_at = NULL,
              heartbeat_at = NULL, last_error_json = ?, updated_at = ?
          WHERE run_id = ? AND state = 'running' AND lease_owner = ?
        `, [now + Math.max(0, input.retryDelayMs ?? 0), json(input.error), now, input.runId, input.leaseOwner]);
        await database.run(`
          UPDATE portfolio_backtest_runs
          SET status = 'queued', progress = 0, completed_candidates = 0,
              current_validation_window = NULL, error_json = ?, updated_at = ?
          WHERE run_id = ? AND status = 'running'
        `, [json(input.error), now, input.runId]);
        await this.addEvent(database, input.runId, "worker_requeued", { error: input.error }, now);
        return "requeued";
      }
      await this.transitionFailed(database, input.runId, input.error, now, "worker_failed");
      return "failed";
    });
  }

  async cancel(runId: string, ownerSubject: string, now = Date.now()): Promise<"cancelled" | "requested" | false> {
    this.assertPostgres();
    return this.database.transaction(async (database) => {
      const [row] = await database.query<JobRow & { run_status: string }>(`
        SELECT job.*, run.status AS run_status
        FROM portfolio_run_jobs job
        JOIN portfolio_backtest_runs run ON run.run_id = job.run_id
        WHERE job.run_id = ? AND run.owner_subject = ?
        FOR UPDATE OF job, run
      `, [runId, ownerSubject]);
      if (!row || ["completed", "failed", "cancelled"].includes(row.state)) return false;
      if (row.state === "queued") {
        await this.transitionCancelled(database, runId, now, "queued_job_cancelled");
        return "cancelled";
      }
      const result = await database.run(`
        UPDATE portfolio_backtest_runs
        SET status = 'cancel_requested', updated_at = ?
        WHERE run_id = ? AND status = 'running'
      `, [now, runId]);
      if (result.affectedRows !== 1 && row.run_status !== "cancel_requested") return false;
      await this.addEvent(database, runId, "cancellation_requested", {}, now);
      return "requested";
    });
  }

  async expireDeadline(runId: string, now = Date.now()): Promise<"failed" | "cancelled" | "lost"> {
    this.assertPostgres();
    return this.database.transaction(async (database) => {
      const [row] = await database.query<JobRow & { run_status: string }>(`
        SELECT job.*, run.status AS run_status
        FROM portfolio_run_jobs job
        JOIN portfolio_backtest_runs run ON run.run_id = job.run_id
        WHERE job.run_id = ?
        FOR UPDATE OF job, run
      `, [runId]);
      if (!row || !["queued", "running"].includes(row.state) || Number(row.deadline_at) > now) return "lost";
      if (row.run_status === "cancel_requested") {
        await this.transitionCancelled(database, runId, now, "deadline_cancellation_observed");
        return "cancelled";
      }
      await this.transitionFailed(database, runId, {
        code: "RUN_DEADLINE_EXCEEDED",
        message: "external compute job의 절대 실행 시간을 초과했습니다.",
        retryable: true,
      }, now, "worker_deadline_exceeded");
      return "failed";
    });
  }

  async recoverExpiredLeases(now = Date.now(), limit = 100): Promise<{
    requeued: number;
    failed: number;
    cancelled: number;
  }> {
    this.assertPostgres();
    const safeLimit = Math.max(1, Math.min(1_000, Math.trunc(limit)));
    return this.database.transaction(async (database) => {
      const result = { requeued: 0, failed: 0, cancelled: 0 };
      const deadlineRows = await database.query<JobRow & { run_status: string }>(`
        SELECT job.*, run.status AS run_status
        FROM portfolio_run_jobs job
        JOIN portfolio_backtest_runs run ON run.run_id = job.run_id
        WHERE job.state IN ('queued', 'running') AND job.deadline_at <= ?
        ORDER BY job.deadline_at ASC
        FOR UPDATE OF job, run SKIP LOCKED
        LIMIT ${safeLimit}
      `, [now]);
      for (const row of deadlineRows) {
        if (row.run_status === "cancel_requested") {
          await this.transitionCancelled(database, row.run_id, now, "deadline_cancellation_observed");
          result.cancelled += 1;
        } else {
          await this.transitionFailed(database, row.run_id, {
            code: "RUN_DEADLINE_EXCEEDED",
            message: "external compute job의 절대 실행 시간을 초과했습니다.",
            retryable: true,
          }, now, "worker_deadline_exceeded");
          result.failed += 1;
        }
      }
      const remaining = safeLimit - deadlineRows.length;
      if (remaining <= 0) return result;
      const rows = await database.query<JobRow & { run_status: string }>(`
        SELECT job.*, run.status AS run_status
        FROM portfolio_run_jobs job
        JOIN portfolio_backtest_runs run ON run.run_id = job.run_id
        WHERE job.state = 'running' AND job.lease_expires_at <= ? AND job.deadline_at > ?
        ORDER BY job.lease_expires_at ASC
        FOR UPDATE OF job, run SKIP LOCKED
        LIMIT ${remaining}
      `, [now, now]);
      for (const row of rows) {
        if (row.run_status === "cancel_requested") {
          await this.transitionCancelled(database, row.run_id, now, "expired_lease_cancelled");
          result.cancelled += 1;
        } else if (Number(row.attempt_count) < Number(row.max_attempts)) {
          await database.run(`
            UPDATE portfolio_run_jobs
            SET state = 'queued', available_at = ?, lease_owner = NULL, lease_expires_at = NULL,
                heartbeat_at = NULL, updated_at = ?
            WHERE run_id = ? AND state = 'running'
          `, [now, now, row.run_id]);
          await database.run(`
            UPDATE portfolio_backtest_runs
            SET status = 'queued', progress = 0, completed_candidates = 0,
                current_validation_window = NULL, updated_at = ?
            WHERE run_id = ? AND status = 'running'
          `, [now, row.run_id]);
          await this.addEvent(database, row.run_id, "expired_lease_requeued", {
            attempt_count: Number(row.attempt_count),
            max_attempts: Number(row.max_attempts),
          }, now);
          result.requeued += 1;
        } else {
          await this.transitionFailed(database, row.run_id, {
            code: "WORKER_LEASE_EXHAUSTED",
            message: "worker lease가 반복 만료되어 실행을 중단했습니다.",
            retryable: true,
          }, now, "expired_lease_failed");
          result.failed += 1;
        }
      }
      return result;
    });
  }

  private async putArtifact(
    database: RelationalDatabase,
    role: WorkerArtifactRole,
    value: WorkerInput | WorkerOutput,
    dataRevision: string,
    now: number,
  ): Promise<WorkerArtifactRecord> {
    const encoded = encodeWorkerArtifact(value);
    const id = randomUUID();
    await database.run(`
      INSERT INTO portfolio_worker_artifacts (
        artifact_id, run_id, artifact_role, format, content_encoding, content,
        byte_count, uncompressed_byte_count, checksum, schema_version, data_revision, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, artifact_role) DO NOTHING
    `, [
      id,
      value.run_id,
      role,
      WORKER_ARTIFACT_FORMAT,
      WORKER_ARTIFACT_ENCODING,
      encoded.content,
      encoded.byteCount,
      encoded.uncompressedByteCount,
      encoded.checksum,
      WORKER_PAYLOAD_SCHEMA_VERSION,
      dataRevision,
      now,
    ]);
    const [row] = await database.query<ArtifactRow>(`
      SELECT * FROM portfolio_worker_artifacts WHERE run_id = ? AND artifact_role = ?
    `, [value.run_id, role]);
    if (!row) throw new Error("worker artifact를 저장하지 못했습니다.");
    const stored = artifactRecord(row);
    if (stored.checksum !== encoded.checksum || stored.dataRevision !== dataRevision) {
      throw new Error("immutable worker artifact 충돌이 발생했습니다.");
    }
    return stored;
  }

  private async getArtifactForRun(runId: string, role: WorkerArtifactRole): Promise<WorkerArtifactRecord | undefined> {
    this.assertPostgres();
    const [row] = await this.database.query<ArtifactRow>(`
      SELECT * FROM portfolio_worker_artifacts WHERE run_id = ? AND artifact_role = ?
    `, [runId, role]);
    return row ? artifactRecord(row) : undefined;
  }

  private async transitionCancelled(
    database: RelationalDatabase,
    runId: string,
    now: number,
    eventType: string,
  ): Promise<void> {
    await database.run(`
      UPDATE portfolio_run_jobs
      SET state = 'cancelled', lease_owner = NULL, lease_expires_at = NULL,
          heartbeat_at = NULL, finished_at = ?, updated_at = ?
      WHERE run_id = ? AND state IN ('queued', 'running')
    `, [now, now, runId]);
    await database.run(`
      UPDATE portfolio_backtest_runs
      SET status = 'cancelled', summary_json = ?, warnings_json = ?, finished_at = ?, updated_at = ?
      WHERE run_id = ? AND status IN ('queued', 'running', 'cancel_requested')
    `, [json({ cancelled: true }), json(["사용자 요청으로 실행을 취소했습니다."]), now, now, runId]);
    await this.addEvent(database, runId, eventType, {}, now);
  }

  private async transitionFailed(
    database: RelationalDatabase,
    runId: string,
    error: unknown,
    now: number,
    eventType: string,
  ): Promise<void> {
    await database.run(`
      UPDATE portfolio_run_jobs
      SET state = 'failed', lease_owner = NULL, lease_expires_at = NULL,
          heartbeat_at = NULL, last_error_json = ?, finished_at = ?, updated_at = ?
      WHERE run_id = ? AND state IN ('queued', 'running')
    `, [json(error), now, now, runId]);
    await database.run(`
      UPDATE portfolio_backtest_runs
      SET status = 'failed', error_json = ?, warnings_json = ?, finished_at = ?, updated_at = ?
      WHERE run_id = ? AND status IN ('queued', 'running', 'cancel_requested')
    `, [json(error), json(["중단 전 저장된 artifact는 보존되었습니다."]), now, now, runId]);
    await this.addEvent(database, runId, eventType, { error }, now);
  }

  private async addEvent(
    database: RelationalDatabase,
    runId: string,
    eventType: string,
    detail: unknown,
    now: number,
  ): Promise<void> {
    await database.run(`
      INSERT INTO portfolio_run_events (event_id, run_id, event_type, event_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `, [randomUUID(), runId, eventType.slice(0, 64), json(detail), now]);
  }
}
