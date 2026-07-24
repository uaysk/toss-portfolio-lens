import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteDatabase } from "../database.js";
import { ArtifactRepository } from "../repositories/artifact-repository.js";
import { RunRepository } from "../repositories/run-repository.js";
import { ArtifactService } from "./artifact-service.js";
import { PORTFOLIO_ENGINE_VERSION, requestHash } from "./service-envelope.js";
import { RunService } from "./run-service.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("RunService persistence and cancellation", () => {
  const databases: SqliteDatabase[] = [];

  afterEach(async () => {
    await Promise.all(databases.splice(0).map((database) => database.close()));
  });

  async function setup(maxConcurrentRuns = 1) {
    const database = new SqliteDatabase(":memory:");
    databases.push(database);
    const runs = new RunRepository(database);
    const artifacts = new ArtifactRepository(database);
    await runs.initialize();
    await artifacts.initialize();
    const service = new RunService(runs, new ArtifactService(artifacts, 1_000, 204_800), maxConcurrentRuns, 2);
    return { database, runs, artifacts, service };
  }

  it("동일 request hash와 data revision의 완료 run을 멱등하게 재사용한다", async () => {
    const { service } = await setup();
    const task = vi.fn().mockResolvedValue({ summary: { sharpe: 1 }, result: { ok: true } });
    const first = await service.execute({
      ownerSubject: "owner",
      kind: "backtest",
      config: { assets: ["A"] },
      dataRevision: "revision-1",
      task,
    });
    const secondTask = vi.fn().mockRejectedValue(new Error("must not run"));
    const second = await service.execute({
      ownerSubject: "owner",
      kind: "backtest",
      config: { assets: ["A"] },
      dataRevision: "revision-1",
      task: secondTask,
    });
    expect(second.run.id).toBe(first.run.id);
    expect(second.reused).toBe(true);
    expect(task).toHaveBeenCalledOnce();
    expect(secondTask).not.toHaveBeenCalled();
  });

  it("동시 preflight 실패는 정확히 한 failed run과 한 쌍의 실패 event만 생성한다", async () => {
    const { runs, service } = await setup();
    const input = {
      ownerSubject: "owner",
      kind: "optimization" as const,
      config: { symbols: ["AAA", "BBB"], seed: 19 },
      dataRevision: "preflight-revision",
      totalCandidates: 32,
      error: { code: "FX_HISTORY_UNAVAILABLE", message: "missing FX", retryable: false },
    };

    const results = await Promise.all(Array.from({ length: 8 }, () => service.recordPreflightFailure(input)));
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(results.map((result) => result.run.id)).size).toBe(1);
    expect(results[0]!.run).toMatchObject({
      status: "failed",
      error: input.error,
      totalCandidates: 32,
    });
    const events = await runs.getEvents(results[0]!.run.id, "owner");
    expect(events.filter((event) => event.type === "created")).toHaveLength(1);
    expect(events.filter((event) => event.type === "preflight_failed")).toHaveLength(1);
    expect(events.filter((event) => event.type === "failed")).toHaveLength(1);
  });

  it("기존 queued/running/completed run은 동시 preflight 실패 기록으로 상태나 event가 바뀌지 않는다", async () => {
    const { runs, service } = await setup();
    for (const [index, status] of (["queued", "running", "completed"] as const).entries()) {
      const config = { symbols: ["AAA", "BBB"], seed: 100 + index };
      const dataRevision = `existing-${status}`;
      const existing = await service.create({
        ownerSubject: "owner",
        kind: "optimization",
        config,
        dataRevision,
        totalCandidates: 10,
      });
      if (status === "running") expect(await runs.markRunning(existing.id, 200 + index)).toBe(true);
      if (status === "completed") {
        expect(await runs.complete(existing.id, { done: true }, { candidates: [] }, [], 200 + index)).toBe(true);
      }
      const before = await runs.get(existing.id, "owner");
      const eventsBefore = await runs.getEvents(existing.id, "owner");

      const results = await Promise.all(Array.from({ length: 4 }, () => service.recordPreflightFailure({
        ownerSubject: "owner",
        kind: "optimization",
        config,
        dataRevision,
        totalCandidates: 10,
        error: { code: "PREFLIGHT_FAILED", message: "must not replace", retryable: false },
      })));

      expect(results.every((result) => !result.created && result.run.id === existing.id)).toBe(true);
      expect(await runs.get(existing.id, "owner")).toEqual(before);
      expect(await runs.getEvents(existing.id, "owner")).toEqual(eventsBefore);
    }
  });

  it(".2 run을 보존하면서 동일 입력의 .3 run을 새로 만든다", async () => {
    const { runs, service } = await setup();
    const config = { assets: ["AAA"], seed: 7 };
    const oldEngineVersion = "portfolio-lens-rust-2026.07.2";
    const old = await runs.create({
      kind: "backtest",
      ownerSubject: "owner",
      requestHash: requestHash({ config, engineVersion: oldEngineVersion }),
      dataRevision: "revision-engine",
      engineVersion: oldEngineVersion,
      config,
    });
    await runs.complete(old.id, { old: true }, { points: [] });

    const current = await service.create({
      ownerSubject: "owner",
      kind: "backtest",
      config,
      dataRevision: "revision-engine",
    });

    expect(PORTFOLIO_ENGINE_VERSION).toBe("portfolio-lens-rust-2026.07.5");
    expect(current.id).not.toBe(old.id);
    expect(current).toMatchObject({ status: "queued", engineVersion: PORTFOLIO_ENGINE_VERSION });
    expect(await runs.get(old.id, "owner")).toMatchObject({ status: "completed", engineVersion: oldEngineVersion });
  });

  it("중첩된 outlook·Walk-forward·Monte Carlo seed를 manifest에 모두 고정한다", async () => {
    const { service } = await setup();
    const created = await service.create({
      ownerSubject: "owner",
      kind: "outlook",
      config: {
        optimization: { seed: 11 },
        walkForward: { seeds: [12, 13] },
        monteCarlo: { seed: 14 },
      },
      dataRevision: "revision-seeds",
    });
    expect(created.manifest).toMatchObject({
      reproducibility: {
        seed: null,
        seed_configuration: {
          "optimization.seed": 11,
          "walkForward.seeds": [12, 13],
          "monteCarlo.seed": 14,
        },
      },
    });
  });

  it("실행 중 취소 요청을 확인하고 이미 저장된 상태를 cancelled로 보존한다", async () => {
    const { service } = await setup();
    let release!: () => void;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    const queued = await service.enqueue({
      ownerSubject: "owner",
      kind: "optimization",
      config: { seed: 1 },
      dataRevision: "revision-1",
      totalCandidates: 10,
      task: async (context) => {
        started();
        await releasePromise;
        await context.throwIfCancelled();
        return { summary: {}, result: {} };
      },
    });
    await startedPromise;
    expect(await service.cancel(queued.run.id, "owner")).toBe(true);
    release();

    let stored = await service.get(queued.run.id, "owner");
    for (let attempt = 0; attempt < 50 && stored?.status !== "cancelled"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
      stored = await service.get(queued.run.id, "owner");
    }
    expect(stored?.status).toBe("cancelled");
    expect(stored?.summary).toEqual({ cancelled: true });

    const retryTask = vi.fn().mockResolvedValue({ summary: { retried: true }, result: { ok: true } });
    const retried = await service.enqueue({
      ownerSubject: "owner",
      kind: "optimization",
      config: { seed: 1 },
      dataRevision: "revision-1",
      totalCandidates: 10,
      task: retryTask,
    });
    expect(retried.run.id).toBe(queued.run.id);
    expect(retried.reused).toBe(false);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      stored = await service.get(queued.run.id, "owner");
      if (stored?.status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect(stored).toMatchObject({ status: "completed", summary: { retried: true }, result: { ok: true } });
    expect(stored?.error).toBeUndefined();
    expect(retryTask).toHaveBeenCalledOnce();
  });

  it("실행 중 취소 요청을 task AbortSignal에 즉시 전달한다", async () => {
    const { service } = await setup();
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    let observedSignal: AbortSignal | undefined;
    const queued = await service.enqueue({
      ownerSubject: "owner",
      kind: "optimization",
      config: { seed: 2 },
      dataRevision: "revision-2",
      totalCandidates: 100_000,
      task: async (context) => {
        observedSignal = context.signal;
        started();
        return new Promise<never>((_resolve, reject) => {
          const rejectFromSignal = () => reject(context.signal.reason);
          if (context.signal.aborted) rejectFromSignal();
          else context.signal.addEventListener("abort", rejectFromSignal, { once: true });
        });
      },
    });
    await startedPromise;

    expect(await service.cancel(queued.run.id, "owner")).toBe(true);
    expect(observedSignal?.aborted).toBe(true);

    let stored = await service.get(queued.run.id, "owner");
    for (let attempt = 0; attempt < 50 && stored?.status !== "cancelled"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
      stored = await service.get(queued.run.id, "owner");
    }
    expect(stored).toMatchObject({ status: "cancelled", summary: { cancelled: true } });
  });

  it("queue에서 꺼낸 직후 markRunning 전 취소해도 task를 시작하지 않고 cancelled로 끝낸다", async () => {
    const { runs, service } = await setup();
    let enteredMarkRunning!: () => void;
    let releaseMarkRunning!: () => void;
    const markRunningEntered = new Promise<void>((resolve) => { enteredMarkRunning = resolve; });
    const markRunningReleased = new Promise<void>((resolve) => { releaseMarkRunning = resolve; });
    const originalMarkRunning = runs.markRunning.bind(runs);
    vi.spyOn(runs, "markRunning").mockImplementation(async (id, now) => {
      enteredMarkRunning();
      await markRunningReleased;
      return originalMarkRunning(id, now);
    });
    const task = vi.fn().mockResolvedValue({ summary: {}, result: {} });
    const queued = await service.enqueue({
      ownerSubject: "owner",
      kind: "optimization",
      config: { seed: 3 },
      dataRevision: "revision-3",
      task,
    });

    await markRunningEntered;
    expect(await service.cancel(queued.run.id, "owner")).toBe(true);
    releaseMarkRunning();

    let stored = await service.get(queued.run.id, "owner");
    for (let attempt = 0; attempt < 50 && stored?.status !== "cancelled"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
      stored = await service.get(queued.run.id, "owner");
    }
    expect(stored).toMatchObject({ status: "cancelled", summary: { cancelled: true } });
    expect(task).not.toHaveBeenCalled();
  });

  it("artifact 저장 후 complete 직전 취소해도 completed로 덮어쓰지 않는다", async () => {
    const { runs, artifacts, service } = await setup();
    let enteredComplete!: () => void;
    let releaseComplete!: () => void;
    const completeEntered = new Promise<void>((resolve) => { enteredComplete = resolve; });
    const completeReleased = new Promise<void>((resolve) => { releaseComplete = resolve; });
    const originalComplete = runs.complete.bind(runs);
    vi.spyOn(runs, "complete").mockImplementation(async (...args) => {
      enteredComplete();
      await completeReleased;
      return originalComplete(...args);
    });
    const queued = await service.enqueue({
      ownerSubject: "owner",
      kind: "optimization",
      config: { seed: 4 },
      dataRevision: "revision-4",
      task: async () => ({
        summary: { candidateCount: 1 },
        result: { ok: true },
        artifacts: [{ type: "result", content: { ok: true } }],
      }),
    });

    await completeEntered;
    expect(await artifacts.get(queued.run.id, "result")).toMatchObject({ content: { ok: true } });
    expect(await service.cancel(queued.run.id, "owner")).toBe(true);
    releaseComplete();

    let stored = await service.get(queued.run.id, "owner");
    for (let attempt = 0; attempt < 50 && stored?.status !== "cancelled"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
      stored = await service.get(queued.run.id, "owner");
    }
    expect(stored).toMatchObject({ status: "cancelled", summary: { cancelled: true } });
    const events = await runs.getEvents(queued.run.id, "owner");
    expect(events.map((event) => event.type)).toContain("cancelled");
    expect(events.map((event) => event.type)).not.toContain("completed");
  });

  it("실패한 동일 execute 요청을 같은 run id로 다시 실행한다", async () => {
    const { service } = await setup();
    await expect(service.execute({
      ownerSubject: "owner",
      kind: "backtest",
      config: { assets: ["A"] },
      dataRevision: "revision-1",
      task: vi.fn().mockRejectedValue(new Error("synthetic failure")),
    })).rejects.toThrow("synthetic failure");
    const failed = await service.findReusable({
      ownerSubject: "owner",
      kind: "backtest",
      config: { assets: ["A"] },
      dataRevision: "revision-1",
    });
    expect(failed).toBeUndefined();
    const terminal = await service.create({
      ownerSubject: "owner",
      kind: "backtest",
      config: { assets: ["A"] },
      dataRevision: "revision-1",
    });
    expect(terminal.status).toBe("failed");
    expect(terminal.error).toMatchObject({
      code: "RUN_FAILED",
      message: "synthetic failure",
      phase: "compute_or_artifact_persistence",
      error_type: "Error",
      completed_candidate_count: 0,
    });
    expect((terminal.error as { stack_trace?: string }).stack_trace).toContain("synthetic failure");
    const retryTask = vi.fn().mockResolvedValue({ summary: { retried: true }, result: { ok: true } });
    const retried = await service.execute({
      ownerSubject: "owner",
      kind: "backtest",
      config: { assets: ["A"] },
      dataRevision: "revision-1",
      task: retryTask,
    });
    expect(retried.run.id).toBe(terminal.id);
    expect(retried.reused).toBe(false);
    expect(retried.run).toMatchObject({ status: "completed", summary: { retried: true }, result: { ok: true } });
    expect(retried.run.error).toBeUndefined();
    expect(retryTask).toHaveBeenCalledOnce();
  });

  it("close는 활성 실행을 중단하고 대기 실행을 terminalize한 뒤에만 같은 Promise로 완료된다", async () => {
    const { runs, artifacts, service } = await setup();
    const activeStarted = deferred();
    const failuresStarted = deferred();
    const releaseFailures = deferred();
    const activeTask = vi.fn(async (context) => {
      activeStarted.resolve();
      await new Promise<void>((resolve) => {
        if (context.signal.aborted) resolve();
        else context.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      await context.updateProgress(0.75);
      return { summary: { shouldNotComplete: true }, result: {} };
    });
    const queuedTask = vi.fn().mockResolvedValue({ summary: {}, result: {} });
    const updateProgress = vi.spyOn(runs, "updateProgress");
    const addEvent = vi.spyOn(runs, "addEvent");
    const complete = vi.spyOn(runs, "complete");
    const originalFail = runs.fail.bind(runs);
    let failureCount = 0;
    const fail = vi.spyOn(runs, "fail").mockImplementation(async (...args) => {
      failureCount += 1;
      if (failureCount === 2) failuresStarted.resolve();
      await releaseFailures.promise;
      return originalFail(...args);
    });

    const active = await service.enqueue({
      ownerSubject: "owner",
      kind: "optimization",
      config: { seed: 31 },
      dataRevision: "shutdown-active",
      task: activeTask,
    });
    await activeStarted.promise;
    const queued = await service.enqueue({
      ownerSubject: "owner",
      kind: "optimization",
      config: { seed: 32 },
      dataRevision: "shutdown-queued",
      task: queuedTask,
    });

    const firstClose = service.close("SIGTERM");
    const secondClose = service.close("SIGINT");
    expect(secondClose).toBe(firstClose);
    let closeSettled = false;
    void firstClose.then(
      () => { closeSettled = true; },
      () => { closeSettled = true; },
    );
    await failuresStarted.promise;
    await Promise.resolve();
    expect(closeSettled).toBe(false);

    releaseFailures.resolve();
    await firstClose;
    expect(closeSettled).toBe(true);
    expect(activeTask).toHaveBeenCalledOnce();
    expect(queuedTask).not.toHaveBeenCalled();
    expect(updateProgress).not.toHaveBeenCalled();
    expect(await artifacts.get(active.run.id, "result")).toBeUndefined();
    expect(await runs.get(active.run.id, "owner")).toMatchObject({
      status: "failed",
      error: { code: "RUN_SERVICE_SHUTDOWN", retryable: true },
    });
    expect(await runs.get(queued.run.id, "owner")).toMatchObject({
      status: "failed",
      error: { code: "RUN_SERVICE_SHUTDOWN", retryable: true },
    });

    const mutationCounts = {
      addEvent: addEvent.mock.calls.length,
      complete: complete.mock.calls.length,
      fail: fail.mock.calls.length,
      updateProgress: updateProgress.mock.calls.length,
    };
    const rejectedExecuteTask = vi.fn();
    const rejectedEnqueueTask = vi.fn();
    await expect(service.execute({
      ownerSubject: "owner",
      kind: "backtest",
      config: { assets: ["AAA"] },
      dataRevision: "after-close-execute",
      task: rejectedExecuteTask,
    })).rejects.toThrow("종료");
    await expect(service.enqueue({
      ownerSubject: "owner",
      kind: "backtest",
      config: { assets: ["AAA"] },
      dataRevision: "after-close-enqueue",
      task: rejectedEnqueueTask,
    })).rejects.toThrow("종료");
    await expect(service.enqueueExternal({
      ownerSubject: "owner",
      kind: "backtest",
      config: { assets: ["AAA"] },
      dataRevision: "after-close-external-enqueue",
      payload: {},
    })).rejects.toThrow("종료");
    await expect(service.executeExternal({
      ownerSubject: "owner",
      kind: "backtest",
      config: { assets: ["AAA"] },
      dataRevision: "after-close-external-execute",
      payload: {},
    })).rejects.toThrow("종료");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(rejectedExecuteTask).not.toHaveBeenCalled();
    expect(rejectedEnqueueTask).not.toHaveBeenCalled();
    expect({
      addEvent: addEvent.mock.calls.length,
      complete: complete.mock.calls.length,
      fail: fail.mock.calls.length,
      updateProgress: updateProgress.mock.calls.length,
    }).toEqual(mutationCounts);
  });

  it("close는 이미 시작된 fire-and-forget progress 저장과 종료 상태 저장을 모두 기다린다", async () => {
    const { runs, service } = await setup();
    const progressStarted = deferred();
    const releaseProgress = deferred();
    const originalUpdateProgress = runs.updateProgress.bind(runs);
    vi.spyOn(runs, "updateProgress").mockImplementation(async (...args) => {
      progressStarted.resolve();
      await releaseProgress.promise;
      return originalUpdateProgress(...args);
    });
    const active = await service.enqueue({
      ownerSubject: "owner",
      kind: "optimization",
      config: { seed: 33 },
      dataRevision: "shutdown-progress-tail",
      task: async (context) => {
        void context.updateProgress(0.5, { completedCandidates: 1, totalCandidates: 2 });
        await new Promise<void>((resolve) => {
          if (context.signal.aborted) resolve();
          else context.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        await context.throwIfCancelled();
        return { summary: {}, result: {} };
      },
    });
    await progressStarted.promise;

    const closing = service.close();
    let settled = false;
    void closing.then(
      () => { settled = true; },
      () => { settled = true; },
    );
    await Promise.resolve();
    expect(settled).toBe(false);
    releaseProgress.resolve();
    await closing;
    expect(await runs.get(active.run.id, "owner")).toMatchObject({
      status: "failed",
      error: { code: "RUN_SERVICE_SHUTDOWN" },
    });
  });

  it("완료 후 보관된 context의 progress 호출은 저장소를 다시 쓰지 않는다", async () => {
    const { runs, service } = await setup();
    const updateProgress = vi.spyOn(runs, "updateProgress");
    let lateProgress!: () => Promise<void>;
    const completed = await service.execute({
      ownerSubject: "owner",
      kind: "backtest",
      config: { assets: ["AAA"], seed: 37 },
      dataRevision: "late-progress-after-deactivate",
      task: async (context) => {
        lateProgress = () => context.updateProgress(0.25, { completedCandidates: 1 });
        return { summary: { ok: true }, result: { ok: true } };
      },
    });
    const writesAtCompletion = updateProgress.mock.calls.length;

    await expect(lateProgress()).resolves.toBeUndefined();
    expect(updateProgress).toHaveBeenCalledTimes(writesAtCompletion);
    expect(await runs.get(completed.run.id, "owner")).toMatchObject({
      status: "completed",
      progress: 1,
    });
  });

  it("close가 markRunning 중 시작되면 task를 호출하지 않고 늦게 생성된 context도 종료한다", async () => {
    const { runs, service } = await setup();
    const markRunningStarted = deferred();
    const releaseMarkRunning = deferred();
    const originalMarkRunning = runs.markRunning.bind(runs);
    vi.spyOn(runs, "markRunning").mockImplementation(async (...args) => {
      markRunningStarted.resolve();
      await releaseMarkRunning.promise;
      return originalMarkRunning(...args);
    });
    const config = { assets: ["AAA"], seed: 34 };
    const task = vi.fn().mockResolvedValue({ summary: {}, result: {} });
    const execution = service.execute({
      ownerSubject: "owner",
      kind: "backtest",
      config,
      dataRevision: "shutdown-late-context",
      task,
    });
    const executionOutcome = execution.then(
      () => undefined,
      (error: unknown) => error,
    );
    await markRunningStarted.promise;
    const closing = service.close();
    releaseMarkRunning.resolve();

    expect(await executionOutcome).toBeInstanceOf(Error);
    await closing;
    expect(task).not.toHaveBeenCalled();
    const stored = await runs.findByRequest(
      "owner",
      "backtest",
      requestHash({ config, engineVersion: PORTFOLIO_ENGINE_VERSION }),
      "shutdown-late-context",
    );
    expect(stored).toMatchObject({
      status: "failed",
      error: { code: "RUN_SERVICE_SHUTDOWN", retryable: true },
    });
  });

  it("close는 대기 run의 이미 기록된 사용자 취소 의도를 shutdown 실패로 덮어쓰지 않는다", async () => {
    const { runs, service } = await setup();
    const activeStarted = deferred();
    const active = await service.enqueue({
      ownerSubject: "owner",
      kind: "optimization",
      config: { seed: 35 },
      dataRevision: "shutdown-cancel-priority-active",
      task: async (context) => {
        activeStarted.resolve();
        await new Promise<void>((resolve) => {
          if (context.signal.aborted) resolve();
          else context.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        await context.throwIfCancelled();
        return { summary: {}, result: {} };
      },
    });
    await activeStarted.promise;
    const queuedTask = vi.fn().mockResolvedValue({ summary: {}, result: {} });
    const queued = await service.enqueue({
      ownerSubject: "owner",
      kind: "optimization",
      config: { seed: 36 },
      dataRevision: "shutdown-cancel-priority-queued",
      task: queuedTask,
    });
    expect(await runs.requestCancellation(queued.run.id, "owner")).toBe(true);

    await service.close();
    expect(await runs.get(active.run.id, "owner")).toMatchObject({
      status: "failed",
      error: { code: "RUN_SERVICE_SHUTDOWN" },
    });
    expect(await runs.get(queued.run.id, "owner")).toMatchObject({
      status: "cancelled",
      summary: { cancelled: true },
    });
    expect(queuedTask).not.toHaveBeenCalled();
  });

  it("서버 재시작 시 queued/running/cancel_requested run을 failed로 복구한다", async () => {
    const { runs, service } = await setup();
    const queued = await service.create({
      ownerSubject: "owner",
      kind: "walk_forward",
      config: { seed: 2 },
      dataRevision: "revision-1",
    });
    expect(await runs.markRunning(queued.id)).toBe(true);
    expect(await service.initialize()).toBe(1);
    expect(await service.get(queued.id, "owner")).toMatchObject({
      status: "failed",
      error: { code: "STALE_RUN_RECOVERED", retryable: true },
    });
  });
});
