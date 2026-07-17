import { createHash, randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { MCP_SCOPE_IDS, hasScopes, type McpScopeId } from "../auth/mcp-scope.js";
import { MCP_SERVER_INSTRUCTIONS } from "./instructions.js";
import { outputEnvelopeSchema, toolSchemas, type ToolName } from "./schemas.js";
import { toolMetadata, securitySchemes } from "./tools/metadata.js";
import { createToolHandlers, type McpToolDependencies } from "./tools/handlers.js";
import { toolError } from "./errors.js";
import { ServiceError } from "../services/service-envelope.js";

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

function anonymizedSubject(subject: string): string {
  return createHash("sha256").update(subject).digest("hex").slice(0, 12);
}

function asStructured(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : { result: value };
}

function dateRangeDays(from: unknown, to: unknown): number | undefined {
  if (typeof from !== "string" || typeof to !== "string") return undefined;
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  return Number.isFinite(start) && Number.isFinite(end) ? Math.floor((end - start) / 86_400_000) : undefined;
}

function enforceLimits(value: unknown, dependencies: McpToolDependencies): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const input = value as Record<string, unknown>;
  const nested = input.baseConfig && typeof input.baseConfig === "object"
    ? input.baseConfig as Record<string, unknown>
    : undefined;
  const days = dateRangeDays(input.fromDate ?? input.startDate, input.toDate ?? input.endDate)
    ?? (nested ? dateRangeDays(nested.startDate, nested.endDate) : undefined);
  if (days !== undefined && days > dependencies.maxDateRangeYears * 366) {
    throw new ServiceError({
      code: "DATE_RANGE_LIMIT",
      message: `요청 기간은 최대 ${dependencies.maxDateRangeYears}년입니다.`,
      retryable: false,
      field: "fromDate",
    });
  }
  const assets = Array.isArray(input.assets) ? input.assets
    : nested && Array.isArray(nested.assets) ? nested.assets
      : Array.isArray(input.symbols) ? input.symbols : undefined;
  if (assets && assets.length > dependencies.maxAssets) {
    throw new ServiceError({
      code: "ASSET_LIMIT",
      message: `종목은 최대 ${dependencies.maxAssets}개까지 사용할 수 있습니다.`,
      retryable: false,
      field: "assets",
    });
  }
}

export function createMcpServer(input: {
  dependencies: McpToolDependencies;
  authMode: "oauth" | "none";
  resourceMetadataUrl: string;
}): McpServer {
  const server = new McpServer(
    { name: "Toss Portfolio Lens", version: "1.0.0", title: "Toss Portfolio Lens" },
    { instructions: MCP_SERVER_INSTRUCTIONS },
  );
  const handlers = createToolHandlers(input.dependencies);

  for (const name of Object.keys(toolSchemas) as ToolName[]) {
    const metadata = toolMetadata[name];
    const callback = async (argumentsValue: unknown, extra: {
      authInfo?: { scopes: string[]; extra?: Record<string, unknown> };
    }): Promise<CallToolResult> => {
      const started = Date.now();
      const requestId = randomUUID();
      const scopes = input.authMode === "none" ? [...MCP_SCOPE_IDS] : extra.authInfo?.scopes ?? [];
      const required = [...metadata.scopes];
      if (name === "run_portfolio_backtest") {
        const report = argumentsValue && typeof argumentsValue === "object"
          ? (argumentsValue as { report?: { enabled?: boolean } }).report
          : undefined;
        if (report?.enabled) required.push("report:generate");
      }
      const subject = input.authMode === "none"
        ? "local-owner"
        : typeof extra.authInfo?.extra?.sub === "string" ? extra.authInfo.extra.sub : "owner";
      if (!hasScopes(scopes, required)) {
        console.info(JSON.stringify({
          event: "mcp_tool",
          request_id: requestId,
          tool: name,
          duration_ms: Date.now() - started,
          status: "insufficient_scope",
          subject: anonymizedSubject(subject),
        }));
        return insufficientScope(Array.from(new Set(required)), input.resourceMetadataUrl);
      }
      let status = "ok";
      try {
        enforceLimits(argumentsValue, input.dependencies);
        const result = await handlers[name](argumentsValue, subject);
        const structuredContent = asStructured(result);
        const text = JSON.stringify(structuredContent);
        return {
          structuredContent,
          content: [{ type: "text", text: text.length > 4_000 ? `${text.slice(0, 4_000)}…` : text }],
        };
      } catch (error) {
        status = "error";
        return toolError(error);
      } finally {
        console.info(JSON.stringify({
          event: "mcp_tool",
          request_id: requestId,
          tool: name,
          duration_ms: Date.now() - started,
          status,
          subject: anonymizedSubject(subject),
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
