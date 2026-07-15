import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  createConnection,
  createPool,
  type Pool,
  type PoolConnection,
  type PoolOptions,
  type ResultSetHeader,
  type RowDataPacket,
} from "mysql2/promise";

export type DatabaseDialect = "sqlite" | "mysql";
export type DatabaseRow = Record<string, unknown>;

export type RunResult = {
  affectedRows: number;
  insertId: number;
};

export interface RelationalDatabase {
  readonly dialect: DatabaseDialect;
  query<T extends DatabaseRow>(sql: string, parameters?: unknown[]): Promise<T[]>;
  run(sql: string, parameters?: unknown[]): Promise<RunResult>;
  transaction<T>(work: (database: RelationalDatabase) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

function normalizeParameters(parameters: unknown[]): unknown[] {
  return parameters.map((value) => value === undefined ? null : value);
}

class DirectSqliteDatabase implements RelationalDatabase {
  readonly dialect = "sqlite" as const;

  constructor(protected readonly database: DatabaseSync) {}

  async query<T extends DatabaseRow>(sql: string, parameters: unknown[] = []): Promise<T[]> {
    return this.database.prepare(sql).all(...normalizeParameters(parameters) as never[]) as T[];
  }

  async run(sql: string, parameters: unknown[] = []): Promise<RunResult> {
    const result = this.database.prepare(sql).run(...normalizeParameters(parameters) as never[]);
    return {
      affectedRows: Number(result.changes),
      insertId: Number(result.lastInsertRowid),
    };
  }

  async transaction<T>(work: (database: RelationalDatabase) => Promise<T>): Promise<T> {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = await work(this);
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async close(): Promise<void> {
    // Transaction-scoped wrappers do not own the underlying connection.
  }
}

export class SqliteDatabase implements RelationalDatabase {
  readonly dialect = "sqlite" as const;
  private readonly database: DatabaseSync;
  private queue: Promise<void> = Promise.resolve();

  constructor(databasePath: string) {
    if (databasePath !== ":memory:") {
      mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
    }
    this.database = new DatabaseSync(databasePath);
    this.database.exec("PRAGMA foreign_keys = ON");
    this.database.exec("PRAGMA journal_mode = WAL");
  }

  private enqueue<T>(work: () => Promise<T> | T): Promise<T> {
    const result = this.queue.then(work, work);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  query<T extends DatabaseRow>(sql: string, parameters: unknown[] = []): Promise<T[]> {
    return this.enqueue(() => (
      this.database.prepare(sql).all(...normalizeParameters(parameters) as never[]) as T[]
    ));
  }

  run(sql: string, parameters: unknown[] = []): Promise<RunResult> {
    return this.enqueue(() => {
      const result = this.database.prepare(sql).run(...normalizeParameters(parameters) as never[]);
      return {
        affectedRows: Number(result.changes),
        insertId: Number(result.lastInsertRowid),
      };
    });
  }

  transaction<T>(work: (database: RelationalDatabase) => Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      const direct = new DirectSqliteDatabase(this.database);
      this.database.exec("BEGIN IMMEDIATE");
      try {
        const result = await work(direct);
        this.database.exec("COMMIT");
        return result;
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    });
  }

  close(): Promise<void> {
    return this.enqueue(() => this.database.close());
  }
}

class MySqlConnectionDatabase implements RelationalDatabase {
  readonly dialect = "mysql" as const;

  constructor(protected readonly connection: Pool | PoolConnection) {}

  async query<T extends DatabaseRow>(sql: string, parameters: unknown[] = []): Promise<T[]> {
    const [rows] = await this.connection.execute<RowDataPacket[]>(sql, normalizeParameters(parameters) as never[]);
    return rows as T[];
  }

  async run(sql: string, parameters: unknown[] = []): Promise<RunResult> {
    const [result] = await this.connection.execute<ResultSetHeader>(sql, normalizeParameters(parameters) as never[]);
    return {
      affectedRows: Number(result.affectedRows),
      insertId: Number(result.insertId),
    };
  }

  async transaction<T>(work: (database: RelationalDatabase) => Promise<T>): Promise<T> {
    if (!("getConnection" in this.connection)) return work(this);
    const connection = await this.connection.getConnection();
    try {
      await connection.beginTransaction();
      const result = await work(new MySqlConnectionDatabase(connection));
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async close(): Promise<void> {
    if ("end" in this.connection) await this.connection.end();
  }
}

export type MySqlConnectionConfig = {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  connectTimeoutMs: number;
  ssl?: {
    rejectUnauthorized: boolean;
  };
};

function poolOptions(config: MySqlConnectionConfig): PoolOptions {
  return {
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    connectTimeout: config.connectTimeoutMs,
    waitForConnections: true,
    connectionLimit: 8,
    maxIdle: 4,
    idleTimeout: 60_000,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
    charset: "utf8mb4",
    dateStrings: true,
    ...(config.ssl ? { ssl: config.ssl } : {}),
  };
}

export async function openMySqlDatabase(config: MySqlConnectionConfig): Promise<RelationalDatabase> {
  let pool = createPool(poolOptions(config));
  try {
    await pool.query("SELECT 1");
    return new MySqlConnectionDatabase(pool);
  } catch (error) {
    await pool.end();
    const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
    if (code !== "ER_BAD_DB_ERROR") throw error;
  }

  const bootstrap = await createConnection({
    ...poolOptions(config),
    database: undefined,
  });
  try {
    await bootstrap.query(
      `CREATE DATABASE IF NOT EXISTS \`${config.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
  } finally {
    await bootstrap.end();
  }

  pool = createPool(poolOptions(config));
  try {
    await pool.query("SELECT 1");
    return new MySqlConnectionDatabase(pool);
  } catch (error) {
    await pool.end();
    throw error;
  }
}
