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
} from "./high-volatility-stack-policy.js";
import {
  normalizeModelEvidence,
  totalDirectionalCostRate,
} from "./model-evidence.js";
import {
  applyEtfSessionGate,
  selectEtfPairDirection,
  type EtfPairDirection,
  type EtfSessionGate,
  type PairReturnMapping,
} from "./pair-return-mapper.js";
import type { RustMarketEvidenceV2 } from "./technical-indicator-evidence.js";
import {
  decideUnifiedSimulationPolicy,
  type CircuitBreakerObservations,
  type UnifiedDirection,
  type UnifiedPolicyDecision,
  type UnifiedPolicyState,
} from "./unified-policy-engine.js";

export const HISTORICAL_SIMULATION_BACKTEST_VERSION =
  "historical-simulation-backtest/v1" as const;

export type HistoricalBacktestLane =
  | "baseline_policy"
  | "primary_only"
  | "rust_only"
  | "primary_veto"
  | "final_policy";

export type HistoricalDecisionOrigin = {
  originAt: string;
  fillAt: string;
  signalSymbol: string;
  executionSymbols: Partial<Record<Exclude<UnifiedDirection, "cash">, string>>;
  pricesAtFill: Record<string, number>;
  modelPlan: readonly SimulationModelPlanEntry[];
  modelEvidence: readonly ModelEvidence[];
  rustEvidence?: RustMarketEvidenceV2;
  costs: EvidenceCostBreakdown;
  baselineDirection: UnifiedDirection;
  pairMapping?: PairReturnMapping;
  etfSessionGate?: EtfSessionGate;
  scannerSelectedSymbols?: string[];
  highVolatility?: HighVolatilityUnifiedPolicyContext;
  actualTargetReturns?: Partial<Record<5 | 15 | 30 | 60, number>>;
  circuit?: Partial<CircuitBreakerObservations>;
};

export type HistoricalBacktestInput = {
  simulationCase: SimulationCase;
  symbol: string;
  seed: number;
  initialEquity: number;
  origins: readonly HistoricalDecisionOrigin[];
  costStressMultiplier: number;
};

export type HistoricalFill = {
  lane: HistoricalBacktestLane;
  originAt: string;
  filledAt: string;
  direction: UnifiedDirection;
  previousDirection: UnifiedDirection;
  executionSymbol: string | null;
  price: number | null;
  exposureRate: number;
  cost: number;
  reason: string;
};

export type HistoricalLaneDecision = {
  lane: HistoricalBacktestLane;
  originAt: string;
  fillAt: string;
  direction: UnifiedDirection;
  executionSymbol: string | null;
  exposureRate: number;
  reasons: string[];
  unifiedDecision?: UnifiedPolicyDecision;
};

export type HistoricalPerformanceMetrics = {
  grossReturn: number;
  netReturn: number;
  costDrag: number;
  maximumDrawdown: number;
  sharpe: number | null;
  sortino: number | null;
  calmar: number | null;
  turnover: number;
  tradeCount: number;
  winRate: number | null;
  profitFactor: number | null;
  averageTradeReturn: number | null;
  p05TradeReturn: number | null;
  p95TradeReturn: number | null;
  maximumConsecutiveLosses: number;
  exposure: number;
  cashRatio: number;
  directionAccuracy: number | null;
  unavailableRatio: number;
  vetoCount: number;
  noTradeCount: number;
  totalCosts: number;
  endingEquity: number;
};

export type HistoricalModelMetrics = {
  modelLane: string;
  role: string;
  observationCount: number;
  directionAccuracy: number | null;
  brier: number | null;
  pinball: number | null;
  weightedIntervalScore: number | null;
  intervalCoverage: number | null;
  calibrationError: number | null;
  unavailableRatio: number;
  averageLatencyMs: number | null;
};

export type HistoricalBacktestResult = {
  schemaVersion: typeof HISTORICAL_SIMULATION_BACKTEST_VERSION;
  simulationCase: SimulationCase;
  symbol: string;
  seed: number;
  initialEquity: number;
  costStressMultiplier: number;
  originCount: number;
  firstOriginAt: string | null;
  lastOriginAt: string | null;
  lanes: Record<HistoricalBacktestLane, HistoricalPerformanceMetrics>;
  modelMetrics: HistoricalModelMetrics[];
  scannerSelectionStability: number | null;
  offlineThroughputOriginsPerSecond: number;
  decisions: HistoricalLaneDecision[];
  fills: HistoricalFill[];
  integrity: {
    finalizedDataOnly: true;
    originFillSeparated: true;
    sameBarRetroactiveFill: false;
    deterministic: true;
    pointInTimeTraining: true;
  };
};

type LaneState = {
  direction: UnifiedDirection;
  executionSymbol: string | null;
  exposureRate: number;
  equity: number;
  grossPnl: number;
  costs: number;
  turnoverNotional: number;
  previousPrices: Record<string, number>;
  returns: number[];
  equityCurve: number[];
  exposureSamples: number[];
  tradeReturns: number[];
  openTradePnl: number;
  openTradeNotional: number;
  tradeCount: number;
  vetoCount: number;
  noTradeCount: number;
  unavailableCount: number;
  directionalPredictions: Array<{ predicted: number; actual: number }>;
  policyState: UnifiedPolicyState;
};

type LaneChoice = {
  direction: UnifiedDirection;
  exposureRate: number;
  reasons: string[];
  probability?: number;
  unavailable?: boolean;
  unifiedDecision?: UnifiedPolicyDecision;
};

function timestamp(value: string, name: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be an ISO timestamp.`);
  return parsed;
}

function quantile(values: readonly number[], probability: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const position = probability * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const weight = position - lower;
  return sorted[lower]! * (1 - weight) + sorted[upper]! * weight;
}

function mean(values: readonly number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function standardDeviation(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const average = mean(values);
  return Math.sqrt(
    values.reduce((sum, value) => sum + (value - average) ** 2, 0)
      / (values.length - 1),
  );
}

function initialLaneState(initialEquity: number): LaneState {
  return {
    direction: "cash",
    executionSymbol: null,
    exposureRate: 0,
    equity: initialEquity,
    grossPnl: 0,
    costs: 0,
    turnoverNotional: 0,
    previousPrices: {},
    returns: [],
    equityCurve: [initialEquity],
    exposureSamples: [],
    tradeReturns: [],
    openTradePnl: 0,
    openTradeNotional: 0,
    tradeCount: 0,
    vetoCount: 0,
    noTradeCount: 0,
    unavailableCount: 0,
    directionalPredictions: [],
    policyState: {
      currentDirection: "cash",
      tradeTimestamps: [],
      dailyTurnoverRate: 0,
    },
  };
}

function stressedCosts(
  costs: EvidenceCostBreakdown,
  multiplier: number,
): EvidenceCostBreakdown {
  return {
    ...costs,
    spreadBps: costs.spreadBps * multiplier,
    slippageBps: costs.slippageBps * multiplier,
  };
}

function evidenceAtCosts(
  evidence: ModelEvidence,
  costs: EvidenceCostBreakdown,
): ModelEvidence {
  return normalizeModelEvidence({
    modelLane: evidence.modelLane,
    modelId: evidence.modelId,
    modelRevision: evidence.modelRevision,
    role: evidence.role,
    symbol: evidence.symbol,
    originAt: evidence.originAt,
    horizonMinutes: evidence.horizonMinutes,
    quantiles: Object.fromEntries(
      Object.entries(evidence.rawQuantiles).map(([probability, value]) => [
        Number(probability),
        value,
      ]),
    ),
    expectedReturn: evidence.expectedReturn,
    calibrationId: evidence.calibrationId,
    calibrationStatus: evidence.calibrationStatus,
    calibrationAge: evidence.calibrationAge,
    featureProfile: evidence.featureProfile,
    dataQuality: evidence.dataQuality,
    generatedAt: evidence.generatedAt,
    latencyMs: evidence.latencyMs,
    inputOrigin: evidence.inputOrigin,
    costs,
  });
}

function primaryEvidence(
  origin: HistoricalDecisionOrigin,
): ModelEvidence[] {
  const plans = origin.modelPlan.filter((plan) => (
    plan.role === "primary"
    && (plan.symbol === "*" || plan.symbol.toUpperCase() === origin.signalSymbol.toUpperCase())
  ));
  return plans.flatMap((plan) => origin.modelEvidence.filter((evidence) => (
    evidence.role === "primary"
    && evidence.modelLane === plan.modelLane
    && evidence.symbol.toUpperCase() === origin.signalSymbol.toUpperCase()
    && evidence.originAt === origin.originAt
  )));
}

function choosePrimaryOnly(origin: HistoricalDecisionOrigin): LaneChoice {
  const candidates = primaryEvidence(origin)
    .filter((evidence) => (
      evidence.calibrationStatus === "ready"
      && evidence.dataQuality.status === "ok"
      && !evidence.dataQuality.stale
    ))
    .map((evidence) => {
      const long = evidence.pNetLong >= evidence.pNetShort;
      const probability = long ? evidence.pNetLong : evidence.pNetShort;
      const netEdge = long ? evidence.expectedNetReturn : -evidence.expectedNetReturn;
      const tail = long
        ? Math.max(evidence.expectedShortfall, -evidence.q10Return, 0.0001)
        : Math.max(evidence.q90Return, 0.0001);
      return {
        evidence,
        direction: long ? "long" as const : "short" as const,
        probability,
        netEdge,
        score: netEdge / tail,
      };
    })
    .filter((candidate) => candidate.probability >= 0.6 && candidate.netEdge > 0)
    .sort((left, right) => right.score - left.score);
  const selected = candidates[0];
  if (!selected) {
    return {
      direction: "cash",
      exposureRate: 0,
      reasons: ["PRIMARY_UNAVAILABLE_OR_NO_NET_EDGE"],
      unavailable: primaryEvidence(origin).length === 0,
    };
  }
  return {
    direction: selected.direction,
    exposureRate: 0.5,
    probability: selected.probability,
    reasons: [`PRIMARY_ONLY_${selected.evidence.horizonMinutes}M`],
  };
}

function chooseRustOnly(origin: HistoricalDecisionOrigin): LaneChoice {
  const rust = origin.rustEvidence;
  if (!rust || rust.blockedGates.length > 0) {
    return {
      direction: "cash",
      exposureRate: 0,
      reasons: rust ? [...rust.blockedGates] : ["RUST_EVIDENCE_UNAVAILABLE"],
      unavailable: !rust,
    };
  }
  const score = mean([
    rust.trendScore ?? 0,
    rust.momentumScore ?? 0,
    rust.breakoutScore ?? 0,
  ]);
  if (Math.abs(score) < 0.15 || (rust.liquidityQuality ?? 0) < 0.45) {
    return { direction: "cash", exposureRate: 0, reasons: ["RUST_NO_TRADE_REGIME"] };
  }
  return {
    direction: score > 0 ? "long" : "short",
    exposureRate: Math.min(0.5, 0.2 + (rust.liquidityQuality ?? 0) * 0.3),
    probability: Math.min(0.95, 0.5 + Math.abs(score) * 0.4),
    reasons: ["RUST_DIRECTIONAL_GATE"],
  };
}

function etfChoice(
  origin: HistoricalDecisionOrigin,
  state: LaneState,
): LaneChoice {
  const primary = primaryEvidence(origin);
  const selection = selectEtfPairDirection({
    mapping: origin.pairMapping,
    primaryAvailable: primary.length > 0,
    rustDataQuality: origin.rustEvidence
      ? origin.rustEvidence.blockedGates.length === 0 ? "good" : "degraded"
      : "unavailable",
    rustTechnicalSignal: origin.rustEvidence
      ? mean([
          origin.rustEvidence.trendScore ?? 0,
          origin.rustEvidence.momentumScore ?? 0,
        ]) > 0.1 ? 1
        : mean([
            origin.rustEvidence.trendScore ?? 0,
            origin.rustEvidence.momentumScore ?? 0,
          ]) < -0.1 ? -1 : 0
      : 0,
  });
  const gated = origin.etfSessionGate
    ? applyEtfSessionGate({
        proposedDirection: selection.direction,
        currentDirection: (
          ["bull", "bear", "cash"].includes(state.direction)
            ? state.direction
            : "cash"
        ) as EtfPairDirection,
        gate: origin.etfSessionGate,
      })
    : {
        direction: "cash" as const,
        reasons: ["ETF_SESSION_GATE_UNAVAILABLE"],
      };
  return {
    direction: gated.direction,
    exposureRate: gated.direction === "cash" ? 0 : 0.5,
    probability: gated.direction === "bull"
      ? selection.pNetBull
      : gated.direction === "bear" ? selection.pNetBear : undefined,
    reasons: [...selection.reasons, ...gated.reasons],
    unavailable: primary.length === 0,
  };
}

function finalChoice(
  input: HistoricalBacktestInput,
  origin: HistoricalDecisionOrigin,
  state: LaneState,
  primaryVetoOnly: boolean,
): LaneChoice {
  if (input.simulationCase === "us_etf_pair") return etfChoice(origin, state);
  const rust = primaryVetoOnly && origin.rustEvidence
    ? {
        ...origin.rustEvidence,
        blockedGates: [],
        quoteFreshnessMs: origin.rustEvidence.quoteFreshnessMs ?? 0,
      }
    : origin.rustEvidence;
  const costs = origin.costs;
  const decision = decideUnifiedSimulationPolicy({
    simulationCase: input.simulationCase,
    symbol: origin.signalSymbol,
    originAt: origin.originAt,
    modelPlan: origin.modelPlan,
    modelEvidence: origin.modelEvidence,
    rustEvidence: rust,
    costs,
    state: state.policyState,
    sizing: {
      equity: state.equity,
      volatilityTargetRate: 0.01,
      lossBudgetRate: 0.01,
      bookParticipationRate: 0.01,
      symbolExposureCapRate: input.simulationCase === "high_vol_crypto" ? 0.3 : 0.5,
      grossExposureCapRate: 0.75,
      marginUsageCapRate: 0.5,
      maximumLeverage: input.simulationCase === "high_vol_crypto" ? 2 : 1.5,
    },
    circuit: {
      dailyLossRate: 0,
      consecutiveLosses: 0,
      missingData: !rust,
      ...origin.circuit,
    },
    highVolatility: origin.highVolatility,
  });
  return {
    direction: decision.direction,
    exposureRate: Math.max(0, Math.min(2, decision.positionSizing.selectedRate)),
    probability: decision.direction === "long"
      ? decision.pNetLong ?? undefined
      : decision.direction === "short" ? decision.pNetShort ?? undefined : undefined,
    reasons: decision.reasons,
    unavailable: decision.reasons.includes("PRIMARY_MODEL_UNAVAILABLE"),
    unifiedDecision: decision,
  };
}

function choiceForLane(
  lane: HistoricalBacktestLane,
  input: HistoricalBacktestInput,
  origin: HistoricalDecisionOrigin,
  state: LaneState,
): LaneChoice {
  const stressedOrigin: HistoricalDecisionOrigin = {
    ...origin,
    costs: stressedCosts(origin.costs, input.costStressMultiplier),
    modelEvidence: origin.modelEvidence.map((evidence) => (
      evidenceAtCosts(
        evidence,
        stressedCosts(origin.costs, input.costStressMultiplier),
      )
    )),
  };
  if (
    input.simulationCase === "high_vol_crypto"
    && stressedOrigin.scannerSelectedSymbols
    && !stressedOrigin.scannerSelectedSymbols.includes(stressedOrigin.signalSymbol)
  ) {
    return {
      direction: "cash",
      exposureRate: 0,
      reasons: ["SCANNER_SYMBOL_NOT_SELECTED"],
    };
  }
  if (lane === "baseline_policy") {
    return {
      direction: stressedOrigin.baselineDirection,
      exposureRate: stressedOrigin.baselineDirection === "cash" ? 0 : 0.25,
      reasons: ["CAUSAL_EMA_BASELINE"],
    };
  }
  if (lane === "primary_only") return choosePrimaryOnly(stressedOrigin);
  if (lane === "rust_only") return chooseRustOnly(stressedOrigin);
  return finalChoice(input, stressedOrigin, state, lane === "primary_veto");
}

function executionSymbol(
  origin: HistoricalDecisionOrigin,
  direction: UnifiedDirection,
): string | null {
  if (direction === "cash") return null;
  return origin.executionSymbols[direction] ?? null;
}

function applyChoice(
  lane: HistoricalBacktestLane,
  input: HistoricalBacktestInput,
  origin: HistoricalDecisionOrigin,
  state: LaneState,
  choice: LaneChoice,
  fills: HistoricalFill[],
): void {
  const equityBeforeMark = state.equity;
  if (state.direction !== "cash" && state.executionSymbol) {
    const previousPrice = state.previousPrices[state.executionSymbol];
    const price = origin.pricesAtFill[state.executionSymbol];
    if (previousPrice && price) {
      const sign = state.direction === "short" ? -1 : 1;
      const grossRate = sign * (price / previousPrice - 1) * state.exposureRate;
      const grossPnl = state.equity * grossRate;
      state.grossPnl += grossPnl;
      state.openTradePnl += grossPnl;
      state.equity += grossPnl;
    }
  }
  const nextSymbol = executionSymbol(origin, choice.direction);
  let resolvedDirection = choice.direction;
  let resolvedExposure = choice.exposureRate;
  if (choice.direction !== "cash" && (
    !nextSymbol
    || !Number.isFinite(origin.pricesAtFill[nextSymbol])
    || origin.pricesAtFill[nextSymbol]! <= 0
  )) {
    resolvedDirection = "cash";
    resolvedExposure = 0;
    choice.reasons.push("NEXT_VALID_FILL_PRICE_UNAVAILABLE");
  }
  const changing = resolvedDirection !== state.direction
    || (resolvedDirection !== "cash" && nextSymbol !== state.executionSymbol);
  let transitionCost = 0;
  if (changing) {
    const directional = totalDirectionalCostRate(
      stressedCosts(origin.costs, input.costStressMultiplier),
    );
    const oldRate = state.direction === "short" ? directional.short : directional.long;
    const newRate = resolvedDirection === "short" ? directional.short : directional.long;
    const closeNotional = state.direction === "cash" ? 0 : state.equity * state.exposureRate;
    const openNotional = resolvedDirection === "cash" ? 0 : state.equity * resolvedExposure;
    transitionCost = closeNotional * oldRate / 2 + openNotional * newRate / 2;
    state.costs += transitionCost;
    state.equity -= transitionCost;
    state.openTradePnl -= transitionCost;
    state.turnoverNotional += closeNotional + openNotional;
    if (state.direction !== "cash") {
      const denominator = Math.max(state.openTradeNotional, Number.EPSILON);
      state.tradeReturns.push(state.openTradePnl / denominator);
      state.openTradePnl = 0;
      state.openTradeNotional = 0;
    }
    if (resolvedDirection !== "cash") {
      state.tradeCount += 1;
      state.openTradeNotional = openNotional;
      state.openTradePnl = -openNotional * newRate / 2;
    }
    fills.push({
      lane,
      originAt: origin.originAt,
      filledAt: origin.fillAt,
      direction: resolvedDirection,
      previousDirection: state.direction,
      executionSymbol: nextSymbol,
      price: nextSymbol ? origin.pricesAtFill[nextSymbol] ?? null : null,
      exposureRate: resolvedExposure,
      cost: transitionCost,
      reason: choice.reasons.join(","),
    });
    state.policyState = {
      ...state.policyState,
      currentDirection: resolvedDirection,
      ...(resolvedDirection === "cash"
        ? {
            lastExitAt: origin.fillAt,
            lastDirection: state.direction,
            positionOpenedAt: undefined,
          }
        : {
            positionOpenedAt: state.direction === resolvedDirection
              ? state.policyState.positionOpenedAt
              : origin.fillAt,
          }),
      tradeTimestamps: [
        ...state.policyState.tradeTimestamps,
        origin.fillAt,
      ].slice(-100),
      dailyTurnoverRate: state.turnoverNotional / input.initialEquity,
      ...(choice.unifiedDecision?.selectedHorizonMinutes
        ? {
            lastHorizonMinutes: choice.unifiedDecision.selectedHorizonMinutes,
            lastHorizonScore: choice.unifiedDecision.horizonScore ?? undefined,
          }
        : {}),
    };
  }
  state.direction = resolvedDirection;
  state.executionSymbol = resolvedDirection === "cash" ? null : nextSymbol;
  state.exposureRate = resolvedExposure;
  state.previousPrices = { ...origin.pricesAtFill };
  state.noTradeCount += Number(resolvedDirection === "cash");
  state.unavailableCount += Number(choice.unavailable === true);
  state.vetoCount += Number(choice.unifiedDecision?.veto.vetoed === true);
  state.exposureSamples.push(resolvedDirection === "cash" ? 0 : resolvedExposure);
  state.returns.push(equityBeforeMark <= 0 ? 0 : state.equity / equityBeforeMark - 1);
  state.equityCurve.push(state.equity);
  const actual = origin.actualTargetReturns?.[
    choice.unifiedDecision?.selectedHorizonMinutes as 5 | 15 | 30 | 60
  ] ?? origin.actualTargetReturns?.[15];
  if (choice.probability !== undefined && actual !== undefined && resolvedDirection !== "cash") {
    state.directionalPredictions.push({
      predicted: choice.probability,
      actual: (
        resolvedDirection === "short" || resolvedDirection === "bear"
          ? Number(actual < 0)
          : Number(actual > 0)
      ),
    });
  }
}

function maximumDrawdown(curve: readonly number[]): number {
  let peak = curve[0] ?? 0;
  let maximum = 0;
  for (const value of curve) {
    peak = Math.max(peak, value);
    if (peak > 0) maximum = Math.max(maximum, (peak - value) / peak);
  }
  return maximum;
}

function maximumConsecutiveLosses(values: readonly number[]): number {
  let current = 0;
  let maximum = 0;
  for (const value of values) {
    current = value < 0 ? current + 1 : 0;
    maximum = Math.max(maximum, current);
  }
  return maximum;
}

function lanePerformance(
  state: LaneState,
  input: HistoricalBacktestInput,
  periodsPerYear: number,
): HistoricalPerformanceMetrics {
  if (state.direction !== "cash" && state.openTradeNotional > 0) {
    state.tradeReturns.push(state.openTradePnl / state.openTradeNotional);
  }
  const average = mean(state.returns);
  const deviation = standardDeviation(state.returns);
  const downside = state.returns.filter((value) => value < 0);
  const downsideDeviation = Math.sqrt(mean(downside.map((value) => value ** 2)));
  const mdd = maximumDrawdown(state.equityCurve);
  const netReturn = state.equity / input.initialEquity - 1;
  const grossReturn = (input.initialEquity + state.grossPnl) / input.initialEquity - 1;
  const winners = state.tradeReturns.filter((value) => value > 0);
  const losers = state.tradeReturns.filter((value) => value < 0);
  const gains = winners.reduce((sum, value) => sum + value, 0);
  const losses = Math.abs(losers.reduce((sum, value) => sum + value, 0));
  return {
    grossReturn,
    netReturn,
    costDrag: state.costs / input.initialEquity,
    maximumDrawdown: mdd,
    sharpe: deviation > 0 ? average / deviation * Math.sqrt(periodsPerYear) : null,
    sortino: downsideDeviation > 0
      ? average / downsideDeviation * Math.sqrt(periodsPerYear)
      : null,
    calmar: mdd > 0 ? netReturn / mdd : null,
    turnover: state.turnoverNotional / input.initialEquity,
    tradeCount: state.tradeCount,
    winRate: state.tradeReturns.length ? winners.length / state.tradeReturns.length : null,
    profitFactor: losses > 0 ? gains / losses : gains > 0 ? Number.POSITIVE_INFINITY : null,
    averageTradeReturn: state.tradeReturns.length ? mean(state.tradeReturns) : null,
    p05TradeReturn: quantile(state.tradeReturns, 0.05),
    p95TradeReturn: quantile(state.tradeReturns, 0.95),
    maximumConsecutiveLosses: maximumConsecutiveLosses(state.tradeReturns),
    exposure: mean(state.exposureSamples),
    cashRatio: state.exposureSamples.length
      ? state.exposureSamples.filter((value) => value === 0).length / state.exposureSamples.length
      : 1,
    directionAccuracy: state.directionalPredictions.length
      ? mean(state.directionalPredictions.map((row) => Number(row.actual === Number(row.predicted >= 0.5))))
      : null,
    unavailableRatio: input.origins.length
      ? state.unavailableCount / input.origins.length
      : 1,
    vetoCount: state.vetoCount,
    noTradeCount: state.noTradeCount,
    totalCosts: state.costs,
    endingEquity: state.equity,
  };
}

function pinballLoss(actual: number, forecast: number, probability: number): number {
  const error = actual - forecast;
  return error >= 0 ? probability * error : (probability - 1) * error;
}

function modelMetrics(
  origins: readonly HistoricalDecisionOrigin[],
): HistoricalModelMetrics[] {
  const groups = new Map<string, Array<{ evidence: ModelEvidence; actual: number }>>();
  const availableOrigins = new Map<string, Set<string>>();
  const totalOrigins = origins.length;
  for (const origin of origins) {
    for (const evidence of origin.modelEvidence) {
      const actual = origin.actualTargetReturns?.[evidence.horizonMinutes];
      if (actual === undefined) continue;
      const key = `${evidence.modelLane}:${evidence.role}`;
      const rows = groups.get(key) ?? [];
      rows.push({ evidence, actual });
      groups.set(key, rows);
      const available = availableOrigins.get(key) ?? new Set<string>();
      available.add(origin.originAt);
      availableOrigins.set(key, available);
    }
  }
  const expectedKeys = new Set(origins.flatMap((origin) => (
    origin.modelPlan.map((plan) => `${plan.modelLane}:${plan.role}`)
  )));
  return [...expectedKeys].sort().map((key) => {
    const rows = groups.get(key) ?? [];
    const [modelLane, role] = key.split(":");
    const pinballs = rows.flatMap(({ evidence, actual }) => [
      pinballLoss(actual, evidence.q10Return, 0.1),
      pinballLoss(actual, evidence.q50Return, 0.5),
      pinballLoss(actual, evidence.q90Return, 0.9),
    ]);
    const coverages = rows.map(({ evidence, actual }) => (
      Number(actual >= evidence.q10Return && actual <= evidence.q90Return)
    ));
    const briers = rows.map(({ evidence, actual }) => {
      const probability = actual >= 0 ? evidence.pNetLong : evidence.pNetShort;
      return (probability - 1) ** 2;
    });
    const wis = rows.map(({ evidence, actual }) => {
      const interval = evidence.q90Return - evidence.q10Return;
      const lowerPenalty = actual < evidence.q10Return
        ? 10 * (evidence.q10Return - actual)
        : 0;
      const upperPenalty = actual > evidence.q90Return
        ? 10 * (actual - evidence.q90Return)
        : 0;
      return interval + lowerPenalty + upperPenalty
        + 0.5 * Math.abs(actual - evidence.q50Return);
    });
    return {
      modelLane: modelLane ?? "unknown",
      role: role ?? "unknown",
      observationCount: rows.length,
      directionAccuracy: rows.length
        ? mean(rows.map(({ evidence, actual }) => Number(
            (evidence.q50Return >= 0) === (actual >= 0),
          )))
        : null,
      brier: briers.length ? mean(briers) : null,
      pinball: pinballs.length ? mean(pinballs) : null,
      weightedIntervalScore: wis.length ? mean(wis) : null,
      intervalCoverage: coverages.length ? mean(coverages) : null,
      calibrationError: rows.length
        ? Math.abs(
            mean(rows.map(({ evidence }) => evidence.pNetLong))
            - mean(rows.map(({ actual }) => Number(actual > 0))),
          )
        : null,
      unavailableRatio: totalOrigins
        ? 1 - (availableOrigins.get(key)?.size ?? 0) / totalOrigins
        : 1,
      averageLatencyMs: rows.length
        ? mean(rows.map(({ evidence }) => evidence.latencyMs))
        : null,
    };
  });
}

function selectionStability(origins: readonly HistoricalDecisionOrigin[]): number | null {
  const selections = origins
    .map((origin) => origin.scannerSelectedSymbols)
    .filter((value): value is string[] => value !== undefined);
  if (selections.length < 2) return null;
  const scores: number[] = [];
  for (let index = 1; index < selections.length; index += 1) {
    const left = new Set(selections[index - 1]);
    const right = new Set(selections[index]);
    const union = new Set([...left, ...right]);
    if (union.size === 0) continue;
    const intersection = [...left].filter((symbol) => right.has(symbol));
    scores.push(intersection.length / union.size);
  }
  return scores.length ? mean(scores) : null;
}

export function runHistoricalSimulationBacktest(
  input: HistoricalBacktestInput,
): HistoricalBacktestResult {
  if (!Number.isSafeInteger(input.seed)) throw new Error("seed must be an integer.");
  if (!Number.isFinite(input.initialEquity) || input.initialEquity <= 0) {
    throw new Error("initialEquity must be positive.");
  }
  if (!Number.isFinite(input.costStressMultiplier) || input.costStressMultiplier <= 0) {
    throw new Error("costStressMultiplier must be positive.");
  }
  const origins = [...input.origins].sort(
    (left, right) => timestamp(left.originAt, "originAt") - timestamp(right.originAt, "originAt"),
  );
  for (let index = 0; index < origins.length; index += 1) {
    const origin = origins[index]!;
    if (timestamp(origin.fillAt, "fillAt") <= timestamp(origin.originAt, "originAt")) {
      throw new Error("fillAt must be strictly after originAt.");
    }
    if (
      index > 0
      && timestamp(origin.originAt, "originAt")
        <= timestamp(origins[index - 1]!.originAt, "previous.originAt")
    ) throw new Error("decision origins must be unique.");
    for (const evidence of origin.modelEvidence) {
      if (timestamp(evidence.originAt, "model.originAt") > timestamp(origin.originAt, "originAt")) {
        throw new Error("future model evidence is not allowed.");
      }
    }
    if (
      origin.rustEvidence
      && timestamp(origin.rustEvidence.observedAt, "rust.observedAt")
        > timestamp(origin.originAt, "originAt")
    ) throw new Error("future Rust evidence is not allowed.");
  }
  const started = performanceNow();
  const lanes = [
    "baseline_policy",
    "primary_only",
    "rust_only",
    "primary_veto",
    "final_policy",
  ] as const;
  const states = Object.fromEntries(
    lanes.map((lane) => [lane, initialLaneState(input.initialEquity)]),
  ) as Record<HistoricalBacktestLane, LaneState>;
  const decisions: HistoricalLaneDecision[] = [];
  const fills: HistoricalFill[] = [];
  for (const origin of origins) {
    for (const lane of lanes) {
      const state = states[lane];
      const choice = choiceForLane(lane, { ...input, origins }, origin, state);
      applyChoice(lane, { ...input, origins }, origin, state, choice, fills);
      decisions.push({
        lane,
        originAt: origin.originAt,
        fillAt: origin.fillAt,
        direction: state.direction,
        executionSymbol: state.executionSymbol,
        exposureRate: state.exposureRate,
        reasons: [...new Set(choice.reasons)],
        ...(choice.unifiedDecision ? { unifiedDecision: choice.unifiedDecision } : {}),
      });
    }
  }
  const diffs = origins.slice(1).map((origin, index) => (
    timestamp(origin.originAt, "originAt")
    - timestamp(origins[index]!.originAt, "previous.originAt")
  ));
  const medianDiff = quantile(diffs, 0.5) ?? 15 * 60_000;
  const periodsPerYear = 365.25 * 86_400_000 / Math.max(medianDiff, 60_000);
  const elapsedSeconds = Math.max((performanceNow() - started) / 1_000, 0.000001);
  return {
    schemaVersion: HISTORICAL_SIMULATION_BACKTEST_VERSION,
    simulationCase: input.simulationCase,
    symbol: input.symbol,
    seed: input.seed,
    initialEquity: input.initialEquity,
    costStressMultiplier: input.costStressMultiplier,
    originCount: origins.length,
    firstOriginAt: origins[0]?.originAt ?? null,
    lastOriginAt: origins.at(-1)?.originAt ?? null,
    lanes: Object.fromEntries(
      lanes.map((lane) => [
        lane,
        lanePerformance(states[lane], { ...input, origins }, periodsPerYear),
      ]),
    ) as Record<HistoricalBacktestLane, HistoricalPerformanceMetrics>,
    modelMetrics: modelMetrics(origins),
    scannerSelectionStability: selectionStability(origins),
    offlineThroughputOriginsPerSecond: origins.length / elapsedSeconds,
    decisions,
    fills,
    integrity: {
      finalizedDataOnly: true,
      originFillSeparated: true,
      sameBarRetroactiveFill: false,
      deterministic: true,
      pointInTimeTraining: true,
    },
  };
}

function performanceNow(): number {
  return typeof globalThis.performance === "undefined"
    ? Date.now()
    : globalThis.performance.now();
}

export function normalizeHistoricalBacktestArtifact(
  value: unknown,
): HistoricalBacktestResult | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Partial<HistoricalBacktestResult>;
  if (
    source.schemaVersion !== HISTORICAL_SIMULATION_BACKTEST_VERSION
    || !["btc_eth", "high_vol_crypto", "us_etf_pair"].includes(
      source.simulationCase ?? "",
    )
    || typeof source.symbol !== "string"
    || !Number.isSafeInteger(source.seed)
    || !Number.isFinite(source.originCount)
    || !source.lanes
    || !Array.isArray(source.decisions)
    || !Array.isArray(source.fills)
  ) return undefined;
  return source as HistoricalBacktestResult;
}
