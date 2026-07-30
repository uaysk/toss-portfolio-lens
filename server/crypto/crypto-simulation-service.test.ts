import { describe, expect, it, vi } from "vitest";
import type { ArtifactType } from "../repositories/artifact-repository.js";
import type {
  PortfolioRunListInput,
  PortfolioRunRecord,
  PortfolioRunStatus,
  RunRepository,
} from "../repositories/run-repository.js";
import type { ArtifactService } from "../services/artifact-service.js";
import type { RunService, RunTaskContext } from "../services/run-service.js";
import type { SimulationRouterService } from "../simulation/router.js";
import {
  createSimulationStartRequestSchema,
  type SimulationStartRequest,
} from "../simulation/contracts.js";
import type { BinanceUsdmScanner } from "./binance-scanner.js";
import type { BinanceScannerCandidate, BinanceScannerSnapshot } from "./contracts.js";
import {
  CryptoSimulationCoordinator,
  SimulationServiceMultiplexer,
  type CryptoSimulationRuntime,
  type CryptoWorkerPublicState,
} from "./crypto-simulation-service.js";
import type { FuturesExecution } from "./execution.js";

const NOW = Date.parse("2026-07-25T00:00:00.000Z");
const SNAPSHOT_ID = "a".repeat(64);

const selected: BinanceScannerCandidate = {
  rank: 1,
  symbol: "BTCUSDT",
  price: 100_000,
  volume: 10_000,
  quoteVolume: 1_000_000_000,
  relativeVolume: 2,
  spreadBps: 2,
  realizedVolatility60m: 0.005,
  priceChangePercent24h: 3,
  atrPercent14: 0.004,
  volatilityScore: 1,
  score: 1,
  scoreComponents: {
    tradingAmount: 1,
    volume: 1,
    relativeVolume: 1,
    realizedVolatility60m: 1,
    priceChange24h: 1,
    atrPercent14: 1,
  },
  dataQuality: {
    status: "available",
    finalBars: 1_024,
    missingFields: [],
    reasons: [],
    observedAt: new Date(NOW).toISOString(),
  },
};

const secondSelected: BinanceScannerCandidate = {
  ...selected,
  rank: 2,
  symbol: "ETHUSDT",
  price: 3_500,
  quoteVolume: 750_000_000,
  volatilityScore: 0.9,
  score: 0.9,
};

const scannerSnapshot: BinanceScannerSnapshot = {
  schemaVersion: "binance-usdm-scanner/v1",
  market: {
    kind: "crypto_futures",
    venue: "BINANCE_USDM",
    quoteAsset: "USDT",
    contractType: "PERPETUAL",
  },
  scannerSnapshotId: SNAPSHOT_ID,
  snapshotId: SNAPSHOT_ID,
  generatedAt: new Date(NOW).toISOString(),
  expiresAt: new Date(NOW + 60_000).toISOString(),
  criterion: "volatility",
  candidates: [selected],
  evidence: {
    exchangeInfoObservedAt: new Date(NOW).toISOString(),
    universeSize: 1,
    liquidityPoolSize: 1,
    spreadQualifiedSize: 1,
    requirements: {
      status: "TRADING",
      contractType: "PERPETUAL",
      quoteAsset: "USDT",
      marginAsset: "USDT",
      minimumListingAgeDays: 7,
      liquidityPoolSize: 50,
      maximumSpreadBps: 10,
    },
    volatilityWeights: {
      realized60m: 0.5,
      change24h: 0.3,
      atr14: 0.2,
    },
  },
};

const twoSymbolScannerSnapshot: BinanceScannerSnapshot = {
  ...scannerSnapshot,
  candidates: [selected, secondSelected],
  evidence: {
    ...scannerSnapshot.evidence,
    universeSize: 2,
    liquidityPoolSize: 2,
    spreadQualifiedSize: 2,
  },
};

function request(): SimulationStartRequest {
  return createSimulationStartRequestSchema({ maxDurationMinutes: 390 }).parse({
    market: {
      kind: "crypto_futures",
      venue: "BINANCE_USDM",
      quoteAsset: "USDT",
      contractType: "PERPETUAL",
    },
    initialCash: 10_000,
    durationMinutes: 120,
    selection: { mode: "auto", criterion: "volatility", symbolCount: 1 },
    modelLanes: ["kronos_base", "fincast"],
    execution: { mode: "paper" },
  });
}

function requestForSelection(selection: unknown): SimulationStartRequest {
  return createSimulationStartRequestSchema({ maxDurationMinutes: 390 }).parse({
    market: {
      kind: "crypto_futures",
      venue: "BINANCE_USDM",
      quoteAsset: "USDT",
      contractType: "PERPETUAL",
    },
    initialCash: 10_000,
    durationMinutes: 120,
    selection,
    modelLanes: ["kronos_base", "fincast"],
    execution: { mode: "paper" },
  });
}

type StoredArtifact = {
  type: ArtifactType;
  content: unknown;
  rowCount?: number;
  dataRevision: string;
};

class FakeRunRepository {
  readonly runs = new Map<string, PortfolioRunRecord>();
  readonly events: Array<{ runId: string; type: string; detail: unknown }> = [];
  readonly markRunning = vi.fn(async (id: string) => {
    const run = this.runs.get(id);
    if (!run || run.status !== "queued") return false;
    run.status = "running";
    run.startedAt = NOW + 1;
    return true;
  });
  readonly addEvent = vi.fn(async (runId: string, type: string, detail: unknown) => {
    this.events.push({ runId, type, detail });
  });
  readonly updateProgress = vi.fn(async (
    id: string,
    input: {
      progress: number;
      completedCandidates?: number;
      totalCandidates?: number;
      currentValidationWindow?: string;
      warnings?: string[];
    },
  ) => {
    const run = this.runs.get(id);
    if (!run) return;
    run.progress = Math.min(0.99, input.progress);
    if (input.completedCandidates !== undefined) {
      run.completedCandidates = input.completedCandidates;
    }
    if (input.totalCandidates !== undefined) run.totalCandidates = input.totalCandidates;
    run.currentValidationWindow = input.currentValidationWindow;
    if (input.warnings) run.warnings = input.warnings;
  });

  private nextId = 1;

  admit(
    ownerSubject: string,
    config: unknown,
    dataRevision: string,
    totalCandidates = 1,
  ): PortfolioRunRecord {
    const id = `crypto-run-${this.nextId++}`;
    const run: PortfolioRunRecord = {
      id,
      kind: "ai_trading_simulation",
      ownerSubject,
      requestHash: `hash-${id}`,
      dataRevision,
      engineVersion: "test",
      status: "queued",
      progress: 0,
      completedCandidates: 0,
      totalCandidates,
      input: structuredClone(config),
      warnings: [],
      tags: [],
      createdAt: NOW,
      updatedAt: NOW,
    };
    this.runs.set(id, run);
    return run;
  }

  async get(id: string, ownerSubject: string): Promise<PortfolioRunRecord | undefined> {
    const run = this.runs.get(id);
    return run?.ownerSubject === ownerSubject ? run : undefined;
  }

  async list(input: PortfolioRunListInput) {
    const statuses = new Set(input.statuses ?? []);
    const items = [...this.runs.values()].filter((run) => (
      run.ownerSubject === input.ownerSubject
      && (!statuses.size || statuses.has(run.status))
    ));
    return { items: items.slice(0, input.limit ?? 20) };
  }

  async isCancellationRequested(id: string): Promise<boolean> {
    return this.runs.get(id)?.status === "cancel_requested";
  }

  async requestCancellation(id: string, ownerSubject: string): Promise<boolean> {
    const run = await this.get(id, ownerSubject);
    if (!run || (run.status !== "queued" && run.status !== "running")) return false;
    run.status = "cancel_requested";
    return true;
  }

  async complete(
    id: string,
    summary: unknown,
    result: unknown,
    warnings: string[] = [],
  ): Promise<boolean> {
    const run = this.runs.get(id);
    if (!run || (run.status !== "queued" && run.status !== "running")) return false;
    run.status = "completed";
    run.progress = 1;
    run.summary = summary;
    run.result = result;
    run.warnings = warnings;
    run.finishedAt = NOW + 10;
    return true;
  }

  async cancel(id: string, summary: unknown, warnings: string[] = []): Promise<void> {
    const run = this.runs.get(id);
    if (!run || !["queued", "running", "cancel_requested"].includes(run.status)) return;
    run.status = "cancelled";
    run.summary = summary;
    run.warnings = warnings;
    run.finishedAt = NOW + 10;
  }

  async fail(id: string, error: unknown, warnings: string[] = []): Promise<void> {
    const run = this.runs.get(id);
    if (!run || !["queued", "running", "cancel_requested"].includes(run.status)) return;
    run.status = "failed";
    run.error = error;
    run.warnings = warnings;
    run.finishedAt = NOW + 10;
  }
}

class FakeArtifacts {
  readonly values = new Map<string, Map<ArtifactType, StoredArtifact>>();
  readonly put = vi.fn(async (input: {
    runId: string;
    type: ArtifactType;
    content: unknown;
    rowCount?: number;
    dataRevision: string;
  }) => {
    const byType = this.values.get(input.runId) ?? new Map();
    byType.set(input.type, {
      type: input.type,
      content: input.content,
      rowCount: input.rowCount,
      dataRevision: input.dataRevision,
    });
    this.values.set(input.runId, byType);
    return {
      id: `${input.runId}:${input.type}`,
      runId: input.runId,
      type: input.type,
      uri: `test://${input.runId}/${input.type}`,
      format: "application/json" as const,
      rowCount: input.rowCount ?? 1,
      byteCount: 1,
      checksum: "checksum",
      generatedAt: new Date(NOW).toISOString(),
      schemaVersion: "test",
      dataRevision: input.dataRevision,
    };
  });

  async list(runId: string) {
    return [...(this.values.get(runId)?.values() ?? [])].map((item) => ({
      id: `${runId}:${item.type}`,
      runId,
      type: item.type,
      uri: `test://${runId}/${item.type}`,
      format: "application/json" as const,
      rowCount: item.rowCount ?? 1,
      byteCount: 1,
      checksum: "checksum",
      generatedAt: new Date(NOW).toISOString(),
      schemaVersion: "test",
      dataRevision: item.dataRevision,
    }));
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function eventually(
  predicate: () => boolean,
  message = "condition did not settle",
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(message);
}

function abortingRuntime(): CryptoSimulationRuntime {
  return {
    run: vi.fn(async ({ context }: { context: RunTaskContext }) => (
      new Promise<Awaited<ReturnType<CryptoSimulationRuntime["run"]>>>((_, reject) => {
        if (context.signal.aborted) {
          reject(context.signal.reason);
          return;
        }
        context.signal.addEventListener(
          "abort",
          () => reject(context.signal.reason),
          { once: true },
        );
      })
    )),
  };
}

function harness(input: {
  runtime: CryptoSimulationRuntime;
  maximumActiveSessions?: number;
  scannerSelection?: Promise<{ snapshot: BinanceScannerSnapshot; selected: BinanceScannerCandidate }>;
  workers?: () => Partial<Record<"kronos_base" | "fincast", CryptoWorkerPublicState>>;
  maintenanceMarginState?: () => {
    configured: boolean;
    ready: boolean;
    state: "not_ready" | "ready" | "unavailable";
  };
  prepareRiskData?: (symbol: string, requiredMaximumNotional: number) => Promise<void>;
}) {
  const repository = new FakeRunRepository();
  const artifacts = new FakeArtifacts();
  const scannerSelection = input.scannerSelection
    ?? Promise.resolve({ snapshot: scannerSnapshot, selected });
  const scanner = {
    selectionSnapshot: vi.fn(() => scannerSelection),
    candidates: vi.fn().mockResolvedValue(scannerSnapshot),
  };
  const runService = {
    create: vi.fn(async (createInput: {
      ownerSubject: string;
      config: unknown;
      dataRevision: string;
      totalCandidates?: number;
    }) => repository.admit(
      createInput.ownerSubject,
      createInput.config,
      createInput.dataRevision,
      createInput.totalCandidates,
    )),
  };
  const execution: FuturesExecution = {
    mode: "paper",
    status: () => ({
      mode: "paper",
      realOrder: false,
      credentialsConfigured: false,
      signedReadSucceeded: false,
      gate: "open",
      blockers: [],
    }),
    submit: vi.fn(),
    reconcileUnknown: vi.fn(),
  };
  const runtimeSnapshots = new Map<string, unknown>();
  const coordinator = new CryptoSimulationCoordinator({
    scanner: scanner as unknown as BinanceUsdmScanner,
    execution,
    runService: runService as unknown as RunService,
    repository: repository as unknown as RunRepository,
    artifacts: artifacts as unknown as ArtifactService,
    runtime: input.runtime,
    runtimeSnapshots,
    ...(input.maximumActiveSessions !== undefined
      ? { maximumActiveSessions: input.maximumActiveSessions }
      : {}),
    credentials: { configured: true, signedReadSucceeded: true },
    maintenanceMarginState: input.maintenanceMarginState,
    prepareRiskData: input.prepareRiskData,
    workerState: input.workers,
  });
  return {
    coordinator,
    repository,
    artifacts,
    scanner,
    runService,
    runtimeSnapshots,
  };
}

describe("CryptoSimulationCoordinator lifecycle", () => {
  it("defaults to one active crypto session when no override is supplied", async () => {
    const test = harness({ runtime: abortingRuntime() });
    const first = await test.coordinator.start(request(), "owner-a") as {
      run: PortfolioRunRecord;
    };

    await expect(test.coordinator.start(request(), "owner-b")).rejects.toThrow(
      "session limit",
    );

    await test.coordinator.cancel(first.run.id, "owner-a");
    await eventually(() => test.coordinator.status().activeSessions === 0);
  });

  it("retries signed maintenance-margin preflight before creating a run", async () => {
    const runtime: CryptoSimulationRuntime = {
      run: vi.fn(),
    };
    const test = harness({
      runtime,
      maintenanceMarginState: () => ({
        configured: true,
        ready: false,
        state: "unavailable",
      }),
      prepareRiskData: vi.fn().mockRejectedValue(
        new Error("signed bracket refresh unavailable"),
      ),
    });

    expect(test.coordinator.status()).toMatchObject({
      capabilities: { paper: true, autonomousPaperTrading: true },
      executionGates: { paper: true },
      maintenanceMargin: {
        configured: true,
        ready: false,
        state: "unavailable",
      },
    });
    await expect(test.coordinator.start(request(), "owner-a")).rejects.toThrow(
      "signed bracket refresh unavailable",
    );
    expect(test.scanner.selectionSnapshot).toHaveBeenCalledTimes(1);
    expect(test.repository.runs.size).toBe(0);
    expect(test.runService.create).not.toHaveBeenCalled();
  });

  it("recovers a transient bracket failure through a later explicit preflight", async () => {
    const runtime: CryptoSimulationRuntime = {
      run: vi.fn().mockResolvedValue({ summary: {}, result: {} }),
    };
    const prepareRiskData = vi.fn()
      .mockRejectedValueOnce(new Error("temporary bracket failure"))
      .mockResolvedValueOnce(undefined);
    const test = harness({
      runtime,
      maintenanceMarginState: () => ({
        configured: true,
        ready: false,
        state: "unavailable",
      }),
      prepareRiskData,
    });

    await expect(test.coordinator.start(request(), "owner-a")).rejects.toThrow(
      "temporary bracket failure",
    );
    const started = await test.coordinator.start(request(), "owner-a") as {
      run: PortfolioRunRecord;
    };
    expect(started.run.status).toBe("running");
    expect(prepareRiskData).toHaveBeenNthCalledWith(1, "BTCUSDT", 30_000);
    expect(prepareRiskData).toHaveBeenNthCalledWith(2, "BTCUSDT", 30_000);
    expect(test.repository.runs.size).toBe(1);
  });

  it.each([
    {
      mode: "auto",
      selection: { mode: "auto", criterion: "volatility", symbolCount: 2 },
      expectedSelected: [selected, secondSelected],
    },
    {
      mode: "manual",
      selection: { mode: "manual", symbols: ["ETHUSDT", "BTCUSDT"] },
      expectedSelected: [secondSelected, selected],
    },
  ])(
    "uses one scanner snapshot and per-symbol bracket preflight for a two-symbol $mode run",
    async ({ selection, expectedSelected }) => {
      const runtime: CryptoSimulationRuntime = {
        run: vi.fn().mockResolvedValue({ summary: {}, result: {} }),
      };
      const prepareRiskData = vi.fn().mockResolvedValue(undefined);
      const test = harness({
        runtime,
        scannerSelection: Promise.resolve({
          snapshot: twoSymbolScannerSnapshot,
          selected,
        }),
        prepareRiskData,
      });
      const parsedRequest = requestForSelection(selection);
      const started = await test.coordinator.start(parsedRequest, "owner-a") as {
        run: PortfolioRunRecord;
        snapshot: {
          selectedSymbols: string[];
          selected: BinanceScannerCandidate[];
        };
      };
      const expectedSymbols = expectedSelected.map((candidate) => candidate.symbol);

      expect(test.scanner.selectionSnapshot).toHaveBeenCalledTimes(1);
      expect(test.scanner.selectionSnapshot).toHaveBeenCalledWith("volatility");
      expect(prepareRiskData.mock.calls).toEqual(
        expectedSymbols.map((symbol) => [symbol, 15_000]),
      );
      expect(started.run.totalCandidates).toBe(2);
      expect(started.snapshot).toMatchObject({
        selectedSymbols: expectedSymbols,
        selected: expectedSelected,
      });
      expect(test.repository.runs.get(started.run.id)?.input).toMatchObject({
        scannerSnapshotId: SNAPSHOT_ID,
        selectedSymbols: expectedSymbols,
      });

      await eventually(() => vi.mocked(runtime.run).mock.calls.length === 1);
      expect(vi.mocked(runtime.run).mock.calls[0]?.[0]).toMatchObject({
        request: parsedRequest,
        snapshot: twoSymbolScannerSnapshot,
        selected: expectedSelected,
      });
      await eventually(() => test.artifacts.values.get(started.run.id)
        ?.has("simulation-selection") === true);
      expect(test.artifacts.values.get(started.run.id)?.get("simulation-selection"))
        .toMatchObject({
          rowCount: 2,
          content: {
            scannerSnapshotId: SNAPSHOT_ID,
            selected: expectedSelected,
            rankedCandidates: twoSymbolScannerSnapshot.candidates,
          },
        });
    },
  );

  it("persists create → running → complete, artifacts/report, ownership, progress, and status gates", async () => {
    const completion = deferred<Awaited<ReturnType<CryptoSimulationRuntime["run"]>>>();
    let workerState: Partial<Record<"kronos_base" | "fincast", CryptoWorkerPublicState>> = {
      kronos_base: { status: "healthy", precision: "fp32" },
      fincast: { status: "memory_pressure", precision: "fp16" },
    };
    const runtime: CryptoSimulationRuntime = {
      run: vi.fn(async ({ context }) => {
        await context.updateProgress(0.4, {
          completedCandidates: 0,
          totalCandidates: 1,
          currentValidationWindow: "shadow:BTCUSDT",
        });
        return completion.promise;
      }),
    };
    const test = harness({ runtime, workers: () => workerState });
    const initialStatus = test.coordinator.status();
    expect(initialStatus).toMatchObject({
      credentials: { configured: true, signedReadSucceeded: true },
      executionGates: { paper: true, testnet: false, live: false, realOrder: false },
      workers: {
        kronos_base: { status: "healthy", precision: "fp32" },
        fincast: { status: "memory_pressure", precision: "fp16" },
      },
      capabilities: { paper: true, realOrder: false },
    });

    const started = await test.coordinator.start(request(), "owner-a") as {
      run: PortfolioRunRecord;
    };
    expect(started.run.status).toBe("running");
    expect(test.repository.runs.get(started.run.id)?.status).toBe("running");
    expect(test.coordinator.status().activeSessions).toBe(1);
    await eventually(() => test.artifacts.values.get(started.run.id)
      ?.has("simulation-selection") === true);
    expect(test.artifacts.values.get(started.run.id)?.get("simulation-selection"))
      .toMatchObject({
        rowCount: 1,
        content: {
          scannerSnapshotId: SNAPSHOT_ID,
          selected: [selected],
          rankedCandidates: scannerSnapshot.candidates,
          evidence: scannerSnapshot.evidence,
          realOrder: false,
        },
      });
    expect(test.repository.runs.get(started.run.id)).toMatchObject({
      progress: 0.4,
      currentValidationWindow: "shadow:BTCUSDT",
    });

    completion.resolve({
      summary: { phase: "completed", snapshot: { phase: "completed", equity: 10_050 } },
      result: {
        snapshot: { phase: "completed", equity: 10_050 },
        report: { performance: { finalEquity: 10_050 }, comparison: "inconclusive" },
      },
      warnings: ["inconclusive"],
      artifacts: [{
        type: "simulation-trades",
        content: [{ id: "trade-1" }],
        rowCount: 1,
      }],
    });
    await eventually(
      () => test.repository.runs.get(started.run.id)?.status === "completed",
    );
    expect(test.coordinator.status().activeSessions).toBe(0);
    expect(await test.coordinator.owns(started.run.id, "owner-a")).toBe(true);
    expect(await test.coordinator.owns(started.run.id, "owner-b")).toBe(false);
    expect(await test.coordinator.get(started.run.id, "owner-b")).toBeUndefined();
    expect(test.artifacts.values.get(started.run.id)?.has("simulation-selection")).toBe(true);
    expect(test.artifacts.values.get(started.run.id)?.has("simulation-trades")).toBe(true);
    const report = await test.coordinator.report(started.run.id, "owner-a") as unknown as {
      performance: { finalEquity: number };
      artifacts: Array<{ type: ArtifactType }>;
      snapshot: { phase: string };
    };
    expect(report.performance.finalEquity).toBe(10_050);
    expect(report.snapshot.phase).toBe("completed");
    expect(report.artifacts.map(({ type }) => type)).toEqual([
      "simulation-selection",
      "simulation-trades",
    ]);

    workerState = {
      kronos_base: { status: "degraded", precision: "fp32" },
    };
    expect(test.coordinator.status().workers).toMatchObject({
      kronos_base: { status: "degraded" },
      fincast: { status: "unavailable", precision: "unknown" },
    });
  });

  it("fails with persisted selection and diagnostics when the runtime fails", async () => {
    const failureSnapshot = { phase: "failed", warnings: ["stream_desync"] };
    const runtime: CryptoSimulationRuntime = {
      run: vi.fn().mockRejectedValue(Object.assign(
        new Error("Binance public stream desynchronized."),
        { code: "stream_desync", snapshot: failureSnapshot },
      )),
    };
    const test = harness({ runtime });
    const started = await test.coordinator.start(request(), "owner-a") as {
      run: PortfolioRunRecord;
    };
    await eventually(() => test.repository.runs.get(started.run.id)?.status === "failed");
    expect(test.repository.runs.get(started.run.id)?.error).toMatchObject({
      code: "CRYPTO_STREAM_DESYNC",
      retryable: true,
      realOrderApiUsed: false,
    });
    expect(test.artifacts.values.get(started.run.id)?.get("simulation-selection"))
      .toBeDefined();
    expect(test.artifacts.values.get(started.run.id)?.get("simulation-diagnostics")?.content)
      .toMatchObject({
        snapshot: failureSnapshot,
        failure: { code: "CRYPTO_STREAM_DESYNC" },
        realOrder: false,
      });
    const report = await test.coordinator.report(started.run.id, "owner-a") as {
      artifacts: Array<{ type: ArtifactType }>;
    };
    expect(report.artifacts.map(({ type }) => type)).toEqual([
      "simulation-selection",
      "simulation-diagnostics",
    ]);
  });

  it("persists terminal artifacts but fails instead of completing an unsettled run", async () => {
    const terminalDiagnostics = {
      settlementComplete: false,
      terminalSettlement: {
        status: "unsettled_fail_closed",
        lanes: [{ lane: "kronos_base", status: "unsettled_fail_closed" }],
      },
    };
    const runtime: CryptoSimulationRuntime = {
      run: vi.fn().mockResolvedValue({
        summary: { phase: "failed", settlementComplete: false },
        result: { snapshot: { phase: "failed", settlementComplete: false } },
        warnings: ["terminal_settlement_unavailable"],
        terminalFailure: {
          code: "CRYPTO_TERMINAL_SETTLEMENT_INCOMPLETE",
          message: "Terminal settlement failed closed.",
          retryable: true,
        },
        artifacts: [
          {
            type: "simulation-trades",
            content: { settlementComplete: false, positions: [{ symbol: "BTCUSDT" }] },
            rowCount: 1,
          },
          {
            type: "simulation-diagnostics",
            content: terminalDiagnostics,
            rowCount: 1,
          },
        ],
      }),
    };
    const test = harness({ runtime });
    const started = await test.coordinator.start(request(), "owner-a") as {
      run: PortfolioRunRecord;
    };

    await eventually(() => test.repository.runs.get(started.run.id)?.status === "failed");
    expect(test.repository.runs.get(started.run.id)).toMatchObject({
      status: "failed",
      error: {
        code: "CRYPTO_TERMINAL_SETTLEMENT_INCOMPLETE",
        message: "Terminal settlement failed closed.",
        retryable: true,
        realOrderApiUsed: false,
      },
      warnings: ["terminal_settlement_unavailable"],
    });
    expect(test.repository.runs.get(started.run.id)?.summary).toBeUndefined();
    expect(test.artifacts.values.get(started.run.id)?.get("simulation-trades")).toBeDefined();
    expect(
      test.artifacts.values.get(started.run.id)?.get("simulation-diagnostics")?.content,
    ).toEqual(terminalDiagnostics);
    const report = await test.coordinator.report(started.run.id, "owner-a") as {
      artifacts: Array<{ type: ArtifactType }>;
    };
    expect(report.artifacts.map(({ type }) => type)).toEqual([
      "simulation-selection",
      "simulation-trades",
      "simulation-diagnostics",
    ]);
  });

  it("enforces owner and global active limits, cancels causally, and frees slots", async () => {
    const runtime = abortingRuntime();
    const test = harness({ runtime, maximumActiveSessions: 2 });
    const first = await test.coordinator.start(request(), "owner-a") as {
      run: PortfolioRunRecord;
    };
    await expect(test.coordinator.start(request(), "owner-a")).rejects.toThrow(
      "already active for this owner",
    );
    const second = await test.coordinator.start(request(), "owner-b") as {
      run: PortfolioRunRecord;
    };
    await expect(test.coordinator.start(request(), "owner-c")).rejects.toThrow(
      "session limit",
    );
    expect(await test.coordinator.cancel(first.run.id, "owner-b")).toBeUndefined();
    expect(test.repository.runs.get(first.run.id)?.status).toBe("running");

    await test.coordinator.cancel(first.run.id, "owner-a");
    await eventually(() => test.repository.runs.get(first.run.id)?.status === "cancelled");
    expect(test.artifacts.values.get(first.run.id)?.has("simulation-selection")).toBe(true);
    expect(test.repository.runs.get(first.run.id)?.summary).toMatchObject({
      phase: "cancelled",
      realOrderApiUsed: false,
    });
    const third = await test.coordinator.start(request(), "owner-c") as {
      run: PortfolioRunRecord;
    };
    expect(third.run.status).toBe("running");
    await test.coordinator.cancel(second.run.id, "owner-b");
    await test.coordinator.cancel(third.run.id, "owner-c");
    await eventually(() => test.coordinator.status().activeSessions === 0);
  });

  it("aborts active sessions as failed on close and rejects admission after shutdown", async () => {
    const test = harness({ runtime: abortingRuntime(), maximumActiveSessions: 2 });
    const first = await test.coordinator.start(request(), "owner-a") as {
      run: PortfolioRunRecord;
    };
    const second = await test.coordinator.start(request(), "owner-b") as {
      run: PortfolioRunRecord;
    };
    await test.coordinator.close("SIGTERM");
    for (const runId of [first.run.id, second.run.id]) {
      expect(test.repository.runs.get(runId)).toMatchObject({
        status: "failed",
        error: {
          code: "CRYPTO_SIMULATION_SERVER_SHUTDOWN",
          realOrderApiUsed: false,
        },
      });
      expect(test.artifacts.values.get(runId)?.has("simulation-selection")).toBe(true);
    }
    expect(test.coordinator.status().activeSessions).toBe(0);
    await expect(test.coordinator.start(request(), "owner-c")).rejects.toThrow(
      "coordinator is closed",
    );
    await expect(test.coordinator.close("SIGINT")).resolves.toBeUndefined();
  });

  it("does not admit a run after close wins a scanner wait and terminalizes markRunning failure", async () => {
    const scan = deferred<{
      snapshot: BinanceScannerSnapshot;
      selected: BinanceScannerCandidate;
    }>();
    const closing = harness({
      runtime: abortingRuntime(),
      scannerSelection: scan.promise,
    });
    const start = closing.coordinator.start(request(), "owner-a");
    await eventually(() => closing.scanner.selectionSnapshot.mock.calls.length === 1);
    await closing.coordinator.close();
    scan.resolve({ snapshot: scannerSnapshot, selected });
    await expect(start).rejects.toThrow("coordinator is closed");
    expect(closing.runService.create).not.toHaveBeenCalled();

    const failedAdmission = harness({ runtime: abortingRuntime() });
    failedAdmission.repository.markRunning.mockResolvedValueOnce(false);
    await expect(failedAdmission.coordinator.start(request(), "owner-b")).rejects.toThrow(
      "could not enter the running state",
    );
    const [run] = [...failedAdmission.repository.runs.values()];
    expect(run).toMatchObject({
      status: "failed" satisfies PortfolioRunStatus,
      error: {
        code: "CRYPTO_SIMULATION_START_FAILED",
        realOrderApiUsed: false,
      },
    });
    expect(failedAdmission.coordinator.status().activeSessions).toBe(0);
  });
});

describe("SimulationServiceMultiplexer crypto/stock routing", () => {
  it("chooses an active run before a newer terminal run, then the newest terminal run", async () => {
    const test = harness({ runtime: abortingRuntime() });
    const cryptoRun = test.repository.admit("owner-a", {
      market: {
        kind: "crypto_futures",
        venue: "BINANCE_USDM",
        quoteAsset: "USDT",
        contractType: "PERPETUAL",
      },
      initialCash: 10_000,
    }, "binance-usdm:test");
    cryptoRun.status = "running";
    cryptoRun.startedAt = NOW;
    const stockCurrent = {
      run: {
        runId: "stock-run-1",
        status: "completed",
        createdAt: new Date(NOW + 10_000).toISOString(),
      },
      snapshot: {
        phase: "completed",
        market: { kind: "stock", country: "US" },
      },
    };
    const stock = {
      current: vi.fn().mockResolvedValue(stockCurrent),
      list: vi.fn().mockResolvedValue({ items: [] }),
    } as unknown as SimulationRouterService;
    const multiplexer = new SimulationServiceMultiplexer(test.coordinator, stock);

    expect(await multiplexer.current("owner-a")).toMatchObject({
      run: { id: cryptoRun.id, status: "running" },
    });
    cryptoRun.status = "completed";
    cryptoRun.finishedAt = NOW + 1;
    expect(await multiplexer.current("owner-a")).toEqual(stockCurrent);
  });

  it("replaces stock-shaped crypto duplicates with normalized v7 history and preserves stock rows", async () => {
    const test = harness({ runtime: abortingRuntime() });
    const cryptoRun = test.repository.admit("owner-a", {
      market: {
        kind: "crypto_futures",
        venue: "BINANCE_USDM",
        quoteAsset: "USDT",
        contractType: "PERPETUAL",
      },
      initialCash: 10_000,
      durationMinutes: 120,
      preset: "risk_management",
      riskTolerance: 25,
      selection: { mode: "auto", criterion: "volatility", symbolCount: 1 },
      strategy: { mode: "single" },
      modelLanes: ["kronos_base", "fincast"],
      execution: { mode: "paper" },
      selectedSymbol: "BTCUSDT",
    }, "binance-usdm:test");
    cryptoRun.status = "completed";
    cryptoRun.startedAt = NOW;
    cryptoRun.finishedAt = NOW + 120_000;
    cryptoRun.summary = {
      finalEquity: 10_250,
      returnRatio: 0.025,
      tradeCount: 2,
    };
    cryptoRun.result = {
      snapshot: {
        phase: "completed",
        market: {
          kind: "crypto_futures",
          venue: "BINANCE_USDM",
          quoteAsset: "USDT",
          contractType: "PERPETUAL",
        },
        currency: "USDT",
        initialCash: 10_000,
        equity: 10_250,
        selected: [{ symbol: "BTCUSDT" }],
        modelComparison: { outcome: "inconclusive", lanes: [] },
      },
      report: {
        performance: {
          currency: "USDT",
          initialCash: 10_000,
          finalEquity: 10_250,
          tradeCount: 2,
        },
      },
    };
    const malformedStockViewOfCrypto = {
      runId: cryptoRun.id,
      status: "completed",
      currency: "KRW",
      initialCash: 10_000,
      finalEquity: 10_250,
    };
    const stockHistory = {
      runId: "stock-run-1",
      status: "completed",
      market: { kind: "stock", country: "KR" },
      currency: "KRW",
    };
    const stock = {
      current: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue({
        items: [malformedStockViewOfCrypto, stockHistory],
        nextCursor: "stock-cursor",
      }),
    } as unknown as SimulationRouterService;
    const multiplexer = new SimulationServiceMultiplexer(test.coordinator, stock);

    const listed = await multiplexer.list({ limit: 20 }, "owner-a") as {
      schemaVersion: string;
      items: Array<Record<string, unknown>>;
      nextCursor?: string;
      page: { limit: number; returned: number };
    };
    expect(listed).toMatchObject({
      schemaVersion: "ai-paper-simulation/v8",
      nextCursor: "stock-cursor",
      page: { limit: 20, returned: 2 },
    });
    expect(listed.items).toHaveLength(2);
    expect(listed.items[0]).toMatchObject({
      runId: cryptoRun.id,
      market: {
        kind: "crypto_futures",
        venue: "BINANCE_USDM",
        quoteAsset: "USDT",
        contractType: "PERPETUAL",
      },
      currency: "USDT",
      initialCash: 10_000,
      finalEquity: 10_250,
      returnRatio: 0.025,
      configuration: {
        market: { kind: "crypto_futures" },
        modelLanes: ["kronos_base", "fincast"],
        execution: { mode: "paper" },
      },
      performance: {
        currency: "USDT",
        finalEquity: 10_250,
        tradeCount: 2,
      },
    });
    expect(listed.items[1]).toEqual(stockHistory);
  });
});
