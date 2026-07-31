export const AI_SIMULATION_CHRONOS2_MODEL_ID = "amazon/chronos-2" as const;
export const AI_SIMULATION_FINCAST_MODEL_ID = "Vincent05R/FinCast" as const;

export type AiSimulationForecastLane = "chronos2" | "fincast";

export type AiSimulationForecastPoint = {
  horizonMinutes: number;
  targetTimestamp: string;
  q10Price: number;
  medianPrice: number;
  q90Price: number;
  upProbability?: number;
};

export type AiSimulationModelForecast = {
  lane: AiSimulationForecastLane;
  signalSymbol: string;
  status: "available" | "unavailable";
  origin?: string;
  inputOrigin?: string;
  originPrice?: number;
  priceObservedAt?: string;
  projectionPolicy: "native_input_origin" | "live_price_rebase/v1";
  generatedAt?: string;
  modelId?: string;
  modelRevision?: string;
  points: AiSimulationForecastPoint[];
  unavailableReason?: string;
};

export type AiSimulationForecastActualMark = {
  timestamp: string;
  close: number;
};

export type AiSimulationForecastChartRow = {
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

function record(value: unknown): UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : {};
}

function text(value: unknown, maximum = 1_000): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= maximum ? normalized : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function timestamp(value: unknown): string | undefined {
  const normalized = text(value, 64);
  if (!normalized || !Number.isFinite(Date.parse(normalized))) return undefined;
  return new Date(Date.parse(normalized)).toISOString();
}

function symbol(value: unknown): string | undefined {
  const normalized = text(value, 32)?.toUpperCase();
  return normalized && /^[A-Z0-9][A-Z0-9._-]{0,31}$/.test(normalized)
    ? normalized
    : undefined;
}

function modelIdForLane(lane: AiSimulationForecastLane): string {
  return lane === "fincast"
    ? AI_SIMULATION_FINCAST_MODEL_ID
    : AI_SIMULATION_CHRONOS2_MODEL_ID;
}

function normalizePoint(value: unknown, origin?: string): AiSimulationForecastPoint | undefined {
  const source = record(value);
  const horizonMinutes = finite(source.horizonMinutes);
  const targetTimestamp = timestamp(source.targetTimestamp);
  const q10Price = finite(source.q10Price);
  const medianPrice = finite(source.medianPrice);
  const q90Price = finite(source.q90Price);
  if (
    horizonMinutes === undefined
    || !Number.isSafeInteger(horizonMinutes)
    || ![5, 15, 30, 60].includes(horizonMinutes)
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
  const upProbability = finite(source.upProbability);
  return {
    horizonMinutes,
    targetTimestamp,
    q10Price,
    medianPrice,
    q90Price,
    ...(upProbability !== undefined && upProbability >= 0 && upProbability <= 1
      ? { upProbability }
      : {}),
  };
}

function normalizeForecast(value: unknown): AiSimulationModelForecast | undefined {
  const source = record(value);
  const lane = source.lane === "fincast" || source.lane === "chronos2"
    ? source.lane
    : undefined;
  const signalSymbol = symbol(source.signalSymbol);
  const status = source.status === "available" || source.status === "unavailable"
    ? source.status
    : undefined;
  const modelId = text(source.modelId, 256);
  if (!lane || !signalSymbol || !status || (modelId && modelId !== modelIdForLane(lane))) {
    return undefined;
  }
  const origin = timestamp(source.origin);
  const points = (Array.isArray(source.points) ? source.points : [])
    .map((point) => normalizePoint(point, origin))
    .filter((point): point is AiSimulationForecastPoint => point !== undefined)
    .sort((left, right) => (
      Date.parse(left.targetTimestamp) - Date.parse(right.targetTimestamp)
      || left.horizonMinutes - right.horizonMinutes
    ))
    .filter((point, index, values) => (
      index === 0
      || point.targetTimestamp !== values[index - 1]?.targetTimestamp
      || point.horizonMinutes !== values[index - 1]?.horizonMinutes
    ));
  const available = status === "available" && Boolean(origin) && points.length > 0;
  const inputOrigin = timestamp(source.inputOrigin);
  const originPrice = finite(source.originPrice);
  const priceObservedAt = timestamp(source.priceObservedAt);
  const projectionPolicy = source.projectionPolicy === "native_input_origin"
    || source.projectionPolicy === "live_price_rebase/v1"
    ? source.projectionPolicy
    : undefined;
  if (!projectionPolicy) return undefined;
  const generatedAt = timestamp(source.generatedAt);
  const modelRevision = text(source.modelRevision, 256);
  return {
    lane,
    signalSymbol,
    status: available ? "available" : "unavailable",
    ...(origin ? { origin } : {}),
    ...(inputOrigin ? { inputOrigin } : {}),
    ...(originPrice !== undefined && originPrice > 0 ? { originPrice } : {}),
    ...(priceObservedAt ? { priceObservedAt } : {}),
    projectionPolicy,
    ...(generatedAt ? { generatedAt } : {}),
    ...(modelId ? { modelId } : {}),
    ...(modelRevision ? { modelRevision } : {}),
    points: available ? points : [],
    ...(!available ? {
      unavailableReason: text(source.unavailableReason)
        ?? "모델이 표시 가능한 가격 분위수 경로를 반환하지 않았습니다.",
    } : {}),
  };
}

export function normalizeAiSimulationModelForecasts(
  value: unknown,
): AiSimulationModelForecast[] {
  return mergeLatestModelForecasts(
    (Array.isArray(value) ? value : [])
      .map(normalizeForecast)
      .filter((forecast): forecast is AiSimulationModelForecast => forecast !== undefined),
  );
}

function forecastTimestamp(value: AiSimulationModelForecast): number {
  return value.origin ? Date.parse(value.origin) : Number.NEGATIVE_INFINITY;
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

export function selectExactModelForecastActualMark(
  forecast: AiSimulationModelForecast,
  charts: readonly {
    symbol: string;
    bars: readonly {
      timestamp: string;
      close: number;
      status: string;
    }[];
  }[],
): AiSimulationForecastActualMark | undefined {
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

export function modelForecastChartRows(
  forecast: AiSimulationModelForecast,
  actualMark?: AiSimulationForecastActualMark,
): AiSimulationForecastChartRow[] {
  const rows: AiSimulationForecastChartRow[] = [];
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
