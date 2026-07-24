import { AlertTriangle, CheckCircle2, GitCompareArrows } from "lucide-react";
import { Card } from "@/components/ui/card";
import type {
  AiSimulationCurrency,
  AiSimulationStrategyComparison,
  AiSimulationStrategyComparisonLane,
} from "@/lib/ai-simulation";
import { AI_SIMULATION_PAIR_CATALOG } from "@/lib/ai-simulation";
import { formatMoney } from "@/lib/format";
import { cn } from "@/lib/utils";

const LANE_LABELS: Record<AiSimulationStrategyComparisonLane["id"], string> = {
  kronos: "Kronos-base",
  rust: "Rust 기술 지표",
  ensemble: "최종 전략",
};

function ratio(value?: number, signed = false): string {
  if (!Number.isFinite(value)) return "unavailable";
  const percent = (value as number) * 100;
  return `${signed && percent > 0 ? "+" : ""}${percent.toFixed(2)}%`;
}

function decimal(value?: number): string {
  return Number.isFinite(value) ? (value as number).toFixed(3) : "unavailable";
}

function statusClass(status: string): string {
  const normalized = status.toLowerCase();
  if (["available", "complete", "completed", "ready", "running"].includes(normalized)) {
    return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  }
  if (["unavailable", "failed", "error"].includes(normalized)) {
    return "bg-rose-500/10 text-rose-700 dark:text-rose-300";
  }
  return "bg-amber-500/10 text-amber-700 dark:text-amber-300";
}

function returnClass(value?: number): string {
  if (!Number.isFinite(value) || value === 0) return "text-foreground";
  return (value as number) > 0
    ? "text-emerald-700 dark:text-emerald-300"
    : "text-rose-700 dark:text-rose-300";
}

function comparisonConditions(comparison: AiSimulationStrategyComparison) {
  return [
    { label: "동일 원천", passed: comparison.sameOrigin },
    { label: "동일 비용", passed: comparison.sameCosts },
    { label: "동일 체결 정책", passed: comparison.sameExecutionPolicy },
  ];
}

function LaneCard({
  lane,
  currency,
  compact,
}: {
  lane: AiSimulationStrategyComparisonLane;
  currency: AiSimulationCurrency;
  compact: boolean;
}) {
  return (
    <article
      className={cn("min-w-0 rounded-2xl bg-secondary", compact ? "p-3" : "p-4")}
      data-simulation-comparison-lane={lane.id}
      data-simulation-comparison-analytical-only={lane.analyticalOnly ?? "unknown"}
    >
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-1.5">
        <p className="text-[10px] font-black">{LANE_LABELS[lane.id]}</p>
        <div className="flex flex-wrap items-center justify-end gap-1">
          {lane.id === "ensemble" ? (
            <span className="rounded-full bg-primary px-2 py-1 text-[8px] font-black text-primary-foreground">
              forward 실행 정책
            </span>
          ) : null}
          <span className="rounded-full bg-sky-500/10 px-2 py-1 text-[8px] font-black text-sky-700 dark:text-sky-300">
            비교 성과 분석용
          </span>
          <span className={cn("rounded-full px-2 py-1 text-[8px] font-black", statusClass(lane.status))}>
            {lane.status}
          </span>
        </div>
      </div>
      <p className={cn(
        "mt-3 break-words font-black tracking-[-0.03em]",
        compact ? "text-sm" : "text-xl",
        returnClass(lane.cumulativeReturn),
      )}>
        {ratio(lane.cumulativeReturn, true)}
      </p>
      <p className="mt-1 text-[8px] font-black text-muted-foreground">누적 수익률</p>
      <p className="mt-2 break-words text-[8px] font-black text-muted-foreground">
        bull {lane.bullCount ?? "–"} · bear {lane.bearCount ?? "–"} · cash {lane.cashCount ?? "–"}
      </p>
      {lane.unavailableReason ? (
        <p className="mt-2 break-words rounded-xl bg-card p-2 text-[8px] leading-4 text-muted-foreground">
          {lane.unavailableReason}
        </p>
      ) : null}

      {!compact ? (
        <>
          <dl className="mt-3 grid grid-cols-2 gap-2 text-[8px]">
            <div><dt className="text-muted-foreground">순수익률</dt><dd className="mt-1 font-black">{ratio(lane.netReturn, true)}</dd></div>
            <div><dt className="text-muted-foreground">최대 낙폭</dt><dd className="mt-1 font-black">{ratio(lane.maxDrawdown)}</dd></div>
            <div><dt className="text-muted-foreground">위험조정</dt><dd className="mt-1 font-black">{decimal(lane.riskAdjustedReturn)}</dd></div>
            <div><dt className="text-muted-foreground">체결 / 전환</dt><dd className="mt-1 font-black">{lane.trades ?? "–"} / {lane.switches ?? "–"}</dd></div>
            <div><dt className="text-muted-foreground">총 비용</dt><dd className="mt-1 break-words font-black">{Number.isFinite(lane.costs) ? formatMoney(lane.costs as number, currency) : "unavailable"}</dd></div>
            <div><dt className="text-muted-foreground">순손익</dt><dd className="mt-1 break-words font-black">{Number.isFinite(lane.netProfit) ? formatMoney(lane.netProfit as number, currency) : "unavailable"}</dd></div>
            <div><dt className="text-muted-foreground">방향 정확도</dt><dd className="mt-1 font-black">{ratio(lane.directionAccuracy)}</dd></div>
            <div><dt className="text-muted-foreground">체결 정확도</dt><dd className="mt-1 font-black">{ratio(lane.executionAccuracy)}</dd></div>
            <div><dt className="text-muted-foreground">calibration</dt><dd className="mt-1 font-black">{decimal(lane.calibration)}</dd></div>
            <div><dt className="text-muted-foreground">unavailable</dt><dd className="mt-1 font-black">{ratio(lane.unavailableRatio)}</dd></div>
            <div><dt className="text-muted-foreground">calibration 없음</dt><dd className="mt-1 font-black">{ratio(lane.calibrationUnavailableRatio)}</dd></div>
            <div><dt className="text-muted-foreground">평균 지연</dt><dd className="mt-1 font-black">{Number.isFinite(lane.latencyMs) ? `${(lane.latencyMs as number).toFixed(0)}ms` : "unavailable"}</dd></div>
          </dl>
          <details className="mt-3 rounded-xl bg-card p-3" data-simulation-comparison-reasons={lane.id}>
            <summary className="cursor-pointer text-[9px] font-black">
              판단 근거 {lane.decisionReasons.length}건
            </summary>
            {lane.decisionReasons.length ? (
              <div className="mt-3 max-h-64 space-y-2 overflow-y-auto overscroll-contain pr-1">
                {lane.decisionReasons.map((decision, index) => (
                  <article
                    key={`${decision.decidedAt ?? "unknown"}:${decision.symbol ?? decision.signalSymbol ?? "unknown"}:${index}`}
                    className="rounded-xl bg-secondary p-3"
                  >
                    {decision.symbol || decision.signalSymbol || decision.executionSymbol || decision.action ? (
                      <p className="break-words text-[8px] font-black">
                        {[decision.symbol, decision.signalSymbol && decision.executionSymbol
                          ? `${decision.signalSymbol} → ${decision.executionSymbol}`
                          : decision.signalSymbol ?? decision.executionSymbol, decision.action]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                    ) : null}
                    <ul className="mt-1 space-y-1 text-[8px] leading-4 text-muted-foreground">
                      {decision.reasons.map((reason, reasonIndex) => (
                        <li key={`${reason}:${reasonIndex}`} className="break-words">{reason}</li>
                      ))}
                    </ul>
                  </article>
                ))}
              </div>
            ) : (
              <p className="mt-2 text-[8px] leading-4 text-muted-foreground">저장된 판단 근거가 없습니다.</p>
            )}
          </details>
        </>
      ) : null}
    </article>
  );
}

export function AiSimulationComparisonPanel({
  comparison,
  currency,
  compact = false,
}: {
  comparison: AiSimulationStrategyComparison;
  currency: AiSimulationCurrency;
  compact?: boolean;
}) {
  const conditions = comparisonConditions(comparison);
  const pairLabel = comparison.pairId
    ? AI_SIMULATION_PAIR_CATALOG.find(({ id }) => id === comparison.pairId)?.label ?? comparison.pairId
    : undefined;
  const content = (
    <>
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-[10px] font-black">
            <GitCompareArrows className="size-3.5 shrink-0" aria-hidden="true" />
            동일 조건 3전략 비교
          </p>
          {!compact || pairLabel ? (
            <p className="mt-1 break-words text-[8px] text-muted-foreground">
              {!compact ? `condition ${comparison.conditionId}` : ""}
              {!compact && pairLabel ? " · " : ""}
              {pairLabel}
            </p>
          ) : null}
        </div>
        {comparison.incompleteCount > 0 ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-1 text-[8px] font-black text-amber-700 dark:text-amber-300">
            <AlertTriangle className="size-3" aria-hidden="true" />
            미완료 {comparison.incompleteCount}
          </span>
        ) : null}
      </div>
      {!compact ? (
        <div className="mt-3 flex flex-wrap gap-1.5" aria-label="비교 동일 조건 확인">
          {conditions.map(({ label, passed }) => (
            <span
              key={label}
              className={cn(
                "inline-flex items-center gap-1 rounded-full px-2 py-1 text-[8px] font-black",
                passed
                  ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                  : "bg-rose-500/10 text-rose-700 dark:text-rose-300",
              )}
            >
              {passed ? <CheckCircle2 className="size-3" aria-hidden="true" /> : <AlertTriangle className="size-3" aria-hidden="true" />}
              {label}
            </span>
          ))}
        </div>
      ) : null}
      <p
        className={cn(
          "break-words text-[8px] leading-4 text-muted-foreground",
          compact ? "mt-2" : "mt-3",
        )}
        data-simulation-comparison-analytical-disclosure
      >
        모든 lane의 비교 성과는 분석·검증용이며, 실제 가상 원장은 Kronos-base와 Rust를 결합한 최종 전략만 사용합니다.
      </p>
      <div className={cn("grid grid-cols-1 gap-2 sm:grid-cols-3", compact ? "mt-2" : "mt-4")}>
        {comparison.lanes.map((lane) => (
          <LaneCard key={lane.id} lane={lane} currency={currency} compact={compact} />
        ))}
      </div>
    </>
  );

  if (compact) {
    return (
      <div className="mt-3 min-w-0" data-simulation-strategy-comparison={comparison.conditionId}>
        {content}
      </div>
    );
  }
  return (
    <Card className="min-w-0 bg-card p-5 sm:p-6" data-simulation-strategy-comparison={comparison.conditionId}>
      {content}
    </Card>
  );
}
