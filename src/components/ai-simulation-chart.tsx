import { useEffect, useMemo, useState } from "react";
import { Maximize2, Minimize2 } from "lucide-react";
import {
  Area,
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
import { Card } from "@/components/ui/card";
import { formatMoney, formatQuantity } from "@/lib/format";
import type { AiSimulationCurrency } from "@/lib/ai-simulation";
import type {
  AiSimulationForecastLane,
  AiSimulationModelForecast,
} from "@/lib/ai-simulation-forecast";
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
  positionSide?: "long" | "short";
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
  currency: AiSimulationCurrency;
  bars: readonly AiSimulationChartBar[];
  indicators: readonly AiSimulationChartIndicator[];
  trades: readonly AiSimulationChartTrade[];
  patterns: readonly AiSimulationChartPattern[];
  updatedAt?: string;
  forecasts?: readonly AiSimulationModelForecast[];
  className?: string;
};

export type AiSimulationChartTradePoint = {
  id: string;
  timestamp: string;
  price: number;
  trade: AiSimulationChartTrade;
};

export type AiSimulationCombinedChartRow = {
  timestamp: string;
  time: number;
  chartTime?: number;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  volume?: number;
  status?: AiSimulationChartBarStatus;
  indicatorValues: Record<string, number>;
  candleRange?: [number, number];
  forecastCoordinateHints?: Array<{
    originTime: number;
    horizonMinutes: number;
  }>;
} & Record<string, unknown>;

type ChartRow = AiSimulationCombinedChartRow;

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

const MODEL_FORECAST_STYLE: Readonly<Record<AiSimulationForecastLane, {
  label: string;
  stroke: string;
  fill: string;
}>> = {
  kronos_base: {
    label: "Kronos-base",
    stroke: "#6d28d9",
    fill: "#8b5cf6",
  },
  fincast: {
    label: "FinCast",
    stroke: "#0f766e",
    fill: "#14b8a6",
  },
};

const PATTERN_LABELS: Readonly<Record<string, string>> = {
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
    time: Date.parse(bar.timestamp),
    candleRange: [bar.low, bar.high],
  }));
}

function forecastKey(
  lane: AiSimulationForecastLane,
  field: "range" | "q10" | "median" | "q90",
): string {
  return `forecast:${lane}:${field}`;
}

/**
 * Extends finalized/forming candle rows with exact model target timestamps.
 * Only an exact finalized origin close may anchor a forecast path; missing
 * targets are never interpolated and no return-to-price conversion occurs.
 */
export function aiSimulationCombinedChartRows(
  bars: readonly AiSimulationChartBar[],
  forecasts: readonly AiSimulationModelForecast[] = [],
): AiSimulationCombinedChartRow[] {
  const rows = chartRows(bars);
  const byTime = new Map(rows.map((row) => [row.time, row]));
  const exactFinalClose = new Map(
    rows.flatMap((row) => (
      row.status === "final" && finite(row.close) ? [[row.time, row.close] as const] : []
    )),
  );

  for (const forecast of forecasts) {
    if (forecast.status !== "available" || !forecast.origin) continue;
    const originTime = Date.parse(forecast.origin);
    if (!Number.isFinite(originTime)) continue;
    const originClose = exactFinalClose.get(originTime)
      ?? (forecast.lane === "fincast" && finite(forecast.originPrice)
        && forecast.originPrice > 0
        ? forecast.originPrice
        : undefined);
    if (originClose !== undefined) {
      const originRow = byTime.get(originTime) ?? {
        timestamp: new Date(originTime).toISOString(),
        time: originTime,
        indicatorValues: {},
      };
      originRow[forecastKey(forecast.lane, "range")] = [originClose, originClose];
      originRow[forecastKey(forecast.lane, "q10")] = originClose;
      originRow[forecastKey(forecast.lane, "median")] = originClose;
      originRow[forecastKey(forecast.lane, "q90")] = originClose;
      byTime.set(originTime, originRow);
    }
    for (const point of forecast.points) {
      const time = Date.parse(point.targetTimestamp);
      if (!Number.isFinite(time) || time <= originTime) continue;
      const row = byTime.get(time) ?? {
        timestamp: new Date(time).toISOString(),
        time,
        indicatorValues: {},
      };
      row[forecastKey(forecast.lane, "range")] = [point.q10Price, point.q90Price];
      row[forecastKey(forecast.lane, "q10")] = point.q10Price;
      row[forecastKey(forecast.lane, "median")] = point.medianPrice;
      row[forecastKey(forecast.lane, "q90")] = point.q90Price;
      row.forecastCoordinateHints = [
        ...(row.forecastCoordinateHints ?? []),
        { originTime, horizonMinutes: point.horizonMinutes },
      ].filter((hint, index, values) => values.findIndex((candidate) => (
        candidate.originTime === hint.originTime
        && candidate.horizonMinutes === hint.horizonMinutes
      )) === index);
      byTime.set(time, row);
    }
  }
  return [...byTime.values()].sort((left, right) => left.time - right.time);
}

/**
 * A future path is current only when it was produced from the newest finalized
 * candle and every advertised target is still ahead of that candle. This also
 * protects archived/legacy payloads when a worker's last success was later
 * followed by failures.
 */
export function aiSimulationCurrentModelForecasts(
  bars: readonly AiSimulationChartBar[],
  forecasts: readonly AiSimulationModelForecast[],
): AiSimulationModelForecast[] {
  const latestFinalTime = normalizedBars(bars).flatMap((bar) => (
    bar.status === "final" ? [Date.parse(bar.timestamp)] : []
  )).at(-1);
  if (latestFinalTime === undefined) return [];
  return forecasts.filter((forecast) => (
    forecast.status === "available"
    && forecast.origin !== undefined
    && (
      Date.parse(forecast.origin) === latestFinalTime
      || (
        forecast.lane === "fincast"
        && finite(forecast.originPrice)
        && forecast.originPrice > 0
        && Date.parse(forecast.origin) > latestFinalTime
        && Date.parse(forecast.origin) - latestFinalTime <= 60_000
      )
    )
    && forecast.points.length > 0
    && forecast.points.every((point) => (
      Date.parse(point.targetTimestamp) > latestFinalTime
    ))
  ));
}

export function aiSimulationNearestChartRow(
  rows: readonly AiSimulationCombinedChartRow[],
  coordinate: number,
): AiSimulationCombinedChartRow | undefined {
  if (!Number.isFinite(coordinate)) return undefined;
  return rows.reduce<AiSimulationCombinedChartRow | undefined>(
    (selected, row) => (
      !selected
      || Math.abs((row.chartTime ?? row.time) - coordinate)
        < Math.abs((selected.chartTime ?? selected.time) - coordinate)
        ? row
        : selected
    ),
    undefined,
  );
}

/**
 * Binance futures trade continuously, so their wall-clock distance is the
 * correct chart distance. Stock minute bars have overnight/weekend holes;
 * compress those holes to one observed-bar interval while keeping future
 * forecast minutes proportional after the newest candle.
 */
export function aiSimulationChartCoordinateRows(
  rows: readonly AiSimulationCombinedChartRow[],
  continuousTimeline: boolean,
): AiSimulationCombinedChartRow[] {
  const ordered = [...rows].sort((left, right) => left.time - right.time);
  if (continuousTimeline || ordered.length < 2) {
    return ordered.map((row) => ({ ...row, chartTime: row.time }));
  }
  const actualRows = ordered.filter((row) => finite(row.close) && row.candleRange !== undefined);
  if (actualRows.length < 2) {
    return ordered.map((row) => ({ ...row, chartTime: row.time }));
  }
  const deltas = actualRows.slice(1).flatMap((row, index) => {
    const delta = row.time - actualRows[index]!.time;
    return delta > 0 ? [delta] : [];
  }).sort((left, right) => left - right);
  const observedInterval = Math.max(
    1,
    Math.min(
      5 * 60_000,
      deltas[Math.floor((deltas.length - 1) / 2)] ?? 60_000,
    ),
  );
  const coordinates = new Map<number, number>();
  let coordinate = actualRows[0]!.time;
  coordinates.set(actualRows[0]!.time, coordinate);
  for (let index = 1; index < actualRows.length; index += 1) {
    const current = actualRows[index]!;
    coordinate += Math.min(current.time - actualRows[index - 1]!.time, observedInterval);
    coordinates.set(current.time, coordinate);
  }
  const firstActual = actualRows[0]!;
  const lastActual = actualRows.at(-1)!;
  const firstCoordinate = coordinates.get(firstActual.time)!;
  const lastCoordinate = coordinates.get(lastActual.time)!;
  return ordered.map((row) => {
    const exact = coordinates.get(row.time);
    if (exact !== undefined) return { ...row, chartTime: exact };
    if (row.time < firstActual.time) {
      return { ...row, chartTime: firstCoordinate - (firstActual.time - row.time) };
    }
    if (row.time > lastActual.time) {
      const forecastCoordinate = row.forecastCoordinateHints?.flatMap((hint) => {
        const originCoordinate = coordinates.get(hint.originTime);
        return originCoordinate === undefined
          ? []
          : [originCoordinate + hint.horizonMinutes * 60_000];
      })[0];
      return {
        ...row,
        chartTime: forecastCoordinate ?? lastCoordinate + (row.time - lastActual.time),
      };
    }
    const nextIndex = actualRows.findIndex((actual) => actual.time > row.time);
    const next = actualRows[nextIndex]!;
    const previous = actualRows[nextIndex - 1]!;
    const previousCoordinate = coordinates.get(previous.time)!;
    const nextCoordinate = coordinates.get(next.time)!;
    const position = (row.time - previous.time) / (next.time - previous.time);
    return {
      ...row,
      chartTime: previousCoordinate + (nextCoordinate - previousCoordinate) * position,
    };
  });
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
  if (!payload
    || !finite(payload.open)
    || !finite(payload.high)
    || !finite(payload.low)
    || !finite(payload.close)
    || !payload.candleRange) return <g />;
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

export function aiSimulationTradeMarkerColor(side: "buy" | "sell"): string {
  return side === "buy" ? "var(--candle-rise)" : "var(--candle-fall)";
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
  const color = aiSimulationTradeMarkerColor(point.trade.side);
  const direction = `${buy ? "매수" : "매도"}${
    point.trade.positionSide ? ` · ${point.trade.positionSide.toUpperCase()}` : ""
  }`;
  const unit = currency === "USDT" ? "계약" : "주";
  const label = `${direction} ${formatQuantity(point.trade.quantity)}${unit} · ${formatMoney(point.price, currency)}`;
  return (
    <g
      aria-label={label}
      data-ai-simulation-trade-marker={point.trade.side}
      data-ai-simulation-position-side={point.trade.positionSide}
      data-ai-simulation-trade-at={point.trade.executedAt}
      data-ai-simulation-trade-color={buy ? "red" : "blue"}
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
  updatedAt,
  forecasts = [],
  className,
}: AiSimulationChartProps) {
  const [expanded, setExpanded] = useState(false);
  const [selectedTime, setSelectedTime] = useState<number>();
  const actualRows = useMemo(() => chartRows(bars), [bars]);
  const currentForecasts = useMemo(
    () => aiSimulationCurrentModelForecasts(bars, forecasts),
    [bars, forecasts],
  );
  const rows = useMemo(
    () => aiSimulationCombinedChartRows(bars, currentForecasts),
    [bars, currentForecasts],
  );
  const coordinateRows = useMemo(
    () => aiSimulationChartCoordinateRows(rows, currency === "USDT"),
    [currency, rows],
  );
  const coordinateByTimestamp = useMemo(
    () => new Map(coordinateRows.map((row) => [row.time, row.chartTime ?? row.time])),
    [coordinateRows],
  );
  const timestampAtCoordinate = (coordinate: number): string => {
    const nearest = aiSimulationNearestChartRow(coordinateRows, coordinate);
    return nearest?.timestamp ?? new Date(coordinate).toISOString();
  };
  const overlays = useMemo(
    () => priceOverlays(actualRows, indicators),
    [actualRows, indicators],
  );
  const tradePoints = useMemo(
    () => aiSimulationChartTradePoints(bars, trades),
    [bars, trades],
  );
  const latestBar = actualRows.at(-1);
  const selectedRow = coordinateRows.find((row) => row.time === selectedTime)
    ?? latestBar
    ?? coordinateRows.at(-1);
  const availableForecasts = currentForecasts;
  const forecastOriginAvailability = new Map(availableForecasts.map((forecast) => [
    forecast.lane,
    Boolean(
      forecast.origin
      && (
        actualRows.some((row) => (
          row.status === "final"
          && row.time === Date.parse(forecast.origin!)
        ))
        || (
          forecast.lane === "fincast"
          && finite(forecast.originPrice)
          && forecast.originPrice > 0
        )
      ),
    ),
  ]));
  const recentPatterns = useMemo(
    () => [...patterns]
      .filter((pattern) => Number.isFinite(Date.parse(pattern.detectedAt)))
      .sort((left, right) => Date.parse(right.detectedAt) - Date.parse(left.detectedAt))
      .slice(0, AI_SIMULATION_CHART_MAX_PATTERN_BADGES),
    [patterns],
  );
  useEffect(() => {
    if (!expanded) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [expanded]);

  return (
    <Card
      className={cn(
        "min-w-0 overflow-hidden p-4 sm:p-5",
        expanded && "fixed inset-2 z-[100] overflow-y-auto bg-background shadow-2xl sm:inset-4",
        className,
      )}
      data-ai-simulation-chart={symbol}
      data-ai-simulation-chart-expanded={expanded}
    >
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-black">{name ? `${name} · ${symbol}` : symbol}</h3>
          <p className="mt-1 text-[9px] font-bold text-muted-foreground">
            OHLC · 최근 {actualRows.length}/{AI_SIMULATION_CHART_MAX_BARS}개 봉
            {availableForecasts.length ? ` · 예측 ${availableForecasts.length}개 lane 연속 표시` : ""}
          </p>
        </div>
        <div className="flex shrink-0 items-start gap-2">
        {latestBar ? (
          <dl className="flex flex-wrap justify-end gap-x-3 gap-y-1 text-[9px]">
            <div>
              <dt className="inline text-muted-foreground">
                {latestBar.status === "forming" ? "현재가 " : "종가 "}
              </dt>
              <dd className="inline font-black">{formatMoney(latestBar.close!, currency)}</dd>
            </div>
            {finite(latestBar.volume) ? (
              <div>
                <dt className="inline text-muted-foreground">거래량 </dt>
                <dd className="inline font-black">{formatQuantity(latestBar.volume)}</dd>
              </div>
            ) : null}
            <div className="basis-full text-right">
              <dt
                className={cn(
                  "inline font-black",
                  latestBar.status === "forming"
                    ? "text-amber-700 dark:text-amber-300"
                    : "text-muted-foreground",
                )}
                data-ai-simulation-latest-bar-status={latestBar.status}
              >
                {latestBar.status === "forming" ? "실시간 진행봉" : "확정봉"}
              </dt>
              {updatedAt ? (
                <dd className="ml-1 inline text-muted-foreground">
                  · 갱신 {formatTimestamp(updatedAt)}
                </dd>
              ) : null}
            </div>
          </dl>
        ) : null}
          <button
            type="button"
            className="grid size-9 shrink-0 place-items-center rounded-xl bg-secondary text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => setExpanded((value) => !value)}
            aria-label={expanded ? `${symbol} 차트 축소` : `${symbol} 차트 전체화면 확대`}
            title={expanded ? "차트 축소 (Esc)" : "차트 전체화면 확대"}
          >
            {expanded ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
          </button>
        </div>
      </div>

      {actualRows.length ? (
        <>
        {selectedRow ? (
          <section
            className="mt-3 min-w-0 rounded-[20px] bg-secondary px-3 py-2.5"
            data-ai-simulation-hover-metrics
            aria-live="polite"
            aria-label="차트 커서 시점 지표"
          >
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[9px]">
              <span className="font-black">{formatTimestamp(selectedRow.timestamp)}</span>
              {finite(selectedRow.open) ? <span>시 {formatMoney(selectedRow.open, currency)}</span> : null}
              {finite(selectedRow.high) ? <span>고 {formatMoney(selectedRow.high, currency)}</span> : null}
              {finite(selectedRow.low) ? <span>저 {formatMoney(selectedRow.low, currency)}</span> : null}
              {finite(selectedRow.close) ? <span>종 {formatMoney(selectedRow.close, currency)}</span> : null}
              {finite(selectedRow.volume) ? <span>거래량 {formatQuantity(selectedRow.volume)}</span> : null}
            </div>
            <div className="mt-1.5 flex max-w-full flex-wrap gap-x-3 gap-y-1 text-[8px] text-muted-foreground">
              {Object.entries(selectedRow.indicatorValues).map(([key, value]) => (
                <span key={key}>{key} {formatIndicatorValue(value)}</span>
              ))}
              {availableForecasts.flatMap((forecast) => {
                const style = MODEL_FORECAST_STYLE[forecast.lane];
                const median = selectedRow[forecastKey(forecast.lane, "median")];
                const q10 = selectedRow[forecastKey(forecast.lane, "q10")];
                const q90 = selectedRow[forecastKey(forecast.lane, "q90")];
                return finite(median) ? [(
                  <span key={forecast.lane} style={{ color: style.stroke }}>
                    {style.label} Q10 {finite(q10) ? formatMoney(q10, currency) : "–"}
                    {" · "}중앙 {formatMoney(median, currency)}
                    {" · "}Q90 {finite(q90) ? formatMoney(q90, currency) : "–"}
                  </span>
                )] : [];
              })}
            </div>
          </section>
        ) : null}
        <div
          className={cn(
            "mt-3 h-[300px] min-w-0 max-w-full rounded-[20px] bg-secondary p-2",
            expanded && "h-[62vh] min-h-[420px]",
          )}
          data-ai-simulation-price-chart
          role="img"
          aria-label={`${name ?? symbol} 시뮬레이션 캔들 차트`}
          onMouseMove={(event) => {
            if (!coordinateRows.length) return;
            const bounds = event.currentTarget.getBoundingClientRect();
            const plotLeft = bounds.left + 8;
            const plotRight = Math.max(plotLeft + 1, bounds.right - 66);
            const ratio = Math.max(
              0,
              Math.min(1, (event.clientX - plotLeft) / (plotRight - plotLeft)),
            );
            const firstCoordinate = coordinateRows[0]!.chartTime ?? coordinateRows[0]!.time;
            const lastCoordinate = coordinateRows.at(-1)!.chartTime
              ?? coordinateRows.at(-1)!.time;
            const nearest = aiSimulationNearestChartRow(
              coordinateRows,
              firstCoordinate + (lastCoordinate - firstCoordinate) * ratio,
            );
            if (nearest) setSelectedTime(nearest.time);
          }}
        >
          <ResponsiveContainer width="100%" height="100%" minWidth={1} minHeight={1}>
            <ComposedChart
              data={coordinateRows}
              syncId={AI_SIMULATION_CHART_SYNC_ID}
              syncMethod="value"
              margin={{ top: 12, right: 5, bottom: 0, left: 0 }}
              onMouseMove={(state: unknown) => {
                const interaction = state as {
                  activeLabel?: string | number;
                  activeTooltipIndex?: string | number;
                  activePayload?: Array<{ payload?: AiSimulationCombinedChartRow }>;
                } | undefined;
                const payloadRow = interaction?.activePayload?.[0]?.payload;
                const tooltipIndex = Number(interaction?.activeTooltipIndex);
                const indexedRow = Number.isSafeInteger(tooltipIndex)
                  ? coordinateRows[tooltipIndex]
                  : undefined;
                const activeLabel = Number(interaction?.activeLabel);
                const nearest = aiSimulationNearestChartRow(coordinateRows, activeLabel);
                const selected = payloadRow ?? indexedRow ?? nearest;
                if (selected && Number.isFinite(selected.time)) setSelectedTime(selected.time);
              }}
            >
              <CartesianGrid
                stroke="hsl(var(--border))"
                vertical={false}
                strokeDasharray="3 5"
              />
              <XAxis
                dataKey="chartTime"
                type="number"
                scale="linear"
                domain={["dataMin", "dataMax"]}
                tickFormatter={(value) => chartTime(timestampAtCoordinate(Number(value)))}
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
                content={() => null}
                cursor={{ stroke: "hsl(var(--foreground) / 0.45)", strokeWidth: 1 }}
                wrapperStyle={{ display: "none" }}
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
              {availableForecasts.map((forecast) => {
                const style = MODEL_FORECAST_STYLE[forecast.lane];
                const anchored = forecastOriginAvailability.get(forecast.lane) === true;
                return (
                  <Area
                    key={`${forecast.lane}:range`}
                    dataKey={forecastKey(forecast.lane, "range")}
                    name={`${style.label} Q10–Q90 예측 범위`}
                    type="linear"
                    fill={style.fill}
                    fillOpacity={0.1}
                    stroke="none"
                    connectNulls={false}
                    isAnimationActive={false}
                    data-ai-simulation-forecast-band={forecast.lane}
                    {...(!anchored ? { strokeDasharray: "3 3" } : {})}
                  />
                );
              })}
              {availableForecasts.flatMap((forecast) => {
                const style = MODEL_FORECAST_STYLE[forecast.lane];
                return [
                  <Line
                    key={`${forecast.lane}:q10`}
                    dataKey={forecastKey(forecast.lane, "q10")}
                    name={`${style.label} Q10`}
                    type="linear"
                    stroke={style.stroke}
                    strokeDasharray="3 3"
                    strokeWidth={1}
                    dot={false}
                    connectNulls={false}
                    isAnimationActive={false}
                  />,
                  <Line
                    key={`${forecast.lane}:median`}
                    dataKey={forecastKey(forecast.lane, "median")}
                    name={`${style.label} 중앙값`}
                    type="linear"
                    stroke={style.stroke}
                    strokeWidth={2}
                    dot={{ r: 2 }}
                    connectNulls={false}
                    isAnimationActive={false}
                    data-ai-simulation-forecast-line={forecast.lane}
                  />,
                  <Line
                    key={`${forecast.lane}:q90`}
                    dataKey={forecastKey(forecast.lane, "q90")}
                    name={`${style.label} Q90`}
                    type="linear"
                    stroke={style.stroke}
                    strokeDasharray="3 3"
                    strokeWidth={1}
                    dot={false}
                    connectNulls={false}
                    isAnimationActive={false}
                  />,
                ];
              })}
              {availableForecasts.flatMap((forecast) => {
                const originTime = forecast.origin ? Date.parse(forecast.origin) : Number.NaN;
                const originCoordinate = coordinateByTimestamp.get(originTime);
                return originCoordinate !== undefined ? [(
                  <ReferenceLine
                    key={`${forecast.lane}:origin`}
                    x={originCoordinate}
                    stroke={MODEL_FORECAST_STYLE[forecast.lane].stroke}
                    strokeDasharray="2 4"
                    strokeOpacity={0.7}
                    data-ai-simulation-forecast-origin={forecast.lane}
                  />
                )] : [];
              })}
              {tradePoints.map((point) => (
                <ReferenceDot
                  key={point.id}
                  x={coordinateByTimestamp.get(Date.parse(point.timestamp))
                    ?? Date.parse(point.timestamp)}
                  y={point.price}
                  ifOverflow="extendDomain"
                  isFront
                  shape={<TradeMarkerShape currency={currency} point={point} />}
                />
              ))}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        </>
      ) : (
        <div
          className="mt-3 grid h-[300px] place-items-center rounded-[20px] bg-secondary px-4 text-center text-xs font-bold text-muted-foreground"
          data-ai-simulation-chart-empty
        >
          시뮬레이션에 사용할 확정 또는 진행 중인 캔들 데이터가 없습니다.
        </div>
      )}

      {forecasts.length ? (
        <section
          className="mt-2 min-w-0 rounded-[20px] bg-secondary p-3"
          data-ai-simulation-model-forecast-overlay
          aria-label={`${symbol} 모델 미래 가격 예측`}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="text-[10px] font-black">분봉 뒤에 이어진 모델 예측</h4>
            <span className="text-[8px] text-muted-foreground">원시 target timestamp · 보간 없음</span>
          </div>
          <div className="mt-2 flex max-w-full flex-wrap gap-1.5">
            {forecasts.map((forecast) => {
              const style = MODEL_FORECAST_STYLE[forecast.lane];
              const anchored = forecastOriginAvailability.get(forecast.lane) === true;
              const current = currentForecasts.includes(forecast);
              return (
                <span
                  key={`${forecast.signalSymbol}:${forecast.lane}:${forecast.origin ?? "unavailable"}`}
                  className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-card px-2 py-1 text-[8px] font-black"
                  data-ai-simulation-model-forecast={forecast.lane}
                  data-ai-simulation-model-forecast-status={current
                    ? "available"
                    : forecast.status === "available"
                      ? "stale"
                      : forecast.status}
                  data-ai-simulation-model-forecast-origin={anchored ? "exact-final" : "unavailable"}
                  title={forecast.modelId}
                >
                  <span className="h-0.5 w-3 shrink-0" style={{ backgroundColor: style.stroke }} />
                  {style.label}
                  {current
                    ? ` · ${forecast.points.length}개 horizon`
                    : forecast.status === "available"
                      ? " · stale"
                      : " · unavailable"}
                </span>
              );
            })}
          </div>
          {forecasts.some((forecast) => (
            forecast.status === "available" && !currentForecasts.includes(forecast)
          )) ? (
            <p className="mt-2 text-[8px] leading-4 text-muted-foreground" role="status">
              최신 확정봉보다 오래된 예측은 미래 경로로 표시하지 않습니다.
            </p>
          ) : null}
          {availableForecasts.flatMap((forecast) => (
            forecastOriginAvailability.get(forecast.lane) === true ? [] : [(
              <p
                key={`${forecast.lane}:origin-warning`}
                className="mt-2 text-[8px] leading-4 text-amber-800 dark:text-amber-200"
                role="status"
              >
                {MODEL_FORECAST_STYLE[forecast.lane].label}: origin과 정확히 일치하는 확정봉이 없어
                과거 가격으로 연결하지 않았습니다.
              </p>
            )]
          ))}
          {availableForecasts.length ? (
            <div className="mt-2 flex max-w-full flex-wrap gap-1.5">
              {availableForecasts.flatMap((forecast) => forecast.points.map((point) => (
                <details
                  key={`${forecast.lane}:${point.horizonMinutes}:${point.targetTimestamp}`}
                  className="max-w-full rounded-2xl bg-card px-2 py-1 text-[8px] text-muted-foreground"
                  data-ai-simulation-model-forecast-horizon={`${forecast.lane}:${point.horizonMinutes}`}
                >
                  <summary className="cursor-pointer font-black">
                    {MODEL_FORECAST_STYLE[forecast.lane].label} +{point.horizonMinutes}분
                    {" · 중앙 "}{formatMoney(point.medianPrice, currency)}
                  </summary>
                  <span className="mt-1 block break-words pr-1 leading-4">
                    {formatTimestamp(point.targetTimestamp)}
                    {" · Q10 "}{formatMoney(point.q10Price, currency)}
                    {" · Q90 "}{formatMoney(point.q90Price, currency)}
                  </span>
                </details>
              )))}
            </div>
          ) : null}
        </section>
      ) : null}

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
