import {
  Pool,
  type PoolClient,
  type PoolConfig,
} from "pg";

export type DatabaseRow = Record<string, unknown>;

export type RunResult = {
  affectedRows: number;
};

/**
 * The application storage boundary is PostgreSQL-only. Callers intentionally
 * do not observe a dialect so schema and repository code cannot grow backend
 * branches again.
 */
export interface RelationalDatabase {
  query<T extends DatabaseRow>(sql: string, parameters?: unknown[]): Promise<T[]>;
  run(sql: string, parameters?: unknown[]): Promise<RunResult>;
  transaction<T>(work: (database: RelationalDatabase) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export type PostgresConnectionConfig = {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  connectTimeoutMs: number;
  ssl?: {
    rejectUnauthorized: boolean;
    ca?: string;
  };
};

function normalizeParameters(parameters: unknown[]): unknown[] {
  return parameters.map((value) => value === undefined ? null : value);
}

/**
 * Repository SQL historically used question-mark placeholders. Keep the
 * conversion at this single PostgreSQL adapter boundary while the public
 * database contract remains backend agnostic.
 */
export function postgresSql(sql: string): string {
  let parameter = 0;
  return sql.replace(/\?/g, () => `$${++parameter}`);
}

class PostgresConnectionDatabase implements RelationalDatabase {
  private closeTask: Promise<void> | undefined;

  constructor(
    private readonly connection: Pool | PoolClient,
    private readonly ownsPool = false,
  ) {}

  async query<T extends DatabaseRow>(sql: string, parameters: unknown[] = []): Promise<T[]> {
    const result = await this.connection.query(postgresSql(sql), normalizeParameters(parameters));
    return result.rows as T[];
  }

  async run(sql: string, parameters: unknown[] = []): Promise<RunResult> {
    const result = await this.connection.query(postgresSql(sql), normalizeParameters(parameters));
    return { affectedRows: Number(result.rowCount ?? 0) };
  }

  async transaction<T>(work: (database: RelationalDatabase) => Promise<T>): Promise<T> {
    if (!(this.connection instanceof Pool)) return work(this);
    const client = await this.connection.connect();
    let releaseError: Error | undefined;
    try {
      await client.query("BEGIN");
      const result = await work(new PostgresConnectionDatabase(client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        releaseError = rollbackError instanceof Error
          ? rollbackError
          : new Error("PostgreSQL rollback failed.", { cause: rollbackError });
        throw new AggregateError(
          [error, rollbackError],
          "PostgreSQL transaction failed and rollback could not be completed.",
          { cause: error },
        );
      }
      throw error;
    } finally {
      client.release(releaseError);
    }
  }

  async close(): Promise<void> {
    if (!this.ownsPool || !(this.connection instanceof Pool)) return;
    this.closeTask ??= this.connection.end();
    await this.closeTask;
  }
}

function postgresPoolOptions(config: PostgresConnectionConfig): PoolConfig {
  return {
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    connectionTimeoutMillis: config.connectTimeoutMs,
    max: 8,
    idleTimeoutMillis: 60_000,
    allowExitOnIdle: true,
    keepAlive: true,
    application_name: "toss-portfolio-lens",
    ...(config.ssl ? { ssl: config.ssl } : {}),
  };
}

export async function openPostgresDatabase(
  config: PostgresConnectionConfig,
): Promise<RelationalDatabase> {
  const pool = new Pool(postgresPoolOptions(config));
  pool.on("error", (error) => {
    console.error(
      "[storage] 유휴 PostgreSQL 연결 오류로 풀에서 연결을 제거했습니다:",
      error instanceof Error ? error.message : error,
    );
  });
  try {
    await pool.query("SELECT 1");
    return new PostgresConnectionDatabase(pool, true);
  } catch (error) {
    try {
      await pool.end();
    } catch (closeError) {
      console.warn(
        "[storage] PostgreSQL 연결 실패 후 풀 정리에 실패했습니다:",
        closeError instanceof Error ? closeError.message : closeError,
      );
    }
    throw error;
  }
}
