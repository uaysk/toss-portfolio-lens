import { describe, expect, it, vi } from "vitest";
import {
  TossProviderContractError,
  TossScalpingProvider,
  normalizeTossMinuteCandles,
  normalizeTossOrderbook,
  normalizeTossRankings,
  normalizeTossTrades,
  normalizeTossWarnings,
  type TossProviderConfig,
  type TossRawMarketClient,
  type TossRawMarketResponse,
} from "./toss-provider.js";

const fetchedAt = "2026-07-21T00:00:01Z";

function config(overrides: Partial<TossProviderConfig> = {}): TossProviderConfig {
  const rateLimit = {
    initialIntervalMs: 0,
    minimumIntervalMs: 0,
    maximumIntervalMs: 10_000,
    maximumHeaderDelayMs: 10_000,
    sleep: vi.fn().mockResolvedValue(undefined),
    now: () => 0,
  };
  return {
    rankingMaximumCount: 50,
    pricesBatchSize: 2,
    candlesMaximumCount: 100,
    tradesMaximumCount: 40,
    cacheMaximumEntries: 30,
    cacheTtlMs: {
      rankings: 1_000,
      prices: 1_000,
      candles: 1_000,
      orderbook: 1_000,
      trades: 1_000,
      warnings: 1_000,
      calendar: 1_000,
    },
    retry: {
      maxAttempts: 3,
      baseDelayMs: 10,
      maximumDelayMs: 100,
      jitterRatio: 0,
      sleep: vi.fn().mockResolvedValue(undefined),
    },
    rateLimits: {
      ranking: { ...rateLimit },
      market_data: { ...rateLimit },
      chart: { ...rateLimit },
      stock: { ...rateLimit },
      market_info: { ...rateLimit },
    },
    now: () => 0,
    ...overrides,
  };
}

function response(feature: TossRawMarketResponse["feature"], data: unknown, headers?: Record<string, string>): TossRawMarketResponse {
  return { feature, upstreamPath: `/test/${feature}`, fetchedAt, data, ...(headers ? { headers } : {}) };
}

describe("Toss normalizers", () => {
  it("normalizes ranking fields without inventing missing metrics", () => {
    expect(normalizeTossRankings({
      result: {
        rankedAt: "2026-07-21T09:00:00+09:00",
        rankings: [{
          rank: 1,
          symbol: "005930",
          name: "삼성전자",
          currency: "KRW",
          price: "80,000",
          basePrice: 79_000,
          changeRate: "0.0125",
          volume: "1,000",
          tradingAmount: "80000000",
        }],
      },
    }, fetchedAt, "KR")).toEqual([{
      provider: "toss",
      rank: 1,
      symbol: "005930",
      name: "삼성전자",
      marketCountry: "KR",
      currency: "KRW",
      rankedAt: "2026-07-21T09:00:00+09:00",
      price: 80_000,
      basePrice: 79_000,
      changeRateRatio: 0.0125,
      volume: 1_000,
      tradingAmount: 80_000_000,
    }]);
    expect(normalizeTossRankings({ result: { rankedAt: null, rankings: [] } }, fetchedAt, "KR")).toEqual([]);
  });

  it("rejects malformed rankings and impossible candles", () => {
    expect(() => normalizeTossRankings({ result: { rankedAt: fetchedAt, rankings: [{ rank: 1 }] } }, fetchedAt, "KR"))
      .toThrow(TossProviderContractError);
    expect(() => normalizeTossMinuteCandles({ result: { candles: [{
      timestamp: "2026-07-21T09:00:00+09:00",
      open: 100,
      high: 99,
      low: 98,
      close: 101,
    }] } }, "005930")).toThrow(/high must bound/);
  });

  it("preserves US currency and canonical exchange without guessing unknown venues", () => {
    expect(normalizeTossRankings({ result: {
      rankedAt: "2026-07-21T09:31:00-04:00",
      rankings: [{ rank: 1, symbol: "AAPL", currency: "USD", market: "NASDAQ", price: 220 }],
    } }, fetchedAt, "US")).toEqual([expect.objectContaining({
      symbol: "AAPL", marketCountry: "US", currency: "USD", exchange: "NAS",
    })]);
    expect(normalizeTossRankings({ result: {
      rankedAt: "2026-07-21T09:31:00-04:00",
      rankings: [{ rank: 1, symbol: "TEST", currency: "USD", market: "OTC", price: 10 }],
    } }, fetchedAt, "US")[0]).not.toHaveProperty("exchange");

    const candle = normalizeTossMinuteCandles({ result: { candles: [{
      timestamp: "2026-07-21T00:30:00Z", open: 10, high: 11, low: 9, close: 10,
    }] } }, "AAPL", "US")[0]!;
    expect(candle.sessionDate).toBe("2026-07-21");
    const afterMidnightDay = normalizeTossMinuteCandles({ result: { candles: [{
      timestamp: "2026-07-21T04:30:00Z", open: 10, high: 11, low: 9, close: 10,
    }] } }, "AAPL", "US")[0]!;
    expect(afterMidnightDay.sessionDate).toBe("2026-07-21");
  });

  it("sorts orderbook levels and retains unknown warning codes", () => {
    const book = normalizeTossOrderbook({ result: {
      symbol: "005930",
      timestamp: "2026-07-21T09:01:00+09:00",
      asks: [{ price: "102", quantity: "4" }, { price: "101", quantity: "3" }],
      bids: [{ price: "99", quantity: "2" }, { price: "100", quantity: "1" }],
    } }, "005930", fetchedAt);
    expect(book.asks.map(({ price }) => price)).toEqual([101, 102]);
    expect(book.bids.map(({ price }) => price)).toEqual([100, 99]);

    expect(normalizeTossWarnings({ result: { warnings: [{ code: "NEW_PROVIDER_CODE" }] } }, "005930", fetchedAt))
      .toEqual([{
        provider: "toss",
        symbol: "005930",
        code: "NEW_PROVIDER_CODE",
        severity: "unknown",
        observedAt: fetchedAt,
      }]);
  });

  it("creates deterministic fallback trade identifiers and rejects zero quantities", () => {
    const payload = { result: { trades: [{
      timestamp: "2026-07-21T09:02:00+09:00",
      price: 101,
      volume: "5",
      cumulativeVolume: 50,
      side: "BID",
    }] } };
    const first = normalizeTossTrades(payload, "005930")[0]!;
    const second = normalizeTossTrades(payload, "005930")[0]!;
    expect(first.eventId).toBe(second.eventId);
    expect(first.eventIdSource).toBe("composite");
    expect(first.side).toBe("buy");
    expect(() => normalizeTossTrades({ result: { trades: [{ ...payload.result.trades[0], volume: 0 }] } }, "005930"))
      .toThrow(/quantity/);
  });
});

describe("TossScalpingProvider", () => {
  it("coalesces cached ranking requests and observes provider rate headers", async () => {
    const getReadOnlyMarketData = vi.fn(async () => response("rankings", { result: {
      rankedAt: "2026-07-21T09:00:00+09:00",
      rankings: [{
        rank: 1,
        symbol: "005930",
        currency: "KRW",
        price: { lastPrice: "100", basePrice: "98", changeRate: "0.02" },
        tradingVolume: "10",
        tradingAmount: "1000",
      }],
    } }, {
      "x-ratelimit-limit": "20",
      "x-ratelimit-remaining": "4",
      "x-ratelimit-reset": "2",
    }));
    const provider = new TossScalpingProvider({ getReadOnlyMarketData } as TossRawMarketClient, config());
    const first = provider.getRankings("volume", 5);
    const second = provider.getRankings("volume", 5);
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(getReadOnlyMarketData).toHaveBeenCalledTimes(1);
    expect(provider.rateLimitSnapshot("ranking")).toMatchObject({
      observedLimit: 20,
      observedRemaining: 4,
      intervalMs: 500,
    });
    await expect(first).resolves.toEqual([expect.objectContaining({
      price: 100,
      basePrice: 98,
      changeRateRatio: 0.02,
      volume: 10,
      tradingAmount: 1000,
    })]);
  });

  it("uses the provider-supported daily top-gainers contract for volatility candidate discovery", async () => {
    const getReadOnlyMarketData = vi.fn(async (feature, query) => response(feature, { result: {
      rankedAt: fetchedAt,
      rankings: [{ rank: 1, symbol: "005930", currency: "KRW", price: 100, changeRate: 0.02 }],
    } }));
    const provider = new TossScalpingProvider({ getReadOnlyMarketData } as TossRawMarketClient, config());
    await expect(provider.getRankings("change_rate", 5)).resolves.toHaveLength(1);
    expect(getReadOnlyMarketData).toHaveBeenCalledWith("rankings", expect.objectContaining({
      type: "TOP_GAINERS",
      duration: "1d",
      count: "5",
    }));
  });

  it("passes the selected US market through ranking requests and normalizes USD results", async () => {
    const getReadOnlyMarketData = vi.fn(async (feature, query) => response(feature, { result: {
      rankedAt: "2026-07-21T09:31:00-04:00",
      rankings: [{ rank: 1, symbol: "AAPL", currency: "USD", exchange: "NAS", price: 220 }],
    } }));
    const provider = new TossScalpingProvider({ getReadOnlyMarketData } as TossRawMarketClient, config());
    await expect(provider.getRankings("trading_amount", 5, "US")).resolves.toEqual([
      expect.objectContaining({ symbol: "AAPL", marketCountry: "US", currency: "USD", exchange: "NAS" }),
    ]);
    expect(getReadOnlyMarketData).toHaveBeenCalledWith("rankings", expect.objectContaining({ marketCountry: "US" }));
  });

  it("normalizes KR integrated KRX/NXT calendar days and explicit integrated-null holidays", async () => {
    const getReadOnlyMarketData = vi.fn(async (feature, query) => response(feature, { result: {
      today: query.date === "2026-07-25" ? {
        date: "2026-07-25",
        integrated: null,
      } : {
        date: "2026-07-22",
        integrated: {
          preMarket: {
            startTime: "2026-07-22T08:00:00+09:00",
            singlePriceAuctionStartTime: "2026-07-22T08:40:00+09:00",
            endTime: "2026-07-22T08:50:00+09:00",
          },
          regularMarket: {
            startTime: "2026-07-22T09:00:00+09:00",
            endTime: "2026-07-22T15:30:00+09:00",
          },
          afterMarket: {
            startTime: "2026-07-22T15:40:00+09:00",
            singlePriceAuctionEndTime: "2026-07-22T19:50:00+09:00",
            endTime: "2026-07-22T20:00:00+09:00",
          },
        },
      },
    } }));
    const provider = new TossScalpingProvider({ getReadOnlyMarketData } as TossRawMarketClient, config());

    await expect(provider.getMarketCalendar("KR", "2026-07-22")).resolves.toEqual({
      marketCountry: "KR",
      sessionDate: "2026-07-22",
      dayMarket: null,
      preMarket: null,
      regularMarket: {
        startAt: "2026-07-22T09:00:00+09:00",
        endAt: "2026-07-22T15:30:00+09:00",
      },
      afterMarket: null,
    });
    await expect(provider.getMarketCalendar("KR", "2026-07-25")).resolves.toEqual({
      marketCountry: "KR",
      sessionDate: "2026-07-25",
      dayMarket: null,
      preMarket: null,
      regularMarket: null,
      afterMarket: null,
    });
    expect(getReadOnlyMarketData).toHaveBeenNthCalledWith(1, "market-calendar", {
      country: "KR", date: "2026-07-22",
    });
    expect(getReadOnlyMarketData).toHaveBeenNthCalledWith(2, "market-calendar", {
      country: "KR", date: "2026-07-25",
    });
  });

  it("caches and validates all US sessions including a cross-midnight day market and early close", async () => {
    const getReadOnlyMarketData = vi.fn(async (feature) => response(feature, { result: {
      today: {
        date: "2026-11-27",
        dayMarket: { startTime: "2026-11-27T10:00:00+09:00", endTime: "2026-11-27T18:00:00+09:00" },
        preMarket: { startTime: "2026-11-27T18:00:00+09:00", endTime: "2026-11-27T23:30:00+09:00" },
        regularMarket: { startTime: "2026-11-27T23:30:00+09:00", endTime: "2026-11-28T03:00:00+09:00" },
        afterMarket: { startTime: "2026-11-28T03:00:00+09:00", endTime: "2026-11-28T08:50:00+09:00" },
      },
    } }));
    const provider = new TossScalpingProvider({ getReadOnlyMarketData } as TossRawMarketClient, config());
    const first = provider.getMarketCalendar("US", "2026-11-27");
    const second = provider.getMarketCalendar("US", "2026-11-27");
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({
        marketCountry: "US", sessionDate: "2026-11-27",
        dayMarket: {
          startAt: "2026-11-27T10:00:00+09:00", endAt: "2026-11-27T18:00:00+09:00",
        },
        preMarket: {
          startAt: "2026-11-27T18:00:00+09:00", endAt: "2026-11-27T23:30:00+09:00",
        },
        regularMarket: {
          startAt: "2026-11-27T23:30:00+09:00", endAt: "2026-11-28T03:00:00+09:00",
        },
        afterMarket: {
          startAt: "2026-11-28T03:00:00+09:00", endAt: "2026-11-28T08:50:00+09:00",
        },
      }),
      expect.anything(),
    ]);
    expect(getReadOnlyMarketData).toHaveBeenCalledTimes(1);
    expect(getReadOnlyMarketData).toHaveBeenCalledWith("market-calendar", {
      country: "US", date: "2026-11-27",
    });
  });

  it("rejects a US day-market period that is not attached to the following trading date", async () => {
    const provider = new TossScalpingProvider({
      getReadOnlyMarketData: vi.fn(async (feature) => response(feature, { result: { today: {
        date: "2026-07-22",
        dayMarket: { startTime: "2026-07-22T20:00:00-04:00", endTime: "2026-07-23T04:00:00-04:00" },
        preMarket: null,
        regularMarket: null,
        afterMarket: null,
      } } })),
    } as TossRawMarketClient, config());
    await expect(provider.getMarketCalendar("US", "2026-07-22"))
      .rejects.toThrow(/dayMarket timestamps do not match today\.date/);
  });

  it("rejects country-shape and local-session-date mismatches instead of confirming a session", async () => {
    const krTopLevelOnly = new TossScalpingProvider({
      getReadOnlyMarketData: vi.fn(async (feature) => response(feature, { result: { today: {
        date: "2026-07-22",
        regularMarket: {
          startTime: "2026-07-22T09:00:00+09:00",
          endTime: "2026-07-22T15:30:00+09:00",
        },
      } } })),
    } as TossRawMarketClient, config());
    await expect(krTopLevelOnly.getMarketCalendar("KR", "2026-07-22"))
      .rejects.toThrow(/today\.integrated must be an object or null/);

    const mismatchedSessionDate = new TossScalpingProvider({
      getReadOnlyMarketData: vi.fn(async (feature) => response(feature, { result: { today: {
        date: "2026-07-22",
        integrated: { regularMarket: {
          startTime: "2026-07-21T09:00:00+09:00",
          endTime: "2026-07-21T15:30:00+09:00",
        } },
      } } })),
    } as TossRawMarketClient, config());
    await expect(mismatchedSessionDate.getMarketCalendar("KR", "2026-07-22"))
      .rejects.toThrow(/timestamps do not match today\.date/);

    const mismatchedProviderDate = new TossScalpingProvider({
      getReadOnlyMarketData: vi.fn(async (feature) => response(feature, { result: { today: {
        date: "2026-11-26",
        regularMarket: null,
      } } })),
    } as TossRawMarketClient, config());
    await expect(mismatchedProviderDate.getMarketCalendar("US", "2026-11-27"))
      .rejects.toThrow(/today\.date does not match the requested date/);
  });

  it("batches price requests using configured capacity", async () => {
    const getReadOnlyMarketData = vi.fn(async (feature, query) => response(feature, {
      result: { prices: String(query.symbols).split(",").map((symbol) => ({
        symbol,
        currency: "KRW",
        lastPrice: "100",
        timestamp: fetchedAt,
      })) },
    }));
    const provider = new TossScalpingProvider({ getReadOnlyMarketData } as TossRawMarketClient, config());
    await expect(provider.getPrices(["A", "B", "C", "D", "E"])).resolves.toHaveLength(5);
    expect(getReadOnlyMarketData).toHaveBeenCalledTimes(3);
    expect(getReadOnlyMarketData.mock.calls.map(([, query]) => query.symbols)).toEqual(["A,B", "C,D", "E"]);
  });

  it("applies configured retry policy without logging provider errors", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    let attempts = 0;
    const getReadOnlyMarketData = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error("limited"), {
        status: 429,
        code: "rate-limit",
        headers: { "retry-after": "0.02" },
      });
      return response("warnings", { result: { warnings: [] } });
    });
    const provider = new TossScalpingProvider({ getReadOnlyMarketData } as TossRawMarketClient, config({
      retry: {
        maxAttempts: 2,
        baseDelayMs: 5,
        maximumDelayMs: 100,
        jitterRatio: 0,
        sleep,
        now: () => 0,
      },
    }));
    await expect(provider.getWarnings("005930")).resolves.toEqual([]);
    expect(attempts).toBe(2);
    expect(sleep).toHaveBeenCalledWith(20);
  });

  it("enforces configured request capacities", async () => {
    const provider = new TossScalpingProvider({
      getReadOnlyMarketData: vi.fn(),
    } as unknown as TossRawMarketClient, config());
    await expect(provider.getRankings("volume", 51)).rejects.toThrow(/between 1 and 50/);
    await expect(provider.getMinuteCandles("005930", 101)).rejects.toThrow(/between 1 and 100/);
    await expect(provider.getTrades("005930", 41)).rejects.toThrow(/between 1 and 40/);
  });
});
