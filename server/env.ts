export type AppConfig = {
  clientId: string;
  clientSecret: string;
  dashboardPassword: string;
  sessionSecret: string;
  host: string;
  port: number;
  tossApiBaseUrl: string;
  databasePath: string;
  snapshotRefreshHours: number;
  nodeEnv: string;
};

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
    snapshotRefreshHours: readSnapshotRefreshHours(),
    nodeEnv: process.env.NODE_ENV?.trim() || "development",
  };
}
