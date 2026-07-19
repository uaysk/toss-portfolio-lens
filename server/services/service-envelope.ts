import { createHash } from "node:crypto";

export const MCP_SCHEMA_VERSION = "1.1";
export const PORTFOLIO_ENGINE_VERSION = "portfolio-lens-rust-2026.07.3";
export const HISTORICAL_LIMITATION = "역사적 데이터에 기반한 분석·시뮬레이션이며 미래 성과를 보장하지 않습니다.";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

export function requestHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

export type ServiceEnvelope<T> = {
  schema_version: string;
  generated_at: string;
  engine_version: string;
  data_revision: string;
  request_hash: string;
  requested_period?: { from: string; to: string };
  effective_period?: { from: string; to: string };
  assumptions: string[];
  warnings: string[];
  data_quality: Record<string, unknown>;
  result: T;
};

export function envelope<T>(input: {
  request: unknown;
  dataRevision: string;
  result: T;
  requestedPeriod?: { from: string; to: string };
  effectivePeriod?: { from: string; to: string };
  assumptions?: string[];
  warnings?: string[];
  dataQuality?: Record<string, unknown>;
  generatedAt?: string;
}): ServiceEnvelope<T> {
  return {
    schema_version: MCP_SCHEMA_VERSION,
    generated_at: input.generatedAt ?? new Date().toISOString(),
    engine_version: PORTFOLIO_ENGINE_VERSION,
    data_revision: input.dataRevision,
    request_hash: requestHash(input.request),
    ...(input.requestedPeriod ? { requested_period: input.requestedPeriod } : {}),
    ...(input.effectivePeriod ? { effective_period: input.effectivePeriod } : {}),
    assumptions: input.assumptions ?? [],
    warnings: Array.from(new Set([...(input.warnings ?? []), HISTORICAL_LIMITATION])),
    data_quality: input.dataQuality ?? {},
    result: input.result,
  };
}

export type StructuredServiceError = {
  code: string;
  message: string;
  retryable: boolean;
  field?: string;
  details?: Record<string, unknown>;
};

export class ServiceError extends Error {
  constructor(readonly detail: StructuredServiceError) {
    super(detail.message);
    this.name = "ServiceError";
  }
}
