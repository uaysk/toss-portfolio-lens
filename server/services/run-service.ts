import { ARTIFACT_TYPES as SUPPORTED_ARTIFACT_TYPES, type ArtifactType } from "../repositories/artifact-repository.js";
import type { RunRepository, PortfolioRunKind, PortfolioRunRecord } from "../repositories/run-repository.js";
import { requestHash, PORTFOLIO_ENGINE_VERSION, ServiceError } from "./service-envelope.js";
import type { ArtifactService } from "./artifact-service.js";
import type { RunJobRepository } from "../repositories/run-job-repository.js";
import type { OptimizationRepository } from "../repositories/optimization-repository.js";
import {
  WORKER_PAYLOAD_SCHEMA_VERSION,
  WorkerInputSchema,
  type WorkerInput,
} from "../worker/contracts.js";
import { buildInfo } from "../build-info.js";

type RunTaskResult = {
  summary: unknown;
  result: unknown;
  warnings?: string[];
  artifacts?: Array<{ type: ArtifactType; content: unknown; rowCount?: number }>;
};

function manifestSeeds(value: unknown, prefix = "", depth = 0, found: Record<string, number | number[]> = {}): Record<string, number | number[]> {
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > 6) return found;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (key === "seed" && Number.isSafeInteger(item) && Number(item) >= 0) {
      found[path] = Number(item);
    } else if (key === "seeds" && Array.isArray(item)
      && item.length > 0 && item.every((seed) => Number.isSafeInteger(seed) && Number(seed) >= 0)) {
      found[path] = item.map(Number);
    } else if (item && typeof item === "object" && !Array.isArray(item)) {
      manifestSeeds(item, path, depth + 1, found);
    }
  }
  return found;
}

const ARTIFACT_TYPES = new Set<ArtifactType>(SUPPORTED_ARTIFACT_TYPES);

function failedRunDiagnostic(error: unknown, run: PortfolioRunRecord, current?: PortfolioRunRecord) {
  const message = error instanceof Error ? error.message : String(error);
  const config = run.input && typeof run.input === "object" && !Array.isArray(run.input)
    ? run.input as Record<string, unknown>
    : {};
  const inferredCode = message.includes("응답 제한 시간")
    ? "WORKER_RESPONSE_TIMEOUT"
    : message.includes("연결 제한 시간")
      ? "WORKER_CONNECT_TIMEOUT"
      : message.includes("128MiB") || message.includes("프레임")
        ? "WORKER_IPC_PAYLOAD_LIMIT"
        : message.includes("socket closed") || message.includes("ECONNRESET")
          ? "WORKER_DISCONNECTED"
          : "RUN_FAILED";
  const structured = error instanceof ServiceError ? error.detail : undefined;
  const startedAt = current?.startedAt ?? run.startedAt ?? run.createdAt;
  return {
    code: structured?.code ?? inferredCode,
    message: structured?.message ?? message,
    retryable: structured?.retryable ?? inferredCode !== "WORKER_IPC_PAYLOAD_LIMIT",
    phase: "compute_or_artifact_persistence",
    algorithm: typeof config.algorithm === "string" ? config.algorithm : null,
    symbol_count: Array.isArray(config.symbols) ? config.symbols.length : null,
    candidate_budget: Number(config.candidateBudget ?? current?.totalCandidates ?? run.totalCandidates),
    completed_candidate_count: current?.completedCandidates ?? run.completedCandidates,
    total_candidate_count: current?.totalCandidates ?? run.totalCandidates,
    elapsed_ms: Math.max(0, Date.now() - startedAt),
    worker_job_id: null,
    ...(structured?.details ? { details: structured.details } : {}),
    ...(error instanceof Error ? {
      error_type: error.name,
      ...(error.stack ? { stack_trace: error.stack } : {}),
    } : {}),
  };
}

function runCreationMetadata(input: {
  kind: PortfolioRunKind;
  config: unknown;
  dataRevision: string;
}) {
  const hash = requestHash({ config: input.config, engineVersion: PORTFOLIO_ENGINE_VERSION });
  const seeds = manifestSeeds(input.config);
  return {
    hash,
    manifest: {
      schema_version: "portfolio-lens-run-manifest/v1",
      finalized: false,
      captured_at: new Date().toISOString(),
      run: {
        kind: input.kind,
        request_hash: hash,
        data_revision: input.dataRevision,
        engine_version: PORTFOLIO_ENGINE_VERSION,
        input: input.config,
      },
      build: buildInfo(),
      reproducibility: {
        deterministic_when: "동일 seed, 정규화 입력, data revision, 엔진·worker schema 버전이 동일할 때",
        seed: seeds.seed ?? null,
        seed_configuration: seeds,
        formula_versions: input.kind === "optimization"
          ? { optimization_objectives: "optimization-objectives/v2" }
          : {},
        artifact_checksums: [],
      },
    },
  };
}

export type RunTaskContext = {
  runId: string;
  signal: AbortSignal;
  updateProgress: (progress: number, detail?: {
    completedCandidates?: number;
    totalCandidates?: number;
    currentValidationWindow?: string;
    warnings?: string[];
  }) => Promise<void>;
  isCancelled: () => Promise<boolean>;
  throwIfCancelled: () => Promise<void>;
};

type QueuedTask = {
  ownerSubject: string;
  run: PortfolioRunRecord;
  task: (context: RunTaskContext) => Promise<RunTaskResult>;
  deadlineAt: number;
};

type ExecuteRunInput = {
  ownerSubject: string;
  kind: PortfolioRunKind;
  config: unknown;
  dataRevision: string;
  task: (context: RunTaskContext) => Promise<RunTaskResult>;
};

type CreateRunInput = {
  ownerSubject: string;
  kind: PortfolioRunKind;
  config: unknown;
  dataRevision: string;
  totalCandidates?: number;
};

type RecordPreflightFailureInput = CreateRunInput & {
  error: unknown;
};

type EnqueueRunInput = ExecuteRunInput & {
  totalCandidates?: number;
  allowInlineInExternal?: boolean;
};

type EnqueueExternalRunInput = {
  ownerSubject: string;
  kind: PortfolioRunKind;
  config: unknown;
  dataRevision: string;
  payload: Record<string, unknown>;
  totalCandidates?: number;
  priority?: number;
  maxAttempts?: number;
};

type ExecuteExternalRunInput = Omit<
  EnqueueExternalRunInput,
  "priority" | "maxAttempts"
>;

class RunCancelledError extends Error {}
class RunDeadlineExceededError extends Error {}
class RunServiceClosedError extends Error {}

export class RunService {
  private readonly queue: QueuedTask[] = [];
  private readonly activeExecutions = new Map<string, {
    controller: AbortController;
    deadlineTimer?: NodeJS.Timeout;
  }>();
  private readonly admissionTasks = new Set<Promise<unknown>>();
  private readonly executionTasks = new Set<Promise<unknown>>();
  private readonly persistenceTasks = new Set<Promise<unknown>>();
  private readonly shutdownController = new AbortController();
  private running = 0;
  private accepting = true;
  private closeTask?: Promise<void>;

  constructor(
    private readonly repository: RunRepository,
    private readonly artifacts: ArtifactService,
    private readonly maxConcurrentRuns: number,
    private readonly maxRunsPerSubject: number,
    private readonly options: {
      maxQueuedRuns?: number;
      runDeadlineMs?: number;
      executionMode?: "inline" | "rust_socket" | "external";
      jobRepository?: RunJobRepository;
      resultPollMs?: number;
      resultDeadlineMs?: number;
      optimizationRepository?: OptimizationRepository;
    } = {},
  ) {
    if (options.executionMode === "external" && !options.jobRepository) {
      throw new Error("external 실행 모드에는 PostgreSQL run job repository가 필요합니다.");
    }
  }

  async initialize(): Promise<number> {
    this.assertAccepting();
    const recoveredJobs = this.options.jobRepository
      ? await this.options.jobRepository.recoverExpiredLeases()
      : { requeued: 0, failed: 0, cancelled: 0 };
    const recoveredInline = await this.repository.recoverStaleRuns(
      Date.now(),
      Boolean(this.options.jobRepository),
    );
    return recoveredInline + recoveredJobs.requeued + recoveredJobs.failed + recoveredJobs.cancelled;
  }

  get executionMode(): "inline" | "rust_socket" | "external" {
    return this.options.executionMode ?? "inline";
  }

  async waitForIdle(): Promise<void> {
    if (this.closeTask) {
      await this.closeTask;
      return;
    }
    while (true) {
      this.drain();
      const tasks = [...this.admissionTasks, ...this.executionTasks, ...this.persistenceTasks];
      if (!tasks.length && !this.queue.length && this.running === 0) return;
      if (tasks.length) {
        await Promise.allSettled(tasks);
      } else {
        await Promise.resolve();
      }
    }
  }

  close(reason = "server_shutdown"): Promise<void> {
    if (!this.closeTask) this.closeTask = this.performClose(reason);
    return this.closeTask;
  }

  async create(input: CreateRunInput): Promise<PortfolioRunRecord> {
    this.assertAccepting();
    const task = this.createAccepted(input);
    return await this.trackTask(this.admissionTasks, task);
  }

  private async createAccepted(input: CreateRunInput): Promise<PortfolioRunRecord> {
    const { hash, manifest } = runCreationMetadata(input);
    return this.repository.create({
      kind: input.kind,
      ownerSubject: input.ownerSubject,
      requestHash: hash,
      dataRevision: input.dataRevision,
      engineVersion: PORTFOLIO_ENGINE_VERSION,
      config: input.config,
      totalCandidates: input.totalCandidates,
      manifest,
    });
  }

  async recordPreflightFailure(
    input: RecordPreflightFailureInput,
  ): Promise<{ run: PortfolioRunRecord; created: boolean }> {
    this.assertAccepting();
    const task = this.recordPreflightFailureAccepted(input);
    return await this.trackTask(this.admissionTasks, task);
  }

  private async recordPreflightFailureAccepted(
    input: RecordPreflightFailureInput,
  ): Promise<{ run: PortfolioRunRecord; created: boolean }> {
    const { hash, manifest } = runCreationMetadata(input);
    return this.repository.createPreflightFailureIfAbsent({
      kind: input.kind,
      ownerSubject: input.ownerSubject,
      requestHash: hash,
      dataRevision: input.dataRevision,
      engineVersion: PORTFOLIO_ENGINE_VERSION,
      config: input.config,
      error: input.error,
      totalCandidates: input.totalCandidates,
      manifest,
    });
  }

  async execute(input: ExecuteRunInput): Promise<{ run: PortfolioRunRecord; reused: boolean }> {
    this.assertAccepting();
    const task = this.executeAccepted(input);
    return await this.trackTask(this.executionTasks, task);
  }

  private async executeAccepted(
    input: ExecuteRunInput,
  ): Promise<{ run: PortfolioRunRecord; reused: boolean }> {
    let run = await this.create(input);
    if (run.status === "completed") return { run, reused: true };
    if (run.status === "failed" || run.status === "cancelled") {
      const retried = await this.repository.retryTerminal({
        runId: run.id,
        ownerSubject: input.ownerSubject,
        expectedStatus: run.status,
      });
      const current = await this.repository.get(run.id, input.ownerSubject);
      if (!retried || !current) {
        if (current?.status === "completed") return { run: current, reused: true };
        throw new ServiceError({
          code: "RUN_ALREADY_ACTIVE",
          message: "동일한 입력의 재실행이 이미 진행 중입니다.",
          retryable: true,
          details: { run_id: run.id },
        });
      }
      run = current;
    }
    if (!await this.repository.markRunning(run.id)) {
      const current = await this.repository.get(run.id, input.ownerSubject);
      if (current?.status === "completed") return { run: current, reused: true };
      throw new ServiceError({
        code: "RUN_ALREADY_ACTIVE",
        message: "동일한 입력의 실행이 이미 진행 중입니다.",
        retryable: true,
        details: { run_id: run.id },
      });
    }
    await this.repository.addEvent(run.id, "started", { kind: input.kind });
    const context = this.activateContext(run.id, Date.now() + (this.options.runDeadlineMs ?? 120_000));
    try {
      await context.throwIfCancelled();
      const completed = await input.task(context);
      await context.throwIfCancelled();
      await this.persistArtifacts(run.id, input.dataRevision, completed.artifacts ?? [], context);
      await context.throwIfCancelled();
      const stored = await this.repository.complete(
        run.id,
        completed.summary,
        completed.result,
        completed.warnings ?? [],
      );
      if (!stored && await this.repository.isCancellationRequested(run.id)) {
        throw new RunCancelledError("실행이 취소되었습니다.");
      }
    } catch (error) {
      if (error instanceof RunCancelledError
        || (context.signal.aborted && context.signal.reason instanceof RunCancelledError)
        || await this.repository.isCancellationRequested(run.id)) {
        await this.repository.cancel(run.id, { cancelled: true }, ["사용자 요청으로 실행을 취소했습니다."]);
      } else if (error instanceof RunServiceClosedError
        || (context.signal.aborted && context.signal.reason instanceof RunServiceClosedError)) {
        await this.waitForTasks(this.admissionTasks);
        if (await this.repository.isCancellationRequested(run.id)) {
          await this.repository.cancel(run.id, { cancelled: true }, ["사용자 요청으로 실행을 취소했습니다."]);
        } else {
          await this.repository.fail(run.id, {
            code: "RUN_SERVICE_SHUTDOWN",
            message: "서버 종료로 실행이 중단되었습니다.",
            retryable: true,
          }, ["중단 전 저장된 artifact는 보존되었습니다."]);
        }
      } else if (error instanceof RunDeadlineExceededError) {
        await this.repository.fail(run.id, {
          code: "RUN_DEADLINE_EXCEEDED",
          message: "실행 제한 시간을 초과했습니다.",
          retryable: true,
        });
      } else {
        const current = await this.repository.get(run.id, input.ownerSubject);
        await this.repository.fail(run.id, failedRunDiagnostic(error, run, current));
      }
      throw error;
    } finally {
      this.deactivateContext(run.id, context.signal);
    }
    const stored = await this.repository.get(run.id, input.ownerSubject);
    if (!stored) throw new Error("완료된 실행을 찾을 수 없습니다.");
    return { run: stored, reused: false };
  }

  async enqueue(input: EnqueueRunInput): Promise<{ run: PortfolioRunRecord; reused: boolean }> {
    this.assertAccepting();
    const task = this.enqueueAccepted(input);
    return await this.trackTask(this.admissionTasks, task);
  }

  private async enqueueAccepted(
    input: EnqueueRunInput,
  ): Promise<{ run: PortfolioRunRecord; reused: boolean }> {
    if (this.executionMode === "external" && !input.allowInlineInExternal) {
      throw new Error("external 실행은 serializable worker payload로 enqueueExternal을 호출해야 합니다.");
    }
    let run = await this.create(input);
    if (run.status === "failed" || run.status === "cancelled") {
      const retried = await this.repository.retryTerminal({
        runId: run.id,
        ownerSubject: input.ownerSubject,
        expectedStatus: run.status,
        totalCandidates: input.totalCandidates,
      });
      const current = await this.repository.get(run.id, input.ownerSubject);
      if (!current) throw new Error("재실행할 run을 찾을 수 없습니다.");
      if (!retried) return { run: current, reused: true };
      run = current;
    }
    if (run.status !== "queued") return { run, reused: true };
    if (this.executionMode === "external") {
      await this.repository.addEvent(run.id, "external_inline_fallback", {
        kind: input.kind,
        reason: "worker_job_kind_not_yet_supported",
      });
    }
    const activeForOwner = await this.repository.activeCount(input.ownerSubject);
    if (activeForOwner > this.maxRunsPerSubject) {
      await this.repository.fail(run.id, {
        code: "SUBJECT_RUN_LIMIT",
        message: "사용자별 동시 실행 상한을 초과했습니다.",
        retryable: true,
      });
      throw new ServiceError({
        code: "SUBJECT_RUN_LIMIT",
        message: "사용자별 동시 실행 상한을 초과했습니다.",
        retryable: true,
      });
    }
    const activeTotal = await this.repository.activeCount();
    if (activeTotal > (this.options.maxQueuedRuns ?? 4)) {
      await this.repository.fail(run.id, {
        code: "GLOBAL_RUN_LIMIT",
        message: "전체 실행 대기열 상한을 초과했습니다.",
        retryable: true,
      });
      throw new ServiceError({
        code: "GLOBAL_RUN_LIMIT",
        message: "전체 실행 대기열 상한을 초과했습니다.",
        retryable: true,
      });
    }
    this.queue.push({
      ownerSubject: input.ownerSubject,
      run,
      task: input.task,
      deadlineAt: Date.now() + (this.options.runDeadlineMs ?? 120_000),
    });
    this.drain();
    return { run, reused: false };
  }

  async get(runId: string, ownerSubject: string): Promise<PortfolioRunRecord | undefined> {
    this.assertAccepting();
    const task = this.getAccepted(runId, ownerSubject);
    return await this.trackTask(this.admissionTasks, task);
  }

  private async getAccepted(
    runId: string,
    ownerSubject: string,
  ): Promise<PortfolioRunRecord | undefined> {
    let run = await this.repository.get(runId, ownerSubject);
    if (run && ["queued", "running", "cancel_requested"].includes(run.status) && this.options.jobRepository) {
      const job = await this.options.jobRepository.get(run.id);
      if (job && job.deadlineAt <= Date.now()) {
        await this.options.jobRepository.expireDeadline(run.id);
        run = await this.repository.get(runId, ownerSubject);
      }
    }
    if (run?.status === "completed") await this.materializeExternalArtifacts(run);
    return run;
  }

  async enqueueExternal(
    input: EnqueueExternalRunInput,
  ): Promise<{ run: PortfolioRunRecord; reused: boolean }> {
    this.assertAccepting();
    const task = this.enqueueExternalAccepted(input);
    return await this.trackTask(this.admissionTasks, task);
  }

  private async enqueueExternalAccepted(
    input: EnqueueExternalRunInput,
  ): Promise<{ run: PortfolioRunRecord; reused: boolean }> {
    const jobs = this.options.jobRepository;
    if (!jobs) throw new Error("external compute queue가 초기화되지 않았습니다.");
    let run = await this.create(input);
    if (run.status === "completed") {
      await this.materializeExternalArtifacts(run);
      return { run, reused: true };
    }
    const existing = await jobs.get(run.id);
    if (existing) {
      if ((run.status === "failed" || run.status === "cancelled") && existing.state === run.status) {
        const activeForOwner = await this.repository.activeCount(input.ownerSubject);
        if (activeForOwner >= this.maxRunsPerSubject) {
          throw new ServiceError({
            code: "SUBJECT_RUN_LIMIT",
            message: "사용자별 동시 실행 상한을 초과했습니다.",
            retryable: true,
          });
        }
        const activeTotal = await this.repository.activeCount();
        if (activeTotal >= (this.options.maxQueuedRuns ?? 4)) {
          throw new ServiceError({
            code: "GLOBAL_RUN_LIMIT",
            message: "전체 실행 대기열 상한을 초과했습니다.",
            retryable: true,
          });
        }
        const now = Date.now();
        const retried = await jobs.retryTerminal({
          runId: run.id,
          ownerSubject: input.ownerSubject,
          totalCandidates: input.totalCandidates,
          priority: input.priority,
          maxAttempts: input.maxAttempts,
          deadlineAt: now + (this.options.runDeadlineMs ?? 120_000),
          now,
        });
        const current = await this.repository.get(run.id, input.ownerSubject);
        if (!current) throw new Error("재실행할 external run을 찾을 수 없습니다.");
        return { run: current, reused: !retried };
      }
      return { run, reused: true };
    }
    if (run.status === "failed" || run.status === "cancelled") {
      const retried = await this.repository.retryTerminal({
        runId: run.id,
        ownerSubject: input.ownerSubject,
        expectedStatus: run.status,
        totalCandidates: input.totalCandidates,
      });
      const current = await this.repository.get(run.id, input.ownerSubject);
      if (!current) throw new Error("재실행할 external run을 찾을 수 없습니다.");
      if (!retried) return { run: current, reused: true };
      run = current;
    }
    const activeForOwner = await this.repository.activeCount(input.ownerSubject);
    if (activeForOwner > this.maxRunsPerSubject) {
      await this.repository.fail(run.id, {
        code: "SUBJECT_RUN_LIMIT",
        message: "사용자별 동시 실행 상한을 초과했습니다.",
        retryable: true,
      });
      throw new ServiceError({
        code: "SUBJECT_RUN_LIMIT",
        message: "사용자별 동시 실행 상한을 초과했습니다.",
        retryable: true,
      });
    }
    const activeTotal = await this.repository.activeCount();
    if (activeTotal > (this.options.maxQueuedRuns ?? 4)) {
      await this.repository.fail(run.id, {
        code: "GLOBAL_RUN_LIMIT",
        message: "전체 실행 대기열 상한을 초과했습니다.",
        retryable: true,
      });
      throw new ServiceError({
        code: "GLOBAL_RUN_LIMIT",
        message: "전체 실행 대기열 상한을 초과했습니다.",
        retryable: true,
      });
    }
    const workerInput: WorkerInput = WorkerInputSchema.parse({
      schema_version: WORKER_PAYLOAD_SCHEMA_VERSION,
      engine_version: run.engineVersion,
      run_id: run.id,
      job_kind: run.kind,
      data_revision: run.dataRevision,
      request_hash: run.requestHash,
      payload: input.payload,
    });
    try {
      const artifact = await jobs.putInput(workerInput);
      await jobs.enqueue({
        runId: run.id,
        kind: run.kind,
        inputArtifactId: artifact.id,
        priority: input.priority,
        maxAttempts: input.maxAttempts,
        deadlineAt: Date.now() + (this.options.runDeadlineMs ?? 120_000),
      });
    } catch (error) {
      await this.repository.fail(run.id, {
        code: "EXTERNAL_DISPATCH_FAILED",
        message: "외부 계산 작업을 등록하지 못했습니다.",
        retryable: true,
      });
      throw error;
    }
    return { run, reused: false };
  }

  async executeExternal(
    input: ExecuteExternalRunInput,
  ): Promise<{ run: PortfolioRunRecord; reused: boolean }> {
    this.assertAccepting();
    const task = this.executeExternalAccepted(input);
    return await this.trackTask(this.executionTasks, task);
  }

  private async executeExternalAccepted(
    input: ExecuteExternalRunInput,
  ): Promise<{ run: PortfolioRunRecord; reused: boolean }> {
    const dispatched = await this.enqueueExternal(input);
    if (dispatched.run.status === "completed") return dispatched;
    const deadlineAt = Date.now() + (this.options.resultDeadlineMs ?? 300_000);
    const pollMs = this.options.resultPollMs ?? 250;
    while (Date.now() < deadlineAt) {
      this.assertAccepting();
      const current = await this.get(dispatched.run.id, input.ownerSubject);
      if (!current) throw new Error("external run을 찾을 수 없습니다.");
      if (current.status === "completed") {
        return { run: current, reused: dispatched.reused };
      }
      if (current.status === "failed" || current.status === "cancelled") {
        throw new ServiceError({
          code: current.status === "cancelled" ? "RUN_CANCELLED" : "RUN_FAILED",
          message: current.status === "cancelled" ? "실행이 취소되었습니다." : "외부 계산 실행에 실패했습니다.",
          retryable: current.status === "failed",
          details: { run_id: current.id, error: current.error },
        });
      }
      await this.waitForExternalPoll(pollMs);
    }
    await this.options.jobRepository?.cancel(dispatched.run.id, input.ownerSubject);
    throw new ServiceError({
      code: "RUN_DEADLINE_EXCEEDED",
      message: "외부 계산 결과 대기 시간을 초과했습니다.",
      retryable: true,
      details: { run_id: dispatched.run.id },
    });
  }

  async findReusable(input: {
    ownerSubject: string;
    kind: PortfolioRunKind;
    config: unknown;
    dataRevision: string;
  }): Promise<PortfolioRunRecord | undefined> {
    this.assertAccepting();
    const task = this.findReusableAccepted(input);
    return await this.trackTask(this.admissionTasks, task);
  }

  private async findReusableAccepted(input: {
    ownerSubject: string;
    kind: PortfolioRunKind;
    config: unknown;
    dataRevision: string;
  }): Promise<PortfolioRunRecord | undefined> {
    const run = await this.repository.findByRequest(
      input.ownerSubject,
      input.kind,
      requestHash({ config: input.config, engineVersion: PORTFOLIO_ENGINE_VERSION }),
      input.dataRevision,
    );
    if (run?.status !== "completed") return undefined;
    await this.materializeExternalArtifacts(run);
    return run;
  }

  private assertAccepting(): void {
    if (!this.accepting) {
      throw new RunServiceClosedError("Run service가 종료되어 새 실행을 시작할 수 없습니다.");
    }
  }

  private trackTask<T>(tasks: Set<Promise<unknown>>, task: Promise<T>): Promise<T> {
    tasks.add(task);
    void task.then(
      () => tasks.delete(task),
      () => tasks.delete(task),
    );
    return task;
  }

  private async waitForTasks(tasks: Set<Promise<unknown>>): Promise<void> {
    while (tasks.size) {
      await Promise.allSettled([...tasks]);
    }
  }

  private async waitForOwnedWork(): Promise<void> {
    while (true) {
      const tasks = [...this.executionTasks, ...this.persistenceTasks];
      if (!tasks.length) return;
      await Promise.allSettled(tasks);
    }
  }

  private waitForExternalPoll(milliseconds: number): Promise<void> {
    const signal = this.shutdownController.signal;
    if (signal.aborted) {
      return Promise.reject(
        signal.reason instanceof Error ? signal.reason : new RunServiceClosedError("Run service가 종료되었습니다."),
      );
    }
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal.reason instanceof Error
          ? signal.reason
          : new RunServiceClosedError("Run service가 종료되었습니다."));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, milliseconds);
      timer.unref();
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }

  private async terminalizeQueuedRun(queued: QueuedTask, reason: string): Promise<void> {
    if (await this.repository.isCancellationRequested(queued.run.id)) {
      await this.repository.cancel(
        queued.run.id,
        { cancelled: true },
        ["대기 중 사용자 요청으로 취소했습니다."],
      );
      return;
    }
    await this.repository.fail(queued.run.id, {
      code: "RUN_SERVICE_SHUTDOWN",
      message: "서버 종료로 대기 중 실행이 중단되었습니다.",
      retryable: true,
    }, [`대기 중이던 실행을 시작하지 않았습니다: ${reason}`]);
  }

  private async performClose(reason: string): Promise<void> {
    this.accepting = false;
    const shutdown = new RunServiceClosedError(`서버 종료로 실행이 중단되었습니다: ${reason}`);
    if (!this.shutdownController.signal.aborted) this.shutdownController.abort(shutdown);
    for (const active of this.activeExecutions.values()) {
      if (!active.controller.signal.aborted) active.controller.abort(shutdown);
    }

    await this.waitForTasks(this.admissionTasks);
    for (const active of this.activeExecutions.values()) {
      if (!active.controller.signal.aborted) active.controller.abort(shutdown);
    }

    const queued = this.queue.splice(0);
    const terminalizations = queued.map((item) => this.terminalizeQueuedRun(item, reason));
    const [terminalResults] = await Promise.all([
      Promise.allSettled(terminalizations),
      this.waitForOwnedWork(),
    ]);
    const failures = terminalResults.flatMap((result) => (
      result.status === "rejected" ? [result.reason] : []
    ));
    if (failures.length) {
      throw new AggregateError(failures, "대기 중 Run service 실행을 모두 종료하지 못했습니다.");
    }
  }

  async cancel(runId: string, ownerSubject: string): Promise<boolean> {
    this.assertAccepting();
    const task = this.cancelAccepted(runId, ownerSubject);
    return await this.trackTask(this.admissionTasks, task);
  }

  private async cancelAccepted(runId: string, ownerSubject: string): Promise<boolean> {
    if (this.options.jobRepository && await this.options.jobRepository.get(runId)) {
      return Boolean(await this.options.jobRepository.cancel(runId, ownerSubject));
    }
    const requested = await this.repository.requestCancellation(runId, ownerSubject);
    if (!requested) return false;
    this.activeExecutions.get(runId)?.controller.abort(new RunCancelledError("실행이 취소되었습니다."));
    const index = this.queue.findIndex((item) => item.run.id === runId);
    if (index >= 0) {
      this.queue.splice(index, 1);
      await this.repository.cancel(runId, { cancelled: true }, ["대기 중 사용자 요청으로 취소했습니다."]);
    }
    return true;
  }

  private activateContext(runId: string, deadlineAt = Number.POSITIVE_INFINITY): RunTaskContext {
    const controller = new AbortController();
    const active: { controller: AbortController; deadlineTimer?: NodeJS.Timeout } = { controller };
    if (Number.isFinite(deadlineAt)) {
      active.deadlineTimer = setTimeout(() => {
        controller.abort(new RunDeadlineExceededError("실행 제한 시간을 초과했습니다."));
      }, Math.max(0, deadlineAt - Date.now()));
      active.deadlineTimer.unref();
    }
    this.activeExecutions.set(runId, active);
    if (this.shutdownController.signal.aborted) {
      controller.abort(
        this.shutdownController.signal.reason instanceof Error
          ? this.shutdownController.signal.reason
          : new RunServiceClosedError("Run service가 종료되었습니다."),
      );
    }
    const isCancelled = async () => (
      controller.signal.aborted && controller.signal.reason instanceof RunCancelledError
    ) || this.repository.isCancellationRequested(runId);
    const context: RunTaskContext = {
      runId,
      signal: controller.signal,
      isCancelled,
      updateProgress: (progress, detail = {}) => {
        if (!this.accepting || controller.signal.aborted) {
          const error = controller.signal.reason instanceof Error
            ? controller.signal.reason
            : new RunServiceClosedError("Run service가 종료되었습니다.");
          const rejected = Promise.reject(error);
          void rejected.catch(() => undefined);
          return rejected;
        }
        if (this.activeExecutions.get(runId) !== active) {
          return Promise.resolve();
        }
        const task = this.repository.updateProgress(runId, { progress, ...detail });
        return this.trackTask(this.persistenceTasks, task);
      },
      throwIfCancelled: async () => {
        if (controller.signal.aborted) {
          if (controller.signal.reason instanceof Error) throw controller.signal.reason;
          throw new RunCancelledError("실행이 취소되었습니다.");
        }
        if (Date.now() >= deadlineAt) {
          const error = new RunDeadlineExceededError("실행 제한 시간을 초과했습니다.");
          controller.abort(error);
          throw error;
        }
        if (await isCancelled()) {
          const error = new RunCancelledError("실행이 취소되었습니다.");
          controller.abort(error);
          throw error;
        }
      },
    };
    return context;
  }

  private deactivateContext(runId: string, signal: AbortSignal): void {
    const active = this.activeExecutions.get(runId);
    if (!active || active.controller.signal !== signal) return;
    if (active.deadlineTimer) clearTimeout(active.deadlineTimer);
    this.activeExecutions.delete(runId);
  }

  private async persistArtifacts(
    runId: string,
    dataRevision: string,
    artifacts: NonNullable<RunTaskResult["artifacts"]>,
    context?: RunTaskContext,
  ): Promise<void> {
    for (const artifact of artifacts) {
      await context?.throwIfCancelled();
      await this.artifacts.put({ runId, dataRevision, ...artifact });
      await context?.throwIfCancelled();
    }
  }

  private async materializeExternalArtifacts(run: PortfolioRunRecord): Promise<void> {
    const jobs = this.options.jobRepository;
    if (!jobs || !await jobs.get(run.id)) return;
    const stored = await jobs.getOutput(run.id);
    if (!stored?.value.artifacts?.length) return;
    for (const artifact of stored.value.artifacts) {
      if (artifact.type.startsWith("worker-")) continue;
      if (!ARTIFACT_TYPES.has(artifact.type as ArtifactType)) {
        throw new Error(`지원하지 않는 worker artifact type입니다: ${artifact.type}`);
      }
      const type = artifact.type as ArtifactType;
      if (await this.artifacts.get(run.id, type)) continue;
      await this.artifacts.put({
        runId: run.id,
        dataRevision: run.dataRevision,
        type,
        content: artifact.content,
        rowCount: artifact.row_count,
      });
    }
    if (run.kind === "optimization" && this.options.optimizationRepository) {
      const input = await jobs.getInput(run.id);
      const candidatesArtifact = stored.value.artifacts.find((artifact) => artifact.type === "candidates");
      const candidates = Array.isArray(candidatesArtifact?.content)
        ? candidatesArtifact.content as Array<{
          weights: Record<string, number>;
          metrics: Record<string, unknown> & { robustScore?: number | null };
        }>
        : [];
      const payload = input?.value.payload;
      const optimization = payload?.optimization as Record<string, unknown> | undefined;
      const objective = typeof payload?.objective === "string" ? payload.objective : "robust_score";
      const settings = payload?.settings ?? {};
      await this.options.optimizationRepository.createRun({
        runId: run.id,
        objective,
        seed: Number(optimization?.seed ?? 0),
        candidateBudget: Number(optimization?.candidateBudget ?? candidates.length),
        objectiveVersion: run.engineVersion,
        settings,
      });
      if (await this.options.optimizationRepository.candidateCount(run.id) >= candidates.length) return;
      const frontierArtifact = stored.value.artifacts.find((artifact) => artifact.type === "worker-pareto-frontier");
      const frontier = Array.isArray(frontierArtifact?.content)
        ? frontierArtifact.content as Array<{ weights?: Record<string, number> }>
        : [];
      const pareto = new Set(frontier.map((candidate) => (
        JSON.stringify(Object.entries(candidate.weights ?? {}).sort(([left], [right]) => left.localeCompare(right)))
      )));
      await this.options.optimizationRepository.putCandidates(candidates.map((candidate, index) => {
        const signature = JSON.stringify(Object.entries(candidate.weights).sort(([left], [right]) => left.localeCompare(right)));
        return {
          runId: run.id,
          rank: index + 1,
          weights: candidate.weights,
          metrics: candidate.metrics,
          score: candidate.metrics.robustScore ?? Number.NEGATIVE_INFINITY,
          pareto: pareto.has(signature),
        };
      }));
    }
  }

  private drain(): void {
    if (!this.accepting) return;
    while (this.accepting && this.running < this.maxConcurrentRuns && this.queue.length) {
      const queued = this.queue.shift()!;
      this.running += 1;
      const task = this.runQueued(queued).finally(() => {
        this.running -= 1;
        this.drain();
      });
      this.trackTask(this.executionTasks, task);
      void task.catch((error) => {
        console.error(
          "[runs] background execution failed:",
          error instanceof Error ? error.message : "unknown error",
        );
      });
    }
  }

  private async runQueued(queued: QueuedTask): Promise<void> {
    const context = this.activateContext(queued.run.id, queued.deadlineAt);
    try {
      if (!await this.repository.markRunning(queued.run.id)) {
        if (await this.repository.isCancellationRequested(queued.run.id)) {
          await this.repository.cancel(queued.run.id, { cancelled: true }, ["대기 중 사용자 요청으로 취소했습니다."]);
        }
        return;
      }
      await this.repository.addEvent(queued.run.id, "started", { kind: queued.run.kind });
      await context.throwIfCancelled();
      const result = await queued.task(context);
      await context.throwIfCancelled();
      await this.persistArtifacts(queued.run.id, queued.run.dataRevision, result.artifacts ?? [], context);
      await context.throwIfCancelled();
      const stored = await this.repository.complete(queued.run.id, result.summary, result.result, result.warnings ?? []);
      if (!stored && await this.repository.isCancellationRequested(queued.run.id)) {
        throw new RunCancelledError("실행이 취소되었습니다.");
      }
    } catch (error) {
      if (error instanceof RunCancelledError
        || (context.signal.aborted && context.signal.reason instanceof RunCancelledError)
        || await this.repository.isCancellationRequested(queued.run.id)) {
        await this.repository.cancel(queued.run.id, { cancelled: true }, ["사용자 요청으로 실행을 취소했습니다."]);
      } else if (error instanceof RunServiceClosedError
        || (context.signal.aborted && context.signal.reason instanceof RunServiceClosedError)) {
        await this.waitForTasks(this.admissionTasks);
        if (await this.repository.isCancellationRequested(queued.run.id)) {
          await this.repository.cancel(
            queued.run.id,
            { cancelled: true },
            ["사용자 요청으로 실행을 취소했습니다."],
          );
        } else {
          await this.repository.fail(queued.run.id, {
            code: "RUN_SERVICE_SHUTDOWN",
            message: "서버 종료로 실행이 중단되었습니다.",
            retryable: true,
          }, ["중단 전 저장된 artifact는 보존되었습니다."]);
        }
      } else if (error instanceof RunDeadlineExceededError) {
        await this.repository.fail(queued.run.id, {
          code: "RUN_DEADLINE_EXCEEDED",
          message: "실행 제한 시간을 초과했습니다.",
          retryable: true,
        });
      } else {
        const current = await this.repository.get(queued.run.id, queued.ownerSubject);
        await this.repository.fail(
          queued.run.id,
          failedRunDiagnostic(error, queued.run, current),
        );
      }
    } finally {
      this.deactivateContext(queued.run.id, context.signal);
    }
  }
}
