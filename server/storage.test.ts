import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "./env.js";
import type { PortfolioHistoryStore } from "./history.js";
import { openConfiguredHistoryStore } from "./storage.js";

type StorageConfigOverrides = Pick<Partial<AppConfig>, "dbProvider" | "mysql" | "postgres">;

function config(overrides: StorageConfigOverrides = {}): AppConfig {
  return {
    tossApiAuthMode: "oauth_client_credentials",
    clientId: "client-id",
    clientSecret: "client-secret",
    dashboardPassword: "dashboard-password-long",
    readOnlyApiToken: "read-only-api-token",
    readOnlyApiTokenSource: "READ_ONLY_API_TOKEN",
    sessionSecret: "session-secret-with-at-least-32-characters",
    host: "127.0.0.1",
    port: 3200,
    trustProxy: [],
    gracefulShutdownTimeoutMs: 30_000,
    tossApiBaseUrl: "https://example.invalid",
    dbProvider: "sqlite",
    databasePath: ":memory:",
    candleCacheLatestTtlMs: 300_000,
    snapshotRefreshHours: 6,
    nodeEnv: "test",
    publicAppUrl: "http://localhost:3200",
    reportStorage: { kind: "local", directory: "/tmp/reports" },
    compute: {
      executionMode: "inline",
      resultPollMs: 250,
      resultDeadlineMs: 300_000,
      rustSocketPath: "/tmp/toss-portfolio-lens-compute.sock",
      rustSocketPoolSize: 2,
      rustSocketTimeoutMs: 300_000,
    },
    mcp: {
      enabled: false,
      authMode: "oauth",
      allowedOrigins: [],
      maxRequestsPerMinute: 60,
      maxConcurrentRuns: 1,
      maxRunsPerSubject: 2,
      maxQueuedRuns: 4,
      runDeadlineMs: 120_000,
      maxAssets: 20,
      maxCandidateBudget: 2_000,
      maxDateRangeYears: 20,
      inlineResultMaxRows: 1_000,
      inlineResultMaxBytes: 204_800,
      auditRetentionDays: 90,
    },
    scalping: {
      enabled: false,
      minimumTopCount: 5,
      maximumTopCount: 50,
      ai: {
        url: "ws://127.0.0.1:8765/ws/scalping-ai/v1",
        authTokenFile: "/tmp/toss-portfolio-lens-ai-token",
        timeoutMs: 120_000,
        connectTimeoutMs: 10_000,
        reconnectBaseMs: 250,
        reconnectMaxMs: 10_000,
        maximumInFlight: 4,
        maximumBatchSize: 50,
        maximumRequestBytes: 64 * 1024 * 1024,
        maximumResponseBytes: 128 * 1024 * 1024,
      },
      simulation: {
        maximumDurationMinutes: 390,
        maximumActiveSessions: 2,
        selectionMaximumAttempts: 3,
        selectionRetryDelayMs: 15_000,
      },
    },
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
