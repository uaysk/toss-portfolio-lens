import {
  openMySqlDatabase,
  openPostgresDatabase,
  type RelationalDatabase,
} from "./database.js";
import type { AppConfig } from "./env.js";
import { PortfolioHistoryStore } from "./history.js";

function migratedRowCount(rows: Record<string, number>): number {
  return Object.values(rows).reduce((sum, count) => sum + count, 0);
}

type ExternalBackend = "PostgreSQL" | "MySQL";

async function openAndMigrate(
  backend: ExternalBackend,
  database: RelationalDatabase,
  sqliteStore: PortfolioHistoryStore,
): Promise<PortfolioHistoryStore> {
  let targetStore: PortfolioHistoryStore | undefined;
  try {
    targetStore = await PortfolioHistoryStore.open(database);
    const migration = await PortfolioHistoryStore.migrateSqliteData(
      sqliteStore,
      targetStore,
      await sqliteStore.migrationFingerprint(),
    );
    if (migration.skipped) {
      console.info(`[storage] SQLite 데이터 변경이 없어 ${backend} 마이그레이션을 건너뜁니다.`);
    } else {
      console.info(
        `[storage] SQLite 데이터 ${migratedRowCount(migration.rows).toLocaleString("en-US")}행을 ${backend}로 마이그레이션했습니다.`,
      );
    }
    return targetStore;
  } catch (error) {
    if (targetStore) await targetStore.close().catch(() => undefined);
    else await database.close().catch(() => undefined);
    throw error;
  }
}

export async function openConfiguredHistoryStore(config: AppConfig): Promise<PortfolioHistoryStore> {
  const sqliteStore = await PortfolioHistoryStore.openSqlite(config.databasePath);
  if (config.dbProvider === "sqlite") {
    console.info("[storage] DB_PROVIDER=sqlite: SQLite를 사용합니다.");
    return sqliteStore;
  }

  try {
    if (config.dbProvider === "postgresql") {
      if (!config.postgres) throw new Error("DB_PROVIDER=postgresql 연결 설정이 없습니다.");
      const store = await openAndMigrate(
        "PostgreSQL",
        await openPostgresDatabase(config.postgres),
        sqliteStore,
      );
      await sqliteStore.close();
      console.info("[storage] DB_PROVIDER=postgresql: PostgreSQL을 사용합니다.");
      return store;
    }

    if (!config.mysql) throw new Error("DB_PROVIDER=mysql 연결 설정이 없습니다.");
    const store = await openAndMigrate(
      "MySQL",
      await openMySqlDatabase(config.mysql),
      sqliteStore,
    );
    await sqliteStore.close();
    console.info("[storage] DB_PROVIDER=mysql: MySQL/MariaDB를 사용합니다.");
    return store;
  } catch (error) {
    await sqliteStore.close().catch(() => undefined);
    console.error(
      `[storage] DB_PROVIDER=${config.dbProvider} 연결 또는 마이그레이션에 실패해 시작을 중단합니다:`,
      error instanceof Error ? error.message : error,
    );
    throw error;
  }
}
