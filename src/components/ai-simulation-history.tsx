import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  ChevronRight,
  Clock3,
  Cpu,
  FileText,
  History,
  ListChecks,
  LoaderCircle,
  ReceiptText,
  RefreshCw,
  Wallet,
} from "lucide-react";
import { AiSimulationChart } from "@/components/ai-simulation-chart";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  aiSimulationErrorMessage,
  normalizeAiSimulationHistory,
  normalizeAiSimulationReport,
  type AiSimulationDecision,
  type AiSimulationHistoryItem,
  type AiSimulationMarketCountry,
  type AiSimulationPreset,
  type AiSimulationRunReport,
  type AiSimulationSelectionRequest,
  type AiSimulationTrade,
} from "@/lib/ai-simulation";
import { formatMoney, formatQuantity } from "@/lib/format";
import { cn } from "@/lib/utils";

type AiSimulationHistoryProps = {
  onUnauthorized: () => void;
  refreshKey?: string;
};

const PRESET_LABELS: Record<AiSimulationPreset, string> = {
  trend: "추세 수익",
  breakout: "돌파 가속",
  mean_reversion: "반등 수익",
  risk_management: "방어 수익",
};

const STATUS_LABELS: Record<string, string> = {
  queued: "대기 중",
  running: "진행 중",
  monitoring: "진행 중",
  selecting: "종목 선정",
  candidate_selection: "종목 선정",
  cancel_requested: "취소 처리 중",
  cancelled: "취소됨",
  completed: "완료",
  failed: "실패",
};

const ACTION_LABELS: Record<string, string> = {
  buy: "가상 매수",
  sell: "가상 매도",
  hold: "보유 유지",
  watch: "관망",
  skip: "건너뜀",
  cash: "현금 유지",
};

function readJson(response: Response): Promise<unknown> {
  return response.json().catch(() => ({}));
}

function timestamp(value?: string): string {
  if (!value) return "unavailable";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "unavailable";
  return new Intl.DateTimeFormat("ko-KR", {
    year: "2-digit",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function ratio(value?: number, signed = false): string {
  if (!Number.isFinite(value)) return "unavailable";
  const percent = (value as number) * 100;
  return `${signed && percent > 0 ? "+" : ""}${percent.toFixed(2)}%`;
}

function money(value: number | undefined, currency: "KRW" | "USD"): string {
  return Number.isFinite(value) ? formatMoney(value as number, currency) : "unavailable";
}

function marketLabel(value?: AiSimulationMarketCountry): string {
  return value === "US" ? "미국" : value === "KR" ? "국내" : "시장 unavailable";
}

function statusLabel(value: string): string {
  return STATUS_LABELS[value] ?? value;
}

function presetLabel(value?: AiSimulationPreset): string {
  return value ? PRESET_LABELS[value] : "프리셋 unavailable";
}

function selectionLabel(value?: AiSimulationSelectionRequest): string {
  if (!value) return "선정 방식 unavailable";
  if (value.mode === "manual") return `직접 선택 · ${value.symbols.length}종목`;
  const criterion = value.criterion === "trading_amount"
    ? "거래대금"
    : value.criterion === "volume"
      ? "거래량"
      : "변동성";
  return `${criterion} 자동 선정 · ${value.symbolCount}종목`;
}

function statusClass(status: string): string {
  if (status === "completed") return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  if (status === "failed") return "bg-rose-500/10 text-rose-700 dark:text-rose-300";
  if (status === "cancelled") return "bg-amber-500/10 text-amber-700 dark:text-amber-300";
  return "bg-primary/10 text-primary";
}

function returnClass(value?: number): string {
  if (!Number.isFinite(value) || value === 0) return "text-foreground";
  return (value as number) > 0
    ? "text-emerald-700 dark:text-emerald-300"
    : "text-rose-700 dark:text-rose-300";
}

function ReportMetric({
  label,
  value,
  className,
}: {
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div className="min-w-0 rounded-2xl bg-secondary p-3">
      <dt className="text-[9px] font-black tracking-[0.08em] text-muted-foreground">{label}</dt>
      <dd className={cn("mt-2 truncate text-sm font-black", className)} title={value}>{value}</dd>
    </div>
  );
}

export function SimulationRunHistoryList({
  items,
  selectedRunId,
  onSelect,
}: {
  items: AiSimulationHistoryItem[];
  selectedRunId?: string;
  onSelect: (runId: string) => void;
}) {
  return (
    <div
      className="max-h-[36rem] min-h-0 space-y-2 overflow-y-auto overscroll-contain pr-1"
      data-simulation-history-scroll
      aria-label="시뮬레이션 실행 기록"
      tabIndex={0}
    >
      {items.length ? items.map((item) => {
        const symbols = item.selected.map(({ name, symbol }) => name || symbol).join(", ");
        const selected = item.runId === selectedRunId;
        return (
          <button
            key={item.runId}
            type="button"
            className={cn(
              "w-full rounded-2xl border p-4 text-left transition-colors",
              selected
                ? "border-primary bg-primary/5"
                : "border-transparent bg-secondary hover:border-border hover:bg-secondary/70",
            )}
            aria-pressed={selected}
            aria-label={`${timestamp(item.startedAt)} ${marketLabel(item.marketCountry)} 시뮬레이션 결과 보고서 열기`}
            data-simulation-history-item={item.runId}
            onClick={() => onSelect(item.runId)}
          >
            <div className="flex min-w-0 items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs font-black">{timestamp(item.startedAt)}</p>
                <p className="mt-1 truncate text-[9px] text-muted-foreground">
                  {marketLabel(item.marketCountry)} · {presetLabel(item.preset)} · {selectionLabel(item.selection)}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span className={cn("rounded-full px-2 py-1 text-[8px] font-black", statusClass(item.status))}>
                  {statusLabel(item.status)}
                </span>
                <ChevronRight className="size-3.5 text-muted-foreground" aria-hidden="true" />
              </div>
            </div>
            {symbols ? <p className="mt-3 truncate text-[10px] font-black" title={symbols}>{symbols}</p> : null}
            <dl className="mt-3 grid grid-cols-3 gap-2">
              <div>
                <dt className="text-[8px] font-black text-muted-foreground">최종 자산</dt>
                <dd className="mt-1 truncate text-[10px] font-black">{money(item.finalEquity, item.currency)}</dd>
              </div>
              <div>
                <dt className="text-[8px] font-black text-muted-foreground">수익률</dt>
                <dd className={cn("mt-1 text-[10px] font-black", returnClass(item.returnRatio))}>
                  {ratio(item.returnRatio, true)}
                </dd>
              </div>
              <div>
                <dt className="text-[8px] font-black text-muted-foreground">판단 / 체결</dt>
                <dd className="mt-1 text-[10px] font-black">
                  {item.decisionCount ?? "–"} / {item.tradeCount ?? "–"}
                </dd>
              </div>
            </dl>
          </button>
        );
      }) : (
        <div className="grid min-h-40 place-items-center rounded-2xl bg-secondary p-5 text-center">
          <div>
            <History className="mx-auto size-5 text-muted-foreground" aria-hidden="true" />
            <p className="mt-3 text-xs font-black">저장된 시뮬레이션 기록이 없습니다.</p>
            <p className="mt-1 text-[9px] leading-4 text-muted-foreground">시뮬레이션을 실행하면 결과가 여기에 누적됩니다.</p>
          </div>
        </div>
      )}
    </div>
  );
}

function DecisionList({
  decisions,
}: {
  decisions: AiSimulationDecision[];
}) {
  return (
    <section className="min-w-0 rounded-2xl bg-secondary p-4" data-simulation-report-decisions>
      <div className="flex items-center justify-between gap-2">
        <h4 className="flex items-center gap-2 text-xs font-black"><ListChecks className="size-3.5" />AI 판단</h4>
        <span className="text-[9px] font-black text-muted-foreground">{decisions.length}건</span>
      </div>
      <div className="mt-3 max-h-72 min-h-0 space-y-2 overflow-y-auto overscroll-contain pr-1" tabIndex={0}>
        {decisions.length ? [...decisions].reverse().map((decision, index) => (
          <article key={`${decision.symbol}:${decision.decidedAt}:${index}`} className="rounded-xl bg-card p-3">
            <div className="flex flex-wrap justify-between gap-2">
              <p className="text-[10px] font-black">
                {decision.symbol} · {ACTION_LABELS[decision.action.toLowerCase()] ?? decision.action}
              </p>
              <time className="text-[8px] text-muted-foreground">{timestamp(decision.decidedAt)}</time>
            </div>
            <p className="mt-2 break-words text-[9px] leading-4">{decision.reason}</p>
            <p className="mt-2 text-[8px] text-muted-foreground">
              상승 {ratio(decision.upProbability)} · score {Number.isFinite(decision.score) ? decision.score?.toFixed(3) : "unavailable"}
            </p>
          </article>
        )) : <p className="text-[9px] text-muted-foreground">저장된 판단이 없습니다.</p>}
      </div>
    </section>
  );
}

function TradeList({
  trades,
  currency,
}: {
  trades: AiSimulationTrade[];
  currency: "KRW" | "USD";
}) {
  return (
    <section className="min-w-0 rounded-2xl bg-secondary p-4" data-simulation-report-trades>
      <div className="flex items-center justify-between gap-2">
        <h4 className="flex items-center gap-2 text-xs font-black"><ReceiptText className="size-3.5" />가상 체결</h4>
        <span className="text-[9px] font-black text-muted-foreground">{trades.length}건</span>
      </div>
      <div className="mt-3 max-h-72 min-h-0 space-y-2 overflow-y-auto overscroll-contain pr-1" tabIndex={0}>
        {trades.length ? [...trades].reverse().map((trade, index) => (
          <article key={`${trade.symbol}:${trade.executedAt}:${index}`} className="rounded-xl bg-card p-3">
            <div className="flex flex-wrap justify-between gap-2">
              <p className="text-[10px] font-black">
                {trade.symbol} · {trade.side.toLowerCase() === "buy" ? "가상 매수" : trade.side.toLowerCase() === "sell" ? "가상 매도" : trade.side}
              </p>
              <time className="text-[8px] text-muted-foreground">{timestamp(trade.executedAt)}</time>
            </div>
            <p className="mt-2 text-[9px]">
              {formatQuantity(trade.quantity)}주 × {formatMoney(trade.price, currency)}
            </p>
            <p className="mt-1 text-[8px] text-muted-foreground">
              체결액 {formatMoney(trade.amount, currency)} · 비용 {formatMoney(trade.cost, currency)}
            </p>
          </article>
        )) : <p className="text-[9px] text-muted-foreground">저장된 가상 체결이 없습니다.</p>}
      </div>
    </section>
  );
}

export function SimulationRunReportView({
  report,
}: {
  report: AiSimulationRunReport;
}) {
  const { performance, configuration } = report;
  const selectedSymbols = report.selected.map(({ name, symbol }) => name ? `${name} · ${symbol}` : symbol);
  const costs = configuration.costs
    ? Object.entries(configuration.costs).map(([key, value]) => `${key} ${value}bps`)
    : [];

  return (
    <div className="min-w-0 space-y-3" data-simulation-report={report.runId}>
      <section className="overflow-hidden rounded-2xl bg-primary p-5 text-primary-foreground">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-primary-foreground/10 px-2.5 py-1 text-[9px] font-black">
                {statusLabel(report.status)}
              </span>
              <span className="truncate text-[9px] text-primary-foreground/60">run {report.runId}</span>
            </div>
            <p className="mt-4 text-[9px] font-black tracking-[0.12em] text-primary-foreground/60">FINAL RESULT</p>
            <p className="mt-1 text-3xl font-black tracking-[-0.05em]">
              {money(performance.finalEquity, performance.currency)}
            </p>
            <p className="mt-2 text-sm font-black">
              {money(performance.pnl, performance.currency)} · {ratio(performance.returnRatio, true)}
            </p>
          </div>
          <dl className="grid grid-cols-2 gap-2 text-[9px] sm:min-w-64">
            <div className="rounded-xl bg-primary-foreground/10 p-3">
              <dt className="text-primary-foreground/50">시작</dt>
              <dd className="mt-1 font-black">{timestamp(report.startedAt)}</dd>
            </div>
            <div className="rounded-xl bg-primary-foreground/10 p-3">
              <dt className="text-primary-foreground/50">종료</dt>
              <dd className="mt-1 font-black">{timestamp(report.finishedAt)}</dd>
            </div>
          </dl>
        </div>
      </section>

      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <ReportMetric label="실현 손익" value={money(performance.realizedPnl, performance.currency)} />
        <ReportMetric label="미실현 손익" value={money(performance.unrealizedPnl, performance.currency)} />
        <ReportMetric label="총 비용" value={money(performance.totalCosts, performance.currency)} />
        <ReportMetric
          label="판단 / 체결"
          value={`${performance.decisionCount ?? report.decisions.length} / ${performance.tradeCount ?? report.trades.length}`}
        />
      </dl>

      <section className="rounded-2xl bg-secondary p-4" aria-labelledby={`configuration-${report.runId}`}>
        <div className="flex items-center gap-2">
          <FileText className="size-4" aria-hidden="true" />
          <h3 id={`configuration-${report.runId}`} className="text-sm font-black">실행 설정</h3>
        </div>
        <dl className="mt-3 grid gap-2 text-[10px] sm:grid-cols-2 xl:grid-cols-3">
          <div className="rounded-xl bg-card p-3"><dt className="text-muted-foreground">시장</dt><dd className="mt-1 font-black">{marketLabel(configuration.marketCountry)}</dd></div>
          <div className="rounded-xl bg-card p-3"><dt className="text-muted-foreground">프리셋</dt><dd className="mt-1 font-black">{presetLabel(configuration.preset)}</dd></div>
          <div className="rounded-xl bg-card p-3"><dt className="text-muted-foreground">공격·방어</dt><dd className="mt-1 font-black">{configuration.riskTolerance ?? "unavailable"}</dd></div>
          <div className="rounded-xl bg-card p-3"><dt className="text-muted-foreground">종목 선정</dt><dd className="mt-1 font-black">{selectionLabel(configuration.selection)}</dd></div>
          <div className="rounded-xl bg-card p-3"><dt className="text-muted-foreground">시작 예수금</dt><dd className="mt-1 font-black">{money(configuration.initialCash, performance.currency)}</dd></div>
          <div className="rounded-xl bg-card p-3"><dt className="text-muted-foreground">기간</dt><dd className="mt-1 font-black">{configuration.durationMinutes === undefined ? "unavailable" : `${configuration.durationMinutes}분`}</dd></div>
        </dl>
        {costs.length ? <p className="mt-3 break-words text-[9px] leading-4 text-muted-foreground">비용 가정 · {costs.join(" · ")}</p> : null}
      </section>

      <div className="grid gap-3 xl:grid-cols-2">
        <section className="rounded-2xl bg-secondary p-4" data-simulation-report-selection>
          <div className="flex items-center justify-between gap-2">
            <h3 className="flex items-center gap-2 text-sm font-black"><BarChart3 className="size-4" />선정 종목</h3>
            <span className="text-[9px] font-black text-muted-foreground">{report.selected.length}종목</span>
          </div>
          {report.selected.length ? (
            <div className="mt-3 space-y-2">
              {report.selected.map((item) => (
                <article key={item.symbol} className="rounded-xl bg-card p-3">
                  <p className="text-xs font-black">{item.name || item.symbol} <span className="text-[9px] text-muted-foreground">· {item.symbol}</span></p>
                  <p className="mt-2 text-[9px] text-muted-foreground">
                    상승 {ratio(item.upProbability)} · 중앙 수익률 {ratio(item.predictedMedianReturn, true)}
                  </p>
                  {item.currentPrice !== undefined ? (
                    <p className="mt-1 text-[9px] text-muted-foreground">
                      최근가 {formatMoney(item.currentPrice, performance.currency)} · {timestamp(item.priceObservedAt)}
                    </p>
                  ) : null}
                  {item.model ? <p className="mt-1 break-all text-[8px] text-muted-foreground">{item.model}</p> : null}
                </article>
              ))}
            </div>
          ) : <p className="mt-3 text-[9px] text-muted-foreground">저장된 선정 종목이 없습니다.</p>}
        </section>

        <section className="rounded-2xl bg-secondary p-4" data-simulation-report-models>
          <div className="flex items-center justify-between gap-2">
            <h3 className="flex items-center gap-2 text-sm font-black"><Cpu className="size-4" />AI 모델·판단 주기</h3>
            <span className="text-[9px] font-black text-muted-foreground">
              확정봉 {report.decisionCadence?.triggeredEvents ?? "–"}회
            </span>
          </div>
          <div className="mt-3 space-y-2">
            {report.modelProvenance.length ? report.modelProvenance.map((model) => (
              <p key={model} className="break-all rounded-xl bg-card p-3 text-[9px] font-black">{model}</p>
            )) : <p className="text-[9px] text-muted-foreground">모델 provenance가 저장되지 않았습니다.</p>}
          </div>
          <dl className="mt-3 grid grid-cols-2 gap-2 text-[9px]">
            <div className="rounded-xl bg-card p-3"><dt className="text-muted-foreground">트리거</dt><dd className="mt-1 break-words font-black">{report.decisionCadence?.trigger ?? "unavailable"}</dd></div>
            <div className="rounded-xl bg-card p-3"><dt className="text-muted-foreground">마지막 완료</dt><dd className="mt-1 font-black">{timestamp(report.decisionCadence?.lastFinishedAt)}</dd></div>
          </dl>
        </section>
      </div>

      {report.equity.length ? (
        <section className="rounded-2xl bg-secondary p-4" data-simulation-report-equity>
          <div className="flex items-center justify-between gap-2">
            <h3 className="flex items-center gap-2 text-sm font-black"><Activity className="size-4" />자산 추이</h3>
            <span className="text-[9px] font-black text-muted-foreground">{report.equity.length}개 기록</span>
          </div>
          <div className="mt-3 max-h-40 overflow-y-auto rounded-xl bg-card" tabIndex={0}>
            <table className="w-full text-left text-[9px]">
              <thead className="sticky top-0 bg-card">
                <tr className="text-muted-foreground"><th className="p-3 font-black">시각</th><th className="p-3 text-right font-black">자산</th><th className="p-3 text-right font-black">현금</th></tr>
              </thead>
              <tbody>
                {report.equity.map((point, index) => (
                  <tr key={`${point.timestamp}:${index}`} className="border-t border-border/50">
                    <td className="p-3">{timestamp(point.timestamp)}</td>
                    <td className="p-3 text-right font-black">{formatMoney(point.equity, performance.currency)}</td>
                    <td className="p-3 text-right">{money(point.cash, performance.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {report.charts.length ? (
        <section className="space-y-3" data-simulation-report-charts aria-label="시뮬레이션 차트 근거">
          <div className="flex items-center justify-between px-1">
            <h3 className="text-sm font-black">캔들·지표·패턴 근거</h3>
            <span className="text-[9px] text-muted-foreground">{report.charts.length}종목</span>
          </div>
          <div className="grid gap-3 xl:grid-cols-2">
            {report.charts.map((chart) => (
              <AiSimulationChart
                key={chart.symbol}
                symbol={chart.symbol}
                name={chart.name}
                currency={chart.currency}
                bars={chart.bars}
                indicators={chart.indicators}
                patterns={chart.patterns}
                updatedAt={chart.updatedAt}
                trades={report.trades.flatMap((trade) => {
                  const side = trade.side.toLowerCase();
                  if (trade.symbol !== chart.symbol || (side !== "buy" && side !== "sell")) return [];
                  return [{
                    executedAt: trade.executedAt,
                    price: trade.price,
                    quantity: trade.quantity,
                    side,
                  }];
                })}
              />
            ))}
          </div>
        </section>
      ) : null}

      <div className="grid gap-3 xl:grid-cols-2">
        <DecisionList decisions={report.decisions} />
        <TradeList trades={report.trades} currency={performance.currency} />
      </div>

      {report.positions.length ? (
        <section className="rounded-2xl bg-secondary p-4" data-simulation-report-positions>
          <h3 className="flex items-center gap-2 text-sm font-black"><Wallet className="size-4" />종료 시 가상 포지션</h3>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {report.positions.map((position) => (
              <article key={position.symbol} className="rounded-xl bg-card p-3 text-[9px]">
                <p className="font-black">{position.symbol} · {formatQuantity(position.quantity)}주</p>
                <p className="mt-1 text-muted-foreground">
                  평균 {formatMoney(position.averagePrice, performance.currency)} · 평가손익 {money(position.unrealizedPnl, performance.currency)}
                </p>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      {report.evidence.length || report.warnings.length || report.limits.length ? (
        <section className="rounded-2xl bg-secondary p-4" data-simulation-report-evidence>
          <h3 className="flex items-center gap-2 text-sm font-black"><AlertTriangle className="size-4" />근거·제약·경고</h3>
          {report.evidence.length ? (
            <dl className="mt-3 grid gap-2 sm:grid-cols-2">
              {report.evidence.map((item, index) => (
                <div key={`${item.label}:${index}`} className="rounded-xl bg-card p-3 text-[9px]">
                  <dt className="font-black">{item.label}</dt>
                  {item.value ? <dd className="mt-1 break-words text-muted-foreground">{item.value}</dd> : null}
                </div>
              ))}
            </dl>
          ) : null}
          {report.warnings.length || report.limits.length ? (
            <ul className="mt-3 list-disc space-y-1 pl-5 text-[9px] leading-4 text-muted-foreground">
              {[...report.warnings, ...report.limits].map((item, index) => <li key={`${item}:${index}`}>{item}</li>)}
            </ul>
          ) : null}
        </section>
      ) : null}

      {selectedSymbols.length ? (
        <p className="px-1 text-[8px] leading-4 text-muted-foreground">
          보고서 대상 · {selectedSymbols.join(", ")}
        </p>
      ) : null}
    </div>
  );
}

export function AiSimulationHistory({
  onUnauthorized,
  refreshKey,
}: AiSimulationHistoryProps) {
  const [items, setItems] = useState<AiSimulationHistoryItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [selectedRunId, setSelectedRunId] = useState<string>();
  const [report, setReport] = useState<AiSimulationRunReport>();
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [reportLoading, setReportLoading] = useState(false);
  const [error, setError] = useState("");
  const [reportError, setReportError] = useState("");

  const loadHistory = useCallback(async (cursor?: string) => {
    const append = Boolean(cursor);
    append ? setLoadingMore(true) : setLoading(true);
    setError("");
    try {
      const search = new URLSearchParams({ limit: "20" });
      if (cursor) search.set("cursor", cursor);
      const response = await fetch(`/api/portfolio/simulation/runs?${search.toString()}`, {
        headers: { Accept: "application/json" },
      });
      const payload = await readJson(response);
      if (response.status === 401) {
        onUnauthorized();
        return;
      }
      if (!response.ok) {
        throw new Error(aiSimulationErrorMessage(payload, "시뮬레이션 기록을 불러오지 못했습니다."));
      }
      const page = normalizeAiSimulationHistory(payload);
      setItems((current) => {
        const merged = append ? [...current, ...page.items] : page.items;
        return [...new Map(merged.map((item) => [item.runId, item])).values()];
      });
      setNextCursor(page.nextCursor);
      if (!append) {
        setSelectedRunId((current) => page.items.some(({ runId }) => runId === current)
          ? current
          : page.items[0]?.runId);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "시뮬레이션 기록을 불러오지 못했습니다.");
    } finally {
      append ? setLoadingMore(false) : setLoading(false);
    }
  }, [onUnauthorized]);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory, refreshKey]);

  useEffect(() => {
    if (!selectedRunId) {
      setReport(undefined);
      setReportError("");
      return;
    }
    const controller = new AbortController();
    const loadReport = async () => {
      setReportLoading(true);
      setReportError("");
      try {
        const base = `/api/portfolio/simulation/runs/${encodeURIComponent(selectedRunId)}`;
        let response = await fetch(`${base}/report`, {
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
        let payload = await readJson(response);
        if (response.status === 404 && !controller.signal.aborted) {
          response = await fetch(base, {
            headers: { Accept: "application/json" },
            signal: controller.signal,
          });
          payload = await readJson(response);
        }
        if (response.status === 401) {
          onUnauthorized();
          return;
        }
        if (!response.ok) {
          throw new Error(aiSimulationErrorMessage(payload, "시뮬레이션 결과 보고서를 불러오지 못했습니다."));
        }
        const next = normalizeAiSimulationReport(payload);
        if (!next) throw new Error("시뮬레이션 결과 보고서 형식을 확인하지 못했습니다.");
        if (!controller.signal.aborted) setReport(next);
      } catch (caught) {
        if (!controller.signal.aborted) {
          setReport(undefined);
          setReportError(caught instanceof Error ? caught.message : "시뮬레이션 결과 보고서를 불러오지 못했습니다.");
        }
      } finally {
        if (!controller.signal.aborted) setReportLoading(false);
      }
    };
    void loadReport();
    return () => controller.abort();
  }, [onUnauthorized, selectedRunId]);

  return (
    <Card className="min-w-0 bg-card p-5 sm:p-6" data-simulation-history>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-black tracking-[0.12em] text-muted-foreground">SIMULATION ARCHIVE</p>
          <h2 className="mt-1 text-lg font-black">시뮬레이션 기록·결과 보고서</h2>
          <p className="mt-1 text-[10px] leading-4 text-muted-foreground">
            실행별 설정, 선정 종목, AI 근거, 체결과 최종 손익을 다시 확인할 수 있습니다.
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={() => void loadHistory()}
          disabled={loading}
          aria-label="시뮬레이션 기록 새로고침"
        >
          <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
          새로고침
        </Button>
      </div>

      {error ? (
        <div className="mt-4 flex items-start gap-2 rounded-2xl bg-destructive/10 p-4 text-xs text-destructive" role="alert">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <p>{error}</p>
        </div>
      ) : null}

      <div className="mt-5 grid min-w-0 gap-4 lg:grid-cols-[minmax(18rem,0.72fr)_minmax(0,1.4fr)]">
        <aside className="min-w-0">
          {loading ? (
            <div className="grid min-h-40 place-items-center rounded-2xl bg-secondary" role="status">
              <div className="text-center">
                <LoaderCircle className="mx-auto size-5 animate-spin" />
                <p className="mt-2 text-[10px] font-black">실행 기록 불러오는 중</p>
              </div>
            </div>
          ) : (
            <SimulationRunHistoryList
              items={items}
              selectedRunId={selectedRunId}
              onSelect={setSelectedRunId}
            />
          )}
          {nextCursor ? (
            <Button
              type="button"
              className="mt-3 w-full"
              size="sm"
              variant="secondary"
              disabled={loadingMore}
              onClick={() => void loadHistory(nextCursor)}
            >
              {loadingMore ? <LoaderCircle className="animate-spin" /> : <Clock3 />}
              이전 기록 더 보기
            </Button>
          ) : null}
        </aside>

        <div className="min-w-0" aria-live="polite">
          {reportLoading ? (
            <div className="grid min-h-64 place-items-center rounded-2xl bg-secondary" role="status">
              <div className="text-center">
                <LoaderCircle className="mx-auto size-5 animate-spin" />
                <p className="mt-2 text-[10px] font-black">결과 보고서 불러오는 중</p>
              </div>
            </div>
          ) : reportError ? (
            <div className="grid min-h-64 place-items-center rounded-2xl bg-destructive/10 p-5 text-center text-destructive" role="alert">
              <div>
                <AlertTriangle className="mx-auto size-5" />
                <p className="mt-3 text-xs font-black">결과 보고서를 표시하지 못했습니다.</p>
                <p className="mt-1 text-[9px] leading-4">{reportError}</p>
              </div>
            </div>
          ) : report ? (
            <SimulationRunReportView report={report} />
          ) : (
            <div className="grid min-h-64 place-items-center rounded-2xl bg-secondary p-5 text-center">
              <div>
                <FileText className="mx-auto size-5 text-muted-foreground" />
                <p className="mt-3 text-xs font-black">확인할 실행을 선택하세요.</p>
                <p className="mt-1 text-[9px] text-muted-foreground">선택한 시뮬레이션의 결과 보고서가 여기에 표시됩니다.</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}
