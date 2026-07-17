import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteDatabase } from "../database.js";
import { ArtifactRepository } from "../repositories/artifact-repository.js";
import { RunRepository } from "../repositories/run-repository.js";
import { ArtifactService } from "./artifact-service.js";
import { RunService } from "./run-service.js";

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
