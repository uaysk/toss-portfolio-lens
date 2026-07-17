import type { Server } from "node:http";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpServer } from "./server.js";
import { createMcpHttpRuntime, type McpHttpRuntime } from "./transport.js";
import type { McpToolDependencies } from "./tools/handlers.js";
import { SqliteDatabase } from "../database.js";
import { McpAuditRepository } from "../repositories/mcp-audit-repository.js";

function parseResponse(text: string, contentType: string | null): unknown {
  if (!text) return undefined;
  if (!contentType?.includes("text/event-stream")) return JSON.parse(text);
  const data = text.split(/\r?\n/).filter((line) => line.startsWith("data:"));
  return JSON.parse(data.at(-1)!.slice(5).trim());
}

describe("MCP Streamable HTTP transport", () => {
  let server: Server | undefined;
  let runtime: McpHttpRuntime | undefined;
  let database: SqliteDatabase | undefined;

  afterEach(async () => {
    await runtime?.close();
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    await database?.close();
  });

  it("stateful session과 명시적 stateless 요청을 모두 처리한다", async () => {
    const dependencies = {
      instruments: { search: vi.fn().mockResolvedValue([]) },
      marketData: { repository: { dataRevision: vi.fn().mockResolvedValue("revision-1") } },
      resources: { register: vi.fn() },
      maxCandidateBudget: 10_000,
      maxAssets: 20,
      maxDateRangeYears: 20,
    } as unknown as McpToolDependencies;
    database = new SqliteDatabase(":memory:");
    const audit = new McpAuditRepository(database);
    await audit.initialize();
    runtime = createMcpHttpRuntime({
      serverFactory: () => createMcpServer({
        dependencies,
        authMode: "none",
        resourceMetadataUrl: "http://127.0.0.1/.well-known/oauth-protected-resource",
        audit,
        auditSubjectSalt: "test-salt",
      }),
      authMode: "none",
      resourceMetadataUrl: "http://127.0.0.1/.well-known/oauth-protected-resource",
      allowedOrigins: [],
      maxRequestsPerMinute: 100,
      audit,
      auditSubjectSalt: "test-salt",
    });
    const app = express();
    app.use(express.json({ limit: "16kb" }));
    app.use(runtime.router);
    app.get("/api/health", (_request, response) => response.json({ status: "ok" }));
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server address unavailable");
    const url = `http://127.0.0.1:${address.port}/mcp`;
    const headers = { accept: "application/json, text/event-stream", "content-type": "application/json" };

    const health = await fetch(`http://127.0.0.1:${address.port}/api/health`, {
      headers: { origin: "https://unrelated.example" },
    });
    expect(health.status).toBe(200);

    const initialize = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "transport-test", version: "1" } },
      }),
    });
    expect(initialize.status).toBe(200);
    const sessionId = initialize.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();
    expect(runtime.activeSessionCount()).toBe(1);
    const initializeBody = parseResponse(await initialize.text(), initialize.headers.get("content-type")) as Record<string, unknown>;
    expect(initializeBody).toHaveProperty("result");

    const listed = await fetch(url, {
      method: "POST",
      headers: { ...headers, "mcp-session-id": sessionId! },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    expect(listed.status).toBe(200);
    const listedBody = parseResponse(await listed.text(), listed.headers.get("content-type")) as { result: { tools: unknown[] } };
    expect(listedBody.result.tools).toHaveLength(31);

    const validTool = await fetch(url, {
      method: "POST",
      headers: { ...headers, "mcp-session-id": sessionId! },
      body: JSON.stringify({ jsonrpc: "2.0", id: "valid-5", method: "tools/call", params: { name: "search_instruments", arguments: { query: "AAPL" } } }),
    });
    expect(validTool.status).toBe(200);

    const unknownTool = await fetch(url, {
      method: "POST",
      headers: { ...headers, "mcp-session-id": sessionId! },
      body: JSON.stringify({ jsonrpc: "2.0", id: "unknown-6", method: "tools/call", params: { name: "unknown_tool", arguments: {} } }),
    });
    expect(unknownTool.status).toBe(200);

    const invalidInput = await fetch(url, {
      method: "POST",
      headers: { ...headers, "mcp-session-id": sessionId! },
      body: JSON.stringify({ jsonrpc: "2.0", id: "invalid-7", method: "tools/call", params: { name: "search_instruments", arguments: {} } }),
    });
    expect(invalidInput.status).toBe(200);
    const auditRows = await audit.list({ limit: 10 });
    expect(auditRows).toEqual(expect.arrayContaining([
      expect.objectContaining({ protocolRequestId: "valid-5", toolName: "search_instruments", status: "ok" }),
      expect.objectContaining({ protocolRequestId: "unknown-6", toolName: "unknown_tool", status: "error", errorCode: "UNKNOWN_TOOL" }),
      expect.objectContaining({ protocolRequestId: "invalid-7", toolName: "search_instruments", status: "error", errorCode: "INVALID_TOOL_INPUT" }),
    ]));
    expect(auditRows.every((row) => Boolean(row.sessionHash))).toBe(true);

    const missing = await fetch(url, {
      method: "POST",
      headers: { ...headers, "mcp-session-id": "missing-session" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }),
    });
    expect(missing.status).toBe(404);

    const statelessInitialize = await fetch(`${url}?session=stateless`, {
      method: "POST",
      headers: { ...headers, "mcp-session-mode": "stateless" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "initialize",
        params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "stateless-test", version: "1" } },
      }),
    });
    expect(statelessInitialize.status).toBe(200);
    expect(statelessInitialize.headers.get("mcp-session-id")).toBeNull();

    const deleted = await fetch(url, { method: "DELETE", headers: { ...headers, "mcp-session-id": sessionId! } });
    expect(deleted.status).toBeLessThan(300);
    expect(runtime.activeSessionCount()).toBe(0);
  });
});
