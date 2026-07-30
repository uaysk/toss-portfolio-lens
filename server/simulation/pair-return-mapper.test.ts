import { describe, expect, it } from "vitest";
import { getPairCatalogEntry } from "./pair-catalog.js";
import {
  applyEtfSessionGate,
  evaluateEtfSessionGate,
  fitPairReturnMapper,
  selectEtfPairDirection,
  type PairReturnObservation,
} from "./pair-return-mapper.js";

function history(): PairReturnObservation[] {
  return Array.from({ length: 120 }, (_, index) => {
    const targetReturn = ((index % 11) - 5) / 1_000;
    return {
      observedAt: new Date(Date.UTC(2026, 6, 27, 12, index)).toISOString(),
      targetReturn,
      bullReturn: 0.0002 + targetReturn * 2.35 + (index % 3 - 1) * 0.0001,
      bearReturn: -0.0003 - targetReturn * 2.05 + (index % 5 - 2) * 0.0001,
      timeOfDayBucket: index % 2 ? "10" : "11",
      volatilityRegime: index % 3 ? "normal" : "high",
    };
  });
}

describe("ETF PairReturnMapper", () => {
  it("fits causal per-leg distributions instead of multiplying the target by three", () => {
    const pair = getPairCatalogEntry("spy-spxl-spxs");
    const result = fitPairReturnMapper({
      originAt: "2026-07-28T00:00:00.000Z",
      pair,
      targetQuantiles: { 0.1: -0.01, 0.5: 0.004, 0.9: 0.014 },
      targetExpectedReturn: 0.004,
      history: history(),
      timeOfDayBucket: "10",
      volatilityRegime: "normal",
      bullCosts: {
        commissionBps: 2,
        spreadBps: 3,
        slippageBps: 2,
        fundingBps: 0,
        safetyMarginBps: 1,
      },
      bearCosts: {
        commissionBps: 2,
        spreadBps: 5,
        slippageBps: 3,
        fundingBps: 0,
        safetyMarginBps: 1,
      },
    });
    expect(result.status).toBe("ready");
    expect(result.simpleLeverageMultiplicationUsed).toBe(false);
    expect(result.bull?.effectiveBeta).not.toBe(3);
    expect(result.bear?.effectiveBeta).not.toBe(-3);
    expect(result.bull?.expectedReturn).not.toBeCloseTo(0.012, 8);
    expect(result.bull?.totalCostBps).not.toBe(result.bear?.totalCostBps);
  });

  it("rejects future training rows and enforces regular-session entry gates", () => {
    const pair = getPairCatalogEntry("qqq-tqqq-sqqq");
    const futureOnly = history().map((row) => ({
      ...row,
      observedAt: "2026-07-29T00:00:00.000Z",
    }));
    expect(fitPairReturnMapper({
      originAt: "2026-07-28T00:00:00.000Z",
      pair,
      targetQuantiles: { 0.1: -0.01, 0.5: 0, 0.9: 0.01 },
      targetExpectedReturn: 0,
      history: futureOnly,
      timeOfDayBucket: "10",
      volatilityRegime: "normal",
      bullCosts: { commissionBps: 0, spreadBps: 0, slippageBps: 0, fundingBps: 0, safetyMarginBps: 0 },
      bearCosts: { commissionBps: 0, spreadBps: 0, slippageBps: 0, fundingBps: 0, safetyMarginBps: 0 },
    }).status).toBe("warming_up");

    expect(evaluateEtfSessionGate({
      originAt: "2026-07-28T13:34:00.000Z",
      marketCalendarStatus: "regular",
      minutesFromOpen: 4,
      minutesToClose: 386,
      quoteObservedAt: "2026-07-28T13:34:00.000Z",
      quoteSpreadBps: 2,
      maximumSpreadBps: 35,
      flattenBeforeClose: true,
    })).toMatchObject({
      canEnter: false,
      openingRange: "OR15",
    });
  });

  it("shares fail-closed cost-adjusted selection and session gating with replay", () => {
    const pair = getPairCatalogEntry("spy-spxl-spxs");
    const mapping = fitPairReturnMapper({
      originAt: "2026-07-28T14:30:00.000Z",
      pair,
      targetQuantiles: { 0.1: -0.004, 0.5: 0.006, 0.9: 0.018 },
      targetExpectedReturn: 0.006,
      history: history(),
      timeOfDayBucket: "10",
      volatilityRegime: "normal",
      bullCosts: { commissionBps: 1, spreadBps: 1, slippageBps: 1, fundingBps: 0, safetyMarginBps: 1 },
      bearCosts: { commissionBps: 1, spreadBps: 2, slippageBps: 2, fundingBps: 0, safetyMarginBps: 1 },
    });
    const selected = selectEtfPairDirection({
      mapping: {
        ...mapping,
        pNetBull: 0.74,
        pNetBear: 0.21,
        bull: mapping.bull && { ...mapping.bull, expectedNetReturn: 0.009 },
      },
      primaryAvailable: true,
      rustDataQuality: "good",
      rustTechnicalSignal: 1,
    });
    expect(selected.direction).toBe("bull");

    const gated = applyEtfSessionGate({
      proposedDirection: selected.direction,
      currentDirection: "cash",
      gate: evaluateEtfSessionGate({
        originAt: "2026-07-28T13:34:00.000Z",
        marketCalendarStatus: "regular",
        minutesFromOpen: 4,
        minutesToClose: 386,
        quoteObservedAt: "2026-07-28T13:34:00.000Z",
        quoteSpreadBps: 2,
        maximumSpreadBps: 35,
        flattenBeforeClose: true,
      }),
    });
    expect(gated.direction).toBe("cash");
    expect(gated.reasons).toContain("OR15_NOT_COMPLETE");

    expect(selectEtfPairDirection({
      mapping,
      primaryAvailable: false,
      rustDataQuality: "good",
      rustTechnicalSignal: 1,
    })).toMatchObject({
      direction: "cash",
      reasons: ["CHRONOS2_PRIMARY_UNAVAILABLE"],
    });
  });
});
