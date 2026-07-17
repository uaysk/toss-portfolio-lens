import { describe, expect, it } from "vitest";
import { SqliteDatabase } from "../database.js";
import { ArtifactRepository } from "./artifact-repository.js";
import { RunRepository } from "./run-repository.js";

describe("ArtifactRepository canonical checksum", () => {
  it("객체 key 삽입 순서와 무관하게 inline/external artifact checksum을 고정한다", async () => {
    const database = new SqliteDatabase(":memory:");
    try {
      const runs = new RunRepository(database);
      const artifacts = new ArtifactRepository(database);
      await runs.initialize();
      await artifacts.initialize();
      const run = await runs.create({
        kind: "backtest",
        ownerSubject: "owner",
        requestHash: "request-hash",
        dataRevision: "revision-1",
        engineVersion: "engine-v1",
        config: {},
      });
      const inline = await artifacts.put({
        runId: run.id,
        type: "equity",
        content: [{ date: "2026-01-01", balance: 100, nested: { z: 2, a: 1 } }],
        schemaVersion: "1.0",
        dataRevision: run.dataRevision,
      });
      const external = await artifacts.put({
        runId: run.id,
        type: "equity",
        content: [{ nested: { a: 1, z: 2 }, balance: 100, date: "2026-01-01" }],
        schemaVersion: "1.0",
        dataRevision: run.dataRevision,
      });

      expect(external.checksum).toBe(inline.checksum);
      expect(external.byteCount).toBe(inline.byteCount);
    } finally {
      await database.close();
    }
  });
});
