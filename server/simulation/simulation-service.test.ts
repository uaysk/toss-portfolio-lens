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
import { AiTradingSimulationService } from "./simulation-service.js";

const RUN_ID = "550e8400-e29b-41d4-a716-446655440000";
const CREATED_AT = "2026-07-24T00:00:00.000Z";
const INPUT_END_AT = "2026-07-24T00:05:00.000Z";
const GENERATED_AT = "2026-07-24T00:05:02.000Z";
const TECHNICAL_AT = "2026-07-24T00:05:04.000Z";

type StoredArtifact = {
  runId: string;
  type: ArtifactType;
  content: unknown;
  rowCount?: number;
  dataRevision: string;
};

function model(loaded = true) {
  return {
    model_id: "amazon/chronos-bolt-small",
    model_revision: "revision-a",
    tokenizer_id: null,
    tokenizer_revision: null,
    source_revision: "chronos-forecasting-2.1.0",
    loader_version: "chronos-forecasting-2.1.0",
    license: "Apache-2.0",
    device: loaded ? "cuda" : "unavailable",
    dtype: "float32",
    attention_backend: loaded ? "math" : "unavailable",
    loaded,
  };
}

function forecastSeries(
  symbol: string,
  median: number,
  q10: number,
  q90: number,
  upProbability = 0.7,
) {
  return {
    instrument_key: symbol,
    status: "available",
    input_end_at: INPUT_END_AT,
    horizons: [{
      horizon_minutes: 5,
      target_timestamp: "2026-07-24T00:10:00.000Z",
      return_quantiles: [
        { quantile: 0.05, value: q10 - 0.005 },
        { quantile: 0.1, value: q10 },
        { quantile: 0.25, value: (q10 + median) / 2 },
        { quantile: 0.5, value: median },
        { quantile: 0.75, value: (median + q90) / 2 },
        { quantile: 0.9, value: q90 },
        { quantile: 0.95, value: q90 + 0.005 },
      ],
      up_probability: upProbability,
    }],
  };
}

function forecast(loaded = true) {
  return {
    forecast: {
      schema_version: "scalping-ai/v1",
      request_id: "simulation-forecast",
      mode: "forecast",
      status: loaded ? "available" : "unavailable",
      model: model(loaded),
      generated_at: GENERATED_AT,
      series: [
        forecastSeries("AAA", 0.03, 0.01, 0.05),
        forecastSeries("BBB", 0.025, 0.02, 0.03),
        forecastSeries("CCC", 0.01, 0, 0.02),
      ],
    },
  };
}

function request(symbolCount: 1 | 2 = 1): SimulationStartRequest {
  return {
    marketCountry: "KR",
    criterion: "trading_amount",
    initialCash: 100_000,
    durationMinutes: 60,
    symbolCount,
    preset: "risk_management",
    costs: {
      commissionBpsPerSide: 10,
      taxBpsOnExit: 20,
      spreadBpsRoundTrip: 20,
      slippageBpsPerSide: 10,
    },
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createRun(ownerSubject: string, input: unknown, dataRevision: string): PortfolioRunRecord {
  const now = Date.parse(CREATED_AT);
  return {
    id: RUN_ID,
    kind: "ai_trading_simulation",
    ownerSubject,
    requestHash: "request-hash",
    dataRevision,
    engineVersion: "test-engine",
    status: "queued",
    progress: 0,
    completedCandidates: 0,
    totalCandidates: 0,
    input,
    warnings: [],
    tags: [],
    createdAt: now,
    updatedAt: now,
  };
}

function tradeEvent(executedAt: string, price = 100, symbol = "BBB"): ScalpingLiveEvent {
  return {
    schemaVersion: "scalping-live-event/v1",
    id: Date.parse(executedAt),
    emittedAt: executedAt,
    type: "trade",
    symbol,
    marketCountry: "KR",
    payload: { executedAt, price },
  };
}

function finalBarEvent(
  openTime: string,
  closeTime: string,
  open = 100,
  close = 100,
  symbol = "BBB",
): ScalpingLiveEvent {
  return {
    schemaVersion: "scalping-live-event/v1",
    id: Date.parse(closeTime),
    emittedAt: closeTime,
    type: "bar",
    symbol,
    marketCountry: "KR",
    payload: {
      intervalMinutes: 1,
      state: "final",
      openTime,
      closeTime,
      open,
      high: Math.max(open, close),
      low: Math.min(open, close),
      close,
    },
  };
}

async function eventually<T>(
  read: () => T | Promise<T>,
  predicate: (value: T) => boolean,
  message: string,
): Promise<T> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Timed out waiting for ${message}`);
}

function harness(options: {
  aiAvailable?: boolean;
  artifactFailureAfter?: number;
  artifactGate?: Promise<void>;
  createGate?: Promise<void>;
  now?: () => number;
  releaseFailureCalls?: number[];
} = {}) {
  let currentRun: PortfolioRunRecord | undefined;
  let liveListener: ((event: ScalpingLiveEvent) => void) | undefined;
  const artifacts: StoredArtifact[] = [];
  const events: Array<{ type: string; detail: unknown }> = [];
  let releaseCall = 0;
  const release = vi.fn(() => {
    releaseCall += 1;
    if (options.releaseFailureCalls?.includes(releaseCall)) {
      throw new Error("temporary release failure");
    }
  });
  const removeListener = vi.fn();

  const market = {
    status: vi.fn(() => ({ providers: { ai: { status: options.aiAvailable === false ? "unavailable" : "configured" } } })),
    workspace: vi.fn().mockResolvedValue({
      workspace: {
        candidates: [
          { symbol: "AAA", name: "Alpha", price: 99, filtered: false },
          { symbol: "BBB", name: "Beta", price: 100, filtered: false },
          { symbol: "CCC", name: "Gamma", price: 101, filtered: false },
        ],
      },
    }),
    forecast: vi.fn().mockResolvedValue(forecast(options.aiAvailable !== false)),
    realtimeAnalysis: vi.fn().mockResolvedValue({
      generatedAt: TECHNICAL_AT,
      technical: {
        instruments: [
          { instrument_key: "AAA", signals: { latest: { status: "entry_candidate", calculation_timestamp: TECHNICAL_AT } } },
          { instrument_key: "BBB", signals: { latest: { status: "entry_candidate", calculation_timestamp: TECHNICAL_AT } } },
          { instrument_key: "CCC", signals: { latest: { status: "watch", calculation_timestamp: TECHNICAL_AT } } },
        ],
      },
    }),
  };
  const live = {
    retain: vi.fn().mockResolvedValue(release),
    onEvent: vi.fn((listener: (event: ScalpingLiveEvent) => void) => {
      liveListener = listener;
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
      await options.createGate;
      currentRun = createRun(input.ownerSubject, input.config, input.dataRevision);
      currentRun.totalCandidates = input.totalCandidates ?? 0;
      return currentRun;
    }),
  };
  const repository = {
    markRunning: vi.fn(async (_id: string, now = Date.now()) => {
      if (!currentRun || currentRun.status !== "queued") return false;
      currentRun.status = "running";
      currentRun.startedAt = now;
      currentRun.updatedAt = now;
      return true;
    }),
    addEvent: vi.fn(async (_id: string, type: string, detail: unknown) => {
      events.push({ type, detail: clone(detail) });
    }),
    updateProgress: vi.fn(async (_id: string, update: {
      progress: number;
      completedCandidates?: number;
      totalCandidates?: number;
      currentValidationWindow?: string;
      warnings?: string[];
    }, now = Date.now()) => {
      if (!currentRun) return;
      currentRun.progress = Math.max(0, Math.min(0.99, update.progress));
      if (update.completedCandidates !== undefined) currentRun.completedCandidates = update.completedCandidates;
      if (update.totalCandidates !== undefined) currentRun.totalCandidates = update.totalCandidates;
      if (update.currentValidationWindow !== undefined) currentRun.currentValidationWindow = update.currentValidationWindow;
      if (update.warnings !== undefined) currentRun.warnings = [...update.warnings];
      currentRun.updatedAt = now;
    }),
    get: vi.fn(async (id: string, ownerSubject: string) => (
      currentRun?.id === id && currentRun.ownerSubject === ownerSubject ? currentRun : undefined
    )),
    list: vi.fn(async ({ ownerSubject }: { ownerSubject: string }) => ({
      items: currentRun?.ownerSubject === ownerSubject ? [currentRun] : [],
    })),
    isCancellationRequested: vi.fn().mockResolvedValue(false),
    complete: vi.fn(async (
      _id: string,
      summary: unknown,
      result: unknown,
      warnings: string[],
      now = Date.now(),
    ) => {
      if (!currentRun) return false;
      currentRun.status = "completed";
      currentRun.progress = 1;
      currentRun.summary = clone(summary);
      currentRun.result = clone(result);
      currentRun.warnings = [...warnings];
      currentRun.finishedAt = now;
      currentRun.updatedAt = now;
      return true;
    }),
    cancel: vi.fn(async (
      _id: string,
      summary: unknown,
      warnings: string[],
      now = Date.now(),
    ) => {
      if (!currentRun) return;
      currentRun.status = "cancelled";
      currentRun.summary = clone(summary);
      currentRun.warnings = [...warnings];
      currentRun.finishedAt = now;
      currentRun.updatedAt = now;
    }),
    fail: vi.fn(async (
      _id: string,
      error: unknown,
      warnings: string[],
      now = Date.now(),
    ) => {
      if (!currentRun) return;
      currentRun.status = "failed";
      currentRun.error = clone(error);
      currentRun.warnings = [...warnings];
      currentRun.finishedAt = now;
      currentRun.updatedAt = now;
    }),
  };
  const artifactService = {
    put: vi.fn(async (input: StoredArtifact) => {
      await options.artifactGate;
      if (options.artifactFailureAfter !== undefined
        && artifacts.length >= options.artifactFailureAfter) {
        throw new Error("artifact unavailable");
      }
      artifacts.push({ ...input, content: clone(input.content) });
      return {} as never;
    }),
    get: vi.fn(async (runId: string, type: ArtifactType) => {
      const stored = artifacts.filter((artifact) => (
        artifact.runId === runId && artifact.type === type
      )).at(-1);
      return stored ? {
        descriptor: {} as never,
        content: clone(stored.content),
      } : undefined;
    }),
  };
  const service = new AiTradingSimulationService(
    market,
    live,
    runService as unknown as RunService,
    repository as unknown as RunRepository,
    artifactService as unknown as ArtifactService,
    {
      maximumDurationMinutes: 390,
      decisionIntervalMinutes: 1,
      maximumActiveSessions: 2,
      candidatePoolSize: 3,
      progressUpdateMs: 60_000,
      now: options.now ?? (() => Date.parse(CREATED_AT)),
    },
  );

  return {
    service,
    market,
    live,
    runService,
    repository,
    artifactService,
    artifacts,
    events,
    release,
    removeListener,
    emit(event: ScalpingLiveEvent) {
      if (!liveListener) throw new Error("live listener was not registered");
      liveListener(event);
    },
    run: () => currentRun,
    latestArtifact(type: ArtifactType) {
      return artifacts.filter((artifact) => artifact.type === type).at(-1);
    },
  };
}

async function waitForPhase(
  setup: ReturnType<typeof harness>,
  runId: string,
  phase: string,
) {
  return eventually(
    () => setup.service.get(runId, "owner"),
    (value) => (
      (value as { snapshot?: { phase?: string } } | undefined)?.snapshot?.phase === phase
    ),
    `simulation phase ${phase}`,
  );
}

describe("AI trading simulation service", () => {
  it("advertises paper-only capabilities and exposes no order API", async () => {
    const setup = harness();
    const status = setup.service.status() as {
      capabilities: Record<string, unknown>;
      limitations: string[];
    };
    expect(status.capabilities).toMatchObject({
      realOrder: false,
      orderApiDependency: false,
      mcp: false,
      autonomousPaperTrading: true,
    });
    expect(status.limitations.join(" ")).toContain("실제 주문 API를 호출하지 않는");

    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(setup.service));
    expect(methods).toEqual(expect.arrayContaining(["status", "start", "get", "cancel", "close"]));
    expect(methods.filter((name) => /order/i.test(name))).toEqual([]);
    await setup.service.close("test_complete");
    expect(setup.removeListener).toHaveBeenCalledTimes(1);
  });

  it.each([
    { symbolCount: 1 as const, selected: ["BBB"] },
    { symbolCount: 2 as const, selected: ["BBB", "AAA"] },
  ])("scans then selects exactly $symbolCount symbol(s) and invokes one Rust batch", async ({ symbolCount, selected }) => {
    const setup = harness();
    const started = await setup.service.start(request(symbolCount), "owner");
    const running = await waitForPhase(setup, started.runId, "running") as {
      snapshot: { selected: Array<{ symbol: string }> };
    };

    expect(setup.market.workspace).toHaveBeenCalledTimes(1);
    expect(setup.market.workspace).toHaveBeenCalledWith(expect.objectContaining({
      topCount: 3,
      scanOnly: true,
      marketCountry: "KR",
      includePortfolioContext: false,
    }));
    expect(setup.market.forecast).toHaveBeenCalledTimes(1);
    expect(setup.market.forecast).toHaveBeenCalledWith({
      marketCountry: "KR",
      symbols: ["AAA", "BBB", "CCC"],
      interval: "1m",
    });
    expect(running.snapshot.selected.map(({ symbol }) => symbol)).toEqual(selected);
    expect(setup.live.retain).toHaveBeenCalledWith(["AAA", "BBB", "CCC"], "KR", undefined);
    expect(setup.live.retain).toHaveBeenCalledWith(selected, "KR", undefined);
    expect(setup.market.realtimeAnalysis).toHaveBeenCalledTimes(1);
    expect(setup.market.realtimeAnalysis).toHaveBeenCalledWith({
      marketCountry: "KR",
      symbols: selected,
      interval: "1m",
      preset: "risk_management",
      positionContext: { mode: "isolated", positions: [] },
    });

    await setup.service.cancel(started.runId, "owner");
  });

  it("atomically reserves one active session per owner across concurrent start requests", async () => {
    const setup = harness();
    const first = setup.service.start(request(1), "owner");
    await expect(setup.service.start(request(1), "owner")).rejects.toThrow(
      "이미 진행 중인 AI 시뮬레이션",
    );
    const started = await first;
    await waitForPhase(setup, started.runId, "running");
    expect(setup.runService.create).toHaveBeenCalledTimes(1);
    await setup.service.cancel(started.runId, "owner");
  });

  it("terminalizes a created run when selecting-event persistence fails", async () => {
    const setup = harness();
    setup.repository.addEvent.mockRejectedValueOnce(new Error("event unavailable"));

    await expect(setup.service.start(request(1), "owner")).rejects.toThrow("event unavailable");
    expect(setup.repository.fail).toHaveBeenCalledWith(
      RUN_ID,
      expect.objectContaining({
        code: "AI_SIMULATION_START_FAILED",
        real_order_api_used: false,
      }),
      ["event unavailable"],
      Date.parse(CREATED_AT),
    );
    expect(setup.run()?.status).toBe("failed");
    expect(await setup.service.current("owner")).toMatchObject({
      run: { status: "failed" },
    });
    await setup.service.close("test_complete");
  });

  it("waits for an in-flight owner start before resolving the current run", async () => {
    const createGate = deferred();
    const setup = harness({ createGate: createGate.promise });
    const starting = setup.service.start(request(1), "owner");
    const current = setup.service.current("owner");
    let currentSettled = false;
    void current.finally(() => {
      currentSettled = true;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(currentSettled).toBe(false);

    createGate.resolve();
    const started = await starting;
    const restored = await current;
    expect(restored).toMatchObject({
      run: { runId: started.runId, status: "running" },
    });
    expect(["selecting", "running"]).toContain(
      (restored as { snapshot?: { phase?: string } } | undefined)?.snapshot?.phase,
    );
    await setup.service.cancel(started.runId, "owner");
  });

  it("rejects a same-time fill, then fills whole shares with explicit costs on a later trade", async () => {
    const setup = harness();
    const started = await setup.service.start(request(1), "owner");
    await waitForPhase(setup, started.runId, "running");

    setup.emit(tradeEvent(TECHNICAL_AT));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const unchanged = await setup.service.get(started.runId, "owner") as {
      snapshot: { cash: number; positions: unknown[]; trades: unknown[] };
    };
    expect(unchanged.snapshot).toMatchObject({
      cash: 100_000,
      positions: [],
      trades: [],
    });

    setup.emit(tradeEvent("2026-07-24T00:05:05.000Z"));
    const filled = await eventually(
      () => setup.service.get(started.runId, "owner"),
      (value) => (
        ((value as { snapshot?: { trades?: unknown[] } } | undefined)?.snapshot?.trades?.length ?? 0) === 1
      ),
      "later causal fill",
    ) as {
      snapshot: {
        cash: number;
        totalCosts: number;
        positions: Array<{ symbol: string; quantity: number }>;
        trades: Array<{ quantity: number; grossAmount: number; totalCosts: number; source: string }>;
      };
    };
    const trade = filled.snapshot.trades[0]!;
    expect(trade).toMatchObject({
      quantity: 997,
      grossAmount: 99_700,
      source: "kis_ws_trade",
    });
    expect(Number.isSafeInteger(trade.quantity)).toBe(true);
    expect(trade.totalCosts).toBeCloseTo(299.1);
    expect(filled.snapshot.totalCosts).toBeCloseTo(299.1);
    expect(filled.snapshot.cash).toBeCloseTo(0.9);
    expect(filled.snapshot.positions).toEqual([
      expect.objectContaining({ symbol: "BBB", quantity: 997 }),
    ]);

    await setup.service.cancel(started.runId, "owner");
  });

  it("keeps the shared two-symbol ledger monotonic when executions arrive out of order", async () => {
    const setup = harness();
    const started = await setup.service.start(request(2), "owner");
    await waitForPhase(setup, started.runId, "running");

    setup.emit(tradeEvent("2026-07-24T00:06:00.000Z", 100, "BBB"));
    await eventually(
      () => setup.service.get(started.runId, "owner"),
      (value) => ((value as { snapshot?: { trades?: unknown[] } })?.snapshot?.trades?.length ?? 0) === 1,
      "first ledger fill",
    );
    setup.emit(tradeEvent("2026-07-24T00:05:30.000Z", 100, "AAA"));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const guarded = await setup.service.get(started.runId, "owner") as {
      snapshot: {
        trades: Array<{ symbol: string; executedAt: string }>;
        pendingActions: Array<{ symbol: string }>;
        warnings: string[];
      };
    };
    expect(guarded.snapshot.trades).toEqual([
      expect.objectContaining({ symbol: "BBB", executedAt: "2026-07-24T00:06:00.000Z" }),
    ]);
    expect(guarded.snapshot.pendingActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ symbol: "AAA" }),
    ]));
    expect(guarded.snapshot.warnings).toContain("가상 원장보다 과거에 도착한 체결 이벤트를 무시했습니다.");

    setup.emit(tradeEvent("2026-07-24T00:06:01.000Z", 100, "AAA"));
    const filled = await eventually(
      () => setup.service.get(started.runId, "owner"),
      (value) => ((value as { snapshot?: { trades?: unknown[] } })?.snapshot?.trades?.length ?? 0) === 2,
      "later monotonic fill",
    ) as {
      snapshot: { trades: Array<{ symbol: string; executedAt: string }> };
    };
    expect(filled.snapshot.trades.map(({ executedAt }) => executedAt)).toEqual([
      "2026-07-24T00:06:00.000Z",
      "2026-07-24T00:06:01.000Z",
    ]);
    await setup.service.cancel(started.runId, "owner");
  });

  it("uses the virtual position in the next Rust batch and autonomously sells on a later AI exit", async () => {
    const setup = harness();
    const started = await setup.service.start(request(1), "owner");
    await waitForPhase(setup, started.runId, "running");
    setup.emit(tradeEvent("2026-07-24T00:05:05.000Z", 100));
    await eventually(
      () => setup.service.get(started.runId, "owner"),
      (value) => ((value as { snapshot?: { trades?: unknown[] } })?.snapshot?.trades?.length ?? 0) === 1,
      "initial autonomous buy",
    );

    const exitForecast = forecast(true);
    exitForecast.forecast.generated_at = "2026-07-24T00:07:02.000Z";
    exitForecast.forecast.series = [
      {
        ...forecastSeries("BBB", -0.02, -0.03, -0.01, 0.4),
        input_end_at: "2026-07-24T00:07:00.000Z",
      },
    ];
    setup.market.forecast.mockResolvedValue(exitForecast);
    setup.emit(finalBarEvent(
      "2026-07-24T00:06:00.000Z",
      "2026-07-24T00:07:00.000Z",
      101,
      102,
    ));
    await eventually(
      () => setup.service.get(started.runId, "owner"),
      (value) => (value as {
        snapshot?: { pendingActions?: Array<{ action: string }> };
      })?.snapshot?.pendingActions?.some(({ action }) => action === "sell") === true,
      "autonomous sell decision",
    );
    expect(setup.market.realtimeAnalysis).toHaveBeenLastCalledWith(expect.objectContaining({
      positionContext: {
        mode: "isolated",
        positions: [expect.objectContaining({
          symbol: "BBB",
          quantity: 997,
          asOf: "2026-07-24T00:05:05.000Z",
        })],
      },
    }));
    setup.emit(tradeEvent("2026-07-24T00:07:03.000Z", 103));
    const sold = await eventually(
      () => setup.service.get(started.runId, "owner"),
      (value) => ((value as { snapshot?: { trades?: unknown[] } })?.snapshot?.trades?.length ?? 0) === 2,
      "later autonomous sell fill",
    ) as {
      snapshot: {
        positions: unknown[];
        trades: Array<{ side: string; executedAt: string }>;
        cash: number;
      };
    };
    expect(sold.snapshot.positions).toEqual([]);
    expect(sold.snapshot.trades.map(({ side }) => side)).toEqual(["buy", "sell"]);
    expect(sold.snapshot.trades[1]?.executedAt).toBe("2026-07-24T00:07:03.000Z");
    expect(sold.snapshot.cash).toBeGreaterThan(100_000);
    await setup.service.cancel(started.runId, "owner");
  });

  it("retries analysis with the new virtual-ledger revision when a fill completes mid-refresh", async () => {
    const setup = harness();
    const started = await setup.service.start(request(1), "owner");
    await waitForPhase(setup, started.runId, "running");

    const refreshGate = deferred<ReturnType<typeof forecast>>();
    setup.market.forecast.mockReturnValueOnce(refreshGate.promise);
    setup.emit(finalBarEvent(
      "2026-07-24T00:06:00.000Z",
      "2026-07-24T00:07:00.000Z",
      0,
      100,
    ));
    await eventually(
      () => setup.market.forecast.mock.calls.length,
      (count) => count === 2,
      "blocked refresh forecast",
    );

    setup.emit(tradeEvent("2026-07-24T00:07:03.000Z", 100));
    await eventually(
      () => setup.service.get(started.runId, "owner"),
      (value) => ((value as { snapshot?: { trades?: unknown[] } })?.snapshot?.trades?.length ?? 0) === 1,
      "fill during refresh",
    );
    refreshGate.resolve(forecast(true));
    await eventually(
      () => setup.market.realtimeAnalysis.mock.calls.length,
      (count) => count >= 3,
      "ledger-aware refresh retry",
    );
    expect(setup.market.realtimeAnalysis).toHaveBeenLastCalledWith(expect.objectContaining({
      positionContext: {
        mode: "isolated",
        positions: [expect.objectContaining({
          symbol: "BBB",
          quantity: 997,
          asOf: "2026-07-24T00:07:03.000Z",
        })],
      },
    }));
    await setup.service.cancel(started.runId, "owner");
  });

  it("values a two-symbol fill only with marks observed by its execution time", async () => {
    const setup = harness();
    const started = await setup.service.start(request(2), "owner");
    await waitForPhase(setup, started.runId, "running");
    setup.emit(tradeEvent("2026-07-24T00:05:05.000Z", 100, "BBB"));
    setup.emit(tradeEvent("2026-07-24T00:05:06.000Z", 100, "AAA"));
    await eventually(
      () => setup.service.get(started.runId, "owner"),
      (value) => ((value as { snapshot?: { trades?: unknown[] } })?.snapshot?.trades?.length ?? 0) === 2,
      "two initial positions",
    );

    const mixedForecast = forecast(true);
    mixedForecast.forecast.generated_at = "2026-07-24T00:07:02.000Z";
    mixedForecast.forecast.series = [
      {
        ...forecastSeries("AAA", -0.02, -0.03, -0.01, 0.4),
        input_end_at: "2026-07-24T00:07:00.000Z",
      },
      {
        ...forecastSeries("BBB", 0.02, 0.01, 0.03, 0.7),
        input_end_at: "2026-07-24T00:07:00.000Z",
      },
    ];
    setup.market.forecast.mockResolvedValue(mixedForecast);
    setup.emit(finalBarEvent(
      "2026-07-24T00:06:00.000Z",
      "2026-07-24T00:07:00.000Z",
      100,
      100,
      "AAA",
    ));
    await eventually(
      () => setup.service.get(started.runId, "owner"),
      (value) => (value as {
        snapshot?: { pendingActions?: Array<{ symbol: string; action: string }> };
      })?.snapshot?.pendingActions?.some(({ symbol, action }) => symbol === "AAA" && action === "sell") === true,
      "single-symbol exit decision",
    );

    setup.emit(tradeEvent("2026-07-24T00:09:00.000Z", 200, "BBB"));
    setup.emit(tradeEvent("2026-07-24T00:08:00.000Z", 100, "AAA"));
    const sold = await eventually(
      () => setup.service.get(started.runId, "owner"),
      (value) => ((value as { snapshot?: { trades?: unknown[] } })?.snapshot?.trades?.length ?? 0) === 3,
      "as-of exit fill",
    ) as {
      snapshot: { positions: Array<{ symbol: string; quantity: number }> };
    };
    const held = sold.snapshot.positions.find(({ symbol }) => symbol === "BBB");
    expect(held).toBeDefined();
    const equityPoints = await eventually(
      () => setup.latestArtifact("simulation-equity")?.content as Array<{
        timestamp: string;
        invested: number;
      }> | undefined,
      (points) => points?.at(-1)?.timestamp === "2026-07-24T00:08:00.000Z",
      "execution-time equity artifact",
    );
    expect(equityPoints?.at(-1)?.invested).toBe(held!.quantity * 100);
    expect(equityPoints?.at(-1)?.invested).not.toBe(held!.quantity * 200);
    await setup.service.cancel(started.runId, "owner");
  });

  it("cancels into a terminal snapshot and persists the full simulation artifact set", async () => {
    const setup = harness();
    const started = await setup.service.start(request(1), "owner");
    await waitForPhase(setup, started.runId, "running");
    setup.emit(tradeEvent("2026-07-24T00:06:00.000Z", 100));
    await eventually(
      () => setup.service.get(started.runId, "owner"),
      (value) => (
        ((value as { snapshot?: { trades?: unknown[] } } | undefined)?.snapshot?.trades?.length ?? 0) === 1
      ),
      "filled trade before cancellation",
    );

    const cancelled = await setup.service.cancel(started.runId, "owner") as {
      run: { status: string };
      snapshot: { phase: string; trades: unknown[]; capabilities: Record<string, unknown> };
    };
    expect(cancelled.run.status).toBe("cancelled");
    expect(cancelled.snapshot).toMatchObject({
      phase: "cancelled",
      capabilities: { realOrder: false, mcp: false },
    });
    expect(cancelled.snapshot.trades).toHaveLength(1);
    // The candidate release is attempted immediately and retained in the combined
    // finalizer for an idempotent retry, alongside the selected-symbol release.
    expect(setup.release).toHaveBeenCalledTimes(3);
    expect(setup.repository.cancel).toHaveBeenCalledTimes(1);

    expect(new Set(setup.artifacts.map(({ type }) => type))).toEqual(new Set([
      "simulation-selection",
      "simulation-decisions",
      "simulation-equity",
      "simulation-trades",
      "simulation-diagnostics",
    ]));
    expect(setup.latestArtifact("simulation-trades")?.content).toEqual(cancelled.snapshot.trades);
    expect(setup.latestArtifact("simulation-diagnostics")?.content).toMatchObject({
      phase: "cancelled",
      real_order_api_used: false,
      mcp_exposed: false,
      same_bar_fill_allowed: false,
    });
    expect(setup.run()?.summary).toMatchObject({
      phase: "cancelled",
      trade_count: 1,
      real_order_api_used: false,
      snapshot: { phase: "cancelled" },
    });
  });

  it("terminalizes cancellation even when final artifact persistence fails", async () => {
    const setup = harness({ artifactFailureAfter: 5 });
    const started = await setup.service.start(request(1), "owner");
    await waitForPhase(setup, started.runId, "running");

    const cancelled = await setup.service.cancel(started.runId, "owner") as {
      run: { status: string; warnings: string[] };
      snapshot: { phase: string };
    };
    expect(cancelled.run.status).toBe("cancelled");
    expect(cancelled.snapshot.phase).toBe("cancelled");
    expect(cancelled.run.warnings).toContain("최종 artifact 저장 실패: artifact unavailable");
    expect(setup.repository.cancel).toHaveBeenCalledTimes(1);
    expect(setup.repository.fail).not.toHaveBeenCalled();
  });

  it("retries an idempotent live release before terminalizing the session", async () => {
    const setup = harness({ releaseFailureCalls: [2] });
    const started = await setup.service.start(request(1), "owner");
    await waitForPhase(setup, started.runId, "running");

    const cancelled = await setup.service.cancel(started.runId, "owner") as {
      run: { status: string; warnings: string[] };
    };
    expect(cancelled.run.status).toBe("cancelled");
    expect(cancelled.run.warnings).not.toEqual(expect.arrayContaining([
      expect.stringContaining("실시간 구독 해제 실패"),
    ]));
    expect(setup.release).toHaveBeenCalledTimes(5);
  });

  it("terminalizes a cancellation that races the completed status transition", async () => {
    const setup = harness();
    const started = await setup.service.start(request(1), "owner");
    await waitForPhase(setup, started.runId, "running");
    setup.repository.isCancellationRequested
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    setup.repository.complete.mockResolvedValueOnce(false);
    const session = (setup.service as unknown as {
      active: Map<string, unknown>;
    }).active.get(started.runId);
    expect(session).toBeDefined();

    await (setup.service as unknown as {
      finish(
        value: unknown,
        terminal: "completed",
        reason: string,
      ): Promise<void>;
    }).finish(session, "completed", "기간 종료");

    expect(setup.repository.complete).toHaveBeenCalledTimes(1);
    expect(setup.repository.cancel).toHaveBeenCalledTimes(1);
    expect(setup.run()?.status).toBe("cancelled");
    expect(setup.repository.fail).not.toHaveBeenCalled();
  });

  it("rejects marks and executions beyond the configured session expiry", async () => {
    const setup = harness();
    const started = await setup.service.start(request(1), "owner");
    await waitForPhase(setup, started.runId, "running");
    setup.emit(tradeEvent("2026-07-24T00:05:05.000Z", 100));
    const beforeExpiry = await eventually(
      () => setup.service.get(started.runId, "owner"),
      (value) => ((value as { snapshot?: { trades?: unknown[] } })?.snapshot?.trades?.length ?? 0) === 1,
      "position before expiry",
    ) as {
      snapshot: {
        cash: number;
        equity: number;
        positions: Array<{ marketPrice: number; markObservedAt: string }>;
        trades: unknown[];
      };
    };
    setup.emit(tradeEvent("2026-07-24T01:00:00.001Z"));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const result = await setup.service.get(started.runId, "owner") as {
      snapshot: {
        trades: unknown[];
        cash: number;
        equity: number;
        positions: Array<{ marketPrice: number; markObservedAt: string }>;
      };
    };
    expect(result.snapshot.trades).toHaveLength(1);
    expect(result.snapshot.cash).toBe(beforeExpiry.snapshot.cash);
    expect(result.snapshot.equity).toBe(beforeExpiry.snapshot.equity);
    expect(result.snapshot.positions[0]).toMatchObject({
      marketPrice: 100,
      markObservedAt: "2026-07-24T00:05:05.000Z",
    });
    await setup.service.cancel(started.runId, "owner");
  });

  it("uses the remaining wall-clock duration after delayed initial artifact persistence", async () => {
    let now = Date.parse(CREATED_AT);
    const artifactGate = deferred();
    const setup = harness({ artifactGate: artifactGate.promise, now: () => now });
    const started = await setup.service.start(request(1), "owner");
    await waitForPhase(setup, started.runId, "running");
    now += 60 * 60_000 + 1;
    artifactGate.resolve();

    await eventually(
      setup.run,
      (run) => run?.status === "completed",
      "zero-remaining-duration completion",
    );
    expect(setup.run()?.summary).toMatchObject({
      phase: "completed",
      trade_count: 0,
    });
  });

  it("restores the owner's current simulation after a page reload", async () => {
    const setup = harness();
    const started = await setup.service.start(request(1), "owner");
    await waitForPhase(setup, started.runId, "running");
    const current = await setup.service.current("owner") as {
      run: { runId: string; status: string };
      snapshot: { phase: string };
    };
    expect(current.run).toMatchObject({ runId: RUN_ID, status: "running" });
    expect(current.snapshot.phase).toBe("running");
    await setup.service.cancel(started.runId, "owner");
    expect(await setup.service.current("owner")).toMatchObject({
      run: { runId: RUN_ID, status: "cancelled" },
      snapshot: { phase: "cancelled" },
    });
  });

  it("overlays a recovered failed run status on its last running checkpoint", async () => {
    const setup = harness();
    const started = await setup.service.start(request(1), "owner");
    await waitForPhase(setup, started.runId, "running");
    await eventually(
      () => setup.latestArtifact("simulation-diagnostics"),
      (artifact) => artifact !== undefined,
      "running checkpoint artifact",
    );
    const internals = setup.service as unknown as {
      active: Map<string, unknown>;
    };
    const session = internals.active.get(started.runId);
    internals.active.delete(started.runId);
    const stored = setup.run()!;
    stored.status = "failed";
    stored.error = { code: "STALE_RUN_RECOVERED", message: "서버 재시작으로 실행이 중단되었습니다." };
    stored.warnings = ["중단 전 저장된 artifact는 보존되었습니다."];

    const recovered = await setup.service.current("owner") as {
      run: { status: string };
      snapshot: {
        phase: string;
        progress: number;
        pendingActions: unknown[];
        warnings: string[];
      };
    };
    expect(recovered.run.status).toBe("failed");
    expect(recovered.snapshot).toMatchObject({
      phase: "failed",
      progress: 1,
      pendingActions: [],
    });
    expect(recovered.snapshot.warnings).toEqual(expect.arrayContaining([
      "중단 전 저장된 artifact는 보존되었습니다.",
      "서버 재시작으로 실행이 중단되었습니다.",
    ]));

    if (session) internals.active.set(started.runId, session);
    await setup.service.close("test_complete");
  });

  it("fails closed when AI is unavailable without fabricating trades or changing cash", async () => {
    const setup = harness({ aiAvailable: false });
    const started = await setup.service.start(request(1), "owner");
    await eventually(
      setup.run,
      (run) => run?.status === "failed",
      "failed AI-unavailable run",
    );

    expect(setup.live.retain).toHaveBeenCalledTimes(1);
    expect(setup.release).toHaveBeenCalledTimes(1);
    expect(setup.market.realtimeAnalysis).not.toHaveBeenCalled();
    expect(setup.repository.fail).toHaveBeenCalledWith(
      RUN_ID,
      expect.objectContaining({
        code: "AI_SIMULATION_FAILED",
        real_order_api_used: false,
      }),
      expect.arrayContaining([expect.stringContaining("AI 종목 선정이 unavailable")]),
      Date.parse(CREATED_AT),
    );
    expect(setup.latestArtifact("simulation-trades")?.content).toEqual([]);
    expect(setup.latestArtifact("simulation-equity")?.content).toEqual([
      { timestamp: CREATED_AT, equity: 100_000, cash: 100_000, invested: 0 },
    ]);
    expect(setup.latestArtifact("simulation-diagnostics")?.content).toMatchObject({
      phase: "failed",
      real_order_api_used: false,
      order_api_dependency: false,
    });
    expect(setup.repository.complete).not.toHaveBeenCalled();
    expect(setup.repository.cancel).not.toHaveBeenCalled();
    await setup.service.close("test_complete");
  });

  it("fails closed when the AI response includes a higher-scored symbol outside the scanner candidates", async () => {
    const setup = harness();
    const forged = forecast(true);
    forged.forecast.series.unshift(forecastSeries("ZZZ", 0.5, 0.4, 0.6, 0.99));
    setup.market.forecast.mockResolvedValue(forged);
    await setup.service.start(request(1), "owner");
    await eventually(
      setup.run,
      (run) => run?.status === "failed",
      "failed out-of-universe selection",
    );
    expect(setup.live.retain).toHaveBeenCalledTimes(1);
    expect(setup.release).toHaveBeenCalledTimes(1);
    expect(setup.run()?.warnings).toContain("AI 종목 선정 결과가 요청한 스캔 후보 집합을 벗어났습니다.");
  });
});
