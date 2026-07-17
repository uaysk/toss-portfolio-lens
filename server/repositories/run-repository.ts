import { randomUUID } from "node:crypto";
import type { RelationalDatabase } from "../database.js";

export type PortfolioRunKind =
  | "backtest"
  | "optimization"
  | "walk_forward"
  | "stress_test"
  | "weight_sensitivity"
  | "start_date_sensitivity"
  | "rebalance_sensitivity"
  | "cash_flow_sensitivity";

export type PortfolioRunStatus =
  | "queued"
  | "running"
  | "cancel_requested"
  | "cancelled"
  | "completed"
  | "failed";

export type PortfolioRunRecord = {
  id: string;
  kind: PortfolioRunKind;
  ownerSubject: string;
  requestHash: string;
  dataRevision: string;
  engineVersion: string;
  status: PortfolioRunStatus;
  progress: number;
  completedCandidates: number;
  totalCandidates: number;
  currentValidationWindow?: string;
  input: unknown;
  summary?: unknown;
  result?: unknown;
  error?: unknown;
  warnings: string[];
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  updatedAt: number;
};

type RunRow = {
  run_id: string;
  run_kind: PortfolioRunKind;
  owner_subject: string;
  request_hash: string;
  data_revision: string;
  engine_version: string;
  status: PortfolioRunStatus;
  progress: number;
  completed_candidates: number;
  total_candidates: number;
  current_validation_window: string | null;
  input_json: string;
  summary_json: string | null;
  result_json: string | null;
  error_json: string | null;
  warnings_json: string;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  updated_at: number;
};

function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function parseJson(value: string | null): unknown {
  if (value === null) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function asRun(row: RunRow): PortfolioRunRecord {
  const warnings = parseJson(row.warnings_json);
  return {
    id: row.run_id,
    kind: row.run_kind,
    ownerSubject: row.owner_subject,
    requestHash: row.request_hash,
    dataRevision: row.data_revision,
    engineVersion: row.engine_version,
    status: row.status,
    progress: Number(row.progress),
    completedCandidates: Number(row.completed_candidates),
    totalCandidates: Number(row.total_candidates),
    ...(row.current_validation_window ? { currentValidationWindow: row.current_validation_window } : {}),
    input: parseJson(row.input_json),
    ...(row.summary_json ? { summary: parseJson(row.summary_json) } : {}),
    ...(row.result_json ? { result: parseJson(row.result_json) } : {}),
    ...(row.error_json ? { error: parseJson(row.error_json) } : {}),
    warnings: Array.isArray(warnings) ? warnings.filter((item): item is string => typeof item === "string") : [],
    createdAt: Number(row.created_at),
    ...(row.started_at !== null ? { startedAt: Number(row.started_at) } : {}),
    ...(row.finished_at !== null ? { finishedAt: Number(row.finished_at) } : {}),
    updatedAt: Number(row.updated_at),
  };
}

export class RunRepository {
  constructor(private readonly database: RelationalDatabase) {}

  async initialize(): Promise<void> {
    if (this.database.dialect === "mysql") {
      await this.database.run(`
        CREATE TABLE IF NOT EXISTS portfolio_backtest_runs (
          run_id VARCHAR(64) PRIMARY KEY,
          run_kind VARCHAR(40) NOT NULL,
          owner_subject VARCHAR(128) NOT NULL,
          request_hash VARCHAR(128) NOT NULL,
          data_revision VARCHAR(128) NOT NULL,
          engine_version VARCHAR(64) NOT NULL,
          status VARCHAR(32) NOT NULL,
          progress DOUBLE NOT NULL DEFAULT 0,
          completed_candidates INT NOT NULL DEFAULT 0,
          total_candidates INT NOT NULL DEFAULT 0,
          current_validation_window VARCHAR(128) NULL,
          input_json LONGTEXT NOT NULL,
          summary_json LONGTEXT NULL,
          result_json LONGTEXT NULL,
          error_json LONGTEXT NULL,
          warnings_json LONGTEXT NOT NULL,
          created_at BIGINT NOT NULL,
          started_at BIGINT NULL,
          finished_at BIGINT NULL,
          updated_at BIGINT NOT NULL,
          UNIQUE KEY uq_portfolio_run_request (owner_subject, run_kind, request_hash, data_revision),
          KEY idx_portfolio_run_status (owner_subject, status, updated_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
      await this.database.run(`
        CREATE TABLE IF NOT EXISTS portfolio_run_events (
          event_id VARCHAR(64) PRIMARY KEY,
          run_id VARCHAR(64) NOT NULL,
          event_type VARCHAR(64) NOT NULL,
          event_json LONGTEXT NOT NULL,
          created_at BIGINT NOT NULL,
          KEY idx_portfolio_run_events (run_id, created_at),
          CONSTRAINT fk_portfolio_run_events_run FOREIGN KEY (run_id)
            REFERENCES portfolio_backtest_runs(run_id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
      return;
    }
    const timestampType = this.database.dialect === "postgres" ? "BIGINT" : "INTEGER";
    await this.database.run(`
      CREATE TABLE IF NOT EXISTS portfolio_backtest_runs (
        run_id TEXT PRIMARY KEY,
        run_kind TEXT NOT NULL,
        owner_subject TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        data_revision TEXT NOT NULL,
        engine_version TEXT NOT NULL,
        status TEXT NOT NULL,
        progress REAL NOT NULL DEFAULT 0,
        completed_candidates INTEGER NOT NULL DEFAULT 0,
        total_candidates INTEGER NOT NULL DEFAULT 0,
        current_validation_window TEXT,
        input_json TEXT NOT NULL,
        summary_json TEXT,
        result_json TEXT,
        error_json TEXT,
        warnings_json TEXT NOT NULL,
        created_at ${timestampType} NOT NULL,
        started_at ${timestampType},
        finished_at ${timestampType},
        updated_at ${timestampType} NOT NULL,
        UNIQUE(owner_subject, run_kind, request_hash, data_revision)
      )
    `);
    await this.database.run(`
      CREATE INDEX IF NOT EXISTS idx_portfolio_run_status
      ON portfolio_backtest_runs(owner_subject, status, updated_at)
    `);
    await this.database.run(`
      CREATE TABLE IF NOT EXISTS portfolio_run_events (
        event_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES portfolio_backtest_runs(run_id) ON DELETE CASCADE,
        event_type TEXT NOT NULL,
        event_json TEXT NOT NULL,
        created_at ${timestampType} NOT NULL
      )
    `);
    await this.database.run(`
      CREATE INDEX IF NOT EXISTS idx_portfolio_run_events
      ON portfolio_run_events(run_id, created_at)
    `);
  }

  async create(input: {
    kind: PortfolioRunKind;
    ownerSubject: string;
    requestHash: string;
    dataRevision: string;
    engineVersion: string;
    config: unknown;
    totalCandidates?: number;
    now?: number;
  }): Promise<PortfolioRunRecord> {
    const now = input.now ?? Date.now();
    const id = randomUUID();
    const values = [
      id,
      input.kind,
      input.ownerSubject,
      input.requestHash,
      input.dataRevision,
      input.engineVersion,
      "queued",
      0,
      0,
      input.totalCandidates ?? 0,
      json(input.config),
      "[]",
      now,
      now,
    ];
    if (this.database.dialect === "mysql") {
      await this.database.run(`
        INSERT IGNORE INTO portfolio_backtest_runs (
          run_id, run_kind, owner_subject, request_hash, data_revision, engine_version,
          status, progress, completed_candidates, total_candidates, input_json,
          warnings_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, values);
    } else {
      await this.database.run(`
        INSERT INTO portfolio_backtest_runs (
          run_id, run_kind, owner_subject, request_hash, data_revision, engine_version,
          status, progress, completed_candidates, total_candidates, input_json,
          warnings_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(owner_subject, run_kind, request_hash, data_revision) DO NOTHING
      `, values);
    }
    const existing = await this.findByRequest(
      input.ownerSubject,
      input.kind,
      input.requestHash,
      input.dataRevision,
    );
    if (!existing) throw new Error("실행 레코드를 생성하지 못했습니다.");
    return existing;
  }

  async get(id: string, ownerSubject?: string): Promise<PortfolioRunRecord | undefined> {
    const rows = ownerSubject
      ? await this.database.query<RunRow>(
          "SELECT * FROM portfolio_backtest_runs WHERE run_id = ? AND owner_subject = ?",
          [id, ownerSubject],
        )
      : await this.database.query<RunRow>("SELECT * FROM portfolio_backtest_runs WHERE run_id = ?", [id]);
    return rows[0] ? asRun(rows[0]) : undefined;
  }

  async findByRequest(
    ownerSubject: string,
    kind: PortfolioRunKind,
    requestHash: string,
    dataRevision: string,
  ): Promise<PortfolioRunRecord | undefined> {
    const [row] = await this.database.query<RunRow>(`
      SELECT * FROM portfolio_backtest_runs
      WHERE owner_subject = ? AND run_kind = ? AND request_hash = ? AND data_revision = ?
    `, [ownerSubject, kind, requestHash, dataRevision]);
    return row ? asRun(row) : undefined;
  }

  async activeCount(ownerSubject?: string): Promise<number> {
    const [row] = ownerSubject
      ? await this.database.query<{ count: number }>(`
          SELECT COUNT(*) AS count FROM portfolio_backtest_runs
          WHERE owner_subject = ? AND status IN ('queued', 'running', 'cancel_requested')
        `, [ownerSubject])
      : await this.database.query<{ count: number }>(`
          SELECT COUNT(*) AS count FROM portfolio_backtest_runs
          WHERE status IN ('queued', 'running', 'cancel_requested')
        `);
    return Number(row?.count ?? 0);
  }

  async markRunning(id: string, now = Date.now()): Promise<boolean> {
    const result = await this.database.run(`
      UPDATE portfolio_backtest_runs
      SET status = 'running', started_at = COALESCE(started_at, ?), updated_at = ?
      WHERE run_id = ? AND status = 'queued'
    `, [now, now, id]);
    return result.affectedRows === 1;
  }

  async updateProgress(id: string, input: {
    progress: number;
    completedCandidates?: number;
    totalCandidates?: number;
    currentValidationWindow?: string;
    warnings?: string[];
  }, now = Date.now()): Promise<void> {
    await this.database.run(`
      UPDATE portfolio_backtest_runs
      SET progress = ?, completed_candidates = COALESCE(?, completed_candidates),
          total_candidates = COALESCE(?, total_candidates), current_validation_window = ?,
          warnings_json = COALESCE(?, warnings_json), updated_at = ?
      WHERE run_id = ? AND status IN ('queued', 'running', 'cancel_requested')
    `, [
      Math.max(0, Math.min(1, input.progress)),
      input.completedCandidates,
      input.totalCandidates,
      input.currentValidationWindow,
      input.warnings ? json(input.warnings) : undefined,
      now,
      id,
    ]);
  }

  async requestCancellation(id: string, ownerSubject: string, now = Date.now()): Promise<boolean> {
    const result = await this.database.run(`
      UPDATE portfolio_backtest_runs
      SET status = 'cancel_requested', updated_at = ?
      WHERE run_id = ? AND owner_subject = ? AND status IN ('queued', 'running')
    `, [now, id, ownerSubject]);
    return result.affectedRows === 1;
  }

  async isCancellationRequested(id: string): Promise<boolean> {
    const [row] = await this.database.query<{ status: string }>(
      "SELECT status FROM portfolio_backtest_runs WHERE run_id = ?",
      [id],
    );
    return row?.status === "cancel_requested";
  }

  async complete(id: string, summary: unknown, result: unknown, warnings: string[] = [], now = Date.now()): Promise<void> {
    await this.database.run(`
      UPDATE portfolio_backtest_runs
      SET status = 'completed', progress = 1, summary_json = ?, result_json = ?,
          warnings_json = ?, error_json = NULL, finished_at = ?, updated_at = ?
      WHERE run_id = ? AND status IN ('queued', 'running')
    `, [json(summary), json(result), json(warnings), now, now, id]);
  }

  async cancel(id: string, summary: unknown, warnings: string[] = [], now = Date.now()): Promise<void> {
    await this.database.run(`
      UPDATE portfolio_backtest_runs
      SET status = 'cancelled', summary_json = ?, warnings_json = ?, finished_at = ?, updated_at = ?
      WHERE run_id = ? AND status IN ('queued', 'running', 'cancel_requested')
    `, [json(summary), json(warnings), now, now, id]);
  }

  async fail(id: string, error: unknown, warnings: string[] = [], now = Date.now()): Promise<void> {
    await this.database.run(`
      UPDATE portfolio_backtest_runs
      SET status = 'failed', error_json = ?, warnings_json = ?, finished_at = ?, updated_at = ?
      WHERE run_id = ? AND status IN ('queued', 'running', 'cancel_requested')
    `, [json(error), json(warnings), now, now, id]);
  }

  async addEvent(id: string, type: string, detail: unknown, now = Date.now()): Promise<void> {
    await this.database.run(`
      INSERT INTO portfolio_run_events (event_id, run_id, event_type, event_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `, [randomUUID(), id, type.slice(0, 64), json(detail), now]);
  }

  async recoverStaleRuns(now = Date.now()): Promise<number> {
    const result = await this.database.run(`
      UPDATE portfolio_backtest_runs
      SET status = 'failed',
          error_json = ?,
          warnings_json = ?,
          finished_at = ?, updated_at = ?
      WHERE status IN ('queued', 'running', 'cancel_requested')
    `, [
      json({ code: "STALE_RUN_RECOVERED", message: "서버 재시작으로 실행이 중단되었습니다.", retryable: true }),
      json(["중단 전 저장된 artifact는 보존되었습니다."]),
      now,
      now,
    ]);
    return result.affectedRows;
  }
}
