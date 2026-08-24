import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

export const SCALPING_AI_SCHEMA_VERSION = "scalping-ai/v2" as const;
export const SCALPING_AI_HORIZONS = [5, 15, 30, 60] as const;
export const SCALPING_AI_REALTIME_HORIZONS = [5, 15] as const;
export const SCALPING_AI_QUANTILES = [0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95] as const;
export const FINCAST_MODEL_ID = "Vincent05R/FinCast" as const;
export const CHRONOS_2_MODEL_ID = "amazon/chronos-2" as const;

const finite = z.number().finite();
const positive = finite.positive();
const nonnegative = finite.nonnegative();
const timestamp = z.string().max(64).refine((value) => (
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  && Number.isFinite(Date.parse(value))
), "RFC3339 timestamp with offset is required");
const timestampMillis = (value: string) => Date.parse(value);
const requestId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const fullHorizons = z.tuple([
  z.literal(5), z.literal(15), z.literal(30), z.literal(60),
]);
const realtimeHorizons = z.tuple([z.literal(5), z.literal(15)]);
const horizons = z.union([realtimeHorizons, fullHorizons]);
const quantiles = z.tuple([
  z.literal(0.05), z.literal(0.1), z.literal(0.25), z.literal(0.5),
  z.literal(0.75), z.literal(0.9), z.literal(0.95),
]);

export const AiPriceBarSchema = z.object({
  timestamp,
  open: positive,
  high: positive,
  low: positive,
  close: positive,
  volume: nonnegative.nullable().optional(),
  amount: nonnegative.nullable().optional(),
  trade_count: z.number().int().nonnegative().nullable().optional(),
  taker_buy_volume: nonnegative.nullable().optional(),
  taker_buy_amount: nonnegative.nullable().optional(),
  mark_price: positive.nullable().optional(),
  index_price: positive.nullable().optional(),
  premium_index: finite.nullable().optional(),
  funding_rate: finite.nullable().optional(),
  btc_short_return: finite.nullable().optional(),
  btc_realized_volatility: nonnegative.nullable().optional(),
  eth_short_return: finite.nullable().optional(),
  eth_realized_volatility: nonnegative.nullable().optional(),
  benchmark_return: finite.nullable().optional(),
  relative_strength: finite.nullable().optional(),
  complete: z.literal(true),
}).strict().superRefine((bar, context) => {
  if (bar.low > Math.min(bar.open, bar.close) || bar.high < Math.max(bar.open, bar.close) || bar.low > bar.high) {
    context.addIssue({ code: "custom", message: "OHLC bounds are invalid" });
  }
});
export type AiPriceBar = z.infer<typeof AiPriceBarSchema>;

export const AiTargetStopSchema = z.object({
  side: z.enum(["long", "short"]),
  target_price: positive,
  stop_price: positive,
}).strict().refine((item) => item.target_price !== item.stop_price, "target and stop must differ");

export const AiSeriesCadenceSchema = z.object({
  candle_seconds: z.union([
    z.literal(5), z.literal(15), z.literal(30), z.literal(60),
  ]),
  gap_policy: z.enum(["continuous", "market_session_prevalidated"]),
}).strict().superRefine((cadence, context) => {
  if (cadence.gap_policy === "market_session_prevalidated" && cadence.candle_seconds !== 60) {
    context.addIssue({
      code: "custom",
      path: ["candle_seconds"],
      message: "market-session FinCast inputs must use one-minute candles",
    });
  }
});
export type AiSeriesCadence = z.infer<typeof AiSeriesCadenceSchema>;

const futureTimestamps = z.array(timestamp).min(15).max(60).superRefine((items, context) => {
  if (items.length !== 15 && items.length !== 60) {
    context.addIssue({
      code: "custom",
      message: "future timestamps must contain exactly 15 or 60 values",
    });
  }
  for (let index = 1; index < items.length; index += 1) {
    if (timestampMillis(items[index]!) <= timestampMillis(items[index - 1]!)) {
      context.addIssue({ code: "custom", path: [index], message: "future timestamps must be increasing" });
    }
  }
});

function validateChronologicalBars(
  bars: ReadonlyArray<{ timestamp: string }>,
  context: z.RefinementCtx,
): void {
  for (let index = 1; index < bars.length; index += 1) {
    if (timestampMillis(bars[index]!.timestamp) <= timestampMillis(bars[index - 1]!.timestamp)) {
      context.addIssue({
        code: "custom",
        path: ["bars", index, "timestamp"],
        message: "bars must be strictly increasing by instant",
      });
    }
  }
}

const requestBase = {
  schema_version: z.literal(SCALPING_AI_SCHEMA_VERSION),
  request_id: requestId,
  horizons_minutes: horizons,
  quantiles,
  seed: z.number().int().min(0).max(2_147_483_647),
};

function validateUniqueInstrumentKeys(
  series: ReadonlyArray<{ instrument_key: string }>,
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  series.forEach((item, index) => {
    if (seen.has(item.instrument_key)) {
      context.addIssue({
        code: "custom",
        path: ["series", index, "instrument_key"],
        message: "instrument_key values must be unique",
      });
    }
    seen.add(item.instrument_key);
  });
}

const ForecastSeriesSchema = z.object({
  instrument_key: z.string().min(1).max(128),
  timezone: z.string().min(1).max(64),
  input_end_at: timestamp,
  future_timestamps: futureTimestamps,
  bars: z.array(AiPriceBarSchema).min(1).max(20_000),
  target_stop: AiTargetStopSchema.nullable().optional(),
  input_cadence: AiSeriesCadenceSchema.nullable().optional(),
}).strict().superRefine((series, context) => {
  validateChronologicalBars(series.bars, context);
  const last = series.bars.at(-1);
  if (last && timestampMillis(last.timestamp) !== timestampMillis(series.input_end_at)) {
    context.addIssue({ code: "custom", path: ["input_end_at"], message: "must equal final bar timestamp" });
  }
  if (timestampMillis(series.future_timestamps[0]!) <= timestampMillis(series.input_end_at)) {
    context.addIssue({ code: "custom", path: ["future_timestamps", 0], message: "must be after input_end_at" });
  }
  if (series.target_stop && last) {
    const { side, target_price: target, stop_price: stop } = series.target_stop;
    if ((side === "long" && !(stop < last.close && last.close < target))
      || (side === "short" && !(target < last.close && last.close < stop))) {
      context.addIssue({ code: "custom", path: ["target_stop"], message: "does not bracket final close" });
    }
  }
});

const EvaluationOriginSchema = z.object({
  origin: timestamp,
  future_timestamps: futureTimestamps,
  technical_signal: z.union([z.literal(-1), z.literal(0), z.literal(1)]).nullable().optional(),
  regime: z.string().min(1).max(64).nullable().optional(),
  target_stop: AiTargetStopSchema.nullable().optional(),
}).strict();

const EvaluationSeriesSchema = z.object({
  instrument_key: z.string().min(1).max(128),
  timezone: z.string().min(1).max(64),
  bars: z.array(AiPriceBarSchema).min(1).max(100_000),
  origins: z.array(EvaluationOriginSchema).min(1).max(10_000),
  input_cadence: AiSeriesCadenceSchema.nullable().optional(),
}).strict().superRefine((series, context) => {
  validateChronologicalBars(series.bars, context);
  const barIndexByInstant = new Map<number, number>();
  series.bars.forEach((bar, index) => barIndexByInstant.set(timestampMillis(bar.timestamp), index));
  let previousOrigin = Number.NEGATIVE_INFINITY;
  series.origins.forEach((origin, originIndex) => {
    const originMillis = timestampMillis(origin.origin);
    if (originMillis <= previousOrigin) {
      context.addIssue({
        code: "custom",
        path: ["origins", originIndex, "origin"],
        message: "origins must be strictly increasing by instant",
      });
    }
    previousOrigin = originMillis;
    const barIndex = barIndexByInstant.get(originMillis);
    if (barIndex === undefined) {
      context.addIssue({
        code: "custom",
        path: ["origins", originIndex, "origin"],
        message: "origin must match a completed bar timestamp",
      });
      return;
    }
    const expected = series.bars.slice(barIndex + 1, barIndex + 61);
    if (expected.length !== 60) {
      context.addIssue({
        code: "custom",
        path: ["origins", originIndex, "future_timestamps"],
        message: "origin must have 60 subsequent completed bars",
      });
      return;
    }
    origin.future_timestamps.forEach((value, futureIndex) => {
      if (timestampMillis(value) !== timestampMillis(expected[futureIndex]!.timestamp)) {
        context.addIssue({
          code: "custom",
          path: ["origins", originIndex, "future_timestamps", futureIndex],
          message: "future timestamps must match the next 60 bars exactly",
        });
      }
    });
    const originClose = series.bars[barIndex]!.close;
    if (origin.target_stop) {
      const { side, target_price: target, stop_price: stop } = origin.target_stop;
      if ((side === "long" && !(stop < originClose && originClose < target))
        || (side === "short" && !(target < originClose && originClose < stop))) {
        context.addIssue({
          code: "custom",
          path: ["origins", originIndex, "target_stop"],
          message: "target and stop must bracket the origin close",
        });
      }
    }
  });
});

export const AiCostAssumptionsSchema = z.object({
  commission_bps_per_side: finite.min(0).max(1_000),
  tax_bps_on_exit: finite.min(0).max(1_000),
  spread_bps_round_trip: finite.min(0).max(5_000),
  slippage_bps_per_side: finite.min(0).max(5_000),
}).strict();

export const AiForecastRequestSchema = z.object({
  ...requestBase,
  mode: z.literal("forecast"),
  forecast_profile: z.enum(["full", "realtime_5_15"]).optional(),
  series: z.array(ForecastSeriesSchema).min(1).max(50),
}).strict().superRefine((request, context) => {
  validateUniqueInstrumentKeys(request.series, context);
  const profile = request.forecast_profile ?? "full";
  const expectedHorizons = profile === "realtime_5_15"
    ? SCALPING_AI_REALTIME_HORIZONS
    : SCALPING_AI_HORIZONS;
  const expectedTimestampCount = expectedHorizons.at(-1)!;
  if (request.horizons_minutes.length !== expectedHorizons.length
    || request.horizons_minutes.some((value, index) => value !== expectedHorizons[index])) {
    context.addIssue({
      code: "custom",
      path: ["horizons_minutes"],
      message: `${profile} forecast horizon profile is required`,
    });
  }
  request.series.forEach((series, index) => {
    if (series.future_timestamps.length !== expectedTimestampCount) {
      context.addIssue({
        code: "custom",
        path: ["series", index, "future_timestamps"],
        message: `${profile} requires ${expectedTimestampCount} future timestamps`,
      });
    }
  });
});

export const AiEvaluateRequestSchema = z.object({
  ...requestBase,
  mode: z.literal("evaluate"),
  series: z.array(EvaluationSeriesSchema).min(1).max(50),
  cost_assumptions: AiCostAssumptionsSchema,
}).strict().superRefine((request, context) => {
  validateUniqueInstrumentKeys(request.series, context);
  if (request.horizons_minutes.length !== SCALPING_AI_HORIZONS.length
    || request.horizons_minutes.some((value, index) => value !== SCALPING_AI_HORIZONS[index])) {
    context.addIssue({
      code: "custom",
      path: ["horizons_minutes"],
      message: "evaluation requires the full horizon profile",
    });
  }
  request.series.forEach((series, seriesIndex) => {
    series.origins.forEach((origin, originIndex) => {
      if (origin.future_timestamps.length !== 60) {
        context.addIssue({
          code: "custom",
          path: ["series", seriesIndex, "origins", originIndex, "future_timestamps"],
          message: "evaluation requires 60 future timestamps",
        });
      }
    });
  });
});

export const AiRequestSchema = z.discriminatedUnion("mode", [AiForecastRequestSchema, AiEvaluateRequestSchema]);
export type AiRequest = z.infer<typeof AiRequestSchema>;
export type AiForecastRequest = z.infer<typeof AiForecastRequestSchema>;
export type AiEvaluateRequest = z.infer<typeof AiEvaluateRequestSchema>;

/**
 * Precision qualification covers 128 fixed contexts plus two deterministic
 * price-scale stress contexts at each supported native cadence:
 * 15s/240, 30s/120, and 60s/60.
 */
export const FINCAST_QUALIFICATION_QUANTILE_ROWS = 130 * (240 + 120 + 60);
export const MAX_Q50_ADJUSTMENT_IQR_RATIO = 1_000_000_000;
const FINCAST_PRECISION_FAILURE_REASONS = [
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
export const QuantileRearrangementObservationsSchema = z.object({
  row_count: z.number().int().min(1).max(FINCAST_QUALIFICATION_QUANTILE_ROWS),
  non_finite_value_count: z.number().int().nonnegative(),
  crossing_row_count: z.number().int().nonnegative(),
  crossing_adjacent_pair_count: z.number().int().nonnegative(),
  adjusted_row_count: z.number().int().nonnegative(),
  q50_adjustment_iqr_ratio_median: finite.min(0).max(MAX_Q50_ADJUSTMENT_IQR_RATIO),
  q50_adjustment_iqr_ratio_p95: finite.min(0).max(MAX_Q50_ADJUSTMENT_IQR_RATIO),
  q50_adjustment_iqr_ratio_max: finite.min(0).max(MAX_Q50_ADJUSTMENT_IQR_RATIO),
  postprocessed_monotonic: z.boolean(),
}).strict().superRefine((observations, context) => {
  if (observations.non_finite_value_count > observations.row_count * 9) {
    context.addIssue({
      code: "custom",
      path: ["non_finite_value_count"],
      message: "non-finite quantile count exceeds the bounded native output shape",
    });
  }
  if (observations.crossing_row_count > observations.row_count) {
    context.addIssue({
      code: "custom",
      path: ["crossing_row_count"],
      message: "crossing quantile row count exceeds observed rows",
    });
  }
  if (observations.crossing_adjacent_pair_count > observations.row_count * 8) {
    context.addIssue({
      code: "custom",
      path: ["crossing_adjacent_pair_count"],
      message: "crossing adjacent-pair count exceeds the bounded native output shape",
    });
  }
  if (observations.adjusted_row_count > observations.row_count) {
    context.addIssue({
      code: "custom",
      path: ["adjusted_row_count"],
      message: "adjusted quantile row count exceeds observed rows",
    });
  }
  if (!(observations.q50_adjustment_iqr_ratio_median
    <= observations.q50_adjustment_iqr_ratio_p95
    && observations.q50_adjustment_iqr_ratio_p95
    <= observations.q50_adjustment_iqr_ratio_max)) {
    context.addIssue({
      code: "custom",
      path: ["q50_adjustment_iqr_ratio_p95"],
      message: "q50 adjustment summaries must be ordered",
    });
  }
  if (observations.adjusted_row_count === 0
    && (observations.q50_adjustment_iqr_ratio_median !== 0
      || observations.q50_adjustment_iqr_ratio_p95 !== 0
      || observations.q50_adjustment_iqr_ratio_max !== 0)) {
    context.addIssue({
      code: "custom",
      path: ["q50_adjustment_iqr_ratio_median"],
      message: "zero adjusted rows require zero q50 adjustment summaries",
    });
  }
});
export type QuantileRearrangementObservations = z.infer<
  typeof QuantileRearrangementObservationsSchema
>;

export const AiModelProvenanceSchema = z.object({
  model_id: z.string().min(1).max(256),
  model_revision: z.string().min(1).max(256),
  tokenizer_id: z.string().min(1).max(256).nullable().optional(),
  tokenizer_revision: z.string().min(1).max(256).nullable().optional(),
  source_revision: z.string().min(1).max(256),
  loader_version: z.string().min(1).max(128),
  license: z.string().min(1).max(64),
  device: z.enum(["cuda", "cpu", "unavailable"]),
  device_name: z.string().min(1).max(256).nullable().optional(),
  cuda_capability: z.string().regex(/^\d+\.\d+$/).max(16).nullable().optional(),
  dtype: z.enum(["float32", "mixed_float16"]),
  attention_backend: z.enum(["math", "unavailable"]),
  loaded: z.boolean(),
  precision_validation: z.enum(["not_required", "passed", "fallback_fp32", "unavailable"]).optional(),
  peak_vram_bytes: z.number().int().nonnegative().nullable().optional(),
  peak_vram_measurement: z.literal("cuda_allocated_or_reserved").nullable().optional(),
  memory_status: z.enum(["ok", "memory_pressure", "unavailable"]).optional(),
  quantile_monotonicity_policy: z.enum([
    "native",
    "fp32_monotone_rearrangement_v1",
    "chronos2_fp32_monotone_rearrangement_v1",
    "unavailable",
  ]).optional(),
  fp32_quantile_observations: QuantileRearrangementObservationsSchema.nullable().optional(),
  mixed_quantile_observations: QuantileRearrangementObservationsSchema.nullable().optional(),
  quantile_tail_policy: z.enum(["native", "tail_clamped_q10_q90", "unavailable"]).optional(),
  precision_failure_reasons: z.array(z.string().min(1).max(300)).optional(),
  fallback_from: z.string().min(1).max(256).nullable().optional(),
  fallback_reason: z.string().min(1).max(500).nullable().optional(),
}).strict().superRefine((model, context) => {
  if (model.loaded && (model.device === "unavailable" || model.attention_backend !== "math")) {
    context.addIssue({ code: "custom", message: "loaded model requires an execution device and math attention" });
  }
  if (!model.loaded && (model.device !== "unavailable" || model.attention_backend !== "unavailable")) {
    context.addIssue({ code: "custom", message: "unloaded model runtime must be unavailable" });
  }
  const deviceName = model.device_name ?? null;
  const cudaCapability = model.cuda_capability ?? null;
  if (model.device !== "cuda" && (deviceName !== null || cudaCapability !== null)) {
    context.addIssue({ code: "custom", path: ["device_name"], message: "CUDA metadata requires a CUDA model" });
  }
  if ((deviceName === null) !== (cudaCapability === null)) {
    context.addIssue({
      code: "custom",
      path: ["cuda_capability"],
      message: "CUDA device name and capability must be recorded together",
    });
  }
  if (model.dtype === "mixed_float16" && model.precision_validation !== "passed") {
    context.addIssue({
      code: "custom",
      path: ["precision_validation"],
      message: "mixed_float16 provenance requires passed precision validation",
    });
  }
  const peakVramBytes = model.peak_vram_bytes ?? null;
  const peakVramMeasurement = model.peak_vram_measurement ?? null;
  if (peakVramBytes !== null && !model.loaded) {
    context.addIssue({
      code: "custom",
      path: ["peak_vram_bytes"],
      message: "peak VRAM is valid only for a loaded model",
    });
  }
  if ((peakVramBytes === null) !== (peakVramMeasurement === null)) {
    context.addIssue({
      code: "custom",
      path: ["peak_vram_measurement"],
      message: "peak VRAM value and measurement basis must be recorded together",
    });
  }
  if (model.model_id === CHRONOS_2_MODEL_ID) {
    const invalidChronos2Precision = model.dtype !== "float32"
      || (model.precision_validation !== undefined
        && model.precision_validation !== (model.loaded ? "not_required" : "unavailable"))
      || (model.memory_status !== undefined
        && model.memory_status !== (model.loaded ? "ok" : "unavailable"))
      || (model.quantile_monotonicity_policy !== undefined
        && model.quantile_monotonicity_policy !== (
          model.loaded ? "chronos2_fp32_monotone_rearrangement_v1" : "unavailable"
        ))
      || (model.fp32_quantile_observations !== undefined
        && model.fp32_quantile_observations !== null)
      || (model.mixed_quantile_observations !== undefined
        && model.mixed_quantile_observations !== null)
      || (model.quantile_tail_policy !== undefined
        && model.quantile_tail_policy !== (model.loaded ? "native" : "unavailable"))
      || (model.precision_failure_reasons?.length ?? 0) > 0;
    if (invalidChronos2Precision) {
      context.addIssue({
        code: "custom",
        message: "Chronos-2 requires monotone-rearranged native float32 provenance",
      });
    }
  }
  if (model.model_id === FINCAST_MODEL_ID) {
    if (model.loaded) {
      const precisionFailureReasons = model.precision_failure_reasons ?? [];
      const validPrecisionFailureReasons = precisionFailureReasons.length
        <= FINCAST_PRECISION_FAILURE_REASONS.length
        && new Set(precisionFailureReasons).size === precisionFailureReasons.length
        && precisionFailureReasons.every((reason) => (
          (FINCAST_PRECISION_FAILURE_REASONS as readonly string[]).includes(reason)
        ));
      const fp32Observations = model.fp32_quantile_observations;
      const mixedObservations = model.mixed_quantile_observations;
      const mixedRuntimeFailed = precisionFailureReasons
        .some((reason) => reason.startsWith("mixed_"));
      const validFp32Observations = fp32Observations !== undefined
        && fp32Observations !== null
        && fp32Observations.row_count === FINCAST_QUALIFICATION_QUANTILE_ROWS
        && fp32Observations.non_finite_value_count === 0
        && fp32Observations.postprocessed_monotonic;
      const validMixedObservations = mixedRuntimeFailed
        ? mixedObservations === null
        : mixedObservations !== undefined
          && mixedObservations !== null
          && mixedObservations.row_count === FINCAST_QUALIFICATION_QUANTILE_ROWS
          && precisionFailureReasons.includes("non_finite_output")
            === (mixedObservations.non_finite_value_count > 0)
          && precisionFailureReasons.includes("quantile_postprocessing_failed")
            === (
              mixedObservations.non_finite_value_count === 0
              && !mixedObservations.postprocessed_monotonic
            );
      const validPrecision = (
        model.dtype === "mixed_float16"
        && model.precision_validation === "passed"
        && (model.precision_failure_reasons?.length ?? 0) === 0
      ) || (
        model.dtype === "float32"
        && model.precision_validation === "fallback_fp32"
        && (model.precision_failure_reasons?.length ?? 0) > 0
      );
      if (!validPrecisionFailureReasons
        || !validPrecision
        || !validFp32Observations
        || !validMixedObservations
        || peakVramBytes === null
        || peakVramBytes <= 0
        || model.memory_status !== "ok"
        || model.quantile_monotonicity_policy !== "fp32_monotone_rearrangement_v1"
        || model.quantile_tail_policy !== "tail_clamped_q10_q90") {
        context.addIssue({
          code: "custom",
          message: "loaded FinCast requires complete validated precision and VRAM provenance",
        });
      }
    } else if (model.dtype !== "float32"
      || model.precision_validation !== "unavailable"
      || (model.memory_status !== "unavailable" && model.memory_status !== "memory_pressure")
      || model.quantile_monotonicity_policy !== "unavailable"
      || (model.fp32_quantile_observations !== undefined
        && model.fp32_quantile_observations !== null)
      || (model.mixed_quantile_observations !== undefined
        && model.mixed_quantile_observations !== null)
      || model.quantile_tail_policy !== "unavailable") {
      context.addIssue({
        code: "custom",
        message: "unavailable FinCast requires fail-closed runtime provenance",
      });
    }
  }
});
export type AiModelProvenance = z.infer<typeof AiModelProvenanceSchema>;

const UnavailableSchema = z.object({
  code: z.string().min(1).max(64),
  message: z.string().min(1).max(500),
}).strict();

const QuantileValueSchema = z.object({ quantile: finite.gt(0).lt(1), value: finite }).strict();
export const AiTargetStopBoundsSchema = z.object({
  status: z.enum(["available", "unavailable"]),
  target_first_probability_lower: finite.min(0).max(1).nullable().optional(),
  target_first_probability_upper: finite.min(0).max(1).nullable().optional(),
  stop_first_probability_lower: finite.min(0).max(1).nullable().optional(),
  stop_first_probability_upper: finite.min(0).max(1).nullable().optional(),
  ambiguous_probability: finite.min(0).max(1).nullable().optional(),
  neither_probability: finite.min(0).max(1).nullable().optional(),
  reason: z.string().max(500).nullable().optional(),
}).strict().superRefine((value, context) => {
  const probabilities = [
    value.target_first_probability_lower,
    value.target_first_probability_upper,
    value.stop_first_probability_lower,
    value.stop_first_probability_upper,
    value.ambiguous_probability,
    value.neither_probability,
  ];
  if (value.status === "unavailable") {
    if (!value.reason || probabilities.some((probability) => probability !== null
      && probability !== undefined)) {
      context.addIssue({
        code: "custom",
        message: "unavailable target/stop bounds require only a reason",
      });
    }
    return;
  }
  if (value.reason || probabilities.some((probability) => probability === null
    || probability === undefined)) {
    context.addIssue({
      code: "custom",
      message: "available target/stop bounds require every probability and no reason",
    });
    return;
  }
  const [
    targetLower,
    targetUpper,
    stopLower,
    stopUpper,
    ambiguous,
    neither,
  ] = probabilities as [number, number, number, number, number, number];
  const tolerance = 1e-9;
  if (
    targetLower > targetUpper
    || stopLower > stopUpper
    || Math.abs(targetLower + stopLower + ambiguous + neither - 1) > tolerance
    || Math.abs(targetUpper - targetLower - ambiguous) > tolerance
    || Math.abs(stopUpper - stopLower - ambiguous) > tolerance
  ) {
    context.addIssue({
      code: "custom",
      message: "target/stop probability bounds are inconsistent",
    });
  }
});

export const AiHorizonForecastSchema = z.object({
  horizon_minutes: z.union([z.literal(5), z.literal(15), z.literal(30), z.literal(60)]),
  target_timestamp: timestamp,
  return_quantiles: z.array(QuantileValueSchema).length(SCALPING_AI_QUANTILES.length),
  price_quantiles: z.array(QuantileValueSchema).length(SCALPING_AI_QUANTILES.length),
  native_return_quantiles: z.array(QuantileValueSchema).max(99).optional(),
  native_price_quantiles: z.array(QuantileValueSchema).max(99).optional(),
  up_probability: finite.min(0).max(1).nullable().optional(),
  down_probability: finite.min(0).max(1).nullable().optional(),
  flat_probability: finite.min(0).max(1).nullable().optional(),
  probability_method: z.enum(["sample_paths", "derived_quantile_cdf", "unavailable"]),
  expected_volatility: nonnegative.nullable().optional(),
  volatility_method: z.enum(["path_realized", "quantile_implied_sigma", "unavailable"]),
  uncertainty_interval_width: nonnegative.nullable().optional(),
  target_stop: AiTargetStopBoundsSchema,
  valid_path_count: z.number().int().nonnegative(),
  invalid_path_count: z.number().int().nonnegative(),
}).strict().superRefine((value, context) => {
  if (
    (value.native_return_quantiles === undefined)
    !== (value.native_price_quantiles === undefined)
  ) {
    context.addIssue({
      code: "custom",
      message: "native return and price quantiles must be present together",
    });
  }
  if (value.native_return_quantiles && value.native_price_quantiles) {
    if (
      (value.native_return_quantiles.length > 0 && value.native_return_quantiles.length < 7)
      || (value.native_price_quantiles.length > 0 && value.native_price_quantiles.length < 7)
    ) {
      context.addIssue({
        code: "custom",
        message: "non-empty native quantiles must contain at least seven points",
      });
    }
    for (const [key, quantiles] of [
      ["native_return_quantiles", value.native_return_quantiles],
      ["native_price_quantiles", value.native_price_quantiles],
    ] as const) {
      for (let index = 1; index < quantiles.length; index += 1) {
        if (
          quantiles[index]!.quantile <= quantiles[index - 1]!.quantile
          || quantiles[index]!.value < quantiles[index - 1]!.value
        ) {
          context.addIssue({
            code: "custom",
            path: [key, index],
            message: "native quantiles must be strictly keyed and value-monotone",
          });
        }
      }
    }
    if (value.native_return_quantiles.some((item, index) => (
      item.quantile !== value.native_price_quantiles![index]?.quantile
    ))) {
      context.addIssue({
        code: "custom",
        message: "native return and price quantile probabilities must align",
      });
    }
  }
  const probabilities = [
    value.up_probability,
    value.down_probability,
    value.flat_probability,
  ];
  if (value.probability_method === "unavailable") {
    if (probabilities.some((probability) => probability !== null
      && probability !== undefined)) {
      context.addIssue({
        code: "custom",
        message: "unavailable direction probabilities must all be null",
      });
    }
    return;
  }
  if (probabilities.some((probability) => probability === null
    || probability === undefined)) {
    context.addIssue({
      code: "custom",
      message: "available direction probabilities must all be present",
    });
    return;
  }
  const complete = probabilities as [number, number, number];
  if (Math.abs(complete.reduce((sum, probability) => sum + probability, 0) - 1) > 1e-9) {
    context.addIssue({
      code: "custom",
      message: "direction probabilities must sum to one",
    });
  }
});

const InputQualitySchema = z.object({
  status: z.enum(["good", "partial"]),
  bar_count: z.number().int().nonnegative(),
  missing_volume_ratio: finite.min(0).max(1),
  missing_amount_ratio: finite.min(0).max(1),
  irregular_interval_count: z.number().int().nonnegative(),
  warnings: z.array(z.string().max(500)).max(100),
}).strict();

const SeriesForecastResultSchema = z.object({
  instrument_key: z.string().min(1).max(256),
  status: z.enum(["available", "unavailable"]),
  input_end_at: timestamp,
  horizons: z.array(AiHorizonForecastSchema).max(4),
  input_quality: InputQualitySchema,
  distribution_shift: z.object({
    status: z.literal("unavailable"),
    reason: z.literal("reference_statistics_not_published"),
  }).strict(),
  unavailable: UnavailableSchema.nullable().optional(),
}).strict().superRefine((series, context) => {
  const horizonShape = series.horizons.map((item) => item.horizon_minutes);
  const matches = (expected: readonly number[]) => (
    horizonShape.length === expected.length
    && horizonShape.every((value, index) => value === expected[index])
  );
  if (series.status === "available"
    && (!matches(SCALPING_AI_REALTIME_HORIZONS)
      && !matches(SCALPING_AI_HORIZONS)
      || series.unavailable)) {
    context.addIssue({
      code: "custom",
      message: "available series must have ordered realtime or full horizons",
    });
  }
  if (series.status === "unavailable" && (series.horizons.length || !series.unavailable)) {
    context.addIssue({ code: "custom", message: "unavailable series must have a reason only" });
  }
});

const ModelRunInputOriginSchema = z.object({
  instrument_key: z.string().min(1).max(128),
  context_start_at: timestamp,
  input_end_at: timestamp,
  bar_count: z.number().int().min(1).max(20_000),
  input_digest: z.string().regex(/^[0-9a-f]{64}$/),
}).strict().superRefine((origin, context) => {
  if (timestampMillis(origin.context_start_at) > timestampMillis(origin.input_end_at)) {
    context.addIssue({
      code: "custom",
      path: ["context_start_at"],
      message: "context cannot start after input_end_at",
    });
  }
});

const ModelRunSchema = z.object({
  role: z.enum(["fincast", "chronos_2"]),
  expected_model_id: z.enum([
    FINCAST_MODEL_ID,
    CHRONOS_2_MODEL_ID,
  ]),
  status: z.enum(["available", "partial", "unavailable"]),
  model: AiModelProvenanceSchema,
  generated_at: timestamp,
  latency_ms: nonnegative,
  degraded: z.boolean(),
  fallback_used: z.boolean(),
  fallback_reason: z.string().min(1).max(500).nullable().optional(),
  input_origins: z.array(ModelRunInputOriginSchema).min(1).max(10_000),
  input_end_aligned: z.literal(true),
  raw_series: z.array(SeriesForecastResultSchema).min(1).max(10_000),
}).strict().superRefine((run, context) => {
  const expectedModelId = run.role === "chronos_2"
      ? CHRONOS_2_MODEL_ID
      : FINCAST_MODEL_ID;
  if (run.expected_model_id !== expectedModelId || run.model.model_id !== expectedModelId) {
    context.addIssue({
      code: "custom",
      path: ["expected_model_id"],
      message: "model run role and expected model identity must match",
    });
  }
  if (run.degraded
    || run.fallback_used
    || (run.fallback_reason ?? null) !== null
    || (run.model.fallback_from ?? null) !== null
    || (run.model.fallback_reason ?? null) !== null) {
    context.addIssue({
      code: "custom",
      path: ["model"],
      message: "independent model run cannot contain degraded or model fallback provenance",
    });
  }
  if (run.input_origins.length !== run.raw_series.length) {
    context.addIssue({ code: "custom", path: ["raw_series"], message: "results must align with input origins" });
  } else {
    run.input_origins.forEach((origin, index) => {
      const result = run.raw_series[index]!;
      if (origin.instrument_key !== result.instrument_key
        || timestampMillis(origin.input_end_at) !== timestampMillis(result.input_end_at)) {
        context.addIssue({
          code: "custom",
          path: ["raw_series", index],
          message: "result must align exactly with its input origin",
        });
      }
    });
  }
  if (new Set(run.input_origins.map((item) => item.instrument_key)).size !== run.input_origins.length) {
    context.addIssue({ code: "custom", path: ["input_origins"], message: "instrument keys must be unique" });
  }
  const available = run.raw_series.filter((item) => item.status === "available").length;
  const expectedStatus = available === run.raw_series.length ? "available" : available > 0 ? "partial" : "unavailable";
  if (run.status !== expectedStatus) {
    context.addIssue({ code: "custom", path: ["status"], message: "run status must summarize raw series" });
  }
});

const MetricGroupSchema = z.object({
  count: z.number().int().nonnegative(),
  direction_accuracy: finite.min(0).max(1).nullable().optional(),
  mae: nonnegative.nullable().optional(),
  rmse: nonnegative.nullable().optional(),
}).strict();
const CalibrationBinSchema = z.object({
  lower: finite.min(0).max(1),
  upper: finite.min(0).max(1),
  count: z.number().int().nonnegative(),
  mean_probability: finite.min(0).max(1).nullable().optional(),
  observed_frequency: finite.min(0).max(1).nullable().optional(),
}).strict();
const StrategyComparisonSchema = z.object({
  technical_trade_count: z.number().int().nonnegative(),
  ai_filtered_trade_count: z.number().int().nonnegative(),
  technical_net_return: finite,
  ai_filtered_net_return: finite,
  technical_max_drawdown: nonnegative,
  ai_filtered_max_drawdown: nonnegative,
}).strict();
const HorizonEvaluationSchema = z.object({
  horizon_minutes: z.number().int().positive(),
  overall: MetricGroupSchema,
  quantile_coverage: z.array(QuantileValueSchema),
  mean_pinball_loss: nonnegative.nullable().optional(),
  quantile_pinball_loss: z.array(QuantileValueSchema).optional(),
  up_probability_brier: nonnegative.nullable().optional(),
  target_stop_first_count: z.number().int().nonnegative(),
  target_stop_first_accuracy: finite.min(0).max(1).nullable(),
  calibration: z.array(CalibrationBinSchema),
  by_symbol: z.record(z.string(), MetricGroupSchema),
  by_time: z.record(z.string(), MetricGroupSchema),
  by_regime: z.record(z.string(), MetricGroupSchema),
  strategy_comparison: StrategyComparisonSchema,
}).strict();

const EvaluationPredictedQuantilesSchema = z.array(QuantileValueSchema)
  .max(SCALPING_AI_QUANTILES.length)
  .superRefine((values, context) => {
    if (values.length !== 0 && values.length !== SCALPING_AI_QUANTILES.length) {
      context.addIssue({ code: "custom", message: "predicted quantiles must be empty or complete" });
      return;
    }
    values.forEach((item, index) => {
      if (item.quantile !== SCALPING_AI_QUANTILES[index]) {
        context.addIssue({
          code: "custom",
          path: [index, "quantile"],
          message: "predicted quantiles must use the fixed ordered levels",
        });
      }
    });
  });

const evaluationDirection = (value: number): -1 | 0 | 1 => (value > 0 ? 1 : value < 0 ? -1 : 0);
const evaluationNumberMatches = (actual: number, expected: number): boolean => Math.abs(actual - expected) <= 1e-12;

const EvaluationRecordSchema = z.object({
  instrument_key: z.string().min(1).max(128),
  origin: timestamp,
  horizon_minutes: z.union([z.literal(5), z.literal(15), z.literal(30), z.literal(60)]),
  target_timestamp: timestamp,
  status: z.enum(["available", "unavailable"]),
  predicted_median_return: finite.nullable(),
  predicted_quantiles: EvaluationPredictedQuantilesSchema,
  actual_return: finite.nullable(),
  execution_return: finite.nullable(),
  up_probability: finite.min(0).max(1).nullable(),
  predicted_first_passage: z.enum(["target", "stop", "ambiguous"]).nullable(),
  actual_first_passage: z.enum(["target", "stop", "ambiguous", "neither"]).nullable(),
  technical_signal: z.union([z.literal(-1), z.literal(0), z.literal(1)]).nullable(),
  regime: z.string().min(1).max(64).nullable(),
  round_trip_cost_rate: nonnegative,
  technical_net_return: finite.nullable(),
  ai_filtered_net_return: finite.nullable(),
  unavailable: UnavailableSchema.nullable(),
}).strict().superRefine((record, context) => {
  if (record.status === "available") {
    if (record.unavailable
      || record.predicted_median_return === null
      || record.up_probability === null
      || record.predicted_quantiles.length !== SCALPING_AI_QUANTILES.length
      || record.actual_return === null
      || record.execution_return === null) {
      context.addIssue({ code: "custom", message: "available evaluation record requires predictions and returns" });
    }
  } else if (!record.unavailable
    || record.predicted_median_return !== null
    || record.predicted_quantiles.length !== 0
    || record.up_probability !== null
    || record.predicted_first_passage !== null
    || record.ai_filtered_net_return !== null) {
    context.addIssue({ code: "custom", message: "unavailable evaluation record cannot contain model predictions" });
  }

  if ((record.actual_return === null) !== (record.execution_return === null)) {
    context.addIssue({ code: "custom", message: "actual and execution returns must be present together" });
  }
  if (record.actual_first_passage !== null && record.actual_return === null) {
    context.addIssue({ code: "custom", message: "actual first-passage requires realized returns" });
  }

  let expectedTechnical: number | null = null;
  if ((record.technical_signal === -1 || record.technical_signal === 1) && record.execution_return !== null) {
    expectedTechnical = record.technical_signal * record.execution_return - record.round_trip_cost_rate;
  }
  if ((record.technical_net_return === null) !== (expectedTechnical === null)
    || (record.technical_net_return !== null && expectedTechnical !== null
      && !evaluationNumberMatches(record.technical_net_return, expectedTechnical))) {
    context.addIssue({ code: "custom", message: "technical net return does not match execution and cost" });
  }

  let expectedFiltered: number | null = null;
  if (record.status === "available"
    && (record.technical_signal === -1 || record.technical_signal === 1)
    && record.predicted_median_return !== null
    && evaluationDirection(record.predicted_median_return) === record.technical_signal) {
    expectedFiltered = expectedTechnical;
  }
  if ((record.ai_filtered_net_return === null) !== (expectedFiltered === null)
    || (record.ai_filtered_net_return !== null && expectedFiltered !== null
      && !evaluationNumberMatches(record.ai_filtered_net_return, expectedFiltered))) {
    context.addIssue({ code: "custom", message: "AI-filtered net return does not match the admitted trade" });
  }
});

const EvaluationResultSchema = z.object({
  retrospective: z.literal(true),
  cost_assumptions: AiCostAssumptionsSchema,
  records: z.array(EvaluationRecordSchema),
  metrics: z.array(HorizonEvaluationSchema),
}).strict().superRefine((evaluation, context) => {
  const expectedCostRate = (
    evaluation.cost_assumptions.commission_bps_per_side * 2
    + evaluation.cost_assumptions.tax_bps_on_exit
    + evaluation.cost_assumptions.spread_bps_round_trip
    + evaluation.cost_assumptions.slippage_bps_per_side * 2
  ) / 10_000;
  const seen = new Set<string>();
  let previous: readonly [number, string, number] | undefined;
  evaluation.records.forEach((record, index) => {
    if (!evaluationNumberMatches(record.round_trip_cost_rate, expectedCostRate)) {
      context.addIssue({
        code: "custom",
        path: ["records", index, "round_trip_cost_rate"],
        message: "record cost rate must match cost assumptions",
      });
    }
    const instant = timestampMillis(record.origin);
    const key = `${instant}\u0000${record.instrument_key}\u0000${record.horizon_minutes}`;
    if (seen.has(key)) {
      context.addIssue({ code: "custom", path: ["records", index], message: "evaluation records must be unique" });
    }
    seen.add(key);
    const current = [instant, record.instrument_key, record.horizon_minutes] as const;
    if (previous && (current[0] < previous[0]
      || (current[0] === previous[0] && current[1] < previous[1])
      || (current[0] === previous[0] && current[1] === previous[1] && current[2] < previous[2]))) {
      context.addIssue({ code: "custom", path: ["records", index], message: "evaluation records must be ordered" });
    }
    previous = current;
  });
});

export const AiResponseSchema = z.object({
  schema_version: z.literal(SCALPING_AI_SCHEMA_VERSION),
  request_id: requestId,
  mode: z.enum(["forecast", "evaluate"]),
  status: z.enum(["available", "partial", "unavailable"]),
  model: AiModelProvenanceSchema,
  generated_at: timestamp,
  series: z.array(SeriesForecastResultSchema).max(10_000),
  model_runs: z.array(ModelRunSchema).length(1).nullable().optional(),
  evaluation: EvaluationResultSchema.nullable().optional(),
  error: UnavailableSchema.nullable().optional(),
}).strict().superRefine((response, context) => {
  if (
    response.model.model_id !== FINCAST_MODEL_ID
    && response.model.model_id !== CHRONOS_2_MODEL_ID
  ) {
    context.addIssue({
      code: "custom",
      path: ["model", "model_id"],
      message: "AI backend must use a supported pinned Chronos-2 or FinCast model",
    });
  }
  if ((response.model.fallback_from ?? null) !== null || (response.model.fallback_reason ?? null) !== null) {
    context.addIssue({
      code: "custom",
      path: ["model"],
      message: "independent AI responses cannot contain model fallback provenance",
    });
  }
  if (response.mode === "evaluate" && response.status !== "unavailable" && !response.evaluation) {
    context.addIssue({ code: "custom", path: ["evaluation"], message: "evaluate response requires evaluation" });
  }
  if (response.mode === "forecast" && response.evaluation) {
    context.addIssue({ code: "custom", path: ["evaluation"], message: "forecast response cannot include evaluation" });
  }
  if (response.error && (response.status !== "unavailable" || response.series.length > 0 || response.evaluation)) {
    context.addIssue({
      code: "custom",
      path: ["error"],
      message: "protocol error requires unavailable status without series or evaluation",
    });
  }
  if (!response.error && response.series.length === 0) {
    context.addIssue({ code: "custom", path: ["series"], message: "successful response requires series results" });
  }
  if (!response.error && response.mode === "forecast") {
    const available = response.series.filter((item) => item.status === "available").length;
    const expected = available === response.series.length ? "available" : available > 0 ? "partial" : "unavailable";
    if (response.status !== expected) {
      context.addIssue({ code: "custom", path: ["status"], message: "forecast status must summarize series" });
    }
  }
  if (!response.error && response.mode === "evaluate" && response.evaluation) {
    const available = response.evaluation.records.filter((item) => item.status === "available").length;
    const expected = response.evaluation.records.length > 0 && available === response.evaluation.records.length
      ? "available"
      : available > 0 ? "partial" : "unavailable";
    if (response.status !== expected) {
      context.addIssue({ code: "custom", path: ["status"], message: "evaluate status must summarize records" });
    }
  }
  if (!response.error && response.mode === "forecast" && !response.model_runs) {
    context.addIssue({
      code: "custom",
      path: ["model_runs"],
      message: "successful forecast requires exactly one independent model run",
    });
  }
  if (response.model_runs) {
    if (response.mode !== "forecast" || response.error) {
      context.addIssue({ code: "custom", path: ["model_runs"], message: "model runs require a successful forecast" });
      return;
    }
    const independentRun = response.model_runs[0]!;
    const expectedModelId = independentRun.role === "chronos_2"
        ? CHRONOS_2_MODEL_ID
        : FINCAST_MODEL_ID;
    if (response.model.model_id !== expectedModelId) {
      context.addIssue({
        code: "custom",
        path: ["model", "model_id"],
        message: "top-level model identity must match the independent model lane",
      });
    }
    if (!isDeepStrictEqual(response.model, independentRun.model)
      || !isDeepStrictEqual(response.series, independentRun.raw_series)
      || response.status !== independentRun.status) {
      context.addIssue({
        code: "custom",
        path: ["model_runs", 0],
        message: "top-level response fields must mirror the independent model run",
      });
    }
    if (response.model_runs.some((run) => timestampMillis(run.generated_at) > timestampMillis(response.generated_at))) {
      context.addIssue({
        code: "custom",
        path: ["generated_at"],
        message: "response generated_at cannot precede a model run",
      });
    }
  }
});
export type AiResponse = z.infer<typeof AiResponseSchema>;

export function aiRequestBase(requestIdValue: string, seed = 0) {
  return {
    schema_version: SCALPING_AI_SCHEMA_VERSION,
    request_id: requestIdValue,
    horizons_minutes: [...SCALPING_AI_HORIZONS],
    quantiles: [...SCALPING_AI_QUANTILES],
    seed,
  } as const;
}
