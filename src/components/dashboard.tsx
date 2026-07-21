import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  CandlestickChart,
  ChartNoAxesCombined,
  CircleGauge,
  FlaskConical,
  Layers3,
  LayoutDashboard,
  LibraryBig,
  ListFilter,
  LoaderCircle,
  LockKeyhole,
  LogOut,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  TimerReset,
} from "lucide-react";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { AllocationHistoryChart } from "@/components/allocation-history-chart";
import { Logo } from "@/components/logo";
import { PortfolioAnalysisView } from "@/components/portfolio-analysis";
import { PortfolioBacktestView } from "@/components/portfolio-backtest";
import { ResearchLibrary } from "@/components/research-library";
import { StockVisibilitySettings } from "@/components/stock-visibility-settings";
import { TechnicalAnalysisView } from "@/components/technical-analysis";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { buildAllocation } from "@/lib/allocation";
import { dashboardHash, dashboardViewFromHash, type DashboardView } from "@/lib/dashboard-navigation";
import { formatMoney, formatPercent, formatQuantity, formatSignedMoney, formatSyncTime } from "@/lib/format";
import { PORTFOLIO_REFRESH_INTERVAL_MS, portfolioRequestUrl } from "@/lib/portfolio-refresh";
import { holdingKey, stockColor, stockForeground } from "@/lib/stock-appearance";
import { cn } from "@/lib/utils";
import type { TechnicalStrategyHandoff } from "@/lib/technical-strategy";
import {
  buildVisibilityStocks,
  HIDDEN_STOCKS_STORAGE_KEY,
  parseHiddenStockKeys,
  serializeHiddenStockKeys,
} from "@/lib/visibility-settings";
import type { ApiError, Holding, Portfolio, PortfolioHistorySeries, Theme } from "@/types";

const ScalpingAssistant = lazy(() => import("@/components/scalping-assistant").then((module) => ({ default: module.ScalpingAssistant })));

type DashboardProps = {
  onLogout: () => void;
  onUnauthorized: () => void;
  theme: Theme;
  onToggleTheme: () => void;
};

function formatAmountPair(amounts: { KRW: number; USD: number }, signed = false): string {
  const format = signed ? formatSignedMoney : formatMoney;
  const values: string[] = [];
  if (amounts.KRW !== 0 || amounts.USD === 0) values.push(format(amounts.KRW, "KRW"));
  if (amounts.USD !== 0) values.push(format(amounts.USD, "USD"));
  return values.join(" · ");
}

async function readPayload<T>(response: Response): Promise<T> {
  return (await response.json().catch(() => ({}))) as T;
}

function initials(name: string, symbol: string): string {
  const trimmed = name.trim();
  if (trimmed) return Array.from(trimmed).slice(0, 2).join("");
  return symbol.slice(0, 2).toUpperCase();
}

function GainIndicator({ value, inverse = false }: { value: number; inverse?: boolean }) {
  const positive = value >= 0;
  const Icon = positive ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={cn("inline-flex items-center gap-1 font-bold", inverse ? "text-white" : "text-foreground")}>
      <Icon className="size-4" aria-hidden="true" />
      {formatPercent(value, true)}
    </span>
  );
}

function Sidebar({
  portfolio,
  onLogout,
  view = "overview",
  onViewChange = () => undefined,
}: {
  portfolio?: Portfolio;
  onLogout: () => void;
  view?: DashboardView;
  onViewChange?: (view: DashboardView) => void;
}) {
  const sections = [
    { href: "#history", label: "비중 추이", icon: ChartNoAxesCombined },
    { href: "#allocation", label: "자산 구성", icon: CircleGauge },
    { href: "#holdings", label: "보유 종목", icon: Layers3 },
  ];

  return (
    <aside className="dashboard-sidebar">
      <Logo inverse />
      <nav className="mt-14 space-y-1" aria-label="대시보드 탐색">
        {([
          { value: "overview" as const, label: "포트폴리오", icon: LayoutDashboard },
          { value: "analysis" as const, label: "포트폴리오 분석", icon: BarChart3 },
          { value: "technical" as const, label: "기술적 분석", icon: CandlestickChart },
          { value: "scalping" as const, label: "단타 보조", icon: TimerReset },
          { value: "backtest" as const, label: "백테스트", icon: FlaskConical },
          { value: "optimization" as const, label: "최적화", icon: Sparkles },
          { value: "library" as const, label: "실행·프리셋", icon: LibraryBig },
        ]).map((item) => (
          <button
            key={item.value}
            type="button"
            onClick={() => onViewChange(item.value)}
            className={cn(
              "flex w-full items-center gap-3 rounded-2xl px-3.5 py-3 text-left text-sm font-semibold transition-colors",
              view === item.value ? "bg-white text-black" : "text-white/60 hover:bg-white/10 hover:text-white",
            )}
          >
            <item.icon className="size-[18px]" aria-hidden="true" />
            {item.label}
          </button>
        ))}
        {view === "overview" ? (
          <div className="space-y-0.5 pb-2 pl-4 pt-2">
            {sections.map((item) => (
              <a key={item.href} href={item.href} className="flex items-center gap-2.5 rounded-xl px-3 py-2 text-xs font-semibold text-white/40 transition-colors hover:bg-white/10 hover:text-white/80">
                <item.icon className="size-3.5" aria-hidden="true" />{item.label}
              </a>
            ))}
          </div>
        ) : null}
      </nav>

      <div className="mt-auto space-y-3">
        <div className="rounded-[22px] bg-white/[0.08] p-4">
          <div className="mb-3 flex items-center gap-2 text-white/50">
            <ShieldCheck className="size-4" aria-hidden="true" />
            <span className="text-[11px] font-bold tracking-[0.12em]">READ ONLY</span>
          </div>
          <p className="truncate text-sm font-semibold text-white">{portfolio?.account.label || "토스증권 계좌"}</p>
          <p className="mt-1 text-xs text-white/40">조회 전용 연결</p>
        </div>
        <button
          type="button"
          onClick={onLogout}
          className="flex w-full items-center gap-3 rounded-2xl px-3.5 py-3 text-sm font-semibold text-white/60 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
        >
          <LogOut className="size-[18px]" aria-hidden="true" />
          로그아웃
        </button>
      </div>
    </aside>
  );
}

function DashboardHeader({
  portfolio,
  refreshing,
  onRefresh,
  onAccountChange,
  onLogout,
  theme,
  onToggleTheme,
  settingsOpen,
  hiddenCount,
  onToggleSettings,
  view,
}: {
  portfolio: Portfolio;
  refreshing: boolean;
  onRefresh: () => void;
  onAccountChange: (value: string) => void;
  onLogout: () => void;
  theme: Theme;
  onToggleTheme: () => void;
  settingsOpen: boolean;
  hiddenCount: number;
  onToggleSettings: () => void;
  view: DashboardView;
}) {
  return (
    <header className="dashboard-header">
      <div>
        <p className="mb-1 text-xs font-bold tracking-[0.14em] text-muted-foreground">
          {{ overview: "PORTFOLIO OVERVIEW", analysis: "PORTFOLIO ANALYSIS", technical: "TECHNICAL ANALYSIS", scalping: "SCALPING ASSISTANT", backtest: "PORTFOLIO BACKTEST", optimization: "PORTFOLIO OPTIMIZATION", library: "RUNS & PRESETS" }[view]}
        </p>
        <h1 className="text-[clamp(1.8rem,3vw,2.55rem)] font-black tracking-[-0.05em]">
          {{ overview: "안녕하세요.", analysis: "포트폴리오 분석", technical: "기술적 분석", scalping: "단타 보조", backtest: "백테스트", optimization: "포트폴리오 최적화", library: "실행·프리셋" }[view]}
        </h1>
      </div>

      <div className="flex items-center justify-end gap-2">
        <Select value={portfolio.selectedAccountId} onValueChange={onAccountChange}>
          <SelectTrigger aria-label="계좌 선택" className="hidden sm:flex">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="end">
            {portfolio.accounts.map((account) => (
              <SelectItem key={account.id} value={account.id}>
                {account.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <ThemeToggle theme={theme} onToggle={onToggleTheme} />
        {view === "overview" ? (
          <Button
            variant="secondary"
            size="icon"
            className="relative"
            onClick={onToggleSettings}
            aria-label={settingsOpen ? "표시 설정 닫기" : "표시 설정 열기"}
            aria-expanded={settingsOpen}
            aria-controls="display-settings"
          >
            <Settings2 />
            {hiddenCount ? (
              <span className="absolute -right-1 -top-1 grid size-5 place-items-center rounded-full bg-primary text-[10px] font-black text-primary-foreground">
                {hiddenCount > 9 ? "9+" : hiddenCount}
              </span>
            ) : null}
          </Button>
        ) : null}
        <Button variant="secondary" size="icon" onClick={onRefresh} disabled={refreshing} aria-label="포트폴리오 새로고침">
          <RefreshCw className={cn(refreshing && "animate-spin")} />
        </Button>
        <Button variant="secondary" size="icon" onClick={onLogout} className="lg:hidden" aria-label="로그아웃">
          <LogOut />
        </Button>
      </div>
    </header>
  );
}

function MobileViewTabs({ view, onChange }: { view: DashboardView; onChange: (view: DashboardView) => void }) {
  return (
    <div className="mb-3 flex max-w-full gap-1 overflow-x-auto rounded-[20px] bg-secondary p-1 lg:hidden" aria-label="화면 선택">
      {([
        { value: "overview" as const, label: "포트폴리오" },
        { value: "analysis" as const, label: "분석" },
        { value: "technical" as const, label: "기술 분석" },
        { value: "scalping" as const, label: "단타 보조" },
        { value: "backtest" as const, label: "백테스트" },
        { value: "optimization" as const, label: "최적화" },
        { value: "library" as const, label: "실행·프리셋" },
      ]).map((item) => (
        <button
          key={item.value}
          type="button"
          aria-pressed={view === item.value}
          onClick={() => onChange(item.value)}
          className={cn(
            "min-w-fit flex-1 rounded-full px-4 py-2.5 text-xs font-black transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            view === item.value ? "bg-primary text-primary-foreground" : "text-muted-foreground",
          )}
        >{item.label}</button>
      ))}
    </div>
  );
}

function PortfolioHero({ portfolio }: { portfolio: Portfolio }) {
  const { summary } = portfolio;
  const primaryCurrency = summary.evaluationAmount.KRW !== 0 || summary.evaluationAmount.USD === 0 ? "KRW" : "USD";
  const secondaryCurrency = primaryCurrency === "KRW" && summary.evaluationAmount.USD !== 0 ? "USD" : undefined;
  return (
    <section id="overview" className="portfolio-hero animate-fade-up scroll-mt-5" aria-labelledby="portfolio-total-title">
      <div className="relative z-10 flex h-full flex-col">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="mb-5 inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-2 text-xs font-bold text-white/70">
              <LockKeyhole className="size-3.5" />
              보유 주식 평가액
            </div>
            <p id="portfolio-total-title" className="text-[clamp(2.45rem,6vw,5.8rem)] font-black leading-none tracking-[-0.07em] text-white">
              {formatMoney(summary.evaluationAmount[primaryCurrency], primaryCurrency)}
            </p>
            {secondaryCurrency ? (
              <p className="mt-3 text-[clamp(1.35rem,2.7vw,2.35rem)] font-black tracking-[-0.045em] text-white/60">
                + {formatMoney(summary.evaluationAmount[secondaryCurrency], secondaryCurrency)}
              </p>
            ) : null}
          </div>
          <span className="hidden rounded-full bg-white px-3.5 py-2 text-xs font-black text-black sm:inline-flex">LIVE · 5초</span>
        </div>

        <div className="mt-auto grid grid-cols-2 gap-x-5 gap-y-5 pt-12 lg:grid-cols-4 lg:gap-8">
          <div>
            <p className="mb-2 text-xs font-medium text-white/50">총 투자 원금</p>
            <p className="text-sm font-bold text-white sm:text-base">{formatAmountPair(summary.purchaseAmount)}</p>
          </div>
          <div>
            <p className="mb-2 text-xs font-medium text-white/50">누적 평가 손익</p>
            <p className="text-sm font-bold text-white sm:text-base">{formatAmountPair(summary.profitLoss, true)}</p>
          </div>
          <div>
            <p className="mb-2 text-xs font-medium text-white/50">오늘 손익</p>
            <p className="text-sm font-bold text-white sm:text-base">{formatAmountPair(summary.dailyProfitLoss, true)}</p>
          </div>
          <div>
            <p className="mb-2 text-xs font-medium text-white/50">누적 수익률</p>
            <GainIndicator value={summary.profitRate} inverse />
          </div>
        </div>
      </div>
    </section>
  );
}

function AllocationCard({ portfolio, theme }: { portfolio: Portfolio; theme: Theme }) {
  const currencies = useMemo(
    () => (["KRW", "USD"] as const).filter((currency) =>
      portfolio.holdings.some((holding) => holding.currency === currency && holding.evaluationAmount > 0),
    ),
    [portfolio.holdings],
  );
  const [selectedCurrency, setSelectedCurrency] = useState<"KRW" | "USD">(
    portfolio.holdings.some((holding) => holding.currency === "KRW" && holding.evaluationAmount > 0)
      ? "KRW"
      : portfolio.holdings.some((holding) => holding.currency === "USD" && holding.evaluationAmount > 0)
        ? "USD"
        : "KRW",
  );

  useEffect(() => {
    if (currencies.length && !currencies.includes(selectedCurrency)) {
      setSelectedCurrency(currencies[0]);
    }
  }, [currencies, selectedCurrency]);

  const allocation = useMemo(() => {
    return buildAllocation(portfolio.holdings, selectedCurrency);
  }, [portfolio.holdings, selectedCurrency]);
  const total = allocation.reduce((sum, item) => sum + item.value, 0);

  return (
    <section id="allocation" className="scroll-mt-5">
      <Card className="grid min-h-[390px] gap-4 bg-secondary p-5 sm:p-7 lg:grid-cols-[0.95fr_1.05fr]">
        <div className="flex flex-col">
          <div>
            <div className="mb-2 flex items-center justify-between gap-3">
              <p className="text-xs font-bold tracking-[0.14em] text-muted-foreground">ALLOCATION</p>
              {currencies.length > 1 ? (
                <div className="flex rounded-full bg-card p-1">
                  {currencies.map((currency) => (
                    <button
                      key={currency}
                      type="button"
                      onClick={() => setSelectedCurrency(currency)}
                      className={cn(
                        "rounded-full px-3 py-1.5 text-[11px] font-black transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        selectedCurrency === currency ? "bg-primary text-primary-foreground" : "text-muted-foreground",
                      )}
                    >
                      {currency}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            <h2 className="text-2xl font-black tracking-[-0.04em]">자산 구성 · {selectedCurrency}</h2>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">보유 종목 평가액 비중입니다.</p>
          </div>

          <div className="mt-8 space-y-3 lg:mt-auto">
            {allocation.length ? allocation.map((item) => {
              const percent = total > 0 ? (item.value / total) * 100 : 0;
              return (
                <div key={item.key} className="flex items-center gap-3">
                  <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: stockColor(item.symbol, theme) }} />
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold">{item.name}</span>
                  <span className="text-sm font-black tabular-nums">{formatPercent(percent)}</span>
                </div>
              );
            }) : (
              <p className="rounded-2xl bg-card p-4 text-sm text-muted-foreground">표시할 보유 자산이 없습니다.</p>
            )}
          </div>
        </div>

        <div className="relative min-h-[290px]">
          {allocation.length ? (
            <>
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={allocation}
                    dataKey="value"
                    nameKey="name"
                    innerRadius="61%"
                    outerRadius="88%"
                    paddingAngle={2}
                    cornerRadius={7}
                    stroke="none"
                  >
                    {allocation.map((item) => (
                      <Cell key={item.key} fill={stockColor(item.symbol, theme)} />
                    ))}
                  </Pie>
                  <Tooltip
                    cursor={false}
                    formatter={(value) => formatMoney(Number(value), selectedCurrency)}
                    contentStyle={{
                      border: 0,
                      borderRadius: 16,
                      boxShadow: "0 16px 48px rgba(0,0,0,.12)",
                      fontSize: 12,
                      fontWeight: 700,
                      background: "hsl(var(--card))",
                      color: "hsl(var(--card-foreground))",
                    }}
                    labelStyle={{ color: "hsl(var(--card-foreground))", fontWeight: 800 }}
                    itemStyle={{ color: "hsl(var(--card-foreground))", fontWeight: 700 }}
                  />
                </PieChart>
              </ResponsiveContainer>
              <div className="pointer-events-none absolute inset-0 grid place-items-center text-center">
                <div>
                  <p className="text-xs font-semibold text-muted-foreground">상위 비중</p>
                  <p className="mt-1 max-w-[120px] truncate text-lg font-black">{allocation[0]?.name}</p>
                </div>
              </div>
            </>
          ) : (
            <div className="grid h-full place-items-center">
              <div className="grid size-52 place-items-center rounded-full bg-card">
                <Layers3 className="size-7 text-muted-foreground/50" />
              </div>
            </div>
          )}
        </div>
      </Card>
    </section>
  );
}

function HoldingDesktopRow({ holding, theme }: { holding: Holding; theme: Theme }) {
  return (
    <div className="holding-grid items-center rounded-[20px] bg-muted px-4 py-3.5 transition-transform hover:-translate-y-0.5">
      <div className="flex min-w-0 items-center gap-3">
        <span
          className="grid size-11 shrink-0 place-items-center rounded-2xl text-xs font-black"
          style={{ backgroundColor: stockColor(holding.symbol, theme), color: stockForeground(holding.symbol, theme) }}
        >
          {initials(holding.name, holding.symbol)}
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-bold">{holding.name}</p>
          <p className="mt-1 truncate text-xs font-medium text-muted-foreground">{holding.symbol} · {holding.market}</p>
        </div>
      </div>
      <div>
        <p className="text-sm font-bold">{formatQuantity(holding.quantity)}주</p>
        <p className="mt-1 text-xs text-muted-foreground">평균 {formatMoney(holding.averagePrice, holding.currency)}</p>
      </div>
      <div className="text-right">
        <p className="text-sm font-bold">{formatMoney(holding.currentPrice, holding.currency)}</p>
        <p className="mt-1 text-xs text-muted-foreground">현재가</p>
      </div>
      <div className="text-right">
        <p className="text-sm font-black">{formatMoney(holding.evaluationAmount, holding.currency)}</p>
        <p className="mt-1 text-xs text-muted-foreground">평가액</p>
      </div>
      <div className="text-right">
        <p className="text-sm font-black">{formatSignedMoney(holding.profitLoss, holding.currency)}</p>
        <p className="mt-1 text-xs font-bold text-muted-foreground">{formatPercent(holding.profitRate, true)}</p>
      </div>
    </div>
  );
}

function HoldingMobileCard({ holding, theme }: { holding: Holding; theme: Theme }) {
  return (
    <article className="rounded-[22px] bg-muted p-4">
      <div className="flex items-center gap-3">
        <span
          className="grid size-11 shrink-0 place-items-center rounded-2xl text-xs font-black"
          style={{ backgroundColor: stockColor(holding.symbol, theme), color: stockForeground(holding.symbol, theme) }}
        >
          {initials(holding.name, holding.symbol)}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-black">{holding.name}</h3>
          <p className="mt-1 text-xs font-medium text-muted-foreground">{holding.symbol} · {holding.market}</p>
        </div>
        <GainIndicator value={holding.profitRate} />
      </div>
      <div className="mt-5 grid grid-cols-2 gap-3">
        <div>
          <p className="text-[11px] text-muted-foreground">평가액</p>
          <p className="mt-1 text-sm font-black">{formatMoney(holding.evaluationAmount, holding.currency)}</p>
        </div>
        <div className="text-right">
          <p className="text-[11px] text-muted-foreground">평가 손익</p>
          <p className="mt-1 text-sm font-black">{formatSignedMoney(holding.profitLoss, holding.currency)}</p>
        </div>
        <div>
          <p className="text-[11px] text-muted-foreground">보유 수량</p>
          <p className="mt-1 text-sm font-bold">{formatQuantity(holding.quantity)}주</p>
        </div>
        <div className="text-right">
          <p className="text-[11px] text-muted-foreground">현재가</p>
          <p className="mt-1 text-sm font-bold">{formatMoney(holding.currentPrice, holding.currency)}</p>
        </div>
      </div>
    </article>
  );
}

function HoldingsCard({ portfolio, theme, hiddenCount }: { portfolio: Portfolio; theme: Theme; hiddenCount: number }) {
  const [query, setQuery] = useState("");
  const holdings = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("ko-KR");
    if (!normalized) return portfolio.holdings;
    return portfolio.holdings.filter((holding) =>
      [holding.name, holding.symbol, holding.market].some((value) => value.toLocaleLowerCase("ko-KR").includes(normalized)),
    );
  }, [portfolio.holdings, query]);

  return (
    <section id="holdings" className="scroll-mt-5" aria-labelledby="holdings-title">
      <Card className="bg-card p-0">
        <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="mb-2 text-xs font-bold tracking-[0.14em] text-muted-foreground">HOLDINGS</p>
            <h2 id="holdings-title" className="text-2xl font-black tracking-[-0.04em]">보유 종목</h2>
            <p className="mt-2 text-sm text-muted-foreground">총 {portfolio.holdings.length}개 종목</p>
          </div>
          <div className="relative w-full sm:w-[260px]">
            <Search className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="종목명 또는 심볼 검색"
              aria-label="보유 종목 검색"
              className="h-11 pl-10"
            />
          </div>
        </div>

        {holdings.length ? (
          <>
            <div className="hidden space-y-2 lg:block">
              <div className="holding-grid px-4 pb-1 text-[11px] font-bold tracking-wide text-muted-foreground">
                <span>종목</span>
                <span>보유 수량</span>
                <span className="text-right">현재가</span>
                <span className="text-right">평가액</span>
                <span className="text-right">평가 손익</span>
              </div>
              {holdings.map((holding) => <HoldingDesktopRow key={holdingKey(holding)} holding={holding} theme={theme} />)}
            </div>
            <div className="space-y-2 lg:hidden">
              {holdings.map((holding) => <HoldingMobileCard key={holdingKey(holding)} holding={holding} theme={theme} />)}
            </div>
          </>
        ) : (
          <div className="grid min-h-52 place-items-center rounded-[24px] bg-muted p-8 text-center">
            <div>
              <ListFilter className="mx-auto size-6 text-muted-foreground" />
              <p className="mt-4 text-sm font-bold">
                {!query.trim() && hiddenCount ? "모든 보유 종목이 숨겨져 있습니다." : "일치하는 종목이 없습니다."}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {!query.trim() && hiddenCount ? "상단 표시 설정에서 다시 표시할 수 있습니다." : "다른 검색어를 입력해 보세요."}
              </p>
            </div>
          </div>
        )}
      </Card>
    </section>
  );
}

function DashboardSkeleton({ theme, onToggleTheme }: { theme: Theme; onToggleTheme: () => void }) {
  return (
    <div className="dashboard-frame">
      <Sidebar onLogout={() => undefined} />
      <main className="dashboard-main">
        <div className="dashboard-header">
          <div className="space-y-2"><Skeleton className="h-3 w-32" /><Skeleton className="h-10 w-44" /></div>
          <div className="flex gap-2">
            <ThemeToggle theme={theme} onToggle={onToggleTheme} />
            <Skeleton className="h-11 w-44 rounded-full" />
          </div>
        </div>
        <div className="space-y-3">
          <Skeleton className="h-[360px] rounded-[30px]" />
          <div className="grid gap-3 md:grid-cols-3">
            <Skeleton className="h-44 rounded-[28px]" />
            <Skeleton className="h-44 rounded-[28px]" />
            <Skeleton className="h-44 rounded-[28px]" />
          </div>
          <Skeleton className="h-80 rounded-[28px]" />
        </div>
      </main>
    </div>
  );
}

function InitialError({
  message,
  requestId,
  onRetry,
  onLogout,
  theme,
  onToggleTheme,
}: {
  message: string;
  requestId?: string;
  onRetry: () => void;
  onLogout: () => void;
  theme: Theme;
  onToggleTheme: () => void;
}) {
  return (
    <div className="dashboard-frame">
      <Sidebar onLogout={onLogout} />
      <main className="dashboard-main relative grid place-items-center">
        <div className="absolute right-5 top-5">
          <ThemeToggle theme={theme} onToggle={onToggleTheme} />
        </div>
        <div className="max-w-md text-center">
          <div className="mx-auto grid size-14 place-items-center rounded-[20px] bg-primary text-primary-foreground">
            <RefreshCw className="size-5" />
          </div>
          <h1 className="mt-6 text-2xl font-black tracking-[-0.04em]">포트폴리오를 불러오지 못했습니다.</h1>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">{message}</p>
          {requestId ? <p className="mt-2 text-xs text-muted-foreground">요청 ID: {requestId}</p> : null}
          <div className="mt-7 flex flex-wrap justify-center gap-2">
            <Button onClick={onRetry}>
              다시 불러오기
              <RefreshCw />
            </Button>
            <Button variant="secondary" onClick={onLogout}>
              로그아웃
              <LogOut />
            </Button>
          </div>
        </div>
      </main>
    </div>
  );
}

export function Dashboard({ onLogout, onUnauthorized, theme, onToggleTheme }: DashboardProps) {
  const [view, setView] = useState<DashboardView>(() => dashboardViewFromHash(window.location.hash));
  const [technicalStrategyHandoff, setTechnicalStrategyHandoff] = useState<TechnicalStrategyHandoff>();
  const [portfolio, setPortfolio] = useState<Portfolio>();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<{ message: string; requestId?: string }>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [historySeries, setHistorySeries] = useState<PortfolioHistorySeries[]>([]);
  const portfolioRef = useRef<Portfolio | undefined>(undefined);
  const backgroundRefreshInFlight = useRef(false);
  const foregroundRequestsInFlight = useRef(0);
  const latestPortfolioRequest = useRef(0);
  const [hiddenStockKeys, setHiddenStockKeys] = useState<Set<string>>(
    () => new Set(parseHiddenStockKeys(window.localStorage.getItem(HIDDEN_STOCKS_STORAGE_KEY))),
  );

  useEffect(() => {
    const updateFromHash = () => setView(dashboardViewFromHash(window.location.hash));
    window.addEventListener("hashchange", updateFromHash);
    return () => window.removeEventListener("hashchange", updateFromHash);
  }, []);

  const changeView = useCallback((nextView: DashboardView) => {
    setView(nextView);
    setSettingsOpen(false);
    window.history.replaceState(null, "", dashboardHash(nextView));
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  const openTechnicalBacktest = useCallback((handoff: TechnicalStrategyHandoff) => {
    setTechnicalStrategyHandoff(handoff);
    changeView("backtest");
  }, [changeView]);
  const consumeTechnicalBacktestHandoff = useCallback(() => setTechnicalStrategyHandoff(undefined), []);

  useEffect(() => {
    if (portfolio && technicalStrategyHandoff && technicalStrategyHandoff.accountId !== portfolio.selectedAccountId) {
      setTechnicalStrategyHandoff(undefined);
    }
  }, [portfolio, technicalStrategyHandoff]);

  useEffect(() => {
    try {
      window.localStorage.setItem(HIDDEN_STOCKS_STORAGE_KEY, serializeHiddenStockKeys(hiddenStockKeys));
    } catch {
      // 브라우저 저장소가 차단된 경우 현재 세션의 설정은 그대로 유지한다.
    }
  }, [hiddenStockKeys]);

  const loadPortfolio = useCallback(async (account?: string, force = false, background = false) => {
    if (background && (backgroundRefreshInFlight.current || foregroundRequestsInFlight.current > 0)) return;
    if (background) backgroundRefreshInFlight.current = true;
    else foregroundRequestsInFlight.current += 1;
    const requestNumber = latestPortfolioRequest.current + 1;
    latestPortfolioRequest.current = requestNumber;
    if (force && !background) setRefreshing(true);
    else if (!portfolioRef.current && !background) setLoading(true);
    if (!background) setError(undefined);

    try {
      const response = await fetch(portfolioRequestUrl(account, force, !background), {
        headers: { Accept: "application/json" },
      });
      const payload = await readPayload<Portfolio & ApiError>(response);
      if (response.status === 401 && payload.error?.code === "authentication-required") {
        onUnauthorized();
        return;
      }
      if (!response.ok) {
        throw Object.assign(new Error(payload.error?.message || "포트폴리오를 불러오지 못했습니다."), {
          requestId: payload.error?.requestId,
        });
      }
      if (requestNumber !== latestPortfolioRequest.current) return;
      portfolioRef.current = payload;
      setPortfolio(payload);
      if (background) setError(undefined);
    } catch (caught) {
      const requestId = typeof caught === "object" && caught && "requestId" in caught
        ? String((caught as { requestId?: string }).requestId || "")
        : undefined;
      if (!background && requestNumber === latestPortfolioRequest.current) {
        setError({
          message: caught instanceof Error ? caught.message : "포트폴리오를 불러오지 못했습니다.",
          ...(requestId ? { requestId } : {}),
        });
      }
    } finally {
      setLoading(false);
      if (!background) setRefreshing(false);
      if (background) backgroundRefreshInFlight.current = false;
      else foregroundRequestsInFlight.current = Math.max(0, foregroundRequestsInFlight.current - 1);
    }
  }, [onUnauthorized]);

  useEffect(() => {
    void loadPortfolio();
  }, [loadPortfolio]);

  useEffect(() => {
    const account = portfolio?.selectedAccountId;
    if (!account) return;
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        void loadPortfolio(account, false, true);
      }
    }, PORTFOLIO_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [loadPortfolio, portfolio?.selectedAccountId]);

  useEffect(() => {
    setHistorySeries([]);
  }, [portfolio?.selectedAccountId]);

  const visiblePortfolio = useMemo<Portfolio | undefined>(() => {
    if (!portfolio) return undefined;
    const holdings = portfolio.holdings.filter((holding) => !hiddenStockKeys.has(holdingKey(holding)));
    return {
      ...portfolio,
      holdings,
      summary: {
        ...portfolio.summary,
        positionCount: holdings.length,
      },
    };
  }, [hiddenStockKeys, portfolio]);

  const visibilityStocks = useMemo(
    () => portfolio ? buildVisibilityStocks(portfolio.holdings, historySeries) : [],
    [historySeries, portfolio],
  );

  const hiddenCurrentCount = useMemo(
    () => portfolio?.holdings.filter((holding) => hiddenStockKeys.has(holdingKey(holding))).length ?? 0,
    [hiddenStockKeys, portfolio?.holdings],
  );
  const hiddenDisplayCount = useMemo(
    () => visibilityStocks.filter((stock) => hiddenStockKeys.has(stock.key)).length,
    [hiddenStockKeys, visibilityStocks],
  );

  const handleHistorySeriesChange = useCallback((series: PortfolioHistorySeries[]) => {
    setHistorySeries(series);
  }, []);

  const toggleStockVisibility = useCallback((key: string) => {
    setHiddenStockKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    onLogout();
  }

  if (loading) return <DashboardSkeleton theme={theme} onToggleTheme={onToggleTheme} />;
  if (!portfolio && error) {
    return (
      <InitialError
        message={error.message}
        requestId={error.requestId}
        onRetry={() => void loadPortfolio()}
        onLogout={() => void handleLogout()}
        theme={theme}
        onToggleTheme={onToggleTheme}
      />
    );
  }
  if (!portfolio || !visiblePortfolio) return <DashboardSkeleton theme={theme} onToggleTheme={onToggleTheme} />;

  return (
    <div className="dashboard-frame">
      <Sidebar portfolio={portfolio} onLogout={() => void handleLogout()} view={view} onViewChange={changeView} />
      <main className="dashboard-main">
        <DashboardHeader
          portfolio={portfolio}
          refreshing={refreshing}
          onRefresh={() => void loadPortfolio(portfolio.selectedAccountId, true)}
          onAccountChange={(value) => void loadPortfolio(value)}
          onLogout={() => void handleLogout()}
          theme={theme}
          onToggleTheme={onToggleTheme}
          settingsOpen={settingsOpen}
          hiddenCount={hiddenDisplayCount}
          onToggleSettings={() => setSettingsOpen((value) => !value)}
          view={view}
        />

        <MobileViewTabs view={view} onChange={changeView} />

        {portfolio.accounts.length > 1 ? (
          <div className="mb-3 sm:hidden">
            <Select value={portfolio.selectedAccountId} onValueChange={(value) => void loadPortfolio(value)}>
              <SelectTrigger aria-label="계좌 선택" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {portfolio.accounts.map((account) => (
                  <SelectItem key={account.id} value={account.id}>
                    {account.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}

        {view === "overview" && settingsOpen ? (
          <StockVisibilitySettings
            stocks={visibilityStocks}
            hiddenStockKeys={hiddenStockKeys}
            theme={theme}
            onToggle={toggleStockVisibility}
            onShowAll={() => setHiddenStockKeys(new Set())}
            onClose={() => setSettingsOpen(false)}
          />
        ) : null}

        {error ? (
          <div role="alert" className="mb-3 flex flex-col gap-3 rounded-[20px] bg-primary px-4 py-3 text-sm text-primary-foreground sm:flex-row sm:items-center sm:justify-between">
            <span>{error.message}</span>
            <button type="button" className="shrink-0 font-bold underline underline-offset-4" onClick={() => void loadPortfolio(portfolio.selectedAccountId, true)}>
              다시 시도
            </button>
          </div>
        ) : null}

        {view === "overview" ? (
          <div className="space-y-3">
            <PortfolioHero portfolio={visiblePortfolio} />
            <AllocationCard portfolio={visiblePortfolio} theme={theme} />
            <AllocationHistoryChart
              key={portfolio.selectedAccountId}
              portfolio={portfolio}
              theme={theme}
              hiddenStockKeys={hiddenStockKeys}
              onUnauthorized={onUnauthorized}
              onSeriesChange={handleHistorySeriesChange}
            />
            <HoldingsCard portfolio={visiblePortfolio} theme={theme} hiddenCount={hiddenCurrentCount} />
          </div>
        ) : view === "analysis" ? (
          <PortfolioAnalysisView key={portfolio.selectedAccountId} portfolio={portfolio} theme={theme} onUnauthorized={onUnauthorized} />
        ) : view === "technical" ? (
          <TechnicalAnalysisView key={`${portfolio.selectedAccountId}:technical`} portfolio={portfolio} theme={theme} onUnauthorized={onUnauthorized} onOpenTechnicalBacktest={openTechnicalBacktest} />
        ) : view === "scalping" ? (
          <Suspense fallback={<Card className="grid min-h-[420px] place-items-center bg-secondary"><div className="text-center"><LoaderCircle className="mx-auto size-5 animate-spin" /><p className="mt-3 text-xs font-black">단타 보조 화면을 불러오는 중</p></div></Card>}>
            <ScalpingAssistant key={`${portfolio.selectedAccountId}:scalping`} portfolio={portfolio} theme={theme} onUnauthorized={onUnauthorized} />
          </Suspense>
        ) : view === "backtest" ? (
          <PortfolioBacktestView
            key={`${portfolio.selectedAccountId}:backtest`}
            portfolio={portfolio}
            theme={theme}
            onUnauthorized={onUnauthorized}
            mode="backtest"
            technicalStrategyHandoff={technicalStrategyHandoff?.accountId === portfolio.selectedAccountId ? technicalStrategyHandoff : undefined}
            onTechnicalStrategyHandoffConsumed={consumeTechnicalBacktestHandoff}
          />
        ) : view === "optimization" ? (
          <PortfolioBacktestView key={`${portfolio.selectedAccountId}:optimization`} portfolio={portfolio} theme={theme} onUnauthorized={onUnauthorized} mode="optimization" />
        ) : (
          <ResearchLibrary key={`${portfolio.selectedAccountId}:library`} portfolio={portfolio} theme={theme} onUnauthorized={onUnauthorized} />
        )}

        <footer className="mt-10 flex flex-col gap-2 pb-2 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <p>마지막 동기화 {formatSyncTime(portfolio.asOf)}</p>
          <p className="inline-flex items-center gap-1.5">
            <ShieldCheck className="size-3.5" />
            토스증권 조회 API만 사용 · 주문 기능 없음
          </p>
        </footer>
      </main>
    </div>
  );
}
