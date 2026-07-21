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
