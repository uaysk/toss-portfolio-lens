import { describe, expect, it } from "vitest";
import { buildReadOnlyMarketPath, MarketQueryError, READ_ONLY_MARKET_FEATURES } from "./market.js";

describe("read-only market request whitelist", () => {
  it("공식 조회 엔드포인트와 허용된 조건만 조합한다", () => {
    expect(buildReadOnlyMarketPath("prices", { symbols: "005930,AAPL" }))
      .toBe("/api/v1/prices?symbols=005930%2CAAPL");
    expect(buildReadOnlyMarketPath("candles", {
      symbol: "AAPL",
      interval: "1d",
      count: "200",
      adjusted: "false",
      before: "2026-07-15T09:00:00+09:00",
    })).toContain("before=2026-07-15T09%3A00%3A00%2B09%3A00");
    expect(buildReadOnlyMarketPath("warnings", { symbol: "005930" }))
      .toBe("/api/v1/stocks/005930/warnings");
    expect(buildReadOnlyMarketPath("market-calendar", { country: "US", date: "2026-07-15" }))
      .toBe("/api/v1/market-calendar/US?date=2026-07-15");
    expect(buildReadOnlyMarketPath("investor-trading", { symbol: "KOSPI", interval: "1d", count: "30" }))
      .toBe("/api/v1/market-indicators/KOSPI/investor-trading?interval=1d&count=30");
  });

  it("거래 기능을 제외한 시장 조회 기능 13개를 모두 구성한다", () => {
    const cases = [
      ["orderbook", { symbol: "005930" }],
      ["prices", { symbols: "005930,AAPL" }],
      ["trades", { symbol: "005930", count: "20" }],
      ["price-limits", { symbol: "005930" }],
      ["candles", { symbol: "005930", interval: "1d" }],
      ["stocks", { symbols: "005930,AAPL" }],
      ["warnings", { symbol: "005930" }],
      ["exchange-rate", { baseCurrency: "KRW", quoteCurrency: "USD" }],
      ["market-calendar", { country: "KR" }],
      ["rankings", { type: "TOP_GAINERS", marketCountry: "KR", duration: "1d" }],
      ["indicator-prices", { symbols: "KOSPI,KOSDAQ" }],
      ["indicator-candles", { symbol: "KOSPI", interval: "1d" }],
      ["investor-trading", { symbol: "KOSDAQ", interval: "1w" }],
    ] as const;

    expect(READ_ONLY_MARKET_FEATURES).toHaveLength(13);
    expect(cases.map(([feature, query]) => buildReadOnlyMarketPath(feature, query))).toHaveLength(13);
  });

  it("임의 조건이나 잘못된 심볼·범위는 거부한다", () => {
    expect(() => buildReadOnlyMarketPath("prices", { symbols: "005930", path: "/api/v1/orders" }))
      .toThrow(MarketQueryError);
    expect(() => buildReadOnlyMarketPath("orderbook", { symbol: "../../orders" }))
      .toThrow(MarketQueryError);
    expect(() => buildReadOnlyMarketPath("trades", { symbol: "005930", count: "51" }))
      .toThrow(MarketQueryError);
    expect(() => buildReadOnlyMarketPath("market-calendar", { country: "KR", date: "2026-02-30" }))
      .toThrow(MarketQueryError);
  });
});
