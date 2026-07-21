import type { MarketCountry } from "./contracts.js";
import type { KisEnvironment, KisMarketSource, KisUsExchangeCode } from "./kis-rest-client.js";
import { zonedTimestamp } from "./market-time.js";

type UnknownRecord = Record<string, unknown>;

export type KisExecutionTrId = "H0STCNT0" | "H0NXCNT0" | "H0UNCNT0" | "HDFSCNT0";
export type KisOrderbookTrId = "H0STASP0" | "H0NXASP0" | "H0UNASP0" | "HDFSASP0";
export type KisMarketTrId = KisExecutionTrId | KisOrderbookTrId;

export type KisWebSocketConfig = {
  appKey: string;
  appSecret: string;
  environment: KisEnvironment;
  url?: string;
  approvalTimeoutMs: number;
  approvalMaxAttempts: number;
  approvalRetryBaseMs: number;
  approvalRetryMaxMs: number;
  maxSubscriptions: number;
  subscribeIntervalMs: number;
  connectionTimeoutMs: number;
  reconnectBaseMs: number;
  reconnectMaxMs: number;
  reconnectJitterRatio: number;
};

export type KisSubscription = {
  trId: KisMarketTrId;
  symbol: string;
  exchange?: KisUsExchangeCode;
};

export type KisConnectionState =
  | "idle"
  | "authorizing"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error"
  | "closed";

export type KisConnectionEvent = {
  type: "connection";
  state: KisConnectionState;
  providerTimestamp: string;
  generation: number;
  attempt: number;
  reason?: string;
  retryInMs?: number;
};

export type KisExecutionEvent = {
  type: "execution";
  trId: KisExecutionTrId;
  market: KisMarketSource;
  marketCountry: MarketCountry;
  exchange?: KisUsExchangeCode;
  symbol: string;
  eventId: string;
  providerTimestamp: string;
  receivedAt: string;
  sessionDate: string;
  tradeTime: string;
  price: number;
  executionVolume: number;
  accumulatedVolume: number;
  accumulatedTradingAmount: number;
  askPrice1: number;
  bidPrice1: number;
  executionStrength?: number;
  executionClassCode?: string;
  tradingHalted?: boolean;
};

export type KisOrderbookLevel = {
  level: number;
  price: number;
  quantity: number;
};

export type KisOrderbookEvent = {
  type: "orderbook";
  trId: KisOrderbookTrId;
  market: KisMarketSource;
  marketCountry: MarketCountry;
  exchange?: KisUsExchangeCode;
  symbol: string;
  providerTimestamp: string;
  receivedAt: string;
  sessionDate: string;
  quoteTime: string;
  timestampDateSource: "received-session-date" | "provider-local-date";
  depth: "ten_level" | "top_of_book";
  asks: KisOrderbookLevel[];
  bids: KisOrderbookLevel[];
  totalAskQuantity: number;
  totalBidQuantity: number;
};

export type KisSubscriptionEvent = {
  type: "subscription";
  trId: KisMarketTrId;
  market: KisMarketSource;
  marketCountry: MarketCountry;
  exchange?: KisUsExchangeCode;
  symbol: string;
  providerTimestamp: string;
  action: "subscribe" | "unsubscribe" | "unknown";
  accepted: boolean;
  code: string;
  message: string;
};

export type KisPingEvent = {
  type: "ping";
  trId: "PINGPONG";
  providerTimestamp: string;
};

export type KisParseErrorEvent = {
  type: "parse_error";
  providerTimestamp: string;
  reason: string;
  trId?: string;
  market?: KisMarketSource;
  symbol?: string;
};

export type KisWebSocketEvent =
  | KisConnectionEvent
  | KisExecutionEvent
  | KisOrderbookEvent
  | KisSubscriptionEvent
  | KisPingEvent
  | KisParseErrorEvent;

export type WebSocketEventName = "open" | "message" | "error" | "close";
export type WebSocketListener = (event: unknown) => void;

export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: WebSocketEventName, listener: WebSocketListener): void;
  removeEventListener?(type: WebSocketEventName, listener: WebSocketListener): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export type KisWebSocketClientOptions = {
  fetchImpl?: typeof fetch;
  webSocketFactory?: WebSocketFactory;
  sleepImpl?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
  setTimeoutImpl?: (callback: () => void, milliseconds: number) => unknown;
  clearTimeoutImpl?: (handle: unknown) => void;
};

export class KisWebSocketError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "KisWebSocketError";
  }
}

export class KisWebSocketValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KisWebSocketValidationError";
  }
}

const REST_BASE_URLS: Record<KisEnvironment, string> = {
  real: "https://openapi.koreainvestment.com:9443",
  demo: "https://openapivts.koreainvestment.com:29443",
};
const WEB_SOCKET_URLS: Record<KisEnvironment, string> = {
  real: "ws://ops.koreainvestment.com:21000",
  demo: "ws://ops.koreainvestment.com:31000",
};
const APPROVAL_PATH = "/oauth2/Approval";
const OPEN_READY_STATE = 1;

const EXECUTION_TR_IDS = new Set<KisExecutionTrId>(["H0STCNT0", "H0NXCNT0", "H0UNCNT0", "HDFSCNT0"]);
const ORDERBOOK_TR_IDS = new Set<KisOrderbookTrId>(["H0STASP0", "H0NXASP0", "H0UNASP0", "HDFSASP0"]);
const US_EXCHANGES = new Set<KisUsExchangeCode>(["NAS", "NYS", "AMS"]);

type ControlMessage = {
  action: "subscribe" | "unsubscribe";
  subscription: KisSubscription;
};

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return "";
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const normalized = value.replace(/[,%\s]/g, "");
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized)) return undefined;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function optionalFiniteNumber(value: unknown): number | undefined {
  return stringValue(value) === "" ? undefined : finiteNumber(value);
}

function isCompactDate(value: string): boolean {
  if (!/^\d{8}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

function isCompactTime(value: string): boolean {
  if (!/^\d{6}$/.test(value)) return false;
  const hour = Number(value.slice(0, 2));
  const minute = Number(value.slice(2, 4));
  const second = Number(value.slice(4, 6));
  return hour <= 23 && minute <= 59 && second <= 59;
}

function compactTimestamp(date: string, time: string): string {
  return `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}+09:00`;
}

function seoulCompactDate(timestamp: number): string {
  return new Date(timestamp + 9 * 60 * 60 * 1_000).toISOString().slice(0, 10).replaceAll("-", "");
}

function nowIso(now: () => number): string {
  return new Date(now()).toISOString();
}

function marketForTrId(trId: string): KisMarketSource | undefined {
  if (trId === "HDFSCNT0" || trId === "HDFSASP0") return "US";
  if (trId.startsWith("H0ST")) return "KRX";
  if (trId.startsWith("H0NX")) return "NXT";
  if (trId.startsWith("H0UN")) return "INTEGRATED";
  return undefined;
}

function marketCountryForTrId(trId: string): MarketCountry | undefined {
  return trId === "HDFSCNT0" || trId === "HDFSASP0" ? "US" : marketForTrId(trId) ? "KR" : undefined;
}

function isExecutionTrId(value: string): value is KisExecutionTrId {
  return EXECUTION_TR_IDS.has(value as KisExecutionTrId);
}

function isOrderbookTrId(value: string): value is KisOrderbookTrId {
  return ORDERBOOK_TR_IDS.has(value as KisOrderbookTrId);
}

function isMarketTrId(value: string): value is KisMarketTrId {
  return isExecutionTrId(value) || isOrderbookTrId(value);
}

function subscriptionKey(subscription: KisSubscription): string {
  return `${subscription.trId}:${subscription.exchange ?? ""}:${subscription.symbol}`;
}

function providerSubscriptionKey(subscription: KisSubscription): string {
  if (subscription.trId === "HDFSCNT0" || subscription.trId === "HDFSASP0") {
    return `D${subscription.exchange}${subscription.symbol}`;
  }
  return subscription.symbol;
}

function overseasSymbol(value: string): { symbol: string; exchange?: KisUsExchangeCode } {
  const normalized = value.trim().toUpperCase();
  const prefixed = /^[DR]([A-Z]{3})([A-Z0-9._-]{1,32})$/.exec(normalized);
  if (!prefixed) return { symbol: normalized };
  const providerExchange = prefixed[1]!;
  const exchange = providerExchange === "BAQ" ? "NAS"
    : providerExchange === "BAY" ? "NYS"
      : providerExchange === "BAA" ? "AMS"
        : US_EXCHANGES.has(providerExchange as KisUsExchangeCode)
          ? providerExchange as KisUsExchangeCode
          : undefined;
  return { symbol: prefixed[2]!, ...(exchange ? { exchange } : {}) };
}

function assertPositive(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new KisWebSocketValidationError(`${name} must be a positive finite number.`);
  }
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function defaultWebSocketFactory(url: string): WebSocketLike {
  const constructor = (globalThis as unknown as {
    WebSocket?: new (address: string) => WebSocketLike;
  }).WebSocket;
  if (!constructor) {
    throw new KisWebSocketError("No WebSocket implementation is available.", "websocket-unavailable", false);
  }
  return new constructor(url);
}

function eventData(event: unknown): unknown {
  return isRecord(event) && "data" in event ? event.data : event;
}

function textFrame(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) return value.toString("utf8");
  if (value instanceof ArrayBuffer) return new TextDecoder().decode(value);
  if (ArrayBuffer.isView(value)) {
    return new TextDecoder().decode(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  }
  return undefined;
}

export class KisWebSocketClient {
  private readonly restBaseUrl: string;
  private readonly webSocketUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly webSocketFactory: WebSocketFactory;
  private readonly sleepImpl: (milliseconds: number) => Promise<void>;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly setTimeoutImpl: (callback: () => void, milliseconds: number) => unknown;
  private readonly clearTimeoutImpl: (handle: unknown) => void;
  private readonly listeners = new Set<(event: KisWebSocketEvent) => void>();
  private readonly desiredSubscriptions = new Map<string, KisSubscription>();
  private state: KisConnectionState = "idle";
  private generation = 0;
  private reconnectAttempt = 0;
  private manuallyStopped = true;
  private socket?: WebSocketLike;
  private approvalKey?: string;
  private approvalInFlight?: Promise<string>;
  private approvalController?: AbortController;
  private connectionInFlight?: Promise<void>;
  private reconnectTimer?: unknown;
  private connectionTimer?: unknown;
  private controlTimer?: unknown;
  private controlQueue: ControlMessage[] = [];
  private readonly pendingControlActions = new Map<string, "subscribe" | "unsubscribe">();
  private nextControlAt = 0;

  constructor(
    private readonly config: KisWebSocketConfig,
    options: KisWebSocketClientOptions = {},
  ) {
    if (config.environment !== "real" && config.environment !== "demo") {
      throw new KisWebSocketValidationError("environment must be real or demo.");
    }
    if (!config.appKey.trim()) throw new KisWebSocketValidationError("appKey must not be empty.");
    if (!config.appSecret.trim()) throw new KisWebSocketValidationError("appSecret must not be empty.");
    assertPositive(config.approvalTimeoutMs, "approvalTimeoutMs");
    if (!Number.isInteger(config.approvalMaxAttempts) || config.approvalMaxAttempts < 1) {
      throw new KisWebSocketValidationError("approvalMaxAttempts must be an integer greater than or equal to 1.");
    }
    assertPositive(config.approvalRetryBaseMs, "approvalRetryBaseMs");
    assertPositive(config.approvalRetryMaxMs, "approvalRetryMaxMs");
    if (config.approvalRetryMaxMs < config.approvalRetryBaseMs) {
      throw new KisWebSocketValidationError("approvalRetryMaxMs must be greater than or equal to approvalRetryBaseMs.");
    }
    if (!Number.isInteger(config.maxSubscriptions) || config.maxSubscriptions < 1) {
      throw new KisWebSocketValidationError("maxSubscriptions must be a positive integer.");
    }
    assertPositive(config.subscribeIntervalMs, "subscribeIntervalMs");
    assertPositive(config.connectionTimeoutMs, "connectionTimeoutMs");
    assertPositive(config.reconnectBaseMs, "reconnectBaseMs");
    assertPositive(config.reconnectMaxMs, "reconnectMaxMs");
    if (config.reconnectMaxMs < config.reconnectBaseMs) {
      throw new KisWebSocketValidationError("reconnectMaxMs must be greater than or equal to reconnectBaseMs.");
    }
    if (!Number.isFinite(config.reconnectJitterRatio)
      || config.reconnectJitterRatio < 0 || config.reconnectJitterRatio > 1) {
      throw new KisWebSocketValidationError("reconnectJitterRatio must be between 0 and 1.");
    }
    if (config.url !== undefined && !/^wss?:\/\//i.test(config.url)) {
      throw new KisWebSocketValidationError("url must use ws:// or wss://.");
    }
    this.restBaseUrl = REST_BASE_URLS[config.environment];
    this.webSocketUrl = config.url ?? WEB_SOCKET_URLS[config.environment];
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.webSocketFactory = options.webSocketFactory ?? defaultWebSocketFactory;
    this.sleepImpl = options.sleepImpl ?? defaultSleep;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.setTimeoutImpl = options.setTimeoutImpl ?? ((callback, milliseconds) => setTimeout(callback, milliseconds));
    this.clearTimeoutImpl = options.clearTimeoutImpl ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  get connectionState(): KisConnectionState {
    return this.state;
  }

  get subscriptionCount(): number {
    return this.desiredSubscriptions.size;
  }

  onEvent(listener: (event: KisWebSocketEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribe(subscription: KisSubscription): boolean {
    this.validateSubscription(subscription);
    const normalized = { ...subscription, symbol: subscription.symbol.toUpperCase() };
    const key = subscriptionKey(normalized);
    if (this.desiredSubscriptions.has(key)) return false;
    if (this.desiredSubscriptions.size >= this.config.maxSubscriptions) {
      throw new KisWebSocketValidationError(
        `Configured KIS WebSocket subscription capacity (${this.config.maxSubscriptions}) was reached.`,
      );
    }
    this.desiredSubscriptions.set(key, normalized);
    if (this.state === "connected") this.enqueueControl({ action: "subscribe", subscription: normalized });
    return true;
  }

  unsubscribe(subscription: KisSubscription): boolean {
    this.validateSubscription(subscription);
    const normalized = { ...subscription, symbol: subscription.symbol.toUpperCase() };
    const removed = this.desiredSubscriptions.delete(subscriptionKey(normalized));
    if (removed && this.state === "connected") {
      this.enqueueControl({ action: "unsubscribe", subscription: normalized });
    }
    return removed;
  }

  async connect(): Promise<void> {
    this.manuallyStopped = false;
    if (this.state === "connected" || this.state === "connecting") return;
    if (this.connectionInFlight) return this.connectionInFlight;
    this.clearReconnectTimer();
    const task = this.openConnection(this.reconnectAttempt > 0);
    this.connectionInFlight = task;
    try {
      await task;
    } finally {
      if (this.connectionInFlight === task) this.connectionInFlight = undefined;
    }
  }

  disconnect(): void {
    this.manuallyStopped = true;
    this.generation += 1;
    this.clearReconnectTimer();
    this.clearConnectionTimer();
    this.clearControlQueue();
    const socket = this.socket;
    this.socket = undefined;
    this.approvalKey = undefined;
    this.approvalInFlight = undefined;
    this.approvalController?.abort();
    this.approvalController = undefined;
    this.pendingControlActions.clear();
    if (socket) {
      try {
        socket.close(1_000, "client disconnect");
      } catch {
        // Closing is best effort; generation checks discard late events.
      }
    }
    this.transition("closed", this.generation, "client disconnect");
  }

  private validateSubscription(subscription: KisSubscription): void {
    if (!isMarketTrId(subscription.trId)) throw new KisWebSocketValidationError("Unsupported KIS market TR ID.");
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(subscription.symbol)) {
      throw new KisWebSocketValidationError("symbol must contain 1 to 32 supported ASCII characters.");
    }
    const overseas = subscription.trId === "HDFSCNT0" || subscription.trId === "HDFSASP0";
    if (overseas && !US_EXCHANGES.has(subscription.exchange as KisUsExchangeCode)) {
      throw new KisWebSocketValidationError("US subscriptions require exchange NAS, NYS, or AMS.");
    }
    if (!overseas && subscription.exchange !== undefined) {
      throw new KisWebSocketValidationError("exchange is only valid for US subscriptions.");
    }
  }

  private emit(event: KisWebSocketEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A consumer exception must not break the market-data connection.
      }
    }
  }

  private transition(
    state: KisConnectionState,
    generation: number,
    reason?: string,
    retryInMs?: number,
  ): void {
    this.state = state;
    this.emit({
      type: "connection",
      state,
      providerTimestamp: nowIso(this.now),
      generation,
      attempt: this.reconnectAttempt,
      ...(reason ? { reason } : {}),
      ...(retryInMs === undefined ? {} : { retryInMs }),
    });
  }

  private async approval(): Promise<string> {
    if (this.approvalKey) return this.approvalKey;
    if (this.approvalInFlight) return this.approvalInFlight;
    const task = this.issueApproval();
    this.approvalInFlight = task;
    try {
      return await task;
    } finally {
      if (this.approvalInFlight === task) this.approvalInFlight = undefined;
    }
  }

  private async issueApproval(): Promise<string> {
    for (let attempt = 0; attempt < this.config.approvalMaxAttempts; attempt += 1) {
      const controller = new AbortController();
      this.approvalController = controller;
      const timeout = this.setTimeoutImpl(() => controller.abort(), this.config.approvalTimeoutMs);
      try {
        const response = await this.fetchImpl(`${this.restBaseUrl}${APPROVAL_PATH}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            grant_type: "client_credentials",
            appkey: this.config.appKey,
            secretkey: this.config.appSecret,
          }),
          signal: controller.signal,
        });
        let body: unknown;
        try {
          body = await response.json();
        } catch {
          throw new KisWebSocketError("KIS approval response was not valid JSON.", "invalid-approval-response", response.status >= 500);
        }
        if (!isRecord(body)) {
          throw new KisWebSocketError("KIS approval response was invalid.", "invalid-approval-response", false);
        }
        const code = stringValue(body.error_code) || stringValue(body.msg_cd) || `http-${response.status}`;
        if (!response.ok || (body.rt_cd !== undefined && stringValue(body.rt_cd) !== "0")) {
          const retryable = response.status === 429 || response.status >= 500 || code === "EGW00201";
          throw new KisWebSocketError(
            this.redact(stringValue(body.error_description) || stringValue(body.msg1) || "KIS approval request failed."),
            code,
            retryable,
          );
        }
        const key = stringValue(body.approval_key);
        if (!key) throw new KisWebSocketError("KIS approval key was empty.", "empty-approval-key", false);
        this.approvalKey = key;
        return key;
      } catch (error) {
        if (this.manuallyStopped) {
          throw new KisWebSocketError("KIS approval request was cancelled.", "approval-cancelled", false);
        }
        const normalized = error instanceof KisWebSocketError
          ? error
          : new KisWebSocketError(
            error instanceof Error && error.name === "AbortError"
              ? "KIS approval request timed out."
              : "KIS approval network request failed.",
            error instanceof Error && error.name === "AbortError" ? "approval-timeout" : "approval-network-error",
            true,
          );
        if (!normalized.retryable || attempt + 1 >= this.config.approvalMaxAttempts) throw normalized;
        const delay = Math.min(
          this.config.approvalRetryMaxMs,
          this.config.approvalRetryBaseMs * 2 ** attempt,
        );
        await this.sleepImpl(delay);
      } finally {
        this.clearTimeoutImpl(timeout);
        if (this.approvalController === controller) this.approvalController = undefined;
      }
    }
    throw new KisWebSocketError("KIS approval request failed.", "approval-failed", false);
  }

  private async openConnection(isReconnect: boolean): Promise<void> {
    const generation = ++this.generation;
    this.transition(isReconnect ? "reconnecting" : "authorizing", generation);
    try {
      await this.approval();
      if (this.manuallyStopped || generation !== this.generation) return;
      const socket = this.webSocketFactory(this.webSocketUrl);
      if (this.manuallyStopped || generation !== this.generation) {
        socket.close(1_000, "stale connection");
        return;
      }
      this.socket = socket;
      this.attachSocket(socket, generation);
      this.transition("connecting", generation);
      this.connectionTimer = this.setTimeoutImpl(() => {
        if (!this.isCurrent(socket, generation) || this.state === "connected") return;
        this.transition("error", generation, "connection timeout");
        this.socket = undefined;
        try {
          socket.close(4_000, "connection timeout");
        } catch {
          // Reconnection below remains authoritative.
        }
        this.scheduleReconnect(generation, "connection timeout");
      }, this.config.connectionTimeoutMs);
    } catch (error) {
      if (this.manuallyStopped || generation !== this.generation) return;
      const normalized = error instanceof KisWebSocketError
        ? error
        : new KisWebSocketError("KIS WebSocket connection failed.", "connection-error", true);
      this.transition("error", generation, normalized.message);
      this.scheduleReconnect(generation, normalized.code);
      if (!isReconnect) throw normalized;
    }
  }

  private attachSocket(socket: WebSocketLike, generation: number): void {
    socket.addEventListener("open", () => {
      if (!this.isCurrent(socket, generation)) return;
      this.clearConnectionTimer();
      this.reconnectAttempt = 0;
      this.transition("connected", generation);
      this.resetControlQueue();
      for (const subscription of this.desiredSubscriptions.values()) {
        this.enqueueControl({ action: "subscribe", subscription });
      }
    });
    socket.addEventListener("message", (event) => {
      if (!this.isCurrent(socket, generation)) return;
      this.handleMessage(socket, event);
    });
    socket.addEventListener("error", () => {
      if (!this.isCurrent(socket, generation)) return;
      this.transition("error", generation, "websocket error");
      this.clearConnectionTimer();
      this.clearControlQueue();
      this.socket = undefined;
      try {
        socket.close(4_001, "websocket error");
      } catch {
        // Reconnection below remains authoritative.
      }
      this.scheduleReconnect(generation, "websocket error");
    });
    socket.addEventListener("close", (event) => {
      if (!this.isCurrent(socket, generation)) return;
      this.clearConnectionTimer();
      this.clearControlQueue();
      this.socket = undefined;
      const reason = isRecord(event) ? stringValue(event.reason) : "";
      this.transition("closed", generation, reason || "websocket closed");
      this.scheduleReconnect(generation, reason || "websocket closed");
    });
  }

  private isCurrent(socket: WebSocketLike, generation: number): boolean {
    return !this.manuallyStopped && this.socket === socket && this.generation === generation;
  }

  private scheduleReconnect(generation: number, reason: string): void {
    if (this.manuallyStopped || generation !== this.generation || this.reconnectTimer !== undefined) return;
    const exponential = Math.min(
      this.config.reconnectMaxMs,
      this.config.reconnectBaseMs * 2 ** this.reconnectAttempt,
    );
    const jitter = (this.random() * 2 - 1) * this.config.reconnectJitterRatio;
    const delay = Math.max(1, Math.min(this.config.reconnectMaxMs, Math.round(exponential * (1 + jitter))));
    this.reconnectAttempt += 1;
    this.transition("reconnecting", generation, reason, delay);
    this.reconnectTimer = this.setTimeoutImpl(() => {
      this.reconnectTimer = undefined;
      if (this.manuallyStopped || generation !== this.generation) return;
      const task = this.openConnection(true);
      this.connectionInFlight = task;
      void task.finally(() => {
        if (this.connectionInFlight === task) this.connectionInFlight = undefined;
      }).catch(() => {
        // openConnection emits state and schedules the next configured retry.
      });
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer === undefined) return;
    this.clearTimeoutImpl(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private clearConnectionTimer(): void {
    if (this.connectionTimer === undefined) return;
    this.clearTimeoutImpl(this.connectionTimer);
    this.connectionTimer = undefined;
  }

  private resetControlQueue(): void {
    this.clearControlQueue();
    this.nextControlAt = 0;
  }

  private clearControlQueue(): void {
    if (this.controlTimer !== undefined) this.clearTimeoutImpl(this.controlTimer);
    this.controlTimer = undefined;
    this.controlQueue = [];
    this.pendingControlActions.clear();
  }

  private enqueueControl(message: ControlMessage): void {
    this.controlQueue.push(message);
    this.drainControlQueue();
  }

  private drainControlQueue(): void {
    if (this.state !== "connected" || !this.socket || this.controlTimer !== undefined || this.controlQueue.length === 0) return;
    const waitMs = Math.max(0, this.nextControlAt - this.now());
    if (waitMs > 0) {
      this.controlTimer = this.setTimeoutImpl(() => {
        this.controlTimer = undefined;
        this.drainControlQueue();
      }, waitMs);
      return;
    }
    const message = this.controlQueue.shift();
    if (!message) return;
    const key = subscriptionKey(message.subscription);
    const stillRelevant = message.action === "unsubscribe" || this.desiredSubscriptions.has(key);
    if (stillRelevant) this.sendControl(this.socket, message);
    this.nextControlAt = this.now() + this.config.subscribeIntervalMs;
    if (this.controlQueue.length > 0) this.drainControlQueue();
  }

  private sendControl(socket: WebSocketLike, message: ControlMessage): void {
    if (!this.approvalKey || socket.readyState !== OPEN_READY_STATE) return;
    const providerKey = providerSubscriptionKey(message.subscription);
    const pendingKey = `${message.subscription.trId}:${providerKey}`;
    try {
      this.pendingControlActions.set(pendingKey, message.action);
      socket.send(JSON.stringify({
        header: {
          approval_key: this.approvalKey,
          custtype: "P",
          tr_type: message.action === "subscribe" ? "1" : "2",
          "content-type": "utf-8",
        },
        body: {
          input: {
            tr_id: message.subscription.trId,
            tr_key: providerKey,
          },
        },
      }));
    } catch {
      this.pendingControlActions.delete(pendingKey);
      this.emit({
        type: "parse_error",
        providerTimestamp: nowIso(this.now),
        reason: "Failed to send KIS subscription control frame.",
        trId: message.subscription.trId,
        market: marketForTrId(message.subscription.trId),
        symbol: message.subscription.symbol,
      });
    }
  }

  private handleMessage(socket: WebSocketLike, event: unknown): void {
    const raw = textFrame(eventData(event));
    if (raw === undefined) {
      this.emitParseError("Unsupported KIS WebSocket message type.");
      return;
    }
    const trimmed = raw.trim();
    if (trimmed.startsWith("{")) {
      this.handleJsonMessage(socket, raw);
      return;
    }
    this.handleDataMessage(raw);
  }

  private handleJsonMessage(socket: WebSocketLike, raw: string): void {
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      this.emitParseError("KIS WebSocket JSON frame was malformed.");
      return;
    }
    if (!isRecord(body)) {
      this.emitParseError("KIS WebSocket JSON frame was not an object.");
      return;
    }
    const header = isRecord(body.header) ? body.header : {};
    const trId = stringValue(header.tr_id);
    if (trId === "PINGPONG") {
      try {
        socket.send(raw);
      } catch {
        this.emitParseError("Failed to echo KIS PINGPONG frame.", "PINGPONG");
        return;
      }
      const providerTimestamp = this.systemTimestamp(header.datetime);
      this.emit({ type: "ping", trId: "PINGPONG", providerTimestamp });
      return;
    }
    if (!isMarketTrId(trId)) {
      this.emitParseError("Unknown KIS WebSocket JSON TR ID.", trId || undefined);
      return;
    }
    const responseBody = isRecord(body.body) ? body.body : {};
    const code = stringValue(responseBody.msg_cd) || stringValue(responseBody.rt_cd) || "unknown";
    const accepted = stringValue(responseBody.rt_cd) === "0";
    const providerKey = stringValue(header.tr_key).toUpperCase();
    const decoded = trId === "HDFSCNT0" || trId === "HDFSASP0"
      ? overseasSymbol(providerKey)
      : { symbol: providerKey };
    if (!/^[A-Z0-9][A-Z0-9._-]{0,31}$/.test(decoded.symbol)
      || ((trId === "HDFSCNT0" || trId === "HDFSASP0") && decoded.exchange === undefined)) {
      this.emitParseError("KIS subscription acknowledgement did not include a valid symbol.", trId, marketForTrId(trId));
      return;
    }
    const trType = stringValue(header.tr_type);
    const pendingAction = this.pendingControlActions.get(`${trId}:${providerKey}`);
    this.pendingControlActions.delete(`${trId}:${providerKey}`);
    this.emit({
      type: "subscription",
      trId,
      market: marketForTrId(trId)!,
      marketCountry: marketCountryForTrId(trId)!,
      ...(decoded.exchange ? { exchange: decoded.exchange } : {}),
      symbol: decoded.symbol,
      providerTimestamp: this.systemTimestamp(header.datetime),
      action: trType === "1" ? "subscribe" : trType === "2" ? "unsubscribe" : pendingAction ?? "unknown",
      accepted,
      code,
      message: stringValue(responseBody.msg1),
    });
  }

  private systemTimestamp(value: unknown): string {
    const compact = stringValue(value).replace(/[^0-9]/g, "");
    if (compact.length >= 14) {
      const date = compact.slice(0, 8);
      const time = compact.slice(8, 14);
      if (isCompactDate(date) && isCompactTime(time)) return compactTimestamp(date, time);
    }
    return nowIso(this.now);
  }

  private handleDataMessage(raw: string): void {
    const [encrypted, trId = "", rawCount = "", ...payloadParts] = raw.split("|");
    if (encrypted !== "0") {
      this.emitParseError("Encrypted or unsupported KIS WebSocket frame was not parsed.", trId || undefined);
      return;
    }
    if (!isMarketTrId(trId)) {
      this.emitParseError("Unknown KIS market-data TR ID.", trId || undefined);
      return;
    }
    const recordCount = Number(rawCount);
    if (!Number.isInteger(recordCount) || recordCount < 1) {
      this.emitParseError("KIS market-data frame had an invalid record count.", trId);
      return;
    }
    const fields = payloadParts.join("|").split("^");
    const minimumWidth = trId === "HDFSCNT0" ? 26 : trId === "HDFSASP0" ? 17
      : isExecutionTrId(trId) ? 46 : 59;
    if (fields.length < minimumWidth * recordCount || fields.length % recordCount !== 0) {
      this.emitParseError("KIS market-data frame length did not match its record count.", trId);
      return;
    }
    const width = fields.length / recordCount;
    for (let index = 0; index < recordCount; index += 1) {
      const values = fields.slice(index * width, (index + 1) * width);
      if (trId === "HDFSCNT0") this.parseOverseasExecution(values);
      else if (trId === "HDFSASP0") this.parseOverseasOrderbook(values);
      else if (isExecutionTrId(trId)) this.parseExecution(trId, values);
      else this.parseOrderbook(trId, values);
    }
  }

  private parseExecution(trId: KisExecutionTrId, values: string[]): void {
    const symbol = stringValue(values[0]);
    const time = stringValue(values[1]);
    const price = finiteNumber(values[2]);
    const askPrice1 = finiteNumber(values[10]);
    const bidPrice1 = finiteNumber(values[11]);
    const executionVolume = finiteNumber(values[12]);
    const accumulatedVolume = finiteNumber(values[13]);
    const accumulatedTradingAmount = finiteNumber(values[14]);
    const executionStrength = optionalFiniteNumber(values[18]);
    const sessionDate = stringValue(values[33]);
    const market = marketForTrId(trId)!;
    const invalid = [
      !/^[A-Za-z0-9]{1,12}$/.test(symbol) ? "symbol" : "",
      !isCompactTime(time) ? "time" : "",
      price === undefined || price <= 0 ? "price" : "",
      askPrice1 === undefined || askPrice1 < 0 ? "askPrice1" : "",
      bidPrice1 === undefined || bidPrice1 < 0 ? "bidPrice1" : "",
      executionVolume === undefined || executionVolume <= 0 ? "executionVolume" : "",
      accumulatedVolume === undefined || accumulatedVolume < 0 ? "accumulatedVolume" : "",
      accumulatedTradingAmount === undefined || accumulatedTradingAmount < 0 ? "accumulatedTradingAmount" : "",
      stringValue(values[18]) !== "" && executionStrength === undefined ? "executionStrength" : "",
      !isCompactDate(sessionDate) ? "sessionDate" : "",
    ].filter(Boolean);
    if (invalid.length > 0 || price === undefined || askPrice1 === undefined || bidPrice1 === undefined
      || executionVolume === undefined || accumulatedVolume === undefined || accumulatedTradingAmount === undefined) {
      this.emitParseError(
        `KIS execution record was excluded because fields were invalid: ${invalid.join(", ")}.`,
        trId,
        market,
        symbol || undefined,
      );
      return;
    }
    const receivedAt = nowIso(this.now);
    this.emit({
      type: "execution",
      trId,
      market,
      marketCountry: "KR",
      symbol,
      eventId: `kis:${trId}:${symbol}:${sessionDate}:${time}:${accumulatedVolume}:${price}:${executionVolume}`,
      providerTimestamp: compactTimestamp(sessionDate, time),
      receivedAt,
      sessionDate,
      tradeTime: time,
      price,
      executionVolume,
      accumulatedVolume,
      accumulatedTradingAmount,
      askPrice1,
      bidPrice1,
      ...(executionStrength === undefined ? {} : { executionStrength }),
      ...(stringValue(values[21]) ? { executionClassCode: stringValue(values[21]) } : {}),
      tradingHalted: stringValue(values[35]).toUpperCase() === "Y",
    });
  }

  private parseOverseasExecution(values: string[]): void {
    const decoded = overseasSymbol(stringValue(values[0]));
    const providerSymbol = stringValue(values[1]).toUpperCase();
    const sessionDate = stringValue(values[4]);
    const time = stringValue(values[5]);
    const price = finiteNumber(values[11]);
    const bidPrice1 = finiteNumber(values[15]);
    const askPrice1 = finiteNumber(values[16]);
    const executionVolume = finiteNumber(values[19]);
    const accumulatedVolume = finiteNumber(values[20]);
    const accumulatedTradingAmount = finiteNumber(values[21]);
    const executionStrength = optionalFiniteNumber(values[24]);
    const providerTimestamp = zonedTimestamp(sessionDate, time, "America/New_York");
    const invalid = [
      !/^[A-Z0-9][A-Z0-9._-]{0,31}$/.test(decoded.symbol) ? "symbol" : "",
      providerSymbol !== decoded.symbol ? "providerSymbol" : "",
      decoded.exchange === undefined ? "exchange" : "",
      !isCompactDate(sessionDate) ? "sessionDate" : "",
      !isCompactTime(time) ? "time" : "",
      !providerTimestamp ? "timestamp" : "",
      price === undefined || price <= 0 ? "price" : "",
      askPrice1 === undefined || askPrice1 < 0 ? "askPrice1" : "",
      bidPrice1 === undefined || bidPrice1 < 0 ? "bidPrice1" : "",
      executionVolume === undefined || executionVolume <= 0 ? "executionVolume" : "",
      accumulatedVolume === undefined || accumulatedVolume < 0 ? "accumulatedVolume" : "",
      accumulatedTradingAmount === undefined || accumulatedTradingAmount < 0 ? "accumulatedTradingAmount" : "",
      stringValue(values[24]) !== "" && executionStrength === undefined ? "executionStrength" : "",
    ].filter(Boolean);
    if (invalid.length > 0 || !providerTimestamp || decoded.exchange === undefined || price === undefined
      || askPrice1 === undefined || bidPrice1 === undefined || executionVolume === undefined
      || accumulatedVolume === undefined || accumulatedTradingAmount === undefined) {
      this.emitParseError(
        `KIS overseas execution record was excluded because fields were invalid: ${invalid.join(", ")}.`,
        "HDFSCNT0",
        "US",
        decoded.symbol || undefined,
      );
      return;
    }
    const receivedAt = nowIso(this.now);
    this.emit({
      type: "execution",
      trId: "HDFSCNT0",
      market: "US",
      marketCountry: "US",
      exchange: decoded.exchange,
      symbol: decoded.symbol,
      eventId: `kis:HDFSCNT0:${decoded.exchange}:${decoded.symbol}:${sessionDate}:${time}:${accumulatedVolume}:${price}:${executionVolume}`,
      providerTimestamp,
      receivedAt,
      sessionDate,
      tradeTime: time,
      price,
      executionVolume,
      accumulatedVolume,
      accumulatedTradingAmount,
      askPrice1,
      bidPrice1,
      ...(executionStrength === undefined ? {} : { executionStrength }),
      ...(stringValue(values[25]) ? { executionClassCode: stringValue(values[25]) } : {}),
    });
  }

  private parseOverseasOrderbook(values: string[]): void {
    const decoded = overseasSymbol(stringValue(values[0]));
    const providerSymbol = stringValue(values[1]).toUpperCase();
    const sessionDate = stringValue(values[3]);
    const time = stringValue(values[4]);
    const totalBidQuantity = finiteNumber(values[7]);
    const totalAskQuantity = finiteNumber(values[8]);
    const bidPrice = finiteNumber(values[11]);
    const askPrice = finiteNumber(values[12]);
    const bidQuantity = finiteNumber(values[13]);
    const askQuantity = finiteNumber(values[14]);
    const providerTimestamp = zonedTimestamp(sessionDate, time, "America/New_York");
    const invalid = [
      !/^[A-Z0-9][A-Z0-9._-]{0,31}$/.test(decoded.symbol) ? "symbol" : "",
      providerSymbol !== decoded.symbol ? "providerSymbol" : "",
      decoded.exchange === undefined ? "exchange" : "",
      !isCompactDate(sessionDate) ? "sessionDate" : "",
      !isCompactTime(time) ? "time" : "",
      !providerTimestamp ? "timestamp" : "",
      bidPrice === undefined || bidPrice <= 0 ? "bidPrice1" : "",
      askPrice === undefined || askPrice <= 0 ? "askPrice1" : "",
      bidQuantity === undefined || bidQuantity < 0 ? "bidQuantity1" : "",
      askQuantity === undefined || askQuantity < 0 ? "askQuantity1" : "",
      totalBidQuantity === undefined || totalBidQuantity < 0 ? "totalBidQuantity" : "",
      totalAskQuantity === undefined || totalAskQuantity < 0 ? "totalAskQuantity" : "",
    ].filter(Boolean);
    if (invalid.length > 0 || !providerTimestamp || decoded.exchange === undefined
      || bidPrice === undefined || askPrice === undefined || bidQuantity === undefined || askQuantity === undefined
      || totalBidQuantity === undefined || totalAskQuantity === undefined) {
      this.emitParseError(
        `KIS overseas orderbook record was excluded because fields were invalid: ${invalid.join(", ")}.`,
        "HDFSASP0",
        "US",
        decoded.symbol || undefined,
      );
      return;
    }
    const receivedAt = nowIso(this.now);
    this.emit({
      type: "orderbook",
      trId: "HDFSASP0",
      market: "US",
      marketCountry: "US",
      exchange: decoded.exchange,
      symbol: decoded.symbol,
      providerTimestamp,
      receivedAt,
      sessionDate,
      quoteTime: time,
      timestampDateSource: "provider-local-date",
      depth: "top_of_book",
      asks: [{ level: 1, price: askPrice, quantity: askQuantity }],
      bids: [{ level: 1, price: bidPrice, quantity: bidQuantity }],
      totalAskQuantity,
      totalBidQuantity,
    });
  }

  private parseOrderbook(trId: KisOrderbookTrId, values: string[]): void {
    const symbol = stringValue(values[0]);
    const time = stringValue(values[1]);
    const market = marketForTrId(trId)!;
    const totalAskQuantity = finiteNumber(values[43]);
    const totalBidQuantity = finiteNumber(values[44]);
    const asks: KisOrderbookLevel[] = [];
    const bids: KisOrderbookLevel[] = [];
    const invalid: string[] = [];
    for (let offset = 0; offset < 10; offset += 1) {
      this.parseOrderbookLevel(values[3 + offset], values[23 + offset], offset + 1, "ask", asks, invalid);
      this.parseOrderbookLevel(values[13 + offset], values[33 + offset], offset + 1, "bid", bids, invalid);
    }
    if (!/^[A-Za-z0-9]{1,12}$/.test(symbol)) invalid.push("symbol");
    if (!isCompactTime(time)) invalid.push("time");
    if (totalAskQuantity === undefined || totalAskQuantity < 0) invalid.push("totalAskQuantity");
    if (totalBidQuantity === undefined || totalBidQuantity < 0) invalid.push("totalBidQuantity");
    if (asks.length === 0 && bids.length === 0) invalid.push("levels");
    if (invalid.length > 0 || totalAskQuantity === undefined || totalBidQuantity === undefined) {
      this.emitParseError(
        `KIS orderbook record was excluded because fields were invalid: ${Array.from(new Set(invalid)).join(", ")}.`,
        trId,
        market,
        symbol || undefined,
      );
      return;
    }
    const sessionDate = seoulCompactDate(this.now());
    const receivedAt = nowIso(this.now);
    this.emit({
      type: "orderbook",
      trId,
      market,
      marketCountry: "KR",
      symbol,
      providerTimestamp: compactTimestamp(sessionDate, time),
      receivedAt,
      sessionDate,
      quoteTime: time,
      timestampDateSource: "received-session-date",
      depth: "ten_level",
      asks,
      bids,
      totalAskQuantity,
      totalBidQuantity,
    });
  }

  private parseOrderbookLevel(
    rawPrice: string,
    rawQuantity: string,
    level: number,
    side: "ask" | "bid",
    target: KisOrderbookLevel[],
    invalid: string[],
  ): void {
    const price = optionalFiniteNumber(rawPrice);
    const quantity = optionalFiniteNumber(rawQuantity);
    if (price === undefined && quantity === undefined) return;
    if (price === 0 && quantity === 0) return;
    if (price === undefined || price <= 0 || quantity === undefined || quantity < 0) {
      invalid.push(`${side}${level}`);
      return;
    }
    target.push({ level, price, quantity });
  }

  private emitParseError(
    reason: string,
    trId?: string,
    market?: KisMarketSource,
    symbol?: string,
  ): void {
    this.emit({
      type: "parse_error",
      providerTimestamp: nowIso(this.now),
      reason,
      ...(trId ? { trId } : {}),
      ...(market ? { market } : {}),
      ...(symbol ? { symbol } : {}),
    });
  }

  private redact(message: string): string {
    return message
      .replaceAll(this.config.appKey, "[redacted]")
      .replaceAll(this.config.appSecret, "[redacted]");
  }
}
