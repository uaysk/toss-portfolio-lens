import { describe, expect, it, vi } from "vitest";
import {
  validateFincastFutureTimestamps,
  validateFincastMarketSequence,
} from "./fincast-market-cadence.js";
import { DEFAULT_KR_INTEGRATED_SESSION_WINDOWS } from "./market-session.js";
import type { TossMarketCalendarDay } from "./toss-provider.js";

function krCalendar(sessionDate: string): TossMarketCalendarDay {
  return {
    marketCountry: "KR",
    sessionDate,
    dayMarket: null,
    preMarket: null,
    regularMarket: {
      startAt: `${sessionDate}T00:00:00.000Z`,
      endAt: `${sessionDate}T06:30:00.000Z`,
    },
    afterMarket: null,
  };
}

function usCalendar(
  sessionDate: string,
  regularStart = "14:30",
  regularEnd = "21:00",
): TossMarketCalendarDay {
  return {
    marketCountry: "US",
    sessionDate,
    dayMarket: null,
    preMarket: null,
    regularMarket: {
      startAt: `${sessionDate}T${regularStart}:00.000Z`,
      endAt: `${sessionDate}T${regularEnd}:00.000Z`,
    },
    afterMarket: null,
  };
}

function closedUsCalendar(sessionDate: string): TossMarketCalendarDay {
  return {
    marketCountry: "US",
    sessionDate,
    dayMarket: null,
    preMarket: null,
    regularMarket: null,
    afterMarket: null,
  };
}

describe("FinCast calendar-confirmed stock cadence", () => {
  it("rejects a missing minute inside an active KR session", async () => {
    const result = await validateFincastMarketSequence({
      marketCountry: "KR",
      krWindows: DEFAULT_KR_INTEGRATED_SESSION_WINDOWS,
      loadCalendar: vi.fn(async () => krCalendar("2026-07-21")),
      bars: [
        { closeTime: "2026-07-21T09:31:00+09:00", sessionDate: "2026-07-21" },
        { closeTime: "2026-07-21T09:33:00+09:00", sessionDate: "2026-07-21" },
      ],
    });

    expect(result).toEqual({
      status: "unavailable",
      code: "fincast_market_cadence_invalid",
    });
  });

  it("accepts the configured KR break only when the date-specific calendar confirms an open normal day", async () => {
    const loadCalendar = vi.fn(async () => krCalendar("2026-07-21"));
    const result = await validateFincastMarketSequence({
      marketCountry: "KR",
      krWindows: DEFAULT_KR_INTEGRATED_SESSION_WINDOWS,
      loadCalendar,
      bars: [
        { closeTime: "2026-07-21T08:49:00+09:00", sessionDate: "2026-07-21" },
        { closeTime: "2026-07-21T08:50:00+09:00", sessionDate: "2026-07-21" },
        { closeTime: "2026-07-21T09:01:00+09:00", sessionDate: "2026-07-21" },
        { closeTime: "2026-07-21T09:02:00+09:00", sessionDate: "2026-07-21" },
      ],
    });

    expect(result).toEqual({ status: "available" });
    expect(loadCalendar).toHaveBeenCalledTimes(1);
  });

  it("accepts a calendar-confirmed overnight for a regular-session-only KR instrument", async () => {
    const regularWindows = DEFAULT_KR_INTEGRATED_SESSION_WINDOWS.filter(
      ({ kind }) => kind === "regular_market",
    );
    const calendars = new Map<string, TossMarketCalendarDay>([
      ["2026-07-21", krCalendar("2026-07-21")],
      ["2026-07-22", krCalendar("2026-07-22")],
    ]);
    const result = await validateFincastMarketSequence({
      marketCountry: "KR",
      krWindows: regularWindows,
      loadCalendar: async (sessionDate) => calendars.get(sessionDate),
      bars: [
        { closeTime: "2026-07-21T15:29:00+09:00", sessionDate: "2026-07-21" },
        { closeTime: "2026-07-21T15:30:00+09:00", sessionDate: "2026-07-21" },
        { closeTime: "2026-07-22T09:01:00+09:00", sessionDate: "2026-07-22" },
        { closeTime: "2026-07-22T09:02:00+09:00", sessionDate: "2026-07-22" },
      ],
    });

    expect(result).toEqual({ status: "available" });
  });

  it("accepts an overnight weekend only after every intervening US closure is calendar-confirmed", async () => {
    const calendars = new Map<string, TossMarketCalendarDay>([
      ["2026-01-09", usCalendar("2026-01-09")],
      ["2026-01-10", closedUsCalendar("2026-01-10")],
      ["2026-01-11", closedUsCalendar("2026-01-11")],
      ["2026-01-12", usCalendar("2026-01-12")],
    ]);
    const loadCalendar = vi.fn(async (sessionDate: string) => calendars.get(sessionDate));
    const result = await validateFincastMarketSequence({
      marketCountry: "US",
      krWindows: DEFAULT_KR_INTEGRATED_SESSION_WINDOWS,
      loadCalendar,
      bars: [
        { closeTime: "2026-01-09T20:59:00.000Z", sessionDate: "2026-01-09" },
        { closeTime: "2026-01-09T21:00:00.000Z", sessionDate: "2026-01-09" },
        { closeTime: "2026-01-12T14:31:00.000Z", sessionDate: "2026-01-12" },
        { closeTime: "2026-01-12T14:32:00.000Z", sessionDate: "2026-01-12" },
      ],
    });

    expect(result).toEqual({ status: "available" });
    expect(loadCalendar.mock.calls.map(([date]) => date)).toEqual([
      "2026-01-09",
      "2026-01-10",
      "2026-01-11",
      "2026-01-12",
    ]);
  });

  it("rejects an arbitrary cross-session gap when an intervening US trading day was open", async () => {
    const calendars = new Map<string, TossMarketCalendarDay>([
      ["2026-01-09", usCalendar("2026-01-09")],
      ["2026-01-10", closedUsCalendar("2026-01-10")],
      ["2026-01-11", closedUsCalendar("2026-01-11")],
      ["2026-01-12", usCalendar("2026-01-12")],
      ["2026-01-13", usCalendar("2026-01-13")],
    ]);
    const result = await validateFincastMarketSequence({
      marketCountry: "US",
      krWindows: DEFAULT_KR_INTEGRATED_SESSION_WINDOWS,
      loadCalendar: async (sessionDate) => calendars.get(sessionDate),
      bars: [
        { closeTime: "2026-01-09T21:00:00.000Z", sessionDate: "2026-01-09" },
        { closeTime: "2026-01-13T14:31:00.000Z", sessionDate: "2026-01-13" },
      ],
    });

    expect(result).toEqual({
      status: "unavailable",
      code: "fincast_market_cadence_invalid",
    });
  });

  it("honors a US early close and validates the next 60 scheduled timestamps", async () => {
    const calendars = new Map<string, TossMarketCalendarDay>([
      ["2026-11-27", usCalendar("2026-11-27", "14:30", "18:00")],
      ["2026-11-28", closedUsCalendar("2026-11-28")],
      ["2026-11-29", closedUsCalendar("2026-11-29")],
      ["2026-11-30", usCalendar("2026-11-30")],
    ]);
    const future = Array.from({ length: 60 }, (_unused, index) => (
      new Date(Date.parse("2026-11-30T14:31:00.000Z") + index * 60_000).toISOString()
    ));
    const result = await validateFincastFutureTimestamps({
      marketCountry: "US",
      krWindows: DEFAULT_KR_INTEGRATED_SESSION_WINDOWS,
      loadCalendar: async (sessionDate) => calendars.get(sessionDate),
      last: {
        closeTime: "2026-11-27T18:00:00.000Z",
        sessionDate: "2026-11-27",
      },
      futureTimestamps: future,
      lookaheadDays: 3,
    });

    expect(result).toEqual({ status: "available" });
  });

  it("fails closed when any required calendar day is unavailable", async () => {
    const result = await validateFincastMarketSequence({
      marketCountry: "US",
      krWindows: DEFAULT_KR_INTEGRATED_SESSION_WINDOWS,
      loadCalendar: async (sessionDate) => (
        sessionDate === "2026-01-10" ? undefined : (
          sessionDate === "2026-01-09"
            ? usCalendar(sessionDate)
            : usCalendar(sessionDate)
        )
      ),
      bars: [
        { closeTime: "2026-01-09T21:00:00.000Z", sessionDate: "2026-01-09" },
        { closeTime: "2026-01-12T14:31:00.000Z", sessionDate: "2026-01-12" },
      ],
    });

    expect(result).toEqual({
      status: "unavailable",
      code: "fincast_market_calendar_unavailable",
    });
  });
});
