import type { MySqlConnectionConfig } from "./database.js";

export type AppConfig = {
  clientId: string;
  clientSecret: string;
  dashboardPassword: string;
  sessionSecret: string;
  host: string;
  port: number;
  tossApiBaseUrl: string;
  databasePath: string;
  mysql?: MySqlConnectionConfig;
  snapshotRefreshHours: number;
  nodeEnv: string;
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

function readMySqlConfig(): MySqlConnectionConfig | undefined {
  const mysqlUrl = optional("MYSQL_URL");
  const individualNames = ["MYSQL_HOST", "MYSQL_PORT", "MYSQL_USER", "MYSQL_PASSWORD", "MYSQL_DATABASE"];
  const hasIndividualValue = individualNames.some((name) => process.env[name] !== undefined);
  if (!mysqlUrl && !hasIndividualValue) return undefined;

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
    return {
      host,
      port,
      user,
      password,
      database,
      connectTimeoutMs,
      ...(useSsl ? {
        ssl: { rejectUnauthorized: readBoolean("MYSQL_SSL_REJECT_UNAUTHORIZED", true) },
      } : {}),
    };
  } catch (error) {
    console.warn("[storage] MySQL 설정을 사용할 수 없어 SQLite를 사용합니다:", error instanceof Error ? error.message : error);
    return undefined;
  }
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error("필수 환경 변수 " + name + "가 설정되지 않았습니다.");
  }
  return value;
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

export function loadConfig(): AppConfig {
  const dashboardPassword = required("DASHBOARD_PASSWORD");
  const sessionSecret = required("SESSION_SECRET");

  if (dashboardPassword.length < 12) {
    throw new Error("DASHBOARD_PASSWORD는 12자 이상이어야 합니다.");
  }
  if (sessionSecret.length < 32) {
    throw new Error("SESSION_SECRET은 32자 이상이어야 합니다.");
  }

  return {
    clientId: required("CLIENT_ID"),
    clientSecret: required("CLIENT_SECRET"),
    dashboardPassword,
    sessionSecret,
    host: process.env.HOST?.trim() || "0.0.0.0",
    port: readPort(),
    tossApiBaseUrl: process.env.TOSS_API_BASE_URL?.trim() || "https://openapi.tossinvest.com",
    databasePath: process.env.DATABASE_PATH?.trim() || "./data/portfolio-history.sqlite",
    mysql: readMySqlConfig(),
    snapshotRefreshHours: readSnapshotRefreshHours(),
    nodeEnv: process.env.NODE_ENV?.trim() || "development",
  };
}
