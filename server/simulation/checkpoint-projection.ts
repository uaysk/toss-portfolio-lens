import type {
  SimulationCheckpointPatchOperationV2,
  SimulationCheckpointPathSegmentV2,
} from "./checkpoint-contracts.js";

type UnknownRecord = Record<string, unknown>;

export type SimulationCheckpointScalarState = {
  schemaVersion?: string;
  phase?: string;
  createdAt?: string;
  startedAt?: string;
  expiresAt?: string;
  market?: string;
  marketCountry?: string;
  currency?: string;
  initialCash?: number;
  cash?: number;
  equity?: number;
  invested?: number;
  realizedPnl?: number;
  totalCosts?: number;
  progress?: number;
  decisionCount: number;
  tradeCount: number;
};

export type SimulationCheckpointCursor = {
  decisionAppendCount: number;
  decisionLength: number;
  tradeAppendCount: number;
  tradeLength: number;
  equityAppendCount: number;
  equityLength: number;
  provenanceAppendCount: number;
  provenanceLength: number;
  chartRevision: number;
  comparisonRevision: number;
  snapshotKeys: Set<string>;
  snapshotValues: Map<string, unknown>;
};

export type SimulationCheckpointProjection = {
  snapshot: UnknownRecord;
  decisions: readonly unknown[];
  decisionAppendCount: number;
  trades: readonly unknown[];
  tradeAppendCount: number;
  equity: readonly unknown[];
  equityAppendCount: number;
  provenance?: readonly unknown[];
  provenanceAppendCount: number;
  charts: readonly unknown[];
  chartRevision: number;
  comparison?: unknown;
  comparisonRevision: number;
  dirtyDecisionIndexes: ReadonlySet<number>;
  dirtyProvenanceIndexes: ReadonlySet<number>;
  selection: unknown;
};

export function checkpointScalarState(
  snapshot: UnknownRecord,
): SimulationCheckpointScalarState {
  const stringValue = (key: string): string | undefined => (
    typeof snapshot[key] === "string" ? snapshot[key] : undefined
  );
  const numberValue = (key: string): number | undefined => (
    typeof snapshot[key] === "number" && Number.isFinite(snapshot[key])
      ? snapshot[key] as number
      : undefined
  );
  return {
    ...(stringValue("schemaVersion") ? { schemaVersion: stringValue("schemaVersion") } : {}),
    ...(stringValue("phase") ? { phase: stringValue("phase") } : {}),
    ...(stringValue("createdAt") ? { createdAt: stringValue("createdAt") } : {}),
    ...(stringValue("startedAt") ? { startedAt: stringValue("startedAt") } : {}),
    ...(stringValue("expiresAt") ? { expiresAt: stringValue("expiresAt") } : {}),
    ...(stringValue("market") ? { market: stringValue("market") } : {}),
    ...(stringValue("marketCountry") ? { marketCountry: stringValue("marketCountry") } : {}),
    ...(stringValue("currency") ? { currency: stringValue("currency") } : {}),
    ...(numberValue("initialCash") !== undefined
      ? { initialCash: numberValue("initialCash") } : {}),
    ...(numberValue("cash") !== undefined ? { cash: numberValue("cash") } : {}),
    ...(numberValue("equity") !== undefined ? { equity: numberValue("equity") } : {}),
    ...(numberValue("invested") !== undefined ? { invested: numberValue("invested") } : {}),
    ...(numberValue("realizedPnl") !== undefined
      ? { realizedPnl: numberValue("realizedPnl") } : {}),
    ...(numberValue("totalCosts") !== undefined
      ? { totalCosts: numberValue("totalCosts") } : {}),
    ...(numberValue("progress") !== undefined ? { progress: numberValue("progress") } : {}),
    decisionCount: Array.isArray(snapshot.decisions) ? snapshot.decisions.length : 0,
    tradeCount: Array.isArray(snapshot.trades) ? snapshot.trades.length : 0,
  };
}

function snapshotValues(snapshot: UnknownRecord): Map<string, unknown> {
  return new Map(Object.entries(snapshot));
}

export function createSimulationCheckpointCursor(
  projection: SimulationCheckpointProjection,
): SimulationCheckpointCursor {
  const currentSnapshotValues = snapshotValues(projection.snapshot);
  return {
    decisionAppendCount: projection.decisionAppendCount,
    decisionLength: projection.decisions.length,
    tradeAppendCount: projection.tradeAppendCount,
    tradeLength: projection.trades.length,
    equityAppendCount: projection.equityAppendCount,
    equityLength: projection.equity.length,
    provenanceAppendCount: projection.provenanceAppendCount,
    provenanceLength: projection.provenance?.length ?? 0,
    chartRevision: projection.chartRevision,
    comparisonRevision: projection.comparisonRevision,
    snapshotKeys: new Set(currentSnapshotValues.keys()),
    snapshotValues: currentSnapshotValues,
  };
}

function appendRollingArrayPatch(
  operations: SimulationCheckpointPatchOperationV2[],
  path: SimulationCheckpointPathSegmentV2[],
  values: readonly unknown[],
  appendCount: number,
  cursorAppendCount: number,
  cursorLength: number,
): void {
  const appended = appendCount - cursorAppendCount;
  const removed = cursorLength + appended - values.length;
  if (!Number.isSafeInteger(appended)
    || appended < 0
    || appended > values.length
    || !Number.isSafeInteger(removed)
    || removed < 0
    || removed > cursorLength) {
    throw new Error(`simulation checkpoint append cursor가 어긋났습니다: ${path.join(".")}`);
  }
  if (removed) {
    operations.push({
      op: "splice",
      path,
      index: 0,
      deleteCount: removed,
      values: [],
    });
  }
  if (appended) {
    operations.push({
      op: "splice",
      path,
      index: cursorLength - removed,
      deleteCount: 0,
      values: values.slice(values.length - appended),
    });
  }
}

export function createSimulationCheckpointPatch(
  projection: SimulationCheckpointProjection,
  cursor: SimulationCheckpointCursor,
): {
  operations: SimulationCheckpointPatchOperationV2[];
  nextCursor: SimulationCheckpointCursor;
} {
  const operations: SimulationCheckpointPatchOperationV2[] = [];
  const currentSnapshotValues = snapshotValues(projection.snapshot);
  const cumulativeKeys = new Set(["decisions", "trades", "charts", "strategyComparison"]);
  for (const [key, value] of currentSnapshotValues) {
    if (cumulativeKeys.has(key) || Object.is(cursor.snapshotValues.get(key), value)) continue;
    operations.push({ op: "set", path: ["snapshot", key], value });
  }
  for (const key of cursor.snapshotKeys) {
    if (cumulativeKeys.has(key) || currentSnapshotValues.has(key)) continue;
    operations.push({ op: "delete", path: ["snapshot", key] });
  }
  if (projection.chartRevision !== cursor.chartRevision) {
    operations.push({
      op: "set",
      path: ["snapshot", "charts"],
      value: projection.charts,
    });
  }
  if (projection.comparisonRevision !== cursor.comparisonRevision) {
    if (projection.comparison === undefined) {
      operations.push(
        { op: "delete", path: ["snapshot", "strategyComparison"] },
        { op: "delete", path: ["comparison"] },
      );
    } else {
      operations.push(
        {
          op: "set",
          path: ["snapshot", "strategyComparison"],
          value: projection.comparison,
        },
        { op: "set", path: ["comparison"], value: projection.comparison },
      );
    }
  }
  appendRollingArrayPatch(
    operations,
    ["snapshot", "decisions"],
    projection.decisions,
    projection.decisionAppendCount,
    cursor.decisionAppendCount,
    cursor.decisionLength,
  );
  appendRollingArrayPatch(
    operations,
    ["snapshot", "trades"],
    projection.trades,
    projection.tradeAppendCount,
    cursor.tradeAppendCount,
    cursor.tradeLength,
  );
  appendRollingArrayPatch(
    operations,
    ["equity"],
    projection.equity,
    projection.equityAppendCount,
    cursor.equityAppendCount,
    cursor.equityLength,
  );
  if (projection.provenance) {
    appendRollingArrayPatch(
      operations,
      ["provenance"],
      projection.provenance,
      projection.provenanceAppendCount,
      cursor.provenanceAppendCount,
      cursor.provenanceLength,
    );
  }
  for (const index of projection.dirtyDecisionIndexes) {
    const value = projection.decisions[index];
    if (value !== undefined) {
      operations.push({ op: "set", path: ["snapshot", "decisions", index], value });
    }
  }
  for (const index of projection.dirtyProvenanceIndexes) {
    const value = projection.provenance?.[index];
    if (value !== undefined) {
      operations.push({ op: "set", path: ["provenance", index], value });
    }
  }
  operations.push({ op: "set", path: ["selection"], value: projection.selection });
  return {
    operations,
    nextCursor: createSimulationCheckpointCursor(projection),
  };
}
