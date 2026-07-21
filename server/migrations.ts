import { createHash } from "node:crypto";
import type { DatabaseDialect, RelationalDatabase } from "./database.js";

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
  if (database.dialect === "mysql") {
    await database.run(`
      CREATE TABLE IF NOT EXISTS portfolio_schema_migrations (
        migration_id VARCHAR(128) PRIMARY KEY,
        checksum CHAR(64) NOT NULL,
        applied_at BIGINT NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    return;
  }
  const timestamp = database.dialect === "postgres" ? "BIGINT" : "INTEGER";
  await database.run(`
    CREATE TABLE IF NOT EXISTS portfolio_schema_migrations (
      migration_id TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at ${timestamp} NOT NULL
    )
  `);
}

async function hasTable(database: RelationalDatabase, table: string): Promise<boolean> {
  if (database.dialect === "sqlite") {
    const rows = await database.query<{ table_name: string }>(
      "SELECT name AS table_name FROM sqlite_master WHERE type = 'table' AND name = ?",
      [table],
    );
    return rows.length > 0;
  }
  if (database.dialect === "mysql") {
    const rows = await database.query<{ table_name: string }>(`
      SELECT TABLE_NAME AS table_name
      FROM information_schema.tables
      WHERE table_schema = DATABASE() AND table_name = ?
    `, [table]);
    return rows.length > 0;
  }
  const rows = await database.query<{ table_name: string }>(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = ?
  `, [table]);
  return rows.length > 0;
}

async function columns(database: RelationalDatabase, table: string): Promise<Set<string>> {
  if (database.dialect === "sqlite") {
    const rows = await database.query<{ name: string }>(`PRAGMA table_info(${table})`);
    return new Set(rows.map((row) => row.name.toLowerCase()));
  }
  if (database.dialect === "mysql") {
    const rows = await database.query<{ column_name: string }>(`
      SELECT COLUMN_NAME AS column_name
      FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ?
    `, [table]);
    return new Set(rows.map((row) => row.column_name.toLowerCase()));
  }
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
  definitions: Record<string, Record<DatabaseDialect, string>>,
): Promise<void> {
  if (!await hasTable(database, table)) return;
  const existing = await columns(database, table);
  for (const [name, byDialect] of Object.entries(definitions)) {
    if (existing.has(name.toLowerCase())) continue;
    await database.run(`ALTER TABLE ${table} ADD COLUMN ${name} ${byDialect[database.dialect]}`);
    existing.add(name.toLowerCase());
  }
}

export async function ensureMarketCandleVolumeColumn(database: RelationalDatabase): Promise<void> {
  await addMissingColumns(database, "portfolio_market_candles", {
    volume: {
      sqlite: "REAL",
      mysql: "DOUBLE NULL",
      postgres: "DOUBLE PRECISION",
    },
  });
}

async function ensureScalpingVolumeAvailabilityColumn(database: RelationalDatabase): Promise<void> {
  await addMissingColumns(database, "portfolio_intraday_bars", {
    volume_available: {
      sqlite: "INTEGER NOT NULL DEFAULT 1",
      mysql: "TINYINT(1) NOT NULL DEFAULT 1",
      postgres: "BOOLEAN NOT NULL DEFAULT TRUE",
    },
  });
}

async function createScalpingTables(database: RelationalDatabase): Promise<void> {
  if (database.dialect === "mysql") {
    await database.run(`
      CREATE TABLE IF NOT EXISTS portfolio_intraday_bars (
        symbol VARCHAR(32) NOT NULL,
        interval_minutes INT NOT NULL,
        open_time VARCHAR(40) NOT NULL,
        close_time VARCHAR(40) NOT NULL,
        session_date VARCHAR(10) NOT NULL,
        source_kind VARCHAR(32) NOT NULL,
        bar_state VARCHAR(16) NOT NULL,
        open_price DOUBLE NOT NULL,
        high_price DOUBLE NOT NULL,
        low_price DOUBLE NOT NULL,
        close_price DOUBLE NOT NULL,
        volume DOUBLE NOT NULL,
        turnover DOUBLE NULL,
        trade_count INT NULL,
        quality_status VARCHAR(32) NOT NULL,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY(symbol, interval_minutes, open_time),
        KEY idx_portfolio_intraday_session (symbol, interval_minutes, session_date, open_time),
        KEY idx_portfolio_intraday_updated (updated_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await database.run(`
      CREATE TABLE IF NOT EXISTS portfolio_scalping_predictions (
        prediction_id VARCHAR(64) PRIMARY KEY,
        symbol VARCHAR(32) NOT NULL,
        model_name VARCHAR(128) NOT NULL,
        model_version VARCHAR(128) NOT NULL,
        input_ended_at VARCHAR(40) NOT NULL,
        generated_at VARCHAR(40) NOT NULL,
        status VARCHAR(32) NOT NULL,
        data_quality VARCHAR(32) NOT NULL,
        retrospective TINYINT(1) NOT NULL,
        payload_json LONGTEXT NOT NULL,
        created_at BIGINT NOT NULL,
        KEY idx_portfolio_scalping_prediction_latest (symbol, retrospective, generated_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    return;
  }
  const real = database.dialect === "postgres" ? "DOUBLE PRECISION" : "REAL";
  const timestamp = database.dialect === "postgres" ? "BIGINT" : "INTEGER";
  const boolean = database.dialect === "postgres" ? "BOOLEAN" : "INTEGER";
  await database.run(`
    CREATE TABLE IF NOT EXISTS portfolio_intraday_bars (
      symbol TEXT NOT NULL,
      interval_minutes INTEGER NOT NULL,
      open_time TEXT NOT NULL,
      close_time TEXT NOT NULL,
      session_date TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      bar_state TEXT NOT NULL,
      open_price ${real} NOT NULL,
      high_price ${real} NOT NULL,
      low_price ${real} NOT NULL,
      close_price ${real} NOT NULL,
      volume ${real} NOT NULL,
      turnover ${real},
      trade_count INTEGER,
      quality_status TEXT NOT NULL,
      updated_at ${timestamp} NOT NULL,
      PRIMARY KEY(symbol, interval_minutes, open_time)
    )
  `);
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
      symbol TEXT NOT NULL,
      model_name TEXT NOT NULL,
      model_version TEXT NOT NULL,
      input_ended_at TEXT NOT NULL,
      generated_at TEXT NOT NULL,
      status TEXT NOT NULL,
      data_quality TEXT NOT NULL,
      retrospective ${boolean} NOT NULL,
      payload_json TEXT NOT NULL,
      created_at ${timestamp} NOT NULL
    )
  `);
  await database.run(`
    CREATE INDEX IF NOT EXISTS idx_portfolio_scalping_prediction_latest
    ON portfolio_scalping_predictions(symbol, retrospective, generated_at)
  `);
}

async function hasIndex(database: RelationalDatabase, index: string): Promise<boolean> {
  if (database.dialect === "sqlite") {
    const rows = await database.query<{ index_name: string }>(
      "SELECT name AS index_name FROM sqlite_master WHERE type = 'index' AND name = ?",
      [index],
    );
    return rows.length > 0;
  }
  if (database.dialect === "mysql") {
    const rows = await database.query<{ index_name: string }>(`
      SELECT DISTINCT INDEX_NAME AS index_name
      FROM information_schema.statistics
      WHERE table_schema = DATABASE() AND index_name = ?
    `, [index]);
    return rows.length > 0;
  }
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
    name: {
      sqlite: "TEXT",
      mysql: "VARCHAR(200) NULL",
      postgres: "TEXT",
    },
    tags_json: {
      sqlite: "TEXT NOT NULL DEFAULT '[]'",
      mysql: "LONGTEXT NULL",
      postgres: "TEXT NOT NULL DEFAULT '[]'",
    },
    archived_at: {
      sqlite: "INTEGER",
      mysql: "BIGINT NULL",
      postgres: "BIGINT",
    },
    deleted_at: {
      sqlite: "INTEGER",
      mysql: "BIGINT NULL",
      postgres: "BIGINT",
    },
    replay_of: {
      sqlite: "TEXT",
      mysql: "VARCHAR(64) NULL",
      postgres: "TEXT",
    },
    manifest_json: {
      sqlite: "TEXT",
      mysql: "LONGTEXT NULL",
      postgres: "TEXT",
    },
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
  if (database.dialect === "mysql") {
    await database.run(`
      CREATE TABLE IF NOT EXISTS portfolio_presets (
        preset_id VARCHAR(64) PRIMARY KEY,
        owner_subject VARCHAR(128) NOT NULL,
        name VARCHAR(200) NOT NULL,
        description TEXT NOT NULL,
        config_json LONGTEXT NOT NULL,
        tags_json LONGTEXT NOT NULL,
        source_json LONGTEXT NOT NULL,
        revision INT NOT NULL,
        last_used_at BIGINT NULL,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        deleted_at BIGINT NULL,
        KEY idx_portfolio_preset_browse (owner_subject, deleted_at, updated_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await database.run(`
      CREATE TABLE IF NOT EXISTS portfolio_preset_versions (
        version_id VARCHAR(64) PRIMARY KEY,
        preset_id VARCHAR(64) NOT NULL,
        revision INT NOT NULL,
        snapshot_json LONGTEXT NOT NULL,
        created_at BIGINT NOT NULL,
        UNIQUE KEY uq_portfolio_preset_revision (preset_id, revision),
        KEY idx_portfolio_preset_versions (preset_id, revision),
        CONSTRAINT fk_portfolio_preset_versions_preset FOREIGN KEY (preset_id)
          REFERENCES portfolio_presets(preset_id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    return;
  }
  const timestamp = database.dialect === "postgres" ? "BIGINT" : "INTEGER";
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
      last_used_at ${timestamp},
      created_at ${timestamp} NOT NULL,
      updated_at ${timestamp} NOT NULL,
      deleted_at ${timestamp}
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
      created_at ${timestamp} NOT NULL,
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

const migrations: readonly Migration[] = [
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
      if (transaction.dialect === "mysql") {
        await transaction.run(`
          INSERT IGNORE INTO portfolio_schema_migrations (migration_id, checksum, applied_at)
          VALUES (?, ?, ?)
        `, [migration.id, expectedChecksum, now]);
      } else {
        await transaction.run(`
          INSERT INTO portfolio_schema_migrations (migration_id, checksum, applied_at)
          VALUES (?, ?, ?)
          ON CONFLICT(migration_id) DO NOTHING
        `, [migration.id, expectedChecksum, now]);
      }
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
