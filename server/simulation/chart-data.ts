import type {
  ScalpingAnalysisInstrument,
  ScalpingRealtimeAnalysisResult,
  ScalpingWorkspaceResult,
} from "../scalping/api-contracts.js";

const MAX_CHART_BARS = 180;
const MAX_CHART_PATTERNS = 120;

type UnknownRecord = Record<string, unknown>;

export type SimulationChartPatternBias = "bullish" | "bearish" | "neutral";

export type SimulationChartPattern = {
  name:
    | "bullish_engulfing"
    | "bearish_engulfing"
    | "hammer"
    | "shooting_star"
    | "inside_bar"
    | "bullish_outside_bar"
    | "bearish_outside_bar";
  bias: SimulationChartPatternBias;
  strength: number;
  detectedAt: string;
};

export type SimulationChartBar = {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
  status: "forming" | "final" | "unknown";
  indicatorValues: Record<string, number>;
};

export type SimulationChartIndicator = {
  id: string;
  kind: string;
  status: string;
  values: Record<string, number>;
};

export type SimulationChartView = {
  symbol: string;
  name?: string;
  currency: "KRW" | "USD";
  bars: SimulationChartBar[];
  indicators: SimulationChartIndicator[];
  patterns: SimulationChartPattern[];
  updatedAt?: string;
};

function record(value: unknown): UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : {};
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizedTimestamp(value: unknown): string | undefined {
  const raw = text(value);
  const parsed = raw ? Date.parse(raw) : Number.NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function boundedStrength(value: number): number {
  return Math.max(0, Math.min(1, Math.round(value * 10_000) / 10_000));
}

function candleParts(bar: SimulationChartBar) {
  const range = Math.max(Number.EPSILON, bar.high - bar.low);
  const body = Math.abs(bar.close - bar.open);
  return {
    range,
    body,
    upperWick: bar.high - Math.max(bar.open, bar.close),
    lowerWick: Math.min(bar.open, bar.close) - bar.low,
    bullish: bar.close > bar.open,
    bearish: bar.close < bar.open,
  };
}

export function detectSimulationChartPatterns(
  bars: readonly SimulationChartBar[],
): SimulationChartPattern[] {
  const patterns: SimulationChartPattern[] = [];
  for (let index = 0; index < bars.length; index += 1) {
    const current = bars[index]!;
    if (current.status !== "final") continue;
    const currentParts = candleParts(current);
    const minimumBody = Math.max(currentParts.range * 0.04, Number.EPSILON);
    const effectiveBody = Math.max(currentParts.body, minimumBody);

    if (currentParts.lowerWick >= effectiveBody * 2
      && currentParts.upperWick <= effectiveBody
      && Math.max(current.open, current.close) >= current.low + currentParts.range * 0.6) {
      patterns.push({
        name: "hammer",
        bias: "bullish",
        strength: boundedStrength(currentParts.lowerWick / currentParts.range),
        detectedAt: current.timestamp,
      });
    }
    if (currentParts.upperWick >= effectiveBody * 2
      && currentParts.lowerWick <= effectiveBody
      && Math.min(current.open, current.close) <= current.low + currentParts.range * 0.4) {
      patterns.push({
        name: "shooting_star",
        bias: "bearish",
        strength: boundedStrength(currentParts.upperWick / currentParts.range),
        detectedAt: current.timestamp,
      });
    }

    const previous = bars[index - 1];
    if (!previous || previous.status !== "final") continue;
    const previousParts = candleParts(previous);
    const previousBodyHigh = Math.max(previous.open, previous.close);
    const previousBodyLow = Math.min(previous.open, previous.close);
    const currentBodyHigh = Math.max(current.open, current.close);
    const currentBodyLow = Math.min(current.open, current.close);
    if (previousParts.bearish && currentParts.bullish
      && currentBodyLow <= previousBodyLow
      && currentBodyHigh >= previousBodyHigh) {
      patterns.push({
        name: "bullish_engulfing",
        bias: "bullish",
        strength: boundedStrength(currentParts.body / Math.max(previousParts.body, minimumBody)),
        detectedAt: current.timestamp,
      });
    }
    if (previousParts.bullish && currentParts.bearish
      && currentBodyLow <= previousBodyLow
      && currentBodyHigh >= previousBodyHigh) {
      patterns.push({
        name: "bearish_engulfing",
        bias: "bearish",
        strength: boundedStrength(currentParts.body / Math.max(previousParts.body, minimumBody)),
        detectedAt: current.timestamp,
      });
    }
    if (current.high < previous.high && current.low > previous.low) {
      patterns.push({
        name: "inside_bar",
        bias: "neutral",
        strength: boundedStrength(1 - currentParts.range / Math.max(previousParts.range, Number.EPSILON)),
        detectedAt: current.timestamp,
      });
    } else if (current.high > previous.high && current.low < previous.low) {
      patterns.push({
        name: currentParts.bullish ? "bullish_outside_bar" : "bearish_outside_bar",
        bias: currentParts.bullish ? "bullish" : "bearish",
        strength: boundedStrength(currentParts.range / Math.max(previousParts.range, currentParts.range) - 0.05),
        detectedAt: current.timestamp,
      });
    }
  }
  return patterns.slice(-MAX_CHART_PATTERNS);
}

function normalizeBar(value: unknown): SimulationChartBar | undefined {
  const source = record(value);
  const timestamp = normalizedTimestamp(
    source.timestamp ?? source.closeTime ?? source.close_time ?? source.openTime ?? source.open_time,
  );
  const open = finite(source.open);
  const high = finite(source.high);
  const low = finite(source.low);
  const close = finite(source.close);
  if (!timestamp || open === undefined || high === undefined || low === undefined || close === undefined
    || open <= 0 || high <= 0 || low <= 0 || close <= 0
    || high < Math.max(open, close, low) || low > Math.min(open, close, high)) {
    return undefined;
  }
  const rawStatus = source.status ?? source.state;
  const status = rawStatus === "forming" || rawStatus === "final" || rawStatus === "unknown"
    ? rawStatus
    : source.complete === true ? "final" : "unknown";
  const volume = finite(source.volume);
  return {
    timestamp,
    open,
    high,
    low,
    close,
    ...(volume !== undefined && volume >= 0 ? { volume } : {}),
    status,
    indicatorValues: {},
  };
}

function pointList(value: unknown): UnknownRecord[] {
  const source = record(value);
  const points = list(source.points).map(record);
  if (points.length) return points;
  const latest = record(source.latest);
  return Object.keys(latest).length ? [latest] : [];
}

function pointValues(value: UnknownRecord): Record<string, number> {
  return Object.fromEntries(
    Object.entries(record(value.values)).flatMap(([key, raw]) => {
      const number = finite(raw);
      return number === undefined ? [] : [[key, number]];
    }),
  );
}

function applySeries(
  barsByTimestamp: Map<string, SimulationChartBar>,
  series: unknown,
  prefix: string,
): void {
  for (const point of pointList(series)) {
    const timestamp = normalizedTimestamp(point.timestamp);
    const bar = timestamp ? barsByTimestamp.get(timestamp) : undefined;
    if (!bar) continue;
    for (const [field, value] of Object.entries(pointValues(point))) {
      bar.indicatorValues[`${prefix}:${field}`] = value;
    }
  }
}

function mergeTechnical(
  chart: SimulationChartView,
  technicalInput: unknown,
): void {
  const technical = record(technicalInput);
  const barsByTimestamp = new Map(chart.bars.map((bar) => [bar.timestamp, bar]));
  const intraday = record(technical.intraday);
  applySeries(barsByTimestamp, intraday.session_vwap, "session-vwap");
  applySeries(barsByTimestamp, intraday.anchored_vwap, "anchored-vwap");

  const indicators: SimulationChartIndicator[] = [];
  for (const item of list(technical.indicators)) {
    const indicator = record(item);
    const id = text(indicator.id ?? indicator.indicatorId ?? indicator.indicator_id);
    const kind = text(indicator.kind);
    if (!id || !kind) continue;
    applySeries(barsByTimestamp, indicator, id);
    const points = pointList(indicator);
    const availability = record(indicator.availability);
    indicators.push({
      id,
      kind,
      status: text(availability.status) ?? "unavailable",
      values: points.length ? pointValues(points.at(-1)!) : {},
    });
  }
  chart.indicators = indicators;
  chart.patterns = detectSimulationChartPatterns(chart.bars);
}

export function simulationChartsFromWorkspace(
  value: ScalpingWorkspaceResult,
  symbols: readonly string[],
): SimulationChartView[] {
  const wanted = new Set(symbols);
  const metadataBySymbol = new Map(
    value.workspace.candidates.map((candidate) => [candidate.symbol, candidate]),
  );
  const charts = value.workspace.instruments.flatMap((instrument) => {
    if (!wanted.has(instrument.symbol)) return [];
    const metadata = metadataBySymbol.get(instrument.symbol);
    const bars = instrument.bars
      .flatMap((bar) => normalizeBar(bar) ?? [])
      .sort((left, right) => left.timestamp.localeCompare(right.timestamp))
      .slice(-MAX_CHART_BARS);
    const chart: SimulationChartView = {
      symbol: instrument.symbol,
      ...(metadata?.name ? { name: metadata.name } : {}),
      currency: metadata?.currency === "USD" ? "USD" : "KRW",
      bars,
      indicators: [],
      patterns: [],
      updatedAt: value.workspace.generatedAt,
    };
    mergeTechnical(chart, instrument.technical);
    return [chart];
  });
  const chartBySymbol = new Map(charts.map((chart) => [chart.symbol, chart]));
  for (const symbol of symbols) {
    if (chartBySymbol.has(symbol)) continue;
    const metadata = metadataBySymbol.get(symbol);
    chartBySymbol.set(symbol, {
      symbol,
      ...(metadata?.name ? { name: metadata.name } : {}),
      currency: metadata?.currency === "USD" ? "USD" : "KRW",
      bars: [],
      indicators: [],
      patterns: [],
      updatedAt: value.workspace.generatedAt,
    });
  }
  return symbols.flatMap((symbol) => chartBySymbol.get(symbol) ?? []);
}

export function mergeSimulationFinalBar(
  chart: SimulationChartView,
  payload: unknown,
  observedAt?: string,
): boolean {
  const bar = normalizeBar(payload);
  const source = record(payload);
  if (!bar || bar.status !== "final" || source.intervalMinutes !== 1) return false;
  return upsertSimulationChartBar(chart, bar, observedAt, true);
}

export function mergeSimulationFormingBar(
  chart: SimulationChartView,
  payload: unknown,
  observedAt?: string,
): boolean {
  const bar = normalizeBar(payload);
  const source = record(payload);
  if (!bar || bar.status !== "forming" || source.intervalMinutes !== 1) return false;
  return upsertSimulationChartBar(chart, bar, observedAt, false);
}

function upsertSimulationChartBar(
  chart: SimulationChartView,
  bar: SimulationChartBar,
  observedAt: string | undefined,
  refreshPatterns: boolean,
): boolean {
  const existingIndex = chart.bars.findIndex((candidate) => candidate.timestamp === bar.timestamp);
  if (existingIndex >= 0) {
    const existing = chart.bars[existingIndex]!;
    // A late forming update must never downgrade an already finalized candle.
    if (existing.status === "final" && bar.status === "forming") return false;
    const unchanged = existing.open === bar.open
      && existing.high === bar.high
      && existing.low === bar.low
      && existing.close === bar.close
      && existing.volume === bar.volume
      && existing.status === bar.status;
    if (unchanged) return false;
    chart.bars[existingIndex] = { ...bar, indicatorValues: existing.indicatorValues };
  } else {
    chart.bars.push(bar);
    chart.bars.sort((left, right) => left.timestamp.localeCompare(right.timestamp));
    if (chart.bars.length > MAX_CHART_BARS) {
      chart.bars.splice(0, chart.bars.length - MAX_CHART_BARS);
    }
  }
  chart.updatedAt = normalizedTimestamp(observedAt) ?? bar.timestamp;
  if (refreshPatterns) chart.patterns = detectSimulationChartPatterns(chart.bars);
  return true;
}

export function mergeSimulationLatestTechnical(
  chart: SimulationChartView,
  result: ScalpingRealtimeAnalysisResult,
): void {
  if (!("instruments" in result.technical)) return;
  const instrument = result.technical.instruments.find(
    (candidate: ScalpingAnalysisInstrument) => candidate.instrument_key === chart.symbol,
  );
  if (!instrument) return;
  mergeTechnical(chart, instrument);
  chart.updatedAt = result.generatedAt;
}

export function latestSimulationPatternObservation(
  chart: SimulationChartView | undefined,
): {
  chartPatternBias: SimulationChartPatternBias;
  chartPatterns: string[];
  patternObservedAt?: string;
} {
  const latestAt = chart?.bars.filter((bar) => bar.status === "final").at(-1)?.timestamp;
  if (!chart || !latestAt) return { chartPatternBias: "neutral", chartPatterns: [] };
  const latest = chart.patterns.filter((pattern) => pattern.detectedAt === latestAt);
  if (!latest.length) return { chartPatternBias: "neutral", chartPatterns: [] };
  const directional = latest.filter((pattern) => pattern.bias !== "neutral");
  const bullish = directional.filter((pattern) => pattern.bias === "bullish")
    .reduce((maximum, pattern) => Math.max(maximum, pattern.strength), 0);
  const bearish = directional.filter((pattern) => pattern.bias === "bearish")
    .reduce((maximum, pattern) => Math.max(maximum, pattern.strength), 0);
  return {
    chartPatternBias: bullish === bearish ? "neutral" : bullish > bearish ? "bullish" : "bearish",
    chartPatterns: latest.map((pattern) => pattern.name),
    patternObservedAt: latestAt,
  };
}
