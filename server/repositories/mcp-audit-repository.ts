import { randomUUID } from "node:crypto";
import type { RelationalDatabase } from "../database.js";

export type McpAuditStatus = "ok" | "error" | "insufficient_scope";

export type McpAuditRecord = {
  id: string;
  requestId: string;
  protocolRequestId?: string;
  sessionHash?: string;
  toolName: string;
  subjectHash: string;
  authMode: "oauth" | "none";
  status: McpAuditStatus;
  errorCode?: string;
  runId?: string;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
};

type McpAuditRow = {
  audit_id: string;
  request_id: string;
  protocol_request_id: string | null;
  session_hash: string | null;
  tool_name: string;
  subject_hash: string;
  auth_mode: "oauth" | "none";
  status: McpAuditStatus;
  error_code: string | null;
  run_id: string | null;
  started_at: number | string;
  finished_at: number | string;
  duration_ms: number | string;
};

function asRecord(row: McpAuditRow): McpAuditRecord {
  return {
    id: row.audit_id,
    requestId: row.request_id,
    ...(row.protocol_request_id ? { protocolRequestId: row.protocol_request_id } : {}),
    ...(row.session_hash ? { sessionHash: row.session_hash } : {}),
    toolName: row.tool_name,
    subjectHash: row.subject_hash,
    authMode: row.auth_mode,
    status: row.status,
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    ...(row.run_id ? { runId: row.run_id } : {}),
    startedAt: Number(row.started_at),
    finishedAt: Number(row.finished_at),
    durationMs: Number(row.duration_ms),
  };
}

export class McpAuditRepository {
  constructor(private readonly database: RelationalDatabase) {}

  async initialize(): Promise<void> {
    if (this.database.dialect === "mysql") {
      await this.database.run(`
        CREATE TABLE IF NOT EXISTS mcp_tool_audit_log (
          audit_id VARCHAR(64) PRIMARY KEY,
          request_id VARCHAR(64) NOT NULL,
          protocol_request_id VARCHAR(128) NULL,
          session_hash VARCHAR(64) NULL,
          tool_name VARCHAR(96) NOT NULL,
          subject_hash VARCHAR(64) NOT NULL,
          auth_mode VARCHAR(16) NOT NULL,
          status VARCHAR(32) NOT NULL,
          error_code VARCHAR(96) NULL,
          run_id VARCHAR(64) NULL,
          started_at BIGINT NOT NULL,
          finished_at BIGINT NOT NULL,
          duration_ms BIGINT NOT NULL,
          UNIQUE KEY uq_mcp_tool_audit_request (request_id),
          KEY idx_mcp_tool_audit_started (started_at, tool_name),
          KEY idx_mcp_tool_audit_subject (subject_hash, started_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
      await this.ensureCorrelationColumns();
      return;
    }
    const integer = this.database.dialect === "postgres" ? "BIGINT" : "INTEGER";
    await this.database.run(`
      CREATE TABLE IF NOT EXISTS mcp_tool_audit_log (
        audit_id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL UNIQUE,
        protocol_request_id TEXT,
        session_hash TEXT,
        tool_name TEXT NOT NULL,
        subject_hash TEXT NOT NULL,
        auth_mode TEXT NOT NULL CHECK (auth_mode IN ('oauth', 'none')),
        status TEXT NOT NULL CHECK (status IN ('ok', 'error', 'insufficient_scope')),
        error_code TEXT,
        run_id TEXT,
        started_at ${integer} NOT NULL,
        finished_at ${integer} NOT NULL,
        duration_ms ${integer} NOT NULL CHECK (duration_ms >= 0)
      )
    `);
    await this.database.run(`
      CREATE INDEX IF NOT EXISTS idx_mcp_tool_audit_started
      ON mcp_tool_audit_log(started_at, tool_name)
    `);
    await this.database.run(`
      CREATE INDEX IF NOT EXISTS idx_mcp_tool_audit_subject
      ON mcp_tool_audit_log(subject_hash, started_at)
    `);
    await this.ensureCorrelationColumns();
  }

  private async ensureCorrelationColumns(): Promise<void> {
    let names: Set<string>;
    if (this.database.dialect === "sqlite") {
      const rows = await this.database.query<{ name: string }>("PRAGMA table_info(mcp_tool_audit_log)");
      names = new Set(rows.map((row) => row.name));
    } else if (this.database.dialect === "mysql") {
      const rows = await this.database.query<{ column_name: string }>(`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = 'mcp_tool_audit_log'
      `);
      names = new Set(rows.map((row) => row.column_name));
    } else {
      const rows = await this.database.query<{ column_name: string }>(`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'mcp_tool_audit_log'
      `);
      names = new Set(rows.map((row) => row.column_name));
    }
    const text = this.database.dialect === "mysql" ? "VARCHAR(128)" : "TEXT";
    if (!names.has("protocol_request_id")) {
      await this.database.run(`ALTER TABLE mcp_tool_audit_log ADD COLUMN protocol_request_id ${text} NULL`);
    }
    if (!names.has("session_hash")) {
      const sessionType = this.database.dialect === "mysql" ? "VARCHAR(64)" : "TEXT";
      await this.database.run(`ALTER TABLE mcp_tool_audit_log ADD COLUMN session_hash ${sessionType} NULL`);
    }
  }

  async record(input: Omit<McpAuditRecord, "id">): Promise<McpAuditRecord> {
    const record: McpAuditRecord = {
      ...input,
      id: randomUUID(),
      ...(input.protocolRequestId ? { protocolRequestId: input.protocolRequestId.slice(0, 128) } : {}),
      ...(input.sessionHash ? { sessionHash: input.sessionHash.slice(0, 64) } : {}),
      toolName: input.toolName.slice(0, 96),
      subjectHash: input.subjectHash.slice(0, 64),
      ...(input.errorCode ? { errorCode: input.errorCode.slice(0, 96) } : {}),
      ...(input.runId ? { runId: input.runId.slice(0, 64) } : {}),
      durationMs: Math.max(0, Math.trunc(input.durationMs)),
    };
    const values = [
      record.id,
      record.requestId,
      record.protocolRequestId,
      record.sessionHash,
      record.toolName,
      record.subjectHash,
      record.authMode,
      record.status,
      record.errorCode,
      record.runId,
      Math.trunc(record.startedAt),
      Math.trunc(record.finishedAt),
      record.durationMs,
    ];
    if (this.database.dialect === "mysql") {
      await this.database.run(`
        INSERT IGNORE INTO mcp_tool_audit_log (
          audit_id, request_id, protocol_request_id, session_hash, tool_name, subject_hash, auth_mode, status,
          error_code, run_id, started_at, finished_at, duration_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, values);
    } else {
      await this.database.run(`
        INSERT INTO mcp_tool_audit_log (
          audit_id, request_id, protocol_request_id, session_hash, tool_name, subject_hash, auth_mode, status,
          error_code, run_id, started_at, finished_at, duration_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(request_id) DO NOTHING
      `, values);
    }
    const stored = await this.getByRequestId(record.requestId);
    if (!stored) throw new Error("MCP 호출 감사 로그를 저장하지 못했습니다.");
    return stored;
  }

  async getByRequestId(requestId: string): Promise<McpAuditRecord | undefined> {
    const [row] = await this.database.query<McpAuditRow>(`
      SELECT * FROM mcp_tool_audit_log WHERE request_id = ?
    `, [requestId]);
    return row ? asRecord(row) : undefined;
  }

  async list(input: { limit?: number; toolName?: string } = {}): Promise<McpAuditRecord[]> {
    const limit = Math.max(1, Math.min(1_000, Math.trunc(input.limit ?? 100)));
    const rows = input.toolName
      ? await this.database.query<McpAuditRow>(`
          SELECT * FROM mcp_tool_audit_log
          WHERE tool_name = ? ORDER BY started_at DESC LIMIT ${limit}
        `, [input.toolName])
      : await this.database.query<McpAuditRow>(`
          SELECT * FROM mcp_tool_audit_log ORDER BY started_at DESC LIMIT ${limit}
        `);
    return rows.map(asRecord);
  }

  async deleteBefore(cutoff: number): Promise<number> {
    const deleted = await this.database.run(
      "DELETE FROM mcp_tool_audit_log WHERE started_at < ?",
      [Math.trunc(cutoff)],
    );
    return deleted.affectedRows;
  }
}
