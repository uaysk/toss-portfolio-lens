export type TechnicalIndicatorKind =
  | "sma"
  | "ema"
  | "rsi"
  | "macd"
  | "bollinger_bands"
  | "atr"
  | "donchian_channel"
  | "benchmark_relative_strength"
  | "fifty_two_week_high_low_position"
  | "moving_average_distance"
  | "adx_dmi"
  | "stochastic_oscillator"
  | "roc"
  | "keltner_channel"
  | "supertrend"
  | "historical_volatility"
  | "normalized_atr"
  | "bollinger_band_width_percent_b"
  | "aroon"
  | "cci"
  | "williams_r"
  | "parabolic_sar"
  | "choppiness_index"
  | "volume_sma"
  | "relative_volume"
  | "obv"
  | "mfi"
  | "cmf"
  | "accumulation_distribution_line"
  | "vwap_anchored_vwap"
  | "volume_profile";

export type TechnicalIndicatorPanel = "price" | "oscillator" | "mixed" | "volume" | "profile";
export type TechnicalIndicatorCategory = "trend" | "momentum" | "volatility" | "breakout" | "relative_performance" | "volume";
export type TechnicalVolumePresentation = "overlay" | "panel";

export type TechnicalIndicatorOption = {
  kind: TechnicalIndicatorKind;
  label: string;
  shortLabel: string;
  panel: TechnicalIndicatorPanel;
  category: TechnicalIndicatorCategory;
  outputFields: string[];
  priceFields: string[];
  oscillatorFields: string[];
  volumeFields?: string[];
  volumePresentation?: TechnicalVolumePresentation;
  referenceLines?: number[];
  scope?: "batch" | "focused";
};

export const TECHNICAL_INDICATORS: TechnicalIndicatorOption[] = [
  { kind: "sma", label: "단순 이동평균", shortLabel: "SMA", panel: "price", category: "trend", outputFields: ["value"], priceFields: ["value"], oscillatorFields: [] },
  { kind: "ema", label: "지수 이동평균", shortLabel: "EMA", panel: "price", category: "trend", outputFields: ["value"], priceFields: ["value"], oscillatorFields: [] },
  { kind: "rsi", label: "상대강도지수", shortLabel: "RSI", panel: "oscillator", category: "momentum", outputFields: ["value"], priceFields: [], oscillatorFields: ["value"], referenceLines: [30, 70] },
  { kind: "macd", label: "MACD", shortLabel: "MACD", panel: "oscillator", category: "momentum", outputFields: ["macd", "signal", "histogram"], priceFields: [], oscillatorFields: ["macd", "signal", "histogram"], referenceLines: [0] },
  { kind: "bollinger_bands", label: "볼린저 밴드", shortLabel: "Bollinger", panel: "price", category: "volatility", outputFields: ["upper", "middle", "lower"], priceFields: ["upper", "middle", "lower"], oscillatorFields: [] },
  { kind: "atr", label: "평균 진폭", shortLabel: "ATR", panel: "oscillator", category: "volatility", outputFields: ["atr"], priceFields: [], oscillatorFields: ["atr"] },
  { kind: "donchian_channel", label: "돈치안 채널", shortLabel: "Donchian", panel: "price", category: "breakout", outputFields: ["upper", "middle", "lower"], priceFields: ["upper", "middle", "lower"], oscillatorFields: [] },
  { kind: "benchmark_relative_strength", label: "벤치마크 상대강도", shortLabel: "Relative", panel: "oscillator", category: "relative_performance", outputFields: ["relative_strength"], priceFields: [], oscillatorFields: ["relative_strength"], referenceLines: [100] },
  { kind: "fifty_two_week_high_low_position", label: "52주 고저점 위치", shortLabel: "52W", panel: "mixed", category: "breakout", outputFields: ["rolling_high", "rolling_low", "position_percent"], priceFields: ["rolling_high", "rolling_low"], oscillatorFields: ["position_percent"], referenceLines: [0, 50, 100] },
  { kind: "moving_average_distance", label: "이동평균 이격도", shortLabel: "MA 거리", panel: "mixed", category: "trend", outputFields: ["moving_average", "distance_percent"], priceFields: ["moving_average"], oscillatorFields: ["distance_percent"], referenceLines: [0] },
  { kind: "adx_dmi", label: "ADX·DMI", shortLabel: "ADX·DMI", panel: "oscillator", category: "trend", outputFields: ["adx", "plus_di", "minus_di"], priceFields: [], oscillatorFields: ["adx", "plus_di", "minus_di"], referenceLines: [25] },
  { kind: "stochastic_oscillator", label: "스토캐스틱 오실레이터", shortLabel: "Stochastic", panel: "oscillator", category: "momentum", outputFields: ["percent_k", "percent_d"], priceFields: [], oscillatorFields: ["percent_k", "percent_d"], referenceLines: [20, 80] },
  { kind: "roc", label: "변화율", shortLabel: "ROC", panel: "oscillator", category: "momentum", outputFields: ["value"], priceFields: [], oscillatorFields: ["value"], referenceLines: [0] },
  { kind: "keltner_channel", label: "켈트너 채널", shortLabel: "Keltner", panel: "price", category: "volatility", outputFields: ["upper", "middle", "lower"], priceFields: ["upper", "middle", "lower"], oscillatorFields: [] },
  { kind: "supertrend", label: "슈퍼트렌드", shortLabel: "Supertrend", panel: "mixed", category: "trend", outputFields: ["supertrend", "direction"], priceFields: ["supertrend"], oscillatorFields: ["direction"], referenceLines: [0] },
  { kind: "historical_volatility", label: "역사적 변동성", shortLabel: "Hist Vol", panel: "oscillator", category: "volatility", outputFields: ["value"], priceFields: [], oscillatorFields: ["value"], referenceLines: [0] },
  { kind: "normalized_atr", label: "정규화 ATR", shortLabel: "NATR", panel: "oscillator", category: "volatility", outputFields: ["value"], priceFields: [], oscillatorFields: ["value"], referenceLines: [0] },
  { kind: "bollinger_band_width_percent_b", label: "볼린저 밴드폭·%B", shortLabel: "BB Width·%B", panel: "mixed", category: "volatility", outputFields: ["bandwidth", "percent_b", "upper", "middle", "lower"], priceFields: ["upper", "middle", "lower"], oscillatorFields: ["bandwidth", "percent_b"], referenceLines: [0, 1] },
  { kind: "aroon", label: "아룬", shortLabel: "Aroon", panel: "oscillator", category: "trend", outputFields: ["aroon_up", "aroon_down", "oscillator"], priceFields: [], oscillatorFields: ["aroon_up", "aroon_down", "oscillator"], referenceLines: [0] },
  { kind: "cci", label: "상품채널지수", shortLabel: "CCI", panel: "oscillator", category: "momentum", outputFields: ["value"], priceFields: [], oscillatorFields: ["value"], referenceLines: [-100, 100] },
  { kind: "williams_r", label: "Williams %R", shortLabel: "Williams %R", panel: "oscillator", category: "momentum", outputFields: ["value"], priceFields: [], oscillatorFields: ["value"], referenceLines: [-80, -20] },
  { kind: "parabolic_sar", label: "Parabolic SAR", shortLabel: "SAR", panel: "mixed", category: "trend", outputFields: ["sar", "direction"], priceFields: ["sar"], oscillatorFields: ["direction"], referenceLines: [0] },
  { kind: "choppiness_index", label: "Choppiness Index", shortLabel: "CHOP", panel: "oscillator", category: "trend", outputFields: ["value"], priceFields: [], oscillatorFields: ["value"], referenceLines: [38.2, 61.8] },
  { kind: "volume_sma", label: "거래량 이동평균", shortLabel: "Volume SMA", panel: "volume", category: "volume", outputFields: ["value"], priceFields: [], oscillatorFields: [], volumeFields: ["value"], volumePresentation: "overlay" },
  { kind: "relative_volume", label: "상대 거래량", shortLabel: "Relative Volume", panel: "volume", category: "volume", outputFields: ["value"], priceFields: [], oscillatorFields: [], volumeFields: ["value"], volumePresentation: "panel", referenceLines: [1] },
  { kind: "obv", label: "누적 거래량", shortLabel: "OBV", panel: "volume", category: "volume", outputFields: ["value"], priceFields: [], oscillatorFields: [], volumeFields: ["value"], volumePresentation: "panel", referenceLines: [0] },
  { kind: "mfi", label: "자금흐름지수", shortLabel: "MFI", panel: "oscillator", category: "volume", outputFields: ["value"], priceFields: [], oscillatorFields: ["value"], volumeFields: [], volumePresentation: "panel", referenceLines: [20, 80] },
  { kind: "cmf", label: "Chaikin Money Flow", shortLabel: "CMF", panel: "oscillator", category: "volume", outputFields: ["value"], priceFields: [], oscillatorFields: ["value"], volumeFields: [], volumePresentation: "panel", referenceLines: [0] },
  { kind: "accumulation_distribution_line", label: "Accumulation/Distribution Line", shortLabel: "A/D Line", panel: "volume", category: "volume", outputFields: ["value"], priceFields: [], oscillatorFields: [], volumeFields: ["value"], volumePresentation: "panel", referenceLines: [0] },
  { kind: "vwap_anchored_vwap", label: "VWAP·Anchored VWAP", shortLabel: "VWAP·AVWAP", panel: "price", category: "volume", outputFields: ["vwap", "anchored_vwap"], priceFields: ["vwap", "anchored_vwap"], oscillatorFields: [], scope: "batch" },
  { kind: "volume_profile", label: "Volume Profile", shortLabel: "Volume Profile", panel: "profile", category: "volume", outputFields: ["point_of_control", "value_area_high", "value_area_low"], priceFields: [], oscillatorFields: [], scope: "focused" },
];

export const TECHNICAL_BATCH_INDICATORS = TECHNICAL_INDICATORS.filter((indicator) => indicator.scope !== "focused");

export const TECHNICAL_INDICATOR_BY_KIND = new Map(
  TECHNICAL_INDICATORS.map((indicator) => [indicator.kind, indicator]),
);

export type TechnicalIndicatorPresetKey = "trend" | "momentum" | "volatility" | "breakout" | "relative_performance" | "volume";

export const TECHNICAL_INDICATOR_PRESETS: Array<{ key: TechnicalIndicatorPresetKey; label: string; kinds: TechnicalIndicatorKind[] }> = [
  { key: "trend", label: "추세", kinds: ["sma", "ema", "adx_dmi", "supertrend", "aroon", "parabolic_sar", "moving_average_distance", "choppiness_index"] },
  { key: "momentum", label: "모멘텀", kinds: ["rsi", "macd", "stochastic_oscillator", "roc", "cci", "williams_r"] },
  { key: "volatility", label: "변동성", kinds: ["bollinger_bands", "atr", "keltner_channel", "historical_volatility", "normalized_atr", "bollinger_band_width_percent_b"] },
  { key: "breakout", label: "돌파", kinds: ["donchian_channel", "fifty_two_week_high_low_position", "supertrend"] },
  { key: "relative_performance", label: "상대성과", kinds: ["benchmark_relative_strength", "moving_average_distance", "roc"] },
  { key: "volume", label: "거래량", kinds: ["volume_sma", "relative_volume", "obv", "mfi", "cmf", "accumulation_distribution_line", "vwap_anchored_vwap"] },
];

export function identifyTechnicalIndicatorPreset(kinds: readonly TechnicalIndicatorKind[]): TechnicalIndicatorPresetKey | "custom" {
  const selected = new Set(kinds);
  return TECHNICAL_INDICATOR_PRESETS.find((preset) => (
    preset.kinds.length === selected.size && preset.kinds.every((kind) => selected.has(kind))
  ))?.key ?? "custom";
}

// `source` is preset provenance. The technical preset kind itself lives in
// config.presetType, so use the API's existing manual provenance branch.
export const TECHNICAL_PRESET_SOURCE = Object.freeze({ type: "manual" as const });

export type TechnicalIndicatorPrimitive = string | number | boolean | null;

export type TechnicalIndicatorDefinition = {
  id: string;
  kind: TechnicalIndicatorKind;
  parameters?: Record<string, TechnicalIndicatorPrimitive>;
  instrumentKeys?: string[];
};

export type TechnicalAnalysisRequest = {
  symbols: string[];
  fromDate: string;
  toDate: string;
  interval: "1d" | "1w";
  adjusted: boolean;
  currencyMode: "local" | "KRW";
  responseMode: "full_series";
  indicators: TechnicalIndicatorDefinition[];
};

export type TechnicalAnalysisBar = {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
};

export type TechnicalPriceSeries = {
  key: string;
  symbol: string;
  market: string;
  currency: string;
  instrument_type: "stock" | "etf" | "index" | "fund" | "other";
  bars: TechnicalAnalysisBar[];
};

export type TechnicalAvailability = {
  status: "available" | "partial" | "insufficient_history" | "volume_unavailable" | "unsupported_instrument" | "unavailable";
  reason: string;
};

export function technicalAvailabilityLabel(status: TechnicalAvailability["status"]): string {
  switch (status) {
    case "available": return "사용 가능";
    case "partial": return "일부 가능";
    case "insufficient_history": return "이력 부족";
    case "volume_unavailable": return "거래량 없음";
    case "unsupported_instrument": return "미지원 종목";
    default: return "사용 불가";
  }
}

export function isTechnicalVolumeIndicator(kind: TechnicalIndicatorKind): boolean {
  return TECHNICAL_INDICATOR_BY_KIND.get(kind)?.category === "volume";
}

export type TechnicalIndicatorPoint = {
  date: string;
  state: "warmup" | "available" | "unavailable";
  values: Record<string, number | null>;
};

export type TechnicalIndicatorCalculation = {
  instrument_key: string;
  indicator_id: string;
  kind: TechnicalIndicatorKind;
  parameters: Record<string, TechnicalIndicatorPrimitive>;
  availability: TechnicalAvailability;
  warmup: {
    required_observations: number;
    observed_observations: number;
    state: "warming_up" | "ready";
    first_available_date: string | null;
  };
  metadata?: Record<string, unknown>;
  profile?: TechnicalVolumeProfile;
  points?: TechnicalIndicatorPoint[];
  latest?: TechnicalIndicatorPoint;
};

export type TechnicalVolumeProfileBucket = {
  index: number;
  price_low: number;
  price_high: number;
  price_mid: number;
  volume: number;
  volume_percent: number;
  in_value_area: boolean;
  is_point_of_control: boolean;
};

export type TechnicalVolumeProfile = {
  schema_version: "volume-profile/v1" | string;
  from_date: string;
  to_date: string;
  price_source: "close" | "typical_price";
  requested_bucket_count: number;
  effective_bucket_count: number;
  price_min: number;
  price_max: number;
  bucket_width: number;
  total_volume: number;
  included_observations: number;
  missing_volume_observations: number;
  value_area_percent: number;
  point_of_control: number;
  value_area_high: number;
  value_area_low: number;
  buckets: TechnicalVolumeProfileBucket[];
  approximation: string;
};

export type TechnicalVwapSettings = {
  anchor: "period_start" | "user_date" | "recent_high" | "recent_low" | "signal_date";
  anchorDate?: string;
  lookbackPeriod: number;
  mode: "vwap" | "anchored" | "both";
};

export type TechnicalVolumeProfileSettings = {
  symbol?: string;
  bucketCount: number;
  priceSource: "close" | "typical_price";
  valueAreaPercent: number;
};

export type TechnicalTradeEstimate<T> = ({ status: "estimated" } & T) | { status: "unavailable"; reason: string };

export type TechnicalTradeExecution = {
  order_id: string;
  ordered_at: string;
  filled_at: string;
  filled_quantity: number;
  average_filled_price: number | null;
  filled_amount: number | null;
  commission: number | null;
  tax: number | null;
  status: string;
};

/**
 * Server-computed portfolio execution marker. The UI never reconstructs a
 * missing weight or execution value: unavailable means unavailable.
 */
export type TechnicalTradeMarker = {
  id: string;
  symbol: string;
  date: string;
  side: "buy" | "sell";
  order_count: number;
  execution_count: null;
  execution_count_reason: "individual_executions_not_persisted";
  filled_quantity: number;
  average_filled_price: number | null;
  filled_amount: number | null;
  currency: string;
  filled_amount_krw: TechnicalTradeEstimate<{
    value: number;
    fx_rate: number;
    fx_rate_date: string;
    fx_rate_status: "identity" | "exact" | "carried";
  }>;
  trade_weight: TechnicalTradeEstimate<{
    percent: number;
    numerator_krw: number;
    denominator_krw: number;
    valuation_date: string;
  }>;
  position_weight: TechnicalTradeEstimate<{
    before_percent: number;
    after_percent: number;
    before_snapshot_date: string;
    after_snapshot_date: string;
  }>;
  details: TechnicalTradeExecution[];
};

export type TechnicalTradeMarkersPayload = {
  schema_version: string;
  account_id: string;
  generated_at: string;
  policies: Record<string, string>;
  metadata: {
    order_history: {
      status: "idle" | "running" | "complete" | "partial" | "error" | "unavailable";
      marker_data_availability: "available" | "partial" | "unavailable";
      complete: boolean;
      phase: "waiting" | "orders" | "instruments" | "prices" | "reconstructing" | "complete" | null;
      updated_at: string | null;
      first_trade_date: string | null;
      last_backfilled_date: string | null;
      orders_imported: number | null;
      failed_symbols: number | null;
      message: string | null;
    };
  };
  markers: TechnicalTradeMarker[];
  diagnostics: {
    stored_order_count: number;
    included_order_count: number;
    skipped_unfilled_or_invalid_count: number;
    filtered_out_count: number;
    marker_count: number;
    estimated_weight_count: number;
    unavailable_weight_count: number;
    order_history_status: "idle" | "running" | "complete" | "partial" | "error" | "unavailable";
    marker_data_availability: "available" | "partial" | "unavailable";
    marker_count_complete: boolean;
  };
};

export function technicalTradeMarkerStatusNotice(payload: TechnicalTradeMarkersPayload): string {
  const orderHistory = payload.metadata?.order_history;
  if (!orderHistory) {
    return "거래 marker 데이터 unavailable · 주문 이력 완전성을 확인하지 못해 0건을 거래 없음으로 해석할 수 없습니다.";
  }
  const markerCount = payload.markers.length.toLocaleString("ko-KR");
  if (orderHistory.marker_data_availability === "available" && orderHistory.complete) {
    return `거래 marker 주문 이력 complete · 조회 범위 ${markerCount}건`;
  }
  if (orderHistory.marker_data_availability === "partial") {
    return `거래 marker 일부만 표시 · 주문 이력 ${orderHistory.status} · 확인된 ${markerCount}건이며 0건이어도 거래 없음으로 확정할 수 없습니다.`;
  }
  return `거래 marker 데이터 unavailable · 주문 이력 ${orderHistory.status} · 0건을 거래 없음으로 해석할 수 없습니다.`;
}

export type TechnicalAnalysisPayload = {
  run_id: string;
  reused: boolean;
  response_mode: "full_series" | "latest_summary";
  price_series: TechnicalPriceSeries[];
  technical_analysis: {
    schema_version: string;
    indicator_engine_version: string;
    response_mode: "full_series" | "latest_summary";
    adjustment_policy: "adjusted" | "unadjusted";
    calculations: TechnicalIndicatorCalculation[];
    diagnostics?: Record<string, unknown>;
  };
  artifact_index?: Array<Record<string, unknown>>;
};

export type TechnicalAnalysisEnvelope = {
  schema_version?: string;
  generated_at?: string;
  engine_version?: string;
  data_revision?: string;
  assumptions?: string[];
  warnings?: string[];
  data_quality?: Record<string, unknown>;
  result: TechnicalAnalysisPayload;
};

export type TechnicalInstrumentChoice = {
  symbol: string;
  name: string;
  market: string;
  currency: "KRW" | "USD";
  assetType?: string;
};

export type TechnicalChartRow = TechnicalAnalysisBar & {
  candleRange: [number, number];
  indicatorValues: Record<string, number | null>;
};

export type TechnicalPresetConfig = {
  schemaVersion: 1;
  presetType: "technical_watchlist" | "technical_chart_config";
  watchlist: TechnicalInstrumentChoice[];
  interval?: "1d" | "1w";
  fromDate?: string;
  toDate?: string;
  columns?: 1 | 2 | 3 | 4;
  priceMode?: "actual" | "starting100";
  currencyMode?: "local" | "KRW";
  sortMode?: "weight" | "return" | "indicator";
  globalIndicators?: TechnicalIndicatorKind[];
  indicatorOverrides?: Record<string, TechnicalIndicatorKind[]>;
  benchmarkSymbol?: string;
  showTradeMarkers?: boolean;
  vwapSettings?: TechnicalVwapSettings;
  volumeProfileSettings?: TechnicalVolumeProfileSettings;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function indicatorKinds(value: unknown): TechnicalIndicatorKind[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.filter((item): item is TechnicalIndicatorKind => (
    typeof item === "string"
      && item !== "volume_profile"
      && TECHNICAL_INDICATOR_BY_KIND.has(item as TechnicalIndicatorKind)
  ))));
}

export function indicatorValueKey(indicatorId: string, field: string): string {
  return `${indicatorId}:${field}`;
}

export function buildTechnicalIndicatorDefinitions(
  symbols: string[],
  globalKinds: TechnicalIndicatorKind[],
  overrides: Readonly<Record<string, TechnicalIndicatorKind[] | undefined>>,
  benchmarkSymbol?: string,
  parametersByKind: Partial<Record<TechnicalIndicatorKind, Record<string, TechnicalIndicatorPrimitive>>> = {},
): TechnicalIndicatorDefinition[] {
  const normalizedSymbols = Array.from(new Set(symbols.map((symbol) => symbol.trim().toUpperCase()).filter(Boolean)));
  const selected = new Map<TechnicalIndicatorKind, string[]>();
  for (const symbol of normalizedSymbols) {
    const effective = overrides[symbol] ?? globalKinds;
    for (const kind of Array.from(new Set(effective))) {
      if (!TECHNICAL_INDICATOR_BY_KIND.has(kind)) continue;
      const targets = selected.get(kind) ?? [];
      targets.push(symbol);
      selected.set(kind, targets);
    }
  }
  return TECHNICAL_BATCH_INDICATORS.flatMap((option): TechnicalIndicatorDefinition[] => {
    const targets = selected.get(option.kind);
    if (!targets?.length) return [];
    let parameters: Record<string, TechnicalIndicatorPrimitive> | undefined = parametersByKind[option.kind]
      ? { ...parametersByKind[option.kind] }
      : undefined;
    if (option.kind === "benchmark_relative_strength") {
      parameters = { ...(parameters ?? {}), benchmark_key: (benchmarkSymbol && normalizedSymbols.includes(benchmarkSymbol) ? benchmarkSymbol : normalizedSymbols[0]) ?? "" };
    }
    return [{
      id: `${option.kind}-primary`,
      kind: option.kind,
      ...(parameters ? { parameters } : {}),
      ...(targets.length === normalizedSymbols.length ? {} : { instrumentKeys: targets }),
    }];
  });
}

export function buildVolumeProfileRequest(input: {
  symbol: string;
  fromDate: string;
  toDate: string;
  interval: "1d" | "1w";
  currencyMode: "local" | "KRW";
  settings: TechnicalVolumeProfileSettings;
}): TechnicalAnalysisRequest {
  const symbol = input.symbol.trim().toUpperCase();
  return {
    symbols: [symbol],
    fromDate: input.fromDate,
    toDate: input.toDate,
    interval: input.interval,
    adjusted: true,
    currencyMode: input.currencyMode,
    responseMode: "full_series",
    indicators: [{
      id: "volume-profile-focused",
      kind: "volume_profile",
      parameters: {
        bucket_count: Math.min(200, Math.max(5, Math.trunc(input.settings.bucketCount))),
        price_source: input.settings.priceSource,
        value_area_percent: Math.min(99, Math.max(50, input.settings.valueAreaPercent)),
      },
      instrumentKeys: [symbol],
    }],
  };
}

export function volumeProfileCalculation(payload: TechnicalAnalysisPayload): TechnicalIndicatorCalculation | undefined {
  return payload.technical_analysis.calculations.find((calculation) => calculation.kind === "volume_profile");
}

export function unwrapTechnicalAnalysisPayload(value: unknown): TechnicalAnalysisPayload | undefined {
  if (!isRecord(value)) return undefined;
  const candidate = isRecord(value.result) ? value.result : value;
  if (!Array.isArray(candidate.price_series) || !isRecord(candidate.technical_analysis)) return undefined;
  if (!Array.isArray(candidate.technical_analysis.calculations)) return undefined;
  return candidate as unknown as TechnicalAnalysisPayload;
}

export function calculationsForInstrument(
  payload: TechnicalAnalysisPayload,
  instrumentKey: string,
): TechnicalIndicatorCalculation[] {
  return payload.technical_analysis.calculations.filter((calculation) => calculation.instrument_key === instrumentKey);
}

export function buildTechnicalChartRows(
  series: TechnicalPriceSeries,
  calculations: TechnicalIndicatorCalculation[],
): TechnicalChartRow[] {
  const valuesByDate = new Map<string, Record<string, number | null>>();
  for (const calculation of calculations) {
    for (const point of calculation.points ?? []) {
      const row = valuesByDate.get(point.date) ?? {};
      for (const [field, value] of Object.entries(point.values)) {
        row[indicatorValueKey(calculation.indicator_id, field)] = finite(value) ? value : null;
      }
      valuesByDate.set(point.date, row);
    }
  }
  return series.bars.map((bar) => ({
    ...bar,
    candleRange: [bar.low, bar.high],
    indicatorValues: valuesByDate.get(bar.date) ?? {},
  }));
}

export function displayTechnicalChartRows(
  rows: TechnicalChartRow[],
  mode: "actual" | "starting100",
  priceValueKeys: ReadonlySet<string>,
): TechnicalChartRow[] {
  if (mode === "actual") return rows;
  const base = rows.find((row) => row.close > 0)?.close;
  if (!base) return rows;
  const normalize = (value: number): number => (value / base) * 100;
  return rows.map((row) => ({
    ...row,
    open: normalize(row.open),
    high: normalize(row.high),
    low: normalize(row.low),
    close: normalize(row.close),
    candleRange: [normalize(row.low), normalize(row.high)],
    indicatorValues: Object.fromEntries(Object.entries(row.indicatorValues).map(([key, value]) => [
      key,
      value !== null && priceValueKeys.has(key) ? normalize(value) : value,
    ])),
  }));
}

export function technicalSeriesReturn(series: TechnicalPriceSeries): number | undefined {
  const first = series.bars.find((bar) => bar.close > 0)?.close;
  const last = [...series.bars].reverse().find((bar) => bar.close > 0)?.close;
  return first && last ? ((last / first) - 1) * 100 : undefined;
}

export function latestTechnicalIndicatorValue(
  calculations: TechnicalIndicatorCalculation[],
): number | undefined {
  for (const calculation of calculations) {
    const point = calculation.latest ?? calculation.points?.at(-1);
    if (!point) continue;
    const value = Object.values(point.values).find(finite);
    if (value !== undefined) return value;
  }
  return undefined;
}

export function normalizeTechnicalPresetConfig(value: unknown): TechnicalPresetConfig | undefined {
  if (!isRecord(value)) return undefined;
  const presetType = value.presetType === "technical_watchlist" || value.presetType === "technical_chart_config"
    ? value.presetType
    : value.kind === "technical_watchlist" || value.kind === "technical_chart_config" ? value.kind : undefined;
  if (!presetType) return undefined;
  const rawWatchlist = Array.isArray(value.watchlist) ? value.watchlist : Array.isArray(value.symbols)
    ? value.symbols.map((symbol) => ({ symbol, name: symbol, market: "", currency: "KRW" }))
    : [];
  const watchlistCandidates = rawWatchlist.flatMap((item): TechnicalInstrumentChoice[] => {
    if (!isRecord(item) || typeof item.symbol !== "string") return [];
    const symbol = item.symbol.trim().toUpperCase();
    if (!symbol || !/^[A-Z0-9.-]{1,32}$/.test(symbol)) return [];
    return [{
      symbol,
      name: typeof item.name === "string" && item.name.trim() ? item.name.trim() : symbol,
      market: typeof item.market === "string" ? item.market : "",
      currency: item.currency === "USD" ? "USD" : "KRW",
      ...(typeof item.assetType === "string" ? { assetType: item.assetType } : {}),
    }];
  });
  const seenWatchlistSymbols = new Set<string>();
  const watchlist = watchlistCandidates.filter((item) => {
    if (seenWatchlistSymbols.has(item.symbol)) return false;
    seenWatchlistSymbols.add(item.symbol);
    return true;
  }).slice(0, 50);
  const columns = finite(value.columns) && [1, 2, 3, 4].includes(value.columns) ? value.columns as 1 | 2 | 3 | 4 : undefined;
  const rawOverrides = isRecord(value.indicatorOverrides) ? value.indicatorOverrides : {};
  const indicatorOverrides = Object.fromEntries(Object.entries(rawOverrides).flatMap(([symbol, kinds]) => {
    const normalized = indicatorKinds(kinds);
    return normalized.length || Array.isArray(kinds) ? [[symbol.toUpperCase(), normalized]] : [];
  }));
  const rawVwap = isRecord(value.vwapSettings) ? value.vwapSettings : undefined;
  const vwapAnchor = rawVwap && ["period_start", "user_date", "recent_high", "recent_low", "signal_date"].includes(String(rawVwap.anchor))
    ? rawVwap.anchor as TechnicalVwapSettings["anchor"]
    : undefined;
  const vwapMode = rawVwap && ["vwap", "anchored", "both"].includes(String(rawVwap.mode))
    ? rawVwap.mode as TechnicalVwapSettings["mode"]
    : undefined;
  const vwapLookback = rawVwap && finite(rawVwap.lookbackPeriod)
    ? Math.min(10_000, Math.max(1, Math.trunc(rawVwap.lookbackPeriod)))
    : undefined;
  const vwapSettings = vwapAnchor && vwapMode && vwapLookback
    ? {
        anchor: vwapAnchor,
        mode: vwapMode,
        lookbackPeriod: vwapLookback,
        ...(typeof rawVwap?.anchorDate === "string" ? { anchorDate: rawVwap.anchorDate } : {}),
      }
    : undefined;
  const rawProfile = isRecord(value.volumeProfileSettings) ? value.volumeProfileSettings : undefined;
  const volumeProfileSettings = rawProfile
    && finite(rawProfile.bucketCount)
    && finite(rawProfile.valueAreaPercent)
    && (rawProfile.priceSource === "close" || rawProfile.priceSource === "typical_price")
    ? {
        ...(typeof rawProfile.symbol === "string" ? { symbol: rawProfile.symbol.trim().toUpperCase() } : {}),
        bucketCount: Math.min(200, Math.max(5, Math.trunc(rawProfile.bucketCount))),
        priceSource: rawProfile.priceSource as TechnicalVolumeProfileSettings["priceSource"],
        valueAreaPercent: Math.min(99, Math.max(50, rawProfile.valueAreaPercent)),
      }
    : undefined;
  return {
    schemaVersion: 1,
    presetType,
    watchlist,
    ...(value.interval === "1d" || value.interval === "1w" ? { interval: value.interval } : {}),
    ...(typeof value.fromDate === "string" ? { fromDate: value.fromDate } : {}),
    ...(typeof value.toDate === "string" ? { toDate: value.toDate } : {}),
    ...(columns ? { columns } : {}),
    ...(value.priceMode === "actual" || value.priceMode === "starting100" ? { priceMode: value.priceMode } : {}),
    ...(value.currencyMode === "local" || value.currencyMode === "KRW" ? { currencyMode: value.currencyMode } : {}),
    ...(value.sortMode === "weight" || value.sortMode === "return" || value.sortMode === "indicator" ? { sortMode: value.sortMode } : {}),
    ...(Array.isArray(value.globalIndicators) ? { globalIndicators: indicatorKinds(value.globalIndicators) } : {}),
    ...(Object.keys(indicatorOverrides).length ? { indicatorOverrides } : {}),
    ...(typeof value.benchmarkSymbol === "string" ? { benchmarkSymbol: value.benchmarkSymbol.toUpperCase() } : {}),
    ...(typeof value.showTradeMarkers === "boolean" ? { showTradeMarkers: value.showTradeMarkers } : {}),
    ...(vwapSettings ? { vwapSettings } : {}),
    ...(volumeProfileSettings ? { volumeProfileSettings } : {}),
  };
}

export function dateYearsAgo(date: string, years: number): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCFullYear(parsed.getUTCFullYear() - years);
  return parsed.toISOString().slice(0, 10);
}

export function dateMonthsAgo(date: string, months: number): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCMonth(parsed.getUTCMonth() - months);
  return parsed.toISOString().slice(0, 10);
}

export function visibleDateCutoff(fromDate: string, toDate: string, visiblePercent: number): string {
  const from = Date.parse(`${fromDate}T00:00:00Z`);
  const to = Date.parse(`${toDate}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) return fromDate;
  const percent = Math.max(1, Math.min(100, visiblePercent));
  const cutoff = to - (to - from) * (percent / 100);
  return new Date(cutoff).toISOString().slice(0, 10);
}

export function technicalWeekKey(date: string): string {
  const value = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(value.getTime())) return date;
  const day = value.getUTCDay() || 7;
  value.setUTCDate(value.getUTCDate() - day + 1);
  return value.toISOString().slice(0, 10);
}

export function technicalMarkerBarDate(markerDate: string, barDates: string[], interval: "1d" | "1w"): string | undefined {
  if (interval === "1d") return barDates.includes(markerDate) ? markerDate : undefined;
  const week = technicalWeekKey(markerDate);
  return barDates.find((date) => technicalWeekKey(date) === week);
}

export function combinedPortfolioWeightMap(payload: unknown): Map<string, number> | undefined {
  if (!isRecord(payload)) return undefined;
  const points = Array.isArray(payload.points) ? payload.points : [];
  const series = Array.isArray(payload.series) ? payload.series : [];
  const latest = points.at(-1);
  if (!isRecord(latest) || !isRecord(latest.values) || typeof latest.totalValue !== "number" || latest.totalValue <= 0) return undefined;
  const weights = new Map<string, number>();
  for (const raw of series) {
    if (!isRecord(raw) || typeof raw.symbol !== "string" || typeof raw.key !== "string") continue;
    const value = latest.values[raw.key];
    // Combined history values are already KRW portfolio percentages.
    if (finite(value)) weights.set(raw.symbol.toUpperCase(), value);
  }
  return weights.size ? weights : undefined;
}

export function technicalInstrumentsFromPortfolioHistory(payload: unknown): TechnicalInstrumentChoice[] {
  if (!isRecord(payload) || !Array.isArray(payload.series)) return [];
  return payload.series.flatMap((raw): TechnicalInstrumentChoice[] => {
    if (!isRecord(raw) || typeof raw.symbol !== "string") return [];
    const symbol = raw.symbol.trim().toUpperCase();
    if (!symbol) return [];
    return [{
      symbol,
      name: typeof raw.name === "string" && raw.name.trim() ? raw.name : symbol,
      market: typeof raw.market === "string" ? raw.market : "",
      currency: raw.currency === "USD" ? "USD" : "KRW",
      assetType: "historical_portfolio_holding",
    }];
  });
}
