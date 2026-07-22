import { describe, expect, it } from "vitest";
import {
  DEFAULT_KR_INTEGRATED_SESSION_WINDOWS,
  DEFAULT_US_EXTENDED_SESSION_WINDOWS,
  marketLocalTimestamp,
  marketSessionEffectiveMinute,
  marketSessionWindowAnchor,
  marketTradingSessionDate,
  sessionWindowForBarClose,
  sessionWindowForTrade,
  validateSessionWindows,
} from "./market-session.js";

describe("KRX/NXT integrated session schedule", () => {
  it("models the official pre, regular, and after-market execution windows with explicit breaks", () => {
    expect(DEFAULT_KR_INTEGRATED_SESSION_WINDOWS).toEqual([
      { kind: "pre_market", openMinute: 480, closeMinute: 530 },
      { kind: "regular_market", openMinute: 540, closeMinute: 930 },
      { kind: "after_market", openMinute: 940, closeMinute: 1_200 },
    ]);
    expect(sessionWindowForTrade("2026-07-22T15:35:00+09:00", "KR", DEFAULT_KR_INTEGRATED_SESSION_WINDOWS)).toBeUndefined();
    expect(sessionWindowForTrade("2026-07-22T15:40:00+09:00", "KR", DEFAULT_KR_INTEGRATED_SESSION_WINDOWS)?.kind).toBe("after_market");
    expect(sessionWindowForBarClose("2026-07-22T15:40:00+09:00", "KR", DEFAULT_KR_INTEGRATED_SESSION_WINDOWS)).toBeUndefined();
    expect(sessionWindowForBarClose("2026-07-22T15:41:00+09:00", "KR", DEFAULT_KR_INTEGRATED_SESSION_WINDOWS)?.kind).toBe("after_market");
  });

  it("anchors each active window independently and rejects overlapping configuration", () => {
    expect(marketSessionWindowAnchor(
      "2026-07-22",
      "2026-07-22T16:12:30+09:00",
      "KR",
      DEFAULT_KR_INTEGRATED_SESSION_WINDOWS,
    )).toBe("2026-07-22T06:40:00.000Z");
    expect(() => validateSessionWindows([
      { kind: "pre_market", openMinute: 480, closeMinute: 550 },
      { kind: "regular_market", openMinute: 540, closeMinute: 930 },
    ])).toThrow(/sorted and must not overlap/);
  });

  it("represents early KST bars with their exchange-local date for the Rust contract", () => {
    expect(marketLocalTimestamp("2026-07-21T23:01:00.000Z", "KR"))
      .toBe("2026-07-22T08:01:00.000+09:00");
  });

  it("represents US bars in New York local time with the observed DST offset", () => {
    expect(marketLocalTimestamp("2026-07-21T13:31:00.125Z", "US"))
      .toBe("2026-07-21T09:31:00.125-04:00");
    expect(marketLocalTimestamp("2026-01-21T14:31:00.125Z", "US"))
      .toBe("2026-01-21T09:31:00.125-05:00");
  });

  it("rejects invalid timestamps instead of producing a fabricated local timestamp", () => {
    expect(() => marketLocalTimestamp("not-a-timestamp", "US")).toThrow(/valid RFC3339/);
  });
});

describe("US extended-hours session schedule", () => {
  it("keeps the cross-midnight day market on the following trading-session date", () => {
    expect(DEFAULT_US_EXTENDED_SESSION_WINDOWS).toEqual([
      { kind: "day_market", openMinute: 1_200, closeMinute: 1_440, localDateOffset: -1 },
      { kind: "day_market", openMinute: 0, closeMinute: 240, localDateOffset: 0 },
      { kind: "pre_market", openMinute: 240, closeMinute: 570, localDateOffset: 0 },
      { kind: "regular_market", openMinute: 570, closeMinute: 960, localDateOffset: 0 },
      { kind: "after_market", openMinute: 960, closeMinute: 1_200, localDateOffset: 0 },
    ]);
    expect(marketTradingSessionDate(
      "2026-07-21T20:01:00-04:00",
      "US",
      DEFAULT_US_EXTENDED_SESSION_WINDOWS,
    )).toBe("2026-07-22");
    expect(marketTradingSessionDate(
      "2026-07-22T03:59:00-04:00",
      "US",
      DEFAULT_US_EXTENDED_SESSION_WINDOWS,
    )).toBe("2026-07-22");
    expect(marketSessionEffectiveMinute("2026-07-21T20:01:00-04:00", "2026-07-22", "US")).toBe(-239);
    expect(marketSessionEffectiveMinute("2026-07-22T00:01:00-04:00", "2026-07-22", "US")).toBe(1);
  });

  it("classifies every supported US session and preserves exact boundary ownership", () => {
    expect(sessionWindowForTrade(
      "2026-07-21T20:00:00-04:00", "US", DEFAULT_US_EXTENDED_SESSION_WINDOWS, "2026-07-22",
    )?.kind).toBe("day_market");
    expect(sessionWindowForBarClose(
      "2026-07-22T00:00:00-04:00", "US", DEFAULT_US_EXTENDED_SESSION_WINDOWS, "2026-07-22",
    )?.kind).toBe("day_market");
    expect(sessionWindowForTrade(
      "2026-07-22T04:00:00-04:00", "US", DEFAULT_US_EXTENDED_SESSION_WINDOWS, "2026-07-22",
    )?.kind).toBe("pre_market");
    expect(sessionWindowForTrade(
      "2026-07-22T09:30:00-04:00", "US", DEFAULT_US_EXTENDED_SESSION_WINDOWS, "2026-07-22",
    )?.kind).toBe("regular_market");
    expect(sessionWindowForTrade(
      "2026-07-22T16:00:00-04:00", "US", DEFAULT_US_EXTENDED_SESSION_WINDOWS, "2026-07-22",
    )?.kind).toBe("after_market");
  });

  it("anchors day-market aggregation before midnight without shifting its trading date", () => {
    expect(marketSessionWindowAnchor(
      "2026-07-22",
      "2026-07-21T20:12:30-04:00",
      "US",
      DEFAULT_US_EXTENDED_SESSION_WINDOWS,
    )).toBe("2026-07-22T00:00:00.000Z");
    expect(() => validateSessionWindows([
      { kind: "day_market", openMinute: 1_200, closeMinute: 1_440, localDateOffset: -1 },
      { kind: "pre_market", openMinute: 180, closeMinute: 300, localDateOffset: -1 },
    ])).toThrow(/sorted and must not overlap/);
  });
});
