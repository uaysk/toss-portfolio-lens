import { afterEach, describe, expect, it, vi } from "vitest";
import type { IntradayBarRecord } from "../repositories/scalping-repository.js";
import type { KisWebSocketEvent, KisSubscription } from "./kis-websocket-client.js";
import { aggregateRecoveredBars, ScalpingLiveRuntime } from "./live-runtime.js";

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
    const key = `${subscription.trId}:${subscription.exchange ?? ""}:${subscription.symbol}`;
    if (this.subscriptions.has(key)) return false;
    this.subscriptions.set(key, subscription);
    return true;
  }

  unsubscribe(subscription: KisSubscription) {
    return this.subscriptions.delete(`${subscription.trId}:${subscription.exchange ?? ""}:${subscription.symbol}`);
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
      { trId: "HDFSCNT0", symbol: "AAPL", exchange: "NAS" },
      { trId: "HDFSASP0", symbol: "AAPL", exchange: "NAS" },
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
      { trId: "HDFSCNT0", symbol: "MSFT", exchange: "NAS" },
      { trId: "HDFSASP0", symbol: "MSFT", exchange: "NAS" },
    ]));
    expect(Array.from(socket.subscriptions.values()).some(({ symbol }) => symbol === "AAPL")).toBe(false);
    expect(runtime.eventsAfter(0)).toContainEqual(expect.objectContaining({
      type: "diagnostic", symbol: "AAPL", marketCountry: "US",
      payload: expect.objectContaining({ code: "subscription-unavailable", status: "source_unavailable" }),
    }));
    release();
    expect(socket.subscriptionCount).toBe(0);
    runtime.close();
  });

  it("removes both feeds and emits provider details when one subscription acknowledgement is rejected", async () => {
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
    expect(socket.subscriptionCount).toBe(0);
    expect(runtime.state.symbols).toEqual([]);
    expect(runtime.eventsAfter(0)).toContainEqual(expect.objectContaining({
      type: "diagnostic",
      symbol: "AAPL",
      marketCountry: "US",
      payload: {
        code: "subscription-rejected",
        status: "source_unavailable",
        trId: "HDFSASP0",
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
        oldestTimestamp: "2026-07-21T09:00:00+09:00",
        newestTimestamp: "2026-07-21T09:00:00+09:00",
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
        oldestTimestamp: "2026-07-21T09:04:00+09:00",
        newestTimestamp: "2026-07-21T09:09:00+09:00",
      },
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
