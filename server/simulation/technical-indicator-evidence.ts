import type { SimulationPreset } from "./contracts.js";

export const RUST_INDICATOR_EVIDENCE_VERSION =
  "rust-indicator-evidence/v1" as const;
export const RUST_SCANNER_EVIDENCE_VERSION =
  "rust-scanner-evidence/v1" as const;
export const RUST_MARKET_EVIDENCE_VERSION =
  "rust-market-evidence/v2" as const;

type UnknownRecord = Record<string, unknown>;

export type NormalizedRustIndicator = {
  id: string;
  kind: string;
  values: Record<string, number>;
  previousValues: Record<string, number>;
};

export type RustIndicatorEvidence = {
  schemaVersion: typeof RUST_INDICATOR_EVIDENCE_VERSION;
  directionalScore: number;
  riskScale: number;
  availableIndicatorCount: number;
  usedDirectionalIndicatorCount: number;
  usedRiskIndicatorCount: number;
  components: Record<string, number>;
};

export type RustScannerMetricEvidence = Readonly<{
  availability: Readonly<{
    status:
      | "available"
      | "partial"
      | "insufficient_history"
      | "volume_unavailable"
      | "unsupported_instrument"
      | "unavailable";
    reason?: string;
  }>;
  value: number | null;
}>;

export type RustScannerEvidenceInput = Readonly<{
  schemaVersion: typeof RUST_SCANNER_EVIDENCE_VERSION;
  originAt?: string;
  provenance: Readonly<{
    source: "rust_scalping_scanner_metrics";
  }>;
  components: Readonly<{
    availableMetricCount: number;
    tradingAmount: number | null;
    relativeVolume: number | null;
  }>;
  tradingAmount: Readonly<{
    availability: RustScannerMetricEvidence["availability"];
    value: RustScannerMetricEvidence["value"];
  }>;
  relativeVolume: RustScannerMetricEvidence;
}>;

export type RustMarketEvidenceV2 = Readonly<{
  schemaVersion: typeof RUST_MARKET_EVIDENCE_VERSION;
  trendScore: number | null;
  momentumScore: number | null;
  breakoutScore: number | null;
  choppiness: number | null;
  normalizedAtr: number | null;
  realizedVolatility: number | null;
  dayRangeRatio: number | null;
  bollingerWidthExpansion: number | null;
  relativeVolume: number | null;
  tradingAmount: number | null;
  spreadBps: number | null;
  orderbookDepth: number | null;
  orderbookImbalance: number | null;
  executionStrength: number | null;
  liquidityQuality: number | null;
  exitRisk: number | null;
  sessionVwap: number | null;
  openingRange5: number | null;
  openingRange15: number | null;
  openingRange30: number | null;
  timeOfDayRelativeVolume: number | null;
  benchmarkRelativeStrength: number | null;
  quoteFreshnessMs: number | null;
  regime: string;
  passedGates: string[];
  blockedGates: string[];
  unavailableFields: string[];
  originAt: string;
  observedAt: string;
}>;

export function parseRustIndicatorEvidence(value: unknown): RustIndicatorEvidence | undefined {
  const source = record(value);
  if (source?.schemaVersion !== RUST_INDICATOR_EVIDENCE_VERSION) return undefined;
  const directionalScore = finite(source.directionalScore);
  const riskScale = finite(source.riskScale);
  const availableIndicatorCount = finite(source.availableIndicatorCount);
  const usedDirectionalIndicatorCount = finite(source.usedDirectionalIndicatorCount);
  const usedRiskIndicatorCount = finite(source.usedRiskIndicatorCount);
  if (directionalScore === undefined || directionalScore < -1 || directionalScore > 1
    || riskScale === undefined || riskScale < 0 || riskScale > 1
    || availableIndicatorCount === undefined || !Number.isSafeInteger(availableIndicatorCount)
    || usedDirectionalIndicatorCount === undefined
    || !Number.isSafeInteger(usedDirectionalIndicatorCount)
    || usedRiskIndicatorCount === undefined || !Number.isSafeInteger(usedRiskIndicatorCount)) {
    return undefined;
  }
  return {
    schemaVersion: RUST_INDICATOR_EVIDENCE_VERSION,
    directionalScore,
    riskScale,
    availableIndicatorCount,
    usedDirectionalIndicatorCount,
    usedRiskIndicatorCount,
    components: finiteValues(source.components),
  };
}

function record(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function finiteOrNull(value: unknown): number | null | undefined {
  return value === null ? null : finite(value);
}

function text(value: unknown, maximum = 128): string | undefined {
  return typeof value === "string" && value.trim() && value.length <= maximum
    ? value.trim()
    : undefined;
}

function clamp(value: number, minimum = -1, maximum = 1): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function rounded(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function finiteValues(value: unknown): Record<string, number> {
  const source = record(value);
  if (!source) return {};
  return Object.fromEntries(
    Object.entries(source)
      .flatMap(([key, item]) => {
        const normalized = finite(item);
        return normalized === undefined || !text(key, 64)
          ? []
          : [[key, normalized] as const];
      })
      .slice(0, 32),
  );
}

function scannerMetricValue(value: unknown): number | undefined {
  const source = record(value);
  const status = text(record(source?.availability)?.status, 64);
  const metric = finite(source?.value);
  return (
    (status === "available" || status === "partial")
    && metric !== undefined
    && metric >= 0
  ) ? metric : undefined;
}

const SCANNER_AVAILABILITY_STATUSES = new Set([
  "available",
  "partial",
  "insufficient_history",
  "volume_unavailable",
  "unsupported_instrument",
  "unavailable",
] as const);

function scannerMetricEvidence(value: unknown): RustScannerMetricEvidence | undefined {
  const source = record(value);
  const availabilitySource = record(source?.availability);
  const status = text(availabilitySource?.status, 64);
  if (!status || !SCANNER_AVAILABILITY_STATUSES.has(
    status as RustScannerMetricEvidence["availability"]["status"],
  )) {
    return undefined;
  }
  const reasonValue = availabilitySource?.reason;
  const reason = reasonValue === undefined ? undefined : text(reasonValue, 500);
  if (reasonValue !== undefined && reason === undefined) return undefined;
  const metricValue = source?.value;
  const normalizedValue = metricValue === null ? null : finite(metricValue);
  if (
    normalizedValue === undefined
    || (normalizedValue !== null && normalizedValue < 0)
    || (status === "available" && normalizedValue === null)
    || (!["available", "partial"].includes(status) && normalizedValue !== null)
  ) {
    return undefined;
  }
  return {
    availability: {
      status: status as RustScannerMetricEvidence["availability"]["status"],
      ...(reason === undefined ? {} : { reason }),
    },
    value: normalizedValue,
  };
}

/**
 * Projects the two non-directional liquidity fields from the versioned Rust
 * scanner output. Unknown metadata stays outside the trading policy boundary.
 * A malformed metric fails closed instead of being partially fabricated.
 */
export function projectRustScannerEvidence(
  value: unknown,
  options: Readonly<{ originAt?: string }> = {},
): RustScannerEvidenceInput | undefined {
  const source = record(value);
  if (!source) return undefined;
  const tradingAmount = scannerMetricEvidence(source.trading_amount);
  const relativeVolume = scannerMetricEvidence(source.relative_volume);
  if (!tradingAmount || !relativeVolume) return undefined;
  const originAt = options.originAt === undefined
    ? undefined
    : text(options.originAt, 64);
  if (
    options.originAt !== undefined
    && (originAt === undefined || !Number.isFinite(Date.parse(originAt)))
  ) {
    return undefined;
  }
  const availableMetricCount = Number(tradingAmount.value !== null)
    + Number(relativeVolume.value !== null);
  return {
    schemaVersion: RUST_SCANNER_EVIDENCE_VERSION,
    ...(originAt === undefined ? {} : { originAt }),
    provenance: { source: "rust_scalping_scanner_metrics" },
    components: {
      availableMetricCount,
      tradingAmount: tradingAmount.value,
      relativeVolume: relativeVolume.value,
    },
    tradingAmount,
    relativeVolume,
  };
}

const RUST_MARKET_NUMERIC_FIELDS = [
  "trendScore",
  "momentumScore",
  "breakoutScore",
  "choppiness",
  "normalizedAtr",
  "realizedVolatility",
  "dayRangeRatio",
  "bollingerWidthExpansion",
  "relativeVolume",
  "tradingAmount",
  "spreadBps",
  "orderbookDepth",
  "orderbookImbalance",
  "executionStrength",
  "liquidityQuality",
  "exitRisk",
  "sessionVwap",
  "openingRange5",
  "openingRange15",
  "openingRange30",
  "timeOfDayRelativeVolume",
  "benchmarkRelativeStrength",
  "quoteFreshnessMs",
] as const satisfies readonly (keyof RustMarketEvidenceV2)[];

const SNAKE_CASE_MARKET_FIELDS: Readonly<Record<
  (typeof RUST_MARKET_NUMERIC_FIELDS)[number],
  string
>> = {
  trendScore: "trend_score",
  momentumScore: "momentum_score",
  breakoutScore: "breakout_score",
  choppiness: "choppiness",
  normalizedAtr: "normalized_atr",
  realizedVolatility: "realized_volatility",
  dayRangeRatio: "day_range_ratio",
  bollingerWidthExpansion: "bollinger_width_expansion",
  relativeVolume: "relative_volume",
  tradingAmount: "trading_amount",
  spreadBps: "spread_bps",
  orderbookDepth: "orderbook_depth",
  orderbookImbalance: "orderbook_imbalance",
  executionStrength: "execution_strength",
  liquidityQuality: "liquidity_quality",
  exitRisk: "exit_risk",
  sessionVwap: "session_vwap",
  openingRange5: "opening_range_5",
  openingRange15: "opening_range_15",
  openingRange30: "opening_range_30",
  timeOfDayRelativeVolume: "time_of_day_relative_volume",
  benchmarkRelativeStrength: "benchmark_relative_strength",
  quoteFreshnessMs: "quote_freshness_ms",
};

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > 128) return undefined;
  const normalized = value.map((item) => text(item, 128));
  return normalized.every((item): item is string => item !== undefined)
    ? [...new Set(normalized)]
    : undefined;
}

/**
 * Strictly projects the Rust v2 policy boundary. Non-finite numeric data or an
 * observation newer than its decision origin invalidates the whole evidence
 * instead of silently replacing it with a policy-friendly value.
 */
export function parseRustMarketEvidenceV2(value: unknown): RustMarketEvidenceV2 | undefined {
  const source = record(value);
  if (!source || source.schemaVersion !== RUST_MARKET_EVIDENCE_VERSION) return undefined;
  const numeric: Record<string, number | null> = {};
  for (const key of RUST_MARKET_NUMERIC_FIELDS) {
    const raw = Object.hasOwn(source, key)
      ? source[key]
      : source[SNAKE_CASE_MARKET_FIELDS[key]];
    const parsed = finiteOrNull(raw);
    if (parsed === undefined) return undefined;
    numeric[key] = parsed;
  }
  for (const nonNegativeKey of [
    "choppiness",
    "normalizedAtr",
    "realizedVolatility",
    "dayRangeRatio",
    "relativeVolume",
    "tradingAmount",
    "spreadBps",
    "orderbookDepth",
    "sessionVwap",
    "openingRange5",
    "openingRange15",
    "openingRange30",
    "timeOfDayRelativeVolume",
    "quoteFreshnessMs",
  ] as const) {
    const metric = numeric[nonNegativeKey];
    if (metric !== null && metric! < 0) return undefined;
  }
  for (const boundedKey of [
    "trendScore",
    "momentumScore",
    "breakoutScore",
    "orderbookImbalance",
    "executionStrength",
    "benchmarkRelativeStrength",
  ] as const) {
    const metric = numeric[boundedKey];
    if (metric !== null && (metric! < -1 || metric! > 1)) return undefined;
  }
  for (const unitKey of ["liquidityQuality", "exitRisk"] as const) {
    const metric = numeric[unitKey];
    if (metric !== null && (metric! < 0 || metric! > 1)) return undefined;
  }
  const regime = text(source.regime, 64);
  const passedGates = stringList(source.passedGates ?? source.passed_gates);
  const blockedGates = stringList(source.blockedGates ?? source.blocked_gates);
  const unavailableFields = stringList(
    source.unavailableFields ?? source.unavailable_fields,
  );
  const originAt = text(source.originAt ?? source.origin_at, 64);
  const observedAt = text(source.observedAt ?? source.observed_at, 64);
  if (
    !regime
    || !passedGates
    || !blockedGates
    || !unavailableFields
    || !originAt
    || !observedAt
  ) return undefined;
  const originMs = Date.parse(originAt);
  const observedMs = Date.parse(observedAt);
  if (
    !Number.isFinite(originMs)
    || !Number.isFinite(observedMs)
    || observedMs > originMs
  ) return undefined;
  return {
    schemaVersion: RUST_MARKET_EVIDENCE_VERSION,
    trendScore: numeric.trendScore!,
    momentumScore: numeric.momentumScore!,
    breakoutScore: numeric.breakoutScore!,
    choppiness: numeric.choppiness!,
    normalizedAtr: numeric.normalizedAtr!,
    realizedVolatility: numeric.realizedVolatility!,
    dayRangeRatio: numeric.dayRangeRatio!,
    bollingerWidthExpansion: numeric.bollingerWidthExpansion!,
    relativeVolume: numeric.relativeVolume!,
    tradingAmount: numeric.tradingAmount!,
    spreadBps: numeric.spreadBps!,
    orderbookDepth: numeric.orderbookDepth!,
    orderbookImbalance: numeric.orderbookImbalance!,
    executionStrength: numeric.executionStrength!,
    liquidityQuality: numeric.liquidityQuality!,
    exitRisk: numeric.exitRisk!,
    sessionVwap: numeric.sessionVwap!,
    openingRange5: numeric.openingRange5!,
    openingRange15: numeric.openingRange15!,
    openingRange30: numeric.openingRange30!,
    timeOfDayRelativeVolume: numeric.timeOfDayRelativeVolume!,
    benchmarkRelativeStrength: numeric.benchmarkRelativeStrength!,
    quoteFreshnessMs: numeric.quoteFreshnessMs!,
    regime,
    passedGates,
    blockedGates,
    unavailableFields,
    originAt,
    observedAt,
  };
}

function normalizeScannerEvidence(value: unknown): {
  tradingAmount?: number;
  relativeVolume?: number;
  availableMetricCount: number;
  confirmationScale: number;
} | undefined {
  const source = record(value);
  if (
    source?.schemaVersion !== RUST_SCANNER_EVIDENCE_VERSION
    || record(source.provenance)?.source !== "rust_scalping_scanner_metrics"
  ) {
    return undefined;
  }
  const components = record(source.components);
  const expectedAvailableMetricCount = finite(components?.availableMetricCount);
  if (
    expectedAvailableMetricCount === undefined
    || !Number.isSafeInteger(expectedAvailableMetricCount)
    || expectedAvailableMetricCount < 0
    || expectedAvailableMetricCount > 2
  ) {
    return undefined;
  }
  const tradingAmount = scannerMetricValue(source.tradingAmount);
  const relativeVolume = scannerMetricValue(source.relativeVolume);
  const availableMetricCount = Number(tradingAmount !== undefined)
    + Number(relativeVolume !== undefined);
  const componentTradingAmount = components?.tradingAmount;
  const componentRelativeVolume = components?.relativeVolume;
  if (
    expectedAvailableMetricCount !== availableMetricCount
    || componentTradingAmount !== (tradingAmount ?? null)
    || componentRelativeVolume !== (relativeVolume ?? null)
  ) {
    return undefined;
  }
  if (availableMetricCount === 0) {
    return { availableMetricCount, confirmationScale: 1 };
  }
  const relativeVolumeScale = relativeVolume === undefined
    ? 1
    : clamp(0.5 + Math.min(relativeVolume, 1) * 0.5, 0.5, 1);
  const tradingAmountScale = tradingAmount === 0 ? 0.5 : 1;
  return {
    ...(tradingAmount === undefined ? {} : { tradingAmount }),
    ...(relativeVolume === undefined ? {} : { relativeVolume }),
    availableMetricCount,
    confirmationScale: Math.min(relativeVolumeScale, tradingAmountScale),
  };
}

function pointValues(value: unknown): Record<string, number> {
  return finiteValues(record(value)?.values);
}

/**
 * Accepts both the raw Rust `ScalpingIndicatorCalculation` shape and the
 * bounded crypto adapter shape. Only available, finite observations are kept.
 */
export function normalizeRustIndicators(value: unknown): NormalizedRustIndicator[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const source = record(item);
    const id = text(source?.indicator_id ?? source?.id);
    const kind = text(source?.kind);
    if (!source || !id || !kind) return [];
    const availability = text(record(source.availability)?.status, 64);
    if (availability && !["available", "partial"].includes(availability)) return [];
    const points = Array.isArray(source.points) ? source.points : [];
    const availablePoints = points.filter((point) => {
      const state = text(record(point)?.state, 64);
      return state === undefined || state === "available";
    });
    const latestPoint = source.latest ?? availablePoints.at(-1);
    const latestValues = Object.keys(finiteValues(source.latestValues)).length
      ? finiteValues(source.latestValues)
      : pointValues(latestPoint);
    const previousValues = Object.keys(finiteValues(source.previousValues)).length
      ? finiteValues(source.previousValues)
      : Object.keys(pointValues(source.previous)).length
        ? pointValues(source.previous)
        : pointValues(availablePoints.at(-2));
    if (!Object.keys(latestValues).length) return [];
    return [{
      id,
      kind,
      values: latestValues,
      previousValues,
    }];
  }).slice(0, 128);
}

type ScoredComponent = {
  key: string;
  score: number;
  group: "trend" | "momentum" | "breakout" | "volume";
};

function oscillatorScore(value: number, midpoint: number, halfRange: number): number {
  return clamp((value - midpoint) / Math.max(halfRange, Number.EPSILON));
}

function channelScore(
  close: number,
  lower: number | undefined,
  upper: number | undefined,
): number | undefined {
  if (lower === undefined || upper === undefined || upper <= lower) return undefined;
  return clamp(((close - lower) / (upper - lower) - 0.5) * 2);
}

function boundedSlope(current: number | undefined, previous: number | undefined): number | undefined {
  if (current === undefined || previous === undefined) return undefined;
  const scale = Math.max(Math.abs(current), Math.abs(previous), Number.EPSILON);
  return clamp((current - previous) / scale * 20);
}

function directionalComponents(
  indicators: readonly NormalizedRustIndicator[],
  input: {
    preset: SimulationPreset;
    currentPrice: number;
    currentVolume?: number;
  },
): ScoredComponent[] {
  const output: ScoredComponent[] = [];
  const inverseAtExtremes = input.preset === "mean_reversion";
  const byId = new Map(indicators.map((indicator) => [indicator.id, indicator]));
  const emaFast = [...byId].find(([id, item]) => (
    item.kind === "ema" && /fast|9(?:\D|$)|20(?:\D|$)/i.test(id)
  ))?.[1]?.values.value;
  const emaSlow = [...byId].find(([id, item]) => (
    item.kind === "ema" && /slow|21(?:\D|$)|50(?:\D|$)/i.test(id)
  ))?.[1]?.values.value;
  if (emaFast !== undefined && emaSlow !== undefined && input.currentPrice > 0) {
    output.push({
      key: "ema_structure",
      score: clamp((emaFast - emaSlow) / input.currentPrice / 0.003),
      group: "trend",
    });
  }

  for (const indicator of indicators) {
    const { values, previousValues } = indicator;
    let score: number | undefined;
    let group: ScoredComponent["group"] = "momentum";
    switch (indicator.kind) {
      case "ema":
      case "sma": {
        if (values.value !== undefined && input.currentPrice > 0) {
          score = clamp((input.currentPrice - values.value) / input.currentPrice / 0.01);
          group = "trend";
        }
        break;
      }
      case "moving_average_distance": {
        score = values.distance_percent === undefined
          ? undefined
          : clamp(values.distance_percent / 2);
        group = "trend";
        break;
      }
      case "macd": {
        const histogram = values.histogram
          ?? (values.macd !== undefined && values.signal !== undefined
            ? values.macd - values.signal : undefined);
        score = histogram === undefined || input.currentPrice <= 0
          ? undefined
          : clamp(histogram / input.currentPrice / 0.002);
        group = "momentum";
        break;
      }
      case "rsi": {
        if (values.value !== undefined) {
          const base = oscillatorScore(values.value, 50, 25);
          score = inverseAtExtremes ? -base : base;
        }
        break;
      }
      case "stochastic_oscillator": {
        const value = values.percent_k ?? values.percent_d;
        if (value !== undefined) {
          const base = oscillatorScore(value, 50, 35);
          score = inverseAtExtremes ? -base : base;
        }
        break;
      }
      case "roc": {
        if (values.value !== undefined) {
          const base = clamp(values.value / 2);
          score = inverseAtExtremes ? -base : base;
        }
        break;
      }
      case "cci": {
        if (values.value !== undefined) {
          const base = clamp(values.value / 150);
          score = inverseAtExtremes ? -base : base;
        }
        break;
      }
      case "williams_r": {
        if (values.value !== undefined) {
          const base = oscillatorScore(values.value, -50, 35);
          score = inverseAtExtremes ? -base : base;
        }
        break;
      }
      case "mfi": {
        if (values.value !== undefined) {
          const base = oscillatorScore(values.value, 50, 30);
          score = inverseAtExtremes ? -base : base;
          group = "volume";
        }
        break;
      }
      case "adx_dmi": {
        if (values.plus_di !== undefined && values.minus_di !== undefined) {
          const direction = (values.plus_di - values.minus_di)
            / Math.max(values.plus_di + values.minus_di, Number.EPSILON);
          score = clamp(direction * clamp((values.adx ?? 20) / 25, 0.25, 1));
          group = "trend";
        }
        break;
      }
      case "supertrend":
      case "parabolic_sar": {
        if (values.direction !== undefined) score = clamp(values.direction);
        group = "trend";
        break;
      }
      case "aroon": {
        const oscillator = values.oscillator
          ?? (values.aroon_up !== undefined && values.aroon_down !== undefined
            ? values.aroon_up - values.aroon_down : undefined);
        score = oscillator === undefined ? undefined : clamp(oscillator / 100);
        group = "trend";
        break;
      }
      case "bollinger_bands":
      case "keltner_channel":
      case "donchian_channel": {
        const position = channelScore(input.currentPrice, values.lower, values.upper);
        score = position === undefined
          ? undefined
          : inverseAtExtremes ? -position : position;
        group = indicator.kind === "donchian_channel" ? "breakout" : "trend";
        break;
      }
      case "bollinger_band_width_percent_b": {
        if (values.percent_b !== undefined) {
          const position = clamp((values.percent_b - 0.5) * 2);
          score = inverseAtExtremes ? -position : position;
          group = "breakout";
        }
        break;
      }
      case "cmf": {
        if (values.value !== undefined) score = clamp(values.value / 0.2);
        group = "volume";
        break;
      }
      case "obv":
      case "accumulation_distribution_line": {
        score = boundedSlope(values.value, previousValues.value);
        group = "volume";
        break;
      }
      default:
        break;
    }
    if (score !== undefined && Number.isFinite(score)) {
      output.push({
        key: `${indicator.id}:${indicator.kind}`,
        score: rounded(clamp(score)),
        group,
      });
    }
  }
  return output.slice(0, 96);
}

function minimumFinite(values: readonly number[], fallback: number): number {
  return values.length ? Math.min(...values) : fallback;
}

type RiskFamily =
  | "atr"
  | "choppiness"
  | "historical_volatility"
  | "bandwidth"
  | "liquidity";

type RiskSource = Readonly<{
  family: RiskFamily;
  key: string;
  scale: number;
}>;

function atrRiskScale(normalizedAtrPercent: number): number {
  return clamp(
    1 - Math.max(0, normalizedAtrPercent - 1) / 12,
    0.35,
    1,
  );
}

function liquidityRiskScale(relativeVolume: number): number {
  return clamp(0.5 + Math.min(relativeVolume, 1) * 0.5, 0.5, 1);
}

/**
 * Reduces the exact Rust indicator observations to bounded, auditable evidence.
 * Redundant indicators are averaged within their family before families are
 * combined, so asking Rust for more indicators cannot dominate the model merely
 * by count. Non-directional volatility/choppiness fields only reduce risk.
 */
export function scoreRustIndicatorEvidence(input: {
  indicators: unknown;
  preset: SimulationPreset;
  currentPrice: number;
  currentVolume?: number;
  scannerEvidence?: RustScannerEvidenceInput;
}): RustIndicatorEvidence {
  const normalized = normalizeRustIndicators(input.indicators);
  const scored = directionalComponents(normalized, input);
  const groups = (["trend", "momentum", "breakout", "volume"] as const)
    .flatMap((group) => {
      const values = scored.filter((item) => item.group === group).map((item) => item.score);
      return values.length ? [[group, values.reduce((sum, value) => sum + value, 0) / values.length] as const] : [];
    });
  const groupWeights: Record<(typeof groups)[number][0], number> = {
    trend: input.preset === "trend" ? 0.4 : 0.3,
    momentum: input.preset === "mean_reversion" ? 0.4 : 0.25,
    breakout: input.preset === "breakout" ? 0.4 : 0.2,
    volume: 0.2,
  };
  const totalWeight = groups.reduce((sum, [group]) => sum + groupWeights[group], 0);
  const indicatorDirectionalScore = totalWeight
    ? groups.reduce((sum, [group, value]) => sum + value * groupWeights[group], 0)
      / totalWeight
    : 0;
  const scanner = normalizeScannerEvidence(input.scannerEvidence);
  // Scanner liquidity never supplies or weakens a sign. In particular, low
  // liquidity must not attenuate an opposing technical score enough to remove
  // a conflict veto. It affects riskScale only.
  const directionalScore = indicatorDirectionalScore;

  const riskSources: RiskSource[] = [];
  for (const indicator of normalized) {
    const value = indicator.values.value;
    if (indicator.kind === "normalized_atr" && value !== undefined) {
      riskSources.push({
        family: "atr",
        key: `${indicator.id}:normalized_atr`,
        scale: atrRiskScale(Math.max(0, value)),
      });
    } else if (
      indicator.kind === "atr"
      && (indicator.values.atr ?? indicator.values.value) !== undefined
      && input.currentPrice > 0
    ) {
      const atr = indicator.values.atr ?? indicator.values.value!;
      riskSources.push({
        family: "atr",
        key: `${indicator.id}:price_normalized_atr`,
        scale: atrRiskScale(Math.max(0, atr) / input.currentPrice * 100),
      });
    } else if (indicator.kind === "choppiness_index" && value !== undefined) {
      riskSources.push({
        family: "choppiness",
        key: `${indicator.id}:choppiness`,
        scale: clamp(1 - Math.max(0, value - 45) / 45, 0.45, 1),
      });
    } else if (indicator.kind === "historical_volatility" && value !== undefined) {
      riskSources.push({
        family: "historical_volatility",
        key: `${indicator.id}:historical_volatility`,
        scale: clamp(1 / (1 + Math.max(0, value) / 100), 0.35, 1),
      });
    } else if (indicator.kind === "bollinger_band_width_percent_b"
      && indicator.values.bandwidth !== undefined) {
      riskSources.push({
        family: "bandwidth",
        key: `${indicator.id}:bandwidth`,
        scale: clamp(
          1 / (1 + Math.max(0, indicator.values.bandwidth) / 20),
          0.4,
          1,
        ),
      });
    } else if (
      indicator.kind === "relative_volume"
      && value !== undefined
      && value >= 0
    ) {
      riskSources.push({
        family: "liquidity",
        key: `${indicator.id}:relative_volume`,
        scale: liquidityRiskScale(value),
      });
    } else if (
      indicator.kind === "volume_sma"
      && value !== undefined
      && value > 0
      && input.currentVolume !== undefined
      && input.currentVolume >= 0
    ) {
      riskSources.push({
        family: "liquidity",
        key: `${indicator.id}:current_volume_to_sma`,
        scale: liquidityRiskScale(input.currentVolume / value),
      });
    }
  }
  if (scanner && scanner.availableMetricCount > 0) {
    riskSources.push({
      family: "liquidity",
      key: "scanner:liquidity_confirmation",
      scale: scanner.confirmationScale,
    });
  }
  const riskFamilies = ([
    "atr",
    "choppiness",
    "historical_volatility",
    "bandwidth",
    "liquidity",
  ] as const).flatMap((family) => {
    const sources = riskSources.filter((item) => item.family === family);
    return sources.length
      ? [[family, minimumFinite(sources.map((item) => item.scale), 1)] as const]
      : [];
  });
  const scannerComponents: Array<[string, number]> = scanner ? [
    ["scanner:available_metric_count", scanner.availableMetricCount],
    ["scanner:confirmation_scale", scanner.confirmationScale],
    ...(scanner.tradingAmount === undefined
      ? [] : [["scanner:trading_amount", scanner.tradingAmount] as [string, number]]),
    ...(scanner.relativeVolume === undefined
      ? [] : [["scanner:relative_volume", scanner.relativeVolume] as [string, number]]),
  ] : [];
  const components = Object.fromEntries([
    ...scannerComponents.map(([key, value]) => [key, rounded(value)] as const),
    ...groups.map(([group, value]) => [`group:${group}`, rounded(value)] as const),
    ...scored.map((item) => [`indicator:${item.key}`, item.score] as const),
    ...riskSources.map((item) => [
      `risk_source:${item.key}`,
      rounded(item.scale),
    ] as const),
    ...riskFamilies.map(([family, value]) => [
      `risk:${family}`,
      rounded(value),
    ] as const),
  ].slice(0, 128));
  return {
    schemaVersion: RUST_INDICATOR_EVIDENCE_VERSION,
    directionalScore: rounded(clamp(directionalScore)),
    riskScale: rounded(minimumFinite(riskFamilies.map(([, value]) => value), 1)),
    availableIndicatorCount: normalized.length,
    usedDirectionalIndicatorCount: scored.length,
    usedRiskIndicatorCount: riskFamilies.length,
    components,
  };
}
