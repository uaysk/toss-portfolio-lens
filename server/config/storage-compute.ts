import { readFileSync } from "node:fs";
import type { PostgresConnectionConfig } from "../database.js";

export type ComputeExecutionMode = "rust_socket" | "external";

export type ComputeConfig = {
  executionMode: ComputeExecutionMode;
  resultPollMs: number;
  resultDeadlineMs: number;
  rustSocketPath: string;
  rustSocketPoolSize: number;
  rustSocketTimeoutMs: number;
  rustComputeMaxQueued: number;
  rustComputeQueueTimeoutMs: number;
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

function readBoundedInteger(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = Number.parseInt(process.env[name] ?? String(fallback), 10);
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${name}는 ${minimum}~${maximum} 범위의 숫자여야 합니다.`);
  }
  return value;
}

export function readPostgresConfig(): PostgresConnectionConfig {
  const postgresUrl = optional("POSTGRES_URL");
  const individualNames = [
    "POSTGRES_HOST",
    "POSTGRES_PORT",
    "POSTGRES_USER",
    "POSTGRES_PASSWORD",
    "POSTGRES_DATABASE",
  ];
  const hasIndividualValue = individualNames.some(
    (name) => process.env[name] !== undefined,
  );
  if (!postgresUrl && !hasIndividualValue) {
    throw new Error(
      "POSTGRES_URL 또는 POSTGRES_HOST, POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DATABASE가 필요합니다.",
    );
  }

  let host: string | undefined;
  let portText: string | undefined;
  let user: string | undefined;
  let password: string | undefined;
  let database: string | undefined;
  if (postgresUrl) {
    const parsed = new URL(postgresUrl);
    if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
      throw new Error("POSTGRES_URL은 postgresql:// 형식이어야 합니다.");
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
    throw new Error(
      "POSTGRES_HOST, POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DATABASE가 모두 필요합니다.",
    );
  }
  if (!/^[A-Za-z0-9_-]{1,63}$/.test(database)) {
    throw new Error("POSTGRES_DATABASE 이름은 영문, 숫자, _, -만 사용할 수 있습니다.");
  }
  const port = Number.parseInt(portText || "5432", 10);
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    throw new Error("POSTGRES_PORT가 올바르지 않습니다.");
  }
  const connectTimeoutMs = Number.parseInt(
    optional("POSTGRES_CONNECT_TIMEOUT_MS") || "3000",
    10,
  );
  if (
    !Number.isFinite(connectTimeoutMs)
    || connectTimeoutMs < 500
    || connectTimeoutMs > 30_000
  ) {
    throw new Error("POSTGRES_CONNECT_TIMEOUT_MS는 500~30000 범위여야 합니다.");
  }
  const useSsl = readBoolean("POSTGRES_SSL", false);
  const caPath = optional("POSTGRES_SSL_CA_PATH");
  if (caPath && !useSsl) {
    throw new Error("POSTGRES_SSL_CA_PATH를 사용하려면 POSTGRES_SSL=true가 필요합니다.");
  }
  const ca = caPath ? readFileSync(caPath, "utf8") : undefined;
  if (caPath && !ca?.trim()) {
    throw new Error("POSTGRES_SSL_CA_PATH의 인증서가 비어 있습니다.");
  }
  return {
    host,
    port,
    user,
    password,
    database,
    connectTimeoutMs,
    ...(useSsl
      ? {
          ssl: {
            rejectUnauthorized: readBoolean(
              "POSTGRES_SSL_REJECT_UNAUTHORIZED",
              true,
            ),
            ...(ca ? { ca } : {}),
          },
        }
      : {}),
  };
}

export function readComputeConfig(): ComputeConfig {
  const mode = optional("EXECUTION_MODE")?.toLowerCase() || "rust_socket";
  if (mode !== "rust_socket" && mode !== "external") {
    throw new Error("EXECUTION_MODE는 rust_socket 또는 external이어야 합니다.");
  }
  return {
    executionMode: mode,
    resultPollMs: readBoundedInteger(
      "RUST_WORKER_RESULT_POLL_MS",
      250,
      25,
      10_000,
    ),
    resultDeadlineMs: readBoundedInteger(
      "RUST_WORKER_RESULT_DEADLINE_MS",
      300_000,
      1_000,
      3_600_000,
    ),
    rustSocketPath:
      optional("RUST_COMPUTE_SOCKET")
      || "/tmp/toss-portfolio-lens-compute.sock",
    rustSocketPoolSize: readBoundedInteger(
      "RUST_COMPUTE_POOL_SIZE",
      2,
      1,
      32,
    ),
    rustSocketTimeoutMs: readBoundedInteger(
      "RUST_COMPUTE_TIMEOUT_MS",
      300_000,
      1_000,
      3_600_000,
    ),
    rustComputeMaxQueued: readBoundedInteger(
      "RUST_COMPUTE_MAX_QUEUED",
      32,
      1,
      10_000,
    ),
    rustComputeQueueTimeoutMs: readBoundedInteger(
      "RUST_COMPUTE_QUEUE_TIMEOUT_MS",
      30_000,
      100,
      3_600_000,
    ),
  };
}
