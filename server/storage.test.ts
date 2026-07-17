import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "./env.js";
import type { PortfolioHistoryStore } from "./history.js";
import { openConfiguredHistoryStore } from "./storage.js";

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    clientId: "client-id",
    clientSecret: "client-secret",
    dashboardPassword: "dashboard-password-long",
    sessionSecret: "session-secret-with-at-least-32-characters",
    host: "127.0.0.1",
    port: 3200,
    tossApiBaseUrl: "https://example.invalid",
    dbProvider: "sqlite",
    databasePath: ":memory:",
    candleCacheLatestTtlMs: 300_000,
    snapshotRefreshHours: 6,
    nodeEnv: "test",
    publicAppUrl: "http://localhost:3200",
    reportStorage: { kind: "local", directory: "/tmp/reports" },
    ...overrides,
  };
}

describe("configured history storage", () => {
  const stores: PortfolioHistoryStore[] = [];

  afterEach(async () => {
    await Promise.all(stores.splice(0).map((store) => store.close()));
    vi.restoreAllMocks();
  });

  it("DB_PROVIDER=sqlite이면 SQLite를 연다", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const store = await openConfiguredHistoryStore(config());
    stores.push(store);
    expect(store.backend).toBe("sqlite");
  });

  it("DB_PROVIDER=mysql이면 연결 실패 시 SQLite로 fallback하지 않는다", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(openConfiguredHistoryStore(config({
      dbProvider: "mysql",
      mysql: {
        host: "127.0.0.1",
        port: 1,
        user: "unavailable",
        password: "unavailable",
        database: "portfolio_lens",
        connectTimeoutMs: 500,
      },
    }))).rejects.toThrow();
  });

  it("DB_PROVIDER=postgresql이면 연결 실패 시 SQLite로 fallback하지 않는다", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(openConfiguredHistoryStore(config({
      dbProvider: "postgresql",
      postgres: {
        host: "127.0.0.1",
        port: 1,
        user: "unavailable",
        password: "unavailable",
        database: "portfolio_lens",
        connectTimeoutMs: 500,
      },
    }))).rejects.toThrow();
  });

  it("선택한 외부 DB 설정이 없으면 시작하지 않는다", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(openConfiguredHistoryStore(config({ dbProvider: "postgresql" })))
      .rejects.toThrow("DB_PROVIDER=postgresql 연결 설정이 없습니다");
  });

  it("DB_PROVIDER=sqlite이면 외부 DB 설정이 있어도 SQLite만 사용한다", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const store = await openConfiguredHistoryStore(config({
      mysql: {
        host: "127.0.0.1",
        port: 1,
        user: "unavailable",
        password: "unavailable",
        database: "portfolio_lens",
        connectTimeoutMs: 500,
      },
    }));
    stores.push(store);
    expect(store.backend).toBe("sqlite");
  });
});
