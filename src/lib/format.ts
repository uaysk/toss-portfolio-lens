const SYNC_TIME_FORMATTER = new Intl.DateTimeFormat("ko-KR", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});
const USDT_FORMATTER = new Intl.NumberFormat("ko-KR", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});
const COMPACT_USDT_FORMATTER = new Intl.NumberFormat("ko-KR", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
  notation: "compact",
  compactDisplay: "short",
});
const KRW_FORMATTER = new Intl.NumberFormat("ko-KR", {
  style: "currency",
  currency: "KRW",
  currencyDisplay: "narrowSymbol",
  maximumFractionDigits: 0,
});
const COMPACT_KRW_FORMATTER = new Intl.NumberFormat("ko-KR", {
  style: "currency",
  currency: "KRW",
  currencyDisplay: "narrowSymbol",
  maximumFractionDigits: 0,
  notation: "compact",
  compactDisplay: "short",
});
const USD_FORMATTER = new Intl.NumberFormat("ko-KR", {
  style: "currency",
  currency: "USD",
  currencyDisplay: "narrowSymbol",
  maximumFractionDigits: 2,
});
const COMPACT_USD_FORMATTER = new Intl.NumberFormat("ko-KR", {
  style: "currency",
  currency: "USD",
  currencyDisplay: "narrowSymbol",
  maximumFractionDigits: 2,
  notation: "compact",
  compactDisplay: "short",
});
const PERCENT_FORMATTER = new Intl.NumberFormat("ko-KR", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const QUANTITY_FORMATTER = new Intl.NumberFormat("ko-KR", {
  maximumFractionDigits: 6,
});

export function formatMoney(value: number, currency = "KRW", compact = false): string {
  const safeValue = Number.isFinite(value) ? value : 0;
  if (currency === "USDT") {
    return `${(compact ? COMPACT_USDT_FORMATTER : USDT_FORMATTER).format(safeValue)} USDT`;
  }
  const safeCurrency = currency === "USD" ? "USD" : "KRW";
  if (safeCurrency === "USD") {
    return (compact ? COMPACT_USD_FORMATTER : USD_FORMATTER).format(safeValue);
  }
  return (compact ? COMPACT_KRW_FORMATTER : KRW_FORMATTER).format(safeValue);
}
export function formatSignedMoney(value: number, currency = "KRW"): string {
  const prefix = value > 0 ? "+" : "";
  return prefix + formatMoney(value, currency);
}

export function formatPercent(value: number, signed = false): string {
  const safeValue = Number.isFinite(value) ? value : 0;
  const prefix = signed && safeValue > 0 ? "+" : "";
  return prefix + PERCENT_FORMATTER.format(safeValue) + "%";
}

export function formatQuantity(value: number): string {
  return QUANTITY_FORMATTER.format(Number.isFinite(value) ? value : 0);
}

export function formatSyncTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "방금 전";
  return SYNC_TIME_FORMATTER.format(date);
}
