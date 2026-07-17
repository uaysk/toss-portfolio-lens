import { readFileSync } from "node:fs";
import type { MySqlConnectionConfig, PostgresConnectionConfig } from "./database.js";

export type OpenAiConfig = {
  endpoint: string;
  apiKey: string;
  model?: string;
  timeoutMs: number;
};

export type BedrockConfig = {
  region: string;
  modelId: string;
  timeoutMs: number;
};

export type S3ReportStorageConfig = {
  kind: "s3";
  bucket: string;
  region: string;
  prefix: string;
  endpoint?: string;
  forcePathStyle: boolean;
  credentials?: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  };
};

export type ReportStorageConfig = S3ReportStorageConfig | {
  kind: "local";
  directory: string;
};

export type TossApiAuthConfig =
  | {
    tossApiAuthMode: "oauth_client_credentials";
    clientId: string;
    clientSecret: string;
    tossApiBearerToken?: undefined;
  }
  | {
    tossApiAuthMode: "static_bearer";
    clientId?: string;
    clientSecret?: string;
    tossApiBearerToken: string;
  };

export type DatabaseProvider = "sqlite" | "mysql" | "postgresql";

export type AppConfig = TossApiAuthConfig & {
  dashboardPassword: string;
  sessionSecret: string;
  host: string;
  port: number;
  tossApiBaseUrl: string;
  dbProvider: DatabaseProvider;
  databasePath: string;
  postgres?: PostgresConnectionConfig;
  mysql?: MySqlConnectionConfig;
  candleCacheLatestTtlMs: number;
  snapshotRefreshHours: number;
  nodeEnv: string;
  publicAppUrl: string;
  openAi?: OpenAiConfig;
  bedrock?: BedrockConfig;
  reportStorage: ReportStorageConfig;
};

function optional(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function readBoolean(name: string, fallback: boolean): boolean {
  const value = optional(name)?.toLowerCase();
  if (!value) return fallback;
  if (["1", "true", "yes", "on", "required"].includes(value)) return true;
  if (["0", "false", "no", "off", "disabled"].includes(value)) return false;
  console.warn(`[storage] ${name} 값이 올바르지 않아 기본값을 사용합니다.`);
  return fallback;
}

function readMySqlConfig(requiredForProvider = false): MySqlConnectionConfig | undefined {
  const mysqlUrl = optional("MYSQL_URL");
  const individualNames = ["MYSQL_HOST", "MYSQL_PORT", "MYSQL_USER", "MYSQL_PASSWORD", "MYSQL_DATABASE"];
  const hasIndividualValue = individualNames.some((name) => process.env[name] !== undefined);
  if (!mysqlUrl && !hasIndividualValue) {
    if (requiredForProvider) throw new Error("DB_PROVIDER=mysql이면 유효한 MySQL 연결 설정이 필요합니다.");
    return undefined;
  }

  try {
    let host: string | undefined;
    let portText: string | undefined;
    let user: string | undefined;
    let password: string | undefined;
    let database: string | undefined;
    if (mysqlUrl) {
      const parsed = new URL(mysqlUrl);
      if (parsed.protocol !== "mysql:") throw new Error("MYSQL_URL은 mysql:// 형식이어야 합니다.");
      host = parsed.hostname;
      portText = parsed.port || "3306";
      user = decodeURIComponent(parsed.username);
      password = decodeURIComponent(parsed.password);
      database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
    } else {
      host = optional("MYSQL_HOST");
      portText = optional("MYSQL_PORT") || "3306";
      user = optional("MYSQL_USER");
      password = process.env.MYSQL_PASSWORD;
      database = optional("MYSQL_DATABASE");
    }

    if (!host || !user || password === undefined || !database) {
      throw new Error("MYSQL_HOST, MYSQL_USER, MYSQL_PASSWORD, MYSQL_DATABASE가 모두 필요합니다.");
    }
    if (!/^[A-Za-z0-9_$-]{1,64}$/.test(database)) {
      throw new Error("MYSQL_DATABASE 이름은 영문, 숫자, _, $, -만 사용할 수 있습니다.");
    }
    const port = Number.parseInt(portText || "3306", 10);
    if (!Number.isFinite(port) || port < 1 || port > 65535) throw new Error("MYSQL_PORT가 올바르지 않습니다.");
    const connectTimeoutMs = Number.parseInt(optional("MYSQL_CONNECT_TIMEOUT_MS") || "3000", 10);
    if (!Number.isFinite(connectTimeoutMs) || connectTimeoutMs < 500 || connectTimeoutMs > 30_000) {
      throw new Error("MYSQL_CONNECT_TIMEOUT_MS는 500~30000 범위여야 합니다.");
    }
    const useSsl = readBoolean("MYSQL_SSL", false);
    const caPath = optional("MYSQL_SSL_CA_PATH");
    if (caPath && !useSsl) throw new Error("MYSQL_SSL_CA_PATH를 사용하려면 MYSQL_SSL=true가 필요합니다.");
    const ca = caPath ? readFileSync(caPath, "utf8") : undefined;
    if (caPath && !ca?.trim()) throw new Error("MYSQL_SSL_CA_PATH의 인증서가 비어 있습니다.");
    return {
      host,
      port,
      user,
      password,
      database,
      connectTimeoutMs,
      ...(useSsl ? {
        ssl: {
          rejectUnauthorized: readBoolean("MYSQL_SSL_REJECT_UNAUTHORIZED", true),
          ...(ca ? { ca } : {}),
        },
      } : {}),
    };
  } catch (error) {
    if (requiredForProvider) throw error;
    console.warn("[storage] MySQL 설정을 사용할 수 없어 SQLite를 사용합니다:", error instanceof Error ? error.message : error);
    return undefined;
  }
}

function readPostgresConfig(requiredForProvider = false): PostgresConnectionConfig | undefined {
  const postgresUrl = optional("POSTGRES_URL") || optional("DATABASE_URL");
  const individualNames = [
    "POSTGRES_HOST", "POSTGRES_PORT", "POSTGRES_USER", "POSTGRES_PASSWORD", "POSTGRES_DATABASE",
  ];
  const hasIndividualValue = individualNames.some((name) => process.env[name] !== undefined);
  if (!postgresUrl && !hasIndividualValue) {
    if (requiredForProvider) throw new Error("DB_PROVIDER=postgresql이면 유효한 PostgreSQL 연결 설정이 필요합니다.");
    return undefined;
  }

  try {
    let host: string | undefined;
    let portText: string | undefined;
    let user: string | undefined;
    let password: string | undefined;
    let database: string | undefined;
    if (postgresUrl) {
      const parsed = new URL(postgresUrl);
      if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
        throw new Error("POSTGRES_URL/DATABASE_URL은 postgresql:// 형식이어야 합니다.");
      }
      host = parsed.hostname;
      portText = parsed.port || "5432";
      user = decodeURIComponent(parsed.username);
      password = decodeURIComponent(parsed.password);
      database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
    } else {
      host = optional("POSTGRES_HOST");
      portText = optional("POSTGRES_PORT") || "5432";
      user = optional("POSTGRES_USER");
      password = process.env.POSTGRES_PASSWORD;
      database = optional("POSTGRES_DATABASE");
    }

    if (!host || !user || password === undefined || !database) {
      throw new Error("POSTGRES_HOST, POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DATABASE가 모두 필요합니다.");
    }
    if (!/^[A-Za-z0-9_-]{1,63}$/.test(database)) {
      throw new Error("POSTGRES_DATABASE 이름은 영문, 숫자, _, -만 사용할 수 있습니다.");
    }
    const port = Number.parseInt(portText || "5432", 10);
    if (!Number.isFinite(port) || port < 1 || port > 65535) throw new Error("POSTGRES_PORT가 올바르지 않습니다.");
    const connectTimeoutMs = Number.parseInt(optional("POSTGRES_CONNECT_TIMEOUT_MS") || "3000", 10);
    if (!Number.isFinite(connectTimeoutMs) || connectTimeoutMs < 500 || connectTimeoutMs > 30_000) {
      throw new Error("POSTGRES_CONNECT_TIMEOUT_MS는 500~30000 범위여야 합니다.");
    }
    const useSsl = readBoolean("POSTGRES_SSL", false);
    const caPath = optional("POSTGRES_SSL_CA_PATH");
    if (caPath && !useSsl) throw new Error("POSTGRES_SSL_CA_PATH를 사용하려면 POSTGRES_SSL=true가 필요합니다.");
    const ca = caPath ? readFileSync(caPath, "utf8") : undefined;
    if (caPath && !ca?.trim()) throw new Error("POSTGRES_SSL_CA_PATH의 인증서가 비어 있습니다.");
    return {
      host,
      port,
      user,
      password,
      database,
      connectTimeoutMs,
      ...(useSsl ? {
        ssl: {
          rejectUnauthorized: readBoolean("POSTGRES_SSL_REJECT_UNAUTHORIZED", true),
          ...(ca ? { ca } : {}),
        },
      } : {}),
    };
  } catch (error) {
    if (requiredForProvider) throw error;
    console.warn(
      "[storage] PostgreSQL 설정을 사용할 수 없어 다른 저장소를 확인합니다:",
      error instanceof Error ? error.message : error,
    );
    return undefined;
  }
}

function readDatabaseProvider(): DatabaseProvider {
  const provider = optional("DB_PROVIDER")?.toLowerCase() || "sqlite";
  if (provider !== "sqlite" && provider !== "mysql" && provider !== "postgresql") {
    throw new Error("DB_PROVIDER는 sqlite, mysql, postgresql 중 하나여야 합니다.");
  }
  return provider;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error("필수 환경 변수 " + name + "가 설정되지 않았습니다.");
  }
  return value;
}

function readTossApiAuth(): TossApiAuthConfig {
  const mode = optional("TOSS_API_AUTH_MODE")?.toLowerCase() || "oauth_client_credentials";
  if (mode === "static_bearer") {
    const clientId = optional("CLIENT_ID");
    const clientSecret = optional("CLIENT_SECRET");
    return {
      tossApiAuthMode: "static_bearer",
      tossApiBearerToken: required("TOSS_API_BEARER_TOKEN"),
      ...(clientId ? { clientId } : {}),
      ...(clientSecret ? { clientSecret } : {}),
    };
  }
  if (mode !== "oauth_client_credentials") {
    throw new Error("TOSS_API_AUTH_MODE는 oauth_client_credentials 또는 static_bearer여야 합니다.");
  }
  return {
    tossApiAuthMode: "oauth_client_credentials",
    clientId: required("CLIENT_ID"),
    clientSecret: required("CLIENT_SECRET"),
  };
}

function readPort(): number {
  const value = Number.parseInt(process.env.PORT ?? "3200", 10);
  if (!Number.isFinite(value) || value < 1 || value > 65535) {
    throw new Error("PORT는 1~65535 범위의 숫자여야 합니다.");
  }
  return value;
}

function readSnapshotRefreshHours(): number {
  const value = Number.parseInt(process.env.SNAPSHOT_REFRESH_HOURS ?? "6", 10);
  if (!Number.isFinite(value) || value < 1 || value > 24) {
    throw new Error("SNAPSHOT_REFRESH_HOURS는 1~24 범위의 숫자여야 합니다.");
  }
  return value;
}

function readBoundedInteger(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = Number.parseInt(process.env[name] ?? String(fallback), 10);
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${name}는 ${minimum}~${maximum} 범위의 숫자여야 합니다.`);
  }
  return value;
}

function normalizedHttpUrl(value: string, name: string): string {
  const withProtocol = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  const parsed = new URL(withProtocol);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${name}은 올바른 HTTP(S) 주소여야 합니다.`);
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  return parsed.toString().replace(/\/$/, "");
}

function readOpenAiConfig(): OpenAiConfig | undefined {
  const endpoint = optional("OPENAI_API_ENDPOINT");
  const apiKey = optional("OPENAI_API_KEY");
  if (!endpoint && !apiKey) return undefined;
  if (!endpoint || !apiKey) {
    console.warn("[reports] OPENAI_API_ENDPOINT와 OPENAI_API_KEY를 모두 설정해야 AI 보고서를 생성할 수 있습니다.");
    return undefined;
  }
  return {
    endpoint: normalizedHttpUrl(endpoint, "OPENAI_API_ENDPOINT"),
    apiKey,
    model: optional("OPENAI_MODEL"),
    timeoutMs: readBoundedInteger("OPENAI_TIMEOUT_MS", 60_000, 5_000, 180_000),
  };
}

function readReportAiConfig(): Pick<AppConfig, "openAi" | "bedrock"> {
  const provider = optional("REPORT_AI_PROVIDER")?.toLowerCase();
  if (provider && provider !== "openai" && provider !== "bedrock") {
    throw new Error("REPORT_AI_PROVIDER는 openai 또는 bedrock이어야 합니다.");
  }
  if (provider === "bedrock") {
    return {
      bedrock: {
        region: optional("BEDROCK_REGION") || "eu-north-1",
        modelId: optional("BEDROCK_MODEL_ID") || "moonshotai.kimi-k2.5",
        timeoutMs: readBoundedInteger("BEDROCK_TIMEOUT_MS", 120_000, 5_000, 180_000),
      },
    };
  }
  return { openAi: readOpenAiConfig() };
}

function readReportStorage(): ReportStorageConfig {
  const bucket = optional("S3_BUCKET");
  if (!bucket) {
    return { kind: "local", directory: optional("REPORTS_PATH") || "./data/reports" };
  }
  const accessKeyId = optional("S3_ACCESS_KEY_ID") || optional("AWS_ACCESS_KEY_ID");
  const secretAccessKey = optional("S3_SECRET_ACCESS_KEY") || optional("AWS_SECRET_ACCESS_KEY");
  const sessionToken = optional("S3_SESSION_TOKEN") || optional("AWS_SESSION_TOKEN");
  if (Boolean(accessKeyId) !== Boolean(secretAccessKey)) {
    throw new Error("S3 액세스 키와 시크릿 키는 함께 설정해야 합니다.");
  }
  const endpoint = optional("S3_ENDPOINT");
  return {
    kind: "s3",
    bucket,
    region: optional("S3_REGION") || optional("AWS_REGION") || "us-east-1",
    prefix: (optional("S3_PREFIX") || "portfolio-reports").replace(/^\/+|\/+$/g, "") || "portfolio-reports",
    ...(endpoint ? { endpoint: normalizedHttpUrl(endpoint, "S3_ENDPOINT") } : {}),
    forcePathStyle: readBoolean("S3_FORCE_PATH_STYLE", Boolean(endpoint)),
    ...(accessKeyId && secretAccessKey ? {
      credentials: { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) },
    } : {}),
  };
}

export function loadConfig(): AppConfig {
  const dashboardPassword = required("DASHBOARD_PASSWORD");
  const sessionSecret = required("SESSION_SECRET");
  const tossApiAuth = readTossApiAuth();

  if (sessionSecret.length < 32) {
    throw new Error("SESSION_SECRET은 32자 이상이어야 합니다.");
  }

  const host = process.env.HOST?.trim() || "0.0.0.0";
  const port = readPort();
  const configuredPublicUrl = optional("PUBLIC_APP_URL") || optional("APP_URL");
  const reportAi = readReportAiConfig();
  const dbProvider = readDatabaseProvider();
  const postgres = dbProvider === "postgresql" ? readPostgresConfig(true) : undefined;
  const mysql = dbProvider === "mysql" ? readMySqlConfig(true) : undefined;
  return {
    ...tossApiAuth,
    dashboardPassword,
    sessionSecret,
    host,
    port,
    tossApiBaseUrl: normalizedHttpUrl(
      optional("TOSS_API_BASE_URL") || "https://openapi.tossinvest.com",
      "TOSS_API_BASE_URL",
    ),
    dbProvider,
    databasePath: process.env.DATABASE_PATH?.trim() || "./data/portfolio-history.sqlite",
    postgres,
    mysql,
    candleCacheLatestTtlMs: readBoundedInteger("CANDLE_CACHE_LATEST_TTL_MS", 300_000, 10_000, 86_400_000),
    snapshotRefreshHours: readSnapshotRefreshHours(),
    nodeEnv: process.env.NODE_ENV?.trim() || "development",
    publicAppUrl: configuredPublicUrl
      ? normalizedHttpUrl(configuredPublicUrl, "PUBLIC_APP_URL")
      : `http://localhost:${port}`,
    ...reportAi,
    reportStorage: readReportStorage(),
  };
}
