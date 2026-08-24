import type { Server } from "node:http";
import { readFileSync } from "node:fs";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpServer } from "./server.js";
import { createMcpHttpRuntime, type McpHttpRuntime } from "./transport.js";
import type { McpToolDependencies } from "./tools/handlers.js";
import { PGliteDatabase } from "../../test-support/pglite-database.js";
import { McpAuditRepository } from "../repositories/mcp-audit-repository.js";

const generatedContract = JSON.parse(readFileSync(
  new URL("./generated-contract.json", import.meta.url),
  "utf8",
)) as { toolCount: number; tools: Array<{ name: string }> };

function parseResponse(text: string, contentType: string | null): unknown {
  if (!text) return undefined;
  if (!contentType?.includes("text/event-stream")) return JSON.parse(text);
  const data = text.split(/\r?\n/).filter((line) => line.startsWith("data:"));
  return JSON.parse(data.at(-1)!.slice(5).trim());
}

function testToolDependencies(): McpToolDependencies {
  return {
    instruments: { search: vi.fn().mockResolvedValue([]) },
    marketData: { repository: { dataRevision: vi.fn().mockResolvedValue("revision-1") } },
    resources: { register: vi.fn() },
    maxCandidateBudget: 10_000,
    maxAssets: 20,
    maxDateRangeYears: 20,
  } as unknown as McpToolDependencies;
}

const transportHeaders = {
  accept: "application/json, text/event-stream",
  "content-type": "application/json",
};

async function initializeSession(url: string, additionalHeaders: Record<string, string> = {}): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { ...transportHeaders, ...additionalHeaders },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "transport-test", version: "1" } },
    }),
  });
}

describe("MCP Streamable HTTP transport", () => {
  let server: Server | undefined;
  let runtime: McpHttpRuntime | undefined;
  let database: PGliteDatabase | undefined;

  afterEach(async () => {
    const activeRuntime = runtime;
    const activeServer = server;
    const activeDatabase = database;
    runtime = undefined;
    server = undefined;
    database = undefined;
    await activeRuntime?.close();
    if (activeServer) await new Promise<void>((resolve) => activeServer.close(() => resolve()));
    await activeDatabase?.close();
  });

  async function startTestRuntime(
    overrides: Partial<Parameters<typeof createMcpHttpRuntime>[0]> = {},
    trustProxy = false,
  ): Promise<string> {
    const dependencies = testToolDependencies();
    runtime = createMcpHttpRuntime({
      serverFactory: () => createMcpServer({
        dependencies,
        authMode: "none",
        resourceMetadataUrl: "http://127.0.0.1/.well-known/oauth-protected-resource",
      }),
      authMode: "none",
      resourceMetadataUrl: "http://127.0.0.1/.well-known/oauth-protected-resource",
      allowedOrigins: [],
      maxRequestsPerMinute: 100,
      ...overrides,
    });
    const app = express();
    if (trustProxy) app.set("trust proxy", true);
    app.use(express.json({ limit: "16kb" }));
    app.use(runtime.router);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server address unavailable");
    return `http://127.0.0.1:${address.port}/mcp`;
  }

  it("stateful session과 명시적 stateless 요청을 모두 처리한다", async () => {
    const dependencies = {
      instruments: { search: vi.fn().mockResolvedValue([]) },
      marketData: { repository: { dataRevision: vi.fn().mockResolvedValue("revision-1") } },
      resources: { register: vi.fn() },
      maxCandidateBudget: 10_000,
      maxAssets: 20,
      maxDateRangeYears: 20,
    } as unknown as McpToolDependencies;
    database = new PGliteDatabase();
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
    expect(listedBody.result.tools).toHaveLength(generatedContract.toolCount);
    expect((listedBody.result.tools as Array<{ name: string }>).map((tool) => tool.name))
      .toEqual(generatedContract.tools.map((tool) => tool.name));

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

  it("N+1 stateful session을 생성 전에 거절하고 close 후 슬롯을 재사용한다", async () => {
    const dependencies = testToolDependencies();
    const serverFactory = vi.fn(() => createMcpServer({
      dependencies,
      authMode: "none",
      resourceMetadataUrl: "http://127.0.0.1/.well-known/oauth-protected-resource",
    }));
    const url = await startTestRuntime({ serverFactory, maximumStatefulSessions: 2 });

    const first = await initializeSession(url);
    const second = await initializeSession(url);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstSessionId = first.headers.get("mcp-session-id");
    const secondSessionId = second.headers.get("mcp-session-id");
    expect(firstSessionId).toBeTruthy();
    expect(secondSessionId).toBeTruthy();
    await first.text();
    await second.text();
    expect(runtime?.activeSessionCount()).toBe(2);

    const overflow = await initializeSession(url);
    expect(overflow.status).toBe(503);
    expect(overflow.headers.get("retry-after")).toBeTruthy();
    expect(overflow.headers.get("cache-control")).toBe("no-store");
    expect(await overflow.json()).toMatchObject({
      error: { code: -32000, message: "MCP session capacity reached" },
    });
    expect(serverFactory).toHaveBeenCalledTimes(2);

    const closed = await fetch(url, {
      method: "DELETE",
      headers: { ...transportHeaders, "mcp-session-id": firstSessionId! },
    });
    expect(closed.status).toBeLessThan(300);
    await closed.text();
    expect(runtime?.activeSessionCount()).toBe(1);

    const replacement = await initializeSession(url);
    expect(replacement.status).toBe(200);
    expect(replacement.headers.get("mcp-session-id")).toBeTruthy();
    await replacement.text();
    expect(runtime?.activeSessionCount()).toBe(2);
    expect(serverFactory).toHaveBeenCalledTimes(3);
  });

  it("동시에 진행 중인 session 초기화도 capacity 예약에 포함한다", async () => {
    const dependencies = testToolDependencies();
    let releaseConnect!: () => void;
    const connectGate = new Promise<void>((resolve) => {
      releaseConnect = resolve;
    });
    const serverFactory = vi.fn(() => {
      const mcpServer = createMcpServer({
        dependencies,
        authMode: "none",
        resourceMetadataUrl: "http://127.0.0.1/.well-known/oauth-protected-resource",
      });
      const connect = mcpServer.connect.bind(mcpServer);
      mcpServer.connect = async (transport) => {
        await connectGate;
        return connect(transport);
      };
      return mcpServer;
    });
    const url = await startTestRuntime({ serverFactory, maximumStatefulSessions: 1 });

    const firstInitialization = initializeSession(url);
    await vi.waitFor(() => expect(serverFactory).toHaveBeenCalledOnce());

    let overflow: Response;
    try {
      overflow = await initializeSession(url);
    } finally {
      releaseConnect();
    }
    expect(overflow.status).toBe(503);
    expect(serverFactory).toHaveBeenCalledOnce();

    const first = await firstInitialization;
    expect(first.status).toBe(200);
    await first.text();
    expect(runtime?.activeSessionCount()).toBe(1);
  }, 10_000);

  it("close 중인 session 초기화를 등록하지 않고 transport를 한 번만 정리한다", async () => {
    const dependencies = testToolDependencies();
    let releaseConnect!: () => void;
    const connectGate = new Promise<void>((resolve) => {
      releaseConnect = resolve;
    });
    const closeSpies: Array<ReturnType<typeof vi.fn>> = [];
    const serverFactory = vi.fn(() => {
      const mcpServer = createMcpServer({
        dependencies,
        authMode: "none",
        resourceMetadataUrl: "http://127.0.0.1/.well-known/oauth-protected-resource",
      });
      const connect = mcpServer.connect.bind(mcpServer);
      mcpServer.connect = async (transport) => {
        await connectGate;
        return connect(transport);
      };
      const close = mcpServer.close.bind(mcpServer);
      const closeSpy = vi.fn(() => close());
      mcpServer.close = closeSpy;
      closeSpies.push(closeSpy);
      return mcpServer;
    });
    const url = await startTestRuntime({ serverFactory, maximumStatefulSessions: 1 });

    const initialization = initializeSession(url);
    await vi.waitFor(() => expect(serverFactory).toHaveBeenCalledOnce());

    const firstClose = runtime!.close();
    const secondClose = runtime!.close();
    expect(secondClose).toBe(firstClose);
    releaseConnect();

    const response = await initialization;
    await expect(response.json()).resolves.toMatchObject({
      error: { code: -32000, message: "MCP transport is shutting down" },
    });
    await firstClose;

    expect(response.status).toBe(503);
    expect(runtime?.activeSessionCount()).toBe(0);
    expect(closeSpies).toHaveLength(1);
    expect(closeSpies[0]).toHaveBeenCalledOnce();
    await expect(runtime!.close()).resolves.toBeUndefined();
    expect(closeSpies[0]).toHaveBeenCalledOnce();
  }, 10_000);

  it("TTL cleanup 후 stateful session 슬롯을 재사용한다", async () => {
    const url = await startTestRuntime({
      maximumStatefulSessions: 1,
      statefulSessionTtlMs: 20,
      statefulSessionCleanupIntervalMs: 5,
    });

    const first = await initializeSession(url);
    expect(first.status).toBe(200);
    expect(first.headers.get("mcp-session-id")).toBeTruthy();
    await first.text();
    expect(runtime?.activeSessionCount()).toBe(1);

    await vi.waitFor(() => expect(runtime?.activeSessionCount()).toBe(0), { timeout: 1_000 });

    const replacement = await initializeSession(url);
    expect(replacement.status).toBe(200);
    expect(replacement.headers.get("mcp-session-id")).toBeTruthy();
    await replacement.text();
    expect(runtime?.activeSessionCount()).toBe(1);
  });

  it("활성 GET SSE session은 TTL에서 제외하고 연결 종료 뒤 idle TTL로 정리한다", async () => {
    const url = await startTestRuntime({
      maximumStatefulSessions: 1,
      statefulSessionTtlMs: 100,
      statefulSessionCleanupIntervalMs: 10,
    });
    const initialized = await initializeSession(url);
    const sessionId = initialized.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();
    await initialized.text();

    const streamAbort = new AbortController();
    const stream = await fetch(url, {
      headers: {
        accept: "text/event-stream",
        "mcp-session-id": sessionId!,
      },
      signal: streamAbort.signal,
    });
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");

    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(runtime?.activeSessionCount()).toBe(1);

    streamAbort.abort();
    await vi.waitFor(() => expect(runtime?.activeSessionCount()).toBe(0), { timeout: 1_000 });
  });

  it("동시 stateless 요청을 상한에서 거절하고 완료 후 슬롯을 재사용한다", async () => {
    const dependencies = testToolDependencies();
    let releaseConnect!: () => void;
    const connectGate = new Promise<void>((resolve) => {
      releaseConnect = resolve;
    });
    const serverFactory = vi.fn(() => {
      const mcpServer = createMcpServer({
        dependencies,
        authMode: "none",
        resourceMetadataUrl: "http://127.0.0.1/.well-known/oauth-protected-resource",
      });
      const connect = mcpServer.connect.bind(mcpServer);
      mcpServer.connect = async (transport) => {
        await connectGate;
        return connect(transport);
      };
      return mcpServer;
    });
    const url = await startTestRuntime({ serverFactory, maximumStatelessRequests: 1 });
    const statelessHeaders = { "mcp-session-mode": "stateless" };

    const firstRequest = initializeSession(url, statelessHeaders);
    await vi.waitFor(() => expect(serverFactory).toHaveBeenCalledOnce());

    let overflow: Response;
    try {
      overflow = await initializeSession(url, statelessHeaders);
    } finally {
      releaseConnect();
    }
    expect(overflow.status).toBe(503);
    expect(overflow.headers.get("retry-after")).toBe("1");
    expect(overflow.headers.get("cache-control")).toBe("no-store");
    expect(await overflow.json()).toMatchObject({
      error: { code: -32000, message: "MCP stateless request capacity reached" },
    });
    expect(serverFactory).toHaveBeenCalledOnce();

    const first = await firstRequest;
    expect(first.status).toBe(200);
    await first.text();
    const replacement = await initializeSession(url, statelessHeaders);
    expect(replacement.status).toBe(200);
    await replacement.text();
    expect(serverFactory).toHaveBeenCalledTimes(2);
  }, 10_000);

  it("trusted proxy가 설정되면 forwarded IP별로 rate bucket을 분리한다", async () => {
    const url = await startTestRuntime({
      maxRequestsPerMinute: 1,
      maximumRateBuckets: 4,
    }, true);
    const statelessHeaders = { "mcp-session-mode": "stateless" };

    const firstClient = await initializeSession(url, {
      ...statelessHeaders,
      "x-forwarded-for": "198.51.100.10",
    });
    expect(firstClient.status).toBe(200);
    await firstClient.text();

    const limitedClient = await initializeSession(url, {
      ...statelessHeaders,
      "x-forwarded-for": "198.51.100.10",
    });
    expect(limitedClient.status).toBe(429);
    expect(limitedClient.headers.get("retry-after")).toBeTruthy();
    expect(limitedClient.headers.get("cache-control")).toBe("no-store");

    const otherClient = await initializeSession(url, {
      ...statelessHeaders,
      "x-forwarded-for": "198.51.100.11",
    });
    expect(otherClient.status).toBe(200);
    await otherClient.text();
  });

  it("rate bucket capacity를 넘는 새 IP를 429로 거절한다", async () => {
    const url = await startTestRuntime({
      maxRequestsPerMinute: 100,
      maximumRateBuckets: 2,
    }, true);
    const requestFrom = (ip: string) => initializeSession(url, {
      "mcp-session-mode": "stateless",
      "x-forwarded-for": ip,
    });

    const first = await requestFrom("198.51.100.20");
    const second = await requestFrom("198.51.100.21");
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    await first.text();
    await second.text();

    const overflow = await requestFrom("198.51.100.22");
    expect(overflow.status).toBe(429);
    expect(overflow.headers.get("retry-after")).toBeTruthy();
    expect(overflow.headers.get("cache-control")).toBe("no-store");
    expect(await overflow.json()).toMatchObject({
      error: { code: -32000, message: "Too many MCP request sources" },
    });

    const existing = await requestFrom("198.51.100.20");
    expect(existing.status).toBe(200);
    await existing.text();
  });

  it("CORS 거절 응답을 origin별 비공유 응답으로 표시한다", async () => {
    const url = await startTestRuntime({
      allowedOrigins: ["https://allowed.example"],
    });

    const denied = await initializeSession(url, {
      origin: "https://denied.example",
      "mcp-session-mode": "stateless",
    });
    expect(denied.status).toBe(403);
    expect(denied.headers.get("vary")).toContain("Origin");
    expect(denied.headers.get("cache-control")).toBe("no-store");
    expect(await denied.json()).toEqual({ error: "origin_not_allowed" });
  });
});
