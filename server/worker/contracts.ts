import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { z } from "zod";
import type { PortfolioRunKind } from "../repositories/run-repository.js";

export const WORKER_PAYLOAD_SCHEMA_VERSION = "1.0";
export const WORKER_ARTIFACT_FORMAT = "application/json";
export const WORKER_ARTIFACT_ENCODING = "gzip";
export const WORKER_ARTIFACT_MAX_BYTES = 128 * 1024 * 1024;

const jobKinds = [
  "backtest",
  "optimization",
  "walk_forward",
  "stress_test",
  "weight_sensitivity",
  "start_date_sensitivity",
  "rebalance_sensitivity",
  "cash_flow_sensitivity",
  "monte_carlo",
  "outlook",
] as const satisfies readonly PortfolioRunKind[];

export const WorkerJobKindSchema = z.enum(jobKinds);

export const WorkerInputSchema = z.object({
  schema_version: z.literal(WORKER_PAYLOAD_SCHEMA_VERSION),
  engine_version: z.string().min(1).max(64),
  run_id: z.string().min(1).max(64),
  job_kind: WorkerJobKindSchema,
  data_revision: z.string().min(1).max(128),
  request_hash: z.string().regex(/^[a-f0-9]{64}$/),
  payload: z.record(z.string(), z.unknown()),
}).strict();

export type WorkerInput = z.infer<typeof WorkerInputSchema>;

export const WorkerOutputSchema = z.object({
  schema_version: z.literal(WORKER_PAYLOAD_SCHEMA_VERSION),
  engine_version: z.string().min(1).max(64),
  run_id: z.string().min(1).max(64),
  job_kind: WorkerJobKindSchema,
  status: z.enum(["completed", "failed", "cancelled"]),
  summary: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
  warnings: z.array(z.string()),
  artifacts: z.array(z.object({
    type: z.string().min(1).max(64),
    content: z.unknown(),
    row_count: z.number().int().nonnegative().optional(),
  }).strict()).optional(),
  data_revision: z.string().min(1).max(128).optional(),
  request_hash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  payload_hash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();

export type WorkerOutput = z.infer<typeof WorkerOutputSchema>;

function rawKeyCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalValue(value: unknown, path = "$"): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`worker payload의 ${path} 값은 유한한 숫자여야 합니다.`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map((item, index) => canonicalValue(item, `${path}[${index}]`));
  if (value instanceof Map) {
    return Object.fromEntries(
      Array.from(value.entries())
        .map(([key, item]) => [String(key), canonicalValue(item, `${path}.${String(key)}`)] as const)
        .sort(([left], [right]) => rawKeyCompare(left, right)),
    );
  }
  if (typeof value === "object" && value) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => rawKeyCompare(left, right))
      .map(([key, item]) => [key, canonicalValue(item, `${path}.${key}`)] as const);
    return Object.fromEntries(entries);
  }
  throw new Error(`worker payload의 ${path} 값은 JSON으로 직렬화할 수 없습니다.`);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export function encodeWorkerArtifact(value: WorkerInput | WorkerOutput): {
  content: Buffer;
  checksum: string;
  byteCount: number;
  uncompressedByteCount: number;
} {
  const validated = "payload" in value ? WorkerInputSchema.parse(value) : WorkerOutputSchema.parse(value);
  const source = Buffer.from(canonicalJson(validated), "utf8");
  if (source.byteLength > WORKER_ARTIFACT_MAX_BYTES) {
    throw new Error("worker artifact가 압축 전 128MiB 상한을 초과했습니다.");
  }
  const content = gzipSync(source, { level: 6 });
  if (content.byteLength > WORKER_ARTIFACT_MAX_BYTES) {
    throw new Error("worker artifact가 압축 후 128MiB 상한을 초과했습니다.");
  }
  return {
    content,
    checksum: createHash("sha256").update(source).digest("hex"),
    byteCount: content.byteLength,
    uncompressedByteCount: source.byteLength,
  };
}

export function decodeWorkerArtifact(
  content: Buffer,
  expectedChecksum: string,
  expectedSize?: { byteCount: number; uncompressedByteCount: number },
): WorkerInput | WorkerOutput {
  if (content.byteLength > WORKER_ARTIFACT_MAX_BYTES) {
    throw new Error("압축된 worker artifact가 128MiB 상한을 초과했습니다.");
  }
  if (expectedSize && (!Number.isSafeInteger(expectedSize.byteCount)
    || !Number.isSafeInteger(expectedSize.uncompressedByteCount)
    || expectedSize.byteCount !== content.byteLength
    || expectedSize.uncompressedByteCount < 0
    || expectedSize.uncompressedByteCount > WORKER_ARTIFACT_MAX_BYTES)) {
    throw new Error("worker artifact 크기 metadata가 유효하지 않습니다.");
  }
  const source = gunzipSync(content, { maxOutputLength: WORKER_ARTIFACT_MAX_BYTES });
  if (expectedSize && source.byteLength !== expectedSize.uncompressedByteCount) {
    throw new Error("worker artifact 비압축 크기 metadata가 일치하지 않습니다.");
  }
  const checksum = createHash("sha256").update(source).digest("hex");
  if (checksum !== expectedChecksum) throw new Error("worker artifact checksum이 일치하지 않습니다.");
  const parsed = JSON.parse(source.toString("utf8")) as unknown;
  if (typeof parsed === "object" && parsed && "payload" in parsed) return WorkerInputSchema.parse(parsed);
  return WorkerOutputSchema.parse(parsed);
}
