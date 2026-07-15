import { describe, expect, it } from "vitest";
import {
  normalizeCandlePage,
  normalizeExchangeRatePayload,
  normalizeHoldingsPayload,
  normalizeInstrumentsPayload,
  normalizeOrderPage,
} from "./toss.js";

describe("normalizeHoldingsPayload", () => {
  it("토스증권 v1.2.2의 통화별 요약과 중첩 종목 값을 정규화한다", () => {
    const normalized = normalizeHoldingsPayload({
      result: {
        totalPurchaseAmount: { krw: "6500000", usd: "1553" },
        marketValue: {
          amount: { krw: "7200000", usd: "1785" },
          amountAfterCost: { krw: "7050000", usd: "1771.43" },
        },
        profitLoss: {
          amount: { krw: "700000", usd: "232" },
          rate: "0.1179",
        },
        dailyProfitLoss: {
          amount: { krw: "100000", usd: "25" },
          rate: "0.0141",
        },
        items: [
          {
            symbol: "005930",
            name: "삼성전자",
            marketCountry: "KR",
            currency: "KRW",
            quantity: "100",
            lastPrice: "72000",
            averagePurchasePrice: "65000",
            marketValue: {
              purchaseAmount: "6500000",
              amount: "7200000",
            },
            profitLoss: {
              amount: "700000",
              rate: "0.1077",
            },
            dailyProfitLoss: {
              amount: "100000",
              rate: "0.0141",
            },
          },
          {
            symbol: "AAPL",
            name: "Apple Inc.",
            marketCountry: "US",
            currency: "USD",
            quantity: "10",
            lastPrice: "178.5",
            averagePurchasePrice: "155.3",
            marketValue: {
              purchaseAmount: "1553",
              amount: "1785",
            },
            profitLoss: {
              amount: "232",
              rate: "0.1494",
            },
            dailyProfitLoss: {
              amount: "25",
              rate: "0.0142",
            },
          },
        ],
      },
    });

    expect(normalized.summary).toMatchObject({
      purchaseAmount: { KRW: 6500000, USD: 1553 },
      evaluationAmount: { KRW: 7200000, USD: 1785 },
      profitLoss: { KRW: 700000, USD: 232 },
      dailyProfitLoss: { KRW: 100000, USD: 25 },
      positionCount: 2,
    });
    expect(normalized.summary.profitRate).toBeCloseTo(11.79, 6);
    expect(normalized.summary.dailyProfitRate).toBeCloseTo(1.41, 6);
    expect(normalized.holdings[0]).toMatchObject({
      symbol: "005930",
      market: "KRX",
      currency: "KRW",
      evaluationAmount: 7200000,
      profitLoss: 700000,
      dailyProfitRate: 1.41,
    });
    expect(normalized.holdings[0].profitRate).toBeCloseTo(10.7692, 3);
    expect(normalized.holdings[1]).toMatchObject({
      symbol: "AAPL",
      market: "미국",
      currency: "USD",
      evaluationAmount: 1785,
      profitLoss: 232,
      dailyProfitRate: 1.42,
    });
    expect(normalized.holdings[1].profitRate).toBeCloseTo(14.9388, 3);
  });
});

describe("과거 데이터 정규화", () => {
  it("체결 완료 주문의 execution 값을 보존한다", () => {
    const page = normalizeOrderPage({
      result: {
        hasNext: true,
        nextCursor: "next-page",
        orders: [{
          orderId: "order-1",
          symbol: "005930",
          side: "BUY",
          currency: "KRW",
          status: "CLOSED",
          orderedAt: "2026-07-01T09:00:00+09:00",
          execution: {
            filledAt: "2026-07-01T09:01:00+09:00",
            filledQuantity: "3",
            averageFilledPrice: "72000",
            filledAmount: "216000",
            commission: "10",
            tax: "0",
          },
        }],
      },
    });

    expect(page).toMatchObject({ hasNext: true, nextCursor: "next-page" });
    expect(page.orders[0]).toMatchObject({
      orderId: "order-1",
      symbol: "005930",
      side: "BUY",
      filledQuantity: 3,
      averageFilledPrice: 72000,
      filledAmount: 216000,
    });
  });

  it("일봉과 배열 형태의 종목 정보를 정규화한다", () => {
    const candles = normalizeCandlePage({
      result: {
        nextBefore: "older",
        candles: [{
          timestamp: "2026-07-01T00:00:00+09:00",
          openPrice: "72000",
          highPrice: "74000",
          lowPrice: "71500",
          closePrice: "73500",
          currency: "KRW",
        }],
      },
    }, "005930");
    expect(candles).toEqual({
      nextBefore: "older",
      candles: [{
        symbol: "005930",
        date: "2026-07-01",
        timestamp: "2026-07-01T00:00:00+09:00",
        currency: "KRW",
        openPrice: 72000,
        highPrice: 74000,
        lowPrice: 71500,
        closePrice: 73500,
      }],
    });

    expect(normalizeInstrumentsPayload({
      result: [{
        symbol: "AAPL",
        name: "애플",
        market: "NASDAQ",
        currency: "USD",
        listDate: "1980-12-12",
        delistDate: null,
        securityType: "STOCK",
        status: "ACTIVE",
      }],
    })).toEqual([{
      symbol: "AAPL",
      name: "애플",
      market: "NASDAQ",
      currency: "USD",
      listDate: "1980-12-12",
      securityType: "STOCK",
      status: "ACTIVE",
    }]);

    expect(normalizeExchangeRatePayload({
      result: { baseCurrency: "USD", quoteCurrency: "KRW", rate: "1387.25", dateTime: "2026-07-01T15:30:00+09:00" },
    }, "2026-07-01")).toEqual({
      date: "2026-07-01",
      rate: 1387.25,
      timestamp: "2026-07-01T15:30:00+09:00",
    });
  });
});
