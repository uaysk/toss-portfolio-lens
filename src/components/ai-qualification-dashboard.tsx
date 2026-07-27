import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  Check,
  CircleAlert,
  Clock3,
  Cpu,
  FileText,
  Gauge,
  LoaderCircle,
  MemoryStick,
  Radio,
  ServerCog,
  Thermometer,
  TimerReset,
  X,
} from "lucide-react";
import {
  isQualificationPayload,
  isTerminalQualificationStatus,
  type QualificationEvent,
  type QualificationPayload,
  type QualificationRunStatus,
  type QualificationState,
  type QualificationStep,
  type QualificationStepStatus,
} from "@/lib/ai-qualification";
import { cn } from "@/lib/utils";

type ConnectionState = "connecting" | "live" | "polling" | "terminal";

const runStatusLabel: Record<QualificationRunStatus, string> = {
  planned: "대기",
  running: "실행 중",
  completed: "완료",
  completed_with_failures: "일부 실패",
  failed: "실패",
  cancelled: "중단",
  budget_exhausted: "예산 소진",
};

const stepStatusLabel: Record<QualificationStepStatus, string> = {
  pending: "대기",
  running: "처리 중",
  completed: "완료",
  failed: "실패",
  skipped: "건너뜀",
  cancelled: "중단",
};

function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (hours) return `${hours}시간 ${String(minutes).padStart(2, "0")}분`;
  if (minutes) return `${minutes}분 ${String(seconds).padStart(2, "0")}초`;
  return `${seconds}초`;
}

function formatMoment(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(parsed);
}

function statusTone(status: QualificationRunStatus | QualificationStepStatus): string {
  if (status === "running") return "bg-emerald-400/15 text-emerald-300";
  if (status === "completed") return "bg-white text-black";
  if (status === "failed" || status === "cancelled") return "bg-rose-400/15 text-rose-300";
  if (status === "budget_exhausted" || status === "completed_with_failures") {
    return "bg-amber-300/15 text-amber-200";
  }
  return "bg-white/[0.07] text-white/45";
}

function StepStatusIcon({ status }: { status: QualificationStepStatus }) {
  if (status === "running") return <LoaderCircle className="size-4 animate-spin text-emerald-300" />;
  if (status === "completed") return <Check className="size-4 text-white" />;
  if (status === "failed" || status === "cancelled") return <X className="size-4 text-rose-300" />;
  if (status === "skipped") return <CircleAlert className="size-4 text-amber-200" />;
  return <span className="size-2 rounded-full bg-white/20" />;
}

function Metric({
  icon: Icon,
  label,
  value,
  detail,
  accent,
}: {
  icon: typeof Gauge;
  label: string;
  value: string;
  detail: string;
  accent?: "green" | "amber";
}) {
  return (
    <div className="rounded-[24px] bg-white/[0.045] p-5">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-white/45">{label}</p>
        <Icon className={cn(
          "size-4",
          accent === "green" ? "text-emerald-300" : accent === "amber" ? "text-amber-200" : "text-white/45",
        )} />
      </div>
      <p className="mt-5 text-2xl font-black tracking-[-0.04em] text-white">{value}</p>
      <p className="mt-1 text-xs text-white/35">{detail}</p>
    </div>
  );
}

function LaneSummary({
  title,
  subtitle,
  steps,
}: {
  title: string;
  subtitle: string;
  steps: QualificationStep[];
}) {
  const complete = steps.filter((step) => step.status === "completed").length;
  const failed = steps.filter((step) => step.status === "failed").length;
  const running = steps.find((step) => step.status === "running");
  const state = failed ? "failed" : running ? "running" : complete === steps.length ? "completed" : "pending";
  return (
    <div className="rounded-[26px] bg-white/[0.045] p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-base font-black tracking-[-0.025em] text-white">{title}</p>
          <p className="mt-1 text-xs text-white/40">{subtitle}</p>
        </div>
        <span className={cn("rounded-full px-2.5 py-1 text-[10px] font-black", statusTone(state))}>
          {stepStatusLabel[state]}
        </span>
      </div>
      <div className="mt-6 flex items-end justify-between">
        <div>
          <p className="text-3xl font-black tracking-[-0.05em] text-white">{complete}</p>
          <p className="mt-1 text-[11px] text-white/35">완료 / {steps.length}</p>
        </div>
        <div className="h-1.5 w-28 overflow-hidden rounded-full bg-white/10">
          <div
            className={cn("h-full rounded-full", failed ? "bg-rose-300" : "bg-white")}
            style={{ width: `${steps.length ? complete / steps.length * 100 : 0}%` }}
          />
        </div>
      </div>
    </div>
  );
}

function EmptyState({
  loading,
  error,
  onRetry,
}: {
  loading: boolean;
  error?: string;
  onRetry: () => void;
}) {
  return (
    <section className="grid min-h-[560px] place-items-center rounded-[32px] bg-[#090909] px-6 text-white">
      <div className="max-w-md text-center">
        <div className="mx-auto grid size-14 place-items-center rounded-[20px] bg-white/[0.07]">
          {loading
            ? <LoaderCircle className="size-5 animate-spin" />
            : <ServerCog className="size-5 text-white/60" />}
        </div>
        <h2 className="mt-6 text-xl font-black tracking-[-0.035em]">
          {loading ? "검증 실행을 찾는 중입니다." : "아직 모니터링할 실행이 없습니다."}
        </h2>
        <p className="mt-3 text-sm leading-6 text-white/45">
          {error || "자동 검증 스크립트를 실행하면 이 화면에 1초 단위로 상태가 표시됩니다."}
        </p>
        {!loading ? (
          <button
            type="button"
            onClick={onRetry}
            className="mt-6 rounded-full bg-white px-4 py-2.5 text-xs font-black text-black transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
          >
            다시 확인
          </button>
        ) : null}
      </div>
    </section>
  );
}

export function AiQualificationRunView({
  state,
  events,
  connection,
}: {
  state: QualificationState;
  events: QualificationEvent[];
  connection: ConnectionState;
}) {
  const activeStep = state.steps.find((step) => step.id === state.activeStepId);
  const kronosSteps = state.steps.filter((step) => (
    step.id.startsWith("replay-base") || step.id.startsWith("replay-cache")
  ));
  const fincastSteps = state.steps.filter((step) => step.id.startsWith("fincast-batch"));
  const orderedEvents = [...events].sort((left, right) => right.sequence - left.sequence).slice(0, 80);
  const memoryPercent = state.telemetry
    ? state.telemetry.memoryUsedMiB / state.telemetry.memoryTotalMiB * 100
    : 0;

  return (
    <section className="overflow-hidden rounded-[32px] bg-[#090909] text-white shadow-2xl shadow-black/15">
      <div className="px-5 py-6 sm:px-7 lg:px-9 lg:py-8">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span className={cn("rounded-full px-3 py-1.5 text-[11px] font-black", statusTone(state.status))}>
                {runStatusLabel[state.status]}
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-full bg-white/[0.06] px-3 py-1.5 text-[11px] font-bold text-white/45">
                <Radio className={cn("size-3", connection === "live" && "text-emerald-300")} />
                {connection === "live"
                  ? "SSE LIVE · 1초"
                  : connection === "polling"
                    ? "1초 폴링"
                    : connection === "terminal"
                      ? "실행 종료"
                      : "연결 중"}
              </span>
            </div>
            <h2 className="mt-5 text-[clamp(1.65rem,4vw,2.8rem)] font-black tracking-[-0.055em]">
              모델 검증 진행 상황
            </h2>
            <p className="mt-2 font-mono text-xs text-white/35">{state.runId}</p>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:min-w-[460px]">
            <div className="rounded-[18px] bg-white/[0.045] px-4 py-3">
              <p className="text-[10px] font-bold text-white/35">GPU</p>
              <p className="mt-1 text-xs font-black">Tesla P40</p>
            </div>
            <div className="rounded-[18px] bg-white/[0.045] px-4 py-3">
              <p className="text-[10px] font-bold text-white/35">입력 범위</p>
              <p className="mt-1 text-xs font-black">{state.config.durationHours}시간</p>
            </div>
            <div className="rounded-[18px] bg-white/[0.045] px-4 py-3">
              <p className="text-[10px] font-bold text-white/35">심볼</p>
              <p className="mt-1 truncate text-xs font-black">{state.config.symbols.join(" · ")}</p>
            </div>
            <div className="rounded-[18px] bg-white/[0.045] px-4 py-3">
              <p className="text-[10px] font-bold text-white/35">BUILD</p>
              <p className="mt-1 text-xs font-black">SKIPPED</p>
            </div>
          </div>
        </div>

        <div className="mt-9">
          <div className="flex items-end justify-between gap-4">
            <div>
              <p className="text-5xl font-black tracking-[-0.07em] sm:text-6xl">
                {state.progress.percent.toFixed(1)}
                <span className="ml-1 text-xl text-white/35">%</span>
              </p>
              <p className="mt-2 text-xs text-white/40">
                {activeStep ? `${activeStep.label} · 단계 ${state.progress.activeStepPercent?.toFixed(0) ?? 0}%` : "활성 단계 없음"}
              </p>
            </div>
            <p className="pb-1 text-right text-xs text-white/40">
              {state.progress.completedSteps} / {state.progress.totalSteps} 완료
              {state.progress.failedSteps ? ` · ${state.progress.failedSteps} 실패` : ""}
            </p>
          </div>
          <div
            className="mt-5 h-3 overflow-hidden rounded-full bg-white/[0.08]"
            role="progressbar"
            aria-valuenow={state.progress.percent}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="전체 검증 진행률"
          >
            <div
              className={cn(
                "h-full rounded-full transition-[width] duration-700",
                state.status === "failed" || state.status === "cancelled"
                  ? "bg-rose-300"
                  : state.status === "budget_exhausted"
                    ? "bg-amber-200"
                    : "bg-white",
              )}
              style={{ width: `${state.progress.percent}%` }}
            />
          </div>
        </div>

        <div className="mt-5 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          <Metric
            icon={Clock3}
            label="경과 시간"
            value={formatDuration(state.progress.elapsedMs)}
            detail={`총 ${state.config.budgetHours}시간 예산`}
          />
          <Metric
            icon={TimerReset}
            label="남은 예산"
            value={formatDuration(state.progress.remainingBudgetMs)}
            detail={`마감 ${formatMoment(state.deadlineAt)}`}
            accent={state.progress.remainingBudgetMs < 30 * 60_000 ? "amber" : undefined}
          />
          <Metric
            icon={Gauge}
            label="GPU 사용률"
            value={state.telemetry ? `${state.telemetry.gpuUtilizationPercent.toFixed(0)}%` : "—"}
            detail={state.telemetry ? `온도 ${state.telemetry.temperatureC.toFixed(0)}°C` : "telemetry 대기 중"}
            accent={state.telemetry?.gpuUtilizationPercent ? "green" : undefined}
          />
          <Metric
            icon={MemoryStick}
            label="VRAM"
            value={state.telemetry
              ? `${(state.telemetry.memoryUsedMiB / 1_024).toFixed(1)} GB`
              : "—"}
            detail={state.telemetry
              ? `${memoryPercent.toFixed(0)}% · 총 ${(state.telemetry.memoryTotalMiB / 1_024).toFixed(0)} GB`
              : "telemetry 대기 중"}
            accent={memoryPercent > 90 ? "amber" : undefined}
          />
        </div>

        <div className="mt-2 grid gap-2 lg:grid-cols-2">
          <LaneSummary
            title="Kronos-Base"
            subtitle="base vs kv-cache-v1 · 48시간 BTC/ETH"
            steps={kronosSteps}
          />
          <LaneSummary
            title="FinCast"
            subtitle="microbatch 4 / 8 / 16 · 출력 안정성"
            steps={fincastSteps}
          />
        </div>

        <div className="mt-2 grid gap-2 xl:grid-cols-[minmax(0,1.25fr)_minmax(320px,.75fr)]">
          <div className="rounded-[26px] bg-white/[0.045] p-4 sm:p-5">
            <div className="flex items-center justify-between px-1">
              <div className="flex items-center gap-2">
                <Activity className="size-4 text-white/55" />
                <h3 className="text-sm font-black">실행 단계</h3>
              </div>
              <span className="text-[10px] font-bold text-white/30">순차 자동 실행</span>
            </div>
            <div className="mt-4 space-y-1.5">
              {state.steps.map((step) => (
                <div
                  key={step.id}
                  className={cn(
                    "grid gap-3 rounded-[18px] px-3.5 py-3.5 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center",
                    step.status === "running" ? "bg-white/[0.075]" : "bg-black/20",
                  )}
                >
                  <div className="grid size-7 place-items-center rounded-full bg-white/[0.06]">
                    <StepStatusIcon status={step.status} />
                  </div>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="truncate text-xs font-black text-white/90">{step.label}</p>
                      <span className="rounded-full bg-white/[0.055] px-2 py-0.5 text-[9px] font-bold text-white/35">
                        {step.variant}
                      </span>
                    </div>
                    <p className={cn(
                      "mt-1 truncate text-[10px]",
                      step.error ? "text-rose-300/80" : "text-white/30",
                    )}>
                      {step.error || step.summary || step.description}
                    </p>
                  </div>
                  <div className="flex items-center justify-between gap-3 sm:justify-end">
                    <span className="text-[10px] font-semibold text-white/25">
                      {step.durationMs === undefined ? "" : formatDuration(step.durationMs)}
                    </span>
                    <span className={cn("rounded-full px-2.5 py-1 text-[9px] font-black", statusTone(step.status))}>
                      {stepStatusLabel[step.status]}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-[26px] bg-white/[0.045] p-4 sm:p-5">
            <div className="flex items-center justify-between px-1">
              <div className="flex items-center gap-2">
                <Radio className="size-4 text-emerald-300" />
                <h3 className="text-sm font-black">실시간 이벤트</h3>
              </div>
              <span className="text-[10px] font-bold text-white/30">{orderedEvents.length}개 표시</span>
            </div>
            <div className="mt-4 max-h-[560px] space-y-1.5 overflow-y-auto pr-1" aria-live="polite">
              {orderedEvents.length ? orderedEvents.map((event) => (
                <div key={event.sequence} className="rounded-[16px] bg-black/20 px-3.5 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-mono text-[9px] text-white/25">#{event.sequence}</span>
                    <time className="text-[9px] text-white/25">{formatMoment(event.at)}</time>
                  </div>
                  <p className={cn(
                    "mt-1.5 text-[11px] leading-5",
                    event.type.includes("failed") ? "text-rose-200" : "text-white/60",
                  )}>
                    {event.message}
                  </p>
                </div>
              )) : (
                <div className="grid min-h-36 place-items-center text-center">
                  <div>
                    <LoaderCircle className="mx-auto size-4 animate-spin text-white/30" />
                    <p className="mt-2 text-[10px] text-white/30">첫 이벤트를 기다리는 중입니다.</p>
                  </div>
                </div>
              )}
            </div>
            {isTerminalQualificationStatus(state.status) ? (
              <div className="mt-3 rounded-[18px] bg-white/[0.055] p-4">
                <div className="flex items-center gap-2">
                  <FileText className="size-4 text-white/50" />
                  <p className="text-xs font-black">생성된 인계 자료</p>
                </div>
                <p className="mt-2 break-all font-mono text-[10px] leading-5 text-white/35">
                  {state.artifacts.reportMarkdown}<br />
                  {state.artifacts.handoffPrompt}
                </p>
              </div>
            ) : null}
          </div>
        </div>

        <div className="mt-2 flex flex-col gap-2 rounded-[22px] bg-white/[0.035] px-4 py-3 text-[10px] text-white/30 sm:flex-row sm:items-center sm:justify-between">
          <span className="inline-flex items-center gap-1.5">
            <Cpu className="size-3" /> CUDA {state.config.cudaCapability} · BF16 미사용
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Thermometer className="size-3" /> 마지막 상태 {formatMoment(state.updatedAt)}
          </span>
        </div>
      </div>
    </section>
  );
}

export function AiQualificationDashboard({
  onUnauthorized,
}: {
  onUnauthorized: () => void;
}) {
  const [payload, setPayload] = useState<QualificationPayload>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const streamRef = useRef<EventSource | undefined>(undefined);
  const refreshRunning = useRef(false);

  const refresh = useCallback(async () => {
    if (refreshRunning.current) return;
    refreshRunning.current = true;
    try {
      const response = await fetch("/api/ai-qualification/runs/latest", {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      if (response.status === 401) {
        onUnauthorized();
        return;
      }
      if (response.status === 404) {
        setPayload(undefined);
        setError(undefined);
        return;
      }
      if (!response.ok) throw new Error("검증 진행 상태를 불러오지 못했습니다.");
      const value: unknown = await response.json();
      if (!isQualificationPayload(value)) throw new Error("검증 진행 상태 형식이 올바르지 않습니다.");
      setPayload(value);
      setError(undefined);
      if (isTerminalQualificationStatus(value.state.status)) setConnection("terminal");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "검증 진행 상태를 불러오지 못했습니다.");
    } finally {
      refreshRunning.current = false;
      setLoading(false);
    }
  }, [onUnauthorized]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const runId = payload?.state.runId;
  useEffect(() => {
    streamRef.current?.close();
    streamRef.current = undefined;
    if (!runId || (payload && isTerminalQualificationStatus(payload.state.status))) return;
    setConnection("connecting");
    const stream = new EventSource(
      `/api/ai-qualification/runs/${encodeURIComponent(runId)}/events`,
    );
    streamRef.current = stream;
    stream.onopen = () => setConnection("live");
    stream.addEventListener("snapshot", (event) => {
      try {
        const state = JSON.parse((event as MessageEvent<string>).data) as QualificationState;
        if (state.schemaVersion !== "ai-p40-qualification-state/v1" || state.runId !== runId) return;
        setPayload((current) => ({
          state,
          events: current?.state.runId === runId ? current.events : [],
        }));
        if (isTerminalQualificationStatus(state.status)) {
          setConnection("terminal");
          stream.close();
        }
      } catch {
        setConnection("polling");
      }
    });
    stream.addEventListener("progress", (event) => {
      try {
        const progressEvent = JSON.parse((event as MessageEvent<string>).data) as QualificationEvent;
        if (progressEvent.schemaVersion !== "ai-p40-qualification-event/v1"
          || progressEvent.runId !== runId) return;
        setPayload((current) => {
          if (!current || current.state.runId !== runId) return current;
          const events = [
            ...current.events.filter((item) => item.sequence !== progressEvent.sequence),
            progressEvent,
          ].sort((left, right) => left.sequence - right.sequence).slice(-200);
          return { ...current, events };
        });
      } catch {
        setConnection("polling");
      }
    });
    stream.addEventListener("terminal", () => {
      setConnection("terminal");
      stream.close();
      void refresh();
    });
    stream.onerror = () => setConnection("polling");
    return () => {
      stream.close();
      if (streamRef.current === stream) streamRef.current = undefined;
    };
  }, [payload?.state.status, refresh, runId]);

  useEffect(() => {
    if (connection === "live" || connection === "terminal") return;
    const timer = window.setInterval(() => void refresh(), 1_000);
    return () => window.clearInterval(timer);
  }, [connection, payload, refresh]);

  const events = useMemo(() => payload?.events ?? [], [payload?.events]);
  if (!payload) {
    return <EmptyState loading={loading} error={error} onRetry={() => void refresh()} />;
  }
  return (
    <AiQualificationRunView
      state={payload.state}
      events={events}
      connection={connection}
    />
  );
}
