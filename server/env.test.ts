import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "./env.js";

describe("MySQL environment configuration", () => {
  const originalEnvironment = { ...process.env };

  beforeEach(() => {
    process.env = {
      CLIENT_ID: "client-id",
      CLIENT_SECRET: "client-secret",
      DASHBOARD_PASSWORD: "dashboard-password-long",
      SESSION_SECRET: "session-secret-with-at-least-32-characters",
    };
  });

  afterEach(() => {
    process.env = { ...originalEnvironment };
    vi.restoreAllMocks();
  });

  it("MySQL 값이 없으면 SQLite를 기본값으로 사용한다", () => {
    const config = loadConfig();
    expect(config.mysql).toBeUndefined();
    expect(config.databasePath).toBe("./data/portfolio-history.sqlite");
  });

  it("개별 MySQL 값을 모두 설정하면 연결 구성을 만든다", () => {
    Object.assign(process.env, {
      MYSQL_HOST: "mysql.internal",
      MYSQL_PORT: "3307",
      MYSQL_USER: "portfolio",
      MYSQL_PASSWORD: "database-password",
      MYSQL_DATABASE: "portfolio_lens",
      MYSQL_CONNECT_TIMEOUT_MS: "2500",
      MYSQL_SSL: "true",
      MYSQL_SSL_REJECT_UNAUTHORIZED: "false",
    });

    expect(loadConfig().mysql).toEqual({
      host: "mysql.internal",
      port: 3307,
      user: "portfolio",
      password: "database-password",
      database: "portfolio_lens",
      connectTimeoutMs: 2500,
      ssl: { rejectUnauthorized: false },
    });
  });

  it("MYSQL_URL도 지원하고 일부만 설정된 값은 안전하게 무시한다", () => {
    process.env.MYSQL_URL = "mysql://portfolio:p%40ss@mysql.internal:3306/portfolio_lens";
    expect(loadConfig().mysql).toMatchObject({
      host: "mysql.internal",
      port: 3306,
      user: "portfolio",
      password: "p@ss",
      database: "portfolio_lens",
    });

    delete process.env.MYSQL_URL;
    process.env.MYSQL_HOST = "mysql.internal";
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(loadConfig().mysql).toBeUndefined();
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining("MySQL 설정을 사용할 수 없어 SQLite를 사용합니다"),
      expect.stringContaining("모두 필요합니다"),
    );
  });
});
