import type { PairTradingCosts } from "./ensemble-policy.js";
import type { PairDirection } from "./pair-catalog.js";

export const PAIR_STRATEGY_COMPARISON_VERSION = "pair-strategy-comparison/v2" as const;

export const PAIR_STRATEGY_LANES = [
  "kronos",
  "rust",
  "ensemble",
] as const;
export type PairStrategyLaneId = typeof PAIR_STRATEGY_LANES[number];

export type PairStrategyLaneObservation =
  | {
      status: "available";
      direction: PairDirection;
      executionSymbol: string | null;
      directionProbability?: number;
      calibrationStatus?: "good" | "poor" | "unavailable";
      latencyMs?: number;
    }
  | {
      status: "unavailable";
      unavailableReason: string;
      calibrationStatus?: "poor" | "unavailable";
      latencyMs?: number;
    };

export type PairExecutableOutcome = {
  executionSymbol: string;
  grossReturn: number;
  entryPrice?: number;
  exitPrice?: number;
};

export type PairExecutableOutcomeSelection = {
  direction: PairDirection;
  executionSymbol: string | null;
  netReturns: {
    bull: number;
    bear: number;
    cash: 0;
  };
};

export type PairStrategyComparisonObservation = {
  observationId: string;
  origin: string;
  eligibleAfter: string;
  targetTimestamp: string;
  actualDirection: "bull" | "bear" | "cash";
  actualExecutionSymbol?: string;
  executableOutcomes: {
    bull: PairExecutableOutcome;
    bear: PairExecutableOutcome;
  };
  lanes: Record<PairStrategyLaneId, PairStrategyLaneObservation>;
};

export type PairStrategyComparisonInput = {
  conditionId: string;
  initialCapital: number;
  costs: PairTradingCosts;
  executionPolicyId: string;
  observations: readonly PairStrategyComparisonObservation[];
};

export function isNonOverlappingPairComparisonOrigin(
  existing: readonly Pick<PairStrategyComparisonObservation, "targetTimestamp">[],
  nextOrigin: string,
): boolean {
  const origin = Date.parse(timestamp(nextOrigin, "nextOrigin"));
  return existing.every(({ targetTimestamp }) => (
    Date.parse(timestamp(targetTimestamp, "targetTimestamp")) <= origin
  ));
}

export type PairStrategyLaneMetrics = {
  status: "available" | "partial" | "unavailable";
  analyticalOnly: boolean;
  originCount: number;
  availableCount: number;
  unavailableCount: number;
  cumulativeReturn: number;
  netReturn: number;
  netProfit: number;
  maxDrawdown: number;
  riskAdjustedReturn: number;
  bullCount: number;
  bearCount: number;
  cashCount: number;
  transitionCount: number;
  directionAccuracy: number | null;
  executionSelectionAccuracy: number | null;
  tradeCount: number;
  totalCosts: number;
  calibrationBrierScore: number | null;
  calibrationUnavailableRate: number;
  unavailableRate: number;
  averageLatencyMs: number | null;
};

export type PairStrategyComparison = {
  schemaVersion: typeof PAIR_STRATEGY_COMPARISON_VERSION;
  conditionId: string;
  sameOrigin: true;
  sameCosts: true;
  sameExecutionPolicy: true;
  common: {
    originCount: number;
    firstOrigin?: string;
    lastOrigin?: string;
    initialCapital: number;
    costs: PairTradingCosts;
    executionPolicyId: string;
  };
  lanes: Record<PairStrategyLaneId, PairStrategyLaneMetrics>;
  strategies: Record<PairStrategyLaneId, PairStrategyLaneMetrics>;
};

function timestamp(value: string, name: string): string {
  if (!Number.isFinite(Date.parse(value))) throw new Error(`${name} must be an RFC3339 timestamp.`);
  return new Date(Date.parse(value)).toISOString();
}

function validateBps(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 5_000) {
    throw new Error(`${name} must be finite basis points in [0, 5000].`);
  }
}

function validatePairTradingCosts(costs: PairTradingCosts): void {
  for (const [name, value] of Object.entries({
    commissionBpsPerSide: costs.commissionBpsPerSide,
    taxBpsOnExit: costs.taxBpsOnExit,
    spreadBpsRoundTrip: costs.spreadBpsRoundTrip,
    slippageBpsPerSide: costs.slippageBpsPerSide,
    switchCostBps: costs.switchCostBps,
    sellRegulatoryBps: costs.sellRegulatoryBps ?? 0,
  })) validateBps(value, name);
  for (const [name, value] of Object.entries({
    commissionFreeGrossAmountMaximum: costs.commissionFreeGrossAmountMaximum,
    sellRegulatoryFeePerShare: costs.sellRegulatoryFeePerShare,
    sellRegulatoryFeeMaximum: costs.sellRegulatoryFeeMaximum,
    estimatedOrderGrossAmount: costs.estimatedOrderGrossAmount,
  })) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
      throw new Error(`${name} must be finite and non-negative.`);
    }
  }
}

function rounded(value: number): number {
  return Math.round(value * 1_000_000_000) / 1_000_000_000;
}

function costRate(
  costs: PairTradingCosts,
  outcome?: PairExecutableOutcome,
  grossAmount = 100_000,
): number {
  const commissionWaived = costs.commissionFreeGrossAmountMaximum !== undefined
    && grossAmount <= costs.commissionFreeGrossAmountMaximum;
  const referencePrice = outcome?.entryPrice;
  let perShareRegulatoryBps = referencePrice !== undefined
    && Number.isFinite(referencePrice)
    && referencePrice > 0
    ? (costs.sellRegulatoryFeePerShare ?? 0) / referencePrice * 10_000
    : 0;
  if (costs.sellRegulatoryFeeMaximum !== undefined && grossAmount > 0) {
    perShareRegulatoryBps = Math.min(
      perShareRegulatoryBps,
      costs.sellRegulatoryFeeMaximum / grossAmount * 10_000,
    );
  }
  return (
    (commissionWaived ? 0 : costs.commissionBpsPerSide * 2)
    + costs.taxBpsOnExit
    + (costs.sellRegulatoryBps ?? 0)
    + perShareRegulatoryBps
    + costs.spreadBpsRoundTrip
    + costs.slippageBpsPerSide * 2
  ) / 10_000;
}

export function selectBestExecutablePairOutcome(
  outcomes: PairStrategyComparisonObservation["executableOutcomes"],
  costs: PairTradingCosts,
): PairExecutableOutcomeSelection {
  validatePairTradingCosts(costs);
  for (const direction of ["bull", "bear"] as const) {
    const outcome = outcomes[direction];
    if (!outcome.executionSymbol.trim()
      || !Number.isFinite(outcome.grossReturn)
      || outcome.grossReturn <= -1
      || (outcome.entryPrice !== undefined
        && (!Number.isFinite(outcome.entryPrice) || outcome.entryPrice <= 0))
      || (outcome.exitPrice !== undefined
        && (!Number.isFinite(outcome.exitPrice) || outcome.exitPrice <= 0))) {
      throw new Error(`Executable ${direction} outcome is invalid.`);
    }
  }
  const rawNetReturns = {
    bull: outcomes.bull.grossReturn - costRate(costs, outcomes.bull),
    bear: outcomes.bear.grossReturn - costRate(costs, outcomes.bear),
  };
  const direction: PairDirection = rawNetReturns.bull > 0
    && rawNetReturns.bull > rawNetReturns.bear
    ? "bull"
    : rawNetReturns.bear > 0 && rawNetReturns.bear > rawNetReturns.bull
      ? "bear"
      : "cash";
  return {
    direction,
    executionSymbol: direction === "cash" ? null : outcomes[direction].executionSymbol,
    netReturns: {
      bull: rounded(rawNetReturns.bull),
      bear: rounded(rawNetReturns.bear),
      cash: 0,
    },
  };
}

function maximumDrawdown(values: readonly number[]): number {
  let peak = values[0] ?? 0;
  let maximum = 0;
  for (const value of values) {
    peak = Math.max(peak, value);
    if (peak > 0) maximum = Math.max(maximum, (peak - value) / peak);
  }
  return rounded(maximum);
}

function riskAdjustedReturn(returns: readonly number[]): number {
  if (returns.length < 2) return 0;
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce(
    (sum, value) => sum + (value - mean) ** 2,
    0,
  ) / (returns.length - 1);
  const deviation = Math.sqrt(Math.max(0, variance));
  return deviation > 0 ? rounded(mean / deviation * Math.sqrt(returns.length)) : 0;
}

function availableStatus(
  availableCount: number,
  originCount: number,
): PairStrategyLaneMetrics["status"] {
  return availableCount === 0
    ? "unavailable"
    : availableCount === originCount ? "available" : "partial";
}

function metricsForLane(
  laneId: PairStrategyLaneId,
  input: PairStrategyComparisonInput,
): PairStrategyLaneMetrics {
  let netEquity = input.initialCapital;
  let grossEquity = input.initialCapital;
  let totalCosts = 0;
  let availableCount = 0;
  let bullCount = 0;
  let bearCount = 0;
  let cashCount = 0;
  let transitionCount = 0;
  let tradeCount = 0;
  let directionCorrect = 0;
  let directionEvaluated = 0;
  let executionCorrect = 0;
  let executionEvaluated = 0;
  let previousDirection: PairDirection = "cash";
  const path = [netEquity];
  const periodReturns: number[] = [];
  const calibrationErrors: number[] = [];
  let calibrationUnavailable = 0;
  const latencies: number[] = [];

  for (const observation of input.observations) {
    const lane = observation.lanes[laneId];
    if (lane.status === "unavailable") {
      calibrationUnavailable += 1;
      if (lane.latencyMs !== undefined) latencies.push(lane.latencyMs);
      path.push(netEquity);
      periodReturns.push(0);
      continue;
    }
    availableCount += 1;
    if (lane.latencyMs !== undefined) latencies.push(lane.latencyMs);
    if (lane.calibrationStatus !== "good") calibrationUnavailable += 1;
    const direction = lane.direction;
    if (direction === "bull") bullCount += 1;
    else if (direction === "bear") bearCount += 1;
    else cashCount += 1;
    if (direction !== previousDirection) transitionCount += 1;

    if (observation.actualDirection !== "cash") {
      directionEvaluated += 1;
      if (direction === observation.actualDirection) directionCorrect += 1;
    }
    if (direction !== "cash" && observation.actualExecutionSymbol) {
      executionEvaluated += 1;
      if (lane.executionSymbol === observation.actualExecutionSymbol) executionCorrect += 1;
    }
    if (lane.directionProbability !== undefined
      && observation.actualDirection !== "cash"
      && direction !== "cash") {
      const probability = lane.directionProbability;
      if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
        throw new Error(`Invalid direction probability for ${laneId}.`);
      }
      const outcome = direction === observation.actualDirection ? 1 : 0;
      calibrationErrors.push((probability - outcome) ** 2);
    }

    if (direction === "cash") {
      previousDirection = direction;
      path.push(netEquity);
      periodReturns.push(0);
      continue;
    }
    const outcome = observation.executableOutcomes[direction];
    if (lane.executionSymbol !== outcome.executionSymbol) {
      throw new Error(
        `${laneId} does not use the common executable instrument at ${observation.observationId}.`,
      );
    }
    // Every observation uses the same independently executable round-trip
    // outcome. The additional switch cost is a policy-level churn penalty
    // when two adjacent decisions reverse direction; it is not a substitute
    // for the round-trip costs already included in baseCostRate.
    const switching = previousDirection !== "cash" && previousDirection !== direction;
    const baseCostRate = costRate(input.costs, outcome, netEquity);
    const appliedCostRate = baseCostRate + (switching ? input.costs.switchCostBps / 10_000 : 0);
    const capitalBefore = netEquity;
    const monetaryCost = capitalBefore * appliedCostRate;
    const netPeriodReturn = outcome.grossReturn - appliedCostRate;
    grossEquity *= 1 + outcome.grossReturn;
    netEquity *= 1 + netPeriodReturn;
    totalCosts += monetaryCost;
    tradeCount += 1;
    path.push(netEquity);
    periodReturns.push(netPeriodReturn);
    previousDirection = direction;
  }

  const originCount = input.observations.length;
  return {
    status: availableStatus(availableCount, originCount),
    // All three lanes are normalized analytical comparisons. Only the service
    // ledger driven by the ensemble decision is allowed to create forward
    // paper fills.
    analyticalOnly: true,
    originCount,
    availableCount,
    unavailableCount: originCount - availableCount,
    cumulativeReturn: rounded(grossEquity / input.initialCapital - 1),
    netReturn: rounded(netEquity / input.initialCapital - 1),
    netProfit: rounded(netEquity - input.initialCapital),
    maxDrawdown: maximumDrawdown(path),
    riskAdjustedReturn: riskAdjustedReturn(periodReturns),
    bullCount,
    bearCount,
    cashCount,
    transitionCount,
    directionAccuracy: directionEvaluated
      ? rounded(directionCorrect / directionEvaluated) : null,
    executionSelectionAccuracy: executionEvaluated
      ? rounded(executionCorrect / executionEvaluated) : null,
    tradeCount,
    totalCosts: rounded(totalCosts),
    calibrationBrierScore: calibrationErrors.length
      ? rounded(calibrationErrors.reduce((sum, value) => sum + value, 0) / calibrationErrors.length)
      : null,
    calibrationUnavailableRate: originCount
      ? rounded(calibrationUnavailable / originCount) : 0,
    unavailableRate: originCount
      ? rounded((originCount - availableCount) / originCount) : 0,
    averageLatencyMs: latencies.length
      ? rounded(latencies.reduce((sum, value) => sum + value, 0) / latencies.length)
      : null,
  };
}

function validateObservation(
  value: PairStrategyComparisonObservation,
  previousOrigin?: number,
): number {
  if (!value.observationId.trim()) throw new Error("observationId is required.");
  const origin = Date.parse(timestamp(value.origin, "origin"));
  const eligible = Date.parse(timestamp(value.eligibleAfter, "eligibleAfter"));
  const target = Date.parse(timestamp(value.targetTimestamp, "targetTimestamp"));
  if (previousOrigin !== undefined && origin <= previousOrigin) {
    throw new Error("Comparison origins must be strictly increasing.");
  }
  if (eligible < origin || target <= eligible) {
    throw new Error("Comparison origin, eligibility, and target timestamps are inconsistent.");
  }
  for (const direction of ["bull", "bear"] as const) {
    const outcome = value.executableOutcomes[direction];
    if (!outcome.executionSymbol.trim()
      || !Number.isFinite(outcome.grossReturn)
      || outcome.grossReturn <= -1
      || (outcome.entryPrice !== undefined
        && (!Number.isFinite(outcome.entryPrice) || outcome.entryPrice <= 0))
      || (outcome.exitPrice !== undefined
        && (!Number.isFinite(outcome.exitPrice) || outcome.exitPrice <= 0))) {
      throw new Error(`Executable ${direction} outcome is invalid.`);
    }
  }
  for (const laneId of PAIR_STRATEGY_LANES) {
    const lane = value.lanes[laneId];
    if (!lane || !["available", "unavailable"].includes(lane.status)) {
      throw new Error(`Every comparison origin requires an explicit ${laneId} lane status.`);
    }
    if (lane.latencyMs !== undefined
      && (!Number.isFinite(lane.latencyMs) || lane.latencyMs < 0)) {
      throw new Error(`Invalid latency for ${laneId}.`);
    }
    if (lane.status === "available") {
      if (!["bull", "bear", "cash"].includes(lane.direction)
        || (lane.direction === "cash" ? lane.executionSymbol !== null : !lane.executionSymbol)) {
        throw new Error(`Available ${laneId} decision is invalid.`);
      }
    } else if (!lane.unavailableReason.trim()) {
      throw new Error(`Unavailable ${laneId} requires a reason.`);
    }
  }
  return origin;
}

export function comparePairStrategies(
  input: PairStrategyComparisonInput,
): PairStrategyComparison {
  if (!input.conditionId.trim() || !input.executionPolicyId.trim()) {
    throw new Error("Comparison condition and execution policy ids are required.");
  }
  if (!Number.isFinite(input.initialCapital) || input.initialCapital <= 0) {
    throw new Error("initialCapital must be positive and finite.");
  }
  validatePairTradingCosts(input.costs);
  const seen = new Set<string>();
  let previousOrigin: number | undefined;
  for (const observation of input.observations) {
    if (seen.has(observation.observationId)) {
      throw new Error(`Duplicate comparison observation: ${observation.observationId}`);
    }
    seen.add(observation.observationId);
    previousOrigin = validateObservation(observation, previousOrigin);
  }
  const lanes = Object.fromEntries(PAIR_STRATEGY_LANES.map((laneId) => (
    [laneId, metricsForLane(laneId, input)]
  ))) as Record<PairStrategyLaneId, PairStrategyLaneMetrics>;
  const strategies = Object.fromEntries(PAIR_STRATEGY_LANES.map((laneId) => (
    [laneId, { ...lanes[laneId] }]
  ))) as Record<PairStrategyLaneId, PairStrategyLaneMetrics>;
  return {
    schemaVersion: PAIR_STRATEGY_COMPARISON_VERSION,
    conditionId: input.conditionId,
    sameOrigin: true,
    sameCosts: true,
    sameExecutionPolicy: true,
    common: {
      originCount: input.observations.length,
      ...(input.observations[0] ? {
        firstOrigin: timestamp(input.observations[0].origin, "origin"),
        lastOrigin: timestamp(input.observations.at(-1)!.origin, "origin"),
      } : {}),
      initialCapital: input.initialCapital,
      costs: { ...input.costs },
      executionPolicyId: input.executionPolicyId,
    },
    lanes,
    strategies,
  };
}
