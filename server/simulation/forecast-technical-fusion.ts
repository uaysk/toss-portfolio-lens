import type { RustIndicatorEvidence } from "./technical-indicator-evidence.js";

export const FORECAST_TECHNICAL_FUSION_VERSION =
  "forecast-technical-fusion/v1" as const;

export type FusionDirection = "long" | "short" | "flat";
export type FusionQuality = "good" | "partial" | "stale" | "unavailable";

export type ForecastTechnicalFusionResult = {
  policyVersion: typeof FORECAST_TECHNICAL_FUSION_VERSION;
  direction: FusionDirection;
  admitted: boolean;
  exposureScale: number;
  eligibleAfter: string;
  technicalScore: number;
  technicalDirection: FusionDirection;
  reasonCodes: string[];
  components: Record<string, number>;
};

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function rounded(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function timestamp(value: string | undefined): number | undefined {
  const parsed = value === undefined ? Number.NaN : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function latestIso(values: readonly (string | undefined)[]): string {
  const parsed = values.flatMap((value) => {
    const instant = timestamp(value);
    return instant === undefined ? [] : [instant];
  });
  return new Date(Math.max(...parsed)).toISOString();
}

function technicalDirection(score: number): FusionDirection {
  return score >= 0.15 ? "long" : score <= -0.15 ? "short" : "flat";
}

/**
 * A causal post-forecast policy. It never changes the base model direction and
 * never increases size or leverage. Technical evidence can confirm, veto, or
 * reduce exposure only.
 */
export function fuseForecastWithTechnical(input: {
  lane: "kronos_base" | "fincast";
  modelDirection: FusionDirection;
  modelConfidence: number;
  modelOriginAt: string;
  modelGeneratedAt: string;
  technical?: {
    originAt?: string;
    calculationAt?: string;
    evidenceAt?: string;
    eligibleAfter?: string;
    quality: FusionQuality;
    directionalSignal?: -1 | 0 | 1;
    confidence?: number;
    multiTimeframeAgreement?: string;
    indicators?: RustIndicatorEvidence;
    patternBias?: "bullish" | "bearish" | "neutral";
    patternStrength?: number;
  };
  maximumTechnicalAgeMs: number;
  technicalBoundaryToleranceMs?: number;
}): ForecastTechnicalFusionResult {
  const origin = timestamp(input.modelOriginAt);
  const generated = timestamp(input.modelGeneratedAt);
  if (origin === undefined || generated === undefined) {
    throw new Error("Model origin and generation timestamps must be valid.");
  }
  const technical = input.technical;
  const reasons: string[] = [];
  const components: Record<string, number> = {
    modelConfidence: rounded(clamp(input.modelConfidence)),
  };
  if (!technical) {
    return {
      policyVersion: FORECAST_TECHNICAL_FUSION_VERSION,
      direction: input.modelDirection,
      admitted: true,
      exposureScale: 1,
      eligibleAfter: latestIso([input.modelOriginAt, input.modelGeneratedAt]),
      technicalScore: 0,
      technicalDirection: "flat",
      reasonCodes: ["technical_evidence_not_configured"],
      components,
    };
  }

  const technicalOrigin = timestamp(
    technical.originAt ?? technical.calculationAt ?? technical.evidenceAt,
  );
  const calculationAt = timestamp(
    technical.calculationAt ?? technical.originAt ?? technical.evidenceAt,
  );
  const eligibleAfter = latestIso([
    input.modelOriginAt,
    input.modelGeneratedAt,
    technical.eligibleAfter,
    technical.calculationAt,
    technical.evidenceAt,
  ]);
  if (technicalOrigin === undefined || calculationAt === undefined) {
    return {
      policyVersion: FORECAST_TECHNICAL_FUSION_VERSION,
      direction: input.modelDirection,
      admitted: false,
      exposureScale: 0,
      eligibleAfter,
      technicalScore: 0,
      technicalDirection: "flat",
      reasonCodes: ["technical_evidence_timestamp_missing"],
      components,
    };
  }
  const boundaryTolerance = Math.max(
    0,
    Math.min(1_000, input.technicalBoundaryToleranceMs ?? 0),
  );
  if (technicalOrigin !== undefined && technicalOrigin - origin > boundaryTolerance
    || calculationAt !== undefined && calculationAt - origin > boundaryTolerance) {
    return {
      policyVersion: FORECAST_TECHNICAL_FUSION_VERSION,
      direction: input.modelDirection,
      admitted: false,
      exposureScale: 0,
      eligibleAfter,
      technicalScore: 0,
      technicalDirection: "flat",
      reasonCodes: ["technical_evidence_after_model_origin"],
      components,
    };
  }
  if (technicalOrigin !== undefined
    && origin - technicalOrigin > input.maximumTechnicalAgeMs) {
    return {
      policyVersion: FORECAST_TECHNICAL_FUSION_VERSION,
      direction: input.modelDirection,
      admitted: false,
      exposureScale: 0,
      eligibleAfter,
      technicalScore: 0,
      technicalDirection: "flat",
      reasonCodes: ["technical_evidence_stale"],
      components,
    };
  }
  if (technical.quality === "stale" || technical.quality === "unavailable") {
    return {
      policyVersion: FORECAST_TECHNICAL_FUSION_VERSION,
      direction: input.modelDirection,
      admitted: false,
      exposureScale: 0,
      eligibleAfter,
      technicalScore: 0,
      technicalDirection: "flat",
      reasonCodes: [`technical_quality_${technical.quality}`],
      components,
    };
  }

  const indicatorScore = clamp(
    technical.indicators?.directionalScore ?? 0,
    -1,
    1,
  );
  const signalScore = clamp(technical.directionalSignal ?? 0, -1, 1);
  const agreementScore = technical.multiTimeframeAgreement === "aligned_bullish"
    ? 1
    : technical.multiTimeframeAgreement === "aligned_bearish" ? -1 : 0;
  const patternScore = technical.patternBias === "bullish"
    ? clamp(technical.patternStrength ?? 0.5)
    : technical.patternBias === "bearish"
      ? -clamp(technical.patternStrength ?? 0.5) : 0;
  const weighted = indicatorScore * 0.55
    + signalScore * 0.15
    + agreementScore * 0.15
    + patternScore * 0.15;
  const technicalScore = rounded(clamp(weighted, -1, 1));
  const direction = technicalDirection(technicalScore);
  components.indicatorDirectionalScore = rounded(indicatorScore);
  components.directionalSignal = rounded(signalScore);
  components.multiTimeframeAgreement = rounded(agreementScore);
  components.patternScore = rounded(patternScore);
  components.technicalScore = technicalScore;
  components.indicatorRiskScale = rounded(technical.indicators?.riskScale ?? 1);

  if (input.modelDirection === "flat") {
    reasons.push("base_model_flat");
    return {
      policyVersion: FORECAST_TECHNICAL_FUSION_VERSION,
      direction: input.modelDirection,
      admitted: false,
      exposureScale: 0,
      eligibleAfter,
      technicalScore,
      technicalDirection: direction,
      reasonCodes: reasons,
      components,
    };
  }
  const sign = input.modelDirection === "long" ? 1 : -1;
  const alignment = technicalScore * sign;
  const strongPatternConflict = patternScore * sign <= -0.65;
  if (alignment <= -0.25 || strongPatternConflict) {
    reasons.push(strongPatternConflict
      ? "strong_pattern_conflict"
      : "technical_direction_conflict");
    return {
      policyVersion: FORECAST_TECHNICAL_FUSION_VERSION,
      direction: input.modelDirection,
      admitted: false,
      exposureScale: 0,
      eligibleAfter,
      technicalScore,
      technicalDirection: direction,
      reasonCodes: reasons,
      components,
    };
  }

  const qualityScale = technical.quality === "partial" ? 0.65 : 1;
  const completenessScale = 0.5 + 0.5 * clamp(technical.confidence ?? 1);
  const alignmentScale = alignment >= 0.15
    ? 0.7 + Math.min(0.3, alignment * 0.3)
    : alignment < 0 ? 0.4 : 0.6;
  const exposureScale = rounded(clamp(
    (technical.indicators?.riskScale ?? 1)
      * qualityScale
      * completenessScale
      * alignmentScale,
  ));
  reasons.push(alignment >= 0.15
    ? "technical_direction_confirmed"
    : alignment < 0 ? "weak_technical_conflict_size_reduced" : "technical_neutral_size_reduced");
  if (technical.quality === "partial") reasons.push("partial_technical_quality_size_reduced");
  return {
    policyVersion: FORECAST_TECHNICAL_FUSION_VERSION,
    direction: input.modelDirection,
    admitted: exposureScale > 0,
    exposureScale,
    eligibleAfter,
    technicalScore,
    technicalDirection: direction,
    reasonCodes: reasons,
    components,
  };
}
