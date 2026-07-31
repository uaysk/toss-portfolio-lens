import { createHash } from "node:crypto";
import type { RelationalDatabase } from "../database.js";
import { ArtifactCodec } from "../services/artifact-codec.js";
import { canonicalJson } from "../worker/canonical-json.js";
import {
  SIMULATION_CHECKPOINT_FLUSH_INTERVAL_MS,
  SIMULATION_CHECKPOINT_MAX_CHUNK_BYTES,
  SIMULATION_CHECKPOINT_MAX_EVENTS,
  SIMULATION_CHECKPOINT_SCHEMA_VERSION,
  type SimulationCheckpointChunkReferenceV2,
  type SimulationCheckpointEventTypeV2,
  type SimulationCheckpointEventV2,
  type SimulationCheckpointManifestV2,
  type SimulationCheckpointPatchOperationV2,
  type SimulationCheckpointPathSegmentV2,
  type SimulationCheckpointReplayV2,
} from "./checkpoint-contracts.js";

type CheckpointManifestRow = {
  run_id: string;
  schema_version: string;
  manifest_seq: number;
  revision: number;
  base_json: string;
  base_byte_count: number;
  base_checksum: string;
  scalar_json: string;
  previous_checksum: string | null;
  checksum: string;
  chunk_refs_json: string;
  created_at: number;
  updated_at: number;
};

type CheckpointChunkRow = {
  run_id: string;
  chunk_seq: number;
  first_revision: number;
  last_revision: number;
  event_count: number;
  byte_count: number;
  previous_checksum: string | null;
  checksum: string;
  events_json: string;
  created_at: number;
};

type PendingEvent = {
  event: SimulationCheckpointEventV2;
  json: string;
};

type TimerHandle = ReturnType<typeof setTimeout>;

export type SimulationCheckpointStoreOptions = {
  maxEvents?: number;
  maxChunkBytes?: number;
  flushIntervalMs?: number;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (timer: TimerHandle) => void;
  codec?: Pick<ArtifactCodec, "encode">;
};

export type StartSimulationCheckpointSessionInput<TState, TScalar> = {
  runId: string;
  baseState: TState;
  scalarState: TScalar;
  now?: number;
  onError?: (error: unknown) => void;
};

export type CaptureSimulationCheckpointInput<TState, TScalar> = {
  state: TState;
  scalarState: TScalar;
  type: SimulationCheckpointEventTypeV2;
  occurredAt?: number;
  flush?: boolean;
};

export type AppendSimulationCheckpointPatchInput<TScalar> = {
  /**
   * Precomputed append-only operations. Callers retain ownership of the
   * referenced values until the returned promise settles.
   */
  operations: readonly SimulationCheckpointPatchOperationV2[];
  scalarState: TScalar;
  type: SimulationCheckpointEventTypeV2;
  occurredAt?: number;
  flush?: boolean;
};

type LoadedCheckpoint<TState, TScalar> = {
  manifest: SimulationCheckpointManifestV2<TScalar>;
  baseState: TState;
};

function checksum(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function jsonByteCount(value: string): number {
  return Buffer.byteLength(value);
}

function parseJson<T>(value: string, context: string): T {
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    throw new Error(
      `${context} JSON이 손상되었습니다: ${error instanceof Error ? error.message : "unknown"}`,
    );
  }
}

function assertSafeNonNegativeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`simulation checkpoint ${field} 값이 올바르지 않습니다.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function jsonObjectKeys(value: Record<string, unknown>): string[] {
  return Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort();
}

function cloneJsonValue<T>(value: T): T {
  return parseJson<T>(canonicalJson(value), "simulation checkpoint value");
}

function jsonEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length
      && left.every((value, index) => jsonEqual(value, right[index]));
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = jsonObjectKeys(left);
    const rightKeys = jsonObjectKeys(right);
    return leftKeys.length === rightKeys.length
      && leftKeys.every((key, index) => (
        key === rightKeys[index] && jsonEqual(left[key], right[key])
      ));
  }
  return false;
}

function shiftedArrayOverlap(
  previous: readonly unknown[],
  current: readonly unknown[],
): { shift: number; overlap: number } | undefined {
  const maximumShift = Math.min(previous.length - 1, 64);
  for (let shift = 1; shift <= maximumShift; shift += 1) {
    const overlap = Math.min(previous.length - shift, current.length);
    if (overlap < 8) continue;
    let matches = true;
    for (let index = 0; index < overlap; index += 1) {
      if (!jsonEqual(previous[index + shift], current[index])) {
        matches = false;
        break;
      }
    }
    if (matches) return { shift, overlap };
  }
  return undefined;
}

function diffState(
  previous: unknown,
  current: unknown,
  path: SimulationCheckpointPathSegmentV2[],
  output: SimulationCheckpointPatchOperationV2[],
): void {
  if (Object.is(previous, current)) return;
  if (Array.isArray(previous) && Array.isArray(current)) {
    if (jsonEqual(previous, current)) return;
    const shifted = shiftedArrayOverlap(previous, current);
    if (shifted) {
      output.push({
        op: "splice",
        path: [...path],
        index: 0,
        deleteCount: shifted.shift,
        values: [],
      });
      const retainedLength = previous.length - shifted.shift;
      if (retainedLength > current.length) {
        output.push({
          op: "splice",
          path: [...path],
          index: current.length,
          deleteCount: retainedLength - current.length,
          values: [],
        });
      } else if (current.length > retainedLength) {
        output.push({
          op: "splice",
          path: [...path],
          index: retainedLength,
          deleteCount: 0,
          values: cloneJsonValue(current.slice(retainedLength)),
        });
      }
      return;
    }
    const sharedLength = Math.min(previous.length, current.length);
    for (let index = 0; index < sharedLength; index += 1) {
      diffState(previous[index], current[index], [...path, index], output);
    }
    for (let index = sharedLength; index < current.length; index += 1) {
      output.push({
        op: "set",
        path: [...path, index],
        value: cloneJsonValue(current[index]),
      });
    }
    if (current.length < previous.length) {
      output.push({ op: "truncate", path: [...path], length: current.length });
    }
    return;
  }
  if (isRecord(previous) && isRecord(current)) {
    const previousKeys = jsonObjectKeys(previous);
    const currentKeys = jsonObjectKeys(current);
    const currentSet = new Set(currentKeys);
    for (const key of previousKeys) {
      if (!currentSet.has(key)) output.push({ op: "delete", path: [...path, key] });
    }
    const previousSet = new Set(previousKeys);
    for (const key of currentKeys) {
      if (!previousSet.has(key)) {
        output.push({
          op: "set",
          path: [...path, key],
          value: cloneJsonValue(current[key]),
        });
        continue;
      }
      diffState(previous[key], current[key], [...path, key], output);
    }
    return;
  }
  output.push({ op: "set", path: [...path], value: cloneJsonValue(current) });
}

function pathParent(
  state: unknown,
  path: readonly SimulationCheckpointPathSegmentV2[],
): { parent: Record<string, unknown> | unknown[]; key: SimulationCheckpointPathSegmentV2 } {
  if (path.length === 0) throw new Error("root checkpoint operation에는 parent가 없습니다.");
  let current = state;
  for (const segment of path.slice(0, -1)) {
    if (typeof segment === "number") {
      if (!Array.isArray(current) || !Number.isSafeInteger(segment) || segment < 0) {
        throw new Error("simulation checkpoint array path가 올바르지 않습니다.");
      }
      current = current[segment];
    } else {
      if (!isRecord(current)) {
        throw new Error("simulation checkpoint object path가 올바르지 않습니다.");
      }
      current = current[segment];
    }
  }
  if (!Array.isArray(current) && !isRecord(current)) {
    throw new Error("simulation checkpoint operation parent가 객체가 아닙니다.");
  }
  return {
    parent: current,
    key: path[path.length - 1]!,
  };
}

function pathValue(
  state: unknown,
  path: readonly SimulationCheckpointPathSegmentV2[],
): unknown {
  let current = state;
  for (const segment of path) {
    if (typeof segment === "number") {
      if (!Array.isArray(current) || !Number.isSafeInteger(segment) || segment < 0) {
        throw new Error("simulation checkpoint array path가 올바르지 않습니다.");
      }
      current = current[segment];
      continue;
    }
    if (!isRecord(current)) {
      throw new Error("simulation checkpoint object path가 올바르지 않습니다.");
    }
    current = current[segment];
  }
  return current;
}

function applyOperation(
  state: unknown,
  operation: SimulationCheckpointPatchOperationV2,
): unknown {
  if (operation.op === "splice") {
    const target = pathValue(state, operation.path);
    if (!Array.isArray(target)
      || !Number.isSafeInteger(operation.index)
      || operation.index < 0
      || operation.index > target.length
      || !Number.isSafeInteger(operation.deleteCount)
      || operation.deleteCount < 0
      || operation.index + operation.deleteCount > target.length
      || !Array.isArray(operation.values)) {
      throw new Error("simulation checkpoint splice operation이 올바르지 않습니다.");
    }
    target.splice(
      operation.index,
      operation.deleteCount,
      ...cloneJsonValue(operation.values),
    );
    return state;
  }
  if (operation.path.length === 0) {
    if (operation.op !== "set") {
      throw new Error("root simulation checkpoint에는 set operation만 허용됩니다.");
    }
    return cloneJsonValue(operation.value);
  }
  const { parent, key } = pathParent(state, operation.path);
  if (Array.isArray(parent)) {
    if (typeof key !== "number" || !Number.isSafeInteger(key) || key < 0) {
      throw new Error("simulation checkpoint array index가 올바르지 않습니다.");
    }
    if (operation.op === "set") {
      if (key > parent.length) throw new Error("simulation checkpoint array에 빈 index를 만들 수 없습니다.");
      parent[key] = cloneJsonValue(operation.value);
      return state;
    }
    if (operation.op === "delete") {
      if (key >= parent.length) throw new Error("simulation checkpoint array delete index가 없습니다.");
      parent.splice(key, 1);
      return state;
    }
    throw new Error("array element에는 truncate operation을 적용할 수 없습니다.");
  }
  if (typeof key !== "string") {
    throw new Error("simulation checkpoint object key가 올바르지 않습니다.");
  }
  if (operation.op === "set") {
    parent[key] = cloneJsonValue(operation.value);
    return state;
  }
  if (operation.op === "delete") {
    delete parent[key];
    return state;
  }
  const target = parent[key];
  if (!Array.isArray(target)
    || !Number.isSafeInteger(operation.length)
    || operation.length < 0
    || operation.length > target.length) {
    throw new Error("simulation checkpoint truncate operation이 올바르지 않습니다.");
  }
  target.length = operation.length;
  return state;
}

function applyEvent(state: unknown, event: SimulationCheckpointEventV2): unknown {
  let result = state;
  for (const operation of event.operations) result = applyOperation(result, operation);
  return result;
}

function manifestChecksum<TScalar>(
  manifest: Omit<SimulationCheckpointManifestV2<TScalar>, "checksum">,
): string {
  return checksum(canonicalJson(manifest));
}

function manifestWithoutChecksum<TScalar>(
  manifest: SimulationCheckpointManifestV2<TScalar>,
): Omit<SimulationCheckpointManifestV2<TScalar>, "checksum"> {
  const { checksum: _checksum, ...content } = manifest;
  return content;
}

function manifestFromRow<TScalar>(
  row: CheckpointManifestRow,
): LoadedCheckpoint<unknown, TScalar> {
  if (row.schema_version !== SIMULATION_CHECKPOINT_SCHEMA_VERSION) {
    throw new Error(`지원하지 않는 simulation checkpoint schema입니다: ${row.schema_version}`);
  }
  const seq = Number(row.manifest_seq);
  const revision = Number(row.revision);
  const baseByteCount = Number(row.base_byte_count);
  const createdAt = Number(row.created_at);
  const updatedAt = Number(row.updated_at);
  assertSafeNonNegativeInteger(seq, "seq");
  assertSafeNonNegativeInteger(revision, "revision");
  assertSafeNonNegativeInteger(baseByteCount, "base byte count");
  assertSafeNonNegativeInteger(createdAt, "createdAt");
  assertSafeNonNegativeInteger(updatedAt, "updatedAt");
  const baseState = parseJson<unknown>(row.base_json, "simulation checkpoint base");
  if (jsonByteCount(row.base_json) !== baseByteCount || checksum(row.base_json) !== row.base_checksum) {
    throw new Error("simulation checkpoint base checksum이 일치하지 않습니다.");
  }
  const chunks = parseJson<SimulationCheckpointChunkReferenceV2[]>(
    row.chunk_refs_json,
    "simulation checkpoint chunk references",
  );
  const scalarState = parseJson<TScalar>(row.scalar_json, "simulation checkpoint scalar");
  const manifest: SimulationCheckpointManifestV2<TScalar> = {
    schemaVersion: SIMULATION_CHECKPOINT_SCHEMA_VERSION,
    runId: row.run_id,
    seq,
    revision,
    previousChecksum: row.previous_checksum,
    checksum: row.checksum,
    base: {
      byteCount: baseByteCount,
      checksum: row.base_checksum,
    },
    chunks,
    scalarState,
    createdAt,
    updatedAt,
  };
  if (manifestChecksum(manifestWithoutChecksum(manifest)) !== manifest.checksum) {
    throw new Error("simulation checkpoint manifest checksum이 일치하지 않습니다.");
  }
  if ((seq === 0 && chunks.length !== 0) || (seq > 0 && chunks.length !== 1)) {
    throw new Error("simulation checkpoint manifest tail reference가 올바르지 않습니다.");
  }
  const tail = chunks[0];
  if (tail && (tail.seq !== seq
    || tail.lastRevision !== revision
    || tail.firstRevision > tail.lastRevision
    || tail.eventCount !== tail.lastRevision - tail.firstRevision + 1)) {
    throw new Error("simulation checkpoint manifest tail reference가 revision과 일치하지 않습니다.");
  }
  if (!tail && revision !== 0) {
    throw new Error("simulation checkpoint manifest revision에 tail reference가 없습니다.");
  }
  return { manifest, baseState };
}

function chunkReference(row: CheckpointChunkRow): SimulationCheckpointChunkReferenceV2 {
  return {
    seq: Number(row.chunk_seq),
    firstRevision: Number(row.first_revision),
    lastRevision: Number(row.last_revision),
    eventCount: Number(row.event_count),
    byteCount: Number(row.byte_count),
    previousChecksum: row.previous_checksum,
    checksum: row.checksum,
    createdAt: Number(row.created_at),
  };
}

function sameChunkReference(
  left: SimulationCheckpointChunkReferenceV2,
  right: SimulationCheckpointChunkReferenceV2,
): boolean {
  return left.seq === right.seq
    && left.firstRevision === right.firstRevision
    && left.lastRevision === right.lastRevision
    && left.eventCount === right.eventCount
    && left.byteCount === right.byteCount
    && left.previousChecksum === right.previousChecksum
    && left.checksum === right.checksum
    && left.createdAt === right.createdAt;
}

export class SimulationCheckpointStore {
  readonly maxEvents: number;
  readonly maxChunkBytes: number;
  readonly flushIntervalMs: number;
  readonly now: () => number;
  readonly setTimer: (callback: () => void, delayMs: number) => TimerHandle;
  readonly clearTimer: (timer: TimerHandle) => void;
  private readonly codec: Pick<ArtifactCodec, "encode">;

  constructor(
    private readonly database: RelationalDatabase,
    options: SimulationCheckpointStoreOptions = {},
  ) {
    this.maxEvents = options.maxEvents ?? SIMULATION_CHECKPOINT_MAX_EVENTS;
    this.maxChunkBytes = options.maxChunkBytes ?? SIMULATION_CHECKPOINT_MAX_CHUNK_BYTES;
    this.flushIntervalMs = options.flushIntervalMs ?? SIMULATION_CHECKPOINT_FLUSH_INTERVAL_MS;
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
    this.codec = options.codec ?? new ArtifactCodec();
    if (!Number.isSafeInteger(this.maxEvents) || this.maxEvents < 1
      || this.maxEvents > SIMULATION_CHECKPOINT_MAX_EVENTS) {
      throw new Error(`simulation checkpoint maxEvents는 1..${SIMULATION_CHECKPOINT_MAX_EVENTS}여야 합니다.`);
    }
    if (!Number.isSafeInteger(this.maxChunkBytes) || this.maxChunkBytes < 256
      || this.maxChunkBytes > SIMULATION_CHECKPOINT_MAX_CHUNK_BYTES) {
      throw new Error(
        `simulation checkpoint maxChunkBytes는 256..${SIMULATION_CHECKPOINT_MAX_CHUNK_BYTES}여야 합니다.`,
      );
    }
    if (!Number.isSafeInteger(this.flushIntervalMs) || this.flushIntervalMs < 1
      || this.flushIntervalMs > SIMULATION_CHECKPOINT_FLUSH_INTERVAL_MS) {
      throw new Error(
        `simulation checkpoint flushIntervalMs는 1..${SIMULATION_CHECKPOINT_FLUSH_INTERVAL_MS}여야 합니다.`,
      );
    }
  }

  async initialize(): Promise<void> {
    await this.database.run(`
      CREATE TABLE IF NOT EXISTS portfolio_simulation_checkpoint_manifests (
        run_id TEXT PRIMARY KEY REFERENCES portfolio_backtest_runs(run_id) ON DELETE CASCADE,
        schema_version TEXT NOT NULL,
        manifest_seq BIGINT NOT NULL,
        revision BIGINT NOT NULL,
        base_json TEXT NOT NULL,
        base_byte_count BIGINT NOT NULL,
        base_checksum TEXT NOT NULL,
        scalar_json TEXT NOT NULL,
        previous_checksum TEXT,
        checksum TEXT NOT NULL,
        chunk_refs_json TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      )
    `);
    await this.database.run(`
      CREATE TABLE IF NOT EXISTS portfolio_simulation_checkpoint_chunks (
        run_id TEXT NOT NULL REFERENCES portfolio_simulation_checkpoint_manifests(run_id)
          ON DELETE CASCADE,
        chunk_seq BIGINT NOT NULL,
        first_revision BIGINT NOT NULL,
        last_revision BIGINT NOT NULL,
        event_count INTEGER NOT NULL,
        byte_count BIGINT NOT NULL,
        previous_checksum TEXT,
        checksum TEXT NOT NULL,
        events_json TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        PRIMARY KEY (run_id, chunk_seq)
      )
    `);
    await this.database.run(`
      CREATE INDEX IF NOT EXISTS idx_simulation_checkpoint_revision
      ON portfolio_simulation_checkpoint_chunks(run_id, last_revision)
    `);
  }

  async startSession<TState, TScalar>(
    input: StartSimulationCheckpointSessionInput<TState, TScalar>,
  ): Promise<SimulationCheckpointSession<TState, TScalar>> {
    const createdAt = input.now ?? this.now();
    assertSafeNonNegativeInteger(createdAt, "createdAt");
    const encodedBase = await this.codec.encode(input.baseState);
    const baseJson = encodedBase.contentJson;
    const scalarJson = canonicalJson(input.scalarState);
    const content: Omit<SimulationCheckpointManifestV2<TScalar>, "checksum"> = {
      schemaVersion: SIMULATION_CHECKPOINT_SCHEMA_VERSION,
      runId: input.runId,
      seq: 0,
      revision: 0,
      previousChecksum: null,
      base: {
        byteCount: encodedBase.byteCount,
        checksum: encodedBase.checksum,
      },
      chunks: [],
      scalarState: parseJson<TScalar>(scalarJson, "simulation checkpoint scalar"),
      createdAt,
      updatedAt: createdAt,
    };
    const manifest: SimulationCheckpointManifestV2<TScalar> = {
      ...content,
      checksum: manifestChecksum(content),
    };
    await this.database.run(`
      INSERT INTO portfolio_simulation_checkpoint_manifests (
        run_id, schema_version, manifest_seq, revision, base_json, base_byte_count,
        base_checksum, scalar_json, previous_checksum, checksum, chunk_refs_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      input.runId,
      manifest.schemaVersion,
      manifest.seq,
      manifest.revision,
      baseJson,
      manifest.base.byteCount,
      manifest.base.checksum,
      scalarJson,
      manifest.previousChecksum,
      manifest.checksum,
      canonicalJson(manifest.chunks),
      manifest.createdAt,
      manifest.updatedAt,
    ]);
    return new SimulationCheckpointSession(
      this,
      manifest,
      parseJson<TState>(baseJson, "simulation checkpoint base"),
      input.onError,
    );
  }

  async resumeSession<TState, TScalar>(
    runId: string,
    onError?: (error: unknown) => void,
  ): Promise<SimulationCheckpointSession<TState, TScalar> | undefined> {
    const replay = await this.replay<TState, TScalar>(runId);
    if (!replay) return undefined;
    return new SimulationCheckpointSession(
      this,
      replay.manifest,
      replay.state,
      onError,
    );
  }

  async getManifest<TScalar = unknown>(
    runId: string,
  ): Promise<SimulationCheckpointManifestV2<TScalar> | undefined> {
    const loaded = await this.load<TScalar>(runId);
    return loaded?.manifest;
  }

  async replay<TState = unknown, TScalar = unknown>(
    runId: string,
  ): Promise<SimulationCheckpointReplayV2<TState, TScalar> | undefined> {
    const loaded = await this.load<TScalar>(runId);
    if (!loaded) return undefined;
    const rows = await this.database.query<CheckpointChunkRow>(`
      SELECT run_id, chunk_seq, first_revision, last_revision, event_count,
        byte_count, previous_checksum, checksum, events_json, created_at
      FROM portfolio_simulation_checkpoint_chunks
      WHERE run_id = ?
      ORDER BY chunk_seq ASC
    `, [runId]);
    if (rows.length !== loaded.manifest.seq) {
      throw new Error("simulation checkpoint chunk 수가 manifest와 일치하지 않습니다.");
    }
    let state: unknown = loaded.baseState;
    const events: SimulationCheckpointEventV2[] = [];
    let expectedRevision = 1;
    let previousChunkChecksum: string | null = null;
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]!;
      const actual = chunkReference(row);
      if (actual.seq !== index + 1
        || actual.previousChecksum !== previousChunkChecksum
        || actual.firstRevision !== expectedRevision
        || actual.lastRevision < actual.firstRevision
        || actual.eventCount !== actual.lastRevision - actual.firstRevision + 1
        || jsonByteCount(row.events_json) !== actual.byteCount
        || checksum(row.events_json) !== actual.checksum
        || actual.byteCount > this.maxChunkBytes
        || actual.eventCount > this.maxEvents) {
        throw new Error(`simulation checkpoint chunk ${actual.seq} 무결성 검증에 실패했습니다.`);
      }
      const tail = loaded.manifest.chunks[0];
      if (index === rows.length - 1 && (!tail || !sameChunkReference(actual, tail))) {
        throw new Error("simulation checkpoint manifest tail reference가 마지막 chunk와 일치하지 않습니다.");
      }
      const chunkEvents = parseJson<SimulationCheckpointEventV2[]>(
        row.events_json,
        `simulation checkpoint chunk ${actual.seq}`,
      );
      if (chunkEvents.length !== actual.eventCount) {
        throw new Error(`simulation checkpoint chunk ${actual.seq} event 수가 일치하지 않습니다.`);
      }
      for (const event of chunkEvents) {
        if (event.schemaVersion !== SIMULATION_CHECKPOINT_SCHEMA_VERSION
          || event.revision !== expectedRevision
          || !Number.isSafeInteger(event.occurredAt)
          || event.occurredAt < 0
          || !Array.isArray(event.operations)) {
          throw new Error(`simulation checkpoint event revision ${expectedRevision}이 올바르지 않습니다.`);
        }
        state = applyEvent(state, event);
        events.push(event);
        expectedRevision += 1;
      }
      previousChunkChecksum = actual.checksum;
    }
    if (events.length !== loaded.manifest.revision) {
      throw new Error("simulation checkpoint replay revision이 manifest와 일치하지 않습니다.");
    }
    return {
      manifest: loaded.manifest,
      state: state as TState,
      events,
    };
  }

  async commit<TScalar>(input: {
    manifest: SimulationCheckpointManifestV2<TScalar>;
    pending: readonly PendingEvent[];
    scalarState: TScalar;
    now: number;
  }): Promise<SimulationCheckpointManifestV2<TScalar>> {
    if (!input.pending.length) return input.manifest;
    if (input.pending.length > this.maxEvents) {
      throw new Error("simulation checkpoint chunk event 상한을 초과했습니다.");
    }
    const eventsJson = `[${input.pending.map(({ json }) => json).join(",")}]`;
    const byteCount = jsonByteCount(eventsJson);
    if (byteCount > this.maxChunkBytes) {
      throw new Error("simulation checkpoint chunk byte 상한을 초과했습니다.");
    }
    const first = input.pending[0]!.event;
    const last = input.pending[input.pending.length - 1]!.event;
    const previousChunkChecksum = input.manifest.chunks.at(-1)?.checksum ?? null;
    const reference: SimulationCheckpointChunkReferenceV2 = {
      seq: input.manifest.seq + 1,
      firstRevision: first.revision,
      lastRevision: last.revision,
      eventCount: input.pending.length,
      byteCount,
      previousChecksum: previousChunkChecksum,
      checksum: checksum(eventsJson),
      createdAt: input.now,
    };
    const scalarJson = canonicalJson(input.scalarState);
    const content: Omit<SimulationCheckpointManifestV2<TScalar>, "checksum"> = {
      schemaVersion: SIMULATION_CHECKPOINT_SCHEMA_VERSION,
      runId: input.manifest.runId,
      seq: reference.seq,
      revision: reference.lastRevision,
      previousChecksum: input.manifest.checksum,
      base: input.manifest.base,
      // Keep the manifest update O(1) in total history size. Immutable older
      // references are already persisted in the chunk table and linked by
      // previousChecksum.
      chunks: [reference],
      scalarState: parseJson<TScalar>(scalarJson, "simulation checkpoint scalar"),
      createdAt: input.manifest.createdAt,
      updatedAt: input.now,
    };
    const next: SimulationCheckpointManifestV2<TScalar> = {
      ...content,
      checksum: manifestChecksum(content),
    };
    await this.database.transaction(async (database) => {
      const [stored] = await database.query<{
        manifest_seq: number;
        revision: number;
        checksum: string;
      }>(`
        SELECT manifest_seq, revision, checksum
        FROM portfolio_simulation_checkpoint_manifests
        WHERE run_id = ? FOR UPDATE
      `, [input.manifest.runId]);
      if (!stored
        || Number(stored.manifest_seq) !== input.manifest.seq
        || Number(stored.revision) !== input.manifest.revision
        || stored.checksum !== input.manifest.checksum) {
        throw new Error("simulation checkpoint manifest가 다른 writer에 의해 변경되었습니다.");
      }
      await database.run(`
        INSERT INTO portfolio_simulation_checkpoint_chunks (
          run_id, chunk_seq, first_revision, last_revision, event_count, byte_count,
          previous_checksum, checksum, events_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        input.manifest.runId,
        reference.seq,
        reference.firstRevision,
        reference.lastRevision,
        reference.eventCount,
        reference.byteCount,
        reference.previousChecksum,
        reference.checksum,
        eventsJson,
        reference.createdAt,
      ]);
      const updated = await database.run(`
        UPDATE portfolio_simulation_checkpoint_manifests
        SET schema_version = ?, manifest_seq = ?, revision = ?, scalar_json = ?,
          previous_checksum = ?, checksum = ?, chunk_refs_json = ?, updated_at = ?
        WHERE run_id = ? AND manifest_seq = ? AND checksum = ?
      `, [
        next.schemaVersion,
        next.seq,
        next.revision,
        scalarJson,
        next.previousChecksum,
        next.checksum,
        canonicalJson(next.chunks),
        next.updatedAt,
        next.runId,
        input.manifest.seq,
        input.manifest.checksum,
      ]);
      if (updated.affectedRows !== 1) {
        throw new Error("simulation checkpoint manifest update가 적용되지 않았습니다.");
      }
    });
    return next;
  }

  encodeEvent(event: SimulationCheckpointEventV2): Promise<{
    contentJson: string;
    byteCount: number;
  }> {
    return this.codec.encode(event);
  }

  private async load<TScalar>(runId: string): Promise<LoadedCheckpoint<unknown, TScalar> | undefined> {
    const [row] = await this.database.query<CheckpointManifestRow>(`
      SELECT run_id, schema_version, manifest_seq, revision, base_json, base_byte_count,
        base_checksum, scalar_json, previous_checksum, checksum, chunk_refs_json,
        created_at, updated_at
      FROM portfolio_simulation_checkpoint_manifests
      WHERE run_id = ?
    `, [runId]);
    return row ? manifestFromRow<TScalar>(row) : undefined;
  }
}

export class SimulationCheckpointSession<TState, TScalar> {
  private readonly pending: PendingEvent[] = [];
  private pendingByteCount = 2;
  private pendingSince?: number;
  private latestScalarState: TScalar;
  private tail: Promise<void> = Promise.resolve();
  private timer?: TimerHandle;
  private failure?: unknown;
  private closed = false;

  constructor(
    private readonly store: SimulationCheckpointStore,
    private manifest: SimulationCheckpointManifestV2<TScalar>,
    private shadowState: TState,
    private readonly onError?: (error: unknown) => void,
  ) {
    this.latestScalarState = manifest.scalarState;
  }

  snapshot(): {
    manifest: SimulationCheckpointManifestV2<TScalar>;
    bufferedEvents: number;
    bufferedBytes: number;
  } {
    return {
      manifest: this.manifest,
      bufferedEvents: this.pending.length,
      bufferedBytes: this.pendingByteCount,
    };
  }

  capture(input: CaptureSimulationCheckpointInput<TState, TScalar>): Promise<void> {
    return this.enqueue(() => this.captureNow(input));
  }

  /**
   * Admit an already-computed delta without traversing the cumulative state.
   *
   * `capture()` remains available for recovery/compatibility callers, while
   * live simulations use this API so synchronous admission and codec work are
   * proportional to the new event rather than the full session history.
   */
  appendPatch(input: AppendSimulationCheckpointPatchInput<TScalar>): Promise<void> {
    return this.enqueue(() => this.appendPatchNow(input));
  }

  flush(): Promise<void> {
    return this.enqueue(() => this.flushNow());
  }

  close(): Promise<void> {
    return this.enqueue(async () => {
      await this.flushNow();
      this.closed = true;
      this.clearFlushTimer();
    });
  }

  private enqueue(operation: () => void | Promise<void>): Promise<void> {
    const task = this.tail.then(async () => {
      if (this.failure) throw this.failure;
      if (this.closed) throw new Error("simulation checkpoint session이 닫혔습니다.");
      await operation();
    });
    this.tail = task.catch(() => undefined);
    return task;
  }

  private async captureNow(input: CaptureSimulationCheckpointInput<TState, TScalar>): Promise<void> {
    const operations: SimulationCheckpointPatchOperationV2[] = [];
    diffState(this.shadowState, input.state, [], operations);
    await this.appendPatchNow({
      operations,
      scalarState: input.scalarState,
      type: input.type,
      ...(input.occurredAt === undefined ? {} : { occurredAt: input.occurredAt }),
      ...(input.flush === undefined ? {} : { flush: input.flush }),
    });
  }

  private async appendPatchNow(
    input: AppendSimulationCheckpointPatchInput<TScalar>,
  ): Promise<void> {
    const occurredAt = input.occurredAt ?? this.store.now();
    const capturedAt = this.store.now();
    assertSafeNonNegativeInteger(occurredAt, "event occurredAt");
    if (this.pending.length
      && this.pendingSince !== undefined
      && capturedAt - this.pendingSince >= this.store.flushIntervalMs) {
      await this.flushNow();
    }
    const operations = [...input.operations];
    if (!operations.length && input.type !== "terminal") {
      if (input.flush) await this.flushNow();
      return;
    }
    const revision = this.manifest.revision + this.pending.length + 1;
    const event: SimulationCheckpointEventV2 = {
      schemaVersion: SIMULATION_CHECKPOINT_SCHEMA_VERSION,
      revision,
      type: input.type,
      occurredAt,
      operations,
    };
    const encodedEvent = await this.store.encodeEvent(event);
    const eventJson = encodedEvent.contentJson;
    const normalizedEvent = parseJson<SimulationCheckpointEventV2>(
      eventJson,
      "simulation checkpoint event",
    );
    const eventByteCount = encodedEvent.byteCount;
    const standaloneByteCount = eventByteCount + 2;
    if (standaloneByteCount > this.store.maxChunkBytes) {
      throw new Error(
        `simulation checkpoint event가 chunk 상한을 초과했습니다: ${standaloneByteCount} bytes`,
      );
    }
    const delimiterBytes = this.pending.length ? 1 : 0;
    if (this.pending.length
      && (this.pending.length >= this.store.maxEvents
        || this.pendingByteCount + delimiterBytes + eventByteCount > this.store.maxChunkBytes)) {
      await this.flushNow();
    }
    if (!this.pending.length) {
      this.pendingSince = capturedAt;
      this.pendingByteCount = 2;
    }
    this.pending.push({
      event: normalizedEvent,
      json: eventJson,
    });
    this.pendingByteCount += (this.pending.length > 1 ? 1 : 0) + eventByteCount;
    this.latestScalarState = cloneJsonValue(input.scalarState);
    this.shadowState = applyEvent(this.shadowState, normalizedEvent) as TState;
    if (this.pending.length >= this.store.maxEvents
      || this.pendingByteCount >= this.store.maxChunkBytes
      || input.flush
      || input.type === "terminal") {
      await this.flushNow();
      return;
    }
    this.scheduleFlushTimer();
  }

  private async flushNow(): Promise<void> {
    if (!this.pending.length) {
      this.clearFlushTimer();
      return;
    }
    this.clearFlushTimer();
    this.manifest = await this.store.commit({
      manifest: this.manifest,
      pending: this.pending,
      scalarState: this.latestScalarState,
      now: this.store.now(),
    });
    this.pending.length = 0;
    this.pendingByteCount = 2;
    this.pendingSince = undefined;
  }

  private scheduleFlushTimer(): void {
    if (this.timer || this.pendingSince === undefined) return;
    const remaining = Math.max(
      0,
      this.pendingSince + this.store.flushIntervalMs - this.store.now(),
    );
    this.timer = this.store.setTimer(() => {
      this.timer = undefined;
      void this.flush().catch((error) => {
        this.failure = error;
        this.onError?.(error);
      });
    }, remaining);
    this.timer.unref?.();
  }

  private clearFlushTimer(): void {
    if (!this.timer) return;
    this.store.clearTimer(this.timer);
    this.timer = undefined;
  }
}
