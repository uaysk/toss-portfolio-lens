import { describe, expect, it } from "vitest";
import type { BinanceMarketEvent } from "./binance-market-data.js";
import {
  AsyncMarketEventQueue,
  MAX_MARKET_EVENT_QUEUE_DEPTH,
} from "./market-event-queue.js";

function book(eventTime: number, bidPrice = eventTime): BinanceMarketEvent {
  return {
    kind: "book_ticker",
    source: "binance_ws",
    symbol: "BTCUSDT",
    bidPrice,
    bidQuantity: 1,
    askPrice: bidPrice + 1,
    askQuantity: 1,
    eventTime,
    receivedAt: eventTime,
  };
}

function trade(
  ingressSequence: number,
  price: number,
): Extract<BinanceMarketEvent, { kind: "agg_trade" }> {
  return {
    kind: "agg_trade",
    source: "binance_ws",
    symbol: "BTCUSDT",
    aggregateTradeId: String(ingressSequence),
    price,
    quantity: 1,
    executedAt: ingressSequence,
    buyerWasMaker: false,
    receivedAt: ingressSequence,
  };
}

describe("AsyncMarketEventQueue", () => {
  it("coalesces replaceable market observations without reordering control events", async () => {
    const queue = new AsyncMarketEventQueue();
    expect(queue.push(book(1, 100))).toBe(true);
    expect(queue.push(book(3, 103))).toBe(true);
    expect(queue.push(book(2, 102))).toBe(true);
    expect(queue.push({ kind: "inference_complete" })).toBe(true);

    const signal = new AbortController().signal;
    const clock = {
      sleep: async () => undefined,
    };
    const latestBook = await queue.next(0, clock, signal);
    const control = await queue.next(0, clock, signal);

    expect(latestBook).toMatchObject({
      kind: "book_ticker",
      eventTime: 3,
      bidPrice: 103,
    });
    expect(control).toEqual({ kind: "inference_complete" });
    expect(queue.stats()).toMatchObject({
      currentDepth: 0,
      coalescedBookTickers: 2,
      overflowCount: 0,
    });
  });

  it("retains a fixed causal aggregate-trade set under an arbitrary burst", async () => {
    const queue = new AsyncMarketEventQueue();
    for (let sequence = 1; sequence <= 2_000; sequence += 1) {
      const fillCandidate = sequence >= 500;
      expect(queue.push(trade(sequence, 100 + Math.sin(sequence) * 10), {
        ingressSequence: sequence,
        fillCandidate,
        fillBarrierKey: fillCandidate ? "decision-1" : undefined,
      })).toBe(true);
    }

    const observed: number[] = [];
    const signal = new AbortController().signal;
    const clock = {
      sleep: async () => undefined,
    };
    for (;;) {
      const event = await queue.next(0, clock, signal);
      if (!event) break;
      if (event.kind === "agg_trade") observed.push(Number(event.aggregateTradeId));
    }

    expect(observed).toContain(1);
    expect(observed).toContain(500);
    expect(observed).toContain(2_000);
    expect(observed.length).toBeLessThanOrEqual(10);
    expect(queue.stats()).toMatchObject({
      maximumAllowedDepth: MAX_MARKET_EVENT_QUEUE_DEPTH,
      overflowCount: 0,
    });
    expect(queue.stats().droppedAggTrades).toBeGreaterThan(1_900);
  });

  it("fails closed on bounded overflow and always delivers a disconnect", async () => {
    const queue = new AsyncMarketEventQueue();
    for (let index = 0; index < MAX_MARKET_EVENT_QUEUE_DEPTH; index += 1) {
      expect(queue.push({ kind: "inference_complete" })).toBe(true);
    }
    expect(queue.push({ kind: "inference_complete" })).toBe(false);
    expect(queue.stats()).toMatchObject({
      currentDepth: MAX_MARKET_EVENT_QUEUE_DEPTH,
      overflowCount: 1,
    });

    queue.fail(new Error("stream disconnected"));
    const event = await queue.next(
      0,
      { sleep: async () => undefined },
      new AbortController().signal,
    );
    expect(event).toMatchObject({
      kind: "disconnect",
      error: expect.objectContaining({ message: "stream disconnected" }),
    });
    expect(queue.stats().currentDepth).toBe(0);
  });
});
