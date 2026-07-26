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
import { AiSimulationComparisonPanel } from "@/components/ai-simulation-comparison-panel";
import {
  AiSimulationAssetClassControl,
  AiSimulationCryptoSetup,
  type AiSimulationAssetClass,
} from "@/components/ai-simulation-crypto";
import {
  AiSimulationFuturesLedger,
  AiSimulationModelComparisonPanel,
} from "@/components/ai-simulation-futures";
import { AiSimulationHistory } from "@/components/ai-simulation-history";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { CHART_UPDATE_INTERVAL_MS } from "@/lib/chart-update";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AI_SIMULATION_CRYPTO_MAXIMUM_INITIAL_CASH,
  AI_SIMULATION_CRYPTO_MINIMUM_INITIAL_CASH,
  DEFAULT_AI_SIMULATION_REQUEST,
  DEFAULT_AI_SIMULATION_CRYPTO_REQUEST,
  aiSimulationErrorMessage,
  aiSimulationPairCatalog,
  aiSimulationPairStrategyEnabled,
  defaultAiSimulationCosts,
  normalizeAiSimulationRun,
  normalizeAiSimulationCandidates,
  normalizeAiSimulationStatus,
  usesDefaultAiSimulationCosts,
  validateAiSimulationCryptoRequest,
  validateAiSimulationRequest,
  type AiSimulationCosts,
  type AiSimulationCandidateSnapshot,
  type AiSimulationCriterion,
  type AiSimulationCryptoRequest,
  type AiSimulationMarketCountry,
  type AiSimulationModelLane,
  type AiSimulationPairCatalogItem,
  type AiSimulationPairId,
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
  { key: "commissionBpsPerSide", label: "토스 편도 수수료" },
  { key: "taxBpsOnExit", label: "매도 거래세" },
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
    label: "돌파 가속 · 최대 공격",
    description: "거래량과 가격 돌파를 빠르게 포착하고 위험 성향 100을 적용하는 최대 공격 구성입니다.",
    recommendedRisk: 100,
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
  open_long: "롱 진입",
  open_short: "숏 진입",
  reduce: "축소·청산",
  none: "진입 없음",
};

const PATTERN_LABELS: Record<string, string> = {
  bullish_engulfing: "상승 장악형",
  bearish_engulfing: "하락 장악형",
  hammer: "망치형",
  shooting_star: "유성형",
  inside_bar: "인사이드 바",
  bullish_outside_bar: "상승 아웃사이드 바",
  bearish_outside_bar: "하락 아웃사이드 바",
  bullish_flag: "상승 깃발형",
  bearish_flag: "하락 깃발형",
  bullish_pennant: "상승 페넌트",
  bearish_pennant: "하락 페넌트",
  rising_wedge: "상승 쐐기형",
  falling_wedge: "하락 쐐기형",
  symmetric_triangle: "대칭 삼각형",
  ascending_triangle: "상승 삼각형",
  descending_triangle: "하락 삼각형",
  double_top: "이중 천장",
  double_bottom: "이중 바닥",
  head_and_shoulders: "헤드앤숄더",
  inverse_head_and_shoulders: "역헤드앤숄더",
  bullish_channel_breakout: "상승 채널 돌파",
  bearish_channel_breakout: "하락 채널 돌파",
};

function requestedSymbolCount(request: AiSimulationRequest): number {
  return request.selection.mode === "manual"
    ? request.selection.symbols.length
    : request.selection.symbolCount;
}

function selectionModeLabel(request: AiSimulationRequest): string {
  return request.selection.mode === "manual" ? "직접 선택" : "자동 선정";
}

function stockModelLaneLabel(lane: AiSimulationModelLane): string {
  return lane === "fincast" ? "FinCast" : "Kronos-base";
}

export function aiSimulationRequestWithStrategy(
  current: AiSimulationRequest,
  strategy: { mode: "single" } | { mode: "pair"; pairId: AiSimulationPairId },
): AiSimulationRequest {
  if (strategy.mode === "single") return { ...current, strategy };
  const switchingToUsDefaults = current.marketCountry === "KR"
    && current.initialCash === DEFAULT_AI_SIMULATION_REQUEST.initialCash;
  const usingDefaultCosts = usesDefaultAiSimulationCosts(
    current.costs,
    current.marketCountry,
  );
  return {
    ...current,
    marketCountry: "US",
    initialCash: switchingToUsDefaults ? 100_000 : current.initialCash,
    selection: { mode: "auto", criterion: "trading_amount", symbolCount: 1 },
    strategy: {
      mode: "pair",
      pairId: strategy.pairId,
      allowDegradedMode: false,
    },
    modelLanes: ["kronos_base"],
    costs: usingDefaultCosts ? defaultAiSimulationCosts("US") : current.costs,
  };
}

function riskDispositionLabel(value: number): string {
  if (value >= 100) return "최대 공격";
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

export function AiSimulationStrategySettings({
  request,
  catalog,
  pairEnabled,
  pairMessage,
  disabled,
  onModeChange,
  onPairIdChange,
}: {
  request: AiSimulationRequest;
  catalog: readonly AiSimulationPairCatalogItem[];
  pairEnabled: boolean;
  pairMessage?: string;
  disabled: boolean;
  onModeChange: (mode: "single" | "pair") => void;
  onPairIdChange: (pairId: AiSimulationPairId) => void;
}) {
  return (
    <div className="rounded-2xl bg-secondary p-4" data-simulation-strategy-settings>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-black">전략 실행 방식</p>
          <p className="mt-1 text-[9px] leading-4 text-muted-foreground">
            페어 비교는 Kronos-base, Rust 기술 지표와 두 신호를 결합한 최종 전략에 같은 미국 시장 원천·비용·체결 정책을 적용합니다.
          </p>
        </div>
        <div
          className="grid grid-cols-2 gap-1 rounded-xl bg-card p-1"
          role="radiogroup"
          aria-label="시뮬레이션 전략 실행 방식"
        >
          <button
            type="button"
            role="radio"
            aria-checked={request.strategy.mode === "single"}
            className={cn(
              "rounded-lg px-3 py-2 text-[10px] font-black transition-colors",
              request.strategy.mode === "single" ? "bg-primary text-primary-foreground" : "text-muted-foreground",
            )}
            disabled={disabled}
            onClick={() => onModeChange("single")}
          >
            단일
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={request.strategy.mode === "pair"}
            className={cn(
              "rounded-lg px-3 py-2 text-[10px] font-black transition-colors",
              request.strategy.mode === "pair" ? "bg-primary text-primary-foreground" : "text-muted-foreground",
            )}
            disabled={disabled || !pairEnabled}
            aria-disabled={disabled || !pairEnabled}
            onClick={() => onModeChange("pair")}
          >
            페어 비교
          </button>
        </div>
      </div>
      {!pairEnabled ? (
        <p className="mt-3 rounded-xl bg-card p-3 text-[9px] leading-4 text-muted-foreground">
          {pairMessage ?? "현재 서버가 페어 전략 capability를 제공하지 않습니다."}
        </p>
      ) : null}
      {request.strategy.mode === "pair" ? (
        <div className="mt-4" data-simulation-pair-settings>
          <label className="min-w-0">
            <span className="mb-2 block text-[10px] font-black text-muted-foreground">미국 페어 카탈로그</span>
            <Select
              value={request.strategy.pairId}
              onValueChange={(value) => onPairIdChange(value as AiSimulationPairId)}
              disabled={disabled}
            >
              <SelectTrigger aria-label="미국 페어 카탈로그" className="w-full min-w-0 bg-card"><SelectValue /></SelectTrigger>
              <SelectContent>
                {catalog.map((item) => (
                  <SelectItem key={item.id} value={item.id}>{item.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <p className="mt-3 rounded-xl bg-card p-3 text-[9px] leading-4 text-muted-foreground">
            페어 비교를 선택하면 시장은 미국으로 고정됩니다. Kronos-base가 unavailable 또는 degraded이거나 Rust 입력이 유효하지 않으면 거래하지 않고 cash로 닫습니다.
          </p>
        </div>
      ) : null}
    </div>
  );
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
  const quantityUnit = snapshot.currency === "USDT" ? "계약" : "주";
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
                  {formatQuantity(position.quantity)}{quantityUnit} · 평균 {formatMoney(position.averagePrice, snapshot.currency)}
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
  const quantityUnit = snapshot.currency === "USDT" ? "계약" : "주";
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
                  {formatQuantity(trade.quantity)}{quantityUnit} × {formatMoney(trade.price, snapshot.currency)} · {formatMoney(trade.amount, snapshot.currency)}
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
          <div><p className="text-[10px] font-black tracking-[0.12em] text-muted-foreground">DECISIONS</p><h2 className="mt-1 text-lg font-black">전략 판단 기록</h2></div>
          <span className="text-[10px] font-black text-muted-foreground">{snapshot.decisions.length}건</span>
        </div>
        <div
          className="mt-4 max-h-[28rem] min-h-0 overflow-y-auto overscroll-contain pr-1"
          data-simulation-decisions-scroll
          tabIndex={0}
          aria-label="전략 판단 기록 스크롤 목록"
        >
          {decisions.length ? (
          <div className="space-y-2">
            {decisions.map((decision, index) => (
              <article key={`${decision.symbol}:${decision.decidedAt}:${index}`} className="rounded-2xl bg-secondary p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-black">{decision.symbol} · {actionLabel(decision.action)}</p>
                  <p className="text-[9px] text-muted-foreground">{formatTimestamp(decision.decidedAt)}</p>
                </div>
                {decision.reasons && decision.reasons.length > 1 ? (
                  <ul className="mt-2 list-disc space-y-1 pl-4 text-xs leading-5">
                    {decision.reasons.map((reason, reasonIndex) => (
                      <li key={`${reason}:${reasonIndex}`} className="break-words">{reason}</li>
                    ))}
                  </ul>
                ) : <p className="mt-2 break-words text-xs leading-5">{decision.reason}</p>}
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
                {decision.q10Return !== undefined
                  || decision.predictedMedianReturn !== undefined
                  || decision.q90Return !== undefined ? (
                    <p className="mt-1 break-words text-[9px] text-muted-foreground">
                      q10 {formatRatio(decision.q10Return, true)} · 중앙 {formatRatio(decision.predictedMedianReturn, true)} · q90 {formatRatio(decision.q90Return, true)}
                    </p>
                  ) : null}
                {decision.signalSymbol || decision.executionSymbol || decision.direction || decision.technicalState ? (
                  <p className="mt-1 break-words text-[9px] text-muted-foreground">
                    {decision.signalSymbol && decision.executionSymbol
                      ? `${decision.signalSymbol} → ${decision.executionSymbol}`
                      : decision.signalSymbol ?? decision.executionSymbol}
                    {decision.direction ? ` · ${decision.direction}` : ""}
                    {decision.technicalState ? ` · ${decision.technicalState}` : ""}
                    {decision.degraded ? " · degraded" : ""}
                  </p>
                ) : null}
                {decision.technicalScore !== undefined
                  || decision.exposureScale !== undefined
                  || decision.chartPatternStrength !== undefined ? (
                    <p className="mt-1 break-words text-[9px] text-muted-foreground">
                      기술 점수 {formatScore(decision.technicalScore)}
                      {decision.technicalDirection ? ` · 기술 방향 ${decision.technicalDirection}` : ""}
                      {decision.exposureScale !== undefined
                        ? ` · 노출 ${formatRatio(decision.exposureScale)}` : ""}
                      {decision.modelEvidenceScale !== undefined
                        ? ` · 모델 증거 ${formatRatio(decision.modelEvidenceScale)}` : ""}
                      {decision.chartPatternStrength !== undefined
                        ? ` · 패턴 강도 ${formatRatio(decision.chartPatternStrength)}` : ""}
                    </p>
                  ) : null}
                {decision.components || decision.weights || decision.finalScores
                  || decision.provenance?.length || decision.fusionPolicyVersion ? (
                  <details className="mt-2 rounded-xl bg-card p-3">
                    <summary className="cursor-pointer text-[9px] font-black">판단 구성 상세</summary>
                    <div className="mt-2 space-y-1 break-words text-[8px] leading-4 text-muted-foreground">
                      {decision.components ? <p>components · {Object.entries(decision.components).map(([key, value]) => `${key} ${value}`).join(" · ")}</p> : null}
                      {decision.weights ? <p>weights · {Object.entries(decision.weights).map(([key, value]) => `${key} ${value}`).join(" · ")}</p> : null}
                      {decision.finalScores ? <p>final scores · {Object.entries(decision.finalScores).map(([key, value]) => `${key} ${value}`).join(" · ")}</p> : null}
                      {decision.provenance?.length ? <p>provenance · {decision.provenance.join(" · ")}</p> : null}
                      {decision.fusionPolicyVersion
                        ? <p>fusion · {decision.fusionPolicyVersion}</p> : null}
                    </div>
                  </details>
                ) : null}
                {decision.model ? <p className="mt-1 truncate text-[9px] text-muted-foreground" title={decision.model}>{decision.model}</p> : null}
              </article>
            ))}
          </div>
          ) : <p className="text-xs text-muted-foreground">전략 판단을 기다리고 있습니다.</p>}
        </div>
      </Card>
    </div>
  );
}

export function simulationDecisionCadenceLabel(trigger?: string): string {
  if (trigger === "final_fincast_15s_aggtrade_bar") return "FinCast 새 확정 15초봉 즉시";
  if (trigger === "final_fincast_30s_aggtrade_bar") return "FinCast 새 확정 30초봉 즉시";
  return trigger === "finalized_one_minute_bar" || trigger === "final_binance_1m_kline"
    ? "새 확정 1분봉 즉시"
    : "확정봉 이벤트 즉시";
}

export function aiSimulationChartLayout(
  snapshot: Pick<AiSimulationSnapshot, "market" | "strategy" | "charts" | "decisions">,
  modelForecasts: readonly { signalSymbol: string }[],
): {
  primarySymbol?: string;
  layout: "crypto-full-width" | "pair-primary-full-width" | "standard";
  charts: AiSimulationSnapshot["charts"];
} {
  const cryptoFutures = snapshot.market?.kind === "crypto_futures";
  const primarySymbol = snapshot.strategy?.mode === "pair"
    ? (
      modelForecasts.find((forecast) => forecast.signalSymbol)?.signalSymbol
      ?? snapshot.decisions.find((decision) => decision.signalSymbol)?.signalSymbol
      ?? snapshot.strategy.pairId.split("-")[0]
    )?.toUpperCase()
    : undefined;
  const charts = primarySymbol
    ? [...snapshot.charts].sort((left, right) => (
      Number(right.symbol.toUpperCase() === primarySymbol)
      - Number(left.symbol.toUpperCase() === primarySymbol)
    ))
    : snapshot.charts;
  return {
    primarySymbol,
    layout: cryptoFutures
      ? "crypto-full-width"
      : primarySymbol
        ? "pair-primary-full-width"
        : "standard",
    charts,
  };
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
  const cryptoFutures = snapshot.market?.kind === "crypto_futures";
  const modelForecasts = snapshot.modelForecasts
    ?? snapshot.kronosForecasts.map((forecast) => ({
      ...forecast,
      lane: "kronos_base" as const,
    }));
  const chartLayout = aiSimulationChartLayout(snapshot, modelForecasts);
  const pairPrimarySymbol = chartLayout.primarySymbol;
  const orderedCharts = chartLayout.charts;

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
            <p className="mt-5 text-[10px] font-black tracking-[0.12em] text-primary-foreground/60">
              {cryptoFutures ? "FUTURES PAPER EQUITY" : "VIRTUAL EQUITY"}
            </p>
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
          <span className="rounded-full bg-primary-foreground/10 px-3 py-1.5">
            {cryptoFutures ? "isolated · 단방향 · paper only" : "보유 0주 · 현금 100% 시작"}
          </span>
          {!cryptoFutures && snapshot.modelLanes?.[0] ? (
            <span className="rounded-full bg-primary-foreground/10 px-3 py-1.5">
              {stockModelLaneLabel(snapshot.modelLanes[0])} · Rust causal fusion
            </span>
          ) : null}
          {snapshot.preset ? <span className="rounded-full bg-primary-foreground/10 px-3 py-1.5">{PRESET_DETAILS[snapshot.preset].label}</span> : null}
          {snapshot.riskTolerance !== undefined ? (
            <span className="rounded-full bg-primary-foreground/10 px-3 py-1.5">
              {riskDispositionLabel(snapshot.riskTolerance)} {snapshot.riskTolerance}
            </span>
          ) : null}
          {snapshot.policyProfile?.targetAllocationRate !== undefined ? (
            <span className="rounded-full bg-primary-foreground/10 px-3 py-1.5">
              {cryptoFutures
                ? `위험 산출 수량 ${(snapshot.policyProfile.targetAllocationRate * 100).toFixed(0)}%`
                : `목표 투자 ${(snapshot.policyProfile.targetAllocationRate * 100).toFixed(0)}% · 현금 ${((snapshot.policyProfile.cashReserveRate ?? 1 - snapshot.policyProfile.targetAllocationRate) * 100).toFixed(0)}%`}
            </span>
          ) : null}
        </div>
      </Card>

      {snapshot.strategyComparison ? (
        <AiSimulationComparisonPanel
          comparison={snapshot.strategyComparison}
          currency={snapshot.currency}
        />
      ) : null}

      {cryptoFutures ? (
        <>
          <AiSimulationModelComparisonPanel comparison={snapshot.modelComparison} />
          <AiSimulationFuturesLedger
            positions={snapshot.futuresPositions ?? []}
            risk={snapshot.futuresRisk}
          />
          <SelectedSymbols snapshot={snapshot} />
        </>
      ) : (
        <div className="grid gap-3 xl:grid-cols-2">
          <SelectedSymbols snapshot={snapshot} />
          <Positions snapshot={snapshot} />
        </div>
      )}
      {snapshot.charts.length ? (
        <div
          className={cn(
            "grid gap-3",
            !cryptoFutures && orderedCharts.length > 1 && "xl:grid-cols-2",
          )}
          data-simulation-charts
          data-simulation-chart-layout={chartLayout.layout}
        >
          {orderedCharts.map((chart) => (
            <AiSimulationChart
              key={chart.symbol}
              symbol={chart.symbol}
              name={chart.name}
              currency={chart.currency}
              bars={chart.bars}
              indicators={chart.indicators}
              patterns={chart.patterns}
              updatedAt={chart.updatedAt}
              forecasts={modelForecasts.filter(
                (forecast) => forecast.signalSymbol === chart.symbol,
              )}
              trades={snapshot.trades.flatMap((trade) => {
                if (trade.symbol !== chart.symbol) return [];
                const side = trade.side.toLowerCase();
                if (side !== "buy" && side !== "sell") return [];
                return [{
                  executedAt: trade.executedAt,
                  price: trade.price,
                  side,
                  quantity: trade.quantity,
                  positionSide: trade.positionSide,
                }];
              })}
              className={cn(
                pairPrimarySymbol
                  && chart.symbol.toUpperCase() === pairPrimarySymbol
                  && "xl:col-span-2",
              )}
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
  const [assetClass, setAssetClass] = useState<AiSimulationAssetClass>("stock");
  const [request, setRequest] = useState<AiSimulationRequest>(DEFAULT_AI_SIMULATION_REQUEST);
  const [cryptoRequest, setCryptoRequest] = useState<AiSimulationCryptoRequest>(
    DEFAULT_AI_SIMULATION_CRYPTO_REQUEST,
  );
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
  const [candidateSnapshot, setCandidateSnapshot] = useState<AiSimulationCandidateSnapshot>();
  const [candidateLoading, setCandidateLoading] = useState(false);
  const [candidateError, setCandidateError] = useState("");
  const cancellingRef = useRef(false);
  const pollingGeneration = useRef(0);

  const issues = useMemo(
    () => assetClass === "crypto_futures"
      ? validateAiSimulationCryptoRequest(cryptoRequest, {
          minimumInitialCash: AI_SIMULATION_CRYPTO_MINIMUM_INITIAL_CASH,
          maximumInitialCash: AI_SIMULATION_CRYPTO_MAXIMUM_INITIAL_CASH,
          minimumDurationMinutes: status?.limits.minimumDurationMinutes,
          maximumDurationMinutes: status?.limits.maximumDurationMinutes,
        })
      : validateAiSimulationRequest(request, status?.limits),
    [assetClass, cryptoRequest, request, status?.limits],
  );
  const runActive = Boolean(run && ACTIVE_RUN_STATUSES.has(run.status));
  const pairEnabled = aiSimulationPairStrategyEnabled(status);
  const pairCatalog = useMemo(() => aiSimulationPairCatalog(status), [status]);
  const loadCryptoCandidates = useCallback(async (signal?: AbortSignal) => {
    setCandidateLoading(true);
    setCandidateError("");
    try {
      const criterion = cryptoRequest.selection.mode === "auto"
        ? cryptoRequest.selection.criterion
        : "volatility";
      const response = await fetch(
        `/api/portfolio/simulation/candidates?criterion=${encodeURIComponent(criterion)}`,
        { headers: { Accept: "application/json" }, signal },
      );
      const payload = await readJson(response);
      if (response.status === 401) {
        onUnauthorized();
        return;
      }
      if (!response.ok) {
        throw new Error(aiSimulationErrorMessage(payload, "암호화폐 선물 후보를 스캔하지 못했습니다."));
      }
      if (!signal?.aborted) setCandidateSnapshot(normalizeAiSimulationCandidates(payload, criterion));
    } catch (caught) {
      if (signal?.aborted) return;
      setCandidateError(caught instanceof Error ? caught.message : "암호화폐 선물 후보를 스캔하지 못했습니다.");
      setCandidateSnapshot(undefined);
    } finally {
      if (!signal?.aborted) setCandidateLoading(false);
    }
  }, [cryptoRequest.selection, onUnauthorized]);

  useEffect(() => {
    if (assetClass !== "crypto_futures" || runActive) return;
    const controller = new AbortController();
    void loadCryptoCandidates(controller.signal);
    return () => controller.abort();
  }, [assetClass, loadCryptoCandidates, runActive]);

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
            const restored = normalizeAiSimulationRun(currentPayload);
            setRun(restored);
            if (restored.snapshot?.market?.kind === "crypto_futures") {
              setAssetClass("crypto_futures");
            }
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
        if (ACTIVE_RUN_STATUSES.has(next.status)) {
          timer = window.setTimeout(() => void poll(), CHART_UPDATE_INTERVAL_MS);
        }
      } catch (caught) {
        if (controller.signal.aborted || generation !== pollingGeneration.current) return;
        setError(caught instanceof Error ? caught.message : "시뮬레이션 상태를 불러오지 못했습니다.");
        timer = window.setTimeout(() => void poll(), CHART_UPDATE_INTERVAL_MS);
      }
    };
    void poll();
    return () => {
      controller.abort();
      if (timer !== undefined) window.clearTimeout(timer);
      if (pollingGeneration.current === generation) pollingGeneration.current += 1;
    };
  }, [run?.runId, runActive, cancelling, onUnauthorized]);

  const startSimulation = useCallback(async () => {
    const validation = assetClass === "crypto_futures"
      ? validateAiSimulationCryptoRequest(cryptoRequest, {
          minimumInitialCash: AI_SIMULATION_CRYPTO_MINIMUM_INITIAL_CASH,
          maximumInitialCash: AI_SIMULATION_CRYPTO_MAXIMUM_INITIAL_CASH,
          minimumDurationMinutes: status?.limits.minimumDurationMinutes,
          maximumDurationMinutes: status?.limits.maximumDurationMinutes,
        })
      : validateAiSimulationRequest(request, status?.limits);
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
        body: JSON.stringify(assetClass === "crypto_futures" ? cryptoRequest : request),
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
  }, [assetClass, cryptoRequest, onUnauthorized, request, status?.limits]);

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
      const usingDefaultCosts = usesDefaultAiSimulationCosts(
        current.costs,
        current.marketCountry,
      );
      return {
        ...current,
        marketCountry,
        selection: current.selection.mode === "manual"
          ? { mode: "manual", symbols: [] }
          : current.selection,
        initialCash: switchingToUsDefaults ? 100_000 : switchingToKrDefaults ? DEFAULT_AI_SIMULATION_REQUEST.initialCash : current.initialCash,
        costs: usingDefaultCosts
          ? defaultAiSimulationCosts(marketCountry)
          : current.costs,
      };
    });
  };

  const changeStrategyMode = (mode: "single" | "pair") => {
    if (mode === "pair" && !pairEnabled) return;
    setInstrumentQuery("");
    setInstrumentResults([]);
    setInstrumentError("");
    if (mode === "pair") setManualInstruments([]);
    setRequest((current) => {
      if (mode === "single") return aiSimulationRequestWithStrategy(current, { mode });
      const currentPairId = current.strategy.mode === "pair" ? current.strategy.pairId : undefined;
      const pairId = pairCatalog.some((item) => item.id === currentPairId)
        ? currentPairId!
        : pairCatalog.some((item) => item.id === "sndk-snxx-sndq")
          ? "sndk-snxx-sndq"
          : pairCatalog[0]?.id ?? "soxx-soxl-soxs";
      return aiSimulationRequestWithStrategy(current, { mode, pairId });
    });
  };

  const changeAssetClass = (next: AiSimulationAssetClass) => {
    if (runActive || next === assetClass) return;
    setAssetClass(next);
    setError("");
    setRun(undefined);
  };

  const currency = request.marketCountry === "US" ? "USD" : "KRW";
  const costProfile = status?.costProfiles?.[request.marketCountry];
  const selectedPairId = request.strategy.mode === "pair" ? request.strategy.pairId : undefined;
  const selectedPair = selectedPairId
    ? pairCatalog.find((item) => item.id === selectedPairId)
    : undefined;

  return (
    <section className="space-y-3" data-ai-simulation>
      <AiSimulationAssetClassControl
        value={assetClass}
        disabled={runActive}
        onChange={changeAssetClass}
      />
      <Card className="overflow-hidden bg-primary p-6 text-primary-foreground sm:p-8">
        <div className="grid gap-7 lg:grid-cols-[1.2fr_0.8fr] lg:items-end">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full bg-primary-foreground/10 px-3 py-2 text-[10px] font-black">
              <Bot className="size-4" />
              PAPER TRADING ONLY
            </div>
            <h2 className="mt-6 max-w-3xl text-[clamp(2rem,5vw,4.7rem)] font-black leading-[0.95] tracking-[-0.07em]">
              {assetClass === "crypto_futures"
                ? <>선물 방향을 읽고,<br />격리 원장으로 검증합니다.</>
                : <>AI가 고르고,<br />가상 원장으로 검증합니다.</>}
            </h2>
            <p className="mt-5 max-w-2xl text-sm leading-6 text-primary-foreground/60">
              {assetClass === "crypto_futures"
                ? "Binance USDⓈ-M USDT 무기한 계약 중 유동성 조건을 통과한 1~2개 계약을 자동 또는 직접 고르고, 확정봉과 다음 유효 체결만으로 롱·숏 paper 결과를 검증합니다. 읽기 전용 키와 공개 시세 외에는 외부로 주문을 전송하지 않습니다."
                : "보유 주식 0주·현금 100%에서 시작해 자동 선정 또는 직접 고른 1~2개 종목의 수익률을 검증합니다. 새 확정 1분봉마다 Kronos-base 예측, Rust 기술 지표와 차트 패턴을 즉시 다시 판단하며 자금과 주문은 외부로 전송하지 않습니다."}
            </p>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-2xl bg-primary-foreground/10 p-4"><BrainCircuit className="size-4" /><p className="mt-4 text-[10px] font-black text-primary-foreground/50">종목 선정</p><p className="mt-1 text-sm font-black">{assetClass === "crypto_futures" ? "자동·직접 1~2계약" : "AI 또는 직접 선택"}</p></div>
            <div className="rounded-2xl bg-primary-foreground/10 p-4"><Clock className="size-4" /><p className="mt-4 text-[10px] font-black text-primary-foreground/50">판단</p><p className="mt-1 text-sm font-black">확정봉 이벤트 즉시</p></div>
            <div className="rounded-2xl bg-primary-foreground/10 p-4"><Wallet className="size-4" /><p className="mt-4 text-[10px] font-black text-primary-foreground/50">시작 상태</p><p className="mt-1 text-sm font-black">{assetClass === "crypto_futures" ? "USDT · isolated" : "현금 100% · 0주"}</p></div>
            <div className="rounded-2xl bg-primary-foreground/10 p-4"><BarChart3 className="size-4" /><p className="mt-4 text-[10px] font-black text-primary-foreground/50">분석</p><p className="mt-1 text-sm font-black">{assetClass === "crypto_futures" ? "Kronos · FinCast" : "Kronos-base · Rust · 패턴"}</p></div>
          </div>
        </div>
      </Card>

      {assetClass === "stock" ? (
        <SimulationDisclosure />
      ) : (
        <Card className="bg-secondary p-4 text-[10px] leading-5 text-muted-foreground" data-crypto-simulation-disclosure>
          <p className="font-black text-foreground">선물 paper 전용 · 실주문 capability false</p>
          <p className="mt-1">
            거래당 위험, UTC 일손실 중단선, 최대 레버리지, gross exposure, 증거금 사용률과 청산 buffer를 실행별로 설정합니다.
            기본값은 0.5%·3%·15배·150%·20%·손절 거리 2배이며 모든 값은 paper 원장에만 적용됩니다.
          </p>
        </Card>
      )}
      <RuntimeStatus status={status} loading={statusLoading} />

      {assetClass === "crypto_futures" ? (
        <AiSimulationCryptoSetup
          request={cryptoRequest}
          status={status?.cryptoFutures}
          candidateSnapshot={candidateSnapshot}
          candidateLoading={candidateLoading}
          candidateError={candidateError}
          issues={issues}
          error={error}
          disabled={runActive || statusLoading || !status?.enabled}
          starting={starting}
          active={runActive}
          cancelling={cancelling}
          cancelRequested={run?.status === "cancel_requested"}
          onRequestChange={setCryptoRequest}
          onRefreshCandidates={() => void loadCryptoCandidates()}
          onStart={() => void startSimulation()}
          onCancel={() => void cancelSimulation()}
          limits={{
            minimumDurationMinutes: status?.limits.minimumDurationMinutes,
            maximumDurationMinutes: status?.limits.maximumDurationMinutes,
          }}
        />
      ) : null}

      <Card className={cn("bg-card p-5 sm:p-7", assetClass !== "stock" && "hidden")} aria-hidden={assetClass !== "stock"}>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-[10px] font-black tracking-[0.12em] text-muted-foreground">SIMULATION SETUP</p>
            <h2 className="mt-1 text-xl font-black">테스트 설정</h2>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">시작 버튼을 눌러야만 후보 스캔과 AI 판단이 시작됩니다.</p>
          </div>
          <span className="rounded-full bg-secondary px-3 py-1.5 text-[10px] font-black">
            {request.strategy.mode === "pair"
              ? `페어 비교 · ${selectedPair?.label ?? request.strategy.pairId}`
              : `${selectionModeLabel(request)} · ${requestedSymbolCount(request)}종목`}
            {" · "}{stockModelLaneLabel(request.modelLanes[0])}
            {" · "}{request.durationMinutes}분 · {riskDispositionLabel(request.riskTolerance)} {request.riskTolerance} · {currency}
          </span>
        </div>

        <form className="mt-5 space-y-4" onSubmit={(event) => { event.preventDefault(); void startSimulation(); }}>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <label className="min-w-0 rounded-2xl bg-secondary p-3">
              <span className="mb-2 block text-[10px] font-black text-muted-foreground">대상 시장</span>
              <Select value={request.marketCountry} onValueChange={(value) => changeMarket(value as AiSimulationMarketCountry)} disabled={runActive || request.strategy.mode === "pair"}>
                <SelectTrigger aria-label="시뮬레이션 대상 시장" className="w-full min-w-0 bg-card"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="KR">국내</SelectItem>
                  <SelectItem value="US">미국</SelectItem>
                </SelectContent>
              </Select>
            </label>
            <label className="min-w-0 rounded-2xl bg-secondary p-3">
              <span className="mb-2 block text-[10px] font-black text-muted-foreground">예측 모델</span>
              <Select
                value={request.modelLanes[0]}
                onValueChange={(value) => setRequest((current) => ({
                  ...current,
                  modelLanes: [value as AiSimulationModelLane],
                }))}
                disabled={runActive || request.strategy.mode === "pair"}
              >
                <SelectTrigger aria-label="주식 시뮬레이션 예측 모델" className="w-full min-w-0 bg-card">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="kronos_base">Kronos-base</SelectItem>
                  <SelectItem value="fincast">FinCast</SelectItem>
                </SelectContent>
              </Select>
              <span className="mt-2 block text-[9px] leading-4 text-muted-foreground">
                {request.strategy.mode === "pair"
                  ? "페어는 Kronos-base + Rust 결합으로 고정됩니다."
                  : "선택한 한 모델만 실행하며 다른 모델로 대체하지 않습니다."}
              </span>
            </label>
            {request.strategy.mode === "single" ? (
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
            ) : (
              <div className="min-w-0 rounded-2xl bg-secondary p-3">
                <span className="block text-[10px] font-black text-muted-foreground">종목 선택 방식</span>
                <p className="mt-3 break-words text-xs font-black">미국 페어 카탈로그 고정</p>
              </div>
            )}
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

          <AiSimulationStrategySettings
            request={request}
            catalog={pairCatalog}
            pairEnabled={pairEnabled}
            pairMessage={statusLoading
              ? "페어 전략 capability를 확인하고 있습니다."
              : status?.pairStrategy?.message}
            disabled={runActive}
            onModeChange={changeStrategyMode}
            onPairIdChange={(pairId) => setRequest((current) => current.strategy.mode === "pair"
              ? { ...current, strategy: { ...current.strategy, pairId } }
              : current)}
          />

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
                <span>최대 공격 · 최대 배분</span>
              </span>
            </label>
          </div>

          {request.strategy.mode === "pair" ? null : request.selection.mode === "auto" ? (
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
            <div
              className="mt-3 rounded-2xl bg-card p-3 text-[10px] leading-4 text-muted-foreground"
              data-simulation-cost-profile={costProfile?.profileId ?? request.marketCountry}
            >
              <p className="font-black text-foreground">
                토스증권 {request.marketCountry === "KR" ? "국내 KRX 일반주식" : "미국 주식·ETF"} 기준
                {costProfile?.verifiedAt ? ` · ${costProfile.verifiedAt} 확인` : ""}
              </p>
              {request.marketCountry === "KR" ? (
                <p className="mt-1">
                  KRX 편도 0.015%, 일반 상장주식 매도세 0.20%를 기본 반영합니다.
                  NXT 수수료는 0.014%이며, ETF·ETN·ELW는 상품별 과세가 달라 기본 매도세를 조정해야 합니다.
                </p>
              ) : (
                <p className="mt-1">
                  편도 0.1%를 적용하되 체결금액 USD 10 이하는 토스 수수료를 면제합니다.
                  매도 시 SEC 0.206bps와 FINRA TAF USD 0.000195/주(건당 최대 USD 9.79)를 원장에서 별도 차감합니다.
                  USD 원장이므로 환전 비용과 환율 스프레드는 포함하지 않습니다.
                </p>
              )}
              <p className="mt-1">
                왕복 스프레드와 편도 슬리피지는 토스 고시 수수료가 아닌 체결 현실성 가정입니다.
                아래 수수료·거래세 값을 바꾸면 사용자 override로 보존됩니다.
              </p>
              {costProfile?.sources.length ? (
                <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
                  {costProfile.sources.map((source) => (
                    <a
                      key={source.url}
                      href={source.url}
                      target="_blank"
                      rel="noreferrer"
                      className="font-black text-foreground underline underline-offset-2"
                    >
                      {source.label}
                    </a>
                  ))}
                </p>
              ) : null}
            </div>
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
