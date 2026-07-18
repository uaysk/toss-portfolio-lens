import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  ComposedChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  Activity,
  BarChart3,
  CalendarDays,
  CircleDollarSign,
  Info,
  LoaderCircle,
  Plus,
  RefreshCw,
  Scale,
  Sparkles,
  Trash2,
  TrendingDown,
  TrendingUp,
  WalletCards,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ReportGenerateButton } from "@/components/report-generate-button";
import { StockSwatch } from "@/components/stock-swatch";
import { PortfolioStrategyLab } from "@/components/portfolio-strategy-lab";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { correlationAssetLabel, correlationCellStyle } from "@/lib/correlation-labels";
import { MONOCHROME_DASHES, MONOCHROME_SERIES, monochromeHeatmapStyle } from "@/lib/chart-theme";
import { removeBacktestAssetPreservingWeights } from "@/lib/backtest-assets";
import { scaleBacktestAssetWeights } from "@/lib/backtest-config";
import { seoulDateString } from "@/lib/date-range";
import { formatMoney, formatPercent, formatSignedMoney } from "@/lib/format";
import { stockColor } from "@/lib/stock-appearance";
import { cn } from "@/lib/utils";
import type {
  ApiError,
  BacktestAsset,
  BacktestBenchmarkKey,
  BacktestCashFlowFrequency,
  BacktestCashFlowRebalanceMode,
  BacktestCashFlowTiming,
  BacktestCustomCashFlow,
  BacktestInstrument,
  BacktestQuantityMode,
  BacktestRebalanceFrequency,
  BacktestResult,
  BacktestRunConfiguration,
  CurrentBacktestPortfolio,
  Portfolio,
  Theme,
} from "@/types";

const benchmarkOptions: Array<{ value: BacktestBenchmarkKey; label: string }> = [
  { value: "NONE", label: "비교 지수 없음" },
  { value: "KOSPI", label: "KOSPI" },
  { value: "KOSDAQ", label: "KOSDAQ" },
  { value: "NASDAQ100", label: "나스닥 100 · QQQ" },
  { value: "SP500", label: "S&P 500 · SPY" },
  { value: "CUSTOM", label: "개별 종목 직접 선택" },
];

const rebalanceOptions: Array<{ value: BacktestRebalanceFrequency; label: string }> = [
  { value: "none", label: "리밸런싱 안 함" },
  { value: "monthly", label: "매월" },
  { value: "quarterly", label: "분기" },
  { value: "annually", label: "매년" },
  { value: "threshold", label: "비중 이탈 임계치" },
];

function rebalanceEvenly(assets: BacktestAsset[], totalWeight = 100): BacktestAsset[] {
  if (!assets.length) return [];
  const base = Math.floor((totalWeight / assets.length) * 100) / 100;
  return assets.map((asset, index) => ({
    ...asset,
    weight: index === assets.length - 1 ? Math.round((totalWeight - base * (assets.length - 1)) * 100) / 100 : base,
  }));
}

function latestListDate(assets: BacktestAsset[]): string {
  return assets.map((asset) => asset.listDate).filter(Boolean).sort().at(-1) ?? "";
}

function shortDate(value: string): string {
  return value.slice(2).replaceAll("-", ".");
}

function metricValue(value: number | null, kind: "percent" | "ratio" = "percent"): string {
  if (value === null) return "데이터 부족";
  return kind === "ratio" ? value.toFixed(2) : formatPercent(value, true);
}

function ResultMetric({ icon: Icon, label, value, detail, benchmark }: {
  icon: typeof Activity;
  label: string;
  value: string;
  detail: string;
  benchmark?: { name: string; value: string; detail?: string };
}) {
  return (
    <div className="min-w-0 rounded-[20px] bg-card p-4 sm:p-5">
      <div className="flex items-center gap-2 text-muted-foreground">
        <Icon className="size-4" aria-hidden="true" />
        <p className="text-[11px] font-bold">{label}</p>
      </div>
      <p className="mt-3 break-words text-xl font-black tracking-[-0.035em]">{value}</p>
      {benchmark ? (
        <div className="mt-3 rounded-[14px] bg-secondary px-3 py-2.5">
          <p className="truncate text-[9px] font-black tracking-[0.08em] text-muted-foreground">벤치마크 · {benchmark.name}</p>
          <p className="mt-1 text-sm font-black">{benchmark.value}</p>
          {benchmark.detail ? <p className="mt-1 text-[9px] text-muted-foreground">{benchmark.detail}</p> : null}
        </div>
      ) : null}
      <p className="mt-2 text-[11px] leading-4 text-muted-foreground">{detail}</p>
    </div>
  );
}

export function PortfolioBacktestView({
  portfolio,
  theme,
  onUnauthorized,
  mode = "backtest",
}: {
  portfolio: Portfolio;
  theme: Theme;
  onUnauthorized: () => void;
  mode?: "backtest" | "optimization";
}) {
  const today = useMemo(() => seoulDateString(), []);
  const [assets, setAssets] = useState<BacktestAsset[]>([]);
  const [symbol, setSymbol] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState(today);
  const [initialAmount, setInitialAmount] = useState(10_000_000);
  const [monthlyCashFlow, setMonthlyCashFlow] = useState(0);
  const [cashFlowFrequency, setCashFlowFrequency] = useState<BacktestCashFlowFrequency>("monthly");
  const [cashFlowTiming, setCashFlowTiming] = useState<BacktestCashFlowTiming>("period_start");
  const [rebalanceFrequency, setRebalanceFrequency] = useState<BacktestRebalanceFrequency>("annually");
  const [rebalanceThresholdPercent, setRebalanceThresholdPercent] = useState(5);
  const [riskFreeRatePercent, setRiskFreeRatePercent] = useState(0);
  const [transactionCostBps, setTransactionCostBps] = useState(0);
  const [currencyMode, setCurrencyMode] = useState<"local" | "KRW">("KRW");
  const [cashTargetPercent, setCashTargetPercent] = useState(0);
  const [quantityMode, setQuantityMode] = useState<BacktestQuantityMode>("fractional");
  const [cashFlowRebalanceMode, setCashFlowRebalanceMode] = useState<BacktestCashFlowRebalanceMode>("target_weights");
  const [cashAnnualYieldPercent, setCashAnnualYieldPercent] = useState(0);
  const [customCashFlows, setCustomCashFlows] = useState<BacktestCustomCashFlow[]>([]);
  const [benchmark, setBenchmark] = useState<BacktestBenchmarkKey>("KOSPI");
  const [benchmarkSymbol, setBenchmarkSymbol] = useState("");
  const [loadingCurrent, setLoadingCurrent] = useState(false);
  const [adding, setAdding] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<BacktestResult>();
  const [backtestRuns, setBacktestRuns] = useState<Array<{ runId: string; label: string }>>([]);
  const manuallyEditedStart = useRef(false);

  const loadCurrentPortfolio = useCallback(async () => {
    setLoadingCurrent(true);
    setError("");
    try {
      const params = new URLSearchParams({ account: portfolio.selectedAccountId });
      const response = await fetch(`/api/portfolio/backtest/current?${params.toString()}`, { headers: { Accept: "application/json" } });
      const payload = await response.json().catch(() => ({})) as CurrentBacktestPortfolio & ApiError;
      if (response.status === 401) {
        onUnauthorized();
        return;
      }
      if (!response.ok) throw new Error(payload.error?.message || "현재 포트폴리오를 불러오지 못했습니다.");
      setAssets(payload.assets);
      setCashTargetPercent(0);
      setStartDate(payload.defaultStartDate);
      setEndDate(payload.defaultEndDate);
      if (payload.initialAmount >= 10_000) setInitialAmount(payload.initialAmount);
      manuallyEditedStart.current = false;
      setResult(undefined);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "현재 포트폴리오를 불러오지 못했습니다.");
    } finally {
      setLoadingCurrent(false);
    }
  }, [onUnauthorized, portfolio.selectedAccountId]);

  useEffect(() => {
    void loadCurrentPortfolio();
  }, [loadCurrentPortfolio]);

  const addInstrument = async () => {
    const normalized = symbol.trim().toUpperCase();
    if (!normalized || assets.some((asset) => asset.symbol === normalized)) return;
    setAdding(true);
    setError("");
    try {
      const response = await fetch(`/api/portfolio/backtest/instruments?symbols=${encodeURIComponent(normalized)}`, {
        headers: { Accept: "application/json" },
      });
      const payload = await response.json().catch(() => ({})) as { instruments?: BacktestInstrument[] } & ApiError;
      if (response.status === 401) {
        onUnauthorized();
        return;
      }
      if (!response.ok || !payload.instruments?.length) {
        throw new Error(payload.error?.message || "종목 정보를 찾지 못했습니다.");
      }
      const next = rebalanceEvenly([...assets, { ...payload.instruments[0], weight: 0, lotSize: 1 }], 100 - cashTargetPercent);
      setAssets(next);
      if (!manuallyEditedStart.current) setStartDate(latestListDate(next));
      setSymbol("");
      setResult(undefined);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "종목을 추가하지 못했습니다.");
    } finally {
      setAdding(false);
    }
  };

  const removeAsset = (assetSymbol: string) => {
    const next = removeBacktestAssetPreservingWeights(assets, assetSymbol);
    setAssets(next);
    if (!manuallyEditedStart.current) setStartDate(latestListDate(next));
    setResult(undefined);
  };

  const weightTotal = assets.reduce((sum, asset) => sum + asset.weight, 0);
  const canRun = assets.length > 0
    && Math.abs(weightTotal + cashTargetPercent - 100) <= 0.01
    && Boolean(startDate)
    && startDate <= endDate
    && endDate <= today
    && initialAmount >= 10_000
    && Number.isFinite(riskFreeRatePercent)
    && riskFreeRatePercent >= -10
    && riskFreeRatePercent <= 50
    && Number.isFinite(transactionCostBps)
    && transactionCostBps >= 0
    && transactionCostBps <= 500
    && cashTargetPercent >= 0
    && cashTargetPercent < 100
    && cashAnnualYieldPercent >= -100
    && cashAnnualYieldPercent <= 100
    && (quantityMode !== "whole" || assets.every((asset) => Number.isFinite(asset.lotSize ?? 1) && (asset.lotSize ?? 1) > 0))
    && (rebalanceFrequency !== "threshold" || (rebalanceThresholdPercent >= 0.1 && rebalanceThresholdPercent <= 50))
    && customCashFlows.every((flow) => Boolean(flow.date) && flow.date >= startDate && flow.date <= endDate && Number.isFinite(flow.amount))
    && (benchmark !== "CUSTOM" || Boolean(benchmarkSymbol.trim()));

  const baseConfig = useMemo<BacktestRunConfiguration>(() => ({
    assets: assets.map((asset) => ({ symbol: asset.symbol, weight: asset.weight, lotSize: asset.lotSize ?? 1 })),
    startDate,
    endDate,
    initialAmount,
    monthlyCashFlow,
    cashFlowFrequency,
    cashFlowTiming,
    rebalanceFrequency,
    ...(rebalanceFrequency === "threshold" ? { rebalanceThresholdPercent } : {}),
    riskFreeRatePercent,
    transactionCostBps,
    currencyMode,
    baseCurrency: "KRW",
    cashFlows: customCashFlows.map((flow) => ({ ...flow, ...(flow.memo?.trim() ? { memo: flow.memo.trim() } : {}) })),
    execution: {
      cashTargetPercent,
      quantityMode,
      cashFlowRebalanceMode,
      tradeDatePolicy: "next_common_observation",
      cashAnnualYieldPercent,
    },
    benchmark,
    ...(benchmark === "CUSTOM" ? { benchmarkSymbol: benchmarkSymbol.trim().toUpperCase() } : {}),
  }), [assets, benchmark, benchmarkSymbol, cashAnnualYieldPercent, cashFlowFrequency, cashFlowRebalanceMode, cashFlowTiming, cashTargetPercent, currencyMode, customCashFlows, endDate, initialAmount, monthlyCashFlow, quantityMode, rebalanceFrequency, rebalanceThresholdPercent, riskFreeRatePercent, startDate, transactionCostBps]);

  const runBacktest = async () => {
    if (!canRun) return;
    setRunning(true);
    setError("");
    try {
      const response = await fetch("/api/portfolio/backtest", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(baseConfig),
      });
      const payload = await response.json().catch(() => ({})) as BacktestResult & ApiError;
      if (response.status === 401) {
        onUnauthorized();
        return;
      }
      if (!response.ok) throw new Error(payload.error?.message || "백테스트를 실행하지 못했습니다.");
      setResult(payload);
      if (payload.runId) {
        const label = `${new Date(payload.generatedAt).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })} · ${payload.config.assets.length}종목 · CAGR ${payload.metrics.cagrPercent === null ? "-" : formatPercent(payload.metrics.cagrPercent, true)}`;
        setBacktestRuns((current) => [{ runId: payload.runId!, label }, ...current.filter((item) => item.runId !== payload.runId)].slice(0, 20));
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "백테스트를 실행하지 못했습니다.");
    } finally {
      setRunning(false);
    }
  };

  const advanced = result?.advanced;
  const rollingData = advanced?.rolling.filter((point) => (
    point.return20d !== null || point.return60d !== null || point.volatility60d !== null
  )) ?? [];
  const hasRolling60 = rollingData.some((point) => point.volatility60d !== null);
  const monthlyYears = useMemo(() => {
    const years = new Map<string, Record<number, number>>();
    for (const item of advanced?.monthlyReturns ?? []) {
      const [year, month] = item.month.split("-");
      const values = years.get(year) ?? {};
      values[Number(month)] = item.returnPercent;
      years.set(year, values);
    }
    return Array.from(years, ([year, months]) => ({ year, months })).sort((left, right) => left.year.localeCompare(right.year));
  }, [advanced?.monthlyReturns]);

  return (
    <section aria-label={mode === "backtest" ? "포트폴리오 백테스트" : "포트폴리오 최적화"} className="flex flex-col gap-3">
      <Card className={cn("bg-secondary p-5 sm:p-7", mode === "optimization" && "order-2")}>
        <div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
          <div className="max-w-2xl">
            <div className="mb-2 flex items-center gap-2 text-xs font-bold tracking-[0.14em] text-muted-foreground">
              {mode === "backtest" ? <BarChart3 className="size-4" aria-hidden="true" /> : <Sparkles className="size-4" aria-hidden="true" />}
              {mode === "backtest" ? "PORTFOLIO BACKTEST" : "OPTIMIZATION UNIVERSE"}
            </div>
            <h2 id="backtest-title" className="text-2xl font-black tracking-[-0.04em]">{mode === "backtest" ? "포트폴리오 전략 백테스트" : "최적화 기준 포트폴리오"}</h2>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              {mode === "backtest"
                ? "국내·미국 종목의 수정주가로 과거 성장, 위험, 낙폭, 기여도와 상관관계를 비교합니다."
                : "탐색할 종목과 기준 비중을 먼저 정한 뒤 Rust worker에서 후보 평가, Walk-forward와 Monte Carlo를 실행합니다."}
            </p>
          </div>
          <Button type="button" variant="secondary" onClick={() => void loadCurrentPortfolio()} disabled={loadingCurrent}>
            {loadingCurrent ? <LoaderCircle className="animate-spin" /> : <WalletCards />}
            현재 포트폴리오 불러오기
          </Button>
        </div>

        <div className="mt-6 rounded-[24px] bg-card p-4 sm:p-5">
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              value={symbol}
              onChange={(event) => setSymbol(event.target.value.toUpperCase())}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void addInstrument();
                }
              }}
              placeholder="종목코드 또는 티커 · 005930, AAPL"
              aria-label="백테스트 종목 코드"
              maxLength={32}
              className="bg-secondary"
            />
            <Button type="button" onClick={() => void addInstrument()} disabled={adding || !symbol.trim() || assets.length >= 20}>
              {adding ? <LoaderCircle className="animate-spin" /> : <Plus />}
              종목 추가
            </Button>
            <Button type="button" variant="secondary" onClick={() => setAssets(rebalanceEvenly(assets, 100 - cashTargetPercent))} disabled={!assets.length}>
              <Scale />균등 배분
            </Button>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">토스 종목 마스터의 정확한 심볼을 사용합니다. 국내 6자리 코드와 미국 티커를 한 포트폴리오에 함께 넣을 수 있습니다.</p>
        </div>

        <div className="mt-3 space-y-2">
          {assets.map((asset) => (
            <div key={`${asset.currency}:${asset.symbol}`} className={cn("grid gap-3 rounded-[22px] bg-card p-4 sm:items-center", quantityMode === "whole" ? "sm:grid-cols-[minmax(0,1fr)_132px_112px_44px]" : "sm:grid-cols-[minmax(0,1fr)_132px_44px]")}>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <StockSwatch symbol={asset.symbol} theme={theme} />
                  <p className="truncate text-sm font-black">{asset.name}</p>
                  <span className="rounded-full bg-secondary px-2.5 py-1 text-[10px] font-black text-muted-foreground">{asset.currency}</span>
                </div>
                <p className="mt-1 text-[11px] font-bold text-muted-foreground">{asset.market} · {asset.symbol} · 상장 {asset.listDate}</p>
              </div>
              <label>
                <span className="mb-1 block text-[10px] font-bold text-muted-foreground">목표 비중</span>
                <div className="relative">
                  <Input
                    type="number"
                    min={0.01}
                    max={100}
                    step={0.01}
                    value={asset.weight}
                    onChange={(event) => {
                      const value = Number(event.target.value);
                      setAssets((current) => current.map((candidate) => candidate.symbol === asset.symbol
                        ? { ...candidate, weight: Number.isFinite(value) ? value : 0 }
                        : candidate));
                      setResult(undefined);
                    }}
                    className="h-11 bg-secondary pr-9 text-right font-black"
                    aria-label={`${asset.name} 목표 비중`}
                  />
                  <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs font-bold text-muted-foreground">%</span>
                </div>
              </label>
              {quantityMode === "whole" ? (
                <label>
                  <span className="mb-1 block text-[10px] font-bold text-muted-foreground">거래 단위</span>
                  <Input
                    type="number"
                    min={0.000001}
                    max={1_000_000}
                    step={1}
                    value={asset.lotSize ?? 1}
                    onChange={(event) => {
                      const value = Number(event.target.value);
                      setAssets((current) => current.map((candidate) => candidate.symbol === asset.symbol ? { ...candidate, lotSize: value } : candidate));
                      setResult(undefined);
                    }}
                    className="h-11 bg-secondary text-right font-black"
                    aria-label={`${asset.name} 거래 단위`}
                  />
                </label>
              ) : null}
              <Button type="button" variant="ghost" size="icon" onClick={() => removeAsset(asset.symbol)} aria-label={`${asset.name} 제거`}>
                <Trash2 />
              </Button>
            </div>
          ))}
          {!assets.length && !loadingCurrent ? (
            <div className="rounded-[22px] bg-card p-6 text-center text-sm text-muted-foreground">현재 포트폴리오를 불러오거나 종목 코드를 직접 추가해 주세요.</div>
          ) : null}
        </div>

        <div className="mt-3 flex items-center justify-between rounded-[18px] bg-card px-4 py-3 text-xs font-bold">
          <span className="text-muted-foreground">총 {assets.length}종목 · 주식 {weightTotal.toFixed(2)}% + 현금 {cashTargetPercent.toFixed(2)}%</span>
          <span className={cn(Math.abs(weightTotal + cashTargetPercent - 100) > 0.01 && "text-rose-500")}>{(weightTotal + cashTargetPercent).toFixed(2)}%</span>
        </div>
      </Card>

      <Card className={cn("bg-secondary p-5 sm:p-7", mode === "optimization" && "order-3")}>
        <p className="text-xs font-bold tracking-[0.14em] text-muted-foreground">{mode === "backtest" ? "ASSUMPTIONS" : "OPTIMIZATION BASELINE"}</p>
        <h3 className="mt-2 text-xl font-black tracking-[-0.035em]">{mode === "backtest" ? "기간과 운용 조건" : "탐색 기준과 비용 조건"}</h3>
        <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <label className="rounded-[20px] bg-card p-4">
            <span className="mb-2 block text-[11px] font-bold text-muted-foreground">시작일</span>
            <Input
              type="date"
              value={startDate}
              min={latestListDate(assets)}
              max={endDate}
              onChange={(event) => {
                manuallyEditedStart.current = true;
                setStartDate(event.target.value);
                setResult(undefined);
              }}
              className="bg-secondary"
            />
            <span className="mt-2 block text-[10px] text-muted-foreground">기본값: 가장 늦은 상장일 {latestListDate(assets) || "-"}</span>
          </label>
          <label className="rounded-[20px] bg-card p-4">
            <span className="mb-2 block text-[11px] font-bold text-muted-foreground">종료일</span>
            <Input type="date" value={endDate} min={startDate} max={today} onChange={(event) => { setEndDate(event.target.value); setResult(undefined); }} className="bg-secondary" />
            <span className="mt-2 block text-[10px] text-muted-foreground">기본값: 현재 날짜 {today}</span>
          </label>
          <label className="rounded-[20px] bg-card p-4">
            <span className="mb-2 block text-[11px] font-bold text-muted-foreground">초기 투자금 · KRW</span>
            <Input type="number" min={10_000} step={100_000} value={initialAmount} onChange={(event) => { setInitialAmount(Number(event.target.value)); setResult(undefined); }} className="bg-secondary text-right font-black" />
            <span className="mt-2 block text-[10px] text-muted-foreground">현재 포트폴리오 불러오기 시 원화 환산 평가액</span>
          </label>
          <label className="rounded-[20px] bg-card p-4">
            <span className="mb-2 block text-[11px] font-bold text-muted-foreground">월 정기 현금흐름 · KRW</span>
            <Input type="number" step={100_000} value={monthlyCashFlow} onChange={(event) => { setMonthlyCashFlow(Number(event.target.value)); setResult(undefined); }} className="bg-secondary text-right font-black" />
            <span className="mt-2 block text-[10px] text-muted-foreground">양수는 추가 투자, 음수는 정기 인출</span>
          </label>
          <label className="rounded-[20px] bg-card p-4">
            <span className="mb-2 block text-[11px] font-bold text-muted-foreground">리밸런싱</span>
            <Select value={rebalanceFrequency} onValueChange={(value) => { setRebalanceFrequency(value as BacktestRebalanceFrequency); setResult(undefined); }}>
              <SelectTrigger className="w-full rounded-2xl bg-secondary"><SelectValue /></SelectTrigger>
              <SelectContent>{rebalanceOptions.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent>
            </Select>
            <span className="mt-2 block text-[10px] text-muted-foreground">기간 첫 거래일에 목표 비중으로 조정</span>
          </label>
          {rebalanceFrequency === "threshold" ? (
            <label className="rounded-[20px] bg-card p-4">
              <span className="mb-2 block text-[11px] font-bold text-muted-foreground">비중 이탈 임계치 · %p</span>
              <Input type="number" min={0.1} max={50} step={0.1} value={rebalanceThresholdPercent} onChange={(event) => { setRebalanceThresholdPercent(Number(event.target.value)); setResult(undefined); }} className="bg-secondary text-right font-black" />
              <span className="mt-2 block text-[10px] text-muted-foreground">목표 비중과 실제 비중 차이가 기준을 넘을 때만 조정</span>
            </label>
          ) : null}
          <label className="rounded-[20px] bg-card p-4">
            <span className="mb-2 block text-[11px] font-bold text-muted-foreground">벤치마크</span>
            <Select value={benchmark} onValueChange={(value) => { setBenchmark(value as BacktestBenchmarkKey); setResult(undefined); }}>
              <SelectTrigger className="w-full rounded-2xl bg-secondary"><SelectValue /></SelectTrigger>
              <SelectContent>{benchmarkOptions.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent>
            </Select>
            {benchmark === "CUSTOM" ? (
              <Input
                value={benchmarkSymbol}
                onChange={(event) => { setBenchmarkSymbol(event.target.value.toUpperCase()); setResult(undefined); }}
                placeholder="종목코드 또는 티커 · 005930, AAPL"
                aria-label="벤치마크 종목 코드"
                maxLength={32}
                className="mt-2 bg-secondary"
              />
            ) : null}
            <span className="mt-2 block text-[10px] text-muted-foreground">지수 프록시 또는 국내·해외 개별 종목 수정주가</span>
          </label>
          <label className="rounded-[20px] bg-card p-4">
            <span className="mb-2 block text-[11px] font-bold text-muted-foreground">연 무위험수익률 · %</span>
            <Input type="number" min={-10} max={50} step={0.1} value={riskFreeRatePercent} onChange={(event) => { setRiskFreeRatePercent(Number(event.target.value)); setResult(undefined); }} className="bg-secondary text-right font-black" />
            <span className="mt-2 block text-[10px] text-muted-foreground">Sharpe·Sortino·알파 및 롤링 위험에 반영</span>
          </label>
          <label className="rounded-[20px] bg-card p-4">
            <span className="mb-2 block text-[11px] font-bold text-muted-foreground">거래비용 가정 · bp</span>
            <Input type="number" min={0} max={500} step={1} value={transactionCostBps} onChange={(event) => { setTransactionCostBps(Number(event.target.value)); setResult(undefined); }} className="bg-secondary text-right font-black" />
            <span className="mt-2 block text-[10px] text-muted-foreground">1bp=0.01% · 초기매수·현금흐름·리밸런싱 거래</span>
          </label>
        </div>

        <div className="mt-6 border-t border-border pt-6">
          <p className="text-xs font-bold tracking-[0.14em] text-muted-foreground">EXECUTION & CASH</p>
          <h4 className="mt-2 text-lg font-black tracking-[-0.03em]">체결·현금·환율 경로</h4>
          <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <label className="rounded-[20px] bg-card p-4">
              <span className="mb-2 block text-[11px] font-bold text-muted-foreground">수익 경로 통화</span>
              <Select value={currencyMode} onValueChange={(value) => { setCurrencyMode(value as "local" | "KRW"); setResult(undefined); }}>
                <SelectTrigger className="w-full rounded-2xl bg-secondary"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="KRW">과거 USD/KRW 환율 반영</SelectItem><SelectItem value="local">현지통화 수익률 합성</SelectItem></SelectContent>
              </Select>
              <span className="mt-2 block text-[10px] text-muted-foreground">KRW는 해외 종목 가격을 날짜별 환율로 원화 환산</span>
            </label>
            <label className="rounded-[20px] bg-card p-4">
              <span className="mb-2 block text-[11px] font-bold text-muted-foreground">현금 목표 비중 · %</span>
              <Input
                type="number" min={0} max={99.99} step={0.1} value={cashTargetPercent}
                onChange={(event) => {
                  const next = Math.min(99.99, Math.max(0, Number(event.target.value)));
                  setCashTargetPercent(next);
                  setAssets((current) => scaleBacktestAssetWeights(current, 100 - next));
                  setResult(undefined);
                }}
                className="bg-secondary text-right font-black"
              />
              <span className="mt-2 block text-[10px] text-muted-foreground">변경 시 종목 비중을 투자 가능 비중에 맞춰 비례 조정</span>
            </label>
            <label className="rounded-[20px] bg-card p-4">
              <span className="mb-2 block text-[11px] font-bold text-muted-foreground">수량 체결 방식</span>
              <Select value={quantityMode} onValueChange={(value) => { setQuantityMode(value as BacktestQuantityMode); setResult(undefined); }}>
                <SelectTrigger className="w-full rounded-2xl bg-secondary"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="fractional">소수 수량 허용</SelectItem><SelectItem value="whole">정수·lot 수량</SelectItem></SelectContent>
              </Select>
              <span className="mt-2 block text-[10px] text-muted-foreground">정수 모드는 매수 후 남은 금액을 현금으로 유지</span>
            </label>
            <label className="rounded-[20px] bg-card p-4">
              <span className="mb-2 block text-[11px] font-bold text-muted-foreground">현금 연수익률 · %</span>
              <Input type="number" min={-100} max={100} step={0.1} value={cashAnnualYieldPercent} onChange={(event) => { setCashAnnualYieldPercent(Number(event.target.value)); setResult(undefined); }} className="bg-secondary text-right font-black" />
              <span className="mt-2 block text-[10px] text-muted-foreground">잔여 현금과 목표 현금 포지션에 일할 적용</span>
            </label>
            <label className="rounded-[20px] bg-card p-4">
              <span className="mb-2 block text-[11px] font-bold text-muted-foreground">정기 현금흐름 주기</span>
              <Select value={cashFlowFrequency} onValueChange={(value) => { setCashFlowFrequency(value as BacktestCashFlowFrequency); setResult(undefined); }}><SelectTrigger className="w-full rounded-2xl bg-secondary"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="monthly">매월</SelectItem><SelectItem value="quarterly">분기</SelectItem><SelectItem value="annually">매년</SelectItem></SelectContent></Select>
            </label>
            <label className="rounded-[20px] bg-card p-4">
              <span className="mb-2 block text-[11px] font-bold text-muted-foreground">정기 현금흐름 시점</span>
              <Select value={cashFlowTiming} onValueChange={(value) => { setCashFlowTiming(value as BacktestCashFlowTiming); setResult(undefined); }}><SelectTrigger className="w-full rounded-2xl bg-secondary"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="period_start">기간 시작</SelectItem><SelectItem value="period_end">기간 종료</SelectItem></SelectContent></Select>
            </label>
            <label className="rounded-[20px] bg-card p-4 md:col-span-2">
              <span className="mb-2 block text-[11px] font-bold text-muted-foreground">현금흐름 기반 리밸런싱</span>
              <Select value={cashFlowRebalanceMode} onValueChange={(value) => { setCashFlowRebalanceMode(value as BacktestCashFlowRebalanceMode); setResult(undefined); }}><SelectTrigger className="w-full rounded-2xl bg-secondary"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="target_weights">목표 비중대로 신규 매수</SelectItem><SelectItem value="drift_reduction">저비중 종목부터 보정</SelectItem><SelectItem value="full">매도 포함 완전 재조정</SelectItem></SelectContent></Select>
              <span className="mt-2 block text-[10px] text-muted-foreground">입출금 발생일에 적용할 종목별 배분·매도 정책</span>
            </label>
          </div>
        </div>

        <div className="mt-6 border-t border-border pt-6">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div><p className="text-xs font-bold tracking-[0.14em] text-muted-foreground">CUSTOM CASH FLOWS</p><h4 className="mt-2 text-lg font-black tracking-[-0.03em]">사용자 지정 입출금</h4></div>
            <Button type="button" variant="secondary" onClick={() => setCustomCashFlows((current) => [...current, { date: startDate || today, amount: 0, memo: "" }])} disabled={customCashFlows.length >= 1000}><Plus />현금흐름 추가</Button>
          </div>
          <div className="mt-4 space-y-2">
            {customCashFlows.map((flow, index) => (
              <div key={`${index}:${flow.date}`} className="grid gap-2 rounded-[18px] bg-card p-3 sm:grid-cols-[150px_180px_minmax(0,1fr)_44px]">
                <Input type="date" min={startDate} max={endDate} value={flow.date} aria-label={`사용자 현금흐름 ${index + 1} 날짜`} onChange={(event) => { setCustomCashFlows((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, date: event.target.value } : item)); setResult(undefined); }} className="bg-secondary" />
                <Input type="number" step={100_000} value={flow.amount} aria-label={`사용자 현금흐름 ${index + 1} 금액`} onChange={(event) => { setCustomCashFlows((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, amount: Number(event.target.value) } : item)); setResult(undefined); }} className="bg-secondary text-right" />
                <Input value={flow.memo ?? ""} maxLength={200} placeholder="메모 · 선택" aria-label={`사용자 현금흐름 ${index + 1} 메모`} onChange={(event) => setCustomCashFlows((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, memo: event.target.value } : item))} className="bg-secondary" />
                <Button type="button" variant="ghost" size="icon" onClick={() => { setCustomCashFlows((current) => current.filter((_, itemIndex) => itemIndex !== index)); setResult(undefined); }} aria-label={`사용자 현금흐름 ${index + 1} 제거`}><Trash2 /></Button>
              </div>
            ))}
            {!customCashFlows.length ? <p className="rounded-[18px] bg-card px-4 py-3 text-xs text-muted-foreground">정기 현금흐름 외의 일회성 납입·인출을 추가하면 실제 공통 거래일로 이동해 XIRR에 반영합니다.</p> : null}
          </div>
        </div>

        {error ? <p role="alert" className="mt-4 rounded-[18px] bg-card px-4 py-3 text-sm font-semibold text-rose-500">{error}</p> : null}
        <Button type="button" className="mt-5 w-full sm:w-auto" onClick={() => void runBacktest()} disabled={!canRun || running}>
          {running ? <LoaderCircle className="animate-spin" /> : <TrendingUp />}
          {running ? "수정주가를 수집하고 계산하는 중" : mode === "backtest" ? "백테스트 실행" : "비교 기준 백테스트 저장"}
        </Button>
      </Card>

      {mode === "optimization" ? (
        <div className="order-1">
          <PortfolioStrategyLab
            baseConfig={baseConfig}
            canAnalyze={canRun}
            backtestRuns={backtestRuns}
            theme={theme}
            onUnauthorized={onUnauthorized}
          />
        </div>
      ) : null}

      {mode === "backtest" && result ? (
        <>
          <Card className="bg-secondary p-5 sm:p-7">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="max-w-2xl">
                <p className="text-xs font-bold tracking-[0.14em] text-muted-foreground">AI REPORT</p>
                <h3 className="mt-2 text-xl font-black tracking-[-0.035em]">백테스트 평가 보고서</h3>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">동일한 종목·비중·기간·현금흐름 조건을 다시 실행하고, 성과와 위험을 고정 템플릿으로 평가합니다.</p>
              </div>
              <ReportGenerateButton
                key={result.generatedAt}
                endpoint="/api/reports/backtest"
                requestBody={{
                  assets: result.config.assets,
                  startDate: result.config.startDate,
                  endDate: result.config.endDate,
                  initialAmount: result.config.initialAmount,
                  monthlyCashFlow: result.config.monthlyCashFlow,
                  cashFlowFrequency: result.config.cashFlowFrequency,
                  cashFlowTiming: result.config.cashFlowTiming,
                  rebalanceFrequency: result.config.rebalanceFrequency,
                  ...(result.config.rebalanceThresholdPercent !== undefined ? { rebalanceThresholdPercent: result.config.rebalanceThresholdPercent } : {}),
                  riskFreeRatePercent: result.config.riskFreeRatePercent ?? 0,
                  transactionCostBps: result.config.transactionCostBps ?? 0,
                  currencyMode: result.config.currencyMode,
                  baseCurrency: "KRW",
                  cashFlows: result.config.cashFlows,
                  execution: result.config.execution,
                  benchmark: result.config.benchmark,
                  ...(result.config.benchmarkSymbol ? { benchmarkSymbol: result.config.benchmarkSymbol } : {}),
                }}
                onUnauthorized={onUnauthorized}
              />
            </div>
          </Card>

          <Card className="bg-secondary p-5 sm:p-7">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <p className="text-xs font-bold tracking-[0.14em] text-muted-foreground">GROWTH OF INVESTMENT</p>
                <h3 className="mt-2 text-xl font-black tracking-[-0.035em]">현금흐름 제거 성장 비교</h3>
                <p className="mt-2 text-sm text-muted-foreground">{result.effectiveStartDate}~{result.endDate} · 시작금 {formatMoney(result.config.initialAmount, "KRW")}</p>
              </div>
              <div className="text-right"><p className="text-sm font-black">최종 잔액 {formatMoney(result.metrics.finalBalance, "KRW")}</p><p className="mt-1 text-[10px] font-bold text-muted-foreground">{result.currencyMethod === "KRW_FX_CONVERTED" ? "과거 환율 반영 KRW 경로" : "현지통화 수익률 합성"}</p></div>
            </div>
            <p className="mt-6 text-xs font-black">시간가중 성장 경로</p>
            <div className="mt-3 h-[300px] min-w-0 sm:h-[360px]">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={result.points} margin={{ top: 10, right: 8, left: 0, bottom: 4 }}>
                  <CartesianGrid vertical={false} stroke="hsl(var(--chart-grid))" strokeDasharray="3 7" />
                  <XAxis dataKey="date" tickFormatter={shortDate} minTickGap={42} tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
                  <YAxis tickFormatter={(value) => formatMoney(Number(value), "KRW", true)} width={62} tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
                  <Tooltip
                    labelFormatter={(value) => String(value)}
                    formatter={(value, name) => [formatMoney(Number(value), "KRW"), name === "growth" ? "포트폴리오 성장" : result.benchmark?.name || "비교 지수"]}
                    contentStyle={{ border: 0, borderRadius: 16, background: "hsl(var(--card))", color: "hsl(var(--foreground))" }}
                  />
                  <Line type="monotone" dataKey="growth" name="growth" stroke="hsl(var(--foreground))" strokeWidth={2.5} dot={false} activeDot={{ r: 4, strokeWidth: 0 }} />
                  {result.benchmark ? <Line type="monotone" dataKey="benchmarkGrowth" name="benchmark" stroke="hsl(var(--muted-foreground))" strokeWidth={2} strokeDasharray="6 5" dot={false} activeDot={{ r: 4, strokeWidth: 0 }} /> : null}
                </LineChart>
              </ResponsiveContainer>
            </div>
            <div className="mt-4 flex flex-wrap gap-4 text-xs font-bold text-muted-foreground">
              <span className="flex items-center gap-2"><i className="h-0.5 w-5 bg-foreground" />포트폴리오 TWR 성장</span>
              {result.benchmark ? <span className="flex items-center gap-2"><i className="h-0.5 w-5 bg-muted-foreground" />{result.benchmark.name}</span> : null}
            </div>
            <div className="mt-7 border-t border-border pt-6">
              <p className="text-xs font-black">실제 포트폴리오 잔액 구성</p>
              <p className="mt-1 text-[10px] text-muted-foreground">입출금·거래비용·잔여 현금을 포함한 명목 잔액입니다.</p>
              <div className="mt-3 h-[300px] min-w-0 sm:h-[360px]">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={result.points} margin={{ top: 10, right: 8, left: 0, bottom: 4 }}>
                    <CartesianGrid vertical={false} stroke="hsl(var(--chart-grid))" strokeDasharray="3 7" />
                    <XAxis dataKey="date" tickFormatter={shortDate} minTickGap={42} tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
                    <YAxis tickFormatter={(value) => formatMoney(Number(value), "KRW", true)} width={62} tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
                    <Tooltip labelFormatter={(value) => String(value)} formatter={(value, name) => [formatMoney(Number(value), "KRW"), name === "balance" ? "총 잔액" : name === "investedBalance" ? "투자 자산" : "현금"]} contentStyle={{ border: 0, borderRadius: 16, background: "hsl(var(--card))", color: "hsl(var(--foreground))" }} />
                    <Line type="monotone" dataKey="balance" name="balance" stroke="hsl(var(--foreground))" strokeWidth={2.5} dot={false} />
                    {result.points.some((point) => point.investedBalance !== undefined) ? <Line type="monotone" dataKey="investedBalance" name="investedBalance" stroke="hsl(var(--muted-foreground))" strokeWidth={1.8} dot={false} /> : null}
                    {result.points.some((point) => point.cashBalance !== undefined) ? <Line type="monotone" dataKey="cashBalance" name="cashBalance" stroke="hsl(var(--muted-foreground))" strokeWidth={1.5} strokeDasharray="3 4" dot={false} /> : null}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          </Card>

          <div className="grid grid-cols-2 gap-2 xl:grid-cols-4">
            <ResultMetric icon={TrendingUp} label="누적 TWR" value={metricValue(result.metrics.totalReturnPercent)} detail="정기 입출금 효과 제거" benchmark={result.benchmark && result.benchmarkMetrics ? { name: result.benchmark.name, value: metricValue(result.benchmarkMetrics.totalReturnPercent) } : undefined} />
            <ResultMetric icon={CalendarDays} label="CAGR" value={metricValue(result.metrics.cagrPercent)} detail="연평균 복리 수익률" benchmark={result.benchmark && result.benchmarkMetrics ? { name: result.benchmark.name, value: metricValue(result.benchmarkMetrics.cagrPercent) } : undefined} />
            <ResultMetric icon={Activity} label="연환산 변동성" value={metricValue(result.metrics.annualizedVolatilityPercent)} detail="일별 수익률 · 252거래일" benchmark={result.benchmark && result.benchmarkMetrics ? { name: result.benchmark.name, value: metricValue(result.benchmarkMetrics.annualizedVolatilityPercent) } : undefined} />
            <ResultMetric icon={TrendingDown} label="최대 낙폭" value={metricValue(result.metrics.maxDrawdownPercent)} detail={`최장 낙폭 ${result.metrics.maxDrawdownDays}일`} benchmark={result.benchmark && result.benchmarkMetrics ? { name: result.benchmark.name, value: metricValue(result.benchmarkMetrics.maxDrawdownPercent), detail: `최장 ${result.benchmarkMetrics.maxDrawdownDays}일` } : undefined} />
            <ResultMetric icon={Scale} label="샤프지수" value={metricValue(result.metrics.sharpeRatio, "ratio")} detail={`연 무위험수익률 ${(result.config.riskFreeRatePercent ?? 0).toFixed(2)}%`} benchmark={result.benchmark && result.benchmarkMetrics ? { name: result.benchmark.name, value: metricValue(result.benchmarkMetrics.sharpeRatio, "ratio") } : undefined} />
            <ResultMetric icon={Scale} label="소르티노지수" value={metricValue(result.metrics.sortinoRatio, "ratio")} detail="하방 변동성 기준" benchmark={result.benchmark && result.benchmarkMetrics ? { name: result.benchmark.name, value: metricValue(result.benchmarkMetrics.sortinoRatio, "ratio") } : undefined} />
            <ResultMetric icon={TrendingUp} label="최고 연도" value={metricValue(result.metrics.bestYearPercent)} detail="부분 연도 포함" benchmark={result.benchmark && result.benchmarkMetrics ? { name: result.benchmark.name, value: metricValue(result.benchmarkMetrics.bestYearPercent) } : undefined} />
            <ResultMetric icon={CircleDollarSign} label="상승 월 비율" value={metricValue(result.metrics.positiveMonthsPercent)} detail={`납입 ${formatMoney(result.metrics.totalContributions, "KRW")} · 인출 ${formatMoney(result.metrics.totalWithdrawals, "KRW")}`} benchmark={result.benchmark && result.benchmarkMetrics ? { name: result.benchmark.name, value: metricValue(result.benchmarkMetrics.positiveMonthsPercent) } : undefined} />
            <ResultMetric icon={Scale} label="Calmar 비율" value={metricValue(result.metrics.calmarRatio, "ratio")} detail="CAGR ÷ 최대 낙폭" benchmark={result.benchmark && result.benchmarkMetrics ? { name: result.benchmark.name, value: metricValue(result.benchmarkMetrics.calmarRatio, "ratio") } : undefined} />
            <ResultMetric icon={TrendingUp} label="최고 일간수익률" value={metricValue(result.metrics.bestDailyReturnPercent)} detail="현금흐름 제거 일간 경로" benchmark={result.benchmark && result.benchmarkMetrics ? { name: result.benchmark.name, value: metricValue(result.benchmarkMetrics.bestDailyReturnPercent) } : undefined} />
            <ResultMetric icon={TrendingDown} label="최저 일간수익률" value={metricValue(result.metrics.worstDailyReturnPercent)} detail="현금흐름 제거 일간 경로" benchmark={result.benchmark && result.benchmarkMetrics ? { name: result.benchmark.name, value: metricValue(result.benchmarkMetrics.worstDailyReturnPercent) } : undefined} />
            <ResultMetric icon={CalendarDays} label="상승일 비율" value={metricValue(result.metrics.positiveDaysPercent)} detail="일간수익률이 0%보다 높은 날" benchmark={result.benchmark && result.benchmarkMetrics ? { name: result.benchmark.name, value: metricValue(result.benchmarkMetrics.positiveDaysPercent) } : undefined} />
            <ResultMetric icon={CircleDollarSign} label="XIRR · 금액가중" value={metricValue(result.metrics.moneyWeightedReturnPercent ?? null)} detail="실제 사용자·정기 현금흐름 날짜 기준" />
            <ResultMetric icon={WalletCards} label="종료 현금" value={formatMoney(result.metrics.endingCashBalance ?? 0, "KRW")} detail={`현금 비중 ${metricValue(result.metrics.endingCashWeightPercent ?? null)}`} />
            <ResultMetric icon={WalletCards} label="종료 투자 자산" value={formatMoney(result.metrics.investedBalance ?? result.metrics.finalBalance, "KRW")} detail={`${result.execution?.quantityMode === "whole" ? "정수" : "소수"} 수량 체결`} />
            <ResultMetric icon={CircleDollarSign} label="실제 차감 거래비용" value={formatMoney(result.metrics.totalTransactionCosts ?? 0, "KRW")} detail={`${(result.config.transactionCostBps ?? 0).toFixed(2)}bp · 포트폴리오 경로 차감`} />
            <ResultMetric icon={TrendingUp} label="순손익" value={formatSignedMoney(result.metrics.netProfitLoss ?? result.metrics.finalBalance - result.config.initialAmount, "KRW")} detail="납입·인출·비용 반영" />
            <ResultMetric icon={Scale} label="체결 정책" value={result.execution?.cashFlowRebalanceMode === "full" ? "완전 재조정" : result.execution?.cashFlowRebalanceMode === "drift_reduction" ? "이탈 축소" : "목표 비중 매수"} detail={`목표 현금 ${formatPercent(result.execution?.cashTargetPercent ?? 0)}`} />
          </div>

          {(result.cashFlows?.length || result.trades?.length) ? (
            <div className="grid min-w-0 gap-3 xl:grid-cols-2">
              <Card className="min-w-0 bg-secondary p-5 sm:p-7">
                <p className="text-xs font-bold tracking-[0.14em] text-muted-foreground">CASH FLOW LEDGER</p>
                <h3 className="mt-2 text-xl font-black tracking-[-0.035em]">현금흐름 적용 기록</h3>
                <div className="mt-5 max-h-[360px] overflow-auto rounded-[20px] bg-card p-3">
                  <table className="w-full min-w-[560px] text-left text-xs"><thead><tr className="text-muted-foreground"><th className="p-3">예정일</th><th className="p-3">실제 거래일</th><th className="p-3">금액</th><th className="p-3">구분·메모</th></tr></thead><tbody>{(result.cashFlows ?? []).map((flow, index) => <tr key={`${flow.effectiveDate}:${index}`} className="border-t border-border"><td className="p-3">{flow.scheduledDate}</td><td className="p-3 font-black">{flow.effectiveDate}</td><td className="p-3">{formatSignedMoney(flow.amount, "KRW")}</td><td className="p-3">{flow.source}{flow.memo ? ` · ${flow.memo}` : ""}</td></tr>)}</tbody></table>
                  {!result.cashFlows?.length ? <p className="p-3 text-xs text-muted-foreground">적용된 현금흐름이 없습니다.</p> : null}
                </div>
              </Card>
              <Card className="min-w-0 bg-secondary p-5 sm:p-7">
                <p className="text-xs font-bold tracking-[0.14em] text-muted-foreground">EXECUTION LEDGER</p>
                <h3 className="mt-2 text-xl font-black tracking-[-0.035em]">실제 시뮬레이션 체결</h3>
                <div className="mt-5 max-h-[360px] overflow-auto rounded-[20px] bg-card p-3">
                  <table className="w-full min-w-[720px] text-left text-xs"><thead><tr className="text-muted-foreground"><th className="p-3">일자·종목</th><th className="p-3">구분</th><th className="p-3">수량 · lot</th><th className="p-3">체결금액</th><th className="p-3">비용</th><th className="p-3">현금 영향</th></tr></thead><tbody>{(result.trades ?? []).map((trade, index) => <tr key={`${trade.date}:${trade.symbol}:${index}`} className="border-t border-border"><td className="p-3"><div className="flex items-center gap-2"><StockSwatch symbol={trade.symbol} theme={theme} className="size-2" /><p className="font-black">{trade.symbol}</p></div><p className="mt-1 text-[9px] text-muted-foreground">{trade.date} · {trade.trigger ?? trade.reason}</p></td><td className="p-3 font-black">{trade.side}</td><td className="p-3">{trade.quantity.toLocaleString("ko-KR", { maximumFractionDigits: 6 })} · {trade.lotSize ?? 1}</td><td className="p-3">{formatMoney(trade.amount, "KRW")}</td><td className="p-3">{formatMoney(trade.transactionCost ?? 0, "KRW")}</td><td className="p-3">{formatSignedMoney(trade.netCashImpact ?? (trade.side === "BUY" ? -trade.amount : trade.amount), "KRW")}</td></tr>)}</tbody></table>
                </div>
              </Card>
            </div>
          ) : null}

          {advanced?.benchmarkComparison ? (
            <Card className="bg-secondary p-5 sm:p-7">
              <p className="text-xs font-bold tracking-[0.14em] text-muted-foreground">ACTIVE RISK & CAPTURE</p>
              <div className="mt-2 flex flex-wrap items-end justify-between gap-2">
                <h3 className="text-xl font-black tracking-[-0.035em]">벤치마크 대비 위험과 참여율</h3>
                <span className="text-[10px] font-bold text-muted-foreground">{advanced.benchmarkComparison.name} · {advanced.benchmarkComparison.observations.toLocaleString("ko-KR")}일</span>
              </div>
              <div className="mt-5 grid grid-cols-2 gap-2 lg:grid-cols-3 xl:grid-cols-6">
                <ResultMetric icon={TrendingUp} label="초과수익" value={metricValue(advanced.benchmarkComparison.excessReturnPercent)} detail={`벤치마크 ${metricValue(advanced.benchmarkComparison.returnPercent)}`} />
                <ResultMetric icon={Activity} label="추적오차" value={metricValue(advanced.benchmarkComparison.trackingErrorPercent)} detail={`정보비율 ${metricValue(advanced.benchmarkComparison.informationRatio, "ratio")}`} />
                <ResultMetric icon={Scale} label="베타 · 알파" value={metricValue(advanced.benchmarkComparison.beta, "ratio")} detail={`알파 ${metricValue(advanced.benchmarkComparison.alphaPercent)}`} />
                <ResultMetric icon={Activity} label="상관계수" value={metricValue(advanced.benchmarkComparison.correlation, "ratio")} detail={`상대 MDD ${metricValue(advanced.benchmarkComparison.relativeMaxDrawdownPercent)}`} />
                <ResultMetric icon={TrendingUp} label="상승 · 하락 참여" value={`${metricValue(advanced.benchmarkComparison.upsideCapturePercent)} · ${metricValue(advanced.benchmarkComparison.downsideCapturePercent)}`} detail="벤치마크 상승일 · 하락일" />
                <ResultMetric icon={CalendarDays} label="일간 · 월간 승률" value={`${metricValue(advanced.benchmarkComparison.dailyWinRatePercent)} · ${metricValue(advanced.benchmarkComparison.monthlyWinRatePercent)}`} detail="벤치마크 초과 비율" />
              </div>
            </Card>
          ) : null}

          {advanced ? (
            <div className="grid min-w-0 gap-3 xl:grid-cols-[1.2fr_0.9fr]">
              <Card className="min-w-0 bg-secondary p-5 sm:p-7">
                <p className="text-xs font-bold tracking-[0.14em] text-muted-foreground">ROLLING PERFORMANCE</p>
                <h3 className="mt-2 text-xl font-black tracking-[-0.035em]">롤링 수익률과 위험 변화</h3>
                {rollingData.length ? (
                  <div className="mt-5 grid gap-3 2xl:grid-cols-2">
                    <div className="h-[280px] min-w-0 rounded-[20px] bg-card p-3">
                      <ResponsiveContainer width="100%" height="100%">
                        <ComposedChart data={rollingData} margin={{ top: 8, right: 4, bottom: 0, left: 0 }}>
                          <CartesianGrid vertical={false} stroke="hsl(var(--chart-grid))" strokeDasharray="3 7" />
                          <XAxis dataKey="date" tickFormatter={shortDate} minTickGap={36} tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
                          <YAxis tickFormatter={(value) => `${Number(value).toFixed(0)}%`} width={42} tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
                          <Tooltip formatter={(value, name) => [formatPercent(Number(value), true), String(name)]} contentStyle={{ border: 0, borderRadius: 16, background: "hsl(var(--card))", color: "hsl(var(--foreground))" }} />
                          <Line type="monotone" dataKey="return20d" name="20일" stroke={MONOCHROME_SERIES[0]} strokeWidth={2.4} dot={false} connectNulls />
                          <Line type="monotone" dataKey="return60d" name="60일" stroke={MONOCHROME_SERIES[1]} strokeDasharray={MONOCHROME_DASHES[1]} strokeWidth={2} dot={false} connectNulls />
                          <Line type="monotone" dataKey="return120d" name="120일" stroke={MONOCHROME_SERIES[2]} strokeDasharray={MONOCHROME_DASHES[2]} strokeWidth={2} dot={false} connectNulls />
                          <Line type="monotone" dataKey="return252d" name="252일" stroke={MONOCHROME_SERIES[3]} strokeDasharray={MONOCHROME_DASHES[3]} strokeWidth={2} dot={false} connectNulls />
                        </ComposedChart>
                      </ResponsiveContainer>
                    </div>
                    <div className="h-[280px] min-w-0 rounded-[20px] bg-card p-3">
                      {hasRolling60 ? <ResponsiveContainer width="100%" height="100%">
                        <ComposedChart data={rollingData} margin={{ top: 8, right: 4, bottom: 0, left: 0 }}>
                          <CartesianGrid vertical={false} stroke="hsl(var(--chart-grid))" strokeDasharray="3 7" />
                          <XAxis dataKey="date" tickFormatter={shortDate} minTickGap={36} tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
                          <YAxis yAxisId="percent" tickFormatter={(value) => `${Number(value).toFixed(0)}%`} width={42} tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
                          <YAxis yAxisId="ratio" orientation="right" width={34} tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
                          <Tooltip formatter={(value, name) => [Number(value).toFixed(2), String(name)]} contentStyle={{ border: 0, borderRadius: 16, background: "hsl(var(--card))", color: "hsl(var(--foreground))" }} />
                          <Line yAxisId="percent" type="monotone" dataKey="volatility60d" name="변동성 %" stroke={MONOCHROME_SERIES[0]} strokeWidth={2.4} dot={false} connectNulls />
                          <Line yAxisId="ratio" type="monotone" dataKey="sharpe60d" name="샤프" stroke={MONOCHROME_SERIES[1]} strokeDasharray={MONOCHROME_DASHES[1]} strokeWidth={2} dot={false} connectNulls />
                          {advanced.benchmarkComparison ? <Line yAxisId="ratio" type="monotone" dataKey="benchmarkBeta60d" name="베타" stroke={MONOCHROME_SERIES[2]} strokeDasharray={MONOCHROME_DASHES[2]} strokeWidth={2} dot={false} connectNulls /> : null}
                          {advanced.benchmarkComparison ? <Line yAxisId="ratio" type="monotone" dataKey="benchmarkCorrelation60d" name="상관" stroke={MONOCHROME_SERIES[3]} strokeDasharray={MONOCHROME_DASHES[3]} strokeWidth={2} dot={false} connectNulls /> : null}
                        </ComposedChart>
                      </ResponsiveContainer> : <div className="grid h-full place-items-center px-4 text-center text-xs leading-5 text-muted-foreground">60개 이상의 수익률 관측이 쌓이면 롤링 위험을 표시합니다.</div>}
                    </div>
                  </div>
                ) : <p className="mt-5 rounded-[20px] bg-card p-5 text-sm text-muted-foreground">20개 이상의 수익률 관측이 필요합니다.</p>}
              </Card>

              <Card className="min-w-0 bg-secondary p-5 sm:p-7">
                <p className="text-xs font-bold tracking-[0.14em] text-muted-foreground">DRAWDOWN DETAIL</p>
                <h3 className="mt-2 text-xl font-black tracking-[-0.035em]">낙폭 깊이와 회복</h3>
                <div className="mt-5 grid grid-cols-2 gap-2">
                  <ResultMetric icon={TrendingDown} label="현재 낙폭" value={metricValue(advanced.drawdowns.points.at(-1)?.drawdownPercent ?? null)} detail="최근 고점 대비" />
                  <ResultMetric icon={CalendarDays} label="현재 수중 기간" value={`${advanced.drawdowns.currentUnderwaterDays.toLocaleString("ko-KR")}일`} detail="최근 고점 미회복" />
                  <ResultMetric icon={TrendingDown} label="평균 낙폭 · Ulcer" value={`${metricValue(advanced.drawdowns.averageDrawdownPercent)} · ${metricValue(advanced.drawdowns.ulcerIndex, "ratio")}`} detail="깊이와 지속 위험" />
                  <ResultMetric icon={TrendingDown} label="최악 20일" value={metricValue(advanced.drawdowns.worst20DayReturnPercent)} detail="20 관측일 롤링 최저" />
                  <ResultMetric icon={TrendingDown} label="최악 60일" value={metricValue(advanced.drawdowns.worst60DayReturnPercent)} detail="60 관측일 롤링 최저" />
                </div>
                <div className="mt-3 space-y-2">
                  {advanced.drawdowns.episodes.map((episode, index) => (
                    <div key={`${episode.startDate}:${episode.troughDate}`} className="rounded-[18px] bg-card p-4">
                      <div className="flex items-center justify-between gap-3"><span className="text-xs font-black">#{index + 1} · {formatPercent(episode.depthPercent, true)}</span><span className="text-[10px] text-muted-foreground">{episode.durationDays}일</span></div>
                      <p className="mt-2 text-[10px] leading-4 text-muted-foreground">{episode.startDate} → {episode.troughDate}{episode.recoveryDate ? ` → ${episode.recoveryDate} 회복` : " · 미회복"}</p>
                    </div>
                  ))}
                </div>
              </Card>
            </div>
          ) : null}

          <Card className="bg-secondary p-5 sm:p-7">
            <p className="text-xs font-bold tracking-[0.14em] text-muted-foreground">DRAWDOWN</p>
            <h3 className="mt-2 text-xl font-black tracking-[-0.035em]">고점 대비 낙폭</h3>
            <div className="mt-5 h-[250px] min-w-0">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={result.points} margin={{ top: 8, right: 8, left: 0, bottom: 4 }}>
                  <CartesianGrid vertical={false} stroke="hsl(var(--chart-grid))" strokeDasharray="3 7" />
                  <XAxis dataKey="date" tickFormatter={shortDate} minTickGap={42} tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
                  <YAxis tickFormatter={(value) => `${Number(value).toFixed(0)}%`} width={44} tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
                  <Tooltip formatter={(value) => [formatPercent(Number(value), true), "낙폭"]} contentStyle={{ border: 0, borderRadius: 16, background: "hsl(var(--card))", color: "hsl(var(--foreground))" }} />
                  <Area type="monotone" dataKey="drawdownPercent" stroke="none" fill={MONOCHROME_SERIES[1]} fillOpacity={0.58} activeDot={{ r: 3, strokeWidth: 0 }} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </Card>

          <div className="grid gap-3 xl:grid-cols-[1.05fr_1.4fr]">
            <Card className="bg-secondary p-5 sm:p-7">
              <p className="text-xs font-bold tracking-[0.14em] text-muted-foreground">ANNUAL RETURNS</p>
              <h3 className="mt-2 text-xl font-black tracking-[-0.035em]">연도별 수익률</h3>
              <div className="mt-5 max-h-[420px] space-y-2 overflow-y-auto pr-1">
                {[...result.annualReturns].reverse().map((item) => (
                  <div key={item.year} className="flex items-center justify-between rounded-[16px] bg-card px-4 py-3 text-sm">
                    <span className="font-black">{item.year}</span>
                    <span className={cn("font-black", item.returnPercent < 0 && "text-muted-foreground")}>{formatPercent(item.returnPercent, true)}</span>
                  </div>
                ))}
              </div>
            </Card>

            <Card className="bg-secondary p-5 sm:p-7">
              <p className="text-xs font-bold tracking-[0.14em] text-muted-foreground">ATTRIBUTION</p>
              <h3 className="mt-2 text-xl font-black tracking-[-0.035em]">종목별 성과 기여</h3>
              <div className="mt-5 space-y-3">
                {result.contributions.map((item) => (
                  <div key={`${item.currency}:${item.symbol}`} className="grid gap-2 rounded-[18px] bg-card p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                    <div className="min-w-0">
                      <div className="flex min-w-0 items-center gap-2"><StockSwatch symbol={item.symbol} theme={theme} /><p className="truncate text-sm font-black">{item.name}</p></div>
                      <p className="mt-1 text-[10px] font-bold text-muted-foreground">{item.market} · {item.symbol} · 목표 {item.weight.toFixed(2)}% · 종목 {formatPercent(item.assetReturnPercent, true)}</p>
                      <p className="mt-1 text-[10px] font-bold text-muted-foreground">시간연결 {formatPercent(item.timeLinkedContributionPercent ?? item.contributionPercent, true)} · 현지가격 {formatPercent(item.localPriceContributionPercent ?? item.timeLinkedContributionPercent ?? item.contributionPercent, true)} · 환율 {formatPercent(item.fxContributionPercent ?? 0, true)}</p>
                    </div>
                    <div className="sm:text-right">
                      <p className="text-sm font-black">{formatSignedMoney(item.profitLoss, "KRW")}</p>
                      <p className="mt-1 text-[10px] font-bold text-muted-foreground">기여 {formatPercent(item.contributionPercent, true)}</p>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          </div>

          {advanced ? (
            <>
              <div className="grid min-w-0 gap-3 xl:grid-cols-[0.95fr_1.35fr]">
                <Card className="min-w-0 bg-secondary p-5 sm:p-7">
                  <p className="text-xs font-bold tracking-[0.14em] text-muted-foreground">TAIL RISK</p>
                  <h3 className="mt-2 text-xl font-black tracking-[-0.035em]">손실 분포와 극단 위험</h3>
                  <div className="mt-5 grid grid-cols-2 gap-2">
                    <ResultMetric icon={TrendingDown} label="역사적 VaR 95%" value={metricValue(advanced.tailRisk.historicalVar95Percent)} detail="하위 5% 일간수익률 경계" />
                    <ResultMetric icon={TrendingDown} label="CVaR 95%" value={metricValue(advanced.tailRisk.expectedShortfall95Percent)} detail="VaR 이하 손실일 평균" />
                    <ResultMetric icon={CalendarDays} label="손실일 비율" value={metricValue(advanced.tailRisk.lossDaysPercent)} detail={`최장 연속 하락 ${advanced.tailRisk.maxConsecutiveLossDays}일`} />
                    <ResultMetric icon={Scale} label="평균 상승 · 하락" value={`${metricValue(advanced.tailRisk.averageGainPercent)} · ${metricValue(advanced.tailRisk.averageLossPercent)}`} detail={`손익비 ${metricValue(advanced.tailRisk.gainLossRatio, "ratio")}`} />
                    <ResultMetric icon={Activity} label="왜도" value={metricValue(advanced.tailRisk.skewness, "ratio")} detail="음수일수록 왼쪽 꼬리 위험" />
                    <ResultMetric icon={Activity} label="초과 첨도" value={metricValue(advanced.tailRisk.excessKurtosis, "ratio")} detail={`최장 연속 상승 ${advanced.tailRisk.maxConsecutiveGainDays}일`} />
                  </div>
                </Card>

                <Card className="min-w-0 bg-secondary p-5 sm:p-7">
                  <p className="text-xs font-bold tracking-[0.14em] text-muted-foreground">MONTHLY RETURN MAP</p>
                  <h3 className="mt-2 text-xl font-black tracking-[-0.035em]">월간 수익률 히트맵</h3>
                  <div className="mt-5 w-full min-w-0 overflow-x-auto rounded-[20px] bg-card p-3">
                    <table className="w-full min-w-[720px] border-separate border-spacing-1 text-center text-[10px]">
                      <thead><tr><th className="p-2 text-left text-muted-foreground">연도</th>{Array.from({ length: 12 }, (_, index) => <th key={index} className="p-2 text-muted-foreground">{index + 1}월</th>)}</tr></thead>
                      <tbody>{monthlyYears.map((row) => (
                        <tr key={row.year}>
                          <th className="p-2 text-left text-xs font-black">{row.year}</th>
                          {Array.from({ length: 12 }, (_, index) => {
                            const value = row.months[index + 1];
                            return <td key={index} className="rounded-xl p-2.5 font-black" style={value === undefined ? undefined : monochromeHeatmapStyle(value)}>{value === undefined ? "-" : `${value > 0 ? "+" : ""}${value.toFixed(1)}`}</td>;
                          })}
                        </tr>
                      ))}</tbody>
                    </table>
                  </div>
                </Card>
              </div>

              <div className="grid min-w-0 gap-3 xl:grid-cols-[1fr_0.95fr]">
                <Card className="min-w-0 bg-secondary p-5 sm:p-7">
                  <p className="text-xs font-bold tracking-[0.14em] text-muted-foreground">RISK CONTRIBUTION</p>
                  <h3 className="mt-2 text-xl font-black tracking-[-0.035em]">종목별 위험 기여도</h3>
                  <p className="mt-2 text-sm leading-6 text-muted-foreground">시뮬레이션 평균 비중과 종목 공분산으로 전체 변동성 기여를 계산합니다.</p>
                  <div className="mt-5 space-y-3">
                    {advanced.riskContributions.map((item) => {
                      const maximum = Math.max(...advanced.riskContributions.map((candidate) => Math.abs(candidate.riskContributionPercent ?? 0)), 1);
                      return (
                        <div key={item.key} className="rounded-[18px] bg-card p-4">
                          <div className="flex items-center justify-between gap-3">
                            <div className="min-w-0"><div className="flex min-w-0 items-center gap-2"><StockSwatch symbol={item.symbol} theme={theme} /><p className="truncate text-xs font-black">{item.name}</p></div><p className="mt-1 text-[10px] text-muted-foreground">평균 {formatPercent(item.averageWeightPercent)} · 종료 {formatPercent(item.endingWeightPercent)} · 변동성 {metricValue(item.annualizedVolatilityPercent)}</p></div>
                            <p className="text-sm font-black">{metricValue(item.riskContributionPercent)}</p>
                          </div>
                          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-secondary"><div className="h-full rounded-full" style={{ width: `${Math.max(2, Math.abs(item.riskContributionPercent ?? 0) / maximum * 100)}%`, backgroundColor: stockColor(item.symbol, theme) }} /></div>
                          <p className="mt-2 text-[10px] text-muted-foreground">포트폴리오 상관 {metricValue(item.correlationToPortfolio, "ratio")}</p>
                        </div>
                      );
                    })}
                  </div>
                </Card>

                <Card className="min-w-0 bg-secondary p-5 sm:p-7">
                  <p className="text-xs font-bold tracking-[0.14em] text-muted-foreground">DIVERSIFICATION</p>
                  <h3 className="mt-2 text-xl font-black tracking-[-0.035em]">집중도와 통화 노출</h3>
                  <div className="mt-5 grid grid-cols-2 gap-2">
                    <ResultMetric icon={Scale} label="상위 1 · 5종목" value={`${formatPercent(advanced.exposure.top1WeightPercent)} · ${formatPercent(advanced.exposure.top5WeightPercent)}`} detail="종료 평가액 기준" />
                    <ResultMetric icon={Scale} label="상위 10종목" value={formatPercent(advanced.exposure.top10WeightPercent)} detail="종료 평가액 기준" />
                    <ResultMetric icon={WalletCards} label="유효 종목 수" value={advanced.exposure.effectivePositions === null ? "데이터 부족" : `${advanced.exposure.effectivePositions.toFixed(2)}개`} detail={`HHI ${advanced.exposure.hhi.toFixed(4)}`} />
                    <ResultMetric icon={Activity} label="분산 효과" value={metricValue(advanced.exposure.diversificationBenefitPercent)} detail="개별 변동성 가중합 대비 감소" />
                    <ResultMetric icon={WalletCards} label="KRW · USD 노출" value={`${formatPercent(advanced.exposure.krwWeightPercent)} · ${formatPercent(advanced.exposure.usdWeightPercent)}`} detail="종료 비중 · 현지수익률 방식" />
                    <ResultMetric icon={Scale} label="국내 · 해외" value={`${formatPercent(advanced.exposure.domesticWeightPercent)} · ${formatPercent(advanced.exposure.overseasWeightPercent)}`} detail="동시 포트폴리오 구성" />
                  </div>
                </Card>
              </div>

              <div className="grid min-w-0 gap-3 xl:grid-cols-[1.2fr_0.9fr]">
                <Card className="min-w-0 bg-secondary p-5 sm:p-7">
                  <p className="text-xs font-bold tracking-[0.14em] text-muted-foreground">TURNOVER & COST</p>
                  <h3 className="mt-2 text-xl font-black tracking-[-0.035em]">월별 회전율과 추정 거래비용</h3>
                  <div className="mt-5 grid grid-cols-2 gap-2 lg:grid-cols-4">
                    <ResultMetric icon={RefreshCw} label="운용 회전율" value={metricValue(advanced.costEfficiency.turnoverPercent)} detail="초기 매수를 제외한 거래금액" />
                    <ResultMetric icon={CircleDollarSign} label="추정 총비용" value={formatMoney(advanced.costEfficiency.estimatedTotalCost, "KRW")} detail={`${advanced.costEfficiency.transactionCostBps.toFixed(2)}bp 가정`} />
                    <ResultMetric icon={TrendingDown} label="비용 드래그" value={metricValue(advanced.costEfficiency.costDragPercent)} detail={`총 거래 ${formatMoney(advanced.costEfficiency.totalTradedAmount, "KRW", true)}`} />
                    <ResultMetric icon={TrendingUp} label="비용 차감 후 추정" value={metricValue(advanced.costEfficiency.netEstimatedReturnPercent)} detail={`차감 전 ${metricValue(advanced.costEfficiency.grossReturnPercent)}`} />
                  </div>
                  <div className="mt-4 h-[280px] min-w-0 rounded-[20px] bg-card p-3">
                    <ResponsiveContainer width="100%" height="100%">
                      <ComposedChart data={advanced.costEfficiency.monthly} margin={{ top: 8, right: 4, bottom: 0, left: 0 }}>
                        <CartesianGrid vertical={false} stroke="hsl(var(--chart-grid))" strokeDasharray="3 7" />
                        <XAxis dataKey="month" tickFormatter={(value) => String(value).slice(2).replace("-", ".")} minTickGap={26} tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
                        <YAxis yAxisId="turnover" tickFormatter={(value) => `${Number(value).toFixed(0)}%`} width={42} tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
                        <YAxis yAxisId="cost" orientation="right" tickFormatter={(value) => formatMoney(Number(value), "KRW", true)} width={54} tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
                        <Tooltip formatter={(value, name) => [name === "회전율" ? formatPercent(Number(value)) : formatMoney(Number(value), "KRW"), String(name)]} contentStyle={{ border: 0, borderRadius: 16, background: "hsl(var(--card))", color: "hsl(var(--foreground))" }} />
                        <Bar yAxisId="turnover" dataKey="turnoverPercent" name="회전율" fill={MONOCHROME_SERIES[1]} radius={[6, 6, 0, 0]} />
                        <Line yAxisId="cost" type="monotone" dataKey="estimatedCost" name="추정비용" stroke={MONOCHROME_SERIES[0]} strokeWidth={2} dot={false} />
                      </ComposedChart>
                    </ResponsiveContainer>
                  </div>
                </Card>

                <Card className="min-w-0 bg-secondary p-5 sm:p-7">
                  <p className="text-xs font-bold tracking-[0.14em] text-muted-foreground">SIMULATED TRADE OUTCOME</p>
                  <h3 className="mt-2 text-xl font-black tracking-[-0.035em]">FIFO 거래 추정치</h3>
                  <div className="mt-5 grid grid-cols-2 gap-2">
                    <ResultMetric icon={CircleDollarSign} label="추정 실현손익" value={formatSignedMoney(advanced.tradeBehavior.estimatedRealizedProfitLoss, "KRW")} detail={`매칭 매도 ${advanced.tradeBehavior.matchedSellCount}건`} />
                    <ResultMetric icon={TrendingUp} label="추정 승률" value={metricValue(advanced.tradeBehavior.estimatedWinRatePercent)} detail={`미매칭 ${advanced.tradeBehavior.unmatchedSellCount}건`} />
                    <ResultMetric icon={Scale} label="Profit Factor" value={metricValue(advanced.tradeBehavior.estimatedProfitFactor, "ratio")} detail="총이익 ÷ 총손실" />
                    <ResultMetric icon={CalendarDays} label="평균 보유기간" value={advanced.tradeBehavior.estimatedAverageHoldingDays === null ? "데이터 부족" : `${advanced.tradeBehavior.estimatedAverageHoldingDays.toFixed(1)}일`} detail="FIFO 수량 가중" />
                    <ResultMetric icon={RefreshCw} label="매수 · 매도" value={`${advanced.tradeBehavior.buyCount} · ${advanced.tradeBehavior.sellCount}건`} detail={`총 ${advanced.costEfficiency.tradeCount}건`} />
                    <ResultMetric icon={CircleDollarSign} label="거래당 평균" value={advanced.costEfficiency.averageTradeAmount === null ? "데이터 부족" : formatMoney(advanced.costEfficiency.averageTradeAmount, "KRW")} detail={`매수/매도 금액비 ${metricValue(advanced.costEfficiency.buySellAmountRatio, "ratio")}`} />
                  </div>
                  <p className="mt-4 text-[10px] leading-4 text-muted-foreground">시뮬레이션이 만든 초기매수·정기 현금흐름·리밸런싱 거래를 FIFO로 매칭한 추정치입니다.</p>
                </Card>
              </div>

              <Card className="bg-secondary p-5 sm:p-7">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div><p className="text-xs font-bold tracking-[0.14em] text-muted-foreground">DATA CONFIDENCE</p><h3 className="mt-2 text-xl font-black tracking-[-0.035em]">백테스트 데이터 신뢰도</h3></div>
                  <span className="w-fit rounded-full bg-card px-4 py-2 text-xs font-black">{advanced.dataQuality.confidence === "high" ? "높음" : advanced.dataQuality.confidence === "medium" ? "보통" : "제한적"}</span>
                </div>
                <div className="mt-5 grid grid-cols-2 gap-2 lg:grid-cols-4">
                  <ResultMetric icon={CalendarDays} label="수익률 관측" value={`${advanced.dataQuality.returnObservationDays.toLocaleString("ko-KR")}일`} detail={`정렬 일자 ${advanced.dataQuality.observationDays.toLocaleString("ko-KR")}일`} />
                  <ResultMetric icon={Activity} label="공통 커버리지" value={formatPercent(advanced.dataQuality.commonCoveragePercent)} detail={`이월 관측 ${advanced.dataQuality.carriedForwardObservations.toLocaleString("ko-KR")}건`} />
                  <ResultMetric icon={CalendarDays} label="유효 기간" value={`${advanced.dataQuality.effectiveStartDate.slice(2)}~${advanced.dataQuality.effectiveEndDate.slice(2)}`} detail={`요청 달력 ${advanced.dataQuality.requestedCalendarDays.toLocaleString("ko-KR")}일`} />
                  <ResultMetric icon={BarChart3} label="벤치마크 관측" value={`${advanced.dataQuality.benchmarkObservations.toLocaleString("ko-KR")}일`} detail={result.benchmark?.name ?? "비교 지수 없음"} />
                </div>
                <div className="mt-4 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                  {advanced.dataQuality.assets.map((asset) => <div key={asset.key} className="rounded-[18px] bg-card p-4"><div className="flex min-w-0 items-center gap-2"><StockSwatch symbol={asset.symbol} theme={theme} /><p className="truncate text-xs font-black">{asset.name}</p></div><p className="mt-1 text-[10px] text-muted-foreground">{asset.observations}/{asset.alignedDays}일 · {formatPercent(asset.coveragePercent)} · {asset.firstDate}~{asset.lastDate}</p></div>)}
                </div>
                <div className="mt-4 rounded-[18px] bg-card px-4 py-3 text-xs leading-5 text-muted-foreground">{advanced.dataQuality.notes.map((note) => <p key={note}>{note}</p>)}</div>
              </Card>
            </>
          ) : null}

          <Card className="bg-secondary p-5 sm:p-7">
            <p className="text-xs font-bold tracking-[0.14em] text-muted-foreground">CORRELATION</p>
            <h3 className="mt-2 text-xl font-black tracking-[-0.035em]">일간 수익률 상관관계</h3>
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
                        <span className="inline-flex items-center justify-center gap-2 whitespace-normal break-keep leading-4">
                          <StockSwatch symbol={asset.symbol} theme={theme} className="size-2" />
                          {correlationAssetLabel(asset)}
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.correlations.assets.map((asset, rowIndex) => (
                    <tr key={asset.symbol}>
                      <th scope="row" title={asset.symbol} className="max-w-[170px] p-2 text-left font-black">
                        <span className="flex min-w-0 items-center gap-2"><StockSwatch symbol={asset.symbol} theme={theme} className="size-2" /><span className="truncate">{correlationAssetLabel(asset)}</span></span>
                      </th>
                      {result.correlations.values[rowIndex].map((value, columnIndex) => (
                        <td
                          key={`${asset.symbol}:${columnIndex}`}
                          className="rounded-xl p-3 font-black"
                          style={correlationCellStyle(value)}
                        >{value === null ? "-" : value.toFixed(2)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <div className="flex items-start gap-2 rounded-[18px] bg-secondary px-4 py-3 text-xs leading-5 text-muted-foreground">
            <Info className="mt-0.5 size-4 shrink-0" />
            <div className="space-y-1">
              {result.warnings.map((warning) => <p key={warning}>{warning}</p>)}
              <p>과거 성과는 미래 수익을 보장하지 않으며, 이 화면은 주문을 생성하지 않는 조회·시뮬레이션 전용 기능입니다.</p>
            </div>
          </div>
        </>
      ) : null}
    </section>
  );
}
