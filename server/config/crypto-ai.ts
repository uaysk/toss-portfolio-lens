import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { isAbsolute } from "node:path";

export type CryptoAiLaneConfig = {
  url: string;
  authTokenFile: string;
  authTokenMustDifferFromFile?: string;
  timeoutMs: number;
  connectTimeoutMs: number;
  reconnectBaseMs: number;
  reconnectMaxMs: number;
  maximumInFlight: 1;
  maximumRequestBytes: number;
  maximumResponseBytes: number;
  tlsCa?: string;
};

export type CryptoAiConfig = {
  fincast: CryptoAiLaneConfig;
  chronos2?: CryptoAiLaneConfig;
  sequentialDeadlineMs: number;
  circuitBreaker: {
    failureThreshold: number;
    cooldownMs: number;
  };
};

type AiComputePrefix = "AI_FINCAST" | "AI_CHRONOS2";

type SelectedEnvironmentValue = {
  name: string;
  value: string;
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
  return isIP(normalized) === 6
    && (normalized.startsWith("fc") || normalized.startsWith("fd"));
}

export function readAiComputeUrl(
  value: string,
  name: string,
  allowInsecurePrivate: boolean,
): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name}은 유효한 WebSocket URL이어야 합니다.`);
  }
  if (!["ws:", "wss:"].includes(parsed.protocol)
    || parsed.pathname !== "/ws/scalping-ai/v2"
    || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${name}은 /ws/scalping-ai/v2 경로의 ws:// 또는 wss:// URL이어야 합니다.`);
  }
  if (parsed.protocol === "ws:") {
    const localCompose = ["fincast-worker", "chronos2-worker"].includes(
      parsed.hostname.toLowerCase(),
    );
    const local = localCompose || isLoopbackHost(parsed.hostname);
    const explicitlyAllowedPrivate = allowInsecurePrivate
      && isPrivateIpLiteral(parsed.hostname);
    if (!local && !explicitlyAllowedPrivate) {
      throw new Error(
        `원격 ${name}은 wss://를 사용해야 하며, private IP의 ws://는 `
        + `${name.replace(/_COMPUTE_URL$/, "_COMPUTE_ALLOW_INSECURE_PRIVATE_WS")}=true일 때만 허용됩니다.`,
      );
    }
  }
  return parsed.toString();
}

function selectEnvironmentValue(
  name: string,
  defaultValue: string,
): SelectedEnvironmentValue {
  return { name, value: optional(name) || defaultValue };
}

function readAbsolutePath(selection: SelectedEnvironmentValue): string {
  if (!isAbsolute(selection.value)) {
    throw new Error(`${selection.name}은 절대 경로여야 합니다.`);
  }
  return selection.value;
}

function readSerializedLaneLimit(selection: SelectedEnvironmentValue): 1 {
  if (selection.value !== "1") {
    throw new Error(`${selection.name}은 GPU lane 직렬화를 위해 1이어야 합니다.`);
  }
  return 1;
}

export function readAiTlsCa(prefix: AiComputePrefix): string | undefined {
  const name = `${prefix}_COMPUTE_TLS_CA_FILE`;
  const path = optional(name);
  if (!path) return undefined;
  let value: string;
  try {
    value = readFileSync(path, "utf8");
  } catch {
    throw new Error(`${name}을 읽을 수 없습니다.`);
  }
  if (!value.trim()) throw new Error(`${name}이 비어 있습니다.`);
  if (Buffer.byteLength(value, "utf8") > 1024 * 1024) {
    throw new Error(`${name}은 1MiB 이하여야 합니다.`);
  }
  return value;
}

function readLane(
  prefix: AiComputePrefix,
  defaultUrl: string,
  defaultTokenFile: string,
): CryptoAiLaneConfig {
  const url = selectEnvironmentValue(`${prefix}_COMPUTE_URL`, defaultUrl);
  const token = selectEnvironmentValue(
    `${prefix}_COMPUTE_AUTH_TOKEN_FILE`,
    defaultTokenFile,
  );
  const maximumInFlight = selectEnvironmentValue(
    `${prefix}_COMPUTE_MAX_IN_FLIGHT`,
    "1",
  );
  const allowInsecurePrivateWs = readBoolean(
    `${prefix}_COMPUTE_ALLOW_INSECURE_PRIVATE_WS`,
    false,
  );
  const tlsCa = readAiTlsCa(prefix);
  const normalizedUrl = readAiComputeUrl(url.value, url.name, allowInsecurePrivateWs);
  if (tlsCa && new URL(normalizedUrl).protocol !== "wss:") {
    throw new Error(
      `${prefix}_COMPUTE_TLS_CA_FILE은 wss:// ${url.name}에서만 사용할 수 있습니다.`,
    );
  }
  const reconnectBaseMs = readBoundedInteger(
    `${prefix}_COMPUTE_RECONNECT_BASE_MS`,
    250,
    1,
    60_000,
  );
  return {
    url: normalizedUrl,
    authTokenFile: readAbsolutePath(token),
    maximumInFlight: readSerializedLaneLimit(maximumInFlight),
    timeoutMs: readBoundedInteger(
      `${prefix}_COMPUTE_TIMEOUT_MS`,
      120_000,
      1_000,
      3_600_000,
    ),
    connectTimeoutMs: readBoundedInteger(
      `${prefix}_COMPUTE_CONNECT_TIMEOUT_MS`,
      10_000,
      1_000,
      60_000,
    ),
    reconnectBaseMs,
    reconnectMaxMs: readBoundedInteger(
      `${prefix}_COMPUTE_RECONNECT_MAX_MS`,
      10_000,
      reconnectBaseMs,
      600_000,
    ),
    maximumRequestBytes: readBoundedInteger(
      `${prefix}_COMPUTE_MAX_REQUEST_BYTES`,
      64 * 1024 * 1024,
      1_024,
      512 * 1024 * 1024,
    ),
    maximumResponseBytes: readBoundedInteger(
      `${prefix}_COMPUTE_MAX_RESPONSE_BYTES`,
      128 * 1024 * 1024,
      1_024,
      512 * 1024 * 1024,
    ),
    ...(tlsCa ? { tlsCa } : {}),
  };
}

export function readCryptoAiConfig(): CryptoAiConfig {
  const fincast = readLane(
    "AI_FINCAST",
    "ws://fincast-worker:8766/ws/scalping-ai/v2",
    "/run/fincast-auth/token",
  );
  const chronos2Url = optional("AI_CHRONOS2_COMPUTE_URL");
  const chronos2 = chronos2Url
    ? readLane(
      "AI_CHRONOS2",
      chronos2Url,
      "/run/chronos2-auth/token",
    )
    : undefined;
  if (chronos2?.authTokenFile === fincast.authTokenFile) {
    throw new Error("FinCast와 Chronos-2는 서로 다른 token 파일을 사용해야 합니다.");
  }

  return {
    fincast,
    ...(chronos2 ? {
      chronos2: {
        ...chronos2,
        authTokenMustDifferFromFile: fincast.authTokenFile,
      },
    } : {}),
    sequentialDeadlineMs: readBoundedInteger(
      "AI_CRYPTO_SEQUENTIAL_DEADLINE_MS",
      240_000,
      1_000,
      7_200_000,
    ),
    circuitBreaker: {
      failureThreshold: readBoundedInteger(
        "AI_CRYPTO_CIRCUIT_BREAKER_FAILURE_THRESHOLD",
        3,
        1,
        100,
      ),
      cooldownMs: readBoundedInteger(
        "AI_CRYPTO_CIRCUIT_BREAKER_COOLDOWN_MS",
        60_000,
        1_000,
        3_600_000,
      ),
    },
  };
}
