import { useEffect, useMemo, useState } from "react";
import { AlertCircle, CalendarDays, Check, Database, EyeOff, LoaderCircle, RefreshCw } from "lucide-react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  isValidCalendarRange,
  presetCalendarRange,
  seoulDateString,
  type CalendarDateRange,
} from "@/lib/date-range";
import { formatMoney } from "@/lib/format";
import { buildValueChartData, filterPortfolioHistory } from "@/lib/history-chart";
import { stockColor } from "@/lib/stock-appearance";
import { cn } from "@/lib/utils";
import type {
  ApiError,
  BackfillStatus,
  HistoryCurrency,
  HistoryRange,
  Portfolio,
  PortfolioHistory,
  PortfolioHistorySeries,
  Theme,
} from "@/types";

const ranges: Array<{ value: HistoryRange; label: string }> = [
  { value: "7d", label: "7일" },
  { value: "30d", label: "30일" },
  { value: "90d", label: "90일" },
  { value: "all", label: "전체" },
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

export function AllocationHistoryChart({
  portfolio,
  theme,
  hiddenStockKeys,
  onUnauthorized,
  onSeriesChange,
}: {
  portfolio: Portfolio;
  theme: Theme;
  hiddenStockKeys: ReadonlySet<string>;
  onUnauthorized: () => void;
  onSeriesChange: (series: PortfolioHistorySeries[]) => void;
}) {
  const availableCurrencies: HistoryCurrency[] = ["KRW", "USD"];
  const [currency, setCurrency] = useState<HistoryCurrency>(
    portfolio.holdings.some((holding) => holding.currency === "KRW" && holding.evaluationAmount > 0)
      ? "KRW"
      : portfolio.holdings.some((holding) => holding.currency === "USD" && holding.evaluationAmount > 0)
        ? "USD"
        : "KRW",
  );
  const today = useMemo(() => seoulDateString(), []);
  const [period, setPeriod] = useState<HistoryRange | "custom">("30d");
  const [draftDateRange, setDraftDateRange] = useState<CalendarDateRange>(
    () => presetCalendarRange("30d", today),
  );
  const [customDateRange, setCustomDateRange] = useState<CalendarDateRange>();
  const [history, setHistory] = useState<PortfolioHistory>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retryKey, setRetryKey] = useState(0);
  const [backfill, setBackfill] = useState<BackfillStatus>();
  const [statusRefreshKey, setStatusRefreshKey] = useState(0);

  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    let previousStatus: BackfillStatus["status"] | undefined;

    const loadStatus = async () => {
      const params = new URLSearchParams({ account: portfolio.selectedAccountId });
      try {
        const response = await fetch(`/api/portfolio/history/status?${params.toString()}`, {
          headers: { Accept: "application/json" },
        });
        const payload = await response.json().catch(() => ({})) as BackfillStatus & ApiError;
        if (!active) return;
        if (response.status === 401) {
          onUnauthorized();
          return;
        }
        if (!response.ok) throw new Error(payload.error?.message || "과거 기록 상태를 불러오지 못했습니다.");
        setBackfill(payload);
        if (
          (previousStatus === "running" || previousStatus === "idle")
          && (payload.status === "complete" || payload.status === "partial")
        ) {
          setRetryKey((value) => value + 1);
        }
        previousStatus = payload.status;
        const delay = payload.status === "running" || payload.status === "idle" ? 1_500 : 30_000;
        timer = window.setTimeout(loadStatus, delay);
      } catch {
        if (active) timer = window.setTimeout(loadStatus, 10_000);
      }
    };

    void loadStatus();
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [onUnauthorized, portfolio.selectedAccountId, statusRefreshKey]);

  useEffect(() => {
    if (period === "custom") return;
    setDraftDateRange(presetCalendarRange(period, today, backfill?.firstTradeDate));
  }, [backfill?.firstTradeDate, period, today]);

  const retryBackfill = async () => {
    try {
      const response = await fetch("/api/portfolio/history/backfill", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ account: portfolio.selectedAccountId }),
      });
      const payload = await response.json().catch(() => ({})) as { status?: BackfillStatus } & ApiError;
      if (response.status === 401) {
        onUnauthorized();
        return;
      }
      if (!response.ok) throw new Error(payload.error?.message || "과거 기록 동기화를 시작하지 못했습니다.");
      if (payload.status) setBackfill(payload.status);
      setStatusRefreshKey((value) => value + 1);
    } catch (caught) {
      setBackfill((current) => current ? {
        ...current,
        status: "error",
        message: caught instanceof Error ? caught.message : "과거 기록 동기화를 시작하지 못했습니다.",
      } : current);
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    const queryRange: HistoryRange = period === "custom" ? "all" : period;
    const params = new URLSearchParams({
      account: portfolio.selectedAccountId,
      currency,
      range: queryRange,
    });
    if (period === "custom" && customDateRange) {
      params.set("from", customDateRange.from);
      params.set("to", customDateRange.to);
    }
    setLoading(true);
    setError("");

    fetch(`/api/portfolio/history?${params.toString()}`, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({})) as PortfolioHistory & ApiError;
        if (response.status === 401) {
          onUnauthorized();
          return;
        }
        if (!response.ok) throw new Error(payload.error?.message || "일별 비중 기록을 불러오지 못했습니다.");
        onSeriesChange(payload.series);
        setHistory(payload);
      })
      .catch((caught: unknown) => {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setError(caught instanceof Error ? caught.message : "일별 비중 기록을 불러오지 못했습니다.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [
    currency,
    customDateRange?.from,
    customDateRange?.to,
    onSeriesChange,
    onUnauthorized,
    period,
    portfolio.selectedAccountId,
    retryKey,
  ]);

  const selectPreset = (value: HistoryRange) => {
    setPeriod(value);
    setCustomDateRange(undefined);
    setDraftDateRange(presetCalendarRange(value, today, backfill?.firstTradeDate));
  };

  const canApplyDateRange = isValidCalendarRange(draftDateRange, today);
  const applyDateRange = () => {
    if (!canApplyDateRange) return;
    setCustomDateRange({ ...draftDateRange });
    setPeriod("custom");
  };

  const visibleHistory = useMemo(
    () => history ? filterPortfolioHistory(history, hiddenStockKeys) : undefined,
    [hiddenStockKeys, history],
  );
  const chartData = useMemo(
    () => visibleHistory ? buildValueChartData(visibleHistory) : [],
    [visibleHistory],
  );

  const points = visibleHistory?.points ?? [];
  const series = visibleHistory?.series ?? [];

  return (
    <section id="history" className="scroll-mt-5" aria-labelledby="history-title">
      <Card className="bg-secondary p-5 sm:p-7">
        <div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
          <div>
            <div className="mb-2 flex items-center gap-2 text-xs font-bold tracking-[0.14em] text-muted-foreground">
              <CalendarDays className="size-4" aria-hidden="true" />
              DAILY WEIGHT
            </div>
            <h2 id="history-title" className="text-2xl font-black tracking-[-0.04em]">종목별 포트폴리오 비중</h2>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              KST 일 단위 · 영역 두께는 종목 비중, 전체 높이는 {currency} 평가금 · USD는 과거 해외주식 포함
            </p>
            {backfill ? (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <div
                  className="inline-flex min-h-8 items-center gap-2 rounded-full bg-card px-3 text-[11px] font-bold text-muted-foreground"
                  title={backfill.message}
                  aria-live="polite"
                >
                  {backfill.status === "running" || backfill.status === "idle" ? (
                    <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
                  ) : backfill.status === "complete" ? (
                    <Check className="size-3.5" aria-hidden="true" />
                  ) : (
                    <Database className="size-3.5" aria-hidden="true" />
                  )}
                  {backfill.status === "running"
                    ? backfill.phase === "orders"
                      ? `체결 내역 수집 중 · ${backfill.ordersImported.toLocaleString("ko-KR")}건`
                      : backfill.phase === "instruments"
                        ? "종목 정보 확인 중"
                        : backfill.phase === "prices"
                          ? `일봉 수집 중 · ${backfill.symbolsProcessed}/${backfill.symbolsTotal}`
                          : "일별 포트폴리오 계산 중"
                    : backfill.status === "idle"
                      ? "과거 기록 준비 중"
                      : backfill.status === "complete"
                        ? `${backfill.firstTradeDate ? displayDate(backfill.firstTradeDate, true) : "첫 거래"}부터 복원됨`
                        : backfill.status === "partial"
                          ? `${backfill.firstTradeDate ? displayDate(backfill.firstTradeDate, true) : "과거 기록"}부터 복원 · 일부 추정`
                          : "과거 기록 동기화 실패"}
                </div>
                {backfill.status === "error" ? (
                  <Button variant="ghost" size="sm" onClick={() => void retryBackfill()}>
                    <RefreshCw /> 다시 동기화
                  </Button>
                ) : null}
              </div>
            ) : null}
            {backfill?.status === "partial" && backfill.message ? (
              <p className="mt-2 max-w-xl text-xs leading-5 text-muted-foreground">{backfill.message}</p>
            ) : null}
          </div>

          <div className="w-full xl:w-[540px]">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-end">
              <div className="flex rounded-full bg-card p-1" aria-label="통화 선택">
                {availableCurrencies.map((item) => (
                  <button
                    key={item}
                    type="button"
                    onClick={() => setCurrency(item)}
                    aria-pressed={currency === item}
                    className={cn(
                      "rounded-full px-3 py-2 text-[11px] font-black transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      currency === item ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                      {item === "KRW" ? "KRW · 국내" : "USD · 해외/과거"}
                  </button>
                ))}
              </div>
              <div className="grid flex-1 grid-cols-4 rounded-full bg-card p-1" aria-label="빠른 조회 기간">
                {ranges.map((item) => (
                  <button
                    key={item.value}
                    type="button"
                    onClick={() => selectPreset(item.value)}
                    aria-pressed={period === item.value}
                    className={cn(
                      "rounded-full px-3 py-2 text-[11px] font-black transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      period === item.value ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="mt-2 grid grid-cols-2 gap-2 rounded-[20px] bg-card p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]" aria-label="직접 조회 기간">
              <label className="min-w-0">
                <span className="mb-1.5 block px-1 text-[10px] font-bold text-muted-foreground">시작일</span>
                <Input
                  type="date"
                  value={draftDateRange.from}
                  min={backfill?.firstTradeDate}
                  max={draftDateRange.to || today}
                  onChange={(event) => setDraftDateRange((current) => ({ ...current, from: event.target.value }))}
                  className="h-10 rounded-xl bg-secondary px-3 text-xs font-bold"
                  aria-label="차트 시작일"
                />
              </label>
              <label className="min-w-0">
                <span className="mb-1.5 block px-1 text-[10px] font-bold text-muted-foreground">종료일</span>
                <Input
                  type="date"
                  value={draftDateRange.to}
                  min={draftDateRange.from || backfill?.firstTradeDate}
                  max={today}
                  onChange={(event) => setDraftDateRange((current) => ({ ...current, to: event.target.value }))}
                  className="h-10 rounded-xl bg-secondary px-3 text-xs font-bold"
                  aria-label="차트 종료일"
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
                <CalendarDays /> 기간 적용
              </Button>
            </div>
          </div>
        </div>

        {loading ? (
          <div className="grid h-[360px] place-items-center" aria-live="polite">
            <div className="text-center text-muted-foreground">
              <LoaderCircle className="mx-auto size-5 animate-spin" aria-hidden="true" />
              <p className="mt-3 text-sm font-semibold">일별 기록을 불러오는 중</p>
            </div>
          </div>
        ) : error ? (
          <div className="grid h-[360px] place-items-center text-center">
            <div>
              <AlertCircle className="mx-auto size-6 text-muted-foreground" aria-hidden="true" />
              <p className="mt-4 text-sm font-bold">{error}</p>
              <Button variant="ghost" size="sm" className="mt-3" onClick={() => setRetryKey((value) => value + 1)}>
                <RefreshCw /> 다시 시도
              </Button>
            </div>
          </div>
        ) : points.length === 0 ? (
          <div className="grid h-[360px] place-items-center rounded-[24px] bg-card px-6 text-center">
            <div className="max-w-sm">
              {backfill?.status === "running" || backfill?.status === "idle" ? (
                <LoaderCircle className="mx-auto size-7 animate-spin text-muted-foreground" aria-hidden="true" />
              ) : (
                <CalendarDays className="mx-auto size-7 text-muted-foreground" aria-hidden="true" />
              )}
              <p className="mt-4 text-base font-black">
                {backfill?.status === "running" || backfill?.status === "idle"
                  ? "첫 거래일부터 기록을 복원하고 있습니다."
                  : "아직 일별 기록이 없습니다."}
              </p>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                {backfill?.status === "running" || backfill?.status === "idle"
                  ? "체결 내역과 일봉을 읽어 SQLite에 저장한 뒤 차트가 자동으로 갱신됩니다."
                  : "동기화를 다시 시도하거나 토스증권 체결 내역을 확인해 주세요."}
              </p>
            </div>
          </div>
        ) : series.length === 0 ? (
          <div className="grid h-[360px] place-items-center rounded-[24px] bg-card px-6 text-center">
            <div className="max-w-sm">
              <EyeOff className="mx-auto size-7 text-muted-foreground" aria-hidden="true" />
              <p className="mt-4 text-base font-black">표시할 종목이 없습니다.</p>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                상단 표시 설정에서 차트에 다시 나타낼 종목을 선택해 주세요.
              </p>
            </div>
          </div>
        ) : points.length === 1 ? (
          <div className="mt-8 rounded-[24px] bg-card p-5 sm:p-7">
            <div className="flex items-end justify-between gap-3">
              <div>
                <p className="text-xs font-bold text-muted-foreground">첫 기록</p>
                <p className="mt-1 text-lg font-black">{displayDate(points[0].date, true)}</p>
              </div>
              <p className="text-xs text-muted-foreground">내일부터 추이선이 만들어집니다.</p>
            </div>
            <div className="mt-8 flex h-20 overflow-hidden rounded-[20px]" aria-label="오늘 종목별 비중">
              {series.map((item) => {
                const weight = points[0].values[item.key] ?? 0;
                return weight > 0 ? (
                  <div
                    key={item.key}
                    className="grid min-w-1 place-items-center overflow-hidden text-[10px] font-black"
                    style={{ width: `${weight}%`, backgroundColor: stockColor(item.key, theme) }}
                    title={`${item.name} ${weight.toFixed(1)}%`}
                  />
                ) : null;
              })}
            </div>
          </div>
        ) : (
          <div className="mt-7 h-[300px] w-full sm:h-[370px]" aria-label="일별 종목 평가금 누적 영역 차트">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 10, right: 4, bottom: 0, left: 0 }}>
                <CartesianGrid vertical={false} stroke="hsl(var(--chart-grid))" strokeDasharray="3 5" />
                <XAxis
                  dataKey="date"
                  tickFormatter={(value) => displayDate(String(value))}
                  axisLine={false}
                  tickLine={false}
                  minTickGap={34}
                  tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11, fontWeight: 600 }}
                />
                <YAxis
                  domain={[0, "auto"]}
                  tickFormatter={(value) => formatMoney(Number(value), currency, true)}
                  axisLine={false}
                  tickLine={false}
                  width={64}
                  tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11, fontWeight: 600 }}
                />
                <Tooltip
                  formatter={(value, name, entry) => {
                    const amount = Number(value);
                    const totalValue = Number(entry.payload?.totalValue ?? 0);
                    const weight = totalValue > 0 ? (amount / totalValue) * 100 : 0;
                    return [`${formatMoney(amount, currency)} · ${weight.toFixed(1)}%`, String(name)];
                  }}
                  labelFormatter={(label) => displayDate(String(label), true)}
                  contentStyle={{
                    border: 0,
                    borderRadius: 16,
                    background: "hsl(var(--card))",
                    color: "hsl(var(--card-foreground))",
                    boxShadow: "0 16px 48px rgba(0,0,0,.2)",
                    fontSize: 12,
                    fontWeight: 700,
                  }}
                  itemStyle={{ color: "hsl(var(--foreground))" }}
                  labelStyle={{ color: "hsl(var(--muted-foreground))", marginBottom: 6 }}
                />
                {series.map((item, index) => (
                  <Area
                    key={item.key}
                    type="linear"
                    dataKey={`series${index}`}
                    name={item.name}
                    stackId="portfolio"
                    stroke={stockColor(item.key, theme)}
                    fill={stockColor(item.key, theme)}
                    strokeWidth={1.5}
                    fillOpacity={0.78}
                    isAnimationActive={false}
                  />
                ))}
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}

        {!loading && !error && series.length ? (
          <div className="mt-6 flex flex-wrap gap-x-5 gap-y-3" aria-label="종목 범례">
            {series.map((item) => (
              <div key={item.key} className="flex min-w-0 items-center gap-2 text-xs">
                <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: stockColor(item.key, theme) }} />
                <span className="max-w-40 truncate font-bold">{item.name}</span>
                <span className="text-muted-foreground">평균 {item.averageWeight.toFixed(1)}%</span>
              </div>
            ))}
          </div>
        ) : null}
      </Card>
    </section>
  );
}
