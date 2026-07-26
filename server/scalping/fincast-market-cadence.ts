import type { IntradayBarRecord } from "../repositories/scalping-repository.js";
import type { MarketCountry } from "./contracts.js";
import { marketTimeZone, zonedTimestamp } from "./market-time.js";
import type { MarketSessionWindow } from "./market-session.js";
import type { TossMarketCalendarDay, TossMarketSessionPeriod } from "./toss-provider.js";

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

export const FINCAST_MAX_CALENDAR_DAYS_PER_OPERATION = 64;

export type FincastMarketCadenceUnavailableCode =
  | "fincast_market_calendar_unavailable"
  | "fincast_market_cadence_invalid";

export type FincastMarketCadenceResult =
  | { status: "available" }
  | {
      status: "unavailable";
      code: FincastMarketCadenceUnavailableCode;
    };

export type FincastCalendarLoader = (
  sessionDate: string,
) => Promise<TossMarketCalendarDay | undefined>;

type CalendarSession =
  | { status: "closed" }
  | {
      status: "open";
      closes: readonly number[];
    };

type TimestampedSessionClose = {
  timestamp: number;
  sessionDate: string;
};

type CadenceBar = Pick<IntradayBarRecord, "closeTime" | "sessionDate">;

function unavailable(
  code: FincastMarketCadenceUnavailableCode,
): FincastMarketCadenceResult {
  return { status: "unavailable", code };
}

function dateEpoch(sessionDate: string): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(sessionDate)) return undefined;
  const epoch = Date.parse(`${sessionDate}T00:00:00.000Z`);
  return Number.isFinite(epoch) ? epoch : undefined;
}

function dateAfter(sessionDate: string, days: number): string | undefined {
  const epoch = dateEpoch(sessionDate);
  if (epoch === undefined || !Number.isInteger(days) || days < 0) return undefined;
  return new Date(epoch + days * DAY_MS).toISOString().slice(0, 10);
}

function datesBetween(
  first: string,
  last: string,
): readonly string[] | undefined {
  const firstEpoch = dateEpoch(first);
  const lastEpoch = dateEpoch(last);
  if (firstEpoch === undefined || lastEpoch === undefined || lastEpoch < firstEpoch) return undefined;
  const dayCount = Math.round((lastEpoch - firstEpoch) / DAY_MS) + 1;
  if (dayCount < 1 || dayCount > FINCAST_MAX_CALENDAR_DAYS_PER_OPERATION) return undefined;
  return Array.from({ length: dayCount }, (_unused, index) => (
    new Date(firstEpoch + index * DAY_MS).toISOString().slice(0, 10)
  ));
}

function periodCloses(period: TossMarketSessionPeriod): readonly number[] | undefined {
  const start = Date.parse(period.startAt);
  const end = Date.parse(period.endAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)
    || start % MINUTE_MS !== 0 || end % MINUTE_MS !== 0 || start >= end) {
    return undefined;
  }
  const output: number[] = [];
  for (let timestamp = start + MINUTE_MS; timestamp <= end; timestamp += MINUTE_MS) {
    output.push(timestamp);
  }
  return output;
}

function localWindowPeriod(
  sessionDate: string,
  window: MarketSessionWindow,
  marketCountry: "KR",
): TossMarketSessionPeriod | undefined {
  if ((window.localDateOffset ?? 0) !== 0
    || window.openMinute < 0
    || window.closeMinute > 24 * 60
    || window.openMinute >= window.closeMinute) {
    return undefined;
  }
  const time = (minute: number) => (
    `${String(Math.floor(minute / 60)).padStart(2, "0")}`
    + `${String(minute % 60).padStart(2, "0")}00`
  );
  const compactDate = sessionDate.replaceAll("-", "");
  const startAt = zonedTimestamp(compactDate, time(window.openMinute), marketTimeZone(marketCountry));
  const endAt = zonedTimestamp(compactDate, time(window.closeMinute), marketTimeZone(marketCountry));
  return startAt && endAt ? { startAt, endAt } : undefined;
}

function confirmedKrSession(
  calendar: TossMarketCalendarDay,
  sessionDate: string,
  configuredWindows: readonly MarketSessionWindow[],
): CalendarSession | undefined {
  if (calendar.marketCountry !== "KR" || calendar.sessionDate !== sessionDate
    || !Object.hasOwn(calendar, "regularMarket")) {
    return undefined;
  }
  if (calendar.regularMarket === null) {
    return calendar.dayMarket === null
      && calendar.preMarket === null
      && calendar.afterMarket === null
      ? { status: "closed" }
      : undefined;
  }
  const regularCloses = periodCloses(calendar.regularMarket);
  if (!regularCloses?.length) return undefined;

  const regularWindow = configuredWindows.find(({ kind }) => kind === "regular_market");
  const configuredRegular = regularWindow
    ? localWindowPeriod(sessionDate, regularWindow, "KR")
    : undefined;
  const isNormalIntegratedDay = configuredRegular
    && Date.parse(configuredRegular.startAt) === Date.parse(calendar.regularMarket.startAt)
    && Date.parse(configuredRegular.endAt) === Date.parse(calendar.regularMarket.endAt);
  if (!isNormalIntegratedDay) {
    // A shortened or otherwise exceptional trading day is accepted only for
    // the exact date-specific period returned by the calendar. Extending it
    // with configured NXT windows would no longer be calendar-confirmed.
    return { status: "open", closes: regularCloses };
  }

  const closes: number[] = [];
  for (const window of configuredWindows) {
    const period = localWindowPeriod(sessionDate, window, "KR");
    const values = period ? periodCloses(period) : undefined;
    if (!values?.length) return undefined;
    closes.push(...values);
  }
  return { status: "open", closes };
}

function confirmedUsSession(
  calendar: TossMarketCalendarDay,
  sessionDate: string,
): CalendarSession | undefined {
  if (calendar.marketCountry !== "US" || calendar.sessionDate !== sessionDate) return undefined;
  const fieldNames = ["dayMarket", "preMarket", "regularMarket", "afterMarket"] as const;
  if (fieldNames.some((field) => !Object.hasOwn(calendar, field))) return undefined;
  const periods = fieldNames.flatMap((field) => calendar[field] ? [calendar[field]] : []);
  if (!periods.length) return { status: "closed" };
  const closes: number[] = [];
  let previousEnd = Number.NEGATIVE_INFINITY;
  for (const period of periods) {
    const start = Date.parse(period.startAt);
    if (!Number.isFinite(start) || start < previousEnd) return undefined;
    const values = periodCloses(period);
    if (!values?.length) return undefined;
    closes.push(...values);
    previousEnd = Date.parse(period.endAt);
  }
  return { status: "open", closes };
}

async function confirmedSchedule(
  marketCountry: MarketCountry,
  sessionDate: string,
  loadCalendar: FincastCalendarLoader,
  krWindows: readonly MarketSessionWindow[],
): Promise<CalendarSession | undefined> {
  const calendar = await loadCalendar(sessionDate);
  if (!calendar) return undefined;
  return marketCountry === "US"
    ? confirmedUsSession(calendar, sessionDate)
    : confirmedKrSession(calendar, sessionDate, krWindows);
}

async function scheduledCloses(
  dates: readonly string[],
  marketCountry: MarketCountry,
  loadCalendar: FincastCalendarLoader,
  krWindows: readonly MarketSessionWindow[],
): Promise<readonly TimestampedSessionClose[] | undefined> {
  const sessions = await Promise.all(dates.map(async (sessionDate) => ({
    sessionDate,
    schedule: await confirmedSchedule(marketCountry, sessionDate, loadCalendar, krWindows),
  })));
  if (sessions.some(({ schedule }) => schedule === undefined)) return undefined;
  const output = sessions.flatMap(({ sessionDate, schedule }) => (
    schedule?.status === "open"
      ? schedule.closes.map((timestamp) => ({ timestamp, sessionDate }))
      : []
  )).sort((left, right) => left.timestamp - right.timestamp);
  for (let index = 1; index < output.length; index += 1) {
    if (output[index - 1]!.timestamp >= output[index]!.timestamp) return undefined;
  }
  return output;
}

export async function validateFincastMarketSequence(input: {
  bars: readonly CadenceBar[];
  marketCountry: MarketCountry;
  loadCalendar: FincastCalendarLoader;
  krWindows: readonly MarketSessionWindow[];
}): Promise<FincastMarketCadenceResult> {
  if (!input.bars.length) return unavailable("fincast_market_cadence_invalid");
  const dates = datesBetween(input.bars[0]!.sessionDate, input.bars.at(-1)!.sessionDate);
  if (!dates) return unavailable("fincast_market_cadence_invalid");
  const expected = await scheduledCloses(
    dates,
    input.marketCountry,
    input.loadCalendar,
    input.krWindows,
  );
  if (!expected) return unavailable("fincast_market_calendar_unavailable");
  const firstTimestamp = Date.parse(input.bars[0]!.closeTime);
  if (!Number.isFinite(firstTimestamp) || firstTimestamp % MINUTE_MS !== 0) {
    return unavailable("fincast_market_cadence_invalid");
  }
  const firstIndex = expected.findIndex(({ timestamp, sessionDate }) => (
    timestamp === firstTimestamp && sessionDate === input.bars[0]!.sessionDate
  ));
  if (firstIndex < 0 || firstIndex + input.bars.length > expected.length) {
    return unavailable("fincast_market_cadence_invalid");
  }
  for (const [offset, bar] of input.bars.entries()) {
    const timestamp = Date.parse(bar.closeTime);
    const scheduled = expected[firstIndex + offset];
    if (!scheduled
      || !Number.isFinite(timestamp)
      || timestamp % MINUTE_MS !== 0
      || timestamp !== scheduled.timestamp
      || bar.sessionDate !== scheduled.sessionDate) {
      return unavailable("fincast_market_cadence_invalid");
    }
  }
  return { status: "available" };
}

export async function validateFincastFutureTimestamps(input: {
  last: CadenceBar;
  futureTimestamps: readonly string[];
  marketCountry: MarketCountry;
  loadCalendar: FincastCalendarLoader;
  krWindows: readonly MarketSessionWindow[];
  lookaheadDays: number;
}): Promise<FincastMarketCadenceResult> {
  if (input.futureTimestamps.length !== 60
    || !Number.isInteger(input.lookaheadDays)
    || input.lookaheadDays < 0
    || input.lookaheadDays >= FINCAST_MAX_CALENDAR_DAYS_PER_OPERATION) {
    return unavailable("fincast_market_cadence_invalid");
  }
  const lastTimestamp = Date.parse(input.last.closeTime);
  if (!Number.isFinite(lastTimestamp) || lastTimestamp % MINUTE_MS !== 0) {
    return unavailable("fincast_market_cadence_invalid");
  }
  const expectedFuture: number[] = [];
  let lastWasCalendarConfirmed = false;
  for (let days = 0; days <= input.lookaheadDays; days += 1) {
    const sessionDate = dateAfter(input.last.sessionDate, days);
    if (!sessionDate) return unavailable("fincast_market_cadence_invalid");
    const schedule = await confirmedSchedule(
      input.marketCountry,
      sessionDate,
      input.loadCalendar,
      input.krWindows,
    );
    if (!schedule) return unavailable("fincast_market_calendar_unavailable");
    if (schedule.status === "closed") continue;
    if (days === 0) {
      const lastIndex = schedule.closes.indexOf(lastTimestamp);
      if (lastIndex < 0) return unavailable("fincast_market_cadence_invalid");
      lastWasCalendarConfirmed = true;
      expectedFuture.push(...schedule.closes.slice(lastIndex + 1));
    } else {
      expectedFuture.push(...schedule.closes);
    }
    if (expectedFuture.length >= 60) break;
  }
  if (!lastWasCalendarConfirmed || expectedFuture.length < 60) {
    return unavailable("fincast_market_cadence_invalid");
  }
  for (const [offset, value] of input.futureTimestamps.entries()) {
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)
      || timestamp % MINUTE_MS !== 0
      || timestamp !== expectedFuture[offset]) {
      return unavailable("fincast_market_cadence_invalid");
    }
  }
  return { status: "available" };
}
