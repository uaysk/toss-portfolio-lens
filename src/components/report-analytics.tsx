import { useMemo, useState } from "react";
import {
  Bar,
  BarChart,
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
import { StockSwatch } from "@/components/stock-swatch";
import { chartTooltipStyle, MONOCHROME_DASHES, MONOCHROME_SERIES } from "@/lib/chart-theme";
import { correlationAssetLabel, correlationCellStyle } from "@/lib/correlation-labels";
import { formatMoney, formatPercent, formatSignedMoney } from "@/lib/format";
import { stockColor } from "@/lib/stock-appearance";
import type {
  BacktestAdvancedAnalytics,
  BacktestResult,
  BenchmarkKey,
  PortfolioAnalysis,
  Theme,
} from "@/types";

type AnalysisData = Omit<PortfolioAnalysis, "accountId">;
type MonthlyReturn = { month: string; returnPercent: number };
type DrawdownData = {
  points: Array<{ date: string; drawdownPercent: number }>;
  episodes: Array<{
    startDate: string;
    troughDate: string;
    recoveryDate?: string;
    depthPercent: number;
    durationDays: number;
    recoveryDays?: number;
  }>;
  currentUnderwaterDays: number;
  averageDrawdownPercent: number | null;
  ulcerIndex: number | null;
  worst20DayReturnPercent: number | null;
  worst60DayReturnPercent: number | null;
};

const benchmarkLabels: Record<BenchmarkKey, string> = {
  KOSPI: "KOSPI",
  KOSDAQ: "KOSDAQ",
  NASDAQ100: "나스닥 100",
  SP500: "S&P 500",
};

function shortDate(value: string): string {
  return value.slice(2).replaceAll("-", ".");
}

function metricPercent(value: number | null | undefined, signed = true): string {
  return value === null || value === undefined ? "데이터 부족" : formatPercent(value, signed);
}

function metricRatio(value: number | null | undefined): string {
  return value === null || value === undefined ? "데이터 부족" : value.toFixed(2);
}

function confidenceLabel(value: "high" | "medium" | "limited"): string {
  if (value === "high") return "높음";
  if (value === "medium") return "보통";
  return "제한적";
}

function AnalyticsHeading({ eyebrow, title, detail }: { eyebrow: string; title: string; detail?: string }) {
  return (
    <div>
      <p className="text-[10px] font-black tracking-[0.16em] text-muted-foreground">{eyebrow}</p>
      <h2 className="mt-2 text-xl font-black tracking-[-0.04em] sm:text-2xl">{title}</h2>
      {detail ? <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">{detail}</p> : null}
    </div>
  );
}

function AnalyticsMetric({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="min-w-0 rounded-[18px] bg-card p-4">
      <p className="text-[9px] font-black tracking-[0.08em] text-muted-foreground">{label}</p>
      <p className="mt-2 break-words text-base font-black tracking-[-0.03em]">{value}</p>
      {detail ? <p className="mt-1 text-[10px] leading-4 text-muted-foreground">{detail}</p> : null}
    </div>
  );
}

function MonthlyReturnHeatmap({ values }: { values: MonthlyReturn[] }) {
  const rows = useMemo(() => {
    const byYear = new Map<string, Record<number, number>>();
    for (const item of values) {
      const [year, month] = item.month.split("-").map(Number);
      byYear.set(String(year), { ...(byYear.get(String(year)) ?? {}), [month]: item.returnPercent });
    }
    return Array.from(byYear, ([year, months]) => ({ year, months }))
      .sort((left, right) => right.year.localeCompare(left.year));
  }, [values]);

  return (
    <Card className="min-w-0 bg-secondary p-5 sm:p-7">
      <AnalyticsHeading eyebrow="MONTHLY RETURN MAP" title="월간 수익률 히트맵" detail="월별 성과의 방향과 강도를 한 화면에서 비교합니다." />
      <div className="mt-5 w-full min-w-0 overflow-x-auto rounded-[20px] bg-card p-3">
        <table className="w-full min-w-[720px] border-separate border-spacing-1 text-center text-[10px]">
          <thead>
            <tr><th className="p-2 text-left text-muted-foreground">연도</th>{Array.from({ length: 12 }, (_, index) => <th key={index} className="p-2 text-muted-foreground">{index + 1}월</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.year}>
                <th className="p-2 text-left text-xs font-black">{row.year}</th>
                {Array.from({ length: 12 }, (_, index) => {
                  const value = row.months[index + 1];
                  const opacity = value === undefined ? 0 : Math.min(0.56, 0.08 + Math.abs(value) / 36);
                  return (
                    <td
                      key={index}
                      className="rounded-xl p-2.5 font-black"
                      style={value === undefined ? undefined : {
                        backgroundColor: `hsl(var(--foreground) / ${opacity})`,
                        color: opacity >= 0.34 ? "hsl(var(--background))" : "hsl(var(--foreground))",
                      }}
                    >{value === undefined ? "-" : `${value > 0 ? "+" : ""}${value.toFixed(1)}`}</td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length ? <p className="p-4 text-center text-xs text-muted-foreground">월간 수익률 표본이 없습니다.</p> : null}
      </div>
    </Card>
  );
}

function DrawdownAnalytics({ data }: { data: DrawdownData }) {
  return (
    <Card className="bg-secondary p-5 sm:p-7">
      <AnalyticsHeading eyebrow="DRAWDOWN ANALYSIS" title="낙폭 깊이와 회복 과정" detail="고점 대비 하락 경로와 가장 큰 낙폭 구간을 함께 표시합니다." />
      <div className="mt-5 grid gap-3 xl:grid-cols-[1.35fr_0.9fr]">
        <div className="min-w-0 rounded-[20px] bg-card p-3">
          <div className="h-[300px]">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={data.points} margin={{ top: 8, right: 4, bottom: 0, left: 0 }}>
                <CartesianGrid vertical={false} stroke="hsl(var(--chart-grid))" strokeDasharray="3 7" />
                <XAxis dataKey="date" tickFormatter={shortDate} minTickGap={42} tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
                <YAxis tickFormatter={(value) => `${Number(value).toFixed(0)}%`} width={44} tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
                <Tooltip formatter={(value) => [formatPercent(Number(value), true), "낙폭"]} contentStyle={chartTooltipStyle} />
                <Line type="monotone" dataKey="drawdownPercent" name="낙폭" stroke={MONOCHROME_SERIES[0]} strokeWidth={2.4} dot={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2 lg:grid-cols-4">
            <AnalyticsMetric label="현재 수중 기간" value={`${data.currentUnderwaterDays.toLocaleString("ko-KR")}일`} />
            <AnalyticsMetric label="평균 낙폭" value={metricPercent(data.averageDrawdownPercent)} />
            <AnalyticsMetric label="ULCER INDEX" value={metricRatio(data.ulcerIndex)} />
            <AnalyticsMetric label="최악 20일 · 60일" value={`${metricPercent(data.worst20DayReturnPercent)} · ${metricPercent(data.worst60DayReturnPercent)}`} />
          </div>
        </div>
        <div className="space-y-2">
          {data.episodes.map((episode, index) => (
            <div key={`${episode.startDate}:${episode.troughDate}`} className="rounded-[18px] bg-card p-4">
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs font-black">#{index + 1} · {metricPercent(episode.depthPercent)}</span>
                <span className="text-[10px] font-bold text-muted-foreground">하락 {episode.durationDays}일</span>
              </div>
              <p className="mt-2 text-[10px] leading-4 text-muted-foreground">
                {episode.startDate} 고점 → {episode.troughDate} 저점{episode.recoveryDate ? ` → ${episode.recoveryDate} 회복 (${episode.recoveryDays ?? 0}일)` : " · 미회복"}
              </p>
            </div>
          ))}
          {!data.episodes.length ? <p className="rounded-[18px] bg-card p-4 text-xs text-muted-foreground">낙폭 구간이 없습니다.</p> : null}
        </div>
      </div>
    </Card>
  );
}

function CorrelationMatrix({ correlations, theme }: {
  correlations: { assets: Array<{ symbol: string; name: string }>; values: Array<Array<number | null>> };
  theme: Theme;
}) {
  return (
    <Card className="bg-secondary p-5 sm:p-7">
      <AnalyticsHeading eyebrow="CORRELATION" title="일간 수익률 상관관계" detail="1에 가까울수록 같은 방향, -1에 가까울수록 반대 방향으로 움직인 구간이 많습니다." />
      <div className="mt-5 overflow-x-auto rounded-[20px] bg-card p-3">
        <table className="w-full min-w-[520px] border-separate border-spacing-1 text-center text-xs">
          <thead>
            <tr>
              <th scope="col" className="p-2 text-left text-muted-foreground">종목명</th>
              {correlations.assets.map((asset) => <th key={asset.symbol} scope="col" title={asset.symbol} className="min-w-[104px] max-w-[140px] p-2 align-bottom font-black"><span className="inline-flex items-center justify-center gap-2 whitespace-normal break-keep leading-4"><StockSwatch symbol={asset.symbol} theme={theme} className="size-2" />{correlationAssetLabel(asset)}</span></th>)}
            </tr>
          </thead>
          <tbody>
            {correlations.assets.map((asset, rowIndex) => (
              <tr key={asset.symbol}>
                <th scope="row" title={asset.symbol} className="max-w-[170px] p-2 text-left font-black"><span className="flex min-w-0 items-center gap-2"><StockSwatch symbol={asset.symbol} theme={theme} className="size-2" /><span className="truncate">{correlationAssetLabel(asset)}</span></span></th>
                {(correlations.values[rowIndex] ?? []).map((value, columnIndex) => <td key={`${asset.symbol}:${columnIndex}`} className="rounded-xl p-3 font-black" style={correlationCellStyle(value)}>{value === null ? "-" : value.toFixed(2)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
        {!correlations.assets.length ? <p className="p-4 text-center text-xs text-muted-foreground">비교 가능한 종목이 없습니다.</p> : null}
      </div>
    </Card>
  );
}

type BenchmarkComparison = {
  key: string;
  name?: string;
  observations: number;
  returnPercent: number | null;
  excessReturnPercent: number | null;
  trackingErrorPercent: number | null;
  informationRatio: number | null;
  beta: number | null;
  alphaPercent: number | null;
  correlation: number | null;
  upsideCapturePercent: number | null;
  downsideCapturePercent: number | null;
  dailyWinRatePercent: number | null;
  monthlyWinRatePercent: number | null;
  relativeMaxDrawdownPercent: number | null;
};

function BenchmarkComparisonCards({ values, names }: { values: BenchmarkComparison[]; names?: Record<string, string> }) {
  return (
    <Card className="bg-secondary p-5 sm:p-7">
      <AnalyticsHeading eyebrow="ACTIVE PERFORMANCE" title="벤치마크 대비 상세 지표" detail="초과수익뿐 아니라 추적오차, 민감도, 참여율과 상대 낙폭을 함께 비교합니다." />
      <div className="mt-5 grid gap-3 xl:grid-cols-2">
        {values.map((item) => (
          <div key={item.key} className="rounded-[22px] bg-card p-4 sm:p-5">
            <div className="flex items-center justify-between gap-3"><h3 className="text-sm font-black">{item.name ?? names?.[item.key] ?? item.key}</h3><span className="text-[10px] font-bold text-muted-foreground">{item.observations.toLocaleString("ko-KR")}일</span></div>
            <div className="mt-4 grid grid-cols-2 gap-2 lg:grid-cols-3">
              <AnalyticsMetric label="지수 수익률" value={metricPercent(item.returnPercent)} />
              <AnalyticsMetric label="초과수익률" value={metricPercent(item.excessReturnPercent)} />
              <AnalyticsMetric label="ALPHA" value={metricPercent(item.alphaPercent)} />
              <AnalyticsMetric label="TRACKING ERROR" value={metricPercent(item.trackingErrorPercent, false)} />
              <AnalyticsMetric label="INFORMATION RATIO" value={metricRatio(item.informationRatio)} />
              <AnalyticsMetric label="BETA" value={metricRatio(item.beta)} />
              <AnalyticsMetric label="상관관계" value={metricRatio(item.correlation)} />
              <AnalyticsMetric label="상방 · 하방 참여율" value={`${metricPercent(item.upsideCapturePercent)} · ${metricPercent(item.downsideCapturePercent)}`} />
              <AnalyticsMetric label="일간 · 월간 승률" value={`${metricPercent(item.dailyWinRatePercent, false)} · ${metricPercent(item.monthlyWinRatePercent, false)}`} />
              <AnalyticsMetric label="상대 최대 낙폭" value={metricPercent(item.relativeMaxDrawdownPercent)} />
            </div>
          </div>
        ))}
        {!values.length ? <p className="rounded-[20px] bg-card p-5 text-sm text-muted-foreground">비교 가능한 벤치마크 지표가 없습니다.</p> : null}
      </div>
    </Card>
  );
}

function AnalysisRolling({ analysis }: { analysis: AnalysisData }) {
  const rolling = analysis.rolling ?? [];
  const availableBenchmarks = analysis.benchmarks.map((item) => item.key);
  const [benchmarkKey, setBenchmarkKey] = useState<BenchmarkKey | undefined>(availableBenchmarks[0]);
  const activeKey = benchmarkKey && availableBenchmarks.includes(benchmarkKey) ? benchmarkKey : availableBenchmarks[0];
  const chartData = rolling.filter((point) => (
    point.return20d !== null
    || point.return60d !== null
    || point.volatility60d !== null
    || (activeKey ? point.benchmarkBeta60d[activeKey] !== undefined : false)
  ));

  return (
    <Card className="bg-secondary p-5 sm:p-7">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <AnalyticsHeading eyebrow="ROLLING PERFORMANCE" title="롤링 수익률과 위험 변화" detail="20·60·120·252거래일 수익률과 60일 변동성·샤프·벤치마크 민감도를 표시합니다." />
        {availableBenchmarks.length ? (
          <div className="flex flex-wrap gap-1 rounded-[16px] bg-card p-1">
            {availableBenchmarks.map((key) => <Button key={key} size="sm" variant={activeKey === key ? "default" : "ghost"} aria-pressed={activeKey === key} onClick={() => setBenchmarkKey(key)}>{benchmarkLabels[key]}</Button>)}
          </div>
        ) : null}
      </div>
      {chartData.length ? (
        <div className="mt-6 grid gap-3 xl:grid-cols-2">
          <div className="rounded-[20px] bg-card p-4">
            <p className="text-xs font-black">롤링 누적수익률</p>
            <div className="mt-4 h-[300px]">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={chartData} margin={{ top: 8, right: 4, bottom: 0, left: 0 }}>
                  <CartesianGrid vertical={false} stroke="hsl(var(--chart-grid))" strokeDasharray="3 7" />
                  <XAxis dataKey="date" tickFormatter={shortDate} minTickGap={42} tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
                  <YAxis tickFormatter={(value) => `${Number(value).toFixed(0)}%`} width={44} tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
                  <Tooltip formatter={(value, name) => [metricPercent(Number(value)), String(name)]} contentStyle={chartTooltipStyle} />
                  <Line type="monotone" dataKey="return20d" name="20일" stroke={MONOCHROME_SERIES[0]} strokeWidth={2.4} dot={false} connectNulls />
                  <Line type="monotone" dataKey="return60d" name="60일" stroke={MONOCHROME_SERIES[1]} strokeDasharray={MONOCHROME_DASHES[1]} strokeWidth={2} dot={false} connectNulls />
                  <Line type="monotone" dataKey="return120d" name="120일" stroke={MONOCHROME_SERIES[2]} strokeDasharray={MONOCHROME_DASHES[2]} strokeWidth={2} dot={false} connectNulls />
                  <Line type="monotone" dataKey="return252d" name="252일" stroke={MONOCHROME_SERIES[3]} strokeDasharray={MONOCHROME_DASHES[3]} strokeWidth={2} dot={false} connectNulls />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </div>
          <div className="rounded-[20px] bg-card p-4">
            <p className="text-xs font-black">60일 위험{activeKey ? ` · ${benchmarkLabels[activeKey]} 비교` : ""}</p>
            <div className="mt-4 h-[300px]">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={chartData} margin={{ top: 8, right: 4, bottom: 0, left: 0 }}>
                  <CartesianGrid vertical={false} stroke="hsl(var(--chart-grid))" strokeDasharray="3 7" />
                  <XAxis dataKey="date" tickFormatter={shortDate} minTickGap={42} tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
                  <YAxis yAxisId="percent" tickFormatter={(value) => `${Number(value).toFixed(0)}%`} width={44} tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
                  <YAxis yAxisId="ratio" orientation="right" width={38} tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
                  <Tooltip formatter={(value, name) => [Number(value).toFixed(2), String(name)]} contentStyle={chartTooltipStyle} />
                  <Line yAxisId="percent" type="monotone" dataKey="volatility60d" name="변동성 %" stroke={MONOCHROME_SERIES[0]} strokeWidth={2.4} dot={false} connectNulls />
                  <Line yAxisId="ratio" type="monotone" dataKey="sharpe60d" name="샤프" stroke={MONOCHROME_SERIES[1]} strokeDasharray={MONOCHROME_DASHES[1]} strokeWidth={2} dot={false} connectNulls />
                  {activeKey ? <Line yAxisId="percent" type="monotone" dataKey={`benchmarkExcess60d.${activeKey}`} name="초과수익 %" stroke={MONOCHROME_SERIES[2]} strokeDasharray={MONOCHROME_DASHES[2]} strokeWidth={2} dot={false} connectNulls /> : null}
                  {activeKey ? <Line yAxisId="ratio" type="monotone" dataKey={`benchmarkBeta60d.${activeKey}`} name="베타" stroke={MONOCHROME_SERIES[3]} strokeDasharray={MONOCHROME_DASHES[3]} strokeWidth={2} dot={false} connectNulls /> : null}
                  {activeKey ? <Line yAxisId="ratio" type="monotone" dataKey={`benchmarkCorrelation60d.${activeKey}`} name="상관" stroke={MONOCHROME_SERIES[1]} strokeDasharray={MONOCHROME_DASHES[3]} strokeWidth={1.8} dot={false} connectNulls /> : null}
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      ) : <p className="mt-5 rounded-[20px] bg-card p-5 text-sm text-muted-foreground">20거래일 이상의 표본이 쌓이면 롤링 차트를 표시합니다.</p>}
    </Card>
  );
}

function TailRiskMetrics({ values }: { values: AnalysisData["tailRisk"] | BacktestAdvancedAnalytics["tailRisk"] }) {
  return (
    <Card className="min-w-0 bg-secondary p-5 sm:p-7">
      <AnalyticsHeading eyebrow="TAIL RISK" title="손실 분포와 극단 위험" />
      <div className="mt-5 grid grid-cols-2 gap-2 lg:grid-cols-3">
        <AnalyticsMetric label="역사적 VaR 95%" value={metricPercent(values.historicalVar95Percent)} detail="하위 5% 일간수익률 경계" />
        <AnalyticsMetric label="CVaR 95%" value={metricPercent(values.expectedShortfall95Percent)} detail="임계치 이하 손실일 평균" />
        <AnalyticsMetric label="손실일 비율" value={metricPercent(values.lossDaysPercent, false)} detail={`최장 연속 하락 ${values.maxConsecutiveLossDays}일`} />
        <AnalyticsMetric label="평균 상승 · 하락" value={`${metricPercent(values.averageGainPercent)} · ${metricPercent(values.averageLossPercent)}`} detail={`손익비 ${metricRatio(values.gainLossRatio)}`} />
        <AnalyticsMetric label="왜도" value={metricRatio(values.skewness)} detail="음수일수록 왼쪽 꼬리 위험" />
        <AnalyticsMetric label="초과 첨도" value={metricRatio(values.excessKurtosis)} detail={`최장 연속 상승 ${values.maxConsecutiveGainDays}일`} />
      </div>
    </Card>
  );
}

function AnalysisRiskAndExposure({ analysis, theme }: { analysis: AnalysisData; theme: Theme }) {
  const maximum = Math.max(...(analysis.riskContributions ?? []).map((item) => Math.abs(item.riskContributionPercent ?? 0)), 1);
  return (
    <div className="grid min-w-0 gap-3 xl:grid-cols-[1.15fr_0.85fr]">
      <Card className="min-w-0 bg-secondary p-5 sm:p-7">
        <AnalyticsHeading eyebrow="RISK CONTRIBUTION" title="종목별 위험 기여도" detail="종목 변동성과 포트폴리오 공분산이 전체 위험에 기여한 비율입니다." />
        <div className="mt-5 space-y-3">
          {(analysis.riskContributions ?? []).map((item) => (
            <div key={item.key} className="rounded-[18px] bg-card p-4">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0"><div className="flex min-w-0 items-center gap-2"><StockSwatch symbol={item.symbol} theme={theme} /><p className="truncate text-xs font-black">{item.name}</p></div><p className="mt-1 text-[10px] text-muted-foreground">{item.symbol} · 비중 {formatPercent(item.weightPercent)} · 변동성 {metricPercent(item.annualizedVolatilityPercent, false)}</p></div>
                <p className="text-sm font-black">{metricPercent(item.riskContributionPercent)}</p>
              </div>
              <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-secondary"><div className="h-full rounded-full" style={{ width: `${Math.max(2, Math.abs(item.riskContributionPercent ?? 0) / maximum * 100)}%`, backgroundColor: stockColor(item.symbol, theme) }} /></div>
              <p className="mt-2 text-[10px] text-muted-foreground">포트폴리오 상관 {metricRatio(item.correlationToPortfolio)}</p>
            </div>
          ))}
          {!analysis.riskContributions?.length ? <p className="rounded-[18px] bg-card p-4 text-xs text-muted-foreground">위험 기여도 표본이 없습니다.</p> : null}
        </div>
      </Card>
      <Card className="min-w-0 bg-secondary p-5 sm:p-7">
        <AnalyticsHeading eyebrow="DIVERSIFICATION" title="집중도와 통화·시장 노출" />
        <div className="mt-5 grid grid-cols-2 gap-2">
          <AnalyticsMetric label="상위 1 · 3종목" value={`${formatPercent(analysis.exposure.top1WeightPercent)} · ${formatPercent(analysis.metrics.top3WeightPercent)}`} />
          <AnalyticsMetric label="상위 5 · 10종목" value={`${formatPercent(analysis.exposure.top5WeightPercent)} · ${formatPercent(analysis.exposure.top10WeightPercent)}`} />
          <AnalyticsMetric label="HHI · 유효 종목 수" value={`${analysis.metrics.hhi.toFixed(4)} · ${analysis.metrics.effectivePositions.toFixed(2)}개`} />
          <AnalyticsMetric label="분산 효과" value={metricPercent(analysis.exposure.diversificationBenefitPercent, false)} />
          <AnalyticsMetric label="KRW · USD" value={`${formatPercent(analysis.exposure.krwWeightPercent)} · ${formatPercent(analysis.exposure.usdWeightPercent)}`} />
          <AnalyticsMetric label="국내 · 해외" value={`${formatPercent(analysis.exposure.domesticWeightPercent)} · ${formatPercent(analysis.exposure.overseasWeightPercent)}`} />
        </div>
      </Card>
    </div>
  );
}

function AnalysisCostAndTrades({ analysis }: { analysis: AnalysisData }) {
  return (
    <div className="grid min-w-0 gap-3 xl:grid-cols-[1.25fr_0.85fr]">
      <Card className="min-w-0 bg-secondary p-5 sm:p-7">
        <AnalyticsHeading eyebrow="COST EFFICIENCY" title="월별 회전율과 실제 비용" />
        <div className="mt-5 grid grid-cols-2 gap-2 lg:grid-cols-5">
          <AnalyticsMetric label="비용 드래그" value={metricPercent(analysis.costEfficiency.costDragPercent)} />
          <AnalyticsMetric label="비용 전 추정수익" value={metricPercent(analysis.costEfficiency.grossEstimatedReturnPercent)} />
          <AnalyticsMetric label="거래금액당 비용" value={analysis.costEfficiency.costPerTradedAmountBps === null ? "데이터 부족" : `${analysis.costEfficiency.costPerTradedAmountBps.toFixed(2)}bp`} />
          <AnalyticsMetric label="거래당 평균" value={analysis.costEfficiency.averageTradeAmount === null ? "데이터 부족" : formatMoney(analysis.costEfficiency.averageTradeAmount, "KRW")} />
          <AnalyticsMetric label="매수/매도 금액비" value={metricRatio(analysis.costEfficiency.buySellAmountRatio)} />
        </div>
        <div className="mt-4 h-[280px] min-w-0 rounded-[20px] bg-card p-3">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={analysis.costEfficiency.monthly ?? []} margin={{ top: 8, right: 4, bottom: 0, left: 0 }}>
              <CartesianGrid vertical={false} stroke="hsl(var(--chart-grid))" strokeDasharray="3 7" />
              <XAxis dataKey="month" tickFormatter={shortDate} minTickGap={26} tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
              <YAxis yAxisId="turnover" tickFormatter={(value) => `${Number(value).toFixed(0)}%`} width={42} tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
              <YAxis yAxisId="cost" orientation="right" tickFormatter={(value) => formatMoney(Number(value), "KRW", true)} width={54} tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
              <Tooltip formatter={(value, name) => [name === "회전율" ? formatPercent(Number(value)) : name === "거래 건수" ? `${Number(value)}건` : formatMoney(Number(value), "KRW"), String(name)]} contentStyle={chartTooltipStyle} />
              <Bar yAxisId="turnover" dataKey="turnoverPercent" name="회전율" fill={MONOCHROME_SERIES[1]} radius={[6, 6, 0, 0]} />
              <Line yAxisId="cost" type="monotone" dataKey="cost" name="비용" stroke={MONOCHROME_SERIES[0]} strokeWidth={2} dot={false} />
              <Line yAxisId="turnover" type="monotone" dataKey="tradeCount" name="거래 건수" stroke={MONOCHROME_SERIES[2]} strokeDasharray={MONOCHROME_DASHES[2]} strokeWidth={1.8} dot={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </Card>
      <Card className="min-w-0 bg-secondary p-5 sm:p-7">
        <AnalyticsHeading eyebrow="TRADE BEHAVIOR" title="FIFO 거래 추정치" />
        <div className="mt-5 grid grid-cols-2 gap-2">
          <AnalyticsMetric label="추정 실현손익" value={formatSignedMoney(analysis.tradeBehavior.estimatedRealizedProfitLoss, "KRW")} />
          <AnalyticsMetric label="추정 승률" value={metricPercent(analysis.tradeBehavior.estimatedWinRatePercent, false)} />
          <AnalyticsMetric label="PROFIT FACTOR" value={metricRatio(analysis.tradeBehavior.estimatedProfitFactor)} />
          <AnalyticsMetric label="평균 보유기간" value={analysis.tradeBehavior.estimatedAverageHoldingDays === null ? "데이터 부족" : `${analysis.tradeBehavior.estimatedAverageHoldingDays.toFixed(1)}일`} />
          <AnalyticsMetric label="매칭 매도" value={`${analysis.tradeBehavior.matchedSellCount.toLocaleString("ko-KR")}건`} />
          <AnalyticsMetric label="미매칭 매도" value={`${analysis.tradeBehavior.unmatchedSellCount.toLocaleString("ko-KR")}건`} />
        </div>
      </Card>
    </div>
  );
}

function AnalysisDataQuality({ analysis }: { analysis: AnalysisData }) {
  const quality = analysis.dataQuality;
  return (
    <Card className="bg-secondary p-5 sm:p-7">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <AnalyticsHeading eyebrow="DATA CONFIDENCE" title="분석 데이터 신뢰도" detail="일별 평가금·종목 가격·환율 복원 범위와 누락 상태를 표시합니다." />
        <span className="w-fit rounded-full bg-card px-4 py-2 text-xs font-black">{confidenceLabel(quality.confidence)}</span>
      </div>
      <div className="mt-5 grid grid-cols-2 gap-2 lg:grid-cols-4 xl:grid-cols-6">
        <AnalyticsMetric label="분석 이력" value={`${quality.historyDays.toLocaleString("ko-KR")}일`} detail={`수익률 ${quality.returnObservationDays}/${quality.expectedReturnObservationDays}일`} />
        <AnalyticsMetric label="수익률 커버리지" value={formatPercent(quality.returnCoveragePercent)} />
        <AnalyticsMetric label="가격 커버리지" value={formatPercent(quality.priceCoveragePercent)} detail={`${quality.requiredPriceObservations.toLocaleString("ko-KR")}건 중 ${quality.missingPriceObservations.toLocaleString("ko-KR")}건 누락`} />
        <AnalyticsMetric label="환율 커버리지" value={formatPercent(quality.fxCoveragePercent)} detail={`${quality.requiredFxObservations.toLocaleString("ko-KR")}건 중 ${quality.missingFxObservations.toLocaleString("ko-KR")}건 누락`} />
        <AnalyticsMetric label="실측 · 복원 스냅샷" value={`${quality.liveSnapshotDays.toLocaleString("ko-KR")} · ${quality.reconstructedSnapshotDays.toLocaleString("ko-KR")}일`} />
        <AnalyticsMetric label="백필 상태" value={quality.backfillStatus} detail={`실패 종목 ${quality.failedSymbols.toLocaleString("ko-KR")}개`} />
        <AnalyticsMetric label="평가 OHLC" value={analysis.estimatedOhlc ? "추정값" : "실측값"} detail={analysis.ohlcBackfillComplete ? "복원 완료" : "복원 진행 중"} />
        <AnalyticsMetric label="환율 복원" value={analysis.fxBackfillComplete ? "완료" : "진행 중"} detail={analysis.includesCurrencies.join(" · ")} />
      </div>
      <div className="mt-4 rounded-[18px] bg-card px-4 py-3 text-xs leading-5 text-muted-foreground">
        {quality.notes.map((note) => <p key={note}>{note}</p>)}
        {!quality.notes.length ? <p>추가 데이터 품질 경고가 없습니다.</p> : null}
      </div>
    </Card>
  );
}

export function AnalysisReportAnalytics({ analysis, theme }: { analysis: AnalysisData; theme: Theme }) {
  const comparisons: BenchmarkComparison[] = (analysis.benchmarkComparisons ?? []).map((item) => ({
    ...item,
    name: analysis.benchmarks.find((benchmark) => benchmark.key === item.key)?.name ?? benchmarkLabels[item.key],
  }));
  const correlation = analysis.correlations ?? { assets: [], values: [] };
  return (
    <>
      <BenchmarkComparisonCards values={comparisons} />
      <AnalysisRolling analysis={analysis} />
      {analysis.drawdowns ? <DrawdownAnalytics data={analysis.drawdowns} /> : null}
      <div className="grid min-w-0 gap-3 xl:grid-cols-[0.9fr_1.3fr]">
        {analysis.tailRisk ? <TailRiskMetrics values={analysis.tailRisk} /> : null}
        <MonthlyReturnHeatmap values={analysis.monthlyReturns ?? []} />
      </div>
      {analysis.riskContributions && analysis.exposure ? <AnalysisRiskAndExposure analysis={analysis} theme={theme} /> : null}
      {analysis.costEfficiency && analysis.tradeBehavior ? <AnalysisCostAndTrades analysis={analysis} /> : null}
      <CorrelationMatrix correlations={correlation} theme={theme} />
      {analysis.dataQuality ? <AnalysisDataQuality analysis={analysis} /> : null}
    </>
  );
}

function BacktestRolling({ advanced, benchmarkName }: { advanced: BacktestAdvancedAnalytics; benchmarkName?: string }) {
  const chartData = advanced.rolling ?? [];
  return (
    <Card className="bg-secondary p-5 sm:p-7">
      <AnalyticsHeading eyebrow="ROLLING PERFORMANCE" title="롤링 수익률과 위험 변화" detail="20·60·120·252거래일 수익률과 60일 변동성·샤프·벤치마크 민감도를 표시합니다." />
      {chartData.length ? (
        <div className="mt-6 grid gap-3 xl:grid-cols-2">
          <div className="rounded-[20px] bg-card p-4">
            <p className="text-xs font-black">롤링 누적수익률</p>
            <div className="mt-4 h-[300px]">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={chartData} margin={{ top: 8, right: 4, bottom: 0, left: 0 }}>
                  <CartesianGrid vertical={false} stroke="hsl(var(--chart-grid))" strokeDasharray="3 7" />
                  <XAxis dataKey="date" tickFormatter={shortDate} minTickGap={42} tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
                  <YAxis tickFormatter={(value) => `${Number(value).toFixed(0)}%`} width={44} tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
                  <Tooltip formatter={(value, name) => [metricPercent(Number(value)), String(name)]} contentStyle={chartTooltipStyle} />
                  <Line type="monotone" dataKey="return20d" name="20일" stroke={MONOCHROME_SERIES[0]} strokeWidth={2.4} dot={false} connectNulls />
                  <Line type="monotone" dataKey="return60d" name="60일" stroke={MONOCHROME_SERIES[1]} strokeDasharray={MONOCHROME_DASHES[1]} strokeWidth={2} dot={false} connectNulls />
                  <Line type="monotone" dataKey="return120d" name="120일" stroke={MONOCHROME_SERIES[2]} strokeDasharray={MONOCHROME_DASHES[2]} strokeWidth={2} dot={false} connectNulls />
                  <Line type="monotone" dataKey="return252d" name="252일" stroke={MONOCHROME_SERIES[3]} strokeDasharray={MONOCHROME_DASHES[3]} strokeWidth={2} dot={false} connectNulls />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </div>
          <div className="rounded-[20px] bg-card p-4">
            <p className="text-xs font-black">60일 위험{benchmarkName ? ` · ${benchmarkName} 비교` : ""}</p>
            <div className="mt-4 h-[300px]">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={chartData} margin={{ top: 8, right: 4, bottom: 0, left: 0 }}>
                  <CartesianGrid vertical={false} stroke="hsl(var(--chart-grid))" strokeDasharray="3 7" />
                  <XAxis dataKey="date" tickFormatter={shortDate} minTickGap={42} tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
                  <YAxis yAxisId="percent" tickFormatter={(value) => `${Number(value).toFixed(0)}%`} width={44} tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
                  <YAxis yAxisId="ratio" orientation="right" width={38} tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
                  <Tooltip formatter={(value, name) => [Number(value).toFixed(2), String(name)]} contentStyle={chartTooltipStyle} />
                  <Line yAxisId="percent" type="monotone" dataKey="volatility60d" name="변동성 %" stroke={MONOCHROME_SERIES[0]} strokeWidth={2.4} dot={false} connectNulls />
                  <Line yAxisId="ratio" type="monotone" dataKey="sharpe60d" name="샤프" stroke={MONOCHROME_SERIES[1]} strokeDasharray={MONOCHROME_DASHES[1]} strokeWidth={2} dot={false} connectNulls />
                  <Line yAxisId="percent" type="monotone" dataKey="benchmarkExcess60d" name="초과수익 %" stroke={MONOCHROME_SERIES[2]} strokeDasharray={MONOCHROME_DASHES[2]} strokeWidth={2} dot={false} connectNulls />
                  <Line yAxisId="ratio" type="monotone" dataKey="benchmarkBeta60d" name="베타" stroke={MONOCHROME_SERIES[3]} strokeDasharray={MONOCHROME_DASHES[3]} strokeWidth={2} dot={false} connectNulls />
                  <Line yAxisId="ratio" type="monotone" dataKey="benchmarkCorrelation60d" name="상관" stroke={MONOCHROME_SERIES[1]} strokeDasharray={MONOCHROME_DASHES[3]} strokeWidth={1.8} dot={false} connectNulls />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      ) : <p className="mt-5 rounded-[20px] bg-card p-5 text-sm text-muted-foreground">20거래일 이상의 표본이 쌓이면 롤링 차트를 표시합니다.</p>}
    </Card>
  );
}

function BacktestRiskAndExposure({ advanced, theme }: { advanced: BacktestAdvancedAnalytics; theme: Theme }) {
  const maximum = Math.max(...advanced.riskContributions.map((item) => Math.abs(item.riskContributionPercent ?? 0)), 1);
  return (
    <div className="grid min-w-0 gap-3 xl:grid-cols-[1.15fr_0.85fr]">
      <Card className="min-w-0 bg-secondary p-5 sm:p-7">
        <AnalyticsHeading eyebrow="RISK CONTRIBUTION" title="종목별 위험 기여도" detail="평균 비중과 종목 공분산으로 전체 변동성 기여를 계산합니다." />
        <div className="mt-5 space-y-3">
          {advanced.riskContributions.map((item) => (
            <div key={item.key} className="rounded-[18px] bg-card p-4">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0"><div className="flex min-w-0 items-center gap-2"><StockSwatch symbol={item.symbol} theme={theme} /><p className="truncate text-xs font-black">{item.name}</p></div><p className="mt-1 text-[10px] text-muted-foreground">{item.symbol} · 평균 {formatPercent(item.averageWeightPercent)} · 종료 {formatPercent(item.endingWeightPercent)} · 변동성 {metricPercent(item.annualizedVolatilityPercent, false)}</p></div>
                <p className="text-sm font-black">{metricPercent(item.riskContributionPercent)}</p>
              </div>
              <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-secondary"><div className="h-full rounded-full" style={{ width: `${Math.max(2, Math.abs(item.riskContributionPercent ?? 0) / maximum * 100)}%`, backgroundColor: stockColor(item.symbol, theme) }} /></div>
              <p className="mt-2 text-[10px] text-muted-foreground">포트폴리오 상관 {metricRatio(item.correlationToPortfolio)}</p>
            </div>
          ))}
          {!advanced.riskContributions.length ? <p className="rounded-[18px] bg-card p-4 text-xs text-muted-foreground">위험 기여도 표본이 없습니다.</p> : null}
        </div>
      </Card>
      <Card className="min-w-0 bg-secondary p-5 sm:p-7">
        <AnalyticsHeading eyebrow="DIVERSIFICATION" title="집중도와 통화·시장 노출" />
        <div className="mt-5 grid grid-cols-2 gap-2">
          <AnalyticsMetric label="상위 1 · 5종목" value={`${formatPercent(advanced.exposure.top1WeightPercent)} · ${formatPercent(advanced.exposure.top5WeightPercent)}`} />
          <AnalyticsMetric label="상위 10종목" value={formatPercent(advanced.exposure.top10WeightPercent)} />
          <AnalyticsMetric label="HHI · 유효 종목 수" value={`${advanced.exposure.hhi.toFixed(4)} · ${advanced.exposure.effectivePositions === null ? "데이터 부족" : `${advanced.exposure.effectivePositions.toFixed(2)}개`}`} />
          <AnalyticsMetric label="분산 효과" value={metricPercent(advanced.exposure.diversificationBenefitPercent, false)} />
          <AnalyticsMetric label="KRW · USD" value={`${formatPercent(advanced.exposure.krwWeightPercent)} · ${formatPercent(advanced.exposure.usdWeightPercent)}`} />
          <AnalyticsMetric label="국내 · 해외" value={`${formatPercent(advanced.exposure.domesticWeightPercent)} · ${formatPercent(advanced.exposure.overseasWeightPercent)}`} />
        </div>
      </Card>
    </div>
  );
}

function BacktestCostAndTrades({ advanced }: { advanced: BacktestAdvancedAnalytics }) {
  return (
    <div className="grid min-w-0 gap-3 xl:grid-cols-[1.25fr_0.85fr]">
      <Card className="min-w-0 bg-secondary p-5 sm:p-7">
        <AnalyticsHeading eyebrow="TURNOVER & COST" title="월별 회전율과 추정 거래비용" />
        <div className="mt-5 grid grid-cols-2 gap-2 lg:grid-cols-5">
          <AnalyticsMetric label="거래비용 가정" value={`${advanced.costEfficiency.transactionCostBps.toFixed(2)}bp`} />
          <AnalyticsMetric label="운용 회전율" value={metricPercent(advanced.costEfficiency.turnoverPercent, false)} />
          <AnalyticsMetric label="총 · 운용 거래금액" value={`${formatMoney(advanced.costEfficiency.totalTradedAmount, "KRW", true)} · ${formatMoney(advanced.costEfficiency.ongoingTradedAmount, "KRW", true)}`} />
          <AnalyticsMetric label="추정 총비용" value={formatMoney(advanced.costEfficiency.estimatedTotalCost, "KRW")} />
          <AnalyticsMetric label="비용 드래그" value={metricPercent(advanced.costEfficiency.costDragPercent)} />
          <AnalyticsMetric label="비용 전 · 후 수익" value={`${metricPercent(advanced.costEfficiency.grossReturnPercent)} · ${metricPercent(advanced.costEfficiency.netEstimatedReturnPercent)}`} />
          <AnalyticsMetric label="거래당 평균" value={advanced.costEfficiency.averageTradeAmount === null ? "데이터 부족" : formatMoney(advanced.costEfficiency.averageTradeAmount, "KRW")} />
          <AnalyticsMetric label="매수/매도 금액비" value={metricRatio(advanced.costEfficiency.buySellAmountRatio)} />
          <AnalyticsMetric label="총 거래 건수" value={`${advanced.costEfficiency.tradeCount.toLocaleString("ko-KR")}건`} />
        </div>
        <div className="mt-4 h-[280px] min-w-0 rounded-[20px] bg-card p-3">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={advanced.costEfficiency.monthly} margin={{ top: 8, right: 4, bottom: 0, left: 0 }}>
              <CartesianGrid vertical={false} stroke="hsl(var(--chart-grid))" strokeDasharray="3 7" />
              <XAxis dataKey="month" tickFormatter={shortDate} minTickGap={26} tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
              <YAxis yAxisId="turnover" tickFormatter={(value) => `${Number(value).toFixed(0)}%`} width={42} tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
              <YAxis yAxisId="money" orientation="right" tickFormatter={(value) => formatMoney(Number(value), "KRW", true)} width={54} tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
              <Tooltip formatter={(value, name) => [name === "회전율" ? formatPercent(Number(value)) : name === "거래 건수" ? `${Number(value)}건` : formatMoney(Number(value), "KRW"), String(name)]} contentStyle={chartTooltipStyle} />
              <Bar yAxisId="turnover" dataKey="turnoverPercent" name="회전율" fill={MONOCHROME_SERIES[1]} radius={[6, 6, 0, 0]} />
              <Line yAxisId="money" type="monotone" dataKey="tradedAmount" name="거래금액" stroke={MONOCHROME_SERIES[2]} strokeWidth={1.8} dot={false} />
              <Line yAxisId="money" type="monotone" dataKey="estimatedCost" name="추정비용" stroke={MONOCHROME_SERIES[0]} strokeWidth={2} dot={false} />
              <Line yAxisId="turnover" type="monotone" dataKey="tradeCount" name="거래 건수" stroke={MONOCHROME_SERIES[3]} strokeDasharray={MONOCHROME_DASHES[3]} strokeWidth={1.8} dot={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </Card>
      <Card className="min-w-0 bg-secondary p-5 sm:p-7">
        <AnalyticsHeading eyebrow="SIMULATED TRADE OUTCOME" title="FIFO 거래 추정치" />
        <div className="mt-5 grid grid-cols-2 gap-2">
          <AnalyticsMetric label="추정 실현손익" value={formatSignedMoney(advanced.tradeBehavior.estimatedRealizedProfitLoss, "KRW")} />
          <AnalyticsMetric label="추정 승률" value={metricPercent(advanced.tradeBehavior.estimatedWinRatePercent, false)} />
          <AnalyticsMetric label="PROFIT FACTOR" value={metricRatio(advanced.tradeBehavior.estimatedProfitFactor)} />
          <AnalyticsMetric label="평균 보유기간" value={advanced.tradeBehavior.estimatedAverageHoldingDays === null ? "데이터 부족" : `${advanced.tradeBehavior.estimatedAverageHoldingDays.toFixed(1)}일`} />
          <AnalyticsMetric label="매칭 · 미매칭 매도" value={`${advanced.tradeBehavior.matchedSellCount} · ${advanced.tradeBehavior.unmatchedSellCount}건`} />
          <AnalyticsMetric label="매수 · 매도" value={`${advanced.tradeBehavior.buyCount} · ${advanced.tradeBehavior.sellCount}건`} />
        </div>
      </Card>
    </div>
  );
}

function BacktestDataQuality({ advanced, benchmarkName, theme }: { advanced: BacktestAdvancedAnalytics; benchmarkName?: string; theme: Theme }) {
  const quality = advanced.dataQuality;
  return (
    <Card className="bg-secondary p-5 sm:p-7">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <AnalyticsHeading eyebrow="DATA CONFIDENCE" title="백테스트 데이터 신뢰도" detail="종목별 가격 관측과 공통 거래일 정렬 범위를 표시합니다." />
        <span className="w-fit rounded-full bg-card px-4 py-2 text-xs font-black">{confidenceLabel(quality.confidence)}</span>
      </div>
      <div className="mt-5 grid grid-cols-2 gap-2 lg:grid-cols-4">
        <AnalyticsMetric label="수익률 · 정렬 관측" value={`${quality.returnObservationDays.toLocaleString("ko-KR")} · ${quality.observationDays.toLocaleString("ko-KR")}일`} />
        <AnalyticsMetric label="공통 커버리지" value={formatPercent(quality.commonCoveragePercent)} detail={`이월 관측 ${quality.carriedForwardObservations.toLocaleString("ko-KR")}건`} />
        <AnalyticsMetric label="유효 기간" value={`${quality.effectiveStartDate}~${quality.effectiveEndDate}`} detail={`요청 달력 ${quality.requestedCalendarDays.toLocaleString("ko-KR")}일`} />
        <AnalyticsMetric label="벤치마크 관측" value={`${quality.benchmarkObservations.toLocaleString("ko-KR")}일`} detail={benchmarkName ?? "비교 지수 없음"} />
      </div>
      <div className="mt-4 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
        {quality.assets.map((asset) => <div key={asset.key} className="rounded-[18px] bg-card p-4"><div className="flex min-w-0 items-center gap-2"><StockSwatch symbol={asset.symbol} theme={theme} /><p className="truncate text-xs font-black">{asset.name}</p></div><p className="mt-1 text-[10px] text-muted-foreground">{asset.symbol} · {asset.observations}/{asset.alignedDays}일 · {formatPercent(asset.coveragePercent)} · {asset.firstDate}~{asset.lastDate}</p></div>)}
      </div>
      <div className="mt-4 rounded-[18px] bg-card px-4 py-3 text-xs leading-5 text-muted-foreground">
        {quality.notes.map((note) => <p key={note}>{note}</p>)}
        {!quality.notes.length ? <p>추가 데이터 품질 경고가 없습니다.</p> : null}
      </div>
    </Card>
  );
}

export function BacktestReportAnalytics({ result, theme }: { result: BacktestResult; theme: Theme }) {
  const advanced = result.advanced;
  if (!advanced) {
    return <Card className="bg-secondary p-5 text-sm text-muted-foreground sm:p-7">이 보고서는 고급 분석 지표가 도입되기 전에 생성되어 상세 지표가 저장되어 있지 않습니다.</Card>;
  }
  const comparison = advanced.benchmarkComparison ? [{ ...advanced.benchmarkComparison }] : [];
  return (
    <>
      <BenchmarkComparisonCards values={comparison} />
      <BacktestRolling advanced={advanced} benchmarkName={result.benchmark?.name} />
      <DrawdownAnalytics data={advanced.drawdowns} />
      <div className="grid min-w-0 gap-3 xl:grid-cols-[0.9fr_1.3fr]">
        <TailRiskMetrics values={advanced.tailRisk} />
        <MonthlyReturnHeatmap values={advanced.monthlyReturns} />
      </div>
      <BacktestRiskAndExposure advanced={advanced} theme={theme} />
      <BacktestCostAndTrades advanced={advanced} />
      <BacktestDataQuality advanced={advanced} benchmarkName={result.benchmark?.name} theme={theme} />
    </>
  );
}
