export type SimulationPhase =
  | "selecting"
  | "running"
  | "finalizing"
  | "completed"
  | "cancelled"
  | "failed";

export type SimulationPhaseEvent =
  | "selection_ready"
  | "begin_finalization"
  | "complete"
  | "cancel"
  | "fail";

export type SimulationPhaseTransition =
  | {
      accepted: true;
      previous: SimulationPhase;
      phase: SimulationPhase;
      event: SimulationPhaseEvent;
    }
  | {
      accepted: false;
      previous: SimulationPhase;
      phase: SimulationPhase;
      event: SimulationPhaseEvent;
    };

const PHASE_TRANSITIONS: Readonly<
  Partial<Record<SimulationPhase, Partial<Record<SimulationPhaseEvent, SimulationPhase>>>>
> = {
  selecting: {
    selection_ready: "running",
    begin_finalization: "finalizing",
  },
  running: {
    begin_finalization: "finalizing",
  },
  finalizing: {
    complete: "completed",
    cancel: "cancelled",
    fail: "failed",
  },
  // A cancellation persisted while completion is being committed must still
  // win before the run reaches a durable completed state.
  completed: {
    cancel: "cancelled",
  },
};

export function transitionSimulationPhase(
  phase: SimulationPhase,
  event: SimulationPhaseEvent,
): SimulationPhaseTransition {
  const next = PHASE_TRANSITIONS[phase]?.[event];
  return next === undefined
    ? { accepted: false, previous: phase, phase, event }
    : { accepted: true, previous: phase, phase: next, event };
}

export type CadenceTick = {
  missedTicks: number;
  effectiveScheduledAtMs: number;
  nextScheduledAtMs: number;
};

export function calculateCadenceTick(
  scheduledAtMs: number,
  observedAtMs: number,
  intervalMs: number,
): CadenceTick {
  if (!Number.isFinite(scheduledAtMs) || !Number.isFinite(observedAtMs)
    || !Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new TypeError("Cadence timestamps must be finite and intervalMs must be positive.");
  }
  const missedTicks = Math.max(0, Math.floor((observedAtMs - scheduledAtMs) / intervalMs));
  const effectiveScheduledAtMs = scheduledAtMs + missedTicks * intervalMs;
  return {
    missedTicks,
    effectiveScheduledAtMs,
    nextScheduledAtMs: effectiveScheduledAtMs + intervalMs,
  };
}

export type DecisionTimerPlan =
  | { status: "scheduled"; delayMs: number }
  | { status: "invalid" | "at_or_after_expiry" };

export function planDecisionTimer(
  scheduledAtMs: number,
  observedAtMs: number,
  expiresAtMs?: number,
): DecisionTimerPlan {
  if (!Number.isFinite(scheduledAtMs) || !Number.isFinite(observedAtMs)
    || (expiresAtMs !== undefined && !Number.isFinite(expiresAtMs))) {
    return { status: "invalid" };
  }
  if (expiresAtMs !== undefined && scheduledAtMs >= expiresAtMs) {
    return { status: "at_or_after_expiry" };
  }
  return {
    status: "scheduled",
    delayMs: Math.max(0, scheduledAtMs - observedAtMs),
  };
}

export type DecisionQueueTick = {
  analysisQueued: true;
  analysisRunning: boolean;
  shouldStartRunner: boolean;
  scheduledTickDelta: 1;
  coalescedTickDelta: 0 | 1;
  skippedTickDelta: 0 | 1;
};

export function reduceDecisionQueueTick(input: {
  analysisRunning: boolean;
  analysisQueued: boolean;
}): DecisionQueueTick {
  if (!input.analysisRunning) {
    return {
      analysisQueued: true,
      analysisRunning: true,
      shouldStartRunner: true,
      scheduledTickDelta: 1,
      coalescedTickDelta: 0,
      skippedTickDelta: 0,
    };
  }
  return {
    analysisQueued: true,
    analysisRunning: true,
    shouldStartRunner: false,
    scheduledTickDelta: 1,
    coalescedTickDelta: input.analysisQueued ? 0 : 1,
    skippedTickDelta: input.analysisQueued ? 1 : 0,
  };
}
