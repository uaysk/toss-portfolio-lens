import type { HistoryRange } from "@/types";

export type CalendarDateRange = {
  from: string;
  to: string;
};

export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function shiftCalendarDate(value: string, days: number): string {
  if (!isCalendarDate(value)) return "";
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

export function seoulDateString(date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function presetCalendarRange(
  range: HistoryRange,
  today: string,
  firstTradeDate?: string,
): CalendarDateRange {
  if (range === "all") {
    return { from: firstTradeDate && isCalendarDate(firstTradeDate) ? firstTradeDate : "", to: today };
  }
  const days = range === "7d" ? 7 : range === "30d" ? 30 : 90;
  const candidate = shiftCalendarDate(today, -(days - 1));
  const from = firstTradeDate && isCalendarDate(firstTradeDate) && firstTradeDate > candidate
    ? firstTradeDate
    : candidate;
  return { from, to: today };
}

export function isValidCalendarRange(range: CalendarDateRange, maxDate?: string): boolean {
  return isCalendarDate(range.from)
    && isCalendarDate(range.to)
    && range.from <= range.to
    && (!maxDate || range.to <= maxDate);
}
