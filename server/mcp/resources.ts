import { createHash } from "node:crypto";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ArtifactType } from "../repositories/artifact-repository.js";
import type { ArtifactService } from "../services/artifact-service.js";
import type { RunService } from "../services/run-service.js";
import { MCP_SCHEMA_VERSION } from "../services/service-envelope.js";

type MarketResource = {
  ownerSubject: string;
  content: unknown;
  descriptor: {
    uri: string;
    format: "application/json";
    row_count: number;
    byte_count: number;
    checksum: string;
    generated_at: string;
    schema_version: string;
    data_revision: string;
  };
};

function authorizeResource(
  extra: { authInfo?: { scopes?: string[]; extra?: Record<string, unknown> } },
  scope: "market:read" | "backtest:run",
  authMode: "oauth" | "none",
): string {
  if (authMode === "oauth" && !extra.authInfo) throw new Error("OAuth 인증이 필요합니다.");
  if (authMode === "oauth" && !extra.authInfo?.scopes?.includes(scope)) throw new Error(`${scope} scope가 필요합니다.`);
  return typeof extra.authInfo?.extra?.sub === "string" ? extra.authInfo.extra.sub : "local-owner";
}

export class McpResourceRegistry {
  private readonly market = new Map<string, MarketResource>();
  private marketBytes = 0;

  constructor(
    private readonly artifacts: ArtifactService,
    private readonly runs: RunService,
    private readonly authMode: "oauth" | "none",
    private readonly maxMarketBytes = 20 * 1024 * 1024,
  ) {}

  private marketKey(requestHash: string, ownerSubject: string): string {
    return `${ownerSubject.length}:${ownerSubject}${requestHash}`;
  }

  storeMarket(requestHash: string, content: unknown, dataRevision: string, ownerSubject: string): MarketResource["descriptor"] {
    const json = JSON.stringify(content);
    const descriptor: MarketResource["descriptor"] = {
      uri: `market://series/${requestHash}`,
      format: "application/json",
      row_count: Array.isArray(content) ? content.length : 1,
      byte_count: Buffer.byteLength(json),
      checksum: createHash("sha256").update(json).digest("hex"),
      generated_at: new Date().toISOString(),
      schema_version: MCP_SCHEMA_VERSION,
      data_revision: dataRevision,
    };
    const key = this.marketKey(requestHash, ownerSubject);
    const previous = this.market.get(key);
    if (previous) this.marketBytes -= previous.descriptor.byte_count;
    this.market.set(key, { ownerSubject, content, descriptor });
    this.marketBytes += descriptor.byte_count;
    while (this.market.size > 200 || this.marketBytes > this.maxMarketBytes) {
      const oldest = this.market.keys().next().value as string | undefined;
      if (!oldest) break;
      const removed = this.market.get(oldest);
      this.market.delete(oldest);
      if (removed) this.marketBytes -= removed.descriptor.byte_count;
    }
    return descriptor;
  }

  getMarket(requestHash: string, ownerSubject: string): MarketResource | undefined {
    return this.market.get(this.marketKey(requestHash, ownerSubject));
  }

  register(server: McpServer): void {
    server.registerResource(
      "market-price-series",
      new ResourceTemplate("market://series/{requestHash}", { list: undefined }),
      { title: "시장 가격 시계열", description: "대용량 가격 시계열 JSON", mimeType: "application/json" },
      async (_uri, variables, extra) => {
        const ownerSubject = authorizeResource(extra, "market:read", this.authMode);
        const key = String(variables.requestHash ?? "");
        const stored = this.getMarket(key, ownerSubject);
        if (!stored) throw new Error("시장 시계열 resource가 만료되었거나 없습니다.");
        return {
          contents: [{
            uri: stored.descriptor.uri,
            mimeType: "application/json",
            text: JSON.stringify({ descriptor: stored.descriptor, data: stored.content }),
          }],
        };
      },
    );

    const templates: Array<{ name: string; template: string; type: ArtifactType }> = [
      { name: "backtest-equity", template: "backtest://runs/{runId}/equity", type: "equity" },
      { name: "backtest-drawdown", template: "backtest://runs/{runId}/drawdown", type: "drawdown" },
      { name: "backtest-holdings", template: "backtest://runs/{runId}/holdings", type: "holdings" },
      { name: "backtest-trades", template: "backtest://runs/{runId}/trades", type: "trades" },
      { name: "backtest-rolling", template: "backtest://runs/{runId}/rolling", type: "rolling" },
      { name: "backtest-correlation", template: "backtest://runs/{runId}/correlation", type: "correlation" },
      { name: "backtest-risk-contribution", template: "backtest://runs/{runId}/risk-contribution", type: "risk-contribution" },
      { name: "backtest-monthly-returns", template: "backtest://runs/{runId}/monthly-returns", type: "monthly-returns" },
      { name: "optimization-candidates", template: "optimization://runs/{runId}/candidates", type: "candidates" },
      { name: "optimization-walk-forward", template: "optimization://runs/{runId}/walk-forward", type: "walk-forward" },
    ];
    for (const item of templates) {
      server.registerResource(
        item.name,
        new ResourceTemplate(item.template, { list: undefined }),
        { title: item.name, description: "저장된 실행 artifact JSON", mimeType: "application/json" },
        async (_uri, variables, extra) => {
          const runId = String(variables.runId ?? "");
          const run = await this.runs.get(runId, authorizeResource(extra, "backtest:run", this.authMode));
          if (!run) throw new Error("실행을 찾을 수 없습니다.");
          const artifact = await this.artifacts.get(runId, item.type);
          if (!artifact) throw new Error("artifact를 찾을 수 없습니다.");
          return {
            contents: [{
              uri: artifact.descriptor.uri,
              mimeType: artifact.descriptor.format,
              text: JSON.stringify({ descriptor: artifact.descriptor, data: artifact.content }),
            }],
          };
        },
      );
    }
  }
}
