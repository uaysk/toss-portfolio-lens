export type RunLibraryItem = {
  id: string;
  kind: string;
  status: string;
  name?: string;
  tags: string[];
  archived: boolean;
  progress?: number;
  createdAt?: string | number;
  updatedAt?: string | number;
  finishedAt?: string | number;
  summary?: unknown;
};

export type PresetLibraryItem = {
  id: string;
  name: string;
  description?: string;
  tags: string[];
  symbols: string[];
  source?: unknown;
  config: Record<string, unknown>;
  version?: number;
  historyCount?: number;
  lastUsedAt?: string | number;
  createdAt?: string | number;
  updatedAt?: string | number;
};

export type PresetLibraryDetails = {
  preset?: PresetLibraryItem;
  history: unknown[];
};

export type LibraryPage<T> = {
  items: T[];
  nextCursor?: string;
};

export type RunLibraryFilters = {
  query?: string;
  kind?: string;
  status?: string;
  archived?: boolean;
  tag?: string;
  cursor?: string;
  limit?: number;
};

export type LibraryRequestOptions = {
  fetcher?: typeof fetch;
  onUnauthorized?: () => void;
};

export type SpecializedPresetPresentation = {
  label: string;
  restoreHint: string;
};

const specializedPresetPresentations: Record<string, SpecializedPresetPresentation> = {
  technical_watchlist: {
    label: "기술적 분석 종목 목록",
    restoreHint: "기술적 분석 화면에서 복원",
  },
  technical_chart_config: {
    label: "기술적 분석 차트 구성",
    restoreHint: "기술적 분석 화면에서 복원",
  },
  technical_signal_strategy: {
    label: "기술 신호 전략",
    restoreHint: "기술적 분석/백테스트 화면에서 복원",
  },
};

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {};
}

function entityRecord(value: unknown, keys: string[]): UnknownRecord {
  const outer = record(value);
  const nested = keys.map((key) => outer[key]).find((candidate) => (
    candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)
  ));
  return nested === undefined ? outer : record(nested);
}

function stringValue(...values: unknown[]): string | undefined {
  const value = values.find((candidate) => typeof candidate === "string" && candidate.trim());
  return typeof value === "string" ? value : undefined;
}

function numberValue(...values: unknown[]): number | undefined {
  const value = values.find((candidate) => typeof candidate === "number" && Number.isFinite(candidate));
  return typeof value === "number" ? value : undefined;
}

function dateValue(...values: unknown[]): string | number | undefined {
  return values.find((candidate) => (
    (typeof candidate === "string" && candidate.length > 0)
    || (typeof candidate === "number" && Number.isFinite(candidate))
  )) as string | number | undefined;
}

export function normalizeTags(value: unknown): string[] {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string" ? value.split(",") : [];
  return Array.from(new Set(values
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)));
}

export function unwrapLibraryResult(value: unknown): unknown {
  const outer = record(value);
  return Object.hasOwn(outer, "result") ? outer.result : value;
}

export function normalizeRun(value: unknown): RunLibraryItem | undefined {
  const item = entityRecord(value, ["run", "item"]);
  const id = stringValue(item.id, item.runId, item.run_id);
  if (!id) return undefined;
  return {
    id,
    kind: stringValue(item.kind, item.runKind, item.run_kind) ?? "unknown",
    status: stringValue(item.status) ?? "unknown",
    ...(stringValue(item.name, item.title) ? { name: stringValue(item.name, item.title) } : {}),
    tags: normalizeTags(item.tags),
    archived: Boolean(item.archived ?? item.isArchived ?? item.is_archived ?? item.archivedAt ?? item.archived_at),
    ...(numberValue(item.progress) !== undefined ? { progress: numberValue(item.progress) } : {}),
    ...(dateValue(item.createdAt, item.created_at) !== undefined ? { createdAt: dateValue(item.createdAt, item.created_at) } : {}),
    ...(dateValue(item.updatedAt, item.updated_at) !== undefined ? { updatedAt: dateValue(item.updatedAt, item.updated_at) } : {}),
    ...(dateValue(item.finishedAt, item.finished_at) !== undefined ? { finishedAt: dateValue(item.finishedAt, item.finished_at) } : {}),
    ...(item.summary !== undefined ? { summary: item.summary } : {}),
  };
}

export function normalizePreset(value: unknown): PresetLibraryItem | undefined {
  const item = entityRecord(value, ["preset", "item"]);
  const id = stringValue(item.id, item.presetId, item.preset_id);
  const name = stringValue(item.name, item.title);
  if (!id || !name) return undefined;
  const config = record(item.config);
  const rawSymbols = Array.isArray(item.symbols)
    ? item.symbols
    : Array.isArray(config.symbols) ? config.symbols : [];
  const history = Array.isArray(item.history) ? item.history : undefined;
  const version = numberValue(item.version, item.revision);
  const historyCount = numberValue(item.historyCount, item.history_count, item.revisionCount, item.revision_count);
  return {
    id,
    name,
    ...(stringValue(item.description) ? { description: stringValue(item.description) } : {}),
    tags: normalizeTags(item.tags),
    symbols: Array.from(new Set(rawSymbols
      .filter((symbol): symbol is string => typeof symbol === "string")
      .map((symbol) => symbol.trim().toUpperCase())
      .filter(Boolean))),
    ...(item.source !== undefined ? { source: item.source } : {}),
    config,
    ...(version !== undefined ? { version } : {}),
    ...(historyCount !== undefined
      ? { historyCount }
      : history ? { historyCount: history.length }
        : version !== undefined ? { historyCount: Math.max(0, version - 1) } : {}),
    ...(dateValue(item.lastUsedAt, item.last_used_at) !== undefined ? { lastUsedAt: dateValue(item.lastUsedAt, item.last_used_at) } : {}),
    ...(dateValue(item.createdAt, item.created_at) !== undefined ? { createdAt: dateValue(item.createdAt, item.created_at) } : {}),
    ...(dateValue(item.updatedAt, item.updated_at) !== undefined ? { updatedAt: dateValue(item.updatedAt, item.updated_at) } : {}),
  };
}

function normalizePage<T>(
  payload: unknown,
  itemKeys: string[],
  normalize: (value: unknown) => T | undefined,
): LibraryPage<T> {
  const unwrapped = unwrapLibraryResult(payload);
  const container = record(unwrapped);
  const source = Array.isArray(unwrapped)
    ? unwrapped
    : itemKeys.map((key) => container[key]).find(Array.isArray) ?? [];
  const nextCursor = stringValue(container.nextCursor, container.next_cursor, container.cursor);
  return {
    items: source.map(normalize).filter((item): item is T => item !== undefined),
    ...(nextCursor ? { nextCursor } : {}),
  };
}

export function normalizeRunPage(payload: unknown): LibraryPage<RunLibraryItem> {
  return normalizePage(payload, ["items", "runs"], normalizeRun);
}

export function normalizePresetPage(payload: unknown): LibraryPage<PresetLibraryItem> {
  return normalizePage(payload, ["items", "presets"], normalizePreset);
}

export function normalizePresetDetails(payload: unknown): PresetLibraryDetails {
  const container = record(unwrapLibraryResult(payload));
  return {
    preset: normalizePreset(container.preset ?? container),
    history: Array.isArray(container.history) ? container.history : [],
  };
}

/**
 * Specialized technical presets are restored by their owning screen. The generic
 * library editor/executors do not understand their versioned nested contracts and
 * must not silently coerce them into an allocation preset.
 */
export function specializedPresetPresentation(
  preset: Pick<PresetLibraryItem, "config">,
): SpecializedPresetPresentation | undefined {
  const presetType = stringValue(preset.config.presetType, preset.config.preset_type);
  return presetType ? specializedPresetPresentations[presetType] : undefined;
}

export function buildRunLibraryUrl(filters: RunLibraryFilters = {}): string {
  const params = new URLSearchParams();
  if (filters.query?.trim()) params.set("query", filters.query.trim());
  if (filters.kind?.trim()) params.set("kind", filters.kind.trim());
  if (filters.status?.trim()) params.set("status", filters.status.trim());
  if (filters.archived !== undefined) params.set("archived", String(filters.archived));
  if (filters.tag?.trim()) params.set("tag", filters.tag.trim());
  if (filters.cursor?.trim()) params.set("cursor", filters.cursor.trim());
  params.set("limit", String(Math.max(1, Math.min(100, Math.floor(filters.limit ?? 25)))));
  return `/api/portfolio/runs?${params.toString()}`;
}

export class ResearchLibraryApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ResearchLibraryApiError";
  }
}

async function requestJson(
  url: string,
  init: RequestInit,
  options: LibraryRequestOptions = {},
): Promise<unknown> {
  const fetcher = options.fetcher ?? fetch;
  const response = await fetcher(url, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });
  const payload = response.status === 204 ? undefined : await response.json().catch(() => ({}));
  if (response.status === 401) options.onUnauthorized?.();
  if (!response.ok) {
    const error = record(record(payload).error);
    throw new ResearchLibraryApiError(stringValue(error.message) ?? "실행·프리셋 요청을 처리하지 못했습니다.", response.status);
  }
  return payload;
}

function encoded(id: string): string {
  return encodeURIComponent(id);
}

export async function listLibraryRuns(filters: RunLibraryFilters = {}, options?: LibraryRequestOptions): Promise<LibraryPage<RunLibraryItem>> {
  return normalizeRunPage(await requestJson(buildRunLibraryUrl(filters), { method: "GET" }, options));
}

export async function updateLibraryRun(id: string, patch: { name?: string; tags?: string[]; archived?: boolean }, options?: LibraryRequestOptions): Promise<RunLibraryItem | undefined> {
  return normalizeRun(unwrapLibraryResult(await requestJson(`/api/portfolio/runs/${encoded(id)}`, { method: "PATCH", body: JSON.stringify(patch) }, options)));
}

export async function deleteLibraryRun(id: string, options?: LibraryRequestOptions): Promise<void> {
  await requestJson(`/api/portfolio/runs/${encoded(id)}`, { method: "DELETE" }, options);
}

export async function runLibraryAction(id: string, action: "duplicate" | "rerun", options?: LibraryRequestOptions): Promise<RunLibraryItem | undefined> {
  return normalizeRun(unwrapLibraryResult(await requestJson(`/api/portfolio/runs/${encoded(id)}/${action}`, { method: "POST" }, options)));
}

export async function getLibraryRunEvents(id: string, options?: LibraryRequestOptions): Promise<unknown> {
  return unwrapLibraryResult(await requestJson(`/api/portfolio/runs/${encoded(id)}/events`, { method: "GET" }, options));
}

export async function getLibraryRunManifest(id: string, options?: LibraryRequestOptions): Promise<unknown> {
  return unwrapLibraryResult(await requestJson(`/api/portfolio/runs/${encoded(id)}/manifest`, { method: "GET" }, options));
}

export async function generateLibraryResearchReport(
  id: string,
  format: "json" | "markdown" = "markdown",
  options?: LibraryRequestOptions & {
    title?: string;
    executionMode?: "sync" | "async";
    pollIntervalMs?: number;
    signal?: AbortSignal;
    onProgress?: (run: UnknownRecord) => void;
  },
): Promise<unknown> {
  const executionMode = options?.executionMode ?? "sync";
  const started = unwrapLibraryResult(await requestJson("/api/portfolio/tools/generate_research_report", {
    method: "POST",
    signal: options?.signal,
    body: JSON.stringify({
      runId: id,
      format,
      ...(options?.title?.trim() ? { title: options.title.trim() } : {}),
      ...(executionMode === "async" ? { executionMode } : {}),
    }),
  }, options));
  if (executionMode !== "async") return started;
  const initial = record(started);
  const runId = stringValue(initial.run_id, initial.runId);
  if (!runId) return started;
  let status = stringValue(initial.status) ?? "queued";
  options?.onProgress?.(initial);
  while (["queued", "running", "cancel_requested"].includes(status)) {
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        globalThis.clearTimeout(timer);
        reject(new DOMException("요청이 취소되었습니다.", "AbortError"));
      };
      const timer = globalThis.setTimeout(() => {
        options?.signal?.removeEventListener("abort", onAbort);
        resolve();
      }, options?.pollIntervalMs ?? 500);
      if (options?.signal?.aborted) {
        onAbort();
        return;
      }
      options?.signal?.addEventListener("abort", onAbort, { once: true });
    });
    const snapshot = record(await requestJson(`/api/portfolio/advanced/runs/${encoded(runId)}`, {
      method: "GET",
      signal: options?.signal,
    }, options));
    status = stringValue(snapshot.status) ?? "failed";
    options?.onProgress?.(snapshot);
  }
  if (status !== "completed") throw new ResearchLibraryApiError("연구 보고서 파생 run이 완료되지 않았습니다.", 422);
  const completed = record(await requestJson(`/api/portfolio/advanced/runs/${encoded(runId)}/result`, {
    method: "GET",
    signal: options?.signal,
  }, options));
  options?.onProgress?.(completed);
  if (completed.resultExternalized === true) {
    const stored = record(await requestJson(`/api/portfolio/advanced/runs/${encoded(runId)}/artifacts/research-report`, {
      method: "GET",
      signal: options?.signal,
    }, options));
    return stored.content ?? stored;
  }
  return completed.result ?? completed;
}

export async function listLibraryPresets(options?: LibraryRequestOptions): Promise<LibraryPage<PresetLibraryItem>> {
  return normalizePresetPage(await requestJson("/api/portfolio/presets", { method: "GET" }, options));
}

export async function getLibraryPreset(id: string, includeHistory = false, options?: LibraryRequestOptions): Promise<PresetLibraryDetails> {
  return normalizePresetDetails(await requestJson(`/api/portfolio/presets/${encoded(id)}${includeHistory ? "?includeHistory=true" : ""}`, { method: "GET" }, options));
}

export async function getLibraryPresetHistory(id: string, options?: LibraryRequestOptions): Promise<PresetLibraryDetails> {
  return normalizePresetDetails(await requestJson(`/api/portfolio/presets/${encoded(id)}/history`, { method: "GET" }, options));
}

export async function createLibraryPreset(input: unknown, options?: LibraryRequestOptions): Promise<PresetLibraryItem | undefined> {
  return normalizePreset(unwrapLibraryResult(await requestJson("/api/portfolio/presets", { method: "POST", body: JSON.stringify(input) }, options)));
}

export async function updateLibraryPreset(id: string, patch: unknown, options?: LibraryRequestOptions): Promise<PresetLibraryItem | undefined> {
  return normalizePreset(unwrapLibraryResult(await requestJson(`/api/portfolio/presets/${encoded(id)}`, { method: "PATCH", body: JSON.stringify(patch) }, options)));
}

export async function deleteLibraryPreset(id: string, options?: LibraryRequestOptions): Promise<void> {
  await requestJson(`/api/portfolio/presets/${encoded(id)}`, { method: "DELETE" }, options);
}

export async function duplicateLibraryPreset(id: string, options?: LibraryRequestOptions): Promise<PresetLibraryItem | undefined> {
  return normalizePreset(unwrapLibraryResult(await requestJson(`/api/portfolio/presets/${encoded(id)}/duplicate`, { method: "POST" }, options)));
}

export async function exportLibraryPreset(id: string, options?: LibraryRequestOptions): Promise<unknown> {
  return unwrapLibraryResult(await requestJson(`/api/portfolio/presets/${encoded(id)}/export`, { method: "GET" }, options));
}

export async function importLibraryPreset(input: unknown, options?: LibraryRequestOptions): Promise<PresetLibraryItem | undefined> {
  return normalizePreset(unwrapLibraryResult(await requestJson("/api/portfolio/presets/import", {
    method: "POST",
    body: JSON.stringify({ document: input, conflictMode: "rename" }),
  }, options)));
}

export async function executeLibraryPreset(
  id: string,
  tool: "run_portfolio_backtest" | "optimize_portfolio" | "walk_forward_optimize",
  options?: LibraryRequestOptions,
): Promise<unknown> {
  return unwrapLibraryResult(await requestJson(`/api/portfolio/tools/${tool}`, {
    method: "POST",
    body: JSON.stringify({ presetId: id }),
  }, options));
}
