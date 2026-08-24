import { beforeEach, describe, expect, it, vi } from "vitest";

const poolState = vi.hoisted(() => ({
  instances: [] as Array<{
    config: Record<string, unknown>;
    client: {
      query: ReturnType<typeof vi.fn>;
      release: ReturnType<typeof vi.fn>;
    };
    connect: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
    listeners: Map<string, (...arguments_: unknown[]) => void>;
    query: ReturnType<typeof vi.fn>;
  }>,
  initialQueryError: undefined as Error | undefined,
  endError: undefined as Error | undefined,
}));

vi.mock("pg", () => ({
  Pool: class MockPool {
    readonly client = {
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
      release: vi.fn(),
    };
    readonly connect = vi.fn().mockResolvedValue(this.client);
    readonly end = vi.fn(() => poolState.endError
      ? Promise.reject(poolState.endError)
      : Promise.resolve());
    readonly listeners = new Map<string, (...arguments_: unknown[]) => void>();
    readonly query = vi.fn(() => poolState.initialQueryError
      ? Promise.reject(poolState.initialQueryError)
      : Promise.resolve({ rows: [], rowCount: 1 }));

    constructor(readonly config: Record<string, unknown>) {
      poolState.instances.push(this);
    }

    on(event: string, listener: (...arguments_: unknown[]) => void): this {
      this.listeners.set(event, listener);
      return this;
    }
  },
}));

import { openPostgresDatabase } from "./database.js";

const config = {
  host: "postgres",
  port: 5432,
  user: "portfolio",
  password: "password",
  database: "portfolio",
  connectTimeoutMs: 3_000,
};

describe("PostgreSQL database adapter", () => {
  beforeEach(() => {
    poolState.instances.splice(0);
    poolState.initialQueryError = undefined;
    poolState.endError = undefined;
    vi.clearAllMocks();
  });

  it("uses a bounded idle pool that does not keep a stopped process alive", async () => {
    const database = await openPostgresDatabase(config);
    const [pool] = poolState.instances;

    expect(pool?.config).toMatchObject({
      connectionTimeoutMillis: 3_000,
      max: 8,
      idleTimeoutMillis: 60_000,
      allowExitOnIdle: true,
      keepAlive: true,
      application_name: "toss-portfolio-lens",
    });
    expect(pool?.query).toHaveBeenCalledWith("SELECT 1");

    await Promise.all([database.close(), database.close()]);
    expect(pool?.end).toHaveBeenCalledOnce();
  });

  it("releases successful and rolled-back transactions, removing an unusable client", async () => {
    const database = await openPostgresDatabase(config);
    const [pool] = poolState.instances;
    if (!pool) throw new Error("mock pool was not created");

    await database.transaction(async (transaction) => {
      await transaction.run("UPDATE example SET value = ?", [undefined]);
    });
    expect(pool.client.query.mock.calls).toEqual([
      ["BEGIN"],
      ["UPDATE example SET value = $1", [null]],
      ["COMMIT"],
    ]);
    expect(pool.client.release).toHaveBeenLastCalledWith(undefined);

    const workFailure = new Error("write failed");
    pool.client.query.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
    pool.client.release.mockClear();

    await expect(database.transaction(async () => {
      throw workFailure;
    })).rejects.toBe(workFailure);
    expect(pool.client.query.mock.calls).toEqual([
      ["BEGIN"],
      ["ROLLBACK"],
    ]);
    expect(pool.client.release).toHaveBeenCalledOnce();
    expect(pool.client.release).toHaveBeenCalledWith(undefined);

    const rollbackFailure = new Error("connection lost during rollback");
    pool.client.query.mockReset().mockImplementation((sql: string) => {
      if (sql === "ROLLBACK") return Promise.reject(rollbackFailure);
      return Promise.resolve({ rows: [], rowCount: 0 });
    });
    pool.client.release.mockClear();

    await expect(database.transaction(async () => {
      throw workFailure;
    })).rejects.toMatchObject({
      name: "AggregateError",
      cause: workFailure,
      errors: [workFailure, rollbackFailure],
    });
    expect(pool.client.release).toHaveBeenCalledOnce();
    expect(pool.client.release).toHaveBeenCalledWith(rollbackFailure);
  });

  it("preserves connection failures even when pool cleanup also fails", async () => {
    const connectionFailure = new Error("connection refused");
    poolState.initialQueryError = connectionFailure;
    poolState.endError = new Error("pool close failed");

    await expect(openPostgresDatabase(config)).rejects.toBe(connectionFailure);
    expect(poolState.instances[0]?.end).toHaveBeenCalledOnce();
  });

  it("handles idle client errors instead of leaving an unhandled pool error event", async () => {
    await openPostgresDatabase(config);
    const listener = poolState.instances[0]?.listeners.get("error");
    const error = new Error("idle connection terminated");

    expect(listener).toBeTypeOf("function");
    expect(() => listener?.(error)).not.toThrow();
  });
});
