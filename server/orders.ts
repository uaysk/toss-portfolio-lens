export type OrderHistoryQuery = Record<string, string>;

export class OrderHistoryQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrderHistoryQueryError";
  }
}

function assertAllowed(query: OrderHistoryQuery, allowed: string[]): void {
  const unexpected = Object.keys(query).filter((key) => !allowed.includes(key));
  if (unexpected.length) {
    throw new OrderHistoryQueryError(`지원하지 않는 거래 내역 조회 조건입니다: ${unexpected.join(", ")}`);
  }
}

function optional(query: OrderHistoryQuery, key: string): string | undefined {
  return query[key]?.trim() || undefined;
}

function calendarDate(value: string | undefined, key: string): string | undefined {
  if (!value) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new OrderHistoryQueryError(`${key} 값은 YYYY-MM-DD 형식이어야 합니다.`);
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new OrderHistoryQueryError(`${key} 값이 실제 날짜가 아닙니다.`);
  }
  return value;
}

function symbol(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.length > 32 || !/^[A-Za-z0-9.\-]+$/.test(value)) {
    throw new OrderHistoryQueryError("symbol 값의 형식이 올바르지 않습니다.");
  }
  return value;
}

function cursor(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.length > 2_048 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new OrderHistoryQueryError("cursor 값의 형식이 올바르지 않습니다.");
  }
  return value;
}

function limit(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (!/^\d+$/.test(value)) throw new OrderHistoryQueryError("limit 값은 정수여야 합니다.");
  const parsed = Number(value);
  if (parsed < 1 || parsed > 100) throw new OrderHistoryQueryError("limit 값은 1~100 범위여야 합니다.");
  return String(parsed);
}

export function buildReadOnlyOrderListPath(query: OrderHistoryQuery): string {
  assertAllowed(query, ["status", "symbol", "from", "to", "cursor", "limit"]);
  const status = optional(query, "status");
  if (status !== "OPEN" && status !== "CLOSED") {
    throw new OrderHistoryQueryError("status 값은 OPEN 또는 CLOSED여야 합니다.");
  }
  const from = calendarDate(optional(query, "from"), "from");
  const to = calendarDate(optional(query, "to"), "to");
  if (from && to && from > to) {
    throw new OrderHistoryQueryError("from 날짜는 to 날짜보다 늦을 수 없습니다.");
  }

  const params = new URLSearchParams({ status });
  const values = {
    symbol: symbol(optional(query, "symbol")),
    from,
    to,
    cursor: cursor(optional(query, "cursor")),
    limit: limit(optional(query, "limit")),
  };
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) params.set(key, value);
  }
  return `/api/v1/orders?${params.toString()}`;
}

export function buildReadOnlyOrderDetailPath(orderId: string, query: OrderHistoryQuery = {}): string {
  assertAllowed(query, []);
  const value = orderId.trim();
  if (!value || value.length > 512 || !/^[A-Za-z0-9._~-]+$/.test(value)) {
    throw new OrderHistoryQueryError("orderId 값의 형식이 올바르지 않습니다.");
  }
  return `/api/v1/orders/${encodeURIComponent(value)}`;
}
