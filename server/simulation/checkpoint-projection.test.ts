import { describe, expect, it } from "vitest";
import {
  checkpointScalarState,
  createSimulationCheckpointCursor,
  createSimulationCheckpointPatch,
  type SimulationCheckpointProjection,
} from "./checkpoint-projection.js";

function projection(
  overrides: Partial<SimulationCheckpointProjection> = {},
): SimulationCheckpointProjection {
  return {
    snapshot: {
      phase: "running",
      cash: 100,
      expiresAt: "2026-07-31T01:00:00.000Z",
      decisions: [{ id: "decision-1" }],
      trades: [],
      charts: [{ symbol: "AAA" }],
      strategyComparison: { revision: 1 },
    },
    decisions: [{ id: "decision-1" }],
    decisionAppendCount: 1,
    trades: [],
    tradeAppendCount: 0,
    equity: [{ equity: 100 }],
    equityAppendCount: 1,
    provenance: [{ id: "provenance-1" }],
    provenanceAppendCount: 1,
    charts: [{ symbol: "AAA" }],
    chartRevision: 1,
    comparison: { revision: 1 },
    comparisonRevision: 1,
    dirtyDecisionIndexes: new Set(),
    dirtyProvenanceIndexes: new Set(),
    selection: { selected: ["AAA"] },
    ...overrides,
  };
}

describe("simulation checkpoint projection", () => {
  it("projects scalar state without retaining non-finite or nested values", () => {
    expect(checkpointScalarState({
      schemaVersion: "ai-paper-simulation/v9",
      phase: "running",
      market: { kind: "stock", country: "US" },
      marketCountry: "US",
      cash: 100,
      equity: Number.NaN,
      decisions: [{ id: 1 }, { id: 2 }],
      trades: [{ id: 1 }],
    })).toEqual({
      schemaVersion: "ai-paper-simulation/v9",
      phase: "running",
      marketCountry: "US",
      cash: 100,
      decisionCount: 2,
      tradeCount: 1,
    });
  });

  it("emits deterministic delta operations for append, mutation, and projection changes", () => {
    const cursor = createSimulationCheckpointCursor(projection());
    const updated = projection({
      snapshot: {
        phase: "running",
        cash: 80,
        decisions: [
          { id: "decision-1", sizing: 0.5 },
          { id: "decision-2" },
        ],
        trades: [{ id: "trade-1" }],
        charts: [{ symbol: "AAA", bars: 2 }],
        strategyComparison: { revision: 2 },
      },
      decisions: [
        { id: "decision-1", sizing: 0.5 },
        { id: "decision-2" },
      ],
      decisionAppendCount: 2,
      trades: [{ id: "trade-1" }],
      tradeAppendCount: 1,
      equity: [{ equity: 100 }, { equity: 80 }],
      equityAppendCount: 2,
      provenance: [
        { id: "provenance-1", sizing: 0.5 },
        { id: "provenance-2" },
      ],
      provenanceAppendCount: 2,
      charts: [{ symbol: "AAA", bars: 2 }],
      chartRevision: 2,
      comparison: { revision: 2 },
      comparisonRevision: 2,
      dirtyDecisionIndexes: new Set([0]),
      dirtyProvenanceIndexes: new Set([0]),
      selection: { selected: ["AAA"], revision: 2 },
    });

    const patch = createSimulationCheckpointPatch(updated, cursor);

    expect(patch.operations).toEqual([
      { op: "set", path: ["snapshot", "cash"], value: 80 },
      { op: "delete", path: ["snapshot", "expiresAt"] },
      {
        op: "set",
        path: ["snapshot", "charts"],
        value: [{ symbol: "AAA", bars: 2 }],
      },
      {
        op: "set",
        path: ["snapshot", "strategyComparison"],
        value: { revision: 2 },
      },
      { op: "set", path: ["comparison"], value: { revision: 2 } },
      {
        op: "splice",
        path: ["snapshot", "decisions"],
        index: 1,
        deleteCount: 0,
        values: [{ id: "decision-2" }],
      },
      {
        op: "splice",
        path: ["snapshot", "trades"],
        index: 0,
        deleteCount: 0,
        values: [{ id: "trade-1" }],
      },
      {
        op: "splice",
        path: ["equity"],
        index: 1,
        deleteCount: 0,
        values: [{ equity: 80 }],
      },
      {
        op: "splice",
        path: ["provenance"],
        index: 1,
        deleteCount: 0,
        values: [{ id: "provenance-2" }],
      },
      {
        op: "set",
        path: ["snapshot", "decisions", 0],
        value: { id: "decision-1", sizing: 0.5 },
      },
      {
        op: "set",
        path: ["provenance", 0],
        value: { id: "provenance-1", sizing: 0.5 },
      },
      {
        op: "set",
        path: ["selection"],
        value: { selected: ["AAA"], revision: 2 },
      },
    ]);
    expect(patch.nextCursor).toMatchObject({
      decisionAppendCount: 2,
      decisionLength: 2,
      tradeAppendCount: 1,
      equityAppendCount: 2,
      provenanceAppendCount: 2,
      chartRevision: 2,
      comparisonRevision: 2,
    });
  });

  it("prunes rolling prefixes and fails closed on an invalid append cursor", () => {
    const initial = projection({
      snapshot: { decisions: [{ id: "a" }, { id: "b" }, { id: "c" }] },
      decisions: [{ id: "a" }, { id: "b" }, { id: "c" }],
      decisionAppendCount: 3,
    });
    const cursor = createSimulationCheckpointCursor(initial);
    const rolled = projection({
      snapshot: { decisions: [{ id: "b" }, { id: "c" }, { id: "d" }] },
      decisions: [{ id: "b" }, { id: "c" }, { id: "d" }],
      decisionAppendCount: 4,
    });
    const operations = createSimulationCheckpointPatch(rolled, cursor).operations
      .filter(({ path }) => path.join(".") === "snapshot.decisions");

    expect(operations).toEqual([
      {
        op: "splice",
        path: ["snapshot", "decisions"],
        index: 0,
        deleteCount: 1,
        values: [],
      },
      {
        op: "splice",
        path: ["snapshot", "decisions"],
        index: 2,
        deleteCount: 0,
        values: [{ id: "d" }],
      },
    ]);

    expect(() => createSimulationCheckpointPatch(
      projection({
        snapshot: { decisions: [{ id: "a" }, { id: "b" }] },
        decisions: [{ id: "a" }, { id: "b" }],
        decisionAppendCount: 2,
      }),
      cursor,
    )).toThrow("simulation checkpoint append cursor가 어긋났습니다");
  });
});
