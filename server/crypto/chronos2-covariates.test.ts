import { describe, expect, it, vi } from "vitest";
import type { BinanceKline } from "./binance-market-data.js";
import {
  loadChronos2DerivativeCovariates,
  normalizeChronos2FundingHistory,
  normalizeChronos2ReferenceKlines,
  paceChronos2DerivativeMarketData,
  type Chronos2DerivativeRestMarketData,
} from "./chronos2-covariates.js";

const START = Date.parse("2026-06-01T00:00:00.000Z");

function bars(count: number): BinanceKline[] {
  return Array.from({ length: count }, (_value, index) => ({
    symbol: "BTCUSDT",
    interval: "1m",
    openTime: START + index * 60_000,
    closeTime: START + (index + 1) * 60_000 - 1,
    open: 100 + index,
    high: 101 + index,
    low: 99 + index,
    close: 100.5 + index,
    volume: 10 + index,
    quoteVolume: 1_000 + index,
    tradeCount: 20 + index,
    takerBuyVolume: 5 + index,
    takerBuyQuoteVolume: 500 + index,
    final: true,
  }));
}

function referencePayload(count: number, base: number): unknown[] {
  return Array.from({ length: count }, (_value, index) => [
    START + index * 60_000,
    String(base + index),
    String(base + index),
    String(base + index),
    String(base + index),
    "0",
    START + (index + 1) * 60_000 - 1,
  ]);
}

function rest(count: number): Chronos2DerivativeRestMarketData {
  return {
    markPriceKlines: vi.fn(async () => referencePayload(count, 100.1)),
    indexPriceKlines: vi.fn(async () => referencePayload(count, 99.9)),
    premiumIndexKlines: vi.fn(async () => referencePayload(count, -0.001)),
    fundingRateHistory: vi.fn(async () => [
      {
        symbol: "BTCUSDT",
        fundingTime: START - 1,
        fundingRate: "0.0001",
      },
      {
        symbol: "BTCUSDT",
        fundingTime: START + 60_000,
        fundingRate: "0.0002",
      },
    ]),
  };
}

describe("Chronos-2 Binance covariate acquisition", () => {
  it("normalizes reference klines and funding history without fabricating values", () => {
    expect(normalizeChronos2ReferenceKlines(referencePayload(2, 100), {
      requirePositive: true,
    })).toEqual([
      { openTime: START, closeTime: START + 59_999, close: 100 },
      { openTime: START + 60_000, closeTime: START + 119_999, close: 101 },
    ]);
    expect(normalizeChronos2FundingHistory([
      { fundingTime: String(START), fundingRate: "-0.0001" },
      { fundingTime: "invalid", fundingRate: "0.1" },
    ])).toEqual([{ fundingTime: START, fundingRate: -0.0001 }]);
  });

  it("merges complete 1m derivatives and forward-fills only already observed funding", async () => {
    const loaded = await loadChronos2DerivativeCovariates(rest(3), bars(3));

    expect(loaded).toMatchObject({
      schemaVersion: "chronos2-derivative-covariates/v1",
      symbol: "BTCUSDT",
      rowCount: 3,
      fundingObservationCount: 2,
      causalFundingPolicy: "latest_funding_time_lte_bar_close_v1",
    });
    expect(loaded.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(loaded.bars.map((bar) => bar.fundingRate)).toEqual([
      0.0001,
      0.0002,
      0.0002,
    ]);
    expect(loaded.bars[0]).toMatchObject({
      markPrice: 100.1,
      indexPrice: 99.9,
      premiumIndex: -0.001,
      takerBuyVolume: 5,
    });
  });

  it("fails closed when a reference series does not cover every requested minute", async () => {
    await expect(loadChronos2DerivativeCovariates(rest(2), bars(3)))
      .rejects.toThrow(/pagination did not advance|coverage is incomplete/);
  });

  it("paces concurrent derivative calls and retries only Binance rate limits", async () => {
    let now = 10_000;
    const delays: number[] = [];
    let markAttempts = 0;
    const source = rest(1);
    source.markPriceKlines = vi.fn(async () => {
      markAttempts += 1;
      if (markAttempts === 1) {
        throw Object.assign(new Error("Too many requests; request weight limit"), {
          code: -1003,
          name: "TooManyRequestsError",
        });
      }
      return referencePayload(1, 100);
    });
    const paced = paceChronos2DerivativeMarketData(source, {
      minimumSpacingMs: 250,
      rateLimitBackoffMs: 60_000,
      maximumRateLimitRetries: 2,
      clock: () => now,
      delay: async (milliseconds) => {
        delays.push(milliseconds);
        now += milliseconds;
      },
    });

    await Promise.all([
      paced.markPriceKlines({ symbol: "BTCUSDT" }),
      paced.indexPriceKlines({ symbol: "BTCUSDT" }),
      paced.premiumIndexKlines({ symbol: "BTCUSDT" }),
    ]);

    expect(markAttempts).toBe(2);
    expect(delays).toContain(60_000);
    expect(delays.filter((milliseconds) => milliseconds === 250).length)
      .toBeGreaterThanOrEqual(2);
  });

  it("does not retry non-rate-limit failures", async () => {
    const source = rest(1);
    source.markPriceKlines = vi.fn(async () => {
      throw new Error("invalid response");
    });
    const paced = paceChronos2DerivativeMarketData(source, {
      minimumSpacingMs: 0,
      rateLimitBackoffMs: 1_000,
      maximumRateLimitRetries: 2,
      delay: async () => undefined,
    });

    await expect(paced.markPriceKlines({ symbol: "BTCUSDT" }))
      .rejects.toThrow("invalid response");
    expect(source.markPriceKlines).toHaveBeenCalledTimes(1);
  });
});
