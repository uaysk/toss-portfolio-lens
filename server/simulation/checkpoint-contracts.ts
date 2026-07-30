export const SIMULATION_CHECKPOINT_SCHEMA_VERSION = "simulation-checkpoint/v2" as const;
export const SIMULATION_CHECKPOINT_MAX_EVENTS = 256;
export const SIMULATION_CHECKPOINT_MAX_CHUNK_BYTES = 1024 * 1024;
export const SIMULATION_CHECKPOINT_FLUSH_INTERVAL_MS = 5_000;

export type SimulationCheckpointEventTypeV2 =
  | "snapshot"
  | "changed"
  | "progress"
  | "fill"
  | "terminal";

export type SimulationCheckpointPathSegmentV2 = string | number;

export type SimulationCheckpointPatchOperationV2 =
  | {
      op: "set";
      path: SimulationCheckpointPathSegmentV2[];
      value: unknown;
    }
  | {
      op: "delete";
      path: SimulationCheckpointPathSegmentV2[];
    }
  | {
      op: "truncate";
      path: SimulationCheckpointPathSegmentV2[];
      length: number;
    }
  | {
      op: "splice";
      path: SimulationCheckpointPathSegmentV2[];
      index: number;
      deleteCount: number;
      values: unknown[];
    };

export type SimulationCheckpointEventV2 = {
  schemaVersion: typeof SIMULATION_CHECKPOINT_SCHEMA_VERSION;
  revision: number;
  type: SimulationCheckpointEventTypeV2;
  occurredAt: number;
  operations: SimulationCheckpointPatchOperationV2[];
};

export type SimulationCheckpointChunkReferenceV2 = {
  seq: number;
  firstRevision: number;
  lastRevision: number;
  eventCount: number;
  byteCount: number;
  previousChecksum: string | null;
  checksum: string;
  createdAt: number;
};

export type SimulationCheckpointManifestV2<TScalar = unknown> = {
  schemaVersion: typeof SIMULATION_CHECKPOINT_SCHEMA_VERSION;
  runId: string;
  /** Monotonically increasing persisted chunk sequence. */
  seq: number;
  /** Monotonically increasing revision of the last persisted event. */
  revision: number;
  /** Checksum of the immediately preceding persisted manifest revision. */
  previousChecksum: string | null;
  checksum: string;
  base: {
    byteCount: number;
    checksum: string;
  };
  /**
   * Bounded tail reference. Older immutable references live in the chunk
   * table and are verified through the checksum chain during replay.
   */
  chunks: SimulationCheckpointChunkReferenceV2[];
  scalarState: TScalar;
  createdAt: number;
  updatedAt: number;
};

export type SimulationCheckpointReplayV2<TState = unknown, TScalar = unknown> = {
  manifest: SimulationCheckpointManifestV2<TScalar>;
  state: TState;
  events: SimulationCheckpointEventV2[];
};
