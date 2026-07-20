import { describe, expect, it } from "vitest";
import {
  buildTechnicalChartRows,
  buildTechnicalIndicatorDefinitions,
  buildVolumeProfileRequest,
  combinedPortfolioWeightMap,
  displayTechnicalChartRows,
  indicatorValueKey,
  identifyTechnicalIndicatorPreset,
  isTechnicalVolumeIndicator,
  normalizeTechnicalPresetConfig,
  TECHNICAL_INDICATOR_PRESETS,
  TECHNICAL_BATCH_INDICATORS,
  TECHNICAL_INDICATORS,
  TECHNICAL_PRESET_SOURCE,
  technicalAvailabilityLabel,
  technicalInstrumentsFromPortfolioHistory,
  technicalMarkerBarDate,
  technicalTradeMarkerStatusNotice,
  unwrapTechnicalAnalysisPayload,
  visibleDateCutoff,
  type TechnicalAnalysisPayload,
  type TechnicalIndicatorCalculation,
  type TechnicalPriceSeries,
  type TechnicalTradeMarkersPayload,
} from "./technical-analysis";

const series: TechnicalPriceSeries = {
  key: "AAA",
  symbol: "AAA",
  market: "NYSE",
  currency: "USD",
  instrument_type: "stock",
  bars: [
    { date: "2026-07-01", open: 90, high: 110, low: 80, close: 100, volume: null },
    { date: "2026-07-02", open: 105, high: 125, low: 95, close: 120, volume: null },
  ],
};

const calculation: TechnicalIndicatorCalculation = {
  instrument_key: "AAA",
  indicator_id: "sma-primary",
  kind: "sma",
  parameters: { period: 20 },
  availability: { status: "available", reason: "" },
  warmup: { required_observations: 20, observed_observations: 30, state: "ready", first_available_date: "2026-07-01" },
  points: [
    { date: "2026-07-01", state: "available", values: { value: 95 } },
    { date: "2026-07-02", state: "available", values: { value: 105 } },
  ],
};

function markerPayload(
  status: TechnicalTradeMarkersPayload["metadata"]["order_history"]["status"],
  availability: TechnicalTradeMarkersPayload["metadata"]["order_history"]["marker_data_availability"],
  complete = false,
): TechnicalTradeMarkersPayload {
  return {
    schema_version: "technical-trade-markers/v1",
    account_id: "account-1",
    generated_at: "2026-07-21T00:00:00.000Z",
    policies: {},
    metadata: {
      order_history: {
        status,
        marker_data_availability: availability,
        complete,
        phase: status === "unavailable" ? null : "complete",
        updated_at: null,
        first_trade_date: null,
        last_backfilled_date: null,
        orders_imported: null,
        failed_symbols: null,
        message: null,
      },
    },
    markers: [],
    diagnostics: {
      stored_order_count: 0,
      included_order_count: 0,
      skipped_unfilled_or_invalid_count: 0,
      filtered_out_count: 0,
      marker_count: 0,
      estimated_weight_count: 0,
      unavailable_weight_count: 0,
      order_history_status: status,
      marker_data_availability: availability,
      marker_count_complete: complete,
    },
  };
}

describe("technical analysis UI contract helpers", () => {
  it("matches all 31 Rust output fields and separates 30 batch indicators from focused Volume Profile", () => {
    const expected = {
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
    } as const;
    expect(TECHNICAL_INDICATORS).toHaveLength(31);
    expect(TECHNICAL_BATCH_INDICATORS).toHaveLength(30);
    expect(TECHNICAL_INDICATORS.find((option) => option.kind === "volume_profile")).toMatchObject({ scope: "focused", panel: "profile" });
    expect(Object.fromEntries(TECHNICAL_INDICATORS.map((option) => [option.kind, option.outputFields]))).toEqual(expected);
    for (const option of TECHNICAL_BATCH_INDICATORS) {
      const volumeFields = option.volumeFields ?? [];
      expect(new Set([...option.priceFields, ...option.oscillatorFields, ...volumeFields])).toEqual(new Set(option.outputFields));
      expect(option.priceFields.filter((field) => option.oscillatorFields.includes(field))).toEqual([]);
      expect(option.priceFields.filter((field) => volumeFields.includes(field))).toEqual([]);
      expect(option.oscillatorFields.filter((field) => volumeFields.includes(field))).toEqual([]);
    }
    expect(Object.fromEntries(TECHNICAL_INDICATORS.filter((option) => option.panel === "mixed").map((option) => [option.kind, {
      price: option.priceFields,
      oscillator: option.oscillatorFields,
    }]))).toEqual({
      fifty_two_week_high_low_position: { price: ["rolling_high", "rolling_low"], oscillator: ["position_percent"] },
      moving_average_distance: { price: ["moving_average"], oscillator: ["distance_percent"] },
      supertrend: { price: ["supertrend"], oscillator: ["direction"] },
      bollinger_band_width_percent_b: { price: ["upper", "middle", "lower"], oscillator: ["bandwidth", "percent_b"] },
      parabolic_sar: { price: ["sar"], oscillator: ["direction"] },
    });
    expect(Object.fromEntries(TECHNICAL_INDICATORS.filter((option) => option.category === "volume").map((option) => [option.kind, {
      panel: option.panel,
      presentation: option.volumePresentation,
      price: option.priceFields,
      oscillator: option.oscillatorFields,
      volume: option.volumeFields ?? [],
    }]))).toEqual({
      volume_sma: { panel: "volume", presentation: "overlay", price: [], oscillator: [], volume: ["value"] },
      relative_volume: { panel: "volume", presentation: "panel", price: [], oscillator: [], volume: ["value"] },
      obv: { panel: "volume", presentation: "panel", price: [], oscillator: [], volume: ["value"] },
      mfi: { panel: "oscillator", presentation: "panel", price: [], oscillator: ["value"], volume: [] },
      cmf: { panel: "oscillator", presentation: "panel", price: [], oscillator: ["value"], volume: [] },
      accumulation_distribution_line: { panel: "volume", presentation: "panel", price: [], oscillator: [], volume: ["value"] },
      vwap_anchored_vwap: { panel: "price", presentation: undefined, price: ["vwap", "anchored_vwap"], oscillator: [], volume: [] },
      volume_profile: { panel: "profile", presentation: undefined, price: [], oscillator: [], volume: [] },
    });
  });

  it("provides the six one-click category compositions and reports edited compositions as custom", () => {
    expect(TECHNICAL_INDICATOR_PRESETS.map((preset) => preset.label)).toEqual(["추세", "모멘텀", "변동성", "돌파", "상대성과", "거래량"]);
    for (const preset of TECHNICAL_INDICATOR_PRESETS) expect(identifyTechnicalIndicatorPreset([...preset.kinds].reverse())).toBe(preset.key);
    expect(identifyTechnicalIndicatorPreset(["sma", "rsi"])).toBe("custom");
  });

  it("exposes the five stage-3 volume availability states without hiding their contract names", () => {
    expect([
      "available",
      "partial",
      "insufficient_history",
      "volume_unavailable",
      "unsupported_instrument",
    ].map((status) => [status, technicalAvailabilityLabel(status as Parameters<typeof technicalAvailabilityLabel>[0])])).toEqual([
      ["available", "사용 가능"],
      ["partial", "일부 가능"],
      ["insufficient_history", "이력 부족"],
      ["volume_unavailable", "거래량 없음"],
      ["unsupported_instrument", "미지원 종목"],
    ]);
    expect(TECHNICAL_INDICATORS.filter((option) => isTechnicalVolumeIndicator(option.kind)).map((option) => option.kind)).toEqual([
      "volume_sma",
      "relative_volume",
      "obv",
      "mfi",
      "cmf",
      "accumulation_distribution_line",
      "vwap_anchored_vwap",
      "volume_profile",
    ]);
  });

  it("uses the preset API's supported manual provenance discriminator", () => {
    expect(TECHNICAL_PRESET_SOURCE).toEqual({ type: "manual" });
  });

  it("groups effective per-instrument selections into one batch indicator request", () => {
    expect(buildTechnicalIndicatorDefinitions(
      ["AAA", "BBB"],
      ["sma", "rsi"],
      { BBB: ["ema", "rsi"] },
    )).toEqual([
      { id: "sma-primary", kind: "sma", instrumentKeys: ["AAA"] },
      { id: "ema-primary", kind: "ema", instrumentKeys: ["BBB"] },
      { id: "rsi-primary", kind: "rsi" },
    ]);
  });

  it("places all seven batch-scope volume definitions in one worker request and excludes focused profile", () => {
    const volumeKinds = TECHNICAL_INDICATOR_PRESETS.find((preset) => preset.key === "volume")?.kinds ?? [];
    const definitions = buildTechnicalIndicatorDefinitions(["AAA", "BBB"], volumeKinds, {});
    expect(definitions.map((definition) => definition.kind)).toEqual(volumeKinds);
    expect(definitions).toHaveLength(7);
    expect(definitions.every((definition) => definition.instrumentKeys === undefined)).toBe(true);
  });

  it("passes causal/static VWAP settings as Rust parameters without local calculation", () => {
    expect(buildTechnicalIndicatorDefinitions(
      ["AAA", "BBB"],
      ["vwap_anchored_vwap"],
      {},
      undefined,
      { vwap_anchored_vwap: { anchor: "signal_date", anchor_date: "2026-07-03", lookback_period: 30, mode: "anchored" } },
    )).toEqual([{
      id: "vwap_anchored_vwap-primary",
      kind: "vwap_anchored_vwap",
      parameters: { anchor: "signal_date", anchor_date: "2026-07-03", lookback_period: 30, mode: "anchored" },
    }]);
  });

  it("builds a one-symbol focused Volume Profile request and caps client controls", () => {
    expect(buildVolumeProfileRequest({
      symbol: " aaa ",
      fromDate: "2026-01-01",
      toDate: "2026-07-01",
      interval: "1d",
      currencyMode: "local",
      settings: { bucketCount: 999, priceSource: "close", valueAreaPercent: 10 },
    })).toMatchObject({
      symbols: ["AAA"],
      indicators: [{
        kind: "volume_profile",
        instrumentKeys: ["AAA"],
        parameters: { bucket_count: 200, price_source: "close", value_area_percent: 50 },
      }],
    });
  });

  it("passes the selected benchmark as a Rust parameter without calculating it in the browser", () => {
    expect(buildTechnicalIndicatorDefinitions(
      ["AAA", "SPY"],
      ["benchmark_relative_strength"],
      {},
      "SPY",
    )[0]).toMatchObject({
      kind: "benchmark_relative_strength",
      parameters: { benchmark_key: "SPY" },
    });
  });

  it("leaves interval-dependent defaults to the common Node service", () => {
    const definitions = buildTechnicalIndicatorDefinitions(
      ["AAA"],
      ["fifty_two_week_high_low_position", "historical_volatility"],
      {},
    );
    expect(definitions).toHaveLength(2);
    expect(definitions.every((definition) => definition.parameters === undefined)).toBe(true);
  });

  it("turns shared zoom into one calendar cutoff instead of per-series bar counts", () => {
    expect(visibleDateCutoff("2026-01-01", "2026-07-01", 100)).toBe("2026-01-01");
    expect(visibleDateCutoff("2026-01-01", "2026-07-01", 50)).toBe("2026-04-01");
  });

  it("maps a daily trade date to the same weekly bar without moving its actual trade date", () => {
    expect(technicalMarkerBarDate("2026-07-14", ["2026-07-10", "2026-07-17"], "1w")).toBe("2026-07-17");
    expect(technicalMarkerBarDate("2026-07-14", ["2026-07-17"], "1d")).toBeUndefined();
  });

  it("거래 marker 0건을 백필 완료 전에는 거래 없음으로 표시하지 않는다", () => {
    expect(technicalTradeMarkerStatusNotice(markerPayload("complete", "available", true))).toContain("주문 이력 complete");
    expect(technicalTradeMarkerStatusNotice(markerPayload("partial", "partial"))).toContain("0건이어도 거래 없음으로 확정할 수 없습니다");
    expect(technicalTradeMarkerStatusNotice(markerPayload("error", "unavailable"))).toContain("주문 이력 error");
    expect(technicalTradeMarkerStatusNotice(markerPayload("unavailable", "unavailable"))).toContain("데이터 unavailable");
  });

  it("uses combined-history values as percentages and restores fully sold portfolio symbols", () => {
    const history = {
      totalValue: 0,
      series: [
        { key: "KRW:AAA", symbol: "AAA", name: "Alpha", market: "KRX", currency: "KRW" },
        { key: "USD:OLD", symbol: "OLD", name: "Old holding", market: "NYSE", currency: "USD" },
      ],
      points: [{ date: "2026-07-20", totalValue: 1_000_000, values: { "KRW:AAA": 62.5, "USD:OLD": 0 } }],
    };
    expect(combinedPortfolioWeightMap(history)?.get("AAA")).toBe(62.5);
    expect(combinedPortfolioWeightMap(history)?.get("OLD")).toBe(0);
    expect(technicalInstrumentsFromPortfolioHistory(history).map((item) => item.symbol)).toEqual(["AAA", "OLD"]);
  });

  it("joins worker points to bars and only applies a display normalization to price-valued fields", () => {
    const rows = buildTechnicalChartRows(series, [calculation]);
    expect(rows[1].indicatorValues[indicatorValueKey("sma-primary", "value")]).toBe(105);
    const normalized = displayTechnicalChartRows(
      rows,
      "starting100",
      new Set([indicatorValueKey("sma-primary", "value")]),
    );
    expect(normalized[0].open).toBeCloseTo(90);
    expect(normalized[0].high).toBeCloseTo(110);
    expect(normalized[0].low).toBeCloseTo(80);
    expect(normalized[0].close).toBeCloseTo(100);
    expect(normalized[1].open).toBeCloseTo(105);
    expect(normalized[1].high).toBeCloseTo(125);
    expect(normalized[1].low).toBeCloseTo(95);
    expect(normalized[1].close).toBeCloseTo(120);
    expect(normalized[1].indicatorValues[indicatorValueKey("sma-primary", "value")]).toBeCloseTo(105);
  });

  it("keeps raw volume and worker-computed volume indicator points unchanged in price normalization mode", () => {
    const volumeSeries: TechnicalPriceSeries = {
      ...series,
      bars: series.bars.map((bar, index) => ({ ...bar, volume: (index + 1) * 1_000 })),
    };
    const volumeCalculation: TechnicalIndicatorCalculation = {
      ...calculation,
      indicator_id: "volume_sma-primary",
      kind: "volume_sma",
      points: [
        { date: "2026-07-01", state: "available", values: { value: 875.25 } },
        { date: "2026-07-02", state: "available", values: { value: 1_437.5 } },
      ],
    };
    const normalized = displayTechnicalChartRows(buildTechnicalChartRows(volumeSeries, [volumeCalculation]), "starting100", new Set());
    expect(normalized.map((row) => row.volume)).toEqual([1_000, 2_000]);
    expect(normalized.map((row) => row.indicatorValues[indicatorValueKey("volume_sma-primary", "value")])).toEqual([875.25, 1_437.5]);
  });

  it("unwraps the common envelope without deriving indicator values", () => {
    const payload = {
      run_id: "run-1",
      reused: false,
      response_mode: "full_series",
      price_series: [series],
      technical_analysis: {
        schema_version: "technical-analysis-result/v1",
        indicator_engine_version: "technical-indicators/1",
        response_mode: "full_series",
        adjustment_policy: "adjusted",
        calculations: [calculation],
      },
    } satisfies TechnicalAnalysisPayload;
    expect(unwrapTechnicalAnalysisPayload({ result: payload })).toBe(payload);
    expect(unwrapTechnicalAnalysisPayload({ result: { price_series: [] } })).toBeUndefined();
  });

  it("restores only recognized technical preset fields", () => {
    expect(normalizeTechnicalPresetConfig({
      presetType: "technical_chart_config",
      watchlist: [{ symbol: " aapl ", name: "Apple", market: "NASDAQ", currency: "USD" }],
      columns: 4,
      globalIndicators: ["sma", "made_up"],
      indicatorOverrides: { aapl: ["rsi"] },
      priceMode: "starting100",
    })).toMatchObject({
      schemaVersion: 1,
      presetType: "technical_chart_config",
      watchlist: [{ symbol: "AAPL", name: "Apple", market: "NASDAQ", currency: "USD" }],
      columns: 4,
      globalIndicators: ["sma"],
      indicatorOverrides: { AAPL: ["rsi"] },
      priceMode: "starting100",
    });
  });

  it("deduplicates and caps untrusted preset watchlists before rendering or batching", () => {
    const watchlist = [
      { symbol: " aapl ", name: "Apple first", currency: "USD" },
      { symbol: "AAPL", name: "Apple duplicate", currency: "USD" },
      ...Array.from({ length: 60 }, (_, index) => ({
        symbol: `T${String(index).padStart(3, "0")}`,
        name: `Test ${index}`,
        currency: "KRW",
      })),
    ];
    const normalized = normalizeTechnicalPresetConfig({ presetType: "technical_watchlist", watchlist });
    expect(normalized?.watchlist).toHaveLength(50);
    expect(normalized?.watchlist[0]).toMatchObject({ symbol: "AAPL", name: "Apple first" });
    expect(normalized?.watchlist.filter((item) => item.symbol === "AAPL")).toHaveLength(1);
  });

  it("persists all batch indicators plus VWAP and focused profile settings without putting profile in the batch", () => {
    const allKinds = TECHNICAL_BATCH_INDICATORS.map((option) => option.kind);
    const normalized = normalizeTechnicalPresetConfig({
      presetType: "technical_chart_config",
      watchlist: [],
      globalIndicators: allKinds,
      indicatorOverrides: { aaa: ["adx_dmi", "keltner_channel", "parabolic_sar", "choppiness_index", "volume_sma", "cmf", "accumulation_distribution_line"] },
      vwapSettings: { anchor: "recent_low", mode: "both", lookbackPeriod: 35 },
      volumeProfileSettings: { symbol: "aaa", bucketCount: 32, priceSource: "typical_price", valueAreaPercent: 68 },
    });
    expect(normalized?.globalIndicators).toEqual(allKinds);
    expect(normalized?.indicatorOverrides?.AAA).toEqual(["adx_dmi", "keltner_channel", "parabolic_sar", "choppiness_index", "volume_sma", "cmf", "accumulation_distribution_line"]);
    expect(normalized?.vwapSettings).toEqual({ anchor: "recent_low", mode: "both", lookbackPeriod: 35 });
    expect(normalized?.volumeProfileSettings).toEqual({ symbol: "AAA", bucketCount: 32, priceSource: "typical_price", valueAreaPercent: 68 });
  });
});
