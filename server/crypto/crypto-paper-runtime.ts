import { createHash } from "node:crypto";
import type { RunTaskContext } from "../services/run-service.js";
import {
  AI_SIMULATION_CONTRACT_VERSION,
  type SimulationModelLane,
  type SimulationStartRequest,
} from "../simulation/contracts.js";
import {
  FINCAST_MODEL_ID,
  KRONOS_BASE_MODEL_ID,
  SCALPING_AI_HORIZONS,
  SCALPING_AI_QUANTILES,
  SCALPING_AI_SCHEMA_VERSION,
  type AiForecastRequest,
} from "../worker/ai-contract.js";
import {
  CausalBinanceKlineStore,
  type BinanceKline,
  type BinanceMarketEvent,
  type BinancePublicStreamConnectionState,
  type BinanceRestMarketData,
  type BinanceWebsocketSubscription,
} from "./binance-market-data.js";
import type {
  BinanceInstrumentRules,
  BinanceScannerCandidate,
  BinanceScannerSnapshot,
} from "./contracts.js";
import type {
  CryptoSimulationRuntime,
  CryptoSimulationRuntimeResult,
} from "./crypto-simulation-service.js";
import {
  ceilToStep,
  floorToStep,
  FuturesPaperLedger,
  type FuturesPaperLedgerSnapshot,
  type FuturesSide,
} from "./futures-paper-ledger.js";
import {
  FUTURES_DAILY_LOSS_LIMIT_RATE,
  FUTURES_TRADE_RISK_RATE,
  PAPER_MAINTENANCE_MARGIN_COVERAGE_RATE,
  signalFromQuantileCdf,
  sizeFuturesPosition,
  updateDailyLossGate,
  type DailyLossGateState,
  type QuantileDirectionSignal,
  type ReturnQuantile,
} from "./futures-risk.js";

const MINUTE_MS = 60_000;
const MAXIMUM_RESTORED_BARS = 1_024;
const DEFAULT_CONTEXT_BARS = 512;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_INFERENCE_DEADLINE_MS = 240_000;
const DEFAULT_CIRCUIT_FAILURE_THRESHOLD = 3;
const DEFAULT_CIRCUIT_COOLDOWN_MS = 60_000;
const COORDINATOR_SETUP_FINALIZATION_ALLOWANCE_MS = 30_000;
const CANCELLATION_POLL_INTERVAL_MS = 1_000;
const PROGRESS_UPDATE_INTERVAL_MS = 5_000;
const EQUITY_SAMPLE_INTERVAL_MS = 5_000;
const MAX_EQUITY_SAMPLES_PER_LANE = 5_000;
const MAX_MARKET_EVENT_QUEUE_DEPTH = 256;
const BOOK_TICKER_FRESHNESS_MS = 15_000;
const MARK_PRICE_FRESHNESS_MS = 5_000;

type UnknownRecord = Record<string, unknown>;

export const CRYPTO_PAPER_RUNTIME_COORDINATOR_REQUIREMENTS = Object.freeze({
  lifecycle: "event_driven_background_session",
  cancellation: "RunTaskContext.signal + throwIfCancelled + isCancelled",
  requestedDurationDeadlineRequired: true,
  setupFinalizationAllowanceMs: COORDINATOR_SETUP_FINALIZATION_ALLOWANCE_MS,
  maximumRestoredOneMinuteBars: MAXIMUM_RESTORED_BARS,
  note: "The coordinator task deadline must cover the requested shadow duration plus setup/finalization. A short generic RunService deadline will abort a valid 120-minute run.",
});

export function cryptoPaperRuntimeMinimumTaskDeadlineMs(durationMinutes: number): number {
  if (!Number.isSafeInteger(durationMinutes) || durationMinutes < 1) {
    throw new Error("durationMinutes must be a positive safe integer.");
  }
  return durationMinutes * MINUTE_MS + COORDINATOR_SETUP_FINALIZATION_ALLOWANCE_MS;
}

export function monotonicCryptoRiskClock(
  previous: number,
  observedNow: number,
  receivedAt: number,
): number {
  if (![previous, observedNow, receivedAt].every(
    (value) => Number.isSafeInteger(value) && value >= 0,
  )) {
    throw new Error("Crypto risk clock inputs must be non-negative safe integers.");
  }
  return Math.max(previous, observedNow, receivedAt);
}

export interface CryptoRuntimeClock {
  now(): number;
  sleep(milliseconds: number, signal: AbortSignal): Promise<void>;
}

export interface CryptoPublicStreams {
  subscribe(
    symbols: readonly string[],
    onEvent: (event: BinanceMarketEvent) => void,
    onDisconnect?: (error?: unknown) => void,
    onState?: (state: BinancePublicStreamConnectionState) => void,
  ): Promise<BinanceWebsocketSubscription>;
}

export interface CryptoAiLaneClient {
  request(input: AiForecastRequest, signal?: AbortSignal): Promise<unknown>;
}

export type CryptoPaperRuntimeSnapshotObserver = (
  runId: string,
  snapshot: CryptoPaperRuntimeSnapshot,
) => void | Promise<void>;

export type CryptoPaperRuntimeOptions = {
  rest: Pick<BinanceRestMarketData, "klines">;
  streams: CryptoPublicStreams;
  laneClients: Partial<Record<SimulationModelLane, CryptoAiLaneClient>>;
  instrumentRules:
    | BinanceInstrumentRules
    | ((
      symbol: string,
      requiredMaximumNotional: number,
    ) => BinanceInstrumentRules | Promise<BinanceInstrumentRules>);
  clock?: CryptoRuntimeClock;
  executionLane?: SimulationModelLane;
  contextBars?: number;
  pollIntervalMs?: number;
  inferenceDeadlineMs?: number;
  circuitBreaker?: {
    failureThreshold: number;
    cooldownMs: number;
  };
  onSnapshot?: CryptoPaperRuntimeSnapshotObserver;
};

type NormalizedLaneForecast = {
  lane: SimulationModelLane;
  generatedAt: number;
  generatedAtIso: string;
  inputEndAt: string;
  quantiles: ReturnQuantile[];
  modelId?: string;
  modelRevision?: string;
  precision: "fp16" | "fp32" | "unknown";
  latencyMs?: number;
  peakVramMb?: number;
};

type RuntimeForecastObservation = NormalizedLaneForecast & {
  originPrice: number;
  targetAt: number;
  evaluated: boolean;
};

type RuntimeDecision = {
  id: string;
  lane: SimulationModelLane;
  symbol: string;
  originAt: string;
  generatedAt?: string;
  decisionAt?: string;
  fillEligibleAfter?: string;
  action: "open_long" | "open_short" | "reduce" | "hold" | "none";
  direction?: FuturesSide | "flat";
  confidence?: number;
  leverage?: number;
  quantity?: number;
  notional?: number;
  protectiveStopPrice?: number;
  probabilityAboveCost?: number;
  probabilityBelowNegativeCost?: number;
  roundTripCostRate?: number;
  status: "pending" | "executed" | "held" | "blocked" | "unavailable" | "skipped";
  reason: string;
  requestDigest: string;
  fillId?: string;
  executedAt?: string;
};

type PendingAction = {
  action: "open" | "reduce";
  decision: RuntimeDecision;
  decisionAt: number;
  eligibleAfterIngressSequence: number;
  side?: FuturesSide;
  quantity?: number;
  leverage?: number;
  protectiveStopPrice?: number;
  atr14?: number;
  adverseQuantileDistance?: number;
  spreadBps?: number;
  reason?: "signal" | "daily_loss_gate" | "protection";
};

type LaneState = {
  lane: SimulationModelLane;
  ledger: FuturesPaperLedger;
  dailyGate: DailyLossGateState;
  pending?: PendingAction;
  attempts: number;
  successes: number;
  timeoutCount: number;
  latencies: number[];
  peakVramMb?: number;
  precision: "fp16" | "fp32" | "unknown";
  modelId?: string;
  modelRevision?: string;
  errors: string[];
  consecutiveFailures: number;
  circuitOpenUntil?: number;
  forecasts: RuntimeForecastObservation[];
  predictionMetrics: {
    pinballLosses: number[];
    medianAbsoluteErrors: number[];
    directionHits: number[];
    coverageHits: number[];
    nominalCoverage: number[];
  };
  equity: Array<{ timestamp: string; equity: number; drawdown: number }>;
  equityPeak: number;
  maximumDrawdown: number;
  lastEquitySampleAt: number;
};

export type CryptoPaperRuntimeSnapshot = {
  schemaVersion: typeof AI_SIMULATION_CONTRACT_VERSION;
  runId: string;
  phase: "running" | "completed" | "failed";
  startedAt: string;
  expiresAt: string;
  market: {
    kind: "crypto_futures";
    venue: "BINANCE_USDM";
    quoteAsset: "USDT";
    contractType: "PERPETUAL";
  };
  currency: "USDT";
  initialCash: number;
  cash: number;
  equity: number;
  progress: number;
  selection: SimulationStartRequest["selection"];
  criterion: string;
  preset: SimulationStartRequest["preset"];
  riskTolerance: number;
  selected: unknown[];
  positions: unknown[];
  futuresPositions: unknown[];
  futuresRisk: {
    dailyLossRatio: number;
    dailyLossLimitRatio: number;
    newEntriesBlocked: boolean;
    blockReason?: string;
    grossExposureRatio: number;
    marginUsageRatio: number;
    riskPerTradeRatio: number;
    riskStreams: {
      healthy: boolean;
      bookTicker: {
        status: "missing" | "fresh" | "stale";
        maximumAgeMs: number;
        lastObservedAt?: string;
      };
      markPrice: {
        status: "missing" | "fresh" | "stale";
        maximumAgeMs: number;
        lastObservedAt?: string;
      };
    };
  };
  charts: unknown[];
  trades: unknown[];
  decisions: RuntimeDecision[];
  kronosForecasts: unknown[];
  warnings: string[];
  capabilities: Record<string, boolean | number | string>;
  modelLanes: SimulationModelLane[];
  executionMode: "paper";
  executionLane: SimulationModelLane;
  modelComparison: unknown;
  decisionCadence: {
    trigger: "final_binance_1m_kline";
    triggeredEvents: number;
    lastTriggeredAt?: string;
    inFlight: boolean;
  };
};

export class CryptoPaperRuntimeError extends Error {
  constructor(
    readonly code: "stream_desync" | "invalid_runtime_input",
    message: string,
    readonly snapshot?: CryptoPaperRuntimeSnapshot,
  ) {
    super(message);
    this.name = "CryptoPaperRuntimeError";
  }
}

function record(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : undefined;
}

function finite(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function first(source: UnknownRecord | undefined, ...keys: string[]): unknown {
  if (!source) return undefined;
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null) return source[key];
  }
  return undefined;
}

function timestamp(value: unknown): number | undefined {
  const candidate = text(value);
  if (!candidate) return undefined;
  const parsed = Date.parse(candidate);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function iso(value: number): string {
  return new Date(value).toISOString();
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function unique(values: readonly string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(signal.reason instanceof Error
      ? signal.reason
      : new Error("Crypto paper runtime was aborted."));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, Math.max(0, milliseconds));
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error
        ? signal.reason
        : new Error("Crypto paper runtime was aborted."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void Promise.resolve().then(() => {
      if (!signal.aborted) return;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    });
  });
}

const systemClock: CryptoRuntimeClock = {
  now: Date.now,
  sleep: abortableSleep,
};

type QueuedMarketEvent =
  | BinanceMarketEvent
  | { kind: "disconnect"; error?: unknown }
  | { kind: "connection_state"; state: BinancePublicStreamConnectionState };
type CoalescedMarketEventKind = "book_ticker" | "mark_price";
type MarketEventQueueToken =
  | { kind: "direct_event"; event: QueuedMarketEvent; queueSequence: number }
  | {
    kind: "coalesced_event";
    eventKind: CoalescedMarketEventKind;
    queueSequence: number;
  }
  | {
    kind: "agg_event";
    event: Extract<BinanceMarketEvent, { kind: "agg_trade" }>;
    ingressSequence: number;
    fillCandidate: boolean;
    queueSequence: number;
  };

type MarketEventQueueStats = {
  currentDepth: number;
  maximumDepth: number;
  maximumAllowedDepth: number;
  droppedNonFinalKlines: number;
  coalescedBookTickers: number;
  coalescedMarkPrices: number;
  preservedCriticalMarkPrices: number;
  droppedAggTrades: number;
  maximumBufferedAggTrades: number;
  overflowCount: number;
};

class AsyncMarketEventQueue {
  private readonly events: MarketEventQueueToken[] = [];
  private readonly coalesced = new Map<
    CoalescedMarketEventKind,
    BinanceMarketEvent
  >();
  private readonly waiters = new Set<
    (event: QueuedMarketEvent) => void
  >();
  private maximumDepth = 0;
  private droppedNonFinalKlines = 0;
  private coalescedBookTickers = 0;
  private coalescedMarkPrices = 0;
  private preservedCriticalMarkPrices = 0;
  private droppedAggTrades = 0;
  private maximumBufferedAggTrades = 0;
  private overflowCount = 0;
  private queueSequence = 0;

  push(
    event: QueuedMarketEvent,
    metadata?: {
      ingressSequence?: number;
      fillCandidate?: boolean;
      preserveMarkRisk?: boolean;
    },
  ): boolean {
    if (event.kind === "kline" && !event.final) {
      this.droppedNonFinalKlines += 1;
      return true;
    }
    if (event.kind === "mark_price" && metadata?.preserveMarkRisk) {
      this.preservedCriticalMarkPrices += 1;
      return this.enqueue({
        kind: "direct_event",
        event,
        queueSequence: ++this.queueSequence,
      });
    }
    if (event.kind === "book_ticker" || event.kind === "mark_price") {
      const queueSequence = ++this.queueSequence;
      const existing = this.coalesced.has(event.kind);
      this.coalesced.set(event.kind, event);
      if (existing) {
        if (event.kind === "book_ticker") this.coalescedBookTickers += 1;
        else this.coalescedMarkPrices += 1;
        const tokenIndex = this.events.findIndex((queued) => (
          queued.kind === "coalesced_event" && queued.eventKind === event.kind
        ));
        if (tokenIndex >= 0) {
          this.events[tokenIndex] = {
            kind: "coalesced_event",
            eventKind: event.kind,
            queueSequence,
          };
          this.sortByIngress();
        }
        return true;
      }
      return this.enqueue({ kind: "coalesced_event", eventKind: event.kind, queueSequence });
    }
    // Preserve the first eligible aggregate trade. It is the causal fill
    // barrier. Also retain the adverse minimum and maximum while the event
    // loop is busy so a transient protective-stop crossing cannot disappear.
    // The selected set is fixed-size even under an arbitrarily large burst.
    if (event.kind === "agg_trade") {
      const ingressSequence = metadata?.ingressSequence;
      if (ingressSequence === undefined) {
        throw new Error("aggTrade ingress sequence is required.");
      }
      const token: Extract<MarketEventQueueToken, { kind: "agg_event" }> = {
        kind: "agg_event",
        event,
        ingressSequence,
        fillCandidate: metadata?.fillCandidate === true,
        queueSequence: ++this.queueSequence,
      };
      const waiter = this.waiters.values().next().value as
        | ((value: QueuedMarketEvent) => void)
        | undefined;
      const buffered = this.events.filter(
        (queued): queued is Extract<MarketEventQueueToken, { kind: "agg_event" }> => (
          queued.kind === "agg_event"
        ),
      );
      if (waiter && buffered.length === 0) {
        this.maximumBufferedAggTrades = Math.max(this.maximumBufferedAggTrades, 1);
        return this.enqueue(token);
      }
      const candidates = [
        ...buffered,
        token,
      ];
      const selected = new Map<number, typeof candidates[number]>();
      const select = (candidate: typeof candidates[number] | undefined) => {
        if (candidate) selected.set(candidate.ingressSequence, candidate);
      };
      select(candidates.reduce((earliest, candidate) => (
        !earliest || candidate.ingressSequence < earliest.ingressSequence
          ? candidate
          : earliest
      ), undefined as typeof candidates[number] | undefined));
      select(candidates
        .filter((candidate) => candidate.fillCandidate)
        .reduce((earliest, candidate) => (
          !earliest || candidate.ingressSequence < earliest.ingressSequence
            ? candidate
            : earliest
        ), undefined as typeof candidates[number] | undefined));
      select(candidates.reduce((minimum, candidate) => (
        !minimum || candidate.event.price < minimum.event.price ? candidate : minimum
      ), undefined as typeof candidates[number] | undefined));
      select(candidates.reduce((maximum, candidate) => (
        !maximum || candidate.event.price > maximum.event.price ? candidate : maximum
      ), undefined as typeof candidates[number] | undefined));
      select(candidates.reduce((latest, candidate) => (
        !latest || candidate.ingressSequence > latest.ingressSequence ? candidate : latest
      ), undefined as typeof candidates[number] | undefined));
      const selectedTokens = Array.from(selected.values())
        .sort((left, right) => left.ingressSequence - right.ingressSequence);
      this.droppedAggTrades += Math.max(0, candidates.length - selectedTokens.length);
      this.maximumBufferedAggTrades = Math.max(
        this.maximumBufferedAggTrades,
        selectedTokens.length,
      );
      for (let index = this.events.length - 1; index >= 0; index -= 1) {
        if (this.events[index]!.kind === "agg_event") this.events.splice(index, 1);
      }
      if (this.events.length + selectedTokens.length > MAX_MARKET_EVENT_QUEUE_DEPTH) {
        this.overflowCount += 1;
        return false;
      }
      this.events.push(...selectedTokens);
      this.sortByIngress();
      this.maximumDepth = Math.max(this.maximumDepth, this.events.length);
      return true;
    }
    return this.enqueue({
      kind: "direct_event",
      event,
      queueSequence: ++this.queueSequence,
    });
  }

  fail(error: unknown): void {
    this.events.length = 0;
    this.coalesced.clear();
    const event: QueuedMarketEvent = { kind: "disconnect", error };
    const waiter = this.waiters.values().next().value as
      | ((value: QueuedMarketEvent) => void)
      | undefined;
    if (waiter) {
      this.waiters.delete(waiter);
      waiter(event);
      return;
    }
    this.events.push({
      kind: "direct_event",
      event,
      queueSequence: ++this.queueSequence,
    });
    this.maximumDepth = Math.max(this.maximumDepth, this.events.length);
  }

  noteIgnoredAggTrade(): void {
    this.droppedAggTrades += 1;
  }

  stats(): MarketEventQueueStats {
    return {
      currentDepth: this.events.length,
      maximumDepth: this.maximumDepth,
      maximumAllowedDepth: MAX_MARKET_EVENT_QUEUE_DEPTH,
      droppedNonFinalKlines: this.droppedNonFinalKlines,
      coalescedBookTickers: this.coalescedBookTickers,
      coalescedMarkPrices: this.coalescedMarkPrices,
      preservedCriticalMarkPrices: this.preservedCriticalMarkPrices,
      droppedAggTrades: this.droppedAggTrades,
      maximumBufferedAggTrades: this.maximumBufferedAggTrades,
      overflowCount: this.overflowCount,
    };
  }

  async next(
    maximumWaitMs: number,
    clock: CryptoRuntimeClock,
    signal: AbortSignal,
  ): Promise<QueuedMarketEvent | undefined> {
    const immediate = this.shift();
    if (immediate) return immediate;
    if (maximumWaitMs <= 0) return undefined;

    const localAbort = new AbortController();
    const onExternalAbort = () => localAbort.abort(signal.reason);
    signal.addEventListener("abort", onExternalAbort, { once: true });
      let waiter:
      | ((event: QueuedMarketEvent) => void)
      | undefined;
    const eventPromise = new Promise<
      QueuedMarketEvent
    >((resolve) => {
      waiter = resolve;
      this.waiters.add(resolve);
    });
    const sleepPromise = clock.sleep(maximumWaitMs, localAbort.signal)
      .then(() => undefined)
      .catch((error: unknown) => {
        if (localAbort.signal.aborted && !signal.aborted) return undefined;
        throw error;
      });
    try {
      const result = await Promise.race([eventPromise, sleepPromise]);
      localAbort.abort(new Error("Market event arrived before the poll timeout."));
      return result;
    } finally {
      if (waiter) this.waiters.delete(waiter);
      signal.removeEventListener("abort", onExternalAbort);
    }
  }

  private enqueue(event: MarketEventQueueToken): boolean {
    if (this.events.length >= MAX_MARKET_EVENT_QUEUE_DEPTH) {
      this.overflowCount += 1;
      if (event.kind === "coalesced_event") {
        this.coalesced.delete(event.eventKind);
      }
      return false;
    }
    const waiter = this.waiters.values().next().value as
      | ((value: QueuedMarketEvent) => void)
      | undefined;
    if (waiter) {
      const resolved = this.resolveToken(event);
      if (!resolved) return true;
      this.waiters.delete(waiter);
      waiter(resolved);
      return true;
    }
    this.events.push(event);
    this.sortByIngress();
    this.maximumDepth = Math.max(this.maximumDepth, this.events.length);
    return true;
  }

  private shift(): QueuedMarketEvent | undefined {
    while (this.events.length) {
      const resolved = this.resolveToken(this.events.shift()!);
      if (resolved) return resolved;
    }
    return undefined;
  }

  private resolveToken(event: MarketEventQueueToken): QueuedMarketEvent | undefined {
    if (event.kind === "direct_event" || event.kind === "agg_event") return event.event;
    const resolved = this.coalesced.get(event.eventKind);
    this.coalesced.delete(event.eventKind);
    return resolved;
  }

  private sortByIngress(): void {
    this.events.sort((left, right) => left.queueSequence - right.queueSequence);
  }
}

function eventAt(event: BinanceMarketEvent): number {
  if (event.kind === "agg_trade") return event.executedAt;
  if (event.kind === "kline") return event.receivedAt;
  return event.eventTime;
}

function eventPrice(event: BinanceMarketEvent): number | undefined {
  if (event.kind === "agg_trade") return event.price;
  if (event.kind === "mark_price") return event.markPrice;
  if (event.kind === "kline" && event.final) return event.close;
  return undefined;
}

function normalizedPrecision(value: unknown): "fp16" | "fp32" | "unknown" {
  const normalized = text(value)?.toLowerCase();
  if (normalized === "fp16"
    || normalized === "float16"
    || normalized === "mixed_float16"
    || normalized === "half") return "fp16";
  if (normalized === "fp32" || normalized === "float32" || normalized === "float") return "fp32";
  return "unknown";
}

function normalizeLaneForecast(
  lane: SimulationModelLane,
  raw: unknown,
  request: AiForecastRequest,
): NormalizedLaneForecast {
  const wrapper = record(raw);
  const response = record(first(wrapper, "response", "result", "output")) ?? wrapper;
  if (!response) throw new Error("model_response_not_object");
  if (text(first(response, "request_id", "requestId")) !== request.request_id) {
    throw new Error("model_request_id_mismatch");
  }
  if (text(response.mode)?.toLowerCase() !== "forecast") {
    throw new Error("model_mode_mismatch");
  }
  const responseStatus = text(response.status)?.toLowerCase();
  if (responseStatus !== "available" && responseStatus !== "partial") {
    const unavailable = record(response.error);
    throw new Error(text(first(unavailable, "code", "message")) ?? "model_unavailable");
  }
  const generatedAt = timestamp(first(response, "generated_at", "generatedAt"));
  if (generatedAt === undefined) throw new Error("model_generated_at_invalid");

  const seriesValues = Array.isArray(response.series) ? response.series : [];
  const expectedSeries = request.series[0]!;
  const series = seriesValues
    .map(record)
    .find((item) => text(first(item, "instrument_key", "instrumentKey"))
      === expectedSeries.instrument_key);
  if (!series || text(series.status)?.toLowerCase() !== "available") {
    throw new Error("model_series_unavailable");
  }
  const inputEndAt = text(first(series, "input_end_at", "inputEndAt"));
  if (!inputEndAt || Date.parse(inputEndAt) !== Date.parse(expectedSeries.input_end_at)) {
    throw new Error("model_input_origin_mismatch");
  }
  if (generatedAt < Date.parse(inputEndAt)) {
    throw new Error("model_generated_before_origin");
  }
  const horizons = Array.isArray(series.horizons) ? series.horizons.map(record) : [];
  const horizon = horizons.find((item) => finite(
    first(item, "horizon_minutes", "horizonMinutes"),
  ) === SCALPING_AI_HORIZONS[0]);
  const rawQuantiles = horizon && Array.isArray(
    first(horizon, "return_quantiles", "returnQuantiles"),
  )
    ? first(horizon, "return_quantiles", "returnQuantiles") as unknown[]
    : [];
  if (rawQuantiles.length !== SCALPING_AI_QUANTILES.length) {
    throw new Error("model_return_quantiles_incomplete");
  }
  const quantiles = rawQuantiles.map((item, index): ReturnQuantile => {
    const entry = record(item);
    const quantile = finite(first(entry, "quantile", "q"));
    const returnRate = finite(first(entry, "value", "return_rate", "returnRate"));
    if (quantile !== SCALPING_AI_QUANTILES[index] || returnRate === undefined) {
      throw new Error("model_return_quantiles_invalid");
    }
    return { quantile, returnRate };
  });
  for (let index = 1; index < quantiles.length; index += 1) {
    if (quantiles[index]!.returnRate < quantiles[index - 1]!.returnRate) {
      throw new Error("model_return_quantiles_non_monotone");
    }
  }

  const modelRuns = Array.isArray(first(response, "model_runs", "modelRuns"))
    ? first(response, "model_runs", "modelRuns") as unknown[]
    : [];
  if (modelRuns.length !== 1) throw new Error("model_lane_count_mismatch");
  const laneRun = record(modelRuns[0]);
  const role = text(first(laneRun, "role", "lane"))?.toLowerCase().replaceAll("-", "_");
  if (role !== lane && !(lane === "kronos_base" && role === "kronos")) {
    throw new Error("model_lane_identity_mismatch");
  }
  const model = record(first(laneRun, "model", "provenance"))
    ?? record(first(response, "model", "provenance"));
  const expectedModelId = lane === "kronos_base" ? KRONOS_BASE_MODEL_ID : FINCAST_MODEL_ID;
  if (text(first(laneRun, "expected_model_id", "expectedModelId")) !== expectedModelId
    || text(first(model, "model_id", "modelId", "id")) !== expectedModelId) {
    throw new Error("model_identity_mismatch");
  }
  const peakVramBytes = finite(first(model, "peak_vram_bytes", "peakVramBytes"));
  return {
    lane,
    generatedAt,
    generatedAtIso: iso(generatedAt),
    inputEndAt,
    quantiles,
    modelId: text(first(model, "model_id", "modelId", "id")),
    modelRevision: text(first(model, "model_revision", "modelRevision", "revision")),
    precision: normalizedPrecision(first(model, "dtype", "precision")),
    latencyMs: finite(first(laneRun, "latency_ms", "latencyMs"))
      ?? finite(first(response, "latency_ms", "latencyMs")),
    peakVramMb: finite(first(model, "peak_vram_mb", "peakVramMb"))
      ?? finite(first(laneRun, "peak_vram_mb", "peakVramMb"))
      ?? (peakVramBytes === undefined ? undefined : peakVramBytes / (1024 * 1024)),
  };
}

function atr14(bars: readonly BinanceKline[]): number {
  const window = bars.slice(-15);
  if (window.length < 2) return 0;
  const ranges: number[] = [];
  for (let index = 1; index < window.length; index += 1) {
    const bar = window[index]!;
    const previousClose = window[index - 1]!.close;
    ranges.push(Math.max(
      bar.high - bar.low,
      Math.abs(bar.high - previousClose),
      Math.abs(bar.low - previousClose),
    ));
  }
  return ranges.reduce((sum, value) => sum + value, 0) / ranges.length;
}

function realizedVolatility(bars: readonly BinanceKline[]): number {
  const window = bars.slice(-61);
  const returns: number[] = [];
  for (let index = 1; index < window.length; index += 1) {
    const previous = window[index - 1]!.close;
    const current = window[index]!.close;
    if (previous > 0 && current > 0) returns.push(Math.log(current / previous));
  }
  if (returns.length < 2) return 0;
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0)
    / (returns.length - 1);
  return Math.sqrt(Math.max(0, variance));
}

function hasContinuousFinalContext(
  bars: readonly BinanceKline[],
  requiredBars: number,
): boolean {
  const context = bars.slice(-requiredBars);
  if (context.length !== requiredBars || context.some((bar) => !bar.final)) return false;
  for (let index = 1; index < context.length; index += 1) {
    if (context[index]!.openTime - context[index - 1]!.openTime !== MINUTE_MS) {
      return false;
    }
  }
  return true;
}

function futureTimestamps(inputEndAt: number): AiForecastRequest["series"][number]["future_timestamps"] {
  const values = Array.from(
    { length: 60 },
    (_, index) => iso(inputEndAt + (index + 1) * MINUTE_MS),
  );
  return values as AiForecastRequest["series"][number]["future_timestamps"];
}

function aiRequest(
  runId: string,
  symbol: string,
  bars: readonly BinanceKline[],
): AiForecastRequest {
  const safeRunId = runId.replaceAll(/[^A-Za-z0-9._:-]/g, "-").slice(0, 48) || "run";
  const final = bars.at(-1);
  if (!final) throw new Error("A final Binance bar is required for inference.");
  const inputEndAt = final.closeTime;
  return {
    schema_version: SCALPING_AI_SCHEMA_VERSION,
    request_id: `crypto:${safeRunId}:${inputEndAt}`,
    mode: "forecast",
    horizons_minutes: [...SCALPING_AI_HORIZONS],
    quantiles: [...SCALPING_AI_QUANTILES],
    seed: 0,
    series: [{
      instrument_key: symbol,
      timezone: "UTC",
      input_end_at: iso(inputEndAt),
      future_timestamps: futureTimestamps(inputEndAt),
      bars: bars.map((bar) => ({
        timestamp: iso(bar.closeTime),
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume,
        amount: bar.quoteVolume,
        complete: true as const,
      })),
      target_stop: null,
    }],
  };
}

function costRate(
  request: SimulationStartRequest,
  observedSpreadBps: number,
): number {
  return (
    request.costs.commissionBpsPerSide * 2
    + request.costs.taxBpsOnExit
    + Math.max(request.costs.spreadBpsRoundTrip, observedSpreadBps)
    + request.costs.slippageBpsPerSide * 2
  ) / 10_000;
}

function modelMetrics(state: LaneState) {
  const snapshot = state.ledger.snapshot();
  const closed = snapshot.fills.filter((fill) => fill.action === "reduce");
  const netOutcomes = closed.map((fill) => fill.realizedPnl - fill.fee);
  const profits = netOutcomes.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const losses = Math.abs(
    netOutcomes.filter((value) => value < 0).reduce((sum, value) => sum + value, 0),
  );
  const average = (values: readonly number[]): number | undefined => values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : undefined;
  return {
    pinballLoss: average(state.predictionMetrics.pinballLosses),
    medianReturnMae: average(state.predictionMetrics.medianAbsoluteErrors),
    directionAccuracy: average(state.predictionMetrics.directionHits),
    quantileCoverage: average(state.predictionMetrics.coverageHits),
    calibrationError: (() => {
      const actual = average(state.predictionMetrics.coverageHits);
      const expected = average(state.predictionMetrics.nominalCoverage);
      return actual === undefined || expected === undefined ? undefined : Math.abs(actual - expected);
    })(),
    netPnl: snapshot.equity - snapshot.initialCash,
    profitFactor: losses > 0 ? profits / losses : profits > 0 ? null : undefined,
    winRate: closed.length
      ? netOutcomes.filter((value) => value > 0).length / closed.length
      : undefined,
    maxDrawdown: state.maximumDrawdown,
    turnover: snapshot.fills.reduce((sum, fill) => sum + fill.notional, 0)
      / snapshot.initialCash,
    funding: snapshot.funding,
    fees: snapshot.fees,
    latencyMs: average(state.latencies),
    availabilityRatio: state.attempts > 0 ? state.successes / state.attempts : 0,
    timeoutCount: state.timeoutCount,
    peakVramMb: state.peakVramMb,
    leverageDistribution: snapshot.fills
      .filter((fill) => fill.action === "open")
      .map((fill) => fill.leverage),
  };
}

function laneStatus(state: LaneState): "completed" | "partial" | "unavailable" {
  if (state.successes === 0) return "unavailable";
  return state.successes === state.attempts ? "completed" : "partial";
}

function futuresPositions(
  snapshot: FuturesPaperLedgerSnapshot,
  riskStreamWarnings: readonly string[] = [],
): unknown[] {
  return snapshot.positions.map((position) => ({
    symbol: position.symbol,
    side: position.side,
    marginMode: "isolated",
    quantity: position.quantity,
    leverage: position.leverage,
    entryPrice: position.entryPrice,
    averagePrice: position.entryPrice,
    currentPrice: position.markPrice,
    markPrice: position.markPrice,
    notional: position.markPrice * position.quantity,
    initialMargin: position.isolatedMargin,
    maintenanceMargin: position.maintenanceMargin,
    liquidationPrice: position.estimatedLiquidationPrice,
    liquidationBufferRatio: position.liquidationBufferRate,
    protectiveStopPrice: position.protectiveStopPrice,
    realizedPnl: snapshot.realizedPnl,
    unrealizedPnl: position.unrealizedPnl,
    funding: snapshot.funding,
    fees: snapshot.fees,
    slippage: snapshot.slippage,
    entryBlocked: riskStreamWarnings.length > 0,
    riskWarnings: [...riskStreamWarnings],
  }));
}

function tradeRows(lane: SimulationModelLane, snapshot: FuturesPaperLedgerSnapshot): unknown[] {
  return snapshot.fills.map((fill) => ({
    id: fill.fillId,
    lane,
    symbol: fill.symbol,
    side: fill.action === "open"
      ? (fill.side === "long" ? "buy" : "sell")
      : (fill.side === "long" ? "sell" : "buy"),
    action: fill.action,
    reduceOnly: fill.reduceOnly,
    quantity: fill.quantity,
    price: fill.price,
    notional: fill.notional,
    leverage: fill.leverage,
    grossAmount: fill.notional,
    cost: fill.fee + fill.slippageCost - fill.funding,
    fee: fill.fee,
    slippage: fill.slippageCost,
    funding: fill.funding,
    realizedPnl: fill.realizedPnl,
    reason: fill.reason,
    decisionAt: iso(fill.decisionAt),
    executedAt: iso(fill.executedAt),
    timestamp: iso(fill.executedAt),
  }));
}

function isTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = text((error as Error & { code?: unknown }).code);
  return /timeout|deadline/i.test(`${code ?? ""} ${error.message}`);
}

function abortReason(signal: AbortSignal, fallback: string): Error {
  return signal.reason instanceof Error ? signal.reason : new Error(fallback);
}

async function raceWithAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw abortReason(signal, "Crypto model inference was aborted.");
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortReason(signal, "Crypto model inference was aborted."));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

export class CryptoPaperRuntime implements CryptoSimulationRuntime {
  private readonly clock: CryptoRuntimeClock;
  private readonly contextBars: number;
  private readonly pollIntervalMs: number;
  private readonly inferenceDeadlineMs: number;
  private readonly circuitFailureThreshold: number;
  private readonly circuitCooldownMs: number;

  constructor(private readonly options: CryptoPaperRuntimeOptions) {
    this.clock = options.clock ?? systemClock;
    this.contextBars = Math.max(
      32,
      Math.min(MAXIMUM_RESTORED_BARS, Math.trunc(options.contextBars ?? DEFAULT_CONTEXT_BARS)),
    );
    this.pollIntervalMs = Math.max(
      100,
      Math.min(10_000, Math.trunc(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS)),
    );
    this.inferenceDeadlineMs = Math.max(
      1_000,
      Math.min(
        7_200_000,
        Math.trunc(options.inferenceDeadlineMs ?? DEFAULT_INFERENCE_DEADLINE_MS),
      ),
    );
    const circuitBreaker = options.circuitBreaker ?? {
      failureThreshold: DEFAULT_CIRCUIT_FAILURE_THRESHOLD,
      cooldownMs: DEFAULT_CIRCUIT_COOLDOWN_MS,
    };
    if (!Number.isSafeInteger(circuitBreaker.failureThreshold)
      || circuitBreaker.failureThreshold < 1
      || circuitBreaker.failureThreshold > 100
      || !Number.isSafeInteger(circuitBreaker.cooldownMs)
      || circuitBreaker.cooldownMs < 1_000
      || circuitBreaker.cooldownMs > 3_600_000) {
      throw new Error("Crypto runtime circuit-breaker configuration is invalid.");
    }
    this.circuitFailureThreshold = circuitBreaker.failureThreshold;
    this.circuitCooldownMs = circuitBreaker.cooldownMs;
  }

  async run(input: {
    request: SimulationStartRequest;
    snapshot: BinanceScannerSnapshot;
    selected: BinanceScannerCandidate;
    context: RunTaskContext;
  }): Promise<CryptoSimulationRuntimeResult> {
    const { request, selected, context } = input;
    if (request.market.kind !== "crypto_futures" || request.execution.mode !== "paper") {
      throw new CryptoPaperRuntimeError(
        "invalid_runtime_input",
        "CryptoPaperRuntime accepts paper crypto_futures requests only.",
      );
    }
    const setupStartedAt = this.clock.now();
    // The requested shadow duration begins only after the public stream,
    // instrument rules, REST recovery, and model context are ready.
    let startedAt = setupStartedAt;
    let expiresAt = startedAt + request.durationMinutes * MINUTE_MS;
    const symbol = selected.symbol;
    const requiredMaximumNotional = (
      request.initialCash * PAPER_MAINTENANCE_MARGIN_COVERAGE_RATE
    );
    const rules = await this.resolveRules(symbol, requiredMaximumNotional);
    if (rules.maintenanceMarginSource !== "binance_user_data_brackets") {
      throw new CryptoPaperRuntimeError(
        "invalid_runtime_input",
        "Signed Binance maintenance-margin brackets are required before paper execution.",
      );
    }
    if (rules.maintenanceMarginMaximumNotional < requiredMaximumNotional) {
      throw new CryptoPaperRuntimeError(
        "invalid_runtime_input",
        "Signed Binance maintenance-margin brackets do not cover the required gross exposure.",
      );
    }
    const maintenanceMarginEvidence = {
      source: rules.maintenanceMarginSource,
      rate: rules.maintenanceMarginRate,
      maximumInitialLeverage: rules.maximumInitialLeverage,
      qualifiedMaximumNotional: rules.maintenanceMarginMaximumNotional,
      requiredMaximumNotional,
      exchangeInfoMaintenanceMarginIgnored: true,
      rawPayloadRetained: false,
    } as const;
    const selectedLanes = [...request.modelLanes];
    const executionLane = selectedLanes.includes(this.options.executionLane ?? "kronos_base")
      ? this.options.executionLane ?? "kronos_base"
      : selectedLanes[0]!;
    const queue = new AsyncMarketEventQueue();
    const ingressStore = new CausalBinanceKlineStore();
    const decisionStore = new CausalBinanceKlineStore();
    const warnings: string[] = [];
    const decisions: RuntimeDecision[] = [];
    const states = new Map<SimulationModelLane, LaneState>();
    let currentSpreadBps = selected.spreadBps;
    let currentMarkPrice = selected.price;
    let lastTriggeredAt: string | undefined;
    let triggeredEvents = 0;
    let inferenceInFlight = false;
    let klineDataHealthy = true;
    let klineDataBlockReason: string | undefined;
    let closing = false;
    let scheduledFunding: { eventAt: number; rate: number } | undefined;
    let streamDisconnected: { error?: unknown } | undefined;
    let subscription: BinanceWebsocketSubscription | undefined;
    let lastPublishedAt = Number.NEGATIVE_INFINITY;
    let lastProgressUpdateAt = Number.NEGATIVE_INFINITY;
    let lastCancellationPollAt = Number.NEGATIVE_INFINITY;
    let lastInferredOpenTime = Number.NEGATIVE_INFINITY;
    let lastProcessedFinalOpenTime = Number.NEGATIVE_INFINITY;
    let lastBookTickerObservedAt: number | undefined;
    let lastMarkPriceObservedAt: number | undefined;
    let lastIngressSequence = 0;
    const ingressSequences = new WeakMap<object, number>();
    let streamQualificationState:
      | "initializing"
      | "qualified"
      | "reconnecting"
      | "rest_recovery"
      | "awaiting_risk_streams" = "initializing";
    let lastRiskClockAt = setupStartedAt;

    for (const lane of selectedLanes) {
      const ledger = new FuturesPaperLedger({
        initialCash: request.initialCash,
        feeBpsPerSide: request.costs.commissionBpsPerSide,
        slippageBpsPerSide: request.costs.slippageBpsPerSide,
      });
      states.set(lane, {
        lane,
        ledger,
        dailyGate: updateDailyLossGate(undefined, request.initialCash, startedAt),
        attempts: 0,
        successes: 0,
        timeoutCount: 0,
        latencies: [],
        precision: "unknown",
        errors: [],
        consecutiveFailures: 0,
        forecasts: [],
        predictionMetrics: {
          pinballLosses: [],
          medianAbsoluteErrors: [],
          directionHits: [],
          coverageHits: [],
          nominalCoverage: [],
        },
        equity: [{ timestamp: iso(startedAt), equity: request.initialCash, drawdown: 0 }],
        equityPeak: request.initialCash,
        maximumDrawdown: 0,
        lastEquitySampleAt: startedAt,
      });
    }

    const cancellationCheckpoint = async (): Promise<void> => {
      if (context.signal.aborted) {
        throw abortReason(context.signal, "Crypto paper runtime was aborted.");
      }
      const at = this.clock.now();
      if (at - lastCancellationPollAt < CANCELLATION_POLL_INTERVAL_MS) return;
      lastCancellationPollAt = at;
      if (!await context.isCancelled()) return;
      await context.throwIfCancelled();
      throw new Error("Crypto paper runtime cancellation was requested.");
    };

    type StreamFreshness = {
      healthy: boolean;
      reason?: string;
      warnings: string[];
      bookTicker: {
        status: "missing" | "fresh" | "stale";
        maximumAgeMs: number;
        lastObservedAt?: string;
      };
      markPrice: {
        status: "missing" | "fresh" | "stale";
        maximumAgeMs: number;
        lastObservedAt?: string;
      };
    };
    const riskStreamFreshness = (at = this.clock.now()): StreamFreshness => {
      const bookStatus = lastBookTickerObservedAt === undefined
        ? "missing"
        : at - lastBookTickerObservedAt <= BOOK_TICKER_FRESHNESS_MS
          ? "fresh"
          : "stale";
      const markStatus = lastMarkPriceObservedAt === undefined
        ? "missing"
        : at - lastMarkPriceObservedAt <= MARK_PRICE_FRESHNESS_MS
          ? "fresh"
          : "stale";
      const streamWarnings = [
        ...(streamQualificationState === "qualified"
          || streamQualificationState === "initializing"
          ? []
          : [`stream_${streamQualificationState}`]),
        ...(bookStatus === "fresh" ? [] : [`book_ticker_${bookStatus}`]),
        ...(markStatus === "fresh" ? [] : [`mark_price_${markStatus}`]),
      ];
      return {
        healthy: streamQualificationState === "qualified"
          && bookStatus === "fresh"
          && markStatus === "fresh",
        ...(streamWarnings.length
          ? { reason: `risk_stream_${streamWarnings.join("_and_")}` }
          : {}),
        warnings: streamWarnings,
        bookTicker: {
          status: bookStatus,
          maximumAgeMs: BOOK_TICKER_FRESHNESS_MS,
          ...(lastBookTickerObservedAt === undefined
            ? {}
            : { lastObservedAt: iso(lastBookTickerObservedAt) }),
        },
        markPrice: {
          status: markStatus,
          maximumAgeMs: MARK_PRICE_FRESHNESS_MS,
          ...(lastMarkPriceObservedAt === undefined
            ? {}
            : { lastObservedAt: iso(lastMarkPriceObservedAt) }),
        },
      };
    };
    const entryBlockReason = (at = this.clock.now()): string | undefined => {
      if (!klineDataHealthy) return klineDataBlockReason ?? "market_data_gap";
      if (streamQualificationState !== "qualified") {
        return `stream_${streamQualificationState}`;
      }
      return riskStreamFreshness(at).reason;
    };
    const entryDataHealthy = (at = this.clock.now()): boolean => (
      klineDataHealthy && riskStreamFreshness(at).healthy
    );
    const blockPendingOpens = (reason: string): void => {
      for (const state of states.values()) {
        if (state.pending?.action !== "open") continue;
        state.pending.decision.status = "blocked";
        state.pending.decision.reason = reason;
        state.pending = undefined;
      }
    };
    const enterReconnectSafety = (): void => {
      streamQualificationState = "reconnecting";
      klineDataHealthy = false;
      klineDataBlockReason = "stream_reconnecting";
      lastBookTickerObservedAt = undefined;
      lastMarkPriceObservedAt = undefined;
      blockPendingOpens("stream_reconnecting");
    };
    const requiresReconnectRecovery = (): boolean => (
      streamQualificationState === "reconnecting"
      || streamQualificationState === "rest_recovery"
    );
    const maybeCompleteStreamRequalification = (): void => {
      if (streamQualificationState !== "awaiting_risk_streams") return;
      const at = this.clock.now();
      const bookFresh = lastBookTickerObservedAt !== undefined
        && at - lastBookTickerObservedAt <= BOOK_TICKER_FRESHNESS_MS;
      const markFresh = lastMarkPriceObservedAt !== undefined
        && at - lastMarkPriceObservedAt <= MARK_PRICE_FRESHNESS_MS;
      if (!klineDataHealthy || !bookFresh || !markFresh) return;
      streamQualificationState = "qualified";
      klineDataBlockReason = undefined;
    };

    const modelComparison = () => ({
      comparisonId: `${context.runId}:${symbol}`,
      outcome: selectedLanes.length > 1 ? "inconclusive" : "pending",
      sameOrigin: true,
      sameContext: true,
      sameCosts: true,
      sameFillBarrier: true,
      symbol,
      lanes: selectedLanes.map((lane) => {
        const state = states.get(lane)!;
        return {
          id: lane,
          status: laneStatus(state),
          precision: state.precision,
          ...(state.errors.length
            ? { unavailableReason: state.errors.at(-1) }
            : {}),
          metrics: modelMetrics(state),
          provenance: {
            modelId: state.modelId,
            modelRevision: state.modelRevision,
          },
        };
      }),
    });

    const snapshotFor = (
      phase: CryptoPaperRuntimeSnapshot["phase"],
      at = this.clock.now(),
    ): CryptoPaperRuntimeSnapshot => {
      const execution = states.get(executionLane)!;
      const ledger = execution.ledger.snapshot();
      const streamFreshness = riskStreamFreshness(at);
      const positions = futuresPositions(ledger, streamFreshness.warnings);
      const progress = phase === "running"
        ? Math.max(0, Math.min(0.999, (at - startedAt) / Math.max(1, expiresAt - startedAt)))
        : 1;
      const dailyLossRatio = execution.dailyGate.drawdownRate;
      const bars = decisionStore.list(symbol).slice(-240);
      return {
        schemaVersion: AI_SIMULATION_CONTRACT_VERSION,
        runId: context.runId,
        phase,
        startedAt: iso(startedAt),
        expiresAt: iso(expiresAt),
        market: {
          kind: "crypto_futures",
          venue: "BINANCE_USDM",
          quoteAsset: "USDT",
          contractType: "PERPETUAL",
        },
        currency: "USDT",
        initialCash: request.initialCash,
        cash: ledger.walletBalance,
        equity: ledger.equity,
        progress,
        selection: request.selection,
        criterion: request.selection.mode === "auto"
          ? request.selection.criterion
          : input.snapshot.criterion,
        preset: request.preset,
        riskTolerance: request.riskTolerance,
        selected: [{
          symbol,
          name: symbol,
          rank: selected.rank,
          score: selected.score,
          price: selected.price,
          reason: `scanner ${input.snapshot.scannerSnapshotId}`,
        }],
        positions,
        futuresPositions: positions,
        futuresRisk: {
          dailyLossRatio,
          dailyLossLimitRatio: FUTURES_DAILY_LOSS_LIMIT_RATE,
          newEntriesBlocked: execution.dailyGate.blocked
            || !klineDataHealthy
            || !streamFreshness.healthy,
          ...(execution.dailyGate.blocked
            ? { blockReason: "UTC 일손실 3% gate" }
            : entryBlockReason(at) ? { blockReason: entryBlockReason(at) } : {}),
          grossExposureRatio: ledger.equity > 0 ? ledger.grossExposure / ledger.equity : 0,
          marginUsageRatio: ledger.equity > 0
            ? ledger.totalIsolatedMargin / ledger.equity
            : 0,
          riskPerTradeRatio: FUTURES_TRADE_RISK_RATE,
          riskStreams: {
            healthy: streamFreshness.healthy,
            bookTicker: streamFreshness.bookTicker,
            markPrice: streamFreshness.markPrice,
          },
        },
        charts: [{
          symbol,
          name: symbol,
          currency: "USDT",
          bars: bars.map((bar) => ({
            timestamp: iso(bar.closeTime),
            open: bar.open,
            high: bar.high,
            low: bar.low,
            close: bar.close,
            volume: bar.volume,
          })),
          indicators: [],
          patterns: [],
          updatedAt: bars.length ? iso(bars.at(-1)!.closeTime) : undefined,
        }],
        trades: tradeRows(executionLane, ledger),
        decisions: decisions.filter((decision) => decision.lane === executionLane).slice(-300),
        kronosForecasts: [],
        warnings: unique(warnings),
        capabilities: {
          paper: true,
          testnet: false,
          live: false,
          realOrder: false,
          isolatedMargin: true,
          oneWayPosition: true,
          maximumPaperLeverage: 15,
          executionLane,
        },
        modelLanes: selectedLanes,
        executionMode: "paper",
        executionLane,
        modelComparison: modelComparison(),
        decisionCadence: {
          trigger: "final_binance_1m_kline",
          triggeredEvents,
          ...(lastTriggeredAt ? { lastTriggeredAt } : {}),
          inFlight: inferenceInFlight,
        },
      };
    };

    const publishSnapshot = async (
      phase: CryptoPaperRuntimeSnapshot["phase"],
      force = false,
      at = this.clock.now(),
    ): Promise<CryptoPaperRuntimeSnapshot> => {
      const snapshot = snapshotFor(phase, at);
      if (!this.options.onSnapshot || (!force && at - lastPublishedAt < 500)) return snapshot;
      try {
        await this.options.onSnapshot(context.runId, structuredClone(snapshot));
        lastPublishedAt = at;
      } catch (error) {
        warnings.push(`snapshot_observer_failed:${error instanceof Error ? error.message : "unknown"}`);
      }
      return snapshot;
    };

    const recordEquity = (at: number): void => {
      for (const state of states.values()) {
        const equity = state.ledger.snapshot().equity;
        state.equityPeak = Math.max(state.equityPeak, equity);
        const drawdown = state.equityPeak > 0
          ? (state.equityPeak - equity) / state.equityPeak
          : 0;
        state.maximumDrawdown = Math.max(state.maximumDrawdown, drawdown);
        if (at - state.lastEquitySampleAt < EQUITY_SAMPLE_INTERVAL_MS) continue;
        state.lastEquitySampleAt = at;
        if (state.equity.length >= MAX_EQUITY_SAMPLES_PER_LANE) {
          state.equity[state.equity.length - 1] = {
            timestamp: iso(at),
            equity,
            drawdown,
          };
          continue;
        }
        state.equity.push({
          timestamp: iso(at),
          equity,
          drawdown,
        });
      }
    };

    const updateProgress = async (
      force = false,
      completed = false,
    ): Promise<void> => {
      const at = this.clock.now();
      if (!force && at - lastProgressUpdateAt < PROGRESS_UPDATE_INTERVAL_MS) return;
      const progress = completed
        ? 1
        : Math.max(
          0.001,
          Math.min(0.999, (at - startedAt) / Math.max(1, expiresAt - startedAt)),
        );
      await context.updateProgress(progress, {
        completedCandidates: completed ? 1 : 0,
        totalCandidates: 1,
        currentValidationWindow: completed
          ? `shadow:${symbol}:complete`
          : `shadow:${symbol}`,
        ...(warnings.length ? { warnings: unique(warnings).slice(-20) } : {}),
      });
      lastProgressUpdateAt = at;
    };

    const decisionId = (lane: SimulationModelLane, at: number): string => (
      `decision:${lane}:${at}:${decisions.length + 1}`
    );
    const fillId = (lane: SimulationModelLane, at: number): string => (
      `fill:${lane}:${at}:${states.get(lane)!.ledger.snapshot().fills.length + 1}`
    );
    const clientOrderId = (
      lane: SimulationModelLane,
      action: "open" | "reduce",
      at: number,
    ): string => `${lane === "kronos_base" ? "k" : "f"}-${action === "open" ? "o" : "r"}-${at}`
      .slice(0, 36);

    const executePending = (event: BinanceMarketEvent): boolean => {
      const fillPrice = event.kind === "agg_trade"
        ? event.price
        : event.kind === "kline" && event.final
          ? event.open
          : undefined;
      const executedAt = event.kind === "agg_trade"
        ? event.executedAt
        : event.kind === "kline" && event.final
          ? event.openTime
          : undefined;
      if (fillPrice === undefined || executedAt === undefined) return false;
      const ingressSequence = ingressSequences.get(event);
      if (ingressSequence === undefined) return false;
      let filled = false;
      for (const state of states.values()) {
        const pending = state.pending;
        if (!pending
          || ingressSequence <= pending.eligibleAfterIngressSequence
          || event.receivedAt <= pending.decisionAt
          || executedAt <= pending.decisionAt) continue;
        // A finalized kline may only contribute its open as a simulated fill
        // when that open occurred strictly after the decision. Checking the
        // close/receipt time here would look back to a price that had already
        // traded while model inference was still running.
        if (event.kind === "kline" && event.openTime <= pending.decisionAt) continue;
        const ledgerBefore = state.ledger.snapshot();
        if (pending.action === "open"
          && (state.dailyGate.blocked || !entryDataHealthy(this.clock.now()))) {
          pending.decision.status = "blocked";
          pending.decision.reason = state.dailyGate.blocked
            ? "daily_loss_gate"
            : entryBlockReason(this.clock.now()) ?? "market_data_unhealthy";
          state.pending = undefined;
          continue;
        }
        try {
          const fill = pending.action === "open"
            ? (() => {
              const side = pending.side!;
              const slippageRate = request.costs.slippageBpsPerSide / 10_000;
              const expectedEntryPrice = side === "long"
                ? ceilToStep(fillPrice * (1 + slippageRate), rules.tickSize)
                : floorToStep(fillPrice * (1 - slippageRate), rules.tickSize);
              const latest = state.ledger.snapshot();
              const revalidated = sizeFuturesPosition({
                mode: "paper",
                side,
                equity: latest.equity,
                currentGrossExposure: latest.grossExposure,
                currentMargin: latest.totalIsolatedMargin,
                price: expectedEntryPrice,
                atr14: pending.atr14!,
                adverseQuantileDistance: pending.adverseQuantileDistance!,
                spreadBps: Math.max(pending.spreadBps!, currentSpreadBps),
                slippageBpsPerSide: request.costs.slippageBpsPerSide,
                // Revalidation may lower leverage or quantity, but it never
                // upgrades the decision after seeing a later market event.
                requestedLeverage: pending.leverage!,
                rules,
              });
              const feeRate = request.costs.commissionBpsPerSide / 10_000;
              const markPnlPerUnit = side === "long"
                ? currentMarkPrice - expectedEntryPrice
                : expectedEntryPrice - currentMarkPrice;
              const equitySlope = markPnlPerUnit - expectedEntryPrice * feeRate;
              const boundedQuantity = (
                limitRate: number,
                currentUsage: number,
                usagePerUnit: number,
              ): number => {
                const numerator = limitRate * latest.equity - currentUsage;
                const denominator = usagePerUnit - limitRate * equitySlope;
                if (numerator <= 0) return 0;
                if (denominator <= 0) return Number.POSITIVE_INFINITY;
                return numerator / denominator;
              };
              const grossQuantityLimit = boundedQuantity(
                1.5,
                latest.grossExposure,
                currentMarkPrice,
              );
              const marginQuantityLimit = boundedQuantity(
                0.2,
                latest.totalIsolatedMargin,
                expectedEntryPrice / revalidated.leverage,
              );
              const stopDistance = Math.abs(
                expectedEntryPrice - revalidated.protectiveStopPrice,
              );
              const riskQuantityLimit = boundedQuantity(
                FUTURES_TRADE_RISK_RATE,
                0,
                stopDistance,
              );
              const quantity = floorToStep(Math.min(
                pending.quantity!,
                revalidated.quantity,
                grossQuantityLimit,
                marginQuantityLimit,
                riskQuantityLimit,
              ), rules.stepSize);
              if (!revalidated.accepted
                || quantity < rules.minQuantity
                || quantity * expectedEntryPrice < rules.minNotional) {
                throw new Error(`risk_revalidation_${revalidated.reason ?? "minimum_notional"}`);
              }
              pending.decision.leverage = revalidated.leverage;
              pending.decision.quantity = quantity;
              pending.decision.notional = quantity * expectedEntryPrice;
              pending.decision.protectiveStopPrice = revalidated.protectiveStopPrice;
              return state.ledger.open({
                fillId: fillId(state.lane, executedAt),
                clientOrderId: clientOrderId(state.lane, "open", executedAt),
                rules,
                side,
                quantity,
                observedPrice: fillPrice,
                markPrice: currentMarkPrice,
                leverage: revalidated.leverage,
                protectiveStopPrice: revalidated.protectiveStopPrice,
                decisionAt: pending.decisionAt,
                executedAt,
              });
            })()
            : (() => {
              const position = ledgerBefore.positions.find((item) => item.symbol === symbol);
              if (!position) return undefined;
              return state.ledger.reduce({
                fillId: fillId(state.lane, executedAt),
                clientOrderId: clientOrderId(state.lane, "reduce", executedAt),
                symbol,
                quantity: position.quantity,
                observedPrice: fillPrice,
                decisionAt: pending.decisionAt,
                executedAt,
                reduceOnly: true,
                reason: pending.reason,
              });
            })();
          if (!fill) {
            pending.decision.status = "skipped";
            pending.decision.reason = "position_already_closed";
          } else {
            pending.decision.status = "executed";
            pending.decision.fillId = fill.fillId;
            pending.decision.executedAt = iso(fill.executedAt);
            filled = true;
          }
        } catch (error) {
          pending.decision.status = "skipped";
          pending.decision.reason = `fill_rejected:${error instanceof Error ? error.message : "unknown"}`;
          warnings.push(`${state.lane}:${pending.decision.reason}`);
        } finally {
          state.pending = undefined;
        }
      }
      return filled;
    };

    const scheduleReduce = (
      state: LaneState,
      at: number,
      reason: "daily_loss_gate" | "protection",
    ): void => {
      const position = state.ledger.snapshot().positions.find((item) => item.symbol === symbol);
      if (!position || at <= position.openedAt) return;
      if (state.pending?.action === "reduce") {
        if (reason === "daily_loss_gate") {
          state.pending.reason = reason;
          state.pending.decision.reason = reason;
        }
        return;
      }
      if (state.pending?.action === "open") {
        state.pending.decision.status = "blocked";
        state.pending.decision.reason = reason;
      }
      const decision: RuntimeDecision = {
        id: decisionId(state.lane, at),
        lane: state.lane,
        symbol,
        originAt: iso(at),
        decisionAt: iso(at),
        fillEligibleAfter: iso(at),
        action: "reduce",
        direction: position.side,
        status: "pending",
        reason,
        requestDigest: digest({ reason, symbol, at }),
      };
      decisions.push(decision);
      state.pending = {
        action: "reduce",
        decision,
        decisionAt: at,
        eligibleAfterIngressSequence: lastIngressSequence,
        reason,
      };
    };

    const enforceRisk = (event: BinanceMarketEvent): void => {
      // Daily-loss UTC boundaries use monotonic local observation time. A
      // delayed prior-day exchange event must never rewind/reset the gate.
      const at = monotonicCryptoRiskClock(
        lastRiskClockAt,
        this.clock.now(),
        event.receivedAt,
      );
      lastRiskClockAt = at;
      const price = eventPrice(event);
      for (const state of states.values()) {
        const position = state.ledger.snapshot().positions.find((item) => item.symbol === symbol);
        if (position && at > position.openedAt) {
          const crossed = position.side === "long"
            ? event.kind === "kline" && event.final
              ? event.low <= position.protectiveStopPrice
              : price !== undefined && price <= position.protectiveStopPrice
            : event.kind === "kline" && event.final
              ? event.high >= position.protectiveStopPrice
              : price !== undefined && price >= position.protectiveStopPrice;
          if (crossed) scheduleReduce(state, at, "protection");
        }
        const gate = updateDailyLossGate(state.dailyGate, state.ledger.snapshot().equity, at);
        state.dailyGate = gate;
        if (gate.closeAllReduceOnly) scheduleReduce(state, at, "daily_loss_gate");
      }
    };

    const applyMarkAndFunding = (event: BinanceMarketEvent): void => {
      if (event.kind !== "mark_price") return;
      if (scheduledFunding && event.eventTime >= scheduledFunding.eventAt) {
        for (const state of states.values()) {
          const position = state.ledger.snapshot().positions.find((item) => item.symbol === symbol);
          if (!position || position.openedAt >= scheduledFunding.eventAt) continue;
          try {
            state.ledger.applyFunding({
              eventId: `funding:${symbol}:${scheduledFunding.eventAt}`,
              symbol,
              rate: scheduledFunding.rate,
              eventAt: scheduledFunding.eventAt,
            });
          } catch (error) {
            warnings.push(`${state.lane}:funding_rejected:${error instanceof Error ? error.message : "unknown"}`);
          }
        }
        scheduledFunding = undefined;
      }
      currentMarkPrice = event.markPrice;
      for (const state of states.values()) {
        state.ledger.mark(symbol, event.markPrice, event.eventTime);
      }
      if (event.nextFundingTime > event.eventTime) {
        scheduledFunding = { eventAt: event.nextFundingTime, rate: event.fundingRate };
      }
    };

    const settleForecasts = (bar: BinanceKline): void => {
      for (const state of states.values()) {
        for (const forecast of state.forecasts) {
          if (forecast.evaluated || bar.closeTime < forecast.targetAt) continue;
          const actual = bar.close / forecast.originPrice - 1;
          const median = forecast.quantiles.find((item) => item.quantile === 0.5)!;
          const low = forecast.quantiles[0]!;
          const high = forecast.quantiles.at(-1)!;
          for (const predicted of forecast.quantiles) {
            const residual = actual - predicted.returnRate;
            state.predictionMetrics.pinballLosses.push(
              (predicted.quantile - (residual < 0 ? 1 : 0)) * residual,
            );
          }
          state.predictionMetrics.medianAbsoluteErrors.push(
            Math.abs(actual - median.returnRate),
          );
          state.predictionMetrics.directionHits.push(
            Math.sign(actual) === Math.sign(median.returnRate) ? 1 : 0,
          );
          state.predictionMetrics.coverageHits.push(
            actual >= low.returnRate && actual <= high.returnRate ? 1 : 0,
          );
          state.predictionMetrics.nominalCoverage.push(high.quantile - low.quantile);
          forecast.evaluated = true;
        }
      }
    };

    const infer = async (bar: BinanceKline): Promise<void> => {
      const bars = decisionStore.list(symbol).slice(-this.contextBars);
      if (!bars.length || bars.at(-1)!.openTime !== bar.openTime) return;
      if (bar.openTime <= lastInferredOpenTime) return;
      lastInferredOpenTime = bar.openTime;
      const canonicalRequest = aiRequest(context.runId, symbol, bars);
      const requestDigest = digest(canonicalRequest);
      const outcomes = new Map<
        SimulationModelLane,
        { forecast?: NormalizedLaneForecast; error?: string }
      >();
      const inferenceController = new AbortController();
      const onContextAbort = () => inferenceController.abort(context.signal.reason);
      context.signal.addEventListener("abort", onContextAbort, { once: true });
      const remainingRuntimeMs = Math.max(0, expiresAt - this.clock.now());
      const inferenceBudgetMs = Math.min(this.inferenceDeadlineMs, remainingRuntimeMs);
      const deadlineTimer = setTimeout(() => {
        inferenceController.abort(new Error(
          remainingRuntimeMs <= this.inferenceDeadlineMs
            ? "crypto_runtime_expiry_deadline_exceeded"
            : "crypto_lane_sequential_deadline_exceeded",
        ));
      }, inferenceBudgetMs);
      deadlineTimer.unref();
      inferenceInFlight = true;
      triggeredEvents += 1;
      lastTriggeredAt = iso(bar.closeTime);
      try {
        for (const lane of selectedLanes) {
          const state = states.get(lane)!;
          state.attempts += 1;
          const attemptAt = this.clock.now();
          if (state.circuitOpenUntil !== undefined && attemptAt < state.circuitOpenUntil) {
            const error = "worker_circuit_open";
            state.errors.push(error);
            outcomes.set(lane, { error });
            continue;
          }
          state.circuitOpenUntil = undefined;
          const client = this.options.laneClients[lane];
          if (!client) {
            const error = "worker_unavailable";
            state.errors.push(error);
            state.consecutiveFailures += 1;
            if (state.consecutiveFailures >= this.circuitFailureThreshold) {
              state.circuitOpenUntil = attemptAt + this.circuitCooldownMs;
            }
            outcomes.set(lane, { error });
            continue;
          }
          const before = this.clock.now();
          try {
            await cancellationCheckpoint();
            if (inferenceController.signal.aborted) {
              throw abortReason(
                inferenceController.signal,
                "Crypto model inference was aborted.",
              );
            }
            const raw = await raceWithAbort(
              Promise.resolve().then(() => client.request(
                structuredClone(canonicalRequest),
                inferenceController.signal,
              )),
              inferenceController.signal,
            );
            await cancellationCheckpoint();
            const forecast = normalizeLaneForecast(lane, raw, canonicalRequest);
            const observedLatency = Math.max(0, this.clock.now() - before);
            state.successes += 1;
            state.consecutiveFailures = 0;
            state.circuitOpenUntil = undefined;
            state.latencies.push(forecast.latencyMs ?? observedLatency);
            state.precision = forecast.precision;
            state.modelId = forecast.modelId;
            state.modelRevision = forecast.modelRevision;
            state.peakVramMb = Math.max(state.peakVramMb ?? 0, forecast.peakVramMb ?? 0)
              || undefined;
            state.forecasts.push({
              ...forecast,
              originPrice: bar.close,
              targetAt: bar.closeTime + SCALPING_AI_HORIZONS[0] * MINUTE_MS,
              evaluated: false,
            });
            outcomes.set(lane, { forecast });
          } catch (error) {
            await cancellationCheckpoint();
            const reason = error instanceof Error ? error.message : "model_call_failed";
            state.errors.push(reason);
            state.consecutiveFailures += 1;
            if (state.consecutiveFailures >= this.circuitFailureThreshold) {
              state.circuitOpenUntil = this.clock.now() + this.circuitCooldownMs;
            }
            if (isTimeout(error)) state.timeoutCount += 1;
            outcomes.set(lane, { error: reason });
          }
        }

        const commonDecisionAt = Math.max(
          bar.closeTime,
          this.clock.now(),
          ...Array.from(outcomes.values()).flatMap((item) => (
            item.forecast ? [item.forecast.generatedAt] : []
          )),
        );
        const observedCostRate = costRate(request, currentSpreadBps);
        const currentAtr = Math.max(
          atr14(bars),
          selected.atrPercent14 * bar.close,
        );
        const currentVolatility = Math.max(
          realizedVolatility(bars),
          selected.realizedVolatility60m,
        );
        for (const lane of selectedLanes) {
          const state = states.get(lane)!;
          const outcome = outcomes.get(lane);
          if (!outcome?.forecast) {
            decisions.push({
              id: decisionId(lane, commonDecisionAt),
              lane,
              symbol,
              originAt: iso(bar.closeTime),
              decisionAt: iso(commonDecisionAt),
              fillEligibleAfter: iso(commonDecisionAt),
              action: "none",
              status: "unavailable",
              reason: outcome?.error ?? "worker_unavailable",
              requestDigest,
            });
            continue;
          }
          const signal: QuantileDirectionSignal = signalFromQuantileCdf({
            quantiles: outcome.forecast.quantiles,
            roundTripCostRate: observedCostRate,
            realizedVolatilityRate: currentVolatility,
            spreadBps: currentSpreadBps,
            mode: "paper",
          });
          const baseDecision: RuntimeDecision = {
            id: decisionId(lane, commonDecisionAt),
            lane,
            symbol,
            originAt: iso(bar.closeTime),
            generatedAt: outcome.forecast.generatedAtIso,
            decisionAt: iso(commonDecisionAt),
            fillEligibleAfter: iso(commonDecisionAt),
            action: "none",
            direction: signal.direction,
            confidence: signal.confidence,
            probabilityAboveCost: signal.probabilityAboveCost,
            probabilityBelowNegativeCost: signal.probabilityBelowNegativeCost,
            roundTripCostRate: observedCostRate,
            status: "held",
            reason: "flat_signal",
            requestDigest,
          };
          if (commonDecisionAt - bar.closeTime > MINUTE_MS) {
            baseDecision.status = "blocked";
            baseDecision.reason = "model_stale";
            decisions.push(baseDecision);
            continue;
          }
          if (!entryDataHealthy(this.clock.now())) {
            baseDecision.status = "blocked";
            baseDecision.reason = entryBlockReason(this.clock.now())
              ?? "market_data_unhealthy";
            decisions.push(baseDecision);
            continue;
          }
          if (state.pending) {
            baseDecision.status = "skipped";
            baseDecision.reason = "pending_action_exists";
            decisions.push(baseDecision);
            continue;
          }
          const ledger = state.ledger.snapshot();
          const position = ledger.positions.find((item) => item.symbol === symbol);
          if (signal.direction === "flat") {
            baseDecision.action = "hold";
            decisions.push(baseDecision);
            continue;
          }
          if (position) {
            if (position.side === signal.direction) {
              baseDecision.action = "hold";
              baseDecision.reason = "same_side_no_averaging";
              decisions.push(baseDecision);
              continue;
            }
            baseDecision.action = "reduce";
            baseDecision.status = "pending";
            baseDecision.reason = "opposite_signal_reduce_only";
            decisions.push(baseDecision);
            state.pending = {
              action: "reduce",
              decision: baseDecision,
              decisionAt: commonDecisionAt,
              eligibleAfterIngressSequence: lastIngressSequence,
              reason: "signal",
            };
            continue;
          }
          if (state.dailyGate.blocked || !entryDataHealthy(this.clock.now())) {
            baseDecision.status = "blocked";
            baseDecision.reason = state.dailyGate.blocked
              ? "daily_loss_gate"
              : entryBlockReason(this.clock.now()) ?? "market_data_unhealthy";
            decisions.push(baseDecision);
            continue;
          }
          const adverseQuantileDistance = signal.direction === "long"
            ? Math.max(0, -outcome.forecast.quantiles[1]!.returnRate) * bar.close
            : Math.max(0, outcome.forecast.quantiles.at(-2)!.returnRate) * bar.close;
          const sizing = sizeFuturesPosition({
            mode: "paper",
            side: signal.direction,
            equity: ledger.equity,
            currentGrossExposure: ledger.grossExposure,
            currentMargin: ledger.totalIsolatedMargin,
            price: bar.close,
            atr14: currentAtr,
            adverseQuantileDistance,
            spreadBps: currentSpreadBps,
            slippageBpsPerSide: request.costs.slippageBpsPerSide,
            requestedLeverage: signal.leverageTier,
            rules,
          });
          baseDecision.action = signal.direction === "long" ? "open_long" : "open_short";
          baseDecision.leverage = sizing.leverage;
          baseDecision.quantity = sizing.quantity;
          baseDecision.notional = sizing.notional;
          baseDecision.protectiveStopPrice = sizing.protectiveStopPrice;
          if (!sizing.accepted) {
            baseDecision.status = "blocked";
            baseDecision.reason = `risk_${sizing.reason ?? "rejected"}`;
            decisions.push(baseDecision);
            continue;
          }
          baseDecision.status = "pending";
          baseDecision.reason = "cost_exceeding_quantile_signal";
          decisions.push(baseDecision);
          state.pending = {
            action: "open",
            decision: baseDecision,
            decisionAt: commonDecisionAt,
            eligibleAfterIngressSequence: lastIngressSequence,
            side: signal.direction,
            quantity: sizing.quantity,
            leverage: sizing.leverage,
            protectiveStopPrice: sizing.protectiveStopPrice,
            atr14: currentAtr,
            adverseQuantileDistance,
            spreadBps: currentSpreadBps,
          };
        }
      } finally {
        clearTimeout(deadlineTimer);
        context.signal.removeEventListener("abort", onContextAbort);
        inferenceInFlight = false;
      }
    };

    try {
      await cancellationCheckpoint();
      subscription = await this.options.streams.subscribe(
        [symbol],
        (event) => {
          if (closing || streamDisconnected || event.symbol !== symbol) return;
          if (event.kind === "kline" && !event.final) {
            queue.push(event);
            return;
          }
          const ingressSequence = ++lastIngressSequence;
          ingressSequences.set(event, ingressSequence);
          ingressStore.applyWebsocket(event);
          if (event.kind === "agg_trade") {
            const needed = Array.from(states.values()).some((state) => (
              Boolean(state.pending) || state.ledger.snapshot().positions.length > 0
            ));
            if (!needed) {
              queue.noteIgnoredAggTrade();
              return;
            }
          }
          const fillCandidate = event.kind === "agg_trade"
            && Array.from(states.values()).some((state) => (
              state.pending !== undefined
              && ingressSequence > state.pending.eligibleAfterIngressSequence
            ));
          const preserveMarkRisk = event.kind === "mark_price"
            && Array.from(states.values()).some((state) => (
              state.ledger.snapshot().positions.some((position) => (
                position.symbol === symbol
                && (position.side === "long"
                  ? event.markPrice <= Math.max(
                    position.protectiveStopPrice,
                    position.estimatedLiquidationPrice,
                  )
                  : event.markPrice >= Math.min(
                    position.protectiveStopPrice,
                    position.estimatedLiquidationPrice,
                  ))
              ))
            ));
          if (!queue.push(event, { ingressSequence, fillCandidate, preserveMarkRisk })) {
            const error = new Error("market_event_queue_overflow");
            streamDisconnected = { error };
            queue.fail(error);
          }
        },
        (error) => {
          if (closing || streamDisconnected) return;
          streamDisconnected = { error };
          queue.push({ kind: "disconnect", ...(error !== undefined ? { error } : {}) });
        },
        (state) => {
          if (closing || streamDisconnected) return;
          if (state.status === "reconnecting") enterReconnectSafety();
          if (!queue.push({ kind: "connection_state", state })) {
            const error = new Error("market_event_queue_overflow");
            streamDisconnected = { error };
            queue.fail(error);
          }
        },
      );
      await cancellationCheckpoint();
      const restoredRaw = await this.options.rest.klines({
        symbol,
        limit: MAXIMUM_RESTORED_BARS,
      });
      const boundedRestored = Array.isArray(restoredRaw)
        ? restoredRaw.slice(-MAXIMUM_RESTORED_BARS)
        : restoredRaw;
      ingressStore.applyRest(symbol, boundedRestored, this.clock.now());
      decisionStore.applyRest(symbol, boundedRestored, this.clock.now());
      const restored = decisionStore.list(symbol);
      if (!hasContinuousFinalContext(restored, this.contextBars)) {
        throw new CryptoPaperRuntimeError(
          "invalid_runtime_input",
          `Binance REST recovery did not return ${this.contextBars} continuous final one-minute bars.`,
        );
      }
      startedAt = this.clock.now();
      expiresAt = startedAt + request.durationMinutes * MINUTE_MS;
      lastRiskClockAt = startedAt;
      if (streamQualificationState === "initializing") {
        streamQualificationState = "qualified";
      }
      for (const state of states.values()) {
        state.dailyGate = updateDailyLossGate(undefined, request.initialCash, startedAt);
        state.equity = [{
          timestamp: iso(startedAt),
          equity: request.initialCash,
          drawdown: 0,
        }];
        state.equityPeak = request.initialCash;
        state.maximumDrawdown = 0;
        state.lastEquitySampleAt = startedAt;
      }
      const liveDecisionStartAt = startedAt;
      await updateProgress(true);
      await publishSnapshot("running", true, liveDecisionStartAt);

      while (this.clock.now() < expiresAt) {
        await cancellationCheckpoint();
        const waitMs = Math.min(this.pollIntervalMs, Math.max(0, expiresAt - this.clock.now()));
        const queued = await queue.next(waitMs, this.clock, context.signal);
        if (!queued) {
          await updateProgress();
          await publishSnapshot("running", false);
          continue;
        }
        if (queued.kind === "disconnect") {
          const detail = queued.error instanceof Error ? queued.error.message : "public stream closed";
          warnings.push(`stream_desync:${detail}`);
          const failedSnapshot = await publishSnapshot("failed", true);
          throw new CryptoPaperRuntimeError(
            "stream_desync",
            `Binance public stream desynchronized: ${detail}`,
            failedSnapshot,
          );
        }
        if (queued.kind === "connection_state") {
          const state = queued.state;
          if (state.status === "reconnecting") {
            enterReconnectSafety();
            await updateProgress();
            await publishSnapshot("running", true, this.clock.now());
            continue;
          }
          if (state.reconnectAttempt > 0 || requiresReconnectRecovery()) {
            streamQualificationState = "rest_recovery";
            klineDataHealthy = false;
            klineDataBlockReason = "stream_rest_recovery";
            const previousFinalOpenTime = decisionStore.list(symbol).at(-1)?.openTime;
            try {
              await cancellationCheckpoint();
              const recoveryRaw = await this.options.rest.klines({
                symbol,
                limit: MAXIMUM_RESTORED_BARS,
              });
              const recoveryBars = Array.isArray(recoveryRaw)
                ? recoveryRaw.slice(-MAXIMUM_RESTORED_BARS)
                : recoveryRaw;
              const observedAt = this.clock.now();
              ingressStore.applyRest(symbol, recoveryBars, observedAt);
              decisionStore.applyRest(symbol, recoveryBars, observedAt);
              const recovered = decisionStore.list(symbol);
              klineDataHealthy = hasContinuousFinalContext(recovered, this.contextBars);
              if (!klineDataHealthy) {
                klineDataBlockReason = "stream_rest_recovery_gap";
                streamQualificationState = "rest_recovery";
              } else {
                for (const bar of recovered) {
                  if (previousFinalOpenTime !== undefined
                    && bar.openTime <= previousFinalOpenTime) continue;
                  settleForecasts(bar);
                  enforceRisk({
                    ...bar,
                    kind: "kline",
                    source: "binance_ws",
                    receivedAt: observedAt,
                  });
                }
                klineDataBlockReason = "stream_awaiting_risk_streams";
                streamQualificationState = "awaiting_risk_streams";
                maybeCompleteStreamRequalification();
              }
            } catch (error) {
              klineDataHealthy = false;
              klineDataBlockReason = "stream_rest_recovery_failed";
              warnings.push(
                `reconnect_recovery_failed:${error instanceof Error ? error.message : "unknown"}`,
              );
            }
            await updateProgress();
            await publishSnapshot("running", true, this.clock.now());
          }
          continue;
        }
        const event = queued;
        let filled = false;

        if (event.kind === "book_ticker") {
          lastBookTickerObservedAt = event.receivedAt;
          const midpoint = (event.bidPrice + event.askPrice) / 2;
          currentSpreadBps = midpoint > 0
            ? (event.askPrice - event.bidPrice) / midpoint * 10_000
            : currentSpreadBps;
        }
        if (event.kind === "mark_price") {
          lastMarkPriceObservedAt = event.receivedAt;
        }
        maybeCompleteStreamRequalification();
        applyMarkAndFunding(event);
        if (event.kind === "kline") {
          const previousFinal = decisionStore.list(symbol).at(-1);
          decisionStore.applyWebsocket(event);
          if (event.final && previousFinal
            && event.openTime - previousFinal.openTime > MINUTE_MS) {
            klineDataHealthy = false;
            klineDataBlockReason = "market_data_gap_recovery";
            blockPendingOpens("market_data_gap_recovery");
            try {
              const gapRaw = await this.options.rest.klines({
                symbol,
                startTime: previousFinal.openTime + MINUTE_MS,
                endTime: event.openTime - 1,
                limit: Math.min(
                  MAXIMUM_RESTORED_BARS,
                  Math.ceil((event.openTime - previousFinal.openTime) / MINUTE_MS),
                ),
              });
              ingressStore.applyRest(symbol, gapRaw, this.clock.now());
              decisionStore.applyRest(symbol, gapRaw, this.clock.now());
              const recent = decisionStore.list(symbol)
                .filter((bar) => bar.openTime >= previousFinal.openTime
                  && bar.openTime <= event.openTime);
              klineDataHealthy = recent.every((bar, index) => (
                index === 0 || bar.openTime - recent[index - 1]!.openTime === MINUTE_MS
              ));
              klineDataBlockReason = klineDataHealthy
                ? undefined
                : "market_data_gap";
              if (klineDataHealthy) {
                const observedAt = this.clock.now();
                for (const recovered of recent.slice(1, -1)) {
                  settleForecasts(recovered);
                  enforceRisk({
                    ...recovered,
                    kind: "kline",
                    source: "binance_ws",
                    receivedAt: observedAt,
                  });
                }
              }
            } catch (error) {
              klineDataHealthy = false;
              klineDataBlockReason = "market_data_gap_recovery_failed";
              warnings.push(
                `gap_recovery_failed:${error instanceof Error ? error.message : "unknown"}`,
              );
            }
          }
        }
        filled = executePending(event);
        enforceRisk(event);
        if (event.kind === "kline" && event.final) {
          settleForecasts(event);
          if (event.receivedAt >= liveDecisionStartAt
            && event.openTime > lastProcessedFinalOpenTime) {
            lastProcessedFinalOpenTime = event.openTime;
            if (entryDataHealthy(this.clock.now())) {
              await infer(event);
            } else {
              const bars = decisionStore.list(symbol).slice(-this.contextBars);
              const requestDigest = bars.length ? digest(aiRequest(context.runId, symbol, bars)) : "";
              const at = Math.max(event.closeTime, this.clock.now());
              triggeredEvents += 1;
              lastTriggeredAt = iso(event.closeTime);
              for (const lane of selectedLanes) {
                decisions.push({
                  id: decisionId(lane, at),
                  lane,
                  symbol,
                  originAt: iso(event.closeTime),
                  decisionAt: iso(at),
                  fillEligibleAfter: iso(at),
                  action: "none",
                  status: "blocked",
                  reason: entryBlockReason(this.clock.now()) ?? "market_data_unhealthy",
                  requestDigest,
                });
              }
            }
          }
        }
        recordEquity(this.clock.now());
        const forceSnapshot = filled || (event.kind === "kline" && event.final);
        await updateProgress();
        await publishSnapshot("running", forceSnapshot, this.clock.now());
      }

      await cancellationCheckpoint();
      await updateProgress(true, true);
      const terminalSnapshot = await publishSnapshot("completed", true, expiresAt);
      const allTrades = selectedLanes.flatMap((lane) => (
        tradeRows(lane, states.get(lane)!.ledger.snapshot())
      ));
      const comparison = modelComparison();
      const provenance = selectedLanes.map((lane) => {
        const state = states.get(lane)!;
        return {
          lane,
          status: laneStatus(state),
          precision: state.precision,
          modelId: state.modelId,
          modelRevision: state.modelRevision,
          attempts: state.attempts,
          successes: state.successes,
          peakVramMb: state.peakVramMb,
          errors: unique(state.errors),
        };
      });
      const executionLedger = states.get(executionLane)!.ledger.snapshot();
      const summary = {
        schemaVersion: AI_SIMULATION_CONTRACT_VERSION,
        phase: "completed",
        market: request.market,
        currency: "USDT",
        initialCash: request.initialCash,
        finalEquity: executionLedger.equity,
        netProfitLoss: executionLedger.equity - request.initialCash,
        returnRatio: executionLedger.equity / request.initialCash - 1,
        tradeCount: executionLedger.fills.length,
        selectedSymbols: [symbol],
        executionLane,
        realOrderApiUsed: false,
        snapshot: terminalSnapshot,
      };
      return {
        summary,
        result: {
          snapshot: terminalSnapshot,
          report: {
            configuration: {
              market: request.market,
              initialCash: request.initialCash,
              durationMinutes: request.durationMinutes,
              selection: request.selection,
              preset: request.preset,
              riskTolerance: request.riskTolerance,
              costs: request.costs,
              modelLanes: selectedLanes,
              execution: request.execution,
              executionLane,
            },
            selected: terminalSnapshot.selected,
            performance: summary,
            decisions,
            trades: tradeRows(executionLane, executionLedger),
            futuresPositions: terminalSnapshot.futuresPositions,
            futuresRisk: terminalSnapshot.futuresRisk,
            equity: states.get(executionLane)!.equity,
            modelComparison: comparison,
            warnings: terminalSnapshot.warnings,
            evidence: {
              scannerSnapshotId: input.snapshot.scannerSnapshotId,
              restoredFinalBars: Math.min(restored.length, MAXIMUM_RESTORED_BARS),
              onlyFinalKlinesTriggerInference: true,
              fillRequiresStrictlyLaterEvent: true,
              maintenanceMargin: maintenanceMarginEvidence,
              realOrder: false,
            },
          },
        },
        warnings: terminalSnapshot.warnings,
        artifacts: [
          {
            type: "simulation-decisions",
            content: {
              schemaVersion: AI_SIMULATION_CONTRACT_VERSION,
              symbol,
              decisions,
            },
            rowCount: decisions.length,
          },
          {
            type: "simulation-equity",
            content: {
              schemaVersion: AI_SIMULATION_CONTRACT_VERSION,
              lanes: Object.fromEntries(selectedLanes.map((lane) => [
                lane,
                states.get(lane)!.equity,
              ])),
            },
            rowCount: selectedLanes.reduce(
              (sum, lane) => sum + states.get(lane)!.equity.length,
              0,
            ),
          },
          {
            type: "simulation-trades",
            content: {
              schemaVersion: AI_SIMULATION_CONTRACT_VERSION,
              marginMode: "isolated",
              positionMode: "one_way",
              lanes: Object.fromEntries(selectedLanes.map((lane) => [
                lane,
                {
                  ledger: states.get(lane)!.ledger.snapshot(),
                  trades: tradeRows(lane, states.get(lane)!.ledger.snapshot()),
                },
              ])),
              trades: allTrades,
            },
            rowCount: allTrades.length,
          },
          {
            type: "simulation-comparison",
            content: comparison,
            rowCount: selectedLanes.length,
          },
          {
            type: "simulation-provenance",
            content: {
              schemaVersion: AI_SIMULATION_CONTRACT_VERSION,
              market: request.market,
              scannerSnapshotId: input.snapshot.scannerSnapshotId,
              executionLane,
              modelLanes: provenance,
              maintenanceMargin: maintenanceMarginEvidence,
              runtime: CRYPTO_PAPER_RUNTIME_COORDINATOR_REQUIREMENTS,
            },
            rowCount: provenance.length,
          },
          {
            type: "simulation-diagnostics",
            content: {
              schemaVersion: AI_SIMULATION_CONTRACT_VERSION,
              snapshot: terminalSnapshot,
              restoredFinalBars: Math.min(restored.length, MAXIMUM_RESTORED_BARS),
              marketDataHealthy: klineDataHealthy
                && riskStreamFreshness(expiresAt).healthy,
              marketDataBlockReason: entryBlockReason(expiresAt),
              klineDataHealthy,
              klineDataBlockReason,
              riskStreams: riskStreamFreshness(expiresAt),
              marketEventQueue: queue.stats(),
              equitySampling: {
                intervalMs: EQUITY_SAMPLE_INTERVAL_MS,
                maximumSamplesPerLane: MAX_EQUITY_SAMPLES_PER_LANE,
                samplesByLane: Object.fromEntries(selectedLanes.map((lane) => [
                  lane,
                  states.get(lane)!.equity.length,
                ])),
              },
              progressUpdateIntervalMs: PROGRESS_UPDATE_INTERVAL_MS,
              cancellationPollIntervalMs: CANCELLATION_POLL_INTERVAL_MS,
              setupDurationMs: startedAt - setupStartedAt,
              maintenanceMargin: maintenanceMarginEvidence,
              streamDesync: false,
              workerFallbackUsed: false,
              modelFailureMasqueradedAsAnotherLane: false,
              onlyFinalKlinesTriggerInference: true,
              fillRequiresStrictlyLaterEvent: true,
              coordinatorMinimumDeadlineMs:
                cryptoPaperRuntimeMinimumTaskDeadlineMs(request.durationMinutes),
            },
          },
        ],
      };
    } finally {
      closing = true;
      if (subscription) {
        try {
          await subscription.close();
        } catch (error) {
          warnings.push(`stream_close_failed:${error instanceof Error ? error.message : "unknown"}`);
        }
      }
    }
  }

  private async resolveRules(
    symbol: string,
    requiredMaximumNotional: number,
  ): Promise<BinanceInstrumentRules> {
    const rules = typeof this.options.instrumentRules === "function"
      ? await this.options.instrumentRules(symbol, requiredMaximumNotional)
      : this.options.instrumentRules;
    if (rules.symbol !== symbol) {
      throw new CryptoPaperRuntimeError(
        "invalid_runtime_input",
        `Instrument rules ${rules.symbol} do not match selected symbol ${symbol}.`,
      );
    }
    return rules;
  }
}
