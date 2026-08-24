import type { MarketCountry } from "./contracts.js";

export type MarketLocalParts = {
  date: string;
  time: string;
};

export type MarketTimeZone = "Asia/Seoul" | "America/New_York";

function createLocalPartsFormatter(timeZone: MarketTimeZone): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
}

const localPartsFormatters: Record<MarketTimeZone, Intl.DateTimeFormat> = {
  "Asia/Seoul": createLocalPartsFormatter("Asia/Seoul"),
  "America/New_York": createLocalPartsFormatter("America/New_York"),
};

export function marketTimeZone(marketCountry: MarketCountry): MarketTimeZone {
  return marketCountry === "US" ? "America/New_York" : "Asia/Seoul";
}

export function localPartsAt(timestamp: number, timeZone: MarketTimeZone): MarketLocalParts {
  const parts = localPartsFormatters[timeZone].formatToParts(new Date(timestamp));
  let year = "";
  let month = "";
  let day = "";
  let hour = "";
  let minute = "";
  let second = "";
  for (const part of parts) {
    switch (part.type) {
      case "year": year = part.value; break;
      case "month": month = part.value; break;
      case "day": day = part.value; break;
      case "hour": hour = part.value; break;
      case "minute": minute = part.value; break;
      case "second": second = part.value; break;
      default: break;
    }
  }
  return {
    date: `${year}${month}${day}`,
    time: `${hour}${minute}${second}`,
  };
}

export function marketLocalParts(timestamp: number, marketCountry: MarketCountry): MarketLocalParts {
  return localPartsAt(timestamp, marketTimeZone(marketCountry));
}

export function zonedTimestamp(
  date: string,
  time: string,
  timeZone: MarketTimeZone,
): string | undefined {
  if (!/^\d{8}$/.test(date) || !/^\d{6}$/.test(time)) return undefined;
  const targetAsUtc = Date.UTC(
    Number(date.slice(0, 4)),
    Number(date.slice(4, 6)) - 1,
    Number(date.slice(6, 8)),
    Number(time.slice(0, 2)),
    Number(time.slice(2, 4)),
    Number(time.slice(4, 6)),
  );
  let candidate = targetAsUtc;
  for (let index = 0; index < 3; index += 1) {
    const observed = localPartsAt(candidate, timeZone);
    const observedAsUtc = Date.UTC(
      Number(observed.date.slice(0, 4)),
      Number(observed.date.slice(4, 6)) - 1,
      Number(observed.date.slice(6, 8)),
      Number(observed.time.slice(0, 2)),
      Number(observed.time.slice(2, 4)),
      Number(observed.time.slice(4, 6)),
    );
    if (observedAsUtc === targetAsUtc) return new Date(candidate).toISOString();
    candidate += targetAsUtc - observedAsUtc;
  }
  const resolved = localPartsAt(candidate, timeZone);
  if (resolved.date !== date || resolved.time !== time) return undefined;
  return new Date(candidate).toISOString();
}

export function marketSessionAnchor(sessionDate: string, marketCountry: MarketCountry): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(sessionDate)) throw new Error("sessionDate must be YYYY-MM-DD.");
  const compact = sessionDate.replaceAll("-", "");
  const localOpen = marketCountry === "US" ? "093000" : "090000";
  const timestamp = zonedTimestamp(compact, localOpen, marketTimeZone(marketCountry));
  if (!timestamp) throw new Error("Market session anchor could not be resolved.");
  return timestamp;
}
