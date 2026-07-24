import { describe, expect, it, vi } from "vitest";
import {
  CausalBinanceKlineStore,
  OfficialBinanceUsdmPublicStreams,
  isModelDecisionEvent,
  normalizeBinanceUniverse,
  normalizeBinanceWebsocketEvent,
  normalizeRestKlines,
  type BinancePublicStreamConnection,
  type BinanceReconnectClock,
} from "./binance-market-data.js";

const NOW = Date.parse("2026-07-25T00:02:00.000Z");

function tuple(openTime: number, closeTime: number, close = "101") {
  return [openTime, "100", "102", "99", close, "10", closeTime, "1000", 20, "5", "500", "0"];
}

class TestConnection implements BinancePublicStreamConnection {
  private readonly listeners = {
    message: [] as Array<(raw: unknown) => void>,
    error: [] as Array<(error: unknown) => void>,
    close: [] as Array<() => void>,
  };

  readonly disconnect = vi.fn(async () => undefined);

  on(
    event: "message" | "error" | "close",
    listener: ((raw: unknown) => void) | ((error: unknown) => void) | (() => void),
  ): unknown {
    if (event === "message") {
      this.listeners.message.push(listener as (raw: unknown) => void);
    } else if (event === "error") {
      this.listeners.error.push(listener as (error: unknown) => void);
    } else {
      this.listeners.close.push(listener as () => void);
    }
    return this;
  }

  emitMessage(raw: unknown): void {
    for (const listener of this.listeners.message) listener(raw);
  }

  emitError(error: unknown): void {
    for (const listener of this.listeners.error) listener(error);
  }

  emitClose(): void {
    for (const listener of this.listeners.close) listener();
  }
}

class TestReconnectClock implements BinanceReconnectClock {
  private sequence = 0;
  private readonly pending = new Map<number, { callback: () => void; delayMs: number }>();
  readonly delays: number[] = [];

  setTimeout(callback: () => void, delayMs: number): unknown {
    const id = ++this.sequence;
    this.pending.set(id, { callback, delayMs });
    this.delays.push(delayMs);
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.pending.delete(handle as number);
  }

  get size(): number {
    return this.pending.size;
  }

  async runNext(): Promise<void> {
    const next = this.pending.entries().next().value as
      | [number, { callback: () => void; delayMs: number }]
      | undefined;
    if (!next) throw new Error("No reconnect timer is pending.");
    this.pending.delete(next[0]);
    next[1].callback();
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
  }
}

describe("Binance USDⓈ-M public market data", () => {
  it("keeps only seasoned trading USDT perpetuals and ignores exchangeInfo maintenance fields", () => {
    const result = normalizeBinanceUniverse({
      symbols: [
        {
          symbol: "BTCUSDT",
          baseAsset: "BTC",
          quoteAsset: "USDT",
          marginAsset: "USDT",
          contractType: "PERPETUAL",
          status: "TRADING",
          onboardDate: NOW - 8 * 86_400_000,
          maintMarginPercent: "0.4",
          filters: [
            { filterType: "PRICE_FILTER", tickSize: "0.1" },
            { filterType: "LOT_SIZE", stepSize: "0.001", minQty: "0.001" },
            { filterType: "MARKET_LOT_SIZE", stepSize: "0.01", minQty: "0.02" },
            { filterType: "MIN_NOTIONAL", notional: "5" },
          ],
        },
        {
          symbol: "NEWUSDT",
          baseAsset: "NEW",
          quoteAsset: "USDT",
          marginAsset: "USDT",
          contractType: "PERPETUAL",
          status: "TRADING",
          onboardDate: NOW - 2 * 86_400_000,
          filters: [],
        },
      ],
    }, NOW);
    expect(result).toEqual([expect.objectContaining({
      symbol: "BTCUSDT",
      tickSize: 0.1,
      stepSize: 0.01,
      minQuantity: 0.02,
      minNotional: 5,
      maintenanceMarginRate: 1,
      maintenanceMarginSource: "unavailable",
    })]);
  });

  it("treats REST bars as final only after closeTime and WS k.x as authoritative", () => {
    const bars = normalizeRestKlines("BTCUSDT", [
      tuple(NOW - 120_000, NOW - 60_001),
      tuple(NOW - 60_000, NOW + 1),
    ], NOW);
    expect(bars.map((bar) => bar.final)).toEqual([true, false]);

    const forming = normalizeBinanceWebsocketEvent({
      e: "kline",
      s: "BTCUSDT",
      k: {
        t: NOW - 60_000,
        T: NOW - 1,
        i: "1m",
        o: "100",
        h: "102",
        l: "99",
        c: "101",
        v: "10",
        q: "1000",
        n: 10,
        x: false,
      },
    }, NOW)!;
    expect(isModelDecisionEvent(forming)).toBe(false);
    if (forming.kind !== "kline") {
      throw new Error("Expected a normalized kline event.");
    }
    expect(isModelDecisionEvent({ ...forming, final: true })).toBe(true);
  });

  it("never lets REST gap recovery overwrite a confirmed websocket bar", () => {
    const store = new CausalBinanceKlineStore();
    const event = normalizeBinanceWebsocketEvent({
      e: "kline",
      s: "BTCUSDT",
      k: {
        t: NOW - 120_000,
        T: NOW - 60_001,
        i: "1m",
        o: "100",
        h: "102",
        l: "99",
        c: "101",
        v: "10",
        q: "1000",
        n: 10,
        x: true,
      },
    }, NOW)!;
    store.applyWebsocket(event);
    expect(store.applyRest("BTCUSDT", [
      tuple(NOW - 120_000, NOW - 60_001, "80"),
    ], NOW)).toEqual([]);
    expect(store.list("BTCUSDT")[0]?.close).toBe(101);
  });

  it("reconnects once after an error/close pair and resumes normalized events", async () => {
    const first = new TestConnection();
    const second = new TestConnection();
    const connections = [first, second];
    const connectionFactory = vi.fn(async () => connections.shift()!);
    const clock = new TestReconnectClock();
    const onEvent = vi.fn();
    const onDisconnect = vi.fn();
    const onState = vi.fn();
    const streams = new OfficialBinanceUsdmPublicStreams({
      connectionFactory,
      clock,
      maxReconnectAttempts: 3,
      initialReconnectDelayMs: 25,
      maximumReconnectDelayMs: 100,
    });

    const subscription = await streams.subscribe(
      ["btcusdt", "BTCUSDT"],
      onEvent,
      onDisconnect,
      onState,
    );
    expect(connectionFactory).toHaveBeenCalledWith([
      "btcusdt@kline_1m",
      "btcusdt@aggTrade",
      "btcusdt@bookTicker",
      "btcusdt@markPrice@1s",
    ]);
    expect(onState).toHaveBeenLastCalledWith({
      status: "connected",
      generation: 1,
      reconnectAttempt: 0,
    });

    const failure = new Error("transient");
    first.emitError(failure);
    first.emitClose();
    expect(clock.size).toBe(1);
    expect(clock.delays).toEqual([25]);
    expect(onDisconnect).not.toHaveBeenCalled();
    expect(onState).toHaveBeenLastCalledWith({
      status: "reconnecting",
      generation: 1,
      reconnectAttempt: 1,
      error: failure,
    });

    await clock.runNext();
    expect(connectionFactory).toHaveBeenCalledTimes(2);
    expect(first.disconnect).toHaveBeenCalledTimes(1);
    expect(onDisconnect).not.toHaveBeenCalled();
    expect(onState).toHaveBeenLastCalledWith({
      status: "connected",
      generation: 2,
      reconnectAttempt: 1,
    });

    second.emitMessage({
      e: "aggTrade",
      s: "BTCUSDT",
      a: 17,
      p: "100.5",
      q: "0.25",
      T: NOW,
      m: false,
    });
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({
      kind: "agg_trade",
      symbol: "BTCUSDT",
      price: 100.5,
    }));

    await subscription.close();
    await subscription.close();
    expect(first.disconnect).toHaveBeenCalledTimes(1);
    expect(second.disconnect).toHaveBeenCalledTimes(1);
  });

  it("notifies the runtime only after bounded reconnect attempts are exhausted", async () => {
    const first = new TestConnection();
    const finalFailure = new Error("still unavailable");
    const connectionFactory = vi.fn()
      .mockResolvedValueOnce(first)
      .mockRejectedValueOnce(new Error("temporarily unavailable"))
      .mockRejectedValueOnce(finalFailure);
    const clock = new TestReconnectClock();
    const onDisconnect = vi.fn();
    const streams = new OfficialBinanceUsdmPublicStreams({
      connectionFactory,
      clock,
      maxReconnectAttempts: 2,
      initialReconnectDelayMs: 10,
      maximumReconnectDelayMs: 20,
    });

    const subscription = await streams.subscribe(["BTCUSDT"], vi.fn(), onDisconnect);
    first.emitClose();
    await clock.runNext();
    expect(onDisconnect).not.toHaveBeenCalled();
    expect(clock.delays).toEqual([10, 20]);

    await clock.runNext();
    expect(connectionFactory).toHaveBeenCalledTimes(3);
    expect(onDisconnect).toHaveBeenCalledTimes(1);
    expect(onDisconnect).toHaveBeenCalledWith(finalFailure);
    expect(first.disconnect).toHaveBeenCalledTimes(1);

    await subscription.close();
    expect(first.disconnect).toHaveBeenCalledTimes(1);
  });

  it("cancels a queued reconnect when explicitly closed", async () => {
    const first = new TestConnection();
    const connectionFactory = vi.fn().mockResolvedValue(first);
    const clock = new TestReconnectClock();
    const onDisconnect = vi.fn();
    const streams = new OfficialBinanceUsdmPublicStreams({
      connectionFactory,
      clock,
      initialReconnectDelayMs: 10,
      maximumReconnectDelayMs: 20,
    });

    const subscription = await streams.subscribe(["BTCUSDT"], vi.fn(), onDisconnect);
    first.emitError(new Error("transient"));
    first.emitClose();
    expect(clock.size).toBe(1);

    await subscription.close();
    expect(clock.size).toBe(0);
    expect(connectionFactory).toHaveBeenCalledTimes(1);
    expect(first.disconnect).toHaveBeenCalledTimes(1);
    expect(onDisconnect).not.toHaveBeenCalled();
  });

  it("closes a connection that resolves after shutdown without reconnecting again", async () => {
    const first = new TestConnection();
    const late = new TestConnection();
    let resolveLate!: (connection: BinancePublicStreamConnection) => void;
    const connectionFactory = vi.fn()
      .mockResolvedValueOnce(first)
      .mockImplementationOnce(() => new Promise<BinancePublicStreamConnection>((resolve) => {
        resolveLate = resolve;
      }));
    const clock = new TestReconnectClock();
    const onDisconnect = vi.fn();
    const streams = new OfficialBinanceUsdmPublicStreams({
      connectionFactory,
      clock,
      initialReconnectDelayMs: 10,
      maximumReconnectDelayMs: 20,
    });

    const subscription = await streams.subscribe(["BTCUSDT"], vi.fn(), onDisconnect);
    first.emitClose();
    await clock.runNext();
    expect(connectionFactory).toHaveBeenCalledTimes(2);

    const closing = subscription.close();
    resolveLate(late);
    await closing;
    late.emitClose();

    expect(first.disconnect).toHaveBeenCalledTimes(1);
    expect(late.disconnect).toHaveBeenCalledTimes(1);
    expect(connectionFactory).toHaveBeenCalledTimes(2);
    expect(onDisconnect).not.toHaveBeenCalled();
  });
});
