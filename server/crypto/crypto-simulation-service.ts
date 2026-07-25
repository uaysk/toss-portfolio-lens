import type { ArtifactType } from "../repositories/artifact-repository.js";
import type {
  PortfolioRunRecord,
  RunRepository,
} from "../repositories/run-repository.js";
import type { ScannerCriterion } from "../scalping/contracts.js";
import type { ArtifactService } from "../services/artifact-service.js";
import type { RunService, RunTaskContext } from "../services/run-service.js";
import {
  AI_SIMULATION_CONTRACT_VERSION,
  type SimulationStartRequest,
} from "../simulation/contracts.js";
import type {
  SimulationCandidatesInput,
  SimulationRouterService,
} from "../simulation/router.js";
import type { SimulationHistoryListInput } from "../simulation/simulation-service.js";
import { BinanceUsdmScanner } from "./binance-scanner.js";
import type { BinanceScannerCandidate, BinanceScannerSnapshot } from "./contracts.js";
import type { FuturesExecution } from "./execution.js";
import type {
  BinanceMaintenanceMarginProviderStatus,
} from "./binance-maintenance-margin.js";
import { PAPER_MAINTENANCE_MARGIN_COVERAGE_RATE } from "./futures-risk.js";

export type CryptoWorkerPublicState = {
  status: "healthy" | "degraded" | "unavailable" | "memory_pressure";
  precision: "fp16" | "fp32" | "unknown";
};

export type CryptoSimulationRuntimeResult = {
  summary: unknown;
  result: unknown;
  warnings?: string[];
  artifacts?: Array<{ type: ArtifactType; content: unknown; rowCount?: number }>;
};

export interface CryptoSimulationRuntime {
  run(input: {
    request: SimulationStartRequest;
    snapshot: BinanceScannerSnapshot;
    selected: BinanceScannerCandidate;
    context: RunTaskContext;
  }): Promise<CryptoSimulationRuntimeResult>;
}

export type CryptoSimulationCoordinatorOptions = {
  scanner: BinanceUsdmScanner;
  execution: FuturesExecution;
  runService: RunService;
  repository: RunRepository;
  artifacts: ArtifactService;
  runtime?: CryptoSimulationRuntime;
  credentials?: {
    configured: boolean;
    signedReadSucceeded: boolean;
  };
  maintenanceMarginState?: () => BinanceMaintenanceMarginProviderStatus;
  prepareRiskData?: (
    symbol: string,
    requiredMaximumNotional: number,
  ) => Promise<void>;
  workers?: Partial<Record<"kronos_base" | "fincast", CryptoWorkerPublicState>>;
  workerState?: () => Partial<Record<"kronos_base" | "fincast", CryptoWorkerPublicState>>;
  runtimeSnapshots?: Map<string, unknown>;
  maximumActiveSessions?: number;
};

type ActiveCryptoSession = {
  runId: string;
  ownerSubject: string;
  controller: AbortController;
  task: Promise<void>;
};

class CryptoRunCancelledError extends Error {}
class CryptoCoordinatorClosedError extends Error {}

type GenericRecord = Record<string, unknown>;

function cryptoMarket() {
  return {
    kind: "crypto_futures" as const,
    venue: "BINANCE_USDM" as const,
    quoteAsset: "USDT" as const,
    contractType: "PERPETUAL" as const,
  };
}

function genericRecord(value: unknown): GenericRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as GenericRecord
    : {};
}

function finiteNumber(value: unknown): number | undefined {
  const parsed = typeof value === "number" || typeof value === "string"
    ? Number(value)
    : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function nonemptyText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function itemRunId(value: unknown): string | undefined {
  const item = genericRecord(value);
  const run = genericRecord(item.run);
  return nonemptyText(run.id)
    ?? nonemptyText(run.runId)
    ?? nonemptyText(item.runId)
    ?? nonemptyText(item.id);
}

function itemRunStatus(value: unknown): string {
  const item = genericRecord(value);
  const run = genericRecord(item.run);
  return nonemptyText(run.status) ?? nonemptyText(item.status) ?? "unknown";
}

function itemRunTime(value: unknown): number {
  const item = genericRecord(value);
  const run = genericRecord(item.run);
  for (const candidate of [
    run.startedAt,
    run.started_at,
    run.createdAt,
    run.created_at,
    item.startedAt,
    item.started_at,
    item.createdAt,
    item.created_at,
    item.finishedAt,
    item.finished_at,
  ]) {
    const numeric = finiteNumber(candidate);
    if (numeric !== undefined) return numeric;
    const text = nonemptyText(candidate);
    if (text && Number.isFinite(Date.parse(text))) return Date.parse(text);
  }
  return Number.NEGATIVE_INFINITY;
}

function preferredCurrent(left: unknown | undefined, right: unknown | undefined): unknown | undefined {
  if (!left) return right;
  if (!right) return left;
  const leftId = itemRunId(left);
  const rightId = itemRunId(right);
  if (leftId && leftId === rightId) return left;
  const activeStatuses = new Set(["queued", "running", "cancel_requested"]);
  const leftActive = activeStatuses.has(itemRunStatus(left));
  const rightActive = activeStatuses.has(itemRunStatus(right));
  if (leftActive !== rightActive) return leftActive ? left : right;
  return itemRunTime(left) >= itemRunTime(right) ? left : right;
}

export class CryptoSimulationCoordinator {
  private readonly active = new Map<string, ActiveCryptoSession>();
  private readonly startingOwners = new Set<string>();
  private readonly tasks = new Set<Promise<void>>();
  private closed = false;

  constructor(private readonly options: CryptoSimulationCoordinatorOptions) {}

  status(enabled = true) {
    const execution = this.options.execution.status();
    const workers = this.options.workerState?.() ?? this.options.workers ?? {};
    const maintenanceMargin = this.options.maintenanceMarginState?.() ?? {
      configured: this.options.credentials?.configured ?? false,
      ready: false,
      state: this.options.credentials?.signedReadSucceeded
        ? "not_ready" as const
        : "unconfigured" as const,
    };
    const signedRiskDataAvailable = (
      (this.options.credentials?.configured ?? false)
      && (this.options.credentials?.signedReadSucceeded ?? false)
      && maintenanceMargin.configured
    );
    return {
      schemaVersion: AI_SIMULATION_CONTRACT_VERSION,
      enabled,
      market: {
        kind: "crypto_futures",
        venue: "BINANCE_USDM",
        quoteAsset: "USDT",
        contractType: "PERPETUAL",
      },
      capabilities: {
        paper: Boolean(this.options.runtime) && signedRiskDataAvailable,
        testnet: false,
        live: false,
        realOrder: false,
        autonomousPaperTrading: Boolean(this.options.runtime) && signedRiskDataAvailable,
        orderApiDependency: false,
      },
      credentials: {
        configured: this.options.credentials?.configured ?? false,
        signedReadSucceeded: this.options.credentials?.signedReadSucceeded ?? false,
      },
      maintenanceMargin: {
        configured: maintenanceMargin.configured,
        ready: maintenanceMargin.ready,
        state: maintenanceMargin.state,
      },
      executionGates: {
        paper: execution.mode === "paper"
          && execution.gate === "open"
          && signedRiskDataAvailable,
        testnet: false,
        live: false,
        realOrder: false,
      },
      workers: {
        kronos_base: workers.kronos_base
          ?? { status: "unavailable", precision: "unknown" },
        fincast: workers.fincast
          ?? { status: "unavailable", precision: "unknown" },
      },
      activeSessions: this.active.size,
    };
  }

  candidates(input: SimulationCandidatesInput): Promise<BinanceScannerSnapshot> {
    return this.options.scanner.candidates(input.criterion);
  }

  async start(input: SimulationStartRequest, ownerSubject: string) {
    if (this.closed) throw new Error("Crypto simulation coordinator is closed.");
    if (input.market.kind !== "crypto_futures") {
      throw new Error("Crypto coordinator only accepts crypto_futures requests.");
    }
    if (input.execution.mode !== "paper" || this.options.execution.mode !== "paper") {
      throw new Error("This deployment accepts paper execution only.");
    }
    if (!this.options.runtime) {
      throw new Error("Crypto paper runtime is unavailable; no run was created.");
    }
    if (this.options.credentials?.configured !== true
      || this.options.credentials.signedReadSucceeded !== true) {
      throw new Error(
        "Signed Binance read access is required for maintenance-margin risk data.",
      );
    }
    const maintenanceMargin = this.options.maintenanceMarginState?.();
    if (maintenanceMargin && !maintenanceMargin.configured) {
      throw new Error(
        "Signed Binance maintenance-margin risk data is unavailable.",
      );
    }
    const maximumActiveSessions = this.options.maximumActiveSessions ?? 1;
    if (this.active.size + this.startingOwners.size >= maximumActiveSessions) {
      throw new Error("The crypto paper session limit has been reached.");
    }
    if (this.startingOwners.has(ownerSubject)
      || [...this.active.values()].some((session) => session.ownerSubject === ownerSubject)) {
      throw new Error("A crypto paper session is already active for this owner.");
    }
    this.startingOwners.add(ownerSubject);
    try {
      const criterion: ScannerCriterion = input.selection.mode === "auto"
        ? input.selection.criterion
        : "volatility";
      const { snapshot, selected: automatic } = await this.options.scanner
        .selectionSnapshot(criterion);
      if (this.closed) {
        throw new Error("Crypto simulation coordinator is closed.");
      }
      const manuallyRequestedSymbol = input.selection.mode === "manual"
        ? input.selection.symbols[0]
        : undefined;
      const selected = input.selection.mode === "manual"
        ? snapshot.candidates.find((candidate) => (
          candidate.symbol === manuallyRequestedSymbol
          && candidate.dataQuality.status === "available"
        ))
        : automatic;
      if (!selected) {
        throw new Error("The requested symbol does not satisfy the current liquidity snapshot.");
      }
      await this.options.prepareRiskData?.(
        selected.symbol,
        input.initialCash * PAPER_MAINTENANCE_MARGIN_COVERAGE_RATE,
      );
      if (this.closed) {
        throw new Error("Crypto simulation coordinator is closed.");
      }
      const sessionNonce = new Date().toISOString();
      const normalizedInput = {
        ...input,
        schemaVersion: AI_SIMULATION_CONTRACT_VERSION,
        market: input.market,
        scannerSnapshotId: snapshot.scannerSnapshotId,
        scannerGeneratedAt: snapshot.generatedAt,
        selectedSymbol: selected.symbol,
        sessionNonce,
        realOrder: false,
      };
      const dataRevision = `binance-usdm:${snapshot.scannerSnapshotId}`;
      const run = await this.options.runService.create({
        ownerSubject,
        kind: "ai_trading_simulation",
        config: normalizedInput,
        dataRevision,
        totalCandidates: 1,
      });
      if (this.closed) {
        await this.options.repository.fail(run.id, {
          code: "CRYPTO_SIMULATION_SERVER_SHUTDOWN",
          message: "Crypto simulation coordinator closed during run admission.",
          retryable: true,
          realOrderApiUsed: false,
        });
        throw new Error("Crypto simulation coordinator is closed.");
      }
      if (!await this.options.repository.markRunning(run.id)) {
        if (await this.options.repository.isCancellationRequested(run.id)) {
          await this.options.repository.cancel(
            run.id,
            { phase: "cancelled", realOrderApiUsed: false },
            ["Crypto paper session was cancelled during admission."],
          );
        } else {
          await this.options.repository.fail(run.id, {
            code: "CRYPTO_SIMULATION_START_FAILED",
            message: "The crypto paper run could not enter the running state.",
            retryable: true,
            realOrderApiUsed: false,
          });
        }
        throw new Error("The crypto paper run could not enter the running state.");
      }
      try {
        if (this.closed) {
          throw new CryptoCoordinatorClosedError(
            "Crypto simulation coordinator closed during run admission.",
          );
        }
        await this.options.repository.addEvent(run.id, "crypto_simulation_started", {
          market: input.market,
          scannerSnapshotId: snapshot.scannerSnapshotId,
          selectedSymbol: selected.symbol,
          modelLanes: input.modelLanes,
          execution: { mode: "paper", realOrder: false },
        });
        if (this.closed) {
          throw new CryptoCoordinatorClosedError(
            "Crypto simulation coordinator closed during run admission.",
          );
        }
      } catch (error) {
        const shuttingDown = error instanceof CryptoCoordinatorClosedError;
        await this.options.repository.fail(run.id, {
          code: shuttingDown
            ? "CRYPTO_SIMULATION_SERVER_SHUTDOWN"
            : "CRYPTO_SIMULATION_START_FAILED",
          message: error instanceof Error
            ? error.message.slice(0, 500)
            : "Crypto simulation admission failed.",
          retryable: true,
          realOrderApiUsed: false,
        });
        throw error;
      }
      const controller = new AbortController();
      const task = this.executeRuntime({
        runId: run.id,
        ownerSubject,
        request: input,
        snapshot,
        selected,
        criterion,
        dataRevision,
        controller,
      }).finally(() => {
        this.active.delete(run.id);
        this.options.runtimeSnapshots?.delete(run.id);
      });
      const session: ActiveCryptoSession = {
        runId: run.id,
        ownerSubject,
        controller,
        task,
      };
      this.active.set(run.id, session);
      this.tasks.add(task);
      void task.finally(() => this.tasks.delete(task)).catch(() => undefined);
      return {
        schemaVersion: AI_SIMULATION_CONTRACT_VERSION,
        market: input.market,
        run: {
          ...run,
          schemaVersion: AI_SIMULATION_CONTRACT_VERSION,
          market: input.market,
          status: "running",
        },
        snapshot: {
          phase: "running",
          market: input.market,
          currency: "USDT",
          initialCash: input.initialCash,
          cash: input.initialCash,
          equity: input.initialCash,
          progress: 0,
          scannerSnapshotId: snapshot.scannerSnapshotId,
          selectedSymbol: selected.symbol,
          selected: [selected],
          modelLanes: input.modelLanes,
          executionMode: "paper",
          execution: { mode: "paper", realOrder: false },
        },
      };
    } finally {
      this.startingOwners.delete(ownerSubject);
    }
  }

  private async executeRuntime(input: {
    runId: string;
    ownerSubject: string;
    request: SimulationStartRequest;
    snapshot: BinanceScannerSnapshot;
    selected: BinanceScannerCandidate;
    criterion: ScannerCriterion;
    dataRevision: string;
    controller: AbortController;
  }): Promise<void> {
    const cancelled = async (): Promise<boolean> => (
      input.controller.signal.aborted
      || await this.options.repository.isCancellationRequested(input.runId)
    );
    const throwIfCancelled = async (): Promise<void> => {
      if (!await cancelled()) return;
      const reason = input.controller.signal.reason;
      if (reason instanceof CryptoCoordinatorClosedError) throw reason;
      if (reason instanceof Error) throw reason;
      throw new CryptoRunCancelledError("Crypto paper session was cancelled.");
    };
    const context: RunTaskContext = {
      runId: input.runId,
      signal: input.controller.signal,
      updateProgress: (progress, detail) => this.options.repository.updateProgress(
        input.runId,
        {
          progress,
          ...(detail?.completedCandidates !== undefined
            ? { completedCandidates: detail.completedCandidates } : {}),
          ...(detail?.totalCandidates !== undefined
            ? { totalCandidates: detail.totalCandidates } : {}),
          ...(detail?.currentValidationWindow
            ? { currentValidationWindow: detail.currentValidationWindow } : {}),
          ...(detail?.warnings ? { warnings: detail.warnings } : {}),
        },
      ),
      isCancelled: cancelled,
      throwIfCancelled,
    };
    const selectionArtifact = {
      type: "simulation-selection" as const,
      content: {
        schemaVersion: AI_SIMULATION_CONTRACT_VERSION,
        market: input.request.market,
        scannerSnapshotId: input.snapshot.scannerSnapshotId,
        generatedAt: input.snapshot.generatedAt,
        criterion: input.criterion,
        selected: input.selected,
        rankedCandidates: input.snapshot.candidates,
        evidence: input.snapshot.evidence,
        realOrder: false,
      },
      rowCount: input.snapshot.candidates.length,
    };
    try {
      await throwIfCancelled();
      // Persist immutable selection evidence before entering the long-lived
      // runtime so completion, cancellation, failure, and shutdown all retain
      // the scanner basis for the session.
      await this.options.artifacts.put({
        runId: input.runId,
        type: selectionArtifact.type,
        content: selectionArtifact.content,
        rowCount: selectionArtifact.rowCount,
        dataRevision: input.dataRevision,
      });
      await throwIfCancelled();
      const completed = await this.options.runtime!.run({
        request: input.request,
        snapshot: input.snapshot,
        selected: input.selected,
        context,
      });
      await throwIfCancelled();
      for (const artifact of completed.artifacts ?? []) {
        await this.options.artifacts.put({
          runId: input.runId,
          type: artifact.type,
          content: artifact.content,
          rowCount: artifact.rowCount,
          dataRevision: input.dataRevision,
        });
      }
      await throwIfCancelled();
      const stored = await this.options.repository.complete(
        input.runId,
        completed.summary,
        completed.result,
        completed.warnings ?? [],
      );
      if (!stored) {
        if (await this.options.repository.isCancellationRequested(input.runId)) {
          throw new CryptoRunCancelledError("Crypto paper session was cancelled during finalization.");
        }
        throw new Error("Crypto paper completion state was not persisted.");
      }
    } catch (error) {
      if (error instanceof CryptoRunCancelledError
        || (input.controller.signal.aborted
          && !(input.controller.signal.reason instanceof CryptoCoordinatorClosedError))) {
        await this.options.repository.cancel(
          input.runId,
          {
            phase: "cancelled",
            market: input.request.market,
            selectedSymbol: input.selected.symbol,
            realOrderApiUsed: false,
          },
          ["사용자 요청으로 crypto paper session을 취소했습니다."],
        );
        return;
      }
      const runtimeError = error && typeof error === "object"
        ? error as { code?: unknown; message?: unknown; snapshot?: unknown }
        : undefined;
      const code = error instanceof CryptoCoordinatorClosedError
        ? "CRYPTO_SIMULATION_SERVER_SHUTDOWN"
        : typeof runtimeError?.code === "string"
          ? `CRYPTO_${runtimeError.code.toUpperCase()}`
          : "CRYPTO_SIMULATION_FAILED";
      const message = typeof runtimeError?.message === "string"
        ? runtimeError.message.slice(0, 500)
        : "Crypto paper runtime failed.";
      try {
        await this.options.artifacts.put({
          runId: input.runId,
          type: "simulation-selection",
          content: selectionArtifact.content,
          rowCount: selectionArtifact.rowCount,
          dataRevision: input.dataRevision,
        });
        if (runtimeError?.snapshot) {
          await this.options.artifacts.put({
            runId: input.runId,
            type: "simulation-diagnostics",
            content: {
              schemaVersion: AI_SIMULATION_CONTRACT_VERSION,
              snapshot: runtimeError.snapshot,
              failure: { code, message },
              realOrder: false,
            },
            rowCount: 1,
            dataRevision: input.dataRevision,
          });
        }
      } catch {
        // Preserve the terminal run failure even if diagnostic persistence is
        // unavailable. Credential or signed-account payloads never enter here.
      }
      await this.options.repository.fail(input.runId, {
        code,
        message,
        retryable: code !== "CRYPTO_INVALID_RUNTIME_INPUT",
        realOrderApiUsed: false,
      }, [message]);
    }
  }

  async current(ownerSubject: string) {
    const active = [...this.active.values()]
      .filter((session) => session.ownerSubject === ownerSubject)
      .at(-1);
    if (active) return this.get(active.runId, ownerSubject);
    const listed = await this.options.repository.list({
      ownerSubject,
      kinds: ["ai_trading_simulation"],
      archived: "all",
      limit: 50,
    });
    const run = listed.items.find((candidate) => this.isCryptoRun(candidate));
    if (!run) return undefined;
    return {
      schemaVersion: AI_SIMULATION_CONTRACT_VERSION,
      market: cryptoMarket(),
      run: this.publicRun(run),
      snapshot: this.storedSnapshot(run),
    };
  }

  async owns(runId: string, ownerSubject: string): Promise<boolean> {
    const run = await this.options.repository.get(runId, ownerSubject);
    return Boolean(run && this.isCryptoRun(run));
  }

  async list(input: SimulationHistoryListInput, ownerSubject: string) {
    const limit = Math.max(1, Math.min(100, input.limit ?? 20));
    const listed = await this.options.repository.list({
      ownerSubject,
      kinds: ["ai_trading_simulation"],
      archived: "all",
      ...(input.statuses?.length ? { statuses: input.statuses } : {}),
      ...(input.cursor ? { cursor: input.cursor } : {}),
      limit,
    });
    const items = listed.items
      .filter((run) => this.isCryptoRun(run))
      .map((run) => this.historyItem(run));
    return {
      schemaVersion: AI_SIMULATION_CONTRACT_VERSION,
      items,
      ...(listed.nextCursor ? { nextCursor: listed.nextCursor } : {}),
      page: { limit, returned: items.length },
    };
  }

  async get(runId: string, ownerSubject: string) {
    const run = await this.options.repository.get(runId, ownerSubject);
    if (!run || run.kind !== "ai_trading_simulation" || !this.isCryptoRun(run)) {
      return undefined;
    }
    return {
      schemaVersion: AI_SIMULATION_CONTRACT_VERSION,
      market: cryptoMarket(),
      run: this.publicRun(run),
      snapshot: this.options.runtimeSnapshots?.get(runId) ?? this.storedSnapshot(run),
    };
  }

  async report(runId: string, ownerSubject: string) {
    const run = await this.options.repository.get(runId, ownerSubject);
    if (!run || run.kind !== "ai_trading_simulation" || !this.isCryptoRun(run)) {
      return undefined;
    }
    const descriptors = await this.options.artifacts.list(runId);
    const result = run.result && typeof run.result === "object" && !Array.isArray(run.result)
      ? run.result as Record<string, unknown>
      : {};
    const report = result.report && typeof result.report === "object"
      && !Array.isArray(result.report)
      ? result.report as Record<string, unknown>
      : {};
    return {
      ...report,
      schemaVersion: AI_SIMULATION_CONTRACT_VERSION,
      market: cryptoMarket(),
      run: this.publicRun(run),
      snapshot: this.options.runtimeSnapshots?.get(runId) ?? this.storedSnapshot(run),
      artifacts: descriptors,
    };
  }

  async cancel(runId: string, ownerSubject: string) {
    const run = await this.options.repository.get(runId, ownerSubject);
    if (!run || run.kind !== "ai_trading_simulation" || !this.isCryptoRun(run)) {
      return undefined;
    }
    if (["queued", "running"].includes(run.status)) {
      await this.options.repository.requestCancellation(runId, ownerSubject);
      this.active.get(runId)?.controller.abort(
        new CryptoRunCancelledError("Crypto paper session cancellation was requested."),
      );
    }
    return this.get(runId, ownerSubject);
  }

  async close(reason = "server_shutdown"): Promise<void> {
    if (this.closed) {
      await Promise.allSettled([...this.tasks]);
      return;
    }
    this.closed = true;
    for (const session of this.active.values()) {
      session.controller.abort(new CryptoCoordinatorClosedError(
        `Crypto paper session stopped during ${reason}.`,
      ));
    }
    await Promise.allSettled([...this.tasks]);
  }

  private isCryptoRun(run: { input: unknown }): boolean {
    if (!run.input || typeof run.input !== "object" || Array.isArray(run.input)) return false;
    const market = (run.input as { market?: unknown }).market;
    return Boolean(
      market && typeof market === "object" && !Array.isArray(market)
      && (market as { kind?: unknown }).kind === "crypto_futures",
    );
  }

  private storedSnapshot(run: { result?: unknown; summary?: unknown }): unknown {
    for (const source of [run.result, run.summary]) {
      if (!source || typeof source !== "object" || Array.isArray(source)) continue;
      const snapshot = (source as { snapshot?: unknown }).snapshot;
      if (snapshot !== undefined) return snapshot;
    }
    return undefined;
  }

  private historyItem(run: PortfolioRunRecord) {
    const input = genericRecord(run.input);
    const snapshot = genericRecord(this.storedSnapshot(run));
    const summary = genericRecord(run.summary);
    const result = genericRecord(run.result);
    const report = genericRecord(result.report);
    const performance = genericRecord(report.performance);
    const selectedItems = Array.isArray(snapshot.selected)
      ? snapshot.selected.slice(0, 2)
      : nonemptyText(input.selectedSymbol)
        ? [{ symbol: nonemptyText(input.selectedSymbol) }]
        : [];
    const initialCash = finiteNumber(snapshot.initialCash)
      ?? finiteNumber(input.initialCash)
      ?? finiteNumber(performance.initialCash);
    const finalEquity = finiteNumber(snapshot.equity)
      ?? finiteNumber(summary.finalEquity)
      ?? finiteNumber(summary.final_equity)
      ?? finiteNumber(performance.finalEquity);
    const returnRatio = finiteNumber(summary.returnRatio)
      ?? finiteNumber(summary.return_ratio)
      ?? finiteNumber(performance.returnRatio)
      ?? (initialCash !== undefined && initialCash > 0 && finalEquity !== undefined
        ? finalEquity / initialCash - 1
        : undefined);
    const modelComparison = snapshot.modelComparison
      ?? report.modelComparison
      ?? performance.modelComparison;
    const configuration = {
      market: {
        kind: "crypto_futures" as const,
        venue: "BINANCE_USDM" as const,
        quoteAsset: "USDT" as const,
        contractType: "PERPETUAL" as const,
      },
      currency: "USDT" as const,
      initialCash,
      durationMinutes: finiteNumber(input.durationMinutes),
      preset: nonemptyText(input.preset),
      riskTolerance: finiteNumber(input.riskTolerance),
      selection: snapshot.selection ?? input.selection,
      strategy: snapshot.strategy ?? input.strategy,
      costs: input.costs,
      modelLanes: Array.isArray(input.modelLanes) ? input.modelLanes : [],
      execution: input.execution ?? { mode: "paper" },
    };
    return {
      schemaVersion: AI_SIMULATION_CONTRACT_VERSION,
      runId: run.id,
      status: run.status,
      progress: run.progress,
      createdAt: new Date(run.createdAt).toISOString(),
      ...(run.startedAt !== undefined
        ? { startedAt: new Date(run.startedAt).toISOString() } : {}),
      ...(run.finishedAt !== undefined
        ? { finishedAt: new Date(run.finishedAt).toISOString() } : {}),
      market: configuration.market,
      currency: "USDT",
      configuration,
      preset: configuration.preset,
      riskTolerance: configuration.riskTolerance,
      selection: configuration.selection,
      strategy: configuration.strategy,
      selected: selectedItems,
      initialCash,
      finalEquity,
      returnRatio,
      performance: {
        currency: "USDT",
        initialCash,
        finalEquity,
        returnRatio,
        realizedPnl: finiteNumber(performance.realizedPnl)
          ?? finiteNumber(summary.realizedPnl),
        totalCosts: finiteNumber(performance.totalCosts)
          ?? finiteNumber(summary.totalCosts),
        tradeCount: finiteNumber(performance.tradeCount)
          ?? finiteNumber(summary.tradeCount),
        decisionCount: finiteNumber(performance.decisionCount)
          ?? finiteNumber(summary.decisionCount),
        ...(modelComparison !== undefined ? { modelComparison } : {}),
      },
      ...(modelComparison !== undefined ? { modelComparison } : {}),
      warnings: run.warnings,
      ...(run.error !== undefined ? { error: run.error } : {}),
    };
  }

  private publicRun(run: PortfolioRunRecord) {
    return {
      ...run,
      schemaVersion: AI_SIMULATION_CONTRACT_VERSION,
      market: cryptoMarket(),
    };
  }
}

export class SimulationServiceMultiplexer implements SimulationRouterService {
  constructor(
    private readonly crypto: CryptoSimulationCoordinator,
    private readonly stock?: SimulationRouterService,
  ) {}

  async status(enabled = true) {
    const crypto = this.crypto.status(enabled);
    const stock = await this.stock?.status(enabled);
    if (!stock || typeof stock !== "object" || Array.isArray(stock)) return crypto;
    const stockRecord = stock as Record<string, unknown>;
    const stockCapabilities = stockRecord.capabilities
      && typeof stockRecord.capabilities === "object"
      && !Array.isArray(stockRecord.capabilities)
      ? stockRecord.capabilities as Record<string, unknown>
      : {};
    return {
      ...stockRecord,
      schemaVersion: AI_SIMULATION_CONTRACT_VERSION,
      capabilities: {
        ...stockCapabilities,
        realOrder: false,
      },
      credentials: crypto.credentials,
      executionGates: crypto.executionGates,
      workers: crypto.workers,
      cryptoFutures: crypto,
    };
  }

  candidates(input: SimulationCandidatesInput, _ownerSubject: string) {
    return this.crypto.candidates(input);
  }

  start(input: SimulationStartRequest, ownerSubject: string): Promise<unknown> {
    if (input.market.kind === "crypto_futures") return this.crypto.start(input, ownerSubject);
    if (!this.stock) throw new Error("Stock simulation is unavailable.");
    return this.stock.start(input, ownerSubject);
  }

  async current(ownerSubject: string): Promise<unknown | undefined> {
    const [crypto, stock] = await Promise.all([
      this.crypto.current(ownerSubject),
      this.stock?.current(ownerSubject),
    ]);
    return preferredCurrent(crypto, stock);
  }

  async list(input: SimulationHistoryListInput, ownerSubject: string): Promise<unknown> {
    const [crypto, stock] = await Promise.all([
      this.crypto.list(input, ownerSubject),
      this.stock?.list(input, ownerSubject),
    ]);
    if (!stock || typeof stock !== "object" || Array.isArray(stock)) return crypto;
    const stockRecord = stock as GenericRecord;
    const stockItems = Array.isArray(stockRecord.items) ? stockRecord.items : [];
    const cryptoItems = Array.isArray(crypto.items) ? crypto.items : [];
    const cryptoById = new Map(
      cryptoItems.flatMap((item) => {
        const id = itemRunId(item);
        return id ? [[id, item] as const] : [];
      }),
    );
    const seen = new Set<string>();
    const items = stockItems.map((item) => {
      const id = itemRunId(item);
      if (!id) return item;
      seen.add(id);
      return cryptoById.get(id) ?? item;
    });
    for (const item of cryptoItems) {
      const id = itemRunId(item);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      items.push(item);
    }
    const requestedLimit = Math.max(1, Math.min(100, input.limit ?? 20));
    return {
      ...stockRecord,
      schemaVersion: AI_SIMULATION_CONTRACT_VERSION,
      items: items.slice(0, requestedLimit),
      nextCursor: nonemptyText(stockRecord.nextCursor) ?? crypto.nextCursor,
      page: {
        limit: requestedLimit,
        returned: Math.min(items.length, requestedLimit),
      },
    };
  }

  async get(runId: string, ownerSubject: string): Promise<unknown | undefined> {
    if (await this.crypto.owns(runId, ownerSubject)) {
      return this.crypto.get(runId, ownerSubject);
    }
    return this.stock?.get(runId, ownerSubject);
  }

  async report(runId: string, ownerSubject: string): Promise<unknown | undefined> {
    if (await this.crypto.owns(runId, ownerSubject)) {
      return this.crypto.report(runId, ownerSubject);
    }
    return this.stock?.report(runId, ownerSubject);
  }

  async cancel(runId: string, ownerSubject: string): Promise<unknown | undefined> {
    if (await this.crypto.owns(runId, ownerSubject)) {
      return this.crypto.cancel(runId, ownerSubject);
    }
    return this.stock?.cancel(runId, ownerSubject);
  }
}
