import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { chromium } from "playwright";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const screenshotDirectory = process.env.TECHNICAL_UI_SCREENSHOT_DIR
  ? path.resolve(process.env.TECHNICAL_UI_SCREENSHOT_DIR)
  : "/tmp/toss-portfolio-lens-technical-ui";
const accountId = "technical-ui-account";
const fixtureDate = "2026-07-21";
const indicatorOutputs = {
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
};
const stageThreeVolumeIndicatorKinds = ["volume_sma", "relative_volume", "obv", "mfi", "cmf", "accumulation_distribution_line"];
const volumeIndicatorKinds = [...stageThreeVolumeIndicatorKinds, "vwap_anchored_vwap"];
const allIndicatorKinds = [...Object.keys(indicatorOutputs), "volume_profile"];
const indicatorPresetKinds = {
  trend: ["sma", "ema", "adx_dmi", "supertrend", "aroon", "parabolic_sar", "moving_average_distance", "choppiness_index"],
  momentum: ["rsi", "macd", "stochastic_oscillator", "roc", "cci", "williams_r"],
  volatility: ["bollinger_bands", "atr", "keltner_channel", "historical_volatility", "normalized_atr", "bollinger_band_width_percent_b"],
  breakout: ["donchian_channel", "fifty_two_week_high_low_position", "supertrend"],
  relative_performance: ["benchmark_relative_strength", "moving_average_distance", "roc"],
  volume: volumeIndicatorKinds,
};
const holdings = Array.from({ length: 22 }, (_, index) => {
  const number = index + 1;
  const symbol = `T${String(number).padStart(3, "0")}`;
  const evaluationAmount = 1_000_000 + (22 - index) * 50_000;
  const purchaseAmount = evaluationAmount / (1.04 + index * 0.002);
  const quantity = 10 + index;
  return {
    symbol,
    name: `테스트 자산 ${String(number).padStart(2, "0")}`,
    market: "KOSPI",
    currency: "KRW",
    quantity,
    availableQuantity: quantity,
    averagePrice: purchaseAmount / quantity,
    currentPrice: evaluationAmount / quantity,
    purchaseAmount,
    evaluationAmount,
    profitLoss: evaluationAmount - purchaseAmount,
    profitRate: ((evaluationAmount / purchaseAmount) - 1) * 100,
    dailyProfitLoss: evaluationAmount * 0.001,
    dailyProfitRate: 0.1,
  };
});
const totalEvaluation = holdings.reduce((sum, holding) => sum + holding.evaluationAmount, 0);
const totalPurchase = holdings.reduce((sum, holding) => sum + holding.purchaseAmount, 0);

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function round(value, digits = 6) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function previousWeekdays(toDate, count) {
  const dates = [];
  const cursor = new Date(`${toDate}T00:00:00Z`);
  while (dates.length < count) {
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return dates.reverse();
}

function portfolioFixture() {
  const account = { id: accountId, name: "기술 분석 검증 계좌", label: "기술 분석 검증 계좌", type: "STOCK" };
  return {
    asOf: `${fixtureDate}T15:30:00+09:00`,
    accounts: [account],
    selectedAccountId: accountId,
    account,
    summary: {
      evaluationAmount: { KRW: totalEvaluation, USD: 0 },
      purchaseAmount: { KRW: totalPurchase, USD: 0 },
      profitLoss: { KRW: totalEvaluation - totalPurchase, USD: 0 },
      dailyProfitLoss: { KRW: totalEvaluation * 0.001, USD: 0 },
      profitRate: ((totalEvaluation / totalPurchase) - 1) * 100,
      dailyProfitRate: 0.1,
      positionCount: holdings.length,
    },
    holdings,
  };
}

function historyFixture() {
  const series = holdings.map((holding) => ({
    key: `${holding.market}:${holding.symbol}`,
    symbol: holding.symbol,
    name: holding.name,
    market: holding.market,
    currency: "KRW",
    averageWeight: round((holding.evaluationAmount / totalEvaluation) * 100),
  }));
  const dates = previousWeekdays(fixtureDate, 12);
  return {
    accountId,
    currency: "KRW",
    includesCurrencies: ["KRW"],
    range: "all",
    generatedAt: `${fixtureDate}T15:31:00+09:00`,
    firstSnapshotDate: dates[0],
    fromDate: dates[0],
    toDate: dates.at(-1),
    series,
    points: dates.map((date, dateIndex) => ({
      date,
      capturedAt: `${date}T15:30:00+09:00`,
      origin: dateIndex === dates.length - 1 ? "LIVE" : "HISTORICAL",
      totalValue: totalEvaluation * (0.985 + dateIndex * 0.0015),
      values: Object.fromEntries(series.map((item, index) => [
        item.key,
        round((holdings[index].evaluationAmount / totalEvaluation) * 100),
      ])),
    })),
  };
}

function barsFor(symbol, toDate) {
  const dates = previousWeekdays(toDate || fixtureDate, 84);
  const symbolNumber = Number(symbol.replace(/\D/g, "")) || 7;
  const base = 30_000 + symbolNumber * 850;
  return dates.map((date, index) => {
    const trend = base * (1 + index * 0.0016);
    const close = round(trend * (1 + Math.sin(index * 0.37 + symbolNumber) * 0.012), 2);
    const open = round(close * (1 + Math.sin(index * 0.19) * 0.004), 2);
    const rawVolume = 100_000 + symbolNumber * 1_000 + index * 173;
    const volume = symbol === "T003" ? null : symbol === "T002" && index % 6 === 0 ? null : rawVolume;
    return {
      date,
      open,
      high: round(Math.max(open, close) * 1.009, 2),
      low: round(Math.min(open, close) * 0.991, 2),
      close,
      volume,
    };
  });
}

function indicatorFixtureValue(kind, field, bar, index) {
  if (kind === "vwap_anchored_vwap") return round(bar.close * (field === "vwap" ? 0.999 : 0.996), 4);
  if (kind === "volume_sma") return round((bar.volume ?? 100_000) * 0.98, 4);
  if (kind === "relative_volume") return round(1 + Math.sin(index * 0.19) * 0.45, 4);
  if (kind === "obv") return round((index + 1) * 82_000 * (index % 12 < 8 ? 1 : 0.82), 4);
  if (kind === "mfi") return round(50 + Math.sin(index * 0.23) * 35, 4);
  if (kind === "cmf") return round(Math.sin(index * 0.17) * 0.32, 6);
  if (kind === "accumulation_distribution_line") return round((index + 1) * 47_000 * Math.sin(index * 0.08 + 0.5), 4);
  if (["upper", "rolling_high"].includes(field)) return round(bar.close * 1.035, 4);
  if (["middle", "moving_average"].includes(field)) return round(bar.close * 0.998, 4);
  if (["lower", "rolling_low"].includes(field)) return round(bar.close * 0.962, 4);
  if (["supertrend", "sar"].includes(field)) return round(bar.close * (index % 18 < 9 ? 0.97 : 1.03), 4);
  if (field === "direction") return index % 18 < 9 ? 1 : -1;
  if (field === "relative_strength") return round(100 + Math.sin(index * 0.2) * 8, 4);
  if (field === "position_percent") return round(50 + Math.sin(index * 0.29) * 42, 4);
  if (field === "percent_b") return round(0.5 + Math.sin(index * 0.29) * 0.35, 4);
  if (field === "bandwidth") return round(6 + Math.sin(index * 0.17), 4);
  if (field === "value" && kind === "williams_r") return round(-50 + Math.sin(index * 0.29) * 35, 4);
  if (field === "value" && kind === "cci") return round(Math.sin(index * 0.22) * 140, 4);
  if (field === "value" && kind === "choppiness_index") return round(50 + Math.sin(index * 0.23) * 18, 4);
  if (field === "value" && ["roc", "moving_average_distance"].includes(kind)) return round(Math.sin(index * 0.21) * 9, 4);
  if (["adx", "plus_di", "minus_di", "percent_k", "percent_d", "aroon_up", "aroon_down", "value"].includes(field)) {
    return round(50 + Math.sin(index * 0.29 + field.length) * 24, 4);
  }
  if (field === "atr") return round(bar.close * 0.018, 4);
  if (["macd", "signal", "histogram", "oscillator", "distance_percent"].includes(field)) {
    return round(Math.sin(index * 0.21 + field.length) * 8, 4);
  }
  return round(bar.close, 4);
}

function volumeAvailability(series) {
  if (series.symbol === "T002") return { status: "partial", reason: "84개 bar 중 일부의 volume이 null입니다." };
  if (series.symbol === "T003") return { status: "volume_unavailable", reason: "가격 OHLC는 있으나 거래량 데이터가 없습니다." };
  if (series.symbol === "T004") return { status: "unsupported_instrument", reason: "index 유형은 거래량 지표를 지원하지 않습니다." };
  if (series.symbol === "T005") return { status: "insufficient_history", reason: "선택 period를 충족하는 연속 거래량 이력이 부족합니다." };
  return { status: "available", reason: "거래량 이력과 종목 유형을 지원합니다." };
}

function indicatorCalculation(series, definition) {
  const kind = definition.kind;
  const fields = indicatorOutputs[kind];
  check(Array.isArray(fields), `지원하지 않는 fixture 지표입니다: ${kind}`);
  const period = 8;
  const isVolumeIndicator = volumeIndicatorKinds.includes(kind);
  const availability = isVolumeIndicator ? volumeAvailability(series) : { status: "available", reason: "calculated" };
  const points = series.bars.map((bar, index) => {
    let state = index >= period - 1 ? "available" : "warmup";
    if (isVolumeIndicator) {
      if (availability.status === "volume_unavailable" || availability.status === "unsupported_instrument") state = "unavailable";
      else if (availability.status === "insufficient_history") state = "warmup";
      else if (availability.status === "partial" && (bar.volume === null || index < period - 1)) state = bar.volume === null ? "unavailable" : "warmup";
    }
    return {
      date: bar.date,
      state,
      values: Object.fromEntries(fields.map((field) => [
        field,
        state === "available" ? indicatorFixtureValue(kind, field, bar, index) : null,
      ])),
    };
  });
  const firstAvailable = points.find((point) => point.state === "available")?.date ?? null;
  const metadata = kind === "vwap_anchored_vwap" ? {
    approximate: true,
    approximation: "bar_hlc3_times_bar_volume_not_intrabar_execution_vwap",
    price_basis: "typical_price_hlc3",
    mode: definition.parameters?.mode ?? "both",
    anchor: definition.parameters?.anchor ?? "period_start",
    requested_anchor_date: definition.parameters?.anchor_date ?? null,
    resolved_anchor_date: definition.parameters?.anchor_date ?? series.bars.at(-12)?.date ?? null,
    anchor_resolution: ["user_date", "signal_date"].includes(definition.parameters?.anchor)
      ? "first_bar_on_or_after_requested_date"
      : definition.parameters?.anchor === "recent_high"
        ? "causal_trailing_high_current_inclusive_most_recent_tie"
        : definition.parameters?.anchor === "recent_low"
          ? "causal_trailing_low_current_inclusive_most_recent_tie"
          : "first_requested_bar",
    lookback_period: definition.parameters?.lookback_period ?? 20,
    future_data_used: false,
  } : undefined;
  return {
    instrument_key: series.key,
    indicator_id: definition.id,
    kind,
    parameters: definition.parameters || { period },
    availability,
    warmup: {
      required_observations: period,
      observed_observations: series.bars.filter((bar) => !isVolumeIndicator || bar.volume !== null).length,
      state: firstAvailable ? "ready" : "warming_up",
      first_available_date: firstAvailable,
    },
    ...(metadata ? { metadata } : {}),
    points,
  };
}

function volumeProfileCalculation(series, definition) {
  const requestedBucketCount = definition.parameters?.bucket_count ?? 24;
  const priceSource = definition.parameters?.price_source ?? "typical_price";
  const valueAreaPercent = definition.parameters?.value_area_percent ?? 70;
  const observations = series.bars.filter((bar) => bar.volume !== null);
  const representativePrices = observations.map((bar) => (
    priceSource === "close" ? bar.close : (bar.high + bar.low + bar.close) / 3
  ));
  const priceMin = Math.min(...representativePrices);
  const priceMax = Math.max(...representativePrices);
  const bucketWidth = (priceMax - priceMin) / requestedBucketCount;
  const rawVolumes = Array.from({ length: requestedBucketCount }, (_, index) => 40_000 + (index + 1) * 7_500 + (index === 17 ? 200_000 : 0));
  const totalVolume = rawVolumes.reduce((sum, volume) => sum + volume, 0);
  const buckets = rawVolumes.map((volume, index) => ({
    index,
    price_low: round(priceMin + bucketWidth * index, 4),
    price_high: round(priceMin + bucketWidth * (index + 1), 4),
    price_mid: round(priceMin + bucketWidth * (index + 0.5), 4),
    volume,
    volume_percent: round(volume / totalVolume * 100, 6),
    in_value_area: index >= 9 && index <= 19,
    is_point_of_control: index === 17,
  }));
  const pointOfControl = buckets[17]?.price_mid ?? buckets.at(-1).price_mid;
  const valueAreaHigh = buckets[19]?.price_high ?? buckets.at(-1).price_high;
  const valueAreaLow = buckets[9]?.price_low ?? buckets[0].price_low;
  return {
    instrument_key: series.key,
    indicator_id: definition.id,
    kind: "volume_profile",
    parameters: definition.parameters,
    availability: { status: "available", reason: "focused bar-volume profile calculated" },
    warmup: {
      required_observations: 1,
      observed_observations: observations.length,
      state: "ready",
      first_available_date: series.bars.at(-1)?.date ?? null,
    },
    metadata: {
      approximate: true,
      approximation: "each_bar_full_volume_assigned_to_one_selected_representative_price_bucket",
      price_source: priceSource,
      point_of_control_tie: "higher_price_bucket",
      maximum_bucket_count: 200,
    },
    profile: {
      schema_version: "volume-profile/v1",
      from_date: series.bars[0].date,
      to_date: series.bars.at(-1).date,
      price_source: priceSource,
      requested_bucket_count: requestedBucketCount,
      effective_bucket_count: requestedBucketCount,
      price_min: round(priceMin, 4),
      price_max: round(priceMax, 4),
      bucket_width: round(bucketWidth, 6),
      total_volume: totalVolume,
      included_observations: observations.length,
      missing_volume_observations: series.bars.length - observations.length,
      value_area_percent: valueAreaPercent,
      point_of_control: pointOfControl,
      value_area_high: valueAreaHigh,
      value_area_low: valueAreaLow,
      buckets,
      approximation: "each_bar_full_volume_assigned_to_one_selected_representative_price_bucket",
    },
    points: [{
      date: series.bars.at(-1).date,
      state: "available",
      values: {
        point_of_control: pointOfControl,
        value_area_high: valueAreaHigh,
        value_area_low: valueAreaLow,
      },
    }],
  };
}

function analysisFixture(request, runNumber) {
  const symbols = Array.isArray(request.symbols) ? request.symbols : holdings.map((holding) => holding.symbol);
  const priceSeries = symbols.map((symbol) => {
    const holding = holdings.find((item) => item.symbol === symbol);
    const custom = symbol === "CSTM";
    const market = holding?.market || (custom ? "NASDAQ" : "KOSPI");
    const currency = custom ? "USD" : "KRW";
    return {
      key: `${market}:${symbol}`,
      symbol,
      market,
      currency,
      instrument_type: symbol === "T004" ? "index" : custom ? "stock" : "etf",
      bars: barsFor(symbol, request.toDate),
    };
  });
  const definitions = Array.isArray(request.indicators) ? request.indicators : [];
  const calculations = priceSeries.flatMap((series) => definitions
    .filter((definition) => !Array.isArray(definition.instrumentKeys) || definition.instrumentKeys.includes(series.symbol))
    .map((definition) => indicatorCalculation(series, definition)));
  return {
    result: {
      run_id: `technical-ui-run-${runNumber}`,
      reused: false,
      response_mode: "full_series",
      price_series: priceSeries,
      technical_analysis: {
        schema_version: "technical-analysis-result/v1",
        indicator_engine_version: "technical-indicators/1.5.0",
        response_mode: "full_series",
        adjustment_policy: "adjusted",
        calculations,
        diagnostics: { fixture: true, symbol_count: symbols.length },
      },
      artifact_index: [],
    },
  };
}

function volumeProfileFixture(request, runNumber) {
  const symbol = request.symbols[0];
  const holding = holdings.find((item) => item.symbol === symbol);
  const market = holding?.market || "NASDAQ";
  const currency = holding ? "KRW" : "USD";
  const series = {
    key: `${market}:${symbol}`,
    symbol,
    market,
    currency,
    instrument_type: holding ? "etf" : "stock",
    bars: barsFor(symbol, request.toDate),
  };
  const calculation = volumeProfileCalculation(series, request.indicators[0]);
  return {
    result: {
      run_id: `technical-ui-profile-${runNumber}`,
      reused: false,
      response_mode: "full_series",
      price_series: [series],
      technical_analysis: {
        schema_version: "technical-analysis-result/v1",
        indicator_engine_version: "technical-indicators/1.5.0",
        response_mode: "full_series",
        adjustment_policy: "adjusted",
        calculations: [calculation],
        diagnostics: { fixture: true, symbol_count: 1, profile_bucket_count: calculation.profile.buckets.length },
      },
      artifact_index: [],
    },
  };
}

function tradeMarkersFixture(symbols, toDate) {
  const symbol = symbols[0] || holdings[0].symbol;
  const bars = barsFor(symbol, toDate);
  const date = bars.at(-8).date;
  return {
    schema_version: "technical-trade-markers/v1",
    account_id: accountId,
    generated_at: `${fixtureDate}T15:32:00+09:00`,
    policies: { weight: "filled_amount_krw / prior_daily_snapshot_total_value", precision: "estimated" },
    metadata: {
      order_history: {
        status: "complete",
        marker_data_availability: "available",
        complete: true,
        phase: "complete",
        updated_at: `${fixtureDate}T15:30:00+09:00`,
        first_trade_date: date,
        last_backfilled_date: fixtureDate,
        orders_imported: 2,
        failed_symbols: 0,
        message: "fixture order history complete",
      },
    },
    markers: [{
      id: `${symbol}:${date}:buy`,
      symbol,
      date,
      side: "buy",
      order_count: 2,
      execution_count: null,
      execution_count_reason: "individual_executions_not_persisted",
      filled_quantity: 3,
      average_filled_price: 51_000,
      filled_amount: 153_000,
      currency: "KRW",
      filled_amount_krw: { status: "estimated", value: 153_000, fx_rate: 1, fx_rate_date: date, fx_rate_status: "identity" },
      trade_weight: { status: "estimated", percent: 0.61, numerator_krw: 153_000, denominator_krw: 25_000_000, valuation_date: bars.at(-9).date },
      position_weight: { status: "estimated", before_percent: 4.2, after_percent: 4.81, before_snapshot_date: bars.at(-9).date, after_snapshot_date: date },
      details: [{
        order_id: "fixture-order-1",
        ordered_at: `${date}T09:05:00+09:00`,
        filled_at: `${date}T09:06:00+09:00`,
        filled_quantity: 3,
        average_filled_price: 51_000,
        filled_amount: 153_000,
        commission: 23,
        tax: 0,
        status: "FILLED",
      }],
    }],
    diagnostics: {
      stored_order_count: 2,
      included_order_count: 2,
      skipped_unfilled_or_invalid_count: 0,
      filtered_out_count: 0,
      marker_count: 1,
      estimated_weight_count: 1,
      unavailable_weight_count: 0,
      order_history_status: "complete",
      marker_data_availability: "available",
      marker_count_complete: true,
    },
  };
}

function backtestInstruments(symbols) {
  return symbols.map((symbol) => {
    const holding = holdings.find((item) => item.symbol === symbol);
    return {
      symbol,
      name: holding?.name || symbol,
      market: holding?.market || "KOSPI",
      currency: holding?.currency || "KRW",
      listDate: "2020-01-02",
      securityType: "ETF",
      status: "ACTIVE",
    };
  });
}

function technicalBacktestFixture(request, runNumber) {
  const dates = previousWeekdays(request.backtest.endDate, 24);
  const instruments = backtestInstruments(request.analysis.symbols);
  const assets = instruments.map((instrument, index) => ({
    ...instrument,
    weight: request.backtest.assets[index]?.weight ?? 0,
    lotSize: 1,
  }));
  const metrics = {
    finalBalance: 11_250_000,
    totalContributions: request.backtest.initialAmount,
    totalWithdrawals: 0,
    endingCashBalance: 450_000,
    endingCashWeightPercent: 4,
    investedBalance: 10_800_000,
    totalTransactionCosts: 8_500,
    netProfitLoss: 1_250_000,
    moneyWeightedReturnPercent: 12.5,
    totalReturnPercent: 12.5,
    cagrPercent: 12.5,
    annualizedVolatilityPercent: 14.2,
    maxDrawdownPercent: -6.4,
    maxDrawdownDays: 12,
    sharpeRatio: 0.88,
    sortinoRatio: 1.14,
    calmarRatio: 1.95,
    bestDailyReturnPercent: 2.1,
    worstDailyReturnPercent: -1.8,
    positiveDaysPercent: 54,
    bestYearPercent: 12.5,
    worstYearPercent: 12.5,
    positiveMonthsPercent: 66.7,
  };
  const firstSymbol = request.analysis.symbols[0];
  const signal = {
    signal_id: `technical-signal-${runNumber}`,
    calculation_date: dates.at(-5),
    signal_date: dates.at(-5),
    planned_trade_date: dates.at(-4),
    actual_application_date: dates.at(-3),
    transition: "activate",
    from_state: "inactive",
    to_state: "active",
    target_weights: request.strategy.allocations.active.weights,
    cash_target_percent: request.strategy.allocations.active.cashPercent,
    status: "applied",
  };
  const plannedSignal = {
    ...signal,
    signal_id: `technical-signal-${runNumber}-planned`,
    calculation_date: dates.at(-2),
    signal_date: dates.at(-2),
    planned_trade_date: dates.at(-1),
    actual_application_date: null,
    transition: "deactivate",
    from_state: "active",
    to_state: "inactive",
    status: "planned",
  };
  const noSafeDateSignal = {
    ...plannedSignal,
    signal_id: `technical-signal-${runNumber}-no-safe-date`,
    calculation_date: dates.at(-1),
    signal_date: dates.at(-1),
    planned_trade_date: null,
    status: "no_safe_trade_date",
  };
  return {
    result: {
      run_id: `technical-strategy-run-${runNumber}`,
      reused: false,
      technical_analysis: { indicator_engine_version: "technical-indicators/1.5.0" },
      technical_strategy: { signals: [signal, plannedSignal, noSafeDateSignal], target_weight_schedule: [] },
      artifact_index: [{ type: "technical-signals" }],
      backtest: {
        runId: `technical-strategy-run-${runNumber}`,
        generatedAt: `${fixtureDate}T15:40:00+09:00`,
        baseCurrency: "KRW",
        currencyMethod: "KRW_FX_CONVERTED",
        requestedStartDate: request.backtest.startDate,
        effectiveStartDate: request.backtest.startDate,
        endDate: request.backtest.endDate,
        config: {
          ...request.backtest,
          requestedStartDate: request.backtest.startDate,
          latestMetadataListDate: "2020-01-02",
          effectiveStartDate: request.backtest.startDate,
          effectiveEndDate: request.backtest.endDate,
        },
        assets,
        warnings: ["기술 신호는 종가 계산 다음 안전 거래일에 적용됩니다."],
        points: dates.map((date, index) => ({ date, balance: 10_000_000 + index * 54_347, growth: 100 + index * 0.54, drawdownPercent: index % 9 === 0 ? -1.2 : -0.2, cashBalance: 450_000, investedBalance: 9_550_000 + index * 54_347, unitPrice: 100 + index * 0.54 })),
        metrics,
        annualReturns: [{ year: Number(request.backtest.endDate.slice(0, 4)), returnPercent: 12.5 }],
        contributions: assets.map((asset, index) => ({ symbol: asset.symbol, name: asset.name, market: asset.market, currency: asset.currency, weight: asset.weight, endingValue: index === 0 ? 10_800_000 : 0, profitLoss: index === 0 ? 800_000 : 0, contributionPercent: index === 0 ? 8 : 0, timeLinkedContributionPercent: index === 0 ? 8 : 0, localPriceContributionPercent: index === 0 ? 8 : 0, fxContributionPercent: 0, assetReturnPercent: index === 0 ? 12.5 : 0 })),
        correlations: { assets: assets.map((asset) => ({ symbol: asset.symbol, name: asset.name })), values: assets.map((_, row) => assets.map((__, column) => row === column ? 1 : 0.25)) },
        trades: [{ date: signal.actual_application_date, symbol: firstSymbol, side: "BUY", amount: 9_500_000, quantity: 10, price: 950_000, reason: "technical_signal", trigger: "technical_signal" }],
        cashFlows: [],
        execution: request.backtest.execution,
        dataQuality: { alignmentPolicy: "carry_forward_for_valuation", commonReturnPolicy: "inner_join", alignedValuationDays: dates.length, commonReturnObservations: dates.length - 1, carryForwardByAsset: assets.map((asset) => ({ symbol: asset.symbol, count: 0 })), benchmarkCarryForwardCount: 0 },
      },
    },
  };
}

function observePage(page) {
  const failures = { console: [], page: [], requests: [], responses: [] };
  page.on("console", (message) => {
    if (message.type() === "error") failures.console.push(message.text());
  });
  page.on("pageerror", (error) => failures.page.push(error.message));
  page.on("requestfailed", (request) => {
    failures.requests.push(`${request.method()} ${request.url()} (${request.failure()?.errorText || "unknown"})`);
  });
  page.on("response", (response) => {
    if (response.status() >= 400) failures.responses.push(`${response.status()} ${response.request().method()} ${response.url()}`);
  });
  return failures;
}

export async function routeTechnicalUiApi(page) {
  const state = {
    analyzeRequests: [],
    profileRequests: [],
    searchRequests: 0,
    presetCreates: [],
    tradeRequests: [],
    instrumentRequests: [],
    validateRequests: [],
    technicalBacktestRequests: [],
    delayNextTechnicalRun: false,
    presets: [],
  };
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const fulfill = (value, status = 200) => route.fulfill({
      status,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify(value),
    });
    if (url.pathname === "/api/auth/session") return fulfill({ authenticated: true });
    if (url.pathname === "/api/auth/logout") return fulfill({ ok: true });
    if (url.pathname === "/api/portfolio") return fulfill(portfolioFixture());
    if (url.pathname === "/api/portfolio/history") {
      if (url.searchParams.get("range") !== "all" || url.searchParams.get("currency") !== "ALL") {
        return fulfill({ error: { code: "invalid-history-request", message: "기술적 분석은 전체 통합 이력을 요청해야 합니다." } }, 400);
      }
      return fulfill(historyFixture());
    }
    if (url.pathname === "/api/portfolio/tools/search_instruments" && request.method() === "POST") {
      state.searchRequests += 1;
      return fulfill({ result: { instruments: [{ symbol: "CSTM", name: "사용자 지정 검증 종목", market: "NASDAQ", currency: "USD", assetType: "stock" }] } });
    }
    if (url.pathname === "/api/portfolio/backtest/instruments" && request.method() === "GET") {
      const symbols = (url.searchParams.get("symbols") || "").split(",").map((item) => item.trim()).filter(Boolean);
      state.instrumentRequests.push(symbols);
      return fulfill({ instruments: backtestInstruments(symbols) });
    }
    if (url.pathname === "/api/portfolio/tools/validate_technical_strategy" && request.method() === "POST") {
      const body = request.postDataJSON();
      if (!body.analysis || !body.strategy?.entryCondition || !body.strategy?.exitCondition || !body.backtest || body.backtest.targetWeightSchedule?.length || body.backtest.rebalanceFrequency !== "none") {
        return fulfill({ error: { code: "invalid-technical-strategy", message: "camelCase strategy와 빈 수동 schedule이 필요합니다." } }, 400);
      }
      state.validateRequests.push(body);
      return fulfill({ result: { valid: true, errors: [], warnings: ["fixture validation passed"] } });
    }
    if (url.pathname === "/api/portfolio/tools/run_technical_strategy_backtest" && request.method() === "POST") {
      const body = request.postDataJSON();
      if (!body.analysis || !body.strategy?.entryCondition || !body.strategy?.exitCondition || !body.backtest || body.backtest.targetWeightSchedule?.length || body.backtest.rebalanceFrequency !== "none") {
        return fulfill({ error: { code: "invalid-technical-strategy-run", message: "combined technical strategy 요청이 아닙니다." } }, 400);
      }
      state.technicalBacktestRequests.push(body);
      if (state.delayNextTechnicalRun) {
        state.delayNextTechnicalRun = false;
        await new Promise((resolve) => setTimeout(resolve, 450));
      }
      return fulfill(technicalBacktestFixture(body, state.technicalBacktestRequests.length));
    }
    if (url.pathname === "/api/portfolio/tools/analyze_technical_signals" && request.method() === "POST") {
      const body = request.postDataJSON();
      const kinds = Array.isArray(body.indicators) ? body.indicators.map((indicator) => indicator.kind) : [];
      if (kinds.length === 1 && kinds[0] === "volume_profile") {
        const definition = body.indicators[0];
        if (
          body.responseMode !== "full_series"
          || body.symbols?.length !== 1
          || definition.instrumentKeys?.length !== 1
          || definition.instrumentKeys[0] !== body.symbols[0]
          || definition.parameters?.bucket_count < 5
          || definition.parameters?.bucket_count > 200
        ) {
          return fulfill({ error: { code: "invalid-volume-profile-request", message: "Volume Profile은 5~200 bucket의 단일 종목 집중 요청이어야 합니다." } }, 400);
        }
        state.profileRequests.push(body);
        return fulfill(volumeProfileFixture(body, state.profileRequests.length));
      }
      if (
        body.responseMode !== "full_series"
        || !kinds.length
        || kinds.length > 30
        || kinds.some((kind) => !indicatorOutputs[kind])
      ) {
        return fulfill({ error: { code: "invalid-analysis-request", message: "지원되는 30개 batch 지표의 full-series 요청이 아닙니다." } }, 400);
      }
      state.analyzeRequests.push(body);
      return fulfill(analysisFixture(body, state.analyzeRequests.length));
    }
    if (url.pathname === "/api/portfolio/technical/trades") {
      const symbols = (url.searchParams.get("symbols") || "").split(",").filter(Boolean);
      state.tradeRequests.push(symbols);
      return fulfill(tradeMarkersFixture(symbols, url.searchParams.get("to") || fixtureDate));
    }
    if (url.pathname === "/api/portfolio/presets" && request.method() === "GET") {
      return fulfill({ result: { items: state.presets } });
    }
    if (url.pathname === "/api/portfolio/presets" && request.method() === "POST") {
      const body = request.postDataJSON();
      if (
        body.source?.type !== "manual"
        || !["technical_watchlist", "technical_chart_config", "technical_signal_strategy"].includes(body.config?.presetType)
      ) {
        return fulfill({ error: { code: "invalid-preset-contract", message: "지원되는 기술적 분석 프리셋이 아닙니다." } }, 400);
      }
      const preset = {
        id: `technical-preset-${state.presets.length + 1}`,
        name: body.name,
        description: body.description,
        tags: body.tags,
        symbols: body.symbols,
        source: body.source,
        config: body.config,
        version: 1,
        createdAt: `${fixtureDate}T15:33:00+09:00`,
        updatedAt: `${fixtureDate}T15:33:00+09:00`,
      };
      state.presets.push(preset);
      state.presetCreates.push(body);
      return fulfill({ result: { preset } }, 201);
    }
    const presetMatch = url.pathname.match(/^\/api\/portfolio\/presets\/([^/]+)$/);
    if (presetMatch && request.method() === "GET") {
      const id = decodeURIComponent(presetMatch[1]);
      const preset = state.presets.find((item) => item.id === id);
      return preset
        ? fulfill({ result: { preset, history: [] } })
        : fulfill({ error: { code: "preset-not-found", message: "프리셋을 찾을 수 없습니다." } }, 404);
    }
    return fulfill({ error: { code: "technical-ui-route-missing", message: `fixture가 없는 API 경로입니다: ${url.pathname}` } }, 404);
  });
  return state;
}

async function selectFourColumns(page) {
  const layoutLabel = page.locator("label").filter({ hasText: "레이아웃" }).first();
  await layoutLabel.getByRole("combobox").click();
  await page.getByRole("option", { name: "4열", exact: true }).click();
}

async function selectedGlobalIndicatorKinds(page) {
  return page.locator("[data-technical-indicator]").evaluateAll((nodes) => Array.from(new Set(nodes
    .filter((node) => !node.closest("[data-technical-symbol]") && node.getAttribute("aria-pressed") === "true")
    .map((node) => node.getAttribute("data-technical-indicator"))
    .filter(Boolean))).sort());
}

async function assertStageFourIndicatorCatalog(page) {
  const kinds = await page.locator("[data-technical-indicator]").evaluateAll((nodes) => Array.from(new Set(nodes
    .filter((node) => !node.closest("[data-technical-symbol]"))
    .map((node) => node.getAttribute("data-technical-indicator"))
    .filter(Boolean))).sort());
  check(kinds.length === 31, `기술 지표 control은 batch 30개와 focused 1개를 합쳐 정확히 31개여야 합니다: ${JSON.stringify(kinds)}`);
  check(allIndicatorKinds.every((kind) => kinds.includes(kind)), "Stage4까지의 31개 지표 control 일부가 누락됐습니다.");
  check(await page.locator('[data-technical-indicator="volume_profile"]').getAttribute("aria-pressed") === null, "Volume Profile focused badge가 batch toggle로 노출됐습니다.");
}

async function exerciseStageTwoPresets(page, state) {
  for (const [key, expectedKinds] of Object.entries(indicatorPresetKinds)) {
    await page.locator(`[data-technical-indicator-preset="${key}"]`).click();
    const selected = await selectedGlobalIndicatorKinds(page);
    check(JSON.stringify(selected) === JSON.stringify([...expectedKinds].sort()), `${key} preset 구성이 다릅니다: ${JSON.stringify(selected)}`);
  }
  await page.locator('[data-technical-indicator-preset="volatility"]').click();
  await page.getByRole("button", { name: "분석 실행", exact: true }).click();
  await page.getByText("adjusted · run technical-ui-run-2", { exact: true }).waitFor();
  check(state.analyzeRequests.length === 2, "Stage2/3 category preset 분석이 단일 추가 batch가 아닙니다.");
  const requested = state.analyzeRequests.at(-1).indicators.map((indicator) => indicator.kind).sort();
  check(JSON.stringify(requested) === JSON.stringify([...indicatorPresetKinds.volatility].sort()), "변동성 preset batch kind가 UI 선택과 다릅니다.");
  const firstCard = page.locator("[data-technical-symbol]").first();
  await firstCard.getByText("Keltner · 사용 가능", { exact: true }).waitFor();
  await firstCard.locator('[data-technical-indicator-panel="historical_volatility"]').waitFor();
  await page.getByRole("button", { name: "변화율 선택", exact: true }).click();
  await page.locator("[data-technical-indicator-mode]").filter({ hasText: "사용자 정의" }).waitFor();
}

async function exerciseStageFourVwapAndProfile(page, state) {
  await page.locator('[data-technical-indicator-preset="volume"]').click();
  await page.getByRole("combobox", { name: "Anchored VWAP anchor", exact: true }).click();
  await page.getByRole("option", { name: "최근 고점", exact: true }).click();
  await page.getByLabel("Anchored VWAP lookback 봉 수").fill("34");

  let previousBatchCount = state.analyzeRequests.length;
  await page.getByRole("button", { name: "분석 실행", exact: true }).click();
  await page.getByText(`adjusted · run technical-ui-run-${previousBatchCount + 1}`, { exact: true }).waitFor();
  check(state.analyzeRequests.length === previousBatchCount + 1, "최근 고점 VWAP 분석이 단일 batch 요청이 아닙니다.");
  let request = state.analyzeRequests.at(-1);
  let definition = request.indicators.find((indicator) => indicator.kind === "vwap_anchored_vwap");
  check(request.symbols.length === 22, "VWAP batch에 포트폴리오 22개 종목이 모두 포함되지 않았습니다.");
  check(request.indicators.length <= 30 && !request.indicators.some((indicator) => indicator.kind === "volume_profile"), "focused Volume Profile이 다종목 batch에 혼입됐습니다.");
  check(definition?.parameters?.anchor === "recent_high", "VWAP 최근 고점 anchor가 worker 요청에 보존되지 않았습니다.");
  check(definition?.parameters?.lookback_period === 34, "VWAP causal lookback이 worker 요청에 보존되지 않았습니다.");
  check(definition?.parameters?.mode === "both", "VWAP + Anchored VWAP 모드가 worker 요청에 보존되지 않았습니다.");
  const firstCard = page.locator('[data-technical-symbol="T001"]');
  const recentHighMetadata = await firstCard.locator("[data-technical-vwap-metadata]").textContent();
  check(recentHighMetadata?.includes("anchor recent_high") && recentHighMetadata.includes("future data false"), `VWAP causal metadata가 카드에 표시되지 않았습니다: ${recentHighMetadata || "missing"}`);

  await page.getByLabel("VWAP 표시 모드").click();
  await page.getByRole("option", { name: "Anchored VWAP", exact: true }).click();
  await page.getByRole("combobox", { name: "Anchored VWAP anchor", exact: true }).click();
  await page.getByRole("option", { name: "신호 발생일", exact: true }).click();
  await page.getByLabel("Anchored VWAP anchor 날짜").fill("2026-05-15");
  previousBatchCount = state.analyzeRequests.length;
  await page.getByRole("button", { name: "분석 실행", exact: true }).click();
  await page.getByText(`adjusted · run technical-ui-run-${previousBatchCount + 1}`, { exact: true }).waitFor();
  request = state.analyzeRequests.at(-1);
  definition = request.indicators.find((indicator) => indicator.kind === "vwap_anchored_vwap");
  check(definition?.parameters?.anchor === "signal_date", "VWAP 신호 발생일 anchor가 worker 요청에 보존되지 않았습니다.");
  check(definition?.parameters?.anchor_date === "2026-05-15", "VWAP 신호 발생일 날짜가 worker 요청에 보존되지 않았습니다.");
  check(definition?.parameters?.mode === "anchored", "Anchored VWAP 전용 모드가 worker 요청에 보존되지 않았습니다.");
  const signalDateMetadata = await firstCard.locator("[data-technical-vwap-metadata]").textContent();
  check(signalDateMetadata?.includes("anchor signal_date") && signalDateMetadata.includes("resolved 2026-05-15"), `VWAP signal_date metadata가 카드에 표시되지 않았습니다: ${signalDateMetadata || "missing"}`);

  const focused = page.locator("[data-technical-volume-profile]");
  await focused.scrollIntoViewIfNeeded();
  await page.getByLabel("Volume Profile 집중 종목").click();
  await page.getByRole("option", { name: "T001 · 테스트 자산 01", exact: true }).click();
  await page.getByLabel("Volume Profile bucket 수").fill("24");
  await page.getByLabel("Volume Profile 가격 source").click();
  await page.getByRole("option", { name: "종가", exact: true }).click();
  await page.getByLabel("Volume Profile value area 비율").fill("68");
  const mainBatchCount = state.analyzeRequests.length;
  await page.getByRole("button", { name: "Volume Profile 집중 분석 실행", exact: true }).click();
  const result = focused.locator("[data-technical-volume-profile-result]");
  await result.waitFor();
  check(state.analyzeRequests.length === mainBatchCount, "Volume Profile 집중 분석이 일반 다종목 batch 상태를 덮어썼습니다.");
  check(state.profileRequests.length === 1, "Volume Profile 집중 분석 요청이 정확히 한 번 호출되지 않았습니다.");
  const profileRequest = state.profileRequests[0];
  const profileDefinition = profileRequest.indicators[0];
  check(profileRequest.symbols.length === 1 && profileRequest.symbols[0] === "T001", "Volume Profile 요청이 단일 선택 종목으로 제한되지 않았습니다.");
  check(profileDefinition.kind === "volume_profile" && profileDefinition.instrumentKeys?.[0] === "T001", "Volume Profile 명시적 target 계약이 보존되지 않았습니다.");
  check(profileDefinition.parameters.bucket_count === 24, "Volume Profile bucket 수가 worker 요청에 보존되지 않았습니다.");
  check(profileDefinition.parameters.price_source === "close", "Volume Profile 가격 source가 worker 요청에 보존되지 않았습니다.");
  check(profileDefinition.parameters.value_area_percent === 68, "Volume Profile Value Area 비율이 worker 요청에 보존되지 않았습니다.");
  check(await result.getAttribute("data-bucket-count") === "24", "Volume Profile 결과의 bucket 수 metadata가 24가 아닙니다.");
  check(await result.locator("[data-volume-profile-bucket]").count() === 24, "Volume Profile 가격 구간별 거래량 bucket 24개가 렌더링되지 않았습니다.");
  check(await result.locator('[data-point-of-control="true"]').count() === 1, "Volume Profile POC bucket이 정확히 하나가 아닙니다.");
  check(await result.locator('[data-in-value-area="true"]').count() > 1, "Volume Profile Value Area bucket이 렌더링되지 않았습니다.");
  for (const selector of ["[data-volume-profile-poc]", "[data-volume-profile-vah]", "[data-volume-profile-val]"]) {
    const level = (await result.locator(selector).textContent())?.trim();
    check(level && !level.includes("unavailable"), `worker Volume Profile level ${selector}가 표시되지 않았습니다.`);
  }
  await result.getByText("each_bar_full_volume_assigned_to_one_selected_representative_price_bucket", { exact: true }).waitFor();
  await result.getByText("일봉 근사치", { exact: true }).waitFor();
}

async function assertVolumeAvailabilityCards(page, state, previousBatchCount) {
  check(state.analyzeRequests.length === previousBatchCount + 1, "거래량 지표 분석이 하나의 추가 batch 요청이 아닙니다.");
  const lastRequest = state.analyzeRequests.at(-1);
  const expectedKinds = [...volumeIndicatorKinds, "roc"].sort();
  check(lastRequest.symbols.length === 23, "거래량 batch에 포트폴리오와 사용자 지정 종목 23개가 모두 포함되지 않았습니다.");
  check(JSON.stringify(lastRequest.indicators.map((indicator) => indicator.kind).sort()) === JSON.stringify(expectedKinds), "거래량 custom 구성의 batch kind가 UI 선택과 다릅니다.");

  const expectations = {
    T001: "available",
    T002: "partial",
    T003: "volume_unavailable",
    T004: "unsupported_instrument",
    T005: "insufficient_history",
  };
  for (const [symbol, status] of Object.entries(expectations)) {
    const card = page.locator(`[data-technical-symbol="${symbol}"]`);
    await card.locator(`[data-technical-volume-indicator="volume_sma"][data-technical-availability="${status}"]`).waitFor();
    const statusText = await card.locator("[data-technical-volume-availability]").textContent();
    check(statusText?.includes(status), `${symbol} 카드에서 ${status} 원문 상태를 식별할 수 없습니다.`);
  }

  const availableCard = page.locator('[data-technical-symbol="T001"]');
  for (const kind of stageThreeVolumeIndicatorKinds) {
    const placement = kind === "volume_sma" ? "volume-overlay" : "indicator-panel";
    await availableCard.locator(`[data-technical-indicator-panel="${kind}"][data-technical-panel-placement="${placement}"]`).waitFor();
  }
  await availableCard.locator('[data-technical-volume-indicator="vwap_anchored_vwap"][data-technical-availability="available"]').waitFor();
  await availableCard.locator("[data-technical-vwap-metadata]").waitFor();

  const unavailableCard = page.locator('[data-technical-symbol="T003"]');
  await unavailableCard.locator("[data-technical-price-chart] svg.recharts-surface").waitFor();
  check(await unavailableCard.locator("[data-candle-direction]").count() > 0, "거래량 unavailable 종목의 가격 candle이 사라졌습니다.");
  check(await unavailableCard.locator('[data-technical-indicator-panel="volume_sma"]').count() === 0, "거래량 unavailable 지표가 빈 패널을 만들어 가격 chart를 방해합니다.");
}

async function exerciseMobileVolumeRendering(page, state) {
  const previousBatchCount = state.analyzeRequests.length;
  await page.locator('[data-technical-indicator-preset="volume"]').click();
  await page.getByRole("button", { name: "분석 실행", exact: true }).click();
  await page.getByText(`adjusted · run technical-ui-run-${previousBatchCount + 1}`, { exact: true }).waitFor();
  check(state.analyzeRequests.length === previousBatchCount + 1, "모바일 거래량 분석이 단일 추가 batch가 아닙니다.");
  const request = state.analyzeRequests.at(-1);
  check(request.symbols.length === 22, "모바일 거래량 batch에 초기 22개 종목이 모두 포함되지 않았습니다.");
  check(
    JSON.stringify(request.indicators.map((indicator) => indicator.kind).sort()) === JSON.stringify([...volumeIndicatorKinds].sort()),
    "모바일 거래량 preset batch kind가 다릅니다.",
  );

  const expectations = {
    T001: "available",
    T002: "partial",
    T003: "volume_unavailable",
    T004: "unsupported_instrument",
    T005: "insufficient_history",
  };
  for (const [symbol, status] of Object.entries(expectations)) {
    const card = page.locator(`[data-technical-symbol="${symbol}"]`);
    await card.locator(`[data-technical-volume-indicator="volume_sma"][data-technical-availability="${status}"]`).waitFor();
    check((await card.locator("[data-technical-volume-availability]").textContent())?.includes(status), `모바일 ${symbol}에서 ${status}를 식별할 수 없습니다.`);
  }

  const availableCard = page.locator('[data-technical-symbol="T001"]');
  await availableCard.scrollIntoViewIfNeeded();
  await availableCard.locator("[data-technical-chart]").waitFor();
  for (const kind of stageThreeVolumeIndicatorKinds) {
    const placement = kind === "volume_sma" ? "volume-overlay" : "indicator-panel";
    await availableCard.locator(`[data-technical-indicator-panel="${kind}"][data-technical-panel-placement="${placement}"]`).waitFor();
  }
  await availableCard.locator('[data-technical-volume-indicator="vwap_anchored_vwap"][data-technical-availability="available"]').waitFor();
  await availableCard.locator("[data-technical-vwap-metadata]").waitFor();
  const unavailableCard = page.locator('[data-technical-symbol="T003"]');
  await unavailableCard.scrollIntoViewIfNeeded();
  await unavailableCard.locator("[data-technical-price-chart] svg.recharts-surface").waitFor();
  check(await unavailableCard.locator("[data-candle-direction]").count() > 0, "모바일 거래량 unavailable 종목의 가격 candle이 사라졌습니다.");
  check(await unavailableCard.locator("[data-technical-indicator-panel]").count() === 0, "모바일 거래량 unavailable 종목에 빈 indicator panel이 남았습니다.");
}

async function gridGeometry(page) {
  return page.locator("[data-technical-chart-grid]").evaluate((grid) => {
    const cards = Array.from(grid.querySelectorAll("[data-technical-symbol]"));
    return {
      template: getComputedStyle(grid).gridTemplateColumns,
      boxes: cards.slice(0, 5).map((card) => {
        const box = card.getBoundingClientRect();
        return { x: box.x, y: box.y, width: box.width, height: box.height };
      }),
    };
  });
}

async function assertNoOverflow(page, label) {
  const overflow = await page.evaluate(() => {
    const scrollWidth = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
    return scrollWidth - document.documentElement.clientWidth;
  });
  check(overflow === 0, `${label} 가로 overflow가 ${overflow}px 발생했습니다.`);
  return overflow;
}

async function assertRenderedChartsHaveSize(page, label) {
  const dimensions = await page.locator("[data-technical-chart] svg.recharts-surface").evaluateAll((nodes) => (
    nodes.map((node) => {
      const box = node.getBoundingClientRect();
      return { width: box.width, height: box.height };
    })
  ));
  check(dimensions.length >= 2, `${label}에서 가격·RSI 차트 SVG를 찾지 못했습니다.`);
  check(dimensions.every(({ width, height }) => width > 1 && height > 1), `${label}에서 zero-size 차트를 발견했습니다: ${JSON.stringify(dimensions)}`);
  return dimensions.length;
}

async function exerciseCustomPreset(page, state) {
  const search = page.getByLabel("사용자 지정 종목 검색");
  await search.fill("CSTM");
  await page.getByRole("button", { name: "CSTM 사용자 지정 종목 추가" }).waitFor();
  await page.getByRole("button", { name: "CSTM 사용자 지정 종목 추가" }).click();
  await page.getByRole("list", { name: "사용자 지정 종목 목록" }).getByText("CSTM", { exact: true }).waitFor();

  await page.locator('[data-technical-indicator-preset="volume"]').click();
  await page.getByRole("button", { name: "변화율 선택", exact: true }).click();
  await page.locator("[data-technical-indicator-mode]").filter({ hasText: "사용자 정의" }).waitFor();
  const previousBatchCount = state.analyzeRequests.length;
  await page.getByRole("button", { name: "분석 실행", exact: true }).click();
  await page.getByRole("heading", { name: "23개 종목 동시 비교", exact: true }).waitFor();
  await page.getByText(`adjusted · run technical-ui-run-${previousBatchCount + 1}`, { exact: true }).waitFor();
  await assertVolumeAvailabilityCards(page, state, previousBatchCount);

  await page.getByPlaceholder("새 프리셋 이름").fill("UI 종목 목록 프리셋");
  await page.getByRole("button", { name: "기술적 분석 종목 목록 프리셋 저장" }).click();
  await page.getByText("사용자 지정 종목 목록을 저장했습니다.", { exact: true }).waitFor();
  check(state.presetCreates.length === 1, "종목 목록 프리셋 POST가 정확히 한 번 호출되지 않았습니다.");
  check(state.presetCreates[0].source?.type === "manual", "종목 목록 프리셋 source.type이 manual이 아닙니다.");
  check(state.presetCreates[0].config.presetType === "technical_watchlist", "종목 목록 presetType이 technical_watchlist가 아닙니다.");
  check(state.presetCreates[0].config.watchlist.some((item) => item.symbol === "CSTM"), "저장한 종목 목록에 사용자 지정 종목이 없습니다.");

  await page.getByPlaceholder("새 프리셋 이름").fill("UI 게이트 프리셋");
  await page.getByRole("button", { name: "기술적 분석 차트 구성 프리셋 저장" }).click();
  await page.getByText("지표·차트 구성을 저장했습니다.", { exact: true }).waitFor();
  check(state.presetCreates.length === 2, "차트 구성 프리셋 POST가 정확히 한 번 추가되지 않았습니다.");
  const chartPreset = state.presetCreates[1];
  check(chartPreset.source?.type === "manual", "차트 프리셋 source.type이 공개 계약의 manual이 아닙니다.");
  check(chartPreset.config.presetType === "technical_chart_config", "차트 프리셋 config.presetType이 technical_chart_config가 아닙니다.");
  check(chartPreset.config.watchlist.some((item) => item.symbol === "CSTM"), "저장한 차트 프리셋에 사용자 지정 종목이 없습니다.");
  check(chartPreset.config.columns === 4, "저장한 프리셋에 4열 구성이 보존되지 않았습니다.");
  check(volumeIndicatorKinds.every((kind) => chartPreset.config.globalIndicators.includes(kind)), "저장한 프리셋에 Stage4 거래량·VWAP 지표 구성이 모두 보존되지 않았습니다.");
  check(chartPreset.config.globalIndicators.includes("roc"), "저장한 거래량+가격 사용자 정의 지표 구성이 보존되지 않았습니다.");
  check(chartPreset.config.vwapSettings?.anchor === "signal_date" && chartPreset.config.vwapSettings?.anchorDate === "2026-05-15", "저장한 프리셋에 Anchored VWAP 신호일 설정이 보존되지 않았습니다.");
  check(chartPreset.config.volumeProfileSettings?.symbol === "T001", "저장한 프리셋에 Volume Profile 집중 종목이 보존되지 않았습니다.");
  check(chartPreset.config.volumeProfileSettings?.bucketCount === 24 && chartPreset.config.volumeProfileSettings?.priceSource === "close" && chartPreset.config.volumeProfileSettings?.valueAreaPercent === 68, "저장한 프리셋에 Volume Profile 계산 설정이 보존되지 않았습니다.");

  await page.getByRole("button", { name: "CSTM 사용자 지정 목록에서 삭제" }).click();
  await page.getByRole("list", { name: "사용자 지정 종목 목록" }).getByText("CSTM", { exact: true }).waitFor({ state: "detached" });

  await page.getByLabel("기술적 분석 프리셋 복원").click();
  await page.getByRole("option", { name: "UI 종목 목록 프리셋", exact: true }).click();
  await page.getByText("프리셋을 복원했습니다. 분석 실행을 눌러 새 설정을 계산하세요.", { exact: true }).waitFor();
  await page.getByRole("list", { name: "사용자 지정 종목 목록" }).getByText("CSTM", { exact: true }).waitFor();

  await page.getByRole("button", { name: "CSTM 사용자 지정 목록에서 삭제" }).click();
  await page.getByRole("list", { name: "사용자 지정 종목 목록" }).getByText("CSTM", { exact: true }).waitFor({ state: "detached" });
  await page.getByLabel("기술적 분석 프리셋 복원").click();
  await page.getByRole("option", { name: "UI 게이트 프리셋", exact: true }).click();
  await page.getByText("프리셋을 복원했습니다. 분석 실행을 눌러 새 설정을 계산하세요.", { exact: true }).waitFor();
  await page.getByRole("list", { name: "사용자 지정 종목 목록" }).getByText("CSTM", { exact: true }).waitFor();
  const restoredKinds = await selectedGlobalIndicatorKinds(page);
  check(JSON.stringify(restoredKinds) === JSON.stringify([...volumeIndicatorKinds, "roc"].sort()), `복원한 Stage4 custom 지표 구성이 다릅니다: ${JSON.stringify(restoredKinds)}`);
  check(await page.getByRole("combobox", { name: "Anchored VWAP anchor", exact: true }).textContent().then((text) => text?.includes("신호 발생일")), "복원한 프리셋의 Anchored VWAP anchor가 UI에 반영되지 않았습니다.");
  check(await page.getByLabel("Volume Profile 가격 source").textContent().then((text) => text?.includes("종가")), "복원한 프리셋의 Volume Profile 가격 source가 UI에 반영되지 않았습니다.");
}

async function chooseSelectOption(page, trigger, optionName) {
  await trigger.click();
  await page.getByRole("option", { name: optionName, exact: true }).click();
}

async function exerciseStageFiveStrategy(page, state, viewport) {
  const workspace = page.locator("[data-technical-strategy-workspace]");
  await workspace.scrollIntoViewIfNeeded();
  await workspace.waitFor();

  // Chart mutations make the snapshotted strategy source stale. Refreshing it is
  // explicit so a 20-symbol ledger request is never silently derived from 23 charts.
  await workspace.getByRole("button", { name: "선택 종목·현재 지표 적용", exact: true }).click();
  await workspace.locator('[data-technical-strategy-valid="true"]').waitFor();
  check(await workspace.getByRole("button", { name: "기술 신호 백테스트로 전달", exact: true }).isEnabled(), "최신 chart source를 적용한 전략 handoff가 활성화되지 않았습니다.");

  // Exercise a nested typed tree in the real editor: all(crosses_above, ..., not(...))
  // plus a between exit condition. Signal evaluation itself remains server-only.
  await chooseSelectOption(page, workspace.getByLabel("진입 조건 · INACTIVE → ACTIVE 연산자", { exact: true }), "모두 충족");
  await workspace.getByRole("button", { name: "비교 조건", exact: true }).click();
  await workspace.getByRole("button", { name: "NOT", exact: true }).click();
  await chooseSelectOption(page, workspace.getByLabel("진입 조건 · INACTIVE → ACTIVE · 1 연산자", { exact: true }), "상향 돌파");
  await chooseSelectOption(page, workspace.getByLabel("청산 조건 · ACTIVE → INACTIVE 연산자", { exact: true }), "범위 안");
  await workspace.getByLabel("기술 전략 최소 보유 기간", { exact: true }).fill("2");
  await workspace.getByLabel("기술 전략 cooldown", { exact: true }).fill("1");
  await workspace.locator('[data-technical-strategy-valid="true"]').waitFor();

  const strategyPresetName = `UI 기술 신호 ${viewport.width}`;
  const presetCountBefore = state.presetCreates.length;
  await workspace.getByLabel("새 기술 신호 전략 프리셋 이름", { exact: true }).fill(strategyPresetName);
  await workspace.getByRole("button", { name: "전략 저장", exact: true }).click();
  await workspace.getByText("기술 신호 전략 프리셋을 저장했습니다.", { exact: true }).waitFor();
  check(state.presetCreates.length === presetCountBefore + 1, "기술 신호 전략 preset POST가 정확히 한 번 호출되지 않았습니다.");
  const preset = state.presetCreates.at(-1);
  check(preset.source?.type === "manual", "기술 신호 전략 preset source.type이 manual이 아닙니다.");
  check(preset.config?.presetType === "technical_signal_strategy", "기술 신호 전략 presetType이 다릅니다.");
  check(preset.config?.schemaVersion === 1 && preset.config?.strategy?.schemaVersion === "technical-strategy/v1", "기술 신호 전략 schemaVersion이 보존되지 않았습니다.");
  check(preset.config?.analysis?.symbols?.length === 20, `기술 신호 전략 종목 수가 ledger 상한 20이 아닙니다: ${preset.config?.analysis?.symbols?.length}`);
  check(preset.config?.strategy?.entryCondition?.operator === "all", "저장한 전략의 all 조건이 보존되지 않았습니다.");
  check(preset.config?.strategy?.entryCondition?.conditions?.[0]?.operator === "crosses_above", "저장한 전략의 crosses_above 조건이 보존되지 않았습니다.");
  check(preset.config?.strategy?.entryCondition?.conditions?.[2]?.operator === "not", "저장한 전략의 not 조건이 보존되지 않았습니다.");
  check(preset.config?.strategy?.exitCondition?.operator === "between", "저장한 전략의 between 조건이 보존되지 않았습니다.");
  check(preset.config?.strategy?.minimumHoldingPeriod === 2 && preset.config?.strategy?.cooldownPeriod === 1, "최소 보유 기간/cooldown이 preset에서 손실됐습니다.");
  check(!Object.hasOwn(preset.config?.strategy || {}, "entry_condition"), "public preset에 snake_case 전략 필드가 노출됐습니다.");

  await workspace.getByLabel("기술 신호 전략 프리셋 복원", { exact: true }).click();
  await page.getByRole("option", { name: strategyPresetName, exact: true }).click();
  await workspace.getByText("기술 신호 전략 프리셋을 복원했습니다.", { exact: true }).waitFor();

  await workspace.getByRole("button", { name: "기술 신호 백테스트로 전달", exact: true }).click();
  await page.locator("[data-backtest-strategy-mode]").waitFor({ timeout: 20_000 });
  const technicalMode = page.locator("[data-backtest-strategy-mode]").getByRole("button", { name: "기술 신호 전략", exact: true });
  await technicalMode.waitFor();
  check(await technicalMode.getAttribute("aria-pressed") === "true", "handoff 후 기술 신호 전략 모드가 선택되지 않았습니다.");
  await page.locator("[data-technical-backtest-source]").waitFor();
  await page.locator('[data-technical-strategy-builder][data-technical-strategy-valid="true"]').waitFor();
  check(new URL(page.url()).hash === "#backtest", `기술 신호 handoff가 backtest hash로 이동하지 않았습니다: ${page.url()}`);
  check(state.instrumentRequests.length === 1, "handoff 종목 metadata를 batch 한 번으로 조회하지 않았습니다.");
  check(state.instrumentRequests[0].length === 20, `handoff 종목 metadata batch가 20종목이 아닙니다: ${state.instrumentRequests[0].length}`);

  const validateButton = page.locator("[data-technical-strategy-validate]");
  await validateButton.scrollIntoViewIfNeeded();
  await validateButton.click();
  await page.getByText("공통 서비스의 전략 검증을 통과했습니다.", { exact: true }).waitFor();
  check(state.validateRequests.length === 1, "기술 신호 전략 validation 요청이 정확히 한 번 발생하지 않았습니다.");
  const firstValidation = state.validateRequests[0];
  check(firstValidation.analysis?.symbols?.length === 20, "validation analysis가 명시적 20종목 subset을 사용하지 않았습니다.");
  check(firstValidation.analysis?.responseMode === "full_series", "validation이 full-series worker source를 사용하지 않았습니다.");
  check(firstValidation.strategy?.entryCondition?.operator === "all" && firstValidation.strategy?.exitCondition?.operator === "between", "validation typed condition tree가 preset/handoff와 다릅니다.");
  check(firstValidation.strategy?.entryCondition?.conditions?.[0]?.left?.type === "indicator", "validation indicator operand가 누락됐습니다.");
  check(typeof firstValidation.strategy?.entryCondition?.conditions?.[0]?.left?.instrumentKey === "string", "validation indicator operand의 public instrumentKey가 누락됐습니다.");
  check(!Object.hasOwn(firstValidation.strategy || {}, "entry_condition") && !Object.hasOwn(firstValidation.strategy || {}, "active_when"), "HTTP public strategy에 내부 snake_case 필드가 노출됐습니다.");
  check(firstValidation.backtest?.rebalanceFrequency === "none" && Array.isArray(firstValidation.backtest?.targetWeightSchedule) && firstValidation.backtest.targetWeightSchedule.length === 0, "브라우저가 Rust 생성 일정 대신 수동 schedule/rebalance를 전송했습니다.");

  const endDateInput = page.locator("label").filter({ hasText: "종료일" }).locator('input[type="date"]').first();
  const exactSourceEndDate = firstValidation.backtest.endDate;
  const earlierEndDate = previousWeekdays(exactSourceEndDate, 2)[0];
  await endDateInput.fill(earlierEndDate);
  await page.getByText("전략 원본의 종목·기간·통화가 현재 백테스트 설정과 다릅니다. 현재 설정으로 초기화하거나 원본 설정을 복원하세요.", { exact: true }).waitFor();
  check(await validateButton.isDisabled(), "strategy source 종료일과 backtest 종료일이 다른데 validation이 활성화되어 있습니다.");
  await endDateInput.fill(exactSourceEndDate);
  await page.getByText("공통 서비스의 전략 검증을 통과했습니다.", { exact: true }).waitFor();

  // The server validation fingerprint includes every backtest assumption, not only
  // the condition tree. Changing capital must expire validation before execution.
  const initialAmountInput = page.locator("label").filter({ hasText: "초기 투자금 · KRW" }).getByRole("spinbutton");
  await initialAmountInput.scrollIntoViewIfNeeded();
  await initialAmountInput.fill("11000000");
  await page.getByText("전략 또는 백테스트 가정이 변경되어 서버 검증이 만료되었습니다.", { exact: true }).waitFor();
  check(await page.getByRole("button", { name: "기술 신호 백테스트 실행", exact: true }).isDisabled(), "검증 후 백테스트 가정 변경에도 실행 버튼이 활성화되어 있습니다.");
  await validateButton.click();
  await page.getByText("공통 서비스의 전략 검증을 통과했습니다.", { exact: true }).waitFor();
  check(state.validateRequests.length === 2 && state.validateRequests[1].backtest.initialAmount === 11_000_000, "변경된 백테스트 가정으로 재검증하지 않았습니다.");

  await page.getByRole("button", { name: "기술 신호 백테스트 실행", exact: true }).click();
  const trace = page.locator("[data-technical-signal-trace]");
  await trace.waitFor({ timeout: 20_000 });
  check(state.technicalBacktestRequests.length === 1, "기술 신호 백테스트 combined endpoint가 정확히 한 번 호출되지 않았습니다.");
  const runRequest = state.technicalBacktestRequests[0];
  check(JSON.stringify(runRequest) === JSON.stringify(state.validateRequests[1]), "검증한 combined request와 실행 request가 일치하지 않습니다.");
  check(runRequest.backtest.rebalanceFrequency === "none" && runRequest.backtest.targetWeightSchedule.length === 0, "실행 요청에 browser 생성 일정 또는 rebalance가 포함됐습니다.");

  const expectedDates = previousWeekdays(runRequest.backtest.endDate, 24);
  const calculationDate = expectedDates.at(-5);
  const plannedDate = expectedDates.at(-4);
  const actualDate = expectedDates.at(-3);
  check(plannedDate !== actualDate, "fixture가 예정 거래일과 실제 적용일 차이를 검증하지 못합니다.");
  const traceText = await trace.textContent() || "";
  for (const label of ["계산 기준일", "신호일", "예정 거래일", "실제 적용일"]) check(traceText.includes(label), `signal trace에 ${label} 구분이 없습니다.`);
  for (const date of [calculationDate, plannedDate, actualDate]) check(traceText.includes(date), `server가 반환한 signal 날짜 ${date}를 UI가 그대로 표시하지 않았습니다.`);
  check(traceText.includes("technical-signal-1"), "server signal id가 trace에 표시되지 않았습니다.");
  check(traceText.includes("처리 상태") && traceText.includes("ledger 적용") && traceText.includes("거래 예정") && traceText.includes("안전 거래일 없음"), "signal trace가 planned/applied/no_safe_trade_date 처리 상태를 구분하지 않았습니다.");
  for (const status of ["applied", "planned", "no_safe_trade_date"]) check(await trace.locator(`[data-technical-signal-status="${status}"]`).count() >= 1, `${status} signal status badge가 없습니다.`);
  await page.locator("[data-technical-report-unavailable]").waitFor();
  check(await page.getByRole("button", { name: "AI 평가 보고서 생성", exact: true }).count() === 0, "기술 신호 결과에 일반 비중 백테스트 report 실행이 노출됐습니다.");

  await chooseSelectOption(page, page.getByLabel("청산 조건 · ACTIVE → INACTIVE 연산자", { exact: true }), "보다 작음");
  await trace.waitFor({ state: "detached" });
  check(await page.locator("[data-technical-report-unavailable]").count() === 0, "백테스트 가정 변경 후 이전 기술 전략 결과 안내가 남아 있습니다.");
  await page.getByText("실행 전에 공통 서비스에서 조건·가용성·기간을 검증합니다.", { exact: true }).waitFor();
  await validateButton.click();
  await page.getByText("공통 서비스의 전략 검증을 통과했습니다.", { exact: true }).waitFor();
  await page.getByRole("button", { name: "기술 신호 백테스트 실행", exact: true }).click();
  await trace.waitFor({ timeout: 20_000 });
  check(state.validateRequests.length === 3 && state.technicalBacktestRequests.length === 2, "설정 변경 후 재검증·재실행 횟수가 다릅니다.");
  check(JSON.stringify(state.technicalBacktestRequests[1]) === JSON.stringify(state.validateRequests[2]), "설정 변경 후 검증 request와 실행 request가 다릅니다.");
  check((await trace.textContent() || "").includes("technical-signal-2"), "재실행한 최신 signal trace가 표시되지 않았습니다.");
  await page.locator("[data-technical-report-unavailable]").waitFor();

  // A technical response that finishes after the user leaves technical mode must
  // never populate allocation results or reappear when the user returns.
  state.delayNextTechnicalRun = true;
  await page.getByRole("button", { name: "기술 신호 백테스트 실행", exact: true }).click();
  for (let attempt = 0; attempt < 30 && state.technicalBacktestRequests.length < 3; attempt += 1) await page.waitForTimeout(20);
  check(state.technicalBacktestRequests.length === 3, "지연 technical run 요청이 시작되지 않았습니다.");
  const allocationMode = page.locator("[data-backtest-strategy-mode]").getByRole("button", { name: "기본 비중 전략", exact: true });
  await allocationMode.click();
  check(await allocationMode.getAttribute("aria-pressed") === "true", "지연 run 중 기본 비중 전략으로 전환되지 않았습니다.");
  await page.waitForTimeout(650);
  check(await page.locator("[data-technical-signal-trace]").count() === 0, "늦은 technical response가 allocation mode에 stale trace를 표시했습니다.");
  check(await page.locator("[data-technical-report-unavailable]").count() === 0, "늦은 technical response가 allocation mode에 technical report 안내를 표시했습니다.");
  check(await page.getByRole("button", { name: "AI 평가 보고서 생성", exact: true }).count() === 0, "늦은 technical response가 allocation mode에 일반 report 실행을 노출했습니다.");
  check(await page.getByRole("heading", { name: "현금흐름 제거 성장 비교", exact: true }).count() === 0, "늦은 technical response가 allocation mode에 stale result를 표시했습니다.");

  await technicalMode.click();
  check(await technicalMode.getAttribute("aria-pressed") === "true", "race 검증 후 기술 신호 모드로 돌아오지 못했습니다.");
  check(await page.locator("[data-technical-signal-trace]").count() === 0, "discard되어야 할 늦은 technical response가 모드 복귀 후 다시 나타났습니다.");
  await page.getByRole("button", { name: "기술 신호 백테스트 실행", exact: true }).click();
  await trace.waitFor({ timeout: 20_000 });
  check(state.technicalBacktestRequests.length === 4, "race 검증 후 최신 technical run이 실행되지 않았습니다.");
  check((await trace.textContent() || "").includes("technical-signal-4"), "race 검증 후 최신 run 결과가 표시되지 않았습니다.");
  await trace.scrollIntoViewIfNeeded();
  const overflow = await assertNoOverflow(page, `${viewport.width}x${viewport.height} 기술 신호 백테스트`);
  return {
    symbols: runRequest.analysis.symbols.length,
    indicators: runRequest.analysis.indicators.length,
    validations: state.validateRequests.length,
    runs: state.technicalBacktestRequests.length,
    calculationDate,
    plannedDate,
    actualDate,
    overflow,
  };
}

async function verifyViewport(browser, baseUrl, { viewport, theme, exerciseMutations }) {
  const context = await browser.newContext({
    viewport,
    colorScheme: theme,
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
    reducedMotion: "reduce",
    deviceScaleFactor: 1,
  });
  await context.addInitScript((initialTheme) => {
    window.localStorage.setItem("portfolio-theme", initialTheme);
    window.localStorage.removeItem("portfolio-hidden-stocks");
    document.addEventListener("DOMContentLoaded", () => {
      const style = document.createElement("style");
      style.textContent = "*,*::before,*::after{animation-duration:0s!important;transition-duration:0s!important}html{scroll-behavior:auto!important}";
      document.head.append(style);
    }, { once: true });
  }, theme);
  const page = await context.newPage();
  const failures = observePage(page);
  const state = await routeTechnicalUiApi(page);
  const startedAt = Date.now();
  try {
    const navigation = await page.goto(`${baseUrl}/#technical-analysis`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    check(navigation?.status() === 200, `${viewport.width}x${viewport.height} 문서 응답이 200이 아닙니다.`);
    await page.getByRole("heading", { name: "기술적 분석", exact: true }).waitFor();
    await page.getByRole("heading", { name: "22개 종목 동시 비교", exact: true }).waitFor({ timeout: 30_000 });
    const initialRenderMs = Date.now() - startedAt;

    const actualViewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    check(actualViewport.width === viewport.width && actualViewport.height === viewport.height, `viewport 불일치: ${JSON.stringify(actualViewport)}`);
    const actualTheme = await page.evaluate(() => document.documentElement.classList.contains("dark") ? "dark" : "light");
    check(actualTheme === theme, `${viewport.width}px 테마가 ${theme}가 아니라 ${actualTheme}입니다.`);
    check(await page.locator("[data-technical-symbol]").count() >= 22, `${viewport.width}px에서 22개 종목 카드를 렌더링하지 못했습니다.`);
    check(state.analyzeRequests.length === 1, "초기 분석이 단일 batch 요청이 아닙니다.");
    check(state.analyzeRequests[0].symbols.length === 22, "초기 batch 요청에 22개 종목이 모두 포함되지 않았습니다.");
    check(state.tradeRequests[0]?.length === 22, "거래 marker 요청에 22개 종목이 모두 포함되지 않았습니다.");
    await assertStageFourIndicatorCatalog(page);
    const markerNotice = (await page.getByRole("status").filter({ hasText: "거래 marker 주문 이력 complete" }).textContent())?.trim();
    check(markerNotice === "거래 marker 주문 이력 complete · 조회 범위 1건", `완전한 주문 이력 marker 상태가 UI에 표시되지 않았습니다: ${markerNotice || "missing"}`);

    await selectFourColumns(page);
    const layout = await gridGeometry(page);
    check(layout.boxes.length >= 5, "레이아웃 검증에 필요한 종목 카드가 부족합니다.");
    if (viewport.width === 1440) {
      const firstRowY = layout.boxes[0].y;
      check(layout.boxes.slice(0, 4).every((box) => Math.abs(box.y - firstRowY) < 2), `1440px에서 첫 4개 카드가 한 행이 아닙니다: ${JSON.stringify(layout.boxes)}`);
      check(new Set(layout.boxes.slice(0, 4).map((box) => Math.round(box.x))).size === 4, "1440px에서 4열 x 위치를 확인하지 못했습니다.");
      check(layout.boxes[4].y > firstRowY + 10, "1440px에서 다섯 번째 카드가 다음 행으로 이동하지 않았습니다.");
    } else {
      check(layout.boxes.every((box) => Math.abs(box.x - layout.boxes[0].x) < 2), `390px에서 카드가 1열이 아닙니다: ${JSON.stringify(layout.boxes)}`);
      check(layout.boxes.slice(1).every((box, index) => box.y > layout.boxes[index].y), "390px 카드가 세로 1열 순서로 배치되지 않았습니다.");
    }

    if (exerciseMutations) {
      await exerciseStageTwoPresets(page, state);
      await exerciseStageFourVwapAndProfile(page, state);
      await exerciseCustomPreset(page, state);
    } else {
      await exerciseMobileVolumeRendering(page, state);
    }

    const cardCount = await page.locator("[data-technical-symbol]").count();
    const lazyPlaceholders = await page.getByText("스크롤하면 차트를 렌더링합니다", { exact: true }).count();
    check(cardCount >= 20, `${viewport.width}px에서 20개 이상 종목 chart를 만들지 못했습니다.`);
    check(lazyPlaceholders >= cardCount - 6, `${viewport.width}px에서 다종목 지연 렌더링이 충분히 적용되지 않았습니다: ${lazyPlaceholders}/${cardCount}`);
    const lastCard = page.locator("[data-technical-symbol]").last();
    await lastCard.scrollIntoViewIfNeeded();
    await lastCard.locator("[data-technical-chart]").waitFor({ timeout: 20_000 });
    const renderedChartSurfaces = await assertRenderedChartsHaveSize(page, `${viewport.width}x${viewport.height}`);
    const overflow = await assertNoOverflow(page, `${viewport.width}x${viewport.height}`);

    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(250);
    await mkdir(screenshotDirectory, { recursive: true });
    const screenshotPath = path.join(screenshotDirectory, `${viewport.width}x${viewport.height}-${theme}.png`);
    await page.screenshot({ path: screenshotPath, animations: "disabled" });
    await page.waitForTimeout(200);

    const technicalStrategy = await exerciseStageFiveStrategy(page, state, viewport);
    await page.waitForTimeout(250);
    const strategyScreenshotPath = path.join(screenshotDirectory, `${viewport.width}x${viewport.height}-${theme}-technical-strategy.png`);
    await page.screenshot({ path: strategyScreenshotPath, animations: "disabled" });
    await page.waitForTimeout(200);

    check(failures.console.length === 0, `console error: ${failures.console.join(" | ")}`);
    check(failures.page.length === 0, `page error: ${failures.page.join(" | ")}`);
    check(failures.requests.length === 0, `failed request: ${failures.requests.join(" | ")}`);
    check(failures.responses.length === 0, `HTTP >=400: ${failures.responses.join(" | ")}`);
    return {
      viewport: `${viewport.width}x${viewport.height}`,
      theme,
      initialRenderMs,
      cards: cardCount,
      gridTemplate: layout.template,
      lazyPlaceholders,
      renderedChartSurfaces,
      overflow: Math.max(overflow, technicalStrategy.overflow),
      technicalStrategy,
      analyzeBatchSizes: state.analyzeRequests.map((request) => request.symbols.length),
      profileRequestSizes: state.profileRequests.map((request) => request.symbols.length),
      profileBucketCounts: state.profileRequests.map((request) => request.indicators[0]?.parameters?.bucket_count),
      customSearches: state.searchRequests,
      presetCreates: state.presetCreates.length,
      markerNotice,
      errors: {
        console: failures.console.length,
        page: failures.page.length,
        failedRequests: failures.requests.length,
        httpAtLeast400: failures.responses.length,
      },
      screenshotPath,
      strategyScreenshotPath,
    };
  } finally {
    await context.close();
  }
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  check(address && typeof address === "object", "Vite 검증 포트를 할당하지 못했습니다.");
  const port = address.port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function firstExecutable(candidates) {
  for (const candidate of candidates.filter(Boolean)) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // 다음 Chromium 후보를 확인한다.
    }
  }
  return undefined;
}

async function waitForVite(baseUrl, child, output) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Vite가 조기 종료됐습니다 (${child.exitCode}).\n${output.join("")}`);
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return;
    } catch {
      // Vite startup을 기다린다.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Vite 준비 시간이 초과됐습니다.\n${output.join("")}`);
}

async function buildClient(viteEntry) {
  const output = [];
  const child = spawn(process.execPath, [viteEntry, "build"], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => output.push(chunk.toString()));
  child.stderr.on("data", (chunk) => output.push(chunk.toString()));
  const exit = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  if (exit.code !== 0) throw new Error(`Vite production build가 실패했습니다 (${exit.code ?? exit.signal}).\n${output.join("")}`);
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 3_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  let viteProcess;
  let browser;
  let exitCode = 0;
  try {
  let baseUrl = process.env.TECHNICAL_UI_BASE_URL?.replace(/\/$/, "");
  if (!baseUrl) {
    const viteEntry = path.join(projectRoot, "node_modules", "vite", "bin", "vite.js");
    if (process.env.TECHNICAL_UI_SKIP_BUILD !== "1") await buildClient(viteEntry);
    const port = await availablePort();
    baseUrl = `http://127.0.0.1:${port}`;
    const output = [];
    viteProcess = spawn(process.execPath, [viteEntry, "preview", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    viteProcess.stdout.on("data", (chunk) => output.push(chunk.toString()));
    viteProcess.stderr.on("data", (chunk) => output.push(chunk.toString()));
    await waitForVite(baseUrl, viteProcess, output);
  }

  const executablePath = await firstExecutable([
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome-stable",
  ]);
  browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--font-render-hinting=none"],
  });
  const results = [
    await verifyViewport(browser, baseUrl, { viewport: { width: 1440, height: 1000 }, theme: "dark", exerciseMutations: true }),
    await verifyViewport(browser, baseUrl, { viewport: { width: 390, height: 844 }, theme: "light", exerciseMutations: false }),
  ];
  console.info(JSON.stringify({ ok: true, results }, null, 2));
  } catch (error) {
    exitCode = 1;
    console.error(error instanceof Error ? error.stack || error.message : String(error));
  } finally {
    await browser?.close().catch(() => undefined);
    await stopProcess(viteProcess);
  }
  process.exitCode = exitCode;
}
