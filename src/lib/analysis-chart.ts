import type { BenchmarkKey, PortfolioAnalysis } from "@/types";

export type AnalysisChartPoint = {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  normalizedOpen: number;
  normalizedHigh: number;
  normalizedLow: number;
  normalizedClose: number;
  candleRange: [number, number];
  benchmarkValues: Partial<Record<BenchmarkKey, number>>;
};

function round(value: number, digits = 4): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

export function buildAnalysisChartData(analysis: PortfolioAnalysis): AnalysisChartPoint[] {
  const sortedCandles = [...analysis.candles].sort((left, right) => left.date.localeCompare(right.date));
  const portfolioBase = sortedCandles[0]?.close ?? 0;
  const states = new Map(analysis.benchmarks.map((benchmark) => [benchmark.key, {
    points: [...benchmark.points].sort((left, right) => left.date.localeCompare(right.date)),
    index: 0,
    latest: undefined as number | undefined,
    base: undefined as number | undefined,
  }]));

  return sortedCandles
    .map((candle) => {
      const benchmarkValues: AnalysisChartPoint["benchmarkValues"] = {};
      for (const [key, state] of states) {
        while (state.index < state.points.length && state.points[state.index].date <= candle.date) {
          state.latest = state.points[state.index].close;
          state.index += 1;
        }
        if (state.latest === undefined) {
          state.latest = state.points.find((point) => point.close > 0)?.close;
        }
        if (state.base === undefined && state.latest && state.latest > 0) state.base = state.latest;
        if (state.latest !== undefined && state.base !== undefined && state.base > 0) {
          benchmarkValues[key] = round(((state.latest / state.base) - 1) * 100);
        }
      }
      const normalize = (value: number) => portfolioBase > 0
        ? round(((value / portfolioBase) - 1) * 100)
        : 0;
      const normalizedOpen = normalize(candle.open);
      const normalizedHigh = normalize(candle.high);
      const normalizedLow = normalize(candle.low);
      const normalizedClose = normalize(candle.close);
      return {
        ...candle,
        normalizedOpen,
        normalizedHigh,
        normalizedLow,
        normalizedClose,
        candleRange: [normalizedLow, normalizedHigh],
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

export function analysisComparisonDomain(
  points: AnalysisChartPoint[],
  selectedBenchmarks: ReadonlySet<BenchmarkKey>,
): [number, number] {
  const values = points.flatMap((point) => [
    point.normalizedLow,
    point.normalizedHigh,
    ...Array.from(selectedBenchmarks)
      .map((key) => point.benchmarkValues[key])
      .filter((value): value is number => value !== undefined),
  ]);
  if (!values.length) return [-1, 1];
  const minimum = Math.min(0, ...values);
  const maximum = Math.max(0, ...values);
  const padding = Math.max(0.5, (maximum - minimum) * 0.08);
  return [round(minimum - padding), round(maximum + padding)];
}
