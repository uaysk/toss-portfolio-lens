import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import type { MySqlConnectionConfig, PostgresConnectionConfig } from "./database.js";
import type { KisExchangeRateConfig } from "./kis-exchange-rate.js";
import type { IntradayBarAggregatorConfig } from "./scalping/intraday-bar-aggregator.js";
import type { KisRestClientConfig } from "./scalping/kis-rest-client.js";
import type { KisWebSocketConfig } from "./scalping/kis-websocket-client.js";
import type { ScannerConfig } from "./scalping/scanner-service.js";
import type { ScalpingServiceConfig } from "./scalping/scalping-service.js";
import {
  DEFAULT_US_EXTENDED_SESSION_WINDOWS,
  krIntegratedSessionWindows,
} from "./scalping/market-session.js";
import type { TossProviderConfig } from "./scalping/toss-provider.js";

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
export type ReadOnlyApiTokenSource = "READ_ONLY_API_TOKEN" | "DASHBOARD_PASSWORD";

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

export type ScalpingAiConfig = {
  url: string;
  authTokenFile: string;
  timeoutMs: number;
  connectTimeoutMs: number;
  reconnectBaseMs: number;
  reconnectMaxMs: number;
  maximumInFlight: number;
  maximumBatchSize: number;
  maximumRequestBytes: number;
  maximumResponseBytes: number;
  tlsCa?: string;
};

export type AiTradingSimulationConfig = {
  maximumDurationMinutes: number;
  maximumActiveSessions: number;
  selectionMaximumAttempts: number;
  selectionRetryDelayMs: number;
};

export type ScalpingConfig = {
  enabled: false;
  minimumTopCount: number;
  maximumTopCount: number;
  ai: ScalpingAiConfig;
  simulation: AiTradingSimulationConfig;
} | {
  enabled: true;
  minimumTopCount: number;
  maximumTopCount: number;
  toss: Omit<TossProviderConfig, "now">;
  kisRest: KisRestClientConfig;
  kisWebSocket: KisWebSocketConfig;
  scanner: Omit<ScannerConfig, "now">;
  service: Omit<ScalpingServiceConfig, "now">;
  aggregator: IntradayBarAggregatorConfig;
  ai: ScalpingAiConfig;
  simulation: AiTradingSimulationConfig;
  sseHeartbeatMs: number;
  realtimeAnalysisDebounceMs: number;
  sseReplayEvents: number;
  barWatermarkAdvanceMs: number;
  recoveryMaximumRequests: number;
  recoveryBarLimit: number;
};

export type AppConfig = TossApiAuthConfig & {
  dashboardPassword: string;
  readOnlyApiToken: string;
  readOnlyApiTokenSource: ReadOnlyApiTokenSource;
  sessionSecret: string;
  host: string;
  port: number;
  trustProxy: string[];
  gracefulShutdownTimeoutMs: number;
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
  scalping: ScalpingConfig;
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

function validProxyAddress(value: string): boolean {
  const [address, prefix, extra] = value.split("/");
  if (!address || extra !== undefined) return false;
  const normalized = address.replace(/^\[|\]$/g, "");
  const version = isIP(normalized);
  if (!version) return false;
  if (prefix === undefined) return true;
  if (!/^\d+$/.test(prefix)) return false;
  const bits = Number(prefix);
  return Number.isInteger(bits) && bits >= 0 && bits <= (version === 4 ? 32 : 128);
}

function readTrustProxy(): string[] {
  const value = optional("TRUST_PROXY");
  if (!value) return [];
  const proxies = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (!proxies.length || proxies.some((entry) => !validProxyAddress(entry))) {
    throw new Error("TRUST_PROXY는 쉼표로 구분한 IP 또는 CIDR 목록이어야 합니다.");
  }
  return proxies.map((entry) => {
    const [address, prefix] = entry.split("/");
    const normalized = address!.replace(/^\[|\]$/g, "");
    return prefix === undefined ? normalized : `${normalized}/${prefix}`;
  });
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
  return ["127.0.0.1", "::1", "[::1]", "localhost"].includes(host.toLowerCase());
}

function isPrivateIpLiteral(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (isIP(normalized) === 4) {
    const octets = normalized.split(".").map(Number);
    return octets[0] === 10
      || (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31)
      || (octets[0] === 192 && octets[1] === 168);
  }
  return isIP(normalized) === 6 && (normalized.startsWith("fc") || normalized.startsWith("fd"));
}

function readAiComputeUrl(allowInsecurePrivate: boolean): string {
  const value = optional("AI_COMPUTE_URL") || "ws://ai-worker:8765/ws/scalping-ai/v1";
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("AI_COMPUTE_URL은 유효한 WebSocket URL이어야 합니다.");
  }
  if (!["ws:", "wss:"].includes(parsed.protocol)
    || parsed.pathname !== "/ws/scalping-ai/v1"
    || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("AI_COMPUTE_URL은 /ws/scalping-ai/v1 경로의 ws:// 또는 wss:// URL이어야 합니다.");
  }
  if (parsed.protocol === "ws:") {
    const localCompose = parsed.hostname.toLowerCase() === "ai-worker";
    const local = localCompose || isLoopbackHost(parsed.hostname);
    const explicitlyAllowedPrivate = allowInsecurePrivate && isPrivateIpLiteral(parsed.hostname);
    if (!local && !explicitlyAllowedPrivate) {
      throw new Error(
        "원격 AI_COMPUTE_URL은 wss://를 사용해야 하며, private IP의 ws://는 "
        + "AI_COMPUTE_ALLOW_INSECURE_PRIVATE_WS=true일 때만 허용됩니다.",
      );
    }
  }
  return parsed.toString();
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

function readAiTlsCa(): string | undefined {
  const path = optional("AI_COMPUTE_TLS_CA_FILE");
  if (!path) return undefined;
  let value: string;
  try {
    value = readFileSync(path, "utf8");
  } catch {
    throw new Error("AI_COMPUTE_TLS_CA_FILE을 읽을 수 없습니다.");
  }
  if (!value.trim()) throw new Error("AI_COMPUTE_TLS_CA_FILE이 비어 있습니다.");
  if (Buffer.byteLength(value, "utf8") > 1024 * 1024) throw new Error("AI_COMPUTE_TLS_CA_FILE은 1MiB 이하여야 합니다.");
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

function readScalpingConfig(): ScalpingConfig {
  const enabled = readBoolean("SCALPING_ENABLED", false);
  const minimumTopCount = readBoundedInteger("SCALPING_TOP_COUNT_MIN", 5, 1, 50);
  let maximumTopCount = readBoundedInteger("SCALPING_TOP_COUNT_MAX", 50, minimumTopCount, 50);
  const allowInsecurePrivateWs = readBoolean("AI_COMPUTE_ALLOW_INSECURE_PRIVATE_WS", false);
  const aiUrl = readAiComputeUrl(allowInsecurePrivateWs);
  const authTokenFile = optional("AI_COMPUTE_AUTH_TOKEN_FILE") || "/run/ai-auth/token";
  if (!authTokenFile.startsWith("/")) throw new Error("AI_COMPUTE_AUTH_TOKEN_FILE은 절대 경로여야 합니다.");
  const reconnectBaseMs = readBoundedInteger("AI_COMPUTE_RECONNECT_BASE_MS", 250, 1, 60_000);
  const aiBase: ScalpingAiConfig = {
    url: aiUrl,
    authTokenFile,
    timeoutMs: readBoundedInteger("AI_COMPUTE_TIMEOUT_MS", 120_000, 1_000, 3_600_000),
    connectTimeoutMs: readBoundedInteger("AI_COMPUTE_CONNECT_TIMEOUT_MS", 10_000, 1_000, 60_000),
    reconnectBaseMs,
    reconnectMaxMs: readBoundedInteger("AI_COMPUTE_RECONNECT_MAX_MS", 10_000, reconnectBaseMs, 600_000),
    maximumInFlight: readBoundedInteger("AI_COMPUTE_MAX_IN_FLIGHT", 4, 1, 1_000),
    maximumBatchSize: readBoundedInteger("AI_COMPUTE_MAX_BATCH_SIZE", maximumTopCount, 1, 50),
    maximumRequestBytes: readBoundedInteger("AI_MAX_REQUEST_BYTES", 64 * 1024 * 1024, 1_024, 512 * 1024 * 1024),
    maximumResponseBytes: readBoundedInteger("AI_MAX_RESPONSE_BYTES", 128 * 1024 * 1024, 1_024, 512 * 1024 * 1024),
  };
  const simulation: AiTradingSimulationConfig = {
    maximumDurationMinutes: readBoundedInteger(
      "SCALPING_SIMULATION_MAX_DURATION_MINUTES",
      390,
      1,
      1_440,
    ),
    maximumActiveSessions: readBoundedInteger(
      "SCALPING_SIMULATION_MAX_ACTIVE_SESSIONS",
      2,
      1,
      20,
    ),
    selectionMaximumAttempts: readBoundedInteger(
      "SCALPING_SIMULATION_SELECTION_MAX_ATTEMPTS",
      3,
      1,
      10,
    ),
    selectionRetryDelayMs: readBoundedInteger(
      "SCALPING_SIMULATION_SELECTION_RETRY_DELAY_MS",
      15_000,
      1,
      120_000,
    ),
  };
  if (!enabled) return { enabled: false, minimumTopCount, maximumTopCount, ai: aiBase, simulation };

  const appKey = required("KI_APP_KEY");
  const appSecret = required("KI_APP_SECRET");
  const environment = (optional("KI_API_ENV") || "demo").toLowerCase();
  const restEnvironment = (optional("KI_SCALPING_REST_ENV") || environment).toLowerCase();
  const websocketEnvironment = (optional("KI_SCALPING_WS_ENV") || environment).toLowerCase();
  if (restEnvironment !== "demo" && restEnvironment !== "real") {
    throw new Error("KI_SCALPING_REST_ENV는 demo 또는 real이어야 합니다.");
  }
  if (websocketEnvironment !== "demo" && websocketEnvironment !== "real") {
    throw new Error("KI_SCALPING_WS_ENV는 demo 또는 real이어야 합니다.");
  }
  const tlsCa = readAiTlsCa();
  if (tlsCa && new URL(aiUrl).protocol !== "wss:") {
    throw new Error("AI_COMPUTE_TLS_CA_FILE은 wss:// AI_COMPUTE_URL에서만 사용할 수 있습니다.");
  }
  const ai: ScalpingAiConfig = {
    ...aiBase,
    ...(tlsCa ? { tlsCa } : {}),
  };
  const providerLimit = (name: string, maximum = 1_000_000) => (
    readBoundedInteger(name, Number.NaN, 1, maximum)
  );
  const nonnegative = (name: string, fallback: number, maximum: number) => (
    readBoundedInteger(name, fallback, 0, maximum)
  );
  const ratio = (name: string, fallback: number) => {
    const value = Number(optional(name) ?? fallback);
    if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${name}는 0~1 범위여야 합니다.`);
    return value;
  };
  const weight = (name: string) => {
    const value = Number(required(name));
    if (!Number.isFinite(value) || value < 0 || value > 100) throw new Error(`${name}는 0~100 범위여야 합니다.`);
    return value;
  };
  const rateLimits = Object.fromEntries([
    ["ranking", "TOSS_SCALPING_RANKING_MIN_INTERVAL_MS"],
    ["market_data", "TOSS_SCALPING_MARKET_DATA_MIN_INTERVAL_MS"],
    ["chart", "TOSS_SCALPING_CHART_MIN_INTERVAL_MS"],
    ["stock", "TOSS_SCALPING_STOCK_MIN_INTERVAL_MS"],
    ["market_info", "TOSS_SCALPING_MARKET_INFO_MIN_INTERVAL_MS"],
  ].map(([group, name]) => {
    const minimumIntervalMs = providerLimit(name, 60_000);
    return [group, {
      initialIntervalMs: minimumIntervalMs,
      minimumIntervalMs,
      maximumIntervalMs: readBoundedInteger("TOSS_SCALPING_RATE_MAX_INTERVAL_MS", 60_000, minimumIntervalMs, 600_000),
      maximumHeaderDelayMs: readBoundedInteger("TOSS_SCALPING_MAX_HEADER_DELAY_MS", 120_000, 1_000, 3_600_000),
    }];
  })) as unknown as Omit<TossProviderConfig, "now">["rateLimits"];

  const kisWebSocketMaximumSubscriptions = providerLimit("KI_SCALPING_WS_MAX_SUBSCRIPTIONS", 10_000);
  // US symbols use a standard execution feed, a day-market execution feed,
  // and the documented standard-session top-of-book feed. Use the stricter
  // three-feed capacity for the shared KR/US visible-symbol limit.
  const websocketMaximumTopCount = Math.floor(kisWebSocketMaximumSubscriptions / 3);
  if (websocketMaximumTopCount < minimumTopCount) {
    throw new Error(
      `KI_SCALPING_WS_MAX_SUBSCRIPTIONS는 최소 표시 종목 ${minimumTopCount}개의 미국 표준 체결·데이 체결·1호가 3개 구독을 위해 최소 ${minimumTopCount * 3}여야 합니다.`,
    );
  }
  maximumTopCount = Math.min(maximumTopCount, websocketMaximumTopCount);
  if (ai.maximumBatchSize < maximumTopCount) {
    throw new Error("AI_COMPUTE_MAX_BATCH_SIZE는 실제 적용되는 최대 표시 종목 수 이상이어야 합니다.");
  }

  const minimumTradingAmount = providerLimit("SCALPING_MINIMUM_TRADING_AMOUNT", Number.MAX_SAFE_INTEGER);
  const scanner: Omit<ScannerConfig, "now"> = {
    minimumTopCount,
    maximumTopCount,
    minimumVolume: providerLimit("SCALPING_MINIMUM_VOLUME", Number.MAX_SAFE_INTEGER),
    minimumTradingAmount,
    usMinimumTradingAmount: providerLimit("SCALPING_US_MINIMUM_TRADING_AMOUNT", minimumTradingAmount),
    maximumSpreadBps: providerLimit("SCALPING_MAXIMUM_SPREAD_BPS", 5_000),
    filterLowLiquidity: readBoolean("SCALPING_FILTER_LOW_LIQUIDITY", true),
    filterWideSpread: readBoolean("SCALPING_FILTER_WIDE_SPREAD", true),
    blockingWarningCodes: (optional("SCALPING_BLOCKING_WARNING_CODES") || "")
      .split(",").map((value) => value.trim()).filter(Boolean),
    cautionWarningCodes: (optional("SCALPING_CAUTION_WARNING_CODES") || "")
      .split(",").map((value) => value.trim()).filter(Boolean),
    minimumVolatilityComponents: readBoundedInteger("SCALPING_MIN_VOLATILITY_COMPONENTS", 4, 1, 7),
    volatilityWeights: {
      realizedVolatility: weight("SCALPING_WEIGHT_REALIZED_VOLATILITY"),
      normalizedAtr: weight("SCALPING_WEIGHT_NORMALIZED_ATR"),
      dayRangeRatio: weight("SCALPING_WEIGHT_DAY_RANGE"),
      bollingerWidthExpansion: weight("SCALPING_WEIGHT_BOLLINGER_EXPANSION"),
      relativeVolume: weight("SCALPING_WEIGHT_RELATIVE_VOLUME"),
      tradingAmount: weight("SCALPING_WEIGHT_TRADING_AMOUNT"),
      spreadBps: weight("SCALPING_WEIGHT_SPREAD"),
    },
    providerPrecedence: ["toss", "kis"],
    staleAfterMs: readBoundedInteger("SCALPING_STALE_AFTER_MS", 120_000, 1_000, 3_600_000),
  };

  const retryMaxAttempts = readBoundedInteger("TOSS_SCALPING_RETRY_MAX_ATTEMPTS", 3, 1, 10);
  const rankingMaximumCount = providerLimit("TOSS_SCALPING_RANKING_MAX_COUNT", 100);
  const pricesBatchSize = providerLimit("TOSS_SCALPING_PRICE_BATCH_SIZE", 10_000);
  const candlesMaximumCount = providerLimit("TOSS_SCALPING_CANDLE_MAX_COUNT", 200);
  const tradesMaximumCount = providerLimit("TOSS_SCALPING_TRADE_MAX_COUNT", 50);
  const workspaceBarLimit = readBoundedInteger(
    "SCALPING_WORKSPACE_BAR_LIMIT",
    4_900,
    60,
    50_000,
  );
  const usWorkspaceBarLimit = readBoundedInteger(
    "SCALPING_US_WORKSPACE_BAR_LIMIT",
    8_640,
    60,
    50_000,
  );
  const workspaceChartBarLimit = readBoundedInteger(
    "SCALPING_CHART_BAR_LIMIT",
    1_000,
    60,
    Math.max(workspaceBarLimit, usWorkspaceBarLimit),
  );
  const minimumAnalysisBars = readBoundedInteger(
    "SCALPING_MINIMUM_ANALYSIS_BARS",
    60,
    1,
    workspaceBarLimit,
  );
  const forecastMinimumBars = readBoundedInteger("AI_MIN_CONTEXT_BARS", 64, 8, Math.min(512, workspaceBarLimit));
  const forecastMaximumBars = readBoundedInteger(
    "AI_MAX_CONTEXT_BARS",
    Math.min(512, workspaceBarLimit),
    forecastMinimumBars,
    Math.min(512, workspaceBarLimit),
  );
  const clockMinute = (name: string, fallback: string) => {
    const value = optional(name) || fallback;
    const match = value.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
    if (!match) throw new Error(`${name}은 HH:MM 형식이어야 합니다.`);
    return Number(match[1]) * 60 + Number(match[2]);
  };
  const sessionOpenMinuteKst = clockMinute("SCALPING_SESSION_OPEN_KST", "09:00");
  const sessionCloseMinuteKst = clockMinute("SCALPING_SESSION_CLOSE_KST", "15:30");
  const preMarketOpenMinuteKst = clockMinute("SCALPING_NXT_PRE_MARKET_OPEN_KST", "08:00");
  const preMarketCloseMinuteKst = clockMinute("SCALPING_NXT_PRE_MARKET_CLOSE_KST", "08:50");
  const afterMarketOpenMinuteKst = clockMinute("SCALPING_NXT_AFTER_MARKET_OPEN_KST", "15:40");
  const afterMarketCloseMinuteKst = clockMinute("SCALPING_NXT_AFTER_MARKET_CLOSE_KST", "20:00");
  if (sessionOpenMinuteKst >= sessionCloseMinuteKst) {
    throw new Error("SCALPING_SESSION_OPEN_KST는 SCALPING_SESSION_CLOSE_KST보다 빨라야 합니다.");
  }
  const integratedKrSessionWindows = krIntegratedSessionWindows({
    preMarketOpenMinuteKst,
    preMarketCloseMinuteKst,
    regularMarketOpenMinuteKst: sessionOpenMinuteKst,
    regularMarketCloseMinuteKst: sessionCloseMinuteKst,
    afterMarketOpenMinuteKst,
    afterMarketCloseMinuteKst,
  });
  const relativeVolumeLookbackSessions = readBoundedInteger("SCALPING_RVOL_LOOKBACK_SESSIONS", 5, 1, 60);
  const integratedSessionMinuteSlots = integratedKrSessionWindows.reduce(
    (sum, window) => sum + window.closeMinute - window.openMinute,
    0,
  );
  const requiredRelativeVolumeBars = integratedSessionMinuteSlots * (relativeVolumeLookbackSessions + 1);
  // Higher intervals are restarted at every configured market window, and a
  // short tail is intentionally excluded from Rust/AI input. Retain enough raw
  // one-minute history for the least-dense supported interval to have the
  // configured number of complete bars even at the start of the current day.
  const completeAnalysisBarsPerSession = [1, 5, 15, 30, 60].map((interval) => (
    integratedKrSessionWindows.reduce(
      (sum, window) => sum + Math.floor((window.closeMinute - window.openMinute) / interval),
      0,
    )
  ));
  const minimumCompleteAnalysisBarsPerSession = Math.min(...completeAnalysisBarsPerSession);
  const requiredAnalysisSessions = Math.ceil(minimumAnalysisBars / minimumCompleteAnalysisBarsPerSession);
  const requiredAnalysisWorkspaceBars = integratedSessionMinuteSlots * (requiredAnalysisSessions + 1);
  if (workspaceBarLimit < requiredAnalysisWorkspaceBars) {
    throw new Error(
      `SCALPING_WORKSPACE_BAR_LIMIT는 NXT 통합 세션 60분봉 분석 ${minimumAnalysisBars}개를 장중 보장하기 위해 최소 ${requiredAnalysisWorkspaceBars}여야 합니다.`,
    );
  }
  if (workspaceBarLimit < requiredRelativeVolumeBars) {
    throw new Error(
      `SCALPING_WORKSPACE_BAR_LIMIT는 NXT 통합 세션 RVOL ${relativeVolumeLookbackSessions}개 이전 세션을 위해 최소 ${requiredRelativeVolumeBars}여야 합니다.`,
    );
  }
  const usSessionMinuteSlots = DEFAULT_US_EXTENDED_SESSION_WINDOWS.reduce(
    (sum, window) => sum + window.closeMinute - window.openMinute,
    0,
  );
  const requiredUsRelativeVolumeBars = usSessionMinuteSlots * (relativeVolumeLookbackSessions + 1);
  const usCompleteAnalysisBarsPerSession = [1, 5, 15, 30, 60].map((interval) => (
    DEFAULT_US_EXTENDED_SESSION_WINDOWS.reduce(
      (sum, window) => sum + Math.floor((window.closeMinute - window.openMinute) / interval),
      0,
    )
  ));
  const usMinimumCompleteAnalysisBarsPerSession = Math.min(...usCompleteAnalysisBarsPerSession);
  const requiredUsAnalysisSessions = Math.ceil(minimumAnalysisBars / usMinimumCompleteAnalysisBarsPerSession);
  const requiredUsAnalysisWorkspaceBars = usSessionMinuteSlots * (requiredUsAnalysisSessions + 1);
  if (usWorkspaceBarLimit < requiredUsAnalysisWorkspaceBars) {
    throw new Error(
      `SCALPING_US_WORKSPACE_BAR_LIMIT는 미국 확장 세션 60분봉 분석 ${minimumAnalysisBars}개를 장중 보장하기 위해 최소 ${requiredUsAnalysisWorkspaceBars}여야 합니다.`,
    );
  }
  if (usWorkspaceBarLimit < requiredUsRelativeVolumeBars) {
    throw new Error(
      `SCALPING_US_WORKSPACE_BAR_LIMIT는 미국 확장 세션 RVOL ${relativeVolumeLookbackSessions}개 이전 세션을 위해 최소 ${requiredUsRelativeVolumeBars}여야 합니다.`,
    );
  }
  if (Math.max(workspaceBarLimit, usWorkspaceBarLimit) * maximumTopCount > 500_000) {
    throw new Error("시장별 SCALPING_WORKSPACE_BAR_LIMIT와 실제 최대 표시 종목 수의 곱은 500000 이하여야 합니다.");
  }
  return {
    enabled: true,
    minimumTopCount,
    maximumTopCount,
    toss: {
      rankingMaximumCount,
      pricesBatchSize,
      candlesMaximumCount,
      tradesMaximumCount,
      cacheMaximumEntries: readBoundedInteger("TOSS_SCALPING_CACHE_MAX_ENTRIES", 2_000, 10, 100_000),
      cacheTtlMs: {
        rankings: nonnegative("TOSS_SCALPING_RANKING_CACHE_TTL_MS", 5_000, 3_600_000),
        prices: nonnegative("TOSS_SCALPING_PRICE_CACHE_TTL_MS", 1_000, 3_600_000),
        candles: nonnegative("TOSS_SCALPING_CANDLE_CACHE_TTL_MS", 15_000, 3_600_000),
        orderbook: nonnegative("TOSS_SCALPING_ORDERBOOK_CACHE_TTL_MS", 1_000, 3_600_000),
        trades: nonnegative("TOSS_SCALPING_TRADE_CACHE_TTL_MS", 1_000, 3_600_000),
        warnings: nonnegative("TOSS_SCALPING_WARNING_CACHE_TTL_MS", 300_000, 86_400_000),
        calendar: nonnegative("TOSS_SCALPING_CALENDAR_CACHE_TTL_MS", 3_600_000, 86_400_000),
      },
      retry: {
        maxAttempts: retryMaxAttempts,
        baseDelayMs: nonnegative("TOSS_SCALPING_RETRY_BASE_MS", 250, 60_000),
        maximumDelayMs: readBoundedInteger("TOSS_SCALPING_RETRY_MAX_MS", 5_000, 1, 600_000),
        jitterRatio: ratio("TOSS_SCALPING_RETRY_JITTER_RATIO", 0.2),
      },
      rateLimits,
    },
    kisRest: {
      appKey,
      appSecret,
      environment: restEnvironment,
      requestIntervalMs: providerLimit("KI_SCALPING_REST_REQUEST_INTERVAL_MS", 60_000),
      timeoutMs: readBoundedInteger("KI_SCALPING_REST_TIMEOUT_MS", 15_000, 1_000, 60_000),
      maxAttempts: readBoundedInteger("KI_SCALPING_REST_MAX_ATTEMPTS", 3, 1, 10),
      retryBaseMs: readBoundedInteger("KI_SCALPING_REST_RETRY_BASE_MS", 250, 1, 60_000),
      retryMaxMs: readBoundedInteger("KI_SCALPING_REST_RETRY_MAX_MS", 5_000, 1, 600_000),
    },
    kisWebSocket: {
      appKey,
      appSecret,
      environment: websocketEnvironment,
      ...(optional("KI_SCALPING_WS_URL") ? { url: optional("KI_SCALPING_WS_URL") } : {}),
      approvalTimeoutMs: readBoundedInteger("KI_SCALPING_WS_APPROVAL_TIMEOUT_MS", 15_000, 1_000, 60_000),
      approvalMaxAttempts: readBoundedInteger("KI_SCALPING_WS_APPROVAL_MAX_ATTEMPTS", 3, 1, 10),
      approvalRetryBaseMs: readBoundedInteger("KI_SCALPING_WS_APPROVAL_RETRY_BASE_MS", 250, 1, 60_000),
      approvalRetryMaxMs: readBoundedInteger("KI_SCALPING_WS_APPROVAL_RETRY_MAX_MS", 5_000, 1, 600_000),
      maxSubscriptions: kisWebSocketMaximumSubscriptions,
      subscribeIntervalMs: providerLimit("KI_SCALPING_WS_SUBSCRIBE_INTERVAL_MS", 60_000),
      connectionTimeoutMs: readBoundedInteger("KI_SCALPING_WS_CONNECTION_TIMEOUT_MS", 15_000, 1_000, 60_000),
      reconnectBaseMs: readBoundedInteger("KI_SCALPING_WS_RECONNECT_BASE_MS", 1_000, 1, 60_000),
      reconnectMaxMs: readBoundedInteger("KI_SCALPING_WS_RECONNECT_MAX_MS", 30_000, 1, 600_000),
      reconnectJitterRatio: ratio("KI_SCALPING_WS_RECONNECT_JITTER_RATIO", 0.2),
    },
    scanner,
    service: {
      minimumTopCount,
      maximumTopCount,
      maximumSubscriptions: kisWebSocketMaximumSubscriptions,
      workspaceBarLimit,
      usWorkspaceBarLimit,
      workspaceChartBarLimit,
      candlePageSize: Math.min(candlesMaximumCount, workspaceBarLimit),
      minimumAnalysisBars,
      barRefreshAfterMs: readBoundedInteger("SCALPING_BAR_REFRESH_AFTER_MS", 15_000, 1_000, 3_600_000),
      volumeProfileBucketCount: readBoundedInteger("SCALPING_VOLUME_PROFILE_BUCKETS", 24, 5, 200),
      volumeProfileInstrumentLimit: readBoundedInteger("SCALPING_VOLUME_PROFILE_MAX_INSTRUMENTS", 20, 1, 20),
      relativeVolumeLookbackSessions,
      tradeFetchCount: readBoundedInteger(
        "SCALPING_TRADE_FETCH_COUNT",
        Math.min(50, tradesMaximumCount),
        1,
        tradesMaximumCount,
      ),
      forecastMinimumBars,
      forecastMaximumBars,
      evaluationMaximumOrigins: readBoundedInteger("AI_MAX_EVALUATION_ORIGINS", 10_000, 1, 1_000_000),
      evaluationOriginStrideBars: readBoundedInteger("SCALPING_EVALUATION_ORIGIN_STRIDE_BARS", 5, 1, 10_000),
      preMarketOpenMinuteKst,
      preMarketCloseMinuteKst,
      sessionOpenMinuteKst,
      sessionCloseMinuteKst,
      afterMarketOpenMinuteKst,
      afterMarketCloseMinuteKst,
    },
    aggregator: {
      allowedLatenessMs: nonnegative("SCALPING_BAR_ALLOWED_LATENESS_MS", 2_000, 60_000),
      maximumSeenEventIdsPerSymbol: readBoundedInteger("SCALPING_BAR_MAX_EVENT_IDS", 20_000, 100, 1_000_000),
      maximumOpenMinuteBucketsPerSymbol: readBoundedInteger("SCALPING_BAR_MAX_OPEN_MINUTES", 10, 2, 1_000),
      finalizedBarRetentionPerInterval: readBoundedInteger("SCALPING_BAR_RETENTION", 1_000, 60, 100_000),
      higherIntervalsMinutes: [5, 15, 30, 60],
    },
    ai,
    simulation,
    sseHeartbeatMs: readBoundedInteger("SCALPING_SSE_HEARTBEAT_MS", 15_000, 1_000, 60_000),
    realtimeAnalysisDebounceMs: readBoundedInteger("SCALPING_REALTIME_ANALYSIS_DEBOUNCE_MS", 250, 50, 5_000),
    sseReplayEvents: readBoundedInteger("SCALPING_SSE_REPLAY_EVENTS", 2_000, 100, 100_000),
    barWatermarkAdvanceMs: readBoundedInteger("SCALPING_BAR_WATERMARK_ADVANCE_MS", 1_000, 250, 60_000),
    recoveryMaximumRequests: readBoundedInteger("SCALPING_RECOVERY_MAX_REQUESTS", 30, 1, 1_000),
    recoveryBarLimit: workspaceBarLimit,
  };
}

export function loadScalpingConfig(): ScalpingConfig {
  return readScalpingConfig();
}

export function loadConfig(): AppConfig {
  const dashboardPassword = required("DASHBOARD_PASSWORD");
  const configuredReadOnlyApiToken = optional("READ_ONLY_API_TOKEN");
  if (configuredReadOnlyApiToken && /\s/.test(configuredReadOnlyApiToken)) {
    throw new Error("READ_ONLY_API_TOKEN에는 공백을 사용할 수 없습니다.");
  }
  const readOnlyApiToken = configuredReadOnlyApiToken ?? dashboardPassword;
  const readOnlyApiTokenSource: ReadOnlyApiTokenSource = configuredReadOnlyApiToken
    ? "READ_ONLY_API_TOKEN"
    : "DASHBOARD_PASSWORD";
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
    readOnlyApiToken,
    readOnlyApiTokenSource,
    sessionSecret,
    host,
    port,
    trustProxy: readTrustProxy(),
    gracefulShutdownTimeoutMs: readBoundedInteger(
      "GRACEFUL_SHUTDOWN_TIMEOUT_MS",
      30_000,
      1_000,
      300_000,
    ),
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
    scalping: readScalpingConfig(),
  };
}
