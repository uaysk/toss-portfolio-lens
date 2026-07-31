import { describe, expect, it } from "vitest";
import { fuseForecastWithTechnical } from "./forecast-technical-fusion.js";

const origin = "2026-07-26T00:10:00.000Z";
const generated = "2026-07-26T00:10:01.000Z";

function evidence(score: number, riskScale = 0.8) {
  return {
    originAt: origin,
    calculationAt: origin,
    eligibleAfter: "2026-07-26T00:11:00.000Z",
    quality: "good" as const,
    confidence: 1,
    indicators: {
      schemaVersion: "rust-indicator-evidence/v1" as const,
      directionalScore: score,
      riskScale,
      availableIndicatorCount: 4,
      usedDirectionalIndicatorCount: 3,
      usedRiskIndicatorCount: 1,
      components: {},
    },
  };
}

describe("forecast technical fusion", () => {
  it("keeps direction and only scales down aligned exposure", () => {
    const result = fuseForecastWithTechnical({
      lane: "fincast",
      modelDirection: "long",
      modelConfidence: 0.8,
      modelOriginAt: origin,
      modelGeneratedAt: generated,
      technical: evidence(0.7),
      maximumTechnicalAgeMs: 60_000,
    });
    expect(result.admitted).toBe(true);
    expect(result.direction).toBe("long");
    expect(result.exposureScale).toBeGreaterThan(0);
    expect(result.exposureScale).toBeLessThanOrEqual(0.8);
    expect(result.eligibleAfter).toBe("2026-07-26T00:11:00.000Z");
  });

  it("vetoes a strong conflict without reversing the model", () => {
    const result = fuseForecastWithTechnical({
      lane: "chronos2",
      modelDirection: "short",
      modelConfidence: 0.8,
      modelOriginAt: origin,
      modelGeneratedAt: generated,
      technical: evidence(0.8),
      maximumTechnicalAgeMs: 60_000,
    });
    expect(result.admitted).toBe(false);
    expect(result.direction).toBe("short");
    expect(result.exposureScale).toBe(0);
    expect(result.reasonCodes).toContain("technical_direction_conflict");
  });

  it("fails closed for future, stale, or unavailable evidence", () => {
    const future = fuseForecastWithTechnical({
      lane: "fincast",
      modelDirection: "long",
      modelConfidence: 0.8,
      modelOriginAt: origin,
      modelGeneratedAt: generated,
      technical: { ...evidence(0.5), calculationAt: "2026-07-26T00:10:00.001Z" },
      maximumTechnicalAgeMs: 60_000,
    });
    expect(future.reasonCodes).toEqual(["technical_evidence_after_model_origin"]);
    const unavailable = fuseForecastWithTechnical({
      lane: "fincast",
      modelDirection: "long",
      modelConfidence: 0.8,
      modelOriginAt: origin,
      modelGeneratedAt: generated,
      technical: { ...evidence(0.5), quality: "unavailable" },
      maximumTechnicalAgeMs: 60_000,
    });
    expect(unavailable.admitted).toBe(false);
  });

  it("fails closed when configured evidence has no causal timestamp", () => {
    const result = fuseForecastWithTechnical({
      lane: "chronos2",
      modelDirection: "long",
      modelConfidence: 0.8,
      modelOriginAt: origin,
      modelGeneratedAt: generated,
      technical: {
        quality: "good",
        indicators: evidence(0.5).indicators,
        patternBias: "bullish",
        patternStrength: 0.8,
      },
      maximumTechnicalAgeMs: 60_000,
    });

    expect(result).toMatchObject({
      admitted: false,
      exposureScale: 0,
      reasonCodes: ["technical_evidence_timestamp_missing"],
    });
  });

  it("lets liquidity risk evidence reduce exposure without changing admission or direction", () => {
    const ordinary = fuseForecastWithTechnical({
      lane: "fincast",
      modelDirection: "long",
      modelConfidence: 0.8,
      modelOriginAt: origin,
      modelGeneratedAt: generated,
      technical: evidence(0.7, 1),
      maximumTechnicalAgeMs: 60_000,
    });
    const liquidityReduced = fuseForecastWithTechnical({
      lane: "fincast",
      modelDirection: "long",
      modelConfidence: 0.8,
      modelOriginAt: origin,
      modelGeneratedAt: generated,
      technical: evidence(0.7, 0.5),
      maximumTechnicalAgeMs: 60_000,
    });

    expect(liquidityReduced.admitted).toBe(ordinary.admitted);
    expect(liquidityReduced.direction).toBe(ordinary.direction);
    expect(liquidityReduced.technicalScore).toBe(ordinary.technicalScore);
    expect(liquidityReduced.exposureScale).toBeLessThan(ordinary.exposureScale);
  });
});
