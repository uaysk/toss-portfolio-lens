import { describe, expect, it, vi } from "vitest";
import { PGliteDatabase } from "../../test-support/pglite-database.js";
import { ArtifactRepository } from "./artifact-repository.js";
import { RunRepository } from "./run-repository.js";

describe("ArtifactRepository canonical checksum", () => {
  it("객체 key 삽입 순서와 무관하게 inline/external artifact checksum을 고정한다", async () => {
    const database = new PGliteDatabase();
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

  it("기술적 분석 artifact를 공통 portfolio URI로 노출한다", async () => {
    const database = new PGliteDatabase();
    try {
      const runs = new RunRepository(database);
      const artifacts = new ArtifactRepository(database);
      await runs.initialize();
      await artifacts.initialize();
      const run = await runs.create({
        kind: "technical_analysis",
        ownerSubject: "owner",
        requestHash: "technical-request-hash",
        dataRevision: "technical-revision-1",
        engineVersion: "technical-engine-v1",
        config: {},
      });

      for (const type of [
        "technical-indicators",
        "technical-signals",
        "technical-diagnostics",
      ] as const) {
        const stored = await artifacts.put({
          runId: run.id,
          type,
          content: [],
          schemaVersion: "1.0",
          dataRevision: run.dataRevision,
        });
        expect(stored.uri).toBe(`portfolio://runs/${run.id}/artifacts/${type}`);
      }
    } finally {
      await database.close();
    }
  });

  it("같은 run/type을 덮어써도 artifact ID를 유지하고 새 content를 반환한다", async () => {
    const database = new PGliteDatabase();
    try {
      const runs = new RunRepository(database);
      const artifacts = new ArtifactRepository(database);
      await runs.initialize();
      await artifacts.initialize();
      const run = await runs.create({
        kind: "backtest",
        ownerSubject: "owner",
        requestHash: "stable-artifact-id",
        dataRevision: "revision-1",
        engineVersion: "engine-v1",
        config: {},
      });

      const first = await artifacts.put({
        runId: run.id,
        type: "equity",
        content: [{ date: "2026-01-01", balance: 100 }],
        schemaVersion: "1.0",
        dataRevision: run.dataRevision,
      });
      const second = await artifacts.put({
        runId: run.id,
        type: "equity",
        content: [{ date: "2026-01-02", balance: 125 }],
        schemaVersion: "1.0",
        dataRevision: run.dataRevision,
      });

      expect(second.id).toBe(first.id);
      expect(second.checksum).not.toBe(first.checksum);
      await expect(artifacts.get(run.id, "equity")).resolves.toEqual({
        descriptor: second,
        content: [{ date: "2026-01-02", balance: 125 }],
      });
    } finally {
      await database.close();
    }
  });

  it("INSERT RETURNING 한 번으로 descriptor를 반환하고 content_json을 다시 읽지 않는다", async () => {
    const database = new PGliteDatabase();
    try {
      const runs = new RunRepository(database);
      const artifacts = new ArtifactRepository(database);
      await runs.initialize();
      await artifacts.initialize();
      const run = await runs.create({
        kind: "backtest",
        ownerSubject: "owner",
        requestHash: "descriptor-only-query",
        dataRevision: "revision-1",
        engineVersion: "engine-v1",
        config: {},
      });
      const query = vi.spyOn(database, "query");
      query.mockClear();

      await artifacts.put({
        runId: run.id,
        type: "equity",
        content: [{ date: "2026-01-01", balance: 100 }],
        schemaVersion: "1.0",
        dataRevision: run.dataRevision,
      });

      expect(query).toHaveBeenCalledTimes(1);
      const sql = String(query.mock.calls[0]?.[0]).replace(/\s+/g, " ").trim();
      expect(sql).toMatch(/^INSERT INTO portfolio_backtest_artifacts/);
      expect(sql).toContain("RETURNING artifact_id, run_id, artifact_type, row_count, byte_count,");
      expect(sql.slice(sql.indexOf("RETURNING"))).not.toContain("content_json");
      expect(sql).not.toMatch(/SELECT \*/i);
    } finally {
      await database.close();
    }
  });
});
