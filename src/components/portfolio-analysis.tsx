import { useEffect, useMemo, useState } from "react";
import { AlertCircle, BarChart3, CalendarDays, CandlestickChart, Info, LoaderCircle, RefreshCw } from "lucide-react";
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
import { analysisPeriodChange, buildAnalysisChartData, type AnalysisChartPoint } from "@/lib/analysis-chart";
import {
  isValidCalendarRange,
  seoulDateString,
  shiftCalendarDate,
  type CalendarDateRange,
} from "@/lib/date-range";
import { formatMoney, formatPercent } from "@/lib/format";
import { cn } from "@/lib/utils";
import type {
  AnalysisRange,
  ApiError,
  BenchmarkKey,
  HistoryCurrency,
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
  { key: "KOSPI", label: "KOSPI", detail: "국내 지수", color: "#38bdf8" },
  { key: "KOSDAQ", label: "KOSDAQ", detail: "국내 지수", color: "#a78bfa" },
  { key: "NASDAQ100", label: "나스닥 100", detail: "QQQ 프록시", color: "#f59e0b" },
  { key: "SP500", label: "S&P 500", detail: "SPY 프록시", color: "#f472b6" },
];

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
  const rising = payload.close >= payload.open;
  const color = rising ? "#22c55e" : "#ef4444";
  const spread = payload.high - payload.low;
  const pixelsPerUnit = spread > 0 ? height / spread : 0;
  const bodyTop = spread > 0
    ? y + (payload.high - Math.max(payload.open, payload.close)) * pixelsPerUnit
    : y;
  const bodyBottom = spread > 0
    ? y + (payload.high - Math.min(payload.open, payload.close)) * pixelsPerUnit
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
  currency: HistoryCurrency;
  selectedBenchmarks: ReadonlySet<BenchmarkKey>;
};

function AnalysisTooltip({ active, label, payload, currency, selectedBenchmarks }: TooltipContentProps) {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;
  return (
    <div className="min-w-48 rounded-2xl bg-card p-4 text-xs shadow-2xl">
      <p className="font-black">{displayDate(String(label), true)}</p>
      <div className="mt-3 grid grid-cols-2 gap-x-5 gap-y-1.5 text-muted-foreground">
        <span>시가</span><strong className="text-right text-foreground">{formatMoney(point.open, currency)}</strong>
        <span>고가</span><strong className="text-right text-foreground">{formatMoney(point.high, currency)}</strong>
        <span>저가</span><strong className="text-right text-foreground">{formatMoney(point.low, currency)}</strong>
        <span>종가</span><strong className="text-right text-foreground">{formatMoney(point.close, currency)}</strong>
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

export function PortfolioAnalysisView({
  portfolio,
  onUnauthorized,
}: {
  portfolio: Portfolio;
  onUnauthorized: () => void;
}) {
  const today = useMemo(() => seoulDateString(), []);
  const [currency, setCurrency] = useState<HistoryCurrency>("KRW");
  const [period, setPeriod] = useState<AnalysisRange | "custom">("30d");
  const [draftDateRange, setDraftDateRange] = useState<CalendarDateRange>(() => presetRange("30d", today));
  const [customDateRange, setCustomDateRange] = useState<CalendarDateRange>();
  const [analysis, setAnalysis] = useState<PortfolioAnalysis>();
  const [selectedBenchmarks, setSelectedBenchmarks] = useState<Set<BenchmarkKey>>(
    () => new Set(["KOSPI", "NASDAQ100"]),
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({
      account: portfolio.selectedAccountId,
      currency,
      range: period === "custom" ? "all" : period,
      benchmarks: benchmarks.map((item) => item.key).join(","),
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
  }, [currency, customDateRange?.from, customDateRange?.to, onUnauthorized, period, portfolio.selectedAccountId, retryKey, today]);

  useEffect(() => {
    if (!analysis || analysis.ohlcBackfillComplete) return;
    const timer = window.setTimeout(() => setRetryKey((value) => value + 1), 10_000);
    return () => window.clearTimeout(timer);
  }, [analysis]);

  const chartData = useMemo(() => analysis ? buildAnalysisChartData(analysis) : [], [analysis]);
  const change = analysisPeriodChange(chartData);
  const latest = chartData.at(-1);
  const high = chartData.length ? Math.max(...chartData.map((point) => point.high)) : 0;
  const low = chartData.length ? Math.min(...chartData.map((point) => point.low)) : 0;
  const canApplyDateRange = isValidCalendarRange(draftDateRange, today);

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
              종목별 일봉과 해당일 보유수량으로 재구성한 {currency} 전체 평가금 추정 OHLC입니다.
            </p>
          </div>

          <div className="w-full xl:w-[560px]">
            <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
              <div className="flex rounded-full bg-card p-1" aria-label="분석 통화 선택">
                {(["KRW", "USD"] as const).map((item) => (
                  <button
                    key={item}
                    type="button"
                    aria-pressed={currency === item}
                    onClick={() => setCurrency(item)}
                    className={cn(
                      "rounded-full px-3 py-2 text-[11px] font-black transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      currency === item ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {item === "KRW" ? "KRW · 국내" : "USD · 해외/과거"}
                  </button>
                ))}
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

        {!loading && !error && chartData.length ? (
          <div className="mt-5 grid grid-cols-2 gap-2 lg:grid-cols-4" aria-label="평가금 일봉 요약">
            {[
              ["최근 종가", formatMoney(latest?.close ?? 0, currency)],
              ["기간 평가금 변화", formatPercent(change, true)],
              ["기간 추정 고가", formatMoney(high, currency)],
              ["기간 추정 저가", formatMoney(low, currency)],
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
            <div><BarChart3 className="mx-auto size-7 text-muted-foreground" /><p className="mt-4 text-base font-black">선택 기간에 평가금 일봉이 없습니다.</p><p className="mt-2 text-sm text-muted-foreground">다른 통화 또는 더 긴 기간을 선택해 주세요.</p></div>
          </div>
        ) : (
          <div className="mt-7 h-[420px] w-full sm:h-[520px]" aria-label="포트폴리오 평가금 일봉과 비교 지수 차트">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={chartData} margin={{ top: 12, right: 4, bottom: 4, left: 0 }}>
                <CartesianGrid vertical={false} stroke="hsl(var(--chart-grid))" strokeDasharray="3 5" />
                <XAxis dataKey="date" tickFormatter={(value) => displayDate(String(value))} axisLine={false} tickLine={false} minTickGap={34} tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11, fontWeight: 600 }} />
                <YAxis yAxisId="portfolio" domain={["auto", "auto"]} tickFormatter={(value) => formatMoney(Number(value), currency, true)} axisLine={false} tickLine={false} width={66} tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10, fontWeight: 600 }} />
                <YAxis yAxisId="benchmark" orientation="right" domain={["auto", "auto"]} tickFormatter={(value) => `${Number(value).toFixed(0)}%`} axisLine={false} tickLine={false} width={42} tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10, fontWeight: 600 }} />
                <Tooltip content={(props) => <AnalysisTooltip {...props} currency={currency} selectedBenchmarks={selectedBenchmarks} />} cursor={{ fill: "hsl(var(--foreground) / 0.04)" }} />
                <Bar yAxisId="portfolio" dataKey="candleRange" shape={CandleShape} isAnimationActive={false} maxBarSize={12} />
                {benchmarks.filter((item) => selectedBenchmarks.has(item.key)).map((item) => (
                  <Line
                    key={item.key}
                    yAxisId="benchmark"
                    type="monotone"
                    dataKey={(point: AnalysisChartPoint) => point.benchmarkValues[item.key]}
                    name={item.label}
                    stroke={item.color}
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
    </section>
  );
}
