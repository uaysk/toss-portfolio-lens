import { randomUUID } from "node:crypto";
import type { RelationalDatabase } from "../database.js";
import { applyPortfolioMigrations } from "../migrations.js";

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

  async initialize(options: { migrationsAlreadyApplied?: boolean } = {}): Promise<void> {
    if (!options.migrationsAlreadyApplied) await applyPortfolioMigrations(this.database);
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
    const [inserted] = await this.database.query<McpAuditRow>(`
      INSERT INTO mcp_tool_audit_log (
        audit_id, request_id, protocol_request_id, session_hash, tool_name, subject_hash, auth_mode, status,
        error_code, run_id, started_at, finished_at, duration_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(request_id) DO NOTHING
      RETURNING *
    `, values);
    if (inserted) return asRecord(inserted);
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
