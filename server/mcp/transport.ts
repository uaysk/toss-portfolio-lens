import { randomUUID } from "node:crypto";
import { Router, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { McpAuditRepository } from "../repositories/mcp-audit-repository.js";
import { anonymizedAuditValue, persistMcpAudit, protocolRequestId } from "./audit.js";
import { toolSchemas, type ToolName } from "./schemas.js";

type Session = {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  principal: string;
  lastSeenAt: number;
};

export type McpHttpRuntime = {
  router: Router;
  close: () => Promise<void>;
  activeSessionCount: () => number;
};

type RateBucket = { count: number; resetAt: number };

function principal(request: Request): string {
  const subject = typeof request.auth?.extra?.sub === "string" ? request.auth.extra.sub : "local-owner";
  return `${request.auth?.clientId ?? "local"}:${subject}`;
}

function sessionId(request: Request): string | undefined {
  const value = request.headers["mcp-session-id"];
  return typeof value === "string" && value ? value : undefined;
}

function jsonRpcError(response: Response, status: number, code: number, message: string): void {
  response.status(status).json({ jsonrpc: "2.0", error: { code, message }, id: null });
}

function requestIp(request: Request): string {
  return request.socket.remoteAddress ?? "unknown";
}

function corsMiddleware(allowedOrigins: ReadonlySet<string>): RequestHandler {
  return (request, response, next) => {
    const origin = request.get("origin");
    if (origin) {
      if (!allowedOrigins.has(origin)) {
        response.status(403).json({ error: "origin_not_allowed" });
        return;
      }
      response.setHeader("Access-Control-Allow-Origin", origin);
      response.setHeader("Vary", "Origin");
      response.setHeader("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS");
      response.setHeader(
        "Access-Control-Allow-Headers",
        "Authorization, Content-Type, MCP-Protocol-Version, MCP-Session-Id, Last-Event-ID, MCP-Session-Mode",
      );
      response.setHeader("Access-Control-Expose-Headers", "MCP-Session-Id, WWW-Authenticate");
    }
    if (request.method === "OPTIONS") {
      response.status(204).end();
      return;
    }
    next();
  };
}

function rateLimitMiddleware(maxRequestsPerMinute: number): RequestHandler {
  const buckets = new Map<string, RateBucket>();
  return (request, response, next) => {
    const now = Date.now();
    const key = `${requestIp(request)}:${principal(request)}`;
    const previous = buckets.get(key);
    const bucket = previous && previous.resetAt > now
      ? previous
      : { count: 0, resetAt: now + 60_000 };
    bucket.count += 1;
    buckets.set(key, bucket);
    if (bucket.count > maxRequestsPerMinute) {
      response.setHeader("Retry-After", String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1_000))));
      response.status(429).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Too many MCP requests" },
        id: null,
      });
      return;
    }
    if (buckets.size > 2_000) {
      for (const [bucketKey, value] of buckets) if (value.resetAt <= now) buckets.delete(bucketKey);
    }
    next();
  };
}

export function createMcpHttpRuntime(input: {
  serverFactory: () => McpServer;
  authMode: "oauth" | "none";
  verifier?: OAuthTokenVerifier;
  resourceMetadataUrl: string;
  allowedOrigins: string[];
  maxRequestsPerMinute: number;
  audit?: McpAuditRepository;
  auditSubjectSalt?: string;
}): McpHttpRuntime {
  if (input.authMode === "oauth" && !input.verifier) {
    throw new Error("OAuth MCP transport requires a token verifier.");
  }

  const router = Router();
  const sessions = new Map<string, Session>();
  const sessionTtlMs = 60 * 60_000;
  const bearer = input.authMode === "oauth"
    ? requireBearerAuth({
        verifier: input.verifier!,
        resourceMetadataUrl: input.resourceMetadataUrl,
      })
    : ((_request: Request, _response: Response, next: NextFunction) => next());

  const cors = corsMiddleware(new Set(input.allowedOrigins));
  const rateLimit = rateLimitMiddleware(input.maxRequestsPerMinute);
  const auditRejectedToolCall: RequestHandler = (request, _response, next) => {
    void (async () => {
      const messages = Array.isArray(request.body) ? request.body : [request.body];
      for (const message of messages) {
        if (!message || typeof message !== "object" || Array.isArray(message)) continue;
        const rpc = message as Record<string, unknown>;
        if (rpc.method !== "tools/call") continue;
        const startedAt = Date.now();
        const params = rpc.params && typeof rpc.params === "object" && !Array.isArray(rpc.params)
          ? rpc.params as Record<string, unknown>
          : {};
        const requestedName = typeof params.name === "string" ? params.name : "<missing>";
        const schema = requestedName in toolSchemas ? toolSchemas[requestedName as ToolName] : undefined;
        const errorCode = !schema
          ? "UNKNOWN_TOOL"
          : schema.safeParse(params.arguments ?? {}).success ? undefined : "INVALID_TOOL_INPUT";
        if (!errorCode) continue;
        const subject = input.authMode === "none"
          ? "local-owner"
          : typeof request.auth?.extra?.sub === "string" ? request.auth.extra.sub : "owner";
        const actualRequestId = protocolRequestId(rpc.id);
        const id = sessionId(request);
        await persistMcpAudit(input.audit, {
          requestId: randomUUID(),
          ...(actualRequestId ? { protocolRequestId: actualRequestId } : {}),
          ...(id ? { sessionHash: anonymizedAuditValue(id, input.auditSubjectSalt) } : {}),
          toolName: requestedName,
          subjectHash: anonymizedAuditValue(subject, input.auditSubjectSalt),
          authMode: input.authMode,
          status: "error",
          errorCode,
          startedAt,
          finishedAt: Date.now(),
        });
      }
    })().catch((error) => {
      console.warn("[mcp-audit] 사전 검증 오류 기록 실패:", error instanceof Error ? error.message : "unknown error");
    }).finally(next);
  };

  async function handleStateless(request: Request, response: Response): Promise<void> {
    const server = input.serverFactory();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await server.connect(transport);
      await transport.handleRequest(request, response, request.body);
    } catch (error) {
      console.error("[mcp] stateless transport failed:", error instanceof Error ? error.message : "unknown error");
      if (!response.headersSent) jsonRpcError(response, 500, -32603, "Internal server error");
    } finally {
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  }

  async function handleNewSession(request: Request, response: Response): Promise<void> {
    const server = input.serverFactory();
    let transport: StreamableHTTPServerTransport;
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { server, transport, principal: principal(request), lastSeenAt: Date.now() });
      },
    });
    transport.onclose = () => {
      const id = transport.sessionId;
      if (id) sessions.delete(id);
    };
    try {
      await server.connect(transport);
      await transport.handleRequest(request, response, request.body);
      if (!transport.sessionId) {
        await transport.close().catch(() => undefined);
        await server.close().catch(() => undefined);
      }
    } catch (error) {
      console.error("[mcp] session initialization failed:", error instanceof Error ? error.message : "unknown error");
      const id = transport.sessionId;
      if (id) sessions.delete(id);
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
      if (!response.headersSent) jsonRpcError(response, 500, -32603, "Internal server error");
    }
  }

  async function post(request: Request, response: Response): Promise<void> {
    const id = sessionId(request);
    if (id) {
      const session = sessions.get(id);
      if (!session) {
        jsonRpcError(response, 404, -32001, "MCP session not found");
        return;
      }
      if (session.principal !== principal(request)) {
        jsonRpcError(response, 403, -32003, "MCP session principal mismatch");
        return;
      }
      session.lastSeenAt = Date.now();
      await session.transport.handleRequest(request, response, request.body);
      return;
    }

    const explicitStateless = request.get("mcp-session-mode")?.toLowerCase() === "stateless"
      || request.query.session === "stateless";
    if (isInitializeRequest(request.body) && !explicitStateless) {
      await handleNewSession(request, response);
      return;
    }
    await handleStateless(request, response);
  }

  async function established(request: Request, response: Response): Promise<void> {
    const id = sessionId(request);
    if (!id) {
      jsonRpcError(response, 400, -32000, "MCP-Session-Id header is required");
      return;
    }
    const session = sessions.get(id);
    if (!session) {
      jsonRpcError(response, 404, -32001, "MCP session not found");
      return;
    }
    if (session.principal !== principal(request)) {
      jsonRpcError(response, 403, -32003, "MCP session principal mismatch");
      return;
    }
    session.lastSeenAt = Date.now();
    await session.transport.handleRequest(request, response);
  }

  const cleanupTimer = setInterval(() => {
    const cutoff = Date.now() - sessionTtlMs;
    for (const [id, session] of sessions) {
      if (session.lastSeenAt > cutoff) continue;
      sessions.delete(id);
      void session.transport.close().catch(() => undefined);
      void session.server.close().catch(() => undefined);
    }
  }, 5 * 60_000);
  cleanupTimer.unref();

  const route = (handler: (request: Request, response: Response) => Promise<void>): RequestHandler => (
    request,
    response,
  ) => {
    void handler(request, response).catch((error) => {
      console.error("[mcp] transport request failed:", error instanceof Error ? error.message : "unknown error");
      if (!response.headersSent) jsonRpcError(response, 500, -32603, "Internal server error");
    });
  };

  router.options("/mcp", cors, rateLimit, (_request, response) => response.status(204).end());
  router.post("/mcp", cors, rateLimit, bearer, auditRejectedToolCall, route(post));
  router.get("/mcp", cors, rateLimit, bearer, route(established));
  router.delete("/mcp", cors, rateLimit, bearer, route(established));

  return {
    router,
    activeSessionCount: () => sessions.size,
    close: async () => {
      clearInterval(cleanupTimer);
      const active = [...sessions.values()];
      sessions.clear();
      await Promise.all(active.map(async ({ server, transport }) => {
        await transport.close().catch(() => undefined);
        await server.close().catch(() => undefined);
      }));
    },
  };
}
