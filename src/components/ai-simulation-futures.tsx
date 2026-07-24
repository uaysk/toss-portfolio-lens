import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  CheckCircle2,
  ExternalLink,
  Gauge,
  GitCompareArrows,
  ShieldAlert,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import type {
  AiSimulationFuturesPosition,
  AiSimulationFuturesRisk,
  AiSimulationModelComparison,
  AiSimulationModelComparisonLane,
} from "@/lib/ai-simulation";
import { formatMoney, formatQuantity } from "@/lib/format";
import { cn } from "@/lib/utils";

const MODEL_LABELS: Record<AiSimulationModelComparisonLane["id"], string> = {
  kronos_base: "Kronos-base",
  fincast: "FinCast",
};

function ratio(value?: number, signed = false): string {
  if (!Number.isFinite(value)) return "unavailable";
  const percent = (value as number) * 100;
  return `${signed && percent > 0 ? "+" : ""}${percent.toFixed(2)}%`;
}

function decimal(value?: number, digits = 3): string {
  return Number.isFinite(value) ? (value as number).toFixed(digits) : "unavailable";
}

function money(value?: number): string {
  return Number.isFinite(value) ? formatMoney(value as number, "USDT") : "unavailable";
}

function Metric({
  label,
  value,
  className,
}: {
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div className="min-w-0 rounded-xl bg-card p-3">
      <p className="text-[8px] font-black text-muted-foreground">{label}</p>
      <p className={cn("mt-1 break-words text-[10px] font-black", className)}>{value}</p>
    </div>
  );
}

function PositionCard({ position }: { position: AiSimulationFuturesPosition }) {
  const long = position.side === "long";
  const pnl = position.unrealizedPnl;
  return (
    <article
      className="min-w-0 rounded-2xl bg-secondary p-4"
      data-futures-position={position.symbol}
      data-futures-position-side={position.side}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className={cn(
            "grid size-9 place-items-center rounded-xl",
            long ? "bg-cyan-500/10 text-cyan-500" : "bg-amber-500/10 text-amber-500",
          )}>
            {long ? <ArrowUpRight className="size-4" /> : <ArrowDownRight className="size-4" />}
          </span>
          <div>
            <p className="text-sm font-black">{position.symbol}</p>
            <p className={cn("mt-0.5 text-[9px] font-black uppercase", long ? "text-cyan-500" : "text-amber-500")}>
              {position.side} · isolated {position.leverage}×
            </p>
          </div>
        </div>
        <p className={cn(
          "rounded-full px-3 py-1.5 text-xs font-black",
          !Number.isFinite(pnl)
            ? "bg-card text-muted-foreground"
            : (pnl as number) >= 0
              ? "bg-cyan-500/10 text-cyan-600 dark:text-cyan-300"
              : "bg-destructive/10 text-destructive",
        )}>
          {pnl !== undefined && pnl >= 0 ? "+" : ""}{money(pnl)}
        </p>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Metric label="수량" value={formatQuantity(position.quantity)} />
        <Metric label="명목가" value={money(position.notional)} />
        <Metric label="격리 증거금" value={money(position.initialMargin)} />
        <Metric label="유지 증거금" value={money(position.maintenanceMargin)} />
        <Metric label="진입가" value={money(position.entryPrice)} />
        <Metric label="Mark price" value={money(position.markPrice)} />
        <Metric label="보호 손절" value={money(position.protectiveStopPrice)} />
        <Metric
          label="추정 청산가 · buffer"
          value={`${money(position.liquidationPrice)} · ${ratio(position.liquidationBufferRatio)}`}
          className={(position.liquidationBufferRatio ?? 1) < 0.03 ? "text-destructive" : undefined}
        />
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Metric label="실현 PnL" value={money(position.realizedPnl)} />
        <Metric label="Funding" value={money(position.funding)} />
        <Metric label="수수료" value={money(position.fees)} />
        <Metric label="슬리피지" value={money(position.slippage)} />
      </div>
    </article>
  );
}

export function AiSimulationFuturesLedger({
  positions,
  risk,
}: {
  positions: readonly AiSimulationFuturesPosition[];
  risk?: AiSimulationFuturesRisk;
}) {
  return (
    <Card className="min-w-0 bg-card p-5 sm:p-6" data-futures-ledger>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-black tracking-[0.12em] text-muted-foreground">FUTURES LEDGER</p>
          <h2 className="mt-1 text-lg font-black">격리 선물 포지션</h2>
        </div>
        <span
          className={cn(
            "rounded-full px-3 py-1.5 text-[9px] font-black",
            risk?.newEntriesBlocked
              ? "bg-destructive/10 text-destructive"
              : "bg-cyan-500/10 text-cyan-700 dark:text-cyan-300",
          )}
          data-futures-risk-gate={risk?.newEntriesBlocked ? "blocked" : "open"}
        >
          {risk?.newEntriesBlocked ? "신규 진입 중단" : "risk gate 정상"}
        </span>
      </div>

      <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <Metric label="거래당 위험" value={ratio(risk?.riskPerTradeRatio ?? 0.005)} />
        <Metric
          label="UTC 일손실 / 한도"
          value={`${ratio(risk?.dailyLossRatio)} / ${ratio(risk?.dailyLossLimitRatio ?? 0.03)}`}
          className={risk?.newEntriesBlocked ? "text-destructive" : undefined}
        />
        <Metric label="Gross exposure" value={ratio(risk?.grossExposureRatio)} />
        <Metric label="증거금 사용" value={ratio(risk?.marginUsageRatio)} />
      </div>
      {risk?.blockReason ? (
        <p className="mt-3 flex items-start gap-2 rounded-2xl bg-destructive/10 p-3 text-[10px] leading-4 text-destructive" role="alert">
          <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />{risk.blockReason}
        </p>
      ) : null}
      <div className="mt-3 space-y-3">
        {positions.length
          ? positions.map((position) => <PositionCard key={`${position.symbol}:${position.side}`} position={position} />)
          : <p className="rounded-2xl bg-secondary p-4 text-xs text-muted-foreground">다음 비용 초과 신호와 유효 체결을 기다리고 있습니다.</p>}
      </div>
      <p className="mt-3 text-[9px] leading-4 text-muted-foreground">
        한 종목 한 방향만 허용하며 반대 주문과 청산은 reduce-only입니다. 물타기와 동시 롱·숏은 허용하지 않습니다.
      </p>
    </Card>
  );
}

function LaneCard({ lane }: { lane: AiSimulationModelComparisonLane }) {
  const metrics = lane.metrics;
  const ready = ["available", "complete", "completed", "running", "ready"].includes(lane.status.toLowerCase());
  return (
    <article
      className="min-w-0 rounded-2xl bg-secondary p-4"
      data-model-lane={lane.id}
      data-model-lane-status={lane.status}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-sm font-black">{MODEL_LABELS[lane.id]}</p>
          <p className="mt-1 text-[9px] text-muted-foreground">독립 lane · {lane.precision}</p>
        </div>
        <span className={cn(
          "rounded-full px-2.5 py-1 text-[8px] font-black",
          ready
            ? "bg-cyan-500/10 text-cyan-700 dark:text-cyan-300"
            : "bg-destructive/10 text-destructive",
        )}>
          {lane.status}
        </span>
      </div>
      {lane.unavailableReason ? <p className="mt-3 break-words text-[9px] leading-4 text-destructive">{lane.unavailableReason}</p> : null}
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Metric label="Pinball loss" value={decimal(metrics.pinballLoss)} />
        <Metric label="Median MAE" value={decimal(metrics.medianReturnMae)} />
        <Metric label="방향 정확도" value={ratio(metrics.directionAccuracy)} />
        <Metric label="Quantile coverage" value={ratio(metrics.quantileCoverage)} />
        <Metric label="비용 후 PnL" value={money(metrics.netPnl)} />
        <Metric label="Profit factor" value={decimal(metrics.profitFactor, 2)} />
        <Metric label="Win rate" value={ratio(metrics.winRate)} />
        <Metric label="Max drawdown" value={ratio(metrics.maxDrawdown)} />
        <Metric label="Turnover" value={decimal(metrics.turnover, 2)} />
        <Metric label="추론 latency" value={metrics.latencyMs !== undefined ? `${metrics.latencyMs.toFixed(0)}ms` : "unavailable"} />
        <Metric label="Availability" value={ratio(metrics.availabilityRatio)} />
        <Metric label="Peak VRAM" value={metrics.peakVramMb !== undefined ? `${metrics.peakVramMb.toFixed(0)}MB` : "unavailable"} />
      </div>
    </article>
  );
}

export function AiSimulationModelComparisonPanel({
  comparison,
}: {
  comparison?: AiSimulationModelComparison;
}) {
  const conditions = [
    ["동일 origin", comparison?.sameOrigin],
    ["동일 context", comparison?.sameContext],
    ["동일 비용", comparison?.sameCosts],
    ["공통 fill barrier", comparison?.sameFillBarrier],
  ] as const;
  return (
    <Card className="min-w-0 bg-card p-5 sm:p-6" data-model-comparison={comparison?.outcome ?? "pending"}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-secondary"><GitCompareArrows className="size-4" /></span>
          <div>
            <p className="text-[10px] font-black tracking-[0.12em] text-muted-foreground">MODEL COMPARISON</p>
            <h2 className="mt-1 text-lg font-black">Kronos · FinCast 독립 비교</h2>
            <p className="mt-1 text-[9px] leading-4 text-muted-foreground">자동 우승자·fallback 위장·즉시 앙상블 없이 원본 lane을 그대로 표시합니다.</p>
          </div>
        </div>
        <span className="rounded-full bg-secondary px-3 py-1.5 text-[9px] font-black">
          {comparison?.outcome ?? "pending"}
        </span>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {conditions.map(([label, passed]) => (
          <p key={label} className="flex items-center gap-2 rounded-xl bg-secondary p-3 text-[9px] font-black">
            {passed ? <CheckCircle2 className="size-3.5 text-cyan-500" /> : <AlertTriangle className="size-3.5 text-destructive" />}
            {label}
          </p>
        ))}
      </div>
      <div className="mt-3 grid gap-3 xl:grid-cols-2">
        {comparison?.lanes.length
          ? comparison.lanes.map((lane) => <LaneCard key={lane.id} lane={lane} />)
          : (
            <div className="rounded-2xl bg-secondary p-4 text-xs text-muted-foreground xl:col-span-2">
              직전 완결 7일 walk-forward 및 120분 shadow 결과가 아직 없습니다. 결과가 부족하면 그대로 inconclusive로 남습니다.
            </div>
          )}
      </div>
      <div className="mt-4 flex flex-col gap-3 rounded-2xl bg-secondary p-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="flex items-center gap-2 text-[9px] leading-4 text-muted-foreground">
          <Gauge className="size-3.5 shrink-0" /> 승격은 검토 후 서버 champion 설정으로만 수행됩니다.
        </p>
        <a
          href="/reports/crypto-scalping-model-comparison.html"
          target="_blank"
          rel="noreferrer"
          className="inline-flex min-h-10 items-center justify-center gap-2 rounded-xl bg-card px-4 text-[10px] font-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          data-crypto-comparison-report-link
        >
          단일 파일 비교 보고서 <ExternalLink className="size-3.5" />
        </a>
      </div>
    </Card>
  );
}
