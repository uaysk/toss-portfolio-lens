import { createHash } from "node:crypto";
import type { SimulationModelLane } from "../simulation/contracts.js";
import {
  AiResponseSchema,
  CHRONOS_2_MODEL_ID,
  FINCAST_MODEL_ID,
  FINCAST_QUALIFICATION_QUANTILE_ROWS,
  QuantileRearrangementObservationsSchema,
  SCALPING_AI_HORIZONS,
  SCALPING_AI_QUANTILES,
  type AiForecastRequest,
  type QuantileRearrangementObservations as WorkerQuantileRearrangementObservations,
} from "../worker/ai-contract.js";
import type { FuturesSide } from "./futures-paper-ledger.js";
import type { ReturnQuantile } from "./futures-risk.js";

export const DEFAULT_CONTEXT_BARS = 512;
export const CHRONOS2_CONTEXT_BARS = 1024;

const PRECISION_FAILURE_REASONS = [
  "non_finite_output",
  "quantile_postprocessing_failed",
  "signal_direction_agreement_below_99pct",
  "q50_median_error_above_5pct_fp32_iqr",
  "q50_p95_error_above_15pct_fp32_iqr",
  "peak_vram_reduction_below_25pct",
  "mixed_cuda_out_of_memory",
  "mixed_unsupported_operation",
  "mixed_setup_failure",
  "mixed_model_load_failure",
  "mixed_inference_failure",
  "mixed_evaluation_failure",
] as const;
const PINNED_GPU_DEVICE_NAME = "Tesla P40";
const PINNED_GPU_CUDA_CAPABILITY = "6.1";
const SAFE_GPU_DEVICE_NAME = /^[A-Za-z0-9 ._()+-]{1,128}$/;

type UnknownRecord = Record<string, unknown>;
type ModelPrecision = "fp16" | "fp32";
export type ModelPrecisionValidation = "not_required" | "passed" | "fallback_fp32";
export type ModelMemoryStatus = "ok";
export type ModelQuantileMonotonicityPolicy =
  | "native"
  | "fp32_monotone_rearrangement_v1"
  | "chronos2_fp32_monotone_rearrangement_v1";
export type ModelQuantileTailPolicy = "native" | "tail_clamped_q10_q90";
export type ModelPeakVramMeasurement = "cuda_allocated_or_reserved";
export type PrecisionFailureReason = typeof PRECISION_FAILURE_REASONS[number];
export type ModelQuantileObservations = {
  rowCount: number;
  nonFiniteValueCount: number;
  crossingRowCount: number;
  crossingAdjacentPairCount: number;
  adjustedRowCount: number;
  q50AdjustmentIqrRatioMedian: number;
  q50AdjustmentIqrRatioP95: number;
  q50AdjustmentIqrRatioMax: number;
  postprocessedMonotonic: boolean;
};

type PinnedModelRuntimeProvenance = {
  modelId: typeof FINCAST_MODEL_ID | typeof CHRONOS_2_MODEL_ID;
  modelRevision: string;
  sourceRevision: string;
  loaderVersion: string;
  license: "MIT" | "Apache-2.0";
  tokenizerId: string | null;
  tokenizerRevision: string | null;
};

const PINNED_MODEL_RUNTIME_PROVENANCE = {
  fincast: {
    modelId: FINCAST_MODEL_ID,
    modelRevision: "2d7d90b159db8961d27c2cf165d51195902ef92b",
    sourceRevision: "488b19d1d85fa2b3d4b93469530cefdcf1cc97a4",
    loaderVersion: "fincast-source-488b19d",
    license: "Apache-2.0",
    tokenizerId: null,
    tokenizerRevision: null,
  },
  chronos2: {
    modelId: CHRONOS_2_MODEL_ID,
    modelRevision: "254b5357164a84326913b0695216f690752ac55d",
    sourceRevision: "v2.3.1",
    loaderVersion: "chronos-forecasting-2.3.1-compact_causal_v1",
    license: "Apache-2.0",
    tokenizerId: null,
    tokenizerRevision: null,
  },
} as const satisfies Record<SimulationModelLane, PinnedModelRuntimeProvenance>;

export type RuntimeModelForecastPoint = {
  horizonMinutes: number;
  targetTimestamp: string;
  q10Price: number;
  medianPrice: number;
  q90Price: number;
  upProbability?: number;
};

export type RuntimeTargetStopEvidence = {
  status: "available" | "unavailable";
  side?: FuturesSide;
  targetFirstProbabilityLower?: number;
  targetFirstProbabilityUpper?: number;
  stopFirstProbabilityLower?: number;
  stopFirstProbabilityUpper?: number;
  ambiguousProbability?: number;
  neitherProbability?: number;
  reason?: string;
};

export type NormalizedLaneForecast = {
  lane: SimulationModelLane;
  generatedAt: number;
  generatedAtIso: string;
  inputEndAt: string;
  quantiles: ReturnQuantile[];
  horizonDistributions: Array<{
    horizonMinutes: 5 | 15 | 30 | 60;
    quantiles: ReturnQuantile[];
    nativeQuantiles: ReturnQuantile[];
    upProbability?: number;
    downProbability?: number;
    flatProbability?: number;
    intervalWidth?: number;
  }>;
  displayPoints: RuntimeModelForecastPoint[];
  upProbability?: number;
  downProbability?: number;
  flatProbability?: number;
  probabilityMethod: "sample_paths" | "derived_quantile_cdf" | "unavailable";
  expectedVolatility?: number;
  volatilityMethod: "path_realized" | "quantile_implied_sigma" | "unavailable";
  uncertaintyIntervalWidth?: number;
  validPathCount: number;
  invalidPathCount: number;
  targetStop: RuntimeTargetStopEvidence;
  modelId: string;
  modelRevision: string;
  sourceRevision: string;
  loaderVersion: string;
  license: string;
  tokenizerId: string | null;
  tokenizerRevision: string | null;
  loaded: true;
  device: "cuda";
  deviceName: string;
  cudaCapability: "6.1";
  attentionBackend: "math";
  precision: ModelPrecision;
  precisionValidation: ModelPrecisionValidation;
  memoryStatus: ModelMemoryStatus;
  quantileMonotonicityPolicy: ModelQuantileMonotonicityPolicy;
  fp32QuantileObservations?: ModelQuantileObservations;
  mixedQuantileObservations?: ModelQuantileObservations | null;
  quantileTailPolicy: ModelQuantileTailPolicy;
  precisionFailureReasons: PrecisionFailureReason[];
  latencyMs?: number;
  peakVramBytes?: number;
  peakVramMeasurement?: ModelPeakVramMeasurement;
  peakVramMb?: number;
};

type CryptoModelInputBar = AiForecastRequest["series"][number]["bars"][number];

function record(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : undefined;
}

function finite(value: unknown): number | undefined {
  if (value === null || value === undefined || typeof value === "boolean") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= 500 ? normalized : undefined;
}

function exactText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 500
    ? value
    : undefined;
}

function nullableExactText(value: unknown): string | null | undefined {
  if (value === null) return null;
  return exactText(value);
}

function first(source: UnknownRecord | undefined, ...keys: string[]): unknown {
  if (!source) return undefined;
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null) return source[key];
  }
  return undefined;
}

function timestamp(value: unknown): number | undefined {
  const candidate = text(value);
  if (!candidate) return undefined;
  const parsed = Date.parse(candidate);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function iso(value: number): string {
  return new Date(value).toISOString();
}

function pythonFloatHex(value: number): string {
  if (!Number.isFinite(value)) {
    throw new Error("Crypto model input contains a non-finite number.");
  }
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value, false);
  const bits = view.getBigUint64(0, false);
  const negative = (bits >> 63n) === 1n;
  const exponentBits = Number((bits >> 52n) & 0x7ffn);
  const fractionBits = bits & 0xfffffffffffffn;
  const sign = negative ? "-" : "";
  if (exponentBits === 0 && fractionBits === 0n) {
    return `${sign}0x0.0p+0`;
  }
  const fraction = fractionBits.toString(16).padStart(13, "0");
  if (exponentBits === 0) {
    return `${sign}0x0.${fraction}p-1022`;
  }
  const exponent = exponentBits - 1023;
  return `${sign}0x1.${fraction}p${exponent >= 0 ? "+" : ""}${exponent}`;
}

function pythonUtcMicrosecondTimestamp(value: string): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new Error("Crypto model input contains an invalid timestamp.");
  }
  return new Date(milliseconds).toISOString().replace(/Z$/, "000Z");
}

function matchesWorkerTimestamp(value: unknown, expected: string): boolean {
  const candidate = exactText(value);
  return candidate === expected || candidate === pythonUtcMicrosecondTimestamp(expected);
}

export function canonicalCryptoModelInputDigest(
  bars: readonly CryptoModelInputBar[],
): string {
  const number = (value: number | null | undefined): string | null => (
    value === null || value === undefined ? null : pythonFloatHex(value)
  );
  const payload = bars.map((bar) => ({
    amount: number(bar.amount),
    benchmark_return: number(bar.benchmark_return),
    btc_realized_volatility: number(bar.btc_realized_volatility),
    btc_short_return: number(bar.btc_short_return),
    close: number(bar.close),
    complete: bar.complete,
    eth_realized_volatility: number(bar.eth_realized_volatility),
    eth_short_return: number(bar.eth_short_return),
    funding_rate: number(bar.funding_rate),
    high: number(bar.high),
    index_price: number(bar.index_price),
    low: number(bar.low),
    mark_price: number(bar.mark_price),
    open: number(bar.open),
    premium_index: number(bar.premium_index),
    relative_strength: number(bar.relative_strength),
    taker_buy_amount: number(bar.taker_buy_amount),
    taker_buy_volume: number(bar.taker_buy_volume),
    timestamp: pythonUtcMicrosecondTimestamp(bar.timestamp),
    trade_count: bar.trade_count ?? null,
    volume: number(bar.volume),
  }));
  return createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
}

function normalizedPrecision(value: unknown): ModelPrecision | undefined {
  if (value === "mixed_float16") return "fp16";
  if (value === "float32") return "fp32";
  return undefined;
}

function exactEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | undefined {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? value as T
    : undefined;
}

function normalizedPrecisionFailureReasons(value: unknown): PrecisionFailureReason[] | undefined {
  if (!Array.isArray(value) || value.length > PRECISION_FAILURE_REASONS.length) {
    return undefined;
  }
  const normalized: PrecisionFailureReason[] = [];
  for (const reason of value) {
    const candidate = exactEnum(reason, PRECISION_FAILURE_REASONS);
    if (!candidate || normalized.includes(candidate)) return undefined;
    normalized.push(candidate);
  }
  return normalized;
}

function normalizedQuantileObservations(
  value: unknown,
): ModelQuantileObservations | null | undefined {
  if (value === null) return null;
  const parsed = QuantileRearrangementObservationsSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const observations: WorkerQuantileRearrangementObservations = parsed.data;
  return {
    rowCount: observations.row_count,
    nonFiniteValueCount: observations.non_finite_value_count,
    crossingRowCount: observations.crossing_row_count,
    crossingAdjacentPairCount: observations.crossing_adjacent_pair_count,
    adjustedRowCount: observations.adjusted_row_count,
    q50AdjustmentIqrRatioMedian: observations.q50_adjustment_iqr_ratio_median,
    q50AdjustmentIqrRatioP95: observations.q50_adjustment_iqr_ratio_p95,
    q50AdjustmentIqrRatioMax: observations.q50_adjustment_iqr_ratio_max,
    postprocessedMonotonic: observations.postprocessed_monotonic,
  };
}

function safePeakVramBytes(value: unknown): number | undefined {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    ? value
    : undefined;
}

function displayQuantile(
  values: readonly unknown[],
  wanted: number,
): number | undefined {
  const matches = values.flatMap((value) => {
    const source = record(value);
    const quantile = finite(first(source, "quantile", "q"));
    const price = finite(first(source, "value", "price"));
    return quantile === wanted && price !== undefined && price > 0 ? [price] : [];
  });
  return matches.length === 1 ? matches[0] : undefined;
}

function normalizeDisplayForecastPoints(
  horizons: readonly UnknownRecord[],
  inputEndAt: string,
  expectedTargets: AiForecastRequest["series"][number]["future_timestamps"],
  expectedHorizons: AiForecastRequest["horizons_minutes"],
): RuntimeModelForecastPoint[] {
  const points = expectedHorizons.map((wantedHorizon) => {
    const horizon = horizons.find((item) => (
      finite(first(item, "horizon_minutes", "horizonMinutes")) === wantedHorizon
    ));
    const targetTimestamp = exactText(first(
      horizon,
      "target_timestamp",
      "targetTimestamp",
    ));
    const rawPrices = first(horizon, "price_quantiles", "priceQuantiles");
    const prices = Array.isArray(rawPrices) ? rawPrices : [];
    const orderedPrices = SCALPING_AI_QUANTILES.map((quantile) => (
      displayQuantile(prices, quantile)
    ));
    const q10Price = orderedPrices[SCALPING_AI_QUANTILES.indexOf(0.1)];
    const medianPrice = orderedPrices[SCALPING_AI_QUANTILES.indexOf(0.5)];
    const q90Price = orderedPrices[SCALPING_AI_QUANTILES.indexOf(0.9)];
    const upProbability = finite(first(horizon, "up_probability", "upProbability"));
    const expectedTargetTimestamp = expectedTargets[wantedHorizon - 1];
    if (!horizon
      || !targetTimestamp
      || !Number.isFinite(Date.parse(targetTimestamp))
      || Date.parse(targetTimestamp) <= Date.parse(inputEndAt)
      || !expectedTargetTimestamp
      || Date.parse(targetTimestamp) !== Date.parse(expectedTargetTimestamp)
      || prices.length !== SCALPING_AI_QUANTILES.length
      || orderedPrices.some((price) => price === undefined || price <= 0)
      || orderedPrices.some((price, index) => (
        index > 0 && price! < orderedPrices[index - 1]!
      ))
      || q10Price === undefined
      || medianPrice === undefined
      || q90Price === undefined
      || (upProbability !== undefined && (upProbability < 0 || upProbability > 1))) {
      throw new Error("model_price_quantiles_invalid");
    }
    return {
      horizonMinutes: wantedHorizon,
      targetTimestamp: iso(Date.parse(targetTimestamp)),
      q10Price,
      medianPrice,
      q90Price,
      ...(upProbability !== undefined ? { upProbability } : {}),
    };
  });
  for (let index = 1; index < points.length; index += 1) {
    if (Date.parse(points[index]!.targetTimestamp)
      <= Date.parse(points[index - 1]!.targetTimestamp)) {
      throw new Error("model_price_targets_non_monotone");
    }
  }
  return points;
}

function normalizedProbability(value: unknown): number | undefined {
  const parsed = finite(value);
  return parsed !== undefined && parsed >= 0 && parsed <= 1 ? parsed : undefined;
}

function normalizedNonnegativeInteger(value: unknown): number | undefined {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    ? value
    : undefined;
}

function normalizeTargetStopEvidence(
  value: unknown,
  requested: AiForecastRequest["series"][number]["target_stop"],
): RuntimeTargetStopEvidence {
  const source = record(value);
  const status = exactEnum(source?.status, ["available", "unavailable"] as const);
  if (!source || !status) throw new Error("model_target_stop_invalid");
  const reason = text(source.reason);
  const names = [
    ["targetFirstProbabilityLower", "target_first_probability_lower"],
    ["targetFirstProbabilityUpper", "target_first_probability_upper"],
    ["stopFirstProbabilityLower", "stop_first_probability_lower"],
    ["stopFirstProbabilityUpper", "stop_first_probability_upper"],
    ["ambiguousProbability", "ambiguous_probability"],
    ["neitherProbability", "neither_probability"],
  ] as const;
  const values = Object.fromEntries(names.map(([normalized, wire]) => [
    normalized,
    normalizedProbability(source[wire]),
  ])) as Record<(typeof names)[number][0], number | undefined>;
  if (status === "unavailable") {
    if (!reason || names.some(([, wire]) => source[wire] !== null && source[wire] !== undefined)) {
      throw new Error("model_target_stop_invalid");
    }
    return { status, reason };
  }
  if (!requested || reason
    || Object.values(values).some((probability) => probability === undefined)) {
    throw new Error("model_target_stop_invalid");
  }
  const targetLower = values.targetFirstProbabilityLower!;
  const targetUpper = values.targetFirstProbabilityUpper!;
  const stopLower = values.stopFirstProbabilityLower!;
  const stopUpper = values.stopFirstProbabilityUpper!;
  const ambiguous = values.ambiguousProbability!;
  const neither = values.neitherProbability!;
  if (
    targetLower > targetUpper
    || stopLower > stopUpper
    || Math.abs(targetLower + stopLower + ambiguous + neither - 1) > 1e-9
    || Math.abs(targetUpper - targetLower - ambiguous) > 1e-9
    || Math.abs(stopUpper - stopLower - ambiguous) > 1e-9
  ) {
    throw new Error("model_target_stop_invalid");
  }
  return {
    status,
    side: requested.side,
    targetFirstProbabilityLower: targetLower,
    targetFirstProbabilityUpper: targetUpper,
    stopFirstProbabilityLower: stopLower,
    stopFirstProbabilityUpper: stopUpper,
    ambiguousProbability: ambiguous,
    neitherProbability: neither,
  };
}

export function normalizeLaneForecast(
  lane: SimulationModelLane,
  raw: unknown,
  request: AiForecastRequest,
): NormalizedLaneForecast {
  const response = record(raw);
  if (!response) throw new Error("model_response_not_object");
  if (text(first(response, "request_id", "requestId")) !== request.request_id) {
    throw new Error("model_request_id_mismatch");
  }
  if (text(response.mode)?.toLowerCase() !== "forecast") {
    throw new Error("model_mode_mismatch");
  }
  const responseStatus = text(response.status)?.toLowerCase();
  if (responseStatus !== "available" && responseStatus !== "partial") {
    const unavailable = record(response.error);
    throw new Error(text(first(unavailable, "code", "message")) ?? "model_unavailable");
  }
  const generatedAt = timestamp(first(response, "generated_at", "generatedAt"));
  if (generatedAt === undefined) throw new Error("model_generated_at_invalid");

  const seriesValues = Array.isArray(response.series) ? response.series : [];
  const expectedSeries = request.series[0]!;
  const series = seriesValues
    .map(record)
    .find((item) => text(first(item, "instrument_key", "instrumentKey"))
      === expectedSeries.instrument_key);
  if (!series || text(series.status)?.toLowerCase() !== "available") {
    throw new Error("model_series_unavailable");
  }
  const inputEndAt = exactText(first(series, "input_end_at", "inputEndAt"));
  if (!inputEndAt || !matchesWorkerTimestamp(inputEndAt, expectedSeries.input_end_at)) {
    throw new Error("model_input_origin_mismatch");
  }
  if (generatedAt < Date.parse(inputEndAt)) {
    throw new Error("model_generated_before_origin");
  }
  const horizons = Array.isArray(series.horizons)
    ? series.horizons.map(record).filter((item): item is UnknownRecord => item !== undefined)
    : [];
  const distributionHorizons = request.forecast_profile === "full"
    ? request.horizons_minutes
    : request.horizons_minutes.filter((horizonMinutes) => horizons.some((item) => finite(
        first(item, "horizon_minutes", "horizonMinutes"),
      ) === horizonMinutes));
  if (distributionHorizons.length === 0) {
    throw new Error("model_return_quantiles_incomplete");
  }
  const horizonDistributions = distributionHorizons.map((horizonMinutes) => {
    const source = horizons.find((item) => finite(
      first(item, "horizon_minutes", "horizonMinutes"),
    ) === horizonMinutes);
    if (!source) throw new Error("model_return_quantiles_incomplete");
    const fixedRaw = first(source, "return_quantiles", "returnQuantiles");
    if (!Array.isArray(fixedRaw) || fixedRaw.length !== SCALPING_AI_QUANTILES.length) {
      throw new Error("model_return_quantiles_incomplete");
    }
    const normalizedFixed = fixedRaw.map((item, index): ReturnQuantile => {
      const entry = record(item);
      const quantile = finite(first(entry, "quantile", "q"));
      const returnRate = finite(first(entry, "value", "return_rate", "returnRate"));
      if (quantile !== SCALPING_AI_QUANTILES[index] || returnRate === undefined) {
        throw new Error("model_return_quantiles_invalid");
      }
      return { quantile, returnRate };
    });
    const nativeRaw = first(
      source,
      "native_return_quantiles",
      "nativeReturnQuantiles",
    );
    const normalizedNative = nativeRaw === undefined
      || (Array.isArray(nativeRaw) && nativeRaw.length === 0)
      ? normalizedFixed
      : Array.isArray(nativeRaw)
        ? nativeRaw.map((item): ReturnQuantile => {
          const entry = record(item);
          const quantile = finite(first(entry, "quantile", "q"));
          const returnRate = finite(first(entry, "value", "return_rate", "returnRate"));
          if (
            quantile === undefined
            || quantile <= 0
            || quantile >= 1
            || returnRate === undefined
          ) throw new Error("model_native_quantiles_invalid");
          return { quantile, returnRate };
        })
        : [];
    if (
      normalizedNative.length < normalizedFixed.length
      || normalizedNative.some((item, index) => (
        index > 0
        && (
          item.quantile <= normalizedNative[index - 1]!.quantile
          || item.returnRate < normalizedNative[index - 1]!.returnRate
        )
      ))
      || (lane === "chronos2" && (
        normalizedNative[0]?.quantile !== 0.01
        || normalizedNative.at(-1)?.quantile !== 0.99
      ))
    ) throw new Error("model_native_quantiles_invalid");
    const readProbability = (snake: string, camel: string): number | undefined => {
      const value = first(source, snake, camel);
      if (value === undefined || value === null) return undefined;
      const parsed = normalizedProbability(value);
      if (parsed === undefined) throw new Error("model_direction_probabilities_invalid");
      return parsed;
    };
    const rawWidth = first(
      source,
      "uncertainty_interval_width",
      "uncertaintyIntervalWidth",
    );
    const intervalWidth = rawWidth === undefined || rawWidth === null
      ? undefined
      : finite(rawWidth);
    if (rawWidth !== undefined && rawWidth !== null
      && (intervalWidth === undefined || intervalWidth < 0)) {
      throw new Error("model_distribution_method_invalid");
    }
    return {
      horizonMinutes,
      quantiles: normalizedFixed,
      nativeQuantiles: normalizedNative,
      ...(readProbability("up_probability", "upProbability") === undefined
        ? {}
        : { upProbability: readProbability("up_probability", "upProbability") }),
      ...(readProbability("down_probability", "downProbability") === undefined
        ? {}
        : { downProbability: readProbability("down_probability", "downProbability") }),
      ...(readProbability("flat_probability", "flatProbability") === undefined
        ? {}
        : { flatProbability: readProbability("flat_probability", "flatProbability") }),
      ...(intervalWidth === undefined ? {} : { intervalWidth }),
    };
  });
  const displayPoints = normalizeDisplayForecastPoints(
    horizons,
    inputEndAt,
    expectedSeries.future_timestamps,
    request.horizons_minutes,
  );
  const horizon = horizons.find((item) => finite(
    first(item, "horizon_minutes", "horizonMinutes"),
  ) === SCALPING_AI_HORIZONS[0]);
  const rawQuantiles = horizon && Array.isArray(
    first(horizon, "return_quantiles", "returnQuantiles"),
  )
    ? first(horizon, "return_quantiles", "returnQuantiles") as unknown[]
    : [];
  if (rawQuantiles.length !== SCALPING_AI_QUANTILES.length) {
    throw new Error("model_return_quantiles_incomplete");
  }
  const quantiles = rawQuantiles.map((item, index): ReturnQuantile => {
    const entry = record(item);
    const quantile = finite(first(entry, "quantile", "q"));
    const returnRate = finite(first(entry, "value", "return_rate", "returnRate"));
    if (quantile !== SCALPING_AI_QUANTILES[index] || returnRate === undefined) {
      throw new Error("model_return_quantiles_invalid");
    }
    return { quantile, returnRate };
  });
  for (let index = 1; index < quantiles.length; index += 1) {
    if (quantiles[index]!.returnRate < quantiles[index - 1]!.returnRate) {
      throw new Error("model_return_quantiles_non_monotone");
    }
  }
  const optionalProbability = (key: string, camel: string): number | undefined => {
    const rawValue = first(horizon, key, camel);
    if (rawValue === undefined || rawValue === null) return undefined;
    const parsed = normalizedProbability(rawValue);
    if (parsed === undefined) throw new Error("model_direction_probabilities_invalid");
    return parsed;
  };
  const upProbability = optionalProbability("up_probability", "upProbability");
  const downProbability = optionalProbability("down_probability", "downProbability");
  const flatProbability = optionalProbability("flat_probability", "flatProbability");
  if (
    upProbability !== undefined
    && downProbability !== undefined
    && flatProbability !== undefined
    && Math.abs(upProbability + downProbability + flatProbability - 1) > 1e-6
  ) {
    throw new Error("model_direction_probabilities_invalid");
  }
  const rawProbabilityMethod = first(horizon, "probability_method", "probabilityMethod");
  const probabilityMethod = rawProbabilityMethod === undefined
    ? "unavailable" as const
    : exactEnum(
        rawProbabilityMethod,
        ["sample_paths", "derived_quantile_cdf", "unavailable"] as const,
      );
  const rawVolatilityMethod = first(horizon, "volatility_method", "volatilityMethod");
  const volatilityMethod = rawVolatilityMethod === undefined
    ? "unavailable" as const
    : exactEnum(
        rawVolatilityMethod,
        ["path_realized", "quantile_implied_sigma", "unavailable"] as const,
      );
  if (!probabilityMethod || !volatilityMethod) {
    throw new Error("model_distribution_method_invalid");
  }
  const auxiliaryProbabilitiesReported = downProbability !== undefined
    || flatProbability !== undefined;
  if (
    rawProbabilityMethod !== undefined
    && (
      probabilityMethod === "unavailable"
        ? upProbability !== undefined || auxiliaryProbabilitiesReported
        : upProbability === undefined
          || downProbability === undefined
          || flatProbability === undefined
          || Math.abs(upProbability + downProbability + flatProbability - 1) > 1e-9
    )
  ) {
    throw new Error("model_direction_probabilities_invalid");
  }
  if (
    rawProbabilityMethod === undefined
    && auxiliaryProbabilitiesReported
    && (
      upProbability === undefined
      || downProbability === undefined
      || flatProbability === undefined
      || Math.abs(upProbability + downProbability + flatProbability - 1) > 1e-9
    )
  ) {
    throw new Error("model_direction_probabilities_invalid");
  }
  const optionalNonnegative = (key: string, camel: string): number | undefined => {
    const rawValue = first(horizon, key, camel);
    if (rawValue === undefined || rawValue === null) return undefined;
    const parsed = finite(rawValue);
    if (parsed === undefined || parsed < 0) throw new Error("model_distribution_metric_invalid");
    return parsed;
  };
  const expectedVolatility = optionalNonnegative(
    "expected_volatility",
    "expectedVolatility",
  );
  const uncertaintyIntervalWidth = optionalNonnegative(
    "uncertainty_interval_width",
    "uncertaintyIntervalWidth",
  );
  const rawValidPathCount = first(horizon, "valid_path_count", "validPathCount");
  const rawInvalidPathCount = first(horizon, "invalid_path_count", "invalidPathCount");
  const validPathCount = rawValidPathCount === undefined
    ? 0
    : normalizedNonnegativeInteger(rawValidPathCount);
  const invalidPathCount = rawInvalidPathCount === undefined
    ? 0
    : normalizedNonnegativeInteger(rawInvalidPathCount);
  if (validPathCount === undefined || invalidPathCount === undefined) {
    throw new Error("model_path_count_invalid");
  }
  const rawTargetStop = first(horizon, "target_stop", "targetStop");
  const targetStop = rawTargetStop === undefined
    ? { status: "unavailable" as const, reason: "not_reported" }
    : normalizeTargetStopEvidence(rawTargetStop, expectedSeries.target_stop);

  const modelRuns = Array.isArray(first(response, "model_runs", "modelRuns"))
    ? first(response, "model_runs", "modelRuns") as unknown[]
    : [];
  if (modelRuns.length !== 1) throw new Error("model_lane_count_mismatch");
  const laneRun = record(modelRuns[0]);
  const role = text(first(laneRun, "role", "lane"))?.toLowerCase().replaceAll("-", "_");
  if (
    role !== lane
    && !(lane === "chronos2" && role === "chronos_2")
  ) {
    throw new Error("model_lane_identity_mismatch");
  }
  const expectedContext = expectedSeries.bars.slice(
    -(lane === "chronos2" ? CHRONOS2_CONTEXT_BARS : DEFAULT_CONTEXT_BARS),
  );
  const expectedContextStartAt = expectedContext[0]?.timestamp;
  const rawInputOrigins = first(laneRun, "input_origins", "inputOrigins");
  const inputOrigins = Array.isArray(rawInputOrigins) ? rawInputOrigins.map(record) : [];
  const inputOrigin = inputOrigins[0];
  const originBarCount = first(inputOrigin, "bar_count", "barCount");
  const originInputDigest = exactText(first(inputOrigin, "input_digest", "inputDigest"));
  if (!expectedContextStartAt
    || inputOrigins.length !== 1
    || !inputOrigin
    || exactText(first(inputOrigin, "instrument_key", "instrumentKey"))
      !== expectedSeries.instrument_key
    || !matchesWorkerTimestamp(
      first(inputOrigin, "context_start_at", "contextStartAt"),
      expectedContextStartAt,
    )
    || !matchesWorkerTimestamp(
      first(inputOrigin, "input_end_at", "inputEndAt"),
      expectedSeries.input_end_at,
    )
    || typeof originBarCount !== "number"
    || !Number.isSafeInteger(originBarCount)
    || originBarCount !== expectedContext.length
    || !originInputDigest
    || !/^[0-9a-f]{64}$/.test(originInputDigest)
    || originInputDigest !== canonicalCryptoModelInputDigest(expectedContext)
    || first(laneRun, "input_end_aligned", "inputEndAligned") !== true) {
    throw new Error("model_input_origin_mismatch");
  }
  const model = record(first(laneRun, "model", "provenance"))
    ?? record(first(response, "model", "provenance"));
  const pinned = PINNED_MODEL_RUNTIME_PROVENANCE[lane];
  if (exactText(first(laneRun, "expected_model_id", "expectedModelId")) !== pinned.modelId
    || exactText(first(model, "model_id", "modelId", "id")) !== pinned.modelId) {
    throw new Error("model_identity_mismatch");
  }
  const modelId = exactText(first(model, "model_id", "modelId", "id"));
  const modelRevision = exactText(first(model, "model_revision", "modelRevision", "revision"));
  const sourceRevision = exactText(first(model, "source_revision", "sourceRevision"));
  const loaderVersion = exactText(first(model, "loader_version", "loaderVersion"));
  const license = exactText(first(model, "license"));
  if (modelId !== pinned.modelId
    || modelRevision !== pinned.modelRevision
    || sourceRevision !== pinned.sourceRevision
    || loaderVersion !== pinned.loaderVersion
    || license !== pinned.license) {
    throw new Error("model_provenance_invalid");
  }
  const rawTokenizerId = model?.tokenizer_id !== undefined
    ? model.tokenizer_id
    : model?.tokenizerId;
  const rawTokenizerRevision = model?.tokenizer_revision !== undefined
    ? model.tokenizer_revision
    : model?.tokenizerRevision;
  const tokenizerId = nullableExactText(rawTokenizerId);
  const tokenizerRevision = nullableExactText(rawTokenizerRevision);
  if (tokenizerId === undefined
    || tokenizerRevision === undefined
    || tokenizerId !== pinned.tokenizerId
    || tokenizerRevision !== pinned.tokenizerRevision) {
    throw new Error("model_tokenizer_provenance_invalid");
  }
  const loaded = first(model, "loaded");
  const device = exactText(first(model, "device"));
  const deviceName = exactText(first(model, "device_name", "deviceName"));
  const cudaCapability = exactText(first(model, "cuda_capability", "cudaCapability"));
  const attentionBackend = exactText(first(model, "attention_backend", "attentionBackend"));
  if (loaded !== true
    || device !== "cuda"
    || deviceName !== PINNED_GPU_DEVICE_NAME
    || !SAFE_GPU_DEVICE_NAME.test(deviceName)
    || cudaCapability !== PINNED_GPU_CUDA_CAPABILITY
    || attentionBackend !== "math") {
    throw new Error("model_runtime_provenance_invalid");
  }
  const precision = normalizedPrecision(first(model, "dtype", "precision"));
  if (!precision) throw new Error("model_precision_invalid");

  const rawPrecisionValidation = first(
    model,
    "precision_validation",
    "precisionValidation",
  );
  const rawMemoryStatus = first(model, "memory_status", "memoryStatus");
  const rawQuantileMonotonicityPolicy = first(
    model,
    "quantile_monotonicity_policy",
    "quantileMonotonicityPolicy",
  );
  const rawFp32QuantileObservations = first(
    model,
    "fp32_quantile_observations",
    "fp32QuantileObservations",
  );
  const rawMixedQuantileObservations = (
    model && Object.prototype.hasOwnProperty.call(model, "mixed_quantile_observations")
      ? model.mixed_quantile_observations
      : model?.mixedQuantileObservations
  );
  const rawQuantileTailPolicy = first(
    model,
    "quantile_tail_policy",
    "quantileTailPolicy",
  );
  const rawPrecisionFailureReasons = first(
    model,
    "precision_failure_reasons",
    "precisionFailureReasons",
  );
  const precisionValidation = exactEnum(
    rawPrecisionValidation,
    ["not_required", "passed", "fallback_fp32"] as const,
  );
  const memoryStatus = exactEnum(rawMemoryStatus, ["ok"] as const);
  const quantileMonotonicityPolicy = exactEnum(
    rawQuantileMonotonicityPolicy,
    [
      "native",
      "fp32_monotone_rearrangement_v1",
      "chronos2_fp32_monotone_rearrangement_v1",
    ] as const,
  );
  const quantileTailPolicy = exactEnum(
    rawQuantileTailPolicy,
    ["native", "tail_clamped_q10_q90"] as const,
  );
  const precisionFailureReasons = normalizedPrecisionFailureReasons(
    rawPrecisionFailureReasons,
  );
  if (!precisionValidation) throw new Error("model_precision_validation_invalid");
  if (!memoryStatus) throw new Error("model_memory_status_invalid");
  if (!quantileMonotonicityPolicy) {
    throw new Error("model_quantile_monotonicity_policy_invalid");
  }
  if (!quantileTailPolicy) throw new Error("model_quantile_tail_policy_invalid");
  if (!precisionFailureReasons) {
    throw new Error("model_precision_failure_reasons_invalid");
  }
  const fp32QuantileObservations = rawFp32QuantileObservations === undefined
    ? undefined
    : normalizedQuantileObservations(rawFp32QuantileObservations);
  const mixedQuantileObservations = rawMixedQuantileObservations === undefined
    ? undefined
    : normalizedQuantileObservations(rawMixedQuantileObservations);

  const legacyVramKeys = [
    "peak_vram_mb",
    "peakVramMb",
    "peakVramBytes",
    "peakVramMeasurement",
  ] as const;
  if (legacyVramKeys.some((key) => (
    Object.prototype.hasOwnProperty.call(model, key)
    || Object.prototype.hasOwnProperty.call(laneRun, key)
  ))) {
    throw new Error("model_peak_vram_invalid");
  }
  const rawPeakVramBytes = model?.peak_vram_bytes;
  const rawPeakVramMeasurement = model?.peak_vram_measurement;
  const peakVramBytes = rawPeakVramBytes === undefined
    ? undefined
    : safePeakVramBytes(rawPeakVramBytes);
  const peakVramMeasurement = rawPeakVramMeasurement === undefined
    ? undefined
    : exactEnum(rawPeakVramMeasurement, ["cuda_allocated_or_reserved"] as const);
  if ((rawPeakVramBytes !== undefined && peakVramBytes === undefined)
    || (rawPeakVramMeasurement !== undefined && peakVramMeasurement === undefined)
    || ((peakVramBytes === undefined) !== (peakVramMeasurement === undefined))) {
    throw new Error("model_peak_vram_invalid");
  }
  const peakVramMb = peakVramBytes === undefined
    ? undefined
    : peakVramBytes / (1024 * 1024);

  if (lane === "chronos2") {
    const expectedMonotonicity = "chronos2_fp32_monotone_rearrangement_v1";
    if (precision !== "fp32"
      || precisionValidation !== "not_required"
      || memoryStatus !== "ok"
      || quantileMonotonicityPolicy !== expectedMonotonicity
      || (fp32QuantileObservations !== undefined && fp32QuantileObservations !== null)
      || (mixedQuantileObservations !== undefined && mixedQuantileObservations !== null)
      || quantileTailPolicy !== "native"
      || precisionFailureReasons.length > 0) {
      throw new Error("model_precision_provenance_invalid");
    }
  } else {
    const mixedRuntimeFailed = precisionFailureReasons
      .some((reason) => reason.startsWith("mixed_"));
    const validFp32Observations = fp32QuantileObservations !== undefined
      && fp32QuantileObservations !== null
      && fp32QuantileObservations.rowCount === FINCAST_QUALIFICATION_QUANTILE_ROWS
      && fp32QuantileObservations.nonFiniteValueCount === 0
      && fp32QuantileObservations.postprocessedMonotonic;
    const validMixedObservations = mixedRuntimeFailed
      ? mixedQuantileObservations === null
      : mixedQuantileObservations !== undefined
        && mixedQuantileObservations !== null
        && mixedQuantileObservations.rowCount === FINCAST_QUALIFICATION_QUANTILE_ROWS
        && precisionFailureReasons.includes("non_finite_output")
          === (mixedQuantileObservations.nonFiniteValueCount > 0)
        && precisionFailureReasons.includes("quantile_postprocessing_failed")
          === (
            mixedQuantileObservations.nonFiniteValueCount === 0
            && !mixedQuantileObservations.postprocessedMonotonic
          );
    const mixedPrecisionValid = precision === "fp16"
      && precisionValidation === "passed"
      && precisionFailureReasons.length === 0;
    const fp32FallbackValid = precision === "fp32"
      && precisionValidation === "fallback_fp32"
      && precisionFailureReasons.length > 0;
    if (!validFp32Observations || !validMixedObservations) {
      throw new Error("model_quantile_observations_invalid");
    }
    if ((!mixedPrecisionValid && !fp32FallbackValid)
      || memoryStatus !== "ok"
      || quantileMonotonicityPolicy !== "fp32_monotone_rearrangement_v1"
      || quantileTailPolicy !== "tail_clamped_q10_q90"
      || peakVramBytes === undefined
      || peakVramBytes <= 0
      || peakVramMeasurement !== "cuda_allocated_or_reserved") {
      throw new Error("model_precision_provenance_invalid");
    }
  }
  if (!AiResponseSchema.safeParse(response).success) {
    throw new Error("model_response_contract_invalid");
  }
  return {
    lane,
    generatedAt,
    generatedAtIso: iso(generatedAt),
    inputEndAt,
    quantiles,
    horizonDistributions,
    displayPoints,
    ...(upProbability === undefined ? {} : { upProbability }),
    ...(downProbability === undefined ? {} : { downProbability }),
    ...(flatProbability === undefined ? {} : { flatProbability }),
    probabilityMethod,
    ...(expectedVolatility === undefined ? {} : { expectedVolatility }),
    volatilityMethod,
    ...(uncertaintyIntervalWidth === undefined ? {} : { uncertaintyIntervalWidth }),
    validPathCount,
    invalidPathCount,
    targetStop,
    modelId,
    modelRevision,
    sourceRevision,
    loaderVersion,
    license,
    tokenizerId,
    tokenizerRevision,
    loaded: true,
    device: "cuda",
    deviceName,
    cudaCapability: PINNED_GPU_CUDA_CAPABILITY,
    attentionBackend: "math",
    precision,
    precisionValidation,
    memoryStatus,
    quantileMonotonicityPolicy,
    fp32QuantileObservations: fp32QuantileObservations ?? undefined,
    mixedQuantileObservations,
    quantileTailPolicy,
    precisionFailureReasons,
    latencyMs: finite(first(laneRun, "latency_ms", "latencyMs"))
      ?? finite(first(response, "latency_ms", "latencyMs")),
    peakVramBytes,
    peakVramMeasurement,
    peakVramMb,
  };
}
