import { describe, expect, it } from "vitest";
import {
  SIMULATION_RUN_FALLBACK_INITIAL_MS,
  SIMULATION_RUN_FALLBACK_MAX_MS,
  isStaleSimulationRunRevision,
  mergeSimulationRunEvent,
  nextSimulationRunFallbackDelay,
  parseSimulationRunMessage,
  simulationRunEventsUrl,
  structurallyShare,
  type SimulationRunEventV1,
} from "./simulation-run-events";
import type { AiSimulationRunResponse } from "./ai-simulation";

function event(
  revision: number,
  type: SimulationRunEventV1["type"],
  payload: unknown,
): SimulationRunEventV1 {
  return {
    schemaVersion: 1,
    runId: "run / one",
    revision,
    emittedAt: "2026-07-30T00:00:00.000Z",
    type,
    payload,
  };
}

const current: AiSimulationRunResponse = {
  runId: "run / one",
  status: "running",
  snapshot: {
    phase: "running",
    currency: "USD",
    initialCash: 100,
    cash: 40,
    equity: 101,
    progress: 0.25,
    selected: [],
    positions: [],
    charts: [{
      symbol: "SOXL",
      name: undefined,
      currency: "USD",
      bars: [],
      indicators: [],
      patterns: [],
      updatedAt: undefined,
    }],
    trades: [],
    decisions: [],
    kronosForecasts: [],
    warnings: [],
    capabilities: {},
    futuresPositions: [],
    modelLanes: [],
    modelEvidence: [],
    unifiedPolicyDecisions: [],
  },
};

describe("simulation run events", () => {
  it("parses the v1 envelope and rejects malformed or unsupported input", () => {
    expect(parseSimulationRunMessage(JSON.stringify(event(3, "progress", { progress: 0.5 }))))
      .toMatchObject({ runId: "run / one", revision: 3, type: "progress" });
    expect(parseSimulationRunMessage("{")).toBeUndefined();
    expect(parseSimulationRunMessage(JSON.stringify({
      ...event(3, "progress", {}),
      schemaVersion: 2,
    }))).toBeUndefined();
    expect(parseSimulationRunMessage(JSON.stringify(event(0, "progress", {}))))
      .toBeUndefined();
  });

  it("encodes the event endpoint and rejects duplicate or older revisions", () => {
    expect(simulationRunEventsUrl("run / one"))
      .toBe("/api/portfolio/simulation/runs/run%20%2F%20one/events");
    expect(simulationRunEventsUrl("run / one", 4))
      .toBe("/api/portfolio/simulation/runs/run%20%2F%20one/events?lastEventId=4");
    expect(isStaleSimulationRunRevision(event(4, "changed", {}), {
      runId: "run / one",
      revision: 4,
    })).toBe(true);
    expect(isStaleSimulationRunRevision(event(5, "changed", {}), {
      runId: "run / one",
      revision: 4,
    })).toBe(false);
  });

  it("merges lightweight progress while retaining unchanged chart references", () => {
    const next = mergeSimulationRunEvent(current, event(2, "progress", {
      progress: 0.5,
      equity: 102,
    }));

    expect(next?.snapshot).toMatchObject({ progress: 0.5, equity: 102, cash: 40 });
    expect(next?.snapshot?.charts).toBe(current.snapshot?.charts);
    expect(next?.snapshot?.charts[0]).toBe(current.snapshot?.charts[0]);
  });

  it("accepts a full terminal response and shares equal nested history", () => {
    const next = mergeSimulationRunEvent(current, event(3, "terminal", {
      runId: "run / one",
      status: "completed",
      snapshot: {
        ...current.snapshot,
        phase: "completed",
        progress: 1,
      },
    }));

    expect(next?.status).toBe("completed");
    expect(next?.snapshot?.phase).toBe("completed");
    expect(next?.snapshot?.charts).toBe(current.snapshot?.charts);
  });

  it("uses bounded exponential fallback and resets after a successful poll", () => {
    expect(nextSimulationRunFallbackDelay(SIMULATION_RUN_FALLBACK_INITIAL_MS, false))
      .toBe(10_000);
    expect(nextSimulationRunFallbackDelay(20_000, false))
      .toBe(SIMULATION_RUN_FALLBACK_MAX_MS);
    expect(nextSimulationRunFallbackDelay(SIMULATION_RUN_FALLBACK_MAX_MS, true))
      .toBe(SIMULATION_RUN_FALLBACK_INITIAL_MS);
  });

  it("returns the previous tree when values are deeply equal", () => {
    const previous = { scalar: 1, nested: [{ value: "same" }] };
    const shared = structurallyShare(previous, { scalar: 1, nested: [{ value: "same" }] });
    expect(shared).toBe(previous);
  });
});
