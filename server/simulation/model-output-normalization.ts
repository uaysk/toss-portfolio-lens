export const PAIR_MODEL_NORMALIZATION_VERSION = "pair-model-normalization/v1" as const;

export type PairModelComponent = "chronos2" | "kronos";
export type PairModelStatus = "available" | "degraded" | "unavailable";
export type PairCalibrationStatus = "good" | "poor" | "unavailable";
export type PairInputQualityStatus = "good" | "partial" | "unavailable";

export type NormalizedPairModelProvenance = {
  modelId?: string;
  modelRevision?: string;
  tokenizerId?: string;
  tokenizerRevision?: string;
  sourceRevision?: string;
  loaderVersion?: string;
  license?: string;
  device?: string;
  deviceName?: string;
  cudaCapability?: string;
  dtype?: string;
  attentionBackend?: string;
  latencyMs?: number;
  loaded: boolean;
  fallbackFrom?: string;
  fallbackReason?: string;
  expectedModelId?: string;
  fallbackUsed?: boolean;
  degraded?: boolean;
  inputInstrumentKey?: string;
  inputOriginAt?: string;
  contextStartAt?: string;
  barCount?: number;
  inputDigest?: string;
};

export type NormalizedPairCalibration = {
  status: PairCalibrationStatus;
  brierScore?: number;
  coverageError?: number;
  reason?: string;
};

export type NormalizedPairModelOutput = {
  normalizationVersion: typeof PAIR_MODEL_NORMALIZATION_VERSION;
  component: PairModelComponent;
  status: PairModelStatus;
  reasonCodes: string[];
  signalSymbol: string;
  horizonMinutes: number;
  inputEndAt?: string;
  generatedAt?: string;
  targetTimestamp?: string;
  medianReturn?: number;
  q10Return?: number;
  q90Return?: number;
  upProbability?: number;
  downProbability?: number;
  flatProbability?: number;
  uncertaintyWidth?: number;
  expectedVolatility?: number;
  calibration: NormalizedPairCalibration;
  inputQuality: {
    status: PairInputQualityStatus;
    warnings: string[];
  };
  provenance: NormalizedPairModelProvenance;
  rawOutput: unknown;
};

export type NormalizedPairModelSet = {
  normalizationVersion: typeof PAIR_MODEL_NORMALIZATION_VERSION;
  signalSymbol: string;
  expectedOrigin?: string;
  alignedOrigin?: string;
  alignmentStatus: "aligned" | "misaligned" | "unavailable";
  reasonCodes: string[];
  chronos2: NormalizedPairModelOutput;
  kronos: NormalizedPairModelOutput;
  rawResponse: unknown;
};

export type PairModelNormalizationOptions = {
  signalSymbol: string;
  expectedOrigin?: string;
  horizonMinutes?: number;
  now?: string;
  maximumOriginAgeMs?: number;
  requireCuda?: boolean;
  requiredDeviceName?: string;
  allowChronosFallback?: boolean;
};

type UnknownRecord = Record<string, unknown>;

type ExtractedRun = {
  component?: PairModelComponent;
  wrapper: UnknownRecord;
  response: UnknownRecord;
  raw: unknown;
};

function record(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : undefined;
}

function text(value: unknown, maximum = 512): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= maximum ? normalized : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function boolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function timestamp(value: unknown): string | undefined {
  const normalized = text(value, 64);
  if (!normalized || !Number.isFinite(Date.parse(normalized))) return undefined;
  return new Date(Date.parse(normalized)).toISOString();
}

function first(source: UnknownRecord | undefined, ...keys: string[]): unknown {
  if (!source) return undefined;
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null) return source[key];
  }
  return undefined;
}

function cloneRaw<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

function componentFrom(value: unknown): PairModelComponent | undefined {
  const normalized = text(value)?.toLowerCase().replaceAll(/[\s_/-]+/g, "");
  if (!normalized) return undefined;
  if (normalized.includes("chronos2") || normalized === "chronos") return "chronos2";
  if (normalized.includes("kronossmall") || normalized === "kronos") return "kronos";
  return undefined;
}

function componentFromModelId(value: unknown): PairModelComponent | undefined {
  const normalized = text(value)?.toLowerCase();
  if (!normalized) return undefined;
  if (normalized === "amazon/chronos-2"
    || normalized === "amazon/chronos-bolt-small"
    || normalized.includes("chronos")) return "chronos2";
  if (normalized === "neoquasar/kronos-small" || normalized.includes("kronos")) return "kronos";
  return undefined;
}

function unwrapRun(value: unknown, explicitComponent?: PairModelComponent): ExtractedRun | undefined {
  const wrapper = record(value);
  if (!wrapper) return undefined;
  const response = record(first(wrapper, "response", "result", "output")) ?? wrapper;
  const model = record(first(response, "model", "model_provenance"))
    ?? record(first(wrapper, "model", "model_provenance"));
  const component = explicitComponent
    ?? componentFrom(first(wrapper, "component", "role", "model_kind", "modelKind", "lane"))
    ?? componentFromModelId(first(model, "model_id", "modelId", "id"));
  return { ...(component ? { component } : {}), wrapper, response, raw: cloneRaw(value) };
}

function extractedRuns(input: unknown): ExtractedRun[] {
  const response = record(input);
  if (!response) return [];
  const rawRuns = first(response, "model_runs", "modelRuns");
  if (Array.isArray(rawRuns)) {
    return rawRuns.flatMap((value) => unwrapRun(value) ?? []);
  }
  const mapped = record(rawRuns);
  if (mapped) {
    return Object.entries(mapped).flatMap(([key, value]) => (
      unwrapRun(value, componentFrom(key)) ?? []
    ));
  }
  return unwrapRun(response) ? [unwrapRun(response)!] : [];
}

function unavailableOutput(
  component: PairModelComponent,
  signalSymbol: string,
  horizonMinutes: number,
  reasonCodes: readonly string[],
  rawOutput: unknown,
): NormalizedPairModelOutput {
  return {
    normalizationVersion: PAIR_MODEL_NORMALIZATION_VERSION,
    component,
    status: "unavailable",
    reasonCodes: unique(reasonCodes),
    signalSymbol,
    horizonMinutes,
    calibration: { status: "unavailable" },
    inputQuality: { status: "unavailable", warnings: [] },
    provenance: { loaded: false },
    rawOutput: cloneRaw(rawOutput),
  };
}

function parseProvenance(run: ExtractedRun): NormalizedPairModelProvenance {
  const responseModel = record(first(run.response, "model", "model_provenance"));
  const wrapperModel = record(first(run.wrapper, "model", "model_provenance"));
  const model = responseModel ?? wrapperModel;
  const latencyMs = finite(
    first(run.wrapper, "latency_ms", "latencyMs", "inference_latency_ms", "inferenceLatencyMs")
      ?? first(run.response, "latency_ms", "latencyMs"),
  );
  const loaded = boolean(first(model, "loaded")) ?? false;
  const inputOrigins = first(run.wrapper, "input_origins", "inputOrigins")
    ?? first(run.response, "input_origins", "inputOrigins");
  const origins = Array.isArray(inputOrigins) ? inputOrigins.map(record) : [];
  const inputOrigin = origins.find((origin) => (
    text(first(origin, "instrument_key", "instrumentKey", "symbol")) !== undefined
  )) ?? origins[0];
  const contextStartAt = timestamp(first(inputOrigin, "context_start_at", "contextStartAt"));
  const inputInstrumentKey = text(
    first(inputOrigin, "instrument_key", "instrumentKey", "symbol"),
    128,
  );
  const inputOriginAt = timestamp(first(inputOrigin, "input_end_at", "inputEndAt", "origin"));
  const barCount = finite(first(inputOrigin, "bar_count", "barCount"));
  const inputDigest = text(first(inputOrigin, "input_digest", "inputDigest"), 256);
  const output: NormalizedPairModelProvenance = {
    loaded,
    ...(text(first(model, "model_id", "modelId", "id")) ? {
      modelId: text(first(model, "model_id", "modelId", "id")),
    } : {}),
    ...(text(first(model, "model_revision", "modelRevision", "revision")) ? {
      modelRevision: text(first(model, "model_revision", "modelRevision", "revision")),
    } : {}),
    ...(text(first(model, "tokenizer_id", "tokenizerId")) ? {
      tokenizerId: text(first(model, "tokenizer_id", "tokenizerId")),
    } : {}),
    ...(text(first(model, "tokenizer_revision", "tokenizerRevision")) ? {
      tokenizerRevision: text(first(model, "tokenizer_revision", "tokenizerRevision")),
    } : {}),
    ...(text(first(model, "source_revision", "sourceRevision")) ? {
      sourceRevision: text(first(model, "source_revision", "sourceRevision")),
    } : {}),
    ...(text(first(model, "loader_version", "loaderVersion")) ? {
      loaderVersion: text(first(model, "loader_version", "loaderVersion")),
    } : {}),
    ...(text(first(model, "license")) ? { license: text(first(model, "license")) } : {}),
    ...(text(first(model, "device")) ? { device: text(first(model, "device")) } : {}),
    ...(text(first(model, "device_name", "deviceName", "gpu_name", "gpuName")) ? {
      deviceName: text(first(model, "device_name", "deviceName", "gpu_name", "gpuName")),
    } : {}),
    ...(text(first(model, "cuda_capability", "cudaCapability", "compute_capability", "computeCapability")) ? {
      cudaCapability: text(
        first(model, "cuda_capability", "cudaCapability", "compute_capability", "computeCapability"),
      ),
    } : {}),
    ...(text(first(model, "dtype")) ? { dtype: text(first(model, "dtype")) } : {}),
    ...(text(first(model, "attention_backend", "attentionBackend")) ? {
      attentionBackend: text(first(model, "attention_backend", "attentionBackend")),
    } : {}),
    ...(latencyMs !== undefined && latencyMs >= 0 ? { latencyMs } : {}),
    ...(text(first(model, "fallback_from", "fallbackFrom")) ? {
      fallbackFrom: text(first(model, "fallback_from", "fallbackFrom")),
    } : {}),
    ...(text(first(model, "fallback_reason", "fallbackReason"), 1_000) ? {
      fallbackReason: text(first(model, "fallback_reason", "fallbackReason"), 1_000),
    } : {}),
    ...(text(first(run.wrapper, "expected_model_id", "expectedModelId")) ? {
      expectedModelId: text(first(run.wrapper, "expected_model_id", "expectedModelId")),
    } : {}),
    ...(boolean(first(run.wrapper, "fallback_used", "fallbackUsed")) !== undefined ? {
      fallbackUsed: boolean(first(run.wrapper, "fallback_used", "fallbackUsed")),
    } : {}),
    ...(boolean(first(run.wrapper, "degraded")) !== undefined ? {
      degraded: boolean(first(run.wrapper, "degraded")),
    } : {}),
    ...(inputInstrumentKey ? { inputInstrumentKey } : {}),
    ...(inputOriginAt ? { inputOriginAt } : {}),
    ...(contextStartAt ? { contextStartAt } : {}),
    ...(barCount !== undefined && Number.isSafeInteger(barCount) && barCount >= 0 ? { barCount } : {}),
    ...(inputDigest ? { inputDigest } : {}),
  };
  return output;
}

function parseCalibration(
  run: ExtractedRun,
  series: UnknownRecord,
  horizon: UnknownRecord,
): NormalizedPairCalibration {
  const source = record(first(horizon, "calibration"))
    ?? record(first(series, "calibration"))
    ?? record(first(run.wrapper, "calibration"))
    ?? record(first(run.response, "calibration"));
  if (!source) return { status: "unavailable" };
  const rawStatus = text(first(source, "status"))?.toLowerCase();
  const status: PairCalibrationStatus = rawStatus
    && ["good", "calibrated", "available", "passed", "valid"].includes(rawStatus)
    ? "good"
    : rawStatus && ["poor", "bad", "miscalibrated", "failed", "invalid"].includes(rawStatus)
      ? "poor"
      : "unavailable";
  const brierScore = finite(first(source, "brier_score", "brierScore"));
  const coverageError = finite(first(source, "coverage_error", "coverageError"));
  const reason = text(first(source, "reason"), 1_000);
  return {
    status,
    ...(brierScore !== undefined && brierScore >= 0 ? { brierScore } : {}),
    ...(coverageError !== undefined && coverageError >= 0 ? { coverageError } : {}),
    ...(reason ? { reason } : {}),
  };
}

function parseInputQuality(series: UnknownRecord): {
  status: PairInputQualityStatus;
  warnings: string[];
} {
  const source = record(first(series, "input_quality", "inputQuality", "data_quality", "dataQuality"));
  const rawStatus = text(first(source, "status"))?.toLowerCase();
  const status: PairInputQualityStatus = rawStatus === "good" || rawStatus === "available"
    ? "good"
    : rawStatus === "partial" ? "partial" : "unavailable";
  const warnings = Array.isArray(first(source, "warnings", "reasons"))
    ? (first(source, "warnings", "reasons") as unknown[])
        .flatMap((value) => text(value, 1_000) ?? [])
    : [];
  return { status, warnings: unique(warnings) };
}

function quantileReturns(horizon: UnknownRecord): {
  q10: number;
  median: number;
  q90: number;
} | undefined {
  const values = first(horizon, "return_quantiles", "returnQuantiles");
  if (!Array.isArray(values)) return undefined;
  const wanted = new Map<number, number>();
  for (const value of values) {
    const item = record(value);
    const quantile = finite(first(item, "quantile", "q"));
    const amount = finite(first(item, "value", "return"));
    if (quantile === undefined || amount === undefined || ![0.1, 0.5, 0.9].includes(quantile)) {
      continue;
    }
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

function normalizedProbability(value: unknown): number | undefined {
  const parsed = finite(value);
  return parsed !== undefined && parsed >= 0 && parsed <= 1 ? parsed : undefined;
}

function normalizeRun(
  run: ExtractedRun,
  component: PairModelComponent,
  options: Required<Pick<
    PairModelNormalizationOptions,
    "signalSymbol" | "horizonMinutes" | "maximumOriginAgeMs" | "requireCuda" | "allowChronosFallback"
  >> & Pick<PairModelNormalizationOptions, "expectedOrigin" | "now" | "requiredDeviceName">,
): NormalizedPairModelOutput {
  const rawOutput = cloneRaw(run.raw);
  const provenance = parseProvenance(run);
  const reasonCodes: string[] = [];
  const seriesValues = first(run.response, "series", "raw_series", "rawSeries");
  const series = Array.isArray(seriesValues)
    ? seriesValues.map(record).find((item) => (
        text(first(item, "instrument_key", "instrumentKey", "symbol"))?.toUpperCase()
          === options.signalSymbol
      ))
    : undefined;
  if (!series) {
    return unavailableOutput(
      component,
      options.signalSymbol,
      options.horizonMinutes,
      ["signal_series_missing"],
      rawOutput,
    );
  }
  const inputEndAt = timestamp(first(series, "input_end_at", "inputEndAt", "origin"));
  const generatedAt = timestamp(
    first(run.response, "generated_at", "generatedAt")
      ?? first(run.wrapper, "generated_at", "generatedAt"),
  );
  const horizons = first(series, "horizons");
  const horizon = Array.isArray(horizons)
    ? horizons.map(record).find((item) => (
        finite(first(item, "horizon_minutes", "horizonMinutes")) === options.horizonMinutes
      ))
    : undefined;
  const quantiles = horizon ? quantileReturns(horizon) : undefined;
  const targetTimestamp = horizon
    ? timestamp(first(horizon, "target_timestamp", "targetTimestamp"))
    : undefined;
  const upProbability = horizon
    ? normalizedProbability(first(horizon, "up_probability", "upProbability"))
    : undefined;
  const flatProbability = horizon
    ? normalizedProbability(first(horizon, "flat_probability", "flatProbability"))
    : undefined;
  const explicitDownProbability = horizon
    ? normalizedProbability(first(horizon, "down_probability", "downProbability"))
    : undefined;
  const downProbability = explicitDownProbability ?? (
    upProbability !== undefined
      ? Math.max(0, Math.min(1, 1 - upProbability - (flatProbability ?? 0)))
      : undefined
  );
  const expectedVolatility = horizon
    ? finite(first(horizon, "expected_volatility", "expectedVolatility"))
    : undefined;
  const inputQuality = parseInputQuality(series);
  const calibration = horizon ? parseCalibration(run, series, horizon) : { status: "unavailable" as const };

  if (text(first(series, "status"))?.toLowerCase() !== "available") reasonCodes.push("series_unavailable");
  if (!inputEndAt) reasonCodes.push("input_origin_invalid");
  if (!generatedAt) reasonCodes.push("generated_at_invalid");
  if (!horizon) reasonCodes.push("forecast_horizon_missing");
  if (!targetTimestamp) reasonCodes.push("target_timestamp_invalid");
  if (!quantiles) reasonCodes.push("return_quantiles_invalid");
  if (upProbability === undefined || downProbability === undefined) {
    reasonCodes.push("direction_probability_invalid");
  }
  if (!provenance.loaded) reasonCodes.push("model_not_loaded");
  const modelId = provenance.modelId?.toLowerCase();
  const expectedId = component === "chronos2"
    ? "amazon/chronos-2"
    : "neoquasar/kronos-small";
  const isChronosFallback = component === "chronos2"
    && (modelId === "amazon/chronos-bolt-small" || provenance.fallbackFrom !== undefined);
  if (modelId !== expectedId && !isChronosFallback) reasonCodes.push("unexpected_model_id");
  if (isChronosFallback) reasonCodes.push("chronos_fallback_used");
  const expectedModelId = provenance.expectedModelId?.toLowerCase();
  const runFallbackReason = text(first(run.wrapper, "fallback_reason", "fallbackReason"), 1_000);
  const runProvenancePresent = provenance.expectedModelId !== undefined
    || provenance.fallbackUsed !== undefined
    || provenance.degraded !== undefined
    || runFallbackReason !== undefined;
  if (runProvenancePresent) {
    const fallbackConsistent = provenance.fallbackUsed === true
      ? component === "chronos2"
        && expectedModelId === "amazon/chronos-2"
        && modelId === "amazon/chronos-bolt-small"
        && provenance.fallbackFrom?.toLowerCase() === "amazon/chronos-2"
        && provenance.degraded === true
        && provenance.loaded
        && Boolean(runFallbackReason)
        && runFallbackReason === provenance.fallbackReason
      : provenance.fallbackUsed === false
        ? expectedModelId === expectedId
          && modelId === expectedId
          && provenance.fallbackFrom === undefined
          && provenance.fallbackReason === undefined
          && provenance.degraded === false
          && runFallbackReason === undefined
        : false;
    if (!fallbackConsistent) reasonCodes.push("model_run_provenance_inconsistent");
  }
  const inputProvenancePresent = provenance.inputInstrumentKey !== undefined
    || provenance.inputOriginAt !== undefined
    || provenance.contextStartAt !== undefined
    || provenance.barCount !== undefined
    || provenance.inputDigest !== undefined;
  if (inputProvenancePresent) {
    const validDigest = provenance.inputDigest !== undefined
      && /^[a-f0-9]{64}$/.test(provenance.inputDigest);
    const inputProvenanceConsistent = provenance.inputInstrumentKey?.toUpperCase()
        === options.signalSymbol
      && provenance.inputOriginAt !== undefined
      && inputEndAt !== undefined
      && Date.parse(provenance.inputOriginAt) === Date.parse(inputEndAt)
      && provenance.contextStartAt !== undefined
      && Date.parse(provenance.contextStartAt) <= Date.parse(inputEndAt)
      && provenance.barCount !== undefined
      && Number.isSafeInteger(provenance.barCount)
      && provenance.barCount > 0
      && validDigest;
    if (!inputProvenanceConsistent) reasonCodes.push("input_origin_provenance_inconsistent");
  }
  if (options.requireCuda && !provenance.device?.toLowerCase().startsWith("cuda")) {
    reasonCodes.push("cuda_required");
  }
  if (options.requiredDeviceName
    && provenance.deviceName?.trim().toLowerCase()
      !== options.requiredDeviceName.trim().toLowerCase()) {
    reasonCodes.push("required_accelerator_mismatch");
  }
  if (inputQuality.status === "unavailable") reasonCodes.push("input_quality_unavailable");
  else if (inputQuality.status === "partial") reasonCodes.push("input_quality_partial");
  if (calibration.status === "poor") reasonCodes.push("calibration_poor");
  else if (calibration.status === "unavailable") reasonCodes.push("calibration_unavailable");
  if (options.expectedOrigin && inputEndAt
    && Date.parse(inputEndAt) !== Date.parse(options.expectedOrigin)) {
    reasonCodes.push("origin_mismatch");
  }
  if (inputEndAt && generatedAt && Date.parse(generatedAt) < Date.parse(inputEndAt)) {
    reasonCodes.push("generated_before_origin");
  }
  if (targetTimestamp && inputEndAt
    && Date.parse(targetTimestamp) <= Date.parse(inputEndAt)) {
    reasonCodes.push("target_not_after_origin");
  }
  if (targetTimestamp && generatedAt
    && Date.parse(targetTimestamp) <= Date.parse(generatedAt)) {
    reasonCodes.push("forecast_horizon_stale");
  }
  if (options.now && inputEndAt) {
    const nowMs = Date.parse(options.now);
    const age = nowMs - Date.parse(inputEndAt);
    if (!Number.isFinite(nowMs) || age < 0 || age > options.maximumOriginAgeMs) {
      reasonCodes.push("stale_origin");
    }
  }

  const blocking = new Set([
    "series_unavailable",
    "signal_series_missing",
    "input_origin_invalid",
    "generated_at_invalid",
    "forecast_horizon_missing",
    "target_timestamp_invalid",
    "return_quantiles_invalid",
    "direction_probability_invalid",
    "model_not_loaded",
    "unexpected_model_id",
    "model_run_provenance_inconsistent",
    "input_origin_provenance_inconsistent",
    "cuda_required",
    "required_accelerator_mismatch",
    "input_quality_unavailable",
    "calibration_poor",
    "origin_mismatch",
    "generated_before_origin",
    "target_not_after_origin",
    "forecast_horizon_stale",
    "stale_origin",
  ]);
  if (isChronosFallback && !options.allowChronosFallback) blocking.add("chronos_fallback_used");
  const status: PairModelStatus = reasonCodes.some((reason) => blocking.has(reason))
    ? "unavailable"
    : reasonCodes.includes("chronos_fallback_used")
        || reasonCodes.includes("input_quality_partial")
        || provenance.degraded === true
      ? "degraded"
      : "available";

  return {
    normalizationVersion: PAIR_MODEL_NORMALIZATION_VERSION,
    component,
    status,
    reasonCodes: unique(reasonCodes),
    signalSymbol: options.signalSymbol,
    horizonMinutes: options.horizonMinutes,
    ...(inputEndAt ? { inputEndAt } : {}),
    ...(generatedAt ? { generatedAt } : {}),
    ...(targetTimestamp ? { targetTimestamp } : {}),
    ...(quantiles ? {
      medianReturn: quantiles.median,
      q10Return: quantiles.q10,
      q90Return: quantiles.q90,
      uncertaintyWidth: quantiles.q90 - quantiles.q10,
    } : {}),
    ...(upProbability !== undefined ? { upProbability } : {}),
    ...(downProbability !== undefined ? { downProbability } : {}),
    ...(flatProbability !== undefined ? { flatProbability } : {}),
    ...(expectedVolatility !== undefined && expectedVolatility >= 0
      ? { expectedVolatility } : {}),
    calibration,
    inputQuality,
    provenance,
    rawOutput,
  };
}

export function normalizePairModelOutputs(
  input: unknown,
  optionsInput: PairModelNormalizationOptions,
): NormalizedPairModelSet {
  const signalSymbol = optionsInput.signalSymbol.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9._-]{0,31}$/.test(signalSymbol)) {
    throw new Error("signalSymbol is invalid.");
  }
  const horizonMinutes = optionsInput.horizonMinutes ?? 5;
  const maximumOriginAgeMs = optionsInput.maximumOriginAgeMs ?? 180_000;
  if (!Number.isSafeInteger(horizonMinutes) || horizonMinutes < 1
    || !Number.isSafeInteger(maximumOriginAgeMs) || maximumOriginAgeMs < 0) {
    throw new Error("Model normalization horizon and freshness limits are invalid.");
  }
  const expectedOrigin = optionsInput.expectedOrigin
    ? timestamp(optionsInput.expectedOrigin)
    : undefined;
  const now = optionsInput.now ? timestamp(optionsInput.now) : undefined;
  const requiredDeviceName = optionsInput.requiredDeviceName?.trim();
  if (optionsInput.expectedOrigin && !expectedOrigin) throw new Error("expectedOrigin is invalid.");
  if (optionsInput.now && !now) throw new Error("now is invalid.");
  if (optionsInput.requiredDeviceName && (!requiredDeviceName || requiredDeviceName.length > 256)) {
    throw new Error("requiredDeviceName is invalid.");
  }
  const options = {
    signalSymbol,
    horizonMinutes,
    maximumOriginAgeMs,
    requireCuda: optionsInput.requireCuda ?? true,
    allowChronosFallback: optionsInput.allowChronosFallback ?? false,
    ...(expectedOrigin ? { expectedOrigin } : {}),
    ...(now ? { now } : {}),
    ...(requiredDeviceName ? { requiredDeviceName } : {}),
  };
  const runs = extractedRuns(input);
  const byComponent = (component: PairModelComponent) => runs.filter((run) => (
    run.component === component
  ));
  const normalizeComponent = (component: PairModelComponent): NormalizedPairModelOutput => {
    const matches = byComponent(component);
    if (!matches.length) {
      return unavailableOutput(component, signalSymbol, horizonMinutes, ["model_run_missing"], input);
    }
    if (matches.length > 1) {
      return unavailableOutput(component, signalSymbol, horizonMinutes, ["duplicate_model_runs"], matches);
    }
    return normalizeRun(matches[0]!, component, options);
  };
  const chronos2 = normalizeComponent("chronos2");
  const kronos = normalizeComponent("kronos");
  const origins = [chronos2.inputEndAt, kronos.inputEndAt].filter(
    (value): value is string => value !== undefined,
  );
  const bothUsableOrigins = origins.length === 2;
  const alignedByTimestamp = bothUsableOrigins
    && Date.parse(origins[0]!) === Date.parse(origins[1]!);
  const targets = [chronos2.targetTimestamp, kronos.targetTimestamp].filter(
    (value): value is string => value !== undefined,
  );
  const alignedByTarget = targets.length === 2
    && Date.parse(targets[0]!) === Date.parse(targets[1]!);
  const contexts = [chronos2, kronos].map((model) => model.provenance);
  const contextProvenancePresent = contexts.some((context) => (
    context.inputInstrumentKey !== undefined
    || context.inputOriginAt !== undefined
    || context.contextStartAt !== undefined
    || context.barCount !== undefined
    || context.inputDigest !== undefined
  ));
  const alignedByContext = !contextProvenancePresent || (
    contexts.every((context) => (
      context.inputInstrumentKey !== undefined
      && context.inputOriginAt !== undefined
      && context.contextStartAt !== undefined
      && context.barCount !== undefined
      && context.inputDigest !== undefined
    ))
    && contexts[0]!.inputInstrumentKey?.toUpperCase()
      === contexts[1]!.inputInstrumentKey?.toUpperCase()
    && Date.parse(contexts[0]!.inputOriginAt!)
      === Date.parse(contexts[1]!.inputOriginAt!)
    && Date.parse(contexts[0]!.contextStartAt!)
      === Date.parse(contexts[1]!.contextStartAt!)
    && contexts[0]!.barCount === contexts[1]!.barCount
    && contexts[0]!.inputDigest === contexts[1]!.inputDigest
  );
  const aligned = alignedByTimestamp && alignedByTarget && alignedByContext;
  const expectedAligned = !expectedOrigin || origins.every((origin) => (
    Date.parse(origin) === Date.parse(expectedOrigin)
  ));
  const alignmentStatus: NormalizedPairModelSet["alignmentStatus"] = !bothUsableOrigins
    ? "unavailable"
    : aligned && expectedAligned ? "aligned" : "misaligned";
  const reasonCodes = unique([
    ...(!alignedByTimestamp || !expectedAligned ? ["model_origin_mismatch"] : []),
    ...(!alignedByTarget ? ["model_target_timestamp_mismatch"] : []),
    ...(!alignedByContext ? ["model_input_context_mismatch"] : []),
    ...(alignmentStatus === "unavailable" ? ["model_origin_unavailable"] : []),
    ...chronos2.reasonCodes.map((reason) => `chronos2:${reason}`),
    ...kronos.reasonCodes.map((reason) => `kronos:${reason}`),
  ]);
  return {
    normalizationVersion: PAIR_MODEL_NORMALIZATION_VERSION,
    signalSymbol,
    ...(expectedOrigin ? { expectedOrigin } : {}),
    ...(alignmentStatus === "aligned" ? { alignedOrigin: origins[0] } : {}),
    alignmentStatus,
    reasonCodes,
    chronos2,
    kronos,
    rawResponse: cloneRaw(input),
  };
}
