import { openPostgresDatabase } from "./database.js";
import type { AppConfig } from "./env.js";
import { PortfolioHistoryStore } from "./history.js";

export async function openConfiguredHistoryStore(config: AppConfig): Promise<PortfolioHistoryStore> {
  try {
    const database = await openPostgresDatabase(config.postgres);
    const store = await PortfolioHistoryStore.open(database);
    console.info("[storage] PostgreSQL 연결과 migration을 완료했습니다.");
    return store;
  } catch (error) {
    console.error(
      "[storage] PostgreSQL 연결 또는 migration에 실패해 시작을 중단합니다:",
      error instanceof Error ? error.message : error,
    );
    throw error;
  }
}
