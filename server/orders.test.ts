import { describe, expect, it } from "vitest";
import {
  buildReadOnlyOrderDetailPath,
  buildReadOnlyOrderListPath,
  OrderHistoryQueryError,
} from "./orders.js";

describe("read-only order history whitelist", () => {
  it("공식 거래 내역 목록 조건만 인코딩한다", () => {
    expect(buildReadOnlyOrderListPath({
      status: "CLOSED",
      symbol: "AAPL",
      from: "2025-01-01",
      to: "2026-07-15",
      cursor: "next_page-token",
      limit: "100",
    })).toBe(
      "/api/v1/orders?status=CLOSED&symbol=AAPL&from=2025-01-01&to=2026-07-15&cursor=next_page-token&limit=100",
    );
    expect(buildReadOnlyOrderListPath({ status: "OPEN" })).toBe("/api/v1/orders?status=OPEN");
  });

  it("opaque 주문 식별자의 읽기 전용 상세 경로를 만든다", () => {
    expect(buildReadOnlyOrderDetailPath("0d5QIHjmtksbsmM-hBRAgP_ExI8"))
      .toBe("/api/v1/orders/0d5QIHjmtksbsmM-hBRAgP_ExI8");
  });

  it("임의 조건과 잘못된 날짜·범위·식별자를 거부한다", () => {
    expect(() => buildReadOnlyOrderListPath({ status: "FILLED" })).toThrow(OrderHistoryQueryError);
    expect(() => buildReadOnlyOrderListPath({ status: "CLOSED", from: "2026-07-16", to: "2026-07-15" }))
      .toThrow(OrderHistoryQueryError);
    expect(() => buildReadOnlyOrderListPath({ status: "CLOSED", limit: "101" }))
      .toThrow(OrderHistoryQueryError);
    expect(() => buildReadOnlyOrderListPath({ status: "CLOSED", mutation: "cancel" }))
      .toThrow(OrderHistoryQueryError);
    expect(() => buildReadOnlyOrderDetailPath("../../holdings"))
      .toThrow(OrderHistoryQueryError);
    expect(() => buildReadOnlyOrderDetailPath("valid-id", { include: "executions" }))
      .toThrow(OrderHistoryQueryError);
  });
});
