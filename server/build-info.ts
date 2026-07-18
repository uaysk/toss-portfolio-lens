import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { outputEnvelopeSchema, toolSchemas } from "./mcp/schemas.js";
import { MCP_SCHEMA_VERSION, PORTFOLIO_ENGINE_VERSION } from "./services/service-envelope.js";
import { WORKER_PAYLOAD_SCHEMA_VERSION } from "./worker/contracts.js";

export const APP_VERSION = "1.1.0";

export function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalJson(item)]));
  }
  return value;
}

function readGitHead(root: string): string | undefined {
  const gitPath = path.join(root, ".git");
  if (!existsSync(gitPath)) return undefined;
  const head = readFileSync(path.join(gitPath, "HEAD"), "utf8").trim();
  if (/^[a-f0-9]{40}$/i.test(head)) return head.toLowerCase();
  const reference = head.match(/^ref:\s+(.+)$/)?.[1];
  if (!reference) return undefined;
  const loose = path.join(gitPath, reference);
  if (existsSync(loose)) {
    const value = readFileSync(loose, "utf8").trim();
    if (/^[a-f0-9]{40}$/i.test(value)) return value.toLowerCase();
  }
  const packed = path.join(gitPath, "packed-refs");
  if (!existsSync(packed)) return undefined;
  const entry = readFileSync(packed, "utf8")
    .split(/\r?\n/)
    .find((line) => line.endsWith(` ${reference}`));
  const value = entry?.split(" ", 1)[0];
  return value && /^[a-f0-9]{40}$/i.test(value) ? value.toLowerCase() : undefined;
}

export function resolveGitSha(root = process.cwd()): string {
  const configured = process.env.APP_GIT_SHA ?? process.env.GIT_SHA ?? process.env.COMMIT_SHA;
  if (configured && /^[a-f0-9]{7,64}$/i.test(configured)) return configured.toLowerCase();
  try {
    return readGitHead(root) ?? "unknown";
  } catch {
    return "unknown";
  }
}

export function mcpSchemaHash(): string {
  const schemas = { inputs: mcpJsonSchemas(), output: mcpOutputJsonSchema() };
  return createHash("sha256").update(JSON.stringify(canonicalJson(schemas))).digest("hex");
}

export function mcpJsonSchemas(): Record<string, unknown> {
  return Object.fromEntries(Object.entries(toolSchemas).map(([name, schema]) => [
    name,
    z.toJSONSchema(schema, { target: "draft-7", io: "input", unrepresentable: "any" }),
  ]));
}

export function mcpOutputJsonSchema(): unknown {
  return z.toJSONSchema(outputEnvelopeSchema, { target: "draft-7", io: "output", unrepresentable: "any" });
}

export function buildInfo() {
  const gitSha = resolveGitSha();
  return {
    appVersion: APP_VERSION,
    gitSha,
    engineVersion: PORTFOLIO_ENGINE_VERSION,
    workerSchemaVersion: WORKER_PAYLOAD_SCHEMA_VERSION,
    mcpSchemaVersion: MCP_SCHEMA_VERSION,
    mcpToolCount: Object.keys(toolSchemas).length,
    mcpSchemaHash: mcpSchemaHash(),
  } as const;
}
