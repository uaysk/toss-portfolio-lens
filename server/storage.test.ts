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
    databasePath: ":memory:",
    snapshotRefreshHours: 6,
    nodeEnv: "test",
    ...overrides,
  };
}

describe("configured history storage", () => {
  const stores: PortfolioHistoryStore[] = [];

  afterEach(async () => {
    await Promise.all(stores.splice(0).map((store) => store.close()));
    vi.restoreAllMocks();
  });

  it("MySQL 설정이 없으면 SQLite를 연다", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const store = await openConfiguredHistoryStore(config());
    stores.push(store);
    expect(store.backend).toBe("sqlite");
  });

  it("MySQL에 연결할 수 없으면 SQLite로 fallback한다", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
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
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining("MySQL 연결 또는 마이그레이션에 실패해 SQLite를 사용합니다"),
      expect.anything(),
    );
  });
});
