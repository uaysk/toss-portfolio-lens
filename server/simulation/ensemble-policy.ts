import type {
  NormalizedPairModelOutput,
  NormalizedPairModelSet,
} from "./model-output-normalization.js";
import {
  mapPairDirection,
  validatePairCatalogEntry,
  type PairCatalogEntry,
  type PairDirection,
  type PairSession,
} from "./pair-catalog.js";

export const PAIR_ENSEMBLE_POLICY_VERSION = "pair-ensemble-policy/v1" as const;

export type PairRustTechnicalState =
  | "watch"
  | "entry_candidate"
  | "hold"
  | "exit_candidate";

export type PairRustTechnicalInput = {
  status: PairRustTechnicalState | null;
  signalOriginAt?: string;
  observedAt?: string;
  earliestEligibleAt?: string;
  technicalSignal?: -1 | 0 | 1;
  multiTimeframeAgreement?: string;
  multiTimeframeTrends?: Readonly<Record<string, "bullish" | "bearish" | "neutral" | null>>;
  confidence?: number;
  chartPatternBias?: "bullish" | "bearish" | "neutral";
  chartPatterns?: readonly string[];
  dataQuality: "good" | "partial" | "stale" | "unavailable";
  rationale?: readonly string[];
  rawOutput?: unknown;
};

export type PairTradingCosts = {
  commissionBpsPerSide: number;
  taxBpsOnExit: number;
  spreadBpsRoundTrip: number;
  slippageBpsPerSide: number;
  switchCostBps: number;
};

export type PairExecutionQuote = {
  status: "available" | "stale" | "unavailable";
  observedAt?: string;
  spreadBps?: number;
};

export type PairExecutionMarketInput = {
  session: PairSession | "session_boundary" | "closed" | "unavailable";
  dataQuality: "good" | "partial" | "stale" | "unavailable";
  quotes: Partial<Record<"bull" | "bear", PairExecutionQuote>>;
};

export type PairEnsemblePolicyProfile = {
  policyVersion: typeof PAIR_ENSEMBLE_POLICY_VERSION;
  profileId: string;
  weights: {
    chronos2: number;
    kronos: number;
    rust: number;
  };
  modelScoreWeights: {
    netExpectedReturn: number;
    directionProbability: number;
    uncertaintyPenalty: number;
  };
  returnScale: number;
  uncertaintyScale: number;
  entryScoreThreshold: number;
  degradedEntryScoreThreshold: number;
  holdScoreThreshold: number;
  minimumScoreMargin: number;
  modelDirectionMargin: number;
  neutralRustExposureScale: number;
  minimumRiskForNeutralRust: number;
  cooldownMs: number;
  quoteMaximumAgeMs: number;
  allowDegradedMode: boolean;
  requireCalibration: boolean;
};

export const DEFAULT_PAIR_ENSEMBLE_POLICY_PROFILE: Readonly<PairEnsemblePolicyProfile> =
  Object.freeze({
    policyVersion: PAIR_ENSEMBLE_POLICY_VERSION,
    profileId: "conservative-v1",
    weights: Object.freeze({
      chronos2: 0.35,
      kronos: 0.35,
      rust: 0.3,
    }),
    modelScoreWeights: Object.freeze({
      netExpectedReturn: 0.55,
      directionProbability: 0.3,
      uncertaintyPenalty: 0.15,
    }),
    returnScale: 0.02,
    uncertaintyScale: 0.08,
    entryScoreThreshold: 0.24,
    degradedEntryScoreThreshold: 0.5,
    holdScoreThreshold: 0.08,
    minimumScoreMargin: 0.12,
    modelDirectionMargin: 0.05,
    neutralRustExposureScale: 0.5,
    minimumRiskForNeutralRust: 60,
    cooldownMs: 5 * 60_000,
    quoteMaximumAgeMs: 30_000,
    allowDegradedMode: false,
    requireCalibration: false,
  });

export type PairModelDirectionScore = {
  status: NormalizedPairModelOutput["status"];
  bull: number;
  bear: number;
  bullNetExpectedReturn: number;
  bearNetExpectedReturn: number;
  bullProbability: number;
  bearProbability: number;
  leveragedUncertainty: number;
  preferredDirection: PairDirection;
};

export type PairRustDirectionScore = {
  bull: number;
  bear: number;
  preferredDirection: PairDirection;
};

export type PairEnsembleDecision = {
  policyVersion: typeof PAIR_ENSEMBLE_POLICY_VERSION;
  profileId: string;
  pairId: string;
  signalSymbol: string;
  origin?: string;
  decisionAt: string;
  eligibleAfter: string;
  currentDirection: PairDirection;
  direction: PairDirection;
  executionSymbol: string | null;
  leverageMultiplier: number;
  decisionKind: "enter" | "hold" | "exit" | "switch" | "cash";
  degraded: boolean;
  exposureScale: number;
  reasonCodes: string[];
  weights: PairEnsemblePolicyProfile["weights"];
  componentScores: {
    chronos2: PairModelDirectionScore;
    kronos: PairModelDirectionScore;
    rust: PairRustDirectionScore;
  };
  finalScores: {
    bull: number;
    bear: number;
    cash: number;
  };
  scoreMargin: number;
  costs: {
    bullRoundTripRate: number;
    bearRoundTripRate: number;
    switchCostApplied: boolean;
  };
};

export type PairEnsembleInput = {
  pair: PairCatalogEntry;
  models: NormalizedPairModelSet;
  rust: PairRustTechnicalInput;
  currentDirection: PairDirection;
  decisionAt: string;
  riskTolerance: number;
  costs: PairTradingCosts;
  market: PairExecutionMarketInput;
  cooldownUntil?: string;
  profile?: PairEnsemblePolicyProfile;
};

function finiteTimestamp(value: string | undefined): string | undefined {
  if (!value || !Number.isFinite(Date.parse(value))) return undefined;
  return new Date(Date.parse(value)).toISOString();
}

function clamp(value: number, minimum = -1, maximum = 1): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function rounded(value: number): number {
  return Math.round(value * 1_000_000_000) / 1_000_000_000;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function validateNonnegativeBps(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 5_000) {
    throw new RangeError(`${name} must be finite basis points in [0, 5000].`);
  }
}

export function validatePairEnsemblePolicyProfile(
  profile: PairEnsemblePolicyProfile,
): PairEnsemblePolicyProfile {
  if (profile.policyVersion !== PAIR_ENSEMBLE_POLICY_VERSION
    || !profile.profileId.trim()) {
    throw new Error("Pair ensemble policy profile identity is invalid.");
  }
  const componentWeight = profile.weights.chronos2 + profile.weights.kronos + profile.weights.rust;
  const scoreWeight = profile.modelScoreWeights.netExpectedReturn
    + profile.modelScoreWeights.directionProbability
    + profile.modelScoreWeights.uncertaintyPenalty;
  if (Object.values(profile.weights).some((value) => !Number.isFinite(value) || value < 0)
    || Math.abs(componentWeight - 1) > 1e-12
    || Object.values(profile.modelScoreWeights).some((value) => !Number.isFinite(value) || value < 0)
    || Math.abs(scoreWeight - 1) > 1e-12
    || !Number.isFinite(profile.returnScale) || profile.returnScale <= 0
    || !Number.isFinite(profile.uncertaintyScale) || profile.uncertaintyScale <= 0
    || !Number.isFinite(profile.entryScoreThreshold)
    || !Number.isFinite(profile.degradedEntryScoreThreshold)
    || profile.degradedEntryScoreThreshold < profile.entryScoreThreshold
    || !Number.isFinite(profile.holdScoreThreshold)
    || !Number.isFinite(profile.minimumScoreMargin) || profile.minimumScoreMargin < 0
    || !Number.isFinite(profile.modelDirectionMargin) || profile.modelDirectionMargin < 0
    || !Number.isFinite(profile.neutralRustExposureScale)
    || profile.neutralRustExposureScale < 0 || profile.neutralRustExposureScale > 1
    || !Number.isSafeInteger(profile.minimumRiskForNeutralRust)
    || profile.minimumRiskForNeutralRust < 0 || profile.minimumRiskForNeutralRust > 100
    || !Number.isSafeInteger(profile.cooldownMs) || profile.cooldownMs < 0
    || !Number.isSafeInteger(profile.quoteMaximumAgeMs) || profile.quoteMaximumAgeMs < 0) {
    throw new Error("Pair ensemble policy profile values are invalid.");
  }
  return profile;
}

function quoteSpread(
  input: PairEnsembleInput,
  direction: "bull" | "bear",
): number {
  const observed = input.market.quotes[direction]?.spreadBps;
  return Math.max(input.costs.spreadBpsRoundTrip, observed ?? 0);
}

function roundTripRate(
  input: PairEnsembleInput,
  direction: "bull" | "bear",
): number {
  const switching = input.currentDirection !== "cash" && input.currentDirection !== direction;
  return (
    input.costs.commissionBpsPerSide * 2
    + input.costs.taxBpsOnExit
    + input.costs.slippageBpsPerSide * 2
    + quoteSpread(input, direction)
    + (switching ? input.costs.switchCostBps : 0)
  ) / 10_000;
}

function emptyModelScore(status: NormalizedPairModelOutput["status"]): PairModelDirectionScore {
  return {
    status,
    bull: 0,
    bear: 0,
    bullNetExpectedReturn: 0,
    bearNetExpectedReturn: 0,
    bullProbability: 0,
    bearProbability: 0,
    leveragedUncertainty: 0,
    preferredDirection: "cash",
  };
}

function scoreModel(
  model: NormalizedPairModelOutput,
  pair: PairCatalogEntry,
  input: PairEnsembleInput,
  profile: PairEnsemblePolicyProfile,
): PairModelDirectionScore {
  if (model.status === "unavailable"
    || model.medianReturn === undefined
    || model.upProbability === undefined
    || model.downProbability === undefined
    || model.uncertaintyWidth === undefined) {
    return emptyModelScore(model.status);
  }
  const bullMultiplier = pair.bull.leverageMultiplier;
  const bearMultiplier = pair.bear.leverageMultiplier;
  const bullNetExpectedReturn = model.medianReturn * bullMultiplier
    - roundTripRate(input, "bull");
  const bearNetExpectedReturn = model.medianReturn * bearMultiplier
    - roundTripRate(input, "bear");
  const leveragedUncertainty = Math.max(
    model.uncertaintyWidth * Math.max(Math.abs(bullMultiplier), Math.abs(bearMultiplier)),
    (model.expectedVolatility ?? 0)
      * Math.max(Math.abs(bullMultiplier), Math.abs(bearMultiplier)),
  );
  const uncertaintyPenalty = clamp(
    leveragedUncertainty / profile.uncertaintyScale,
    0,
    1,
  );
  const directional = (
    netExpectedReturn: number,
    probability: number,
  ) => (
    profile.modelScoreWeights.netExpectedReturn
      * clamp(netExpectedReturn / profile.returnScale)
    + profile.modelScoreWeights.directionProbability
      * clamp(probability * 2 - 1)
    - profile.modelScoreWeights.uncertaintyPenalty * uncertaintyPenalty
  );
  const bull = rounded(directional(bullNetExpectedReturn, model.upProbability));
  const bear = rounded(directional(bearNetExpectedReturn, model.downProbability));
  const preferredDirection: PairDirection = bullNetExpectedReturn > 0
    && bull - bear >= profile.modelDirectionMargin
    ? "bull"
    : bearNetExpectedReturn > 0 && bear - bull >= profile.modelDirectionMargin
      ? "bear"
      : "cash";
  return {
    status: model.status,
    bull,
    bear,
    bullNetExpectedReturn: rounded(bullNetExpectedReturn),
    bearNetExpectedReturn: rounded(bearNetExpectedReturn),
    bullProbability: model.upProbability,
    bearProbability: model.downProbability,
    leveragedUncertainty: rounded(leveragedUncertainty),
    preferredDirection,
  };
}

function scoreRust(
  rust: PairRustTechnicalInput,
  currentDirection: PairDirection,
): PairRustDirectionScore {
  let bull = 0;
  let bear = 0;
  if (rust.status === "entry_candidate") bull += 0.65;
  else if (rust.status === "exit_candidate") bear += 0.65;
  else if (rust.status === "hold" && currentDirection === "bull") bull += 0.35;
  else if (rust.status === "hold" && currentDirection === "bear") bear += 0.35;
  if (rust.technicalSignal === 1) bull += 0.2;
  else if (rust.technicalSignal === -1) bear += 0.2;
  if (rust.multiTimeframeAgreement === "aligned_bullish") bull += 0.25;
  else if (rust.multiTimeframeAgreement === "aligned_bearish") bear += 0.25;
  if (rust.chartPatternBias === "bullish") bull += 0.1;
  else if (rust.chartPatternBias === "bearish") bear += 0.1;
  const qualityScale = rust.dataQuality === "good" ? 1
    : rust.dataQuality === "partial" ? 0.6 : 0;
  const confidenceScale = rust.confidence === undefined
    ? 1
    : clamp(rust.confidence, 0, 1);
  bull = rounded(clamp(bull * qualityScale * confidenceScale, 0, 1));
  bear = rounded(clamp(bear * qualityScale * confidenceScale, 0, 1));
  return {
    bull,
    bear,
    preferredDirection: bull - bear >= 0.1
      ? "bull"
      : bear - bull >= 0.1 ? "bear" : "cash",
  };
}

function latestEligibleAt(input: PairEnsembleInput, quote?: PairExecutionQuote): string {
  const candidates = [
    input.models.chronos2.generatedAt,
    input.models.kronos.generatedAt,
    input.rust.observedAt,
    input.rust.earliestEligibleAt,
    quote?.observedAt,
    input.decisionAt,
  ].flatMap((value) => finiteTimestamp(value) ?? []);
  return candidates.sort((left, right) => Date.parse(right) - Date.parse(left))[0]
    ?? new Date(Date.parse(input.decisionAt)).toISOString();
}

function cashDecision(
  input: PairEnsembleInput,
  profile: PairEnsemblePolicyProfile,
  scores: PairEnsembleDecision["componentScores"],
  finalScores: PairEnsembleDecision["finalScores"],
  costs: PairEnsembleDecision["costs"],
  reasons: readonly string[],
  degraded: boolean,
  origin?: string,
): PairEnsembleDecision {
  return {
    policyVersion: PAIR_ENSEMBLE_POLICY_VERSION,
    profileId: profile.profileId,
    pairId: input.pair.pairId,
    signalSymbol: input.pair.signalSymbol,
    ...(origin ? { origin } : {}),
    decisionAt: new Date(Date.parse(input.decisionAt)).toISOString(),
    eligibleAfter: latestEligibleAt(input),
    currentDirection: input.currentDirection,
    direction: "cash",
    executionSymbol: null,
    leverageMultiplier: 0,
    decisionKind: input.currentDirection === "cash" ? "cash" : "exit",
    degraded,
    exposureScale: 0,
    reasonCodes: unique(reasons),
    weights: { ...profile.weights },
    componentScores: scores,
    finalScores,
    scoreMargin: rounded(Math.abs(finalScores.bull - finalScores.bear)),
    costs,
  };
}

export function evaluatePairEnsemble(input: PairEnsembleInput): PairEnsembleDecision {
  const pair = validatePairCatalogEntry(input.pair);
  const profile = validatePairEnsemblePolicyProfile(
    input.profile ?? DEFAULT_PAIR_ENSEMBLE_POLICY_PROFILE,
  );
  const decisionAt = finiteTimestamp(input.decisionAt);
  if (!decisionAt
    || !Number.isSafeInteger(input.riskTolerance)
    || input.riskTolerance < 0 || input.riskTolerance > 100) {
    throw new Error("Pair ensemble decision timestamp or risk tolerance is invalid.");
  }
  for (const [name, value] of Object.entries(input.costs)) {
    validateNonnegativeBps(value, name);
  }
  if (input.models.signalSymbol !== pair.signalSymbol) {
    throw new Error("Normalized model signal symbol does not match the pair catalog.");
  }
  const chronos2 = scoreModel(input.models.chronos2, pair, input, profile);
  const kronos = scoreModel(input.models.kronos, pair, input, profile);
  const rust = scoreRust(input.rust, input.currentDirection);
  const componentScores = { chronos2, kronos, rust };
  const finalScores = {
    bull: rounded(
      chronos2.bull * profile.weights.chronos2
      + kronos.bull * profile.weights.kronos
      + rust.bull * profile.weights.rust
    ),
    bear: rounded(
      chronos2.bear * profile.weights.chronos2
      + kronos.bear * profile.weights.kronos
      + rust.bear * profile.weights.rust
    ),
    cash: rounded(Math.max(0, 1 - Math.max(
      chronos2.bull,
      chronos2.bear,
      kronos.bull,
      kronos.bear,
      rust.bull,
      rust.bear,
    ))),
  };
  const costs = {
    bullRoundTripRate: rounded(roundTripRate(input, "bull")),
    bearRoundTripRate: rounded(roundTripRate(input, "bear")),
    switchCostApplied: input.currentDirection !== "cash",
  };
  const reasons: string[] = [];
  const modelOutputs = [input.models.chronos2, input.models.kronos];
  const usableModels = modelOutputs.filter((model) => model.status !== "unavailable");
  const degraded = usableModels.length < 2
    || usableModels.some((model) => model.status === "degraded");
  const degradedOrigin = usableModels.length === 1
    && profile.allowDegradedMode
    && input.models.expectedOrigin
    && usableModels[0]?.inputEndAt
    && Date.parse(usableModels[0].inputEndAt) === Date.parse(input.models.expectedOrigin)
    ? finiteTimestamp(input.models.expectedOrigin)
    : undefined;
  const origin = input.models.alignmentStatus === "aligned"
    ? input.models.alignedOrigin
    : degradedOrigin;

  if (!origin) {
    reasons.push("model_origin_not_aligned");
  }
  const rustOrigin = finiteTimestamp(input.rust.signalOriginAt);
  if (!rustOrigin || !origin || Date.parse(rustOrigin) !== Date.parse(origin)) {
    reasons.push("rust_origin_not_aligned");
  }
  if (input.rust.dataQuality === "stale" || input.rust.dataQuality === "unavailable") {
    reasons.push("rust_data_unavailable_or_stale");
  }
  if (input.market.dataQuality === "stale" || input.market.dataQuality === "unavailable") {
    reasons.push("execution_data_unavailable_or_stale");
  }
  for (const direction of ["bull", "bear"] as const) {
    const quote = input.market.quotes[direction];
    const observedAt = finiteTimestamp(quote?.observedAt);
    if (!quote || quote.status !== "available" || !observedAt) {
      reasons.push("execution_quote_unavailable");
      continue;
    }
    const quoteAge = Date.parse(decisionAt) - Date.parse(observedAt);
    if (quoteAge < 0 || quoteAge > profile.quoteMaximumAgeMs) {
      reasons.push("execution_quote_stale");
    }
    if (quote.spreadBps === undefined
      || !Number.isFinite(quote.spreadBps)
      || quote.spreadBps < 0
      || quote.spreadBps > pair.maxSpreadBps) {
      reasons.push("execution_spread_invalid_or_wide");
    }
  }
  if (!pair.allowedSessions.includes(input.market.session as PairSession)) {
    reasons.push("session_not_allowed");
  }
  if (!usableModels.length) reasons.push("all_models_unavailable");
  if (usableModels.length < 2 && !profile.allowDegradedMode) {
    reasons.push("degraded_mode_disabled");
  }
  if (profile.requireCalibration && usableModels.some((model) => (
    model.calibration.status !== "good"
  ))) {
    reasons.push("calibration_required");
  }
  if (modelOutputs.some((model) => model.calibration.status === "poor")) {
    reasons.push("calibration_poor");
  }
  if (input.currentDirection !== "cash" && input.rust.status === "exit_candidate") {
    reasons.push("rust_exit_candidate");
  }
  const currentNetReturns = input.currentDirection === "bull"
    ? [chronos2.bullNetExpectedReturn, kronos.bullNetExpectedReturn]
    : input.currentDirection === "bear"
      ? [chronos2.bearNetExpectedReturn, kronos.bearNetExpectedReturn]
      : [];
  if (currentNetReturns.length === 2 && currentNetReturns.every((value) => value <= 0)) {
    reasons.push("held_direction_net_expected_return_nonpositive");
  }
  if (reasons.length) {
    return cashDecision(input, profile, componentScores, finalScores, costs, reasons, degraded, origin);
  }

  const modelDirections = usableModels.map((model) => (
    model.component === "chronos2" ? chronos2.preferredDirection : kronos.preferredDirection
  ));
  const nonCashModelDirections = modelDirections.filter(
    (direction): direction is "bull" | "bear" => direction !== "cash",
  );
  if (nonCashModelDirections.length !== modelDirections.length) {
    return cashDecision(
      input,
      profile,
      componentScores,
      finalScores,
      costs,
      ["model_direction_not_actionable"],
      degraded,
      origin,
    );
  }
  if (new Set(nonCashModelDirections).size !== 1) {
    return cashDecision(
      input,
      profile,
      componentScores,
      finalScores,
      costs,
      ["ai_model_direction_conflict"],
      degraded,
      origin,
    );
  }
  const candidate = nonCashModelDirections[0]!;
  if (degraded && rust.preferredDirection !== candidate) {
    return cashDecision(
      input,
      profile,
      componentScores,
      finalScores,
      costs,
      ["degraded_requires_rust_direction_agreement"],
      degraded,
      origin,
    );
  }
  if (rust.preferredDirection !== "cash" && rust.preferredDirection !== candidate) {
    return cashDecision(
      input,
      profile,
      componentScores,
      finalScores,
      costs,
      ["rust_direction_conflict"],
      degraded,
      origin,
    );
  }
  const quote = input.market.quotes[candidate];
  const quoteObservedAt = finiteTimestamp(quote?.observedAt);
  if (!quote || quote.status !== "available" || !quoteObservedAt) {
    return cashDecision(
      input,
      profile,
      componentScores,
      finalScores,
      costs,
      ["execution_quote_unavailable"],
      degraded,
      origin,
    );
  }
  const quoteAge = Date.parse(decisionAt) - Date.parse(quoteObservedAt);
  if (quoteAge < 0 || quoteAge > profile.quoteMaximumAgeMs) {
    return cashDecision(
      input,
      profile,
      componentScores,
      finalScores,
      costs,
      ["execution_quote_stale"],
      degraded,
      origin,
    );
  }
  if (quote.spreadBps === undefined
    || !Number.isFinite(quote.spreadBps)
    || quote.spreadBps < 0
    || quote.spreadBps > pair.maxSpreadBps) {
    return cashDecision(
      input,
      profile,
      componentScores,
      finalScores,
      costs,
      ["execution_spread_invalid_or_wide"],
      degraded,
      origin,
    );
  }
  const candidateScore = finalScores[candidate];
  const opposingScore = finalScores[candidate === "bull" ? "bear" : "bull"];
  const scoreMargin = candidateScore - opposingScore;
  const cooldownUntil = finiteTimestamp(input.cooldownUntil);
  if (cooldownUntil && input.currentDirection !== candidate
    && Date.parse(decisionAt) < Date.parse(cooldownUntil)) {
    return cashDecision(
      input,
      profile,
      componentScores,
      finalScores,
      costs,
      ["cooldown_active"],
      degraded,
      origin,
    );
  }
  const threshold = input.currentDirection === candidate
    ? profile.holdScoreThreshold
    : degraded ? profile.degradedEntryScoreThreshold : profile.entryScoreThreshold;
  const riskAdjustment = input.currentDirection === candidate
    ? 0
    : (100 - input.riskTolerance) / 1_000;
  if (candidateScore < threshold + riskAdjustment) {
    return cashDecision(
      input,
      profile,
      componentScores,
      finalScores,
      costs,
      ["ensemble_score_below_threshold"],
      degraded,
      origin,
    );
  }
  if (scoreMargin < profile.minimumScoreMargin) {
    return cashDecision(
      input,
      profile,
      componentScores,
      finalScores,
      costs,
      ["minimum_score_margin_not_met"],
      degraded,
      origin,
    );
  }
  const rustNeutral = rust.preferredDirection === "cash";
  if (rustNeutral && input.riskTolerance < profile.minimumRiskForNeutralRust) {
    return cashDecision(
      input,
      profile,
      componentScores,
      finalScores,
      costs,
      ["neutral_rust_requires_higher_risk_tolerance"],
      degraded,
      origin,
    );
  }
  const mapping = mapPairDirection(pair, candidate);
  const exposureScale = rounded(
    (0.25 + input.riskTolerance / 100 * 0.75)
    * (rustNeutral ? profile.neutralRustExposureScale : 1)
    * (degraded ? 0.5 : 1),
  );
  const decisionKind: PairEnsembleDecision["decisionKind"] = input.currentDirection === candidate
    ? "hold"
    : input.currentDirection === "cash" ? "enter" : "switch";
  return {
    policyVersion: PAIR_ENSEMBLE_POLICY_VERSION,
    profileId: profile.profileId,
    pairId: pair.pairId,
    signalSymbol: pair.signalSymbol,
    origin,
    decisionAt,
    eligibleAfter: latestEligibleAt(input, quote),
    currentDirection: input.currentDirection,
    direction: candidate,
    executionSymbol: mapping.executionSymbol,
    leverageMultiplier: mapping.leverageMultiplier,
    decisionKind,
    degraded,
    exposureScale,
    reasonCodes: unique([
      "ai_models_direction_agree",
      rustNeutral ? "rust_neutral_reduced_exposure" : "rust_direction_supports_ai",
      degraded ? "degraded_threshold_applied_without_weight_redistribution" : "full_ensemble_available",
      "cost_and_uncertainty_adjusted_score_passed",
    ]),
    weights: { ...profile.weights },
    componentScores,
    finalScores,
    scoreMargin: rounded(scoreMargin),
    costs,
  };
}
