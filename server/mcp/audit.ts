import { createHash, createHmac } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { McpAuditRepository, McpAuditStatus } from "../repositories/mcp-audit-repository.js";

export function anonymizedAuditValue(value: string, salt?: string): string {
  return salt
    ? createHmac("sha256", salt).update(value).digest("hex").slice(0, 32)
    : createHash("sha256").update(value).digest("hex").slice(0, 32);
}

export function protocolRequestId(value: unknown): string | undefined {
  return typeof value === "string" || typeof value === "number"
    ? String(value).slice(0, 128)
    : undefined;
}

export async function persistMcpAudit(
  repository: McpAuditRepository | undefined,
  input: {
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
  },
): Promise<void> {
  if (!repository) return;
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await repository.record({
        ...input,
        durationMs: Math.max(0, input.finishedAt - input.startedAt),
      });
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 2) await delay(10 * (attempt + 1));
    }
  }
  console.warn("[mcp-audit] 호출 기록 저장 실패:", lastError instanceof Error ? lastError.message : "unknown error");
}
