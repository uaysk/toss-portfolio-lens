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

type QualificationExperiment = NonNullable<QualificationState["experiment"]>;
type FinCastBackendExperiment = Extract<
  QualificationExperiment,
  { kind: "fincast-fp32-backend-comparison" }
>;
type Chronos2ModelExperiment = Extract<
  QualificationExperiment,
  { kind: "chronos2-fincast-model-comparison" }
>;
type Chronos2ContextExperiment = Extract<
  QualificationExperiment,
  { kind: "chronos2-context-window-comparison" }
>;
type Chronos2ContextResult = NonNullable<
  Chronos2ContextExperiment["metrics"]["contextResults"]
>[number];
type CadenceContextExperiment = Extract<
  QualificationExperiment,
  { kind: "cadence-context-3week-benchmark" }
>;
type HighVolatilityProfitabilityExperiment = Extract<
  QualificationExperiment,
  { kind: "high-volatility-profitability-backtest" }
>;

function throughput(value?: number): string {
  return value === undefined ? "—" : value.toFixed(2);
}

function BackendComparisonSummary({
  experiment,
}: {
  experiment: FinCastBackendExperiment;
}) {
  const metrics = experiment.metrics;
  const speedup = metrics?.speedupRatio;
  return (
    <div className="mt-2 rounded-[26px] bg-white/[0.045] p-4 sm:p-5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm font-black">FP32 backend 비교</p>
          <p className="mt-1 text-xs text-white/40">
            전체 {experiment.durationWeeks}주 raw prediction · 실현 정확도/수익률 · 동일 row routing
          </p>
        </div>
        <span className="font-mono text-[10px] text-cyan-300/75">
          CUDA Graph = 기준선
        </span>
      </div>
      <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-[18px] bg-black/20 px-4 py-4">
          <p className="text-[10px] font-bold text-cyan-300/70">CUDA GRAPH FP32</p>
          <p className="mt-3 text-2xl font-black">{throughput(metrics?.cudaGraphSeriesPerSecond)}</p>
          <p className="mt-1 text-[10px] text-white/30">series/s · c60/B48</p>
        </div>
        <div className="rounded-[18px] bg-black/20 px-4 py-4">
          <p className="text-[10px] font-bold text-white/45">TENSORRT FP32</p>
          <p className="mt-3 text-2xl font-black">{throughput(metrics?.tensorRtSeriesPerSecond)}</p>
          <p className="mt-1 text-[10px] text-white/30">series/s · static engine</p>
        </div>
        <div className="rounded-[18px] bg-black/20 px-4 py-4">
          <p className="text-[10px] font-bold text-white/45">INTEGRATED SPEEDUP</p>
          <p className={cn(
            "mt-3 text-2xl font-black",
            speedup === undefined ? "text-white" : speedup >= 1 ? "text-emerald-300" : "text-rose-300",
          )}>
            {speedup === undefined ? "—" : `${speedup.toFixed(3)}×`}
          </p>
          <p className="mt-1 text-[10px] text-white/30">
            {metrics?.speedupPercent === undefined ? "측정 대기" : `${metrics.speedupPercent >= 0 ? "+" : ""}${metrics.speedupPercent.toFixed(2)}%`}
          </p>
        </div>
        <div className="rounded-[18px] bg-black/20 px-4 py-4">
          <p className="text-[10px] font-bold text-white/45">POLICY / MARGIN</p>
          <p className={cn(
            "mt-3 text-2xl font-black",
            metrics?.thresholdCrossingCount
              ? "text-amber-200"
              : metrics?.thresholdCrossingCount === 0 ? "text-emerald-300" : "text-white",
          )}>
            {metrics?.thresholdCrossingCount ?? "—"}
          </p>
          <p className="mt-1 text-[10px] text-white/30">
            probability-only action Δ ·{" "}
            {metrics?.probabilityOnlyActionMismatchRate === undefined
              ? "—"
              : `${(metrics.probabilityOnlyActionMismatchRate * 100).toFixed(4)}%`}
          </p>
        </div>
      </div>
      <div className="mt-2 grid gap-2 text-[10px] sm:grid-cols-3">
        <p className="rounded-[16px] bg-black/20 px-3.5 py-3 text-white/40">
          방향 일치율{" "}
          <strong className="text-white/75">
            {metrics?.directionMatchRate === undefined
              ? "—"
              : `${(metrics.directionMatchRate * 100).toFixed(4)}%`}
          </strong>
        </p>
        <p className="rounded-[16px] bg-black/20 px-3.5 py-3 text-white/40">
          최소 |margin| · Graph / TRT{" "}
          <strong className="text-white/75">
            {metrics?.closestReferenceMargin === undefined
              ? "—"
              : `${metrics.closestReferenceMargin.toExponential(3)} / ${metrics.closestCandidateMargin?.toExponential(3) ?? "—"}`}
          </strong>
        </p>
        <p className="truncate rounded-[16px] bg-black/20 px-3.5 py-3 font-mono text-white/40">
          {experiment.thresholdMarginArtifact} · {metrics?.thresholdMarginRecordCount ?? 0} rows
        </p>
      </div>
      <div className="mt-2 grid gap-2 text-[10px] sm:grid-cols-2 xl:grid-cols-4">
        <p className="rounded-[16px] bg-black/20 px-3.5 py-3 text-white/40">
          실현 방향 정확도 · Graph / TRT{" "}
          <strong className="text-white/75">
            {metrics?.referenceRealizedDirectionAccuracy === undefined ||
            metrics.candidateRealizedDirectionAccuracy === undefined
              ? "—"
              : `${(metrics.referenceRealizedDirectionAccuracy * 100).toFixed(2)}% / ${(metrics.candidateRealizedDirectionAccuracy * 100).toFixed(2)}%`}
          </strong>
        </p>
        <p className="rounded-[16px] bg-black/20 px-3.5 py-3 text-white/40">
          최대 수익률 / MDD Δ{" "}
          <strong className="text-white/75">
            {metrics?.maximumReturnDelta === undefined ||
            metrics.maximumDrawdownDelta === undefined
              ? "—"
              : `${(metrics.maximumReturnDelta * 10_000).toFixed(3)} / ${(metrics.maximumDrawdownDelta * 10_000).toFixed(3)} bp`}
          </strong>
        </p>
        <p className="rounded-[16px] bg-black/20 px-3.5 py-3 text-white/40">
          symbol 정렬 action / reason 차이{" "}
          <strong className="text-white/75">
            {metrics?.symbolAlignedActionMismatches ?? "—"} / {metrics?.symbolAlignedReasonMismatches ?? "—"}
          </strong>
        </p>
        <p className={cn(
          "rounded-[16px] bg-black/20 px-3.5 py-3",
          metrics?.offlineEconomicallyAcceptable === true
            ? "text-emerald-300"
            : metrics?.offlineEconomicallyAcceptable === false
              ? "text-rose-300"
              : "text-white/40",
        )}>
          offline 경제적 동등성{" "}
          <strong>
            {metrics?.offlineEconomicallyAcceptable === undefined
              ? "—"
              : metrics.offlineEconomicallyAcceptable ? "조건부 통과" : "실패"}
          </strong>
        </p>
        <p className="rounded-[16px] bg-black/20 px-3.5 py-3 text-white/40">
          확률 Δ ≥1 / 5 / 10pp{" "}
          <strong className="text-white/75">
            {metrics?.probabilityOutlier1ppCount ?? "—"} /{" "}
            {metrics?.probabilityOutlier5ppCount ?? "—"} /{" "}
            {metrics?.probabilityOutlier10ppCount ?? "—"}
          </strong>
        </p>
        <p className="rounded-[16px] bg-black/20 px-3.5 py-3 text-white/40">
          최대 확률 Δ / 방향 차이{" "}
          <strong className="text-white/75">
            {metrics?.maximumProbabilityDelta === undefined
              ? "—"
              : `${(metrics.maximumProbabilityDelta * 100).toFixed(4)}pp / ${metrics.realizedDirectionDisagreements ?? "—"}`}
          </strong>
        </p>
      </div>
    </div>
  );
}

function Chronos2ComparisonSummary({
  experiment,
}: {
  experiment: Chronos2ModelExperiment;
}) {
  const metrics = experiment.metrics;
  const eta = metrics?.estimatedFullDurationMs;
  const etaUpper = metrics?.estimatedFullDurationUpperMs;
  return (
    <div className="mt-2 rounded-[26px] bg-white/[0.045] p-4 sm:p-5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm font-black">Chronos-2 · FinCast 모델 비교</p>
          <p className="mt-1 text-xs text-white/40">
            네 입력 profile · 동일 BTC/ETH origin · 실현 정확도/수익률 · FP32
          </p>
        </div>
        <span className="font-mono text-[10px] text-cyan-300/75">
          FinCast CUDA Graph = 기준선
        </span>
      </div>
      <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-[18px] bg-black/20 px-4 py-4">
          <p className="text-[10px] font-bold text-white/45">RUN MODE</p>
          <p className="mt-3 text-2xl font-black uppercase">{experiment.mode}</p>
          <p className="mt-1 text-[10px] text-white/30">
            {(experiment.durationWeeks * 7 * 24).toFixed(0)}h · c60
          </p>
        </div>
        <div className="rounded-[18px] bg-black/20 px-4 py-4">
          <p className="text-[10px] font-bold text-white/45">SELECTED PROFILE</p>
          <p className="mt-3 truncate text-lg font-black">
            {metrics?.selectedProfile ?? "측정 대기"}
          </p>
          <p className="mt-1 text-[10px] text-white/30">
            추가 covariate 개선{" "}
            {metrics?.additionalCovariatesImprovedHoldout === undefined
              || metrics.additionalCovariatesImprovedHoldout === null
              ? "—"
              : metrics.additionalCovariatesImprovedHoldout ? "확인" : "미확인"}
          </p>
        </div>
        <div className="rounded-[18px] bg-black/20 px-4 py-4">
          <p className="text-[10px] font-bold text-white/45">CHRONOS BACKEND</p>
          <p className="mt-3 truncate text-lg font-black">
            {metrics?.selectedBackend ?? experiment.candidateBackend ?? "측정 대기"}
          </p>
          <p className="mt-1 text-[10px] text-white/30">
            {metrics?.selectedBatchSize ? `variate B${metrics.selectedBatchSize}` : "batch sweep 대기"}
          </p>
        </div>
        <div className="rounded-[18px] bg-black/20 px-4 py-4">
          <p className="text-[10px] font-bold text-white/45">5주 ETA</p>
          <p className="mt-3 text-2xl font-black">
            {eta === undefined ? "—" : formatDuration(eta)}
          </p>
          <p className="mt-1 text-[10px] text-white/30">
            보수 상한 {etaUpper === undefined ? "—" : formatDuration(etaUpper)}
          </p>
        </div>
      </div>
      <div className="mt-2 grid gap-2 text-[10px] sm:grid-cols-2 xl:grid-cols-4">
        <p className="rounded-[16px] bg-black/20 px-3.5 py-3 text-white/40">
          실현 방향 정확도 · FinCast / Chronos-2{" "}
          <strong className="text-white/75">
            {metrics?.fincastDirectionAccuracy === undefined
              || metrics.chronos2DirectionAccuracy === undefined
              ? "—"
              : `${(metrics.fincastDirectionAccuracy * 100).toFixed(2)}% / ${(metrics.chronos2DirectionAccuracy * 100).toFixed(2)}%`}
          </strong>
        </p>
        <p className="rounded-[16px] bg-black/20 px-3.5 py-3 text-white/40">
          정책 수익률 중앙값 · FinCast / Chronos-2{" "}
          <strong className="text-white/75">
            {metrics?.fincastMedianPolicyReturn === undefined
              || metrics.chronos2MedianPolicyReturn === undefined
              ? "—"
              : `${(metrics.fincastMedianPolicyReturn * 100).toFixed(2)}% / ${(metrics.chronos2MedianPolicyReturn * 100).toFixed(2)}%`}
          </strong>
        </p>
        <p className="rounded-[16px] bg-black/20 px-3.5 py-3 text-white/40">
          입력 profile <strong className="text-white/75">{experiment.profiles.length}개</strong>
        </p>
        <p className="rounded-[16px] bg-black/20 px-3.5 py-3 text-amber-200/80">
          live 자동 승격 <strong>비활성</strong>
        </p>
      </div>
    </div>
  );
}

function ContextWindowSummary({
  experiment,
}: {
  experiment: Chronos2ContextExperiment;
}) {
  const metrics = experiment.metrics;
  const results: Chronos2ContextResult[] = metrics.contextResults
    ?? experiment.contexts.map((contextBars) => ({
      contextBars,
      status: "pending",
    }));
  return (
    <div className="mt-2 rounded-[26px] bg-white/[0.045] p-4 sm:p-5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm font-black">Chronos-2 context window 비교</p>
          <p className="mt-1 text-xs text-white/40">
            close-only · cross-learning off · 동일 scored origin · native quantile accuracy-first
          </p>
        </div>
        <span className="font-mono text-[10px] text-cyan-300/75">
          {experiment.phase.toUpperCase()} · live 512 유지
        </span>
      </div>
      <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
        {results.map((result) => (
          <div
            key={result.contextBars}
            data-context-window-card={result.contextBars}
            className={cn(
              "rounded-[18px] bg-black/20 px-4 py-4",
              metrics.selectedContextBars === result.contextBars && "ring-1 ring-emerald-300/60",
            )}
          >
            <div className="flex items-center justify-between gap-2">
              <p className="text-[10px] font-bold text-white/45">CONTEXT</p>
              <span className={cn(
                "rounded-full px-2 py-0.5 text-[9px] font-black",
                result.status === "passed" || result.status === "completed"
                  ? "bg-emerald-400/15 text-emerald-300"
                  : result.status === "failed" || result.status === "rejected"
                    ? "bg-rose-400/15 text-rose-300"
                    : "bg-white/[0.07] text-white/45",
              )}>
                {result.status}
              </span>
            </div>
            <p className="mt-3 text-2xl font-black">{result.contextBars}</p>
            <p className="mt-1 truncate text-[10px] text-white/35">
              {result.backend ?? "backend 대기"} · {result.batchSize ? `B${result.batchSize}` : "batch 대기"}
            </p>
            <div className="mt-3 grid grid-cols-2 gap-1 text-[9px] text-white/35">
              <span>p95 {result.latencyP95Ms?.toFixed(1) ?? "—"}ms</span>
              <span>{result.tasksPerSecond?.toFixed(2) ?? "—"} task/s</span>
              <span>Pinball {result.meanPinballLoss?.toPrecision(4) ?? "—"}</span>
              <span>WIS {result.wis?.toPrecision(4) ?? "—"}</span>
              <span>VRAM {result.minimumFreeVramBytes === undefined ? "—" : `${(result.minimumFreeVramBytes / 2 ** 30).toFixed(1)}G free`}</span>
              <span>{result.maximumPowerW?.toFixed(0) ?? "—"}W · {result.maximumTemperatureC?.toFixed(0) ?? "—"}°C</span>
            </div>
            {result.bootstrapCiLow !== undefined && result.bootstrapCiHigh !== undefined ? (
              <p className="mt-2 truncate font-mono text-[9px] text-white/25">
                Δ CI [{result.bootstrapCiLow.toExponential(2)}, {result.bootstrapCiHigh.toExponential(2)}]
              </p>
            ) : null}
            {result.artifactDigest ? (
              <p className="mt-2 truncate font-mono text-[9px] text-white/20">
                {result.artifactDigest}
              </p>
            ) : null}
          </div>
        ))}
      </div>
      <div className="mt-2 grid gap-2 text-[10px] sm:grid-cols-2 xl:grid-cols-4">
        <p className={cn(
          "rounded-[16px] bg-black/20 px-3.5 py-3",
          metrics.pilotGatePassed === true
            ? "text-emerald-300"
            : metrics.pilotGatePassed === false ? "text-rose-300" : "text-white/40",
        )}>
          pilot gate <strong>{metrics.pilotGatePassed === undefined ? "대기" : metrics.pilotGatePassed ? "통과" : "실패"}</strong>
        </p>
        <p className="rounded-[16px] bg-black/20 px-3.5 py-3 text-white/40">
          5주 ETA 상한{" "}
          <strong className="text-white/75">
            {metrics.estimatedFullDurationUpperMs === undefined
              ? "—"
              : formatDuration(metrics.estimatedFullDurationUpperMs)}
          </strong>
        </p>
        <p className="rounded-[16px] bg-black/20 px-3.5 py-3 text-white/40">
          예상 artifact 후 disk{" "}
          <strong className="text-white/75">
            {metrics.projectedDiskFreeGiB === undefined ? "—" : `${metrics.projectedDiskFreeGiB.toFixed(1)} GiB`}
          </strong>
        </p>
        <p className="rounded-[16px] bg-black/20 px-3.5 py-3 text-amber-200/80">
          선택 context <strong>{metrics.selectedContextBars ?? "holdout 전 대기"}</strong>
        </p>
      </div>
    </div>
  );
}

function formatLookback(seconds: number): string {
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor(seconds % 3_600 / 60);
  return hours ? `${hours}h ${minutes.toString().padStart(2, "0")}m` : `${minutes}m`;
}

function CadenceContextSummary({
  experiment,
}: {
  experiment: CadenceContextExperiment;
}) {
  const completed = experiment.combinations.filter((item) => item.status === "completed").length;
  const failed = experiment.combinations.filter((item) => item.status === "failed").length;
  const excluded = experiment.combinations.filter((item) =>
    item.status === "excluded" || item.status === "dependency_failed"
  ).length;
  const conditional = experiment.combinations.filter((item) => item.planRole === "conditional").length;
  const current = experiment.currentCombinationId
    ? experiment.combinations.find((item) => item.id === experiment.currentCombinationId)
    : undefined;
  return (
    <div
      className="mt-2 rounded-[26px] bg-white/[0.045] p-4 sm:p-5"
      data-cadence-context-dashboard
    >
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-sm font-black">FinCast · Chronos-2 cadence/context 3주 benchmark</p>
          <p className="mt-1 text-xs text-white/40">
            {formatMoment(experiment.evaluationStart)} → {formatMoment(experiment.evaluationEndExclusive)}
            {" · "}15분 origin · 5/15/30/60분 horizon · cross-learning off
          </p>
        </div>
        <div className="flex flex-wrap gap-2 text-[10px] font-black">
          <span className="rounded-full bg-cyan-400/10 px-3 py-1.5 text-cyan-200">
            {experiment.phase.toUpperCase()}
          </span>
          <span className={cn(
            "rounded-full px-3 py-1.5",
            experiment.selectedPlanReady
              ? "bg-emerald-400/15 text-emerald-300"
              : "bg-amber-300/15 text-amber-200",
          )}>
            FINAL PLAN {experiment.selectedPlanReady ? `${experiment.selectedCombinationCount}개` : "대기"}
          </span>
          <span className="rounded-full bg-white/[0.06] px-3 py-1.5 text-white/45">
            {completed}/{experiment.totalCombinationCount} 완료 · {failed} 실패
          </span>
        </div>
      </div>

      <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
        <p className="rounded-[16px] bg-black/20 px-3.5 py-3 text-[10px] text-white/45">
          기본 matrix <strong className="text-white/80">{experiment.defaultFinalCombinationIds?.length ?? 10}</strong>
        </p>
        <p className="rounded-[16px] bg-black/20 px-3.5 py-3 text-[10px] text-white/45">
          조건부 <strong className="text-white/80">{conditional || 7}</strong>
        </p>
        <p className="rounded-[16px] bg-black/20 px-3.5 py-3 text-[10px] text-emerald-200/70">
          최종 선택 <strong>{experiment.selectedCombinationCount}</strong>
        </p>
        <p className="rounded-[16px] bg-black/20 px-3.5 py-3 text-[10px] text-rose-200/65">
          제외/dependency <strong>{excluded}</strong>
        </p>
        <p className="rounded-[16px] bg-black/20 px-3.5 py-3 text-[10px] text-amber-100/65">
          후속 후보 <strong>{experiment.followupCandidateIds?.length ?? 0}</strong>
        </p>
      </div>

      <div className="mt-4 grid gap-2 sm:grid-cols-3">
        {(["low", "medium", "high"] as const).map((regime) => {
          const window = experiment.screeningWindows.find((item) => item.regime === regime);
          return (
            <div key={regime} className="rounded-[16px] bg-black/20 px-3.5 py-3">
              <p className="text-[9px] font-black uppercase text-white/30">{regime} volatility</p>
              <p className="mt-1 text-[11px] font-bold text-white/70">
                {window ? `${formatMoment(window.start)} · RV ${window.realizedVolatility.toPrecision(4)}` : "선정 대기"}
              </p>
            </div>
          );
        })}
      </div>

      {current ? (
        <div className="mt-2 rounded-[18px] bg-emerald-400/[0.08] px-4 py-3" aria-live="polite">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs font-black text-emerald-200">
              {current.id} · {experiment.currentSymbol ?? "symbol 대기"} ·{" "}
              {experiment.currentOrigin ? formatMoment(experiment.currentOrigin) : "origin 대기"}
            </p>
            <p className="text-[10px] text-emerald-100/55">
              {current.completedOrigins}/{current.totalOrigins} · {current.progressPercent.toFixed(1)}%
              {current.etaMs === null ? "" : ` · ETA ${formatDuration(current.etaMs)}`}
              {current.inferenceBatchSize === undefined ? "" : ` · B${current.inferenceBatchSize}`}
            </p>
          </div>
          {current.executionOptimizationVersion ? (
            <p className="mt-1 truncate text-[9px] text-emerald-100/35">
              실행 최적화 {current.executionOptimizationVersion}
            </p>
          ) : null}
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-black/30">
            <div
              className="h-full rounded-full bg-emerald-300 transition-[width]"
              style={{ width: `${current.progressPercent}%` }}
            />
          </div>
        </div>
      ) : null}

      <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {experiment.combinations.map((item) => {
          const statusClass = item.status === "completed"
            ? "bg-emerald-400/15 text-emerald-300"
            : item.status === "failed"
              ? "bg-rose-400/15 text-rose-300"
            : item.status === "running" || item.status === "retrying"
                ? "bg-cyan-400/15 text-cyan-200"
                : item.status === "followup_only"
                  ? "bg-violet-400/15 text-violet-200"
                  : item.status === "skipped"
                    || item.status === "excluded"
                    || item.status === "dependency_failed"
                  ? "bg-amber-300/15 text-amber-200"
                  : "bg-white/[0.07] text-white/40";
          return (
            <div
              key={item.id}
              data-benchmark-combination={item.id}
              data-screening-decision={item.screeningDecision}
              data-selected-for-final={item.selectedForFinal ? "true" : "false"}
              className={cn(
                "rounded-[18px] bg-black/20 px-4 py-4",
                item.id === experiment.currentCombinationId && "ring-1 ring-emerald-300/60",
                item.selectedForFinal && "ring-1 ring-cyan-300/25",
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-[10px] font-black uppercase text-white/45">
                    {item.model}
                  </p>
                  <p className="mt-0.5 text-[8px] font-black uppercase tracking-wide text-white/25">
                    {item.planRole ?? "unassigned"} · {item.screeningStatus ?? "unavailable"}
                  </p>
                </div>
                <span className={cn("rounded-full px-2 py-0.5 text-[9px] font-black", statusClass)}>
                  {item.status}
                </span>
              </div>
              <p className="mt-3 text-lg font-black">
                c{item.contextBars} · {item.cadenceSeconds}s
              </p>
              <p className="mt-1 text-[10px] text-white/35">
                {formatLookback(item.lookbackSeconds)} lookback · {item.predictionLengthSteps} step
                {item.inferenceBatchSize === undefined ? "" : ` · B${item.inferenceBatchSize}`}
              </p>
              {item.executionOptimizationVersion ? (
                <p
                  className="mt-1 truncate text-[8px] text-cyan-100/35"
                  title={item.executionOptimizationVersion}
                >
                  {item.executionOptimizationVersion}
                </p>
              ) : null}
              <div className="mt-3 grid grid-cols-2 gap-1 text-[9px] text-white/35">
                <span>WIS {item.partialPrediction?.wis?.toPrecision(4) ?? "—"}</span>
                <span>DIR {item.partialPrediction?.directionAccuracy === null || item.partialPrediction?.directionAccuracy === undefined
                  ? "—"
                  : `${(item.partialPrediction.directionAccuracy * 100).toFixed(1)}%`}</span>
                <span>NET {item.partialTrading?.netReturn === undefined
                  ? "—"
                  : `${(item.partialTrading.netReturn * 100).toFixed(2)}%`}</span>
                <span>p95 {item.latencyP95Ms?.toFixed(0) ?? "—"}ms</span>
                <span>VRAM {item.peakVramMiB === null || item.peakVramMiB === undefined
                  ? "—"
                  : `${(item.peakVramMiB / 1_024).toFixed(1)}G`}</span>
                <span>retry {item.retryCount}</span>
              </div>
              <div className="mt-3 h-1 overflow-hidden rounded-full bg-white/10">
                <div className="h-full rounded-full bg-white/70" style={{ width: `${item.progressPercent}%` }} />
              </div>
              {item.screeningReason ? (
                <p
                  className={cn(
                    "mt-2 line-clamp-2 text-[9px] leading-4",
                    item.screeningDecision === "excluded"
                      ? "text-rose-200/70"
                      : item.screeningDecision === "borderline"
                        ? "text-amber-100/65"
                        : "text-white/25",
                  )}
                  title={item.screeningReason}
                >
                  {item.screeningDecision}: {item.screeningReason}
                </p>
              ) : null}
              {item.dependencyIds?.length || item.screeningComparatorIds?.length ? (
                <p className="mt-2 line-clamp-2 text-[8px] leading-3 text-white/20">
                  {item.dependencyIds?.length ? `dep ${item.dependencyIds.join(", ")}` : ""}
                  {item.dependencyIds?.length && item.screeningComparatorIds?.length ? " · " : ""}
                  {item.screeningComparatorIds?.length
                    ? `vs ${item.screeningComparatorIds.join(", ")}`
                    : ""}
                </p>
              ) : null}
              {item.failureReason ? (
                <p className="mt-2 line-clamp-2 text-[9px] leading-4 text-rose-200/80">
                  {item.failureReason}
                </p>
              ) : null}
            </div>
          );
        })}
      </div>

      <div className="mt-2 rounded-[16px] bg-black/20 px-3.5 py-3 text-[10px] text-amber-100/60">
        {experiment.fiveSecondLookbackNote}
      </div>
      {experiment.recentLogLines.length ? (
        <div className="mt-2 max-h-36 overflow-y-auto rounded-[16px] bg-black/30 px-3.5 py-3 font-mono text-[9px] leading-5 text-white/35">
          {experiment.recentLogLines.slice(-8).map((line, index) => (
            <p key={`${index}-${line}`}>{line}</p>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function formatReturn(value?: number | null): string {
  return value === undefined || value === null ? "—" : `${(value * 100).toFixed(2)}%`;
}

function HighVolatilityProfitabilitySummary({
  experiment,
}: {
  experiment: HighVolatilityProfitabilityExperiment;
}) {
  const laneCards = [
    ["Chronos-2", experiment.models.chronos2],
    ["FinCast", experiment.models.fincast],
  ] as const;
  const resultCards = [
    ["Chronos-2 + Rust", experiment.results?.chronos2Rust],
    ["Chronos-2 + FinCast veto + Rust", experiment.results?.chronos2FincastVetoRust],
  ] as const;
  const completed = experiment.completedOrigins;
  const total = experiment.totalOrigins;
  const originPercent = total ? Math.min(100, completed / total * 100) : 0;

  return (
    <div
      className="mt-2 rounded-[26px] bg-white/[0.045] p-4 sm:p-5"
      data-high-vol-profitability-dashboard
    >
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-sm font-black">고변동성 암호화폐 모델 스택 수익성 검증</p>
          <p className="mt-1 text-xs text-white/40">
            {formatMoment(experiment.evaluationStart)} → {formatMoment(experiment.evaluationEndExclusive)}
            {" · "}15분 origin · point-in-time top-5 → model top-3 → 최종 top-1
          </p>
        </div>
        <div className="flex flex-wrap gap-2 text-[10px] font-black">
          <span className="rounded-full bg-cyan-400/10 px-3 py-1.5 text-cyan-200">
            {experiment.phase.toUpperCase()}
          </span>
          <span className="rounded-full bg-white/[0.06] px-3 py-1.5 text-white/45">
            후보 {experiment.candidateUniverse.length} · 사용 가능 {experiment.usableCandidates.length}
          </span>
          <span className={cn(
            "rounded-full px-3 py-1.5",
            experiment.dataErrorCount
              ? "bg-amber-300/15 text-amber-200"
              : "bg-emerald-400/15 text-emerald-300",
          )}>
            DATA ERROR {experiment.dataErrorCount}
          </span>
        </div>
      </div>

      <div className="mt-4 grid gap-2 lg:grid-cols-2">
        {laneCards.map(([name, lane]) => {
          const lanePercent = lane.total ? Math.min(100, lane.completed / lane.total * 100) : 0;
          const tone = lane.status === "completed"
            ? "bg-emerald-400/15 text-emerald-300"
            : lane.status === "running"
              ? "bg-cyan-400/15 text-cyan-200"
              : lane.status === "failed" || lane.status === "unavailable"
                ? "bg-rose-400/15 text-rose-300"
                : "bg-white/[0.07] text-white/40";
          return (
            <div key={name} className="rounded-[18px] bg-black/20 px-4 py-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-xs font-black text-white/85">{name}</p>
                    <span className="rounded-full bg-violet-400/10 px-2 py-0.5 text-[9px] font-black uppercase text-violet-200">
                      {lane.role}
                    </span>
                  </div>
                  <p className="mt-1 truncate font-mono text-[9px] text-white/30">
                    {lane.modelId} · {lane.modelRevision ?? "revision unavailable"}
                  </p>
                </div>
                <span className={cn("rounded-full px-2.5 py-1 text-[9px] font-black", tone)}>
                  {lane.status}
                </span>
              </div>
              <p className="mt-3 text-lg font-black">
                c{lane.contextBars} · {lane.cadenceSeconds}s
              </p>
              <div className="mt-2 flex items-center justify-between text-[10px] text-white/35">
                <span>{lane.completed}/{lane.total} origin</span>
                <span>retry {lane.retries}</span>
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10">
                <div className="h-full rounded-full bg-white/70" style={{ width: `${lanePercent}%` }} />
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-2 rounded-[18px] bg-black/20 px-4 py-3" aria-live="polite">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs font-black text-white/75">
            {experiment.currentSymbol ?? "symbol 대기"}
            {" · "}
            {experiment.currentOrigin ? formatMoment(experiment.currentOrigin) : "origin 대기"}
          </p>
          <p className="text-[10px] text-white/40">{completed}/{total} · {originPercent.toFixed(1)}%</p>
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10">
          <div className="h-full rounded-full bg-cyan-300" style={{ width: `${originPercent}%` }} />
        </div>
      </div>

      <div className="mt-2 grid gap-2 lg:grid-cols-2">
        {resultCards.map(([name, metrics]) => (
          <div key={name} className="rounded-[18px] bg-black/20 px-4 py-4">
            <p className="text-xs font-black text-white/75">{name}</p>
            <div className="mt-3 grid grid-cols-3 gap-2 text-[10px]">
              <p className="text-white/35">NET <strong className="block text-sm text-white/85">{formatReturn(metrics?.netReturn)}</strong></p>
              <p className="text-white/35">SHARPE <strong className="block text-sm text-white/85">{metrics?.sharpe?.toFixed(2) ?? "—"}</strong></p>
              <p className="text-white/35">MDD <strong className="block text-sm text-white/85">{formatReturn(metrics?.maxDrawdown)}</strong></p>
              <p className="text-white/35">GROSS <strong className="block text-sm text-white/85">{formatReturn(metrics?.grossReturn)}</strong></p>
              <p className="text-white/35">TRADES <strong className="block text-sm text-white/85">{metrics?.tradeCount ?? "—"}</strong></p>
              <p className="text-white/35">VETO <strong className="block text-sm text-white/85">{metrics?.vetoCount ?? "—"}</strong></p>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-2 flex flex-wrap gap-2 text-[9px] text-white/35">
        <span className="rounded-full bg-black/20 px-3 py-1.5">{experiment.policyVersions.selector}</span>
        <span className="rounded-full bg-black/20 px-3 py-1.5">{experiment.policyVersions.vetoCalibration}</span>
      </div>

      {experiment.failureReason ? (
        <div className="mt-2 rounded-[16px] bg-rose-400/10 px-3.5 py-3 text-[10px] leading-5 text-rose-200">
          {experiment.failureReason}
        </div>
      ) : null}
      {experiment.recentLogLines.length ? (
        <div className="mt-2 max-h-36 overflow-y-auto rounded-[16px] bg-black/30 px-3.5 py-3 font-mono text-[9px] leading-5 text-white/35">
          {experiment.recentLogLines.slice(-8).map((line, index) => (
            <p key={`${index}-${line}`}>{line}</p>
          ))}
        </div>
      ) : null}
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
  const backendExperiment = state.experiment?.kind === "fincast-fp32-backend-comparison"
    ? state.experiment
    : undefined;
  const chronos2Experiment = state.experiment?.kind === "chronos2-fincast-model-comparison"
    ? state.experiment
    : undefined;
  const contextExperiment = state.experiment?.kind === "chronos2-context-window-comparison"
    ? state.experiment
    : undefined;
  const cadenceExperiment = state.experiment?.kind === "cadence-context-3week-benchmark"
    ? state.experiment
    : undefined;
  const highVolExperiment = state.experiment?.kind === "high-volatility-profitability-backtest"
    ? state.experiment
    : undefined;
  const fincastSteps = state.steps.filter((step) => step.id.startsWith("fincast-batch"));
  const cudaGraphSteps = state.steps.filter((step) => step.id.startsWith("cuda-graph"));
  const tensorRtSteps = state.steps.filter((step) => step.id.startsWith("tensorrt"));
  const chronos2Steps = state.steps.filter((step) => step.model === "chronos-2");
  const chronos2ComparisonSteps = state.steps.filter((step) => (
    step.model === "comparison"
    && !["prepare-input"].includes(step.id)
  ));
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
              {highVolExperiment
                ? "고변동성 암호화폐 모델 스택 수익성 검증"
                : cadenceExperiment
                ? "FinCast · Chronos-2 cadence/context 3주 benchmark"
                : backendExperiment
                ? `FinCast FP32 ${backendExperiment.durationWeeks}주 백엔드 검증`
                : contextExperiment
                  ? `Chronos-2 Context Window ${contextExperiment.phase === "pilot" ? "pilot" : "5주"} 검증`
                : chronos2Experiment
                  ? `Chronos-2 · FinCast ${chronos2Experiment.mode === "pilot" ? "pilot" : "5주"} 검증`
                : "모델 검증 진행 상황"}
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
              <p className="mt-1 text-xs font-black">
                {highVolExperiment
                  ? `${Math.round(state.config.durationHours / 24)}일`
                  : cadenceExperiment
                  ? "정확히 21일"
                  : backendExperiment
                  ? `${backendExperiment.durationWeeks}주`
                  : `${state.config.durationHours}시간`}
              </p>
            </div>
            <div className="rounded-[18px] bg-white/[0.045] px-4 py-3">
              <p className="text-[10px] font-bold text-white/35">심볼</p>
              <p className="mt-1 truncate text-xs font-black">{state.config.symbols.join(" · ")}</p>
            </div>
            <div className="rounded-[18px] bg-white/[0.045] px-4 py-3">
              <p className="text-[10px] font-bold text-white/35">
                {highVolExperiment
                  ? "PIPELINE"
                  : cadenceExperiment
                  ? "MATRIX"
                  : backendExperiment ? "ROUTE" : contextExperiment ? "CONTEXT" : chronos2Experiment ? "PROFILE" : "BUILD"}
              </p>
              <p className="mt-1 text-xs font-black">
                {highVolExperiment
                  ? `${highVolExperiment.phase} · top-${highVolExperiment.modelSelectorCandidateCount}`
                  : cadenceExperiment
                  ? `${cadenceExperiment.totalCombinationCount}개 · ${cadenceExperiment.phase}`
                  : backendExperiment
                  ? `c${backendExperiment.cadenceSeconds} / B${backendExperiment.batchSize}`
                  : contextExperiment
                    ? `${contextExperiment.contexts.length}개 / close`
                  : chronos2Experiment
                    ? `${chronos2Experiment.profiles.length}개 / c60`
                  : "SKIPPED"}
              </p>
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
            detail={state.telemetry
              ? `온도 ${state.telemetry.temperatureC.toFixed(0)}°C · ${state.telemetry.powerDrawW?.toFixed(0) ?? "—"} / ${state.telemetry.powerLimitW?.toFixed(0) ?? "160"} W`
              : "telemetry 대기 중"}
            accent={state.telemetry?.gpuUtilizationPercent ? "green" : undefined}
          />
          <Metric
            icon={MemoryStick}
            label="VRAM"
            value={state.telemetry
              ? `${(state.telemetry.memoryUsedMiB / 1_024).toFixed(1)} GB`
              : "—"}
            detail={state.telemetry
              ? `${memoryPercent.toFixed(0)}% · headroom ${((state.telemetry.memoryHeadroomMiB ?? state.telemetry.memoryTotalMiB - state.telemetry.memoryUsedMiB) / 1_024).toFixed(1)} GB`
              : "telemetry 대기 중"}
            accent={memoryPercent > 90 ? "amber" : undefined}
          />
        </div>

        {cadenceExperiment || highVolExperiment ? (
          <div className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            <Metric
              icon={Cpu}
              label="CPU"
              value={state.telemetry?.cpuUtilizationPercent === undefined
                ? "—"
                : `${state.telemetry.cpuUtilizationPercent.toFixed(0)}%`}
              detail={cadenceExperiment
                ? `data ${cadenceExperiment.dataThroughputRowsPerSecond?.toFixed(2) ?? "—"} unit/s`
                : `data error ${highVolExperiment?.dataErrorCount ?? 0}`}
            />
            <Metric
              icon={MemoryStick}
              label="RAM"
              value={state.telemetry?.ramUsedMiB === undefined
                ? "—"
                : `${(state.telemetry.ramUsedMiB / 1_024).toFixed(1)} GB`}
              detail={state.telemetry?.ramTotalMiB === undefined
                ? "telemetry 대기 중"
                : `total ${(state.telemetry.ramTotalMiB / 1_024).toFixed(1)} GB`}
            />
            <Metric
              icon={Activity}
              label="추론 처리량"
              value={`${(
                cadenceExperiment?.inferenceThroughputOriginsPerSecond
                ?? state.telemetry?.inferenceOriginsPerSecond
              )?.toFixed(3) ?? "—"}/s`}
              detail={cadenceExperiment
                ? `${cadenceExperiment.inferenceOriginsProcessed} origin 처리`
                : `${highVolExperiment?.completedOrigins ?? 0} origin 처리`}
            />
            <Metric
              icon={TimerReset}
              label={cadenceExperiment ? "현재 조합" : "현재 심볼"}
              value={cadenceExperiment?.currentCombinationId ?? highVolExperiment?.currentSymbol ?? "대기"}
              detail={(cadenceExperiment?.currentOrigin ?? highVolExperiment?.currentOrigin)
                ? formatMoment((cadenceExperiment?.currentOrigin ?? highVolExperiment?.currentOrigin)!)
                : "origin 대기"}
            />
          </div>
        ) : null}

        {!cadenceExperiment && !highVolExperiment ? <div className="mt-2 grid gap-2 lg:grid-cols-2">
          {backendExperiment ? (
            <>
              <LaneSummary
                title="CUDA Graph FP32"
                subtitle="qualified PyTorch reference · 독립 2회"
                steps={cudaGraphSteps}
              />
              <LaneSummary
                title="TensorRT FP32"
                subtitle="static c60/B48 engine challenger · 독립 2회"
                steps={tensorRtSteps}
              />
            </>
          ) : chronos2Experiment || contextExperiment ? (
            <>
              <LaneSummary
                title="Chronos-2 FP32"
                subtitle={contextExperiment
                  ? "5 context · 10 batches · 4 backends"
                  : "batch sweep · patch alignment · GPU gather · CUDA Graph"}
                steps={chronos2Steps}
              />
              <LaneSummary
                title="FinCast 기준·모델 비교"
                subtitle={contextExperiment
                  ? "origin parity · pilot gate · accuracy/bootstrap"
                  : "CUDA Graph FP32 · 실현 정확도 · 정책 수익률"}
                steps={chronos2ComparisonSteps}
              />
            </>
          ) : (
            <>
              <LaneSummary
                title="Chronos-2"
                subtitle="FP32 · canonical challenger lane"
                steps={chronos2Steps}
              />
              <LaneSummary
                title="FinCast"
                subtitle="microbatch 4 / 8 / 16 · 출력 안정성"
                steps={fincastSteps}
              />
            </>
          )}
        </div> : null}

        {backendExperiment ? <BackendComparisonSummary experiment={backendExperiment} /> : null}
        {chronos2Experiment
          ? <Chronos2ComparisonSummary experiment={chronos2Experiment} />
          : null}
        {contextExperiment
          ? <ContextWindowSummary experiment={contextExperiment} />
          : null}
        {cadenceExperiment
          ? <CadenceContextSummary experiment={cadenceExperiment} />
          : null}
        {highVolExperiment
          ? <HighVolatilityProfitabilitySummary experiment={highVolExperiment} />
          : null}

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
            <Cpu className="size-3" /> CUDA {state.config.cudaCapability} · {backendExperiment
              ? "FP32 only · stateless routing"
              : highVolExperiment
                ? "Chronos-2 primary · FinCast veto · Rust quality · paper/backtest only"
              : cadenceExperiment
                ? "FinCast · Chronos-2 FP32 · 5/15/30/60초 · cross-learning off"
              : chronos2Experiment || contextExperiment
                ? "Chronos-2 FP32 · cross-learning off"
                : "BF16 미사용"}
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
      if (!response.ok) {
        let message = "검증 진행 상태를 불러오지 못했습니다.";
        try {
          const body: unknown = await response.json();
          if (body && typeof body === "object" && "error" in body) {
            const apiError = (body as { error?: unknown }).error;
            if (
              apiError
              && typeof apiError === "object"
              && "message" in apiError
              && typeof (apiError as { message?: unknown }).message === "string"
            ) {
              const detail = (apiError as { message: string }).message.trim();
              if (detail) message = detail.slice(0, 500);
            }
          }
        } catch {
          // A non-JSON proxy response still uses the safe localized fallback.
        }
        throw new Error(message);
      }
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
