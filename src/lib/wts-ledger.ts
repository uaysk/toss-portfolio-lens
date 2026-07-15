export type WtsLedgerKind =
  | "BUY"
  | "SELL"
  | "DEPOSIT"
  | "WITHDRAWAL"
  | "EXCHANGE_IN"
  | "EXCHANGE_OUT"
  | "DIVIDEND"
  | "FEE"
  | "OTHER";

export type WtsLedgerCurrency = "KRW" | "USD";

export type WtsLedgerEntry = {
  date: string;
  time: string;
  occurredAt: string;
  title: string;
  category: string;
  kind: WtsLedgerKind;
  currency: WtsLedgerCurrency;
  amount: number;
  balance: number;
  instrumentName?: string;
  quantity?: number;
};

export type WtsLedgerParseResult = {
  entries: WtsLedgerEntry[];
  unresolvedEntries: number;
  ignoredLines: number;
};

type ParsedMoney = { value: number; currency: WtsLedgerCurrency };
type DateCursor = { year: number; month: number; date: string };

const DATE_HEADING = /^(?:(\d{4})\s*[.\-/]\s*)?(\d{1,2})\s*[.\-/]\s*(\d{1,2})\.?$/;
const TRANSACTION_META = /^(\d{1,2}):(\d{2})\s*[ㅣ|]\s*(.+)$/;
const QUANTITY_TITLE = /^(.+?)\s+([\d,.]+)\s*주$/;

function validDate(year: number, month: number, day: number): string | undefined {
  const value = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : undefined;
}

function parseDateHeading(line: string, baseYear: number, previous?: DateCursor): DateCursor | undefined {
  const match = line.match(DATE_HEADING);
  if (!match) return undefined;
  const month = Number(match[2]);
  const day = Number(match[3]);
  let year = match[1] ? Number(match[1]) : previous?.year ?? baseYear;
  if (!match[1] && previous && month > previous.month) year -= 1;
  const date = validDate(year, month, day);
  return date ? { year, month, date } : undefined;
}

function parseMoney(line: string): ParsedMoney | undefined {
  const normalized = line.trim().replace(/[−–—]/g, "-");
  const currency: WtsLedgerCurrency = /\$|USD|달러/i.test(normalized) ? "USD" : "KRW";
  const number = normalized.match(/[+-]?\s*(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?/)?.[0];
  if (!number || (!/[원$]|USD|달러/i.test(normalized))) return undefined;
  const parsed = Number(number.replace(/[\s,]/g, ""));
  const value = /^\s*-/.test(normalized) && parsed > 0 ? -parsed : parsed;
  return Number.isFinite(value) ? { value, currency } : undefined;
}

function normalizeKind(category: string): WtsLedgerKind {
  if (/구매|매수/.test(category)) return "BUY";
  if (/판매|매도/.test(category)) return "SELL";
  if (/배당/.test(category)) return "DIVIDEND";
  if (/수수료|세금|제세금/.test(category)) return "FEE";
  if (/환전/.test(category)) return /입금/.test(category) ? "EXCHANGE_IN" : "EXCHANGE_OUT";
  if (/입금/.test(category)) return "DEPOSIT";
  if (/출금/.test(category)) return "WITHDRAWAL";
  return "OTHER";
}

function normalizeTime(hour: string, minute: string): string | undefined {
  const hourValue = Number(hour);
  const minuteValue = Number(minute);
  if (hourValue > 23 || minuteValue > 59) return undefined;
  return `${String(hourValue).padStart(2, "0")}:${String(minuteValue).padStart(2, "0")}`;
}

export function parseWtsLedger(
  input: string,
  options: { baseYear?: number; leadingDate?: string } = {},
): WtsLedgerParseResult {
  const baseYear = options.baseYear ?? new Date().getFullYear();
  const leadingDate = options.leadingDate && /^\d{4}-\d{2}-\d{2}$/.test(options.leadingDate)
    ? options.leadingDate
    : undefined;
  const lines = input
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const entries: WtsLedgerEntry[] = [];
  let cursor: DateCursor | undefined;
  let unresolvedEntries = 0;
  let ignoredLines = 0;

  for (let index = 0; index < lines.length;) {
    const heading = parseDateHeading(lines[index], baseYear, cursor);
    if (heading) {
      cursor = heading;
      index += 1;
      continue;
    }

    const meta = lines[index + 1]?.match(TRANSACTION_META);
    const amount = lines[index + 2] ? parseMoney(lines[index + 2]) : undefined;
    const balance = lines[index + 3] ? parseMoney(lines[index + 3]) : undefined;
    const time = meta ? normalizeTime(meta[1], meta[2]) : undefined;
    if (!meta || !amount || !balance || !time) {
      ignoredLines += 1;
      index += 1;
      continue;
    }

    const date = cursor?.date ?? leadingDate;
    if (!date) {
      unresolvedEntries += 1;
      index += 4;
      continue;
    }
    const title = lines[index];
    const quantityMatch = title.match(QUANTITY_TITLE);
    const quantity = quantityMatch ? Number(quantityMatch[2].replace(/,/g, "")) : undefined;
    const currency = amount.currency === balance.currency ? amount.currency : amount.currency;
    entries.push({
      date,
      time,
      occurredAt: `${date}T${time}:00+09:00`,
      title,
      category: meta[3].trim(),
      kind: normalizeKind(meta[3]),
      currency,
      amount: amount.value,
      balance: balance.value,
      ...(quantityMatch ? { instrumentName: quantityMatch[1].trim(), quantity } : {}),
    });
    index += 4;
  }

  return { entries, unresolvedEntries, ignoredLines };
}
