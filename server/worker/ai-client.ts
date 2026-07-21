import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import WebSocket, { type ClientOptions, type RawData } from "ws";
import { AiRequestSchema, type AiRequest, type AiResponse } from "./ai-contract.js";
import {
  AiServerTransportEnvelopeSchema,
  AiTransportCancelEnvelopeSchema,
  AiTransportRequestEnvelopeSchema,
  AiTransportStatusEnvelopeSchema,
  SCALPING_AI_TRANSPORT_VERSION,
  SCALPING_AI_WEBSOCKET_PATH,
  SCALPING_AI_WEBSOCKET_SUBPROTOCOL,
  type AiWorkerStatus,
} from "./ai-transport-contract.js";

export type AiComputeClientConfig = {
  url: string;
  authTokenFile: string;
  timeoutMs: number;
  connectTimeoutMs: number;
  reconnectBaseMs: number;
  reconnectMaxMs: number;
  maximumInFlight: number;
  maximumRequestBytes?: number;
  maximumResponseBytes?: number;
  tlsCa?: string;
};

export interface AiWebSocketLike {
  readonly readyState: number;
  readonly protocol: string;
  on(event: "open", listener: () => void): unknown;
  on(event: "message", listener: (data: RawData, isBinary: boolean) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "close", listener: (code: number, reason: Buffer) => void): unknown;
  send(data: string, callback?: (error?: Error) => void): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  removeAllListeners(): unknown;
}

export type AiWebSocketFactory = (
  url: string,
  protocol: string,
  options: ClientOptions,
) => AiWebSocketLike;

export type AiComputeClientOptions = {
  createWebSocket?: AiWebSocketFactory;
  readAuthTokenFile?: (path: string) => string;
  random?: () => number;
  now?: () => number;
};

export type AiComputeConnectionState = "idle" | "connecting" | "connected" | "reconnecting" | "unavailable" | "closed";

export type AiComputeClientSnapshot = {
  connection: AiComputeConnectionState;
  transportVersion: typeof SCALPING_AI_TRANSPORT_VERSION;
  secure: boolean;
  pendingRequests: number;
  worker?: AiWorkerStatus;
  lastConnectedAt?: string;
  lastResponseAt?: string;
  lastErrorCode?: string;
};

type PendingRequest = {
  request: AiRequest;
  envelope: string;
  sent: boolean;
  timer: NodeJS.Timeout;
  signal?: AbortSignal;
  onAbort?: () => void;
  resolve: (response: AiResponse) => void;
  reject: (error: Error) => void;
};

const MINIMUM_FRAME_BYTES = 1_024;
const MAXIMUM_FRAME_BYTES = 512 * 1024 * 1024;
const MAXIMUM_ENVELOPE_OVERHEAD_BYTES = 16 * 1024;
const MAXIMUM_IGNORED_RESPONSE_IDS = 1_024;
const OPEN_READY_STATE = 1;

function frameLimit(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < MINIMUM_FRAME_BYTES || resolved > MAXIMUM_FRAME_BYTES) {
    throw new Error(`${name}는 ${MINIMUM_FRAME_BYTES}~${MAXIMUM_FRAME_BYTES} 바이트 범위여야 합니다.`);
  }
  return resolved;
}

function positiveInteger(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name}는 ${minimum}~${maximum} 범위의 정수여야 합니다.`);
  }
  return value;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("AI compute 요청이 취소되었습니다.");
}

function rawDataBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.concat(data);
  throw new AiComputeTransportError("AI compute 응답 frame 형식이 올바르지 않습니다.", "INVALID_FRAME_TYPE", false);
}

function isFatalConnectionError(error: Error): boolean {
  const code = typeof (error as Error & { code?: unknown }).code === "string"
    ? (error as Error & { code: string }).code
    : "";
  return /Unexpected server response: (?:401|403|426)/i.test(error.message)
    || /CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY|HOSTNAME/i.test(code);
}

export class AiComputeTransportError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "AiComputeTransportError";
  }
}

export class AiComputeClient {
  private readonly maximumRequestBytes: number;
  private readonly maximumResponseBytes: number;
  private readonly url: URL;
  private readonly createWebSocket: AiWebSocketFactory;
  private readonly readAuthTokenFile: (path: string) => string;
  private readonly random: () => number;
  private readonly now: () => number;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly ignoredResponseIds = new Set<string>();
  private socket?: AiWebSocketLike;
  private reconnectTimer?: NodeJS.Timeout;
  private connectTimer?: NodeJS.Timeout;
  private reconnectAttempt = 0;
  private socketGeneration = 0;
  private statusRequestId?: string;
  private connection: AiComputeConnectionState = "idle";
  private workerStatus?: AiWorkerStatus;
  private lastConnectedAt?: string;
  private lastResponseAt?: string;
  private lastErrorCode?: string;
  private fatalError?: AiComputeTransportError;
  private closed = false;

  constructor(private readonly config: AiComputeClientConfig, options: AiComputeClientOptions = {}) {
    try {
      this.url = new URL(config.url);
    } catch {
      throw new Error("AI compute WebSocket URL이 올바르지 않습니다.");
    }
    if (!["ws:", "wss:"].includes(this.url.protocol)
      || this.url.pathname !== SCALPING_AI_WEBSOCKET_PATH
      || this.url.username || this.url.password || this.url.search || this.url.hash) {
      throw new Error(`AI compute URL은 ${SCALPING_AI_WEBSOCKET_PATH} 경로의 ws:// 또는 wss:// URL이어야 합니다.`);
    }
    if (!config.authTokenFile.trim() || !isAbsolute(config.authTokenFile)) {
      throw new Error("AI compute 인증 토큰 파일은 절대 경로여야 합니다.");
    }
    positiveInteger(config.timeoutMs, 1, 3_600_000, "AI compute timeout");
    positiveInteger(config.connectTimeoutMs, 1, 60_000, "AI compute 연결 timeout");
    positiveInteger(config.reconnectBaseMs, 1, 60_000, "AI compute 재연결 기본 지연");
    positiveInteger(config.reconnectMaxMs, config.reconnectBaseMs, 600_000, "AI compute 재연결 최대 지연");
    positiveInteger(config.maximumInFlight, 1, 1_000, "AI compute 동시 요청 상한");
    if (config.tlsCa !== undefined && (this.url.protocol !== "wss:" || !config.tlsCa.trim())) {
      throw new Error("AI compute TLS CA는 비어 있지 않은 wss:// 연결에서만 사용할 수 있습니다.");
    }
    this.maximumRequestBytes = frameLimit(config.maximumRequestBytes, 64 * 1024 * 1024, "AI compute 요청 상한");
    this.maximumResponseBytes = frameLimit(config.maximumResponseBytes, 128 * 1024 * 1024, "AI compute 응답 상한");
    this.createWebSocket = options.createWebSocket ?? ((url, protocol, clientOptions) => (
      new WebSocket(url, protocol, clientOptions)
    ));
    this.readAuthTokenFile = options.readAuthTokenFile ?? ((path) => readFileSync(path, "utf8"));
    this.random = options.random ?? Math.random;
    this.now = options.now ?? Date.now;
  }

  snapshot(): AiComputeClientSnapshot {
    return {
      connection: this.connection,
      transportVersion: SCALPING_AI_TRANSPORT_VERSION,
      secure: this.url.protocol === "wss:",
      pendingRequests: this.pending.size,
      ...(this.workerStatus ? { worker: structuredClone(this.workerStatus) } : {}),
      ...(this.lastConnectedAt ? { lastConnectedAt: this.lastConnectedAt } : {}),
      ...(this.lastResponseAt ? { lastResponseAt: this.lastResponseAt } : {}),
      ...(this.lastErrorCode ? { lastErrorCode: this.lastErrorCode } : {}),
    };
  }

  request(input: AiRequest, signal?: AbortSignal): Promise<AiResponse> {
    const request = AiRequestSchema.parse(input);
    const source = Buffer.from(JSON.stringify(request), "utf8");
    if (source.byteLength === 0 || source.byteLength > this.maximumRequestBytes) {
      throw new Error("AI compute 요청이 크기 상한을 초과했습니다.");
    }
    if (this.closed) return Promise.reject(new AiComputeTransportError("AI compute client가 종료되었습니다.", "CLIENT_CLOSED", false));
    if (this.fatalError) return Promise.reject(this.fatalError);
    if (this.pending.has(request.request_id)) {
      throw new AiComputeTransportError("동일한 AI compute request_id가 이미 처리 중입니다.", "DUPLICATE_REQUEST_ID", false);
    }
    if (this.pending.size >= this.config.maximumInFlight) {
      throw new AiComputeTransportError("AI compute 동시 요청 상한을 초과했습니다.", "MAXIMUM_IN_FLIGHT", true);
    }
    if (signal?.aborted) return Promise.reject(abortError(signal));
    const envelope = JSON.stringify(AiTransportRequestEnvelopeSchema.parse({
      transport_version: SCALPING_AI_TRANSPORT_VERSION,
      type: "request",
      request_id: request.request_id,
      payload: request,
    }));
    if (Buffer.byteLength(envelope, "utf8") > this.maximumRequestBytes + MAXIMUM_ENVELOPE_OVERHEAD_BYTES) {
      throw new Error("AI compute WebSocket 요청 envelope이 크기 상한을 초과했습니다.");
    }

    return new Promise<AiResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.cancelPending(
          request.request_id,
          new AiComputeTransportError(
            `AI compute 응답 제한 시간 ${this.config.timeoutMs}ms를 초과했습니다.`,
            "REQUEST_TIMEOUT",
            true,
          ),
        );
      }, this.config.timeoutMs);
      timer.unref();
      const pending: PendingRequest = { request, envelope, sent: false, timer, signal, resolve, reject };
      if (signal) {
        pending.onAbort = () => this.cancelPending(request.request_id, abortError(signal));
        signal.addEventListener("abort", pending.onAbort, { once: true });
      }
      this.pending.set(request.request_id, pending);
      this.ensureConnection();
      this.flushPending();
      if (signal?.aborted) pending.onAbort?.();
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.connection = "closed";
    this.clearConnectionTimers();
    const error = new AiComputeTransportError("AI compute client가 종료되었습니다.", "CLIENT_CLOSED", false);
    for (const requestId of [...this.pending.keys()]) this.settlePending(requestId, error);
    const socket = this.socket;
    this.socket = undefined;
    if (socket) {
      socket.removeAllListeners();
      socket.on("error", () => undefined);
      try {
        if (socket.readyState === OPEN_READY_STATE) socket.close(1_000, "client shutdown");
        else socket.terminate();
      } catch {
        socket.terminate();
      }
    }
  }

  private ensureConnection(): void {
    if (this.closed || this.fatalError || this.socket || this.reconnectTimer) return;
    this.connect();
  }

  private connect(): void {
    if (this.closed || this.fatalError || this.socket) return;
    const generation = ++this.socketGeneration;
    this.connection = this.reconnectAttempt > 0 ? "reconnecting" : "connecting";
    let authToken: string;
    try {
      authToken = this.readAuthTokenFile(this.config.authTokenFile).trim();
      if (!/^[\x21-\x7e]{32,4096}$/.test(authToken)) throw new Error("invalid token file");
    } catch {
      this.handleDisconnect(
        undefined,
        generation,
        new AiComputeTransportError(
          "AI compute 인증 토큰 파일을 아직 읽을 수 없습니다.",
          "AUTH_TOKEN_UNAVAILABLE",
          true,
        ),
      );
      return;
    }
    let socket: AiWebSocketLike;
    try {
      socket = this.createWebSocket(this.url.toString(), SCALPING_AI_WEBSOCKET_SUBPROTOCOL, {
        headers: { Authorization: `Bearer ${authToken}` },
        perMessageDeflate: false,
        maxPayload: this.maximumResponseBytes + MAXIMUM_ENVELOPE_OVERHEAD_BYTES,
        ...(this.config.tlsCa ? { ca: this.config.tlsCa } : {}),
      });
    } catch (error) {
      this.handleDisconnect(
        undefined,
        generation,
        error instanceof Error ? error : new Error("AI compute WebSocket 연결을 만들 수 없습니다."),
      );
      return;
    }
    this.socket = socket;
    let ended = false;
    const end = (error: Error, closeCode?: number) => {
      if (ended) return;
      ended = true;
      this.handleDisconnect(socket, generation, error, closeCode);
    };
    this.connectTimer = setTimeout(() => {
      end(new AiComputeTransportError("AI compute WebSocket 연결 시간이 초과되었습니다.", "CONNECT_TIMEOUT", true));
      socket.terminate();
    }, this.config.connectTimeoutMs);
    this.connectTimer.unref();
    socket.on("open", () => {
      if (ended || !this.isCurrent(socket, generation)) return;
      if (socket.protocol !== SCALPING_AI_WEBSOCKET_SUBPROTOCOL) {
        end(new AiComputeTransportError("AI compute WebSocket subprotocol이 일치하지 않습니다.", "PROTOCOL_MISMATCH", false), 4_406);
        socket.close(4_406, "subprotocol mismatch");
        return;
      }
      this.sendStatusRequest(socket, generation);
    });
    socket.on("message", (data, isBinary) => {
      if (ended || !this.isCurrent(socket, generation)) return;
      if (isBinary) {
        end(new AiComputeTransportError("AI compute worker가 binary frame을 반환했습니다.", "BINARY_FRAME", false), 1_003);
        socket.close(1_003, "text frames required");
        return;
      }
      try {
        this.handleMessage(rawDataBuffer(data));
      } catch (error) {
        const normalized = error instanceof AiComputeTransportError
          ? error
          : new AiComputeTransportError("AI compute 응답 전송 계약이 올바르지 않습니다.", "INVALID_RESPONSE", false);
        end(normalized, 1_002);
        socket.close(1_002, "invalid transport response");
      }
    });
    socket.on("error", (error) => {
      end(error);
      socket.terminate();
    });
    socket.on("close", (code, reason) => {
      const detail = reason.byteLength ? ` (${reason.toString("utf8").slice(0, 120)})` : "";
      end(new AiComputeTransportError(
        `AI compute WebSocket 연결이 종료되었습니다: ${code}${detail}`,
        `SOCKET_CLOSED_${code}`,
        ![4_401, 4_403, 4_406].includes(code),
      ), code);
    });
  }

  private isCurrent(socket: AiWebSocketLike, generation: number): boolean {
    return this.socket === socket && this.socketGeneration === generation;
  }

  private sendStatusRequest(socket: AiWebSocketLike, generation: number): void {
    const requestId = `status:${randomUUID()}`;
    const envelope = JSON.stringify(AiTransportStatusEnvelopeSchema.parse({
      transport_version: SCALPING_AI_TRANSPORT_VERSION,
      type: "status",
      request_id: requestId,
    }));
    this.statusRequestId = requestId;
    this.send(socket, generation, envelope);
  }

  private flushPending(): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== OPEN_READY_STATE || this.connection !== "connected") return;
    const generation = this.socketGeneration;
    for (const pending of this.pending.values()) {
      if (pending.sent) continue;
      pending.sent = true;
      this.send(socket, generation, pending.envelope);
    }
  }

  private send(socket: AiWebSocketLike, generation: number, envelope: string): void {
    try {
      socket.send(envelope, (error) => {
        if (error && this.isCurrent(socket, generation)) {
          this.handleDisconnect(socket, generation, error);
          socket.terminate();
        }
      });
    } catch (error) {
      this.handleDisconnect(
        socket,
        generation,
        error instanceof Error ? error : new Error("AI compute WebSocket 전송에 실패했습니다."),
      );
      socket.terminate();
    }
  }

  private handleMessage(raw: Buffer): void {
    if (raw.byteLength === 0 || raw.byteLength > this.maximumResponseBytes + MAXIMUM_ENVELOPE_OVERHEAD_BYTES) {
      throw new AiComputeTransportError("AI compute 응답이 크기 상한을 초과했습니다.", "RESPONSE_LIMIT_EXCEEDED", false);
    }
    let value: unknown;
    try {
      value = JSON.parse(raw.toString("utf8"));
    } catch {
      throw new AiComputeTransportError("AI compute 응답 JSON이 올바르지 않습니다.", "INVALID_JSON", false);
    }
    const parsed = AiServerTransportEnvelopeSchema.safeParse(value);
    if (!parsed.success) {
      throw new AiComputeTransportError("AI compute 응답 envelope이 올바르지 않습니다.", "INVALID_ENVELOPE", false);
    }
    this.lastResponseAt = new Date(this.now()).toISOString();
    if (parsed.data.type === "status_response") {
      if (!this.statusRequestId || parsed.data.request_id !== this.statusRequestId) {
        throw new AiComputeTransportError("AI compute status 응답 identity가 일치하지 않습니다.", "STATUS_IDENTITY_MISMATCH", false);
      }
      this.statusRequestId = undefined;
      this.workerStatus = parsed.data.status;
      if (this.connectTimer) clearTimeout(this.connectTimer);
      this.connectTimer = undefined;
      this.connection = "connected";
      this.lastConnectedAt = new Date(this.now()).toISOString();
      this.lastErrorCode = undefined;
      this.reconnectAttempt = 0;
      this.flushPending();
      return;
    }
    const pending = this.pending.get(parsed.data.request_id);
    if (!pending) {
      if (this.ignoredResponseIds.delete(parsed.data.request_id)) return;
      throw new AiComputeTransportError("등록되지 않은 AI compute 응답 request_id입니다.", "UNKNOWN_RESPONSE_ID", false);
    }
    const payloadBytes = Buffer.byteLength(JSON.stringify(parsed.data.payload), "utf8");
    if (payloadBytes === 0 || payloadBytes > this.maximumResponseBytes) {
      throw new AiComputeTransportError("AI compute 응답 payload가 크기 상한을 초과했습니다.", "RESPONSE_LIMIT_EXCEEDED", false);
    }
    if (parsed.data.payload.request_id !== pending.request.request_id
      || parsed.data.payload.mode !== pending.request.mode) {
      throw new AiComputeTransportError("AI compute 응답 identity가 요청과 일치하지 않습니다.", "RESPONSE_IDENTITY_MISMATCH", false);
    }
    this.settlePending(parsed.data.request_id, undefined, parsed.data.payload);
  }

  private cancelPending(requestId: string, error: Error): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    if (pending.sent) {
      this.rememberIgnoredResponse(requestId);
      const socket = this.socket;
      if (socket?.readyState === OPEN_READY_STATE && this.connection === "connected") {
        const envelope = JSON.stringify(AiTransportCancelEnvelopeSchema.parse({
          transport_version: SCALPING_AI_TRANSPORT_VERSION,
          type: "cancel",
          request_id: requestId,
        }));
        this.send(socket, this.socketGeneration, envelope);
      }
    }
    this.settlePending(requestId, error);
  }

  private rememberIgnoredResponse(requestId: string): void {
    this.ignoredResponseIds.add(requestId);
    while (this.ignoredResponseIds.size > MAXIMUM_IGNORED_RESPONSE_IDS) {
      const oldest = this.ignoredResponseIds.values().next().value as string | undefined;
      if (!oldest) break;
      this.ignoredResponseIds.delete(oldest);
    }
  }

  private settlePending(requestId: string, error?: Error, response?: AiResponse): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    clearTimeout(pending.timer);
    if (pending.signal && pending.onAbort) pending.signal.removeEventListener("abort", pending.onAbort);
    if (error) pending.reject(error);
    else pending.resolve(response!);
  }

  private handleDisconnect(
    socket: AiWebSocketLike | undefined,
    generation: number,
    error: Error,
    closeCode?: number,
  ): void {
    if (generation !== this.socketGeneration || (socket && this.socket !== socket)) return;
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = undefined;
    if (socket) {
      socket.removeAllListeners();
      socket.on("error", () => undefined);
    }
    this.socket = undefined;
    this.statusRequestId = undefined;
    const fatal = error instanceof AiComputeTransportError
      ? !error.retryable
      : isFatalConnectionError(error) || [4_401, 4_403, 4_406].includes(closeCode ?? 0);
    const normalized = error instanceof AiComputeTransportError
      ? error
      : new AiComputeTransportError(
        fatal ? "AI compute WebSocket 인증, TLS 또는 protocol 연결에 실패했습니다." : "AI compute WebSocket 연결에 실패했습니다.",
        fatal ? "CONNECTION_CONFIGURATION_ERROR" : "CONNECTION_FAILED",
        !fatal,
      );
    this.lastErrorCode = normalized.code;
    for (const [requestId, pending] of [...this.pending]) {
      if (pending.sent || fatal) this.settlePending(requestId, normalized);
    }
    if (this.closed) return;
    if (fatal) {
      this.fatalError = normalized;
      this.connection = "unavailable";
      return;
    }
    this.connection = "reconnecting";
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.closed || this.fatalError || this.reconnectTimer) return;
    const exponent = Math.min(this.reconnectAttempt, 30);
    const cap = Math.min(this.config.reconnectMaxMs, this.config.reconnectBaseMs * (2 ** exponent));
    const delay = Math.max(1, Math.floor(this.random() * cap));
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
    this.reconnectTimer.unref();
  }

  private clearConnectionTimers(): void {
    if (this.connectTimer) clearTimeout(this.connectTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.connectTimer = undefined;
    this.reconnectTimer = undefined;
  }
}
