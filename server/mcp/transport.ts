import { randomUUID } from "node:crypto";
import { Router, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { BoundedFixedWindowRateLimiter } from "../auth/fixed-window-rate-limiter.js";
import { normalizeClientIp } from "../auth/login-attempt-limiter.js";
import type { McpAuditRepository } from "../repositories/mcp-audit-repository.js";
import { anonymizedAuditValue, persistMcpAudit, protocolRequestId } from "./audit.js";
import { toolSchemas, type ToolName } from "./schemas.js";

type Session = {
  transport: StreamableHTTPServerTransport;
  close: () => Promise<void>;
  principal: string;
  lastSeenAt: number;
  activeRequests: number;
};

export type McpHttpRuntime = {
  router: Router;
  close: () => Promise<void>;
  activeSessionCount: () => number;
};

const DEFAULT_MAXIMUM_STATEFUL_SESSIONS = 128;
const DEFAULT_MAXIMUM_STATELESS_REQUESTS = 128;
const DEFAULT_SESSION_TTL_MS = 60 * 60_000;
const DEFAULT_SESSION_CLEANUP_INTERVAL_MS = 5 * 60_000;
const DEFAULT_MAXIMUM_RATE_BUCKETS = 2_000;
const RATE_BUCKET_WINDOW_MS = 60_000;

function principal(request: Request): string {
  const subject = typeof request.auth?.extra?.sub === "string" ? request.auth.extra.sub : "local-owner";
  return `${request.auth?.clientId ?? "local"}:${subject}`;
}

function sessionId(request: Request): string | undefined {
  const value = request.headers["mcp-session-id"];
  return typeof value === "string" && value ? value : undefined;
}

function jsonRpcError(response: Response, status: number, code: number, message: string): void {
  response.setHeader("Cache-Control", "no-store");
  response.status(status).json({ jsonrpc: "2.0", error: { code, message }, id: null });
}

function requestIp(request: Request): string {
  return normalizeClientIp(request.ip || request.socket.remoteAddress);
}

function corsMiddleware(allowedOrigins: ReadonlySet<string>): RequestHandler {
  return (request, response, next) => {
    const origin = request.get("origin");
    if (origin) {
      response.vary("Origin");
      if (!allowedOrigins.has(origin)) {
        response.setHeader("Cache-Control", "no-store");
        response.status(403).json({ error: "origin_not_allowed" });
        return;
      }
      response.setHeader("Access-Control-Allow-Origin", origin);
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

function rateLimitMiddleware(maxRequestsPerMinute: number, maximumBuckets: number): RequestHandler {
  const limiter = new BoundedFixedWindowRateLimiter({
    maximumRequests: maxRequestsPerMinute,
    windowMs: RATE_BUCKET_WINDOW_MS,
    maximumEntries: maximumBuckets,
  });
  return (request, response, next) => {
    const key = `${requestIp(request)}:${principal(request)}`;
    const decision = limiter.check(key);
    if (!decision.allowed) {
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Retry-After", String(decision.retryAfterSeconds));
      response.status(429).json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: decision.reason === "source-capacity"
            ? "Too many MCP request sources"
            : "Too many MCP requests",
        },
        id: null,
      });
      return;
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
  maximumStatefulSessions?: number;
  maximumStatelessRequests?: number;
  statefulSessionTtlMs?: number;
  statefulSessionCleanupIntervalMs?: number;
  maximumRateBuckets?: number;
  audit?: McpAuditRepository;
  auditSubjectSalt?: string;
}): McpHttpRuntime {
  if (input.authMode === "oauth" && !input.verifier) {
    throw new Error("OAuth MCP transport requires a token verifier.");
  }

  const maximumStatefulSessions = input.maximumStatefulSessions ?? DEFAULT_MAXIMUM_STATEFUL_SESSIONS;
  const maximumStatelessRequests = input.maximumStatelessRequests ?? DEFAULT_MAXIMUM_STATELESS_REQUESTS;
  const sessionTtlMs = input.statefulSessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  const sessionCleanupIntervalMs = input.statefulSessionCleanupIntervalMs ?? DEFAULT_SESSION_CLEANUP_INTERVAL_MS;
  const maximumRateBuckets = input.maximumRateBuckets ?? DEFAULT_MAXIMUM_RATE_BUCKETS;
  if (
    !Number.isInteger(maximumStatefulSessions) || maximumStatefulSessions < 1
    || !Number.isInteger(maximumStatelessRequests) || maximumStatelessRequests < 1
    || !Number.isInteger(sessionTtlMs) || sessionTtlMs < 1
    || !Number.isInteger(sessionCleanupIntervalMs) || sessionCleanupIntervalMs < 1
    || !Number.isInteger(maximumRateBuckets) || maximumRateBuckets < 1
  ) {
    throw new Error("MCP transport capacity configuration is invalid.");
  }

  const router = Router();
  const sessions = new Map<string, Session>();
  const sessionInitializationTasks = new Set<Promise<void>>();
  let pendingSessionInitializations = 0;
  let activeStatelessRequests = 0;
  let closed = false;
  let closeTask: Promise<void> | undefined;
  const bearer = input.authMode === "oauth"
    ? requireBearerAuth({
        verifier: input.verifier!,
        resourceMetadataUrl: input.resourceMetadataUrl,
      })
    : ((_request: Request, _response: Response, next: NextFunction) => next());

  const cors = corsMiddleware(new Set(input.allowedOrigins));
  const rateLimit = rateLimitMiddleware(input.maxRequestsPerMinute, maximumRateBuckets);
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
    if (activeStatelessRequests >= maximumStatelessRequests) {
      response.setHeader("Retry-After", "1");
      jsonRpcError(response, 503, -32000, "MCP stateless request capacity reached");
      return;
    }
    activeStatelessRequests += 1;
    let server: McpServer | undefined;
    let transport: StreamableHTTPServerTransport | undefined;
    try {
      server = input.serverFactory();
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await server.connect(transport);
      await transport.handleRequest(request, response, request.body);
    } catch (error) {
      console.error("[mcp] stateless transport failed:", error instanceof Error ? error.message : "unknown error");
      if (!response.headersSent) jsonRpcError(response, 500, -32603, "Internal server error");
    } finally {
      await transport?.close().catch(() => undefined);
      await server?.close().catch(() => undefined);
      activeStatelessRequests -= 1;
    }
  }

  function finishSessionRequest(session: Session): void {
    session.activeRequests = Math.max(0, session.activeRequests - 1);
    session.lastSeenAt = Date.now();
  }

  async function handleSessionRequest(session: Session, handler: () => Promise<void>): Promise<void> {
    session.activeRequests += 1;
    session.lastSeenAt = Date.now();
    try {
      await handler();
    } finally {
      finishSessionRequest(session);
    }
  }

  function cleanupExpiredSessions(now: number): void {
    const cutoff = now - sessionTtlMs;
    for (const [id, session] of sessions) {
      if (session.activeRequests > 0 || session.lastSeenAt > cutoff) continue;
      sessions.delete(id);
      void session.close();
    }
  }

  async function initializeNewSession(
    request: Request,
    response: Response,
    releaseInitializationReservation: () => void,
  ): Promise<void> {
    const server = input.serverFactory();
    let initializedSession: Session | undefined;
    let transport: StreamableHTTPServerTransport;
    let resourceCloseTask: Promise<void> | undefined;
    const closeResources = () => {
      resourceCloseTask ??= (async () => {
        await transport.close().catch(() => undefined);
        await server.close().catch(() => undefined);
      })();
      return resourceCloseTask;
    };
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        initializedSession = {
          transport,
          close: closeResources,
          principal: principal(request),
          lastSeenAt: Date.now(),
          activeRequests: 1,
        };
        if (!closed) sessions.set(id, initializedSession);
        // The initialized session now occupies the slot that was reserved for
        // it. Release the pending reservation immediately so the same slot is
        // not counted twice while handleRequest finishes writing its response.
        releaseInitializationReservation();
      },
    });
    transport.onclose = () => {
      const id = transport.sessionId;
      if (id) sessions.delete(id);
    };
    try {
      await server.connect(transport);
      if (closed) {
        jsonRpcError(response, 503, -32000, "MCP transport is shutting down");
        await closeResources();
        return;
      }
      await transport.handleRequest(request, response, request.body);
      if (!transport.sessionId || closed) {
        const id = transport.sessionId;
        if (id) sessions.delete(id);
        await closeResources();
      }
    } catch (error) {
      console.error("[mcp] session initialization failed:", error instanceof Error ? error.message : "unknown error");
      const id = transport.sessionId;
      if (id) sessions.delete(id);
      await closeResources();
      if (!response.headersSent) jsonRpcError(response, 500, -32603, "Internal server error");
    } finally {
      if (initializedSession) finishSessionRequest(initializedSession);
    }
  }

  async function handleNewSession(request: Request, response: Response): Promise<void> {
    if (closed) {
      jsonRpcError(response, 503, -32000, "MCP transport is shutting down");
      return;
    }
    if (sessions.size + pendingSessionInitializations >= maximumStatefulSessions) {
      cleanupExpiredSessions(Date.now());
    }
    if (sessions.size + pendingSessionInitializations >= maximumStatefulSessions) {
      response.setHeader("Retry-After", "60");
      jsonRpcError(response, 503, -32000, "MCP session capacity reached");
      return;
    }

    pendingSessionInitializations += 1;
    let reservationHeld = true;
    const releaseInitializationReservation = () => {
      if (!reservationHeld) return;
      reservationHeld = false;
      pendingSessionInitializations -= 1;
    };
    const initializationTask = initializeNewSession(request, response, releaseInitializationReservation);
    sessionInitializationTasks.add(initializationTask);
    try {
      await initializationTask;
    } finally {
      sessionInitializationTasks.delete(initializationTask);
      releaseInitializationReservation();
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
      await handleSessionRequest(
        session,
        () => session.transport.handleRequest(request, response, request.body),
      );
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
    await handleSessionRequest(session, () => session.transport.handleRequest(request, response));
  }

  const cleanupTimer = setInterval(() => {
    cleanupExpiredSessions(Date.now());
  }, sessionCleanupIntervalMs);
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
    close: () => {
      closed = true;
      if (closeTask) return closeTask;
      clearInterval(cleanupTimer);
      const active = [...sessions.values()];
      sessions.clear();
      const initializing = [...sessionInitializationTasks];
      closeTask = Promise.all([
        Promise.all(active.map((session) => session.close())),
        Promise.allSettled(initializing),
      ]).then(() => undefined);
      return closeTask;
    },
  };
}
