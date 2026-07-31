import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { loadConfig } from "../server/env.js";
import type { DatabaseRow } from "../server/database.js";
import { openConfiguredHistoryStore } from "../server/storage.js";

const OUTPUT_PATH = ".cache/operations/postgres-maintenance.json";

type DatabaseSizeRow = {
  bytes: number | string;
  pretty: string;
};

type TableHealthRow = DatabaseRow & {
  table_name: string;
  total_bytes: number | string;
  table_bytes: number | string;
  index_bytes: number | string;
  live_rows: number | string;
  dead_rows: number | string;
  sequential_scans: number | string;
  index_scans: number | string;
  last_autovacuum: string | null;
  last_autoanalyze: string | null;
};

type RetentionRow = {
  total: number | string;
  active: number | string;
  archived: number | string;
  soft_deleted: number | string;
};

function numeric(value: number | string | null | undefined): number {
  return Number(value ?? 0);
}

async function main(): Promise<void> {
  const store = await openConfiguredHistoryStore(loadConfig());
  try {
    const database = store.relationalDatabase;
    const [databaseSize] = await database.query<DatabaseSizeRow>(`
      SELECT
        pg_database_size(current_database()) AS bytes,
        pg_size_pretty(pg_database_size(current_database())) AS pretty
    `);
    const tables = await database.query<TableHealthRow>(`
      SELECT
        statistics.relname AS table_name,
        pg_total_relation_size(statistics.relid) AS total_bytes,
        pg_relation_size(statistics.relid) AS table_bytes,
        pg_indexes_size(statistics.relid) AS index_bytes,
        statistics.n_live_tup AS live_rows,
        statistics.n_dead_tup AS dead_rows,
        statistics.seq_scan AS sequential_scans,
        statistics.idx_scan AS index_scans,
        statistics.last_autovacuum::text AS last_autovacuum,
        statistics.last_autoanalyze::text AS last_autoanalyze
      FROM pg_stat_user_tables statistics
      WHERE statistics.schemaname = current_schema()
      ORDER BY pg_total_relation_size(statistics.relid) DESC, statistics.relname
      LIMIT 50
    `);
    const [retention] = await database.query<RetentionRow>(`
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (
          WHERE archived_at IS NULL AND deleted_at IS NULL
        ) AS active,
        COUNT(*) FILTER (WHERE archived_at IS NOT NULL) AS archived,
        COUNT(*) FILTER (WHERE deleted_at IS NOT NULL) AS soft_deleted
      FROM portfolio_backtest_runs
    `);
    const normalizedTables = tables.map((table) => ({
      tableName: table.table_name,
      totalBytes: numeric(table.total_bytes),
      tableBytes: numeric(table.table_bytes),
      indexBytes: numeric(table.index_bytes),
      liveRows: numeric(table.live_rows),
      deadRows: numeric(table.dead_rows),
      deadRowRatio: numeric(table.live_rows) + numeric(table.dead_rows) === 0
        ? 0
        : numeric(table.dead_rows) / (numeric(table.live_rows) + numeric(table.dead_rows)),
      sequentialScans: numeric(table.sequential_scans),
      indexScans: numeric(table.index_scans),
      lastAutovacuum: table.last_autovacuum,
      lastAutoanalyze: table.last_autoanalyze,
    }));
    const report = {
      schemaVersion: "postgres-maintenance-report/v1",
      generatedAt: new Date().toISOString(),
      database: {
        bytes: numeric(databaseSize?.bytes),
        pretty: databaseSize?.pretty,
      },
      retention: {
        total: numeric(retention?.total),
        active: numeric(retention?.active),
        archived: numeric(retention?.archived),
        softDeleted: numeric(retention?.soft_deleted),
      },
      thresholds: {
        reviewDeadRowRatio: 0.2,
      },
      tables: normalizedTables,
      maintenanceCandidates: normalizedTables
        .filter((table) => table.deadRowRatio >= 0.2 && table.deadRows >= 1_000)
        .map((table) => table.tableName),
    };
    await mkdir(dirname(OUTPUT_PATH), { recursive: true });
    await writeFile(OUTPUT_PATH, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    console.log(JSON.stringify({
      database: report.database,
      retention: report.retention,
      maintenanceCandidates: report.maintenanceCandidates,
      output: OUTPUT_PATH,
    }));
  } finally {
    await store.close();
  }
}

await main();
