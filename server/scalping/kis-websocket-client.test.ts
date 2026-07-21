import { describe, expect, it, vi } from "vitest";
import {
  KisWebSocketClient,
  KisWebSocketError,
  KisWebSocketValidationError,
  type KisExecutionTrId,
  type KisMarketTrId,
  type KisOrderbookTrId,
  type KisWebSocketConfig,
  type KisWebSocketEvent,
  type WebSocketEventName,
  type WebSocketLike,
  type WebSocketListener,
} from "./kis-websocket-client.js";

const INITIAL_NOW = Date.parse("2026-07-21T10:15:30+09:00");

const config: KisWebSocketConfig = {
  appKey: "test-app-key",
  appSecret: "test-app-secret",
  environment: "demo",
  approvalTimeoutMs: 1_000,
  approvalMaxAttempts: 3,
  approvalRetryBaseMs: 100,
  approvalRetryMaxMs: 1_000,
  maxSubscriptions: 4,
  subscribeIntervalMs: 25,
  connectionTimeoutMs: 5_000,
  reconnectBaseMs: 100,
  reconnectMaxMs: 1_000,
  reconnectJitterRatio: 0,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

class TestClock {
  value = INITIAL_NOW;
  readonly tasks = new Map<number, { callback: () => void; milliseconds: number }>();
  private sequence = 0;

  readonly setTimeout = (callback: () => void, milliseconds: number): number => {
    const id = ++this.sequence;
    this.tasks.set(id, { callback, milliseconds });
    return id;
  };

  readonly clearTimeout = (handle: unknown): void => {
    this.tasks.delete(Number(handle));
  };

  runNext(): number | undefined {
    const next = Array.from(this.tasks.entries()).sort((left, right) => {
      const delay = left[1].milliseconds - right[1].milliseconds;
      return delay === 0 ? left[0] - right[0] : delay;
    })[0];
    if (!next) return undefined;
    const [id, task] = next;
    this.tasks.delete(id);
    this.value += task.milliseconds;
    task.callback();
    return task.milliseconds;
  }
}

class FakeWebSocket implements WebSocketLike {
  readyState = 0;
  readonly sent: string[] = [];
  readonly closes: Array<{ code?: number; reason?: string }> = [];
  private readonly listeners = new Map<WebSocketEventName, Set<WebSocketListener>>();

  addEventListener(type: WebSocketEventName, listener: WebSocketListener): void {
    const listeners = this.listeners.get(type) ?? new Set<WebSocketListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: WebSocketEventName, listener: WebSocketListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error("socket is not open");
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason });
    this.readyState = 3;
    this.emit("close", { code, reason });
  }

  open(): void {
    this.readyState = 1;
    this.emit("open", {});
  }

  message(data: string | Uint8Array): void {
    this.emit("message", { data });
  }

  serverClose(reason = "server closed"): void {
    this.readyState = 3;
    this.emit("close", { code: 1_006, reason });
  }

  serverError(): void {
    this.emit("error", {});
  }

  private emit(type: WebSocketEventName, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function executionValues(symbol = "005930"): string[] {
  const values = Array.from({ length: 46 }, () => "");
  values[0] = symbol;
  values[1] = "101530";
  values[2] = "73500";
  values[10] = "73600";
  values[11] = "73500";
  values[12] = "120";
  values[13] = "12345678";
  values[14] = "905000000000";
  values[18] = "112.45";
  values[21] = "1";
  values[33] = "20260721";
  values[35] = "N";
  return values;
}

function orderbookValues(symbol = "005930"): string[] {
  const values = Array.from({ length: 59 }, () => "");
  values[0] = symbol;
  values[1] = "101531";
  values[2] = "0";
  values[3] = "73600";
  values[13] = "73500";
  values[23] = "8500";
  values[33] = "9200";
  values[43] = "120000";
  values[44] = "135000";
  return values;
}

function overseasExecutionValues(symbol = "AAPL", exchange = "NAS"): string[] {
  const values = Array.from({ length: 26 }, () => "");
  values[0] = `D${exchange}${symbol}`;
  values[1] = symbol;
  values[2] = "4";
  values[3] = "20260721";
  values[4] = "20260721";
  values[5] = "101530";
  values[6] = "20260721";
  values[7] = "231530";
  values[8] = "210.00";
  values[9] = "213.00";
  values[10] = "209.00";
  values[11] = "212.50";
  values[15] = "212.49";
  values[16] = "212.51";
  values[17] = "100";
  values[18] = "120";
  values[19] = "25";
  values[20] = "1234567";
  values[21] = "262345678.90";
  values[22] = "11";
  values[23] = "14";
  values[24] = "108.75";
  values[25] = "1";
  return values;
}

function overseasOrderbookValues(symbol = "AAPL", exchange = "NAS"): string[] {
  const values = Array.from({ length: 17 }, () => "");
  values[0] = `D${exchange}${symbol}`;
  values[1] = symbol;
  values[2] = "4";
  values[3] = "20260721";
  values[4] = "101531";
  values[5] = "20260721";
  values[6] = "231531";
  values[7] = "5000";
  values[8] = "4500";
  values[11] = "212.49";
  values[12] = "212.51";
  values[13] = "100";
  values[14] = "120";
  values[15] = "10";
  values[16] = "-5";
  return values;
}

function dataFrame(trId: KisMarketTrId, values: string[], count = 1): string {
  return `0|${trId}|${count}|${values.join("^")}`;
}

function testHarness(overrides: {
  config?: Partial<KisWebSocketConfig>;
  fetchImpl?: typeof fetch;
} = {}) {
  const clock = new TestClock();
  const sockets: FakeWebSocket[] = [];
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = overrides.fetchImpl ?? (vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), init });
    return json({ approval_key: "approval-key" });
  }) as unknown as typeof fetch);
  const client = new KisWebSocketClient({ ...config, ...overrides.config }, {
    fetchImpl,
    webSocketFactory: () => {
      const socket = new FakeWebSocket();
      sockets.push(socket);
      return socket;
    },
    sleepImpl: vi.fn().mockResolvedValue(undefined),
    now: () => clock.value,
    random: () => 0.5,
    setTimeoutImpl: clock.setTimeout,
    clearTimeoutImpl: clock.clearTimeout,
  });
  const events: KisWebSocketEvent[] = [];
  client.onEvent((event) => events.push(event));
  return { client, clock, sockets, events, requests, fetchImpl };
}

describe("KisWebSocketClient", () => {
  it("validates configured limits instead of assuming a provider subscription count", () => {
    expect(() => testHarness({ config: { maxSubscriptions: 0 } })).toThrow(KisWebSocketValidationError);
    expect(() => testHarness({ config: { subscribeIntervalMs: 0 } })).toThrow("subscribeIntervalMs");
    expect(() => testHarness({ config: { reconnectBaseMs: 2_000, reconnectMaxMs: 1_000 } })).toThrow("reconnectMaxMs");
    expect(() => testHarness({ config: { reconnectJitterRatio: 1.1 } })).toThrow("reconnectJitterRatio");

    const { client } = testHarness({ config: { maxSubscriptions: 1 } });
    expect(client.subscribe({ trId: "H0STCNT0", symbol: "005930" })).toBe(true);
    expect(() => client.subscribe({ trId: "H0STASP0", symbol: "005930" })).toThrow("capacity (1)");
  });

  it("gets an approval key, paces subscribe/unsubscribe frames, acknowledges subscriptions, and echoes PINGPONG", async () => {
    const { client, clock, sockets, events, requests } = testHarness();
    client.subscribe({ trId: "H0STCNT0", symbol: "005930" });
    client.subscribe({ trId: "H0STASP0", symbol: "005930" });

    await Promise.all([client.connect(), client.connect()]);
    expect(sockets).toHaveLength(1);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toContain("/oauth2/Approval");
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      grant_type: "client_credentials",
      appkey: config.appKey,
      secretkey: config.appSecret,
    });

    const socket = sockets[0]!;
    socket.open();
    expect(client.connectionState).toBe("connected");
    expect(socket.sent).toHaveLength(1);
    expect(JSON.parse(socket.sent[0]!)).toMatchObject({
      header: { approval_key: "approval-key", tr_type: "1" },
      body: { input: { tr_id: "H0STCNT0", tr_key: "005930" } },
    });
    expect(clock.runNext()).toBe(25);
    expect(socket.sent).toHaveLength(2);

    socket.message(JSON.stringify({
      header: { tr_id: "H0STCNT0", tr_key: "005930", datetime: "20260721101531" },
      body: { rt_cd: "0", msg_cd: "OPSP0000", msg1: "SUBSCRIBE SUCCESS" },
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "subscription",
      trId: "H0STCNT0",
      symbol: "005930",
      market: "KRX",
      action: "subscribe",
      accepted: true,
      providerTimestamp: "2026-07-21T10:15:31+09:00",
    }));

    const ping = JSON.stringify({ header: { tr_id: "PINGPONG", datetime: "20260721101532" } });
    socket.message(ping);
    expect(socket.sent.at(-1)).toBe(ping);
    expect(events).toContainEqual({
      type: "ping",
      trId: "PINGPONG",
      providerTimestamp: "2026-07-21T10:15:32+09:00",
    });

    expect(client.unsubscribe({ trId: "H0STCNT0", symbol: "005930" })).toBe(true);
    expect(clock.runNext()).toBe(25);
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
      header: { tr_type: "2" },
      body: { input: { tr_id: "H0STCNT0", tr_key: "005930" } },
    });
  });

  it("parses KRX, NXT, and integrated execution frames with provider timestamps", async () => {
    const { client, sockets, events } = testHarness();
    await client.connect();
    const socket = sockets[0]!;
    socket.open();

    const trIds: KisExecutionTrId[] = ["H0STCNT0", "H0NXCNT0", "H0UNCNT0"];
    for (const trId of trIds) socket.message(dataFrame(trId, executionValues()));

    const executions = events.filter((event) => event.type === "execution");
    expect(executions).toHaveLength(3);
    expect(executions.map(({ market }) => market)).toEqual(["KRX", "NXT", "INTEGRATED"]);
    expect(executions[0]).toMatchObject({
      type: "execution",
      trId: "H0STCNT0",
      symbol: "005930",
      eventId: "kis:H0STCNT0:005930:20260721:101530:12345678:73500:120",
      providerTimestamp: "2026-07-21T10:15:30+09:00",
      price: 73_500,
      executionVolume: 120,
      accumulatedVolume: 12_345_678,
      accumulatedTradingAmount: 905_000_000_000,
      askPrice1: 73_600,
      bidPrice1: 73_500,
      executionStrength: 112.45,
      tradingHalted: false,
    });
  });

  it("parses KRX, NXT, and integrated ten-level orderbook frame layouts without fabricating empty levels", async () => {
    const { client, sockets, events } = testHarness();
    await client.connect();
    const socket = sockets[0]!;
    socket.open();

    const trIds: KisOrderbookTrId[] = ["H0STASP0", "H0NXASP0", "H0UNASP0"];
    for (const trId of trIds) socket.message(dataFrame(trId, orderbookValues()));

    const orderbooks = events.filter((event) => event.type === "orderbook");
    expect(orderbooks).toHaveLength(3);
    expect(orderbooks.map(({ market }) => market)).toEqual(["KRX", "NXT", "INTEGRATED"]);
    expect(orderbooks[0]).toMatchObject({
      type: "orderbook",
      symbol: "005930",
      providerTimestamp: "2026-07-21T10:15:31+09:00",
      timestampDateSource: "received-session-date",
      asks: [{ level: 1, price: 73_600, quantity: 8_500 }],
      bids: [{ level: 1, price: 73_500, quantity: 9_200 }],
      totalAskQuantity: 120_000,
      totalBidQuantity: 135_000,
    });
  });

  it("uses explicit US exchange subscription keys and parses official 26/17-field US raw frames", async () => {
    const { client, sockets, events } = testHarness();
    client.subscribe({ trId: "HDFSCNT0", symbol: "AAPL", exchange: "NAS" });
    client.subscribe({ trId: "HDFSASP0", symbol: "AAPL", exchange: "NAS" });
    await client.connect();
    const socket = sockets[0]!;
    socket.open();
    expect(JSON.parse(socket.sent[0]!)).toMatchObject({
      body: { input: { tr_id: "HDFSCNT0", tr_key: "DNASAAPL" } },
    });

    socket.message(dataFrame("HDFSCNT0", overseasExecutionValues()));
    socket.message(dataFrame("HDFSASP0", overseasOrderbookValues()));

    expect(events).toContainEqual(expect.objectContaining({
      type: "execution",
      trId: "HDFSCNT0",
      market: "US",
      marketCountry: "US",
      exchange: "NAS",
      symbol: "AAPL",
      providerTimestamp: "2026-07-21T14:15:30.000Z",
      price: 212.5,
      executionVolume: 25,
      accumulatedVolume: 1_234_567,
      accumulatedTradingAmount: 262_345_678.9,
      bidPrice1: 212.49,
      askPrice1: 212.51,
      executionStrength: 108.75,
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "orderbook",
      trId: "HDFSASP0",
      marketCountry: "US",
      exchange: "NAS",
      symbol: "AAPL",
      providerTimestamp: "2026-07-21T14:15:31.000Z",
      timestampDateSource: "provider-local-date",
      depth: "top_of_book",
      bids: [{ level: 1, price: 212.49, quantity: 100 }],
      asks: [{ level: 1, price: 212.51, quantity: 120 }],
      totalBidQuantity: 5_000,
      totalAskQuantity: 4_500,
    }));
  });

  it("rejects US subscriptions without an exchange instead of guessing NASDAQ", () => {
    const { client } = testHarness();
    expect(() => client.subscribe({ trId: "HDFSCNT0", symbol: "AAPL" }))
      .toThrow("require exchange NAS, NYS, or AMS");
  });

  it("emits parser diagnostics with TR, market, symbol and time instead of zero-filling malformed records", async () => {
    const { client, sockets, events } = testHarness();
    await client.connect();
    const socket = sockets[0]!;
    socket.open();
    const malformed = executionValues();
    malformed[2] = "not-a-price";

    socket.message(dataFrame("H0NXCNT0", malformed));
    socket.message("0|UNKNOWN|1|bad");

    expect(events.filter((event) => event.type === "execution")).toHaveLength(0);
    expect(events).toContainEqual(expect.objectContaining({
      type: "parse_error",
      trId: "H0NXCNT0",
      market: "NXT",
      symbol: "005930",
      providerTimestamp: new Date(INITIAL_NOW).toISOString(),
      reason: expect.stringContaining("price"),
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "parse_error",
      trId: "UNKNOWN",
      reason: "Unknown KIS market-data TR ID.",
    }));
  });

  it("reconnects with configured backoff, resubscribes, and ignores stale socket generations", async () => {
    const { client, clock, sockets, events } = testHarness();
    client.subscribe({ trId: "H0UNCNT0", symbol: "005930" });
    await client.connect();
    const first = sockets[0]!;
    first.open();
    expect(first.sent).toHaveLength(1);

    first.serverClose("transient disconnect");
    expect(client.connectionState).toBe("reconnecting");
    const reconnectEvent = events.findLast((event) => event.type === "connection" && event.state === "reconnecting");
    expect(reconnectEvent).toMatchObject({ retryInMs: 100, reason: "transient disconnect" });
    expect(clock.runNext()).toBe(100);
    await Promise.resolve();
    await Promise.resolve();
    expect(sockets).toHaveLength(2);

    const staleEventCount = events.filter((event) => event.type === "execution").length;
    first.message(dataFrame("H0UNCNT0", executionValues()));
    expect(events.filter((event) => event.type === "execution")).toHaveLength(staleEventCount);

    const second = sockets[1]!;
    second.open();
    expect(second.sent).toHaveLength(1);
    second.message(dataFrame("H0UNCNT0", executionValues()));
    expect(events).toContainEqual(expect.objectContaining({
      type: "execution",
      market: "INTEGRATED",
      symbol: "005930",
    }));
  });

  it("retries approval with configured delays and never includes credentials in normalized errors", async () => {
    let attempts = 0;
    const fetchImpl = vi.fn(async () => {
      attempts += 1;
      if (attempts < 3) return json({ error_code: "EGW00201", error_description: "rate limited" }, 429);
      return json({ approval_key: "approval-key" });
    }) as unknown as typeof fetch;
    const clock = new TestClock();
    const sleeps: number[] = [];
    const sockets: FakeWebSocket[] = [];
    const client = new KisWebSocketClient(config, {
      fetchImpl,
      webSocketFactory: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
      sleepImpl: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
      now: () => clock.value,
      setTimeoutImpl: clock.setTimeout,
      clearTimeoutImpl: clock.clearTimeout,
    });

    await client.connect();
    expect(attempts).toBe(3);
    expect(sleeps).toEqual([100, 200]);
    expect(sockets).toHaveLength(1);

    const failing = new KisWebSocketClient({ ...config, approvalMaxAttempts: 1 }, {
      fetchImpl: vi.fn(async () => {
        throw new Error(`${config.appKey}/${config.appSecret}`);
      }) as unknown as typeof fetch,
      webSocketFactory: () => new FakeWebSocket(),
      now: () => clock.value,
      setTimeoutImpl: clock.setTimeout,
      clearTimeoutImpl: clock.clearTimeout,
    });
    const error = await failing.connect().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(KisWebSocketError);
    expect(String(error)).not.toContain(config.appKey);
    expect(String(error)).not.toContain(config.appSecret);
    failing.disconnect();
  });

  it("stops reconnect timers and rejects late events after an explicit disconnect", async () => {
    const { client, clock, sockets, events } = testHarness();
    await client.connect();
    const socket = sockets[0]!;
    socket.open();
    socket.serverClose();
    expect(clock.tasks.size).toBeGreaterThan(0);

    client.disconnect();
    expect(client.connectionState).toBe("closed");
    expect(clock.tasks.size).toBe(0);
    const before = events.length;
    socket.message(dataFrame("H0STCNT0", executionValues()));
    expect(events).toHaveLength(before);
  });
});
