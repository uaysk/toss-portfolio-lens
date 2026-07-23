import { randomUUID } from "node:crypto";
import type { RelationalDatabase } from "../database.js";
import { applyPortfolioMigrations } from "../migrations.js";

export type PortfolioRunKind =
  | "backtest"
  | "optimization"
  | "walk_forward"
  | "stress_test"
  | "weight_sensitivity"
  | "start_date_sensitivity"
  | "rebalance_sensitivity"
  | "cash_flow_sensitivity"
  | "monte_carlo"
  | "outlook"
  | "technical_analysis"
  | "technical_strategy"
  | "scalping_prediction_evaluation"
  | "scalping_analysis"
  | "ai_trading_simulation"
  | "exposure_analysis"
  | "pareto_frontier"
  | "research_report";

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
  name?: string;
  tags: string[];
  archivedAt?: number;
  deletedAt?: number;
  replayOf?: string;
  manifest?: unknown;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  updatedAt: number;
};

export type PortfolioRunEventRecord = {
  id: string;
  runId: string;
  type: string;
  detail: unknown;
  createdAt: number;
};

export type PortfolioRunListInput = {
  ownerSubject: string;
  search?: string;
  kinds?: PortfolioRunKind[];
  statuses?: PortfolioRunStatus[];
  tags?: string[];
  archived?: boolean | "all";
  includeDeleted?: boolean;
  createdFrom?: number;
  createdTo?: number;
  limit?: number;
  cursor?: string;
};

export type PortfolioRunListResult = {
  items: PortfolioRunRecord[];
  nextCursor?: string;
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
  name: string | null;
  tags_json: string | null;
  archived_at: number | string | null;
  deleted_at: number | string | null;
  replay_of: string | null;
  manifest_json: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  updated_at: number;
};

type EventRow = {
  event_id: string;
  run_id: string;
  event_type: string;
  event_json: string;
  created_at: number | string;
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

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? Array.from(new Set(value.filter((item): item is string => typeof item === "string")))
    : [];
}

function normalizedTags(tags: readonly string[]): string[] {
  const normalized = tags.map((tag) => tag.trim()).filter(Boolean);
  if (normalized.some((tag) => tag.length > 64) || normalized.length > 50) {
    throw new Error("run tag는 50개 이하, 각 64자 이하여야 합니다.");
  }
  return Array.from(new Set(normalized)).sort((left, right) => left.localeCompare(right));
}

function encodeCursor(run: PortfolioRunRecord): string {
  return Buffer.from(JSON.stringify({ updatedAt: run.updatedAt, id: run.id }), "utf8").toString("base64url");
}

function decodeCursor(value: string): { updatedAt: number; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    if (!Number.isSafeInteger(parsed.updatedAt) || typeof parsed.id !== "string" || !parsed.id) throw new Error();
    return { updatedAt: Number(parsed.updatedAt), id: parsed.id };
  } catch {
    throw new Error("run 목록 cursor가 올바르지 않습니다.");
  }
}

function escapedLike(value: string): string {
  return value.replace(/=/g, "==").replace(/%/g, "=%").replace(/_/g, "=_");
}

function asRun(row: RunRow): PortfolioRunRecord {
  const warnings = parseJson(row.warnings_json);
  const tags = parseJson(row.tags_json);
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
    ...(row.name ? { name: row.name } : {}),
    tags: stringArray(tags),
    ...(row.archived_at !== null && row.archived_at !== undefined ? { archivedAt: Number(row.archived_at) } : {}),
    ...(row.deleted_at !== null && row.deleted_at !== undefined ? { deletedAt: Number(row.deleted_at) } : {}),
    ...(row.replay_of ? { replayOf: row.replay_of } : {}),
    ...(row.manifest_json ? { manifest: parseJson(row.manifest_json) } : {}),
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
          name VARCHAR(200) NULL,
          tags_json LONGTEXT NOT NULL,
          archived_at BIGINT NULL,
          deleted_at BIGINT NULL,
          replay_of VARCHAR(64) NULL,
          manifest_json LONGTEXT NULL,
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
      await applyPortfolioMigrations(this.database);
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
        name TEXT,
        tags_json TEXT NOT NULL DEFAULT '[]',
        archived_at ${timestampType},
        deleted_at ${timestampType},
        replay_of TEXT,
        manifest_json TEXT,
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
    await applyPortfolioMigrations(this.database);
  }

  async create(input: {
    kind: PortfolioRunKind;
    ownerSubject: string;
    requestHash: string;
    dataRevision: string;
    engineVersion: string;
    config: unknown;
    totalCandidates?: number;
    name?: string;
    tags?: string[];
    replayOf?: string;
    manifest?: unknown;
    now?: number;
  }): Promise<PortfolioRunRecord> {
    const now = input.now ?? Date.now();
    const id = randomUUID();
    const tags = normalizedTags(input.tags ?? []);
    const name = input.name?.trim() || undefined;
    if (name && name.length > 200) throw new Error("run 이름은 200자 이하여야 합니다.");
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
      name,
      json(tags),
      input.replayOf,
      input.manifest === undefined ? undefined : json(input.manifest),
      now,
      now,
    ];
    if (this.database.dialect === "mysql") {
      await this.database.run(`
        INSERT IGNORE INTO portfolio_backtest_runs (
          run_id, run_kind, owner_subject, request_hash, data_revision, engine_version,
          status, progress, completed_candidates, total_candidates, input_json,
          warnings_json, name, tags_json, replay_of, manifest_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, values);
    } else {
      await this.database.run(`
        INSERT INTO portfolio_backtest_runs (
          run_id, run_kind, owner_subject, request_hash, data_revision, engine_version,
          status, progress, completed_candidates, total_candidates, input_json,
          warnings_json, name, tags_json, replay_of, manifest_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(owner_subject, run_kind, request_hash, data_revision) DO NOTHING
      `, values);
    }
    let existing = await this.findByRequest(
      input.ownerSubject,
      input.kind,
      input.requestHash,
      input.dataRevision,
    );
    if (!existing) {
      const deleted = await this.findByRequestIncludingDeleted(
        input.ownerSubject,
        input.kind,
        input.requestHash,
        input.dataRevision,
      );
      if (deleted?.deletedAt !== undefined) {
        await this.database.run(`
          UPDATE portfolio_backtest_runs
          SET deleted_at = NULL, archived_at = NULL, updated_at = ?
          WHERE run_id = ? AND owner_subject = ? AND deleted_at IS NOT NULL
        `, [now, deleted.id, input.ownerSubject]);
        existing = await this.findByRequest(
          input.ownerSubject,
          input.kind,
          input.requestHash,
          input.dataRevision,
        );
      }
    }
    if (!existing) throw new Error("실행 레코드를 생성하지 못했습니다.");
    if (existing.id === id) {
      await this.addEvent(existing.id, "created", {
        kind: existing.kind,
        request_hash: existing.requestHash,
        data_revision: existing.dataRevision,
      }, now);
    }
    return existing;
  }

  async createPreflightFailureIfAbsent(input: {
    kind: PortfolioRunKind;
    ownerSubject: string;
    requestHash: string;
    dataRevision: string;
    engineVersion: string;
    config: unknown;
    error: unknown;
    totalCandidates?: number;
    manifest?: unknown;
    now?: number;
  }): Promise<{ run: PortfolioRunRecord; created: boolean }> {
    const now = input.now ?? Date.now();
    const id = randomUUID();
    const values = [
      id,
      input.kind,
      input.ownerSubject,
      input.requestHash,
      input.dataRevision,
      input.engineVersion,
      "failed",
      0,
      0,
      input.totalCandidates ?? 0,
      json(input.config),
      json(input.error),
      "[]",
      "[]",
      input.manifest === undefined ? undefined : json(input.manifest),
      now,
      now,
      now,
    ];
    return this.database.transaction(async (database) => {
      const inserted = database.dialect === "mysql"
        ? await database.run(`
            INSERT IGNORE INTO portfolio_backtest_runs (
              run_id, run_kind, owner_subject, request_hash, data_revision, engine_version,
              status, progress, completed_candidates, total_candidates, input_json,
              error_json, warnings_json, tags_json, manifest_json, created_at, finished_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `, values)
        : await database.run(`
            INSERT INTO portfolio_backtest_runs (
              run_id, run_kind, owner_subject, request_hash, data_revision, engine_version,
              status, progress, completed_candidates, total_candidates, input_json,
              error_json, warnings_json, tags_json, manifest_json, created_at, finished_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(owner_subject, run_kind, request_hash, data_revision) DO NOTHING
          `, values);
      const created = inserted.affectedRows === 1;
      if (created) {
        await this.insertEvent(database, id, "created", {
          kind: input.kind,
          request_hash: input.requestHash,
          data_revision: input.dataRevision,
        }, now);
        await this.insertEvent(database, id, "preflight_failed", input.error, now);
        await this.insertEvent(database, id, "failed", { error: input.error }, now);
      }
      const [row] = await database.query<RunRow>(`
        SELECT * FROM portfolio_backtest_runs
        WHERE owner_subject = ? AND run_kind = ? AND request_hash = ? AND data_revision = ?
      `, [input.ownerSubject, input.kind, input.requestHash, input.dataRevision]);
      if (!row) throw new Error("사전 실패 실행 레코드를 생성하거나 조회하지 못했습니다.");
      return { run: asRun(row), created };
    });
  }

  async get(id: string, ownerSubject?: string, includeDeleted = false): Promise<PortfolioRunRecord | undefined> {
    const deleted = includeDeleted ? "" : " AND deleted_at IS NULL";
    const rows = ownerSubject
      ? await this.database.query<RunRow>(
          `SELECT * FROM portfolio_backtest_runs WHERE run_id = ? AND owner_subject = ?${deleted}`,
          [id, ownerSubject],
        )
      : await this.database.query<RunRow>(
          `SELECT * FROM portfolio_backtest_runs WHERE run_id = ?${deleted}`,
          [id],
        );
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
        AND deleted_at IS NULL
    `, [ownerSubject, kind, requestHash, dataRevision]);
    return row ? asRun(row) : undefined;
  }

  private async findByRequestIncludingDeleted(
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

  async list(input: PortfolioRunListInput): Promise<PortfolioRunListResult> {
    const conditions = ["owner_subject = ?"];
    const parameters: unknown[] = [input.ownerSubject];
    if (!input.includeDeleted) conditions.push("deleted_at IS NULL");
    if (input.archived !== "all") {
      conditions.push(input.archived ? "archived_at IS NOT NULL" : "archived_at IS NULL");
    }
    if (input.search?.trim()) {
      const pattern = `%${escapedLike(input.search.trim().toLowerCase())}%`;
      conditions.push(`(
        LOWER(COALESCE(name, '')) LIKE ? ESCAPE '='
        OR LOWER(run_id) LIKE ? ESCAPE '='
        OR LOWER(run_kind) LIKE ? ESCAPE '='
      )`);
      parameters.push(pattern, pattern, pattern);
    }
    const kinds = Array.from(new Set(input.kinds ?? []));
    if (kinds.length) {
      conditions.push(`run_kind IN (${kinds.map(() => "?").join(", ")})`);
      parameters.push(...kinds);
    }
    const statuses = Array.from(new Set(input.statuses ?? []));
    if (statuses.length) {
      conditions.push(`status IN (${statuses.map(() => "?").join(", ")})`);
      parameters.push(...statuses);
    }
    for (const tag of normalizedTags(input.tags ?? [])) {
      conditions.push("tags_json LIKE ? ESCAPE '='");
      parameters.push(`%${escapedLike(JSON.stringify(tag))}%`);
    }
    if (input.createdFrom !== undefined) {
      conditions.push("created_at >= ?");
      parameters.push(input.createdFrom);
    }
    if (input.createdTo !== undefined) {
      conditions.push("created_at <= ?");
      parameters.push(input.createdTo);
    }
    if (input.cursor) {
      const cursor = decodeCursor(input.cursor);
      conditions.push("(updated_at < ? OR (updated_at = ? AND run_id < ?))");
      parameters.push(cursor.updatedAt, cursor.updatedAt, cursor.id);
    }
    const limit = Math.max(1, Math.min(200, Math.trunc(input.limit ?? 50)));
    const rows = await this.database.query<RunRow>(`
      SELECT * FROM portfolio_backtest_runs
      WHERE ${conditions.join(" AND ")}
      ORDER BY updated_at DESC, run_id DESC
      LIMIT ${limit + 1}
    `, parameters);
    const items = rows.slice(0, limit).map(asRun);
    return {
      items,
      ...(rows.length > limit && items.length ? { nextCursor: encodeCursor(items.at(-1)!) } : {}),
    };
  }

  async getEvents(
    runId: string,
    ownerSubject: string,
    options: { after?: number; afterId?: string; limit?: number } = {},
  ): Promise<PortfolioRunEventRecord[]> {
    const limit = Math.max(1, Math.min(1_000, Math.trunc(options.limit ?? 200)));
    const parameters: unknown[] = [runId, ownerSubject];
    let after = "";
    if (options.after !== undefined && options.afterId !== undefined) {
      after = " AND (event.created_at > ? OR (event.created_at = ? AND event.event_id > ?))";
      parameters.push(options.after, options.after, options.afterId);
    } else if (options.after !== undefined) {
      // Backward-compatible timestamp-only cursors retain their original semantics.
      after = " AND event.created_at > ?";
      parameters.push(options.after);
    }
    const rows = await this.database.query<EventRow>(`
      SELECT event.event_id, event.run_id, event.event_type, event.event_json, event.created_at
      FROM portfolio_run_events event
      JOIN portfolio_backtest_runs run ON run.run_id = event.run_id
      WHERE event.run_id = ? AND run.owner_subject = ?${after}
      ORDER BY event.created_at ASC, event.event_id ASC
      LIMIT ${limit}
    `, parameters);
    return rows.map((row) => ({
      id: row.event_id,
      runId: row.run_id,
      type: row.event_type,
      detail: parseJson(row.event_json),
      createdAt: Number(row.created_at),
    }));
  }

  async rename(runId: string, ownerSubject: string, name: string | undefined, now = Date.now()): Promise<PortfolioRunRecord | undefined> {
    const normalized = name?.trim() || undefined;
    if (normalized && normalized.length > 200) throw new Error("run 이름은 200자 이하여야 합니다.");
    await this.metadataUpdate(runId, ownerSubject, "name = ?", [normalized], "renamed", { name: normalized ?? null }, now);
    return this.get(runId, ownerSubject);
  }

  async setTags(runId: string, ownerSubject: string, tags: string[], now = Date.now()): Promise<PortfolioRunRecord | undefined> {
    const normalized = normalizedTags(tags);
    await this.metadataUpdate(runId, ownerSubject, "tags_json = ?", [json(normalized)], "tags_updated", { tags: normalized }, now);
    return this.get(runId, ownerSubject);
  }

  async archive(runId: string, ownerSubject: string, now = Date.now()): Promise<PortfolioRunRecord | undefined> {
    await this.metadataUpdate(runId, ownerSubject, "archived_at = ?", [now], "archived", {}, now);
    return this.get(runId, ownerSubject);
  }

  async unarchive(runId: string, ownerSubject: string, now = Date.now()): Promise<PortfolioRunRecord | undefined> {
    await this.metadataUpdate(runId, ownerSubject, "archived_at = NULL", [], "unarchived", {}, now);
    return this.get(runId, ownerSubject);
  }

  async softDelete(runId: string, ownerSubject: string, now = Date.now()): Promise<boolean> {
    return this.database.transaction(async (database) => {
      const updated = await database.run(`
        UPDATE portfolio_backtest_runs
        SET deleted_at = ?, archived_at = NULL, updated_at = ?
        WHERE run_id = ? AND owner_subject = ? AND deleted_at IS NULL
          AND status IN ('completed', 'failed', 'cancelled')
      `, [now, now, runId, ownerSubject]);
      if (updated.affectedRows !== 1) return false;
      await this.insertEvent(database, runId, "soft_deleted", {}, now);
      return true;
    });
  }

  async storeManifest(runId: string, ownerSubject: string, manifest: unknown, now = Date.now()): Promise<unknown> {
    const serialized = json(manifest);
    await this.database.transaction(async (database) => {
      const updated = await database.run(`
        UPDATE portfolio_backtest_runs
        SET manifest_json = ?, updated_at = ?
        WHERE run_id = ? AND owner_subject = ? AND deleted_at IS NULL AND manifest_json IS NULL
      `, [serialized, now, runId, ownerSubject]);
      if (updated.affectedRows === 1) {
        await this.insertEvent(database, runId, "manifest_stored", {}, now);
      }
    });
    const stored = await this.getManifest(runId, ownerSubject);
    if (stored === undefined) throw new Error("run을 찾을 수 없거나 manifest를 저장하지 못했습니다.");
    return stored;
  }

  /** Finalizes a creation-time manifest seed exactly once. A finalized manifest
   * is never overwritten, including by later exports or deployments. */
  async finalizeManifest(runId: string, ownerSubject: string, manifest: unknown, now = Date.now()): Promise<unknown> {
    return this.database.transaction(async (database) => {
      const lock = database.dialect === "sqlite" ? "" : " FOR UPDATE";
      const [row] = await database.query<{ manifest_json: string | null }>(`
        SELECT manifest_json FROM portfolio_backtest_runs
        WHERE run_id = ? AND owner_subject = ? AND deleted_at IS NULL${lock}
      `, [runId, ownerSubject]);
      if (!row) throw new Error("run을 찾을 수 없습니다.");
      const existing = parseJson(row.manifest_json);
      if (existing && typeof existing === "object" && !Array.isArray(existing)
        && (existing as Record<string, unknown>).finalized === true) return existing;
      const updated = await database.run(`
        UPDATE portfolio_backtest_runs
        SET manifest_json = ?, updated_at = ?
        WHERE run_id = ? AND owner_subject = ? AND deleted_at IS NULL
      `, [json(manifest), now, runId, ownerSubject]);
      if (updated.affectedRows !== 1) throw new Error("manifest를 finalization하지 못했습니다.");
      await this.insertEvent(database, runId, "manifest_finalized", {}, now);
      return manifest;
    });
  }

  async linkReplay(runId: string, ownerSubject: string, sourceRunId: string, now = Date.now()): Promise<boolean> {
    if (runId === sourceRunId) return false;
    return this.database.transaction(async (database) => {
      const updated = await database.run(`
        UPDATE portfolio_backtest_runs
        SET replay_of = ?, updated_at = ?
        WHERE run_id = ?
          AND owner_subject = ?
          AND deleted_at IS NULL
          AND replay_of IS NULL
          AND EXISTS (
            SELECT 1 FROM portfolio_backtest_runs source
            WHERE source.run_id = ?
              AND source.owner_subject = ?
              AND source.deleted_at IS NULL
          )
      `, [sourceRunId, now, runId, ownerSubject, sourceRunId, ownerSubject]);
      if (updated.affectedRows === 1) {
        await this.insertEvent(database, runId, "replayed_from", { run_id: sourceRunId }, now);
        return true;
      }
      return false;
    });
  }

  async getManifest(runId: string, ownerSubject: string): Promise<unknown | undefined> {
    const [row] = await this.database.query<{ manifest_json: string | null }>(`
      SELECT manifest_json FROM portfolio_backtest_runs
      WHERE run_id = ? AND owner_subject = ? AND deleted_at IS NULL
    `, [runId, ownerSubject]);
    return row?.manifest_json ? parseJson(row.manifest_json) : undefined;
  }

  private async metadataUpdate(
    runId: string,
    ownerSubject: string,
    assignment: string,
    values: unknown[],
    eventType: string,
    detail: unknown,
    now: number,
  ): Promise<boolean> {
    return this.database.transaction(async (database) => {
      const updated = await database.run(`
        UPDATE portfolio_backtest_runs
        SET ${assignment}, updated_at = ?
        WHERE run_id = ? AND owner_subject = ? AND deleted_at IS NULL
      `, [...values, now, runId, ownerSubject]);
      if (updated.affectedRows !== 1) return false;
      await this.insertEvent(database, runId, eventType, detail, now);
      return true;
    });
  }

  private insertEvent(
    database: RelationalDatabase,
    runId: string,
    type: string,
    detail: unknown,
    now: number,
  ): Promise<unknown> {
    return database.run(`
      INSERT INTO portfolio_run_events (event_id, run_id, event_type, event_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `, [randomUUID(), runId, type.slice(0, 64), json(detail), now]);
  }

  async retryTerminal(input: {
    runId: string;
    ownerSubject: string;
    expectedStatus: "failed" | "cancelled";
    totalCandidates?: number;
    now?: number;
  }): Promise<boolean> {
    const now = input.now ?? Date.now();
    return this.database.transaction(async (database) => {
      const updated = await database.run(`
        UPDATE portfolio_backtest_runs
        SET status = 'queued', progress = 0, completed_candidates = 0,
            total_candidates = COALESCE(?, total_candidates), current_validation_window = NULL,
            summary_json = NULL, result_json = NULL, error_json = NULL, warnings_json = '[]',
            started_at = NULL, finished_at = NULL, updated_at = ?
        WHERE run_id = ? AND owner_subject = ? AND status = ?
      `, [input.totalCandidates, now, input.runId, input.ownerSubject, input.expectedStatus]);
      if (updated.affectedRows !== 1) return false;
      await database.run(`
        INSERT INTO portfolio_run_events (event_id, run_id, event_type, event_json, created_at)
        VALUES (?, ?, ?, ?, ?)
      `, [randomUUID(), input.runId, "retry_requested", json({ previous_status: input.expectedStatus }), now]);
      return true;
    });
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
      // progress=1 is reserved for the same transaction that commits the
      // completed terminal state. Active runs remain visibly finalizing.
      Math.max(0, Math.min(0.99, input.progress)),
      input.completedCandidates,
      input.totalCandidates,
      input.currentValidationWindow,
      input.warnings ? json(input.warnings) : undefined,
      now,
      id,
    ]);
  }

  async requestCancellation(id: string, ownerSubject: string, now = Date.now()): Promise<boolean> {
    return this.database.transaction(async (database) => {
      const result = await database.run(`
        UPDATE portfolio_backtest_runs
        SET status = 'cancel_requested', updated_at = ?
        WHERE run_id = ? AND owner_subject = ? AND status IN ('queued', 'running')
          AND deleted_at IS NULL
      `, [now, id, ownerSubject]);
      if (result.affectedRows !== 1) return false;
      await this.insertEvent(database, id, "cancellation_requested", {}, now);
      return true;
    });
  }

  async isCancellationRequested(id: string): Promise<boolean> {
    const [row] = await this.database.query<{ status: string }>(
      "SELECT status FROM portfolio_backtest_runs WHERE run_id = ?",
      [id],
    );
    return row?.status === "cancel_requested";
  }

  async complete(id: string, summary: unknown, result: unknown, warnings: string[] = [], now = Date.now()): Promise<boolean> {
    return this.database.transaction(async (database) => {
      const updated = await database.run(`
        UPDATE portfolio_backtest_runs
        SET status = 'completed', progress = 1, summary_json = ?, result_json = ?,
            warnings_json = ?, error_json = NULL, finished_at = ?, updated_at = ?
        WHERE run_id = ? AND status IN ('queued', 'running') AND deleted_at IS NULL
      `, [json(summary), json(result), json(warnings), now, now, id]);
      if (updated.affectedRows === 1) await this.insertEvent(database, id, "completed", {}, now);
      return updated.affectedRows === 1;
    });
  }

  async cancel(id: string, summary: unknown, warnings: string[] = [], now = Date.now()): Promise<void> {
    await this.database.transaction(async (database) => {
      const updated = await database.run(`
        UPDATE portfolio_backtest_runs
        SET status = 'cancelled', summary_json = ?, warnings_json = ?, finished_at = ?, updated_at = ?
        WHERE run_id = ? AND status IN ('queued', 'running', 'cancel_requested') AND deleted_at IS NULL
      `, [json(summary), json(warnings), now, now, id]);
      if (updated.affectedRows === 1) await this.insertEvent(database, id, "cancelled", {}, now);
    });
  }

  async fail(id: string, error: unknown, warnings: string[] = [], now = Date.now()): Promise<void> {
    await this.database.transaction(async (database) => {
      const updated = await database.run(`
        UPDATE portfolio_backtest_runs
        SET status = 'failed', error_json = ?, warnings_json = ?, finished_at = ?, updated_at = ?
        WHERE run_id = ? AND status IN ('queued', 'running', 'cancel_requested') AND deleted_at IS NULL
      `, [json(error), json(warnings), now, now, id]);
      if (updated.affectedRows === 1) await this.insertEvent(database, id, "failed", { error }, now);
    });
  }

  async addEvent(id: string, type: string, detail: unknown, now = Date.now()): Promise<void> {
    await this.insertEvent(this.database, id, type, detail, now);
  }

  async recoverStaleRuns(now = Date.now(), preserveExternalJobs = false): Promise<number> {
    const result = await this.database.run(`
      UPDATE portfolio_backtest_runs
      SET status = 'failed',
          error_json = ?,
          warnings_json = ?,
          finished_at = ?, updated_at = ?
      WHERE status IN ('queued', 'running', 'cancel_requested')
        ${preserveExternalJobs ? "AND NOT EXISTS (SELECT 1 FROM portfolio_run_jobs job WHERE job.run_id = portfolio_backtest_runs.run_id)" : ""}
    `, [
      json({ code: "STALE_RUN_RECOVERED", message: "서버 재시작으로 실행이 중단되었습니다.", retryable: true }),
      json(["중단 전 저장된 artifact는 보존되었습니다."]),
      now,
      now,
    ]);
    return result.affectedRows;
  }
}
