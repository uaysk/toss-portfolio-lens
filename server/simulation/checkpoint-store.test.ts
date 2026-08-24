import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type DatabaseRow,
  type RelationalDatabase,
  type RunResult,
} from "../database.js";
import { PGliteDatabase } from "../../test-support/pglite-database.js";
import { RunRepository } from "../repositories/run-repository.js";
import {
  SIMULATION_CHECKPOINT_SCHEMA_VERSION,
} from "./checkpoint-contracts.js";
import { SimulationCheckpointStore } from "./checkpoint-store.js";

async function setupStore(options: ConstructorParameters<typeof SimulationCheckpointStore>[1] = {}) {
  const database = new PGliteDatabase();
  const runs = new RunRepository(database);
  await runs.initialize();
  const store = new SimulationCheckpointStore(database, options);
  await store.initialize();
  const run = await runs.create({
    kind: "ai_trading_simulation",
    ownerSubject: "checkpoint-owner",
    requestHash: `checkpoint-${Math.random()}`,
    dataRevision: "live-paper:test",
    engineVersion: "simulation-test",
    config: {},
  });
  return { database, store, run };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("SimulationCheckpointStore v2", () => {
  it("immutable chunk seq/checksum chain을 만들고 base + patch chunks를 동일 상태로 replay한다", async () => {
    let now = 1_000;
    const { database, store, run } = await setupStore({
      maxEvents: 2,
      now: () => now,
    });
    try {
      const base = {
        phase: "selecting",
        progress: 0,
        cash: 1_000,
        decisions: [] as Array<{ action: string }>,
        nested: { selected: ["AAA", "BBB"] },
      };
      const session = await store.startSession({
        runId: run.id,
        baseState: base,
        scalarState: { phase: "selecting", progress: 0, cash: 1_000 },
      });
      now += 100;
      await session.capture({
        type: "changed",
        state: {
          ...base,
          phase: "running",
          decisions: [{ action: "hold" }],
        },
        scalarState: { phase: "running", progress: 0, cash: 1_000 },
        occurredAt: now,
      });
      now += 100;
      await session.capture({
        type: "progress",
        state: {
          ...base,
          phase: "running",
          progress: 0.25,
          decisions: [{ action: "hold" }],
        },
        scalarState: { phase: "running", progress: 0.25, cash: 1_000 },
        occurredAt: now,
      });
      now += 100;
      const terminalState = {
        ...base,
        phase: "completed",
        progress: 1,
        cash: 1_025,
        decisions: [{ action: "hold" }, { action: "sell" }],
        nested: { selected: ["AAA"] },
      };
      await session.capture({
        type: "terminal",
        state: terminalState,
        scalarState: { phase: "completed", progress: 1, cash: 1_025 },
        occurredAt: now,
      });
      await session.close();

      const replay = await store.replay<typeof terminalState>(run.id);
      expect(replay?.state).toEqual(terminalState);
      expect(replay?.events.map(({ revision }) => revision)).toEqual([1, 2, 3]);
      expect(replay?.events.map(({ type }) => type)).toEqual([
        "changed",
        "progress",
        "terminal",
      ]);
      expect(replay?.manifest).toMatchObject({
        schemaVersion: SIMULATION_CHECKPOINT_SCHEMA_VERSION,
        runId: run.id,
        seq: 2,
        revision: 3,
        scalarState: { phase: "completed", progress: 1, cash: 1_025 },
      });
      const chunks = replay!.manifest.chunks;
      expect(chunks.map(({ seq }) => seq)).toEqual([2]);
      expect(chunks[0]?.previousChecksum).not.toBeNull();
      expect(replay?.manifest.previousChecksum).not.toBeNull();

      const stateReplay = await store.replayState<typeof terminalState>(run.id);
      expect(stateReplay?.state).toEqual(terminalState);
      expect(stateReplay).not.toHaveProperty("events");

      const rows = await database.query<{
        chunk_seq: number;
        previous_checksum: string | null;
        checksum: string;
        events_json: string;
      }>(`
        SELECT chunk_seq, previous_checksum, checksum, events_json
        FROM portfolio_simulation_checkpoint_chunks
        WHERE run_id = ?
        ORDER BY chunk_seq
      `, [run.id]);
      expect(rows).toHaveLength(2);
      expect(JSON.parse(rows[0]!.events_json)).toHaveLength(2);
      expect(JSON.parse(rows[1]!.events_json)).toHaveLength(1);
      expect(rows[0]!.previous_checksum).toBeNull();
      expect(rows[1]!.previous_checksum).toBe(rows[0]!.checksum);
    } finally {
      await database.close();
    }
  });

  it("chunk를 byte 상한 전에 나누고 각 write bytes를 전체 replay 이력과 무관하게 제한한다", async () => {
    let now = 2_000;
    const { database, store, run } = await setupStore({
      maxChunkBytes: 512,
      now: () => now,
    });
    try {
      const session = await store.startSession({
        runId: run.id,
        baseState: { values: [] as string[] },
        scalarState: { count: 0 },
      });
      let state = { values: [] as string[] };
      for (let index = 0; index < 5; index += 1) {
        now += 10;
        state = { values: [...state.values, `${index}:${"x".repeat(110)}`] };
        await session.capture({
          type: "changed",
          state,
          scalarState: { count: state.values.length },
          occurredAt: now,
        });
      }
      await session.close();

      const replay = await store.replay<typeof state, { count: number }>(run.id);
      expect(replay?.state).toEqual(state);
      expect(replay!.manifest.seq).toBeGreaterThan(1);
      const chunks = await database.query<{ byte_count: number }>(`
        SELECT byte_count
        FROM portfolio_simulation_checkpoint_chunks
        WHERE run_id = ?
      `, [run.id]);
      expect(chunks.every(({ byte_count }) => Number(byte_count) <= 512)).toBe(true);
      expect(replay?.manifest.scalarState).toEqual({ count: 5 });
    } finally {
      await database.close();
    }
  });

  it("bounded rolling array가 shift되어도 전체 5,000개 이력을 다시 쓰지 않는다", async () => {
    const { database, store, run } = await setupStore();
    try {
      const values = Array.from({ length: 5_000 }, (_, id) => ({ id, value: `v${id}` }));
      const session = await store.startSession({
        runId: run.id,
        baseState: { values },
        scalarState: { count: values.length },
      });
      const nextValues = [...values.slice(1), { id: 5_000, value: "v5000" }];
      await session.capture({
        type: "changed",
        state: { values: nextValues },
        scalarState: { count: nextValues.length },
        flush: true,
      });

      const replay = await store.replay<{ values: typeof values }>(run.id);
      expect(replay?.state.values).toEqual(nextValues);
      expect(replay?.events[0]?.operations.map(({ op }) => op)).toEqual(["splice", "splice"]);
      expect(replay?.manifest.chunks[0]?.byteCount).toBeLessThan(2_048);
      await session.close();
    } finally {
      await database.close();
    }
  });

  it("~10MiB history 뒤 단일 append admission과 persisted bytes가 history 크기에 비례하지 않는다", async () => {
    const small = await setupStore();
    const large = await setupStore();
    try {
      const appended = { id: "new", payload: "delta".repeat(16) };
      const smallSession = await small.store.startSession({
        runId: small.run.id,
        baseState: { values: [] as Array<{ id: string | number; payload: string }> },
        scalarState: { count: 0 },
      });
      await smallSession.appendPatch({
        type: "changed",
        operations: [{
          op: "splice",
          path: ["values"],
          index: 0,
          deleteCount: 0,
          values: [appended],
        }],
        scalarState: { count: 1 },
        flush: true,
      });

      const values = Array.from({ length: 10_000 }, (_, id) => ({
        id,
        payload: `${id}:`.padEnd(1_050, "x"),
      }));
      expect(Buffer.byteLength(JSON.stringify({ values }))).toBeGreaterThan(10 * 1024 * 1024);
      const largeSession = await large.store.startSession({
        runId: large.run.id,
        baseState: { values },
        scalarState: { count: values.length },
      });
      const admissionStartedAt = performance.now();
      const persisted = largeSession.appendPatch({
        type: "changed",
        operations: [{
          op: "splice",
          path: ["values"],
          index: values.length,
          deleteCount: 0,
          values: [appended],
        }],
        scalarState: { count: values.length + 1 },
        flush: true,
      });
      const synchronousAdmissionMs = performance.now() - admissionStartedAt;
      expect(synchronousAdmissionMs).toBeLessThan(20);
      await persisted;

      const readEventBytes = async (
        database: PGliteDatabase,
        runId: string,
      ): Promise<number> => {
        const [row] = await database.query<{ events_json: string }>(`
          SELECT events_json
          FROM portfolio_simulation_checkpoint_chunks
          WHERE run_id = ? AND chunk_seq = 1
        `, [runId]);
        return Buffer.byteLength(row!.events_json);
      };
      const smallEventBytes = await readEventBytes(small.database, small.run.id);
      const largeEventBytes = await readEventBytes(large.database, large.run.id);
      expect(largeEventBytes).toBeLessThan(2_048);
      expect(Math.abs(largeEventBytes - smallEventBytes)).toBeLessThan(32);

      const replay = await large.store.replay<{
        values: Array<{ id: string | number; payload: string }>;
      }>(large.run.id);
      expect(replay?.state.values).toHaveLength(values.length + 1);
      expect(replay?.state.values[0]).toEqual(values[0]);
      expect(replay?.state.values.at(-1)).toEqual(appended);
      expect(replay?.manifest.revision).toBe(1);
      expect(replay?.manifest.checksum).toMatch(/^[a-f0-9]{64}$/);
      await Promise.all([smallSession.close(), largeSession.close()]);
    } finally {
      await Promise.all([small.database.close(), large.database.close()]);
    }
  }, 30_000);

  it("첫 buffered event로부터 5초 timer가 지나면 자동 flush한다", async () => {
    let now = 3_000;
    let scheduled: (() => void) | undefined;
    let scheduledDelay: number | undefined;
    const fakeTimer = { unref: vi.fn() } as unknown as NodeJS.Timeout;
    const { database, store, run } = await setupStore({
      now: () => now,
      setTimer: (callback, delayMs) => {
        scheduled = callback;
        scheduledDelay = delayMs;
        return fakeTimer;
      },
      clearTimer: vi.fn(),
    });
    try {
      const session = await store.startSession({
        runId: run.id,
        baseState: { progress: 0 },
        scalarState: { progress: 0 },
      });
      await session.capture({
        type: "progress",
        state: { progress: 0.1 },
        scalarState: { progress: 0.1 },
        occurredAt: now,
      });
      expect(session.snapshot().bufferedEvents).toBe(1);
      expect(scheduledDelay).toBe(5_000);
      expect((await store.getManifest(run.id))?.seq).toBe(0);

      now += 5_000;
      scheduled?.();
      await session.flush();
      expect((await store.getManifest(run.id))?.seq).toBe(1);
      expect(session.snapshot().bufferedEvents).toBe(0);
      await session.close();
    } finally {
      await database.close();
    }
  });

  it("fill과 terminal capture는 5초를 기다리지 않고 즉시 flush한다", async () => {
    let now = 4_000;
    const { database, store, run } = await setupStore({ now: () => now });
    try {
      const session = await store.startSession({
        runId: run.id,
        baseState: { phase: "running", trades: [] as number[] },
        scalarState: { phase: "running" },
      });
      now += 1;
      await session.capture({
        type: "fill",
        state: { phase: "running", trades: [1] },
        scalarState: { phase: "running" },
        occurredAt: now,
        flush: true,
      });
      expect((await store.getManifest(run.id))?.seq).toBe(1);

      now += 1;
      await session.capture({
        type: "terminal",
        state: { phase: "completed", trades: [1] },
        scalarState: { phase: "completed" },
        occurredAt: now,
      });
      const manifest = await store.getManifest(run.id);
      expect(manifest?.seq).toBe(2);
      expect(manifest?.revision).toBe(2);
      await session.close();
    } finally {
      await database.close();
    }
  });

  it("기본 chunk는 정확히 최대 256 events에서 자동 flush한다", async () => {
    const { database, store, run } = await setupStore();
    try {
      const session = await store.startSession({
        runId: run.id,
        baseState: { counter: 0 },
        scalarState: { counter: 0 },
      });
      for (let counter = 1; counter <= 256; counter += 1) {
        await session.capture({
          type: "changed",
          state: { counter },
          scalarState: { counter },
        });
      }
      const manifest = await store.getManifest(run.id);
      expect(manifest?.seq).toBe(1);
      expect(manifest?.revision).toBe(256);
      expect(manifest?.chunks[0]?.eventCount).toBe(256);
      expect(session.snapshot().bufferedEvents).toBe(0);
      await session.close();
    } finally {
      await database.close();
    }
  });

  it("manifest tail reference write bytes stay bounded as chunk history grows", async () => {
    const { database, store, run } = await setupStore({ maxEvents: 1 });
    try {
      const session = await store.startSession({
        runId: run.id,
        baseState: { counter: 0 },
        scalarState: { counter: 0 },
      });
      const storedSizes: number[] = [];
      for (let counter = 1; counter <= 32; counter += 1) {
        await session.capture({
          type: "changed",
          state: { counter },
          scalarState: { counter },
        });
        const [row] = await database.query<{ chunk_refs_json: string }>(`
          SELECT chunk_refs_json
          FROM portfolio_simulation_checkpoint_manifests
          WHERE run_id = ?
        `, [run.id]);
        storedSizes.push(Buffer.byteLength(row!.chunk_refs_json));
      }

      const steadyStateSizes = storedSizes.slice(1);
      expect(Math.max(...steadyStateSizes) - Math.min(...steadyStateSizes)).toBeLessThan(32);
      expect((await store.getManifest(run.id))?.chunks).toHaveLength(1);
      expect((await store.replay<{ counter: number }>(run.id))?.state.counter).toBe(32);
      await session.close();
    } finally {
      await database.close();
    }
  });

  it("persisted immutable chunk가 변조되면 replay를 거부한다", async () => {
    const { database, store, run } = await setupStore();
    try {
      const session = await store.startSession({
        runId: run.id,
        baseState: { value: 0 },
        scalarState: { value: 0 },
      });
      await session.capture({
        type: "changed",
        state: { value: 1 },
        scalarState: { value: 1 },
        flush: true,
      });
      await database.run(`
        UPDATE portfolio_simulation_checkpoint_chunks
        SET events_json = ?
        WHERE run_id = ? AND chunk_seq = 1
      `, ["[]", run.id]);

      await expect(store.replay(run.id)).rejects.toThrow("무결성 검증");
    } finally {
      await database.close();
    }
  });
});

class RecordingDatabase implements RelationalDatabase {
  readonly statements: string[] = [];

  async query<T extends DatabaseRow>(): Promise<T[]> {
    return [];
  }

  async run(sql: string): Promise<RunResult> {
    this.statements.push(sql.replace(/\s+/g, " ").trim());
    return { affectedRows: 0 };
  }

  async transaction<T>(work: (database: RelationalDatabase) => Promise<T>): Promise<T> {
    return work(this);
  }

  async close(): Promise<void> {}
}

describe("SimulationCheckpointStore PostgreSQL schema", () => {
  it("owns one PostgreSQL DDL shape without dialect branches", async () => {
    const database = new RecordingDatabase();
    await new SimulationCheckpointStore(database).initialize();
    const ddl = database.statements.join("\n");
    expect(ddl).toContain("portfolio_simulation_checkpoint_manifests");
    expect(ddl).toContain("portfolio_simulation_checkpoint_chunks");
    expect(ddl).toContain("manifest_seq BIGINT");
    expect(ddl).toContain("CREATE INDEX IF NOT EXISTS idx_simulation_checkpoint_revision");
    expect(ddl).not.toContain("LONGTEXT");
    expect(ddl).not.toContain("ENGINE=InnoDB");
  });
});
