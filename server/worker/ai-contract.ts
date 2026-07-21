import { z } from "zod";

export const SCALPING_AI_SCHEMA_VERSION = "scalping-ai/v1" as const;
export const SCALPING_AI_HORIZONS = [5, 15, 30, 60] as const;
export const SCALPING_AI_QUANTILES = [0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95] as const;

const finite = z.number().finite();
const positive = finite.positive();
const nonnegative = finite.nonnegative();
const timestamp = z.string().max(64).refine((value) => (
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  && Number.isFinite(Date.parse(value))
), "RFC3339 timestamp with offset is required");
const timestampMillis = (value: string) => Date.parse(value);
const requestId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const horizons = z.tuple([
  z.literal(5), z.literal(15), z.literal(30), z.literal(60),
]);
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

const futureTimestamps = z.array(timestamp).length(60).superRefine((items, context) => {
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
  series: z.array(ForecastSeriesSchema).min(1).max(50),
}).strict().superRefine((request, context) => validateUniqueInstrumentKeys(request.series, context));

export const AiEvaluateRequestSchema = z.object({
  ...requestBase,
  mode: z.literal("evaluate"),
  series: z.array(EvaluationSeriesSchema).min(1).max(50),
  cost_assumptions: AiCostAssumptionsSchema,
}).strict().superRefine((request, context) => validateUniqueInstrumentKeys(request.series, context));

export const AiRequestSchema = z.discriminatedUnion("mode", [AiForecastRequestSchema, AiEvaluateRequestSchema]);
export type AiRequest = z.infer<typeof AiRequestSchema>;
export type AiForecastRequest = z.infer<typeof AiForecastRequestSchema>;
export type AiEvaluateRequest = z.infer<typeof AiEvaluateRequestSchema>;

const ModelProvenanceSchema = z.object({
  model_id: z.string().min(1).max(256),
  model_revision: z.string().min(1).max(256),
  tokenizer_id: z.string().min(1).max(256).nullable().optional(),
  tokenizer_revision: z.string().min(1).max(256).nullable().optional(),
  source_revision: z.string().min(1).max(256),
  loader_version: z.string().min(1).max(128),
  license: z.string().min(1).max(64),
  device: z.enum(["cuda", "cpu", "unavailable"]),
  dtype: z.literal("float32"),
  attention_backend: z.enum(["math", "unavailable"]),
  loaded: z.boolean(),
  fallback_from: z.string().min(1).max(256).nullable().optional(),
  fallback_reason: z.string().min(1).max(500).nullable().optional(),
}).strict().superRefine((model, context) => {
  if (model.loaded && (model.device === "unavailable" || model.attention_backend !== "math")) {
    context.addIssue({ code: "custom", message: "loaded model requires an execution device and math attention" });
  }
  if (!model.loaded && (model.device !== "unavailable" || model.attention_backend !== "unavailable")) {
    context.addIssue({ code: "custom", message: "unloaded model runtime must be unavailable" });
  }
});

const UnavailableSchema = z.object({
  code: z.string().min(1).max(64),
  message: z.string().min(1).max(500),
}).strict();

const QuantileValueSchema = z.object({ quantile: finite.gt(0).lt(1), value: finite }).strict();
const TargetStopBoundsSchema = z.object({
  status: z.enum(["available", "unavailable"]),
  target_first_probability_lower: finite.min(0).max(1).nullable().optional(),
  target_first_probability_upper: finite.min(0).max(1).nullable().optional(),
  stop_first_probability_lower: finite.min(0).max(1).nullable().optional(),
  stop_first_probability_upper: finite.min(0).max(1).nullable().optional(),
  ambiguous_probability: finite.min(0).max(1).nullable().optional(),
  neither_probability: finite.min(0).max(1).nullable().optional(),
  reason: z.string().max(500).nullable().optional(),
}).strict();

const HorizonForecastSchema = z.object({
  horizon_minutes: z.union([z.literal(5), z.literal(15), z.literal(30), z.literal(60)]),
  target_timestamp: timestamp,
  return_quantiles: z.array(QuantileValueSchema).length(SCALPING_AI_QUANTILES.length),
  price_quantiles: z.array(QuantileValueSchema).length(SCALPING_AI_QUANTILES.length),
  up_probability: finite.min(0).max(1).nullable().optional(),
  down_probability: finite.min(0).max(1).nullable().optional(),
  flat_probability: finite.min(0).max(1).nullable().optional(),
  probability_method: z.enum(["sample_paths", "derived_quantile_cdf", "unavailable"]),
  expected_volatility: nonnegative.nullable().optional(),
  volatility_method: z.enum(["path_realized", "quantile_implied_sigma", "unavailable"]),
  uncertainty_interval_width: nonnegative.nullable().optional(),
  target_stop: TargetStopBoundsSchema,
  valid_path_count: z.number().int().nonnegative(),
  invalid_path_count: z.number().int().nonnegative(),
}).strict();

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
  horizons: z.array(HorizonForecastSchema).max(4),
  input_quality: InputQualitySchema,
  distribution_shift: z.object({
    status: z.literal("unavailable"),
    reason: z.literal("reference_statistics_not_published"),
  }).strict(),
  unavailable: UnavailableSchema.nullable().optional(),
}).strict().superRefine((series, context) => {
  if (series.status === "available" && (series.horizons.length !== 4 || series.unavailable)) {
    context.addIssue({ code: "custom", message: "available series must have four horizons" });
  }
  if (series.status === "unavailable" && (series.horizons.length || !series.unavailable)) {
    context.addIssue({ code: "custom", message: "unavailable series must have a reason only" });
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
  model: ModelProvenanceSchema,
  generated_at: timestamp,
  series: z.array(SeriesForecastResultSchema).max(10_000),
  evaluation: EvaluationResultSchema.nullable().optional(),
  error: UnavailableSchema.nullable().optional(),
}).strict().superRefine((response, context) => {
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
