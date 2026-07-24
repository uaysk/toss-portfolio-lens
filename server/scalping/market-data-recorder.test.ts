import { afterEach, describe, expect, it, vi } from "vitest";
import { MarketDataRecorder, type MarketDataRecorderConfig } from "./market-data-recorder.js";
import type { ScalpingLiveEvent } from "./live-runtime.js";

function config(overrides: Partial<MarketDataRecorderConfig> = {}): MarketDataRecorderConfig {
  return {
    instruments: [
      { symbol: "TSLA", exchange: "NAS" },
      { symbol: "SOXL", exchange: "AMS" },
    ],
    feedProfile: "standard",
    flushIntervalMs: 60_000,
    batchSize: 10,
    maximumQueueSize: 100,
    retryBaseMs: 10,
    retryMaxMs: 100,
    now: () => Date.parse("2026-07-24T14:00:00.500Z"),
    ...overrides,
  };
}

function tradeEvent(
  id = 1,
  symbol = "TSLA",
  marketCountry: "US" | "KR" = "US",
): ScalpingLiveEvent {
  return {
    schemaVersion: "scalping-live-event/v1",
    id,
    emittedAt: "2026-07-24T14:00:00.250Z",
    type: "trade",
    symbol,
    marketCountry,
    payload: {
      provider: "kis",
      symbol,
      market: marketCountry === "US" ? "US" : "KRX",
      exchange: marketCountry === "US" ? "NAS" : undefined,
      sessionFeed: marketCountry === "US" ? "standard" : undefined,
      sessionDate: "2026-07-24",
      eventId: `kis:HDFSCNT0:standard:NAS:${symbol}:${id}`,
      eventIdSource: "provider",
      executedAt: "2026-07-24T14:00:00.000Z",
      receivedAt: "2026-07-24T14:00:00.125Z",
      price: 220.25,
      quantity: 3,
      tradingAmount: 660.75,
      side: "unknown",
      cumulativeVolume: 1_234,
      cumulativeTradingAmount: 271_777,
      executionStrength: 108.5,
      executionClassCode: "1",
      bestBidPrice: 220.24,
      bestAskPrice: 220.26,
    },
  };
}

function orderbookEvent(symbol = "TSLA"): ScalpingLiveEvent {
  return {
    schemaVersion: "scalping-live-event/v1",
    id: 2,
    emittedAt: "2026-07-24T14:00:00.300Z",
    type: "orderbook",
    symbol,
    marketCountry: "US",
    payload: {
      provider: "kis",
      symbol,
      market: "US",
      exchange: symbol === "SOXL" ? "AMS" : "NAS",
      sessionFeed: "standard",
      sessionDate: "2026-07-24",
      observedAt: "2026-07-24T14:00:00.000Z",
      receivedAt: "2026-07-24T14:00:00.200Z",
      depth: "top_of_book",
      asks: [{ price: 220.26, quantity: 50 }],
      bids: [{ price: 220.24, quantity: 40 }],
      totalAskQuantity: 500,
      totalBidQuantity: 450,
    },
  };
}

function connectionEvent(
  id: number,
  state: "connected" | "reconnecting",
): ScalpingLiveEvent {
  return {
    schemaVersion: "scalping-live-event/v1",
    id,
    emittedAt: `2026-07-24T14:00:0${id}.000Z`,
    type: "connection",
    payload: {
      type: "connection",
      state,
      providerTimestamp: `2026-07-24T14:00:0${id}.000Z`,
      generation: 1,
      attempt: 0,
    },
  };
}

describe("MarketDataRecorder", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("retains explicit US standard feeds and batch-persists enriched trades and orderbooks", async () => {
    let listener: ((event: ScalpingLiveEvent) => void) | undefined;
    const release = vi.fn();
    const removeListener = vi.fn();
    const live = {
      onEvent: vi.fn((next: (event: ScalpingLiveEvent) => void) => {
        listener = next;
        return removeListener;
      }),
      retain: vi.fn().mockResolvedValue(release),
    };
    const store = {
      putTrades: vi.fn().mockResolvedValue(undefined),
      putOrderbooks: vi.fn().mockResolvedValue(undefined),
      putRecordingEvents: vi.fn().mockResolvedValue(undefined),
    };
    const recorder = new MarketDataRecorder(live as never, store as never, config());

    await recorder.start();
    expect(live.retain).toHaveBeenCalledWith(
      ["TSLA", "SOXL"],
      "US",
      { TSLA: "NAS", SOXL: "AMS" },
      { usFeedProfile: "standard" },
    );

    listener!(tradeEvent());
    listener!(orderbookEvent());
    await recorder.flushNow();

    expect(store.putTrades).toHaveBeenCalledWith([
      expect.objectContaining({
        marketCountry: "US",
        symbol: "TSLA",
        venue: "US",
        exchange: "NAS",
        sessionFeed: "standard",
        sessionDate: "2026-07-24",
        receivedAt: "2026-07-24T14:00:00.125Z",
        executionStrength: 108.5,
        cumulativeAmount: 271_777,
        bestBidPrice: 220.24,
        bestAskPrice: 220.26,
      }),
    ]);
    expect(store.putOrderbooks).toHaveBeenCalledWith([
      expect.objectContaining({
        snapshotId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        symbol: "TSLA",
        exchange: "NAS",
        depth: "top_of_book",
        bestAskPrice: 220.26,
        bestBidPrice: 220.24,
      }),
    ]);
    expect(recorder.status).toMatchObject({
      state: "running",
      counters: {
        receivedTrades: 1,
        receivedOrderbooks: 1,
        persistedTrades: 1,
        persistedOrderbooks: 1,
        droppedEvents: 0,
        pendingTrades: 0,
        pendingOrderbooks: 0,
      },
    });

    await recorder.close();
    expect(removeListener).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(recorder.status.state).toBe("stopped");
  });

  it("ignores other markets and unconfigured symbols, and bounds its in-memory queue", async () => {
    let listener: ((event: ScalpingLiveEvent) => void) | undefined;
    const live = {
      onEvent: vi.fn((next: (event: ScalpingLiveEvent) => void) => {
        listener = next;
        return vi.fn();
      }),
      retain: vi.fn().mockResolvedValue(vi.fn()),
    };
    const store = {
      putTrades: vi.fn().mockResolvedValue(undefined),
      putOrderbooks: vi.fn().mockResolvedValue(undefined),
      putRecordingEvents: vi.fn().mockResolvedValue(undefined),
    };
    const recorder = new MarketDataRecorder(
      live as never,
      store as never,
      config({ batchSize: 2, maximumQueueSize: 2 }),
    );
    await recorder.start();

    listener!(tradeEvent(1, "AAPL"));
    listener!(tradeEvent(2, "TSLA", "KR"));
    listener!(tradeEvent(3));
    listener!(orderbookEvent());
    listener!(tradeEvent(4));

    expect(recorder.status.counters).toMatchObject({
      receivedTrades: 2,
      receivedOrderbooks: 1,
      droppedEvents: 1,
    });
    await recorder.flushNow();
    expect(store.putTrades).toHaveBeenCalledTimes(1);
    expect(store.putOrderbooks).toHaveBeenCalledTimes(1);
    await recorder.close();
  });

  it("requeues a failed durable batch without reporting it as persisted", async () => {
    let listener: ((event: ScalpingLiveEvent) => void) | undefined;
    const live = {
      onEvent: vi.fn((next: (event: ScalpingLiveEvent) => void) => {
        listener = next;
        return vi.fn();
      }),
      retain: vi.fn().mockResolvedValue(vi.fn()),
    };
    const putTrades = vi.fn()
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValue(undefined);
    const store = {
      putTrades,
      putOrderbooks: vi.fn().mockResolvedValue(undefined),
      putRecordingEvents: vi.fn().mockResolvedValue(undefined),
    };
    const recorder = new MarketDataRecorder(live as never, store as never, config());
    await recorder.start();
    listener!(tradeEvent());

    await expect(recorder.flushNow()).rejects.toThrow("database unavailable");
    expect(recorder.status).toMatchObject({
      lastError: { code: "persistence_failed" },
      counters: { persistedTrades: 0, pendingTrades: 1 },
    });

    await recorder.flushNow();
    expect(recorder.status.counters).toMatchObject({ persistedTrades: 1, pendingTrades: 0 });
    await recorder.close();
  });

  it("filters shared day-feed traffic and rejects payload identity mismatches", async () => {
    let listener: ((event: ScalpingLiveEvent) => void) | undefined;
    const live = {
      onEvent: vi.fn((next: (event: ScalpingLiveEvent) => void) => {
        listener = next;
        return vi.fn();
      }),
      retain: vi.fn().mockResolvedValue(vi.fn()),
    };
    const store = {
      putTrades: vi.fn().mockResolvedValue(undefined),
      putOrderbooks: vi.fn().mockResolvedValue(undefined),
      putRecordingEvents: vi.fn().mockResolvedValue(undefined),
    };
    const recorder = new MarketDataRecorder(live as never, store as never, config());
    await recorder.start();

    const dayTrade = tradeEvent(10);
    dayTrade.payload = { ...(dayTrade.payload as object), sessionFeed: "day" };
    listener!(dayTrade);
    const wrongExchange = tradeEvent(11);
    wrongExchange.payload = { ...(wrongExchange.payload as object), exchange: "NYS" };
    listener!(wrongExchange);
    listener!(tradeEvent(12));
    await recorder.flushNow();

    expect(store.putTrades).toHaveBeenCalledOnce();
    expect(recorder.status.counters).toMatchObject({
      receivedTrades: 1,
      filteredDayEvents: 1,
      rejectedEvents: 1,
    });
    await recorder.close();
  });

  it("keeps in-flight records inside the queue bound and records connection gaps", async () => {
    let listener: ((event: ScalpingLiveEvent) => void) | undefined;
    let resolveTrade!: () => void;
    const blockedTrade = new Promise<void>((resolve) => {
      resolveTrade = resolve;
    });
    const live = {
      state: { connection: "connected", subscriptions: 4 },
      onEvent: vi.fn((next: (event: ScalpingLiveEvent) => void) => {
        listener = next;
        return vi.fn();
      }),
      retain: vi.fn().mockResolvedValue(vi.fn()),
    };
    const store = {
      putTrades: vi.fn().mockReturnValueOnce(blockedTrade).mockResolvedValue(undefined),
      putOrderbooks: vi.fn().mockResolvedValue(undefined),
      putRecordingEvents: vi.fn().mockResolvedValue(undefined),
    };
    const recorder = new MarketDataRecorder(
      live as never,
      store as never,
      config({ batchSize: 1, maximumQueueSize: 2 }),
    );
    await recorder.start();
    listener!(tradeEvent(20));
    const flushing = recorder.flushNow();
    await vi.waitFor(() => expect(store.putTrades).toHaveBeenCalledOnce());
    listener!(tradeEvent(21));
    listener!(tradeEvent(22));
    listener!(connectionEvent(3, "connected"));
    listener!(connectionEvent(4, "reconnecting"));

    expect(recorder.status).toMatchObject({
      provider: { connection: "connected", subscriptions: 4 },
      counters: {
        pendingTrades: 2,
        droppedEvents: 1,
      },
    });
    resolveTrade();
    await flushing;
    await recorder.waitForIdle();

    const operationalEvents = store.putRecordingEvents.mock.calls.flatMap(([records]) => records);
    expect(operationalEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventType: "queue_overflow", code: "raw_queue_full" }),
      expect.objectContaining({ eventType: "connection_state", code: "reconnecting" }),
      expect.objectContaining({
        eventType: "data_gap",
        symbol: "TSLA",
        code: "connection_reconnecting",
      }),
      expect.objectContaining({
        eventType: "data_gap",
        symbol: "SOXL",
        code: "connection_reconnecting",
      }),
    ]));
    expect(recorder.status.counters.pendingTrades).toBe(0);
    await recorder.close();
  });

  it("retries a transient persistence failure while closing", async () => {
    let listener: ((event: ScalpingLiveEvent) => void) | undefined;
    const live = {
      onEvent: vi.fn((next: (event: ScalpingLiveEvent) => void) => {
        listener = next;
        return vi.fn();
      }),
      retain: vi.fn().mockResolvedValue(vi.fn()),
    };
    const putTrades = vi.fn()
      .mockRejectedValueOnce(new Error("temporary database outage"))
      .mockResolvedValue(undefined);
    const store = {
      putTrades,
      putOrderbooks: vi.fn().mockResolvedValue(undefined),
      putRecordingEvents: vi.fn().mockResolvedValue(undefined),
    };
    const recorder = new MarketDataRecorder(
      live as never,
      store as never,
      config({ retryBaseMs: 1, retryMaxMs: 2, closeTimeoutMs: 100 }),
    );
    await recorder.start();
    listener!(tradeEvent(30));

    await recorder.close();

    expect(putTrades).toHaveBeenCalledTimes(2);
    expect(recorder.status).toMatchObject({
      state: "stopped",
      counters: { pendingTrades: 0, pendingRecordingEvents: 0 },
    });
  });
});
