import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readComputeConfig,
  readPostgresConfig,
} from "./storage-compute.js";

const ORIGINAL_ENV = { ...process.env };

function individualPostgresEnvironment(): NodeJS.ProcessEnv {
  return {
    POSTGRES_HOST: "postgres",
    POSTGRES_PORT: "5432",
    POSTGRES_USER: "portfolio",
    POSTGRES_PASSWORD: "postgres-password",
    POSTGRES_DATABASE: "portfolio",
  };
}

beforeEach(() => {
  process.env = {};
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("storage configuration reader", () => {
  it("requires complete PostgreSQL configuration and preserves canonical defaults", () => {
    expect(() => readPostgresConfig()).toThrow("POSTGRES_URL 또는 POSTGRES_HOST");

    process.env = individualPostgresEnvironment();
    expect(readPostgresConfig()).toEqual({
      host: "postgres",
      port: 5432,
      user: "portfolio",
      password: "postgres-password",
      database: "portfolio",
      connectTimeoutMs: 3_000,
    });

    delete process.env.POSTGRES_USER;
    expect(() => readPostgresConfig()).toThrow(
      "POSTGRES_HOST, POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DATABASE",
    );
  });

  it("accepts only PostgreSQL URLs and validates database, port, and timeout", () => {
    process.env.POSTGRES_URL =
      "postgresql://portfolio:password@db.example:5433/lens";
    expect(readPostgresConfig()).toMatchObject({
      host: "db.example",
      port: 5433,
      user: "portfolio",
      password: "password",
      database: "lens",
    });

    process.env.POSTGRES_URL = "mysql://portfolio:password@db.example/lens";
    expect(() => readPostgresConfig()).toThrow("POSTGRES_URL은 postgresql://");

    delete process.env.POSTGRES_URL;
    process.env = {
      ...individualPostgresEnvironment(),
      POSTGRES_DATABASE: "invalid/name",
    };
    expect(() => readPostgresConfig()).toThrow("POSTGRES_DATABASE 이름");

    process.env.POSTGRES_DATABASE = "portfolio";
    process.env.POSTGRES_PORT = "65536";
    expect(() => readPostgresConfig()).toThrow("POSTGRES_PORT");

    process.env.POSTGRES_PORT = "5432";
    process.env.POSTGRES_CONNECT_TIMEOUT_MS = "499";
    expect(() => readPostgresConfig()).toThrow(
      "POSTGRES_CONNECT_TIMEOUT_MS는 500~30000",
    );
  });

  it("rejects a CA path unless PostgreSQL TLS is enabled", () => {
    process.env = {
      ...individualPostgresEnvironment(),
      POSTGRES_SSL_CA_PATH: "/tmp/postgres-ca.pem",
    };
    expect(() => readPostgresConfig()).toThrow(
      "POSTGRES_SSL_CA_PATH를 사용하려면 POSTGRES_SSL=true",
    );
  });
});

describe("compute configuration reader", () => {
  it("keeps Rust socket defaults and accepts the PostgreSQL durable queue", () => {
    expect(readComputeConfig()).toEqual({
      executionMode: "rust_socket",
      resultPollMs: 250,
      resultDeadlineMs: 300_000,
      rustSocketPath: "/tmp/toss-portfolio-lens-compute.sock",
      rustSocketPoolSize: 2,
      rustSocketTimeoutMs: 300_000,
      rustComputeMaxQueued: 32,
      rustComputeQueueTimeoutMs: 30_000,
    });

    process.env.EXECUTION_MODE = "external";
    expect(readComputeConfig().executionMode).toBe("external");
  });

  it("rejects legacy execution modes and out-of-range queue settings", () => {
    process.env.EXECUTION_MODE = "inline";
    expect(() => readComputeConfig()).toThrow(
      "EXECUTION_MODE는 rust_socket 또는 external",
    );

    process.env.EXECUTION_MODE = "rust_socket";
    process.env.RUST_COMPUTE_MAX_QUEUED = "0";
    expect(() => readComputeConfig()).toThrow(
      "RUST_COMPUTE_MAX_QUEUED는 1~10000",
    );
  });
});
