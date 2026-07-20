import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { PortfolioRunKind } from "../repositories/run-repository.js";
import { backtestArtifacts } from "../services/backtest-artifacts.js";
import { TechnicalAnalysisWorkerResultSchema } from "../services/technical-analysis-contract.js";
import { TechnicalStrategyWorkerResultSchema } from "../services/technical-strategy-contract.js";

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
  "technical_analysis",
  "technical_strategy",
] as const satisfies readonly PortfolioRunKind[];

export const WorkerJobKindSchema = z.enum(jobKinds);

export const WorkerMetricsContentSchema = z.object({
  compute_ms: z.number().finite().nonnegative(),
  engine: z.string().min(1).max(64),
  ipc: z.enum(["unix_domain_socket_length_frame_v2", "postgres_artifact_queue"]),
  cancellation: z.string().min(1).max(128),
}).passthrough();

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

const WorkerOutputBaseSchema = z.object({
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

export const WorkerOutputSchema = WorkerOutputBaseSchema.superRefine((output, context) => {
  if (output.status !== "completed") return;
  if (output.job_kind === "technical_analysis") {
    const parsed = TechnicalAnalysisWorkerResultSchema.safeParse(output.result);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        context.addIssue({
          code: "custom",
          path: ["result", ...issue.path],
          message: `기술적 분석 worker result 계약 오류: ${issue.message}`,
        });
      }
      return;
    }
    const indicators = output.artifacts?.filter((artifact) => artifact.type === "technical-indicators") ?? [];
    const diagnostics = output.artifacts?.filter((artifact) => artifact.type === "technical-diagnostics") ?? [];
    if (indicators.length > 1 || diagnostics.length > 1) {
      context.addIssue({ code: "custom", path: ["artifacts"], message: "기술적 분석 artifact type은 중복될 수 없습니다." });
      return;
    }
    if (indicators[0] && !isDeepStrictEqual(indicators[0].content, parsed.data.calculations)) {
      context.addIssue({ code: "custom", path: ["artifacts"], message: "technical-indicators artifact가 result.calculations와 일치하지 않습니다." });
    }
    if (diagnostics[0] && !isDeepStrictEqual(diagnostics[0].content, parsed.data.diagnostics)) {
      context.addIssue({ code: "custom", path: ["artifacts"], message: "technical-diagnostics artifact가 result.diagnostics와 일치하지 않습니다." });
    }
    return;
  }
  if (output.job_kind !== "technical_strategy") return;
  const parsed = TechnicalStrategyWorkerResultSchema.safeParse(output.result);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      context.addIssue({
        code: "custom",
        path: ["result", ...issue.path],
        message: `기술 신호 전략 worker result 계약 오류: ${issue.message}`,
      });
    }
    return;
  }
  const expected = [
    {
      type: "technical-indicators",
      content: parsed.data.technical_analysis.calculations,
      rowCount: parsed.data.technical_analysis.calculations.length,
    },
    {
      type: "technical-signals",
      content: parsed.data.technical_strategy.signals,
      rowCount: parsed.data.technical_strategy.signals.length,
    },
    {
      type: "technical-diagnostics",
      content: {
        indicator: parsed.data.technical_analysis.diagnostics,
        strategy: parsed.data.technical_strategy.diagnostics,
      },
      rowCount: 1,
    },
    ...(parsed.data.backtest ? backtestArtifacts(parsed.data.backtest) : []),
  ];
  const actual = output.artifacts ?? [];
  const metrics = actual.filter((artifact) => artifact.type === "worker-metrics");
  if (metrics.length !== 1 || metrics[0]!.row_count !== 1
    || !WorkerMetricsContentSchema.safeParse(metrics[0]!.content).success) {
    context.addIssue({ code: "custom", path: ["artifacts"], message: "기술 신호 전략 worker-metrics artifact 계약이 올바르지 않습니다." });
    return;
  }
  const canonicalActual = actual.filter((artifact) => artifact.type !== "worker-metrics");
  const expectedTypes = new Set(expected.map((artifact) => artifact.type));
  if (expectedTypes.size !== expected.length
    || canonicalActual.length !== expected.length
    || new Set(canonicalActual.map((artifact) => artifact.type)).size !== canonicalActual.length
    || canonicalActual.some((artifact) => !expectedTypes.has(artifact.type as never))) {
    context.addIssue({ code: "custom", path: ["artifacts"], message: "기술 신호 전략 artifact type 집합이 canonical result와 일치하지 않습니다." });
    return;
  }
  for (const artifact of expected) {
    const matched = canonicalActual.find((candidate) => candidate.type === artifact.type);
    if (!matched || matched.row_count !== artifact.rowCount || !isDeepStrictEqual(matched.content, artifact.content)) {
      context.addIssue({ code: "custom", path: ["artifacts"], message: `${artifact.type} artifact가 canonical result와 일치하지 않습니다.` });
    }
  }
});

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
