import type { ArtifactType } from "../repositories/artifact-repository.js";
import type { RunRepository, PortfolioRunKind, PortfolioRunRecord } from "../repositories/run-repository.js";
import { requestHash, PORTFOLIO_ENGINE_VERSION, ServiceError } from "./service-envelope.js";
import type { ArtifactService } from "./artifact-service.js";

type RunTaskResult = {
  summary: unknown;
  result: unknown;
  warnings?: string[];
  artifacts?: Array<{ type: ArtifactType; content: unknown; rowCount?: number }>;
};

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
};

class RunCancelledError extends Error {}

export class RunService {
  private readonly queue: QueuedTask[] = [];
  private running = 0;

  constructor(
    private readonly repository: RunRepository,
    private readonly artifacts: ArtifactService,
    private readonly maxConcurrentRuns: number,
    private readonly maxRunsPerSubject: number,
  ) {}

  async initialize(): Promise<number> {
    return this.repository.recoverStaleRuns();
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
      requestHash: requestHash(input.config),
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
    const run = await this.create(input);
    if (run.status === "completed") return { run, reused: true };
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
      const completed = await input.task(this.context(run.id));
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
    task: (context: RunTaskContext) => Promise<RunTaskResult>;
  }): Promise<{ run: PortfolioRunRecord; reused: boolean }> {
    const run = await this.create(input);
    if (run.status !== "queued") return { run, reused: true };
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
    this.queue.push({ ownerSubject: input.ownerSubject, run, task: input.task });
    void this.drain();
    return { run, reused: false };
  }

  get(runId: string, ownerSubject: string): Promise<PortfolioRunRecord | undefined> {
    return this.repository.get(runId, ownerSubject);
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
      requestHash(input.config),
      input.dataRevision,
    );
    return run?.status === "completed" ? run : undefined;
  }

  async cancel(runId: string, ownerSubject: string): Promise<boolean> {
    const requested = await this.repository.requestCancellation(runId, ownerSubject);
    if (!requested) return false;
    const index = this.queue.findIndex((item) => item.run.id === runId);
    if (index >= 0) {
      this.queue.splice(index, 1);
      await this.repository.cancel(runId, { cancelled: true }, ["대기 중 사용자 요청으로 취소했습니다."]);
    }
    return true;
  }

  private context(runId: string): RunTaskContext {
    const isCancelled = () => this.repository.isCancellationRequested(runId);
    return {
      runId,
      isCancelled,
      updateProgress: (progress, detail = {}) => this.repository.updateProgress(runId, { progress, ...detail }),
      throwIfCancelled: async () => {
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
      const result = await queued.task(this.context(queued.run.id));
      await this.context(queued.run.id).throwIfCancelled();
      await this.persistArtifacts(queued.run.id, queued.run.dataRevision, result.artifacts ?? []);
      await this.repository.complete(queued.run.id, result.summary, result.result, result.warnings ?? []);
    } catch (error) {
      if (error instanceof RunCancelledError || await this.repository.isCancellationRequested(queued.run.id)) {
        await this.repository.cancel(queued.run.id, { cancelled: true }, ["사용자 요청으로 실행을 취소했습니다."]);
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
