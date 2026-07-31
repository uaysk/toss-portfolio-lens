import { loadConfig } from "../server/env.js";
import { listAppliedMigrations } from "../server/migrations.js";
import { openConfiguredHistoryStore } from "../server/storage.js";

const store = await openConfiguredHistoryStore(loadConfig());
try {
  const database = store.relationalDatabase;
  const [{ value }] = await database.query<{ value: number }>("SELECT 1 AS value");
  if (Number(value) !== 1) throw new Error("PostgreSQL SELECT probe failed.");

  const migrations = await listAppliedMigrations(database);
  if (!migrations.length) throw new Error("No PostgreSQL migrations were recorded.");
  if (migrations.some(({ checksum }) => !/^[a-f0-9]{64}$/.test(checksum))) {
    throw new Error("A PostgreSQL migration checksum is invalid.");
  }

  let rolledBack = false;
  try {
    await database.transaction(async (transaction) => {
      await transaction.run(
        "CREATE TEMP TABLE portfolio_transaction_probe(value INTEGER NOT NULL)",
      );
      await transaction.run(
        "INSERT INTO portfolio_transaction_probe(value) VALUES (?)",
        [1],
      );
      throw new Error("rollback-probe");
    });
  } catch (error) {
    rolledBack = error instanceof Error && error.message === "rollback-probe";
  }
  if (!rolledBack) throw new Error("PostgreSQL transaction rollback probe failed.");

  process.stdout.write(`${JSON.stringify({
    ok: true,
    backend: "postgres",
    migrationCount: migrations.length,
    latestMigration: migrations.at(-1)?.id,
  })}\n`);
} finally {
  await store.close();
}
