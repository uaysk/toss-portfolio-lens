import { afterEach, describe, expect, it } from "vitest";
import { SqliteDatabase } from "../database.js";
import { RunRepository } from "./run-repository.js";

describe("RunRepository management", () => {
  let database: SqliteDatabase | undefined;

  afterEach(async () => {
    await database?.close();
    database = undefined;
  });

  async function setup() {
    database = new SqliteDatabase(":memory:");
    const repository = new RunRepository(database);
    await repository.initialize();
    return repository;
  }

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
});
