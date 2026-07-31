import { envelope, ServiceError } from "../../services/service-envelope.js";

export type GenericInput = Record<string, unknown>;

export function object(input: unknown): GenericInput {
  return input as GenericInput;
}

export function recordValue(value: unknown): GenericInput | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as GenericInput
    : undefined;
}

export function serviceNotFound(entity: "run" | "preset", id: string): ServiceError {
  return new ServiceError({
    code: entity === "run" ? "RUN_NOT_FOUND" : "PRESET_NOT_FOUND",
    message: entity === "run" ? "run을 찾을 수 없습니다." : "preset을 찾을 수 없습니다.",
    retryable: false,
    details: { id },
  });
}

export function runResultEnvelope(run: {
  id: string;
  kind: string;
  status: string;
  progress: number;
  completedCandidates: number;
  totalCandidates: number;
  currentValidationWindow?: string;
  dataRevision: string;
  warnings: string[];
  input: unknown;
  summary?: unknown;
  result?: unknown;
  error?: unknown;
}, request: unknown, artifactIndex: unknown[] = [], includeStoredResult = true) {
  return envelope({
    request,
    dataRevision: run.dataRevision,
    warnings: run.warnings,
    dataQuality: {},
    result: {
      run_id: run.id,
      kind: run.kind,
      status: run.status,
      progress: run.progress,
      completed_candidates: run.completedCandidates,
      total_candidates: run.totalCandidates,
      current_validation_window: run.currentValidationWindow,
      summary: run.summary,
      ...(includeStoredResult ? { result: run.result } : {}),
      error: run.error,
      artifact_index: artifactIndex,
    },
  });
}
