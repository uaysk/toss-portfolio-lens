import {
  SimulationPresetSchema,
  type SimulationModelLane,
  type SimulationPreset,
} from "./contracts.js";
import {
  AiModelProvenanceSchema,
  CHRONOS_2_MODEL_ID,
  FINCAST_MODEL_ID,
  SCALPING_AI_SCHEMA_VERSION,
  type QuantileRearrangementObservations,
} from "../worker/ai-contract.js";
import {
  calculateBrokerExecutionCharges,
  type TossSimulationCostProfile,
} from "./cost-profile.js";
import {
  FORECAST_TECHNICAL_FUSION_VERSION,
  fuseForecastWithTechnical,
  type ForecastTechnicalFusionResult,
  type FusionQuality,
} from "./forecast-technical-fusion.js";
import {
  parseRustIndicatorEvidence,
  type RustIndicatorEvidence,
} from "./technical-indicator-evidence.js";

export const AI_PAPER_POLICY_VERSION = "ai-paper-policy/v3" as const;

export const AI_PAPER_FORECAST_HORIZON_MINUTES = 5 as const;

export type PaperTechnicalConfirmation = "entry_candidate" | "non_exit";
export type PaperPatternConfirmation = "bullish" | "non_bearish";
export type PaperChartPatternBias = "bullish" | "bearish" | "neutral";

export type ResolvedPaperPolicyProfile = {
  policyVersion: typeof AI_PAPER_POLICY_VERSION;
  preset: SimulationPreset;
  riskTolerance: number;
  entryUpProbability: number;
  exitUpProbability: number;
  riskPenalty: number;
  technicalConfirmation: PaperTechnicalConfirmation;
  patternConfirmation: PaperPatternConfirmation;
  targetAllocationRate: number;
  cashReserveRate: number;
};

type PresetProfileSeed = {
  entryAdjustment: number;
  exitAdjustment: number;
  riskPenaltyAdjustment: number;
  allocationAdjustment: number;
  technicalConfirmationUntil: number;
  bullishPatternUntil: number;
};

const PRESET_PROFILE_SEEDS: Readonly<Record<SimulationPreset, PresetProfileSeed>> = {
  trend: {
    entryAdjustment: 0,
    exitAdjustment: 0,
    riskPenaltyAdjustment: 0,
    allocationAdjustment: 0,
    technicalConfirmationUntil: 35,
    bullishPatternUntil: 25,
  },
  breakout: {
    entryAdjustment: -0.01,
    exitAdjustment: -0.01,
    riskPenaltyAdjustment: -0.03,
    allocationAdjustment: 0.05,
    technicalConfirmationUntil: 50,
    bullishPatternUntil: 45,
  },
  mean_reversion: {
    entryAdjustment: 0.01,
    exitAdjustment: 0.01,
    riskPenaltyAdjustment: 0.02,
    allocationAdjustment: -0.05,
    technicalConfirmationUntil: 55,
    bullishPatternUntil: 50,
  },
  risk_management: {
    entryAdjustment: 0.02,
    exitAdjustment: 0.02,
    riskPenaltyAdjustment: 0.05,
    allocationAdjustment: -0.1,
    technicalConfirmationUntil: 70,
    bullishPatternUntil: 65,
  },
};

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function rounded(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function interpolate(defensive: number, aggressive: number, riskRatio: number): number {
  return defensive + (aggressive - defensive) * riskRatio;
}

export function resolvePaperPolicyProfile(
  presetInput: SimulationPreset,
  riskTolerance: number,
): ResolvedPaperPolicyProfile {
  const preset = SimulationPresetSchema.parse(presetInput);
  if (!Number.isSafeInteger(riskTolerance) || riskTolerance < 0 || riskTolerance > 100) {
    throw new RangeError("riskTolerance must be an integer in 0..=100.");
  }
  const seed = PRESET_PROFILE_SEEDS[preset];
  const riskRatio = riskTolerance / 100;
  const entryUpProbability = clamp(
    interpolate(0.66, 0.52, riskRatio) + seed.entryAdjustment,
    0.5,
    0.9,
  );
  const exitUpProbability = clamp(
    interpolate(0.52, 0.4, riskRatio) + seed.exitAdjustment,
    0.25,
    entryUpProbability - 0.05,
  );
  const targetAllocationRate = clamp(
    interpolate(0.35, 0.9, riskRatio) + seed.allocationAdjustment,
    0.2,
    0.95,
  );
  return {
    policyVersion: AI_PAPER_POLICY_VERSION,
    preset,
    riskTolerance,
    entryUpProbability: rounded(entryUpProbability),
    exitUpProbability: rounded(exitUpProbability),
    riskPenalty: rounded(clamp(
      interpolate(0.45, 0.15, riskRatio) + seed.riskPenaltyAdjustment,
      0.05,
      0.75,
    )),
    technicalConfirmation: riskTolerance <= seed.technicalConfirmationUntil
      ? "entry_candidate"
      : "non_exit",
    patternConfirmation: riskTolerance <= seed.bullishPatternUntil
      ? "bullish"
      : "non_bearish",
    targetAllocationRate: rounded(targetAllocationRate),
    cashReserveRate: rounded(1 - targetAllocationRate),
  };
}

export type AiPaperModelProvenance = {
  modelId: string;
  modelRevision: string;
  tokenizerId?: string;
  tokenizerRevision?: string;
  sourceRevision: string;
  loaderVersion: string;
  license: string;
  device: "cuda" | "cpu" | "unavailable";
  deviceName?: string;
  cudaCapability?: string;
  dtype: "float32" | "mixed_float16";
  attentionBackend: "math" | "unavailable";
  loaded: boolean;
  precisionValidation?: "not_required" | "passed" | "fallback_fp32" | "unavailable";
  peakVramBytes?: number;
  peakVramMeasurement?: "cuda_allocated_or_reserved";
  memoryStatus?: "ok" | "memory_pressure" | "unavailable";
  quantileMonotonicityPolicy?:
    | "native"
    | "fp32_monotone_rearrangement_v1"
    | "chronos2_fp32_monotone_rearrangement_v1"
    | "unavailable";
  fp32QuantileObservations?: QuantileRearrangementObservations | null;
  mixedQuantileObservations?: QuantileRearrangementObservations | null;
  quantileTailPolicy?: "native" | "tail_clamped_q10_q90" | "unavailable";
  precisionFailureReasons?: string[];
  fallbackFrom?: string;
  fallbackReason?: string;
};

export type AiPaperForecastCandidate = {
  symbol: string;
  inputEndAt: string;
  generatedAt: string;
  targetTimestamp: string;
  horizonMinutes: typeof AI_PAPER_FORECAST_HORIZON_MINUTES;
  medianReturn: number;
  q10Return: number;
  q90Return: number;
  upProbability: number;
  downProbability?: number;
  flatProbability?: number;
  expectedVolatility?: number;
  uncertaintyIntervalWidth?: number;
  validPathCount?: number;
  invalidPathCount?: number;
  targetStop?: {
    status: "available" | "unavailable";
    targetFirstProbabilityLower?: number;
    targetFirstProbabilityUpper?: number;
    stopFirstProbabilityLower?: number;
    stopFirstProbabilityUpper?: number;
    ambiguousProbability?: number;
    neitherProbability?: number;
    reason?: string;
  };
  score: number;
  riskPenalty: number;
  roundTripCostRate: number;
  model: AiPaperModelProvenance;
};

export type AiPaperSelection = {
  policyVersion: typeof AI_PAPER_POLICY_VERSION;
  status: "available" | "unavailable";
  requestedSymbolCount: 1 | 2;
  availableCandidateCount: number;
  generatedAt?: string;
  model?: AiPaperModelProvenance;
  selected: AiPaperForecastCandidate[];
  reason?:
    | "invalid_forecast_response"
    | "model_unavailable"
    | "insufficient_available_forecasts"
    | "stale_forecast_horizon";
};

export type PaperTechnicalState = "watch" | "entry_candidate" | "hold" | "exit_candidate";
export type PaperPolicyActionKind = "buy" | "sell" | "hold" | "watch";

export type PaperPolicyAction = {
  policyVersion: typeof AI_PAPER_POLICY_VERSION;
  symbol: string;
  action: PaperPolicyActionKind;
  eligibleAfter: string;
  inputEndAt: string;
  forecastGeneratedAt: string;
  score: number;
  medianReturn: number;
  q10Return: number;
  q90Return: number;
  upProbability: number;
  technicalState: PaperTechnicalState | null;
  technicalObservedAt?: string;
  chartPatternBias: PaperChartPatternBias | null;
  chartPatterns: string[];
  chartPatternStrength?: number;
  fusionPolicyVersion?: typeof FORECAST_TECHNICAL_FUSION_VERSION;
  technicalScore?: number;
  technicalDirection?: ForecastTechnicalFusionResult["technicalDirection"];
  exposureScale?: number;
  modelEvidenceScale?: number;
  technicalComponents?: Record<string, number>;
  targetAllocationRate?: number;
  reasons: string[];
  model: AiPaperModelProvenance;
};

export type PaperPosition = {
  symbol: string;
  quantity: number;
  averagePrice: number;
  costBasis: number;
};

export type PaperLedger = {
  policyVersion: typeof AI_PAPER_POLICY_VERSION;
  initialCash: number;
  cash: number;
  positions: Record<string, PaperPosition>;
  realizedPnl: number;
  totalCosts: number;
};

export type PaperTradingCosts = {
  commissionBpsPerSide: number;
  exitTaxBps: number;
  spreadBpsRoundTrip: number;
  slippageBpsPerSide: number;
  marketCostProfile?: TossSimulationCostProfile;
};

export type PaperExecution = {
  timestamp: string;
  price: number;
};

export type PaperFillConfig = {
  symbolCount: 1 | 2;
  costs: PaperTradingCosts;
  targetAllocationRate: number;
  markPrices?: Readonly<Record<string, number>>;
  allocationEquity?: number;
};

export type PaperTrade = {
  policyVersion: typeof AI_PAPER_POLICY_VERSION;
  symbol: string;
  side: "buy" | "sell";
  signalEligibleAfter: string;
  executedAt: string;
  price: number;
  quantity: number;
  grossAmount: number;
  commission: number;
  exitTax: number;
  regulatoryFee: number;
  spreadCost: number;
  slippageCost: number;
  totalCosts: number;
  cashAfter: number;
  positionQuantityAfter: number;
};

export type PaperFillResult = {
  status: "filled" | "skipped" | "rejected";
  reason:
    | "filled"
    | "non_executable_action"
    | "invalid_execution"
    | "execution_not_after_eligible"
    | "position_not_held"
    | "target_already_met"
    | "insufficient_cash"
    | "mark_price_unavailable"
    | "invalid_ledger";
  ledger: PaperLedger;
  trade?: PaperTrade;
};

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : undefined;
}

function nonemptyString(value: unknown, maximum = 256): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= maximum ? normalized : undefined;
}

function optionalString(value: unknown, maximum = 256): string | undefined | null {
  if (value === undefined || value === null) return undefined;
  return nonemptyString(value, maximum) ?? null;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isoTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 64) return undefined;
  const instant = Date.parse(value);
  return Number.isFinite(instant) ? new Date(instant).toISOString() : undefined;
}

function rawKeyCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validatedRoundTripCostRate(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value >= 1) {
    throw new RangeError("roundTripCostRate must be a finite decimal rate in [0, 1).");
  }
  return value;
}

function validatedRiskPenalty(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError("riskPenalty must be a finite coefficient in [0, 1].");
  }
  return value;
}

function parseModel(
  value: unknown,
  expectedLane?: SimulationModelLane,
): AiPaperModelProvenance | undefined {
  const parsed = AiModelProvenanceSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const source = parsed.data;
  const expectedModelId = expectedLane === "fincast"
    ? FINCAST_MODEL_ID
    : expectedLane === "chronos2" ? CHRONOS_2_MODEL_ID : undefined;
  if (
    (
      source.model_id !== FINCAST_MODEL_ID
      && source.model_id !== CHRONOS_2_MODEL_ID
    )
    || (expectedModelId !== undefined && source.model_id !== expectedModelId)
    || (source.fallback_from ?? null) !== null
    || (source.fallback_reason ?? null) !== null
  ) {
    return undefined;
  }
  return {
    modelId: source.model_id,
    modelRevision: source.model_revision,
    ...(source.tokenizer_id ? { tokenizerId: source.tokenizer_id } : {}),
    ...(source.tokenizer_revision
      ? { tokenizerRevision: source.tokenizer_revision } : {}),
    sourceRevision: source.source_revision,
    loaderVersion: source.loader_version,
    license: source.license,
    device: source.device,
    ...(source.device_name ? { deviceName: source.device_name } : {}),
    ...(source.cuda_capability ? { cudaCapability: source.cuda_capability } : {}),
    dtype: source.dtype,
    attentionBackend: source.attention_backend,
    loaded: source.loaded,
    ...(source.precision_validation
      ? { precisionValidation: source.precision_validation } : {}),
    ...(source.peak_vram_bytes === undefined || source.peak_vram_bytes === null
      ? {} : { peakVramBytes: source.peak_vram_bytes }),
    ...(source.peak_vram_measurement
      ? { peakVramMeasurement: source.peak_vram_measurement } : {}),
    ...(source.memory_status ? { memoryStatus: source.memory_status } : {}),
    ...(source.quantile_monotonicity_policy
      ? { quantileMonotonicityPolicy: source.quantile_monotonicity_policy } : {}),
    ...(source.fp32_quantile_observations === undefined
      ? {} : { fp32QuantileObservations: source.fp32_quantile_observations }),
    ...(source.mixed_quantile_observations === undefined
      ? {} : { mixedQuantileObservations: source.mixed_quantile_observations }),
    ...(source.quantile_tail_policy
      ? { quantileTailPolicy: source.quantile_tail_policy } : {}),
    ...(source.precision_failure_reasons
      ? { precisionFailureReasons: [...source.precision_failure_reasons] } : {}),
  };
}

function parseQuantiles(value: unknown): { q10: number; median: number; q90: number } | undefined {
  if (!Array.isArray(value)) return undefined;
  const wanted = new Map<number, number>();
  for (const item of value) {
    const quantile = finite(record(item)?.quantile);
    const amount = finite(record(item)?.value);
    if (quantile === undefined || amount === undefined || ![0.1, 0.5, 0.9].includes(quantile)) continue;
    if (wanted.has(quantile)) return undefined;
    wanted.set(quantile, amount);
  }
  const q10 = wanted.get(0.1);
  const median = wanted.get(0.5);
  const q90 = wanted.get(0.9);
  if (q10 === undefined || median === undefined || q90 === undefined
    || q10 > median || median > q90) return undefined;
  return { q10, median, q90 };
}

function probability(value: unknown): number | undefined {
  const parsed = finite(value);
  return parsed !== undefined && parsed >= 0 && parsed <= 1 ? parsed : undefined;
}

function nonnegativeInteger(value: unknown): number | undefined {
  const parsed = finite(value);
  return parsed !== undefined && Number.isSafeInteger(parsed) && parsed >= 0
    ? parsed
    : undefined;
}

function parseTargetStop(value: unknown): AiPaperForecastCandidate["targetStop"] | undefined {
  const source = record(value);
  if (!source || source.status !== "available" && source.status !== "unavailable") {
    return undefined;
  }
  const keys = [
    "target_first_probability_lower",
    "target_first_probability_upper",
    "stop_first_probability_lower",
    "stop_first_probability_upper",
    "ambiguous_probability",
    "neither_probability",
  ] as const;
  const reason = optionalString(source.reason, 500);
  if (reason === null) return undefined;
  if (source.status === "unavailable") {
    if (!reason || keys.some((key) => source[key] !== undefined && source[key] !== null)) {
      return undefined;
    }
    return { status: "unavailable", reason };
  }
  if (reason) return undefined;
  const values = keys.map((key) => probability(source[key]));
  if (values.some((item) => item === undefined)) return undefined;
  const [
    targetFirstProbabilityLower,
    targetFirstProbabilityUpper,
    stopFirstProbabilityLower,
    stopFirstProbabilityUpper,
    ambiguousProbability,
    neitherProbability,
  ] = values as [number, number, number, number, number, number];
  const tolerance = 1e-9;
  if (
    targetFirstProbabilityLower > targetFirstProbabilityUpper
    || stopFirstProbabilityLower > stopFirstProbabilityUpper
    || Math.abs(
      targetFirstProbabilityLower
      + stopFirstProbabilityLower
      + ambiguousProbability
      + neitherProbability
      - 1
    ) > tolerance
    || Math.abs(
      targetFirstProbabilityUpper
      - targetFirstProbabilityLower
      - ambiguousProbability
    ) > tolerance
    || Math.abs(
      stopFirstProbabilityUpper
      - stopFirstProbabilityLower
      - ambiguousProbability
    ) > tolerance
  ) {
    return undefined;
  }
  return {
    status: "available",
    targetFirstProbabilityLower,
    targetFirstProbabilityUpper,
    stopFirstProbabilityLower,
    stopFirstProbabilityUpper,
    ambiguousProbability,
    neitherProbability,
  };
}

function parseCandidate(
  value: unknown,
  generatedAt: string,
  model: AiPaperModelProvenance,
  roundTripCostRate: number,
  riskPenalty: number,
  notBeforeMs: number,
): AiPaperForecastCandidate | undefined {
  const source = record(value);
  const symbol = nonemptyString(source?.instrument_key, 128);
  const inputEndAt = isoTimestamp(source?.input_end_at);
  if (!source || source.status !== "available" || source.unavailable !== undefined && source.unavailable !== null
    || !symbol || !inputEndAt || !Array.isArray(source.horizons)) return undefined;
  const fiveMinute = source.horizons.filter((item) => record(item)?.horizon_minutes === 5);
  if (fiveMinute.length !== 1) return undefined;
  const horizon = record(fiveMinute[0]);
  const targetTimestamp = isoTimestamp(horizon?.target_timestamp);
  const quantiles = parseQuantiles(horizon?.return_quantiles);
  const upProbability = finite(horizon?.up_probability);
  if (!targetTimestamp
    || Date.parse(targetTimestamp) <= Math.max(Date.parse(generatedAt), notBeforeMs)
    || !quantiles
    || upProbability === undefined
    || upProbability < 0
    || upProbability > 1) return undefined;
  const score = quantiles.median
    - riskPenalty * (quantiles.q90 - quantiles.q10)
    - roundTripCostRate;
  if (!Number.isFinite(score)) return undefined;
  const rawDownProbability = horizon?.down_probability;
  const rawFlatProbability = horizon?.flat_probability;
  const downProbability = probability(rawDownProbability);
  const flatProbability = probability(rawFlatProbability);
  const auxiliaryProbabilitiesReported = (
    rawDownProbability !== undefined && rawDownProbability !== null
  ) || (
    rawFlatProbability !== undefined && rawFlatProbability !== null
  );
  if (auxiliaryProbabilitiesReported && (
    downProbability === undefined
    || flatProbability === undefined
    || Math.abs(upProbability + downProbability + flatProbability - 1) > 1e-9
  )) return undefined;
  const expectedVolatility = finite(horizon?.expected_volatility);
  const uncertaintyIntervalWidth = finite(horizon?.uncertainty_interval_width);
  const validPathCount = nonnegativeInteger(horizon?.valid_path_count);
  const invalidPathCount = nonnegativeInteger(horizon?.invalid_path_count);
  const rawTargetStop = horizon?.target_stop;
  const targetStop = parseTargetStop(rawTargetStop);
  if (rawTargetStop !== undefined && rawTargetStop !== null && !targetStop) return undefined;
  return {
    symbol,
    inputEndAt,
    generatedAt,
    targetTimestamp,
    horizonMinutes: AI_PAPER_FORECAST_HORIZON_MINUTES,
    medianReturn: quantiles.median,
    q10Return: quantiles.q10,
    q90Return: quantiles.q90,
    upProbability,
    ...(downProbability === undefined ? {} : { downProbability }),
    ...(flatProbability === undefined ? {} : { flatProbability }),
    ...(expectedVolatility !== undefined && expectedVolatility >= 0
      ? { expectedVolatility } : {}),
    ...(uncertaintyIntervalWidth !== undefined && uncertaintyIntervalWidth >= 0
      ? { uncertaintyIntervalWidth } : {}),
    ...(validPathCount === undefined ? {} : { validPathCount }),
    ...(invalidPathCount === undefined ? {} : { invalidPathCount }),
    ...(targetStop ? { targetStop } : {}),
    score,
    riskPenalty,
    roundTripCostRate,
    model,
  };
}

export function selectAiForecastSeries(
  input: unknown,
  config: {
    symbolCount: 1 | 2;
    roundTripCostRate: number;
    riskPenalty: number;
    notBeforeMs?: number;
    modelLane?: SimulationModelLane;
  },
): AiPaperSelection {
  if (config.symbolCount !== 1 && config.symbolCount !== 2) {
    throw new RangeError("symbolCount must be exactly 1 or 2.");
  }
  const roundTripCostRate = validatedRoundTripCostRate(config.roundTripCostRate);
  const riskPenalty = validatedRiskPenalty(config.riskPenalty);
  if (config.notBeforeMs !== undefined && !Number.isFinite(config.notBeforeMs)) {
    throw new RangeError("notBeforeMs must be a finite epoch timestamp.");
  }
  const response = record(input);
  const model = parseModel(response?.model, config.modelLane);
  const generatedAt = isoTimestamp(response?.generated_at);
  const base = {
    policyVersion: AI_PAPER_POLICY_VERSION,
    requestedSymbolCount: config.symbolCount,
    availableCandidateCount: 0,
    selected: [] as AiPaperForecastCandidate[],
  } as const;
  if (!response || response.schema_version !== SCALPING_AI_SCHEMA_VERSION || response.mode !== "forecast"
    || !model || !generatedAt || !Array.isArray(response.series)) {
    return { ...base, status: "unavailable", reason: "invalid_forecast_response" };
  }
  if (!model.loaded) {
    return {
      ...base,
      status: "unavailable",
      generatedAt,
      model,
      reason: "model_unavailable",
    };
  }
  const notBeforeMs = config.notBeforeMs ?? Date.parse(generatedAt);
  const freshnessCutoff = Math.max(Date.parse(generatedAt), notBeforeMs);
  let staleForecastCount = 0;
  const parsed = response.series
    .map((series) => {
      const source = record(series);
      const horizon = Array.isArray(source?.horizons)
        ? source.horizons.find((item) => record(item)?.horizon_minutes === 5)
        : undefined;
      const targetTimestamp = isoTimestamp(record(horizon)?.target_timestamp);
      if (source?.status === "available"
        && targetTimestamp
        && Date.parse(targetTimestamp) <= freshnessCutoff) {
        staleForecastCount += 1;
      }
      return parseCandidate(
        series,
        generatedAt,
        model,
        roundTripCostRate,
        riskPenalty,
        notBeforeMs,
      );
    })
    .filter((candidate): candidate is AiPaperForecastCandidate => candidate !== undefined);
  const duplicateSymbols = new Set<string>();
  const seen = new Set<string>();
  for (const candidate of parsed) {
    if (seen.has(candidate.symbol)) duplicateSymbols.add(candidate.symbol);
    seen.add(candidate.symbol);
  }
  const candidates = parsed
    .filter((candidate) => !duplicateSymbols.has(candidate.symbol))
    .sort((left, right) => right.score - left.score || rawKeyCompare(left.symbol, right.symbol));
  if (candidates.length < config.symbolCount) {
    return {
      ...base,
      status: "unavailable",
      availableCandidateCount: candidates.length,
      generatedAt,
      model,
      reason: staleForecastCount > 0
        ? "stale_forecast_horizon"
        : "insufficient_available_forecasts",
    };
  }
  return {
    policyVersion: AI_PAPER_POLICY_VERSION,
    status: "available",
    requestedSymbolCount: config.symbolCount,
    availableCandidateCount: candidates.length,
    generatedAt,
    model,
    selected: candidates.slice(0, config.symbolCount),
  };
}

function maxTimestamp(left: string, right: string): string {
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

function technicalObservation(value: unknown): {
  state: PaperTechnicalState | null;
  observedAt?: string;
  signalOriginAt?: string;
  calculationAt?: string;
  evidenceAt?: string;
  earliestEligibleAt?: string;
  directionalSignal?: -1 | 0 | 1;
  confidence?: number;
  multiTimeframeAgreement?: string;
  quality: FusionQuality;
  indicators?: RustIndicatorEvidence;
  chartPatternBias: PaperChartPatternBias | null;
  chartPatterns: string[];
  chartPatternStrength: number;
} {
  const source = record(value);
  const rawState = source?.status
    ?? source?.state
    ?? source?.technicalState
    ?? source?.technical_state
    ?? value;
  const state = rawState === "watch" || rawState === "entry_candidate"
    || rawState === "hold" || rawState === "exit_candidate"
    ? rawState
    : null;
  const observedAt = isoTimestamp(source?.observedAt ?? source?.observed_at);
  const signalOriginAt = isoTimestamp(source?.signalOriginAt ?? source?.signal_origin_at);
  const calculationAt = isoTimestamp(source?.calculationAt ?? source?.calculation_at);
  const evidenceAt = isoTimestamp(
    source?.technicalEvidenceAt
      ?? source?.technical_evidence_at
      ?? source?.patternObservedAt
      ?? source?.pattern_observed_at,
  );
  const earliestEligibleAt = isoTimestamp(
    source?.earliestEligibleAt ?? source?.earliest_eligible_at,
  );
  const rawDirectionalSignal = source?.technicalSignal ?? source?.technical_signal;
  const directionalSignal = rawDirectionalSignal === -1
    || rawDirectionalSignal === 0 || rawDirectionalSignal === 1
    ? rawDirectionalSignal
    : state === "entry_candidate" ? 1 : state === "exit_candidate" ? -1 : 0;
  const confidenceValue = source?.confidence;
  const confidence = typeof confidenceValue === "number"
    && Number.isFinite(confidenceValue) && confidenceValue >= 0 && confidenceValue <= 1
    ? confidenceValue
    : undefined;
  const multiTimeframeAgreement = nonemptyString(
    source?.multiTimeframeAgreement ?? source?.multi_timeframe_agreement,
    64,
  );
  const signalQuality = nonemptyString(record(source?.signalDataQuality)?.status, 64)?.toLowerCase();
  const instrumentQuality = nonemptyString(
    record(source?.instrumentDataQuality)?.status,
    64,
  )?.toLowerCase();
  const qualityValues = [signalQuality, instrumentQuality].filter(
    (item): item is string => item !== undefined,
  );
  const quality: FusionQuality = qualityValues.some((item) => item.includes("stale"))
    ? "stale"
    : qualityValues.some((item) => (
        ["unavailable", "invalid", "failed", "error"].some((token) => item.includes(token))
      ))
      ? "unavailable"
      : qualityValues.some((item) => (
          ["partial", "warning", "degraded"].some((token) => item.includes(token))
        ))
        ? "partial"
        : "good";
  const indicators = parseRustIndicatorEvidence(source?.indicatorEvidence);
  const rawBias = source?.chartPatternBias ?? source?.chart_pattern_bias;
  const chartPatternBias = rawBias === "bullish" || rawBias === "bearish" || rawBias === "neutral"
    ? rawBias
    : null;
  const rawPatterns = source?.chartPatterns ?? source?.chart_patterns;
  const chartPatterns = Array.isArray(rawPatterns)
    ? [...new Set(rawPatterns
        .map((pattern) => nonemptyString(pattern, 128))
        .filter((pattern): pattern is string => pattern !== undefined))]
        .slice(0, 16)
    : [];
  const rawPatternStrength = source?.chartPatternStrength ?? source?.chart_pattern_strength;
  const chartPatternStrength = typeof rawPatternStrength === "number"
    && Number.isFinite(rawPatternStrength)
    ? clamp(rawPatternStrength, 0, 1)
    : chartPatternBias === null || chartPatternBias === "neutral" ? 0 : 0.5;
  return {
    state,
    ...(observedAt ? { observedAt } : {}),
    ...(signalOriginAt ? { signalOriginAt } : {}),
    ...(calculationAt ? { calculationAt } : {}),
    ...(evidenceAt ? { evidenceAt } : {}),
    ...(earliestEligibleAt ? { earliestEligibleAt } : {}),
    ...(directionalSignal !== undefined ? { directionalSignal } : {}),
    ...(confidence !== undefined ? { confidence } : {}),
    ...(multiTimeframeAgreement ? { multiTimeframeAgreement } : {}),
    quality,
    ...(indicators ? { indicators } : {}),
    chartPatternBias,
    chartPatterns,
    chartPatternStrength,
  };
}

function modelEvidence(candidate: AiPaperForecastCandidate): {
  admitted: boolean;
  scale: number;
  reasons: string[];
  components: Record<string, number>;
} {
  const reasons: string[] = [];
  const components: Record<string, number> = {};
  const scales: number[] = [1];
  let admitted = true;
  if (candidate.downProbability !== undefined) {
    const directionalEdge = candidate.upProbability - candidate.downProbability;
    components.modelDirectionalEdge = rounded(directionalEdge);
    scales.push(clamp(0.5 + directionalEdge / 2, 0.5, 1));
    if (directionalEdge <= 0) {
      admitted = false;
      reasons.push("model_down_probability_not_below_up_probability");
    }
  }
  if (candidate.flatProbability !== undefined) {
    components.modelFlatProbability = rounded(candidate.flatProbability);
    scales.push(clamp(1 - candidate.flatProbability * 0.5, 0.5, 1));
  }
  if (candidate.expectedVolatility !== undefined) {
    components.modelExpectedVolatility = rounded(candidate.expectedVolatility);
    scales.push(clamp(
      0.02 / Math.max(0.02, candidate.expectedVolatility),
      0.5,
      1,
    ));
  }
  if (candidate.uncertaintyIntervalWidth !== undefined) {
    components.modelUncertaintyIntervalWidth = rounded(candidate.uncertaintyIntervalWidth);
    scales.push(clamp(
      0.04 / Math.max(0.04, candidate.uncertaintyIntervalWidth),
      0.5,
      1,
    ));
  }
  if (candidate.validPathCount !== undefined || candidate.invalidPathCount !== undefined) {
    const valid = candidate.validPathCount ?? 0;
    const invalid = candidate.invalidPathCount ?? 0;
    const total = valid + invalid;
    const reliability = total > 0 ? valid / total : 0.5;
    components.modelValidPathRatio = rounded(reliability);
    scales.push(clamp(reliability, 0.5, 1));
  }
  const targetStop = candidate.targetStop;
  if (targetStop?.status === "available") {
    const targetLower = targetStop.targetFirstProbabilityLower;
    const targetUpper = targetStop.targetFirstProbabilityUpper;
    const stopLower = targetStop.stopFirstProbabilityLower;
    const stopUpper = targetStop.stopFirstProbabilityUpper;
    if (targetLower !== undefined) components.targetFirstProbabilityLower = targetLower;
    if (targetUpper !== undefined) components.targetFirstProbabilityUpper = targetUpper;
    if (stopLower !== undefined) components.stopFirstProbabilityLower = stopLower;
    if (stopUpper !== undefined) components.stopFirstProbabilityUpper = stopUpper;
    if (targetStop.ambiguousProbability !== undefined) {
      components.targetStopAmbiguousProbability = targetStop.ambiguousProbability;
    }
    if (targetStop.neitherProbability !== undefined) {
      components.targetStopNeitherProbability = targetStop.neitherProbability;
    }
    if (targetLower !== undefined && stopUpper !== undefined) {
      scales.push(clamp(0.5 + (targetLower - stopUpper) / 2, 0.35, 1));
    }
    if (targetUpper !== undefined && stopLower !== undefined && targetUpper < stopLower) {
      admitted = false;
      reasons.push("model_target_before_stop_definitively_unfavorable");
    }
    const unresolvedProbability = (
      targetStop.ambiguousProbability ?? 0
    ) + (targetStop.neitherProbability ?? 0);
    if (unresolvedProbability > 0) {
      scales.push(clamp(1 - unresolvedProbability * 0.5, 0.5, 1));
    }
  }
  const scale = rounded(Math.min(...scales));
  return {
    admitted,
    scale,
    reasons,
    components,
  };
}

export function decidePaperActions(input: {
  selection: AiPaperSelection;
  profile: ResolvedPaperPolicyProfile;
  technicalStates?: Readonly<Record<string, unknown>>;
  heldSymbols?: readonly string[];
  modelLane?: SimulationModelLane;
}): PaperPolicyAction[] {
  if (input.selection.status !== "available") return [];
  const held = new Set(input.heldSymbols ?? []);
  return input.selection.selected.map((candidate) => {
    const observation = technicalObservation(input.technicalStates?.[candidate.symbol]);
    const state = observation.state;
    const isHeld = held.has(candidate.symbol);
    const technicalEntryConfirmed = input.profile.technicalConfirmation === "entry_candidate"
      ? state === "entry_candidate"
      : state !== "exit_candidate";
    const patternEntryConfirmed = input.profile.patternConfirmation === "bullish"
      ? observation.chartPatternBias === "bullish"
      : observation.chartPatternBias !== "bearish";
    const hasTechnicalEvidence = Boolean(
      observation.state
      || observation.signalOriginAt
      || observation.calculationAt
      || observation.evidenceAt
      || observation.indicators
      || observation.chartPatternBias && observation.chartPatternBias !== "neutral",
    );
    const baseFusion = fuseForecastWithTechnical({
      lane: input.modelLane ?? (
        candidate.model.modelId === FINCAST_MODEL_ID ? "fincast" : "chronos2"
      ),
      modelDirection: "long",
      modelConfidence: candidate.upProbability,
      modelOriginAt: candidate.inputEndAt,
      modelGeneratedAt: candidate.generatedAt,
      ...(hasTechnicalEvidence ? {
        technical: {
          originAt: observation.signalOriginAt ?? observation.calculationAt,
          calculationAt: observation.calculationAt ?? observation.signalOriginAt,
          evidenceAt: observation.evidenceAt,
          ...(observation.earliestEligibleAt
            ? { eligibleAfter: observation.earliestEligibleAt } : {}),
          quality: observation.quality,
          directionalSignal: observation.directionalSignal,
          confidence: observation.confidence,
          multiTimeframeAgreement: observation.multiTimeframeAgreement,
          indicators: observation.indicators,
          patternBias: observation.chartPatternBias ?? undefined,
          patternStrength: observation.chartPatternStrength,
        },
      } : {}),
      maximumTechnicalAgeMs: AI_PAPER_FORECAST_HORIZON_MINUTES * 2 * 60_000,
    });
    const fusion: ForecastTechnicalFusionResult = hasTechnicalEvidence
      ? baseFusion
      : {
          ...baseFusion,
          admitted: false,
          exposureScale: 0,
          reasonCodes: ["technical_evidence_missing"],
        };
    const model = modelEvidence(candidate);
    const exitReasons = [
      ...(!hasTechnicalEvidence ? ["technical_evidence_missing"] : []),
      ...(candidate.score < 0 ? ["negative_risk_adjusted_score"] : []),
      ...(candidate.upProbability <= input.profile.exitUpProbability
        ? ["low_up_probability"] : []),
      ...(state === "exit_candidate" ? ["technical_exit_candidate"] : []),
      ...(observation.chartPatternBias === "bearish" ? ["bearish_chart_pattern"] : []),
    ];
    const canEnter = candidate.score > 0
      && candidate.upProbability >= input.profile.entryUpProbability
      && technicalEntryConfirmed
      && patternEntryConfirmed
      && fusion.admitted
      && model.admitted;
    const action: PaperPolicyActionKind = isHeld
      ? exitReasons.length ? "sell" : "hold"
      : canEnter ? "buy" : "watch";
    const reasons = action === "buy"
      ? [
          "positive_risk_adjusted_score",
          "entry_probability_threshold",
          input.profile.technicalConfirmation === "entry_candidate"
            ? "technical_entry_confirmation"
            : "technical_exit_absent",
          input.profile.patternConfirmation === "bullish"
            ? "bullish_chart_pattern"
            : "bearish_chart_pattern_absent",
        ]
      : action === "sell" ? exitReasons
        : action === "hold" ? ["exit_conditions_absent"]
          : [
              ...(candidate.score <= 0 ? ["entry_score_threshold_not_met"] : []),
              ...(candidate.upProbability < input.profile.entryUpProbability
                ? ["entry_probability_threshold_not_met"] : []),
              ...(state === "exit_candidate" ? ["technical_exit_candidate"] : []),
              ...(state !== "exit_candidate" && !technicalEntryConfirmed
                ? ["technical_entry_confirmation_required"] : []),
              ...(observation.chartPatternBias === "bearish"
                ? ["bearish_chart_pattern"] : []),
              ...(observation.chartPatternBias !== "bearish" && !patternEntryConfirmed
                ? ["bullish_chart_pattern_required"] : []),
              ...(!fusion.admitted ? fusion.reasonCodes : []),
              ...(!model.admitted ? model.reasons : []),
            ];
    const aiEligibleAfter = maxTimestamp(candidate.inputEndAt, candidate.generatedAt);
    const technicalEligibleAfter = [
      observation.observedAt,
      observation.earliestEligibleAt,
      fusion.eligibleAfter,
    ].filter((item): item is string => item !== undefined)
      .reduce(maxTimestamp, aiEligibleAfter);
    const eligibleAfter = maxTimestamp(aiEligibleAfter, technicalEligibleAfter);
    return {
      policyVersion: AI_PAPER_POLICY_VERSION,
      symbol: candidate.symbol,
      action,
      eligibleAfter,
      inputEndAt: candidate.inputEndAt,
      forecastGeneratedAt: candidate.generatedAt,
      score: candidate.score,
      medianReturn: candidate.medianReturn,
      q10Return: candidate.q10Return,
      q90Return: candidate.q90Return,
      upProbability: candidate.upProbability,
      technicalState: state,
      ...(observation.observedAt ? { technicalObservedAt: observation.observedAt } : {}),
      chartPatternBias: observation.chartPatternBias,
      chartPatterns: [...observation.chartPatterns],
      chartPatternStrength: observation.chartPatternStrength,
      fusionPolicyVersion: FORECAST_TECHNICAL_FUSION_VERSION,
      technicalScore: fusion.technicalScore,
      technicalDirection: fusion.technicalDirection,
      exposureScale: fusion.exposureScale,
      modelEvidenceScale: model.scale,
      technicalComponents: {
        ...fusion.components,
        ...model.components,
      },
      targetAllocationRate: rounded(
        hasTechnicalEvidence
          ? input.profile.targetAllocationRate
            * (action === "buy" ? fusion.exposureScale * model.scale : 1)
          : 0,
      ),
      reasons: action === "buy"
        ? [...reasons, ...fusion.reasonCodes, ...model.reasons]
        : reasons,
      model: candidate.model,
    };
  });
}

function validMoney(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function cloneLedger(ledger: PaperLedger): PaperLedger {
  return {
    ...ledger,
    positions: Object.fromEntries(
      Object.entries(ledger.positions).map(([symbol, position]) => [symbol, { ...position }]),
    ),
  };
}

function ledgerIsValid(ledger: PaperLedger): boolean {
  return ledger.policyVersion === AI_PAPER_POLICY_VERSION
    && Number.isFinite(ledger.initialCash) && ledger.initialCash > 0
    && validMoney(ledger.cash)
    && Number.isFinite(ledger.realizedPnl)
    && validMoney(ledger.totalCosts)
    && Object.entries(ledger.positions).every(([symbol, position]) => (
      symbol === position.symbol
      && Number.isSafeInteger(position.quantity) && position.quantity > 0
      && Number.isFinite(position.averagePrice) && position.averagePrice > 0
      && Number.isFinite(position.costBasis) && position.costBasis > 0
    ));
}

function validateCosts(costs: PaperTradingCosts): {
  commissionRate: number;
  exitTaxRate: number;
  halfSpreadRate: number;
  slippageRate: number;
} {
  const fields = [
    costs.commissionBpsPerSide,
    costs.exitTaxBps,
    costs.spreadBpsRoundTrip,
    costs.slippageBpsPerSide,
  ];
  if (fields.some((value) => !Number.isFinite(value) || value < 0 || value > 5_000)) {
    throw new RangeError("Paper trading cost assumptions must be finite basis points in [0, 5000].");
  }
  const output = {
    commissionRate: costs.commissionBpsPerSide / 10_000,
    exitTaxRate: costs.exitTaxBps / 10_000,
    halfSpreadRate: costs.spreadBpsRoundTrip / 20_000,
    slippageRate: costs.slippageBpsPerSide / 10_000,
  };
  if (output.commissionRate + output.exitTaxRate + output.halfSpreadRate + output.slippageRate >= 1) {
    throw new RangeError("Paper trading sell costs must remain below the gross proceeds.");
  }
  return output;
}

function statutoryExecutionCharges(
  costs: PaperTradingCosts,
  side: "buy" | "sell",
  grossAmount: number,
  quantity: number,
  rates: ReturnType<typeof validateCosts>,
): {
  commission: number;
  exitTax: number;
  regulatoryFee: number;
} {
  if (!costs.marketCostProfile) {
    return {
      commission: grossAmount * rates.commissionRate,
      exitTax: side === "sell" ? grossAmount * rates.exitTaxRate : 0,
      regulatoryFee: 0,
    };
  }
  return calculateBrokerExecutionCharges(costs.marketCostProfile, {
    side,
    grossAmount,
    quantity,
    costs: {
      commissionBpsPerSide: costs.commissionBpsPerSide,
      taxBpsOnExit: costs.exitTaxBps,
    },
  });
}

function rejected(ledger: PaperLedger, reason: PaperFillResult["reason"]): PaperFillResult {
  return { status: "rejected", reason, ledger: cloneLedger(ledger) };
}

function skipped(ledger: PaperLedger, reason: PaperFillResult["reason"]): PaperFillResult {
  return { status: "skipped", reason, ledger: cloneLedger(ledger) };
}

export function createPaperLedger(initialCash: number): PaperLedger {
  if (!Number.isFinite(initialCash) || initialCash <= 0) {
    throw new RangeError("initialCash must be a positive finite amount.");
  }
  return {
    policyVersion: AI_PAPER_POLICY_VERSION,
    initialCash,
    cash: initialCash,
    positions: {},
    realizedPnl: 0,
    totalCosts: 0,
  };
}

function currentEquity(
  ledger: PaperLedger,
  actionSymbol: string,
  actionPrice: number,
  marks: Readonly<Record<string, number>> | undefined,
): number | undefined {
  let equity = ledger.cash;
  for (const [symbol, position] of Object.entries(ledger.positions)) {
    const price = symbol === actionSymbol ? actionPrice : marks?.[symbol];
    if (price === undefined || !Number.isFinite(price) || price <= 0) return undefined;
    equity += position.quantity * price;
  }
  return Number.isFinite(equity) && equity > 0 ? equity : undefined;
}

export function fillPaperAction(
  ledgerInput: PaperLedger,
  action: PaperPolicyAction,
  execution: PaperExecution,
  config: PaperFillConfig,
): PaperFillResult {
  const ledger = cloneLedger(ledgerInput);
  if (!ledgerIsValid(ledger)) return rejected(ledger, "invalid_ledger");
  if (action.action !== "buy" && action.action !== "sell") {
    return skipped(ledger, "non_executable_action");
  }
  if (config.symbolCount !== 1 && config.symbolCount !== 2) {
    throw new RangeError("symbolCount must be exactly 1 or 2.");
  }
  if (!Number.isFinite(config.targetAllocationRate)
    || config.targetAllocationRate <= 0
    || config.targetAllocationRate > 1) {
    throw new RangeError("targetAllocationRate must be a finite decimal rate in (0, 1].");
  }
  const rates = validateCosts(config.costs);
  const executedAt = isoTimestamp(execution.timestamp);
  const eligibleAfter = isoTimestamp(action.eligibleAfter);
  if (!executedAt || !eligibleAfter || !Number.isFinite(execution.price) || execution.price <= 0) {
    return rejected(ledger, "invalid_execution");
  }
  if (Date.parse(executedAt) <= Date.parse(eligibleAfter)) {
    return rejected(ledger, "execution_not_after_eligible");
  }

  if (action.action === "sell") {
    const position = ledger.positions[action.symbol];
    if (!position) return skipped(ledger, "position_not_held");
    const quantity = position.quantity;
    const grossAmount = quantity * execution.price;
    const statutory = statutoryExecutionCharges(
      config.costs,
      "sell",
      grossAmount,
      quantity,
      rates,
    );
    const { commission, exitTax, regulatoryFee } = statutory;
    const spreadCost = grossAmount * rates.halfSpreadRate;
    const slippageCost = grossAmount * rates.slippageRate;
    const totalCosts = commission + exitTax + regulatoryFee + spreadCost + slippageCost;
    const proceeds = grossAmount - totalCosts;
    if (!validMoney(proceeds)) return rejected(ledger, "invalid_execution");
    ledger.cash += proceeds;
    ledger.realizedPnl += proceeds - position.costBasis;
    ledger.totalCosts += totalCosts;
    delete ledger.positions[action.symbol];
    const trade: PaperTrade = {
      policyVersion: AI_PAPER_POLICY_VERSION,
      symbol: action.symbol,
      side: "sell",
      signalEligibleAfter: eligibleAfter,
      executedAt,
      price: execution.price,
      quantity,
      grossAmount,
      commission,
      exitTax,
      regulatoryFee,
      spreadCost,
      slippageCost,
      totalCosts,
      cashAfter: ledger.cash,
      positionQuantityAfter: 0,
    };
    return { status: "filled", reason: "filled", ledger, trade };
  }

  const equity = config.allocationEquity === undefined
    ? currentEquity(ledger, action.symbol, execution.price, config.markPrices)
    : Number.isFinite(config.allocationEquity) && config.allocationEquity > 0
      ? config.allocationEquity
      : undefined;
  if (equity === undefined) return rejected(ledger, "mark_price_unavailable");
  const current = ledger.positions[action.symbol];
  const currentGross = (current?.quantity ?? 0) * execution.price;
  const targetGross = equity * config.targetAllocationRate / config.symbolCount;
  const desiredQuantity = Math.floor(Math.max(0, targetGross - currentGross) / execution.price);
  if (desiredQuantity <= 0) return skipped(ledger, "target_already_met");
  const maximumQuantity = Math.min(
    desiredQuantity,
    Math.floor((ledger.cash + Number.EPSILON) / execution.price),
  );
  let low = 0;
  let high = maximumQuantity;
  while (low < high) {
    const candidate = Math.ceil((low + high) / 2);
    const candidateGross = candidate * execution.price;
    const statutory = statutoryExecutionCharges(
      config.costs,
      "buy",
      candidateGross,
      candidate,
      rates,
    );
    const candidateDebit = candidateGross
      + statutory.commission
      + candidateGross * rates.halfSpreadRate
      + candidateGross * rates.slippageRate;
    if (candidateDebit <= ledger.cash + 1e-9) low = candidate;
    else high = candidate - 1;
  }
  const quantity = low;
  if (quantity <= 0) return skipped(ledger, "insufficient_cash");
  const grossAmount = quantity * execution.price;
  const statutory = statutoryExecutionCharges(
    config.costs,
    "buy",
    grossAmount,
    quantity,
    rates,
  );
  const { commission, regulatoryFee } = statutory;
  const spreadCost = grossAmount * rates.halfSpreadRate;
  const slippageCost = grossAmount * rates.slippageRate;
  const totalCosts = commission + regulatoryFee + spreadCost + slippageCost;
  const debit = grossAmount + totalCosts;
  if (debit > ledger.cash + 1e-9) return skipped(ledger, "insufficient_cash");
  ledger.cash = Math.max(0, ledger.cash - debit);
  ledger.totalCosts += totalCosts;
  const priorQuantity = current?.quantity ?? 0;
  const newQuantity = priorQuantity + quantity;
  const costBasis = (current?.costBasis ?? 0) + debit;
  ledger.positions[action.symbol] = {
    symbol: action.symbol,
    quantity: newQuantity,
    averagePrice: costBasis / newQuantity,
    costBasis,
  };
  const trade: PaperTrade = {
    policyVersion: AI_PAPER_POLICY_VERSION,
    symbol: action.symbol,
    side: "buy",
    signalEligibleAfter: eligibleAfter,
    executedAt,
    price: execution.price,
    quantity,
    grossAmount,
    commission,
    exitTax: 0,
    regulatoryFee,
    spreadCost,
    slippageCost,
    totalCosts,
    cashAfter: ledger.cash,
    positionQuantityAfter: newQuantity,
  };
  return { status: "filled", reason: "filled", ledger, trade };
}
