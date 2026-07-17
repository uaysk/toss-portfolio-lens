import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync, writeFileSync } from "node:fs";
import { loadConfig } from "./env.js";

const mysqlCaPath = "/tmp/toss-portfolio-lens-env-test-ca.pem";
const postgresCaPath = "/tmp/toss-portfolio-lens-env-test-postgres-ca.pem";

describe("database environment configuration", () => {
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
    rmSync(mysqlCaPath, { force: true });
    rmSync(postgresCaPath, { force: true });
    process.env = { ...originalEnvironment };
    vi.restoreAllMocks();
  });

  it("DB_PROVIDER가 없으면 SQLite를 기본값으로 사용한다", () => {
    const config = loadConfig();
    expect(config).toMatchObject({
      tossApiAuthMode: "oauth_client_credentials",
      clientId: "client-id",
      clientSecret: "client-secret",
      tossApiBaseUrl: "https://openapi.tossinvest.com",
      dbProvider: "sqlite",
    });
    expect(config.mysql).toBeUndefined();
    expect(config.databasePath).toBe("./data/portfolio-history.sqlite");
  });

  it("정적 Bearer 모드에서는 OAuth 자격증명 없이 호환 API를 설정한다", () => {
    delete process.env.CLIENT_ID;
    delete process.env.CLIENT_SECRET;
    Object.assign(process.env, {
      TOSS_API_AUTH_MODE: "static_bearer",
      TOSS_API_BEARER_TOKEN: "local-read-only-token",
      TOSS_API_BASE_URL: "https://tpl.uaysk.com/",
    });

    expect(loadConfig()).toMatchObject({
      tossApiAuthMode: "static_bearer",
      tossApiBearerToken: "local-read-only-token",
      tossApiBaseUrl: "https://tpl.uaysk.com",
    });
  });

  it("인증 모드별 필수값과 허용값을 검증한다", () => {
    delete process.env.CLIENT_ID;
    expect(() => loadConfig()).toThrow("필수 환경 변수 CLIENT_ID");

    process.env.TOSS_API_AUTH_MODE = "static_bearer";
    delete process.env.CLIENT_SECRET;
    expect(() => loadConfig()).toThrow("필수 환경 변수 TOSS_API_BEARER_TOKEN");

    process.env.TOSS_API_AUTH_MODE = "unsupported";
    expect(() => loadConfig()).toThrow("TOSS_API_AUTH_MODE는 oauth_client_credentials 또는 static_bearer");
  });

  it("DASHBOARD_PASSWORD는 비어 있지 않으면 길이와 관계없이 허용한다", () => {
    process.env.DASHBOARD_PASSWORD = "short";
    expect(loadConfig().dashboardPassword).toBe("short");

    process.env.DASHBOARD_PASSWORD = "   ";
    expect(() => loadConfig()).toThrow("필수 환경 변수 DASHBOARD_PASSWORD");
  });

  it("개별 MySQL 값을 모두 설정하면 연결 구성을 만든다", () => {
    writeFileSync(mysqlCaPath, "-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----\n");
    Object.assign(process.env, {
      DB_PROVIDER: "mysql",
      MYSQL_HOST: "mysql.internal",
      MYSQL_PORT: "3307",
      MYSQL_USER: "portfolio",
      MYSQL_PASSWORD: "database-password",
      MYSQL_DATABASE: "portfolio_lens",
      MYSQL_CONNECT_TIMEOUT_MS: "2500",
      MYSQL_SSL: "true",
      MYSQL_SSL_CA_PATH: mysqlCaPath,
      MYSQL_SSL_REJECT_UNAUTHORIZED: "false",
    });

    expect(loadConfig().mysql).toEqual({
      host: "mysql.internal",
      port: 3307,
      user: "portfolio",
      password: "database-password",
      database: "portfolio_lens",
      connectTimeoutMs: 2500,
      ssl: {
        rejectUnauthorized: false,
        ca: "-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----\n",
      },
    });
    expect(loadConfig().dbProvider).toBe("mysql");
  });

  it("DB_PROVIDER=mysql에서 MYSQL_URL을 지원하고 일부 설정은 거부한다", () => {
    process.env.DB_PROVIDER = "mysql";
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
    expect(() => loadConfig()).toThrow("MYSQL_HOST, MYSQL_USER, MYSQL_PASSWORD, MYSQL_DATABASE가 모두 필요합니다");
  });

  it("선택한 DB의 연결 설정이 없으면 시작하지 않는다", () => {
    process.env.DB_PROVIDER = "mysql";
    expect(() => loadConfig()).toThrow("DB_PROVIDER=mysql이면 유효한 MySQL 연결 설정");

    process.env.DB_PROVIDER = "postgresql";
    expect(() => loadConfig()).toThrow("DB_PROVIDER=postgresql이면 유효한 PostgreSQL 연결 설정");
  });

  it("개별 PostgreSQL 값과 TLS CA를 연결 구성으로 만든다", () => {
    writeFileSync(postgresCaPath, "-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----\n");
    Object.assign(process.env, {
      DB_PROVIDER: "postgresql",
      POSTGRES_HOST: "postgres.internal",
      POSTGRES_PORT: "5433",
      POSTGRES_USER: "portfolio",
      POSTGRES_PASSWORD: "database-password",
      POSTGRES_DATABASE: "portfolio_lens",
      POSTGRES_CONNECT_TIMEOUT_MS: "2500",
      POSTGRES_SSL: "true",
      POSTGRES_SSL_CA_PATH: postgresCaPath,
      POSTGRES_SSL_REJECT_UNAUTHORIZED: "false",
    });

    expect(loadConfig().postgres).toEqual({
      host: "postgres.internal",
      port: 5433,
      user: "portfolio",
      password: "database-password",
      database: "portfolio_lens",
      connectTimeoutMs: 2500,
      ssl: {
        rejectUnauthorized: false,
        ca: "-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----\n",
      },
    });
    expect(loadConfig().dbProvider).toBe("postgresql");
  });

  it("DB_PROVIDER=postgresql에서 POSTGRES_URL을 지원하고 일부 설정은 거부한다", () => {
    process.env.DB_PROVIDER = "postgresql";
    process.env.POSTGRES_URL = "postgresql://portfolio:p%40ss@postgres.internal:5432/portfolio_lens";
    expect(loadConfig().postgres).toMatchObject({
      host: "postgres.internal",
      port: 5432,
      user: "portfolio",
      password: "p@ss",
      database: "portfolio_lens",
    });

    delete process.env.POSTGRES_URL;
    process.env.POSTGRES_HOST = "postgres.internal";
    expect(() => loadConfig()).toThrow("POSTGRES_HOST, POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DATABASE가 모두 필요합니다");
  });

  it("지원하지 않는 DB_PROVIDER 값을 거부한다", () => {
    process.env.DB_PROVIDER = "postgres";
    expect(() => loadConfig()).toThrow("DB_PROVIDER는 sqlite, mysql, postgresql 중 하나");
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

  it("Stockholm Bedrock Kimi K2.5 보고서 설정을 선택한다", () => {
    Object.assign(process.env, {
      REPORT_AI_PROVIDER: "bedrock",
      BEDROCK_REGION: "eu-north-1",
      BEDROCK_MODEL_ID: "moonshotai.kimi-k2.5",
      BEDROCK_TIMEOUT_MS: "90000",
    });
    const config = loadConfig();
    expect(config.bedrock).toEqual({
      region: "eu-north-1",
      modelId: "moonshotai.kimi-k2.5",
      timeoutMs: 90_000,
    });
    expect(config.openAi).toBeUndefined();
  });

  it("지원하지 않는 AI 보고서 공급자를 거부한다", () => {
    process.env.REPORT_AI_PROVIDER = "unsupported";
    expect(() => loadConfig()).toThrow("REPORT_AI_PROVIDER는 openai 또는 bedrock");
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
