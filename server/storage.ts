import { openPostgresDatabase } from "./database.js";
import type { RelationalDatabase } from "./database.js";
import type { AppConfig } from "./env.js";
import { PortfolioHistoryStore } from "./history.js";

export async function openConfiguredHistoryStore(config: AppConfig): Promise<PortfolioHistoryStore> {
  let database: RelationalDatabase | undefined;
  try {
    database = await openPostgresDatabase(config.postgres);
    const store = await PortfolioHistoryStore.open(database);
    console.info("[storage] PostgreSQL 연결과 migration을 완료했습니다.");
    return store;
  } catch (error) {
    if (database) {
      try {
        await database.close();
      } catch (closeError) {
        console.warn(
          "[storage] 시작 실패 후 PostgreSQL 연결 정리에 실패했습니다:",
          closeError instanceof Error ? closeError.message : closeError,
        );
      }
    }
    console.error(
      "[storage] PostgreSQL 연결 또는 migration에 실패해 시작을 중단합니다:",
      error instanceof Error ? error.message : error,
    );
    throw error;
  }
}
