import { describe, expect, it } from "vitest";
import {
  IntradayBarAggregator,
  type IntradayBarAggregatorConfig,
  type IntradayTradeTick,
} from "./intraday-bar-aggregator.js";

function config(overrides: Partial<IntradayBarAggregatorConfig> = {}): IntradayBarAggregatorConfig {
  return {
    allowedLatenessMs: 30_000,
    maximumSeenEventIdsPerSymbol: 100,
    maximumOpenMinuteBucketsPerSymbol: 10,
    finalizedBarRetentionPerInterval: 20,
    higherIntervalsMinutes: [5, 15, 30, 60],
    ...overrides,
  };
}

function tick(
  eventId: string,
  executedAt: string,
  price: number,
  quantity = 1,
  symbol = "005930",
): IntradayTradeTick {
  return {
    symbol,
    eventId,
    executedAt,
    sessionDate: "2026-07-21",
    price,
    quantity,
  };
}

describe("IntradayBarAggregator", () => {
  it("builds event-time OHLC and rejects duplicate events", () => {
    const aggregator = new IntradayBarAggregator(config());
    aggregator.ingest(tick("later", "2026-07-21T09:00:20+09:00", 102, 2));
    const earlier = aggregator.ingest(tick("earlier", "2026-07-21T09:00:10+09:00", 100, 3));
    const lastForming = earlier.updates.findLast(({ bar }) => bar.interval === "1m" && bar.status === "forming")!.bar;
    expect(lastForming).toMatchObject({
      open: 100,
      high: 102,
      low: 100,
      close: 102,
      volume: 5,
      tradeCount: 2,
      status: "forming",
    });
    expect(aggregator.ingest(tick("earlier", "2026-07-21T09:00:10+09:00", 999)).reason).toBe("duplicate");

    const updates = aggregator.advanceWatermark("005930", "2026-07-21T09:01:30+09:00");
    const final = updates.find(({ bar }) => bar.interval === "1m" && bar.status === "final")!.bar;
    expect(final).toMatchObject({ open: 100, close: 102, volume: 5, quality: "available", missingMinuteCount: 0 });
  });

  it("rejects events behind the watermark without revising finalized history", () => {
    const aggregator = new IntradayBarAggregator(config({ allowedLatenessMs: 0 }));
    aggregator.ingest(tick("first", "2026-07-21T09:00:10+09:00", 100));
    aggregator.ingest(tick("next", "2026-07-21T09:02:00+09:00", 102));
    const late = aggregator.ingest(tick("late", "2026-07-21T09:00:50+09:00", 90));
    expect(late).toEqual({ accepted: false, reason: "too_late", updates: [] });
    expect(aggregator.recentFinalBars("005930", "1m")[0]).toMatchObject({ low: 100, close: 100 });
  });

  it("marks the first minute after a connection discontinuity partial", () => {
    const aggregator = new IntradayBarAggregator(config({ allowedLatenessMs: 0 }));
    aggregator.markDiscontinuity("AAPL", "2026-07-21T13:30:30.000Z", "US");
    aggregator.ingest({
      symbol: "AAPL",
      marketCountry: "US",
      eventId: "first-after-connect",
      executedAt: "2026-07-21T13:30:30.000Z",
      sessionDate: "2026-07-21",
      sessionStartAt: "2026-07-21T13:30:00.000Z",
      price: 200,
      quantity: 1,
    });
    aggregator.advanceWatermark("AAPL", "2026-07-21T13:31:00.000Z", "US");
    expect(aggregator.recentFinalBars("AAPL", "1m", "US")[0]).toMatchObject({
      startAt: "2026-07-21T13:30:00.000Z",
      quality: "partial",
      missingMinuteCount: 0,
    });
  });

  it("does not carry a discontinuity marker across hours without trades", () => {
    const aggregator = new IntradayBarAggregator(config({ allowedLatenessMs: 0 }));
    aggregator.markDiscontinuity("AAPL", "2026-07-21T09:30:10.000Z", "US");
    aggregator.ingest({
      symbol: "AAPL",
      marketCountry: "US",
      eventId: "hours-after-connect",
      executedAt: "2026-07-21T13:30:01.000Z",
      sessionDate: "2026-07-21",
      sessionStartAt: "2026-07-21T13:30:00.000Z",
      price: 200,
      quantity: 1,
    });
    aggregator.advanceWatermark("AAPL", "2026-07-21T13:31:00.000Z", "US");
    expect(aggregator.recentFinalBars("AAPL", "1m", "US")[0]).toMatchObject({
      startAt: "2026-07-21T13:30:00.000Z",
      quality: "available",
    });
  });

  it("marks an already forming minute partial when the feed disconnects", () => {
    const aggregator = new IntradayBarAggregator(config({ allowedLatenessMs: 0 }));
    aggregator.ingest({
      symbol: "AAPL",
      marketCountry: "US",
      eventId: "before-disconnect",
      executedAt: "2026-07-21T13:30:01.000Z",
      sessionDate: "2026-07-21",
      price: 200,
      quantity: 1,
    });
    aggregator.markDiscontinuity("AAPL", "2026-07-21T13:30:30.000Z", "US");
    aggregator.advanceWatermark("AAPL", "2026-07-21T13:31:00.000Z", "US");
    expect(aggregator.recentFinalBars("AAPL", "1m", "US")[0]).toMatchObject({ quality: "partial" });
  });

  it("aggregates exactly five finalized minutes and never creates empty minute bars", () => {
    const aggregator = new IntradayBarAggregator(config({ allowedLatenessMs: 0 }));
    for (let minute = 0; minute < 5; minute += 1) {
      aggregator.ingest(tick(
        `event-${minute}`,
        `2026-07-21T09:0${minute}:10+09:00`,
        100 + minute,
        minute + 1,
      ));
    }
    const updates = aggregator.advanceWatermark("005930", "2026-07-21T09:05:00+09:00");
    const five = updates.find(({ bar }) => bar.interval === "5m" && bar.status === "final")!.bar;
    expect(five).toMatchObject({
      startAt: "2026-07-21T00:00:00.000Z",
      endAt: "2026-07-21T00:05:00.000Z",
      open: 100,
      close: 104,
      high: 104,
      low: 100,
      volume: 15,
      tradeCount: 5,
      componentMinuteCount: 5,
      quality: "available",
      missingMinuteCount: 0,
    });
    expect(aggregator.recentFinalBars("005930", "1m")).toHaveLength(5);
  });

  it("marks higher intervals partial when source minutes are missing", () => {
    const aggregator = new IntradayBarAggregator(config({ allowedLatenessMs: 0 }));
    aggregator.ingest(tick("only", "2026-07-21T09:00:10+09:00", 100, 2));
    const updates = aggregator.advanceWatermark("005930", "2026-07-21T09:05:00+09:00");
    const five = updates.find(({ bar }) => bar.interval === "5m" && bar.status === "final")!.bar;
    expect(five).toMatchObject({
      componentMinuteCount: 1,
      missingMinuteCount: 4,
      quality: "partial",
    });
    expect(aggregator.recentFinalBars("005930", "1m")).toHaveLength(1);
  });

  it("clamps a scheduled 60-minute tail to the session close and finalizes it there as partial", () => {
    const aggregator = new IntradayBarAggregator(config({ allowedLatenessMs: 0 }));
    aggregator.ingest({
      ...tick("tail", "2026-07-21T19:40:10+09:00", 100),
      marketCountry: "KR",
      sessionStartAt: "2026-07-21T15:40:00+09:00",
      sessionEndAt: "2026-07-21T20:00:00+09:00",
    });
    const forming = aggregator.advanceWatermark("005930", "2026-07-21T19:41:00+09:00", "KR");
    expect(forming).toContainEqual(expect.objectContaining({
      bar: expect.objectContaining({
        interval: "60m",
        startAt: "2026-07-21T10:40:00.000Z",
        endAt: "2026-07-21T11:00:00.000Z",
        status: "forming",
        quality: "partial",
      }),
    }));

    const finalized = aggregator.advanceWatermark("005930", "2026-07-21T20:00:00+09:00", "KR");
    expect(finalized).toContainEqual(expect.objectContaining({
      bar: expect.objectContaining({
        interval: "60m",
        startAt: "2026-07-21T10:40:00.000Z",
        endAt: "2026-07-21T11:00:00.000Z",
        status: "final",
        quality: "partial",
        missingMinuteCount: 59,
      }),
    }));
  });

  it("finalizes 15/30/60 minute bars from finalized one-minute bars", () => {
    const aggregator = new IntradayBarAggregator(config({ allowedLatenessMs: 0, finalizedBarRetentionPerInterval: 100 }));
    for (let minute = 0; minute < 60; minute += 1) {
      const hour = 9 + Math.floor(minute / 60);
      const minuteInHour = String(minute % 60).padStart(2, "0");
      aggregator.ingest(tick(
        `full-${minute}`,
        `2026-07-21T${String(hour).padStart(2, "0")}:${minuteInHour}:01+09:00`,
        100 + minute,
      ));
    }
    aggregator.advanceWatermark("005930", "2026-07-21T10:00:00+09:00");
    expect(aggregator.recentFinalBars("005930", "15m")).toHaveLength(4);
    expect(aggregator.recentFinalBars("005930", "30m")).toHaveLength(2);
    expect(aggregator.recentFinalBars("005930", "60m")).toHaveLength(1);
    expect(aggregator.recentFinalBars("005930", "60m")[0]).toMatchObject({
      open: 100,
      close: 159,
      componentMinuteCount: 60,
      quality: "available",
    });
  });

  it("anchors US 60-minute bars to 09:30 ET instead of epoch-aligned 09:00", () => {
    const aggregator = new IntradayBarAggregator(config({
      allowedLatenessMs: 0,
      finalizedBarRetentionPerInterval: 100,
    }));
    for (let minute = 0; minute < 60; minute += 1) {
      const executedAt = new Date(Date.parse("2026-07-21T13:30:00.000Z") + minute * 60_000 + 1_000).toISOString();
      aggregator.ingest({
        symbol: "AAPL",
        marketCountry: "US",
        eventId: `us-${minute}`,
        executedAt,
        sessionDate: "2026-07-21",
        sessionStartAt: "2026-07-21T13:30:00.000Z",
        price: 200 + minute,
        quantity: 1,
      });
    }
    aggregator.advanceWatermark("AAPL", "2026-07-21T14:30:00.000Z", "US");
    expect(aggregator.recentFinalBars("AAPL", "60m", "US")).toEqual([
      expect.objectContaining({
        marketCountry: "US",
        startAt: "2026-07-21T13:30:00.000Z",
        endAt: "2026-07-21T14:30:00.000Z",
        open: 200,
        close: 259,
        componentMinuteCount: 60,
        quality: "available",
      }),
    ]);
    expect(aggregator.recentFinalBars("AAPL", "60m", "KR")).toEqual([]);
  });

  it("honors configured retention and capacity guards", () => {
    const aggregator = new IntradayBarAggregator(config({
      allowedLatenessMs: 120_000,
      maximumOpenMinuteBucketsPerSymbol: 1,
      finalizedBarRetentionPerInterval: 1,
    }));
    aggregator.ingest(tick("one", "2026-07-21T09:00:10+09:00", 100));
    expect(() => aggregator.ingest(tick("two", "2026-07-21T09:01:10+09:00", 101))).toThrow(/capacity exceeded/);

    const identifiers = new IntradayBarAggregator(config({
      allowedLatenessMs: 120_000,
      maximumSeenEventIdsPerSymbol: 1,
    }));
    identifiers.ingest(tick("id-one", "2026-07-21T09:00:10+09:00", 100));
    expect(() => identifiers.ingest(tick("id-two", "2026-07-21T09:00:11+09:00", 101)))
      .toThrow(/identifier capacity exceeded/);
    expect(identifiers.ingest(tick("id-one", "2026-07-21T09:00:10+09:00", 100))).toMatchObject({
      accepted: false,
      reason: "duplicate",
    });

    const retained = new IntradayBarAggregator(config({ allowedLatenessMs: 0, finalizedBarRetentionPerInterval: 1 }));
    retained.ingest(tick("a", "2026-07-21T09:00:10+09:00", 100));
    retained.ingest(tick("b", "2026-07-21T09:01:10+09:00", 101));
    retained.advanceWatermark("005930", "2026-07-21T09:02:00+09:00");
    expect(retained.recentFinalBars("005930", "1m")).toHaveLength(1);
    expect(retained.recentFinalBars("005930", "1m")[0]?.close).toBe(101);
  });
});
