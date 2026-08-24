import { afterEach, describe, expect, it } from "vitest";
import { PGliteDatabase } from "../../test-support/pglite-database.js";
import type { DatabaseRow, RelationalDatabase, RunResult } from "../database.js";
import { RunRepository } from "./run-repository.js";

describe("RunRepository management", () => {
  let database: PGliteDatabase | undefined;

  afterEach(async () => {
    await database?.close();
    database = undefined;
  });

  async function setup() {
    database = new PGliteDatabase();
    const repository = new RunRepository(database);
    await repository.initialize();
    return repository;
  }

  it("standalone initialize는 migration을 적용하고 선적용 경로는 DDL을 반복하지 않는다", async () => {
    database = new PGliteDatabase();
    await expect(new RunRepository(database).initialize()).resolves.toBeUndefined();
    expect(await database.query<{ table_name: string }>(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = current_schema()
        AND table_name IN ('portfolio_backtest_runs', 'portfolio_run_events')
      ORDER BY table_name
    `)).toEqual([
      { table_name: "portfolio_backtest_runs" },
      { table_name: "portfolio_run_events" },
    ]);

    const unexpectedSql = (): never => {
      throw new Error("migration 선적용 경로에서 repository SQL이 실행되었습니다.");
    };
    const preinitializedDatabase: RelationalDatabase = {
      async query<T extends DatabaseRow>(): Promise<T[]> {
        return unexpectedSql();
      },
      async run(): Promise<RunResult> {
        return unexpectedSql();
      },
      async transaction<T>(): Promise<T> {
        return unexpectedSql();
      },
      async close(): Promise<void> {},
    };
    await expect(new RunRepository(preinitializedDatabase).initialize({
      migrationsAlreadyApplied: true,
    })).resolves.toBeUndefined();
  });

  it("관리 컬럼이 없는 기존 run 테이블도 migration 후 목록 index를 생성한다", async () => {
    database = new PGliteDatabase();
    await database.run(`
      CREATE TABLE portfolio_backtest_runs (
        run_id TEXT PRIMARY KEY,
        run_kind TEXT NOT NULL,
        owner_subject TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        data_revision TEXT NOT NULL,
        engine_version TEXT NOT NULL,
        status TEXT NOT NULL,
        progress REAL NOT NULL DEFAULT 0,
        completed_candidates INTEGER NOT NULL DEFAULT 0,
        total_candidates INTEGER NOT NULL DEFAULT 0,
        current_validation_window TEXT,
        input_json TEXT NOT NULL,
        summary_json TEXT,
        result_json TEXT,
        error_json TEXT,
        warnings_json TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        started_at BIGINT,
        finished_at BIGINT,
        updated_at BIGINT NOT NULL,
        UNIQUE(owner_subject, run_kind, request_hash, data_revision)
      )
    `);

    await expect(new RunRepository(database).initialize()).resolves.toBeUndefined();
    const indexes = await database.query<{ index_name: string }>(`
      SELECT indexname AS index_name
      FROM pg_indexes
      WHERE schemaname = current_schema() AND indexname = 'idx_portfolio_run_list'
    `);
    expect(indexes).toEqual([{ index_name: "idx_portfolio_run_list" }]);
  }, 15_000);

  it("이름·tag·archive·cursor 검색과 owner별 event를 제공한다", async () => {
    const repository = await setup();
    const first = await repository.create({
      kind: "optimization",
      ownerSubject: "owner-a",
      requestHash: "a".repeat(64),
      dataRevision: "revision-a",
      engineVersion: "engine-a",
      config: { symbols: ["AAA", "BBB"] },
      name: "첫 최적화",
      tags: ["research"],
      now: 100,
    });
    const second = await repository.create({
      kind: "backtest",
      ownerSubject: "owner-a",
      requestHash: "b".repeat(64),
      dataRevision: "revision-a",
      engineVersion: "engine-a",
      config: { assets: ["AAA"] },
      name: "두 번째 백테스트",
      tags: ["saved", "research"],
      now: 200,
    });
    await repository.create({
      kind: "backtest",
      ownerSubject: "owner-b",
      requestHash: "c".repeat(64),
      dataRevision: "revision-b",
      engineVersion: "engine-a",
      config: {},
      name: "다른 소유자",
      now: 300,
    });

    expect(await repository.storeManifest(first.id, "owner-a", { git_sha: "abc" }, 105)).toEqual({ git_sha: "abc" });
    expect(await repository.getManifest(first.id, "owner-a")).toEqual({ git_sha: "abc" });
    expect(await repository.storeManifest(first.id, "owner-a", { git_sha: "changed" }, 110)).toEqual({ git_sha: "abc" });
    expect(await repository.finalizeManifest(first.id, "owner-a", { git_sha: "abc", finalized: true }, 115))
      .toEqual({ git_sha: "abc", finalized: true });
    expect(await repository.finalizeManifest(first.id, "owner-a", { git_sha: "changed", finalized: true }, 116))
      .toEqual({ git_sha: "abc", finalized: true });
    await repository.rename(first.id, "owner-a", "대표 후보", 120);
    await repository.setTags(first.id, "owner-a", ["pareto", "saved", "pareto"], 130);

    const page1 = await repository.list({ ownerSubject: "owner-a", tags: ["saved"], limit: 1 });
    expect(page1.items).toHaveLength(1);
    expect(page1.nextCursor).toBeTruthy();
    const page2 = await repository.list({ ownerSubject: "owner-a", tags: ["saved"], limit: 1, cursor: page1.nextCursor });
    expect(page2.items).toHaveLength(1);
    expect(new Set([...page1.items, ...page2.items].map((run) => run.id))).toEqual(new Set([first.id, second.id]));
    expect((await repository.list({ ownerSubject: "owner-a", search: "대표" })).items.map((run) => run.id)).toEqual([first.id]);

    await repository.archive(first.id, "owner-a", 140);
    expect((await repository.list({ ownerSubject: "owner-a" })).items.map((run) => run.id)).toEqual([second.id]);
    expect((await repository.list({ ownerSubject: "owner-a", archived: true })).items.map((run) => run.id)).toEqual([first.id]);
    await repository.unarchive(first.id, "owner-a", 150);

    const events = await repository.getEvents(first.id, "owner-a");
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining([
      "created", "manifest_stored", "manifest_finalized", "renamed", "tags_updated", "archived", "unarchived",
    ]));
    expect(await repository.getEvents(first.id, "owner-b")).toEqual([]);

    await repository.addEvent(first.id, "same_millisecond_a", {}, 160);
    await repository.addEvent(first.id, "same_millisecond_b", {}, 160);
    const sameMillisecondFirstPage = await repository.getEvents(first.id, "owner-a", { after: 159, limit: 1 });
    expect(sameMillisecondFirstPage).toHaveLength(1);
    const sameMillisecondSecondPage = await repository.getEvents(first.id, "owner-a", {
      after: sameMillisecondFirstPage[0]!.createdAt,
      afterId: sameMillisecondFirstPage[0]!.id,
      limit: 1,
    });
    expect(new Set([
      sameMillisecondFirstPage[0]!.type,
      sameMillisecondSecondPage[0]!.type,
    ])).toEqual(new Set(["same_millisecond_a", "same_millisecond_b"]));
  });

  it("terminal run을 soft delete하고 동일 요청 재생 시 기존 멱등 run을 복구한다", async () => {
    const repository = await setup();
    const input = {
      kind: "backtest" as const,
      ownerSubject: "owner-a",
      requestHash: "d".repeat(64),
      dataRevision: "revision-a",
      engineVersion: "engine-a",
      config: { assets: ["AAA"] },
      now: 100,
    };
    const created = await repository.create(input);
    await repository.complete(created.id, { cagr: 1 }, { points: [] }, [], 110);
    expect(await repository.softDelete(created.id, "owner-a", 120)).toBe(true);
    expect(await repository.get(created.id, "owner-a")).toBeUndefined();
    expect((await repository.list({ ownerSubject: "owner-a", includeDeleted: true })).items[0]).toMatchObject({
      id: created.id,
      deletedAt: 120,
    });

    const restored = await repository.create({ ...input, now: 130 });
    expect(restored).toMatchObject({ id: created.id, status: "completed" });
    expect(restored.deletedAt).toBeUndefined();
    expect(await repository.softDelete(created.id, "owner-b", 140)).toBe(false);
  });

  it("active run은 100%로 표시하지 않고 completed 전이와 함께 100%를 기록한다", async () => {
    const repository = await setup();
    const run = await repository.create({
      kind: "optimization",
      ownerSubject: "owner-a",
      requestHash: "9".repeat(64),
      dataRevision: "revision-a",
      engineVersion: "engine-a",
      config: { symbols: ["AAA", "BBB"] },
      totalCandidates: 2_000,
      now: 100,
    });
    expect(await repository.markRunning(run.id, 110)).toBe(true);

    await repository.updateProgress(run.id, {
      progress: 1,
      completedCandidates: 2_000,
      totalCandidates: 2_000,
    }, 120);
    expect(await repository.get(run.id, "owner-a")).toMatchObject({
      status: "running",
      progress: 0.99,
      completedCandidates: 2_000,
    });

    expect(await repository.complete(run.id, { best: {} }, { candidates: [] }, [], 130)).toBe(true);
    expect(await repository.get(run.id, "owner-a")).toMatchObject({
      status: "completed",
      progress: 1,
    });
  });

  it("저장소 경계에서도 과도하게 긴 run 이름을 거부한다", async () => {
    const repository = await setup();
    await expect(repository.create({
      kind: "backtest",
      ownerSubject: "owner-a",
      requestHash: "e".repeat(64),
      dataRevision: "revision-a",
      engineVersion: "engine-a",
      config: {},
      name: "가".repeat(201),
    })).rejects.toThrow("200자");
  });

  it("active/all run 목록의 ORDER BY LIMIT를 partial index scan으로 처리한다", async () => {
    await setup();
    await database!.run(`
      INSERT INTO portfolio_backtest_runs (
        run_id, run_kind, owner_subject, request_hash, data_revision, engine_version,
        status, progress, completed_candidates, total_candidates, input_json,
        warnings_json, tags_json, created_at, updated_at, archived_at, deleted_at
      )
      SELECT 'run-' || value, 'backtest', 'owner', 'request-' || value,
             'revision', 'engine', 'completed', 1, 1, 1, '{}', '[]', '[]',
             value, FLOOR(value / 4.0)::bigint,
             CASE WHEN value % 4 = 0 THEN value ELSE NULL END, NULL
      FROM generate_series(1, 20000) AS value
    `);
    await database!.run("ANALYZE portfolio_backtest_runs");

    for (const archivedCondition of ["AND archived_at IS NULL", ""] as const) {
      const plan = await database!.query<{ "QUERY PLAN": unknown }>(`
        EXPLAIN (FORMAT JSON)
        SELECT * FROM portfolio_backtest_runs
        WHERE owner_subject = 'owner' AND deleted_at IS NULL ${archivedCondition}
        ORDER BY updated_at DESC, run_id DESC
        LIMIT 26
      `);
      const serialized = JSON.stringify(plan);
      expect(serialized).toContain("idx_portfolio_run_list");
      expect(serialized).not.toContain('"Node Type":"Sort"');
    }
  });

  it("재실행 연결은 같은 owner의 존재하는 source에 한 번만 설정한다", async () => {
    const repository = await setup();
    const create = (ownerSubject: string, hash: string, now: number) => repository.create({
      kind: "backtest" as const,
      ownerSubject,
      requestHash: hash.repeat(64),
      dataRevision: "revision-a",
      engineVersion: "engine-a",
      config: { hash },
      now,
    });
    const source = await create("owner-a", "f", 100);
    const otherSource = await create("owner-a", "1", 101);
    const foreignSource = await create("owner-b", "2", 102);
    const target = await create("owner-a", "3", 103);

    expect(await repository.linkReplay(target.id, "owner-a", foreignSource.id, 110)).toBe(false);
    expect(await repository.linkReplay(target.id, "owner-a", "missing", 111)).toBe(false);
    expect(await repository.linkReplay(target.id, "owner-a", target.id, 112)).toBe(false);
    expect(await repository.linkReplay(target.id, "owner-a", source.id, 113)).toBe(true);
    expect(await repository.linkReplay(target.id, "owner-a", otherSource.id, 114)).toBe(false);
    expect(await repository.get(target.id, "owner-a")).toMatchObject({ replayOf: source.id });
    expect((await repository.getEvents(target.id, "owner-a"))
      .filter((event) => event.type === "replayed_from")).toHaveLength(1);
  });

  it("soft archive된 역사 run은 terminal retry와 replay 양쪽에서 제외한다", async () => {
    const repository = await setup();
    const create = (hash: string, now: number) => repository.create({
      kind: "backtest" as const,
      ownerSubject: "owner-a",
      requestHash: hash.repeat(64),
      dataRevision: "revision-a",
      engineVersion: "engine-a",
      config: { hash },
      now,
    });
    const archivedRetry = await create("4", 100);
    await repository.fail(archivedRetry.id, { code: "FAILED" }, [], 110);
    await repository.archive(archivedRetry.id, "owner-a", 120);

    expect(await repository.retryTerminal({
      runId: archivedRetry.id,
      ownerSubject: "owner-a",
      expectedStatus: "failed",
      now: 130,
    })).toBe(false);
    expect(await repository.get(archivedRetry.id, "owner-a")).toMatchObject({
      status: "failed",
      archivedAt: 120,
    });
    expect((await repository.getEvents(archivedRetry.id, "owner-a"))
      .filter((event) => event.type === "retry_requested")).toEqual([]);

    const source = await create("5", 200);
    const archivedSource = await create("6", 201);
    const activeTarget = await create("7", 202);
    const archivedTarget = await create("8", 203);
    await repository.complete(archivedSource.id, {}, {}, [], 210);
    await repository.archive(archivedSource.id, "owner-a", 211);
    await repository.complete(archivedTarget.id, {}, {}, [], 212);
    await repository.archive(archivedTarget.id, "owner-a", 213);

    expect(await repository.linkReplay(activeTarget.id, "owner-a", archivedSource.id, 220)).toBe(false);
    expect(await repository.linkReplay(archivedTarget.id, "owner-a", source.id, 221)).toBe(false);
    expect((await repository.getEvents(activeTarget.id, "owner-a"))
      .filter((event) => event.type === "replayed_from")).toEqual([]);
    expect((await repository.getEvents(archivedTarget.id, "owner-a"))
      .filter((event) => event.type === "replayed_from")).toEqual([]);
  });
});
