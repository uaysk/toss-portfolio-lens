import { afterEach, describe, expect, it } from "vitest";
import { SqliteDatabase } from "../database.js";
import { PresetRepository, PresetRevisionConflictError } from "./preset-repository.js";

describe("PresetRepository", () => {
  let database: SqliteDatabase | undefined;

  afterEach(async () => {
    await database?.close();
    database = undefined;
  });

  async function setup() {
    database = new SqliteDatabase(":memory:");
    const repository = new PresetRepository(database);
    await repository.initialize();
    return repository;
  }

  it("owner 격리와 optimistic revision을 지키며 immutable version을 남긴다", async () => {
    const repository = await setup();
    const created = await repository.create({
      ownerSubject: "owner-a",
      name: "기본 포트폴리오",
      description: "장기 구성",
      config: { assets: [{ symbol: "AAA", weight: 60 }, { symbol: "BBB", weight: 40 }] },
      tags: ["long-term"],
      source: { type: "manual" },
      now: 100,
    });
    expect(created.revision).toBe(1);
    expect(await repository.get(created.id, "owner-b")).toBeUndefined();

    const updated = await repository.update({
      id: created.id,
      ownerSubject: "owner-a",
      expectedRevision: 1,
      name: "수정 포트폴리오",
      config: { assets: [{ symbol: "AAA", weight: 50 }, { symbol: "BBB", weight: 50 }] },
      tags: ["long-term", "balanced"],
      now: 200,
    });
    expect(updated).toMatchObject({ revision: 2, name: "수정 포트폴리오" });
    await expect(repository.update({
      id: created.id,
      ownerSubject: "owner-a",
      expectedRevision: 1,
      description: "stale update",
    })).rejects.toMatchObject({
      name: "PresetRevisionConflictError",
      currentRevision: 2,
    } satisfies Partial<PresetRevisionConflictError>);

    const versions = await repository.getVersions(created.id, "owner-a");
    expect(versions.map((version) => version.revision)).toEqual([1, 2]);
    expect(versions[0].snapshot).toMatchObject({ name: "기본 포트폴리오", revision: 1 });
    expect(versions[1].snapshot).toMatchObject({ name: "수정 포트폴리오", revision: 2 });
    expect(await repository.getVersions(created.id, "owner-b")).toEqual([]);
  });

  it("검색·복제·last used와 soft delete 이력을 관리한다", async () => {
    const repository = await setup();
    const created = await repository.create({
      ownerSubject: "owner-a",
      name: "Pareto 후보",
      description: "최적화 결과",
      config: { symbols: ["AAA", "BBB"] },
      tags: ["pareto", "saved"],
      source: { type: "optimization_candidate", runId: "run-1", rank: 2 },
      now: 100,
    });
    const duplicate = await repository.duplicate({ id: created.id, ownerSubject: "owner-a", now: 200 });
    expect(duplicate).toMatchObject({
      revision: 1,
      name: "Pareto 후보 복사본",
      source: { type: "preset", presetId: created.id, revision: 1 },
    });
    expect((await repository.list({ ownerSubject: "owner-a", search: "최적화", tags: ["pareto"] })).items)
      .toHaveLength(2);

    const used = await repository.markUsed(created.id, "owner-a", 300);
    expect(used?.lastUsedAt).toBe(300);
    expect((await repository.getVersions(created.id, "owner-a"))).toHaveLength(1);

    expect(await repository.softDelete({
      id: created.id,
      ownerSubject: "owner-a",
      expectedRevision: 1,
      now: 400,
    })).toBe(true);
    expect(await repository.get(created.id, "owner-a")).toBeUndefined();
    expect(await repository.getVersions(created.id, "owner-a")).toEqual([
      expect.objectContaining({ revision: 1 }),
      expect.objectContaining({
        revision: 2,
        snapshot: expect.objectContaining({ revision: 2, deletedAt: 400 }),
      }),
    ]);
    expect((await repository.list({ ownerSubject: "owner-a" })).items.map((preset) => preset.id)).toEqual([duplicate.id]);
    expect(await repository.softDelete({ id: duplicate.id, ownerSubject: "owner-b", now: 500 })).toBe(false);
  });
});
