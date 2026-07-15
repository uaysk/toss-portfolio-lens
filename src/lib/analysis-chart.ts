import type { BenchmarkKey, PortfolioAnalysis } from "@/types";

export type AnalysisChartPoint = {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  candleRange: [number, number];
  benchmarkValues: Partial<Record<BenchmarkKey, number>>;
};

function round(value: number, digits = 4): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

export function buildAnalysisChartData(analysis: PortfolioAnalysis): AnalysisChartPoint[] {
  const states = new Map(analysis.benchmarks.map((benchmark) => [benchmark.key, {
    points: [...benchmark.points].sort((left, right) => left.date.localeCompare(right.date)),
    index: 0,
    latest: undefined as number | undefined,
    base: undefined as number | undefined,
  }]));

  return [...analysis.candles]
    .sort((left, right) => left.date.localeCompare(right.date))
    .map((candle) => {
      const benchmarkValues: AnalysisChartPoint["benchmarkValues"] = {};
      for (const [key, state] of states) {
        while (state.index < state.points.length && state.points[state.index].date <= candle.date) {
          state.latest = state.points[state.index].close;
          state.index += 1;
        }
        if (state.base === undefined && state.latest && state.latest > 0) state.base = state.latest;
        if (state.latest !== undefined && state.base !== undefined && state.base > 0) {
          benchmarkValues[key] = round(((state.latest / state.base) - 1) * 100);
        }
      }
      return {
        ...candle,
        candleRange: [candle.low, candle.high],
        benchmarkValues,
      };
    });
}

export function analysisPeriodChange(points: AnalysisChartPoint[]): number {
  if (!points.length) return 0;
  const first = points[0].open;
  const last = points[points.length - 1].close;
  return first > 0 ? round(((last / first) - 1) * 100) : 0;
}
