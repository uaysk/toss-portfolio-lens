import { afterEach, describe, expect, it } from "vitest";
import { SqliteDatabase } from "../database.js";
import { PresetRepository } from "../repositories/preset-repository.js";
import { PRESET_EXPORT_SCHEMA_VERSION, PresetService } from "./preset-service.js";

describe("PresetService import/export", () => {
  let database: SqliteDatabase | undefined;

  afterEach(async () => {
    await database?.close();
    database = undefined;
  });

  async function setup() {
    database = new SqliteDatabase(":memory:");
    const service = new PresetService(new PresetRepository(database));
    await service.initialize();
    return service;
  }

  it("config snapshot을 내보내고 다른 owner에게 명시적으로 가져온다", async () => {
    const service = await setup();
    const config = {
      assets: [{ symbol: "AAA", weight: 70 }, { symbol: "BBB", weight: 20 }],
      cashTargetPercent: 10,
      benchmark: "SP500",
      optimization: { maxWeight: 0.7 },
    };
    const created = await service.create({
      ownerSubject: "owner-a",
      name: " 균형형 ",
      description: " 테스트 구성 ",
      config,
      tags: ["saved", "saved", "balanced"],
      source: { type: "current_portfolio", accountSelector: "opaque" },
      now: 1_000,
    });
    config.assets[0]!.weight = 1;
    expect(created).toMatchObject({
      name: "균형형",
      description: "테스트 구성",
      tags: ["balanced", "saved"],
      config: { assets: [{ symbol: "AAA", weight: 70 }, { symbol: "BBB", weight: 20 }] },
    });

    const exported = await service.exportPreset(created.id, "owner-a", 2_000);
    expect(exported).toMatchObject({
      schema_version: PRESET_EXPORT_SCHEMA_VERSION,
      exported_at: new Date(2_000).toISOString(),
      preset: { name: "균형형" },
    });
    expect(await service.exportPreset(created.id, "owner-b", 2_000)).toBeUndefined();

    const imported = await service.importPreset({
      ownerSubject: "owner-b",
      payload: JSON.stringify(exported),
      name: "가져온 구성",
      tags: ["imported"],
      now: 3_000,
    });
    expect(imported).toMatchObject({
      ownerSubject: "owner-b",
      name: "가져온 구성",
      tags: ["imported"],
      source: {
        type: "import",
        importedAt: new Date(3_000).toISOString(),
        originalSource: { type: "current_portfolio" },
      },
    });
    expect(await service.get(imported.id, "owner-a")).toBeUndefined();
  });

  it("잘못된 JSON 값과 schema, stale revision을 거부한다", async () => {
    const service = await setup();
    expect(() => service.create({
      ownerSubject: "owner-a",
      name: "invalid",
      config: { value: Number.NaN },
    })).toThrow(expect.objectContaining({ name: "PresetValidationError", field: "config" }));
    await expect(service.importPreset({
      ownerSubject: "owner-a",
      payload: { schema_version: "unknown", preset: {} },
    })).rejects.toMatchObject({ name: "PresetValidationError", field: "schema_version" });

    const created = await service.create({ ownerSubject: "owner-a", name: "valid", config: {}, now: 100 });
    await service.update({ id: created.id, ownerSubject: "owner-a", expectedRevision: 1, description: "v2", now: 200 });
    await expect(service.update({
      id: created.id,
      ownerSubject: "owner-a",
      expectedRevision: 1,
      description: "stale",
    })).rejects.toMatchObject({ name: "PresetRevisionConflictError", currentRevision: 2 });
  });
});
