import { beforeEach, describe, expect, it, vi } from "vitest";

const sdkMocks = vi.hoisted(() => ({
  connect: vi.fn(),
  construct: vi.fn(),
}));

vi.mock("@binance/derivatives-trading-usds-futures", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@binance/derivatives-trading-usds-futures")
  >();
  return {
    ...actual,
    DerivativesTradingUsdsFutures: class {
      readonly websocketStreams = { connect: sdkMocks.connect };

      constructor(configuration: unknown) {
        sdkMocks.construct(configuration);
      }
    },
  };
});

import { OfficialBinanceUsdmPublicStreams } from "./binance-market-data.js";

const NOW = Date.parse("2026-07-25T00:02:00.000Z");

class TestTypedStream {
  private listener: ((data: unknown) => void | Promise<void>) | undefined;

  readonly on = vi.fn((
    event: "message",
    listener: (data: unknown) => void | Promise<void>,
  ) => {
    expect(event).toBe("message");
    this.listener = listener;
  });

  emit(data: unknown): void {
    void this.listener?.(data);
  }
}

function createSdkConnection() {
  const listeners = {
    error: [] as Array<(error: unknown) => void>,
    close: [] as Array<() => void>,
  };
  const typed = {
    aggregateTrade: new TestTypedStream(),
    bookTicker: new TestTypedStream(),
    kline: new TestTypedStream(),
    markPrice: new TestTypedStream(),
  };
  const connection = {
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      if (event === "error") {
        listeners.error.push(listener as (error: unknown) => void);
      } else if (event === "close") {
        listeners.close.push(listener as () => void);
      }
    }),
    disconnect: vi.fn(async () => undefined),
    aggregateTradeStreams: vi.fn(() => typed.aggregateTrade),
    individualSymbolBookTickerStreams: vi.fn(() => typed.bookTicker),
    klineCandlestickStreams: vi.fn(() => typed.kline),
    markPriceStream: vi.fn(() => typed.markPrice),
  };
  return { connection, listeners, typed };
}

describe("official Binance USD-M typed stream adapter", () => {
  beforeEach(() => {
    sdkMocks.connect.mockReset();
    sdkMocks.construct.mockReset();
  });

  it("connects without raw URL streams and subscribes on each generated API path", async () => {
    const sdk = createSdkConnection();
    sdkMocks.connect.mockResolvedValue(sdk.connection);
    const onEvent = vi.fn();
    const streams = new OfficialBinanceUsdmPublicStreams();

    const subscription = await streams.subscribe(["BTCUSDT"], onEvent);

    expect(sdkMocks.connect).toHaveBeenCalledTimes(1);
    expect(sdkMocks.connect.mock.calls[0]).toEqual([]);
    expect(sdk.connection.klineCandlestickStreams).toHaveBeenCalledWith({
      symbol: "btcusdt",
      interval: "1m",
    });
    expect(sdk.connection.aggregateTradeStreams).toHaveBeenCalledWith({
      symbol: "btcusdt",
    });
    expect(sdk.connection.individualSymbolBookTickerStreams).toHaveBeenCalledWith({
      symbol: "btcusdt",
    });
    expect(sdk.connection.markPriceStream).toHaveBeenCalledWith({
      symbol: "btcusdt",
      updateSpeed: "1s",
    });

    sdk.typed.kline.emit({
      e: "kline",
      E: NOW,
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
        n: 20,
        x: true,
      },
    });
    sdk.typed.aggregateTrade.emit({
      e: "aggTrade",
      E: NOW,
      s: "BTCUSDT",
      a: 17,
      p: "100.5",
      q: "0.25",
      T: NOW,
      m: false,
    });
    sdk.typed.bookTicker.emit({
      e: "bookTicker",
      E: NOW,
      s: "BTCUSDT",
      b: "100",
      B: "2",
      a: "101",
      A: "3",
    });
    sdk.typed.markPrice.emit({
      e: "markPriceUpdate",
      E: NOW,
      s: "BTCUSDT",
      p: "100.5",
      i: "100.4",
      r: "0.0001",
      T: NOW + 3_600_000,
    });

    expect(onEvent.mock.calls.map(([event]) => event.kind)).toEqual([
      "kline",
      "agg_trade",
      "book_ticker",
      "mark_price",
    ]);
    expect(sdk.connection.on).toHaveBeenCalledWith("error", expect.any(Function));
    expect(sdk.connection.on).toHaveBeenCalledWith("close", expect.any(Function));

    await subscription.close();
    await subscription.close();
    expect(sdk.connection.disconnect).toHaveBeenCalledTimes(1);
  });

  it("forwards SDK errors through the logical connection terminal contract", async () => {
    const sdk = createSdkConnection();
    sdkMocks.connect.mockResolvedValue(sdk.connection);
    const onDisconnect = vi.fn();
    const streams = new OfficialBinanceUsdmPublicStreams({
      maxReconnectAttempts: 0,
    });
    const subscription = await streams.subscribe(["ETHUSDT"], vi.fn(), onDisconnect);
    const failure = new Error("market path unavailable");

    sdk.listeners.error[0]?.(failure);
    sdk.listeners.close[0]?.();

    expect(onDisconnect).toHaveBeenCalledTimes(1);
    expect(onDisconnect).toHaveBeenCalledWith(failure);
    await vi.waitFor(() => {
      expect(sdk.connection.disconnect).toHaveBeenCalledTimes(1);
    });
    await subscription.close();
    expect(sdk.connection.disconnect).toHaveBeenCalledTimes(1);
  });
});
