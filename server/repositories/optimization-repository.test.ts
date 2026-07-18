import { afterEach, describe, expect, it } from "vitest";
import { SqliteDatabase } from "../database.js";
import { OptimizationRepository } from "./optimization-repository.js";
import { RunRepository } from "./run-repository.js";

describe("OptimizationRepository candidate paging", () => {
  let database: SqliteDatabase | undefined;

  afterEach(async () => {
    await database?.close();
    database = undefined;
  });

  it("1,000개를 넘는 후보를 순번으로 조회하고 복제용 전체 목록을 반환한다", async () => {
    database = new SqliteDatabase(":memory:");
    const runs = new RunRepository(database);
    const repository = new OptimizationRepository(database);
    await runs.initialize();
    await repository.initialize();
    const run = await runs.create({
      kind: "optimization",
      ownerSubject: "owner-a",
      requestHash: "c".repeat(64),
      dataRevision: "revision-a",
      engineVersion: "engine-a",
      config: { symbols: ["AAA", "BBB"] },
      totalCandidates: 1_005,
    });
    await repository.createRun({
      runId: run.id,
      objective: "robust_score",
      seed: 7,
      candidateBudget: 1_005,
      objectiveVersion: "engine-a",
      settings: {},
    });
    await repository.putCandidates(Array.from({ length: 1_005 }, (_, index) => ({
      runId: run.id,
      rank: index + 1,
      weights: { AAA: (index + 1) / 2_010, BBB: 1 - (index + 1) / 2_010 },
      metrics: { robustScore: 1 - index / 2_010 },
      score: 1 - index / 2_010,
      pareto: true,
    })));

    expect(await repository.candidateCount(run.id)).toBe(1_005);
    await expect(repository.getCandidateAt(run.id, 1_000)).resolves.toMatchObject({ rank: 1_001 });
    await expect(repository.getCandidateAt(run.id, 1_000, true)).resolves.toMatchObject({ rank: 1_001, pareto: true });
    await expect(repository.listCandidates(run.id, 1_005)).resolves.toHaveLength(1_005);
  });
});
