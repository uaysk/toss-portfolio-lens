import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "./env.js";
import {
  normalizeCandlePage,
  normalizeExchangeRatePayload,
  normalizeHoldingsPayload,
  normalizeInstrumentsPayload,
  normalizeOrderPage,
  TossClient,
} from "./toss.js";

function staticBearerConfig(): AppConfig {
  return {
    tossApiAuthMode: "static_bearer",
    tossApiBearerToken: "local-read-only-token",
    dashboardPassword: "dashboard-password",
    readOnlyApiToken: "dashboard-read-only-api-token",
    readOnlyApiTokenSource: "READ_ONLY_API_TOKEN",
    sessionSecret: "session-secret-with-at-least-32-characters",
    host: "127.0.0.1",
    port: 3200,
    trustProxy: [],
    gracefulShutdownTimeoutMs: 30_000,
    tossApiBaseUrl: "https://tpl.uaysk.com",
    dbProvider: "sqlite",
    databasePath: ":memory:",
    candleCacheLatestTtlMs: 300_000,
    snapshotRefreshHours: 6,
    nodeEnv: "test",
    publicAppUrl: "http://localhost:3200",
    reportStorage: { kind: "local", directory: "/tmp/reports" },
    compute: {
      executionMode: "inline",
      resultPollMs: 250,
      resultDeadlineMs: 300_000,
      rustSocketPath: "/tmp/toss-portfolio-lens-compute.sock",
      rustSocketPoolSize: 2,
      rustSocketTimeoutMs: 300_000,
    },
    mcp: {
      enabled: false,
      authMode: "oauth",
      allowedOrigins: [],
      maxRequestsPerMinute: 60,
      maxConcurrentRuns: 1,
      maxRunsPerSubject: 2,
      maxQueuedRuns: 4,
      runDeadlineMs: 120_000,
      maxAssets: 20,
      maxCandidateBudget: 2_000,
      maxDateRangeYears: 20,
      inlineResultMaxRows: 1_000,
      inlineResultMaxBytes: 204_800,
      auditRetentionDays: 90,
    },
    scalping: {
      enabled: false,
      minimumTopCount: 5,
      maximumTopCount: 50,
      ai: {
        url: "ws://127.0.0.1:8765/ws/scalping-ai/v1",
        authTokenFile: "/tmp/toss-portfolio-lens-ai-token",
        timeoutMs: 120_000,
        connectTimeoutMs: 10_000,
        reconnectBaseMs: 250,
        reconnectMaxMs: 10_000,
        maximumInFlight: 4,
        maximumBatchSize: 50,
        maximumRequestBytes: 64 * 1024 * 1024,
        maximumResponseBytes: 128 * 1024 * 1024,
      },
      simulation: {
        maximumDurationMinutes: 390,
        decisionIntervalSeconds: 20,
        maximumActiveSessions: 2,
        selectionMaximumAttempts: 3,
        selectionRetryDelayMs: 15_000,
      },
    },
  };
}

function oauthConfig(): AppConfig {
  return {
    ...staticBearerConfig(),
    tossApiAuthMode: "oauth_client_credentials",
    clientId: "client-id",
    clientSecret: "client-secret",
    tossApiBearerToken: undefined,
    tossApiBaseUrl: "https://openapi.tossinvest.com",
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("TossClient 인증", () => {
  it("기본 OAuth 모드는 Client Credentials 토큰을 발급받아 사용한다", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "oauth-access-token", expires_in: 3600 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        result: [{ id: "account-1", name: "대표 계좌", type: "STOCK" }],
      }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await new TossClient(oauthConfig()).getAccounts(true);

    expect(fetchMock).toHaveBeenNthCalledWith(1, "https://openapi.tossinvest.com/oauth2/token", expect.objectContaining({
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    }));
    expect(String(fetchMock.mock.calls[0]?.[1]?.body)).toContain("client_id=client-id");
    expect(fetchMock).toHaveBeenNthCalledWith(2, "https://openapi.tossinvest.com/api/v1/accounts", expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer oauth-access-token" }),
    }));
  });

  it("정적 Bearer 모드는 토큰 교환 없이 호환 API를 직접 호출한다", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      result: [{ id: "account-1", name: "대표 계좌", type: "STOCK" }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const accounts = await new TossClient(staticBearerConfig()).getAccounts(true);

    expect(accounts).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("https://tpl.uaysk.com/api/v1/accounts", expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer local-read-only-token" }),
    }));
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/oauth2/token"))).toBe(false);
  });

  it("정적 Bearer 인증 실패는 같은 토큰으로 재시도하지 않는다", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      error: { code: "unauthorized", message: "invalid token" },
    }), { status: 401, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(new TossClient(staticBearerConfig()).getAccounts(true)).rejects.toMatchObject({
      status: 401,
      code: "unauthorized",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("시장 데이터의 rate-limit header만 provider 계층에 전달한다", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      result: { rankings: [] },
    }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "X-RateLimit-Limit": "100",
        "X-RateLimit-Remaining": "40",
        "Set-Cookie": "must-not-leak=secret",
      },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await new TossClient(staticBearerConfig()).getReadOnlyMarketData("rankings", {
      type: "MARKET_TRADING_AMOUNT",
      marketCountry: "KR",
      duration: "realtime",
      count: "5",
    });
    expect(result.headers).toEqual({
      "x-ratelimit-limit": "100",
      "x-ratelimit-remaining": "40",
    });
    expect(result.headers).not.toHaveProperty("set-cookie");
  });
});

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
          volume: "12,345,678",
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
        volume: 12_345_678,
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

  it.each([
    ["005930", "KRW", "19,928,148"],
    ["AAPL", "USD", "48,052,900"],
    ["069500", "KRW", "4,122,351"],
    ["SPY", "USD", "77,409,112"],
  ] as const)("실제 Toss 응답 형태의 %s %s volume 문자열을 보존한다", (symbol, currency, rawVolume) => {
    const page = normalizeCandlePage({
      result: {
        candles: [{
          date: "2026-07-20",
          timestamp: "2026-07-20T00:00:00+09:00",
          currency,
          openPrice: "100",
          highPrice: "110",
          lowPrice: "90",
          closePrice: "105",
          volume: rawVolume,
        }],
      },
    }, symbol);

    expect(page.candles[0]?.volume).toBe(Number(rawVolume.replaceAll(",", "")));
  });

  it.each([
    undefined,
    null,
    "",
    " , ",
    "-1",
    "NaN",
    Number.NaN,
    -1,
    {},
    "12x",
  ])("volume 결측·비정상 값 %j을 0으로 만들지 않는다", (volume) => {
    const page = normalizeCandlePage({
      result: {
        candles: [{
          date: "2026-07-20",
          timestamp: "2026-07-20T00:00:00+09:00",
          currency: "KRW",
          openPrice: 100,
          highPrice: 110,
          lowPrice: 90,
          closePrice: 105,
          volume,
        }],
      },
    }, "005930");

    expect(page.candles[0]).not.toHaveProperty("volume");
  });
});
