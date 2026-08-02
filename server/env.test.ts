import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, readCryptoAiConfig } from "./env.js";

const ORIGINAL_ENV = { ...process.env };

function requiredEnvironment(): NodeJS.ProcessEnv {
  return {
    CLIENT_ID: "client-id",
    CLIENT_SECRET: "client-secret",
    DASHBOARD_PASSWORD: "dashboard-password",
    READ_ONLY_API_TOKEN: "read-only-token",
    SESSION_SECRET: "session-secret-with-at-least-32-characters",
    POSTGRES_HOST: "postgres",
    POSTGRES_PORT: "5432",
    POSTGRES_USER: "portfolio",
    POSTGRES_PASSWORD: "postgres-password",
    POSTGRES_DATABASE: "portfolio",
  };
}

describe("strict production environment", () => {
  beforeEach(() => {
    process.env = requiredEnvironment();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("requires PostgreSQL and exposes no storage dialect selector", () => {
    expect(loadConfig()).toMatchObject({
      postgres: {
        host: "postgres",
        port: 5432,
        user: "portfolio",
        database: "portfolio",
      },
      compute: { executionMode: "rust_socket" },
    });
    const config = loadConfig() as unknown as Record<string, unknown>;
    expect(config).not.toHaveProperty("dbProvider");
    expect(config).not.toHaveProperty("databasePath");
    expect(config).not.toHaveProperty("mysql");

    delete process.env.POSTGRES_HOST;
    expect(() => loadConfig()).toThrow("POSTGRES_HOST");
  });

  it("accepts a canonical POSTGRES_URL and rejects non-PostgreSQL URLs", () => {
    delete process.env.POSTGRES_HOST;
    delete process.env.POSTGRES_PORT;
    delete process.env.POSTGRES_USER;
    delete process.env.POSTGRES_PASSWORD;
    delete process.env.POSTGRES_DATABASE;
    process.env.POSTGRES_URL = [
      "postgresql:",
      "//portfolio:password",
      "@db.example:5433/lens",
    ].join("");
    expect(loadConfig().postgres).toMatchObject({
      host: "db.example",
      port: 5433,
      user: "portfolio",
      password: "password",
      database: "lens",
    });
    process.env.POSTGRES_URL = [
      "mysql:",
      "//portfolio:password",
      "@db.example/lens",
    ].join("");
    expect(() => loadConfig()).toThrow("POSTGRES_URL은 postgresql://");
  });

  it("fails closed when either auth token is missing, blank, or shared", () => {
    delete process.env.READ_ONLY_API_TOKEN;
    expect(() => loadConfig()).toThrow("READ_ONLY_API_TOKEN");

    process.env.READ_ONLY_API_TOKEN = "dashboard-password";
    expect(() => loadConfig()).toThrow("DASHBOARD_PASSWORD와 달라야");

    process.env.READ_ONLY_API_TOKEN = "contains whitespace";
    expect(() => loadConfig()).toThrow("공백");
  });

  it("accepts only Rust socket and PostgreSQL durable-queue execution modes", () => {
    process.env.EXECUTION_MODE = "external";
    expect(loadConfig().compute.executionMode).toBe("external");
    process.env.EXECUTION_MODE = "inline";
    expect(() => loadConfig()).toThrow("rust_socket 또는 external");
  });

  it("keeps production Toss provider traffic on approved HTTPS origins", () => {
    process.env.NODE_ENV = "production";
    process.env.TOSS_API_BASE_URL = "http://openapi.tossinvest.com";
    expect(() => loadConfig()).toThrow("HTTPS");

    process.env.TOSS_API_BASE_URL = "https://attacker.invalid";
    expect(() => loadConfig()).toThrow("공식 토스증권 API origin");

    process.env.TOSS_API_BASE_URL = "https://openapi.tossinvest.com";
    expect(loadConfig().tossApiBaseUrl).toBe("https://openapi.tossinvest.com");
  });

  it("uses only FinCast and optional Chronos-2 v2 lanes", () => {
    process.env.AI_CHRONOS2_COMPUTE_URL = "ws://chronos2-worker:8767/ws/scalping-ai/v2";
    process.env.AI_CHRONOS2_COMPUTE_AUTH_TOKEN_FILE = "/run/chronos2-auth/token";
    expect(readCryptoAiConfig()).toMatchObject({
      fincast: {
        url: "ws://fincast-worker:8766/ws/scalping-ai/v2",
        authTokenFile: "/run/fincast-auth/token",
        maximumInFlight: 1,
      },
      chronos2: {
        url: "ws://chronos2-worker:8767/ws/scalping-ai/v2",
        authTokenFile: "/run/chronos2-auth/token",
        authTokenMustDifferFromFile: "/run/fincast-auth/token",
        maximumInFlight: 1,
      },
    });
  });

  it("rejects old WebSocket contracts and shared lane token files", () => {
    process.env.AI_FINCAST_COMPUTE_URL = "ws://fincast-worker:8766/ws/scalping-ai/v1";
    expect(() => readCryptoAiConfig()).toThrow("/ws/scalping-ai/v2");

    process.env.AI_FINCAST_COMPUTE_URL = "ws://fincast-worker:8766/ws/scalping-ai/v2";
    process.env.AI_CHRONOS2_COMPUTE_URL = "ws://chronos2-worker:8767/ws/scalping-ai/v2";
    process.env.AI_CHRONOS2_COMPUTE_AUTH_TOKEN_FILE = "/run/fincast-auth/token";
    expect(() => readCryptoAiConfig()).toThrow("서로 다른 token 파일");
  });

  it("requires TLS for remote AI hosts unless a private address is explicitly opted in", () => {
    process.env.AI_FINCAST_COMPUTE_URL = "ws://203.0.113.10:8766/ws/scalping-ai/v2";
    expect(() => readCryptoAiConfig()).toThrow("wss://");

    process.env.AI_FINCAST_COMPUTE_URL = "ws://10.20.30.40:8766/ws/scalping-ai/v2";
    expect(() => readCryptoAiConfig()).toThrow("ALLOW_INSECURE_PRIVATE_WS");
    process.env.AI_FINCAST_COMPUTE_ALLOW_INSECURE_PRIVATE_WS = "true";
    expect(readCryptoAiConfig().fincast.url).toBe(
      "ws://10.20.30.40:8766/ws/scalping-ai/v2",
    );
  });

  it("keeps each GPU lane serialized and requires absolute token paths", () => {
    process.env.AI_FINCAST_COMPUTE_MAX_IN_FLIGHT = "2";
    expect(() => readCryptoAiConfig()).toThrow("GPU lane 직렬화를 위해 1");

    process.env.AI_FINCAST_COMPUTE_MAX_IN_FLIGHT = "1";
    process.env.AI_FINCAST_COMPUTE_AUTH_TOKEN_FILE = "relative/token";
    expect(() => readCryptoAiConfig()).toThrow("절대 경로");
  });

  it("keeps crypto orchestration limits fail-closed after reader extraction", () => {
    process.env.AI_CRYPTO_SEQUENTIAL_DEADLINE_MS = "999";
    expect(() => readCryptoAiConfig()).toThrow(
      "AI_CRYPTO_SEQUENTIAL_DEADLINE_MS는 1000~7200000",
    );

    process.env.AI_CRYPTO_SEQUENTIAL_DEADLINE_MS = "1000";
    process.env.AI_CRYPTO_CIRCUIT_BREAKER_FAILURE_THRESHOLD = "0";
    expect(() => readCryptoAiConfig()).toThrow(
      "AI_CRYPTO_CIRCUIT_BREAKER_FAILURE_THRESHOLD는 1~100",
    );
  });
});
