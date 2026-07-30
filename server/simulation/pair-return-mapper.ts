import type { EvidenceCostBreakdown } from "./model-evidence.js";
import { probabilityAtOrBelow, totalDirectionalCostRate } from "./model-evidence.js";
import type { PairCatalogEntry } from "./pair-catalog.js";

export const PAIR_RETURN_MAPPER_VERSION = "pair-return-mapper/v1" as const;
export const ETF_SESSION_POLICY_VERSION = "us-etf-session/v1" as const;
export const ETF_PAIR_DIRECTION_POLICY_VERSION = "us-etf-pair-direction/v1" as const;

export type PairReturnObservation = {
  observedAt: string;
  targetReturn: number;
  bullReturn: number;
  bearReturn: number;
  timeOfDayBucket: string;
  volatilityRegime: string;
};

export type PairReturnMapperInput = {
  originAt: string;
  pair: PairCatalogEntry;
  targetQuantiles: Readonly<Record<number, number>>;
  targetExpectedReturn: number;
  history: readonly PairReturnObservation[];
  timeOfDayBucket: string;
  volatilityRegime: string;
  bullCosts: EvidenceCostBreakdown;
  bearCosts: EvidenceCostBreakdown;
  minimumSamples?: number;
  maximumSamples?: number;
};

type LinearFit = {
  alpha: number;
  beta: number;
  residuals: number[];
  sampleCount: number;
};

export type ExecutionLegDistribution = {
  symbol: string;
  alpha: number;
  realizedBeta: number;
  timeOfDayBeta: number | null;
  volatilityRegimeBeta: number | null;
  effectiveBeta: number;
  residualQ10: number;
  residualQ50: number;
  residualQ90: number;
  q10Return: number;
  q50Return: number;
  q90Return: number;
  expectedReturn: number;
  expectedNetReturn: number;
  pNet: number;
  totalCostBps: number;
};

export type PairReturnMapping = {
  schemaVersion: typeof PAIR_RETURN_MAPPER_VERSION;
  status: "ready" | "warming_up";
  originAt: string;
  pairId: string;
  modelTargetSymbol: string;
  auxiliarySymbols: string[];
  sampleCount: number;
  latestTrainingObservationAt: string | null;
  bull: ExecutionLegDistribution | null;
  bear: ExecutionLegDistribution | null;
  pNetBull: number | null;
  pNetBear: number | null;
  simpleLeverageMultiplicationUsed: false;
};

export type EtfSessionGateInput = {
  originAt: string;
  marketCalendarStatus: "regular" | "closed" | "unknown";
  minutesFromOpen: number | null;
  minutesToClose: number | null;
  quoteObservedAt: string | null;
  quoteSpreadBps: number | null;
  maximumSpreadBps: number;
  flattenBeforeClose: boolean;
};

export type EtfSessionGate = {
  policyVersion: typeof ETF_SESSION_POLICY_VERSION;
  canEnter: boolean;
  canHold: boolean;
  forceExit: boolean;
  openingRange: "OR15";
  reasons: string[];
};

export type EtfPairDirection = "bull" | "bear" | "cash";

export type EtfPairDirectionSelection = {
  policyVersion: typeof ETF_PAIR_DIRECTION_POLICY_VERSION;
  direction: EtfPairDirection;
  pNetBull: number;
  pNetBear: number;
  reasons: string[];
};

function timestamp(value: string, name: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be an ISO timestamp.`);
  return parsed;
}

function linearFit(
  history: readonly PairReturnObservation[],
  leg: "bullReturn" | "bearReturn",
): LinearFit {
  if (history.length < 2) return { alpha: 0, beta: 0, residuals: [], sampleCount: 0 };
  const meanX = history.reduce((sum, row) => sum + row.targetReturn, 0) / history.length;
  const meanY = history.reduce((sum, row) => sum + row[leg], 0) / history.length;
  let covariance = 0;
  let variance = 0;
  for (const row of history) {
    covariance += (row.targetReturn - meanX) * (row[leg] - meanY);
    variance += (row.targetReturn - meanX) ** 2;
  }
  const beta = variance <= Number.EPSILON ? 0 : covariance / variance;
  const alpha = meanY - beta * meanX;
  return {
    alpha,
    beta,
    residuals: history.map((row) => row[leg] - (alpha + beta * row.targetReturn)),
    sampleCount: history.length,
  };
}

function empiricalQuantile(values: readonly number[], probability: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(
    0,
    Math.min(sorted.length - 1, Math.floor(probability * (sorted.length - 1))),
  );
  return sorted[index]!;
}

function targetAt(
  quantiles: Readonly<Record<number, number>>,
  probability: number,
): number {
  const points = Object.entries(quantiles)
    .map(([key, value]) => ({ probability: Number(key), value }))
    .filter((point) => (
      point.probability > 0
      && point.probability < 1
      && Number.isFinite(point.value)
    ))
    .sort((left, right) => left.probability - right.probability);
  if (points.length < 3) throw new Error("PairReturnMapper requires at least three quantiles.");
  if (probability <= points[0]!.probability) return points[0]!.value;
  if (probability >= points.at(-1)!.probability) return points.at(-1)!.value;
  const index = points.findIndex((point) => point.probability >= probability);
  const left = points[index - 1]!;
  const right = points[index]!;
  const weight = (probability - left.probability) / (right.probability - left.probability);
  return left.value + (right.value - left.value) * weight;
}

function mapLeg(
  symbol: string,
  overall: LinearFit,
  timeFit: LinearFit | undefined,
  regimeFit: LinearFit | undefined,
  targetQuantiles: Readonly<Record<number, number>>,
  targetExpectedReturn: number,
  costs: EvidenceCostBreakdown,
): ExecutionLegDistribution {
  const betaComponents = [
    { value: overall.beta, weight: 0.5 },
    ...(timeFit && timeFit.sampleCount >= 10 ? [{ value: timeFit.beta, weight: 0.25 }] : []),
    ...(regimeFit && regimeFit.sampleCount >= 10
      ? [{ value: regimeFit.beta, weight: 0.25 }]
      : []),
  ];
  const weightSum = betaComponents.reduce((sum, component) => sum + component.weight, 0);
  const effectiveBeta = betaComponents.reduce(
    (sum, component) => sum + component.value * component.weight,
    0,
  ) / weightSum;
  const residualQ10 = empiricalQuantile(overall.residuals, 0.1);
  const residualQ50 = empiricalQuantile(overall.residuals, 0.5);
  const residualQ90 = empiricalQuantile(overall.residuals, 0.9);
  const inputProbabilities = effectiveBeta >= 0
    ? [0.1, 0.5, 0.9] as const
    : [0.9, 0.5, 0.1] as const;
  const q10Return = overall.alpha
    + effectiveBeta * targetAt(targetQuantiles, inputProbabilities[0])
    + residualQ10;
  const q50Return = overall.alpha
    + effectiveBeta * targetAt(targetQuantiles, inputProbabilities[1])
    + residualQ50;
  const q90Return = overall.alpha
    + effectiveBeta * targetAt(targetQuantiles, inputProbabilities[2])
    + residualQ90;
  const mappedQuantiles = { 0.1: q10Return, 0.5: q50Return, 0.9: q90Return };
  const directionalCost = totalDirectionalCostRate(costs).long;
  const expectedReturn = overall.alpha + effectiveBeta * targetExpectedReturn + residualQ50;
  return {
    symbol,
    alpha: overall.alpha,
    realizedBeta: overall.beta,
    timeOfDayBeta: timeFit && timeFit.sampleCount >= 10 ? timeFit.beta : null,
    volatilityRegimeBeta: regimeFit && regimeFit.sampleCount >= 10 ? regimeFit.beta : null,
    effectiveBeta,
    residualQ10,
    residualQ50,
    residualQ90,
    q10Return,
    q50Return,
    q90Return,
    expectedReturn,
    expectedNetReturn: expectedReturn - directionalCost,
    pNet: 1 - probabilityAtOrBelow(mappedQuantiles, directionalCost),
    totalCostBps: directionalCost * 10_000,
  };
}

export function fitPairReturnMapper(input: PairReturnMapperInput): PairReturnMapping {
  const originMs = timestamp(input.originAt, "originAt");
  const minimumSamples = input.minimumSamples ?? 60;
  const maximumSamples = input.maximumSamples ?? 2_000;
  const eligible = input.history
    .filter((row) => (
      timestamp(row.observedAt, "observedAt") < originMs
      && Number.isFinite(row.targetReturn)
      && Number.isFinite(row.bullReturn)
      && Number.isFinite(row.bearReturn)
    ))
    .sort((left, right) => timestamp(left.observedAt, "left") - timestamp(right.observedAt, "right"))
    .slice(-maximumSamples);
  if (eligible.length < minimumSamples) {
    return {
      schemaVersion: PAIR_RETURN_MAPPER_VERSION,
      status: "warming_up",
      originAt: input.originAt,
      pairId: input.pair.pairId,
      modelTargetSymbol: input.pair.modelTargetSymbol,
      auxiliarySymbols: [...input.pair.auxiliarySymbols],
      sampleCount: eligible.length,
      latestTrainingObservationAt: eligible.at(-1)?.observedAt ?? null,
      bull: null,
      bear: null,
      pNetBull: null,
      pNetBear: null,
      simpleLeverageMultiplicationUsed: false,
    };
  }
  const timeRows = eligible.filter((row) => row.timeOfDayBucket === input.timeOfDayBucket);
  const regimeRows = eligible.filter((row) => row.volatilityRegime === input.volatilityRegime);
  const bull = mapLeg(
    input.pair.bull.executionSymbol,
    linearFit(eligible, "bullReturn"),
    linearFit(timeRows, "bullReturn"),
    linearFit(regimeRows, "bullReturn"),
    input.targetQuantiles,
    input.targetExpectedReturn,
    input.bullCosts,
  );
  const bear = mapLeg(
    input.pair.bear.executionSymbol,
    linearFit(eligible, "bearReturn"),
    linearFit(timeRows, "bearReturn"),
    linearFit(regimeRows, "bearReturn"),
    input.targetQuantiles,
    input.targetExpectedReturn,
    input.bearCosts,
  );
  return {
    schemaVersion: PAIR_RETURN_MAPPER_VERSION,
    status: "ready",
    originAt: input.originAt,
    pairId: input.pair.pairId,
    modelTargetSymbol: input.pair.modelTargetSymbol,
    auxiliarySymbols: [...input.pair.auxiliarySymbols],
    sampleCount: eligible.length,
    latestTrainingObservationAt: eligible.at(-1)!.observedAt,
    bull,
    bear,
    pNetBull: bull.pNet,
    pNetBear: bear.pNet,
    simpleLeverageMultiplicationUsed: false,
  };
}

export function evaluateEtfSessionGate(input: EtfSessionGateInput): EtfSessionGate {
  const reasons: string[] = [];
  const originMs = timestamp(input.originAt, "originAt");
  if (input.marketCalendarStatus !== "regular") {
    reasons.push(
      input.marketCalendarStatus === "unknown"
        ? "TRADING_CALENDAR_UNKNOWN"
        : "OUTSIDE_REGULAR_SESSION",
    );
  }
  if (input.minutesFromOpen === null || input.minutesToClose === null) {
    reasons.push("SESSION_POSITION_UNAVAILABLE");
  } else {
    if (input.minutesFromOpen < 5) reasons.push("OPENING_FIVE_MINUTE_ENTRY_BLOCK");
    if (input.minutesFromOpen < 15) reasons.push("OR15_NOT_COMPLETE");
    if (input.minutesToClose <= 15) reasons.push("CLOSE_FIFTEEN_MINUTE_ENTRY_BLOCK");
  }
  if (input.quoteObservedAt === null) {
    reasons.push("QUOTE_UNAVAILABLE");
  } else {
    const quoteAge = originMs - timestamp(input.quoteObservedAt, "quoteObservedAt");
    if (quoteAge < 0) reasons.push("FUTURE_QUOTE");
    if (quoteAge > 60_000) reasons.push("QUOTE_STALE");
  }
  if (
    input.quoteSpreadBps === null
    || !Number.isFinite(input.quoteSpreadBps)
    || input.quoteSpreadBps > input.maximumSpreadBps
  ) reasons.push("SPREAD_LIMIT");
  const forceExit = input.flattenBeforeClose
    && input.minutesToClose !== null
    && input.minutesToClose <= 5;
  return {
    policyVersion: ETF_SESSION_POLICY_VERSION,
    canEnter: reasons.length === 0,
    canHold: input.marketCalendarStatus === "regular" && !forceExit,
    forceExit,
    openingRange: "OR15",
    reasons: [...new Set(reasons)],
  };
}

/**
 * Deterministic ETF leg selection shared by forward paper simulation and
 * historical replay. FinCast shadow evidence is deliberately absent from the
 * input so it cannot affect the order decision.
 */
export function selectEtfPairDirection(input: {
  mapping: PairReturnMapping | undefined;
  primaryAvailable: boolean;
  rustDataQuality: "good" | "degraded" | "unavailable";
  rustTechnicalSignal: -1 | 0 | 1;
  minimumNetProbability?: number;
}): EtfPairDirectionSelection {
  const threshold = input.minimumNetProbability ?? 0.6;
  const pNetBull = input.mapping?.pNetBull ?? 0;
  const pNetBear = input.mapping?.pNetBear ?? 0;
  const reasons: string[] = [];
  if (!input.primaryAvailable) reasons.push("CHRONOS2_PRIMARY_UNAVAILABLE");
  if (input.mapping?.status !== "ready") reasons.push("PAIR_RETURN_MAPPER_WARMING_UP");
  if (input.rustDataQuality !== "good") reasons.push("RUST_GATE_UNAVAILABLE");
  if (reasons.length > 0) {
    return {
      policyVersion: ETF_PAIR_DIRECTION_POLICY_VERSION,
      direction: "cash",
      pNetBull,
      pNetBear,
      reasons,
    };
  }
  if (
    pNetBull >= threshold
    && pNetBull > pNetBear
    && (input.mapping?.bull?.expectedNetReturn ?? 0) > 0
    && input.rustTechnicalSignal !== -1
  ) {
    return {
      policyVersion: ETF_PAIR_DIRECTION_POLICY_VERSION,
      direction: "bull",
      pNetBull,
      pNetBear,
      reasons: ["BULL_COST_ADJUSTED_EDGE"],
    };
  }
  if (
    pNetBear >= threshold
    && pNetBear > pNetBull
    && (input.mapping?.bear?.expectedNetReturn ?? 0) > 0
    && input.rustTechnicalSignal !== 1
  ) {
    return {
      policyVersion: ETF_PAIR_DIRECTION_POLICY_VERSION,
      direction: "bear",
      pNetBull,
      pNetBear,
      reasons: ["BEAR_COST_ADJUSTED_EDGE"],
    };
  }
  return {
    policyVersion: ETF_PAIR_DIRECTION_POLICY_VERSION,
    direction: "cash",
    pNetBull,
    pNetBear,
    reasons: ["NO_COST_ADJUSTED_ETF_EDGE"],
  };
}

export function applyEtfSessionGate(input: {
  proposedDirection: EtfPairDirection;
  currentDirection: EtfPairDirection;
  gate: EtfSessionGate;
}): { direction: EtfPairDirection; reasons: string[] } {
  const blocked = input.gate.forceExit
    || !input.gate.canHold
    || (
      input.proposedDirection !== input.currentDirection
      && !input.gate.canEnter
    );
  return {
    direction: blocked ? "cash" : input.proposedDirection,
    reasons: blocked
      ? [...input.gate.reasons, ...(input.gate.forceExit ? ["FORCE_EXIT_BEFORE_CLOSE"] : [])]
      : [...input.gate.reasons],
  };
}
