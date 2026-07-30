import {
  normalizeAiSimulationRun,
  type AiSimulationRunResponse,
} from "@/lib/ai-simulation";

export const SIMULATION_RUN_FALLBACK_INITIAL_MS = 5_000;
export const SIMULATION_RUN_FALLBACK_MAX_MS = 30_000;

export type SimulationRunEventType =
  | "snapshot"
  | "progress"
  | "changed"
  | "terminal"
  | "heartbeat";

export type SimulationRunEventV1 = {
  schemaVersion: 1;
  runId: string;
  revision: number;
  emittedAt: string;
  type: SimulationRunEventType;
  payload: unknown;
};

const EVENT_TYPES = new Set<SimulationRunEventType>([
  "snapshot",
  "progress",
  "changed",
  "terminal",
  "heartbeat",
]);

const RUN_KEYS = new Set([
  "run",
  "runId",
  "run_id",
  "status",
  "error",
  "errorMessage",
  "error_message",
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function simulationRunEventsUrl(runId: string, lastEventId?: number): string {
  const endpoint = `/api/portfolio/simulation/runs/${encodeURIComponent(runId)}/events`;
  return Number.isSafeInteger(lastEventId) && (lastEventId as number) >= 0
    ? `${endpoint}?lastEventId=${lastEventId}`
    : endpoint;
}

export function parseSimulationRunEvent(value: unknown): SimulationRunEventV1 | undefined {
  const source = record(value);
  if (
    source?.schemaVersion !== 1
    || typeof source.runId !== "string"
    || source.runId.length === 0
    || !Number.isSafeInteger(source.revision)
    || (source.revision as number) < 1
    || typeof source.emittedAt !== "string"
    || !Number.isFinite(Date.parse(source.emittedAt))
    || !EVENT_TYPES.has(source.type as SimulationRunEventType)
  ) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    runId: source.runId,
    revision: source.revision as number,
    emittedAt: source.emittedAt,
    type: source.type as SimulationRunEventType,
    payload: source.payload,
  };
}

export function parseSimulationRunMessage(data: string): SimulationRunEventV1 | undefined {
  try {
    return parseSimulationRunEvent(JSON.parse(data));
  } catch {
    return undefined;
  }
}

export function isStaleSimulationRunRevision(
  event: Pick<SimulationRunEventV1, "runId" | "revision">,
  accepted: { runId?: string; revision: number },
): boolean {
  return event.runId === accepted.runId && event.revision <= accepted.revision;
}

export function nextSimulationRunFallbackDelay(
  currentDelayMs: number,
  succeeded: boolean,
): number {
  if (succeeded) return SIMULATION_RUN_FALLBACK_INITIAL_MS;
  return Math.min(
    SIMULATION_RUN_FALLBACK_MAX_MS,
    Math.max(SIMULATION_RUN_FALLBACK_INITIAL_MS, currentDelayMs) * 2,
  );
}

function mergePatch(base: unknown, patch: unknown): unknown {
  const baseRecord = record(base);
  const patchRecord = record(patch);
  if (!patchRecord) return patch;
  const merged: Record<string, unknown> = { ...(baseRecord ?? {}) };
  for (const [key, value] of Object.entries(patchRecord)) {
    merged[key] = mergePatch(baseRecord?.[key], value);
  }
  return merged;
}

/**
 * Reuses every unchanged object/array subtree. This keeps chart and panel props
 * referentially stable when a progress event only changes scalar state.
 */
export function structurallyShare<T>(previous: T, next: T): T {
  if (Object.is(previous, next)) return previous;
  if (Array.isArray(previous) && Array.isArray(next)) {
    if (previous.length !== next.length) return next;
    let changed = false;
    const shared = next.map((value, index) => {
      const item = structurallyShare(previous[index], value);
      changed ||= item !== previous[index];
      return item;
    });
    return (changed ? shared : previous) as T;
  }
  const previousRecord = record(previous);
  const nextRecord = record(next);
  if (previousRecord && nextRecord) {
    const previousKeys = Object.keys(previousRecord);
    const nextKeys = Object.keys(nextRecord);
    let changed = (
      previousKeys.length !== nextKeys.length
      || previousKeys.some((key) => !(key in nextRecord))
    );
    const shared: Record<string, unknown> = {};
    for (const key of nextKeys) {
      const value = structurallyShare(previousRecord[key], nextRecord[key]);
      shared[key] = value;
      changed ||= value !== previousRecord[key];
    }
    return (changed ? shared : previous) as T;
  }
  return next;
}

function eventPayloadPatch(
  current: AiSimulationRunResponse,
  payload: unknown,
): Record<string, unknown> {
  const source = record(payload);
  if (!source) return current;

  if ("snapshot" in source || "run" in source) {
    return mergePatch(current, source) as Record<string, unknown>;
  }

  const rootPatch: Record<string, unknown> = {};
  const snapshotPatch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    (RUN_KEYS.has(key) ? rootPatch : snapshotPatch)[key] = value;
  }
  return {
    ...current,
    ...rootPatch,
    snapshot: Object.keys(snapshotPatch).length
      ? mergePatch(current.snapshot, snapshotPatch)
      : current.snapshot,
  };
}

const LIGHTWEIGHT_METADATA_KEYS = new Set([
  "completedCandidates",
  "completed_candidates",
  "totalCandidates",
  "total_candidates",
  "currentValidationWindow",
  "current_validation_window",
  "dataRevision",
  "data_revision",
  "persistedAt",
  "persisted_at",
]);

function mergeLightweightEvent(
  current: AiSimulationRunResponse,
  event: SimulationRunEventV1,
): AiSimulationRunResponse | undefined {
  if (event.type !== "progress" && event.type !== "changed") return undefined;
  const source = record(event.payload);
  if (!source || "run" in source) return undefined;
  const wrappedSnapshot = record(source.snapshot);
  const snapshotSource = wrappedSnapshot ?? Object.fromEntries(
    Object.entries(source).filter(([key]) => !RUN_KEYS.has(key)),
  );
  const rootSource = wrappedSnapshot
    ? source
    : Object.fromEntries(Object.entries(source).filter(([key]) => RUN_KEYS.has(key)));
  if (
    Object.keys(snapshotSource).some((key) => ![
      "phase",
      "startedAt",
      "started_at",
      "expiresAt",
      "expires_at",
      "initialCash",
      "initial_cash",
      "cash",
      "equity",
      "progress",
      "riskTolerance",
      "risk_tolerance",
      "warnings",
    ].includes(key) && !LIGHTWEIGHT_METADATA_KEYS.has(key))
  ) {
    return undefined;
  }

  let snapshot = current.snapshot;
  let snapshotChanged = false;
  if (snapshot) {
    const changed: Partial<typeof snapshot> = {};
    const stringField = (
      target: "phase" | "startedAt" | "expiresAt",
      ...keys: string[]
    ) => {
      const value = keys.map((key) => snapshotSource[key])
        .find((candidate) => typeof candidate === "string");
      if (typeof value === "string" && value !== snapshot?.[target]) {
        changed[target] = value;
        snapshotChanged = true;
      }
    };
    const numberField = (
      target: "initialCash" | "cash" | "equity" | "progress" | "riskTolerance",
      ...keys: string[]
    ) => {
      const value = keys.map((key) => snapshotSource[key])
        .find((candidate) => typeof candidate === "number" && Number.isFinite(candidate));
      if (typeof value !== "number") return;
      const normalized = target === "progress" ? Math.max(0, Math.min(1, value)) : value;
      if (normalized !== snapshot?.[target]) {
        changed[target] = normalized;
        snapshotChanged = true;
      }
    };
    stringField("phase", "phase");
    stringField("startedAt", "startedAt", "started_at");
    stringField("expiresAt", "expiresAt", "expires_at");
    numberField("initialCash", "initialCash", "initial_cash");
    numberField("cash", "cash");
    numberField("equity", "equity");
    numberField("progress", "progress");
    numberField("riskTolerance", "riskTolerance", "risk_tolerance");
    if (Array.isArray(snapshotSource.warnings)) {
      const warnings = snapshotSource.warnings.filter(
        (warning): warning is string => typeof warning === "string",
      );
      const sharedWarnings = structurallyShare(snapshot.warnings, warnings);
      if (sharedWarnings !== snapshot.warnings) {
        changed.warnings = sharedWarnings;
        snapshotChanged = true;
      }
    }
    if (snapshotChanged) snapshot = { ...snapshot, ...changed };
  } else if (
    Object.keys(snapshotSource).some((key) => !LIGHTWEIGHT_METADATA_KEYS.has(key))
  ) {
    return undefined;
  }

  const status = typeof rootSource.status === "string"
    ? rootSource.status
    : current.status;
  if (!snapshotChanged && status === current.status) return current;
  return {
    ...current,
    status,
    snapshot,
  };
}

export function mergeSimulationRunEvent(
  current: AiSimulationRunResponse | undefined,
  event: SimulationRunEventV1,
): AiSimulationRunResponse | undefined {
  if (event.type === "heartbeat") return current;
  const previous = current ?? { runId: event.runId, status: "queued" };
  const lightweight = current ? mergeLightweightEvent(current, event) : undefined;
  if (lightweight) return lightweight;
  const normalized = normalizeAiSimulationRun(eventPayloadPatch(previous, event.payload));
  const next = {
    ...normalized,
    runId: normalized.runId ?? previous.runId ?? event.runId,
  };
  return structurallyShare(previous, next);
}

export function mergeSimulationRunResponse(
  current: AiSimulationRunResponse | undefined,
  payload: unknown,
  runId: string,
): AiSimulationRunResponse {
  const next = normalizeAiSimulationRun(payload);
  const identified = {
    ...next,
    runId: next.runId ?? current?.runId ?? runId,
  };
  return current ? structurallyShare(current, identified) : identified;
}
