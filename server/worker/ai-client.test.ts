import { EventEmitter } from "node:events";
import type { ClientOptions, RawData } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AiComputeClient,
  AiComputeTransportError,
  type AiComputeClientConfig,
  type AiWebSocketFactory,
  type AiWebSocketLike,
} from "./ai-client.js";
import { aiRequestBase, type AiRequest } from "./ai-contract.js";
import {
  SCALPING_AI_TRANSPORT_VERSION,
  SCALPING_AI_WEBSOCKET_SUBPROTOCOL,
} from "./ai-transport-contract.js";

const BAR_TIME = "2026-07-21T00:00:00.000Z";
const AUTH_TOKEN = "a".repeat(64);

function request(requestId = "request-1"): AiRequest {
  return {
    ...aiRequestBase(requestId),
    mode: "forecast",
    series: [{
      instrument_key: "005930",
      timezone: "Asia/Seoul",
      input_end_at: BAR_TIME,
      bars: [{ timestamp: BAR_TIME, open: 100, high: 101, low: 99, close: 100, complete: true }],
      future_timestamps: Array.from({ length: 60 }, (_, index) => (
        new Date(Date.parse(BAR_TIME) + (index + 1) * 60_000).toISOString()
      )),
    }],
  };
}

function unavailableResponse(requestId = "request-1") {
  return {
    schema_version: "scalping-ai/v1",
    request_id: requestId,
    mode: "forecast",
    status: "unavailable",
    model: {
      model_id: "NeoQuasar/Kronos-small",
      model_revision: "pinned",
      source_revision: "source-pinned",
      loader_version: "portfolio-ai-loader/v1",
      license: "MIT",
      device: "unavailable",
      dtype: "float32",
      attention_backend: "unavailable",
      loaded: false,
      fallback_reason: "model cache missing",
    },
    generated_at: "2026-07-21T00:00:01.000Z",
    series: [{
      instrument_key: "005930",
      status: "unavailable",
      input_end_at: BAR_TIME,
      horizons: [],
      input_quality: {
        status: "partial",
        bar_count: 1,
        missing_volume_ratio: 1,
        missing_amount_ratio: 1,
        irregular_interval_count: 0,
        warnings: ["insufficient history"],
      },
      distribution_shift: { status: "unavailable", reason: "reference_statistics_not_published" },
      unavailable: { code: "model-unavailable", message: "model cache missing" },
    }],
  };
}

type SocketEvent = "open" | "message" | "error" | "close";

class FakeWebSocket extends EventEmitter implements AiWebSocketLike {
  readyState = 0;
  protocol = SCALPING_AI_WEBSOCKET_SUBPROTOCOL;
  readonly sent: string[] = [];

  send(data: string, callback?: (error?: Error) => void): void {
    if (this.readyState !== 1) throw new Error("socket is not open");
    this.sent.push(data);
    queueMicrotask(() => callback?.());
  }

  close(code = 1_000, reason = ""): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close", code, Buffer.from(reason));
  }

  terminate(): void {
    this.readyState = 3;
  }

  open(): void {
    this.readyState = 1;
    this.emit("open");
  }

  message(value: unknown, isBinary = false): void {
    const data = Buffer.from(typeof value === "string" ? value : JSON.stringify(value));
    this.emit("message", data as RawData, isBinary);
  }

  fail(error = new Error("connection failed")): void {
    this.emit("error", error);
  }

  serverClose(code = 1_006, reason = "connection lost"): void {
    this.readyState = 3;
    this.emit("close", code, Buffer.from(reason));
  }

  override on(event: SocketEvent, listener: (...arguments_: never[]) => void): this {
    return super.on(event, listener);
  }
}

function config(overrides: Partial<AiComputeClientConfig> = {}): AiComputeClientConfig {
  return {
    url: "ws://ai-worker:8765/ws/scalping-ai/v1",
    authTokenFile: "/run/ai-auth/token",
    timeoutMs: 2_000,
    connectTimeoutMs: 500,
    reconnectBaseMs: 100,
    reconnectMaxMs: 1_000,
    maximumInFlight: 4,
    ...overrides,
  };
}

function harness(options: {
  config?: Partial<AiComputeClientConfig>;
  readToken?: () => string;
  random?: () => number;
} = {}) {
  const sockets: FakeWebSocket[] = [];
  const connectionOptions: ClientOptions[] = [];
  const factory: AiWebSocketFactory = (_url, _protocol, clientOptions) => {
    const socket = new FakeWebSocket();
    sockets.push(socket);
    connectionOptions.push(clientOptions);
    return socket;
  };
  const client = new AiComputeClient(config(options.config), {
    createWebSocket: factory,
    readAuthTokenFile: options.readToken ?? (() => `${AUTH_TOKEN}\n`),
    random: options.random ?? (() => 0.5),
    now: () => Date.parse("2026-07-21T00:00:02.000Z"),
  });
  return { client, sockets, connectionOptions };
}

function envelopes(socket: FakeWebSocket): Array<Record<string, unknown>> {
  return socket.sent.map((item) => JSON.parse(item) as Record<string, unknown>);
}

function answerStatus(socket: FakeWebSocket): void {
  const status = envelopes(socket).find((item) => item.type === "status");
  if (!status) throw new Error("status request was not sent");
  socket.message({
    transport_version: SCALPING_AI_TRANSPORT_VERSION,
    type: "status_response",
    request_id: status.request_id,
    status: {
      status: "unavailable",
      model: {
        loaded: false,
        device: "unavailable",
        model_id: "NeoQuasar/Kronos-small",
        model_revision: "pinned",
      },
      active_requests: 0,
      queued_requests: 0,
      generated_at: "2026-07-21T00:00:01.000Z",
    },
  });
}

function answerRequest(socket: FakeWebSocket, requestId = "request-1"): void {
  socket.message({
    transport_version: SCALPING_AI_TRANSPORT_VERSION,
    type: "response",
    request_id: requestId,
    payload: unavailableResponse(requestId),
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("AiComputeClient WebSocket transport", () => {
  it("인증된 versioned text 연결에서 response와 status를 request_id로 연결한다", async () => {
    const { client, sockets, connectionOptions } = harness();
    const pending = client.request(request());
    expect(sockets).toHaveLength(1);
    expect(connectionOptions[0]).toMatchObject({
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
      perMessageDeflate: false,
    });
    sockets[0]!.open();
    expect(envelopes(sockets[0]!).map((item) => item.type)).toEqual(["status"]);
    answerStatus(sockets[0]!);
    expect(envelopes(sockets[0]!).map((item) => item.type)).toEqual(["status", "request"]);
    answerRequest(sockets[0]!);

    const response = await pending;
    expect(response).toEqual(unavailableResponse());
    expect(client.snapshot()).toMatchObject({
      connection: "connected",
      secure: false,
      pendingRequests: 0,
      worker: { status: "unavailable", model: { loaded: false, device: "unavailable" } },
    });
    client.close();
  });

  it("forming bar는 연결 전에 거부하고 URL, token path와 frame 한도를 검증한다", () => {
    const invalid = structuredClone(request()) as unknown as { series: Array<{ bars: Array<{ complete: boolean }> }> };
    invalid.series[0]!.bars[0]!.complete = false;
    expect(() => harness().client.request(invalid as never)).toThrow();
    expect(() => new AiComputeClient(config({ url: "https://ai.example/ws/scalping-ai/v1" }))).toThrow("ws:// 또는 wss://");
    expect(() => new AiComputeClient(config({ url: "wss://ai.example/other" }))).toThrow("/ws/scalping-ai/v1");
    expect(() => new AiComputeClient(config({ authTokenFile: "relative-token" }))).toThrow("절대 경로");
    expect(() => new AiComputeClient(config({ maximumResponseBytes: 512 }))).toThrow("응답 상한");
    expect(() => new AiComputeClient(config({ maximumRequestBytes: 512 * 1024 * 1024 + 1 }))).toThrow("요청 상한");
    expect(() => harness({ config: { maximumRequestBytes: 1_024 } }).client.request(request())).toThrow("크기 상한");
  });

  it("wss custom CA를 handshake에만 전달하고 oversized response를 protocol 오류로 종료한다", async () => {
    const tls = harness({
      config: { url: "wss://gpu.example.test:8765/ws/scalping-ai/v1", tlsCa: "test-ca" },
    });
    const tlsPending = tls.client.request(request("tls-request"));
    expect(tls.connectionOptions[0]).toMatchObject({ ca: "test-ca", perMessageDeflate: false });
    tls.client.close();
    await expect(tlsPending).rejects.toMatchObject({ code: "CLIENT_CLOSED" });

    const oversized = harness({ config: { maximumResponseBytes: 1_024 } });
    const oversizedPending = oversized.client.request(request());
    oversized.sockets[0]!.open();
    oversized.sockets[0]!.message("x".repeat(1_024 + 16 * 1_024 + 1));
    await expect(oversizedPending).rejects.toMatchObject({ code: "RESPONSE_LIMIT_EXCEEDED", retryable: false });
    oversized.client.close();
  });

  it("token file이 늦게 생성되면 unsent 요청을 보존하고 backoff 후 연결한다", async () => {
    vi.useFakeTimers();
    let available = false;
    const { client, sockets } = harness({
      readToken: () => {
        if (!available) throw new Error("ENOENT");
        return AUTH_TOKEN;
      },
      random: () => 0.5,
    });
    const pending = client.request(request());
    expect(sockets).toHaveLength(0);
    expect(client.snapshot()).toMatchObject({ connection: "reconnecting", pendingRequests: 1 });

    available = true;
    await vi.advanceTimersByTimeAsync(50);
    expect(sockets).toHaveLength(1);
    sockets[0]!.open();
    answerStatus(sockets[0]!);
    answerRequest(sockets[0]!);
    await expect(pending).resolves.toMatchObject({ request_id: "request-1", status: "unavailable" });
    client.close();
  });

  it("timeout과 AbortSignal은 전송된 요청에 cancel을 보내고 늦은 응답을 무시한다", async () => {
    vi.useFakeTimers();
    const { client, sockets } = harness({ config: { timeoutMs: 1_000 } });
    const timedOut = client.request(request("request-timeout"));
    const timedOutExpectation = expect(timedOut).rejects.toMatchObject({ code: "REQUEST_TIMEOUT" });
    sockets[0]!.open();
    answerStatus(sockets[0]!);
    await vi.advanceTimersByTimeAsync(1_000);
    await timedOutExpectation;
    expect(envelopes(sockets[0]!).some((item) => item.type === "cancel" && item.request_id === "request-timeout")).toBe(true);
    answerRequest(sockets[0]!, "request-timeout");
    expect(client.snapshot().connection).toBe("connected");

    const controller = new AbortController();
    const aborted = client.request(request("request-abort"), controller.signal);
    const abortedExpectation = expect(aborted).rejects.toThrow("caller cancelled");
    controller.abort(new Error("caller cancelled"));
    await abortedExpectation;
    expect(envelopes(sockets[0]!).some((item) => item.type === "cancel" && item.request_id === "request-abort")).toBe(true);
    client.close();
  });

  it("전송 후 disconnect된 요청은 실패시키고 재연결 때 replay하지 않는다", async () => {
    vi.useFakeTimers();
    const { client, sockets } = harness({ random: () => 0.5 });
    const pending = client.request(request("request-disconnect"));
    sockets[0]!.open();
    answerStatus(sockets[0]!);
    sockets[0]!.serverClose();
    await expect(pending).rejects.toMatchObject({ retryable: true });

    await vi.advanceTimersByTimeAsync(50);
    expect(sockets).toHaveLength(2);
    sockets[1]!.open();
    expect(envelopes(sockets[1]!).filter((item) => item.type === "request")).toHaveLength(0);
    client.close();
  });

  it("authenticated status가 연결 제한 시간 안에 없으면 요청을 보내지 않고 재연결한다", async () => {
    vi.useFakeTimers();
    const { client, sockets } = harness({ config: { connectTimeoutMs: 500 }, random: () => 0.5 });
    const pending = client.request(request());
    sockets[0]!.open();
    expect(envelopes(sockets[0]!).map((item) => item.type)).toEqual(["status"]);
    await vi.advanceTimersByTimeAsync(500);
    expect(client.snapshot()).toMatchObject({ connection: "reconnecting", pendingRequests: 1, lastErrorCode: "CONNECT_TIMEOUT" });
    client.close();
    await expect(pending).rejects.toMatchObject({ code: "CLIENT_CLOSED" });
  });

  it("잘못된 response identity, binary frame과 인증 실패를 fatal 상태로 처리한다", async () => {
    const identity = harness();
    const pending = identity.client.request(request());
    identity.sockets[0]!.open();
    answerStatus(identity.sockets[0]!);
    identity.sockets[0]!.message({
      transport_version: SCALPING_AI_TRANSPORT_VERSION,
      type: "response",
      request_id: "unknown-request",
      payload: unavailableResponse("unknown-request"),
    });
    await expect(pending).rejects.toMatchObject({ code: "UNKNOWN_RESPONSE_ID", retryable: false });
    expect(identity.client.snapshot().connection).toBe("unavailable");
    identity.client.close();

    const binary = harness();
    const binaryPending = binary.client.request(request());
    binary.sockets[0]!.open();
    binary.sockets[0]!.message("binary", true);
    await expect(binaryPending).rejects.toMatchObject({ code: "BINARY_FRAME", retryable: false });
    binary.client.close();

    const auth = harness();
    const authPending = auth.client.request(request());
    auth.sockets[0]!.fail(new Error("Unexpected server response: 401"));
    await expect(authPending).rejects.toMatchObject({ code: "CONNECTION_CONFIGURATION_ERROR", retryable: false });
    expect(auth.client.snapshot()).toMatchObject({ connection: "unavailable", lastErrorCode: "CONNECTION_CONFIGURATION_ERROR" });
    auth.client.close();
  });

  it("동일 ID, 최대 in-flight와 close 이후 요청을 명시적으로 거부한다", async () => {
    const { client } = harness({ config: { maximumInFlight: 1 } });
    const first = client.request(request());
    expect(() => client.request(request())).toThrow(AiComputeTransportError);
    expect(() => client.request(request("request-2"))).toThrow("동시 요청 상한");
    client.close();
    await expect(first).rejects.toMatchObject({ code: "CLIENT_CLOSED" });
    await expect(client.request(request("request-3"))).rejects.toMatchObject({ code: "CLIENT_CLOSED" });
  });
});
