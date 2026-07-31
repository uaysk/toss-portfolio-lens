import { loadConfig } from "../server/env.js";
import { listAppliedMigrations } from "../server/migrations.js";
import { openConfiguredHistoryStore } from "../server/storage.js";

type CountRow = {
  count: number | string;
};

type JobVersionRow = {
  payload_schema_version: string;
  state: string;
  count: number | string;
};

async function main(): Promise<void> {
  const store = await openConfiguredHistoryStore(loadConfig());
  try {
    const database = store.relationalDatabase;
    const [activeRuns] = await database.query<CountRow>(`
      SELECT COUNT(*) AS count
      FROM portfolio_backtest_runs
      WHERE status IN ('queued', 'running', 'cancel_requested')
    `);
    const activeJobs = await database.query<JobVersionRow>(`
      SELECT payload_schema_version, state, COUNT(*) AS count
      FROM portfolio_run_jobs
      WHERE state IN ('queued', 'running')
      GROUP BY payload_schema_version, state
      ORDER BY payload_schema_version, state
    `);
    const [nonCanonicalOptimizations] = await database.query<CountRow>(`
      SELECT COUNT(*) AS count
      FROM portfolio_optimization_runs optimization
      JOIN portfolio_backtest_runs run ON run.run_id = optimization.run_id
      WHERE run.archived_at IS NULL
        AND run.deleted_at IS NULL
        AND optimization.objective_version NOT LIKE '%:metrics-v2'
    `);
    const migrations = await listAppliedMigrations(database);
    const activeRunCount = Number(activeRuns?.count ?? 0);
    const activeJobCount = activeJobs.reduce(
      (total, row) => total + Number(row.count),
      0,
    );
    const incompatibleActiveJobs = activeJobs.filter(
      (row) => row.payload_schema_version !== "2.0",
    );
    const nonCanonicalOptimizationCount = Number(
      nonCanonicalOptimizations?.count ?? 0,
    );
    const ready = activeRunCount === 0
      && activeJobCount === 0
      && incompatibleActiveJobs.length === 0
      && nonCanonicalOptimizationCount === 0;
    const report = {
      schemaVersion: "latest-contract-cutover-readiness/v1",
      checkedAt: new Date().toISOString(),
      ready,
      activeRunCount,
      activeJobCount,
      activeJobs: activeJobs.map((row) => ({
        payloadSchemaVersion: row.payload_schema_version,
        state: row.state,
        count: Number(row.count),
      })),
      incompatibleActiveJobCount: incompatibleActiveJobs.reduce(
        (total, row) => total + Number(row.count),
        0,
      ),
      nonCanonicalOptimizationCount,
      appliedMigrationCount: migrations.length,
      latestMigration: migrations.at(-1)?.id,
    };
    console.log(JSON.stringify(report));
    if (!ready) {
      throw new Error("latest contract cutover readiness gate failed");
    }
  } finally {
    await store.close();
  }
}

await main();
