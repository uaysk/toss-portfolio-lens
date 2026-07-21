export const SCALPING_CRITERIA = ["trading_amount", "volume", "volatility"] as const;
export const SCALPING_INTERVALS = ["1m", "5m", "15m", "30m", "60m"] as const;
export const SCALPING_PRESETS = ["trend", "breakout", "mean_reversion", "risk_management"] as const;
export const SCALPING_AI_HORIZONS = [5, 15, 30, 60] as const;
const SCALPING_INTERVAL_MINUTES = [1, 5, 15, 30, 60] as const;

export type ScalpingCriterion = typeof SCALPING_CRITERIA[number];
export type ScalpingInterval = typeof SCALPING_INTERVALS[number];
export type ScalpingIntervalMinutes = typeof SCALPING_INTERVAL_MINUTES[number];
export type ScalpingPreset = typeof SCALPING_PRESETS[number];
export type ScalpingSignalState = "watch" | "entry_candidate" | "hold" | "exit_candidate";
export type ScalpingAvailability = "available" | "partial" | "insufficient_history" | "source_unavailable" | "stale" | "unavailable" | "volume_unavailable" | "unsupported_instrument";

export type ScalpingRequest = {
  criterion: ScalpingCriterion;
  topCount: number;
  interval: ScalpingInterval;
  layoutColumns: 1 | 2 | 3 | 4;
  preset: ScalpingPreset;
  symbols?: string[];
};

export type ScalpingStatus = {
  enabled: boolean;
  message?: string;
  limits?: {
    minimumTopCount?: number;
    maximumTopCount?: number;
    maximumSubscriptions?: number;
  };
  providers: Array<{ name: string; status: string; message?: string }>;
  capabilities: string[];
  limitations: string[];
};

export type ScalpingQuality = {
  status: ScalpingAvailability;
  reasons: string[];
  missing: string[];
  sources: string[];
  observedAt?: string;
};

export type ScalpingBar = {
  timestamp: string;
  intervalMinutes?: ScalpingIntervalMinutes;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
  tradingAmount?: number;
  status: "forming" | "final" | "unknown";
  sessionVwap?: number;
  anchoredVwap?: number;
  indicatorValues: Record<string, number>;
};

export type ScalpingTradeMarker = {
  id: string;
  timestamp?: string;
  side: "buy" | "sell";
  quantity?: number;
  averagePrice?: number;
  amount?: number;
  detailLevel?: "provider_execution" | "order_average_fill";
  groupDate?: string;
  groupOrderCount?: number;
};

export type ScalpingTradeMarkerPoint = {
  marker: ScalpingTradeMarker;
  timestamp: string;
  price: number;
};

export type ScalpingLevels = {
  openingRange5?: { high: number; low: number };
  openingRange15?: { high: number; low: number };
  openingRange30?: { high: number; low: number };
  previousHigh?: number;
  previousLow?: number;
  previousClose?: number;
  dayOpen?: number;
  dayHigh?: number;
  dayLow?: number;
};

export type ScalpingOrderbook = {
  observedAt?: string;
  asks: Array<{ price: number; quantity: number }>;
  bids: Array<{ price: number; quantity: number }>;
  imbalance?: number;
};

export type ScalpingPosition = {
  quantity?: number;
  averagePrice?: number;
  evaluationAmount?: number;
  profitRate?: number;
};

export type ScalpingVolumeProfile = {
  status: "available" | "unavailable";
  pointOfControl?: number;
  valueAreaHigh?: number;
  valueAreaLow?: number;
  approximation?: string;
  buckets: Array<{ priceLow: number; priceHigh: number; volume: number }>;
  unavailableReason?: string;
};

export type ScalpingSignal = {
  state: ScalpingSignalState;
  signalAt?: string;
  calculationAt?: string;
  eligibleAt?: string;
  appliedAt?: string;
  basisPrice?: number;
  entryLow?: number;
  entryHigh?: number;
  stopPrice?: number;
  targetLow?: number;
  targetHigh?: number;
  riskReward?: number;
  indicators: string[];
  multiTimeframeAligned?: boolean;
  confidence?: number;
  quality?: ScalpingQuality;
};

export type ScalpingForecastHorizon = {
  minutes: 5 | 15 | 30 | 60;
  targetAt?: string;
  returnLow?: number;
  returnMedian?: number;
  returnHigh?: number;
  priceLow?: number;
  priceMedian?: number;
  priceHigh?: number;
  upProbability?: number;
  downProbability?: number;
  expectedVolatility?: number;
  uncertaintyWidth?: number;
  targetFirstProbabilityLow?: number;
  targetFirstProbabilityHigh?: number;
};

export type ScalpingForecast = {
  status: "available" | "unavailable";
  inputEndAt?: string;
  generatedAt?: string;
  horizons: ScalpingForecastHorizon[];
  model?: {
    id: string;
    revision: string;
    sourceRevision?: string;
    device?: string;
    dtype?: string;
    fallbackFrom?: string;
  };
  uncertainty?: string;
  distributionShift?: string;
  quality?: { status?: string; warnings: string[] };
  unavailableReason?: string;
};

export type ScalpingIndicatorSummary = {
  id: string;
  kind: string;
  status: string;
  latestAt?: string;
  values: Record<string, number>;
};

export type ScalpingCandidate = {
  symbol: string;
  name: string;
  currency: string;
  rank?: number;
  providerRanks: Record<string, number>;
  price?: number;
  changeRateRatio?: number;
  volume?: number;
  tradingAmount?: number;
  volatilityScore?: number;
  spreadBps?: number;
  executionStrength?: number;
  relativeVolume?: number;
  quality: ScalpingQuality;
  warnings: string[];
  bars: ScalpingBar[];
  levels?: ScalpingLevels;
  orderbook?: ScalpingOrderbook;
  orderbookUnavailableReason?: string;
  volumeProfile?: ScalpingVolumeProfile;
  position?: ScalpingPosition;
  tradeMarkers: ScalpingTradeMarker[];
  signal?: ScalpingSignal;
  forecast?: ScalpingForecast;
  indicators: ScalpingIndicatorSummary[];
};

export type ScalpingWorkspace = {
  generatedAt?: string;
  criterion: ScalpingCriterion;
  requestedTopCount: number;
  interval: ScalpingInterval;
  layoutColumns: 1 | 2 | 3 | 4;
  preset: ScalpingPreset;
  candidates: ScalpingCandidate[];
  quality: ScalpingQuality;
};

export type ScalpingEvaluationReceipt = {
  runId?: string;
  status?: string;
  progress?: number;
  reused: boolean;
  retrospective: true;
};

export type ScalpingEvaluationMetricGroup = {
  count: number;
  directionAccuracy?: number;
  mae?: number;
  rmse?: number;
};

export type ScalpingEvaluationMetric = {
  horizonMinutes: 5 | 15 | 30 | 60;
  overall: ScalpingEvaluationMetricGroup;
  quantileCoverage: Array<{ quantile: number; value: number }>;
  upProbabilityBrier?: number;
  targetStopFirstCount: number;
  targetStopFirstAccuracy?: number;
  calibrationBinCount: number;
  bySymbol: Record<string, ScalpingEvaluationMetricGroup>;
  byTime: Record<string, ScalpingEvaluationMetricGroup>;
  byRegime: Record<string, ScalpingEvaluationMetricGroup>;
  strategy: {
    technicalTradeCount: number;
    aiFilteredTradeCount: number;
    technicalNetReturn: number;
    aiFilteredNetReturn: number;
    technicalMaxDrawdown: number;
    aiFilteredMaxDrawdown: number;
  };
};

export type ScalpingStreamEvent = {
  type: "snapshot" | "candidate" | "bar" | "quote" | "trade" | "orderbook" | "signal" | "forecast" | "analysis" | "connection" | "recovery" | "diagnostic" | "heartbeat";
  symbol?: string;
  value?: unknown;
};

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function number(value: unknown, minimum = Number.NEGATIVE_INFINITY): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum ? value : undefined;
}

function probability(value: unknown): number | undefined {
  const candidate = number(value, 0);
  return candidate !== undefined && candidate <= 1 ? candidate : undefined;
}

function boolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function valueOf(source: UnknownRecord, ...keys: string[]): unknown {
  for (const key of keys) {
    if (source[key] !== undefined) return source[key];
  }
  return undefined;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && allowed.includes(value as T) ? value as T : fallback;
}

function timestamp(value: unknown): string | undefined {
  const candidate = string(value);
  return candidate && Number.isFinite(Date.parse(candidate)) ? candidate : undefined;
}

function intervalMinutes(value: unknown): ScalpingIntervalMinutes | undefined {
  const candidate = number(value, 1);
  return candidate !== undefined && Number.isInteger(candidate)
    && SCALPING_INTERVAL_MINUTES.includes(candidate as ScalpingIntervalMinutes)
    ? candidate as ScalpingIntervalMinutes
    : undefined;
}

function intervalToMinutes(value: ScalpingInterval): ScalpingIntervalMinutes {
  return Number(value.slice(0, -1)) as ScalpingIntervalMinutes;
}

function uniqueStrings(value: unknown): string[] {
  return Array.from(new Set(array(value).flatMap((item) => string(item) ?? [])));
}

function quality(value: unknown, fallback: ScalpingAvailability = "unavailable"): ScalpingQuality {
  const source = record(value);
  const singularReason = string(valueOf(source, "reason"));
  return {
    status: oneOf(valueOf(source, "status"), ["available", "partial", "insufficient_history", "source_unavailable", "stale", "unavailable", "volume_unavailable", "unsupported_instrument"] as const, fallback),
    reasons: Array.from(new Set([...uniqueStrings(valueOf(source, "reasons")), ...(singularReason ? [singularReason] : [])])),
    missing: uniqueStrings(valueOf(source, "missing")),
    sources: uniqueStrings(valueOf(source, "sources")),
    observedAt: timestamp(valueOf(source, "observedAt", "observed_at")),
  };
}

function normalizeBar(value: unknown): ScalpingBar | undefined {
  const source = record(value);
  const rawInterval = valueOf(source, "intervalMinutes", "interval_minutes");
  const normalizedInterval = intervalMinutes(rawInterval);
  const at = timestamp(valueOf(source, "timestamp", "closeTime", "close_time", "openTime", "open_time", "time", "at"));
  const open = number(valueOf(source, "open"), 0);
  const high = number(valueOf(source, "high"), 0);
  const low = number(valueOf(source, "low"), 0);
  const close = number(valueOf(source, "close"), 0);
  if (!at || open === undefined || high === undefined || low === undefined || close === undefined) return undefined;
  if (rawInterval !== undefined && normalizedInterval === undefined) return undefined;
  if (low > Math.min(open, close) || high < Math.max(open, close) || low > high) return undefined;
  return {
    timestamp: at,
    intervalMinutes: normalizedInterval,
    open,
    high,
    low,
    close,
    volume: number(valueOf(source, "volume"), 0),
    tradingAmount: number(valueOf(source, "tradingAmount", "trading_amount", "turnover", "amount"), 0),
    status: oneOf(valueOf(source, "status", "state"), ["forming", "final", "unknown"] as const, boolean(valueOf(source, "complete")) === true ? "final" : "unknown"),
    sessionVwap: number(valueOf(source, "sessionVwap", "session_vwap"), 0),
    anchoredVwap: number(valueOf(source, "anchoredVwap", "anchored_vwap"), 0),
    indicatorValues: {},
  };
}

function normalizeRange(value: unknown): { high: number; low: number } | undefined {
  const source = record(value);
  const high = number(valueOf(source, "high"), 0);
  const low = number(valueOf(source, "low"), 0);
  return high !== undefined && low !== undefined && high >= low ? { high, low } : undefined;
}

function normalizeLevels(value: unknown): ScalpingLevels | undefined {
  const source = record(value);
  if (!Object.keys(source).length) return undefined;
  const result: ScalpingLevels = {
    openingRange5: normalizeRange(valueOf(source, "openingRange5", "opening_range_5")),
    openingRange15: normalizeRange(valueOf(source, "openingRange15", "opening_range_15")),
    openingRange30: normalizeRange(valueOf(source, "openingRange30", "opening_range_30")),
    previousHigh: number(valueOf(source, "previousHigh", "previous_high"), 0),
    previousLow: number(valueOf(source, "previousLow", "previous_low"), 0),
    previousClose: number(valueOf(source, "previousClose", "previous_close"), 0),
    dayOpen: number(valueOf(source, "dayOpen", "day_open"), 0),
    dayHigh: number(valueOf(source, "dayHigh", "day_high"), 0),
    dayLow: number(valueOf(source, "dayLow", "day_low"), 0),
  };
  return Object.values(result).some((item) => item !== undefined) ? result : undefined;
}

function normalizeOrderbook(value: unknown): ScalpingOrderbook | undefined {
  const source = record(value);
  const level = (item: unknown) => {
    const candidate = record(item);
    const price = number(valueOf(candidate, "price"), 0);
    const quantity = number(valueOf(candidate, "quantity", "volume"), 0);
    return price !== undefined && quantity !== undefined ? { price, quantity } : undefined;
  };
  const asks = array(valueOf(source, "asks")).flatMap((item) => level(item) ?? []);
  const bids = array(valueOf(source, "bids")).flatMap((item) => level(item) ?? []);
  if (!asks.length || !bids.length) return undefined;
  return {
    asks,
    bids,
    observedAt: timestamp(valueOf(source, "observedAt", "observed_at")),
    imbalance: number(valueOf(source, "imbalance", "orderbookImbalance", "orderbook_imbalance")),
  };
}

function normalizePosition(value: unknown): ScalpingPosition | undefined {
  const source = record(value);
  if (!Object.keys(source).length) return undefined;
  const result: ScalpingPosition = {
    quantity: number(valueOf(source, "quantity"), 0),
    averagePrice: number(valueOf(source, "averagePrice", "average_price"), 0),
    evaluationAmount: number(valueOf(source, "evaluationAmount", "evaluation_amount"), 0),
    profitRate: number(valueOf(source, "profitRate", "profit_rate")),
  };
  return Object.values(result).some((item) => item !== undefined) ? result : undefined;
}

function normalizeVolumeProfile(value: unknown): ScalpingVolumeProfile | undefined {
  const wrapper = record(value);
  if (!Object.keys(wrapper).length) return undefined;
  const nested = record(valueOf(wrapper, "profile"));
  const source = Object.keys(nested).length ? nested : wrapper;
  const availability = record(valueOf(wrapper, "availability"));
  const rawStatus = valueOf(source, "status") ?? valueOf(availability, "status");
  const rawBuckets = array(valueOf(source, "buckets"));
  const status = rawStatus === "available" || (rawStatus === undefined && rawBuckets.length > 0) ? "available" : "unavailable";
  const buckets = rawBuckets.flatMap((item) => {
    const bucket = record(item);
    const priceLow = number(valueOf(bucket, "priceLow", "price_low", "low"), 0);
    const priceHigh = number(valueOf(bucket, "priceHigh", "price_high", "high"), 0);
    const volume = number(valueOf(bucket, "volume"), 0);
    return priceLow !== undefined && priceHigh !== undefined && priceHigh >= priceLow && volume !== undefined
      ? [{ priceLow, priceHigh, volume }] : [];
  });
  const unavailable = record(valueOf(source, "unavailable", "error"));
  return {
    status,
    pointOfControl: number(valueOf(source, "pointOfControl", "point_of_control", "poc"), 0),
    valueAreaHigh: number(valueOf(source, "valueAreaHigh", "value_area_high", "vah"), 0),
    valueAreaLow: number(valueOf(source, "valueAreaLow", "value_area_low", "val"), 0),
    approximation: string(valueOf(source, "approximation", "method")),
    buckets: status === "available" ? buckets : [],
    unavailableReason: string(valueOf(unavailable, "message", "reason"))
      ?? string(valueOf(availability, "reason"))
      ?? string(valueOf(source, "unavailableReason", "unavailable_reason")),
  };
}

function normalizeTradeMarkers(value: unknown, index: number): ScalpingTradeMarker[] {
  const source = record(value);
  const rawSide = valueOf(source, "side");
  if (rawSide !== "buy" && rawSide !== "sell") return [];
  const side = rawSide;
  const groupId = string(valueOf(source, "id", "eventId", "event_id")) ?? `trade-group:${index}`;
  const groupDate = string(valueOf(source, "date"));
  const groupOrderCount = number(valueOf(source, "orderCount", "order_count"), 1);
  const details = array(valueOf(source, "details"));
  if (details.length) {
    return details.flatMap((item, detailIndex) => {
      const detail = record(item);
      // The portfolio store persists one average fill per order, not every
      // execution. Never substitute ordered_at when the actual filled_at is
      // unavailable and never present the daily aggregate's first order time
      // as the whole group's execution time.
      const at = timestamp(valueOf(detail, "filled_at", "filledAt"));
      const averagePrice = number(valueOf(detail, "average_filled_price", "averageFilledPrice", "price"), 0);
      return [{
        id: `${groupId}:${string(valueOf(detail, "order_id", "orderId")) ?? detailIndex}`,
        ...(at ? { timestamp: at } : {}),
        side,
        quantity: number(valueOf(detail, "filled_quantity", "filledQuantity", "quantity"), 0),
        ...(averagePrice !== undefined && averagePrice > 0 ? { averagePrice } : {}),
        amount: number(valueOf(detail, "filled_amount", "filledAmount", "amount"), 0),
        detailLevel: "order_average_fill" as const,
        ...(groupDate ? { groupDate } : {}),
        ...(groupOrderCount === undefined ? {} : { groupOrderCount }),
      }];
    });
  }
  const at = timestamp(valueOf(source, "timestamp", "executedAt", "executed_at", "at"));
  const averagePrice = number(valueOf(source, "averagePrice", "average_price", "average_filled_price", "price"), 0);
  return [{
    id: groupId === `trade-group:${index}` ? `${at ?? "time-unavailable"}:${side}:${index}` : groupId,
    ...(at ? { timestamp: at } : {}),
    side,
    quantity: number(valueOf(source, "quantity", "filledQuantity", "filled_quantity"), 0),
    ...(averagePrice !== undefined && averagePrice > 0 ? { averagePrice } : {}),
    amount: number(valueOf(source, "amount", "filledAmount", "filled_amount"), 0),
    detailLevel: "provider_execution",
  }];
}

function normalizeSignal(value: unknown): ScalpingSignal | undefined {
  const source = record(value);
  const rawState = valueOf(source, "state", "status");
  if (typeof rawState !== "string" || !(["watch", "entry_candidate", "hold", "exit_candidate"] as string[]).includes(rawState)) return undefined;
  return {
    state: rawState as ScalpingSignalState,
    signalAt: timestamp(valueOf(source, "signalAt", "signal_at", "signalTimestamp", "signal_timestamp")),
    calculationAt: timestamp(valueOf(source, "calculationAt", "calculation_at", "calculationTimestamp", "calculation_timestamp")),
    eligibleAt: timestamp(valueOf(source, "eligibleAt", "eligible_at", "plannedAt", "planned_at", "earliestEligibleTimestamp", "earliest_eligible_timestamp")),
    appliedAt: timestamp(valueOf(source, "appliedAt", "applied_at")),
    basisPrice: number(valueOf(source, "basisPrice", "basis_price"), 0),
    entryLow: number(valueOf(source, "entryLow", "entry_low"), 0)
      ?? number(valueOf(record(valueOf(source, "expectedEntryRange", "expected_entry_range")), "low"), 0),
    entryHigh: number(valueOf(source, "entryHigh", "entry_high"), 0)
      ?? number(valueOf(record(valueOf(source, "expectedEntryRange", "expected_entry_range")), "high"), 0),
    stopPrice: number(valueOf(source, "stopPrice", "stop_price", "stopCandidatePrice", "stop_candidate_price"), 0),
    targetLow: number(valueOf(source, "targetLow", "target_low"), 0)
      ?? number(valueOf(record(valueOf(source, "targetPriceRange", "target_price_range")), "low"), 0),
    targetHigh: number(valueOf(source, "targetHigh", "target_high"), 0)
      ?? number(valueOf(record(valueOf(source, "targetPriceRange", "target_price_range")), "high"), 0),
    riskReward: number(valueOf(source, "riskReward", "risk_reward", "expectedRewardRiskRatio", "expected_reward_risk_ratio"), 0),
    indicators: uniqueStrings(valueOf(source, "indicators", "indicatorKinds", "indicator_kinds")),
    multiTimeframeAligned: boolean(valueOf(source, "multiTimeframeAligned", "multi_timeframe_aligned"))
      ?? (string(valueOf(source, "multiTimeframeAgreement", "multi_timeframe_agreement"))?.startsWith("aligned_")
        ? true
        : string(valueOf(source, "multiTimeframeAgreement", "multi_timeframe_agreement")) ? false : undefined),
    confidence: probability(valueOf(source, "confidence")),
    quality: Object.keys(record(valueOf(source, "quality", "dataQuality", "data_quality"))).length
      ? quality(valueOf(source, "quality", "dataQuality", "data_quality")) : undefined,
  };
}

function quantile(items: unknown, target: number, minimum = Number.NEGATIVE_INFINITY): number | undefined {
  const match = array(items).map(record).find((item) => number(valueOf(item, "quantile")) === target);
  return match ? number(valueOf(match, "value"), minimum) : undefined;
}

function normalizeForecast(value: unknown, parentModel?: unknown, generatedAt?: unknown): ScalpingForecast | undefined {
  const wrapper = record(value);
  if (!Object.keys(wrapper).length) return undefined;
  const payload = record(valueOf(wrapper, "payload"));
  const nested = record(valueOf(payload, "forecast", "prediction"));
  const source = Object.keys(nested).length ? { ...wrapper, ...nested } : wrapper;
  const rawStatus = valueOf(wrapper, "status") ?? valueOf(source, "status");
  const status = rawStatus === "available" ? "available" : "unavailable";
  const modelSource = record(valueOf(source, "model"));
  const payloadModel = record(valueOf(payload, "model"));
  const sharedModel = Object.keys(modelSource).length ? modelSource : Object.keys(payloadModel).length ? payloadModel : record(parentModel);
  const modelId = string(valueOf(sharedModel, "id", "modelId", "model_id")) ?? string(valueOf(wrapper, "modelName", "model_name"));
  const modelRevision = string(valueOf(sharedModel, "revision", "modelRevision", "model_revision")) ?? string(valueOf(wrapper, "modelVersion", "model_version"));
  const inputQuality = record(valueOf(source, "inputQuality", "input_quality", "quality"));
  const distribution = record(valueOf(source, "distributionShift", "distribution_shift"));
  const unavailable = record(valueOf(source, "unavailable", "error"));
  const horizons = array(valueOf(source, "horizons")).flatMap((item): ScalpingForecastHorizon[] => {
    const horizon = record(item);
    const minutes = number(valueOf(horizon, "minutes", "horizonMinutes", "horizon_minutes"));
    if (!SCALPING_AI_HORIZONS.includes(minutes as typeof SCALPING_AI_HORIZONS[number])) return [];
    const returns = valueOf(horizon, "returnQuantiles", "return_quantiles");
    const prices = valueOf(horizon, "priceQuantiles", "price_quantiles");
    const targetStop = record(valueOf(horizon, "targetStop", "target_stop"));
    return [{
      minutes: minutes as ScalpingForecastHorizon["minutes"],
      targetAt: timestamp(valueOf(horizon, "targetAt", "target_at", "targetTimestamp", "target_timestamp")),
      returnLow: number(valueOf(horizon, "returnLow", "return_low")) ?? quantile(returns, 0.1),
      returnMedian: number(valueOf(horizon, "returnMedian", "return_median")) ?? quantile(returns, 0.5),
      returnHigh: number(valueOf(horizon, "returnHigh", "return_high")) ?? quantile(returns, 0.9),
      priceLow: number(valueOf(horizon, "priceLow", "price_low"), 0) ?? quantile(prices, 0.1, 0),
      priceMedian: number(valueOf(horizon, "priceMedian", "price_median"), 0) ?? quantile(prices, 0.5, 0),
      priceHigh: number(valueOf(horizon, "priceHigh", "price_high"), 0) ?? quantile(prices, 0.9, 0),
      upProbability: probability(valueOf(horizon, "upProbability", "up_probability")),
      downProbability: probability(valueOf(horizon, "downProbability", "down_probability")),
      expectedVolatility: number(valueOf(horizon, "expectedVolatility", "expected_volatility"), 0),
      uncertaintyWidth: number(valueOf(horizon, "uncertaintyWidth", "uncertainty_width", "uncertaintyIntervalWidth", "uncertainty_interval_width"), 0),
      targetFirstProbabilityLow: probability(valueOf(targetStop, "targetFirstProbabilityLower", "target_first_probability_lower")),
      targetFirstProbabilityHigh: probability(valueOf(targetStop, "targetFirstProbabilityUpper", "target_first_probability_upper")),
    }];
  });
  const completeHorizons = SCALPING_AI_HORIZONS.every((minutes) => horizons.some((horizon) => horizon.minutes === minutes));
  const normalizedStatus = status === "available" && completeHorizons ? "available" : "unavailable";
  return {
    status: normalizedStatus,
    inputEndAt: timestamp(valueOf(source, "inputEndAt", "input_end_at", "inputEndedAt", "input_ended_at")),
    generatedAt: timestamp(valueOf(source, "generatedAt", "generated_at")) ?? timestamp(valueOf(wrapper, "generatedAt", "generated_at")) ?? timestamp(generatedAt),
    horizons: normalizedStatus === "available" ? horizons : [],
    model: modelId && modelRevision ? {
      id: modelId,
      revision: modelRevision,
      sourceRevision: string(valueOf(sharedModel, "sourceRevision", "source_revision")),
      device: string(valueOf(sharedModel, "device")),
      dtype: string(valueOf(sharedModel, "dtype")),
      fallbackFrom: string(valueOf(sharedModel, "fallbackFrom", "fallback_from")),
    } : undefined,
    uncertainty: string(valueOf(source, "uncertainty")),
    distributionShift: string(valueOf(distribution, "status", "reason")),
    quality: Object.keys(inputQuality).length ? {
      status: string(valueOf(inputQuality, "status")),
      warnings: uniqueStrings(valueOf(inputQuality, "warnings")),
    } : undefined,
    unavailableReason: string(valueOf(unavailable, "message", "reason"))
      ?? string(valueOf(source, "unavailableReason", "unavailable_reason", "reason", "code"))
      ?? (status === "available" && !completeHorizons ? "5·15·30·60분 예측 결과가 완전하지 않습니다." : undefined),
  };
}

function metricPoints(value: unknown): UnknownRecord[] {
  const source = record(value);
  const points = array(valueOf(source, "points")).map(record);
  if (points.length) return points;
  const latest = record(valueOf(source, "latest"));
  return Object.keys(latest).length ? [latest] : [];
}

function metricLatestValues(value: unknown): UnknownRecord {
  return record(valueOf(metricPoints(value).at(-1) ?? {}, "values"));
}

function normalizeTechnical(value: unknown, inputBars: ScalpingBar[]): {
  bars: ScalpingBar[];
  levels?: ScalpingLevels;
  relativeVolume?: number;
  executionStrength?: number;
  orderbookImbalance?: number;
  signal?: ScalpingSignal;
  volumeProfile?: ScalpingVolumeProfile;
  indicators: ScalpingIndicatorSummary[];
  quality?: ScalpingQuality;
} {
  const technical = record(value);
  const intraday = record(valueOf(technical, "intraday"));
  const bars = inputBars.map((bar) => ({ ...bar, indicatorValues: { ...bar.indicatorValues } }));
  const byTimestamp = new Map(bars.map((bar) => [bar.timestamp, bar]));
  const applyMetric = (seriesName: string, valueName: string, target: "sessionVwap" | "anchoredVwap") => {
    for (const point of metricPoints(valueOf(intraday, seriesName))) {
      const at = timestamp(valueOf(point, "timestamp"));
      const metricValue = number(valueOf(record(valueOf(point, "values")), valueName), 0);
      const bar = at ? byTimestamp.get(at) : undefined;
      if (bar && metricValue !== undefined) bar[target] = metricValue;
    }
  };
  applyMetric("session_vwap", "session_vwap", "sessionVwap");
  applyMetric("anchored_vwap", "anchored_vwap", "anchoredVwap");

  const indicators = array(valueOf(technical, "indicators")).flatMap((item): ScalpingIndicatorSummary[] => {
    const indicator = record(item);
    const id = string(valueOf(indicator, "id", "indicatorId", "indicator_id"));
    const kind = string(valueOf(indicator, "kind"));
    if (!id || !kind) return [];
    const points = metricPoints(indicator);
    for (const point of points) {
      const at = timestamp(valueOf(point, "timestamp"));
      const bar = at ? byTimestamp.get(at) : undefined;
      if (!bar) continue;
      for (const [field, raw] of Object.entries(record(valueOf(point, "values")))) {
        const metricValue = number(raw);
        if (metricValue !== undefined) bar.indicatorValues[`${id}:${field}`] = metricValue;
      }
    }
    const latest = points.at(-1);
    const values = Object.fromEntries(Object.entries(record(valueOf(latest ?? {}, "values"))).flatMap(([field, raw]) => {
      const metricValue = number(raw);
      return metricValue === undefined ? [] : [[field, metricValue]];
    }));
    const availability = record(valueOf(indicator, "availability"));
    return [{
      id,
      kind,
      status: string(valueOf(availability, "status")) ?? "unavailable",
      latestAt: timestamp(valueOf(latest ?? {}, "timestamp")),
      values,
    }];
  });

  const opening5 = metricLatestValues(valueOf(intraday, "opening_range_5"));
  const opening15 = metricLatestValues(valueOf(intraday, "opening_range_15"));
  const opening30 = metricLatestValues(valueOf(intraday, "opening_range_30"));
  const previous = metricLatestValues(valueOf(intraday, "previous_session_levels"));
  const current = metricLatestValues(valueOf(intraday, "current_session_levels"));
  const range = (source: UnknownRecord) => {
    const high = number(valueOf(source, "high"), 0);
    const low = number(valueOf(source, "low"), 0);
    return high !== undefined && low !== undefined && high >= low ? { high, low } : undefined;
  };
  const levels: ScalpingLevels = {
    openingRange5: range(opening5),
    openingRange15: range(opening15),
    openingRange30: range(opening30),
    previousHigh: number(valueOf(previous, "previous_high"), 0),
    previousLow: number(valueOf(previous, "previous_low"), 0),
    previousClose: number(valueOf(previous, "previous_close"), 0),
    dayOpen: number(valueOf(current, "session_open"), 0),
    dayHigh: number(valueOf(current, "session_high"), 0),
    dayLow: number(valueOf(current, "session_low"), 0),
  };
  const relative = metricLatestValues(valueOf(intraday, "time_of_day_relative_volume"));
  const orderbookMetric = record(valueOf(intraday, "orderbook_imbalance"));
  const executionMetric = record(valueOf(intraday, "execution_strength"));
  const signalSeries = record(valueOf(technical, "signals"));
  const volumeOutput = record(valueOf(technical, "volume_profile"));
  return {
    bars,
    levels: Object.values(levels).some((item) => item !== undefined) ? levels : undefined,
    relativeVolume: number(valueOf(relative, "relative_volume"), 0),
    executionStrength: number(valueOf(record(valueOf(executionMetric, "values")), "execution_strength_percent"), 0),
    orderbookImbalance: number(valueOf(record(valueOf(orderbookMetric, "values")), "orderbook_imbalance")),
    signal: normalizeSignal(valueOf(signalSeries, "latest") ?? metricPoints(signalSeries).at(-1)),
    volumeProfile: normalizeVolumeProfile(volumeOutput),
    indicators,
    quality: Object.keys(record(valueOf(technical, "data_quality"))).length
      ? quality(valueOf(technical, "data_quality"), "partial") : undefined,
  };
}

function normalizeCandidate(value: unknown, instrumentValue?: unknown): ScalpingCandidate | undefined {
  const source = record(value);
  const instrument = record(instrumentValue);
  const metadata = record(valueOf(instrument, "metadata"));
  const symbol = string(valueOf(source, "symbol", "instrumentKey", "instrument_key"))
    ?? string(valueOf(instrument, "symbol", "instrumentKey", "instrument_key"));
  if (!symbol || !/^[A-Za-z0-9._-]{1,32}$/.test(symbol)) return undefined;
  const ranksSource = record(valueOf(source, "providerRanks", "provider_ranks"));
  const providerRanks = Object.fromEntries(Object.entries(ranksSource).flatMap(([key, item]) => {
    const rank = number(item, 1);
    return rank !== undefined && Number.isInteger(rank) ? [[key, rank]] : [];
  }));
  const rank = number(valueOf(source, "rank"), 1)
    ?? (Object.values(providerRanks).length ? Math.min(...Object.values(providerRanks)) : undefined);
  const nestedPriceSeries = record(valueOf(instrument, "priceSeries", "price_series"));
  const bars = array(valueOf(instrument, "bars", "candles"))
    .concat(array(valueOf(nestedPriceSeries, "bars", "candles")))
    .concat(array(valueOf(source, "bars", "priceSeries", "price_series", "candles")))
    .flatMap((item) => normalizeBar(item) ?? [])
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  const dedupedBars = Array.from(new Map(bars.map((bar) => [bar.timestamp, bar])).values());
  const warnings = array(valueOf(source, "warnings")).flatMap((item) => {
    const warning = record(item);
    return string(item) ?? string(valueOf(warning, "message", "code")) ?? [];
  });
  const rawOrderbook = valueOf(instrument, "orderbook", "book") ?? valueOf(source, "orderbook", "book");
  const realtime = record(valueOf(instrument, "realtime"));
  const technical = normalizeTechnical(valueOf(instrument, "technical", "analysis"), dedupedBars);
  const realtimeOrderbook = valueOf(realtime, "orderbook", "book");
  const realtimeTrade = record(valueOf(realtime, "trade"));
  const orderbookStatus = record(valueOf(instrument, "orderbookStatus", "orderbook_status"));
  const historicalOrderbook = record(valueOf(realtime, "historicalOrderbook", "historical_orderbook"));
  const normalizedBook = normalizeOrderbook(realtimeOrderbook ?? rawOrderbook);
  if (normalizedBook && technical.orderbookImbalance !== undefined) normalizedBook.imbalance = technical.orderbookImbalance;
  const scannerQuality = quality(valueOf(instrument, "quality", "dataQuality", "data_quality")
    ?? valueOf(source, "quality", "dataQuality", "data_quality"), "partial");
  const combinedQuality = technical.quality ? {
    status: technical.quality.status,
    reasons: Array.from(new Set([...scannerQuality.reasons, ...technical.quality.reasons])),
    missing: Array.from(new Set([...scannerQuality.missing, ...technical.quality.missing])),
    sources: scannerQuality.sources,
    observedAt: scannerQuality.observedAt,
  } : scannerQuality;
  return {
    symbol: symbol.toUpperCase(),
    name: string(valueOf(source, "name")) ?? string(valueOf(instrument, "name")) ?? string(valueOf(metadata, "name")) ?? symbol.toUpperCase(),
    currency: string(valueOf(source, "currency")) ?? string(valueOf(instrument, "currency")) ?? string(valueOf(metadata, "currency")) ?? "KRW",
    rank,
    providerRanks,
    price: number(valueOf(source, "price", "currentPrice", "current_price"), 0) ?? number(valueOf(instrument, "price", "currentPrice", "current_price"), 0),
    changeRateRatio: number(valueOf(source, "changeRateRatio", "change_rate_ratio")),
    volume: number(valueOf(source, "volume"), 0),
    tradingAmount: number(valueOf(source, "tradingAmount", "trading_amount"), 0),
    volatilityScore: number(valueOf(source, "volatilityScore", "volatility_score"), 0),
    spreadBps: number(valueOf(source, "spreadBps", "spread_bps"), 0) ?? number(valueOf(instrument, "spreadBps", "spread_bps"), 0),
    executionStrength: technical.executionStrength
      ?? number(valueOf(realtimeTrade, "executionStrength", "execution_strength"), 0)
      ?? number(valueOf(instrument, "executionStrength", "execution_strength"), 0)
      ?? number(valueOf(source, "executionStrength", "execution_strength"), 0),
    relativeVolume: technical.relativeVolume
      ?? number(valueOf(instrument, "relativeVolume", "relative_volume"), 0)
      ?? number(valueOf(source, "relativeVolume", "relative_volume"), 0),
    quality: combinedQuality,
    warnings,
    bars: technical.bars,
    levels: technical.levels ?? normalizeLevels(valueOf(instrument, "levels", "sessionLevels", "session_levels") ?? valueOf(source, "levels")),
    orderbook: normalizedBook,
    orderbookUnavailableReason: string(valueOf(orderbookStatus, "reason", "message"))
      ?? string(valueOf(historicalOrderbook, "reason", "message"))
      ?? string(valueOf(instrument, "orderbookUnavailableReason", "orderbook_unavailable_reason")),
    volumeProfile: technical.volumeProfile
      ?? normalizeVolumeProfile(valueOf(instrument, "volumeProfile", "volume_profile") ?? valueOf(source, "volumeProfile", "volume_profile")),
    position: normalizePosition(valueOf(instrument, "position") ?? valueOf(source, "position")),
    tradeMarkers: array(valueOf(instrument, "tradeMarkers", "trade_markers", "trades"))
      .concat(array(valueOf(source, "tradeMarkers", "trade_markers")))
      .flatMap((item, index) => normalizeTradeMarkers(item, index)),
    signal: technical.signal ?? normalizeSignal(valueOf(instrument, "signal") ?? valueOf(source, "signal")),
    forecast: normalizeForecast(valueOf(instrument, "forecast", "prediction") ?? valueOf(source, "forecast", "prediction")),
    indicators: technical.indicators,
  };
}

export function normalizeScalpingStatus(value: unknown): ScalpingStatus {
  const outer = record(value);
  const result = record(valueOf(outer, "result"));
  const source = Object.keys(record(valueOf(outer, "status"))).length ? record(valueOf(outer, "status"))
    : Object.keys(record(valueOf(result, "status"))).length ? record(valueOf(result, "status"))
      : Object.keys(result).length ? result : outer;
  const rawProviders = valueOf(source, "providers");
  const providers = Array.isArray(rawProviders)
    ? rawProviders.flatMap((item) => {
      const provider = record(item);
      const name = string(valueOf(provider, "name", "provider"));
      const status = string(valueOf(provider, "status"));
      return name && status ? [{ name, status, message: string(valueOf(provider, "message", "reason")) }] : [];
    })
    : Object.entries(record(rawProviders)).map(([name, item]) => {
      const provider = record(item);
      const websocket = record(valueOf(provider, "websocket"));
      const configured = boolean(valueOf(provider, "configured"));
      return {
        name,
        status: string(valueOf(provider, "status")) ?? string(valueOf(websocket, "connection"))
          ?? string(item) ?? (configured === true ? "configured" : configured === false ? "unavailable" : "unknown"),
        message: string(valueOf(provider, "message", "reason")),
      };
    });
  const limits = record(valueOf(source, "limits"));
  const topCount = record(valueOf(limits, "topCount", "top_count"));
  const capabilitiesValue = valueOf(source, "capabilities");
  const capabilities = Array.isArray(capabilitiesValue) ? uniqueStrings(capabilitiesValue)
    : Object.entries(record(capabilitiesValue)).map(([name, enabled]) => `${name}:${String(enabled)}`);
  return {
    enabled: boolean(valueOf(source, "enabled")) === true,
    message: string(valueOf(source, "message", "reason")),
    limits: Object.keys(limits).length ? {
      minimumTopCount: number(valueOf(limits, "minimumTopCount", "minimum_top_count"), 1) ?? number(valueOf(topCount, "minimum"), 1),
      maximumTopCount: number(valueOf(limits, "maximumTopCount", "maximum_top_count"), 1) ?? number(valueOf(topCount, "maximum"), 1),
      maximumSubscriptions: number(valueOf(limits, "maximumSubscriptions", "maximum_subscriptions"), 1),
    } : undefined,
    providers,
    capabilities,
    limitations: uniqueStrings(valueOf(source, "limitations")),
  };
}

export function normalizeScalpingWorkspace(value: unknown, request: ScalpingRequest): ScalpingWorkspace {
  const outer = record(value);
  const result = record(valueOf(outer, "result"));
  const workspace = Object.keys(record(valueOf(outer, "workspace"))).length
    ? record(valueOf(outer, "workspace"))
    : Object.keys(record(valueOf(result, "workspace"))).length ? record(valueOf(result, "workspace")) : outer;
  const rawCandidates = array(valueOf(workspace, "candidates"));
  const instruments = array(valueOf(workspace, "instruments"));
  const instrumentBySymbol = new Map(instruments.flatMap((item) => {
    const instrument = record(item);
    const symbol = string(valueOf(instrument, "symbol", "instrumentKey", "instrument_key"));
    return symbol ? [[symbol.toUpperCase(), item] as const] : [];
  }));
  const candidates = rawCandidates.flatMap((item) => {
    const candidate = record(item);
    const symbol = string(valueOf(candidate, "symbol", "instrumentKey", "instrument_key"));
    return normalizeCandidate(item, symbol ? instrumentBySymbol.get(symbol.toUpperCase()) : undefined) ?? [];
  });
  if (!candidates.length && instruments.length) {
    for (const item of instruments) {
      const candidate = normalizeCandidate(item, item);
      if (candidate) candidates.push(candidate);
    }
  }
  const rawColumns = number(valueOf(workspace, "layoutColumns", "layout_columns"), 1);
  const layoutColumns = rawColumns !== undefined && Number.isInteger(rawColumns) && rawColumns >= 1 && rawColumns <= 4
    ? rawColumns as 1 | 2 | 3 | 4
    : request.layoutColumns;
  return {
    generatedAt: timestamp(valueOf(workspace, "generatedAt", "generated_at")),
    criterion: oneOf(valueOf(workspace, "criterion"), SCALPING_CRITERIA, request.criterion),
    requestedTopCount: number(valueOf(workspace, "requestedTopCount", "requested_top_count"), 1) ?? request.topCount,
    interval: oneOf(valueOf(workspace, "interval"), SCALPING_INTERVALS, request.interval),
    layoutColumns,
    preset: oneOf(valueOf(workspace, "preset"), SCALPING_PRESETS, request.preset),
    candidates,
    quality: quality(valueOf(workspace, "quality"), candidates.length ? "partial" : "source_unavailable"),
  };
}

export function normalizeScalpingForecasts(value: unknown): Map<string, ScalpingForecast> {
  const outer = record(value);
  const forecast = Object.keys(record(valueOf(outer, "forecast"))).length ? record(valueOf(outer, "forecast")) : outer;
  const predictions = array(valueOf(outer, "predictions")).length
    ? array(valueOf(outer, "predictions"))
    : array(valueOf(forecast, "predictions", "series"));
  const model = valueOf(forecast, "model") ?? valueOf(outer, "model");
  const generatedAt = valueOf(forecast, "generatedAt", "generated_at") ?? valueOf(outer, "generatedAt", "generated_at");
  const result = new Map<string, ScalpingForecast>();
  for (const item of predictions) {
    const source = record(item);
    const symbol = string(valueOf(source, "symbol", "instrumentKey", "instrument_key"));
    const normalized = normalizeForecast(item, model, generatedAt);
    if (symbol && normalized) result.set(symbol.toUpperCase(), normalized);
  }
  return result;
}

export function normalizeScalpingEvaluationReceipt(value: unknown): ScalpingEvaluationReceipt {
  const outer = record(value);
  const run = record(valueOf(outer, "run"));
  return {
    runId: string(valueOf(run, "id", "runId", "run_id")) ?? string(valueOf(outer, "runId", "run_id")),
    status: string(valueOf(run, "status")) ?? string(valueOf(outer, "status")),
    progress: probability(valueOf(run, "progress") ?? valueOf(outer, "progress")),
    reused: boolean(valueOf(outer, "reused")) === true,
    retrospective: true,
  };
}

function evaluationMetricGroup(value: unknown): ScalpingEvaluationMetricGroup {
  const source = record(value);
  const rawCount = number(valueOf(source, "count"), 0);
  return {
    count: rawCount !== undefined && Number.isInteger(rawCount) ? rawCount : 0,
    directionAccuracy: probability(valueOf(source, "directionAccuracy", "direction_accuracy")),
    mae: number(valueOf(source, "mae"), 0),
    rmse: number(valueOf(source, "rmse"), 0),
  };
}

function evaluationMetricGroups(value: unknown): Record<string, ScalpingEvaluationMetricGroup> {
  return Object.fromEntries(Object.entries(record(value)).map(([key, item]) => [key, evaluationMetricGroup(item)]));
}

export function normalizeScalpingEvaluationMetrics(value: unknown): ScalpingEvaluationMetric[] {
  const outer = record(value);
  const content = valueOf(outer, "content", "data") ?? value;
  return array(content).flatMap((item) => {
    const source = record(item);
    const horizon = number(valueOf(source, "horizonMinutes", "horizon_minutes"), 1);
    if (horizon !== 5 && horizon !== 15 && horizon !== 30 && horizon !== 60) return [];
    const horizonMinutes = horizon as ScalpingEvaluationMetric["horizonMinutes"];
    const strategy = record(valueOf(source, "strategyComparison", "strategy_comparison"));
    const integer = (candidate: unknown) => {
      const parsed = number(candidate, 0);
      return parsed !== undefined && Number.isInteger(parsed) ? parsed : 0;
    };
    const finiteOrZero = (candidate: unknown, minimum = Number.NEGATIVE_INFINITY) => number(candidate, minimum) ?? 0;
    return [{
      horizonMinutes,
      overall: evaluationMetricGroup(valueOf(source, "overall")),
      quantileCoverage: array(valueOf(source, "quantileCoverage", "quantile_coverage")).flatMap((entry) => {
        const point = record(entry);
        const quantile = probability(valueOf(point, "quantile"));
        const coverage = probability(valueOf(point, "value", "coverage"));
        return quantile === undefined || coverage === undefined ? [] : [{ quantile, value: coverage }];
      }),
      upProbabilityBrier: number(valueOf(source, "upProbabilityBrier", "up_probability_brier"), 0),
      targetStopFirstCount: integer(valueOf(source, "targetStopFirstCount", "target_stop_first_count")),
      targetStopFirstAccuracy: probability(valueOf(source, "targetStopFirstAccuracy", "target_stop_first_accuracy")),
      calibrationBinCount: array(valueOf(source, "calibration")).length,
      bySymbol: evaluationMetricGroups(valueOf(source, "bySymbol", "by_symbol")),
      byTime: evaluationMetricGroups(valueOf(source, "byTime", "by_time")),
      byRegime: evaluationMetricGroups(valueOf(source, "byRegime", "by_regime")),
      strategy: {
        technicalTradeCount: integer(valueOf(strategy, "technicalTradeCount", "technical_trade_count")),
        aiFilteredTradeCount: integer(valueOf(strategy, "aiFilteredTradeCount", "ai_filtered_trade_count")),
        technicalNetReturn: finiteOrZero(valueOf(strategy, "technicalNetReturn", "technical_net_return")),
        aiFilteredNetReturn: finiteOrZero(valueOf(strategy, "aiFilteredNetReturn", "ai_filtered_net_return")),
        technicalMaxDrawdown: finiteOrZero(valueOf(strategy, "technicalMaxDrawdown", "technical_max_drawdown"), 0),
        aiFilteredMaxDrawdown: finiteOrZero(valueOf(strategy, "aiFilteredMaxDrawdown", "ai_filtered_max_drawdown"), 0),
      },
    }];
  }).sort((left, right) => left.horizonMinutes - right.horizonMinutes);
}

export function scalpingTradeMarkerPoints(
  bars: readonly ScalpingBar[],
  markers: readonly ScalpingTradeMarker[],
  maximumBars = 180,
): ScalpingTradeMarkerPoint[] {
  if (!Number.isInteger(maximumBars) || maximumBars < 1) return [];
  const startIndex = Math.max(0, bars.length - maximumBars);
  const visible = bars.slice(startIndex);
  const first = visible[0];
  const last = visible.at(-1);
  if (!first || !last) return [];
  const firstClose = Date.parse(first.timestamp);
  const lastClose = Date.parse(last.timestamp);
  if (!Number.isFinite(firstClose) || !Number.isFinite(lastClose)) return [];
  const previousClose = startIndex > 0 ? Date.parse(bars[startIndex - 1]!.timestamp) : Number.NaN;
  const inferredInterval = first.intervalMinutes
    ?? (visible[1] ? Math.max(1, Math.round((Date.parse(visible[1].timestamp) - firstClose) / 60_000)) : 1);
  const lowerBoundary = Number.isFinite(previousClose) ? previousClose : firstClose - inferredInterval * 60_000;
  return markers.flatMap((marker) => {
    const markerAt = marker.timestamp ? Date.parse(marker.timestamp) : Number.NaN;
    const price = marker.averagePrice;
    if (!Number.isFinite(markerAt) || price === undefined || !Number.isFinite(price) || price <= 0) return [];
    if ((Number.isFinite(previousClose) ? markerAt <= lowerBoundary : markerAt < lowerBoundary) || markerAt > lastClose) return [];
    const row = visible.find((candidate) => Date.parse(candidate.timestamp) >= markerAt);
    return row ? [{ marker, timestamp: row.timestamp, price }] : [];
  }).sort((left, right) => left.timestamp.localeCompare(right.timestamp) || left.marker.id.localeCompare(right.marker.id));
}

export function scalpingStreamUrl(
  symbols: string[],
  interval: ScalpingInterval,
  preset: ScalpingPreset,
): string {
  const query = new URLSearchParams({
    symbols: symbols.map((symbol) => symbol.toUpperCase()).join(","),
    interval,
    preset,
  });
  return `/api/portfolio/scalping/stream?${query.toString()}`;
}

export function parseScalpingStreamEvent(value: unknown): ScalpingStreamEvent | undefined {
  const source = record(value);
  const type = oneOf(valueOf(source, "type"), ["snapshot", "candidate", "bar", "quote", "trade", "orderbook", "signal", "forecast", "analysis", "connection", "recovery", "diagnostic", "heartbeat"] as const, "heartbeat");
  if (type === "heartbeat" && valueOf(source, "type") !== "heartbeat") return undefined;
  return {
    type,
    symbol: string(valueOf(source, "symbol", "instrumentKey", "instrument_key"))?.toUpperCase(),
    value: valueOf(source, "value", "data", "payload") ?? source,
  };
}

function mergeRealtimeAnalysis(workspace: ScalpingWorkspace, event: ScalpingStreamEvent): ScalpingWorkspace {
  const payload = record(event.value);
  if (string(valueOf(payload, "schemaVersion", "schema_version")) !== "scalping-realtime-analysis/v1") return workspace;
  if (string(valueOf(payload, "interval")) !== workspace.interval || string(valueOf(payload, "preset")) !== workspace.preset) return workspace;

  const technical = record(valueOf(payload, "technical"));
  const rawInstruments = array(valueOf(technical, "instruments"));
  const instruments = rawInstruments.length ? rawInstruments : event.symbol ? [technical] : [];
  const bySymbol = new Map(instruments.flatMap((item) => {
    const instrument = record(item);
    const symbol = string(valueOf(instrument, "symbol", "instrumentKey", "instrument_key"))?.toUpperCase()
      ?? (instruments.length === 1 ? event.symbol : undefined);
    return symbol ? [[symbol, item] as const] : [];
  }));
  let changed = false;
  const candidates = workspace.candidates.map((candidate) => {
    const instrument = bySymbol.get(candidate.symbol);
    if (!instrument) return candidate;
    changed = true;
    const normalized = normalizeTechnical(instrument, candidate.bars);
    const orderbook = candidate.orderbook && normalized.orderbookImbalance !== undefined
      ? { ...candidate.orderbook, imbalance: normalized.orderbookImbalance }
      : candidate.orderbook;
    const nextQuality = normalized.quality ? {
      status: normalized.quality.status,
      reasons: Array.from(new Set([...candidate.quality.reasons, ...normalized.quality.reasons])),
      missing: Array.from(new Set([...candidate.quality.missing, ...normalized.quality.missing])),
      sources: Array.from(new Set([...candidate.quality.sources, ...normalized.quality.sources])),
      observedAt: normalized.quality.observedAt ?? candidate.quality.observedAt,
    } : candidate.quality;
    return {
      ...candidate,
      bars: normalized.bars,
      levels: normalized.levels ?? candidate.levels,
      relativeVolume: normalized.relativeVolume ?? candidate.relativeVolume,
      executionStrength: normalized.executionStrength ?? candidate.executionStrength,
      orderbook,
      signal: normalized.signal,
      volumeProfile: normalized.volumeProfile ?? candidate.volumeProfile,
      indicators: normalized.indicators,
      quality: nextQuality,
    };
  });
  return changed ? { ...workspace, candidates } : workspace;
}

export function mergeScalpingStreamEvent(workspace: ScalpingWorkspace, event: ScalpingStreamEvent): ScalpingWorkspace {
  if (event.type === "heartbeat" || event.type === "connection" || event.type === "recovery" || event.type === "diagnostic") return workspace;
  if (event.type === "snapshot") return normalizeScalpingWorkspace({ workspace: event.value }, {
    criterion: workspace.criterion,
    topCount: workspace.requestedTopCount,
    interval: workspace.interval,
    layoutColumns: workspace.layoutColumns,
    preset: workspace.preset,
  });
  if (event.type === "analysis") return mergeRealtimeAnalysis(workspace, event);
  const source = record(event.value);
  const symbol = event.symbol ?? string(valueOf(source, "symbol", "instrumentKey", "instrument_key"))?.toUpperCase();
  if (!symbol) return workspace;
  let changed = false;
  const candidates = workspace.candidates.map((candidate) => {
    if (candidate.symbol !== symbol) return candidate;
    if (event.type === "bar") {
      const bar = normalizeBar(source);
      if (!bar || bar.intervalMinutes !== intervalToMinutes(workspace.interval)) return candidate;
      changed = true;
      const bars = [...candidate.bars.filter((item) => item.timestamp !== bar.timestamp), bar]
        .sort((left, right) => left.timestamp.localeCompare(right.timestamp));
      return { ...candidate, bars, price: bar.close };
    }
    changed = true;
    if (event.type === "candidate") return normalizeCandidate({ ...candidate, ...source }, source) ?? candidate;
    if (event.type === "quote") return {
      ...candidate,
      price: number(valueOf(source, "price", "currentPrice", "current_price"), 0) ?? candidate.price,
      volume: number(valueOf(source, "volume"), 0) ?? candidate.volume,
      tradingAmount: number(valueOf(source, "tradingAmount", "trading_amount"), 0) ?? candidate.tradingAmount,
      spreadBps: number(valueOf(source, "spreadBps", "spread_bps"), 0) ?? candidate.spreadBps,
      executionStrength: number(valueOf(source, "executionStrength", "execution_strength"), 0) ?? candidate.executionStrength,
    };
    if (event.type === "trade") return {
      ...candidate,
      price: number(valueOf(source, "price"), 0) ?? candidate.price,
      executionStrength: number(valueOf(source, "executionStrength", "execution_strength"), 0) ?? candidate.executionStrength,
    };
    if (event.type === "orderbook") return { ...candidate, orderbook: normalizeOrderbook(source) ?? candidate.orderbook };
    if (event.type === "signal") return { ...candidate, signal: normalizeSignal(source) ?? candidate.signal };
    return { ...candidate, forecast: normalizeForecast(source) ?? candidate.forecast };
  });
  return changed ? { ...workspace, candidates } : workspace;
}

export function validateScalpingRequest(value: ScalpingRequest): string[] {
  const issues: string[] = [];
  if (!SCALPING_CRITERIA.includes(value.criterion)) issues.push("스캐너 기준이 올바르지 않습니다.");
  if (!Number.isInteger(value.topCount) || value.topCount < 5 || value.topCount > 50) issues.push("표시 종목 수는 5~50의 정수여야 합니다.");
  if (!SCALPING_INTERVALS.includes(value.interval)) issues.push("분봉 간격이 올바르지 않습니다.");
  if (!Number.isInteger(value.layoutColumns) || value.layoutColumns < 1 || value.layoutColumns > 4) issues.push("차트 열 수는 1~4여야 합니다.");
  if (!SCALPING_PRESETS.includes(value.preset)) issues.push("지표 프리셋이 올바르지 않습니다.");
  if (value.symbols && (value.symbols.length > 50 || value.symbols.some((symbol) => !/^[A-Za-z0-9._-]{1,32}$/.test(symbol)))) {
    issues.push("사용자 지정 종목 목록이 올바르지 않습니다.");
  }
  return issues;
}

export function scalpingErrorMessage(value: unknown, fallback: string): string {
  const outer = record(value);
  const error = record(valueOf(outer, "error"));
  return string(valueOf(error, "message")) ?? string(valueOf(outer, "message")) ?? fallback;
}
