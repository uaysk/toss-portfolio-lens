#!/usr/bin/env node

import { readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPORT_SCHEMA_VERSION = "crypto-model-comparison-report/v1";
const REPLAY_SCHEMA_VERSION = "crypto-model-comparison-replay/v1";
const SAFE_SHADOW_SCHEMA_VERSION = "crypto-comparison-shadow/v1";
const SIMULATION_SCHEMA_VERSION = "ai-paper-simulation/v7";
const MAX_INPUT_BYTES = 64 * 1024 * 1024;
const LANES = Object.freeze(["kronos_base", "fincast"]);
const LANE_LABELS = Object.freeze({
  kronos_base: "Kronos-base",
  fincast: "FinCast",
});
const HORIZONS = Object.freeze([5, 15, 30, 60]);
const REPLAY_WINDOW = Object.freeze({
  completeUtcDays: 7,
  barCount: 10_080,
  contextPrefetchBarCount: 511,
  outcomeTailBarCount: 60,
  inputBarCount: 10_651,
  originCount: 672,
  originStrideMinutes: 15,
  futureBarsPerOrigin: 60,
});
const MARKET = Object.freeze({
  kind: "crypto_futures",
  venue: "BINANCE_USDM",
  quoteAsset: "USDT",
  contractType: "PERPETUAL",
});
const OUTCOMES = new Set(["inconclusive", "review_required"]);
const PRECISION_FAILURE_REASONS = Object.freeze([
  "non_finite_output",
  "quantile_crossing",
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
]);
const PINNED_MODEL_PROVENANCE = Object.freeze({
  kronos_base: Object.freeze({
    modelId: "NeoQuasar/Kronos-base",
    modelRevision: "2b554741eca47781b64468546e77fef3e85130e6",
    sourceRevision: "67b630e67f6a18c9e9be918d9b4337c960db1e9a",
    loaderVersion: "kronos-source-67b630e",
    license: "MIT",
    tokenizerId: "NeoQuasar/Kronos-Tokenizer-base",
    tokenizerRevision: "0e0117387f39004a9016484a186a908917e22426",
  }),
  fincast: Object.freeze({
    modelId: "Vincent05R/FinCast",
    modelRevision: "2d7d90b159db8961d27c2cf165d51195902ef92b",
    sourceRevision: "488b19d1d85fa2b3d4b93469530cefdcf1cc97a4",
    loaderVersion: "fincast-source-488b19d",
    license: "Apache-2.0",
    tokenizerId: null,
    tokenizerRevision: null,
  }),
});
const PINNED_DEVICE = Object.freeze({
  device: "cuda",
  deviceName: "Tesla P40",
  cudaCapability: "6.1",
  attentionBackend: "math",
});
const SENSITIVE_VALUE_PATTERN =
  /(?:api[\s_.-]*key|secret|credential|signature|bearer|password|private[\s_.-]*key|access[\s_.-]*key|auth[\s_.-]*token|account[\s_.-]*balance)/i;

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function values(value) {
  return Array.isArray(value) ? value : Object.values(object(value));
}

function own(source, key) {
  return Object.prototype.hasOwnProperty.call(source, key);
}

function first(records, ...keys) {
  for (const source of records) {
    for (const key of keys) {
      if (source[key] !== undefined && source[key] !== null) return source[key];
    }
  }
  return undefined;
}

function present(records, ...keys) {
  for (const source of records) {
    for (const key of keys) {
      if (own(source, key) && source[key] !== undefined) {
        return { present: true, value: source[key] };
      }
    }
  }
  return { present: false, value: undefined };
}

function firstRecord(...candidates) {
  for (const candidate of candidates) {
    const record = object(candidate);
    if (Object.keys(record).length) return record;
  }
  return {};
}

function firstArray(...candidates) {
  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.length) return candidate;
  }
  return [];
}

function required(condition, message) {
  if (!condition) throw new Error(message);
}

function number(value, options = {}) {
  const candidate = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim()
      ? Number(value)
      : Number.NaN;
  if (!Number.isFinite(candidate)) return undefined;
  if (options.integer && !Number.isSafeInteger(candidate)) return undefined;
  if (options.min !== undefined && candidate < options.min) return undefined;
  if (options.max !== undefined && candidate > options.max) return undefined;
  return Object.is(candidate, -0) ? 0 : candidate;
}

function boolean(value) {
  return typeof value === "boolean" ? value : undefined;
}

function isoTimestamp(value) {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const timestamp = Date.parse(String(value));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function safeToken(value, maximumLength = 160) {
  if (typeof value !== "string") return undefined;
  const candidate = value.trim();
  if (!candidate || candidate.length > maximumLength) return undefined;
  if (SENSITIVE_VALUE_PATTERN.test(candidate)) return undefined;
  return /^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/.test(candidate) ? candidate : undefined;
}

function safeDigest(value) {
  const candidate = safeToken(value, 80);
  return candidate && /^(?:sha256:)?[a-f0-9]{64}$/i.test(candidate)
    ? candidate.toLowerCase()
    : undefined;
}

function safeSymbol(value) {
  if (typeof value !== "string") return undefined;
  const candidate = value.trim().toUpperCase();
  return /^[A-Z0-9]{2,32}$/.test(candidate) && candidate.endsWith("USDT")
    ? candidate
    : undefined;
}

function laneId(value) {
  if (typeof value !== "string") return undefined;
  const candidate = value.trim().toLowerCase().replaceAll("-", "_");
  if (candidate === "kronos" || candidate === "kronosbase") return "kronos_base";
  return LANES.includes(candidate) ? candidate : undefined;
}

function precision(value) {
  if (typeof value !== "string") return "unknown";
  const candidate = value.trim().toLowerCase();
  if (["fp16", "float16", "half", "mixed_float16"].includes(candidate)) return "fp16";
  if (["fp32", "float32"].includes(candidate)) return "fp32";
  return "unknown";
}

function strictPrecision(value) {
  const normalized = precision(value);
  return normalized === "unknown" ? undefined : normalized;
}

function exactProvenanceValue(source, expected, label, ...keys) {
  const candidate = present([source], ...keys);
  required(candidate.present, `${label} is missing.`);
  if (expected === null) {
    required(candidate.value === null, `${label} does not match the pinned provenance.`);
    return null;
  }
  const normalized = safeToken(candidate.value, 160);
  required(
    normalized === expected && candidate.value === expected,
    `${label} does not match the pinned provenance.`,
  );
  return expected;
}

function normalizePrecisionFailureReasons(value, label) {
  required(Array.isArray(value), `${label} precision failure reasons are missing.`);
  required(
    value.length <= PRECISION_FAILURE_REASONS.length,
    `${label} precision failure reasons are invalid.`,
  );
  const normalized = [];
  for (const reason of value) {
    required(
      typeof reason === "string"
        && PRECISION_FAILURE_REASONS.includes(reason)
        && !normalized.includes(reason),
      `${label} precision failure reasons are invalid.`,
    );
    normalized.push(reason);
  }
  return normalized;
}

function normalizeModelProvenance(value, id, label, options = {}) {
  const source = object(value);
  if (!Object.keys(source).length) {
    required(options.allowMissing === true, `${label} model provenance is missing.`);
    return undefined;
  }
  const pinned = PINNED_MODEL_PROVENANCE[id];
  const modelId = exactProvenanceValue(
    source,
    pinned.modelId,
    `${label} model ID`,
    "modelId",
    "model_id",
  );
  const modelRevision = exactProvenanceValue(
    source,
    pinned.modelRevision,
    `${label} model revision`,
    "modelRevision",
    "model_revision",
    "revision",
  );
  const sourceRevision = exactProvenanceValue(
    source,
    pinned.sourceRevision,
    `${label} source revision`,
    "sourceRevision",
    "source_revision",
  );
  const loaderVersion = exactProvenanceValue(
    source,
    pinned.loaderVersion,
    `${label} loader version`,
    "loaderVersion",
    "loader_version",
  );
  const license = exactProvenanceValue(source, pinned.license, `${label} license`, "license");
  const tokenizerId = exactProvenanceValue(
    source,
    pinned.tokenizerId,
    `${label} tokenizer ID`,
    "tokenizerId",
    "tokenizer_id",
  );
  const tokenizerRevision = exactProvenanceValue(
    source,
    pinned.tokenizerRevision,
    `${label} tokenizer revision`,
    "tokenizerRevision",
    "tokenizer_revision",
  );

  required(source.loaded === true, `${label} must report a loaded model.`);
  const device = exactProvenanceValue(
    source,
    PINNED_DEVICE.device,
    `${label} device`,
    "device",
  );
  const rawDeviceName = present([source], "deviceName", "device_name");
  required(
    rawDeviceName.present && rawDeviceName.value === PINNED_DEVICE.deviceName,
    `${label} device name does not match the pinned runtime.`,
  );
  const cudaCapability = exactProvenanceValue(
    source,
    PINNED_DEVICE.cudaCapability,
    `${label} CUDA capability`,
    "cudaCapability",
    "cuda_capability",
  );
  const attentionBackend = exactProvenanceValue(
    source,
    PINNED_DEVICE.attentionBackend,
    `${label} attention backend`,
    "attentionBackend",
    "attention_backend",
  );
  const precisionValue = present([source], "precision", "dtype");
  const normalizedPrecision = strictPrecision(precisionValue.value);
  required(
    precisionValue.present && normalizedPrecision,
    `${label} precision is invalid.`,
  );
  const precisionValidationValue = present(
    [source],
    "precisionValidation",
    "precision_validation",
  );
  required(
    precisionValidationValue.present
      && ["not_required", "passed", "fallback_fp32"].includes(
        precisionValidationValue.value,
      ),
    `${label} precision validation is invalid.`,
  );
  const memoryStatus = exactProvenanceValue(
    source,
    "ok",
    `${label} memory status`,
    "memoryStatus",
    "memory_status",
  );
  const expectedTailPolicy = id === "kronos_base" ? "native" : "tail_clamped_q10_q90";
  const quantileTailPolicy = exactProvenanceValue(
    source,
    expectedTailPolicy,
    `${label} quantile-tail policy`,
    "quantileTailPolicy",
    "quantile_tail_policy",
  );
  const reasonsValue = present(
    [source],
    "precisionFailureReasons",
    "precision_failure_reasons",
  );
  const precisionFailureReasons = normalizePrecisionFailureReasons(
    reasonsValue.value,
    label,
  );
  const precisionValidation = precisionValidationValue.value;
  const precisionFallbackUsed = precisionValidation === "fallback_fp32";
  const fallbackValue = present(
    [source],
    "precisionFallbackUsed",
    "precision_fallback_used",
  );
  if (fallbackValue.present) {
    required(
      fallbackValue.value === precisionFallbackUsed,
      `${label} precision fallback evidence is inconsistent.`,
    );
  }
  if (id === "kronos_base") {
    required(
      normalizedPrecision === "fp32"
        && precisionValidation === "not_required"
        && !precisionFallbackUsed
        && precisionFailureReasons.length === 0,
      `${label} must use native FP32.`,
    );
  } else {
    const validFp16 = normalizedPrecision === "fp16"
      && precisionValidation === "passed"
      && !precisionFallbackUsed
      && precisionFailureReasons.length === 0;
    const validFp32Fallback = normalizedPrecision === "fp32"
      && precisionValidation === "fallback_fp32"
      && precisionFallbackUsed
      && precisionFailureReasons.length > 0;
    required(validFp16 || validFp32Fallback, `${label} FinCast precision evidence is invalid.`);
  }

  const peakVramBytesValue = present([source], "peakVramBytes", "peak_vram_bytes");
  const peakVramMeasurementValue = present(
    [source],
    "peakVramMeasurement",
    "peak_vram_measurement",
  );
  const nullPeakVramPair = peakVramBytesValue.present
    && peakVramMeasurementValue.present
    && peakVramBytesValue.value === null
    && peakVramMeasurementValue.value === null;
  const peakVramBytes = peakVramBytesValue.present && !nullPeakVramPair
    ? number(peakVramBytesValue.value, { integer: true, min: 0 })
    : undefined;
  required(
    (!peakVramBytesValue.present || nullPeakVramPair || peakVramBytes !== undefined)
      && peakVramBytesValue.present === peakVramMeasurementValue.present
      && (nullPeakVramPair
        || !peakVramMeasurementValue.present
        || peakVramMeasurementValue.value === "cuda_allocated_or_reserved"),
    `${label} peak VRAM provenance is invalid.`,
  );
  if (id === "fincast") {
    required(
      peakVramBytes !== undefined && peakVramBytes > 0,
      `${label} FinCast peak VRAM provenance is missing.`,
    );
  }
  const peakVramMbValue = present([source], "peakVramMb", "peak_vram_mb");
  const peakVramMb = peakVramMbValue.present
    ? number(peakVramMbValue.value, { min: 0 })
    : peakVramBytes === undefined ? undefined : peakVramBytes / (1024 * 1024);
  required(
    !peakVramMbValue.present || peakVramMb !== undefined,
    `${label} peak VRAM value is invalid.`,
  );

  return {
    modelId,
    modelRevision,
    sourceRevision,
    loaderVersion,
    license,
    tokenizerId,
    tokenizerRevision,
    loaded: true,
    device,
    deviceName: PINNED_DEVICE.deviceName,
    cudaCapability,
    attentionBackend,
    precision: normalizedPrecision,
    precisionValidation,
    precisionFallbackUsed,
    peakVramBytes: nullPeakVramPair ? null : peakVramBytes,
    peakVramMeasurement: nullPeakVramPair
      ? null
      : peakVramMeasurementValue.present
      ? "cuda_allocated_or_reserved"
      : undefined,
    peakVramMb,
    memoryStatus,
    quantileTailPolicy,
    precisionFailureReasons,
  };
}

function safeStatus(value, fallback = "unavailable") {
  const candidate = safeToken(value, 64)?.toLowerCase();
  return candidate && [
    "available",
    "completed",
    "partial",
    "unavailable",
    "healthy",
    "degraded",
    "memory_pressure",
    "failed",
    "cancelled",
    "pending",
  ].includes(candidate)
    ? candidate
    : fallback;
}

function safeErrorCode(value) {
  const source = object(value);
  const raw = typeof value === "string" ? value : first([source], "code", "reason");
  if (typeof raw !== "string" || !raw.trim()) return source.message ? "lane_error" : undefined;
  if (SENSITIVE_VALUE_PATTERN.test(raw)) return "redacted_error";
  const normalized = raw.trim();
  return /^[A-Za-z][A-Za-z0-9_.-]{0,119}$/.test(normalized)
    ? normalized
    : "lane_error";
}

function errorCodes(...sources) {
  const output = [];
  for (const source of sources) {
    for (const item of values(source)) {
      const code = safeErrorCode(item);
      if (code && !output.includes(code)) output.push(code);
      if (output.length >= 12) return output;
    }
  }
  return output;
}

function normalizeMarket(value) {
  const market = object(value);
  return market.kind === MARKET.kind
    && market.venue === MARKET.venue
    && market.quoteAsset === MARKET.quoteAsset
    && market.contractType === MARKET.contractType
    ? { ...MARKET }
    : undefined;
}

function normalizeCostAssumptions(value) {
  const costs = object(value);
  const normalized = {
    commissionBpsPerSide: number(first([costs], "commission_bps_per_side", "commissionBpsPerSide"), {
      min: 0,
      max: 10_000,
    }),
    taxBpsOnExit: number(first([costs], "tax_bps_on_exit", "taxBpsOnExit"), {
      min: 0,
      max: 10_000,
    }),
    spreadBpsRoundTrip: number(first([costs], "spread_bps_round_trip", "spreadBpsRoundTrip"), {
      min: 0,
      max: 10_000,
    }),
    slippageBpsPerSide: number(first([costs], "slippage_bps_per_side", "slippageBpsPerSide"), {
      min: 0,
      max: 10_000,
    }),
  };
  required(
    Object.values(normalized).every((item) => item !== undefined),
    "Replay cost assumptions are incomplete.",
  );
  return normalized;
}

function normalizeQuantiles(value) {
  return values(value).flatMap((item) => {
    const source = object(item);
    const quantile = number(source.quantile, { min: 0, max: 1 });
    const pinballLoss = number(first([source], "pinballLoss", "pinball_loss"), { min: 0 });
    const observedCoverage = number(first([source], "observedCoverage", "observed_coverage"), {
      min: 0,
      max: 1,
    });
    const calibrationError = number(first([source], "calibrationError", "calibration_error"), {
      min: -1,
      max: 1,
    });
    if (
      quantile === undefined
      || pinballLoss === undefined
      || observedCoverage === undefined
      || calibrationError === undefined
    ) return [];
    return [{ quantile, pinballLoss, observedCoverage, calibrationError }];
  }).sort((left, right) => left.quantile - right.quantile);
}

function normalizeReplayMetrics(value) {
  const byHorizon = new Map();
  for (const item of values(value)) {
    const source = object(item);
    const horizonMinutes = number(first([source], "horizonMinutes", "horizon_minutes"), {
      integer: true,
      min: 1,
      max: 1_440,
    });
    if (!HORIZONS.includes(horizonMinutes) || byHorizon.has(horizonMinutes)) continue;
    const count = number(source.count, { integer: true, min: 0, max: 10_000_000 });
    if (count === undefined) continue;
    byHorizon.set(horizonMinutes, {
      horizonMinutes,
      count,
      meanPinballLoss: number(first([source], "meanPinballLoss", "mean_pinball_loss"), { min: 0 }),
      medianReturnMae: number(first([source], "medianReturnMae", "median_return_mae"), { min: 0 }),
      directionAccuracy: number(first([source], "directionAccuracy", "direction_accuracy"), {
        min: 0,
        max: 1,
      }),
      quantiles: normalizeQuantiles(source.quantiles),
    });
  }
  return HORIZONS.flatMap((horizon) => {
    const metric = byHorizon.get(horizon);
    return metric ? [metric] : [];
  });
}

function normalizeReplayLane(value, id, inputDigest) {
  const source = object(value);
  const availability = typeof source.availability === "string"
    ? source.availability.trim().toLowerCase()
    : undefined;
  required(
    ["available", "partial", "unavailable"].includes(availability),
    `Replay ${id} availability is invalid.`,
  );
  const laneInputDigest = safeDigest(first([source], "inputDigest", "input_digest"));
  required(laneInputDigest === inputDigest, `Replay ${id} input digest does not match.`);
  const fallbackUsed = boolean(first([source], "fallbackUsed", "fallback_used"));
  required(fallbackUsed === false, `Replay ${id} must not use fallback output.`);
  const pinned = PINNED_MODEL_PROVENANCE[id];
  const expectedModelId = safeToken(first(
    [source],
    "expectedModelId",
    "expected_model_id",
  ));
  required(
    expectedModelId === pinned.modelId,
    `Replay ${id} expected model ID does not match the pinned lane.`,
  );
  const observedModelSource = present([source], "observedModelId", "observed_model_id");
  const observedModelId = observedModelSource.present
    ? safeToken(observedModelSource.value)
    : undefined;
  if (observedModelSource.present) {
    required(
      observedModelId === pinned.modelId,
      `Replay ${id} observed model ID does not match the pinned lane.`,
    );
  }
  const identityVerified = boolean(first(
    [source],
    "identityVerified",
    "identity_verified",
  )) === true;
  const effectiveContextDigestSource = present(
    [source],
    "effectiveContextDigest",
    "effective_context_digest",
  );
  const effectiveContextBarsSource = present(
    [source],
    "effectiveContextBars",
    "effective_context_bars",
  );
  const effectiveContextDigest = effectiveContextDigestSource.present
    ? safeDigest(effectiveContextDigestSource.value)
    : undefined;
  const effectiveContextBars = effectiveContextBarsSource.present
    ? number(effectiveContextBarsSource.value, { integer: true, min: 1, max: 10_000 })
    : undefined;
  required(
    effectiveContextDigestSource.present === effectiveContextBarsSource.present,
    `Replay ${id} effective context evidence is incomplete.`,
  );
  if (effectiveContextBarsSource.present) {
    required(
      Boolean(effectiveContextDigest) && effectiveContextBars === 512,
      `Replay ${id} effective context must contain exactly 512 bars.`,
    );
  }
  const provenanceSource = firstRecord(source.provenance, source.model);
  const usable = availability !== "unavailable";
  const provenance = normalizeModelProvenance(
    provenanceSource,
    id,
    `Replay ${id}`,
    { allowMissing: !usable },
  );
  if (usable) {
    required(identityVerified, `Replay ${id} identity is not verified.`);
    required(
      observedModelId === pinned.modelId,
      `Replay ${id} observed model ID is missing.`,
    );
    required(
      effectiveContextBars === 512 && Boolean(effectiveContextDigest),
      `Replay ${id} effective context evidence is missing.`,
    );
  }
  const metrics = normalizeReplayMetrics(source.metrics);
  if (availability === "available") {
    required(metrics.length === HORIZONS.length, `Replay ${id} metrics are incomplete.`);
  }
  return {
    id,
    availability,
    identityVerified,
    expectedModelId,
    observedModelId,
    inputDigest: laneInputDigest,
    recordDigest: safeDigest(first([source], "recordDigest", "record_digest")),
    effectiveContextDigest,
    effectiveContextBars,
    provenance,
    latencyMs: number(first([source], "latencyMs", "latency_ms"), { min: 0 }),
    metrics,
    errors: errorCodes(source.error),
  };
}

function normalizeReplay(payload) {
  const root = object(payload);
  required(
    first([root], "schemaVersion", "schema_version") === REPLAY_SCHEMA_VERSION,
    `Replay input must use ${REPLAY_SCHEMA_VERSION}.`,
  );
  required(Boolean(normalizeMarket(root.market)), "Replay market must be Binance USDⓈ-M perpetual.");
  const symbol = safeSymbol(root.symbol);
  required(Boolean(symbol), "Replay symbol is invalid.");
  const generatedAt = isoTimestamp(first([root], "generatedAt", "generated_at"));
  required(Boolean(generatedAt), "Replay generatedAt is invalid.");
  const inputDigest = safeDigest(first([root], "inputDigest", "input_digest"));
  required(Boolean(inputDigest), "Replay input digest is invalid.");
  const windowSource = object(root.window);
  const window = {
    startAt: isoTimestamp(first([windowSource], "startAt", "start_at")),
    endExclusiveAt: isoTimestamp(first([windowSource], "endExclusiveAt", "end_exclusive_at")),
    completeUtcDays: number(first([windowSource], "completeUtcDays", "complete_utc_days"), {
      integer: true,
      min: 1,
      max: 31,
    }),
    barCount: number(first([windowSource], "barCount", "bar_count"), {
      integer: true,
      min: 1,
      max: 1_000_000,
    }),
    originCount: number(first([windowSource], "originCount", "origin_count"), {
      integer: true,
      min: 1,
      max: 1_000_000,
    }),
    originStrideMinutes: number(first(
      [windowSource],
      "originStrideMinutes",
      "origin_stride_minutes",
    ), { integer: true, min: 1, max: 1_440 }),
    futureBarsPerOrigin: number(first(
      [windowSource],
      "futureBarsPerOrigin",
      "future_bars_per_origin",
    ), { integer: true, min: 1, max: 1_440 }),
    contextPrefetchBarCount: number(first(
      [windowSource],
      "contextPrefetchBarCount",
      "context_prefetch_bar_count",
    ), { integer: true, min: 0, max: 1_000_000 }),
    outcomeTailBarCount: number(first(
      [windowSource],
      "outcomeTailBarCount",
      "outcome_tail_bar_count",
    ), { integer: true, min: 0, max: 1_000_000 }),
    inputBarCount: number(first(
      [windowSource],
      "inputBarCount",
      "input_bar_count",
    ), { integer: true, min: 1, max: 1_000_000 }),
  };
  const windowStart = window.startAt ? Date.parse(window.startAt) : Number.NaN;
  const windowEnd = window.endExclusiveAt ? Date.parse(window.endExclusiveAt) : Number.NaN;
  required(
    window.startAt
      && window.endExclusiveAt
      && window.completeUtcDays === REPLAY_WINDOW.completeUtcDays
      && window.barCount === REPLAY_WINDOW.barCount
      && window.contextPrefetchBarCount === REPLAY_WINDOW.contextPrefetchBarCount
      && window.outcomeTailBarCount === REPLAY_WINDOW.outcomeTailBarCount
      && window.inputBarCount === REPLAY_WINDOW.inputBarCount
      && window.originCount === REPLAY_WINDOW.originCount
      && window.originStrideMinutes === REPLAY_WINDOW.originStrideMinutes
      && window.futureBarsPerOrigin === REPLAY_WINDOW.futureBarsPerOrigin
      && windowEnd - windowStart === 7 * 24 * 60 * 60_000
      && new Date(windowStart).toISOString().endsWith("T00:00:00.000Z")
      && new Date(windowEnd).toISOString().endsWith("T00:00:00.000Z"),
    "Replay window must contain seven complete UTC days at 15-minute origins.",
  );
  const comparisonSource = object(root.comparison);
  const outcome = comparisonSource.outcome;
  required(OUTCOMES.has(outcome), "Replay outcome is invalid.");
  required(
    own(comparisonSource, "automaticWinner") && comparisonSource.automaticWinner === null,
    "Replay must not declare an automatic winner.",
  );
  const lanesSource = object(root.lanes);
  const lanes = Object.fromEntries(LANES.map((id) => {
    required(Object.keys(object(lanesSource[id])).length > 0, `Replay ${id} lane is missing.`);
    return [id, normalizeReplayLane(lanesSource[id], id, inputDigest)];
  }));
  const identitiesVerified = boolean(first(
    [comparisonSource],
    "identitiesVerified",
    "identities_verified",
  )) === true;
  const sameInputDigest = boolean(first(
    [comparisonSource],
    "sameInputDigest",
    "same_input_digest",
  )) === true;
  const sameRecords = boolean(first(
    [comparisonSource],
    "sameRecords",
    "same_records",
  )) === true;
  const sameContext = boolean(first(
    [comparisonSource],
    "sameContext",
    "same_context",
  )) === true;
  if (identitiesVerified) {
    required(
      LANES.every((id) => lanes[id].identityVerified),
      "Replay identity comparison conflicts with lane evidence.",
    );
  }
  if (sameInputDigest) {
    required(
      LANES.every((id) => lanes[id].inputDigest === inputDigest),
      "Replay input-digest comparison conflicts with lane evidence.",
    );
  }
  if (sameRecords) {
    const recordDigest = lanes.kronos_base.recordDigest;
    required(
      Boolean(recordDigest) && lanes.fincast.recordDigest === recordDigest,
      "Replay record comparison conflicts with lane evidence.",
    );
  }
  if (sameContext) {
    const contextDigest = lanes.kronos_base.effectiveContextDigest;
    required(
      Boolean(contextDigest)
        && lanes.kronos_base.effectiveContextBars === 512
        && lanes.fincast.effectiveContextBars === 512
        && lanes.fincast.effectiveContextDigest === contextDigest,
      "Replay context comparison conflicts with lane evidence.",
    );
  }
  return {
    schemaVersion: REPLAY_SCHEMA_VERSION,
    generatedAt,
    market: { ...MARKET },
    symbol,
    window,
    inputDigest,
    costs: normalizeCostAssumptions(first([root], "costAssumptions", "cost_assumptions")),
    lanes,
    comparison: {
      identitiesVerified,
      sameInputDigest,
      sameRecords,
      sameOrigin: boolean(first([comparisonSource], "sameOrigin", "same_origin")) === true,
      sameContext,
      sameCosts: boolean(first([comparisonSource], "sameCosts", "same_costs")) === true,
      sameFillBarrier: boolean(first(
        [comparisonSource],
        "sameFillBarrier",
        "same_fill_barrier",
      )) === true,
      outcome,
    },
  };
}

function shadowParts(payload) {
  const root = object(payload);
  const data = firstRecord(root.data);
  const result = firstRecord(root.result, data.result);
  const report = firstRecord(result.report, root.report, data.report);
  const snapshot = firstRecord(root.snapshot, result.snapshot, report.snapshot, data.snapshot);
  const summary = firstRecord(root.summary, result.summary, report.performance, data.summary);
  const run = firstRecord(root.run, result.run, report.run, data.run);
  const configuration = firstRecord(report.configuration, root.configuration, snapshot.configuration);
  return {
    root,
    data,
    result,
    report,
    snapshot,
    summary,
    run,
    configuration,
    sources: [root, data, result, report, snapshot, summary, run],
  };
}

function artifactEntries(parts) {
  const candidates = [
    parts.root.artifacts,
    parts.data.artifacts,
    parts.result.artifacts,
    parts.report.artifacts,
  ];
  return candidates.flatMap((candidate) => Array.isArray(candidate) ? candidate : []);
}

function artifactContent(parts, type) {
  for (const entry of artifactEntries(parts)) {
    const artifact = object(entry);
    if (artifact.type === type && Object.keys(object(artifact.content)).length) {
      return object(artifact.content);
    }
  }
  return {};
}

function normalizeCandidate(value, fallbackRank) {
  const source = object(value);
  const symbol = safeSymbol(first([source], "symbol", "instrument", "instrumentKey"));
  if (!symbol) return undefined;
  const quality = firstRecord(source.dataQuality, source.quality);
  const priceChangePercent = number(first(
    [source],
    "priceChangePercent24h",
    "price_change_percent_24h",
  ), { min: -100_000, max: 100_000 });
  const qualityStatus = safeStatus(first([quality], "status", "state"), "unavailable");
  return {
    rank: number(source.rank, { integer: true, min: 1, max: 100_000 }) ?? fallbackRank,
    symbol,
    score: number(first([source], "score", "volatilityScore", "volatility_score"), {
      min: 0,
      max: 1,
    }),
    quoteVolume: number(first(
      [source],
      "quoteVolume",
      "quote_volume",
      "tradingAmount",
      "trading_amount",
    ), { min: 0 }),
    relativeVolume: number(first([source], "relativeVolume", "relative_volume"), { min: 0 }),
    realizedVolatility60m: number(first(
      [source],
      "realizedVolatility60m",
      "realized_volatility_60m",
    ), { min: 0 }),
    volatility24h: number(first([source], "volatility24h", "volatility_24h"), {
      min: -1_000,
      max: 1_000,
    }) ?? (priceChangePercent === undefined ? undefined : priceChangePercent / 100),
    atrPercent: number(first([source], "atrPercent14", "atrPercent", "atr_percent_14"), {
      min: 0,
      max: 1_000,
    }),
    spreadBps: number(first([source], "spreadBps", "spread_bps"), { min: 0, max: 100_000 }),
    quality: qualityStatus,
  };
}

function normalizeScanner(parts, symbol) {
  const selectionArtifact = artifactContent(parts, "simulation-selection");
  const scanner = firstRecord(
    parts.root.scanner,
    parts.root.scannerSnapshot,
    parts.data.scanner,
    selectionArtifact,
  );
  const evidence = firstRecord(parts.report.evidence, parts.root.evidence);
  const snapshotId = safeToken(first(
    [scanner, evidence, parts.snapshot, parts.root],
    "scannerSnapshotId",
    "scanner_snapshot_id",
    "snapshotId",
    "snapshot_id",
  ), 128);
  required(Boolean(snapshotId), "Shadow scanner snapshot id is missing or unsafe.");
  const ranked = firstArray(
    scanner.rankedCandidates,
    scanner.candidates,
    parts.root.candidates,
    parts.report.selected,
    parts.snapshot.selected,
  );
  const candidates = ranked
    .map((item, index) => normalizeCandidate(item, index + 1))
    .filter(Boolean)
    .filter((item, index, all) => (
      all.findIndex((candidate) => candidate.symbol === item.symbol) === index
    ))
    .sort((left, right) => left.rank - right.rank || left.symbol.localeCompare(right.symbol))
    .slice(0, 12);
  required(candidates.some((candidate) => candidate.symbol === symbol), "Selected symbol is absent from scanner rows.");
  const rawCriterion = first(
    [scanner, parts.snapshot, parts.configuration],
    "criterion",
    "rankingCriterion",
  );
  const criterion = ["trading_amount", "volume", "volatility"].includes(rawCriterion)
    ? rawCriterion
    : "volatility";
  return { snapshotId, criterion, candidates };
}

function chartBars(parts, symbol) {
  const charts = firstArray(parts.root.charts, parts.report.charts, parts.snapshot.charts);
  for (const item of charts) {
    const chart = object(item);
    const chartSymbol = safeSymbol(chart.symbol);
    if ((!chartSymbol || chartSymbol === symbol) && Array.isArray(chart.bars)) return chart.bars;
  }
  return firstArray(parts.root.candles, parts.data.candles, parts.report.candles);
}

function normalizeCandles(parts, symbol) {
  const byTimestamp = new Map();
  for (const item of chartBars(parts, symbol)) {
    const source = object(item);
    const timestamp = isoTimestamp(first([source], "timestamp", "closeTime", "close_time"));
    const open = number(source.open, { min: Number.MIN_VALUE });
    const high = number(source.high, { min: Number.MIN_VALUE });
    const low = number(source.low, { min: Number.MIN_VALUE });
    const close = number(source.close, { min: Number.MIN_VALUE });
    if (
      !timestamp
      || open === undefined
      || high === undefined
      || low === undefined
      || close === undefined
      || high < Math.max(open, close)
      || low > Math.min(open, close)
    ) continue;
    byTimestamp.set(timestamp, { timestamp, open, high, low, close });
  }
  const candles = [...byTimestamp.values()]
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp))
    .slice(-240);
  required(candles.length > 0, "Shadow candle series is missing.");
  return candles;
}

function normalizeFill(value) {
  const source = object(value);
  const timestamp = isoTimestamp(first(
    [source],
    "timestamp",
    "executedAt",
    "executed_at",
    "filledAt",
  ));
  const price = number(source.price, { min: Number.MIN_VALUE });
  if (!timestamp || price === undefined) return undefined;
  const rawSide = safeToken(first([source], "side", "direction", "positionSide"), 32)?.toLowerCase();
  const action = safeToken(source.action, 32)?.toLowerCase();
  const direction = rawSide === "long"
    || (action === "open" && rawSide === "buy")
    ? "long"
    : rawSide === "short"
      || (action === "open" && rawSide === "sell")
      ? "short"
      : undefined;
  return {
    timestamp,
    lane: laneId(source.lane),
    action: ["open", "reduce", "close"].includes(action) ? action : undefined,
    direction,
    price,
    quantity: number(source.quantity, { min: 0 }),
    cost: number(source.cost),
    fee: number(first([source], "fee", "fees")),
    slippage: number(first([source], "slippage", "slippageCost")),
    funding: number(source.funding),
    realizedPnl: number(first([source], "realizedPnl", "realized_pnl")),
  };
}

function normalizeFills(parts) {
  const tradeArtifact = artifactContent(parts, "simulation-trades");
  const source = firstArray(
    parts.root.fills,
    parts.root.trades,
    parts.report.trades,
    parts.snapshot.trades,
    tradeArtifact.trades,
  );
  return source
    .map(normalizeFill)
    .filter(Boolean)
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp))
    .slice(-300);
}

function normalizeEquityRows(value) {
  const rows = values(value).flatMap((item) => {
    const source = object(item);
    const timestamp = isoTimestamp(first([source], "timestamp", "at", "time"));
    const equity = number(first([source], "equity", "value"), { min: 0 });
    if (!timestamp || equity === undefined) return [];
    return [{
      timestamp,
      value: equity,
      suppliedDrawdown: number(first([source], "drawdown", "drawdownRatio"), {
        min: 0,
        max: 1,
      }),
    }];
  }).sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  let peak = 0;
  return rows.slice(-360).map((row) => {
    peak = Math.max(peak, row.value);
    const derived = peak > 0 ? (peak - row.value) / peak : 0;
    return {
      timestamp: row.timestamp,
      value: row.value,
      drawdown: row.suppliedDrawdown ?? derived,
    };
  });
}

function normalizeEquity(parts, executionLane) {
  const equityArtifact = artifactContent(parts, "simulation-equity");
  const direct = firstRecord(
    parts.root.equityByLane,
    parts.root.equity_by_lane,
    parts.report.equityByLane,
    equityArtifact.lanes,
  );
  const output = Object.fromEntries(LANES.map((id) => [
    id,
    normalizeEquityRows(direct[id]),
  ]));
  const single = firstArray(parts.root.equity, parts.report.equity, parts.snapshot.equityCurve);
  if (!output[executionLane].length && single.length) {
    output[executionLane] = normalizeEquityRows(single);
  }
  required(
    Object.values(output).some((rows) => rows.length > 0),
    "Shadow paper equity series is missing.",
  );
  return output;
}

function normalizeShadowMetrics(value) {
  const source = object(value);
  const profitFactorRaw = first([source], "profitFactor", "profit_factor");
  const profitFactor = number(profitFactorRaw, { min: 0 });
  return {
    pinballLoss: number(first([source], "pinballLoss", "pinball_loss"), { min: 0 }),
    medianReturnMae: number(first([source], "medianReturnMae", "median_return_mae"), { min: 0 }),
    directionAccuracy: number(first([source], "directionAccuracy", "direction_accuracy"), {
      min: 0,
      max: 1,
    }),
    quantileCoverage: number(first([source], "quantileCoverage", "quantile_coverage"), {
      min: 0,
      max: 1,
    }),
    calibrationError: number(first([source], "calibrationError", "calibration_error"), {
      min: 0,
      max: 1,
    }),
    netPnl: number(first([source], "netPnl", "net_pnl", "pnl")),
    profitFactor,
    profitFactorInfinite: own(source, "profitFactor") && profitFactorRaw === null
      || own(source, "profit_factor") && profitFactorRaw === null,
    winRate: number(first([source], "winRate", "win_rate"), { min: 0, max: 1 }),
    maxDrawdown: number(first([source], "maxDrawdown", "max_drawdown"), { min: 0, max: 1 }),
    turnover: number(source.turnover, { min: 0 }),
    funding: number(first([source], "funding", "fundingCost", "funding_cost")),
    fees: number(first([source], "fees", "commission"), { min: 0 }),
    latencyMs: number(first([source], "latencyMs", "latency_ms"), { min: 0 }),
    availabilityRatio: number(first(
      [source],
      "availabilityRatio",
      "availability_ratio",
      "availability",
    ), { min: 0, max: 1 }),
    timeoutCount: number(first([source], "timeoutCount", "timeout_count"), {
      integer: true,
      min: 0,
    }),
    peakVramMb: number(first([source], "peakVramMb", "peak_vram_mb"), { min: 0 }),
    leverageDistribution: values(first(
      [source],
      "leverageDistribution",
      "leverage_distribution",
    )).flatMap((item) => {
      const leverage = number(item, { min: 0, max: 125 });
      return leverage === undefined ? [] : [leverage];
    }).slice(0, 1_000),
  };
}

function comparisonEntries(comparison) {
  const source = first([comparison], "lanes", "models", "results");
  return Array.isArray(source)
    ? source.map((item) => [undefined, item])
    : Object.entries(object(source));
}

function provenanceEntries(parts) {
  const artifact = artifactContent(parts, "simulation-provenance");
  const direct = firstRecord(parts.root.provenance, parts.report.provenance);
  return firstArray(
    artifact.modelLanes,
    direct.modelLanes,
    direct.lanes,
    parts.root.modelProvenance,
  );
}

function findProvenance(parts, id) {
  return provenanceEntries(parts)
    .map(object)
    .find((entry) => laneId(first([entry], "lane", "id", "modelLane")) === id) ?? {};
}

function normalizeShadowLane(value, id, parts) {
  const source = object(value);
  const rawStatus = first([source], "status", "state");
  const status = typeof rawStatus === "string" ? rawStatus.trim().toLowerCase() : undefined;
  required(
    [
      "available",
      "completed",
      "partial",
      "unavailable",
      "healthy",
      "degraded",
      "memory_pressure",
      "failed",
      "cancelled",
      "pending",
    ].includes(status),
    `Shadow ${id} status is invalid.`,
  );
  const provenanceSource = firstRecord(source.provenance, findProvenance(parts, id));
  const requiresProvenance = ["available", "completed", "healthy", "degraded", "partial"].includes(
    status,
  );
  const provenance = normalizeModelProvenance(
    provenanceSource,
    id,
    `Shadow ${id}`,
    { allowMissing: !requiresProvenance },
  );
  const rawPrecision = present([source], "precision", "dtype");
  const lanePrecision = rawPrecision.present ? strictPrecision(rawPrecision.value) : undefined;
  if (rawPrecision.present) {
    required(Boolean(lanePrecision), `Shadow ${id} precision is invalid.`);
  }
  if (provenance && lanePrecision) {
    required(
      provenance.precision === lanePrecision,
      `Shadow ${id} precision conflicts with model provenance.`,
    );
  }
  const metrics = normalizeShadowMetrics(first([source], "metrics", "performance") ?? source);
  const modelDigest = safeDigest(first(
    [provenanceSource, source],
    "modelDigest",
    "model_digest",
    "weightsDigest",
    "weights_digest",
  ));
  const imageDigest = safeDigest(first(
    [provenanceSource, source],
    "imageDigest",
    "image_digest",
    "containerDigest",
    "container_digest",
  ));
  const errors = errorCodes(
    source.errors,
    source.unavailableReason,
    provenanceSource.errors,
    provenanceSource.validationFailures,
    provenanceSource.precisionValidationFailure,
  );
  return {
    id,
    status,
    precision: provenance?.precision ?? lanePrecision ?? "unknown",
    metrics: {
      ...metrics,
      peakVramMb: metrics.peakVramMb
        ?? provenance?.peakVramMb,
    },
    provenance: provenance
      ? {
          ...provenance,
          modelDigest,
          imageDigest,
          attempts: number(provenanceSource.attempts, { integer: true, min: 0 }),
          successes: number(provenanceSource.successes, { integer: true, min: 0 }),
        }
      : {
          modelDigest,
          imageDigest,
          attempts: number(provenanceSource.attempts, { integer: true, min: 0 }),
          successes: number(provenanceSource.successes, { integer: true, min: 0 }),
        },
    errors,
  };
}

function collectKnownRealOrderFlags(parts) {
  const containers = [
    ...parts.sources,
    object(parts.root.execution),
    object(parts.configuration.execution),
    object(parts.snapshot.execution),
    object(parts.snapshot.capabilities),
    object(parts.report.evidence),
    object(parts.root.evidence),
  ];
  return containers.flatMap((source) => [
    ...(own(source, "realOrder") ? [boolean(source.realOrder)] : []),
    ...(own(source, "real_order") ? [boolean(source.real_order)] : []),
    ...(own(source, "realOrderApiUsed") ? [boolean(source.realOrderApiUsed)] : []),
  ]).filter((value) => value !== undefined);
}

function normalizeShadow(payload, replaySymbol) {
  const parts = shadowParts(payload);
  const schemas = parts.sources.flatMap((source) => {
    const value = first([source], "schemaVersion", "schema_version");
    return typeof value === "string" ? [value] : [];
  });
  required(
    schemas.includes(SIMULATION_SCHEMA_VERSION) || schemas.includes(SAFE_SHADOW_SCHEMA_VERSION),
    `Shadow input must contain ${SIMULATION_SCHEMA_VERSION} or ${SAFE_SHADOW_SCHEMA_VERSION}.`,
  );
  const market = [
    parts.root.market,
    parts.data.market,
    parts.report.market,
    parts.configuration.market,
    parts.snapshot.market,
    parts.summary.market,
  ].map(normalizeMarket).find(Boolean);
  required(Boolean(market), "Shadow market must be Binance USDⓈ-M perpetual.");
  const comparison = firstRecord(
    parts.root.comparison,
    parts.root.modelComparison,
    parts.data.modelComparison,
    parts.report.modelComparison,
    parts.snapshot.modelComparison,
    parts.summary.modelComparison,
  );
  required(Object.keys(comparison).length > 0, "Shadow model comparison is missing.");
  const selected = firstArray(parts.root.selected, parts.report.selected, parts.snapshot.selected);
  const symbol = safeSymbol(first(
    [comparison, parts.root, object(selected[0]), parts.snapshot],
    "symbol",
    "selectedSymbol",
  )) ?? replaySymbol;
  required(symbol === replaySymbol, "Replay and shadow symbols must match.");
  const execution = firstRecord(parts.root.execution, parts.configuration.execution);
  const rawExecutionMode = first(
    [parts.root, execution, parts.configuration, parts.snapshot],
    "executionMode",
    "execution_mode",
    "mode",
  );
  required(rawExecutionMode === "paper", "Shadow execution mode must be paper.");
  const realOrderFlags = collectKnownRealOrderFlags(parts);
  required(realOrderFlags.length > 0, "Shadow input must explicitly prove realOrder=false.");
  required(realOrderFlags.every((flag) => flag === false), "Real-order shadow payloads are forbidden.");
  const phaseEvidence = [
    parts.root,
    parts.run,
    parts.report,
    parts.summary,
    parts.snapshot,
  ].flatMap((source) => ["phase", "status"].flatMap((key) => (
    own(source, key) && source[key] !== undefined
      ? [safeStatus(source[key], "unavailable")]
      : []
  )));
  required(
    phaseEvidence.length > 0
      && phaseEvidence.every((value) => ["completed", "failed", "cancelled"].includes(value)),
    "Shadow input must be a terminal simulation payload.",
  );
  required(
    new Set(phaseEvidence).size === 1,
    "Shadow terminal phase evidence conflicts.",
  );
  const phase = phaseEvidence[0];
  const entries = comparisonEntries(comparison);
  const laneMap = new Map();
  for (const [key, item] of entries) {
    const source = object(item);
    const id = laneId(first([source], "id", "lane", "modelLane") ?? key);
    if (id && !laneMap.has(id)) laneMap.set(id, source);
  }
  const lanes = Object.fromEntries(LANES.map((id) => {
    required(laneMap.has(id), `Shadow ${id} lane is missing.`);
    return [id, normalizeShadowLane(laneMap.get(id), id, parts)];
  }));
  const rawOutcome = first([comparison], "outcome", "result");
  const outcome = OUTCOMES.has(rawOutcome) ? rawOutcome : "inconclusive";
  const evidence = firstRecord(
    parts.root.evidence,
    parts.report.evidence,
    parts.summary.evidence,
  );
  const settlementEvidence = [
    parts.root,
    parts.report,
    parts.summary,
    object(parts.root.evidence),
    object(parts.report.evidence),
    object(parts.summary.evidence),
    object(parts.root.terminalSettlement),
    object(parts.report.terminalSettlement),
    object(parts.summary.terminalSettlement),
    object(parts.snapshot.terminalSettlement),
  ].flatMap((source) => ["settlementComplete", "settlement_complete"].flatMap((key) => (
    own(source, key) && source[key] !== undefined
      ? [boolean(source[key])]
      : []
  )));
  required(
    settlementEvidence.length > 0,
    "Shadow terminal settlement evidence is missing.",
  );
  required(
    settlementEvidence.every((value) => value !== undefined),
    "Shadow terminal settlement evidence must be boolean.",
  );
  required(
    new Set(settlementEvidence).size === 1,
    "Shadow terminal settlement evidence conflicts.",
  );
  const settlementComplete = settlementEvidence[0];
  const executionLane = laneId(first(
    [parts.root, parts.configuration, parts.snapshot],
    "executionLane",
    "execution_lane",
  )) ?? "kronos_base";
  const generatedAt = isoTimestamp(first(
    [parts.root, parts.run, parts.report, parts.summary, parts.snapshot],
    "generatedAt",
    "generated_at",
    "finishedAt",
    "finished_at",
    "completedAt",
    "expiresAt",
  ));
  const durationMinutes = number(first(
    [parts.root, parts.configuration, parts.snapshot],
    "durationMinutes",
    "duration_minutes",
  ), { integer: true, min: 1, max: 10_080 });
  const scanner = normalizeScanner(parts, symbol);
  const candles = normalizeCandles(parts, symbol);
  const fills = normalizeFills(parts);
  const equityByLane = normalizeEquity(parts, executionLane);
  return {
    schemaVersion: schemas.includes(SAFE_SHADOW_SCHEMA_VERSION)
      ? SAFE_SHADOW_SCHEMA_VERSION
      : SIMULATION_SCHEMA_VERSION,
    generatedAt,
    phase,
    market: { ...MARKET },
    symbol,
    durationMinutes,
    executionMode: "paper",
    executionLane,
    settlementComplete,
    scanner,
    candles,
    fills,
    equityByLane,
    lanes,
    comparison: {
      sameOrigin: boolean(first([comparison], "sameOrigin", "same_origin")) === true,
      sameContext: boolean(first([comparison], "sameContext", "same_context")) === true,
      sameCosts: boolean(first([comparison], "sameCosts", "same_costs")) === true,
      sameFillBarrier: boolean(first(
        [comparison],
        "sameFillBarrier",
        "same_fill_barrier",
      )) === true,
      outcome,
    },
    evidence: {
      onlyFinalKlinesTriggerInference: boolean(first(
        [evidence],
        "onlyFinalKlinesTriggerInference",
        "only_final_klines_trigger_inference",
      )),
      fillRequiresStrictlyLaterEvent: boolean(first(
        [evidence],
        "fillRequiresStrictlyLaterEvent",
        "fill_requires_strictly_later_event",
      )),
      realOrder: false,
    },
  };
}

function weightedReplayMetric(metrics, key) {
  let weighted = 0;
  let count = 0;
  for (const metric of metrics) {
    const value = metric[key];
    if (value === undefined || metric.count <= 0) continue;
    weighted += value * metric.count;
    count += metric.count;
  }
  return count ? weighted / count : undefined;
}

function aggregateQuantileMetric(metrics, key, absolute = false) {
  let weighted = 0;
  let count = 0;
  for (const metric of metrics) {
    if (metric.count <= 0 || !metric.quantiles.length) continue;
    const average = metric.quantiles.reduce(
      (sum, quantile) => sum + (absolute ? Math.abs(quantile[key]) : quantile[key]),
      0,
    ) / metric.quantiles.length;
    weighted += average * metric.count;
    count += metric.count;
  }
  return count ? weighted / count : undefined;
}

function latestTimestamp(...timestamps) {
  const valid = timestamps.filter(Boolean).map((item) => Date.parse(item)).filter(Number.isFinite);
  return valid.length ? new Date(Math.max(...valid)).toISOString() : undefined;
}

function totalKnownCosts(fills, executionLane) {
  const laneFills = fills.filter((fill) => !fill.lane || fill.lane === executionLane);
  if (!laneFills.length || !laneFills.some((fill) => fill.cost !== undefined)) return undefined;
  return laneFills.reduce((sum, fill) => sum + (fill.cost ?? 0), 0);
}

export function normalizeReportInputs(replayPayload, shadowPayload) {
  const replay = normalizeReplay(replayPayload);
  const shadow = normalizeShadow(shadowPayload, replay.symbol);
  for (const id of LANES) {
    const replayProvenance = replay.lanes[id].provenance;
    const shadowProvenance = shadow.lanes[id].provenance?.modelId
      ? shadow.lanes[id].provenance
      : undefined;
    if (!replayProvenance || !shadowProvenance) continue;
    for (const key of [
      "modelId",
      "modelRevision",
      "sourceRevision",
      "loaderVersion",
      "device",
      "deviceName",
      "cudaCapability",
      "precision",
      "precisionValidation",
    ]) {
      required(
        replayProvenance[key] === shadowProvenance[key],
        `Replay and shadow ${id} ${key} provenance must match.`,
      );
    }
  }
  const comparability = Object.fromEntries([
    ["sameOrigin", [replay.comparison.sameOrigin, shadow.comparison.sameOrigin]],
    ["sameContext", [replay.comparison.sameContext, shadow.comparison.sameContext]],
    ["sameCosts", [replay.comparison.sameCosts, shadow.comparison.sameCosts]],
    ["sameFillBarrier", [replay.comparison.sameFillBarrier, shadow.comparison.sameFillBarrier]],
  ].map(([key, checks]) => [key, {
    replay: checks[0],
    shadow: checks[1],
    overall: checks.every(Boolean),
  }]));
  const lanesUsable = LANES.every((id) => (
    replay.lanes[id].availability === "available"
    && ["available", "completed", "healthy"].includes(shadow.lanes[id].status)
    && Boolean(replay.lanes[id].provenance)
    && Boolean(shadow.lanes[id].provenance.modelId)
  ));
  const readyForReview = Object.values(comparability).every((item) => item.overall)
    && replay.comparison.identitiesVerified
    && replay.comparison.sameInputDigest
    && replay.comparison.sameRecords
    && lanesUsable
    && shadow.phase === "completed"
    && shadow.settlementComplete === true
    && replay.comparison.outcome === "review_required"
    && shadow.comparison.outcome === "review_required";
  const outcome = readyForReview ? "review_required" : "inconclusive";
  const models = Object.fromEntries(LANES.map((id) => {
    const replayLane = replay.lanes[id];
    const shadowLane = shadow.lanes[id];
    const structuredProvenance = shadowLane.provenance.modelId
      ? shadowLane.provenance
      : replayLane.provenance ?? shadowLane.provenance;
    const metrics = replayLane.metrics;
    return [id, {
      id,
      label: LANE_LABELS[id],
      replay: {
        availability: replayLane.availability,
        identityVerified: replayLane.identityVerified,
        latencyMs: replayLane.latencyMs,
        metrics,
        aggregate: {
          pinballLoss: weightedReplayMetric(metrics, "meanPinballLoss"),
          medianReturnMae: weightedReplayMetric(metrics, "medianReturnMae"),
          directionAccuracy: weightedReplayMetric(metrics, "directionAccuracy"),
          quantileCoverage: aggregateQuantileMetric(metrics, "observedCoverage"),
          calibrationError: aggregateQuantileMetric(metrics, "calibrationError", true),
        },
      },
      shadow: {
        status: shadowLane.status,
        precision: shadowLane.precision,
        metrics: shadowLane.metrics,
      },
      provenance: {
        expectedModelId: replayLane.expectedModelId,
        observedModelId: replayLane.observedModelId,
        effectiveContextDigest: replayLane.effectiveContextDigest,
        effectiveContextBars: replayLane.effectiveContextBars,
        modelId: structuredProvenance.modelId,
        modelRevision: structuredProvenance.modelRevision,
        sourceRevision: structuredProvenance.sourceRevision,
        loaderVersion: structuredProvenance.loaderVersion,
        license: structuredProvenance.license,
        tokenizerId: structuredProvenance.tokenizerId,
        tokenizerRevision: structuredProvenance.tokenizerRevision,
        loaded: structuredProvenance.loaded,
        device: structuredProvenance.device,
        deviceName: structuredProvenance.deviceName,
        cudaCapability: structuredProvenance.cudaCapability,
        attentionBackend: structuredProvenance.attentionBackend,
        precision: structuredProvenance.precision,
        precisionValidation: structuredProvenance.precisionValidation,
        precisionFallbackUsed: structuredProvenance.precisionFallbackUsed,
        peakVramBytes: structuredProvenance.peakVramBytes,
        peakVramMeasurement: structuredProvenance.peakVramMeasurement,
        memoryStatus: structuredProvenance.memoryStatus,
        quantileTailPolicy: structuredProvenance.quantileTailPolicy,
        precisionFailureReasons: structuredProvenance.precisionFailureReasons,
        modelDigest: shadowLane.provenance.modelDigest,
        imageDigest: shadowLane.provenance.imageDigest,
        replayRecordDigest: replayLane.recordDigest,
        attempts: shadowLane.provenance.attempts,
        successes: shadowLane.provenance.successes,
      },
      errors: [...new Set([...replayLane.errors, ...shadowLane.errors])],
    }];
  }));
  const limitations = [
    "최근 완결 7일 replay와 단일 120분 안팎의 shadow 표본은 통계적 우월성을 증명하지 않습니다.",
    "paper fill은 실제 시장 충격, 주문장 우선순위와 네트워크 지연을 완전히 재현하지 못합니다.",
    "Kronos와 FinCast는 독립 lane이며 한 모델의 실패를 다른 모델 결과로 대체하지 않습니다.",
    "모델 승격과 실행 lane 변경은 자동화하지 않으며 운영자가 provenance와 실패 원인을 검토해야 합니다.",
  ];
  if (outcome === "inconclusive") {
    limitations.push("비교 가능성, lane availability, terminal settlement 또는 명시적 검토 상태 중 하나 이상이 충족되지 않아 결론을 inconclusive로 유지합니다.");
  }
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    status: "complete",
    generatedAt: latestTimestamp(replay.generatedAt, shadow.generatedAt) ?? replay.generatedAt,
    outcome,
    market: { ...MARKET },
    symbol: replay.symbol,
    replay: {
      generatedAt: replay.generatedAt,
      window: replay.window,
      inputDigest: replay.inputDigest,
      costs: replay.costs,
    },
    shadow: {
      generatedAt: shadow.generatedAt,
      phase: shadow.phase,
      durationMinutes: shadow.durationMinutes,
      executionMode: shadow.executionMode,
      executionLane: shadow.executionLane,
      settlementComplete: shadow.settlementComplete,
      totalKnownCosts: totalKnownCosts(shadow.fills, shadow.executionLane),
      evidence: shadow.evidence,
    },
    scanner: shadow.scanner,
    candles: shadow.candles,
    fills: shadow.fills,
    equityByLane: shadow.equityByLane,
    comparability,
    models,
    limitations,
  };
}

export function pendingReportData() {
  const emptyMetrics = {
    pinballLoss: undefined,
    medianReturnMae: undefined,
    directionAccuracy: undefined,
    quantileCoverage: undefined,
    calibrationError: undefined,
    netPnl: undefined,
    profitFactor: undefined,
    profitFactorInfinite: false,
    winRate: undefined,
    maxDrawdown: undefined,
    turnover: undefined,
    funding: undefined,
    fees: undefined,
    latencyMs: undefined,
    availabilityRatio: undefined,
    timeoutCount: undefined,
    peakVramMb: undefined,
    leverageDistribution: [],
  };
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    status: "pending",
    generatedAt: undefined,
    outcome: "inconclusive",
    market: { ...MARKET },
    symbol: undefined,
    replay: {
      generatedAt: undefined,
      window: {
        ...REPLAY_WINDOW,
      },
      inputDigest: undefined,
      costs: {},
    },
    shadow: {
      generatedAt: undefined,
      phase: "pending",
      durationMinutes: 120,
      executionMode: "paper",
      executionLane: "kronos_base",
      settlementComplete: undefined,
      totalKnownCosts: undefined,
      evidence: {
        onlyFinalKlinesTriggerInference: undefined,
        fillRequiresStrictlyLaterEvent: undefined,
        realOrder: false,
      },
    },
    scanner: { snapshotId: undefined, criterion: "volatility", candidates: [] },
    candles: [],
    fills: [],
    equityByLane: { kronos_base: [], fincast: [] },
    comparability: Object.fromEntries([
      "sameOrigin",
      "sameContext",
      "sameCosts",
      "sameFillBarrier",
    ].map((key) => [key, { replay: undefined, shadow: undefined, overall: undefined }])),
    models: Object.fromEntries(LANES.map((id) => [id, {
      id,
      label: LANE_LABELS[id],
      replay: {
        availability: "pending",
        identityVerified: false,
        latencyMs: undefined,
        metrics: [],
        aggregate: {},
      },
      shadow: {
        status: "pending",
        precision: "unknown",
        metrics: { ...emptyMetrics },
      },
      provenance: {},
      errors: [],
    }])),
    limitations: [
      "현재 파일은 실제 7일 replay와 120분 shadow 결과를 주입하기 전의 검증 대기 scaffold입니다.",
      "paper fill은 실제 시장 충격, 주문장 우선순위와 네트워크 지연을 완전히 재현하지 못합니다.",
      "모델 승격과 실행 lane 변경은 자동화하지 않으며 운영자가 비교 결과를 검토해야 합니다.",
    ],
  };
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function inlineJson(value) {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

function formatNumber(value, digits = 4) {
  return value === undefined
    ? "—"
    : new Intl.NumberFormat("ko-KR", {
        maximumFractionDigits: digits,
        minimumFractionDigits: 0,
      }).format(value);
}

function formatPercent(value, digits = 2) {
  return value === undefined ? "—" : `${formatNumber(value * 100, digits)}%`;
}

function formatUsdt(value) {
  return value === undefined
    ? "—"
    : `${value >= 0 ? "+" : ""}${formatNumber(value, 4)} USDT`;
}

function formatLatency(value) {
  return value === undefined ? "—" : `${formatNumber(value, 1)}ms`;
}

function formatVram(value) {
  return value === undefined ? "—" : `${formatNumber(value, 0)}MB`;
}

function formatDigest(value) {
  if (!value) return "미기록";
  const normalized = value.startsWith("sha256:") ? value.slice(7) : value;
  return `sha256:${normalized.slice(0, 12)}…${normalized.slice(-8)}`;
}

function formatBoolean(value) {
  return value === undefined ? "검증 대기" : value ? "PASS" : "FAIL";
}

function truthClass(value) {
  return value === undefined ? "" : value ? "cyan" : "red";
}

function metric(label, value, detail = "") {
  return `<div class="metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong>${
    detail ? `<small>${escapeHtml(detail)}</small>` : ""
  }</div>`;
}

function scannerRows(data) {
  if (!data.scanner.candidates.length) {
    return '<tr class="empty-row"><td colspan="9">scanner 결과 생성 전</td></tr>';
  }
  return data.scanner.candidates.map((candidate) => `<tr>
    <td>${escapeHtml(`${candidate.rank} · ${candidate.symbol}`)}</td>
    <td>${escapeHtml(formatNumber(candidate.score, 4))}</td>
    <td>${escapeHtml(formatNumber(candidate.quoteVolume, 0))}</td>
    <td>${escapeHtml(formatNumber(candidate.relativeVolume, 2))}</td>
    <td>${escapeHtml(formatPercent(candidate.realizedVolatility60m, 3))}</td>
    <td>${escapeHtml(formatPercent(candidate.volatility24h, 2))}</td>
    <td>${escapeHtml(formatPercent(candidate.atrPercent, 3))}</td>
    <td>${escapeHtml(candidate.spreadBps === undefined ? "—" : `${formatNumber(candidate.spreadBps, 2)}bp`)}</td>
    <td>${escapeHtml(candidate.quality)}</td>
  </tr>`).join("");
}

function horizonRows(model) {
  if (!model.replay.metrics.length) {
    return '<tr class="empty-row"><td colspan="7">replay horizon 지표 생성 전</td></tr>';
  }
  return model.replay.metrics.map((row) => {
    const q50 = row.quantiles.find((item) => item.quantile === 0.5);
    const calibration = row.quantiles.length
      ? row.quantiles.reduce((sum, item) => sum + Math.abs(item.calibrationError), 0)
        / row.quantiles.length
      : undefined;
    return `<tr>
      <td>${escapeHtml(`${row.horizonMinutes}분`)}</td>
      <td>${escapeHtml(formatNumber(row.count, 0))}</td>
      <td>${escapeHtml(formatNumber(row.meanPinballLoss, 7))}</td>
      <td>${escapeHtml(formatNumber(row.medianReturnMae, 7))}</td>
      <td>${escapeHtml(formatPercent(row.directionAccuracy, 2))}</td>
      <td>${escapeHtml(formatPercent(q50?.observedCoverage, 2))}</td>
      <td>${escapeHtml(formatPercent(calibration, 2))}</td>
    </tr>`;
  }).join("");
}

function errorList(model) {
  if (!model.errors.length) return '<li><strong>Errors</strong> · 없음</li>';
  return model.errors.map((code) => `<li><strong>Errors</strong> · ${escapeHtml(code)}</li>`).join("");
}

function modelPanel(model) {
  const replay = model.replay.aggregate;
  const shadow = model.shadow.metrics;
  const profitFactor = shadow.profitFactorInfinite
    ? "∞"
    : formatNumber(shadow.profitFactor, 3);
  const leverage = shadow.leverageDistribution.length
    ? `${formatNumber(
        shadow.leverageDistribution.reduce((sum, value) => sum + value, 0)
          / shadow.leverageDistribution.length,
        2,
      )}× avg`
    : "—";
  return `<div class="lane${model.id === "kronos_base" ? " active" : ""}" data-lane="${model.id}">
    <article class="card">
      <div class="section-head">
        <div><p class="eyebrow">${escapeHtml(model.label.toUpperCase())}</p><h2>${escapeHtml(model.label)} 독립 lane</h2><p>Replay 예측 지표와 shadow 거래·운영 지표를 분리해 표시합니다.</p></div>
        <span class="pill ${model.shadow.status === "completed" || model.shadow.status === "available" ? "cyan" : "amber"}">${escapeHtml(model.shadow.status)}</span>
      </div>
      <p class="metric-group">PREDICTION METRICS · 7-DAY REPLAY</p>
      <div class="grid-5">
        ${metric("Pinball loss", formatNumber(replay.pinballLoss, 7))}
        ${metric("Median-return MAE", formatNumber(replay.medianReturnMae, 7))}
        ${metric("방향 정확도", formatPercent(replay.directionAccuracy, 2))}
        ${metric("Quantile coverage", formatPercent(replay.quantileCoverage, 2))}
        ${metric("Calibration error", formatPercent(replay.calibrationError, 2))}
      </div>
      <div class="table-wrap" role="region" aria-label="${escapeHtml(model.label)} replay horizon 지표 가로 스크롤" tabindex="0">
        <table aria-label="${escapeHtml(model.label)} replay horizon 지표">
          <thead><tr><th>Horizon</th><th>표본</th><th>Pinball</th><th>Median MAE</th><th>방향</th><th>q50 coverage</th><th>Calibration</th></tr></thead>
          <tbody>${horizonRows(model)}</tbody>
        </table>
      </div>
      <p class="metric-group">TRADING METRICS · SHADOW</p>
      <div class="grid-5">
        ${metric("비용 후 PnL", formatUsdt(shadow.netPnl))}
        ${metric("Profit factor", profitFactor)}
        ${metric("Win rate", formatPercent(shadow.winRate, 2))}
        ${metric("Max drawdown", formatPercent(shadow.maxDrawdown, 2))}
        ${metric("Turnover", formatNumber(shadow.turnover, 3))}
        ${metric("Funding", formatUsdt(shadow.funding))}
        ${metric("Fees", formatUsdt(shadow.fees))}
        ${metric("평균 leverage", leverage)}
      </div>
      <p class="metric-group">OPERATIONAL METRICS</p>
      <div class="grid-5">
        ${metric("Precision", model.shadow.precision)}
        ${metric("Inference latency", formatLatency(shadow.latencyMs), `replay ${formatLatency(model.replay.latencyMs)}`)}
        ${metric("Availability", formatPercent(shadow.availabilityRatio, 2))}
        ${metric("Timeout", formatNumber(shadow.timeoutCount, 0))}
        ${metric("Peak VRAM", formatVram(shadow.peakVramMb))}
      </div>
      <ul class="list error-list">${errorList(model)}</ul>
    </article>
  </div>`;
}

function provenanceFacts(data) {
  const base = [
    ["Report schema", data.schemaVersion],
    ["Simulation schema", SIMULATION_SCHEMA_VERSION],
    ["Market", "BINANCE_USDM · USDT · PERPETUAL"],
    ["Replay window", `${data.replay.window.completeUtcDays ?? 7} complete UTC days · ${data.replay.window.originCount ?? 672} origins · ${data.replay.window.originStrideMinutes ?? 15}분 stride`],
    ["Replay input digest", formatDigest(data.replay.inputDigest)],
    ["Scanner snapshot", data.scanner.snapshotId ?? "검증 대기"],
    ["Execution", "paper · isolated · one-way · realOrder=false"],
    ["Report generated", data.generatedAt ?? "실제 실행 완료 전"],
  ];
  const laneFacts = LANES.flatMap((id) => {
    const model = data.models[id];
    return [
      [`${model.label} model`, model.provenance.modelId ?? model.provenance.observedModelId ?? model.provenance.expectedModelId ?? "미기록"],
      [`${model.label} revision`, model.provenance.modelRevision ?? "미기록"],
      [`${model.label} source / loader`, model.provenance.sourceRevision && model.provenance.loaderVersion
        ? `${model.provenance.sourceRevision} · ${model.provenance.loaderVersion}`
        : "미기록"],
      [`${model.label} device`, model.provenance.deviceName && model.provenance.cudaCapability
        ? `${model.provenance.deviceName} · CUDA ${model.provenance.cudaCapability}`
        : "미기록"],
      [`${model.label} precision validation`, model.provenance.precision && model.provenance.precisionValidation
        ? `${model.provenance.precision} · ${model.provenance.precisionValidation}`
        : "미기록"],
      [`${model.label} model digest`, formatDigest(model.provenance.modelDigest)],
      [`${model.label} image digest`, formatDigest(model.provenance.imageDigest)],
      [`${model.label} record digest`, formatDigest(model.provenance.replayRecordDigest)],
      [`${model.label} precision / VRAM`, `${model.shadow.precision} · ${formatVram(model.shadow.metrics.peakVramMb)}`],
    ];
  });
  return [...base, ...laneFacts].map(([label, value]) => (
    `<div class="fact"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`
  )).join("");
}

function comparabilityMetrics(data) {
  const labels = {
    sameOrigin: "동일 origin",
    sameContext: "동일 context",
    sameCosts: "동일 비용",
    sameFillBarrier: "공통 fill barrier",
  };
  return Object.entries(labels).map(([key, label]) => {
    const check = data.comparability[key];
    return `<div class="metric">
      <span>${escapeHtml(label)}</span>
      <strong class="${truthClass(check.overall)}">${escapeHtml(formatBoolean(check.overall))}</strong>
      <small>Replay ${escapeHtml(formatBoolean(check.replay))} · Shadow ${escapeHtml(formatBoolean(check.shadow))}</small>
    </div>`;
  }).join("");
}

export function renderCryptoComparisonReport(data) {
  required(data?.schemaVersion === REPORT_SCHEMA_VERSION, "Normalized report data is invalid.");
  required(OUTCOMES.has(data.outcome), "Report outcome must be inconclusive or review_required.");
  const pending = data.status === "pending";
  const executionModel = data.models[data.shadow.executionLane] ?? data.models.kronos_base;
  const executionMetrics = executionModel.shadow.metrics;
  const statusLabel = pending
    ? "검증 대기"
    : data.outcome === "review_required"
      ? "운영자 검토 필요"
      : "결론 보류";
  const statusClass = pending ? "" : data.outcome === "review_required" ? "cyan" : "amber";
  const outcomeTitle = pending ? "실제 비교 결과 생성 전" : "동일 조건 비교 결과";
  const scannerId = data.scanner.snapshotId ?? "snapshot 대기";
  const reportJson = inlineJson({
    schemaVersion: data.schemaVersion,
    status: data.status,
    outcome: data.outcome,
    generatedAt: data.generatedAt ?? null,
    symbol: data.symbol ?? null,
    candles: data.candles,
    fills: data.fills,
    equityByLane: data.equityByLane,
  });
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>Crypto Scalping · Kronos / FinCast 비교 보고서</title>
  <style>
    :root {
      color-scheme: dark;
      --background: 0 0% 4%;
      --foreground: 0 0% 96%;
      --card: 0 0% 7%;
      --muted: 0 0% 12%;
      --muted-foreground: 0 0% 60%;
      --border: 0 0% 17%;
      --cyan: 188 86% 53%;
      --amber: 38 92% 50%;
      --red: 0 76% 56%;
      --radius: 1.15rem;
      font-family: Inter, Pretendard, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    html { background: hsl(var(--background)); scroll-behavior: smooth; }
    body { margin: 0; background: hsl(var(--background)); color: hsl(var(--foreground)); }
    button, a { color: inherit; font: inherit; }
    :focus-visible { outline: 2px solid hsl(var(--cyan)); outline-offset: 3px; }
    .shell { width: min(100% - 32px, 1480px); margin: 0 auto; padding: 24px 0 72px; }
    .topbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 8px 2px 20px; }
    .brand { font-size: 11px; font-weight: 900; letter-spacing: .12em; }
    .status { display: inline-flex; align-items: center; gap: 7px; border-radius: 999px; padding: 8px 12px; background: hsl(var(--muted)); color: hsl(var(--muted-foreground)); font-size: 10px; font-weight: 900; }
    .status::before { width: 7px; height: 7px; border-radius: 50%; background: hsl(var(--amber)); content: ""; }
    .status.cyan::before { background: hsl(var(--cyan)); }
    .hero { overflow: hidden; border-radius: calc(var(--radius) + .4rem); background: hsl(var(--foreground)); color: hsl(var(--background)); padding: clamp(28px, 5vw, 70px); }
    .eyebrow { margin: 0; color: hsl(var(--muted-foreground)); font-size: 10px; font-weight: 950; letter-spacing: .14em; }
    .hero h1 { max-width: 1240px; margin: 20px 0 0; font-size: clamp(38px, 6.4vw, 92px); font-weight: 950; letter-spacing: -.065em; line-height: .94; word-break: keep-all; }
    .hero p { max-width: 820px; margin: 26px 0 0; color: hsl(0 0% 34%); font-size: 13px; line-height: 1.8; }
    .hero-grid { display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); gap: 8px; margin-top: 38px; }
    .hero-stat { min-width: 0; border-radius: 16px; background: hsl(0 0% 91%); padding: 16px; }
    .hero-stat span { display: block; color: hsl(0 0% 42%); font-size: 9px; font-weight: 900; }
    .hero-stat strong { display: block; margin-top: 7px; overflow-wrap: anywhere; font-size: 13px; }
    .tabs { position: sticky; top: 10px; z-index: 5; display: flex; gap: 4px; margin: 14px 0; padding: 4px; overflow-x: auto; border-radius: 16px; background: hsl(var(--muted) / .94); backdrop-filter: blur(14px); }
    .tab { flex: 1 0 max-content; min-height: 42px; border: 0; border-radius: 12px; padding: 0 16px; background: transparent; color: hsl(var(--muted-foreground)); cursor: pointer; font-size: 10px; font-weight: 900; }
    .tab[aria-selected="true"] { background: hsl(var(--card)); color: hsl(var(--foreground)); }
    [role="tabpanel"][hidden] { display: none; }
    .stack { display: grid; min-width: 0; gap: 12px; }
    .stack > * { min-width: 0; }
    .card, .chart-card { min-width: 0; border-radius: var(--radius); background: hsl(var(--card)); padding: clamp(18px, 3vw, 28px); }
    .card.muted { background: hsl(var(--muted)); }
    .section-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
    .section-head h2 { margin: 6px 0 0; font-size: clamp(20px, 3vw, 30px); letter-spacing: -.04em; }
    .section-head p { margin: 8px 0 0; color: hsl(var(--muted-foreground)); font-size: 11px; line-height: 1.6; }
    .pill { flex: none; border-radius: 999px; padding: 7px 10px; background: hsl(var(--muted)); color: hsl(var(--muted-foreground)); font-size: 9px; font-weight: 900; }
    .pill.cyan { background: hsl(var(--cyan) / .12); color: hsl(var(--cyan)); }
    .pill.amber { background: hsl(var(--amber) / .12); color: hsl(var(--amber)); }
    .pill.red { background: hsl(var(--red) / .12); color: hsl(var(--red)); }
    .grid-2 { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 12px; }
    .grid-4 { display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); gap: 8px; }
    .grid-5 { display: grid; grid-template-columns: repeat(5,minmax(0,1fr)); gap: 8px; }
    .metric { min-width: 0; border-radius: 14px; background: hsl(var(--muted)); padding: 14px; }
    .metric span { display: block; color: hsl(var(--muted-foreground)); font-size: 8px; font-weight: 900; letter-spacing: .04em; }
    .metric strong { display: block; margin-top: 7px; overflow-wrap: anywhere; font-size: 12px; }
    .metric strong.cyan { color: hsl(var(--cyan)); }
    .metric strong.red { color: hsl(var(--red)); }
    .metric small { display: block; margin-top: 6px; color: hsl(var(--muted-foreground)); font-size: 8px; line-height: 1.5; }
    .metric-group { margin: 22px 0 9px; color: hsl(var(--muted-foreground)); font-size: 8px; font-weight: 900; letter-spacing: .12em; }
    .table-wrap { margin-top: 18px; overflow-x: auto; }
    table { width: 100%; min-width: 840px; border-collapse: separate; border-spacing: 0 6px; font-size: 10px; text-align: left; }
    th { padding: 5px 12px; color: hsl(var(--muted-foreground)); font-size: 8px; }
    td { padding: 13px 12px; background: hsl(var(--muted)); }
    td:first-child { border-radius: 12px 0 0 12px; font-weight: 900; }
    td:last-child { border-radius: 0 12px 12px 0; }
    .empty-row td { color: hsl(var(--muted-foreground)); text-align: center; }
    .toggle-bar { display: flex; gap: 6px; margin: 18px 0 12px; padding: 4px; border-radius: 14px; background: hsl(var(--muted)); }
    .model-toggle { flex: 1; min-height: 40px; border: 0; border-radius: 10px; background: transparent; color: hsl(var(--muted-foreground)); cursor: pointer; font-size: 10px; font-weight: 900; }
    .model-toggle[aria-pressed="true"] { background: hsl(var(--card)); color: hsl(var(--foreground)); }
    .lane { display: none; min-width: 0; }
    .lane.active { display: block; }
    .chart-grid { display: grid; grid-template-columns: 1.4fr .6fr; gap: 12px; }
    .chart-card h3 { margin: 0; font-size: 13px; }
    .chart-card p { margin: 6px 0 0; color: hsl(var(--muted-foreground)); font-size: 9px; }
    .legend { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 10px; color: hsl(var(--muted-foreground)); font-size: 8px; }
    .legend i { display: inline-block; width: 8px; height: 8px; margin-right: 5px; border-radius: 50%; background: currentColor; }
    .legend .cyan { color: hsl(var(--cyan)); }
    .legend .amber { color: hsl(var(--amber)); }
    .canvas-wrap { position: relative; width: 100%; height: 280px; margin-top: 16px; }
    .canvas-wrap.short { height: 132px; }
    canvas { display: block; width: 100%; height: 100%; }
    .flow { display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); gap: 8px; margin-top: 18px; }
    .flow-item { position: relative; min-width: 0; border-radius: 14px; background: hsl(var(--muted)); padding: 16px; }
    .flow-item:not(:last-child)::after { position: absolute; top: 50%; right: -8px; z-index: 2; color: hsl(var(--muted-foreground)); content: "→"; transform: translateY(-50%); }
    .flow-item strong { display: block; font-size: 10px; }
    .flow-item span { display: block; margin-top: 7px; color: hsl(var(--muted-foreground)); font-size: 9px; line-height: 1.5; }
    .list { margin: 16px 0 0; padding-left: 18px; color: hsl(var(--muted-foreground)); font-size: 10px; line-height: 1.8; }
    .list strong { color: hsl(var(--foreground)); }
    .error-list { overflow-wrap: anywhere; }
    .facts { display: grid; gap: 7px; margin-top: 16px; }
    .fact { display: grid; grid-template-columns: 190px minmax(0,1fr); gap: 16px; border-radius: 13px; background: hsl(var(--muted)); padding: 13px; font-size: 9px; line-height: 1.6; }
    .fact dt { color: hsl(var(--muted-foreground)); font-weight: 900; }
    .fact dd { min-width: 0; margin: 0; overflow-wrap: anywhere; }
    footer { padding: 28px 4px 0; color: hsl(var(--muted-foreground)); font-size: 9px; line-height: 1.7; }
    @media (max-width: 1100px) { .grid-5 { grid-template-columns: repeat(3,minmax(0,1fr)); } }
    @media (max-width: 900px) {
      .hero-grid, .grid-4, .flow { grid-template-columns: repeat(2,minmax(0,1fr)); }
      .chart-grid { grid-template-columns: 1fr; }
      .flow-item:nth-child(2)::after { content: ""; }
    }
    @media (max-width: 560px) {
      .shell { width: min(100% - 20px, 1480px); padding-top: 10px; }
      .topbar { align-items: flex-start; }
      .hero { padding: 28px 20px; }
      .hero h1 { font-size: 34px; line-height: 1.04; letter-spacing: -.055em; overflow-wrap: break-word; }
      .hero-grid, .grid-2, .grid-4, .grid-5, .flow { grid-template-columns: 1fr; }
      .flow-item::after { content: "" !important; }
      .tabs { top: 4px; }
      .tab { min-height: 44px; padding: 0 13px; }
      .section-head { flex-direction: column; }
      .fact { grid-template-columns: 1fr; gap: 4px; }
      .canvas-wrap { height: 220px; }
    }
    @media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } }
  </style>
</head>
<body>
  <main class="shell">
    <div class="topbar">
      <div class="brand">PORTFOLIO LENS · RESEARCH</div>
      <span class="status ${statusClass}" id="report-status">${escapeHtml(statusLabel)}</span>
    </div>
    <header class="hero">
      <p class="eyebrow">BINANCE USDⓈ-M · PAPER ONLY · AI-PAPER-SIMULATION/V7</p>
      <h1>Kronos와 FinCast,<br>같은 시장에서 따로 검증합니다.</h1>
      <p>동일 origin·context·비용·fill barrier로 예측, 비용 후 거래 성과와 GPU 운영 특성을 비교합니다. 자동 우승자나 자동 승격은 만들지 않습니다.</p>
      <div class="hero-grid">
        <div class="hero-stat"><span>대상</span><strong id="hero-symbol">${escapeHtml(data.symbol ?? "선정 대기")}</strong></div>
        <div class="hero-stat"><span>Walk-forward</span><strong>최근 완결 7일 · 15분 origin</strong></div>
        <div class="hero-stat"><span>Shadow</span><strong>${escapeHtml(`${data.shadow.durationMinutes ?? 120}분 · paper`)}</strong></div>
        <div class="hero-stat"><span>결론</span><strong id="hero-outcome">${escapeHtml(data.outcome)}</strong></div>
      </div>
    </header>
    <nav class="tabs" role="tablist" aria-label="보고서 섹션">
      <button class="tab" role="tab" id="tab-overview" aria-controls="panel-overview" aria-selected="true" tabindex="0">개요</button>
      <button class="tab" role="tab" id="tab-models" aria-controls="panel-models" aria-selected="false" tabindex="-1">모델 비교</button>
      <button class="tab" role="tab" id="tab-risk" aria-controls="panel-risk" aria-selected="false" tabindex="-1">리스크·실행</button>
      <button class="tab" role="tab" id="tab-provenance" aria-controls="panel-provenance" aria-selected="false" tabindex="-1">Provenance</button>
    </nav>
    <section id="panel-overview" role="tabpanel" aria-labelledby="tab-overview" class="stack">
      <article class="card">
        <div class="section-head">
          <div><p class="eyebrow">SCANNER SNAPSHOT</p><h2>유동성 조건 내 scanner 순위</h2><p>선택 근거와 데이터 품질을 immutable snapshot 식별자와 함께 표시합니다.</p></div>
          <span class="pill amber" id="snapshot-id">${escapeHtml(scannerId)}</span>
        </div>
        <div class="table-wrap" role="region" aria-label="암호화폐 선물 scanner 순위 가로 스크롤" tabindex="0">
          <table aria-label="암호화폐 선물 scanner 순위">
            <thead><tr><th>순위 · 계약</th><th>종합 점수</th><th>거래대금</th><th>상대 거래량</th><th>60m 실현변동성</th><th>24h 변동성</th><th>ATR%</th><th>스프레드</th><th>데이터 품질</th></tr></thead>
            <tbody id="scanner-body">${scannerRows(data)}</tbody>
          </table>
        </div>
      </article>
      <div class="chart-grid">
        <article class="chart-card">
          <h3>확정 candle · paper fill</h3><p>Candle과 결정 이후 체결된 LONG/SHORT fill만 표시</p>
          <div class="legend"><span class="cyan"><i></i>상승 · LONG</span><span class="amber"><i></i>하락 · SHORT</span></div>
          <div class="canvas-wrap"><canvas id="candle-chart" aria-label="선택 계약 candle 및 paper fill 차트" role="img"></canvas></div>
        </article>
        <div class="stack">
          <article class="chart-card">
            <h3>Paper equity</h3><p>lane별 비용·funding 반영 equity</p>
            <div class="legend"><span class="cyan"><i></i>Kronos</span><span class="amber"><i></i>FinCast</span></div>
            <div class="canvas-wrap short"><canvas id="equity-chart" aria-label="lane별 paper equity 차트" role="img"></canvas></div>
          </article>
          <article class="chart-card">
            <h3>Drawdown</h3><p>lane별 peak-to-current drawdown</p>
            <div class="canvas-wrap short"><canvas id="drawdown-chart" aria-label="lane별 drawdown 차트" role="img"></canvas></div>
          </article>
        </div>
      </div>
      <article class="card muted">
        <div class="section-head">
          <div><p class="eyebrow">FORWARD RESULT</p><h2>${escapeHtml(outcomeTitle)}</h2><p>실행 lane은 ${escapeHtml(LANE_LABELS[data.shadow.executionLane] ?? data.shadow.executionLane)}이며 모델 승격 판단은 포함하지 않습니다.</p></div>
          <span class="pill ${statusClass}">${escapeHtml(data.outcome)}</span>
        </div>
        <div class="grid-4" style="margin-top:18px">
          ${metric("비용 후 PnL", formatUsdt(executionMetrics.netPnl))}
          ${metric("Profit factor", executionMetrics.profitFactorInfinite ? "∞" : formatNumber(executionMetrics.profitFactor, 3))}
          ${metric("Max drawdown", formatPercent(executionMetrics.maxDrawdown, 2))}
          ${metric("총 비용", formatUsdt(data.shadow.totalKnownCosts))}
        </div>
      </article>
    </section>
    <section id="panel-models" role="tabpanel" aria-labelledby="tab-models" class="stack" hidden>
      <article class="card muted">
        <div class="section-head">
          <div><p class="eyebrow">COMMON COMPARISON BOUNDARY</p><h2>같은 입력과 같은 실행 장벽</h2><p>Replay와 shadow 검증을 분리해 표시하고 둘 다 통과해야 overall PASS로 집계합니다.</p></div>
          <span class="pill">자동 우승자 없음</span>
        </div>
        <div class="grid-4" style="margin-top:18px">${comparabilityMetrics(data)}</div>
        <div class="toggle-bar" role="group" aria-label="표시 모델">
          <button class="model-toggle" data-model="kronos_base" aria-pressed="true">Kronos-base</button>
          <button class="model-toggle" data-model="fincast" aria-pressed="false">FinCast</button>
        </div>
      </article>
      ${LANES.map((id) => modelPanel(data.models[id])).join("")}
    </section>
    <section id="panel-risk" role="tabpanel" aria-labelledby="tab-risk" class="stack" hidden>
      <article class="card">
        <div class="section-head"><div><p class="eyebrow">EXECUTION BARRIER</p><h2>판단과 체결 사이의 시간 경계</h2><p>미래 가격을 사용하지 않도록 결정 이후 최초 유효 aggTrade 또는 다음 확정봉 open만 허용합니다.</p></div><span class="pill cyan">paper only</span></div>
        <div class="flow">
          <div class="flow-item" data-flow-step="1"><strong>확정 1분봉</strong><span>forming 봉은 판단을 유발하지 않음</span></div>
          <div class="flow-item" data-flow-step="2"><strong>독립 모델 판단</strong><span>lane별 quantile CDF와 비용 초과 확률</span></div>
          <div class="flow-item" data-flow-step="3"><strong>후속 이벤트 장벽</strong><span>결정 뒤 최초 유효 aggTrade 또는 확정봉 open</span></div>
          <div class="flow-item" data-flow-step="4"><strong>격리 paper 원장</strong><span>수수료·슬리피지·funding 반영</span></div>
        </div>
      </article>
      <div class="grid-2">
        <article class="card muted">
          <p class="eyebrow">POSITION RISK</p><h2 style="margin:8px 0 0">수량과 leverage</h2>
          <ul class="list">
            <li><strong>거래당 위험 0.5%</strong> / 보호 손절 거리로 명목가 산정</li>
            <li>보호 손절 = max(1.5×ATR14, adverse quantile, spread·slippage)</li>
            <li>paper leverage 최대 15×, gross exposure 150%, 증거금 20%</li>
            <li>청산 buffer가 손절 거리의 2배 미만이면 축소 또는 skip</li>
          </ul>
        </article>
        <article class="card muted">
          <p class="eyebrow">OBSERVED COSTS</p><h2 style="margin:8px 0 0">공통 비용 가정</h2>
          <ul class="list">
            <li>Commission / side · <strong>${escapeHtml(`${formatNumber(data.replay.costs.commissionBpsPerSide, 3)}bp`)}</strong></li>
            <li>Spread / round trip · <strong>${escapeHtml(`${formatNumber(data.replay.costs.spreadBpsRoundTrip, 3)}bp`)}</strong></li>
            <li>Slippage / side · <strong>${escapeHtml(`${formatNumber(data.replay.costs.slippageBpsPerSide, 3)}bp`)}</strong></li>
            <li>Tax / exit · <strong>${escapeHtml(`${formatNumber(data.replay.costs.taxBpsOnExit, 3)}bp`)}</strong></li>
          </ul>
        </article>
      </div>
      <article class="card">
        <div class="section-head"><div><p class="eyebrow">LIVE CAPABILITY</p><h2>이번 보고서의 realOrder는 false</h2><p>입력에서 paper 실행과 realOrder=false가 명시적으로 확인된 필드만 사용합니다.</p></div><span class="pill red">LIVE 잠김</span></div>
        <div class="grid-4" style="margin-top:18px">
          ${metric("PAPER", "허용")}
          ${metric("TESTNET", "잠김")}
          ${metric("LIVE", "잠김")}
          ${metric("Terminal settlement", data.shadow.settlementComplete === undefined ? "검증 대기" : data.shadow.settlementComplete ? "완료" : "불완전")}
        </div>
      </article>
    </section>
    <section id="panel-provenance" role="tabpanel" aria-labelledby="tab-provenance" class="stack" hidden>
      <article class="card">
        <div class="section-head"><div><p class="eyebrow">PROVENANCE</p><h2>재현 가능한 실행 경계</h2><p>허용된 식별자·revision·digest·precision·VRAM만 기록하며 원본 오류 메시지나 계정 데이터는 포함하지 않습니다.</p></div><span class="pill ${pending ? "amber" : "cyan"}">${pending ? "manifest 대기" : "whitelist normalized"}</span></div>
        <dl class="facts">${provenanceFacts(data)}</dl>
      </article>
      <article class="card muted">
        <p class="eyebrow">LIMITATIONS</p><h2 style="margin:8px 0 0">해석 한계</h2>
        <ul class="list">${data.limitations.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
      </article>
    </section>
    <footer>
      이 보고서는 외부 CDN·원격 스크립트·네트워크 요청 없이 동작하는 단일 HTML 파일입니다.
      데이터는 whitelist로 정규화해 파일 내부에만 포함하며 API credential, 서명, 계정 잔고 또는 키 일부를 복사하지 않습니다.
    </footer>
  </main>
  <script>
    "use strict";
    const REPORT_DATA = Object.freeze(${reportJson});
    const COLORS = Object.freeze({ kronos_base: "#22d3ee", fincast: "#f59e0b" });
    const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
    function activateTab(next) {
      tabs.forEach((tab) => {
        const active = tab === next;
        tab.setAttribute("aria-selected", String(active));
        tab.tabIndex = active ? 0 : -1;
        document.getElementById(tab.getAttribute("aria-controls")).hidden = !active;
      });
      requestAnimationFrame(drawAll);
    }
    tabs.forEach((tab, index) => {
      tab.addEventListener("click", () => activateTab(tab));
      tab.addEventListener("keydown", (event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const nextIndex = event.key === "Home" ? 0
          : event.key === "End" ? tabs.length - 1
          : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
        activateTab(tabs[nextIndex]);
        tabs[nextIndex].focus();
      });
    });
    const modelToggles = Array.from(document.querySelectorAll(".model-toggle"));
    modelToggles.forEach((button) => button.addEventListener("click", () => {
      const model = button.dataset.model;
      modelToggles.forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
      document.querySelectorAll("[data-lane]").forEach((lane) => {
        lane.classList.toggle("active", lane.dataset.lane === model);
      });
    }));
    document.querySelectorAll('[role="region"][aria-label*="가로 스크롤"]').forEach((region) => {
      region.addEventListener("keydown", (event) => {
        if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
        event.preventDefault();
        region.scrollBy({
          left: (event.key === "ArrowRight" ? 1 : -1) * Math.max(80, region.clientWidth * .65),
          behavior: "auto"
        });
      });
    });
    function fitCanvas(canvas) {
      const rect = canvas.getBoundingClientRect();
      const scale = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.round(rect.width * scale));
      canvas.height = Math.max(1, Math.round(rect.height * scale));
      const context = canvas.getContext("2d");
      context.setTransform(scale, 0, 0, scale, 0, 0);
      return { context, width: rect.width, height: rect.height };
    }
    function grid(context, width, height) {
      context.clearRect(0, 0, width, height);
      context.strokeStyle = "rgba(255,255,255,.06)";
      context.lineWidth = 1;
      for (let index = 1; index < 5; index += 1) {
        const y = (height / 5) * index;
        context.beginPath();
        context.moveTo(0, y);
        context.lineTo(width, y);
        context.stroke();
      }
    }
    function empty(context, width, height, label) {
      context.fillStyle = "rgba(255,255,255,.42)";
      context.font = "700 11px system-ui";
      context.textAlign = "center";
      context.fillText(label, width / 2, height / 2);
    }
    function drawMultiSeries(canvasId, groups, key, emptyLabel) {
      const canvas = document.getElementById(canvasId);
      if (!canvas || canvas.offsetParent === null) return;
      const { context, width, height } = fitCanvas(canvas);
      grid(context, width, height);
      const available = Object.entries(groups).filter(([, rows]) => rows.length);
      if (!available.length) { empty(context, width, height, emptyLabel); return; }
      const values = available.flatMap(([, rows]) => rows.map((row) => Number(row[key])))
        .filter(Number.isFinite);
      const min = Math.min(...values);
      const max = Math.max(...values);
      const range = max - min || Math.max(1, Math.abs(max));
      available.forEach(([lane, rows]) => {
        context.strokeStyle = COLORS[lane];
        context.lineWidth = 2;
        context.beginPath();
        rows.forEach((row, index) => {
          const x = rows.length === 1 ? width / 2 : (index / (rows.length - 1)) * width;
          const y = height - ((Number(row[key]) - min) / range) * (height - 20) - 10;
          index ? context.lineTo(x, y) : context.moveTo(x, y);
        });
        context.stroke();
      });
    }
    function drawMarker(context, x, y, direction) {
      const color = direction === "long" ? COLORS.kronos_base : COLORS.fincast;
      context.fillStyle = color;
      context.beginPath();
      if (direction === "long") {
        context.moveTo(x, y - 7); context.lineTo(x - 5, y + 2); context.lineTo(x + 5, y + 2);
      } else {
        context.moveTo(x, y + 7); context.lineTo(x - 5, y - 2); context.lineTo(x + 5, y - 2);
      }
      context.closePath();
      context.fill();
    }
    function drawCandles() {
      const canvas = document.getElementById("candle-chart");
      if (!canvas || canvas.offsetParent === null) return;
      const { context, width, height } = fitCanvas(canvas);
      grid(context, width, height);
      const rows = REPORT_DATA.candles;
      if (!rows.length) { empty(context, width, height, "확정 candle 데이터 생성 전"); return; }
      const low = Math.min(...rows.map((row) => row.low));
      const high = Math.max(...rows.map((row) => row.high));
      const range = high - low || 1;
      const step = width / rows.length;
      const y = (value) => height - ((value - low) / range) * (height - 20) - 10;
      rows.forEach((row, index) => {
        const x = step * index + step / 2;
        const rising = row.close >= row.open;
        context.strokeStyle = rising ? COLORS.kronos_base : COLORS.fincast;
        context.fillStyle = rising ? "#070707" : COLORS.fincast;
        context.beginPath();
        context.moveTo(x, y(row.high));
        context.lineTo(x, y(row.low));
        context.stroke();
        const top = Math.min(y(row.open), y(row.close));
        context.fillRect(
          x - Math.max(1, step * .22),
          top,
          Math.max(2, step * .44),
          Math.max(2, Math.abs(y(row.open) - y(row.close)))
        );
      });
      const start = Date.parse(rows[0].timestamp);
      const end = Date.parse(rows[rows.length - 1].timestamp);
      REPORT_DATA.fills.filter((fill) => fill.direction).forEach((fill) => {
        const at = Date.parse(fill.timestamp);
        if (!Number.isFinite(at) || at < start || at > end) return;
        const x = end === start ? width / 2 : ((at - start) / (end - start)) * width;
        drawMarker(context, x, y(fill.price), fill.direction);
      });
    }
    function drawAll() {
      drawCandles();
      drawMultiSeries("equity-chart", REPORT_DATA.equityByLane, "value", "paper equity 데이터 생성 전");
      drawMultiSeries("drawdown-chart", REPORT_DATA.equityByLane, "drawdown", "drawdown 데이터 생성 전");
    }
    window.addEventListener("resize", drawAll, { passive: true });
    requestAnimationFrame(drawAll);
  </script>
</body>
</html>
`;
}

export function renderReportFromInputs(replayPayload, shadowPayload) {
  return renderCryptoComparisonReport(normalizeReportInputs(replayPayload, shadowPayload));
}

async function readJson(path, label) {
  const metadata = await stat(path);
  required(metadata.isFile(), `${label} must be a regular JSON file.`);
  required(metadata.size <= MAX_INPUT_BYTES, `${label} exceeds the 64MiB input limit.`);
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
  required(Object.keys(object(parsed)).length > 0, `${label} must contain a JSON object.`);
  return parsed;
}

function usage() {
  return [
    "Usage:",
    "  node scripts/generate-crypto-comparison-report.mjs --replay <json> --shadow <json> --output <html>",
    "  node scripts/generate-crypto-comparison-report.mjs --pending --output <html>",
    "",
    `Replay schema: ${REPLAY_SCHEMA_VERSION}`,
    `Safe shadow schema: ${SAFE_SHADOW_SCHEMA_VERSION} (or final ${SIMULATION_SCHEMA_VERSION} API payload)`,
  ].join("\n");
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return { help: true };
    if (argument === "--pending") {
      options.pending = true;
      continue;
    }
    if (["--replay", "--shadow", "--output"].includes(argument)) {
      const value = argv[index + 1];
      required(value && !value.startsWith("--"), `${argument} requires a path.`);
      options[argument.slice(2)] = resolve(value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  required(options.output, "--output is required.");
  if (options.pending) {
    required(!options.replay && !options.shadow, "--pending cannot be combined with replay inputs.");
  } else {
    required(options.replay && options.shadow, "--replay and --shadow are required.");
  }
  return options;
}

export async function runCli(argv) {
  const options = parseArguments(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const html = options.pending
    ? renderCryptoComparisonReport(pendingReportData())
    : renderReportFromInputs(
        await readJson(options.replay, "Replay input"),
        await readJson(options.shadow, "Shadow input"),
      );
  await writeFile(options.output, html, { encoding: "utf8", mode: 0o644 });
  process.stdout.write(`Generated ${options.output}\n`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  runCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Report generation failed."}\n`);
    process.exitCode = 1;
  });
}
