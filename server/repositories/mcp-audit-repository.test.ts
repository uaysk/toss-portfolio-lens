import { describe, expect, it, vi } from "vitest";
import { PGliteDatabase } from "../../test-support/pglite-database.js";
import { McpAuditRepository } from "./mcp-audit-repository.js";

describe("McpAuditRepository", () => {
  it("이미 적용된 migration 뒤에는 repository가 DDL을 반복하지 않는다", async () => {
    const run = vi.fn().mockResolvedValue({ affectedRows: 0 });
    const query = vi.fn().mockResolvedValue([]);
    const repository = new McpAuditRepository({
      run,
      query,
      transaction: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    });

    await repository.initialize({ migrationsAlreadyApplied: true });

    expect(run).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it("payload나 token 없이 호출 메타데이터를 멱등 저장하고 기간 정리한다", async () => {
    const database = new PGliteDatabase();
    try {
      const repository = new McpAuditRepository(database);
      await repository.initialize();
      const [toolListIndex] = await database.query<{ indexdef: string }>(`
        SELECT indexdef FROM pg_indexes
        WHERE schemaname = current_schema()
          AND indexname = 'idx_mcp_tool_audit_tool_started'
      `);
      expect(toolListIndex?.indexdef).toContain("(tool_name, started_at DESC)");
      const input = {
        requestId: "request-1",
        protocolRequestId: "json-rpc-7",
        sessionHash: "c".repeat(32),
        toolName: "run_portfolio_backtest",
        subjectHash: "a".repeat(32),
        authMode: "oauth" as const,
        status: "ok" as const,
        runId: "run-1",
        startedAt: 1_000,
        finishedAt: 1_125,
        durationMs: 125,
      };
      const query = vi.spyOn(database, "query");
      query.mockClear();
      const first = await repository.record(input);
      expect(query).toHaveBeenCalledTimes(1);
      expect(String(query.mock.calls[0]?.[0])).toContain("RETURNING *");

      query.mockClear();
      const duplicate = await repository.record(input);
      expect(duplicate).toEqual(first);
      expect(query).toHaveBeenCalledTimes(2);

      expect(await repository.list()).toEqual([expect.objectContaining({
        requestId: "request-1",
        protocolRequestId: "json-rpc-7",
        sessionHash: "c".repeat(32),
        toolName: "run_portfolio_backtest",
        status: "ok",
        durationMs: 125,
        runId: "run-1",
      })]);
      const rows = await database.query<Record<string, unknown>>("SELECT * FROM mcp_tool_audit_log");
      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows)).not.toContain("access_token");
      expect(await repository.deleteBefore(1_001)).toBe(1);
      expect(await repository.list()).toEqual([]);
    } finally {
      await database.close();
    }
  });

  it("오류 코드와 insufficient scope를 구조화해 저장한다", async () => {
    const database = new PGliteDatabase();
    try {
      const repository = new McpAuditRepository(database);
      await repository.initialize();
      await repository.record({
        requestId: "request-2",
        toolName: "get_current_portfolio",
        subjectHash: "b".repeat(32),
        authMode: "oauth",
        status: "insufficient_scope",
        errorCode: "insufficient_scope",
        startedAt: 2_000,
        finishedAt: 2_001,
        durationMs: 1,
      });
      expect(await repository.getByRequestId("request-2")).toMatchObject({
        status: "insufficient_scope",
        errorCode: "insufficient_scope",
      });
    } finally {
      await database.close();
    }
  });
});
