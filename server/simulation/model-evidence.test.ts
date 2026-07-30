import { describe, expect, it } from "vitest";
import {
  normalizeModelEvidence,
  probabilityAtOrBelow,
} from "./model-evidence.js";

const ORIGIN = "2026-07-28T00:00:00.000Z";

describe("common model evidence", () => {
  it("preserves native tails, repairs quantile crossing, and subtracts directional costs", () => {
    const evidence = normalizeModelEvidence({
      modelLane: "chronos2",
      modelId: "amazon/chronos-2",
      modelRevision: "254b5357164a84326913b0695216f690752ac55d",
      role: "primary",
      symbol: "BTCUSDT",
      originAt: ORIGIN,
      horizonMinutes: 30,
      quantiles: {
        0.01: -0.03,
        0.05: -0.02,
        0.1: -0.01,
        0.5: 0.012,
        0.9: 0.01,
        0.95: 0.03,
        0.99: 0.05,
      },
      calibrationId: "c2:BTCUSDT:30",
      calibrationStatus: "ready",
      calibrationAge: 4,
      featureProfile: "chronos2_compact_causal_v1",
      dataQuality: {
        status: "ok",
        finalizedOnly: true,
        stale: false,
        missingRate: 0,
        unavailableFeatures: [],
        warnings: [],
      },
      generatedAt: "2026-07-28T00:00:01.000Z",
      latencyMs: 100,
      inputOrigin: "historical",
      costs: {
        commissionBps: 8,
        spreadBps: 4,
        slippageBps: 3,
        fundingBps: 1,
        safetyMarginBps: 2,
      },
    });

    expect(evidence.q01Return).toBe(-0.03);
    expect(evidence.q05Return).toBe(-0.02);
    expect(evidence.q95Return).toBe(0.03);
    expect(evidence.q99Return).toBe(0.05);
    expect(evidence.quantileCrossingCorrected).toBe(true);
    expect(evidence.q90Return).toBeGreaterThanOrEqual(evidence.q50Return);
    expect(evidence.expectedNetReturn).toBeLessThan(evidence.expectedReturn);
    expect(evidence.pNetLong).toBe(
      1 - probabilityAtOrBelow(
        evidence.rawQuantiles,
        (8 + 4 + 3 + 1 + 2) / 10_000,
      ),
    );
  });

  it("does not clone q05 into q10", () => {
    const evidence = normalizeModelEvidence({
      modelLane: "fincast",
      modelId: "amazon/fincast",
      modelRevision: "test",
      role: "shadow",
      symbol: "ETHUSDT",
      originAt: ORIGIN,
      horizonMinutes: 15,
      quantiles: { 0.05: -0.04, 0.1: -0.01, 0.5: 0, 0.9: 0.02, 0.95: 0.05 },
      calibrationId: "fincast:ETHUSDT:15",
      calibrationStatus: "ready",
      calibrationAge: 1,
      featureProfile: "fincast_causal_v1",
      dataQuality: {
        status: "ok",
        finalizedOnly: true,
        stale: false,
        missingRate: 0,
        unavailableFeatures: [],
        warnings: [],
      },
      generatedAt: ORIGIN,
      latencyMs: 1,
      inputOrigin: "deterministic_test",
      costs: {
        commissionBps: 0,
        spreadBps: 0,
        slippageBps: 0,
        fundingBps: 0,
        safetyMarginBps: 0,
      },
    });
    expect(evidence.q05Return).toBe(-0.04);
    expect(evidence.q10Return).toBeCloseTo(-0.01, 12);
  });
});
