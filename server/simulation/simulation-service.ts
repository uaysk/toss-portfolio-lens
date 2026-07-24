import type { ArtifactService } from "../services/artifact-service.js";
import type { RunService } from "../services/run-service.js";
import type {
  PortfolioRunRecord,
  PortfolioRunStatus,
  RunRepository,
} from "../repositories/run-repository.js";
import type {
  ArtifactDescriptor,
  ArtifactType,
} from "../repositories/artifact-repository.js";
import type { ScalpingLiveEvent } from "../scalping/live-runtime.js";
import type { MarketCountry, ScannerCriterion, UsExchange } from "../scalping/contracts.js";
import {
  DEFAULT_US_EXTENDED_SESSION_WINDOWS,
  sessionWindowForTrade,
} from "../scalping/market-session.js";
import type {
  ScalpingForecastResult,
  ScalpingRealtimeAnalysisResult,
  ScalpingWorkspaceResult,
} from "../scalping/api-contracts.js";
import type { ScalpingService } from "../scalping/scalping-service.js";
import type {
  SimulationCosts,
  SimulationPreset,
  SimulationStartRequest,
  SimulationStrategy,
} from "./contracts.js";
import { AI_SIMULATION_CONTRACT_VERSION } from "./contracts.js";
import {
  DEFAULT_PAIR_CATALOG,
  PAIR_CATALOG_VERSION,
  getPairCatalogEntry,
  mapPairDirection,
  type PairCatalogEntry,
  type PairDirection,
} from "./pair-catalog.js";
import {
  DEFAULT_PAIR_ENSEMBLE_POLICY_PROFILE,
  PAIR_ENSEMBLE_POLICY_VERSION,
  evaluatePairEnsemble,
  type PairEnsembleDecision,
  type PairEnsembleInput,
  type PairExecutionMarketInput,
  type PairRustTechnicalInput,
} from "./ensemble-policy.js";
import {
  normalizePairModelOutputs,
  type NormalizedPairModelOutput,
  type NormalizedPairModelSet,
} from "./model-output-normalization.js";
import {
  createPairRuntimeState,
  transitionPairState,
  validatePairMutualExclusion,
  type PairRuntimeState,
} from "./pair-state.js";
import {
  calculatePairPositionSize,
  type PairSizingResult,
} from "./pair-sizing.js";
import {
  comparePairStrategies,
  isNonOverlappingPairComparisonOrigin,
  type PairStrategyComparisonObservation,
  type PairStrategyLaneObservation,
} from "./strategy-comparison.js";
import {
  createPairDecisionProvenance,
  verifyPairDecisionReplay,
  type PairDecisionProvenance,
} from "./decision-provenance.js";
import {
  AI_PAPER_POLICY_VERSION,
  createPaperLedger,
  decidePaperActions,
  fillPaperAction,
  resolvePaperPolicyProfile,
  selectAiForecastSeries,
  type AiPaperForecastCandidate,
  type AiPaperSelection,
  type PaperLedger,
  type PaperPolicyAction,
  type PaperTrade,
} from "./policy.js";
import {
  reduceDecisionQueueTick,
  transitionSimulationPhase,
  type SimulationPhase,
  type SimulationPhaseEvent,
} from "./session-state.js";
import {
  cleanupSimulationRuntime,
  combinedRelease,
  type SimulationRuntimeHandles,
} from "./session-runtime.js";
import {
  latestSimulationPatternObservation,
  mergeSimulationFinalBar,
  mergeSimulationFormingBar,
  mergeSimulationLatestTechnical,
  simulationChartsFromWorkspace,
  type SimulationChartView,
} from "./chart-data.js";

const MINUTE_MS = 60_000;
const DECISION_ARTIFACT_CHECKPOINT_MS = 60_000;
const PAIR_COMPARISON_SETTLEMENT_GRACE_MS = 60_000;
const MAX_DECISIONS = 5_000;
const MAX_EQUITY_POINTS = 5_000;
const MAX_MARK_HISTORY_PER_SYMBOL = 4_096;
const MAX_HISTORY_PAGE_SIZE = 50;
const DEFAULT_HISTORY_PAGE_SIZE = 20;
const MAX_REPORT_DECISIONS = 500;
const MAX_REPORT_TRADES = 500;
const MAX_REPORT_EQUITY_POINTS = 1_000;
const MAX_REPORT_CHARTS = 3;
const MAX_REPORT_CHART_BARS = 180;
const MAX_REPORT_CHART_PATTERNS = 120;
const MAX_REPORT_CHART_INDICATORS = 50;
const MAX_REPORT_MODEL_PROVENANCE = 16;

const SIMULATION_ARTIFACT_TYPES = [
  "simulation-selection",
  "simulation-decisions",
  "simulation-equity",
  "simulation-trades",
  "simulation-comparison",
  "simulation-provenance",
  "simulation-diagnostics",
] as const satisfies readonly ArtifactType[];

export type SimulationHistoryListInput = {
  limit?: number;
  cursor?: string;
  statuses?: PortfolioRunStatus[];
};

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonempty(value: unknown, maximum = 256): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= maximum ? normalized : undefined;
}

function timestamp(value: unknown): string | undefined {
  const normalized = nonempty(value, 64);
  if (!normalized || !Number.isFinite(Date.parse(normalized))) return undefined;
  return new Date(Date.parse(normalized)).toISOString();
}

function uniqueWarnings(values: readonly string[]): string[] {
  return Array.from(new Set(values.filter(Boolean))).slice(-200);
}

function forecastUnavailableCodes(value: ScalpingForecastResult): string[] {
  const direct = value.unavailable ?? (
    !("schema_version" in value.forecast) ? value.forecast.series ?? [] : []
  );
  return Array.from(new Set([
    ...direct,
    ...(value.predictions ?? []).flatMap((prediction) => (
      "unavailable" in prediction
        ? [{ symbol: prediction.symbol, code: prediction.unavailable.code }]
        : []
    )),
  ].flatMap((item) => {
    const symbol = nonempty(item.symbol, 32);
    const code = nonempty(item.code, 128);
    return code ? [`${symbol ? `${symbol}:` : ""}${code}`] : [];
  })));
}

function isRetryableStaleness(value: string): boolean {
  return ["stale_final_bar", "stale_forecast_horizon"].includes(value.split(":").at(-1) ?? "");
}

function canRetryStaleSelection(
  selection: AiPaperSelection,
  values: readonly string[],
): boolean {
  if (selection.reason === "stale_forecast_horizon") return true;
  return (selection.reason === "insufficient_available_forecasts"
      || selection.reason === "invalid_forecast_response")
    && values.length > 0
    && values.every(isRetryableStaleness);
}

function roundTripCostRate(costs: SimulationCosts): number {
  return (
    costs.commissionBpsPerSide * 2
    + costs.taxBpsOnExit
    + costs.spreadBpsRoundTrip
    + costs.slippageBpsPerSide * 2
  ) / 10_000;
}

type CandidateMetadata = {
  symbol: string;
  name?: string;
  exchange?: UsExchange;
  price?: number;
};

function workspaceCandidates(value: ScalpingWorkspaceResult): CandidateMetadata[] {
  const candidates = value.workspace.candidates;
  const seen = new Set<string>();
  const output: CandidateMetadata[] = [];
  for (const item of candidates) {
    const symbol = item.symbol.toUpperCase();
    if (seen.has(symbol) || item.filtered) continue;
    output.push({
      symbol,
      ...(item.name ? { name: item.name } : {}),
      ...(item.exchange ? { exchange: item.exchange } : {}),
      ...(item.price !== undefined && item.price > 0 ? { price: item.price } : {}),
    });
    seen.add(symbol);
  }
  return output;
}

function latestTimestamp(values: readonly unknown[]): string | undefined {
  const timestamps = values.flatMap((value) => {
    const normalized = timestamp(value);
    return normalized ? [normalized] : [];
  });
  return timestamps.sort((left, right) => Date.parse(right) - Date.parse(left))[0];
}

function technicalStates(
  value: ScalpingRealtimeAnalysisResult,
  charts: readonly SimulationChartView[],
): Record<string, unknown> {
  const technical = value.technical;
  const output: Record<string, unknown> = Object.fromEntries(charts.map((chart) => {
    const pattern = latestSimulationPatternObservation(chart);
    return [chart.symbol, {
      observedAt: latestTimestamp([value.generatedAt, pattern.patternObservedAt]),
      ...pattern,
    }];
  }));
  if (!("instruments" in technical)) return output;
  for (const instrument of technical.instruments) {
    const symbol = instrument.instrument_key.toUpperCase();
    const latest = instrument.signals?.latest ?? instrument.signals?.points?.at(-1);
    const pattern = latestSimulationPatternObservation(
      charts.find((chart) => chart.symbol === symbol),
    );
    output[symbol] = {
      ...(latest?.status ? { status: latest.status } : {}),
      ...(latest?.technical_signal !== undefined
        ? { technicalSignal: latest.technical_signal } : {}),
      ...(latest?.earliest_eligible_timestamp
        ? { earliestEligibleAt: latest.earliest_eligible_timestamp } : {}),
      ...(latest?.signal_timestamp ? { signalOriginAt: latest.signal_timestamp } : {}),
      ...(latest?.calculation_timestamp
        ? { calculationAt: latest.calculation_timestamp } : {}),
      ...(latest?.multi_timeframe_agreement
        ? { multiTimeframeAgreement: latest.multi_timeframe_agreement } : {}),
      ...(latest?.multi_timeframe_trends
        ? { multiTimeframeTrends: latest.multi_timeframe_trends } : {}),
      ...(latest?.confidence !== undefined ? { confidence: latest.confidence } : {}),
      ...(latest?.confidence_semantics
        ? { confidenceSemantics: latest.confidence_semantics } : {}),
      ...(latest?.data_quality ? { signalDataQuality: latest.data_quality } : {}),
      ...(latest?.rationale ? { rationale: latest.rationale } : {}),
      ...(instrument.data_quality ? { instrumentDataQuality: instrument.data_quality } : {}),
      observedAt: latestTimestamp([
        value.generatedAt,
        latest?.calculation_timestamp,
        latest?.signal_timestamp,
        pattern.patternObservedAt,
      ]),
      ...pattern,
    };
  }
  return output;
}

function workspaceTechnicalStates(
  value: ScalpingWorkspaceResult,
  charts: readonly SimulationChartView[],
): Record<string, unknown> {
  const output: Record<string, unknown> = Object.fromEntries(charts.map((chart) => {
    const pattern = latestSimulationPatternObservation(chart);
    return [chart.symbol, {
      observedAt: latestTimestamp([value.workspace.generatedAt, pattern.patternObservedAt]),
      ...pattern,
    }];
  }));
  for (const item of value.workspace.instruments) {
    if (!("instrument_key" in item.technical)) continue;
    const latest = item.technical.signals?.latest ?? item.technical.signals?.points?.at(-1);
    const symbol = item.symbol.toUpperCase();
    const pattern = latestSimulationPatternObservation(
      charts.find((chart) => chart.symbol === symbol),
    );
    output[symbol] = {
      ...(latest?.status ? { status: latest.status } : {}),
      ...(latest?.technical_signal !== undefined
        ? { technicalSignal: latest.technical_signal } : {}),
      ...(latest?.earliest_eligible_timestamp
        ? { earliestEligibleAt: latest.earliest_eligible_timestamp } : {}),
      ...(latest?.signal_timestamp ? { signalOriginAt: latest.signal_timestamp } : {}),
      ...(latest?.calculation_timestamp
        ? { calculationAt: latest.calculation_timestamp } : {}),
      ...(latest?.multi_timeframe_agreement
        ? { multiTimeframeAgreement: latest.multi_timeframe_agreement } : {}),
      ...(latest?.multi_timeframe_trends
        ? { multiTimeframeTrends: latest.multi_timeframe_trends } : {}),
      ...(latest?.confidence !== undefined ? { confidence: latest.confidence } : {}),
      ...(latest?.confidence_semantics
        ? { confidenceSemantics: latest.confidence_semantics } : {}),
      ...(latest?.data_quality ? { signalDataQuality: latest.data_quality } : {}),
      ...(latest?.rationale ? { rationale: latest.rationale } : {}),
      ...(item.technical.data_quality
        ? { instrumentDataQuality: item.technical.data_quality } : {}),
      observedAt: latestTimestamp([
        value.workspace.generatedAt,
        latest?.calculation_timestamp,
        latest?.signal_timestamp,
        pattern.patternObservedAt,
      ]),
      ...pattern,
    };
  }
  return output;
}

function selectionSymbolCount(request: SimulationStartRequest): 1 | 2 {
  if (simulationStrategy(request).mode === "pair") return 1;
  return request.selection.mode === "manual"
    ? request.selection.symbols.length as 1 | 2
    : request.selection.symbolCount;
}

function simulationStrategy(request: SimulationStartRequest): SimulationStrategy {
  return request.strategy ?? { mode: "single" };
}

function selectionCriterion(request: SimulationStartRequest): ScannerCriterion {
  return request.selection.mode === "auto"
    ? request.selection.criterion
    : "trading_amount";
}

function manuallySelectedSymbols(request: SimulationStartRequest): string[] {
  return request.selection.mode === "manual" ? [...request.selection.symbols] : [];
}

type SimulationMarketSource = {
  status: ScalpingService["status"];
  workspace(input: {
    marketCountry: MarketCountry;
    criterion: ScannerCriterion;
    topCount: number;
    interval: "1m";
    layoutColumns: 1;
    preset: SimulationPreset;
    symbols?: string[];
    scanOnly: boolean;
    includePortfolioContext: false;
  }): Promise<ScalpingWorkspaceResult>;
  forecast(input: {
    marketCountry: MarketCountry;
    symbols: string[];
    interval: "1m";
  }, options?: {
    signal?: AbortSignal;
    maximumInputEndAt?: string;
  }): Promise<ScalpingForecastResult>;
  realtimeAnalysis(input: {
    marketCountry: MarketCountry;
    symbols: string[];
    interval: "1m";
    preset: SimulationPreset;
    positionContext: {
      mode: "isolated";
      positions: Array<{
        symbol: string;
        quantity: number;
        averagePrice: number;
        asOf: string;
      }>;
    };
  }, options?: {
    signal?: AbortSignal;
    skipAutomaticRefresh?: boolean;
    maximumInputEndAt?: string;
  }): Promise<ScalpingRealtimeAnalysisResult>;
};

type SimulationLiveSource = {
  retain(
    symbols: readonly string[],
    marketCountry?: MarketCountry,
    usExchanges?: Readonly<Record<string, UsExchange>>,
  ): Promise<() => void>;
  onEvent(listener: (event: ScalpingLiveEvent) => void): () => void;
  waitForIdle(): Promise<void>;
  readonly state?: {
    symbols?: Array<{ symbol: string; marketCountry: MarketCountry }>;
  };
};

export type AiTradingSimulationConfig = {
  maximumDurationMinutes: number;
  maximumActiveSessions: number;
  candidatePoolSize: number;
  selectionMaximumAttempts: number;
  selectionRetryDelayMs: number;
  progressUpdateMs?: number;
  now?: () => number;
};

type SimulationDecision = {
  symbol: string;
  action: PaperPolicyAction["action"];
  decidedAt: string;
  eligibleAfter: string;
  inputEndAt: string;
  forecastGeneratedAt: string;
  technicalObservedAt?: string;
  reason: string;
  reasons: string[];
  score: number;
  upProbability: number;
  predictedMedianReturn: number;
  q10Return: number;
  q90Return: number;
  technicalState: PaperPolicyAction["technicalState"];
  chartPatternBias: PaperPolicyAction["chartPatternBias"];
  chartPatterns: string[];
  model: AiPaperForecastCandidate["model"];
  signalSymbol?: string;
  executionSymbol?: string | null;
  direction?: PairDirection;
  decisionKind?: PairEnsembleDecision["decisionKind"];
  degraded?: boolean;
  exposureScale?: number;
  weights?: Record<string, number>;
  components?: Record<string, number>;
  finalScores?: Record<string, number>;
  provenance?: string[];
  ensemble?: PairEnsembleDecision;
  modelOutputs?: NormalizedPairModelSet;
  rustSignal?: PairRustTechnicalInput;
  sizing?: PairSizingResult;
  pairDecisionId?: string;
};

type SimulationTrade = PaperTrade & {
  amount: number;
  cost: number;
  source: "kis_ws_trade" | "next_final_bar_open";
  pairDecisionId?: string;
};

type SimulationPendingAction = PaperPolicyAction & {
  targetAllocationRate?: number;
  pairDecisionId?: string;
  validUntil?: string;
  pairSizing?: {
    leverageMultiplier: number;
    predictedVolatility: number;
    ensembleExposureScale: number;
    maximumUnderlyingExposureRate: number;
    targetVolatility: number;
  };
  effectiveSpreadBpsRoundTrip?: number;
  switchCostBps?: number;
};

type EquityPoint = {
  timestamp: string;
  equity: number;
  cash: number;
  invested: number;
};

type ObservedMark = {
  price: number;
  observedAt: string;
};

type PairPendingComparison = {
  observationId: string;
  origin: string;
  eligibleAfter: string;
  targetTimestamp: string;
  lanes: PairStrategyComparisonObservation["lanes"];
};

type PairSkippedComparison = {
  observationId: string;
  origin: string;
  targetTimestamp: string;
  skippedAt: string;
  reasonCodes: string[];
};

type PairExecutionQuote = {
  bid: number;
  ask: number;
  mid: number;
  spreadBps: number;
  observedAt: string;
};

type PairEntryExpiration = {
  action: SimulationPendingAction;
  observedAt: string;
  processedAt: string;
  reason: "forecast_horizon_elapsed" | "session_finalized_before_execution";
};

function pairExecutionQuote(value: unknown): PairExecutionQuote | undefined {
  const source = record(value);
  const asks = values(source?.asks);
  const bids = values(source?.bids);
  const ask = finite(record(asks[0])?.price);
  const bid = finite(record(bids[0])?.price);
  const observedAt = timestamp(source?.observedAt ?? source?.observed_at);
  if (ask === undefined || bid === undefined || !observedAt
    || bid <= 0 || ask <= 0 || ask < bid) return undefined;
  const mid = (ask + bid) / 2;
  const spreadBps = mid > 0 ? (ask - bid) / mid * 10_000 : Number.POSITIVE_INFINITY;
  if (!Number.isFinite(spreadBps)) return undefined;
  return { bid, ask, mid, spreadBps, observedAt };
}

function pairSessionAt(value: string): PairCatalogEntry["allowedSessions"][number] | undefined {
  const window = sessionWindowForTrade(
    value,
    "US",
    DEFAULT_US_EXTENDED_SESSION_WINDOWS,
  );
  if (window?.kind === "regular_market") return "regular";
  return window?.kind;
}

function pairTechnicalQuality(source: UnknownRecord | undefined): PairRustTechnicalInput["dataQuality"] {
  const signalQuality = record(source?.signalDataQuality);
  const instrumentQuality = record(source?.instrumentDataQuality);
  const states = [
    nonempty(firstDefined(signalQuality, "status"), 64),
    nonempty(firstDefined(instrumentQuality, "status"), 64),
  ].filter((value): value is string => Boolean(value)).map((value) => value.toLowerCase());
  if (states.some((value) => value.includes("stale"))) return "stale";
  if (states.some((value) => ["unavailable", "invalid", "failed", "error"].includes(value))) {
    return "unavailable";
  }
  if (states.some((value) => ["partial", "warning", "degraded"].includes(value))) return "partial";
  if (states.length && states.every((value) => ["good", "available", "ok", "valid"].includes(value))) {
    return "good";
  }
  return "unavailable";
}

function pairRustTechnicalInput(value: unknown): PairRustTechnicalInput {
  const source = record(value);
  const rawStatus = nonempty(firstDefined(source, "status", "state", "technicalState"), 64);
  const status = rawStatus && ["watch", "entry_candidate", "hold", "exit_candidate"].includes(rawStatus)
    ? rawStatus as PairRustTechnicalInput["status"]
    : null;
  const rawTechnicalSignal = finite(firstDefined(source, "technicalSignal", "technical_signal"));
  const technicalSignal = rawTechnicalSignal === -1 || rawTechnicalSignal === 0 || rawTechnicalSignal === 1
    ? rawTechnicalSignal
    : undefined;
  const rawTrends = record(firstDefined(source, "multiTimeframeTrends", "multi_timeframe_trends"));
  const multiTimeframeTrends = rawTrends
    ? Object.fromEntries(Object.entries(rawTrends).flatMap(([key, item]) => (
        item === "bullish" || item === "bearish" || item === "neutral" || item === null
          ? [[key, item] as const] : []
      )))
    : undefined;
  const chartPatternBias = firstDefined(source, "chartPatternBias", "chart_pattern_bias");
  const chartPatterns = values(firstDefined(source, "chartPatterns", "chart_patterns"))
    .flatMap((item) => nonempty(item, 128) ?? []);
  const rationale = values(firstDefined(source, "rationale"))
    .flatMap((item) => nonempty(item, 500) ?? []);
  const confidence = finite(firstDefined(source, "confidence"));
  return {
    status,
    ...(timestamp(firstDefined(source, "signalOriginAt", "signal_origin_at"))
      ? { signalOriginAt: timestamp(firstDefined(source, "signalOriginAt", "signal_origin_at")) }
      : {}),
    ...(timestamp(firstDefined(source, "observedAt", "observed_at"))
      ? { observedAt: timestamp(firstDefined(source, "observedAt", "observed_at")) }
      : {}),
    ...(timestamp(firstDefined(source, "earliestEligibleAt", "earliest_eligible_at"))
      ? { earliestEligibleAt: timestamp(firstDefined(source, "earliestEligibleAt", "earliest_eligible_at")) }
      : {}),
    ...(technicalSignal !== undefined ? { technicalSignal } : {}),
    ...(nonempty(firstDefined(
      source,
      "multiTimeframeAgreement",
      "multi_timeframe_agreement",
    ), 64) ? {
      multiTimeframeAgreement: nonempty(firstDefined(
        source,
        "multiTimeframeAgreement",
        "multi_timeframe_agreement",
      ), 64),
    } : {}),
    ...(multiTimeframeTrends ? { multiTimeframeTrends } : {}),
    ...(confidence !== undefined && confidence >= 0 && confidence <= 1 ? { confidence } : {}),
    ...(chartPatternBias === "bullish" || chartPatternBias === "bearish" || chartPatternBias === "neutral"
      ? { chartPatternBias } : {}),
    ...(chartPatterns.length ? { chartPatterns } : {}),
    dataQuality: pairTechnicalQuality(source),
    ...(rationale.length ? { rationale } : {}),
    rawOutput: value,
  };
}

function pairExecutionMarketInput(
  session: ActiveSession,
  decisionAt: string,
): PairExecutionMarketInput {
  if (!session.pair) {
    return { session: "unavailable", dataQuality: "unavailable", quotes: {} };
  }
  const quotes = Object.fromEntries((["bull", "bear"] as const).flatMap((direction) => {
    const symbol = session.pair!.catalog[direction].executionSymbol;
    const quote = session.pair!.quotes[symbol];
    return quote ? [[direction, {
      status: "available" as const,
      observedAt: quote.observedAt,
      spreadBps: quote.spreadBps,
    }] as const] : [];
  }));
  const count = Object.keys(quotes).length;
  return {
    session: pairSessionAt(decisionAt) ?? "closed",
    dataQuality: count === 2 ? "good" : count === 1 ? "partial" : "unavailable",
    quotes,
  };
}

function pairActionModel(models: NormalizedPairModelSet): AiPaperForecastCandidate["model"] {
  const source = [models.chronos2, models.kronos].find(({ status }) => status !== "unavailable")
    ?? models.chronos2;
  const provenance = source.provenance;
  const device = provenance.device === "cuda" || provenance.device === "cpu"
    || provenance.device === "unavailable"
    ? provenance.device
    : "unavailable";
  const loaded = provenance.loaded && device !== "unavailable";
  return {
    modelId: provenance.modelId ?? "unavailable",
    modelRevision: provenance.modelRevision ?? "unavailable",
    ...(provenance.tokenizerId ? { tokenizerId: provenance.tokenizerId } : {}),
    ...(provenance.tokenizerRevision
      ? { tokenizerRevision: provenance.tokenizerRevision } : {}),
    sourceRevision: provenance.sourceRevision ?? "unavailable",
    loaderVersion: provenance.loaderVersion ?? "unavailable",
    license: provenance.license ?? "unavailable",
    device,
    dtype: "float32",
    attentionBackend: loaded && provenance.attentionBackend === "math"
      ? "math"
      : "unavailable",
    loaded,
    ...(provenance.fallbackFrom ? { fallbackFrom: provenance.fallbackFrom } : {}),
    ...(provenance.fallbackReason ? { fallbackReason: provenance.fallbackReason } : {}),
  };
}

function pairModelAverage(
  models: NormalizedPairModelSet,
  key: "medianReturn" | "q10Return" | "q90Return" | "upProbability",
): number {
  const values = [models.chronos2[key], models.kronos[key]].filter(
    (value): value is number => value !== undefined && Number.isFinite(value),
  );
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function pairCommonTargetTimestamp(
  models: NormalizedPairModelSet,
): string | undefined {
  const targets = [...new Set(
    [models.chronos2, models.kronos]
      .filter((model) => model.status !== "unavailable")
      .flatMap((model) => model.targetTimestamp ?? []),
  )];
  return targets.length === 1 ? targets[0] : undefined;
}

function pairProvenanceStrings(models: NormalizedPairModelSet): string[] {
  return [models.chronos2, models.kronos].flatMap((model) => {
    const provenance = model.provenance;
    return [
      `${model.component}:${model.status}`,
      ...(provenance.modelId ? [`${model.component}:model=${provenance.modelId}`] : []),
      ...(provenance.modelRevision
        ? [`${model.component}:revision=${provenance.modelRevision}`] : []),
      ...(provenance.device ? [`${model.component}:device=${provenance.device}`] : []),
      ...(provenance.latencyMs !== undefined
        ? [`${model.component}:latency_ms=${provenance.latencyMs}`] : []),
      ...model.reasonCodes.map((reason) => `${model.component}:${reason}`),
    ];
  });
}

type ActiveSession = SimulationRuntimeHandles & {
  id: string;
  ownerSubject: string;
  request: SimulationStartRequest;
  dataRevision: string;
  phase: SimulationPhase;
  createdAt: string;
  startedAt?: string;
  expiresAt?: string;
  selection?: AiPaperSelection;
  metadata: Map<string, CandidateMetadata>;
  ledger: PaperLedger;
  ledgerRevision: number;
  marks: Record<string, number>;
  markTimes: Record<string, string>;
  markHistory: Record<string, ObservedMark[]>;
  pending: Map<string, SimulationPendingAction>;
  decisions: SimulationDecision[];
  trades: SimulationTrade[];
  equity: EquityPoint[];
  charts: SimulationChartView[];
  pair?: {
    catalog: Readonly<PairCatalogEntry>;
    direction: PairDirection;
    runtimeState: PairRuntimeState;
    quotes: Record<string, PairExecutionQuote>;
    quoteEventTimes: Record<string, string>;
    lastModels?: NormalizedPairModelSet;
    lastDecision?: PairEnsembleDecision;
    cooldownUntil?: string;
    strategyComparison?: unknown;
    comparisonPending: PairPendingComparison[];
    comparisonObservations: PairStrategyComparisonObservation[];
    comparisonSkipped: PairSkippedComparison[];
    provenanceRecords: PairDecisionProvenance[];
    lastSizing?: PairSizingResult;
    signalPosition?: {
      averagePrice: number;
      asOf: string;
    };
  };
  warnings: string[];
  lastDecisionTriggeredAt?: string;
  lastDecisionStartedAt?: string;
  lastDecisionFinishedAt?: string;
  decisionTriggeredEvents: number;
  decisionCoalescedEvents: number;
  decisionDuplicateEvents: number;
  lastArtifactPersistedAtMs?: number;
  analysisRunning: boolean;
  persistenceTail: Promise<void>;
  finalizationTask?: Promise<void>;
};

function applyPhaseTransition(session: ActiveSession, event: SimulationPhaseEvent): boolean {
  const transition = transitionSimulationPhase(session.phase, event);
  if (!transition.accepted) return false;
  session.phase = transition.phase;
  return true;
}

function selectedSymbols(session: ActiveSession): string[] {
  if (session.pair) return [session.pair.catalog.signalSymbol];
  return session.selection?.status === "available"
    ? session.selection.selected.map(({ symbol }) => symbol)
    : [];
}

function executionSymbols(session: ActiveSession): string[] {
  if (!session.pair) return selectedSymbols(session);
  return [
    session.pair.catalog.bull.executionSymbol,
    session.pair.catalog.bear.executionSymbol,
  ];
}

function retainedSymbols(session: ActiveSession): string[] {
  return Array.from(new Set([...selectedSymbols(session), ...executionSymbols(session)]));
}

function updatePairExecutionQuote(
  session: ActiveSession,
  symbol: string,
  value: unknown,
  fallbackObservedAt?: string,
): boolean {
  if (!session.pair || !executionSymbols(session).includes(symbol)) return false;
  const source = record(value);
  const observedAt = timestamp(source?.observedAt ?? source?.observed_at)
    ?? timestamp(fallbackObservedAt);
  if (!observedAt) return false;
  const previous = session.pair.quoteEventTimes[symbol];
  if (previous && Date.parse(observedAt) < Date.parse(previous)) return false;
  session.pair.quoteEventTimes[symbol] = observedAt;
  const quote = pairExecutionQuote(value);
  if (!quote || Date.parse(quote.observedAt) !== Date.parse(observedAt)) {
    delete session.pair.quotes[symbol];
    return false;
  }
  session.pair.quotes[symbol] = quote;
  return true;
}

class PairStateLedgerInvariantError extends Error {
  constructor(message: string) {
    super(`PAIR_STATE_LEDGER_INVARIANT: ${message}`);
    this.name = "PairStateLedgerInvariantError";
  }
}

function assertPairStateLedgerInvariant(session: ActiveSession): void {
  if (!session.pair) return;
  const positions = Object.fromEntries(executionSymbols(session).map((symbol) => (
    [symbol, session.ledger.positions[symbol]?.quantity ?? 0]
  )));
  let ledgerDirection: PairDirection;
  try {
    ledgerDirection = validatePairMutualExclusion(session.pair.catalog, positions);
  } catch (error) {
    throw new PairStateLedgerInvariantError(
      error instanceof Error ? error.message : "mutual exclusion validation failed",
    );
  }
  if (ledgerDirection !== session.pair.runtimeState.direction
    || session.pair.direction !== session.pair.runtimeState.direction) {
    throw new PairStateLedgerInvariantError(
      `ledger=${ledgerDirection}, runtime=${session.pair.runtimeState.direction}, `
      + `session=${session.pair.direction}`,
    );
  }
  const pairActions = executionSymbols(session).flatMap((symbol) => {
    const action = session.pending.get(symbol);
    return action ? [action] : [];
  });
  const runtimePending = session.pair.runtimeState.pending;
  if (!runtimePending) {
    if (pairActions.length) {
      throw new PairStateLedgerInvariantError("pending action exists without runtime pending state");
    }
    return;
  }
  const expectedSide = runtimePending.kind === "enter" ? "buy" : "sell";
  if (pairActions.length !== 1
    || pairActions[0]!.symbol !== runtimePending.executionSymbol
    || pairActions[0]!.action !== expectedSide
    || Date.parse(pairActions[0]!.eligibleAfter) !== Date.parse(runtimePending.eligibleAfter)) {
    throw new PairStateLedgerInvariantError(
      "runtime pending state and executable pending action do not match",
    );
  }
}

function isolatedPositionContext(session: ActiveSession) {
  return {
    mode: "isolated" as const,
    positions: Object.values(session.ledger.positions).map((position) => {
      const latestTrade = [...session.trades].reverse().find((trade) => trade.symbol === position.symbol);
      return {
        symbol: position.symbol,
        quantity: position.quantity,
        averagePrice: position.averagePrice,
        asOf: latestTrade?.executedAt ?? session.startedAt ?? session.createdAt,
      };
    }),
  };
}

function pairSignalPositionContext(session: ActiveSession) {
  if (!session.pair?.signalPosition || session.pair.direction !== "bull") {
    return { mode: "isolated" as const, positions: [] };
  }
  // Rust's position-aware status is defined for a long position in the
  // underlying. Treating an inverse ETF holding as a synthetic TSLA/QQQ long
  // would invert its exit semantics, so bear holdings intentionally use the
  // positionless technical signal path.
  return {
    mode: "isolated" as const,
    positions: [{
      symbol: session.pair.catalog.signalSymbol,
      quantity: 1,
      averagePrice: session.pair.signalPosition.averagePrice,
      asOf: session.pair.signalPosition.asOf,
    }],
  };
}

function latestFinalChartOrigin(
  session: ActiveSession,
  symbol: string,
): string | undefined {
  return session.charts.find((chart) => chart.symbol === symbol)?.bars
    .filter((bar) => bar.status === "final")
    .at(-1)?.timestamp;
}

function insideSessionBoundary(session: ActiveSession, value: string): boolean {
  const instant = Date.parse(value);
  const started = session.startedAt ? Date.parse(session.startedAt) : Number.NEGATIVE_INFINITY;
  const expires = session.expiresAt ? Date.parse(session.expiresAt) : Number.POSITIVE_INFINITY;
  return Number.isFinite(instant) && instant >= started && instant <= expires;
}

function updateMark(
  session: ActiveSession,
  symbol: string,
  price: number,
  observedAt: string,
): boolean {
  const normalized = timestamp(observedAt);
  if (!normalized || !Number.isFinite(price) || price <= 0) return false;
  const previous = session.markTimes[symbol];
  if (previous && Date.parse(normalized) < Date.parse(previous)) return false;
  const history = session.markHistory[symbol] ?? [];
  const observed = { price, observedAt: normalized };
  if (history.at(-1)?.observedAt === normalized) history[history.length - 1] = observed;
  else history.push(observed);
  if (history.length > MAX_MARK_HISTORY_PER_SYMBOL) {
    history.splice(0, history.length - MAX_MARK_HISTORY_PER_SYMBOL);
  }
  session.markHistory[symbol] = history;
  session.marks[symbol] = price;
  session.markTimes[symbol] = normalized;
  return true;
}

function observedMarkAt(
  session: ActiveSession,
  symbol: string,
  asOf?: string,
): ObservedMark | undefined {
  const history = session.markHistory[symbol] ?? [];
  if (!asOf) return history.at(-1);
  const boundary = Date.parse(asOf);
  if (!Number.isFinite(boundary)) return undefined;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const mark = history[index]!;
    if (Date.parse(mark.observedAt) <= boundary) return mark;
  }
  return undefined;
}

function firstObservedMarkAfter(
  session: ActiveSession,
  symbol: string,
  after: string,
): ObservedMark | undefined {
  const boundary = Date.parse(after);
  if (!Number.isFinite(boundary)) return undefined;
  return (session.markHistory[symbol] ?? []).find((mark) => (
    Date.parse(mark.observedAt) > boundary
  ));
}

function firstObservedMarkAtOrAfter(
  session: ActiveSession,
  symbol: string,
  at: string,
): ObservedMark | undefined {
  const boundary = Date.parse(at);
  if (!Number.isFinite(boundary)) return undefined;
  return (session.markHistory[symbol] ?? []).find((mark) => (
    Date.parse(mark.observedAt) >= boundary
  ));
}

function pairModelComparisonLane(
  pair: PairCatalogEntry,
  model: NormalizedPairModelOutput,
  score: PairEnsembleDecision["componentScores"]["chronos2"],
): PairStrategyLaneObservation {
  if (model.status === "unavailable") {
    return {
      status: "unavailable",
      unavailableReason: model.reasonCodes.join(",") || "model_unavailable",
      calibrationStatus: model.calibration.status === "good"
        ? undefined
        : model.calibration.status,
      ...(model.provenance.latencyMs !== undefined
        ? { latencyMs: model.provenance.latencyMs } : {}),
    };
  }
  const mapping = mapPairDirection(pair, score.preferredDirection);
  const directionProbability = score.preferredDirection === "bull"
    ? model.upProbability
    : score.preferredDirection === "bear" ? model.downProbability : undefined;
  return {
    status: "available",
    direction: score.preferredDirection,
    executionSymbol: mapping.executionSymbol,
    ...(directionProbability !== undefined ? { directionProbability } : {}),
    calibrationStatus: model.calibration.status,
    ...(model.provenance.latencyMs !== undefined
      ? { latencyMs: model.provenance.latencyMs } : {}),
  };
}

function pairRustComparisonLane(
  pair: PairCatalogEntry,
  rust: PairRustTechnicalInput,
  score: PairEnsembleDecision["componentScores"]["rust"],
  origin: string,
): PairStrategyLaneObservation {
  const rustOrigin = timestamp(rust.signalOriginAt);
  const originAligned = rustOrigin
    && Date.parse(rustOrigin) === Date.parse(origin);
  const latencyMs = rust.observedAt && Number.isFinite(Date.parse(rust.observedAt))
    ? Math.max(0, Date.parse(rust.observedAt) - Date.parse(origin))
    : undefined;
  if (!rust.status || !originAligned
    || rust.dataQuality === "stale" || rust.dataQuality === "unavailable") {
    return {
      status: "unavailable",
      unavailableReason: !rust.status
        ? "rust_signal_unavailable"
        : !originAligned ? "rust_origin_not_aligned" : `rust_data_${rust.dataQuality}`,
      calibrationStatus: "unavailable",
      ...(latencyMs !== undefined ? { latencyMs } : {}),
    };
  }
  const mapping = mapPairDirection(pair, score.preferredDirection);
  return {
    status: "available",
    direction: score.preferredDirection,
    executionSymbol: mapping.executionSymbol,
    ...(rust.confidence !== undefined && score.preferredDirection !== "cash"
      ? { directionProbability: rust.confidence } : {}),
    calibrationStatus: "unavailable",
    ...(latencyMs !== undefined ? { latencyMs } : {}),
  };
}

function pairEnsembleComparisonLane(
  pair: PairCatalogEntry,
  decision: PairEnsembleDecision,
): PairStrategyLaneObservation {
  const mapping = mapPairDirection(pair, decision.direction);
  const directionProbability = decision.direction === "cash"
    ? undefined
    : Math.max(0, Math.min(1, decision.finalScores[decision.direction]));
  return {
    status: "available",
    direction: decision.direction,
    executionSymbol: mapping.executionSymbol,
    ...(directionProbability !== undefined ? { directionProbability } : {}),
    calibrationStatus: "unavailable",
  };
}

function pairComparisonReasons(
  session: ActiveSession,
  lane: "chronos2" | "kronos" | "rust" | "ensemble",
): UnknownRecord[] {
  return session.decisions.flatMap((decision) => {
    if (!decision.ensemble || !decision.modelOutputs || !decision.rustSignal) return [];
    const common = {
      symbol: decision.symbol,
      signalSymbol: decision.signalSymbol,
      executionSymbol: decision.executionSymbol,
      action: decision.direction,
      decidedAt: decision.decidedAt,
    };
    if (lane === "ensemble") {
      return [{
        ...common,
        reason: decision.reasons.join(" · "),
        reasons: decision.reasons,
      }];
    }
    if (lane === "rust") {
      const direction = decision.ensemble.componentScores.rust.preferredDirection;
      const reasons = uniqueWarnings([
        `status=${decision.rustSignal.status ?? "unavailable"}`,
        `direction=${direction}`,
        `data_quality=${decision.rustSignal.dataQuality}`,
        ...(decision.rustSignal.rationale ?? []),
      ]);
      return [{
        ...common,
        executionSymbol: mapPairDirection(session.pair!.catalog, direction).executionSymbol,
        action: direction,
        reason: reasons.join(" · "),
        reasons,
      }];
    }
    const model = decision.modelOutputs[lane];
    const direction = decision.ensemble.componentScores[lane].preferredDirection;
    const reasons = uniqueWarnings([
      `status=${model.status}`,
      `direction=${direction}`,
      ...model.reasonCodes,
    ]);
    return [{
      ...common,
      executionSymbol: mapPairDirection(session.pair!.catalog, direction).executionSymbol,
      action: direction,
      reason: reasons.join(" · "),
      reasons,
    }];
  }).slice(-MAX_REPORT_DECISIONS);
}

function buildPairStrategyComparison(session: ActiveSession): unknown {
  if (!session.pair) return undefined;
  const observations = [...session.pair.comparisonObservations].sort(
    (left, right) => Date.parse(left.origin) - Date.parse(right.origin),
  );
  const comparison = comparePairStrategies({
    conditionId: `${session.pair.catalog.pairId}:same-origin-cost-execution/v1`,
    initialCapital: session.request.initialCash,
    costs: {
      commissionBpsPerSide: session.request.costs.commissionBpsPerSide,
      taxBpsOnExit: session.request.costs.taxBpsOnExit,
      spreadBpsRoundTrip: session.request.costs.spreadBpsRoundTrip,
      slippageBpsPerSide: session.request.costs.slippageBpsPerSide,
      switchCostBps: Math.max(5, session.request.costs.spreadBpsRoundTrip),
    },
    executionPolicyId: "strict-next-observed-after-common-eligibility/v1",
    observations,
  });
  const pending = session.pair.comparisonPending.length;
  const lanes = Object.fromEntries(Object.entries(comparison.lanes).map(([id, metrics]) => {
    const status = pending && metrics.status === "available" ? "partial" : metrics.status;
    return [id, {
      id,
      ...metrics,
      status,
      trades: metrics.tradeCount,
      costs: metrics.totalCosts,
      switches: metrics.transitionCount,
      executionAccuracy: metrics.executionSelectionAccuracy,
      calibration: metrics.calibrationBrierScore,
      calibrationUnavailableRatio: metrics.calibrationUnavailableRate,
      unavailableRatio: metrics.unavailableRate,
      latencyMs: metrics.averageLatencyMs,
      decisionReasons: pairComparisonReasons(
        session,
        id as "chronos2" | "kronos" | "rust" | "ensemble",
      ),
      ...(metrics.status === "unavailable" ? {
        unavailableReason: pending
          ? "공통 origin의 실행 가능 가격 평가가 아직 완료되지 않았습니다."
          : "동일 조건으로 완료된 평가 관측이 없습니다.",
      } : {}),
    }];
  }));
  return {
    ...comparison,
    pairId: session.pair.catalog.pairId,
    incompleteCount: Object.values(lanes).filter(({ status }) => status !== "available").length,
    pendingOriginCount: pending,
    skippedOriginCount: session.pair.comparisonSkipped.length,
    skippedOrigins: session.pair.comparisonSkipped.slice(-MAX_REPORT_DECISIONS),
    lanes,
    strategies: lanes,
  };
}

function markToMarket(session: ActiveSession, asOf?: string): {
  equity: number;
  invested: number;
  unavailable: string[];
} {
  let invested = 0;
  const unavailable: string[] = [];
  for (const [symbol, position] of Object.entries(session.ledger.positions)) {
    const mark = observedMarkAt(session, symbol, asOf)?.price;
    if (mark === undefined || !Number.isFinite(mark) || mark <= 0) {
      invested += position.quantity * position.averagePrice;
      unavailable.push(symbol);
    } else {
      invested += position.quantity * mark;
    }
  }
  return {
    equity: session.ledger.cash + invested,
    invested,
    unavailable,
  };
}

function runView(run: PortfolioRunRecord) {
  return {
    runId: run.id,
    kind: run.kind,
    status: run.status,
    progress: run.progress,
    ...(run.error !== undefined ? { error: run.error } : {}),
    warnings: run.warnings,
    createdAt: new Date(run.createdAt).toISOString(),
    ...(run.startedAt ? { startedAt: new Date(run.startedAt).toISOString() } : {}),
    ...(run.finishedAt ? { finishedAt: new Date(run.finishedAt).toISOString() } : {}),
  };
}

function values(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function firstDefined(source: UnknownRecord | undefined, ...keys: string[]): unknown {
  if (!source) return undefined;
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null) return source[key];
  }
  return undefined;
}

function stringValues(value: unknown): string[] {
  return values(value).flatMap((item) => {
    const text = nonempty(item, 1_000);
    return text ? [text] : [];
  });
}

function runSnapshot(run: PortfolioRunRecord): UnknownRecord | undefined {
  return record(record(run.result)?.snapshot) ?? record(record(run.summary)?.snapshot);
}

function simulationConfiguration(
  run: PortfolioRunRecord,
  snapshot: UnknownRecord | undefined,
) {
  const input = record(run.input);
  const schemaVersion = nonempty(
    firstDefined(input, "schemaVersion", "schema_version")
      ?? firstDefined(snapshot, "schemaVersion", "schema_version"),
    128,
  );
  const policyVersion = nonempty(
    firstDefined(input, "policyVersion", "policy_version")
      ?? firstDefined(snapshot, "policyVersion", "policy_version"),
    128,
  );
  const marketCountry = nonempty(
    firstDefined(snapshot, "marketCountry", "market_country")
      ?? firstDefined(input, "marketCountry", "market_country"),
    8,
  );
  const initialCash = finite(
    firstDefined(snapshot, "initialCash", "initial_cash")
      ?? firstDefined(input, "initialCash", "initial_cash"),
  );
  const durationMinutes = finite(firstDefined(input, "durationMinutes", "duration_minutes"));
  const preset = nonempty(
    firstDefined(snapshot, "preset") ?? firstDefined(input, "preset"),
    64,
  );
  const riskTolerance = finite(
    firstDefined(snapshot, "riskTolerance", "risk_tolerance")
      ?? firstDefined(input, "riskTolerance", "risk_tolerance"),
  );
  const selection = firstDefined(snapshot, "selection") ?? firstDefined(input, "selection");
  const strategy = firstDefined(snapshot, "strategy") ?? firstDefined(input, "strategy");
  const costs = firstDefined(input, "costs");
  const policyProfile = firstDefined(snapshot, "policyProfile", "policy_profile")
    ?? firstDefined(input, "resolvedPolicyProfile", "resolved_policy_profile");
  const decisionCadence = firstDefined(input, "decisionCadence", "decision_cadence");
  return {
    ...(schemaVersion ? { schemaVersion } : {}),
    ...(policyVersion ? { policyVersion } : {}),
    ...(marketCountry ? { marketCountry } : {}),
    ...(initialCash !== undefined ? { initialCash } : {}),
    ...(durationMinutes !== undefined ? { durationMinutes } : {}),
    ...(selection !== undefined ? { selection } : {}),
    ...(strategy !== undefined ? { strategy } : {}),
    ...(preset ? { preset } : {}),
    ...(riskTolerance !== undefined ? { riskTolerance } : {}),
    ...(costs !== undefined ? { costs } : {}),
    ...(policyProfile !== undefined ? { policyProfile } : {}),
    ...(decisionCadence !== undefined ? { decisionCadence } : {}),
  };
}

function modelView(value: unknown): UnknownRecord | undefined {
  const source = record(value);
  const direct = nonempty(value, 256);
  if (!source && !direct) return undefined;
  const modelId = direct ?? nonempty(firstDefined(source, "modelId", "model_id", "id", "name"), 256);
  const modelRevision = nonempty(
    firstDefined(source, "modelRevision", "model_revision", "revision"),
    256,
  );
  const tokenizerId = nonempty(firstDefined(source, "tokenizerId", "tokenizer_id"), 256);
  const tokenizerRevision = nonempty(
    firstDefined(source, "tokenizerRevision", "tokenizer_revision"),
    256,
  );
  const sourceRevision = nonempty(
    firstDefined(source, "sourceRevision", "source_revision"),
    256,
  );
  const loaderVersion = nonempty(
    firstDefined(source, "loaderVersion", "loader_version"),
    256,
  );
  const license = nonempty(firstDefined(source, "license"), 128);
  const device = nonempty(firstDefined(source, "device"), 64);
  const dtype = nonempty(firstDefined(source, "dtype"), 64);
  const attentionBackend = nonempty(
    firstDefined(source, "attentionBackend", "attention_backend"),
    64,
  );
  const loaded = firstDefined(source, "loaded");
  if (!modelId && !modelRevision && !device && typeof loaded !== "boolean") return undefined;
  return {
    ...(modelId ? { modelId } : {}),
    ...(modelRevision ? { modelRevision } : {}),
    ...(tokenizerId ? { tokenizerId } : {}),
    ...(tokenizerRevision ? { tokenizerRevision } : {}),
    ...(sourceRevision ? { sourceRevision } : {}),
    ...(loaderVersion ? { loaderVersion } : {}),
    ...(license ? { license } : {}),
    ...(device ? { device } : {}),
    ...(dtype ? { dtype } : {}),
    ...(attentionBackend ? { attentionBackend } : {}),
    ...(typeof loaded === "boolean" ? { loaded } : {}),
  };
}

function modelProvenance(
  selected: readonly unknown[],
  decisions: readonly unknown[],
): UnknownRecord[] {
  const models = new Map<string, UnknownRecord & { symbols: string[] }>();
  for (const entry of [...selected, ...decisions]) {
    const item = record(entry);
    const model = modelView(item?.model);
    if (!model) continue;
    const key = JSON.stringify(model);
    const symbol = nonempty(item?.symbol, 32);
    const previous = models.get(key);
    if (previous) {
      if (symbol && !previous.symbols.includes(symbol)) previous.symbols.push(symbol);
      continue;
    }
    models.set(key, {
      ...model,
      symbols: symbol ? [symbol] : [],
    });
    if (models.size >= MAX_REPORT_MODEL_PROVENANCE) break;
  }
  return [...models.values()];
}

function boundedChart(value: unknown): UnknownRecord | undefined {
  const source = record(value);
  const symbol = nonempty(source?.symbol, 32);
  if (!source || !symbol) return undefined;
  return {
    symbol,
    ...(nonempty(source.name, 256) ? { name: nonempty(source.name, 256) } : {}),
    ...(nonempty(source.currency, 8) ? { currency: nonempty(source.currency, 8) } : {}),
    bars: values(source.bars).slice(-MAX_REPORT_CHART_BARS),
    indicators: values(source.indicators).slice(-MAX_REPORT_CHART_INDICATORS),
    patterns: values(source.patterns).slice(-MAX_REPORT_CHART_PATTERNS),
    ...(timestamp(source.updatedAt) ? { updatedAt: timestamp(source.updatedAt) } : {}),
  };
}

function boundedCharts(value: unknown): UnknownRecord[] {
  return values(value)
    .slice(0, MAX_REPORT_CHARTS)
    .map(boundedChart)
    .filter((item): item is UnknownRecord => item !== undefined);
}

function boundedSnapshot(input: {
  source: UnknownRecord;
  selected: unknown[];
  positions: unknown[];
  charts: UnknownRecord[];
  trades: unknown[];
  decisions: unknown[];
  warnings: string[];
}) {
  const source = input.source;
  return {
    ...(firstDefined(source, "schemaVersion", "schema_version") !== undefined
      ? { schemaVersion: firstDefined(source, "schemaVersion", "schema_version") } : {}),
    ...(firstDefined(source, "policyVersion", "policy_version") !== undefined
      ? { policyVersion: firstDefined(source, "policyVersion", "policy_version") } : {}),
    ...(source.phase !== undefined ? { phase: source.phase } : {}),
    ...(source.createdAt !== undefined ? { createdAt: source.createdAt } : {}),
    ...(source.startedAt !== undefined ? { startedAt: source.startedAt } : {}),
    ...(source.expiresAt !== undefined ? { expiresAt: source.expiresAt } : {}),
    ...(source.marketCountry !== undefined ? { marketCountry: source.marketCountry } : {}),
    ...(source.currency !== undefined ? { currency: source.currency } : {}),
    ...(source.selection !== undefined ? { selection: source.selection } : {}),
    ...(source.strategy !== undefined ? { strategy: source.strategy } : {}),
    ...(source.pairStrategy !== undefined ? { pairStrategy: source.pairStrategy } : {}),
    ...(source.pairState !== undefined ? { pairState: source.pairState } : {}),
    ...(source.strategyComparison !== undefined
      ? { strategyComparison: source.strategyComparison } : {}),
    ...(source.criterion !== undefined ? { criterion: source.criterion } : {}),
    ...(source.preset !== undefined ? { preset: source.preset } : {}),
    ...(source.riskTolerance !== undefined ? { riskTolerance: source.riskTolerance } : {}),
    ...(source.policyProfile !== undefined ? { policyProfile: source.policyProfile } : {}),
    ...(source.initialCash !== undefined ? { initialCash: source.initialCash } : {}),
    ...(source.cash !== undefined ? { cash: source.cash } : {}),
    ...(source.equity !== undefined ? { equity: source.equity } : {}),
    ...(source.invested !== undefined ? { invested: source.invested } : {}),
    ...(source.realizedPnl !== undefined ? { realizedPnl: source.realizedPnl } : {}),
    ...(source.totalCosts !== undefined ? { totalCosts: source.totalCosts } : {}),
    ...(source.progress !== undefined ? { progress: source.progress } : {}),
    ...(source.decisionCadence !== undefined ? { decisionCadence: source.decisionCadence } : {}),
    selected: input.selected,
    positions: input.positions,
    pendingActions: values(source.pendingActions).slice(-10),
    charts: input.charts,
    trades: input.trades,
    decisions: input.decisions,
    warnings: input.warnings,
    ...(source.capabilities !== undefined ? { capabilities: source.capabilities } : {}),
  };
}

function countFromArtifact(
  artifacts: ReadonlyMap<ArtifactType, ArtifactDescriptor>,
  type: ArtifactType,
  fallback: number,
): number {
  const value = artifacts.get(type)?.rowCount;
  return Number.isSafeInteger(value) && Number(value) >= 0
    ? Math.max(Number(value), fallback)
    : fallback;
}

function reportLimit(total: number, returned: number, maximum: number) {
  return {
    total,
    returned,
    maximum,
    truncated: total > returned,
    window: "latest" as const,
  };
}

function performanceView(input: {
  run: PortfolioRunRecord;
  snapshot: UnknownRecord;
  positions: readonly unknown[];
  tradeCount: number;
  decisionCount: number;
}) {
  const summary = record(input.run.summary);
  const configuration = simulationConfiguration(input.run, input.snapshot);
  const initialCash = finite(
    firstDefined(input.snapshot, "initialCash", "initial_cash")
      ?? firstDefined(summary, "initialCash", "initial_cash")
      ?? configuration.initialCash,
  );
  const finalEquity = finite(
    firstDefined(input.snapshot, "equity", "finalEquity", "final_equity")
      ?? firstDefined(summary, "finalEquity", "final_equity"),
  );
  const cash = finite(firstDefined(input.snapshot, "cash"));
  const realizedPnl = finite(
    firstDefined(input.snapshot, "realizedPnl", "realized_pnl"),
  ) ?? 0;
  const unrealizedPnl = input.positions.reduce<number>((total, value) => (
    total + (finite(firstDefined(record(value), "unrealizedPnl", "unrealized_pnl")) ?? 0)
  ), 0);
  const totalCosts = finite(
    firstDefined(input.snapshot, "totalCosts", "total_costs")
      ?? firstDefined(summary, "totalCosts", "total_costs"),
  ) ?? 0;
  const returnRatio = finite(
    firstDefined(summary, "returnRatio", "return_ratio"),
  ) ?? (
    initialCash !== undefined && initialCash > 0 && finalEquity !== undefined
      ? finalEquity / initialCash - 1
      : undefined
  );
  const netProfitLoss = finite(
    firstDefined(summary, "netProfitLoss", "net_profit_loss"),
  ) ?? (
    initialCash !== undefined && finalEquity !== undefined
      ? finalEquity - initialCash
      : undefined
  );
  return {
    ...(initialCash !== undefined ? { initialCash } : {}),
    ...(finalEquity !== undefined ? { finalEquity } : {}),
    ...(cash !== undefined ? { cash } : {}),
    ...(netProfitLoss !== undefined ? { netProfitLoss } : {}),
    ...(returnRatio !== undefined ? { returnRatio } : {}),
    realizedPnl,
    unrealizedPnl,
    totalCosts,
    tradeCount: input.tradeCount,
    decisionCount: input.decisionCount,
    positionCount: input.positions.length,
  };
}

function historyItem(run: PortfolioRunRecord) {
  const snapshot = runSnapshot(run) ?? {};
  const summary = record(run.summary);
  const configuration = simulationConfiguration(run, snapshot);
  const selected = values(snapshot.selected).slice(0, 2);
  const positions = values(snapshot.positions).slice(0, 2);
  const trades = values(snapshot.trades);
  const decisions = values(snapshot.decisions);
  const tradeCount = finite(firstDefined(summary, "tradeCount", "trade_count")) ?? trades.length;
  const decisionCount = finite(firstDefined(summary, "decisionCount", "decision_count"))
    ?? decisions.length;
  const performance = performanceView({
    run,
    snapshot,
    positions,
    tradeCount,
    decisionCount,
  });
  const firstModel = modelView(record(selected[0])?.model);
  return {
    runId: run.id,
    status: run.status,
    progress: run.progress,
    createdAt: new Date(run.createdAt).toISOString(),
    ...(run.startedAt !== undefined ? { startedAt: new Date(run.startedAt).toISOString() } : {}),
    ...(run.finishedAt !== undefined ? { finishedAt: new Date(run.finishedAt).toISOString() } : {}),
    ...(configuration.marketCountry ? { marketCountry: configuration.marketCountry } : {}),
    ...(configuration.preset ? { preset: configuration.preset } : {}),
    ...(configuration.riskTolerance !== undefined
      ? { riskTolerance: configuration.riskTolerance } : {}),
    ...(configuration.selection !== undefined ? { selection: configuration.selection } : {}),
    ...(configuration.strategy !== undefined ? { strategy: configuration.strategy } : {}),
    selected,
    ...(nonempty(snapshot.currency, 8) ? { currency: nonempty(snapshot.currency, 8) } : {}),
    ...performance,
    ...(firstModel ? { model: firstModel } : {}),
    decisionCadence: firstDefined(snapshot, "decisionCadence", "decision_cadence") ?? null,
    ...(snapshot.strategyComparison !== undefined
      ? { strategyComparison: snapshot.strategyComparison } : {}),
    warnings: uniqueWarnings([...run.warnings, ...stringValues(snapshot.warnings)]).slice(-20),
    ...(run.error !== undefined ? { error: run.error } : {}),
  };
}

export class AiTradingSimulationService {
  private readonly active = new Map<string, ActiveSession>();
  private readonly startingOwners = new Set<string>();
  private readonly startTasks = new Set<Promise<unknown>>();
  private readonly startTasksByOwner = new Map<string, Promise<unknown>>();
  private readonly progressTasks = new Set<Promise<void>>();
  private readonly now: () => number;
  private readonly progressUpdateMs: number;
  private readonly selectionMaximumAttempts: number;
  private readonly selectionRetryDelayMs: number;
  private readonly removeLiveListener: () => void;
  private closed = false;
  private closeTask?: Promise<void>;

  constructor(
    private readonly market: SimulationMarketSource,
    private readonly live: SimulationLiveSource,
    private readonly runs: RunService,
    private readonly repository: RunRepository,
    private readonly artifacts: ArtifactService,
    private readonly config: AiTradingSimulationConfig,
  ) {
    if (!Number.isInteger(config.maximumDurationMinutes) || config.maximumDurationMinutes < 1
      || !Number.isInteger(config.maximumActiveSessions) || config.maximumActiveSessions < 1
      || !Number.isInteger(config.candidatePoolSize) || config.candidatePoolSize < 2) {
      throw new Error("AI simulation configuration is invalid.");
    }
    this.now = config.now ?? Date.now;
    this.progressUpdateMs = config.progressUpdateMs ?? 5_000;
    this.selectionMaximumAttempts = config.selectionMaximumAttempts;
    this.selectionRetryDelayMs = config.selectionRetryDelayMs;
    if (!Number.isInteger(this.progressUpdateMs) || this.progressUpdateMs < 100 || this.progressUpdateMs > 60_000) {
      throw new Error("AI simulation progress interval must be in 100..=60000ms.");
    }
    if (!Number.isInteger(this.selectionMaximumAttempts)
      || this.selectionMaximumAttempts < 1
      || this.selectionMaximumAttempts > 10
      || !Number.isInteger(this.selectionRetryDelayMs)
      || this.selectionRetryDelayMs < 1
      || this.selectionRetryDelayMs > 120_000) {
      throw new Error("AI simulation selection retry configuration is invalid.");
    }
    this.removeLiveListener = live.onEvent((event) => {
      void this.handleLiveEvent(event).catch((error) => {
        console.warn("[simulation] live event 처리 실패:", error instanceof Error ? error.message : error);
      });
    });
  }

  status(enabled = true) {
    const provider = this.market.status(enabled);
    return {
      schemaVersion: AI_SIMULATION_CONTRACT_VERSION,
      enabled,
      limits: {
        minimumInitialCash: 100_000,
        maximumInitialCash: 10_000_000_000_000,
        minimumDurationMinutes: 1,
        maximumDurationMinutes: this.config.maximumDurationMinutes,
        selectedSymbolCount: [1, 2],
        candidatePoolSize: this.config.candidatePoolSize,
        maximumActiveSessions: this.config.maximumActiveSessions,
        selectionMaximumAttempts: this.selectionMaximumAttempts,
        selectionRetryDelayMs: this.selectionRetryDelayMs,
      },
      providers: provider.providers,
      capabilities: {
        realOrder: false,
        orderApiDependency: false,
        mcp: false,
        autonomousPaperTrading: true,
        aiSelectsSymbols: true,
        manualSymbolSelection: true,
        rustTechnicalIndicators: true,
        deterministicChartPatterns: true,
        eventDrivenDecisions: true,
        gpuForecastWorker: "provenance_reported_per_run",
        nextObservedExecutionOnly: true,
        pairStrategy: true,
        dualModelEnsemble: true,
        marketCountries: "KR,US",
      },
      pairStrategy: {
        enabled: true,
        catalogVersion: PAIR_CATALOG_VERSION,
        allowDegradedMode: true,
        directions: ["bull", "bear", "cash"],
        exclusivity: "one_active_direction_per_pair",
        models: {
          chronos2: "amazon/chronos-2",
          kronos: "NeoQuasar/Kronos-small",
          explicitChronosFallback: "amazon/chronos-bolt-small",
        },
        pairs: [...DEFAULT_PAIR_CATALOG.values()].map((pair) => ({
          pairId: pair.pairId,
          signalSymbol: pair.signalSymbol,
          bull: pair.bull,
          bear: pair.bear,
          allowedSessions: pair.allowedSessions,
          maxSpreadBps: pair.maxSpreadBps,
        })),
      },
      policy: {
        version: AI_PAPER_POLICY_VERSION,
        side: "long_only",
        quantity: "whole_share",
        initialPortfolio: "cash_only_zero_holdings",
        cadence: "event_driven_immediately_after_each_new_finalized_one_minute_bar",
        execution: "strictly_after_ai_generation_on_next_observed_trade_or_later_final_bar_open",
      },
      activeSessions: this.active.size,
      limitations: [
        "실제 주문 API를 호출하지 않는 가상 원장입니다.",
        "AI 전망은 투자 지시나 수익 보장이 아니며 모델이 unavailable이면 임의 신호를 만들지 않습니다.",
        "고정 초 단위 주기 없이 새 확정 1분봉이 들어오는 즉시 판단하며 이전 추론이 끝나지 않으면 최신 이벤트 한 번으로 합칩니다.",
        "진행 중인 봉을 미래정보처럼 사용하지 않고 최신 확정 분봉과 해당 시점의 실시간 체결·호가 snapshot만 사용합니다.",
        "판단 생성 이전 또는 같은 시각의 체결을 사용하지 않습니다.",
        "페어 전략은 기초자산 신호와 실행 ETF를 분리하며 bull·bear·cash 중 하나만 활성화합니다.",
        "Chronos-2, Kronos-small 또는 Rust 입력이 정렬되지 않거나 필수 데이터가 unavailable이면 cash로 닫힙니다.",
        "기간 종료 시 다음 유효 체결이 없으면 보유분은 마지막 관측가로 평가하고 매도를 만들지 않습니다.",
        "미국 데이마켓 호가는 unavailable이며 체결 피드와 확정 분봉만 사용할 수 있습니다.",
        "서버 재시작 중이던 forward session은 이어서 체결하지 않고 fail-closed 처리합니다.",
      ],
    };
  }

  async start(input: SimulationStartRequest, ownerSubject: string) {
    if (this.closed) throw new Error("AI simulation service is closed.");
    if (input.durationMinutes > this.config.maximumDurationMinutes) {
      throw new Error("시뮬레이션 기간이 설정된 상한을 초과했습니다.");
    }
    if (this.active.size + this.startingOwners.size >= this.config.maximumActiveSessions) {
      throw new Error("동시에 실행할 수 있는 AI 시뮬레이션 수를 초과했습니다.");
    }
    if (this.startingOwners.has(ownerSubject)
      || [...this.active.values()].some((session) => session.ownerSubject === ownerSubject)) {
      throw new Error("이미 진행 중인 AI 시뮬레이션이 있습니다.");
    }
    this.startingOwners.add(ownerSubject);
    const task = this.startReserved(input, ownerSubject);
    this.startTasks.add(task);
    this.startTasksByOwner.set(ownerSubject, task);
    try {
      return await task;
    } finally {
      this.startTasks.delete(task);
      if (this.startTasksByOwner.get(ownerSubject) === task) {
        this.startTasksByOwner.delete(ownerSubject);
      }
      this.startingOwners.delete(ownerSubject);
    }
  }

  private async startReserved(input: SimulationStartRequest, ownerSubject: string) {
    const createdAtMs = this.now();
    const createdAt = new Date(createdAtMs).toISOString();
    const strategy = simulationStrategy(input);
    const pairCatalog = strategy.mode === "pair"
      ? getPairCatalogEntry(strategy.pairId)
      : undefined;
    if (pairCatalog && input.marketCountry !== pairCatalog.marketCountry) {
      throw new Error(
        `페어 catalog 시장이 요청과 일치하지 않습니다: ${pairCatalog.marketCountry}`,
      );
    }
    const symbolCount = selectionSymbolCount(input);
    const policyProfile = pairCatalog ? {
      ...DEFAULT_PAIR_ENSEMBLE_POLICY_PROFILE,
      weights: { ...DEFAULT_PAIR_ENSEMBLE_POLICY_PROFILE.weights },
      modelScoreWeights: {
        ...DEFAULT_PAIR_ENSEMBLE_POLICY_PROFILE.modelScoreWeights,
      },
      allowDegradedMode: strategy.mode === "pair" && strategy.allowDegradedMode,
    } : resolvePaperPolicyProfile(input.preset, input.riskTolerance);
    const config = {
      schema_version: AI_SIMULATION_CONTRACT_VERSION,
      policy_version: pairCatalog
        ? PAIR_ENSEMBLE_POLICY_VERSION
        : AI_PAPER_POLICY_VERSION,
      mode: "forward_paper_session",
      market_country: input.marketCountry,
      selection: input.selection,
      strategy,
      ...(pairCatalog ? {
        pair_catalog_version: pairCatalog.catalogVersion,
        pair: pairCatalog,
      } : {}),
      scanner_criterion: selectionCriterion(input),
      initial_cash: input.initialCash,
      duration_minutes: input.durationMinutes,
      selected_symbol_count: symbolCount,
      preset: input.preset,
      risk_tolerance: input.riskTolerance,
      resolved_policy_profile: policyProfile,
      costs: input.costs,
      candidate_pool_size: this.config.candidatePoolSize,
      decision_cadence: "event_driven_finalized_one_minute_bar",
      selection_maximum_attempts: this.selectionMaximumAttempts,
      selection_retry_delay_ms: this.selectionRetryDelayMs,
      session_nonce: createdAt,
      real_order_api: false,
      mcp: false,
    };
    const dataRevision = `live-paper:${input.marketCountry}:${createdAtMs}`;
    const run = await this.runs.create({
      ownerSubject,
      kind: "ai_trading_simulation",
      config,
      dataRevision,
      totalCandidates: symbolCount,
    });
    try {
      if (!await this.repository.markRunning(run.id, createdAtMs)) {
        throw new Error("AI 시뮬레이션 run을 시작하지 못했습니다.");
      }
      await this.repository.addEvent(run.id, "simulation_selecting", {
        market_country: input.marketCountry,
        selection_mode: input.selection.mode,
        requested_symbol_count: symbolCount,
        requested_symbols: pairCatalog
          ? [
              pairCatalog.signalSymbol,
              pairCatalog.bull.executionSymbol,
              pairCatalog.bear.executionSymbol,
            ]
          : manuallySelectedSymbols(input),
        strategy,
        real_order_api: false,
      }, createdAtMs);
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown start error";
      try {
        await this.repository.fail(run.id, {
          code: "AI_SIMULATION_START_FAILED",
          message,
          retryable: true,
          real_order_api_used: false,
        }, [message], this.now());
      } catch (terminalError) {
        throw new AggregateError(
          [error, terminalError],
          "AI 시뮬레이션 시작과 실패 상태 저장이 모두 실패했습니다.",
        );
      }
      throw error;
    }
    const session: ActiveSession = {
      id: run.id,
      ownerSubject,
      request: input,
      dataRevision,
      phase: "selecting",
      createdAt,
      metadata: new Map(),
      ledger: createPaperLedger(input.initialCash),
      ledgerRevision: 0,
      marks: {},
      markTimes: {},
      markHistory: {},
      pending: new Map(),
      decisions: [],
      trades: [],
      equity: [{ timestamp: createdAt, equity: input.initialCash, cash: input.initialCash, invested: 0 }],
      charts: [],
      ...(pairCatalog ? {
        pair: {
          catalog: pairCatalog,
          direction: "cash" as const,
          runtimeState: createPairRuntimeState(pairCatalog),
          quotes: {},
          quoteEventTimes: {},
          comparisonPending: [],
          comparisonObservations: [],
          comparisonSkipped: [],
          provenanceRecords: [],
        },
      } : {}),
      warnings: [],
      decisionAbort: new AbortController(),
      decisionTriggeredEvents: 0,
      decisionCoalescedEvents: 0,
      decisionDuplicateEvents: 0,
      analysisRunning: false,
      analysisQueued: false,
      persistenceTail: Promise.resolve(),
    };
    this.active.set(run.id, session);
    void this.initialize(session).catch((error) => this.fail(session, error));
    return {
      runId: run.id,
      status: "running",
      snapshot: this.snapshot(session),
    };
  }

  private async checkpointSnapshot(run: PortfolioRunRecord): Promise<unknown> {
    try {
      const artifact = await this.artifacts.get(run.id, "simulation-diagnostics");
      const snapshot = record(record(artifact?.content)?.snapshot);
      if (!snapshot) return undefined;
      if (!["completed", "cancelled", "failed"].includes(run.status)) return snapshot;
      const checkpointWarnings = Array.isArray(snapshot.warnings)
        ? snapshot.warnings.filter((value): value is string => typeof value === "string")
        : [];
      const errorMessage = nonempty(record(run.error)?.message, 500);
      return {
        ...snapshot,
        phase: run.status,
        progress: 1,
        pendingActions: [],
        warnings: uniqueWarnings([
          ...checkpointWarnings,
          ...run.warnings,
          ...(errorMessage ? [errorMessage] : []),
        ]),
      };
    } catch {
      return undefined;
    }
  }

  async get(runId: string, ownerSubject: string) {
    const run = await this.repository.get(runId, ownerSubject);
    if (!run || run.kind !== "ai_trading_simulation") return undefined;
    const active = this.active.get(runId);
    const result = record(run.result);
    const summary = record(run.summary);
    const checkpoint = active || result?.snapshot || summary?.snapshot
      ? undefined
      : await this.checkpointSnapshot(run);
    const activeSnapshot = active ? this.snapshot(active) : undefined;
    return {
      run: runView(run),
      snapshot: run.status === "cancel_requested" && activeSnapshot
        ? { ...activeSnapshot, phase: "finalizing" }
        : activeSnapshot ?? result?.snapshot ?? summary?.snapshot ?? checkpoint,
    };
  }

  async current(ownerSubject: string) {
    const starting = this.startTasksByOwner.get(ownerSubject);
    if (starting) await starting.catch(() => undefined);
    const active = [...this.active.values()]
      .filter((session) => session.ownerSubject === ownerSubject)
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0];
    if (active) return this.get(active.id, ownerSubject);
    const listed = await this.repository.list({
      ownerSubject,
      kinds: ["ai_trading_simulation"],
      limit: 1,
    });
    const run = listed.items[0];
    if (!run) return undefined;
    const result = record(run.result);
    const summary = record(run.summary);
    const checkpoint = result?.snapshot || summary?.snapshot
      ? undefined
      : await this.checkpointSnapshot(run);
    return {
      run: runView(run),
      snapshot: result?.snapshot ?? summary?.snapshot ?? checkpoint,
    };
  }

  async list(input: SimulationHistoryListInput, ownerSubject: string) {
    const requestedLimit = Number.isSafeInteger(input.limit)
      ? Number(input.limit)
      : DEFAULT_HISTORY_PAGE_SIZE;
    const limit = Math.max(1, Math.min(MAX_HISTORY_PAGE_SIZE, requestedLimit));
    const listed = await this.repository.list({
      ownerSubject,
      kinds: ["ai_trading_simulation"],
      archived: "all",
      ...(input.statuses?.length ? { statuses: input.statuses } : {}),
      limit,
      ...(input.cursor ? { cursor: input.cursor } : {}),
    });
    const statuses = new Set(input.statuses ?? []);
    const items = listed.items
      .filter((run) => (
        run.ownerSubject === ownerSubject
        && run.kind === "ai_trading_simulation"
        && (!statuses.size || statuses.has(run.status))
      ))
      .map(historyItem);
    return {
      schemaVersion: AI_SIMULATION_CONTRACT_VERSION,
      items,
      ...(listed.nextCursor ? { nextCursor: listed.nextCursor } : {}),
      page: {
        limit,
        returned: items.length,
      },
    };
  }

  async report(runId: string, ownerSubject: string) {
    const run = await this.repository.get(runId, ownerSubject);
    if (!run
      || run.ownerSubject !== ownerSubject
      || run.kind !== "ai_trading_simulation") return undefined;

    const artifactFailures: string[] = [];
    const artifactEntries = await Promise.all(SIMULATION_ARTIFACT_TYPES.map(async (type) => {
      try {
        return [type, await this.artifacts.get(run.id, type)] as const;
      } catch {
        artifactFailures.push(`${type} artifact를 읽지 못했습니다.`);
        return [type, undefined] as const;
      }
    }));
    const artifactContent = new Map<ArtifactType, unknown>();
    const artifactDescriptors = new Map<ArtifactType, ArtifactDescriptor>();
    for (const [type, artifact] of artifactEntries) {
      if (!artifact) continue;
      artifactContent.set(type, artifact.content);
      artifactDescriptors.set(type, artifact.descriptor);
    }

    const diagnostic = record(artifactContent.get("simulation-diagnostics"));
    const comparisonArtifact = record(artifactContent.get("simulation-comparison"));
    const provenanceArtifact = artifactContent.get("simulation-provenance");
    const active = this.active.get(run.id);
    const sourceSnapshot = active
      ? record(this.snapshot(active)) ?? {}
      : runSnapshot(run) ?? record(diagnostic?.snapshot) ?? {};
    const selectionEvidence = record(artifactContent.get("simulation-selection"));
    const selectionResult = record(selectionEvidence?.selection);
    const selected = values(sourceSnapshot.selected).length
      ? values(sourceSnapshot.selected).slice(0, 2)
      : values(selectionResult?.selected).slice(0, 2);
    const positions = values(sourceSnapshot.positions).slice(0, 2);
    const allDecisions = Array.isArray(artifactContent.get("simulation-decisions"))
      ? values(artifactContent.get("simulation-decisions"))
      : values(sourceSnapshot.decisions);
    const allTrades = Array.isArray(artifactContent.get("simulation-trades"))
      ? values(artifactContent.get("simulation-trades"))
      : values(sourceSnapshot.trades);
    const allEquity = Array.isArray(artifactContent.get("simulation-equity"))
      ? values(artifactContent.get("simulation-equity"))
      : [];
    const decisions = allDecisions.slice(-MAX_REPORT_DECISIONS);
    const trades = allTrades.slice(-MAX_REPORT_TRADES);
    const equity = allEquity.slice(-MAX_REPORT_EQUITY_POINTS);
    const charts = boundedCharts(sourceSnapshot.charts);
    const warnings = uniqueWarnings([
      ...run.warnings,
      ...stringValues(sourceSnapshot.warnings),
      ...artifactFailures,
    ]);
    const decisionCount = countFromArtifact(
      artifactDescriptors,
      "simulation-decisions",
      allDecisions.length,
    );
    const tradeCount = countFromArtifact(
      artifactDescriptors,
      "simulation-trades",
      allTrades.length,
    );
    const equityPointCount = countFromArtifact(
      artifactDescriptors,
      "simulation-equity",
      allEquity.length,
    );
    const configuration = simulationConfiguration(run, sourceSnapshot);
    const cadence = firstDefined(sourceSnapshot, "decisionCadence", "decision_cadence")
      ?? firstDefined(diagnostic, "decisionCadence", "decision_cadence")
      ?? null;
    const provenance = modelProvenance(selected, allDecisions);
    const strategyComparison = firstDefined(
      sourceSnapshot,
      "strategyComparison",
      "strategy_comparison",
    ) ?? firstDefined(
      comparisonArtifact,
      "strategyComparison",
      "strategy_comparison",
    ) ?? comparisonArtifact;
    const decisionProvenance = values(provenanceArtifact).slice(-MAX_REPORT_DECISIONS);
    const performance = performanceView({
      run,
      snapshot: sourceSnapshot,
      positions,
      tradeCount,
      decisionCount,
    });
    const snapshot = boundedSnapshot({
      source: sourceSnapshot,
      selected,
      positions,
      charts,
      trades,
      decisions,
      warnings,
    });
    const patternCount = charts.reduce(
      (total, chart) => total + values(chart.patterns).length,
      0,
    );
    return {
      schemaVersion: AI_SIMULATION_CONTRACT_VERSION,
      generatedAt: new Date(this.now()).toISOString(),
      run: runView(run),
      report: {
        configuration,
        selection: configuration.selection ?? null,
        selectionResult: selectionResult ?? null,
        selected,
        performance,
        cadence,
        decisions,
        trades,
        positions,
        equity,
        charts,
        modelProvenance: provenance,
        ...(strategyComparison !== undefined ? { strategyComparison } : {}),
        ...(decisionProvenance.length ? { decisionProvenance } : {}),
        evidence: {
          selection: selectionEvidence ?? null,
          chartPatternCount: patternCount,
          artifacts: [...artifactDescriptors.values()],
        },
        warnings,
        limits: {
          decisions: reportLimit(decisionCount, decisions.length, MAX_REPORT_DECISIONS),
          trades: reportLimit(tradeCount, trades.length, MAX_REPORT_TRADES),
          equity: reportLimit(equityPointCount, equity.length, MAX_REPORT_EQUITY_POINTS),
          charts: {
            maximum: MAX_REPORT_CHARTS,
            barsPerChart: MAX_REPORT_CHART_BARS,
            patternsPerChart: MAX_REPORT_CHART_PATTERNS,
            indicatorsPerChart: MAX_REPORT_CHART_INDICATORS,
          },
          modelProvenance: {
            maximum: MAX_REPORT_MODEL_PROVENANCE,
            returned: provenance.length,
          },
        },
      },
      snapshot,
    };
  }

  async cancel(runId: string, ownerSubject: string) {
    const run = await this.repository.get(runId, ownerSubject);
    if (!run || run.kind !== "ai_trading_simulation") return undefined;
    if (["queued", "running"].includes(run.status)) {
      // Persist cancellation intent before touching in-memory state. This makes
      // cancel win even when a concurrent completion is already finalizing.
      await this.repository.requestCancellation(runId, ownerSubject, this.now());
    }
    const session = this.active.get(runId);
    const reason = "사용자가 시뮬레이션 테스트를 중단했습니다.";
    if (session) {
      await this.finish(session, "cancelled", reason);
    } else if (["queued", "running", "cancel_requested"].includes(run.status)) {
      await this.repository.cancel(runId, {
        phase: "cancelled",
        cancelled: true,
        real_order_api_used: false,
      }, [reason], this.now());
    }
    return this.get(runId, ownerSubject);
  }

  close(reason = "server_shutdown"): Promise<void> {
    if (this.closeTask) return this.closeTask;
    this.closed = true;
    this.removeLiveListener();
    this.closeTask = this.closeActiveSessions(reason);
    return this.closeTask;
  }

  private async closeActiveSessions(reason: string): Promise<void> {
    await Promise.allSettled([...this.startTasks]);
    const sessions = [...this.active.values()];
    await Promise.allSettled(sessions.map((session) => (
      this.finish(session, "cancelled", `시뮬레이션이 중단되었습니다: ${reason}`)
    )));
    await Promise.allSettled([...this.progressTasks]);
  }

  private async initialize(session: ActiveSession): Promise<void> {
    if (session.pair) {
      await this.initializePair(session);
      return;
    }
    const symbolCount = selectionSymbolCount(session.request);
    const criterion = selectionCriterion(session.request);
    const manualSymbols = manuallySelectedSymbols(session.request);
    const manualSymbolSet = new Set(manualSymbols);
    let candidates: CandidateMetadata[] = [];
    let scannedCandidateCount = 0;
    let exchangeEligibleCount = 0;
    let scanAttempts = 0;
    for (let attempt = 1; attempt <= this.selectionMaximumAttempts; attempt += 1) {
      scanAttempts = attempt;
      const workspaceResult = await this.market.workspace({
        marketCountry: session.request.marketCountry,
        criterion,
        topCount: this.config.candidatePoolSize,
        interval: "1m",
        layoutColumns: 1,
        preset: session.request.preset,
        ...(manualSymbols.length ? { symbols: manualSymbols } : {}),
        scanOnly: true,
        includePortfolioContext: false,
      });
      if (session.phase !== "selecting") return;
      const scannedCandidates = workspaceCandidates(workspaceResult).slice(0, this.config.candidatePoolSize);
      const eligibleCandidates = session.request.marketCountry === "US"
        ? scannedCandidates.filter(({ exchange }) => exchange !== undefined)
        : scannedCandidates;
      candidates = manualSymbols.length
        ? manualSymbols.flatMap((symbol) => {
            const candidate = eligibleCandidates.find((item) => item.symbol === symbol);
            return candidate ? [candidate] : [];
          })
        : eligibleCandidates;
      scannedCandidateCount = scannedCandidates.length;
      exchangeEligibleCount = eligibleCandidates.length;
      if (eligibleCandidates.length !== scannedCandidates.length) {
        this.warn(session, "거래소 식별자가 없는 미국 후보를 AI 선정 대상에서 제외했습니다.");
      }
      if (candidates.length >= symbolCount) break;
      if (attempt >= this.selectionMaximumAttempts) {
        throw new Error(
          `${manualSymbols.length ? "직접 선택한 종목을 검증하지 못했습니다" : "AI가 선택할 수 있는 유효 스캔 후보가 부족합니다"}: `
          + `market=${session.request.marketCountry}, requested=${symbolCount}, `
          + `scanned=${scannedCandidateCount}, exchangeEligible=${exchangeEligibleCount}, `
          + `attempts=${scanAttempts}`,
        );
      }
      this.warn(
        session,
        `${manualSymbols.length ? "직접 선택한 종목 검증" : "유효 스캔 후보"}이 부족해 공급자 데이터를 제한 재조회합니다 `
        + `(${attempt}/${this.selectionMaximumAttempts}; market=${session.request.marketCountry}, `
        + `requested=${symbolCount}, scanned=${scannedCandidateCount}, `
        + `exchangeEligible=${exchangeEligibleCount}).`,
      );
      await this.waitForSelectionRetry(session);
      if (session.phase !== "selecting") return;
    }
    if (candidates.length < symbolCount) {
      throw new Error(
        `${manualSymbols.length ? "직접 선택한 종목을 검증하지 못했습니다" : "AI가 선택할 수 있는 유효 스캔 후보가 부족합니다"}: `
        + `market=${session.request.marketCountry}, requested=${symbolCount}, `
        + `scanned=${scannedCandidateCount}, exchangeEligible=${exchangeEligibleCount}, `
        + `attempts=${scanAttempts}`,
      );
    }
    if (manualSymbols.length && candidates.some(({ symbol }) => !manualSymbolSet.has(symbol))) {
      throw new Error("직접 선택한 종목 집합 밖의 후보가 포함되었습니다.");
    }
    session.metadata = new Map(candidates.map((candidate) => [candidate.symbol, candidate]));
    const candidateSymbols = candidates.map(({ symbol }) => symbol);
    const candidateExchanges = Object.fromEntries(candidates.flatMap(({ symbol, exchange }) => (
      exchange ? [[symbol, exchange] as const] : []
    )));
    const releaseCandidates = await this.live.retain(
      candidateSymbols,
      session.request.marketCountry,
      session.request.marketCountry === "US" ? candidateExchanges : undefined,
    );
    if (session.phase !== "selecting") {
      releaseCandidates();
      return;
    }
    session.release = releaseCandidates;
    let selection: AiPaperSelection | undefined;
    for (let attempt = 1; attempt <= this.selectionMaximumAttempts; attempt += 1) {
      await this.live.waitForIdle();
      if (session.phase !== "selecting") return;
      const forecastResult = await this.market.forecast({
        marketCountry: session.request.marketCountry,
        symbols: candidateSymbols,
        interval: "1m",
      }, {
        signal: session.decisionAbort.signal,
      });
      if (session.phase !== "selecting") return;
      selection = selectAiForecastSeries(forecastResult.forecast, {
        symbolCount,
        roundTripCostRate: roundTripCostRate(session.request.costs),
        riskPenalty: resolvePaperPolicyProfile(
          session.request.preset,
          session.request.riskTolerance,
        ).riskPenalty,
        notBeforeMs: this.now(),
      });
      if (selection.status === "available") break;
      const unavailable = forecastUnavailableCodes(forecastResult);
      if (!canRetryStaleSelection(selection, unavailable)
        || attempt >= this.selectionMaximumAttempts) {
        const visibleUnavailable = unavailable.slice(0, 20);
        const hiddenCount = unavailable.length - visibleUnavailable.length;
        throw new Error(
          `AI 종목 선정이 unavailable입니다: ${selection.reason ?? "unknown"}`
          + (visibleUnavailable.length ? ` (${visibleUnavailable.join(", ")}`
            + (hiddenCount > 0 ? `, 외 ${hiddenCount}건` : "")
            + ")" : ""),
        );
      }
      this.warn(
        session,
        `최신 완전 확정봉을 기다린 뒤 AI 종목 선정을 재시도합니다 (${attempt}/${this.selectionMaximumAttempts}).`,
      );
      await this.waitForSelectionRetry(session);
      if (session.phase !== "selecting") return;
    }
    if (!selection || selection.status !== "available") {
      throw new Error("AI 종목 선정 결과가 준비되지 않았습니다.");
    }
    if (manualSymbols.length
      && (selection.selected.length !== manualSymbols.length
        || selection.selected.some(({ symbol }) => !manualSymbolSet.has(symbol)))) {
      throw new Error("AI 예측 결과가 직접 선택한 종목 집합을 완전히 포함하지 않았습니다.");
    }
    if (selection.selected.some(({ symbol }) => !session.metadata.has(symbol))) {
      throw new Error("AI 종목 선정 결과가 요청한 스캔 후보 집합을 벗어났습니다.");
    }
    session.selection = selection;
    const symbols = selectedSymbols(session);
    const exchanges = Object.fromEntries(symbols.flatMap((symbol) => {
      const exchange = session.metadata.get(symbol)?.exchange;
      return exchange ? [[symbol, exchange] as const] : [];
    }));
    if (session.request.marketCountry === "US" && Object.keys(exchanges).length !== symbols.length) {
      throw new Error("미국 실시간 구독에 필요한 거래소 정보가 부족합니다.");
    }
    const releaseSelected = await this.live.retain(
      symbols,
      session.request.marketCountry,
      session.request.marketCountry === "US" ? exchanges : undefined,
    );
    if (session.phase !== "selecting") {
      releaseSelected();
      return;
    }
    const retainedSymbols = this.live.state?.symbols;
    if (retainedSymbols && symbols.some((symbol) => !retainedSymbols.some((retained) => (
      retained.marketCountry === session.request.marketCountry && retained.symbol === symbol
    )))) {
      releaseSelected();
      throw new Error("선정 종목의 실시간 체결 구독을 확보하지 못했습니다.");
    }
    session.release = combinedRelease(releaseCandidates, releaseSelected);
    try {
      releaseCandidates();
    } catch (error) {
      this.warn(session, `후보 실시간 구독 해제 실패: ${error instanceof Error ? error.message : "unknown"}`);
    }
    await this.live.waitForIdle();
    const chartWorkspace = await this.market.workspace({
      marketCountry: session.request.marketCountry,
      criterion,
      topCount: this.config.candidatePoolSize,
      symbols,
      interval: "1m",
      layoutColumns: 1,
      preset: session.request.preset,
      scanOnly: false,
      includePortfolioContext: false,
    });
    if (session.phase !== "selecting") return;
    session.charts = simulationChartsFromWorkspace(chartWorkspace, symbols);
    const missingCharts = symbols.filter((symbol) => !session.charts.some((chart) => (
      chart.symbol === symbol && chart.bars.length > 0
    )));
    if (missingCharts.length) {
      this.warn(session, `차트 분봉 unavailable: ${missingCharts.join(", ")}`);
    }
    const startedAtMs = this.now();
    session.startedAt = new Date(startedAtMs).toISOString();
    session.expiresAt = new Date(startedAtMs + session.request.durationMinutes * MINUTE_MS).toISOString();
    const runningTransition = transitionSimulationPhase(session.phase, "selection_ready");
    if (!runningTransition.accepted) return;
    session.phase = runningTransition.phase;
    session.lastDecisionTriggeredAt = session.startedAt;
    session.lastDecisionStartedAt = session.startedAt;
    const decisionRecordedAt = this.recordActions(
      session,
      selection,
      workspaceTechnicalStates(chartWorkspace, session.charts),
    );
    session.lastDecisionFinishedAt = decisionRecordedAt;
    this.recordEquity(session, decisionRecordedAt);
    await this.enqueuePersistence(session, async () => {
      await this.repository.addEvent(session.id, "simulation_ready", {
        symbols,
        model_id: selection.model?.modelId,
        model_revision: selection.model?.modelRevision,
        expires_at: session.expiresAt,
      }, startedAtMs);
      if (session.phase !== "running") return;
      await this.repository.updateProgress(session.id, {
        progress: 0,
        completedCandidates: symbols.length,
        totalCandidates: symbolCount,
        currentValidationWindow: session.startedAt,
      }, startedAtMs);
    });
    if (session.phase !== "running") return;
    await this.persistArtifacts(session);
    if (session.phase !== "running") return;
    const remainingMs = Math.max(0, Date.parse(session.expiresAt) - this.now());
    session.endTimer = setTimeout(() => {
      void this.finish(session, "completed", "설정한 시뮬레이션 기간이 종료되었습니다.")
        .catch((error) => console.warn(
          "[simulation] 기간 종료 처리 실패:",
          error instanceof Error ? error.message : error,
        ));
    }, remainingMs);
    session.endTimer.unref();
    session.progressTimer = setInterval(() => this.queueProgress(session), this.progressUpdateMs);
    session.progressTimer.unref();
  }

  private async initializePair(session: ActiveSession): Promise<void> {
    if (!session.pair || session.request.marketCountry !== "US") {
      throw new Error("페어 전략은 검증된 미국 catalog 세션에서만 시작할 수 있습니다.");
    }
    const pair = session.pair.catalog;
    const symbols = retainedSymbols(session);
    const expected = new Set(symbols);
    let candidates: CandidateMetadata[] = [];
    let attempts = 0;
    for (let attempt = 1; attempt <= this.selectionMaximumAttempts; attempt += 1) {
      attempts = attempt;
      const scan = await this.market.workspace({
        marketCountry: "US",
        criterion: selectionCriterion(session.request),
        topCount: Math.max(this.config.candidatePoolSize, symbols.length),
        interval: "1m",
        layoutColumns: 1,
        preset: session.request.preset,
        symbols,
        scanOnly: true,
        includePortfolioContext: false,
      });
      if (session.phase !== "selecting") return;
      const scanned = workspaceCandidates(scan);
      candidates = symbols.flatMap((symbol) => {
        const candidate = scanned.find((item) => item.symbol === symbol && item.exchange);
        return candidate ? [candidate] : [];
      });
      if (candidates.length === symbols.length
        && candidates.every(({ symbol }) => expected.has(symbol))) break;
      if (attempt >= this.selectionMaximumAttempts) {
        throw new Error(
          `페어 catalog 종목 또는 미국 거래소 metadata가 부족합니다: pair=${pair.pairId}, `
          + `required=${symbols.join(",")}, resolved=${candidates.map(({ symbol }) => symbol).join(",")}, `
          + `attempts=${attempts}`,
        );
      }
      this.warn(
        session,
        `페어 catalog 종목과 거래소 metadata를 제한 재조회합니다 (${attempt}/${this.selectionMaximumAttempts}).`,
      );
      await this.waitForSelectionRetry(session);
      if (session.phase !== "selecting") return;
    }
    session.metadata = new Map(candidates.map((candidate) => [candidate.symbol, candidate]));
    const exchanges = Object.fromEntries(candidates.map(({ symbol, exchange }) => (
      [symbol, exchange!] as const
    )));
    const release = await this.live.retain(symbols, "US", exchanges);
    if (session.phase !== "selecting") {
      release();
      return;
    }
    session.release = release;
    const retained = this.live.state?.symbols;
    if (retained && symbols.some((symbol) => !retained.some((item) => (
      item.marketCountry === "US" && item.symbol === symbol
    )))) {
      release();
      throw new Error("페어 기초자산과 실행 ETF의 실시간 구독을 모두 확보하지 못했습니다.");
    }
    await this.live.waitForIdle();
    if (session.phase !== "selecting") return;
    const workspace = await this.market.workspace({
      marketCountry: "US",
      criterion: selectionCriterion(session.request),
      topCount: Math.max(this.config.candidatePoolSize, symbols.length),
      interval: "1m",
      layoutColumns: 1,
      preset: session.request.preset,
      symbols,
      scanOnly: false,
      includePortfolioContext: false,
    });
    if (session.phase !== "selecting") return;
    session.charts = simulationChartsFromWorkspace(workspace, symbols);
    const missingCharts = symbols.filter((symbol) => !session.charts.some((chart) => (
      chart.symbol === symbol && chart.bars.length > 0
    )));
    if (missingCharts.length) {
      this.warn(session, `페어 차트 분봉 unavailable: ${missingCharts.join(", ")}`);
    }
    for (const chart of session.charts) {
      const latest = chart.bars.at(-1);
      if (latest) updateMark(session, chart.symbol, latest.close, latest.timestamp);
    }
    for (const instrument of workspace.workspace.instruments) {
      updatePairExecutionQuote(
        session,
        instrument.symbol,
        instrument.orderbook,
        workspace.workspace.generatedAt,
      );
    }
    const signal = session.decisionAbort.signal;
    const signalSymbols = [pair.signalSymbol];
    const maximumInputEndAt = latestFinalChartOrigin(session, pair.signalSymbol);
    // Forecast refreshes and persists the captured final bar. Run retained Rust
    // analysis afterward so both components consume that exact origin.
    const forecastResult = await this.market.forecast({
      marketCountry: "US",
      symbols: signalSymbols,
      interval: "1m",
    }, {
      signal,
      ...(maximumInputEndAt ? { maximumInputEndAt } : {}),
    });
    if (signal.aborted || session.phase !== "selecting") return;
    const technical = await this.market.realtimeAnalysis({
      marketCountry: "US",
      symbols: signalSymbols,
      interval: "1m",
      preset: session.request.preset,
      positionContext: pairSignalPositionContext(session),
    }, {
      signal,
      skipAutomaticRefresh: true,
      ...(maximumInputEndAt ? { maximumInputEndAt } : {}),
    });
    if (signal.aborted || session.phase !== "selecting") return;
    for (const chart of session.charts) mergeSimulationLatestTechnical(chart, technical);
    const displaySelection = selectAiForecastSeries(forecastResult.forecast, {
      symbolCount: 1,
      roundTripCostRate: roundTripCostRate(session.request.costs),
      riskPenalty: resolvePaperPolicyProfile(
        session.request.preset,
        session.request.riskTolerance,
      ).riskPenalty,
      notBeforeMs: this.now(),
    });
    if (displaySelection.status === "available"
      && displaySelection.selected.every(({ symbol }) => symbol === pair.signalSymbol)) {
      session.selection = displaySelection;
    }
    const startedAtMs = this.now();
    session.startedAt = new Date(startedAtMs).toISOString();
    session.expiresAt = new Date(
      startedAtMs + session.request.durationMinutes * MINUTE_MS,
    ).toISOString();
    const runningTransition = transitionSimulationPhase(session.phase, "selection_ready");
    if (!runningTransition.accepted) return;
    session.phase = runningTransition.phase;
    session.lastDecisionTriggeredAt = session.startedAt;
    session.lastDecisionStartedAt = session.startedAt;
    const states = technicalStates(technical, session.charts);
    const decisionRecord = this.recordPairDecision(
      session,
      forecastResult.forecast,
      states[pair.signalSymbol],
      maximumInputEndAt,
    );
    session.lastDecisionFinishedAt = decisionRecord.recordedAt;
    this.recordEquity(session, decisionRecord.recordedAt);
    await this.enqueuePersistence(session, async () => {
      await this.repository.addEvent(session.id, "simulation_ready", {
        strategy: "pair",
        pair_id: pair.pairId,
        signal_symbol: pair.signalSymbol,
        execution_symbols: executionSymbols(session),
        direction: session.pair?.lastDecision?.direction ?? "cash",
        model_ids: [
          session.pair?.lastModels?.chronos2.provenance.modelId,
          session.pair?.lastModels?.kronos.provenance.modelId,
        ].filter(Boolean),
        expires_at: session.expiresAt,
        real_order_api: false,
      }, startedAtMs);
      if (session.phase !== "running") return;
      await this.repository.updateProgress(session.id, {
        progress: 0,
        completedCandidates: 1,
        totalCandidates: 1,
        currentValidationWindow: session.startedAt,
      }, startedAtMs);
    });
    if (session.phase !== "running") return;
    await this.persistArtifacts(session);
    if (session.phase !== "running") return;
    const remainingMs = Math.max(0, Date.parse(session.expiresAt) - this.now());
    session.endTimer = setTimeout(() => {
      void this.finish(session, "completed", "설정한 페어 시뮬레이션 기간이 종료되었습니다.")
        .catch((error) => console.warn(
          "[simulation] 페어 기간 종료 처리 실패:",
          error instanceof Error ? error.message : error,
        ));
    }, remainingMs);
    session.endTimer.unref();
    session.progressTimer = setInterval(() => this.queueProgress(session), this.progressUpdateMs);
    session.progressTimer.unref();
  }

  private recordActions(
    session: ActiveSession,
    selection: AiPaperSelection,
    states: Readonly<Record<string, unknown>>,
  ): string {
    const recordedAt = new Date(this.now()).toISOString();
    let observedAt = recordedAt;
    const actions = decidePaperActions({
      selection,
      technicalStates: states,
      heldSymbols: Object.keys(session.ledger.positions),
      profile: resolvePaperPolicyProfile(
        session.request.preset,
        session.request.riskTolerance,
      ),
    });
    for (const action of actions) {
      const eligibleAfter = latestTimestamp([action.eligibleAfter, recordedAt]) ?? action.eligibleAfter;
      const executableAction = eligibleAfter === action.eligibleAfter
        ? action
        : { ...action, eligibleAfter };
      observedAt = latestTimestamp([observedAt, eligibleAfter]) ?? observedAt;
      const decision: SimulationDecision = {
        symbol: action.symbol,
        action: action.action,
        decidedAt: recordedAt,
        eligibleAfter,
        inputEndAt: action.inputEndAt,
        forecastGeneratedAt: action.forecastGeneratedAt,
        ...(action.technicalObservedAt ? { technicalObservedAt: action.technicalObservedAt } : {}),
        reason: action.reasons.join(","),
        reasons: action.reasons,
        score: action.score,
        upProbability: action.upProbability,
        predictedMedianReturn: action.medianReturn,
        q10Return: action.q10Return,
        q90Return: action.q90Return,
        technicalState: action.technicalState,
        chartPatternBias: action.chartPatternBias,
        chartPatterns: action.chartPatterns,
        model: action.model,
      };
      session.decisions.push(decision);
      if (session.decisions.length > MAX_DECISIONS) session.decisions.shift();
      if ((action.action === "buy" || action.action === "sell")
        && insideSessionBoundary(session, eligibleAfter)
        && eligibleAfter !== session.expiresAt) {
        const existing = session.pending.get(action.symbol);
        // A repeated decision must not postpone an already-valid virtual action.
        // Keeping the earlier eligibility preserves the next-observed-fill rule.
        if (!existing || existing.action !== executableAction.action) {
          session.pending.set(action.symbol, executableAction);
        }
      } else {
        session.pending.delete(action.symbol);
      }
    }
    return observedAt;
  }

  private expirePairPendingEntry(
    session: ActiveSession,
    observedAtInput: string,
    options: {
      processedAt?: string;
      force?: boolean;
    } = {},
  ): PairEntryExpiration | undefined {
    if (!session.pair?.runtimeState.pending
      || session.pair.runtimeState.pending.kind !== "enter") return undefined;
    const action = session.pending.get(
      session.pair.runtimeState.pending.executionSymbol,
    );
    if (!action) {
      throw new PairStateLedgerInvariantError(
        "runtime pending entry has no executable pending action",
      );
    }
    if (!action.validUntil && !options.force) {
      throw new PairStateLedgerInvariantError("pending entry has no forecast horizon");
    }
    const observedAt = timestamp(observedAtInput);
    const processedAt = timestamp(options.processedAt)
      ?? new Date(this.now()).toISOString();
    if (!observedAt) {
      throw new PairStateLedgerInvariantError("pending expiration observation time is invalid");
    }
    const expirationBoundary = Math.max(
      Date.parse(observedAt),
      Date.parse(processedAt),
    );
    if (!options.force && action.validUntil
      && expirationBoundary < Date.parse(action.validUntil)) {
      return undefined;
    }
    const transition = transitionPairState(
      session.pair.runtimeState,
      { type: "cancel_pending", at: processedAt },
      DEFAULT_PAIR_CATALOG,
    );
    if (transition.status !== "applied") {
      throw new PairStateLedgerInvariantError(
        `expired entry could not be cancelled: ${transition.reasonCodes.join(",")}`,
      );
    }
    session.pair.runtimeState = transition.state;
    session.pair.direction = transition.state.direction;
    session.pair.cooldownUntil = transition.state.cooldownUntil;
    session.pending.delete(action.symbol);
    const reason = options.force
      ? "session_finalized_before_execution" as const
      : "forecast_horizon_elapsed" as const;
    this.updatePairSizingProvenance(session, action.pairDecisionId, {
      status: reason,
      validUntil: action.validUntil,
      observedAt,
      processedAt,
    });
    this.warn(
      session,
      options.force
        ? "세션 종료로 미체결 페어 진입을 cash로 취소했습니다."
        : `페어 진입 신호가 예측 horizon(${action.validUntil})을 지나 만료되었습니다.`,
    );
    assertPairStateLedgerInvariant(session);
    return {
      action,
      observedAt,
      processedAt,
      reason,
    };
  }

  private async addPairEntryExpirationEvent(
    session: ActiveSession,
    expiration: PairEntryExpiration,
  ): Promise<void> {
    await this.repository.addEvent(session.id, "simulation_pair_entry_expired", {
      pair_id: session.pair?.catalog.pairId,
      symbol: expiration.action.symbol,
      eligible_after: expiration.action.eligibleAfter,
      valid_until: expiration.action.validUntil,
      observed_at: expiration.observedAt,
      processed_at: expiration.processedAt,
      reason: expiration.reason,
      pair_decision_id: expiration.action.pairDecisionId,
      real_order_api: false,
    });
  }

  private queuePairComparison(
    session: ActiveSession,
    models: NormalizedPairModelSet,
    rust: PairRustTechnicalInput,
    decision: PairEnsembleDecision,
  ): void {
    if (!session.pair || !decision.origin) return;
    const targetTimestamp = pairCommonTargetTimestamp(models);
    if (!targetTimestamp
      || Date.parse(targetTimestamp) <= Date.parse(decision.eligibleAfter)) {
      this.warn(session, "동일 조건 성과 비교 target을 확정할 수 없어 해당 origin을 미완료로 남겼습니다.");
      return;
    }
    if (!isNonOverlappingPairComparisonOrigin(
      [...session.pair.comparisonPending, ...session.pair.comparisonObservations],
      decision.origin,
    )) {
      // Forecast horizons overlap at the one-minute decision cadence. Sampling
      // only non-overlapping origins prevents duplicated PnL, costs, and risk.
      return;
    }
    const observationId = `${session.pair.catalog.pairId}:${decision.origin}`;
    if (session.pair.comparisonPending.some((item) => item.observationId === observationId)
      || session.pair.comparisonObservations.some((item) => item.observationId === observationId)) {
      return;
    }
    session.pair.comparisonPending.push({
      observationId,
      origin: decision.origin,
      eligibleAfter: decision.eligibleAfter,
      targetTimestamp,
      lanes: {
        chronos2: pairModelComparisonLane(
          session.pair.catalog,
          models.chronos2,
          decision.componentScores.chronos2,
        ),
        kronos: pairModelComparisonLane(
          session.pair.catalog,
          models.kronos,
          decision.componentScores.kronos,
        ),
        rust: pairRustComparisonLane(
          session.pair.catalog,
          rust,
          decision.componentScores.rust,
          decision.origin,
        ),
        ensemble: pairEnsembleComparisonLane(session.pair.catalog, decision),
      },
    });
    session.pair.strategyComparison = buildPairStrategyComparison(session);
  }

  private refreshPairComparison(
    session: ActiveSession,
    forceSkipIncomplete = false,
  ): void {
    if (!session.pair || !session.pair.comparisonPending.length) {
      if (session.pair) session.pair.strategyComparison = buildPairStrategyComparison(session);
      return;
    }
    const remaining: PairPendingComparison[] = [];
    const processedAt = new Date(this.now()).toISOString();
    for (const pending of session.pair.comparisonPending) {
      const signalAtOrBeforeOrigin = observedMarkAt(
        session,
        session.pair.catalog.signalSymbol,
        pending.origin,
      );
      const signalAtOrigin = signalAtOrBeforeOrigin
        && Date.parse(signalAtOrBeforeOrigin.observedAt) === Date.parse(pending.origin)
        ? signalAtOrBeforeOrigin
        : undefined;
      const signalAtTarget = firstObservedMarkAtOrAfter(
        session,
        session.pair.catalog.signalSymbol,
        pending.targetTimestamp,
      );
      const bullSymbol = session.pair.catalog.bull.executionSymbol;
      const bearSymbol = session.pair.catalog.bear.executionSymbol;
      const bullEntry = firstObservedMarkAfter(session, bullSymbol, pending.eligibleAfter);
      const bearEntry = firstObservedMarkAfter(session, bearSymbol, pending.eligibleAfter);
      const bullExit = firstObservedMarkAtOrAfter(session, bullSymbol, pending.targetTimestamp);
      const bearExit = firstObservedMarkAtOrAfter(session, bearSymbol, pending.targetTimestamp);
      const complete = signalAtOrigin && signalAtTarget
        && bullEntry && bearEntry && bullExit && bearExit
        && Date.parse(bullEntry.observedAt) < Date.parse(pending.targetTimestamp)
        && Date.parse(bearEntry.observedAt) < Date.parse(pending.targetTimestamp)
        && Date.parse(bullExit.observedAt) > Date.parse(bullEntry.observedAt)
        && Date.parse(bearExit.observedAt) > Date.parse(bearEntry.observedAt);
      if (!complete) {
        const graceElapsed = Date.parse(processedAt)
          >= Date.parse(pending.targetTimestamp) + PAIR_COMPARISON_SETTLEMENT_GRACE_MS;
        if (!forceSkipIncomplete && !graceElapsed) {
          remaining.push(pending);
          continue;
        }
        const reasonCodes = uniqueWarnings([
          ...(!signalAtOrigin ? ["signal_origin_mark_not_exact"] : []),
          ...(!signalAtTarget ? ["signal_target_mark_unavailable"] : []),
          ...(!bullEntry || (bullEntry
            && Date.parse(bullEntry.observedAt) >= Date.parse(pending.targetTimestamp))
            ? ["bull_entry_price_unavailable"] : []),
          ...(!bearEntry || (bearEntry
            && Date.parse(bearEntry.observedAt) >= Date.parse(pending.targetTimestamp))
            ? ["bear_entry_price_unavailable"] : []),
          ...(!bullExit || (bullEntry
            && bullExit
            && Date.parse(bullExit.observedAt) <= Date.parse(bullEntry.observedAt))
            ? ["bull_exit_price_unavailable"] : []),
          ...(!bearExit || (bearEntry
            && bearExit
            && Date.parse(bearExit.observedAt) <= Date.parse(bearEntry.observedAt))
            ? ["bear_exit_price_unavailable"] : []),
          ...(forceSkipIncomplete && !graceElapsed
            ? ["session_finalized_before_comparison_settlement"] : []),
        ]);
        if (!session.pair.comparisonSkipped.some(
          ({ observationId }) => observationId === pending.observationId,
        )) {
          session.pair.comparisonSkipped.push({
            observationId: pending.observationId,
            origin: pending.origin,
            targetTimestamp: pending.targetTimestamp,
            skippedAt: processedAt,
            reasonCodes,
          });
          if (session.pair.comparisonSkipped.length > MAX_DECISIONS) {
            session.pair.comparisonSkipped.shift();
          }
        }
        this.warn(
          session,
          `페어 비교 origin을 실행 가격 unavailable로 건너뛰었습니다: `
          + `${pending.origin} (${reasonCodes.join(",")})`,
        );
        continue;
      }
      const signalReturn = signalAtTarget.price / signalAtOrigin.price - 1;
      const baseCostRate = (
        session.request.costs.commissionBpsPerSide * 2
        + session.request.costs.taxBpsOnExit
        + session.request.costs.spreadBpsRoundTrip
        + session.request.costs.slippageBpsPerSide * 2
      ) / 10_000;
      const leverage = Math.max(
        Math.abs(session.pair.catalog.bull.leverageMultiplier),
        Math.abs(session.pair.catalog.bear.leverageMultiplier),
      );
      const neutralThreshold = baseCostRate / leverage;
      const actualDirection: PairDirection = signalReturn > neutralThreshold
        ? "bull"
        : signalReturn < -neutralThreshold ? "bear" : "cash";
      const actualExecutionSymbol = mapPairDirection(
        session.pair.catalog,
        actualDirection,
      ).executionSymbol;
      session.pair.comparisonObservations.push({
        observationId: pending.observationId,
        origin: pending.origin,
        eligibleAfter: pending.eligibleAfter,
        targetTimestamp: pending.targetTimestamp,
        actualDirection,
        ...(actualExecutionSymbol ? { actualExecutionSymbol } : {}),
        executableOutcomes: {
          bull: {
            executionSymbol: bullSymbol,
            grossReturn: bullExit.price / bullEntry.price - 1,
          },
          bear: {
            executionSymbol: bearSymbol,
            grossReturn: bearExit.price / bearEntry.price - 1,
          },
        },
        lanes: pending.lanes,
      });
    }
    session.pair.comparisonPending = remaining;
    session.pair.comparisonObservations.sort(
      (left, right) => Date.parse(left.origin) - Date.parse(right.origin),
    );
    if (session.pair.comparisonObservations.length > MAX_REPORT_DECISIONS) {
      session.pair.comparisonObservations.splice(
        0,
        session.pair.comparisonObservations.length - MAX_REPORT_DECISIONS,
      );
    }
    session.pair.strategyComparison = buildPairStrategyComparison(session);
  }

  private updatePairSizingProvenance(
    session: ActiveSession,
    pairDecisionId: string | undefined,
    sizing: unknown,
  ): void {
    if (!session.pair || !pairDecisionId) return;
    const index = session.pair.provenanceRecords.findIndex(
      ({ decisionId }) => decisionId === pairDecisionId,
    );
    const previous = session.pair.provenanceRecords[index];
    if (!previous) return;
    const updated = createPairDecisionProvenance({
      ensembleInput: previous.replayInput,
      decision: previous.decision,
      sizing,
    });
    const verified = verifyPairDecisionReplay(updated);
    if (!verified.valid) {
      this.warn(session, `페어 sizing provenance 검증 실패: ${verified.reasonCodes.join(",")}`);
      return;
    }
    session.pair.provenanceRecords[index] = updated;
  }

  private recordPairDecision(
    session: ActiveSession,
    forecast: unknown,
    technicalValue: unknown,
    expectedOrigin?: string,
  ): {
    recordedAt: string;
  } {
    if (!session.pair) throw new Error("페어 세션 정보가 없습니다.");
    const decisionAt = new Date(this.now()).toISOString();
    assertPairStateLedgerInvariant(session);
    const expiration = this.expirePairPendingEntry(session, decisionAt, {
      processedAt: decisionAt,
    });
    if (expiration) {
      void this.enqueuePersistence(
        session,
        () => this.addPairEntryExpirationEvent(session, expiration),
      ).catch((persistenceError) => {
        this.warn(
          session,
          `만료 이벤트 저장 실패: ${
            persistenceError instanceof Error ? persistenceError.message : "unknown"
          }`,
        );
      });
    }
    const rust = pairRustTechnicalInput(technicalValue);
    const allowDegradedMode = session.request.strategy?.mode === "pair"
      && session.request.strategy.allowDegradedMode;
    const models = normalizePairModelOutputs(forecast, {
      signalSymbol: session.pair.catalog.signalSymbol,
      ...(expectedOrigin ? { expectedOrigin } : {}),
      now: decisionAt,
      maximumOriginAgeMs: 180_000,
      requireCuda: true,
      requiredDeviceName: "Tesla P40",
      allowChronosFallback: allowDegradedMode,
    });
    const profile = {
      ...DEFAULT_PAIR_ENSEMBLE_POLICY_PROFILE,
      weights: { ...DEFAULT_PAIR_ENSEMBLE_POLICY_PROFILE.weights },
      modelScoreWeights: { ...DEFAULT_PAIR_ENSEMBLE_POLICY_PROFILE.modelScoreWeights },
      allowDegradedMode,
    };
    const ensembleInput: PairEnsembleInput = {
      pair: session.pair.catalog,
      models,
      rust,
      currentDirection: session.pair.direction,
      decisionAt,
      riskTolerance: session.request.riskTolerance,
      costs: {
        commissionBpsPerSide: session.request.costs.commissionBpsPerSide,
        taxBpsOnExit: session.request.costs.taxBpsOnExit,
        spreadBpsRoundTrip: session.request.costs.spreadBpsRoundTrip,
        slippageBpsPerSide: session.request.costs.slippageBpsPerSide,
        switchCostBps: Math.max(5, session.request.costs.spreadBpsRoundTrip),
      },
      market: pairExecutionMarketInput(session, decisionAt),
      ...(session.pair.cooldownUntil ? { cooldownUntil: session.pair.cooldownUntil } : {}),
      profile,
    };
    const decision = evaluatePairEnsemble(ensembleInput);
    const rollback = {
      runtimeState: session.pair.runtimeState,
      direction: session.pair.direction,
      cooldownUntil: session.pair.cooldownUntil,
      lastModels: session.pair.lastModels,
      lastDecision: session.pair.lastDecision,
      strategyComparison: session.pair.strategyComparison,
      comparisonPending: [...session.pair.comparisonPending],
      comparisonObservations: [...session.pair.comparisonObservations],
      comparisonSkipped: [...session.pair.comparisonSkipped],
      provenanceRecords: [...session.pair.provenanceRecords],
      pending: new Map(session.pending),
      decisions: [...session.decisions],
      warnings: [...session.warnings],
    };
    try {
      session.pair.lastModels = models;
      session.pair.lastDecision = decision;
    const stateTransition = transitionPairState(
      session.pair.runtimeState,
      {
        type: "decision",
        targetDirection: decision.direction,
        decidedAt: decisionAt,
        eligibleAfter: decision.eligibleAfter,
        ...(decision.origin ? { origin: decision.origin } : {}),
      },
      DEFAULT_PAIR_CATALOG,
    );
    session.pair.runtimeState = stateTransition.state;
    session.pair.direction = stateTransition.state.direction;
    session.pair.cooldownUntil = stateTransition.state.cooldownUntil;
    const command = stateTransition.commands[0];
    const actionKind: PaperPolicyAction["action"] = command
      ? command.side
      : decision.direction === session.pair.direction && decision.direction !== "cash"
        ? "hold"
        : "watch";
    const actionSymbol = command?.executionSymbol
      ?? decision.executionSymbol
      ?? session.pair.catalog.signalSymbol;
    const decisionReasons = uniqueWarnings([
      ...decision.reasonCodes,
      ...stateTransition.reasonCodes,
    ]);
    const forecastGeneratedAt = latestTimestamp([
      models.chronos2.generatedAt,
      models.kronos.generatedAt,
      decisionAt,
    ]) ?? decisionAt;
    const model = pairActionModel(models);
    const predictedVolatility = Math.max(
      0,
      ...[models.chronos2, models.kronos]
        .filter((output) => output.status !== "unavailable")
        .map((output) => (
        output.expectedVolatility ?? (output.uncertaintyWidth ?? 0) / 2
      )),
    );
    const commonTargetTimestamp = pairCommonTargetTimestamp(models);
    const baseAction: SimulationPendingAction = {
      policyVersion: AI_PAPER_POLICY_VERSION,
      symbol: actionSymbol,
      action: actionKind,
      eligibleAfter: decision.eligibleAfter,
      inputEndAt: decision.origin ?? decisionAt,
      forecastGeneratedAt,
      score: Math.max(decision.finalScores.bull, decision.finalScores.bear),
      medianReturn: pairModelAverage(models, "medianReturn"),
      q10Return: pairModelAverage(models, "q10Return"),
      q90Return: pairModelAverage(models, "q90Return"),
      upProbability: pairModelAverage(models, "upProbability"),
      technicalState: rust.status,
      ...(rust.observedAt ? { technicalObservedAt: rust.observedAt } : {}),
      chartPatternBias: rust.chartPatternBias ?? null,
      chartPatterns: [...(rust.chartPatterns ?? [])],
      reasons: decisionReasons,
      model,
      ...(command?.side === "buy" && commonTargetTimestamp
        ? { validUntil: commonTargetTimestamp } : {}),
      pairSizing: {
        leverageMultiplier: decision.leverageMultiplier,
        predictedVolatility,
        ensembleExposureScale: decision.exposureScale,
        maximumUnderlyingExposureRate: resolvePaperPolicyProfile(
          session.request.preset,
          session.request.riskTolerance,
        ).targetAllocationRate,
        targetVolatility: 0.02,
      },
      effectiveSpreadBpsRoundTrip: Math.max(
        session.request.costs.spreadBpsRoundTrip,
        session.pair.quotes[actionSymbol]?.spreadBps ?? 0,
      ),
      switchCostBps: decision.decisionKind === "switch"
        ? Math.max(5, session.request.costs.spreadBpsRoundTrip)
        : 0,
    };
    const provenanceRecord = createPairDecisionProvenance({
      ensembleInput,
      decision,
      sizing: {
        status: "pending_execution_price",
        inputs: baseAction.pairSizing,
      },
    });
    const replayVerification = verifyPairDecisionReplay(provenanceRecord);
    if (!replayVerification.valid) {
      throw new Error(
        `페어 판단 provenance를 재현하지 못했습니다: ${replayVerification.reasonCodes.join(",")}`,
      );
    }
    baseAction.pairDecisionId = provenanceRecord.decisionId;
    session.pair.provenanceRecords.push(provenanceRecord);
    if (session.pair.provenanceRecords.length > MAX_REPORT_DECISIONS) {
      session.pair.provenanceRecords.shift();
    }
    const components = {
      chronos2Bull: decision.componentScores.chronos2.bull,
      chronos2Bear: decision.componentScores.chronos2.bear,
      kronosBull: decision.componentScores.kronos.bull,
      kronosBear: decision.componentScores.kronos.bear,
      rustBull: decision.componentScores.rust.bull,
      rustBear: decision.componentScores.rust.bear,
    };
    const simulationDecision: SimulationDecision = {
      symbol: actionSymbol,
      action: actionKind,
      decidedAt: decisionAt,
      eligibleAfter: decision.eligibleAfter,
      inputEndAt: decision.origin ?? decisionAt,
      forecastGeneratedAt,
      ...(rust.observedAt ? { technicalObservedAt: rust.observedAt } : {}),
      reason: decisionReasons.join(","),
      reasons: decisionReasons,
      score: baseAction.score,
      upProbability: baseAction.upProbability,
      predictedMedianReturn: baseAction.medianReturn,
      q10Return: baseAction.q10Return,
      q90Return: baseAction.q90Return,
      technicalState: rust.status,
      chartPatternBias: rust.chartPatternBias ?? null,
      chartPatterns: [...(rust.chartPatterns ?? [])],
      model,
      signalSymbol: session.pair.catalog.signalSymbol,
      executionSymbol: decision.executionSymbol,
      direction: decision.direction,
      decisionKind: decision.decisionKind,
      degraded: decision.degraded,
      exposureScale: decision.exposureScale,
      weights: { ...decision.weights },
      components,
      finalScores: { ...decision.finalScores },
      provenance: pairProvenanceStrings(models),
      ensemble: decision,
      modelOutputs: models,
      rustSignal: rust,
      pairDecisionId: baseAction.pairDecisionId,
    };
    session.decisions.push(simulationDecision);
    if (session.decisions.length > MAX_DECISIONS) session.decisions.shift();
    this.queuePairComparison(session, models, rust, decision);
    this.refreshPairComparison(session);
    if (stateTransition.status === "applied") {
      for (const symbol of executionSymbols(session)) session.pending.delete(symbol);
    }
    if (command
      && insideSessionBoundary(session, command.eligibleAfter)
      && command.eligibleAfter !== session.expiresAt) {
      const executable = {
        ...baseAction,
        action: command.side,
        symbol: command.executionSymbol,
        eligibleAfter: command.eligibleAfter,
      };
      session.pending.set(command.executionSymbol, executable);
    }
      assertPairStateLedgerInvariant(session);
      return {
        recordedAt: decision.eligibleAfter,
      };
    } catch (error) {
      session.pair.runtimeState = rollback.runtimeState;
      session.pair.direction = rollback.direction;
      session.pair.cooldownUntil = rollback.cooldownUntil;
      session.pair.lastModels = rollback.lastModels;
      session.pair.lastDecision = rollback.lastDecision;
      session.pair.strategyComparison = rollback.strategyComparison;
      session.pair.comparisonPending = rollback.comparisonPending;
      session.pair.comparisonObservations = rollback.comparisonObservations;
      session.pair.comparisonSkipped = rollback.comparisonSkipped;
      session.pair.provenanceRecords = rollback.provenanceRecords;
      session.pending = rollback.pending;
      session.decisions = rollback.decisions;
      session.warnings = rollback.warnings;
      assertPairStateLedgerInvariant(session);
      throw error;
    }
  }

  private waitForSelectionRetry(session: ActiveSession): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (session.selectionRetryTimer === timer) {
          session.selectionRetryTimer = undefined;
          session.selectionRetryResolve = undefined;
        }
        resolve();
      };
      timer = setTimeout(finish, this.selectionRetryDelayMs);
      timer.unref();
      session.selectionRetryTimer = timer;
      session.selectionRetryResolve = finish;
    });
  }

  private async handleLiveEvent(event: ScalpingLiveEvent): Promise<void> {
    if (!event.symbol || !event.marketCountry) return;
    const sessions = [...this.active.values()].filter((session) => (
      session.phase === "running"
      && session.request.marketCountry === event.marketCountry
      && retainedSymbols(session).includes(event.symbol!)
    ));
    if (!sessions.length) return;
    const payload = record(event.payload);
    if (!payload) return;
    for (const session of sessions) {
      if (event.type === "diagnostic"
        && payload.status === "source_unavailable"
        && ["subscription-unavailable", "subscription-rejected"].includes(String(payload.code))) {
        await this.fail(
          session,
          new Error(`선정 종목 ${event.symbol}의 실시간 체결 구독이 중단되었습니다.`),
        );
      } else if (event.type === "orderbook" && session.pair) {
        updatePairExecutionQuote(session, event.symbol, payload, event.emittedAt);
      } else if (event.type === "trade") {
        const executedAt = timestamp(payload.executedAt);
        const price = finite(payload.price);
        if (!executedAt || price === undefined || price <= 0) continue;
        if (!insideSessionBoundary(session, executedAt)) continue;
        if (updateMark(session, event.symbol, price, executedAt)) {
          if (session.pair) this.refreshPairComparison(session);
          await this.tryFill(
            session,
            event.symbol,
            executedAt,
            price,
            "kis_ws_trade",
            event.emittedAt,
          );
        }
      } else if (event.type === "bar"
        && payload.intervalMinutes === 1
        && payload.state === "forming") {
        const chart = session.charts.find((item) => item.symbol === event.symbol);
        if (chart) mergeSimulationFormingBar(chart, payload, event.emittedAt);
      } else if (event.type === "bar"
        && payload.intervalMinutes === 1
        && payload.state === "final") {
        const chart = session.charts.find((item) => item.symbol === event.symbol);
        const chartChanged = chart
          ? mergeSimulationFinalBar(chart, payload, event.emittedAt)
          : false;
        const closeTime = timestamp(payload.closeTime);
        const openTime = timestamp(payload.openTime);
        const open = finite(payload.open);
        const close = finite(payload.close);
        if (openTime && insideSessionBoundary(session, openTime)
          && open !== undefined && open > 0) {
          if (updateMark(session, event.symbol, open, openTime)) {
            if (session.pair) this.refreshPairComparison(session);
            await this.tryFill(
              session,
              event.symbol,
              openTime,
              open,
              "next_final_bar_open",
              event.emittedAt,
            );
          }
        }
        if (closeTime && insideSessionBoundary(session, closeTime)
          && close !== undefined && close > 0) {
          if (updateMark(session, event.symbol, close, closeTime) && session.pair) {
            this.refreshPairComparison(session);
          }
        }
        if (chartChanged
          && session.phase === "running"
          && (!session.pair || event.symbol === session.pair.catalog.signalSymbol)) {
          this.queueAnalysis(session, this.now());
        } else if (chart && !chartChanged) {
          session.decisionDuplicateEvents += 1;
        }
      }
    }
  }

  private queueAnalysis(session: ActiveSession, triggeredAtMs: number): void {
    const tick = reduceDecisionQueueTick({
      analysisRunning: session.analysisRunning,
      analysisQueued: session.analysisQueued,
    });
    session.decisionTriggeredEvents += tick.scheduledTickDelta;
    session.decisionCoalescedEvents += tick.coalescedTickDelta + tick.skippedTickDelta;
    session.lastDecisionTriggeredAt = new Date(triggeredAtMs).toISOString();
    session.analysisQueued = tick.analysisQueued;
    session.analysisRunning = tick.analysisRunning;
    if (!tick.shouldStartRunner) return;
    void (async () => {
      try {
        while (session.analysisQueued && session.phase === "running") {
          session.analysisQueued = false;
          session.lastDecisionStartedAt = new Date(this.now()).toISOString();
          try {
            await this.refreshDecision(session);
          } catch (error) {
            if (session.phase !== "running" || session.decisionAbort.signal.aborted) return;
            if (error instanceof PairStateLedgerInvariantError) {
              await this.fail(session, error);
              return;
            }
            this.warn(session, `판단 갱신 실패: ${error instanceof Error ? error.message : "unknown"}`);
          } finally {
            session.lastDecisionFinishedAt = new Date(this.now()).toISOString();
          }
        }
      } finally {
        session.analysisRunning = false;
      }
    })().catch((error) => {
      if (session.phase === "running" && !session.decisionAbort.signal.aborted) {
        this.warn(session, `판단 queue 실패: ${error instanceof Error ? error.message : "unknown"}`);
      }
    });
  }

  private async refreshDecision(session: ActiveSession): Promise<void> {
    if (session.pair) {
      await this.refreshPairDecision(session);
      return;
    }
    const symbols = selectedSymbols(session);
    if (!symbols.length) return;
    const signal = session.decisionAbort.signal;
    if (signal.aborted) return;
    const ledgerRevision = session.ledgerRevision;
    const positionContext = isolatedPositionContext(session);
    await this.live.waitForIdle();
    if (signal.aborted || session.phase !== "running") return;
    const [forecastResult, technical] = await Promise.all([
      this.market.forecast({
        marketCountry: session.request.marketCountry,
        symbols,
        interval: "1m",
      }, {
        signal,
      }),
      this.market.realtimeAnalysis({
        marketCountry: session.request.marketCountry,
        symbols,
        interval: "1m",
        preset: session.request.preset,
        positionContext,
      }, {
        signal,
        skipAutomaticRefresh: true,
      }),
    ]);
    if (signal.aborted || session.phase !== "running") return;
    if (session.expiresAt && this.now() >= Date.parse(session.expiresAt)) return;
    if (session.ledgerRevision !== ledgerRevision) {
      session.analysisQueued = true;
      return;
    }
    for (const chart of session.charts) {
      mergeSimulationLatestTechnical(chart, technical);
    }
    const profile = resolvePaperPolicyProfile(
      session.request.preset,
      session.request.riskTolerance,
    );
    const selection = selectAiForecastSeries(forecastResult.forecast, {
      symbolCount: selectionSymbolCount(session.request),
      roundTripCostRate: roundTripCostRate(session.request.costs),
      riskPenalty: profile.riskPenalty,
      notBeforeMs: this.now(),
    });
    if (selection.status !== "available") {
      this.warn(session, `AI 판단 unavailable: ${selection.reason ?? "unknown"}`);
      return;
    }
    const allowed = new Set(symbols);
    if (selection.selected.some(({ symbol }) => !allowed.has(symbol))) {
      this.warn(session, "AI 판단 결과가 고정된 선정 종목 집합을 벗어나 무시했습니다.");
      return;
    }
    session.selection = selection;
    const decisionRecordedAt = this.recordActions(
      session,
      selection,
      technicalStates(technical, session.charts),
    );
    this.recordEquity(session, decisionRecordedAt);
    const checkpoint = this.now() - (session.lastArtifactPersistedAtMs ?? Number.NEGATIVE_INFINITY)
      >= DECISION_ARTIFACT_CHECKPOINT_MS;
    await this.enqueuePersistence(session, async () => {
      await this.repository.addEvent(session.id, "simulation_decision", {
        generated_at: selection.generatedAt,
        symbols,
        pending_actions: [...session.pending.values()].map(({ symbol, action, eligibleAfter }) => ({
          symbol, action, eligible_after: eligibleAfter,
        })),
      });
      if (checkpoint) await this.writeArtifacts(session);
    });
    if (checkpoint) session.lastArtifactPersistedAtMs = this.now();
  }

  private async refreshPairDecision(session: ActiveSession): Promise<void> {
    if (!session.pair) return;
    const signal = session.decisionAbort.signal;
    if (signal.aborted) return;
    const ledgerRevision = session.ledgerRevision;
    const signalSymbol = session.pair.catalog.signalSymbol;
    await this.live.waitForIdle();
    if (signal.aborted || session.phase !== "running") return;
    const maximumInputEndAt = latestFinalChartOrigin(session, signalSymbol);
    // Keep this sequential: the forecast refresh makes the captured bar
    // available to retained Rust analysis, while the cutoff prevents drift.
    const forecastResult = await this.market.forecast({
      marketCountry: "US",
      symbols: [signalSymbol],
      interval: "1m",
    }, {
      signal,
      ...(maximumInputEndAt ? { maximumInputEndAt } : {}),
    });
    if (signal.aborted || session.phase !== "running") return;
    const technical = await this.market.realtimeAnalysis({
      marketCountry: "US",
      symbols: [signalSymbol],
      interval: "1m",
      preset: session.request.preset,
      // Execution ETF holdings are represented as one isolated synthetic
      // underlying position instead of being mislabeled as the signal symbol.
      positionContext: pairSignalPositionContext(session),
    }, {
      signal,
      skipAutomaticRefresh: true,
      ...(maximumInputEndAt ? { maximumInputEndAt } : {}),
    });
    if (signal.aborted || session.phase !== "running") return;
    if (session.expiresAt && this.now() >= Date.parse(session.expiresAt)) return;
    if (session.ledgerRevision !== ledgerRevision) {
      session.analysisQueued = true;
      return;
    }
    for (const chart of session.charts) mergeSimulationLatestTechnical(chart, technical);
    const states = technicalStates(technical, session.charts);
    const decisionRecord = this.recordPairDecision(
      session,
      forecastResult.forecast,
      states[signalSymbol],
      maximumInputEndAt,
    );
    const displaySelection = selectAiForecastSeries(forecastResult.forecast, {
      symbolCount: 1,
      roundTripCostRate: roundTripCostRate(session.request.costs),
      riskPenalty: resolvePaperPolicyProfile(
        session.request.preset,
        session.request.riskTolerance,
      ).riskPenalty,
      notBeforeMs: this.now(),
    });
    if (displaySelection.status === "available"
      && displaySelection.selected.every(({ symbol }) => symbol === signalSymbol)) {
      session.selection = displaySelection;
    }
    this.recordEquity(session, decisionRecord.recordedAt);
    const checkpoint = this.now() - (session.lastArtifactPersistedAtMs ?? Number.NEGATIVE_INFINITY)
      >= DECISION_ARTIFACT_CHECKPOINT_MS;
    await this.enqueuePersistence(session, async () => {
      await this.repository.addEvent(session.id, "simulation_decision", {
        strategy: "pair",
        pair_id: session.pair?.catalog.pairId,
        origin: session.pair?.lastDecision?.origin,
        direction: session.pair?.lastDecision?.direction ?? "cash",
        degraded: session.pair?.lastDecision?.degraded ?? false,
        pending_actions: [...session.pending.values()].map(({ symbol, action, eligibleAfter }) => ({
          symbol, action, eligible_after: eligibleAfter,
        })),
        real_order_api: false,
      });
      if (checkpoint) await this.writeArtifacts(session);
    });
    if (checkpoint) session.lastArtifactPersistedAtMs = this.now();
  }

  private async tryFill(
    session: ActiveSession,
    symbol: string,
    executedAt: string,
    price: number,
    source: SimulationTrade["source"],
    receivedAt?: string,
  ): Promise<void> {
    if (session.phase !== "running") return;
    const processedAt = latestTimestamp([
      executedAt,
      receivedAt,
      new Date(this.now()).toISOString(),
    ]) ?? new Date(this.now()).toISOString();
    if (session.pair) {
      try {
        assertPairStateLedgerInvariant(session);
        const expired = this.expirePairPendingEntry(session, executedAt, {
          processedAt,
        });
        if (expired) {
          await this.enqueuePersistence(session, async () => {
            await this.addPairEntryExpirationEvent(session, expired);
            await this.writeArtifacts(session);
          });
          return;
        }
      } catch (error) {
        await this.fail(session, error);
        return;
      }
    }
    const action = session.pending.get(symbol);
    if (!action) return;
    if (!insideSessionBoundary(session, executedAt)) return;
    if (Date.parse(executedAt) <= Date.parse(action.eligibleAfter)) return;
    if (session.pair) {
      const executionSession = pairSessionAt(executedAt);
      if (!executionSession || !session.pair.catalog.allowedSessions.includes(executionSession)) {
        this.warn(session, "페어 실행 상품 체결이 허용 세션 밖이라 무시했습니다.");
        return;
      }
    }
    const latestTrade = session.trades.at(-1);
    if (latestTrade && Date.parse(executedAt) < Date.parse(latestTrade.executedAt)) {
      this.warn(session, "가상 원장보다 과거에 도착한 체결 이벤트를 무시했습니다.");
      return;
    }
    let pairEntrySignalMark: ObservedMark | undefined;
    if (session.pair) {
      const quotes = executionSymbols(session).map((executionSymbol) => ({
        executionSymbol,
        quote: session.pair!.quotes[executionSymbol],
      }));
      const invalidQuote = quotes.find(({ quote }) => {
        const quoteAge = quote
          ? Date.parse(processedAt) - Date.parse(quote.observedAt)
          : Number.POSITIVE_INFINITY;
        return !quote || quoteAge < 0
          || quoteAge > DEFAULT_PAIR_ENSEMBLE_POLICY_PROFILE.quoteMaximumAgeMs
          || quote.spreadBps > session.pair!.catalog.maxSpreadBps;
      });
      if (invalidQuote) {
        this.warn(
          session,
          `체결 시점의 bull/bear 호가가 없거나 stale/wide라 가상 체결을 보류했습니다: `
          + invalidQuote.executionSymbol,
        );
        return;
      }
      const quote = session.pair.quotes[symbol]!;
      action.effectiveSpreadBpsRoundTrip = Math.max(
        session.request.costs.spreadBpsRoundTrip,
        quote.spreadBps,
      );
      if (action.action === "buy") {
        pairEntrySignalMark = observedMarkAt(
          session,
          session.pair.catalog.signalSymbol,
          executedAt,
        );
        if (!pairEntrySignalMark
          || Date.parse(pairEntrySignalMark.observedAt) < Date.parse(action.inputEndAt)
          || Date.parse(pairEntrySignalMark.observedAt) > Date.parse(executedAt)) {
          await this.fail(
            session,
            new Error(
              "PAIR_SIGNAL_MARK_INVARIANT: execution entry lacks an underlying mark "
              + "at or after the confirmed signal origin",
            ),
          );
          return;
        }
      }
    }
    const valuation = markToMarket(session, executedAt);
    const profile = resolvePaperPolicyProfile(
      session.request.preset,
      session.request.riskTolerance,
    );
    if (session.pair && action.action === "buy") {
      const sizingInput = action.pairSizing;
      const sizing = sizingInput
        ? calculatePairPositionSize({
            equity: valuation.equity,
            availableCash: session.ledger.cash,
            executionPrice: price,
            executionPriceObservedAt: executedAt,
            eligibleAfter: action.eligibleAfter,
            leverageMultiplier: sizingInput.leverageMultiplier,
            predictedVolatility: sizingInput.predictedVolatility,
            targetVolatility: sizingInput.targetVolatility,
            riskTolerance: session.request.riskTolerance,
            ensembleExposureScale: sizingInput.ensembleExposureScale,
            maximumUnderlyingExposureRate: sizingInput.maximumUnderlyingExposureRate,
            currentExecutionQuantity: session.ledger.positions[symbol]?.quantity ?? 0,
            entryCostRate: (
              session.request.costs.commissionBpsPerSide
              + (action.effectiveSpreadBpsRoundTrip
                ?? session.request.costs.spreadBpsRoundTrip) / 2
              + session.request.costs.slippageBpsPerSide
            ) / 10_000,
            lotSize: 1,
          })
        : undefined;
      if (!sizing || sizing.status !== "sized" || sizing.targetExecutionGross <= 0) {
        if (sizing) {
          session.pair.lastSizing = sizing;
          const relatedDecision = [...session.decisions].reverse().find(
            (item) => item.pairDecisionId === action.pairDecisionId,
          );
          if (relatedDecision) relatedDecision.sizing = sizing;
          this.updatePairSizingProvenance(
            session,
            action.pairDecisionId,
            sizing,
          );
        }
        const cancelled = transitionPairState(
          session.pair.runtimeState,
          { type: "cancel_pending", at: executedAt },
          DEFAULT_PAIR_CATALOG,
        );
        if (cancelled.status !== "applied") {
          await this.fail(
            session,
            new PairStateLedgerInvariantError(
              `sizing cancellation failed: ${cancelled.reasonCodes.join(",")}`,
            ),
          );
          return;
        }
        session.pair.runtimeState = cancelled.state;
        session.pair.direction = cancelled.state.direction;
        session.pair.cooldownUntil = cancelled.state.cooldownUntil;
        session.pending.delete(symbol);
        try {
          assertPairStateLedgerInvariant(session);
        } catch (error) {
          await this.fail(session, error);
          return;
        }
        this.warn(
          session,
          `페어 노출 기반 sizing이 cash/unavailable입니다: ${sizing?.reasonCodes.join(",") ?? "sizing_input_missing"}`,
        );
        await this.enqueuePersistence(session, async () => {
          await this.repository.addEvent(session.id, "simulation_pair_sizing_unavailable", {
            pair_id: session.pair?.catalog.pairId,
            symbol,
            executed_at: executedAt,
            sizing: sizing ?? null,
            real_order_api: false,
          });
          await this.writeArtifacts(session);
        });
        return;
      }
      session.pair.lastSizing = sizing;
      const relatedDecision = [...session.decisions].reverse().find(
        (item) => item.pairDecisionId === action.pairDecisionId,
      );
      if (relatedDecision) relatedDecision.sizing = sizing;
      this.updatePairSizingProvenance(session, action.pairDecisionId, sizing);
      action.targetAllocationRate = Math.max(
        Number.EPSILON,
        Math.min(1, sizing.targetExecutionGross / valuation.equity),
      );
    }
    const result = fillPaperAction(
      session.ledger,
      action,
      { timestamp: executedAt, price },
      {
        symbolCount: selectionSymbolCount(session.request),
        targetAllocationRate: action.targetAllocationRate ?? profile.targetAllocationRate,
        costs: {
          commissionBpsPerSide: session.request.costs.commissionBpsPerSide,
          exitTaxBps: session.request.costs.taxBpsOnExit,
          spreadBpsRoundTrip: (
            action.effectiveSpreadBpsRoundTrip ?? session.request.costs.spreadBpsRoundTrip
          ) + (action.switchCostBps ?? 0) * 2,
          slippageBpsPerSide: session.request.costs.slippageBpsPerSide,
        },
        markPrices: session.marks,
        allocationEquity: valuation.equity,
      },
    );
    if (result.status === "rejected" && result.reason === "execution_not_after_eligible") return;
    if (result.status === "rejected" && result.reason === "mark_price_unavailable") return;
    if (result.status !== "filled" || !result.trade) {
      if (session.pair) {
        await this.fail(
          session,
          new PairStateLedgerInvariantError(
            `pair ledger fill was not executable: ${result.reason ?? result.status}`,
          ),
        );
      } else {
        session.pending.delete(symbol);
      }
      return;
    }
    let nextPairState: PairRuntimeState | undefined;
    let nextSignalPosition: { averagePrice: number; asOf: string } | undefined;
    if (session.pair) {
      const direction = symbol === session.pair.catalog.bull.executionSymbol
        ? "bull"
        : symbol === session.pair.catalog.bear.executionSymbol ? "bear" : undefined;
      if (!direction) {
        await this.fail(
          session,
          new PairStateLedgerInvariantError("fill references an execution symbol outside the pair catalog"),
        );
        return;
      }
      const stateTransition = transitionPairState(
        session.pair.runtimeState,
        {
          type: "fill",
          side: result.trade.side,
          direction,
          executionSymbol: symbol,
          executedAt: result.trade.executedAt,
          cooldownMs: DEFAULT_PAIR_ENSEMBLE_POLICY_PROFILE.cooldownMs,
        },
        DEFAULT_PAIR_CATALOG,
      );
      if (stateTransition.status !== "applied") {
        await this.fail(
          session,
          new PairStateLedgerInvariantError(
            `fill transition failed: ${stateTransition.reasonCodes.join(",")}`,
          ),
        );
        return;
      }
      nextPairState = stateTransition.state;
      nextSignalPosition = result.trade.side === "buy" && pairEntrySignalMark
        ? {
            averagePrice: pairEntrySignalMark.price,
            asOf: pairEntrySignalMark.observedAt,
          }
        : undefined;
    }
    session.pending.delete(symbol);
    session.ledger = result.ledger;
    if (session.pair && nextPairState) {
      session.pair.runtimeState = nextPairState;
      session.pair.direction = nextPairState.direction;
      session.pair.cooldownUntil = nextPairState.cooldownUntil;
      session.pair.signalPosition = nextSignalPosition;
    }
    session.ledgerRevision += 1;
    const trade: SimulationTrade = {
      ...result.trade,
      amount: result.trade.grossAmount,
      cost: result.trade.totalCosts,
      source,
      ...(action.pairDecisionId ? { pairDecisionId: action.pairDecisionId } : {}),
    };
    session.trades.push(trade);
    if (session.pair) {
      for (const pendingSymbol of executionSymbols(session)) {
        if (pendingSymbol !== symbol) session.pending.delete(pendingSymbol);
      }
      try {
        assertPairStateLedgerInvariant(session);
      } catch (error) {
        await this.fail(session, error);
        return;
      }
    }
    this.recordEquity(session, trade.executedAt);
    await this.enqueuePersistence(session, async () => {
      await this.repository.addEvent(session.id, "simulation_fill", {
        symbol: trade.symbol,
        side: trade.side,
        executed_at: trade.executedAt,
        source,
        quantity: trade.quantity,
        price: trade.price,
        real_order_api: false,
      });
      await this.writeArtifacts(session);
    });
    session.lastArtifactPersistedAtMs = this.now();
  }

  private recordEquity(session: ActiveSession, observedAt: string): void {
    const valuation = markToMarket(session, observedAt);
    session.equity.push({
      timestamp: observedAt,
      equity: valuation.equity,
      cash: session.ledger.cash,
      invested: valuation.invested,
    });
    if (session.equity.length > MAX_EQUITY_POINTS) session.equity.shift();
    if (valuation.unavailable.length) {
      this.warn(session, `평가 가격 unavailable: ${valuation.unavailable.join(", ")}`);
    }
  }

  private warn(session: ActiveSession, warning: string): void {
    session.warnings = uniqueWarnings([...session.warnings, warning]);
  }

  private async progress(session: ActiveSession): Promise<void> {
    if (session.phase !== "running" || !session.startedAt || !session.expiresAt) return;
    const processedAt = new Date(this.now()).toISOString();
    let expiration: PairEntryExpiration | undefined;
    if (session.pair) {
      try {
        assertPairStateLedgerInvariant(session);
        expiration = this.expirePairPendingEntry(session, processedAt, { processedAt });
        this.refreshPairComparison(session);
      } catch (error) {
        await this.fail(session, error);
        return;
      }
    }
    if (expiration) {
      await this.enqueuePersistence(session, async () => {
        await this.addPairEntryExpirationEvent(session, expiration);
        await this.writeArtifacts(session);
      });
    }
    const cancellationRequested = await this.repository.isCancellationRequested(session.id);
    if (session.phase !== "running") return;
    if (cancellationRequested) {
      await this.finish(session, "cancelled", "취소 요청을 반영했습니다.");
      return;
    }
    const started = Date.parse(session.startedAt);
    const expires = Date.parse(session.expiresAt);
    if (this.now() >= expires) {
      await this.finish(session, "completed", "설정한 시뮬레이션 기간이 종료되었습니다.");
      return;
    }
    const progress = expires > started ? (this.now() - started) / (expires - started) : 0;
    await this.enqueuePersistence(session, () => this.repository.updateProgress(session.id, {
      progress,
      completedCandidates: selectedSymbols(session).length,
      totalCandidates: selectionSymbolCount(session.request),
      currentValidationWindow: new Date(this.now()).toISOString(),
      warnings: session.warnings,
    }));
  }

  private queueProgress(session: ActiveSession): void {
    if (this.closed || session.phase !== "running") return;
    const task = this.progress(session).catch((error) => {
      if (session.phase === "running") {
        this.warn(
          session,
          `진행 상태 저장 실패: ${error instanceof Error ? error.message : "unknown"}`,
        );
      }
    });
    this.progressTasks.add(task);
    void task.finally(() => this.progressTasks.delete(task));
  }

  private snapshot(session: ActiveSession) {
    const valuation = markToMarket(session);
    const started = session.startedAt ? Date.parse(session.startedAt) : undefined;
    const expires = session.expiresAt ? Date.parse(session.expiresAt) : undefined;
    const progress = session.phase === "completed" || session.phase === "cancelled"
      ? 1
      : started !== undefined && expires !== undefined && expires > started
        ? Math.max(0, Math.min(0.99, (this.now() - started) / (expires - started)))
        : 0;
    return {
      schemaVersion: AI_SIMULATION_CONTRACT_VERSION,
      policyVersion: session.pair
        ? PAIR_ENSEMBLE_POLICY_VERSION
        : AI_PAPER_POLICY_VERSION,
      phase: session.phase,
      createdAt: session.createdAt,
      ...(session.startedAt ? { startedAt: session.startedAt } : {}),
      ...(session.expiresAt ? { expiresAt: session.expiresAt } : {}),
      marketCountry: session.request.marketCountry,
      currency: session.request.marketCountry === "US" ? "USD" : "KRW",
      selection: session.request.selection,
      strategy: simulationStrategy(session.request),
      ...(session.pair ? {
        pairStrategy: {
          catalogVersion: session.pair.catalog.catalogVersion,
          pairId: session.pair.catalog.pairId,
          signalSymbol: session.pair.catalog.signalSymbol,
          bull: session.pair.catalog.bull,
          bear: session.pair.catalog.bear,
          allowedSessions: session.pair.catalog.allowedSessions,
          maxSpreadBps: session.pair.catalog.maxSpreadBps,
          allowDegradedMode: session.request.strategy?.mode === "pair"
            && session.request.strategy.allowDegradedMode,
        },
        pairState: {
          direction: session.pair.direction,
          executionSymbol: session.pair.runtimeState.executionSymbol,
        },
        pairRuntimeState: session.pair.runtimeState,
      } : {}),
      criterion: selectionCriterion(session.request),
      preset: session.request.preset,
      riskTolerance: session.request.riskTolerance,
      policyProfile: session.pair ? {
        ...DEFAULT_PAIR_ENSEMBLE_POLICY_PROFILE,
        weights: { ...DEFAULT_PAIR_ENSEMBLE_POLICY_PROFILE.weights },
        modelScoreWeights: {
          ...DEFAULT_PAIR_ENSEMBLE_POLICY_PROFILE.modelScoreWeights,
        },
        allowDegradedMode: session.request.strategy?.mode === "pair"
          && session.request.strategy.allowDegradedMode,
      } : resolvePaperPolicyProfile(
        session.request.preset,
        session.request.riskTolerance,
      ),
      initialCash: session.request.initialCash,
      cash: session.ledger.cash,
      equity: valuation.equity,
      invested: valuation.invested,
      realizedPnl: session.ledger.realizedPnl,
      totalCosts: session.ledger.totalCosts,
      progress,
      decisionCadence: {
        trigger: "finalized_one_minute_bar",
        triggeredEvents: session.decisionTriggeredEvents,
        coalescedEvents: session.decisionCoalescedEvents,
        duplicateEvents: session.decisionDuplicateEvents,
        // Terminal snapshots describe the persisted run state. An aborted task
        // may still be unwinding locally, but it is no longer active work.
        inFlight: session.phase === "running" && session.analysisRunning,
        ...(session.lastDecisionTriggeredAt ? { lastTriggeredAt: session.lastDecisionTriggeredAt } : {}),
        ...(session.lastDecisionStartedAt ? { lastStartedAt: session.lastDecisionStartedAt } : {}),
        ...(session.lastDecisionFinishedAt ? { lastFinishedAt: session.lastDecisionFinishedAt } : {}),
      },
      selected: (session.selection?.selected ?? []).map((candidate) => {
        const chart = session.charts.find(({ symbol }) => symbol === candidate.symbol);
        const latestBar = chart?.bars.at(-1);
        const currentPrice = session.marks[candidate.symbol] ?? latestBar?.close;
        const priceObservedAt = session.markTimes[candidate.symbol] ?? chart?.updatedAt;
        return {
          symbol: candidate.symbol,
          name: session.metadata.get(candidate.symbol)?.name,
          exchange: session.metadata.get(candidate.symbol)?.exchange,
          ...(currentPrice !== undefined ? {
            currentPrice,
            ...(priceObservedAt ? { priceObservedAt } : {}),
          } : {}),
          score: candidate.score,
          upProbability: candidate.upProbability,
          predictedMedianReturn: candidate.medianReturn,
          inputEndAt: candidate.inputEndAt,
          generatedAt: candidate.generatedAt,
          model: candidate.model,
        };
      }),
      positions: Object.values(session.ledger.positions).map((position) => {
        const marketPrice = session.marks[position.symbol];
        return {
          symbol: position.symbol,
          quantity: position.quantity,
          averagePrice: position.averagePrice,
          ...(marketPrice !== undefined ? {
            marketPrice,
            markObservedAt: session.markTimes[position.symbol],
            unrealizedPnl: position.quantity * marketPrice - position.costBasis,
          } : {}),
        };
      }),
      pendingActions: [...session.pending.values()].map(({
        symbol,
        action,
        eligibleAfter,
        validUntil,
        pairDecisionId,
      }) => ({
        symbol,
        action,
        eligibleAfter,
        ...(validUntil ? { validUntil } : {}),
        ...(pairDecisionId ? { pairDecisionId } : {}),
      })),
      charts: session.charts,
      trades: session.trades,
      decisions: session.decisions,
      ...(session.pair?.strategyComparison !== undefined
        ? { strategyComparison: session.pair.strategyComparison } : {}),
      warnings: uniqueWarnings([
        ...session.warnings,
        ...(valuation.unavailable.length ? [`평가 가격 unavailable: ${valuation.unavailable.join(", ")}`] : []),
      ]),
      capabilities: {
        realOrder: false,
        orderApiDependency: false,
        mcp: false,
        autonomousPaperTrading: true,
        nextObservedExecutionOnly: true,
      },
    };
  }

  private async enqueuePersistence(
    session: ActiveSession,
    operation: () => void | Promise<void>,
  ): Promise<void> {
    const task = session.persistenceTail.then(operation);
    session.persistenceTail = task.catch(() => undefined);
    await task;
  }

  private async writeArtifacts(session: ActiveSession): Promise<void> {
    if (session.pair) this.refreshPairComparison(session);
    const snapshot = this.snapshot(session);
    await Promise.all([
      this.artifacts.put({
        runId: session.id,
        type: "simulation-selection",
        content: {
          policy_version: session.pair
            ? PAIR_ENSEMBLE_POLICY_VERSION
            : AI_PAPER_POLICY_VERSION,
          selection: session.selection,
          strategy: simulationStrategy(session.request),
          ...(session.pair ? { pair: session.pair.catalog } : {}),
          metadata: selectedSymbols(session).map((symbol) => session.metadata.get(symbol)),
        },
        rowCount: selectedSymbols(session).length,
        dataRevision: session.dataRevision,
      }),
      this.artifacts.put({
        runId: session.id,
        type: "simulation-decisions",
        content: session.decisions,
        rowCount: session.decisions.length,
        dataRevision: session.dataRevision,
      }),
      this.artifacts.put({
        runId: session.id,
        type: "simulation-equity",
        content: session.equity,
        rowCount: session.equity.length,
        dataRevision: session.dataRevision,
      }),
      this.artifacts.put({
        runId: session.id,
        type: "simulation-trades",
        content: session.trades,
        rowCount: session.trades.length,
        dataRevision: session.dataRevision,
      }),
      ...(session.pair ? [
        this.artifacts.put({
          runId: session.id,
          type: "simulation-comparison",
          content: session.pair.strategyComparison,
          rowCount: session.pair.comparisonObservations.length,
          dataRevision: session.dataRevision,
        }),
        this.artifacts.put({
          runId: session.id,
          type: "simulation-provenance",
          content: session.pair.provenanceRecords,
          rowCount: session.pair.provenanceRecords.length,
          dataRevision: session.dataRevision,
        }),
      ] : []),
      this.artifacts.put({
        runId: session.id,
        type: "simulation-diagnostics",
        content: {
          phase: session.phase,
          policy_version: session.pair
            ? PAIR_ENSEMBLE_POLICY_VERSION
            : AI_PAPER_POLICY_VERSION,
          contract_version: AI_SIMULATION_CONTRACT_VERSION,
          mode: "forward_paper_session",
          real_order_api_used: false,
          order_api_dependency: false,
          mcp_exposed: false,
          execution_policy: session.pair
            ? "strictly_after_all_component_generation_and_execution_quote"
            : "strictly_after_ai_generation",
          same_bar_fill_allowed: false,
          next_trade_preferred: true,
          later_final_bar_open_fallback: true,
          open_positions_are_not_force_filled_at_end: true,
          initial_portfolio: "cash_only_zero_holdings",
          selected_symbol_limit: selectionSymbolCount(session.request),
          selection_mode: session.request.selection.mode,
          strategy: simulationStrategy(session.request),
          ...(session.pair ? {
            pair_catalog_version: session.pair.catalog.catalogVersion,
            pair_id: session.pair.catalog.pairId,
            signal_symbol: session.pair.catalog.signalSymbol,
            execution_symbols: executionSymbols(session),
            active_direction: session.pair.direction,
          } : {}),
          preset: session.request.preset,
          risk_tolerance: session.request.riskTolerance,
          resolved_policy_profile: session.pair ? {
            ...DEFAULT_PAIR_ENSEMBLE_POLICY_PROFILE,
            weights: { ...DEFAULT_PAIR_ENSEMBLE_POLICY_PROFILE.weights },
            modelScoreWeights: {
              ...DEFAULT_PAIR_ENSEMBLE_POLICY_PROFILE.modelScoreWeights,
            },
            allowDegradedMode: session.request.strategy?.mode === "pair"
              && session.request.strategy.allowDegradedMode,
          } : resolvePaperPolicyProfile(
            session.request.preset,
            session.request.riskTolerance,
          ),
          decision_trigger: "new_finalized_one_minute_bar",
          decision_cadence: snapshot.decisionCadence,
          decision_artifact_checkpoint_seconds: DECISION_ARTIFACT_CHECKPOINT_MS / 1_000,
          selection_maximum_attempts: this.selectionMaximumAttempts,
          selection_retry_delay_ms: this.selectionRetryDelayMs,
          costs: session.request.costs,
          warnings: snapshot.warnings,
          snapshot,
        },
        rowCount: 1,
        dataRevision: session.dataRevision,
      }),
    ]);
  }

  private async persistArtifacts(session: ActiveSession): Promise<void> {
    await this.enqueuePersistence(session, () => this.writeArtifacts(session));
    session.lastArtifactPersistedAtMs = this.now();
  }

  private finish(
    session: ActiveSession,
    terminal: "completed" | "cancelled",
    reason: string,
  ): Promise<void> {
    if (session.finalizationTask) return session.finalizationTask;
    if (!applyPhaseTransition(session, "begin_finalization")) return Promise.resolve();
    const task = this.finalize(session, terminal, reason);
    session.finalizationTask = task;
    return task;
  }

  private async finalize(
    session: ActiveSession,
    terminal: "completed" | "cancelled",
    reason: string,
  ): Promise<void> {
    const cleanup = cleanupSimulationRuntime(
      session,
      new Error(`AI simulation ${terminal}.`),
    );
    if (cleanup.releaseError) {
      this.warn(
        session,
        `실시간 구독 해제 실패: ${cleanup.releaseError instanceof Error ? cleanup.releaseError.message : "unknown"}`,
      );
    }
    if (Object.keys(session.ledger.positions).length) {
      this.warn(session, "기간 종료 후 유효한 신규 체결을 만들지 않아 보유분을 마지막 관측가로만 평가했습니다.");
    }
    this.warn(session, reason);
    const preTerminalEquityLength = session.equity.length;
    let effectiveTerminal = terminal;
    try {
      if (session.pair) {
        const processedAt = new Date(this.now()).toISOString();
        assertPairStateLedgerInvariant(session);
        const expiration = this.expirePairPendingEntry(session, processedAt, {
          processedAt,
          force: true,
        });
        this.refreshPairComparison(session, true);
        if (expiration) {
          await this.enqueuePersistence(
            session,
            () => this.addPairEntryExpirationEvent(session, expiration),
          );
        }
      }
      if (terminal === "completed" && await this.repository.isCancellationRequested(session.id)) {
        effectiveTerminal = "cancelled";
        this.warn(session, "완료 처리와 동시에 도착한 취소 요청을 반영했습니다.");
      }
      const terminalPayload = async (phase: "completed" | "cancelled") => {
        if (!applyPhaseTransition(session, phase === "completed" ? "complete" : "cancel")) {
          throw new Error(`허용되지 않은 AI simulation phase 전이입니다: ${session.phase} -> ${phase}`);
        }
        session.equity.length = preTerminalEquityLength;
        this.recordEquity(
          session,
          phase === "completed" && session.expiresAt
            ? session.expiresAt
            : new Date(this.now()).toISOString(),
        );
        try {
          await this.persistArtifacts(session);
        } catch (error) {
          this.warn(session, `최종 artifact 저장 실패: ${error instanceof Error ? error.message : "unknown"}`);
        }
        const snapshot = this.snapshot(session);
        return {
          snapshot,
          summary: {
            phase,
            market_country: session.request.marketCountry,
            selection_mode: session.request.selection.mode,
            preset: session.request.preset,
            risk_tolerance: session.request.riskTolerance,
            initial_cash: session.request.initialCash,
            final_equity: snapshot.equity,
            net_profit_loss: snapshot.equity - session.request.initialCash,
            return_ratio: session.request.initialCash > 0
              ? snapshot.equity / session.request.initialCash - 1
              : null,
            trade_count: session.trades.length,
            selected_symbols: selectedSymbols(session),
            open_position_count: Object.keys(session.ledger.positions).length,
            total_costs: session.ledger.totalCosts,
            real_order_api_used: false,
            snapshot,
          },
        };
      };
      let payload = await terminalPayload(effectiveTerminal);
      if (effectiveTerminal === "completed") {
        const completed = await this.repository.complete(
          session.id,
          payload.summary,
          { snapshot: payload.snapshot },
          session.warnings,
          this.now(),
        );
        if (!completed) {
          if (await this.repository.isCancellationRequested(session.id)) {
            effectiveTerminal = "cancelled";
            this.warn(session, "완료 상태 전환 전에 도착한 취소 요청을 반영했습니다.");
            payload = await terminalPayload(effectiveTerminal);
            await this.repository.cancel(
              session.id,
              payload.summary,
              session.warnings,
              this.now(),
            );
          } else {
            const stored = await this.repository.get(session.id, session.ownerSubject);
            if (!stored || !["completed", "cancelled", "failed"].includes(stored.status)) {
              throw new Error("완료 상태 전환이 적용되지 않았습니다.");
            }
          }
        }
      } else {
        await this.repository.cancel(
          session.id,
          payload.summary,
          session.warnings,
          this.now(),
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown terminal persistence error";
      await this.repository.fail(session.id, {
        code: "AI_SIMULATION_TERMINALIZATION_FAILED",
        message,
        retryable: true,
        intended_status: effectiveTerminal,
        real_order_api_used: false,
      }, uniqueWarnings([...session.warnings, `run 종료 상태 저장 실패: ${message}`]), this.now());
    } finally {
      this.active.delete(session.id);
    }
  }

  private fail(session: ActiveSession, error: unknown): Promise<void> {
    if (session.finalizationTask) return session.finalizationTask;
    if (!applyPhaseTransition(session, "begin_finalization")) return Promise.resolve();
    const task = this.finalizeFailure(session, error);
    session.finalizationTask = task;
    return task;
  }

  private async finalizeFailure(session: ActiveSession, error: unknown): Promise<void> {
    const cleanup = cleanupSimulationRuntime(
      session,
      new Error("AI simulation failed."),
    );
    if (cleanup.releaseError) {
      this.warn(
        session,
        `실시간 구독 해제 실패: ${cleanup.releaseError instanceof Error ? cleanup.releaseError.message : "unknown"}`,
      );
    }
    const message = error instanceof Error ? error.message : "unknown simulation error";
    this.warn(session, message);
    if (session.pair) {
      try {
        const processedAt = new Date(this.now()).toISOString();
        const expiration = this.expirePairPendingEntry(session, processedAt, {
          processedAt,
          force: true,
        });
        this.refreshPairComparison(session, true);
        if (expiration) {
          await this.enqueuePersistence(
            session,
            () => this.addPairEntryExpirationEvent(session, expiration),
          );
        }
      } catch (cancellationError) {
        this.warn(
          session,
          `실패 종료 중 pending 정리 실패: ${
            cancellationError instanceof Error ? cancellationError.message : "unknown"
          }`,
        );
      }
    }
    if (!applyPhaseTransition(session, "fail")) {
      throw new Error(`허용되지 않은 AI simulation failure 전이입니다: ${session.phase}`);
    }
    try {
      await this.persistArtifacts(session).catch(() => undefined);
      await this.repository.fail(session.id, {
        code: "AI_SIMULATION_FAILED",
        message,
        retryable: true,
        real_order_api_used: false,
      }, session.warnings, this.now());
    } finally {
      this.active.delete(session.id);
    }
  }
}
