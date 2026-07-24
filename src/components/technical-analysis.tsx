import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AlertCircle,
  CandlestickChart,
  Check,
  ChevronDown,
  LoaderCircle,
  Minus,
  Play,
  Plus,
  RefreshCw,
  Save,
  Search,
  SlidersHorizontal,
  Trash2,
  ZoomIn,
  ZoomOut,
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
import { StockSwatch } from "@/components/stock-swatch";
import { TechnicalStrategyBuilder } from "@/components/technical-strategy-builder";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MONOCHROME_DASHES } from "@/lib/chart-theme";
import { isValidCalendarRange, seoulDateString } from "@/lib/date-range";
import { formatMoney, formatPercent, formatQuantity } from "@/lib/format";
import {
  createLibraryPreset,
  getLibraryPreset,
  listLibraryPresets,
  type PresetLibraryItem,
} from "@/lib/research-library";
import {
  TECHNICAL_INDICATOR_BY_KIND,
  TECHNICAL_INDICATOR_PRESETS,
  TECHNICAL_BATCH_INDICATORS,
  TECHNICAL_PRESET_SOURCE,
  buildTechnicalChartRows,
  buildTechnicalIndicatorDefinitions,
  buildVolumeProfileRequest,
  combinedPortfolioWeightMap,
  calculationsForInstrument,
  dateMonthsAgo,
  dateYearsAgo,
  displayTechnicalChartRows,
  indicatorValueKey,
  identifyTechnicalIndicatorPreset,
  isTechnicalVolumeIndicator,
  latestTechnicalIndicatorValue,
  normalizeTechnicalPresetConfig,
  technicalSeriesReturn,
  technicalInstrumentsFromPortfolioHistory,
  technicalMarkerBarDate,
  technicalAvailabilityLabel,
  technicalTradeMarkerStatusNotice,
  volumeProfileCalculation,
  visibleDateCutoff,
  type TechnicalAnalysisPayload,
  type TechnicalAnalysisRequest,
  type TechnicalChartRow,
  type TechnicalIndicatorCalculation,
  type TechnicalIndicatorKind,
  type TechnicalInstrumentChoice,
  type TechnicalPriceSeries,
  type TechnicalTradeMarker,
  type TechnicalVolumeProfileSettings,
  type TechnicalVwapSettings,
} from "@/lib/technical-analysis";
import {
  TechnicalAnalysisApiError,
  requestTechnicalAnalysis,
  requestTechnicalTradeMarkers,
  searchTechnicalInstruments,
} from "@/lib/technical-analysis-api";
import {
  MAX_TECHNICAL_STRATEGY_SYMBOLS,
  TECHNICAL_STRATEGY_PRESET_TYPE,
  createDefaultTechnicalStrategy,
  defaultTechnicalStrategyAnalysisSubset,
  normalizeTechnicalStrategyPresetConfig,
  reconcileTechnicalStrategySelection,
  subsetTechnicalStrategyAnalysis,
  technicalStrategyFingerprint,
  technicalStrategySubsetIssue,
  validateTechnicalStrategyDraft,
  type TechnicalStrategy,
  type TechnicalStrategyAnalysis,
  type TechnicalStrategyHandoff,
} from "@/lib/technical-strategy";
import { cn } from "@/lib/utils";
import type { Holding, Portfolio, Theme } from "@/types";

const CHART_SYNC_ID = "technical-analysis-shared-range";
const INDICATOR_COLORS = [
  "hsl(var(--foreground))",
  "#2563eb",
  "#f97316",
  "#8b5cf6",
  "#0d9488",
  "#e11d48",
] as const;

type PriceMode = "actual" | "starting100";
type CurrencyMode = "local" | "KRW";
type SortMode = "weight" | "return" | "indicator";

type ChartDatum = TechnicalChartRow & Record<string, unknown>;

function toInstrument(holding: Holding): TechnicalInstrumentChoice {
  return {
    symbol: holding.symbol.trim().toUpperCase(),
    name: holding.name,
    market: holding.market,
    currency: holding.currency === "USD" ? "USD" : "KRW",
    assetType: "portfolio_holding",
  };
}

function displayDate(value: string): string {
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("ko-KR", { month: "short", day: "numeric", timeZone: "UTC" }).format(parsed);
}

function priceLineEntries(calculations: TechnicalIndicatorCalculation[]) {
  return calculations.flatMap((calculation) => {
    const option = TECHNICAL_INDICATOR_BY_KIND.get(calculation.kind);
    if (!option) return [];
    return option.priceFields.filter((field) => hasRenderableIndicatorValues(calculation, [field])).map((field) => ({
      calculation,
      field,
      key: indicatorValueKey(calculation.indicator_id, field),
      label: `${option.shortLabel} ${field === "value" ? "" : field}`.trim(),
    }));
  });
}

function hasRenderableIndicatorValues(calculation: TechnicalIndicatorCalculation, fields: string[]): boolean {
  const points = calculation.points ?? (calculation.latest ? [calculation.latest] : []);
  return points.some((point) => fields.some((field) => typeof point.values[field] === "number" && Number.isFinite(point.values[field])));
}

function auxiliaryPanelEntries(calculations: TechnicalIndicatorCalculation[]) {
  return calculations.flatMap((calculation) => {
    const option = TECHNICAL_INDICATOR_BY_KIND.get(calculation.kind);
    if (!option) return [];
    const fields = [...option.oscillatorFields, ...(option.volumeFields ?? [])];
    if (!fields.length || (option.category === "volume" && !hasRenderableIndicatorValues(calculation, fields))) return [];
    return [{
      calculation,
      option,
      fields: fields.map((field) => ({ field, key: indicatorValueKey(calculation.indicator_id, field) })),
      volumeOverlay: option.volumePresentation === "overlay",
    }];
  });
}

function availabilityBadgeClass(status: TechnicalIndicatorCalculation["availability"]["status"]): string {
  if (status === "available") return "bg-secondary text-foreground";
  if (status === "partial" || status === "insufficient_history") return "bg-amber-500/15 text-amber-700 dark:text-amber-300";
  return "bg-destructive/10 text-destructive";
}

function chartGridClass(columns: 1 | 2 | 3 | 4): string {
  if (columns === 2) return "grid-cols-1 xl:grid-cols-2";
  if (columns === 3) return "grid-cols-1 lg:grid-cols-2 xl:grid-cols-3";
  if (columns === 4) return "grid-cols-1 lg:grid-cols-2 xl:grid-cols-4";
  return "grid-cols-1";
}

type CandleShapeProps = {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  payload?: ChartDatum;
};

function CandleShape(input: unknown) {
  const { x = 0, y = 0, width = 0, height = 0, payload } = input as CandleShapeProps;
  if (!payload) return <g />;
  const rising = payload.close >= payload.open;
  const color = rising ? "var(--candle-rise)" : "var(--candle-fall)";
  const spread = payload.high - payload.low;
  const pixelsPerUnit = spread > 0 ? height / spread : 0;
  const bodyTop = spread > 0 ? y + (payload.high - Math.max(payload.open, payload.close)) * pixelsPerUnit : y;
  const bodyBottom = spread > 0 ? y + (payload.high - Math.min(payload.open, payload.close)) * pixelsPerUnit : y;
  const center = x + width / 2;
  const bodyWidth = Math.max(1.5, Math.min(width * 0.7, 9));
  return (
    <g data-candle-direction={rising ? "rise" : "fall"}>
      <line x1={center} y1={y} x2={center} y2={y + Math.max(1, height)} stroke={color} strokeWidth={1} />
      <rect
        x={center - bodyWidth / 2}
        y={bodyTop}
        width={bodyWidth}
        height={Math.max(1.5, bodyBottom - bodyTop)}
        rx={1}
        fill={color}
        stroke={color}
      />
    </g>
  );
}

function TradeMarkerShape({ cx = 0, cy = 0, marker }: { cx?: number; cy?: number; marker: TechnicalTradeMarker }) {
  const buy = marker.side === "buy";
  const detail = [
    `${marker.date} ${buy ? "매수" : "매도"}`,
    `동일 날짜 주문 ${marker.order_count}건`,
    "개별 체결 수 unavailable",
    `수량 ${formatQuantity(marker.filled_quantity)}`,
    `평균 체결가 ${marker.average_filled_price === null ? "unavailable" : formatMoney(marker.average_filled_price, marker.currency)}`,
    `체결 금액 ${marker.filled_amount === null ? "unavailable" : formatMoney(marker.filled_amount, marker.currency)}`,
    marker.trade_weight.status === "estimated" ? `추정 비중 ${formatPercent(marker.trade_weight.percent)}` : `비중 unavailable: ${marker.trade_weight.reason}`,
    marker.position_weight.status === "estimated"
      ? `추정 종목 비중 ${formatPercent(marker.position_weight.before_percent)} → ${formatPercent(marker.position_weight.after_percent)}`
      : `종목 비중 unavailable: ${marker.position_weight.reason}`,
  ].join(" · ");
  return (
    <g transform={`translate(${cx} ${cy})`} aria-label={detail} role="img">
      <title>{detail}</title>
      <circle r={7} fill={buy ? "#2563eb" : "#e11d48"} stroke="hsl(var(--card))" strokeWidth={2} />
      <path d={buy ? "M-3,-1 L0,3 L3,-1" : "M-3,1 L0,-3 L3,1"} fill="none" stroke="white" strokeWidth={1.5} />
    </g>
  );
}

function PriceTooltip({
  active,
  payload,
  priceMode,
  currency,
  lines,
}: {
  active?: boolean;
  payload?: Array<{ payload?: ChartDatum }>;
  priceMode: PriceMode;
  currency: string;
  lines: ReturnType<typeof priceLineEntries>;
}) {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;
  const formatPrice = (value: number) => priceMode === "starting100" ? value.toFixed(2) : formatMoney(value, currency);
  return (
    <div className="min-w-52 rounded-2xl bg-card p-4 text-xs shadow-2xl">
      <p className="font-black">{point.date}</p>
      <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-muted-foreground">
        <span>시가</span><strong className="text-right text-foreground">{formatPrice(point.open)}</strong>
        <span>고가</span><strong className="text-right text-foreground">{formatPrice(point.high)}</strong>
        <span>저가</span><strong className="text-right text-foreground">{formatPrice(point.low)}</strong>
        <span>종가</span><strong className="text-right text-foreground">{formatPrice(point.close)}</strong>
        {lines.map((line) => {
          const value = point[line.key];
          return typeof value === "number" ? (
            <span className="contents" key={line.key}>
              <span>{line.label}</span><strong className="text-right text-foreground">{formatPrice(value)}</strong>
            </span>
          ) : null;
        })}
      </div>
    </div>
  );
}

function OscillatorTooltip({ active, payload, label }: { active?: boolean; payload?: Array<{ name?: string; value?: unknown }>; label?: string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="min-w-40 rounded-2xl bg-card p-3 text-xs shadow-2xl">
      <p className="font-black">{label}</p>
      <div className="mt-2 space-y-1">
        {payload.flatMap((item) => typeof item.value === "number" ? [(
          <div key={item.name} className="flex justify-between gap-4"><span className="text-muted-foreground">{item.name}</span><strong>{item.value.toFixed(3)}</strong></div>
        )] : [])}
      </div>
    </div>
  );
}

function useLazyChart(): { ref: React.RefObject<HTMLDivElement | null>; visible: boolean } {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (visible) return;
    const node = ref.current;
    if (!node) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisible(true);
        observer.disconnect();
      }
    }, { rootMargin: "600px 0px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [visible]);
  return { ref, visible };
}

type InstrumentCardProps = {
  series: TechnicalPriceSeries;
  instrument: TechnicalInstrumentChoice;
  holding?: Holding;
  historicalPortfolio?: boolean;
  portfolioWeight?: number;
  calculations: TechnicalIndicatorCalculation[];
  globalIndicators: TechnicalIndicatorKind[];
  overrideIndicators?: TechnicalIndicatorKind[];
  interval: "1d" | "1w";
  priceMode: PriceMode;
  visibleFromDate: string;
  markers: TechnicalTradeMarker[];
  showTradeMarkers: boolean;
  theme: Theme;
  onOverrideChange: (symbol: string, kinds: TechnicalIndicatorKind[] | undefined) => void;
};

const TechnicalInstrumentCard = memo(function TechnicalInstrumentCard({
  series,
  instrument,
  holding,
  historicalPortfolio,
  portfolioWeight,
  calculations,
  globalIndicators,
  overrideIndicators,
  interval,
  priceMode,
  visibleFromDate,
  markers,
  showTradeMarkers,
  theme,
  onOverrideChange,
}: InstrumentCardProps) {
  const { ref, visible } = useLazyChart();
  const selected = overrideIndicators ?? globalIndicators;
  const auxiliaryPanels = useMemo(() => auxiliaryPanelEntries(calculations), [calculations]);
  const volumeCalculations = useMemo(
    () => calculations.filter((calculation) => isTechnicalVolumeIndicator(calculation.kind)),
    [calculations],
  );
  const vwapCalculation = volumeCalculations.find((calculation) => calculation.kind === "vwap_anchored_vwap");
  const volumeAvailabilityReasons = useMemo(() => Array.from(new Map(volumeCalculations.flatMap((calculation) => {
    if (calculation.availability.status === "available") return [];
    const reason = calculation.availability.reason || technicalAvailabilityLabel(calculation.availability.status);
    return [[`${calculation.availability.status}:${reason}`, { status: calculation.availability.status, reason }] as const];
  })).values()), [volumeCalculations]);
  const nonVolumeCalculations = useMemo(
    () => calculations.filter((calculation) => !isTechnicalVolumeIndicator(calculation.kind)),
    [calculations],
  );
  const priceLines = useMemo(() => priceLineEntries(calculations), [calculations]);
  const priceKeys = useMemo(() => new Set(priceLines.map((line) => line.key)), [priceLines]);
  const rows = useMemo(() => buildTechnicalChartRows(series, calculations), [calculations, series]);
  const displayRows = useMemo(
    () => displayTechnicalChartRows(rows, priceMode, priceKeys),
    [priceKeys, priceMode, rows],
  );
  const visibleRows = useMemo(() => {
    return displayRows.filter((row) => row.date >= visibleFromDate).map((row) => Object.assign({}, row, row.indicatorValues) as ChartDatum);
  }, [displayRows, visibleFromDate]);
  const markerPoints = useMemo(() => {
    if (!showTradeMarkers) return [];
    const barDates = visibleRows.map((row) => row.date);
    const rowsByDate = new Map(visibleRows.map((row) => [row.date, row]));
    const sideCounts = new Map<string, number>();
    return markers.flatMap((marker) => {
      const barDate = technicalMarkerBarDate(marker.date, barDates, interval);
      const row = barDate ? rowsByDate.get(barDate) : undefined;
      if (!barDate || !row) return [];
      const sideKey = `${barDate}:${marker.side}`;
      const sideOffset = sideCounts.get(sideKey) ?? 0;
      sideCounts.set(sideKey, sideOffset + 1);
      return [{ marker, row, barDate, sideOffset }];
    });
  }, [interval, markers, showTradeMarkers, visibleRows]);
  const visibleMarkers = markerPoints.map((point) => point.marker);
  const returnPercent = technicalSeriesReturn(series);
  const chartHeight = 270 + auxiliaryPanels.length * 160;
  const currency = priceMode === "starting100" ? "INDEX" : series.currency;

  const toggleOverride = (kind: TechnicalIndicatorKind) => {
    const base = overrideIndicators ?? globalIndicators;
    const next = base.includes(kind) ? base.filter((item) => item !== kind) : [...base, kind];
    onOverrideChange(series.symbol, next);
  };

  return (
    <Card className="min-w-0 overflow-hidden bg-card p-4 sm:p-5" data-technical-symbol={series.symbol}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <StockSwatch symbol={series.symbol} theme={theme} />
            <h3 className="truncate text-base font-black">{instrument.name}</h3>
            {holding ? <span className="rounded-full bg-primary px-2 py-1 text-[9px] font-black text-primary-foreground">PORTFOLIO</span> : historicalPortfolio ? <span className="rounded-full bg-secondary px-2 py-1 text-[9px] font-black">PAST</span> : null}
          </div>
          <p className="mt-1 text-[10px] font-bold text-muted-foreground">{series.symbol} · {series.market} · {series.currency} · {series.bars.length.toLocaleString("ko-KR")} bars</p>
          {holding ? <p className="mt-1 text-[9px] text-muted-foreground">현재 포트폴리오 비중 {portfolioWeight === undefined ? "unavailable" : formatPercent(portfolioWeight)}</p> : historicalPortfolio ? <p className="mt-1 text-[9px] text-muted-foreground">과거 포트폴리오 종목 · 현재 비중 {portfolioWeight === undefined ? "unavailable" : formatPercent(portfolioWeight)}</p> : null}
        </div>
        <div className="text-right">
          <p className="text-sm font-black">{returnPercent === undefined ? "unavailable" : formatPercent(returnPercent, true)}</p>
          <p className="text-[9px] text-muted-foreground">선택 기간 수익률</p>
        </div>
      </div>

      <details className="group mt-3 rounded-2xl bg-secondary p-3">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-[11px] font-black">
          <span className="flex items-center gap-2"><SlidersHorizontal className="size-3.5" />종목별 지표 {overrideIndicators ? "개별 설정" : "공통 설정"}</span>
          <ChevronDown className="size-3.5 transition-transform group-open:rotate-180" />
        </summary>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {TECHNICAL_BATCH_INDICATORS.map((option) => (
            <button
              key={option.kind}
              type="button"
              aria-pressed={selected.includes(option.kind)}
              aria-label={`${series.symbol} ${option.label} ${selected.includes(option.kind) ? "해제" : "선택"}`}
              data-technical-indicator={option.kind}
              onClick={() => toggleOverride(option.kind)}
              className={cn(
                "rounded-full px-2.5 py-1.5 text-[9px] font-black transition-colors",
                selected.includes(option.kind) ? "bg-primary text-primary-foreground" : "bg-card text-muted-foreground",
              )}
            >{option.shortLabel}</button>
          ))}
          {overrideIndicators ? (
            <button type="button" className="rounded-full bg-card px-2.5 py-1.5 text-[9px] font-black" onClick={() => onOverrideChange(series.symbol, undefined)}>공통 설정 사용</button>
          ) : null}
        </div>
      </details>

      {nonVolumeCalculations.length ? <div className="mt-3 flex flex-wrap gap-1.5">
        {nonVolumeCalculations.map((calculation) => (
          <span
            key={calculation.indicator_id}
            title={calculation.availability.reason}
            data-technical-availability={calculation.availability.status}
            className={cn("rounded-full px-2 py-1 text-[9px] font-black", availabilityBadgeClass(calculation.availability.status))}
          >{TECHNICAL_INDICATOR_BY_KIND.get(calculation.kind)?.shortLabel ?? calculation.kind} · {technicalAvailabilityLabel(calculation.availability.status)}</span>
        ))}
      </div> : null}

      {volumeCalculations.length ? (
        <div
          className="mt-3 rounded-2xl bg-secondary p-3"
          aria-label={`${series.symbol} 거래량 지표 availability`}
          data-technical-volume-availability
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[10px] font-black">거래량 지표 상태</p>
            <p className="text-[9px] text-muted-foreground">worker 응답 · 가격 차트와 독립</p>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {volumeCalculations.map((calculation) => {
              const status = calculation.availability.status;
              return (
                <span
                  key={calculation.indicator_id}
                  title={calculation.availability.reason}
                  data-technical-volume-indicator={calculation.kind}
                  data-technical-availability={status}
                  className={cn("rounded-full px-2 py-1 text-[9px] font-black", availabilityBadgeClass(status))}
                >
                  {TECHNICAL_INDICATOR_BY_KIND.get(calculation.kind)?.shortLabel ?? calculation.kind} · <code>{status}</code> · {technicalAvailabilityLabel(status)}
                </span>
              );
            })}
          </div>
          {volumeAvailabilityReasons.length ? (
            <div className="mt-2 space-y-1 text-[9px] leading-4 text-muted-foreground">
              {volumeAvailabilityReasons.map(({ status, reason }) => (
                <p key={`${status}:${reason}`} data-technical-volume-reason={status}><code>{status}</code>: {reason}</p>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {vwapCalculation?.metadata ? (
        <div className="mt-3 rounded-2xl bg-amber-500/10 p-3 text-[9px] leading-4 text-muted-foreground" data-technical-vwap-metadata>
          <p className="font-black text-foreground">VWAP·Anchored VWAP · {interval === "1d" ? "일봉" : "주봉"} 기반 근사치</p>
          <p>봉 HLC3×거래량을 사용하며 체결 단위 intraday VWAP이 아닙니다.</p>
          <p>anchor <code>{String(vwapCalculation.metadata.anchor ?? "period_start")}</code> · resolved <code>{String(vwapCalculation.metadata.resolved_anchor_date ?? "unavailable")}</code> · future data <code>{String(vwapCalculation.metadata.future_data_used ?? false)}</code></p>
        </div>
      ) : null}

      <div ref={ref} className="mt-3 min-w-0" style={{ minHeight: chartHeight }}>
        {!visible ? (
          <div className="grid rounded-[20px] bg-secondary text-center text-xs font-bold text-muted-foreground" style={{ height: chartHeight, placeItems: "center" }}>스크롤하면 차트를 렌더링합니다</div>
        ) : !visibleRows.length ? (
          <div className="grid rounded-[20px] bg-secondary text-center text-xs font-bold text-muted-foreground" style={{ height: chartHeight, placeItems: "center" }}>표시할 가격 시계열이 없습니다.</div>
        ) : (
          <div className="space-y-2" data-technical-chart>
            <div className="h-[270px] min-w-0 rounded-[20px] bg-secondary p-2" data-technical-price-chart aria-label={`${series.symbol} 가격 및 지표 오버레이 차트`}>
              <ResponsiveContainer width="100%" height="100%" minWidth={1} minHeight={1}>
                <ComposedChart data={visibleRows} syncId={CHART_SYNC_ID} syncMethod="value" margin={{ top: 12, right: 7, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke="hsl(var(--border))" vertical={false} strokeDasharray="3 5" />
                  <XAxis dataKey="date" tickFormatter={displayDate} tick={{ fontSize: 9 }} minTickGap={35} axisLine={false} tickLine={false} />
                  <YAxis width={52} orientation="right" tick={{ fontSize: 9 }} axisLine={false} tickLine={false} domain={["auto", "auto"]} />
                  <Tooltip
                    content={<PriceTooltip priceMode={priceMode} currency={currency} lines={priceLines} />}
                    cursor={{ stroke: "hsl(var(--foreground) / 0.5)", strokeWidth: 1 }}
                    wrapperStyle={{ zIndex: 30 }}
                  />
                  <Bar dataKey="candleRange" shape={<CandleShape />} isAnimationActive={false} />
                  {priceLines.map((line, index) => (
                    <Line
                      key={line.key}
                      dataKey={line.key}
                      name={line.label}
                      type="linear"
                      dot={false}
                      connectNulls={false}
                      stroke={INDICATOR_COLORS[index % INDICATOR_COLORS.length]}
                      strokeDasharray={MONOCHROME_DASHES[index % MONOCHROME_DASHES.length]}
                      strokeWidth={1.5}
                      isAnimationActive={false}
                    />
                  ))}
                  {markerPoints.map(({ marker, row, barDate, sideOffset }) => {
                    const offset = 0.008 + sideOffset * 0.007;
                    const y = marker.side === "buy" ? row.low * (1 - offset) : row.high * (1 + offset);
                    return (
                      <ReferenceDot
                        key={marker.id}
                        x={barDate}
                        y={y}
                        ifOverflow="extendDomain"
                        isFront
                        shape={<TradeMarkerShape marker={marker} />}
                      />
                    );
                  })}
                </ComposedChart>
              </ResponsiveContainer>
            </div>

            {auxiliaryPanels.map(({ calculation, option, fields, volumeOverlay }, panelIndex) => {
              const histogram = calculation.kind === "macd" ? fields.find((item) => item.field === "histogram") : undefined;
              return (
                <div
                  className="h-[152px] min-w-0 rounded-[20px] bg-secondary px-2 pt-2"
                  key={calculation.indicator_id}
                  data-technical-indicator-panel={calculation.kind}
                  data-technical-panel-placement={volumeOverlay ? "volume-overlay" : "indicator-panel"}
                  data-technical-availability={calculation.availability.status}
                  aria-label={`${series.symbol} ${option.label} 보조 지표 패널`}
                >
                  <div className="flex items-center justify-between px-2 text-[9px] font-black">
                    <span>{option.label}</span>
                    <span className="text-muted-foreground">{calculation.availability.status} · {technicalAvailabilityLabel(calculation.availability.status)}</span>
                  </div>
                  <div className="h-[126px]">
                    <ResponsiveContainer width="100%" height="100%" minWidth={1} minHeight={1}>
                      <ComposedChart data={visibleRows} syncId={CHART_SYNC_ID} syncMethod="value" margin={{ top: 4, right: 7, bottom: 0, left: 0 }}>
                        <CartesianGrid stroke="hsl(var(--border))" vertical={false} strokeDasharray="3 5" />
                        <XAxis dataKey="date" hide />
                        <YAxis width={46} orientation="right" tick={{ fontSize: 8 }} axisLine={false} tickLine={false} domain={["auto", "auto"]} />
                        <Tooltip content={<OscillatorTooltip />} cursor={{ stroke: "hsl(var(--foreground) / 0.5)" }} wrapperStyle={{ zIndex: 30 }} />
                        {option.referenceLines?.map((value) => <ReferenceLine key={value} y={value} stroke="hsl(var(--muted-foreground))" strokeDasharray="3 4" />)}
                        {volumeOverlay ? <Bar dataKey="volume" name="volume" fill="hsl(var(--muted-foreground) / 0.22)" isAnimationActive={false} /> : null}
                        {histogram ? <Bar dataKey={histogram.key} name="histogram" fill="hsl(var(--muted-foreground) / 0.45)" isAnimationActive={false} /> : null}
                        {fields.filter((item) => item !== histogram).map((item, index) => (
                          <Line
                            key={item.key}
                            dataKey={item.key}
                            name={item.field}
                            dot={false}
                            connectNulls={false}
                            stroke={INDICATOR_COLORS[(panelIndex + index) % INDICATOR_COLORS.length]}
                            strokeDasharray={MONOCHROME_DASHES[index % MONOCHROME_DASHES.length]}
                            strokeWidth={1.4}
                            isAnimationActive={false}
                          />
                        ))}
                      </ComposedChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {visibleMarkers.length ? (
        <details className="mt-3 rounded-2xl bg-secondary p-3">
          <summary className="cursor-pointer text-[10px] font-black">거래 marker 상세 · {visibleMarkers.length}건</summary>
          <div className="mt-3 space-y-2">
            {visibleMarkers.map((marker) => (
              <div key={`${marker.id}:detail`} className="rounded-xl bg-card p-3 text-[10px]">
                <div className="flex items-center justify-between gap-3">
                  <strong className={marker.side === "buy" ? "text-blue-600" : "text-rose-600"}>{marker.date} · {marker.side === "buy" ? "매수" : "매도"}</strong>
                  <span>{marker.order_count}개 주문 집계</span>
                </div>
                <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-muted-foreground">
                  <span>체결 수량</span><span className="text-right text-foreground">{formatQuantity(marker.filled_quantity)}</span>
                  <span>개별 체결 수</span><span className="text-right text-foreground">unavailable · 개별 체결 미저장</span>
                  <span>평균 체결가</span><span className="text-right text-foreground">{marker.average_filled_price === null ? "unavailable" : formatMoney(marker.average_filled_price, marker.currency)}</span>
                  <span>체결 금액</span><span className="text-right text-foreground">{marker.filled_amount === null ? "unavailable" : formatMoney(marker.filled_amount, marker.currency)}</span>
                  <span>KRW 환산 금액</span><span className="text-right text-foreground">{marker.filled_amount_krw.status === "estimated" ? `추정 ${formatMoney(marker.filled_amount_krw.value, "KRW")}` : `unavailable · ${marker.filled_amount_krw.reason}`}</span>
                  <span>거래 비중</span><span className="text-right text-foreground">{marker.trade_weight.status === "estimated" ? `추정 비중 ${formatPercent(marker.trade_weight.percent)}` : `unavailable · ${marker.trade_weight.reason}`}</span>
                  <span>종목 비중</span><span className="text-right text-foreground">{marker.position_weight.status === "estimated" ? `추정 ${formatPercent(marker.position_weight.before_percent)} → ${formatPercent(marker.position_weight.after_percent)}` : `unavailable · ${marker.position_weight.reason}`}</span>
                </div>
                <div className="mt-2 space-y-1 border-t border-border pt-2">
                  {marker.details.map((detail) => (
                    <p key={detail.order_id} className="text-muted-foreground">
                      주문 {detail.order_id} · {detail.filled_at || detail.ordered_at} · {formatQuantity(detail.filled_quantity)}주 · {detail.average_filled_price === null ? "평균가 unavailable" : formatMoney(detail.average_filled_price, marker.currency)} · {detail.filled_amount === null ? "금액 unavailable" : formatMoney(detail.filled_amount, marker.currency)} · 수수료 {detail.commission === null ? "unavailable" : formatMoney(detail.commission, marker.currency)} · 세금 {detail.tax === null ? "unavailable" : formatMoney(detail.tax, marker.currency)}
                    </p>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </details>
      ) : null}
    </Card>
  );
});

function FocusedVolumeProfile({
  instruments,
  settings,
  analysis,
  interval,
  loading,
  error,
  onSettingsChange,
  onRun,
}: {
  instruments: TechnicalInstrumentChoice[];
  settings: TechnicalVolumeProfileSettings;
  analysis?: TechnicalAnalysisPayload;
  interval: "1d" | "1w";
  loading: boolean;
  error: string;
  onSettingsChange: (settings: TechnicalVolumeProfileSettings) => void;
  onRun: () => void;
}) {
  const calculation = analysis ? volumeProfileCalculation(analysis) : undefined;
  const profile = calculation?.profile;
  const currency = analysis?.price_series[0]?.currency ?? "KRW";
  const maxVolume = profile?.buckets.reduce((maximum, bucket) => Math.max(maximum, bucket.volume), 0) ?? 0;
  const buckets = profile ? [...profile.buckets].reverse() : [];
  return (
    <Card className="min-w-0 overflow-hidden bg-secondary p-5 sm:p-6" data-technical-volume-profile>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-black tracking-[0.12em] text-muted-foreground">FOCUSED ANALYSIS · INDICATOR 31</p>
          <h3 className="mt-1 text-lg font-black">Volume Profile</h3>
          <p className="mt-1 max-w-2xl text-[10px] leading-4 text-muted-foreground">한 종목만 별도 Rust 요청으로 계산합니다. 각 {interval === "1d" ? "일봉" : "주봉"}의 전체 거래량을 선택 가격 bucket 하나에 배정하는 근사치이며 브라우저는 POC·VAH·VAL을 재계산하지 않습니다.</p>
        </div>
        <span className="rounded-full bg-card px-3 py-1.5 text-[9px] font-black" data-technical-indicator="volume_profile">focused only · max 200 buckets</span>
      </div>
      <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-5">
        <label className="rounded-[20px] bg-card p-4 xl:col-span-2"><span className="mb-2 block text-[10px] font-black text-muted-foreground">집중 종목</span><Select value={settings.symbol ?? ""} onValueChange={(symbol) => onSettingsChange({ ...settings, symbol })}><SelectTrigger className="w-full bg-secondary" aria-label="Volume Profile 집중 종목"><SelectValue placeholder="종목 선택" /></SelectTrigger><SelectContent>{instruments.map((instrument) => <SelectItem key={instrument.symbol} value={instrument.symbol}>{instrument.symbol} · {instrument.name}</SelectItem>)}</SelectContent></Select></label>
        <label className="rounded-[20px] bg-card p-4"><span className="mb-2 block text-[10px] font-black text-muted-foreground">Bucket 수</span><Input aria-label="Volume Profile bucket 수" type="number" min={5} max={200} value={settings.bucketCount} onChange={(event) => onSettingsChange({ ...settings, bucketCount: Math.min(200, Math.max(5, Number(event.target.value) || 5)) })} className="bg-secondary" /></label>
        <label className="rounded-[20px] bg-card p-4"><span className="mb-2 block text-[10px] font-black text-muted-foreground">가격 source</span><Select value={settings.priceSource} onValueChange={(priceSource) => onSettingsChange({ ...settings, priceSource: priceSource as TechnicalVolumeProfileSettings["priceSource"] })}><SelectTrigger className="w-full bg-secondary" aria-label="Volume Profile 가격 source"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="typical_price">HLC3</SelectItem><SelectItem value="close">종가</SelectItem></SelectContent></Select></label>
        <label className="rounded-[20px] bg-card p-4"><span className="mb-2 block text-[10px] font-black text-muted-foreground">Value Area %</span><Input aria-label="Volume Profile value area 비율" type="number" min={50} max={99} value={settings.valueAreaPercent} onChange={(event) => onSettingsChange({ ...settings, valueAreaPercent: Math.min(99, Math.max(50, Number(event.target.value) || 50)) })} className="bg-secondary" /></label>
      </div>
      <div className="mt-3 flex items-center justify-between gap-3">
        <p className="text-[9px] text-muted-foreground">POC 동률은 높은 가격, Value Area 인접 거래량 동률도 높은 가격 bucket을 우선합니다.</p>
        <Button onClick={onRun} disabled={loading || !settings.symbol} aria-label="Volume Profile 집중 분석 실행">{loading ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}집중 분석</Button>
      </div>
      {error ? <div role="alert" className="mt-3 rounded-[20px] bg-destructive/10 p-4 text-xs text-destructive">{error}</div> : null}
      {calculation && !profile ? (
        <div className="mt-4 rounded-[20px] bg-card p-5" data-technical-volume-profile-unavailable>
          <p className="font-black">{technicalAvailabilityLabel(calculation.availability.status)}</p>
          <p className="mt-1 text-xs text-muted-foreground"><code>{calculation.availability.status}</code> · {calculation.availability.reason}</p>
        </div>
      ) : profile ? (
        <div className="mt-4 grid min-w-0 gap-3 lg:grid-cols-[minmax(0,1fr)_18rem]" data-technical-volume-profile-result data-bucket-count={profile.buckets.length}>
          <div className="min-w-0 rounded-[20px] bg-card p-4">
            <div className="mb-3 flex flex-wrap gap-2 text-[9px] font-black">
              <span className="rounded-full bg-secondary px-2.5 py-1">requested {profile.requested_bucket_count}</span>
              <span className="rounded-full bg-secondary px-2.5 py-1">effective {profile.effective_bucket_count}</span>
              <span className="rounded-full bg-amber-500/15 px-2.5 py-1">{interval === "1d" ? "일봉" : "주봉"} 근사치</span>
            </div>
            <div className="max-h-[420px] space-y-1 overflow-y-auto overflow-x-hidden pr-1" role="img" aria-label={`${settings.symbol} 가격 구간별 거래량 profile`}>
              {buckets.map((bucket) => (
                <div key={bucket.index} className="grid min-w-0 grid-cols-[5.5rem_minmax(0,1fr)_4.5rem] items-center gap-2 text-[9px]" data-volume-profile-bucket={bucket.index} data-in-value-area={bucket.in_value_area ? "true" : "false"} data-point-of-control={bucket.is_point_of_control ? "true" : "false"}>
                  <span className="truncate text-right text-muted-foreground">{formatMoney(bucket.price_mid, currency)}</span>
                  <div className="h-4 min-w-0 overflow-hidden rounded-full bg-secondary"><div className={cn("h-full rounded-full", bucket.is_point_of_control ? "bg-rose-500" : bucket.in_value_area ? "bg-blue-500" : "bg-muted-foreground/35")} style={{ width: `${maxVolume > 0 ? Math.max(1, bucket.volume / maxVolume * 100) : 0}%` }} /></div>
                  <span className="truncate text-right font-black">{bucket.volume_percent.toFixed(2)}%</span>
                </div>
              ))}
            </div>
          </div>
          <div className="rounded-[20px] bg-card p-4">
            <p className="text-[10px] font-black text-muted-foreground">WORKER LEVELS</p>
            <dl className="mt-3 space-y-3 text-xs">
              <div><dt className="text-muted-foreground">Point of Control</dt><dd className="mt-1 text-base font-black" data-volume-profile-poc>{formatMoney(profile.point_of_control, currency)}</dd></div>
              <div><dt className="text-muted-foreground">Value Area High</dt><dd className="mt-1 font-black" data-volume-profile-vah>{formatMoney(profile.value_area_high, currency)}</dd></div>
              <div><dt className="text-muted-foreground">Value Area Low</dt><dd className="mt-1 font-black" data-volume-profile-val>{formatMoney(profile.value_area_low, currency)}</dd></div>
              <div><dt className="text-muted-foreground">총 거래량</dt><dd className="mt-1 font-black">{profile.total_volume.toLocaleString("ko-KR")}</dd></div>
              <div><dt className="text-muted-foreground">관측 / 결측</dt><dd className="mt-1 font-black">{profile.included_observations} / {profile.missing_volume_observations}</dd></div>
              <div><dt className="text-muted-foreground">범위</dt><dd className="mt-1 font-black">{profile.from_date} ~ {profile.to_date}</dd></div>
            </dl>
            <p className="mt-4 break-words text-[9px] leading-4 text-muted-foreground"><code>{profile.approximation}</code></p>
          </div>
        </div>
      ) : loading ? <div className="mt-4 grid min-h-40 place-items-center rounded-[20px] bg-card text-xs font-black"><LoaderCircle className="animate-spin" /></div> : <div className="mt-4 rounded-[20px] bg-card p-5 text-xs text-muted-foreground">설정을 선택하고 집중 분석을 실행하세요.</div>}
    </Card>
  );
}

function TechnicalStrategyWorkspace({
  accountId,
  analysis,
  portfolioWeights,
  onUnauthorized,
  onOpenBacktest,
}: {
  accountId: string;
  analysis: TechnicalStrategyAnalysis;
  portfolioWeights?: Map<string, number>;
  onUnauthorized: () => void;
  onOpenBacktest: (handoff: TechnicalStrategyHandoff) => void;
}) {
  const incomingFingerprint = useMemo(() => JSON.stringify(analysis), [analysis]);
  const initialAnalysis = useMemo(() => (
    defaultTechnicalStrategyAnalysisSubset(analysis) ?? analysis
  ), []); // The workspace intentionally snapshots the chart source until the user refreshes it.
  const initialWeights = useMemo(() => Object.fromEntries(initialAnalysis.symbols.map((symbol) => [symbol, portfolioWeights?.get(symbol)])), []);
  const [source, setSource] = useState<TechnicalStrategyAnalysis>(initialAnalysis);
  const [strategy, setStrategy] = useState<TechnicalStrategy>(() => createDefaultTechnicalStrategy(initialAnalysis, initialWeights));
  const [selectedSymbols, setSelectedSymbols] = useState<string[]>(initialAnalysis.symbols.slice(0, MAX_TECHNICAL_STRATEGY_SYMBOLS));
  const [sourceFingerprint, setSourceFingerprint] = useState(incomingFingerprint);
  const [sourceOrigin, setSourceOrigin] = useState<"chart" | "preset">("chart");
  const [strategyPresets, setStrategyPresets] = useState<PresetLibraryItem[]>([]);
  const [selectedPresetId, setSelectedPresetId] = useState("");
  const [presetName, setPresetName] = useState("");
  const [presetBusy, setPresetBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const errors = useMemo(() => validateTechnicalStrategyDraft(source, strategy), [source, strategy]);
  const chartSourceStale = sourceOrigin === "chart" && sourceFingerprint !== incomingFingerprint;
  const availableSymbolFingerprint = analysis.symbols.join("\u0000");

  useEffect(() => {
    setSelectedSymbols((current) => {
      const next = reconcileTechnicalStrategySelection(current, analysis.symbols);
      return next.length === current.length && next.every((symbol, index) => symbol === current[index]) ? current : next;
    });
  }, [availableSymbolFingerprint]);

  const loadStrategyPresets = useCallback(async () => {
    try {
      const page = await listLibraryPresets({ onUnauthorized });
      setStrategyPresets(page.items.filter((item) => normalizeTechnicalStrategyPresetConfig(item.config) !== undefined));
    } catch {
      setNotice("기술 신호 전략 프리셋 목록을 불러오지 못했습니다.");
    }
  }, [onUnauthorized]);

  useEffect(() => {
    void loadStrategyPresets();
  }, [loadStrategyPresets]);

  const applyChartSource = () => {
    const issue = technicalStrategySubsetIssue(analysis, selectedSymbols);
    if (issue) {
      setNotice(issue);
      return;
    }
    const next = subsetTechnicalStrategyAnalysis(analysis, selectedSymbols);
    if (!next) {
      setNotice(`1~${MAX_TECHNICAL_STRATEGY_SYMBOLS}개 종목과 한 개 이상의 시계열 지표를 선택해 주세요.`);
      return;
    }
    const weights = Object.fromEntries(next.symbols.map((symbol) => [symbol, portfolioWeights?.get(symbol)]));
    setSource(next);
    setStrategy(createDefaultTechnicalStrategy(next, weights));
    setSourceFingerprint(incomingFingerprint);
    setSourceOrigin("chart");
    setSelectedPresetId("");
    setNotice("현재 차트 종목·지표를 전략 원본으로 적용하고 조건을 초기화했습니다.");
  };

  const toggleSymbol = (symbol: string) => {
    setSelectedSymbols((current) => {
      if (current.includes(symbol)) return current.filter((item) => item !== symbol);
      if (current.length >= MAX_TECHNICAL_STRATEGY_SYMBOLS) return current;
      return [...current, symbol];
    });
  };

  const saveStrategyPreset = async () => {
    if (!presetName.trim() || errors.length) return;
    setPresetBusy(true);
    setNotice("");
    try {
      await createLibraryPreset({
        name: presetName.trim(),
        description: "기술 지표 조건·상태 배분 신호 전략",
        tags: ["technical-analysis", TECHNICAL_STRATEGY_PRESET_TYPE],
        symbols: source.symbols,
        source: TECHNICAL_PRESET_SOURCE,
        config: { schemaVersion: 1, presetType: TECHNICAL_STRATEGY_PRESET_TYPE, analysis: source, strategy },
      }, { onUnauthorized });
      setPresetName("");
      setNotice("기술 신호 전략 프리셋을 저장했습니다.");
      await loadStrategyPresets();
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : "기술 신호 전략 프리셋을 저장하지 못했습니다.");
    } finally {
      setPresetBusy(false);
    }
  };

  const restoreStrategyPreset = async (id: string) => {
    setSelectedPresetId(id);
    setPresetBusy(true);
    setNotice("");
    try {
      const details = await getLibraryPreset(id, false, { onUnauthorized });
      const config = normalizeTechnicalStrategyPresetConfig(details.preset?.config);
      if (!config) throw new Error("기술 신호 전략 프리셋 형식이 아닙니다.");
      setSource(config.analysis);
      setStrategy(config.strategy);
      setSelectedSymbols(reconcileTechnicalStrategySelection(config.analysis.symbols, analysis.symbols));
      setSourceOrigin("preset");
      setSourceFingerprint(technicalStrategyFingerprint(config.analysis, config.strategy));
      setNotice("기술 신호 전략 프리셋을 복원했습니다.");
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : "기술 신호 전략 프리셋을 복원하지 못했습니다.");
    } finally {
      setPresetBusy(false);
    }
  };

  return (
    <Card className="min-w-0 bg-secondary p-5 sm:p-6" data-technical-strategy-workspace>
      <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div className="max-w-3xl"><p className="text-[10px] font-black tracking-[0.12em] text-muted-foreground">TECHNICAL SIGNAL STRATEGY</p><h3 className="mt-1 text-xl font-black">차트 구성을 신호 백테스트로 연결</h3><p className="mt-2 text-xs leading-5 text-muted-foreground">최대 20개 전략 종목을 명시적으로 선택합니다. 선택한 지표 정의와 parameter를 그대로 전달하며 브라우저는 신호나 목표비중 일정을 만들지 않습니다.</p></div>
        <Button type="button" onClick={() => onOpenBacktest({ accountId, analysis: source, strategy })} disabled={Boolean(errors.length) || chartSourceStale}><Play />기술 신호 백테스트로 전달</Button>
      </div>

      <div className="mt-4 rounded-[20px] bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-2"><div><p className="text-[10px] font-black">전략 종목 선택</p><p className="mt-1 text-[9px] text-muted-foreground">{analysis.symbols.length}개 차트 중 {selectedSymbols.length}/{MAX_TECHNICAL_STRATEGY_SYMBOLS}개 선택</p></div><Button type="button" size="sm" variant="secondary" onClick={applyChartSource} disabled={!selectedSymbols.length}>선택 종목·현재 지표 적용</Button></div>
        <div className="mt-3 flex flex-wrap gap-2" aria-label="기술 신호 전략 종목">
          {analysis.symbols.map((symbol) => <button key={symbol} type="button" aria-pressed={selectedSymbols.includes(symbol)} onClick={() => toggleSymbol(symbol)} className={cn("rounded-full px-3 py-2 text-[10px] font-black", selectedSymbols.includes(symbol) ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground")}>{symbol}</button>)}
        </div>
        {analysis.symbols.length > MAX_TECHNICAL_STRATEGY_SYMBOLS ? <p className="mt-3 text-[10px] font-bold text-amber-700 dark:text-amber-300">차트는 {analysis.symbols.length}개를 유지합니다. ledger 한도 때문에 전략에는 표시된 {MAX_TECHNICAL_STRATEGY_SYMBOLS}개만 선택되며, 다른 종목을 포함하려면 먼저 하나를 해제하세요.</p> : null}
        {chartSourceStale ? <p role="status" className="mt-3 rounded-[14px] bg-amber-500/10 px-3 py-2 text-[10px] font-bold text-amber-700 dark:text-amber-300">차트 종목·기간·지표가 변경되었습니다. 현재 선택을 다시 적용해야 전달할 수 있습니다.</p> : null}
        {sourceOrigin === "preset" ? <p className="mt-3 text-[10px] text-muted-foreground">현재 편집 원본은 복원한 프리셋입니다. 차트 설정으로 바꾸려면 위 적용 버튼을 누르세요.</p> : null}
      </div>

      <div className="mt-4">
        <TechnicalStrategyBuilder analysis={source} value={strategy} onChange={setStrategy} />
      </div>

      <div className="mt-4 grid min-w-0 gap-2 md:grid-cols-[minmax(0,1fr)_auto_minmax(220px,0.8fr)]">
        <Input aria-label="새 기술 신호 전략 프리셋 이름" value={presetName} onChange={(event) => setPresetName(event.target.value)} maxLength={120} placeholder="기술 신호 전략 프리셋 이름" className="bg-card" />
        <Button type="button" variant="secondary" onClick={() => void saveStrategyPreset()} disabled={presetBusy || !presetName.trim() || Boolean(errors.length)}><Save />전략 저장</Button>
        <Select value={selectedPresetId} onValueChange={(id) => void restoreStrategyPreset(id)} disabled={presetBusy || !strategyPresets.length}><SelectTrigger className="w-full bg-card" aria-label="기술 신호 전략 프리셋 복원"><SelectValue placeholder="저장된 전략 복원" /></SelectTrigger><SelectContent>{strategyPresets.map((preset) => <SelectItem key={preset.id} value={preset.id}>{preset.name}</SelectItem>)}</SelectContent></Select>
      </div>
      {notice ? <p role="status" className="mt-3 text-[10px] leading-4 text-muted-foreground">{notice}</p> : null}
    </Card>
  );
}

export function TechnicalAnalysisView({
  portfolio,
  theme,
  onUnauthorized,
  onOpenTechnicalBacktest,
}: {
  portfolio: Portfolio;
  theme: Theme;
  onUnauthorized: () => void;
  onOpenTechnicalBacktest?: (handoff: TechnicalStrategyHandoff) => void;
}) {
  const today = useMemo(() => seoulDateString(), []);
  const [customWatchlist, setCustomWatchlist] = useState<TechnicalInstrumentChoice[]>([]);
  const [historicalInstruments, setHistoricalInstruments] = useState<TechnicalInstrumentChoice[]>([]);
  const [excludedHistoricalSymbols, setExcludedHistoricalSymbols] = useState<Set<string>>(() => new Set());
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<TechnicalInstrumentChoice[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [interval, setInterval] = useState<"1d" | "1w">("1d");
  const [fromDate, setFromDate] = useState(() => dateYearsAgo(today, 1));
  const [toDate, setToDate] = useState(today);
  const [columns, setColumns] = useState<1 | 2 | 3 | 4>(2);
  const [priceMode, setPriceMode] = useState<PriceMode>("actual");
  const [currencyMode, setCurrencyMode] = useState<CurrencyMode>("local");
  const [sortMode, setSortMode] = useState<SortMode>("weight");
  const [globalIndicators, setGlobalIndicators] = useState<TechnicalIndicatorKind[]>(["sma", "rsi"]);
  const [indicatorOverrides, setIndicatorOverrides] = useState<Record<string, TechnicalIndicatorKind[] | undefined>>({});
  const [vwapSettings, setVwapSettings] = useState<TechnicalVwapSettings>({
    anchor: "period_start",
    lookbackPeriod: 20,
    mode: "both",
  });
  const [volumeProfileSettings, setVolumeProfileSettings] = useState<TechnicalVolumeProfileSettings>({
    bucketCount: 24,
    priceSource: "typical_price",
    valueAreaPercent: 70,
  });
  const [benchmarkSymbol, setBenchmarkSymbol] = useState("");
  const [showTradeMarkers, setShowTradeMarkers] = useState(true);
  const [visiblePercent, setVisiblePercent] = useState(100);
  const [analysis, setAnalysis] = useState<TechnicalAnalysisPayload>();
  const [tradeMarkers, setTradeMarkers] = useState<TechnicalTradeMarker[]>([]);
  const [loading, setLoading] = useState(false);
  const [analysisError, setAnalysisError] = useState("");
  const [profileAnalysis, setProfileAnalysis] = useState<TechnicalAnalysisPayload>();
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileError, setProfileError] = useState("");
  const [markerNotice, setMarkerNotice] = useState("");
  const [lastRequestSignature, setLastRequestSignature] = useState("");
  const [portfolioWeights, setPortfolioWeights] = useState<Map<string, number>>();
  const [weightDataLoaded, setWeightDataLoaded] = useState(false);
  const [presets, setPresets] = useState<PresetLibraryItem[]>([]);
  const [selectedPresetId, setSelectedPresetId] = useState("");
  const [presetName, setPresetName] = useState("");
  const [presetBusy, setPresetBusy] = useState(false);
  const [presetNotice, setPresetNotice] = useState("");
  const analysisController = useRef<AbortController | undefined>(undefined);
  const profileController = useRef<AbortController | undefined>(undefined);
  const initialRunStarted = useRef(false);

  const currentPortfolioInstruments = useMemo(() => portfolio.holdings.map(toInstrument), [portfolio.holdings]);
  const pastPortfolioInstruments = useMemo(() => {
    const current = new Set(currentPortfolioInstruments.map((item) => item.symbol));
    return historicalInstruments.filter((item) => !current.has(item.symbol));
  }, [currentPortfolioInstruments, historicalInstruments]);
  const portfolioInstruments = useMemo(() => [
    ...currentPortfolioInstruments,
    ...pastPortfolioInstruments.filter((item) => !excludedHistoricalSymbols.has(item.symbol)),
  ], [currentPortfolioInstruments, excludedHistoricalSymbols, pastPortfolioInstruments]);
  const allInstruments = useMemo(() => {
    const result = [...portfolioInstruments];
    const symbols = new Set(result.map((item) => item.symbol));
    for (const item of customWatchlist) {
      if (!symbols.has(item.symbol)) {
        result.push(item);
        symbols.add(item.symbol);
      }
    }
    return result.slice(0, 50);
  }, [customWatchlist, portfolioInstruments]);
  const symbols = useMemo(() => allInstruments.map((item) => item.symbol), [allInstruments]);
  const instrumentBySymbol = useMemo(() => new Map(allInstruments.map((item) => [item.symbol, item])), [allInstruments]);
  const holdingBySymbol = useMemo(() => new Map(portfolio.holdings.map((holding) => [holding.symbol.toUpperCase(), holding])), [portfolio.holdings]);
  const effectiveBenchmark = symbols.includes(benchmarkSymbol) ? benchmarkSymbol : symbols[0] ?? "";
  const vwapParameters = useMemo(() => ({
    anchor: vwapSettings.anchor,
    lookback_period: vwapSettings.lookbackPeriod,
    mode: vwapSettings.mode,
    ...(vwapSettings.anchor === "user_date" || vwapSettings.anchor === "signal_date"
      ? { anchor_date: vwapSettings.anchorDate || fromDate }
      : {}),
  }), [fromDate, vwapSettings]);
  const indicatorDefinitions = useMemo(
    () => buildTechnicalIndicatorDefinitions(
      symbols,
      globalIndicators,
      indicatorOverrides,
      effectiveBenchmark,
      { vwap_anchored_vwap: vwapParameters },
    ),
    [effectiveBenchmark, globalIndicators, indicatorOverrides, symbols, vwapParameters],
  );
  const technicalStrategyAnalysis = useMemo<TechnicalStrategyAnalysis>(() => ({
    symbols,
    fromDate,
    toDate,
    interval,
    adjusted: true,
    currencyMode,
    responseMode: "full_series",
    indicators: indicatorDefinitions,
  }), [currencyMode, fromDate, indicatorDefinitions, interval, symbols, toDate]);
  const requestSignature = useMemo(() => JSON.stringify({ symbols, fromDate, toDate, interval, currencyMode, indicatorDefinitions }), [currencyMode, fromDate, indicatorDefinitions, interval, symbols, toDate]);
  const visibleFromDate = useMemo(() => visibleDateCutoff(fromDate, toDate, visiblePercent), [fromDate, toDate, visiblePercent]);
  const dateRangeValid = isValidCalendarRange({ from: fromDate, to: toDate }, today);
  const isStale = Boolean(analysis && lastRequestSignature !== requestSignature);
  const activeIndicatorPreset = useMemo(() => (
    Object.keys(indicatorOverrides).length ? "custom" : identifyTechnicalIndicatorPreset(globalIndicators)
  ), [globalIndicators, indicatorOverrides]);

  useEffect(() => {
    if (!symbols.includes(benchmarkSymbol)) setBenchmarkSymbol(symbols[0] ?? "");
  }, [benchmarkSymbol, symbols]);

  useEffect(() => {
    if (!symbols.length) {
      setVolumeProfileSettings((current) => current.symbol ? { ...current, symbol: undefined } : current);
      return;
    }
    if (!volumeProfileSettings.symbol || !symbols.includes(volumeProfileSettings.symbol)) {
      setVolumeProfileSettings((current) => ({ ...current, symbol: symbols[0] }));
    }
  }, [symbols, volumeProfileSettings.symbol]);

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ account: portfolio.selectedAccountId, currency: "ALL", range: "all" });
    setWeightDataLoaded(false);
    fetch(`/api/portfolio/history?${params.toString()}`, { headers: { Accept: "application/json" }, signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({}));
        if (response.status === 401) {
          onUnauthorized();
          return;
        }
        if (!response.ok) throw new Error();
        setPortfolioWeights(combinedPortfolioWeightMap(payload));
        setHistoricalInstruments(technicalInstrumentsFromPortfolioHistory(payload));
      })
      .catch((caught: unknown) => {
        if (!(caught instanceof DOMException && caught.name === "AbortError")) {
          setPortfolioWeights(undefined);
          setHistoricalInstruments([]);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setWeightDataLoaded(true);
      });
    return () => controller.abort();
  }, [onUnauthorized, portfolio.selectedAccountId]);

  useEffect(() => {
    const query = searchQuery.trim();
    if (!query) {
      setSearchResults([]);
      setSearchError("");
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setSearching(true);
      setSearchError("");
      searchTechnicalInstruments(query, { signal: controller.signal })
        .then((results) => {
          setSearchResults(results);
        })
        .catch((caught: unknown) => {
          if (caught instanceof DOMException && caught.name === "AbortError") return;
          if (caught instanceof TechnicalAnalysisApiError && caught.status === 401) {
            onUnauthorized();
            return;
          }
          setSearchError(caught instanceof Error ? caught.message : "종목을 검색하지 못했습니다.");
        })
        .finally(() => {
          if (!controller.signal.aborted) setSearching(false);
        });
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [onUnauthorized, searchQuery]);

  const loadPresets = useCallback(async () => {
    try {
      const page = await listLibraryPresets({ onUnauthorized });
      setPresets(page.items.filter((item) => normalizeTechnicalPresetConfig(item.config) !== undefined));
    } catch {
      setPresetNotice("기술적 분석 프리셋 목록을 불러오지 못했습니다.");
    }
  }, [onUnauthorized]);

  useEffect(() => {
    void loadPresets();
  }, [loadPresets]);

  useEffect(() => () => {
    analysisController.current?.abort();
    profileController.current?.abort();
  }, []);

  const addCustomInstrument = useCallback((instrument: TechnicalInstrumentChoice) => {
    setCustomWatchlist((current) => {
      if (portfolioInstruments.some((item) => item.symbol === instrument.symbol) || current.some((item) => item.symbol === instrument.symbol)) return current;
      if (portfolioInstruments.length + current.length >= 50) return current;
      return [...current, instrument];
    });
    setSearchQuery("");
    setSearchResults([]);
  }, [portfolioInstruments]);

  const removeCustomInstrument = useCallback((symbol: string) => {
    setCustomWatchlist((current) => current.filter((item) => item.symbol !== symbol));
    setIndicatorOverrides((current) => {
      const next = { ...current };
      delete next[symbol];
      return next;
    });
  }, []);

  const updateOverride = useCallback((symbol: string, kinds: TechnicalIndicatorKind[] | undefined) => {
    setIndicatorOverrides((current) => {
      const next = { ...current };
      if (kinds === undefined) delete next[symbol];
      else next[symbol] = kinds;
      return next;
    });
  }, []);

  const toggleGlobalIndicator = (kind: TechnicalIndicatorKind) => {
    setGlobalIndicators((current) => current.includes(kind) ? current.filter((item) => item !== kind) : [...current, kind]);
  };

  const applyIndicatorPreset = (key: (typeof TECHNICAL_INDICATOR_PRESETS)[number]["key"]) => {
    const preset = TECHNICAL_INDICATOR_PRESETS.find((item) => item.key === key);
    if (!preset) return;
    setGlobalIndicators([...preset.kinds]);
    setIndicatorOverrides({});
  };

  const analyze = useCallback(async () => {
    if (!symbols.length || !indicatorDefinitions.length || !dateRangeValid) return;
    analysisController.current?.abort();
    const controller = new AbortController();
    analysisController.current = controller;
    setLoading(true);
    setAnalysisError("");
    setMarkerNotice("");
    const request: TechnicalAnalysisRequest = {
      symbols,
      fromDate,
      toDate,
      interval,
      adjusted: true,
      currencyMode,
      responseMode: "full_series",
      indicators: indicatorDefinitions,
    };
    try {
      const [payload, markerResult] = await Promise.all([
        requestTechnicalAnalysis(request, {
          signal: controller.signal,
          failureMessage: "기술적 분석을 실행하지 못했습니다.",
          invalidResponseMessage: "기술적 분석 응답 형식을 확인하지 못했습니다.",
        }),
        requestTechnicalTradeMarkers({
          accountId: portfolio.selectedAccountId,
          fromDate,
          toDate,
          symbols,
        }, { signal: controller.signal })
          .then((markers) => ({ markers }))
          .catch((error: unknown) => ({ error })),
      ]);
      setAnalysis(payload);
      setLastRequestSignature(requestSignature);
      if ("markers" in markerResult) {
        setTradeMarkers(markerResult.markers.markers);
        setMarkerNotice(technicalTradeMarkerStatusNotice(markerResult.markers));
      } else {
        if (markerResult.error instanceof TechnicalAnalysisApiError && markerResult.error.status === 401) onUnauthorized();
        setTradeMarkers([]);
        setMarkerNotice(markerResult.error instanceof Error
          ? markerResult.error.message
          : "거래 marker를 불러오지 못했습니다. 가격 차트와 지표는 정상 표시됩니다.");
      }
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      if (caught instanceof TechnicalAnalysisApiError && caught.status === 401) {
        onUnauthorized();
        return;
      }
      setAnalysisError(caught instanceof Error ? caught.message : "기술적 분석을 실행하지 못했습니다.");
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [currencyMode, dateRangeValid, fromDate, indicatorDefinitions, interval, onUnauthorized, portfolio.selectedAccountId, requestSignature, symbols, toDate]);

  const analyzeVolumeProfile = useCallback(async () => {
    const symbol = volumeProfileSettings.symbol;
    if (!symbol || !dateRangeValid) return;
    profileController.current?.abort();
    const controller = new AbortController();
    profileController.current = controller;
    setProfileLoading(true);
    setProfileError("");
    try {
      const request = buildVolumeProfileRequest({
        symbol,
        fromDate,
        toDate,
        interval,
        currencyMode,
        settings: volumeProfileSettings,
      });
      const payload = await requestTechnicalAnalysis(request, {
        signal: controller.signal,
        failureMessage: "Volume Profile을 계산하지 못했습니다.",
        invalidResponseMessage: "Volume Profile 응답 형식을 확인하지 못했습니다.",
      });
      const calculation = volumeProfileCalculation(payload);
      if (!calculation) throw new Error("Volume Profile 응답 형식을 확인하지 못했습니다.");
      if (calculation.profile && calculation.profile.buckets.length > 200) throw new Error("Volume Profile bucket 응답 상한을 초과했습니다.");
      setProfileAnalysis(payload);
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      if (caught instanceof TechnicalAnalysisApiError && caught.status === 401) {
        onUnauthorized();
        return;
      }
      setProfileError(caught instanceof Error ? caught.message : "Volume Profile을 계산하지 못했습니다.");
    } finally {
      if (!controller.signal.aborted) setProfileLoading(false);
    }
  }, [currencyMode, dateRangeValid, fromDate, interval, onUnauthorized, toDate, volumeProfileSettings]);

  useEffect(() => {
    if (initialRunStarted.current || !weightDataLoaded || !symbols.length || !indicatorDefinitions.length) return;
    initialRunStarted.current = true;
    void analyze();
  }, [analyze, indicatorDefinitions.length, symbols.length, weightDataLoaded]);

  const savePreset = async (presetType: "technical_watchlist" | "technical_chart_config") => {
    if (!presetName.trim()) return;
    setPresetBusy(true);
    setPresetNotice("");
    const config = {
      schemaVersion: 1,
      presetType,
      watchlist: customWatchlist,
      ...(presetType === "technical_chart_config" ? {
        interval,
        fromDate,
        toDate,
        columns,
        priceMode,
        currencyMode,
        sortMode,
        globalIndicators,
        indicatorOverrides: Object.fromEntries(Object.entries(indicatorOverrides).filter((entry): entry is [string, TechnicalIndicatorKind[]] => Array.isArray(entry[1]))),
        benchmarkSymbol: effectiveBenchmark,
        showTradeMarkers,
        vwapSettings,
        volumeProfileSettings,
      } : {}),
    };
    try {
      await createLibraryPreset({
        name: presetName.trim(),
        description: presetType === "technical_watchlist" ? "기술적 분석 사용자 지정 종목 목록" : "기술적 분석 지표·차트 구성",
        tags: ["technical-analysis", presetType],
        symbols: presetType === "technical_watchlist" ? customWatchlist.map((item) => item.symbol) : symbols,
        source: TECHNICAL_PRESET_SOURCE,
        config,
      }, { onUnauthorized });
      setPresetNotice(presetType === "technical_watchlist" ? "사용자 지정 종목 목록을 저장했습니다." : "지표·차트 구성을 저장했습니다.");
      setPresetName("");
      await loadPresets();
    } catch (caught) {
      setPresetNotice(caught instanceof Error ? caught.message : "프리셋을 저장하지 못했습니다.");
    } finally {
      setPresetBusy(false);
    }
  };

  const restorePreset = async (id: string) => {
    setSelectedPresetId(id);
    setPresetBusy(true);
    setPresetNotice("");
    try {
      const details = await getLibraryPreset(id, false, { onUnauthorized });
      const config = normalizeTechnicalPresetConfig(details.preset?.config);
      if (!config) throw new Error("기술적 분석 프리셋 형식이 아닙니다.");
      const portfolioSymbols = new Set(portfolioInstruments.map((item) => item.symbol));
      setCustomWatchlist(config.watchlist
        .filter((item) => !portfolioSymbols.has(item.symbol))
        .slice(0, Math.max(0, 50 - portfolioInstruments.length)));
      if (config.presetType === "technical_chart_config") {
        if (config.interval) setInterval(config.interval);
        if (config.fromDate) setFromDate(config.fromDate);
        if (config.toDate) setToDate(config.toDate);
        if (config.columns) setColumns(config.columns);
        if (config.priceMode) setPriceMode(config.priceMode);
        if (config.currencyMode) setCurrencyMode(config.currencyMode);
        if (config.sortMode) setSortMode(config.sortMode);
        if (config.globalIndicators) setGlobalIndicators(config.globalIndicators);
        setIndicatorOverrides(config.indicatorOverrides ?? {});
        if (config.benchmarkSymbol) setBenchmarkSymbol(config.benchmarkSymbol);
        if (config.showTradeMarkers !== undefined) setShowTradeMarkers(config.showTradeMarkers);
        if (config.vwapSettings) setVwapSettings(config.vwapSettings);
        if (config.volumeProfileSettings) setVolumeProfileSettings(config.volumeProfileSettings);
      }
      setPresetNotice("프리셋을 복원했습니다. 분석 실행을 눌러 새 설정을 계산하세요.");
    } catch (caught) {
      setPresetNotice(caught instanceof Error ? caught.message : "프리셋을 복원하지 못했습니다.");
    } finally {
      setPresetBusy(false);
    }
  };

  const sortedSeries = useMemo(() => {
    if (!analysis) return [];
    const originalOrder = new Map(symbols.map((symbol, index) => [symbol, index]));
    const value = (series: TechnicalPriceSeries): number | undefined => {
      if (sortMode === "weight") return portfolioWeights?.get(series.symbol);
      if (sortMode === "return") return technicalSeriesReturn(series);
      return latestTechnicalIndicatorValue(calculationsForInstrument(analysis, series.key));
    };
    return [...analysis.price_series].sort((left, right) => {
      const leftValue = value(left);
      const rightValue = value(right);
      if (leftValue === undefined && rightValue === undefined) return (originalOrder.get(left.symbol) ?? 999) - (originalOrder.get(right.symbol) ?? 999);
      if (leftValue === undefined) return 1;
      if (rightValue === undefined) return -1;
      return rightValue - leftValue || left.symbol.localeCompare(right.symbol);
    });
  }, [analysis, portfolioWeights, sortMode, symbols]);

  const selectPeriod = (months: 3 | 6 | 12 | 36) => {
    setFromDate(months === 12 ? dateYearsAgo(today, 1) : months === 36 ? dateYearsAgo(today, 3) : dateMonthsAgo(today, months));
    setToDate(today);
  };

  return (
    <section className="space-y-3" aria-label="기술적 분석" data-technical-analysis>
      <Card className="overflow-hidden bg-primary p-5 text-primary-foreground sm:p-7">
        <div className="flex flex-col gap-6 xl:flex-row xl:items-end xl:justify-between">
          <div className="max-w-3xl">
            <p className="text-[10px] font-black tracking-[0.16em] text-primary-foreground/55">RUST INDICATOR ENGINE · READ ONLY</p>
            <h2 className="mt-2 text-2xl font-black tracking-[-0.05em] sm:text-3xl">모든 종목을 한 번에 비교하세요.</h2>
            <p className="mt-3 text-xs leading-5 text-primary-foreground/65">선택한 전체 종목과 지표는 하나의 batch 요청으로 Rust worker에서 계산됩니다. 브라우저는 worker 시계열을 표시만 하며 주문을 실행하지 않습니다.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-white/10 px-3 py-2 text-[10px] font-black">{symbols.length} 종목</span>
            <span className="rounded-full bg-white/10 px-3 py-2 text-[10px] font-black">{indicatorDefinitions.length} 지표 정의</span>
            <Button variant="inverse" onClick={() => void analyze()} disabled={loading || !symbols.length || !indicatorDefinitions.length || !dateRangeValid}>
              {loading ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}{loading ? "계산 중" : "분석 실행"}
            </Button>
          </div>
        </div>
      </Card>

      <div className="grid gap-3 xl:grid-cols-[minmax(0,1.2fr)_minmax(340px,0.8fr)]">
        <Card className="min-w-0 bg-secondary p-5 sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div><p className="text-[10px] font-black tracking-[0.12em] text-muted-foreground">INSTRUMENTS</p><h3 className="mt-1 text-lg font-black">포트폴리오 + 사용자 지정</h3></div>
            <span className="rounded-full bg-card px-3 py-1.5 text-[10px] font-black">최대 50개</span>
          </div>
          <div className="relative mt-4">
            <Search className="pointer-events-none absolute left-3 top-3.5 size-4 text-muted-foreground" />
            <Input
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="종목명 또는 코드 검색"
              aria-label="사용자 지정 종목 검색"
              className="bg-card pl-10"
            />
            {searching ? <LoaderCircle className="absolute right-3 top-3.5 size-4 animate-spin text-muted-foreground" /> : null}
            {searchQuery.trim() && !searching ? (
              <div className="absolute inset-x-0 top-[50px] z-40 max-h-64 overflow-y-auto rounded-[20px] bg-card p-2 shadow-2xl">
                {searchResults.map((item) => {
                  const selected = symbols.includes(item.symbol);
                  return (
                    <button
                      key={`${item.market}:${item.symbol}`}
                      type="button"
                      disabled={selected}
                      onClick={() => addCustomInstrument(item)}
                      aria-label={`${item.symbol} 사용자 지정 종목 추가`}
                      className="flex w-full items-center justify-between gap-3 rounded-2xl px-3 py-3 text-left hover:bg-secondary disabled:opacity-45"
                    >
                      <span className="min-w-0"><strong className="block truncate text-xs">{item.name}</strong><span className="text-[10px] text-muted-foreground">{item.symbol} · {item.market} · {item.currency}</span></span>
                      {selected ? <Check className="size-4" /> : <Plus className="size-4" />}
                    </button>
                  );
                })}
                {!searchResults.length ? <p className="p-3 text-xs text-muted-foreground">{searchError || "검색 결과가 없습니다."}</p> : null}
              </div>
            ) : null}
          </div>

          <div className="mt-4">
            <p className="text-[10px] font-black text-muted-foreground">현재 포트폴리오 · {currentPortfolioInstruments.length}</p>
            <div className="mt-2 flex flex-wrap gap-1.5" role="list" aria-label="현재 포트폴리오 종목">
              {currentPortfolioInstruments.map((item) => (
                <span key={item.symbol} role="listitem" className="inline-flex items-center gap-2 rounded-full bg-card px-3 py-2 text-[10px] font-black"><StockSwatch symbol={item.symbol} theme={theme} />{item.name}<span className="text-muted-foreground">{item.symbol}</span></span>
              ))}
              {!currentPortfolioInstruments.length ? <span className="text-xs text-muted-foreground">현재 보유 종목이 없습니다.</span> : null}
            </div>
          </div>
          {pastPortfolioInstruments.length ? (
            <div className="mt-4">
              <p className="text-[10px] font-black text-muted-foreground">과거 포트폴리오 · {pastPortfolioInstruments.length}</p>
              <div className="mt-2 flex flex-wrap gap-1.5" role="list" aria-label="과거 포트폴리오 종목">
                {pastPortfolioInstruments.map((item) => {
                  const excluded = excludedHistoricalSymbols.has(item.symbol);
                  return (
                    <span key={item.symbol} role="listitem" className={cn("inline-flex items-center gap-2 rounded-full bg-card px-3 py-2 text-[10px] font-black", excluded && "opacity-45")}>
                      <StockSwatch symbol={item.symbol} theme={theme} />{item.name}<span className="text-muted-foreground">{item.symbol}</span>
                      <button
                        type="button"
                        aria-label={`${item.symbol} 과거 포트폴리오 차트 ${excluded ? "추가" : "제외"}`}
                        onClick={() => setExcludedHistoricalSymbols((current) => {
                          const next = new Set(current);
                          if (next.has(item.symbol)) next.delete(item.symbol);
                          else next.add(item.symbol);
                          return next;
                        })}
                      >{excluded ? <Plus className="size-3" /> : <Minus className="size-3" />}</button>
                    </span>
                  );
                })}
              </div>
            </div>
          ) : null}
          <div className="mt-4">
            <p className="text-[10px] font-black text-muted-foreground">사용자 지정 · {customWatchlist.length}</p>
            <div className="mt-2 flex flex-wrap gap-1.5" role="list" aria-label="사용자 지정 종목 목록">
              {customWatchlist.map((item) => (
                <span key={item.symbol} role="listitem" className="inline-flex items-center gap-2 rounded-full bg-card px-3 py-2 text-[10px] font-black">
                  <StockSwatch symbol={item.symbol} theme={theme} />{item.name}<span className="text-muted-foreground">{item.symbol}</span>
                  <button type="button" onClick={() => removeCustomInstrument(item.symbol)} aria-label={`${item.symbol} 사용자 지정 목록에서 삭제`}><Trash2 className="size-3" /></button>
                </span>
              ))}
              {!customWatchlist.length ? <span className="text-xs text-muted-foreground">검색 결과에서 비교할 종목을 추가하세요.</span> : null}
            </div>
          </div>
        </Card>

        <Card className="min-w-0 bg-secondary p-5 sm:p-6">
          <p className="text-[10px] font-black tracking-[0.12em] text-muted-foreground">PRESETS</p>
          <h3 className="mt-1 text-lg font-black">목록·차트 구성 저장</h3>
          <div className="mt-4 space-y-2">
            <Input aria-label="새 기술적 분석 프리셋 이름" value={presetName} onChange={(event) => setPresetName(event.target.value)} maxLength={120} placeholder="새 프리셋 이름" className="bg-card" />
            <div className="grid grid-cols-2 gap-2">
              <Button size="sm" variant="secondary" className="bg-card" aria-label="기술적 분석 종목 목록 프리셋 저장" disabled={presetBusy || !presetName.trim()} onClick={() => void savePreset("technical_watchlist")}><Save />종목 목록</Button>
              <Button size="sm" variant="secondary" className="bg-card" aria-label="기술적 분석 차트 구성 프리셋 저장" disabled={presetBusy || !presetName.trim()} onClick={() => void savePreset("technical_chart_config")}><Save />차트 구성</Button>
            </div>
            <Select value={selectedPresetId} onValueChange={(value) => void restorePreset(value)} disabled={presetBusy || !presets.length}>
              <SelectTrigger className="w-full bg-card" aria-label="기술적 분석 프리셋 복원"><SelectValue placeholder="저장된 프리셋 복원" /></SelectTrigger>
              <SelectContent>{presets.map((preset) => <SelectItem key={preset.id} value={preset.id}>{preset.name}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          {presetNotice ? <p className="mt-3 text-[10px] leading-4 text-muted-foreground">{presetNotice}</p> : null}
        </Card>
      </div>

      <Card className="min-w-0 bg-secondary p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><p className="text-[10px] font-black tracking-[0.12em] text-muted-foreground">COMMON CHART SETTINGS</p><h3 className="mt-1 text-lg font-black">전체 차트 공통 설정</h3></div>
          {isStale ? <span className="rounded-full bg-amber-500/15 px-3 py-1.5 text-[10px] font-black text-amber-700 dark:text-amber-300">설정 변경됨 · 다시 분석 필요</span> : null}
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-[20px] bg-card p-4 md:col-span-2">
            <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-[10px] font-black text-muted-foreground">공통 기간</span><div className="flex gap-1">{([3, 6, 12, 36] as const).map((months) => <button key={months} type="button" onClick={() => selectPeriod(months)} className="rounded-full bg-secondary px-2.5 py-1.5 text-[9px] font-black">{months === 12 ? "1년" : months === 36 ? "3년" : `${months}개월`}</button>)}</div></div>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <label><span className="sr-only">분석 시작일</span><Input type="date" value={fromDate} max={toDate} onChange={(event) => setFromDate(event.target.value)} className="bg-secondary" /></label>
              <label><span className="sr-only">분석 종료일</span><Input type="date" value={toDate} min={fromDate} max={today} onChange={(event) => setToDate(event.target.value)} className="bg-secondary" /></label>
            </div>
            {!dateRangeValid ? <p className="mt-2 text-[10px] font-bold text-destructive">시작일·종료일 범위를 확인해 주세요.</p> : null}
          </div>

          <label className="rounded-[20px] bg-card p-4"><span className="mb-2 block text-[10px] font-black text-muted-foreground">봉 간격</span><Select value={interval} onValueChange={(value) => setInterval(value as "1d" | "1w")}><SelectTrigger className="w-full bg-secondary"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="1d">일봉</SelectItem><SelectItem value="1w">주봉</SelectItem></SelectContent></Select><p className="mt-2 text-[9px] leading-4 text-muted-foreground">지표 period는 봉 개수 기준입니다. 52주 위치의 기본 period는 서버가 일봉 252, 주봉 52로 고정합니다.</p></label>
          <label className="rounded-[20px] bg-card p-4"><span className="mb-2 block text-[10px] font-black text-muted-foreground">통화 기준</span><Select value={currencyMode} onValueChange={(value) => setCurrencyMode(value as CurrencyMode)}><SelectTrigger className="w-full bg-secondary"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="local">현지 통화</SelectItem><SelectItem value="KRW">KRW 환산</SelectItem></SelectContent></Select><p className="mt-2 text-[9px] leading-4 text-muted-foreground">환산은 서버 가격 계층에서 수행합니다.</p></label>
          <label className="rounded-[20px] bg-card p-4"><span className="mb-2 block text-[10px] font-black text-muted-foreground">가격 표시</span><Select value={priceMode} onValueChange={(value) => setPriceMode(value as PriceMode)}><SelectTrigger className="w-full bg-secondary"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="actual">실제 가격</SelectItem><SelectItem value="starting100">시작점 100</SelectItem></SelectContent></Select><p className="mt-2 text-[9px] leading-4 text-muted-foreground">100 기준은 표시 변환이며 지표 원본은 바뀌지 않습니다.</p></label>
          <label className="rounded-[20px] bg-card p-4"><span className="mb-2 block text-[10px] font-black text-muted-foreground">정렬</span><Select value={sortMode} onValueChange={(value) => setSortMode(value as SortMode)}><SelectTrigger className="w-full bg-secondary"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="weight">포트폴리오 비중순</SelectItem><SelectItem value="return">수익률순</SelectItem><SelectItem value="indicator">지표값순</SelectItem></SelectContent></Select><p className="mt-2 text-[9px] leading-4 text-muted-foreground">{sortMode === "weight" ? weightDataLoaded && !portfolioWeights ? "통합 KRW 비중 unavailable · 보유 순서 유지" : "전체 이력의 최신 통합 KRW 비중 기준" : sortMode === "indicator" ? "첫 사용 가능 worker 지표값 기준" : "선택 기간 첫·마지막 가격 기준"}</p></label>
          <label className="rounded-[20px] bg-card p-4"><span className="mb-2 block text-[10px] font-black text-muted-foreground">레이아웃</span><Select value={String(columns)} onValueChange={(value) => setColumns(Number(value) as 1 | 2 | 3 | 4)}><SelectTrigger className="w-full bg-secondary"><SelectValue /></SelectTrigger><SelectContent>{[1, 2, 3, 4].map((value) => <SelectItem key={value} value={String(value)}>{value}열</SelectItem>)}</SelectContent></Select><p className="mt-2 text-[9px] leading-4 text-muted-foreground">모바일에서는 항상 1열입니다.</p></label>
          <label className="rounded-[20px] bg-card p-4"><span className="mb-2 block text-[10px] font-black text-muted-foreground">벤치마크</span><Select value={effectiveBenchmark} onValueChange={setBenchmarkSymbol} disabled={!symbols.length}><SelectTrigger className="w-full bg-secondary"><SelectValue placeholder="종목 선택" /></SelectTrigger><SelectContent>{allInstruments.map((item) => <SelectItem key={item.symbol} value={item.symbol}>{item.symbol} · {item.name}</SelectItem>)}</SelectContent></Select><p className="mt-2 text-[9px] leading-4 text-muted-foreground">상대강도 계산에 worker instrument key로 전달합니다.</p></label>
          <div className="rounded-[20px] bg-card p-4">
            <span className="block text-[10px] font-black text-muted-foreground">거래 marker</span>
            <button type="button" aria-pressed={showTradeMarkers} onClick={() => setShowTradeMarkers((value) => !value)} className={cn("mt-2 flex w-full items-center justify-between rounded-full px-4 py-2.5 text-xs font-black", showTradeMarkers ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground")}><span>매수·매도 표시</span>{showTradeMarkers ? <Check /> : <Minus />}</button>
            <p className="mt-2 text-[9px] leading-4 text-muted-foreground">거래·비중 값은 서버 복원 결과만 표시합니다.</p>
          </div>
        </div>

        <div className="mt-3 rounded-[20px] bg-card p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div><p className="text-[10px] font-black text-muted-foreground">전체 적용 지표</p><p className="mt-1 text-[9px] text-muted-foreground">종목 카드에서 개별 구성을 선택할 수 있습니다. 거래량 지표는 가격과 분리된 하단 패널에 표시합니다.</p></div>
            <span className="rounded-full bg-secondary px-3 py-1.5 text-[9px] font-black" role="status" aria-live="polite" data-technical-indicator-mode>
              {activeIndicatorPreset === "custom" ? "사용자 정의" : `${TECHNICAL_INDICATOR_PRESETS.find((preset) => preset.key === activeIndicatorPreset)?.label} 프리셋`} · {globalIndicators.length}개
            </span>
          </div>
          <div className="mt-3 flex flex-wrap gap-2" aria-label="기술 지표 카테고리 프리셋">
            {TECHNICAL_INDICATOR_PRESETS.map((preset) => (
              <button
                key={preset.key}
                type="button"
                aria-label={`기술 지표 프리셋 ${preset.label} 적용`}
                aria-pressed={activeIndicatorPreset === preset.key}
                data-technical-indicator-preset={preset.key}
                onClick={() => applyIndicatorPreset(preset.key)}
                className={cn(
                  "rounded-full px-3 py-2 text-[10px] font-black transition-colors",
                  activeIndicatorPreset === preset.key ? "bg-foreground text-background" : "bg-secondary text-foreground",
                )}
              >{preset.label}</button>
            ))}
            <span
              aria-current={activeIndicatorPreset === "custom" ? "true" : undefined}
              data-technical-indicator-preset="custom"
              className={cn("rounded-full px-3 py-2 text-[10px] font-black", activeIndicatorPreset === "custom" ? "bg-foreground text-background" : "bg-secondary text-muted-foreground")}
            >사용자 정의</span>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {TECHNICAL_BATCH_INDICATORS.map((option) => (
              <button
                key={option.kind}
                type="button"
                aria-pressed={globalIndicators.includes(option.kind)}
                aria-label={`${option.label} ${globalIndicators.includes(option.kind) ? "해제" : "선택"}`}
                data-technical-indicator={option.kind}
                onClick={() => toggleGlobalIndicator(option.kind)}
                className={cn("rounded-full px-3 py-2 text-[10px] font-black transition-colors", globalIndicators.includes(option.kind) ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground")}
              >{option.shortLabel}<span className="ml-1 opacity-55">{
                option.volumePresentation === "overlay" ? "volume overlay"
                  : option.category === "volume" ? "volume panel"
                    : option.panel === "price" ? "overlay"
                      : option.panel === "mixed" ? "overlay+panel" : "panel"
              }</span></button>
            ))}
          </div>
          <div className="mt-4 rounded-[20px] bg-secondary p-4" data-technical-vwap-settings>
            <div className="flex flex-wrap items-center justify-between gap-2"><div><p className="text-[10px] font-black">VWAP·Anchored VWAP 공통 계산 설정</p><p className="mt-1 text-[9px] text-muted-foreground">선택한 모든 종목의 Rust 계산에 동일하게 적용됩니다. 최근 고·저점은 각 bar까지의 과거만 보는 causal anchor입니다.</p></div><span className="rounded-full bg-amber-500/15 px-2.5 py-1 text-[9px] font-black">{interval === "1d" ? "일봉" : "주봉"} 기반 근사치</span></div>
            <div className="mt-3 grid gap-2 md:grid-cols-3">
              <label><span className="sr-only">VWAP 표시 모드</span><Select value={vwapSettings.mode} onValueChange={(mode) => setVwapSettings((current) => ({ ...current, mode: mode as TechnicalVwapSettings["mode"] }))}><SelectTrigger className="w-full bg-card" aria-label="VWAP 표시 모드"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="both">VWAP + Anchored VWAP</SelectItem><SelectItem value="vwap">VWAP</SelectItem><SelectItem value="anchored">Anchored VWAP</SelectItem></SelectContent></Select></label>
              <label><span className="sr-only">Anchored VWAP anchor</span><Select value={vwapSettings.anchor} onValueChange={(anchor) => setVwapSettings((current) => ({ ...current, anchor: anchor as TechnicalVwapSettings["anchor"] }))}><SelectTrigger className="w-full bg-card" aria-label="Anchored VWAP anchor"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="period_start">기간 시작일</SelectItem><SelectItem value="user_date">사용자 선택일</SelectItem><SelectItem value="recent_high">최근 고점</SelectItem><SelectItem value="recent_low">최근 저점</SelectItem><SelectItem value="signal_date">신호 발생일</SelectItem></SelectContent></Select></label>
              {vwapSettings.anchor === "user_date" || vwapSettings.anchor === "signal_date" ? (
                <label><span className="sr-only">Anchored VWAP anchor 날짜</span><Input aria-label="Anchored VWAP anchor 날짜" type="date" min={fromDate} max={toDate} value={vwapSettings.anchorDate || fromDate} onChange={(event) => setVwapSettings((current) => ({ ...current, anchorDate: event.target.value }))} className="bg-card" /></label>
              ) : vwapSettings.anchor === "recent_high" || vwapSettings.anchor === "recent_low" ? (
                <label><span className="sr-only">Anchored VWAP lookback 봉 수</span><Input aria-label="Anchored VWAP lookback 봉 수" type="number" min={1} max={10_000} value={vwapSettings.lookbackPeriod} onChange={(event) => setVwapSettings((current) => ({ ...current, lookbackPeriod: Math.min(10_000, Math.max(1, Number(event.target.value) || 1)) }))} className="bg-card" /></label>
              ) : <div className="grid place-items-center rounded-xl bg-card px-3 text-[9px] text-muted-foreground">요청 기간 첫 bar anchor</div>}
            </div>
          </div>
          {!indicatorDefinitions.length ? <p className="mt-3 text-[10px] font-bold text-destructive">한 개 이상의 지표를 선택하세요.</p> : null}
        </div>

        <div className="mt-3 flex flex-col gap-3 rounded-[20px] bg-card p-4 sm:flex-row sm:items-center sm:justify-between">
          <div><p className="text-[10px] font-black text-muted-foreground">공통 날짜 확대·축소</p><p className="mt-1 text-xs font-black">{visibleFromDate} ~ {toDate} · 요청 기간의 {visiblePercent}%</p></div>
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="icon" onClick={() => setVisiblePercent((value) => Math.max(10, value - 15))} aria-label="공통 차트 확대"><ZoomIn /></Button>
            <input aria-label="공통 차트 표시 기간" type="range" min={10} max={100} step={5} value={visiblePercent} onChange={(event) => setVisiblePercent(Number(event.target.value))} className="w-28 accent-foreground sm:w-40" />
            <Button variant="secondary" size="icon" onClick={() => setVisiblePercent((value) => Math.min(100, value + 15))} aria-label="공통 차트 축소"><ZoomOut /></Button>
            <Button variant="secondary" size="sm" onClick={() => setVisiblePercent(100)}>전체</Button>
          </div>
        </div>
      </Card>

      {analysisError ? <div role="alert" className="flex items-start gap-3 rounded-[20px] bg-destructive/10 p-4 text-sm text-destructive"><AlertCircle className="mt-0.5 size-4 shrink-0" /><span>{analysisError}</span></div> : null}
      {markerNotice ? <div role="status" className="rounded-[20px] bg-secondary p-4 text-xs text-muted-foreground">{markerNotice}</div> : null}

      {analysis ? (
        <div>
          <div className="mb-3 flex flex-wrap items-end justify-between gap-3 px-1">
            <div><p className="text-[10px] font-black tracking-[0.12em] text-muted-foreground">SYNCHRONIZED CHARTS</p><h3 className="mt-1 text-xl font-black">{analysis.price_series.length}개 종목 동시 비교</h3></div>
            <div className="text-right text-[9px] text-muted-foreground"><p>engine {analysis.technical_analysis.indicator_engine_version}</p><p>{analysis.technical_analysis.adjustment_policy} · run {analysis.run_id}</p></div>
          </div>
          <div className={cn("grid min-w-0 gap-3", chartGridClass(columns))} data-technical-chart-grid>
            {sortedSeries.map((series) => {
              const instrument = instrumentBySymbol.get(series.symbol) ?? { symbol: series.symbol, name: series.symbol, market: series.market, currency: series.currency === "USD" ? "USD" as const : "KRW" as const };
              return (
                <TechnicalInstrumentCard
                  key={series.key}
                  series={series}
                  instrument={instrument}
                  holding={holdingBySymbol.get(series.symbol)}
                  historicalPortfolio={!holdingBySymbol.has(series.symbol) && pastPortfolioInstruments.some((item) => item.symbol === series.symbol)}
                  portfolioWeight={portfolioWeights?.get(series.symbol)}
                  calculations={calculationsForInstrument(analysis, series.key)}
                  globalIndicators={globalIndicators}
                  overrideIndicators={indicatorOverrides[series.symbol]}
                  interval={interval}
                  priceMode={priceMode}
                  visibleFromDate={visibleFromDate}
                  markers={tradeMarkers.filter((marker) => marker.symbol === series.symbol)}
                  showTradeMarkers={showTradeMarkers}
                  theme={theme}
                  onOverrideChange={updateOverride}
                />
              );
            })}
          </div>
        </div>
      ) : loading ? (
        <Card className="grid min-h-80 place-items-center bg-secondary p-8 text-center"><div><LoaderCircle className="mx-auto size-7 animate-spin" /><p className="mt-3 text-sm font-black">Rust worker가 batch 지표를 계산하고 있습니다.</p></div></Card>
      ) : (
        <Card className="grid min-h-80 place-items-center bg-secondary p-8 text-center"><div><CandlestickChart className="mx-auto size-8 text-muted-foreground" /><p className="mt-3 text-sm font-black">종목과 지표를 선택한 뒤 분석을 실행하세요.</p></div></Card>
      )}

      {onOpenTechnicalBacktest && symbols.length && indicatorDefinitions.length ? (
        <TechnicalStrategyWorkspace
          accountId={portfolio.selectedAccountId}
          analysis={technicalStrategyAnalysis}
          portfolioWeights={portfolioWeights}
          onUnauthorized={onUnauthorized}
          onOpenBacktest={onOpenTechnicalBacktest}
        />
      ) : null}

      <FocusedVolumeProfile
        instruments={allInstruments}
        settings={volumeProfileSettings}
        analysis={profileAnalysis}
        interval={interval}
        loading={profileLoading}
        error={profileError}
        onSettingsChange={(settings) => {
          setVolumeProfileSettings(settings);
          setProfileAnalysis(undefined);
          setProfileError("");
        }}
        onRun={() => void analyzeVolumeProfile()}
      />
    </section>
  );
}
