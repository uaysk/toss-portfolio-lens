export type DateValuePoint = { date: string; value: number };

export type PriceSeriesInput = {
  key: string;
  label: string;
  points: readonly DateValuePoint[];
};

export type ReturnSeriesInput = PriceSeriesInput;

export type AlignmentQuality = {
  requestedPoints: Record<string, number>;
  keptPoints: Record<string, number>;
  removedInvalidDate: number;
  removedNonFinite: number;
  removedNonPositive: number;
  removedDuplicateDates: number;
  warnings: string[];
};

export type AlignedSeries = {
  keys: string[];
  dates: string[];
  byKey: Record<string, number[]>;
  labels: Record<string, string>;
  quality: AlignmentQuality;
};

export type ReturnAnalysisOptions = {
  annualization?: number;
  confidence?: number;
  riskFreeRatePercent?: number;
  minimumObservations?: number;
};

export type CorrelationMatrix = {
  keys: string[];
  correlation: Array<Array<number | null>>;
  observations: number[][];
};

export type MonthlySummary = {
  month: string;
  count: number;
  cumulativeReturn: number | null;
  annualizedVolatility: number | null;
  sharpeRatio: number | null;
};

export type AnnualSummary = {
  year: string;
  count: number;
  cumulativeReturn: number | null;
  annualizedReturn: number | null;
  annualizedVolatility: number | null;
  sharpeRatio: number | null;
};

export type ReturnSeriesAnalysis = {
  key: string;
  label: string;
  observations: number;
  sampleStart: string | null;
  sampleEnd: string | null;
  frequencyPerYear: number | null;
  cumulativeReturn: number | null;
  cagr: number | null;
  annualizedVolatility: number | null;
  sharpeRatio: number | null;
  sortinoRatio: number | null;
  calmarRatio: number | null;
  maxDrawdown: number | null;
  currentDrawdown: number | null;
  maxDrawdownRecoveryDays: number | null;
  ulcerIndex: number | null;
  valueAtRisk95: number | null;
  conditionalValueAtRisk95: number | null;
  skewness: number | null;
  excessKurtosis: number | null;
  rollingPerformance: Array<{ window: number; return: number | null; volatility: number | null }>;
  monthlySummary: MonthlySummary[];
  annualSummary: AnnualSummary[];
  warnings: string[];
};

export type PairedReturnAnalysis = {
  leftKey: string;
  rightKey: string;
  observations: number;
  sampleStart: string | null;
  sampleEnd: string | null;
  frequencyPerYear: number | null;
  pearsonCorrelation: number | null;
  spearmanCorrelation: number | null;
  covariance: number | null;
  beta: number | null;
  rSquared: number | null;
  trackingError: number | null;
  informationRatio: number | null;
  jensenAlpha: number | null;
  upCorrelation: number | null;
  downCorrelation: number | null;
  upCapture: number | null;
  downCapture: number | null;
  warnings: string[];
};

export type DeterministicRng = {
  next: () => number;
  nextInt: (maxExclusive: number) => number;
  nextFloat: (min: number, max: number) => number;
};

export type RollingCorrelationPoint = { date: string; value: number | null };

const DAY_MS = 86_400_000;
const DEFAULT_ANNUALIZATION = 252;

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function safe(value: number | null | undefined): number | null {
  return finite(value) ? value : null;
}

function mean(values: readonly number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function sampleVariance(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const average = mean(values);
  return values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1);
}

function standardDeviation(values: readonly number[]): number {
  return Math.sqrt(sampleVariance(values));
}

function covariance(left: readonly number[], right: readonly number[]): number | null {
  if (left.length !== right.length || left.length < 2) return null;
  const leftMean = mean(left);
  const rightMean = mean(right);
  return left.reduce((sum, value, index) => sum + (value - leftMean) * (right[index] - rightMean), 0)
    / (left.length - 1);
}

function pearson(left: readonly number[], right: readonly number[]): number | null {
  const cov = covariance(left, right);
  const denominator = standardDeviation(left) * standardDeviation(right);
  return cov !== null && denominator > 0 ? Math.max(-1, Math.min(1, cov / denominator)) : null;
}

function ranks(values: readonly number[]): number[] {
  const sorted = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value || a.index - b.index);
  const result = Array(values.length).fill(0) as number[];
  let index = 0;
  while (index < sorted.length) {
    let end = index + 1;
    while (end < sorted.length && sorted[end].value === sorted[index].value) end += 1;
    const rank = (index + 1 + end) / 2;
    for (let cursor = index; cursor < end; cursor += 1) result[sorted[cursor].index] = rank;
    index = end;
  }
  return result;
}

function spearman(left: readonly number[], right: readonly number[]): number | null {
  return left.length === right.length && left.length >= 2 ? pearson(ranks(left), ranks(right)) : null;
}

function compounded(values: readonly number[]): number | null {
  if (!values.length) return null;
  const growth = values.reduce((current, value) => current * (1 + value), 1);
  return growth > 0 && finite(growth) ? growth - 1 : null;
}

function quantile(values: readonly number[], probability: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = Math.max(0, Math.min(sorted.length - 1, (sorted.length - 1) * probability));
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function sanitize(
  points: readonly DateValuePoint[],
  positiveOnly: boolean,
): { points: DateValuePoint[]; invalidDate: number; nonFinite: number; nonPositive: number; duplicates: number } {
  const byDate = new Map<string, number>();
  let invalidDate = 0;
  let nonFinite = 0;
  let nonPositive = 0;
  let duplicates = 0;
  for (const point of points) {
    if (!validDate(point.date)) {
      invalidDate += 1;
      continue;
    }
    if (!finite(point.value)) {
      nonFinite += 1;
      continue;
    }
    if (positiveOnly && point.value <= 0) {
      nonPositive += 1;
      continue;
    }
    if (byDate.has(point.date)) duplicates += 1;
    byDate.set(point.date, point.value);
  }
  return {
    points: Array.from(byDate, ([date, value]) => ({ date, value })).sort((a, b) => a.date.localeCompare(b.date)),
    invalidDate,
    nonFinite,
    nonPositive,
    duplicates,
  };
}

function annualization(options: ReturnAnalysisOptions): number {
  const value = options.annualization ?? DEFAULT_ANNUALIZATION;
  return finite(value) && value >= 1 && value <= 366 ? value : DEFAULT_ANNUALIZATION;
}

function bucket<T extends { date: string }>(points: readonly T[], size: number): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const point of points) {
    const key = point.date.slice(0, size);
    const values = result.get(key) ?? [];
    values.push(point);
    result.set(key, values);
  }
  return result;
}

function basicMetrics(values: readonly number[], annual: number, riskFreePercent: number) {
  const cumulative = compounded(values);
  const volatility = values.length >= 2 ? standardDeviation(values) * Math.sqrt(annual) : null;
  const riskFreePeriod = (1 + riskFreePercent / 100) ** (1 / annual) - 1;
  const excess = values.map((value) => value - riskFreePeriod);
  const deviation = standardDeviation(values);
  const downsideDeviation = values.length
    ? Math.sqrt(values.reduce((sum, value) => sum + Math.min(value - riskFreePeriod, 0) ** 2, 0) / values.length)
    : 0;
  return {
    cumulative,
    volatility,
    sharpe: deviation > 0 ? mean(excess) / deviation * Math.sqrt(annual) : null,
    sortino: downsideDeviation > 0 ? mean(excess) / downsideDeviation * Math.sqrt(annual) : null,
  };
}

function drawdownMetrics(points: readonly DateValuePoint[]) {
  let growth = 1;
  let peak = 1;
  let peakDate = points[0]?.date ?? "";
  let maxDrawdown = 0;
  let currentDrawdown = 0;
  let maxRecoveryDays = 0;
  const drawdowns: number[] = [];
  for (const point of points) {
    growth *= 1 + point.value;
    if (growth >= peak) {
      if (peakDate && point.date > peakDate) {
        maxRecoveryDays = Math.max(maxRecoveryDays, Math.round((Date.parse(`${point.date}T00:00:00Z`) - Date.parse(`${peakDate}T00:00:00Z`)) / DAY_MS));
      }
      peak = growth;
      peakDate = point.date;
    }
    currentDrawdown = peak > 0 ? growth / peak - 1 : 0;
    maxDrawdown = Math.min(maxDrawdown, currentDrawdown);
    drawdowns.push(currentDrawdown);
  }
  if (currentDrawdown < 0 && peakDate && points.length) {
    maxRecoveryDays = Math.max(maxRecoveryDays, Math.round((Date.parse(`${points.at(-1)!.date}T00:00:00Z`) - Date.parse(`${peakDate}T00:00:00Z`)) / DAY_MS));
  }
  return {
    maxDrawdown,
    currentDrawdown,
    maxRecoveryDays: points.length ? maxRecoveryDays : null,
    ulcer: drawdowns.length ? Math.sqrt(mean(drawdowns.map((value) => value ** 2))) : null,
  };
}

function summarize(
  key: string,
  label: string,
  points: readonly DateValuePoint[],
  options: ReturnAnalysisOptions,
  inheritedWarnings: string[],
): ReturnSeriesAnalysis {
  const annual = annualization(options);
  const riskFree = finite(options.riskFreeRatePercent) ? options.riskFreeRatePercent! : 0;
  const minimum = Math.max(1, Math.floor(options.minimumObservations ?? 2));
  const warnings = [...inheritedWarnings];
  if (points.length < minimum) warnings.push(`최소 관측 수 ${minimum}개보다 표본이 적습니다.`);
  const values = points.map((point) => point.value);
  const basic = basicMetrics(values, annual, riskFree);
  const first = points[0]?.date;
  const last = points.at(-1)?.date;
  const elapsedYears = first && last
    ? Math.max(1 / annual, ((Date.parse(`${last}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / DAY_MS + 365.25 / annual) / 365.25)
    : 0;
  const cagr = basic.cumulative !== null && 1 + basic.cumulative > 0 && elapsedYears > 0
    ? (1 + basic.cumulative) ** (1 / elapsedYears) - 1
    : null;
  const drawdown = drawdownMetrics(points);
  const confidence = Math.max(0.8, Math.min(0.999, options.confidence ?? 0.95));
  const valueAtRisk = quantile(values, 1 - confidence);
  const tail = valueAtRisk === null ? [] : values.filter((value) => value <= valueAtRisk);
  const deviation = standardDeviation(values);
  const average = mean(values);
  const skewness = values.length >= 3 && deviation > 0
    ? values.length / ((values.length - 1) * (values.length - 2))
      * values.reduce((sum, value) => sum + ((value - average) / deviation) ** 3, 0)
    : null;
  const excessKurtosis = values.length >= 4 && deviation > 0
    ? values.length * (values.length + 1) / ((values.length - 1) * (values.length - 2) * (values.length - 3))
      * values.reduce((sum, value) => sum + ((value - average) / deviation) ** 4, 0)
      - 3 * (values.length - 1) ** 2 / ((values.length - 2) * (values.length - 3))
    : null;
  const monthlySummary = Array.from(bucket(points, 7), ([month, entries]): MonthlySummary => {
    const metric = basicMetrics(entries.map((entry) => entry.value), annual, riskFree);
    return {
      month,
      count: entries.length,
      cumulativeReturn: safe(metric.cumulative),
      annualizedVolatility: safe(metric.volatility),
      sharpeRatio: safe(metric.sharpe),
    };
  });
  const annualSummary = Array.from(bucket(points, 4), ([year, entries]): AnnualSummary => {
    const metric = basicMetrics(entries.map((entry) => entry.value), annual, riskFree);
    const annualizedReturn = metric.cumulative !== null && 1 + metric.cumulative > 0
      ? (1 + metric.cumulative) ** (annual / entries.length) - 1
      : null;
    return {
      year,
      count: entries.length,
      cumulativeReturn: safe(metric.cumulative),
      annualizedReturn: safe(annualizedReturn),
      annualizedVolatility: safe(metric.volatility),
      sharpeRatio: safe(metric.sharpe),
    };
  });
  return {
    key,
    label,
    observations: points.length,
    sampleStart: first ?? null,
    sampleEnd: last ?? null,
    frequencyPerYear: annual,
    cumulativeReturn: safe(basic.cumulative),
    cagr: safe(cagr),
    annualizedVolatility: safe(basic.volatility),
    sharpeRatio: safe(basic.sharpe),
    sortinoRatio: safe(basic.sortino),
    calmarRatio: cagr !== null && drawdown.maxDrawdown < 0 ? safe(cagr / Math.abs(drawdown.maxDrawdown)) : null,
    maxDrawdown: points.length ? drawdown.maxDrawdown : null,
    currentDrawdown: points.length ? drawdown.currentDrawdown : null,
    maxDrawdownRecoveryDays: drawdown.maxRecoveryDays,
    ulcerIndex: safe(drawdown.ulcer),
    valueAtRisk95: safe(valueAtRisk),
    conditionalValueAtRisk95: tail.length ? mean(tail) : null,
    skewness: safe(skewness),
    excessKurtosis: safe(excessKurtosis),
    rollingPerformance: [20, 60, 252].map((window) => {
      const slice = values.slice(-window);
      const metric = slice.length >= Math.min(window, minimum) ? basicMetrics(slice, annual, riskFree) : undefined;
      return { window, return: safe(metric?.cumulative), volatility: safe(metric?.volatility) };
    }),
    monthlySummary,
    annualSummary,
    warnings,
  };
}

export function createDeterministicRng(seed: number): DeterministicRng {
  let state = (Number.isFinite(seed) ? Math.trunc(seed) : 0) >>> 0;
  if (state === 0) state = 0x6d2b79f5;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4_294_967_296;
  };
  return {
    next,
    nextInt: (maximum) => Number.isInteger(maximum) && maximum > 0 ? Math.floor(next() * maximum) : 0,
    nextFloat: (minimum, maximum) => maximum > minimum ? minimum + next() * (maximum - minimum) : minimum,
  };
}

export function convertPricesToReturns(input: PriceSeriesInput): ReturnSeriesInput {
  const sanitized = sanitize(input.points, true).points;
  return {
    key: input.key,
    label: input.label,
    points: sanitized.slice(1).map((point, index) => ({
      date: point.date,
      value: point.value / sanitized[index].value - 1,
    })).filter((point) => finite(point.value)),
  };
}

export function alignReturnSeries(inputs: readonly (PriceSeriesInput | ReturnSeriesInput)[]): AlignedSeries {
  const quality: AlignmentQuality = {
    requestedPoints: {},
    keptPoints: {},
    removedInvalidDate: 0,
    removedNonFinite: 0,
    removedNonPositive: 0,
    removedDuplicateDates: 0,
    warnings: [],
  };
  const sanitized = inputs.map((input) => {
    const result = sanitize(input.points, false);
    quality.requestedPoints[input.key] = input.points.length;
    quality.keptPoints[input.key] = result.points.length;
    quality.removedInvalidDate += result.invalidDate;
    quality.removedNonFinite += result.nonFinite;
    quality.removedDuplicateDates += result.duplicates;
    return { ...input, points: result.points, map: new Map(result.points.map((point) => [point.date, point.value])) };
  });
  const dates = sanitized.length
    ? sanitized[0].points.map((point) => point.date).filter((date) => sanitized.every((series) => series.map.has(date)))
    : [];
  if (!dates.length) quality.warnings.push("공통 관측일이 없습니다.");
  if (quality.removedInvalidDate) quality.warnings.push(`비정상 날짜 ${quality.removedInvalidDate}건을 제거했습니다.`);
  if (quality.removedNonFinite) quality.warnings.push(`비유한 값 ${quality.removedNonFinite}건을 제거했습니다.`);
  if (quality.removedDuplicateDates) quality.warnings.push(`중복 날짜 ${quality.removedDuplicateDates}건은 마지막 값으로 대체했습니다.`);
  return {
    keys: sanitized.map((series) => series.key),
    dates,
    byKey: Object.fromEntries(sanitized.map((series) => [series.key, dates.map((date) => series.map.get(date)!)])),
    labels: Object.fromEntries(sanitized.map((series) => [series.key, series.label])),
    quality,
  };
}

export function analyzeSimpleReturnSeries(input: ReturnSeriesInput, options: ReturnAnalysisOptions = {}): ReturnSeriesAnalysis {
  return analyzeReturnSeries(input, options);
}

export function analyzeReturnSeries(input: ReturnSeriesInput, options: ReturnAnalysisOptions = {}): ReturnSeriesAnalysis {
  const sanitized = sanitize(input.points, false);
  const warnings: string[] = [];
  if (sanitized.invalidDate) warnings.push(`비정상 날짜 ${sanitized.invalidDate}건을 제거했습니다.`);
  if (sanitized.nonFinite) warnings.push(`비유한 값 ${sanitized.nonFinite}건을 제거했습니다.`);
  if (sanitized.duplicates) warnings.push(`중복 날짜 ${sanitized.duplicates}건은 마지막 값으로 대체했습니다.`);
  return summarize(input.key, input.label, sanitized.points, options, warnings);
}

export function buildRollingCorrelation(
  left: ReturnSeriesInput,
  right: ReturnSeriesInput,
  window = 60,
  method: "pearson" | "spearman" = "pearson",
): RollingCorrelationPoint[] {
  const aligned = alignReturnSeries([left, right]);
  const size = Math.max(2, Math.min(1_000, Math.floor(window)));
  const leftValues = aligned.byKey[left.key] ?? [];
  const rightValues = aligned.byKey[right.key] ?? [];
  return aligned.dates.map((date, index) => {
    if (index + 1 < size) return { date, value: null };
    const leftWindow = leftValues.slice(index + 1 - size, index + 1);
    const rightWindow = rightValues.slice(index + 1 - size, index + 1);
    return { date, value: method === "spearman" ? spearman(leftWindow, rightWindow) : pearson(leftWindow, rightWindow) };
  });
}

export function analyzePairedReturnSeries(
  left: ReturnSeriesInput,
  right: ReturnSeriesInput,
  options: ReturnAnalysisOptions = {},
): PairedReturnAnalysis {
  const aligned = alignReturnSeries([left, right]);
  const leftValues = aligned.byKey[left.key] ?? [];
  const rightValues = aligned.byKey[right.key] ?? [];
  const annual = annualization(options);
  const minimum = Math.max(2, Math.floor(options.minimumObservations ?? 2));
  const warnings = [...aligned.quality.warnings];
  if (aligned.dates.length < minimum) warnings.push(`최소 관측 수 ${minimum}개보다 표본이 적습니다.`);
  const correlation = pearson(leftValues, rightValues);
  const cov = covariance(leftValues, rightValues);
  const benchmarkVariance = sampleVariance(rightValues);
  const beta = cov !== null && benchmarkVariance > 0 ? cov / benchmarkVariance : null;
  const differences = leftValues.map((value, index) => value - rightValues[index]);
  const trackingError = differences.length >= 2 ? standardDeviation(differences) * Math.sqrt(annual) : null;
  const riskFreePeriod = (1 + (options.riskFreeRatePercent ?? 0) / 100) ** (1 / annual) - 1;
  const jensen = beta !== null
    ? ((mean(leftValues) - riskFreePeriod) - beta * (mean(rightValues) - riskFreePeriod)) * annual
    : null;
  const select = (predicate: (value: number) => boolean) => ({
    left: leftValues.filter((_, index) => predicate(rightValues[index])),
    right: rightValues.filter(predicate),
  });
  const up = select((value) => value > 0);
  const down = select((value) => value < 0);
  const capture = (values: { left: number[]; right: number[] }) => {
    const asset = compounded(values.left);
    const benchmark = compounded(values.right);
    return asset !== null && benchmark !== null && Math.abs(benchmark) > 1e-12 ? asset / benchmark : null;
  };
  return {
    leftKey: left.key,
    rightKey: right.key,
    observations: aligned.dates.length,
    sampleStart: aligned.dates[0] ?? null,
    sampleEnd: aligned.dates.at(-1) ?? null,
    frequencyPerYear: annual,
    pearsonCorrelation: safe(correlation),
    spearmanCorrelation: safe(spearman(leftValues, rightValues)),
    covariance: safe(cov),
    beta: safe(beta),
    rSquared: correlation === null ? null : correlation ** 2,
    trackingError: safe(trackingError),
    informationRatio: trackingError && trackingError > 0 ? mean(differences) * annual / trackingError : null,
    jensenAlpha: safe(jensen),
    upCorrelation: safe(pearson(up.left, up.right)),
    downCorrelation: safe(pearson(down.left, down.right)),
    upCapture: safe(capture(up)),
    downCapture: safe(capture(down)),
    warnings,
  };
}

export function buildCorrelationMatrix(
  inputs: readonly ReturnSeriesInput[],
  options: ReturnAnalysisOptions & { method?: "pearson" | "spearman" } = {},
): CorrelationMatrix {
  const aligned = alignReturnSeries(inputs);
  const observations = aligned.dates.length;
  const correlation = inputs.map((left, leftIndex) => inputs.map((right, rightIndex) => {
    if (leftIndex === rightIndex) return observations ? 1 : null;
    const leftValues = aligned.byKey[left.key] ?? [];
    const rightValues = aligned.byKey[right.key] ?? [];
    return options.method === "spearman" ? spearman(leftValues, rightValues) : pearson(leftValues, rightValues);
  }));
  return {
    keys: inputs.map((input) => input.key),
    correlation,
    observations: inputs.map(() => inputs.map(() => observations)),
  };
}
