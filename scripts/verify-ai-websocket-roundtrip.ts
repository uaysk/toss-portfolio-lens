import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { AiComputeClient } from "../server/worker/ai-client.js";
import { AiForecastRequestSchema, aiRequestBase, type AiForecastRequest } from "../server/worker/ai-contract.js";

function boundedInteger(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = Number.parseInt(process.env[name] ?? String(fallback), 10);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function booleanSetting(name: string, fallback = false): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (["1", "true", "yes", "on"].includes(raw.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(raw.toLowerCase())) return false;
  throw new Error(`${name} must be a boolean.`);
}

function isPrivateLiteral(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (isIP(host) === 4) {
    const parts = host.split(".").map(Number);
    return parts[0] === 10
      || (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31)
      || (parts[0] === 192 && parts[1] === 168);
  }
  return isIP(host) === 6 && (host.startsWith("fc") || host.startsWith("fd"));
}

function validateTestUrl(value: string): string {
  const url = new URL(value);
  if (!["ws:", "wss:"].includes(url.protocol)
    || url.pathname !== "/ws/scalping-ai/v1"
    || url.username || url.password || url.search || url.hash) {
    throw new Error("AI_COMPUTE_URL must be the versioned AI WebSocket endpoint.");
  }
  if (url.protocol === "ws:") {
    const local = ["ai-worker", "localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname.toLowerCase());
    if (!local && (!isPrivateLiteral(url.hostname) || !booleanSetting("AI_COMPUTE_ALLOW_INSECURE_PRIVATE_WS"))) {
      throw new Error("Remote ws:// verification is restricted to an explicitly allowed private-LAN address.");
    }
  }
  return url.toString();
}

function buildRequest(seriesCount: number): AiForecastRequest {
  const end = Math.floor(Date.now() / 60_000) * 60_000 - 60_000;
  const first = end - 79 * 60_000;
  const series = Array.from({ length: seriesCount }, (_, seriesIndex) => {
    let previousClose = 100 + seriesIndex * 7;
    const bars = Array.from({ length: 80 }, (_unused, index) => {
      const open = previousClose;
      const move = 0.00035 + Math.sin((index + seriesIndex) / 7) * 0.0012;
      const close = open * (1 + move);
      previousClose = close;
      const volume = 100_000 + seriesIndex * 10_000 + index * 271;
      return {
        timestamp: new Date(first + index * 60_000).toISOString(),
        open,
        high: Math.max(open, close) * 1.0015,
        low: Math.min(open, close) * 0.9985,
        close,
        volume,
        amount: volume * close,
        complete: true as const,
      };
    });
    return {
      instrument_key: `VERIFY:${String(seriesIndex + 1).padStart(4, "0")}`,
      timezone: "Asia/Seoul",
      input_end_at: bars.at(-1)!.timestamp,
      future_timestamps: Array.from({ length: 60 }, (_future, index) => (
        new Date(end + (index + 1) * 60_000).toISOString()
      )),
      bars,
    };
  });
  return AiForecastRequestSchema.parse({
    ...aiRequestBase(`ws-roundtrip-${Date.now()}`),
    mode: "forecast",
    series,
  });
}

async function main(): Promise<void> {
  const seriesCount = boundedInteger("AI_VERIFY_SERIES_COUNT", 2, 1, 50);
  const reconnectBaseMs = boundedInteger("AI_COMPUTE_RECONNECT_BASE_MS", 100, 1, 60_000);
  const caPath = process.env.AI_COMPUTE_TLS_CA_FILE?.trim();
  const client = new AiComputeClient({
    url: validateTestUrl(process.env.AI_COMPUTE_URL ?? "ws://127.0.0.1:18766/ws/scalping-ai/v1"),
    authTokenFile: process.env.AI_COMPUTE_AUTH_TOKEN_FILE ?? "/tmp/toss-portfolio-lens-ai-auth-token",
    timeoutMs: boundedInteger("AI_COMPUTE_TIMEOUT_MS", 180_000, 1_000, 3_600_000),
    connectTimeoutMs: boundedInteger("AI_COMPUTE_CONNECT_TIMEOUT_MS", 10_000, 1_000, 60_000),
    reconnectBaseMs,
    reconnectMaxMs: boundedInteger("AI_COMPUTE_RECONNECT_MAX_MS", 10_000, reconnectBaseMs, 600_000),
    maximumInFlight: boundedInteger("AI_COMPUTE_MAX_IN_FLIGHT", 4, 1, 1_000),
    maximumRequestBytes: boundedInteger("AI_MAX_REQUEST_BYTES", 64 * 1024 * 1024, 1_024, 512 * 1024 * 1024),
    maximumResponseBytes: boundedInteger("AI_MAX_RESPONSE_BYTES", 128 * 1024 * 1024, 1_024, 512 * 1024 * 1024),
    ...(caPath ? { tlsCa: readFileSync(caPath, "utf8") } : {}),
  });
  const request = buildRequest(seriesCount);
  const started = performance.now();
  try {
    const response = await client.request(request);
    const elapsedMs = Math.round(performance.now() - started);
    if (response.request_id !== request.request_id || response.series.length !== seriesCount) {
      throw new Error("AI WebSocket round-trip identity or batch cardinality did not match.");
    }
    if (booleanSetting("AI_VERIFY_REQUIRE_MODEL") && !response.model.loaded) {
      throw new Error("AI_VERIFY_REQUIRE_MODEL was set, but the worker model is unavailable.");
    }
    if (booleanSetting("AI_VERIFY_REQUIRE_CUDA") && response.model.device !== "cuda") {
      throw new Error(`AI_VERIFY_REQUIRE_CUDA was set, but the worker reported ${response.model.device}.`);
    }
    process.stdout.write(`${JSON.stringify({
      schema_version: "scalping-ai-websocket-verification/v1",
      elapsed_ms: elapsedMs,
      request_id: response.request_id,
      response_status: response.status,
      series_count: response.series.length,
      available_series: response.series.filter((item) => item.status === "available").length,
      horizons_per_available_series: response.series
        .filter((item) => item.status === "available")
        .map((item) => item.horizons.length),
      model: {
        id: response.model.model_id,
        revision: response.model.model_revision,
        loaded: response.model.loaded,
        device: response.model.device,
        dtype: response.model.dtype,
        attention_backend: response.model.attention_backend,
      },
      transport: client.snapshot(),
    }, null, 2)}\n`);
  } finally {
    client.close();
  }
}

main().catch((error) => {
  process.stderr.write(`AI WebSocket verification failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
