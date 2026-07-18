import { useEffect, useMemo, useState } from "react";
import { Activity, AlertCircle, BarChart3, CalendarDays, CandlestickChart, Info, LoaderCircle, RefreshCw, ShieldCheck, TrendingDown } from "lucide-react";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ReportGenerateButton } from "@/components/report-generate-button";
import {
  chartTooltipStyle,
  MONOCHROME_DASHES,
  MONOCHROME_SERIES,
  monochromeHeatmapStyle,
} from "@/lib/chart-theme";
import {
  analysisComparisonDomain,
  analysisPeriodChange,
  buildAnalysisChartData,
  type AnalysisChartPoint,
} from "@/lib/analysis-chart";
import {
  isValidCalendarRange,
  seoulDateString,
  shiftCalendarDate,
  type CalendarDateRange,
} from "@/lib/date-range";
import { formatMoney, formatPercent, formatSignedMoney } from "@/lib/format";
import { correlationAssetLabel, correlationCellStyle } from "@/lib/correlation-labels";
import { cn } from "@/lib/utils";
import type {
  AnalysisRange,
  ApiError,
  BenchmarkKey,
  Portfolio,
  PortfolioAnalysis,
} from "@/types";

const ranges: Array<{ value: AnalysisRange; label: string }> = [
  { value: "30d", label: "30일" },
  { value: "90d", label: "90일" },
  { value: "1y", label: "1년" },
  { value: "all", label: "전체" },
];

const benchmarks: Array<{ key: BenchmarkKey; label: string; detail: string; color: string }> = [
  { key: "KOSPI", label: "KOSPI", detail: "국내 지수", color: MONOCHROME_SERIES[0] },
  { key: "KOSDAQ", label: "KOSDAQ", detail: "국내 지수", color: MONOCHROME_SERIES[1] },
  { key: "NASDAQ100", label: "나스닥 100", detail: "QQQ 프록시", color: MONOCHROME_SERIES[2] },
  { key: "SP500", label: "S&P 500", detail: "SPY 프록시", color: MONOCHROME_SERIES[3] },
];
const monthLabels = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"];

function displayDate(value: string, withYear = false): string {
  const date = new Date(`${value}T00:00:00+09:00`);
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    ...(withYear ? { year: "numeric" } : {}),
    month: "short",
    day: "numeric",
  }).format(date);
}

function presetRange(range: AnalysisRange, today: string, firstDate?: string): CalendarDateRange {
  if (range === "all") return { from: firstDate || "", to: today };
  const days = range === "30d" ? 30 : range === "90d" ? 90 : 365;
  const candidate = shiftCalendarDate(today, -(days - 1));
  return { from: firstDate && firstDate > candidate ? firstDate : candidate, to: today };
}

type CandleShapeProps = {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  payload?: AnalysisChartPoint;
};

function CandleShape(input: unknown) {
  const { x = 0, y = 0, width = 0, height = 0, payload } = input as CandleShapeProps;
  if (!payload) return <g />;
  const rising = payload.normalizedClose >= payload.normalizedOpen;
  const color = "hsl(var(--foreground))";
  const spread = payload.normalizedHigh - payload.normalizedLow;
  const pixelsPerUnit = spread > 0 ? height / spread : 0;
  const bodyTop = spread > 0
    ? y + (payload.normalizedHigh - Math.max(payload.normalizedOpen, payload.normalizedClose)) * pixelsPerUnit
    : y;
  const bodyBottom = spread > 0
    ? y + (payload.normalizedHigh - Math.min(payload.normalizedOpen, payload.normalizedClose)) * pixelsPerUnit
    : y;
  const center = x + width / 2;
  const bodyWidth = Math.max(1.5, Math.min(width * 0.72, 10));
  const bodyHeight = Math.max(1.5, bodyBottom - bodyTop);
  return (
    <g>
      <line x1={center} y1={y} x2={center} y2={y + Math.max(height, 1)} stroke={color} strokeWidth={1} />
      <rect
        x={center - bodyWidth / 2}
        y={bodyTop}
        width={bodyWidth}
        height={bodyHeight}
        rx={1}
        fill={rising ? color : "hsl(var(--card))"}
        stroke={color}
        strokeWidth={1.2}
      />
    </g>
  );
}

type TooltipContentProps = {
  active?: boolean;
  label?: string;
  payload?: Array<{ payload?: AnalysisChartPoint }>;
  selectedBenchmarks: ReadonlySet<BenchmarkKey>;
};

function AnalysisTooltip({ active, label, payload, selectedBenchmarks }: TooltipContentProps) {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;
  return (
    <div className="min-w-48 rounded-2xl bg-card p-4 text-xs shadow-2xl">
      <p className="font-black">{displayDate(String(label), true)}</p>
      <div className="mt-3 grid grid-cols-2 gap-x-5 gap-y-1.5 text-muted-foreground">
        <span>시가</span><strong className="text-right text-foreground">{formatMoney(point.open, "KRW")}</strong>
        <span>고가</span><strong className="text-right text-foreground">{formatMoney(point.high, "KRW")}</strong>
        <span>저가</span><strong className="text-right text-foreground">{formatMoney(point.low, "KRW")}</strong>
        <span>종가</span><strong className="text-right text-foreground">{formatMoney(point.close, "KRW")}</strong>
      </div>
      <div className="mt-3 space-y-1.5">
        {benchmarks.filter((item) => selectedBenchmarks.has(item.key)).map((item) => {
          const value = point.benchmarkValues[item.key];
          return value === undefined ? null : (
            <div key={item.key} className="flex items-center justify-between gap-4">
              <span className="flex items-center gap-2 text-muted-foreground">
                <span className="size-2 rounded-full" style={{ backgroundColor: item.color }} />{item.label}
              </span>
              <strong>{formatPercent(value, true)}</strong>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function metricPercent(value: number | null | undefined): string {
  return value === null || value === undefined ? "데이터 부족" : formatPercent(value, true);
}

function metricRatio(value: number | null | undefined): string {
  return value === null || value === undefined ? "데이터 부족" : value.toFixed(2);
}

function MetricCard({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="min-w-0 rounded-[20px] bg-card p-4 sm:p-5">
      <p className="text-[11px] font-bold text-muted-foreground">{label}</p>
      <p className="mt-2 break-words text-lg font-black leading-tight tracking-[-0.035em] sm:text-xl">{value}</p>
      <p className="mt-2 text-[11px] leading-4 text-muted-foreground">{detail}</p>
    </div>
  );
}

export function PortfolioAnalysisView({
  portfolio,
  onUnauthorized,
}: {
  portfolio: Portfolio;
  onUnauthorized: () => void;
}) {
  const today = useMemo(() => seoulDateString(), []);
  const [period, setPeriod] = useState<AnalysisRange | "custom">("30d");
  const [draftDateRange, setDraftDateRange] = useState<CalendarDateRange>(() => presetRange("30d", today));
  const [customDateRange, setCustomDateRange] = useState<CalendarDateRange>();
  const [analysis, setAnalysis] = useState<PortfolioAnalysis>();
  const [selectedBenchmarks, setSelectedBenchmarks] = useState<Set<BenchmarkKey>>(
    () => new Set(["KOSPI", "NASDAQ100"]),
  );
  const [riskFreeRate, setRiskFreeRate] = useState(0);
  const [draftRiskFreeRate, setDraftRiskFreeRate] = useState("0");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({
      account: portfolio.selectedAccountId,
      range: period === "custom" ? "all" : period,
      benchmarks: benchmarks.map((item) => item.key).join(","),
      riskFreeRate: String(riskFreeRate),
    });
    if (period === "custom" && customDateRange) {
      params.set("from", customDateRange.from);
      params.set("to", customDateRange.to);
    }
    setLoading(true);
    setError("");
    fetch(`/api/portfolio/analysis?${params.toString()}`, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({})) as PortfolioAnalysis & ApiError;
        if (response.status === 401) {
          onUnauthorized();
          return;
        }
        if (!response.ok) throw new Error(payload.error?.message || "분석 데이터를 불러오지 못했습니다.");
        setAnalysis(payload);
        if (period !== "custom") setDraftDateRange(presetRange(period, today, payload.fromDate));
      })
      .catch((caught: unknown) => {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setError(caught instanceof Error ? caught.message : "분석 데이터를 불러오지 못했습니다.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [customDateRange?.from, customDateRange?.to, onUnauthorized, period, portfolio.selectedAccountId, retryKey, riskFreeRate, today]);

  useEffect(() => {
    if (!analysis || analysis.ohlcBackfillComplete) return;
    const timer = window.setTimeout(() => setRetryKey((value) => value + 1), 10_000);
    return () => window.clearTimeout(timer);
  }, [analysis]);

  const chartData = useMemo(() => analysis ? buildAnalysisChartData(analysis) : [], [analysis]);
  const chartDomain = useMemo(
    () => analysisComparisonDomain(chartData, selectedBenchmarks),
    [chartData, selectedBenchmarks],
  );
  const portfolioBase = chartData[0]?.close ?? 0;
  const change = analysis?.metrics.valuationChangePercent ?? analysisPeriodChange(chartData);
  const latest = chartData.at(-1);
  const high = chartData.length ? Math.max(...chartData.map((point) => point.high)) : 0;
  const low = chartData.length ? Math.min(...chartData.map((point) => point.low)) : 0;
  const canApplyDateRange = isValidCalendarRange(draftDateRange, today);
  const primaryBenchmark = benchmarks.find((item) => selectedBenchmarks.has(item.key)) ?? benchmarks[0];
  const primaryComparison = analysis?.benchmarkComparisons.find((item) => item.key === primaryBenchmark.key);
  const rollingData = analysis?.rolling.filter((point) => (
    point.return20d !== null || point.volatility60d !== null || point.benchmarkBeta60d[primaryBenchmark.key] !== undefined
  )) ?? [];
  const hasRolling60 = rollingData.some((point) => point.volatility60d !== null);
  const monthlyYears = useMemo(() => {
    const rows = new Map<string, Record<number, number>>();
    for (const item of analysis?.monthlyReturns ?? []) {
      const [year, month] = item.month.split("-").map(Number);
      rows.set(String(year), { ...(rows.get(String(year)) ?? {}), [month]: item.returnPercent });
    }
    return Array.from(rows, ([year, months]) => ({ year, months })).sort((left, right) => right.year.localeCompare(left.year));
  }, [analysis]);

  const selectPreset = (range: AnalysisRange) => {
    setPeriod(range);
    setCustomDateRange(undefined);
    setDraftDateRange(presetRange(range, today, analysis?.fromDate));
  };
  const applyDateRange = () => {
    if (!canApplyDateRange) return;
    setCustomDateRange({ ...draftDateRange });
    setPeriod("custom");
  };
  const toggleBenchmark = (key: BenchmarkKey) => {
    setSelectedBenchmarks((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const applyRiskFreeRate = () => {
    const value = Number(draftRiskFreeRate);
    if (!Number.isFinite(value) || value < -10 || value > 50) return;
    setRiskFreeRate(Math.round(value * 100) / 100);
  };

  return (
    <section aria-labelledby="analysis-title" className="space-y-3">
      <Card className="bg-secondary p-5 sm:p-7">
        <div className="flex flex-col gap-6 xl:flex-row xl:items-start xl:justify-between">
          <div className="max-w-2xl">
            <div className="mb-2 flex items-center gap-2 text-xs font-bold tracking-[0.14em] text-muted-foreground">
              <CandlestickChart className="size-4" aria-hidden="true" /> DAILY PORTFOLIO OHLC
            </div>
            <h2 id="analysis-title" className="text-2xl font-black tracking-[-0.04em]">포트폴리오 전체 평가금 일봉</h2>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              국내·해외 종목을 일별 USD/KRW 환율로 원화 환산해 한 번에 재구성한 전체 평가금 추정 OHLC입니다.
            </p>
            <p className="mt-1 text-xs font-bold text-muted-foreground">포트폴리오와 비교 지수는 기준일 종가를 0%로 맞추며, QQQ·SPY도 일별 USD/KRW를 반영한 원화 수익률로 비교합니다.</p>
          </div>

          <div className="w-full xl:w-[560px]">
            <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
              <div className="inline-flex min-h-10 items-center justify-center rounded-full bg-card px-4 text-[11px] font-black text-muted-foreground">
                KRW 환산 · 국내 + 해외
              </div>
              <div className="grid flex-1 grid-cols-4 rounded-full bg-card p-1" aria-label="분석 기간">
                {ranges.map((item) => (
                  <button
                    key={item.value}
                    type="button"
                    aria-pressed={period === item.value}
                    onClick={() => selectPreset(item.value)}
                    className={cn(
                      "rounded-full px-2 py-2 text-[11px] font-black transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      period === item.value ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
                    )}
                  >{item.label}</button>
                ))}
              </div>
            </div>

            <div className="mt-2 grid grid-cols-2 gap-2 rounded-[20px] bg-card p-3 sm:grid-cols-[1fr_1fr_auto]">
              <label className="min-w-0">
                <span className="mb-1.5 block px-1 text-[10px] font-bold text-muted-foreground">시작일</span>
                <Input
                  type="date"
                  value={draftDateRange.from}
                  max={draftDateRange.to || today}
                  onChange={(event) => setDraftDateRange((current) => ({ ...current, from: event.target.value }))}
                  className="h-10 rounded-xl bg-secondary px-3 text-xs font-bold"
                  aria-label="분석 시작일"
                />
              </label>
              <label className="min-w-0">
                <span className="mb-1.5 block px-1 text-[10px] font-bold text-muted-foreground">종료일</span>
                <Input
                  type="date"
                  value={draftDateRange.to}
                  min={draftDateRange.from}
                  max={today}
                  onChange={(event) => setDraftDateRange((current) => ({ ...current, to: event.target.value }))}
                  className="h-10 rounded-xl bg-secondary px-3 text-xs font-bold"
                  aria-label="분석 종료일"
                />
              </label>
              <Button
                type="button"
                size="sm"
                variant={period === "custom" ? "default" : "secondary"}
                disabled={!canApplyDateRange}
                onClick={applyDateRange}
                className="col-span-2 h-10 self-end sm:col-span-1"
              >
                <CalendarDays /> 적용
              </Button>
            </div>
            <div className="mt-2 flex items-end gap-2 rounded-[20px] bg-card p-3">
              <label className="min-w-0 flex-1">
                <span className="mb-1.5 block px-1 text-[10px] font-bold text-muted-foreground">연 무위험수익률 · 샤프·소르티노·알파 계산</span>
                <div className="relative">
                  <Input
                    type="number"
                    min={-10}
                    max={50}
                    step={0.1}
                    value={draftRiskFreeRate}
                    onChange={(event) => setDraftRiskFreeRate(event.target.value)}
                    onKeyDown={(event) => { if (event.key === "Enter") applyRiskFreeRate(); }}
                    className="h-10 rounded-xl bg-secondary pr-8 text-right text-xs font-bold"
                    aria-label="연 무위험수익률"
                  />
                  <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs font-bold text-muted-foreground">%</span>
                </div>
              </label>
              <Button type="button" size="sm" variant="secondary" className="h-10" onClick={applyRiskFreeRate}>적용</Button>
            </div>
          </div>
        </div>

        <div className="mt-6 flex flex-wrap gap-2" aria-label="비교 지수 선택">
          {benchmarks.map((item) => (
            <button
              key={item.key}
              type="button"
              aria-pressed={selectedBenchmarks.has(item.key)}
              onClick={() => toggleBenchmark(item.key)}
              className={cn(
                "inline-flex min-h-10 items-center gap-2 rounded-full bg-card px-3.5 text-xs font-bold transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                !selectedBenchmarks.has(item.key) && "opacity-45",
              )}
            >
              <span className="size-2.5 rounded-full" style={{ backgroundColor: item.color }} />
              <span>{item.label}</span>
              <span className="text-[10px] text-muted-foreground">{item.detail}</span>
            </button>
          ))}
        </div>

        {analysis && !loading && !error ? (
          <div className="mt-5 flex flex-col gap-3 rounded-[22px] bg-card p-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-xs font-black">선택 기간 AI 평가</p>
              <p className="mt-1 text-[11px] leading-5 text-muted-foreground">화면의 기간과 선택한 비교 지수를 다시 계산해 고정 템플릿 보고서로 저장합니다.</p>
            </div>
            <ReportGenerateButton
              key={`${analysis.generatedAt}:${Array.from(selectedBenchmarks).sort().join(",")}`}
              endpoint="/api/reports/portfolio-analysis"
              requestBody={{
                account: portfolio.selectedAccountId,
                range: analysis.range,
                from: analysis.fromDate,
                to: analysis.toDate,
                benchmarks: Array.from(selectedBenchmarks).sort().join(","),
                riskFreeRate,
              }}
              onUnauthorized={onUnauthorized}
            />
          </div>
        ) : null}

        {!loading && !error && chartData.length ? (
          <div className="mt-5 grid grid-cols-2 gap-2 lg:grid-cols-4" aria-label="평가금 일봉 요약">
            {[
              ["최근 종가", formatMoney(latest?.close ?? 0, "KRW")],
              ["기간 평가금 변화", formatPercent(change, true)],
              ["기간 추정 고가", formatMoney(high, "KRW")],
              ["기간 추정 저가", formatMoney(low, "KRW")],
            ].map(([label, value]) => (
              <div key={label} className="rounded-[20px] bg-card p-4">
                <p className="text-[11px] font-bold text-muted-foreground">{label}</p>
                <p className="mt-2 truncate text-lg font-black tracking-[-0.03em]">{value}</p>
              </div>
            ))}
          </div>
        ) : null}

        {loading ? (
          <div className="grid h-[440px] place-items-center text-center text-muted-foreground" aria-live="polite">
            <div><LoaderCircle className="mx-auto size-6 animate-spin" /><p className="mt-3 text-sm font-semibold">평가금과 비교 지수 일봉을 불러오는 중</p></div>
          </div>
        ) : error ? (
          <div className="grid h-[440px] place-items-center text-center">
            <div><AlertCircle className="mx-auto size-7 text-muted-foreground" /><p className="mt-4 text-sm font-bold">{error}</p><Button variant="ghost" size="sm" className="mt-3" onClick={() => setRetryKey((value) => value + 1)}><RefreshCw /> 다시 시도</Button></div>
          </div>
        ) : chartData.length === 0 ? (
          <div className="mt-6 grid h-[360px] place-items-center rounded-[24px] bg-card px-6 text-center">
            <div><BarChart3 className="mx-auto size-7 text-muted-foreground" /><p className="mt-4 text-base font-black">선택 기간에 평가금 일봉이 없습니다.</p><p className="mt-2 text-sm text-muted-foreground">더 긴 기간을 선택해 주세요.</p></div>
          </div>
        ) : (
          <div className="mt-7 h-[420px] w-full sm:h-[520px]" aria-label="포트폴리오 평가금 일봉과 비교 지수 차트">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={chartData} margin={{ top: 12, right: 4, bottom: 4, left: 0 }}>
                <CartesianGrid vertical={false} stroke="hsl(var(--chart-grid))" strokeDasharray="3 5" />
                <XAxis dataKey="date" tickFormatter={(value) => displayDate(String(value))} axisLine={false} tickLine={false} minTickGap={34} tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11, fontWeight: 600 }} />
                <YAxis yAxisId="portfolio" domain={chartDomain} allowDataOverflow tickFormatter={(value) => formatMoney(portfolioBase * (1 + Number(value) / 100), "KRW", true)} axisLine={false} tickLine={false} width={66} tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10, fontWeight: 600 }} />
                <YAxis yAxisId="benchmark" orientation="right" domain={chartDomain} allowDataOverflow tickFormatter={(value) => `${Number(value).toFixed(0)}%`} axisLine={false} tickLine={false} width={42} tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10, fontWeight: 600 }} />
                <Tooltip content={(props) => <AnalysisTooltip {...props} selectedBenchmarks={selectedBenchmarks} />} cursor={{ fill: "hsl(var(--foreground) / 0.04)" }} />
                <Bar yAxisId="portfolio" dataKey="candleRange" shape={CandleShape} isAnimationActive={false} maxBarSize={12} />
                {benchmarks.filter((item) => selectedBenchmarks.has(item.key)).map((item) => (
                  <Line
                    key={item.key}
                    yAxisId="benchmark"
                    type="monotone"
                    dataKey={(point: AnalysisChartPoint) => point.benchmarkValues[item.key]}
                    name={item.label}
                    stroke={item.color}
                    strokeDasharray={MONOCHROME_DASHES[benchmarks.findIndex((benchmark) => benchmark.key === item.key)]}
                    strokeWidth={2}
                    dot={false}
                    connectNulls
                    isAnimationActive={false}
                  />
                ))}
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}

        <div className="mt-5 flex items-start gap-2 rounded-[18px] bg-card px-4 py-3 text-xs leading-5 text-muted-foreground">
          {analysis && !analysis.ohlcBackfillComplete ? <LoaderCircle className="mt-0.5 size-4 shrink-0 animate-spin" /> : <Info className="mt-0.5 size-4 shrink-0" />}
          <p>
            {analysis && !analysis.ohlcBackfillComplete
              ? "기존 종목의 시가·고가·저가를 다시 수집하고 있습니다. 완료 전 일부 캔들은 종가 기준으로 평평하게 표시될 수 있습니다."
              : "포트폴리오 장중 고가·저가는 종목별 일봉 극값과 해당일 보유수량을 합산한 추정치입니다. 종목별 극값 발생 시각이 다르므로 실제 계좌 장중 극값과 차이가 날 수 있습니다."}
          </p>
        </div>
        {analysis?.benchmarkErrors.length ? (
          <p className="mt-3 text-xs text-muted-foreground">일부 비교 지수를 불러오지 못했습니다: {analysis.benchmarkErrors.map((item) => item.key).join(", ")}</p>
        ) : null}
      </Card>

      {analysis && !loading && !error ? (
        <>
          <Card className="bg-secondary p-5 sm:p-7">
            <div>
              <p className="text-xs font-bold tracking-[0.14em] text-muted-foreground">PERFORMANCE</p>
              <h3 className="mt-2 text-xl font-black tracking-[-0.035em]">성과와 벤치마크</h3>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">전일 보유비중으로 가중한 종목·환율 수익률과 주요 시장지수를 비교합니다.</p>
            </div>
            <div className="mt-5 grid grid-cols-2 gap-2 xl:grid-cols-3 2xl:grid-cols-6">
              <MetricCard label="보유주식 TWR" value={metricPercent(analysis.metrics.timeWeightedReturnPercent)} detail="입출금 영향 없이 일간수익률 연결" />
              <MetricCard label="보유주식 XIRR" value={metricPercent(analysis.metrics.moneyWeightedReturnPercent)} detail="시작 평가액·체결·종료 평가액 기준 연율" />
              <MetricCard label="연환산 추정수익률" value={metricPercent(analysis.metrics.annualizedReturnPercent)} detail="252 거래일 기준 복리 환산" />
              <MetricCard label="KOSPI 대비" value={metricPercent(analysis.metrics.excessReturns.KOSPI)} detail={`KOSPI ${metricPercent(analysis.metrics.benchmarkReturns.KOSPI)}`} />
              <MetricCard label="나스닥 100 대비" value={metricPercent(analysis.metrics.excessReturns.NASDAQ100)} detail={`QQQ 프록시 ${metricPercent(analysis.metrics.benchmarkReturns.NASDAQ100)}`} />
              <MetricCard label="기간 추정 손익" value={formatSignedMoney(analysis.metrics.estimatedProfitLoss, "KRW")} detail={`순투자 추정 ${formatMoney(analysis.metrics.netInvestedAmount, "KRW")}`} />
            </div>
          </Card>

          <Card className="bg-secondary p-5 sm:p-7">
            <p className="text-xs font-bold tracking-[0.14em] text-muted-foreground">ACTIVE RISK & CAPTURE</p>
            <h3 className="mt-2 text-xl font-black tracking-[-0.035em]">벤치마크 대비 위험과 참여율</h3>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">포트폴리오와 벤치마크의 공통 분석일 수익률을 원화 기준으로 정렬했습니다.</p>
            <div className="mt-5 grid gap-3 xl:grid-cols-2">
              {analysis.benchmarkComparisons.filter((comparison) => selectedBenchmarks.has(comparison.key)).map((comparison) => {
                const style = benchmarks.find((item) => item.key === comparison.key)!;
                return (
                  <div key={comparison.key} className="rounded-[22px] bg-card p-4 sm:p-5">
                    <div className="flex items-center justify-between gap-3">
                      <p className="flex items-center gap-2 text-sm font-black"><i className="size-2.5 rounded-full" style={{ backgroundColor: style.color }} />{style.label}</p>
                      <span className="text-[10px] font-bold text-muted-foreground">{comparison.observations.toLocaleString("ko-KR")}일 · KRW</span>
                    </div>
                    <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
                      <MetricCard label="초과수익" value={metricPercent(comparison.excessReturnPercent)} detail={`벤치마크 ${metricPercent(comparison.returnPercent)}`} />
                      <MetricCard label="추적오차" value={metricPercent(comparison.trackingErrorPercent)} detail="초과수익 변동성" />
                      <MetricCard label="정보비율" value={metricRatio(comparison.informationRatio)} detail="초과수익 ÷ 추적오차" />
                      <MetricCard label="베타 · 알파" value={metricRatio(comparison.beta)} detail={`알파 ${metricPercent(comparison.alphaPercent)}`} />
                      <MetricCard label="상승 · 하락 참여" value={`${metricPercent(comparison.upsideCapturePercent)} · ${metricPercent(comparison.downsideCapturePercent)}`} detail="벤치마크 상승일 · 하락일" />
                      <MetricCard label="일간 · 월간 승률" value={`${metricPercent(comparison.dailyWinRatePercent)} · ${metricPercent(comparison.monthlyWinRatePercent)}`} detail={`상관 ${metricRatio(comparison.correlation)} · 상대 MDD ${metricPercent(comparison.relativeMaxDrawdownPercent)}`} />
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>

          <div className="grid gap-3 xl:grid-cols-[1.35fr_1fr]">
            <Card className="bg-secondary p-5 sm:p-7">
              <p className="text-xs font-bold tracking-[0.14em] text-muted-foreground">RISK</p>
              <h3 className="mt-2 text-xl font-black tracking-[-0.035em]">위험 대비 성과</h3>
              <div className="mt-5 grid grid-cols-2 gap-2 lg:grid-cols-3">
                <MetricCard label="연환산 변동성" value={metricPercent(analysis.metrics.annualizedVolatilityPercent)} detail="일별 추정수익률 표준편차" />
                <MetricCard label="최대 낙폭 MDD" value={metricPercent(analysis.metrics.maxDrawdownPercent)} detail={`최장 낙폭 ${analysis.metrics.maxDrawdownDays ?? 0}일`} />
                <MetricCard label="현재 낙폭" value={metricPercent(analysis.metrics.currentDrawdownPercent)} detail="최근 고점 대비" />
                <MetricCard label="샤프지수" value={metricRatio(analysis.metrics.sharpeRatio)} detail={`연 무위험수익률 ${analysis.metrics.riskFreeRatePercent.toFixed(2)}%`} />
                <MetricCard label="소르티노지수" value={metricRatio(analysis.metrics.sortinoRatio)} detail="하방 변동성만 위험으로 반영" />
                <MetricCard label="Calmar 비율" value={metricRatio(analysis.metrics.calmarRatio)} detail="연환산 수익률 ÷ MDD" />
                <MetricCard label="최고 일간수익률" value={metricPercent(analysis.metrics.bestDailyReturnPercent)} detail="전일 보유비중 기준" />
                <MetricCard label="최저 일간수익률" value={metricPercent(analysis.metrics.worstDailyReturnPercent)} detail="전일 보유비중 기준" />
                <MetricCard label="상승일 비율" value={metricPercent(analysis.metrics.positiveDaysPercent)} detail="수익률이 0%보다 높은 거래일" />
                <MetricCard label="현재 수중 기간" value={`${analysis.drawdowns.currentUnderwaterDays.toLocaleString("ko-KR")}일`} detail="최근 고점 미회복 기간" />
                <MetricCard label="평균 낙폭 · Ulcer" value={`${metricPercent(analysis.drawdowns.averageDrawdownPercent)} · ${metricRatio(analysis.drawdowns.ulcerIndex)}`} detail="낙폭 깊이와 지속 위험" />
                <MetricCard label="최악 20일 · 60일" value={`${metricPercent(analysis.drawdowns.worst20DayReturnPercent)} · ${metricPercent(analysis.drawdowns.worst60DayReturnPercent)}`} detail="롤링 구간 최저 수익률" />
              </div>
            </Card>

            <Card className="bg-secondary p-5 sm:p-7">
              <p className="text-xs font-bold tracking-[0.14em] text-muted-foreground">DIVERSIFICATION & COST</p>
              <h3 className="mt-2 text-xl font-black tracking-[-0.035em]">집중도와 거래 비용</h3>
              <div className="mt-5 grid grid-cols-2 gap-2">
                <MetricCard label="상위 1 · 3종목" value={`${formatPercent(analysis.exposure.top1WeightPercent)} · ${formatPercent(analysis.metrics.top3WeightPercent)}`} detail="기간 마지막 평가일 기준" />
                <MetricCard label="상위 5 · 10종목" value={`${formatPercent(analysis.exposure.top5WeightPercent)} · ${formatPercent(analysis.exposure.top10WeightPercent)}`} detail="집중도 구간 비교" />
                <MetricCard label="유효 종목 수" value={`${analysis.metrics.effectivePositions.toFixed(1)}개`} detail={`HHI ${analysis.metrics.hhi.toFixed(3)}`} />
                <MetricCard label="분산 효과" value={metricPercent(analysis.exposure.diversificationBenefitPercent)} detail="개별 변동성 가중합 대비 감소" />
                <MetricCard label="KRW · USD 노출" value={`${formatPercent(analysis.exposure.krwWeightPercent)} · ${formatPercent(analysis.exposure.usdWeightPercent)}`} detail="국내·해외 동시 평가" />
                <MetricCard label="회전율" value={formatPercent(analysis.metrics.turnoverPercent)} detail={`체결 ${analysis.metrics.tradeCount.toLocaleString("ko-KR")}건`} />
                <MetricCard label="수수료 · 세금" value={formatMoney(analysis.metrics.commission + analysis.metrics.tax, "KRW")} detail={`수수료 ${formatMoney(analysis.metrics.commission, "KRW")} · 세금 ${formatMoney(analysis.metrics.tax, "KRW")}`} />
                <MetricCard label="비용 드래그" value={metricPercent(analysis.costEfficiency.costDragPercent)} detail={`거래금액당 ${analysis.costEfficiency.costPerTradedAmountBps?.toFixed(2) ?? "-"}bp`} />
              </div>
            </Card>
          </div>

          <Card className="bg-secondary p-5 sm:p-7">
            <p className="text-xs font-bold tracking-[0.14em] text-muted-foreground">ROLLING PERFORMANCE</p>
            <h3 className="mt-2 text-xl font-black tracking-[-0.035em]">롤링 수익률과 위험 변화</h3>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">고정된 전체 기간 숫자 대신 최근 20·60·120·252거래일 상태가 어떻게 변했는지 보여줍니다.</p>
            {rollingData.length ? (
              <div className="mt-6 grid gap-3 xl:grid-cols-2">
                <div className="rounded-[22px] bg-card p-4">
                  <p className="text-xs font-black">롤링 누적수익률</p>
                  <div className="mt-4 h-[280px]">
                    {hasRolling60 ? <ResponsiveContainer width="100%" height="100%">
                      <ComposedChart data={rollingData} margin={{ top: 8, right: 4, bottom: 0, left: 0 }}>
                        <CartesianGrid vertical={false} stroke="hsl(var(--chart-grid))" strokeDasharray="3 7" />
                        <XAxis dataKey="date" tickFormatter={(value) => displayDate(String(value))} minTickGap={42} tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
                        <YAxis tickFormatter={(value) => `${Number(value).toFixed(0)}%`} width={44} tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
                        <Tooltip formatter={(value, name) => [formatPercent(Number(value), true), String(name)]} contentStyle={chartTooltipStyle} />
                        <Line type="monotone" dataKey="return20d" name="20일" stroke={MONOCHROME_SERIES[0]} strokeWidth={2.4} dot={false} connectNulls />
                        <Line type="monotone" dataKey="return60d" name="60일" stroke={MONOCHROME_SERIES[1]} strokeDasharray={MONOCHROME_DASHES[1]} strokeWidth={2} dot={false} connectNulls />
                        <Line type="monotone" dataKey="return120d" name="120일" stroke={MONOCHROME_SERIES[2]} strokeDasharray={MONOCHROME_DASHES[2]} strokeWidth={2} dot={false} connectNulls />
                        <Line type="monotone" dataKey="return252d" name="252일" stroke={MONOCHROME_SERIES[3]} strokeDasharray={MONOCHROME_DASHES[3]} strokeWidth={2} dot={false} connectNulls />
                      </ComposedChart>
                    </ResponsiveContainer> : <div className="grid h-full place-items-center rounded-[18px] bg-secondary px-5 text-center text-xs leading-5 text-muted-foreground">60거래일 이상 선택하면 변동성·샤프·베타·상관관계의 변화를 표시합니다.</div>}
                  </div>
                </div>
                <div className="rounded-[22px] bg-card p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs font-black">60일 위험 · {primaryBenchmark.label} 민감도</p>
                    <span className="text-[10px] font-bold text-muted-foreground">원화 기준</span>
                  </div>
                  <div className="mt-4 h-[280px]">
                    <ResponsiveContainer width="100%" height="100%">
                      <ComposedChart data={rollingData} margin={{ top: 8, right: 4, bottom: 0, left: 0 }}>
                        <CartesianGrid vertical={false} stroke="hsl(var(--chart-grid))" strokeDasharray="3 7" />
                        <XAxis dataKey="date" tickFormatter={(value) => displayDate(String(value))} minTickGap={42} tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
                        <YAxis yAxisId="percent" tickFormatter={(value) => `${Number(value).toFixed(0)}%`} width={44} tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
                        <YAxis yAxisId="ratio" orientation="right" width={36} tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
                        <Tooltip formatter={(value, name) => [Number(value).toFixed(2), String(name)]} contentStyle={chartTooltipStyle} />
                        <Line yAxisId="percent" type="monotone" dataKey="volatility60d" name="변동성 %" stroke={MONOCHROME_SERIES[0]} strokeWidth={2.4} dot={false} connectNulls />
                        <Line yAxisId="ratio" type="monotone" dataKey="sharpe60d" name="샤프" stroke={MONOCHROME_SERIES[1]} strokeDasharray={MONOCHROME_DASHES[1]} strokeWidth={2} dot={false} connectNulls />
                        <Line yAxisId="ratio" type="monotone" dataKey={`benchmarkBeta60d.${primaryBenchmark.key}`} name="베타" stroke={MONOCHROME_SERIES[2]} strokeDasharray={MONOCHROME_DASHES[2]} strokeWidth={2} dot={false} connectNulls />
                        <Line yAxisId="ratio" type="monotone" dataKey={`benchmarkCorrelation60d.${primaryBenchmark.key}`} name="상관" stroke={MONOCHROME_SERIES[3]} strokeDasharray={MONOCHROME_DASHES[3]} strokeWidth={2} dot={false} connectNulls />
                      </ComposedChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              </div>
            ) : <p className="mt-5 rounded-[20px] bg-card p-5 text-sm text-muted-foreground">20거래일 이상의 수익률 표본이 쌓이면 롤링 차트를 표시합니다.</p>}
          </Card>

          <div className="grid gap-3 xl:grid-cols-[1.4fr_0.9fr]">
            <Card className="bg-secondary p-5 sm:p-7">
              <p className="text-xs font-bold tracking-[0.14em] text-muted-foreground">DRAWDOWN PATH</p>
              <h3 className="mt-2 text-xl font-black tracking-[-0.035em]">고점 대비 낙폭과 회복</h3>
              <div className="mt-5 h-[300px]">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={analysis.drawdowns.points} margin={{ top: 8, right: 4, bottom: 0, left: 0 }}>
                    <CartesianGrid vertical={false} stroke="hsl(var(--chart-grid))" strokeDasharray="3 7" />
                    <XAxis dataKey="date" tickFormatter={(value) => displayDate(String(value))} minTickGap={42} tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
                    <YAxis tickFormatter={(value) => `${Number(value).toFixed(0)}%`} width={44} tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
                    <Tooltip formatter={(value) => [formatPercent(Number(value), true), "낙폭"]} contentStyle={chartTooltipStyle} />
                    <Line type="monotone" dataKey="drawdownPercent" name="낙폭" stroke={MONOCHROME_SERIES[0]} strokeWidth={2.4} dot={false} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </Card>
            <Card className="bg-secondary p-5 sm:p-7">
              <p className="text-xs font-bold tracking-[0.14em] text-muted-foreground">WORST DRAWDOWNS</p>
              <h3 className="mt-2 text-xl font-black tracking-[-0.035em]">최악 낙폭 구간</h3>
              <div className="mt-5 space-y-2">
                {analysis.drawdowns.episodes.map((episode, index) => (
                  <div key={`${episode.startDate}:${episode.troughDate}`} className="rounded-[18px] bg-card p-4">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-xs font-black">#{index + 1} · {formatPercent(episode.depthPercent, true)}</span>
                      <span className="text-[10px] font-bold text-muted-foreground">{episode.durationDays}일</span>
                    </div>
                    <p className="mt-2 text-[10px] leading-4 text-muted-foreground">{episode.startDate} 고점 → {episode.troughDate} 저점{episode.recoveryDate ? ` → ${episode.recoveryDate} 회복` : " · 미회복"}</p>
                  </div>
                ))}
                {!analysis.drawdowns.episodes.length ? <p className="rounded-[18px] bg-card p-4 text-xs text-muted-foreground">선택 기간에 낙폭 구간이 없습니다.</p> : null}
              </div>
            </Card>
          </div>

          <Card className="bg-secondary p-5 sm:p-7">
            <p className="text-xs font-bold tracking-[0.14em] text-muted-foreground">CONTRIBUTION</p>
            <h3 className="mt-2 text-xl font-black tracking-[-0.035em]">종목별 추정 성과 기여도</h3>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">평가금·체결 기반 추정 손익과 전일 보유비중을 시간 연결한 가격·환율 기여도를 함께 표시합니다.</p>
            {analysis.contributions.length ? (
              <div className="mt-6 space-y-4">
                {analysis.contributions.map((item) => {
                  const maximum = Math.max(...analysis.contributions.map((candidate) => Math.abs(candidate.estimatedProfitLoss)), 1);
                  return (
                    <div key={`${item.currency}:${item.key}`} className="grid gap-2 sm:grid-cols-[minmax(130px,0.8fr)_minmax(180px,2fr)_auto] sm:items-center">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-black">{item.name}</p>
                        <p className="text-[10px] font-bold text-muted-foreground">{item.market} · {item.symbol}</p>
                        <p className="mt-1 text-[10px] font-bold text-muted-foreground">시간연결 {formatPercent(item.timeLinkedContributionPercent, true)} · 가격 {formatPercent(item.localPriceContributionPercent, true)} · 환율 {formatPercent(item.fxContributionPercent, true)}</p>
                      </div>
                      <div className="h-2.5 overflow-hidden rounded-full bg-card">
                        <div className="h-full rounded-full bg-foreground" style={{ width: `${Math.max(3, (Math.abs(item.estimatedProfitLoss) / maximum) * 100)}%`, opacity: item.estimatedProfitLoss >= 0 ? 0.9 : 0.45 }} />
                      </div>
                      <div className="text-left sm:text-right">
                        <p className="text-sm font-black">{formatSignedMoney(item.estimatedProfitLoss, "KRW")}</p>
                        <p className="text-[10px] font-bold text-muted-foreground">{formatPercent(item.contributionPercent, true)}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : <p className="mt-6 rounded-[20px] bg-card p-5 text-sm text-muted-foreground">선택 기간에 계산할 종목별 기여 내역이 없습니다.</p>}
          </Card>

          <div className="grid min-w-0 gap-3 xl:grid-cols-[0.95fr_1.35fr]">
            <Card className="min-w-0 bg-secondary p-5 sm:p-7">
              <p className="text-xs font-bold tracking-[0.14em] text-muted-foreground">TAIL RISK</p>
              <h3 className="mt-2 text-xl font-black tracking-[-0.035em]">손실 분포와 극단 위험</h3>
              <div className="mt-5 grid grid-cols-2 gap-2">
                <MetricCard label="역사적 VaR 95%" value={metricPercent(analysis.tailRisk.historicalVar95Percent)} detail="하위 5% 일간수익률 경계" />
                <MetricCard label="CVaR 95%" value={metricPercent(analysis.tailRisk.expectedShortfall95Percent)} detail="VaR 초과 손실일 평균" />
                <MetricCard label="손실일 비율" value={metricPercent(analysis.tailRisk.lossDaysPercent)} detail={`최장 연속 하락 ${analysis.tailRisk.maxConsecutiveLossDays}일`} />
                <MetricCard label="평균 상승 · 하락" value={`${metricPercent(analysis.tailRisk.averageGainPercent)} · ${metricPercent(analysis.tailRisk.averageLossPercent)}`} detail={`손익비 ${metricRatio(analysis.tailRisk.gainLossRatio)}`} />
                <MetricCard label="왜도" value={metricRatio(analysis.tailRisk.skewness)} detail="음수일수록 왼쪽 꼬리 위험" />
                <MetricCard label="초과 첨도" value={metricRatio(analysis.tailRisk.excessKurtosis)} detail={`최장 연속 상승 ${analysis.tailRisk.maxConsecutiveGainDays}일`} />
              </div>
            </Card>

            <Card className="min-w-0 bg-secondary p-5 sm:p-7">
              <p className="text-xs font-bold tracking-[0.14em] text-muted-foreground">MONTHLY RETURN MAP</p>
              <h3 className="mt-2 text-xl font-black tracking-[-0.035em]">월간 수익률 히트맵</h3>
              <div className="mt-5 w-full min-w-0 overflow-x-auto rounded-[20px] bg-card p-3">
                <table className="w-full min-w-[720px] border-separate border-spacing-1 text-center text-[10px]">
                  <thead><tr><th className="p-2 text-left text-muted-foreground">연도</th>{monthLabels.map((month) => <th key={month} className="p-2 text-muted-foreground">{month}월</th>)}</tr></thead>
                  <tbody>
                    {monthlyYears.map((row) => (
                      <tr key={row.year}>
                        <th className="p-2 text-left text-xs font-black">{row.year}</th>
                        {monthLabels.map((_, index) => {
                          const value = row.months[index + 1];
                          return (
                            <td
                              key={index}
                              className="rounded-xl p-2.5 font-black"
                              style={value === undefined ? undefined : monochromeHeatmapStyle(value)}
                            >{value === undefined ? "-" : `${value > 0 ? "+" : ""}${value.toFixed(1)}`}</td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!monthlyYears.length ? <p className="p-4 text-center text-xs text-muted-foreground">월간 수익률 표본이 없습니다.</p> : null}
              </div>
            </Card>
          </div>

          <div className="grid min-w-0 gap-3 xl:grid-cols-[1fr_1.15fr]">
            <Card className="min-w-0 bg-secondary p-5 sm:p-7">
              <p className="text-xs font-bold tracking-[0.14em] text-muted-foreground">RISK CONTRIBUTION</p>
              <h3 className="mt-2 text-xl font-black tracking-[-0.035em]">종목별 위험 기여도</h3>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">최신 비중과 기간 내 종목 공분산으로 전체 변동성에 대한 기여를 계산합니다.</p>
              <div className="mt-5 space-y-3">
                {analysis.riskContributions.slice(0, 10).map((item) => {
                  const maximum = Math.max(...analysis.riskContributions.map((candidate) => Math.abs(candidate.riskContributionPercent ?? 0)), 1);
                  return (
                    <div key={item.key} className="rounded-[18px] bg-card p-4">
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0"><p className="truncate text-xs font-black">{item.name}</p><p className="mt-1 text-[10px] text-muted-foreground">비중 {formatPercent(item.weightPercent)} · 변동성 {metricPercent(item.annualizedVolatilityPercent)}</p></div>
                        <p className="text-sm font-black">{metricPercent(item.riskContributionPercent)}</p>
                      </div>
                      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-secondary"><div className="h-full rounded-full bg-foreground" style={{ width: `${Math.max(2, Math.abs(item.riskContributionPercent ?? 0) / maximum * 100)}%` }} /></div>
                      <p className="mt-2 text-[10px] text-muted-foreground">포트폴리오 상관 {metricRatio(item.correlationToPortfolio)}</p>
                    </div>
                  );
                })}
                {!analysis.riskContributions.length ? <p className="rounded-[18px] bg-card p-4 text-xs text-muted-foreground">활성 보유종목의 공통 일봉이 부족합니다.</p> : null}
              </div>
            </Card>

            <Card className="min-w-0 bg-secondary p-5 sm:p-7">
              <p className="text-xs font-bold tracking-[0.14em] text-muted-foreground">CURRENT CORRELATION</p>
              <h3 className="mt-2 text-xl font-black tracking-[-0.035em]">현재 보유종목 일간 상관관계</h3>
              <div className="mt-5 w-full min-w-0 overflow-x-auto rounded-[20px] bg-card p-3">
                <table className="w-full min-w-[520px] border-separate border-spacing-1 text-center text-xs">
                  <thead><tr><th className="p-2 text-left text-muted-foreground">종목명</th>{analysis.correlations.assets.map((asset) => <th key={asset.key} className="min-w-[94px] p-2 font-black">{correlationAssetLabel(asset)}</th>)}</tr></thead>
                  <tbody>{analysis.correlations.assets.map((asset, rowIndex) => (
                    <tr key={asset.key}>
                      <th className="max-w-[160px] truncate p-2 text-left font-black">{correlationAssetLabel(asset)}</th>
                      {analysis.correlations.values[rowIndex].map((value, columnIndex) => (
                        <td key={`${asset.key}:${columnIndex}`} className="rounded-xl p-3 font-black" style={correlationCellStyle(value)}>{value === null ? "-" : value.toFixed(2)}</td>
                      ))}
                    </tr>
                  ))}</tbody>
                </table>
                {!analysis.correlations.assets.length ? <p className="p-4 text-center text-xs text-muted-foreground">비교 가능한 현재 보유종목이 없습니다.</p> : null}
              </div>
            </Card>
          </div>

          <div className="grid min-w-0 gap-3 xl:grid-cols-[1.25fr_0.9fr]">
            <Card className="min-w-0 bg-secondary p-5 sm:p-7">
              <p className="text-xs font-bold tracking-[0.14em] text-muted-foreground">TRADING COST</p>
              <h3 className="mt-2 text-xl font-black tracking-[-0.035em]">월별 회전율과 비용</h3>
              <div className="mt-5 h-[280px]">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={analysis.costEfficiency.monthly} margin={{ top: 8, right: 4, bottom: 0, left: 0 }}>
                    <CartesianGrid vertical={false} stroke="hsl(var(--chart-grid))" strokeDasharray="3 7" />
                    <XAxis dataKey="month" tickFormatter={(value) => String(value).slice(2).replace("-", ".")} minTickGap={26} tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
                    <YAxis yAxisId="turnover" tickFormatter={(value) => `${Number(value).toFixed(0)}%`} width={44} tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
                    <YAxis yAxisId="cost" orientation="right" tickFormatter={(value) => formatMoney(Number(value), "KRW", true)} width={56} tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
                    <Tooltip formatter={(value, name) => [name === "회전율" ? formatPercent(Number(value)) : formatMoney(Number(value), "KRW"), String(name)]} contentStyle={chartTooltipStyle} />
                    <Bar yAxisId="turnover" dataKey="turnoverPercent" name="회전율" fill={MONOCHROME_SERIES[1]} radius={[6, 6, 0, 0]} />
                    <Line yAxisId="cost" type="monotone" dataKey="cost" name="비용" stroke={MONOCHROME_SERIES[0]} strokeWidth={2} dot={false} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </Card>
            <Card className="min-w-0 bg-secondary p-5 sm:p-7">
              <p className="text-xs font-bold tracking-[0.14em] text-muted-foreground">ESTIMATED TRADE OUTCOME</p>
              <h3 className="mt-2 text-xl font-black tracking-[-0.035em]">체결 기반 거래 추정치</h3>
              <div className="mt-5 grid grid-cols-2 gap-2">
                <MetricCard label="추정 실현손익" value={formatSignedMoney(analysis.tradeBehavior.estimatedRealizedProfitLoss, "KRW")} detail={`매칭 매도 ${analysis.tradeBehavior.matchedSellCount}건`} />
                <MetricCard label="추정 승률" value={metricPercent(analysis.tradeBehavior.estimatedWinRatePercent)} detail={`미매칭 매도 ${analysis.tradeBehavior.unmatchedSellCount}건`} />
                <MetricCard label="추정 Profit Factor" value={metricRatio(analysis.tradeBehavior.estimatedProfitFactor)} detail="총이익 ÷ 총손실" />
                <MetricCard label="추정 평균 보유기간" value={analysis.tradeBehavior.estimatedAverageHoldingDays === null ? "데이터 부족" : `${analysis.tradeBehavior.estimatedAverageHoldingDays.toFixed(1)}일`} detail="FIFO 수량 가중" />
                <MetricCard label="거래당 평균 금액" value={analysis.costEfficiency.averageTradeAmount === null ? "데이터 부족" : formatMoney(analysis.costEfficiency.averageTradeAmount, "KRW")} detail={`매수/매도 금액비 ${metricRatio(analysis.costEfficiency.buySellAmountRatio)}`} />
                <MetricCard label="비용 차감 전 추정" value={metricPercent(analysis.costEfficiency.grossEstimatedReturnPercent)} detail={`차감 후 ${metricPercent(analysis.metrics.estimatedReturnPercent)}`} />
              </div>
              <p className="mt-4 text-[10px] leading-4 text-muted-foreground">FIFO 체결 매칭 추정치입니다. 액면분할·합병·타사대체입출고·배당 원장이 없어 실제 실현손익과 다를 수 있습니다.</p>
            </Card>
          </div>

          <Card className="bg-secondary p-5 sm:p-7">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <p className="text-xs font-bold tracking-[0.14em] text-muted-foreground">DATA CONFIDENCE</p>
                <h3 className="mt-2 flex items-center gap-2 text-xl font-black tracking-[-0.035em]"><ShieldCheck className="size-5" />분석 데이터 신뢰도</h3>
              </div>
              <span className="rounded-full bg-card px-4 py-2 text-xs font-black">{analysis.dataQuality.confidence === "high" ? "높음" : analysis.dataQuality.confidence === "medium" ? "보통" : "제한적"}</span>
            </div>
            <div className="mt-5 grid grid-cols-2 gap-2 lg:grid-cols-4">
              <MetricCard label="수익률 관측" value={`${analysis.dataQuality.returnObservationDays.toLocaleString("ko-KR")}일`} detail={`예상 거래일 ${analysis.dataQuality.expectedReturnObservationDays.toLocaleString("ko-KR")}일 · 커버리지 ${formatPercent(analysis.dataQuality.returnCoveragePercent)}`} />
              <MetricCard label="종목 가격 커버리지" value={formatPercent(analysis.dataQuality.priceCoveragePercent)} detail={`누락 ${analysis.dataQuality.missingPriceObservations.toLocaleString("ko-KR")} / 필요 ${analysis.dataQuality.requiredPriceObservations.toLocaleString("ko-KR")}`} />
              <MetricCard label="환율 커버리지" value={formatPercent(analysis.dataQuality.fxCoveragePercent)} detail={`누락 ${analysis.dataQuality.missingFxObservations.toLocaleString("ko-KR")} / 필요 ${analysis.dataQuality.requiredFxObservations.toLocaleString("ko-KR")}`} />
              <MetricCard label="스냅샷 구성" value={`${analysis.dataQuality.liveSnapshotDays} 실제 · ${analysis.dataQuality.reconstructedSnapshotDays} 재구성`} detail={`과거수집 ${analysis.dataQuality.backfillStatus} · 실패 ${analysis.dataQuality.failedSymbols}종목`} />
            </div>
            {analysis.dataQuality.notes.length ? <div className="mt-4 rounded-[18px] bg-card px-4 py-3 text-xs leading-5 text-muted-foreground">{analysis.dataQuality.notes.map((note) => <p key={note}>{note}</p>)}</div> : null}
          </Card>

          <div className="flex items-start gap-2 rounded-[18px] bg-secondary px-4 py-3 text-xs leading-5 text-muted-foreground">
            <Info className="mt-0.5 size-4 shrink-0" />
            <p>토스 OpenAPI에는 계좌 입출금·예수금·배당 원장이 없습니다. TWR은 전일 보유비중과 종목·환율 수익률을 연결하고, XIRR은 기간 시작 보유주식 평가액을 최초 투자, 매수·매도 체결을 현금흐름, 종료 평가액을 회수금으로 간주해 계산합니다. 따라서 계좌 전체 수익률이 아닌 보유주식 투자 성과이며 미투자 현금과 실제 입출금·배당은 포함되지 않습니다.</p>
          </div>
        </>
      ) : null}
    </section>
  );
}
