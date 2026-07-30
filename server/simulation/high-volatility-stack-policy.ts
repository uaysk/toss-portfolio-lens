import type { ModelEvidence } from "./model-evidence.js";
import type { RustMarketEvidenceV2 } from "./technical-indicator-evidence.js";

export const HIGH_VOLATILITY_STACK_POLICY_VERSION =
  "high-volatility-stack-policy/v2" as const;
export const FINCAST_VETO_PROBABILITY_CALIBRATION_VERSION =
  "fincast-veto-probability-calibration/v1" as const;

export type HighVolatilityHorizon = 5 | 15 | 30 | 60;
export type HighVolatilityDirection = "long" | "short";
export type HighVolatilityRegime = "low" | "normal" | "high";

export type HighVolatilityRustQuality = Readonly<{
  score: number;
  components: Readonly<{
    liquidity: number | null;
    exitSafety: number | null;
    trendPersistence: number | null;
    widthExpansion: number | null;
    freshness: number | null;
  }>;
  unavailableComponents: readonly string[];
}>;

export type HighVolatilityHorizonAssessment = Readonly<{
  horizonMinutes: HighVolatilityHorizon;
  entryAllowed: boolean;
  preferenceScale: number;
  passedGates: readonly string[];
  blockedGates: readonly string[];
}>;

export type VetoProbabilityCalibrationSample = Readonly<{
  modelLane: string;
  symbol: string;
  horizonMinutes: HighVolatilityHorizon;
  volatilityRegime: HighVolatilityRegime;
  direction: HighVolatilityDirection;
  originAt: string;
  resolvedAt: string;
  rawProbability: number;
  outcome: 0 | 1;
}>;

export type VetoProbabilityCalibration = Readonly<{
  version: typeof FINCAST_VETO_PROBABILITY_CALIBRATION_VERSION;
  calibrationId: string;
  status: "ready" | "warming_up" | "stale";
  scope: "symbol_horizon_regime" | "symbol_horizon_fallback";
  volatilityRegime: HighVolatilityRegime;
  direction: HighVolatilityDirection;
  rawProbability: number;
  calibratedProbability: number | null;
  threshold: number;
  sampleCount: number;
  ageMinutes: number;
  cutoffAt: string;
  usedSampleOrigins: readonly string[];
}>;

export type HighVolatilityUnifiedPolicyContext = Readonly<{
  policyVersion: typeof HIGH_VOLATILITY_STACK_POLICY_VERSION;
  volatilityRegime: HighVolatilityRegime;
  rustQuality: HighVolatilityRustQuality;
  horizonAssessments: Partial<
    Record<HighVolatilityHorizon, HighVolatilityHorizonAssessment>
  >;
  vetoCalibrationByHorizon?: Partial<
    Record<HighVolatilityHorizon, VetoProbabilityCalibration>
  >;
}>;

export type HighVolatilityCandidateInput = Readonly<{
  symbol: string;
  scannerRank: number;
  scannerScore: number;
  primaryEvidence: readonly ModelEvidence[];
  rustEvidence: RustMarketEvidenceV2;
  adx: number | null;
  fundingRate: number | null;
  basisRate: number | null;
}>;

export type HighVolatilityCandidateSelection = Readonly<{
  policyVersion: typeof HIGH_VOLATILITY_STACK_POLICY_VERSION;
  selectedSymbols: readonly string[];
  candidates: readonly Readonly<{
    symbol: string;
    scannerRank: number;
    scannerScore: number;
    eligible: boolean;
    selectedHorizonMinutes: HighVolatilityHorizon | null;
    direction: HighVolatilityDirection | null;
    score: number | null;
    rustQualityScore: number;
    expectedNetReturn: number | null;
    pNet: number | null;
    reasons: readonly string[];
    horizonAssessments: Partial<
      Record<HighVolatilityHorizon, HighVolatilityHorizonAssessment>
    >;
  }>[];
}>;

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function finite(value: number | null | undefined): value is number {
  return value !== null && value !== undefined && Number.isFinite(value);
}

function timestamp(value: string, label: string): number {
  const result = Date.parse(value);
  if (!Number.isFinite(result)) throw new Error(`${label} must be an ISO timestamp.`);
  return result;
}

function percentile(values: readonly number[], probability: number): number {
  if (values.length === 0) throw new Error("percentile requires at least one value.");
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(probability * sorted.length) - 1),
  );
  return sorted[index]!;
}

/**
 * The Rust layer is deliberately non-directional here. It can rank otherwise
 * valid model opportunities and attenuate weak market structure, but its trend
 * sign never flips or vetoes a Chronos-2 direction.
 */
export function scoreHighVolatilityRustQuality(
  evidence: RustMarketEvidenceV2,
): HighVolatilityRustQuality {
  const weighted: Array<readonly [string, number, number | null]> = [
    [
      "liquidity",
      0.3,
      finite(evidence.liquidityQuality)
        ? clamp(evidence.liquidityQuality)
        : null,
    ],
    [
      "exitSafety",
      0.25,
      finite(evidence.exitRisk) ? 1 - clamp(evidence.exitRisk) : null,
    ],
    [
      "trendPersistence",
      0.2,
      finite(evidence.choppiness)
        ? clamp((65 - evidence.choppiness) / 30)
        : null,
    ],
    [
      "widthExpansion",
      0.15,
      finite(evidence.bollingerWidthExpansion)
        ? clamp((evidence.bollingerWidthExpansion + 0.5) / 2)
        : null,
    ],
    [
      "freshness",
      0.1,
      finite(evidence.quoteFreshnessMs)
        ? evidence.quoteFreshnessMs <= 60_000
          ? 1
          : evidence.quoteFreshnessMs <= 120_000
            ? 0.5
            : 0
        : null,
    ],
  ];
  const components = Object.fromEntries(
    weighted.map(([key, _weight, value]) => [key, value]),
  ) as HighVolatilityRustQuality["components"];
  const score = weighted.reduce(
    (sum, [_key, weight, value]) => sum + (value ?? 0) * weight,
    0,
  );
  return {
    score: clamp(score),
    components,
    unavailableComponents: weighted.flatMap(([key, _weight, value]) => (
      value === null ? [key] : []
    )),
  };
}

export function assessHighVolatilityHorizons(input: {
  rustEvidence: RustMarketEvidenceV2;
  adx: number | null;
  fundingRate: number | null;
  basisRate: number | null;
}): Partial<Record<HighVolatilityHorizon, HighVolatilityHorizonAssessment>> {
  const commonPassed = ["RUST_SOFT_QUALITY_APPLIED"];
  const short = (horizonMinutes: 15 | 30): HighVolatilityHorizonAssessment => ({
    horizonMinutes,
    entryAllowed: true,
    preferenceScale: horizonMinutes === 30 ? 1 : 0.95,
    passedGates: commonPassed,
    blockedGates: [],
  });
  const blocked60: string[] = [];
  const passed60: string[] = [];
  const gate = (condition: boolean, name: string) => {
    (condition ? passed60 : blocked60).push(name);
  };
  gate(finite(input.adx) && input.adx >= 25, "ADX_25");
  gate(
    finite(input.fundingRate) && Math.abs(input.fundingRate) <= 0.0005,
    "FUNDING_NORMAL",
  );
  gate(
    finite(input.basisRate) && Math.abs(input.basisRate) <= 0.01,
    "BASIS_NORMAL",
  );
  gate(
    finite(input.rustEvidence.liquidityQuality)
      && input.rustEvidence.liquidityQuality >= 0.75,
    "LIQUIDITY_075",
  );
  gate(
    finite(input.rustEvidence.exitRisk) && input.rustEvidence.exitRisk <= 0.25,
    "EXIT_RISK_025",
  );
  gate(
    finite(input.rustEvidence.choppiness) && input.rustEvidence.choppiness <= 55,
    "CHOPPINESS_55",
  );
  gate(
    finite(input.rustEvidence.bollingerWidthExpansion)
      && input.rustEvidence.bollingerWidthExpansion >= 0.05,
    "BB_WIDTH_EXPANDING",
  );
  gate(
    finite(input.rustEvidence.quoteFreshnessMs)
      && input.rustEvidence.quoteFreshnessMs <= 60_000,
    "QUOTE_FRESH_60S",
  );
  return {
    5: {
      horizonMinutes: 5,
      entryAllowed: false,
      preferenceScale: 0,
      passedGates: [],
      blockedGates: ["RISK_MANAGEMENT_ONLY"],
    },
    15: short(15),
    30: short(30),
    60: {
      horizonMinutes: 60,
      entryAllowed: blocked60.length === 0,
      preferenceScale: 0.65,
      passedGates: passed60,
      blockedGates: blocked60,
    },
  };
}

export function classifyCausalVolatilityRegime(
  historicalValues: readonly number[],
  currentValue: number | null | undefined,
): HighVolatilityRegime {
  const finiteHistory = historicalValues.filter(
    (value) => Number.isFinite(value) && value >= 0,
  );
  if (!finite(currentValue) || currentValue < 0 || finiteHistory.length < 24) {
    return "normal";
  }
  const low = percentile(finiteHistory, 1 / 3);
  const high = percentile(finiteHistory, 2 / 3);
  if (currentValue <= low) return "low";
  if (currentValue >= high) return "high";
  return "normal";
}

export function fitVetoProbabilityCalibration(
  samples: readonly VetoProbabilityCalibrationSample[],
  input: {
    modelLane: string;
    symbol: string;
    horizonMinutes: HighVolatilityHorizon;
    volatilityRegime: HighVolatilityRegime;
    direction: HighVolatilityDirection;
    originAt: string;
    rawProbability: number;
  },
  options: {
    minimumExactSamples?: number;
    minimumFallbackSamples?: number;
    maximumSamples?: number;
    maximumAgeMinutes?: number;
    threshold?: number;
  } = {},
): VetoProbabilityCalibration {
  const cutoffMs = timestamp(input.originAt, "originAt");
  const minimumExactSamples = options.minimumExactSamples ?? 12;
  const minimumFallbackSamples = options.minimumFallbackSamples ?? 30;
  const maximumSamples = options.maximumSamples ?? 96;
  const maximumAgeMinutes = options.maximumAgeMinutes ?? 24 * 60;
  const threshold = options.threshold ?? 0.71;
  if (!Number.isFinite(input.rawProbability)
    || input.rawProbability < 0
    || input.rawProbability > 1) {
    throw new Error("rawProbability must be between zero and one.");
  }
  const common = samples.filter((sample) => (
    sample.modelLane === input.modelLane
    && sample.symbol.toUpperCase() === input.symbol.toUpperCase()
    && sample.horizonMinutes === input.horizonMinutes
    && sample.direction === input.direction
    && timestamp(sample.originAt, "sample.originAt") < cutoffMs
    && timestamp(sample.resolvedAt, "sample.resolvedAt") < cutoffMs
    && Number.isFinite(sample.rawProbability)
    && sample.rawProbability >= 0
    && sample.rawProbability <= 1
  ));
  const exact = common.filter(
    (sample) => sample.volatilityRegime === input.volatilityRegime,
  );
  const scope = exact.length >= minimumExactSamples
    ? "symbol_horizon_regime"
    : "symbol_horizon_fallback";
  const eligible = (scope === "symbol_horizon_regime" ? exact : common)
    .sort((left, right) => (
      Math.abs(left.rawProbability - input.rawProbability)
        - Math.abs(right.rawProbability - input.rawProbability)
      || timestamp(right.resolvedAt, "right.resolvedAt")
        - timestamp(left.resolvedAt, "left.resolvedAt")
    ))
    .slice(0, maximumSamples);
  const requiredSamples = scope === "symbol_horizon_regime"
    ? minimumExactSamples
    : minimumFallbackSamples;
  const latest = [...eligible].sort((left, right) => (
    timestamp(right.resolvedAt, "right.resolvedAt")
      - timestamp(left.resolvedAt, "left.resolvedAt")
  ))[0];
  const ageMinutes = latest
    ? Math.max(
        0,
        Math.floor(
          (cutoffMs - timestamp(latest.resolvedAt, "latest.resolvedAt")) / 60_000,
        ),
      )
    : 0;
  const status = eligible.length < requiredSamples
    ? "warming_up"
    : ageMinutes > maximumAgeMinutes
      ? "stale"
      : "ready";
  const weighted = eligible.map((sample) => ({
    ...sample,
    weight: Math.max(
      0.2,
      1 - Math.abs(sample.rawProbability - input.rawProbability) / 0.25,
    ),
  }));
  const weightTotal = weighted.reduce((sum, sample) => sum + sample.weight, 0);
  const successes = weighted.reduce(
    (sum, sample) => sum + sample.outcome * sample.weight,
    0,
  );
  // A small prior centered on the current raw probability prevents a sparse
  // regime bucket from turning one outcome into a 0%/100% veto probability.
  const priorStrength = 8;
  const calibratedProbability = status === "ready"
    ? clamp(
        (successes + input.rawProbability * priorStrength)
          / (weightTotal + priorStrength),
      )
    : null;
  return {
    version: FINCAST_VETO_PROBABILITY_CALIBRATION_VERSION,
    calibrationId: [
      FINCAST_VETO_PROBABILITY_CALIBRATION_VERSION,
      input.modelLane,
      input.symbol.toUpperCase(),
      input.horizonMinutes,
      scope === "symbol_horizon_regime" ? input.volatilityRegime : "all",
      input.direction,
      eligible.length,
    ].join(":"),
    status,
    scope,
    volatilityRegime: input.volatilityRegime,
    direction: input.direction,
    rawProbability: input.rawProbability,
    calibratedProbability,
    threshold,
    sampleCount: eligible.length,
    ageMinutes,
    cutoffAt: new Date(cutoffMs).toISOString(),
    usedSampleOrigins: eligible.map((sample) => sample.originAt),
  };
}

function selectionThreshold(horizonMinutes: HighVolatilityHorizon): number {
  return horizonMinutes === 60 ? 0.74 : 0.65;
}

export function selectHighVolatilityCandidates(
  candidates: readonly HighVolatilityCandidateInput[],
  executionSymbolCount = 2,
): HighVolatilityCandidateSelection {
  if (!Number.isInteger(executionSymbolCount)
    || executionSymbolCount < 1
    || executionSymbolCount > 2) {
    throw new Error("executionSymbolCount must be one or two.");
  }
  const rows = candidates.map((candidate) => {
    const rustQuality = scoreHighVolatilityRustQuality(candidate.rustEvidence);
    const horizonAssessments = assessHighVolatilityHorizons({
      rustEvidence: candidate.rustEvidence,
      adx: candidate.adx,
      fundingRate: candidate.fundingRate,
      basisRate: candidate.basisRate,
    });
    const rejectionReasons: string[] = [];
    const scored = candidate.primaryEvidence.flatMap((evidence) => {
      const horizon = evidence.horizonMinutes as HighVolatilityHorizon;
      const assessment = horizonAssessments[horizon];
      const reasons: string[] = [];
      if (!assessment?.entryAllowed) reasons.push(...(assessment?.blockedGates ?? []));
      if (evidence.calibrationStatus !== "ready") reasons.push("CALIBRATION_NOT_READY");
      if (evidence.dataQuality.status !== "ok" || evidence.dataQuality.stale) {
        reasons.push("MODEL_DATA_QUALITY");
      }
      const direction: HighVolatilityDirection =
        evidence.pNetLong >= evidence.pNetShort ? "long" : "short";
      const pNet = direction === "long" ? evidence.pNetLong : evidence.pNetShort;
      if (pNet < selectionThreshold(horizon)) reasons.push("PNET_BELOW_THRESHOLD");
      const expectedNetReturn = direction === "long"
        ? evidence.expectedNetReturn
        : -evidence.expectedNetReturn;
      if (expectedNetReturn <= 0) reasons.push("NO_NET_EDGE");
      const tailLoss = direction === "long"
        ? Math.max(evidence.expectedShortfall, -evidence.q10Return, 0.0001)
        : Math.max(evidence.q90Return, 0.0001);
      if (reasons.length > 0) {
        rejectionReasons.push(
          ...reasons.map((reason) => `${horizon}M:${reason}`),
        );
        return [];
      }
      const scannerScale = 0.85 + clamp(candidate.scannerScore) * 0.15;
      return [{
        horizon,
        direction,
        pNet,
        expectedNetReturn,
        score: expectedNetReturn / tailLoss
          * rustQuality.score
          * assessment!.preferenceScale
          * scannerScale
          * (0.5 + pNet),
      }];
    }).sort((left, right) => (
      right.score - left.score
      || (left.horizon === 30 ? -1 : 1)
    ));
    const best = scored[0];
    return {
      symbol: candidate.symbol.toUpperCase(),
      scannerRank: candidate.scannerRank,
      scannerScore: candidate.scannerScore,
      eligible: best !== undefined,
      selectedHorizonMinutes: best?.horizon ?? null,
      direction: best?.direction ?? null,
      score: best?.score ?? null,
      rustQualityScore: rustQuality.score,
      expectedNetReturn: best?.expectedNetReturn ?? null,
      pNet: best?.pNet ?? null,
      reasons: best
        ? []
        : [
            "NO_QUALIFIED_COST_ADJUSTED_HORIZON",
            ...new Set(rejectionReasons),
          ],
      horizonAssessments,
    };
  }).sort((left, right) => (
    Number(right.eligible) - Number(left.eligible)
    || (right.score ?? Number.NEGATIVE_INFINITY)
      - (left.score ?? Number.NEGATIVE_INFINITY)
    || left.scannerRank - right.scannerRank
    || left.symbol.localeCompare(right.symbol)
  ));
  return {
    policyVersion: HIGH_VOLATILITY_STACK_POLICY_VERSION,
    selectedSymbols: rows
      .filter((row) => row.eligible)
      .slice(0, executionSymbolCount)
      .map((row) => row.symbol),
    candidates: rows,
  };
}
