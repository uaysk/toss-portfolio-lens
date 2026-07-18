import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  Activity,
  Archive,
  ArchiveRestore,
  Ban,
  BookCopy,
  Download,
  FileClock,
  FileJson,
  FileText,
  History,
  LibraryBig,
  LoaderCircle,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Save,
  Search,
  Tags,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { LazyJsonDetails } from "@/components/lazy-json-details";
import { SavedResearchRunResults } from "@/components/portfolio-research-results";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  createLibraryPreset,
  deleteLibraryPreset,
  deleteLibraryRun,
  duplicateLibraryPreset,
  executeLibraryPreset,
  exportLibraryPreset,
  generateLibraryResearchReport,
  getLibraryRunEvents,
  getLibraryRunManifest,
  getLibraryPresetHistory,
  importLibraryPreset,
  listLibraryPresets,
  listLibraryRuns,
  normalizeTags,
  runLibraryAction,
  updateLibraryPreset,
  updateLibraryRun,
  type PresetLibraryItem,
  type RunLibraryFilters,
  type RunLibraryItem,
} from "@/lib/research-library";
import { cancelAdvancedAnalysis, loadAdvancedRunSnapshot } from "@/lib/advanced-analysis";
import { cn } from "@/lib/utils";
import type { AdvancedRunSnapshot, Portfolio, Theme } from "@/types";

type LibraryTab = "runs" | "presets";

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : "요청을 처리하지 못했습니다.";
}

function formatDate(value: string | number | undefined): string {
  if (value === undefined) return "-";
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return String(value);
  return parsed.toLocaleString("ko-KR", { dateStyle: "medium", timeStyle: "short" });
}

function csv(value: string): string[] {
  return Array.from(new Set(value.split(",").map((item) => item.trim()).filter(Boolean)));
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function numberValue(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function runStatusLabel(value: string): string {
  return ({
    queued: "대기",
    running: "실행 중",
    cancel_requested: "취소 요청",
    cancelled: "취소됨",
    completed: "완료",
    failed: "실패",
  } as Record<string, string>)[value] ?? value;
}

function StatusPill({ status }: { status: string }) {
  const active = ["queued", "running", "cancel_requested"].includes(status);
  return (
    <span className={cn(
      "inline-flex rounded-full px-2.5 py-1 text-[10px] font-black",
      status === "completed"
        ? "bg-foreground text-background"
        : active ? "bg-card text-foreground" : "bg-card text-muted-foreground",
    )}>{runStatusLabel(status)}</span>
  );
}

function EmptyPanel({ children }: { children: React.ReactNode }) {
  return <div className="rounded-[22px] bg-card px-5 py-10 text-center text-sm text-muted-foreground">{children}</div>;
}

function PresetLazyHistory({ presetId, onUnauthorized }: { presetId: string; onUnauthorized: () => void }) {
  const [history, setHistory] = useState<unknown>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const load = async () => {
    setLoading(true);
    setError("");
    try {
      setHistory((await getLibraryPresetHistory(presetId, { onUnauthorized })).history);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  };
  return (
    <details className="mt-3 rounded-2xl bg-card p-3">
      <summary className="cursor-pointer text-[10px] font-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">변경 이력</summary>
      {history === undefined ? <Button type="button" variant="secondary" size="sm" className="mt-3" onClick={() => void load()} disabled={loading}>{loading ? <LoaderCircle className="animate-spin" /> : <History />}이력 불러오기</Button> : <LazyJsonDetails value={history} className="mt-3 rounded-2xl bg-secondary p-3" />}
      {error ? <p role="alert" className="mt-2 text-xs text-rose-500">{error}</p> : null}
    </details>
  );
}

function RunLazyDetails({ runId, completed, onUnauthorized }: { runId: string; completed: boolean; onUnauthorized: () => void }) {
  const [events, setEvents] = useState<unknown>();
  const [manifest, setManifest] = useState<unknown>();
  const [report, setReport] = useState<unknown>();
  const [loading, setLoading] = useState<"events" | "manifest" | "report">();
  const [error, setError] = useState("");
  const [reportFormat, setReportFormat] = useState<"markdown" | "json">("markdown");
  const [reportTitle, setReportTitle] = useState("");

  const load = async (kind: "events" | "manifest") => {
    setLoading(kind);
    setError("");
    try {
      const loaded = kind === "events"
        ? await getLibraryRunEvents(runId, { onUnauthorized })
        : await getLibraryRunManifest(runId, { onUnauthorized });
      if (kind === "events") setEvents(loaded);
      else setManifest(loaded);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setLoading(undefined);
    }
  };

  const generateReport = async () => {
    setLoading("report");
    setError("");
    try {
      setReport(await generateLibraryResearchReport(runId, reportFormat, {
        onUnauthorized,
        title: reportTitle,
        executionMode: "async",
      }));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setLoading(undefined);
    }
  };

  return (
    <details className="rounded-2xl bg-secondary p-3">
      <summary className="cursor-pointer text-[11px] font-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        이벤트·재현 정보
      </summary>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button type="button" variant="secondary" size="sm" onClick={() => void load("events")} disabled={loading !== undefined}>
          {loading === "events" ? <LoaderCircle className="animate-spin" /> : <FileClock />}이벤트 불러오기
        </Button>
        <Button type="button" variant="secondary" size="sm" onClick={() => void load("manifest")} disabled={loading !== undefined}>
          {loading === "manifest" ? <LoaderCircle className="animate-spin" /> : <FileJson />}매니페스트 불러오기
        </Button>
        <Button type="button" variant="secondary" size="sm" onClick={() => void generateReport()} disabled={loading !== undefined || !completed}>
          {loading === "report" ? <LoaderCircle className="animate-spin" /> : <FileText />}연구 보고서 생성
        </Button>
      </div>
      <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_140px]"><Input aria-label="연구 보고서 제목" value={reportTitle} onChange={(event) => setReportTitle(event.target.value)} placeholder="보고서 제목 · 선택" className="bg-card" /><Select value={reportFormat} onValueChange={(value) => setReportFormat(value as "markdown" | "json")}><SelectTrigger aria-label="연구 보고서 형식" className="w-full bg-card"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="markdown">Markdown</SelectItem><SelectItem value="json">JSON</SelectItem></SelectContent></Select></div>
      {error ? <p role="alert" className="mt-3 text-xs font-bold text-rose-500">{error}</p> : null}
      {events !== undefined ? <LazyJsonDetails value={events} className="mt-3 rounded-2xl bg-card p-3" /> : null}
      {manifest !== undefined ? <LazyJsonDetails value={manifest} className="mt-3 rounded-2xl bg-card p-3" /> : null}
      {report !== undefined ? <LazyJsonDetails value={report} className="mt-3 rounded-2xl bg-card p-3" /> : null}
    </details>
  );
}

function RunLibrary({ theme, onUnauthorized }: { theme: Theme; onUnauthorized: () => void }) {
  const [draftFilters, setDraftFilters] = useState<RunLibraryFilters>({ archived: false, limit: 25 });
  const [filters, setFilters] = useState<RunLibraryFilters>({ archived: false, limit: 25 });
  const [runs, setRuns] = useState<RunLibraryItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [resultSnapshot, setResultSnapshot] = useState<AdvancedRunSnapshot>();
  const [editingId, setEditingId] = useState<string>();
  const [editName, setEditName] = useState("");
  const [editTags, setEditTags] = useState("");
  const [deletePendingId, setDeletePendingId] = useState<string>();
  const requestSequence = useRef(0);

  const load = useCallback(async (cursor?: string) => {
    const sequence = ++requestSequence.current;
    if (cursor) setLoadingMore(true);
    else setLoading(true);
    setError("");
    try {
      const page = await listLibraryRuns({ ...filters, ...(cursor ? { cursor } : {}) }, { onUnauthorized });
      if (sequence !== requestSequence.current) return;
      setRuns((current) => cursor
        ? [...current, ...page.items.filter((item) => !current.some((existing) => existing.id === item.id))]
        : page.items);
      setNextCursor(page.nextCursor);
    } catch (caught) {
      if (sequence === requestSequence.current) setError(errorMessage(caught));
    } finally {
      if (sequence === requestSequence.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [filters, onUnauthorized]);

  useEffect(() => {
    void load();
  }, [load]);

  const applyFilters = (event: FormEvent) => {
    event.preventDefault();
    setFilters({
      ...draftFilters,
      query: draftFilters.query?.trim(),
      tag: draftFilters.tag?.trim(),
      cursor: undefined,
    });
    setDeletePendingId(undefined);
  };

  const startEdit = (run: RunLibraryItem) => {
    setEditingId(run.id);
    setEditName(run.name ?? "");
    setEditTags(run.tags.join(", "));
    setDeletePendingId(undefined);
  };

  const saveEdit = async (run: RunLibraryItem) => {
    setBusy(`${run.id}:edit`);
    setError("");
    try {
      const patch = { name: editName.trim(), tags: normalizeTags(editTags) };
      const updated = await updateLibraryRun(run.id, patch, { onUnauthorized });
      setRuns((current) => current.map((item) => item.id === run.id ? updated ?? { ...item, ...patch } : item));
      setEditingId(undefined);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy("");
    }
  };

  const toggleArchived = async (run: RunLibraryItem) => {
    setBusy(`${run.id}:archive`);
    setError("");
    try {
      const updated = await updateLibraryRun(run.id, { archived: !run.archived }, { onUnauthorized });
      if (filters.archived === run.archived) setRuns((current) => current.filter((item) => item.id !== run.id));
      else setRuns((current) => current.map((item) => item.id === run.id ? updated ?? { ...item, archived: !item.archived } : item));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy("");
    }
  };

  const remove = async (run: RunLibraryItem) => {
    if (deletePendingId !== run.id) {
      setDeletePendingId(run.id);
      return;
    }
    setBusy(`${run.id}:delete`);
    setError("");
    try {
      await deleteLibraryRun(run.id, { onUnauthorized });
      setRuns((current) => current.filter((item) => item.id !== run.id));
      setDeletePendingId(undefined);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy("");
    }
  };

  const action = async (run: RunLibraryItem, operation: "duplicate" | "rerun") => {
    setBusy(`${run.id}:${operation}`);
    setError("");
    try {
      const created = await runLibraryAction(run.id, operation, { onUnauthorized });
      if (created) setRuns((current) => [created, ...current.filter((item) => item.id !== created.id)]);
      else await load();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy("");
    }
  };

  const cancel = async (run: RunLibraryItem) => {
    setBusy(`${run.id}:cancel`);
    setError("");
    try {
      const cancelled = await cancelAdvancedAnalysis(run.id, onUnauthorized);
      setRuns((current) => current.map((item) => item.id === run.id
        ? { ...item, status: cancelled.status, progress: cancelled.progress }
        : item));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy("");
    }
  };

  const saveRunPreset = async (run: RunLibraryItem) => {
    setBusy(`${run.id}:preset`);
    setError("");
    setNotice("");
    try {
      const preset = await createLibraryPreset({
        name: `${run.name || `${run.kind} ${run.id.slice(0, 8)}`} 프리셋`,
        description: `저장된 ${run.kind} run에서 생성`,
        tags: Array.from(new Set([...run.tags, "run"])),
        source: { type: "run", runId: run.id },
      }, { onUnauthorized });
      setNotice(preset ? `“${preset.name}” 프리셋을 저장했습니다.` : "run 프리셋을 저장했습니다.");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy("");
    }
  };

  const openRunResult = async (run: RunLibraryItem) => {
    setBusy(`${run.id}:result`);
    setError("");
    try {
      setResultSnapshot(await loadAdvancedRunSnapshot(run.id, onUnauthorized));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy("");
    }
  };

  return (
    <div id="library-runs-panel" role="tabpanel" aria-labelledby="library-runs-tab" className="space-y-3">
      <Card className="bg-secondary p-4 sm:p-5">
        <form onSubmit={applyFilters} className="grid gap-2 md:grid-cols-2 xl:grid-cols-[minmax(180px,1fr)_170px_170px_150px_minmax(140px,.7fr)_auto]">
          <label className="relative min-w-0">
            <span className="sr-only">실행 검색</span>
            <Search className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={draftFilters.query ?? ""} onChange={(event) => setDraftFilters((current) => ({ ...current, query: event.target.value }))} placeholder="이름 또는 run ID 검색" className="bg-card pl-11" />
          </label>
          <Select value={draftFilters.kind || "all"} onValueChange={(value) => setDraftFilters((current) => ({ ...current, kind: value === "all" ? undefined : value }))}>
            <SelectTrigger aria-label="실행 유형 필터" className="w-full bg-card"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="all">모든 유형</SelectItem>{["backtest", "optimization", "walk_forward", "stress_test", "weight_sensitivity", "start_date_sensitivity", "rebalance_sensitivity", "cash_flow_sensitivity", "monte_carlo", "outlook", "exposure_analysis", "pareto_frontier", "research_report"].map((kind) => <SelectItem key={kind} value={kind}>{kind}</SelectItem>)}</SelectContent>
          </Select>
          <Select value={draftFilters.status || "all"} onValueChange={(value) => setDraftFilters((current) => ({ ...current, status: value === "all" ? undefined : value }))}>
            <SelectTrigger aria-label="실행 상태 필터" className="w-full bg-card"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="all">모든 상태</SelectItem>{["queued", "running", "cancel_requested", "completed", "failed", "cancelled"].map((status) => <SelectItem key={status} value={status}>{runStatusLabel(status)}</SelectItem>)}</SelectContent>
          </Select>
          <Select value={draftFilters.archived === undefined ? "all" : String(draftFilters.archived)} onValueChange={(value) => setDraftFilters((current) => ({ ...current, archived: value === "all" ? undefined : value === "true" }))}>
            <SelectTrigger aria-label="실행 보관 필터" className="w-full bg-card"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="false">활성 실행</SelectItem><SelectItem value="true">보관됨</SelectItem><SelectItem value="all">전체</SelectItem></SelectContent>
          </Select>
          <label><span className="sr-only">실행 태그 필터</span><Input value={draftFilters.tag ?? ""} onChange={(event) => setDraftFilters((current) => ({ ...current, tag: event.target.value }))} placeholder="태그" className="bg-card" /></label>
          <Button type="submit"><Search />검색</Button>
        </form>
      </Card>

      {error ? <p role="alert" className="rounded-[18px] bg-primary px-4 py-3 text-sm font-bold text-primary-foreground">{error}</p> : null}
      {notice ? <p role="status" className="rounded-[18px] bg-card px-4 py-3 text-sm font-bold">{notice}</p> : null}
      {loading ? <EmptyPanel><LoaderCircle className="mx-auto mb-3 animate-spin" />실행 기록을 불러오는 중입니다.</EmptyPanel> : !runs.length ? <EmptyPanel>조건에 맞는 실행 기록이 없습니다.</EmptyPanel> : (
        <Card className="min-w-0 bg-secondary p-3 sm:p-4">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1080px] text-left text-xs">
              <thead><tr className="text-muted-foreground"><th className="p-3">실행</th><th className="p-3">유형·상태</th><th className="p-3">태그</th><th className="p-3">업데이트</th><th className="p-3">관리</th></tr></thead>
              <tbody>{runs.map((run) => (
                <tr key={run.id} className="border-t border-border align-top">
                  <td className="p-3">
                    {editingId === run.id ? (
                      <div className="w-[310px] space-y-2">
                        <Input aria-label={`${run.id} 실행 이름`} value={editName} onChange={(event) => setEditName(event.target.value)} placeholder="실행 이름" className="h-10 bg-card" />
                        <Input aria-label={`${run.id} 실행 태그`} value={editTags} onChange={(event) => setEditTags(event.target.value)} placeholder="태그 · 쉼표 구분" className="h-10 bg-card" />
                        <div className="flex gap-2"><Button size="sm" onClick={() => void saveEdit(run)} disabled={busy === `${run.id}:edit`}><Save />저장</Button><Button size="sm" variant="ghost" onClick={() => setEditingId(undefined)}><X />취소</Button></div>
                      </div>
                    ) : (
                      <div className="max-w-[320px]"><p className="font-black">{run.name || `${run.kind} 실행`}</p><p className="mt-1 break-all text-[9px] text-muted-foreground">{run.id}</p>{run.summary !== undefined ? <LazyJsonDetails value={run.summary} className="mt-2" /> : null}</div>
                    )}
                  </td>
                  <td className="p-3"><p className="font-bold">{run.kind}</p><div className="mt-2"><StatusPill status={run.status} /></div>{run.archived ? <p className="mt-2 text-[9px] font-black text-muted-foreground">ARCHIVED</p> : null}</td>
                  <td className="p-3"><div className="flex max-w-[220px] flex-wrap gap-1">{run.tags.length ? run.tags.map((tag) => <span key={tag} className="rounded-full bg-card px-2 py-1 text-[9px] font-bold">{tag}</span>) : <span className="text-muted-foreground">-</span>}</div></td>
                  <td className="p-3 text-muted-foreground"><p>{formatDate(run.updatedAt ?? run.finishedAt ?? run.createdAt)}</p>{run.progress !== undefined && run.progress < 1 ? <p className="mt-1 font-bold">{Math.round(run.progress * 100)}%</p> : null}</td>
                  <td className="p-3">
                    <div className="flex max-w-[360px] flex-wrap gap-1.5">
                      <Button size="sm" variant="secondary" onClick={() => startEdit(run)} disabled={Boolean(busy)}><Pencil />수정</Button>
                      <Button size="sm" variant="secondary" onClick={() => void action(run, "duplicate")} disabled={Boolean(busy)}><BookCopy />복제</Button>
                      <Button size="sm" variant="secondary" onClick={() => void action(run, "rerun")} disabled={Boolean(busy)}><Play />재실행</Button>
                      {["queued", "running", "cancel_requested"].includes(run.status) ? <Button size="sm" variant="secondary" onClick={() => void cancel(run)} disabled={Boolean(busy) || run.status === "cancel_requested"}>{busy === `${run.id}:cancel` ? <LoaderCircle className="animate-spin" /> : <Ban />}취소</Button> : null}
                      <Button size="sm" variant="secondary" onClick={() => void openRunResult(run)} disabled={Boolean(busy) || run.status !== "completed"}>{busy === `${run.id}:result` ? <LoaderCircle className="animate-spin" /> : <Activity />}검증 결과</Button>
                      <Button size="sm" variant="secondary" onClick={() => void saveRunPreset(run)} disabled={Boolean(busy) || run.status !== "completed"}><Save />프리셋 저장</Button>
                      <Button size="sm" variant="secondary" onClick={() => void toggleArchived(run)} disabled={Boolean(busy)}>{run.archived ? <ArchiveRestore /> : <Archive />}{run.archived ? "복원" : "보관"}</Button>
                      {deletePendingId === run.id ? <Button size="sm" variant="default" onClick={() => void remove(run)} disabled={Boolean(busy)}><Trash2 />정말 삭제</Button> : <Button size="sm" variant="ghost" onClick={() => void remove(run)} disabled={Boolean(busy)}><Trash2 />삭제</Button>}
                      {deletePendingId === run.id ? <Button size="sm" variant="ghost" onClick={() => setDeletePendingId(undefined)}><X />취소</Button> : null}
                    </div>
                    <div className="mt-2"><RunLazyDetails runId={run.id} completed={run.status === "completed"} onUnauthorized={onUnauthorized} /></div>
                  </td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </Card>
      )}
      {resultSnapshot ? <Card className="min-w-0 bg-secondary p-4 sm:p-6"><div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"><div><p className="text-xs font-black tracking-[0.12em] text-muted-foreground">PERSISTED RUN RESULT</p><h3 className="mt-2 text-xl font-black">{resultSnapshot.kind} 검증 결과</h3><p className="mt-1 break-all text-[9px] text-muted-foreground">{resultSnapshot.runId}</p></div><Button type="button" variant="ghost" size="sm" onClick={() => setResultSnapshot(undefined)}><X />닫기</Button></div><SavedResearchRunResults snapshot={resultSnapshot} theme={theme} onUnauthorized={onUnauthorized} /></Card> : null}
      <div className="flex flex-wrap justify-between gap-2">
        <Button type="button" variant="secondary" onClick={() => void load()} disabled={loading || loadingMore}><RefreshCw className={cn((loading || loadingMore) && "animate-spin")} />새로고침</Button>
        {nextCursor ? <Button type="button" variant="secondary" onClick={() => void load(nextCursor)} disabled={loadingMore}>{loadingMore ? <LoaderCircle className="animate-spin" /> : <Plus />}더 보기</Button> : null}
      </div>
    </div>
  );
}

type PresetDraft = {
  name: string;
  description: string;
  tags: string;
  symbols: string;
  weights: string;
  cashWeightPercent: string;
  benchmark: string;
  startDate: string;
  endDate: string;
  rebalanceFrequency: string;
  transactionCostBps: string;
  optimizationConstraints: string;
};

const emptyPresetDraft: PresetDraft = {
  name: "",
  description: "",
  tags: "",
  symbols: "",
  weights: "",
  cashWeightPercent: "0",
  benchmark: "",
  startDate: "",
  endDate: "",
  rebalanceFrequency: "none",
  transactionCostBps: "0",
  optimizationConstraints: "{}",
};

function draftFromPreset(preset: PresetLibraryItem): PresetDraft {
  const config = preset.config;
  const weights = record(config.defaultWeights);
  const period = record(config.period);
  const optimization = config.optimizationConstraints ?? {};
  return {
    name: preset.name,
    description: preset.description ?? "",
    tags: preset.tags.join(", "),
    symbols: preset.symbols.join(", "),
    weights: preset.symbols.map((symbol) => numberValue(weights[symbol]) * 100).join(", "),
    cashWeightPercent: String(numberValue(config.cashWeight) * 100),
    benchmark: typeof config.benchmark === "string" ? config.benchmark : "",
    startDate: typeof period.startDate === "string" ? period.startDate : "",
    endDate: typeof period.endDate === "string" ? period.endDate : "",
    rebalanceFrequency: typeof config.rebalanceFrequency === "string" ? config.rebalanceFrequency : "none",
    transactionCostBps: String(numberValue(config.transactionCostBps)),
    optimizationConstraints: JSON.stringify(optimization, null, 2),
  };
}

function presetPayload(draft: PresetDraft, includeSource: boolean): Record<string, unknown> {
  const symbols = csv(draft.symbols).map((symbol) => symbol.toUpperCase());
  const weightValues = csv(draft.weights).map(Number);
  const defaultWeights = Object.fromEntries(symbols.map((symbol, index) => [symbol, Number.isFinite(weightValues[index]) ? weightValues[index] / 100 : 0]));
  const optimizationConstraints = JSON.parse(draft.optimizationConstraints || "{}") as unknown;
  return {
    name: draft.name.trim(),
    description: draft.description.trim(),
    tags: normalizeTags(draft.tags),
    ...(includeSource ? { source: { type: "manual" } } : {}),
    symbols,
    config: {
      symbols,
      defaultWeights,
      cashWeight: numberValue(draft.cashWeightPercent) / 100,
      ...(draft.benchmark.trim() ? { benchmark: draft.benchmark.trim().toUpperCase() } : {}),
      ...(draft.startDate || draft.endDate ? { period: { ...(draft.startDate ? { startDate: draft.startDate } : {}), ...(draft.endDate ? { endDate: draft.endDate } : {}) } } : {}),
      rebalanceFrequency: draft.rebalanceFrequency,
      transactionCostBps: numberValue(draft.transactionCostBps),
      optimizationConstraints,
    },
  };
}

function PresetEditor({ draft, editing, busy, onChange, onCancel, onSubmit }: {
  draft: PresetDraft;
  editing: boolean;
  busy: boolean;
  onChange: (value: PresetDraft) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const update = (patch: Partial<PresetDraft>) => onChange({ ...draft, ...patch });
  return (
    <Card className="bg-secondary p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs font-black tracking-[0.12em] text-muted-foreground">{editing ? "EDIT PRESET" : "NEW PRESET"}</p><h3 className="mt-2 text-xl font-black">{editing ? "프리셋 수정" : "종목 구성 프리셋 만들기"}</h3></div>{editing ? <Button variant="ghost" size="sm" onClick={onCancel}><X />수정 취소</Button> : null}</div>
      <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <label className="rounded-[18px] bg-card p-4"><span className="mb-2 block text-[11px] font-bold text-muted-foreground">이름</span><Input value={draft.name} onChange={(event) => update({ name: event.target.value })} maxLength={120} className="bg-secondary" /></label>
        <label className="rounded-[18px] bg-card p-4 md:col-span-2"><span className="mb-2 block text-[11px] font-bold text-muted-foreground">설명</span><Input value={draft.description} onChange={(event) => update({ description: event.target.value })} maxLength={500} className="bg-secondary" /></label>
        <label className="rounded-[18px] bg-card p-4"><span className="mb-2 block text-[11px] font-bold text-muted-foreground">태그 · 쉼표 구분</span><Input value={draft.tags} onChange={(event) => update({ tags: event.target.value })} className="bg-secondary" /></label>
        <label className="rounded-[18px] bg-card p-4 md:col-span-2"><span className="mb-2 block text-[11px] font-bold text-muted-foreground">종목 · 쉼표 구분</span><Input value={draft.symbols} onChange={(event) => update({ symbols: event.target.value.toUpperCase() })} placeholder="SPY, QQQ, GLD" className="bg-secondary" /></label>
        <label className="rounded-[18px] bg-card p-4 md:col-span-2"><span className="mb-2 block text-[11px] font-bold text-muted-foreground">기본 비중 % · 종목 순서</span><Input value={draft.weights} onChange={(event) => update({ weights: event.target.value })} placeholder="50, 30, 20" className="bg-secondary" /></label>
        <label className="rounded-[18px] bg-card p-4"><span className="mb-2 block text-[11px] font-bold text-muted-foreground">현금 비중 %</span><Input type="number" min={0} max={100} value={draft.cashWeightPercent} onChange={(event) => update({ cashWeightPercent: event.target.value })} className="bg-secondary text-right" /></label>
        <label className="rounded-[18px] bg-card p-4"><span className="mb-2 block text-[11px] font-bold text-muted-foreground">벤치마크</span><Input value={draft.benchmark} onChange={(event) => update({ benchmark: event.target.value.toUpperCase() })} placeholder="SPY" className="bg-secondary" /></label>
        <label className="rounded-[18px] bg-card p-4"><span className="mb-2 block text-[11px] font-bold text-muted-foreground">시작일</span><Input type="date" value={draft.startDate} onChange={(event) => update({ startDate: event.target.value })} className="bg-secondary" /></label>
        <label className="rounded-[18px] bg-card p-4"><span className="mb-2 block text-[11px] font-bold text-muted-foreground">종료일</span><Input type="date" value={draft.endDate} onChange={(event) => update({ endDate: event.target.value })} className="bg-secondary" /></label>
        <label className="rounded-[18px] bg-card p-4"><span className="mb-2 block text-[11px] font-bold text-muted-foreground">리밸런싱</span><Select value={draft.rebalanceFrequency} onValueChange={(value) => update({ rebalanceFrequency: value })}><SelectTrigger className="w-full bg-secondary"><SelectValue /></SelectTrigger><SelectContent>{["none", "monthly", "quarterly", "annually", "threshold"].map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent></Select></label>
        <label className="rounded-[18px] bg-card p-4"><span className="mb-2 block text-[11px] font-bold text-muted-foreground">거래비용 bp</span><Input type="number" min={0} max={500} value={draft.transactionCostBps} onChange={(event) => update({ transactionCostBps: event.target.value })} className="bg-secondary text-right" /></label>
        <label className="rounded-[18px] bg-card p-4 md:col-span-2 xl:col-span-4"><span className="mb-2 block text-[11px] font-bold text-muted-foreground">최적화 제약 · JSON</span><textarea value={draft.optimizationConstraints} onChange={(event) => update({ optimizationConstraints: event.target.value })} rows={4} className="w-full rounded-2xl bg-secondary px-4 py-3 font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" /></label>
      </div>
      <Button className="mt-4" onClick={onSubmit} disabled={busy || !draft.name.trim() || !csv(draft.symbols).length}>{busy ? <LoaderCircle className="animate-spin" /> : <Save />}{editing ? "변경 저장" : "프리셋 생성"}</Button>
    </Card>
  );
}

function currentPortfolioPresetPayload(portfolio: Portfolio, name: string): Record<string, unknown> {
  return {
    name: name.trim(),
    description: `${portfolio.account.label}의 ${portfolio.asOf} 조회 스냅샷`,
    tags: ["current-portfolio"],
    source: {
      type: "current_portfolio",
      accountId: portfolio.selectedAccountId,
      accountLabel: portfolio.account.label,
      asOf: portfolio.asOf,
      holdings: portfolio.holdings.map((holding) => ({
        symbol: holding.symbol,
        name: holding.name,
        market: holding.market,
        currency: holding.currency,
        quantity: holding.quantity,
        evaluationAmount: holding.evaluationAmount,
      })),
      summary: portfolio.summary,
    },
    symbols: portfolio.holdings.map((holding) => holding.symbol),
  };
}

function downloadJson(value: unknown, filename: string): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function PresetLibrary({ portfolio, onUnauthorized }: { portfolio: Portfolio; onUnauthorized: () => void }) {
  const [presets, setPresets] = useState<PresetLibraryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [executionResult, setExecutionResult] = useState<unknown>();
  const [query, setQuery] = useState("");
  const [editingId, setEditingId] = useState<string>();
  const [draft, setDraft] = useState<PresetDraft>(emptyPresetDraft);
  const [currentName, setCurrentName] = useState(`현재 포트폴리오 · ${portfolio.account.label}`);
  const [deletePendingId, setDeletePendingId] = useState<string>();
  const [importText, setImportText] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setPresets((await listLibraryPresets({ onUnauthorized })).items);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  }, [onUnauthorized]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { setCurrentName(`현재 포트폴리오 · ${portfolio.account.label}`); }, [portfolio.account.label]);

  const visible = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("ko-KR");
    if (!normalized) return presets;
    return presets.filter((preset) => [preset.name, preset.description ?? "", ...preset.tags, ...preset.symbols].some((value) => value.toLocaleLowerCase("ko-KR").includes(normalized)));
  }, [presets, query]);

  const submitDraft = async () => {
    setBusy(editingId ? `${editingId}:edit` : "create");
    setError("");
    try {
      const payload = presetPayload(draft, !editingId);
      const editingPreset = editingId ? presets.find((preset) => preset.id === editingId) : undefined;
      const saved = editingId
        ? await updateLibraryPreset(editingId, { ...payload, revision: editingPreset?.version ?? 1 }, { onUnauthorized })
        : await createLibraryPreset(payload, { onUnauthorized });
      if (saved) setPresets((current) => [saved, ...current.filter((item) => item.id !== saved.id)]);
      else await load();
      setEditingId(undefined);
      setDraft(emptyPresetDraft);
    } catch (caught) {
      setError(caught instanceof SyntaxError ? "최적화 제약 JSON 형식을 확인해 주세요." : errorMessage(caught));
    } finally {
      setBusy("");
    }
  };

  const saveCurrent = async () => {
    setBusy("current");
    setError("");
    try {
      const saved = await createLibraryPreset(currentPortfolioPresetPayload(portfolio, currentName), { onUnauthorized });
      if (saved) setPresets((current) => [saved, ...current.filter((item) => item.id !== saved.id)]);
      else await load();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy("");
    }
  };

  const duplicate = async (preset: PresetLibraryItem) => {
    setBusy(`${preset.id}:duplicate`);
    setError("");
    try {
      const created = await duplicateLibraryPreset(preset.id, { onUnauthorized });
      if (created) setPresets((current) => [created, ...current.filter((item) => item.id !== created.id)]);
      else await load();
    } catch (caught) { setError(errorMessage(caught)); }
    finally { setBusy(""); }
  };

  const remove = async (preset: PresetLibraryItem) => {
    if (deletePendingId !== preset.id) {
      setDeletePendingId(preset.id);
      return;
    }
    setBusy(`${preset.id}:delete`);
    setError("");
    try {
      await deleteLibraryPreset(preset.id, { onUnauthorized });
      setPresets((current) => current.filter((item) => item.id !== preset.id));
      setDeletePendingId(undefined);
    } catch (caught) { setError(errorMessage(caught)); }
    finally { setBusy(""); }
  };

  const exportPreset = async (preset: PresetLibraryItem) => {
    setBusy(`${preset.id}:export`);
    setError("");
    try {
      downloadJson(await exportLibraryPreset(preset.id, { onUnauthorized }), `portfolio-preset-${preset.id}.json`);
    } catch (caught) { setError(errorMessage(caught)); }
    finally { setBusy(""); }
  };

  const importPreset = async () => {
    setBusy("import");
    setError("");
    try {
      const saved = await importLibraryPreset(JSON.parse(importText), { onUnauthorized });
      if (saved) setPresets((current) => [saved, ...current.filter((item) => item.id !== saved.id)]);
      else await load();
      setImportText("");
    } catch (caught) {
      setError(caught instanceof SyntaxError ? "가져올 JSON 형식을 확인해 주세요." : errorMessage(caught));
    } finally {
      setBusy("");
    }
  };

  const executePreset = async (preset: PresetLibraryItem, tool: "run_portfolio_backtest" | "optimize_portfolio" | "walk_forward_optimize") => {
    setBusy(`${preset.id}:${tool}`);
    setError("");
    try {
      const executed = await executeLibraryPreset(preset.id, tool, { onUnauthorized });
      setExecutionResult(executed);
      setNotice(`“${preset.name}” 프리셋 실행을 접수했습니다.`);
      await load();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy("");
    }
  };

  return (
    <div id="library-presets-panel" role="tabpanel" aria-labelledby="library-presets-tab" className="space-y-3">
      <PresetEditor draft={draft} editing={Boolean(editingId)} busy={busy === "create" || busy === `${editingId}:edit`} onChange={setDraft} onCancel={() => { setEditingId(undefined); setDraft(emptyPresetDraft); }} onSubmit={() => void submitDraft()} />

      <div className="grid gap-3 xl:grid-cols-2">
        <Card className="bg-secondary p-5">
          <p className="text-xs font-black tracking-[0.12em] text-muted-foreground">CURRENT PORTFOLIO</p><h3 className="mt-2 text-lg font-black">현재 구성을 스냅샷으로 저장</h3>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">{portfolio.asOf} 기준 {portfolio.holdings.length}종목의 통화·수량·평가금과 계좌 요약을 immutable source로 저장합니다.</p>
          <div className="mt-4 flex flex-col gap-2 sm:flex-row"><label className="min-w-0 flex-1"><span className="sr-only">현재 포트폴리오 프리셋 이름</span><Input value={currentName} onChange={(event) => setCurrentName(event.target.value)} className="bg-card" /></label><Button onClick={() => void saveCurrent()} disabled={busy === "current" || !currentName.trim()}>{busy === "current" ? <LoaderCircle className="animate-spin" /> : <Save />}현재 포트폴리오 저장</Button></div>
        </Card>
        <Card className="bg-secondary p-5">
          <p className="text-xs font-black tracking-[0.12em] text-muted-foreground">IMPORT JSON</p><h3 className="mt-2 text-lg font-black">프리셋 가져오기</h3>
          <label className="mt-4 block"><span className="sr-only">가져올 프리셋 JSON</span><textarea value={importText} onChange={(event) => setImportText(event.target.value)} rows={3} placeholder="내보낸 JSON을 붙여넣으세요." className="w-full rounded-2xl bg-card px-4 py-3 font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" /></label>
          <div className="mt-2 flex flex-wrap gap-2"><label className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-full bg-card px-4 text-xs font-semibold focus-within:ring-2 focus-within:ring-ring"><Upload className="size-4" />파일 선택<input type="file" accept="application/json,.json" className="sr-only" onChange={(event) => { const file = event.target.files?.[0]; if (file) void file.text().then(setImportText).catch(() => setError("파일을 읽지 못했습니다.")); }} /></label><Button size="sm" onClick={() => void importPreset()} disabled={busy === "import" || !importText.trim()}>{busy === "import" ? <LoaderCircle className="animate-spin" /> : <Upload />}가져오기</Button></div>
        </Card>
      </div>

      <Card className="bg-secondary p-4 sm:p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div><p className="text-xs font-black tracking-[0.12em] text-muted-foreground">PRESET LIBRARY</p><h3 className="mt-2 text-xl font-black">저장된 프리셋</h3></div><div className="flex gap-2"><label className="relative min-w-0"><span className="sr-only">프리셋 검색</span><Search className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="이름·태그·종목 검색" className="bg-card pl-11" /></label><Button variant="secondary" size="icon" onClick={() => void load()} aria-label="프리셋 새로고침"><RefreshCw className={cn(loading && "animate-spin")} /></Button></div></div>
      </Card>
      {error ? <p role="alert" className="rounded-[18px] bg-primary px-4 py-3 text-sm font-bold text-primary-foreground">{error}</p> : null}
      {notice ? <p role="status" className="rounded-[18px] bg-card px-4 py-3 text-sm font-bold">{notice}</p> : null}
      {executionResult !== undefined ? <LazyJsonDetails value={executionResult} className="rounded-[18px] bg-secondary p-4" /> : null}
      {loading ? <EmptyPanel><LoaderCircle className="mx-auto mb-3 animate-spin" />프리셋을 불러오는 중입니다.</EmptyPanel> : !visible.length ? <EmptyPanel>저장된 프리셋이 없습니다.</EmptyPanel> : (
        <div className="grid gap-3 xl:grid-cols-2">
          {visible.map((preset) => (
            <Card key={preset.id} className="min-w-0 bg-secondary p-5">
              <div className="flex items-start justify-between gap-3"><div className="min-w-0"><h4 className="truncate text-lg font-black">{preset.name}</h4><p className="mt-1 break-all text-[9px] text-muted-foreground">{preset.id}</p></div><span className="shrink-0 rounded-full bg-card px-2.5 py-1 text-[9px] font-black">v{preset.version ?? 1}</span></div>
              {preset.description ? <p className="mt-3 text-xs leading-5 text-muted-foreground">{preset.description}</p> : null}
              <div className="mt-3 flex flex-wrap gap-1.5">{preset.symbols.map((symbol) => <span key={symbol} className="rounded-full bg-card px-2.5 py-1 text-[10px] font-black">{symbol}</span>)}</div>
              <div className="mt-3 flex flex-wrap gap-2 text-[10px] text-muted-foreground"><span className="inline-flex items-center gap-1"><History className="size-3" />변경 {preset.historyCount ?? 0}회</span><span>마지막 사용 {formatDate(preset.lastUsedAt)}</span><span>수정 {formatDate(preset.updatedAt)}</span></div>
              {preset.tags.length ? <div className="mt-3 flex flex-wrap gap-1">{preset.tags.map((tag) => <span key={tag} className="inline-flex items-center gap-1 rounded-full bg-card px-2 py-1 text-[9px] font-bold"><Tags className="size-2.5" />{tag}</span>)}</div> : null}
              <LazyJsonDetails value={{ source: preset.source, config: preset.config }} className="mt-4 rounded-2xl bg-card p-3" />
              <PresetLazyHistory presetId={preset.id} onUnauthorized={onUnauthorized} />
              <div className="mt-4 flex flex-wrap gap-1.5">
                <Button size="sm" onClick={() => void executePreset(preset, "run_portfolio_backtest")} disabled={Boolean(busy)}><Play />백테스트</Button>
                <Button size="sm" variant="secondary" onClick={() => void executePreset(preset, "optimize_portfolio")} disabled={Boolean(busy)}><Activity />최적화</Button>
                <Button size="sm" variant="secondary" onClick={() => void executePreset(preset, "walk_forward_optimize")} disabled={Boolean(busy)}><Play />Walk-forward</Button>
                <Button size="sm" variant="secondary" onClick={() => { setEditingId(preset.id); setDraft(draftFromPreset(preset)); window.scrollTo({ top: 0, behavior: "smooth" }); }} disabled={Boolean(busy)}><Pencil />수정</Button>
                <Button size="sm" variant="secondary" onClick={() => void duplicate(preset)} disabled={Boolean(busy)}><BookCopy />복제</Button>
                <Button size="sm" variant="secondary" onClick={() => void exportPreset(preset)} disabled={Boolean(busy)}><Download />내보내기</Button>
                {deletePendingId === preset.id ? <Button size="sm" onClick={() => void remove(preset)} disabled={Boolean(busy)}><Trash2 />정말 삭제</Button> : <Button size="sm" variant="ghost" onClick={() => void remove(preset)} disabled={Boolean(busy)}><Trash2 />삭제</Button>}
                {deletePendingId === preset.id ? <Button size="sm" variant="ghost" onClick={() => setDeletePendingId(undefined)}><X />취소</Button> : null}
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

export function ResearchLibrary({ portfolio, theme, onUnauthorized }: { portfolio: Portfolio; theme: Theme; onUnauthorized: () => void }) {
  const [tab, setTab] = useState<LibraryTab>("runs");
  const tabs: LibraryTab[] = ["runs", "presets"];
  const selectAdjacentTab = (direction: 1 | -1) => {
    const next = tabs[(tabs.indexOf(tab) + direction + tabs.length) % tabs.length];
    setTab(next);
    window.requestAnimationFrame(() => document.getElementById(`library-${next}-tab`)?.focus());
  };
  return (
    <section aria-labelledby="research-library-title" className="space-y-3">
      <Card className="bg-secondary p-5 sm:p-7">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div><p className="flex items-center gap-2 text-xs font-black tracking-[0.14em] text-muted-foreground"><LibraryBig className="size-4" />RESEARCH LIBRARY</p><h2 id="research-library-title" className="mt-2 text-2xl font-black tracking-[-0.04em]">실행 기록과 프리셋</h2><p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">재현 가능한 분석 실행과 종목 구성을 영구 저장하고 다시 사용할 수 있습니다. 모든 기능은 조회·분석·역사적 시뮬레이션 전용입니다.</p></div>
        </div>
        <div role="tablist" aria-label="실행 기록과 프리셋 선택" onKeyDown={(event) => { if (event.key === "ArrowRight") { event.preventDefault(); selectAdjacentTab(1); } else if (event.key === "ArrowLeft") { event.preventDefault(); selectAdjacentTab(-1); } }} className="mt-5 flex max-w-full gap-1 overflow-x-auto rounded-[20px] bg-card p-1">
          {([{ value: "runs" as const, label: "실행 기록", icon: FileClock }, { value: "presets" as const, label: "프리셋", icon: LibraryBig }]).map((item) => <button key={item.value} id={`library-${item.value}-tab`} type="button" role="tab" aria-selected={tab === item.value} aria-controls={`library-${item.value}-panel`} tabIndex={tab === item.value ? 0 : -1} onClick={() => setTab(item.value)} className={cn("inline-flex min-w-fit items-center justify-center gap-2 rounded-full px-5 py-2.5 text-xs font-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", tab === item.value ? "bg-foreground text-background" : "text-muted-foreground")}><item.icon className="size-4" />{item.label}</button>)}
        </div>
      </Card>
      {tab === "runs" ? <RunLibrary theme={theme} onUnauthorized={onUnauthorized} /> : <PresetLibrary portfolio={portfolio} onUnauthorized={onUnauthorized} />}
    </section>
  );
}
