import type {
  SimulationCase,
  SimulationModelPlanEntry,
} from "./contracts.js";
import type {
  EvidenceCostBreakdown,
  ModelEvidence,
} from "./model-evidence.js";
import type {
  HighVolatilityUnifiedPolicyContext,
  VetoProbabilityCalibration,
} from "./high-volatility-stack-policy.js";
import type { RustMarketEvidenceV2 } from "./technical-indicator-evidence.js";

export const UNIFIED_STRATEGY_POLICY_VERSION = "simulation-strategy-policy/v2" as const;
export const MODEL_ROUTER_POLICY_VERSION = "model-role-router/v1" as const;
export const VETO_POLICY_VERSION = "strong-veto/v2" as const;
export const DYNAMIC_HORIZON_POLICY_VERSION = "dynamic-horizon/v2" as const;
export const POSITION_SIZING_POLICY_VERSION = "bounded-position-sizing/v1" as const;
export const CIRCUIT_BREAKER_POLICY_VERSION = "simulation-circuit-breaker/v1" as const;

export type UnifiedDirection = "long" | "short" | "bull" | "bear" | "cash";
type RawDirection = "long" | "short";

export type CircuitBreakerObservations = {
  dailyLossRate: number;
  consecutiveLosses: number;
  referenceSpreadBps?: number;
  referenceDepth?: number;
  realizedVolatilityBaseline?: number;
  priceGapRate?: number;
  missingData?: boolean;
};

export type UnifiedPolicyState = {
  currentDirection: UnifiedDirection;
  positionOpenedAt?: string;
  lastExitAt?: string;
  lastDirection?: UnifiedDirection;
  lastHorizonMinutes?: number;
  lastHorizonScore?: number;
  tradeTimestamps: string[];
  dailyTurnoverRate: number;
};

export type PositionSizingInputs = {
  equity: number;
  volatilityTargetRate: number;
  lossBudgetRate: number;
  bookParticipationRate: number;
  symbolExposureCapRate: number;
  grossExposureCapRate: number;
  marginUsageCapRate: number;
  maximumLeverage: number;
};

export type UnifiedPolicyInput = {
  simulationCase: SimulationCase;
  symbol: string;
  originAt: string;
  modelPlan: readonly SimulationModelPlanEntry[];
  modelEvidence: readonly ModelEvidence[];
  rustEvidence?: RustMarketEvidenceV2;
  costs: EvidenceCostBreakdown;
  state: UnifiedPolicyState;
  sizing: PositionSizingInputs;
  circuit: CircuitBreakerObservations;
  highVolatility?: HighVolatilityUnifiedPolicyContext;
};

export type VetoResult = {
  policyVersion: typeof VETO_POLICY_VERSION;
  evaluated: boolean;
  vetoed: boolean;
  modelLane: string | null;
  reasons: string[];
  rawOppositeProbability?: number;
  calibratedOppositeProbability?: number | null;
  probabilityThreshold?: number;
  probabilityCalibration?: VetoProbabilityCalibration;
};

export type PositionSizingResult = {
  policyVersion: typeof POSITION_SIZING_POLICY_VERSION;
  requestedNotional: number;
  selectedNotional: number;
  selectedRate: number;
  limitingFactor: string;
  limits: {
    volatilityTarget: number;
    tailLossBudget: number;
    orderbookParticipation: number;
    symbolExposureCap: number;
    grossExposureCap: number;
    marginUsageCap: number;
  };
};

export type CircuitBreakerState = {
  policyVersion: typeof CIRCUIT_BREAKER_POLICY_VERSION;
  active: boolean;
  triggers: string[];
  releaseConditions: string[];
};

export type UnifiedPolicyDecision = {
  policyVersion: typeof UNIFIED_STRATEGY_POLICY_VERSION;
  routerVersion: typeof MODEL_ROUTER_POLICY_VERSION;
  originAt: string;
  symbol: string;
  simulationCase: SimulationCase;
  direction: UnifiedDirection;
  executionAction: "enter" | "hold" | "exit" | "reverse" | "none";
  selectedHorizonMinutes: number | null;
  primaryEvidence: ModelEvidence | null;
  vetoEvidence: ModelEvidence | null;
  shadowEvidence: ModelEvidence[];
  expectedGrossReturn: number | null;
  expectedNetReturn: number | null;
  pNetLong: number | null;
  pNetShort: number | null;
  horizonScore: number | null;
  rustRegime: string | null;
  passedIndicatorGates: string[];
  blockedIndicatorGates: string[];
  veto: VetoResult;
  circuitBreaker: CircuitBreakerState;
  positionSizing: PositionSizingResult;
  costBreakdown: EvidenceCostBreakdown & {
    totalLongBps: number;
    totalShortBps: number;
  };
  noTrade: boolean;
  reasons: string[];
  warnings: string[];
  highVolatilityPolicy: {
    policyVersion: HighVolatilityUnifiedPolicyContext["policyVersion"];
    volatilityRegime: HighVolatilityUnifiedPolicyContext["volatilityRegime"];
    rustQualityScore: number;
  } | null;
};

type Candidate = {
  direction: RawDirection;
  evidence: ModelEvidence;
  pNet: number;
  grossEdge: number;
  netEdge: number;
  score: number;
};

type HorizonPolicy = {
  entryProbability: number;
  strongConfidence: number;
  maximumIntervalWidth: number;
  maximumTailLoss: number;
};

function finiteTimestamp(value: string, name: string): number {
  const result = Date.parse(value);
  if (!Number.isFinite(result)) throw new Error(`${name} must be an ISO timestamp.`);
  return result;
}

function policyFor(
  simulationCase: SimulationCase,
  symbol: string,
  horizonMinutes: number,
): HorizonPolicy {
  const normalized = symbol.toUpperCase();
  if (normalized === "BTCUSDT") {
    return {
      entryProbability: horizonMinutes === 15 ? 0.64 : 0.6,
      strongConfidence: 0.67,
      maximumIntervalWidth: horizonMinutes === 60 ? 0.07 : 0.045,
      maximumTailLoss: horizonMinutes === 60 ? 0.04 : 0.025,
    };
  }
  if (normalized === "ETHUSDT") {
    return {
      entryProbability: horizonMinutes === 5 ? 0.82 : horizonMinutes === 60 ? 0.66 : 0.61,
      strongConfidence: 0.68,
      maximumIntervalWidth: horizonMinutes === 60 ? 0.09 : 0.06,
      maximumTailLoss: horizonMinutes === 60 ? 0.05 : 0.032,
    };
  }
  if (simulationCase === "high_vol_crypto") {
    return {
      entryProbability: horizonMinutes === 60 ? 0.74 : 0.65,
      strongConfidence: horizonMinutes === 60 ? 0.74 : 0.71,
      maximumIntervalWidth: horizonMinutes === 60 ? 0.1 : 0.09,
      maximumTailLoss: horizonMinutes === 60 ? 0.06 : 0.05,
    };
  }
  return {
    entryProbability: horizonMinutes === 60 ? 0.64 : 0.6,
    strongConfidence: 0.66,
    maximumIntervalWidth: horizonMinutes === 60 ? 0.055 : 0.035,
    maximumTailLoss: horizonMinutes === 60 ? 0.035 : 0.022,
  };
}

function plansForSymbol(
  plans: readonly SimulationModelPlanEntry[],
  symbol: string,
): SimulationModelPlanEntry[] {
  const normalized = symbol.toUpperCase();
  return plans.filter((plan) => plan.symbol === "*" || plan.symbol.toUpperCase() === normalized);
}

function evidenceForPlan(
  allEvidence: readonly ModelEvidence[],
  plan: SimulationModelPlanEntry,
  symbol: string,
): ModelEvidence[] {
  const normalized = symbol.toUpperCase();
  return allEvidence.filter((evidence) => (
    evidence.symbol.toUpperCase() === normalized
    && evidence.modelLane === plan.modelLane
    && evidence.role === plan.role
  ));
}

function isEntryHorizonAllowed(
  simulationCase: SimulationCase,
  symbol: string,
  evidence: ModelEvidence,
): boolean {
  if (evidence.horizonMinutes !== 5) return true;
  if (symbol.toUpperCase() === "ETHUSDT") {
    return Math.max(evidence.pNetLong, evidence.pNetShort) >= 0.82
      && Math.abs(evidence.expectedNetReturn) >= 0.003;
  }
  // Five-minute evidence remains available to exit/reversal risk management,
  // but is not an entry candidate for BTC, high-volatility, or ETF strategies.
  return false;
}

function candidateForEvidence(
  simulationCase: SimulationCase,
  symbol: string,
  evidence: ModelEvidence,
  rustEvidence: RustMarketEvidenceV2,
  highVolatility: HighVolatilityUnifiedPolicyContext | undefined,
): Candidate | undefined {
  if (!isEntryHorizonAllowed(simulationCase, symbol, evidence)) return undefined;
  const horizonAssessment = simulationCase === "high_vol_crypto"
    ? highVolatility?.horizonAssessments[evidence.horizonMinutes]
    : undefined;
  if (horizonAssessment && !horizonAssessment.entryAllowed) return undefined;
  const policy = policyFor(simulationCase, symbol, evidence.horizonMinutes);
  const direction: RawDirection = evidence.pNetLong >= evidence.pNetShort ? "long" : "short";
  const pNet = direction === "long" ? evidence.pNetLong : evidence.pNetShort;
  if (pNet < policy.entryProbability) return undefined;
  const grossEdge = direction === "long" ? evidence.expectedReturn : -evidence.expectedReturn;
  const netEdge = direction === "long"
    ? evidence.expectedNetReturn
    : -evidence.expectedNetReturn;
  if (netEdge <= 0) return undefined;
  const tailLoss = direction === "long"
    ? Math.max(evidence.expectedShortfall, -evidence.q10Return, 0.0001)
    : Math.max(evidence.q90Return, 0.0001);
  const calibrationQuality = evidence.calibrationStatus === "ready" ? 1 : 0;
  const liquidityScale = rustEvidence.liquidityQuality ?? 0;
  const highVolatilityScale = simulationCase === "high_vol_crypto"
    ? (highVolatility?.rustQuality.score ?? liquidityScale)
      * (horizonAssessment?.preferenceScale ?? 1)
    : 1;
  return {
    direction,
    evidence,
    pNet,
    grossEdge,
    netEdge,
    score: (netEdge / tailLoss)
      * calibrationQuality
      * liquidityScale
      * highVolatilityScale,
  };
}

function selectDynamicHorizon(
  candidates: readonly Candidate[],
  state: UnifiedPolicyState,
): Candidate | undefined {
  const sorted = [...candidates].sort((left, right) => (
    right.score - left.score
    || right.evidence.horizonMinutes - left.evidence.horizonMinutes
  ));
  const best = sorted[0];
  if (!best || state.lastHorizonMinutes === undefined || best.evidence.horizonMinutes === state.lastHorizonMinutes) {
    return best;
  }
  const previous = sorted.find(
    (candidate) => candidate.evidence.horizonMinutes === state.lastHorizonMinutes,
  );
  if (!previous) return best;
  const priorScore = state.lastHorizonScore ?? previous.score;
  return best.score >= priorScore * 1.15 ? best : previous;
}

function evaluateVeto(
  input: UnifiedPolicyInput,
  primary: Candidate,
  vetoPlan: SimulationModelPlanEntry | undefined,
): { result: VetoResult; evidence: ModelEvidence | null } {
  if (!vetoPlan) {
    return {
      result: {
        policyVersion: VETO_POLICY_VERSION,
        evaluated: false,
        vetoed: false,
        modelLane: null,
        reasons: [],
      },
      evidence: null,
    };
  }
  const matching = evidenceForPlan(input.modelEvidence, vetoPlan, input.symbol)
    .find((evidence) => evidence.horizonMinutes === primary.evidence.horizonMinutes);
  if (!matching) {
    return {
      result: {
        policyVersion: VETO_POLICY_VERSION,
        evaluated: false,
        vetoed: vetoPlan.required,
        modelLane: vetoPlan.modelLane,
        reasons: vetoPlan.required ? ["REQUIRED_VETO_MODEL_UNAVAILABLE"] : [],
      },
      evidence: null,
    };
  }
  const policy = policyFor(
    input.simulationCase,
    input.symbol,
    primary.evidence.horizonMinutes,
  );
  const reasons: string[] = [];
  const rawOppositeProbability = primary.direction === "long"
    ? matching.pNetShort
    : matching.pNetLong;
  const probabilityCalibration = input.simulationCase === "high_vol_crypto"
    ? input.highVolatility?.vetoCalibrationByHorizon?.[
        primary.evidence.horizonMinutes
      ]
    : undefined;
  if (
    probabilityCalibration
    && (
      probabilityCalibration.status !== "ready"
      || probabilityCalibration.calibratedProbability === null
    )
  ) {
    reasons.push("VETO_PROBABILITY_CALIBRATION_UNAVAILABLE");
  }
  const oppositeProbability = probabilityCalibration?.calibratedProbability
    ?? rawOppositeProbability;
  const probabilityThreshold = probabilityCalibration?.threshold
    ?? Math.max(0.68, policy.strongConfidence);
  if (oppositeProbability >= probabilityThreshold) {
    reasons.push("STRONG_OPPOSITE_NET_PROBABILITY");
  }
  if (
    primary.direction === "long"
      ? matching.q10Return <= -policy.maximumTailLoss
        || matching.expectedShortfall >= policy.maximumTailLoss
      : matching.q90Return >= policy.maximumTailLoss
  ) {
    reasons.push("TAIL_LOSS_LIMIT");
  }
  const q50Opposes = primary.direction === "long"
    ? matching.q50Return < 0
    : matching.q50Return > 0;
  if (
    q50Opposes
    && primary.pNet >= policy.strongConfidence
    && oppositeProbability >= policy.strongConfidence
  ) {
    reasons.push("CONFIDENT_DIRECTION_CONFLICT");
  }
  if (
    matching.intervalWidth > policy.maximumIntervalWidth
    || matching.calibrationStatus !== "ready"
    || matching.dataQuality.status !== "ok"
    || matching.dataQuality.stale
  ) {
    reasons.push("VETO_MODEL_RISK_QUALITY");
  }
  return {
    result: {
      policyVersion: VETO_POLICY_VERSION,
      evaluated: true,
      vetoed: reasons.length > 0,
      modelLane: matching.modelLane,
      reasons,
      rawOppositeProbability,
      calibratedOppositeProbability:
        probabilityCalibration?.calibratedProbability ?? null,
      probabilityThreshold,
      ...(probabilityCalibration ? { probabilityCalibration } : {}),
    },
    evidence: matching,
  };
}

function evaluateCircuitBreakers(
  input: UnifiedPolicyInput,
  primary: ModelEvidence | null,
): CircuitBreakerState {
  const triggers: string[] = [];
  const rust = input.rustEvidence;
  const originMs = finiteTimestamp(input.originAt, "originAt");
  if (input.circuit.dailyLossRate >= (input.simulationCase === "high_vol_crypto" ? 0.03 : 0.04)) {
    triggers.push("DAILY_LOSS_LIMIT");
  }
  if (input.circuit.consecutiveLosses >= 4) triggers.push("CONSECUTIVE_LOSSES");
  if (
    rust?.spreadBps !== null
    && rust?.spreadBps !== undefined
    && input.circuit.referenceSpreadBps !== undefined
    && rust.spreadBps >= Math.max(12, input.circuit.referenceSpreadBps * 2)
  ) triggers.push("SPREAD_SPIKE");
  if (
    rust?.orderbookDepth !== null
    && rust?.orderbookDepth !== undefined
    && input.circuit.referenceDepth !== undefined
    && rust.orderbookDepth <= input.circuit.referenceDepth * 0.35
  ) triggers.push("DEPTH_COLLAPSE");
  if (
    rust?.realizedVolatility !== null
    && rust?.realizedVolatility !== undefined
    && input.circuit.realizedVolatilityBaseline !== undefined
    && rust.realizedVolatility >= input.circuit.realizedVolatilityBaseline * 3
  ) triggers.push("REALIZED_VOLATILITY_SPIKE");
  if ((input.circuit.priceGapRate ?? 0) >= 0.04) triggers.push("PRICE_GAP");
  if (input.circuit.missingData) triggers.push("DATA_MISSING");
  if (!rust || rust.blockedGates.length > 0) triggers.push("RUST_GATE_BLOCKED");
  if (
    rust
    && (
      rust.quoteFreshnessMs === null
      || rust.quoteFreshnessMs > 120_000
      || finiteTimestamp(rust.observedAt, "rust.observedAt") > originMs
    )
  ) triggers.push("DATA_STALE");
  if (
    primary
    && (
      primary.calibrationStatus !== "ready"
      || primary.dataQuality.stale
      || primary.dataQuality.status !== "ok"
    )
  ) triggers.push("CALIBRATION_OR_MODEL_DATA_QUALITY");
  if (primary && primary.originAt !== input.originAt) triggers.push("MODEL_ORIGIN_MISMATCH");
  const maximumWidth = primary
    ? policyFor(input.simulationCase, input.symbol, primary.horizonMinutes).maximumIntervalWidth
    : Number.POSITIVE_INFINITY;
  if (primary && primary.intervalWidth > maximumWidth) {
    triggers.push("PREDICTION_INTERVAL_EXPLOSION");
  }
  return {
    policyVersion: CIRCUIT_BREAKER_POLICY_VERSION,
    active: triggers.length > 0,
    triggers: [...new Set(triggers)],
    releaseConditions: triggers.map((trigger) => `CLEAR_${trigger}`),
  };
}

function emptyPositionSizing(): PositionSizingResult {
  return {
    policyVersion: POSITION_SIZING_POLICY_VERSION,
    requestedNotional: 0,
    selectedNotional: 0,
    selectedRate: 0,
    limitingFactor: "NO_TRADE",
    limits: {
      volatilityTarget: 0,
      tailLossBudget: 0,
      orderbookParticipation: 0,
      symbolExposureCap: 0,
      grossExposureCap: 0,
      marginUsageCap: 0,
    },
  };
}

function sizePosition(
  input: UnifiedPolicyInput,
  candidate: Candidate,
): PositionSizingResult {
  const { sizing } = input;
  if (!Number.isFinite(sizing.equity) || sizing.equity <= 0) return emptyPositionSizing();
  const volatility = Math.max(
    input.rustEvidence?.realizedVolatility ?? candidate.evidence.intervalWidth,
    0.0001,
  );
  const tailLoss = candidate.direction === "long"
    ? Math.max(candidate.evidence.expectedShortfall, -candidate.evidence.q10Return, 0.0001)
    : Math.max(candidate.evidence.q90Return, 0.0001);
  const requestedNotional = sizing.equity * Math.min(
    sizing.maximumLeverage,
    sizing.volatilityTargetRate / volatility,
  );
  const limits = {
    volatilityTarget: requestedNotional,
    tailLossBudget: sizing.equity * sizing.lossBudgetRate / tailLoss,
    orderbookParticipation: Math.max(
      0,
      (input.rustEvidence?.orderbookDepth ?? 0) * sizing.bookParticipationRate,
    ),
    symbolExposureCap: sizing.equity * sizing.symbolExposureCapRate,
    grossExposureCap: sizing.equity * sizing.grossExposureCapRate,
    marginUsageCap: sizing.equity * sizing.marginUsageCapRate * sizing.maximumLeverage,
  };
  const [limitingFactor, selectedNotional] = Object.entries(limits)
    .sort((left, right) => left[1] - right[1])[0]!;
  return {
    policyVersion: POSITION_SIZING_POLICY_VERSION,
    requestedNotional,
    selectedNotional,
    selectedRate: selectedNotional / sizing.equity,
    limitingFactor,
    limits,
  };
}

function outputDirection(simulationCase: SimulationCase, direction: RawDirection): UnifiedDirection {
  return simulationCase === "us_etf_pair"
    ? direction === "long" ? "bull" : "bear"
    : direction;
}

function executionAction(
  previous: UnifiedDirection,
  next: UnifiedDirection,
): UnifiedPolicyDecision["executionAction"] {
  if (previous === next) return next === "cash" ? "none" : "hold";
  if (previous === "cash") return next === "cash" ? "none" : "enter";
  if (next === "cash") return "exit";
  return "reverse";
}

function stabilizeDirection(
  candidateDirection: UnifiedDirection,
  state: UnifiedPolicyState,
  originAt: string,
): { direction: UnifiedDirection; reasons: string[] } {
  const now = finiteTimestamp(originAt, "originAt");
  const reasons: string[] = [];
  const isReversal = state.currentDirection !== "cash"
    && candidateDirection !== "cash"
    && state.currentDirection !== candidateDirection;
  if (
    isReversal
    && state.positionOpenedAt
    && now - finiteTimestamp(state.positionOpenedAt, "positionOpenedAt") < 10 * 60_000
  ) {
    reasons.push("MINIMUM_HOLD_TIME");
    return { direction: state.currentDirection, reasons };
  }
  if (
    state.currentDirection === "cash"
    && candidateDirection !== "cash"
    && state.lastExitAt
    && state.lastDirection === candidateDirection
    && now - finiteTimestamp(state.lastExitAt, "lastExitAt") < 15 * 60_000
  ) {
    reasons.push("REENTRY_COOLDOWN");
    return { direction: "cash", reasons };
  }
  const recentTrades = state.tradeTimestamps.filter(
    (timestampValue) => now - finiteTimestamp(timestampValue, "tradeTimestamp") < 60 * 60_000,
  );
  if (recentTrades.length >= 4 && candidateDirection !== state.currentDirection) {
    reasons.push("MAXIMUM_TRADES_PER_HOUR");
    return { direction: state.currentDirection, reasons };
  }
  if (state.dailyTurnoverRate >= 4 && candidateDirection !== state.currentDirection) {
    reasons.push("DAILY_TURNOVER_BUDGET");
    return { direction: state.currentDirection, reasons };
  }
  return { direction: candidateDirection, reasons };
}

function costBreakdown(costs: EvidenceCostBreakdown): UnifiedPolicyDecision["costBreakdown"] {
  const base = costs.commissionBps + costs.spreadBps + costs.slippageBps
    + costs.safetyMarginBps;
  return {
    ...costs,
    totalLongBps: Math.max(0, base + costs.fundingBps),
    totalShortBps: Math.max(0, base - costs.fundingBps),
  };
}

export function decideUnifiedSimulationPolicy(
  input: UnifiedPolicyInput,
): UnifiedPolicyDecision {
  finiteTimestamp(input.originAt, "originAt");
  const symbol = input.symbol.toUpperCase();
  const plans = plansForSymbol(input.modelPlan, symbol);
  const primaryPlan = plans.find((plan) => plan.role === "primary");
  const vetoPlan = plans.find((plan) => plan.role === "veto");
  const shadowPlans = plans.filter((plan) => plan.role === "shadow");
  const shadowEvidence = shadowPlans.flatMap(
    (plan) => evidenceForPlan(input.modelEvidence, plan, symbol),
  );
  const reasons: string[] = [];
  const warnings = shadowPlans.flatMap((plan) => (
    evidenceForPlan(input.modelEvidence, plan, symbol).length === 0
      ? [`SHADOW_MODEL_UNAVAILABLE:${plan.modelLane}`]
      : []
  ));
  if (!primaryPlan) reasons.push("PRIMARY_MODEL_PLAN_UNAVAILABLE");
  const primaryEvidence = primaryPlan
    ? evidenceForPlan(input.modelEvidence, primaryPlan, symbol)
    : [];
  if (primaryEvidence.length === 0) reasons.push("PRIMARY_MODEL_UNAVAILABLE");
  if (!input.rustEvidence) reasons.push("RUST_EVIDENCE_UNAVAILABLE");

  const candidates = input.rustEvidence
    ? primaryEvidence.flatMap((evidence) => {
      if (
        evidence.originAt !== input.originAt
        || evidence.calibrationStatus !== "ready"
        || evidence.dataQuality.status !== "ok"
        || evidence.dataQuality.stale
      ) return [];
      const candidate = candidateForEvidence(
        input.simulationCase,
        symbol,
        evidence,
        input.rustEvidence!,
        input.highVolatility,
      );
      return candidate ? [candidate] : [];
    })
    : [];
  let selected = selectDynamicHorizon(candidates, input.state);
  if (!selected && primaryEvidence.length > 0) reasons.push("NO_COST_ADJUSTED_EDGE");

  const vetoEvaluation = selected
    ? evaluateVeto(input, selected, vetoPlan)
    : {
      result: {
        policyVersion: VETO_POLICY_VERSION,
        evaluated: false,
        vetoed: false,
        modelLane: vetoPlan?.modelLane ?? null,
        reasons: [],
      } satisfies VetoResult,
      evidence: null,
    };
  if (selected && vetoPlan?.required && !vetoEvaluation.result.evaluated) {
    vetoEvaluation.result.vetoed = true;
    if (!vetoEvaluation.result.reasons.includes("REQUIRED_VETO_MODEL_UNAVAILABLE")) {
      vetoEvaluation.result.reasons.push("REQUIRED_VETO_MODEL_UNAVAILABLE");
    }
  }
  if (vetoEvaluation.result.vetoed) reasons.push(...vetoEvaluation.result.reasons);

  const circuitBreaker = evaluateCircuitBreakers(
    input,
    selected?.evidence ?? primaryEvidence[0] ?? null,
  );
  if (circuitBreaker.active) reasons.push(...circuitBreaker.triggers);

  if (vetoEvaluation.result.vetoed || circuitBreaker.active || reasons.some(
    (reason) => reason.startsWith("PRIMARY_") || reason === "RUST_EVIDENCE_UNAVAILABLE",
  )) {
    selected = undefined;
  }
  const proposed = selected
    ? outputDirection(input.simulationCase, selected.direction)
    : "cash";
  const stabilized = circuitBreaker.active
    ? { direction: "cash" as const, reasons: [] }
    : stabilizeDirection(proposed, input.state, input.originAt);
  reasons.push(...stabilized.reasons);
  const positionSizing = selected && stabilized.direction !== "cash"
    ? sizePosition(input, selected)
    : emptyPositionSizing();
  if (positionSizing.selectedNotional <= 0 && stabilized.direction !== "cash") {
    reasons.push("POSITION_SIZE_ZERO");
  }
  const direction = positionSizing.selectedNotional <= 0 ? "cash" : stabilized.direction;
  const rust = input.rustEvidence;
  const selectedHighVolatilityAssessment = selected
    ? input.highVolatility?.horizonAssessments[
        selected.evidence.horizonMinutes
      ]
    : undefined;
  return {
    policyVersion: UNIFIED_STRATEGY_POLICY_VERSION,
    routerVersion: MODEL_ROUTER_POLICY_VERSION,
    originAt: input.originAt,
    symbol,
    simulationCase: input.simulationCase,
    direction,
    executionAction: executionAction(input.state.currentDirection, direction),
    selectedHorizonMinutes: selected?.evidence.horizonMinutes ?? null,
    primaryEvidence: selected?.evidence ?? primaryEvidence[0] ?? null,
    vetoEvidence: vetoEvaluation.evidence,
    shadowEvidence,
    expectedGrossReturn: selected?.grossEdge ?? null,
    expectedNetReturn: selected?.netEdge ?? null,
    pNetLong: selected?.evidence.pNetLong ?? null,
    pNetShort: selected?.evidence.pNetShort ?? null,
    horizonScore: selected?.score ?? null,
    rustRegime: rust?.regime ?? null,
    passedIndicatorGates: [
      ...(rust?.passedGates ?? []),
      ...(selectedHighVolatilityAssessment?.passedGates ?? []),
    ],
    blockedIndicatorGates: [
      ...(rust?.blockedGates ?? []),
      ...(selectedHighVolatilityAssessment?.blockedGates ?? []),
    ],
    veto: vetoEvaluation.result,
    circuitBreaker,
    positionSizing,
    costBreakdown: costBreakdown(input.costs),
    noTrade: direction === "cash",
    reasons: [...new Set(reasons)],
    warnings: [...new Set(warnings)],
    highVolatilityPolicy: input.highVolatility
      ? {
          policyVersion: input.highVolatility.policyVersion,
          volatilityRegime: input.highVolatility.volatilityRegime,
          rustQualityScore: input.highVolatility.rustQuality.score,
        }
      : null,
  };
}
