import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { MCP_SCOPE_IDS, hasScopes, type McpScopeId } from "../auth/mcp-scope.js";
import { MCP_SERVER_INSTRUCTIONS } from "./instructions.js";
import { outputEnvelopeSchema, toolSchemas, type ToolName } from "./schemas.js";
import { toolMetadata, securitySchemes } from "./tools/metadata.js";
import { createToolHandlers, resolvePresetExecution, type McpToolDependencies } from "./tools/handlers.js";
import { toolError } from "./errors.js";
import { ServiceError } from "../services/service-envelope.js";
import { enforceToolRequestLimits } from "../services/tool-request-limits.js";
import type { McpAuditRepository, McpAuditStatus } from "../repositories/mcp-audit-repository.js";
import { anonymizedAuditValue, persistMcpAudit, protocolRequestId } from "./audit.js";
import { APP_VERSION, buildInfo } from "../build-info.js";

function insufficientScope(scopes: McpScopeId[], resourceMetadataUrl: string): CallToolResult {
  const challenge = `Bearer error="insufficient_scope", scope="${scopes.join(" ")}", resource_metadata="${resourceMetadataUrl}"`;
  return {
    isError: true,
    structuredContent: {
      error: {
        code: "insufficient_scope",
        message: "도구 실행에 추가 OAuth scope가 필요합니다.",
        retryable: true,
        details: { required_scopes: scopes },
      },
    },
    content: [{ type: "text", text: `추가 권한이 필요합니다: ${scopes.join(", ")}` }],
    _meta: { "mcp/www_authenticate": [challenge] },
  };
}

function runId(value: unknown, depth = 0): string | undefined {
  if (depth > 3 || !value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const direct = record.run_id ?? record.runId;
  if (typeof direct === "string" && direct.length <= 64) return direct;
  return runId(record.result, depth + 1) ?? runId(record.summary, depth + 1);
}

function asStructured(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : { result: value };
}

function requestsBacktestReport(argumentsValue: unknown): boolean {
  if (!argumentsValue || typeof argumentsValue !== "object" || Array.isArray(argumentsValue)) return false;
  const report = (argumentsValue as { report?: unknown }).report;
  return Boolean(report && typeof report === "object" && !Array.isArray(report)
    && (report as { enabled?: unknown }).enabled === true);
}

export function createMcpServer(input: {
  dependencies: McpToolDependencies;
  authMode: "oauth" | "none";
  resourceMetadataUrl: string;
  audit?: McpAuditRepository;
  auditSubjectSalt?: string;
}): McpServer {
  const identity = buildInfo();
  const server = new McpServer(
    {
      name: "Toss Portfolio Lens",
      version: identity.gitSha === "unknown" ? APP_VERSION : `${APP_VERSION}+${identity.gitSha.slice(0, 12)}`,
      title: "Toss Portfolio Lens",
      description: JSON.stringify(identity),
    },
    { instructions: MCP_SERVER_INSTRUCTIONS },
  );
  const handlers = createToolHandlers(input.dependencies);

  for (const name of Object.keys(toolSchemas) as ToolName[]) {
    const metadata = toolMetadata[name];
    const callback = async (argumentsValue: unknown, extra: {
      authInfo?: { scopes: string[]; extra?: Record<string, unknown> };
      requestId: string | number;
      sessionId?: string;
    }): Promise<CallToolResult> => {
      const started = Date.now();
      const requestId = randomUUID();
      const scopes = input.authMode === "none" ? [...MCP_SCOPE_IDS] : extra.authInfo?.scopes ?? [];
      const subject = input.authMode === "none"
        ? "local-owner"
        : typeof extra.authInfo?.extra?.sub === "string" ? extra.authInfo.extra.sub : "owner";
      let handlerArguments = argumentsValue;
      let resolvedPresetId: string | undefined;
      let presetResolutionError: unknown;
      if (name === "run_portfolio_backtest"
        && hasScopes(scopes, metadata.scopes)
        && argumentsValue && typeof argumentsValue === "object" && !Array.isArray(argumentsValue)) {
        const presetId = (argumentsValue as { presetId?: unknown }).presetId;
        if (typeof presetId === "string") {
          try {
            handlerArguments = await resolvePresetExecution(
              input.dependencies,
              subject,
              argumentsValue as Record<string, unknown>,
              "run_portfolio_backtest",
              { markUsed: false },
            );
            resolvedPresetId = presetId;
          } catch (error) {
            presetResolutionError = error;
          }
        }
      }
      const required = [...metadata.scopes];
      if (!presetResolutionError && name === "run_portfolio_backtest" && requestsBacktestReport(handlerArguments)) {
        required.push("report:generate");
      }
      if (["analyze_portfolio_exposures", "build_pareto_frontier", "generate_research_report"].includes(name)
        && handlerArguments && typeof handlerArguments === "object" && !Array.isArray(handlerArguments)
        && (handlerArguments as { executionMode?: unknown }).executionMode === "async") {
        required.push("backtest:run");
      }
      const subjectHash = anonymizedAuditValue(subject, input.auditSubjectSalt);
      const actualRequestId = protocolRequestId(extra.requestId);
      const sessionHash = extra.sessionId
        ? anonymizedAuditValue(extra.sessionId, input.auditSubjectSalt)
        : undefined;
      if (!hasScopes(scopes, required)) {
        const finishedAt = Date.now();
        await persistMcpAudit(input.audit, {
          requestId,
          ...(actualRequestId ? { protocolRequestId: actualRequestId } : {}),
          ...(sessionHash ? { sessionHash } : {}),
          toolName: name,
          subjectHash,
          authMode: input.authMode,
          status: "insufficient_scope",
          errorCode: "insufficient_scope",
          startedAt: started,
          finishedAt,
        });
        console.info(JSON.stringify({
          event: "mcp_tool",
          request_id: requestId,
          tool: name,
          duration_ms: finishedAt - started,
          status: "insufficient_scope",
          subject: subjectHash,
        }));
        return insufficientScope(Array.from(new Set(required)), input.resourceMetadataUrl);
      }
      let status: McpAuditStatus = "ok";
      let errorCode: string | undefined;
      let associatedRunId: string | undefined;
      try {
        if (presetResolutionError) throw presetResolutionError;
        if (resolvedPresetId) {
          const used = await input.dependencies.presets.markUsed(resolvedPresetId, subject);
          if (!used) {
            throw new ServiceError({
              code: "PRESET_NOT_FOUND",
              message: "preset을 찾을 수 없습니다.",
              retryable: false,
              details: { preset_id: resolvedPresetId },
            });
          }
        }
        enforceToolRequestLimits(handlerArguments, input.dependencies);
        const result = await handlers[name](handlerArguments, subject);
        associatedRunId = runId(result);
        const structuredContent = outputEnvelopeSchema.parse(asStructured(result));
        const text = JSON.stringify(structuredContent);
        return {
          structuredContent,
          content: [{ type: "text", text: text.length > 4_000 ? `${text.slice(0, 4_000)}…` : text }],
        };
      } catch (error) {
        status = "error";
        errorCode = error instanceof ServiceError
          ? error.detail.code
          : error instanceof Error ? error.name.slice(0, 96) : "UNKNOWN_ERROR";
        return toolError(error);
      } finally {
        const finishedAt = Date.now();
        await persistMcpAudit(input.audit, {
          requestId,
          ...(actualRequestId ? { protocolRequestId: actualRequestId } : {}),
          ...(sessionHash ? { sessionHash } : {}),
          toolName: name,
          subjectHash,
          authMode: input.authMode,
          status,
          ...(errorCode ? { errorCode } : {}),
          ...(associatedRunId ? { runId: associatedRunId } : {}),
          startedAt: started,
          finishedAt,
        });
        console.info(JSON.stringify({
          event: "mcp_tool",
          request_id: requestId,
          tool: name,
          duration_ms: finishedAt - started,
          status,
          subject: subjectHash,
        }));
      }
    };

    server.registerTool(name, {
      title: metadata.title,
      description: metadata.description,
      inputSchema: toolSchemas[name],
      outputSchema: outputEnvelopeSchema,
      annotations: metadata.annotations,
      _meta: { securitySchemes: securitySchemes(metadata.scopes) },
    } as never, callback as never);
  }

  input.dependencies.resources.register(server);
  return server;
}
