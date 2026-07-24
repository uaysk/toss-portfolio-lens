import { describe, expect, it } from "vitest";
import { calculatePairPositionSize } from "./pair-sizing.js";

const base = {
  equity: 100_000,
  availableCash: 100_000,
  executionPrice: 50,
  executionPriceObservedAt: "2026-07-24T14:30:06.000Z",
  eligibleAfter: "2026-07-24T14:30:05.000Z",
  leverageMultiplier: 2,
  predictedVolatility: 0.02,
  targetVolatility: 0.02,
  riskTolerance: 50,
  ensembleExposureScale: 1,
  maximumUnderlyingExposureRate: 1,
  entryCostRate: 0,
} as const;

describe("pair exposure sizing", () => {
  it("converts a target underlying exposure into whole execution shares", () => {
    const sized = calculatePairPositionSize(base);
    expect(sized).toMatchObject({
      status: "sized",
      quantity: 500,
      targetExecutionQuantity: 500,
      executionGross: 25_000,
      underlyingExposure: 50_000,
      underlyingExposureRate: 0.5,
      riskScale: 0.5,
      volatilityScale: 1,
    });
  });

  it("uses leverage, predicted volatility, risk, and ensemble scale without overexposure", () => {
    const defensive = calculatePairPositionSize({
      ...base,
      leverageMultiplier: -2,
      predictedVolatility: 0.04,
      riskTolerance: 25,
      ensembleExposureScale: 0.5,
    });
    const aggressive = calculatePairPositionSize({
      ...base,
      leverageMultiplier: -1,
      predictedVolatility: 0.01,
      riskTolerance: 100,
    });
    // Whole-share sizing rounds the 6,250 target exposure down to
    // 62 shares * $50 * 2x = 6,200.
    expect(defensive.underlyingExposure).toBe(6_200);
    expect(aggressive.underlyingExposure).toBeLessThanOrEqual(base.equity);
    expect(aggressive.quantity).toBeGreaterThan(defensive.quantity);
  });

  it("fails closed when the execution price is not strictly after eligibility", () => {
    expect(calculatePairPositionSize({
      ...base,
      executionPriceObservedAt: base.eligibleAfter,
    })).toMatchObject({
      status: "unavailable",
      quantity: 0,
      reasonCodes: ["execution_price_not_after_signal"],
    });
  });

  it("returns cash for zero risk, an already met target, or an unaffordable whole share", () => {
    expect(calculatePairPositionSize({ ...base, riskTolerance: 0 }).status).toBe("cash");
    expect(calculatePairPositionSize({
      ...base,
      currentExecutionQuantity: 500,
    }).reasonCodes).toContain("target_exposure_already_met");
    expect(calculatePairPositionSize({
      ...base,
      availableCash: 1,
    }).reasonCodes).toContain("insufficient_cash_for_whole_lot");
  });

  it("does not invent volatility or accept malformed leverage and cost inputs", () => {
    const result = calculatePairPositionSize({
      ...base,
      leverageMultiplier: 0,
      predictedVolatility: 0,
      entryCostRate: 1,
    });
    expect(result.status).toBe("unavailable");
    expect(result.reasonCodes).toEqual(expect.arrayContaining([
      "leverage_multiplier_invalid",
      "predicted_volatility_unavailable",
      "entry_cost_rate_invalid",
    ]));
  });
});
