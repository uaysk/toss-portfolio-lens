import { openMySqlDatabase, type RelationalDatabase } from "./database.js";
import type { AppConfig } from "./env.js";
import { PortfolioHistoryStore } from "./history.js";

function migratedRowCount(rows: Record<string, number>): number {
  return Object.values(rows).reduce((sum, count) => sum + count, 0);
}

export async function openConfiguredHistoryStore(config: AppConfig): Promise<PortfolioHistoryStore> {
  const sqliteStore = await PortfolioHistoryStore.openSqlite(config.databasePath);
  if (!config.mysql) {
    console.info("[storage] SQLite를 사용합니다.");
    return sqliteStore;
  }

  let mysqlStore: PortfolioHistoryStore | undefined;
  let mysqlDatabase: RelationalDatabase | undefined;
  try {
    mysqlDatabase = await openMySqlDatabase(config.mysql);
    mysqlStore = await PortfolioHistoryStore.open(mysqlDatabase);
    const migration = await PortfolioHistoryStore.migrateSqliteData(
      sqliteStore,
      mysqlStore,
      await sqliteStore.migrationFingerprint(),
    );
    if (migration.skipped) {
      console.info("[storage] SQLite 데이터 변경이 없어 MySQL 마이그레이션을 건너뜁니다.");
    } else {
      console.info(`[storage] SQLite 데이터 ${migratedRowCount(migration.rows).toLocaleString("en-US")}행을 MySQL로 마이그레이션했습니다.`);
    }
    await sqliteStore.close();
    console.info("[storage] MySQL을 사용합니다.");
    return mysqlStore;
  } catch (error) {
    if (mysqlStore) await mysqlStore.close().catch(() => undefined);
    else if (mysqlDatabase) await mysqlDatabase.close().catch(() => undefined);
    console.warn(
      "[storage] MySQL 연결 또는 마이그레이션에 실패해 SQLite를 사용합니다:",
      error instanceof Error ? error.message : error,
    );
    return sqliteStore;
  }
}
