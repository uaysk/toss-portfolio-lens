import { createHash } from "node:crypto";
import type { RunTaskContext } from "../services/run-service.js";
import {
  AI_SIMULATION_CONTRACT_VERSION,
  DEFAULT_CRYPTO_FUTURES_RISK_LIMITS,
  type SimulationModelLane,
  type SimulationStartRequest,
} from "../simulation/contracts.js";
import {
  normalizeModelEvidence,
  type EvidenceCostBreakdown,
  type ModelEvidence,
} from "../simulation/model-evidence.js";
import {
  applyConformalScale,
  fitRollingConformalCalibration,
  type ConformalResidual,
} from "../simulation/rolling-conformal-calibration.js";
import {
  CIRCUIT_BREAKER_POLICY_VERSION,
  decideUnifiedSimulationPolicy,
  DYNAMIC_HORIZON_POLICY_VERSION,
  MODEL_ROUTER_POLICY_VERSION,
  POSITION_SIZING_POLICY_VERSION,
  UNIFIED_STRATEGY_POLICY_VERSION,
  VETO_POLICY_VERSION,
  type UnifiedPolicyDecision,
  type UnifiedPolicyState,
} from "../simulation/unified-policy-engine.js";
import {
  SCALPING_AI_HORIZONS,
  SCALPING_AI_QUANTILES,
  SCALPING_AI_REALTIME_HORIZONS,
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
import {
  FinCastMicroCandleAggregator,
  loadFinCastMicroContext,
  type BinanceAggregateTrade,
  type FinCastMicroCandleSeconds,
} from "./fincast-micro-candles.js";
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
  estimatedLiquidationPrice,
  floorToStep,
  FuturesPaperLedger,
  type FuturesPaperLedgerSnapshot,
  type FuturesSide,
} from "./futures-paper-ledger.js";
import {
  PAPER_MAINTENANCE_MARGIN_COVERAGE_MULTIPLIER,
  signalFromQuantileCdf,
  sizeFuturesPosition,
  updateDailyLossGate,
  type DailyLossGateState,
  type QuantileDirectionSignal,
  type ReturnQuantile,
} from "./futures-risk.js";
import {
  detectSimulationChartPatterns,
  type SimulationChartBar,
  type SimulationChartPatternBias,
} from "../simulation/chart-data.js";
import {
  FORECAST_TECHNICAL_FUSION_VERSION,
  fuseForecastWithTechnical,
} from "../simulation/forecast-technical-fusion.js";
import {
  scoreRustIndicatorEvidence,
  type RustIndicatorEvidence,
  type RustMarketEvidenceV2,
} from "../simulation/technical-indicator-evidence.js";
import {
  composeCryptoLiveRustMarketEvidence,
  CRYPTO_RUST_MAX_INPUT_BARS,
  type CryptoLiveRustMarketEvidence,
  type CryptoRustScannerEvidence,
  type CryptoRustTechnicalAnalysis,
  type CryptoRustTechnicalAnalyzer,
} from "./crypto-rust-technical.js";
import {
  CHRONOS2_CONTEXT_BARS,
  DEFAULT_CONTEXT_BARS,
  canonicalCryptoModelInputDigest,
  normalizeLaneForecast,
  type ModelMemoryStatus,
  type ModelPeakVramMeasurement,
  type ModelPrecisionValidation,
  type ModelQuantileMonotonicityPolicy,
  type ModelQuantileObservations,
  type ModelQuantileTailPolicy,
  type NormalizedLaneForecast,
  type PrecisionFailureReason,
} from "./crypto-forecast-normalization.js";
import { AsyncMarketEventQueue as BoundedMarketEventQueue } from "./market-event-queue.js";

export { canonicalCryptoModelInputDigest } from "./crypto-forecast-normalization.js";

const MINUTE_MS = 60_000;
const MAXIMUM_RESTORED_BARS = 1_024;
export const CRYPTO_LOCAL_CHART_PROJECTION_BARS = 240;
export const HIGH_VOL_CRYPTO_INFERENCE_INTERVAL_MS = 5_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_INFERENCE_DEADLINE_MS = 240_000;
const DEFAULT_CIRCUIT_FAILURE_THRESHOLD = 3;
const DEFAULT_CIRCUIT_COOLDOWN_MS = 60_000;
const TERMINAL_SETTLEMENT_GRACE_MS = 125_000;
const TERMINAL_SETTLEMENT_FINALIZATION_RESERVE_MS = 30_000;
const COORDINATOR_SETUP_FINALIZATION_ALLOWANCE_MS = (
  TERMINAL_SETTLEMENT_GRACE_MS + TERMINAL_SETTLEMENT_FINALIZATION_RESERVE_MS
);
const CANCELLATION_POLL_INTERVAL_MS = 1_000;
const PROGRESS_UPDATE_INTERVAL_MS = 5_000;
const EQUITY_SAMPLE_INTERVAL_MS = 5_000;
const MAX_EQUITY_SAMPLES_PER_LANE = 5_000;
const MAX_RUNTIME_FORECAST_OBSERVATIONS_PER_LANE = 12_000;
const MAX_FINAL_KLINE_RISK_EVIDENCE_BUCKETS = 3;
const MAX_FINAL_KLINE_FUNDING_EVIDENCE = 4;
const BOOK_TICKER_FRESHNESS_MS = 15_000;
const MARK_PRICE_FRESHNESS_MS = 5_000;
const SAFE_MODEL_ERROR_CODES = new Set([
  "crypto_lane_sequential_deadline_exceeded",
  "crypto_runtime_expiry_deadline_exceeded",
  "model_call_failed",
  "model_direction_probabilities_invalid",
  "model_distribution_method_invalid",
  "model_distribution_metric_invalid",
  "model_generated_at_invalid",
  "model_generated_before_origin",
  "model_identity_mismatch",
  "model_input_origin_mismatch",
  "model_lane_count_mismatch",
  "model_lane_identity_mismatch",
  "model_memory_status_invalid",
  "model_mode_mismatch",
  "model_native_quantiles_invalid",
  "model_path_count_invalid",
  "model_peak_vram_invalid",
  "model_price_quantiles_invalid",
  "model_price_targets_non_monotone",
  "model_precision_failure_reasons_invalid",
  "model_precision_invalid",
  "model_precision_provenance_invalid",
  "model_precision_validation_invalid",
  "model_provenance_invalid",
  "model_provenance_inconsistent",
  "model_quantile_monotonicity_policy_invalid",
  "model_quantile_observations_invalid",
  "model_quantile_tail_policy_invalid",
  "model_request_id_mismatch",
  "model_response_contract_invalid",
  "model_response_not_object",
  "model_return_quantiles_incomplete",
  "model_return_quantiles_invalid",
  "model_return_quantiles_non_monotone",
  "model_revision_invalid",
  "model_runtime_provenance_invalid",
  "model_series_unavailable",
  "model_target_stop_invalid",
  "model_tokenizer_provenance_invalid",
  "model_unavailable",
  "terminal_settlement_unavailable",
  "worker_circuit_open",
  "worker_unavailable",
]);
const MAXIMUM_PROVENANCE_ERROR_CODES = 20;

type UnknownRecord = Record<string, unknown>;

export const CRYPTO_PAPER_RUNTIME_COORDINATOR_REQUIREMENTS = Object.freeze({
  lifecycle: "event_driven_background_session",
  cancellation: "RunTaskContext.signal + throwIfCancelled + isCancelled",
  requestedDurationDeadlineRequired: true,
  setupFinalizationAllowanceMs: COORDINATOR_SETUP_FINALIZATION_ALLOWANCE_MS,
  terminalSettlementGraceMs: TERMINAL_SETTLEMENT_GRACE_MS,
  terminalSettlementFinalizationReserveMs: TERMINAL_SETTLEMENT_FINALIZATION_RESERVE_MS,
  terminalSettlementNoEventPolicy: "unsettled_fail_closed",
  maximumRestoredOneMinuteBars: MAXIMUM_RESTORED_BARS,
  maximumRustTechnicalOneMinuteBars: CRYPTO_RUST_MAX_INPUT_BARS,
  maximumLocalChartProjectionBars: CRYPTO_LOCAL_CHART_PROJECTION_BARS,
  note: "The coordinator task deadline must cover the requested shadow duration, bounded terminal settlement grace, and setup/finalization. A short generic RunService deadline will abort a valid run.",
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
  rest: Pick<BinanceRestMarketData, "klines">
    & Partial<Pick<BinanceRestMarketData, "aggregateTrades">>;
  streams: CryptoPublicStreams;
  laneClients: Partial<Record<SimulationModelLane, CryptoAiLaneClient>>;
  technicalAnalyzer?: Pick<CryptoRustTechnicalAnalyzer, "analyze">;
  loadCalibrationResiduals?: (input: {
    modelLane: SimulationModelLane;
    symbol: string;
    horizonMinutes: number;
    originAt: string;
  }) => readonly ConformalResidual[];
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

type RuntimeForecastObservation = NormalizedLaneForecast & {
  horizonMinutes: 5 | 15 | 30 | 60;
  displayOriginAt: string;
  inputOriginPrice: number;
  originPrice: number;
  priceObservedAt: string;
  projectionPolicy: "native_input_origin" | "live_price_rebase/v1";
  targetAt: number;
  evaluated: boolean;
  actualReturn?: number;
  resolvedAt?: string;
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
  technicalState?: string;
  chartPatternBias?: SimulationChartPatternBias;
  chartPatterns?: string[];
  chartPatternStrength?: number;
  fusionPolicyVersion?: typeof FORECAST_TECHNICAL_FUSION_VERSION;
  technicalScore?: number;
  technicalDirection?: FuturesSide | "flat";
  exposureScale?: number;
  modelEvidenceScale?: number;
  modelProbabilityMethod?: NormalizedLaneForecast["probabilityMethod"];
  modelVolatilityMethod?: NormalizedLaneForecast["volatilityMethod"];
  modelValidPathCount?: number;
  modelInvalidPathCount?: number;
  technicalOriginAt?: string;
  technicalEngineVersion?: string;
  indicatorEngineVersion?: string;
  technicalScannerEvidence?: CryptoRustScannerEvidence;
  components?: Record<string, number>;
  status: "pending" | "executed" | "held" | "blocked" | "unavailable" | "skipped";
  reason: string;
  requestDigest: string;
  fillId?: string;
  executedAt?: string;
  fillEventKind?: "agg_trade" | "final_kline_open";
  fillIngressSequence?: number;
  fillReceivedAt?: string;
  fillBarrierDigest?: string;
  terminalSettlementFailureReason?: string;
  terminalSettlementOutcome?: "superseded_by_liquidation";
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
  reason?: "signal" | "daily_loss_gate" | "protection" | "terminal_settlement";
  terminalSettlement?: boolean;
  eligibleStreamEpoch?: number;
};

type TerminalSettlementLaneEvidence = {
  lane: SimulationModelLane;
  required: boolean;
  positionAtExpiry?: {
    symbol: string;
    side: FuturesSide;
    quantity: number;
  };
  decisionSource: "not_required" | "runtime_expiry" | "existing_risk_reduce";
  decisionId?: string;
  decisionAt?: string;
  eligibleAfterIngressSequence?: number;
  status: "not_required" | "pending" | "settled" | "unsettled_fail_closed";
  settledBy?: "terminal_reduce" | "liquidation" | "existing_risk_reduce" | "risk_reduce";
  fillId?: string;
  executedAt?: string;
  fillEventKind?: "agg_trade" | "final_kline_open" | "mark_price_liquidation";
  fillIngressSequence?: number;
  fillReceivedAt?: string;
  fillBarrierDigest?: string;
  fillPrice?: number;
  fee?: number;
  exitTax?: number;
  slippage?: number;
  funding?: number;
  realizedPnl?: number;
  remainingQuantity?: number;
  fillCountAtExpiry?: number;
  unavailableReason?: "terminal_settlement_unavailable";
};

type TerminalSettlementEvidence = {
  policy: "causal_reduce_only";
  scheduling: "expiry_boundary_event" | "expiry_timeout";
  decisionAt: string;
  graceDeadlineAt: string;
  graceDurationMs: number;
  decisionStreamEpoch: number;
  settlementComplete: boolean;
  status: "not_required" | "pending" | "settled" | "unsettled_fail_closed";
  barrier: {
    eligibleAfterIngressSequence: number;
    requiresStrictlyLaterIngress: true;
    requiresCausalAtStrictlyAfterExpiry: true;
    receiptTimeTelemetryOnly: true;
    eligibleEventKinds: ["agg_trade", "final_kline_open"];
  };
  boundaryTrigger?: {
    kind: BinanceMarketEvent["kind"];
    ingressSequence: number;
    causalAt: string;
    receivedAt: string;
    observedPrice?: number;
    aggregateTradeId?: string;
    klineOpenTime?: string;
    digest: string;
  };
  fillBarrierEvent?: {
    kind: "agg_trade" | "final_kline_open";
    ingressSequence: number;
    causalAt: string;
    receivedAt: string;
    observedPrice: number;
    aggregateTradeId?: string;
    klineOpenTime?: string;
    digest: string;
  };
  commonFillBarrierDigest?: string;
  candidateEventsObserved: number;
  rejectedAtOrBeforeIngressBarrier: number;
  rejectedAtOrBeforeExpiry: number;
  lanes: TerminalSettlementLaneEvidence[];
};

type LaneState = {
  lane: SimulationModelLane;
  ledger: FuturesPaperLedger;
  riskGeneration: number;
  dailyGate: DailyLossGateState;
  pending?: PendingAction;
  attempts: number;
  successes: number;
  timeoutCount: number;
  latencies: number[];
  peakVramBytes?: number;
  peakVramMeasurement?: ModelPeakVramMeasurement;
  peakVramMb?: number;
  precision: "fp16" | "fp32" | "unknown";
  modelId?: string;
  modelRevision?: string;
  sourceRevision?: string;
  loaderVersion?: string;
  license?: string;
  tokenizerId?: string | null;
  tokenizerRevision?: string | null;
  loaded?: true;
  device?: "cuda";
  deviceName?: string;
  cudaCapability?: "6.1";
  attentionBackend?: "math";
  precisionValidation?: ModelPrecisionValidation;
  memoryStatus?: ModelMemoryStatus;
  quantileMonotonicityPolicy?: ModelQuantileMonotonicityPolicy;
  fp32QuantileObservations?: ModelQuantileObservations;
  mixedQuantileObservations?: ModelQuantileObservations | null;
  quantileTailPolicy?: ModelQuantileTailPolicy;
  precisionFailureReasons?: PrecisionFailureReason[];
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

type RuntimeLaneInferenceOutcome = {
  attemptAt: number;
  forecast?: NormalizedLaneForecast;
  error?: string;
  observedLatency?: number;
  incrementsFailure: boolean;
  timedOut: boolean;
  failureObservedAt?: number;
};

type RuntimeInferenceCompletion = {
  id: number;
  streamEpoch: number;
  bar: BinanceKline;
  bars: BinanceKline[];
  decisionAt: number;
  decisionPrice: number;
  priceObservedAt: number;
  requestDigest: string;
  outcomes: Map<SimulationModelLane, RuntimeLaneInferenceOutcome>;
  riskGenerations: Map<SimulationModelLane, number>;
  decisionSpreadBps: number;
  currentAtr: number;
  currentVolatility: number;
  technicalBars: BinanceKline[];
  rustTechnical?: CryptoRustTechnicalAnalysis;
  rustLiveMarketEvidence?: CryptoLiveRustMarketEvidence;
  rustTechnicalError?: string;
};

type RuntimeRustTechnicalCacheEntry =
  | Readonly<{
    originCloseTime: number;
    status: "available";
    analysis: CryptoRustTechnicalAnalysis;
  }>
  | Readonly<{
    originCloseTime: number;
    status: "failed";
    error: "rust_technical_analysis_failed";
  }>;

type PortfolioDailyLossObservation = DailyLossGateState & {
  closeAllReduceOnly: boolean;
};

export class PortfolioDailyLossGate {
  private readonly equities = new Map<
    SimulationModelLane,
    Map<string, number>
  >();
  private readonly states = new Map<SimulationModelLane, DailyLossGateState>();

  constructor(input: {
    lanes: readonly SimulationModelLane[];
    symbols: readonly string[];
    perSymbolInitialCash: number;
    dailyLossLimitRate: number;
    observedAt: number;
  }) {
    for (const lane of input.lanes) {
      this.equities.set(lane, new Map(
        input.symbols.map((symbol) => [symbol, input.perSymbolInitialCash]),
      ));
      this.states.set(lane, updateDailyLossGate(
        undefined,
        input.perSymbolInitialCash * input.symbols.length,
        input.observedAt,
        input.dailyLossLimitRate,
      ));
    }
  }

  state(lane: SimulationModelLane): DailyLossGateState {
    const state = this.states.get(lane);
    if (!state) throw new Error(`portfolio_daily_loss_lane_unavailable:${lane}`);
    return state;
  }

  observe(input: {
    lane: SimulationModelLane;
    symbol: string;
    equity: number;
    observedAt: number;
    dailyLossLimitRate: number;
  }): PortfolioDailyLossObservation {
    const laneEquities = this.equities.get(input.lane);
    if (!laneEquities || !laneEquities.has(input.symbol)) {
      throw new Error(`portfolio_daily_loss_symbol_unavailable:${input.symbol}`);
    }
    laneEquities.set(input.symbol, input.equity);
    const portfolioEquity = [...laneEquities.values()]
      .reduce((sum, equity) => sum + equity, 0);
    const next = updateDailyLossGate(
      this.states.get(input.lane),
      portfolioEquity,
      input.observedAt,
      input.dailyLossLimitRate,
    );
    this.states.set(input.lane, next);
    return next;
  }
}

type RuntimeEquityPoint = {
  timestamp: string;
  equity: number;
  drawdown: number;
};

const MODEL_METRIC_AGGREGATION_SCHEMA_VERSION = "crypto-model-metric-aggregation/v1";

type ModelMetricAggregationBasis = {
  schemaVersion: typeof MODEL_METRIC_AGGREGATION_SCHEMA_VERSION;
  prediction: {
    pinballLossSum: number;
    pinballLossCount: number;
    medianAbsoluteErrorSum: number;
    medianAbsoluteErrorCount: number;
    directionHitSum: number;
    directionCount: number;
    coverageHitSum: number;
    coverageCount: number;
    nominalCoverageSum: number;
    nominalCoverageCount: number;
  };
  trading: {
    netPnl: number;
    grossProfit: number;
    grossLoss: number;
    winCount: number;
    outcomeCount: number;
    turnoverNotional: number;
    initialCash: number;
    funding: number;
    fees: number;
    leverageDistribution: number[];
  };
  operations: {
    attempts: number;
    successes: number;
    latencySum: number;
    latencyCount: number;
    timeoutCount: number;
    peakVramMb?: number;
  };
  equity: RuntimeEquityPoint[];
};

type PortfolioMetricAggregationResult = {
  consistent: boolean;
  metrics: Record<string, unknown>;
};

function aggregateEquityPartitions(
  partitions: readonly {
    series: readonly RuntimeEquityPoint[];
    initialCash: number;
  }[],
): {
  points: RuntimeEquityPoint[];
  maximumDrawdown: number;
} {
  if (partitions.some(({ initialCash }) => (
    !Number.isFinite(initialCash) || initialCash <= 0
  ))) {
    throw new Error("portfolio_equity_initial_cash_invalid");
  }
  const normalized = partitions.map(({ series, initialCash }) => ({
    initialCash,
    series: series
      .filter((point) => (
        Number.isFinite(Date.parse(point.timestamp))
        && Number.isFinite(point.equity)
      ))
      .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp)),
  }));
  const timestamps = [...new Set(normalized.flatMap(({ series }) => (
    series.map((point) => Date.parse(point.timestamp))
  )))].sort((left, right) => left - right);
  const indices = normalized.map(() => 0);
  const latestEquities = normalized.map(({ initialCash }) => initialCash);
  const output: RuntimeEquityPoint[] = [];
  let peak = latestEquities.reduce((sum, value) => sum + value, 0);
  let maximumDrawdown = 0;
  for (const timestamp of timestamps) {
    for (let index = 0; index < normalized.length; index += 1) {
      const series = normalized[index]!.series;
      while (indices[index]! < series.length
        && Date.parse(series[indices[index]!]!.timestamp) <= timestamp) {
        latestEquities[index] = series[indices[index]!]!.equity;
        indices[index] += 1;
      }
    }
    const equity = latestEquities.reduce((sum, value) => sum + value, 0);
    peak = Math.max(peak, equity);
    const drawdown = peak > 0 ? Math.max(0, (peak - equity) / peak) : 0;
    maximumDrawdown = Math.max(maximumDrawdown, drawdown);
    const point = {
      timestamp: iso(timestamp),
      equity,
      drawdown,
    };
    if (output.length < MAX_EQUITY_SAMPLES_PER_LANE) output.push(point);
    else output[output.length - 1] = point;
  }
  return {
    points: output,
    maximumDrawdown,
  };
}

export function aggregatePortfolioEquitySeries(
  seriesBySymbol: readonly (readonly RuntimeEquityPoint[])[],
  perSymbolInitialCash: number,
): RuntimeEquityPoint[] {
  if (!Number.isFinite(perSymbolInitialCash) || perSymbolInitialCash <= 0) {
    throw new Error("portfolio_equity_initial_cash_invalid");
  }
  return aggregateEquityPartitions(seriesBySymbol.map((series) => ({
    series,
    initialCash: perSymbolInitialCash,
  }))).points;
}

export function groupPortfolioRuntimeArtifacts(
  results: readonly CryptoSimulationRuntimeResult[],
): Array<{
  type: NonNullable<CryptoSimulationRuntimeResult["artifacts"]>[number]["type"];
  contents: unknown[];
  rowCount: number;
}> {
  const grouped = new Map<string, {
    type: NonNullable<CryptoSimulationRuntimeResult["artifacts"]>[number]["type"];
    contents: unknown[];
    rowCount: number;
  }>();
  for (const result of results) {
    for (const artifact of result.artifacts ?? []) {
      const current = grouped.get(artifact.type) ?? {
        type: artifact.type,
        contents: [],
        rowCount: 0,
      };
      current.contents.push(artifact.content);
      current.rowCount += artifact.rowCount ?? 1;
      grouped.set(artifact.type, current);
    }
  }
  return [...grouped.values()];
}

export function aggregatePortfolioLaneProvenance(
  laneValues: readonly Record<string, unknown>[],
  expectedSymbolCount: number,
): {
  consistent: boolean;
  provenance?: Record<string, unknown>;
} {
  const provenances = laneValues.flatMap((value) => {
    const provenance = record(first(value, "provenance"));
    return provenance ? [provenance] : [];
  });
  const representative = provenances[0];
  const representativeDigest = representative ? digest(representative) : undefined;
  const consistent = laneValues.length === expectedSymbolCount
    && provenances.length === expectedSymbolCount
    && representativeDigest !== undefined
    && provenances.every((provenance) => digest(provenance) === representativeDigest);
  return {
    consistent,
    ...(representative ? { provenance: structuredClone(representative) } : {}),
  };
}

function requiredBasisNumber(
  source: UnknownRecord | undefined,
  key: string,
): number | undefined {
  const value = source?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function requiredBasisCount(
  source: UnknownRecord | undefined,
  key: string,
): number | undefined {
  const value = requiredBasisNumber(source, key);
  return value !== undefined && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function parseModelMetricAggregationBasis(
  value: unknown,
): ModelMetricAggregationBasis | undefined {
  const source = record(value);
  if (source?.schemaVersion !== MODEL_METRIC_AGGREGATION_SCHEMA_VERSION) return undefined;
  const prediction = record(source.prediction);
  const trading = record(source.trading);
  const operations = record(source.operations);
  const predictionValues = {
    pinballLossSum: requiredBasisNumber(prediction, "pinballLossSum"),
    pinballLossCount: requiredBasisCount(prediction, "pinballLossCount"),
    medianAbsoluteErrorSum: requiredBasisNumber(prediction, "medianAbsoluteErrorSum"),
    medianAbsoluteErrorCount: requiredBasisCount(prediction, "medianAbsoluteErrorCount"),
    directionHitSum: requiredBasisNumber(prediction, "directionHitSum"),
    directionCount: requiredBasisCount(prediction, "directionCount"),
    coverageHitSum: requiredBasisNumber(prediction, "coverageHitSum"),
    coverageCount: requiredBasisCount(prediction, "coverageCount"),
    nominalCoverageSum: requiredBasisNumber(prediction, "nominalCoverageSum"),
    nominalCoverageCount: requiredBasisCount(prediction, "nominalCoverageCount"),
  };
  const tradingValues = {
    netPnl: requiredBasisNumber(trading, "netPnl"),
    grossProfit: requiredBasisNumber(trading, "grossProfit"),
    grossLoss: requiredBasisNumber(trading, "grossLoss"),
    winCount: requiredBasisCount(trading, "winCount"),
    outcomeCount: requiredBasisCount(trading, "outcomeCount"),
    turnoverNotional: requiredBasisNumber(trading, "turnoverNotional"),
    initialCash: requiredBasisNumber(trading, "initialCash"),
    funding: requiredBasisNumber(trading, "funding"),
    fees: requiredBasisNumber(trading, "fees"),
  };
  const operationValues = {
    attempts: requiredBasisCount(operations, "attempts"),
    successes: requiredBasisCount(operations, "successes"),
    latencySum: requiredBasisNumber(operations, "latencySum"),
    latencyCount: requiredBasisCount(operations, "latencyCount"),
    timeoutCount: requiredBasisCount(operations, "timeoutCount"),
  };
  if ([
    ...Object.values(predictionValues),
    ...Object.values(tradingValues),
    ...Object.values(operationValues),
  ].some((candidate) => candidate === undefined)) return undefined;
  if (
    tradingValues.initialCash! <= 0
    || tradingValues.grossProfit! < 0
    || tradingValues.grossLoss! < 0
    || tradingValues.turnoverNotional! < 0
    || tradingValues.winCount! > tradingValues.outcomeCount!
    || operationValues.successes! > operationValues.attempts!
  ) return undefined;
  const rawLeverages = trading?.leverageDistribution;
  if (!Array.isArray(rawLeverages) || rawLeverages.some((candidate) => (
    typeof candidate !== "number" || !Number.isFinite(candidate) || candidate <= 0
  ))) return undefined;
  const rawEquity = source.equity;
  if (!Array.isArray(rawEquity)) return undefined;
  const equity = rawEquity.flatMap((candidate): RuntimeEquityPoint[] => {
    const point = record(candidate);
    const timestamp = exactText(point?.timestamp);
    const equityValue = requiredBasisNumber(point, "equity");
    const drawdown = requiredBasisNumber(point, "drawdown");
    return timestamp !== undefined
      && Number.isFinite(Date.parse(timestamp))
      && equityValue !== undefined
      && drawdown !== undefined
      ? [{
        timestamp,
        equity: equityValue,
        drawdown,
      }]
      : [];
  });
  if (equity.length !== rawEquity.length) return undefined;
  const peakVramMb = operations?.peakVramMb === undefined
    ? undefined
    : requiredBasisNumber(operations, "peakVramMb");
  if (operations?.peakVramMb !== undefined
    && (peakVramMb === undefined || peakVramMb < 0)) return undefined;
  return {
    schemaVersion: MODEL_METRIC_AGGREGATION_SCHEMA_VERSION,
    prediction: predictionValues as ModelMetricAggregationBasis["prediction"],
    trading: {
      ...tradingValues as Omit<
        ModelMetricAggregationBasis["trading"],
        "leverageDistribution"
      >,
      leverageDistribution: [...rawLeverages],
    },
    operations: {
      ...operationValues as Omit<
        ModelMetricAggregationBasis["operations"],
        "peakVramMb"
      >,
      ...(peakVramMb !== undefined ? { peakVramMb } : {}),
    },
    equity,
  };
}

export function aggregatePortfolioLaneMetrics(
  laneValues: readonly Record<string, unknown>[],
  expectedSymbolCount: number,
): PortfolioMetricAggregationResult {
  if (!Number.isSafeInteger(expectedSymbolCount) || expectedSymbolCount < 1) {
    return { consistent: false, metrics: {} };
  }
  const bases = laneValues.flatMap((value) => {
    const basis = parseModelMetricAggregationBasis(value.aggregationBasis);
    return basis ? [basis] : [];
  });
  if (laneValues.length !== expectedSymbolCount || bases.length !== expectedSymbolCount) {
    return { consistent: false, metrics: {} };
  }
  const sum = (select: (basis: ModelMetricAggregationBasis) => number): number => (
    bases.reduce((total, basis) => total + select(basis), 0)
  );
  const ratio = (
    numerator: (basis: ModelMetricAggregationBasis) => number,
    denominator: (basis: ModelMetricAggregationBasis) => number,
  ): number | undefined => {
    const totalCount = sum(denominator);
    return totalCount > 0 ? sum(numerator) / totalCount : undefined;
  };
  const grossProfit = sum((basis) => basis.trading.grossProfit);
  const grossLoss = sum((basis) => basis.trading.grossLoss);
  const totalInitialCash = sum((basis) => basis.trading.initialCash);
  const actualCoverage = ratio(
    (basis) => basis.prediction.coverageHitSum,
    (basis) => basis.prediction.coverageCount,
  );
  const nominalCoverage = ratio(
    (basis) => basis.prediction.nominalCoverageSum,
    (basis) => basis.prediction.nominalCoverageCount,
  );
  const portfolioEquity = aggregateEquityPartitions(bases.map((basis) => ({
    series: basis.equity,
    initialCash: basis.trading.initialCash,
  })));
  const metrics: Record<string, unknown> = {
    netPnl: sum((basis) => basis.trading.netPnl),
    maxDrawdown: portfolioEquity.maximumDrawdown,
    turnover: sum((basis) => basis.trading.turnoverNotional) / totalInitialCash,
    funding: sum((basis) => basis.trading.funding),
    fees: sum((basis) => basis.trading.fees),
    availabilityRatio: ratio(
      (basis) => basis.operations.successes,
      (basis) => basis.operations.attempts,
    ) ?? 0,
    timeoutCount: sum((basis) => basis.operations.timeoutCount),
    leverageDistribution: bases.flatMap(
      (basis) => basis.trading.leverageDistribution,
    ),
  };
  const optionalMetrics = {
    pinballLoss: ratio(
      (basis) => basis.prediction.pinballLossSum,
      (basis) => basis.prediction.pinballLossCount,
    ),
    medianReturnMae: ratio(
      (basis) => basis.prediction.medianAbsoluteErrorSum,
      (basis) => basis.prediction.medianAbsoluteErrorCount,
    ),
    directionAccuracy: ratio(
      (basis) => basis.prediction.directionHitSum,
      (basis) => basis.prediction.directionCount,
    ),
    quantileCoverage: actualCoverage,
    calibrationError: actualCoverage !== undefined && nominalCoverage !== undefined
      ? Math.abs(actualCoverage - nominalCoverage)
      : undefined,
    profitFactor: grossLoss > 0
      ? grossProfit / grossLoss
      : grossProfit > 0
        ? null
        : undefined,
    winRate: ratio(
      (basis) => basis.trading.winCount,
      (basis) => basis.trading.outcomeCount,
    ),
    latencyMs: ratio(
      (basis) => basis.operations.latencySum,
      (basis) => basis.operations.latencyCount,
    ),
    peakVramMb: bases.flatMap((basis) => (
      basis.operations.peakVramMb === undefined
        ? []
        : [basis.operations.peakVramMb]
    )).reduce<number | undefined>((maximum, value) => (
      maximum === undefined ? value : Math.max(maximum, value)
    ), undefined),
  };
  for (const [key, value] of Object.entries(optionalMetrics)) {
    if (value !== undefined) metrics[key] = value;
  }
  return {
    consistent: true,
    metrics,
  };
}

export type CryptoPaperRuntimeSnapshot = {
  schemaVersion: typeof AI_SIMULATION_CONTRACT_VERSION;
  simulationCase: SimulationStartRequest["simulationCase"];
  resolvedModelPlan: SimulationStartRequest["resolvedModelPlan"];
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
  policyProfile: CryptoFuturesPolicyProfile;
  selected: unknown[];
  positions: unknown[];
  futuresPositions: unknown[];
  futuresRisk: {
    dailyLossRatio: number;
    dailyLossLimitRatio: number;
    newEntriesBlocked: boolean;
    blockReason?: string;
    grossExposureRatio: number;
    grossExposureLimitRatio: number;
    marginUsageRatio: number;
    marginUsageLimitRatio: number;
    riskPerTradeRatio: number;
    maximumLeverage: number;
    liquidationBufferMultiple: number;
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
  unifiedPolicyDecisions: UnifiedPolicyDecision[];
  modelEvidence: ModelEvidence[];
  rustMarketEvidence: CryptoLiveRustMarketEvidence[];
  modelForecasts: unknown[];
  warnings: string[];
  capabilities: Record<string, boolean | number | string>;
  modelLanes: SimulationModelLane[];
  executionMode: "paper";
  executionLane: SimulationModelLane;
  modelComparison: unknown;
  terminalSettlement?: TerminalSettlementEvidence;
  decisionCadence: {
    trigger: "final_binance_1m_kline"
      | "final_fincast_30s_aggtrade_bar"
      | "final_fincast_15s_aggtrade_bar"
      | "high_vol_live_5s";
    modelCandleSeconds: 15 | 30 | 60;
    inferenceIntervalSeconds: 5 | 15 | 30 | 60;
    triggeredEvents: number;
    coalescedFinalKlines: number;
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

function exactText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function nullableExactText(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  return exactText(value);
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

function cryptoRuntimeScope(runId: string, symbol: string): string {
  return createHash("sha256")
    .update(runId, "utf8")
    .update("\0", "utf8")
    .update(symbol, "utf8")
    .digest("hex")
    .slice(0, 16);
}

type CryptoRuntimeIdentifierInput = {
  runId: string;
  symbol: string;
  lane: SimulationModelLane;
  at: number;
  sequence: number;
};

function assertCryptoRuntimeIdentifierInput(
  input: CryptoRuntimeIdentifierInput,
): void {
  if (
    !input.runId
    || !input.symbol
    || !Number.isSafeInteger(input.at)
    || input.at < 0
    || !Number.isSafeInteger(input.sequence)
    || input.sequence < 1
  ) {
    throw new Error("crypto_runtime_identifier_input_invalid");
  }
}

export function cryptoRuntimeEntityId(
  kind: "decision" | "fill",
  input: CryptoRuntimeIdentifierInput,
): string {
  assertCryptoRuntimeIdentifierInput(input);
  const lane = input.lane === "chronos2" ? "c2" : "f";
  return [
    kind,
    cryptoRuntimeScope(input.runId, input.symbol),
    lane,
    input.at.toString(36),
    input.sequence.toString(36),
  ].join(":");
}

export function cryptoRuntimeClientOrderId(
  input: CryptoRuntimeIdentifierInput & {
    action: "open" | "reduce";
  },
): string {
  assertCryptoRuntimeIdentifierInput(input);
  const lane = input.lane === "chronos2" ? "c2" : "f";
  const action = input.action === "open" ? "o" : "r";
  const uniqueComponent = createHash("sha256")
    .update([
      input.runId,
      input.symbol,
      input.lane,
      input.action,
      String(input.at),
      String(input.sequence),
    ].join("\0"), "utf8")
    .digest("hex")
    .slice(0, 12);
  const clientOrderId = [
    "ps",
    cryptoRuntimeScope(input.runId, input.symbol),
    `${lane}${action}`,
    uniqueComponent,
  ].join("-");
  if (
    clientOrderId.length > 36
    || !/^[.A-Z:/a-z0-9_-]+$/.test(clientOrderId)
  ) {
    throw new Error("crypto_runtime_client_order_id_invalid");
  }
  return clientOrderId;
}

export function cryptoModelForecastIsFresh(input: {
  inputEndAt: string;
  targetTimestamps: readonly string[];
  latestFinalCandleCloseTime?: number;
  maximumInputLagMs?: number;
}): boolean {
  const inputEndAt = Date.parse(input.inputEndAt);
  const latestFinalCandleCloseTime = input.latestFinalCandleCloseTime;
  const maximumInputLagMs = Math.max(0, input.maximumInputLagMs ?? 0);
  if (
    !Number.isFinite(inputEndAt)
    || latestFinalCandleCloseTime === undefined
    || !Number.isSafeInteger(latestFinalCandleCloseTime)
    || inputEndAt > latestFinalCandleCloseTime
    || latestFinalCandleCloseTime - inputEndAt > maximumInputLagMs
  ) return false;
  return input.targetTimestamps.some((candidate) => {
    const target = Date.parse(candidate);
    return Number.isFinite(target) && target > latestFinalCandleCloseTime;
  });
}

function unique(values: readonly string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function safeModelErrorCode(value: unknown): string {
  const candidate = text(value);
  return candidate && SAFE_MODEL_ERROR_CODES.has(candidate)
    ? candidate
    : "model_call_failed";
}

function safeProvenanceErrorCodes(values: readonly string[]): string[] {
  return unique(values.map(safeModelErrorCode)).slice(-MAXIMUM_PROVENANCE_ERROR_CODES);
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

function eventPrice(event: BinanceMarketEvent): number | undefined {
  if (event.kind === "agg_trade") return event.price;
  if (event.kind === "mark_price") return event.markPrice;
  if (event.kind === "kline" && event.final) return event.close;
  return undefined;
}

function terminalCausalAt(event: BinanceMarketEvent): number | undefined {
  if (event.kind === "agg_trade") return event.executedAt;
  if (event.kind === "kline") return event.final ? event.openTime : undefined;
  return event.eventTime;
}

function terminalObservedPrice(event: BinanceMarketEvent): number | undefined {
  if (event.kind === "agg_trade") return event.price;
  if (event.kind === "kline") return event.final ? event.open : undefined;
  if (event.kind === "mark_price") return event.markPrice;
  return (event.bidPrice + event.askPrice) / 2;
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

type CryptoFuturesPolicyProfile = {
  preset: SimulationStartRequest["preset"];
  riskTolerance: number;
  minimumConfidence: number;
  maximumLeverage: number;
  targetAllocationRate: number;
  cashReserveRate: number;
  technicalConfirmationRequired: boolean;
};

function cryptoFuturesPolicyProfile(
  request: Pick<SimulationStartRequest, "preset" | "riskTolerance">,
): CryptoFuturesPolicyProfile {
  const riskRatio = request.riskTolerance / 100;
  const preset = {
    trend: { confidence: 0.52, maximumLeverage: 10, recommendedRisk: 60, confirmationUntil: 65 },
    breakout: { confidence: 0.49, maximumLeverage: 15, recommendedRisk: 100, confirmationUntil: 45 },
    mean_reversion: { confidence: 0.56, maximumLeverage: 8, recommendedRisk: 50, confirmationUntil: 75 },
    risk_management: { confidence: 0.62, maximumLeverage: 5, recommendedRisk: 25, confirmationUntil: -1 },
  }[request.preset];
  const targetAllocationRate = Math.max(
    0.2,
    Math.min(1, 0.5 + request.riskTolerance / preset.recommendedRisk * 0.5),
  );
  return {
    preset: request.preset,
    riskTolerance: request.riskTolerance,
    minimumConfidence: Math.max(0.45, preset.confidence - riskRatio * 0.08),
    maximumLeverage: Math.max(
      1,
      Math.min(preset.maximumLeverage, Math.round(1 + riskRatio * 14)),
    ),
    targetAllocationRate,
    cashReserveRate: 1 - targetAllocationRate,
    technicalConfirmationRequired: request.riskTolerance <= preset.confirmationUntil,
  };
}

function exponentialMovingAverage(values: readonly number[], period: number): number[] {
  const alpha = 2 / (period + 1);
  const output: number[] = [];
  for (const value of values) {
    output.push(output.length ? output.at(-1)! + alpha * (value - output.at(-1)!) : value);
  }
  return output;
}

function rollingRsi(values: readonly number[], index: number, period = 14): number | undefined {
  if (index < period) return undefined;
  let gains = 0;
  let losses = 0;
  for (let cursor = index - period + 1; cursor <= index; cursor += 1) {
    const change = values[cursor]! - values[cursor - 1]!;
    if (change >= 0) gains += change;
    else losses -= change;
  }
  if (losses === 0) return gains > 0 ? 100 : 50;
  const relativeStrength = gains / losses;
  return 100 - 100 / (1 + relativeStrength);
}

export type CryptoChartProjection = {
  bars: SimulationChartBar[];
  indicators: Array<{
    id: string;
    kind: string;
    status: "available" | "unavailable";
    values: Record<string, number>;
  }>;
  patterns: ReturnType<typeof detectSimulationChartPatterns>;
};

export function cryptoChartProjection(
  sourceBars: readonly BinanceKline[],
): CryptoChartProjection {
  // Pattern detection contains rolling window work. Keep its causal input
  // independent from the much longer Rust scanner history so seven days of
  // one-minute bars cannot turn a decision into quadratic local work.
  const bars = sourceBars.slice(-CRYPTO_LOCAL_CHART_PROJECTION_BARS);
  const closes = bars.map((bar) => bar.close);
  const ema9 = exponentialMovingAverage(closes, 9);
  const ema21 = exponentialMovingAverage(closes, 21);
  const projection = bars.map((bar, index): SimulationChartBar => {
    const indicatorValues: Record<string, number> = {
      "trend-ema-fast:value": ema9[index]!,
      "trend-ema-slow:value": ema21[index]!,
    };
    const rsi = rollingRsi(closes, index);
    if (rsi !== undefined) indicatorValues["momentum-rsi:value"] = rsi;
    const window = bars.slice(Math.max(0, index - 19), index + 1);
    if (window.length === 20) {
      const mean = window.reduce((sum, item) => sum + item.close, 0) / window.length;
      const variance = window.reduce((sum, item) => sum + (item.close - mean) ** 2, 0)
        / window.length;
      const deviation = Math.sqrt(variance);
      indicatorValues["mean-bollinger:middle"] = mean;
      indicatorValues["mean-bollinger:upper"] = mean + deviation * 2;
      indicatorValues["mean-bollinger:lower"] = mean - deviation * 2;
      indicatorValues["breakout-donchian:upper"] = Math.max(...window.map((item) => item.high));
      indicatorValues["breakout-donchian:lower"] = Math.min(...window.map((item) => item.low));
    }
    const atr = atr14(bars.slice(0, index + 1));
    if (atr > 0) indicatorValues["risk-atr:value"] = atr;
    return {
      timestamp: iso(bar.closeTime),
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: bar.volume,
      status: bar.final ? "final" : "forming",
      indicatorValues,
    };
  });
  const latest = projection.at(-1)?.indicatorValues ?? {};
  const indicator = (
    id: string,
    kind: string,
    fields: readonly string[],
  ) => {
    const values = Object.fromEntries(fields.flatMap((field) => {
      const value = latest[`${id}:${field}`];
      return value === undefined ? [] : [[field, value]];
    }));
    return {
      id,
      kind,
      status: Object.keys(values).length ? "available" as const : "unavailable" as const,
      values,
    };
  };
  return {
    bars: projection,
    indicators: [
      indicator("trend-ema-fast", "ema", ["value"]),
      indicator("trend-ema-slow", "ema", ["value"]),
      indicator("momentum-rsi", "rsi", ["value"]),
      indicator("mean-bollinger", "bollinger_bands", ["upper", "middle", "lower"]),
      indicator("breakout-donchian", "donchian_channel", ["upper", "lower"]),
      indicator("risk-atr", "atr", ["value"]),
    ],
    patterns: detectSimulationChartPatterns(projection),
  };
}

function cryptoTechnicalObservation(
  bars: readonly BinanceKline[],
  preset: SimulationStartRequest["preset"],
  rust?: CryptoRustTechnicalAnalysis,
  rustError?: string,
): {
  state: string;
  direction: FuturesSide | "flat";
  directionalSignal: -1 | 0 | 1;
  chartPatternBias: SimulationChartPatternBias;
  chartPatterns: string[];
  chartPatternStrength: number;
  indicators: RustIndicatorEvidence;
  originAt?: string;
  calculationAt?: string;
  eligibleAfter?: string;
  quality: "good" | "partial" | "stale" | "unavailable";
  confidence?: number;
  multiTimeframeAgreement?: string;
  scalpingEngineVersion?: string;
  indicatorEngineVersion?: string;
  scannerEvidence?: CryptoRustScannerEvidence;
  components: Record<string, number>;
} {
  const localBars = bars.slice(-CRYPTO_LOCAL_CHART_PROJECTION_BARS);
  const chart = cryptoChartProjection(localBars);
  const latest = chart.bars.at(-1);
  let direction: FuturesSide | "flat" = "flat";
  const latestAt = latest?.timestamp;
  // Chart indicators and candlestick patterns are projection-only. Trading
  // direction and risk evidence must come from the Rust analyzer.
  const localIndicators = scoreRustIndicatorEvidence({
    indicators: [],
    preset,
    currentPrice: latest?.close ?? 0,
  });
  const rustIndicators = rust
    ? scoreRustIndicatorEvidence({
        indicators: rust.calculations,
        preset,
        currentPrice: latest?.close ?? rust.basisPrice,
        ...(latest?.volume === undefined ? {} : { currentVolume: latest.volume }),
        scannerEvidence: rust.scannerEvidence,
      })
    : undefined;
  const directionalScore = rustIndicators?.directionalScore;
  const directionalSignal = rust?.technicalSignal ?? 0;
  if (directionalScore !== undefined || rust) {
    const combinedScore = (directionalScore ?? 0) * 0.75 + directionalSignal * 0.25;
    direction = combinedScore >= 0.15
      ? "long"
      : combinedScore <= -0.15 ? "short" : "flat";
  }
  const rustQualityStatus = rust?.quality.status.toLowerCase();
  const quality = rustError
    ? "unavailable" as const
    : !rust
      ? "unavailable" as const
      : rustQualityStatus?.includes("stale")
        ? "stale" as const
        : rustQualityStatus && ["unavailable", "invalid", "failed", "error"].some(
            (token) => rustQualityStatus.includes(token),
          )
          ? "unavailable" as const
          : rust.quality.sameSessionGapCount > 0
            || rust.quality.missingVolumeCount > 0
            || rust.quality.missingAmountCount > 0
            || rustQualityStatus?.includes("partial")
            ? "partial" as const
            : "good" as const;
  return {
    state: rust ? `${preset}:${direction}:${rust.status}` : `${preset}:${direction}`,
    direction,
    directionalSignal,
    chartPatternBias: "neutral",
    chartPatterns: [],
    chartPatternStrength: 0,
    indicators: rustIndicators ?? localIndicators,
    ...(rust?.originAt ?? latestAt ? { originAt: rust?.originAt ?? latestAt } : {}),
    ...(rust?.calculationAt ?? latestAt
      ? { calculationAt: rust?.calculationAt ?? latestAt } : {}),
    ...(rust?.earliestEligibleAt ? { eligibleAfter: rust.earliestEligibleAt } : {}),
    quality,
    ...(rust ? {
      confidence: rust.confidence,
      multiTimeframeAgreement: rust.multiTimeframeAgreement,
      scalpingEngineVersion: rust.scalpingEngineVersion,
      indicatorEngineVersion: rust.indicatorEngineVersion,
      scannerEvidence: rust.scannerEvidence,
    } : {}),
    components: {
      ...(rustIndicators ? {
        rustDirectionalScore: rustIndicators.directionalScore,
        rustRiskScale: rustIndicators.riskScale,
        rustIndicatorCount: rustIndicators.availableIndicatorCount,
        ...Object.fromEntries(Object.entries(rustIndicators.components).filter(
          ([key]) => key.startsWith("scanner:"),
        )),
      } : {}),
    },
  };
}

function hasContinuousFinalContext(
  bars: readonly BinanceKline[],
  requiredBars: number,
  expectedIntervalMs = MINUTE_MS,
): boolean {
  const context = bars.slice(-requiredBars);
  if (context.length !== requiredBars || context.some((bar) => !bar.final)) return false;
  for (let index = 1; index < context.length; index += 1) {
    if (context[index]!.openTime - context[index - 1]!.openTime !== expectedIntervalMs) {
      return false;
    }
  }
  return true;
}

function futureTimestamps(
  inputEndAt: number,
  steps: 15 | 60,
): AiForecastRequest["series"][number]["future_timestamps"] {
  const values = Array.from(
    { length: steps },
    (_, index) => iso(inputEndAt + (index + 1) * MINUTE_MS),
  );
  return values as AiForecastRequest["series"][number]["future_timestamps"];
}

function aiRequest(
  runId: string,
  symbol: string,
  bars: readonly BinanceKline[],
  targetStop: AiForecastRequest["series"][number]["target_stop"] = null,
  fullHorizon = false,
  requestDiscriminator?: number,
): AiForecastRequest {
  const safeRunId = runId.replaceAll(/[^A-Za-z0-9._:-]/g, "-").slice(0, 48) || "run";
  const final = bars.at(-1);
  if (!final) throw new Error("A final Binance bar is required for inference.");
  const inputEndAt = final.closeTime;
  return {
    schema_version: SCALPING_AI_SCHEMA_VERSION,
    request_id: [
      "crypto",
      safeRunId,
      inputEndAt,
      ...(requestDiscriminator === undefined ? [] : [requestDiscriminator]),
    ].join(":").slice(0, 128),
    mode: "forecast",
    forecast_profile: fullHorizon ? "full" : "realtime_5_15",
    horizons_minutes: fullHorizon
      ? [...SCALPING_AI_HORIZONS]
      : [...SCALPING_AI_REALTIME_HORIZONS],
    quantiles: [...SCALPING_AI_QUANTILES],
    seed: 0,
    series: [{
      instrument_key: symbol,
      timezone: "UTC",
      input_end_at: iso(inputEndAt),
      future_timestamps: futureTimestamps(inputEndAt, fullHorizon ? 60 : 15),
      bars: bars.map((bar) => ({
        timestamp: iso(bar.closeTime),
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume,
        amount: bar.quoteVolume,
        trade_count: bar.tradeCount,
        taker_buy_volume: bar.takerBuyVolume ?? null,
        taker_buy_amount: bar.takerBuyQuoteVolume ?? null,
        complete: true as const,
      })),
      target_stop: targetStop,
    }],
  };
}

export function cryptoModelContextForLane(
  lane: SimulationModelLane,
  bars: readonly BinanceKline[],
): BinanceKline[] {
  return bars.slice(
    -(lane === "chronos2" ? CHRONOS2_CONTEXT_BARS : DEFAULT_CONTEXT_BARS),
  );
}

export function rebaseCryptoReturnQuantiles(
  quantiles: readonly ReturnQuantile[],
  inputOriginPrice: number,
  decisionPrice: number,
): ReturnQuantile[] {
  if (!Number.isFinite(inputOriginPrice) || inputOriginPrice <= 0
    || !Number.isFinite(decisionPrice) || decisionPrice <= 0) {
    throw new Error("crypto_live_rebase_price_invalid");
  }
  return quantiles.map((item) => ({
    quantile: item.quantile,
    returnRate: inputOriginPrice * (1 + item.returnRate) / decisionPrice - 1,
  }));
}

function rebaseLaneForecastToLivePrice(
  forecast: NormalizedLaneForecast,
  inputOriginPrice: number,
  decisionPrice: number,
  realizedVolatilityRate: number,
  spreadBps: number,
): NormalizedLaneForecast {
  const horizonDistributions = forecast.horizonDistributions.map((distribution) => {
    const quantiles = rebaseCryptoReturnQuantiles(
      distribution.quantiles,
      inputOriginPrice,
      decisionPrice,
    );
    const nativeQuantiles = rebaseCryptoReturnQuantiles(
      distribution.nativeQuantiles,
      inputOriginPrice,
      decisionPrice,
    );
    const signal = signalFromQuantileCdf({
      quantiles,
      roundTripCostRate: 0,
      realizedVolatilityRate,
      spreadBps,
      mode: "paper",
    });
    return {
      ...distribution,
      quantiles,
      nativeQuantiles,
      upProbability: signal.probabilityAboveCost,
      downProbability: signal.probabilityBelowNegativeCost,
      flatProbability: Math.max(
        0,
        1 - signal.probabilityAboveCost - signal.probabilityBelowNegativeCost,
      ),
      intervalWidth: quantiles.at(-1)!.returnRate - quantiles[0]!.returnRate,
    };
  });
  const primary = horizonDistributions.find(
    (distribution) => distribution.horizonMinutes === SCALPING_AI_HORIZONS[0],
  ) ?? horizonDistributions[0]!;
  const relativeScale = inputOriginPrice / decisionPrice;
  return {
    ...forecast,
    quantiles: primary.quantiles,
    horizonDistributions,
    displayPoints: forecast.displayPoints.map((point) => ({
      ...point,
      upProbability: horizonDistributions.find(
        (distribution) => distribution.horizonMinutes === point.horizonMinutes,
      )?.upProbability,
    })),
    upProbability: primary.upProbability,
    downProbability: primary.downProbability,
    flatProbability: primary.flatProbability,
    probabilityMethod: "derived_quantile_cdf",
    ...(forecast.expectedVolatility === undefined
      ? {}
      : { expectedVolatility: forecast.expectedVolatility * relativeScale }),
    ...(forecast.uncertaintyIntervalWidth === undefined
      ? {}
      : { uncertaintyIntervalWidth: forecast.uncertaintyIntervalWidth * relativeScale }),
  };
}

function cryptoTargetStop(
  analysis: CryptoRustTechnicalAnalysis | undefined,
): AiForecastRequest["series"][number]["target_stop"] {
  if (!analysis || analysis.status !== "entry_candidate"
    || analysis.stopCandidatePrice === null || analysis.targetCandidatePrice === null) {
    return null;
  }
  if (analysis.stopCandidatePrice < analysis.basisPrice
    && analysis.basisPrice < analysis.targetCandidatePrice) {
    return {
      side: "long",
      target_price: analysis.targetCandidatePrice,
      stop_price: analysis.stopCandidatePrice,
    };
  }
  // The current Rust assistance contract is long-position-oriented. A short
  // first-passage target must not be fabricated from its exit label.
  return null;
}

function modelPlanForLane(
  request: SimulationStartRequest,
  symbol: string,
  lane: SimulationModelLane,
): SimulationStartRequest["resolvedModelPlan"][number] | undefined {
  return normalizedModelPlan(request).find((plan) => (
    plan.modelLane === lane
    && (plan.symbol === "*" || plan.symbol.toUpperCase() === symbol.toUpperCase())
  ));
}

function normalizedModelPlan(
  request: SimulationStartRequest,
): SimulationStartRequest["resolvedModelPlan"] {
  return request.resolvedModelPlan;
}

function runtimeCalibrationResiduals(
  state: LaneState,
  symbol: string,
  horizonMinutes: number,
): ConformalResidual[] {
  return state.forecasts.flatMap((forecast) => {
    const q10 = forecast.quantiles.find((item) => item.quantile === 0.1)?.returnRate;
    const q90 = forecast.quantiles.find((item) => item.quantile === 0.9)?.returnRate;
    if (
      forecast.horizonMinutes !== horizonMinutes
      || forecast.actualReturn === undefined
      || forecast.resolvedAt === undefined
      || q10 === undefined
      || q90 === undefined
    ) return [];
    return [{
      modelLane: state.lane,
      symbol,
      horizonMinutes,
      originAt: forecast.displayOriginAt,
      resolvedAt: forecast.resolvedAt,
      predictedQ10: q10,
      predictedQ90: q90,
      actualReturn: forecast.actualReturn,
    }];
  });
}

function commonModelEvidence(
  input: {
    request: SimulationStartRequest;
    symbol: string;
    originAt: string;
    outcomes: ReadonlyMap<SimulationModelLane, RuntimeLaneInferenceOutcome>;
    states: ReadonlyMap<SimulationModelLane, LaneState>;
    rustTechnical?: CryptoRustTechnicalAnalysis;
    rustMarketEvidence?: RustMarketEvidenceV2;
    loadCalibrationResiduals?: CryptoPaperRuntimeOptions["loadCalibrationResiduals"];
    costs: EvidenceCostBreakdown;
  },
): ModelEvidence[] {
  const output: ModelEvidence[] = [];
  for (const [lane, outcome] of input.outcomes) {
    const forecast = outcome.forecast;
    const state = input.states.get(lane);
    const plan = modelPlanForLane(input.request, input.symbol, lane);
    if (!forecast || !state || !plan) continue;
    for (const distribution of forecast.horizonDistributions) {
      const residuals = input.loadCalibrationResiduals?.({
        modelLane: lane,
        symbol: input.symbol,
        horizonMinutes: distribution.horizonMinutes,
        originAt: input.originAt,
      }) ?? runtimeCalibrationResiduals(
        state,
        input.symbol,
        distribution.horizonMinutes,
      );
      const calibration = fitRollingConformalCalibration(
        residuals,
        {
          modelLane: lane,
          symbol: input.symbol,
          horizonMinutes: distribution.horizonMinutes,
          originAt: input.originAt,
        },
        {
          minimumSamples: 30,
          maximumSamples: 500,
          maximumAgeMinutes: 24 * 60,
          coverage: 0.8,
        },
      );
      const nativeQuantiles = Object.fromEntries(
        distribution.nativeQuantiles.map((item) => [item.quantile, item.returnRate]),
      );
      const calibrated = applyConformalScale(nativeQuantiles, calibration);
      const unavailableFeatures = [
        ...(input.rustMarketEvidence?.unavailableFields ?? []),
        "open_interest",
        "long_short_ratio",
        "liquidation_volume",
      ];
      output.push(normalizeModelEvidence({
        modelLane: lane,
        modelId: forecast.modelId,
        modelRevision: forecast.modelRevision,
        role: plan.role,
        symbol: input.symbol,
        originAt: input.originAt,
        horizonMinutes: distribution.horizonMinutes,
        quantiles: calibrated,
        calibrationId: calibration.calibrationId,
        calibrationStatus: calibration.status,
        calibrationAge: calibration.ageMinutes,
        featureProfile: lane === "chronos2"
          ? "compact_causal_v1"
          : "fincast-native/v1",
        dataQuality: {
          status: input.rustTechnical?.quality.status === "available"
            ? "ok"
            : input.rustTechnical ? "degraded" : "unavailable",
          finalizedOnly: true,
          stale: (input.rustMarketEvidence?.quoteFreshnessMs ?? Number.POSITIVE_INFINITY)
            > 120_000,
          missingRate: input.rustTechnical
            ? input.rustTechnical.quality.sameSessionGapCount
              / Math.max(1, input.rustTechnical.quality.finalBarCount)
            : 1,
          unavailableFeatures: [...new Set(unavailableFeatures)],
          warnings: [
            ...(input.rustTechnical?.quality.reasons ?? ["rust_technical_unavailable"]),
          ],
        },
        generatedAt: forecast.generatedAtIso,
        latencyMs: outcome.observedLatency ?? forecast.latencyMs ?? 0,
        inputOrigin: "live",
        costs: input.costs,
      }));
    }
  }
  return output;
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

function cryptoModelEvidence(input: {
  forecast: NormalizedLaneForecast;
  direction: FuturesSide | "flat";
  roundTripCostRate: number;
  realizedVolatilityRate: number;
}): {
  admitted: boolean;
  exposureScale: number;
  reasonCodes: string[];
  components: Record<string, number>;
} {
  const clampUnit = (value: number, minimum = 0, maximum = 1) => (
    Math.max(minimum, Math.min(maximum, value))
  );
  const rounded = (value: number) => Math.round(value * 1_000_000) / 1_000_000;
  const scales = [1];
  const reasonCodes: string[] = [];
  const components: Record<string, number> = {};
  let admitted = true;
  const { forecast } = input;

  if (
    input.direction !== "flat"
    && forecast.upProbability !== undefined
    && forecast.downProbability !== undefined
  ) {
    const directionalEdge = input.direction === "long"
      ? forecast.upProbability - forecast.downProbability
      : forecast.downProbability - forecast.upProbability;
    components.modelDirectionalProbabilityEdge = rounded(directionalEdge);
    scales.push(clampUnit(0.5 + Math.max(0, directionalEdge) / 2, 0.5, 1));
    if (directionalEdge <= 0) {
      admitted = false;
      reasonCodes.push("model_direction_probability_conflict");
    }
  }
  if (forecast.upProbability !== undefined) {
    components.modelUpProbability = rounded(forecast.upProbability);
  }
  if (forecast.downProbability !== undefined) {
    components.modelDownProbability = rounded(forecast.downProbability);
  }
  if (forecast.flatProbability !== undefined) {
    components.modelFlatProbability = rounded(forecast.flatProbability);
    scales.push(clampUnit(1 - forecast.flatProbability * 0.5, 0.5, 1));
  }
  if (forecast.expectedVolatility !== undefined) {
    components.modelExpectedVolatility = rounded(forecast.expectedVolatility);
    const reference = Math.max(
      input.realizedVolatilityRate,
      input.roundTripCostRate,
      0.001,
    );
    scales.push(clampUnit(
      reference / Math.max(reference, forecast.expectedVolatility),
      0.5,
      1,
    ));
  }
  if (forecast.uncertaintyIntervalWidth !== undefined) {
    components.modelUncertaintyIntervalWidth = rounded(
      forecast.uncertaintyIntervalWidth,
    );
    const reference = Math.max(input.roundTripCostRate * 2, 0.005);
    scales.push(clampUnit(
      reference / Math.max(reference, forecast.uncertaintyIntervalWidth),
      0.5,
      1,
    ));
  }
  const totalPathCount = forecast.validPathCount + forecast.invalidPathCount;
  components.modelValidPathCount = forecast.validPathCount;
  components.modelInvalidPathCount = forecast.invalidPathCount;
  if (totalPathCount > 0) {
    const reliability = forecast.validPathCount / totalPathCount;
    components.modelValidPathRatio = rounded(reliability);
    scales.push(clampUnit(reliability, 0.5, 1));
    if (forecast.validPathCount === 0) {
      admitted = false;
      reasonCodes.push("model_has_no_valid_paths");
    }
  }

  const targetStop = forecast.targetStop;
  if (
    input.direction !== "flat"
    && targetStop.status === "available"
    && targetStop.side === input.direction
  ) {
    const targetLower = targetStop.targetFirstProbabilityLower!;
    const targetUpper = targetStop.targetFirstProbabilityUpper!;
    const stopLower = targetStop.stopFirstProbabilityLower!;
    const stopUpper = targetStop.stopFirstProbabilityUpper!;
    const ambiguous = targetStop.ambiguousProbability!;
    const neither = targetStop.neitherProbability!;
    components.targetFirstProbabilityLower = rounded(targetLower);
    components.targetFirstProbabilityUpper = rounded(targetUpper);
    components.stopFirstProbabilityLower = rounded(stopLower);
    components.stopFirstProbabilityUpper = rounded(stopUpper);
    components.targetStopAmbiguousProbability = rounded(ambiguous);
    components.targetStopNeitherProbability = rounded(neither);
    scales.push(clampUnit(0.5 + (targetLower - stopUpper) / 2, 0.35, 1));
    scales.push(clampUnit(1 - (ambiguous + neither) * 0.5, 0.5, 1));
    if (targetUpper < stopLower) {
      admitted = false;
      reasonCodes.push("model_target_before_stop_definitively_unfavorable");
    }
  }

  return {
    admitted,
    exposureScale: rounded(Math.min(...scales)),
    reasonCodes,
    components,
  };
}

function laneTradingMetricInputs(state: LaneState) {
  const snapshot = state.ledger.snapshot();
  const openCosts = new Map<string, {
    remainingQuantity: number;
    remainingEntryFee: number;
  }>();
  const netOutcomes: number[] = [];
  for (const fill of snapshot.fills) {
    if (fill.action === "open") {
      openCosts.set(fill.symbol, {
        remainingQuantity: fill.quantity,
        remainingEntryFee: fill.fee,
      });
      continue;
    }
    const entry = openCosts.get(fill.symbol);
    let allocatedEntryFee = 0;
    if (entry && entry.remainingQuantity > 0) {
      const closingQuantity = Math.min(fill.quantity, entry.remainingQuantity);
      allocatedEntryFee = closingQuantity >= entry.remainingQuantity
        ? entry.remainingEntryFee
        : entry.remainingEntryFee * closingQuantity / entry.remainingQuantity;
      entry.remainingQuantity -= closingQuantity;
      entry.remainingEntryFee -= allocatedEntryFee;
      if (entry.remainingQuantity <= 0) openCosts.delete(fill.symbol);
    }
    netOutcomes.push(
      fill.realizedPnl + fill.funding - fill.fee - allocatedEntryFee,
    );
  }
  const profits = netOutcomes.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const losses = Math.abs(
    netOutcomes.filter((value) => value < 0).reduce((sum, value) => sum + value, 0),
  );
  return {
    snapshot,
    netOutcomes,
    profits,
    losses,
  };
}

function sumNumbers(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0);
}

function modelMetricAggregationBasis(state: LaneState): ModelMetricAggregationBasis {
  const {
    snapshot,
    netOutcomes,
    profits,
    losses,
  } = laneTradingMetricInputs(state);
  return {
    schemaVersion: MODEL_METRIC_AGGREGATION_SCHEMA_VERSION,
    prediction: {
      pinballLossSum: sumNumbers(state.predictionMetrics.pinballLosses),
      pinballLossCount: state.predictionMetrics.pinballLosses.length,
      medianAbsoluteErrorSum: sumNumbers(state.predictionMetrics.medianAbsoluteErrors),
      medianAbsoluteErrorCount: state.predictionMetrics.medianAbsoluteErrors.length,
      directionHitSum: sumNumbers(state.predictionMetrics.directionHits),
      directionCount: state.predictionMetrics.directionHits.length,
      coverageHitSum: sumNumbers(state.predictionMetrics.coverageHits),
      coverageCount: state.predictionMetrics.coverageHits.length,
      nominalCoverageSum: sumNumbers(state.predictionMetrics.nominalCoverage),
      nominalCoverageCount: state.predictionMetrics.nominalCoverage.length,
    },
    trading: {
      netPnl: snapshot.equity - snapshot.initialCash,
      grossProfit: profits,
      grossLoss: losses,
      winCount: netOutcomes.filter((value) => value > 0).length,
      outcomeCount: netOutcomes.length,
      turnoverNotional: snapshot.fills.reduce((sum, fill) => sum + fill.notional, 0),
      initialCash: snapshot.initialCash,
      funding: snapshot.funding,
      fees: snapshot.fees,
      leverageDistribution: snapshot.fills
        .filter((fill) => fill.action === "open")
        .map((fill) => fill.leverage),
    },
    operations: {
      attempts: state.attempts,
      successes: state.successes,
      latencySum: sumNumbers(state.latencies),
      latencyCount: state.latencies.length,
      timeoutCount: state.timeoutCount,
      ...(state.peakVramMb !== undefined ? { peakVramMb: state.peakVramMb } : {}),
    },
    equity: state.equity.map((point) => ({ ...point })),
  };
}

function modelMetrics(state: LaneState) {
  const {
    snapshot,
    netOutcomes,
    profits,
    losses,
  } = laneTradingMetricInputs(state);
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
    winRate: netOutcomes.length
      ? netOutcomes.filter((value) => value > 0).length / netOutcomes.length
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

function laneModelProvenanceIsConsistent(
  state: LaneState,
  forecast: NormalizedLaneForecast,
): boolean {
  if (state.successes === 0) return true;
  return state.modelId === forecast.modelId
    && state.modelRevision === forecast.modelRevision
    && state.sourceRevision === forecast.sourceRevision
    && state.loaderVersion === forecast.loaderVersion
    && state.license === forecast.license
    && state.tokenizerId === forecast.tokenizerId
    && state.tokenizerRevision === forecast.tokenizerRevision
    && state.loaded === forecast.loaded
    && state.device === forecast.device
    && state.deviceName === forecast.deviceName
    && state.cudaCapability === forecast.cudaCapability
    && state.attentionBackend === forecast.attentionBackend
    && state.precision === forecast.precision
    && state.precisionValidation === forecast.precisionValidation
    && state.memoryStatus === forecast.memoryStatus
    && state.quantileMonotonicityPolicy === forecast.quantileMonotonicityPolicy
    && JSON.stringify(state.fp32QuantileObservations)
      === JSON.stringify(forecast.fp32QuantileObservations)
    && JSON.stringify(state.mixedQuantileObservations)
      === JSON.stringify(forecast.mixedQuantileObservations)
    && state.quantileTailPolicy === forecast.quantileTailPolicy
    && state.peakVramBytes === forecast.peakVramBytes
    && state.peakVramMeasurement === forecast.peakVramMeasurement
    && state.peakVramMb === forecast.peakVramMb
    && JSON.stringify(state.precisionFailureReasons)
      === JSON.stringify(forecast.precisionFailureReasons);
}

function maximumDefined(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.max(left, right);
}

function persistedLaneModelProvenance(state: LaneState) {
  return {
    modelId: state.modelId,
    modelRevision: state.modelRevision,
    sourceRevision: state.sourceRevision,
    loaderVersion: state.loaderVersion,
    license: state.license,
    tokenizerId: state.tokenizerId,
    tokenizerRevision: state.tokenizerRevision,
    loaded: state.loaded,
    device: state.device,
    deviceName: state.deviceName,
    cudaCapability: state.cudaCapability,
    attentionBackend: state.attentionBackend,
    precision: state.precision,
    precisionValidation: state.precisionValidation,
    memoryStatus: state.memoryStatus,
    quantileMonotonicityPolicy: state.quantileMonotonicityPolicy,
    fp32QuantileObservations: state.fp32QuantileObservations,
    mixedQuantileObservations: state.mixedQuantileObservations,
    quantileTailPolicy: state.quantileTailPolicy,
    ...(state.precisionFailureReasons
      ? { precisionFailureReasons: [...state.precisionFailureReasons] }
      : {}),
    peakVramBytes: state.peakVramBytes,
    peakVramMeasurement: state.peakVramMeasurement,
    peakVramMb: state.peakVramMb,
  };
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
    exitTaxes: snapshot.exitTaxes,
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
    commission: fill.fee - fill.exitTax,
    exitTax: fill.exitTax,
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
  private readonly laneRequestTails = new Map<SimulationModelLane, Promise<void>>();

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

  private async requestLane(
    lane: SimulationModelLane,
    client: CryptoAiLaneClient,
    request: AiForecastRequest,
    signal: AbortSignal,
  ): Promise<unknown> {
    const predecessor = this.laneRequestTails.get(lane) ?? Promise.resolve();
    let release = () => {};
    const occupied = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = predecessor
      .catch(() => {})
      .then(() => occupied);
    this.laneRequestTails.set(lane, tail);
    try {
      await raceWithAbort(predecessor.catch(() => {}), signal);
      return await client.request(request, signal);
    } finally {
      release();
      void tail.finally(() => {
        if (this.laneRequestTails.get(lane) === tail) {
          this.laneRequestTails.delete(lane);
        }
      });
    }
  }

  async run(input: {
    request: SimulationStartRequest;
    snapshot: BinanceScannerSnapshot;
    selected: BinanceScannerCandidate | readonly BinanceScannerCandidate[];
    context: RunTaskContext;
  }): Promise<CryptoSimulationRuntimeResult> {
    const selectedItems = Array.isArray(input.selected)
      ? input.selected
      : [input.selected as BinanceScannerCandidate];
    if (selectedItems.length < 1 || selectedItems.length > 2) {
      throw new CryptoPaperRuntimeError(
        "invalid_runtime_input",
        "CryptoPaperRuntime requires one or two selected contracts.",
      );
    }
    if (selectedItems.length === 1) {
      return this.runSingle({
        ...input,
        selected: selectedItems[0]!,
      });
    }
    return this.runPortfolio({
      ...input,
      selected: selectedItems,
    });
  }

  private async runSingle(input: {
    request: SimulationStartRequest;
    snapshot: BinanceScannerSnapshot;
    selected: BinanceScannerCandidate;
    context: RunTaskContext;
    snapshotObserver?: CryptoPaperRuntimeSnapshotObserver;
    portfolioDailyLossGate?: PortfolioDailyLossGate;
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
    const riskLimits = request.riskLimits ?? DEFAULT_CRYPTO_FUTURES_RISK_LIMITS;
    const requiredMaximumNotional = (
      request.initialCash
      * riskLimits.grossExposureLimitRate
      * PAPER_MAINTENANCE_MARGIN_COVERAGE_MULTIPLIER
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
    const modelCandleSeconds = request.fincastCandleSeconds ?? 60;
    const subminuteFinCast = modelCandleSeconds < 60;
    const highFrequencyHighVol = (
      request.simulationCase === "high_vol_crypto"
      && !subminuteFinCast
    );
    if (
      subminuteFinCast
      && (
        selectedLanes.length !== 1
        || selectedLanes[0] !== "fincast"
        || (modelCandleSeconds !== 15 && modelCandleSeconds !== 30)
        || !this.options.rest.aggregateTrades
      )
    ) {
      throw new CryptoPaperRuntimeError(
        "invalid_runtime_input",
        "FinCast 15s/30s mode requires the FinCast-only lane and Binance aggregate-trade REST data.",
      );
    }
    const modelIntervalMs = modelCandleSeconds * 1_000;
    const inferenceIntervalMs = highFrequencyHighVol
      ? HIGH_VOL_CRYPTO_INFERENCE_INTERVAL_MS
      : modelIntervalMs;
    const decisionTrigger = highFrequencyHighVol
      ? "high_vol_live_5s" as const
      : modelCandleSeconds === 15
      ? "final_fincast_15s_aggtrade_bar" as const
      : modelCandleSeconds === 30
        ? "final_fincast_30s_aggtrade_bar" as const
        : "final_binance_1m_kline" as const;
    const policyProfile = cryptoFuturesPolicyProfile(request);
    const modelPlan = normalizedModelPlan(request);
    const preferredExecutionLane = modelPlan.find((plan) => (
      plan.role === "primary"
      && (plan.symbol === "*" || plan.symbol.toUpperCase() === symbol)
    ))?.modelLane ?? this.options.executionLane ?? "fincast";
    const executionLane = selectedLanes.includes(preferredExecutionLane)
      ? preferredExecutionLane
      : selectedLanes[0]!;
    const queue = new BoundedMarketEventQueue();
    const ingressStore = new CausalBinanceKlineStore();
    const decisionStore = new CausalBinanceKlineStore();
    // A single run has one symbol and preset. Replacing this entry whenever
    // the latest finalized one-minute origin changes is therefore a bounded
    // causal cache and prevents 15s/30s FinCast decisions from re-running Rust
    // four or two times for the same minute.
    let rustTechnicalCache: RuntimeRustTechnicalCacheEntry | undefined;
    let fincastMicroBars: BinanceKline[] = [];
    let fincastMicroAggregator: FinCastMicroCandleAggregator | undefined;
    const bufferedSetupAggregateTrades: BinanceAggregateTrade[] = [];
    const appendFinCastMicroBar = (bar: BinanceKline): void => {
      const existing = fincastMicroBars.findIndex(
        (candidate) => candidate.openTime === bar.openTime,
      );
      if (existing >= 0) fincastMicroBars[existing] = { ...bar };
      else fincastMicroBars.push({ ...bar });
      fincastMicroBars.sort((left, right) => left.openTime - right.openTime);
      if (fincastMicroBars.length > MAXIMUM_RESTORED_BARS) {
        fincastMicroBars = fincastMicroBars.slice(-MAXIMUM_RESTORED_BARS);
      }
    };
    const modelContext = (): BinanceKline[] => (
      subminuteFinCast
        ? fincastMicroBars.slice(-this.contextBars)
        : decisionStore.list(symbol).slice(-this.contextBars)
    );
    const latestModelBar = (): BinanceKline | undefined => modelContext().at(-1);
    const warnings: string[] = [];
    const decisions: RuntimeDecision[] = [];
    const unifiedPolicyDecisions: UnifiedPolicyDecision[] = [];
    const routedModelEvidence: ModelEvidence[] = [];
    const liveRustMarketEvidence: CryptoLiveRustMarketEvidence[] = [];
    const states = new Map<SimulationModelLane, LaneState>();
    let terminalSettlement: TerminalSettlementEvidence | undefined;
    let currentSpreadBps = selected.spreadBps;
    let ingressSpreadBps = selected.spreadBps;
    let currentMarkPrice = selected.price;
    let currentMarkPriceObservedAt = Number.isFinite(
      Date.parse(selected.dataQuality.observedAt),
    )
      ? Date.parse(selected.dataQuality.observedAt)
      : Date.parse(input.snapshot.generatedAt);
    let lastTriggeredAt: string | undefined;
    let triggeredEvents = 0;
    let inferenceInFlight = false;
    let klineDataHealthy = true;
    let klineDataBlockReason: string | undefined;
    let closing = false;
    let streamDisconnected: { error?: unknown } | undefined;
    let subscription: BinanceWebsocketSubscription | undefined;
    let lastPublishedAt = Number.NEGATIVE_INFINITY;
    let lastProgressUpdateAt = Number.NEGATIVE_INFINITY;
    let lastCancellationPollAt = Number.NEGATIVE_INFINITY;
    let lastInferredOpenTime = Number.NEGATIVE_INFINITY;
    let lastProcessedFinalOpenTime = Number.NEGATIVE_INFINITY;
    let nextHighFrequencyInferenceAt = Number.POSITIVE_INFINITY;
    let lastBookTickerObservedAt: number | undefined;
    let lastMarkPriceObservedAt: number | undefined;
    let lastBookTickerEventTime: number | undefined;
    let lastMarkPriceEventTime: number | undefined;
    let lastIngressBookTickerEventTime: number | undefined;
    let lastIngressMarkPriceEventTime: number | undefined;
    let latestBookTicker: Extract<
      BinanceMarketEvent,
      { kind: "book_ticker" }
    > | undefined;
    const recentAggregateTrades: Array<Extract<
      BinanceMarketEvent,
      { kind: "agg_trade" }
    >> = [];
    let lastIngressSequence = 0;
    let coalescedFinalKlines = 0;
    let coalescedInferenceBar: BinanceKline | undefined;
    let inferenceTask: Promise<void> | undefined;
    let inferenceFailure: unknown;
    let readyInferenceCompletion: RuntimeInferenceCompletion | undefined;
    let activeInferenceController: AbortController | undefined;
    let acceptInferenceCompletions = true;
    let liveWindowStarted = false;
    let liveDecisionStartAt = Number.POSITIVE_INFINITY;
    let terminalBoundaryQueued = false;
    let streamEpoch = 0;
    let inferenceSequence = 0;
    const prospectivePendingOpenRisk = new Map<SimulationModelLane, {
      pendingKey: string;
      fillIngressSequence: number;
      fillCausalAt: number;
      protectiveStopPrice: number;
      estimatedLiquidationPrice: number;
    }>();
    type BufferedMarkRiskEvidence = {
      event: Extract<BinanceMarketEvent, { kind: "mark_price" }>;
      ingressSequence: number;
    };
    type MarkRiskEvidenceBucket = {
      minimum: BufferedMarkRiskEvidence;
      maximum: BufferedMarkRiskEvidence;
      latest: BufferedMarkRiskEvidence;
    };
    type CanonicalFundingSettlement = {
      eventId: string;
      eventAt: number;
      rate: number;
      settlementMarkPrice: number;
      triggerIngressSequence: number;
      triggerEvent: Extract<BinanceMarketEvent, { kind: "mark_price" }>;
    };
    type FrozenFinalKlineRiskEvidence = {
      marks: readonly BufferedMarkRiskEvidence[];
      fundingSettlements: readonly CanonicalFundingSettlement[];
      complete: boolean;
    };
    const finalKlineRiskEvidence = new Map<number, MarkRiskEvidenceBucket>();
    const finalKlineRiskEvidenceSnapshots = new WeakMap<
      object,
      FrozenFinalKlineRiskEvidence
    >();
    const canonicalFundingSettlements: CanonicalFundingSettlement[] = [];
    const consumedFundingSettlements = new Map<
      SimulationModelLane,
      Set<string>
    >(selectedLanes.map((lane) => [lane, new Set<string>()]));
    let ingressScheduledFunding: { eventAt: number; rate: number } | undefined;
    let lastIngressAcceptedMarkPrice = selected.price;
    let markEvidenceEvictedThroughEventTime: number | undefined;
    let fundingEvidenceEvictedThroughEventAt: number | undefined;
    const bufferFinalKlineRiskEvidence = (
      event: Extract<BinanceMarketEvent, { kind: "mark_price" }>,
      ingressSequence: number,
    ): void => {
      const intervalOpenTime = Math.floor(event.eventTime / MINUTE_MS) * MINUTE_MS;
      const evidence = {
        event: { ...event },
        ingressSequence,
      };
      const existing = finalKlineRiskEvidence.get(intervalOpenTime);
      finalKlineRiskEvidence.set(intervalOpenTime, existing
        ? {
          minimum: event.markPrice < existing.minimum.event.markPrice
            ? evidence
            : existing.minimum,
          maximum: event.markPrice > existing.maximum.event.markPrice
            ? evidence
            : existing.maximum,
          latest: evidence,
        }
        : { minimum: evidence, maximum: evidence, latest: evidence });
      const intervalKeys = Array.from(finalKlineRiskEvidence.keys())
        .sort((left, right) => left - right);
      while (intervalKeys.length > MAX_FINAL_KLINE_RISK_EVIDENCE_BUCKETS) {
        const evictedKey = intervalKeys.shift()!;
        const evicted = finalKlineRiskEvidence.get(evictedKey);
        if (evicted) {
          markEvidenceEvictedThroughEventTime = Math.max(
            markEvidenceEvictedThroughEventTime ?? Number.NEGATIVE_INFINITY,
            evicted.minimum.event.eventTime,
            evicted.maximum.event.eventTime,
            evicted.latest.event.eventTime,
          );
        }
        finalKlineRiskEvidence.delete(evictedKey);
      }
    };
    const bufferCanonicalFundingSettlement = (
      event: Extract<BinanceMarketEvent, { kind: "mark_price" }>,
      ingressSequence: number,
    ): void => {
      if (ingressScheduledFunding && event.eventTime >= ingressScheduledFunding.eventAt) {
        const settlement: CanonicalFundingSettlement = {
          eventId: `funding:${symbol}:${ingressScheduledFunding.eventAt}`,
          eventAt: ingressScheduledFunding.eventAt,
          rate: ingressScheduledFunding.rate,
          settlementMarkPrice: lastIngressAcceptedMarkPrice,
          triggerIngressSequence: ingressSequence,
          triggerEvent: { ...event },
        };
        if (!canonicalFundingSettlements.some(
          (candidateSettlement) => candidateSettlement.eventId === settlement.eventId,
        )) {
          canonicalFundingSettlements.push(settlement);
          canonicalFundingSettlements.sort(
            (left, right) => left.eventAt - right.eventAt
              || left.triggerIngressSequence - right.triggerIngressSequence,
          );
          while (
            canonicalFundingSettlements.length > MAX_FINAL_KLINE_FUNDING_EVIDENCE
          ) {
            const evicted = canonicalFundingSettlements.shift()!;
            fundingEvidenceEvictedThroughEventAt = Math.max(
              fundingEvidenceEvictedThroughEventAt ?? Number.NEGATIVE_INFINITY,
              evicted.eventAt,
            );
          }
        }
        ingressScheduledFunding = undefined;
      }
      lastIngressAcceptedMarkPrice = event.markPrice;
      if (event.nextFundingTime > event.eventTime) {
        ingressScheduledFunding = {
          eventAt: event.nextFundingTime,
          rate: event.fundingRate,
        };
      }
    };
    const freezeFinalKlineRiskEvidence = (
      bar: Extract<BinanceMarketEvent, { kind: "kline" }>,
      ingressSequence: number,
    ): void => {
      // The callback sequence is the causal receipt order. receivedAt remains
      // telemetry only and cannot exclude evidence when the local clock rolls back.
      const marks = Array.from(new Map(
        Array.from(finalKlineRiskEvidence.values())
          .flatMap((bucket) => [bucket.minimum, bucket.maximum, bucket.latest])
          .filter((item) => (
            item.ingressSequence < ingressSequence
            && item.event.eventTime > bar.openTime
          ))
          .map((item) => [item.ingressSequence, item]),
      ).values()).sort((left, right) => (
        left.event.eventTime - right.event.eventTime
        || left.ingressSequence - right.ingressSequence
      ));
      const fundingSettlements = canonicalFundingSettlements
        .filter((settlement) => (
          settlement.triggerIngressSequence < ingressSequence
          && settlement.eventAt > bar.openTime
        ))
        .map((settlement) => ({
          ...settlement,
          triggerEvent: { ...settlement.triggerEvent },
        }));
      const markEvidenceComplete = markEvidenceEvictedThroughEventTime === undefined
        || markEvidenceEvictedThroughEventTime <= bar.openTime;
      const fundingEvidenceComplete = fundingEvidenceEvictedThroughEventAt === undefined
        || fundingEvidenceEvictedThroughEventAt <= bar.openTime;
      finalKlineRiskEvidenceSnapshots.set(bar, {
        marks,
        fundingSettlements,
        complete: markEvidenceComplete && fundingEvidenceComplete,
      });
    };
    const ingressSequences = new WeakMap<object, number>();
    const ingressObservedAts = new WeakMap<object, number>();
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
        exitTaxBps: request.costs.taxBpsOnExit,
        slippageBpsPerSide: request.costs.slippageBpsPerSide,
      });
      states.set(lane, {
        lane,
        ledger,
        riskGeneration: 0,
        dailyGate: input.portfolioDailyLossGate?.state(lane)
          ?? updateDailyLossGate(
            undefined,
            request.initialCash,
            startedAt,
            riskLimits.dailyLossLimitRate,
          ),
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
    const currentDailyGate = (state: LaneState): DailyLossGateState => (
      input.portfolioDailyLossGate?.state(state.lane) ?? state.dailyGate
    );
    const observeDailyGate = (
      state: LaneState,
      equity: number,
      observedAt: number,
    ): PortfolioDailyLossObservation => {
      const gate = input.portfolioDailyLossGate?.observe({
        lane: state.lane,
        symbol,
        equity,
        observedAt,
        dailyLossLimitRate: riskLimits.dailyLossLimitRate,
      }) ?? updateDailyLossGate(
        state.dailyGate,
        equity,
        observedAt,
        riskLimits.dailyLossLimitRate,
      );
      state.dailyGate = gate;
      return gate;
    };

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
    const decisionLifecycleBlockReason = (
      at = this.clock.now(),
    ): string | undefined => {
      if (closing) return "runtime_closing";
      if (context.signal.aborted) return "runtime_cancelled";
      if (streamDisconnected) return "stream_desync";
      if (at >= expiresAt) return "runtime_expired";
      return entryDataHealthy(at)
        ? undefined
        : entryBlockReason(at) ?? "market_data_unhealthy";
    };
    const blockPendingOpens = (reason: string): void => {
      for (const state of states.values()) {
        if (state.pending?.action !== "open") continue;
        state.pending.decision.status = "blocked";
        state.pending.decision.reason = reason;
        prospectivePendingOpenRisk.delete(state.lane);
        state.pending = undefined;
      }
    };
    const discardCoalescedInference = (): void => {
      if (!coalescedInferenceBar) return;
      coalescedFinalKlines += 1;
      coalescedInferenceBar = undefined;
    };
    const enterReconnectSafety = (): void => {
      streamQualificationState = "reconnecting";
      klineDataHealthy = false;
      klineDataBlockReason = "stream_reconnecting";
      lastBookTickerObservedAt = undefined;
      lastMarkPriceObservedAt = undefined;
      lastBookTickerEventTime = undefined;
      lastMarkPriceEventTime = undefined;
      lastIngressBookTickerEventTime = undefined;
      lastIngressMarkPriceEventTime = undefined;
      latestBookTicker = undefined;
      recentAggregateTrades.length = 0;
      finalKlineRiskEvidence.clear();
      markEvidenceEvictedThroughEventTime = undefined;
      blockPendingOpens("stream_reconnecting");
      discardCoalescedInference();
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

    const forecastIsFresh = (forecast: RuntimeForecastObservation): boolean => (
      cryptoModelForecastIsFresh({
        inputEndAt: forecast.inputEndAt,
        targetTimestamps: forecast.displayPoints.map((point) => point.targetTimestamp),
        latestFinalCandleCloseTime: latestModelBar()?.closeTime,
        maximumInputLagMs: highFrequencyHighVol ? MINUTE_MS : 0,
      })
    );

    const modelForecasts = () => selectedLanes.map((lane) => {
      const state = states.get(lane)!;
      const latest = state.forecasts.at(-1);
      const stale = latest && latest.displayPoints.length > 0
        ? !forecastIsFresh(latest)
        : false;
      if (!latest || latest.displayPoints.length === 0 || stale) {
        return {
          lane,
          signalSymbol: symbol,
          status: "unavailable" as const,
          ...(latest ? {
            origin: latest.displayOriginAt,
            inputOrigin: latest.inputEndAt,
            originPrice: latest.originPrice,
            priceObservedAt: latest.priceObservedAt,
            projectionPolicy: latest.projectionPolicy,
            generatedAt: latest.generatedAtIso,
            modelId: latest.modelId,
            modelRevision: latest.modelRevision,
          } : {}),
          points: [],
          unavailableReason: stale
            ? "model_forecast_stale"
            : latest
            ? "model_price_path_unavailable"
            : state.errors.at(-1) ?? "first_model_forecast_pending",
        };
      }
      return {
        lane,
        signalSymbol: symbol,
        status: "available" as const,
        origin: latest.displayOriginAt,
        inputOrigin: latest.inputEndAt,
        originPrice: latest.originPrice,
        priceObservedAt: latest.priceObservedAt,
        projectionPolicy: latest.projectionPolicy,
        generatedAt: latest.generatedAtIso,
        modelId: latest.modelId,
        modelRevision: latest.modelRevision,
        points: latest.displayPoints.map((point) => ({ ...point })),
      };
    });

    const modelComparison = () => {
      const settlementIncomplete = terminalSettlement?.settlementComplete === false;
      const requiredSettlementLanes = terminalSettlement?.lanes.filter(
        (lane) => lane.required,
      ) ?? [];
      const firstSettlementDigest = requiredSettlementLanes[0]?.fillBarrierDigest;
      const settlementSameFillBarrier = !terminalSettlement
        || requiredSettlementLanes.length === 0
        || (
          terminalSettlement.settlementComplete
          && firstSettlementDigest !== undefined
          && requiredSettlementLanes.every((lane) => (
            lane.status === "settled"
            && lane.fillBarrierDigest === firstSettlementDigest
          ))
        );
      return {
        comparisonId: `${context.runId}:${symbol}`,
        outcome: settlementIncomplete || selectedLanes.length > 1 ? "inconclusive" : "pending",
        sameOrigin: true,
        sameContext: true,
        sameCosts: true,
        sameFillBarrier: !settlementIncomplete && settlementSameFillBarrier,
        symbol,
        lanes: selectedLanes.map((lane) => {
          const state = states.get(lane)!;
          const laneSettlement = terminalSettlement?.lanes.find(
            (candidateLane) => candidateLane.lane === lane,
          );
          const settlementUnavailable = laneSettlement?.status === "unsettled_fail_closed";
          return {
            id: lane,
            status: settlementUnavailable ? "partial" : laneStatus(state),
            precision: state.precision,
            ...(settlementUnavailable
              ? { unavailableReason: "terminal_settlement_unavailable" }
              : state.errors.length
                ? { unavailableReason: safeModelErrorCode(state.errors.at(-1)) }
                : {}),
            metrics: modelMetrics(state),
            aggregationBasis: modelMetricAggregationBasis(state),
            provenance: persistedLaneModelProvenance(state),
          };
        }),
      };
    };

    const snapshotFor = (
      phase: CryptoPaperRuntimeSnapshot["phase"],
      at = this.clock.now(),
    ): CryptoPaperRuntimeSnapshot => {
      const execution = states.get(executionLane)!;
      const ledger = execution.ledger.snapshot();
      const executionDailyGate = currentDailyGate(execution);
      const latestExecutionForecast = execution.forecasts.at(-1);
      const executionForecast = latestExecutionForecast
        && forecastIsFresh(latestExecutionForecast)
        ? latestExecutionForecast
        : undefined;
      const executionMedianReturn = executionForecast?.quantiles.find(
        (quantile) => quantile.quantile === 0.5,
      )?.returnRate;
      const executionUpProbability = executionForecast?.displayPoints.find(
        (point) => point.horizonMinutes === SCALPING_AI_HORIZONS[0],
      )?.upProbability;
      const streamFreshness = riskStreamFreshness(at);
      const positions = futuresPositions(ledger, streamFreshness.warnings);
      const progress = phase === "completed"
        ? 1
        : Math.max(0, Math.min(0.999, (at - startedAt) / Math.max(1, expiresAt - startedAt)));
      const dailyLossRatio = executionDailyGate.drawdownRate;
      const bars = decisionStore.list(symbol, false).slice(-240);
      const chart = cryptoChartProjection(bars);
      const forecasts = modelForecasts();
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
        simulationCase: request.simulationCase,
        resolvedModelPlan: structuredClone(modelPlan),
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
        policyProfile,
        selected: [{
          symbol,
          name: symbol,
          rank: selected.rank,
          score: selected.score,
          price: selected.price,
          currentPrice: currentMarkPrice,
          priceObservedAt: iso(currentMarkPriceObservedAt),
          observedAt: iso(currentMarkPriceObservedAt),
          ...(executionUpProbability !== undefined
            ? { upProbability: executionUpProbability }
            : {}),
          ...(executionMedianReturn !== undefined
            ? { predictedMedianReturn: executionMedianReturn }
            : {}),
          ...(executionForecast
            ? {
              inputEndAt: executionForecast.inputEndAt,
              generatedAt: executionForecast.generatedAtIso,
              model: {
                modelId: executionForecast.modelId,
                modelRevision: executionForecast.modelRevision,
                device: executionForecast.device,
              },
            }
            : {}),
          reason: `scanner ${input.snapshot.scannerSnapshotId}`,
        }],
        positions,
        futuresPositions: positions,
        futuresRisk: {
          dailyLossRatio,
          dailyLossLimitRatio: riskLimits.dailyLossLimitRate,
          newEntriesBlocked: executionDailyGate.blocked
            || !klineDataHealthy
            || !streamFreshness.healthy,
          ...(executionDailyGate.blocked
            ? {
              blockReason: `UTC 일손실 ${(riskLimits.dailyLossLimitRate * 100)
                .toFixed(2)}% gate`,
            }
            : entryBlockReason(at) ? { blockReason: entryBlockReason(at) } : {}),
          grossExposureRatio: ledger.equity > 0 ? ledger.grossExposure / ledger.equity : 0,
          grossExposureLimitRatio: riskLimits.grossExposureLimitRate,
          marginUsageRatio: ledger.equity > 0
            ? ledger.totalIsolatedMargin / ledger.equity
            : 0,
          marginUsageLimitRatio: riskLimits.marginUsageLimitRate,
          riskPerTradeRatio: riskLimits.riskPerTradeRate,
          maximumLeverage: riskLimits.maximumLeverage,
          liquidationBufferMultiple: riskLimits.liquidationBufferMultiple,
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
          bars: chart.bars,
          indicators: chart.indicators,
          patterns: chart.patterns,
          updatedAt: bars.length ? iso(at) : undefined,
        }],
        trades: tradeRows(executionLane, ledger),
        decisions: decisions.filter((decision) => decision.lane === executionLane).slice(-300),
        unifiedPolicyDecisions: unifiedPolicyDecisions.slice(-300),
        modelEvidence: routedModelEvidence.slice(-600),
        rustMarketEvidence: liveRustMarketEvidence.slice(-300),
        modelForecasts: forecasts,
        warnings: unique(warnings),
        capabilities: {
          paper: true,
          testnet: false,
          live: false,
          realOrder: false,
          isolatedMargin: true,
          oneWayPosition: true,
          maximumPaperLeverage: riskLimits.maximumLeverage,
          executionLane,
          modelCandleSeconds,
          inferenceIntervalSeconds: inferenceIntervalMs / 1_000,
          chartCandleSeconds: 60,
        },
        modelLanes: selectedLanes,
        executionMode: "paper",
        executionLane,
        modelComparison: modelComparison(),
        ...(terminalSettlement
          ? { terminalSettlement: structuredClone(terminalSettlement) }
          : {}),
        decisionCadence: {
          trigger: decisionTrigger,
          modelCandleSeconds,
          inferenceIntervalSeconds: inferenceIntervalMs / 1_000 as 5 | 15 | 30 | 60,
          triggeredEvents,
          coalescedFinalKlines,
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
      const observer = input.snapshotObserver ?? this.options.onSnapshot;
      if (!observer || (!force && at - lastPublishedAt < 500)) return snapshot;
      try {
        await observer(context.runId, structuredClone(snapshot));
        lastPublishedAt = at;
      } catch (error) {
        warnings.push(`snapshot_observer_failed:${error instanceof Error ? error.message : "unknown"}`);
      }
      return snapshot;
    };

    const recordEquity = (at: number, force = false): void => {
      for (const state of states.values()) {
        const equity = state.ledger.snapshot().equity;
        state.equityPeak = Math.max(state.equityPeak, equity);
        const drawdown = state.equityPeak > 0
          ? (state.equityPeak - equity) / state.equityPeak
          : 0;
        state.maximumDrawdown = Math.max(state.maximumDrawdown, drawdown);
        if (!force && at - state.lastEquitySampleAt < EQUITY_SAMPLE_INTERVAL_MS) continue;
        state.lastEquitySampleAt = at;
        const terminalPoint = {
          timestamp: iso(at),
          equity,
          drawdown,
        };
        if (force && state.equity.at(-1)?.timestamp === terminalPoint.timestamp) {
          state.equity[state.equity.length - 1] = terminalPoint;
          continue;
        }
        if (state.equity.length >= MAX_EQUITY_SAMPLES_PER_LANE) {
          state.equity[state.equity.length - 1] = terminalPoint;
          continue;
        }
        state.equity.push(terminalPoint);
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
      cryptoRuntimeEntityId("decision", {
        runId: context.runId,
        symbol,
        lane,
        at,
        sequence: decisions.length + 1,
      })
    );
    const fillId = (lane: SimulationModelLane, at: number): string => (
      cryptoRuntimeEntityId("fill", {
        runId: context.runId,
        symbol,
        lane,
        at,
        sequence: states.get(lane)!.ledger.snapshot().fills.length + 1,
      })
    );
    const clientOrderId = (
      lane: SimulationModelLane,
      action: "open" | "reduce",
      at: number,
    ): string => cryptoRuntimeClientOrderId({
      runId: context.runId,
      symbol,
      lane,
      action,
      at,
      sequence: states.get(lane)!.ledger.snapshot().fills.length + 1,
    });

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
          || (pending.eligibleStreamEpoch !== undefined
            && pending.eligibleStreamEpoch !== streamEpoch)
          || (!pending.terminalSettlement && event.receivedAt <= pending.decisionAt)
          || executedAt <= pending.decisionAt) continue;
        // A finalized kline may only contribute its open as a simulated fill
        // when that open occurred strictly after the decision. Checking the
        // close/receipt time here would look back to a price that had already
        // traded while model inference was still running.
        if (event.kind === "kline" && event.openTime <= pending.decisionAt) continue;
        const ledgerBefore = state.ledger.snapshot();
        if (pending.action === "open" && event.kind === "kline") {
          const evidenceSnapshot = finalKlineRiskEvidenceSnapshots.get(event);
          if (evidenceSnapshot?.complete !== true) {
            pending.decision.status = "blocked";
            pending.decision.reason = "final_kline_risk_evidence_incomplete";
            prospectivePendingOpenRisk.delete(state.lane);
            state.pending = undefined;
            continue;
          }
        }
        const lifecycleBlockReason = decisionLifecycleBlockReason(
          ingressObservedAts.get(event) ?? this.clock.now(),
        );
        const dailyGate = currentDailyGate(state);
        if (pending.action === "open"
          && (dailyGate.blocked || lifecycleBlockReason !== undefined)) {
          pending.decision.status = "blocked";
          pending.decision.reason = dailyGate.blocked
            ? "daily_loss_gate"
            : lifecycleBlockReason ?? "market_data_unhealthy";
          prospectivePendingOpenRisk.delete(state.lane);
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
              const causalMarkPrice = event.kind === "kline"
                ? fillPrice
                : currentMarkPrice;
              const causalSpreadBps = event.kind === "kline"
                ? pending.spreadBps!
                : Math.max(pending.spreadBps!, currentSpreadBps);
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
                spreadBps: causalSpreadBps,
                slippageBpsPerSide: request.costs.slippageBpsPerSide,
                // Revalidation may lower leverage or quantity, but it never
                // upgrades the decision after seeing a later market event.
                requestedLeverage: pending.leverage!,
                limits: riskLimits,
                rules,
              });
              const feeRate = request.costs.commissionBpsPerSide / 10_000;
              const markPnlPerUnit = side === "long"
                ? causalMarkPrice - expectedEntryPrice
                : expectedEntryPrice - causalMarkPrice;
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
                riskLimits.grossExposureLimitRate,
                latest.grossExposure,
                causalMarkPrice,
              );
              const marginQuantityLimit = boundedQuantity(
                riskLimits.marginUsageLimitRate,
                latest.totalIsolatedMargin,
                expectedEntryPrice / revalidated.leverage,
              );
              const stopDistance = Math.abs(
                expectedEntryPrice - revalidated.protectiveStopPrice,
              );
              const riskQuantityLimit = boundedQuantity(
                riskLimits.riskPerTradeRate,
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
                markPrice: causalMarkPrice,
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
            state.riskGeneration += 1;
            pending.decision.status = "executed";
            pending.decision.fillId = fill.fillId;
            pending.decision.executedAt = iso(fill.executedAt);
            pending.decision.fillEventKind = event.kind === "agg_trade"
              ? "agg_trade"
              : "final_kline_open";
            pending.decision.fillIngressSequence = ingressSequence;
            pending.decision.fillReceivedAt = iso(event.receivedAt);
            pending.decision.fillBarrierDigest = digest({
              runId: context.runId,
              symbol,
              ingressSequence,
              event,
            });
            filled = true;
          }
        } catch (error) {
          pending.decision.status = "skipped";
          pending.decision.reason = `fill_rejected:${error instanceof Error ? error.message : "unknown"}`;
          warnings.push(`${state.lane}:${pending.decision.reason}`);
        } finally {
          if (pending.action === "open") {
            prospectivePendingOpenRisk.delete(state.lane);
          }
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
        prospectivePendingOpenRisk.delete(state.lane);
      }
      state.riskGeneration += 1;
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

    const scheduleTerminalSettlement = (
      scheduling: TerminalSettlementEvidence["scheduling"],
      eligibleAfterIngressSequence: number,
      boundaryEvent?: {
        event: BinanceMarketEvent;
        ingressSequence: number;
      },
    ): TerminalSettlementEvidence => {
      if (terminalSettlement) return terminalSettlement;
      const decisionAt = expiresAt;
      const decisionStreamEpoch = streamEpoch;
      const lanes: TerminalSettlementLaneEvidence[] = [];

      for (const state of states.values()) {
        if (state.pending?.action === "open") {
          state.pending.decision.status = "blocked";
          state.pending.decision.reason = "runtime_expired";
          prospectivePendingOpenRisk.delete(state.lane);
          state.pending = undefined;
        }
        const position = state.ledger.snapshot().positions.find(
          (candidatePosition) => candidatePosition.symbol === symbol,
        );
        if (!position) {
          lanes.push({
            lane: state.lane,
            required: false,
            decisionSource: "not_required",
            status: "not_required",
          });
          continue;
        }

        let pending = state.pending;
        let decisionSource: TerminalSettlementLaneEvidence["decisionSource"];
        if (pending?.action === "reduce") {
          // A protection or daily-loss reduce already has an earlier causal
          // decision and fill watermark. Expiry must not weaken or rewrite it.
          decisionSource = "existing_risk_reduce";
        } else {
          state.riskGeneration += 1;
          const decision: RuntimeDecision = {
            id: decisionId(state.lane, decisionAt),
            lane: state.lane,
            symbol,
            originAt: iso(decisionAt),
            decisionAt: iso(decisionAt),
            fillEligibleAfter: iso(decisionAt),
            action: "reduce",
            direction: position.side,
            status: "pending",
            reason: "terminal_settlement",
            requestDigest: digest({
              reason: "terminal_settlement",
              symbol,
              decisionAt,
              eligibleAfterIngressSequence,
              decisionStreamEpoch,
            }),
          };
          decisions.push(decision);
          pending = {
            action: "reduce",
            decision,
            decisionAt,
            eligibleAfterIngressSequence,
            reason: "terminal_settlement",
            terminalSettlement: true,
            eligibleStreamEpoch: decisionStreamEpoch,
          };
          state.pending = pending;
          decisionSource = "runtime_expiry";
        }
        lanes.push({
          lane: state.lane,
          required: true,
          positionAtExpiry: {
            symbol: position.symbol,
            side: position.side,
            quantity: position.quantity,
          },
          decisionSource,
          decisionId: pending.decision.id,
          decisionAt: iso(pending.decisionAt),
          eligibleAfterIngressSequence: pending.eligibleAfterIngressSequence,
          status: "pending",
          fillCountAtExpiry: state.ledger.snapshot().fills.length,
        });
      }

      const required = lanes.some((lane) => lane.required);
      terminalSettlement = {
        policy: "causal_reduce_only",
        scheduling,
        decisionAt: iso(decisionAt),
        graceDeadlineAt: iso(decisionAt + TERMINAL_SETTLEMENT_GRACE_MS),
        graceDurationMs: TERMINAL_SETTLEMENT_GRACE_MS,
        decisionStreamEpoch,
        settlementComplete: !required,
        status: required ? "pending" : "not_required",
        barrier: {
          eligibleAfterIngressSequence,
          requiresStrictlyLaterIngress: true,
          requiresCausalAtStrictlyAfterExpiry: true,
          receiptTimeTelemetryOnly: true,
          eligibleEventKinds: ["agg_trade", "final_kline_open"],
        },
        ...(boundaryEvent && terminalCausalAt(boundaryEvent.event) !== undefined
          ? {
            boundaryTrigger: {
              kind: boundaryEvent.event.kind,
              ingressSequence: boundaryEvent.ingressSequence,
              causalAt: iso(terminalCausalAt(boundaryEvent.event)!),
              receivedAt: iso(boundaryEvent.event.receivedAt),
              ...(terminalObservedPrice(boundaryEvent.event) !== undefined
                ? { observedPrice: terminalObservedPrice(boundaryEvent.event) }
                : {}),
              ...(boundaryEvent.event.kind === "agg_trade"
                ? { aggregateTradeId: boundaryEvent.event.aggregateTradeId }
                : {}),
              ...(boundaryEvent.event.kind === "kline"
                ? { klineOpenTime: iso(boundaryEvent.event.openTime) }
                : {}),
              digest: digest({
                runId: context.runId,
                symbol,
                decisionAt,
                ingressSequence: boundaryEvent.ingressSequence,
                event: boundaryEvent.event,
              }),
            },
          }
          : {}),
        candidateEventsObserved: 0,
        rejectedAtOrBeforeIngressBarrier: 0,
        rejectedAtOrBeforeExpiry: 0,
        lanes,
      };
      return terminalSettlement;
    };

    const queueTerminalBoundary = (
      scheduling: TerminalSettlementEvidence["scheduling"],
      eligibleAfterIngressSequence: number,
      boundaryEvent?: {
        event: BinanceMarketEvent;
        ingressSequence: number;
      },
    ): boolean => {
      if (terminalSettlement || terminalBoundaryQueued) return true;
      terminalBoundaryQueued = true;
      const queued = queue.push({
        kind: "expiry_boundary",
        scheduling,
        eligibleAfterIngressSequence,
        ...(boundaryEvent ? { boundaryEvent } : {}),
      });
      if (!queued) terminalBoundaryQueued = false;
      return queued;
    };

    const terminalFillCandidate = (
      event: BinanceMarketEvent,
    ): {
      kind: "agg_trade" | "final_kline_open";
      causalAt: number;
    } | undefined => (
      event.kind === "agg_trade"
        ? { kind: "agg_trade", causalAt: event.executedAt }
        : event.kind === "kline" && event.final
          ? { kind: "final_kline_open", causalAt: event.openTime }
          : undefined
    );

    const noteTerminalBoundary = (
      event: BinanceMarketEvent,
      ingressSequence: number,
    ): void => {
      const causalAt = terminalCausalAt(event);
      if (!terminalSettlement
        || terminalSettlement.boundaryTrigger
        || causalAt === undefined
        || causalAt <= expiresAt
        || ingressSequence <= terminalSettlement.barrier.eligibleAfterIngressSequence) return;
      terminalSettlement.boundaryTrigger = {
        kind: event.kind,
        ingressSequence,
        causalAt: iso(causalAt),
        receivedAt: iso(event.receivedAt),
        ...(terminalObservedPrice(event) !== undefined
          ? { observedPrice: terminalObservedPrice(event) }
          : {}),
        ...(event.kind === "agg_trade"
          ? { aggregateTradeId: event.aggregateTradeId }
          : {}),
        ...(event.kind === "kline"
          ? { klineOpenTime: iso(event.openTime) }
          : {}),
        digest: digest({
          runId: context.runId,
          symbol,
          decisionAt: expiresAt,
          ingressSequence,
          event,
        }),
      };
    };

    const noteTerminalCandidate = (
      event: BinanceMarketEvent,
      ingressSequence: number,
    ): void => {
      const candidateEvent = terminalFillCandidate(event);
      if (!terminalSettlement || !candidateEvent) return;
      noteTerminalBoundary(event, ingressSequence);
      terminalSettlement.candidateEventsObserved += 1;
      if (ingressSequence <= terminalSettlement.barrier.eligibleAfterIngressSequence) {
        terminalSettlement.rejectedAtOrBeforeIngressBarrier += 1;
      }
      if (candidateEvent.causalAt <= expiresAt) {
        terminalSettlement.rejectedAtOrBeforeExpiry += 1;
      }
      if (!terminalSettlement.fillBarrierEvent
        && ingressSequence > terminalSettlement.barrier.eligibleAfterIngressSequence
        && candidateEvent.causalAt > expiresAt) {
        const observedPrice = terminalObservedPrice(event);
        if (observedPrice === undefined) return;
        const barrierEvent = {
          kind: candidateEvent.kind,
          ingressSequence,
          causalAt: iso(candidateEvent.causalAt),
          receivedAt: iso(event.receivedAt),
          observedPrice,
          ...(event.kind === "agg_trade"
            ? { aggregateTradeId: event.aggregateTradeId }
            : {}),
          ...(event.kind === "kline"
            ? { klineOpenTime: iso(event.openTime) }
            : {}),
          digest: digest({
            runId: context.runId,
            symbol,
            ingressSequence,
            event,
          }),
        };
        terminalSettlement.fillBarrierEvent = barrierEvent;
        terminalSettlement.commonFillBarrierDigest = barrierEvent.digest;
      }
    };

    const reconcileTerminalRiskClosures = (
      event?: BinanceMarketEvent,
      ingressSequence?: number,
    ): void => {
      if (!terminalSettlement) return;
      for (const state of states.values()) {
        const pending = state.pending;
        if (pending?.action !== "reduce") continue;
        if (state.ledger.snapshot().positions.some((position) => position.symbol === symbol)) {
          continue;
        }
        const laneEvidence = terminalSettlement.lanes.find(
          (candidateLane) => candidateLane.lane === state.lane,
        );
        const fills = state.ledger.snapshot().fills;
        const postExpiryLiquidation = fills.slice(laneEvidence?.fillCountAtExpiry ?? 0)
          .reverse()
          .find((fill) => fill.action === "reduce" && fill.reason === "liquidation");
        if (postExpiryLiquidation) {
          pending.decision.status = "skipped";
          pending.decision.terminalSettlementOutcome = "superseded_by_liquidation";
          if (event?.kind === "mark_price"
            && ingressSequence !== undefined
            && postExpiryLiquidation.executedAt === event.eventTime
            && laneEvidence) {
            laneEvidence.fillEventKind = "mark_price_liquidation";
            laneEvidence.fillIngressSequence = ingressSequence;
            laneEvidence.fillReceivedAt = iso(event.receivedAt);
            laneEvidence.fillBarrierDigest = digest({
              runId: context.runId,
              symbol,
              ingressSequence,
              event,
            });
          }
        }
        state.pending = undefined;
      }
    };

    const enforceRisk = (
      event: BinanceMarketEvent,
      targetLanes?: ReadonlySet<SimulationModelLane>,
    ): void => {
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
        if (targetLanes && !targetLanes.has(state.lane)) continue;
        const position = state.ledger.snapshot().positions.find((item) => item.symbol === symbol);
        const eventIsAfterPosition = position !== undefined && (
          event.kind === "kline"
            ? event.openTime > position.openedAt
            : event.kind === "agg_trade"
              ? event.executedAt > position.openedAt
              : event.eventTime > position.openedAt
        );
        if (position && eventIsAfterPosition) {
          const crossed = position.side === "long"
            ? event.kind === "kline" && event.final
              ? event.low <= position.protectiveStopPrice
              : price !== undefined && price <= position.protectiveStopPrice
            : event.kind === "kline" && event.final
              ? event.high >= position.protectiveStopPrice
              : price !== undefined && price >= position.protectiveStopPrice;
          if (crossed) scheduleReduce(state, at, "protection");
        }
        const gate = observeDailyGate(
          state,
          state.ledger.snapshot().equity,
          at,
        );
        if (gate.closeAllReduceOnly
          || (input.portfolioDailyLossGate !== undefined && gate.blocked)) {
          scheduleReduce(state, at, "daily_loss_gate");
        }
      }
    };

    const applyCanonicalFundingSettlement = (
      state: LaneState,
      settlement: CanonicalFundingSettlement,
    ): boolean => {
      const consumed = consumedFundingSettlements.get(state.lane)!;
      if (consumed.has(settlement.eventId)) return false;
      const beforeMark = state.ledger.snapshot();
      const position = beforeMark.positions.find((candidate) => candidate.symbol === symbol);
      if (!position || position.openedAt >= settlement.eventAt) return false;

      // Funding is valued from the last accepted mark before the canonical
      // funding boundary. Both ordinary positions and delayed finalized-kline
      // opens consume this same immutable settlement.
      state.ledger.mark(
        symbol,
        settlement.settlementMarkPrice,
        settlement.eventAt,
      );
      const afterMark = state.ledger.snapshot();
      if (afterMark.fills.length > beforeMark.fills.length) {
        state.riskGeneration += afterMark.fills.length - beforeMark.fills.length;
      }
      consumed.add(settlement.eventId);
      if (!afterMark.positions.some((candidate) => candidate.symbol === symbol)) {
        return true;
      }
      try {
        state.ledger.applyFunding({
          eventId: settlement.eventId,
          symbol,
          rate: settlement.rate,
          eventAt: settlement.eventAt,
        });
      } catch (error) {
        warnings.push(
          `${state.lane}:funding_rejected:`
            + `${error instanceof Error ? error.message : "unknown"}`,
        );
      }
      return true;
    };

    const applyCanonicalFundingSettlementsThrough = (
      ingressSequence: number,
    ): void => {
      for (const settlement of canonicalFundingSettlements) {
        if (settlement.triggerIngressSequence > ingressSequence) continue;
        for (const state of states.values()) {
          applyCanonicalFundingSettlement(state, settlement);
        }
      }
    };

    const replayFinalKlineOpenRiskEvidence = (
      bar: Extract<BinanceMarketEvent, { kind: "kline" }>,
      targetLanes: ReadonlySet<SimulationModelLane>,
    ): void => {
      finalKlineRiskEvidence.delete(bar.openTime);
      const evidence = finalKlineRiskEvidenceSnapshots.get(bar);
      finalKlineRiskEvidenceSnapshots.delete(bar);
      if (targetLanes.size === 0 || !evidence?.complete) return;
      const replayActions = [
        ...evidence.marks.map((item) => ({
          kind: "mark" as const,
          causalAt: item.event.eventTime,
          ingressSequence: item.ingressSequence,
          item,
        })),
        ...evidence.fundingSettlements.map((settlement) => ({
          kind: "funding" as const,
          causalAt: settlement.eventAt,
          ingressSequence: settlement.triggerIngressSequence,
          settlement,
        })),
      ].sort((left, right) => (
        left.causalAt - right.causalAt
        || (left.kind === right.kind ? 0 : left.kind === "funding" ? -1 : 1)
        || left.ingressSequence - right.ingressSequence
      ));
      for (const action of replayActions) {
        if (action.kind === "mark") {
          for (const state of states.values()) {
            if (!targetLanes.has(state.lane)) continue;
            const beforeMark = state.ledger.snapshot();
            const position = beforeMark.positions.find((candidate) => candidate.symbol === symbol);
            if (!position || action.item.event.eventTime <= position.openedAt) continue;
            state.ledger.mark(
              symbol,
              action.item.event.markPrice,
              action.item.event.eventTime,
            );
            const fillCountAfterMark = state.ledger.snapshot().fills.length;
            if (fillCountAfterMark > beforeMark.fills.length) {
              state.riskGeneration += fillCountAfterMark - beforeMark.fills.length;
            }
          }
          enforceRisk(action.item.event, targetLanes);
          continue;
        }
        for (const state of states.values()) {
          if (!targetLanes.has(state.lane)) continue;
          applyCanonicalFundingSettlement(state, action.settlement);
        }
        enforceRisk({
          ...action.settlement.triggerEvent,
          eventTime: action.settlement.eventAt,
          markPrice: action.settlement.settlementMarkPrice,
          indexPrice: action.settlement.settlementMarkPrice,
        }, targetLanes);
      }
    };

    const applyMarkAndFunding = (event: BinanceMarketEvent): void => {
      if (event.kind !== "mark_price") return;
      currentMarkPrice = event.markPrice;
      currentMarkPriceObservedAt = event.eventTime;
      for (const state of states.values()) {
        const beforeMark = state.ledger.snapshot();
        const position = beforeMark.positions.find((item) => item.symbol === symbol);
        if (position && event.eventTime <= position.openedAt) continue;
        const fillCountBeforeMark = beforeMark.fills.length;
        state.ledger.mark(symbol, event.markPrice, event.eventTime);
        const fillCountAfterMark = state.ledger.snapshot().fills.length;
        if (fillCountAfterMark > fillCountBeforeMark) {
          state.riskGeneration += fillCountAfterMark - fillCountBeforeMark;
        }
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
          forecast.actualReturn = actual;
          forecast.resolvedAt = iso(bar.closeTime);
        }
      }
    };

    const performInference = async (
      bar: BinanceKline,
      id: number,
      inferenceStreamEpoch: number,
      trigger: {
        decisionAt: number;
        decisionPrice: number;
        priceObservedAt: number;
      },
    ): Promise<RuntimeInferenceCompletion> => {
      const bars = modelContext();
      if (!bars.length || bars.at(-1)!.openTime !== bar.openTime) {
        throw new Error("inference_origin_not_latest_final_bar");
      }
      if (!highFrequencyHighVol && bar.openTime <= lastInferredOpenTime) {
        throw new Error("inference_origin_already_processed");
      }
      if (!highFrequencyHighVol) lastInferredOpenTime = bar.openTime;
      const liveDecisionOriginAt = iso(trigger.decisionAt);
      const causalLiveBookTicker = latestBookTicker
        && latestBookTicker.eventTime <= trigger.decisionAt
        ? {
          observedAt: iso(latestBookTicker.eventTime),
          bidPrice: latestBookTicker.bidPrice,
          bidQuantity: latestBookTicker.bidQuantity,
          askPrice: latestBookTicker.askPrice,
          askQuantity: latestBookTicker.askQuantity,
        }
        : undefined;
      const causalLiveTrades = recentAggregateTrades.filter((trade) => (
        trade.executedAt <= trigger.decisionAt
        && trade.executedAt > trigger.decisionAt - MINUTE_MS
      ));
      const causalLiveTradeStats = causalLiveTrades.length
        ? {
          observedAt: iso(Math.max(...causalLiveTrades.map((trade) => trade.executedAt))),
          buyVolume: causalLiveTrades
            .filter((trade) => !trade.buyerWasMaker)
            .reduce((sum, trade) => sum + trade.quantity, 0),
          sellVolume: causalLiveTrades
            .filter((trade) => trade.buyerWasMaker)
            .reduce((sum, trade) => sum + trade.quantity, 0),
        }
        : undefined;
      const decisionSpreadBps = currentSpreadBps;
      const currentAtr = Math.max(
        atr14(bars),
        selected.atrPercent14 * bar.close,
      );
      const currentVolatility = Math.max(
        realizedVolatility(bars),
        selected.realizedVolatility60m,
      );
      const outcomes = new Map<SimulationModelLane, RuntimeLaneInferenceOutcome>();
      const riskGenerations = new Map(selectedLanes.map((lane) => [
        lane,
        states.get(lane)!.riskGeneration,
      ]));
      const inferenceController = new AbortController();
      activeInferenceController = inferenceController;
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
      lastTriggeredAt = iso(trigger.decisionAt);
      try {
        const technicalBars = decisionStore.list(symbol)
          .filter((candidate) => candidate.final && candidate.closeTime <= bar.closeTime)
          .slice(-CRYPTO_RUST_MAX_INPUT_BARS);
        let rustTechnical: CryptoRustTechnicalAnalysis | undefined;
        let rustLiveMarketEvidence: CryptoLiveRustMarketEvidence | undefined;
        let rustTechnicalError: string | undefined;
        if (this.options.technicalAnalyzer) {
          const technicalOriginCloseTime = technicalBars.at(-1)?.closeTime;
          const cached = technicalOriginCloseTime === undefined
            ? undefined
            : rustTechnicalCache?.originCloseTime === technicalOriginCloseTime
              ? rustTechnicalCache
              : undefined;
          if (cached?.status === "available") {
            rustTechnical = cached.analysis;
          } else if (cached?.status === "failed") {
            rustTechnicalError = cached.error;
          } else if (technicalOriginCloseTime !== undefined) {
            try {
              rustTechnical = await raceWithAbort(
                this.options.technicalAnalyzer.analyze({
                  symbol,
                  bars: technicalBars,
                  preset: request.preset,
                  ...(latestBookTicker
                    && latestBookTicker.eventTime <= bar.closeTime
                    && bar.closeTime - latestBookTicker.eventTime <= 60_000
                    ? {
                      orderbook: {
                        observedAt: iso(latestBookTicker.eventTime),
                        bidPrice: latestBookTicker.bidPrice,
                        bidQuantity: latestBookTicker.bidQuantity,
                        askPrice: latestBookTicker.askPrice,
                        askQuantity: latestBookTicker.askQuantity,
                      },
                    }
                    : {}),
                  ...(() => {
                    const causalTrades = recentAggregateTrades.filter((trade) => (
                      trade.executedAt <= bar.closeTime
                      && trade.executedAt > bar.closeTime - 60_000
                    ));
                    if (!causalTrades.length) return {};
                    const buyVolume = causalTrades
                      .filter((trade) => !trade.buyerWasMaker)
                      .reduce((sum, trade) => sum + trade.quantity, 0);
                    const sellVolume = causalTrades
                      .filter((trade) => trade.buyerWasMaker)
                      .reduce((sum, trade) => sum + trade.quantity, 0);
                    return {
                      tradeStats: {
                        observedAt: iso(Math.max(
                          ...causalTrades.map((trade) => trade.executedAt),
                        )),
                        buyVolume,
                        sellVolume,
                      },
                    };
                  })(),
                  signal: inferenceController.signal,
                }),
                inferenceController.signal,
              );
              rustTechnicalCache = {
                originCloseTime: technicalOriginCloseTime,
                status: "available",
                analysis: rustTechnical,
              };
            } catch {
              rustTechnicalError = "rust_technical_analysis_failed";
              rustTechnicalCache = {
                originCloseTime: technicalOriginCloseTime,
                status: "failed",
                error: "rust_technical_analysis_failed",
              };
            }
          } else {
            rustTechnicalError = "rust_technical_analysis_failed";
          }
        }
        if (highFrequencyHighVol && rustTechnical) {
          try {
            rustLiveMarketEvidence = composeCryptoLiveRustMarketEvidence({
              baseEvidence: rustTechnical.marketEvidence,
              decisionOriginAt: liveDecisionOriginAt,
              ...(causalLiveBookTicker ? { bookTicker: causalLiveBookTicker } : {}),
              ...(causalLiveTradeStats ? { tradeStats: causalLiveTradeStats } : {}),
            });
          } catch {
            rustTechnicalError = "rust_live_market_evidence_failed";
          }
        }
        const targetStop = cryptoTargetStop(rustTechnical);
        const laneRequests = new Map(selectedLanes.map((lane) => {
          const laneBars = cryptoModelContextForLane(lane, bars);
          return [lane, aiRequest(
            context.runId,
            symbol,
            laneBars,
            targetStop,
            request.simulationCase !== undefined,
            highFrequencyHighVol ? trigger.decisionAt : undefined,
          )] as const;
        }));
        const requestDigest = digest(Object.fromEntries(
          selectedLanes.map((lane) => [lane, laneRequests.get(lane)!]),
        ));
        for (const lane of selectedLanes) {
          const state = states.get(lane)!;
          const attemptAt = this.clock.now();
          if (state.circuitOpenUntil !== undefined && attemptAt < state.circuitOpenUntil) {
            outcomes.set(lane, {
              attemptAt,
              error: "worker_circuit_open",
              incrementsFailure: false,
              timedOut: false,
            });
            continue;
          }
          const client = this.options.laneClients[lane];
          if (!client) {
            outcomes.set(lane, {
              attemptAt,
              error: "worker_unavailable",
              incrementsFailure: true,
              timedOut: false,
              failureObservedAt: attemptAt,
            });
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
              this.requestLane(
                lane,
                client,
                structuredClone(laneRequests.get(lane)!),
                inferenceController.signal,
              ),
              inferenceController.signal,
            );
            await cancellationCheckpoint();
            const normalizedForecast = normalizeLaneForecast(
              lane,
              raw,
              laneRequests.get(lane)!,
            );
            const forecast = highFrequencyHighVol
              ? rebaseLaneForecastToLivePrice(
                normalizedForecast,
                bar.close,
                trigger.decisionPrice,
                currentVolatility,
                decisionSpreadBps,
              )
              : normalizedForecast;
            const observedLatency = Math.max(0, this.clock.now() - before);
            outcomes.set(lane, {
              attemptAt,
              forecast,
              observedLatency,
              incrementsFailure: false,
              timedOut: false,
            });
          } catch (error) {
            await cancellationCheckpoint();
            const reason = safeModelErrorCode(
              error instanceof Error ? error.message : "model_call_failed",
            );
            outcomes.set(lane, {
              attemptAt,
              error: reason,
              incrementsFailure: true,
              timedOut: isTimeout(error),
              failureObservedAt: this.clock.now(),
            });
          }
        }
        return {
          id,
          streamEpoch: inferenceStreamEpoch,
          bar,
          bars,
          decisionAt: trigger.decisionAt,
          decisionPrice: trigger.decisionPrice,
          priceObservedAt: trigger.priceObservedAt,
          requestDigest,
          outcomes,
          riskGenerations,
          decisionSpreadBps,
          currentAtr,
          currentVolatility,
          technicalBars,
          ...(rustTechnical ? { rustTechnical } : {}),
          ...(rustLiveMarketEvidence ? { rustLiveMarketEvidence } : {}),
          ...(rustTechnicalError ? { rustTechnicalError } : {}),
        };
      } finally {
        clearTimeout(deadlineTimer);
        context.signal.removeEventListener("abort", onContextAbort);
        if (activeInferenceController === inferenceController) {
          activeInferenceController = undefined;
        }
        inferenceInFlight = false;
      }
    };

    const commitInference = (
      completion: RuntimeInferenceCompletion,
      forcedBlockReason?: string,
    ): void => {
      const {
        bar,
        decisionAt,
        decisionPrice,
        priceObservedAt,
        requestDigest,
        outcomes,
        riskGenerations,
        decisionSpreadBps,
        currentAtr,
        currentVolatility,
        technicalBars,
        rustTechnical,
        rustLiveMarketEvidence,
        rustTechnicalError,
      } = completion;
      const commonDecisionAt = Math.max(
        decisionAt,
        this.clock.now(),
        ...Array.from(outcomes.values()).flatMap((item) => (
          item.forecast ? [item.forecast.generatedAt] : []
        )),
      );
      const decisionOriginAt = iso(decisionAt);
      const decisionIngressWatermark = lastIngressSequence;
      const epochInvalid = completion.streamEpoch !== streamEpoch;
      const lifecycleBlockReason = forcedBlockReason
        ?? (epochInvalid
          ? decisionLifecycleBlockReason() ?? "stream_epoch_changed"
          : decisionLifecycleBlockReason());

      if (epochInvalid) {
        for (const lane of selectedLanes) {
          decisions.push({
            id: decisionId(lane, commonDecisionAt),
            lane,
            symbol,
            originAt: decisionOriginAt,
            decisionAt: iso(commonDecisionAt),
            fillEligibleAfter: iso(commonDecisionAt),
            action: "none",
            status: "blocked",
            reason: lifecycleBlockReason ?? "stream_epoch_changed",
            requestDigest,
          });
        }
        return;
      }

      const newlyAddedForecasts: RuntimeForecastObservation[] = [];
      for (const lane of selectedLanes) {
        const state = states.get(lane)!;
        const outcome = outcomes.get(lane);
        if (!outcome) continue;
        state.attempts += 1;
        if (outcome.forecast && !laneModelProvenanceIsConsistent(state, outcome.forecast)) {
          outcome.forecast = undefined;
          outcome.error = "model_provenance_inconsistent";
          outcome.incrementsFailure = true;
          outcome.timedOut = false;
          outcome.failureObservedAt = this.clock.now();
        }
        if (outcome.forecast) {
          const forecast = outcome.forecast;
          state.successes += 1;
          state.consecutiveFailures = 0;
          state.circuitOpenUntil = undefined;
          state.latencies.push(forecast.latencyMs ?? outcome.observedLatency ?? 0);
          state.precision = forecast.precision;
          state.modelId = forecast.modelId;
          state.modelRevision = forecast.modelRevision;
          state.sourceRevision = forecast.sourceRevision;
          state.loaderVersion = forecast.loaderVersion;
          state.license = forecast.license;
          state.tokenizerId = forecast.tokenizerId;
          state.tokenizerRevision = forecast.tokenizerRevision;
          state.loaded = forecast.loaded;
          state.device = forecast.device;
          state.deviceName = forecast.deviceName;
          state.cudaCapability = forecast.cudaCapability;
          state.attentionBackend = forecast.attentionBackend;
          state.precisionValidation = forecast.precisionValidation;
          state.memoryStatus = forecast.memoryStatus;
          state.quantileMonotonicityPolicy = forecast.quantileMonotonicityPolicy;
          state.fp32QuantileObservations = forecast.fp32QuantileObservations;
          state.mixedQuantileObservations = forecast.mixedQuantileObservations;
          state.quantileTailPolicy = forecast.quantileTailPolicy;
          state.precisionFailureReasons = [...forecast.precisionFailureReasons];
          state.peakVramBytes = maximumDefined(
            state.peakVramBytes,
            forecast.peakVramBytes,
          );
          state.peakVramMeasurement = forecast.peakVramMeasurement;
          state.peakVramMb = maximumDefined(state.peakVramMb, forecast.peakVramMb);
          for (const distribution of forecast.horizonDistributions) {
            const targetAt = forecast.displayPoints.find(
              (point) => point.horizonMinutes === distribution.horizonMinutes,
            )?.targetTimestamp;
            const observation: RuntimeForecastObservation = {
              ...forecast,
              quantiles: distribution.quantiles,
              horizonMinutes: distribution.horizonMinutes,
              displayOriginAt: decisionOriginAt,
              inputOriginPrice: bar.close,
              originPrice: decisionPrice,
              priceObservedAt: iso(priceObservedAt),
              projectionPolicy: highFrequencyHighVol
                ? "live_price_rebase/v1"
                : "native_input_origin",
              targetAt: targetAt === undefined
                ? bar.closeTime + distribution.horizonMinutes * MINUTE_MS
                : Date.parse(targetAt),
              evaluated: false,
            };
            state.forecasts.push(observation);
            newlyAddedForecasts.push(observation);
          }
          if (state.forecasts.length > MAX_RUNTIME_FORECAST_OBSERVATIONS_PER_LANE) {
            state.forecasts.splice(
              0,
              state.forecasts.length - MAX_RUNTIME_FORECAST_OBSERVATIONS_PER_LANE,
            );
          }
        } else {
          const reason = outcome.error ?? "worker_unavailable";
          state.errors.push(reason);
          if (outcome.incrementsFailure) {
            state.consecutiveFailures += 1;
            if (state.consecutiveFailures >= this.circuitFailureThreshold) {
              state.circuitOpenUntil = (
                outcome.failureObservedAt ?? outcome.attemptAt
              ) + this.circuitCooldownMs;
            }
          }
          if (outcome.timedOut) state.timeoutCount += 1;
        }
      }

      if (newlyAddedForecasts.length) {
        const observedFinalBars = decisionStore.list(symbol);
        const earliestTarget = Math.min(...newlyAddedForecasts.map((item) => item.targetAt));
        const targetBar = observedFinalBars.find((item) => item.closeTime >= earliestTarget);
        if (targetBar) settleForecasts(targetBar);
      }

      const observedCostRate = costRate(request, decisionSpreadBps);
      const policyRustEvidence = highFrequencyHighVol
        ? rustLiveMarketEvidence?.marketEvidence
        : rustTechnical?.marketEvidence;
      if (rustLiveMarketEvidence) {
        liveRustMarketEvidence.push(rustLiveMarketEvidence);
        if (liveRustMarketEvidence.length > 300) {
          liveRustMarketEvidence.splice(0, liveRustMarketEvidence.length - 300);
        }
      }
      const technical = cryptoTechnicalObservation(
        technicalBars,
        request.preset,
        rustTechnical,
        rustTechnicalError,
      );
      const evidenceCosts: EvidenceCostBreakdown = {
        commissionBps: request.costs.commissionBpsPerSide * 2,
        spreadBps: decisionSpreadBps,
        slippageBps: request.costs.slippageBpsPerSide * 2,
        fundingBps: 0,
        safetyMarginBps: 1,
      };
      const routedEvidence = commonModelEvidence({
        request,
        symbol,
        originAt: decisionOriginAt,
        outcomes,
        states,
        ...(rustTechnical ? { rustTechnical } : {}),
        ...(policyRustEvidence ? { rustMarketEvidence: policyRustEvidence } : {}),
        ...(this.options.loadCalibrationResiduals
          ? { loadCalibrationResiduals: this.options.loadCalibrationResiduals }
          : {}),
        costs: evidenceCosts,
      });
      routedModelEvidence.push(...routedEvidence);
      if (routedModelEvidence.length > 2_000) {
        routedModelEvidence.splice(0, routedModelEvidence.length - 2_000);
      }
      const primaryPlan = modelPlan.find((plan) => (
        plan.role === "primary"
        && (plan.symbol === "*" || plan.symbol.toUpperCase() === symbol)
      ));
      const primaryState = primaryPlan ? states.get(primaryPlan.modelLane) : undefined;
      let unifiedDecision: UnifiedPolicyDecision | undefined;
      if (
        primaryPlan
        && primaryState
      ) {
        const ledger = primaryState.ledger.snapshot();
        const position = ledger.positions.find((item) => item.symbol === symbol);
        const lastUnified = unifiedPolicyDecisions.at(-1);
        const lastExit = [...ledger.fills].reverse().find((fill) => fill.action === "reduce");
        const consecutiveLosses = [...ledger.fills]
          .reverse()
          .filter((fill) => fill.action === "reduce")
          .findIndex((fill) => fill.realizedPnl >= 0);
        const policyState: UnifiedPolicyState = {
          currentDirection: position?.side ?? "cash",
          ...(position ? { positionOpenedAt: iso(position.openedAt) } : {}),
          ...(lastExit ? {
            lastExitAt: iso(lastExit.executedAt),
            lastDirection: lastExit.side,
          } : {}),
          ...(lastUnified?.selectedHorizonMinutes === null
            || lastUnified?.selectedHorizonMinutes === undefined
            ? {}
            : {
              lastHorizonMinutes: lastUnified.selectedHorizonMinutes,
              ...(lastUnified.horizonScore === null
                ? {}
                : { lastHorizonScore: lastUnified.horizonScore }),
            }),
          tradeTimestamps: ledger.fills.map((fill) => iso(fill.executedAt)),
          dailyTurnoverRate: ledger.fills.reduce(
            (sum, fill) => sum + fill.notional,
            0,
          ) / Math.max(ledger.equity, 1),
        };
        const previousBar = technicalBars.at(-2);
        unifiedDecision = decideUnifiedSimulationPolicy({
          simulationCase: request.simulationCase,
          symbol,
          originAt: decisionOriginAt,
          modelPlan,
          modelEvidence: routedEvidence,
          ...(policyRustEvidence ? { rustEvidence: policyRustEvidence } : {}),
          costs: evidenceCosts,
          state: policyState,
          sizing: {
            equity: ledger.equity,
            volatilityTargetRate: 0.01,
            lossBudgetRate: riskLimits.riskPerTradeRate,
            bookParticipationRate: 0.01,
            symbolExposureCapRate: 0.5,
            grossExposureCapRate: riskLimits.grossExposureLimitRate,
            marginUsageCapRate: riskLimits.marginUsageLimitRate,
            maximumLeverage: riskLimits.maximumLeverage,
          },
          circuit: {
            dailyLossRate: currentDailyGate(primaryState).drawdownRate,
            consecutiveLosses: consecutiveLosses < 0
              ? ledger.fills.filter((fill) => (
                fill.action === "reduce" && fill.realizedPnl < 0
              )).length
              : consecutiveLosses,
            referenceSpreadBps: selected.spreadBps,
            ...(policyRustEvidence?.orderbookDepth === null
              || policyRustEvidence?.orderbookDepth === undefined
              ? {}
              : { referenceDepth: policyRustEvidence.orderbookDepth }),
            ...(policyRustEvidence?.realizedVolatility === null
              || policyRustEvidence?.realizedVolatility === undefined
              ? {}
              : {
                realizedVolatilityBaseline:
                  policyRustEvidence.realizedVolatility,
              }),
            ...(previousBar
              ? { priceGapRate: Math.abs(bar.open / previousBar.close - 1) }
              : {}),
            missingData: !klineDataHealthy || policyRustEvidence === undefined,
          },
        });
        unifiedPolicyDecisions.push(unifiedDecision);
      }
      for (const lane of selectedLanes) {
        const state = states.get(lane)!;
        const outcome = outcomes.get(lane);
        if (!outcome?.forecast) {
          decisions.push({
            id: decisionId(lane, commonDecisionAt),
            lane,
            symbol,
            originAt: decisionOriginAt,
            decisionAt: iso(commonDecisionAt),
            fillEligibleAfter: iso(commonDecisionAt),
            action: "none",
            status: "unavailable",
            reason: outcome?.error ?? "worker_unavailable",
            requestDigest,
          });
          continue;
        }
        const role = modelPlanForLane(request, symbol, lane)?.role ?? "primary";
        if (role !== "primary") {
          decisions.push({
            id: decisionId(lane, commonDecisionAt),
            lane,
            symbol,
            originAt: decisionOriginAt,
            generatedAt: outcome.forecast.generatedAtIso,
            decisionAt: iso(commonDecisionAt),
            fillEligibleAfter: iso(commonDecisionAt),
            action: "none",
            status: "skipped",
            reason: role === "shadow" ? "shadow_observation_only" : "veto_observation_only",
            requestDigest,
          });
          continue;
        }
        const selectedDistribution = unifiedDecision?.selectedHorizonMinutes === null
          || unifiedDecision?.selectedHorizonMinutes === undefined
          ? outcome.forecast.horizonDistributions[0]!
          : outcome.forecast.horizonDistributions.find(
            (distribution) => (
              distribution.horizonMinutes === unifiedDecision!.selectedHorizonMinutes
            ),
          ) ?? outcome.forecast.horizonDistributions[0]!;
        const routedQuantiles = selectedDistribution.quantiles;
        const legacySignal = signalFromQuantileCdf({
          quantiles: routedQuantiles,
          roundTripCostRate: observedCostRate,
          realizedVolatilityRate: currentVolatility,
          spreadBps: decisionSpreadBps,
          mode: "paper",
        });
        const signal: QuantileDirectionSignal = unifiedDecision
          ? {
            direction: unifiedDecision.direction === "long"
              || unifiedDecision.direction === "short"
              ? unifiedDecision.direction
              : "flat",
            probabilityAboveCost: unifiedDecision.pNetLong ?? 0,
            probabilityBelowNegativeCost: unifiedDecision.pNetShort ?? 0,
            confidence: Math.max(
              unifiedDecision.pNetLong ?? 0,
              unifiedDecision.pNetShort ?? 0,
            ),
            leverageTier: legacySignal.leverageTier,
          }
          : legacySignal;
        const fusion = fuseForecastWithTechnical({
          lane,
          modelDirection: signal.direction,
          modelConfidence: signal.confidence,
          modelOriginAt: decisionOriginAt,
          modelGeneratedAt: outcome.forecast.generatedAtIso,
          ...(this.options.technicalAnalyzer ? {
            technical: {
              originAt: technical.originAt,
              calculationAt: technical.calculationAt,
              ...(technical.eligibleAfter
                ? { eligibleAfter: technical.eligibleAfter } : {}),
              quality: technical.quality,
              directionalSignal: technical.directionalSignal,
              confidence: technical.confidence,
              multiTimeframeAgreement: technical.multiTimeframeAgreement,
              indicators: technical.indicators,
              patternBias: technical.chartPatternBias,
              patternStrength: technical.chartPatternStrength,
            },
          } : {}),
          maximumTechnicalAgeMs: subminuteFinCast ? 90_000 : 2 * MINUTE_MS,
          technicalBoundaryToleranceMs: 1,
        });
        const modelEvidence = cryptoModelEvidence({
          forecast: outcome.forecast,
          direction: signal.direction,
          roundTripCostRate: observedCostRate,
          realizedVolatilityRate: currentVolatility,
        });
        const entryDecisionAt = Math.max(
          commonDecisionAt,
          Date.parse(fusion.eligibleAfter),
        );
        const baseDecision: RuntimeDecision = {
          id: decisionId(lane, commonDecisionAt),
          lane,
          symbol,
          originAt: decisionOriginAt,
          generatedAt: outcome.forecast.generatedAtIso,
          decisionAt: iso(commonDecisionAt),
          fillEligibleAfter: iso(commonDecisionAt),
          action: "none",
          direction: signal.direction,
          confidence: signal.confidence,
          probabilityAboveCost: signal.probabilityAboveCost,
          probabilityBelowNegativeCost: signal.probabilityBelowNegativeCost,
          roundTripCostRate: observedCostRate,
          technicalState: technical.state,
          chartPatternBias: technical.chartPatternBias,
          chartPatterns: [...technical.chartPatterns],
          chartPatternStrength: technical.chartPatternStrength,
          fusionPolicyVersion: FORECAST_TECHNICAL_FUSION_VERSION,
          technicalScore: fusion.technicalScore,
          technicalDirection: fusion.technicalDirection,
          exposureScale: fusion.exposureScale,
          modelEvidenceScale: modelEvidence.exposureScale,
          modelProbabilityMethod: outcome.forecast.probabilityMethod,
          modelVolatilityMethod: outcome.forecast.volatilityMethod,
          modelValidPathCount: outcome.forecast.validPathCount,
          modelInvalidPathCount: outcome.forecast.invalidPathCount,
          ...(technical.originAt ? { technicalOriginAt: technical.originAt } : {}),
          ...(technical.scalpingEngineVersion
            ? { technicalEngineVersion: technical.scalpingEngineVersion } : {}),
          ...(technical.indicatorEngineVersion
            ? { indicatorEngineVersion: technical.indicatorEngineVersion } : {}),
          ...(technical.scannerEvidence
            ? { technicalScannerEvidence: technical.scannerEvidence } : {}),
          components: {
            confidence: signal.confidence,
            minimumConfidence: policyProfile.minimumConfidence,
            ...technical.components,
            ...fusion.components,
            ...modelEvidence.components,
            ...(unifiedDecision?.selectedHorizonMinutes === null
              || unifiedDecision?.selectedHorizonMinutes === undefined
              ? {}
              : {
                unifiedHorizonMinutes: unifiedDecision.selectedHorizonMinutes,
                unifiedHorizonScore: unifiedDecision.horizonScore ?? 0,
                unifiedPositionRate: unifiedDecision.positionSizing.selectedRate,
              }),
          },
          status: "held",
          reason: "flat_signal",
          requestDigest,
        };
        if (riskGenerations.get(lane) !== state.riskGeneration) {
          baseDecision.status = "blocked";
          baseDecision.reason = "position_changed_during_inference";
          decisions.push(baseDecision);
          continue;
        }
        if (commonDecisionAt - bar.closeTime > modelIntervalMs) {
          baseDecision.status = "blocked";
          baseDecision.reason = "model_stale";
          decisions.push(baseDecision);
          continue;
        }
        if (lifecycleBlockReason !== undefined) {
          baseDecision.status = "blocked";
          baseDecision.reason = lifecycleBlockReason;
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
        if (unifiedDecision?.direction === "cash") {
          baseDecision.status = position ? "pending" : "blocked";
          baseDecision.reason = unifiedDecision.reasons[0] ?? "unified_policy_no_trade";
          if (position) {
            baseDecision.action = "reduce";
            state.pending = {
              action: "reduce",
              decision: baseDecision,
              decisionAt: commonDecisionAt,
              eligibleAfterIngressSequence: decisionIngressWatermark,
              reason: "signal",
            };
          }
          decisions.push(baseDecision);
          continue;
        }
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
            eligibleAfterIngressSequence: decisionIngressWatermark,
            reason: "signal",
          };
          continue;
        }
        if (currentDailyGate(state).blocked) {
          baseDecision.status = "blocked";
          baseDecision.reason = "daily_loss_gate";
          decisions.push(baseDecision);
          continue;
        }
        if (signal.confidence < policyProfile.minimumConfidence) {
          baseDecision.status = "blocked";
          baseDecision.reason = "preset_confidence_gate";
          decisions.push(baseDecision);
          continue;
        }
        if (!fusion.admitted) {
          baseDecision.status = "blocked";
          baseDecision.reason = fusion.reasonCodes[0] ?? "technical_fusion_blocked";
          decisions.push(baseDecision);
          continue;
        }
        if (!modelEvidence.admitted) {
          baseDecision.status = "blocked";
          baseDecision.reason = modelEvidence.reasonCodes[0] ?? "model_evidence_blocked";
          decisions.push(baseDecision);
          continue;
        }
        if (policyProfile.technicalConfirmationRequired
          && technical.direction !== signal.direction) {
          baseDecision.status = "blocked";
          baseDecision.reason = technical.direction === "flat"
            ? "technical_confirmation_unavailable"
            : "technical_direction_conflict";
          decisions.push(baseDecision);
          continue;
        }
        const adverseQuantileDistance = signal.direction === "long"
          ? Math.max(
            0,
            -(routedQuantiles.find((item) => item.quantile === 0.1)?.returnRate ?? 0),
          ) * decisionPrice
          : Math.max(
            0,
            routedQuantiles.find((item) => item.quantile === 0.9)?.returnRate ?? 0,
          ) * decisionPrice;
        const sizing = sizeFuturesPosition({
          mode: "paper",
          side: signal.direction,
          equity: ledger.equity,
          currentGrossExposure: ledger.grossExposure,
          currentMargin: ledger.totalIsolatedMargin,
          price: decisionPrice,
          atr14: currentAtr,
          adverseQuantileDistance,
          spreadBps: decisionSpreadBps,
          slippageBpsPerSide: request.costs.slippageBpsPerSide,
          requestedLeverage: Math.min(
            signal.leverageTier,
            policyProfile.maximumLeverage,
            riskLimits.maximumLeverage,
          ),
          limits: riskLimits,
          rules,
        });
        const unifiedQuantityCap = unifiedDecision
          ? unifiedDecision.positionSizing.selectedNotional / decisionPrice
          : Number.POSITIVE_INFINITY;
        const policyQuantity = floorToStep(
          Math.min(sizing.quantity, unifiedQuantityCap)
            * policyProfile.targetAllocationRate
            * fusion.exposureScale
            * modelEvidence.exposureScale,
          rules.stepSize,
        );
        baseDecision.action = signal.direction === "long" ? "open_long" : "open_short";
        baseDecision.id = decisionId(lane, entryDecisionAt);
        baseDecision.decisionAt = iso(entryDecisionAt);
        baseDecision.fillEligibleAfter = iso(entryDecisionAt);
        baseDecision.leverage = sizing.leverage;
        baseDecision.quantity = policyQuantity;
        baseDecision.notional = policyQuantity * decisionPrice;
        baseDecision.protectiveStopPrice = sizing.protectiveStopPrice;
        if (!sizing.accepted
          || policyQuantity < rules.minQuantity
          || policyQuantity * decisionPrice < rules.minNotional) {
          baseDecision.status = "blocked";
          baseDecision.reason = `risk_${sizing.reason ?? "policy_allocation_below_minimum"}`;
          decisions.push(baseDecision);
          continue;
        }
        baseDecision.status = "pending";
        baseDecision.reason = "cost_exceeding_quantile_signal";
        decisions.push(baseDecision);
        state.pending = {
          action: "open",
          decision: baseDecision,
          decisionAt: entryDecisionAt,
          eligibleAfterIngressSequence: decisionIngressWatermark,
          side: signal.direction,
          quantity: policyQuantity,
          leverage: sizing.leverage,
          protectiveStopPrice: sizing.protectiveStopPrice,
          atr14: currentAtr,
          adverseQuantileDistance,
          spreadBps: decisionSpreadBps,
        };
      }
    };

    const recordBlockedFinalDecision = (
      bar: BinanceKline,
      reason: string,
      triggerAt = bar.closeTime,
    ): void => {
      const bars = modelContext()
        .filter((candidateBar) => candidateBar.openTime <= bar.openTime)
        .slice(-this.contextBars);
      const requestDigest = bars.length
        ? digest(aiRequest(
          context.runId,
          symbol,
          bars,
          null,
          request.simulationCase !== undefined,
          highFrequencyHighVol ? triggerAt : undefined,
        ))
        : "";
      const at = Math.max(triggerAt, this.clock.now());
      triggeredEvents += 1;
      lastTriggeredAt = iso(triggerAt);
      for (const lane of selectedLanes) {
        decisions.push({
          id: decisionId(lane, at),
          lane,
          symbol,
          originAt: iso(triggerAt),
          decisionAt: iso(at),
          fillEligibleAfter: iso(at),
          action: "none",
          status: "blocked",
          reason,
          requestDigest,
        });
      }
    };

    const launchInference = (
      bar: BinanceKline,
      trigger: {
        decisionAt: number;
        decisionPrice: number;
        priceObservedAt: number;
      } = {
        decisionAt: bar.closeTime,
        decisionPrice: bar.close,
        priceObservedAt: bar.closeTime,
      },
    ): void => {
      if (inferenceTask) {
        if (highFrequencyHighVol) {
          coalescedFinalKlines += 1;
          return;
        }
        if (!coalescedInferenceBar || bar.openTime > coalescedInferenceBar.openTime) {
          if (coalescedInferenceBar) coalescedFinalKlines += 1;
          coalescedInferenceBar = bar;
        } else {
          coalescedFinalKlines += 1;
        }
        return;
      }
      const id = ++inferenceSequence;
      const inferenceStreamEpoch = streamEpoch;
      inferenceTask = performInference(bar, id, inferenceStreamEpoch, trigger)
        .then((completion) => {
          readyInferenceCompletion = completion;
        })
        .catch((error: unknown) => {
          inferenceFailure = error;
        })
        .finally(() => {
          if (!acceptInferenceCompletions || closing) return;
          if (!queue.push({ kind: "inference_complete" })) {
            const error = new Error("market_event_queue_overflow");
            inferenceFailure = error;
            streamDisconnected = { error };
            streamEpoch += 1;
            enterReconnectSafety();
            queue.fail(error);
          }
        });
    };
    const maybeLaunchHighFrequencyInference = (): void => {
      if (!highFrequencyHighVol || !liveWindowStarted || terminalSettlement) return;
      const at = this.clock.now();
      if (at < nextHighFrequencyInferenceAt || at >= expiresAt) return;
      const elapsedIntervals = Math.floor(
        (at - nextHighFrequencyInferenceAt) / HIGH_VOL_CRYPTO_INFERENCE_INTERVAL_MS,
      );
      if (elapsedIntervals > 0) coalescedFinalKlines += elapsedIntervals;
      nextHighFrequencyInferenceAt += (
        elapsedIntervals + 1
      ) * HIGH_VOL_CRYPTO_INFERENCE_INTERVAL_MS;
      const bar = latestModelBar();
      if (!bar) return;
      if (inferenceTask) {
        coalescedFinalKlines += 1;
        return;
      }
      const reason = decisionLifecycleBlockReason(at);
      if (reason) {
        recordBlockedFinalDecision(bar, reason, at);
        return;
      }
      launchInference(bar, {
        decisionAt: at,
        decisionPrice: currentMarkPrice,
        priceObservedAt: currentMarkPriceObservedAt,
      });
    };
    const yieldToImmediateInferenceCompletion = async (): Promise<void> => {
      if (!inferenceTask) return;
      // A resolved worker progresses through several promise continuations
      // (request, abort race, normalization, and completion publication).
      // Give those microtasks a bounded turn before a deterministic clock is
      // allowed to advance to a later market event. A genuinely pending worker
      // remains non-blocking and the consumer continues draining on this poll.
      const maximumTurns = selectedLanes.length * 8 + 8;
      for (let turn = 0; turn < maximumTurns && inferenceTask; turn += 1) {
        await Promise.resolve();
        if (readyInferenceCompletion !== undefined || inferenceFailure !== undefined) {
          // The launch promise's finally handler publishes the reducer token
          // in the following microtask.
          await Promise.resolve();
          break;
        }
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
          ingressObservedAts.set(event, this.clock.now());
          if (liveWindowStarted
            && !terminalSettlement
            && !terminalBoundaryQueued
            && this.clock.now() >= expiresAt) {
            const causalAt = terminalCausalAt(event);
            const isCausalBoundary = causalAt !== undefined && causalAt > expiresAt;
            // Queue an ordered control token before the first post-expiry
            // market event. Pre-expiry reducer backlog stays ahead of the
            // decision, while this event can never fall behind the watermark.
            if (!queueTerminalBoundary(
              isCausalBoundary ? "expiry_boundary_event" : "expiry_timeout",
              Math.max(0, ingressSequence - 1),
              isCausalBoundary ? { event, ingressSequence } : undefined,
            )) {
              const error = new Error("market_event_queue_overflow");
              streamDisconnected = { error };
              streamEpoch += 1;
              enterReconnectSafety();
              activeInferenceController?.abort(error);
              queue.fail(error);
              return;
            }
          }
          ingressStore.applyWebsocket(event);
          if (subminuteFinCast && event.kind === "agg_trade") {
            const aggregateTrade: BinanceAggregateTrade = {
              aggregateTradeId: Number(event.aggregateTradeId),
              price: event.price,
              quantity: event.quantity,
              executedAt: event.executedAt,
              buyerWasMaker: event.buyerWasMaker,
            };
            if (fincastMicroAggregator) {
              for (const completedBar of fincastMicroAggregator.accept(aggregateTrade)) {
                appendFinCastMicroBar(completedBar);
                if (liveWindowStarted && !queue.push({
                  kind: "model_bar",
                  bar: completedBar,
                })) {
                  const error = new Error("market_event_queue_overflow");
                  streamDisconnected = { error };
                  streamEpoch += 1;
                  enterReconnectSafety();
                  activeInferenceController?.abort(error);
                  queue.fail(error);
                  return;
                }
              }
            } else {
              bufferedSetupAggregateTrades.push(aggregateTrade);
              if (bufferedSetupAggregateTrades.length > 10_000) {
                bufferedSetupAggregateTrades.splice(
                  0,
                  bufferedSetupAggregateTrades.length - 10_000,
                );
              }
            }
          }
          let acceptedIngressMarkPrice = true;
          if (event.kind === "book_ticker") {
            const acceptedIngressBook = lastIngressBookTickerEventTime === undefined
              || event.eventTime >= lastIngressBookTickerEventTime;
            if (acceptedIngressBook) {
              lastIngressBookTickerEventTime = event.eventTime;
              const midpoint = (event.bidPrice + event.askPrice) / 2;
              if (midpoint > 0) {
                ingressSpreadBps = (event.askPrice - event.bidPrice) / midpoint * 10_000;
              }
            }
          }
          if (event.kind === "mark_price") {
            acceptedIngressMarkPrice = lastIngressMarkPriceEventTime === undefined
              || event.eventTime >= lastIngressMarkPriceEventTime;
            if (acceptedIngressMarkPrice) {
              lastIngressMarkPriceEventTime = event.eventTime;
              bufferFinalKlineRiskEvidence(event, ingressSequence);
              bufferCanonicalFundingSettlement(event, ingressSequence);
            }
          }
          if (event.kind === "kline" && event.final) {
            freezeFinalKlineRiskEvidence(event, ingressSequence);
          }
          if (event.kind === "agg_trade") {
            const needed = Array.from(states.values()).some((state) => (
              Boolean(state.pending) || state.ledger.snapshot().positions.length > 0
            ));
            if (!needed) {
              queue.noteIgnoredAggTrade();
              return;
            }
          }
          const fillObservation = event.kind === "agg_trade"
            ? { price: event.price, causalAt: event.executedAt }
            : event.kind === "kline" && event.final
              ? { price: event.open, causalAt: event.openTime }
              : undefined;
          const fillCandidates = fillObservation
            ? Array.from(states.values()).filter((state) => (
              state.pending !== undefined
              && ingressSequence > state.pending.eligibleAfterIngressSequence
              && (state.pending.terminalSettlement
                || event.receivedAt > state.pending.decisionAt)
              && fillObservation.causalAt > state.pending.decisionAt
              && prospectivePendingOpenRisk.get(state.lane)?.pendingKey
                !== `${state.pending.eligibleAfterIngressSequence}:${state.pending.side ?? ""}`
            ))
            : [];
          const fillCandidate = fillCandidates.length > 0;
          if (fillObservation) {
            for (const state of fillCandidates) {
              const pending = state.pending;
              if (pending?.action !== "open"
                || pending.side === undefined
                || pending.leverage === undefined
                || pending.protectiveStopPrice === undefined
                || pending.atr14 === undefined
                || pending.adverseQuantileDistance === undefined
                || pending.spreadBps === undefined) continue;
              const pendingKey = `${pending.eligibleAfterIngressSequence}:${pending.side}`;
              if (prospectivePendingOpenRisk.get(state.lane)?.pendingKey === pendingKey) {
                continue;
              }
              const slippageRate = request.costs.slippageBpsPerSide / 10_000;
              const expectedEntryPrice = pending.side === "long"
                ? ceilToStep(fillObservation.price * (1 + slippageRate), rules.tickSize)
                : floorToStep(fillObservation.price * (1 - slippageRate), rules.tickSize);
              const latest = state.ledger.snapshot();
              const prospectiveSizing = sizeFuturesPosition({
                mode: "paper",
                side: pending.side,
                equity: latest.equity,
                currentGrossExposure: latest.grossExposure,
                currentMargin: latest.totalIsolatedMargin,
                price: expectedEntryPrice,
                atr14: pending.atr14,
                adverseQuantileDistance: pending.adverseQuantileDistance,
                spreadBps: event.kind === "kline"
                  ? pending.spreadBps
                  : Math.max(pending.spreadBps, ingressSpreadBps),
                slippageBpsPerSide: request.costs.slippageBpsPerSide,
                requestedLeverage: pending.leverage,
                limits: riskLimits,
                rules,
              });
              const prospectiveProtectiveStop = prospectiveSizing.accepted
                ? prospectiveSizing.protectiveStopPrice
                : pending.protectiveStopPrice;
              prospectivePendingOpenRisk.set(state.lane, {
                pendingKey,
                fillIngressSequence: ingressSequence,
                fillCausalAt: fillObservation.causalAt,
                protectiveStopPrice: pending.side === "long"
                  ? Math.max(pending.protectiveStopPrice, prospectiveProtectiveStop)
                  : Math.min(pending.protectiveStopPrice, prospectiveProtectiveStop),
                estimatedLiquidationPrice: estimatedLiquidationPrice(
                  pending.side,
                  expectedEntryPrice,
                  prospectiveSizing.accepted
                    ? prospectiveSizing.leverage
                    : pending.leverage,
                  rules.maintenanceMarginRate,
                ),
              });
            }
          }
          const fillBarrierKey = fillCandidate
            ? fillCandidates
              .map((state) => (
                `${state.lane}:${state.pending!.action}:${state.pending!.eligibleAfterIngressSequence}`
              ))
              .sort()
              .join("|")
            : undefined;
          const markRiskBarrierKey = event.kind === "mark_price" && acceptedIngressMarkPrice
            ? Array.from(states.values()).flatMap((state) => {
              const positionKeys = state.ledger.snapshot().positions.flatMap((position) => {
                if (position.symbol !== symbol) return [];
                const liquidationCrossed = position.side === "long"
                  ? event.markPrice <= position.estimatedLiquidationPrice
                  : event.markPrice >= position.estimatedLiquidationPrice;
                const protectionCrossed = position.side === "long"
                  ? event.markPrice <= position.protectiveStopPrice
                  : event.markPrice >= position.protectiveStopPrice;
                const tier = event.eventTime <= position.openedAt
                  ? undefined
                  : liquidationCrossed
                    ? "liquidation"
                    : protectionCrossed
                      ? "protection"
                      : undefined;
                return tier
                  ? [
                    `${state.lane}:position:${position.openedAt}`
                      + `:${position.side}:${tier}`,
                  ]
                  : [];
              });
              const pending = state.pending;
              const pendingKey = pending?.action === "open" && pending.side !== undefined
                ? `${pending.eligibleAfterIngressSequence}:${pending.side}`
                : undefined;
              const prospective = pendingKey
                && prospectivePendingOpenRisk.get(state.lane)?.pendingKey === pendingKey
                ? prospectivePendingOpenRisk.get(state.lane)
                : undefined;
              const pendingProtectionThreshold = pending?.action === "open"
                && pending.side !== undefined
                && pending.protectiveStopPrice !== undefined
                ? pending.side === "long"
                  ? Math.max(
                    pending.protectiveStopPrice,
                    prospective?.protectiveStopPrice ?? Number.NEGATIVE_INFINITY,
                  )
                  : Math.min(
                    pending.protectiveStopPrice,
                    prospective?.protectiveStopPrice ?? Number.POSITIVE_INFINITY,
                  )
                : undefined;
              const pendingCausallyValid = pending?.action === "open"
                && pending.side !== undefined
                && (prospective === undefined
                  || event.eventTime > prospective.fillCausalAt);
              const pendingLiquidationCrossed = pendingCausallyValid
                && prospective !== undefined
                && (pending.side === "long"
                  ? event.markPrice <= prospective.estimatedLiquidationPrice
                  : event.markPrice >= prospective.estimatedLiquidationPrice);
              const pendingProtectionCrossed = pendingCausallyValid
                && pendingProtectionThreshold !== undefined
                && (pending.side === "long"
                  ? event.markPrice <= pendingProtectionThreshold
                  : event.markPrice >= pendingProtectionThreshold);
              const pendingTier = pendingLiquidationCrossed
                ? "liquidation"
                : pendingProtectionCrossed
                  ? "protection"
                  : undefined;
              return [
                ...positionKeys,
                ...(pendingTier
                  ? [
                    `${state.lane}:pending:${pendingKey!}:`
                      + `${prospective?.fillIngressSequence ?? "before_fill"}`
                      + `:${pendingTier}`,
                  ]
                  : []),
              ];
            }).sort().join("|") || undefined
            : undefined;
          if (!queue.push(event, {
            ingressSequence,
            fillCandidate,
            ...(fillBarrierKey ? { fillBarrierKey } : {}),
            ...(markRiskBarrierKey ? { markRiskBarrierKey } : {}),
          })) {
            const error = new Error("market_event_queue_overflow");
            streamDisconnected = { error };
            streamEpoch += 1;
            enterReconnectSafety();
            activeInferenceController?.abort(error);
            queue.fail(error);
          }
        },
        (error) => {
          if (closing || streamDisconnected) return;
          const disconnectError = error instanceof Error
            ? error
            : new Error("public_stream_disconnected");
          streamDisconnected = { error: disconnectError };
          streamEpoch += 1;
          enterReconnectSafety();
          activeInferenceController?.abort(disconnectError);
          if (!queue.push({ kind: "disconnect", error: disconnectError })) {
            queue.fail(disconnectError);
          }
        },
        (state) => {
          if (closing || streamDisconnected) return;
          if (state.status === "reconnecting") {
            streamEpoch += 1;
            enterReconnectSafety();
            if (subminuteFinCast) {
              fincastMicroAggregator = undefined;
              bufferedSetupAggregateTrades.length = 0;
            }
            activeInferenceController?.abort(new Error("public_stream_reconnecting"));
          }
          if (!queue.push({ kind: "connection_state", state })) {
            const error = new Error("market_event_queue_overflow");
            streamDisconnected = { error };
            streamEpoch += 1;
            enterReconnectSafety();
            activeInferenceController?.abort(error);
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
      if (this.options.technicalAnalyzer) {
        // The neural context remains bounded at 512. Rust scanner metrics need
        // five prior complete UTC sessions, so backfill a separate causal
        // technical window in bounded Binance pages.
        const maximumPages = Math.ceil(CRYPTO_RUST_MAX_INPUT_BARS / MAXIMUM_RESTORED_BARS);
        for (let page = 1; page < maximumPages; page += 1) {
          await cancellationCheckpoint();
          const before = decisionStore.list(symbol);
          if (before.length >= CRYPTO_RUST_MAX_INPUT_BARS) break;
          const earliestOpenTime = before[0]?.openTime;
          if (earliestOpenTime === undefined || earliestOpenTime <= 0) break;
          const earlierRaw = await this.options.rest.klines({
            symbol,
            endTime: earliestOpenTime - 1,
            limit: MAXIMUM_RESTORED_BARS,
          });
          const boundedEarlier = Array.isArray(earlierRaw)
            ? earlierRaw.slice(-MAXIMUM_RESTORED_BARS)
            : earlierRaw;
          decisionStore.applyRest(symbol, boundedEarlier, this.clock.now());
          const nextEarliestOpenTime = decisionStore.list(symbol)[0]?.openTime;
          if (
            nextEarliestOpenTime === undefined
            || nextEarliestOpenTime >= earliestOpenTime
          ) {
            break;
          }
        }
      }
      const restored = decisionStore.list(symbol);
      if (!hasContinuousFinalContext(restored, this.contextBars)) {
        throw new CryptoPaperRuntimeError(
          "invalid_runtime_input",
          `Binance REST recovery did not return ${this.contextBars} continuous final one-minute bars.`,
        );
      }
      if (subminuteFinCast) {
        const completedThrough = (
          Math.floor(this.clock.now() / modelIntervalMs) * modelIntervalMs
        ) - 1;
        fincastMicroBars = await loadFinCastMicroContext({
          symbol,
          intervalSeconds: modelCandleSeconds as FinCastMicroCandleSeconds,
          contextBars: this.contextBars,
          endTime: completedThrough,
          signal: context.signal,
          aggregateTrades: (aggregateInput) => (
            this.options.rest.aggregateTrades!(aggregateInput)
          ),
        });
        if (!hasContinuousFinalContext(
          fincastMicroBars,
          this.contextBars,
          modelIntervalMs,
        )) {
          throw new CryptoPaperRuntimeError(
            "invalid_runtime_input",
            `Binance aggregate-trade recovery did not return ${this.contextBars} continuous final ${modelCandleSeconds}-second bars.`,
          );
        }
        fincastMicroAggregator = new FinCastMicroCandleAggregator(
          symbol,
          modelCandleSeconds as FinCastMicroCandleSeconds,
          fincastMicroBars.at(-1),
        );
        for (const aggregateTrade of bufferedSetupAggregateTrades
          .filter((trade) => trade.executedAt > fincastMicroBars.at(-1)!.closeTime)
          .sort((left, right) => (
            left.executedAt - right.executedAt
            || left.aggregateTradeId - right.aggregateTradeId
          ))) {
          for (const completedBar of fincastMicroAggregator.accept(aggregateTrade)) {
            appendFinCastMicroBar(completedBar);
          }
        }
        bufferedSetupAggregateTrades.length = 0;
      }
      startedAt = this.clock.now();
      expiresAt = startedAt + request.durationMinutes * MINUTE_MS;
      lastRiskClockAt = startedAt;
      if (streamQualificationState === "initializing") {
        streamQualificationState = "qualified";
      }
      for (const state of states.values()) {
        state.dailyGate = observeDailyGate(
          state,
          request.initialCash,
          startedAt,
        );
        state.equity = [{
          timestamp: iso(startedAt),
          equity: request.initialCash,
          drawdown: 0,
        }];
        state.equityPeak = request.initialCash;
        state.maximumDrawdown = 0;
        state.lastEquitySampleAt = startedAt;
      }
      liveDecisionStartAt = startedAt;
      liveWindowStarted = true;
      if (highFrequencyHighVol) {
        nextHighFrequencyInferenceAt = (
          Math.floor(startedAt / HIGH_VOL_CRYPTO_INFERENCE_INTERVAL_MS) + 1
        ) * HIGH_VOL_CRYPTO_INFERENCE_INTERVAL_MS;
      }
      await updateProgress(true);
      await publishSnapshot("running", true, liveDecisionStartAt);

      while (!terminalSettlement) {
        await cancellationCheckpoint();
        await yieldToImmediateInferenceCompletion();
        maybeLaunchHighFrequencyInference();
        if (this.clock.now() >= expiresAt && !terminalBoundaryQueued) {
          if (!queueTerminalBoundary("expiry_timeout", lastIngressSequence)) {
            const error = new Error("market_event_queue_overflow");
            streamDisconnected = { error };
            streamEpoch += 1;
            enterReconnectSafety();
            activeInferenceController?.abort(error);
            queue.fail(error);
          }
        }
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
              if (klineDataHealthy && subminuteFinCast) {
                const completedThrough = (
                  Math.floor(observedAt / modelIntervalMs) * modelIntervalMs
                ) - 1;
                fincastMicroBars = await loadFinCastMicroContext({
                  symbol,
                  intervalSeconds: modelCandleSeconds as FinCastMicroCandleSeconds,
                  contextBars: this.contextBars,
                  endTime: completedThrough,
                  signal: context.signal,
                  aggregateTrades: (aggregateInput) => (
                    this.options.rest.aggregateTrades!(aggregateInput)
                  ),
                });
                klineDataHealthy = hasContinuousFinalContext(
                  fincastMicroBars,
                  this.contextBars,
                  modelIntervalMs,
                );
                fincastMicroAggregator = new FinCastMicroCandleAggregator(
                  symbol,
                  modelCandleSeconds as FinCastMicroCandleSeconds,
                  fincastMicroBars.at(-1),
                );
                for (const aggregateTrade of bufferedSetupAggregateTrades
                  .filter((trade) => trade.executedAt > fincastMicroBars.at(-1)!.closeTime)
                  .sort((left, right) => (
                    left.executedAt - right.executedAt
                    || left.aggregateTradeId - right.aggregateTradeId
                  ))) {
                  for (const completedBar of fincastMicroAggregator.accept(aggregateTrade)) {
                    appendFinCastMicroBar(completedBar);
                  }
                }
                bufferedSetupAggregateTrades.length = 0;
              }
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
        if (queued.kind === "inference_complete") {
          const completedTask = inferenceTask;
          if (completedTask) await completedTask;
          inferenceTask = undefined;
          const failure = inferenceFailure;
          inferenceFailure = undefined;
          const completion = readyInferenceCompletion;
          readyInferenceCompletion = undefined;
          if (failure !== undefined) throw failure;
          if (completion) commitInference(completion);

          const nextBar = coalescedInferenceBar;
          coalescedInferenceBar = undefined;
          if (nextBar && this.clock.now() < expiresAt) {
            const latestFinalOpenTime = latestModelBar()?.openTime;
            if (latestFinalOpenTime !== nextBar.openTime) {
              coalescedFinalKlines += 1;
              recordBlockedFinalDecision(nextBar, "inference_origin_superseded");
            } else {
              const reason = decisionLifecycleBlockReason();
              if (reason) recordBlockedFinalDecision(nextBar, reason);
              else launchInference(nextBar);
            }
          }
          recordEquity(this.clock.now());
          await updateProgress();
          await publishSnapshot("running", true, this.clock.now());
          continue;
        }
        if (queued.kind === "expiry_boundary") {
          scheduleTerminalSettlement(
            queued.scheduling,
            queued.eligibleAfterIngressSequence,
            queued.boundaryEvent,
          );
          continue;
        }
        if (queued.kind === "model_bar") {
          const bar = queued.bar;
          if (
            subminuteFinCast
            && bar.final
            && bar.openTime > lastProcessedFinalOpenTime
          ) {
            lastProcessedFinalOpenTime = bar.openTime;
            const reason = decisionLifecycleBlockReason();
            if (reason) {
              discardCoalescedInference();
              recordBlockedFinalDecision(bar, reason);
            } else {
              launchInference(bar);
            }
          }
          await updateProgress();
          await publishSnapshot("running", false, this.clock.now());
          continue;
        }
        const event = queued;
        let filled = false;
        let riskEventAccepted = true;
        const eventIngressSequence = ingressSequences.get(event);
        if (eventIngressSequence !== undefined) {
          noteTerminalCandidate(event, eventIngressSequence);
        }
        if (eventIngressSequence !== undefined) {
          applyCanonicalFundingSettlementsThrough(eventIngressSequence);
        }

        if (event.kind === "book_ticker") {
          riskEventAccepted = lastBookTickerEventTime === undefined
            || event.eventTime >= lastBookTickerEventTime;
          if (riskEventAccepted) {
            latestBookTicker = event;
            lastBookTickerEventTime = event.eventTime;
            lastBookTickerObservedAt = event.receivedAt;
            const midpoint = (event.bidPrice + event.askPrice) / 2;
            currentSpreadBps = midpoint > 0
              ? (event.askPrice - event.bidPrice) / midpoint * 10_000
              : currentSpreadBps;
          }
        }
        if (event.kind === "agg_trade") {
          recentAggregateTrades.push(event);
          const cutoff = event.executedAt - 2 * MINUTE_MS;
          while (
            recentAggregateTrades[0]
            && recentAggregateTrades[0].executedAt < cutoff
          ) recentAggregateTrades.shift();
        }
        if (event.kind === "mark_price") {
          riskEventAccepted = lastMarkPriceEventTime === undefined
            || event.eventTime >= lastMarkPriceEventTime;
          if (riskEventAccepted) {
            lastMarkPriceEventTime = event.eventTime;
            lastMarkPriceObservedAt = event.receivedAt;
          }
        }
        maybeCompleteStreamRequalification();
        if (riskEventAccepted) applyMarkAndFunding(event);
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
        const positionedBeforeFinalFill = event.kind === "kline" && event.final
          ? new Set(Array.from(states.values()).flatMap((state) => (
            state.ledger.snapshot().positions.some((position) => position.symbol === symbol)
              ? [state.lane]
              : []
          )))
          : undefined;
        filled = executePending(event);
        if (!subminuteFinCast && event.kind === "kline" && event.final) {
          const newlyOpenedLanes = new Set(Array.from(states.values()).flatMap((state) => {
            if (positionedBeforeFinalFill?.has(state.lane)) return [];
            const position = state.ledger.snapshot().positions.find(
              (candidatePosition) => candidatePosition.symbol === symbol,
            );
            return position?.openedAt === event.openTime ? [state.lane] : [];
          }));
          replayFinalKlineOpenRiskEvidence(event, newlyOpenedLanes);
        }
        if (riskEventAccepted) enforceRisk(event);
        reconcileTerminalRiskClosures(event, eventIngressSequence);
        if (event.kind === "kline" && event.final) {
          settleForecasts(event);
          if (event.receivedAt >= liveDecisionStartAt
            && event.openTime > lastProcessedFinalOpenTime) {
            lastProcessedFinalOpenTime = event.openTime;
            if (!highFrequencyHighVol) {
              const reason = decisionLifecycleBlockReason();
              if (reason) {
                discardCoalescedInference();
                recordBlockedFinalDecision(event, reason);
              }
              else launchInference(event);
            }
          }
        }
        recordEquity(this.clock.now());
        const forceSnapshot = filled || (event.kind === "kline" && event.final);
        await updateProgress();
        await publishSnapshot("running", forceSnapshot, this.clock.now());
      }

      acceptInferenceCompletions = false;
      coalescedInferenceBar = undefined;
      activeInferenceController?.abort(new Error("crypto_runtime_expiry_deadline_exceeded"));
      if (inferenceTask) {
        await inferenceTask;
        inferenceTask = undefined;
      }
      if (inferenceFailure !== undefined) throw inferenceFailure;
      if (readyInferenceCompletion) {
        commitInference(readyInferenceCompletion, "runtime_expired");
        readyInferenceCompletion = undefined;
      }
      await cancellationCheckpoint();

      const settlement = scheduleTerminalSettlement(
        "expiry_timeout",
        lastIngressSequence,
      );
      const settlementDeadlineAt = expiresAt + TERMINAL_SETTLEMENT_GRACE_MS;
      let settlementFailureDetail:
        | "terminal_settlement_no_causal_fill"
        | "terminal_settlement_stream_epoch_changed"
        | "terminal_settlement_stream_desync"
        | "terminal_settlement_fill_rejected" = "terminal_settlement_no_causal_fill";
      const hasUnsettledPosition = (): boolean => settlement.lanes.some((lane) => (
        lane.required
        && states.get(lane.lane)!.ledger.snapshot().positions.some(
          (position) => position.symbol === symbol,
        )
      ));

      while (hasUnsettledPosition() && this.clock.now() < settlementDeadlineAt) {
        await cancellationCheckpoint();
        if (streamDisconnected) {
          settlementFailureDetail = "terminal_settlement_stream_desync";
          break;
        }
        if (streamEpoch !== settlement.decisionStreamEpoch) {
          settlementFailureDetail = "terminal_settlement_stream_epoch_changed";
          break;
        }
        const waitMs = Math.min(
          this.pollIntervalMs,
          Math.max(0, settlementDeadlineAt - this.clock.now()),
        );
        const queued = await queue.next(waitMs, this.clock, context.signal);
        if (!queued) {
          await updateProgress();
          await publishSnapshot("running", false, this.clock.now());
          continue;
        }
        if (queued.kind === "disconnect") {
          settlementFailureDetail = "terminal_settlement_stream_desync";
          break;
        }
        if (queued.kind === "connection_state") {
          if (queued.state.status === "reconnecting" || queued.state.reconnectAttempt > 0) {
            settlementFailureDetail = "terminal_settlement_stream_epoch_changed";
            break;
          }
          continue;
        }
        if (queued.kind === "inference_complete") continue;
        if (queued.kind === "expiry_boundary") continue;
        if (queued.kind === "model_bar") continue;
        if (streamEpoch !== settlement.decisionStreamEpoch) {
          settlementFailureDetail = "terminal_settlement_stream_epoch_changed";
          break;
        }
        const ingressSequence = ingressSequences.get(queued);
        if (ingressSequence === undefined) continue;
        noteTerminalBoundary(queued, ingressSequence);
        applyCanonicalFundingSettlementsThrough(ingressSequence);
        let riskEventAccepted = true;
        if (queued.kind === "book_ticker") {
          riskEventAccepted = lastBookTickerEventTime === undefined
            || queued.eventTime >= lastBookTickerEventTime;
          if (riskEventAccepted) {
            lastBookTickerEventTime = queued.eventTime;
            lastBookTickerObservedAt = queued.receivedAt;
            const midpoint = (queued.bidPrice + queued.askPrice) / 2;
            currentSpreadBps = midpoint > 0
              ? (queued.askPrice - queued.bidPrice) / midpoint * 10_000
              : currentSpreadBps;
          }
        }
        if (queued.kind === "mark_price") {
          riskEventAccepted = lastMarkPriceEventTime === undefined
            || queued.eventTime >= lastMarkPriceEventTime;
          if (riskEventAccepted) {
            lastMarkPriceEventTime = queued.eventTime;
            lastMarkPriceObservedAt = queued.receivedAt;
          }
        }
        maybeCompleteStreamRequalification();
        if (riskEventAccepted) {
          applyMarkAndFunding(queued);
          enforceRisk(queued);
        }
        reconcileTerminalRiskClosures(queued, ingressSequence);
        const candidate = terminalFillCandidate(queued);
        if (!candidate) {
          recordEquity(this.clock.now());
          await updateProgress();
          await publishSnapshot("running", false, this.clock.now());
          continue;
        }
        noteTerminalCandidate(queued, ingressSequence);
        const filled = executePending(queued);
        if (Array.from(states.values()).some((state) => (
          state.ledger.snapshot().positions.some((position) => position.symbol === symbol)
          && state.pending === undefined
        ))) {
          settlementFailureDetail = "terminal_settlement_fill_rejected";
          break;
        }
        recordEquity(this.clock.now());
        await updateProgress();
        await publishSnapshot("running", filled, this.clock.now());
      }

      for (const laneEvidence of settlement.lanes) {
        if (!laneEvidence.required) continue;
        const state = states.get(laneEvidence.lane)!;
        const decision = decisions.find(
          (candidateDecision) => candidateDecision.id === laneEvidence.decisionId,
        );
        const positionStillOpen = state.ledger.snapshot().positions.some(
          (position) => position.symbol === symbol,
        );
        if (!positionStillOpen) {
          const ledger = state.ledger.snapshot();
          const terminalFills = ledger.fills.slice(laneEvidence.fillCountAtExpiry ?? 0);
          const closingFill = decision?.fillId
            ? terminalFills.find((fill) => fill.fillId === decision.fillId)
            : terminalFills.find((fill) => fill.action === "reduce");
          laneEvidence.status = "settled";
          laneEvidence.settledBy = closingFill?.reason === "liquidation"
            ? "liquidation"
            : laneEvidence.decisionSource === "existing_risk_reduce"
              ? "existing_risk_reduce"
              : closingFill?.reason === "daily_loss_gate"
                  || closingFill?.reason === "protection"
                ? "risk_reduce"
                : "terminal_reduce";
          if (closingFill) {
            laneEvidence.fillId = closingFill.fillId;
            laneEvidence.executedAt = iso(closingFill.executedAt);
            laneEvidence.fillPrice = closingFill.price;
            laneEvidence.fee = closingFill.fee;
            laneEvidence.exitTax = closingFill.exitTax;
            laneEvidence.slippage = closingFill.slippageCost;
            laneEvidence.funding = closingFill.funding;
            laneEvidence.realizedPnl = closingFill.realizedPnl;
          } else {
            if (decision?.fillId) laneEvidence.fillId = decision.fillId;
            if (decision?.executedAt) laneEvidence.executedAt = decision.executedAt;
          }
          laneEvidence.remainingQuantity = ledger.positions
            .filter((position) => position.symbol === symbol)
            .reduce((sum, position) => sum + position.quantity, 0);
          if (decision?.fillEventKind) laneEvidence.fillEventKind = decision.fillEventKind;
          if (decision?.fillIngressSequence !== undefined) {
            laneEvidence.fillIngressSequence = decision.fillIngressSequence;
          }
          if (decision?.fillReceivedAt) laneEvidence.fillReceivedAt = decision.fillReceivedAt;
          if (decision?.fillBarrierDigest) {
            laneEvidence.fillBarrierDigest = decision.fillBarrierDigest;
          }
          continue;
        }
        laneEvidence.status = "unsettled_fail_closed";
        laneEvidence.unavailableReason = "terminal_settlement_unavailable";
        laneEvidence.remainingQuantity = state.ledger.snapshot().positions
          .filter((position) => position.symbol === symbol)
          .reduce((sum, position) => sum + position.quantity, 0);
        if (decision) {
          if (decision.status === "pending") decision.status = "blocked";
          decision.terminalSettlementFailureReason = settlementFailureDetail;
        }
        if (state.pending?.decision.id === laneEvidence.decisionId) {
          state.pending = undefined;
        }
      }
      settlement.settlementComplete = settlement.lanes.every(
        (lane) => !lane.required || lane.status === "settled",
      );
      const requiredSettlementDigests = settlement.lanes
        .filter((lane) => lane.required)
        .map((lane) => lane.fillBarrierDigest);
      if (requiredSettlementDigests.length > 0
        && requiredSettlementDigests[0] !== undefined
        && requiredSettlementDigests.every(
          (candidateDigest) => candidateDigest === requiredSettlementDigests[0],
        )) {
        settlement.commonFillBarrierDigest = requiredSettlementDigests[0];
      } else {
        delete settlement.commonFillBarrierDigest;
      }
      settlement.status = settlement.lanes.every((lane) => !lane.required)
        ? "not_required"
        : settlement.settlementComplete
          ? "settled"
          : "unsettled_fail_closed";
      if (!settlement.settlementComplete) {
        warnings.push("terminal_settlement_unavailable");
        warnings.push(`terminal_settlement_failure:${settlementFailureDetail}`);
      }
      const settlementStreamDesync = settlementFailureDetail
        === "terminal_settlement_stream_desync"
        || settlementFailureDetail === "terminal_settlement_stream_epoch_changed";
      const terminalObservedAt = this.clock.now();
      for (const state of states.values()) {
        state.dailyGate = observeDailyGate(
          state,
          state.ledger.snapshot().equity,
          terminalObservedAt,
        );
      }
      recordEquity(terminalObservedAt, true);
      await cancellationCheckpoint();
      const terminalPhase = settlement.settlementComplete ? "completed" : "failed";
      await updateProgress(true, settlement.settlementComplete);
      const terminalSnapshot = await publishSnapshot(terminalPhase, true, terminalObservedAt);
      const allTrades = selectedLanes.flatMap((lane) => (
        tradeRows(lane, states.get(lane)!.ledger.snapshot())
      ));
      const comparison = modelComparison();
      const provenance = selectedLanes.map((lane) => {
        const state = states.get(lane)!;
        const laneSettlement = settlement.lanes.find(
          (candidateLane) => candidateLane.lane === lane,
        );
        const settlementUnavailable = laneSettlement?.status === "unsettled_fail_closed";
        return {
          lane,
          status: settlementUnavailable ? "partial" : laneStatus(state),
          ...persistedLaneModelProvenance(state),
          attempts: state.attempts,
          successes: state.successes,
          errors: safeProvenanceErrorCodes([
            ...state.errors,
            ...(settlementUnavailable ? ["terminal_settlement_unavailable"] : []),
          ]),
        };
      });
      const executionLedger = states.get(executionLane)!.ledger.snapshot();
      const summary = {
        schemaVersion: AI_SIMULATION_CONTRACT_VERSION,
        phase: terminalPhase,
        market: request.market,
        currency: "USDT",
        initialCash: request.initialCash,
        finalEquity: executionLedger.equity,
        netProfitLoss: executionLedger.equity - request.initialCash,
        returnRatio: executionLedger.equity / request.initialCash - 1,
        tradeCount: executionLedger.fills.length,
        selectedSymbols: [symbol],
        executionLane,
        settlementComplete: settlement.settlementComplete,
        terminalSettlement: structuredClone(settlement),
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
              riskLimits,
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
            charts: terminalSnapshot.charts,
            modelForecasts: terminalSnapshot.modelForecasts,
            modelComparison: comparison,
            settlementComplete: settlement.settlementComplete,
            terminalSettlement: structuredClone(settlement),
            warnings: terminalSnapshot.warnings,
            evidence: {
              scannerSnapshotId: input.snapshot.scannerSnapshotId,
              restoredFinalBars: Math.min(restored.length, MAXIMUM_RESTORED_BARS),
              onlyFinalKlinesTriggerInference: true,
              fillRequiresStrictlyLaterEvent: true,
              settlementComplete: settlement.settlementComplete,
              terminalSettlement: structuredClone(settlement),
              maintenanceMargin: maintenanceMarginEvidence,
              realOrder: false,
            },
          },
        },
        warnings: terminalSnapshot.warnings,
        ...(!settlement.settlementComplete
          ? {
            terminalFailure: {
              code: "CRYPTO_TERMINAL_SETTLEMENT_INCOMPLETE" as const,
              message: `Terminal settlement failed closed: ${settlementFailureDetail}.`,
              retryable: true,
            },
          }
          : {}),
        artifacts: [
          {
            type: "simulation-decisions",
            content: {
              schemaVersion: AI_SIMULATION_CONTRACT_VERSION,
              symbol,
              decisions,
              unifiedPolicyDecisions,
              modelEvidence: routedModelEvidence,
              rustMarketEvidence: liveRustMarketEvidence,
              settlementComplete: settlement.settlementComplete,
              terminalSettlement: structuredClone(settlement),
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
              settlementComplete: settlement.settlementComplete,
              terminalSettlement: structuredClone(settlement),
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
              simulationCase: request.simulationCase,
              normalizedRequest: request,
              modelPlan,
              scannerSnapshotId: input.snapshot.scannerSnapshotId,
              executionLane,
              modelLanes: provenance,
              settlementComplete: settlement.settlementComplete,
              terminalSettlement: structuredClone(settlement),
              maintenanceMargin: maintenanceMarginEvidence,
              runtime: CRYPTO_PAPER_RUNTIME_COORDINATOR_REQUIREMENTS,
              policyVersions: {
                unified: UNIFIED_STRATEGY_POLICY_VERSION,
                router: MODEL_ROUTER_POLICY_VERSION,
                veto: VETO_POLICY_VERSION,
                horizon: DYNAMIC_HORIZON_POLICY_VERSION,
                sizing: POSITION_SIZING_POLICY_VERSION,
                circuitBreaker: CIRCUIT_BREAKER_POLICY_VERSION,
              },
            },
            rowCount: provenance.length,
          },
          {
            type: "simulation-diagnostics",
            content: {
              schemaVersion: AI_SIMULATION_CONTRACT_VERSION,
              snapshot: terminalSnapshot,
              settlementComplete: settlement.settlementComplete,
              terminalSettlement: structuredClone(settlement),
              terminalSettlementFailureDetail: settlement.settlementComplete
                ? undefined
                : settlementFailureDetail,
              restoredFinalBars: Math.min(restored.length, MAXIMUM_RESTORED_BARS),
              marketDataHealthy: !settlementStreamDesync
                && klineDataHealthy
                && riskStreamFreshness(terminalObservedAt).healthy,
              marketDataBlockReason: settlementStreamDesync
                ? "stream_desync"
                : entryBlockReason(terminalObservedAt),
              klineDataHealthy,
              klineDataBlockReason,
              riskStreams: riskStreamFreshness(terminalObservedAt),
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
              streamDesync: settlementStreamDesync,
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
      acceptInferenceCompletions = false;
      coalescedInferenceBar = undefined;
      streamEpoch += 1;
      activeInferenceController?.abort(
        context.signal.aborted
          ? abortReason(context.signal, "Crypto paper runtime was aborted.")
          : new Error("crypto_runtime_closing"),
      );
      if (subscription) {
        try {
          await subscription.close();
        } catch (error) {
          warnings.push(`stream_close_failed:${error instanceof Error ? error.message : "unknown"}`);
        }
      }
      if (inferenceTask) {
        await inferenceTask;
        inferenceTask = undefined;
      }
      readyInferenceCompletion = undefined;
      inferenceFailure = undefined;
    }
  }

  private aggregatePortfolioSnapshots(
    runId: string,
    request: SimulationStartRequest,
    snapshots: readonly CryptoPaperRuntimeSnapshot[],
    portfolioDailyLossGate?: PortfolioDailyLossGate,
  ): CryptoPaperRuntimeSnapshot {
    if (!snapshots.length) {
      throw new Error("portfolio_snapshot_unavailable");
    }
    const initialCash = snapshots.reduce((sum, snapshot) => sum + snapshot.initialCash, 0);
    const cash = snapshots.reduce((sum, snapshot) => sum + snapshot.cash, 0);
    const equity = snapshots.reduce((sum, snapshot) => sum + snapshot.equity, 0);
    const riskLimits = request.riskLimits ?? DEFAULT_CRYPTO_FUTURES_RISK_LIMITS;
    const startedAt = new Date(Math.min(
      ...snapshots.map((snapshot) => Date.parse(snapshot.startedAt)),
    )).toISOString();
    const expiresAt = new Date(Math.max(
      ...snapshots.map((snapshot) => Date.parse(snapshot.expiresAt)),
    )).toISOString();
    const firstSnapshot = snapshots[0]!;
    const portfolioDailyGate = portfolioDailyLossGate?.state(firstSnapshot.executionLane);
    const nonDailyBlock = snapshots.find((snapshot) => (
      snapshot.futuresRisk.newEntriesBlocked
      && !snapshot.futuresRisk.blockReason?.startsWith("UTC 일손실")
    ));
    const weightedRatio = (select: (snapshot: CryptoPaperRuntimeSnapshot) => number) => (
      snapshots.reduce((sum, snapshot) => sum + select(snapshot) * snapshot.equity, 0)
      / Math.max(Number.EPSILON, equity)
    );
    const modelForecasts = snapshots.flatMap((snapshot) => (
      Array.isArray(snapshot.modelForecasts) ? snapshot.modelForecasts : []
    ));
    const lanes = request.modelLanes.map((lane) => {
      const laneValues = snapshots.flatMap((snapshot) => {
        const comparison = record(snapshot.modelComparison);
        const values = first(comparison, "lanes");
        if (!Array.isArray(values)) return [];
        const found = values.map(record).find((item) => first(item, "id", "lane") === lane);
        return found ? [found] : [];
      });
      const aggregatedProvenance = aggregatePortfolioLaneProvenance(
        laneValues,
        snapshots.length,
      );
      const aggregatedMetrics = aggregatePortfolioLaneMetrics(
        laneValues,
        snapshots.length,
      );
      return {
        id: lane,
        status: !aggregatedProvenance.consistent || !aggregatedMetrics.consistent
          ? "partial"
          : laneValues.every((value) => (
            ["healthy", "completed"].includes(text(value.status) ?? "")
          ))
            ? "healthy"
            : laneValues.some((value) => text(value.status) === "unavailable")
              ? "unavailable"
              : "partial",
        precision: text(laneValues.find((value) => text(value.precision))?.precision) ?? "unknown",
        provenanceConsistent: aggregatedProvenance.consistent,
        ...(aggregatedProvenance.provenance
          ? { provenance: aggregatedProvenance.provenance }
          : {}),
        ...(!aggregatedProvenance.consistent
          ? { unavailableReason: "portfolio_model_provenance_inconsistent" }
          : !aggregatedMetrics.consistent
            ? { unavailableReason: "portfolio_metric_aggregation_basis_incomplete" }
          : {}),
        metrics: aggregatedMetrics.metrics,
      };
    });
    return {
      schemaVersion: AI_SIMULATION_CONTRACT_VERSION,
      runId,
      phase: snapshots.every((snapshot) => snapshot.phase === "completed")
        ? "completed"
        : snapshots.some((snapshot) => snapshot.phase === "failed")
          ? "failed"
          : "running",
      startedAt,
      expiresAt,
      market: firstSnapshot.market,
      simulationCase: request.simulationCase,
      resolvedModelPlan: structuredClone(normalizedModelPlan(request)),
      currency: "USDT",
      initialCash,
      cash,
      equity,
      progress: snapshots.reduce((sum, snapshot) => sum + snapshot.progress, 0)
        / snapshots.length,
      selection: request.selection,
      criterion: request.selection.mode === "auto"
        ? request.selection.criterion
        : firstSnapshot.criterion,
      preset: request.preset,
      riskTolerance: request.riskTolerance,
      policyProfile: cryptoFuturesPolicyProfile(request),
      selected: snapshots.flatMap((snapshot) => snapshot.selected),
      positions: snapshots.flatMap((snapshot) => snapshot.positions),
      futuresPositions: snapshots.flatMap((snapshot) => snapshot.futuresPositions),
      futuresRisk: {
        dailyLossRatio: portfolioDailyGate?.drawdownRate
          ?? (initialCash > 0 ? Math.max(0, (initialCash - equity) / initialCash) : 0),
        dailyLossLimitRatio: riskLimits.dailyLossLimitRate,
        newEntriesBlocked: portfolioDailyGate?.blocked === true || nonDailyBlock !== undefined,
        ...(portfolioDailyGate?.blocked
          ? {
            blockReason: `UTC 일손실 ${(riskLimits.dailyLossLimitRate * 100)
              .toFixed(2)}% gate`,
          }
          : nonDailyBlock?.futuresRisk.blockReason
            ? { blockReason: nonDailyBlock.futuresRisk.blockReason }
          : {}),
        grossExposureRatio: weightedRatio(
          (snapshot) => snapshot.futuresRisk.grossExposureRatio,
        ),
        grossExposureLimitRatio: riskLimits.grossExposureLimitRate,
        marginUsageRatio: weightedRatio(
          (snapshot) => snapshot.futuresRisk.marginUsageRatio,
        ),
        marginUsageLimitRatio: riskLimits.marginUsageLimitRate,
        riskPerTradeRatio: riskLimits.riskPerTradeRate,
        maximumLeverage: riskLimits.maximumLeverage,
        liquidationBufferMultiple: riskLimits.liquidationBufferMultiple,
        riskStreams: {
          healthy: snapshots.every((snapshot) => snapshot.futuresRisk.riskStreams.healthy),
          bookTicker: firstSnapshot.futuresRisk.riskStreams.bookTicker,
          markPrice: firstSnapshot.futuresRisk.riskStreams.markPrice,
        },
      },
      charts: snapshots.flatMap((snapshot) => snapshot.charts),
      trades: snapshots.flatMap((snapshot) => snapshot.trades),
      decisions: snapshots.flatMap((snapshot) => snapshot.decisions).slice(-600),
      unifiedPolicyDecisions: snapshots.flatMap(
        (snapshot) => snapshot.unifiedPolicyDecisions,
      ).slice(-600),
      modelEvidence: snapshots.flatMap((snapshot) => snapshot.modelEvidence).slice(-1_200),
      rustMarketEvidence: snapshots.flatMap(
        (snapshot) => snapshot.rustMarketEvidence,
      ).slice(-600),
      modelForecasts,
      warnings: unique(snapshots.flatMap((snapshot) => snapshot.warnings)),
      capabilities: {
        ...firstSnapshot.capabilities,
        multiSymbol: true,
        selectedSymbolCount: snapshots.length,
        paper: true,
        testnet: false,
        live: false,
        realOrder: false,
      },
      modelLanes: [...request.modelLanes],
      executionMode: "paper",
      executionLane: firstSnapshot.executionLane,
      modelComparison: {
        comparisonId: `${runId}:portfolio`,
        outcome: "inconclusive",
        sameOrigin: true,
        sameContext: true,
        sameCosts: true,
        sameFillBarrier: snapshots.every((snapshot) => (
          first(record(snapshot.modelComparison), "sameFillBarrier") === true
        )),
        symbols: snapshots.flatMap((snapshot) => (
          snapshot.selected.flatMap((value) => {
            const symbol = text(first(record(value), "symbol"));
            return symbol ? [symbol] : [];
          })
        )),
        lanes,
      },
      decisionCadence: {
        trigger: firstSnapshot.decisionCadence.trigger,
        modelCandleSeconds: firstSnapshot.decisionCadence.modelCandleSeconds,
        inferenceIntervalSeconds:
          firstSnapshot.decisionCadence.inferenceIntervalSeconds,
        triggeredEvents: snapshots.reduce(
          (sum, snapshot) => sum + snapshot.decisionCadence.triggeredEvents,
          0,
        ),
        coalescedFinalKlines: snapshots.reduce(
          (sum, snapshot) => sum + snapshot.decisionCadence.coalescedFinalKlines,
          0,
        ),
        ...(snapshots.map((snapshot) => snapshot.decisionCadence.lastTriggeredAt)
          .filter((value): value is string => Boolean(value))
          .sort()
          .at(-1)
          ? {
            lastTriggeredAt: snapshots.map(
              (snapshot) => snapshot.decisionCadence.lastTriggeredAt,
            ).filter((value): value is string => Boolean(value)).sort().at(-1),
          }
          : {}),
        inFlight: snapshots.some((snapshot) => snapshot.decisionCadence.inFlight),
      },
    };
  }

  private async runPortfolio(input: {
    request: SimulationStartRequest;
    snapshot: BinanceScannerSnapshot;
    selected: readonly BinanceScannerCandidate[];
    context: RunTaskContext;
  }): Promise<CryptoSimulationRuntimeResult> {
    const perSymbolInitialCash = input.request.initialCash / input.selected.length;
    const riskLimits = input.request.riskLimits ?? DEFAULT_CRYPTO_FUTURES_RISK_LIMITS;
    const portfolioDailyLossGate = new PortfolioDailyLossGate({
      lanes: input.request.modelLanes,
      symbols: input.selected.map((candidate) => candidate.symbol),
      perSymbolInitialCash,
      dailyLossLimitRate: riskLimits.dailyLossLimitRate,
      observedAt: this.clock.now(),
    });
    const snapshots = new Map<string, CryptoPaperRuntimeSnapshot>();
    const progress = new Map<string, number>();
    const portfolioController = new AbortController();
    const abortPortfolio = (reason: unknown) => {
      if (!portfolioController.signal.aborted) {
        portfolioController.abort(
          reason instanceof Error ? reason : new Error("crypto_portfolio_aborted"),
        );
      }
    };
    const onParentAbort = () => abortPortfolio(input.context.signal.reason);
    if (input.context.signal.aborted) onParentAbort();
    else input.context.signal.addEventListener("abort", onParentAbort, { once: true });
    const publishAggregate = async (): Promise<void> => {
      if (snapshots.size !== input.selected.length || !this.options.onSnapshot) return;
      await this.options.onSnapshot(
        input.context.runId,
        this.aggregatePortfolioSnapshots(
          input.context.runId,
          input.request,
          [...snapshots.values()],
          portfolioDailyLossGate,
        ),
      );
    };
    const tasks = input.selected.map(async (selected, index) => {
      const childRequest: SimulationStartRequest = {
        ...input.request,
        initialCash: perSymbolInitialCash,
        selection: { mode: "manual", symbols: [selected.symbol] },
      };
      const childContext: RunTaskContext = {
        ...input.context,
        runId: `${input.context.runId}:${index + 1}:${selected.symbol}`,
        signal: portfolioController.signal,
        isCancelled: async () => (
          portfolioController.signal.aborted
          || await input.context.isCancelled()
        ),
        throwIfCancelled: async () => {
          if (portfolioController.signal.aborted) {
            throw abortReason(
              portfolioController.signal,
              "Crypto portfolio runtime was aborted.",
            );
          }
          await input.context.throwIfCancelled();
        },
        updateProgress: async (value, detail) => {
          progress.set(selected.symbol, value);
          await input.context.updateProgress(
            [...progress.values()].reduce((sum, item) => sum + item, 0)
              / input.selected.length,
            {
              ...detail,
              completedCandidates: [...progress.values()].filter((item) => item >= 1).length,
              totalCandidates: input.selected.length,
              currentValidationWindow: `shadow:${selected.symbol}`,
            },
          );
        },
      };
      try {
        return await this.runSingle({
          request: childRequest,
          snapshot: input.snapshot,
          selected,
          context: childContext,
          portfolioDailyLossGate,
          snapshotObserver: async (_runId, snapshot) => {
            snapshots.set(selected.symbol, snapshot);
            await publishAggregate();
          },
        });
      } catch (error) {
        abortPortfolio(error);
        throw error;
      }
    });
    const settled = await Promise.allSettled(tasks);
    input.context.signal.removeEventListener("abort", onParentAbort);
    const rejected = settled.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (rejected) throw rejected.reason;
    const results = settled.map((result) => (
      (result as PromiseFulfilledResult<CryptoSimulationRuntimeResult>).value
    ));
    const portfolioEquity = aggregatePortfolioEquitySeries(
      results.map((result) => {
        const resultRecord = record(result.result);
        const report = record(first(resultRecord, "report"));
        const rawEquity = first(report, "equity");
        if (!Array.isArray(rawEquity)) return [];
        return rawEquity.flatMap((value): RuntimeEquityPoint[] => {
          const point = record(value);
          const timestamp = exactText(first(point, "timestamp"));
          const equity = finite(first(point, "equity"));
          const drawdown = finite(first(point, "drawdown"));
          return timestamp && equity !== undefined
            ? [{
              timestamp,
              equity,
              drawdown: drawdown ?? 0,
            }]
            : [];
        });
      }),
      perSymbolInitialCash,
    );
    const terminalSnapshots = results.flatMap((result) => {
      const resultRecord = record(result.result);
      const snapshot = first(resultRecord, "snapshot");
      return snapshot && record(snapshot)
        ? [snapshot as CryptoPaperRuntimeSnapshot]
        : [];
    });
    if (terminalSnapshots.length !== input.selected.length) {
      throw new Error("portfolio_terminal_snapshot_unavailable");
    }
    const terminalSnapshot = this.aggregatePortfolioSnapshots(
      input.context.runId,
      input.request,
      terminalSnapshots,
      portfolioDailyLossGate,
    );
    const warnings = unique(results.flatMap((result) => result.warnings ?? []));
    const groupedArtifacts = groupPortfolioRuntimeArtifacts(results);
    const terminalFailure = results.find((result) => result.terminalFailure)?.terminalFailure;
    const summary = {
      schemaVersion: AI_SIMULATION_CONTRACT_VERSION,
      phase: terminalFailure ? "failed" : "completed",
      market: input.request.market,
      currency: "USDT",
      initialCash: input.request.initialCash,
      finalEquity: terminalSnapshot.equity,
      netProfitLoss: terminalSnapshot.equity - input.request.initialCash,
      returnRatio: terminalSnapshot.equity / input.request.initialCash - 1,
      tradeCount: terminalSnapshot.trades.length,
      selectedSymbols: input.selected.map((candidate) => candidate.symbol),
      executionLane: terminalSnapshot.executionLane,
      settlementComplete: !terminalFailure,
      realOrderApiUsed: false,
      snapshot: terminalSnapshot,
    };
    return {
      summary,
      result: {
        snapshot: terminalSnapshot,
        report: {
          configuration: {
            market: input.request.market,
            initialCash: input.request.initialCash,
            durationMinutes: input.request.durationMinutes,
            selection: input.request.selection,
            preset: input.request.preset,
            riskTolerance: input.request.riskTolerance,
            costs: input.request.costs,
            riskLimits,
            modelLanes: input.request.modelLanes,
            execution: input.request.execution,
            executionLane: terminalSnapshot.executionLane,
          },
          selected: terminalSnapshot.selected,
          performance: summary,
          decisions: terminalSnapshot.decisions,
          trades: terminalSnapshot.trades,
          futuresPositions: terminalSnapshot.futuresPositions,
          futuresRisk: terminalSnapshot.futuresRisk,
          charts: terminalSnapshot.charts,
          modelForecasts: terminalSnapshot.modelForecasts,
          modelComparison: terminalSnapshot.modelComparison,
          equity: portfolioEquity,
          warnings,
        },
      },
      warnings,
      ...(terminalFailure ? { terminalFailure } : {}),
      artifacts: groupedArtifacts.map((artifact) => ({
        type: artifact.type,
        content: {
          schemaVersion: AI_SIMULATION_CONTRACT_VERSION,
          portfolio: true,
          selectedSymbols: input.selected.map((candidate) => candidate.symbol),
          items: artifact.contents,
          realOrder: false,
        },
        rowCount: artifact.rowCount,
      })),
    };
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
