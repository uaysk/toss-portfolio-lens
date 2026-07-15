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

  it("공개 URL과 OpenAI 보고서 설정을 정규화한다", () => {
    Object.assign(process.env, {
      PUBLIC_APP_URL: "tpl.uaysk.com/",
      OPENAI_API_ENDPOINT: "https://api.openai.com/v1/",
      OPENAI_API_KEY: "test-openai-key",
      OPENAI_MODEL: "test-model",
      OPENAI_TIMEOUT_MS: "45000",
      REPORTS_PATH: "/tmp/portfolio-reports",
    });
    const config = loadConfig();
    expect(config.publicAppUrl).toBe("https://tpl.uaysk.com");
    expect(config.openAi).toEqual({
      endpoint: "https://api.openai.com/v1",
      apiKey: "test-openai-key",
      model: "test-model",
      timeoutMs: 45_000,
    });
    expect(config.reportStorage).toEqual({ kind: "local", directory: "/tmp/portfolio-reports" });
  });

  it("S3_BUCKET이 있으면 S3 보고서 저장소를 선택한다", () => {
    Object.assign(process.env, {
      S3_BUCKET: "portfolio-reports",
      S3_REGION: "ap-northeast-2",
      S3_PREFIX: "/lens/reports/",
      S3_ENDPOINT: "http://minio.internal:9000/",
      S3_ACCESS_KEY_ID: "access-key",
      S3_SECRET_ACCESS_KEY: "secret-key",
    });
    expect(loadConfig().reportStorage).toEqual({
      kind: "s3",
      bucket: "portfolio-reports",
      region: "ap-northeast-2",
      prefix: "lens/reports",
      endpoint: "http://minio.internal:9000",
      forcePathStyle: true,
      credentials: { accessKeyId: "access-key", secretAccessKey: "secret-key" },
    });
  });
});
