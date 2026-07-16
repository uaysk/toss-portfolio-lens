import { useEffect, useMemo, useState } from "react";
import {
  BarChart3,
  CalendarDays,
  CheckCircle2,
  CircleAlert,
  FileChartColumn,
  Info,
  Lightbulb,
  LoaderCircle,
  ShieldAlert,
  Target,
} from "lucide-react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Logo } from "@/components/logo";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { analysisComparisonDomain, buildAnalysisChartData } from "@/lib/analysis-chart";
import { correlationAssetLabel, correlationCellStyle } from "@/lib/correlation-labels";
import { formatMoney, formatPercent, formatSignedMoney } from "@/lib/format";
import { cn } from "@/lib/utils";
import type {
  AnalysisReport,
  ApiError,
  BacktestReport,
  BenchmarkKey,
  ReportNarrative,
  StoredReport,
  Theme,
} from "@/types";

const benchmarkStyle: Record<BenchmarkKey, { label: string; color: string }> = {
  KOSPI: { label: "KOSPI", color: "#38bdf8" },
  KOSDAQ: { label: "KOSDAQ", color: "#a78bfa" },
  NASDAQ100: { label: "나스닥 100", color: "#f59e0b" },
  SP500: { label: "S&P 500", color: "#f472b6" },
};

function displayDate(value: string): string {
  const date = new Date(`${value}T00:00:00+09:00`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ko-KR", { year: "numeric", month: "short", day: "numeric" }).format(date);
}

function displayDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function shortDate(value: string): string {
  return value.slice(2).replaceAll("-", ".");
}

function ratio(value: number | null | undefined): string {
  return value === null || value === undefined ? "데이터 부족" : value.toFixed(2);
}

function percent(value: number | null | undefined): string {
  return value === null || value === undefined ? "데이터 부족" : formatPercent(value, true);
}

function ReportMetric({ label, value, detail, benchmark }: {
  label: string;
  value: string;
  detail?: string;
  benchmark?: { name: string; value: string; detail?: string };
}) {
  return (
    <div className="min-w-0 rounded-[20px] bg-card p-4 sm:p-5">
      <p className="text-[10px] font-black tracking-[0.08em] text-muted-foreground">{label}</p>
      <p className="mt-3 truncate text-xl font-black tracking-[-0.04em]">{value}</p>
      {benchmark ? (
        <div className="mt-3 rounded-[14px] bg-secondary px-3 py-2.5">
          <p className="truncate text-[9px] font-black tracking-[0.08em] text-muted-foreground">벤치마크 · {benchmark.name}</p>
          <p className="mt-1 text-sm font-black">{benchmark.value}</p>
          {benchmark.detail ? <p className="mt-1 text-[9px] text-muted-foreground">{benchmark.detail}</p> : null}
        </div>
      ) : null}
      {detail ? <p className="mt-2 text-[11px] leading-5 text-muted-foreground">{detail}</p> : null}
    </div>
  );
}

function SectionHeading({ eyebrow, title, detail }: { eyebrow: string; title: string; detail?: string }) {
  return (
    <div>
      <p className="text-[10px] font-black tracking-[0.16em] text-muted-foreground">{eyebrow}</p>
      <h2 className="mt-2 text-xl font-black tracking-[-0.04em] sm:text-2xl">{title}</h2>
      {detail ? <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">{detail}</p> : null}
    </div>
  );
}

function NarrativePanel({ narrative }: { narrative: ReportNarrative }) {
  const sections = [
    { title: "강점", icon: CheckCircle2, items: narrative.strengths },
    { title: "위험 요인", icon: ShieldAlert, items: narrative.risks },
    { title: "점검 항목", icon: Lightbulb, items: narrative.actions },
  ];
  return (
    <>
      <Card className="bg-secondary p-5 sm:p-7">
        <SectionHeading eyebrow="AI ASSESSMENT" title="수치 기반 종합 평가" detail="보고서에 저장된 지표만을 근거로 생성한 평가입니다." />
        <p className="mt-5 rounded-[22px] bg-card p-5 text-sm font-semibold leading-7 sm:p-6 sm:text-base">{narrative.summary}</p>
        <div className="mt-3 grid gap-3 lg:grid-cols-3">
          {sections.map(({ title, icon: Icon, items }) => (
            <div key={title} className="rounded-[22px] bg-card p-5">
              <div className="flex items-center gap-2">
                <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
                <h3 className="text-sm font-black">{title}</h3>
              </div>
              <ol className="mt-4 space-y-3">
                {items.map((item, index) => (
                  <li key={item} className="grid grid-cols-[22px_1fr] gap-2 text-xs leading-5 text-muted-foreground">
                    <span className="grid size-[22px] place-items-center rounded-full bg-secondary text-[10px] font-black text-foreground">{index + 1}</span>
                    <span>{item}</span>
                  </li>
                ))}
              </ol>
            </div>
          ))}
        </div>
      </Card>
    </>
  );
}

function AnalysisReportContent({ report }: { report: AnalysisReport }) {
  const [chartMode, setChartMode] = useState<"relative" | "value">("relative");
  const analysis = report.data;
  const chartData = useMemo(() => buildAnalysisChartData(analysis), [analysis]);
  const benchmarkKeys = useMemo(() => new Set(analysis.benchmarks.map((item) => item.key)), [analysis.benchmarks]);
  const domain = useMemo(() => analysisComparisonDomain(chartData, benchmarkKeys), [benchmarkKeys, chartData]);
  const metrics = analysis.metrics;
  const maximumContribution = Math.max(...analysis.contributions.map((item) => Math.abs(item.estimatedProfitLoss)), 1);
  return (
    <>
      <Card className="bg-secondary p-5 sm:p-7">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <SectionHeading
            eyebrow="PERFORMANCE PATH"
            title="포트폴리오와 시장 흐름"
            detail="상대 성과는 포트폴리오와 지수의 첫 공통 시점을 0%로 맞춰 비교합니다."
          />
          <div className="inline-flex w-fit rounded-full bg-card p-1">
            <Button size="sm" aria-pressed={chartMode === "relative"} variant={chartMode === "relative" ? "default" : "ghost"} onClick={() => setChartMode("relative")}>상대 성과</Button>
            <Button size="sm" aria-pressed={chartMode === "value"} variant={chartMode === "value" ? "default" : "ghost"} onClick={() => setChartMode("value")}>평가금</Button>
          </div>
        </div>
        <div className="mt-6 h-[360px] min-w-0 sm:h-[480px]">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData} margin={{ top: 10, right: 8, left: 0, bottom: 4 }}>
              <CartesianGrid vertical={false} stroke="hsl(var(--chart-grid))" strokeDasharray="3 7" />
              <XAxis dataKey="date" tickFormatter={shortDate} minTickGap={42} tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
              <YAxis
                domain={chartMode === "relative" ? domain : ["auto", "auto"]}
                tickFormatter={(value) => chartMode === "relative" ? `${Number(value).toFixed(0)}%` : formatMoney(Number(value), "KRW", true)}
                width={62}
                tickLine={false}
                axisLine={false}
                tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
              />
              <Tooltip
                labelFormatter={(value) => displayDate(String(value))}
                formatter={(value, name) => [
                  chartMode === "relative" ? formatPercent(Number(value), true) : formatMoney(Number(value), "KRW"),
                  String(name),
                ]}
                contentStyle={{ border: 0, borderRadius: 16, background: "hsl(var(--card))", color: "hsl(var(--foreground))" }}
              />
              <Line
                type="monotone"
                dataKey={chartMode === "relative" ? "normalizedClose" : "close"}
                name="포트폴리오"
                stroke="hsl(var(--foreground))"
                strokeWidth={2.8}
                dot={false}
                activeDot={{ r: 4, strokeWidth: 0 }}
              />
              {chartMode === "relative" ? analysis.benchmarks.map((benchmark) => (
                <Line
                  key={benchmark.key}
                  type="monotone"
                  dataKey={`benchmarkValues.${benchmark.key}`}
                  name={benchmarkStyle[benchmark.key].label}
                  stroke={benchmarkStyle[benchmark.key].color}
                  strokeWidth={1.8}
                  dot={false}
                  activeDot={{ r: 3, strokeWidth: 0 }}
                />
              )) : null}
            </LineChart>
          </ResponsiveContainer>
        </div>
        <div className="mt-4 flex flex-wrap gap-4 text-[11px] font-bold text-muted-foreground">
          <span className="flex items-center gap-2"><i className="h-0.5 w-5 bg-foreground" />포트폴리오</span>
          {chartMode === "relative" ? analysis.benchmarks.map((benchmark) => (
            <span key={benchmark.key} className="flex items-center gap-2"><i className="h-0.5 w-5" style={{ backgroundColor: benchmarkStyle[benchmark.key].color }} />{benchmarkStyle[benchmark.key].label}</span>
          )) : null}
        </div>
      </Card>

      <Card className="bg-secondary p-5 sm:p-7">
        <SectionHeading eyebrow="KEY METRICS" title="성과와 위험 지표" />
        <div className="mt-5 grid grid-cols-2 gap-2 lg:grid-cols-3 2xl:grid-cols-4">
          <ReportMetric label="보유주식 TWR" value={percent(metrics.timeWeightedReturnPercent)} detail="입출금 영향 제거 추정" />
          <ReportMetric label="보유주식 XIRR" value={percent(metrics.moneyWeightedReturnPercent)} detail="체결 현금흐름 기반 추정" />
          <ReportMetric label="연환산 수익률" value={percent(metrics.annualizedReturnPercent)} />
          <ReportMetric label="연환산 변동성" value={percent(metrics.annualizedVolatilityPercent)} />
          <ReportMetric label="최대 낙폭 MDD" value={percent(metrics.maxDrawdownPercent)} detail={`최장 ${metrics.maxDrawdownDays ?? 0}일`} />
          <ReportMetric label="현재 낙폭" value={percent(metrics.currentDrawdownPercent)} />
          <ReportMetric label="샤프지수" value={ratio(metrics.sharpeRatio)} detail="무위험수익률 0%" />
          <ReportMetric label="소르티노지수" value={ratio(metrics.sortinoRatio)} />
          <ReportMetric label="CALMAR" value={ratio(metrics.calmarRatio)} />
          <ReportMetric label="상위 3종목 비중" value={formatPercent(metrics.top3WeightPercent)} />
          <ReportMetric label="유효 종목 수" value={`${metrics.effectivePositions.toFixed(1)}개`} detail={`HHI ${metrics.hhi.toFixed(3)}`} />
          <ReportMetric label="회전율" value={formatPercent(metrics.turnoverPercent)} detail={`체결 ${metrics.tradeCount.toLocaleString("ko-KR")}건`} />
        </div>
      </Card>

      <div className="grid gap-3 xl:grid-cols-[0.8fr_1.2fr]">
        <Card className="bg-secondary p-5 sm:p-7">
          <SectionHeading eyebrow="BENCHMARK" title="시장 대비 성과" />
          <div className="mt-5 space-y-2">
            {analysis.benchmarks.map((benchmark) => (
              <div key={benchmark.key} className="rounded-[18px] bg-card p-4">
                <div className="flex items-center justify-between gap-4">
                  <span className="flex items-center gap-2 text-xs font-black"><i className="size-2.5 rounded-full" style={{ backgroundColor: benchmarkStyle[benchmark.key].color }} />{benchmark.name}</span>
                  <strong className="text-sm">{percent(metrics.benchmarkReturns[benchmark.key])}</strong>
                </div>
                <p className="mt-2 text-[11px] text-muted-foreground">포트폴리오 초과성과 <strong className="text-foreground">{percent(metrics.excessReturns[benchmark.key])}</strong></p>
              </div>
            ))}
            {!analysis.benchmarks.length ? <p className="rounded-[18px] bg-card p-4 text-xs text-muted-foreground">비교 지수를 선택하지 않았습니다.</p> : null}
          </div>
        </Card>

        <Card className="bg-secondary p-5 sm:p-7">
          <SectionHeading eyebrow="ATTRIBUTION" title="종목별 추정 성과 기여" detail="기여값이 큰 순서로 표시하며 음수 기여는 아래쪽에 배치됩니다." />
          <div className="mt-5 space-y-3">
            {analysis.contributions.map((item) => (
              <div key={`${item.currency}:${item.key}`} className="grid gap-2 rounded-[18px] bg-card p-4 sm:grid-cols-[minmax(120px,0.8fr)_minmax(130px,1.2fr)_auto] sm:items-center">
                <div className="min-w-0">
                  <p className="truncate text-xs font-black">{item.name}</p>
                  <p className="mt-1 text-[10px] text-muted-foreground">{item.market} · {item.symbol}</p>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-secondary">
                  <div
                    className={cn("h-full rounded-full", item.estimatedProfitLoss >= 0 ? "bg-emerald-400" : "bg-rose-400")}
                    style={{ width: `${Math.max(3, Math.abs(item.estimatedProfitLoss) / maximumContribution * 100)}%` }}
                  />
                </div>
                <div className="sm:text-right">
                  <p className="text-xs font-black">{formatSignedMoney(item.estimatedProfitLoss, "KRW")}</p>
                  <p className="mt-1 text-[10px] text-muted-foreground">{formatPercent(item.contributionPercent, true)}</p>
                </div>
              </div>
            ))}
            {!analysis.contributions.length ? <p className="rounded-[18px] bg-card p-4 text-xs text-muted-foreground">계산 가능한 기여 내역이 없습니다.</p> : null}
          </div>
        </Card>
      </div>

      <Card className="bg-secondary p-5 sm:p-7">
        <SectionHeading eyebrow="COST & CASH FLOW" title="추정 손익과 거래 비용" />
        <div className="mt-5 grid grid-cols-2 gap-2 lg:grid-cols-4">
          <ReportMetric label="기간 추정 손익" value={formatSignedMoney(metrics.estimatedProfitLoss, "KRW")} />
          <ReportMetric label="순투자 추정" value={formatMoney(metrics.netInvestedAmount, "KRW")} />
          <ReportMetric label="매수 · 매도" value={`${formatMoney(metrics.totalBuyAmount, "KRW", true)} · ${formatMoney(metrics.totalSellAmount, "KRW", true)}`} />
          <ReportMetric label="수수료 · 세금" value={formatMoney(metrics.commission + metrics.tax, "KRW")} />
        </div>
      </Card>
    </>
  );
}

function BacktestReportContent({ report }: { report: BacktestReport }) {
  const [chartMode, setChartMode] = useState<"growth" | "drawdown">("growth");
  const result = report.data;
  const metrics = result.metrics;
  return (
    <>
      <Card className="bg-secondary p-5 sm:p-7">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <SectionHeading eyebrow="SIMULATION PATH" title="백테스트 성과 경로" detail={`${result.config.rebalanceFrequency} 리밸런싱 · ${result.currencyMethod} 통화 방식`} />
          <div className="inline-flex w-fit rounded-full bg-card p-1">
            <Button size="sm" aria-pressed={chartMode === "growth"} variant={chartMode === "growth" ? "default" : "ghost"} onClick={() => setChartMode("growth")}>성장</Button>
            <Button size="sm" aria-pressed={chartMode === "drawdown"} variant={chartMode === "drawdown" ? "default" : "ghost"} onClick={() => setChartMode("drawdown")}>낙폭</Button>
          </div>
        </div>
        <div className="mt-6 h-[360px] min-w-0 sm:h-[480px]">
          <ResponsiveContainer width="100%" height="100%">
            {chartMode === "growth" ? (
              <LineChart data={result.points} margin={{ top: 10, right: 8, left: 0, bottom: 4 }}>
                <CartesianGrid vertical={false} stroke="hsl(var(--chart-grid))" strokeDasharray="3 7" />
                <XAxis dataKey="date" tickFormatter={shortDate} minTickGap={42} tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
                <YAxis tickFormatter={(value) => formatMoney(Number(value), "KRW", true)} width={64} tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
                <Tooltip labelFormatter={(value) => displayDate(String(value))} formatter={(value, name) => [formatMoney(Number(value), "KRW"), name === "growth" ? "포트폴리오" : result.benchmark?.name || "비교 지수"]} contentStyle={{ border: 0, borderRadius: 16, background: "hsl(var(--card))", color: "hsl(var(--foreground))" }} />
                <Line type="monotone" dataKey="growth" name="growth" stroke="hsl(var(--foreground))" strokeWidth={2.8} dot={false} activeDot={{ r: 4, strokeWidth: 0 }} />
                {result.benchmark ? <Line type="monotone" dataKey="benchmarkGrowth" name="benchmark" stroke="#f59e0b" strokeWidth={2} dot={false} activeDot={{ r: 3, strokeWidth: 0 }} /> : null}
              </LineChart>
            ) : (
              <AreaChart data={result.points} margin={{ top: 10, right: 8, left: 0, bottom: 4 }}>
                <CartesianGrid vertical={false} stroke="hsl(var(--chart-grid))" strokeDasharray="3 7" />
                <XAxis dataKey="date" tickFormatter={shortDate} minTickGap={42} tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
                <YAxis tickFormatter={(value) => `${Number(value).toFixed(0)}%`} width={46} tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
                <Tooltip labelFormatter={(value) => displayDate(String(value))} formatter={(value) => [formatPercent(Number(value), true), "낙폭"]} contentStyle={{ border: 0, borderRadius: 16, background: "hsl(var(--card))", color: "hsl(var(--foreground))" }} />
                <Area type="monotone" dataKey="drawdownPercent" stroke="none" fill="#fb7185" fillOpacity={0.58} activeDot={{ r: 3, strokeWidth: 0 }} />
              </AreaChart>
            )}
          </ResponsiveContainer>
        </div>
      </Card>

      <Card className="bg-secondary p-5 sm:p-7">
        <SectionHeading eyebrow="KEY METRICS" title="성과와 위험 지표" />
        <div className="mt-5 grid grid-cols-2 gap-2 lg:grid-cols-3 2xl:grid-cols-4">
          <ReportMetric label="누적 TWR" value={percent(metrics.totalReturnPercent)} benchmark={result.benchmark && result.benchmarkMetrics ? { name: result.benchmark.name, value: percent(result.benchmarkMetrics.totalReturnPercent) } : undefined} />
          <ReportMetric label="CAGR" value={percent(metrics.cagrPercent)} benchmark={result.benchmark && result.benchmarkMetrics ? { name: result.benchmark.name, value: percent(result.benchmarkMetrics.cagrPercent) } : undefined} />
          <ReportMetric label="최종 잔액" value={formatMoney(metrics.finalBalance, "KRW")} />
          <ReportMetric label="연환산 변동성" value={percent(metrics.annualizedVolatilityPercent)} benchmark={result.benchmark && result.benchmarkMetrics ? { name: result.benchmark.name, value: percent(result.benchmarkMetrics.annualizedVolatilityPercent) } : undefined} />
          <ReportMetric label="최대 낙폭 MDD" value={percent(metrics.maxDrawdownPercent)} detail={`최장 ${metrics.maxDrawdownDays}일`} benchmark={result.benchmark && result.benchmarkMetrics ? { name: result.benchmark.name, value: percent(result.benchmarkMetrics.maxDrawdownPercent), detail: `최장 ${result.benchmarkMetrics.maxDrawdownDays}일` } : undefined} />
          <ReportMetric label="샤프지수" value={ratio(metrics.sharpeRatio)} benchmark={result.benchmark && result.benchmarkMetrics ? { name: result.benchmark.name, value: ratio(result.benchmarkMetrics.sharpeRatio) } : undefined} />
          <ReportMetric label="소르티노지수" value={ratio(metrics.sortinoRatio)} benchmark={result.benchmark && result.benchmarkMetrics ? { name: result.benchmark.name, value: ratio(result.benchmarkMetrics.sortinoRatio) } : undefined} />
          <ReportMetric label="상승 월 비율" value={percent(metrics.positiveMonthsPercent)} benchmark={result.benchmark && result.benchmarkMetrics ? { name: result.benchmark.name, value: percent(result.benchmarkMetrics.positiveMonthsPercent) } : undefined} />
        </div>
      </Card>

      <div className="grid gap-3 xl:grid-cols-[0.8fr_1.2fr]">
        <Card className="bg-secondary p-5 sm:p-7">
          <SectionHeading eyebrow="ANNUAL RETURNS" title="연도별 수익률" />
          <div className="mt-5 h-[340px] min-w-0">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={result.annualReturns} margin={{ top: 8, right: 8, left: 0, bottom: 4 }}>
                <CartesianGrid vertical={false} stroke="hsl(var(--chart-grid))" strokeDasharray="3 7" />
                <XAxis dataKey="year" tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
                <YAxis tickFormatter={(value) => `${Number(value).toFixed(0)}%`} width={44} tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
                <Tooltip formatter={(value) => [formatPercent(Number(value), true), "수익률"]} contentStyle={{ border: 0, borderRadius: 16, background: "hsl(var(--card))", color: "hsl(var(--foreground))" }} />
                <Bar dataKey="returnPercent" fill="hsl(var(--foreground))" radius={[6, 6, 2, 2]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card className="bg-secondary p-5 sm:p-7">
          <SectionHeading eyebrow="ATTRIBUTION" title="종목 구성과 성과 기여" />
          <div className="mt-5 space-y-3">
            {result.contributions.map((item) => (
              <div key={`${item.currency}:${item.symbol}`} className="grid gap-2 rounded-[18px] bg-card p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                <div className="min-w-0">
                  <div className="flex items-center gap-2"><p className="truncate text-xs font-black">{item.name}</p><span className="rounded-full bg-secondary px-2 py-1 text-[9px] font-black text-muted-foreground">{item.weight.toFixed(1)}%</span></div>
                  <p className="mt-1 text-[10px] text-muted-foreground">{item.market} · {item.symbol} · 종목 수익 {formatPercent(item.assetReturnPercent, true)}</p>
                </div>
                <div className="sm:text-right">
                  <p className="text-xs font-black">{formatSignedMoney(item.profitLoss, "KRW")}</p>
                  <p className="mt-1 text-[10px] text-muted-foreground">기여 {formatPercent(item.contributionPercent, true)}</p>
                </div>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <Card className="bg-secondary p-5 sm:p-7">
        <SectionHeading eyebrow="CORRELATION" title="일간 수익률 상관관계" detail="1에 가까울수록 같은 방향, -1에 가까울수록 반대 방향으로 움직인 구간이 많습니다." />
        <div className="mt-5 overflow-x-auto rounded-[20px] bg-card p-3">
          <table className="w-full min-w-[520px] border-separate border-spacing-1 text-center text-xs">
            <thead>
              <tr>
                <th scope="col" className="p-2 text-left text-muted-foreground">종목명</th>
                {result.correlations.assets.map((asset) => (
                  <th
                    key={asset.symbol}
                    scope="col"
                    title={asset.symbol}
                    className="min-w-[104px] max-w-[140px] p-2 align-bottom font-black"
                  >
                    <span className="block whitespace-normal break-keep leading-4">
                      {correlationAssetLabel(asset)}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.correlations.assets.map((asset, row) => (
                <tr key={asset.symbol}>
                  <th scope="row" title={asset.symbol} className="max-w-[170px] truncate p-2 text-left font-black">
                    {correlationAssetLabel(asset)}
                  </th>
                  {result.correlations.values[row].map((value, column) => (
                    <td key={`${asset.symbol}:${column}`} className="rounded-xl p-3 font-black" style={correlationCellStyle(value)}>{value === null ? "-" : value.toFixed(2)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}

function ReportDocument({ report, theme, onToggleTheme }: { report: StoredReport; theme: Theme; onToggleTheme: () => void }) {
  const stance = {
    strong: "견조",
    balanced: "균형",
    cautious: "주의",
    "high-risk": "고위험",
  }[report.narrative.stance];
  return (
    <main className="min-h-screen bg-[var(--shell)] px-2 py-2 sm:px-3 sm:py-3">
      <div className="mx-auto max-w-[1540px] rounded-[26px] bg-[var(--panel)] px-4 py-5 sm:rounded-[30px] sm:px-8 sm:py-8 lg:px-12">
        <header className="flex items-center justify-between gap-4">
          <Logo />
          <ThemeToggle theme={theme} onToggle={onToggleTheme} />
        </header>

        <section className="mt-7 overflow-hidden rounded-[30px] bg-[#111] p-6 text-white sm:p-9 lg:p-12">
          <div className="grid gap-9 lg:grid-cols-[minmax(0,1fr)_300px] lg:items-end">
            <div>
              <div className="flex flex-wrap items-center gap-2 text-[10px] font-black tracking-[0.14em] text-white/55">
                <span>PORTFOLIO LENS REPORT</span><span>·</span><span>TEMPLATE 01</span><span>·</span><span>{report.kind === "analysis" ? "ACTUAL PORTFOLIO" : "BACKTEST"}</span>
              </div>
              <h1 className="mt-5 break-keep text-3xl font-black tracking-[-0.055em] sm:text-5xl">{report.title}</h1>
              <div className="mt-5 flex flex-wrap gap-x-5 gap-y-2 text-xs font-bold text-white/65">
                <span className="flex items-center gap-2"><CalendarDays className="size-4" />{displayDate(report.period.from)} ~ {displayDate(report.period.to)}</span>
                <span className="flex items-center gap-2"><FileChartColumn className="size-4" />{displayDateTime(report.createdAt)} 생성</span>
              </div>
            </div>
            <div className="rounded-[24px] bg-white/10 p-5">
              <div className="flex items-end justify-between gap-3"><p className="text-xs font-bold text-white/60">종합 평가 점수</p><p className="text-sm font-black">{stance}</p></div>
              <p className="mt-3 text-5xl font-black tracking-[-0.06em]">{report.narrative.score}<span className="ml-1 text-lg text-white/45">/100</span></p>
              <div className="mt-4 h-2 overflow-hidden rounded-full bg-white/15"><div className="h-full rounded-full bg-white" style={{ width: `${report.narrative.score}%` }} /></div>
            </div>
          </div>
        </section>

        <div className="mt-3 space-y-3">
          <NarrativePanel narrative={report.narrative} />
          {report.kind === "analysis" ? <AnalysisReportContent report={report} /> : <BacktestReportContent report={report} />}

          <Card className="bg-secondary p-5 sm:p-7">
            <div className="grid gap-5 lg:grid-cols-[1fr_1fr]">
              <div className="flex items-start gap-3 rounded-[20px] bg-card p-5">
                <Target className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
                <div><p className="text-xs font-black">AI 평가 방법</p><p className="mt-2 text-xs leading-6 text-muted-foreground">{report.narrative.methodology}</p></div>
              </div>
              <div className="flex items-start gap-3 rounded-[20px] bg-card p-5">
                <Info className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
                <div><p className="text-xs font-black">이용 안내</p><p className="mt-2 text-xs leading-6 text-muted-foreground">이 보고서는 조회·분석용이며 투자 자문이나 주문 지시가 아닙니다. 추정값과 백테스트 결과는 실제 계좌 수익 및 미래 성과와 다를 수 있습니다.</p></div>
              </div>
            </div>
          </Card>
        </div>

        <footer className="flex flex-col gap-2 px-2 pb-2 pt-8 text-[10px] font-bold text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <span>Portfolio Lens · 고정 보고서 템플릿 {report.templateVersion}</span>
          <span>Report ID {report.id}</span>
        </footer>
      </div>
    </main>
  );
}

function ReportMessage({ title, detail, icon: Icon }: { title: string; detail: string; icon: typeof CircleAlert }) {
  return (
    <div className="text-center">
      <Icon className="mx-auto size-7 text-muted-foreground" />
      <h1 className="mt-5 text-xl font-black">{title}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{detail}</p>
    </div>
  );
}

export function ReportPage({ reportId, theme, onToggleTheme }: { reportId?: string; theme: Theme; onToggleTheme: () => void }) {
  const [report, setReport] = useState<StoredReport>();
  const [loading, setLoading] = useState(Boolean(reportId));
  const [error, setError] = useState("");

  useEffect(() => {
    if (!reportId) return;
    const controller = new AbortController();
    setLoading(true);
    fetch(`/api/reports/${encodeURIComponent(reportId)}`, { headers: { Accept: "application/json" }, signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({})) as StoredReport & ApiError;
        if (!response.ok) throw new Error(payload.error?.message || "보고서를 불러오지 못했습니다.");
        setReport(payload);
        document.title = `${payload.title} · Portfolio Lens`;
      })
      .catch((caught: unknown) => {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setError(caught instanceof Error ? caught.message : "보고서를 불러오지 못했습니다.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [reportId]);

  if (report) return <ReportDocument report={report} theme={theme} onToggleTheme={onToggleTheme} />;
  return (
    <main className="relative grid min-h-screen place-items-center bg-[var(--shell)] px-6">
      <div className="absolute right-5 top-5"><ThemeToggle theme={theme} onToggle={onToggleTheme} /></div>
      <div className="absolute left-5 top-5"><Logo /></div>
      {loading ? <ReportMessage icon={LoaderCircle} title="보고서를 불러오는 중" detail="저장된 수치와 차트 데이터를 준비하고 있습니다." />
        : error ? <ReportMessage icon={CircleAlert} title="보고서를 열 수 없습니다" detail={error} />
          : <ReportMessage icon={BarChart3} title="보고서 링크가 필요합니다" detail="대시보드에서 보고서를 생성한 뒤 발급된 주소로 접속해 주세요." />}
    </main>
  );
}
