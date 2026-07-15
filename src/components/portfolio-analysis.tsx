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
import { ReportGenerateButton } from "@/components/report-generate-button";
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
  const rising = payload.normalizedClose >= payload.normalizedOpen;
  const color = rising ? "#22c55e" : "#ef4444";
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
      <p className="mt-2 truncate text-xl font-black tracking-[-0.035em]">{value}</p>
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({
      account: portfolio.selectedAccountId,
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
  }, [customDateRange?.from, customDateRange?.to, onUnauthorized, period, portfolio.selectedAccountId, retryKey, today]);

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
              국내·해외 종목을 일별 USD/KRW 환율로 원화 환산해 한 번에 재구성한 전체 평가금 추정 OHLC입니다.
            </p>
            <p className="mt-1 text-xs font-bold text-muted-foreground">포트폴리오와 비교 지수는 기준일 종가를 0%로 맞춰 같은 지점에서 시작합니다.</p>
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

          <div className="grid gap-3 xl:grid-cols-[1.35fr_1fr]">
            <Card className="bg-secondary p-5 sm:p-7">
              <p className="text-xs font-bold tracking-[0.14em] text-muted-foreground">RISK</p>
              <h3 className="mt-2 text-xl font-black tracking-[-0.035em]">위험 대비 성과</h3>
              <div className="mt-5 grid grid-cols-2 gap-2 lg:grid-cols-3">
                <MetricCard label="연환산 변동성" value={metricPercent(analysis.metrics.annualizedVolatilityPercent)} detail="일별 추정수익률 표준편차" />
                <MetricCard label="최대 낙폭 MDD" value={metricPercent(analysis.metrics.maxDrawdownPercent)} detail={`최장 낙폭 ${analysis.metrics.maxDrawdownDays ?? 0}일`} />
                <MetricCard label="현재 낙폭" value={metricPercent(analysis.metrics.currentDrawdownPercent)} detail="최근 고점 대비" />
                <MetricCard label="샤프지수" value={metricRatio(analysis.metrics.sharpeRatio)} detail="무위험수익률 0% 가정" />
                <MetricCard label="소르티노지수" value={metricRatio(analysis.metrics.sortinoRatio)} detail="하방 변동성만 위험으로 반영" />
                <MetricCard label="Calmar 비율" value={metricRatio(analysis.metrics.calmarRatio)} detail="연환산 수익률 ÷ MDD" />
                <MetricCard label="최고 일간수익률" value={metricPercent(analysis.metrics.bestDailyReturnPercent)} detail="전일 보유비중 기준" />
                <MetricCard label="최저 일간수익률" value={metricPercent(analysis.metrics.worstDailyReturnPercent)} detail="전일 보유비중 기준" />
                <MetricCard label="상승일 비율" value={metricPercent(analysis.metrics.positiveDaysPercent)} detail="수익률이 0%보다 높은 거래일" />
              </div>
            </Card>

            <Card className="bg-secondary p-5 sm:p-7">
              <p className="text-xs font-bold tracking-[0.14em] text-muted-foreground">DIVERSIFICATION & COST</p>
              <h3 className="mt-2 text-xl font-black tracking-[-0.035em]">집중도와 거래 비용</h3>
              <div className="mt-5 grid grid-cols-2 gap-2">
                <MetricCard label="상위 3종목 비중" value={formatPercent(analysis.metrics.top3WeightPercent)} detail="기간 마지막 평가일 기준" />
                <MetricCard label="유효 종목 수" value={`${analysis.metrics.effectivePositions.toFixed(1)}개`} detail={`HHI ${analysis.metrics.hhi.toFixed(3)}`} />
                <MetricCard label="회전율" value={formatPercent(analysis.metrics.turnoverPercent)} detail={`체결 ${analysis.metrics.tradeCount.toLocaleString("ko-KR")}건`} />
                <MetricCard label="수수료 · 세금" value={formatMoney(analysis.metrics.commission + analysis.metrics.tax, "KRW")} detail={`수수료 ${formatMoney(analysis.metrics.commission, "KRW")} · 세금 ${formatMoney(analysis.metrics.tax, "KRW")}`} />
              </div>
            </Card>
          </div>

          <Card className="bg-secondary p-5 sm:p-7">
            <p className="text-xs font-bold tracking-[0.14em] text-muted-foreground">CONTRIBUTION</p>
            <h3 className="mt-2 text-xl font-black tracking-[-0.035em]">종목별 추정 성과 기여도</h3>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">기간 시작·종료 평가금과 기간 중 체결 순액으로 계산한 상위 기여 종목입니다.</p>
            {analysis.contributions.length ? (
              <div className="mt-6 space-y-4">
                {analysis.contributions.map((item) => {
                  const maximum = Math.max(...analysis.contributions.map((candidate) => Math.abs(candidate.estimatedProfitLoss)), 1);
                  const positive = item.estimatedProfitLoss >= 0;
                  return (
                    <div key={`${item.currency}:${item.key}`} className="grid gap-2 sm:grid-cols-[minmax(130px,0.8fr)_minmax(180px,2fr)_auto] sm:items-center">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-black">{item.name}</p>
                        <p className="text-[10px] font-bold text-muted-foreground">{item.market} · {item.symbol}</p>
                      </div>
                      <div className="h-2.5 overflow-hidden rounded-full bg-card">
                        <div className={cn("h-full rounded-full", positive ? "bg-emerald-300 dark:bg-emerald-300" : "bg-rose-300 dark:bg-rose-300")} style={{ width: `${Math.max(3, (Math.abs(item.estimatedProfitLoss) / maximum) * 100)}%` }} />
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

          <div className="flex items-start gap-2 rounded-[18px] bg-secondary px-4 py-3 text-xs leading-5 text-muted-foreground">
            <Info className="mt-0.5 size-4 shrink-0" />
            <p>토스 OpenAPI에는 계좌 입출금·예수금·배당 원장이 없습니다. TWR은 전일 보유비중과 종목·환율 수익률을 연결하고, XIRR은 기간 시작 보유주식 평가액을 최초 투자, 매수·매도 체결을 현금흐름, 종료 평가액을 회수금으로 간주해 계산합니다. 따라서 계좌 전체 수익률이 아닌 보유주식 투자 성과이며 미투자 현금과 실제 입출금·배당은 포함되지 않습니다.</p>
          </div>
        </>
      ) : null}
    </section>
  );
}
