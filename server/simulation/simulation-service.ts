import type { ArtifactService } from "../services/artifact-service.js";
import type { RunService } from "../services/run-service.js";
import type { RunRepository, PortfolioRunRecord } from "../repositories/run-repository.js";
import type { ScalpingLiveEvent } from "../scalping/live-runtime.js";
import type { MarketCountry, ScannerCriterion, UsExchange } from "../scalping/contracts.js";
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
} from "./contracts.js";
import { AI_SIMULATION_CONTRACT_VERSION } from "./contracts.js";
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
  mergeSimulationLatestTechnical,
  simulationChartsFromWorkspace,
  type SimulationChartView,
} from "./chart-data.js";

const MINUTE_MS = 60_000;
const DECISION_ARTIFACT_CHECKPOINT_MS = 60_000;
const MAX_DECISIONS = 5_000;
const MAX_EQUITY_POINTS = 5_000;
const MAX_MARK_HISTORY_PER_SYMBOL = 4_096;

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
  return request.selection.mode === "manual"
    ? request.selection.symbols.length as 1 | 2
    : request.selection.symbolCount;
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
};

type SimulationTrade = PaperTrade & {
  amount: number;
  cost: number;
  source: "kis_ws_trade" | "next_final_bar_open";
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
  pending: Map<string, PaperPolicyAction>;
  decisions: SimulationDecision[];
  trades: SimulationTrade[];
  equity: EquityPoint[];
  charts: SimulationChartView[];
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
  return session.selection?.status === "available"
    ? session.selection.selected.map(({ symbol }) => symbol)
    : [];
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
        marketCountries: "KR,US",
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
    const symbolCount = selectionSymbolCount(input);
    const policyProfile = resolvePaperPolicyProfile(input.preset, input.riskTolerance);
    const config = {
      schema_version: AI_SIMULATION_CONTRACT_VERSION,
      policy_version: AI_PAPER_POLICY_VERSION,
      mode: "forward_paper_session",
      market_country: input.marketCountry,
      selection: input.selection,
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
        requested_symbols: manuallySelectedSymbols(input),
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
      && selectedSymbols(session).includes(event.symbol!)
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
      } else if (event.type === "trade") {
        const executedAt = timestamp(payload.executedAt);
        const price = finite(payload.price);
        if (!executedAt || price === undefined || price <= 0) continue;
        if (!insideSessionBoundary(session, executedAt)) continue;
        if (updateMark(session, event.symbol, price, executedAt)) {
          await this.tryFill(session, event.symbol, executedAt, price, "kis_ws_trade");
        }
      } else if (event.type === "bar"
        && payload.intervalMinutes === 1
        && payload.state === "final") {
        const chart = session.charts.find((item) => item.symbol === event.symbol);
        const chartChanged = chart ? mergeSimulationFinalBar(chart, payload) : false;
        const closeTime = timestamp(payload.closeTime);
        const openTime = timestamp(payload.openTime);
        const open = finite(payload.open);
        const close = finite(payload.close);
        if (openTime && insideSessionBoundary(session, openTime)
          && open !== undefined && open > 0) {
          if (updateMark(session, event.symbol, open, openTime)) {
            await this.tryFill(session, event.symbol, openTime, open, "next_final_bar_open");
          }
        }
        if (closeTime && insideSessionBoundary(session, closeTime)
          && close !== undefined && close > 0) {
          updateMark(session, event.symbol, close, closeTime);
        }
        if (chartChanged && session.phase === "running") {
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

  private async tryFill(
    session: ActiveSession,
    symbol: string,
    executedAt: string,
    price: number,
    source: SimulationTrade["source"],
  ): Promise<void> {
    const action = session.pending.get(symbol);
    if (!action || session.phase !== "running") return;
    if (!insideSessionBoundary(session, executedAt)) return;
    const latestTrade = session.trades.at(-1);
    if (latestTrade && Date.parse(executedAt) < Date.parse(latestTrade.executedAt)) {
      this.warn(session, "가상 원장보다 과거에 도착한 체결 이벤트를 무시했습니다.");
      return;
    }
    const valuation = markToMarket(session, executedAt);
    const profile = resolvePaperPolicyProfile(
      session.request.preset,
      session.request.riskTolerance,
    );
    const result = fillPaperAction(
      session.ledger,
      action,
      { timestamp: executedAt, price },
      {
        symbolCount: selectionSymbolCount(session.request),
        targetAllocationRate: profile.targetAllocationRate,
        costs: {
          commissionBpsPerSide: session.request.costs.commissionBpsPerSide,
          exitTaxBps: session.request.costs.taxBpsOnExit,
          spreadBpsRoundTrip: session.request.costs.spreadBpsRoundTrip,
          slippageBpsPerSide: session.request.costs.slippageBpsPerSide,
        },
        markPrices: session.marks,
        allocationEquity: valuation.equity,
      },
    );
    if (result.status === "rejected" && result.reason === "execution_not_after_eligible") return;
    if (result.status === "rejected" && result.reason === "mark_price_unavailable") return;
    session.pending.delete(symbol);
    if (result.status !== "filled" || !result.trade) return;
    session.ledger = result.ledger;
    session.ledgerRevision += 1;
    const trade: SimulationTrade = {
      ...result.trade,
      amount: result.trade.grossAmount,
      cost: result.trade.totalCosts,
      source,
    };
    session.trades.push(trade);
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
      policyVersion: AI_PAPER_POLICY_VERSION,
      phase: session.phase,
      createdAt: session.createdAt,
      ...(session.startedAt ? { startedAt: session.startedAt } : {}),
      ...(session.expiresAt ? { expiresAt: session.expiresAt } : {}),
      marketCountry: session.request.marketCountry,
      currency: session.request.marketCountry === "US" ? "USD" : "KRW",
      selection: session.request.selection,
      criterion: selectionCriterion(session.request),
      preset: session.request.preset,
      riskTolerance: session.request.riskTolerance,
      policyProfile: resolvePaperPolicyProfile(
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
      selected: (session.selection?.selected ?? []).map((candidate) => ({
        symbol: candidate.symbol,
        name: session.metadata.get(candidate.symbol)?.name,
        exchange: session.metadata.get(candidate.symbol)?.exchange,
        score: candidate.score,
        upProbability: candidate.upProbability,
        predictedMedianReturn: candidate.medianReturn,
        inputEndAt: candidate.inputEndAt,
        generatedAt: candidate.generatedAt,
        model: candidate.model,
      })),
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
      pendingActions: [...session.pending.values()].map(({ symbol, action, eligibleAfter }) => ({
        symbol, action, eligibleAfter,
      })),
      charts: session.charts,
      trades: session.trades,
      decisions: session.decisions,
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
    const snapshot = this.snapshot(session);
    await Promise.all([
      this.artifacts.put({
        runId: session.id,
        type: "simulation-selection",
        content: {
          policy_version: AI_PAPER_POLICY_VERSION,
          selection: session.selection,
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
      this.artifacts.put({
        runId: session.id,
        type: "simulation-diagnostics",
        content: {
          phase: session.phase,
          policy_version: AI_PAPER_POLICY_VERSION,
          contract_version: AI_SIMULATION_CONTRACT_VERSION,
          mode: "forward_paper_session",
          real_order_api_used: false,
          order_api_dependency: false,
          mcp_exposed: false,
          execution_policy: "strictly_after_ai_generation",
          same_bar_fill_allowed: false,
          next_trade_preferred: true,
          later_final_bar_open_fallback: true,
          open_positions_are_not_force_filled_at_end: true,
          initial_portfolio: "cash_only_zero_holdings",
          selected_symbol_limit: selectionSymbolCount(session.request),
          selection_mode: session.request.selection.mode,
          preset: session.request.preset,
          risk_tolerance: session.request.riskTolerance,
          resolved_policy_profile: resolvePaperPolicyProfile(
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
