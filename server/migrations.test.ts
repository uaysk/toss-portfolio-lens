import { afterEach, describe, expect, it, vi } from "vitest";
import { type DatabaseDialect, type RelationalDatabase, SqliteDatabase } from "./database.js";
import {
  applyPortfolioMigrations,
  ensureMarketCandleVolumeColumn,
  ensureScalpingMarketCountry,
  listAppliedMigrations,
} from "./migrations.js";
import { RunRepository } from "./repositories/run-repository.js";

describe("versioned portfolio migrations", () => {
  let database: SqliteDatabase | undefined;

  afterEach(async () => {
    await database?.close();
    database = undefined;
  });

  it.each([
    ["mysql", "DOUBLE NULL"],
    ["postgres", "DOUBLE PRECISION"],
  ] as const)("%s 기존 candle table에 nullable volume을 additive migration한다", async (dialect, columnType) => {
    const run = vi.fn().mockResolvedValue({ affectedRows: 0, insertId: 0 });
    const database = {
      dialect: dialect as DatabaseDialect,
      query: vi.fn(async (sql: string) => (
        sql.includes("information_schema.tables")
          ? [{ table_name: "portfolio_market_candles" }]
          : []
      )),
      run,
      transaction: vi.fn(),
      close: vi.fn(),
    } as unknown as RelationalDatabase;

    await ensureMarketCandleVolumeColumn(database);

    expect(run).toHaveBeenCalledWith(
      `ALTER TABLE portfolio_market_candles ADD COLUMN volume ${columnType}`,
    );
  });

  it("PostgreSQL 기존 단타 테이블을 KR 기본값과 시장 복합 PK로 보존 마이그레이션한다", async () => {
    const run = vi.fn().mockResolvedValue({ affectedRows: 0, insertId: 0 });
    const query = vi.fn(async (sql: string, parameters: unknown[] = []) => {
      if (sql.includes("information_schema.tables")) return [{ table_name: parameters[0] }];
      if (sql.includes("information_schema.columns")) return [{ column_name: "symbol" }];
      if (sql.includes("JOIN information_schema.key_column_usage")) {
        return ["symbol", "interval_minutes", "open_time"].map((column_name, index) => ({
          column_name,
          ordinal_position: index + 1,
        }));
      }
      if (sql.includes("information_schema.table_constraints")) {
        return [{ constraint_name: "portfolio_intraday_bars_pkey" }];
      }
      if (sql.includes("pg_indexes")) return [];
      return [];
    });
    const postgres = {
      dialect: "postgres" as const,
      query,
      run,
      transaction: vi.fn(),
      close: vi.fn(),
    } as unknown as RelationalDatabase;

    await ensureScalpingMarketCountry(postgres);

    expect(run).toHaveBeenCalledWith(
      "ALTER TABLE portfolio_intraday_bars ADD COLUMN market_country TEXT NOT NULL DEFAULT 'KR'",
    );
    expect(run).toHaveBeenCalledWith(
      "ALTER TABLE portfolio_scalping_predictions ADD COLUMN market_country TEXT NOT NULL DEFAULT 'KR'",
    );
    expect(run).toHaveBeenCalledWith(
      "UPDATE portfolio_intraday_bars SET market_country = 'KR' WHERE market_country IS NULL OR market_country = ''",
    );
    expect(run).toHaveBeenCalledWith(
      "ALTER TABLE portfolio_intraday_bars DROP CONSTRAINT \"portfolio_intraday_bars_pkey\"",
    );
    expect(run).toHaveBeenCalledWith(expect.stringContaining(
      "ADD PRIMARY KEY(market_country, symbol, interval_minutes, open_time)",
    ));
    expect(run).toHaveBeenCalledWith(
      "CREATE INDEX idx_portfolio_scalping_prediction_market_latest ON portfolio_scalping_predictions(market_country, symbol, retrospective, generated_at)",
    );
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
    await database.run(`
      CREATE TABLE portfolio_market_candles (
        source_kind TEXT NOT NULL,
        symbol TEXT NOT NULL,
        candle_interval TEXT NOT NULL,
        adjusted INTEGER NOT NULL,
        timestamp TEXT NOT NULL,
        close_price REAL NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(source_kind, symbol, candle_interval, adjusted, timestamp)
      )
    `);
    await database.run(`
      CREATE TABLE portfolio_intraday_bars (
        symbol TEXT NOT NULL,
        interval_minutes INTEGER NOT NULL,
        open_time TEXT NOT NULL,
        close_time TEXT NOT NULL,
        session_date TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        bar_state TEXT NOT NULL,
        open_price REAL NOT NULL,
        high_price REAL NOT NULL,
        low_price REAL NOT NULL,
        close_price REAL NOT NULL,
        volume REAL NOT NULL,
        turnover REAL,
        trade_count INTEGER,
        quality_status TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(symbol, interval_minutes, open_time)
      )
    `);
    await database.run(`
      INSERT INTO portfolio_intraday_bars (
        symbol, interval_minutes, open_time, close_time, session_date, source_kind, bar_state,
        open_price, high_price, low_price, close_price, volume, turnover, trade_count,
        quality_status, updated_at
      ) VALUES ('AAPL', 1, '2026-07-20T13:30:00.000Z', '2026-07-20T13:31:00.000Z',
        '2026-07-20', 'kis_rest', 'final', 100, 101, 99, 100.5, 10, 1005, 2, 'complete', 1)
    `);
    await database.run(`
      CREATE TABLE portfolio_scalping_predictions (
        prediction_id TEXT PRIMARY KEY,
        symbol TEXT NOT NULL,
        model_name TEXT NOT NULL,
        model_version TEXT NOT NULL,
        input_ended_at TEXT NOT NULL,
        generated_at TEXT NOT NULL,
        status TEXT NOT NULL,
        data_quality TEXT NOT NULL,
        retrospective INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);
    await database.run(`
      INSERT INTO portfolio_scalping_predictions (
        prediction_id, symbol, model_name, model_version, input_ended_at, generated_at,
        status, data_quality, retrospective, payload_json, created_at
      ) VALUES ('legacy-prediction', 'AAPL', 'model', 'v1', '2026-07-20T13:30:00.000Z',
        '2026-07-20T13:30:01.000Z', 'available', 'complete', 0, '{}', 1)
    `);

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
      "20260721_005_market_candle_volume",
      "20260721_006_scalping_intraday_storage",
      "20260721_007_scalping_volume_availability",
      "20260721_008_scalping_market_country",
    ]);
    expect(new Set(applied.map((migration) => migration.checksum)).size).toBe(8);
    const marketCandleColumns = await database.query<{ name: string }>("PRAGMA table_info(portfolio_market_candles)");
    expect(marketCandleColumns.map((column) => column.name)).toContain("volume");
    const scalpingTables = await database.query<{ name: string }>(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN ('portfolio_intraday_bars', 'portfolio_scalping_predictions')
      ORDER BY name
    `);
    expect(scalpingTables.map((row) => row.name)).toEqual([
      "portfolio_intraday_bars",
      "portfolio_scalping_predictions",
    ]);
    const intradayColumns = await database.query<{ name: string }>("PRAGMA table_info(portfolio_intraday_bars)");
    expect(intradayColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
      "market_country", "volume_available",
    ]));
    const intradayPrimaryKey = await database.query<{ name: string; pk: number | string }>(
      "PRAGMA table_info(portfolio_intraday_bars)",
    );
    expect(intradayPrimaryKey
      .filter((column) => Number(column.pk) > 0)
      .sort((left, right) => Number(left.pk) - Number(right.pk))
      .map((column) => column.name)).toEqual([
      "market_country", "symbol", "interval_minutes", "open_time",
    ]);
    const predictionColumns = await database.query<{ name: string }>(
      "PRAGMA table_info(portfolio_scalping_predictions)",
    );
    expect(predictionColumns.map((column) => column.name)).toContain("market_country");
    expect(await database.query<{ market_country: string }>(
      "SELECT market_country FROM portfolio_intraday_bars WHERE symbol = 'AAPL'",
    )).toEqual([{ market_country: "KR" }]);
    expect(await database.query<{ market_country: string }>(
      "SELECT market_country FROM portfolio_scalping_predictions WHERE prediction_id = 'legacy-prediction'",
    )).toEqual([{ market_country: "KR" }]);
    const intradayIndexes = await database.query<{ name: string }>(`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND tbl_name = 'portfolio_intraday_bars' AND name NOT LIKE 'sqlite_autoindex%'
      ORDER BY name ASC
    `);
    expect(intradayIndexes.map((index) => index.name)).toEqual(expect.arrayContaining([
      "idx_portfolio_intraday_market_session",
      "idx_portfolio_intraday_updated",
    ]));

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
