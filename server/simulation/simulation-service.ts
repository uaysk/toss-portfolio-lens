import type { ArtifactService } from "../services/artifact-service.js";
import type { RunService } from "../services/run-service.js";
import type { RunRepository, PortfolioRunRecord } from "../repositories/run-repository.js";
import type { ScalpingLiveEvent } from "../scalping/live-runtime.js";
import type { MarketCountry, ScannerCriterion, UsExchange } from "../scalping/contracts.js";
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
  selectAiForecastSeries,
  type AiPaperForecastCandidate,
  type AiPaperSelection,
  type PaperLedger,
  type PaperPolicyAction,
  type PaperTrade,
} from "./policy.js";

const MINUTE_MS = 60_000;
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

function forecastUnavailableCodes(value: unknown): string[] {
  const root = record(value);
  const direct = Array.isArray(root?.unavailable) ? root.unavailable : [];
  const predictions = Array.isArray(root?.predictions) ? root.predictions : [];
  return Array.from(new Set([...direct, ...predictions].flatMap((item) => {
    const source = record(item);
    const unavailable = record(source?.unavailable);
    const symbol = nonempty(source?.symbol, 32);
    const code = nonempty(source?.code, 128) ?? nonempty(unavailable?.code, 128);
    return code ? [`${symbol ? `${symbol}:` : ""}${code}`] : [];
  }))).slice(0, 20);
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

function workspaceCandidates(value: unknown): CandidateMetadata[] {
  const workspace = record(record(value)?.workspace);
  const candidates = workspace?.candidates;
  if (!Array.isArray(candidates)) return [];
  const seen = new Set<string>();
  const output: CandidateMetadata[] = [];
  for (const value of candidates) {
    const item = record(value);
    const symbol = nonempty(item?.symbol, 32)?.toUpperCase();
    if (!symbol || seen.has(symbol) || item?.filtered === true) continue;
    const exchange = item?.exchange;
    output.push({
      symbol,
      ...(nonempty(item?.name, 160) ? { name: nonempty(item?.name, 160) } : {}),
      ...(["NAS", "NYS", "AMS"].includes(String(exchange)) ? { exchange: exchange as UsExchange } : {}),
      ...(finite(item?.price) !== undefined && finite(item?.price)! > 0 ? { price: finite(item?.price) } : {}),
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

function technicalStates(value: unknown): Record<string, unknown> {
  const root = record(value);
  const technical = record(root?.technical);
  const instruments = technical?.instruments;
  if (!Array.isArray(instruments)) return {};
  const output: Record<string, unknown> = {};
  for (const value of instruments) {
    const instrument = record(value);
    const symbol = nonempty(instrument?.instrument_key, 128)?.toUpperCase();
    const latest = record(record(instrument?.signals)?.latest);
    const state = nonempty(latest?.status, 64);
    if (symbol && state) {
      output[symbol] = {
        status: state,
        observedAt: latestTimestamp([
          root?.generatedAt,
          root?.generated_at,
          latest?.calculation_timestamp,
          latest?.signal_timestamp,
        ]),
      };
    }
  }
  return output;
}

type SimulationMarketSource = {
  status(enabled?: boolean): unknown;
  workspace(input: {
    marketCountry: MarketCountry;
    criterion: ScannerCriterion;
    topCount: number;
    interval: "1m";
    layoutColumns: 1;
    preset: SimulationPreset;
    scanOnly: true;
    includePortfolioContext: false;
  }): Promise<unknown>;
  forecast(input: {
    marketCountry: MarketCountry;
    symbols: string[];
    interval: "1m";
  }): Promise<unknown>;
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
  }): Promise<unknown>;
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
  decisionIntervalMinutes: number;
  maximumActiveSessions: number;
  candidatePoolSize: number;
  progressUpdateMs?: number;
  now?: () => number;
};

type SimulationPhase =
  | "selecting"
  | "running"
  | "finalizing"
  | "completed"
  | "cancelled"
  | "failed";

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

type ActiveSession = {
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
  warnings: string[];
  release?: () => void;
  endTimer?: NodeJS.Timeout;
  progressTimer?: NodeJS.Timeout;
  analysisRunning: boolean;
  analysisQueued: boolean;
  lastAnalysisBar?: string;
  persistenceTail: Promise<void>;
};

function combinedRelease(...releases: Array<() => void>): () => void {
  return () => {
    const errors: unknown[] = [];
    for (const release of releases) {
      try {
        release();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, "일부 실시간 구독을 해제하지 못했습니다.");
  };
}

function releaseWithRetry(release: () => void): void {
  try {
    release();
  } catch (firstError) {
    try {
      release();
    } catch (secondError) {
      throw new AggregateError(
        [firstError, secondError],
        "실시간 구독 해제 재시도가 실패했습니다.",
      );
    }
  }
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
  private readonly now: () => number;
  private readonly progressUpdateMs: number;
  private readonly removeLiveListener: () => void;
  private closed = false;

  constructor(
    private readonly market: SimulationMarketSource,
    private readonly live: SimulationLiveSource,
    private readonly runs: RunService,
    private readonly repository: RunRepository,
    private readonly artifacts: ArtifactService,
    private readonly config: AiTradingSimulationConfig,
  ) {
    if (!Number.isInteger(config.maximumDurationMinutes) || config.maximumDurationMinutes < 1
      || !Number.isInteger(config.decisionIntervalMinutes) || config.decisionIntervalMinutes < 1
      || !Number.isInteger(config.maximumActiveSessions) || config.maximumActiveSessions < 1
      || !Number.isInteger(config.candidatePoolSize) || config.candidatePoolSize < 2) {
      throw new Error("AI simulation configuration is invalid.");
    }
    this.now = config.now ?? Date.now;
    this.progressUpdateMs = config.progressUpdateMs ?? 5_000;
    if (!Number.isInteger(this.progressUpdateMs) || this.progressUpdateMs < 100 || this.progressUpdateMs > 60_000) {
      throw new Error("AI simulation progress interval must be in 100..=60000ms.");
    }
    this.removeLiveListener = live.onEvent((event) => {
      void this.handleLiveEvent(event).catch((error) => {
        console.warn("[simulation] live event 처리 실패:", error instanceof Error ? error.message : error);
      });
    });
  }

  status(enabled = true) {
    const provider = record(this.market.status(enabled));
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
      },
      providers: provider?.providers,
      capabilities: {
        realOrder: false,
        orderApiDependency: false,
        mcp: false,
        autonomousPaperTrading: true,
        aiSelectsSymbols: true,
        rustTechnicalIndicators: true,
        nextObservedExecutionOnly: true,
        marketCountries: "KR,US",
      },
      policy: {
        version: AI_PAPER_POLICY_VERSION,
        side: "long_only",
        quantity: "whole_share",
        decisionIntervalMinutes: this.config.decisionIntervalMinutes,
        execution: "strictly_after_ai_generation_on_next_observed_trade_or_later_final_bar_open",
      },
      activeSessions: this.active.size,
      limitations: [
        "실제 주문 API를 호출하지 않는 가상 원장입니다.",
        "AI 전망은 투자 지시나 수익 보장이 아니며 모델이 unavailable이면 임의 신호를 만들지 않습니다.",
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
    const config = {
      schema_version: AI_SIMULATION_CONTRACT_VERSION,
      policy_version: AI_PAPER_POLICY_VERSION,
      mode: "forward_paper_session",
      market_country: input.marketCountry,
      scanner_criterion: input.criterion,
      initial_cash: input.initialCash,
      duration_minutes: input.durationMinutes,
      selected_symbol_count: input.symbolCount,
      preset: input.preset,
      costs: input.costs,
      candidate_pool_size: this.config.candidatePoolSize,
      decision_interval_minutes: this.config.decisionIntervalMinutes,
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
      totalCandidates: input.symbolCount,
    });
    try {
      if (!await this.repository.markRunning(run.id, createdAtMs)) {
        throw new Error("AI 시뮬레이션 run을 시작하지 못했습니다.");
      }
      await this.repository.addEvent(run.id, "simulation_selecting", {
        market_country: input.marketCountry,
        requested_symbol_count: input.symbolCount,
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
      warnings: [],
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
    return {
      run: runView(run),
      snapshot: active ? this.snapshot(active) : result?.snapshot ?? summary?.snapshot ?? checkpoint,
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
    const session = this.active.get(runId);
    if (session) await this.finish(session, "cancelled", "사용자가 시뮬레이션을 중단했습니다.");
    const stored = await this.repository.get(runId, ownerSubject);
    return stored ? {
      run: runView(stored),
      snapshot: record(stored.result)?.snapshot
        ?? record(stored.summary)?.snapshot
        ?? (session ? this.snapshot(session) : undefined),
    } : undefined;
  }

  async close(reason = "server_shutdown"): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.removeLiveListener();
    await Promise.allSettled([...this.startTasks]);
    await Promise.allSettled([...this.active.values()].map((session) => (
      this.finish(session, "cancelled", `시뮬레이션이 중단되었습니다: ${reason}`)
    )));
  }

  private async initialize(session: ActiveSession): Promise<void> {
    const workspaceResult = await this.market.workspace({
      marketCountry: session.request.marketCountry,
      criterion: session.request.criterion,
      topCount: this.config.candidatePoolSize,
      interval: "1m",
      layoutColumns: 1,
      preset: session.request.preset,
      scanOnly: true,
      includePortfolioContext: false,
    });
    if (session.phase !== "selecting") return;
    const scannedCandidates = workspaceCandidates(workspaceResult).slice(0, this.config.candidatePoolSize);
    const candidates = session.request.marketCountry === "US"
      ? scannedCandidates.filter(({ exchange }) => exchange !== undefined)
      : scannedCandidates;
    if (candidates.length !== scannedCandidates.length) {
      this.warn(session, "거래소 식별자가 없는 미국 후보를 AI 선정 대상에서 제외했습니다.");
    }
    if (candidates.length < session.request.symbolCount) {
      throw new Error("AI가 선택할 수 있는 유효 스캔 후보가 부족합니다.");
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
    await this.live.waitForIdle();
    if (session.phase !== "selecting") return;
    const forecastResult = await this.market.forecast({
      marketCountry: session.request.marketCountry,
      symbols: candidateSymbols,
      interval: "1m",
    });
    if (session.phase !== "selecting") return;
    const selection = selectAiForecastSeries(record(forecastResult)?.forecast, {
      symbolCount: session.request.symbolCount,
      roundTripCostRate: roundTripCostRate(session.request.costs),
    });
    if (selection.status !== "available") {
      const unavailable = forecastUnavailableCodes(forecastResult);
      throw new Error(
        `AI 종목 선정이 unavailable입니다: ${selection.reason ?? "unknown"}`
        + (unavailable.length ? ` (${unavailable.join(", ")})` : ""),
      );
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
    const technical = await this.market.realtimeAnalysis({
      marketCountry: session.request.marketCountry,
      symbols,
      interval: "1m",
      preset: session.request.preset,
      positionContext: isolatedPositionContext(session),
    });
    if (session.phase !== "selecting") return;
    const startedAtMs = this.now();
    session.startedAt = new Date(startedAtMs).toISOString();
    session.expiresAt = new Date(startedAtMs + session.request.durationMinutes * MINUTE_MS).toISOString();
    session.phase = "running";
    const decisionRecordedAt = this.recordActions(session, selection, technicalStates(technical));
    this.recordEquity(session, decisionRecordedAt);
    await this.repository.addEvent(session.id, "simulation_ready", {
      symbols,
      model_id: selection.model?.modelId,
      model_revision: selection.model?.modelRevision,
      expires_at: session.expiresAt,
    }, startedAtMs);
    await this.repository.updateProgress(session.id, {
      progress: 0,
      completedCandidates: symbols.length,
      totalCandidates: session.request.symbolCount,
      currentValidationWindow: session.startedAt,
    }, startedAtMs);
    await this.persistArtifacts(session);
    const remainingMs = Math.max(0, Date.parse(session.expiresAt) - this.now());
    session.endTimer = setTimeout(() => {
      void this.finish(session, "completed", "설정한 시뮬레이션 기간이 종료되었습니다.")
        .catch((error) => console.warn(
          "[simulation] 기간 종료 처리 실패:",
          error instanceof Error ? error.message : error,
        ));
    }, remainingMs);
    session.endTimer.unref();
    session.progressTimer = setInterval(() => void this.progress(session), this.progressUpdateMs);
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
        model: action.model,
      };
      session.decisions.push(decision);
      if (session.decisions.length > MAX_DECISIONS) session.decisions.shift();
      if ((action.action === "buy" || action.action === "sell")
        && insideSessionBoundary(session, eligibleAfter)
        && eligibleAfter !== session.expiresAt) {
        session.pending.set(action.symbol, executableAction);
      } else {
        session.pending.delete(action.symbol);
      }
    }
    return observedAt;
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
        if (closeTime && insideSessionBoundary(session, closeTime)
          && closeTime !== session.expiresAt
          && this.shouldAnalyze(session, closeTime)) {
          this.queueAnalysis(session, closeTime);
        }
      }
    }
  }

  private shouldAnalyze(session: ActiveSession, closeTime: string): boolean {
    if (session.lastAnalysisBar && Date.parse(closeTime) <= Date.parse(session.lastAnalysisBar)) return false;
    const minute = Math.floor(Date.parse(closeTime) / MINUTE_MS);
    return minute % this.config.decisionIntervalMinutes === 0;
  }

  private queueAnalysis(session: ActiveSession, closeTime: string): void {
    session.lastAnalysisBar = closeTime;
    session.analysisQueued = true;
    if (session.analysisRunning) return;
    session.analysisRunning = true;
    void (async () => {
      try {
        while (session.analysisQueued && session.phase === "running") {
          session.analysisQueued = false;
          await this.refreshDecision(session);
        }
      } finally {
        session.analysisRunning = false;
      }
    })().catch((error) => {
      this.warn(session, `판단 갱신 실패: ${error instanceof Error ? error.message : "unknown"}`);
    });
  }

  private async refreshDecision(session: ActiveSession): Promise<void> {
    const symbols = selectedSymbols(session);
    if (!symbols.length) return;
    const ledgerRevision = session.ledgerRevision;
    const positionContext = isolatedPositionContext(session);
    await this.live.waitForIdle();
    const [forecastResult, technical] = await Promise.all([
      this.market.forecast({
        marketCountry: session.request.marketCountry,
        symbols,
        interval: "1m",
      }),
      this.market.realtimeAnalysis({
        marketCountry: session.request.marketCountry,
        symbols,
        interval: "1m",
        preset: session.request.preset,
        positionContext,
      }),
    ]);
    if (session.phase !== "running") return;
    if (session.expiresAt && this.now() >= Date.parse(session.expiresAt)) return;
    if (session.ledgerRevision !== ledgerRevision) {
      session.analysisQueued = true;
      return;
    }
    const selection = selectAiForecastSeries(record(forecastResult)?.forecast, {
      symbolCount: session.request.symbolCount,
      roundTripCostRate: roundTripCostRate(session.request.costs),
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
    const decisionRecordedAt = this.recordActions(session, selection, technicalStates(technical));
    this.recordEquity(session, decisionRecordedAt);
    await this.repository.addEvent(session.id, "simulation_decision", {
      generated_at: selection.generatedAt,
      symbols,
      pending_actions: [...session.pending.values()].map(({ symbol, action, eligibleAfter }) => ({
        symbol, action, eligible_after: eligibleAfter,
      })),
    });
    await this.persistArtifacts(session);
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
    const result = fillPaperAction(
      session.ledger,
      action,
      { timestamp: executedAt, price },
      {
        symbolCount: session.request.symbolCount,
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
    await this.repository.addEvent(session.id, "simulation_fill", {
      symbol: trade.symbol,
      side: trade.side,
      executed_at: trade.executedAt,
      source,
      quantity: trade.quantity,
      price: trade.price,
      real_order_api: false,
    });
    await this.persistArtifacts(session);
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
    if (await this.repository.isCancellationRequested(session.id)) {
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
    await this.repository.updateProgress(session.id, {
      progress,
      completedCandidates: selectedSymbols(session).length,
      totalCandidates: session.request.symbolCount,
      currentValidationWindow: new Date(this.now()).toISOString(),
      warnings: session.warnings,
    });
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
      initialCash: session.request.initialCash,
      cash: session.ledger.cash,
      equity: valuation.equity,
      invested: valuation.invested,
      realizedPnl: session.ledger.realizedPnl,
      totalCosts: session.ledger.totalCosts,
      progress,
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

  private async persistArtifacts(session: ActiveSession): Promise<void> {
    const task = session.persistenceTail.then(async () => {
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
            selected_symbol_limit: session.request.symbolCount,
            costs: session.request.costs,
            warnings: snapshot.warnings,
            snapshot,
          },
          rowCount: 1,
          dataRevision: session.dataRevision,
        }),
      ]);
    });
    session.persistenceTail = task.catch(() => undefined);
    await task;
  }

  private async finish(
    session: ActiveSession,
    terminal: "completed" | "cancelled",
    reason: string,
  ): Promise<void> {
    if (!["selecting", "running"].includes(session.phase)) return;
    session.phase = "finalizing";
    if (session.endTimer) clearTimeout(session.endTimer);
    if (session.progressTimer) clearInterval(session.progressTimer);
    try {
      if (session.release) releaseWithRetry(session.release);
    } catch (error) {
      this.warn(session, `실시간 구독 해제 실패: ${error instanceof Error ? error.message : "unknown"}`);
    }
    session.release = undefined;
    if (Object.keys(session.ledger.positions).length) {
      this.warn(session, "기간 종료 후 유효한 신규 체결을 만들지 않아 보유분을 마지막 관측가로만 평가했습니다.");
    }
    this.warn(session, reason);
    session.phase = terminal;
    this.recordEquity(
      session,
      terminal === "completed" && session.expiresAt
        ? session.expiresAt
        : new Date(this.now()).toISOString(),
    );
    try {
      try {
        await this.persistArtifacts(session);
      } catch (error) {
        this.warn(session, `최종 artifact 저장 실패: ${error instanceof Error ? error.message : "unknown"}`);
      }
      const snapshot = this.snapshot(session);
      const summary = {
        phase: terminal,
        market_country: session.request.marketCountry,
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
      };
      try {
        if (terminal === "completed") {
          if (await this.repository.isCancellationRequested(session.id)) {
            await this.repository.cancel(session.id, summary, session.warnings, this.now());
          } else {
            const completed = await this.repository.complete(
              session.id,
              summary,
              { snapshot },
              session.warnings,
              this.now(),
            );
            if (!completed) {
              if (await this.repository.isCancellationRequested(session.id)) {
                await this.repository.cancel(session.id, summary, session.warnings, this.now());
              } else {
                const stored = await this.repository.get(session.id, session.ownerSubject);
                if (!stored || !["completed", "cancelled", "failed"].includes(stored.status)) {
                  throw new Error("완료 상태 전환이 적용되지 않았습니다.");
                }
              }
            }
          }
        } else {
          await this.repository.cancel(session.id, summary, session.warnings, this.now());
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown terminal persistence error";
        await this.repository.fail(session.id, {
          code: "AI_SIMULATION_TERMINALIZATION_FAILED",
          message,
          retryable: true,
          intended_status: terminal,
          real_order_api_used: false,
        }, uniqueWarnings([...session.warnings, `run 종료 상태 저장 실패: ${message}`]), this.now());
      }
    } finally {
      this.active.delete(session.id);
    }
  }

  private async fail(session: ActiveSession, error: unknown): Promise<void> {
    if (session.phase === "completed" || session.phase === "cancelled" || session.phase === "failed") return;
    if (session.endTimer) clearTimeout(session.endTimer);
    if (session.progressTimer) clearInterval(session.progressTimer);
    try {
      if (session.release) releaseWithRetry(session.release);
    } catch (releaseError) {
      this.warn(session, `실시간 구독 해제 실패: ${releaseError instanceof Error ? releaseError.message : "unknown"}`);
    }
    session.release = undefined;
    session.phase = "failed";
    const message = error instanceof Error ? error.message : "unknown simulation error";
    this.warn(session, message);
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
