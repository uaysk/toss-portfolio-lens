import type { AdvancedRunSnapshot } from "@/types";

export type AdvancedAnalysisOperation =
  | "optimization"
  | "walk-forward"
  | "stress-test"
  | "sensitivity-weight"
  | "sensitivity-start-date"
  | "sensitivity-rebalance"
  | "sensitivity-cash-flow"
  | "monte-carlo"
  | "compare-backtests"
  | "diversifying-assets"
  | "market-regimes"
  | "return-contribution"
  | "pareto-frontier"
  | "redundant-assets"
  | "rebalance-plan";

type ApiFailure = { error?: { message?: string } };
type StartEnvelope = {
  warnings?: string[];
  result?: {
    run_id?: string;
    kind?: string;
    status?: AdvancedRunSnapshot["status"];
    progress?: number;
    completed_candidates?: number;
    total_candidates?: number;
    current_validation_window?: string;
    result?: unknown;
  } | unknown;
};

export type AdvancedAnalysisResult = {
  run?: AdvancedRunSnapshot;
  result: unknown;
  warnings: string[];
};

async function readArtifact(
  runId: string,
  type: string,
  signal?: AbortSignal,
  onUnauthorized?: () => void,
): Promise<unknown> {
  const payload = await checkedFetch(`/api/portfolio/advanced/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(type)}`, {
    headers: { Accept: "application/json" },
    signal,
  }, onUnauthorized);
  return payload.content;
}

export async function loadAdvancedArtifact(
  runId: string,
  type: string,
  onUnauthorized?: () => void,
  signal?: AbortSignal,
): Promise<unknown> {
  return readArtifact(runId, type, signal, onUnauthorized);
}

async function externalizedResult(
  run: AdvancedRunSnapshot,
  signal?: AbortSignal,
  onUnauthorized?: () => void,
): Promise<unknown> {
  const types = new Set((run.artifacts ?? []).map((artifact) => artifact.type));
  if (types.has("result")) {
    const result = await readArtifact(run.runId, "result", signal, onUnauthorized);
    const scenarioKinds = new Set(["stress_test", "weight_sensitivity", "start_date_sensitivity", "rebalance_sensitivity", "cash_flow_sensitivity"]);
    return scenarioKinds.has(run.kind) && Array.isArray(result) ? { scenarios: result } : result;
  }
  if (types.has("scenario-comparison")) return readArtifact(run.runId, "scenario-comparison", signal, onUnauthorized);
  const summary = run.summary && typeof run.summary === "object" ? run.summary as Record<string, unknown> : {};
  if (run.kind === "optimization") {
    return {
      best: summary.best,
      candidateCount: summary.candidate_count ?? 0,
      paretoCount: summary.pareto_count ?? 0,
      candidatesExternalized: types.has("candidates"),
      paretoFrontierExternalized: types.has("worker-pareto-frontier"),
    };
  }
  if (run.kind === "walk_forward" && types.has("walk-forward")) {
    return {
      summary,
      folds: [],
      foldsExternalized: true,
      foldsArtifact: (run.artifacts ?? []).find((artifact) => artifact.type === "walk-forward"),
    };
  }
  if (run.kind === "monte_carlo") {
    const distribution = types.has("monte-carlo-distribution")
      ? await readArtifact(run.runId, "monte-carlo-distribution", signal, onUnauthorized)
      : undefined;
    return {
      ...summary,
      distributions: summary.distributions ?? distribution,
      percentilePaths: [],
      percentilePathsExternalized: types.has("monte-carlo-percentile-paths"),
      percentilePathsArtifact: (run.artifacts ?? []).find((artifact) => artifact.type === "monte-carlo-percentile-paths"),
      samplePaths: [],
      samplePathsExternalized: types.has("monte-carlo-sample-paths"),
      samplePathsArtifact: (run.artifacts ?? []).find((artifact) => artifact.type === "monte-carlo-sample-paths"),
    };
  }
  throw new Error("대용량 분석 결과 artifact를 찾지 못했습니다.");
}

async function readJson(response: Response): Promise<Record<string, unknown> & ApiFailure> {
  return await response.json().catch(() => ({})) as Record<string, unknown> & ApiFailure;
}

async function checkedFetch(
  url: string,
  init: RequestInit,
  onUnauthorized?: () => void,
): Promise<Record<string, unknown> & ApiFailure> {
  const response = await fetch(url, init);
  const payload = await readJson(response);
  if (response.status === 401) {
    onUnauthorized?.();
    throw new Error("로그인이 만료되었습니다.");
  }
  if (!response.ok) throw new Error(payload.error?.message || "고급 분석 요청을 처리하지 못했습니다.");
  return payload;
}

export async function loadAdvancedMarketResource(
  uri: unknown,
  onUnauthorized?: () => void,
  signal?: AbortSignal,
): Promise<unknown> {
  const prefix = "market://series/";
  if (typeof uri !== "string" || !uri.startsWith(prefix)) throw new Error("시장 자료 URI가 올바르지 않습니다.");
  const requestHash = uri.slice(prefix.length);
  if (!/^[a-f0-9]{64}$/.test(requestHash)) throw new Error("시장 자료 식별자가 올바르지 않습니다.");
  const payload = await checkedFetch(`/api/portfolio/advanced/resources/market/${requestHash}`, {
    headers: { Accept: "application/json" },
    signal,
  }, onUnauthorized);
  return payload.data;
}

function initialRun(payload: StartEnvelope): AdvancedRunSnapshot | undefined {
  const value = payload.result;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const run = value as {
    run_id?: string;
    kind?: string;
    status?: AdvancedRunSnapshot["status"];
    progress?: number;
    completed_candidates?: number;
    total_candidates?: number;
    current_validation_window?: string;
    result?: unknown;
  };
  if (!run.run_id || !run.status) return undefined;
  return {
    runId: run.run_id,
    kind: run.kind ?? "advanced",
    status: run.status,
    progress: run.progress ?? 0,
    completedCandidates: run.completed_candidates ?? 0,
    totalCandidates: run.total_candidates ?? 0,
    ...(run.current_validation_window ? { currentValidationWindow: run.current_validation_window } : {}),
    ...(run.result !== undefined ? { result: run.result } : {}),
    warnings: payload.warnings ?? [],
  };
}

function errorMessage(value: unknown): string {
  if (value && typeof value === "object" && "message" in value && typeof value.message === "string") return value.message;
  return "고급 분석 실행이 완료되지 않았습니다.";
}

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", () => {
      window.clearTimeout(timer);
      reject(new DOMException("요청이 취소되었습니다.", "AbortError"));
    }, { once: true });
  });
}

export async function runAdvancedAnalysis(input: {
  operation: AdvancedAnalysisOperation;
  body: unknown;
  signal?: AbortSignal;
  onUnauthorized?: () => void;
  onProgress?: (run: AdvancedRunSnapshot) => void;
  pollIntervalMs?: number;
}): Promise<AdvancedAnalysisResult> {
  const started = await checkedFetch(`/api/portfolio/advanced/${input.operation}`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(input.body),
    signal: input.signal,
  }, input.onUnauthorized) as StartEnvelope;
  let run = initialRun(started);
  if (!run) {
    return { result: started.result, warnings: started.warnings ?? [] };
  }
  input.onProgress?.(run);
  while (["queued", "running", "cancel_requested"].includes(run.status)) {
    await wait(input.pollIntervalMs ?? 800, input.signal);
    run = await checkedFetch(`/api/portfolio/advanced/runs/${encodeURIComponent(run.runId)}`, {
      headers: { Accept: "application/json" },
      signal: input.signal,
    }, input.onUnauthorized) as unknown as AdvancedRunSnapshot;
    input.onProgress?.(run);
  }
  if (run.status !== "completed") throw new Error(errorMessage(run.error));
  const completed = await checkedFetch(`/api/portfolio/advanced/runs/${encodeURIComponent(run.runId)}/result`, {
    headers: { Accept: "application/json" },
    signal: input.signal,
  }, input.onUnauthorized) as unknown as AdvancedRunSnapshot;
  input.onProgress?.(completed);
  const result = completed.result !== undefined
    ? completed.result
    : completed.resultExternalized
      ? await externalizedResult(completed, input.signal, input.onUnauthorized)
      : undefined;
  return { run: completed, result, warnings: completed.warnings ?? [] };
}

export async function cancelAdvancedAnalysis(runId: string, onUnauthorized?: () => void): Promise<AdvancedRunSnapshot> {
  return await checkedFetch(`/api/portfolio/advanced/runs/${encodeURIComponent(runId)}/cancel`, {
    method: "POST",
    headers: { Accept: "application/json" },
  }, onUnauthorized) as unknown as AdvancedRunSnapshot;
}
