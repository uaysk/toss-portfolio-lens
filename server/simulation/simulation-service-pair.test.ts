import { describe, expect, it, vi } from "vitest";
import type { ArtifactType } from "../repositories/artifact-repository.js";
import type {
  PortfolioRunRecord,
  RunRepository,
} from "../repositories/run-repository.js";
import type { ScalpingLiveEvent } from "../scalping/live-runtime.js";
import type { ArtifactService } from "../services/artifact-service.js";
import type { RunService } from "../services/run-service.js";
import type { SimulationStartRequest } from "./contracts.js";
import {
  verifyPairDecisionReplay,
  type PairDecisionProvenance,
} from "./decision-provenance.js";
import { AiTradingSimulationService } from "./simulation-service.js";

const RUN_ID = "550e8400-e29b-41d4-a716-446655440004";
const OWNER = "pair-test-owner";
const INITIAL_ORIGIN = "2026-07-24T14:30:00.000Z";
const INITIAL_NOW = "2026-07-24T14:30:05.000Z";
const INPUT_DIGEST = "a".repeat(64);

type Direction = "bull" | "bear";
type TechnicalState = "entry_candidate" | "hold" | "exit_candidate" | "watch";
type QuoteMode = "available" | "missing" | "stale";

type Scenario = {
  origin: string;
  kronosDirection: Direction;
  technicalState: TechnicalState;
  technicalSignal: -1 | 0 | 1;
  quoteMode: QuoteMode;
};

type StoredArtifact = {
  runId: string;
  type: ArtifactType;
  content: unknown;
  rowCount?: number;
  dataRevision: string;
};

type PairSnapshot = {
  phase: string;
  pairStrategy?: {
    pairId: string;
    signalSymbol: string;
    bull: { executionSymbol: string };
    bear: { executionSymbol: string };
  };
  pairState?: {
    direction: "bull" | "bear" | "cash";
    executionSymbol: string | null;
  };
  pendingActions: Array<{
    symbol: string;
    action: "buy" | "sell" | "hold" | "watch";
    eligibleAfter: string;
    validUntil?: string;
    pairDecisionId?: string;
  }>;
  positions: Array<{ symbol: string; quantity: number }>;
  trades: Array<{
    symbol: string;
    side: "buy" | "sell";
    executedAt: string;
  }>;
  decisions: Array<{
    action: "buy" | "sell" | "hold" | "watch";
    direction?: "bull" | "bear" | "cash";
    eligibleAfter: string;
    reasons: string[];
    ensemble?: {
      origin?: string;
      direction: "bull" | "bear" | "cash";
      reasonCodes: string[];
    };
    modelOutputs?: {
      alignmentStatus: string;
      alignedOrigin?: string;
      kronos: {
        inputEndAt?: string;
        rawOutput: { role?: string; raw_series?: unknown[] };
        provenance: { modelId?: string; deviceName?: string };
      };
    };
    rustSignal?: {
      signalOriginAt?: string;
      status: TechnicalState | null;
      rawOutput?: unknown;
    };
  }>;
  capabilities: {
    realOrder: boolean;
    orderApiDependency: boolean;
    mcp: boolean;
  };
  strategyComparison?: {
    pairId: string;
    sameOrigin: boolean;
    sameCosts: boolean;
    sameExecutionPolicy: boolean;
    pendingOriginCount?: number;
    skippedOriginCount?: number;
    skippedOrigins?: Array<{
      origin: string;
      reasonCodes: string[];
    }>;
  };
  warnings: string[];
};

function at(origin: string, offsetMs: number): string {
  return new Date(Date.parse(origin) + offsetMs).toISOString();
}

function workerModel() {
  return {
    model_id: "NeoQuasar/Kronos-base",
    model_revision: "2b554741eca47781b64468546e77fef3e85130e6",
    tokenizer_id: "NeoQuasar/Kronos-Tokenizer-base",
    tokenizer_revision: "0e0117387f39004a9016484a186a908917e22426",
    source_revision: "kronos-pinned",
    loader_version: "pair-worker/v1",
    license: "Apache-2.0",
    device: "cuda",
    device_name: "Tesla P40",
    cuda_capability: "6.1",
    dtype: "float32",
    attention_backend: "math",
    loaded: true,
  } as const;
}

function returnDistribution(direction: Direction) {
  return direction === "bull"
    ? {
        values: [-0.005, 0.015, 0.022, 0.03, 0.037, 0.045, 0.052],
        up: 0.86,
        down: 0.09,
      }
    : {
        values: [-0.052, -0.045, -0.037, -0.03, -0.022, -0.015, 0.005],
        up: 0.09,
        down: 0.86,
      };
}

function rawSeries(origin: string, direction: Direction) {
  const distribution = returnDistribution(direction);
  const quantiles = [0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95] as const;
  return [{
    instrument_key: "TSLA",
    status: "available",
    input_end_at: origin,
    horizons: ([5, 15, 30, 60] as const).map((minutes) => ({
      horizon_minutes: minutes,
      target_timestamp: at(origin, minutes * 60_000),
      return_quantiles: quantiles.map((quantile, index) => ({
        quantile,
        value: distribution.values[index]!,
      })),
      price_quantiles: quantiles.map((quantile, index) => ({
        quantile,
        value: 250 * (1 + distribution.values[index]!),
      })),
      up_probability: distribution.up,
      down_probability: distribution.down,
      flat_probability: 0.05,
      probability_method: "sample_paths",
      expected_volatility: 0.015,
      volatility_method: "path_realized",
      uncertainty_interval_width: 0.03,
      target_stop: {
        status: "unavailable",
        reason: "target_stop_not_requested",
      },
      valid_path_count: 64,
      invalid_path_count: 0,
    })),
    input_quality: {
      status: "good",
      bar_count: 121,
      missing_volume_ratio: 0,
      missing_amount_ratio: 0,
      irregular_interval_count: 0,
      warnings: [],
    },
    distribution_shift: {
      status: "unavailable",
      reason: "reference_statistics_not_published",
    },
  }];
}

function modelRun(
  origin: string,
  direction: Direction,
) {
  const modelId = "NeoQuasar/Kronos-base" as const;
  return {
    role: "kronos_base",
    expected_model_id: modelId,
    status: "available",
    model: workerModel(),
    generated_at: at(origin, 2_000),
    latency_ms: 185,
    degraded: false,
    fallback_used: false,
    input_origins: [{
      instrument_key: "TSLA",
      context_start_at: at(origin, -120 * 60_000),
      input_end_at: origin,
      bar_count: 121,
      input_digest: INPUT_DIGEST,
    }],
    input_end_aligned: true,
    raw_series: rawSeries(origin, direction),
  };
}

function kronosForecast(scenario: Scenario) {
  const kronos = modelRun(
    scenario.origin,
    scenario.kronosDirection,
  );
  return {
    forecast: {
      schema_version: "scalping-ai/v1",
      request_id: `pair-${Date.parse(scenario.origin)}`,
      mode: "forecast",
      status: "available",
      model: kronos.model,
      generated_at: kronos.generated_at,
      series: kronos.raw_series,
      model_runs: [kronos],
      evaluation: null,
      error: null,
    },
    predictions: [],
  };
}

function technicalAnalysis(scenario: Scenario) {
  const bullish = scenario.technicalSignal > 0;
  const bearish = scenario.technicalSignal < 0;
  return {
    schemaVersion: "scalping-realtime-analysis/v1",
    generatedAt: at(scenario.origin, 3_000),
    marketCountry: "US",
    interval: "1m",
    preset: "risk_management",
    barRevision: `bars:${scenario.origin}`,
    technical: {
      schema_version: "scalping-analysis-result/v3",
      response_mode: "latest_summary",
      interval_minutes: 1,
      instruments: [{
        instrument_key: "TSLA",
        signals: {
          latest: {
            status: scenario.technicalState,
            calculation_timestamp: at(scenario.origin, 3_000),
            signal_timestamp: scenario.origin,
            earliest_eligible_timestamp: at(scenario.origin, 3_000),
            technical_signal: scenario.technicalSignal,
            multi_timeframe_agreement: bullish
              ? "aligned_bullish"
              : bearish ? "aligned_bearish" : "neutral",
            multi_timeframe_trends: {
              "1m": bullish ? "bullish" : bearish ? "bearish" : "neutral",
              "5m": bullish ? "bullish" : bearish ? "bearish" : "neutral",
            },
            confidence: 0.95,
            confidence_semantics: "deterministic technical confidence",
            data_quality: { status: "good" },
            rationale: ["same finalized origin", "multi-timeframe agreement"],
          },
        },
        data_quality: { status: "good", reasons: [] },
      }],
    },
    diagnostics: {
      analysisBatchRequestCount: 1,
      analysisBatchInstrumentCount: 1,
      finalizedBarsOnly: true,
      providerRescan: false,
      positionContext: "isolated_request",
    },
  };
}

function candidates() {
  return [
    { symbol: "TSLA", name: "Tesla", exchange: "NAS" as const, currency: "USD", price: 250, filtered: false },
    { symbol: "TSLL", name: "Direxion TSLA Bull", exchange: "NAS" as const, currency: "USD", price: 50, filtered: false },
    { symbol: "TSLQ", name: "Tradr TSLA Bear", exchange: "NAS" as const, currency: "USD", price: 40, filtered: false },
  ];
}

function quote(symbol: string, scenario: Scenario) {
  if (scenario.quoteMode === "missing" || symbol === "TSLA") return undefined;
  const mid = symbol === "TSLL" ? 50 : 40;
  const observedAt = scenario.quoteMode === "stale"
    ? at(scenario.origin, -40_000)
    : at(scenario.origin, 4_000);
  return {
    observedAt,
    asks: [{ price: mid + 0.02, quantity: 100 }],
    bids: [{ price: mid - 0.02, quantity: 100 }],
  };
}

function bars(symbol: string, origin: string) {
  const base = symbol === "TSLA" ? 250 : symbol === "TSLL" ? 50 : 40;
  return [
    {
      timestamp: at(origin, -60_000),
      open: base - 0.2,
      high: base + 0.1,
      low: base - 0.3,
      close: base,
      volume: 10_000,
      status: "final",
    },
    {
      timestamp: origin,
      open: base,
      high: base + 0.3,
      low: base - 0.1,
      close: base + 0.2,
      volume: 12_000,
      status: "final",
    },
  ];
}

function workspace(scenario: Scenario, symbols: readonly string[]) {
  return {
    workspace: {
      generatedAt: at(scenario.origin, 3_000),
      candidates: candidates(),
      instruments: symbols.map((symbol) => ({
        symbol,
        bars: bars(symbol, scenario.origin),
        technical: {},
        ...(quote(symbol, scenario) ? { orderbook: quote(symbol, scenario) } : {}),
      })),
    },
  };
}

function pairRequest(): SimulationStartRequest {
  return {
    market: { kind: "stock", country: "US" },
    marketCountry: "US",
    initialCash: 100_000,
    durationMinutes: 60,
    selection: {
      mode: "auto",
      criterion: "trading_amount",
      symbolCount: 1,
    },
    strategy: {
      mode: "pair",
      pairId: "tsla-tsll-tslq",
      allowDegradedMode: false,
    },
    preset: "risk_management",
    riskTolerance: 80,
    costs: {
      commissionBpsPerSide: 1.5,
      taxBpsOnExit: 0,
      spreadBpsRoundTrip: 5,
      slippageBpsPerSide: 2,
    },
    modelLanes: ["kronos_base"],
    execution: { mode: "paper" },
  };
}

function createRun(
  ownerSubject: string,
  input: unknown,
  dataRevision: string,
  now: number,
): PortfolioRunRecord {
  return {
    id: RUN_ID,
    kind: "ai_trading_simulation",
    ownerSubject,
    requestHash: "pair-request-hash",
    dataRevision,
    engineVersion: "pair-test-engine",
    status: "queued",
    progress: 0,
    completedCandidates: 0,
    totalCandidates: 1,
    input,
    warnings: [],
    tags: [],
    createdAt: now,
    updatedAt: now,
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function harness(overrides: Partial<Scenario> = {}) {
  const scenario: Scenario = {
    origin: INITIAL_ORIGIN,
    kronosDirection: "bull",
    technicalState: "entry_candidate",
    technicalSignal: 1,
    quoteMode: "available",
    ...overrides,
  };
  let nowMs = Date.parse(INITIAL_NOW);
  let currentRun: PortfolioRunRecord | undefined;
  let listener: ((event: ScalpingLiveEvent) => void) | undefined;
  const storedArtifacts: StoredArtifact[] = [];
  const repositoryEvents: Array<{ type: string; detail: unknown }> = [];
  const release = vi.fn();
  const removeListener = vi.fn();

  const market = {
    status: vi.fn(() => ({ providers: { ai: { status: "configured" } } })),
    workspace: vi.fn((input: { scanOnly: boolean; symbols?: string[] }) => Promise.resolve(
      input.scanOnly
        ? { workspace: { generatedAt: at(scenario.origin, 3_000), candidates: candidates(), instruments: [] } }
        : workspace(scenario, input.symbols ?? []),
    )),
    forecast: vi.fn((
      _input: unknown,
      _options?: { signal?: AbortSignal; maximumInputEndAt?: string },
    ) => Promise.resolve(kronosForecast(scenario))),
    realtimeAnalysis: vi.fn((
      _input: unknown,
      _options?: {
        signal?: AbortSignal;
        skipAutomaticRefresh?: boolean;
        maximumInputEndAt?: string;
      },
    ) => Promise.resolve(technicalAnalysis(scenario))),
  };
  const live = {
    retain: vi.fn().mockResolvedValue(release),
    onEvent: vi.fn((value: (event: ScalpingLiveEvent) => void) => {
      listener = value;
      return removeListener;
    }),
    waitForIdle: vi.fn().mockResolvedValue(undefined),
  };
  const runService = {
    create: vi.fn(async (input: {
      ownerSubject: string;
      config: unknown;
      dataRevision: string;
      totalCandidates?: number;
    }) => {
      currentRun = createRun(
        input.ownerSubject,
        input.config,
        input.dataRevision,
        nowMs,
      );
      currentRun.totalCandidates = input.totalCandidates ?? 1;
      return currentRun;
    }),
  };
  const repository = {
    markRunning: vi.fn(async (_id: string, observedAt = nowMs) => {
      if (!currentRun || currentRun.status !== "queued") return false;
      currentRun.status = "running";
      currentRun.startedAt = observedAt;
      currentRun.updatedAt = observedAt;
      return true;
    }),
    addEvent: vi.fn(async (
      _id: string,
      type: string,
      detail: unknown,
    ) => {
      repositoryEvents.push({ type, detail: clone(detail) });
    }),
    updateProgress: vi.fn(async (
      _id: string,
      update: {
        progress: number;
        completedCandidates?: number;
        totalCandidates?: number;
        currentValidationWindow?: string;
        warnings?: string[];
      },
      observedAt = nowMs,
    ) => {
      if (!currentRun) return;
      currentRun.progress = Math.max(0, Math.min(0.99, update.progress));
      currentRun.completedCandidates = update.completedCandidates
        ?? currentRun.completedCandidates;
      currentRun.totalCandidates = update.totalCandidates ?? currentRun.totalCandidates;
      currentRun.currentValidationWindow = update.currentValidationWindow
        ?? currentRun.currentValidationWindow;
      currentRun.warnings = update.warnings ?? currentRun.warnings;
      currentRun.updatedAt = observedAt;
    }),
    get: vi.fn(async (id: string, ownerSubject: string) => (
      currentRun?.id === id && currentRun.ownerSubject === ownerSubject
        ? currentRun
        : undefined
    )),
    list: vi.fn(async () => ({ items: currentRun ? [currentRun] : [] })),
    requestCancellation: vi.fn(async () => {
      if (!currentRun) return false;
      currentRun.status = "cancel_requested";
      return true;
    }),
    isCancellationRequested: vi.fn(async () => currentRun?.status === "cancel_requested"),
    complete: vi.fn(async () => true),
    cancel: vi.fn(async (
      _id: string,
      summary: unknown,
      warnings: string[],
      observedAt = nowMs,
    ) => {
      if (!currentRun) return;
      currentRun.status = "cancelled";
      currentRun.summary = clone(summary);
      currentRun.warnings = [...warnings];
      currentRun.finishedAt = observedAt;
      currentRun.updatedAt = observedAt;
    }),
    fail: vi.fn(async (
      _id: string,
      error: unknown,
      warnings: string[],
      observedAt = nowMs,
    ) => {
      if (!currentRun) return;
      currentRun.status = "failed";
      currentRun.error = clone(error);
      currentRun.warnings = [...warnings];
      currentRun.finishedAt = observedAt;
      currentRun.updatedAt = observedAt;
    }),
  };
  const artifactService = {
    put: vi.fn(async (input: StoredArtifact) => {
      storedArtifacts.push({ ...input, content: clone(input.content) });
      return {} as never;
    }),
    get: vi.fn(async (runId: string, type: ArtifactType) => {
      const artifact = storedArtifacts.filter((item) => (
        item.runId === runId && item.type === type
      )).at(-1);
      return artifact
        ? { descriptor: {} as never, content: clone(artifact.content) }
        : undefined;
    }),
  };
  const service = new AiTradingSimulationService(
    market as unknown as ConstructorParameters<typeof AiTradingSimulationService>[0],
    live,
    runService as unknown as RunService,
    repository as unknown as RunRepository,
    artifactService as unknown as ArtifactService,
    {
      maximumDurationMinutes: 390,
      maximumActiveSessions: 2,
      candidatePoolSize: 3,
      selectionMaximumAttempts: 1,
      selectionRetryDelayMs: 1,
      progressUpdateMs: 60_000,
      now: () => nowMs,
    },
  );

  return {
    scenario,
    service,
    market,
    live,
    repository,
    repositoryEvents,
    storedArtifacts,
    release,
    removeListener,
    setNow(value: string) {
      nowMs = Date.parse(value);
    },
    emit(event: ScalpingLiveEvent) {
      if (!listener) throw new Error("live listener was not registered");
      listener(event);
    },
  };
}

function tradeEvent(
  symbol: "TSLL" | "TSLQ",
  executedAt: string,
  price: number,
  emittedAt = executedAt,
): ScalpingLiveEvent {
  return {
    schemaVersion: "scalping-live-event/v1",
    id: Date.parse(executedAt),
    emittedAt,
    type: "trade",
    symbol,
    marketCountry: "US",
    payload: { executedAt, price, quantity: 100 },
  };
}

function orderbookEvent(symbol: "TSLL" | "TSLQ", observedAt: string): ScalpingLiveEvent {
  const mid = symbol === "TSLL" ? 50 : 40;
  return {
    schemaVersion: "scalping-live-event/v1",
    id: Date.parse(observedAt) + (symbol === "TSLL" ? 1 : 2),
    emittedAt: observedAt,
    type: "orderbook",
    symbol,
    marketCountry: "US",
    payload: {
      observedAt,
      asks: [{ price: mid + 0.02, quantity: 100 }],
      bids: [{ price: mid - 0.02, quantity: 100 }],
    },
  };
}

function invalidOrderbookEvent(
  symbol: "TSLL" | "TSLQ",
  observedAt: string,
): ScalpingLiveEvent {
  return {
    schemaVersion: "scalping-live-event/v1",
    id: Date.parse(observedAt) + (symbol === "TSLL" ? 11 : 12),
    emittedAt: observedAt,
    type: "orderbook",
    symbol,
    marketCountry: "US",
    payload: {
      observedAt,
      asks: [],
      bids: [],
    },
  };
}

function signalTradeEvent(executedAt: string, price: number): ScalpingLiveEvent {
  return {
    schemaVersion: "scalping-live-event/v1",
    id: Date.parse(executedAt) + 21,
    emittedAt: executedAt,
    type: "trade",
    symbol: "TSLA",
    marketCountry: "US",
    payload: { executedAt, price, quantity: 100 },
  };
}

function finalSignalBar(origin: string): ScalpingLiveEvent {
  return {
    schemaVersion: "scalping-live-event/v1",
    id: Date.parse(origin),
    emittedAt: origin,
    type: "bar",
    symbol: "TSLA",
    marketCountry: "US",
    payload: {
      intervalMinutes: 1,
      state: "final",
      openTime: at(origin, -60_000),
      closeTime: origin,
      open: 250,
      high: 251,
      low: 249.5,
      close: 250.5,
      volume: 20_000,
    },
  };
}

async function readSnapshot(setup: ReturnType<typeof harness>): Promise<PairSnapshot> {
  const view = await setup.service.get(RUN_ID, OWNER) as unknown as {
    snapshot?: PairSnapshot;
  } | undefined;
  if (!view?.snapshot) throw new Error("simulation snapshot is unavailable");
  return view.snapshot;
}

async function waitForSnapshot(
  setup: ReturnType<typeof harness>,
  predicate: (snapshot: PairSnapshot) => boolean,
  message: string,
): Promise<PairSnapshot> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const snapshot = await readSnapshot(setup);
    if (predicate(snapshot)) return snapshot;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Timed out waiting for ${message}`);
}

async function settleEvents(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

async function startRunning(setup: ReturnType<typeof harness>): Promise<PairSnapshot> {
  const started = await setup.service.start(pairRequest(), OWNER);
  expect(started.runId).toBe(RUN_ID);
  return waitForSnapshot(setup, (snapshot) => snapshot.phase === "running", "pair session running");
}

function expectMutuallyExclusive(snapshot: PairSnapshot): void {
  const symbols = new Set(snapshot.positions.map(({ symbol }) => symbol));
  expect(symbols.has("TSLL") && symbols.has("TSLQ")).toBe(false);
}

describe("AI trading simulation pair integration", () => {
  it("retains the exact catalog triplet and aligns Kronos-base and Rust at one origin", async () => {
    const setup = harness();
    try {
      const status = setup.service.status() as {
        capabilities: Record<string, unknown>;
      };
      expect(status.capabilities).toMatchObject({
        realOrder: false,
        orderApiDependency: false,
        mcp: false,
        pairStrategy: true,
        kronosRustEnsemble: true,
      });

      const snapshot = await startRunning(setup);
      expect(setup.live.retain).toHaveBeenCalledTimes(1);
      expect(setup.live.retain).toHaveBeenCalledWith(
        ["TSLA", "TSLL", "TSLQ"],
        "US",
        { TSLA: "NAS", TSLL: "NAS", TSLQ: "NAS" },
      );
      expect(setup.market.workspace.mock.calls.map(([input]) => input.symbols)).toEqual([
        ["TSLA", "TSLL", "TSLQ"],
        ["TSLA", "TSLL", "TSLQ"],
      ]);
      expect(setup.market.forecast).toHaveBeenCalledWith(
        { marketCountry: "US", symbols: ["TSLA"], interval: "1m" },
        expect.objectContaining({
          signal: expect.any(AbortSignal),
          maximumInputEndAt: INITIAL_ORIGIN,
        }),
      );
      expect(snapshot.pairStrategy).toMatchObject({
        pairId: "tsla-tsll-tslq",
        signalSymbol: "TSLA",
        bull: { executionSymbol: "TSLL" },
        bear: { executionSymbol: "TSLQ" },
      });

      const decision = snapshot.decisions.at(-1);
      expect(decision?.ensemble).toMatchObject({
        origin: INITIAL_ORIGIN,
        direction: "bull",
      });
      expect(decision?.modelOutputs).toMatchObject({
        alignmentStatus: "aligned",
        alignedOrigin: INITIAL_ORIGIN,
        kronos: {
          inputEndAt: INITIAL_ORIGIN,
          provenance: {
            modelId: "NeoQuasar/Kronos-base",
            deviceName: "Tesla P40",
          },
        },
      });
      expect(decision?.modelOutputs?.kronos.rawOutput).toMatchObject({
        role: "kronos_base",
        raw_series: [expect.objectContaining({ input_end_at: INITIAL_ORIGIN })],
      });
      expect(decision?.rustSignal).toMatchObject({
        signalOriginAt: INITIAL_ORIGIN,
        status: "entry_candidate",
        rawOutput: expect.any(Object),
      });
      expect(snapshot.capabilities).toEqual(expect.objectContaining({
        realOrder: false,
        orderApiDependency: false,
        mcp: false,
      }));
      expect(snapshot.strategyComparison).toMatchObject({
        pairId: "tsla-tsll-tslq",
        sameOrigin: true,
        sameCosts: true,
        sameExecutionPolicy: true,
      });
      const provenanceArtifact = setup.storedArtifacts.filter(
        ({ type }) => type === "simulation-provenance",
      ).at(-1)?.content as PairDecisionProvenance[] | undefined;
      expect(provenanceArtifact).toHaveLength(1);
      expect(verifyPairDecisionReplay(provenanceArtifact![0]!)).toMatchObject({
        valid: true,
        reasonCodes: [],
      });
      expect(provenanceArtifact![0]).toMatchObject({
        rawInputs: {
          kronos: expect.any(Object),
          rust: expect.any(Object),
        },
        weights: { kronos: 0.72, rust: 0.28 },
      });
      expect(setup.storedArtifacts.some(
        ({ type }) => type === "simulation-comparison",
      )).toBe(true);
    } finally {
      await setup.service.close("pair_test_complete");
    }
  });

  it("waits for forecast refresh and pins pair model and Rust inputs to each captured origin", async () => {
    const setup = harness();
    let completedForecastOrigin: string | undefined;
    setup.market.forecast.mockImplementation(async (
      _input,
      options,
    ) => {
      const origin = options?.maximumInputEndAt;
      await Promise.resolve();
      completedForecastOrigin = origin;
      return kronosForecast({
        ...setup.scenario,
        ...(origin ? { origin } : {}),
      });
    });
    setup.market.realtimeAnalysis.mockImplementation((
      _input,
      options,
    ) => {
      const requestedOrigin = options?.maximumInputEndAt;
      const origin = requestedOrigin && completedForecastOrigin === requestedOrigin
        ? requestedOrigin
        : at(requestedOrigin ?? setup.scenario.origin, -60_000);
      return Promise.resolve(technicalAnalysis({
        ...setup.scenario,
        origin,
      }));
    });
    try {
      let snapshot = await startRunning(setup);
      expect(snapshot.decisions.at(-1)).toMatchObject({
        ensemble: { origin: INITIAL_ORIGIN },
        modelOutputs: {
          alignmentStatus: "aligned",
          alignedOrigin: INITIAL_ORIGIN,
        },
        rustSignal: { signalOriginAt: INITIAL_ORIGIN },
      });
      expect(setup.market.forecast.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
        maximumInputEndAt: INITIAL_ORIGIN,
      }));
      expect(setup.market.realtimeAnalysis.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
        skipAutomaticRefresh: true,
        maximumInputEndAt: INITIAL_ORIGIN,
      }));

      const nextOrigin = at(INITIAL_ORIGIN, 60_000);
      setup.scenario.origin = nextOrigin;
      setup.setNow(at(nextOrigin, 5_000));
      setup.emit(finalSignalBar(nextOrigin));
      snapshot = await waitForSnapshot(
        setup,
        (value) => value.decisions.length >= 2,
        "origin-pinned pair refresh",
      );

      expect(snapshot.decisions.at(-1)).toMatchObject({
        ensemble: { origin: nextOrigin },
        modelOutputs: {
          alignmentStatus: "aligned",
          alignedOrigin: nextOrigin,
        },
        rustSignal: { signalOriginAt: nextOrigin },
      });
      expect(setup.market.forecast.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
        maximumInputEndAt: nextOrigin,
      }));
      expect(setup.market.realtimeAnalysis.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
        skipAutomaticRefresh: true,
        maximumInputEndAt: nextOrigin,
      }));
    } finally {
      await setup.service.close("pair_test_complete");
    }
  });

  it("fails closed to cash without pending execution when Kronos and Rust conflict", async () => {
    const setup = harness({ kronosDirection: "bear" });
    try {
      const snapshot = await startRunning(setup);
      const decision = snapshot.decisions.at(-1);
      expect(decision?.ensemble).toMatchObject({
        origin: INITIAL_ORIGIN,
        direction: "cash",
        reasonCodes: expect.arrayContaining(["rust_direction_conflict"]),
      });
      expect(snapshot.pairState).toEqual({
        direction: "cash",
        executionSymbol: null,
      });
      expect(snapshot.pendingActions).toEqual([]);
      expect(snapshot.positions).toEqual([]);
      expectMutuallyExclusive(snapshot);
    } finally {
      await setup.service.close("pair_test_complete");
    }
  });

  it.each([
    ["missing", "execution_data_unavailable_or_stale"],
    ["stale", "execution_quote_stale"],
  ] as const)("fails closed to cash when the execution quote is %s", async (quoteMode, reason) => {
    const setup = harness({ quoteMode });
    try {
      const snapshot = await startRunning(setup);
      expect(snapshot.decisions.at(-1)?.ensemble).toMatchObject({
        direction: "cash",
        reasonCodes: expect.arrayContaining([reason]),
      });
      expect(snapshot.pendingActions).toEqual([]);
      expect(snapshot.positions).toEqual([]);
      expectMutuallyExclusive(snapshot);
    } finally {
      await setup.service.close("pair_test_complete");
    }
  });

  it("uses only post-signal execution ETF prices, applies Rust exit, and never holds bull and bear together", async () => {
    const setup = harness();
    try {
      let snapshot = await startRunning(setup);
      const entryEligible = snapshot.pendingActions.find(({ symbol }) => symbol === "TSLL");
      expect(entryEligible).toMatchObject({ action: "buy", eligibleAfter: INITIAL_NOW });
      expectMutuallyExclusive(snapshot);

      setup.emit(tradeEvent("TSLL", at(entryEligible!.eligibleAfter, -1), 50));
      setup.emit(tradeEvent("TSLL", entryEligible!.eligibleAfter, 50));
      await settleEvents();
      snapshot = await readSnapshot(setup);
      expect(snapshot.trades).toEqual([]);
      expect(snapshot.positions).toEqual([]);

      const entryExecutedAt = at(entryEligible!.eligibleAfter, 1_000);
      setup.emit(tradeEvent("TSLL", entryExecutedAt, 50));
      snapshot = await waitForSnapshot(
        setup,
        (value) => value.trades.length === 1,
        "post-signal TSLL entry fill",
      );
      expect(snapshot.trades[0]).toMatchObject({
        symbol: "TSLL",
        side: "buy",
        executedAt: entryExecutedAt,
      });
      expect(snapshot.pairState).toEqual({
        direction: "bull",
        executionSymbol: "TSLL",
      });
      expect(snapshot.positions).toEqual([
        expect.objectContaining({ symbol: "TSLL", quantity: expect.any(Number) }),
      ]);
      expectMutuallyExclusive(snapshot);

      const exitOrigin = "2026-07-24T14:31:00.000Z";
      setup.scenario.origin = exitOrigin;
      setup.scenario.technicalState = "exit_candidate";
      setup.scenario.technicalSignal = -1;
      setup.setNow(at(exitOrigin, 5_000));
      setup.emit(orderbookEvent("TSLL", at(exitOrigin, 4_000)));
      await settleEvents();
      setup.emit(finalSignalBar(exitOrigin));

      snapshot = await waitForSnapshot(
        setup,
        (value) => value.decisions.length >= 2
          && value.pendingActions.some(({ symbol, action }) => symbol === "TSLL" && action === "sell"),
        "Rust exit decision",
      );
      const exitDecision = snapshot.decisions.at(-1);
      expect(exitDecision?.ensemble).toMatchObject({
        origin: exitOrigin,
        direction: "cash",
        reasonCodes: expect.arrayContaining(["rust_exit_candidate"]),
      });
      expect(exitDecision?.action).toBe("sell");
      expect(snapshot.pendingActions).toEqual([
        expect.objectContaining({ symbol: "TSLL", action: "sell" }),
      ]);
      expect(snapshot.positions.map(({ symbol }) => symbol)).toEqual(["TSLL"]);
      expectMutuallyExclusive(snapshot);

      const exitEligible = snapshot.pendingActions[0]!.eligibleAfter;
      const exitExecutedAt = at(exitEligible, 1_000);
      setup.emit(tradeEvent("TSLL", exitExecutedAt, 49.5));
      snapshot = await waitForSnapshot(
        setup,
        (value) => value.trades.length === 2 && value.positions.length === 0,
        "TSLL exit fill",
      );
      expect(snapshot.trades[1]).toMatchObject({
        symbol: "TSLL",
        side: "sell",
        executedAt: exitExecutedAt,
      });
      expect(snapshot.pairState).toEqual({
        direction: "cash",
        executionSymbol: null,
      });
      expectMutuallyExclusive(snapshot);

      const bearOrigin = "2026-07-24T14:37:00.000Z";
      setup.scenario.origin = bearOrigin;
      setup.scenario.kronosDirection = "bear";
      setup.scenario.technicalState = "exit_candidate";
      setup.scenario.technicalSignal = -1;
      setup.setNow(at(bearOrigin, 5_000));
      setup.emit(orderbookEvent("TSLL", at(bearOrigin, 4_000)));
      setup.emit(orderbookEvent("TSLQ", at(bearOrigin, 4_000)));
      await settleEvents();
      setup.emit(finalSignalBar(bearOrigin));

      snapshot = await waitForSnapshot(
        setup,
        (value) => value.decisions.length >= 3
          && value.pendingActions.some(({ symbol, action }) => symbol === "TSLQ" && action === "buy"),
        "post-cooldown TSLQ entry decision",
      );
      expect(snapshot.decisions.at(-1)?.ensemble).toMatchObject({
        origin: bearOrigin,
        direction: "bear",
      });
      expect(snapshot.pendingActions).toEqual([
        expect.objectContaining({ symbol: "TSLQ", action: "buy" }),
      ]);
      expectMutuallyExclusive(snapshot);

      const bearEligible = snapshot.pendingActions[0]!.eligibleAfter;
      setup.emit(tradeEvent("TSLQ", at(bearEligible, 1_000), 40));
      snapshot = await waitForSnapshot(
        setup,
        (value) => value.trades.length === 3
          && value.positions.some(({ symbol }) => symbol === "TSLQ"),
        "post-cooldown TSLQ entry fill",
      );
      expect(snapshot.positions).toEqual([
        expect.objectContaining({ symbol: "TSLQ", quantity: expect.any(Number) }),
      ]);
      expect(snapshot.positions.some(({ symbol }) => symbol === "TSLL")).toBe(false);
      expectMutuallyExclusive(snapshot);
    } finally {
      await setup.service.close("pair_test_complete");
    }
  });

  it("expires an unfilled entry at its forecast horizon and admits a fresh later decision", async () => {
    const setup = harness();
    try {
      let snapshot = await startRunning(setup);
      const pending = snapshot.pendingActions.find(({ symbol }) => symbol === "TSLL");
      expect(pending?.validUntil).toBe("2026-07-24T14:35:00.000Z");

      setup.emit(tradeEvent("TSLL", pending!.validUntil!, 50));
      await settleEvents();
      snapshot = await readSnapshot(setup);
      expect(snapshot.trades).toEqual([]);
      expect(snapshot.positions).toEqual([]);
      expect(snapshot.pendingActions).toEqual([]);
      expect(snapshot.pairState).toEqual({ direction: "cash", executionSymbol: null });
      expect(setup.repositoryEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "simulation_pair_entry_expired" }),
      ]));

      const freshOrigin = pending!.validUntil!;
      setup.scenario.origin = freshOrigin;
      setup.setNow(at(freshOrigin, 5_000));
      setup.emit(orderbookEvent("TSLL", at(freshOrigin, 4_000)));
      setup.emit(orderbookEvent("TSLQ", at(freshOrigin, 4_000)));
      await settleEvents();
      setup.emit(finalSignalBar(freshOrigin));
      snapshot = await waitForSnapshot(
        setup,
        (value) => value.decisions.length >= 2
          && value.pendingActions.some(({ symbol, action }) => (
            symbol === "TSLL" && action === "buy"
          )),
        "fresh post-expiry pair entry",
      );
      expect(snapshot.pendingActions[0]).toMatchObject({
        symbol: "TSLL",
        action: "buy",
        eligibleAfter: at(freshOrigin, 5_000),
        validUntil: "2026-07-24T14:40:00.000Z",
      });
      expectMutuallyExclusive(snapshot);
    } finally {
      await setup.service.close("pair_test_complete");
    }
  });

  it("does not retroactively fill a delayed pre-horizon trade received after the horizon", async () => {
    const setup = harness();
    try {
      let snapshot = await startRunning(setup);
      const pending = snapshot.pendingActions.find(({ symbol }) => symbol === "TSLL")!;
      const receivedAt = at(pending.validUntil!, 60_000);
      setup.setNow(receivedAt);
      setup.emit(tradeEvent(
        "TSLL",
        at(pending.validUntil!, -30_000),
        50,
        receivedAt,
      ));
      snapshot = await waitForSnapshot(
        setup,
        (value) => value.pendingActions.length === 0,
        "processing-time entry expiration",
      );
      expect(snapshot.trades).toEqual([]);
      expect(snapshot.positions).toEqual([]);
      await settleEvents();
      expect(setup.repositoryEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: "simulation_pair_entry_expired",
          detail: expect.objectContaining({
            reason: "forecast_horizon_elapsed",
            processed_at: receivedAt,
          }),
        }),
      ]));
    } finally {
      await setup.service.close("pair_test_complete");
    }
  });

  it("invalidates a newer malformed book instead of retaining the prior valid quote", async () => {
    const setup = harness();
    try {
      await startRunning(setup);
      const origin = "2026-07-24T14:31:00.000Z";
      setup.scenario.origin = origin;
      setup.setNow(at(origin, 5_000));
      setup.emit(orderbookEvent("TSLL", at(origin, 4_000)));
      setup.emit(invalidOrderbookEvent("TSLQ", at(origin, 4_000)));
      await settleEvents();
      setup.emit(finalSignalBar(origin));
      const snapshot = await waitForSnapshot(
        setup,
        (value) => value.decisions.length >= 2 && value.pendingActions.length === 0,
        "decision after malformed execution book",
      );
      expect(snapshot.decisions.at(-1)?.ensemble).toMatchObject({
        direction: "cash",
        reasonCodes: expect.arrayContaining(["execution_quote_unavailable"]),
      });
      expect(snapshot.pendingActions).toEqual([]);
      expect(snapshot.positions).toEqual([]);
    } finally {
      await setup.service.close("pair_test_complete");
    }
  });

  it("ignores an older malformed book and keeps the newer valid quote", async () => {
    const setup = harness();
    try {
      await startRunning(setup);
      const origin = "2026-07-24T14:31:00.000Z";
      setup.scenario.origin = origin;
      setup.setNow(at(origin, 5_000));
      setup.emit(orderbookEvent("TSLL", at(origin, 4_000)));
      setup.emit(orderbookEvent("TSLQ", at(origin, 4_000)));
      setup.emit(invalidOrderbookEvent("TSLQ", at(origin, 3_000)));
      await settleEvents();
      setup.emit(finalSignalBar(origin));
      const snapshot = await waitForSnapshot(
        setup,
        (value) => value.decisions.length >= 2,
        "decision after out-of-order malformed book",
      );
      expect(snapshot.decisions.at(-1)?.ensemble).toMatchObject({
        direction: "bull",
      });
      expect(snapshot.decisions.at(-1)?.ensemble?.reasonCodes).not.toContain(
        "execution_quote_unavailable",
      );
    } finally {
      await setup.service.close("pair_test_complete");
    }
  });

  it("revalidates both execution legs before filling a pending entry", async () => {
    const setup = harness();
    try {
      const snapshot = await startRunning(setup);
      expect(snapshot.pendingActions).toEqual([
        expect.objectContaining({ symbol: "TSLL", action: "buy" }),
      ]);
      const executedAt = at(INITIAL_ORIGIN, 40_000);
      setup.setNow(executedAt);
      setup.emit(orderbookEvent("TSLL", at(INITIAL_ORIGIN, 39_000)));
      setup.emit(tradeEvent("TSLL", executedAt, 50));
      await settleEvents();
      const blocked = await readSnapshot(setup);
      expect(blocked.trades).toEqual([]);
      expect(blocked.positions).toEqual([]);
      expect(blocked.pendingActions).toEqual([
        expect.objectContaining({ symbol: "TSLL", action: "buy" }),
      ]);
      expect(blocked.warnings.some((warning) => (
        warning.includes("진입") && warning.includes("TSLQ")
      ))).toBe(true);
    } finally {
      await setup.service.close("pair_test_complete");
    }
  });

  it("skips comparison origins with no executable prices after the bounded grace", async () => {
    const setup = harness();
    try {
      await startRunning(setup);
      const origin = "2026-07-24T14:36:01.000Z";
      setup.scenario.origin = origin;
      setup.setNow(at(origin, 5_000));
      setup.emit(orderbookEvent("TSLL", at(origin, 4_000)));
      setup.emit(orderbookEvent("TSLQ", at(origin, 4_000)));
      await settleEvents();
      setup.emit(finalSignalBar(origin));
      const snapshot = await waitForSnapshot(
        setup,
        (value) => (value.strategyComparison?.skippedOriginCount ?? 0) >= 1
          && value.decisions.length >= 2,
        "comparison grace skip",
      );
      expect(snapshot.strategyComparison).toMatchObject({
        skippedOriginCount: 1,
        pendingOriginCount: 1,
        skippedOrigins: [
          expect.objectContaining({
            origin: INITIAL_ORIGIN,
            reasonCodes: expect.arrayContaining([
              "bull_entry_price_unavailable",
              "bear_entry_price_unavailable",
            ]),
          }),
        ],
      });
    } finally {
      await setup.service.close("pair_test_complete");
    }
  });

  it("captures the exact finalized chart origin so startup comparison does not lose it", async () => {
    const setup = harness();
    try {
      await startRunning(setup);
      const internal = setup.service as unknown as {
        active: Map<string, {
          markHistory: Record<string, Array<{ price: number; observedAt: string }>>;
          pair: {
            comparisonPending: Array<{ signalOriginPrice?: number }>;
          };
        }>;
        refreshPairComparison: (session: unknown) => void;
      };
      const active = internal.active.get(RUN_ID)!;
      expect(active.pair.comparisonPending[0]?.signalOriginPrice).toBe(250.2);
      active.markHistory.TSLA = [{
        price: 249,
        observedAt: at(INITIAL_ORIGIN, -60_000),
      }];
      setup.setNow("2026-07-24T14:36:00.000Z");
      internal.refreshPairComparison(active);
      const snapshot = await readSnapshot(setup);
      expect(snapshot.strategyComparison?.skippedOrigins?.[0]).toMatchObject({
        origin: INITIAL_ORIGIN,
      });
      expect(snapshot.strategyComparison?.skippedOrigins?.[0]?.reasonCodes).not.toContain(
        "signal_origin_mark_not_exact",
      );
    } finally {
      await setup.service.close("pair_test_complete");
    }
  });

  it("rolls back runtime and executable pending state when decision commit work throws", async () => {
    const setup = harness();
    try {
      const initial = await startRunning(setup);
      const initialPending = initial.pendingActions[0]!;
      const internal = setup.service as unknown as {
        queuePairComparison: (...args: unknown[]) => void;
      };
      const originalQueue = internal.queuePairComparison.bind(setup.service);
      let injectFailure = true;
      internal.queuePairComparison = (...args: unknown[]) => {
        if (injectFailure) {
          injectFailure = false;
          throw new Error("injected comparison commit failure");
        }
        originalQueue(...args);
      };

      const origin = "2026-07-24T14:31:00.000Z";
      setup.scenario.origin = origin;
      setup.scenario.kronosDirection = "bear";
      setup.setNow(at(origin, 5_000));
      setup.emit(orderbookEvent("TSLL", at(origin, 4_000)));
      setup.emit(orderbookEvent("TSLQ", at(origin, 4_000)));
      await settleEvents();
      setup.emit(finalSignalBar(origin));
      const snapshot = await waitForSnapshot(
        setup,
        (value) => value.warnings.some((warning) => (
          warning.includes("injected comparison commit failure")
        )),
        "decision rollback warning",
      );
      expect(snapshot.decisions).toHaveLength(1);
      expect(snapshot.pendingActions).toEqual([
        expect.objectContaining({
          symbol: initialPending.symbol,
          action: initialPending.action,
          eligibleAfter: initialPending.eligibleAfter,
          pairDecisionId: initialPending.pairDecisionId,
        }),
      ]);
    } finally {
      await setup.service.close("pair_test_complete");
    }
  });

  it("detects an orphan runtime pending transition before action lookup", async () => {
    const setup = harness();
    try {
      const snapshot = await startRunning(setup);
      const active = (
        setup.service as unknown as {
          active: Map<string, { pending: Map<string, unknown> }>;
        }
      ).active.get(RUN_ID)!;
      active.pending.clear();
      setup.emit(tradeEvent(
        "TSLL",
        at(snapshot.pendingActions[0]!.eligibleAfter, 1_000),
        50,
      ));
      await vi.waitFor(() => {
        expect(setup.repository.fail).toHaveBeenCalled();
      });
      expect(setup.repository.fail.mock.calls.at(-1)?.[1]).toEqual(
        expect.objectContaining({
          message: expect.stringContaining("PAIR_STATE_LEDGER_INVARIANT"),
        }),
      );
    } finally {
      await setup.service.close("pair_test_complete");
    }
  });

  it("atomically cancels an unfilled entry when the session finalizes", async () => {
    const setup = harness();
    await startRunning(setup);
    await setup.service.close("pair_test_finalization");
    const snapshot = await readSnapshot(setup);
    expect(snapshot.pendingActions).toEqual([]);
    expect(setup.repositoryEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "simulation_pair_entry_expired",
        detail: expect.objectContaining({
          reason: "session_finalized_before_execution",
        }),
      }),
    ]));
  });
});
