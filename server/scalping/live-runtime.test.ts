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
    const key = `${subscription.trId}:${subscription.symbol}`;
    if (this.subscriptions.has(key)) return false;
    this.subscriptions.set(key, subscription);
    return true;
  }

  unsubscribe(subscription: KisSubscription) {
    return this.subscriptions.delete(`${subscription.trId}:${subscription.symbol}`);
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
      type: "execution", trId: "H0UNCNT0", market: "INTEGRATED", symbol: "005930",
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

  it("REST 복구 거래량이 없으면 0을 만들지 않는다", async () => {
    const socket = new FakeSocket();
    const putBars = vi.fn().mockResolvedValue(undefined);
    const runtime = new ScalpingLiveRuntime(socket as never, { getCurrentDayMinutes: vi.fn().mockResolvedValue({
      items: [{
        symbol: "005930", sessionDate: "20260721", timestamp: "2026-07-21T09:00:00+09:00",
        open: 100, high: 101, low: 99, close: 100, status: "final", source: "kis_rest_recovery",
      }],
      quality: "partial",
      diagnostics: [{ index: 0, code: "malformed-row", fields: ["volume"], message: "volume missing" }],
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
    expect(stored[0]).not.toHaveProperty("volume");
    expect(stored[0]).toMatchObject({ close: 100, quality: "partial" });
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
    expect(aggregator.advanceWatermark).toHaveBeenCalledWith("005930", "2026-07-21T00:02:00.000Z");
    release();
    await vi.advanceTimersByTimeAsync(250);
    expect(aggregator.advanceWatermark).toHaveBeenCalledTimes(1);
    runtime.close();
  });
});
