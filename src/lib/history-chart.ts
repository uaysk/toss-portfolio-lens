import type { BackfillStatus, PortfolioHistory } from "@/types";

export type ValueChartPoint = {
  date: string;
  totalValue: number;
  [key: string]: string | number;
};

export const HISTORY_BACKFILL_RUNNING_POLL_MS = 2_000;
export const HISTORY_BACKFILL_IDLE_POLL_MS = 5_000;
export const HISTORY_BACKFILL_MAX_RETRY_MS = 30_000;

function round(value: number, digits = 6): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

export function shouldPollPortfolioHistoryBackfill(
  status: BackfillStatus["status"],
  visibilityState: DocumentVisibilityState = "visible",
): boolean {
  return visibilityState === "visible" && (status === "idle" || status === "running");
}

export function portfolioHistoryBackfillPollDelay(
  status: BackfillStatus["status"],
): number | undefined {
  if (status === "running") return HISTORY_BACKFILL_RUNNING_POLL_MS;
  if (status === "idle") return HISTORY_BACKFILL_IDLE_POLL_MS;
  return undefined;
}

export function portfolioHistoryBackfillRetryDelay(consecutiveFailures: number): number {
  const exponent = Math.max(0, Math.trunc(consecutiveFailures) - 1);
  return Math.min(
    HISTORY_BACKFILL_MAX_RETRY_MS,
    HISTORY_BACKFILL_IDLE_POLL_MS * (2 ** exponent),
  );
}

export function filterPortfolioHistory(
  history: PortfolioHistory,
  hiddenStockKeys: ReadonlySet<string>,
): PortfolioHistory {
  if (!hiddenStockKeys.size) return history;
  const visibleSeries = history.series.filter((series) => !hiddenStockKeys.has(series.key));
  const weightSums = new Map(visibleSeries.map((series) => [series.key, 0]));
  const points = history.points.map((point) => {
    const visibleWeight = visibleSeries.reduce(
      (sum, series) => sum + (point.values[series.key] ?? 0),
      0,
    );
    const values: Record<string, number> = {};
    for (const series of visibleSeries) {
      const normalizedWeight = visibleWeight > 0
        ? ((point.values[series.key] ?? 0) / visibleWeight) * 100
        : 0;
      values[series.key] = round(normalizedWeight);
      weightSums.set(series.key, (weightSums.get(series.key) ?? 0) + normalizedWeight);
    }
    return {
      ...point,
      totalValue: round(point.totalValue * (visibleWeight / 100), 4),
      values,
    };
  });
  const pointCount = Math.max(points.length, 1);
  return {
    ...history,
    series: visibleSeries.map((series) => ({
      ...series,
      averageWeight: round((weightSums.get(series.key) ?? 0) / pointCount, 3),
    })),
    points,
  };
}

export function buildValueChartData(history: PortfolioHistory): ValueChartPoint[] {
  return history.points.map((point) => {
    const row: ValueChartPoint = {
      date: point.date,
      totalValue: point.totalValue,
    };
    history.series.forEach((series, index) => {
      const weight = point.values[series.key] ?? 0;
      row[`series${index}`] = point.totalValue * (weight / 100);
    });
    return row;
  });
}
