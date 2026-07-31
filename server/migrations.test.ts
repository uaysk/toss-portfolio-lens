import { afterEach, describe, expect, it } from "vitest";
import { PGliteDatabase } from "../test-support/pglite-database.js";
import {
  applyPortfolioMigrations,
  listAppliedMigrations,
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
] as const;

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
          'portfolio_scalping_recording_events'
        )
      ORDER BY table_name
    `);
    expect(tables.map(({ table_name }) => table_name)).toEqual([
      "portfolio_intraday_bars",
      "portfolio_market_candles",
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
  });

  it("is idempotent and does not rewrite historical checksums or timestamps", async () => {
    database = new PGliteDatabase();
    const first = await applyPortfolioMigrations(database, 123);
    const second = await applyPortfolioMigrations(database, 999);
    expect(second).toEqual(first);
    expect(await listAppliedMigrations(database)).toEqual(first);
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
