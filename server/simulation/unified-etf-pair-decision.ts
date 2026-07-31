import type {
  PairEnsembleDecision,
  PairEnsembleInput,
} from "./ensemble-policy.js";
import {
  applyEtfSessionGate,
  selectEtfPairDirection,
  type EtfSessionGate,
  type PairReturnMapping,
} from "./pair-return-mapper.js";

export type UnifiedEtfPairDecisionContext = {
  pairMapping: PairReturnMapping;
  selectedHorizonMinutes: number;
  sessionGate: EtfSessionGate;
};

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

/**
 * Projects the base Chronos-2/Rust ensemble decision onto executable ETF
 * returns and the regular-session gate. Keeping this transformation pure lets
 * forward execution and provenance replay use exactly the same policy.
 */
export function projectUnifiedEtfPairDecision(
  ensembleInput: PairEnsembleInput,
  baseDecision: PairEnsembleDecision,
  context: UnifiedEtfPairDecisionContext,
): PairEnsembleDecision {
  const { models, rust, currentDirection, pair } = ensembleInput;
  const directionSelection = selectEtfPairDirection({
    mapping: context.pairMapping,
    primaryAvailable: models.chronos2.status === "available",
    rustDataQuality: rust.dataQuality === "good"
      ? "good"
      : rust.dataQuality === "unavailable" ? "unavailable" : "degraded",
    rustTechnicalSignal: rust.technicalSignal ?? 0,
  });
  const { pNetBull, pNetBear } = directionSelection;
  const sessionSelection = applyEtfSessionGate({
    proposedDirection: directionSelection.direction,
    currentDirection,
    gate: context.sessionGate,
  });
  const direction = sessionSelection.direction;
  const executionSymbol = direction === "cash"
    ? null
    : pair[direction].executionSymbol;
  const mappingLeg = direction === "cash"
    ? undefined
    : context.pairMapping[direction] ?? undefined;
  const decisionKind: PairEnsembleDecision["decisionKind"] = direction === "cash"
    ? currentDirection === "cash" ? "cash" : "exit"
    : currentDirection === "cash" ? "enter"
      : currentDirection === direction ? "hold" : "switch";
  const mappingReasons = context.pairMapping.status === "ready"
    ? [
        "pair_return_mapper_ready",
        `selected_horizon_${context.selectedHorizonMinutes}m`,
        `pnet_bull_${pNetBull.toFixed(4)}`,
        `pnet_bear_${pNetBear.toFixed(4)}`,
      ]
    : ["pair_return_mapper_warming_up"];

  return {
    ...baseDecision,
    direction,
    executionSymbol,
    leverageMultiplier: direction === "cash"
      ? 0
      : pair[direction].leverageMultiplier,
    decisionKind,
    degraded: models.chronos2.status !== "available"
      || context.pairMapping.status !== "ready",
    exposureScale: direction === "cash" ? 0 : baseDecision.exposureScale,
    reasonCodes: unique([
      ...mappingReasons,
      ...directionSelection.reasons,
      ...sessionSelection.reasons,
    ]),
    componentScores: {
      ...baseDecision.componentScores,
      chronos2: {
        ...baseDecision.componentScores.chronos2,
        bull: pNetBull,
        bear: pNetBear,
        bullNetExpectedReturn: context.pairMapping.bull?.expectedNetReturn ?? 0,
        bearNetExpectedReturn: context.pairMapping.bear?.expectedNetReturn ?? 0,
        bullProbability: pNetBull,
        bearProbability: pNetBear,
        leveragedUncertainty: mappingLeg
          ? mappingLeg.q90Return - mappingLeg.q10Return
          : 0,
        preferredDirection: direction,
      },
    },
    finalScores: {
      bull: pNetBull,
      bear: pNetBear,
      cash: direction === "cash" ? 1 : 0,
    },
    scoreMargin: Math.abs(pNetBull - pNetBear),
    costs: {
      bullRoundTripRate: (context.pairMapping.bull?.totalCostBps ?? 0) / 10_000,
      bearRoundTripRate: (context.pairMapping.bear?.totalCostBps ?? 0) / 10_000,
      switchCostApplied: decisionKind === "switch",
    },
  };
}
