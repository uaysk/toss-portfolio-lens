import { afterEach, describe, expect, it } from "vitest";
import { SqliteDatabase } from "./database.js";
import { applyPortfolioMigrations, listAppliedMigrations } from "./migrations.js";
import { RunRepository } from "./repositories/run-repository.js";

describe("versioned portfolio migrations", () => {
  let database: SqliteDatabase | undefined;

  afterEach(async () => {
    await database?.close();
    database = undefined;
  });

  it("기존 run 테이블에 관리 컬럼을 보존적으로 추가하고 ledger를 멱등 기록한다", async () => {
    database = new SqliteDatabase(":memory:");
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
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER,
        updated_at INTEGER NOT NULL,
        UNIQUE(owner_subject, run_kind, request_hash, data_revision)
      )
    `);
    await database.run(`
      INSERT INTO portfolio_backtest_runs (
        run_id, run_kind, owner_subject, request_hash, data_revision, engine_version,
        status, input_json, warnings_json, created_at, updated_at
      ) VALUES (?, 'backtest', 'owner-a', ?, 'revision-1', 'engine-1', 'completed', '{}', '[]', 10, 10)
    `, ["00000000-0000-4000-8000-000000000001", "a".repeat(64)]);
    await database.run(`
      INSERT INTO portfolio_backtest_runs (
        run_id, run_kind, owner_subject, request_hash, data_revision, engine_version,
        status, input_json, warnings_json, created_at, updated_at
      ) VALUES (?, 'optimization', 'dashboard-http', ?, 'revision-2', 'engine-1', 'completed', '{}', '[]', 11, 11)
    `, ["00000000-0000-4000-8000-000000000002", "b".repeat(64)]);
    await database.run(`
      INSERT INTO portfolio_backtest_runs (
        run_id, run_kind, owner_subject, request_hash, data_revision, engine_version,
        status, input_json, warnings_json, created_at, updated_at
      ) VALUES (?, 'backtest', 'owner', ?, 'revision-3', 'engine-1', 'completed', '{}', '[]', 12, 12)
    `, ["00000000-0000-4000-8000-000000000003", "c".repeat(64)]);
    await database.run(`
      INSERT INTO portfolio_backtest_runs (
        run_id, run_kind, owner_subject, request_hash, data_revision, engine_version,
        status, input_json, warnings_json, created_at, updated_at
      ) VALUES (?, 'backtest', 'dashboard-report', ?, 'revision-3', 'engine-1', 'completed', '{}', '[]', 13, 13)
    `, ["00000000-0000-4000-8000-000000000004", "c".repeat(64)]);
    await database.run(`
      CREATE TABLE portfolio_report_links (
        report_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES portfolio_backtest_runs(run_id) ON DELETE CASCADE,
        owner_subject TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        data_revision TEXT NOT NULL,
        engine_version TEXT NOT NULL,
        report_schema_version TEXT NOT NULL,
        report_config_hash TEXT NOT NULL,
        model_name TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(
          owner_subject, request_hash, data_revision, engine_version,
          report_schema_version, report_config_hash
        )
      )
    `);
    await database.run(`
      INSERT INTO portfolio_report_links (
        report_id, run_id, owner_subject, request_hash, data_revision, engine_version,
        report_schema_version, report_config_hash, model_name, created_at
      ) VALUES (?, ?, 'owner', ?, 'revision-3', 'engine-1', 'report-v1', ?, NULL, '2026-07-18T00:00:00.000Z')
    `, [
      "00000000-0000-4000-8000-000000000011",
      "00000000-0000-4000-8000-000000000003",
      "c".repeat(64),
      "d".repeat(64),
    ]);
    await database.run(`
      INSERT INTO portfolio_report_links (
        report_id, run_id, owner_subject, request_hash, data_revision, engine_version,
        report_schema_version, report_config_hash, model_name, created_at
      ) VALUES (?, ?, 'dashboard-report', ?, 'revision-3', 'engine-1', 'report-v1', ?, NULL, '2026-07-18T00:00:01.000Z')
    `, [
      "00000000-0000-4000-8000-000000000012",
      "00000000-0000-4000-8000-000000000004",
      "c".repeat(64),
      "d".repeat(64),
    ]);

    const runs = new RunRepository(database);
    await runs.initialize();
    await applyPortfolioMigrations(database, 20);

    const columnRows = await database.query<{ name: string }>("PRAGMA table_info(portfolio_backtest_runs)");
    expect(columnRows.map((row) => row.name)).toEqual(expect.arrayContaining([
      "name", "tags_json", "archived_at", "deleted_at", "replay_of", "manifest_json",
    ]));
    const applied = await listAppliedMigrations(database);
    expect(applied.map((migration) => migration.id)).toEqual([
      "20260718_001_run_management",
      "20260718_002_portfolio_presets",
      "20260718_003_canonical_local_owner",
      "20260718_004_canonical_local_owner_reconciliation",
    ]);
    expect(new Set(applied.map((migration) => migration.checksum)).size).toBe(4);

    const legacy = await runs.get("00000000-0000-4000-8000-000000000001", "owner-a");
    expect(legacy).toMatchObject({ tags: [], input: {}, status: "completed" });
    expect(await runs.get("00000000-0000-4000-8000-000000000002", "owner"))
      .toMatchObject({ ownerSubject: "owner", kind: "optimization" });
    const conflictingLegacy = await runs.get("00000000-0000-4000-8000-000000000004", "owner");
    expect(conflictingLegacy).toMatchObject({
      ownerSubject: "owner",
      requestHash: expect.not.stringMatching(/^c{64}$/),
      replayOf: "00000000-0000-4000-8000-000000000003",
      manifest: {
        migration: {
          id: "20260718_004_canonical_local_owner_reconciliation",
          original_owner: "dashboard-report",
          original_request_hash: "c".repeat(64),
          canonical_run_id: "00000000-0000-4000-8000-000000000003",
        },
      },
    });
    const reportLinks = await database.query<{
      report_id: string;
      owner_subject: string;
      report_config_hash: string;
    }>(`
      SELECT report_id, owner_subject, report_config_hash
      FROM portfolio_report_links
      ORDER BY report_id ASC
    `);
    expect(reportLinks).toHaveLength(2);
    expect(reportLinks.map((link) => link.owner_subject)).toEqual(["owner", "owner"]);
    expect(new Set(reportLinks.map((link) => link.report_config_hash)).size).toBe(2);
    expect(reportLinks[0]?.report_config_hash).toBe("d".repeat(64));
    expect(reportLinks[1]?.report_config_hash).not.toBe("d".repeat(64));
    const presetTables = await database.query<{ name: string }>(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN ('portfolio_presets', 'portfolio_preset_versions')
      ORDER BY name
    `);
    expect(presetTables.map((row) => row.name)).toEqual(["portfolio_preset_versions", "portfolio_presets"]);
  });
});
