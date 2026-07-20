import { z } from "zod";

export const TECHNICAL_INDICATOR_ENGINE_VERSION = "technical-indicators/1.5.0" as const;
export const TECHNICAL_ANALYSIS_RESULT_SCHEMA_VERSION = "technical-analysis-result/v1" as const;
export const MAX_VOLUME_PROFILE_BUCKETS = 200;
export const MAX_VOLUME_PROFILE_OBSERVATIONS = 20_000;

export const TECHNICAL_INDICATOR_KINDS = [
  "sma",
  "ema",
  "rsi",
  "macd",
  "bollinger_bands",
  "atr",
  "donchian_channel",
  "benchmark_relative_strength",
  "fifty_two_week_high_low_position",
  "moving_average_distance",
  "adx_dmi",
  "stochastic_oscillator",
  "roc",
  "keltner_channel",
  "supertrend",
  "historical_volatility",
  "normalized_atr",
  "bollinger_band_width_percent_b",
  "aroon",
  "cci",
  "williams_r",
  "parabolic_sar",
  "choppiness_index",
  "volume_sma",
  "relative_volume",
  "obv",
  "mfi",
  "cmf",
  "accumulation_distribution_line",
  "vwap_anchored_vwap",
  "volume_profile",
] as const;

export type TechnicalIndicatorKind = typeof TECHNICAL_INDICATOR_KINDS[number];

/** Rust catalog output-field mirror used only for request validation. */
export const TECHNICAL_INDICATOR_OUTPUT_FIELDS = {
  sma: ["value"],
  ema: ["value"],
  rsi: ["value"],
  macd: ["macd", "signal", "histogram"],
  bollinger_bands: ["upper", "middle", "lower"],
  atr: ["atr"],
  donchian_channel: ["upper", "middle", "lower"],
  benchmark_relative_strength: ["relative_strength"],
  fifty_two_week_high_low_position: ["rolling_high", "rolling_low", "position_percent"],
  moving_average_distance: ["moving_average", "distance_percent"],
  adx_dmi: ["adx", "plus_di", "minus_di"],
  stochastic_oscillator: ["percent_k", "percent_d"],
  roc: ["value"],
  keltner_channel: ["upper", "middle", "lower"],
  supertrend: ["supertrend", "direction"],
  historical_volatility: ["value"],
  normalized_atr: ["value"],
  bollinger_band_width_percent_b: ["bandwidth", "percent_b", "upper", "middle", "lower"],
  aroon: ["aroon_up", "aroon_down", "oscillator"],
  cci: ["value"],
  williams_r: ["value"],
  parabolic_sar: ["sar", "direction"],
  choppiness_index: ["value"],
  volume_sma: ["value"],
  relative_volume: ["value"],
  obv: ["value"],
  mfi: ["value"],
  cmf: ["value"],
  accumulation_distribution_line: ["value"],
  vwap_anchored_vwap: ["vwap", "anchored_vwap"],
  volume_profile: ["point_of_control", "value_area_high", "value_area_low"],
} as const satisfies Record<TechnicalIndicatorKind, readonly string[]>;

const finiteNumber = z.number().finite();
const indicatorPointSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  state: z.enum(["warmup", "available", "unavailable"]),
  values: z.record(z.string(), finiteNumber.nullable()),
}).strict();

const volumeProfileBucketSchema = z.object({
  index: z.number().int().nonnegative(),
  price_low: finiteNumber,
  price_high: finiteNumber,
  price_mid: finiteNumber,
  volume: finiteNumber.nonnegative(),
  volume_percent: finiteNumber.nonnegative(),
  in_value_area: z.boolean(),
  is_point_of_control: z.boolean(),
}).strict();

const volumeProfileSchema = z.object({
  schema_version: z.literal("volume-profile/v1"),
  from_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  price_source: z.enum(["close", "typical_price"]),
  requested_bucket_count: z.number().int().min(5).max(MAX_VOLUME_PROFILE_BUCKETS),
  effective_bucket_count: z.number().int().min(1).max(MAX_VOLUME_PROFILE_BUCKETS),
  price_min: finiteNumber,
  price_max: finiteNumber,
  bucket_width: finiteNumber.nonnegative(),
  total_volume: finiteNumber.nonnegative(),
  included_observations: z.number().int().nonnegative().max(MAX_VOLUME_PROFILE_OBSERVATIONS),
  missing_volume_observations: z.number().int().nonnegative().max(MAX_VOLUME_PROFILE_OBSERVATIONS),
  value_area_percent: finiteNumber.min(50).max(99),
  point_of_control: finiteNumber,
  value_area_high: finiteNumber,
  value_area_low: finiteNumber,
  buckets: z.array(volumeProfileBucketSchema).max(MAX_VOLUME_PROFILE_BUCKETS),
  approximation: z.literal("each_bar_full_volume_assigned_to_one_selected_representative_price_bucket"),
}).strict().superRefine((profile, context) => {
  if (profile.included_observations + profile.missing_volume_observations > MAX_VOLUME_PROFILE_OBSERVATIONS) {
    context.addIssue({ code: "custom", path: ["included_observations"], message: "Volume Profile 관측치 상한을 초과했습니다." });
  }
  if (profile.buckets.length !== 0 && profile.buckets.length !== profile.effective_bucket_count) {
    context.addIssue({ code: "custom", path: ["buckets"], message: "Volume Profile effective bucket 수가 일치하지 않습니다." });
  }
  if (profile.value_area_low > profile.point_of_control || profile.point_of_control > profile.value_area_high) {
    context.addIssue({ code: "custom", path: ["point_of_control"], message: "Volume Profile POC가 Value Area 범위를 벗어났습니다." });
  }
});

const calculationSchema = z.object({
  instrument_key: z.string().min(1).max(128),
  indicator_id: z.string().min(1).max(128),
  kind: z.enum(TECHNICAL_INDICATOR_KINDS),
  parameters: z.record(z.string(), z.union([z.string(), finiteNumber, z.boolean(), z.null()])),
  availability: z.object({
    status: z.enum(["available", "partial", "insufficient_history", "volume_unavailable", "unsupported_instrument", "unavailable"]),
    reason: z.string().min(1).max(256),
  }).strict(),
  warmup: z.object({
    required_observations: z.number().int().positive(),
    observed_observations: z.number().int().nonnegative(),
    state: z.enum(["warming_up", "ready"]),
    first_available_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  }).strict(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  profile: volumeProfileSchema.optional(),
  points: z.array(indicatorPointSchema).min(1).max(100_000).optional(),
  latest: indicatorPointSchema.optional(),
}).strict();

/** Strict cross-process result contract used before any completed external run is persisted. */
export const TechnicalAnalysisWorkerResultSchema = z.object({
  schema_version: z.literal(TECHNICAL_ANALYSIS_RESULT_SCHEMA_VERSION),
  indicator_engine_version: z.literal(TECHNICAL_INDICATOR_ENGINE_VERSION),
  response_mode: z.enum(["full_series", "latest_summary"]),
  adjustment_policy: z.enum(["adjusted", "unadjusted"]),
  calculations: z.array(calculationSchema).min(1),
  diagnostics: z.record(z.string(), z.unknown()),
}).strict().superRefine((result, context) => {
  const profiles = result.calculations.filter((calculation) => calculation.profile !== undefined);
  if (profiles.length > 1) {
    context.addIssue({ code: "custom", path: ["calculations"], message: "Volume Profile 결과는 하나만 허용됩니다." });
  }
  result.calculations.forEach((calculation, index) => {
    if (result.response_mode === "full_series" && (!calculation.points || calculation.latest !== undefined)) {
      context.addIssue({ code: "custom", path: ["calculations", index], message: "full_series calculation은 points만 포함해야 합니다." });
    }
    if (result.response_mode === "latest_summary" && (!calculation.latest || calculation.points !== undefined)) {
      context.addIssue({ code: "custom", path: ["calculations", index], message: "latest_summary calculation은 latest만 포함해야 합니다." });
    }
    if (calculation.profile && calculation.kind !== "volume_profile") {
      context.addIssue({ code: "custom", path: ["calculations", index, "profile"], message: "Volume Profile payload의 kind가 일치하지 않습니다." });
    }
    if (result.response_mode === "latest_summary" && calculation.profile?.buckets.length) {
      context.addIssue({ code: "custom", path: ["calculations", index, "profile", "buckets"], message: "latest_summary는 profile bucket을 포함할 수 없습니다." });
    }
  });
});

export type TechnicalIndicatorParameterRule =
  | { type: "integer"; minimum: number; maximum: number; required?: boolean }
  | { type: "number"; minimum: number; maximum: number; required?: boolean }
  | { type: "enum"; values: readonly string[]; required?: boolean }
  | { type: "instrument_key"; required?: boolean }
  | { type: "iso_date"; required?: boolean };

const period = { type: "integer", minimum: 1, maximum: 10_000 } as const;
const source = { type: "enum", values: ["open", "high", "low", "close", "typical_price"] } as const;
const multiplier = { type: "number", minimum: 0.1, maximum: 20 } as const;

/**
 * Client-facing mirror of the Rust catalog's accepted parameter surface.
 * Rust remains authoritative for calculation and repeats this validation at
 * the UDS boundary; this mirror prevents avoidable price fetches and 500s.
 */
export const TECHNICAL_INDICATOR_PARAMETER_RULES = {
  sma: { period, source },
  ema: { period, source },
  rsi: { period, source },
  macd: { fast_period: period, signal_period: period, slow_period: period, source },
  bollinger_bands: { period, source, stddev_multiplier: multiplier },
  atr: { period },
  donchian_channel: { period },
  benchmark_relative_strength: { benchmark_key: { type: "instrument_key", required: true } },
  fifty_two_week_high_low_position: { period },
  moving_average_distance: {
    average_type: { type: "enum", values: ["sma", "ema"] },
    period,
    source,
  },
  adx_dmi: { period },
  stochastic_oscillator: { lookback_period: period, smooth_d: period, smooth_k: period },
  roc: { period, source },
  keltner_channel: { atr_period: period, ema_period: period, multiplier },
  supertrend: { atr_period: period, multiplier },
  historical_volatility: {
    annualization: period,
    period,
    return_type: { type: "enum", values: ["simple", "log"] },
  },
  normalized_atr: { period },
  bollinger_band_width_percent_b: { period, source, stddev_multiplier: multiplier },
  aroon: { period },
  cci: { constant: { type: "number", minimum: 0.000_001, maximum: 1 }, period },
  williams_r: { period },
  parabolic_sar: {
    max_step: { type: "number", minimum: 0.000_1, maximum: 1 },
    step: { type: "number", minimum: 0.000_1, maximum: 1 },
  },
  choppiness_index: { period },
  volume_sma: { period },
  relative_volume: { period },
  obv: {},
  mfi: { period },
  cmf: { period },
  accumulation_distribution_line: {},
  vwap_anchored_vwap: {
    anchor: { type: "enum", values: ["period_start", "user_date", "recent_high", "recent_low", "signal_date"] },
    anchor_date: { type: "iso_date" },
    lookback_period: period,
    mode: { type: "enum", values: ["vwap", "anchored", "both"] },
  },
  volume_profile: {
    bucket_count: { type: "integer", minimum: 5, maximum: 200 },
    price_source: { type: "enum", values: ["close", "typical_price"] },
    value_area_percent: { type: "number", minimum: 50, maximum: 99 },
  },
} as const satisfies Record<TechnicalIndicatorKind, Readonly<Record<string, TechnicalIndicatorParameterRule>>>;
