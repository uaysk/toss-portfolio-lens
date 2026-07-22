import { afterEach, describe, expect, it, vi } from "vitest";
import type { IntradayBarRecord } from "../repositories/scalping-repository.js";
import type { KisWebSocketEvent, KisSubscription } from "./kis-websocket-client.js";
import {
  aggregateRecoveredBars,
  mergeRecoveredSessionCloseRows,
  ScalpingLiveRuntime,
} from "./live-runtime.js";
import { DEFAULT_KR_INTEGRATED_SESSION_WINDOWS } from "./market-session.js";

function minute(input: Partial<IntradayBarRecord> & Pick<IntradayBarRecord, "openTime" | "open" | "high" | "low" | "close" | "volume">): IntradayBarRecord {
  return {
    symbol: "005930",
    intervalMinutes: 1,
    closeTime: new Date(Date.parse(input.openTime) + 60_000).toISOString(),
    sessionDate: "2026-07-21",
    source: "kis_rest",
    state: "final",
    quality: "recovered",
    updatedAt: 1,
    ...input,
  };
}

function recoveryPage(localTimes: readonly string[]) {
  return {
    items: localTimes.map((timestamp, index) => ({
      symbol: "005930",
      sessionDate: "20260721",
      timestamp,
      open: 100 + index,
      high: 102 + index,
      low: 99 + index,
      close: 101 + index,
      volume: 10,
      status: "final" as const,
      source: "kis_rest_recovery" as const,
    })),
    quality: "available" as const,
    diagnostics: [],
    providerTimestamp: "2026-07-21T01:01:00.000Z",
  };
}

class FakeSocket {
  connectionState = "idle" as const | "connected";
  readonly subscriptions = new Map<string, KisSubscription>();
  private readonly listeners = new Set<(event: KisWebSocketEvent) => void>();

  get subscriptionCount() { return this.subscriptions.size; }

  onEvent(listener: (event: KisWebSocketEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribe(subscription: KisSubscription) {
    const key = `${subscription.trId}:${subscription.exchange ?? ""}:${subscription.usFeed ?? "standard"}:${subscription.symbol}`;
    if (this.subscriptions.has(key)) return false;
    this.subscriptions.set(key, subscription);
    return true;
  }

  unsubscribe(subscription: KisSubscription) {
    return this.subscriptions.delete(`${subscription.trId}:${subscription.exchange ?? ""}:${subscription.usFeed ?? "standard"}:${subscription.symbol}`);
  }

  async connect() { this.connectionState = "connected"; }
  disconnect() { this.connectionState = "idle"; }

  emit(event: KisWebSocketEvent) {
    for (const listener of this.listeners) listener(event);
  }
}

describe("aggregateRecoveredBars", () => {
  it("preserves OHLCV order and marks missing component minutes partial", () => {
    const bars = [
      minute({ openTime: "2026-07-21T00:00:00.000Z", open: 100, high: 103, low: 99, close: 102, volume: 10 }),
      minute({ openTime: "2026-07-21T00:01:00.000Z", open: 102, high: 104, low: 101, close: 103, volume: 20 }),
      minute({ openTime: "2026-07-21T00:02:00.000Z", open: 103, high: 105, low: 100, close: 101, volume: 30 }),
      minute({ openTime: "2026-07-21T00:03:00.000Z", open: 101, high: 102, low: 98, close: 99, volume: 40 }),
      minute({ openTime: "2026-07-21T00:04:00.000Z", open: 99, high: 101, low: 97, close: 100, volume: 50 }),
    ];
    const [bar] = aggregateRecoveredBars(bars, 5);
    expect(bar).toMatchObject({
      intervalMinutes: 5,
      state: "final",
      open: 100,
      high: 105,
      low: 97,
      close: 100,
      volume: 150,
      quality: "recovered",
    });
    expect(aggregateRecoveredBars(bars.slice(0, 4), 5)[0]).toMatchObject({ state: "forming", quality: "partial" });
  });

  it("anchors US 60-minute recovery bars at the 09:30 New York regular-session open", () => {
    const bars = Array.from({ length: 60 }, (_, index) => minute({
      symbol: "AAPL",
      sessionDate: "2026-07-21",
      openTime: new Date(Date.parse("2026-07-21T13:30:00.000Z") + index * 60_000).toISOString(),
      open: 100 + index,
      high: 101 + index,
      low: 99 + index,
      close: 100.5 + index,
      volume: 1,
    }));
    const result = aggregateRecoveredBars(bars, 60, { sessionStartAt: "2026-07-21T13:30:00.000Z" });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      openTime: "2026-07-21T13:30:00.000Z",
      closeTime: "2026-07-21T14:30:00.000Z",
      state: "final",
      quality: "recovered",
      volume: 60,
    });
  });

  it("re-anchors NXT after-market bars at 15:40 and excludes the 15:30-15:39 break", () => {
    const date = "2026-07-21";
    const source = Array.from({ length: 40 }, (_, index) => minute({
      openTime: `2026-07-21T${index < 15 ? "15" : "15"}:${String(15 + index).padStart(2, "0")}:00+09:00`,
      open: 100 + index,
      high: 101 + index,
      low: 99 + index,
      close: 100.5 + index,
      volume: 10,
      sessionDate: date,
    }));
    const aggregated = aggregateRecoveredBars(source, 15, {
      krSessionWindows: DEFAULT_KR_INTEGRATED_SESSION_WINDOWS,
    });
    expect(aggregated.map(({ openTime, closeTime, state }) => ({ openTime, closeTime, state }))).toEqual([
      { openTime: "2026-07-21T06:15:00.000Z", closeTime: "2026-07-21T06:30:00.000Z", state: "final" },
      { openTime: "2026-07-21T06:40:00.000Z", closeTime: "2026-07-21T06:55:00.000Z", state: "final" },
    ]);
    expect(aggregated.some(({ openTime }) => openTime === "2026-07-21T06:30:00.000Z")).toBe(false);
  });

  it("clamps scheduled KR and US higher-interval tails to their session closes", () => {
    const krRegular = [
      ...Array.from({ length: 60 }, (_, index) => minute({
        openTime: new Date(Date.parse("2026-07-21T14:00:00+09:00") + index * 60_000).toISOString(),
        open: 100, high: 101, low: 99, close: 100, volume: 1,
      })),
      ...Array.from({ length: 30 }, (_, index) => minute({
        openTime: new Date(Date.parse("2026-07-21T15:00:00+09:00") + index * 60_000).toISOString(),
        open: 100, high: 101, low: 99, close: 100, volume: 1,
      })),
    ];
    expect(aggregateRecoveredBars(krRegular, 60, {
      sessionWindows: DEFAULT_KR_INTEGRATED_SESSION_WINDOWS,
    }).map(({ openTime, closeTime, state, quality }) => ({ openTime, closeTime, state, quality }))).toEqual([
      {
        openTime: "2026-07-21T05:00:00.000Z",
        closeTime: "2026-07-21T06:00:00.000Z",
        state: "final",
        quality: "recovered",
      },
      {
        openTime: "2026-07-21T06:00:00.000Z",
        closeTime: "2026-07-21T06:30:00.000Z",
        state: "final",
        quality: "partial",
      },
    ]);

    const krPreTail = Array.from({ length: 50 }, (_, index) => minute({
      openTime: new Date(Date.parse("2026-07-21T08:00:00+09:00") + index * 60_000).toISOString(),
      open: 100, high: 101, low: 99, close: 100, volume: 1,
    }));
    expect(aggregateRecoveredBars(krPreTail, 60, {
      sessionWindows: DEFAULT_KR_INTEGRATED_SESSION_WINDOWS,
    })).toEqual([
      expect.objectContaining({
        openTime: "2026-07-20T23:00:00.000Z",
        closeTime: "2026-07-20T23:50:00.000Z",
        state: "final",
        quality: "partial",
      }),
    ]);

    const krAfterTail = Array.from({ length: 20 }, (_, index) => minute({
      openTime: new Date(Date.parse("2026-07-21T19:40:00+09:00") + index * 60_000).toISOString(),
      open: 100, high: 101, low: 99, close: 100, volume: 1,
    }));
    expect(aggregateRecoveredBars(krAfterTail, 60, {
      sessionWindows: DEFAULT_KR_INTEGRATED_SESSION_WINDOWS,
    })).toEqual([
      expect.objectContaining({
        openTime: "2026-07-21T10:40:00.000Z",
        closeTime: "2026-07-21T11:00:00.000Z",
        state: "final",
        quality: "partial",
      }),
    ]);

    const usTail = Array.from({ length: 30 }, (_, index) => minute({
      marketCountry: "US",
      symbol: "AAPL",
      openTime: new Date(Date.parse("2026-07-21T19:30:00.000Z") + index * 60_000).toISOString(),
      open: 200, high: 201, low: 199, close: 200, volume: 1,
    }));
    expect(aggregateRecoveredBars(usTail, 60, {
      sessionWindows: [{ kind: "regular_market", openMinute: 570, closeMinute: 960 }],
    })).toEqual([
      expect.objectContaining({
        openTime: "2026-07-21T19:30:00.000Z",
        closeTime: "2026-07-21T20:00:00.000Z",
        state: "final",
        quality: "partial",
      }),
    ]);
  });

  it("does not promote stale source minutes to recovered higher-interval quality", () => {
    const bars = Array.from({ length: 5 }, (_, index) => minute({
      openTime: new Date(Date.parse("2026-07-21T00:00:00.000Z") + index * 60_000).toISOString(),
      open: 100 + index,
      high: 101 + index,
      low: 99 + index,
      close: 100.5 + index,
      volume: 1,
      ...(index === 2 ? { quality: "stale" as const } : {}),
    }));
    expect(aggregateRecoveredBars(bars, 5)[0]).toMatchObject({
      state: "final",
      quality: "partial",
    });
  });
});

describe("mergeRecoveredSessionCloseRows", () => {
  it.each([
    ["KR pre close", "KR" as const, "005930", "2026-07-21T08:50:00+09:00", DEFAULT_KR_INTEGRATED_SESSION_WINDOWS],
    ["KR regular close", "KR" as const, "005930", "2026-07-21T15:30:00+09:00", DEFAULT_KR_INTEGRATED_SESSION_WINDOWS],
    ["KR after close", "KR" as const, "005930", "2026-07-21T20:00:00+09:00", DEFAULT_KR_INTEGRATED_SESSION_WINDOWS],
    ["US regular close", "US" as const, "AAPL", "2026-07-21T20:00:00.000Z", [
      { kind: "regular_market" as const, openMinute: 570, closeMinute: 960 },
    ]],
  ])("merges an exact %s auction row into its prior minute", (_label, marketCountry, symbol, boundaryAt, windows) => {
    const boundaryMs = Date.parse(boundaryAt);
    const prior = minute({
      marketCountry,
      symbol,
      openTime: new Date(boundaryMs - 60_000).toISOString(),
      closeTime: new Date(boundaryMs).toISOString(),
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: 0,
      turnover: 0,
    });
    const boundary = minute({
      marketCountry,
      symbol,
      openTime: new Date(boundaryMs).toISOString(),
      closeTime: new Date(boundaryMs + 60_000).toISOString(),
      open: 102,
      high: 105,
      low: 98,
      close: 104,
      volume: 1_829_148,
      turnover: 123_456,
      state: "forming",
      quality: "partial",
    });
    expect(mergeRecoveredSessionCloseRows([boundary], [prior], marketCountry, windows)).toEqual([
      expect.objectContaining({
        marketCountry,
        symbol,
        openTime: prior.openTime,
        closeTime: new Date(boundaryMs).toISOString(),
        state: "final",
        open: 100,
        high: 105,
        low: 98,
        close: 104,
        volume: 1_829_148,
        turnover: 123_456,
        quality: "recovered",
      }),
    ]);
  });

  it("preserves an exact close auction as a partial prior-minute bar when the prior row is absent", () => {
    const boundary = minute({
      openTime: "2026-07-21T06:30:00.000Z",
      closeTime: "2026-07-21T06:31:00.000Z",
      open: 102, high: 105, low: 98, close: 104, volume: 10,
      state: "forming", quality: "partial",
    });
    expect(mergeRecoveredSessionCloseRows(
      [boundary], [], "KR", DEFAULT_KR_INTEGRATED_SESSION_WINDOWS,
    )).toEqual([
      expect.objectContaining({
        openTime: "2026-07-21T06:29:00.000Z",
        closeTime: "2026-07-21T06:30:00.000Z",
        state: "final",
        quality: "partial",
        volume: 10,
      }),
    ]);
  });

  it("does not double-add a boundary-only REST row and marks an unverifiable WS minute partial", () => {
    const prior = minute({
      openTime: "2026-07-21T06:29:00.000Z",
      closeTime: "2026-07-21T06:30:00.000Z",
      source: "kis_ws",
      open: 100, high: 110, low: 99, close: 108,
      volume: 2_000_000, turnover: 216_000_000, tradeCount: 1_000,
      quality: "complete",
    });
    const restBoundary = minute({
      openTime: "2026-07-21T06:30:00.000Z",
      closeTime: "2026-07-21T06:31:00.000Z",
      source: "kis_rest",
      open: 108, high: 108, low: 108, close: 108,
      volume: 1_829_148, turnover: 197_547_984, state: "forming", quality: "partial",
    });
    expect(mergeRecoveredSessionCloseRows(
      [restBoundary], [prior], "KR", DEFAULT_KR_INTEGRATED_SESSION_WINDOWS,
    )).toEqual([
      expect.objectContaining({
        source: "kis_ws",
        openTime: prior.openTime,
        closeTime: prior.closeTime,
        state: "final",
        close: 108,
        volume: 2_000_000,
        turnover: 216_000_000,
        tradeCount: 1_000,
        quality: "partial",
      }),
    ]);
  });

  it.each(["complete", "partial"] as const)(
    "replaces a %s WS bucket with the complete REST minute before merging the close-auction row",
    (wsQuality) => {
    const wsPrior = minute({
      openTime: "2026-07-21T06:29:00.000Z",
      closeTime: "2026-07-21T06:30:00.000Z",
      source: "kis_ws",
      open: 100, high: 110, low: 99, close: 108,
      volume: 2_000_000, turnover: 216_000_000, tradeCount: 1_000,
      quality: wsQuality,
    });
    const rawPrior = minute({
      openTime: wsPrior.openTime,
      closeTime: wsPrior.closeTime,
      source: "kis_rest",
      open: 100, high: 101, low: 99, close: 100,
      volume: 0, turnover: 0, quality: "recovered",
    });
    const restBoundary = minute({
      openTime: "2026-07-21T06:30:00.000Z",
      closeTime: "2026-07-21T06:31:00.000Z",
      source: "kis_rest",
      open: 108, high: 108, low: 108, close: 108,
      volume: 1_829_148, turnover: 197_547_984, state: "forming", quality: "partial",
    });
    expect(mergeRecoveredSessionCloseRows(
      [rawPrior, restBoundary], [wsPrior], "KR", DEFAULT_KR_INTEGRATED_SESSION_WINDOWS,
    )).toEqual([
      expect.objectContaining({
        source: "recovered",
        openTime: wsPrior.openTime,
        state: "final",
        close: 108,
        volume: 1_829_148,
        turnover: 197_547_984,
        quality: "recovered",
      }),
    ]);
    },
  );
});

describe("ScalpingLiveRuntime", () => {
  afterEach(() => vi.useRealTimers());

  it("reference-counts two provider subscriptions per symbol", async () => {
    const socket = new FakeSocket();
    const runtime = new ScalpingLiveRuntime(socket as never, { getCurrentDayMinutes: vi.fn().mockRejectedValue(new Error("offline")) }, {
      ingest: vi.fn(), advanceWatermark: vi.fn(), recentFinalBars: vi.fn(),
    } as never, { putBars: vi.fn(), listBars: vi.fn() } as never, {
      replayEventLimit: 10,
      disconnectWhenIdle: true,
      watermarkAdvanceMs: 60_000,
      recoveryMaximumRequests: 3,
      recoveryBarLimit: 500,
      now: () => Date.parse("2026-07-21T01:00:00.000Z"),
    });
    const first = await runtime.retain(["005930"]);
    const second = await runtime.retain(["005930"]);
    expect(socket.subscriptionCount).toBe(2);
    first();
    expect(socket.subscriptionCount).toBe(2);
    second();
    expect(socket.subscriptionCount).toBe(0);
    expect(runtime.state.connection).toBe("idle");
    runtime.close();
  });

  it("requires explicit US exchanges and creates HDFS subscriptions without guessing", async () => {
    const socket = new FakeSocket();
    const runtime = new ScalpingLiveRuntime(socket as never, {
      getCurrentDayMinutes: vi.fn(), getOverseasMinutes: vi.fn().mockRejectedValue(new Error("offline")),
    } as never, {
      ingest: vi.fn(), advanceWatermark: vi.fn(), recentFinalBars: vi.fn(),
    } as never, { putBars: vi.fn(), listBars: vi.fn() } as never, {
      replayEventLimit: 20, disconnectWhenIdle: true, watermarkAdvanceMs: 60_000,
      recoveryMaximumRequests: 3, recoveryBarLimit: 500,
      now: () => Date.parse("2026-07-21T14:00:00.000Z"),
    });
    const releaseMissing = await runtime.retain(["AAPL"], "US");
    expect(socket.subscriptionCount).toBe(0);
    expect(runtime.eventsAfter(0).at(-1)).toMatchObject({
      type: "diagnostic", symbol: "AAPL", marketCountry: "US",
      payload: { code: "us-exchange-unavailable", status: "source_unavailable" },
    });
    releaseMissing();

    const release = await runtime.retain(["AAPL"], "US", { AAPL: "NAS" });
    expect(Array.from(socket.subscriptions.values())).toEqual(expect.arrayContaining([
      { trId: "HDFSCNT0", symbol: "AAPL", exchange: "NAS", usFeed: "standard" },
      { trId: "HDFSCNT0", symbol: "AAPL", exchange: "NAS", usFeed: "day" },
      { trId: "HDFSASP0", symbol: "AAPL", exchange: "NAS", usFeed: "standard" },
    ]));
    release();
    expect(socket.subscriptionCount).toBe(0);
    runtime.close();
  });

  it("degrades a per-symbol subscription failure and keeps other US symbols live", async () => {
    const socket = new FakeSocket();
    const originalSubscribe = socket.subscribe.bind(socket);
    vi.spyOn(socket, "subscribe").mockImplementation((subscription) => {
      if (subscription.symbol === "AAPL" && subscription.trId === "HDFSASP0") {
        throw new Error("configured capacity reached");
      }
      return originalSubscribe(subscription);
    });
    const runtime = new ScalpingLiveRuntime(socket as never, {
      getCurrentDayMinutes: vi.fn(), getOverseasMinutes: vi.fn().mockRejectedValue(new Error("offline")),
    } as never, {
      ingest: vi.fn(), advanceWatermark: vi.fn(), recentFinalBars: vi.fn(),
    } as never, { putBars: vi.fn(), listBars: vi.fn() } as never, {
      replayEventLimit: 20, disconnectWhenIdle: true, watermarkAdvanceMs: 60_000,
      recoveryMaximumRequests: 3, recoveryBarLimit: 500,
      now: () => Date.parse("2026-07-21T14:00:00.000Z"),
    });
    const release = await runtime.retain(["AAPL", "MSFT"], "US", { AAPL: "NAS", MSFT: "NAS" });
    expect(Array.from(socket.subscriptions.values())).toEqual(expect.arrayContaining([
      { trId: "HDFSCNT0", symbol: "MSFT", exchange: "NAS", usFeed: "standard" },
      { trId: "HDFSCNT0", symbol: "MSFT", exchange: "NAS", usFeed: "day" },
      { trId: "HDFSASP0", symbol: "MSFT", exchange: "NAS", usFeed: "standard" },
    ]));
    expect(Array.from(socket.subscriptions.values()).filter(({ symbol }) => symbol === "AAPL")).toEqual(expect.arrayContaining([
      { trId: "HDFSCNT0", symbol: "AAPL", exchange: "NAS", usFeed: "standard" },
      { trId: "HDFSCNT0", symbol: "AAPL", exchange: "NAS", usFeed: "day" },
    ]));
    expect(runtime.eventsAfter(0)).toContainEqual(expect.objectContaining({
      type: "diagnostic", symbol: "AAPL", marketCountry: "US",
      payload: expect.objectContaining({ code: "subscription-partial", status: "partial", trId: "HDFSASP0" }),
    }));
    release();
    expect(socket.subscriptionCount).toBe(0);
    runtime.close();
  });

  it("removes only a rejected optional feed and keeps remaining US execution feeds live", async () => {
    const socket = new FakeSocket();
    const runtime = new ScalpingLiveRuntime(socket as never, {
      getCurrentDayMinutes: vi.fn(), getOverseasMinutes: vi.fn().mockRejectedValue(new Error("offline")),
    } as never, {
      ingest: vi.fn(), advanceWatermark: vi.fn(), recentFinalBars: vi.fn(),
    } as never, { putBars: vi.fn(), listBars: vi.fn() } as never, {
      replayEventLimit: 20, disconnectWhenIdle: true, watermarkAdvanceMs: 60_000,
      recoveryMaximumRequests: 3, recoveryBarLimit: 500,
    });
    const release = await runtime.retain(["AAPL"], "US", { AAPL: "NAS" });
    socket.emit({
      type: "subscription",
      trId: "HDFSASP0",
      market: "US",
      marketCountry: "US",
      exchange: "NAS",
      symbol: "AAPL",
      providerTimestamp: "2026-07-21T14:00:00.000Z",
      action: "subscribe",
      accepted: false,
      code: "OPSP8999",
      message: "SUBSCRIPTION LIMIT",
    });
    expect(socket.subscriptionCount).toBe(2);
    expect(runtime.state.symbols).toEqual([{ symbol: "AAPL", marketCountry: "US", exchange: "NAS" }]);
    expect(runtime.eventsAfter(0)).toContainEqual(expect.objectContaining({
      type: "diagnostic",
      symbol: "AAPL",
      marketCountry: "US",
      payload: {
        code: "subscription-rejected",
        status: "partial",
        trId: "HDFSASP0",
        usFeed: undefined,
        providerCode: "OPSP8999",
        message: "SUBSCRIPTION LIMIT",
      },
    }));
    release();
    runtime.close();
  });

  it("ignores a rejected acknowledgement that arrives after the reference was released", async () => {
    const socket = new FakeSocket();
    const runtime = new ScalpingLiveRuntime(socket as never, {
      getCurrentDayMinutes: vi.fn().mockRejectedValue(new Error("offline")), getOverseasMinutes: vi.fn(),
    } as never, {
      ingest: vi.fn(), advanceWatermark: vi.fn(), recentFinalBars: vi.fn(),
    } as never, { putBars: vi.fn(), listBars: vi.fn() } as never, {
      replayEventLimit: 20, disconnectWhenIdle: true, watermarkAdvanceMs: 60_000,
      recoveryMaximumRequests: 3, recoveryBarLimit: 500,
    });
    const release = await runtime.retain(["005930"]);
    release();
    const before = runtime.eventsAfter(0).length;
    socket.emit({
      type: "subscription",
      trId: "H0UNCNT0",
      market: "INTEGRATED",
      marketCountry: "KR",
      symbol: "005930",
      providerTimestamp: "2026-07-21T00:00:00.000Z",
      action: "subscribe",
      accepted: false,
      code: "LATE",
      message: "late acknowledgement",
    });
    expect(runtime.eventsAfter(0)).toHaveLength(before);
    runtime.close();
  });

  it("rolls back all subscriptions acquired by a retain when the socket connection fails", async () => {
    const socket = new FakeSocket();
    socket.connect = vi.fn().mockRejectedValue(new Error("approval failed"));
    const runtime = new ScalpingLiveRuntime(socket as never, {
      getCurrentDayMinutes: vi.fn(), getOverseasMinutes: vi.fn(),
    } as never, {
      ingest: vi.fn(), advanceWatermark: vi.fn(), recentFinalBars: vi.fn(),
    } as never, { putBars: vi.fn(), listBars: vi.fn() } as never, {
      replayEventLimit: 20, disconnectWhenIdle: true, watermarkAdvanceMs: 60_000,
      recoveryMaximumRequests: 3, recoveryBarLimit: 500,
    });
    await expect(runtime.retain(["AAPL", "MSFT"], "US", { AAPL: "NAS", MSFT: "NAS" }))
      .rejects.toThrow("approval failed");
    expect(socket.subscriptionCount).toBe(0);
    expect(runtime.state.symbols).toEqual([]);
    runtime.close();
  });

  it("persists WebSocket aggregate updates and publishes forming/final bars", async () => {
    const socket = new FakeSocket();
    const putBars = vi.fn().mockResolvedValue(undefined);
    const aggregator = {
      ingest: vi.fn().mockReturnValue({
        accepted: true,
        updates: [{
          kind: "upsert",
          bar: {
            symbol: "005930", interval: "1m", startAt: "2026-07-21T00:00:00.000Z",
            endAt: "2026-07-21T00:01:00.000Z", sessionDate: "2026-07-21", status: "final",
            open: 100, high: 101, low: 99, close: 100, volume: 2, tradingAmount: 200,
            tradeCount: 1, componentMinuteCount: 1, quality: "available", missingMinuteCount: 0,
          },
        }],
      }),
      advanceWatermark: vi.fn(),
      recentFinalBars: vi.fn(),
    };
    const runtime = new ScalpingLiveRuntime(socket as never, { getCurrentDayMinutes: vi.fn().mockRejectedValue(new Error("offline")) }, aggregator as never, {
      putBars, listBars: vi.fn(),
    } as never, {
      replayEventLimit: 20, disconnectWhenIdle: false, watermarkAdvanceMs: 60_000,
      recoveryMaximumRequests: 3, recoveryBarLimit: 500,
      now: () => Date.parse("2026-07-21T00:02:00Z"),
    });
    const received: string[] = [];
    runtime.onEvent((event) => received.push(event.type));
    socket.emit({
      type: "execution", trId: "H0UNCNT0", market: "INTEGRATED", marketCountry: "KR", symbol: "005930",
      eventId: "trade-1", providerTimestamp: "2026-07-21T09:00:10+09:00", receivedAt: "2026-07-21T00:00:10Z",
      sessionDate: "20260721", tradeTime: "090010", price: 100, executionVolume: 2,
      accumulatedVolume: 2, accumulatedTradingAmount: 200, askPrice1: 101, bidPrice1: 99,
      tradingHalted: false,
    });
    await runtime.waitForIdle();
    expect(aggregator.ingest).toHaveBeenCalledWith(expect.objectContaining({
      sessionDate: "2026-07-21", tradingAmount: 200,
    }));
    expect(putBars).toHaveBeenCalledWith([expect.objectContaining({
      source: "kis_ws", state: "final", turnover: 200,
    })]);
    expect(received).toEqual(["trade", "bar"]);
    expect(runtime.snapshot("005930", "KR").trade).toMatchObject({ market: "INTEGRATED" });
    expect(runtime.eventsAfter(0)).toContainEqual(expect.objectContaining({
      type: "trade", marketCountry: "KR", payload: expect.objectContaining({ market: "INTEGRATED" }),
    }));
    runtime.close();
  });

  it("publishes a forming NXT tail clamped to 20:00 without a synthetic 20:40 close", async () => {
    const socket = new FakeSocket();
    const putBars = vi.fn().mockResolvedValue(undefined);
    const bar = (startAt: string, endAt: string, status: "forming" | "final", quality: "available" | "partial") => ({
      symbol: "005930", marketCountry: "KR" as const, interval: "60m" as const,
      startAt, endAt, sessionDate: "2026-07-21", status,
      open: 100, high: 101, low: 99, close: 100, volume: 2, tradingAmount: 200,
      tradeCount: 1, componentMinuteCount: quality === "partial" ? 50 : 60,
      quality, missingMinuteCount: quality === "partial" ? 10 : 0,
    });
    const aggregator = {
      ingest: vi.fn().mockReturnValue({
        accepted: true,
        updates: [
          { kind: "upsert", bar: bar("2026-07-21T10:40:00.000Z", "2026-07-21T11:40:00.000Z", "forming", "partial") },
          { kind: "upsert", bar: bar("2026-07-21T09:40:00.000Z", "2026-07-21T10:40:00.000Z", "forming", "partial") },
        ],
      }),
      advanceWatermark: vi.fn(), recentFinalBars: vi.fn(),
    };
    const runtime = new ScalpingLiveRuntime(socket as never, {
      getCurrentDayMinutes: vi.fn(), getOverseasMinutes: vi.fn(),
    } as never, aggregator as never, { putBars, listBars: vi.fn() } as never, {
      replayEventLimit: 20, disconnectWhenIdle: false, watermarkAdvanceMs: 60_000,
      recoveryMaximumRequests: 3, recoveryBarLimit: 500,
      now: () => Date.parse("2026-07-21T19:45:10+09:00"),
    });
    socket.emit({
      type: "execution", trId: "H0UNCNT0", market: "INTEGRATED", marketCountry: "KR", symbol: "005930",
      eventId: "nxt-tail", providerTimestamp: "2026-07-21T19:45:10+09:00", receivedAt: "2026-07-21T10:45:10Z",
      sessionDate: "20260721", tradeTime: "194510", price: 100, executionVolume: 2,
      accumulatedVolume: 2, accumulatedTradingAmount: 200, askPrice1: 101, bidPrice1: 99,
    });
    await runtime.waitForIdle();
    expect(putBars).toHaveBeenCalledOnce();
    expect(putBars).toHaveBeenCalledWith([
      expect.objectContaining({
        intervalMinutes: 60,
        openTime: "2026-07-21T10:40:00.000Z",
        closeTime: "2026-07-21T11:00:00.000Z",
        state: "forming",
        quality: "partial",
      }),
      expect.objectContaining({
        intervalMinutes: 60,
        openTime: "2026-07-21T09:40:00.000Z",
        closeTime: "2026-07-21T10:40:00.000Z",
        state: "forming",
        quality: "partial",
      }),
    ]);
    expect(runtime.eventsAfter(0).filter((event) => event.type === "bar")).toEqual([
      expect.objectContaining({
        marketCountry: "KR",
        payload: expect.objectContaining({
          openTime: "2026-07-21T10:40:00.000Z",
          closeTime: "2026-07-21T11:00:00.000Z",
          state: "forming",
          quality: "partial",
        }),
      }),
      expect.objectContaining({
        marketCountry: "KR",
        payload: expect.objectContaining({ openTime: "2026-07-21T09:40:00.000Z" }),
      }),
    ]);
    runtime.close();
  });

  it("deduplicates a US tail final over forming at the 16:00 close", async () => {
    const socket = new FakeSocket();
    const putBars = vi.fn().mockResolvedValue(undefined);
    const bar = (startAt: string, endAt: string, status: "forming" | "final") => ({
      symbol: "AAPL", marketCountry: "US" as const, interval: "60m" as const,
      startAt, endAt, sessionDate: "2026-07-21", status,
      open: 200, high: 201, low: 199, close: 200, volume: 2, tradingAmount: 400,
      tradeCount: 1, componentMinuteCount: 30, quality: "partial" as const, missingMinuteCount: 30,
    });
    const aggregator = {
      ingest: vi.fn().mockReturnValue({
        accepted: true,
        updates: [
          { kind: "upsert", bar: bar("2026-07-21T19:30:00.000Z", "2026-07-21T20:30:00.000Z", "forming") },
          { kind: "upsert", bar: bar("2026-07-21T19:30:00.000Z", "2026-07-21T20:30:00.000Z", "final") },
          { kind: "upsert", bar: bar("2026-07-21T18:30:00.000Z", "2026-07-21T19:30:00.000Z", "forming") },
        ],
      }),
      advanceWatermark: vi.fn(), recentFinalBars: vi.fn(),
    };
    const runtime = new ScalpingLiveRuntime(socket as never, {
      getCurrentDayMinutes: vi.fn(), getOverseasMinutes: vi.fn(),
    } as never, aggregator as never, { putBars, listBars: vi.fn() } as never, {
      replayEventLimit: 20, disconnectWhenIdle: false, watermarkAdvanceMs: 60_000,
      recoveryMaximumRequests: 3, recoveryBarLimit: 500,
      now: () => Date.parse("2026-07-21T15:31:10-04:00"),
    });
    socket.emit({
      type: "execution", trId: "HDFSCNT0", market: "US", marketCountry: "US", exchange: "NAS", symbol: "AAPL",
      eventId: "us-tail", providerTimestamp: "2026-07-21T19:31:10.000Z", receivedAt: "2026-07-21T19:31:10Z",
      sessionDate: "20260721", tradeTime: "153110", price: 200, executionVolume: 2,
      accumulatedVolume: 2, accumulatedTradingAmount: 400, askPrice1: 201, bidPrice1: 199,
    });
    await runtime.waitForIdle();
    expect(putBars).toHaveBeenCalledOnce();
    expect(putBars).toHaveBeenCalledWith([
      expect.objectContaining({
        marketCountry: "US",
        intervalMinutes: 60,
        openTime: "2026-07-21T19:30:00.000Z",
        closeTime: "2026-07-21T20:00:00.000Z",
        state: "final",
        quality: "partial",
      }),
      expect.objectContaining({
        marketCountry: "US",
        intervalMinutes: 60,
        openTime: "2026-07-21T18:30:00.000Z",
        closeTime: "2026-07-21T19:30:00.000Z",
        state: "forming",
        quality: "partial",
      }),
    ]);
    expect(runtime.eventsAfter(0).filter((event) => event.type === "bar")).toEqual([
      expect.objectContaining({
        marketCountry: "US",
        payload: expect.objectContaining({
          openTime: "2026-07-21T19:30:00.000Z",
          closeTime: "2026-07-21T20:00:00.000Z",
          state: "final",
          quality: "partial",
        }),
      }),
      expect.objectContaining({
        marketCountry: "US",
        payload: expect.objectContaining({ openTime: "2026-07-21T18:30:00.000Z" }),
      }),
    ]);
    runtime.close();
  });

  it("assigns both halves of the cross-midnight US day feed to one trading-session date", () => {
    const socket = new FakeSocket();
    const aggregator = {
      ingest: vi.fn().mockReturnValue({ accepted: true, updates: [] }),
      advanceWatermark: vi.fn(), recentFinalBars: vi.fn(),
    };
    const runtime = new ScalpingLiveRuntime(socket as never, {
      getCurrentDayMinutes: vi.fn(), getOverseasMinutes: vi.fn(),
    } as never, aggregator as never, { putBars: vi.fn(), listBars: vi.fn() } as never, {
      replayEventLimit: 20, disconnectWhenIdle: false, watermarkAdvanceMs: 60_000,
      recoveryMaximumRequests: 3, recoveryBarLimit: 500,
    });
    const base = {
      type: "execution" as const,
      trId: "HDFSCNT0" as const,
      market: "US" as const,
      marketCountry: "US" as const,
      exchange: "NAS" as const,
      usFeed: "day" as const,
      symbol: "AAPL",
      receivedAt: "2026-07-22T00:15:31.000Z",
      price: 200,
      executionVolume: 2,
      accumulatedVolume: 2,
      accumulatedTradingAmount: 400,
      askPrice1: 201,
      bidPrice1: 199,
    };
    socket.emit({
      ...base,
      eventId: "day-before-midnight",
      providerTimestamp: "2026-07-22T00:15:30.000Z",
      sessionDate: "20260722",
      tradeTime: "201530",
    });
    socket.emit({
      ...base,
      eventId: "day-after-midnight",
      providerTimestamp: "2026-07-22T04:15:30.000Z",
      sessionDate: "20260722",
      tradeTime: "001530",
    });
    expect(aggregator.ingest).toHaveBeenNthCalledWith(1, expect.objectContaining({
      executedAt: "2026-07-22T00:15:30.000Z",
      sessionDate: "2026-07-22",
      sessionStartAt: "2026-07-22T00:00:00.000Z",
      sessionEndAt: "2026-07-22T04:00:00.000Z",
    }));
    expect(aggregator.ingest).toHaveBeenNthCalledWith(2, expect.objectContaining({
      executedAt: "2026-07-22T04:15:30.000Z",
      sessionDate: "2026-07-22",
      sessionStartAt: "2026-07-22T04:00:00.000Z",
      sessionEndAt: "2026-07-22T08:00:00.000Z",
    }));
    runtime.close();
  });

  it("never exposes a US day-market orderbook and expires stale standard-session snapshots", () => {
    const socket = new FakeSocket();
    let now = Date.parse("2026-07-21T14:15:31.000Z");
    const runtime = new ScalpingLiveRuntime(socket as never, {
      getCurrentDayMinutes: vi.fn(), getOverseasMinutes: vi.fn(),
    } as never, {
      ingest: vi.fn(), advanceWatermark: vi.fn(), recentFinalBars: vi.fn(),
    } as never, { putBars: vi.fn(), listBars: vi.fn() } as never, {
      replayEventLimit: 20, disconnectWhenIdle: false, watermarkAdvanceMs: 60_000,
      recoveryMaximumRequests: 3, recoveryBarLimit: 500, snapshotStaleAfterMs: 120_000,
      now: () => now,
    });
    const emitBook = (providerTimestamp: string) => socket.emit({
      type: "orderbook",
      trId: "HDFSASP0",
      market: "US",
      marketCountry: "US",
      exchange: "NAS",
      usFeed: "standard",
      symbol: "AAPL",
      providerTimestamp,
      receivedAt: providerTimestamp,
      sessionDate: providerTimestamp.slice(0, 10).replaceAll("-", ""),
      quoteTime: "101531",
      timestampDateSource: "provider-local-date",
      depth: "top_of_book",
      asks: [{ level: 1, price: 201, quantity: 10 }],
      bids: [{ level: 1, price: 199, quantity: 12 }],
      totalAskQuantity: 10,
      totalBidQuantity: 12,
    });

    emitBook("2026-07-21T14:15:31.000Z");
    expect(runtime.snapshot("AAPL", "US").orderbook).toMatchObject({ depth: "top_of_book" });

    now = Date.parse("2026-07-22T00:15:31.000Z");
    emitBook("2026-07-22T00:15:31.000Z");
    expect(runtime.snapshot("AAPL", "US").orderbook).toBeUndefined();

    now = Date.parse("2026-07-22T08:15:31.000Z");
    emitBook("2026-07-22T08:15:31.000Z");
    expect(runtime.snapshot("AAPL", "US").orderbook).toMatchObject({ depth: "top_of_book" });
    now += 120_001;
    expect(runtime.snapshot("AAPL", "US").orderbook).toBeUndefined();
    runtime.close();
  });

  it("normalizes late-evening US REST recovery rows to the following trading-session date", async () => {
    const socket = new FakeSocket();
    const putBars = vi.fn().mockResolvedValue(undefined);
    const getOverseasMinutes = vi.fn()
      .mockResolvedValueOnce({
        items: [{
          symbol: "AAPL",
          sessionDate: "20260721",
          timestamp: "2026-07-22T00:15:00.000Z",
          open: 200,
          high: 201,
          low: 199,
          close: 200.5,
          volume: 10,
          status: "final",
          source: "kis_rest_recovery",
        }],
        quality: "available",
        diagnostics: [],
        providerTimestamp: "2026-07-22T00:15:30.000Z",
      })
      .mockResolvedValueOnce({
        items: [], quality: "available", diagnostics: [], providerTimestamp: "2026-07-22T00:15:30.000Z",
      });
    const runtime = new ScalpingLiveRuntime(socket as never, {
      getCurrentDayMinutes: vi.fn(), getOverseasMinutes,
    } as never, {
      ingest: vi.fn(), advanceWatermark: vi.fn(), recentFinalBars: vi.fn(),
    } as never, { putBars, listBars: vi.fn() } as never, {
      replayEventLimit: 20, disconnectWhenIdle: false, watermarkAdvanceMs: 60_000,
      recoveryMaximumRequests: 3, recoveryBarLimit: 500,
      now: () => Date.parse("2026-07-22T00:15:30.000Z"),
    });

    await runtime.recover("AAPL", "US", "NAS");

    expect(getOverseasMinutes).toHaveBeenNthCalledWith(1, expect.objectContaining({
      symbol: "AAPL", exchange: "NAS", sessionDate: "20260721",
    }));
    expect(putBars).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({
        marketCountry: "US",
        symbol: "AAPL",
        intervalMinutes: 1,
        openTime: "2026-07-22T00:15:00.000Z",
        sessionDate: "2026-07-22",
      }),
    ]));
    runtime.close();
  });

  it("publishes break-time executions without aggregating them or flooding diagnostics", () => {
    const socket = new FakeSocket();
    const aggregator = { ingest: vi.fn(), advanceWatermark: vi.fn(), recentFinalBars: vi.fn() };
    const runtime = new ScalpingLiveRuntime(socket as never, {
      getCurrentDayMinutes: vi.fn(), getOverseasMinutes: vi.fn(),
    } as never, aggregator as never, { putBars: vi.fn(), listBars: vi.fn() } as never, {
      replayEventLimit: 100, disconnectWhenIdle: false, watermarkAdvanceMs: 60_000,
      recoveryMaximumRequests: 3, recoveryBarLimit: 500,
    });
    const types: string[] = [];
    runtime.onEvent((event) => types.push(event.type));
    for (let index = 0; index < 10; index += 1) {
      socket.emit({
        type: "execution", trId: "H0UNCNT0", market: "INTEGRATED", marketCountry: "KR", symbol: "005930",
        eventId: `break-${index}`, providerTimestamp: `2026-07-21T15:3${index}:10+09:00`, receivedAt: "2026-07-21T06:30:10Z",
        sessionDate: "20260721", tradeTime: `153${index}10`, price: 100, executionVolume: 2,
        accumulatedVolume: 2, accumulatedTradingAmount: 200, askPrice1: 101, bidPrice1: 99,
        tradingHalted: false,
      });
    }
    expect(aggregator.ingest).not.toHaveBeenCalled();
    expect(types.filter((type) => type === "trade")).toHaveLength(10);
    expect(types).not.toContain("diagnostic");
    runtime.close();
  });

  it("assigns an exact session-close execution to the final active minute and starts gap recovery", async () => {
    const socket = new FakeSocket();
    const aggregator = {
      ingest: vi.fn().mockReturnValue({ accepted: false, updates: [] }),
      advanceWatermark: vi.fn(), recentFinalBars: vi.fn(),
    };
    const getCurrentDayMinutes = vi.fn().mockRejectedValue(new Error("offline"));
    const runtime = new ScalpingLiveRuntime(socket as never, {
      getCurrentDayMinutes, getOverseasMinutes: vi.fn(),
    } as never, aggregator as never, { putBars: vi.fn(), listBars: vi.fn() } as never, {
      replayEventLimit: 20, disconnectWhenIdle: false, watermarkAdvanceMs: 60_000,
      recoveryMaximumRequests: 3, recoveryBarLimit: 500,
      now: () => Date.parse("2026-07-21T20:00:01+09:00"),
    });
    socket.emit({
      type: "execution", trId: "H0UNCNT0", market: "INTEGRATED", marketCountry: "KR", symbol: "005930",
      eventId: "after-close", providerTimestamp: "2026-07-21T20:00:00+09:00", receivedAt: "2026-07-21T11:00:00Z",
      sessionDate: "20260721", tradeTime: "200000", price: 100, executionVolume: 2,
      accumulatedVolume: 2, accumulatedTradingAmount: 200, askPrice1: 101, bidPrice1: 99,
      tradingHalted: false,
    });
    expect(aggregator.ingest).toHaveBeenCalledWith(expect.objectContaining({
      executedAt: "2026-07-21T10:59:59.999Z",
      sessionStartAt: "2026-07-21T06:40:00.000Z",
      sessionEndAt: "2026-07-21T11:00:00.000Z",
    }));
    await runtime.waitForIdle();
    expect(getCurrentDayMinutes).toHaveBeenCalledOnce();
    runtime.close();
  });

  it("runs one trailing close refresh when the exact close arrives during an older recovery", async () => {
    const socket = new FakeSocket();
    const emptyPage = {
      items: [], quality: "available" as const, diagnostics: [], providerTimestamp: "2026-07-21T10:59:59.000Z",
    };
    let resolveFirst!: (value: typeof emptyPage) => void;
    const firstPage = new Promise<typeof emptyPage>((resolve) => { resolveFirst = resolve; });
    const closePage = {
      items: [
        {
          symbol: "005930", sessionDate: "20260721", timestamp: "2026-07-21T15:29:00+09:00",
          open: 100, high: 100, low: 100, close: 100, volume: 0, status: "final" as const,
          source: "kis_rest_recovery" as const,
        },
        {
          symbol: "005930", sessionDate: "20260721", timestamp: "2026-07-21T15:30:00+09:00",
          open: 101, high: 102, low: 101, close: 102, volume: 10, status: "final" as const,
          source: "kis_rest_recovery" as const,
        },
      ],
      quality: "available" as const,
      diagnostics: [],
      providerTimestamp: "2026-07-21T06:30:01.000Z",
    };
    const getCurrentDayMinutes = vi.fn()
      .mockImplementationOnce(() => firstPage)
      .mockResolvedValue(closePage);
    const putBars = vi.fn().mockResolvedValue(undefined);
    const runtime = new ScalpingLiveRuntime(socket as never, {
      getCurrentDayMinutes, getOverseasMinutes: vi.fn(),
    } as never, {
      ingest: vi.fn().mockReturnValue({ accepted: false, updates: [] }),
      advanceWatermark: vi.fn(), recentFinalBars: vi.fn(),
    } as never, { putBars, listBars: vi.fn().mockResolvedValue([]) } as never, {
      replayEventLimit: 20, disconnectWhenIdle: false, watermarkAdvanceMs: 60_000,
      recoveryMaximumRequests: 1, recoveryBarLimit: 500,
      now: () => Date.parse("2026-07-21T15:30:01+09:00"),
    });

    void runtime.recover("005930");
    await vi.waitFor(() => expect(getCurrentDayMinutes).toHaveBeenCalledTimes(1));
    const exactClose = {
      type: "execution" as const, trId: "H0UNCNT0" as const, market: "INTEGRATED" as const,
      marketCountry: "KR" as const, symbol: "005930", eventId: "regular-close",
      providerTimestamp: "2026-07-21T15:30:00+09:00", receivedAt: "2026-07-21T06:30:00Z",
      sessionDate: "20260721", tradeTime: "153000", price: 102, executionVolume: 10,
      accumulatedVolume: 10, accumulatedTradingAmount: 1_020, askPrice1: 103, bidPrice1: 101,
      tradingHalted: false,
    };
    socket.emit(exactClose);
    socket.emit({ ...exactClose, eventId: "regular-close-duplicate" });
    resolveFirst(emptyPage);
    await runtime.waitForIdle();

    expect(getCurrentDayMinutes).toHaveBeenCalledTimes(2);
    expect((putBars.mock.calls[0]?.[0] as IntradayBarRecord[])).toEqual([
      expect.objectContaining({
        source: "recovered",
        openTime: "2026-07-21T06:29:00.000Z",
        closeTime: "2026-07-21T06:30:00.000Z",
        close: 102,
        volume: 10,
        quality: "recovered",
      }),
    ]);
    runtime.close();
  });

  it("recovers a crossed NXT session close once even when no exact-close execution arrives", async () => {
    vi.useFakeTimers();
    let now = Date.parse("2026-07-21T19:59:59.800+09:00");
    const socket = new FakeSocket();
    const closePage = {
      items: [
        {
          symbol: "005930", sessionDate: "20260721", timestamp: "2026-07-21T19:59:00+09:00",
          open: 100, high: 100, low: 100, close: 100, volume: 0, status: "final" as const,
          source: "kis_rest_recovery" as const,
        },
        {
          symbol: "005930", sessionDate: "20260721", timestamp: "2026-07-21T20:00:00+09:00",
          open: 101, high: 102, low: 101, close: 102, volume: 10, status: "final" as const,
          source: "kis_rest_recovery" as const,
        },
      ],
      quality: "available" as const,
      diagnostics: [],
      providerTimestamp: "2026-07-21T11:00:01.000Z",
    };
    let resolveClose!: (value: typeof closePage) => void;
    const pendingClose = new Promise<typeof closePage>((resolve) => { resolveClose = resolve; });
    const getCurrentDayMinutes = vi.fn().mockImplementation(() => (
      now < Date.parse("2026-07-21T20:00:00+09:00")
        ? Promise.resolve({ ...closePage, items: [] })
        : pendingClose
    ));
    const putBars = vi.fn().mockResolvedValue(undefined);
    const runtime = new ScalpingLiveRuntime(socket as never, {
      getCurrentDayMinutes, getOverseasMinutes: vi.fn(),
    } as never, {
      ingest: vi.fn().mockReturnValue({ accepted: false, updates: [] }),
      advanceWatermark: vi.fn().mockReturnValue([]), recentFinalBars: vi.fn(),
      markDiscontinuity: vi.fn(),
    } as never, { putBars, listBars: vi.fn().mockResolvedValue([]) } as never, {
      replayEventLimit: 20, disconnectWhenIdle: false, watermarkAdvanceMs: 250,
      recoveryMaximumRequests: 1, recoveryBarLimit: 500, now: () => now,
    });
    const events: Array<{ type: string; payload: unknown }> = [];
    runtime.onEvent((event) => events.push(event));

    const release = await runtime.retain(["005930"]);
    await runtime.waitForIdle();
    getCurrentDayMinutes.mockClear();
    putBars.mockClear();
    now = Date.parse("2026-07-21T20:00:00.100+09:00");
    await vi.advanceTimersByTimeAsync(250);
    await vi.waitFor(() => expect(getCurrentDayMinutes).toHaveBeenCalledTimes(1));
    socket.emit({
      type: "execution", trId: "H0UNCNT0", market: "INTEGRATED", marketCountry: "KR", symbol: "005930",
      eventId: "same-close-after-wall-clock", providerTimestamp: "2026-07-21T20:00:00+09:00",
      receivedAt: "2026-07-21T11:00:00Z", sessionDate: "20260721", tradeTime: "200000",
      price: 102, executionVolume: 10, accumulatedVolume: 10, accumulatedTradingAmount: 1_020,
      askPrice1: 103, bidPrice1: 101, tradingHalted: false,
    });
    resolveClose(closePage);
    await runtime.waitForIdle();
    now = Date.parse("2026-07-21T20:00:01.100+09:00");
    await vi.advanceTimersByTimeAsync(250);
    await runtime.waitForIdle();

    expect(getCurrentDayMinutes).toHaveBeenCalledTimes(1);
    expect((putBars.mock.calls[0]?.[0] as IntradayBarRecord[])).toEqual([
      expect.objectContaining({
        source: "recovered",
        openTime: "2026-07-21T10:59:00.000Z",
        closeTime: "2026-07-21T11:00:00.000Z",
        close: 102,
        volume: 10,
        quality: "recovered",
      }),
    ]);
    expect(events).toContainEqual(expect.objectContaining({
      type: "bar",
      payload: expect.objectContaining({
        intervalMinutes: 1,
        openTime: "2026-07-21T10:59:00.000Z",
        state: "final",
      }),
    }));
    release();
    getCurrentDayMinutes.mockClear();
    now = Date.parse("2026-07-21T20:00:02.000+09:00");
    const lateRelease = await runtime.retain(["005930"]);
    await runtime.waitForIdle();
    getCurrentDayMinutes.mockClear();
    now = Date.parse("2026-07-21T20:00:03.000+09:00");
    await vi.advanceTimersByTimeAsync(250);
    await runtime.waitForIdle();
    expect(getCurrentDayMinutes).not.toHaveBeenCalled();
    lateRelease();
    runtime.close();
  });

  it("recovers only provider-returned bars and labels unavailable historical orderbook and turnover", async () => {
    const socket = new FakeSocket();
    const putBars = vi.fn().mockResolvedValue(undefined);
    const rest = { getCurrentDayMinutes: vi.fn().mockResolvedValue({
      items: [{
        symbol: "005930", sessionDate: "20260721", timestamp: "2026-07-21T09:00:00+09:00",
        open: 100, high: 101, low: 99, close: 100, volume: 10, status: "final", source: "kis_rest_recovery",
      }],
      quality: "available",
      diagnostics: [],
      providerTimestamp: "2026-07-21T00:10:00Z",
    }) };
    const runtime = new ScalpingLiveRuntime(socket as never, rest as never, {
      ingest: vi.fn(), advanceWatermark: vi.fn(), recentFinalBars: vi.fn(),
    } as never, { putBars, listBars: vi.fn() } as never, {
      replayEventLimit: 10,
      disconnectWhenIdle: false,
      watermarkAdvanceMs: 60_000,
      recoveryMaximumRequests: 3,
      recoveryBarLimit: 500,
      now: () => Date.parse("2026-07-21T00:10:00Z"),
    });
    await runtime.recover("005930");
    expect(putBars).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ intervalMinutes: 1, source: "kis_rest", volume: 10 }),
    ]));
    const stored = putBars.mock.calls[0]![0] as IntradayBarRecord[];
    expect(stored.every((bar) => bar.turnover === undefined)).toBe(true);
    expect(runtime.eventsAfter(0).at(-1)).toMatchObject({
      type: "recovery",
      payload: {
        status: "available",
        recoveredBars: 5,
        recoveredOneMinuteBars: 1,
        oldestTimestamp: "2026-07-21T00:00:00.000Z",
        newestTimestamp: "2026-07-21T00:00:00.000Z",
        turnover: { status: "unavailable" },
        historicalOrderbook: { status: "unavailable" },
      },
    });
    runtime.close();
  });

  it("keeps accepted KIS OHLCV rows recovered when a peer provider row is malformed", async () => {
    const socket = new FakeSocket();
    const putBars = vi.fn().mockResolvedValue(undefined);
    const runtime = new ScalpingLiveRuntime(socket as never, { getCurrentDayMinutes: vi.fn().mockResolvedValue({
      items: [{
        symbol: "005930", sessionDate: "20260721", timestamp: "2026-07-21T09:00:00+09:00",
        open: 100, high: 101, low: 99, close: 100, volume: 10,
        status: "final", source: "kis_rest_recovery",
      }],
      quality: "partial",
      diagnostics: [{ index: 1, code: "malformed-row", fields: ["volume"], message: "peer row excluded" }],
      providerTimestamp: "2026-07-21T00:10:00Z",
    }) }, {
      ingest: vi.fn(), advanceWatermark: vi.fn(), recentFinalBars: vi.fn(),
    } as never, { putBars, listBars: vi.fn() } as never, {
      replayEventLimit: 10, disconnectWhenIdle: false, watermarkAdvanceMs: 60_000,
      recoveryMaximumRequests: 3, recoveryBarLimit: 500,
      now: () => Date.parse("2026-07-21T00:10:00Z"),
    });
    await runtime.recover("005930");
    const stored = putBars.mock.calls[0]![0] as IntradayBarRecord[];
    expect(stored[0]).toMatchObject({ close: 100, volume: 10, quality: "recovered" });
    const higher = putBars.mock.calls[1]![0] as IntradayBarRecord[];
    expect(higher).toHaveLength(4);
    expect(higher.every((bar) => bar.quality === "partial")).toBe(true);
    expect(runtime.eventsAfter(0).at(-1)).toMatchObject({
      type: "recovery", payload: { status: "partial", recoveredOneMinuteBars: 1 },
    });
    runtime.close();
  });

  it("keeps an accepted but still-forming KIS minute partial", async () => {
    const socket = new FakeSocket();
    const putBars = vi.fn().mockResolvedValue(undefined);
    const runtime = new ScalpingLiveRuntime(socket as never, { getCurrentDayMinutes: vi.fn().mockResolvedValue({
      items: [{
        symbol: "005930", sessionDate: "20260721", timestamp: "2026-07-21T09:10:00+09:00",
        open: 100, high: 101, low: 99, close: 100, volume: 10,
        status: "forming", source: "kis_rest_recovery",
      }],
      quality: "available",
      diagnostics: [],
      providerTimestamp: "2026-07-21T00:10:30Z",
    }) }, {
      ingest: vi.fn(), advanceWatermark: vi.fn(), recentFinalBars: vi.fn(),
    } as never, { putBars, listBars: vi.fn() } as never, {
      replayEventLimit: 10, disconnectWhenIdle: false, watermarkAdvanceMs: 60_000,
      recoveryMaximumRequests: 3, recoveryBarLimit: 500,
      now: () => Date.parse("2026-07-21T00:10:30Z"),
    });
    await runtime.recover("005930");
    expect((putBars.mock.calls[0]![0] as IntradayBarRecord[])[0]).toMatchObject({
      state: "forming", quality: "partial",
    });
    runtime.close();
  });

  it("재연결 누락 구간을 저장된 최신 봉까지 KIS 커서로 복구하고 설정 상한을 지킨다", async () => {
    const socket = new FakeSocket();
    const known = minute({
      openTime: "2026-07-21T00:05:00.000Z", open: 100, high: 101, low: 99, close: 100, volume: 10,
    });
    const page = (minutes: number[]) => ({
      items: minutes.map((minuteValue) => ({
        symbol: "005930",
        sessionDate: "20260721",
        timestamp: `2026-07-21T09:${String(minuteValue).padStart(2, "0")}:00+09:00`,
        open: 100 + minuteValue,
        high: 102 + minuteValue,
        low: 99 + minuteValue,
        close: 101 + minuteValue,
        volume: 10,
        status: "final" as const,
        source: "kis_rest_recovery" as const,
      })),
      quality: "available" as const,
      diagnostics: [],
      providerTimestamp: "2026-07-21T00:10:00.000Z",
    });
    const getCurrentDayMinutes = vi.fn()
      .mockResolvedValueOnce(page([8, 9]))
      .mockResolvedValueOnce(page([6, 7]))
      .mockResolvedValueOnce(page([4, 5]));
    const putBars = vi.fn().mockResolvedValue(undefined);
    const listBars = vi.fn()
      .mockResolvedValueOnce([known])
      .mockResolvedValueOnce([known]);
    const runtime = new ScalpingLiveRuntime(socket as never, { getCurrentDayMinutes }, {
      ingest: vi.fn(), advanceWatermark: vi.fn(), recentFinalBars: vi.fn(),
    } as never, { putBars, listBars } as never, {
      replayEventLimit: 20,
      disconnectWhenIdle: false,
      watermarkAdvanceMs: 60_000,
      recoveryMaximumRequests: 5,
      recoveryBarLimit: 500,
      now: () => Date.parse("2026-07-21T00:10:00.000Z"),
    });

    await runtime.recover("005930");

    expect(getCurrentDayMinutes).toHaveBeenCalledTimes(3);
    expect(getCurrentDayMinutes.mock.calls.map(([request]) => request.inputTime)).toEqual([
      "091000", "090759", "090559",
    ]);
    expect(putBars.mock.calls[0]![0]).toHaveLength(6);
    expect(runtime.eventsAfter(0).at(-1)).toMatchObject({
      type: "recovery",
      payload: {
        status: "available",
        recoveredOneMinuteBars: 6,
        requestCount: 3,
        stoppedByConfiguredLimit: false,
        oldestTimestamp: "2026-07-21T00:04:00.000Z",
        newestTimestamp: "2026-07-21T00:09:00.000Z",
      },
    });
    runtime.close();
  });

  it("continues below a newer stored bar to the older side of the oldest unrecovered gap", async () => {
    const socket = new FakeSocket();
    const existing = [
      minute({ openTime: "2026-07-21T09:05:00+09:00", open: 100, high: 101, low: 99, close: 100, volume: 10 }),
      minute({ openTime: "2026-07-21T10:00:00+09:00", open: 110, high: 111, low: 109, close: 110, volume: 10 }),
    ];
    const getCurrentDayMinutes = vi.fn()
      .mockResolvedValueOnce(recoveryPage(["2026-07-21T09:30:00+09:00", "2026-07-21T09:59:00+09:00"]))
      .mockResolvedValueOnce(recoveryPage(["2026-07-21T09:06:00+09:00", "2026-07-21T09:29:00+09:00"]))
      .mockResolvedValueOnce(recoveryPage(["2026-07-21T09:04:00+09:00", "2026-07-21T09:05:00+09:00"]));
    const runtime = new ScalpingLiveRuntime(socket as never, { getCurrentDayMinutes }, {
      ingest: vi.fn(), advanceWatermark: vi.fn(), recentFinalBars: vi.fn(),
    } as never, {
      putBars: vi.fn().mockResolvedValue(undefined),
      listBars: vi.fn().mockResolvedValue(existing),
    } as never, {
      replayEventLimit: 20, disconnectWhenIdle: false, watermarkAdvanceMs: 60_000,
      recoveryMaximumRequests: 5, recoveryBarLimit: 500,
      now: () => Date.parse("2026-07-21T10:00:30+09:00"),
    });

    await runtime.recover("005930");

    expect(getCurrentDayMinutes.mock.calls.map(([request]) => request.inputTime)).toEqual([
      "100030", "092959", "090559",
    ]);
    expect(runtime.eventsAfter(0).at(-1)).toMatchObject({
      type: "recovery",
      payload: { requestCount: 3, stoppedByConfiguredLimit: false },
    });
    runtime.close();
  });

  it("keeps the one-page overlap stop for continuously stored session minutes", async () => {
    const socket = new FakeSocket();
    const existing = Array.from({ length: 6 }, (_, index) => minute({
      openTime: new Date(Date.parse("2026-07-21T09:05:00+09:00") + index * 60_000).toISOString(),
      open: 100, high: 101, low: 99, close: 100, volume: 10,
    }));
    const getCurrentDayMinutes = vi.fn().mockResolvedValue(
      recoveryPage(["2026-07-21T09:09:00+09:00", "2026-07-21T09:10:00+09:00"]),
    );
    const runtime = new ScalpingLiveRuntime(socket as never, { getCurrentDayMinutes }, {
      ingest: vi.fn(), advanceWatermark: vi.fn(), recentFinalBars: vi.fn(),
    } as never, {
      putBars: vi.fn().mockResolvedValue(undefined),
      listBars: vi.fn().mockResolvedValue(existing),
    } as never, {
      replayEventLimit: 20, disconnectWhenIdle: false, watermarkAdvanceMs: 60_000,
      recoveryMaximumRequests: 5, recoveryBarLimit: 500,
      now: () => Date.parse("2026-07-21T09:11:00+09:00"),
    });

    await runtime.recover("005930");

    expect(getCurrentDayMinutes).toHaveBeenCalledOnce();
    expect(runtime.eventsAfter(0).at(-1)).toMatchObject({
      type: "recovery", payload: { requestCount: 1, stoppedByConfiguredLimit: false },
    });
    runtime.close();
  });

  it("treats the configured 15:30-15:40 break as a scheduled session transition", async () => {
    const socket = new FakeSocket();
    const existing = [
      minute({ openTime: "2026-07-21T15:29:00+09:00", open: 100, high: 101, low: 99, close: 100, volume: 10 }),
      minute({ openTime: "2026-07-21T15:40:00+09:00", open: 101, high: 102, low: 100, close: 101, volume: 10 }),
    ];
    const getCurrentDayMinutes = vi.fn().mockResolvedValue(
      recoveryPage(["2026-07-21T15:40:00+09:00"]),
    );
    const runtime = new ScalpingLiveRuntime(socket as never, { getCurrentDayMinutes }, {
      ingest: vi.fn(), advanceWatermark: vi.fn(), recentFinalBars: vi.fn(),
    } as never, {
      putBars: vi.fn().mockResolvedValue(undefined),
      listBars: vi.fn().mockResolvedValue(existing),
    } as never, {
      replayEventLimit: 20, disconnectWhenIdle: false, watermarkAdvanceMs: 60_000,
      recoveryMaximumRequests: 5, recoveryBarLimit: 500,
      now: () => Date.parse("2026-07-21T15:41:00+09:00"),
    });

    await runtime.recover("005930");

    expect(getCurrentDayMinutes).toHaveBeenCalledOnce();
    runtime.close();
  });

  it("stops gap-directed pagination at the configured recovery request limit", async () => {
    const socket = new FakeSocket();
    const existing = [
      minute({ openTime: "2026-07-21T09:05:00+09:00", open: 100, high: 101, low: 99, close: 100, volume: 10 }),
      minute({ openTime: "2026-07-21T10:00:00+09:00", open: 110, high: 111, low: 109, close: 110, volume: 10 }),
    ];
    const getCurrentDayMinutes = vi.fn()
      .mockResolvedValueOnce(recoveryPage(["2026-07-21T09:30:00+09:00", "2026-07-21T09:59:00+09:00"]))
      .mockResolvedValueOnce(recoveryPage(["2026-07-21T09:10:00+09:00", "2026-07-21T09:29:00+09:00"]));
    const runtime = new ScalpingLiveRuntime(socket as never, { getCurrentDayMinutes }, {
      ingest: vi.fn(), advanceWatermark: vi.fn(), recentFinalBars: vi.fn(),
    } as never, {
      putBars: vi.fn().mockResolvedValue(undefined),
      listBars: vi.fn().mockResolvedValue(existing),
    } as never, {
      replayEventLimit: 20, disconnectWhenIdle: false, watermarkAdvanceMs: 60_000,
      recoveryMaximumRequests: 2, recoveryBarLimit: 500,
      now: () => Date.parse("2026-07-21T10:00:30+09:00"),
    });

    await runtime.recover("005930");

    expect(getCurrentDayMinutes).toHaveBeenCalledTimes(2);
    expect(runtime.eventsAfter(0).at(-1)).toMatchObject({
      type: "recovery", payload: { requestCount: 2, stoppedByConfiguredLimit: true },
    });
    runtime.close();
  });

  it("advances event-time watermarks from the wall clock only while connected", async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const aggregator = {
      ingest: vi.fn(),
      advanceWatermark: vi.fn().mockReturnValue([]),
      recentFinalBars: vi.fn(),
    };
    const runtime = new ScalpingLiveRuntime(socket as never, {
      getCurrentDayMinutes: vi.fn().mockRejectedValue(new Error("offline")),
    }, aggregator as never, { putBars: vi.fn(), listBars: vi.fn() } as never, {
      replayEventLimit: 10,
      disconnectWhenIdle: true,
      watermarkAdvanceMs: 250,
      recoveryMaximumRequests: 3,
      recoveryBarLimit: 500,
      now: () => Date.parse("2026-07-21T00:02:00Z"),
    });
    const release = await runtime.retain(["005930"]);
    await vi.advanceTimersByTimeAsync(250);
    expect(aggregator.advanceWatermark).toHaveBeenCalledWith("005930", "2026-07-21T00:02:00.000Z", "KR");
    release();
    await vi.advanceTimersByTimeAsync(250);
    expect(aggregator.advanceWatermark).toHaveBeenCalledTimes(1);
    runtime.close();
  });
});
