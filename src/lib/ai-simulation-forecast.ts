export const AI_SIMULATION_KRONOS_BASE_MODEL_ID = "NeoQuasar/Kronos-base" as const;
export const AI_SIMULATION_FINCAST_MODEL_ID = "Vincent05R/FinCast" as const;

export type AiSimulationForecastLane = "kronos_base" | "fincast";

export type AiSimulationKronosForecastPoint = {
  horizonMinutes: number;
  targetTimestamp: string;
  q10Price: number;
  medianPrice: number;
  q90Price: number;
  upProbability?: number;
};

export type AiSimulationKronosForecast = {
  signalSymbol: string;
  status: "available" | "unavailable";
  origin?: string;
  generatedAt?: string;
  modelId?: string;
  modelRevision?: string;
  points: AiSimulationKronosForecastPoint[];
  unavailableReason?: string;
};

export type AiSimulationModelForecast = AiSimulationKronosForecast & {
  lane: AiSimulationForecastLane;
};

export type AiSimulationKronosActualMark = {
  timestamp: string;
  close: number;
};

export type AiSimulationKronosForecastChartRow = {
  timestamp: string;
  actualPrice?: number;
  q10Price?: number;
  medianPrice?: number;
  q90Price?: number;
  predictionRange?: [number, number];
  horizonMinutes?: number;
  upProbability?: number;
};

type UnknownRecord = Record<string, unknown>;

type ForecastCandidate = {
  output: UnknownRecord;
  context: UnknownRecord;
};

function record(value: unknown): UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : {};
}

function first(source: UnknownRecord, ...keys: string[]): unknown {
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null) return source[key];
  }
  return undefined;
}

function text(value: unknown, maximum = 1_000): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= maximum ? normalized : undefined;
}

function finite(value: unknown): number | undefined {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim()
      ? Number(value)
      : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function timestamp(value: unknown): string | undefined {
  const parsed = text(value, 64);
  if (!parsed || !Number.isFinite(Date.parse(parsed))) return undefined;
  return new Date(Date.parse(parsed)).toISOString();
}

function symbol(value: unknown): string | undefined {
  const parsed = text(value, 64)?.toUpperCase();
  return parsed && /^[A-Z0-9][A-Z0-9._-]{0,31}$/.test(parsed) ? parsed : undefined;
}

function probability(value: unknown): number | undefined {
  const parsed = finite(value);
  return parsed !== undefined && parsed >= 0 && parsed <= 1 ? parsed : undefined;
}

function candidateFromContainer(
  containerValue: unknown,
  context: UnknownRecord,
): ForecastCandidate | undefined {
  const container = record(containerValue);
  const output = record(first(
    container,
    "kronos",
    "kronosBase",
    "kronos_base",
    "kronos-base",
  ));
  return Object.keys(output).length ? { output, context } : undefined;
}

function collectCandidates(value: unknown, output: ForecastCandidate[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectCandidates(item, output);
    return;
  }
  const source = record(value);
  if (!Object.keys(source).length) return;

  const modelOutput = candidateFromContainer(
    first(source, "modelOutputs", "model_outputs", "models"),
    source,
  );
  if (modelOutput) output.push(modelOutput);

  const rawInput = candidateFromContainer(
    first(source, "rawInputs", "raw_inputs"),
    source,
  );
  if (rawInput) output.push(rawInput);

  const replayInput = record(first(source, "replayInput", "replay_input"));
  const replayModel = candidateFromContainer(
    first(replayInput, "models", "modelOutputs", "model_outputs"),
    source,
  );
  if (replayModel) output.push(replayModel);

  const role = text(first(source, "role", "component", "model_kind", "modelKind"))
    ?.toLowerCase()
    .replaceAll("-", "_");
  if (
    first(source, "rawOutput", "raw_output") !== undefined
    || first(source, "raw_series", "rawSeries") !== undefined
    || role === "kronos"
    || role === "kronos_base"
  ) {
    output.push({ output: source, context: source });
  }

  for (const nested of [
    first(source, "decisions"),
    first(source, "decisionProvenance", "decision_provenance"),
  ]) {
    if (Array.isArray(nested)) collectCandidates(nested, output);
  }
}

function modelIdentity(candidate: ForecastCandidate): {
  modelId?: string;
  modelRevision?: string;
  recognized: boolean;
} {
  const directProvenance = record(first(
    candidate.output,
    "provenance",
    "modelProvenance",
    "model_provenance",
  ));
  const raw = record(first(candidate.output, "rawOutput", "raw_output"));
  const rawSource = Object.keys(raw).length ? raw : candidate.output;
  const response = record(first(rawSource, "response", "result", "output"));
  const responseSource = Object.keys(response).length ? response : rawSource;
  const model = record(first(responseSource, "model", "model_provenance"));
  const rawModel = Object.keys(model).length
    ? model
    : record(first(rawSource, "model", "model_provenance"));
  const modelId = text(first(
    directProvenance,
    "modelId",
    "model_id",
  )) ?? text(first(rawModel, "modelId", "model_id", "id"));
  const expectedModelId = text(first(
    responseSource,
    "expectedModelId",
    "expected_model_id",
  )) ?? text(first(rawSource, "expectedModelId", "expected_model_id"));
  const recognized = modelId
    ? modelId.toLowerCase() === AI_SIMULATION_KRONOS_BASE_MODEL_ID.toLowerCase()
    : expectedModelId?.toLowerCase() === AI_SIMULATION_KRONOS_BASE_MODEL_ID.toLowerCase();
  return {
    modelId,
    modelRevision: text(first(
      directProvenance,
      "modelRevision",
      "model_revision",
      "revision",
    )) ?? text(first(rawModel, "modelRevision", "model_revision", "revision")),
    recognized,
  };
}

function directQuantile(
  values: unknown,
  wanted: 0.1 | 0.5 | 0.9,
): number | undefined {
  if (!Array.isArray(values)) return undefined;
  const matches = values.flatMap((value) => {
    const item = record(value);
    const quantile = finite(first(item, "quantile", "q"));
    const amount = finite(first(item, "value", "price"));
    return quantile === wanted && amount !== undefined ? [amount] : [];
  });
  return matches.length === 1 ? matches[0] : undefined;
}

function normalizePoint(
  value: unknown,
  origin: string | undefined,
): AiSimulationKronosForecastPoint | undefined {
  const source = record(value);
  const horizonMinutes = finite(first(source, "horizonMinutes", "horizon_minutes"));
  const targetTimestamp = timestamp(first(source, "targetTimestamp", "target_timestamp"));
  const prices = first(source, "priceQuantiles", "price_quantiles");
  const q10Price = directQuantile(prices, 0.1)
    ?? finite(first(source, "q10Price", "q10_price"));
  const medianPrice = directQuantile(prices, 0.5)
    ?? finite(first(source, "medianPrice", "median_price", "q50Price", "q50_price"));
  const q90Price = directQuantile(prices, 0.9)
    ?? finite(first(source, "q90Price", "q90_price"));
  if (
    horizonMinutes === undefined
    || !Number.isSafeInteger(horizonMinutes)
    || horizonMinutes <= 0
    || !targetTimestamp
    || (origin && Date.parse(targetTimestamp) <= Date.parse(origin))
    || q10Price === undefined
    || medianPrice === undefined
    || q90Price === undefined
    || q10Price <= 0
    || q10Price > medianPrice
    || medianPrice > q90Price
  ) {
    return undefined;
  }
  const upProbability = probability(first(source, "upProbability", "up_probability"));
  return {
    horizonMinutes,
    targetTimestamp,
    q10Price,
    medianPrice,
    q90Price,
    ...(upProbability !== undefined ? { upProbability } : {}),
  };
}

function unavailableReason(
  output: UnknownRecord,
  series: UnknownRecord | undefined,
): string {
  const unavailable = record(first(series ?? {}, "unavailable", "error"));
  const reasonCodes = first(output, "reasonCodes", "reason_codes");
  const listedReason = Array.isArray(reasonCodes)
    ? reasonCodes.map((value) => text(value)).filter(Boolean).join(" · ")
    : undefined;
  return text(first(unavailable, "message", "reason", "code"))
    ?? listedReason
    ?? "Kronos-base가 표시 가능한 가격 분위수 경로를 반환하지 않았습니다.";
}

function candidateSeries(candidate: ForecastCandidate): UnknownRecord[] {
  const raw = record(first(candidate.output, "rawOutput", "raw_output"));
  const rawSource = Object.keys(raw).length ? raw : candidate.output;
  const response = record(first(rawSource, "response", "result", "output"));
  const responseSource = Object.keys(response).length ? response : rawSource;
  const values = first(responseSource, "raw_series", "rawSeries", "series")
    ?? first(rawSource, "raw_series", "rawSeries", "series");
  return Array.isArray(values) ? values.map(record).filter((item) => Object.keys(item).length) : [];
}

function normalizeCandidate(candidate: ForecastCandidate): AiSimulationKronosForecast[] {
  const identity = modelIdentity(candidate);
  if (!identity.recognized) return [];
  const contextSymbol = symbol(first(
    candidate.context,
    "signalSymbol",
    "signal_symbol",
    "symbol",
  )) ?? symbol(first(candidate.output, "signalSymbol", "signal_symbol"));
  const outputOrigin = timestamp(first(candidate.output, "inputEndAt", "input_end_at", "origin"));
  const generatedAt = timestamp(first(candidate.output, "generatedAt", "generated_at"));
  const seriesValues = candidateSeries(candidate);

  if (!seriesValues.length) {
    return contextSymbol ? [{
      signalSymbol: contextSymbol,
      status: "unavailable",
      ...(outputOrigin ? { origin: outputOrigin } : {}),
      ...(generatedAt ? { generatedAt } : {}),
      ...(identity.modelId ? { modelId: identity.modelId } : {}),
      ...(identity.modelRevision ? { modelRevision: identity.modelRevision } : {}),
      points: [],
      unavailableReason: unavailableReason(candidate.output, undefined),
    }] : [];
  }

  return seriesValues.flatMap((series) => {
    const signalSymbol = symbol(first(series, "instrumentKey", "instrument_key", "symbol"))
      ?? contextSymbol;
    if (!signalSymbol || (contextSymbol && signalSymbol !== contextSymbol)) return [];
    const origin = timestamp(first(series, "inputEndAt", "input_end_at", "origin"))
      ?? outputOrigin;
    const rawHorizons = first(series, "horizons");
    const points = (Array.isArray(rawHorizons) ? rawHorizons : [])
      .map((item) => normalizePoint(item, origin))
      .filter((item): item is AiSimulationKronosForecastPoint => item !== undefined)
      .sort((left, right) => (
        Date.parse(left.targetTimestamp) - Date.parse(right.targetTimestamp)
        || left.horizonMinutes - right.horizonMinutes
      ))
      .filter((point, index, values) => (
        !index
        || point.targetTimestamp !== values[index - 1]?.targetTimestamp
        || point.horizonMinutes !== values[index - 1]?.horizonMinutes
      ));
    const seriesStatus = text(first(series, "status"))?.toLowerCase();
    const outputStatus = text(first(candidate.output, "status"))?.toLowerCase();
    const available = seriesStatus === "available"
      && outputStatus !== "unavailable"
      && Boolean(origin)
      && points.length > 0;
    return [{
      signalSymbol,
      status: available ? "available" as const : "unavailable" as const,
      ...(origin ? { origin } : {}),
      ...(generatedAt ? { generatedAt } : {}),
      ...(identity.modelId ? { modelId: identity.modelId } : {}),
      ...(identity.modelRevision ? { modelRevision: identity.modelRevision } : {}),
      points: available ? points : [],
      ...(!available ? {
        unavailableReason: unavailableReason(candidate.output, series),
      } : {}),
    }];
  });
}

function forecastTimestamp(value: AiSimulationKronosForecast): number {
  return value.origin ? Date.parse(value.origin) : Number.NEGATIVE_INFINITY;
}

/**
 * Selects the newest raw Kronos-base forecast per signal symbol. It never
 * interpolates a missing horizon or derives a price from return quantiles.
 * A newer unavailable result intentionally replaces an older available one.
 */
export function selectLatestKronosForecasts(
  value: unknown,
): AiSimulationKronosForecast[] {
  const candidates: ForecastCandidate[] = [];
  collectCandidates(value, candidates);
  return mergeLatestKronosForecasts(candidates.flatMap(normalizeCandidate));
}

export function mergeLatestKronosForecasts(
  ...groups: readonly AiSimulationKronosForecast[][]
): AiSimulationKronosForecast[] {
  const normalized = groups.flatMap((group) => group);
  const selected = new Map<string, AiSimulationKronosForecast>();
  for (const forecast of normalized) {
    const current = selected.get(forecast.signalSymbol);
    const forecastOrigin = forecastTimestamp(forecast);
    const currentOrigin = current ? forecastTimestamp(current) : Number.NEGATIVE_INFINITY;
    const forecastGenerated = forecast.generatedAt
      ? Date.parse(forecast.generatedAt)
      : Number.NEGATIVE_INFINITY;
    const currentGenerated = current?.generatedAt
      ? Date.parse(current.generatedAt)
      : Number.NEGATIVE_INFINITY;
    if (
      !current
      || forecastOrigin > currentOrigin
      || (forecastOrigin === currentOrigin && forecastGenerated > currentGenerated)
      || (
        forecastOrigin === currentOrigin
        && forecastGenerated === currentGenerated
        && forecast.status === "available"
        && current.status !== "available"
      )
    ) {
      selected.set(forecast.signalSymbol, forecast);
    }
  }
  return [...selected.values()].sort((left, right) => left.signalSymbol.localeCompare(right.signalSymbol));
}

function directForecastLane(value: unknown, modelId: string | undefined): AiSimulationForecastLane | undefined {
  const normalized = text(value)?.toLowerCase().replaceAll("-", "_");
  const explicitLane = normalized === "kronos" || normalized === "kronos_base"
    ? "kronos_base"
    : normalized === "fincast"
      ? "fincast"
      : undefined;
  let modelLane: AiSimulationForecastLane | undefined;
  if (modelId?.toLowerCase() === AI_SIMULATION_KRONOS_BASE_MODEL_ID.toLowerCase()) {
    modelLane = "kronos_base";
  }
  if (modelId?.toLowerCase() === AI_SIMULATION_FINCAST_MODEL_ID.toLowerCase()) {
    modelLane = "fincast";
  }
  // A known model identity must never be relabelled as the other independent
  // lane. Unknown/versioned model IDs still require an explicit lane and are
  // retained for provenance instead of being guessed from their name.
  if (explicitLane && modelLane && explicitLane !== modelLane) return undefined;
  return explicitLane ?? modelLane;
}

function normalizeDirectModelForecast(value: unknown): AiSimulationModelForecast | undefined {
  const source = record(value);
  const signalSymbol = symbol(first(source, "signalSymbol", "signal_symbol", "symbol"));
  const modelId = text(first(source, "modelId", "model_id"));
  const lane = directForecastLane(first(source, "lane", "modelLane", "model_lane"), modelId);
  const origin = timestamp(first(source, "origin", "inputEndAt", "input_end_at"));
  const generatedAt = timestamp(first(source, "generatedAt", "generated_at"));
  const rawStatus = text(source.status)?.toLowerCase();
  const rawPoints = first(source, "points", "horizons");
  if (!signalSymbol || !lane || (rawStatus !== "available" && rawStatus !== "unavailable")) {
    return undefined;
  }
  const points = (Array.isArray(rawPoints) ? rawPoints : [])
    .map((point) => normalizePoint(point, origin))
    .filter((point): point is AiSimulationKronosForecastPoint => point !== undefined)
    .sort((left, right) => (
      Date.parse(left.targetTimestamp) - Date.parse(right.targetTimestamp)
      || left.horizonMinutes - right.horizonMinutes
    ))
    .filter((point, index, values) => (
      !index
      || point.targetTimestamp !== values[index - 1]?.targetTimestamp
      || point.horizonMinutes !== values[index - 1]?.horizonMinutes
    ));
  const available = rawStatus === "available" && Boolean(origin) && points.length > 0;
  return {
    lane,
    signalSymbol,
    status: available ? "available" : "unavailable",
    ...(origin ? { origin } : {}),
    ...(generatedAt ? { generatedAt } : {}),
    ...(modelId ? { modelId } : {}),
    ...(text(first(source, "modelRevision", "model_revision", "revision"))
      ? { modelRevision: text(first(source, "modelRevision", "model_revision", "revision")) }
      : {}),
    points: available ? points : [],
    ...(!available ? {
      unavailableReason: text(first(source, "unavailableReason", "unavailable_reason", "reason"))
        ?? "모델이 표시 가능한 가격 분위수 경로를 반환하지 않았습니다.",
    } : {}),
  };
}

/**
 * Normalizes the explicit v7 per-lane forecast projection. Legacy stock
 * artifacts continue to flow through selectLatestKronosForecasts.
 */
export function normalizeAiSimulationModelForecasts(
  value: unknown,
): AiSimulationModelForecast[] {
  return mergeLatestModelForecasts(
    (Array.isArray(value) ? value : [])
      .map(normalizeDirectModelForecast)
      .filter((forecast): forecast is AiSimulationModelForecast => forecast !== undefined),
  );
}

export function mergeLatestModelForecasts(
  ...groups: readonly AiSimulationModelForecast[][]
): AiSimulationModelForecast[] {
  const selected = new Map<string, AiSimulationModelForecast>();
  for (const forecast of groups.flatMap((group) => group)) {
    const key = `${forecast.signalSymbol}:${forecast.lane}`;
    const current = selected.get(key);
    const forecastOrigin = forecastTimestamp(forecast);
    const currentOrigin = current ? forecastTimestamp(current) : Number.NEGATIVE_INFINITY;
    const forecastGenerated = forecast.generatedAt
      ? Date.parse(forecast.generatedAt)
      : Number.NEGATIVE_INFINITY;
    const currentGenerated = current?.generatedAt
      ? Date.parse(current.generatedAt)
      : Number.NEGATIVE_INFINITY;
    if (
      !current
      || forecastOrigin > currentOrigin
      || (forecastOrigin === currentOrigin && forecastGenerated > currentGenerated)
      || (
        forecastOrigin === currentOrigin
        && forecastGenerated === currentGenerated
        && forecast.status === "available"
        && current.status !== "available"
      )
    ) {
      selected.set(key, forecast);
    }
  }
  return [...selected.values()].sort((left, right) => (
    left.signalSymbol.localeCompare(right.signalSymbol)
    || left.lane.localeCompare(right.lane)
  ));
}

/**
 * Returns only a finalized chart close whose timestamp is exactly the model
 * origin. Earlier closes and forming bars are not promoted to an origin mark.
 */
export function selectExactKronosForecastActualMark(
  forecast: AiSimulationKronosForecast,
  charts: readonly {
    symbol: string;
    bars: readonly {
      timestamp: string;
      close: number;
      status: string;
    }[];
  }[],
): AiSimulationKronosActualMark | undefined {
  if (!forecast.origin) return undefined;
  const origin = Date.parse(forecast.origin);
  if (!Number.isFinite(origin)) return undefined;
  const chart = charts.find((item) => item.symbol.toUpperCase() === forecast.signalSymbol);
  const bar = chart?.bars.find((item) => (
    item.status === "final"
    && Number.isFinite(Date.parse(item.timestamp))
    && Date.parse(item.timestamp) === origin
    && Number.isFinite(item.close)
    && item.close > 0
  ));
  return bar ? { timestamp: forecast.origin, close: bar.close } : undefined;
}

export function kronosForecastChartRows(
  forecast: AiSimulationKronosForecast,
  actualMark?: AiSimulationKronosActualMark,
): AiSimulationKronosForecastChartRow[] {
  const rows: AiSimulationKronosForecastChartRow[] = [];
  if (forecast.origin) {
    rows.push({
      timestamp: forecast.origin,
      ...(actualMark && Date.parse(actualMark.timestamp) === Date.parse(forecast.origin)
        ? { actualPrice: actualMark.close }
        : {}),
    });
  }
  if (forecast.status !== "available") return rows;
  rows.push(...forecast.points.map((point) => ({
    timestamp: point.targetTimestamp,
    q10Price: point.q10Price,
    medianPrice: point.medianPrice,
    q90Price: point.q90Price,
    predictionRange: [point.q10Price, point.q90Price] as [number, number],
    horizonMinutes: point.horizonMinutes,
    ...(point.upProbability !== undefined ? { upProbability: point.upProbability } : {}),
  })));
  return rows;
}
