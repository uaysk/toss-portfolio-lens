import { describe, expect, it } from "vitest";
import {
  calculateCadenceTick,
  planDecisionTimer,
  reduceDecisionQueueTick,
  transitionSimulationPhase,
} from "./session-state.js";

describe("simulation phase reducer", () => {
  it("accepts only the lifecycle transitions used by a forward session", () => {
    expect(transitionSimulationPhase("selecting", "selection_ready")).toMatchObject({
      accepted: true,
      phase: "running",
    });
    expect(transitionSimulationPhase("running", "begin_finalization")).toMatchObject({
      accepted: true,
      phase: "finalizing",
    });
    expect(transitionSimulationPhase("finalizing", "complete")).toMatchObject({
      accepted: true,
      phase: "completed",
    });
    expect(transitionSimulationPhase("finalizing", "cancel")).toMatchObject({
      accepted: true,
      phase: "cancelled",
    });
    expect(transitionSimulationPhase("finalizing", "fail")).toMatchObject({
      accepted: true,
      phase: "failed",
    });
  });

  it("rejects stale callbacks and duplicate terminal transitions", () => {
    expect(transitionSimulationPhase("selecting", "complete")).toMatchObject({
      accepted: false,
      phase: "selecting",
    });
    expect(transitionSimulationPhase("finalizing", "selection_ready")).toMatchObject({
      accepted: false,
      phase: "finalizing",
    });
    expect(transitionSimulationPhase("cancelled", "begin_finalization")).toMatchObject({
      accepted: false,
      phase: "cancelled",
    });
  });

  it("lets a persisted cancellation intent win a completion race", () => {
    expect(transitionSimulationPhase("completed", "cancel")).toMatchObject({
      accepted: true,
      phase: "cancelled",
    });
  });
});

describe("simulation cadence reducer", () => {
  it("anchors a late callback to the latest elapsed wall-clock tick", () => {
    expect(calculateCadenceTick(1_000, 3_501, 1_000)).toEqual({
      missedTicks: 2,
      effectiveScheduledAtMs: 3_000,
      nextScheduledAtMs: 4_000,
    });
    expect(calculateCadenceTick(1_000, 999, 1_000)).toEqual({
      missedTicks: 0,
      effectiveScheduledAtMs: 1_000,
      nextScheduledAtMs: 2_000,
    });
  });

  it("plans timers without scheduling at or beyond session expiry", () => {
    expect(planDecisionTimer(2_000, 1_250, 3_000)).toEqual({
      status: "scheduled",
      delayMs: 750,
    });
    expect(planDecisionTimer(3_000, 1_250, 3_000)).toEqual({
      status: "at_or_after_expiry",
    });
    expect(planDecisionTimer(Number.NaN, 1_250)).toEqual({ status: "invalid" });
  });

  it("coalesces one tick while analysis runs and skips further duplicates", () => {
    expect(reduceDecisionQueueTick({
      analysisRunning: false,
      analysisQueued: false,
    })).toMatchObject({
      shouldStartRunner: true,
      analysisRunning: true,
      analysisQueued: true,
      coalescedTickDelta: 0,
      skippedTickDelta: 0,
    });
    expect(reduceDecisionQueueTick({
      analysisRunning: true,
      analysisQueued: false,
    })).toMatchObject({
      shouldStartRunner: false,
      coalescedTickDelta: 1,
      skippedTickDelta: 0,
    });
    expect(reduceDecisionQueueTick({
      analysisRunning: true,
      analysisQueued: true,
    })).toMatchObject({
      shouldStartRunner: false,
      coalescedTickDelta: 0,
      skippedTickDelta: 1,
    });
  });
});
