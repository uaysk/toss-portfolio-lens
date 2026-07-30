import type { PortfolioRunKind } from "../repositories/run-repository.js";
import { TECHNICAL_INDICATOR_ENGINE_VERSION } from "../services/technical-analysis-contract.js";
import type { SimulationPreset } from "../simulation/contracts.js";
import {
  RUST_MARKET_EVIDENCE_VERSION,
  RUST_SCANNER_EVIDENCE_VERSION,
  parseRustMarketEvidenceV2,
} from "../simulation/technical-indicator-evidence.js";
import type { RustMarketEvidenceV2 } from "../simulation/technical-indicator-evidence.js";
import type { BinanceKline } from "./binance-market-data.js";

export const CRYPTO_RUST_TECHNICAL_SCHEMA_VERSION = "crypto-rust-technical/v1" as const;
export const CRYPTO_RUST_SCALPING_ENGINE_VERSION = "scalping-analysis/1.4.0" as const;
export const CRYPTO_RUST_SCANNER_EVIDENCE_SCHEMA_VERSION =
  RUST_SCANNER_EVIDENCE_VERSION;
export const CRYPTO_LIVE_RUST_MARKET_EVIDENCE_SCHEMA_VERSION =
  "crypto-live-rust-market-evidence/v1" as const;
export const CRYPTO_RUST_OUTPUT_TAIL_POINTS = 64;
// Seven UTC days leave at least six complete 24/7 sessions plus the current
// partial session, which is sufficient for the five-session relative-volume
// baseline without using the current session as history.
export const CRYPTO_RUST_MAX_INPUT_BARS = 7 * 24 * 60;

type JsonRecord = Record<string, unknown>;

export type CryptoRustIndicatorKind =
  | "ema"
  | "rsi"
  | "macd"
  | "bollinger_bands"
  | "atr"
  | "donchian_channel"
  | "adx_dmi"
  | "stochastic_oscillator"
  | "roc"
  | "keltner_channel"
  | "supertrend"
  | "historical_volatility"
  | "normalized_atr"
  | "bollinger_band_width_percent_b"
  | "aroon"
  | "cci"
  | "williams_r"
  | "parabolic_sar"
  | "choppiness_index"
  | "volume_sma"
  | "relative_volume"
  | "obv"
  | "mfi"
  | "cmf"
  | "accumulation_distribution_line";

export type CryptoRustIndicatorDefinition = Readonly<{
  id: string;
  kind: CryptoRustIndicatorKind;
  parameters?: Readonly<Record<string, string | number | boolean>>;
}>;

export const CRYPTO_RUST_INDICATORS = Object.freeze([
  { id: "ema-fast-9", kind: "ema", parameters: { period: 9, source: "close" } },
  { id: "ema-slow-21", kind: "ema", parameters: { period: 21, source: "close" } },
  { id: "rsi-14", kind: "rsi", parameters: { period: 14, source: "close" } },
  {
    id: "macd-12-26-9",
    kind: "macd",
    parameters: {
      fast_period: 12,
      slow_period: 26,
      signal_period: 9,
      source: "close",
    },
  },
  {
    id: "bollinger-20-2",
    kind: "bollinger_bands",
    parameters: { period: 20, stddev_multiplier: 2, source: "close" },
  },
  { id: "atr-14", kind: "atr", parameters: { period: 14 } },
  { id: "donchian-20", kind: "donchian_channel", parameters: { period: 20 } },
  { id: "adx-dmi-14", kind: "adx_dmi", parameters: { period: 14 } },
  {
    id: "stochastic-14-3-3",
    kind: "stochastic_oscillator",
    parameters: { lookback_period: 14, smooth_k: 3, smooth_d: 3 },
  },
  { id: "roc-10", kind: "roc", parameters: { period: 10, source: "close" } },
  {
    id: "keltner-20-10-2",
    kind: "keltner_channel",
    parameters: { ema_period: 20, atr_period: 10, multiplier: 2 },
  },
  {
    id: "supertrend-10-3",
    kind: "supertrend",
    parameters: { atr_period: 10, multiplier: 3 },
  },
  {
    id: "historical-volatility-20-1m",
    kind: "historical_volatility",
    parameters: { period: 20, annualization: 525_600, return_type: "log" },
  },
  { id: "normalized-atr-14", kind: "normalized_atr", parameters: { period: 14 } },
  {
    id: "bollinger-width-percent-b-20",
    kind: "bollinger_band_width_percent_b",
    parameters: { period: 20, stddev_multiplier: 2, source: "close" },
  },
  { id: "aroon-25", kind: "aroon", parameters: { period: 25 } },
  { id: "cci-20", kind: "cci", parameters: { period: 20, constant: 0.015 } },
  { id: "williams-r-14", kind: "williams_r", parameters: { period: 14 } },
  {
    id: "parabolic-sar",
    kind: "parabolic_sar",
    parameters: { step: 0.02, max_step: 0.2 },
  },
  { id: "choppiness-14", kind: "choppiness_index", parameters: { period: 14 } },
  { id: "volume-sma-20", kind: "volume_sma", parameters: { period: 20 } },
  { id: "relative-volume-20", kind: "relative_volume", parameters: { period: 20 } },
  { id: "obv", kind: "obv" },
  { id: "mfi-14", kind: "mfi", parameters: { period: 14 } },
  { id: "cmf-20", kind: "cmf", parameters: { period: 20 } },
  { id: "accumulation-distribution-line", kind: "accumulation_distribution_line" },
] as const) satisfies readonly CryptoRustIndicatorDefinition[];

export interface CryptoRustComputePort {
  compute<T>(
    kind: Extract<PortfolioRunKind, "scalping_analysis">,
    payload: Record<string, unknown>,
    options?: {
      includeArtifacts?: boolean;
      signal?: AbortSignal;
    },
  ): Promise<{ result: T }>;
}

export type CryptoRustTechnicalValuePoint = Readonly<{
  at: string;
  values: Readonly<Record<string, number>>;
}>;

export type CryptoRustTechnicalCalculation = Readonly<{
  id: string;
  kind: CryptoRustIndicatorKind;
  availability: Readonly<{
    status: string;
    reason: string;
  }>;
  latest: CryptoRustTechnicalValuePoint | null;
  previous: CryptoRustTechnicalValuePoint | null;
}>;

export type CryptoRustScannerMetric = Readonly<{
  availability: Readonly<{
    status:
      | "available"
      | "partial"
      | "insufficient_history"
      | "volume_unavailable"
      | "unsupported_instrument"
      | "unavailable";
    reason: string;
  }>;
  value: number | null;
  metadata: Readonly<Record<string, string | number | boolean | null>>;
}>;

export type CryptoRustScannerEvidence = Readonly<{
  schemaVersion: typeof CRYPTO_RUST_SCANNER_EVIDENCE_SCHEMA_VERSION;
  originAt: string;
  tradingAmount: CryptoRustScannerMetric;
  relativeVolume: CryptoRustScannerMetric;
  provenance: Readonly<{
    source: "rust_scalping_scanner_metrics";
    resultSchemaVersion: "scalping-analysis-result/v3";
    market: "BINANCE_USDM";
    quoteAsset: "USDT";
    interval: "1m";
    finalizedBarsOnly: true;
    tradingAmountSource: "quote_volume";
    relativeVolumeBaseline: "same_local_minute_prior_sessions";
    currentSessionExcluded: true;
  }>;
  components: Readonly<{
    availableMetricCount: number;
    tradingAmount: number | null;
    relativeVolume: number | null;
  }>;
}>;

export type CryptoRustTechnicalAnalysis = Readonly<{
  schemaVersion: typeof CRYPTO_RUST_TECHNICAL_SCHEMA_VERSION;
  symbol: string;
  scalpingEngineVersion: string;
  indicatorEngineVersion: string;
  originAt: string;
  calculationAt: string;
  signalAt: string;
  earliestEligibleAt: string;
  status: "watch" | "entry_candidate" | "hold" | "exit_candidate";
  technicalSignal: -1 | 0 | 1;
  basisPrice: number;
  stopCandidatePrice: number | null;
  targetCandidatePrice: number | null;
  confidence: number;
  confidenceSemantics: string;
  quality: Readonly<{
    status: string;
    reason: string;
    reasons: readonly string[];
    finalBarCount: number;
    sameSessionGapCount: number;
    missingVolumeCount: number;
    missingAmountCount: number;
  }>;
  multiTimeframeAgreement: string;
  multiTimeframeTrends: Readonly<
    Record<string, "bullish" | "bearish" | "neutral" | null>
  >;
  rationale: readonly string[];
  calculations: readonly CryptoRustTechnicalCalculation[];
  scannerEvidence: CryptoRustScannerEvidence;
  marketEvidence: RustMarketEvidenceV2;
  input: Readonly<{
    interval: "1m";
    barCount: number;
    firstFinalizedAt: string;
    lastFinalizedAt: string;
    outputTailPoints: typeof CRYPTO_RUST_OUTPUT_TAIL_POINTS;
    usesOhlc: true;
    usesVolume: true;
    usesQuoteVolumeAsAmount: true;
  }>;
}>;

export type CryptoRustTechnicalAnalyzeInput = Readonly<{
  symbol: string;
  bars: readonly BinanceKline[];
  preset: SimulationPreset;
  orderbook?: Readonly<{
    observedAt: string;
    bidPrice: number;
    bidQuantity: number;
    askPrice: number;
    askQuantity: number;
  }>;
  tradeStats?: Readonly<{
    observedAt: string;
    buyVolume: number;
    sellVolume: number;
  }>;
  signal?: AbortSignal;
}>;

export type CryptoLiveRustMarketEvidence = Readonly<{
  schemaVersion: typeof CRYPTO_LIVE_RUST_MARKET_EVIDENCE_SCHEMA_VERSION;
  technicalOriginAt: string;
  decisionOriginAt: string;
  microstructureObservedAt: string | null;
  marketEvidence: RustMarketEvidenceV2;
}>;

export type CryptoLiveRustMarketEvidenceInput = Readonly<{
  baseEvidence: RustMarketEvidenceV2;
  decisionOriginAt: string;
  bookTicker?: Readonly<{
    observedAt: string;
    bidPrice: number;
    bidQuantity: number;
    askPrice: number;
    askQuantity: number;
  }>;
  tradeStats?: Readonly<{
    observedAt: string;
    buyVolume: number;
    sellVolume: number;
  }>;
}>;

type PreparedBar = Readonly<{
  timestamp: string;
  session_date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  amount: number;
  complete: true;
  epochMillis: number;
}>;

const LIVE_MARKET_GATE_NAMES = new Set([
  "SPREAD",
  "SPREAD_UNAVAILABLE",
  "LIQUIDITY",
  "LIQUIDITY_UNAVAILABLE",
  "QUOTE_FRESHNESS",
  "QUOTE_STALE",
  "QUOTE_FRESHNESS_UNAVAILABLE",
]);

const LIVE_MARKET_FIELDS = Object.freeze([
  "spreadBps",
  "orderbookDepth",
  "orderbookImbalance",
  "executionStrength",
  "liquidityQuality",
  "exitRisk",
  "quoteFreshnessMs",
] as const);

function roundEvidence(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function clampEvidence(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function canonicalEpoch(value: string, label: string): number {
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== value) {
    throw new Error(`Crypto live Rust ${label} must be a canonical UTC instant.`);
  }
  return epoch;
}

function liveMarketGateProjection(input: {
  base: RustMarketEvidenceV2;
  spreadBps: number | null;
  liquidityQuality: number | null;
  quoteFreshnessMs: number | null;
}): Pick<RustMarketEvidenceV2, "passedGates" | "blockedGates"> {
  const passedGates = input.base.passedGates.filter(
    (gate) => !LIVE_MARKET_GATE_NAMES.has(gate),
  );
  const blockedGates = input.base.blockedGates.filter(
    (gate) => !LIVE_MARKET_GATE_NAMES.has(gate),
  );
  if (input.spreadBps === null) blockedGates.push("SPREAD_UNAVAILABLE");
  else if (input.spreadBps <= 35) passedGates.push("SPREAD");
  else blockedGates.push("SPREAD");
  if (input.liquidityQuality === null) blockedGates.push("LIQUIDITY_UNAVAILABLE");
  else if (input.liquidityQuality >= 0.25) passedGates.push("LIQUIDITY");
  else blockedGates.push("LIQUIDITY");
  if (input.quoteFreshnessMs === null) {
    blockedGates.push("QUOTE_FRESHNESS_UNAVAILABLE");
  } else if (input.quoteFreshnessMs <= 60_000) {
    passedGates.push("QUOTE_FRESHNESS");
  } else {
    blockedGates.push("QUOTE_STALE");
  }
  return {
    passedGates: [...new Set(passedGates)],
    blockedGates: [...new Set(blockedGates)],
  };
}

/**
 * Projects cached finalized-bar Rust indicators onto a live decision origin.
 *
 * The technical values remain the Rust worker's immutable, finalized-1m
 * result. Only top-of-book and aggregate-trade fields are replaced with
 * snapshots observed no later than the decision origin. The calculations and
 * gate thresholds intentionally mirror worker/rust/src/scalping.rs.
 */
export function composeCryptoLiveRustMarketEvidence(
  input: CryptoLiveRustMarketEvidenceInput,
): CryptoLiveRustMarketEvidence {
  const decisionEpoch = canonicalEpoch(input.decisionOriginAt, "decisionOriginAt");
  const technicalEpoch = canonicalEpoch(input.baseEvidence.originAt, "technicalOriginAt");
  const baseObservedEpoch = canonicalEpoch(
    input.baseEvidence.observedAt,
    "baseEvidence.observedAt",
  );
  if (technicalEpoch > decisionEpoch || baseObservedEpoch > decisionEpoch) {
    throw new Error("Crypto live Rust base evidence exceeds the decision origin.");
  }

  let spreadBps = input.baseEvidence.spreadBps;
  let orderbookDepth = input.baseEvidence.orderbookDepth;
  let orderbookImbalance = input.baseEvidence.orderbookImbalance;
  let quoteObservedEpoch = input.baseEvidence.quoteFreshnessMs === null
    ? undefined
    : technicalEpoch - input.baseEvidence.quoteFreshnessMs;
  if (input.bookTicker) {
    const observedEpoch = canonicalEpoch(input.bookTicker.observedAt, "bookTicker.observedAt");
    if (observedEpoch > decisionEpoch) {
      throw new Error("Crypto live Rust book ticker exceeds the decision origin.");
    }
    const {
      bidPrice,
      bidQuantity,
      askPrice,
      askQuantity,
    } = input.bookTicker;
    if (
      !Number.isFinite(bidPrice)
      || bidPrice <= 0
      || !Number.isFinite(askPrice)
      || askPrice < bidPrice
      || !Number.isFinite(bidQuantity)
      || bidQuantity < 0
      || !Number.isFinite(askQuantity)
      || askQuantity < 0
    ) {
      throw new Error("Crypto live Rust book ticker values are invalid.");
    }
    const midpoint = (bidPrice + askPrice) / 2;
    const totalQuantity = bidQuantity + askQuantity;
    spreadBps = roundEvidence((askPrice - bidPrice) / midpoint * 10_000, 8);
    orderbookDepth = roundEvidence(totalQuantity * midpoint, 4);
    orderbookImbalance = totalQuantity > 0
      ? roundEvidence((bidQuantity - askQuantity) / totalQuantity, 8)
      : null;
    quoteObservedEpoch = observedEpoch;
  }
  const quoteFreshnessMs = quoteObservedEpoch === undefined
    ? null
    : decisionEpoch - quoteObservedEpoch;

  let executionStrength = input.baseEvidence.executionStrength;
  let tradeObservedEpoch: number | undefined;
  if (input.tradeStats) {
    tradeObservedEpoch = canonicalEpoch(input.tradeStats.observedAt, "tradeStats.observedAt");
    if (tradeObservedEpoch > decisionEpoch) {
      throw new Error("Crypto live Rust trade stats exceed the decision origin.");
    }
    const { buyVolume, sellVolume } = input.tradeStats;
    if (
      !Number.isFinite(buyVolume)
      || buyVolume < 0
      || !Number.isFinite(sellVolume)
      || sellVolume < 0
    ) {
      throw new Error("Crypto live Rust trade stats values are invalid.");
    }
    const totalVolume = buyVolume + sellVolume;
    executionStrength = totalVolume > 0
      ? roundEvidence((buyVolume - sellVolume) / totalVolume, 8)
      : null;
  }

  const liquidityComponents: number[] = [];
  if (spreadBps !== null) {
    liquidityComponents.push(clampEvidence(1 - spreadBps / 50, 0, 1));
  }
  if (orderbookDepth !== null) {
    liquidityComponents.push(clampEvidence(orderbookDepth / 250_000, 0, 1));
  }
  if (input.baseEvidence.relativeVolume !== null) {
    liquidityComponents.push(clampEvidence(input.baseEvidence.relativeVolume, 0, 1));
  }
  const liquidityQuality = liquidityComponents.length
    ? roundEvidence(
      liquidityComponents.reduce((sum, value) => sum + value, 0)
        / liquidityComponents.length,
      8,
    )
    : null;

  const exitComponents: number[] = [];
  if (input.baseEvidence.normalizedAtr !== null) {
    exitComponents.push(clampEvidence(input.baseEvidence.normalizedAtr / 10, 0, 1));
  }
  if (input.baseEvidence.choppiness !== null) {
    exitComponents.push(clampEvidence(input.baseEvidence.choppiness / 100, 0, 1));
  }
  if (spreadBps !== null) {
    exitComponents.push(clampEvidence(spreadBps / 50, 0, 1));
  }
  const exitRisk = exitComponents.length
    ? roundEvidence(
      exitComponents.reduce((sum, value) => sum + value, 0) / exitComponents.length,
      8,
    )
    : null;
  const gates = liveMarketGateProjection({
    base: input.baseEvidence,
    spreadBps,
    liquidityQuality,
    quoteFreshnessMs,
  });
  const unavailableFields = new Set(input.baseEvidence.unavailableFields);
  const liveValues = {
    spreadBps,
    orderbookDepth,
    orderbookImbalance,
    executionStrength,
    liquidityQuality,
    exitRisk,
    quoteFreshnessMs,
  };
  for (const field of LIVE_MARKET_FIELDS) {
    if (liveValues[field] === null) unavailableFields.add(field);
    else unavailableFields.delete(field);
  }
  const microstructureObservedEpoch = Math.max(
    ...(quoteObservedEpoch === undefined ? [] : [quoteObservedEpoch]),
    ...(tradeObservedEpoch === undefined ? [] : [tradeObservedEpoch]),
  );
  const observedEpoch = Math.max(
    baseObservedEpoch,
    ...(Number.isFinite(microstructureObservedEpoch)
      ? [microstructureObservedEpoch]
      : []),
  );
  const marketEvidence: RustMarketEvidenceV2 = {
    ...input.baseEvidence,
    schemaVersion: RUST_MARKET_EVIDENCE_VERSION,
    spreadBps,
    orderbookDepth,
    orderbookImbalance,
    executionStrength,
    liquidityQuality,
    exitRisk,
    quoteFreshnessMs,
    passedGates: gates.passedGates,
    blockedGates: gates.blockedGates,
    unavailableFields: [...unavailableFields],
    originAt: input.decisionOriginAt,
    observedAt: new Date(observedEpoch).toISOString(),
  };
  return {
    schemaVersion: CRYPTO_LIVE_RUST_MARKET_EVIDENCE_SCHEMA_VERSION,
    technicalOriginAt: input.baseEvidence.originAt,
    decisionOriginAt: input.decisionOriginAt,
    microstructureObservedAt: Number.isFinite(microstructureObservedEpoch)
      ? new Date(microstructureObservedEpoch).toISOString()
      : null,
    marketEvidence,
  };
}

function record(value: unknown, label: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Crypto Rust ${label} must be an object.`);
  }
  return value as JsonRecord;
}

function array(value: unknown, label: string, maximum: number): unknown[] {
  if (!Array.isArray(value)) throw new Error(`Crypto Rust ${label} must be an array.`);
  if (value.length > maximum) {
    throw new Error(`Crypto Rust ${label} exceeds the ${maximum}-item limit.`);
  }
  return value;
}

function string(value: unknown, label: string, maximum = 500): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) {
    throw new Error(`Crypto Rust ${label} must be a non-empty bounded string.`);
  }
  return value;
}

function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Crypto Rust ${label} must be finite.`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  const parsed = finite(value, label);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Crypto Rust ${label} must be a non-negative safe integer.`);
  }
  return parsed;
}

function isoInstant(value: unknown, label: string): string {
  const parsed = string(value, label, 64);
  const epoch = Date.parse(parsed);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== parsed) {
    throw new Error(`Crypto Rust ${label} must be a canonical UTC instant.`);
  }
  return parsed;
}

function nullableFinite(value: unknown, label: string): number | null {
  if (value === null || value === undefined) return null;
  return finite(value, label);
}

function boundedStrings(value: unknown, label: string, maximum: number): string[] {
  return array(value, label, maximum).map((item, index) => (
    string(item, `${label}[${index}]`, 500)
  ));
}

function normalizeSymbol(value: string): string {
  const symbol = value.trim().toUpperCase();
  if (!/^[A-Z0-9]{1,32}$/.test(symbol)) {
    throw new Error("Crypto Rust symbol must contain 1..32 uppercase letters or digits.");
  }
  return symbol;
}

function prepareBars(symbol: string, source: readonly BinanceKline[]): PreparedBar[] {
  if (source.length > 100_000) {
    throw new Error("Crypto Rust source bars exceed the 100000-item ingress limit.");
  }
  const candidates = source
    .filter((bar) => bar.final && bar.interval === "1m")
    .map((bar, index) => {
      if (bar.symbol.toUpperCase() !== symbol) {
        throw new Error(`Crypto Rust bars[${index}] symbol does not match ${symbol}.`);
      }
      if (!Number.isSafeInteger(bar.openTime) || bar.openTime < 0 || bar.openTime % 60_000 !== 0) {
        throw new Error(`Crypto Rust bars[${index}] openTime is not minute-aligned.`);
      }
      if (
        !Number.isSafeInteger(bar.closeTime)
        || ![59_999, 60_000].includes(bar.closeTime - bar.openTime)
      ) {
        throw new Error(`Crypto Rust bars[${index}] is not an exact one-minute candle.`);
      }
      for (const [name, value] of Object.entries({
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
      })) {
        if (!Number.isFinite(value) || value <= 0) {
          throw new Error(`Crypto Rust bars[${index}].${name} must be finite and positive.`);
        }
      }
      if (
        bar.high < Math.max(bar.open, bar.close)
        || bar.low > Math.min(bar.open, bar.close)
        || bar.low > bar.high
      ) {
        throw new Error(`Crypto Rust bars[${index}] has an inconsistent OHLC range.`);
      }
      if (!Number.isFinite(bar.volume) || bar.volume < 0) {
        throw new Error(`Crypto Rust bars[${index}].volume must be finite and non-negative.`);
      }
      if (!Number.isFinite(bar.quoteVolume) || bar.quoteVolume < 0) {
        throw new Error(`Crypto Rust bars[${index}].quoteVolume must be finite and non-negative.`);
      }
      const epochMillis = bar.openTime + 60_000;
      const timestamp = new Date(epochMillis).toISOString();
      return {
        timestamp,
        session_date: timestamp.slice(0, 10),
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume,
        amount: bar.quoteVolume,
        complete: true as const,
        epochMillis,
      };
    })
    .sort((left, right) => left.epochMillis - right.epochMillis);
  if (candidates.length === 0) {
    throw new Error("Crypto Rust analysis requires at least one finalized exact 1m candle.");
  }
  for (let index = 1; index < candidates.length; index += 1) {
    if (candidates[index - 1]!.epochMillis === candidates[index]!.epochMillis) {
      throw new Error(`Crypto Rust bars contain duplicate minute ${candidates[index]!.timestamp}.`);
    }
  }
  return candidates.slice(-CRYPTO_RUST_MAX_INPUT_BARS);
}

function confirmedUtcSessions(bars: readonly PreparedBar[]): {
  started: string[];
  complete: string[];
} {
  const byDate = new Map<string, PreparedBar[]>();
  for (const bar of bars) {
    const session = byDate.get(bar.session_date);
    if (session) session.push(bar);
    else byDate.set(bar.session_date, [bar]);
  }
  const started: string[] = [];
  const complete: string[] = [];
  for (const [date, session] of byDate) {
    const start = Date.parse(`${date}T00:00:00.000Z`);
    if (session[0]?.epochMillis !== start) continue;
    started.push(date);
    if (
      session.length === 1_440
      && session.every((bar, index) => bar.epochMillis === start + index * 60_000)
    ) {
      complete.push(date);
    }
  }
  return { started, complete };
}

function availability(value: unknown, label: string): {
  status: string;
  reason: string;
} {
  const parsed = record(value, label);
  return {
    status: string(parsed.status, `${label}.status`, 64),
    reason: string(parsed.reason, `${label}.reason`, 500),
  };
}

const SCANNER_METRIC_KEYS = Object.freeze([
  "realized_volatility",
  "normalized_atr",
  "day_range_ratio",
  "bollinger_width_expansion",
  "relative_volume",
  "trading_amount",
  "spread_bps",
] as const);

function exactKeys(value: JsonRecord, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const normalizedExpected = [...expected].sort();
  if (
    actual.length !== normalizedExpected.length
    || actual.some((key, index) => key !== normalizedExpected[index])
  ) {
    throw new Error(`Crypto Rust ${label} does not match the exact worker schema.`);
  }
}

function scannerMetadata(value: unknown, label: string): Record<
  string,
  string | number | boolean | null
> {
  const source = record(value, label);
  const entries = Object.entries(source);
  if (entries.length > 16) {
    throw new Error(`Crypto Rust ${label} exceeds 16 entries.`);
  }
  return Object.fromEntries(entries.map(([key, item]) => {
    if (
      !/^[a-z][a-z0-9_]{0,63}$/.test(key)
      || (
        item !== null
        && typeof item !== "string"
        && typeof item !== "boolean"
        && (typeof item !== "number" || !Number.isFinite(item))
      )
      || (typeof item === "string" && item.length > 256)
    ) {
      throw new Error(`Crypto Rust ${label}.${key} is not a bounded JSON primitive.`);
    }
    return [key, item] as const;
  }));
}

function scannerAvailability(
  value: unknown,
  label: string,
): CryptoRustScannerMetric["availability"] {
  const source = record(value, label);
  exactKeys(source, ["status", "reason"], label);
  const status = string(source.status, `${label}.status`, 64);
  if (
    status !== "available"
    && status !== "partial"
    && status !== "insufficient_history"
    && status !== "volume_unavailable"
    && status !== "unsupported_instrument"
    && status !== "unavailable"
  ) {
    throw new Error(`Crypto Rust ${label}.status is unsupported.`);
  }
  return {
    status,
    reason: string(source.reason, `${label}.reason`, 500),
  };
}

function scannerMetric(
  value: unknown,
  label: string,
  nonNegative: boolean,
): CryptoRustScannerMetric {
  const source = record(value, label);
  exactKeys(source, ["availability", "value", "metadata"], label);
  if (!Object.hasOwn(source, "value")) {
    throw new Error(`Crypto Rust ${label}.value is required.`);
  }
  const metricAvailability = scannerAvailability(
    source.availability,
    `${label}.availability`,
  );
  const metricValue = nullableFinite(source.value, `${label}.value`);
  if (metricValue !== null && nonNegative && metricValue < 0) {
    throw new Error(`Crypto Rust ${label}.value must be non-negative.`);
  }
  if (metricAvailability.status === "available" && metricValue === null) {
    throw new Error(`Crypto Rust ${label} is available without a finite value.`);
  }
  if (
    metricValue !== null
    && !["available", "partial"].includes(metricAvailability.status)
  ) {
    throw new Error(`Crypto Rust ${label} exposes a value while unavailable.`);
  }
  return {
    availability: metricAvailability,
    value: metricValue,
    metadata: scannerMetadata(source.metadata, `${label}.metadata`),
  };
}

function scannerEvidence(
  value: unknown,
  originAt: string,
): CryptoRustScannerEvidence {
  const source = record(value, "result.instruments[0].scanner_metrics");
  exactKeys(source, SCANNER_METRIC_KEYS, "result.instruments[0].scanner_metrics");
  // Validate every field in the versioned worker struct. Only the two
  // liquidity metrics below are retained by this bounded projection.
  for (const key of SCANNER_METRIC_KEYS) {
    scannerMetric(
      source[key],
      `result.instruments[0].scanner_metrics.${key}`,
      key === "relative_volume" || key === "trading_amount" || key === "spread_bps",
    );
  }
  const relativeVolume = scannerMetric(
    source.relative_volume,
    "result.instruments[0].scanner_metrics.relative_volume",
    true,
  );
  const tradingAmount = scannerMetric(
    source.trading_amount,
    "result.instruments[0].scanner_metrics.trading_amount",
    true,
  );
  exactKeys(
    relativeVolume.metadata,
    ["baseline", "current_session_excluded"],
    "result.instruments[0].scanner_metrics.relative_volume.metadata",
  );
  if (
    relativeVolume.metadata.baseline !== "same_local_minute_prior_sessions"
    || relativeVolume.metadata.current_session_excluded !== true
  ) {
    throw new Error("Crypto Rust relative-volume provenance does not match the worker contract.");
  }
  exactKeys(
    tradingAmount.metadata,
    ["formula", "missing_policy"],
    "result.instruments[0].scanner_metrics.trading_amount.metadata",
  );
  if (
    tradingAmount.metadata.formula !== "sum(caller_supplied_final_bar_amount)"
    || tradingAmount.metadata.missing_policy
      !== "complete_current_session_coverage_required"
  ) {
    throw new Error("Crypto Rust trading-amount provenance does not match the worker contract.");
  }
  const retained = [tradingAmount, relativeVolume];
  return {
    schemaVersion: CRYPTO_RUST_SCANNER_EVIDENCE_SCHEMA_VERSION,
    originAt,
    tradingAmount,
    relativeVolume,
    provenance: {
      source: "rust_scalping_scanner_metrics",
      resultSchemaVersion: "scalping-analysis-result/v3",
      market: "BINANCE_USDM",
      quoteAsset: "USDT",
      interval: "1m",
      finalizedBarsOnly: true,
      tradingAmountSource: "quote_volume",
      relativeVolumeBaseline: "same_local_minute_prior_sessions",
      currentSessionExcluded: true,
    },
    components: {
      availableMetricCount: retained.filter((metric) => metric.value !== null).length,
      tradingAmount: tradingAmount.value,
      relativeVolume: relativeVolume.value,
    },
  };
}

function finiteValuePoint(
  value: unknown,
  label: string,
  originEpoch: number,
): CryptoRustTechnicalValuePoint | null {
  const point = record(value, label);
  if (point.state !== "available") return null;
  const at = isoInstant(point.timestamp, `${label}.timestamp`);
  if (Date.parse(at) > originEpoch) {
    throw new Error(`Crypto Rust ${label} contains a future calculation point.`);
  }
  const rawValues = record(point.values, `${label}.values`);
  const values = Object.fromEntries(
    Object.entries(rawValues)
      .filter(([, item]) => typeof item === "number" && Number.isFinite(item))
      .slice(0, 16),
  ) as Record<string, number>;
  return Object.keys(values).length ? { at, values } : null;
}

function calculation(
  value: unknown,
  expected: CryptoRustIndicatorDefinition,
  originEpoch: number,
): CryptoRustTechnicalCalculation {
  const parsed = record(value, `calculation ${expected.id}`);
  if (parsed.indicator_id !== expected.id || parsed.kind !== expected.kind) {
    throw new Error(`Crypto Rust calculation ${expected.id} identity does not match the request.`);
  }
  const actualParameters = record(
    parsed.parameters,
    `calculation ${expected.id}.parameters`,
  );
  const expectedParameters = expected.parameters ?? {};
  const actualParameterKeys = Object.keys(actualParameters).sort();
  const expectedParameterKeys = Object.keys(expectedParameters).sort();
  if (
    actualParameterKeys.length !== expectedParameterKeys.length
    || actualParameterKeys.some((key, index) => key !== expectedParameterKeys[index])
    || expectedParameterKeys.some((key) => actualParameters[key] !== expectedParameters[key])
  ) {
    throw new Error(`Crypto Rust calculation ${expected.id} parameters drifted from the request.`);
  }
  const points = array(
    parsed.points,
    `calculation ${expected.id}.points`,
    CRYPTO_RUST_OUTPUT_TAIL_POINTS,
  );
  let previousEpoch = Number.NEGATIVE_INFINITY;
  const finitePoints: CryptoRustTechnicalValuePoint[] = [];
  for (let index = 0; index < points.length; index += 1) {
    const rawPoint = record(points[index], `calculation ${expected.id}.points[${index}]`);
    const at = isoInstant(
      rawPoint.timestamp,
      `calculation ${expected.id}.points[${index}].timestamp`,
    );
    const epoch = Date.parse(at);
    if (epoch <= previousEpoch) {
      throw new Error(`Crypto Rust calculation ${expected.id} points are not strictly ordered.`);
    }
    if (epoch > originEpoch) {
      throw new Error(`Crypto Rust calculation ${expected.id} contains a future calculation point.`);
    }
    previousEpoch = epoch;
    const projected = finiteValuePoint(
      rawPoint,
      `calculation ${expected.id}.points[${index}]`,
      originEpoch,
    );
    if (projected) finitePoints.push(projected);
  }
  return {
    id: expected.id,
    kind: expected.kind,
    availability: availability(
      parsed.availability,
      `calculation ${expected.id}.availability`,
    ),
    latest: finitePoints.at(-1) ?? null,
    previous: finitePoints.at(-2) ?? null,
  };
}

function signalStatus(value: unknown): CryptoRustTechnicalAnalysis["status"] {
  if (
    value !== "watch"
    && value !== "entry_candidate"
    && value !== "hold"
    && value !== "exit_candidate"
  ) {
    throw new Error("Crypto Rust signal status is unsupported.");
  }
  return value;
}

function technicalSignal(
  status: CryptoRustTechnicalAnalysis["status"],
): CryptoRustTechnicalAnalysis["technicalSignal"] {
  if (status === "entry_candidate") return 1;
  if (status === "exit_candidate") return -1;
  return 0;
}

function multiTimeframeTrends(
  value: unknown,
): Record<string, "bullish" | "bearish" | "neutral" | null> {
  const parsed = record(value, "signal.multi_timeframe_trends");
  if (Object.keys(parsed).length > 16) {
    throw new Error("Crypto Rust signal.multi_timeframe_trends exceeds 16 entries.");
  }
  return Object.fromEntries(Object.entries(parsed).map(([key, trend]) => {
    if (
      trend !== null
      && trend !== "bullish"
      && trend !== "bearish"
      && trend !== "neutral"
    ) {
      throw new Error(`Crypto Rust signal.multi_timeframe_trends.${key} is unsupported.`);
    }
    return [key, trend];
  }));
}

function targetCandidate(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const range = record(value, "signal.target_price_range");
  const low = finite(range.low, "signal.target_price_range.low");
  const high = finite(range.high, "signal.target_price_range.high");
  if (high < low) throw new Error("Crypto Rust signal target range is inverted.");
  return (low + high) / 2;
}

function parseResult(
  value: unknown,
  symbol: string,
  bars: readonly PreparedBar[],
): CryptoRustTechnicalAnalysis {
  const originAt = bars.at(-1)!.timestamp;
  const originEpoch = Date.parse(originAt);
  const root = record(value, "result");
  if (
    root.schema_version !== "scalping-analysis-result/v3"
    || root.scalping_engine_version !== CRYPTO_RUST_SCALPING_ENGINE_VERSION
    || root.indicator_engine_version !== TECHNICAL_INDICATOR_ENGINE_VERSION
    || root.response_mode !== "full_series"
    || root.interval_minutes !== 1
  ) {
    throw new Error("Crypto Rust result contract does not match scalping-analysis-result/v3.");
  }
  const instruments = array(root.instruments, "result.instruments", 1);
  if (instruments.length !== 1) {
    throw new Error("Crypto Rust result must contain exactly one instrument.");
  }
  const instrument = record(instruments[0], "result.instruments[0]");
  if (instrument.instrument_key !== symbol) {
    throw new Error("Crypto Rust result instrument does not match the requested symbol.");
  }
  if (nonNegativeInteger(instrument.bar_count, "result.instruments[0].bar_count") !== bars.length) {
    throw new Error("Crypto Rust result bar count does not match the causal input.");
  }

  const rawCalculations = array(
    instrument.indicators,
    "result.instruments[0].indicators",
    CRYPTO_RUST_INDICATORS.length,
  );
  if (rawCalculations.length !== CRYPTO_RUST_INDICATORS.length) {
    throw new Error("Crypto Rust result omitted one or more requested indicators.");
  }
  const byId = new Map<string, unknown>();
  rawCalculations.forEach((item, index) => {
    const parsed = record(item, `result.instruments[0].indicators[${index}]`);
    const id = string(parsed.indicator_id, `indicator[${index}].indicator_id`, 128);
    if (parsed.instrument_key !== symbol) {
      throw new Error(`Crypto Rust calculation ${id} references another instrument.`);
    }
    if (byId.has(id)) {
      throw new Error(`Crypto Rust result contains duplicate calculation ${id}.`);
    }
    byId.set(id, item);
  });
  const calculations = CRYPTO_RUST_INDICATORS.map((expected) => {
    const raw = byId.get(expected.id);
    if (raw === undefined) {
      throw new Error(`Crypto Rust result is missing calculation ${expected.id}.`);
    }
    return calculation(raw, expected, originEpoch);
  });

  const signals = record(instrument.signals, "result.instruments[0].signals");
  const points = array(
    signals.points,
    "result.instruments[0].signals.points",
    CRYPTO_RUST_OUTPUT_TAIL_POINTS,
  );
  if (points.length === 0) throw new Error("Crypto Rust result has no assistance signal.");
  let lastSignalEpoch = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < points.length; index += 1) {
    const point = record(points[index], `signal.points[${index}]`);
    const at = isoInstant(point.calculation_timestamp, `signal.points[${index}].calculation_timestamp`);
    const epoch = Date.parse(at);
    if (epoch <= lastSignalEpoch || epoch > originEpoch) {
      throw new Error("Crypto Rust assistance signals are unordered or future-dated.");
    }
    const signalAt = isoInstant(
      point.signal_timestamp,
      `signal.points[${index}].signal_timestamp`,
    );
    const eligibleAt = isoInstant(
      point.earliest_eligible_timestamp,
      `signal.points[${index}].earliest_eligible_timestamp`,
    );
    if (
      signalAt !== at
      || eligibleAt !== new Date(epoch + 60_000).toISOString()
    ) {
      throw new Error("Crypto Rust assistance signal violates the finalized-bar barrier.");
    }
    lastSignalEpoch = epoch;
  }
  const latest = record(points.at(-1), "signal.latest");
  const calculationAt = isoInstant(latest.calculation_timestamp, "signal.calculation_timestamp");
  const signalAt = isoInstant(latest.signal_timestamp, "signal.signal_timestamp");
  const earliestEligibleAt = isoInstant(
    latest.earliest_eligible_timestamp,
    "signal.earliest_eligible_timestamp",
  );
  const expectedEligibleAt = new Date(originEpoch + 60_000).toISOString();
  if (
    calculationAt !== originAt
    || signalAt !== originAt
    || earliestEligibleAt !== expectedEligibleAt
  ) {
    throw new Error("Crypto Rust signal timestamps do not preserve the finalized-bar barrier.");
  }
  const status = signalStatus(latest.status);
  const confidence = finite(latest.confidence, "signal.confidence");
  if (confidence < 0 || confidence > 1) {
    throw new Error("Crypto Rust signal.confidence must be in 0..1.");
  }

  const instrumentQuality = record(instrument.data_quality, "instrument.data_quality");
  const signalQuality = availability(latest.data_quality, "signal.data_quality");
  const finalBarCount = nonNegativeInteger(
    instrumentQuality.final_bar_count,
    "instrument.data_quality.final_bar_count",
  );
  if (finalBarCount !== bars.length) {
    throw new Error("Crypto Rust data-quality bar count does not match the input.");
  }
  const parsedScannerEvidence = scannerEvidence(instrument.scanner_metrics, originAt);
  const marketEvidence = parseRustMarketEvidenceV2(instrument.market_evidence);
  if (!marketEvidence || marketEvidence.originAt !== originAt) {
    throw new Error("Crypto Rust market evidence v2 is missing or violates the origin boundary.");
  }

  return {
    schemaVersion: CRYPTO_RUST_TECHNICAL_SCHEMA_VERSION,
    symbol,
    scalpingEngineVersion: CRYPTO_RUST_SCALPING_ENGINE_VERSION,
    indicatorEngineVersion: TECHNICAL_INDICATOR_ENGINE_VERSION,
    originAt,
    calculationAt,
    signalAt,
    earliestEligibleAt,
    status,
    technicalSignal: technicalSignal(status),
    basisPrice: finite(latest.basis_price, "signal.basis_price"),
    stopCandidatePrice: nullableFinite(
      latest.stop_candidate_price,
      "signal.stop_candidate_price",
    ),
    targetCandidatePrice: targetCandidate(latest.target_price_range),
    confidence,
    confidenceSemantics: string(
      latest.confidence_semantics,
      "signal.confidence_semantics",
      500,
    ),
    quality: {
      status: string(instrumentQuality.status, "instrument.data_quality.status", 64),
      reason: signalQuality.reason,
      reasons: boundedStrings(instrumentQuality.reasons, "instrument.data_quality.reasons", 100),
      finalBarCount,
      sameSessionGapCount: nonNegativeInteger(
        instrumentQuality.same_session_gap_count,
        "instrument.data_quality.same_session_gap_count",
      ),
      missingVolumeCount: nonNegativeInteger(
        instrumentQuality.missing_volume_count,
        "instrument.data_quality.missing_volume_count",
      ),
      missingAmountCount: nonNegativeInteger(
        instrumentQuality.missing_amount_count,
        "instrument.data_quality.missing_amount_count",
      ),
    },
    multiTimeframeAgreement: string(
      latest.multi_timeframe_agreement,
      "signal.multi_timeframe_agreement",
      64,
    ),
    multiTimeframeTrends: multiTimeframeTrends(latest.multi_timeframe_trends),
    rationale: boundedStrings(latest.rationale, "signal.rationale", 100),
    calculations,
    scannerEvidence: parsedScannerEvidence,
    marketEvidence,
    input: {
      interval: "1m",
      barCount: bars.length,
      firstFinalizedAt: bars[0]!.timestamp,
      lastFinalizedAt: originAt,
      outputTailPoints: CRYPTO_RUST_OUTPUT_TAIL_POINTS,
      usesOhlc: true,
      usesVolume: true,
      usesQuoteVolumeAsAmount: true,
    },
  };
}

export class CryptoRustTechnicalAnalyzer {
  constructor(private readonly rust: CryptoRustComputePort) {}

  async analyze(input: CryptoRustTechnicalAnalyzeInput): Promise<CryptoRustTechnicalAnalysis> {
    const symbol = normalizeSymbol(input.symbol);
    const bars = prepareBars(symbol, input.bars);
    const sessions = confirmedUtcSessions(bars);
    const originAt = bars.at(-1)!.timestamp;
    const validateCausalSnapshot = (observedAt: string, label: string): string => {
      const parsed = isoInstant(observedAt, label);
      if (Date.parse(parsed) > Date.parse(originAt)) {
        throw new Error(`Crypto Rust ${label} must not be after the decision origin.`);
      }
      return parsed;
    };
    const orderbook = input.orderbook
      ? {
        timestamp: validateCausalSnapshot(
          input.orderbook.observedAt,
          "orderbook.observedAt",
        ),
        bid_volume: finite(input.orderbook.bidQuantity, "orderbook.bidQuantity"),
        ask_volume: finite(input.orderbook.askQuantity, "orderbook.askQuantity"),
        best_bid: finite(input.orderbook.bidPrice, "orderbook.bidPrice"),
        best_ask: finite(input.orderbook.askPrice, "orderbook.askPrice"),
      }
      : undefined;
    const tradeStats = input.tradeStats
      ? {
        timestamp: validateCausalSnapshot(
          input.tradeStats.observedAt,
          "tradeStats.observedAt",
        ),
        buy_volume: finite(input.tradeStats.buyVolume, "tradeStats.buyVolume"),
        sell_volume: finite(input.tradeStats.sellVolume, "tradeStats.sellVolume"),
      }
      : undefined;
    const result = await this.rust.compute<unknown>(
      "scalping_analysis",
      {
        scalping_analysis: {
          schema_version: "scalping-analysis-request/v3",
          response_mode: "full_series",
          adjustment_policy: "unadjusted",
          interval_minutes: 1,
          instruments: [{
            key: symbol,
            symbol,
            market: "BINANCE_USDM",
            currency: "USDT",
            instrument_type: "crypto",
            bars: bars.map(({ epochMillis: _epochMillis, ...bar }) => bar),
            session_start_confirmed_dates: sessions.started,
            complete_session_dates: sessions.complete,
            session_windows: [],
            session_window_overrides: [],
            ...(orderbook ? { orderbook } : {}),
            ...(tradeStats ? { trade_stats: tradeStats } : {}),
          }],
          indicators: CRYPTO_RUST_INDICATORS,
          relative_volume_lookback_sessions: 5,
          signal: {
            enabled: true,
            preset: input.preset,
            entry_buffer_bps: 15,
            stop_loss_bps: 100,
            target_reward_ratio: 2,
          },
          output_projection: {
            series_tail_points: CRYPTO_RUST_OUTPUT_TAIL_POINTS,
            signal_snapshots: [],
          },
        },
      },
      {
        includeArtifacts: false,
        ...(input.signal ? { signal: input.signal } : {}),
      },
    );
    return parseResult(result.result, symbol, bars);
  }
}
