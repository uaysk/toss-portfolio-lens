import { useMemo } from "react";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceDot,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card } from "@/components/ui/card";
import { formatMoney, formatQuantity } from "@/lib/format";
import {
  scalpingTradeMarkerPoints,
  type ScalpingTradeMarker,
} from "@/lib/scalping-assistant";
import { cn } from "@/lib/utils";

export const AI_SIMULATION_CHART_MAX_BARS = 180;
const AI_SIMULATION_CHART_MAX_PATTERN_BADGES = 12;
const AI_SIMULATION_CHART_SYNC_ID = "ai-simulation-shared-time";

export type AiSimulationChartBarStatus = "forming" | "final" | "unknown";
export type AiSimulationChartPatternBias = "bullish" | "bearish" | "neutral";

export type AiSimulationChartBar = {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
  status: AiSimulationChartBarStatus;
  indicatorValues: Record<string, number>;
};

export type AiSimulationChartIndicator = {
  id: string;
  kind: string;
  status: string;
  values: Record<string, number>;
};

export type AiSimulationChartTrade = {
  executedAt: string;
  price: number;
  side: "buy" | "sell";
  quantity: number;
};

export type AiSimulationChartPattern = {
  detectedAt: string;
  name: string;
  bias: AiSimulationChartPatternBias;
  strength?: number;
};

export type AiSimulationChartProps = {
  symbol: string;
  name?: string;
  currency: "KRW" | "USD";
  bars: readonly AiSimulationChartBar[];
  indicators: readonly AiSimulationChartIndicator[];
  trades: readonly AiSimulationChartTrade[];
  patterns: readonly AiSimulationChartPattern[];
  className?: string;
};

export type AiSimulationChartTradePoint = {
  id: string;
  timestamp: string;
  price: number;
  trade: AiSimulationChartTrade;
};

type ChartRow = AiSimulationChartBar
  & { candleRange: [number, number] }
  & Record<string, unknown>;

type PriceOverlay = {
  key: string;
  label: string;
};

const PRICE_INDICATOR_FIELDS: Readonly<Record<string, readonly string[]>> = {
  sma: ["value"],
  ema: ["value"],
  bollinger: ["upper", "middle", "lower"],
  bollinger_band: ["upper", "middle", "lower"],
  bollinger_bands: ["upper", "middle", "lower"],
  donchian: ["upper", "middle", "lower"],
  donchian_channel: ["upper", "middle", "lower"],
  keltner: ["upper", "middle", "lower"],
  keltner_channel: ["upper", "middle", "lower"],
  supertrend: ["supertrend", "value"],
  sar: ["sar", "value"],
  parabolic_sar: ["sar", "value"],
  session_vwap: ["session_vwap", "vwap", "value"],
  anchored_vwap: ["anchored_vwap", "value"],
  vwap_anchored_vwap: ["vwap", "anchored_vwap"],
};

const PRICE_OVERLAY_COLORS = [
  "#2563eb",
  "#e11d48",
  "#0d9488",
  "#8b5cf6",
  "#ca8a04",
  "#475569",
] as const;

const PATTERN_LABELS: Readonly<Record<string, string>> = {
  bullish_engulfing: "상승 장악형",
  bearish_engulfing: "하락 장악형",
  hammer: "망치형",
  shooting_star: "유성형",
  inside_bar: "인사이드 바",
  bullish_outside_bar: "상승 아웃사이드 바",
  bearish_outside_bar: "하락 아웃사이드 바",
};

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function normalizeKind(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function validBar(bar: AiSimulationChartBar): boolean {
  return Number.isFinite(Date.parse(bar.timestamp))
    && finite(bar.open)
    && finite(bar.high)
    && finite(bar.low)
    && finite(bar.close)
    && bar.open > 0
    && bar.high > 0
    && bar.low > 0
    && bar.close > 0
    && bar.high >= Math.max(bar.open, bar.close, bar.low)
    && bar.low <= Math.min(bar.open, bar.close, bar.high);
}

function normalizedBars(
  bars: readonly AiSimulationChartBar[],
): AiSimulationChartBar[] {
  const byTimestamp = new Map<number, AiSimulationChartBar>();
  for (const bar of bars) {
    if (!validBar(bar)) continue;
    const timestamp = Date.parse(bar.timestamp);
    const indicatorValues = Object.fromEntries(
      Object.entries(bar.indicatorValues).filter((entry): entry is [string, number] => finite(entry[1])),
    );
    byTimestamp.set(timestamp, { ...bar, indicatorValues });
  }
  return [...byTimestamp.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, bar]) => bar)
    .slice(-AI_SIMULATION_CHART_MAX_BARS);
}

function chartRows(bars: readonly AiSimulationChartBar[]): ChartRow[] {
  return normalizedBars(bars).map((bar) => ({
    ...bar.indicatorValues,
    ...bar,
    candleRange: [bar.low, bar.high],
  }));
}

function vwapLabel(key: string): string | undefined {
  const normalized = key.toLowerCase().replace(/[^a-z]/g, "");
  if (normalized.includes("anchoredvwap")) return "Anchored VWAP";
  if (normalized.includes("sessionvwap")) return "Session VWAP";
  return undefined;
}

function priceOverlays(
  rows: readonly ChartRow[],
  indicators: readonly AiSimulationChartIndicator[],
): PriceOverlay[] {
  const overlays = new Map<string, PriceOverlay>();
  const hasValue = (key: string) => rows.some((row) => finite(row.indicatorValues[key]));

  for (const indicator of indicators) {
    const kind = normalizeKind(indicator.kind);
    for (const field of PRICE_INDICATOR_FIELDS[kind] ?? []) {
      const key = `${indicator.id}:${field}`;
      if (hasValue(key)) {
        overlays.set(key, {
          key,
          label: `${indicator.kind.replaceAll("_", " ")} · ${field.replaceAll("_", " ")}`,
        });
      }
    }
  }

  for (const row of rows) {
    for (const key of Object.keys(row.indicatorValues)) {
      const label = vwapLabel(key);
      if (label && hasValue(key) && !overlays.has(key)) {
        overlays.set(key, { key, label });
      }
    }
  }
  return [...overlays.values()];
}

/**
 * Maps a fill to the first visible candle whose close boundary is at or after
 * the fill. Fills outside the bounded chart window are intentionally omitted.
 */
export function aiSimulationChartTradePoints(
  bars: readonly AiSimulationChartBar[],
  trades: readonly AiSimulationChartTrade[],
): AiSimulationChartTradePoint[] {
  const visibleBars = normalizedBars(bars);
  const tradeByMarkerId = new Map<string, AiSimulationChartTrade>();
  const markers: ScalpingTradeMarker[] = trades.flatMap((trade, index) => {
    if (!Number.isFinite(Date.parse(trade.executedAt))
      || !finite(trade.price)
      || trade.price <= 0
      || !finite(trade.quantity)
      || trade.quantity <= 0) {
      return [];
    }
    const id = `simulation-trade:${index}:${trade.executedAt}:${trade.side}`;
    tradeByMarkerId.set(id, trade);
    return [{
      id,
      timestamp: trade.executedAt,
      averagePrice: trade.price,
      quantity: trade.quantity,
      side: trade.side,
      detailLevel: "provider_execution" as const,
    }];
  });

  return scalpingTradeMarkerPoints(visibleBars, markers, AI_SIMULATION_CHART_MAX_BARS)
    .flatMap(({ marker, timestamp, price }) => {
      const trade = tradeByMarkerId.get(marker.id);
      return trade ? [{ id: marker.id, timestamp, price, trade }] : [];
    });
}

function chartTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ko-KR", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function formatIndicatorValue(value: number): string {
  if (Math.abs(value) >= 1_000) {
    return new Intl.NumberFormat("ko-KR", {
      notation: "compact",
      maximumFractionDigits: 2,
    }).format(value);
  }
  return new Intl.NumberFormat("ko-KR", {
    maximumFractionDigits: 3,
  }).format(value);
}

function indicatorStatusClass(status: string): string {
  const normalized = status.toLowerCase();
  if (["available", "ready", "good", "connected", "configured"].includes(normalized)) {
    return "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300";
  }
  if (["partial", "stale", "forming", "reconnecting"].includes(normalized)) {
    return "bg-amber-500/15 text-amber-700 dark:text-amber-300";
  }
  return "bg-secondary text-muted-foreground";
}

function patternClass(bias: AiSimulationChartPatternBias): string {
  if (bias === "bullish") return "bg-rose-500/12 text-rose-700 dark:text-rose-300";
  if (bias === "bearish") return "bg-blue-500/12 text-blue-700 dark:text-blue-300";
  return "bg-secondary text-muted-foreground";
}

function patternBiasLabel(bias: AiSimulationChartPatternBias): string {
  if (bias === "bullish") return "상승";
  if (bias === "bearish") return "하락";
  return "중립";
}

function patternStrength(value: number | undefined): string | undefined {
  if (!finite(value)) return undefined;
  if (value >= 0 && value <= 1) return `${Math.round(value * 100)}%`;
  return formatIndicatorValue(value);
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
  const bodyTop = spread > 0
    ? y + (payload.high - Math.max(payload.open, payload.close)) * pixelsPerUnit
    : y;
  const bodyBottom = spread > 0
    ? y + (payload.high - Math.min(payload.open, payload.close)) * pixelsPerUnit
    : y;
  const center = x + width / 2;
  const bodyWidth = Math.max(1.5, Math.min(width * 0.68, 8));
  return (
    <g data-ai-simulation-candle={payload.status}>
      <line
        x1={center}
        y1={y}
        x2={center}
        y2={y + Math.max(1, height)}
        stroke={color}
        strokeWidth={1}
      />
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

function TradeMarkerShape({
  cx = 0,
  cy = 0,
  currency,
  point,
}: {
  cx?: number;
  cy?: number;
  currency: AiSimulationChartProps["currency"];
  point: AiSimulationChartTradePoint;
}) {
  const buy = point.trade.side === "buy";
  const markerY = cy + (buy ? 8 : -8);
  const color = buy ? "#2563eb" : "#e11d48";
  const label = `${buy ? "매수" : "매도"} ${formatQuantity(point.trade.quantity)}주 · ${formatMoney(point.price, currency)}`;
  return (
    <g
      aria-label={label}
      data-ai-simulation-trade-marker={point.trade.side}
      data-ai-simulation-trade-at={point.trade.executedAt}
    >
      <title>{label}</title>
      <line x1={cx} y1={cy} x2={cx} y2={markerY} stroke={color} strokeWidth={1} />
      <circle cx={cx} cy={markerY} r={7} fill={color} stroke="hsl(var(--card))" strokeWidth={2} />
      <path
        d={buy
          ? `M ${cx - 3} ${markerY + 1} L ${cx} ${markerY - 2} L ${cx + 3} ${markerY + 1}`
          : `M ${cx - 3} ${markerY - 1} L ${cx} ${markerY + 2} L ${cx + 3} ${markerY - 1}`}
        fill="none"
        stroke="white"
        strokeWidth={1.5}
      />
    </g>
  );
}

export function AiSimulationChart({
  symbol,
  name,
  currency,
  bars,
  indicators,
  trades,
  patterns,
  className,
}: AiSimulationChartProps) {
  const rows = useMemo(() => chartRows(bars), [bars]);
  const overlays = useMemo(() => priceOverlays(rows, indicators), [indicators, rows]);
  const tradePoints = useMemo(
    () => aiSimulationChartTradePoints(bars, trades),
    [bars, trades],
  );
  const latestBar = rows.at(-1);
  const recentPatterns = useMemo(
    () => [...patterns]
      .filter((pattern) => Number.isFinite(Date.parse(pattern.detectedAt)))
      .sort((left, right) => Date.parse(right.detectedAt) - Date.parse(left.detectedAt))
      .slice(0, AI_SIMULATION_CHART_MAX_PATTERN_BADGES),
    [patterns],
  );

  return (
    <Card
      className={cn("min-w-0 overflow-hidden p-4 sm:p-5", className)}
      data-ai-simulation-chart={symbol}
    >
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-black">{name ? `${name} · ${symbol}` : symbol}</h3>
          <p className="mt-1 text-[9px] font-bold text-muted-foreground">
            OHLC · 최근 {rows.length}/{AI_SIMULATION_CHART_MAX_BARS}개 봉
          </p>
        </div>
        {latestBar ? (
          <dl className="flex shrink-0 flex-wrap justify-end gap-x-3 gap-y-1 text-[9px]">
            <div>
              <dt className="inline text-muted-foreground">종가 </dt>
              <dd className="inline font-black">{formatMoney(latestBar.close, currency)}</dd>
            </div>
            {finite(latestBar.volume) ? (
              <div>
                <dt className="inline text-muted-foreground">거래량 </dt>
                <dd className="inline font-black">{formatQuantity(latestBar.volume)}</dd>
              </div>
            ) : null}
          </dl>
        ) : null}
      </div>

      {rows.length ? (
        <div
          className="mt-3 h-[300px] min-w-0 max-w-full rounded-[20px] bg-secondary p-2"
          data-ai-simulation-price-chart
          role="img"
          aria-label={`${name ?? symbol} 시뮬레이션 캔들 차트`}
        >
          <ResponsiveContainer width="100%" height="100%" minWidth={1} minHeight={1}>
            <ComposedChart
              data={rows}
              syncId={AI_SIMULATION_CHART_SYNC_ID}
              syncMethod="value"
              margin={{ top: 12, right: 5, bottom: 0, left: 0 }}
            >
              <CartesianGrid
                stroke="hsl(var(--border))"
                vertical={false}
                strokeDasharray="3 5"
              />
              <XAxis
                dataKey="timestamp"
                tickFormatter={chartTime}
                minTickGap={28}
                tick={{ fontSize: 8 }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                orientation="right"
                width={58}
                tick={{ fontSize: 8 }}
                tickFormatter={(value) => formatMoney(Number(value), currency, true)}
                axisLine={false}
                tickLine={false}
                domain={["auto", "auto"]}
              />
              <Tooltip
                labelFormatter={(label) => formatTimestamp(String(label))}
                formatter={(value, label) => [
                  Array.isArray(value)
                    ? value.map((entry) => formatMoney(Number(entry), currency)).join(" – ")
                    : typeof value === "number"
                      ? formatMoney(value, currency)
                      : String(value),
                  String(label),
                ]}
                cursor={{ stroke: "hsl(var(--foreground) / 0.45)", strokeWidth: 1 }}
                wrapperStyle={{ zIndex: 30 }}
              />
              <Bar
                dataKey="candleRange"
                name="저가–고가"
                shape={<CandleShape />}
                isAnimationActive={false}
              />
              {overlays.map((overlay, index) => (
                <Line
                  key={overlay.key}
                  dataKey={overlay.key}
                  name={overlay.label}
                  type="linear"
                  dot={false}
                  connectNulls={false}
                  stroke={PRICE_OVERLAY_COLORS[index % PRICE_OVERLAY_COLORS.length]}
                  strokeDasharray={index % 2 ? "5 3" : undefined}
                  strokeWidth={1.25}
                  isAnimationActive={false}
                />
              ))}
              {tradePoints.map((point) => (
                <ReferenceDot
                  key={point.id}
                  x={point.timestamp}
                  y={point.price}
                  ifOverflow="extendDomain"
                  isFront
                  shape={<TradeMarkerShape currency={currency} point={point} />}
                />
              ))}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <div
          className="mt-3 grid h-[300px] place-items-center rounded-[20px] bg-secondary px-4 text-center text-xs font-bold text-muted-foreground"
          data-ai-simulation-chart-empty
        >
          시뮬레이션에 사용할 확정 또는 진행 중인 캔들 데이터가 없습니다.
        </div>
      )}

      {overlays.length ? (
        <div
          className="mt-2 flex max-w-full flex-wrap gap-1.5"
          data-ai-simulation-price-overlays="available"
          aria-label="가격 차트 오버레이"
        >
          {overlays.map((overlay, index) => (
            <span
              key={overlay.key}
              className="inline-flex max-w-full items-center gap-1 rounded-full bg-secondary px-2 py-1 text-[8px] font-black text-muted-foreground"
              data-ai-simulation-price-overlay={overlay.key}
              title={overlay.label}
            >
              <span
                className="h-0.5 w-3 shrink-0"
                style={{ backgroundColor: PRICE_OVERLAY_COLORS[index % PRICE_OVERLAY_COLORS.length] }}
              />
              <span className="truncate">{overlay.label}</span>
            </span>
          ))}
        </div>
      ) : null}

      <section
        className="mt-3 min-w-0 rounded-[20px] bg-secondary p-3"
        data-ai-simulation-indicators={indicators.length ? "available" : "unavailable"}
        aria-label="시뮬레이션 최신 기술 지표"
      >
        <div className="flex items-center justify-between gap-2">
          <h4 className="text-[10px] font-black">최신 기술 지표</h4>
          <span className="text-[8px] text-muted-foreground">worker 계산값</span>
        </div>
        {indicators.length ? (
          <div className="mt-2 flex max-w-full flex-wrap gap-1.5">
            {indicators.map((indicator, index) => {
              const values = Object.entries(indicator.values)
                .filter((entry): entry is [string, number] => finite(entry[1]))
                .slice(0, 4)
                .map(([field, value]) => `${field.replaceAll("_", " ")} ${formatIndicatorValue(value)}`)
                .join(" · ");
              const label = `${indicator.kind} · ${indicator.status}${values ? ` · ${values}` : ""}`;
              return (
                <span
                  key={`${indicator.id}:${index}`}
                  className={cn(
                    "max-w-full truncate rounded-full px-2 py-1 text-[8px] font-black",
                    indicatorStatusClass(indicator.status),
                  )}
                  data-ai-simulation-indicator-badge={indicator.kind}
                  title={`${indicator.id} · ${label}`}
                >
                  {label}
                </span>
              );
            })}
          </div>
        ) : (
          <p className="mt-2 text-[9px] text-muted-foreground">
            표시할 최신 지표 계산값이 없습니다.
          </p>
        )}
      </section>

      <section
        className="mt-3 min-w-0 rounded-[20px] bg-secondary p-3"
        data-ai-simulation-patterns={recentPatterns.length ? "available" : "unavailable"}
        aria-label="시뮬레이션 차트 패턴 근거"
      >
        <div className="flex items-center justify-between gap-2">
          <h4 className="text-[10px] font-black">차트 패턴 근거</h4>
          <span className="text-[8px] text-muted-foreground">
            {recentPatterns.length ? `최근 ${recentPatterns.length}건` : "감지 없음"}
          </span>
        </div>
        {recentPatterns.length ? (
          <div className="mt-2 flex max-h-24 max-w-full flex-wrap gap-1.5 overflow-y-auto">
            {recentPatterns.map((pattern, index) => {
              const strength = patternStrength(pattern.strength);
              const label = PATTERN_LABELS[pattern.name] ?? pattern.name.replaceAll("_", " ");
              return (
                <span
                  key={`${pattern.detectedAt}:${pattern.name}:${index}`}
                  className={cn(
                    "max-w-full truncate rounded-full px-2 py-1 text-[8px] font-black",
                    patternClass(pattern.bias),
                  )}
                  data-ai-simulation-pattern={pattern.bias}
                  title={`${formatTimestamp(pattern.detectedAt)} · ${label}`}
                >
                  {patternBiasLabel(pattern.bias)} · {label}
                  {strength ? ` · 강도 ${strength}` : ""}
                </span>
              );
            })}
          </div>
        ) : (
          <p className="mt-2 text-[9px] text-muted-foreground">
            현재 차트 구간에서 확인된 캔들 패턴이 없습니다.
          </p>
        )}
      </section>
    </Card>
  );
}
