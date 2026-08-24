import { afterEach, describe, expect, it } from "vitest";
import { PGliteDatabase } from "../../test-support/pglite-database.js";
import { OptimizationRepository } from "./optimization-repository.js";
import { RunRepository } from "./run-repository.js";

describe("OptimizationRepository candidate paging", () => {
  let database: PGliteDatabase | undefined;

  afterEach(async () => {
    await database?.close();
    database = undefined;
  });

  it("1,000개를 넘는 후보를 순번으로 조회하고 복제용 전체 목록을 반환한다", async () => {
    database = new PGliteDatabase();
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

  it("순위 없는 후보는 점수순으로 마지막에 두고 정렬 인덱스 하나만 유지한다", async () => {
    database = new PGliteDatabase();
    const runs = new RunRepository(database);
    const repository = new OptimizationRepository(database);
    await runs.initialize();
    await repository.initialize();
    const run = await runs.create({
      kind: "optimization",
      ownerSubject: "owner-order",
      requestHash: "d".repeat(64),
      dataRevision: "revision-order",
      engineVersion: "engine-order",
      config: {},
      totalCandidates: 4,
    });
    await repository.createRun({
      runId: run.id,
      objective: "robust_score",
      seed: 9,
      candidateBudget: 4,
      objectiveVersion: "engine-order",
      settings: {},
    });
    await repository.putCandidates([
      { runId: run.id, weights: { AAA: 0.1 }, metrics: {}, score: 0.2, pareto: true },
      { runId: run.id, rank: 2, weights: { AAA: 0.2 }, metrics: {}, score: 0.4, pareto: false },
      { runId: run.id, weights: { AAA: 0.3 }, metrics: {}, score: 0.8, pareto: true },
      { runId: run.id, rank: 1, weights: { AAA: 0.4 }, metrics: {}, score: 0.1, pareto: true },
    ]);

    expect((await repository.listCandidates(run.id)).map(({ rank, score }) => ({ rank, score })))
      .toEqual([
        { rank: 1, score: 0.1 },
        { rank: 2, score: 0.4 },
        { rank: undefined, score: 0.8 },
        { rank: undefined, score: 0.2 },
      ]);
    expect((await repository.listParetoCandidates(run.id)).map(({ rank, score }) => ({ rank, score })))
      .toEqual([
        { rank: 1, score: 0.1 },
        { rank: undefined, score: 0.8 },
        { rank: undefined, score: 0.2 },
      ]);

    const indexes = await database.query<{ indexname: string; indexdef: string }>(`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = current_schema()
        AND tablename = 'portfolio_optimization_candidates'
    `);
    expect(indexes.some(({ indexname, indexdef }) => (
      indexname === "idx_optimization_candidate_order"
      && indexdef.includes("(run_id, candidate_rank, score DESC)")
    ))).toBe(true);
    expect(indexes.some(({ indexname }) => indexname === "idx_optimization_candidate_rank"))
      .toBe(false);
  });
});
