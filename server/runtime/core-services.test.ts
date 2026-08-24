import { describe, expect, it, vi } from "vitest";
import type { DatabaseRow, RelationalDatabase, RunResult } from "../database.js";
import { PortfolioHistoryStore } from "../history.js";
import { RuntimeTelemetry } from "../observability/runtime-telemetry.js";
import { initializeCorePersistence } from "./core-services.js";

function countingDatabase(): {
  database: RelationalDatabase;
  appliedMigrationIds: string[];
} {
  const appliedMigrationIds: string[] = [];
  const database: RelationalDatabase = {
    async query<T extends DatabaseRow>(): Promise<T[]> {
      return [];
    },
    async run(sql: string, parameters: unknown[] = []): Promise<RunResult> {
      if (sql.includes("INSERT INTO portfolio_schema_migrations")) {
        appliedMigrationIds.push(String(parameters[0]));
      }
      return { affectedRows: 0 };
    },
    async transaction<T>(work: (transaction: RelationalDatabase) => Promise<T>): Promise<T> {
      return work(database);
    },
    close: vi.fn().mockResolvedValue(undefined),
  };
  return { database, appliedMigrationIds };
}

describe("initializeCorePersistence", () => {
  it("history startup의 단일 migration pass를 production repository들이 반복하지 않는다", async () => {
    const { database, appliedMigrationIds } = countingDatabase();
    const historyStore = await PortfolioHistoryStore.open(database);
    const initiallyApplied = [...appliedMigrationIds];

    await initializeCorePersistence({
      database,
      runtimeTelemetry: new RuntimeTelemetry(),
      scalpingEnabled: true,
      migrationsAlreadyApplied: true,
    });

    expect(initiallyApplied).toContain("20260731_011_postgres_base_schema");
    expect(initiallyApplied).toContain("20260823_013_legacy_common_candle_backfill");
    expect(new Set(initiallyApplied).size).toBe(initiallyApplied.length);
    expect(appliedMigrationIds).toEqual(initiallyApplied);
    await historyStore.close();
  });

  it("직접 구성할 때도 migration을 한 번만 소유한다", async () => {
    const { database, appliedMigrationIds } = countingDatabase();

    await initializeCorePersistence({
      database,
      runtimeTelemetry: new RuntimeTelemetry(),
      scalpingEnabled: true,
    });

    expect(appliedMigrationIds).toContain("20260731_011_postgres_base_schema");
    expect(appliedMigrationIds).toContain("20260823_013_legacy_common_candle_backfill");
    expect(new Set(appliedMigrationIds).size).toBe(appliedMigrationIds.length);
  });
});
