import { describe, expect, it } from "vitest";
import { SqliteDatabase } from "../database.js";
import { McpAuditRepository } from "./mcp-audit-repository.js";

describe("McpAuditRepository", () => {
  it("payload나 token 없이 호출 메타데이터를 멱등 저장하고 기간 정리한다", async () => {
    const database = new SqliteDatabase(":memory:");
    try {
      const repository = new McpAuditRepository(database);
      await repository.initialize();
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
      await repository.record(input);
      await repository.record(input);

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
    const database = new SqliteDatabase(":memory:");
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
