import type { MarketCountry } from "./contracts.js";
import { marketLocalParts, marketSessionAnchor, marketTimeZone, zonedTimestamp } from "./market-time.js";

export type MarketSessionWindowKind = "day_market" | "pre_market" | "regular_market" | "after_market";

export type MarketSessionWindow = {
  kind: MarketSessionWindowKind;
  openMinute: number;
  closeMinute: number;
  /** Local calendar-day offset from the trading session date. */
  localDateOffset?: -1 | 0;
};

export type KrIntegratedSessionConfig = {
  preMarketOpenMinuteKst: number;
  preMarketCloseMinuteKst: number;
  regularMarketOpenMinuteKst: number;
  regularMarketCloseMinuteKst: number;
  afterMarketOpenMinuteKst: number;
  afterMarketCloseMinuteKst: number;
};

/**
 * Fallback schedule only. Live/future scheduling is confirmed against Toss's
 * date-specific market calendar before signals or AI forecasts are emitted.
 *
 * The US day market belongs to the following trading date and crosses New
 * York midnight, so it is represented by two contiguous windows on one
 * effective trading-session axis: -04:00..00:00 and 00:00..04:00.
 */
export const DEFAULT_US_EXTENDED_SESSION_WINDOWS: readonly MarketSessionWindow[] = [
  { kind: "day_market", openMinute: 20 * 60, closeMinute: 24 * 60, localDateOffset: -1 },
  { kind: "day_market", openMinute: 0, closeMinute: 4 * 60, localDateOffset: 0 },
  { kind: "pre_market", openMinute: 4 * 60, closeMinute: 9 * 60 + 30, localDateOffset: 0 },
  { kind: "regular_market", openMinute: 9 * 60 + 30, closeMinute: 16 * 60, localDateOffset: 0 },
  { kind: "after_market", openMinute: 16 * 60, closeMinute: 20 * 60, localDateOffset: 0 },
];

export const DEFAULT_KR_INTEGRATED_SESSION_WINDOWS: readonly MarketSessionWindow[] = [
  { kind: "pre_market", openMinute: 8 * 60, closeMinute: 8 * 60 + 50 },
  { kind: "regular_market", openMinute: 9 * 60, closeMinute: 15 * 60 + 30 },
  { kind: "after_market", openMinute: 15 * 60 + 40, closeMinute: 20 * 60 },
];

export function krIntegratedSessionWindows(
  config: KrIntegratedSessionConfig,
): readonly MarketSessionWindow[] {
  const windows: readonly MarketSessionWindow[] = [
    { kind: "pre_market", openMinute: config.preMarketOpenMinuteKst, closeMinute: config.preMarketCloseMinuteKst },
    { kind: "regular_market", openMinute: config.regularMarketOpenMinuteKst, closeMinute: config.regularMarketCloseMinuteKst },
    { kind: "after_market", openMinute: config.afterMarketOpenMinuteKst, closeMinute: config.afterMarketCloseMinuteKst },
  ];
  validateSessionWindows(windows);
  return windows;
}

export function validateSessionWindows(windows: readonly MarketSessionWindow[]): void {
  if (!windows.length) throw new Error("market session windows must not be empty.");
  let previousClose = Number.NEGATIVE_INFINITY;
  for (const window of windows) {
    if (!Number.isInteger(window.openMinute) || !Number.isInteger(window.closeMinute)
      || window.openMinute < 0 || window.closeMinute > 24 * 60 || window.openMinute >= window.closeMinute) {
      throw new Error(`market session window ${window.kind} has an invalid minute range.`);
    }
    const offset = window.localDateOffset ?? 0;
    if (offset !== -1 && offset !== 0) throw new Error(`market session window ${window.kind} has an invalid local-date offset.`);
    const effectiveOpen = offset * 24 * 60 + window.openMinute;
    const effectiveClose = offset * 24 * 60 + window.closeMinute;
    if (effectiveOpen < previousClose) throw new Error("market session windows must be sorted and must not overlap.");
    previousClose = effectiveClose;
  }
}

export function marketSessionWindows(
  marketCountry: MarketCountry,
  krWindows: readonly MarketSessionWindow[],
): readonly MarketSessionWindow[] {
  return marketCountry === "US" ? DEFAULT_US_EXTENDED_SESSION_WINDOWS : krWindows;
}

function compactIsoDate(value: string): string {
  return value.replaceAll("-", "");
}

function shiftedSessionDate(sessionDate: string, days: number): string {
  const epoch = Date.parse(`${sessionDate}T00:00:00.000Z`);
  if (!Number.isFinite(epoch)) throw new Error("sessionDate must be YYYY-MM-DD.");
  return new Date(epoch + days * 24 * 60 * 60_000).toISOString().slice(0, 10);
}

function localDate(timestamp: string, marketCountry: MarketCountry): string {
  const parts = marketLocalParts(Date.parse(timestamp), marketCountry);
  return `${parts.date.slice(0, 4)}-${parts.date.slice(4, 6)}-${parts.date.slice(6, 8)}`;
}

function calendarDayDelta(left: string, right: string): number | undefined {
  const leftEpoch = Date.parse(`${left}T00:00:00.000Z`);
  const rightEpoch = Date.parse(`${right}T00:00:00.000Z`);
  if (!Number.isFinite(leftEpoch) || !Number.isFinite(rightEpoch)) return undefined;
  return Math.round((leftEpoch - rightEpoch) / (24 * 60 * 60_000));
}

export function marketSessionEffectiveMinute(
  timestamp: string,
  sessionDate: string,
  marketCountry: MarketCountry,
): number | undefined {
  const delta = calendarDayDelta(localDate(timestamp, marketCountry), sessionDate);
  if (delta === undefined) return undefined;
  return delta * 24 * 60 + marketMinuteOfDay(timestamp, marketCountry);
}

export function marketTradingSessionDate(
  timestamp: string,
  marketCountry: MarketCountry,
  windows: readonly MarketSessionWindow[],
): string | undefined {
  const minute = marketMinuteOfDay(timestamp, marketCountry);
  const window = windows.find((candidate) => minute >= candidate.openMinute && minute < candidate.closeMinute);
  if (!window) return undefined;
  return shiftedSessionDate(localDate(timestamp, marketCountry), -(window.localDateOffset ?? 0));
}

export function marketMinuteOfDay(timestamp: string, marketCountry: MarketCountry): number {
  const local = marketLocalParts(Date.parse(timestamp), marketCountry);
  return Number(local.time.slice(0, 2)) * 60 + Number(local.time.slice(2, 4));
}

export function sessionWindowForBarClose(
  timestamp: string,
  marketCountry: MarketCountry,
  windows: readonly MarketSessionWindow[],
  sessionDate?: string,
): MarketSessionWindow | undefined {
  const minute = marketMinuteOfDay(timestamp, marketCountry);
  if (sessionDate) {
    const effectiveMinute = marketSessionEffectiveMinute(timestamp, sessionDate, marketCountry);
    if (effectiveMinute === undefined) return undefined;
    return windows.find((window) => {
      const offset = window.localDateOffset ?? 0;
      return effectiveMinute > offset * 24 * 60 + window.openMinute
        && effectiveMinute <= offset * 24 * 60 + window.closeMinute;
    });
  }
  return windows.find((window) => (
    (minute > window.openMinute && minute <= window.closeMinute)
    || (minute === 0 && window.closeMinute === 24 * 60)
  ));
}

export function sessionWindowForTrade(
  timestamp: string,
  marketCountry: MarketCountry,
  windows: readonly MarketSessionWindow[],
  sessionDate?: string,
): MarketSessionWindow | undefined {
  const minute = marketMinuteOfDay(timestamp, marketCountry);
  if (sessionDate) {
    const effectiveMinute = marketSessionEffectiveMinute(timestamp, sessionDate, marketCountry);
    if (effectiveMinute === undefined) return undefined;
    return windows.find((window) => {
      const offset = window.localDateOffset ?? 0;
      return effectiveMinute >= offset * 24 * 60 + window.openMinute
        && effectiveMinute < offset * 24 * 60 + window.closeMinute;
    });
  }
  return windows.find((window) => minute >= window.openMinute && minute < window.closeMinute);
}

export function marketSessionWindowAnchor(
  sessionDate: string,
  timestamp: string,
  marketCountry: MarketCountry,
  krWindows: readonly MarketSessionWindow[],
): string {
  const window = sessionWindowForTrade(timestamp, marketCountry, krWindows, sessionDate);
  if (!window) return marketSessionAnchor(sessionDate, marketCountry);
  const hour = String(Math.floor(window.openMinute / 60)).padStart(2, "0");
  const minute = String(window.openMinute % 60).padStart(2, "0");
  const anchor = zonedTimestamp(
    compactIsoDate(shiftedSessionDate(sessionDate, window.localDateOffset ?? 0)),
    `${hour}${minute}00`,
    marketTimeZone(marketCountry),
  );
  if (!anchor) throw new Error("Market session-window anchor could not be resolved.");
  return anchor;
}

export function marketLocalTimestamp(timestamp: string, marketCountry: MarketCountry): string {
  const epoch = Date.parse(timestamp);
  if (!Number.isFinite(epoch)) throw new Error("timestamp must be valid RFC3339.");
  const local = marketLocalParts(epoch, marketCountry);
  const localEpoch = Date.UTC(
    Number(local.date.slice(0, 4)),
    Number(local.date.slice(4, 6)) - 1,
    Number(local.date.slice(6, 8)),
    Number(local.time.slice(0, 2)),
    Number(local.time.slice(2, 4)),
    Number(local.time.slice(4, 6)),
    epoch % 1_000,
  );
  const offsetMinutes = Math.round((localEpoch - epoch) / 60_000);
  const sign = offsetMinutes < 0 ? "-" : "+";
  const absoluteOffset = Math.abs(offsetMinutes);
  const offset = `${sign}${String(Math.floor(absoluteOffset / 60)).padStart(2, "0")}:${String(absoluteOffset % 60).padStart(2, "0")}`;
  return `${local.date.slice(0, 4)}-${local.date.slice(4, 6)}-${local.date.slice(6, 8)}`
    + `T${local.time.slice(0, 2)}:${local.time.slice(2, 4)}:${local.time.slice(4, 6)}`
    + `.${String(epoch % 1_000).padStart(3, "0")}${offset}`;
}
