import type { KeyboardEvent } from "react";
import {
  Activity,
  AlertTriangle,
  Check,
  Cpu,
  Database,
  LoaderCircle,
  LockKeyhole,
  Play,
  RefreshCw,
  ShieldCheck,
  Square,
  Waves,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AI_SIMULATION_CRYPTO_MAXIMUM_INITIAL_CASH,
  AI_SIMULATION_CRYPTO_MINIMUM_INITIAL_CASH,
} from "@/lib/ai-simulation";
import type {
  AiSimulationCandidateSnapshot,
  AiSimulationCryptoRequest,
  AiSimulationCryptoStatus,
  AiSimulationCriterion,
  AiSimulationModelLane,
} from "@/lib/ai-simulation";
import { formatMoney } from "@/lib/format";
import { cn } from "@/lib/utils";

export type AiSimulationAssetClass = "stock" | "crypto_futures";

const ASSET_OPTIONS: Array<{
  value: AiSimulationAssetClass;
  label: string;
  detail: string;
}> = [
  { value: "stock", label: "주식", detail: "KR · US" },
  { value: "crypto_futures", label: "암호화폐", detail: "BINANCE USDⓈ-M" },
];

const CRITERION_LABELS: Record<AiSimulationCriterion, string> = {
  trading_amount: "거래대금",
  volume: "거래량",
  volatility: "변동성",
};

const MODEL_LABELS: Record<AiSimulationModelLane, string> = {
  kronos_base: "Kronos-base",
  fincast: "FinCast",
};

const CRYPTO_PRESET_DETAILS: Record<
  AiSimulationCryptoRequest["preset"],
  { label: string; description: string; recommendedRisk: number }
> = {
  trend: {
    label: "추세 수익",
    description: "EMA 추세와 모델 방향이 일치할 때 진입합니다.",
    recommendedRisk: 60,
  },
  breakout: {
    label: "돌파 가속 · 최대 공격",
    description: "Donchian 돌파와 모델 비용 초과 확률을 함께 확인합니다.",
    recommendedRisk: 100,
  },
  mean_reversion: {
    label: "반등 수익",
    description: "RSI·Bollinger 과매수/과매도와 모델 반전 방향을 확인합니다.",
    recommendedRisk: 50,
  },
  risk_management: {
    label: "방어 수익",
    description: "EMA·RSI 상태를 참고하고 더 높은 모델 확신도로 진입을 제한합니다.",
    recommendedRisk: 25,
  },
};

function cryptoRiskDisposition(value: number): string {
  if (value >= 80) return "최대 공격";
  if (value >= 60) return "공격";
  if (value >= 40) return "균형";
  return "방어";
}

function percent(value?: number, digits = 2): string {
  return Number.isFinite(value) ? `${((value as number) * 100).toFixed(digits)}%` : "unavailable";
}

function decimal(value?: number, digits = 2): string {
  return Number.isFinite(value) ? (value as number).toFixed(digits) : "unavailable";
}

function compact(value?: number): string {
  if (!Number.isFinite(value)) return "unavailable";
  return new Intl.NumberFormat("ko-KR", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value as number);
}

function timestamp(value?: string): string {
  if (!value) return "unavailable";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "unavailable";
  return new Intl.DateTimeFormat("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

export function AiSimulationAssetClassControl({
  value,
  disabled,
  onChange,
}: {
  value: AiSimulationAssetClass;
  disabled?: boolean;
  onChange: (value: AiSimulationAssetClass) => void;
}) {
  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? ASSET_OPTIONS.length - 1
        : (index + (event.key === "ArrowRight" ? 1 : -1) + ASSET_OPTIONS.length) % ASSET_OPTIONS.length;
    const next = ASSET_OPTIONS[nextIndex];
    onChange(next.value);
    document.querySelector<HTMLButtonElement>(
      `[data-simulation-asset-class-option="${next.value}"]`,
    )?.focus();
  };

  return (
    <div
      className="grid grid-cols-2 rounded-2xl bg-secondary p-1"
      role="radiogroup"
      aria-label="시뮬레이션 자산군"
      data-simulation-asset-class={value}
    >
      {ASSET_OPTIONS.map((option, index) => {
        const selected = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            disabled={disabled}
            data-simulation-asset-class-option={option.value}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => move(event, index)}
            className={cn(
              "min-w-0 rounded-xl px-4 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              selected
                ? "bg-card text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <span className="block text-xs font-black">{option.label}</span>
            <span className="mt-0.5 block truncate text-[9px] font-bold">{option.detail}</span>
          </button>
        );
      })}
    </div>
  );
}

function CapabilityCard({
  label,
  enabled,
  detail,
}: {
  label: string;
  enabled: boolean;
  detail: string;
}) {
  return (
    <div
      className={cn(
        "rounded-2xl p-3",
        enabled ? "bg-card" : "bg-destructive/5",
      )}
      data-execution-capability={label.toLowerCase()}
      data-enabled={enabled}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-black">{label}</span>
        <span className={cn(
          "rounded-full px-2 py-1 text-[8px] font-black",
          enabled ? "bg-cyan-500/10 text-cyan-700 dark:text-cyan-300" : "bg-secondary text-muted-foreground",
        )}>
          {enabled ? "가능" : "잠김"}
        </span>
      </div>
      <p className="mt-2 text-[9px] leading-4 text-muted-foreground">{detail}</p>
    </div>
  );
}

function WorkerCard({
  lane,
  status,
}: {
  lane: AiSimulationModelLane;
  status?: AiSimulationCryptoStatus["workers"][AiSimulationModelLane];
}) {
  const available = Boolean(status?.available);
  return (
    <article
      className="min-w-0 rounded-2xl bg-secondary p-4"
      data-model-worker={lane}
      data-model-worker-available={available}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-black">{MODEL_LABELS[lane]}</p>
          <p className="mt-1 truncate text-[9px] text-muted-foreground" title={status?.modelId}>
            {status?.modelId ?? "모델 정보 unavailable"}
          </p>
        </div>
        <span className={cn(
          "shrink-0 rounded-full px-2 py-1 text-[8px] font-black",
          available
            ? "bg-cyan-500/10 text-cyan-700 dark:text-cyan-300"
            : "bg-destructive/10 text-destructive",
        )}>
          {status?.status ?? "unavailable"}
        </span>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 text-[9px]">
        <p className="rounded-xl bg-card px-2.5 py-2"><span className="text-muted-foreground">precision</span><br /><strong>{status?.precision ?? "unknown"}</strong></p>
        <p className="rounded-xl bg-card px-2.5 py-2"><span className="text-muted-foreground">latency</span><br /><strong>{status?.latencyMs !== undefined ? `${status.latencyMs.toFixed(0)}ms` : "unavailable"}</strong></p>
      </div>
      {status?.reason ? <p className="mt-2 break-words text-[9px] leading-4 text-destructive">{status.reason}</p> : null}
    </article>
  );
}

function CandidateTable({
  snapshot,
  loading,
  error,
  selection,
  disabled,
  onToggleSymbol,
}: {
  snapshot?: AiSimulationCandidateSnapshot;
  loading: boolean;
  error?: string;
  selection: AiSimulationCryptoRequest["selection"];
  disabled: boolean;
  onToggleSymbol: (symbol: string) => void;
}) {
  const selectedSymbols = selection.mode === "auto"
    ? new Set(
      snapshot?.candidates.filter(({ eligible }) => eligible)
        .slice(0, selection.symbolCount)
        .map(({ symbol }) => symbol) ?? [],
    )
    : new Set(selection.symbols);
  const selectedCandidates = snapshot?.candidates.filter(
    ({ symbol }) => selectedSymbols.has(symbol),
  ) ?? [];
  return (
    <section className="rounded-2xl bg-secondary p-4" data-crypto-scanner>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-black">실시간 선물 scanner</p>
          <p className="mt-1 text-[9px] leading-4 text-muted-foreground">
            거래대금 상위·스프레드 10bp 이하 범위에서 유동성과 확정봉 변동성을 평가합니다.
          </p>
        </div>
        <span
          className="max-w-full truncate rounded-full bg-card px-3 py-1.5 text-[9px] font-black"
          data-crypto-scanner-snapshot={snapshot?.snapshotId ?? "unavailable"}
          title={snapshot?.snapshotId}
        >
          {loading ? "scan 중" : `snapshot ${snapshot?.snapshotId ?? "unavailable"}`}
        </span>
      </div>
      {loading ? (
        <div className="mt-4 flex items-center gap-2 rounded-2xl bg-card p-4 text-xs text-muted-foreground" role="status">
          <LoaderCircle className="size-4 animate-spin" /> Binance 공개 시장 데이터를 확인하고 있습니다.
        </div>
      ) : error ? (
        <p className="mt-4 rounded-2xl bg-destructive/10 p-4 text-xs text-destructive" role="alert">{error}</p>
      ) : snapshot?.candidates.length ? (
        <div
          className="mt-4 max-h-[32rem] overflow-auto"
          role="region"
          aria-label="암호화폐 선물 scanner 상위 50개 순위 스크롤"
          tabIndex={0}
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            event.currentTarget.scrollBy({
              left: (event.key === "ArrowRight" ? 1 : -1)
                * Math.max(80, event.currentTarget.clientWidth * 0.65),
              behavior: "auto",
            });
          }}
        >
          <table className="w-full min-w-[630px] border-separate border-spacing-y-1.5 text-left text-[9px]">
            <thead className="text-muted-foreground">
              <tr>
                <th className="px-3 py-1">선택</th>
                <th className="px-3 py-1">순위 · 계약</th>
                <th className="px-3 py-1">점수</th>
                <th className="px-3 py-1">현재 / Mark</th>
                <th className="px-3 py-1">60m 변동성</th>
                <th className="px-3 py-1">ATR</th>
                <th className="px-3 py-1">스프레드</th>
                <th className="px-3 py-1">24h 거래대금</th>
                <th className="px-3 py-1">품질</th>
              </tr>
            </thead>
            <tbody>
              {snapshot.candidates.slice(0, 50).map((candidate, index) => (
                <tr
                  key={candidate.symbol}
                  className={cn(
                    "bg-card",
                    selectedSymbols.has(candidate.symbol) && "outline outline-1 outline-cyan-500/50",
                  )}
                  data-crypto-candidate={candidate.symbol}
                  data-candidate-eligible={candidate.eligible}
                  data-candidate-selected={selectedSymbols.has(candidate.symbol)}
                >
                  <td className="rounded-l-xl px-3 py-3">
                    <button
                      type="button"
                      aria-label={`${candidate.symbol} ${selectedSymbols.has(candidate.symbol) ? "선택 해제" : "선택"}`}
                      aria-pressed={selectedSymbols.has(candidate.symbol)}
                      disabled={disabled || !candidate.eligible || selection.mode === "auto"}
                      onClick={() => onToggleSymbol(candidate.symbol)}
                      className="grid size-7 place-items-center rounded-lg bg-secondary disabled:opacity-50"
                    >
                      {selectedSymbols.has(candidate.symbol) ? <Check className="size-3.5" /> : null}
                    </button>
                  </td>
                  <td className="px-3 py-3 font-black">#{candidate.rank ?? index + 1} · {candidate.symbol}</td>
                  <td className="px-3 py-3 font-black">{decimal(candidate.score, 3)}</td>
                  <td className="px-3 py-3">
                    {candidate.markPrice !== undefined || candidate.currentPrice !== undefined
                      ? formatMoney(candidate.markPrice ?? candidate.currentPrice ?? 0, "USDT")
                      : "unavailable"}
                  </td>
                  <td className="px-3 py-3">{percent(candidate.realizedVolatility60m)}</td>
                  <td className="px-3 py-3">{percent(candidate.atrPercent)}</td>
                  <td className={cn("px-3 py-3", (candidate.spreadBps ?? 0) > 10 && "text-destructive")}>{decimal(candidate.spreadBps, 1)}bp</td>
                  <td className="px-3 py-3">{compact(candidate.tradingAmount)} USDT</td>
                  <td className="rounded-r-xl px-3 py-3">
                    <span className={cn(
                      "rounded-full px-2 py-1 font-black",
                      candidate.eligible
                        ? "bg-cyan-500/10 text-cyan-700 dark:text-cyan-300"
                        : "bg-destructive/10 text-destructive",
                    )}>
                      {candidate.eligible ? candidate.quality.status : "제외"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="mt-4 rounded-2xl bg-card p-4 text-xs text-muted-foreground">
          조건을 통과한 후보가 없습니다. 새 snapshot으로 다시 확인해 주세요.
        </p>
      )}
      {selectedCandidates.length ? (
        <details className="mt-3 rounded-2xl bg-card p-4" data-crypto-selection-evidence>
          <summary className="cursor-pointer text-[10px] font-black">
            {selection.mode === "auto" ? "자동 선정" : "직접 선택"} · {selectedCandidates.map(({ symbol }) => symbol).join(", ")}
          </summary>
          <div className="mt-3 space-y-2">
            {selectedCandidates.map((candidate) => (
              <article key={candidate.symbol} className="rounded-xl bg-secondary p-3">
                <p className="text-[9px] font-black">{candidate.symbol}</p>
                <p className="mt-1 break-words text-[8px] leading-4 text-muted-foreground">
                  {Object.entries(candidate.scoreComponents)
                    .map(([key, value]) => `${key} ${decimal(value, 4)}`)
                    .join(" · ") || "점수 구성 unavailable"}
                  {" · "}품질 {candidate.quality.status}
                </p>
              </article>
            ))}
          </div>
        </details>
      ) : null}
      {snapshot?.warnings.length ? (
        <ul className="mt-3 list-disc space-y-1 pl-5 text-[9px] leading-4 text-destructive">
          {snapshot.warnings.map((warning) => <li key={warning}>{warning}</li>)}
        </ul>
      ) : null}
      {snapshot?.generatedAt ? <p className="mt-3 text-right text-[8px] text-muted-foreground">생성 {timestamp(snapshot.generatedAt)}</p> : null}
    </section>
  );
}

export function toggleCryptoModelLane(
  current: AiSimulationCryptoRequest["modelLanes"],
  lane: AiSimulationModelLane,
): AiSimulationCryptoRequest["modelLanes"] {
  if (current.includes(lane) && current.length === 1) return current;
  const toggled = current.includes(lane)
    ? current.filter((item) => item !== lane)
    : [...current, lane];
  const canonical = (["kronos_base", "fincast"] as const)
    .filter((item) => toggled.includes(item));
  if (canonical.length === 2) return ["kronos_base", "fincast"];
  return canonical[0] === "fincast" ? ["fincast"] : ["kronos_base"];
}

export function AiSimulationCryptoSetup({
  request,
  status,
  candidateSnapshot,
  candidateLoading,
  candidateError,
  issues,
  error,
  disabled,
  starting,
  active,
  cancelling,
  cancelRequested,
  onRequestChange,
  onRefreshCandidates,
  onStart,
  onCancel,
  limits,
}: {
  request: AiSimulationCryptoRequest;
  status?: AiSimulationCryptoStatus;
  candidateSnapshot?: AiSimulationCandidateSnapshot;
  candidateLoading: boolean;
  candidateError?: string;
  issues: string[];
  error?: string;
  disabled: boolean;
  starting: boolean;
  active: boolean;
  cancelling: boolean;
  cancelRequested: boolean;
  onRequestChange: (request: AiSimulationCryptoRequest) => void;
  onRefreshCandidates: () => void;
  onStart: () => void;
  onCancel: () => void;
  limits?: {
    minimumDurationMinutes?: number;
    maximumDurationMinutes?: number;
  };
}) {
  const paperGateOpen = status?.executionGates.paper === true;
  const selectedWorkersAvailable = request.modelLanes.every(
    (lane) => status?.workers[lane]?.available === true,
  );
  const eligibleCandidates = candidateSnapshot?.candidates.filter(
    ({ eligible }) => eligible,
  ) ?? [];
  const selectionReady = request.selection.mode === "auto"
    ? eligibleCandidates.length >= request.selection.symbolCount
    : request.selection.symbols.length >= 1
      && request.selection.symbols.length <= 2
      && request.selection.symbols.every((symbol) => (
        eligibleCandidates.some((candidate) => candidate.symbol === symbol)
      ));
  const runtimeGateMessage = active
    ? undefined
    : !paperGateOpen
    ? "서버의 paper 실행 gate가 열릴 때까지 시작할 수 없습니다."
    : !selectedWorkersAvailable
      ? "선택한 모든 모델 worker가 사용 가능해야 시작할 수 있습니다."
      : undefined;
  const toggleLane = (lane: AiSimulationModelLane) => {
    const selected = request.modelLanes.includes(lane);
    if (selected && request.modelLanes.length === 1) return;
    const next = toggleCryptoModelLane(request.modelLanes, lane);
    onRequestChange({
      ...request,
      modelLanes: next,
    });
  };
  const toggleManualSymbol = (symbol: string) => {
    if (request.selection.mode !== "manual") return;
    const selected = request.selection.symbols.includes(symbol);
    const symbols = selected
      ? request.selection.symbols.filter((item) => item !== symbol)
      : request.selection.symbols.length < 2
        ? [...request.selection.symbols, symbol]
        : request.selection.symbols;
    onRequestChange({
      ...request,
      selection: { mode: "manual", symbols },
    });
  };

  return (
    <Card className="bg-card p-5 sm:p-7" data-crypto-simulation-setup>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-[10px] font-black tracking-[0.12em] text-muted-foreground">CRYPTO FUTURES · PAPER</p>
          <h2 className="mt-1 text-xl font-black">USDT 무기한 선물 shadow 설정</h2>
          <p className="mt-2 max-w-2xl text-xs leading-5 text-muted-foreground">
            isolated 단방향 원장으로 롱·숏을 모의 체결합니다. 실주문과 testnet 주문은 이 배포에서 전송하지 않습니다.
          </p>
        </div>
        <span className="rounded-full bg-cyan-500/10 px-3 py-1.5 text-[10px] font-black text-cyan-700 dark:text-cyan-300">
          {request.durationMinutes}분 · 위험 {(request.riskLimits.riskPerTradeRate * 100).toFixed(2)}%
          {" · "}최대 {request.riskLimits.maximumLeverage}×
        </span>
      </div>

      <div className="mt-5 grid gap-3 lg:grid-cols-[0.9fr_1.1fr]">
        <section className="rounded-2xl bg-secondary p-4" aria-label="실행 capability">
          <div className="flex items-center gap-2"><ShieldCheck className="size-4" /><p className="text-xs font-black">실행 gate</p></div>
          <div className="mt-3 grid gap-2 sm:grid-cols-3 lg:grid-cols-1 xl:grid-cols-3">
            <CapabilityCard label="PAPER" enabled={paperGateOpen} detail="현재 허용 · 가상 원장" />
            <CapabilityCard label="TESTNET" enabled={status?.executionGates.testnet ?? false} detail="qualification 전 잠금" />
            <CapabilityCard label="LIVE" enabled={status?.executionGates.live ?? false} detail="명시 승인 전 잠금" />
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <p className="rounded-xl bg-card p-3 text-[9px] leading-4"><LockKeyhole className="mb-2 size-3.5" /><strong>자격 증명</strong><br /><span className="text-muted-foreground">{status?.credentialsConfigured ? "서버 설정됨" : "미설정 또는 숨김"}</span></p>
            <p className="rounded-xl bg-card p-3 text-[9px] leading-4"><Database className="mb-2 size-3.5" /><strong>signed read</strong><br /><span className="text-muted-foreground">{status?.signedReadSucceeded ? "성공" : "미확인"}</span></p>
          </div>
        </section>
        <section className="grid gap-3 sm:grid-cols-2" aria-label="모델 worker 상태">
          <WorkerCard lane="kronos_base" status={status?.workers.kronos_base} />
          <WorkerCard lane="fincast" status={status?.workers.fincast} />
        </section>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-2xl bg-secondary p-3">
          <span className="mb-2 block text-[10px] font-black text-muted-foreground">대상 시장</span>
          <p className="rounded-xl bg-card px-3 py-2.5 text-xs font-black" aria-label="암호화폐 대상 시장">
            Binance USDⓈ-M · USDT 무기한
          </p>
        </div>
        <label className="rounded-2xl bg-secondary p-3">
          <span className="mb-2 block text-[10px] font-black text-muted-foreground">종목 선택 방식</span>
          <Select
            value={request.selection.mode}
            disabled={disabled}
            onValueChange={(value) => onRequestChange({
              ...request,
              selection: value === "manual"
                ? { mode: "manual", symbols: [] }
                : { mode: "auto", criterion: "volatility", symbolCount: 1 },
            })}
          >
            <SelectTrigger className="w-full bg-card" aria-label="암호화폐 종목 선택 방식"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">거래 지표로 자동 선정</SelectItem>
              <SelectItem value="manual">Scanner에서 직접 선택</SelectItem>
            </SelectContent>
          </Select>
        </label>
        <label className="rounded-2xl bg-secondary p-3">
          <span className="mb-2 block text-[10px] font-black text-muted-foreground">판단 프리셋</span>
          <Select
            value={request.preset}
            disabled={disabled}
            onValueChange={(value) => {
              const preset = value as AiSimulationCryptoRequest["preset"];
              onRequestChange({
                ...request,
                preset,
                riskTolerance: CRYPTO_PRESET_DETAILS[preset].recommendedRisk,
              });
            }}
          >
            <SelectTrigger className="w-full bg-card" aria-label="암호화폐 판단 프리셋"><SelectValue /></SelectTrigger>
            <SelectContent>
              {Object.entries(CRYPTO_PRESET_DETAILS).map(([value, details]) => (
                <SelectItem key={value} value={value}>{details.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        <fieldset className="rounded-2xl bg-secondary p-3">
          <legend className="px-1 text-[10px] font-black text-muted-foreground">독립 모델 lane</legend>
          <div className="mt-1 flex min-h-10 items-center gap-2">
            {(["kronos_base", "fincast"] as const).map((lane) => {
              const selected = request.modelLanes.includes(lane);
              const workerAvailable = status?.workers[lane]?.available ?? false;
              return (
                <button
                  key={lane}
                  type="button"
                  aria-pressed={selected}
                  disabled={disabled || (!selected && !workerAvailable)}
                  onClick={() => toggleLane(lane)}
                  data-model-lane-toggle={lane}
                  className={cn(
                    "flex-1 rounded-xl px-2 py-2 text-[9px] font-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40",
                    selected ? "bg-card text-foreground" : "text-muted-foreground",
                  )}
                >
                  {selected ? <Check className="mr-1 inline size-3" /> : null}{MODEL_LABELS[lane]}
                </button>
              );
            })}
          </div>
        </fieldset>
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-[1.2fr_0.8fr]">
        <div className="rounded-2xl bg-secondary p-4">
          <p className="text-xs font-black">{CRYPTO_PRESET_DETAILS[request.preset].label}</p>
          <p className="mt-1 text-[9px] leading-4 text-muted-foreground">
            {CRYPTO_PRESET_DETAILS[request.preset].description}
          </p>
        </div>
        <label className="rounded-2xl bg-secondary p-4">
          <span className="flex items-center justify-between gap-3 text-[10px] font-black text-muted-foreground">
            <span>공격·방어 성향</span>
            <span className="rounded-full bg-card px-2.5 py-1 text-foreground">
              {cryptoRiskDisposition(request.riskTolerance)} {request.riskTolerance}
            </span>
          </span>
          <input
            aria-label="암호화폐 공격 방어 성향"
            type="range"
            min={0}
            max={100}
            step={1}
            value={request.riskTolerance}
            disabled={disabled}
            onChange={(event) => onRequestChange({
              ...request,
              riskTolerance: Number(event.target.value),
            })}
            className="mt-4 h-2 w-full cursor-pointer accent-primary disabled:cursor-not-allowed"
          />
          <span className="mt-2 flex justify-between text-[9px] font-black text-muted-foreground">
            <span>방어 · 높은 확인 기준</span>
            <span>공격 · 높은 배분</span>
          </span>
        </label>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {request.selection.mode === "auto" ? (
        <label className="rounded-2xl bg-secondary p-3">
          <span className="mb-2 block text-[10px] font-black text-muted-foreground">Scanner 순위</span>
          <Select
            value={request.selection.criterion}
            disabled={disabled}
            onValueChange={(value) => onRequestChange({
              ...request,
              selection: {
                mode: "auto",
                criterion: value as AiSimulationCriterion,
                symbolCount: request.selection.mode === "auto"
                  ? request.selection.symbolCount
                  : 1,
              },
            })}
          >
            <SelectTrigger className="w-full bg-card" aria-label="암호화폐 scanner 기준"><SelectValue /></SelectTrigger>
            <SelectContent>
              {Object.entries(CRITERION_LABELS).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}
            </SelectContent>
          </Select>
        </label>
        ) : (
          <div className="rounded-2xl bg-secondary p-3">
            <span className="mb-2 block text-[10px] font-black text-muted-foreground">Scanner 직접 선택</span>
            <p className="rounded-xl bg-card px-3 py-2.5 text-xs font-black">
              {request.selection.symbols.length}/2 계약 선택
            </p>
          </div>
        )}
        {request.selection.mode === "auto" ? (
          <label className="rounded-2xl bg-secondary p-3">
            <span className="mb-2 block text-[10px] font-black text-muted-foreground">선정 계약 수</span>
            <Select
              value={String(request.selection.symbolCount)}
              disabled={disabled}
              onValueChange={(value) => onRequestChange({
                ...request,
                selection: {
                  mode: "auto",
                  criterion: request.selection.mode === "auto"
                    ? request.selection.criterion
                    : "volatility",
                  symbolCount: Number(value) as 1 | 2,
                },
              })}
            >
              <SelectTrigger className="w-full bg-card" aria-label="암호화폐 선정 계약 수"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="1">1계약 · 단일</SelectItem>
                <SelectItem value="2">2계약 · 독립 비교</SelectItem>
              </SelectContent>
            </Select>
          </label>
        ) : (
          <div className="rounded-2xl bg-secondary p-3">
            <span className="mb-2 block text-[10px] font-black text-muted-foreground">전략 실행 방식</span>
            <p className="rounded-xl bg-card px-3 py-2.5 text-xs font-black">
              {request.selection.symbols.length === 2 ? "2계약 독립 비교" : "단일 계약"}
            </p>
          </div>
        )}
        <label className="rounded-2xl bg-secondary p-3">
          <span className="mb-2 block text-[10px] font-black text-muted-foreground">시작 자산 · USDT</span>
          <Input
            aria-label="암호화폐 시작 자산"
            type="number"
            min={AI_SIMULATION_CRYPTO_MINIMUM_INITIAL_CASH}
            max={AI_SIMULATION_CRYPTO_MAXIMUM_INITIAL_CASH}
            step={100}
            value={request.initialCash}
            disabled={disabled}
            className="bg-card"
            onChange={(event) => onRequestChange({ ...request, initialCash: Number(event.target.value) })}
          />
        </label>
        <label className="rounded-2xl bg-secondary p-3">
          <span className="mb-2 block text-[10px] font-black text-muted-foreground">Shadow 기간 · 분</span>
          <Input
            aria-label="암호화폐 테스트 기간"
            type="number"
            min={limits?.minimumDurationMinutes ?? 1}
            max={limits?.maximumDurationMinutes}
            step={1}
            value={request.durationMinutes}
            disabled={disabled}
            className="bg-card"
            onChange={(event) => onRequestChange({ ...request, durationMinutes: Number(event.target.value) })}
          />
        </label>
      </div>

      <div className="mt-3 flex flex-col gap-3 rounded-2xl bg-secondary p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <Waves className="mt-0.5 size-4 shrink-0" />
          <p className="text-[9px] leading-4 text-muted-foreground">
            자동 선정은 60초 이내 snapshot을 재사용하며, 선택 근거와 점수 구성요소를 실행 artifact에 보존합니다.
          </p>
        </div>
        <Button type="button" variant="secondary" size="sm" disabled={candidateLoading || disabled} onClick={onRefreshCandidates}>
          {candidateLoading ? <LoaderCircle className="animate-spin" /> : <RefreshCw />} 새로 스캔
        </Button>
      </div>

      <div className="mt-3">
        <CandidateTable
          snapshot={candidateSnapshot}
          loading={candidateLoading}
          error={candidateError}
          selection={request.selection}
          disabled={disabled}
          onToggleSymbol={toggleManualSymbol}
        />
      </div>

      <details className="mt-3 rounded-2xl bg-secondary p-4">
        <summary className="cursor-pointer text-xs font-black">비용 가정 · bps</summary>
        <p className="mt-2 text-[9px] leading-4 text-muted-foreground">
          Binance taker 수수료, 관측 스프레드와 다음 유효 체결 슬리피지를 비용 후 신호에 반영합니다. funding은 실제 mark-price 주기에 따라 별도 원장화합니다.
        </p>
        <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          {([
            ["commissionBpsPerSide", "편도 수수료"],
            ["taxBpsOnExit", "청산 거래세"],
            ["spreadBpsRoundTrip", "왕복 스프레드"],
            ["slippageBpsPerSide", "편도 슬리피지"],
          ] as const).map(([key, label]) => (
            <label key={key} className="rounded-xl bg-card p-3">
              <span className="mb-2 block text-[9px] font-black text-muted-foreground">{label}</span>
              <Input
                aria-label={`암호화폐 ${label} bps`}
                type="number"
                min={0}
                step={0.1}
                disabled={disabled}
                value={request.costs[key]}
                className="h-10 bg-secondary text-xs"
                onChange={(event) => onRequestChange({
                  ...request,
                  costs: { ...request.costs, [key]: Number(event.target.value) },
                })}
              />
            </label>
          ))}
        </div>
      </details>

      <details className="mt-3 rounded-2xl bg-secondary p-4" open>
        <summary className="cursor-pointer text-xs font-black">Paper 위험 한도 · 직접 설정</summary>
        <p className="mt-2 text-[9px] leading-4 text-muted-foreground">
          아래 값은 이 실행의 가상 원장에만 적용됩니다. 배포에 고정된 안전선 안에서 더 보수적으로만
          조정할 수 있으며, hard envelope보다 완화할 수 없습니다. 실주문 capability와 live/testnet
          gate에는 영향을 주지 않습니다.
        </p>
        <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {([
            ["riskPerTradeRate", "거래당 위험", 0.1, 0.5, 0.1, 100, "%"],
            ["dailyLossLimitRate", "UTC 일손실 중단선", 0.5, 3, 0.5, 100, "%"],
            ["maximumLeverage", "최대 레버리지", 1, 15, 1, 1, "×"],
            ["grossExposureLimitRate", "Gross exposure 상한", 10, 150, 5, 100, "%"],
            ["marginUsageLimitRate", "증거금 사용률 상한", 5, 20, 5, 100, "%"],
            ["liquidationBufferMultiple", "청산 buffer / 손절", 2, 5, 0.25, 1, "×"],
          ] as const).map(([key, label, minimum, maximum, step, displayScale, unit]) => (
            <label key={key} className="rounded-xl bg-card p-3">
              <span className="mb-2 flex items-center justify-between gap-2 text-[9px] font-black text-muted-foreground">
                <span>{label}</span>
                <span className="text-foreground">
                  {(request.riskLimits[key] * displayScale).toFixed(
                    key === "maximumLeverage" ? 0 : key === "liquidationBufferMultiple" ? 2 : 1,
                  )}{unit}
                </span>
              </span>
              <Input
                aria-label={`암호화폐 ${label}`}
                type="number"
                min={minimum}
                max={maximum}
                step={step}
                disabled={disabled}
                value={request.riskLimits[key] * displayScale}
                className="h-10 bg-secondary text-xs"
                onChange={(event) => onRequestChange({
                  ...request,
                  riskLimits: {
                    ...request.riskLimits,
                    [key]: Number(event.target.value) / displayScale,
                  },
                })}
              />
            </label>
          ))}
        </div>
      </details>

      {issues.length ? (
        <ul className="mt-3 rounded-2xl bg-destructive/10 p-4 text-xs text-destructive" role="alert">
          {issues.map((issue) => <li key={issue}>{issue}</li>)}
        </ul>
      ) : null}
      {error ? (
        <p className="mt-3 rounded-2xl bg-destructive/10 p-4 text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}

      <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-[9px] leading-4 text-muted-foreground">
          확정봉만 판단을 유발하고, 결정 이후 최초 유효 aggTrade 또는 다음 확정봉 open만 체결에 사용합니다.
        </p>
        {active ? (
          <Button
            type="button"
            size="lg"
            variant="secondary"
            disabled={cancelling || cancelRequested}
            onClick={onCancel}
            data-crypto-simulation-stop
          >
            {cancelling || cancelRequested
              ? <LoaderCircle className="animate-spin" />
              : <Square />}
            {cancelling || cancelRequested ? "중단 처리 중" : "테스트 중단"}
          </Button>
        ) : (
          <Button
            type="button"
            size="lg"
            aria-describedby={runtimeGateMessage ? "crypto-runtime-gate-message" : undefined}
            disabled={disabled
              || starting
              || issues.length > 0
              || !selectionReady
              || !paperGateOpen
              || !selectedWorkersAvailable}
            onClick={onStart}
            data-crypto-simulation-start
          >
            {starting ? <LoaderCircle className="animate-spin" /> : <Play />}
            {request.durationMinutes}분 paper 시작
          </Button>
        )}
      </div>
      {runtimeGateMessage ? (
        <p
          id="crypto-runtime-gate-message"
          role="status"
          className="mt-3 rounded-2xl bg-secondary p-3 text-[9px] text-muted-foreground"
        >
          {runtimeGateMessage}
        </p>
      ) : null}
      {!status?.executionGates.live ? (
        <p className="mt-3 flex items-center gap-2 rounded-2xl bg-destructive/5 p-3 text-[9px] text-muted-foreground">
          <AlertTriangle className="size-3.5 shrink-0 text-destructive" /> realOrder capability false · 읽기 전용 키로 주문을 전송하지 않습니다.
        </p>
      ) : null}
    </Card>
  );
}
