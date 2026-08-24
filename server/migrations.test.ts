import { afterEach, describe, expect, it } from "vitest";
import { PGliteDatabase } from "../test-support/pglite-database.js";
import type { DatabaseRow, RelationalDatabase, RunResult } from "./database.js";
import {
  applyPortfolioMigrations,
  LEGACY_COMMON_CANDLE_BACKFILL_MIGRATION_ID,
  listAppliedMigrations,
  RUN_SCHEMA_MIGRATION_ID,
} from "./migrations.js";

const EXPECTED_MIGRATION_IDS = [
  "20260718_001_run_management",
  "20260718_002_portfolio_presets",
  "20260718_003_canonical_local_owner",
  "20260718_004_canonical_local_owner_reconciliation",
  "20260721_005_market_candle_volume",
  "20260721_006_scalping_intraday_storage",
  "20260721_007_scalping_volume_availability",
  "20260721_008_scalping_market_country",
  "20260724_009_scalping_raw_market_data",
  "20260725_010_binance_usdm_market",
  "20260731_011_postgres_base_schema",
  "20260731_012_latest_contract_cutover",
  "20260823_013_legacy_common_candle_backfill",
  "20260824_014_run_list_index",
  "20260824_015_order_history_index",
  "20260824_016_mcp_audit_schema",
  "20260824_017_run_schema",
] as const;

class RecordingDatabase implements RelationalDatabase {
  constructor(
    private readonly delegate: RelationalDatabase,
    readonly statements: string[] = [],
  ) {}

  query<T extends DatabaseRow>(sql: string, parameters?: unknown[]): Promise<T[]> {
    this.statements.push(sql);
    return this.delegate.query<T>(sql, parameters);
  }

  run(sql: string, parameters?: unknown[]): Promise<RunResult> {
    this.statements.push(sql);
    return this.delegate.run(sql, parameters);
  }

  transaction<T>(work: (database: RelationalDatabase) => Promise<T>): Promise<T> {
    return this.delegate.transaction((database) => work(new RecordingDatabase(database, this.statements)));
  }

  close(): Promise<void> {
    return this.delegate.close();
  }
}

function legacyCommonCandleBackfills(statements: readonly string[]): string[] {
  return statements.filter((statement) => (
    statement.includes("INSERT INTO portfolio_market_candles")
    && statement.includes("SELECT")
  ));
}

describe("versioned PostgreSQL migrations", () => {
  let database: PGliteDatabase | undefined;

  afterEach(async () => {
    await database?.close();
    database = undefined;
  });

  it("creates the canonical PostgreSQL schema and preserves migration identity", async () => {
    database = new PGliteDatabase();
    const applied = await applyPortfolioMigrations(database, 123);

    expect(applied.map(({ id }) => id)).toEqual(EXPECTED_MIGRATION_IDS);
    expect(applied.every(({ checksum }) => /^[a-f0-9]{64}$/.test(checksum))).toBe(true);
    expect(new Set(applied.map(({ checksum }) => checksum)).size).toBe(applied.length);
    expect(applied.every(({ appliedAt }) => appliedAt === 123)).toBe(true);

    const tables = await database.query<{ table_name: string }>(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = current_schema()
        AND table_name IN (
          'portfolio_snapshots',
          'portfolio_market_candles',
          'portfolio_intraday_bars',
          'portfolio_scalping_predictions',
          'portfolio_scalping_trades',
          'portfolio_scalping_orderbooks',
          'portfolio_scalping_recording_events',
          'portfolio_backtest_runs',
          'portfolio_run_events'
        )
      ORDER BY table_name
    `);
    expect(tables.map(({ table_name }) => table_name)).toEqual([
      "portfolio_backtest_runs",
      "portfolio_intraday_bars",
      "portfolio_market_candles",
      "portfolio_run_events",
      "portfolio_scalping_orderbooks",
      "portfolio_scalping_predictions",
      "portfolio_scalping_recording_events",
      "portfolio_scalping_trades",
      "portfolio_snapshots",
    ]);

    const columns = await database.query<{ column_name: string; data_type: string }>(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'portfolio_intraday_bars'
      ORDER BY ordinal_position
    `);
    expect(columns.map(({ column_name }) => column_name)).toEqual(expect.arrayContaining([
      "market_country",
      "volume_available",
      "open_price",
      "close_price",
    ]));
    expect(columns.find(({ column_name }) => column_name === "open_price")?.data_type)
      .toBe("double precision");

    const orderIndexes = await database.query<{ indexname: string; indexdef: string }>(`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = current_schema() AND tablename = 'portfolio_orders'
      ORDER BY indexname
    `);
    expect(orderIndexes.some(({ indexname, indexdef }) => (
      indexname === "idx_orders_account_effective_time"
      && indexdef.includes("COALESCE(NULLIF((filled_at)::text, ''::text), (ordered_at)::text)")
      && indexdef.includes("order_id")
    ))).toBe(true);
    expect(orderIndexes.some(({ indexname }) => indexname === "idx_orders_account_filled_at"))
      .toBe(false);

    const auditColumns = await database.query<{ column_name: string }>(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'mcp_tool_audit_log'
      ORDER BY ordinal_position
    `);
    expect(auditColumns.map(({ column_name }) => column_name)).toEqual(expect.arrayContaining([
      "protocol_request_id",
      "session_hash",
      "duration_ms",
    ]));
    const auditIndexes = await database.query<{ indexname: string; indexdef: string }>(`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = current_schema() AND tablename = 'mcp_tool_audit_log'
    `);
    expect(auditIndexes.some(({ indexname, indexdef }) => (
      indexname === "idx_mcp_tool_audit_tool_started"
      && indexdef.includes("(tool_name, started_at DESC)")
    ))).toBe(true);

    const runIndexes = await database.query<{ indexname: string; indexdef: string }>(`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = current_schema()
        AND indexname IN (
          'idx_portfolio_run_list',
          'idx_portfolio_run_status',
          'idx_portfolio_run_events'
        )
      ORDER BY indexname
    `);
    expect(runIndexes.map(({ indexname }) => indexname)).toEqual([
      "idx_portfolio_run_events",
      "idx_portfolio_run_list",
      "idx_portfolio_run_status",
    ]);
    expect(runIndexes.find(({ indexname }) => indexname === "idx_portfolio_run_list")?.indexdef)
      .toContain("WHERE (deleted_at IS NULL)");
  });

  it("creates the latest run schema when historical run migrations were recorded as no-ops", async () => {
    database = new PGliteDatabase();
    await applyPortfolioMigrations(database, 123);
    await database.run("DROP TABLE portfolio_run_events");
    await database.run("DROP TABLE portfolio_backtest_runs");
    await database.run(
      "DELETE FROM portfolio_schema_migrations WHERE migration_id = ?",
      [RUN_SCHEMA_MIGRATION_ID],
    );

    await applyPortfolioMigrations(database, 456);

    const tables = await database.query<{ table_name: string }>(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = current_schema()
        AND table_name IN ('portfolio_backtest_runs', 'portfolio_run_events')
      ORDER BY table_name
    `);
    expect(tables.map(({ table_name }) => table_name)).toEqual([
      "portfolio_backtest_runs",
      "portfolio_run_events",
    ]);
    const columns = await database.query<{ column_name: string }>(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'portfolio_backtest_runs'
    `);
    expect(columns.map(({ column_name }) => column_name)).toEqual(expect.arrayContaining([
      "run_id",
      "name",
      "tags_json",
      "deleted_at",
      "manifest_json",
    ]));
    expect((await listAppliedMigrations(database)).find(({ id }) => id === RUN_SCHEMA_MIGRATION_ID))
      .toMatchObject({ id: RUN_SCHEMA_MIGRATION_ID, appliedAt: 456 });
  });

  it("preserves legacy run rows and unknown columns while completing the canonical schema", async () => {
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
        legacy_note TEXT,
        UNIQUE(owner_subject, run_kind, request_hash, data_revision)
      )
    `);
    await database.run(`
      INSERT INTO portfolio_backtest_runs (
        run_id, run_kind, owner_subject, request_hash, data_revision,
        engine_version, status, input_json, warnings_json, created_at,
        updated_at, legacy_note
      ) VALUES (
        'legacy-run', 'backtest', 'owner-a', 'legacy-request', 'revision-a',
        'legacy-engine', 'completed', '{}', '[]', 100, 110, 'keep-me'
      )
    `);

    await applyPortfolioMigrations(database, 456);

    expect(await database.query<{
      run_id: string;
      legacy_note: string;
      tags_json: string;
      deleted_at: number | null;
    }>(`
      SELECT run_id, legacy_note, tags_json, deleted_at
      FROM portfolio_backtest_runs
      WHERE run_id = 'legacy-run'
    `)).toEqual([{
      run_id: "legacy-run",
      legacy_note: "keep-me",
      tags_json: "[]",
      deleted_at: null,
    }]);
    expect(await database.query<{ count: number | string }>(`
      SELECT COUNT(*) AS count
      FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name = 'portfolio_run_events'
    `)).toEqual([{ count: 1 }]);
  });

  it("is idempotent and does not rewrite historical checksums or timestamps", async () => {
    database = new PGliteDatabase();
    const recording = new RecordingDatabase(database);
    const first = await applyPortfolioMigrations(recording, 123);
    expect(legacyCommonCandleBackfills(recording.statements)).toHaveLength(3);
    expect(recording.statements.filter((statement) => statement.includes("pg_advisory_xact_lock")))
      .toHaveLength(1);
    recording.statements.length = 0;

    const second = await applyPortfolioMigrations(recording, 999);
    expect(second).toEqual(first);
    expect(await listAppliedMigrations(database)).toEqual(first);
    expect(legacyCommonCandleBackfills(recording.statements)).toHaveLength(0);
    expect(recording.statements.filter((statement) => statement.includes("pg_advisory_xact_lock")))
      .toHaveLength(1);
  });

  it("backfills all legacy common-candle sources once when upgrading an existing database", async () => {
    database = new PGliteDatabase();
    await applyPortfolioMigrations(database, 123);
    await database.run(
      "DELETE FROM portfolio_schema_migrations WHERE migration_id = ?",
      [LEGACY_COMMON_CANDLE_BACKFILL_MIGRATION_ID],
    );
    await database.run(`
      INSERT INTO portfolio_instruments (
        instrument_key, symbol, name, market, currency, updated_at
      ) VALUES ('KRW:AAA', 'AAA', '에이', 'KRX', 'KRW', 10)
    `);
    await database.run(`
      INSERT INTO portfolio_daily_prices (
        instrument_key, price_date, open_price, high_price, low_price,
        close_price, currency, timestamp, updated_at
      ) VALUES ('KRW:AAA', '2026-08-20', NULL, 115, NULL, 110, 'KRW', '2026-08-20T00:00:00+09:00', 11)
    `);
    await database.run(`
      INSERT INTO portfolio_backtest_prices (
        instrument_key, price_date, close_price, currency, timestamp, updated_at
      ) VALUES ('KRW:BBB', '2026-08-20', 220, 'KRW', '2026-08-20T00:00:00+09:00', 12)
    `);
    await database.run(`
      INSERT INTO portfolio_benchmark_prices (
        benchmark_key, price_date, close_price, timestamp, updated_at
      ) VALUES ('KOSPI', '2026-08-20', 3300, '2026-08-20T00:00:00+09:00', 13)
    `);
    const recording = new RecordingDatabase(database);

    await applyPortfolioMigrations(recording, 456);

    expect(legacyCommonCandleBackfills(recording.statements)).toHaveLength(3);
    expect(await database.query<{
      source_kind: string;
      symbol: string;
      adjusted: number;
      open_price: number;
      high_price: number;
      low_price: number;
      close_price: number;
    }>(`
      SELECT source_kind, symbol, adjusted, open_price, high_price, low_price, close_price
      FROM portfolio_market_candles
      ORDER BY symbol, adjusted
    `)).toEqual([
      {
        source_kind: "stock",
        symbol: "AAA",
        adjusted: 0,
        open_price: 110,
        high_price: 115,
        low_price: 110,
        close_price: 110,
      },
      {
        source_kind: "stock",
        symbol: "BBB",
        adjusted: 1,
        open_price: 220,
        high_price: 220,
        low_price: 220,
        close_price: 220,
      },
      {
        source_kind: "indicator",
        symbol: "KOSPI",
        adjusted: 0,
        open_price: 3300,
        high_price: 3300,
        low_price: 3300,
        close_price: 3300,
      },
    ]);

    recording.statements.length = 0;
    await applyPortfolioMigrations(recording, 789);
    expect(legacyCommonCandleBackfills(recording.statements)).toHaveLength(0);
    expect(await database.query<{ count: number | string }>(
      "SELECT COUNT(*) AS count FROM portfolio_market_candles",
    )).toEqual([{ count: 3 }]);
  });

  it("preserves legacy MCP audit rows while adding correlation columns", async () => {
    database = new PGliteDatabase();
    await database.run(`
      CREATE TABLE mcp_tool_audit_log (
        audit_id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL UNIQUE,
        tool_name TEXT NOT NULL,
        subject_hash TEXT NOT NULL,
        auth_mode TEXT NOT NULL,
        status TEXT NOT NULL,
        error_code TEXT,
        run_id TEXT,
        started_at BIGINT NOT NULL,
        finished_at BIGINT NOT NULL,
        duration_ms BIGINT NOT NULL
      )
    `);
    await database.run(`
      INSERT INTO mcp_tool_audit_log (
        audit_id, request_id, tool_name, subject_hash, auth_mode, status,
        started_at, finished_at, duration_ms
      ) VALUES ('audit-legacy', 'request-legacy', 'get_current_portfolio',
                'subject-hash', 'oauth', 'ok', 100, 110, 10)
    `);

    await applyPortfolioMigrations(database, 456);

    expect(await database.query<{
      request_id: string;
      protocol_request_id: string | null;
      session_hash: string | null;
    }>(`
      SELECT request_id, protocol_request_id, session_hash
      FROM mcp_tool_audit_log
      WHERE audit_id = 'audit-legacy'
    `)).toEqual([{
      request_id: "request-legacy",
      protocol_request_id: null,
      session_hash: null,
    }]);
  });

  it("fails closed when an applied migration checksum was altered", async () => {
    database = new PGliteDatabase();
    await applyPortfolioMigrations(database, 123);
    await database.run(`
      UPDATE portfolio_schema_migrations
      SET checksum = ?
      WHERE migration_id = ?
    `, ["0".repeat(64), "20260718_001_run_management"]);
    await expect(applyPortfolioMigrations(database, 999))
      .rejects.toThrow("migration checksum이 일치하지 않습니다");
  });
});
