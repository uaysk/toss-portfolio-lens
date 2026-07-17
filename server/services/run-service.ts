import type { ArtifactType } from "../repositories/artifact-repository.js";
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

type RunTaskResult = {
  summary: unknown;
  result: unknown;
  warnings?: string[];
  artifacts?: Array<{ type: ArtifactType; content: unknown; rowCount?: number }>;
};

const ARTIFACT_TYPES = new Set<ArtifactType>([
  "equity",
  "drawdown",
  "holdings",
  "trades",
  "rolling",
  "correlation",
  "risk-contribution",
  "monthly-returns",
  "cash-ledger",
  "cash-flows",
  "candidates",
  "walk-forward",
  "worker-pareto-frontier",
  "scenario-comparison",
  "monte-carlo-distribution",
  "monte-carlo-percentile-paths",
  "monte-carlo-sample-paths",
  "worker-metrics",
  "result",
]);

export type RunTaskContext = {
  runId: string;
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

class RunCancelledError extends Error {}
class RunDeadlineExceededError extends Error {}

export class RunService {
  private readonly queue: QueuedTask[] = [];
  private running = 0;

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

  async create(input: {
    ownerSubject: string;
    kind: PortfolioRunKind;
    config: unknown;
    dataRevision: string;
    totalCandidates?: number;
  }): Promise<PortfolioRunRecord> {
    return this.repository.create({
      kind: input.kind,
      ownerSubject: input.ownerSubject,
      requestHash: requestHash({ config: input.config, engineVersion: PORTFOLIO_ENGINE_VERSION }),
      dataRevision: input.dataRevision,
      engineVersion: PORTFOLIO_ENGINE_VERSION,
      config: input.config,
      totalCandidates: input.totalCandidates,
    });
  }

  async execute(input: {
    ownerSubject: string;
    kind: PortfolioRunKind;
    config: unknown;
    dataRevision: string;
    task: (context: RunTaskContext) => Promise<RunTaskResult>;
  }): Promise<{ run: PortfolioRunRecord; reused: boolean }> {
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
    try {
      const completed = await input.task(this.context(run.id, Date.now() + (this.options.runDeadlineMs ?? 120_000)));
      await this.persistArtifacts(run.id, input.dataRevision, completed.artifacts ?? []);
      await this.repository.complete(
        run.id,
        completed.summary,
        completed.result,
        completed.warnings ?? [],
      );
    } catch (error) {
      if (error instanceof RunCancelledError) {
        await this.repository.cancel(run.id, { cancelled: true }, ["사용자 요청으로 실행을 취소했습니다."]);
      } else if (error instanceof RunDeadlineExceededError) {
        await this.repository.fail(run.id, {
          code: "RUN_DEADLINE_EXCEEDED",
          message: "실행 제한 시간을 초과했습니다.",
          retryable: true,
        });
      } else {
        await this.repository.fail(run.id, error instanceof ServiceError ? error.detail : {
          code: "RUN_FAILED",
          message: "실행 중 내부 오류가 발생했습니다.",
          retryable: true,
        });
      }
      throw error;
    }
    const stored = await this.repository.get(run.id, input.ownerSubject);
    if (!stored) throw new Error("완료된 실행을 찾을 수 없습니다.");
    return { run: stored, reused: false };
  }

  async enqueue(input: {
    ownerSubject: string;
    kind: PortfolioRunKind;
    config: unknown;
    dataRevision: string;
    totalCandidates?: number;
    allowInlineInExternal?: boolean;
    task: (context: RunTaskContext) => Promise<RunTaskResult>;
  }): Promise<{ run: PortfolioRunRecord; reused: boolean }> {
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
    void this.drain();
    return { run, reused: false };
  }

  async get(runId: string, ownerSubject: string): Promise<PortfolioRunRecord | undefined> {
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

  async enqueueExternal(input: {
    ownerSubject: string;
    kind: PortfolioRunKind;
    config: unknown;
    dataRevision: string;
    payload: Record<string, unknown>;
    totalCandidates?: number;
    priority?: number;
    maxAttempts?: number;
  }): Promise<{ run: PortfolioRunRecord; reused: boolean }> {
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

  async executeExternal(input: {
    ownerSubject: string;
    kind: PortfolioRunKind;
    config: unknown;
    dataRevision: string;
    payload: Record<string, unknown>;
    totalCandidates?: number;
  }): Promise<{ run: PortfolioRunRecord; reused: boolean }> {
    const dispatched = await this.enqueueExternal(input);
    if (dispatched.run.status === "completed") return dispatched;
    const deadlineAt = Date.now() + (this.options.resultDeadlineMs ?? 300_000);
    const pollMs = this.options.resultPollMs ?? 250;
    while (Date.now() < deadlineAt) {
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
      await new Promise((resolve) => setTimeout(resolve, pollMs));
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

  async cancel(runId: string, ownerSubject: string): Promise<boolean> {
    if (this.options.jobRepository && await this.options.jobRepository.get(runId)) {
      return Boolean(await this.options.jobRepository.cancel(runId, ownerSubject));
    }
    const requested = await this.repository.requestCancellation(runId, ownerSubject);
    if (!requested) return false;
    const index = this.queue.findIndex((item) => item.run.id === runId);
    if (index >= 0) {
      this.queue.splice(index, 1);
      await this.repository.cancel(runId, { cancelled: true }, ["대기 중 사용자 요청으로 취소했습니다."]);
    }
    return true;
  }

  private context(runId: string, deadlineAt = Number.POSITIVE_INFINITY): RunTaskContext {
    const isCancelled = () => this.repository.isCancellationRequested(runId);
    return {
      runId,
      isCancelled,
      updateProgress: (progress, detail = {}) => this.repository.updateProgress(runId, { progress, ...detail }),
      throwIfCancelled: async () => {
        if (Date.now() >= deadlineAt) throw new RunDeadlineExceededError("실행 제한 시간을 초과했습니다.");
        if (await isCancelled()) throw new RunCancelledError("실행이 취소되었습니다.");
      },
    };
  }

  private async persistArtifacts(
    runId: string,
    dataRevision: string,
    artifacts: NonNullable<RunTaskResult["artifacts"]>,
  ): Promise<void> {
    for (const artifact of artifacts) {
      await this.artifacts.put({ runId, dataRevision, ...artifact });
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
          metrics: Record<string, number | null> & { robustScore?: number | null };
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

  private async drain(): Promise<void> {
    while (this.running < this.maxConcurrentRuns && this.queue.length) {
      const queued = this.queue.shift()!;
      this.running += 1;
      void this.runQueued(queued).finally(() => {
        this.running -= 1;
        void this.drain();
      });
    }
  }

  private async runQueued(queued: QueuedTask): Promise<void> {
    if (!await this.repository.markRunning(queued.run.id)) return;
    await this.repository.addEvent(queued.run.id, "started", { kind: queued.run.kind });
    try {
      const result = await queued.task(this.context(queued.run.id, queued.deadlineAt));
      await this.context(queued.run.id, queued.deadlineAt).throwIfCancelled();
      await this.persistArtifacts(queued.run.id, queued.run.dataRevision, result.artifacts ?? []);
      await this.repository.complete(queued.run.id, result.summary, result.result, result.warnings ?? []);
    } catch (error) {
      if (error instanceof RunCancelledError || await this.repository.isCancellationRequested(queued.run.id)) {
        await this.repository.cancel(queued.run.id, { cancelled: true }, ["사용자 요청으로 실행을 취소했습니다."]);
      } else if (error instanceof RunDeadlineExceededError) {
        await this.repository.fail(queued.run.id, {
          code: "RUN_DEADLINE_EXCEEDED",
          message: "실행 제한 시간을 초과했습니다.",
          retryable: true,
        });
      } else {
        await this.repository.fail(queued.run.id, error instanceof ServiceError ? error.detail : {
          code: "RUN_FAILED",
          message: "실행 중 내부 오류가 발생했습니다.",
          retryable: true,
        });
      }
    }
  }
}
