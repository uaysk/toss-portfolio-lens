import { createHash } from "node:crypto";
import type { RelationalDatabase } from "./database.js";
import {
  LATEST_CONTRACT_CUTOVER_MIGRATION_ID,
  LATEST_CONTRACT_CUTOVER_SIGNATURE,
  migrateLatestContracts,
} from "./migrations/latest-contract-cutover.js";

export type AppliedMigration = {
  id: string;
  checksum: string;
  appliedAt: number;
};

type Migration = {
  id: string;
  signature: string;
  up: (database: RelationalDatabase) => Promise<void>;
};

type MigrationRow = {
  migration_id: string;
  checksum: string;
  applied_at: number | string;
};

function checksum(migration: Pick<Migration, "id" | "signature">): string {
  return createHash("sha256")
    .update(`${migration.id}\n${migration.signature}`)
    .digest("hex");
}

async function createLedger(database: RelationalDatabase): Promise<void> {
  await database.run(`
    CREATE TABLE IF NOT EXISTS portfolio_schema_migrations (
      migration_id TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at BIGINT NOT NULL
    )
  `);
}

async function hasTable(database: RelationalDatabase, table: string): Promise<boolean> {
  const rows = await database.query<{ table_name: string }>(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = ?
  `, [table]);
  return rows.length > 0;
}

async function columns(database: RelationalDatabase, table: string): Promise<Set<string>> {
  const rows = await database.query<{ column_name: string }>(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = ?
  `, [table]);
  return new Set(rows.map((row) => row.column_name.toLowerCase()));
}

async function addMissingColumns(
  database: RelationalDatabase,
  table: string,
  definitions: Record<string, string>,
): Promise<void> {
  if (!await hasTable(database, table)) return;
  const existing = await columns(database, table);
  for (const [name, definition] of Object.entries(definitions)) {
    if (existing.has(name.toLowerCase())) continue;
    await database.run(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    existing.add(name.toLowerCase());
  }
}

export async function ensureMarketCandleVolumeColumn(database: RelationalDatabase): Promise<void> {
  await addMissingColumns(database, "portfolio_market_candles", {
    volume: "DOUBLE PRECISION",
  });
}

async function ensureScalpingVolumeAvailabilityColumn(database: RelationalDatabase): Promise<void> {
  await addMissingColumns(database, "portfolio_intraday_bars", {
    volume_available: "BOOLEAN NOT NULL DEFAULT TRUE",
  });
}

async function primaryKeyColumns(database: RelationalDatabase, table: string): Promise<string[]> {
  const rows = await database.query<{ column_name: string; ordinal_position: number | string }>(`
    SELECT key_column.column_name, key_column.ordinal_position
    FROM information_schema.table_constraints constraint_info
    JOIN information_schema.key_column_usage key_column
      ON key_column.constraint_schema = constraint_info.constraint_schema
      AND key_column.constraint_name = constraint_info.constraint_name
      AND key_column.table_name = constraint_info.table_name
    WHERE constraint_info.table_schema = current_schema()
      AND constraint_info.table_name = ?
      AND constraint_info.constraint_type = 'PRIMARY KEY'
    ORDER BY key_column.ordinal_position
  `, [table]);
  return rows.map((row) => row.column_name.toLowerCase());
}

export async function ensureScalpingMarketCountry(database: RelationalDatabase): Promise<void> {
  await addMissingColumns(database, "portfolio_intraday_bars", {
    market_country: "TEXT NOT NULL DEFAULT 'KR'",
  });
  await addMissingColumns(database, "portfolio_scalping_predictions", {
    market_country: "TEXT NOT NULL DEFAULT 'KR'",
  });
  if (await hasTable(database, "portfolio_intraday_bars")) {
    await database.run("UPDATE portfolio_intraday_bars SET market_country = 'KR' WHERE market_country IS NULL OR market_country = ''");
    const expected = ["market_country", "symbol", "interval_minutes", "open_time"];
    const current = await primaryKeyColumns(database, "portfolio_intraday_bars");
    if (current.join(",") !== expected.join(",")) {
      const [primary] = await database.query<{ constraint_name: string }>(`
        SELECT constraint_name
        FROM information_schema.table_constraints
        WHERE table_schema = current_schema() AND table_name = 'portfolio_intraday_bars'
          AND constraint_type = 'PRIMARY KEY'
      `);
      if (primary) {
        if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(primary.constraint_name)) {
          throw new Error("Unexpected PostgreSQL primary-key identifier.");
        }
        await database.run(
          `ALTER TABLE portfolio_intraday_bars DROP CONSTRAINT "${primary.constraint_name}"`,
        );
      }
      await database.run(`
        ALTER TABLE portfolio_intraday_bars
        ADD PRIMARY KEY(market_country, symbol, interval_minutes, open_time)
      `);
    }
  }
  if (await hasTable(database, "portfolio_scalping_predictions")) {
    await database.run("UPDATE portfolio_scalping_predictions SET market_country = 'KR' WHERE market_country IS NULL OR market_country = ''");
  }
  await createIndex(
    database,
    "idx_portfolio_intraday_market_session",
    "portfolio_intraday_bars",
    "market_country, symbol, interval_minutes, session_date, open_time",
  );
  await createIndex(
    database,
    "idx_portfolio_intraday_updated",
    "portfolio_intraday_bars",
    "updated_at",
  );
  await createIndex(
    database,
    "idx_portfolio_scalping_prediction_market_latest",
    "portfolio_scalping_predictions",
    "market_country, symbol, retrospective, generated_at",
  );
}

async function createScalpingTables(database: RelationalDatabase): Promise<void> {
  await database.run(`
    CREATE TABLE IF NOT EXISTS portfolio_intraday_bars (
      market_country TEXT NOT NULL DEFAULT 'KR',
      symbol TEXT NOT NULL,
      interval_minutes INTEGER NOT NULL,
      open_time TEXT NOT NULL,
      close_time TEXT NOT NULL,
      session_date TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      bar_state TEXT NOT NULL,
      open_price DOUBLE PRECISION NOT NULL,
      high_price DOUBLE PRECISION NOT NULL,
      low_price DOUBLE PRECISION NOT NULL,
      close_price DOUBLE PRECISION NOT NULL,
      volume DOUBLE PRECISION NOT NULL,
      turnover DOUBLE PRECISION,
      trade_count INTEGER,
      quality_status TEXT NOT NULL,
      updated_at BIGINT NOT NULL,
      PRIMARY KEY(market_country, symbol, interval_minutes, open_time)
    )
  `);
  await addMissingColumns(database, "portfolio_intraday_bars", {
    market_country: "TEXT NOT NULL DEFAULT 'KR'",
  });
  await database.run(`
    CREATE INDEX IF NOT EXISTS idx_portfolio_intraday_session
    ON portfolio_intraday_bars(symbol, interval_minutes, session_date, open_time)
  `);
  await database.run(`
    CREATE INDEX IF NOT EXISTS idx_portfolio_intraday_updated
    ON portfolio_intraday_bars(updated_at)
  `);
  await database.run(`
    CREATE TABLE IF NOT EXISTS portfolio_scalping_predictions (
      prediction_id TEXT PRIMARY KEY,
      market_country TEXT NOT NULL DEFAULT 'KR',
      symbol TEXT NOT NULL,
      model_name TEXT NOT NULL,
      model_version TEXT NOT NULL,
      input_ended_at TEXT NOT NULL,
      generated_at TEXT NOT NULL,
      status TEXT NOT NULL,
      data_quality TEXT NOT NULL,
      retrospective BOOLEAN NOT NULL,
      payload_json TEXT NOT NULL,
      created_at BIGINT NOT NULL
    )
  `);
  await addMissingColumns(database, "portfolio_scalping_predictions", {
    market_country: "TEXT NOT NULL DEFAULT 'KR'",
  });
  await database.run(`
    CREATE INDEX IF NOT EXISTS idx_portfolio_scalping_prediction_latest
    ON portfolio_scalping_predictions(symbol, retrospective, generated_at)
  `);
}

export async function createScalpingRawMarketDataTables(database: RelationalDatabase): Promise<void> {
  await database.run(`
    CREATE TABLE IF NOT EXISTS portfolio_scalping_trades (
      market_country TEXT NOT NULL,
      symbol TEXT NOT NULL,
      event_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      venue TEXT NOT NULL,
      exchange_code TEXT,
      session_feed TEXT,
      session_date TEXT NOT NULL,
      executed_at TEXT NOT NULL,
      received_at TEXT NOT NULL,
      price DOUBLE PRECISION NOT NULL,
      quantity DOUBLE PRECISION NOT NULL,
      trading_amount DOUBLE PRECISION,
      side TEXT NOT NULL,
      cumulative_volume DOUBLE PRECISION,
      cumulative_amount DOUBLE PRECISION,
      execution_strength DOUBLE PRECISION,
      execution_class TEXT,
      best_bid_price DOUBLE PRECISION,
      best_ask_price DOUBLE PRECISION,
      recorded_at BIGINT NOT NULL,
      PRIMARY KEY(market_country, symbol, event_id)
    )
  `);
  await database.run(`
    CREATE TABLE IF NOT EXISTS portfolio_scalping_orderbooks (
      snapshot_id TEXT PRIMARY KEY,
      market_country TEXT NOT NULL,
      symbol TEXT NOT NULL,
      provider TEXT NOT NULL,
      venue TEXT NOT NULL,
      exchange_code TEXT,
      session_feed TEXT,
      session_date TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      received_at TEXT NOT NULL,
      depth TEXT NOT NULL,
      asks_json TEXT NOT NULL,
      bids_json TEXT NOT NULL,
      total_ask_quantity DOUBLE PRECISION,
      total_bid_quantity DOUBLE PRECISION,
      best_ask_price DOUBLE PRECISION NOT NULL,
      best_ask_quantity DOUBLE PRECISION NOT NULL,
      best_bid_price DOUBLE PRECISION NOT NULL,
      best_bid_quantity DOUBLE PRECISION NOT NULL,
      recorded_at BIGINT NOT NULL
    )
  `);
  await database.run(`
    CREATE TABLE IF NOT EXISTS portfolio_scalping_recording_events (
      event_id TEXT PRIMARY KEY,
      market_country TEXT NOT NULL,
      symbol TEXT,
      event_type TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      code TEXT,
      details_json TEXT,
      recorded_at BIGINT NOT NULL
    )
  `);
  await createIndex(
    database,
    "idx_portfolio_scalping_trade_session",
    "portfolio_scalping_trades",
    "market_country, symbol, session_date, executed_at, received_at, recorded_at",
  );
  await createIndex(
    database,
    "idx_portfolio_scalping_orderbook_session",
    "portfolio_scalping_orderbooks",
    "market_country, symbol, session_date, observed_at, received_at, recorded_at",
  );
  await createIndex(
    database,
    "idx_portfolio_scalping_recording_symbol_time",
    "portfolio_scalping_recording_events",
    "market_country, symbol, occurred_at, recorded_at, event_id",
  );
  await createIndex(
    database,
    "idx_portfolio_scalping_recording_time_type",
    "portfolio_scalping_recording_events",
    "market_country, occurred_at, event_type, recorded_at, event_id",
  );
}

export async function widenScalpingMarketCountryForCrypto(
  database: RelationalDatabase,
): Promise<void> {
  await createIndex(
    database,
    "idx_portfolio_scalping_trade_provider_venue",
    "portfolio_scalping_trades",
    "market_country, provider, venue, symbol, executed_at",
  );
  await createIndex(
    database,
    "idx_portfolio_scalping_orderbook_provider_venue",
    "portfolio_scalping_orderbooks",
    "market_country, provider, venue, symbol, observed_at",
  );
}

async function hasIndex(database: RelationalDatabase, index: string): Promise<boolean> {
  const rows = await database.query<{ index_name: string }>(`
    SELECT indexname AS index_name
    FROM pg_indexes
    WHERE schemaname = current_schema() AND indexname = ?
  `, [index]);
  return rows.length > 0;
}

async function createIndex(
  database: RelationalDatabase,
  index: string,
  table: string,
  expression: string,
): Promise<void> {
  if (!await hasTable(database, table) || await hasIndex(database, index)) return;
  await database.run(`CREATE INDEX ${index} ON ${table}(${expression})`);
}

async function migrateRunManagement(database: RelationalDatabase): Promise<void> {
  await addMissingColumns(database, "portfolio_backtest_runs", {
    name: "TEXT",
    tags_json: "TEXT NOT NULL DEFAULT '[]'",
    archived_at: "BIGINT",
    deleted_at: "BIGINT",
    replay_of: "TEXT",
    manifest_json: "TEXT",
  });
  if (await hasTable(database, "portfolio_backtest_runs")) {
    await database.run("UPDATE portfolio_backtest_runs SET tags_json = '[]' WHERE tags_json IS NULL");
    await createIndex(
      database,
      "idx_portfolio_run_browse",
      "portfolio_backtest_runs",
      "owner_subject, deleted_at, archived_at, updated_at",
    );
    await createIndex(
      database,
      "idx_portfolio_run_replay",
      "portfolio_backtest_runs",
      "owner_subject, replay_of",
    );
  }
}

async function createPresetTables(database: RelationalDatabase): Promise<void> {
  await database.run(`
    CREATE TABLE IF NOT EXISTS portfolio_presets (
      preset_id TEXT PRIMARY KEY,
      owner_subject TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      config_json TEXT NOT NULL,
      tags_json TEXT NOT NULL,
      source_json TEXT NOT NULL,
      revision INTEGER NOT NULL,
      last_used_at BIGINT,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      deleted_at BIGINT
    )
  `);
  await database.run(`
    CREATE INDEX IF NOT EXISTS idx_portfolio_preset_browse
    ON portfolio_presets(owner_subject, deleted_at, updated_at)
  `);
  await database.run(`
    CREATE TABLE IF NOT EXISTS portfolio_preset_versions (
      version_id TEXT PRIMARY KEY,
      preset_id TEXT NOT NULL REFERENCES portfolio_presets(preset_id) ON DELETE CASCADE,
      revision INTEGER NOT NULL,
      snapshot_json TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      UNIQUE(preset_id, revision)
    )
  `);
  await database.run(`
    CREATE INDEX IF NOT EXISTS idx_portfolio_preset_versions
    ON portfolio_preset_versions(preset_id, revision)
  `);
}

async function canonicalizeLocalOwner(database: RelationalDatabase): Promise<void> {
  const legacyOwners = ["dashboard-http", "dashboard-report"];
  if (await hasTable(database, "portfolio_backtest_runs")) {
    type LegacyRun = { run_id: string; run_kind: string; request_hash: string; data_revision: string };
    for (const legacyOwner of legacyOwners) {
      const runs = await database.query<LegacyRun>(`
        SELECT run_id, run_kind, request_hash, data_revision
        FROM portfolio_backtest_runs
        WHERE owner_subject = ?
      `, [legacyOwner]);
      for (const run of runs) {
        const [canonical] = await database.query<{ run_id: string }>(`
          SELECT run_id FROM portfolio_backtest_runs
          WHERE owner_subject = ? AND run_kind = ? AND request_hash = ? AND data_revision = ?
        `, ["owner", run.run_kind, run.request_hash, run.data_revision]);
        if (canonical) {
          const migratedHash = createHash("sha256")
            .update(`canonical-owner-duplicate\n${run.run_id}\n${run.request_hash}`)
            .digest("hex");
          const migrationManifest = JSON.stringify({
            schema_version: "portfolio-lens-run-manifest/v1",
            finalized: false,
            migration: {
              id: "20260718_004_canonical_local_owner_reconciliation",
              original_owner: legacyOwner,
              original_request_hash: run.request_hash,
              canonical_run_id: canonical.run_id,
            },
          });
          await database.run(`
            UPDATE portfolio_backtest_runs
            SET owner_subject = ?, request_hash = ?, replay_of = COALESCE(replay_of, ?),
                manifest_json = COALESCE(manifest_json, ?)
            WHERE run_id = ? AND owner_subject = ?
          `, ["owner", migratedHash, canonical.run_id, migrationManifest, run.run_id, legacyOwner]);
        } else {
          await database.run(
            "UPDATE portfolio_backtest_runs SET owner_subject = ? WHERE run_id = ? AND owner_subject = ?",
            ["owner", run.run_id, legacyOwner],
          );
        }
      }
    }
  }
  if (await hasTable(database, "portfolio_presets")) {
    for (const legacyOwner of legacyOwners) {
      await database.run(
        "UPDATE portfolio_presets SET owner_subject = ? WHERE owner_subject = ?",
        ["owner", legacyOwner],
      );
    }
  }
  if (await hasTable(database, "portfolio_report_links")) {
    type LegacyReport = {
      report_id: string;
      request_hash: string;
      data_revision: string;
      engine_version: string;
      report_schema_version: string;
      report_config_hash: string;
    };
    for (const legacyOwner of legacyOwners) {
      const links = await database.query<LegacyReport>(`
        SELECT report_id, request_hash, data_revision, engine_version,
               report_schema_version, report_config_hash
        FROM portfolio_report_links
        WHERE owner_subject = ?
      `, [legacyOwner]);
      for (const link of links) {
        const [canonical] = await database.query<{ report_id: string }>(`
          SELECT report_id FROM portfolio_report_links
          WHERE owner_subject = ? AND request_hash = ? AND data_revision = ?
            AND engine_version = ? AND report_schema_version = ? AND report_config_hash = ?
        `, [
          "owner", link.request_hash, link.data_revision, link.engine_version,
          link.report_schema_version, link.report_config_hash,
        ]);
        if (canonical) {
          const migratedConfigHash = createHash("sha256")
            .update(`canonical-report-duplicate\n${link.report_id}\n${link.report_config_hash}`)
            .digest("hex");
          await database.run(`
            UPDATE portfolio_report_links
            SET owner_subject = ?, report_config_hash = ?
            WHERE report_id = ? AND owner_subject = ?
          `, ["owner", migratedConfigHash, link.report_id, legacyOwner]);
        } else {
          await database.run(
            "UPDATE portfolio_report_links SET owner_subject = ? WHERE report_id = ? AND owner_subject = ?",
            ["owner", link.report_id, legacyOwner],
          );
        }
      }
    }
  }
}

async function createPortfolioBaseSchema(database: RelationalDatabase): Promise<void> {
  const statements = [
    `CREATE TABLE IF NOT EXISTS portfolio_snapshots (
      id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      account_id VARCHAR(128) NOT NULL,
      snapshot_date CHAR(10) NOT NULL,
      captured_at BIGINT NOT NULL,
      origin VARCHAR(16) NOT NULL DEFAULT 'LIVE',
      UNIQUE(account_id, snapshot_date)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_snapshots_account_date
      ON portfolio_snapshots(account_id, snapshot_date)`,
    `CREATE TABLE IF NOT EXISTS portfolio_snapshot_items (
      snapshot_id BIGINT NOT NULL REFERENCES portfolio_snapshots(id) ON DELETE CASCADE,
      symbol VARCHAR(64) NOT NULL,
      name VARCHAR(255) NOT NULL,
      market VARCHAR(64) NOT NULL,
      currency VARCHAR(8) NOT NULL,
      evaluation_amount DOUBLE PRECISION NOT NULL,
      weight_percent DOUBLE PRECISION NOT NULL,
      PRIMARY KEY(snapshot_id, market, symbol, currency)
    )`,
    `CREATE TABLE IF NOT EXISTS portfolio_orders (
      account_id VARCHAR(128) NOT NULL,
      order_id VARCHAR(128) NOT NULL,
      symbol VARCHAR(64) NOT NULL,
      side VARCHAR(16) NOT NULL,
      currency VARCHAR(8) NOT NULL,
      status VARCHAR(32) NOT NULL,
      ordered_at VARCHAR(64) NOT NULL,
      filled_at VARCHAR(64) NOT NULL,
      filled_quantity DOUBLE PRECISION NOT NULL,
      average_filled_price DOUBLE PRECISION NOT NULL,
      filled_amount DOUBLE PRECISION NOT NULL,
      commission DOUBLE PRECISION NOT NULL,
      tax DOUBLE PRECISION NOT NULL,
      fetched_at BIGINT NOT NULL,
      PRIMARY KEY(account_id, order_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_orders_account_filled_at
      ON portfolio_orders(account_id, filled_at)`,
    `CREATE TABLE IF NOT EXISTS portfolio_instruments (
      instrument_key VARCHAR(96) PRIMARY KEY,
      symbol VARCHAR(64) NOT NULL,
      name VARCHAR(255) NOT NULL,
      market VARCHAR(64) NOT NULL,
      currency VARCHAR(8) NOT NULL,
      updated_at BIGINT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS portfolio_daily_prices (
      instrument_key VARCHAR(96) NOT NULL REFERENCES portfolio_instruments(instrument_key) ON DELETE CASCADE,
      price_date CHAR(10) NOT NULL,
      open_price DOUBLE PRECISION,
      high_price DOUBLE PRECISION,
      low_price DOUBLE PRECISION,
      close_price DOUBLE PRECISION NOT NULL,
      currency VARCHAR(8) NOT NULL,
      timestamp VARCHAR(64) NOT NULL,
      updated_at BIGINT NOT NULL,
      PRIMARY KEY(instrument_key, price_date)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_daily_prices_key_date
      ON portfolio_daily_prices(instrument_key, price_date)`,
    `CREATE TABLE IF NOT EXISTS portfolio_backtest_prices (
      instrument_key VARCHAR(96) NOT NULL,
      price_date CHAR(10) NOT NULL,
      close_price DOUBLE PRECISION NOT NULL,
      currency VARCHAR(8) NOT NULL,
      timestamp VARCHAR(64) NOT NULL,
      updated_at BIGINT NOT NULL,
      PRIMARY KEY(instrument_key, price_date)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_backtest_prices_key_date
      ON portfolio_backtest_prices(instrument_key, price_date)`,
    `CREATE TABLE IF NOT EXISTS portfolio_benchmark_prices (
      benchmark_key VARCHAR(32) NOT NULL,
      price_date CHAR(10) NOT NULL,
      close_price DOUBLE PRECISION NOT NULL,
      timestamp VARCHAR(64) NOT NULL,
      updated_at BIGINT NOT NULL,
      PRIMARY KEY(benchmark_key, price_date)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_benchmark_prices_key_date
      ON portfolio_benchmark_prices(benchmark_key, price_date)`,
    `CREATE TABLE IF NOT EXISTS portfolio_exchange_rates (
      rate_date CHAR(10) NOT NULL,
      base_currency VARCHAR(8) NOT NULL,
      quote_currency VARCHAR(8) NOT NULL,
      rate DOUBLE PRECISION NOT NULL,
      timestamp VARCHAR(64) NOT NULL,
      updated_at BIGINT NOT NULL,
      PRIMARY KEY(rate_date, base_currency, quote_currency)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_exchange_rates_pair_date
      ON portfolio_exchange_rates(base_currency, quote_currency, rate_date)`,
    `CREATE TABLE IF NOT EXISTS portfolio_backfill_state (
      account_id VARCHAR(128) PRIMARY KEY,
      status VARCHAR(16) NOT NULL,
      phase VARCHAR(24) NOT NULL,
      started_at VARCHAR(64),
      completed_at VARCHAR(64),
      updated_at VARCHAR(64) NOT NULL,
      first_trade_date CHAR(10),
      last_backfilled_date CHAR(10),
      orders_imported BIGINT NOT NULL DEFAULT 0,
      symbols_total BIGINT NOT NULL DEFAULT 0,
      symbols_processed BIGINT NOT NULL DEFAULT 0,
      prices_imported BIGINT NOT NULL DEFAULT 0,
      snapshots_created BIGINT NOT NULL DEFAULT 0,
      reconciled_symbols BIGINT NOT NULL DEFAULT 0,
      discrepancy_symbols BIGINT NOT NULL DEFAULT 0,
      failed_symbols BIGINT NOT NULL DEFAULT 0,
      message TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS portfolio_cash_ledger (
      account_id VARCHAR(128) NOT NULL,
      entry_id VARCHAR(128) NOT NULL,
      transaction_date CHAR(10) NOT NULL,
      transaction_time CHAR(5) NOT NULL,
      occurred_at VARCHAR(64) NOT NULL,
      title VARCHAR(255) NOT NULL,
      category VARCHAR(64) NOT NULL,
      kind VARCHAR(64) NOT NULL,
      currency VARCHAR(8) NOT NULL,
      amount DOUBLE PRECISION NOT NULL,
      balance DOUBLE PRECISION NOT NULL,
      instrument_name VARCHAR(255),
      quantity DOUBLE PRECISION,
      source VARCHAR(32) NOT NULL DEFAULT 'WTS_PASTE',
      imported_at BIGINT NOT NULL,
      PRIMARY KEY(account_id, entry_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_cash_ledger_account_date
      ON portfolio_cash_ledger(account_id, transaction_date, transaction_time)`,
    `CREATE TABLE IF NOT EXISTS portfolio_market_candles (
      source_kind VARCHAR(16) NOT NULL,
      symbol VARCHAR(64) NOT NULL,
      candle_interval VARCHAR(8) NOT NULL,
      adjusted SMALLINT NOT NULL,
      price_date CHAR(10) NOT NULL,
      timestamp VARCHAR(64) NOT NULL,
      currency VARCHAR(8) NOT NULL,
      open_price DOUBLE PRECISION NOT NULL,
      high_price DOUBLE PRECISION NOT NULL,
      low_price DOUBLE PRECISION NOT NULL,
      close_price DOUBLE PRECISION NOT NULL,
      volume DOUBLE PRECISION,
      updated_at BIGINT NOT NULL,
      PRIMARY KEY(source_kind, symbol, candle_interval, adjusted, timestamp)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_market_candles_lookup
      ON portfolio_market_candles(source_kind, symbol, candle_interval, adjusted, price_date)`,
    `CREATE TABLE IF NOT EXISTS portfolio_candle_responses (
      request_key CHAR(64) PRIMARY KEY,
      feature VARCHAR(32) NOT NULL,
      request_path VARCHAR(512) NOT NULL,
      source_kind VARCHAR(16) NOT NULL,
      symbol VARCHAR(64) NOT NULL,
      candle_interval VARCHAR(8) NOT NULL,
      adjusted SMALLINT NOT NULL,
      payload_json TEXT NOT NULL,
      fetched_at BIGINT NOT NULL,
      expires_at BIGINT NOT NULL
    )`,
  ];
  for (const statement of statements) await database.run(statement);
}

const migrations: readonly Migration[] = [
  {
    id: "20260731_011_postgres_base_schema",
    signature: "postgres-base-schema-v1;snapshots,orders,instruments,prices,backfill,cash,candles",
    up: createPortfolioBaseSchema,
  },
  {
    id: "20260718_001_run_management",
    signature: "portfolio_backtest_runs:name,tags_json,archived_at,deleted_at,replay_of,manifest_json;run-browse-v1",
    up: migrateRunManagement,
  },
  {
    id: "20260718_002_portfolio_presets",
    signature: "portfolio_presets-v1;portfolio_preset_versions-v1",
    up: createPresetTables,
  },
  {
    id: "20260718_003_canonical_local_owner",
    signature: "canonical-owner:owner;legacy:dashboard-http,dashboard-report;preserve-conflicting-run",
    up: canonicalizeLocalOwner,
  },
  {
    id: "20260718_004_canonical_local_owner_reconciliation",
    signature: "canonical-owner-reconcile-v2;preserve-run-and-report-conflicts;record-original-hash",
    up: canonicalizeLocalOwner,
  },
  {
    id: "20260721_005_market_candle_volume",
    signature: "portfolio_market_candles:nullable-provider-volume-v1",
    up: ensureMarketCandleVolumeColumn,
  },
  {
    id: "20260721_006_scalping_intraday_storage",
    signature: "portfolio_intraday_bars-v1;portfolio_scalping_predictions-v1;forming-final-quality",
    up: createScalpingTables,
  },
  {
    id: "20260721_007_scalping_volume_availability",
    signature: "portfolio_intraday_bars:volume_available-v1;missing-volume-is-not-zero",
    up: ensureScalpingVolumeAvailabilityColumn,
  },
  {
    id: "20260721_008_scalping_market_country",
    signature: "portfolio_intraday_bars:market-country-composite-pk-v1;portfolio_scalping_predictions:market-country-latest-v1;legacy-default:KR",
    up: ensureScalpingMarketCountry,
  },
  {
    id: "20260724_009_scalping_raw_market_data",
    signature: "portfolio_scalping_trades-v1;portfolio_scalping_orderbooks-v1;portfolio_scalping_recording_events-v1;raw-us-market-data-session-ordering-v2",
    up: createScalpingRawMarketDataTables,
  },
  {
    id: "20260725_010_binance_usdm_market",
    signature: "market-country:varchar32;value:BINANCE_USDM;provider:binance;venue:BINANCE_USDM;preserve-existing-primary-keys",
    up: widenScalpingMarketCountryForCrypto,
  },
  {
    id: LATEST_CONTRACT_CUTOVER_MIGRATION_ID,
    signature: LATEST_CONTRACT_CUTOVER_SIGNATURE,
    up: migrateLatestContracts,
  },
];

export async function applyPortfolioMigrations(
  database: RelationalDatabase,
  now = Date.now(),
): Promise<AppliedMigration[]> {
  await createLedger(database);
  for (const migration of migrations) {
    const expectedChecksum = checksum(migration);
    await database.transaction(async (transaction) => {
      const [applied] = await transaction.query<MigrationRow>(
        "SELECT migration_id, checksum, applied_at FROM portfolio_schema_migrations WHERE migration_id = ?",
        [migration.id],
      );
      if (applied) {
        if (applied.checksum !== expectedChecksum) {
          throw new Error(`DB migration checksum이 일치하지 않습니다: ${migration.id}`);
        }
        return;
      }
      await migration.up(transaction);
      await transaction.run(`
        INSERT INTO portfolio_schema_migrations (migration_id, checksum, applied_at)
        VALUES (?, ?, ?)
        ON CONFLICT(migration_id) DO NOTHING
      `, [migration.id, expectedChecksum, now]);
    });
  }
  return listAppliedMigrations(database);
}

export async function listAppliedMigrations(database: RelationalDatabase): Promise<AppliedMigration[]> {
  await createLedger(database);
  const rows = await database.query<MigrationRow>(`
    SELECT migration_id, checksum, applied_at
    FROM portfolio_schema_migrations
    ORDER BY migration_id ASC
  `);
  return rows.map((row) => ({
    id: row.migration_id,
    checksum: row.checksum,
    appliedAt: Number(row.applied_at),
  }));
}
