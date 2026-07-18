import { useEffect, useMemo, useRef, useState } from "react";
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Activity, Ban, FlaskConical, LoaderCircle, Play, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { LazyJsonDetails } from "@/components/lazy-json-details";
import { PortfolioResearchTools, type AnalysisRunChoice } from "@/components/portfolio-research-tools";
import { ExposureResearchResults, OptimizationResearchResults, OutlookResearchResults } from "@/components/portfolio-research-results";
import { StockSwatch } from "@/components/stock-swatch";
import { cancelAdvancedAnalysis, loadAdvancedArtifact, runAdvancedAnalysis, type AdvancedAnalysisOperation } from "@/lib/advanced-analysis";
import { normalizedBacktestWeights, parseNumberList, parseSymbolList } from "@/lib/backtest-config";
import { formatMoney, formatPercent } from "@/lib/format";
import { stockColor } from "@/lib/stock-appearance";
import { parseFactorDraft } from "@/lib/research-visualization";
import {
  buildExposureAnalysisRequest,
  buildMonteCarloRequest,
  buildOptimizationRequest,
  buildOutlookMonteCarloPayload,
  buildOutlookOptimizationPayload,
  buildWalkForwardPayload,
  buildWalkForwardRequest,
  optimizerBaselines,
  parseExposureConstituentsDraft,
  parseRobustScoreWeightsDraft,
  walkForwardSeeds,
  withQuantityMode,
  type AssetGroupDimension,
  type AssetGroupMetadata,
  type CovarianceEstimator,
  type MonteCarloMethod,
  type OptimizationAlgorithm,
  type OptimizerBaseline,
  type RegimePolicyMethod,
  type RobustValidationMode,
  type WalkForwardMode,
} from "@/lib/strategy-lab-request";
import { cn } from "@/lib/utils";
import type { AdvancedRunSnapshot, BacktestInstrument, BacktestQuantityMode, BacktestRebalanceFrequency, BacktestRunConfiguration, Theme } from "@/types";

type LabMode = "compare" | "sensitivity" | "stress" | "optimization" | "walk-forward" | "monte-carlo" | "outlook" | "exposures" | "research";
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

type ExposureDraft = {
  currency: string;
  sector: string;
  industry: string;
  country: string;
  assetType: string;
  hedge: "unknown" | "hedged" | "unhedged";
  factors: string;
  constituents: string;
};

type GroupConstraintDraft = {
  id: number;
  dimension: AssetGroupDimension;
  group: string;
  minWeightPercent: string;
  maxWeightPercent: string;
};

const modeOptions: Array<{ value: LabMode; label: string }> = [
  { value: "compare", label: "실행 비교" },
  { value: "sensitivity", label: "민감도" },
  { value: "stress", label: "스트레스" },
  { value: "optimization", label: "최적화" },
  { value: "walk-forward", label: "Walk-forward" },
  { value: "monte-carlo", label: "Monte Carlo" },
  { value: "outlook", label: "미래 전망" },
  { value: "exposures", label: "노출 분석" },
  { value: "research", label: "연구 도구" },
];

const objectiveOptions = [
  ["robust_score", "강건 점수"], ["max_sharpe", "최대 Sharpe"], ["max_sortino", "최대 Sortino"],
  ["max_calmar", "최대 Calmar"], ["min_volatility", "최소 변동성"], ["min_cvar", "최소 CVaR"],
  ["max_information_ratio", "최대 Information Ratio"],
] as const;

const algorithmOptions: Array<[OptimizationAlgorithm, string]> = [
  ["random_search", "Random search"],
  ["differential_evolution", "Differential Evolution"],
  ["cma_es", "CMA-ES"],
  ["nsga_ii", "NSGA-II"],
  ["direct_cvar", "직접 CVaR"],
];

const baselineLabels: Record<OptimizerBaseline, string> = {
  equal_weight: "동일비중",
  current_weight: "현재 비중",
  inverse_volatility: "역변동성",
  minimum_variance: "최소분산",
  risk_parity: "Risk Parity / ERC",
  hrp: "HRP",
  herc: "HERC",
};

const groupDimensionOptions: Array<[AssetGroupDimension, string]> = [
  ["sector", "Sector"],
  ["industry", "Industry"],
  ["country", "Country"],
  ["currency", "Currency"],
  ["assetType", "Asset type"],
];

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
  const adjustedReturn = record(distributions.cashFlowAdjustedTerminalReturnPercent);
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
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-3 2xl:grid-cols-6">
        <div className="rounded-[18px] bg-card p-4"><p className="text-[10px] text-muted-foreground">평균 최종 잔액</p><p className="mt-2 text-sm font-black">{formatMoney(numeric(terminal.mean) ?? 0, "KRW")}</p></div>
        <div className="rounded-[18px] bg-card p-4"><p className="text-[10px] text-muted-foreground">현금흐름 조정 평균 수익률</p><p className="mt-2 text-sm font-black">{percentValue(adjustedReturn.mean)}</p><p className="mt-1 text-[9px] text-muted-foreground">(종료잔액 + 인출) / (초기자본 + 납입) − 1</p></div>
        <div className="rounded-[18px] bg-card p-4"><p className="text-[10px] text-muted-foreground">현금흐름 조정 손실 확률</p><p className="mt-2 text-sm font-black">{percentValue(probabilities.terminalLossProbabilityPercent)}</p><p className="mt-1 text-[9px] text-muted-foreground">종료잔액 + 인출 &lt; 초기자본 + 납입</p></div>
        <div className="rounded-[18px] bg-card p-4"><p className="text-[10px] text-muted-foreground">원시 잔액 하락 확률</p><p className="mt-2 text-sm font-black">{percentValue(probabilities.terminalBalanceBelowInitialProbabilityPercent)}</p><p className="mt-1 text-[9px] text-muted-foreground">현금흐름 미조정 비교</p></div>
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
  instruments,
  canAnalyze,
  backtestRuns,
  theme,
  onUnauthorized,
}: {
  baseConfig: BacktestRunConfiguration;
  instruments?: BacktestInstrument[];
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
  const [optimizationAlgorithm, setOptimizationAlgorithm] = useState<OptimizationAlgorithm>("random_search");
  const [covarianceEstimator, setCovarianceEstimator] = useState<CovarianceEstimator>("ledoit_wolf");
  const [selectedBaselines, setSelectedBaselines] = useState<OptimizerBaseline[]>([...optimizerBaselines]);
  const [ledgerValidationBudget, setLedgerValidationBudget] = useState(32);
  const [ledgerQuantityMode, setLedgerQuantityMode] = useState<BacktestQuantityMode>(baseConfig.execution.quantityMode);
  const [regimePolicyEnabled, setRegimePolicyEnabled] = useState(false);
  const [regimePolicyMethod, setRegimePolicyMethod] = useState<RegimePolicyMethod>("auto");
  const [groupConstraints, setGroupConstraints] = useState<GroupConstraintDraft[]>([]);
  const [robustScoreWeightsDraft, setRobustScoreWeightsDraft] = useState("{}");
  const [robustValidationEnabled, setRobustValidationEnabled] = useState(true);
  const [robustValidationMode, setRobustValidationMode] = useState<RobustValidationMode>("walk_forward");
  const [robustValidationWindowMode, setRobustValidationWindowMode] = useState<WalkForwardMode>("rolling");
  const [robustValidationTestPercent, setRobustValidationTestPercent] = useState(20);
  const [robustValidationTrainWindow, setRobustValidationTrainWindow] = useState(126);
  const [robustValidationTestWindow, setRobustValidationTestWindow] = useState(21);
  const [robustValidationStep, setRobustValidationStep] = useState(21);
  const [robustValidationFoldCount, setRobustValidationFoldCount] = useState(5);
  const [robustValidationGap, setRobustValidationGap] = useState(0);
  const [robustValidationEmbargo, setRobustValidationEmbargo] = useState(0);
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
  const [outlookOptimizationEnabled, setOutlookOptimizationEnabled] = useState(true);
  const [outlookSensitivityEnabled, setOutlookSensitivityEnabled] = useState(true);
  const [outlookCostShockBps, setOutlookCostShockBps] = useState(25);
  const [outlookZeroCashFlow, setOutlookZeroCashFlow] = useState(true);
  const [outlookRebalanceModes, setOutlookRebalanceModes] = useState<Array<"none" | "monthly" | "quarterly" | "annually">>(["none", "quarterly"]);
  const [outlookRegimeLookback, setOutlookRegimeLookback] = useState(20);
  const [walkForwardMode, setWalkForwardMode] = useState<WalkForwardMode>("rolling");
  const [walkForwardGap, setWalkForwardGap] = useState(0);
  const [walkForwardEmbargo, setWalkForwardEmbargo] = useState(0);
  const [foldCandidateBudget, setFoldCandidateBudget] = useState(100);
  const [additionalWalkForwardSeeds, setAdditionalWalkForwardSeeds] = useState("");
  const [monteCarloMethod, setMonteCarloMethod] = useState<MonteCarloMethod>("moving_block");
  const [monteCarloRebalance, setMonteCarloRebalance] = useState<BacktestRebalanceFrequency>(baseConfig.rebalanceFrequency);
  const [monteCarloThreshold, setMonteCarloThreshold] = useState(baseConfig.rebalanceThresholdPercent ?? 5);
  const [monteCarloCashWeightPercent, setMonteCarloCashWeightPercent] = useState(baseConfig.execution.cashTargetPercent);
  const [monteCarloCashYieldPercent, setMonteCarloCashYieldPercent] = useState(baseConfig.execution.cashAnnualYieldPercent);
  const [monteCarloTransactionCostBps, setMonteCarloTransactionCostBps] = useState(baseConfig.transactionCostBps);
  const [monteCarloPeriodicCashFlow, setMonteCarloPeriodicCashFlow] = useState(baseConfig.monthlyCashFlow);
  const [monteCarloCashFlowFrequencyDays, setMonteCarloCashFlowFrequencyDays] = useState(baseConfig.cashFlowFrequency === "monthly" ? 21 : baseConfig.cashFlowFrequency === "quarterly" ? 63 : 252);
  const [monteCarloLotSizes, setMonteCarloLotSizes] = useState<Record<string, number>>(() => Object.fromEntries(baseConfig.assets.map((asset) => [asset.symbol, asset.lotSize ?? 1])));
  const [inflationAnnualPercent, setInflationAnnualPercent] = useState(0);
  const [calibrationOrigins, setCalibrationOrigins] = useState(12);
  const [exposureLookThrough, setExposureLookThrough] = useState(true);
  const [exposureMetadata, setExposureMetadata] = useState<Record<string, ExposureDraft>>(() => Object.fromEntries(baseConfig.assets.map((asset) => {
    const instrument = instruments?.find((item) => item.symbol === asset.symbol);
    return [asset.symbol, {
      currency: instrument?.currency ?? "",
      sector: "",
      industry: "",
      country: "",
      assetType: instrument?.securityType ?? "",
      hedge: "unknown" as const,
      factors: "",
      constituents: "",
    }];
  })));
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
    optimizationAlgorithm,
    covarianceEstimator,
    selectedBaselines,
    ledgerValidationBudget,
    ledgerQuantityMode,
    regimePolicyEnabled,
    regimePolicyMethod,
    groupConstraints,
    robustScoreWeightsDraft,
    robustValidationEnabled,
    robustValidationMode,
    robustValidationWindowMode,
    robustValidationTestPercent,
    robustValidationTrainWindow,
    robustValidationTestWindow,
    robustValidationStep,
    robustValidationFoldCount,
    robustValidationGap,
    robustValidationEmbargo,
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
    outlookOptimizationEnabled,
    outlookSensitivityEnabled,
    outlookCostShockBps,
    outlookZeroCashFlow,
    outlookRebalanceModes,
    outlookRegimeLookback,
    walkForwardMode,
    walkForwardGap,
    walkForwardEmbargo,
    foldCandidateBudget,
    additionalWalkForwardSeeds,
    monteCarloMethod,
    monteCarloRebalance,
    monteCarloThreshold,
    monteCarloCashWeightPercent,
    monteCarloCashYieldPercent,
    monteCarloTransactionCostBps,
    monteCarloPeriodicCashFlow,
    monteCarloCashFlowFrequencyDays,
    monteCarloLotSizes,
    inflationAnnualPercent,
    calibrationOrigins,
    exposureLookThrough,
    exposureMetadata,
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
    setMonteCarloLotSizes((current) => Object.fromEntries(baseConfig.assets.map((asset) => [
      asset.symbol,
      current[asset.symbol] ?? asset.lotSize ?? 1,
    ])));
  }, [baseConfig.assets]);
  useEffect(() => setLedgerQuantityMode(baseConfig.execution.quantityMode), [baseConfig.execution.quantityMode]);
  useEffect(() => {
    setExposureMetadata((current) => Object.fromEntries(baseConfig.assets.map((asset) => {
      const instrument = instruments?.find((item) => item.symbol === asset.symbol);
      const existing = current[asset.symbol];
      return [asset.symbol, existing ?? {
        currency: instrument?.currency ?? "",
        sector: "",
        industry: "",
        country: "",
        assetType: instrument?.securityType ?? "",
        hedge: "unknown" as const,
        factors: "",
        constituents: "",
      }];
    })));
  }, [baseConfig.assets, instruments]);

  const robustScoreWeights = parseRobustScoreWeightsDraft(robustScoreWeightsDraft);
  const optimizationAssetGroups: Record<string, AssetGroupMetadata> = Object.fromEntries(baseConfig.assets.flatMap((asset) => {
    const metadata = exposureMetadata[asset.symbol];
    if (!metadata) return [];
    const group: AssetGroupMetadata = {};
    if (metadata.sector.trim()) group.sector = metadata.sector.trim();
    if (metadata.industry.trim()) group.industry = metadata.industry.trim();
    if (metadata.country.trim()) group.country = metadata.country.trim();
    if (metadata.currency.trim()) group.currency = metadata.currency.trim().toUpperCase();
    if (metadata.assetType.trim()) group.assetType = metadata.assetType.trim();
    return Object.keys(group).length ? [[asset.symbol, group]] : [];
  }));
  const optimizationGroupConstraints = groupConstraints.map((item) => ({
    dimension: item.dimension,
    group: item.group,
    minWeightPercent: Number(item.minWeightPercent || 0),
    maxWeightPercent: Number(item.maxWeightPercent || 100),
  }));
  const assetGroupMetadataReady = baseConfig.assets.every((asset) => {
    const metadata = exposureMetadata[asset.symbol];
    if (!metadata) return true;
    return (!metadata.currency.trim() || /^[A-Z]{3}$/.test(metadata.currency.trim().toUpperCase()))
      && (!metadata.country.trim() || metadata.country.trim().length >= 2)
      && [metadata.sector, metadata.industry, metadata.country, metadata.assetType].every((item) => item.trim().length <= 80);
  });
  const groupConstraintsReady = groupConstraints.every((item) => {
    const minimum = Number(item.minWeightPercent || 0);
    const maximum = Number(item.maxWeightPercent || 100);
    return item.group.trim().length > 0 && item.group.trim().length <= 80
      && Number.isFinite(minimum) && Number.isFinite(maximum)
      && minimum >= 0 && maximum <= 100 && minimum <= maximum;
  });
  const parsedConstituents = Object.fromEntries(baseConfig.assets.map((asset) => [
    asset.symbol,
    parseExposureConstituentsDraft(exposureMetadata[asset.symbol]?.constituents ?? ""),
  ]));

  const optimizationBody = useMemo(() => buildOptimizationRequest(baseConfig, {
    objective,
    benchmark: optimizationBenchmark,
    candidateBudget,
    seed,
    minWeightPercent,
    maxWeightPercent,
    minWeightsPercent: perAssetMinimums,
    maxWeightsPercent: perAssetMaximums,
    maxAssets,
    requiredAssets,
    excludedAssets,
    ...(maxDrawdownPercent !== "" ? { maxDrawdownPercent: Number(maxDrawdownPercent) } : {}),
    ...(targetReturnPercent !== "" ? { targetReturnPercent: Number(targetReturnPercent) } : {}),
    ...(maxTurnoverPercent !== "" ? { maxTurnoverPercent: Number(maxTurnoverPercent) } : {}),
    algorithm: optimizationAlgorithm,
    covarianceEstimator,
    baselines: selectedBaselines,
    ledgerValidationBudget,
    ledgerQuantityMode,
    regimePolicyEnabled,
    regimePolicyMethod,
    assetGroups: optimizationAssetGroups,
    groupConstraints: optimizationGroupConstraints,
    robustScoreWeights: robustScoreWeights.value,
    robustValidationEnabled,
    robustValidationMode,
    robustValidationWindowMode,
    robustValidationTestPercent,
    robustValidationTrainWindow,
    robustValidationTestWindow,
    robustValidationStep,
    robustValidationFoldCount,
    robustValidationGap,
    robustValidationEmbargo,
  }), [baseConfig, candidateBudget, covarianceEstimator, excludedAssets, groupConstraints, ledgerQuantityMode, ledgerValidationBudget, maxAssets, maxDrawdownPercent, maxTurnoverPercent, maxWeightPercent, minWeightPercent, objective, optimizationAlgorithm, optimizationBenchmark, perAssetMaximums, perAssetMinimums, regimePolicyEnabled, regimePolicyMethod, requiredAssets, robustScoreWeightsDraft, robustValidationEnabled, robustValidationEmbargo, robustValidationFoldCount, robustValidationGap, robustValidationMode, robustValidationStep, robustValidationTestPercent, robustValidationTestWindow, robustValidationTrainWindow, robustValidationWindowMode, seed, selectedBaselines, targetReturnPercent, exposureMetadata]);

  const walkForwardControls = {
    mode: walkForwardMode,
    trainWindow,
    testWindow,
    step,
    gap: walkForwardGap,
    embargo: walkForwardEmbargo,
    foldCandidateBudget,
    seed,
    additionalSeeds: additionalWalkForwardSeeds,
  };
  const monteCarloControls = {
    method: monteCarloMethod,
    horizonDays,
    pathCount,
    blockLength,
    seed,
    ...(goalAmount !== "" ? { goalAmount: Number(goalAmount) } : {}),
    quantiles: parseNumberList(quantiles).map((value) => value / 100),
    samplePathCount,
    rebalanceFrequency: monteCarloRebalance,
    ...(monteCarloRebalance === "threshold" ? { rebalanceThresholdPercent: monteCarloThreshold } : {}),
    cashWeightPercent: monteCarloCashWeightPercent,
    cashAnnualYieldPercent: monteCarloCashYieldPercent,
    transactionCostBps: monteCarloTransactionCostBps,
    periodicCashFlow: monteCarloPeriodicCashFlow,
    cashFlowFrequencyDays: monteCarloCashFlowFrequencyDays,
    inflationAnnualPercent,
    quantityMode: ledgerQuantityMode,
    lotSizes: monteCarloLotSizes,
    calibrationOrigins,
  };

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
      body = buildWalkForwardRequest(optimizationBody, walkForwardControls);
    } else if (mode === "monte-carlo") {
      operation = "monte-carlo";
      body = buildMonteCarloRequest(baseConfig, monteCarloControls);
    } else if (mode === "outlook") {
      operation = "outlook";
      body = {
        baseConfig: withQuantityMode(baseConfig, ledgerQuantityMode),
        optimization: buildOutlookOptimizationPayload({
          enabled: outlookOptimizationEnabled,
          objective,
          benchmark: optimizationBenchmark,
          candidateBudget,
          minWeightPercent,
          maxWeightPercent,
          algorithm: optimizationAlgorithm,
          covarianceEstimator,
          baselines: selectedBaselines,
          ledgerValidationBudget,
          regimePolicyEnabled,
          regimePolicyMethod,
          assetGroups: optimizationAssetGroups,
          groupConstraints: optimizationGroupConstraints,
          robustScoreWeights: robustScoreWeights.value,
          robustValidationEnabled,
          robustValidationMode,
          robustValidationWindowMode,
          robustValidationTestPercent,
          robustValidationTrainWindow,
          robustValidationTestWindow,
          robustValidationStep,
          robustValidationFoldCount,
          robustValidationGap,
          robustValidationEmbargo,
        }),
        walkForward: buildWalkForwardPayload(walkForwardControls),
        monteCarlo: buildOutlookMonteCarloPayload(monteCarloControls),
        stressScenarios: stressScenarios.map((scenario) => ({
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
        })),
        sensitivity: {
          enabled: outlookSensitivityEnabled,
          transactionCostShockBps: outlookCostShockBps,
          includeZeroCashFlow: outlookZeroCashFlow,
          rebalanceModes: outlookRebalanceModes,
        },
        marketRegime: { enabled: true, lookback: outlookRegimeLookback },
        confidenceWeights: { oos: 0.45, monteCarloCalibration: 0.35, dataQuality: 0.2 },
      };
    } else {
      operation = "exposures";
      const weights = normalizedBacktestWeights(baseConfig);
      body = buildExposureAnalysisRequest(
        baseConfig.assets.map((asset) => {
          const metadata = exposureMetadata[asset.symbol] ?? { currency: "", sector: "", industry: "", country: "", assetType: "", hedge: "unknown", factors: "", constituents: "" };
          return {
            symbol: asset.symbol,
            weight: weights[asset.symbol],
            currency: metadata.currency,
            sector: metadata.sector,
            industry: metadata.industry,
            country: metadata.country,
            assetType: metadata.assetType,
            ...(metadata.hedge !== "unknown" ? { hedged: metadata.hedge === "hedged" } : {}),
            factors: parseFactorDraft(metadata.factors),
            constituents: parsedConstituents[asset.symbol]?.value ?? [],
          };
        }),
        exposureLookThrough,
      );
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
      if ((mode === "optimization" || mode === "outlook") && completed.run?.runId) {
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

  const updateExposure = (symbol: string, patch: Partial<ExposureDraft>) => {
    setExposureMetadata((current) => ({
      ...current,
      [symbol]: {
        ...(current[symbol] ?? { currency: "", sector: "", industry: "", country: "", assetType: "", hedge: "unknown", factors: "", constituents: "" }),
        ...patch,
      },
    }));
  };

  const exposureReady = baseConfig.assets.every((asset) => /^[A-Z]{3}$/.test(exposureMetadata[asset.symbol]?.currency.trim().toUpperCase() ?? "")
    && !parsedConstituents[asset.symbol]?.error);
  const currentWalkForwardSeeds = walkForwardSeeds(seed, additionalWalkForwardSeeds);
  const lotSizesReady = baseConfig.assets.every((asset) => Number.isFinite(monteCarloLotSizes[asset.symbol]) && monteCarloLotSizes[asset.symbol] > 0);
  const robustValidationReady = !robustValidationEnabled || (
    Number.isInteger(robustValidationGap) && robustValidationGap >= 0 && robustValidationGap <= 1_000
    && (robustValidationMode === "holdout"
      ? Number.isFinite(robustValidationTestPercent) && robustValidationTestPercent >= 5 && robustValidationTestPercent <= 50
      : Number.isInteger(robustValidationTrainWindow) && robustValidationTrainWindow >= 20 && robustValidationTrainWindow <= 5_000
        && Number.isInteger(robustValidationTestWindow) && robustValidationTestWindow >= 5 && robustValidationTestWindow <= 2_000
        && Number.isInteger(robustValidationStep) && robustValidationStep >= 1 && robustValidationStep <= 2_000
        && Number.isInteger(robustValidationFoldCount) && robustValidationFoldCount >= 2 && robustValidationFoldCount <= 100
        && Number.isInteger(robustValidationEmbargo) && robustValidationEmbargo >= 0 && robustValidationEmbargo <= 1_000)
  );
  const canSubmit = canAnalyze && !running && (mode !== "compare" || selectedRuns.length >= 2)
    && (!["optimization", "walk-forward", "outlook"].includes(mode) || baseConfig.assets.length >= 2)
    && (!["optimization", "walk-forward", "outlook"].includes(mode) || selectedBaselines.length > 0)
    && (!["optimization", "walk-forward", "outlook"].includes(mode) || assetGroupMetadataReady)
    && (!["optimization", "walk-forward", "outlook"].includes(mode) || groupConstraintsReady)
    && (!["optimization", "walk-forward", "outlook"].includes(mode) || !robustScoreWeights.error)
    && (!["optimization", "walk-forward", "outlook"].includes(mode) || robustValidationReady)
    && (mode !== "optimization" && mode !== "walk-forward" || objective !== "max_information_ratio" || Boolean(optimizationBenchmark.trim()))
    && (mode !== "outlook" || objective !== "max_information_ratio"
      || Boolean(optimizationBenchmark.trim()) || baseConfig.benchmark !== "NONE")
    && (mode !== "walk-forward" && mode !== "outlook" || foldCandidateBudget >= currentWalkForwardSeeds.length)
    && (mode !== "monte-carlo" && mode !== "outlook" || monteCarloCashWeightPercent < 100)
    && (mode !== "monte-carlo" && mode !== "outlook" || lotSizesReady)
    && (mode !== "outlook" || outlookRebalanceModes.length > 0)
    && (mode !== "outlook" || Number.isInteger(outlookRegimeLookback) && outlookRegimeLookback >= 5 && outlookRegimeLookback <= 252)
    && (mode !== "stress" && mode !== "outlook" || stressScenarios.length > 0)
    && (mode !== "exposures" || exposureReady);
  const staleResult = Boolean(resultConfigFingerprint && resultConfigFingerprint !== analysisInputFingerprint);

  const optimizationEngineControls = <div className="space-y-3">
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
      <Field label="탐색 알고리즘"><Select value={optimizationAlgorithm} onValueChange={(value) => setOptimizationAlgorithm(value as OptimizationAlgorithm)}><SelectTrigger aria-label="최적화 탐색 알고리즘" className="w-full bg-secondary"><SelectValue /></SelectTrigger><SelectContent>{algorithmOptions.map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent></Select></Field>
      <Field label="공분산 추정"><Select value={covarianceEstimator} onValueChange={(value) => setCovarianceEstimator(value as CovarianceEstimator)}><SelectTrigger aria-label="공분산 추정 방식" className="w-full bg-secondary"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="sample">표본 공분산</SelectItem><SelectItem value="ledoit_wolf">Ledoit–Wolf shrinkage</SelectItem></SelectContent></Select></Field>
      <Field label="Ledger 재검증 후보" help="Screening 상위·Pareto 후보를 실제 거래 ledger로 다시 계산합니다."><Input aria-label="Ledger 재검증 후보 예산" type="number" min={1} max={128} value={ledgerValidationBudget} onChange={(event) => setLedgerValidationBudget(Number(event.target.value))} className="bg-secondary text-right" /></Field>
      <Field label="Ledger 수량 방식" help="Outlook 기준 ledger와 Monte Carlo에도 같은 수량 계약을 적용합니다."><Select value={ledgerQuantityMode} onValueChange={(value) => setLedgerQuantityMode(value as BacktestQuantityMode)}><SelectTrigger aria-label="Ledger 수량 방식" className="w-full bg-secondary"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="fractional">소수 수량</SelectItem><SelectItem value="whole">정수·lot 수량</SelectItem></SelectContent></Select></Field>
    </div>
    <Field label="강건 점수 가중치 · JSON" help={'빈 객체는 엔진 기본값을 사용합니다. 예: {"sharpe":0.4,"oosAverageSharpe":0.6}'}><Input aria-label="강건 점수 가중치 JSON" value={robustScoreWeightsDraft} onChange={(event) => setRobustScoreWeightsDraft(event.target.value)} className="bg-secondary font-mono text-[11px]" />{robustScoreWeights.error ? <span role="alert" className="mt-2 block text-[10px] text-rose-500">{robustScoreWeights.error}</span> : null}</Field>
    <div className="rounded-[18px] bg-card p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div><p className="text-[11px] font-bold text-muted-foreground">후보별 IS/OOS 강건 검증</p><p className="mt-1 text-[10px] leading-4 text-muted-foreground">후보·공분산은 최초 학습 구간에서만 적합하고 이후 시간순 OOS fold의 점수·coverage를 합산합니다. fold마다 재최적화하려면 Walk-forward 실행을 사용하세요. 기존 단일 holdout도 선택할 수 있습니다.</p></div>
        <ToggleChoice active={robustValidationEnabled} onClick={() => setRobustValidationEnabled((current) => !current)}>{robustValidationEnabled ? "활성" : "비활성"}</ToggleChoice>
      </div>
      {robustValidationEnabled ? <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <Field label="검증 방식"><Select value={robustValidationMode} onValueChange={(value) => setRobustValidationMode(value as RobustValidationMode)}><SelectTrigger aria-label="강건 검증 방식" className="w-full bg-secondary"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="walk_forward">Walk-forward OOS</SelectItem><SelectItem value="holdout">단일 holdout · 호환</SelectItem></SelectContent></Select></Field>
        {robustValidationMode === "holdout" ? <>
          <Field label="Inner OOS 비율 %"><Input aria-label="Inner OOS 비율" type="number" min={5} max={50} value={robustValidationTestPercent} onChange={(event) => setRobustValidationTestPercent(Number(event.target.value))} className="bg-secondary text-right" /></Field>
          <Field label="Inner gap · 관측일"><Input aria-label="Inner 검증 gap" type="number" min={0} max={1000} value={robustValidationGap} onChange={(event) => setRobustValidationGap(Number(event.target.value))} className="bg-secondary text-right" /></Field>
        </> : <>
          <Field label="Window 방식"><Select value={robustValidationWindowMode} onValueChange={(value) => setRobustValidationWindowMode(value as WalkForwardMode)}><SelectTrigger aria-label="강건 검증 window 방식" className="w-full bg-secondary"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="rolling">Rolling</SelectItem><SelectItem value="anchored">Anchored</SelectItem></SelectContent></Select></Field>
          <Field label="학습 관측일"><Input aria-label="강건 검증 학습 관측일" type="number" min={20} max={5000} value={robustValidationTrainWindow} onChange={(event) => setRobustValidationTrainWindow(Number(event.target.value))} className="bg-secondary text-right" /></Field>
          <Field label="OOS 관측일"><Input aria-label="강건 검증 OOS 관측일" type="number" min={5} max={2000} value={robustValidationTestWindow} onChange={(event) => setRobustValidationTestWindow(Number(event.target.value))} className="bg-secondary text-right" /></Field>
          <Field label="Step"><Input aria-label="강건 검증 step" type="number" min={1} max={2000} value={robustValidationStep} onChange={(event) => setRobustValidationStep(Number(event.target.value))} className="bg-secondary text-right" /></Field>
          <Field label="최대 fold"><Input aria-label="강건 검증 최대 fold" type="number" min={2} max={100} value={robustValidationFoldCount} onChange={(event) => setRobustValidationFoldCount(Number(event.target.value))} className="bg-secondary text-right" /></Field>
          <Field label="Gap"><Input aria-label="강건 검증 gap" type="number" min={0} max={1000} value={robustValidationGap} onChange={(event) => setRobustValidationGap(Number(event.target.value))} className="bg-secondary text-right" /></Field>
          <Field label="Embargo"><Input aria-label="강건 검증 embargo" type="number" min={0} max={1000} value={robustValidationEmbargo} onChange={(event) => setRobustValidationEmbargo(Number(event.target.value))} className="bg-secondary text-right" /></Field>
        </>}
      </div> : null}
      {!robustValidationReady ? <p role="alert" className="mt-3 text-[10px] text-rose-500">강건 검증의 기간·fold·gap·embargo 범위를 확인하세요.</p> : null}
    </div>
    <div className="grid gap-3 lg:grid-cols-[1.4fr_0.8fr]">
      <div className="rounded-[18px] bg-card p-4" role="group" aria-label="기준 후보 선택">
        <p className="text-[11px] font-bold text-muted-foreground">기준 후보 · 최소 1개</p>
        <div className="mt-3 flex flex-wrap gap-2">{optimizerBaselines.map((baseline) => <ToggleChoice key={baseline} active={selectedBaselines.includes(baseline)} onClick={() => setSelectedBaselines((current) => current.includes(baseline) ? current.filter((item) => item !== baseline) : [...current, baseline])}>{baselineLabels[baseline]}</ToggleChoice>)}</div>
        {!selectedBaselines.length ? <p role="alert" className="mt-3 text-[10px] text-rose-500">Screening 기준 후보를 하나 이상 선택하세요.</p> : null}
      </div>
      <div className="rounded-[18px] bg-card p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div><p className="text-[11px] font-bold text-muted-foreground">시장 국면 순차 정책</p><p className="mt-1 text-[10px] leading-4 text-muted-foreground">과거 정보만으로 상태별 기준 비중을 선택하고 ledger로 재검증합니다.</p></div><ToggleChoice active={regimePolicyEnabled} onClick={() => setRegimePolicyEnabled((current) => !current)}>{regimePolicyEnabled ? "활성" : "비활성"}</ToggleChoice></div>
        {regimePolicyEnabled ? <Select value={regimePolicyMethod} onValueChange={(value) => setRegimePolicyMethod(value as RegimePolicyMethod)}><SelectTrigger aria-label="시장 국면 정책 탐색 방식" className="mt-3 w-full bg-secondary"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="auto">Auto</SelectItem><SelectItem value="dynamic_programming">Dynamic Programming</SelectItem><SelectItem value="mcts">MCTS</SelectItem></SelectContent></Select> : null}
      </div>
    </div>
    <div className="rounded-[18px] bg-card p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div><p className="text-[11px] font-bold text-muted-foreground">그룹 비중 제약</p><p className="mt-1 text-[10px] text-muted-foreground">아래 종목별 metadata의 그룹 합산 비중에 최소·최대 제약을 적용합니다.</p></div><Button type="button" variant="secondary" size="sm" onClick={() => setGroupConstraints((current) => [...current, { id: Math.max(0, ...current.map((item) => item.id)) + 1, dimension: "sector", group: "", minWeightPercent: "0", maxWeightPercent: "100" }])} disabled={groupConstraints.length >= 100}><Plus />제약 추가</Button></div>
      {groupConstraints.length ? <div className="mt-3 space-y-2">{groupConstraints.map((constraint) => <div key={constraint.id} className="grid gap-2 rounded-2xl bg-secondary p-3 sm:grid-cols-[1fr_1.2fr_0.7fr_0.7fr_auto]"><Select value={constraint.dimension} onValueChange={(value) => setGroupConstraints((current) => current.map((item) => item.id === constraint.id ? { ...item, dimension: value as AssetGroupDimension } : item))}><SelectTrigger aria-label={`그룹 제약 ${constraint.id} 차원`} className="w-full bg-card"><SelectValue /></SelectTrigger><SelectContent>{groupDimensionOptions.map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent></Select><Input aria-label={`그룹 제약 ${constraint.id} 이름`} value={constraint.group} onChange={(event) => setGroupConstraints((current) => current.map((item) => item.id === constraint.id ? { ...item, group: event.target.value } : item))} placeholder="그룹 이름" maxLength={80} className="bg-card" /><Input aria-label={`그룹 제약 ${constraint.id} 최소 비중`} type="number" min={0} max={100} value={constraint.minWeightPercent} onChange={(event) => setGroupConstraints((current) => current.map((item) => item.id === constraint.id ? { ...item, minWeightPercent: event.target.value } : item))} placeholder="최소 %" className="bg-card text-right" /><Input aria-label={`그룹 제약 ${constraint.id} 최대 비중`} type="number" min={0} max={100} value={constraint.maxWeightPercent} onChange={(event) => setGroupConstraints((current) => current.map((item) => item.id === constraint.id ? { ...item, maxWeightPercent: event.target.value } : item))} placeholder="최대 %" className="bg-card text-right" /><Button type="button" variant="ghost" size="icon" aria-label={`그룹 제약 ${constraint.id} 삭제`} onClick={() => setGroupConstraints((current) => current.filter((item) => item.id !== constraint.id))}><Trash2 /></Button></div>)}</div> : <p className="mt-3 text-[10px] text-muted-foreground">제약 없음</p>}
      {!groupConstraintsReady ? <p role="alert" className="mt-3 text-[10px] text-rose-500">그룹 이름과 0~100% 범위의 최소·최대 비중을 확인하세요.</p> : null}
    </div>
  </div>;

  const assetGroupControlsPanel = <div className="overflow-x-auto rounded-[18px] bg-card p-3">
    <p className="p-3 text-[11px] font-bold text-muted-foreground">종목별 그룹 metadata · 빈 값은 제약 계산에서 미지정</p>
    <table className="w-full min-w-[980px] text-left text-xs"><thead><tr className="text-muted-foreground"><th className="p-3">종목</th><th className="p-3">Sector</th><th className="p-3">Industry</th><th className="p-3">Country</th><th className="p-3">Currency</th><th className="p-3">Asset type</th></tr></thead><tbody>{baseConfig.assets.map((asset) => { const metadata = exposureMetadata[asset.symbol] ?? { currency: "", sector: "", industry: "", country: "", assetType: "", hedge: "unknown" as const, factors: "", constituents: "" }; return <tr key={asset.symbol} className="border-t border-border"><td className="p-3 font-black">{asset.symbol}</td><td className="p-2"><Input aria-label={`${asset.symbol} 최적화 sector`} maxLength={80} value={metadata.sector} onChange={(event) => updateExposure(asset.symbol, { sector: event.target.value })} placeholder="미지정" className="h-10 bg-secondary" /></td><td className="p-2"><Input aria-label={`${asset.symbol} 최적화 industry`} maxLength={80} value={metadata.industry} onChange={(event) => updateExposure(asset.symbol, { industry: event.target.value })} placeholder="미지정" className="h-10 bg-secondary" /></td><td className="p-2"><Input aria-label={`${asset.symbol} 최적화 country`} maxLength={80} value={metadata.country} onChange={(event) => updateExposure(asset.symbol, { country: event.target.value })} placeholder="미지정" className="h-10 bg-secondary" /></td><td className="p-2"><Input aria-label={`${asset.symbol} 최적화 currency`} maxLength={3} value={metadata.currency} onChange={(event) => updateExposure(asset.symbol, { currency: event.target.value.toUpperCase() })} placeholder="USD" className="h-10 bg-secondary uppercase" /></td><td className="p-2"><Input aria-label={`${asset.symbol} 최적화 asset type`} maxLength={80} value={metadata.assetType} onChange={(event) => updateExposure(asset.symbol, { assetType: event.target.value })} placeholder="미지정" className="h-10 bg-secondary" /></td></tr>; })}</tbody></table>
    {!assetGroupMetadataReady ? <p role="alert" className="p-3 text-[10px] text-rose-500">입력한 통화는 3자리 코드, 국가는 2자 이상이어야 하며 metadata는 80자 이하여야 합니다.</p> : null}
  </div>;

  const walkForwardControlsPanel = <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
    <Field label="Walk-forward 방식"><Select value={walkForwardMode} onValueChange={(value) => setWalkForwardMode(value as WalkForwardMode)}><SelectTrigger aria-label="Walk-forward 방식" className="w-full bg-secondary"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="rolling">rolling</SelectItem><SelectItem value="anchored">anchored</SelectItem></SelectContent></Select></Field>
    <Field label="학습 · OOS 관측일"><div className="grid grid-cols-2 gap-2"><Input aria-label="Walk-forward 학습 관측일" type="number" min={20} max={5000} value={trainWindow} onChange={(event) => setTrainWindow(Number(event.target.value))} className="bg-secondary text-right" /><Input aria-label="Walk-forward OOS 관측일" type="number" min={5} max={2000} value={testWindow} onChange={(event) => setTestWindow(Number(event.target.value))} className="bg-secondary text-right" /></div></Field>
    <Field label="이동 · Gap · Embargo"><div className="grid grid-cols-3 gap-2"><Input aria-label="Walk-forward 이동 간격" type="number" min={1} max={2000} value={step} onChange={(event) => setStep(Number(event.target.value))} className="bg-secondary text-right" /><Input aria-label="Walk-forward gap" type="number" min={0} max={1000} value={walkForwardGap} onChange={(event) => setWalkForwardGap(Number(event.target.value))} className="bg-secondary text-right" /><Input aria-label="Walk-forward embargo" type="number" min={0} max={1000} value={walkForwardEmbargo} onChange={(event) => setWalkForwardEmbargo(Number(event.target.value))} className="bg-secondary text-right" /></div></Field>
    <Field label="Fold 후보 예산"><Input aria-label="Walk-forward fold 후보 예산" type="number" min={1} max={10000} value={foldCandidateBudget} onChange={(event) => setFoldCandidateBudget(Number(event.target.value))} className="bg-secondary text-right" /></Field>
    <Field label="추가 seed" help={`현재 seed ${seed}는 항상 포함합니다. 실제 배열: ${currentWalkForwardSeeds.join(", ")}`}><Input aria-label="Walk-forward 추가 seed" value={additionalWalkForwardSeeds} onChange={(event) => setAdditionalWalkForwardSeeds(event.target.value)} placeholder="예: 2026, 777" className="bg-secondary" /></Field>
  </div>;

  const monteCarloControlsPanel = <div className="space-y-3">
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
      <Field label="Bootstrap / 분포 방식"><Select value={monteCarloMethod} onValueChange={(value) => setMonteCarloMethod(value as MonteCarloMethod)}><SelectTrigger aria-label="Monte Carlo 방식" className="w-full bg-secondary"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="moving_block">moving-block</SelectItem><SelectItem value="stationary">stationary</SelectItem><SelectItem value="regime_conditioned">regime-conditioned</SelectItem><SelectItem value="student_t">Student-t</SelectItem></SelectContent></Select></Field>
      <Field label="미래 거래일 · 경로 수"><div className="grid grid-cols-2 gap-2"><Input aria-label="Monte Carlo 미래 거래일" type="number" min={1} max={25200} value={horizonDays} onChange={(event) => setHorizonDays(Number(event.target.value))} className="bg-secondary text-right" /><Input aria-label="Monte Carlo 경로 수" type="number" min={100} max={100000} value={pathCount} onChange={(event) => setPathCount(Number(event.target.value))} className="bg-secondary text-right" /></div></Field>
      <Field label="블록 길이 · Calibration"><div className="grid grid-cols-2 gap-2"><Input aria-label="Monte Carlo 블록 길이" type="number" min={1} max={252} value={blockLength} onChange={(event) => setBlockLength(Number(event.target.value))} className="bg-secondary text-right" /><Input aria-label="Monte Carlo calibration origins" type="number" min={0} max={100} value={calibrationOrigins} onChange={(event) => setCalibrationOrigins(Number(event.target.value))} className="bg-secondary text-right" /></div></Field>
      <Field label="목표 금액 · 분위수 %"><div className="grid grid-cols-2 gap-2"><Input aria-label="Monte Carlo 목표 금액" type="number" min={1} value={goalAmount} onChange={(event) => setGoalAmount(event.target.value)} placeholder="목표 없음" className="bg-secondary text-right" /><Input aria-label="Monte Carlo 분위수" value={quantiles} onChange={(event) => setQuantiles(event.target.value)} className="bg-secondary" /></div></Field>
      <Field label="표본 경로 · seed"><div className="grid grid-cols-2 gap-2"><Input aria-label="Monte Carlo 표본 경로 수" type="number" min={0} max={100} value={samplePathCount} onChange={(event) => setSamplePathCount(Number(event.target.value))} className="bg-secondary text-right" /><Input aria-label="Monte Carlo seed" type="number" min={0} value={seed} onChange={(event) => setSeed(Number(event.target.value))} className="bg-secondary text-right" /></div></Field>
      <Field label="리밸런싱"><Select value={monteCarloRebalance} onValueChange={(value) => setMonteCarloRebalance(value as BacktestRebalanceFrequency)}><SelectTrigger aria-label="Monte Carlo 리밸런싱" className="w-full bg-secondary"><SelectValue /></SelectTrigger><SelectContent>{rebalanceModes.map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)}</SelectContent></Select>{monteCarloRebalance === "threshold" ? <Input aria-label="Monte Carlo 리밸런싱 threshold" type="number" min={0.1} max={50} value={monteCarloThreshold} onChange={(event) => setMonteCarloThreshold(Number(event.target.value))} className="mt-2 bg-secondary text-right" /> : null}</Field>
      <Field label="현금 비중 % · 연 수익률 %"><div className="grid grid-cols-2 gap-2"><Input aria-label="Monte Carlo 현금 비중" type="number" min={0} max={99} value={monteCarloCashWeightPercent} onChange={(event) => setMonteCarloCashWeightPercent(Number(event.target.value))} className="bg-secondary text-right" /><Input aria-label="Monte Carlo 현금 연 수익률" type="number" min={-100} max={100} value={monteCarloCashYieldPercent} onChange={(event) => setMonteCarloCashYieldPercent(Number(event.target.value))} className="bg-secondary text-right" /></div></Field>
      <Field label="거래비용 bp · 물가상승률 %"><div className="grid grid-cols-2 gap-2"><Input aria-label="Monte Carlo 거래비용" type="number" min={0} max={500} value={monteCarloTransactionCostBps} onChange={(event) => setMonteCarloTransactionCostBps(Number(event.target.value))} className="bg-secondary text-right" /><Input aria-label="Monte Carlo 물가상승률" type="number" min={-20} max={100} value={inflationAnnualPercent} onChange={(event) => setInflationAnnualPercent(Number(event.target.value))} className="bg-secondary text-right" /></div></Field>
      <Field label="주기 현금흐름 · 주기(거래일)" help="음수는 인출이며 중간 고갈 확률에 반영합니다."><div className="grid grid-cols-2 gap-2"><Input aria-label="Monte Carlo 주기 현금흐름" type="number" value={monteCarloPeriodicCashFlow} onChange={(event) => setMonteCarloPeriodicCashFlow(Number(event.target.value))} className="bg-secondary text-right" /><Input aria-label="Monte Carlo 현금흐름 주기" type="number" min={1} max={25200} value={monteCarloCashFlowFrequencyDays} onChange={(event) => setMonteCarloCashFlowFrequencyDays(Number(event.target.value))} className="bg-secondary text-right" /></div></Field>
      <Field label="수량 방식"><Select value={ledgerQuantityMode} onValueChange={(value) => setLedgerQuantityMode(value as BacktestQuantityMode)}><SelectTrigger aria-label="Monte Carlo 수량 방식" className="w-full bg-secondary"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="fractional">소수 수량</SelectItem><SelectItem value="whole">정수·lot 수량</SelectItem></SelectContent></Select></Field>
    </div>
    <div className="overflow-x-auto rounded-[18px] bg-card p-3"><table className="w-full min-w-[520px] text-left text-xs"><thead><tr className="text-muted-foreground"><th className="p-3">종목</th><th className="p-3">Monte Carlo lot size</th></tr></thead><tbody>{baseConfig.assets.map((asset) => <tr key={asset.symbol} className="border-t border-border"><td className="p-3 font-black">{asset.symbol}</td><td className="p-2"><Input aria-label={`${asset.symbol} Monte Carlo lot size`} type="number" min={0.000001} max={1000000} value={monteCarloLotSizes[asset.symbol] ?? 1} onChange={(event) => setMonteCarloLotSizes((current) => ({ ...current, [asset.symbol]: Number(event.target.value) }))} className="h-10 bg-secondary text-right" /></td></tr>)}</tbody></table></div>
  </div>;

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
        {optimizationEngineControls}
        <div className="overflow-x-auto rounded-[20px] bg-card p-3"><table className="w-full min-w-[680px] text-left text-xs"><thead><tr className="text-muted-foreground"><th className="p-3">종목</th><th className="p-3">개별 최소 %</th><th className="p-3">개별 최대 %</th><th className="p-3">필수</th><th className="p-3">제외</th></tr></thead><tbody>{baseConfig.assets.map((asset) => <tr key={asset.symbol} className="border-t border-border"><td className="p-3 font-black"><span className="flex items-center gap-2"><StockSwatch symbol={asset.symbol} theme={theme} />{asset.symbol}</span></td><td className="p-3"><Input aria-label={`${asset.symbol} 개별 최소 비중`} type="number" min={0} max={100} value={perAssetMinimums[asset.symbol] ?? ""} onChange={(event) => updateOptionalWeight(setPerAssetMinimums, asset.symbol, event.target.value)} placeholder="전역" className="h-10 bg-secondary" /></td><td className="p-3"><Input aria-label={`${asset.symbol} 개별 최대 비중`} type="number" min={0} max={100} value={perAssetMaximums[asset.symbol] ?? ""} onChange={(event) => updateOptionalWeight(setPerAssetMaximums, asset.symbol, event.target.value)} placeholder="전역" className="h-10 bg-secondary" /></td><td className="p-3"><input aria-label={`${asset.symbol} 필수 종목`} type="checkbox" checked={requiredAssets.includes(asset.symbol)} onChange={() => { setRequiredAssets((current) => current.includes(asset.symbol) ? current.filter((value) => value !== asset.symbol) : [...current, asset.symbol]); setExcludedAssets((current) => current.filter((value) => value !== asset.symbol)); }} /></td><td className="p-3"><input aria-label={`${asset.symbol} 제외 종목`} type="checkbox" checked={excludedAssets.includes(asset.symbol)} onChange={() => { setExcludedAssets((current) => current.includes(asset.symbol) ? current.filter((value) => value !== asset.symbol) : [...current, asset.symbol]); setRequiredAssets((current) => current.filter((value) => value !== asset.symbol)); }} /></td></tr>)}</tbody></table></div>
        {assetGroupControlsPanel}
        {mode === "walk-forward" ? walkForwardControlsPanel : null}
      </div> : null}

      {mode === "monte-carlo" ? <div className="mt-5">{monteCarloControlsPanel}</div> : null}

      {mode === "outlook" ? <div className="mt-5 space-y-3">
        <div className="rounded-[20px] bg-card p-4"><div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div><p className="text-xs font-black">통합 전망</p><p className="mt-1 text-[10px] leading-5 text-muted-foreground">2단계 최적화 → Walk-forward OOS → Monte Carlo calibration → 시장 국면 → stress·민감도를 동일 입력·seed로 실행합니다.</p></div><ToggleChoice active={outlookOptimizationEnabled} onClick={() => setOutlookOptimizationEnabled((current) => !current)}>최적화 {outlookOptimizationEnabled ? "포함" : "제외"}</ToggleChoice></div></div>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <Field label="최적화 목적"><Select value={objective} onValueChange={setObjective}><SelectTrigger className="w-full bg-secondary"><SelectValue /></SelectTrigger><SelectContent>{objectiveOptions.map(([value,label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent></Select></Field>
          <Field label="전망 벤치마크 · 선택" help="비우면 백테스트 기본 벤치마크를 사용"><Input value={optimizationBenchmark} onChange={(event) => setOptimizationBenchmark(event.target.value.toUpperCase())} placeholder={baseConfig.benchmark === "NONE" ? "SPY, QQQ" : `${baseConfig.benchmark} 사용`} className="bg-secondary" /></Field>
          <Field label="Screening 후보 예산"><Input type="number" min={10} max={10000} value={candidateBudget} onChange={(event) => setCandidateBudget(Number(event.target.value))} className="bg-secondary text-right" /></Field>
          <Field label="최소 · 최대 비중 %"><div className="grid grid-cols-2 gap-2"><Input type="number" min={0} max={100} value={minWeightPercent} onChange={(event) => setMinWeightPercent(Number(event.target.value))} className="bg-secondary text-right" /><Input type="number" min={0} max={100} value={maxWeightPercent} onChange={(event) => setMaxWeightPercent(Number(event.target.value))} className="bg-secondary text-right" /></div></Field>
          <Field label="재현 seed"><Input type="number" min={0} value={seed} onChange={(event) => setSeed(Number(event.target.value))} className="bg-secondary text-right" /></Field>
        </div>
        {optimizationEngineControls}
        {assetGroupControlsPanel}
        {walkForwardControlsPanel}
        {monteCarloControlsPanel}
        <div className="rounded-[18px] bg-card p-4"><div className="grid gap-3 md:grid-cols-[1fr_200px]"><div><p className="text-xs font-black">과거정보 전용 시장 국면</p><p className="mt-1 text-[10px] leading-5 text-muted-foreground">벤치마크가 있으면 벤치마크, 없으면 현재 비중 포트폴리오의 직전 관측만 사용해 risk-on·neutral·risk-off를 분류합니다.</p></div><Field label="국면 lookback · 거래일"><Input aria-label="Outlook 시장 국면 lookback" type="number" min={5} max={252} value={outlookRegimeLookback} onChange={(event) => setOutlookRegimeLookback(Number(event.target.value))} className="bg-secondary text-right" /></Field></div></div>
        <div className="rounded-[18px] bg-card p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div><p className="text-xs font-black">Outlook 민감도 ledger</p><p className="mt-1 text-[10px] text-muted-foreground">비용 충격·무현금흐름·리밸런싱 정책을 동일 데이터와 실제 ledger로 비교합니다.</p></div><ToggleChoice active={outlookSensitivityEnabled} onClick={() => setOutlookSensitivityEnabled((current) => !current)}>{outlookSensitivityEnabled ? "포함" : "제외"}</ToggleChoice></div>
          {outlookSensitivityEnabled ? <div className="mt-3 grid gap-3 md:grid-cols-[200px_1fr]"><Field label="추가 거래비용 충격 · bp"><Input aria-label="Outlook 추가 거래비용 충격" type="number" min={0} max={500} value={outlookCostShockBps} onChange={(event) => setOutlookCostShockBps(Number(event.target.value))} className="bg-secondary text-right" /></Field><div className="rounded-[18px] bg-secondary p-4"><p className="text-[11px] font-bold text-muted-foreground">민감도 시나리오</p><div className="mt-3 flex flex-wrap gap-2"><ToggleChoice active={outlookZeroCashFlow} onClick={() => setOutlookZeroCashFlow((current) => !current)}>현금흐름 0</ToggleChoice>{(["none", "monthly", "quarterly", "annually"] as const).map((item) => <ToggleChoice key={item} active={outlookRebalanceModes.includes(item)} onClick={() => setOutlookRebalanceModes((current) => current.includes(item) ? (current.length > 1 ? current.filter((value) => value !== item) : current) : [...current, item])}>{item}</ToggleChoice>)}</div></div></div> : null}
        </div>
        <div className="rounded-[18px] bg-card p-4 text-[10px] leading-5 text-muted-foreground"><p className="font-black text-foreground">Stress {stressScenarios.length}개 포함</p><p>{stressScenarios.map((scenario) => scenario.name).join(" · ")}</p><p>스트레스 탭에서 기간·비용·현금흐름·통화·리밸런싱 조건을 수정한 뒤 다시 미래 전망 탭으로 돌아오면 그대로 사용합니다.</p></div>
      </div> : null}

      {mode === "exposures" ? <div className="mt-5 space-y-3">
        <div className="rounded-[20px] bg-card p-4"><div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div><p className="text-xs font-black">공급자 metadata 기반 노출 분석</p><p className="mt-1 text-[10px] leading-5 text-muted-foreground">통화는 현재 종목 metadata로 채웁니다. 공급되지 않은 sector·industry·국가·factor를 추정하지 않으며 빈 값은 UNKNOWN으로 반환합니다.</p></div><ToggleChoice active={exposureLookThrough} onClick={() => setExposureLookThrough((current) => !current)}>ETF look-through {exposureLookThrough ? "ON" : "OFF"}</ToggleChoice></div></div>
        <div className="overflow-x-auto rounded-[20px] bg-card p-3"><table className="w-full min-w-[1260px] text-left text-[10px]"><thead><tr className="text-muted-foreground"><th className="p-3">종목·비중</th><th className="p-3">통화 *</th><th className="p-3">Sector</th><th className="p-3">Industry</th><th className="p-3">Country</th><th className="p-3">Asset type</th><th className="p-3">환헤지</th><th className="p-3">Factor</th></tr></thead><tbody>{baseConfig.assets.map((asset) => { const metadata = exposureMetadata[asset.symbol] ?? { currency: "", sector: "", industry: "", country: "", assetType: "", hedge: "unknown" as const, factors: "", constituents: "" }; return <tr key={asset.symbol} className="border-t border-border"><td className="p-3 font-black">{asset.symbol}<br /><span className="font-normal text-muted-foreground">{formatPercent(asset.weight)}</span></td><td className="p-2"><Input aria-label={`${asset.symbol} 통화`} maxLength={3} value={metadata.currency} onChange={(event) => updateExposure(asset.symbol, { currency: event.target.value.toUpperCase() })} placeholder="USD" className="h-10 bg-secondary uppercase" /></td><td className="p-2"><Input aria-label={`${asset.symbol} sector`} value={metadata.sector} onChange={(event) => updateExposure(asset.symbol, { sector: event.target.value })} placeholder="미제공" className="h-10 bg-secondary" /></td><td className="p-2"><Input aria-label={`${asset.symbol} industry`} value={metadata.industry} onChange={(event) => updateExposure(asset.symbol, { industry: event.target.value })} placeholder="미제공" className="h-10 bg-secondary" /></td><td className="p-2"><Input aria-label={`${asset.symbol} country`} value={metadata.country} onChange={(event) => updateExposure(asset.symbol, { country: event.target.value })} placeholder="미제공" className="h-10 bg-secondary" /></td><td className="p-2"><Input aria-label={`${asset.symbol} asset type`} value={metadata.assetType} onChange={(event) => updateExposure(asset.symbol, { assetType: event.target.value })} placeholder="미제공" className="h-10 bg-secondary" /></td><td className="p-2"><Select value={metadata.hedge} onValueChange={(value) => updateExposure(asset.symbol, { hedge: value as ExposureDraft["hedge"] })}><SelectTrigger aria-label={`${asset.symbol} 환헤지`} className="w-full bg-secondary"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="unknown">미확인</SelectItem><SelectItem value="hedged">헤지</SelectItem><SelectItem value="unhedged">비헤지</SelectItem></SelectContent></Select></td><td className="p-2"><Input aria-label={`${asset.symbol} factor`} value={metadata.factors} onChange={(event) => updateExposure(asset.symbol, { factors: event.target.value })} placeholder="value=0.3, momentum=-0.1" className="h-10 bg-secondary" /></td></tr>; })}</tbody></table></div>
        {exposureLookThrough ? <div className="grid gap-3 lg:grid-cols-2">{baseConfig.assets.map((asset) => { const metadata = exposureMetadata[asset.symbol]; const parsed = parsedConstituents[asset.symbol]; return <label key={asset.symbol} className="rounded-[18px] bg-card p-4"><span className="text-[11px] font-black">{asset.symbol} ETF 구성종목 JSON</span><span className="mt-1 block text-[10px] leading-4 text-muted-foreground">배열 항목: symbol, 0~1 weight, 선택 sector·industry·country·currency. 빈 값은 구성 snapshot 미제공입니다.</span><textarea aria-label={`${asset.symbol} ETF 구성종목 JSON`} value={metadata?.constituents ?? ""} onChange={(event) => updateExposure(asset.symbol, { constituents: event.target.value })} placeholder={'[{"symbol":"AAPL","weight":0.07,"sector":"Technology","country":"US","currency":"USD"}]'} rows={4} className="mt-3 w-full resize-y rounded-xl border border-border bg-secondary px-3 py-2 font-mono text-[11px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring" />{parsed?.error ? <span role="alert" className="mt-2 block text-[10px] text-rose-500">{parsed.error}</span> : parsed?.value.length ? <span className="mt-2 block text-[10px] text-muted-foreground">검증된 구성종목 {parsed.value.length.toLocaleString("ko-KR")}개</span> : null}</label>; })}</div> : null}
        {!exposureReady ? <p role="alert" className="rounded-[18px] bg-card p-4 text-xs text-rose-500">모든 종목에 ISO 4217 형식의 3자리 통화 코드가 필요합니다. 통화를 추정해서 채우지 않습니다.</p> : null}
        {exposureLookThrough ? <p className="rounded-[18px] bg-card p-4 text-[10px] leading-5 text-muted-foreground">입력한 공급자 snapshot만 look-through에 사용합니다. 빈 구성종목은 추정하지 않으며 coverage 0과 명시적 경고를 반환합니다.</p> : null}
      </div> : null}

      {mode === "research" ? <PortfolioResearchTools baseConfig={baseConfig} backtestRuns={backtestRuns} optimizationRuns={optimizationRuns} theme={theme} onUnauthorized={onUnauthorized} /> : null}

      {error ? <p role="alert" className="mt-4 rounded-[18px] bg-card px-4 py-3 text-sm font-semibold text-rose-500">{error}</p> : null}
      {run && ["queued", "running", "cancel_requested"].includes(run.status) ? <ProgressPanel run={run} onCancel={() => void requestCancel()} cancelling={cancelling} /> : null}
      {mode !== "research" ? <Button type="button" className="mt-5 w-full sm:w-auto" onClick={() => void submit()} disabled={!canSubmit}>{running ? <LoaderCircle className="animate-spin" /> : <Play />}{running ? "Rust worker 계산 중" : "고급 분석 실행"}</Button> : null}

      <div className={mode === "research" ? "hidden" : undefined}>
      {result !== undefined ? <div className="mt-6 border-t border-border pt-6"><div className="mb-4 flex flex-wrap items-center gap-2"><Activity className="size-4" /><p className="text-xs font-black tracking-[0.12em]">ANALYSIS RESULT</p>{staleResult ? <span className="rounded-full bg-foreground px-2 py-1 text-[9px] font-black text-background">현재 입력과 다른 실행</span> : null}<p className="w-full text-[10px] leading-4 text-muted-foreground">실행 설정 · {resultConfigLabel}</p></div>{resultMode === "compare" ? <CompareResults result={result} /> : resultMode === "optimization" ? <OptimizationResearchResults result={result} run={run} onUnauthorized={onUnauthorized} objective={resultObjective} theme={theme} /> : resultMode === "walk-forward" ? <WalkForwardResults result={result} run={run} onUnauthorized={onUnauthorized} /> : resultMode === "monte-carlo" ? <MonteCarloResults result={result} run={run} onUnauthorized={onUnauthorized} /> : resultMode === "outlook" ? <OutlookResearchResults result={result} run={run} onUnauthorized={onUnauthorized} objective={resultObjective} theme={theme} /> : resultMode === "exposures" ? <ExposureResearchResults result={result} /> : <ScenarioResults result={result} />}{warnings.length ? <div className="mt-4 rounded-[18px] bg-card p-4 text-[10px] leading-5 text-muted-foreground">{warnings.map((warning) => <p key={warning}>{warning}</p>)}</div> : null}<LazyJsonDetails value={result} className="mt-4 rounded-[18px] bg-card p-4" /></div> : null}
      </div>
    </Card>
  );
}
