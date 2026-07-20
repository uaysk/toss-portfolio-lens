import {
  isHistoryDate,
  kstDateString,
  type BackfillStatus,
  type PortfolioHistory,
  type PortfolioHistoryStore,
} from "../history.js";
import type { HistoricalOrder } from "../toss.js";
import type { PortfolioAnalysisService } from "../analysis.js";
import { ServiceError } from "./service-envelope.js";

export const TECHNICAL_TRADE_MARKERS_SCHEMA_VERSION = "technical-trade-markers/v1" as const;

type MarkerSide = "buy" | "sell";
export type TechnicalTradeMarkerOrderHistoryStatus = BackfillStatus["status"] | "unavailable";
export type TechnicalTradeMarkerDataAvailability = "available" | "partial" | "unavailable";
type Estimate<T> =
  | ({ status: "estimated" } & T)
  | { status: "unavailable"; reason: string };

export type TechnicalTradeMarker = {
  id: string;
  date: string;
  symbol: string;
  currency: string;
  side: MarkerSide;
  order_count: number;
  execution_count: null;
  execution_count_reason: "individual_executions_not_persisted";
  filled_quantity: number;
  average_filled_price: number | null;
  filled_amount: number | null;
  filled_amount_krw: Estimate<{
    value: number;
    fx_rate: number;
    fx_rate_date: string;
    fx_rate_status: "identity" | "exact" | "carried";
  }>;
  trade_weight: Estimate<{
    percent: number;
    numerator_krw: number;
    denominator_krw: number;
    valuation_date: string;
  }>;
  position_weight: Estimate<{
    before_percent: number;
    after_percent: number;
    before_snapshot_date: string;
    after_snapshot_date: string;
  }>;
  details: Array<{
    order_id: string;
    ordered_at: string;
    filled_at: string;
    filled_quantity: number;
    average_filled_price: number | null;
    filled_amount: number | null;
    commission: number | null;
    tax: number | null;
    status: string;
  }>;
};

export type TechnicalTradeMarkers = {
  schema_version: typeof TECHNICAL_TRADE_MARKERS_SCHEMA_VERSION;
  account_id: string;
  generated_at: string;
  policies: {
    grouping: "trade_date_symbol_currency_side";
    date_timezone: "Asia/Seoul";
    amount_basis: "stored_filled_amount_excluding_unrecorded_adjustments";
    trade_weight: "filled_amount_krw_divided_by_previous_daily_holdings_valuation";
    weight_quality: "always_estimated_from_daily_snapshots";
    portfolio_value_scope: "persisted_security_holdings_excludes_unpersisted_cash";
    execution_detail: "order_level_average_fill_only";
  };
  metadata: {
    order_history: {
      status: TechnicalTradeMarkerOrderHistoryStatus;
      marker_data_availability: TechnicalTradeMarkerDataAvailability;
      complete: boolean;
      phase: BackfillStatus["phase"] | null;
      updated_at: string | null;
      first_trade_date: string | null;
      last_backfilled_date: string | null;
      orders_imported: number | null;
      failed_symbols: number | null;
      message: string | null;
    };
  };
  markers: TechnicalTradeMarker[];
  diagnostics: {
    stored_order_count: number;
    included_order_count: number;
    skipped_unfilled_or_invalid_count: number;
    filtered_out_count: number;
    marker_count: number;
    estimated_weight_count: number;
    unavailable_weight_count: number;
    order_history_status: TechnicalTradeMarkerOrderHistoryStatus;
    marker_data_availability: TechnicalTradeMarkerDataAvailability;
    marker_count_complete: boolean;
  };
};

function round(value: number, digits = 8): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function markerSide(value: string): MarkerSide | undefined {
  const side = value.trim().toUpperCase();
  if (["BUY", "PURCHASE", "BID", "매수"].includes(side)) return "buy";
  if (["SELL", "ASK", "매도"].includes(side)) return "sell";
  return undefined;
}

export function technicalTradeDate(order: HistoricalOrder): string | undefined {
  const timestamp = order.filledAt || order.orderedAt;
  if (!timestamp) return undefined;
  const parsed = new Date(timestamp);
  if (!Number.isNaN(parsed.getTime()) && /(?:Z|[+-]\d{2}:?\d{2})$/i.test(timestamp)) {
    return kstDateString(parsed);
  }
  const date = timestamp.match(/^(\d{4}-\d{2}-\d{2})/)?.[1];
  return date && isHistoryDate(date) ? date : undefined;
}

function priorPoint(history: PortfolioHistory, date: string) {
  for (let index = history.points.length - 1; index >= 0; index -= 1) {
    const point = history.points[index];
    if (point && point.date < date) return point;
  }
  return undefined;
}

function sameDatePoint(history: PortfolioHistory, date: string) {
  return history.points.find((point) => point.date === date);
}

function positionWeight(
  history: PortfolioHistory,
  point: PortfolioHistory["points"][number],
  symbol: string,
  currency: string,
): { value: number } | { reason: string } {
  const keys = history.series
    .filter((item) => item.symbol.toUpperCase() === symbol && item.currency === currency)
    .map((item) => item.key);
  if (!keys.length) return { reason: "portfolio_position_series_unavailable" };
  const values = keys.map((key) => point.values[key]);
  if (values.some((value) => !Number.isFinite(value))) {
    return { reason: "portfolio_position_weight_unavailable" };
  }
  return { value: round(values.reduce<number>((total, value) => total + (value as number), 0), 6) };
}

function fxForDate(currency: string, date: string, exchangeRates: ReadonlyMap<string, number>) {
  if (currency === "KRW") {
    return { rate: 1, date, status: "identity" as const };
  }
  if (currency !== "USD") return undefined;
  const exact = exchangeRates.get(date);
  if (exact && Number.isFinite(exact) && exact > 0) {
    return { rate: exact, date, status: "exact" as const };
  }
  const carried = Array.from(exchangeRates)
    .filter(([rateDate, rate]) => rateDate < date && Number.isFinite(rate) && rate > 0)
    .sort(([left], [right]) => right.localeCompare(left))[0];
  return carried
    ? { rate: carried[1], date: carried[0], status: "carried" as const }
    : undefined;
}

function unavailable(reason: string): { status: "unavailable"; reason: string } {
  return { status: "unavailable", reason };
}

function finiteOrNull(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

function orderHistoryMetadata(
  status: BackfillStatus | undefined,
  storedOrderCount: number,
): TechnicalTradeMarkers["metadata"]["order_history"] {
  const orderHistoryStatus = status?.status ?? "unavailable";
  const markerDataAvailability: TechnicalTradeMarkerDataAvailability = orderHistoryStatus === "complete"
    ? "available"
    : orderHistoryStatus === "running" || orderHistoryStatus === "partial" || storedOrderCount > 0
      ? "partial"
      : "unavailable";
  return {
    status: orderHistoryStatus,
    marker_data_availability: markerDataAvailability,
    complete: orderHistoryStatus === "complete",
    phase: status?.phase ?? null,
    updated_at: status?.updatedAt ?? null,
    first_trade_date: status?.firstTradeDate ?? null,
    last_backfilled_date: status?.lastBackfilledDate ?? null,
    orders_imported: status?.ordersImported ?? null,
    failed_symbols: status?.failedSymbols ?? null,
    message: status?.message ?? (status ? null : "주문 이력 백필 상태를 확인하지 못했습니다."),
  };
}

export function buildTechnicalTradeMarkers(input: {
  accountId: string;
  orders: HistoricalOrder[];
  history: PortfolioHistory;
  exchangeRates: ReadonlyMap<string, number>;
  fromDate?: string;
  toDate?: string;
  symbols?: string[];
  backfillStatus?: BackfillStatus;
  now?: Date;
}): TechnicalTradeMarkers {
  const requestedSymbols = input.symbols?.length
    ? new Set(input.symbols.map((symbol) => symbol.trim().toUpperCase()))
    : undefined;
  const validOrders = input.orders.flatMap((order) => {
    const side = markerSide(order.side);
    const date = technicalTradeDate(order);
    const symbol = order.symbol.trim().toUpperCase();
    if (!side || !date || !symbol || !Number.isFinite(order.filledQuantity) || order.filledQuantity <= 0) return [];
    return [{ order, side, date, symbol, currency: order.currency.trim().toUpperCase() }];
  });
  const eligible = validOrders.filter((item) => (
    (!input.fromDate || item.date >= input.fromDate)
    && (!input.toDate || item.date <= input.toDate)
    && (!requestedSymbols || requestedSymbols.has(item.symbol))
  ));
  const groups = new Map<string, typeof eligible>();
  for (const item of eligible) {
    const key = [item.date, item.symbol, item.currency, item.side].join(":");
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }

  const markers = Array.from(groups, ([id, group]): TechnicalTradeMarker => {
    const first = group[0]!;
    const quantitiesValid = group.every(({ order }) => Number.isFinite(order.filledQuantity) && order.filledQuantity > 0);
    const pricesValid = group.every(({ order }) => Number.isFinite(order.averageFilledPrice) && order.averageFilledPrice > 0);
    const amountsValid = group.every(({ order }) => Number.isFinite(order.filledAmount) && order.filledAmount > 0);
    const filledQuantity = quantitiesValid
      ? round(group.reduce((total, { order }) => total + order.filledQuantity, 0))
      : 0;
    const averageFilledPrice = quantitiesValid && pricesValid && filledQuantity > 0
      ? round(group.reduce((total, { order }) => total + order.averageFilledPrice * order.filledQuantity, 0) / filledQuantity)
      : null;
    const filledAmount = amountsValid
      ? round(group.reduce((total, { order }) => total + order.filledAmount, 0))
      : null;
    const fx = fxForDate(first.currency, first.date, input.exchangeRates);
    const filledAmountKrw = filledAmount === null
      ? unavailable("stored_filled_amount_unavailable")
      : !fx
        ? unavailable(first.currency === "USD" ? "usd_krw_exchange_rate_unavailable" : "unsupported_currency")
        : {
            status: "estimated" as const,
            value: round(filledAmount * fx.rate),
            fx_rate: fx.rate,
            fx_rate_date: fx.date,
            fx_rate_status: fx.status,
          };
    const before = priorPoint(input.history, first.date);
    const after = sameDatePoint(input.history, first.date);
    const tradeWeight = filledAmountKrw.status === "unavailable"
      ? unavailable(filledAmountKrw.reason)
      : !before
        ? unavailable("previous_portfolio_snapshot_unavailable")
        : !Number.isFinite(before.totalValue) || before.totalValue <= 0
          ? unavailable("previous_portfolio_valuation_unavailable")
          : {
              status: "estimated" as const,
              percent: round((filledAmountKrw.value / before.totalValue) * 100, 6),
              numerator_krw: filledAmountKrw.value,
              denominator_krw: before.totalValue,
              valuation_date: before.date,
            };
    const beforePosition = before
      ? positionWeight(input.history, before, first.symbol, first.currency)
      : undefined;
    const afterPosition = after
      ? positionWeight(input.history, after, first.symbol, first.currency)
      : undefined;
    const position = !before
      ? unavailable("previous_portfolio_snapshot_unavailable")
      : !after
        ? unavailable("trade_date_portfolio_snapshot_unavailable")
        : beforePosition && "reason" in beforePosition
          ? unavailable(beforePosition.reason)
          : afterPosition && "reason" in afterPosition
            ? unavailable(afterPosition.reason)
        : {
            status: "estimated" as const,
            before_percent: beforePosition!.value,
            after_percent: afterPosition!.value,
            before_snapshot_date: before.date,
            after_snapshot_date: after.date,
          };
    return {
      id,
      date: first.date,
      symbol: first.symbol,
      currency: first.currency,
      side: first.side,
      order_count: group.length,
      execution_count: null,
      execution_count_reason: "individual_executions_not_persisted",
      filled_quantity: filledQuantity,
      average_filled_price: averageFilledPrice,
      filled_amount: filledAmount,
      filled_amount_krw: filledAmountKrw,
      trade_weight: tradeWeight,
      position_weight: position,
      details: group
        .map(({ order }) => ({
          order_id: order.orderId,
          ordered_at: order.orderedAt,
          filled_at: order.filledAt,
          filled_quantity: order.filledQuantity,
          average_filled_price: finiteOrNull(order.averageFilledPrice),
          filled_amount: finiteOrNull(order.filledAmount),
          commission: finiteOrNull(order.commission),
          tax: finiteOrNull(order.tax),
          status: order.status,
        }))
        .sort((left, right) => (left.filled_at || left.ordered_at).localeCompare(right.filled_at || right.ordered_at)
          || left.order_id.localeCompare(right.order_id)),
    };
  }).sort((left, right) => left.date.localeCompare(right.date)
    || left.symbol.localeCompare(right.symbol)
    || left.side.localeCompare(right.side));

  const orderHistory = orderHistoryMetadata(input.backfillStatus, input.orders.length);
  return {
    schema_version: TECHNICAL_TRADE_MARKERS_SCHEMA_VERSION,
    account_id: input.accountId,
    generated_at: (input.now ?? new Date()).toISOString(),
    policies: {
      grouping: "trade_date_symbol_currency_side",
      date_timezone: "Asia/Seoul",
      amount_basis: "stored_filled_amount_excluding_unrecorded_adjustments",
      trade_weight: "filled_amount_krw_divided_by_previous_daily_holdings_valuation",
      weight_quality: "always_estimated_from_daily_snapshots",
      portfolio_value_scope: "persisted_security_holdings_excludes_unpersisted_cash",
      execution_detail: "order_level_average_fill_only",
    },
    metadata: { order_history: orderHistory },
    markers,
    diagnostics: {
      stored_order_count: input.orders.length,
      included_order_count: eligible.length,
      skipped_unfilled_or_invalid_count: input.orders.length - validOrders.length,
      filtered_out_count: validOrders.length - eligible.length,
      marker_count: markers.length,
      estimated_weight_count: markers.filter((marker) => marker.trade_weight.status === "estimated").length,
      unavailable_weight_count: markers.filter((marker) => marker.trade_weight.status === "unavailable").length,
      order_history_status: orderHistory.status,
      marker_data_availability: orderHistory.marker_data_availability,
      marker_count_complete: orderHistory.complete,
    },
  };
}

export class TechnicalTradeMarkerService {
  constructor(
    private readonly store: Pick<PortfolioHistoryStore, "getOrders" | "getExchangeRates" | "getBackfillStatus">,
    private readonly portfolioAnalysis: Pick<PortfolioAnalysisService, "getCombinedHistory">,
  ) {}

  async getMarkers(input: {
    accountId: string;
    fromDate?: string;
    toDate?: string;
    symbols?: string[];
  }): Promise<TechnicalTradeMarkers> {
    const accountId = input.accountId.trim();
    if (!accountId || accountId.length > 128) {
      throw new ServiceError({ code: "INVALID_ACCOUNT", message: "조회할 계좌를 선택해 주세요.", retryable: false, field: "accountId" });
    }
    if ((input.fromDate && !isHistoryDate(input.fromDate)) || (input.toDate && !isHistoryDate(input.toDate))
      || (input.fromDate && input.toDate && input.fromDate > input.toDate)) {
      throw new ServiceError({ code: "INVALID_DATE_RANGE", message: "거래 조회 기간을 확인해 주세요.", retryable: false, field: "fromDate" });
    }
    if (input.symbols && (input.symbols.length > 100 || input.symbols.some((symbol) => !/^[A-Z0-9.-]{1,32}$/i.test(symbol.trim())))) {
      throw new ServiceError({ code: "INVALID_SYMBOLS", message: "조회 종목을 확인해 주세요.", retryable: false, field: "symbols" });
    }
    const [orders, history, backfillStatus] = await Promise.all([
      this.store.getOrders(accountId),
      this.portfolioAnalysis.getCombinedHistory({ accountId, range: "all" }),
      this.store.getBackfillStatus(accountId).catch(() => undefined),
    ]);
    const orderDates = orders.flatMap((order) => technicalTradeDate(order) ?? []);
    const firstDate = history.points[0]?.date ?? orderDates.sort()[0];
    const lastDate = history.points.at(-1)?.date ?? orderDates.sort().at(-1);
    const exchangeRates = firstDate && lastDate
      ? await this.store.getExchangeRates(firstDate, lastDate)
      : new Map<string, number>();
    return buildTechnicalTradeMarkers({
      accountId,
      orders,
      history,
      exchangeRates,
      ...(backfillStatus ? { backfillStatus } : {}),
      ...(input.fromDate ? { fromDate: input.fromDate } : {}),
      ...(input.toDate ? { toDate: input.toDate } : {}),
      ...(input.symbols ? { symbols: input.symbols } : {}),
    });
  }
}
