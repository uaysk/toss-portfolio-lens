import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "./env.js";

const mocks = vi.hoisted(() => ({
  openPostgresDatabase: vi.fn(),
  openHistoryStore: vi.fn(),
}));

vi.mock("./database.js", () => ({
  openPostgresDatabase: mocks.openPostgresDatabase,
}));

vi.mock("./history.js", () => ({
  PortfolioHistoryStore: {
    open: mocks.openHistoryStore,
  },
}));

import { openConfiguredHistoryStore } from "./storage.js";

const postgres = {
  host: "postgres",
  port: 5432,
  user: "portfolio",
  password: "password",
  database: "portfolio",
  connectTimeoutMs: 3_000,
};

describe("configured PostgreSQL history storage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("opens exactly the required PostgreSQL adapter and runs store migrations", async () => {
    const database = { kind: "postgres-database" };
    const store = { kind: "history-store" };
    mocks.openPostgresDatabase.mockResolvedValue(database);
    mocks.openHistoryStore.mockResolvedValue(store);

    await expect(openConfiguredHistoryStore({ postgres } as AppConfig)).resolves.toBe(store);
    expect(mocks.openPostgresDatabase).toHaveBeenCalledOnce();
    expect(mocks.openPostgresDatabase).toHaveBeenCalledWith(postgres);
    expect(mocks.openHistoryStore).toHaveBeenCalledWith(database);
  });

  it("propagates connection and migration failures without fallback", async () => {
    const connectionFailure = new Error("postgres unavailable");
    mocks.openPostgresDatabase.mockRejectedValue(connectionFailure);
    await expect(openConfiguredHistoryStore({ postgres } as AppConfig))
      .rejects.toBe(connectionFailure);
    expect(mocks.openHistoryStore).not.toHaveBeenCalled();

    const database = { kind: "postgres-database" };
    const migrationFailure = new Error("migration checksum mismatch");
    mocks.openPostgresDatabase.mockResolvedValue(database);
    mocks.openHistoryStore.mockRejectedValue(migrationFailure);
    await expect(openConfiguredHistoryStore({ postgres } as AppConfig))
      .rejects.toBe(migrationFailure);
  });
});
