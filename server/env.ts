import { readFileSync } from "node:fs";
import type { MySqlConnectionConfig, PostgresConnectionConfig } from "./database.js";
import type { KisExchangeRateConfig } from "./kis-exchange-rate.js";

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
export type ComputeExecutionMode = "inline" | "rust_socket" | "external";

export type ComputeConfig = {
  executionMode: ComputeExecutionMode;
  resultPollMs: number;
  resultDeadlineMs: number;
  rustSocketPath: string;
  rustSocketPoolSize: number;
  rustSocketTimeoutMs: number;
};

export type McpAuthMode = "oauth" | "none";

export type McpOAuthConfig = {
  issuer: string;
  clientId: string;
  clientName: string;
  clientSecret: string;
  redirectUri: string;
  signingPrivateKeyPem: string;
  autoApprove: boolean;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  authorizationCodeTtlSeconds: number;
  loginSessionTtlSeconds: number;
};

export type McpConfig = {
  enabled: boolean;
  authMode: McpAuthMode;
  resourceUrl?: string;
  oauth?: McpOAuthConfig;
  allowedOrigins: string[];
  maxRequestsPerMinute: number;
  maxConcurrentRuns: number;
  maxRunsPerSubject: number;
  maxQueuedRuns: number;
  runDeadlineMs: number;
  maxAssets: number;
  maxCandidateBudget: number;
  maxDateRangeYears: number;
  inlineResultMaxRows: number;
  inlineResultMaxBytes: number;
  auditRetentionDays: number;
};

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
  compute: ComputeConfig;
  mcp: McpConfig;
  kisExchangeRate?: KisExchangeRateConfig;
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

function isLoopbackHost(host: string): boolean {
  return ["127.0.0.1", "::1", "localhost"].includes(host.toLowerCase());
}

function readSecretFile(name: string, fallbackPath: string): string {
  const filePath = optional(name) || fallbackPath;
  let value: string;
  try {
    value = readFileSync(filePath, "utf8").trimEnd();
  } catch {
    throw new Error(`${name} 파일을 읽을 수 없습니다.`);
  }
  if (!value) throw new Error(`${name} 파일이 비어 있습니다.`);
  return value;
}

function readMcpConfig({
  host,
  nodeEnv,
  publicAppUrl,
}: {
  host: string;
  nodeEnv: string;
  publicAppUrl: string;
}): McpConfig {
  const enabled = readBoolean("MCP_ENABLED", false);
  const authModeText = optional("MCP_AUTH_MODE")?.toLowerCase() || "oauth";
  if (authModeText !== "oauth" && authModeText !== "none") {
    throw new Error("MCP_AUTH_MODE는 oauth 또는 none이어야 합니다.");
  }
  const authMode = authModeText as McpAuthMode;
  const rawOrigins = optional("MCP_ALLOWED_ORIGINS")
    ?.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean) ?? [];
  const allowedOrigins = rawOrigins.map((origin) => new URL(normalizedHttpUrl(origin, "MCP_ALLOWED_ORIGINS")).origin);
  const limits = {
    allowedOrigins,
    maxRequestsPerMinute: readBoundedInteger("MCP_MAX_REQUESTS_PER_MINUTE", 60, 1, 10_000),
    maxConcurrentRuns: readBoundedInteger("MCP_MAX_CONCURRENT_RUNS", 1, 1, 32),
    maxRunsPerSubject: readBoundedInteger("MCP_MAX_RUNS_PER_SUBJECT", 2, 1, 32),
    maxAssets: readBoundedInteger("MCP_MAX_ASSETS", 20, 1, 20),
    maxCandidateBudget: readBoundedInteger("MCP_MAX_CANDIDATE_BUDGET", 2_000, 1, 100_000),
    maxQueuedRuns: readBoundedInteger("MCP_MAX_QUEUED_RUNS", 4, 1, 1_000),
    runDeadlineMs: readBoundedInteger("MCP_RUN_DEADLINE_MS", 120_000, 1_000, 3_600_000),
    maxDateRangeYears: readBoundedInteger("MCP_MAX_DATE_RANGE_YEARS", 20, 1, 50),
    inlineResultMaxRows: readBoundedInteger("MCP_INLINE_RESULT_MAX_ROWS", 1_000, 10, 100_000),
    inlineResultMaxBytes: readBoundedInteger("MCP_INLINE_RESULT_MAX_BYTES", 204_800, 1_024, 10_485_760),
    auditRetentionDays: readBoundedInteger("MCP_AUDIT_RETENTION_DAYS", 90, 1, 3_650),
  };
  if (!enabled) return { enabled: false, authMode, ...limits };

  const resourceUrl = normalizedHttpUrl(
    optional("MCP_RESOURCE_URL") || `${publicAppUrl}/mcp`,
    "MCP_RESOURCE_URL",
  );
  if (new URL(resourceUrl).pathname.replace(/\/+$/, "") !== "/mcp") {
    throw new Error("MCP_RESOURCE_URL은 canonical /mcp endpoint여야 합니다.");
  }

  if (authMode === "none") {
    if (nodeEnv === "production" || !isLoopbackHost(host)) {
      throw new Error("MCP_AUTH_MODE=none은 production이 아닌 loopback 바인딩에서만 사용할 수 있습니다.");
    }
    return { enabled: true, authMode, resourceUrl, ...limits };
  }

  const issuer = normalizedHttpUrl(required("MCP_OAUTH_ISSUER"), "MCP_OAUTH_ISSUER");
  const redirectUri = normalizedHttpUrl(required("MCP_OAUTH_REDIRECT_URI"), "MCP_OAUTH_REDIRECT_URI");
  if (new URL(issuer).pathname !== "/") {
    throw new Error("MCP_OAUTH_ISSUER는 path가 없는 authorization server origin이어야 합니다.");
  }
  if (nodeEnv === "production") {
    if (new URL(resourceUrl).protocol !== "https:" || new URL(issuer).protocol !== "https:") {
      throw new Error("production MCP OAuth의 resource URL과 issuer는 HTTPS여야 합니다.");
    }
    const redirect = new URL(redirectUri);
    if (redirect.protocol !== "https:" && !isLoopbackHost(redirect.hostname)) {
      throw new Error("production MCP OAuth redirect URI는 비-loopback 주소에서 HTTPS여야 합니다.");
    }
  }
  const clientId = required("MCP_OAUTH_CLIENT_ID");
  if (!/^[A-Za-z0-9._~-]{3,128}$/.test(clientId)) {
    throw new Error("MCP_OAUTH_CLIENT_ID 형식이 올바르지 않습니다.");
  }
  const autoApprove = readBoolean("MCP_OAUTH_AUTO_APPROVE", false);
  if (autoApprove && nodeEnv !== "test") {
    throw new Error("MCP_OAUTH_AUTO_APPROVE는 test 환경에서만 사용할 수 있습니다.");
  }
  return {
    enabled: true,
    authMode,
    resourceUrl,
    oauth: {
      issuer,
      clientId,
      clientName: optional("MCP_OAUTH_CLIENT_NAME") || "Toss Portfolio Lens ChatGPT",
      clientSecret: readSecretFile(
        "MCP_OAUTH_CLIENT_SECRET_FILE",
        "/run/secrets/mcp-oauth-client-secret",
      ),
      signingPrivateKeyPem: readSecretFile(
        "MCP_OAUTH_SIGNING_KEY_FILE",
        "/run/secrets/mcp-oauth-signing-key",
      ),
      redirectUri,
      autoApprove,
      accessTokenTtlSeconds: readBoundedInteger("MCP_ACCESS_TOKEN_TTL_SECONDS", 3_600, 60, 86_400),
      refreshTokenTtlSeconds: readBoundedInteger(
        "MCP_REFRESH_TOKEN_TTL_SECONDS",
        2_592_000,
        3_600,
        31_536_000,
      ),
      authorizationCodeTtlSeconds: readBoundedInteger("MCP_AUTH_CODE_TTL_SECONDS", 300, 60, 900),
      loginSessionTtlSeconds: readBoundedInteger("MCP_OAUTH_SESSION_TTL_SECONDS", 900, 60, 3_600),
    },
    ...limits,
  };
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

function readComputeConfig(dbProvider: DatabaseProvider): ComputeConfig {
  const mode = optional("EXECUTION_MODE")?.toLowerCase() || "rust_socket";
  if (mode !== "inline" && mode !== "rust_socket" && mode !== "external") {
    throw new Error("EXECUTION_MODE는 inline, rust_socket 또는 external이어야 합니다.");
  }
  if (mode === "external" && dbProvider !== "postgresql") {
    throw new Error("EXECUTION_MODE=external은 DB_PROVIDER=postgresql에서만 사용할 수 있습니다.");
  }
  return {
    executionMode: mode,
    resultPollMs: optional("RUST_WORKER_RESULT_POLL_MS")
      ? readBoundedInteger("RUST_WORKER_RESULT_POLL_MS", 250, 25, 10_000)
      : readBoundedInteger("PYTHON_WORKER_RESULT_POLL_MS", 250, 25, 10_000),
    resultDeadlineMs: optional("RUST_WORKER_RESULT_DEADLINE_MS")
      ? readBoundedInteger("RUST_WORKER_RESULT_DEADLINE_MS", 300_000, 1_000, 3_600_000)
      : readBoundedInteger("PYTHON_WORKER_RESULT_DEADLINE_MS", 300_000, 1_000, 3_600_000),
    rustSocketPath: optional("RUST_COMPUTE_SOCKET") || "/tmp/toss-portfolio-lens-compute.sock",
    rustSocketPoolSize: readBoundedInteger("RUST_COMPUTE_POOL_SIZE", 2, 1, 32),
    rustSocketTimeoutMs: readBoundedInteger("RUST_COMPUTE_TIMEOUT_MS", 300_000, 1_000, 3_600_000),
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

function readKisExchangeRateConfig(): KisExchangeRateConfig | undefined {
  const appKey = optional("KI_APP_KEY");
  const appSecret = optional("KI_APP_SECRET");
  if (!appKey && !appSecret) return undefined;
  if (!appKey || !appSecret) {
    throw new Error("KI_APP_KEY와 KI_APP_SECRET은 함께 설정해야 합니다.");
  }
  const environment = (optional("KI_API_ENV") || "demo").toLowerCase();
  if (environment !== "demo" && environment !== "real") {
    throw new Error("KI_API_ENV는 demo 또는 real이어야 합니다.");
  }
  return {
    appKey,
    appSecret,
    environment,
    requestIntervalMs: readBoundedInteger("KI_API_REQUEST_INTERVAL_MS", 600, 100, 10_000),
    timeoutMs: readBoundedInteger("KI_API_TIMEOUT_MS", 15_000, 1_000, 60_000),
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
  const nodeEnv = process.env.NODE_ENV?.trim() || "development";
  const publicAppUrl = configuredPublicUrl
    ? normalizedHttpUrl(configuredPublicUrl, "PUBLIC_APP_URL")
    : `http://localhost:${port}`;
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
    nodeEnv,
    publicAppUrl,
    ...reportAi,
    reportStorage: readReportStorage(),
    compute: readComputeConfig(dbProvider),
    mcp: readMcpConfig({ host, nodeEnv, publicAppUrl }),
    kisExchangeRate: readKisExchangeRateConfig(),
  };
}
