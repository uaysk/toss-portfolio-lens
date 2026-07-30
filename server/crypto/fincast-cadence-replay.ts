import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { join } from "node:path";
import {
  AiCostAssumptionsSchema,
  AiForecastRequestSchema,
  AiResponseSchema,
  FINCAST_MODEL_ID,
  SCALPING_AI_HORIZONS,
  SCALPING_AI_QUANTILES,
  aiRequestBase,
  type AiForecastRequest,
  type AiResponse,
} from "../worker/ai-contract.js";
import {
  normalizeRestKlines,
  type BinanceKline,
  type BinanceRestMarketData,
} from "./binance-market-data.js";
import {
  loadFinCastCadenceMarketData,
  type FinCastCadenceMarketData,
} from "./fincast-cadence-market-data.js";
import {
  writeFinCastRawInputArtifact,
  type FinCastRawInputArtifact,
} from "./fincast-raw-artifact.js";

const MINUTE_MS = 60_000;
const ORIGIN_HOURS = 4 as const;
const ORIGIN_COUNT = 240 as const;
const OUTCOME_TAIL_MINUTES = 60 as const;
const CONTEXT_BARS = 512 as const;
const CANONICAL_MINUTE_BAR_COUNT = 811 as const;
const FORECAST_BATCH_SIZE = 50;
const DEFAULT_DEADLINE_MS = 4 * 60 * 60_000;
const MAXIMUM_DEADLINE_MS = 24 * 60 * 60_000;
const NUMBER_TOLERANCE = 1e-12;
const OUTPUT_SCHEMA = "crypto-fincast-cadence-comparison/v1";
const PINNED_FINCAST = {
  modelId: FINCAST_MODEL_ID,
  modelRevision: "2d7d90b159db8961d27c2cf165d51195902ef92b",
  sourceRevision: "488b19d1d85fa2b3d4b93469530cefdcf1cc97a4",
  loaderVersion: "fincast-source-488b19d",
  license: "Apache-2.0",
  deviceName: "Tesla P40",
  cudaCapability: "6.1",
} as const;

export type FinCastCadenceSeconds = 15 | 30 | 60;

export type FinCastCadenceReplayClient = {
  request(input: AiForecastRequest, signal?: AbortSignal): Promise<unknown>;
};

export type FinCastCadenceClock = {
  now(): number;
};

export type FinCastCadenceCostAssumptions = {
  commission_bps_per_side: number;
  tax_bps_on_exit: number;
  spread_bps_round_trip: number;
  slippage_bps_per_side: number;
};

export type FinCastCadenceQuantileMetric = {
  quantile: (typeof SCALPING_AI_QUANTILES)[number];
  pinballLoss: number;
  observedCoverage: number;
  calibrationError: number;
};

export type FinCastCadenceHorizonMetrics = {
  horizonMinutes: (typeof SCALPING_AI_HORIZONS)[number];
  count: number;
  meanPinballLoss: number;
  medianReturnMae: number;
  directionAccuracy: number;
  upProbabilityBrier: number;
  quantiles: FinCastCadenceQuantileMetric[];
};

export type FinCastCadenceReplayRecord = {
  originAt: string;
  horizonMinutes: (typeof SCALPING_AI_HORIZONS)[number];
  targetAt: string;
  originClose: number;
  nextMinuteOpen: number;
  targetClose: number;
  actualReturn: number;
  executionReturn: number;
  roundTripCostRate: number;
  predictedMedianReturn: number;
  upProbability: number;
  predictedQuantiles: Array<{
    quantile: (typeof SCALPING_AI_QUANTILES)[number];
    value: number;
  }>;
};

export type FinCastCadenceResult = {
  candleSeconds: FinCastCadenceSeconds;
  contextBars: 512;
  contextSpanMinutes: 128 | 256 | 512;
  originCount: 240;
  recordCount: 960;
  availability: "available";
  inputDigest: string;
  workerInputDigest: string;
  recordDigest: string;
  modelDigest: string;
  model: AiResponse["model"];
  requestCount: number;
  modelLatencyMs: number;
  wallLatencyMs: number;
  metrics: FinCastCadenceHorizonMetrics[];
  records: FinCastCadenceReplayRecord[];
  rawInputArtifact?: {
    manifestPath: string;
    manifestSha256: string;
    contextsSha256: string;
    originsSha256: string;
  };
};

export type FinCastCadenceComparisonResult = {
  schemaVersion: "crypto-fincast-cadence-comparison/v1";
  generatedAt: string;
  executionMode: "historical_replay";
  realOrder: false;
  market: {
    kind: "crypto_futures";
    venue: "BINANCE_USDM";
    quoteAsset: "USDT";
    contractType: "PERPETUAL";
  };
  symbol: string;
  window: {
    originStartAt: string;
    originEndExclusiveAt: string;
    outcomeEndExclusiveAt: string;
    originHours: 4;
    originCount: 240;
    originStrideSeconds: 60;
    outcomeTailMinutes: 60;
    canonicalMinuteBarCount: 811;
  };
  costAssumptions: FinCastCadenceCostAssumptions;
  roundTripCostRate: number;
  provenance: {
    canonicalMinuteDigest: string;
    aggregateTradeDigest: string;
    aggregateTradeCount: number;
    aggregateTradeRequestCount: number;
    aggregateTradeRequestWeight: number;
    adaptiveSplitCount: number;
    bars15sDigest: string;
    bars30sDigest: string;
  };
  common: {
    originDigest: string;
    outcomeDigest: string;
    fillBarrierDigest: string;
    costDigest: string;
  };
  cadences: {
    "15": FinCastCadenceResult;
    "30": FinCastCadenceResult;
    "60": FinCastCadenceResult;
  };
  comparison: {
    sameOrigins: true;
    sameOutcomes: true;
    sameCosts: true;
    sameFillBarrier: true;
    sameModelIdentity: true;
    automaticWinner: null;
    outcome: "inconclusive";
    limitations: [
      "single_symbol_four_hour_window",
      "overlapping_forecast_horizons",
      "cadence_and_context_span_change_together",
    ];
  };
};

export type FinCastCadenceReplayOptions = {
  rest: Pick<BinanceRestMarketData, "klines" | "aggregateTrades">;
  client: FinCastCadenceReplayClient;
  clock?: FinCastCadenceClock;
  monotonicNow?: () => number;
  requestId?: () => string;
  deadlineMs?: number;
  aggregateTradePageDelayMs?: number;
  aggregateTradeMaximumPagesPerLeaf?: number;
  aggregateTradePace?: (
    delayMs: number,
    signal?: AbortSignal,
  ) => Promise<void>;
  rawInputArtifacts?: {
    root: string;
    modelSeed: number;
  };
};

export type FinCastCadenceReplayInput = {
  symbol: string;
  endExclusive: number;
  costAssumptions: FinCastCadenceCostAssumptions;
  signal?: AbortSignal;
  deadlineMs?: number;
};

type ReplayWindow = {
  originStart: number;
  originEndExclusive: number;
  outcomeEndExclusive: number;
  canonicalDataStart: number;
  microDataStart: number;
};

type CommonOrigin = {
  ordinal: number;
  originAt: string;
  originMs: number;
  originClose: number;
  nextMinuteOpen: number;
  futureBars: BinanceKline[];
};

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function normalizedSymbol(value: string): string {
  const symbol = value.trim().toUpperCase();
  if (!/^[A-Z0-9]{2,32}$/.test(symbol) || !symbol.endsWith("USDT")) {
    throw new Error("FinCast cadence replay symbol must identify a Binance USDT contract.");
  }
  return symbol;
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function exactMinute(value: number, name: string): number {
  const parsed = boundedInteger(value, MINUTE_MS, Number.MAX_SAFE_INTEGER, name);
  if (parsed % MINUTE_MS !== 0) throw new Error(`${name} must align to a UTC minute.`);
  return parsed;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("FinCast cadence replay was cancelled.");
}

function sameNumber(left: number, right: number): boolean {
  return Math.abs(left - right) <= NUMBER_TOLERANCE
    * Math.max(1, Math.abs(left), Math.abs(right));
}

function direction(value: number): -1 | 0 | 1 {
  return value > 0 ? 1 : value < 0 ? -1 : 0;
}

function roundTripCostRate(costs: FinCastCadenceCostAssumptions): number {
  return (
    costs.commission_bps_per_side * 2
    + costs.tax_bps_on_exit
    + costs.spread_bps_round_trip
    + costs.slippage_bps_per_side * 2
  ) / 10_000;
}

function windowFor(endExclusive: number): ReplayWindow {
  const originEndExclusive = exactMinute(
    endExclusive,
    "FinCast cadence origin endExclusive",
  );
  const originStart = originEndExclusive - ORIGIN_COUNT * MINUTE_MS;
  return {
    originStart,
    originEndExclusive,
    outcomeEndExclusive: originEndExclusive + OUTCOME_TAIL_MINUTES * MINUTE_MS,
    canonicalDataStart: originStart - (CONTEXT_BARS - 1) * MINUTE_MS,
    // The first 30s context ends at originStart + 60s and starts 255m earlier.
    microDataStart: originStart - 255 * MINUTE_MS,
  };
}

async function loadCanonicalMinuteBars(input: {
  rest: Pick<BinanceRestMarketData, "klines">;
  symbol: string;
  window: ReplayWindow;
  authoritativeNow: number;
  signal: AbortSignal;
}): Promise<BinanceKline[]> {
  if (input.signal.aborted) throw abortError(input.signal);
  const payload = await input.rest.klines({
    symbol: input.symbol,
    startTime: input.window.canonicalDataStart,
    endTime: input.window.outcomeEndExclusive - 1,
    limit: 1_024,
  });
  if (!Array.isArray(payload)) {
    throw new Error("Binance canonical 1m replay payload is not an array.");
  }
  const bars = normalizeRestKlines(
    input.symbol,
    payload,
    input.authoritativeNow,
  ).filter((bar) => (
    bar.openTime >= input.window.canonicalDataStart
    && bar.openTime < input.window.outcomeEndExclusive
  ));
  if (bars.length !== payload.length || bars.length !== CANONICAL_MINUTE_BAR_COUNT) {
    throw new Error(
      `Expected ${CANONICAL_MINUTE_BAR_COUNT} canonical 1m bars but received ${bars.length}.`,
    );
  }
  for (let index = 0; index < bars.length; index += 1) {
    const bar = bars[index]!;
    const expectedOpenTime = input.window.canonicalDataStart + index * MINUTE_MS;
    if (
      !bar.final
      || bar.symbol !== input.symbol
      || bar.interval !== "1m"
      || bar.openTime !== expectedOpenTime
      || bar.closeTime !== expectedOpenTime + MINUTE_MS - 1
    ) {
      throw new Error(
        `Canonical Binance 1m continuity failed at ${new Date(expectedOpenTime).toISOString()}.`,
      );
    }
  }
  return bars;
}

function commonOrigins(
  bars: readonly BinanceKline[],
  window: ReplayWindow,
): CommonOrigin[] {
  const byOpenTime = new Map(bars.map((bar) => [bar.openTime, bar]));
  const origins: CommonOrigin[] = [];
  for (let ordinal = 0; ordinal < ORIGIN_COUNT; ordinal += 1) {
    const originOpenTime = window.originStart + ordinal * MINUTE_MS;
    const origin = byOpenTime.get(originOpenTime);
    const next = byOpenTime.get(originOpenTime + MINUTE_MS);
    const futureBars = Array.from(
      { length: OUTCOME_TAIL_MINUTES },
      (_unused, index) => byOpenTime.get(originOpenTime + (index + 1) * MINUTE_MS),
    );
    if (!origin || !next || futureBars.some((bar) => bar === undefined)) {
      throw new Error("Canonical Binance 1m outcomes are incomplete.");
    }
    origins.push({
      ordinal,
      originAt: new Date(origin.closeTime).toISOString(),
      originMs: origin.closeTime,
      originClose: origin.close,
      nextMinuteOpen: next.open,
      futureBars: futureBars as BinanceKline[],
    });
  }
  return origins;
}

function aiBars(bars: readonly BinanceKline[]): AiForecastRequest["series"][number]["bars"] {
  return bars.map((bar) => ({
    timestamp: new Date(bar.closeTime).toISOString(),
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
    amount: bar.quoteVolume,
    complete: true,
  }));
}

function contextForOrigin(input: {
  cadence: FinCastCadenceSeconds;
  bars: readonly BinanceKline[];
  origin: CommonOrigin;
}): BinanceKline[] {
  const originIndex = input.bars.findIndex((bar) => bar.closeTime === input.origin.originMs);
  if (originIndex < CONTEXT_BARS - 1) {
    throw new Error(`FinCast ${input.cadence}s context does not contain 512 causal bars.`);
  }
  const context = input.bars.slice(originIndex - CONTEXT_BARS + 1, originIndex + 1);
  const intervalMs = input.cadence * 1_000;
  const expectedInterval = input.cadence === 60 ? "1m" : `${input.cadence}s`;
  for (let index = 0; index < context.length; index += 1) {
    const bar = context[index]!;
    if (
      !bar.final
      || bar.interval !== expectedInterval
      || bar.closeTime !== bar.openTime + intervalMs - 1
      || (index > 0 && bar.openTime !== context[index - 1]!.openTime + intervalMs)
    ) {
      throw new Error(`FinCast ${input.cadence}s context continuity failed.`);
    }
  }
  const latest = context.at(-1)!;
  if (
    latest.closeTime !== input.origin.originMs
    || !sameNumber(latest.close, input.origin.originClose)
  ) {
    throw new Error(`FinCast ${input.cadence}s context is not aligned to the canonical origin.`);
  }
  return context;
}

function validatePinnedFinCastModel(model: AiResponse["model"]): string {
  const precisionFailureReasons = model.precision_failure_reasons ?? [];
  const validPrecision = (
    model.dtype === "mixed_float16"
    && model.precision_validation === "passed"
    && precisionFailureReasons.length === 0
  ) || (
    model.dtype === "float32"
    && model.precision_validation === "fallback_fp32"
    && precisionFailureReasons.length > 0
  );
  if (
    model.model_id !== PINNED_FINCAST.modelId
    || model.model_revision !== PINNED_FINCAST.modelRevision
    || model.source_revision !== PINNED_FINCAST.sourceRevision
    || model.loader_version !== PINNED_FINCAST.loaderVersion
    || model.license !== PINNED_FINCAST.license
    || (model.tokenizer_id ?? null) !== null
    || (model.tokenizer_revision ?? null) !== null
    || !model.loaded
    || model.device !== "cuda"
    || model.device_name !== PINNED_FINCAST.deviceName
    || model.cuda_capability !== PINNED_FINCAST.cudaCapability
    || model.attention_backend !== "math"
    || !validPrecision
    || model.memory_status !== "ok"
    || model.quantile_monotonicity_policy !== "fp32_monotone_rearrangement_v1"
    || model.quantile_tail_policy !== "tail_clamped_q10_q90"
    || model.peak_vram_bytes === null
    || model.peak_vram_bytes === undefined
    || model.peak_vram_bytes <= 0
    || model.peak_vram_measurement !== "cuda_allocated_or_reserved"
    || (model.fallback_from ?? null) !== null
    || (model.fallback_reason ?? null) !== null
  ) {
    throw new Error("FinCast cadence replay received unpinned model provenance.");
  }
  return digest(model);
}

function validateForecastResponse(input: {
  raw: unknown;
  request: AiForecastRequest;
  contexts: readonly BinanceKline[][];
}): {
  response: AiResponse;
  modelDigest: string;
  modelLatencyMs: number;
  workerInputDigests: string[];
} {
  const response = AiResponseSchema.parse(input.raw);
  if (
    response.request_id !== input.request.request_id
    || response.mode !== "forecast"
    || response.status !== "available"
    || response.error
    || response.series.length !== input.request.series.length
    || response.model_runs?.length !== 1
  ) {
    throw new Error("FinCast cadence forecast response identity or availability is invalid.");
  }
  const modelDigest = validatePinnedFinCastModel(response.model);
  const modelRun = response.model_runs[0]!;
  if (
    modelRun.role !== "fincast"
    || modelRun.expected_model_id !== FINCAST_MODEL_ID
    || modelRun.status !== "available"
    || modelRun.degraded
    || modelRun.fallback_used
    || (modelRun.fallback_reason ?? null) !== null
    || modelRun.input_origins.length !== input.request.series.length
  ) {
    throw new Error("FinCast cadence independent model-run evidence is invalid.");
  }

  const workerInputDigests: string[] = [];
  for (let index = 0; index < input.request.series.length; index += 1) {
    const requested = input.request.series[index]!;
    const result = response.series[index]!;
    const evidence = modelRun.input_origins[index]!;
    const context = input.contexts[index]!;
    if (
      result.instrument_key !== requested.instrument_key
      || result.status !== "available"
      || Date.parse(result.input_end_at) !== Date.parse(requested.input_end_at)
      || result.input_quality.status !== "good"
      || result.input_quality.bar_count !== CONTEXT_BARS
      || result.input_quality.missing_volume_ratio !== 0
      || result.input_quality.missing_amount_ratio !== 0
      || result.input_quality.irregular_interval_count !== 0
      || result.input_quality.warnings.length !== 0
      || evidence.instrument_key !== requested.instrument_key
      || Date.parse(evidence.input_end_at) !== Date.parse(requested.input_end_at)
      || Date.parse(evidence.context_start_at) !== context[0]!.closeTime
      || evidence.bar_count !== CONTEXT_BARS
    ) {
      throw new Error("FinCast cadence response changed an input origin or effective context.");
    }
    workerInputDigests.push(evidence.input_digest);
    for (let horizonIndex = 0; horizonIndex < SCALPING_AI_HORIZONS.length; horizonIndex += 1) {
      const horizon = SCALPING_AI_HORIZONS[horizonIndex]!;
      const forecast = result.horizons[horizonIndex];
      const expectedTarget = requested.future_timestamps[horizon - 1]!;
      if (
        !forecast
        || forecast.horizon_minutes !== horizon
        || Date.parse(forecast.target_timestamp) !== Date.parse(expectedTarget)
        || forecast.return_quantiles.length !== SCALPING_AI_QUANTILES.length
        || forecast.price_quantiles.length !== SCALPING_AI_QUANTILES.length
        || forecast.up_probability === null
        || forecast.up_probability === undefined
      ) {
        throw new Error("FinCast cadence response changed a fixed forecast horizon.");
      }
      let previousReturn = Number.NEGATIVE_INFINITY;
      for (let quantileIndex = 0; quantileIndex < SCALPING_AI_QUANTILES.length; quantileIndex += 1) {
        const quantile = SCALPING_AI_QUANTILES[quantileIndex]!;
        const predictedReturn = forecast.return_quantiles[quantileIndex]!;
        const predictedPrice = forecast.price_quantiles[quantileIndex]!;
        const base = context.at(-1)!.close;
        if (
          predictedReturn.quantile !== quantile
          || predictedPrice.quantile !== quantile
          || predictedReturn.value < previousReturn
          || !sameNumber(predictedPrice.value / base - 1, predictedReturn.value)
        ) {
          throw new Error("FinCast cadence response returned invalid quantile evidence.");
        }
        previousReturn = predictedReturn.value;
      }
    }
  }
  return {
    response,
    modelDigest,
    modelLatencyMs: modelRun.latency_ms,
    workerInputDigests,
  };
}

function metrics(records: readonly FinCastCadenceReplayRecord[]): FinCastCadenceHorizonMetrics[] {
  return SCALPING_AI_HORIZONS.map((horizonMinutes) => {
    const horizonRecords = records.filter((record) => (
      record.horizonMinutes === horizonMinutes
    ));
    if (horizonRecords.length !== ORIGIN_COUNT) {
      throw new Error(`FinCast cadence ${horizonMinutes}m metrics have incomplete records.`);
    }
    const quantiles = SCALPING_AI_QUANTILES.map((quantile) => {
      let loss = 0;
      let covered = 0;
      for (const record of horizonRecords) {
        const predicted = record.predictedQuantiles.find((item) => item.quantile === quantile);
        if (!predicted) throw new Error("FinCast cadence metric is missing a quantile.");
        const error = record.actualReturn - predicted.value;
        loss += Math.max(quantile * error, (quantile - 1) * error);
        covered += Number(record.actualReturn <= predicted.value);
      }
      const observedCoverage = covered / horizonRecords.length;
      return {
        quantile,
        pinballLoss: loss / horizonRecords.length,
        observedCoverage,
        calibrationError: observedCoverage - quantile,
      };
    });
    return {
      horizonMinutes,
      count: horizonRecords.length,
      meanPinballLoss: quantiles.reduce((sum, item) => sum + item.pinballLoss, 0)
        / quantiles.length,
      medianReturnMae: horizonRecords.reduce((sum, record) => (
        sum + Math.abs(record.actualReturn - record.predictedMedianReturn)
      ), 0) / horizonRecords.length,
      directionAccuracy: horizonRecords.reduce((sum, record) => (
        sum + Number(direction(record.actualReturn) === direction(record.predictedMedianReturn))
      ), 0) / horizonRecords.length,
      upProbabilityBrier: horizonRecords.reduce((sum, record) => (
        sum + (record.upProbability - Number(record.actualReturn > 0)) ** 2
      ), 0) / horizonRecords.length,
      quantiles,
    };
  });
}

export class FinCastCadenceComparisonReplay {
  private readonly clock: FinCastCadenceClock;
  private readonly monotonicNow: () => number;
  private readonly requestId: () => string;
  private readonly deadlineMs: number;

  constructor(private readonly options: FinCastCadenceReplayOptions) {
    this.clock = options.clock ?? { now: Date.now };
    this.monotonicNow = options.monotonicNow ?? performance.now.bind(performance);
    this.requestId = options.requestId ?? (() => `fincast-cadence:${randomUUID()}`);
    this.deadlineMs = boundedInteger(
      options.deadlineMs ?? DEFAULT_DEADLINE_MS,
      1,
      MAXIMUM_DEADLINE_MS,
      "FinCast cadence deadlineMs",
    );
  }

  async run(input: FinCastCadenceReplayInput): Promise<FinCastCadenceComparisonResult> {
    const symbol = normalizedSymbol(input.symbol);
    const costs = AiCostAssumptionsSchema.parse(input.costAssumptions);
    const deadlineMs = boundedInteger(
      input.deadlineMs ?? this.deadlineMs,
      1,
      MAXIMUM_DEADLINE_MS,
      "FinCast cadence deadlineMs",
    );
    const authoritativeNow = this.clock.now();
    const window = windowFor(input.endExclusive);
    if (window.outcomeEndExclusive > Math.floor(authoritativeNow / MINUTE_MS) * MINUTE_MS) {
      throw new Error("FinCast cadence outcome tail is not completely closed.");
    }
    if (!this.options.rest.aggregateTrades) {
      throw new Error("FinCast cadence replay requires Binance aggregate-trade REST data.");
    }
    const controller = new AbortController();
    const deadline = setTimeout(() => {
      controller.abort(new Error(`FinCast cadence replay exceeded its ${deadlineMs}ms deadline.`));
    }, deadlineMs);
    deadline.unref?.();
    const forwardAbort = () => controller.abort(
      input.signal?.reason instanceof Error
        ? input.signal.reason
        : new Error("FinCast cadence replay was cancelled."),
    );
    input.signal?.addEventListener("abort", forwardAbort, { once: true });
    if (input.signal?.aborted) forwardAbort();

    try {
      const canonicalBars = await loadCanonicalMinuteBars({
        rest: this.options.rest,
        symbol,
        window,
        authoritativeNow,
        signal: controller.signal,
      });
      const initialPriceBar = canonicalBars.find(
        (bar) => bar.closeTime === window.microDataStart - 1,
      );
      if (!initialPriceBar) {
        throw new Error("Canonical 1m data cannot seed FinCast micro-bar recovery.");
      }
      const micro = await loadFinCastCadenceMarketData({
        symbol,
        startTime: window.microDataStart,
        endExclusive: window.originEndExclusive,
        initialPrice: initialPriceBar.close,
        signal: controller.signal,
        aggregateTrades: (request) => this.options.rest.aggregateTrades!(request),
        ...(this.options.aggregateTradePageDelayMs === undefined
          ? {}
          : { pageDelayMs: this.options.aggregateTradePageDelayMs }),
        ...(this.options.aggregateTradeMaximumPagesPerLeaf === undefined
          ? {}
          : { maximumPagesPerLeaf: this.options.aggregateTradeMaximumPagesPerLeaf }),
        ...(this.options.aggregateTradePace === undefined
          ? {}
          : { pace: this.options.aggregateTradePace }),
      });
      const origins = commonOrigins(canonicalBars, window);
      const originDigest = digest(origins.map((origin) => origin.originAt));
      const outcomeReference = origins.flatMap((origin) => (
        SCALPING_AI_HORIZONS.map((horizon) => {
          const target = origin.futureBars[horizon - 1]!;
          return {
            originAt: origin.originAt,
            horizon,
            targetAt: new Date(target.closeTime).toISOString(),
            originClose: origin.originClose,
            targetClose: target.close,
          };
        })
      ));
      const fillReference = origins.map((origin) => ({
        originAt: origin.originAt,
        nextMinuteOpen: origin.nextMinuteOpen,
      }));
      const modelDigests = new Set<string>();
      const cadenceResults = new Map<FinCastCadenceSeconds, FinCastCadenceResult>();
      const barsByCadence = new Map<FinCastCadenceSeconds, readonly BinanceKline[]>([
        [15, micro.bars15s],
        [30, micro.bars30s],
        [60, canonicalBars],
      ]);

      for (const cadence of [15, 30, 60] as const) {
        if (controller.signal.aborted) throw abortError(controller.signal);
        const cadenceBars = barsByCadence.get(cadence)!;
        const inputHash = createHash("sha256");
        const workerInputDigests: string[] = [];
        const records: FinCastCadenceReplayRecord[] = [];
        let model: AiResponse["model"] | undefined;
        let modelDigest = "";
        let modelLatencyMs = 0;
        let requestCount = 0;
        const wallStartedAt = this.monotonicNow();
        const cadenceContexts = origins.map((origin) => contextForOrigin({
          cadence,
          bars: cadenceBars,
          origin,
        }));
        let rawInputArtifact: FinCastRawInputArtifact | undefined;
        if (this.options.rawInputArtifacts) {
          rawInputArtifact = await writeFinCastRawInputArtifact({
            directory: join(
              this.options.rawInputArtifacts.root,
              String(cadence),
            ),
            cadenceSeconds: cadence,
            modelSeed: this.options.rawInputArtifacts.modelSeed,
            rows: origins.map((origin, index) => ({
              instrumentKey: `${symbol}:${cadence}s:${origin.ordinal}`,
              origin: origin.originAt,
              futureTimestamps: origin.futureBars.map(
                (bar) => new Date(bar.closeTime).toISOString(),
              ),
              closes: cadenceContexts[index]!.map((bar) => bar.close),
              metadata: {
                venue: "BINANCE_USDM",
                symbol,
                cadence_seconds: cadence,
                ordinal: origin.ordinal,
              },
            })),
            metadata: {
              source: "FinCastCadenceComparisonReplay",
              execution_mode: "historical_replay",
              venue: "BINANCE_USDM",
              symbol,
              origin_digest: originDigest,
              canonical_minute_digest: digest(canonicalBars),
              aggregate_trade_digest: micro.aggregateTradeDigest,
            },
          });
        }

        for (let offset = 0; offset < origins.length; offset += FORECAST_BATCH_SIZE) {
          const batchOrigins = origins.slice(offset, offset + FORECAST_BATCH_SIZE);
          const contexts = cadenceContexts.slice(
            offset,
            offset + FORECAST_BATCH_SIZE,
          );
          const series = batchOrigins.map((origin, index) => {
            const context = contexts[index]!;
            const converted = aiBars(context);
            inputHash.update(JSON.stringify({
              originAt: origin.originAt,
              cadence,
              bars: converted,
            }));
            return {
              instrument_key: `${symbol}:${cadence}s:${origin.ordinal}`,
              timezone: "UTC",
              input_end_at: origin.originAt,
              future_timestamps: origin.futureBars.map(
                (bar) => new Date(bar.closeTime).toISOString(),
              ) as AiForecastRequest["series"][number]["future_timestamps"],
              bars: converted,
              target_stop: null,
            };
          });
          const request = AiForecastRequestSchema.parse({
            ...aiRequestBase(`${this.requestId()}:${cadence}:${requestCount}`, 0),
            mode: "forecast",
            series,
          });
          const raw = await this.options.client.request(request, controller.signal);
          const validated = validateForecastResponse({ raw, request, contexts });
          requestCount += 1;
          modelLatencyMs += validated.modelLatencyMs;
          workerInputDigests.push(...validated.workerInputDigests);
          if (modelDigest && modelDigest !== validated.modelDigest) {
            throw new Error("FinCast model provenance changed within a cadence replay.");
          }
          modelDigest = validated.modelDigest;
          model = validated.response.model;

          for (let index = 0; index < batchOrigins.length; index += 1) {
            const origin = batchOrigins[index]!;
            const result = validated.response.series[index]!;
            for (const horizonMinutes of SCALPING_AI_HORIZONS) {
              const target = origin.futureBars[horizonMinutes - 1]!;
              const forecast = result.horizons.find(
                (item) => item.horizon_minutes === horizonMinutes,
              )!;
              const predictedQuantiles = forecast.return_quantiles.map((item) => ({
                quantile: item.quantile as (typeof SCALPING_AI_QUANTILES)[number],
                value: item.value,
              }));
              const predictedMedianReturn = predictedQuantiles.find(
                (item) => item.quantile === 0.5,
              )?.value;
              if (
                predictedMedianReturn === undefined
                || forecast.up_probability === null
                || forecast.up_probability === undefined
              ) {
                throw new Error("FinCast cadence response omitted median or probability evidence.");
              }
              records.push({
                originAt: origin.originAt,
                horizonMinutes,
                targetAt: new Date(target.closeTime).toISOString(),
                originClose: origin.originClose,
                nextMinuteOpen: origin.nextMinuteOpen,
                targetClose: target.close,
                actualReturn: target.close / origin.originClose - 1,
                executionReturn: target.close / origin.nextMinuteOpen - 1,
                roundTripCostRate: roundTripCostRate(costs),
                predictedMedianReturn,
                upProbability: forecast.up_probability,
                predictedQuantiles,
              });
            }
          }
        }
        if (!model || records.length !== ORIGIN_COUNT * SCALPING_AI_HORIZONS.length) {
          throw new Error(`FinCast ${cadence}s replay returned an incomplete record set.`);
        }
        modelDigests.add(modelDigest);
        const uniqueKeys = new Set(records.map(
          (record) => `${record.originAt}\u0000${record.horizonMinutes}`,
        ));
        if (uniqueKeys.size !== records.length) {
          throw new Error(`FinCast ${cadence}s replay returned duplicate records.`);
        }
        cadenceResults.set(cadence, {
          candleSeconds: cadence,
          contextBars: CONTEXT_BARS,
          contextSpanMinutes: (CONTEXT_BARS * cadence / 60) as 128 | 256 | 512,
          originCount: ORIGIN_COUNT,
          recordCount: records.length as 960,
          availability: "available",
          inputDigest: inputHash.digest("hex"),
          workerInputDigest: digest(workerInputDigests),
          recordDigest: digest(records),
          modelDigest,
          model,
          requestCount,
          modelLatencyMs,
          wallLatencyMs: Math.max(0, this.monotonicNow() - wallStartedAt),
          metrics: metrics(records),
          records,
          ...(rawInputArtifact
            ? {
              rawInputArtifact: {
                manifestPath: rawInputArtifact.manifestPath,
                manifestSha256: rawInputArtifact.manifestSha256,
                contextsSha256: rawInputArtifact.manifest.files.contexts.sha256,
                originsSha256: rawInputArtifact.manifest.files.origins.sha256,
              },
            }
            : {}),
        });
      }
      if (modelDigests.size !== 1) {
        throw new Error("FinCast model identity changed across cadence lanes.");
      }
      const result15 = cadenceResults.get(15)!;
      const result30 = cadenceResults.get(30)!;
      const result60 = cadenceResults.get(60)!;
      return {
        schemaVersion: OUTPUT_SCHEMA,
        generatedAt: new Date(this.clock.now()).toISOString(),
        executionMode: "historical_replay",
        realOrder: false,
        market: {
          kind: "crypto_futures",
          venue: "BINANCE_USDM",
          quoteAsset: "USDT",
          contractType: "PERPETUAL",
        },
        symbol,
        window: {
          originStartAt: new Date(window.originStart).toISOString(),
          originEndExclusiveAt: new Date(window.originEndExclusive).toISOString(),
          outcomeEndExclusiveAt: new Date(window.outcomeEndExclusive).toISOString(),
          originHours: ORIGIN_HOURS,
          originCount: ORIGIN_COUNT,
          originStrideSeconds: 60,
          outcomeTailMinutes: OUTCOME_TAIL_MINUTES,
          canonicalMinuteBarCount: CANONICAL_MINUTE_BAR_COUNT,
        },
        costAssumptions: costs,
        roundTripCostRate: roundTripCostRate(costs),
        provenance: {
          canonicalMinuteDigest: digest(canonicalBars),
          aggregateTradeDigest: micro.aggregateTradeDigest,
          aggregateTradeCount: micro.aggregateTradeCount,
          aggregateTradeRequestCount: micro.requestCount,
          aggregateTradeRequestWeight: micro.requestWeight,
          adaptiveSplitCount: micro.adaptiveSplitCount,
          bars15sDigest: digest(micro.bars15s),
          bars30sDigest: digest(micro.bars30s),
        },
        common: {
          originDigest,
          outcomeDigest: digest(outcomeReference),
          fillBarrierDigest: digest(fillReference),
          costDigest: digest(costs),
        },
        cadences: {
          "15": result15,
          "30": result30,
          "60": result60,
        },
        comparison: {
          sameOrigins: true,
          sameOutcomes: true,
          sameCosts: true,
          sameFillBarrier: true,
          sameModelIdentity: true,
          automaticWinner: null,
          outcome: "inconclusive",
          limitations: [
            "single_symbol_four_hour_window",
            "overlapping_forecast_horizons",
            "cadence_and_context_span_change_together",
          ],
        },
      };
    } finally {
      clearTimeout(deadline);
      input.signal?.removeEventListener("abort", forwardAbort);
    }
  }
}
