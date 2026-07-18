import { useEffect, useMemo, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";
import { Activity, CheckCircle2, CircleAlert, Database, LoaderCircle, Save, Scale, Target } from "lucide-react";
import { LazyJsonDetails } from "@/components/lazy-json-details";
import { StockSwatch } from "@/components/stock-swatch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { loadAdvancedArtifact } from "@/lib/advanced-analysis";
import { formatMoney, formatPercent } from "@/lib/format";
import { createLibraryPreset } from "@/lib/research-library";
import {
  buildOosEquitySeries,
  buildQuantileSeries,
  candidateMetric,
  candidateSignature,
  candidateQualityStatus,
  chartCandidates,
  finiteNumber,
  normalizeOptimizationCandidates,
  researchArray,
  researchRecord,
  type CandidateMetricKey,
  type ResearchCandidate,
} from "@/lib/research-visualization";
import type { AdvancedRunSnapshot, Theme } from "@/types";

type ResultProps = {
  result: unknown;
  run?: AdvancedRunSnapshot;
  onUnauthorized: () => void;
};

function decimalPercent(value: unknown): string {
  const number = finiteNumber(value);
  return number === undefined ? "-" : formatPercent(number * 100, true);
}

function valuePercent(value: unknown): string {
  const number = finiteNumber(value);
  return number === undefined ? "-" : formatPercent(number, true);
}

function ratio(value: unknown): string {
  const number = finiteNumber(value);
  return number === undefined ? "-" : number.toFixed(3);
}

function StatusBadge({ value }: { value: string }) {
  const positive = ["available", "completed", "high"].includes(value);
  const warning = ["partial", "medium", "not_selected", "not_requested"].includes(value);
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[9px] font-black ${positive ? "bg-foreground text-background" : "bg-secondary text-muted-foreground"}`}>
      {positive ? <CheckCircle2 className="size-3" /> : warning ? <CircleAlert className="size-3" /> : <Database className="size-3" />}
      {value}
    </span>
  );
}

function useArtifact(input: {
  run?: AdvancedRunSnapshot;
  type: string;
  initial?: unknown;
  onUnauthorized: () => void;
}) {
  const [value, setValue] = useState<unknown>(input.initial);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const available = Boolean(input.run?.artifacts?.some((artifact) => artifact.type === input.type));
  useEffect(() => {
    setValue(input.initial);
    setError("");
  }, [input.run?.runId, input.initial]);
  const load = async () => {
    if (!input.run?.runId) return;
    setLoading(true);
    setError("");
    try {
      setValue(await loadAdvancedArtifact(input.run.runId, input.type, input.onUnauthorized));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : `${input.type} artifact를 불러오지 못했습니다.`);
    } finally {
      setLoading(false);
    }
  };
  return { value, loading, error, available, load };
}

function ArtifactPrompt({
  label,
  description,
  artifact,
}: {
  label: string;
  description: string;
  artifact: ReturnType<typeof useArtifact>;
}) {
  if (!artifact.available || artifact.value !== undefined) return null;
  return (
    <div className="rounded-[18px] bg-card p-4">
      <p className="text-xs leading-5 text-muted-foreground">{description}</p>
      <Button type="button" variant="secondary" size="sm" className="mt-3" onClick={() => void artifact.load()} disabled={artifact.loading}>
        {artifact.loading ? <LoaderCircle className="animate-spin" /> : <Activity />}{label}
      </Button>
      {artifact.error ? <p role="alert" className="mt-2 text-xs text-rose-500">{artifact.error}</p> : null}
    </div>
  );
}

const candidateMetricRows: Array<{ key: CandidateMetricKey; label: string; format: (value: unknown) => string }> = [
  { key: "return", label: "수익률", format: decimalPercent },
  { key: "volatility", label: "변동성", format: decimalPercent },
  { key: "maxDrawdown", label: "MDD", format: decimalPercent },
  { key: "sharpe", label: "Sharpe", format: ratio },
  { key: "cvar", label: "CVaR", format: decimalPercent },
  { key: "turnover", label: "회전율", format: decimalPercent },
  { key: "transactionCost", label: "거래비용", format: decimalPercent },
  { key: "robustScore", label: "강건 점수", format: ratio },
];

function CandidateSummary({
  candidate,
  theme,
  presetName,
  onPresetNameChange,
  onSavePreset,
  saving,
}: {
  candidate: ResearchCandidate;
  theme: Theme;
  presetName?: string;
  onPresetNameChange?: (value: string) => void;
  onSavePreset?: () => void;
  saving?: boolean;
}) {
  const detail = candidate.robustDetail;
  const components = researchArray(detail.components).map(researchRecord);
  const robustValidation = researchRecord(detail.validation);
  const quality = candidateQualityStatus(candidate);
  return (
    <div className="min-w-0 rounded-[20px] bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div><p className="text-xs font-black">{candidate.label}</p><p className="mt-1 text-[9px] text-muted-foreground">screen #{candidate.screeningRank ?? "-"} · ledger #{candidate.ledgerRank ?? "-"} · 순위 변화 {candidate.rankChange === undefined ? "-" : candidate.rankChange > 0 ? `+${candidate.rankChange}` : candidate.rankChange}</p></div>
        <div className="flex flex-wrap gap-1"><StatusBadge value={candidate.validationStatus} /><StatusBadge value={quality} />{candidate.pareto ? <StatusBadge value="PARETO" /> : null}</div>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2 text-center">
        <div className="rounded-2xl bg-secondary p-2"><p className="text-[9px] text-muted-foreground">IS robust</p><p className="mt-1 text-xs font-black">{ratio(detail.inSampleScore)}</p></div>
        <div className="rounded-2xl bg-secondary p-2"><p className="text-[9px] text-muted-foreground">OOS robust</p><p className="mt-1 text-xs font-black">{ratio(detail.outOfSampleScore)}</p></div>
        <div className="rounded-2xl bg-secondary p-2"><p className="text-[9px] text-muted-foreground">OOS coverage</p><p className="mt-1 text-xs font-black">{decimalPercent(detail.coverage)}</p></div>
      </div>
      {Object.keys(robustValidation).length ? <p className="mt-2 text-center text-[9px] text-muted-foreground">{String(robustValidation.mode ?? "holdout")}{robustValidation.windowMode ? ` · ${String(robustValidation.windowMode)}` : ""} · {String(robustValidation.scoredFoldCount ?? robustValidation.foldCount ?? 1)} folds</p> : null}
      <div className="mt-3 space-y-2">{Object.entries(candidate.weights).sort((left, right) => right[1] - left[1]).slice(0, 8).map(([symbol, weight]) => <div key={symbol} className="flex items-center justify-between gap-3 text-[10px]"><span className="flex items-center gap-2 font-black"><StockSwatch symbol={symbol} theme={theme} />{symbol}</span><span>{decimalPercent(weight)}</span></div>)}</div>
      {components.length ? <details className="mt-3 rounded-2xl bg-secondary p-3"><summary className="cursor-pointer text-[10px] font-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">강건 점수 구성요소·가중치</summary><div className="mt-2 space-y-1">{components.map((component, index) => <p key={`${String(component.name)}-${index}`} className="flex justify-between gap-2 text-[9px] text-muted-foreground"><span>{String(component.name ?? "-")} · {String(component.source ?? "-")}</span><span>w {ratio(component.weight)} · raw {ratio(component.raw)}</span></p>)}</div></details> : null}
      {onSavePreset && onPresetNameChange ? <div className="mt-3 border-t border-border pt-3"><label><span className="sr-only">{candidate.label} 프리셋 이름</span><Input value={presetName ?? ""} onChange={(event) => onPresetNameChange(event.target.value)} className="h-9 bg-secondary text-[10px]" /></label><Button type="button" size="sm" variant="secondary" className="mt-2 w-full" onClick={onSavePreset} disabled={saving || !presetName?.trim()}>{saving ? <LoaderCircle className="animate-spin" /> : <Save />}이 후보를 프리셋으로 저장</Button></div> : null}
    </div>
  );
}

export function OptimizationResearchResults({ result, run, onUnauthorized, objective, theme }: ResultProps & { objective: string; theme: Theme }) {
  const data = researchRecord(result);
  const initialCandidates = researchArray(data.candidates).length ? data.candidates : undefined;
  const initialLedger = researchArray(data.ledgerValidatedCandidates).length ? data.ledgerValidatedCandidates : undefined;
  const initialPareto = researchArray(data.paretoFrontier).length ? data.paretoFrontier : undefined;
  const screeningArtifact = useArtifact({ run, type: "screening-candidates", initial: initialCandidates, onUnauthorized });
  const candidatesArtifact = useArtifact({ run, type: "candidates", initial: initialCandidates, onUnauthorized });
  const ledgerArtifact = useArtifact({ run, type: "ledger-validated-candidates", initial: initialLedger, onUnauthorized });
  const paretoArtifact = useArtifact({ run, type: "worker-pareto-frontier", initial: initialPareto, onUnauthorized });
  const candidates = useMemo(() => normalizeOptimizationCandidates({
    candidates: screeningArtifact.value ?? candidatesArtifact.value,
    ledgerCandidates: ledgerArtifact.value,
    paretoCandidates: paretoArtifact.value,
  }), [candidatesArtifact.value, ledgerArtifact.value, paretoArtifact.value, screeningArtifact.value]);
  const [selected, setSelected] = useState<string[]>([]);
  const [presetNames, setPresetNames] = useState<Record<string, string>>({});
  const [savingCandidate, setSavingCandidate] = useState("");
  const [saveMessage, setSaveMessage] = useState("");
  const [saveError, setSaveError] = useState("");
  useEffect(() => {
    const available = new Set(candidates.map((candidate) => candidate.id));
    setSelected((current) => {
      const retained = current.filter((id) => available.has(id)).slice(0, 5);
      for (const candidate of candidates) {
        if (retained.length >= Math.min(2, candidates.length)) break;
        if (!retained.includes(candidate.id)) retained.push(candidate.id);
      }
      return retained;
    });
  }, [candidates]);
  const selectedCandidates = candidates.filter((candidate) => selected.includes(candidate.id));
  const chart = chartCandidates(candidates).flatMap((candidate) => {
    const metrics = Object.keys(candidate.ledgerMetrics).length ? candidate.ledgerMetrics : candidate.screeningMetrics;
    const risk = candidateMetric(metrics, "volatility");
    const reward = candidateMetric(metrics, "return");
    if (risk === undefined || reward === undefined) return [];
    return [{
      id: candidate.id,
      risk: risk * 100,
      reward: reward * 100,
      robust: candidateMetric(metrics, "robustScore") ?? 0,
      label: candidate.label,
      pareto: candidate.pareto,
    }];
  });
  const validation = researchRecord(data.ledgerValidation);
  const best = researchRecord(researchRecord(data.bestByObjective)[objective] ?? data.best);
  const bestMetrics = researchRecord(best.ledgerMetrics ?? best.metrics);
  const toggle = (id: string) => setSelected((current) => current.includes(id)
    ? current.length <= 2 ? current : current.filter((value) => value !== id)
    : current.length >= 5 ? current : [...current, id]);
  const selectChartPoint = (point: unknown) => {
    const entry = researchRecord(point);
    const payload = researchRecord(entry.payload);
    const id = String(entry.id ?? payload.id ?? "");
    if (id) toggle(id);
  };
  const selectedPoints = chart.filter((point) => selected.includes(point.id));
  const regularPoints = chart.filter((point) => !point.pareto && !selected.includes(point.id));
  const paretoPoints = chart.filter((point) => point.pareto && !selected.includes(point.id));
  const selectionCandidates = useMemo(() => {
    const visible = candidates.slice(0, 250);
    const ids = new Set(visible.map((candidate) => candidate.id));
    for (const candidate of candidates) {
      if (!candidate.pareto || ids.has(candidate.id) || visible.length >= 2_000) continue;
      visible.push(candidate);
      ids.add(candidate.id);
    }
    return visible;
  }, [candidates]);
  const saveCandidatePreset = async (candidate: ResearchCandidate) => {
    if (!run?.runId) return;
    const paretoValues = researchArray(paretoArtifact.value);
    const screeningValues = researchArray(screeningArtifact.value ?? candidatesArtifact.value);
    const paretoIndex = paretoValues.findIndex((value) => candidateSignature(value) === candidate.id);
    const screeningIndex = screeningValues.findIndex((value) => candidateSignature(value) === candidate.id);
    const source = candidate.pareto && paretoIndex >= 0
      ? { type: "pareto_candidate" as const, runId: run.runId, candidateIndex: paretoIndex }
      : { type: "optimization_candidate" as const, runId: run.runId, candidateIndex: screeningIndex >= 0 ? screeningIndex : Math.max(0, (candidate.screeningRank ?? 1) - 1) };
    setSavingCandidate(candidate.id);
    setSaveMessage("");
    setSaveError("");
    try {
      const preset = await createLibraryPreset({
        name: (presetNames[candidate.id] ?? `${candidate.label} 후보`).trim(),
        description: `${source.type === "pareto_candidate" ? "Pareto" : "최적화"} 후보에서 저장`,
        tags: ["optimization", ...(source.type === "pareto_candidate" ? ["pareto"] : [])],
        source,
      }, { onUnauthorized });
      setSaveMessage(preset ? `“${preset.name}” 프리셋을 저장했습니다.` : "후보 프리셋을 저장했습니다.");
    } catch (caught) {
      setSaveError(caught instanceof Error ? caught.message : "후보 프리셋을 저장하지 못했습니다.");
    } finally {
      setSavingCandidate("");
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
        {[
          { label: "Screening", value: String(data.screeningCandidateCount ?? data.candidateCount ?? candidates.length) },
          { label: "Ledger 검증", value: `${String(validation.completedCount ?? selectedCandidates.filter((candidate) => candidate.validationStatus === "completed").length)} / ${String(validation.selectedCount ?? "-")}` },
          { label: "Pareto", value: String(data.paretoCount ?? paretoPoints.length) },
          { label: "최고 강건 점수", value: ratio(candidateMetric(bestMetrics, "robustScore")) },
          { label: "검증 상태", value: String(validation.status ?? "not_requested") },
        ].map(({ label, value }) => <div key={label} className="rounded-[18px] bg-card p-4"><p className="text-[9px] font-black tracking-[0.1em] text-muted-foreground">{label}</p><p className="mt-2 text-sm font-black">{value}</p></div>)}
      </div>
      <div className="grid gap-3 xl:grid-cols-[1.25fr_0.75fr]">
        <div className="rounded-[20px] bg-card p-3" role="group" aria-label="후보 변동성과 수익률 Pareto 산점도 탐색기">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2 px-2"><div><p className="text-xs font-black">Pareto scatter</p><p className="text-[9px] text-muted-foreground">ledger 지표가 있으면 ledger, 없으면 screening 지표를 사용합니다. 최대 2,000점이며 점을 눌러 2~5개 비교 후보를 선택합니다.</p></div><span className="text-[9px] font-black text-muted-foreground">X 변동성 · Y 수익률</span></div>
          <div className="h-[330px]">
            <ResponsiveContainer width="100%" height="100%"><ScatterChart margin={{ top: 12, right: 10, bottom: 20, left: 0 }}><CartesianGrid stroke="hsl(var(--chart-grid))" strokeDasharray="3 7" /><XAxis type="number" dataKey="risk" name="변동성" unit="%" tickLine={false} axisLine={false} tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }} /><YAxis type="number" dataKey="reward" name="수익률" unit="%" width={48} tickLine={false} axisLine={false} tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }} /><ZAxis type="number" dataKey="robust" range={[28, 100]} /><Tooltip cursor={{ strokeDasharray: "3 3" }} formatter={(value, name) => name === "변동성" || name === "수익률" ? formatPercent(Number(value), true) : Number(value).toFixed(3)} contentStyle={{ border: 0, borderRadius: 16, background: "hsl(var(--card))", color: "hsl(var(--foreground))" }} /><Scatter name="후보" data={regularPoints} fill="hsl(var(--muted-foreground))" fillOpacity={0.45} cursor="pointer" onClick={selectChartPoint} /><Scatter name="Pareto" data={paretoPoints} fill="hsl(var(--foreground))" cursor="pointer" onClick={selectChartPoint} /><Scatter name="선택" data={selectedPoints} fill="hsl(var(--chart-positive))" stroke="hsl(var(--foreground))" strokeWidth={2} cursor="pointer" onClick={selectChartPoint} /></ScatterChart></ResponsiveContainer>
          </div>
        </div>
        <div className="rounded-[20px] bg-card p-4">
          <p className="text-xs font-black">2~5개 후보 선택</p><p className="mt-1 text-[9px] leading-4 text-muted-foreground">현재 {selected.length}개 선택 · screening 상위 250개와 추가 Pareto 후보를 합쳐 최대 2,000개를 키보드로도 선택할 수 있습니다.</p>
          <div className="mt-3 max-h-[330px] space-y-1 overflow-y-auto pr-1">{selectionCandidates.map((candidate) => <label key={candidate.id} className="flex cursor-pointer items-center gap-2 rounded-xl bg-secondary px-3 py-2 text-[10px]"><input type="checkbox" checked={selected.includes(candidate.id)} onChange={() => toggle(candidate.id)} disabled={!selected.includes(candidate.id) && selected.length >= 5} /><span className="min-w-0 flex-1 truncate font-black">#{candidate.screeningRank ?? "-"} {candidate.label}</span>{candidate.pareto ? <span className="text-[8px] font-black">PARETO</span> : null}</label>)}</div>
        </div>
      </div>
      <ArtifactPrompt label="Screening 후보 불러오기" description="대용량 screening 후보는 별도 artifact입니다. 비교가 필요할 때만 불러옵니다." artifact={screeningArtifact.available ? screeningArtifact : candidatesArtifact} />
      <ArtifactPrompt label="Ledger 검증 후보 불러오기" description="실제 비용·현금·수량 ledger로 재검증된 후보와 순위 변화를 불러옵니다." artifact={ledgerArtifact} />
      <ArtifactPrompt label="Pareto frontier 불러오기" description="전체 Pareto frontier를 별도 artifact에서 불러옵니다." artifact={paretoArtifact} />
      {screeningArtifact.error || candidatesArtifact.error || ledgerArtifact.error || paretoArtifact.error ? <p role="alert" className="text-xs text-rose-500">{screeningArtifact.error || candidatesArtifact.error || ledgerArtifact.error || paretoArtifact.error}</p> : null}
      {selectedCandidates.length >= 2 ? <>
        <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-5">{selectedCandidates.map((candidate) => <CandidateSummary key={candidate.id} candidate={candidate} theme={theme} {...(run?.kind === "optimization" ? { presetName: presetNames[candidate.id] ?? `${candidate.label} 후보`, onPresetNameChange: (value: string) => setPresetNames((current) => ({ ...current, [candidate.id]: value })), onSavePreset: () => void saveCandidatePreset(candidate), saving: savingCandidate === candidate.id } : {})} />)}</div>
        <div className="overflow-x-auto rounded-[20px] bg-card p-3"><table className="w-full min-w-[960px] text-left text-[10px]"><thead><tr className="text-muted-foreground"><th className="p-3">후보</th>{candidateMetricRows.map((row) => <th key={row.key} className="p-3">{row.label}<br /><span className="font-normal">screen → ledger · Δ</span></th>)}</tr></thead><tbody>{selectedCandidates.map((candidate) => <tr key={candidate.id} className="border-t border-border align-top"><td className="p-3 font-black">{candidate.label}</td>{candidateMetricRows.map((row) => { const screen = candidateMetric(candidate.screeningMetrics, row.key); const ledger = candidateMetric(candidate.ledgerMetrics, row.key); const delta = finiteNumber(candidate.metricDelta[row.key]); return <td key={row.key} className="p-3"><p>{row.format(screen)}</p><p className="font-black">{row.format(ledger)}</p><p className="text-muted-foreground">Δ {row.format(delta)}</p></td>; })}</tr>)}</tbody></table></div>
      </> : candidates.length ? <p className="rounded-[18px] bg-card p-4 text-xs text-muted-foreground">비교하려면 후보를 2개 이상 선택하세요.</p> : null}
      {saveMessage ? <p role="status" className="rounded-[18px] bg-card p-4 text-xs font-bold">{saveMessage}</p> : null}
      {saveError ? <p role="alert" className="rounded-[18px] bg-card p-4 text-xs text-rose-500">{saveError}</p> : null}
      {Object.keys(researchRecord(data.robustScoreWeights)).length ? <LazyJsonDetails value={{ robustScoreWeights: data.robustScoreWeights, ledgerValidation: data.ledgerValidation, paretoComputation: data.paretoComputation }} className="rounded-[18px] bg-card p-4" /> : null}
    </div>
  );
}

function ProbabilityCard({ label, value, detail }: { label: string; value: unknown; detail?: string }) {
  return <div className="rounded-[18px] bg-card p-4"><p className="text-[9px] font-black tracking-[0.1em] text-muted-foreground">{label}</p><p className="mt-2 text-lg font-black">{value === null || value === undefined ? "-" : valuePercent(value)}</p>{detail ? <p className="mt-1 text-[9px] text-muted-foreground">{detail}</p> : null}</div>;
}

export function OutlookResearchResults({ result, run, onUnauthorized, theme, objective = "robust_score" }: ResultProps & { theme: Theme; objective?: string }) {
  const initial = researchRecord(result);
  const hasInlineSummary = !initial.outlookSummaryExternalized
    && (Object.keys(researchRecord(initial.dataQuality)).length > 0
      || Object.keys(researchRecord(initial.optimization)).length > 0
      || researchArray(researchRecord(initial.future).terminalBalanceQuantiles).length > 0);
  const summaryArtifact = useArtifact({ run, type: "outlook-summary", initial: hasInlineSummary ? initial : undefined, onUnauthorized });
  const data = researchRecord(summaryArtifact.value ?? result);
  const future = researchRecord(data.future);
  const oos = researchRecord(data.oos);
  const stress = researchRecord(data.stress);
  const sensitivity = researchRecord(data.sensitivity);
  const marketRegime = researchRecord(data.marketRegime);
  const confidence = researchRecord(data.confidence);
  const quality = researchRecord(data.dataQuality);
  const pathArtifact = useArtifact({ run, type: "outlook-quantile-paths", initial: researchArray(future.percentilePaths).length ? future.percentilePaths : undefined, onUnauthorized });
  const oosArtifact = useArtifact({ run, type: "outlook-oos-equity", initial: researchArray(oos.stitchedEquity).length ? oos.stitchedEquity : undefined, onUnauthorized });
  const worstArtifact = useArtifact({ run, type: "outlook-worst-scenarios", initial: researchArray(stress.worstScenarios).length ? stress.worstScenarios : undefined, onUnauthorized });
  const calibrationArtifact = useArtifact({ run, type: "outlook-calibration", initial: data.calibration ?? undefined, onUnauthorized });
  const sensitivityArtifact = useArtifact({ run, type: "outlook-sensitivity", initial: researchArray(sensitivity.scenarios).length ? sensitivity : undefined, onUnauthorized });
  const regimeArtifact = useArtifact({ run, type: "outlook-market-regimes", onUnauthorized });
  const quantileSeries = useMemo(() => buildQuantileSeries(pathArtifact.value), [pathArtifact.value]);
  const equitySeries = useMemo(() => buildOosEquitySeries(oosArtifact.value ?? oos.stitchedEquity), [oos.stitchedEquity, oosArtifact.value]);
  const terminalQuantiles = researchArray(future.terminalBalanceQuantiles).map(researchRecord);
  const worst = researchArray(worstArtifact.value ?? stress.worstScenarios).map(researchRecord);
  const components = researchArray(confidence.components).map(researchRecord);
  const optimization = researchRecord(data.optimization);
  const sensitivityScenarios = researchArray(researchRecord(sensitivityArtifact.value ?? sensitivity).scenarios).map(researchRecord);

  return (
    <div className="space-y-4">
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
        <ProbabilityCard label="현금흐름 조정 손실 확률" value={future.terminalLossProbabilityPercent ?? researchRecord(data.probabilities).loss} detail="종료잔액 + 인출 < 초기자본 + 납입" />
        <ProbabilityCard label="고갈 확률" value={future.depletionProbabilityPercent ?? researchRecord(data.probabilities).depletion} />
        <ProbabilityCard label="목표 달성 확률" value={future.goalProbabilityPercent ?? researchRecord(data.probabilities).goal} detail={future.goalProbabilityPercent == null ? "목표 금액 미설정" : undefined} />
        <div className="rounded-[18px] bg-card p-4"><p className="text-[9px] font-black tracking-[0.1em] text-muted-foreground">OOS COVERAGE</p><p className="mt-2 text-lg font-black">{decimalPercent(oos.coverage)}</p><p className="mt-1 text-[9px] text-muted-foreground">{String(oos.foldCount ?? 0)} folds</p></div>
        <div className="rounded-[18px] bg-card p-4"><p className="text-[9px] font-black tracking-[0.1em] text-muted-foreground">CONFIDENCE</p><p className="mt-2 text-lg font-black">{decimalPercent(confidence.score)}</p><div className="mt-1"><StatusBadge value={String(confidence.label ?? "low")} /></div></div>
      </div>
      <ArtifactPrompt label="통합 outlook 요약 불러오기" description="결과가 큰 실행은 최적화·OOS·Monte Carlo·stress 통합 요약을 artifact로 분리합니다." artifact={summaryArtifact} />
      <div className="grid gap-3 xl:grid-cols-2">
        <div className="rounded-[20px] bg-card p-4">
          <div className="flex items-center justify-between gap-2"><div><p className="text-xs font-black">미래 잔액 분위수 경로</p><p className="mt-1 text-[9px] text-muted-foreground">경로당 최대 500점 표시</p></div><Target className="size-4 text-muted-foreground" /></div>
          {quantileSeries.points.length ? <div className="mt-3 h-[300px]" role="img" aria-label="Monte Carlo 미래 잔액 분위수 경로"><ResponsiveContainer width="100%" height="100%"><LineChart data={quantileSeries.points}><CartesianGrid vertical={false} stroke="hsl(var(--chart-grid))" strokeDasharray="3 7" /><XAxis dataKey="step" tickLine={false} axisLine={false} tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }} /><YAxis width={64} tickFormatter={(value) => formatMoney(Number(value), "KRW", true)} tickLine={false} axisLine={false} tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }} /><Tooltip formatter={(value) => formatMoney(Number(value), "KRW")} contentStyle={{ border: 0, borderRadius: 16, background: "hsl(var(--card))", color: "hsl(var(--foreground))" }} />{quantileSeries.keys.map(({ key, quantile }, index) => <Line key={key} type="monotone" dataKey={key} name={`Q${Math.round(quantile * 100)}`} stroke={`hsl(0 0% ${20 + index * 14}%)`} strokeWidth={Math.abs(quantile - 0.5) < 0.001 ? 3 : 1.4} dot={false} />)}</LineChart></ResponsiveContainer></div> : <ArtifactPrompt label="분위수 경로 불러오기" description="대용량 Monte Carlo 분위수 경로를 별도 artifact에서 불러옵니다." artifact={pathArtifact} />}
          {pathArtifact.error ? <p role="alert" className="mt-2 text-xs text-rose-500">{pathArtifact.error}</p> : null}
          {terminalQuantiles.length ? <div className="mt-3 flex flex-wrap gap-1.5">{terminalQuantiles.map((item) => <span key={String(item.quantile)} className="rounded-full bg-secondary px-2.5 py-1.5 text-[9px] font-black">Q{Math.round((finiteNumber(item.quantile) ?? 0) * 100)} {formatMoney(finiteNumber(item.balance ?? item.value) ?? 0, "KRW")}</span>)}</div> : null}
        </div>
        <div className="rounded-[20px] bg-card p-4">
          <div className="flex items-center justify-between gap-2"><div><p className="text-xs font-black">Stitched OOS equity</p><p className="mt-1 text-[9px] text-muted-foreground">fold별 OOS만 이어 붙인 누수 방지 경로</p></div><Scale className="size-4 text-muted-foreground" /></div>
          {equitySeries.length ? <div className="mt-3 h-[300px]" role="img" aria-label="Walk-forward stitched OOS equity"><ResponsiveContainer width="100%" height="100%"><LineChart data={equitySeries}><CartesianGrid vertical={false} stroke="hsl(var(--chart-grid))" strokeDasharray="3 7" /><XAxis dataKey="date" tickLine={false} axisLine={false} tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }} /><YAxis width={48} tickFormatter={(value) => Number(value).toFixed(2)} tickLine={false} axisLine={false} tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }} /><Tooltip formatter={(value) => Number(value).toFixed(4)} contentStyle={{ border: 0, borderRadius: 16, background: "hsl(var(--card))", color: "hsl(var(--foreground))" }} /><Line type="monotone" dataKey="equity" name="OOS equity" stroke="hsl(var(--foreground))" strokeWidth={2.5} dot={false} /></LineChart></ResponsiveContainer></div> : <ArtifactPrompt label="OOS equity 불러오기" description="전체 stitched OOS equity를 별도 artifact에서 불러옵니다." artifact={oosArtifact} />}
          {oosArtifact.error ? <p role="alert" className="mt-2 text-xs text-rose-500">{oosArtifact.error}</p> : null}
          <div className="mt-3 grid grid-cols-3 gap-2 text-center text-[9px]"><div className="rounded-xl bg-secondary p-2">CAGR<br /><b>{decimalPercent(oos.cagr)}</b></div><div className="rounded-xl bg-secondary p-2">MDD<br /><b>{decimalPercent(oos.maxDrawdown)}</b></div><div className="rounded-xl bg-secondary p-2">Sharpe<br /><b>{ratio(oos.sharpe)}</b></div></div>
        </div>
      </div>
      <div className="grid gap-3 xl:grid-cols-[1fr_1fr]">
        <div className="rounded-[20px] bg-card p-4"><p className="text-xs font-black">최악 stress 시나리오</p>{worst.length ? <div className="mt-3 overflow-x-auto"><table className="w-full min-w-[520px] text-left text-[10px]"><thead><tr className="text-muted-foreground"><th className="p-2">시나리오</th><th className="p-2">누적</th><th className="p-2">CAGR</th><th className="p-2">MDD</th><th className="p-2">Sharpe</th></tr></thead><tbody>{worst.map((scenario, index) => { const metrics = researchRecord(scenario.metrics ?? scenario.summary); return <tr key={String(scenario.id ?? index)} className="border-t border-border"><td className="p-2 font-black">{String(scenario.name ?? scenario.id ?? `시나리오 ${index + 1}`)}</td><td className="p-2">{valuePercent(metrics.totalReturnPercent)}</td><td className="p-2">{valuePercent(metrics.cagrPercent)}</td><td className="p-2">{valuePercent(metrics.maxDrawdownPercent)}</td><td className="p-2">{ratio(metrics.sharpeRatio)}</td></tr>; })}</tbody></table></div> : <ArtifactPrompt label="최악 시나리오 불러오기" description="stress 결과에서 손실이 큰 시나리오를 불러옵니다." artifact={worstArtifact} />}{worstArtifact.error ? <p role="alert" className="mt-2 text-xs text-rose-500">{worstArtifact.error}</p> : null}</div>
        <div className="rounded-[20px] bg-card p-4"><div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs font-black">검증·데이터 품질·신뢰도</p><StatusBadge value={String(quality.status ?? "unavailable")} /></div><div className="mt-3 space-y-2">{components.map((component) => <div key={String(component.name)} className="rounded-2xl bg-secondary p-3 text-[10px]"><div className="flex justify-between gap-2"><span className="font-black">{String(component.name ?? "-")}</span><span>{component.available ? decimalPercent(component.raw) : "미제공"}</span></div><div className="mt-1 text-muted-foreground">weight {decimalPercent(component.weight)} · available {String(Boolean(component.available))}</div></div>)}</div>{calibrationArtifact.value !== undefined ? <LazyJsonDetails value={calibrationArtifact.value} className="mt-3 rounded-2xl bg-secondary p-3" /> : <ArtifactPrompt label="Calibration 불러오기" description="과거 origin별 예측구간 적중률과 편향을 불러옵니다." artifact={calibrationArtifact} />}{researchArray(quality.warnings ?? data.warnings).length ? <div className="mt-3 rounded-2xl bg-secondary p-3 text-[9px] leading-4 text-muted-foreground">{researchArray(quality.warnings ?? data.warnings).map((warning) => <p key={String(warning)}>{String(warning)}</p>)}</div> : null}</div>
      </div>
      <div className="rounded-[20px] bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-2"><div><p className="text-xs font-black">시장 국면 검증</p><p className="mt-1 text-[9px] text-muted-foreground">각 날짜 직전까지의 trailing 관측만 사용하는 risk-on · neutral · risk-off 분류</p></div><StatusBadge value={String(marketRegime.status ?? "unavailable")} /></div>
        <div className="mt-3 grid gap-2 sm:grid-cols-3"><div className="rounded-2xl bg-secondary p-3 text-[10px]"><p className="text-muted-foreground">LATEST</p><p className="mt-1 font-black">{String(researchRecord(marketRegime.latest).state ?? "-")}</p></div><div className="rounded-2xl bg-secondary p-3 text-[10px]"><p className="text-muted-foreground">SOURCE</p><p className="mt-1 font-black">{String(marketRegime.source ?? "-")}</p></div><div className="rounded-2xl bg-secondary p-3 text-[10px]"><p className="text-muted-foreground">COVERAGE</p><p className="mt-1 font-black">{decimalPercent(marketRegime.coverage)}</p></div></div>
        {regimeArtifact.value !== undefined ? <LazyJsonDetails value={regimeArtifact.value} className="mt-3 rounded-2xl bg-secondary p-3" /> : <ArtifactPrompt label="국면 관측·전이 불러오기" description="전체 시점별 국면, 상태 수와 전이 횟수를 별도 artifact에서 불러옵니다." artifact={regimeArtifact} />}
        {regimeArtifact.error ? <p role="alert" className="mt-2 text-xs text-rose-500">{regimeArtifact.error}</p> : null}
      </div>
      <div className="rounded-[20px] bg-card p-4">
        <div><p className="text-xs font-black">Ledger 민감도 비교</p><p className="mt-1 text-[9px] text-muted-foreground">기준 대비 거래비용·현금흐름·리밸런싱 정책 변화의 실제 경로 차이</p></div>
        {sensitivityScenarios.length ? <div className="mt-3 overflow-x-auto"><table className="w-full min-w-[760px] text-left text-[10px]"><thead><tr className="text-muted-foreground"><th className="p-2">시나리오</th><th className="p-2">누적</th><th className="p-2">Δ 누적</th><th className="p-2">MDD</th><th className="p-2">Δ MDD</th><th className="p-2">비용</th></tr></thead><tbody>{sensitivityScenarios.map((scenario, index) => { const metrics = researchRecord(scenario.metrics); const deltas = researchRecord(scenario.metricDeltas); return <tr key={String(scenario.id ?? index)} className="border-t border-border"><td className="p-2 font-black">{String(scenario.name ?? scenario.id ?? `민감도 ${index + 1}`)}</td><td className="p-2">{valuePercent(metrics.totalReturnPercent)}</td><td className="p-2">{valuePercent(deltas.totalReturnPercent)}</td><td className="p-2">{valuePercent(metrics.maxDrawdownPercent)}</td><td className="p-2">{valuePercent(deltas.maxDrawdownPercent)}</td><td className="p-2">{formatMoney(finiteNumber(metrics.totalTransactionCosts) ?? 0, "KRW")}</td></tr>; })}</tbody></table></div> : <ArtifactPrompt label="민감도 결과 불러오기" description="비용·현금흐름·리밸런싱 민감도 결과를 별도 artifact에서 불러옵니다." artifact={sensitivityArtifact} />}
        {sensitivityArtifact.error ? <p role="alert" className="mt-2 text-xs text-rose-500">{sensitivityArtifact.error}</p> : null}
      </div>
      {Object.keys(optimization).length ? <div className="border-t border-border pt-5"><div className="mb-3"><p className="text-xs font-black tracking-[0.1em]">SCREENING · LEDGER · PARETO</p><p className="mt-1 text-[9px] text-muted-foreground">동일 outlook 실행의 최적화 단계를 OOS·Monte Carlo·stress 결과와 함께 비교합니다.</p></div><OptimizationResearchResults result={optimization} run={run} onUnauthorized={onUnauthorized} objective={objective} theme={theme} /></div> : null}
      {data.limitation ? <p className="rounded-[18px] bg-card p-4 text-[10px] leading-5 text-muted-foreground">{String(data.limitation)}</p> : null}
    </div>
  );
}

const exposureLabels: Record<string, string> = { sector: "Sector", industry: "Industry", country: "Country", currency: "Currency", assetType: "Asset type" };

export function ExposureResearchResults({ result }: { result: unknown }) {
  const data = researchRecord(result);
  const exposures = researchRecord(data.exposures);
  const coverage = researchRecord(data.coverage);
  const quality = researchRecord(data.dataQuality);
  const hedge = researchRecord(data.currencyHedge);
  const factors = researchArray(data.factorExposures).map(researchRecord);
  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">{Object.keys(exposureLabels).map((dimension) => <div key={dimension} className="rounded-[20px] bg-card p-4"><div className="flex items-center justify-between gap-2"><p className="text-xs font-black">{exposureLabels[dimension]}</p><span className="text-[9px] font-black text-muted-foreground">coverage {decimalPercent(coverage[dimension])}</span></div><div className="mt-3 space-y-2">{researchArray(exposures[dimension]).map(researchRecord).slice(0, 12).map((item) => { const weight = finiteNumber(item.weight) ?? 0; return <div key={String(item.name)}><div className="flex justify-between gap-2 text-[9px]"><span className="truncate font-black">{String(item.name ?? "UNKNOWN")}</span><span>{decimalPercent(weight)}</span></div><div className="mt-1 h-1.5 overflow-hidden rounded-full bg-secondary"><div className="h-full rounded-full bg-foreground" style={{ width: `${Math.max(0, Math.min(100, weight * 100))}%` }} /></div></div>; })}</div></div>)}</div>
      <div className="grid gap-3 lg:grid-cols-3"><div className="rounded-[20px] bg-card p-4"><p className="text-xs font-black">환헤지 여부</p><div className="mt-3 grid grid-cols-3 gap-2 text-center text-[9px]"><div className="rounded-xl bg-secondary p-3">헤지<br /><b>{decimalPercent(hedge.hedgedWeight)}</b></div><div className="rounded-xl bg-secondary p-3">비헤지<br /><b>{decimalPercent(hedge.unhedgedWeight)}</b></div><div className="rounded-xl bg-secondary p-3">미확인<br /><b>{decimalPercent(hedge.unknownWeight)}</b></div></div></div><div className="rounded-[20px] bg-card p-4"><p className="text-xs font-black">Factor exposure</p><div className="mt-3 space-y-2">{factors.length ? factors.map((factor) => <div key={String(factor.factor)} className="flex justify-between gap-2 rounded-xl bg-secondary px-3 py-2 text-[9px]"><span className="font-black">{String(factor.factor)}</span><span>{ratio(factor.value)} · coverage {decimalPercent(factor.coverage)}</span></div>) : <p className="text-[10px] text-muted-foreground">공급된 factor 값이 없습니다.</p>}</div></div><div className="rounded-[20px] bg-card p-4"><div className="flex items-center justify-between gap-2"><p className="text-xs font-black">Look-through</p><StatusBadge value={String(quality.status ?? "unavailable")} /></div><p className="mt-3 text-lg font-black">{decimalPercent(coverage.lookThrough)}</p><p className="mt-1 text-[9px] leading-4 text-muted-foreground">ETF 구성종목 snapshot으로 설명 가능한 전체 비중입니다. 공급자가 제공하지 않은 필드는 UNKNOWN으로 유지합니다.</p></div></div>
      {researchArray(quality.byAsset).length ? <div className="overflow-x-auto rounded-[20px] bg-card p-3"><table className="w-full min-w-[820px] text-left text-[10px]"><thead><tr className="text-muted-foreground"><th className="p-3">종목</th><th className="p-3">Sector</th><th className="p-3">Industry</th><th className="p-3">Country</th><th className="p-3">Currency</th><th className="p-3">Asset type</th><th className="p-3">Factor</th><th className="p-3">ETF 구성</th></tr></thead><tbody>{researchArray(quality.byAsset).map(researchRecord).map((asset, index) => { const metadata = researchRecord(asset.metadata); return <tr key={String(asset.symbol ?? index)} className="border-t border-border"><td className="p-3 font-black">{String(asset.symbol ?? "-")}</td>{["sector", "industry", "country", "currency", "asset_type", "factors", "etf_constituents"].map((key) => <td key={key} className="p-3"><StatusBadge value={String(metadata[key] ?? "unavailable")} /></td>)}</tr>; })}</tbody></table></div> : null}
      {researchArray(data.warnings).length ? <div className="rounded-[18px] bg-card p-4 text-[10px] leading-5 text-muted-foreground">{researchArray(data.warnings).map((warning) => <p key={String(warning)}>{String(warning)}</p>)}</div> : null}
    </div>
  );
}

export function SavedResearchRunResults({ snapshot, theme, onUnauthorized }: { snapshot: AdvancedRunSnapshot; theme: Theme; onUnauthorized: () => void }) {
  const result = snapshot.result ?? snapshot.summary;
  if (result === undefined) return <p className="rounded-2xl bg-secondary p-3 text-[10px] text-muted-foreground">표시할 결과 요약이 없습니다.</p>;
  if (snapshot.kind === "optimization") return <OptimizationResearchResults result={result} run={snapshot} objective="robust_score" theme={theme} onUnauthorized={onUnauthorized} />;
  if (snapshot.kind === "outlook") return <OutlookResearchResults result={result} run={snapshot} theme={theme} onUnauthorized={onUnauthorized} />;
  if (snapshot.kind === "exposure_analysis") return <ExposureResearchResults result={result} />;
  if (snapshot.kind === "pareto_frontier") return <OptimizationResearchResults result={{ paretoFrontier: researchRecord(result).candidates ?? result }} run={snapshot} objective="robust_score" theme={theme} onUnauthorized={onUnauthorized} />;
  if (snapshot.kind === "monte_carlo") return <LazyJsonDetails value={result} className="rounded-2xl bg-secondary p-3" />;
  return <LazyJsonDetails value={result} className="rounded-2xl bg-secondary p-3" />;
}
