import {
  PGlite,
  type PGliteInterface,
  type Transaction,
} from "@electric-sql/pglite";
import {
  postgresSql,
  type DatabaseRow,
  type RelationalDatabase,
  type RunResult,
} from "../server/database.js";

type PGliteConnection = Pick<PGliteInterface, "query"> | Transaction;

class PGliteTransactionDatabase implements RelationalDatabase {
  constructor(protected readonly connection: PGliteConnection) {}

  async query<T extends DatabaseRow>(sql: string, parameters: unknown[] = []): Promise<T[]> {
    const result = await this.connection.query<T>(postgresSql(sql), parameters);
    return result.rows as T[];
  }

  async run(sql: string, parameters: unknown[] = []): Promise<RunResult> {
    const result = await this.connection.query(postgresSql(sql), parameters);
    return { affectedRows: Number(result.affectedRows ?? 0) };
  }

  async transaction<T>(work: (database: RelationalDatabase) => Promise<T>): Promise<T> {
    return work(this);
  }

  async close(): Promise<void> {
    // Transaction wrappers never own the PGlite instance.
  }
}

export class PGliteDatabase implements RelationalDatabase {
  private readonly ready = PGlite.create();

  static async create(): Promise<PGliteDatabase> {
    const database = new PGliteDatabase();
    await database.ready;
    return database;
  }

  async query<T extends DatabaseRow>(sql: string, parameters: unknown[] = []): Promise<T[]> {
    const pglite = await this.ready;
    const result = await pglite.query<T>(postgresSql(sql), parameters);
    return result.rows as T[];
  }

  async run(sql: string, parameters: unknown[] = []): Promise<RunResult> {
    const pglite = await this.ready;
    const result = await pglite.query(postgresSql(sql), parameters);
    return { affectedRows: Number(result.affectedRows ?? 0) };
  }

  async transaction<T>(
    work: (database: RelationalDatabase) => Promise<T>,
  ): Promise<T> {
    const pglite = await this.ready;
    return pglite.transaction(
      (transaction) => work(new PGliteTransactionDatabase(transaction)),
    );
  }

  /**
   * Reuse the expensive PGlite process between tests while restoring the
   * isolated empty-schema contract expected by each fixture.
   */
  async reset(): Promise<void> {
    const pglite = await this.ready;
    await pglite.query(postgresSql("DROP SCHEMA IF EXISTS public CASCADE"));
    await pglite.query(postgresSql("CREATE SCHEMA public"));
  }

  async close(): Promise<void> {
    await (await this.ready).close();
  }
}
