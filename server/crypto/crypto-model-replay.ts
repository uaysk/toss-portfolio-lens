import { createHash, randomUUID } from "node:crypto";
import {
  AiCostAssumptionsSchema,
  AiEvaluateRequestSchema,
  AiResponseSchema,
  CHRONOS_2_MODEL_ID,
  FINCAST_QUALIFICATION_QUANTILE_ROWS,
  FINCAST_MODEL_ID,
  QuantileRearrangementObservationsSchema,
  SCALPING_AI_HORIZONS,
  SCALPING_AI_QUANTILES,
  SCALPING_AI_SCHEMA_VERSION,
  type AiEvaluateRequest,
  type AiResponse,
} from "../worker/ai-contract.js";
import {
  normalizeRestKlines,
  type BinanceKline,
  type BinanceRestMarketData,
} from "./binance-market-data.js";

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const REPLAY_DAYS = 7;
const DEFAULT_REPLAY_DURATION_HOURS = REPLAY_DAYS * 24;
const MAXIMUM_REPLAY_DURATION_HOURS = 5 * 7 * 24;
const BINANCE_PAGE_LIMIT = 1_024;
const ORIGIN_STRIDE_BARS = 15;
const FUTURE_BAR_COUNT = 60;
const DEFAULT_CONTEXT_BARS = 512;
const MAXIMUM_RAW_CONTEXT_BARS = 8192;
const DEFAULT_DEADLINE_MS = 2 * 60 * 60_000;
const MAXIMUM_DEADLINE_MS = 24 * 60 * 60_000;
const NUMBER_TOLERANCE = 1e-12;
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

export type CryptoReplayLane = "chronos2" | "fincast";
type PrecisionFailureReason = typeof PRECISION_FAILURE_REASONS[number];
type ReplayPrecision = "fp16" | "fp32";
type ReplayPrecisionValidation = "not_required" | "passed" | "fallback_fp32";
export type CryptoReplayQuantileObservations = {
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

export type CryptoReplayModelProvenance = {
  modelId: typeof CHRONOS_2_MODEL_ID | typeof FINCAST_MODEL_ID;
  modelRevision: string;
  sourceRevision: string;
  loaderVersion: string;
  license: string;
  tokenizerId: string | null;
  tokenizerRevision: string | null;
  loaded: true;
  device: "cuda";
  deviceName: string;
  cudaCapability: string;
  attentionBackend: "math";
  precision: ReplayPrecision;
  precisionValidation: ReplayPrecisionValidation;
  precisionFallbackUsed: boolean;
  peakVramBytes: number | null;
  peakVramMeasurement: "cuda_allocated_or_reserved" | null;
  memoryStatus: "ok";
  quantileMonotonicityPolicy:
    | "chronos2_fp32_monotone_rearrangement_v1"
    | "fp32_monotone_rearrangement_v1";
  fp32QuantileObservations: CryptoReplayQuantileObservations | null;
  mixedQuantileObservations: CryptoReplayQuantileObservations | null;
  quantileTailPolicy: "native" | "tail_clamped_q10_q90";
  precisionFailureReasons: PrecisionFailureReason[];
};

export interface CryptoReplayLaneClient {
  request(input: AiEvaluateRequest, signal?: AbortSignal): Promise<unknown>;
}

export interface CryptoReplayClock {
  now(): number;
}

export type CryptoReplayCostAssumptions = AiEvaluateRequest["cost_assumptions"];

export type CryptoModelReplayOptions = {
  rest: Pick<BinanceRestMarketData, "klines">;
  lanes: Record<CryptoReplayLane, CryptoReplayLaneClient>;
  clock?: CryptoReplayClock;
  contextBars?: number;
  deadlineMs?: number;
  requestId?: () => string;
};

export type CryptoModelReplayInput = {
  symbol: string;
  costAssumptions: CryptoReplayCostAssumptions;
  signal?: AbortSignal;
  deadlineMs?: number;
  durationHours?: number;
  endExclusive?: number;
};

export type CryptoReplayRawContextRow = {
  instrumentKey: string;
  origin: string;
  futureTimestamps: readonly string[];
  closes: readonly number[];
  metadata: {
    symbol: string;
    originOrdinal: number;
    windowStartAt: string;
    windowEndExclusiveAt: string;
  };
};

export type CryptoReplayRawContextResult = {
  symbol: string;
  durationHours: number;
  startAt: string;
  endExclusiveAt: string;
  contextBars: number;
  inputBarCount: number;
  marketBars: readonly BinanceKline[];
  rows: CryptoReplayRawContextRow[];
};

export type CryptoReplayQuantileMetric = {
  quantile: (typeof SCALPING_AI_QUANTILES)[number];
  pinballLoss: number;
  observedCoverage: number;
  calibrationError: number;
};

export type CryptoReplayHorizonMetrics = {
  horizonMinutes: (typeof SCALPING_AI_HORIZONS)[number];
  count: number;
  meanPinballLoss: number | null;
  medianReturnMae: number | null;
  directionAccuracy: number | null;
  quantiles: CryptoReplayQuantileMetric[];
};

export type CryptoReplayLaneResult = {
  lane: CryptoReplayLane;
  expectedModelId: typeof CHRONOS_2_MODEL_ID | typeof FINCAST_MODEL_ID;
  observedModelId?: string;
  availability: "available" | "partial" | "unavailable";
  identityVerified: boolean;
  inputDigest: string;
  recordDigest?: string;
  predictionDigest?: string;
  effectiveContextDigest?: string;
  effectiveContextBars?: number;
  provenance?: CryptoReplayModelProvenance;
  latencyMs: number;
  fallbackUsed: false;
  metrics: CryptoReplayHorizonMetrics[];
  error?: {
    code: string;
    message: string;
  };
};

export type CryptoModelReplayResult = {
  schemaVersion: "crypto-model-comparison-replay/v1";
  generatedAt: string;
  market: {
    kind: "crypto_futures";
    venue: "BINANCE_USDM";
    quoteAsset: "USDT";
    contractType: "PERPETUAL";
  };
  symbol: string;
  window: {
    startAt: string;
    endExclusiveAt: string;
    durationHours: number;
    completeUtcDays: number | null;
    barCount: number;
    contextPrefetchBarCount: number;
    outcomeTailBarCount: 60;
    inputBarCount: number;
    originCount: number;
    originStrideMinutes: 15;
    futureBarsPerOrigin: 60;
  };
  requestId: string;
  inputDigest: string;
  costAssumptions: CryptoReplayCostAssumptions;
  lanes: Record<CryptoReplayLane, CryptoReplayLaneResult>;
  comparison: {
    identitiesVerified: boolean;
    sameInputDigest: boolean;
    sameRecords: boolean;
    sameOrigin: boolean;
    sameContext: boolean;
    sameCosts: boolean;
    sameFillBarrier: boolean;
    automaticWinner: null;
    outcome: "inconclusive" | "review_required";
  };
};

export type CryptoModelReplayErrorCode =
  | "invalid_input"
  | "data_gap"
  | "non_final_bar"
  | "pagination_stalled"
  | "deadline_exceeded"
  | "cancelled";

export class CryptoModelReplayError extends Error {
  constructor(
    readonly code: CryptoModelReplayErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CryptoModelReplayError";
  }
}

type ReplayWindow = {
  evaluationStart: number;
  dataStart: number;
  endExclusive: number;
  dataEndExclusive: number;
};

type ExpectedRecord = {
  key: string;
  instrumentKey: string;
  originMs: number;
  horizonMinutes: (typeof SCALPING_AI_HORIZONS)[number];
  targetTimestampMs: number;
  actualReturn: number;
  executionReturn: number;
};

type ValidatedLane = {
  response: AiResponse;
  recordDigest: string;
  predictionDigest: string;
  effectiveContextDigest: string;
  provenance: CryptoReplayModelProvenance;
  metrics: CryptoReplayHorizonMetrics[];
};

type LaneInvocation = {
  result: CryptoReplayLaneResult;
  validated?: ValidatedLane;
};

class LaneReplayValidationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly observedModelId?: string,
  ) {
    super(message);
    this.name = "LaneReplayValidationError";
  }
}

const expectedModelId = {
  chronos2: CHRONOS_2_MODEL_ID,
  fincast: FINCAST_MODEL_ID,
} as const satisfies Record<CryptoReplayLane, string>;

const pinnedModelProvenance = {
  chronos2: {
    modelId: CHRONOS_2_MODEL_ID,
    modelRevision: "254b5357164a84326913b0695216f690752ac55d",
    sourceRevision: "v2.3.1",
    loaderVersion: "chronos-forecasting-2.3.1",
    license: "Apache-2.0",
    tokenizerId: null,
    tokenizerRevision: null,
  },
  fincast: {
    modelId: FINCAST_MODEL_ID,
    modelRevision: "2d7d90b159db8961d27c2cf165d51195902ef92b",
    sourceRevision: "488b19d1d85fa2b3d4b93469530cefdcf1cc97a4",
    loaderVersion: "fincast-source-488b19d",
    license: "Apache-2.0",
    tokenizerId: null,
    tokenizerRevision: null,
  },
} as const satisfies Record<CryptoReplayLane, {
  modelId: string;
  modelRevision: string;
  sourceRevision: string;
  loaderVersion: string;
  license: string;
  tokenizerId: string | null;
  tokenizerRevision: string | null;
}>;

function normalizedPrecisionFailureReasons(
  value: unknown,
): PrecisionFailureReason[] | undefined {
  if (!Array.isArray(value) || value.length > PRECISION_FAILURE_REASONS.length) {
    return undefined;
  }
  const normalized: PrecisionFailureReason[] = [];
  for (const reason of value) {
    if (typeof reason !== "string"
      || !(PRECISION_FAILURE_REASONS as readonly string[]).includes(reason)
      || normalized.includes(reason as PrecisionFailureReason)) {
      return undefined;
    }
    normalized.push(reason as PrecisionFailureReason);
  }
  return normalized;
}

function replayQuantileObservations(
  value: unknown,
): CryptoReplayQuantileObservations | null | undefined {
  if (value === undefined || value === null) return value;
  const parsed = QuantileRearrangementObservationsSchema.safeParse(value);
  if (!parsed.success) return undefined;
  return {
    rowCount: parsed.data.row_count,
    nonFiniteValueCount: parsed.data.non_finite_value_count,
    crossingRowCount: parsed.data.crossing_row_count,
    crossingAdjacentPairCount: parsed.data.crossing_adjacent_pair_count,
    adjustedRowCount: parsed.data.adjusted_row_count,
    q50AdjustmentIqrRatioMedian: parsed.data.q50_adjustment_iqr_ratio_median,
    q50AdjustmentIqrRatioP95: parsed.data.q50_adjustment_iqr_ratio_p95,
    q50AdjustmentIqrRatioMax: parsed.data.q50_adjustment_iqr_ratio_max,
    postprocessedMonotonic: parsed.data.postprocessed_monotonic,
  };
}

function validatePinnedProvenance(
  role: CryptoReplayLane,
  model: AiResponse["model"],
): CryptoReplayModelProvenance {
  const pinned = pinnedModelProvenance[role];
  if (model.model_id !== pinned.modelId
    || model.model_revision !== pinned.modelRevision
    || model.source_revision !== pinned.sourceRevision
    || model.loader_version !== pinned.loaderVersion
    || model.license !== pinned.license) {
    throw new LaneReplayValidationError(
      "MODEL_PROVENANCE_MISMATCH",
      `The ${role} lane did not use the pinned model and source provenance.`,
      model.model_id,
    );
  }
  if (model.tokenizer_id !== pinned.tokenizerId
    || model.tokenizer_revision !== pinned.tokenizerRevision) {
    throw new LaneReplayValidationError(
      "MODEL_TOKENIZER_PROVENANCE_MISMATCH",
      `The ${role} lane did not use the pinned tokenizer provenance.`,
      model.model_id,
    );
  }

  const deviceName = model.device_name?.trim();
  const cudaCapability = model.cuda_capability ?? undefined;
  if (!model.loaded
    || model.device !== "cuda"
    || model.attention_backend !== "math"
    || !deviceName
    || deviceName !== model.device_name
    || deviceName !== PINNED_GPU_DEVICE_NAME
    || !cudaCapability
    || cudaCapability !== PINNED_GPU_CUDA_CAPABILITY) {
    throw new LaneReplayValidationError(
      "MODEL_RUNTIME_PROVENANCE_INVALID",
      `The ${role} lane did not report a loaded CUDA/math runtime.`,
      model.model_id,
    );
  }

  const rawPrecisionValidation = model.precision_validation;
  const rawMemoryStatus = model.memory_status;
  const rawQuantileMonotonicityPolicy = model.quantile_monotonicity_policy;
  const rawFp32QuantileObservations = model.fp32_quantile_observations;
  const rawMixedQuantileObservations = model.mixed_quantile_observations;
  const rawQuantileTailPolicy = model.quantile_tail_policy;
  const rawPrecisionFailureReasons = model.precision_failure_reasons;
  const precision: ReplayPrecision | undefined = model.dtype === "mixed_float16"
    ? "fp16"
    : model.dtype === "float32" ? "fp32" : undefined;
  const precisionValidation = rawPrecisionValidation;
  const memoryStatus = rawMemoryStatus;
  const quantileMonotonicityPolicy = rawQuantileMonotonicityPolicy;
  const quantileTailPolicy = rawQuantileTailPolicy;
  const precisionFailureReasons = normalizedPrecisionFailureReasons(
    rawPrecisionFailureReasons ?? [],
  );
  if (!precisionFailureReasons) {
    throw new LaneReplayValidationError(
      "MODEL_PRECISION_FAILURE_REASONS_INVALID",
      `The ${role} lane returned unbounded precision validation failure reasons.`,
      model.model_id,
    );
  }
  const fp32QuantileObservations = replayQuantileObservations(
    rawFp32QuantileObservations,
  );
  const mixedQuantileObservations = replayQuantileObservations(
    rawMixedQuantileObservations,
  );

  const peakVramBytes = model.peak_vram_bytes ?? null;
  const peakVramMeasurement = model.peak_vram_measurement ?? null;
  if ((peakVramBytes === null) !== (peakVramMeasurement === null)
    || (peakVramBytes !== null
      && (!Number.isSafeInteger(peakVramBytes) || peakVramBytes < 0))
    || (peakVramMeasurement !== null
      && peakVramMeasurement !== "cuda_allocated_or_reserved")) {
    throw new LaneReplayValidationError(
      "MODEL_PEAK_VRAM_INVALID",
      `The ${role} lane returned invalid peak VRAM provenance.`,
      model.model_id,
    );
  }

  if (role === "chronos2") {
    if (precision !== "fp32"
      || precisionValidation !== "not_required"
      || memoryStatus !== "ok"
      || quantileMonotonicityPolicy !== "chronos2_fp32_monotone_rearrangement_v1"
      || (fp32QuantileObservations !== undefined && fp32QuantileObservations !== null)
      || (mixedQuantileObservations !== undefined && mixedQuantileObservations !== null)
      || quantileTailPolicy !== "native"
      || precisionFailureReasons.length > 0) {
      throw new LaneReplayValidationError(
        "MODEL_PRECISION_PROVENANCE_INVALID",
        "The Chronos-2 lane did not report monotone-rearranged FP32 provenance.",
        model.model_id,
      );
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
      throw new LaneReplayValidationError(
        "MODEL_QUANTILE_OBSERVATIONS_INVALID",
        "The FinCast lane did not report bounded precision-qualification observations.",
        model.model_id,
      );
    }
    if ((!mixedPrecisionValid && !fp32FallbackValid)
      || memoryStatus !== "ok"
      || quantileMonotonicityPolicy !== "fp32_monotone_rearrangement_v1"
      || quantileTailPolicy !== "tail_clamped_q10_q90"
      || peakVramBytes === null
      || peakVramBytes <= 0
      || peakVramMeasurement !== "cuda_allocated_or_reserved") {
      throw new LaneReplayValidationError(
        "MODEL_PRECISION_PROVENANCE_INVALID",
        "The FinCast lane did not report validated FP16 or lossless FP32 fallback provenance.",
        model.model_id,
      );
    }
  }

  return {
    modelId: pinned.modelId,
    modelRevision: pinned.modelRevision,
    sourceRevision: pinned.sourceRevision,
    loaderVersion: pinned.loaderVersion,
    license: pinned.license,
    tokenizerId: model.tokenizer_id ?? null,
    tokenizerRevision: model.tokenizer_revision ?? null,
    loaded: true,
    device: "cuda",
    deviceName: PINNED_GPU_DEVICE_NAME,
    cudaCapability: PINNED_GPU_CUDA_CAPABILITY,
    attentionBackend: "math",
    precision,
    precisionValidation,
    precisionFallbackUsed: precisionValidation === "fallback_fp32",
    peakVramBytes,
    peakVramMeasurement,
    memoryStatus,
    quantileMonotonicityPolicy,
    fp32QuantileObservations: fp32QuantileObservations ?? null,
    mixedQuantileObservations: mixedQuantileObservations ?? null,
    quantileTailPolicy,
    precisionFailureReasons,
  };
}

function finiteInteger(
  value: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new CryptoModelReplayError(
      "invalid_input",
      `${name} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
  return value;
}

function normalizedSymbol(value: string): string {
  const symbol = value.trim().toUpperCase();
  if (!/^[A-Z0-9]{2,32}$/.test(symbol) || !symbol.endsWith("USDT")) {
    throw new CryptoModelReplayError(
      "invalid_input",
      "Replay symbol must be a Binance USDT contract symbol.",
    );
  }
  return symbol;
}

function replayWindow(
  now: number,
  contextBars: number,
  durationHours: number,
  requestedEndExclusive?: number,
): ReplayWindow {
  if (!Number.isFinite(now) || now < DAY_MS) {
    throw new CryptoModelReplayError("invalid_input", "Replay clock returned an invalid instant.");
  }
  let endExclusive: number;
  if (requestedEndExclusive === undefined) {
    const date = new Date(now);
    const todayStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
    endExclusive = now >= todayStart + FUTURE_BAR_COUNT * MINUTE_MS
      ? todayStart
      : todayStart - DAY_MS;
  } else {
    if (!Number.isSafeInteger(requestedEndExclusive)
      || requestedEndExclusive <= 0
      || requestedEndExclusive % MINUTE_MS !== 0
      || requestedEndExclusive + FUTURE_BAR_COUNT * MINUTE_MS > now) {
      throw new CryptoModelReplayError(
        "invalid_input",
        "Replay endExclusive must be an exact completed UTC minute with a complete outcome tail.",
      );
    }
    endExclusive = requestedEndExclusive;
  }
  const evaluationStart = endExclusive - durationHours * 60 * MINUTE_MS;
  return {
    evaluationStart,
    dataStart: evaluationStart - (contextBars - 1) * MINUTE_MS,
    endExclusive,
    dataEndExclusive: endExclusive + FUTURE_BAR_COUNT * MINUTE_MS,
  };
}

function safeLaneError(error: unknown): { code: string; message: string } {
  if (error instanceof LaneReplayValidationError) {
    return {
      code: error.code,
      message: `The model lane failed replay validation (${error.code}).`,
    };
  }
  if (error instanceof Error && error.name === "ZodError") {
    return {
      code: "INVALID_RESPONSE_CONTRACT",
      message: "The model lane returned an invalid response contract.",
    };
  }
  return {
    code: "LANE_UNAVAILABLE",
    message: "The model lane was unavailable during replay.",
  };
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function semanticRequestDigest(request: AiEvaluateRequest): string {
  const { request_id: _requestId, ...semanticRequest } = request;
  return digest(semanticRequest);
}

function sameNumber(left: number, right: number): boolean {
  return Math.abs(left - right) <= NUMBER_TOLERANCE;
}

function exactEpochMillisecond(value: string): number | undefined {
  const match = value.match(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.(\d+))?(?:Z|[+-]\d{2}:\d{2})$/,
  );
  if (!match) return undefined;
  const subMillisecondDigits = (match[1] ?? "").slice(3);
  if (subMillisecondDigits && /[^0]/.test(subMillisecondDigits)) return undefined;
  const parsed = Date.parse(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function direction(value: number): -1 | 0 | 1 {
  return value > 0 ? 1 : value < 0 ? -1 : 0;
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freezeDeep(child);
  }
  return value;
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof CryptoModelReplayError) return signal.reason;
  if (signal.reason instanceof Error) {
    return new CryptoModelReplayError("cancelled", signal.reason.message);
  }
  return new CryptoModelReplayError("cancelled", "Crypto model replay was cancelled.");
}

async function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortReason(signal);
  let onAbort: (() => void) | undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, cancelled]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function exactDuplicate(left: BinanceKline, right: BinanceKline): boolean {
  return left.symbol === right.symbol
    && left.interval === right.interval
    && left.openTime === right.openTime
    && left.closeTime === right.closeTime
    && left.open === right.open
    && left.high === right.high
    && left.low === right.low
    && left.close === right.close
    && left.volume === right.volume
    && left.quoteVolume === right.quoteVolume
    && left.tradeCount === right.tradeCount
    && left.takerBuyVolume === right.takerBuyVolume
    && left.takerBuyQuoteVolume === right.takerBuyQuoteVolume
    && left.final === right.final;
}

async function loadCompleteBars(
  rest: Pick<BinanceRestMarketData, "klines">,
  symbol: string,
  window: ReplayWindow,
  contextBars: number,
  authoritativeNow: number,
  evaluationBarCount: number,
  signal: AbortSignal,
): Promise<BinanceKline[]> {
  const byOpenTime = new Map<number, BinanceKline>();
  let cursor = window.dataStart;
  let pageCount = 0;
  const expectedInputBarCount = (
    evaluationBarCount
    + contextBars - 1
    + FUTURE_BAR_COUNT
  );
  const maximumPages = Math.ceil(expectedInputBarCount / BINANCE_PAGE_LIMIT) + 2;

  while (cursor < window.dataEndExclusive) {
    if (signal.aborted) throw abortReason(signal);
    if (pageCount >= maximumPages) {
      throw new CryptoModelReplayError(
        "pagination_stalled",
        "Binance replay pagination exceeded its fail-closed page bound.",
      );
    }
    const payload = await raceWithAbort(rest.klines({
      symbol,
      startTime: cursor,
      endTime: window.dataEndExclusive - 1,
      limit: BINANCE_PAGE_LIMIT,
    }), signal);
    const page = normalizeRestKlines(symbol, payload, authoritativeNow)
      .filter((bar) => (
        bar.openTime >= window.dataStart && bar.openTime < window.dataEndExclusive
      ));
    if (!page.length) {
      throw new CryptoModelReplayError(
        "pagination_stalled",
        `Binance returned no usable 1m bars at ${new Date(cursor).toISOString()}.`,
      );
    }

    let maximumOpenTime = Number.NEGATIVE_INFINITY;
    for (const bar of page) {
      maximumOpenTime = Math.max(maximumOpenTime, bar.openTime);
      const previous = byOpenTime.get(bar.openTime);
      if (previous && !exactDuplicate(previous, bar)) {
        throw new CryptoModelReplayError(
          "data_gap",
          `Conflicting duplicate Binance bar at ${new Date(bar.openTime).toISOString()}.`,
        );
      }
      byOpenTime.set(bar.openTime, previous ?? bar);
    }
    const nextCursor = maximumOpenTime + MINUTE_MS;
    if (!Number.isFinite(maximumOpenTime) || nextCursor <= cursor) {
      throw new CryptoModelReplayError(
        "pagination_stalled",
        "Binance replay pagination did not advance.",
      );
    }
    cursor = nextCursor;
    pageCount += 1;
  }

  const bars = [...byOpenTime.values()].sort((left, right) => left.openTime - right.openTime);
  if (bars.some((bar) => !bar.final)) {
    throw new CryptoModelReplayError(
      "non_final_bar",
      "Binance replay included a bar that was not final at the authoritative clock.",
    );
  }
  if (bars.length !== expectedInputBarCount) {
    throw new CryptoModelReplayError(
      "data_gap",
      `Expected ${expectedInputBarCount} causal input bars but received ${bars.length}.`,
    );
  }
  for (let index = 0; index < bars.length; index += 1) {
    const bar = bars[index]!;
    const expectedOpenTime = window.dataStart + index * MINUTE_MS;
    if (bar.symbol !== symbol
      || bar.interval !== "1m"
      || bar.openTime !== expectedOpenTime
      || bar.closeTime !== expectedOpenTime + MINUTE_MS - 1) {
      throw new CryptoModelReplayError(
        "data_gap",
        `Binance 1m bar continuity failed at ${new Date(expectedOpenTime).toISOString()}.`,
      );
    }
  }
  return bars;
}

function alignedFirstOriginIndex(
  bars: readonly BinanceKline[],
  contextBars: number,
  window: ReplayWindow,
): number {
  for (let index = contextBars - 1; index + FUTURE_BAR_COUNT < bars.length; index += 1) {
    const bar = bars[index]!;
    if (bar.openTime < window.evaluationStart) continue;
    if (bar.openTime >= window.endExclusive) break;
    if ((bar.closeTime + 1) % (ORIGIN_STRIDE_BARS * MINUTE_MS) === 0) return index;
  }
  throw new CryptoModelReplayError(
    "invalid_input",
    "The selected replay window does not contain a valid walk-forward origin.",
  );
}

function buildRequest(
  symbol: string,
  bars: readonly BinanceKline[],
  costs: CryptoReplayCostAssumptions,
  contextBars: number,
  requestId: string,
  window: ReplayWindow,
): AiEvaluateRequest {
  const aiBars: AiEvaluateRequest["series"][number]["bars"] = bars.map((bar) => ({
    timestamp: new Date(bar.closeTime).toISOString(),
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
    amount: bar.quoteVolume,
    trade_count: bar.tradeCount,
    taker_buy_volume: bar.takerBuyVolume,
    taker_buy_amount: bar.takerBuyQuoteVolume,
    complete: true,
  }));
  const firstOriginIndex = alignedFirstOriginIndex(bars, contextBars, window);
  const origins: AiEvaluateRequest["series"][number]["origins"] = [];
  for (
    let index = firstOriginIndex;
    index + FUTURE_BAR_COUNT < bars.length
      && bars[index]!.openTime < window.endExclusive;
    index += ORIGIN_STRIDE_BARS
  ) {
    origins.push({
      origin: aiBars[index]!.timestamp,
      future_timestamps: aiBars
        .slice(index + 1, index + FUTURE_BAR_COUNT + 1)
        .map((bar) => bar.timestamp) as AiEvaluateRequest["series"][number]["origins"][number]["future_timestamps"],
      technical_signal: null,
      regime: null,
      target_stop: null,
    });
  }
  return AiEvaluateRequestSchema.parse({
    schema_version: SCALPING_AI_SCHEMA_VERSION,
    request_id: requestId,
    mode: "evaluate",
    horizons_minutes: [...SCALPING_AI_HORIZONS],
    quantiles: [...SCALPING_AI_QUANTILES],
    seed: 0,
    series: [{
      instrument_key: symbol,
      timezone: "UTC",
      bars: aiBars,
      origins,
    }],
    cost_assumptions: costs,
  });
}

function expectedRecords(request: AiEvaluateRequest): Map<string, ExpectedRecord> {
  const source = request.series[0]!;
  const barIndex = new Map(source.bars.map((bar, index) => [bar.timestamp, index]));
  const records = new Map<string, ExpectedRecord>();
  for (const origin of source.origins) {
    const index = barIndex.get(origin.origin);
    if (index === undefined) {
      throw new CryptoModelReplayError("data_gap", "A replay origin is absent from its bar context.");
    }
    const originMs = exactEpochMillisecond(origin.origin);
    if (originMs === undefined) {
      throw new CryptoModelReplayError("data_gap", "A replay origin is not an exact millisecond instant.");
    }
    for (const horizon of SCALPING_AI_HORIZONS) {
      const target = source.bars[index + horizon]!;
      const next = source.bars[index + 1]!;
      const originBar = source.bars[index]!;
      const targetTimestampMs = exactEpochMillisecond(target.timestamp);
      if (targetTimestampMs === undefined) {
        throw new CryptoModelReplayError(
          "data_gap",
          "A replay target is not an exact millisecond instant.",
        );
      }
      const key = `${originMs}\u0000${horizon}`;
      records.set(key, {
        key,
        instrumentKey: source.instrument_key,
        originMs,
        horizonMinutes: horizon,
        targetTimestampMs,
        actualReturn: target.close / originBar.close - 1,
        executionReturn: target.close / next.open - 1,
      });
    }
  }
  return records;
}

export async function loadCryptoReplayRawContexts(input: {
  rest: Pick<BinanceRestMarketData, "klines">;
  symbol: string;
  durationHours: number;
  endExclusive: number;
  authoritativeNow?: number;
  contextBars?: number;
  signal?: AbortSignal;
}): Promise<CryptoReplayRawContextResult> {
  const symbol = normalizedSymbol(input.symbol);
  const durationHours = finiteInteger(
    input.durationHours,
    1,
    MAXIMUM_REPLAY_DURATION_HOURS,
    "Replay durationHours",
  );
  const contextBars = finiteInteger(
    input.contextBars ?? DEFAULT_CONTEXT_BARS,
    1,
    MAXIMUM_RAW_CONTEXT_BARS,
    "Replay contextBars",
  );
  const authoritativeNow = input.authoritativeNow ?? Date.now();
  const window = replayWindow(
    authoritativeNow,
    contextBars,
    durationHours,
    input.endExclusive,
  );
  const localController = input.signal ? undefined : new AbortController();
  const signal = input.signal ?? localController!.signal;
  const bars = await loadCompleteBars(
    input.rest,
    symbol,
    window,
    contextBars,
    authoritativeNow,
    durationHours * 60,
    signal,
  );
  const firstOriginIndex = alignedFirstOriginIndex(bars, contextBars, window);
  const rows: CryptoReplayRawContextRow[] = [];
  for (
    let index = firstOriginIndex;
    index + FUTURE_BAR_COUNT < bars.length
      && bars[index]!.openTime < window.endExclusive;
    index += ORIGIN_STRIDE_BARS
  ) {
    const origin = bars[index]!;
    const context = bars.slice(index - contextBars + 1, index + 1);
    if (context.length !== contextBars) {
      throw new CryptoModelReplayError(
        "data_gap",
        "A raw replay origin did not retain its complete causal context.",
      );
    }
    rows.push({
      instrumentKey: `BINANCE_USDM:${symbol}`,
      origin: new Date(origin.closeTime).toISOString(),
      futureTimestamps: bars
        .slice(index + 1, index + FUTURE_BAR_COUNT + 1)
        .map((bar) => new Date(bar.closeTime).toISOString()),
      closes: context.map((bar) => bar.close),
      metadata: {
        symbol,
        originOrdinal: rows.length,
        windowStartAt: new Date(window.evaluationStart).toISOString(),
        windowEndExclusiveAt: new Date(window.endExclusive).toISOString(),
      },
    });
  }
  return {
    symbol,
    durationHours,
    startAt: new Date(window.evaluationStart).toISOString(),
    endExclusiveAt: new Date(window.endExclusive).toISOString(),
    contextBars,
    inputBarCount: bars.length,
    marketBars: bars,
    rows,
  };
}

function roundTripCostRate(costs: CryptoReplayCostAssumptions): number {
  return (
    costs.commission_bps_per_side * 2
    + costs.tax_bps_on_exit
    + costs.spread_bps_round_trip
    + costs.slippage_bps_per_side * 2
  ) / 10_000;
}

function validateAndMeasure(
  role: CryptoReplayLane,
  raw: unknown,
  request: AiEvaluateRequest,
  expected: ReadonlyMap<string, ExpectedRecord>,
  contextBars: number,
): ValidatedLane {
  const response = AiResponseSchema.parse(raw);
  if (response.request_id !== request.request_id || response.mode !== "evaluate") {
    throw new LaneReplayValidationError(
      "REQUEST_IDENTITY_MISMATCH",
      "The model response does not identify the exact replay request.",
      response.model.model_id,
    );
  }
  if (response.model.model_id !== expectedModelId[role]) {
    throw new LaneReplayValidationError(
      "MODEL_IDENTITY_MISMATCH",
      `The ${role} lane returned an unexpected model identity.`,
      response.model.model_id,
    );
  }
  const provenance = validatePinnedProvenance(role, response.model);
  if (response.error || !response.evaluation) {
    throw new LaneReplayValidationError(
      "EVALUATION_UNAVAILABLE",
      response.error?.message ?? `The ${role} lane returned no evaluation records.`,
      response.model.model_id,
    );
  }
  if (JSON.stringify(response.evaluation.cost_assumptions)
    !== JSON.stringify(request.cost_assumptions)) {
    throw new LaneReplayValidationError(
      "COST_ASSUMPTIONS_MISMATCH",
      `The ${role} lane changed the replay cost assumptions.`,
      response.model.model_id,
    );
  }
  if (response.evaluation.records.length !== expected.size) {
    throw new LaneReplayValidationError(
      "RECORD_COUNT_MISMATCH",
      `The ${role} lane returned a different replay record count.`,
      response.model.model_id,
    );
  }
  const origins = request.series[0]!.origins;
  if (response.series.length !== origins.length) {
    throw new LaneReplayValidationError(
      "CONTEXT_EVIDENCE_MISMATCH",
      `The ${role} lane returned a different effective-context evidence count.`,
      response.model.model_id,
    );
  }
  const contextEvidence = response.series.map((series, index) => {
    const observedOriginMs = exactEpochMillisecond(series.input_end_at);
    const expectedOriginMs = exactEpochMillisecond(origins[index]!.origin);
    if (observedOriginMs === undefined
      || observedOriginMs !== expectedOriginMs
      || series.input_quality.bar_count !== contextBars) {
      throw new LaneReplayValidationError(
        "CONTEXT_EVIDENCE_MISMATCH",
        `The ${role} lane did not use the fixed effective context at every origin.`,
        response.model.model_id,
      );
    }
    return { originMs: expectedOriginMs, barCount: series.input_quality.bar_count };
  });

  const realizedRecords: Array<{
    key: string;
    instrumentKey: string;
    targetTimestamp: string;
    actualReturn: number;
    executionReturn: number;
    roundTripCostRate: number;
  }> = [];
  const predictionRecords: Array<{
    key: string;
    status: "available" | "unavailable";
    predictedMedianReturn: number | null;
    predictedQuantiles: Array<{ quantile: number; value: number }>;
    upProbability: number | null;
    predictedFirstPassage: "target" | "stop" | "ambiguous" | null;
    unavailableCode: string | null;
  }> = [];
  const observedKeys = new Set<string>();
  const costRate = roundTripCostRate(request.cost_assumptions);
  for (const record of response.evaluation.records) {
    const originMs = exactEpochMillisecond(record.origin);
    const targetTimestampMs = exactEpochMillisecond(record.target_timestamp);
    if (originMs === undefined || targetTimestampMs === undefined) {
      throw new LaneReplayValidationError(
        "RECORD_TIMESTAMP_INVALID",
        `The ${role} lane returned a replay timestamp below the millisecond comparison boundary.`,
        response.model.model_id,
      );
    }
    const key = `${originMs}\u0000${record.horizon_minutes}`;
    if (observedKeys.has(key)) {
      throw new LaneReplayValidationError(
        "DUPLICATE_RECORD",
        `The ${role} lane returned a duplicate replay record.`,
        response.model.model_id,
      );
    }
    observedKeys.add(key);
    const reference = expected.get(key);
    if (!reference
      || record.instrument_key !== reference.instrumentKey
      || targetTimestampMs !== reference.targetTimestampMs
      || record.actual_return === null
      || record.execution_return === null
      || !sameNumber(record.actual_return, reference.actualReturn)
      || !sameNumber(record.execution_return, reference.executionReturn)
      || !sameNumber(record.round_trip_cost_rate, costRate)) {
      throw new LaneReplayValidationError(
        "RECORD_BARRIER_MISMATCH",
        `The ${role} lane changed an origin, realized return, cost, or next-bar fill.`,
        response.model.model_id,
      );
    }
    if (record.status === "available") {
      const predicted = record.predicted_quantiles;
      for (let index = 1; index < predicted.length; index += 1) {
        if (predicted[index]!.value < predicted[index - 1]!.value) {
          throw new LaneReplayValidationError(
            "NON_MONOTONE_QUANTILES",
            `The ${role} lane returned non-monotone quantiles.`,
            response.model.model_id,
          );
        }
      }
      const median = predicted.find((item) => item.quantile === 0.5)?.value;
      if (median === undefined
        || record.predicted_median_return === null
        || !sameNumber(median, record.predicted_median_return)) {
        throw new LaneReplayValidationError(
          "MEDIAN_QUANTILE_MISMATCH",
          `The ${role} lane returned a median inconsistent with q50.`,
          response.model.model_id,
        );
      }
    }
    realizedRecords.push({
      key: reference.key,
      instrumentKey: reference.instrumentKey,
      targetTimestamp: new Date(reference.targetTimestampMs).toISOString(),
      actualReturn: reference.actualReturn,
      executionReturn: reference.executionReturn,
      roundTripCostRate: costRate,
    });
    predictionRecords.push({
      key: reference.key,
      status: record.status,
      predictedMedianReturn: record.predicted_median_return,
      predictedQuantiles: record.predicted_quantiles.map((item) => ({
        quantile: item.quantile,
        value: item.value,
      })),
      upProbability: record.up_probability,
      predictedFirstPassage: record.predicted_first_passage,
      unavailableCode: record.unavailable?.code ?? null,
    });
  }
  realizedRecords.sort((left, right) => left.key.localeCompare(right.key));
  predictionRecords.sort((left, right) => left.key.localeCompare(right.key));

  const metrics = SCALPING_AI_HORIZONS.map((horizonMinutes): CryptoReplayHorizonMetrics => {
    const records = response.evaluation!.records.filter((record) => (
      record.horizon_minutes === horizonMinutes
      && record.status === "available"
      && record.actual_return !== null
      && record.predicted_median_return !== null
    ));
    if (!records.length) {
      return {
        horizonMinutes,
        count: 0,
        meanPinballLoss: null,
        medianReturnMae: null,
        directionAccuracy: null,
        quantiles: [],
      };
    }
    const quantiles = SCALPING_AI_QUANTILES.map((quantile): CryptoReplayQuantileMetric => {
      let loss = 0;
      let covered = 0;
      for (const record of records) {
        const predicted = record.predicted_quantiles.find((item) => item.quantile === quantile);
        if (!predicted || record.actual_return === null) {
          throw new LaneReplayValidationError(
            "QUANTILE_MISSING",
            `The ${role} lane omitted a fixed replay quantile.`,
            response.model.model_id,
          );
        }
        const error = record.actual_return - predicted.value;
        loss += Math.max(quantile * error, (quantile - 1) * error);
        covered += Number(record.actual_return <= predicted.value);
      }
      const observedCoverage = covered / records.length;
      return {
        quantile,
        pinballLoss: loss / records.length,
        observedCoverage,
        calibrationError: observedCoverage - quantile,
      };
    });
    const medianReturnMae = records.reduce((sum, record) => (
      sum + Math.abs(record.actual_return! - record.predicted_median_return!)
    ), 0) / records.length;
    const directionAccuracy = records.reduce((sum, record) => (
      sum + Number(direction(record.actual_return!) === direction(record.predicted_median_return!))
    ), 0) / records.length;
    return {
      horizonMinutes,
      count: records.length,
      meanPinballLoss: quantiles.reduce((sum, item) => sum + item.pinballLoss, 0) / quantiles.length,
      medianReturnMae,
      directionAccuracy,
      quantiles,
    };
  });
  return {
    response,
    recordDigest: digest(realizedRecords),
    predictionDigest: digest(predictionRecords),
    effectiveContextDigest: digest(contextEvidence),
    provenance,
    metrics,
  };
}

function unavailableLane(
  lane: CryptoReplayLane,
  inputDigest: string,
  latencyMs: number,
  error: unknown,
): CryptoReplayLaneResult {
  const safeError = safeLaneError(error);
  return {
    lane,
    expectedModelId: expectedModelId[lane],
    ...(error instanceof LaneReplayValidationError && error.observedModelId
      ? { observedModelId: error.observedModelId }
      : {}),
    availability: "unavailable",
    identityVerified: false,
    inputDigest,
    latencyMs,
    fallbackUsed: false,
    metrics: [],
    error: safeError,
  };
}

export class CryptoModelComparisonReplay {
  private readonly clock: CryptoReplayClock;
  private readonly contextBars: number;
  private readonly deadlineMs: number;
  private readonly requestId: () => string;

  constructor(private readonly options: CryptoModelReplayOptions) {
    this.clock = options.clock ?? { now: Date.now };
    this.contextBars = finiteInteger(
      options.contextBars ?? DEFAULT_CONTEXT_BARS,
      1,
      DEFAULT_CONTEXT_BARS,
      "Replay contextBars",
    );
    this.deadlineMs = finiteInteger(
      options.deadlineMs ?? DEFAULT_DEADLINE_MS,
      1,
      MAXIMUM_DEADLINE_MS,
      "Replay deadlineMs",
    );
    this.requestId = options.requestId ?? (() => `crypto-replay:${randomUUID()}`);
  }

  async run(input: CryptoModelReplayInput): Promise<CryptoModelReplayResult> {
    const symbol = normalizedSymbol(input.symbol);
    const costs = AiCostAssumptionsSchema.parse(input.costAssumptions);
    const deadlineMs = finiteInteger(
      input.deadlineMs ?? this.deadlineMs,
      1,
      MAXIMUM_DEADLINE_MS,
      "Replay deadlineMs",
    );
    const durationHours = finiteInteger(
      input.durationHours ?? DEFAULT_REPLAY_DURATION_HOURS,
      1,
      MAXIMUM_REPLAY_DURATION_HOURS,
      "Replay durationHours",
    );
    const evaluationBarCount = durationHours * 60;
    const authoritativeNow = this.clock.now();
    const window = replayWindow(
      authoritativeNow,
      this.contextBars,
      durationHours,
      input.endExclusive,
    );
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(new CryptoModelReplayError(
      "deadline_exceeded",
      `Crypto model replay exceeded its ${deadlineMs}ms overall deadline.`,
    )), deadlineMs);
    deadline.unref?.();
    const forwardAbort = () => controller.abort(
      input.signal?.reason instanceof Error
        ? new CryptoModelReplayError("cancelled", input.signal.reason.message)
        : new CryptoModelReplayError("cancelled", "Crypto model replay was cancelled."),
    );
    input.signal?.addEventListener("abort", forwardAbort, { once: true });
    if (input.signal?.aborted) forwardAbort();

    try {
      const bars = await loadCompleteBars(
        this.options.rest,
        symbol,
        window,
        this.contextBars,
        authoritativeNow,
        evaluationBarCount,
        controller.signal,
      );
      const request = freezeDeep(buildRequest(
        symbol,
        bars,
        costs,
        this.contextBars,
        this.requestId(),
        window,
      ));
      const inputDigest = semanticRequestDigest(request);
      const expected = expectedRecords(request);
      const invocations = {} as Record<CryptoReplayLane, LaneInvocation>;

      for (const lane of ["chronos2", "fincast"] as const) {
        if (controller.signal.aborted) throw abortReason(controller.signal);
        const startedAt = this.clock.now();
        try {
          const raw = await raceWithAbort(
            this.options.lanes[lane].request(request, controller.signal),
            controller.signal,
          );
          const validated = validateAndMeasure(
            lane,
            raw,
            request,
            expected,
            this.contextBars,
          );
          const latencyMs = Math.max(0, this.clock.now() - startedAt);
          invocations[lane] = {
            validated,
            result: {
              lane,
              expectedModelId: expectedModelId[lane],
              observedModelId: validated.response.model.model_id,
              availability: validated.response.status,
              identityVerified: true,
              inputDigest,
              recordDigest: validated.recordDigest,
              predictionDigest: validated.predictionDigest,
              effectiveContextDigest: validated.effectiveContextDigest,
              effectiveContextBars: this.contextBars,
              provenance: validated.provenance,
              latencyMs,
              fallbackUsed: false,
              metrics: validated.metrics,
            },
          };
        } catch (error) {
          if (controller.signal.aborted) throw abortReason(controller.signal);
          invocations[lane] = {
            result: unavailableLane(
              lane,
              inputDigest,
              Math.max(0, this.clock.now() - startedAt),
              error,
            ),
          };
        }
      }

      const chronos2 = invocations.chronos2;
      const fincast = invocations.fincast;
      const bothValidated = Boolean(chronos2.validated && fincast.validated);
      const identitiesVerified = bothValidated
        && chronos2.result.identityVerified
        && fincast.result.identityVerified;
      const sameInputDigest = bothValidated
        && chronos2.result.inputDigest === fincast.result.inputDigest
        && chronos2.result.inputDigest === inputDigest;
      const sameRecords = bothValidated
        && chronos2.result.recordDigest === fincast.result.recordDigest;
      const sameEffectiveContext = bothValidated
        && chronos2.result.effectiveContextBars === this.contextBars
        && fincast.result.effectiveContextBars === this.contextBars
        && chronos2.result.effectiveContextDigest === fincast.result.effectiveContextDigest;
      const sameCosts = bothValidated
        && JSON.stringify(chronos2.validated!.response.evaluation!.cost_assumptions)
          === JSON.stringify(fincast.validated!.response.evaluation!.cost_assumptions)
        && JSON.stringify(chronos2.validated!.response.evaluation!.cost_assumptions)
          === JSON.stringify(request.cost_assumptions);
      const sameOrigin = sameRecords;
      const sameContext = sameInputDigest && sameEffectiveContext;
      const sameFillBarrier = sameRecords;
      const fullyAvailable = chronos2.result.availability === "available"
        && fincast.result.availability === "available";
      const comparable = identitiesVerified
        && sameInputDigest
        && sameRecords
        && sameOrigin
        && sameContext
        && sameCosts
        && sameFillBarrier
        && fullyAvailable;

      return {
        schemaVersion: "crypto-model-comparison-replay/v1",
        generatedAt: new Date(this.clock.now()).toISOString(),
        market: {
          kind: "crypto_futures",
          venue: "BINANCE_USDM",
          quoteAsset: "USDT",
          contractType: "PERPETUAL",
        },
        symbol,
        window: {
          startAt: new Date(window.evaluationStart).toISOString(),
          endExclusiveAt: new Date(window.endExclusive).toISOString(),
          durationHours,
          completeUtcDays: durationHours % 24 === 0 ? durationHours / 24 : null,
          barCount: evaluationBarCount,
          contextPrefetchBarCount: this.contextBars - 1,
          outcomeTailBarCount: 60,
          inputBarCount: bars.length,
          originCount: request.series[0]!.origins.length,
          originStrideMinutes: 15,
          futureBarsPerOrigin: 60,
        },
        requestId: request.request_id,
        inputDigest,
        costAssumptions: request.cost_assumptions,
        lanes: {
          chronos2: chronos2.result,
          fincast: fincast.result,
        },
        comparison: {
          identitiesVerified,
          sameInputDigest,
          sameRecords,
          sameOrigin,
          sameContext,
          sameCosts,
          sameFillBarrier,
          automaticWinner: null,
          outcome: comparable ? "review_required" : "inconclusive",
        },
      };
    } finally {
      clearTimeout(deadline);
      input.signal?.removeEventListener("abort", forwardAbort);
    }
  }
}
