import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Activity,
  AlertTriangle,
  BrainCircuit,
  CircleDashed,
  FlaskConical,
  LoaderCircle,
  Radio,
  RefreshCw,
  ShieldAlert,
  Wifi,
  WifiOff,
} from "lucide-react";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatMoney, formatQuantity } from "@/lib/format";
import {
  SCALPING_CRITERIA,
  SCALPING_INTERVALS,
  SCALPING_PRESETS,
  mergeScalpingStreamEvent,
  normalizeScalpingEvaluationMetrics,
  normalizeScalpingEvaluationReceipt,
  normalizeScalpingForecasts,
  normalizeScalpingStatus,
  normalizeScalpingWorkspace,
  parseScalpingStreamEvent,
  scalpingErrorMessage,
  scalpingStreamUrl,
  scalpingTradeMarkerPoints,
  validateScalpingRequest,
  type ScalpingCandidate,
  type ScalpingCriterion,
  type ScalpingEvaluationReceipt,
  type ScalpingEvaluationMetric,
  type ScalpingForecast,
  type ScalpingInterval,
  type ScalpingPreset,
  type ScalpingRequest,
  type ScalpingSignal,
  type ScalpingStatus,
  type ScalpingTradeMarker,
  type ScalpingWorkspace,
} from "@/lib/scalping-assistant";
import { loadAdvancedArtifact, loadAdvancedRunSnapshot } from "@/lib/advanced-analysis";
import { cn } from "@/lib/utils";
import type { Portfolio, Theme } from "@/types";

const SCALPING_CHART_SYNC_ID = "scalping-assistant-shared-time";
const DEFAULT_REQUEST: ScalpingRequest = {
  criterion: "trading_amount",
  topCount: 10,
  interval: "1m",
  layoutColumns: 2,
  preset: "trend",
};

const CRITERION_LABELS: Record<ScalpingCriterion, string> = {
  trading_amount: "거래대금",
  volume: "거래량",
  volatility: "변동성",
};

const PRESET_LABELS: Record<ScalpingPreset, { label: string; description: string }> = {
  trend: { label: "추세", description: "VWAP·다중 시간대 추세" },
  breakout: { label: "돌파", description: "시가 범위·전일 고저" },
  mean_reversion: { label: "평균회귀", description: "VWAP 이격·밴드 복귀" },
  risk_management: { label: "위험관리", description: "ATR·손절·손익비" },
};

const SIGNAL_LABELS: Record<NonNullable<ScalpingCandidate["signal"]>["state"], string> = {
  watch: "관망",
  entry_candidate: "진입 후보",
  hold: "보유 유지",
  exit_candidate: "청산 후보",
};

type ScalpingAssistantProps = {
  portfolio: Portfolio;
  theme: Theme;
  onUnauthorized: () => void;
};

type ChartRow = ScalpingCandidate["bars"][number] & { candleRange: [number, number] } & Record<string, unknown>;

const INDICATOR_LINE_FIELDS: Record<string, string[]> = {
  sma: ["value"],
  ema: ["value"],
  bollinger_bands: ["upper", "middle", "lower"],
  donchian_channel: ["upper", "middle", "lower"],
  keltner_channel: ["upper", "middle", "lower"],
  supertrend: ["supertrend", "value"],
  parabolic_sar: ["sar", "value"],
};

const INDICATOR_LINE_COLORS = ["#2563eb", "#e11d48", "#0d9488", "#8b5cf6", "#ca8a04", "#475569"] as const;

function finite(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function formatCompact(value: number | undefined): string {
  if (!finite(value)) return "unavailable";
  return new Intl.NumberFormat("ko-KR", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function formatRatio(value: number | undefined, signed = false): string {
  if (!finite(value)) return "unavailable";
  const percent = value * 100;
  return `${signed && percent > 0 ? "+" : ""}${percent.toFixed(2)}%`;
}

function formatProbability(value: number | undefined): string {
  return finite(value) ? `${(value * 100).toFixed(1)}%` : "unavailable";
}

function formatTimestamp(value: string | undefined, withDate = false): string {
  if (!value) return "unavailable";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "unavailable";
  return new Intl.DateTimeFormat("ko-KR", {
    ...(withDate ? { month: "short", day: "numeric" } : {}),
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function chartTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

async function readJson(response: Response): Promise<unknown> {
  return response.json().catch(() => ({}));
}

function chartGridClass(columns: 1 | 2 | 3 | 4): string {
  if (columns === 2) return "grid-cols-1 xl:grid-cols-2";
  if (columns === 3) return "grid-cols-1 lg:grid-cols-2 xl:grid-cols-3";
  if (columns === 4) return "grid-cols-1 lg:grid-cols-2 xl:grid-cols-4";
  return "grid-cols-1";
}

function availabilityClass(status: string): string {
  if (status === "available" || status === "good" || status === "ready" || status === "connected" || status === "configured") {
    return "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300";
  }
  if (status === "partial" || status === "stale" || status === "reconnecting") {
    return "bg-amber-500/15 text-amber-700 dark:text-amber-300";
  }
  return "bg-destructive/10 text-destructive";
}

function signalClass(signal: ScalpingSignal["state"]): string {
  if (signal === "entry_candidate") return "bg-blue-500/15 text-blue-700 dark:text-blue-300";
  if (signal === "exit_candidate") return "bg-rose-500/15 text-rose-700 dark:text-rose-300";
  if (signal === "hold") return "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300";
  return "bg-secondary text-muted-foreground";
}

function CandleShape(input: unknown) {
  const { x = 0, y = 0, width = 0, height = 0, payload } = input as {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    payload?: ChartRow;
  };
  if (!payload) return <g />;
  const rising = payload.close >= payload.open;
  const color = rising ? "var(--candle-rise)" : "var(--candle-fall)";
  const spread = payload.high - payload.low;
  const pixelsPerUnit = spread > 0 ? height / spread : 0;
  const bodyTop = spread > 0 ? y + (payload.high - Math.max(payload.open, payload.close)) * pixelsPerUnit : y;
  const bodyBottom = spread > 0 ? y + (payload.high - Math.min(payload.open, payload.close)) * pixelsPerUnit : y;
  const center = x + width / 2;
  const bodyWidth = Math.max(1.5, Math.min(width * 0.68, 8));
  return (
    <g data-scalping-candle={payload.status}>
      <line x1={center} y1={y} x2={center} y2={y + Math.max(1, height)} stroke={color} strokeWidth={1} />
      <rect
        x={center - bodyWidth / 2}
        y={bodyTop}
        width={bodyWidth}
        height={Math.max(1.5, bodyBottom - bodyTop)}
        fill={rising ? "hsl(var(--card))" : color}
        stroke={color}
        strokeWidth={payload.status === "forming" ? 1.6 : 1}
        strokeDasharray={payload.status === "forming" ? "2 2" : undefined}
      />
    </g>
  );
}

function TradeMarkerShape({ cx = 0, cy = 0, marker }: { cx?: number; cy?: number; marker: ScalpingTradeMarker }) {
  const buy = marker.side === "buy";
  const markerY = cy + (buy ? 8 : -8);
  return (
    <g aria-label={`${buy ? "매수" : "매도"} 체결`}>
      <line x1={cx} y1={cy} x2={cx} y2={markerY} stroke={buy ? "#2563eb" : "#e11d48"} strokeWidth={1} />
      <circle cx={cx} cy={markerY} r={7} fill={buy ? "#2563eb" : "#e11d48"} stroke="hsl(var(--card))" strokeWidth={2} />
      <path d={buy ? `M ${cx - 3} ${markerY + 1} L ${cx} ${markerY - 2} L ${cx + 3} ${markerY + 1}` : `M ${cx - 3} ${markerY - 1} L ${cx} ${markerY + 2} L ${cx + 3} ${markerY - 1}`} fill="none" stroke="white" strokeWidth={1.5} />
    </g>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-2xl bg-secondary p-3">
      <dt className="truncate text-[9px] font-black text-muted-foreground">{label}</dt>
      <dd className="mt-1 truncate text-xs font-black" title={value}>{value}</dd>
    </div>
  );
}

function PriceChart({ candidate, preset }: { candidate: ScalpingCandidate; preset: ScalpingPreset }) {
  const rows = useMemo<ChartRow[]>(() => candidate.bars.slice(-180).map((bar) => ({ ...bar, ...bar.indicatorValues, candleRange: [bar.low, bar.high] })), [candidate.bars]);
  const indicatorLines = useMemo(() => candidate.indicators.flatMap((indicator) => (
    (INDICATOR_LINE_FIELDS[indicator.kind] ?? []).flatMap((field) => {
      const key = `${indicator.id}:${field}`;
      return rows.some((row) => finite(row[key] as number | undefined)) ? [{ key, label: `${indicator.kind} ${field}` }] : [];
    })
  )), [candidate.indicators, rows]);
  const markerPoints = useMemo(
    () => scalpingTradeMarkerPoints(candidate.bars, candidate.tradeMarkers, 180),
    [candidate.bars, candidate.tradeMarkers],
  );
  const levels = candidate.levels;
  if (!rows.length) {
    return <div className="grid h-[300px] place-items-center rounded-[20px] bg-secondary px-4 text-center text-xs font-bold text-muted-foreground" data-scalping-chart-empty>확정 또는 진행 중인 분봉 데이터가 없습니다.</div>;
  }
  return (
    <div className="h-[300px] min-w-0 rounded-[20px] bg-secondary p-2" data-scalping-price-chart aria-label={`${candidate.symbol} 실시간 분봉 차트`}>
      <ResponsiveContainer width="100%" height="100%" minWidth={1} minHeight={1}>
        <ComposedChart data={rows} syncId={SCALPING_CHART_SYNC_ID} syncMethod="value" margin={{ top: 12, right: 5, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="hsl(var(--border))" vertical={false} strokeDasharray="3 5" />
          <XAxis dataKey="timestamp" tickFormatter={chartTime} minTickGap={28} tick={{ fontSize: 8 }} axisLine={false} tickLine={false} />
          <YAxis orientation="right" width={54} tick={{ fontSize: 8 }} axisLine={false} tickLine={false} domain={["auto", "auto"]} />
          <Tooltip
            labelFormatter={(label) => formatTimestamp(String(label), true)}
            formatter={(value, name) => [typeof value === "number" ? formatMoney(value, candidate.currency) : String(value), String(name)]}
            cursor={{ stroke: "hsl(var(--foreground) / 0.45)", strokeWidth: 1 }}
            wrapperStyle={{ zIndex: 30 }}
          />
          <Bar dataKey="candleRange" name="OHLC" shape={<CandleShape />} isAnimationActive={false} />
          {preset !== "risk_management" ? <Line dataKey="sessionVwap" name="Session VWAP" type="linear" dot={false} connectNulls={false} stroke="#f97316" strokeWidth={1.5} isAnimationActive={false} /> : null}
          {preset === "trend" || preset === "mean_reversion" ? <Line dataKey="anchoredVwap" name="Anchored VWAP" type="linear" dot={false} connectNulls={false} stroke="#8b5cf6" strokeDasharray="5 3" strokeWidth={1.4} isAnimationActive={false} /> : null}
          {preset === "breakout" && finite(levels?.previousHigh) ? <ReferenceLine y={levels?.previousHigh} stroke="#e11d48" strokeDasharray="4 4" label={{ value: "전고", fontSize: 8 }} /> : null}
          {preset === "breakout" && finite(levels?.previousLow) ? <ReferenceLine y={levels?.previousLow} stroke="#2563eb" strokeDasharray="4 4" label={{ value: "전저", fontSize: 8 }} /> : null}
          {preset === "mean_reversion" && finite(levels?.previousClose) ? <ReferenceLine y={levels?.previousClose} stroke="hsl(var(--muted-foreground))" strokeDasharray="2 4" label={{ value: "전종", fontSize: 8 }} /> : null}
          {preset === "breakout" && finite(levels?.openingRange5?.high) ? <ReferenceLine y={levels?.openingRange5?.high} stroke="#14b8a6" strokeDasharray="2 3" label={{ value: "OR5 H", fontSize: 8 }} /> : null}
          {preset === "breakout" && finite(levels?.openingRange5?.low) ? <ReferenceLine y={levels?.openingRange5?.low} stroke="#14b8a6" strokeDasharray="2 3" label={{ value: "OR5 L", fontSize: 8 }} /> : null}
          {preset === "breakout" && finite(levels?.openingRange15?.high) ? <ReferenceLine y={levels?.openingRange15?.high} stroke="#0d9488" strokeDasharray="5 3" label={{ value: "OR15 H", fontSize: 8 }} /> : null}
          {preset === "breakout" && finite(levels?.openingRange15?.low) ? <ReferenceLine y={levels?.openingRange15?.low} stroke="#0d9488" strokeDasharray="5 3" label={{ value: "OR15 L", fontSize: 8 }} /> : null}
          {preset === "breakout" && finite(levels?.openingRange30?.high) ? <ReferenceLine y={levels?.openingRange30?.high} stroke="#0f766e" strokeDasharray="8 3" label={{ value: "OR30 H", fontSize: 8 }} /> : null}
          {preset === "breakout" && finite(levels?.openingRange30?.low) ? <ReferenceLine y={levels?.openingRange30?.low} stroke="#0f766e" strokeDasharray="8 3" label={{ value: "OR30 L", fontSize: 8 }} /> : null}
          {indicatorLines.map((line, index) => <Line key={line.key} dataKey={line.key} name={line.label} type="linear" dot={false} connectNulls={false} stroke={INDICATOR_LINE_COLORS[index % INDICATOR_LINE_COLORS.length]} strokeDasharray={index % 2 ? "5 3" : undefined} strokeWidth={1.25} isAnimationActive={false} />)}
          {finite(candidate.position?.averagePrice) ? <ReferenceLine y={candidate.position?.averagePrice} stroke="hsl(var(--foreground))" strokeWidth={1.4} label={{ value: "평균 매수가", fontSize: 8 }} /> : null}
          {markerPoints.map(({ marker, timestamp, price }) => (
            <ReferenceDot key={marker.id} x={timestamp} y={price} ifOverflow="extendDomain" isFront shape={<TradeMarkerShape marker={marker} />} />
          ))}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

function IndicatorPanel({ candidate }: { candidate: ScalpingCandidate }) {
  if (!candidate.indicators.length) {
    return <div className="min-w-0 rounded-[20px] bg-secondary p-4 text-[9px] text-muted-foreground" data-scalping-indicators="unavailable"><p className="font-black text-foreground">Rust 기술 지표 unavailable</p><p className="mt-1">분봉 이력이 부족하거나 worker 결과가 제공되지 않았습니다.</p></div>;
  }
  return (
    <div className="min-w-0 rounded-[20px] bg-secondary p-4" data-scalping-indicators="available">
      <div className="flex items-center justify-between gap-2"><p className="text-[10px] font-black">Rust 공통 지표 엔진</p><span className="text-[8px] text-muted-foreground">브라우저 재계산 없음</span></div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {candidate.indicators.map((indicator) => {
          const values = Object.entries(indicator.values).slice(0, 3).map(([field, value]) => `${field} ${value.toFixed(3)}`).join(" · ");
          return <span key={indicator.id} title={`${indicator.id}${values ? ` · ${values}` : ""}`} className={cn("max-w-full truncate rounded-full px-2 py-1 text-[8px] font-black", availabilityClass(indicator.status))}>{indicator.kind} · {indicator.status}{values ? ` · ${values}` : ""}</span>;
        })}
      </div>
    </div>
  );
}

function VolumeProfilePanel({ candidate }: { candidate: ScalpingCandidate }) {
  const profile = candidate.volumeProfile;
  if (!profile || profile.status !== "available") {
    return <div className="min-w-0 rounded-[20px] bg-secondary p-4 text-[9px] text-muted-foreground" data-scalping-volume-profile="unavailable"><p className="font-black text-foreground">Volume Profile unavailable</p><p className="mt-1">{profile?.unavailableReason ?? "요청 종목의 가격대별 거래량이 제공되지 않았습니다."}</p></div>;
  }
  const maximum = Math.max(0, ...profile.buckets.map(({ volume }) => volume));
  return (
    <div className="min-w-0 rounded-[20px] bg-secondary p-4" data-scalping-volume-profile="available">
      <div className="flex items-center justify-between gap-2"><p className="text-[10px] font-black">Volume Profile</p><span className="text-[8px] text-muted-foreground">{profile.approximation ?? "provider calculation"}</span></div>
      <dl className="mt-2 grid grid-cols-3 gap-2 text-[8px]"><div><dt className="text-muted-foreground">POC</dt><dd className="font-black">{finite(profile.pointOfControl) ? formatMoney(profile.pointOfControl, candidate.currency) : "unavailable"}</dd></div><div><dt className="text-muted-foreground">VAH</dt><dd className="font-black">{finite(profile.valueAreaHigh) ? formatMoney(profile.valueAreaHigh, candidate.currency) : "unavailable"}</dd></div><div><dt className="text-muted-foreground">VAL</dt><dd className="font-black">{finite(profile.valueAreaLow) ? formatMoney(profile.valueAreaLow, candidate.currency) : "unavailable"}</dd></div></dl>
      <div className="mt-3 max-h-28 space-y-1 overflow-y-auto" aria-label={`${candidate.symbol} 가격대별 거래량`}>{profile.buckets.slice(-20).reverse().map((bucket, index) => <div key={`${bucket.priceLow}:${bucket.priceHigh}:${index}`} className="grid grid-cols-[5.5rem_minmax(0,1fr)] items-center gap-2 text-[8px]"><span className="truncate text-right text-muted-foreground">{formatMoney((bucket.priceLow + bucket.priceHigh) / 2, candidate.currency)}</span><div className="h-2 overflow-hidden rounded-full bg-card"><div className="h-full rounded-full bg-foreground/55" style={{ width: `${maximum > 0 ? Math.max(1, bucket.volume / maximum * 100) : 0}%` }} /></div></div>)}</div>
    </div>
  );
}

function SessionLevelsPanel({ candidate, compact = false }: { candidate: ScalpingCandidate; compact?: boolean }) {
  const levels = candidate.levels;
  const entries: Array<[string, number | undefined]> = [
    ["전일 고가", levels?.previousHigh], ["전일 저가", levels?.previousLow], ["전일 종가", levels?.previousClose],
    ["당일 시가", levels?.dayOpen], ["당일 고가", levels?.dayHigh], ["당일 저가", levels?.dayLow],
    ["OR5 고가", levels?.openingRange5?.high], ["OR5 저가", levels?.openingRange5?.low],
    ["OR15 고가", levels?.openingRange15?.high], ["OR15 저가", levels?.openingRange15?.low],
    ["OR30 고가", levels?.openingRange30?.high], ["OR30 저가", levels?.openingRange30?.low],
  ];
  return (
    <div className="min-w-0 rounded-[20px] bg-secondary p-4" data-scalping-session-levels>
      <div className="flex items-center justify-between gap-2"><p className="text-[10px] font-black">세션·Opening Range</p><span className="text-[8px] text-muted-foreground">확정 봉 기준</span></div>
      <dl className={cn("mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[8px]", !compact && "sm:grid-cols-3")}>{entries.map(([label, value]) => <div key={label} className="flex min-w-0 justify-between gap-2"><dt className="truncate text-muted-foreground">{label}</dt><dd className="shrink-0 font-black">{finite(value) ? formatMoney(value, candidate.currency) : "unavailable"}</dd></div>)}</dl>
    </div>
  );
}

function OrderbookPanel({ candidate }: { candidate: ScalpingCandidate }) {
  const book = candidate.orderbook;
  if (!book) {
    return (
      <div className="min-w-0 rounded-[20px] bg-secondary p-4" data-scalping-orderbook="unavailable">
        <p className="text-[10px] font-black">실시간 호가 unavailable</p>
        <p className="mt-1 text-[9px] leading-4 text-muted-foreground">{candidate.orderbookUnavailableReason ?? "공급자가 현재 호가를 제공하지 않았습니다. 과거 호가를 추정하지 않습니다."}</p>
      </div>
    );
  }
  return (
    <div className="min-w-0 rounded-[20px] bg-secondary p-4" data-scalping-orderbook="available">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[10px] font-black">실시간 호가</p>
        <span className="text-[9px] text-muted-foreground">{formatTimestamp(book.observedAt)}</span>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2 text-[9px]">
        <div className="space-y-1">
          <p className="font-black text-rose-600">매도</p>
          {book.asks.slice(0, 3).reverse().map((level) => <p key={`ask:${level.price}`} className="flex justify-between gap-2"><span>{formatMoney(level.price, candidate.currency)}</span><span className="text-muted-foreground">{formatQuantity(level.quantity)}</span></p>)}
        </div>
        <div className="space-y-1">
          <p className="font-black text-blue-600">매수</p>
          {book.bids.slice(0, 3).map((level) => <p key={`bid:${level.price}`} className="flex justify-between gap-2"><span>{formatMoney(level.price, candidate.currency)}</span><span className="text-muted-foreground">{formatQuantity(level.quantity)}</span></p>)}
        </div>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 border-t border-border pt-2 text-[9px]">
        <p>스프레드 <strong>{finite(candidate.spreadBps) ? `${candidate.spreadBps.toFixed(1)} bps` : "unavailable"}</strong></p>
        <p>호가 불균형 <strong>{formatRatio(book.imbalance)}</strong></p>
      </div>
    </div>
  );
}

function SignalPanel({ candidate, compact = false }: { candidate: ScalpingCandidate; compact?: boolean }) {
  const signal = candidate.signal;
  if (!signal) {
    return (
      <div className="min-w-0 rounded-[20px] bg-secondary p-4" data-scalping-signal="unavailable">
        <div className="flex items-center gap-2"><CircleDashed className="size-4" /><p className="text-[10px] font-black">보조 신호 unavailable</p></div>
        <p className="mt-1 text-[9px] text-muted-foreground">확정 분봉과 다음 유효 시점이 확보될 때까지 관망합니다.</p>
      </div>
    );
  }
  return (
    <div className="min-w-0 rounded-[20px] bg-secondary p-4" data-scalping-signal={signal.state}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[10px] font-black">매수·매도 보조 신호</p>
        <span className={cn("rounded-full px-2.5 py-1 text-[9px] font-black", signalClass(signal.state))}>{SIGNAL_LABELS[signal.state]}</span>
      </div>
      <dl className={cn("mt-3 grid grid-cols-1 gap-x-3 gap-y-2 text-[9px]", !compact && "sm:grid-cols-2")}>
        <div><dt className="text-muted-foreground">계산 / 신호</dt><dd className="font-black">{formatTimestamp(signal.calculationAt)} / {formatTimestamp(signal.signalAt)}</dd></div>
        <div><dt className="text-muted-foreground">예정 / 실제 적용</dt><dd className="font-black">{formatTimestamp(signal.eligibleAt)} / {formatTimestamp(signal.appliedAt)}</dd></div>
        <div><dt className="text-muted-foreground">기준 가격</dt><dd className="font-black">{finite(signal.basisPrice) ? formatMoney(signal.basisPrice, candidate.currency) : "unavailable"}</dd></div>
        <div><dt className="text-muted-foreground">예상 진입 범위</dt><dd className="font-black">{finite(signal.entryLow) && finite(signal.entryHigh) ? `${formatMoney(signal.entryLow, candidate.currency)} ~ ${formatMoney(signal.entryHigh, candidate.currency)}` : "unavailable"}</dd></div>
        <div><dt className="text-muted-foreground">손절 후보</dt><dd className="font-black">{finite(signal.stopPrice) ? formatMoney(signal.stopPrice, candidate.currency) : "unavailable"}</dd></div>
        <div><dt className="text-muted-foreground">목표 범위</dt><dd className="font-black">{finite(signal.targetLow) && finite(signal.targetHigh) ? `${formatMoney(signal.targetLow, candidate.currency)} ~ ${formatMoney(signal.targetHigh, candidate.currency)}` : "unavailable"}</dd></div>
        <div><dt className="text-muted-foreground">예상 손익비</dt><dd className="font-black">{finite(signal.riskReward) ? `${signal.riskReward.toFixed(2)} : 1` : "unavailable"}</dd></div>
        <div><dt className="text-muted-foreground">다중 시간대 추세</dt><dd className="font-black">{signal.multiTimeframeAligned === undefined ? "unavailable" : signal.multiTimeframeAligned ? "일치" : "불일치"}</dd></div>
        <div><dt className="text-muted-foreground">신뢰도 / 품질</dt><dd className="font-black">{formatProbability(signal.confidence)} / {signal.quality?.status ?? "unavailable"}</dd></div>
      </dl>
      <p className="mt-3 border-t border-border pt-2 text-[9px] text-muted-foreground">사용 지표: {signal.indicators.length ? signal.indicators.join(" · ") : "unavailable"}</p>
    </div>
  );
}

function ForecastPanel({ forecast, candidate }: { forecast: ScalpingForecast | undefined; candidate: ScalpingCandidate }) {
  if (!forecast || forecast.status !== "available") {
    return (
      <div className="min-w-0 rounded-[20px] bg-secondary p-4" data-scalping-ai="unavailable">
        <div className="flex items-center gap-2"><BrainCircuit className="size-4" /><p className="text-[10px] font-black">AI 전망 unavailable</p></div>
        <p className="mt-1 text-[9px] leading-4 text-muted-foreground">{forecast?.unavailableReason ?? "모델 예측이 반환되지 않았습니다. 임의의 확률이나 가격을 표시하지 않습니다."}</p>
        {forecast?.model ? <p className="mt-2 text-[9px] text-muted-foreground">{forecast.model.id} · {forecast.model.revision}</p> : null}
      </div>
    );
  }
  return (
    <div className="min-w-0 rounded-[20px] bg-secondary p-4" data-scalping-ai="available">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div><p className="text-[10px] font-black">AI 가격 전망</p><p className="mt-1 text-[9px] text-muted-foreground">입력 종료 {formatTimestamp(forecast.inputEndAt)} · 생성 {formatTimestamp(forecast.generatedAt)}</p></div>
        <span className="rounded-full bg-card px-2.5 py-1 text-[9px] font-black">보조 평가</span>
      </div>
      <div className="mt-3 max-w-full overflow-x-auto">
        <table className="w-full min-w-[520px] text-left text-[9px]" aria-label={`${candidate.symbol} AI 예측`}>
          <thead className="text-muted-foreground"><tr><th className="pb-2">기간 / 종료</th><th className="pb-2">수익률 q10 / q50 / q90</th><th className="pb-2">가격 범위</th><th className="pb-2">상승 / 하락</th><th className="pb-2">변동성 / 불확실성</th><th className="pb-2">목표 선도달 범위</th></tr></thead>
          <tbody>
            {forecast.horizons.map((horizon) => (
              <tr key={horizon.minutes} className="border-t border-border">
                <td className="py-2 font-black">{horizon.minutes}분 <span className="font-normal text-muted-foreground">{formatTimestamp(horizon.targetAt)}</span></td>
                <td>{formatRatio(horizon.returnLow)} / {formatRatio(horizon.returnMedian)} / {formatRatio(horizon.returnHigh)}</td>
                <td>{finite(horizon.priceLow) && finite(horizon.priceHigh) ? `${formatMoney(horizon.priceLow, candidate.currency)} ~ ${formatMoney(horizon.priceHigh, candidate.currency)}` : "unavailable"}</td>
                <td>{formatProbability(horizon.upProbability)} / {formatProbability(horizon.downProbability)}</td>
                <td>{formatRatio(horizon.expectedVolatility)} / {formatRatio(horizon.uncertaintyWidth)}</td>
                <td>{formatProbability(horizon.targetFirstProbabilityLow)} ~ {formatProbability(horizon.targetFirstProbabilityHigh)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-3 border-t border-border pt-2 text-[9px] leading-4 text-muted-foreground">
        <p>모델 {forecast.model ? `${forecast.model.id} · ${forecast.model.revision}` : "provenance unavailable"}{forecast.model?.fallbackFrom ? ` · fallback from ${forecast.model.fallbackFrom}` : ""}</p>
        <p>장치 {forecast.model?.device ?? "unavailable"} · dtype {forecast.model?.dtype ?? "unavailable"} · 분포 이탈 {forecast.distributionShift ?? "unavailable"}</p>
        <p>입력 품질 {forecast.quality?.status ?? "unavailable"}{forecast.quality?.warnings.length ? ` · ${forecast.quality.warnings.join(" · ")}` : ""}</p>
      </div>
    </div>
  );
}

const ScalpingCandidateCard = memo(function ScalpingCandidateCard({ candidate, theme: _theme, preset, layoutColumns }: { candidate: ScalpingCandidate; theme: Theme; preset: ScalpingPreset; layoutColumns: 1 | 2 | 3 | 4 }) {
  const latest = candidate.bars.at(-1);
  return (
    <Card className="min-w-0 overflow-hidden bg-card p-4 sm:p-5" data-scalping-symbol={candidate.symbol}>
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <span className="grid size-8 shrink-0 place-items-center rounded-full bg-primary text-[10px] font-black text-primary-foreground">{candidate.rank ?? "–"}</span>
            <div className="min-w-0"><h3 className="truncate text-base font-black">{candidate.name}</h3><p className="truncate text-[9px] font-bold text-muted-foreground">{candidate.symbol} · {candidate.currency}</p></div>
            {latest?.status === "forming" ? <span className="inline-flex items-center gap-1 rounded-full bg-rose-500/12 px-2 py-1 text-[8px] font-black text-rose-600"><Radio className="size-2.5" />진행 중 봉</span> : null}
          </div>
        </div>
        <div className="text-right"><p className="text-base font-black">{finite(candidate.price) ? formatMoney(candidate.price, candidate.currency) : "unavailable"}</p><p className={cn("text-[10px] font-black", finite(candidate.changeRateRatio) && candidate.changeRateRatio >= 0 ? "text-rose-600" : "text-blue-600")}>{formatRatio(candidate.changeRateRatio, true)}</p></div>
      </div>

      <dl className={cn("mt-4 grid grid-cols-2 gap-2", layoutColumns <= 2 && "sm:grid-cols-4")}>
        <Metric label="거래대금" value={finite(candidate.tradingAmount) ? formatMoney(candidate.tradingAmount, candidate.currency, true) : "unavailable"} />
        <Metric label="거래량" value={formatCompact(candidate.volume)} />
        <Metric label="변동성 점수" value={finite(candidate.volatilityScore) ? candidate.volatilityScore.toFixed(4) : "unavailable"} />
        <Metric label="시간대 RVOL" value={finite(candidate.relativeVolume) ? `${candidate.relativeVolume.toFixed(2)}×` : "unavailable"} />
      </dl>

      <div className="mt-3"><PriceChart candidate={candidate} preset={preset} /></div>

      <div className="mt-3"><IndicatorPanel candidate={candidate} /></div>

      <div className={cn("mt-3 grid min-w-0 gap-3", layoutColumns <= 2 && "xl:grid-cols-2")}>
        <OrderbookPanel candidate={candidate} />
        <div className="min-w-0 rounded-[20px] bg-secondary p-4">
          <p className="text-[10px] font-black">포지션·체결</p>
          {candidate.position ? (
            <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[9px]">
              <dt className="text-muted-foreground">보유 수량</dt><dd className="text-right font-black">{finite(candidate.position.quantity) ? formatQuantity(candidate.position.quantity) : "unavailable"}</dd>
              <dt className="text-muted-foreground">평균 매수가</dt><dd className="text-right font-black">{finite(candidate.position.averagePrice) ? formatMoney(candidate.position.averagePrice, candidate.currency) : "unavailable"}</dd>
              <dt className="text-muted-foreground">수익률</dt><dd className="text-right font-black">{finite(candidate.position.profitRate) ? `${candidate.position.profitRate.toFixed(2)}%` : "unavailable"}</dd>
            </dl>
          ) : <p className="mt-2 text-[9px] text-muted-foreground">현재 포지션이 없거나 보유 정보가 제공되지 않았습니다.</p>}
          <p className="mt-3 border-t border-border pt-2 text-[9px] text-muted-foreground">체결 기록 {candidate.tradeMarkers.length}건 · 체결 강도 {finite(candidate.executionStrength) ? candidate.executionStrength.toFixed(1) : "unavailable"}</p>
          {candidate.tradeMarkers.length ? <details className="mt-2"><summary className="cursor-pointer text-[9px] font-black">매수·매도 기록 상세</summary><div className="mt-2 space-y-1 text-[9px] text-muted-foreground">{candidate.tradeMarkers.map((marker) => <p key={marker.id}>{formatTimestamp(marker.timestamp, true)} · {marker.side === "buy" ? "매수" : "매도"} · {finite(marker.quantity) ? `${formatQuantity(marker.quantity)}주` : "수량 unavailable"} · {finite(marker.averagePrice) ? formatMoney(marker.averagePrice, candidate.currency) : "평균가 unavailable"} · {finite(marker.amount) ? formatMoney(marker.amount, candidate.currency) : "금액 unavailable"}{marker.detailLevel === "order_average_fill" ? " · 주문별 평균 체결" : ""}</p>)}</div><p className="mt-2 text-[8px] leading-4 text-muted-foreground">개별 execution 이력은 저장되지 않으므로 주문별 평균 체결만 표시합니다. 체결시각이나 평균가가 없는 기록은 차트 위치를 추정하지 않습니다.</p></details> : null}
        </div>
      </div>

      <div className={cn("mt-3 grid min-w-0 gap-3", layoutColumns <= 2 && "xl:grid-cols-2")}>
        <SignalPanel candidate={candidate} compact={layoutColumns >= 3} />
        <ForecastPanel forecast={candidate.forecast} candidate={candidate} />
      </div>

      {preset === "breakout" ? <div className={cn("mt-3 grid min-w-0 gap-3", layoutColumns <= 2 && "xl:grid-cols-2")}><SessionLevelsPanel candidate={candidate} compact={layoutColumns >= 3} /><VolumeProfilePanel candidate={candidate} /></div> : null}

      <div className="mt-3 flex min-w-0 flex-wrap items-center gap-1.5 text-[8px] font-black">
        <span title={[...candidate.quality.reasons, ...candidate.quality.missing.map((item) => `missing:${item}`)].join(" · ")} className={cn("rounded-full px-2 py-1", availabilityClass(candidate.quality.status))}>데이터 {candidate.quality.status}</span>
        {candidate.quality.sources.map((source) => <span key={source} className="rounded-full bg-secondary px-2 py-1">{source}</span>)}
        {candidate.warnings.map((warning) => <span key={warning} className="max-w-full truncate rounded-full bg-amber-500/15 px-2 py-1 text-amber-700 dark:text-amber-300" title={warning}>{warning}</span>)}
      </div>
    </Card>
  );
});

function estimatedVirtualCardHeight(layoutColumns: 1 | 2 | 3 | 4): number {
  if (typeof window !== "undefined" && window.matchMedia("(max-width: 639px)").matches) return 1_900;
  return layoutColumns >= 3 ? 1_950 : 1_150;
}

function VirtualizedCandidateCard({ candidate, theme, preset = "trend", layoutColumns = 2 }: { candidate: ScalpingCandidate; theme: Theme; preset?: ScalpingPreset; layoutColumns?: 1 | 2 | 3 | 4 }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(false);
  const [placeholderHeight, setPlaceholderHeight] = useState(() => estimatedVirtualCardHeight(layoutColumns));
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        if (!entry.isIntersecting) setPlaceholderHeight(Math.max(780, Math.ceil(host.getBoundingClientRect().height)));
        setVisible(entry.isIntersecting);
      }
    }, { root: null, rootMargin: "850px 0px", threshold: 0 });
    observer.observe(host);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) setPlaceholderHeight(estimatedVirtualCardHeight(layoutColumns));
  }, [layoutColumns, visible]);
  useEffect(() => {
    const content = contentRef.current;
    if (!visible || !content) return;
    const update = () => setPlaceholderHeight(Math.max(780, Math.ceil(content.getBoundingClientRect().height)));
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(content);
    return () => observer.disconnect();
  }, [visible]);
  return (
    <div ref={hostRef} className="min-w-0" style={{ minHeight: placeholderHeight }} data-scalping-virtual-symbol={candidate.symbol} data-scalping-card-state={visible ? "mounted" : "placeholder"}>
      {visible ? <div ref={contentRef}><ScalpingCandidateCard candidate={candidate} theme={theme} preset={preset} layoutColumns={layoutColumns} /></div> : (
        <Card className="grid place-items-center bg-secondary p-5 text-center text-xs font-bold text-muted-foreground" style={{ height: placeholderHeight }} aria-label={`${candidate.symbol} 차트 대기`}>
          <span>{candidate.symbol} · 화면에 가까워지면 차트를 렌더링합니다.</span>
        </Card>
      )}
    </div>
  );
}

export const ScalpingVirtualizedCandidateCard = VirtualizedCandidateCard;

function StatusBanner({ status }: { status: ScalpingStatus }) {
  if (!status.enabled) {
    return (
      <Card className="bg-secondary p-5" data-scalping-disabled role="status">
        <div className="flex items-start gap-3"><WifiOff className="mt-0.5 size-5 shrink-0" /><div><p className="font-black">단타 보조가 비활성화되어 있습니다.</p><p className="mt-1 text-xs leading-5 text-muted-foreground">{status.message ?? "서버의 공급자·호출 한도·AI worker 설정을 확인해 주세요."}</p></div></div>
        {status.limitations.length ? <ul className="mt-3 list-disc space-y-1 pl-5 text-[10px] text-muted-foreground">{status.limitations.map((item) => <li key={item}>{item}</li>)}</ul> : null}
      </Card>
    );
  }
  return (
    <div className="flex flex-wrap gap-2" aria-label="단타 데이터 공급 상태">
      {status.providers.map((provider) => <span key={provider.name} title={provider.message} className={cn("rounded-full px-3 py-1.5 text-[9px] font-black", availabilityClass(provider.status))}>{provider.name} · {provider.status}</span>)}
      {status.limits?.maximumSubscriptions ? <span className="rounded-full bg-secondary px-3 py-1.5 text-[9px] font-black">실측 구독 상한 {status.limits.maximumSubscriptions}</span> : null}
    </div>
  );
}

function EvaluationPanel({
  candidates,
  interval,
  disabled,
  onUnauthorized,
}: {
  candidates: ScalpingCandidate[];
  interval: ScalpingInterval;
  disabled: boolean;
  onUnauthorized: () => void;
}) {
  const [costs, setCosts] = useState({ commissionBpsPerSide: 1.5, taxBpsOnExit: 18, spreadBpsRoundTrip: 5, slippageBpsPerSide: 2 });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState<ScalpingEvaluationReceipt>();
  const [metrics, setMetrics] = useState<ScalpingEvaluationMetric[]>([]);

  const startEvaluation = async () => {
    setLoading(true);
    setError("");
    setReceipt(undefined);
    setMetrics([]);
    try {
      const response = await fetch("/api/portfolio/scalping/evaluations", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          symbols: candidates.map(({ symbol }) => symbol),
          interval,
          evaluation: { walkForward: true, retrospective: true, ...costs },
        }),
      });
      const payload = await readJson(response);
      if (response.status === 401) {
        onUnauthorized();
        return;
      }
      if (!response.ok) throw new Error(scalpingErrorMessage(payload, "예측 검증을 시작하지 못했습니다."));
      setReceipt(normalizeScalpingEvaluationReceipt(payload));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "예측 검증을 시작하지 못했습니다.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const runId = receipt?.runId;
    if (!runId) return;
    const controller = new AbortController();
    let timer: number | undefined;
    const poll = async () => {
      try {
        const snapshot = await loadAdvancedRunSnapshot(runId, onUnauthorized, controller.signal);
        if (controller.signal.aborted) return;
        if (snapshot.kind !== "scalping_prediction_evaluation") {
          throw new Error("단타 예측 검증 run 유형이 일치하지 않습니다.");
        }
        setReceipt((current) => current ? {
          ...current,
          status: snapshot.status,
          progress: snapshot.progress,
        } : current);
        if (["queued", "running", "cancel_requested"].includes(snapshot.status)) {
          timer = window.setTimeout(() => void poll(), 800);
          return;
        }
        if (snapshot.status !== "completed") {
          const detail = snapshot.error && typeof snapshot.error === "object" && "message" in snapshot.error
            ? String(snapshot.error.message)
            : `예측 검증 run이 ${snapshot.status} 상태로 종료되었습니다.`;
          throw new Error(detail);
        }
        const artifact = await loadAdvancedArtifact(runId, "scalping-evaluation-summary", onUnauthorized, controller.signal);
        if (controller.signal.aborted) return;
        const nextMetrics = normalizeScalpingEvaluationMetrics(artifact);
        if (!nextMetrics.length) throw new Error("예측 검증 요약 artifact가 비어 있습니다.");
        setMetrics(nextMetrics);
      } catch (caught) {
        if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : "예측 검증 결과를 불러오지 못했습니다.");
      }
    };
    void poll();
    return () => {
      controller.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [receipt?.runId, onUnauthorized]);

  return (
    <Card className="bg-secondary p-5 sm:p-6" data-scalping-evaluation>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><p className="text-[10px] font-black tracking-[0.12em] text-muted-foreground">PREDICTION EVALUATION</p><h2 className="mt-1 text-lg font-black">예측 검증</h2><p className="mt-1 max-w-2xl text-[10px] leading-4 text-muted-foreground">시간 순서 Walk-forward로 현재 모델을 재생합니다. 과거 당시 저장된 예측이 아니므로 결과는 항상 <code>retrospective</code>로 구분됩니다.</p></div>
        <span className="rounded-full bg-card px-3 py-1.5 text-[9px] font-black">random split 사용 안 함</span>
      </div>
      <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {([
          ["commissionBpsPerSide", "편도 수수료 bps"],
          ["taxBpsOnExit", "청산 세금 bps"],
          ["spreadBpsRoundTrip", "왕복 스프레드 bps"],
          ["slippageBpsPerSide", "편도 슬리피지 bps"],
        ] as const).map(([key, label]) => <label key={key} className="rounded-2xl bg-card p-3"><span className="mb-2 block text-[9px] font-black text-muted-foreground">{label}</span><Input type="number" min={0} step={0.1} aria-label={label} value={costs[key]} onChange={(event) => setCosts((current) => ({ ...current, [key]: Math.max(0, Number(event.target.value) || 0) }))} className="h-10 bg-secondary text-xs" /></label>)}
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <p className="text-[9px] text-muted-foreground">방향·MAE·RMSE·분위수 coverage·calibration·목표/손절 선도달·시간대/종목/국면·비용 차감·MDD·거래 수를 run/artifact에 저장합니다.</p>
        <Button onClick={() => void startEvaluation()} disabled={disabled || loading || !candidates.length}>{loading ? <LoaderCircle className="animate-spin" /> : <FlaskConical />}Walk-forward 검증 시작</Button>
      </div>
      {error ? <p role="alert" className="mt-3 rounded-2xl bg-destructive/10 p-3 text-xs text-destructive">{error}</p> : null}
      {receipt ? <div className="mt-3 rounded-2xl bg-card p-3 text-xs" role="status"><strong>검증 run {receipt.status ?? "queued"}</strong><p className="mt-1 text-[10px] text-muted-foreground">ID {receipt.runId ?? "응답에서 제공되지 않음"} · retrospective · {receipt.reused ? "기존 run 재사용" : "새 run"}{finite(receipt.progress) ? ` · 진행 ${(receipt.progress * 100).toFixed(0)}%` : ""}</p></div> : null}
      {metrics.length ? (
        <div className="mt-3 min-w-0 rounded-2xl bg-card p-3" data-scalping-evaluation-results>
          <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-[10px] font-black">Walk-forward 검증 결과</p><span className="text-[8px] text-muted-foreground">retrospective · 비용 차감</span></div>
          <div className="mt-3 max-w-full overflow-x-auto">
            <table className="min-w-[920px] w-full text-left text-[9px]">
              <thead className="text-muted-foreground"><tr><th className="pb-2">기간</th><th>표본</th><th>방향</th><th>MAE / RMSE</th><th>상승확률 Brier</th><th>목표·손절 선도달</th><th>기술 신호</th><th>AI 필터</th><th>MDD 기술 / AI</th></tr></thead>
              <tbody>{metrics.map((metric) => (
                <tr key={metric.horizonMinutes} className="border-t border-border align-top">
                  <td className="py-2 font-black">{metric.horizonMinutes}분</td>
                  <td>{metric.overall.count}</td>
                  <td>{formatProbability(metric.overall.directionAccuracy)}</td>
                  <td>{formatRatio(metric.overall.mae)} / {formatRatio(metric.overall.rmse)}</td>
                  <td>{finite(metric.upProbabilityBrier) ? metric.upProbabilityBrier.toFixed(4) : "unavailable"}</td>
                  <td>{metric.targetStopFirstCount}건 · {formatProbability(metric.targetStopFirstAccuracy)}</td>
                  <td>{metric.strategy.technicalTradeCount}회 · {formatRatio(metric.strategy.technicalNetReturn, true)}</td>
                  <td>{metric.strategy.aiFilteredTradeCount}회 · {formatRatio(metric.strategy.aiFilteredNetReturn, true)}</td>
                  <td>{formatRatio(metric.strategy.technicalMaxDrawdown)} / {formatRatio(metric.strategy.aiFilteredMaxDrawdown)}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">{metrics.map((metric) => (
            <details key={`detail:${metric.horizonMinutes}`} className="min-w-0 rounded-xl bg-secondary p-3 text-[8px]">
              <summary className="cursor-pointer font-black">{metric.horizonMinutes}분 coverage·그룹</summary>
              <p className="mt-2 break-words text-muted-foreground">coverage {metric.quantileCoverage.length ? metric.quantileCoverage.map((point) => `q${point.quantile}: ${formatProbability(point.value)}`).join(" · ") : "unavailable"}</p>
              <p className="mt-1 text-muted-foreground">calibration {metric.calibrationBinCount} bins · 종목 {Object.keys(metric.bySymbol).length} · 시간대 {Object.keys(metric.byTime).length} · 국면 {Object.keys(metric.byRegime).length}</p>
            </details>
          ))}</div>
        </div>
      ) : null}
    </Card>
  );
}

export function ScalpingAssistant({ portfolio: _portfolio, theme, onUnauthorized }: ScalpingAssistantProps) {
  const [request, setRequest] = useState<ScalpingRequest>(DEFAULT_REQUEST);
  const [status, setStatus] = useState<ScalpingStatus>();
  const [workspace, setWorkspace] = useState<ScalpingWorkspace>();
  const [loading, setLoading] = useState(true);
  const [forecastLoading, setForecastLoading] = useState(false);
  const [error, setError] = useState("");
  const [forecastError, setForecastError] = useState("");
  const [streamState, setStreamState] = useState<"idle" | "connected" | "reconnecting" | "unavailable">("idle");
  const requestIssues = useMemo(() => validateScalpingRequest(request), [request]);

  const runWorkspace = useCallback(async (nextRequest: ScalpingRequest) => {
    const issues = validateScalpingRequest(nextRequest);
    if (issues.length) {
      setError(issues.join(" "));
      return;
    }
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/portfolio/scalping/workspace", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(nextRequest),
      });
      const payload = await readJson(response);
      if (response.status === 401) {
        onUnauthorized();
        return;
      }
      if (!response.ok) throw new Error(scalpingErrorMessage(payload, "단타 후보를 불러오지 못했습니다."));
      setWorkspace(normalizeScalpingWorkspace(payload, nextRequest));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "단타 후보를 불러오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }, [onUnauthorized]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    fetch("/api/portfolio/scalping/status", { headers: { Accept: "application/json" }, signal: controller.signal })
      .then(async (response) => {
        const payload = await readJson(response);
        if (response.status === 401) {
          onUnauthorized();
          return undefined;
        }
        if (!response.ok) throw new Error(scalpingErrorMessage(payload, "단타 보조 상태를 확인하지 못했습니다."));
        return normalizeScalpingStatus(payload);
      })
      .then((nextStatus) => {
        if (!nextStatus || controller.signal.aborted) return;
        setStatus(nextStatus);
        if (nextStatus.enabled) return runWorkspace(DEFAULT_REQUEST);
        setLoading(false);
      })
      .catch((caught) => {
        if (controller.signal.aborted) return;
        setStatus({ enabled: false, message: caught instanceof Error ? caught.message : "상태 확인 실패", providers: [], capabilities: [], limitations: [] });
        setLoading(false);
      });
    return () => controller.abort();
  }, [onUnauthorized, runWorkspace]);

  const symbolsKey = workspace?.candidates.map(({ symbol }) => symbol).join(",") ?? "";
  const workspaceInterval = workspace?.interval;
  const workspacePreset = workspace?.preset;
  const workspaceCriterion = workspace?.criterion;
  const workspaceTopCount = workspace?.requestedTopCount;
  const workspaceLayoutColumns = workspace?.layoutColumns;
  useEffect(() => {
    if (!status?.enabled || !symbolsKey || !workspaceInterval || !workspacePreset || !workspaceCriterion
      || !workspaceTopCount || !workspaceLayoutColumns || typeof EventSource === "undefined") {
      setStreamState(status?.enabled && symbolsKey ? "unavailable" : "idle");
      return;
    }
    const stream = new EventSource(scalpingStreamUrl(symbolsKey.split(","), workspaceInterval, workspacePreset));
    let recoveryRefresh: number | undefined;
    setStreamState("reconnecting");
    stream.onopen = () => setStreamState("connected");
    stream.onerror = () => setStreamState("reconnecting");
    const receive = (rawEvent: Event) => {
      const message = rawEvent as MessageEvent<string>;
      try {
        const event = parseScalpingStreamEvent(JSON.parse(message.data));
        if (event) {
          if (event.type === "connection") {
            const payload = event.value && typeof event.value === "object" ? event.value as Record<string, unknown> : {};
            setStreamState(payload.state === "connected" ? "connected" : "reconnecting");
          }
          if (event.type === "recovery") {
            const payload = event.value && typeof event.value === "object" ? event.value as Record<string, unknown> : {};
            if (payload.status === "available" || payload.status === "partial") {
              if (recoveryRefresh !== undefined) window.clearTimeout(recoveryRefresh);
              recoveryRefresh = window.setTimeout(() => void runWorkspace({
                criterion: workspaceCriterion,
                topCount: workspaceTopCount,
                interval: workspaceInterval,
                layoutColumns: workspaceLayoutColumns,
                preset: workspacePreset,
              }), 750);
            }
          }
          setWorkspace((current) => current ? mergeScalpingStreamEvent(current, event) : current);
        }
      } catch {
        // 잘못된 이벤트 하나는 무시하고 EventSource 연결을 유지한다.
      }
    };
    stream.onmessage = receive;
    for (const type of ["connection", "bar", "trade", "orderbook", "analysis", "recovery", "diagnostic"] as const) {
      stream.addEventListener(type, receive);
    }
    stream.addEventListener("unavailable", () => setStreamState("unavailable"));
    return () => {
      if (recoveryRefresh !== undefined) window.clearTimeout(recoveryRefresh);
      stream.close();
      setStreamState("idle");
    };
  }, [
    runWorkspace,
    status?.enabled,
    symbolsKey,
    workspaceCriterion,
    workspaceInterval,
    workspaceLayoutColumns,
    workspacePreset,
    workspaceTopCount,
  ]);

  const requestForecasts = async () => {
    if (!workspace?.candidates.length) return;
    setForecastLoading(true);
    setForecastError("");
    try {
      const response = await fetch("/api/portfolio/scalping/forecast", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ symbols: workspace.candidates.map(({ symbol }) => symbol), interval: request.interval }),
      });
      const payload = await readJson(response);
      if (response.status === 401) {
        onUnauthorized();
        return;
      }
      if (!response.ok) throw new Error(scalpingErrorMessage(payload, "AI 전망을 생성하지 못했습니다."));
      const forecasts = normalizeScalpingForecasts(payload);
      setWorkspace((current) => current ? {
        ...current,
        candidates: current.candidates.map((candidate) => ({ ...candidate, forecast: forecasts.get(candidate.symbol) ?? candidate.forecast })),
      } : current);
      if (!forecasts.size) setForecastError("예측 응답에 표시 가능한 종목 결과가 없습니다. 임의 값을 표시하지 않습니다.");
    } catch (caught) {
      setForecastError(caught instanceof Error ? caught.message : "AI 전망을 생성하지 못했습니다.");
    } finally {
      setForecastLoading(false);
    }
  };

  const setCriterion = (criterion: ScalpingCriterion) => setRequest((current) => ({ ...current, criterion }));
  const setInterval = (interval: ScalpingInterval) => setRequest((current) => ({ ...current, interval }));
  const setPreset = (preset: ScalpingPreset) => setRequest((current) => ({ ...current, preset }));

  return (
    <section className="min-w-0 space-y-3" aria-labelledby="scalping-assistant-title" data-scalping-assistant>
      <Card className="relative min-w-0 overflow-hidden bg-primary p-5 text-primary-foreground sm:p-7">
        <div className="relative z-10 flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
          <div className="max-w-3xl">
            <div className="mb-3 inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1.5 text-[10px] font-black"><Activity className="size-3.5" />INTRADAY DECISION SUPPORT</div>
            <h2 id="scalping-assistant-title" className="text-[clamp(1.7rem,4vw,3rem)] font-black tracking-[-0.055em]">실시간 후보와 위험을 한눈에.</h2>
            <p className="mt-3 max-w-2xl text-xs leading-5 text-primary-foreground/65">토스증권 랭킹과 한국투자증권 체결·호가를 결합하고, Rust 지표와 공개 AI 전망을 보조 정보로 보여줍니다.</p>
          </div>
          <div className="rounded-[20px] bg-white/10 p-4 text-[10px] leading-5 text-primary-foreground/75" role="note">
            <p className="font-black text-primary-foreground">주문 기능 없음 · 수익 보장 아님</p>
            <p>신호는 투자 판단을 대체하지 않습니다. 확정 봉 신호는 같은 봉 종가 체결로 간주하지 않고 다음 분봉 또는 다음 유효 호가부터 적용합니다.</p>
          </div>
        </div>
      </Card>

      {status ? <StatusBanner status={status} /> : null}

      <Card className="min-w-0 bg-secondary p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div><p className="text-[10px] font-black tracking-[0.12em] text-muted-foreground">SCANNER & WORKSPACE</p><h2 className="mt-1 text-lg font-black">종목 스캐너</h2></div>
          <div className="flex items-center gap-2 text-[9px] font-black text-muted-foreground" role="status" aria-live="polite">
            {streamState === "connected" ? <Wifi className="size-3.5 text-emerald-600" /> : streamState === "reconnecting" ? <LoaderCircle className="size-3.5 animate-spin text-amber-600" /> : <WifiOff className="size-3.5" />}
            실시간 {streamState}
          </div>
        </div>

        <div className="mt-4 grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-5">
          <fieldset className="min-w-0 rounded-[20px] bg-card p-3 sm:col-span-2"><legend className="px-1 text-[9px] font-black text-muted-foreground">순위 기준</legend><div className="mt-1 grid grid-cols-3 gap-1">{SCALPING_CRITERIA.map((criterion) => <button key={criterion} type="button" aria-pressed={request.criterion === criterion} onClick={() => setCriterion(criterion)} className={cn("min-w-0 rounded-full px-2 py-2 text-[10px] font-black", request.criterion === criterion ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground")}>{CRITERION_LABELS[criterion]}</button>)}</div></fieldset>
          <label className="min-w-0 rounded-[20px] bg-card p-3"><span className="mb-2 block text-[9px] font-black text-muted-foreground">표시 종목 수 (5~50)</span><Input aria-label="표시 종목 수" type="number" min={5} max={50} step={1} value={request.topCount} onChange={(event) => setRequest((current) => ({ ...current, topCount: Number(event.target.value) }))} aria-invalid={request.topCount < 5 || request.topCount > 50 || !Number.isInteger(request.topCount)} className="h-10 bg-secondary text-xs" /></label>
          <label className="min-w-0 rounded-[20px] bg-card p-3"><span className="mb-2 block text-[9px] font-black text-muted-foreground">분봉</span><Select value={request.interval} onValueChange={(value) => setInterval(value as ScalpingInterval)}><SelectTrigger aria-label="분봉 간격" className="h-10 w-full min-w-0 bg-secondary text-xs"><SelectValue /></SelectTrigger><SelectContent>{SCALPING_INTERVALS.map((interval) => <SelectItem key={interval} value={interval}>{interval.replace("m", "분봉")}</SelectItem>)}</SelectContent></Select></label>
          <label className="min-w-0 rounded-[20px] bg-card p-3"><span className="mb-2 block text-[9px] font-black text-muted-foreground">차트 열</span><Select value={String(request.layoutColumns)} onValueChange={(value) => setRequest((current) => ({ ...current, layoutColumns: Number(value) as 1 | 2 | 3 | 4 }))}><SelectTrigger aria-label="차트 열 수" className="h-10 w-full min-w-0 bg-secondary text-xs"><SelectValue /></SelectTrigger><SelectContent>{([1, 2, 3, 4] as const).map((columns) => <SelectItem key={columns} value={String(columns)}>{columns}열</SelectItem>)}</SelectContent></Select></label>
        </div>

        <fieldset className="mt-3 min-w-0"><legend className="text-[9px] font-black text-muted-foreground">지표 프리셋</legend><div className="mt-2 grid min-w-0 gap-2 sm:grid-cols-2 xl:grid-cols-4">{SCALPING_PRESETS.map((preset) => <button key={preset} type="button" aria-pressed={request.preset === preset} onClick={() => setPreset(preset)} className={cn("min-w-0 rounded-[18px] p-3 text-left transition-colors", request.preset === preset ? "bg-primary text-primary-foreground" : "bg-card")}><span className="block text-[11px] font-black">{PRESET_LABELS[preset].label}</span><span className={cn("mt-1 block truncate text-[9px]", request.preset === preset ? "text-primary-foreground/60" : "text-muted-foreground")}>{PRESET_LABELS[preset].description}</span></button>)}</div></fieldset>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <div className="text-[9px] text-muted-foreground">{requestIssues.length ? <span role="alert" className="font-black text-destructive">{requestIssues.join(" ")}</span> : <span>모든 종목·지표는 서버에서 한 번의 batch 요청으로 계산됩니다.</span>}</div>
          <div className="flex flex-wrap gap-2"><Button variant="secondary" onClick={() => void requestForecasts()} disabled={!status?.enabled || forecastLoading || loading || !workspace?.candidates.length}>{forecastLoading ? <LoaderCircle className="animate-spin" /> : <BrainCircuit />}AI 전망 요청</Button><Button onClick={() => void runWorkspace(request)} disabled={!status?.enabled || loading || requestIssues.length > 0}>{loading ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}스캔 적용</Button></div>
        </div>
      </Card>

      {error ? <Card className="bg-destructive/10 p-4 text-sm text-destructive" role="alert"><div className="flex gap-2"><AlertTriangle className="mt-0.5 size-4 shrink-0" /><p>{error}</p></div></Card> : null}
      {forecastError ? <Card className="bg-amber-500/10 p-4 text-xs text-amber-800 dark:text-amber-200" role="alert">{forecastError}</Card> : null}

      {workspace ? (
        <Card className="min-w-0 bg-secondary p-4 sm:p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div><p className="text-[10px] font-black tracking-[0.12em] text-muted-foreground">LIVE BOARD</p><h2 className="mt-1 text-lg font-black">{CRITERION_LABELS[workspace.criterion]} 상위 {workspace.candidates.length}종목</h2><p className="mt-1 text-[9px] text-muted-foreground">생성 {formatTimestamp(workspace.generatedAt, true)} · {workspace.interval} · {PRESET_LABELS[workspace.preset].label}</p></div>
            <span className={cn("rounded-full px-3 py-1.5 text-[9px] font-black", availabilityClass(workspace.quality.status))}>batch {workspace.quality.status}</span>
          </div>
          {!workspace.candidates.length ? <div className="mt-4 grid min-h-[260px] place-items-center rounded-[24px] bg-card px-5 text-center"><div><ShieldAlert className="mx-auto size-6 text-muted-foreground" /><p className="mt-3 font-black">표시 가능한 후보가 없습니다.</p><p className="mt-1 text-xs text-muted-foreground">필터, 공급자 상태와 데이터 품질 사유를 확인해 주세요.</p></div></div> : (
            <div className={cn("mt-4 grid min-w-0 gap-3", chartGridClass(request.layoutColumns))} style={{ overflowAnchor: "none" }} data-scalping-grid-columns={request.layoutColumns}>
              {workspace.candidates.map((candidate) => <VirtualizedCandidateCard key={candidate.symbol} candidate={candidate} theme={theme} preset={request.preset} layoutColumns={request.layoutColumns} />)}
            </div>
          )}
        </Card>
      ) : loading ? <Card className="grid min-h-[360px] place-items-center bg-secondary"><div className="text-center"><LoaderCircle className="mx-auto size-6 animate-spin" /><p className="mt-3 text-xs font-black">후보와 분봉을 batch로 불러오는 중</p></div></Card> : null}

      <EvaluationPanel candidates={workspace?.candidates ?? []} interval={request.interval} disabled={!status?.enabled || loading} onUnauthorized={onUnauthorized} />

      <Card className="bg-secondary p-4 text-[10px] leading-5 text-muted-foreground" role="note">
        <div className="flex items-start gap-2"><ShieldAlert className="mt-0.5 size-4 shrink-0" /><p><strong className="text-foreground">안내:</strong> 이 화면은 매수·매도 주문 지시가 아닌 의사결정 보조입니다. AI는 거래 결정을 내리지 않으며, 예측이 없거나 과거 호가가 보존되지 않은 경우 unavailable로 표시합니다. 투자 결과와 손실은 사용자에게 귀속됩니다.</p></div>
      </Card>
    </section>
  );
}

export const ScalpingAssistantView = ScalpingAssistant;
