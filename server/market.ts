export const READ_ONLY_MARKET_FEATURES = [
  "orderbook",
  "prices",
  "trades",
  "price-limits",
  "candles",
  "stocks",
  "warnings",
  "exchange-rate",
  "market-calendar",
  "rankings",
  "indicator-prices",
  "indicator-candles",
  "investor-trading",
] as const;

export type ReadOnlyMarketFeature = typeof READ_ONLY_MARKET_FEATURES[number];
export type MarketQuery = Record<string, string>;

export class MarketQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarketQueryError";
  }
}

function assertAllowed(query: MarketQuery, allowed: string[]): void {
  const unexpected = Object.keys(query).filter((key) => !allowed.includes(key));
  if (unexpected.length) throw new MarketQueryError(`지원하지 않는 조회 조건입니다: ${unexpected.join(", ")}`);
}

function required(query: MarketQuery, key: string): string {
  const value = query[key]?.trim();
  if (!value) throw new MarketQueryError(`${key} 값을 입력해 주세요.`);
  return value;
}

function optional(query: MarketQuery, key: string): string | undefined {
  return query[key]?.trim() || undefined;
}

function oneOf(value: string, key: string, allowed: readonly string[]): string {
  if (!allowed.includes(value)) {
    throw new MarketQueryError(`${key} 값은 ${allowed.join(", ")} 중 하나여야 합니다.`);
  }
  return value;
}

function pattern(value: string, key: string, expression: RegExp, maxLength = 256): string {
  if (value.length > maxLength || !expression.test(value)) {
    throw new MarketQueryError(`${key} 값의 형식이 올바르지 않습니다.`);
  }
  return value;
}

function integer(value: string | undefined, key: string, min: number, max: number): string | undefined {
  if (!value) return undefined;
  if (!/^\d+$/.test(value)) throw new MarketQueryError(`${key} 값은 정수여야 합니다.`);
  const parsed = Number(value);
  if (parsed < min || parsed > max) throw new MarketQueryError(`${key} 값은 ${min}~${max} 범위여야 합니다.`);
  return String(parsed);
}

function boolean(value: string | undefined, key: string): string | undefined {
  if (!value) return undefined;
  return oneOf(value, key, ["true", "false"]);
}

function calendarDate(value: string | undefined, key: string): string | undefined {
  if (!value) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new MarketQueryError(`${key} 값은 YYYY-MM-DD 형식이어야 합니다.`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new MarketQueryError(`${key} 값이 실제 날짜가 아닙니다.`);
  }
  return value;
}

function dateTime(value: string | undefined, key: string): string | undefined {
  if (!value) return undefined;
  if (value.length > 64 || Number.isNaN(Date.parse(value))) {
    throw new MarketQueryError(`${key} 값은 ISO 8601 날짜와 시간이어야 합니다.`);
  }
  return value;
}

function withQuery(path: string, values: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) params.set(key, value);
  }
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

function symbol(query: MarketQuery): string {
  return pattern(required(query, "symbol"), "symbol", /^[A-Za-z0-9.\-]+$/, 32);
}

function stockSymbols(query: MarketQuery): string {
  return pattern(required(query, "symbols"), "symbols", /^[A-Za-z0-9.,\-]+$/, 2_000);
}

function indicatorSymbol(query: MarketQuery): string {
  return pattern(required(query, "symbol"), "symbol", /^[A-Za-z0-9_]+$/, 64);
}

export function isReadOnlyMarketFeature(value: string): value is ReadOnlyMarketFeature {
  return READ_ONLY_MARKET_FEATURES.includes(value as ReadOnlyMarketFeature);
}

export function buildReadOnlyMarketPath(feature: ReadOnlyMarketFeature, query: MarketQuery): string {
  switch (feature) {
    case "orderbook":
      assertAllowed(query, ["symbol"]);
      return withQuery("/api/v1/orderbook", { symbol: symbol(query) });
    case "prices":
      assertAllowed(query, ["symbols"]);
      return withQuery("/api/v1/prices", { symbols: stockSymbols(query) });
    case "trades":
      assertAllowed(query, ["symbol", "count"]);
      return withQuery("/api/v1/trades", {
        symbol: symbol(query),
        count: integer(optional(query, "count"), "count", 1, 50),
      });
    case "price-limits":
      assertAllowed(query, ["symbol"]);
      return withQuery("/api/v1/price-limits", { symbol: symbol(query) });
    case "candles":
      assertAllowed(query, ["symbol", "interval", "count", "before", "adjusted"]);
      return withQuery("/api/v1/candles", {
        symbol: symbol(query),
        interval: oneOf(required(query, "interval"), "interval", ["1m", "1d"]),
        count: integer(optional(query, "count"), "count", 1, 200),
        before: dateTime(optional(query, "before"), "before"),
        adjusted: boolean(optional(query, "adjusted"), "adjusted"),
      });
    case "stocks":
      assertAllowed(query, ["symbols"]);
      return withQuery("/api/v1/stocks", { symbols: stockSymbols(query) });
    case "warnings": {
      assertAllowed(query, ["symbol"]);
      const value = symbol(query);
      return `/api/v1/stocks/${encodeURIComponent(value)}/warnings`;
    }
    case "exchange-rate":
      assertAllowed(query, ["baseCurrency", "quoteCurrency", "dateTime"]);
      return withQuery("/api/v1/exchange-rate", {
        baseCurrency: oneOf(required(query, "baseCurrency"), "baseCurrency", ["KRW", "USD"]),
        quoteCurrency: oneOf(required(query, "quoteCurrency"), "quoteCurrency", ["KRW", "USD"]),
        dateTime: dateTime(optional(query, "dateTime"), "dateTime"),
      });
    case "market-calendar": {
      assertAllowed(query, ["country", "date"]);
      const country = oneOf(required(query, "country"), "country", ["KR", "US"]);
      return withQuery(`/api/v1/market-calendar/${country}`, {
        date: calendarDate(optional(query, "date"), "date"),
      });
    }
    case "rankings":
      assertAllowed(query, ["type", "marketCountry", "duration", "excludeInvestmentCaution", "count"]);
      return withQuery("/api/v1/rankings", {
        type: oneOf(required(query, "type"), "type", [
          "MARKET_TRADING_AMOUNT",
          "MARKET_TRADING_VOLUME",
          "TOP_GAINERS",
          "TOP_LOSERS",
          "TOSS_SECURITIES_TRADING_AMOUNT",
          "TOSS_SECURITIES_TRADING_VOLUME",
        ]),
        marketCountry: oneOf(required(query, "marketCountry"), "marketCountry", ["KR", "US"]),
        duration: oneOf(required(query, "duration"), "duration", ["realtime", "1d", "1w", "1mo", "3mo", "6mo", "1y"]),
        excludeInvestmentCaution: boolean(optional(query, "excludeInvestmentCaution"), "excludeInvestmentCaution"),
        count: integer(optional(query, "count"), "count", 1, 100),
      });
    case "indicator-prices":
      assertAllowed(query, ["symbols"]);
      return withQuery("/api/v1/market-indicators/prices", {
        symbols: pattern(required(query, "symbols"), "symbols", /^[A-Za-z0-9_,]+$/, 1_000),
      });
    case "indicator-candles": {
      assertAllowed(query, ["symbol", "interval", "count", "before"]);
      const value = indicatorSymbol(query);
      return withQuery(`/api/v1/market-indicators/${encodeURIComponent(value)}/candles`, {
        interval: oneOf(required(query, "interval"), "interval", ["1m", "1d"]),
        count: integer(optional(query, "count"), "count", 1, 200),
        before: dateTime(optional(query, "before"), "before"),
      });
    }
    case "investor-trading": {
      assertAllowed(query, ["symbol", "interval", "count", "until"]);
      const value = oneOf(required(query, "symbol"), "symbol", ["KOSPI", "KOSDAQ"]);
      return withQuery(`/api/v1/market-indicators/${value}/investor-trading`, {
        interval: oneOf(required(query, "interval"), "interval", ["1d", "1w", "1mo", "1y"]),
        count: integer(optional(query, "count"), "count", 1, 100),
        until: calendarDate(optional(query, "until"), "until"),
      });
    }
  }
}
