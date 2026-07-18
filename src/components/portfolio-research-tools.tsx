import { useEffect, useMemo, useState } from "react";
import { Activity, LoaderCircle, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { LazyJsonDetails } from "@/components/lazy-json-details";
import { loadAdvancedMarketResource, runAdvancedAnalysis, type AdvancedAnalysisOperation } from "@/lib/advanced-analysis";
import { normalizedBacktestWeights, parseSymbolList } from "@/lib/backtest-config";
import { formatMoney, formatPercent } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { BacktestRunConfiguration } from "@/types";

export type AnalysisRunChoice = { runId: string; label: string };

type ResearchMode = "diversifying" | "regimes" | "contribution" | "pareto" | "redundant" | "rebalance";

const researchModes: Array<{ value: ResearchMode; label: string }> = [
  { value: "diversifying", label: "분산 후보" },
  { value: "regimes", label: "시장 국면" },
  { value: "contribution", label: "수익 기여" },
  { value: "pareto", label: "Pareto" },
  { value: "redundant", label: "중복 자산" },
  { value: "rebalance", label: "리밸런싱 계획" },
];

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function number(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function decimalPercent(value: unknown): string {
  const parsed = number(value);
  return parsed === undefined ? "-" : formatPercent(parsed * 100, true);
}

function percent(value: unknown): string {
  const parsed = number(value);
  return parsed === undefined ? "-" : formatPercent(parsed, true);
}

function ratio(value: unknown): string {
  const parsed = number(value);
  return parsed === undefined ? "-" : parsed.toFixed(3);
}

function ResearchField({ label, help, children }: { label: string; help?: string; children: React.ReactNode }) {
  return <label className="rounded-[18px] bg-card p-4"><span className="mb-2 block text-[11px] font-bold text-muted-foreground">{label}</span>{children}{help ? <span className="mt-2 block text-[10px] leading-4 text-muted-foreground">{help}</span> : null}</label>;
}

function ModeButton({ active, children, onClick }: { active: boolean; children: React.ReactNode; onClick: () => void }) {
  return <button type="button" aria-pressed={active} onClick={onClick} className={cn("rounded-full border px-3 py-2 text-[11px] font-black transition-colors", active ? "border-foreground bg-foreground text-background" : "border-border bg-card text-muted-foreground hover:text-foreground")}>{children}</button>;
}

function DiversifyingResult({ result }: { result: unknown }) {
  const candidates = array(record(result).candidates).map(record);
  return <div className="overflow-x-auto rounded-[20px] bg-card p-3"><table className="w-full min-w-[760px] text-left text-xs"><thead><tr className="text-muted-foreground"><th className="p-3">후보</th><th className="p-3">상관</th><th className="p-3">하락장 상관</th><th className="p-3">Beta</th><th className="p-3">변동성 감소</th><th className="p-3">혼합 CAGR</th><th className="p-3">혼합 MDD</th></tr></thead><tbody>{candidates.map((candidate) => { const effect = record(candidate.expected_variance_effect); const mixed = record(candidate.mixed_portfolio_metrics); return <tr key={String(candidate.symbol)} className="border-t border-border"><td className="p-3 font-black">{String(candidate.symbol)}</td><td className="p-3">{ratio(candidate.correlation)}</td><td className="p-3">{ratio(candidate.down_market_correlation)}</td><td className="p-3">{ratio(candidate.beta)}</td><td className="p-3">{decimalPercent(effect.volatility_reduction)}</td><td className="p-3">{decimalPercent(mixed.cagr)}</td><td className="p-3">{decimalPercent(mixed.max_drawdown)}</td></tr>; })}</tbody></table>{!candidates.length ? <p className="p-4 text-xs text-muted-foreground">상관 기준을 통과한 후보가 없습니다.</p> : null}</div>;
}

function RegimeResult({ result, onUnauthorized }: { result: unknown; onUnauthorized: () => void }) {
  const data = record(result);
  const regimes = array(data.regimes).map(record);
  const descriptor = record(data.observations_resource);
  const [loadedObservations, setLoadedObservations] = useState<unknown[]>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { setLoadedObservations(undefined); setError(""); }, [result]);
  const observations = loadedObservations ?? array(data.observations);
  const loadObservations = async () => {
    setLoading(true);
    setError("");
    try { setLoadedObservations(array(await loadAdvancedMarketResource(descriptor.uri, onUnauthorized))); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "시장 국면 관측값을 불러오지 못했습니다."); }
    finally { setLoading(false); }
  };
  const preview = observations.slice(0, 200).map(record);
  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {regimes.map((regime) => <div key={String(regime.regime)} className="rounded-[18px] bg-card p-4"><p className="text-[10px] font-black uppercase text-muted-foreground">{String(regime.regime)}</p><p className="mt-2 text-sm font-black">{String(regime.observations)}일</p><p className="mt-1 text-[10px] text-muted-foreground">평균 {decimalPercent(regime.average_return)} · 변동성 {decimalPercent(regime.annualized_volatility)}</p></div>)}
      </div>
      <div className="rounded-[18px] bg-card p-4">
        <p className="text-xs text-muted-foreground">관측 {(number(descriptor.row_count) ?? observations.length).toLocaleString("ko-KR")}개{descriptor.uri ? " · 대용량 관측값은 보호된 resource로 분리" : ""}</p>
        {descriptor.uri && !loadedObservations ? <Button type="button" variant="secondary" size="sm" className="mt-3" onClick={() => void loadObservations()} disabled={loading}>{loading ? <LoaderCircle className="animate-spin" /> : <Activity />}관측값 불러오기</Button> : null}
        {preview.length ? <details className="mt-3"><summary className="cursor-pointer text-xs font-black">관측값 미리보기 · 최대 200개</summary><div className="mt-3 max-h-[320px] overflow-auto"><table className="w-full min-w-[560px] text-left text-[10px]"><thead><tr className="text-muted-foreground"><th className="p-2">일자</th><th className="p-2">수익률</th><th className="p-2">변동성</th><th className="p-2">국면</th></tr></thead><tbody>{preview.map((item, index) => <tr key={`${String(item.date)}:${index}`} className="border-t border-border"><td className="p-2">{String(item.date ?? "-")}</td><td className="p-2">{decimalPercent(item.return)}</td><td className="p-2">{decimalPercent(item.volatility)}</td><td className="p-2 font-black">{String(item.regime ?? "-")}</td></tr>)}</tbody></table></div></details> : null}
        {error ? <p className="mt-2 text-xs text-rose-500">{error}</p> : null}
      </div>
    </div>
  );
}

function ContributionResult({ result }: { result: unknown }) {
  const data = record(result);
  const contributions = array(data.contributions).map(record);
  const risks = new Map(array(data.risk_contributions).map(record).map((item) => [String(item.symbol), item]));
  return <div className="overflow-x-auto rounded-[20px] bg-card p-3"><table className="w-full min-w-[760px] text-left text-xs"><thead><tr className="text-muted-foreground"><th className="p-3">종목</th><th className="p-3">시간연결 기여</th><th className="p-3">현지가격</th><th className="p-3">환율</th><th className="p-3">손익</th><th className="p-3">위험 기여</th></tr></thead><tbody>{contributions.map((item) => { const symbol = String(item.symbol); const risk = risks.get(symbol) ?? {}; return <tr key={symbol} className="border-t border-border"><td className="p-3 font-black">{symbol}</td><td className="p-3">{percent(item.timeLinkedContributionPercent ?? item.contributionPercent)}</td><td className="p-3">{percent(item.localPriceContributionPercent)}</td><td className="p-3">{percent(item.fxContributionPercent)}</td><td className="p-3">{formatMoney(number(item.profitLoss ?? item.estimatedProfitLoss) ?? 0, "KRW")}</td><td className="p-3">{percent(risk.contributionPercent ?? risk.riskContributionPercent ?? risk.contribution)}</td></tr>; })}</tbody></table></div>;
}

function ParetoResult({ result }: { result: unknown }) {
  const candidates = array(record(result).candidates).map(record);
  return <div className="overflow-x-auto rounded-[20px] bg-card p-3"><table className="w-full min-w-[800px] text-left text-xs"><thead><tr className="text-muted-foreground"><th className="p-3">순위</th><th className="p-3">점수</th><th className="p-3">CAGR</th><th className="p-3">변동성</th><th className="p-3">MDD</th><th className="p-3">비중</th></tr></thead><tbody>{candidates.map((candidate, index) => { const metrics = record(candidate.metrics); const weights = Object.entries(record(candidate.weights)).sort((left, right) => Number(right[1]) - Number(left[1])); return <tr key={String(candidate.id ?? index)} className="border-t border-border"><td className="p-3 font-black">{String(candidate.rank ?? index + 1)}</td><td className="p-3">{ratio(candidate.score)}</td><td className="p-3">{decimalPercent(metrics.return ?? metrics.cagr)}</td><td className="p-3">{decimalPercent(metrics.volatility)}</td><td className="p-3">{decimalPercent(metrics.maxDrawdown)}</td><td className="p-3"><div className="flex max-w-[380px] flex-wrap gap-1">{weights.map(([symbol, weight]) => <span key={symbol} className="rounded-full bg-secondary px-2 py-1 text-[9px] font-black">{symbol} {formatPercent((number(weight) ?? 0) * 100)}</span>)}</div></td></tr>; })}</tbody></table>{!candidates.length ? <p className="p-4 text-xs text-muted-foreground">저장된 Pareto 후보가 없습니다.</p> : null}</div>;
}

function RedundantResult({ result }: { result: unknown }) {
  const pairs = array(record(result).pair_details).map(record);
  return <div className="overflow-x-auto rounded-[20px] bg-card p-3"><table className="w-full min-w-[740px] text-left text-xs"><thead><tr className="text-muted-foreground"><th className="p-3">자산 쌍</th><th className="p-3">상관</th><th className="p-3">Beta</th><th className="p-3">낙폭 상관</th><th className="p-3">관측</th><th className="p-3">판정</th></tr></thead><tbody>{pairs.map((pair) => <tr key={`${String(pair.left)}-${String(pair.right)}`} className="border-t border-border"><td className="p-3 font-black">{String(pair.left)} · {String(pair.right)}</td><td className="p-3">{ratio(pair.correlation)}</td><td className="p-3">{ratio(pair.beta)}</td><td className="p-3">{ratio(pair.drawdown_path_correlation)}</td><td className="p-3">{String(pair.observations ?? "-")}</td><td className="p-3"><span className={cn("rounded-full px-2 py-1 text-[9px] font-black", pair.redundant ? "bg-foreground text-background" : "bg-secondary text-muted-foreground")}>{pair.redundant ? "중복 후보" : "유지"}</span></td></tr>)}</tbody></table></div>;
}

function RebalanceResult({ result }: { result: unknown }) {
  const data = record(result);
  const changes = array(data.changes).map(record);
  const risk = record(data.risk_change);
  return <div className="space-y-3"><div className="grid grid-cols-2 gap-2 sm:grid-cols-4">{[["회전율", decimalPercent(data.turnover)], ["추정 비용률", decimalPercent(data.estimated_cost_rate)], ["추정 비용", data.estimated_cost === null ? "-" : formatMoney(number(data.estimated_cost) ?? 0, "KRW")], ["위험 변화", `Sharpe ${ratio(risk.sharpe_ratio)}`]].map(([label, value]) => <div key={label} className="rounded-[18px] bg-card p-4"><p className="text-[10px] text-muted-foreground">{label}</p><p className="mt-2 text-sm font-black">{value}</p></div>)}</div><div className="overflow-x-auto rounded-[20px] bg-card p-3"><table className="w-full min-w-[680px] text-left text-xs"><thead><tr className="text-muted-foreground"><th className="p-3">종목</th><th className="p-3">현재</th><th className="p-3">목표</th><th className="p-3">변화</th><th className="p-3">방향</th><th className="p-3">명목 금액</th></tr></thead><tbody>{changes.map((item) => <tr key={String(item.symbol)} className="border-t border-border"><td className="p-3 font-black">{String(item.symbol)}</td><td className="p-3">{decimalPercent(item.current)}</td><td className="p-3">{decimalPercent(item.target)}</td><td className="p-3">{decimalPercent(item.change)}</td><td className="p-3 uppercase">{String(item.action)}</td><td className="p-3">{item.notional_change === undefined ? "-" : formatMoney(number(item.notional_change) ?? 0, "KRW")}</td></tr>)}</tbody></table></div><p className="text-[10px] text-muted-foreground">분석 결과는 계획만 계산하며 주문을 생성하지 않습니다.</p></div>;
}

export function PortfolioResearchTools({ baseConfig, backtestRuns, optimizationRuns, onUnauthorized }: {
  baseConfig: BacktestRunConfiguration;
  backtestRuns: AnalysisRunChoice[];
  optimizationRuns: AnalysisRunChoice[];
  onUnauthorized: () => void;
}) {
  const normalized = useMemo(() => normalizedBacktestWeights(baseConfig), [baseConfig]);
  const [mode, setMode] = useState<ResearchMode>("diversifying");
  const [candidateSymbols, setCandidateSymbols] = useState("");
  const [maximumCorrelation, setMaximumCorrelation] = useState(0.35);
  const [candidateWeightPercent, setCandidateWeightPercent] = useState(20);
  const [candidateLimit, setCandidateLimit] = useState(10);
  const [benchmark, setBenchmark] = useState(baseConfig.assets[0]?.symbol ?? "");
  const [volatilityWindow, setVolatilityWindow] = useState(20);
  const [backtestRunId, setBacktestRunId] = useState(backtestRuns[0]?.runId ?? "");
  const [optimizationRunId, setOptimizationRunId] = useState(optimizationRuns[0]?.runId ?? "");
  const [paretoLimit, setParetoLimit] = useState(100);
  const [correlationThreshold, setCorrelationThreshold] = useState(0.9);
  const [betaTolerance, setBetaTolerance] = useState(0.2);
  const [drawdownCorrelationThreshold, setDrawdownCorrelationThreshold] = useState(0.8);
  const [currentWeights, setCurrentWeights] = useState<Record<string, string>>(() => Object.fromEntries(Object.entries(normalized).map(([symbol, weight]) => [symbol, String(weight * 100)])));
  const [targetWeights, setTargetWeights] = useState<Record<string, string>>(() => Object.fromEntries(Object.entries(normalized).map(([symbol, weight]) => [symbol, String(weight * 100)])));
  const [portfolioValue, setPortfolioValue] = useState(String(baseConfig.initialAmount));
  const [transactionCostBps, setTransactionCostBps] = useState(baseConfig.transactionCostBps);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<unknown>();
  const [resultMode, setResultMode] = useState<ResearchMode>();
  const [resultFingerprint, setResultFingerprint] = useState("");
  const [resultLabel, setResultLabel] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState("");
  const inputFingerprint = JSON.stringify({
    baseConfig,
    mode,
    candidateSymbols,
    maximumCorrelation,
    candidateWeightPercent,
    candidateLimit,
    benchmark,
    volatilityWindow,
    backtestRunId,
    optimizationRunId,
    paretoLimit,
    correlationThreshold,
    betaTolerance,
    drawdownCorrelationThreshold,
    currentWeights,
    targetWeights,
    portfolioValue,
    transactionCostBps,
  });

  useEffect(() => {
    setBenchmark((current) => current || baseConfig.assets[0]?.symbol || "");
  }, [baseConfig.assets]);
  useEffect(() => {
    const next = Object.fromEntries(Object.entries(normalized).map(([symbol, weight]) => [symbol, String(weight * 100)]));
    setCurrentWeights(next);
    setTargetWeights(next);
  }, [normalized]);
  useEffect(() => { setBacktestRunId((current) => current || backtestRuns[0]?.runId || ""); }, [backtestRuns]);
  useEffect(() => { setOptimizationRunId((current) => current || optimizationRuns[0]?.runId || ""); }, [optimizationRuns]);

  const submit = async () => {
    const submittedFingerprint = inputFingerprint;
    const submittedLabel = `${researchModes.find((item) => item.value === mode)?.label ?? mode} · ${baseConfig.startDate}~${baseConfig.endDate} · ${baseConfig.currencyMode}`;
    let operation: AdvancedAnalysisOperation;
    let body: unknown;
    const common = { fromDate: baseConfig.startDate, toDate: baseConfig.endDate, currencyMode: baseConfig.currencyMode };
    if (mode === "diversifying") {
      const candidates = parseSymbolList(candidateSymbols);
      operation = "diversifying-assets";
      body = { baseSymbols: baseConfig.assets.map((asset) => asset.symbol), baseWeights: normalized, ...common, maximumCorrelation, candidateWeight: candidateWeightPercent / 100, limit: candidateLimit, ...(candidates.length ? { candidateSymbols: candidates } : {}) };
    } else if (mode === "regimes") {
      operation = "market-regimes";
      body = { benchmark: benchmark.trim().toUpperCase(), ...common, volatilityWindow };
    } else if (mode === "contribution") {
      operation = "return-contribution";
      body = { runId: backtestRunId };
    } else if (mode === "pareto") {
      operation = "pareto-frontier";
      body = { runId: optimizationRunId, limit: paretoLimit };
    } else if (mode === "redundant") {
      operation = "redundant-assets";
      body = { symbols: baseConfig.assets.map((asset) => asset.symbol), ...common, correlationThreshold, betaTolerance, drawdownCorrelationThreshold };
    } else {
      const current = Object.fromEntries(Object.entries(currentWeights).map(([symbol, value]) => [symbol, Number(value) / 100]));
      const target = Object.fromEntries(Object.entries(targetWeights).map(([symbol, value]) => [symbol, Number(value) / 100]));
      operation = "rebalance-plan";
      body = { currentWeights: current, targetWeights: target, ...common, ...(portfolioValue !== "" ? { portfolioValue: Number(portfolioValue) } : {}), transactionCostBps };
    }
    setRunning(true);
    setResult(undefined);
    setWarnings([]);
    setError("");
    try {
      const completed = await runAdvancedAnalysis({ operation, body, onUnauthorized });
      setResult(completed.result);
      setWarnings(completed.warnings);
      setResultMode(mode);
      setResultFingerprint(submittedFingerprint);
      setResultLabel(submittedLabel);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "연구 도구를 실행하지 못했습니다.");
    } finally {
      setRunning(false);
    }
  };

  const currentTotal = Object.values(currentWeights).reduce((sum, value) => sum + (Number(value) || 0), 0);
  const targetTotal = Object.values(targetWeights).reduce((sum, value) => sum + (Number(value) || 0), 0);
  const diversifyingSymbols = new Set([
    ...baseConfig.assets.map((asset) => asset.symbol),
    ...parseSymbolList(candidateSymbols),
  ]);
  const diversifyingValid = baseConfig.assets.length <= 19 && diversifyingSymbols.size <= 20;
  const canSubmit = !running && baseConfig.assets.length > 0
    && (mode !== "diversifying" || diversifyingValid)
    && (mode !== "regimes" || Boolean(benchmark.trim()))
    && (mode !== "contribution" || Boolean(backtestRunId))
    && (mode !== "pareto" || Boolean(optimizationRunId))
    && (mode !== "redundant" || baseConfig.assets.length >= 2)
    && (mode !== "rebalance" || Math.abs(currentTotal - 100) <= 0.01 && Math.abs(targetTotal - 100) <= 0.01);
  const staleResult = Boolean(resultFingerprint && resultFingerprint !== inputFingerprint);

  return <div className="mt-5 space-y-4">
    <div className="flex flex-wrap gap-2" aria-label="연구 도구 선택">{researchModes.map((item) => <ModeButton key={item.value} active={mode === item.value} onClick={() => { setMode(item.value); setError(""); }}>{item.label}</ModeButton>)}</div>
    {mode === "diversifying" ? <div className="space-y-2"><div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4"><ResearchField label="후보 종목 · 선택" help="비우면 캐시에 있는 종목에서 탐색"><Input value={candidateSymbols} onChange={(event) => setCandidateSymbols(event.target.value)} placeholder="SPY, QQQ, GLD" className="bg-secondary" /></ResearchField><ResearchField label="최대 상관"><Input type="number" min={-1} max={1} step={0.01} value={maximumCorrelation} onChange={(event) => setMaximumCorrelation(Number(event.target.value))} className="bg-secondary text-right" /></ResearchField><ResearchField label="후보 혼합 비중 · %"><Input type="number" min={1} max={50} value={candidateWeightPercent} onChange={(event) => setCandidateWeightPercent(Number(event.target.value))} className="bg-secondary text-right" /></ResearchField><ResearchField label="결과 수"><Input type="number" min={1} max={19} value={candidateLimit} onChange={(event) => setCandidateLimit(Number(event.target.value))} className="bg-secondary text-right" /></ResearchField></div>{!diversifyingValid ? <p className="text-xs text-rose-500">분산 후보 탐색은 기준 종목 최대 19개, 기준과 직접 입력한 후보를 합쳐 최대 20개까지 지원합니다.</p> : null}</div> : null}
    {mode === "regimes" ? <div className="grid gap-3 md:grid-cols-2"><ResearchField label="벤치마크 종목"><Input value={benchmark} onChange={(event) => setBenchmark(event.target.value.toUpperCase())} className="bg-secondary" /></ResearchField><ResearchField label="변동성 창 · 관측일"><Input type="number" min={5} max={252} value={volatilityWindow} onChange={(event) => setVolatilityWindow(Number(event.target.value))} className="bg-secondary text-right" /></ResearchField></div> : null}
    {mode === "contribution" ? <ResearchField label="완료된 백테스트 실행" help="현재 화면의 실행을 고르거나 저장된 run UUID를 붙여넣을 수 있습니다."><div className="space-y-2"><Input aria-label="수익 기여 백테스트 run ID" value={backtestRunId} onChange={(event) => setBacktestRunId(event.target.value.trim())} placeholder="00000000-0000-4000-8000-000000000000" className="bg-secondary" />{backtestRuns.length ? <Select value={backtestRuns.some((item) => item.runId === backtestRunId) ? backtestRunId : undefined} onValueChange={setBacktestRunId}><SelectTrigger className="w-full bg-secondary"><SelectValue placeholder="현재 화면의 실행 선택" /></SelectTrigger><SelectContent>{backtestRuns.map((item) => <SelectItem key={item.runId} value={item.runId}>{item.label}</SelectItem>)}</SelectContent></Select> : null}</div></ResearchField> : null}
    {mode === "pareto" ? <div className="grid gap-3 md:grid-cols-[1fr_220px]"><ResearchField label="완료된 최적화 실행" help="현재 화면의 실행을 고르거나 저장된 run UUID를 붙여넣을 수 있습니다."><div className="space-y-2"><Input aria-label="Pareto 최적화 run ID" value={optimizationRunId} onChange={(event) => setOptimizationRunId(event.target.value.trim())} placeholder="00000000-0000-4000-8000-000000000000" className="bg-secondary" />{optimizationRuns.length ? <Select value={optimizationRuns.some((item) => item.runId === optimizationRunId) ? optimizationRunId : undefined} onValueChange={setOptimizationRunId}><SelectTrigger className="w-full bg-secondary"><SelectValue placeholder="현재 화면의 실행 선택" /></SelectTrigger><SelectContent>{optimizationRuns.map((item) => <SelectItem key={item.runId} value={item.runId}>{item.label}</SelectItem>)}</SelectContent></Select> : null}</div></ResearchField><ResearchField label="최대 후보 수"><Input type="number" min={1} max={1000} value={paretoLimit} onChange={(event) => setParetoLimit(Number(event.target.value))} className="bg-secondary text-right" /></ResearchField></div> : null}
    {mode === "redundant" ? <div className="grid gap-3 md:grid-cols-3"><ResearchField label="상관 임계치"><Input type="number" min={0} max={1} step={0.01} value={correlationThreshold} onChange={(event) => setCorrelationThreshold(Number(event.target.value))} className="bg-secondary text-right" /></ResearchField><ResearchField label="Beta 1 허용 거리"><Input type="number" min={0} max={2} step={0.01} value={betaTolerance} onChange={(event) => setBetaTolerance(Number(event.target.value))} className="bg-secondary text-right" /></ResearchField><ResearchField label="낙폭 상관 임계치"><Input type="number" min={0} max={1} step={0.01} value={drawdownCorrelationThreshold} onChange={(event) => setDrawdownCorrelationThreshold(Number(event.target.value))} className="bg-secondary text-right" /></ResearchField></div> : null}
    {mode === "rebalance" ? <div className="space-y-3"><div className="grid gap-3 md:grid-cols-2"><ResearchField label="포트폴리오 평가액 · 선택"><Input type="number" min={1} value={portfolioValue} onChange={(event) => setPortfolioValue(event.target.value)} className="bg-secondary text-right" /></ResearchField><ResearchField label="거래비용 · bp"><Input type="number" min={0} max={500} value={transactionCostBps} onChange={(event) => setTransactionCostBps(Number(event.target.value))} className="bg-secondary text-right" /></ResearchField></div><div className="overflow-x-auto rounded-[20px] bg-card p-3"><table className="w-full min-w-[560px] text-left text-xs"><thead><tr className="text-muted-foreground"><th className="p-3">종목</th><th className="p-3">현재 비중 %</th><th className="p-3">목표 비중 %</th></tr></thead><tbody>{baseConfig.assets.map((asset) => <tr key={asset.symbol} className="border-t border-border"><td className="p-3 font-black">{asset.symbol}</td><td className="p-3"><Input aria-label={`${asset.symbol} 현재 비중`} type="number" min={0} max={100} value={currentWeights[asset.symbol] ?? ""} onChange={(event) => setCurrentWeights((current) => ({ ...current, [asset.symbol]: event.target.value }))} className="h-10 bg-secondary text-right" /></td><td className="p-3"><Input aria-label={`${asset.symbol} 목표 비중`} type="number" min={0} max={100} value={targetWeights[asset.symbol] ?? ""} onChange={(event) => setTargetWeights((current) => ({ ...current, [asset.symbol]: event.target.value }))} className="h-10 bg-secondary text-right" /></td></tr>)}</tbody><tfoot><tr className="border-t border-border font-black"><td className="p-3">합계</td><td className="p-3 text-right">{currentTotal.toFixed(2)}%</td><td className="p-3 text-right">{targetTotal.toFixed(2)}%</td></tr></tfoot></table></div></div> : null}
    {error ? <p role="alert" className="rounded-[18px] bg-card px-4 py-3 text-sm font-semibold text-rose-500">{error}</p> : null}
    <Button type="button" onClick={() => void submit()} disabled={!canSubmit}>{running ? <LoaderCircle className="animate-spin" /> : <Play />}{running ? "분석 중" : "연구 도구 실행"}</Button>
    {result !== undefined ? <div className="border-t border-border pt-5"><div className="mb-4 flex flex-wrap items-center gap-2"><Activity className="size-4" /><p className="text-xs font-black tracking-[0.12em]">RESEARCH RESULT</p>{staleResult ? <span className="rounded-full bg-foreground px-2 py-1 text-[9px] font-black text-background">현재 입력과 다른 실행</span> : null}<p className="w-full text-[10px] text-muted-foreground">실행 설정 · {resultLabel}</p></div>{resultMode === "diversifying" ? <DiversifyingResult result={result} /> : resultMode === "regimes" ? <RegimeResult result={result} onUnauthorized={onUnauthorized} /> : resultMode === "contribution" ? <ContributionResult result={result} /> : resultMode === "pareto" ? <ParetoResult result={result} /> : resultMode === "redundant" ? <RedundantResult result={result} /> : <RebalanceResult result={result} />}{warnings.length ? <div className="mt-3 rounded-[18px] bg-card p-4 text-[10px] leading-5 text-muted-foreground">{warnings.map((warning) => <p key={warning}>{warning}</p>)}</div> : null}<LazyJsonDetails value={result} className="mt-3 rounded-[18px] bg-card p-4" /></div> : null}
  </div>;
}
