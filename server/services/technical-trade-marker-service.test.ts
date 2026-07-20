import { describe, expect, it, vi } from "vitest";
import type { BackfillStatus, PortfolioHistory } from "../history.js";
import type { HistoricalOrder } from "../toss.js";
import {
  buildTechnicalTradeMarkers,
  TechnicalTradeMarkerService,
  technicalTradeDate,
} from "./technical-trade-marker-service.js";

const history: PortfolioHistory = {
  accountId: "account-1",
  currency: "KRW",
  includesCurrencies: ["KRW", "USD"],
  range: "all",
  generatedAt: "2024-01-04T00:00:00.000Z",
  series: [
    { key: "KRX:AAA", symbol: "AAA", name: "Alpha", market: "KRX", currency: "KRW", averageWeight: 25 },
    { key: "NASDAQ:BBB", symbol: "BBB", name: "Beta", market: "NASDAQ", currency: "USD", averageWeight: 20 },
  ],
  points: [
    { date: "2024-01-01", capturedAt: "2024-01-01T06:00:00.000Z", totalValue: 1_000_000, values: { "KRX:AAA": 10, "NASDAQ:BBB": 20 } },
    { date: "2024-01-02", capturedAt: "2024-01-02T06:00:00.000Z", totalValue: 1_200_000, values: { "KRX:AAA": 25, "NASDAQ:BBB": 15 } },
    { date: "2024-01-03", capturedAt: "2024-01-03T06:00:00.000Z", totalValue: 1_100_000, values: { "KRX:AAA": 20, "NASDAQ:BBB": 5 } },
  ],
};

function order(input: Partial<HistoricalOrder> & Pick<HistoricalOrder, "orderId" | "symbol" | "side">): HistoricalOrder {
  return {
    currency: "KRW",
    status: "CLOSED",
    orderedAt: "2024-01-02T01:00:00Z",
    filledAt: "2024-01-02T01:10:00Z",
    filledQuantity: 1,
    averageFilledPrice: 100_000,
    filledAmount: 100_000,
    commission: 0,
    tax: 0,
    ...input,
  };
}

function backfillStatus(status: BackfillStatus["status"], input: Partial<BackfillStatus> = {}): BackfillStatus {
  return {
    accountId: "account-1",
    status,
    phase: status === "idle" ? "waiting" : status === "running" ? "orders" : "complete",
    updatedAt: "2024-01-04T00:00:00.000Z",
    ordersImported: 0,
    symbolsTotal: 0,
    symbolsProcessed: 0,
    pricesImported: 0,
    snapshotsCreated: 0,
    reconciledSymbols: 0,
    discrepancySymbols: 0,
    failedSymbols: 0,
    ...input,
  };
}

describe("technical trade markers", () => {
  it("KST 거래일 기준 같은 종목·방향의 여러 주문을 집계하고 추정 비중을 계산한다", () => {
    const result = buildTechnicalTradeMarkers({
      accountId: "account-1",
      history,
      exchangeRates: new Map(),
      now: new Date("2024-01-04T00:00:00.000Z"),
      backfillStatus: backfillStatus("complete", { ordersImported: 3 }),
      orders: [
        order({ orderId: "buy-1", symbol: "aaa", side: "BUY", filledQuantity: 2, averageFilledPrice: 50_000, filledAmount: 100_000 }),
        order({ orderId: "buy-2", symbol: "AAA", side: "BUY", filledQuantity: 1, averageFilledPrice: 60_000, filledAmount: 60_000 }),
        order({ orderId: "sell-1", symbol: "AAA", side: "SELL", filledQuantity: 1, averageFilledPrice: 70_000, filledAmount: 70_000 }),
      ],
    });

    expect(result.markers).toHaveLength(2);
    expect(result.markers[0]).toMatchObject({
      date: "2024-01-02",
      side: "buy",
      order_count: 2,
      execution_count: null,
      filled_quantity: 3,
      average_filled_price: 53333.33333333,
      filled_amount: 160000,
      filled_amount_krw: { status: "estimated", value: 160000, fx_rate_status: "identity" },
      trade_weight: { status: "estimated", percent: 16, denominator_krw: 1_000_000 },
      position_weight: { status: "estimated", before_percent: 10, after_percent: 25 },
      details: [{ order_id: "buy-1" }, { order_id: "buy-2" }],
    });
    expect(result.markers[1]).toMatchObject({ side: "sell", trade_weight: { status: "estimated", percent: 7 } });
    expect(result.policies.portfolio_value_scope).toBe("persisted_security_holdings_excludes_unpersisted_cash");
    expect(result.metadata.order_history).toMatchObject({
      status: "complete",
      marker_data_availability: "available",
      complete: true,
      orders_imported: 3,
    });
    expect(result.diagnostics).toMatchObject({
      order_history_status: "complete",
      marker_data_availability: "available",
      marker_count_complete: true,
    });
  });

  it("USD 금액은 당일 환율을 쓰고 없으면 과거 환율 carry-forward임을 표시한다", () => {
    const result = buildTechnicalTradeMarkers({
      accountId: "account-1",
      history,
      exchangeRates: new Map([["2024-01-01", 1_300]]),
      orders: [order({ orderId: "usd-buy", symbol: "BBB", side: "BUY", currency: "USD", filledAmount: 100 })],
    });
    expect(result.markers[0]).toMatchObject({
      filled_amount_krw: { status: "estimated", value: 130000, fx_rate_date: "2024-01-01", fx_rate_status: "carried" },
      trade_weight: { status: "estimated", percent: 13 },
      position_weight: { status: "estimated", before_percent: 20, after_percent: 15 },
    });
  });

  it("직전 평가액·당일 snapshot·환율이 없으면 값을 만들지 않고 unavailable을 반환한다", () => {
    const noSnapshots = { ...history, points: [] };
    const result = buildTechnicalTradeMarkers({
      accountId: "account-1",
      history: noSnapshots,
      exchangeRates: new Map(),
      orders: [order({ orderId: "usd-buy", symbol: "BBB", side: "BUY", currency: "USD", filledAmount: 100 })],
    });
    expect(result.markers[0]).toMatchObject({
      filled_amount_krw: { status: "unavailable", reason: "usd_krw_exchange_rate_unavailable" },
      trade_weight: { status: "unavailable", reason: "usd_krw_exchange_rate_unavailable" },
      position_weight: { status: "unavailable", reason: "previous_portfolio_snapshot_unavailable" },
    });
  });

  it("종목 series 또는 point 값이 없으면 종목 비중을 0→0으로 만들지 않는다", () => {
    const missingSeries = buildTechnicalTradeMarkers({
      accountId: "account-1",
      history,
      exchangeRates: new Map(),
      orders: [order({ orderId: "missing-series", symbol: "CCC", side: "BUY" })],
    });
    expect(missingSeries.markers[0]?.position_weight).toEqual({
      status: "unavailable",
      reason: "portfolio_position_series_unavailable",
    });

    const missingPointValue = buildTechnicalTradeMarkers({
      accountId: "account-1",
      history: {
        ...history,
        points: history.points.map((point) => ({
          ...point,
          values: point.date === "2024-01-02" ? { "NASDAQ:BBB": 15 } : point.values,
        })),
      },
      exchangeRates: new Map(),
      orders: [order({ orderId: "missing-point", symbol: "AAA", side: "BUY" })],
    });
    expect(missingPointValue.markers[0]?.position_weight).toEqual({
      status: "unavailable",
      reason: "portfolio_position_weight_unavailable",
    });
  });

  it.each([
    ["complete", "available", true],
    ["partial", "partial", false],
    ["running", "partial", false],
    ["idle", "unavailable", false],
    ["error", "unavailable", false],
  ] as const)("백필 %s 상태에서 marker 완전성을 %s로 명시한다", (status, availability, complete) => {
    const result = buildTechnicalTradeMarkers({
      accountId: "account-1",
      history,
      exchangeRates: new Map(),
      orders: [],
      backfillStatus: backfillStatus(status, { message: `${status} state` }),
    });
    expect(result.markers).toEqual([]);
    expect(result.metadata.order_history).toMatchObject({
      status,
      marker_data_availability: availability,
      complete,
      message: `${status} state`,
    });
    expect(result.diagnostics).toMatchObject({
      order_history_status: status,
      marker_data_availability: availability,
      marker_count_complete: complete,
    });
  });

  it("미체결·알 수 없는 방향을 제외하고 기간과 symbol을 필터링한다", () => {
    const result = buildTechnicalTradeMarkers({
      accountId: "account-1",
      history,
      exchangeRates: new Map(),
      fromDate: "2024-01-02",
      toDate: "2024-01-02",
      symbols: ["AAA"],
      orders: [
        order({ orderId: "valid", symbol: "AAA", side: "BUY" }),
        order({ orderId: "unfilled", symbol: "AAA", side: "BUY", filledQuantity: 0 }),
        order({ orderId: "unknown", symbol: "AAA", side: "UNKNOWN" }),
        order({ orderId: "other", symbol: "BBB", side: "BUY" }),
      ],
    });
    expect(result.markers).toHaveLength(1);
    expect(result.diagnostics).toMatchObject({
      stored_order_count: 4,
      included_order_count: 1,
      skipped_unfilled_or_invalid_count: 2,
      filtered_out_count: 1,
    });
  });

  it("timezone이 있는 timestamp는 Asia/Seoul 거래일로 변환한다", () => {
    expect(technicalTradeDate(order({
      orderId: "late",
      symbol: "AAA",
      side: "BUY",
      filledAt: "2024-01-01T16:30:00Z",
    }))).toBe("2024-01-02");
  });

  it("service가 저장 주문·통합 history·환율을 조립하고 잘못된 입력을 먼저 거부한다", async () => {
    const store = {
      getOrders: vi.fn(async () => [order({ orderId: "buy", symbol: "AAA", side: "BUY" })]),
      getExchangeRates: vi.fn(async () => new Map<string, number>()),
      getBackfillStatus: vi.fn(async () => backfillStatus("complete", { ordersImported: 1 })),
    };
    const analysis = { getCombinedHistory: vi.fn(async () => history) };
    const service = new TechnicalTradeMarkerService(store, analysis);
    await expect(service.getMarkers({ accountId: "" })).rejects.toMatchObject({ detail: { code: "INVALID_ACCOUNT" } });
    await expect(service.getMarkers({ accountId: "account-1", fromDate: "2024-99-99" })).rejects.toMatchObject({ detail: { code: "INVALID_DATE_RANGE" } });
    expect(store.getOrders).not.toHaveBeenCalled();

    const result = await service.getMarkers({ accountId: "account-1", symbols: ["aaa"] });
    expect(result.markers).toHaveLength(1);
    expect(store.getOrders).toHaveBeenCalledWith("account-1");
    expect(store.getBackfillStatus).toHaveBeenCalledWith("account-1");
    expect(analysis.getCombinedHistory).toHaveBeenCalledWith({ accountId: "account-1", range: "all" });
  });

  it("백필 상태 조회가 실패하면 저장 주문을 완전한 이력으로 오인하지 않는다", async () => {
    const store = {
      getOrders: vi.fn(async () => [order({ orderId: "known-buy", symbol: "AAA", side: "BUY" })]),
      getExchangeRates: vi.fn(async () => new Map<string, number>()),
      getBackfillStatus: vi.fn(async () => { throw new Error("status db unavailable"); }),
    };
    const service = new TechnicalTradeMarkerService(store, { getCombinedHistory: vi.fn(async () => history) });
    const result = await service.getMarkers({ accountId: "account-1" });
    expect(result.markers).toHaveLength(1);
    expect(result.metadata.order_history).toMatchObject({
      status: "unavailable",
      marker_data_availability: "partial",
      complete: false,
    });
    expect(result.diagnostics.marker_count_complete).toBe(false);
  });
});
