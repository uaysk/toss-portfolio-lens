import { describe, expect, it } from "vitest";
import {
  asOfJoinByKey,
  scanHighVolatilityUniverse,
  type HighVolatilityCandidateObservation,
} from "./high-volatility-scanner.js";

const ORIGIN = "2026-07-28T00:00:00.000Z";
const SETTINGS = {
  symbolCount: 1 as const,
  minimumListingDays: 90,
  minimumTradingAmountUsd: 25_000_000,
  maximumSpreadBps: 12,
  depthRangeBps: 10,
  minimumDepthUsd: 250_000,
  maximumMissingRate: 0.02,
  rescanIntervalMinutes: 30,
  riskAppetite: "balanced" as const,
};

function candidate(
  symbol: string,
  overrides: Partial<HighVolatilityCandidateObservation> = {},
): HighVolatilityCandidateObservation {
  return {
    symbol,
    observedAt: "2026-07-27T23:59:59.000Z",
    listingAt: "2024-01-01T00:00:00.000Z",
    quoteAsset: "USDT",
    contractType: "PERPETUAL",
    missingRate: 0,
    tradingAmountUsd: 100_000_000,
    tradeCount: 50_000,
    medianSpreadBps: 2,
    p95SpreadBps: 4,
    depthUsd: 1_000_000,
    staleQuote: false,
    abnormalGap: false,
    halted: false,
    fundingRate: 0.0001,
    basisRate: 0.001,
    realizedVolatility: 0.03,
    normalizedAtr: 0.02,
    rollingRange: 0.08,
    bollingerWidthExpansion: 1.5,
    relativeVolume: 2,
    liquidityQuality: 0.9,
    ...overrides,
  };
}

describe("point-in-time high-volatility scanner", () => {
  it("applies hard gates before ranking and persists exclusion reasons", () => {
    const result = scanHighVolatilityUniverse([
      candidate("SOLUSDT"),
      candidate("DOGEUSDT", { realizedVolatility: 0.05, tradingAmountUsd: 80_000_000 }),
      candidate("BTCUSDT"),
      candidate("USDCUSDT"),
      candidate("NEWUSDT", { listingAt: "2026-07-20T00:00:00.000Z" }),
      candidate("WIDEUSDT", { medianSpreadBps: 20 }),
      candidate("FUTUREUSDT", { observedAt: "2026-07-28T00:01:00.000Z" }),
    ], ORIGIN, SETTINGS);

    expect(result.totalCandidateCount).toBe(6);
    expect(result.eligibleCandidateCount).toBe(2);
    expect(result.selectedSymbols).toEqual(["DOGEUSDT"]);
    expect(result.candidates.find(({ symbol }) => symbol === "BTCUSDT")?.exclusionReasons)
      .toContain("CORE_ASSET_EXCLUDED");
    expect(result.candidates.find(({ symbol }) => symbol === "USDCUSDT")?.exclusionReasons)
      .toContain("STABLECOIN_LIKE");
    expect(result.candidates.find(({ symbol }) => symbol === "WIDEUSDT")?.exclusionReasons)
      .toContain("SPREAD_TOO_WIDE");
    expect(result.candidates.some(({ symbol }) => symbol === "FUTUREUSDT")).toBe(false);
  });

  it("joins the latest observation at or before each origin", () => {
    const rows = new Map([
      ["SOLUSDT", [
        { observedAt: "2026-07-27T23:59:00.000Z", value: 1 },
        { observedAt: "2026-07-28T00:01:00.000Z", value: 999 },
      ]],
    ]);
    expect(asOfJoinByKey(rows, ORIGIN).get("SOLUSDT")?.value).toBe(1);
  });
});
