import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { PortfolioHistoryStore, type HistoricalSnapshot } from "../server/history.js";
import type {
  DatabaseRow,
  RelationalDatabase,
  RunResult,
} from "../server/database.js";
import type { DailyCandle, HistoricalOrder } from "../server/toss.js";
import { PGliteDatabase } from "../test-support/pglite-database.js";

const ROW_COUNT = 1_000;
const MINIMUM_QUERY_REDUCTION_PERCENT = 80;
const OUTPUT_PATH = ".cache/performance/postgres-batch.json";

type Counter = {
  statements: number;
  sql: string[];
};

class CountingDatabase implements RelationalDatabase {
  constructor(
    private readonly delegate: RelationalDatabase,
    private readonly counter: Counter,
    private readonly ownsDelegate = false,
  ) {}

  query<T extends DatabaseRow>(
    sql: string,
    parameters: unknown[] = [],
  ): Promise<T[]> {
    this.counter.statements += 1;
    this.counter.sql.push(sql);
    return this.delegate.query<T>(sql, parameters);
  }

  run(sql: string, parameters: unknown[] = []): Promise<RunResult> {
    this.counter.statements += 1;
    this.counter.sql.push(sql);
    return this.delegate.run(sql, parameters);
  }

  transaction<T>(
    work: (database: RelationalDatabase) => Promise<T>,
  ): Promise<T> {
    return this.delegate.transaction((database) => (
      work(new CountingDatabase(database, this.counter))
    ));
  }

  async close(): Promise<void> {
    if (this.ownsDelegate) await this.delegate.close();
  }
}

function dateAt(index: number): string {
  return new Date(Date.UTC(2020, 0, 1 + index)).toISOString().slice(0, 10);
}

function orders(): HistoricalOrder[] {
  return Array.from({ length: ROW_COUNT }, (_, index) => ({
    orderId: `order-${index}`,
    symbol: `SYM${index % 25}`,
    side: index % 2 === 0 ? "BUY" : "SELL",
    currency: "KRW",
    status: "CLOSED",
    orderedAt: `${dateAt(index)}T09:00:00+09:00`,
    filledAt: `${dateAt(index)}T09:01:00+09:00`,
    filledQuantity: 1,
    averageFilledPrice: 100 + index,
    filledAmount: 100 + index,
    commission: 0,
    tax: 0,
  }));
}

function candles(): DailyCandle[] {
  return Array.from({ length: ROW_COUNT }, (_, index) => {
    const date = dateAt(index);
    const close = 100 + index;
    return {
      symbol: "BENCH",
      date,
      timestamp: `${date}T00:00:00.000Z`,
      currency: "KRW",
      openPrice: close - 1,
      highPrice: close + 1,
      lowPrice: close - 2,
      closePrice: close,
      volume: index + 1,
    };
  });
}

function snapshots(): HistoricalSnapshot[] {
  return Array.from({ length: ROW_COUNT }, (_, index) => ({
    date: dateAt(index),
    capturedAt: Date.parse(`${dateAt(index)}T00:00:00.000Z`),
    items: [{
      symbol: "BENCH",
      name: "Benchmark",
      market: "KRX",
      currency: "KRW",
      evaluationAmount: 100 + index,
    }],
  }));
}

function reduction(baseline: number, current: number): number {
  return ((baseline - current) / baseline) * 100;
}

async function main(): Promise<void> {
  const counter: Counter = { statements: 0, sql: [] };
  const database = new CountingDatabase(
    await PGliteDatabase.create(),
    counter,
    true,
  );
  const store = await PortfolioHistoryStore.open(database);
  try {
    counter.statements = 0;
    counter.sql = [];
    await store.upsertOrders("benchmark", orders(), 1);
    const orderQueries = counter.statements;
    const orderUsesUnnest = counter.sql.every((sql) => sql.includes("UNNEST"));

    await store.upsertInstruments([{
      symbol: "BENCH",
      name: "Benchmark",
      market: "KRX",
      currency: "KRW",
    }], 1);
    counter.statements = 0;
    counter.sql = [];
    await store.upsertDailyPrices("KRW:BENCH", candles(), 1);
    const barQueries = counter.statements;
    const barsUseUnnest = counter.sql.every((sql) => sql.includes("UNNEST"));

    counter.statements = 0;
    counter.sql = [];
    await store.replaceHistoricalSnapshots(
      "benchmark",
      snapshots(),
      "2030-01-01",
    );
    const snapshotQueries = counter.statements;
    const snapshotWritesUseUnnest = counter.sql
      .filter((sql) => /INSERT INTO portfolio_(snapshots|snapshot_items)/.test(sql))
      .every((sql) => sql.includes("UNNEST"));

    const report = {
      schemaVersion: "postgres-batch-benchmark/v1",
      generatedAt: new Date().toISOString(),
      rowCount: ROW_COUNT,
      minimumQueryReductionPercent: MINIMUM_QUERY_REDUCTION_PERCENT,
      measurements: {
        orders: {
          baselineQueries: ROW_COUNT,
          currentQueries: orderQueries,
          reductionPercent: reduction(ROW_COUNT, orderQueries),
          usesUnnest: orderUsesUnnest,
        },
        bars: {
          baselineQueries: ROW_COUNT * 2,
          currentQueries: barQueries,
          reductionPercent: reduction(ROW_COUNT * 2, barQueries),
          usesUnnest: barsUseUnnest,
        },
        snapshots: {
          baselineQueries: 1 + ROW_COUNT * 4,
          currentQueries: snapshotQueries,
          reductionPercent: reduction(1 + ROW_COUNT * 4, snapshotQueries),
          usesUnnest: snapshotWritesUseUnnest,
        },
      },
    };
    const passed = Object.values(report.measurements).every((measurement) => (
      measurement.reductionPercent >= MINIMUM_QUERY_REDUCTION_PERCENT
      && measurement.usesUnnest
    ));
    await mkdir(dirname(OUTPUT_PATH), { recursive: true });
    await writeFile(OUTPUT_PATH, `${JSON.stringify({ ...report, passed }, null, 2)}\n`);
    console.log(JSON.stringify({ ...report, passed }, null, 2));
    if (!passed) {
      throw new Error(
        `PostgreSQL batch writes must reduce query count by at least ${MINIMUM_QUERY_REDUCTION_PERCENT}%`,
      );
    }
  } finally {
    await store.close();
  }
}

await main();
