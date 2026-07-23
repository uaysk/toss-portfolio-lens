import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  BarChart3,
  Bot,
  BrainCircuit,
  Clock,
  LoaderCircle,
  Play,
  ShieldCheck,
  Square,
  Wallet,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  DEFAULT_AI_SIMULATION_REQUEST,
  aiSimulationErrorMessage,
  normalizeAiSimulationRun,
  normalizeAiSimulationStatus,
  validateAiSimulationRequest,
  type AiSimulationCosts,
  type AiSimulationCriterion,
  type AiSimulationMarketCountry,
  type AiSimulationPreset,
  type AiSimulationRequest,
  type AiSimulationRunResponse,
  type AiSimulationSnapshot,
  type AiSimulationStatus,
} from "@/lib/ai-simulation";
import { formatMoney, formatQuantity } from "@/lib/format";
import { cn } from "@/lib/utils";

type AiSimulationProps = {
  onUnauthorized: () => void;
};

const ACTIVE_RUN_STATUSES = new Set(["queued", "running", "cancel_requested"]);
const COST_FIELDS: Array<{ key: keyof AiSimulationCosts; label: string }> = [
  { key: "commissionBpsPerSide", label: "편도 수수료" },
  { key: "taxBpsOnExit", label: "청산 세금" },
  { key: "spreadBpsRoundTrip", label: "왕복 스프레드" },
  { key: "slippageBpsPerSide", label: "편도 슬리피지" },
];

const CRITERION_LABELS: Record<AiSimulationCriterion, string> = {
  trading_amount: "거래대금",
  volume: "거래량",
  volatility: "변동성",
};

const PRESET_LABELS: Record<AiSimulationPreset, string> = {
  trend: "추세",
  breakout: "돌파",
  mean_reversion: "평균회귀",
  risk_management: "위험관리",
};

const PHASE_LABELS: Record<string, string> = {
  queued: "대기 중",
  selecting: "AI 종목 선정",
  candidate_selection: "AI 종목 선정",
  monitoring: "시뮬레이션 진행",
  running: "시뮬레이션 진행",
  liquidating: "가상 포지션 정리",
  completed: "완료",
  cancelled: "취소됨",
  cancel_requested: "취소 처리 중",
  failed: "실패",
};

const ACTION_LABELS: Record<string, string> = {
  buy: "가상 매수",
  sell: "가상 매도",
  hold: "보유 유지",
  watch: "관망",
  skip: "건너뜀",
  cash: "현금 유지",
};

async function readJson(response: Response): Promise<unknown> {
  return response.json().catch(() => ({}));
}

function formatTimestamp(value?: string): string {
  if (!value) return "unavailable";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "unavailable";
  return new Intl.DateTimeFormat("ko-KR", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function formatRatio(value?: number, signed = false): string {
  if (!Number.isFinite(value)) return "unavailable";
  const percent = (value as number) * 100;
  return `${signed && percent > 0 ? "+" : ""}${percent.toFixed(2)}%`;
}

function formatScore(value?: number): string {
  return Number.isFinite(value) ? (value as number).toFixed(3) : "unavailable";
}

function phaseLabel(value: string): string {
  return PHASE_LABELS[value] ?? value;
}

function actionLabel(value: string): string {
  return ACTION_LABELS[value.toLowerCase()] ?? value;
}

function capabilityLabel(key: string, value: boolean | number | string): string {
  return `${key} · ${typeof value === "boolean" ? (value ? "지원" : "미지원") : value}`;
}

function Metric({
  label,
  value,
  emphasis = false,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
}) {
  return (
    <div className="min-w-0 rounded-2xl bg-secondary p-4">
      <p className="text-[10px] font-black tracking-[0.08em] text-muted-foreground">{label}</p>
      <p className={cn("mt-2 truncate text-base font-black", emphasis && "text-xl tracking-[-0.04em]")}>{value}</p>
    </div>
  );
}

export function SimulationDisclosure() {
  return (
    <Card className="bg-secondary p-4 sm:p-5" data-simulation-disclosure role="note">
      <div className="flex items-start gap-3">
        <ShieldCheck className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
        <div>
          <p className="font-black">실주문 없음, 투자 지시 아님, 다음 유효 체결만.</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            AI의 종목 선정과 매수·매도 판단은 가상 원장에만 반영됩니다. 확정 분봉으로 내린 결정은 같은 봉 가격에 소급하지 않고 판단 이후의 다음 체결 또는 그보다 늦게 시작한 확정 분봉에서만 가상 체결할 수 있습니다.
          </p>
        </div>
      </div>
    </Card>
  );
}

function RuntimeStatus({ status, loading }: { status?: AiSimulationStatus; loading: boolean }) {
  if (loading) {
    return (
      <Card className="flex items-center gap-3 bg-secondary p-4 text-sm" role="status">
        <LoaderCircle className="size-4 animate-spin" />
        시뮬레이션 실행 환경 확인 중
      </Card>
    );
  }
  if (!status?.enabled) {
    return (
      <Card className="bg-secondary p-5" role="status" data-simulation-disabled>
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 size-5 shrink-0" />
          <div>
            <p className="font-black">AI 시뮬레이션을 시작할 수 없습니다.</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              {status?.message ?? "시장 데이터와 AI worker 상태를 확인해 주세요."}
            </p>
          </div>
        </div>
        {status?.limitations.length ? (
          <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-muted-foreground">
            {status.limitations.map((item) => <li key={item}>{item}</li>)}
          </ul>
        ) : null}
      </Card>
    );
  }
  const capabilities = Object.entries(status.capabilities);
  if (!capabilities.length && !status.limitations.length) return null;
  return (
    <div className="space-y-2" aria-label="시뮬레이션 기능 상태">
      {capabilities.length ? <div className="flex flex-wrap gap-2">{capabilities.map(([key, value]) => (
        <span key={key} className="rounded-full bg-secondary px-3 py-1.5 text-[10px] font-black text-muted-foreground">{capabilityLabel(key, value)}</span>
      ))}</div> : null}
      {status.limitations.length ? (
        <Card className="bg-secondary p-4">
          <ul className="list-disc space-y-1 pl-5 text-[10px] leading-4 text-muted-foreground">{status.limitations.map((item) => <li key={item}>{item}</li>)}</ul>
        </Card>
      ) : null}
    </div>
  );
}

function SelectedSymbols({ snapshot }: { snapshot: AiSimulationSnapshot }) {
  return (
    <Card className="bg-card p-5 sm:p-6" data-simulation-selected>
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-[10px] font-black tracking-[0.12em] text-muted-foreground">AI SELECTION</p>
          <h2 className="mt-1 text-lg font-black">AI 선정 종목</h2>
        </div>
        <span className="rounded-full bg-secondary px-3 py-1.5 text-[10px] font-black">
          {snapshot.selected.length} / 2
        </span>
      </div>
      {snapshot.selected.length ? (
        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          {snapshot.selected.map((item) => (
            <article key={item.symbol} className="min-w-0 rounded-2xl bg-secondary p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-base font-black">{item.name || item.symbol}</p>
                  <p className="mt-1 text-[10px] text-muted-foreground">{item.symbol}</p>
                </div>
                <span className="rounded-full bg-card px-2.5 py-1 text-[9px] font-black">score {formatScore(item.score)}</span>
              </div>
              <div className="mt-4 grid grid-cols-2 gap-2 text-xs">
                <div><p className="text-[9px] font-black text-muted-foreground">상승 확률</p><p className="mt-1 font-black">{formatRatio(item.upProbability)}</p></div>
                <div><p className="text-[9px] font-black text-muted-foreground">중앙 수익률</p><p className="mt-1 font-black">{formatRatio(item.predictedMedianReturn, true)}</p></div>
              </div>
              <p className="mt-3 truncate text-[9px] text-muted-foreground" title={item.model}>{item.model ?? "모델 provenance unavailable"}</p>
            </article>
          ))}
        </div>
      ) : (
        <p className="mt-4 rounded-2xl bg-secondary p-4 text-xs leading-5 text-muted-foreground">
          스캐너 후보를 평가하고 있습니다. 점수와 모델 예측이 검증된 종목만 최대 2개까지 표시합니다.
        </p>
      )}
    </Card>
  );
}

function Positions({ snapshot }: { snapshot: AiSimulationSnapshot }) {
  return (
    <Card className="bg-card p-5 sm:p-6" data-simulation-positions>
      <div>
        <p className="text-[10px] font-black tracking-[0.12em] text-muted-foreground">VIRTUAL LEDGER</p>
        <h2 className="mt-1 text-lg font-black">가상 포지션</h2>
      </div>
      {snapshot.positions.length ? (
        <div className="mt-4 space-y-2">
          {snapshot.positions.map((position) => (
            <article key={position.symbol} className="grid gap-3 rounded-2xl bg-secondary p-4 sm:grid-cols-[1fr_auto] sm:items-center">
              <div>
                <p className="font-black">{position.symbol}</p>
                <p className="mt-1 text-[10px] text-muted-foreground">
                  {formatQuantity(position.quantity)}주 · 평균 {formatMoney(position.averagePrice, snapshot.currency)}
                </p>
              </div>
              <div className="sm:text-right">
                <p className="text-xs font-black">
                  {position.marketPrice === undefined ? "현재가 unavailable" : formatMoney(position.marketPrice, snapshot.currency)}
                </p>
                <p className={cn("mt-1 text-[10px]", (position.unrealizedPnl ?? 0) >= 0 ? "text-foreground" : "text-muted-foreground")}>
                  평가손익 {position.unrealizedPnl === undefined ? "unavailable" : formatMoney(position.unrealizedPnl, snapshot.currency)}
                </p>
              </div>
            </article>
          ))}
        </div>
      ) : <p className="mt-4 text-xs text-muted-foreground">현재 가상 보유 종목이 없습니다.</p>}
    </Card>
  );
}

function TradesAndDecisions({ snapshot }: { snapshot: AiSimulationSnapshot }) {
  const trades = [...snapshot.trades].reverse().slice(0, 20);
  const decisions = [...snapshot.decisions].reverse().slice(0, 20);
  return (
    <div className="grid gap-3 xl:grid-cols-2">
      <Card className="min-w-0 bg-card p-5 sm:p-6" data-simulation-trades>
        <div className="flex items-center justify-between gap-3">
          <div><p className="text-[10px] font-black tracking-[0.12em] text-muted-foreground">FILLS</p><h2 className="mt-1 text-lg font-black">가상 체결</h2></div>
          <span className="text-[10px] font-black text-muted-foreground">{snapshot.trades.length}건</span>
        </div>
        {trades.length ? (
          <div className="mt-4 space-y-2">
            {trades.map((trade, index) => (
              <article key={`${trade.symbol}:${trade.executedAt}:${index}`} className="rounded-2xl bg-secondary p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-black">{trade.symbol} · {trade.side.toLowerCase() === "buy" ? "가상 매수" : trade.side.toLowerCase() === "sell" ? "가상 매도" : trade.side}</p>
                  <p className="text-[9px] text-muted-foreground">{formatTimestamp(trade.executedAt)}</p>
                </div>
                <p className="mt-2 text-xs">
                  {formatQuantity(trade.quantity)}주 × {formatMoney(trade.price, snapshot.currency)} · {formatMoney(trade.amount, snapshot.currency)}
                </p>
                <p className="mt-1 text-[9px] text-muted-foreground">
                  비용 {formatMoney(trade.cost, snapshot.currency)} · {trade.source ?? "체결 source unavailable"}
                </p>
              </article>
            ))}
          </div>
        ) : <p className="mt-4 text-xs text-muted-foreground">아직 가상 체결이 없습니다.</p>}
      </Card>

      <Card className="min-w-0 bg-card p-5 sm:p-6" data-simulation-decisions>
        <div className="flex items-center justify-between gap-3">
          <div><p className="text-[10px] font-black tracking-[0.12em] text-muted-foreground">DECISIONS</p><h2 className="mt-1 text-lg font-black">AI 판단 기록</h2></div>
          <span className="text-[10px] font-black text-muted-foreground">{snapshot.decisions.length}건</span>
        </div>
        {decisions.length ? (
          <div className="mt-4 space-y-2">
            {decisions.map((decision, index) => (
              <article key={`${decision.symbol}:${decision.decidedAt}:${index}`} className="rounded-2xl bg-secondary p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-black">{decision.symbol} · {actionLabel(decision.action)}</p>
                  <p className="text-[9px] text-muted-foreground">{formatTimestamp(decision.decidedAt)}</p>
                </div>
                <p className="mt-2 break-words text-xs leading-5">{decision.reason}</p>
                <p className="mt-2 text-[9px] text-muted-foreground">
                  적용 가능 {formatTimestamp(decision.eligibleAfter)} · score {formatScore(decision.score)} · 상승 {formatRatio(decision.upProbability)}
                </p>
                {decision.model ? <p className="mt-1 truncate text-[9px] text-muted-foreground" title={decision.model}>{decision.model}</p> : null}
              </article>
            ))}
          </div>
        ) : <p className="mt-4 text-xs text-muted-foreground">AI 판단을 기다리고 있습니다.</p>}
      </Card>
    </div>
  );
}

function RunPanel({
  run,
  cancelling,
  onCancel,
}: {
  run: AiSimulationRunResponse;
  cancelling: boolean;
  onCancel: () => void;
}) {
  const snapshot = run.snapshot;
  if (!snapshot) {
    const active = ACTIVE_RUN_STATUSES.has(run.status);
    return (
      <Card className="flex min-h-40 items-center justify-center bg-secondary p-6 text-center" data-simulation-run role="status">
        <div>
          {active ? <LoaderCircle className="mx-auto size-5 animate-spin" /> : <AlertTriangle className="mx-auto size-5" />}
          <p className="mt-3 text-sm font-black">{active ? "가상 원장을 준비하고 있습니다." : `시뮬레이션이 ${phaseLabel(run.status)} 상태로 종료되었습니다.`}</p>
          <p className="mt-1 text-[10px] text-muted-foreground">{run.error ?? `run ${run.runId ?? "ID unavailable"}`}</p>
        </div>
      </Card>
    );
  }
  const pnl = snapshot.equity - snapshot.initialCash;
  const returnRatio = snapshot.initialCash > 0 ? pnl / snapshot.initialCash : undefined;
  const active = ACTIVE_RUN_STATUSES.has(run.status);

  return (
    <div className="space-y-3" data-simulation-run={run.runId ?? "unknown"}>
      <Card className="overflow-hidden bg-primary p-5 text-primary-foreground sm:p-7">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-primary-foreground/10 px-3 py-1.5 text-[10px] font-black">{phaseLabel(snapshot.phase)}</span>
              <span className="text-[10px] text-primary-foreground/60">run {run.runId ?? "ID unavailable"}</span>
            </div>
            <p className="mt-5 text-[10px] font-black tracking-[0.12em] text-primary-foreground/60">VIRTUAL EQUITY</p>
            <p className="mt-1 text-[clamp(2rem,5vw,4.5rem)] font-black tracking-[-0.07em]">{formatMoney(snapshot.equity, snapshot.currency)}</p>
            <p className="mt-2 text-sm font-black">
              {pnl >= 0 ? "+" : ""}{formatMoney(pnl, snapshot.currency)} · {formatRatio(returnRatio, true)}
            </p>
          </div>
          <div className="grid grid-cols-2 gap-2 text-sm lg:min-w-[320px]">
            <div className="rounded-2xl bg-primary-foreground/10 p-4"><p className="text-[9px] font-black text-primary-foreground/50">가상 예수금</p><p className="mt-2 font-black">{formatMoney(snapshot.cash, snapshot.currency)}</p></div>
            <div className="rounded-2xl bg-primary-foreground/10 p-4"><p className="text-[9px] font-black text-primary-foreground/50">진행률</p><p className="mt-2 font-black">{(snapshot.progress * 100).toFixed(0)}%</p></div>
            <div className="col-span-2 rounded-2xl bg-primary-foreground/10 p-4 text-[10px] text-primary-foreground/70">
              <p>시작 {formatTimestamp(snapshot.startedAt)}</p>
              <p className="mt-1">종료 예정 {formatTimestamp(snapshot.expiresAt)}</p>
            </div>
          </div>
        </div>
        <div className="mt-5 h-1.5 overflow-hidden rounded-full bg-primary-foreground/10" aria-label={`진행률 ${(snapshot.progress * 100).toFixed(0)}%`}>
          <div className="h-full rounded-full bg-primary-foreground transition-[width]" style={{ width: `${snapshot.progress * 100}%` }} />
        </div>
        {active ? (
          <div className="mt-5 flex justify-end">
            <Button type="button" variant="quiet" onClick={onCancel} disabled={cancelling}>
              {cancelling ? <LoaderCircle className="animate-spin" /> : <Square />}
              시뮬레이션 취소
            </Button>
          </div>
        ) : null}
      </Card>

      <div className="grid gap-3 xl:grid-cols-2">
        <SelectedSymbols snapshot={snapshot} />
        <Positions snapshot={snapshot} />
      </div>
      <TradesAndDecisions snapshot={snapshot} />
      {snapshot.warnings.length ? (
        <Card className="bg-secondary p-5" role="status">
          <div className="flex items-center gap-2"><AlertTriangle className="size-4" /><p className="text-sm font-black">데이터·실행 경고</p></div>
          <ul className="mt-3 list-disc space-y-1 pl-5 text-xs leading-5 text-muted-foreground">
            {snapshot.warnings.map((warning) => <li key={warning}>{warning}</li>)}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}

export function AiSimulation({ onUnauthorized }: AiSimulationProps) {
  const [request, setRequest] = useState<AiSimulationRequest>(DEFAULT_AI_SIMULATION_REQUEST);
  const [status, setStatus] = useState<AiSimulationStatus>();
  const [statusLoading, setStatusLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState("");
  const [run, setRun] = useState<AiSimulationRunResponse>();

  const issues = useMemo(
    () => validateAiSimulationRequest(request, status?.limits),
    [request, status?.limits],
  );
  const runActive = Boolean(run && ACTIVE_RUN_STATUSES.has(run.status));

  useEffect(() => {
    const controller = new AbortController();
    const loadStatus = async () => {
      try {
        const response = await fetch("/api/portfolio/simulation/status", {
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
        const payload = await readJson(response);
        if (response.status === 401) {
          onUnauthorized();
          return;
        }
        if (!response.ok) throw new Error(aiSimulationErrorMessage(payload, "시뮬레이션 실행 환경을 확인하지 못했습니다."));
        const nextStatus = normalizeAiSimulationStatus(payload);
        if (!controller.signal.aborted) setStatus(nextStatus);
        if (nextStatus.enabled) {
          const currentResponse = await fetch("/api/portfolio/simulation/runs/current", {
            headers: { Accept: "application/json" },
            signal: controller.signal,
          });
          const currentPayload = await readJson(currentResponse);
          if (currentResponse.status === 401) {
            onUnauthorized();
            return;
          }
          if (currentResponse.ok && currentPayload
            && typeof currentPayload === "object"
            && (currentPayload as { run?: unknown }).run
            && !controller.signal.aborted) {
            setRun(normalizeAiSimulationRun(currentPayload));
          } else if (!currentResponse.ok) {
            throw new Error(aiSimulationErrorMessage(currentPayload, "최근 시뮬레이션을 복원하지 못했습니다."));
          }
        }
      } catch (caught) {
        if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : "시뮬레이션 실행 환경을 확인하지 못했습니다.");
      } finally {
        if (!controller.signal.aborted) setStatusLoading(false);
      }
    };
    void loadStatus();
    return () => controller.abort();
  }, [onUnauthorized]);

  useEffect(() => {
    const runId = run?.runId;
    if (!runId) return;
    const controller = new AbortController();
    let timer: number | undefined;
    const poll = async () => {
      try {
        const response = await fetch(`/api/portfolio/simulation/runs/${encodeURIComponent(runId)}`, {
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
        const payload = await readJson(response);
        if (response.status === 401) {
          onUnauthorized();
          return;
        }
        if (!response.ok) throw new Error(aiSimulationErrorMessage(payload, "시뮬레이션 상태를 불러오지 못했습니다."));
        const next = normalizeAiSimulationRun(payload);
        if (controller.signal.aborted) return;
        setError("");
        setRun({ ...next, runId: next.runId ?? runId });
        if (ACTIVE_RUN_STATUSES.has(next.status)) timer = window.setTimeout(() => void poll(), 1_000);
      } catch (caught) {
        if (controller.signal.aborted) return;
        setError(caught instanceof Error ? caught.message : "시뮬레이션 상태를 불러오지 못했습니다.");
        timer = window.setTimeout(() => void poll(), 2_500);
      }
    };
    timer = window.setTimeout(() => void poll(), 800);
    return () => {
      controller.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [run?.runId, onUnauthorized]);

  const startSimulation = useCallback(async () => {
    const validation = validateAiSimulationRequest(request, status?.limits);
    if (validation.length) {
      setError(validation[0]);
      return;
    }
    setStarting(true);
    setError("");
    try {
      const response = await fetch("/api/portfolio/simulation/runs", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });
      const payload = await readJson(response);
      if (response.status === 401) {
        onUnauthorized();
        return;
      }
      if (!response.ok) throw new Error(aiSimulationErrorMessage(payload, "AI 시뮬레이션을 시작하지 못했습니다."));
      const next = normalizeAiSimulationRun(payload);
      if (!next.runId) throw new Error("시뮬레이션 응답에 run ID가 없습니다.");
      setRun(next);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "AI 시뮬레이션을 시작하지 못했습니다.");
    } finally {
      setStarting(false);
    }
  }, [onUnauthorized, request, status?.limits]);

  const cancelSimulation = useCallback(async () => {
    if (!run?.runId) return;
    setCancelling(true);
    setError("");
    try {
      const response = await fetch(`/api/portfolio/simulation/runs/${encodeURIComponent(run.runId)}/cancel`, {
        method: "POST",
        headers: { Accept: "application/json" },
      });
      const payload = await readJson(response);
      if (response.status === 401) {
        onUnauthorized();
        return;
      }
      if (!response.ok) throw new Error(aiSimulationErrorMessage(payload, "시뮬레이션을 취소하지 못했습니다."));
      const next = normalizeAiSimulationRun(payload);
      setRun({ ...next, runId: next.runId ?? run.runId });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "시뮬레이션을 취소하지 못했습니다.");
    } finally {
      setCancelling(false);
    }
  }, [onUnauthorized, run?.runId]);

  const changeMarket = (marketCountry: AiSimulationMarketCountry) => {
    setRequest((current) => {
      const switchingToUsDefaults = current.marketCountry === "KR" && marketCountry === "US"
        && current.initialCash === DEFAULT_AI_SIMULATION_REQUEST.initialCash;
      const switchingToKrDefaults = current.marketCountry === "US" && marketCountry === "KR"
        && current.initialCash === 100_000;
      const usingDefaultTax = current.costs.taxBpsOnExit === (current.marketCountry === "KR" ? 18 : 0);
      return {
        ...current,
        marketCountry,
        initialCash: switchingToUsDefaults ? 100_000 : switchingToKrDefaults ? DEFAULT_AI_SIMULATION_REQUEST.initialCash : current.initialCash,
        costs: {
          ...current.costs,
          taxBpsOnExit: usingDefaultTax ? (marketCountry === "KR" ? 18 : 0) : current.costs.taxBpsOnExit,
        },
      };
    });
  };

  const currency = request.marketCountry === "US" ? "USD" : "KRW";

  return (
    <section className="space-y-3" data-ai-simulation>
      <Card className="overflow-hidden bg-primary p-6 text-primary-foreground sm:p-8">
        <div className="grid gap-7 lg:grid-cols-[1.2fr_0.8fr] lg:items-end">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full bg-primary-foreground/10 px-3 py-2 text-[10px] font-black">
              <Bot className="size-4" />
              PAPER TRADING ONLY
            </div>
            <h2 className="mt-6 max-w-3xl text-[clamp(2rem,5vw,4.7rem)] font-black leading-[0.95] tracking-[-0.07em]">
              AI가 고르고,<br />가상 원장으로 검증합니다.
            </h2>
            <p className="mt-5 max-w-2xl text-sm leading-6 text-primary-foreground/60">
              현재 스캐너 후보를 AI가 평가해 1~2개 종목만 선정합니다. 사용자가 정한 예수금과 시간 동안 기술 신호와 공개 모델 예측을 함께 보되, 자금과 주문은 외부로 전송하지 않습니다.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-2xl bg-primary-foreground/10 p-4"><BrainCircuit className="size-4" /><p className="mt-4 text-[10px] font-black text-primary-foreground/50">종목 선정</p><p className="mt-1 text-sm font-black">AI · 최대 2개</p></div>
            <div className="rounded-2xl bg-primary-foreground/10 p-4"><Clock className="size-4" /><p className="mt-4 text-[10px] font-black text-primary-foreground/50">신호 적용</p><p className="mt-1 text-sm font-black">다음 유효 체결</p></div>
            <div className="rounded-2xl bg-primary-foreground/10 p-4"><Wallet className="size-4" /><p className="mt-4 text-[10px] font-black text-primary-foreground/50">자금</p><p className="mt-1 text-sm font-black">가상 예수금</p></div>
            <div className="rounded-2xl bg-primary-foreground/10 p-4"><BarChart3 className="size-4" /><p className="mt-4 text-[10px] font-black text-primary-foreground/50">성과</p><p className="mt-1 text-sm font-black">비용 차감 원장</p></div>
          </div>
        </div>
      </Card>

      <SimulationDisclosure />
      <RuntimeStatus status={status} loading={statusLoading} />

      <Card className="bg-card p-5 sm:p-7">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-[10px] font-black tracking-[0.12em] text-muted-foreground">SIMULATION SETUP</p>
            <h2 className="mt-1 text-xl font-black">테스트 설정</h2>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">시작 버튼을 눌러야만 후보 스캔과 AI 판단이 시작됩니다.</p>
          </div>
          <span className="rounded-full bg-secondary px-3 py-1.5 text-[10px] font-black">
            {request.symbolCount}종목 · {request.durationMinutes}분 · {currency}
          </span>
        </div>

        <form className="mt-5 space-y-4" onSubmit={(event) => { event.preventDefault(); void startSimulation(); }}>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <label className="min-w-0 rounded-2xl bg-secondary p-3">
              <span className="mb-2 block text-[10px] font-black text-muted-foreground">대상 시장</span>
              <Select value={request.marketCountry} onValueChange={(value) => changeMarket(value as AiSimulationMarketCountry)} disabled={runActive}>
                <SelectTrigger aria-label="시뮬레이션 대상 시장" className="w-full min-w-0 bg-card"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="KR">국내</SelectItem>
                  <SelectItem value="US">미국</SelectItem>
                </SelectContent>
              </Select>
            </label>
            <label className="min-w-0 rounded-2xl bg-secondary p-3">
              <span className="mb-2 block text-[10px] font-black text-muted-foreground">AI 후보 기준</span>
              <Select value={request.criterion} onValueChange={(value) => setRequest((current) => ({ ...current, criterion: value as AiSimulationCriterion }))} disabled={runActive}>
                <SelectTrigger aria-label="AI 종목 선정 기준" className="w-full min-w-0 bg-card"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(CRITERION_LABELS).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}
                </SelectContent>
              </Select>
            </label>
            <label className="min-w-0 rounded-2xl bg-secondary p-3">
              <span className="mb-2 block text-[10px] font-black text-muted-foreground">선정 종목 수</span>
              <Select value={String(request.symbolCount)} onValueChange={(value) => setRequest((current) => ({ ...current, symbolCount: Number(value) as 1 | 2 }))} disabled={runActive}>
                <SelectTrigger aria-label="AI 선정 종목 수" className="w-full min-w-0 bg-card"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">1종목</SelectItem>
                  <SelectItem value="2">2종목</SelectItem>
                </SelectContent>
              </Select>
              <span className="mt-2 block text-[9px] text-muted-foreground">AI는 1종목 또는 2종목만 선정합니다.</span>
            </label>
            <label className="min-w-0 rounded-2xl bg-secondary p-3">
              <span className="mb-2 block text-[10px] font-black text-muted-foreground">판단 프리셋</span>
              <Select value={request.preset} onValueChange={(value) => setRequest((current) => ({ ...current, preset: value as AiSimulationPreset }))} disabled={runActive}>
                <SelectTrigger aria-label="AI 판단 프리셋" className="w-full min-w-0 bg-card"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(PRESET_LABELS).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}
                </SelectContent>
              </Select>
            </label>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="rounded-2xl bg-secondary p-3">
              <span className="mb-2 block text-[10px] font-black text-muted-foreground">시작 예수금 · {currency}</span>
              <Input
                aria-label="시작 예수금"
                type="number"
                min={status?.limits.minimumInitialCash ?? 0.01}
                max={status?.limits.maximumInitialCash}
                step={request.marketCountry === "KR" ? 10_000 : 100}
                value={request.initialCash}
                disabled={runActive}
                onChange={(event) => setRequest((current) => ({ ...current, initialCash: Number(event.target.value) }))}
                className="bg-card"
              />
            </label>
            <label className="rounded-2xl bg-secondary p-3">
              <span className="mb-2 block text-[10px] font-black text-muted-foreground">테스트 기간 · 분</span>
              <Input
                aria-label="테스트 기간"
                type="number"
                min={status?.limits.minimumDurationMinutes ?? 1}
                max={status?.limits.maximumDurationMinutes}
                step={1}
                value={request.durationMinutes}
                disabled={runActive}
                onChange={(event) => setRequest((current) => ({ ...current, durationMinutes: Number(event.target.value) }))}
                className="bg-card"
              />
            </label>
          </div>

          <details className="rounded-2xl bg-secondary p-4">
            <summary className="cursor-pointer text-xs font-black">비용 가정 · bps</summary>
            <p className="mt-2 text-[10px] leading-4 text-muted-foreground">수수료·세금·스프레드·슬리피지를 가상 체결 원장에서 차감합니다. 실제 계약과 시장에 맞게 직접 조정하세요.</p>
            <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
              {COST_FIELDS.map(({ key, label }) => (
                <label key={key} className="rounded-2xl bg-card p-3">
                  <span className="mb-2 block text-[9px] font-black text-muted-foreground">{label}</span>
                  <Input
                    aria-label={`${label} bps`}
                    type="number"
                    min={0}
                    step={0.1}
                    value={request.costs[key]}
                    disabled={runActive}
                    onChange={(event) => setRequest((current) => ({
                      ...current,
                      costs: { ...current.costs, [key]: Number(event.target.value) },
                    }))}
                    className="h-10 bg-secondary text-xs"
                  />
                </label>
              ))}
            </div>
          </details>

          {issues.length ? (
            <ul className="rounded-2xl bg-destructive/10 p-4 text-xs text-destructive" role="alert">
              {issues.map((issue) => <li key={issue}>{issue}</li>)}
            </ul>
          ) : null}
          {error ? <p className="rounded-2xl bg-destructive/10 p-4 text-xs text-destructive" role="alert">{error}</p> : null}

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-[10px] leading-4 text-muted-foreground">
              AI 출력이 unavailable이면 임의 판단이나 체결을 만들지 않습니다. 진행 중인 run 설정은 변경할 수 없습니다.
            </p>
            <Button type="submit" size="lg" disabled={statusLoading || !status?.enabled || issues.length > 0 || starting || runActive}>
              {starting ? <LoaderCircle className="animate-spin" /> : <Play />}
              AI 시뮬레이션 시작
            </Button>
          </div>
        </form>
      </Card>

      {run ? (
        <RunPanel run={run} cancelling={cancelling} onCancel={() => void cancelSimulation()} />
      ) : (
        <Card className="grid min-h-48 place-items-center bg-secondary p-6 text-center" data-simulation-empty>
          <div>
            <Bot className="mx-auto size-6" />
            <p className="mt-3 text-sm font-black">아직 실행한 시뮬레이션이 없습니다.</p>
            <p className="mt-1 text-xs text-muted-foreground">설정을 확인한 뒤 시작 버튼을 누르세요.</p>
          </div>
        </Card>
      )}
    </section>
  );
}
