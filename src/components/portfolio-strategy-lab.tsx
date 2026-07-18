import { useEffect, useMemo, useRef, useState } from "react";
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Activity, Ban, FlaskConical, LoaderCircle, Play, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { LazyJsonDetails } from "@/components/lazy-json-details";
import { PortfolioResearchTools, type AnalysisRunChoice } from "@/components/portfolio-research-tools";
import { StockSwatch } from "@/components/stock-swatch";
import { cancelAdvancedAnalysis, loadAdvancedArtifact, runAdvancedAnalysis, type AdvancedAnalysisOperation } from "@/lib/advanced-analysis";
import { normalizedBacktestWeights, parseNumberList, parseSymbolList } from "@/lib/backtest-config";
import { formatMoney, formatPercent } from "@/lib/format";
import { stockColor } from "@/lib/stock-appearance";
import { cn } from "@/lib/utils";
import type { AdvancedRunSnapshot, BacktestRebalanceFrequency, BacktestRunConfiguration, Theme } from "@/types";

type LabMode = "compare" | "sensitivity" | "stress" | "optimization" | "walk-forward" | "monte-carlo" | "research";
type SensitivityMode = "weight" | "start-date" | "rebalance" | "cash-flow";
type BacktestRunChoice = AnalysisRunChoice;
type StressDraft = {
  id: number;
  name: string;
  startDate: string;
  endDate: string;
  transactionCostBps: string;
  monthlyCashFlow: string;
  cashFlowFrequency: "inherit" | "monthly" | "quarterly" | "annually";
  cashFlowTiming: "inherit" | "period_start" | "period_end";
  currencyMode: "inherit" | "local" | "KRW";
  rebalanceFrequency: "inherit" | BacktestRebalanceFrequency;
  thresholdPercent: string;
  excludeSymbols: string;
};

const modeOptions: Array<{ value: LabMode; label: string }> = [
  { value: "compare", label: "실행 비교" },
  { value: "sensitivity", label: "민감도" },
  { value: "stress", label: "스트레스" },
  { value: "optimization", label: "최적화" },
  { value: "walk-forward", label: "Walk-forward" },
  { value: "monte-carlo", label: "Monte Carlo" },
  { value: "research", label: "연구 도구" },
];

const objectiveOptions = [
  ["robust_score", "강건 점수"], ["max_sharpe", "최대 Sharpe"], ["max_sortino", "최대 Sortino"],
  ["max_calmar", "최대 Calmar"], ["min_volatility", "최소 변동성"], ["min_cvar", "최소 CVaR"],
  ["max_information_ratio", "최대 Information Ratio"],
] as const;

const rebalanceModes: BacktestRebalanceFrequency[] = ["none", "monthly", "quarterly", "annually", "threshold"];

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function numeric(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const result = Number(value);
  return Number.isFinite(result) ? result : undefined;
}

function percentDecimal(value: unknown): string {
  const parsed = numeric(value);
  return parsed === undefined ? "-" : formatPercent(parsed * 100, true);
}

function percentValue(value: unknown): string {
  const parsed = numeric(value);
  return parsed === undefined ? "-" : formatPercent(parsed, true);
}

function ratio(value: unknown): string {
  const parsed = numeric(value);
  return parsed === undefined ? "-" : parsed.toFixed(3);
}

function scenarioConfigLabel(value: unknown): string {
  const config = record(value);
  const details: string[] = [];
  const assets = array(config.assets).map(record);
  if (assets.length) {
    details.push(assets.map((asset) => `${String(asset.symbol ?? "-")} ${numeric(asset.weight)?.toFixed(1) ?? "-"}%`).join(" · "));
  }
  if (typeof config.startDate === "string") details.push(`시작 ${config.startDate}`);
  if (typeof config.rebalanceFrequency === "string") {
    details.push(`${config.rebalanceFrequency}${config.rebalanceThresholdPercent !== undefined ? ` ${String(config.rebalanceThresholdPercent)}%` : ""}`);
  }
  if (config.monthlyCashFlow !== undefined) {
    details.push(`현금흐름 ${formatMoney(numeric(config.monthlyCashFlow) ?? 0, "KRW")} · ${String(config.cashFlowFrequency ?? "monthly")} · ${String(config.cashFlowTiming ?? "period_start")}`);
  }
  if (config.transactionCostBps !== undefined) details.push(`비용 ${String(config.transactionCostBps)}bp`);
  return details.join(" / ") || "기준 설정";
}

function updateOptionalWeight(
  setter: React.Dispatch<React.SetStateAction<Record<string, number>>>,
  symbol: string,
  rawValue: string,
): void {
  setter((current) => {
    const next = { ...current };
    if (rawValue === "") delete next[symbol];
    else next[symbol] = Number(rawValue);
    return next;
  });
}

function ToggleChoice({ active, children, onClick }: { active: boolean; children: React.ReactNode; onClick: () => void }) {
  return (
    <button type="button" aria-pressed={active} onClick={onClick} className={cn(
      "rounded-full border px-3 py-2 text-[11px] font-black transition-colors",
      active ? "border-foreground bg-foreground text-background" : "border-border bg-card text-muted-foreground hover:text-foreground",
    )}>{children}</button>
  );
}

function Field({ label, help, children }: { label: string; help?: string; children: React.ReactNode }) {
  return (
    <label className="rounded-[18px] bg-card p-4">
      <span className="mb-2 block text-[11px] font-bold text-muted-foreground">{label}</span>
      {children}
      {help ? <span className="mt-2 block text-[10px] leading-4 text-muted-foreground">{help}</span> : null}
    </label>
  );
}

function ProgressPanel({ run, onCancel, cancelling }: { run: AdvancedRunSnapshot; onCancel: () => void; cancelling: boolean }) {
  const progress = Math.min(100, Math.max(0, run.progress * 100));
  return (
    <div className="mt-4 rounded-[20px] bg-card p-4" aria-live="polite">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs font-black">{run.status === "cancel_requested" ? "취소 요청됨" : "Rust 계산 진행 중"}</p>
          <p className="mt-1 text-[10px] text-muted-foreground">
            {run.completedCandidates.toLocaleString("ko-KR")} / {run.totalCandidates.toLocaleString("ko-KR")} 후보
            {run.currentValidationWindow ? ` · ${run.currentValidationWindow}` : ""}
          </p>
        </div>
        <Button type="button" variant="secondary" size="sm" onClick={onCancel} disabled={cancelling || run.status === "cancel_requested"}>
          {cancelling ? <LoaderCircle className="animate-spin" /> : <Ban />}취소 요청
        </Button>
      </div>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-secondary"><div className="h-full rounded-full bg-foreground transition-[width]" style={{ width: `${Math.max(2, progress)}%` }} /></div>
      <p className="mt-2 text-right text-[10px] font-black text-muted-foreground">{progress.toFixed(0)}%</p>
    </div>
  );
}

function ScenarioResults({ result }: { result: unknown }) {
  const scenarios = array(record(result).scenarios).map(record);
  const chart = scenarios.map((scenario, index) => {
    const metrics = record(scenario.metrics ?? scenario.summary);
    return {
      name: String(scenario.name ?? scenario.label ?? `설정 ${index + 1}`).replace(/_sensitivity-/g, " "),
      return: numeric(metrics.totalReturnPercent) ?? 0,
      cagr: numeric(metrics.cagrPercent) ?? 0,
      drawdown: numeric(metrics.maxDrawdownPercent) ?? 0,
    };
  });
  return (
    <div className="space-y-4">
      <div className="h-[270px] rounded-[20px] bg-card p-3">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={chart} margin={{ top: 10, right: 6, bottom: 30, left: 0 }}>
            <CartesianGrid vertical={false} stroke="hsl(var(--chart-grid))" strokeDasharray="3 7" />
            <XAxis dataKey="name" angle={-12} textAnchor="end" interval={0} height={58} tickLine={false} axisLine={false} tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }} />
            <YAxis tickFormatter={(value) => `${Number(value).toFixed(0)}%`} width={44} tickLine={false} axisLine={false} tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }} />
            <Tooltip formatter={(value) => formatPercent(Number(value), true)} contentStyle={{ border: 0, borderRadius: 16, background: "hsl(var(--card))", color: "hsl(var(--foreground))" }} />
            <Bar dataKey="return" name="누적 수익률" fill="hsl(var(--foreground))" radius={[6, 6, 0, 0]} />
            <Bar dataKey="drawdown" name="최대 낙폭" fill="hsl(var(--muted-foreground))" radius={[6, 6, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="overflow-x-auto rounded-[20px] bg-card p-3">
        <table className="w-full min-w-[760px] text-left text-xs">
          <thead><tr className="text-muted-foreground"><th className="p-3">설정</th><th className="p-3">누적</th><th className="p-3">CAGR</th><th className="p-3">변동성</th><th className="p-3">MDD</th><th className="p-3">Sharpe</th><th className="p-3">XIRR</th><th className="p-3">거래비용</th></tr></thead>
          <tbody>{scenarios.map((scenario, index) => {
            const metrics = record(scenario.metrics ?? scenario.summary);
            return <tr key={String(scenario.id ?? index)} className="border-t border-border"><td className="p-3"><p className="font-black">{String(scenario.name ?? scenario.label ?? `설정 ${index + 1}`).replace(/_sensitivity-/g, " ")}</p><p className="mt-1 max-w-[340px] text-[9px] leading-4 text-muted-foreground">{scenarioConfigLabel(scenario.config)}</p></td><td className="p-3">{percentValue(metrics.totalReturnPercent)}</td><td className="p-3">{percentValue(metrics.cagrPercent)}</td><td className="p-3">{percentValue(metrics.annualizedVolatilityPercent)}</td><td className="p-3">{percentValue(metrics.maxDrawdownPercent)}</td><td className="p-3">{ratio(metrics.sharpeRatio)}</td><td className="p-3">{percentValue(metrics.moneyWeightedReturnPercent)}</td><td className="p-3">{formatMoney(numeric(metrics.totalTransactionCosts) ?? 0, "KRW")}</td></tr>;
          })}</tbody>
        </table>
      </div>
    </div>
  );
}

function OptimizationResults({ result, objective, theme }: { result: unknown; objective: string; theme: Theme }) {
  const data = record(result);
  const best = record(record(data.bestByObjective)[objective] ?? data.best);
  const metrics = record(best.metrics);
  const weights = Object.entries(record(best.weights)).map(([symbol, value]) => ({ symbol, value: numeric(value) ?? 0 })).sort((left, right) => right.value - left.value);
  return (
    <div className="grid gap-3 xl:grid-cols-[0.9fr_1.2fr]">
      <div className="rounded-[20px] bg-card p-5">
        <p className="text-[10px] font-black tracking-[0.12em] text-muted-foreground">BEST CANDIDATE · {String(data.candidateCount ?? 0)}개 평가</p>
        <div className="mt-4 grid grid-cols-2 gap-2 text-xs">
          {[['CAGR', percentDecimal(metrics.return)], ['변동성', percentDecimal(metrics.volatility)], ['MDD', percentDecimal(metrics.maxDrawdown)], ['Sharpe', ratio(metrics.sharpe)], ['CVaR', percentDecimal(metrics.cvar)], ['강건 점수', ratio(metrics.robustScore)]].map(([label, value]) => <div key={label} className="rounded-2xl bg-secondary p-3"><p className="text-[10px] text-muted-foreground">{label}</p><p className="mt-1 font-black">{value}</p></div>)}
        </div>
        <p className="mt-4 text-[10px] text-muted-foreground">Pareto frontier {(numeric(data.paretoCount) ?? array(data.paretoFrontier).length).toLocaleString("ko-KR")}개 · seed {String(data.seed ?? "-")}</p>
      </div>
      <div className="rounded-[20px] bg-card p-5">
        <p className="text-xs font-black">추천 비중</p>
        <div className="mt-4 space-y-3">{weights.map((item) => <div key={item.symbol}><div className="flex justify-between gap-3 text-xs"><span className="flex items-center gap-2 font-black"><StockSwatch symbol={item.symbol} theme={theme} />{item.symbol}</span><span>{formatPercent(item.value * 100)}</span></div><div className="mt-1.5 h-2 overflow-hidden rounded-full bg-secondary"><div className="h-full rounded-full" style={{ width: `${item.value * 100}%`, backgroundColor: stockColor(item.symbol, theme) }} /></div></div>)}</div>
      </div>
    </div>
  );
}

function WalkForwardResults({ result, run, onUnauthorized }: { result: unknown; run?: AdvancedRunSnapshot; onUnauthorized: () => void }) {
  const [loadedResult, setLoadedResult] = useState<unknown>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { setLoadedResult(undefined); setError(""); }, [run?.runId, result]);
  const rawData = loadedResult ?? result;
  const data = Array.isArray(rawData) ? { folds: rawData } : record(rawData);
  const summary = record(data.oosSummary ?? data.oos_summary ?? data.summary);
  const allFolds = array(data.folds).map(record);
  const folds = allFolds.slice(0, 500);
  const loadFolds = async () => {
    if (!run?.runId) return;
    setLoading(true);
    setError("");
    try { setLoadedResult(await loadAdvancedArtifact(run.runId, "walk-forward", onUnauthorized)); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Walk-forward fold를 불러오지 못했습니다."); }
    finally { setLoading(false); }
  };
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[['검증 fold', String(summary.foldCount ?? summary.fold_count ?? allFolds.length)], ['평균 OOS', percentDecimal(summary.averageReturn)], ['최악 OOS', percentDecimal(summary.worstReturn)], ['최고 OOS', percentDecimal(summary.bestReturn)]].map(([label, value]) => <div key={label} className="rounded-[18px] bg-card p-4"><p className="text-[10px] text-muted-foreground">{label}</p><p className="mt-2 text-sm font-black">{value}</p></div>)}
      </div>
      {data.foldsExternalized && loadedResult === undefined ? <div className="rounded-[18px] bg-card p-4"><p className="text-xs text-muted-foreground">대용량 fold 상세는 별도 artifact로 보관했습니다. 화면에는 최대 500개 fold를 표시합니다.</p><Button type="button" variant="secondary" size="sm" className="mt-3" onClick={() => void loadFolds()} disabled={loading}>{loading ? <LoaderCircle className="animate-spin" /> : <Activity />}Walk-forward fold 불러오기</Button></div> : null}
      {error ? <p className="text-xs text-rose-500">{error}</p> : null}
      {folds.length ? <div className="overflow-x-auto rounded-[20px] bg-card p-3"><table className="w-full min-w-[700px] text-left text-xs"><thead><tr className="text-muted-foreground"><th className="p-3">Fold</th><th className="p-3">학습 구간</th><th className="p-3">검증 구간</th><th className="p-3">OOS 수익</th><th className="p-3">OOS MDD</th><th className="p-3">회전율</th></tr></thead><tbody>{folds.map((fold, index) => { const oos = record(fold.oos); return <tr key={index} className="border-t border-border"><td className="p-3 font-black">{index + 1}</td><td className="p-3">{String(fold.trainStart ?? fold.trainStartDate ?? fold.train_start_date ?? "-")}~{String(fold.trainEnd ?? fold.trainEndDate ?? fold.train_end_date ?? "-")}</td><td className="p-3">{String(fold.testStart ?? fold.testStartDate ?? fold.test_start_date ?? "-")}~{String(fold.testEnd ?? fold.testEndDate ?? fold.test_end_date ?? "-")}</td><td className="p-3">{percentDecimal(oos.return)}</td><td className="p-3">{percentDecimal(oos.maxDrawdown)}</td><td className="p-3">{percentDecimal(oos.turnover)}</td></tr>; })}</tbody></table>{allFolds.length > folds.length ? <p className="p-3 text-[10px] text-muted-foreground">전체 {allFolds.length.toLocaleString("ko-KR")}개 중 앞 500개를 표시합니다.</p> : null}</div> : null}
    </div>
  );
}

function MonteCarloResults({ result, run, onUnauthorized }: { result: unknown; run?: AdvancedRunSnapshot; onUnauthorized: () => void }) {
  const data = record(result);
  const probabilities = record(data.probabilities);
  const distributions = record(data.distributions);
  const terminal = record(distributions.terminalBalance);
  const [loadedPercentiles, setLoadedPercentiles] = useState<unknown[]>();
  const [loadingPercentiles, setLoadingPercentiles] = useState(false);
  const [percentileError, setPercentileError] = useState("");
  const rawPaths = (loadedPercentiles ?? array(data.percentilePaths)).map(record);
  const paths = rawPaths.map((path) => {
    const values = array(path.points);
    if (values.length <= 500) return path;
    const stride = Math.ceil((values.length - 1) / 499);
    const points = values.filter((_, index) => index % stride === 0);
    const last = values.at(-1);
    if (last !== undefined && points.at(-1) !== last) points.push(last);
    return { ...path, points };
  });
  const points = new Map<number, Record<string, number>>();
  for (const path of paths) {
    const quantile = numeric(path.quantile) ?? 0;
    for (const pointValue of array(path.points).map(record)) {
      const step = numeric(pointValue.step) ?? 0;
      const point = points.get(step) ?? { step };
      point[`q${Math.round(quantile * 100)}`] = numeric(pointValue.balance) ?? 0;
      points.set(step, point);
    }
  }
  const chart = Array.from(points.values()).sort((left, right) => left.step - right.step);
  const percentileValues = array(terminal.percentiles).map(record);
  const [loadedSamples, setLoadedSamples] = useState<unknown[]>();
  const [loadingSamples, setLoadingSamples] = useState(false);
  const [sampleError, setSampleError] = useState("");
  useEffect(() => {
    setLoadedPercentiles(undefined);
    setPercentileError("");
    setLoadedSamples(undefined);
    setSampleError("");
  }, [run?.runId, result]);
  const samplePaths = (loadedSamples ?? array(data.samplePaths)).map(record).slice(0, 10);
  const samplePoints = new Map<number, Record<string, number>>();
  for (const path of samplePaths) {
    const pathIndex = numeric(path.pathIndex) ?? 0;
    for (const pointValue of array(path.points).map(record)) {
      const step = numeric(pointValue.step) ?? 0;
      const point = samplePoints.get(step) ?? { step };
      point[`p${pathIndex}`] = numeric(pointValue.balance) ?? 0;
      samplePoints.set(step, point);
    }
  }
  const sampleChart = Array.from(samplePoints.values()).sort((left, right) => left.step - right.step);
  const loadSamples = async () => {
    if (!run?.runId) return;
    setLoadingSamples(true);
    setSampleError("");
    try { setLoadedSamples(array(await loadAdvancedArtifact(run.runId, "monte-carlo-sample-paths", onUnauthorized))); }
    catch (caught) { setSampleError(caught instanceof Error ? caught.message : "표본 경로를 불러오지 못했습니다."); }
    finally { setLoadingSamples(false); }
  };
  const loadPercentiles = async () => {
    if (!run?.runId) return;
    setLoadingPercentiles(true);
    setPercentileError("");
    try { setLoadedPercentiles(array(await loadAdvancedArtifact(run.runId, "monte-carlo-percentile-paths", onUnauthorized))); }
    catch (caught) { setPercentileError(caught instanceof Error ? caught.message : "분위수 경로를 불러오지 못했습니다."); }
    finally { setLoadingPercentiles(false); }
  };
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <div className="rounded-[18px] bg-card p-4"><p className="text-[10px] text-muted-foreground">평균 최종 잔액</p><p className="mt-2 text-sm font-black">{formatMoney(numeric(terminal.mean) ?? 0, "KRW")}</p></div>
        <div className="rounded-[18px] bg-card p-4"><p className="text-[10px] text-muted-foreground">손실 종료 확률</p><p className="mt-2 text-sm font-black">{percentValue(probabilities.terminalLossProbabilityPercent)}</p></div>
        <div className="rounded-[18px] bg-card p-4"><p className="text-[10px] text-muted-foreground">중간 고갈 확률</p><p className="mt-2 text-sm font-black">{percentValue(probabilities.everDepletedProbabilityPercent)}</p></div>
        <div className="rounded-[18px] bg-card p-4"><p className="text-[10px] text-muted-foreground">목표 달성 확률</p><p className="mt-2 text-sm font-black">{probabilities.terminalGoalProbabilityPercent === undefined ? "목표 없음" : percentValue(probabilities.terminalGoalProbabilityPercent)}</p></div>
      </div>
      {data.percentilePathsExternalized && !loadedPercentiles ? <div className="rounded-[18px] bg-card p-4"><p className="text-xs text-muted-foreground">분위수 경로는 대용량 응답을 피하기 위해 별도 artifact로 보관했습니다. 불러온 뒤 경로당 최대 500점으로 표시합니다.</p><Button type="button" variant="secondary" size="sm" className="mt-3" onClick={() => void loadPercentiles()} disabled={loadingPercentiles}>{loadingPercentiles ? <LoaderCircle className="animate-spin" /> : <Activity />}분위수 경로 불러오기</Button></div> : null}
      {percentileError ? <p className="text-xs text-rose-500">{percentileError}</p> : null}
      {chart.length ? <div className="h-[320px] rounded-[20px] bg-card p-3"><ResponsiveContainer width="100%" height="100%"><LineChart data={chart}><CartesianGrid vertical={false} stroke="hsl(var(--chart-grid))" strokeDasharray="3 7" /><XAxis dataKey="step" tickLine={false} axisLine={false} tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }} /><YAxis tickFormatter={(value) => formatMoney(Number(value), "KRW", true)} width={60} tickLine={false} axisLine={false} tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }} /><Tooltip formatter={(value) => formatMoney(Number(value), "KRW")} contentStyle={{ border: 0, borderRadius: 16, background: "hsl(var(--card))", color: "hsl(var(--foreground))" }} />{paths.map((path, index) => { const q = Math.round((numeric(path.quantile) ?? 0) * 100); return <Line key={q} type="monotone" dataKey={`q${q}`} name={`${q}% 경로`} stroke={`hsl(0 0% ${25 + index * 14}%)`} strokeWidth={q === 50 ? 3 : 1.5} dot={false} />; })}</LineChart></ResponsiveContainer></div> : null}
      <div className="flex flex-wrap gap-2">{percentileValues.map((item) => <span key={String(item.quantile)} className="rounded-full bg-card px-3 py-2 text-[10px] font-black">Q{Math.round((numeric(item.quantile) ?? 0) * 100)} {formatMoney(numeric(item.value) ?? 0, "KRW")}</span>)}</div>
      {data.samplePathsExternalized && !loadedSamples ? <div className="rounded-[18px] bg-card p-4"><p className="text-xs text-muted-foreground">표본 경로는 응답 정지를 막기 위해 별도 artifact로 보관했습니다.</p><Button type="button" variant="secondary" size="sm" className="mt-3" onClick={() => void loadSamples()} disabled={loadingSamples}>{loadingSamples ? <LoaderCircle className="animate-spin" /> : <Activity />}표본 경로 불러오기</Button></div> : null}
      {sampleError ? <p className="text-xs text-rose-500">{sampleError}</p> : null}
      {sampleChart.length ? <div><p className="mb-2 text-xs font-black">표본 경로 · 최대 10개 표시</p><div className="h-[280px] rounded-[20px] bg-card p-3"><ResponsiveContainer width="100%" height="100%"><LineChart data={sampleChart}><CartesianGrid vertical={false} stroke="hsl(var(--chart-grid))" strokeDasharray="3 7" /><XAxis dataKey="step" tickLine={false} axisLine={false} tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }} /><YAxis tickFormatter={(value) => formatMoney(Number(value), "KRW", true)} width={60} tickLine={false} axisLine={false} tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }} /><Tooltip formatter={(value) => formatMoney(Number(value), "KRW")} contentStyle={{ border: 0, borderRadius: 16, background: "hsl(var(--card))", color: "hsl(var(--foreground))" }} />{samplePaths.map((path, index) => { const id = numeric(path.pathIndex) ?? index; return <Line key={id} type="monotone" dataKey={`p${id}`} name={`표본 ${id}`} stroke={`hsl(0 0% ${25 + index * 6}%)`} strokeWidth={1.3} dot={false} />; })}</LineChart></ResponsiveContainer></div></div> : null}
    </div>
  );
}

function CompareResults({ result }: { result: unknown }) {
  const data = record(result);
  const runs = array(data.runs).map(record);
  const pareto = new Set(array(data.pareto_run_ids).map(String));
  return <div className="overflow-x-auto rounded-[20px] bg-card p-3"><table className="w-full min-w-[800px] text-left text-xs"><thead><tr className="text-muted-foreground"><th className="p-3">실행</th><th className="p-3">CAGR</th><th className="p-3">변동성</th><th className="p-3">MDD</th><th className="p-3">Sharpe</th><th className="p-3">연도 분산</th><th className="p-3">추정 비용</th></tr></thead><tbody>{runs.map((run) => { const summary = record(run.summary); const stability = record(run.stability); const cost = record(run.cost); const id = String(run.run_id); return <tr key={id} className="border-t border-border"><td className="p-3"><p className="font-black">{id.slice(0, 8)}</p>{pareto.has(id) ? <span className="text-[9px] text-muted-foreground">PARETO</span> : null}</td><td className="p-3">{percentValue(summary.cagrPercent)}</td><td className="p-3">{percentValue(summary.annualizedVolatilityPercent)}</td><td className="p-3">{percentValue(summary.maxDrawdownPercent)}</td><td className="p-3">{ratio(summary.sharpeRatio)}</td><td className="p-3">{percentValue(stability.annual_return_dispersion_percent)}</td><td className="p-3">{formatMoney(numeric(cost.estimatedTotalCost) ?? 0, "KRW")}</td></tr>; })}</tbody></table></div>;
}

export function PortfolioStrategyLab({
  baseConfig,
  canAnalyze,
  backtestRuns,
  theme,
  onUnauthorized,
}: {
  baseConfig: BacktestRunConfiguration;
  canAnalyze: boolean;
  backtestRuns: BacktestRunChoice[];
  theme: Theme;
  onUnauthorized: () => void;
}) {
  const [mode, setMode] = useState<LabMode>("sensitivity");
  const [sensitivityMode, setSensitivityMode] = useState<SensitivityMode>("rebalance");
  const [selectedRuns, setSelectedRuns] = useState<string[]>([]);
  const [targetSymbol, setTargetSymbol] = useState(baseConfig.assets[0]?.symbol ?? "");
  const [targetWeights, setTargetWeights] = useState("10, 25, 40, 55");
  const [offsetDays, setOffsetDays] = useState("-90, -30, 0, 30, 90");
  const [selectedRebalances, setSelectedRebalances] = useState<BacktestRebalanceFrequency[]>(["none", "quarterly", "annually", "threshold"]);
  const [sensitivityThreshold, setSensitivityThreshold] = useState(5);
  const [cashAmounts, setCashAmounts] = useState("0, 500000, 1000000");
  const [cashFrequencies, setCashFrequencies] = useState<Array<"monthly" | "quarterly" | "annually">>(["monthly"]);
  const [cashTimings, setCashTimings] = useState<Array<"period_start" | "period_end">>(["period_start", "period_end"]);
  const [stressScenarios, setStressScenarios] = useState<StressDraft[]>([
    { id: 1, name: "기준 설정", startDate: "", endDate: "", transactionCostBps: "", monthlyCashFlow: "", cashFlowFrequency: "inherit", cashFlowTiming: "inherit", currencyMode: "inherit", rebalanceFrequency: "inherit", thresholdPercent: "", excludeSymbols: "" },
    { id: 2, name: "고비용 · 무납입", startDate: "", endDate: "", transactionCostBps: "50", monthlyCashFlow: "0", cashFlowFrequency: "inherit", cashFlowTiming: "inherit", currencyMode: "inherit", rebalanceFrequency: "inherit", thresholdPercent: "", excludeSymbols: "" },
  ]);
  const [objective, setObjective] = useState("robust_score");
  const [optimizationBenchmark, setOptimizationBenchmark] = useState("");
  const [candidateBudget, setCandidateBudget] = useState(500);
  const [seed, setSeed] = useState(12345);
  const [minWeightPercent, setMinWeightPercent] = useState(0);
  const [maxWeightPercent, setMaxWeightPercent] = useState(100);
  const [maxAssets, setMaxAssets] = useState(baseConfig.assets.length);
  const [requiredAssets, setRequiredAssets] = useState<string[]>([]);
  const [excludedAssets, setExcludedAssets] = useState<string[]>([]);
  const [perAssetMinimums, setPerAssetMinimums] = useState<Record<string, number>>({});
  const [perAssetMaximums, setPerAssetMaximums] = useState<Record<string, number>>({});
  const [maxDrawdownPercent, setMaxDrawdownPercent] = useState<string>("");
  const [targetReturnPercent, setTargetReturnPercent] = useState<string>("");
  const [maxTurnoverPercent, setMaxTurnoverPercent] = useState<string>("");
  const [trainWindow, setTrainWindow] = useState(252);
  const [testWindow, setTestWindow] = useState(63);
  const [step, setStep] = useState(63);
  const [horizonDays, setHorizonDays] = useState(252);
  const [pathCount, setPathCount] = useState(10_000);
  const [blockLength, setBlockLength] = useState(20);
  const [goalAmount, setGoalAmount] = useState<string>("");
  const [quantiles, setQuantiles] = useState("5, 25, 50, 75, 95");
  const [samplePathCount, setSamplePathCount] = useState(10);
  const [running, setRunning] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [run, setRun] = useState<AdvancedRunSnapshot>();
  const [result, setResult] = useState<unknown>();
  const [resultMode, setResultMode] = useState<LabMode>();
  const [resultObjective, setResultObjective] = useState("robust_score");
  const [resultConfigFingerprint, setResultConfigFingerprint] = useState("");
  const [resultConfigLabel, setResultConfigLabel] = useState("");
  const [optimizationRuns, setOptimizationRuns] = useState<AnalysisRunChoice[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState("");
  const controller = useRef<AbortController | undefined>(undefined);
  const analysisInputFingerprint = JSON.stringify({
    baseConfig,
    mode,
    sensitivityMode,
    selectedRuns,
    targetSymbol,
    targetWeights,
    offsetDays,
    selectedRebalances,
    sensitivityThreshold,
    cashAmounts,
    cashFrequencies,
    cashTimings,
    stressScenarios,
    objective,
    optimizationBenchmark,
    candidateBudget,
    seed,
    minWeightPercent,
    maxWeightPercent,
    maxAssets,
    requiredAssets,
    excludedAssets,
    perAssetMinimums,
    perAssetMaximums,
    maxDrawdownPercent,
    targetReturnPercent,
    maxTurnoverPercent,
    trainWindow,
    testWindow,
    step,
    horizonDays,
    pathCount,
    blockLength,
    goalAmount,
    quantiles,
    samplePathCount,
  });

  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    if (!baseConfig.assets.some((asset) => asset.symbol === targetSymbol)) setTargetSymbol(baseConfig.assets[0]?.symbol ?? "");
  }, [baseConfig.assets, targetSymbol]);
  useEffect(() => {
    const symbols = new Set(baseConfig.assets.map((asset) => asset.symbol));
    if (baseConfig.assets.length) setMaxAssets((current) => current < 1 || current > baseConfig.assets.length ? baseConfig.assets.length : current);
    setRequiredAssets((current) => current.filter((symbol) => symbols.has(symbol)));
    setExcludedAssets((current) => current.filter((symbol) => symbols.has(symbol)));
    setPerAssetMinimums((current) => Object.fromEntries(Object.entries(current).filter(([symbol]) => symbols.has(symbol))));
    setPerAssetMaximums((current) => Object.fromEntries(Object.entries(current).filter(([symbol]) => symbols.has(symbol))));
  }, [baseConfig.assets]);

  const optimizationBody = useMemo(() => ({
    symbols: baseConfig.assets.map((asset) => asset.symbol),
    fromDate: baseConfig.startDate,
    toDate: baseConfig.endDate,
    currencyMode: baseConfig.currencyMode,
    ...(optimizationBenchmark.trim() ? { benchmark: optimizationBenchmark.trim().toUpperCase() } : {}),
    objective,
    minWeight: minWeightPercent / 100,
    maxWeight: maxWeightPercent / 100,
    minWeights: Object.fromEntries(Object.entries(perAssetMinimums).filter(([, value]) => value >= 0).map(([symbol, value]) => [symbol, value / 100])),
    maxWeights: Object.fromEntries(Object.entries(perAssetMaximums).filter(([, value]) => value >= 0).map(([symbol, value]) => [symbol, value / 100])),
    maxAssets,
    requiredAssets,
    excludedAssets,
    ...(maxDrawdownPercent !== "" ? { maxDrawdown: Number(maxDrawdownPercent) / 100 } : {}),
    ...(targetReturnPercent !== "" ? { targetReturn: Number(targetReturnPercent) / 100 } : {}),
    ...(maxTurnoverPercent !== "" ? { maxTurnover: Number(maxTurnoverPercent) / 100 } : {}),
    currentWeights: normalizedBacktestWeights(baseConfig),
    transactionCostBps: baseConfig.transactionCostBps,
    riskFreeRatePercent: baseConfig.riskFreeRatePercent,
    seed,
    candidateBudget,
  }), [baseConfig, candidateBudget, excludedAssets, maxAssets, maxDrawdownPercent, maxTurnoverPercent, maxWeightPercent, minWeightPercent, objective, optimizationBenchmark, perAssetMaximums, perAssetMinimums, requiredAssets, seed, targetReturnPercent]);

  const submit = async () => {
    if (mode === "research") return;
    const submittedFingerprint = analysisInputFingerprint;
    const submittedLabel = `${baseConfig.startDate}~${baseConfig.endDate} · ${baseConfig.assets.map((asset) => `${asset.symbol} ${asset.weight.toFixed(1)}%`).join(" · ")} · ${baseConfig.currencyMode}`;
    const submittedObjective = objective;
    let operation: AdvancedAnalysisOperation;
    let body: unknown;
    if (mode === "compare") {
      operation = "compare-backtests";
      body = { runIds: selectedRuns };
    } else if (mode === "sensitivity") {
      if (sensitivityMode === "weight") {
        operation = "sensitivity-weight";
        body = { baseConfig, targetSymbol, targetWeights: parseNumberList(targetWeights).map((value) => value / 100) };
      } else if (sensitivityMode === "start-date") {
        operation = "sensitivity-start-date";
        body = { baseConfig, offsetsDays: parseNumberList(offsetDays) };
      } else if (sensitivityMode === "rebalance") {
        operation = "sensitivity-rebalance";
        body = { baseConfig, modes: selectedRebalances, thresholdPercent: sensitivityThreshold };
      } else {
        operation = "sensitivity-cash-flow";
        body = { baseConfig, monthlyAmounts: parseNumberList(cashAmounts), frequencies: cashFrequencies, timings: cashTimings };
      }
    } else if (mode === "stress") {
      operation = "stress-test";
      body = { baseConfig, scenarios: stressScenarios.map((scenario) => ({
        name: scenario.name,
        ...(scenario.startDate ? { startDate: scenario.startDate } : {}),
        ...(scenario.endDate ? { endDate: scenario.endDate } : {}),
        ...(scenario.transactionCostBps !== "" ? { transactionCostBps: Number(scenario.transactionCostBps) } : {}),
        ...(scenario.monthlyCashFlow !== "" ? { monthlyCashFlow: Number(scenario.monthlyCashFlow) } : {}),
        ...(scenario.cashFlowFrequency !== "inherit" ? { cashFlowFrequency: scenario.cashFlowFrequency } : {}),
        ...(scenario.cashFlowTiming !== "inherit" ? { cashFlowTiming: scenario.cashFlowTiming } : {}),
        ...(scenario.currencyMode !== "inherit" ? { currencyMode: scenario.currencyMode } : {}),
        ...(scenario.rebalanceFrequency !== "inherit" ? { rebalanceFrequency: scenario.rebalanceFrequency } : {}),
        ...(scenario.rebalanceFrequency === "threshold" ? { rebalanceThresholdPercent: Number(scenario.thresholdPercent || 5) } : {}),
        ...(parseSymbolList(scenario.excludeSymbols).length ? { excludeSymbols: parseSymbolList(scenario.excludeSymbols) } : {}),
      })) };
    } else if (mode === "optimization") {
      operation = "optimization";
      body = optimizationBody;
    } else if (mode === "walk-forward") {
      operation = "walk-forward";
      body = { ...optimizationBody, trainWindow, testWindow, step };
    } else {
      operation = "monte-carlo";
      body = {
        symbols: baseConfig.assets.map((asset) => asset.symbol),
        weights: normalizedBacktestWeights(baseConfig),
        fromDate: baseConfig.startDate,
        toDate: baseConfig.endDate,
        currencyMode: baseConfig.currencyMode,
        initialAmount: baseConfig.initialAmount,
        horizonDays,
        pathCount,
        blockLength,
        seed,
        ...(goalAmount !== "" ? { goalAmount: Number(goalAmount) } : {}),
        quantiles: parseNumberList(quantiles).map((value) => value / 100),
        samplePathCount,
      };
    }
    controller.current?.abort();
    controller.current = new AbortController();
    setRunning(true);
    setError("");
    setResult(undefined);
    setWarnings([]);
    setRun(undefined);
    try {
      const completed = await runAdvancedAnalysis({ operation, body, signal: controller.current.signal, onUnauthorized, onProgress: setRun });
      setResult(completed.result);
      setWarnings(completed.warnings);
      setRun(completed.run);
      setResultMode(mode);
      setResultObjective(submittedObjective);
      setResultConfigFingerprint(submittedFingerprint);
      setResultConfigLabel(submittedLabel);
      if (mode === "optimization" && completed.run?.runId) {
        setOptimizationRuns((current) => [{ runId: completed.run!.runId, label: `${new Date().toLocaleTimeString("ko-KR")} · ${submittedObjective}` }, ...current.filter((item) => item.runId !== completed.run!.runId)].slice(0, 20));
      }
    } catch (caught) {
      if (!(caught instanceof DOMException && caught.name === "AbortError")) setError(caught instanceof Error ? caught.message : "고급 분석을 실행하지 못했습니다.");
    } finally {
      setRunning(false);
    }
  };

  const requestCancel = async () => {
    if (!run?.runId) return;
    setCancelling(true);
    try { setRun(await cancelAdvancedAnalysis(run.runId, onUnauthorized)); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "취소를 요청하지 못했습니다."); }
    finally { setCancelling(false); }
  };

  const canSubmit = canAnalyze && !running && (mode !== "compare" || selectedRuns.length >= 2)
    && (mode !== "optimization" && mode !== "walk-forward" || baseConfig.assets.length >= 2)
    && (mode !== "optimization" && mode !== "walk-forward" || objective !== "max_information_ratio" || Boolean(optimizationBenchmark.trim()))
    && (mode !== "stress" || stressScenarios.length > 0);
  const staleResult = Boolean(resultConfigFingerprint && resultConfigFingerprint !== analysisInputFingerprint);

  return (
    <Card className="bg-secondary p-5 sm:p-7">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div className="max-w-2xl"><p className="flex items-center gap-2 text-xs font-bold tracking-[0.14em] text-muted-foreground"><FlaskConical className="size-4" /> RUST STRATEGY LAB</p><h3 className="mt-2 text-xl font-black tracking-[-0.035em]">비교·검증·최적화 연구실</h3><p className="mt-2 text-sm leading-6 text-muted-foreground">아래 기준 포트폴리오와 동일한 시장 데이터 계약으로 Rust worker가 병렬 계산합니다. 결과는 주문을 만들지 않습니다.</p></div>
        <span className="w-fit rounded-full bg-card px-3 py-2 text-[10px] font-black">{baseConfig.assets.length} ASSETS · {baseConfig.currencyMode === "KRW" ? "KRW FX" : "LOCAL"}</span>
      </div>
      <div className="mt-5 flex flex-wrap gap-2" aria-label="전략 분석 유형">{modeOptions.map((item) => <ToggleChoice key={item.value} active={mode === item.value} onClick={() => { setMode(item.value); setError(""); }}>{item.label}</ToggleChoice>)}</div>

      {mode === "compare" ? <div className="mt-5"><p className="text-xs font-black">완료된 백테스트 실행 2개 이상 선택</p><div className="mt-3 grid gap-2 md:grid-cols-2">{backtestRuns.map((item) => <ToggleChoice key={item.runId} active={selectedRuns.includes(item.runId)} onClick={() => setSelectedRuns((current) => current.includes(item.runId) ? current.filter((id) => id !== item.runId) : [...current, item.runId])}>{item.label}</ToggleChoice>)}</div>{backtestRuns.length < 2 ? <p className="mt-3 text-xs text-muted-foreground">위 설정을 변경해 백테스트를 두 번 이상 실행하면 수치·안정성·비용을 직접 비교할 수 있습니다.</p> : null}</div> : null}

      {mode === "sensitivity" ? <div className="mt-5 space-y-4"><div className="flex flex-wrap gap-2">{([['weight','비중'],['start-date','시작일'],['rebalance','리밸런싱'],['cash-flow','현금흐름']] as const).map(([value,label]) => <ToggleChoice key={value} active={sensitivityMode === value} onClick={() => setSensitivityMode(value)}>{label}</ToggleChoice>)}</div>
        {sensitivityMode === "weight" ? <div className="grid gap-3 md:grid-cols-2"><Field label="대상 종목"><Select value={targetSymbol} onValueChange={setTargetSymbol}><SelectTrigger className="w-full bg-secondary"><SelectValue /></SelectTrigger><SelectContent>{baseConfig.assets.map((asset) => <SelectItem key={asset.symbol} value={asset.symbol}>{asset.symbol}</SelectItem>)}</SelectContent></Select></Field><Field label="비교 비중 · %" help="쉼표로 여러 값을 입력"><Input value={targetWeights} onChange={(event) => setTargetWeights(event.target.value)} className="bg-secondary" /></Field></div> : null}
        {sensitivityMode === "start-date" ? <Field label="기준일 이동 · 달력일" help="음수는 더 이른 시작, 양수는 더 늦은 시작"><Input value={offsetDays} onChange={(event) => setOffsetDays(event.target.value)} className="bg-secondary" /></Field> : null}
        {sensitivityMode === "rebalance" ? <div className="grid gap-3 md:grid-cols-[1fr_220px]"><div className="rounded-[18px] bg-card p-4"><p className="text-[11px] font-bold text-muted-foreground">비교 방식</p><div className="mt-3 flex flex-wrap gap-2">{rebalanceModes.map((item) => <ToggleChoice key={item} active={selectedRebalances.includes(item)} onClick={() => setSelectedRebalances((current) => current.includes(item) ? current.filter((value) => value !== item) : [...current, item])}>{item}</ToggleChoice>)}</div></div><Field label="Threshold · %"><Input type="number" min={0.1} max={50} value={sensitivityThreshold} onChange={(event) => setSensitivityThreshold(Number(event.target.value))} className="bg-secondary text-right" /></Field></div> : null}
        {sensitivityMode === "cash-flow" ? <div className="space-y-3"><Field label="월 현금흐름 비교 · KRW"><Input value={cashAmounts} onChange={(event) => setCashAmounts(event.target.value)} className="bg-secondary" /></Field><div className="grid gap-3 md:grid-cols-2"><div className="rounded-[18px] bg-card p-4"><p className="text-[11px] text-muted-foreground">주기</p><div className="mt-3 flex flex-wrap gap-2">{(['monthly','quarterly','annually'] as const).map((item) => <ToggleChoice key={item} active={cashFrequencies.includes(item)} onClick={() => setCashFrequencies((current) => current.includes(item) ? current.filter((value) => value !== item) : [...current, item])}>{item}</ToggleChoice>)}</div></div><div className="rounded-[18px] bg-card p-4"><p className="text-[11px] text-muted-foreground">시점</p><div className="mt-3 flex flex-wrap gap-2">{(['period_start','period_end'] as const).map((item) => <ToggleChoice key={item} active={cashTimings.includes(item)} onClick={() => setCashTimings((current) => current.includes(item) ? current.filter((value) => value !== item) : [...current, item])}>{item}</ToggleChoice>)}</div></div></div></div> : null}
      </div> : null}

      {mode === "stress" ? <div className="mt-5 space-y-3">{stressScenarios.map((scenario, index) => <div key={scenario.id} className="rounded-[20px] bg-card p-4"><div className="flex items-center justify-between"><p className="text-xs font-black">시나리오 {index + 1}</p><Button type="button" variant="ghost" size="icon" disabled={stressScenarios.length <= 1} onClick={() => setStressScenarios((current) => current.filter((item) => item.id !== scenario.id))}><Trash2 /></Button></div><div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4"><Input aria-label="시나리오 이름" value={scenario.name} onChange={(event) => setStressScenarios((current) => current.map((item) => item.id === scenario.id ? { ...item, name: event.target.value } : item))} placeholder="시나리오 이름" className="bg-secondary" /><Input type="date" aria-label="스트레스 시작일" value={scenario.startDate} onChange={(event) => setStressScenarios((current) => current.map((item) => item.id === scenario.id ? { ...item, startDate: event.target.value } : item))} className="bg-secondary" /><Input type="date" aria-label="스트레스 종료일" value={scenario.endDate} onChange={(event) => setStressScenarios((current) => current.map((item) => item.id === scenario.id ? { ...item, endDate: event.target.value } : item))} className="bg-secondary" /><Input type="number" aria-label="시나리오 거래비용" value={scenario.transactionCostBps} onChange={(event) => setStressScenarios((current) => current.map((item) => item.id === scenario.id ? { ...item, transactionCostBps: event.target.value } : item))} placeholder="거래비용 bp · 상속" className="bg-secondary" /><Input type="number" aria-label="시나리오 현금흐름" value={scenario.monthlyCashFlow} onChange={(event) => setStressScenarios((current) => current.map((item) => item.id === scenario.id ? { ...item, monthlyCashFlow: event.target.value } : item))} placeholder="월 현금흐름 · 상속" className="bg-secondary" /><Select value={scenario.cashFlowFrequency} onValueChange={(value) => setStressScenarios((current) => current.map((item) => item.id === scenario.id ? { ...item, cashFlowFrequency: value as StressDraft['cashFlowFrequency'] } : item))}><SelectTrigger className="w-full bg-secondary"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="inherit">현금흐름 주기 상속</SelectItem><SelectItem value="monthly">monthly</SelectItem><SelectItem value="quarterly">quarterly</SelectItem><SelectItem value="annually">annually</SelectItem></SelectContent></Select><Select value={scenario.cashFlowTiming} onValueChange={(value) => setStressScenarios((current) => current.map((item) => item.id === scenario.id ? { ...item, cashFlowTiming: value as StressDraft['cashFlowTiming'] } : item))}><SelectTrigger className="w-full bg-secondary"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="inherit">현금흐름 시점 상속</SelectItem><SelectItem value="period_start">period_start</SelectItem><SelectItem value="period_end">period_end</SelectItem></SelectContent></Select><Select value={scenario.currencyMode} onValueChange={(value) => setStressScenarios((current) => current.map((item) => item.id === scenario.id ? { ...item, currencyMode: value as StressDraft['currencyMode'] } : item))}><SelectTrigger className="w-full bg-secondary"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="inherit">통화 모드 상속</SelectItem><SelectItem value="KRW">KRW FX</SelectItem><SelectItem value="local">local</SelectItem></SelectContent></Select><Select value={scenario.rebalanceFrequency} onValueChange={(value) => setStressScenarios((current) => current.map((item) => item.id === scenario.id ? { ...item, rebalanceFrequency: value as StressDraft['rebalanceFrequency'] } : item))}><SelectTrigger className="w-full bg-secondary"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="inherit">리밸런싱 상속</SelectItem>{rebalanceModes.map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)}</SelectContent></Select>{scenario.rebalanceFrequency === "threshold" ? <Input type="number" value={scenario.thresholdPercent} onChange={(event) => setStressScenarios((current) => current.map((item) => item.id === scenario.id ? { ...item, thresholdPercent: event.target.value } : item))} placeholder="Threshold %" className="bg-secondary" /> : null}<Input value={scenario.excludeSymbols} onChange={(event) => setStressScenarios((current) => current.map((item) => item.id === scenario.id ? { ...item, excludeSymbols: event.target.value } : item))} placeholder="제외 심볼 · 쉼표" className="bg-secondary" /></div></div>)}<Button type="button" variant="secondary" onClick={() => setStressScenarios((current) => [...current, { id: Math.max(0, ...current.map((item) => item.id)) + 1, name: `사용자 시나리오 ${current.length + 1}`, startDate: "", endDate: "", transactionCostBps: "", monthlyCashFlow: "", cashFlowFrequency: "inherit", cashFlowTiming: "inherit", currencyMode: "inherit", rebalanceFrequency: "inherit", thresholdPercent: "", excludeSymbols: "" }])} disabled={stressScenarios.length >= 50}><Plus />시나리오 추가</Button></div> : null}

      {mode === "optimization" || mode === "walk-forward" ? <div className="mt-5 space-y-3"><div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4"><Field label="목적 함수"><Select value={objective} onValueChange={setObjective}><SelectTrigger className="w-full bg-secondary"><SelectValue /></SelectTrigger><SelectContent>{objectiveOptions.map(([value,label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent></Select></Field><Field label="벤치마크 심볼 · 선택" help="Information Ratio 목적에는 필수"><Input value={optimizationBenchmark} onChange={(event) => setOptimizationBenchmark(event.target.value.toUpperCase())} placeholder="SPY, QQQ" className="bg-secondary" /></Field><Field label="후보 예산"><Input type="number" min={1} max={10000} value={candidateBudget} onChange={(event) => setCandidateBudget(Number(event.target.value))} className="bg-secondary text-right" /></Field><Field label="최소 · 최대 비중 %"><div className="grid grid-cols-2 gap-2"><Input type="number" min={0} max={100} value={minWeightPercent} onChange={(event) => setMinWeightPercent(Number(event.target.value))} className="bg-secondary text-right" /><Input type="number" min={0} max={100} value={maxWeightPercent} onChange={(event) => setMaxWeightPercent(Number(event.target.value))} className="bg-secondary text-right" /></div></Field><Field label="최대 보유 종목"><Input type="number" min={1} max={baseConfig.assets.length} value={maxAssets} onChange={(event) => setMaxAssets(Number(event.target.value))} className="bg-secondary text-right" /></Field><Field label="최대 낙폭 % · 선택"><Input type="number" min={0} max={100} value={maxDrawdownPercent} onChange={(event) => setMaxDrawdownPercent(event.target.value)} placeholder="제약 없음" className="bg-secondary text-right" /></Field><Field label="목표 CAGR % · 선택"><Input type="number" min={-100} max={1000} value={targetReturnPercent} onChange={(event) => setTargetReturnPercent(event.target.value)} placeholder="제약 없음" className="bg-secondary text-right" /></Field><Field label="최대 회전율 % · 선택"><Input type="number" min={0} max={200} value={maxTurnoverPercent} onChange={(event) => setMaxTurnoverPercent(event.target.value)} placeholder="제약 없음" className="bg-secondary text-right" /></Field><Field label="재현 seed"><Input type="number" min={0} value={seed} onChange={(event) => setSeed(Number(event.target.value))} className="bg-secondary text-right" /></Field></div>
        <div className="overflow-x-auto rounded-[20px] bg-card p-3"><table className="w-full min-w-[680px] text-left text-xs"><thead><tr className="text-muted-foreground"><th className="p-3">종목</th><th className="p-3">개별 최소 %</th><th className="p-3">개별 최대 %</th><th className="p-3">필수</th><th className="p-3">제외</th></tr></thead><tbody>{baseConfig.assets.map((asset) => <tr key={asset.symbol} className="border-t border-border"><td className="p-3 font-black"><span className="flex items-center gap-2"><StockSwatch symbol={asset.symbol} theme={theme} />{asset.symbol}</span></td><td className="p-3"><Input aria-label={`${asset.symbol} 개별 최소 비중`} type="number" min={0} max={100} value={perAssetMinimums[asset.symbol] ?? ""} onChange={(event) => updateOptionalWeight(setPerAssetMinimums, asset.symbol, event.target.value)} placeholder="전역" className="h-10 bg-secondary" /></td><td className="p-3"><Input aria-label={`${asset.symbol} 개별 최대 비중`} type="number" min={0} max={100} value={perAssetMaximums[asset.symbol] ?? ""} onChange={(event) => updateOptionalWeight(setPerAssetMaximums, asset.symbol, event.target.value)} placeholder="전역" className="h-10 bg-secondary" /></td><td className="p-3"><input aria-label={`${asset.symbol} 필수 종목`} type="checkbox" checked={requiredAssets.includes(asset.symbol)} onChange={() => { setRequiredAssets((current) => current.includes(asset.symbol) ? current.filter((value) => value !== asset.symbol) : [...current, asset.symbol]); setExcludedAssets((current) => current.filter((value) => value !== asset.symbol)); }} /></td><td className="p-3"><input aria-label={`${asset.symbol} 제외 종목`} type="checkbox" checked={excludedAssets.includes(asset.symbol)} onChange={() => { setExcludedAssets((current) => current.includes(asset.symbol) ? current.filter((value) => value !== asset.symbol) : [...current, asset.symbol]); setRequiredAssets((current) => current.filter((value) => value !== asset.symbol)); }} /></td></tr>)}</tbody></table></div>
        {mode === "walk-forward" ? <div className="grid gap-3 md:grid-cols-3"><Field label="학습 관측일"><Input type="number" min={20} max={5000} value={trainWindow} onChange={(event) => setTrainWindow(Number(event.target.value))} className="bg-secondary text-right" /></Field><Field label="검증 관측일"><Input type="number" min={5} max={2000} value={testWindow} onChange={(event) => setTestWindow(Number(event.target.value))} className="bg-secondary text-right" /></Field><Field label="이동 간격"><Input type="number" min={1} max={2000} value={step} onChange={(event) => setStep(Number(event.target.value))} className="bg-secondary text-right" /></Field></div> : null}
      </div> : null}

      {mode === "monte-carlo" ? <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-3"><Field label="미래 거래일"><Input type="number" min={1} max={25200} value={horizonDays} onChange={(event) => setHorizonDays(Number(event.target.value))} className="bg-secondary text-right" /></Field><Field label="경로 수"><Input type="number" min={100} max={100000} value={pathCount} onChange={(event) => setPathCount(Number(event.target.value))} className="bg-secondary text-right" /></Field><Field label="블록 길이"><Input type="number" min={1} max={252} value={blockLength} onChange={(event) => setBlockLength(Number(event.target.value))} className="bg-secondary text-right" /></Field><Field label="목표 금액 · 선택"><Input type="number" min={1} value={goalAmount} onChange={(event) => setGoalAmount(event.target.value)} placeholder="목표 없음" className="bg-secondary text-right" /></Field><Field label="분위수 · %" help="0보다 크고 100보다 작은 값을 쉼표로 구분"><Input value={quantiles} onChange={(event) => setQuantiles(event.target.value)} className="bg-secondary" /></Field><Field label="표본 경로 표시"><Input type="number" min={0} max={100} value={samplePathCount} onChange={(event) => setSamplePathCount(Number(event.target.value))} className="bg-secondary text-right" /></Field><Field label="재현 seed"><Input type="number" min={0} value={seed} onChange={(event) => setSeed(Number(event.target.value))} className="bg-secondary text-right" /></Field></div> : null}

      {mode === "research" ? <PortfolioResearchTools baseConfig={baseConfig} backtestRuns={backtestRuns} optimizationRuns={optimizationRuns} theme={theme} onUnauthorized={onUnauthorized} /> : null}

      {error ? <p role="alert" className="mt-4 rounded-[18px] bg-card px-4 py-3 text-sm font-semibold text-rose-500">{error}</p> : null}
      {run && ["queued", "running", "cancel_requested"].includes(run.status) ? <ProgressPanel run={run} onCancel={() => void requestCancel()} cancelling={cancelling} /> : null}
      {mode !== "research" ? <Button type="button" className="mt-5 w-full sm:w-auto" onClick={() => void submit()} disabled={!canSubmit}>{running ? <LoaderCircle className="animate-spin" /> : <Play />}{running ? "Rust worker 계산 중" : "고급 분석 실행"}</Button> : null}

      <div className={mode === "research" ? "hidden" : undefined}>
      {result !== undefined ? <div className="mt-6 border-t border-border pt-6"><div className="mb-4 flex flex-wrap items-center gap-2"><Activity className="size-4" /><p className="text-xs font-black tracking-[0.12em]">ANALYSIS RESULT</p>{staleResult ? <span className="rounded-full bg-foreground px-2 py-1 text-[9px] font-black text-background">현재 입력과 다른 실행</span> : null}<p className="w-full text-[10px] leading-4 text-muted-foreground">실행 설정 · {resultConfigLabel}</p></div>{resultMode === "compare" ? <CompareResults result={result} /> : resultMode === "optimization" ? <OptimizationResults result={result} objective={resultObjective} theme={theme} /> : resultMode === "walk-forward" ? <WalkForwardResults result={result} run={run} onUnauthorized={onUnauthorized} /> : resultMode === "monte-carlo" ? <MonteCarloResults result={result} run={run} onUnauthorized={onUnauthorized} /> : <ScenarioResults result={result} />}{warnings.length ? <div className="mt-4 rounded-[18px] bg-card p-4 text-[10px] leading-5 text-muted-foreground">{warnings.map((warning) => <p key={warning}>{warning}</p>)}</div> : null}<LazyJsonDetails value={result} className="mt-4 rounded-[18px] bg-card p-4" /></div> : null}
      </div>
    </Card>
  );
}
