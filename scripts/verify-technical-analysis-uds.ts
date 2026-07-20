import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { SqliteDatabase } from "../server/database.js";
import { ArtifactRepository } from "../server/repositories/artifact-repository.js";
import { RunRepository } from "../server/repositories/run-repository.js";
import { ArtifactService } from "../server/services/artifact-service.js";
import type { MarketDataService, MarketSeriesResult } from "../server/services/market-data-service.js";
import { RunService } from "../server/services/run-service.js";
import { TechnicalAnalysisService } from "../server/services/technical-analysis-service.js";
import type { TechnicalStrategyWorkerResult } from "../server/services/technical-strategy-contract.js";
import {
  TECHNICAL_INDICATOR_ENGINE_VERSION,
  TECHNICAL_INDICATOR_KINDS,
  TECHNICAL_INDICATOR_PARAMETER_RULES,
} from "../server/services/technical-analysis-contract.js";
import { toolSchemas } from "../server/mcp/schemas.js";
import { createToolHandlers, type McpToolDependencies } from "../server/mcp/tools/handlers.js";
import { RustComputeClient } from "../server/worker/rust-client.js";
import {
  buildTechnicalChartRows,
  calculationsForInstrument,
  unwrapTechnicalAnalysisPayload,
  volumeProfileCalculation,
} from "../src/lib/technical-analysis.js";

const EXPECTED_INDICATOR_ENGINE_VERSION = "technical-indicators/1.5.0";
const EXPECTED_INSTRUMENT_COUNT = 2;
const EXPECTED_INDICATOR_COUNT = 30;
const EXPECTED_CALCULATION_COUNT = EXPECTED_INSTRUMENT_COUNT * EXPECTED_INDICATOR_COUNT;

const workerBinary = fileURLToPath(new URL(
  "../worker/rust/target/debug/portfolio-lens-worker",
  import.meta.url,
));

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function waitForSocket(socketPath: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (existsSync(socketPath)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Rust worker가 10초 안에 UDS socket을 만들지 못했습니다.");
}

function bars(base: number) {
  return Array.from({ length: 80 }, (_, index) => {
    const date = new Date(Date.UTC(2024, 0, index + 1)).toISOString().slice(0, 10);
    const close = base + index * 0.5;
    return {
      date,
      open: close - 0.25,
      high: close + 1,
      low: close - 1,
      close,
      volume: 1_000 + index * 10,
    };
  });
}

function marketSeries(instrument: (typeof payloadBase.instruments)[number]): MarketSeriesResult {
  const assetType = instrument.instrument_type === "etf" ? "ETF" : "STOCK";
  return {
    instrument: {
      symbol: instrument.symbol,
      name: instrument.symbol,
      market: instrument.market,
      currency: instrument.currency,
      assetType,
    },
    interval: "1d",
    adjusted: true,
    currencyMode: "local",
    currency: instrument.currency,
    points: instrument.bars.map((bar) => ({
      ...bar,
      periodStart: bar.date,
      periodEnd: bar.date,
      observations: 1,
      localOpen: bar.open,
      localHigh: bar.high,
      localLow: bar.low,
      localClose: bar.close,
      fxRate: 1,
    })),
    requestedPeriod: { from: instrument.bars[0]!.date, to: instrument.bars.at(-1)!.date },
    effectivePeriod: { from: instrument.bars[0]!.date, to: instrument.bars.at(-1)!.date },
    dataRevision: `parity-${instrument.symbol}`,
    assumptions: [],
    warnings: [],
    dataQuality: {
      observations: instrument.bars.length,
      outputObservations: instrument.bars.length,
      volumeObservations: instrument.bars.length,
      missingVolumeObservations: 0,
      volumeCoverage: 1,
      volumeStatus: "available",
      sourceDailyVolumeObservations: instrument.bars.length,
      sourceDailyMissingVolumeObservations: 0,
      sourceDailyVolumeCoverage: 1,
      sourceDailyVolumeStatus: "available",
      missingFxObservations: 0,
      carriedFxObservations: 0,
      firstObservationDate: instrument.bars[0]!.date,
      metadataListDateRole: "provider_listing_metadata_not_verified_inception",
      listingDateConsistency: "unavailable",
    },
  } as MarketSeriesResult;
}

const payloadBase = {
  schema_version: "technical-analysis-request/v1",
  adjustment_policy: "adjusted",
  instruments: [
    {
      key: "AAA",
      symbol: "AAA",
      market: "TEST",
      currency: "KRW",
      instrument_type: "stock",
      bars: bars(100),
    },
    {
      key: "BBB",
      symbol: "BBB",
      market: "TEST",
      currency: "USD",
      instrument_type: "etf",
      bars: bars(200),
    },
  ],
  indicators: [
    { id: "sma-10", kind: "sma", parameters: { period: 10, source: "close" } },
    { id: "ema-10", kind: "ema", parameters: { period: 10, source: "close" } },
    { id: "rsi-14", kind: "rsi", parameters: { period: 14, source: "close" } },
    { id: "macd-5-12-4", kind: "macd", parameters: { fast_period: 5, slow_period: 12, signal_period: 4, source: "close" } },
    { id: "bollinger-10", kind: "bollinger_bands", parameters: { period: 10, stddev_multiplier: 2, source: "close" } },
    { id: "atr-14", kind: "atr", parameters: { period: 14 } },
    { id: "donchian-10", kind: "donchian_channel", parameters: { period: 10 } },
    { id: "relative-to-bbb", kind: "benchmark_relative_strength", parameters: { benchmark_key: "BBB" } },
    { id: "high-low-position-20", kind: "fifty_two_week_high_low_position", parameters: { period: 20 } },
    { id: "ma-distance-10", kind: "moving_average_distance", parameters: { period: 10, average_type: "ema", source: "close" } },
    { id: "adx-dmi-5", kind: "adx_dmi", parameters: { period: 5 } },
    { id: "stochastic-5-2-2", kind: "stochastic_oscillator", parameters: { lookback_period: 5, smooth_k: 2, smooth_d: 2 } },
    { id: "roc-5", kind: "roc", parameters: { period: 5, source: "close" } },
    { id: "keltner-5", kind: "keltner_channel", parameters: { ema_period: 5, atr_period: 5, multiplier: 2 } },
    { id: "supertrend-5", kind: "supertrend", parameters: { atr_period: 5, multiplier: 2 } },
    { id: "historical-volatility-5", kind: "historical_volatility", parameters: { period: 5, annualization: 252, return_type: "log" } },
    { id: "normalized-atr-5", kind: "normalized_atr", parameters: { period: 5 } },
    { id: "bollinger-width-percent-b-5", kind: "bollinger_band_width_percent_b", parameters: { period: 5, stddev_multiplier: 2, source: "close" } },
    { id: "aroon-5", kind: "aroon", parameters: { period: 5 } },
    { id: "cci-5", kind: "cci", parameters: { period: 5, constant: 0.015 } },
    { id: "williams-r-5", kind: "williams_r", parameters: { period: 5 } },
    { id: "parabolic-sar", kind: "parabolic_sar", parameters: { step: 0.02, max_step: 0.2 } },
    { id: "choppiness-5", kind: "choppiness_index", parameters: { period: 5 } },
    { id: "volume-sma-5", kind: "volume_sma", parameters: { period: 5 } },
    { id: "relative-volume-5", kind: "relative_volume", parameters: { period: 5 } },
    { id: "obv", kind: "obv", parameters: {} },
    { id: "mfi-5", kind: "mfi", parameters: { period: 5 } },
    { id: "cmf-5", kind: "cmf", parameters: { period: 5 } },
    { id: "adl", kind: "accumulation_distribution_line", parameters: {} },
    { id: "vwap", kind: "vwap_anchored_vwap", parameters: { anchor: "recent_high", lookback_period: 5, mode: "both" } },
  ],
};

const strategyDates = ["2024-01-02", "2024-01-03", "2024-01-04", "2024-01-05"] as const;
const strategyBaseCloses = [9, 11, 12, 8] as const;
const strategyFutureChangedCloses = [9, 11, 12, 500] as const;

function strategyTechnicalAnalysis(closes: readonly number[]) {
  assert(closes.length === strategyDates.length, "기술 전략 fixture는 정확히 4개 날짜여야 합니다.");
  return {
    schema_version: "technical-analysis-request/v1",
    response_mode: "full_series",
    adjustment_policy: "adjusted",
    instruments: [{
      key: "AAA",
      symbol: "AAA",
      market: "TEST",
      currency: "KRW",
      instrument_type: "stock",
      bars: strategyDates.map((date, index) => ({
        date,
        open: closes[index]!,
        high: closes[index]! + 1,
        low: closes[index]! - 1,
        close: closes[index]!,
        volume: 1_000 + index * 100,
      })),
    }],
    indicators: [{
      id: "strategy-sma-one",
      kind: "sma",
      parameters: { period: 1, source: "close" },
    }],
  };
}

const strategyDefinition = {
  schema_version: "technical-strategy/v1",
  initial_state: "inactive",
  active_when: {
    operator: "crosses_above",
    left: { type: "bar", instrument_key: "AAA", field: "close" },
    right: { type: "constant", value: 10 },
  },
  inactive_when: {
    operator: "crosses_below",
    left: { type: "bar", instrument_key: "AAA", field: "close" },
    right: { type: "constant", value: 10 },
  },
  minimum_holding_period: 0,
  cooldown_period: 0,
  allocations: {
    active: { weights: { AAA: 100 }, cash_target_percent: 0 },
    inactive: { weights: { AAA: 0 }, cash_target_percent: 100 },
  },
};

function strategySimulation(closes: readonly number[]) {
  assert(closes.length === strategyDates.length, "기술 전략 ledger fixture는 정확히 4개 날짜여야 합니다.");
  return {
    assets: [{
      symbol: "AAA",
      name: "AAA",
      market: "TEST",
      currency: "KRW",
      listDate: "2020-01-01",
      weight: 0,
    }],
    prices: {
      "KRW:AAA": strategyDates.map((date, index) => ({
        date,
        close: closes[index]!,
        localClose: closes[index]!,
        fxRate: 1,
        volume: 1_000 + index * 100,
      })),
    },
    observedDates: { "KRW:AAA": [...strategyDates] },
    requestedStartDate: strategyDates[0],
    endDate: strategyDates.at(-1),
    initialAmount: 1_000_000,
    monthlyCashFlow: 0,
    rebalanceFrequency: "none",
    execution: {
      cashTargetPercent: 100,
      quantityMode: "fractional",
      cashFlowRebalanceMode: "target_weights",
      tradeDatePolicy: "next_common_observation",
      cashAnnualYieldPercent: 0,
    },
  };
}

function strategyResponseContext() {
  const assets = [{
    symbol: "AAA",
    name: "AAA",
    market: "TEST",
    currency: "KRW",
    listDate: "2020-01-01",
    weight: 0,
  }];
  const execution = {
    cashTargetPercent: 100,
    quantityMode: "fractional",
    cashFlowRebalanceMode: "target_weights",
    tradeDatePolicy: "next_common_observation",
    cashAnnualYieldPercent: 0,
  };
  return {
    effective_requested_start: strategyDates[0],
    currency_method: "KRW_FX_CONVERTED",
    config: {
      assets: [{ symbol: "AAA", weight: 0 }],
      startDate: strategyDates[0],
      endDate: strategyDates.at(-1),
      initialAmount: 1_000_000,
      monthlyCashFlow: 0,
      cashFlowFrequency: "monthly",
      cashFlowTiming: "period_start",
      rebalanceFrequency: "none",
      riskFreeRatePercent: 0,
      transactionCostBps: 0,
      cashFlows: [],
      targetWeightSchedule: [],
      execution,
      realism: {},
      currencyMode: "KRW",
      baseCurrency: "KRW",
      benchmark: "NONE",
      requestedStartDate: strategyDates[0],
      latestMetadataListDate: "2020-01-01",
    },
    assets,
    instrument_date_consistency: [{
      symbol: "AAA",
      firstObservationDate: strategyDates[0],
      metadataListDate: "2020-01-01",
      status: "consistent",
    }],
    warnings: [],
  };
}

function signalPrefix(result: TechnicalStrategyWorkerResult, beforeDate: string) {
  return result.technical_strategy.signals
    .filter((signal) => signal.signal_date < beforeDate)
    .map(({ actual_application_date: _actual, status: _status, ...causal }) => causal);
}

assert(
  TECHNICAL_INDICATOR_ENGINE_VERSION === EXPECTED_INDICATOR_ENGINE_VERSION,
  "Node.js indicator engine version mirror가 Stage 5 fixture와 일치하지 않습니다.",
);
assert(
  payloadBase.indicators.length === EXPECTED_INDICATOR_COUNT,
  "Stage 5 multi-chart fixture는 Volume Profile을 제외한 정확히 30개 지표여야 합니다.",
);
assert(
  isDeepStrictEqual(
    payloadBase.indicators.map(({ kind }) => kind),
    TECHNICAL_INDICATOR_KINDS.slice(0, EXPECTED_INDICATOR_COUNT),
  ),
  "Stage 5 multi-chart fixture kind가 Node.js 공통 계약의 앞 30개와 일치하지 않습니다.",
);

if (!existsSync(workerBinary)) {
  throw new Error("debug Rust worker가 없습니다. 먼저 cargo test 또는 cargo build를 실행해 주세요.");
}

const directory = await mkdtemp(path.join(tmpdir(), "portfolio-lens-technical-uds-"));
const socketPath = path.join(directory, "compute.sock");
const worker = spawn(workerBinary, ["serve", "--socket", socketPath], {
  stdio: ["ignore", "ignore", "pipe"],
});
let stderr = "";
worker.stderr.setEncoding("utf8");
worker.stderr.on("data", (chunk: string) => { stderr += chunk; });
const client = new RustComputeClient({ socketPath, poolSize: 1, timeoutMs: 30_000 });
let parityDatabase: SqliteDatabase | undefined;

try {
  await waitForSocket(socketPath);
  const started = performance.now();
  const full = await client.compute<Record<string, unknown>>(
    "technical_analysis",
    { technical_analysis: { ...payloadBase, response_mode: "full_series" } },
    { includeArtifacts: true },
  );
  const fullRoundTripMs = performance.now() - started;
  const calculations = full.result.calculations;
  assert(full.result.schema_version === "technical-analysis-result/v1", "result schema version 불일치");
  assert(full.result.indicator_engine_version === EXPECTED_INDICATOR_ENGINE_VERSION, "indicator engine version 불일치");
  assert(full.result.response_mode === "full_series", "full-series response mode 불일치");
  const catalog = (full.result.diagnostics as { catalog?: unknown } | undefined)?.catalog;
  assert(Array.isArray(catalog) && catalog.length === TECHNICAL_INDICATOR_KINDS.length, "Rust 31개 catalog 누락");
  for (const kind of TECHNICAL_INDICATOR_KINDS) {
    const entry = catalog.find((candidate) => (
      typeof candidate === "object" && candidate !== null && (candidate as { kind?: unknown }).kind === kind
    )) as { parameters?: Record<string, {
      type?: unknown;
      required?: unknown;
      minimum?: unknown;
      maximum?: unknown;
      allowed_values?: unknown;
    }> } | undefined;
    assert(entry?.parameters && typeof entry.parameters === "object", `Rust catalog ${kind} parameter contract 누락`);
    const nodeRules = TECHNICAL_INDICATOR_PARAMETER_RULES[kind];
    assert(
      isDeepStrictEqual(Object.keys(entry.parameters).sort(), Object.keys(nodeRules).sort()),
      `Rust/Node ${kind} parameter 이름 contract 불일치`,
    );
    for (const [name, nodeRule] of Object.entries(nodeRules)) {
      const rustRule = entry.parameters[name];
      assert(rustRule?.type === nodeRule.type, `Rust/Node ${kind}.${name} parameter type 불일치`);
      const nodeRequired = "required" in nodeRule ? Boolean(nodeRule.required) : false;
      assert(Boolean(rustRule.required) === nodeRequired, `Rust/Node ${kind}.${name} required 불일치`);
      if (nodeRule.type === "integer" || nodeRule.type === "number") {
        assert(rustRule.minimum === nodeRule.minimum, `Rust/Node ${kind}.${name} minimum 불일치`);
        assert(rustRule.maximum === nodeRule.maximum, `Rust/Node ${kind}.${name} maximum 불일치`);
      }
      if (nodeRule.type === "enum") {
        assert(
          isDeepStrictEqual(rustRule.allowed_values, [...nodeRule.values]),
          `Rust/Node ${kind}.${name} enum contract 불일치`,
        );
      }
    }
  }
  assert(
    Array.isArray(calculations) && calculations.length === EXPECTED_CALCULATION_COUNT,
    "2종목×30개 multi-chart 지표 batch 계산 수 불일치",
  );
  assert(calculations.every((item) => (
    typeof item === "object" && item !== null && Array.isArray((item as { points?: unknown }).points)
  )), "full-series points 누락");
  assert(calculations.every((item) => {
    if (typeof item !== "object" || item === null) return false;
    const calculation = item as {
      availability?: { status?: unknown };
      points?: Array<{ state?: unknown; values?: Record<string, unknown> }>;
    };
    const last = calculation.points?.at(-1);
    const values = Object.values(last?.values ?? {});
    return (calculation.availability?.status === "available" || calculation.availability?.status === "partial")
      && last?.state === "available"
      && values.length > 0
      && values.every((value) => typeof value === "number" && Number.isFinite(value));
  }), "Stage 5 multi-chart 지표 계산이 available/partial 상태의 유한한 마지막 값을 반환하지 않았습니다.");
  const calculationKeys = new Set(calculations.map((item) => {
    const calculation = item as { instrument_key?: unknown; indicator_id?: unknown };
    return `${String(calculation.instrument_key)}:${String(calculation.indicator_id)}`;
  }));
  const expectedCalculationKeys = new Set(payloadBase.instruments.flatMap((instrument) => (
    payloadBase.indicators.map((indicator) => `${instrument.key}:${indicator.id}`)
  )));
  assert(isDeepStrictEqual(calculationKeys, expectedCalculationKeys), "종목×지표 calculation key가 정확히 일치하지 않습니다.");
  const fullSummary = full.summary as Record<string, unknown>;
  assert(fullSummary.indicator_engine_version === EXPECTED_INDICATOR_ENGINE_VERSION, "full summary engine version 불일치");
  assert(fullSummary.calculation_count === EXPECTED_CALCULATION_COUNT, "full summary calculation count 불일치");
  assert(
    Number(fullSummary.available_count) + Number(fullSummary.partial_count) === EXPECTED_CALCULATION_COUNT,
    "full summary available/partial count 불일치",
  );
  assert(
    fullSummary.insufficient_history_count === 0
      && fullSummary.volume_unavailable_count === 0
      && fullSummary.unsupported_instrument_count === 0
      && fullSummary.unavailable_count === 0,
    "Stage 5 multi-chart 지표 계산에 unavailable 결과가 있습니다.",
  );

  const artifactsByType = new Map(full.artifacts.map((artifact) => [artifact.type, artifact]));
  assert(artifactsByType.size === 3, "full-series artifact 종류 수 불일치");
  const indicatorArtifact = artifactsByType.get("technical-indicators");
  const diagnosticsArtifact = artifactsByType.get("technical-diagnostics");
  const metricsArtifact = artifactsByType.get("worker-metrics");
  assert(
    Array.isArray(indicatorArtifact?.content) && indicatorArtifact.content.length === EXPECTED_CALCULATION_COUNT,
    "indicator artifact 계산 수 불일치",
  );
  assert(indicatorArtifact.row_count === EXPECTED_CALCULATION_COUNT, "indicator artifact row_count 불일치");
  assert(isDeepStrictEqual(indicatorArtifact.content, calculations), "technical-indicators artifact와 result.calculations가 일치하지 않습니다.");
  assert(typeof diagnosticsArtifact?.content === "object" && diagnosticsArtifact.content !== null, "diagnostics artifact 누락");
  assert(diagnosticsArtifact.row_count === 1, "diagnostics artifact row_count 불일치");
  assert(isDeepStrictEqual(diagnosticsArtifact.content, full.result.diagnostics), "technical-diagnostics artifact와 result.diagnostics가 일치하지 않습니다.");
  assert(
    (diagnosticsArtifact.content as Record<string, unknown>).calculation_count === EXPECTED_CALCULATION_COUNT,
    "diagnostics artifact calculation count 불일치",
  );
  assert(metricsArtifact?.row_count === 1, "UDS worker metrics 누락");
  const metrics = metricsArtifact.content as Record<string, unknown>;
  assert(typeof metrics.compute_ms === "number" && Number.isFinite(metrics.compute_ms), "UDS worker compute timing 누락");

  const latestStarted = performance.now();
  const latest = await client.compute<Record<string, unknown>>(
    "technical_analysis",
    { technical_analysis: { ...payloadBase, response_mode: "latest_summary" } },
    { includeArtifacts: false },
  );
  const latestRoundTripMs = performance.now() - latestStarted;
  const latestCalculations = latest.result.calculations;
  assert(latest.result.schema_version === "technical-analysis-result/v1", "latest result schema version 불일치");
  assert(latest.result.indicator_engine_version === EXPECTED_INDICATOR_ENGINE_VERSION, "latest indicator engine version 불일치");
  assert(latest.result.response_mode === "latest_summary", "latest-summary response mode 불일치");
  assert(
    Array.isArray(latestCalculations) && latestCalculations.length === EXPECTED_CALCULATION_COUNT,
    "latest batch 계산 수 불일치",
  );
  assert(latestCalculations.every((item) => {
    if (typeof item !== "object" || item === null) return false;
    const record = item as { latest?: unknown; points?: unknown };
    return record.latest !== undefined && record.points === undefined;
  }), "latest-summary가 latest/points 계약을 지키지 않았습니다.");
  const projectedCalculations = calculations.map((item) => {
    const calculation = item as Record<string, unknown> & { points: unknown[] };
    const { points, ...metadata } = calculation;
    return { ...metadata, latest: points.at(-1) };
  });
  assert(
    isDeepStrictEqual(latestCalculations, projectedCalculations),
    "full-series calculation metadata/마지막 point와 latest-summary가 정확히 일치하지 않습니다.",
  );
  const { response_mode: _fullMode, calculations: _fullCalculations, ...fullSharedResult } = full.result;
  const { response_mode: _latestMode, calculations: _latestCalculations, ...latestSharedResult } = latest.result;
  assert(
    isDeepStrictEqual(latestSharedResult, fullSharedResult),
    "full-series와 latest-summary의 공통 result metadata가 일치하지 않습니다.",
  );
  const latestSummary = latest.summary as Record<string, unknown>;
  assert(latestSummary.indicator_engine_version === EXPECTED_INDICATOR_ENGINE_VERSION, "latest summary engine version 불일치");
  assert(latestSummary.calculation_count === EXPECTED_CALCULATION_COUNT, "latest summary calculation count 불일치");
  assert(latest.artifacts.length === 1 && latest.artifacts[0]?.type === "worker-metrics", "includeArtifacts=false에서 metrics 외 artifact가 반환되었습니다.");

  const profilePayloadBase = {
    schema_version: payloadBase.schema_version,
    adjustment_policy: payloadBase.adjustment_policy,
    instruments: [payloadBase.instruments[0]],
    indicators: [{
      id: "volume-profile-focused",
      kind: "volume_profile",
      parameters: { bucket_count: 24, price_source: "typical_price", value_area_percent: 70 },
      instrument_keys: ["AAA"],
    }],
  };
  const profileStarted = performance.now();
  const profileFull = await client.compute<Record<string, unknown>>(
    "technical_analysis",
    { technical_analysis: { ...profilePayloadBase, response_mode: "full_series" } },
    { includeArtifacts: true },
  );
  const profileRoundTripMs = performance.now() - profileStarted;
  const profileCalculations = profileFull.result.calculations;
  assert(Array.isArray(profileCalculations) && profileCalculations.length === 1, "focused Volume Profile 계산 수 불일치");
  const profileCalculation = profileCalculations[0] as {
    availability?: { status?: unknown };
    metadata?: Record<string, unknown>;
    points?: Array<{ values?: Record<string, unknown> }>;
    profile?: { buckets?: unknown[]; point_of_control?: unknown; value_area_high?: unknown; value_area_low?: unknown };
  };
  assert(profileCalculation.availability?.status === "available", "focused Volume Profile availability 불일치");
  assert(profileCalculation.metadata?.approximate === true, "Volume Profile 근사 metadata 누락");
  assert(profileCalculation.profile?.buckets?.length === 24, "Volume Profile bucket 수 불일치");
  assert(
    [profileCalculation.profile?.point_of_control, profileCalculation.profile?.value_area_high, profileCalculation.profile?.value_area_low]
      .every((value) => typeof value === "number" && Number.isFinite(value)),
    "Volume Profile POC/VAH/VAL 누락",
  );
  const profileIndicatorArtifact = profileFull.artifacts.find((artifact) => artifact.type === "technical-indicators");
  assert(
    isDeepStrictEqual(profileIndicatorArtifact?.content, profileCalculations),
    "focused Volume Profile artifact/result parity 불일치",
  );
  assert((profileFull.summary as Record<string, unknown>).profile_bucket_count === 24, "Volume Profile summary bucket count 불일치");
  assert((profileFull.summary as Record<string, unknown>).approximate_calculation_count === 1, "Volume Profile approximation summary 불일치");

  const profileLatest = await client.compute<Record<string, unknown>>(
    "technical_analysis",
    { technical_analysis: { ...profilePayloadBase, response_mode: "latest_summary" } },
    { includeArtifacts: false },
  );
  const profileLatestCalculations = profileLatest.result.calculations;
  assert(Array.isArray(profileLatestCalculations) && profileLatestCalculations.length === 1, "Volume Profile latest 계산 수 불일치");
  const profileLatestCalculation = profileLatestCalculations[0] as {
    points?: unknown;
    latest?: unknown;
    metadata?: Record<string, unknown>;
    profile?: { buckets?: unknown[] };
  };
  assert(profileLatestCalculation.points === undefined && profileLatestCalculation.latest !== undefined, "Volume Profile latest-summary point 계약 불일치");
  assert(profileLatestCalculation.profile?.buckets?.length === 0, "Volume Profile latest-summary가 bucket을 축약하지 않았습니다.");
  assert(profileLatestCalculation.metadata?.profile_buckets === "omitted_in_latest_summary", "Volume Profile latest 축약 metadata 누락");

  const strategySignalOnlyStarted = performance.now();
  const strategySignalOnly = await client.compute<TechnicalStrategyWorkerResult>(
    "technical_strategy",
    {
      technical_analysis: strategyTechnicalAnalysis(strategyBaseCloses),
      strategy: strategyDefinition,
      safe_trade_dates: [...strategyDates],
      evaluation_start_date: strategyDates[0],
      evaluation_end_date: strategyDates[3],
    },
    { includeArtifacts: true },
  );
  const strategySignalOnlyRoundTripMs = performance.now() - strategySignalOnlyStarted;
  const signalOnlyResult = strategySignalOnly.result;
  assert(signalOnlyResult.backtest === undefined, "signal-only 기술 전략이 backtest ledger를 반환했습니다.");
  assert(
    signalOnlyResult.technical_analysis.indicator_engine_version === EXPECTED_INDICATOR_ENGINE_VERSION,
    "signal-only 기술 전략 indicator engine version 불일치",
  );
  const signalOnlyPoints = signalOnlyResult.technical_analysis.calculations[0]?.points;
  assert(signalOnlyPoints?.length === strategyDates.length, "signal-only 기술 전략이 정확히 4개 날짜를 계산하지 않았습니다.");
  assert(
    signalOnlyResult.technical_strategy.diagnostics.safe_trade_date_count === strategyDates.length,
    "signal-only safe trade date 수가 4개가 아닙니다.",
  );
  assert(signalOnlyResult.technical_strategy.signals.length === 2, "signal-only 신호 수 불일치");
  const signalOnlyActivation = signalOnlyResult.technical_strategy.signals[0]!;
  assert(signalOnlyActivation.status === "planned", "signal-only 첫 신호가 planned가 아닙니다.");
  assert(signalOnlyActivation.signal_date === strategyDates[1], "signal-only activation 계산일 불일치");
  assert(
    signalOnlyActivation.planned_trade_date === strategyDates[2]
      && strategyDates.indexOf(signalOnlyActivation.planned_trade_date) === strategyDates.indexOf(signalOnlyActivation.signal_date) + 1,
    "signal-only activation이 strictly-next-safe 거래일을 사용하지 않았습니다.",
  );
  const terminalSignal = signalOnlyResult.technical_strategy.signals[1]!;
  assert(
    terminalSignal.signal_date === strategyDates[3]
      && terminalSignal.status === "no_safe_trade_date"
      && terminalSignal.planned_trade_date === null,
    "마지막 날짜의 신호가 no_safe_trade_date로 보존되지 않았습니다.",
  );
  const signalOnlyArtifact = strategySignalOnly.artifacts.find((artifact) => artifact.type === "technical-signals");
  assert(
    signalOnlyArtifact?.row_count === signalOnlyResult.technical_strategy.signals.length
      && isDeepStrictEqual(signalOnlyArtifact.content, signalOnlyResult.technical_strategy.signals),
    "signal-only technical-signals artifact/result parity 불일치",
  );

  const strategyCombinedStarted = performance.now();
  const strategyCombined = await client.compute<TechnicalStrategyWorkerResult>(
    "technical_strategy",
    {
      technical_analysis: strategyTechnicalAnalysis(strategyFutureChangedCloses),
      strategy: strategyDefinition,
      simulation: strategySimulation(strategyFutureChangedCloses),
      response_context: strategyResponseContext(),
    },
    { includeArtifacts: true },
  );
  const strategyCombinedRoundTripMs = performance.now() - strategyCombinedStarted;
  const combinedResult = strategyCombined.result;
  assert(combinedResult.backtest, "combined 기술 전략 ledger 결과가 없습니다.");
  const combinedPoints = combinedResult.technical_analysis.calculations[0]?.points;
  assert(combinedPoints?.length === strategyDates.length, "combined 기술 전략이 정확히 4개 날짜를 계산하지 않았습니다.");
  assert(
    combinedResult.technical_strategy.diagnostics.safe_trade_date_count === strategyDates.length,
    "combined ledger common observation 수가 4개가 아닙니다.",
  );
  assert(combinedResult.technical_strategy.signals.length === 1, "combined 기술 전략 신호 수 불일치");
  const appliedSignal = combinedResult.technical_strategy.signals[0]!;
  assert(
    appliedSignal.status === "applied"
      && appliedSignal.signal_date === strategyDates[1]
      && appliedSignal.planned_trade_date === strategyDates[2]
      && appliedSignal.actual_application_date === strategyDates[2],
    "combined activation의 signal/planned/actual 날짜가 일치하지 않습니다.",
  );
  assert(
    strategyDates.indexOf(appliedSignal.planned_trade_date) === strategyDates.indexOf(appliedSignal.signal_date) + 1,
    "combined activation이 strictly-next-safe 거래일을 사용하지 않았습니다.",
  );
  const appliedSchedule = combinedResult.backtest.targetWeightSchedule.find((entry) => (
    entry.action === appliedSignal.signal_id
  ));
  assert(
    appliedSchedule?.scheduledDate === appliedSignal.planned_trade_date
      && appliedSchedule.effectiveDate === appliedSignal.actual_application_date,
    "applied signal과 실제 ledger targetWeightSchedule이 일치하지 않습니다.",
  );
  const combinedSignalArtifact = strategyCombined.artifacts.find((artifact) => artifact.type === "technical-signals");
  assert(
    combinedSignalArtifact?.row_count === combinedResult.technical_strategy.signals.length
      && isDeepStrictEqual(combinedSignalArtifact.content, combinedResult.technical_strategy.signals),
    "combined technical-signals artifact/result parity 불일치",
  );
  assert(
    isDeepStrictEqual(
      signalPrefix(signalOnlyResult, strategyDates[3]),
      signalPrefix(combinedResult, strategyDates[3]),
    ),
    "마지막 미래 OHLC 값을 바꾸자 그 이전 기술 신호 prefix가 변경되었습니다.",
  );

  parityDatabase = new SqliteDatabase(":memory:");
  const runRepository = new RunRepository(parityDatabase);
  const artifactRepository = new ArtifactRepository(parityDatabase);
  await runRepository.initialize();
  await artifactRepository.initialize();
  const artifactService = new ArtifactService(artifactRepository, 1_000, 10_000_000);
  const runService = new RunService(runRepository, artifactService, 2, 10, { executionMode: "rust_socket" });
  const bySymbol = new Map(payloadBase.instruments.map((instrument) => [instrument.symbol, marketSeries(instrument)]));
  const marketData = {
    getPriceSeries: async ({ symbol }: { symbol: string }) => {
      const series = bySymbol.get(symbol);
      if (!series) throw new Error(`parity fixture에 없는 종목입니다: ${symbol}`);
      return series;
    },
  } as unknown as MarketDataService;
  const technicalAnalysis = new TechnicalAnalysisService(
    marketData,
    runService,
    artifactService,
    client,
  );
  const handlers = createToolHandlers({ technicalAnalysis } as unknown as McpToolDependencies);
  const commonRequest = toolSchemas.analyze_technical_signals.parse({
    symbols: payloadBase.instruments.map((instrument) => instrument.symbol),
    fromDate: payloadBase.instruments[0]!.bars[0]!.date,
    toDate: payloadBase.instruments[0]!.bars.at(-1)!.date,
    interval: "1d",
    adjusted: true,
    currencyMode: "local",
    responseMode: "full_series",
    indicators: payloadBase.indicators,
  });
  const httpEnvelope = await handlers.analyze_technical_signals(commonRequest, "technical-parity-owner");
  const mcpEnvelope = await handlers.analyze_technical_signals(commonRequest, "technical-parity-owner");
  const httpPayload = unwrapTechnicalAnalysisPayload(httpEnvelope);
  const mcpPayload = unwrapTechnicalAnalysisPayload(mcpEnvelope);
  assert(httpPayload && mcpPayload, "실제 공통 service 응답을 UI consumer가 해석하지 못했습니다.");
  assert(
    isDeepStrictEqual(httpPayload.technical_analysis, full.result),
    "실제 Rust UDS와 HTTP 공통 service의 지표 수치가 일치하지 않습니다.",
  );
  assert(
    isDeepStrictEqual(mcpPayload.technical_analysis, httpPayload.technical_analysis),
    "HTTP와 MCP 공통 handler의 지표 수치가 일치하지 않습니다.",
  );
  assert(httpPayload.reused === false && mcpPayload.reused === true, "HTTP→MCP 동일 요청의 run cache 재사용이 확인되지 않았습니다.");
  assert(httpPayload.run_id === mcpPayload.run_id, "HTTP와 MCP가 동일한 cached run을 반환하지 않았습니다.");

  let uiComparedValues = 0;
  for (const series of httpPayload.price_series) {
    const instrumentCalculations = calculationsForInstrument(httpPayload, series.key);
    const rows = buildTechnicalChartRows(series, instrumentCalculations);
    const lastRow = rows.at(-1);
    assert(lastRow, `UI ${series.key} chart row가 비어 있습니다.`);
    for (const calculation of instrumentCalculations) {
      const lastPoint = calculation.points?.at(-1);
      assert(lastPoint?.date === lastRow.date, `UI ${series.key}/${calculation.indicator_id} 마지막 날짜 불일치`);
      for (const [field, value] of Object.entries(lastPoint.values)) {
        const renderedValue = lastRow.indicatorValues[`${calculation.indicator_id}:${field}`];
        assert(Object.is(renderedValue, value), `UI ${series.key}/${calculation.indicator_id}:${field} 수치 불일치`);
        uiComparedValues += 1;
      }
    }
  }
  assert(uiComparedValues > EXPECTED_CALCULATION_COUNT, "UI consumer field-level parity 비교 수가 부족합니다.");

  const focusedRequest = toolSchemas.analyze_technical_signals.parse({
    symbols: ["AAA"],
    fromDate: payloadBase.instruments[0]!.bars[0]!.date,
    toDate: payloadBase.instruments[0]!.bars.at(-1)!.date,
    interval: "1d",
    adjusted: true,
    currencyMode: "local",
    responseMode: "full_series",
    indicators: [{
      id: "volume-profile-focused",
      kind: "volume_profile",
      parameters: { bucket_count: 24, price_source: "typical_price", value_area_percent: 70 },
      instrumentKeys: ["AAA"],
    }],
  });
  const httpFocusedEnvelope = await handlers.analyze_technical_signals(focusedRequest, "technical-profile-parity-owner");
  const mcpFocusedEnvelope = await handlers.analyze_technical_signals(focusedRequest, "technical-profile-parity-owner");
  const httpFocusedPayload = unwrapTechnicalAnalysisPayload(httpFocusedEnvelope);
  const mcpFocusedPayload = unwrapTechnicalAnalysisPayload(mcpFocusedEnvelope);
  assert(httpFocusedPayload && mcpFocusedPayload, "focused 공통 service 응답을 UI consumer가 해석하지 못했습니다.");
  assert(
    isDeepStrictEqual(httpFocusedPayload.technical_analysis, profileFull.result),
    "실제 Rust UDS와 HTTP focused Volume Profile 결과가 일치하지 않습니다.",
  );
  assert(
    isDeepStrictEqual(mcpFocusedPayload.technical_analysis, httpFocusedPayload.technical_analysis),
    "HTTP와 MCP focused Volume Profile 결과가 일치하지 않습니다.",
  );
  const uiProfile = volumeProfileCalculation(httpFocusedPayload);
  assert(uiProfile?.profile?.buckets.length === 24, "UI Volume Profile consumer bucket parity 누락");
  assert(uiProfile.profile.point_of_control === profileCalculation.profile?.point_of_control, "UI Volume Profile POC parity 불일치");
  assert(mcpFocusedPayload.reused === true, "focused HTTP→MCP run cache 재사용이 확인되지 않았습니다.");

  process.stdout.write(`${JSON.stringify({
    status: "passed",
    instruments: EXPECTED_INSTRUMENT_COUNT,
    indicators: TECHNICAL_INDICATOR_KINDS.length,
    calculations: calculations.length + profileCalculations.length,
    full_series_round_trip_ms: Number(fullRoundTripMs.toFixed(3)),
    latest_summary_round_trip_ms: Number(latestRoundTripMs.toFixed(3)),
    worker_compute_ms: Number(metrics.compute_ms),
    volume_profile_round_trip_ms: Number(profileRoundTripMs.toFixed(3)),
    volume_profile_buckets: profileCalculation.profile?.buckets?.length,
    strategy_signal_only_round_trip_ms: Number(strategySignalOnlyRoundTripMs.toFixed(3)),
    strategy_combined_round_trip_ms: Number(strategyCombinedRoundTripMs.toFixed(3)),
    strategy_signal_only_signal_count: signalOnlyResult.technical_strategy.signals.length,
    strategy_combined_signal_count: combinedResult.technical_strategy.signals.length,
    http_mcp_ui_field_values_compared: uiComparedValues,
    common_service_cache_reused: mcpPayload.reused,
  })}\n`);
} catch (error) {
  if (stderr) process.stderr.write(stderr);
  throw error;
} finally {
  client.close();
  await parityDatabase?.close();
  if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    if (worker.exitCode !== null || worker.signalCode !== null) resolve();
    else worker.once("exit", () => resolve());
  });
  await rm(directory, { recursive: true, force: true });
}
