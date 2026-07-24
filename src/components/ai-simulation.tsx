import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  BarChart3,
  Bot,
  BrainCircuit,
  Check,
  Clock,
  LoaderCircle,
  Plus,
  Play,
  Search,
  ShieldCheck,
  Square,
  Wallet,
  X,
} from "lucide-react";
import { AiSimulationChart } from "@/components/ai-simulation-chart";
import { AiSimulationHistory } from "@/components/ai-simulation-history";
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
import {
  searchTechnicalInstruments,
  TechnicalAnalysisApiError,
} from "@/lib/technical-analysis-api";
import type { TechnicalInstrumentChoice } from "@/lib/technical-analysis";
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

const PRESET_DETAILS: Record<AiSimulationPreset, {
  label: string;
  description: string;
  recommendedRisk: number;
}> = {
  trend: {
    label: "추세 수익",
    description: "EMA·MACD·ADX로 상승 추세를 따라 현금에서 진입합니다.",
    recommendedRisk: 60,
  },
  breakout: {
    label: "돌파 가속",
    description: "거래량과 가격 돌파를 빠르게 포착하는 가장 공격적인 구성입니다.",
    recommendedRisk: 80,
  },
  mean_reversion: {
    label: "반등 수익",
    description: "과매도·밴드 이탈 뒤 상승 반전 패턴을 확인해 진입합니다.",
    recommendedRisk: 50,
  },
  risk_management: {
    label: "방어 수익",
    description: "현금 비중을 남기고 더 강한 AI·기술 확인 뒤 기회를 취합니다.",
    recommendedRisk: 25,
  },
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
  finalizing: "종료 처리 중",
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

const PATTERN_LABELS: Record<string, string> = {
  bullish_engulfing: "상승 장악형",
  bearish_engulfing: "하락 장악형",
  hammer: "망치형",
  shooting_star: "유성형",
  inside_bar: "인사이드 바",
  bullish_outside_bar: "상승 아웃사이드 바",
  bearish_outside_bar: "하락 아웃사이드 바",
};

function requestedSymbolCount(request: AiSimulationRequest): number {
  return request.selection.mode === "manual"
    ? request.selection.symbols.length
    : request.selection.symbolCount;
}

function selectionModeLabel(request: AiSimulationRequest): string {
  return request.selection.mode === "manual" ? "직접 선택" : "자동 선정";
}

function riskDispositionLabel(value: number): string {
  if (value <= 33) return "방어";
  if (value >= 67) return "공격";
  return "균형";
}

function chartPatternLabel(value: string): string {
  return PATTERN_LABELS[value] ?? value.replaceAll("_", " ");
}

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
          <p className="text-[10px] font-black tracking-[0.12em] text-muted-foreground">SIMULATION UNIVERSE</p>
          <h2 className="mt-1 text-lg font-black">
            {snapshot.selection?.mode === "manual" ? "직접 선택 종목" : "AI 선정 종목"}
          </h2>
        </div>
        <span className="rounded-full bg-secondary px-3 py-1.5 text-[10px] font-black">
          {snapshot.selected.length} / {snapshot.selection?.mode === "manual"
            ? snapshot.selection.symbols.length
            : snapshot.selection?.symbolCount ?? 2}
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
              {item.currentPrice !== undefined ? (
                <div className="mt-3 rounded-xl bg-card p-3" data-simulation-selected-live-price={item.symbol}>
                  <p className="text-[9px] font-black text-muted-foreground">최근 시장가</p>
                  <p className="mt-1 text-xs font-black">{formatMoney(item.currentPrice, snapshot.currency)}</p>
                  <p className="mt-1 text-[8px] text-muted-foreground">갱신 {formatTimestamp(item.priceObservedAt)}</p>
                </div>
              ) : null}
              <p className="mt-3 truncate text-[9px] text-muted-foreground" title={item.model}>{item.model ?? "모델 provenance unavailable"}</p>
            </article>
          ))}
        </div>
      ) : (
        <p className="mt-4 rounded-2xl bg-secondary p-4 text-xs leading-5 text-muted-foreground">
          {snapshot.selection?.mode === "manual"
            ? "선택한 종목의 AI 예측과 시장 데이터를 검증하고 있습니다."
            : "스캐너 후보를 평가하고 있습니다. 점수와 모델 예측이 검증된 종목만 최대 2개까지 표시합니다."}
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

export function TradesAndDecisions({ snapshot }: { snapshot: AiSimulationSnapshot }) {
  const trades = [...snapshot.trades].reverse();
  const decisions = [...snapshot.decisions].reverse();
  return (
    <div className="grid gap-3 xl:grid-cols-2">
      <Card className="min-w-0 bg-card p-5 sm:p-6" data-simulation-trades>
        <div className="flex items-center justify-between gap-3">
          <div><p className="text-[10px] font-black tracking-[0.12em] text-muted-foreground">FILLS</p><h2 className="mt-1 text-lg font-black">가상 체결</h2></div>
          <span className="text-[10px] font-black text-muted-foreground">{snapshot.trades.length}건</span>
        </div>
        <div
          className="mt-4 max-h-[28rem] min-h-0 overflow-y-auto overscroll-contain pr-1"
          data-simulation-trades-scroll
          tabIndex={0}
          aria-label="가상 체결 스크롤 목록"
        >
          {trades.length ? (
          <div className="space-y-2">
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
          ) : <p className="text-xs text-muted-foreground">아직 가상 체결이 없습니다.</p>}
        </div>
      </Card>

      <Card className="min-w-0 bg-card p-5 sm:p-6" data-simulation-decisions>
        <div className="flex items-center justify-between gap-3">
          <div><p className="text-[10px] font-black tracking-[0.12em] text-muted-foreground">DECISIONS</p><h2 className="mt-1 text-lg font-black">AI 판단 기록</h2></div>
          <span className="text-[10px] font-black text-muted-foreground">{snapshot.decisions.length}건</span>
        </div>
        <div
          className="mt-4 max-h-[28rem] min-h-0 overflow-y-auto overscroll-contain pr-1"
          data-simulation-decisions-scroll
          tabIndex={0}
          aria-label="AI 판단 기록 스크롤 목록"
        >
          {decisions.length ? (
          <div className="space-y-2">
            {decisions.map((decision, index) => (
              <article key={`${decision.symbol}:${decision.decidedAt}:${index}`} className="rounded-2xl bg-secondary p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-black">{decision.symbol} · {actionLabel(decision.action)}</p>
                  <p className="text-[9px] text-muted-foreground">{formatTimestamp(decision.decidedAt)}</p>
                </div>
                <p className="mt-2 break-words text-xs leading-5">{decision.reason}</p>
                {decision.chartPatterns.length ? (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {decision.chartPatterns.map((pattern) => (
                      <span
                        key={pattern}
                        className={cn(
                          "rounded-full px-2 py-1 text-[9px] font-black",
                          decision.chartPatternBias === "bullish"
                            ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                            : decision.chartPatternBias === "bearish"
                              ? "bg-rose-500/10 text-rose-700 dark:text-rose-300"
                              : "bg-card text-muted-foreground",
                        )}
                      >
                        {chartPatternLabel(pattern)}
                      </span>
                    ))}
                  </div>
                ) : null}
                <p className="mt-2 text-[9px] text-muted-foreground">
                  적용 가능 {formatTimestamp(decision.eligibleAfter)} · score {formatScore(decision.score)} · 상승 {formatRatio(decision.upProbability)}
                </p>
                {decision.model ? <p className="mt-1 truncate text-[9px] text-muted-foreground" title={decision.model}>{decision.model}</p> : null}
              </article>
            ))}
          </div>
          ) : <p className="text-xs text-muted-foreground">AI 판단을 기다리고 있습니다.</p>}
        </div>
      </Card>
    </div>
  );
}

export function simulationDecisionCadenceLabel(trigger?: string): string {
  return trigger === "finalized_one_minute_bar"
    ? "새 확정 1분봉 즉시"
    : "확정봉 이벤트 즉시";
}

function RunPanel({
  run,
}: {
  run: AiSimulationRunResponse;
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

  return (
    <div className="space-y-3" data-simulation-run={run.runId ?? "unknown"}>
      <Card className="overflow-hidden bg-primary p-5 text-primary-foreground sm:p-7">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span
                className="rounded-full bg-primary-foreground/10 px-3 py-1.5 text-[10px] font-black"
                role="status"
                aria-live="polite"
              >
                {phaseLabel(snapshot.phase)}
              </span>
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
              <p className="mt-1">
                판단 {simulationDecisionCadenceLabel(snapshot.decisionCadence?.trigger)}
                {snapshot.decisionCadence?.triggeredEvents !== undefined
                  ? ` · ${snapshot.decisionCadence.triggeredEvents}회`
                  : ""}
              </p>
            </div>
          </div>
        </div>
        <div className="mt-5 h-1.5 overflow-hidden rounded-full bg-primary-foreground/10" aria-label={`진행률 ${(snapshot.progress * 100).toFixed(0)}%`}>
          <div className="h-full rounded-full bg-primary-foreground transition-[width]" style={{ width: `${snapshot.progress * 100}%` }} />
        </div>
        <div className="mt-4 flex flex-wrap gap-2 text-[9px] font-black text-primary-foreground/70">
          <span className="rounded-full bg-primary-foreground/10 px-3 py-1.5">보유 0주 · 현금 100% 시작</span>
          {snapshot.preset ? <span className="rounded-full bg-primary-foreground/10 px-3 py-1.5">{PRESET_DETAILS[snapshot.preset].label}</span> : null}
          {snapshot.riskTolerance !== undefined ? (
            <span className="rounded-full bg-primary-foreground/10 px-3 py-1.5">
              {riskDispositionLabel(snapshot.riskTolerance)} {snapshot.riskTolerance}
            </span>
          ) : null}
          {snapshot.policyProfile?.targetAllocationRate !== undefined ? (
            <span className="rounded-full bg-primary-foreground/10 px-3 py-1.5">
              목표 투자 {(snapshot.policyProfile.targetAllocationRate * 100).toFixed(0)}% · 현금 {((snapshot.policyProfile.cashReserveRate ?? 1 - snapshot.policyProfile.targetAllocationRate) * 100).toFixed(0)}%
            </span>
          ) : null}
        </div>
      </Card>

      <div className="grid gap-3 xl:grid-cols-2">
        <SelectedSymbols snapshot={snapshot} />
        <Positions snapshot={snapshot} />
      </div>
      {snapshot.charts.length ? (
        <div className="grid gap-3 xl:grid-cols-2" data-simulation-charts>
          {snapshot.charts.map((chart) => (
            <AiSimulationChart
              key={chart.symbol}
              symbol={chart.symbol}
              name={chart.name}
              currency={chart.currency}
              bars={chart.bars}
              indicators={chart.indicators}
              patterns={chart.patterns}
              updatedAt={chart.updatedAt}
              trades={snapshot.trades.flatMap((trade) => {
                if (trade.symbol !== chart.symbol) return [];
                const side = trade.side.toLowerCase();
                if (side !== "buy" && side !== "sell") return [];
                return [{
                  executedAt: trade.executedAt,
                  price: trade.price,
                  side,
                  quantity: trade.quantity,
                }];
              })}
            />
          ))}
        </div>
      ) : null}
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
  const [manualInstruments, setManualInstruments] = useState<TechnicalInstrumentChoice[]>([]);
  const [instrumentQuery, setInstrumentQuery] = useState("");
  const [instrumentResults, setInstrumentResults] = useState<TechnicalInstrumentChoice[]>([]);
  const [instrumentSearching, setInstrumentSearching] = useState(false);
  const [instrumentError, setInstrumentError] = useState("");
  const cancellingRef = useRef(false);
  const pollingGeneration = useRef(0);

  const issues = useMemo(
    () => validateAiSimulationRequest(request, status?.limits),
    [request, status?.limits],
  );
  const runActive = Boolean(run && ACTIVE_RUN_STATUSES.has(run.status));

  useEffect(() => {
    const query = instrumentQuery.trim();
    if (request.selection.mode !== "manual" || query.length < 1 || runActive) {
      setInstrumentResults([]);
      setInstrumentSearching(false);
      setInstrumentError("");
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setInstrumentSearching(true);
      setInstrumentError("");
      void searchTechnicalInstruments(query, { signal: controller.signal })
        .then((results) => {
          if (controller.signal.aborted) return;
          const currency = request.marketCountry === "US" ? "USD" : "KRW";
          const selected = new Set(manualInstruments.map(({ symbol }) => symbol));
          setInstrumentResults(
            results
              .filter((instrument) => instrument.currency === currency && !selected.has(instrument.symbol))
              .slice(0, 8),
          );
        })
        .catch((caught) => {
          if (controller.signal.aborted) return;
          if (caught instanceof TechnicalAnalysisApiError && caught.status === 401) {
            onUnauthorized();
            return;
          }
          setInstrumentError(caught instanceof Error ? caught.message : "종목을 검색하지 못했습니다.");
          setInstrumentResults([]);
        })
        .finally(() => {
          if (!controller.signal.aborted) setInstrumentSearching(false);
        });
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [
    instrumentQuery,
    manualInstruments,
    onUnauthorized,
    request.marketCountry,
    request.selection.mode,
    runActive,
  ]);

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
    if (!runId || !runActive || cancelling) return;
    const generation = ++pollingGeneration.current;
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
        if (controller.signal.aborted || generation !== pollingGeneration.current) return;
        setError("");
        setRun({ ...next, runId: next.runId ?? runId });
        if (ACTIVE_RUN_STATUSES.has(next.status)) timer = window.setTimeout(() => void poll(), 500);
      } catch (caught) {
        if (controller.signal.aborted || generation !== pollingGeneration.current) return;
        setError(caught instanceof Error ? caught.message : "시뮬레이션 상태를 불러오지 못했습니다.");
        timer = window.setTimeout(() => void poll(), 1_500);
      }
    };
    timer = window.setTimeout(() => void poll(), 300);
    return () => {
      controller.abort();
      if (timer !== undefined) window.clearTimeout(timer);
      if (pollingGeneration.current === generation) pollingGeneration.current += 1;
    };
  }, [run?.runId, runActive, cancelling, onUnauthorized]);

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
    if (!run?.runId || cancellingRef.current) return;
    cancellingRef.current = true;
    pollingGeneration.current += 1;
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
      cancellingRef.current = false;
      setCancelling(false);
    }
  }, [onUnauthorized, run?.runId]);

  const changeSelectionMode = (mode: "auto" | "manual") => {
    setInstrumentQuery("");
    setInstrumentResults([]);
    setInstrumentError("");
    setRequest((current) => ({
      ...current,
      selection: mode === "manual"
        ? { mode, symbols: manualInstruments.map(({ symbol }) => symbol) }
        : { mode, criterion: "trading_amount", symbolCount: 1 },
    }));
  };

  const addManualInstrument = (instrument: TechnicalInstrumentChoice) => {
    if (manualInstruments.length >= 2 || manualInstruments.some(({ symbol }) => symbol === instrument.symbol)) {
      return;
    }
    const next = [...manualInstruments, instrument];
    setManualInstruments(next);
    setRequest((current) => ({
      ...current,
      selection: { mode: "manual", symbols: next.map(({ symbol }) => symbol) },
    }));
    setInstrumentQuery("");
    setInstrumentResults([]);
  };

  const removeManualInstrument = (symbol: string) => {
    const next = manualInstruments.filter((instrument) => instrument.symbol !== symbol);
    setManualInstruments(next);
    setRequest((current) => ({
      ...current,
      selection: { mode: "manual", symbols: next.map((instrument) => instrument.symbol) },
    }));
  };

  const changeMarket = (marketCountry: AiSimulationMarketCountry) => {
    setManualInstruments([]);
    setInstrumentQuery("");
    setInstrumentResults([]);
    setInstrumentError("");
    setRequest((current) => {
      const switchingToUsDefaults = current.marketCountry === "KR" && marketCountry === "US"
        && current.initialCash === DEFAULT_AI_SIMULATION_REQUEST.initialCash;
      const switchingToKrDefaults = current.marketCountry === "US" && marketCountry === "KR"
        && current.initialCash === 100_000;
      const usingDefaultTax = current.costs.taxBpsOnExit === (current.marketCountry === "KR" ? 18 : 0);
      return {
        ...current,
        marketCountry,
        selection: current.selection.mode === "manual"
          ? { mode: "manual", symbols: [] }
          : current.selection,
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
              보유 주식 0주·현금 100%에서 시작해 자동 선정 또는 직접 고른 1~2개 종목의 수익률을 검증합니다. 새 확정 1분봉마다 GPU AI 예측, 기술 지표와 차트 패턴을 즉시 다시 판단하며 자금과 주문은 외부로 전송하지 않습니다.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-2xl bg-primary-foreground/10 p-4"><BrainCircuit className="size-4" /><p className="mt-4 text-[10px] font-black text-primary-foreground/50">종목 선정</p><p className="mt-1 text-sm font-black">AI 또는 직접 선택</p></div>
            <div className="rounded-2xl bg-primary-foreground/10 p-4"><Clock className="size-4" /><p className="mt-4 text-[10px] font-black text-primary-foreground/50">판단</p><p className="mt-1 text-sm font-black">확정봉 이벤트 즉시</p></div>
            <div className="rounded-2xl bg-primary-foreground/10 p-4"><Wallet className="size-4" /><p className="mt-4 text-[10px] font-black text-primary-foreground/50">시작 상태</p><p className="mt-1 text-sm font-black">현금 100% · 0주</p></div>
            <div className="rounded-2xl bg-primary-foreground/10 p-4"><BarChart3 className="size-4" /><p className="mt-4 text-[10px] font-black text-primary-foreground/50">분석</p><p className="mt-1 text-sm font-black">AI · 지표 · 패턴</p></div>
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
            {selectionModeLabel(request)} · {requestedSymbolCount(request)}종목 · {request.durationMinutes}분 · {riskDispositionLabel(request.riskTolerance)} {request.riskTolerance} · {currency}
          </span>
        </div>

        <form className="mt-5 space-y-4" onSubmit={(event) => { event.preventDefault(); void startSimulation(); }}>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
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
              <span className="mb-2 block text-[10px] font-black text-muted-foreground">종목 선택 방식</span>
              <Select value={request.selection.mode} onValueChange={(value) => changeSelectionMode(value as "auto" | "manual")} disabled={runActive}>
                <SelectTrigger aria-label="시뮬레이션 종목 선택 방식" className="w-full min-w-0 bg-card"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">거래 지표로 자동 선정</SelectItem>
                  <SelectItem value="manual">사용자가 직접 선택</SelectItem>
                </SelectContent>
              </Select>
            </label>
            <label className="min-w-0 rounded-2xl bg-secondary p-3">
              <span className="mb-2 block text-[10px] font-black text-muted-foreground">판단 프리셋</span>
              <Select
                value={request.preset}
                onValueChange={(value) => {
                  const preset = value as AiSimulationPreset;
                  setRequest((current) => ({
                    ...current,
                    preset,
                    riskTolerance: PRESET_DETAILS[preset].recommendedRisk,
                  }));
                }}
                disabled={runActive}
              >
                <SelectTrigger aria-label="AI 판단 프리셋" className="w-full min-w-0 bg-card"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(PRESET_DETAILS).map(([value, details]) => <SelectItem key={value} value={value}>{details.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </label>
          </div>

          <div className="grid gap-3 lg:grid-cols-[1.2fr_0.8fr]">
            <div className="rounded-2xl bg-secondary p-4">
              <div className="flex items-start gap-3">
                <BrainCircuit className="mt-0.5 size-4 shrink-0" />
                <div>
                  <p className="text-xs font-black">{PRESET_DETAILS[request.preset].label}</p>
                  <p className="mt-1 text-[10px] leading-4 text-muted-foreground">{PRESET_DETAILS[request.preset].description}</p>
                </div>
              </div>
            </div>
            <label className="rounded-2xl bg-secondary p-4">
              <span className="flex items-center justify-between gap-3 text-[10px] font-black text-muted-foreground">
                <span>공격·방어 성향</span>
                <span className="rounded-full bg-card px-2.5 py-1 text-foreground">
                  {riskDispositionLabel(request.riskTolerance)} {request.riskTolerance}
                </span>
              </span>
              <input
                aria-label="공격 방어 성향"
                type="range"
                min={0}
                max={100}
                step={1}
                value={request.riskTolerance}
                disabled={runActive}
                onChange={(event) => setRequest((current) => ({
                  ...current,
                  riskTolerance: Number(event.target.value),
                }))}
                className="mt-4 h-2 w-full cursor-pointer accent-primary disabled:cursor-not-allowed"
              />
              <span className="mt-2 flex justify-between text-[9px] font-black text-muted-foreground">
                <span>방어 · 더 많은 현금</span>
                <span>공격 · 더 큰 배분</span>
              </span>
            </label>
          </div>

          {request.selection.mode === "auto" ? (
            <div className="grid gap-3 rounded-2xl bg-secondary p-4 sm:grid-cols-2" data-simulation-auto-selection>
              <label className="min-w-0">
                <span className="mb-2 block text-[10px] font-black text-muted-foreground">자동 선정 기준</span>
                <Select
                  value={request.selection.criterion}
                  onValueChange={(value) => setRequest((current) => current.selection.mode === "auto"
                    ? {
                        ...current,
                        selection: { ...current.selection, criterion: value as AiSimulationCriterion },
                      }
                    : current)}
                  disabled={runActive}
                >
                  <SelectTrigger aria-label="AI 종목 선정 기준" className="w-full min-w-0 bg-card"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {Object.entries(CRITERION_LABELS).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </label>
              <label className="min-w-0">
                <span className="mb-2 block text-[10px] font-black text-muted-foreground">선정 종목 수</span>
                <Select
                  value={String(request.selection.symbolCount)}
                  onValueChange={(value) => setRequest((current) => current.selection.mode === "auto"
                    ? {
                        ...current,
                        selection: { ...current.selection, symbolCount: Number(value) as 1 | 2 },
                      }
                    : current)}
                  disabled={runActive}
                >
                  <SelectTrigger aria-label="AI 선정 종목 수" className="w-full min-w-0 bg-card"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1">1종목</SelectItem>
                    <SelectItem value="2">2종목</SelectItem>
                  </SelectContent>
                </Select>
              </label>
              <p className="text-[9px] leading-4 text-muted-foreground sm:col-span-2">
                기존 거래대금·거래량·변동성 스캐너를 유지하며 AI 예측 가능성과 비용 차감 기대수익을 함께 평가합니다.
              </p>
            </div>
          ) : (
            <div className="rounded-2xl bg-secondary p-4" data-simulation-manual-selection>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-black">직접 선택 종목</p>
                  <p className="mt-1 text-[9px] text-muted-foreground">현재 시장에서 1~2개를 검색해 선택하세요.</p>
                </div>
                <span className="rounded-full bg-card px-2.5 py-1 text-[9px] font-black">{manualInstruments.length} / 2</span>
              </div>
              {manualInstruments.length ? (
                <div className="mt-3 flex flex-wrap gap-2" data-simulation-manual-symbols>
                  {manualInstruments.map((instrument) => (
                    <span key={instrument.symbol} className="inline-flex items-center gap-2 rounded-full bg-card px-3 py-2 text-[10px] font-black">
                      <Check className="size-3.5" />
                      {instrument.name} · {instrument.symbol}
                      <button
                        type="button"
                        aria-label={`${instrument.symbol} 선택 해제`}
                        className="rounded-full p-0.5 hover:bg-secondary"
                        disabled={runActive}
                        onClick={() => removeManualInstrument(instrument.symbol)}
                      >
                        <X className="size-3.5" />
                      </button>
                    </span>
                  ))}
                </div>
              ) : null}
              <div className="relative mt-3">
                <Search className="pointer-events-none absolute left-3 top-3 size-4 text-muted-foreground" />
                <Input
                  aria-label="시뮬레이션 종목 검색"
                  value={instrumentQuery}
                  disabled={runActive || manualInstruments.length >= 2}
                  placeholder={manualInstruments.length >= 2 ? "최대 2종목을 선택했습니다" : "종목명 또는 종목 코드"}
                  onChange={(event) => setInstrumentQuery(event.target.value)}
                  className="bg-card pl-10"
                />
                {instrumentSearching ? <LoaderCircle className="absolute right-3 top-3 size-4 animate-spin text-muted-foreground" /> : null}
              </div>
              {instrumentError ? <p className="mt-2 text-[10px] text-destructive" role="alert">{instrumentError}</p> : null}
              {instrumentResults.length ? (
                <div className="mt-2 max-h-56 overflow-y-auto rounded-2xl bg-card p-2" data-simulation-instrument-results>
                  {instrumentResults.map((instrument) => (
                    <button
                      key={`${instrument.market}:${instrument.symbol}`}
                      type="button"
                      className="flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2 text-left hover:bg-secondary"
                      onClick={() => addManualInstrument(instrument)}
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-xs font-black">{instrument.name}</span>
                        <span className="mt-0.5 block text-[9px] text-muted-foreground">{instrument.symbol} · {instrument.market}</span>
                      </span>
                      <Plus className="size-4 shrink-0" />
                    </button>
                  ))}
                </div>
              ) : instrumentQuery.trim() && !instrumentSearching && !instrumentError ? (
                <p className="mt-2 text-[10px] text-muted-foreground">현재 시장에서 일치하는 종목이 없습니다.</p>
              ) : null}
            </div>
          )}

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
              AI 출력이 unavailable이면 임의 판단이나 체결을 만들지 않습니다. 고정 초 타이머 없이 선택 종목의 새 확정 1분봉 이벤트에 즉시 반응하며, 판단 이후의 다음 유효 체결만 가상 원장에 반영합니다.
            </p>
            {runActive ? (
              <Button
                type="button"
                size="lg"
                variant="secondary"
                onClick={() => void cancelSimulation()}
                disabled={cancelling || run?.status === "cancel_requested"}
                data-simulation-stop
              >
                {cancelling || run?.status === "cancel_requested" ? <LoaderCircle className="animate-spin" /> : <Square />}
                {cancelling || run?.status === "cancel_requested" ? "중단 처리 중" : "테스트 중단"}
              </Button>
            ) : (
              <Button type="submit" size="lg" disabled={statusLoading || !status?.enabled || issues.length > 0 || starting}>
                {starting ? <LoaderCircle className="animate-spin" /> : <Play />}
                AI 시뮬레이션 시작
              </Button>
            )}
          </div>
        </form>
      </Card>

      {run ? (
        <RunPanel run={run} />
      ) : (
        <Card className="grid min-h-48 place-items-center bg-secondary p-6 text-center" data-simulation-empty>
          <div>
            <Bot className="mx-auto size-6" />
            <p className="mt-3 text-sm font-black">아직 실행한 시뮬레이션이 없습니다.</p>
            <p className="mt-1 text-xs text-muted-foreground">설정을 확인한 뒤 시작 버튼을 누르세요.</p>
          </div>
        </Card>
      )}
      <AiSimulationHistory
        onUnauthorized={onUnauthorized}
        refreshKey={run ? `${run.runId ?? "unknown"}:${run.status}` : "initial"}
      />
    </section>
  );
}
