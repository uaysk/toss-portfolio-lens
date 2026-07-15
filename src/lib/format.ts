export function formatMoney(value: number, currency = "KRW", compact = false): string {
  const safeCurrency = currency === "USD" ? "USD" : "KRW";
  return new Intl.NumberFormat("ko-KR", {
    style: "currency",
    currency: safeCurrency,
    currencyDisplay: "narrowSymbol",
    maximumFractionDigits: safeCurrency === "KRW" ? 0 : 2,
    ...(compact ? { notation: "compact", compactDisplay: "short" } : {}),
  }).format(Number.isFinite(value) ? value : 0);
}
export function formatSignedMoney(value: number, currency = "KRW"): string {
  const prefix = value > 0 ? "+" : "";
  return prefix + formatMoney(value, currency);
}

export function formatPercent(value: number, signed = false): string {
  const safeValue = Number.isFinite(value) ? value : 0;
  const prefix = signed && safeValue > 0 ? "+" : "";
  return prefix + new Intl.NumberFormat("ko-KR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(safeValue) + "%";
}

export function formatQuantity(value: number): string {
  return new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 6 }).format(Number.isFinite(value) ? value : 0);
}

export function formatSyncTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "방금 전";
  return new Intl.DateTimeFormat("ko-KR", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}
