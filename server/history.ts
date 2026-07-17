import { createHash } from "node:crypto";
import { type DatabaseRow, type RelationalDatabase, SqliteDatabase } from "./database.js";
import type { DailyCandle, HistoricalOrder, InstrumentInfo, Portfolio } from "./toss.js";

export type HistoryCurrency = "KRW" | "USD";
export type HistoryRange = "7d" | "30d" | "90d" | "all";
export type HistoryDateRange = { from: string; to: string };

export type PortfolioHistory = {
  accountId: string;
  currency: HistoryCurrency;
  includesCurrencies?: HistoryCurrency[];
  range: HistoryRange;
  generatedAt: string;
  firstSnapshotDate?: string;
  fromDate?: string;
  toDate?: string;
  series: Array<{
    key: string;
    symbol: string;
    name: string;
    market: string;
    currency: HistoryCurrency;
    averageWeight: number;
  }>;
  points: Array<{
    date: string;
    capturedAt: string;
    origin?: "LIVE" | "HISTORICAL";
    totalValue: number;
    values: Record<string, number>;
  }>;
};

export type BackfillStatusValue = "idle" | "running" | "complete" | "partial" | "error";
export type BackfillPhase = "waiting" | "orders" | "instruments" | "prices" | "reconstructing" | "complete";

export type BackfillStatus = {
  accountId: string;
  status: BackfillStatusValue;
  phase: BackfillPhase;
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
  firstTradeDate?: string;
  lastBackfilledDate?: string;
  ordersImported: number;
  symbolsTotal: number;
  symbolsProcessed: number;
  pricesImported: number;
  snapshotsCreated: number;
  reconciledSymbols: number;
  discrepancySymbols: number;
  failedSymbols: number;
  message?: string;
};

export type HistoricalSnapshot = {
  date: string;
  capturedAt: number;
  items: Array<{
    symbol: string;
    name: string;
    market: string;
    currency: HistoryCurrency;
    evaluationAmount: number;
  }>;
};

export type PortfolioAnalysisCandle = {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
};

export type BenchmarkPricePoint = {
  date: string;
  close: number;
};

export type MarketCandleSource = "stock" | "indicator" | "benchmark";

export type MarketCandleCacheInput = {
  requestKey: string;
  feature: "candles" | "indicator-candles";
  requestPath: string;
  source: MarketCandleSource;
  symbol: string;
  interval: "1m" | "1d";
  adjusted: boolean;
  payload: unknown;
  candles: DailyCandle[];
  fetchedAt: number;
  expiresAt: number;
};

type SnapshotRow = {
  id: number;
  snapshot_date: string;
  captured_at: number;
  origin?: "LIVE" | "HISTORICAL";
};

type ItemRow = {
  snapshot_id: number;
  symbol: string;
  name: string;
  market: string;
  evaluation_amount: number;
  weight_percent: number;
};

export type SqliteMigrationResult = {
  skipped: boolean;
  fingerprint: string;
  rows: Record<string, number>;
};

async function batchUpsertMySql(
  database: RelationalDatabase,
  table: string,
  columns: string[],
  rows: DatabaseRow[],
  updateClause: string,
  batchSize = 400,
): Promise<void> {
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const batch = rows.slice(offset, offset + batchSize);
    if (!batch.length) continue;
    const placeholders = batch.map(() => `(${columns.map(() => "?").join(", ")})`).join(", ");
    const parameters = batch.flatMap((row) => columns.map((column) => row[column]));
    await database.run(
      `INSERT INTO ${table} (${columns.join(", ")}) VALUES ${placeholders} ON DUPLICATE KEY UPDATE ${updateClause}`,
      parameters,
    );
  }
}

async function batchUpsertPostgres(
  database: RelationalDatabase,
  table: string,
  columns: string[],
  rows: DatabaseRow[],
  conflictColumns: string[],
  updateColumns: string[],
  freshnessColumn?: string,
  batchSize = 400,
): Promise<void> {
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const batch = rows.slice(offset, offset + batchSize);
    if (!batch.length) continue;
    const placeholders = batch.map(() => `(${columns.map(() => "?").join(", ")})`).join(", ");
    const parameters = batch.flatMap((row) => columns.map((column) => row[column]));
    const conflict = conflictColumns.join(", ");
    const update = updateColumns.length
      ? `DO UPDATE SET ${updateColumns.map((column) => `${column} = EXCLUDED.${column}`).join(", ")}${
        freshnessColumn ? ` WHERE EXCLUDED.${freshnessColumn} >= ${table}.${freshnessColumn}` : ""
      }`
      : "DO NOTHING";
    await database.run(
      `INSERT INTO ${table} (${columns.join(", ")}) VALUES ${placeholders} ON CONFLICT (${conflict}) ${update}`,
      parameters,
    );
  }
}

function round(value: number, digits = 6): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

export function kstDateString(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

export function isHistoryDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function startDateForRange(range: HistoryRange, now: Date): string | undefined {
  if (range === "all") return undefined;
  const days = range === "7d" ? 7 : range === "30d" ? 30 : 90;
  const [year, month, day] = kstDateString(now).split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day - (days - 1))).toISOString().slice(0, 10);
}

function seriesKey(market: string, symbol: string): string {
  return `${market}:${symbol}`;
}

export class PortfolioHistoryStore {
  readonly backend: "sqlite" | "mysql" | "postgres";

  private constructor(private readonly db: RelationalDatabase) {
    this.backend = db.dialect;
  }

  static async open(database: RelationalDatabase): Promise<PortfolioHistoryStore> {
    const store = new PortfolioHistoryStore(database);
    await store.initialize();
    return store;
  }

  static async openSqlite(databasePath: string): Promise<PortfolioHistoryStore> {
    return PortfolioHistoryStore.open(new SqliteDatabase(databasePath));
  }

  static async migrateSqliteData(
    source: PortfolioHistoryStore,
    target: PortfolioHistoryStore,
    fingerprint: string,
  ): Promise<SqliteMigrationResult> {
    if (source.backend !== "sqlite" || !["mysql", "postgres"].includes(target.backend)) {
      throw new Error("SQLite에서 MySQL 또는 PostgreSQL로만 데이터를 마이그레이션할 수 있습니다.");
    }
    const [previous] = await target.db.query<{ meta_value: string }>(`
      SELECT meta_value FROM portfolio_storage_meta WHERE meta_key = 'sqlite_migration_fingerprint_v2'
    `);
    if (previous?.meta_value === fingerprint) {
      return { skipped: true, fingerprint, rows: {} };
    }

    const instruments = await source.db.query<DatabaseRow>("SELECT * FROM portfolio_instruments");
    const orders = await source.db.query<DatabaseRow>("SELECT * FROM portfolio_orders");
    const snapshots = await source.db.query<DatabaseRow>("SELECT * FROM portfolio_snapshots");
    const snapshotItems = await source.db.query<DatabaseRow>(`
      SELECT snapshots.account_id, snapshots.snapshot_date,
             snapshots.captured_at AS source_captured_at,
             items.symbol, items.name, items.market, items.currency,
             items.evaluation_amount, items.weight_percent
      FROM portfolio_snapshot_items AS items
      JOIN portfolio_snapshots AS snapshots ON snapshots.id = items.snapshot_id
      ORDER BY snapshots.account_id, snapshots.snapshot_date
    `);
    const dailyPrices = await source.db.query<DatabaseRow>("SELECT * FROM portfolio_daily_prices");
    const backtestPrices = await source.db.query<DatabaseRow>("SELECT * FROM portfolio_backtest_prices");
    const benchmarkPrices = await source.db.query<DatabaseRow>("SELECT * FROM portfolio_benchmark_prices");
    const exchangeRates = await source.db.query<DatabaseRow>("SELECT * FROM portfolio_exchange_rates");
    const backfillStates = await source.db.query<DatabaseRow>("SELECT * FROM portfolio_backfill_state");
    const cashLedger = await source.hasTable("portfolio_cash_ledger")
      ? await source.db.query<DatabaseRow>("SELECT * FROM portfolio_cash_ledger")
      : [];
    const marketCandles = await source.hasTable("portfolio_market_candles")
      ? await source.db.query<DatabaseRow>("SELECT * FROM portfolio_market_candles")
      : [];
    const candleResponses = await source.hasTable("portfolio_candle_responses")
      ? await source.db.query<DatabaseRow>("SELECT * FROM portfolio_candle_responses")
      : [];
    const rows = {
      portfolio_instruments: instruments.length,
      portfolio_orders: orders.length,
      portfolio_snapshots: snapshots.length,
      portfolio_snapshot_items: snapshotItems.length,
      portfolio_daily_prices: dailyPrices.length,
      portfolio_backtest_prices: backtestPrices.length,
      portfolio_benchmark_prices: benchmarkPrices.length,
      portfolio_exchange_rates: exchangeRates.length,
      portfolio_backfill_state: backfillStates.length,
      portfolio_cash_ledger: cashLedger.length,
      portfolio_market_candles: marketCandles.length,
      portfolio_candle_responses: candleResponses.length,
    };

    if (target.backend === "postgres") {
      await target.db.transaction(async (database) => {
        await batchUpsertPostgres(
          database,
          "portfolio_instruments",
          ["instrument_key", "symbol", "name", "market", "currency", "updated_at"],
          instruments,
          ["instrument_key"],
          ["symbol", "name", "market", "currency", "updated_at"],
          "updated_at",
        );
        await batchUpsertPostgres(
          database,
          "portfolio_orders",
          [
            "account_id", "order_id", "symbol", "side", "currency", "status", "ordered_at", "filled_at",
            "filled_quantity", "average_filled_price", "filled_amount", "commission", "tax", "fetched_at",
          ],
          orders,
          ["account_id", "order_id"],
          [
            "symbol", "side", "currency", "status", "ordered_at", "filled_at", "filled_quantity",
            "average_filled_price", "filled_amount", "commission", "tax", "fetched_at",
          ],
          "fetched_at",
        );
        await batchUpsertPostgres(
          database,
          "portfolio_snapshots",
          ["account_id", "snapshot_date", "captured_at", "origin"],
          snapshots,
          ["account_id", "snapshot_date"],
          ["captured_at", "origin"],
          "captured_at",
        );

        const targetSnapshots = await database.query<{
          id: number;
          account_id: string;
          snapshot_date: string;
          captured_at: number;
        }>("SELECT id, account_id, snapshot_date, captured_at FROM portfolio_snapshots");
        const targetByKey = new Map(targetSnapshots.map((snapshot) => [
          `${snapshot.account_id}\u0000${snapshot.snapshot_date}`,
          snapshot,
        ]));
        const authoritativeSnapshotIds = new Set<number>();
        for (const snapshot of snapshots) {
          const key = `${String(snapshot.account_id)}\u0000${String(snapshot.snapshot_date)}`;
          const targetSnapshot = targetByKey.get(key);
          if (targetSnapshot && Number(snapshot.captured_at) >= Number(targetSnapshot.captured_at)) {
            authoritativeSnapshotIds.add(Number(targetSnapshot.id));
          }
        }
        const migratedItems: DatabaseRow[] = [];
        for (const item of snapshotItems) {
          const key = `${String(item.account_id)}\u0000${String(item.snapshot_date)}`;
          const targetSnapshot = targetByKey.get(key);
          if (!targetSnapshot || Number(item.source_captured_at) < Number(targetSnapshot.captured_at)) continue;
          authoritativeSnapshotIds.add(Number(targetSnapshot.id));
          migratedItems.push({
            snapshot_id: Number(targetSnapshot.id),
            symbol: item.symbol,
            name: item.name,
            market: item.market,
            currency: item.currency,
            evaluation_amount: item.evaluation_amount,
            weight_percent: item.weight_percent,
          });
        }
        for (const snapshotId of authoritativeSnapshotIds) {
          await database.run("DELETE FROM portfolio_snapshot_items WHERE snapshot_id = ?", [snapshotId]);
        }
        await batchUpsertPostgres(
          database,
          "portfolio_snapshot_items",
          ["snapshot_id", "symbol", "name", "market", "currency", "evaluation_amount", "weight_percent"],
          migratedItems,
          ["snapshot_id", "market", "symbol", "currency"],
          ["name", "evaluation_amount", "weight_percent"],
        );

        const timestampedTables: Array<{
          table: string;
          columns: string[];
          rows: DatabaseRow[];
          conflicts: string[];
          updates: string[];
          freshness: string;
        }> = [
          {
            table: "portfolio_daily_prices",
            columns: [
              "instrument_key", "price_date", "open_price", "high_price", "low_price", "close_price",
              "currency", "timestamp", "updated_at",
            ],
            rows: dailyPrices,
            conflicts: ["instrument_key", "price_date"],
            updates: ["open_price", "high_price", "low_price", "close_price", "currency", "timestamp", "updated_at"],
            freshness: "updated_at",
          },
          {
            table: "portfolio_backtest_prices",
            columns: ["instrument_key", "price_date", "close_price", "currency", "timestamp", "updated_at"],
            rows: backtestPrices,
            conflicts: ["instrument_key", "price_date"],
            updates: ["close_price", "currency", "timestamp", "updated_at"],
            freshness: "updated_at",
          },
          {
            table: "portfolio_benchmark_prices",
            columns: ["benchmark_key", "price_date", "close_price", "timestamp", "updated_at"],
            rows: benchmarkPrices,
            conflicts: ["benchmark_key", "price_date"],
            updates: ["close_price", "timestamp", "updated_at"],
            freshness: "updated_at",
          },
          {
            table: "portfolio_exchange_rates",
            columns: ["rate_date", "base_currency", "quote_currency", "rate", "timestamp", "updated_at"],
            rows: exchangeRates,
            conflicts: ["rate_date", "base_currency", "quote_currency"],
            updates: ["rate", "timestamp", "updated_at"],
            freshness: "updated_at",
          },
          {
            table: "portfolio_backfill_state",
            columns: [
              "account_id", "status", "phase", "started_at", "completed_at", "updated_at", "first_trade_date",
              "last_backfilled_date", "orders_imported", "symbols_total", "symbols_processed", "prices_imported",
              "snapshots_created", "reconciled_symbols", "discrepancy_symbols", "failed_symbols", "message",
            ],
            rows: backfillStates,
            conflicts: ["account_id"],
            updates: [
              "status", "phase", "started_at", "completed_at", "updated_at", "first_trade_date",
              "last_backfilled_date", "orders_imported", "symbols_total", "symbols_processed", "prices_imported",
              "snapshots_created", "reconciled_symbols", "discrepancy_symbols", "failed_symbols", "message",
            ],
            freshness: "updated_at",
          },
          {
            table: "portfolio_cash_ledger",
            columns: [
              "account_id", "entry_id", "transaction_date", "transaction_time", "occurred_at", "title",
              "category", "kind", "currency", "amount", "balance", "instrument_name", "quantity", "source",
              "imported_at",
            ],
            rows: cashLedger,
            conflicts: ["account_id", "entry_id"],
            updates: [
              "transaction_date", "transaction_time", "occurred_at", "title", "category", "kind", "currency",
              "amount", "balance", "instrument_name", "quantity", "source", "imported_at",
            ],
            freshness: "imported_at",
          },
          {
            table: "portfolio_market_candles",
            columns: [
              "source_kind", "symbol", "candle_interval", "adjusted", "price_date", "timestamp", "currency",
              "open_price", "high_price", "low_price", "close_price", "updated_at",
            ],
            rows: marketCandles,
            conflicts: ["source_kind", "symbol", "candle_interval", "adjusted", "timestamp"],
            updates: ["price_date", "currency", "open_price", "high_price", "low_price", "close_price", "updated_at"],
            freshness: "updated_at",
          },
          {
            table: "portfolio_candle_responses",
            columns: [
              "request_key", "feature", "request_path", "source_kind", "symbol", "candle_interval", "adjusted",
              "payload_json", "fetched_at", "expires_at",
            ],
            rows: candleResponses,
            conflicts: ["request_key"],
            updates: [
              "feature", "request_path", "source_kind", "symbol", "candle_interval", "adjusted", "payload_json",
              "fetched_at", "expires_at",
            ],
            freshness: "fetched_at",
          },
        ];
        for (const table of timestampedTables) {
          await batchUpsertPostgres(
            database,
            table.table,
            table.columns,
            table.rows,
            table.conflicts,
            table.updates,
            table.freshness,
          );
        }
        await database.run(`
          INSERT INTO portfolio_storage_meta (meta_key, meta_value, updated_at)
          VALUES ('sqlite_migration_fingerprint_v2', ?, ?)
          ON CONFLICT(meta_key) DO UPDATE SET meta_value = EXCLUDED.meta_value, updated_at = EXCLUDED.updated_at
        `, [fingerprint, new Date().toISOString()]);
      });
      return { skipped: false, fingerprint, rows };
    }

    await target.db.transaction(async (database) => {
      await batchUpsertMySql(
        database,
        "portfolio_instruments",
        ["instrument_key", "symbol", "name", "market", "currency", "updated_at"],
        instruments,
        `symbol = IF(VALUES(updated_at) >= updated_at, VALUES(symbol), symbol),
         name = IF(VALUES(updated_at) >= updated_at, VALUES(name), name),
         market = IF(VALUES(updated_at) >= updated_at, VALUES(market), market),
         currency = IF(VALUES(updated_at) >= updated_at, VALUES(currency), currency),
         updated_at = GREATEST(updated_at, VALUES(updated_at))`,
      );
      await batchUpsertMySql(
        database,
        "portfolio_orders",
        [
          "account_id", "order_id", "symbol", "side", "currency", "status", "ordered_at", "filled_at",
          "filled_quantity", "average_filled_price", "filled_amount", "commission", "tax", "fetched_at",
        ],
        orders,
        `symbol = IF(VALUES(fetched_at) >= fetched_at, VALUES(symbol), symbol),
         side = IF(VALUES(fetched_at) >= fetched_at, VALUES(side), side),
         currency = IF(VALUES(fetched_at) >= fetched_at, VALUES(currency), currency),
         status = IF(VALUES(fetched_at) >= fetched_at, VALUES(status), status),
         ordered_at = IF(VALUES(fetched_at) >= fetched_at, VALUES(ordered_at), ordered_at),
         filled_at = IF(VALUES(fetched_at) >= fetched_at, VALUES(filled_at), filled_at),
         filled_quantity = IF(VALUES(fetched_at) >= fetched_at, VALUES(filled_quantity), filled_quantity),
         average_filled_price = IF(VALUES(fetched_at) >= fetched_at, VALUES(average_filled_price), average_filled_price),
         filled_amount = IF(VALUES(fetched_at) >= fetched_at, VALUES(filled_amount), filled_amount),
         commission = IF(VALUES(fetched_at) >= fetched_at, VALUES(commission), commission),
         tax = IF(VALUES(fetched_at) >= fetched_at, VALUES(tax), tax),
         fetched_at = GREATEST(fetched_at, VALUES(fetched_at))`,
      );
      await batchUpsertMySql(
        database,
        "portfolio_snapshots",
        ["account_id", "snapshot_date", "captured_at", "origin"],
        snapshots,
        `origin = IF(VALUES(captured_at) >= captured_at, VALUES(origin), origin),
         captured_at = GREATEST(captured_at, VALUES(captured_at))`,
      );

      const targetSnapshots = await database.query<{
        id: number;
        account_id: string;
        snapshot_date: string;
        captured_at: number;
      }>("SELECT id, account_id, snapshot_date, captured_at FROM portfolio_snapshots");
      const targetByKey = new Map(targetSnapshots.map((snapshot) => [
        `${snapshot.account_id}\u0000${snapshot.snapshot_date}`,
        snapshot,
      ]));
      const authoritativeSnapshotIds = new Set<number>();
      for (const snapshot of snapshots) {
        const key = `${String(snapshot.account_id)}\u0000${String(snapshot.snapshot_date)}`;
        const targetSnapshot = targetByKey.get(key);
        if (targetSnapshot && Number(snapshot.captured_at) >= Number(targetSnapshot.captured_at)) {
          authoritativeSnapshotIds.add(Number(targetSnapshot.id));
        }
      }
      const migratedItems: DatabaseRow[] = [];
      for (const item of snapshotItems) {
        const key = `${String(item.account_id)}\u0000${String(item.snapshot_date)}`;
        const targetSnapshot = targetByKey.get(key);
        if (!targetSnapshot || Number(item.source_captured_at) < Number(targetSnapshot.captured_at)) continue;
        authoritativeSnapshotIds.add(Number(targetSnapshot.id));
        migratedItems.push({
          snapshot_id: Number(targetSnapshot.id),
          symbol: item.symbol,
          name: item.name,
          market: item.market,
          currency: item.currency,
          evaluation_amount: item.evaluation_amount,
          weight_percent: item.weight_percent,
        });
      }
      for (const snapshotId of authoritativeSnapshotIds) {
        await database.run("DELETE FROM portfolio_snapshot_items WHERE snapshot_id = ?", [snapshotId]);
      }
      await batchUpsertMySql(
        database,
        "portfolio_snapshot_items",
        ["snapshot_id", "symbol", "name", "market", "currency", "evaluation_amount", "weight_percent"],
        migratedItems,
        `name = VALUES(name), evaluation_amount = VALUES(evaluation_amount), weight_percent = VALUES(weight_percent)`,
      );
      await batchUpsertMySql(
        database,
        "portfolio_daily_prices",
        [
          "instrument_key", "price_date", "open_price", "high_price", "low_price", "close_price",
          "currency", "timestamp", "updated_at",
        ],
        dailyPrices,
        `open_price = IF(VALUES(updated_at) >= updated_at, VALUES(open_price), open_price),
         high_price = IF(VALUES(updated_at) >= updated_at, VALUES(high_price), high_price),
         low_price = IF(VALUES(updated_at) >= updated_at, VALUES(low_price), low_price),
         close_price = IF(VALUES(updated_at) >= updated_at, VALUES(close_price), close_price),
         currency = IF(VALUES(updated_at) >= updated_at, VALUES(currency), currency),
         timestamp = IF(VALUES(updated_at) >= updated_at, VALUES(timestamp), timestamp),
         updated_at = GREATEST(updated_at, VALUES(updated_at))`,
      );
      await batchUpsertMySql(
        database,
        "portfolio_backtest_prices",
        ["instrument_key", "price_date", "close_price", "currency", "timestamp", "updated_at"],
        backtestPrices,
        `close_price = IF(VALUES(updated_at) >= updated_at, VALUES(close_price), close_price),
         currency = IF(VALUES(updated_at) >= updated_at, VALUES(currency), currency),
         timestamp = IF(VALUES(updated_at) >= updated_at, VALUES(timestamp), timestamp),
         updated_at = GREATEST(updated_at, VALUES(updated_at))`,
      );
      await batchUpsertMySql(
        database,
        "portfolio_benchmark_prices",
        ["benchmark_key", "price_date", "close_price", "timestamp", "updated_at"],
        benchmarkPrices,
        `close_price = IF(VALUES(updated_at) >= updated_at, VALUES(close_price), close_price),
         timestamp = IF(VALUES(updated_at) >= updated_at, VALUES(timestamp), timestamp),
         updated_at = GREATEST(updated_at, VALUES(updated_at))`,
      );
      await batchUpsertMySql(
        database,
        "portfolio_exchange_rates",
        ["rate_date", "base_currency", "quote_currency", "rate", "timestamp", "updated_at"],
        exchangeRates,
        `rate = IF(VALUES(updated_at) >= updated_at, VALUES(rate), rate),
         timestamp = IF(VALUES(updated_at) >= updated_at, VALUES(timestamp), timestamp),
         updated_at = GREATEST(updated_at, VALUES(updated_at))`,
      );
      await batchUpsertMySql(
        database,
        "portfolio_backfill_state",
        [
          "account_id", "status", "phase", "started_at", "completed_at", "updated_at", "first_trade_date",
          "last_backfilled_date", "orders_imported", "symbols_total", "symbols_processed", "prices_imported",
          "snapshots_created", "reconciled_symbols", "discrepancy_symbols", "failed_symbols", "message",
        ],
        backfillStates,
        `status = IF(VALUES(updated_at) >= updated_at, VALUES(status), status),
         phase = IF(VALUES(updated_at) >= updated_at, VALUES(phase), phase),
         started_at = IF(VALUES(updated_at) >= updated_at, VALUES(started_at), started_at),
         completed_at = IF(VALUES(updated_at) >= updated_at, VALUES(completed_at), completed_at),
         first_trade_date = IF(VALUES(updated_at) >= updated_at, VALUES(first_trade_date), first_trade_date),
         last_backfilled_date = IF(VALUES(updated_at) >= updated_at, VALUES(last_backfilled_date), last_backfilled_date),
         orders_imported = IF(VALUES(updated_at) >= updated_at, VALUES(orders_imported), orders_imported),
         symbols_total = IF(VALUES(updated_at) >= updated_at, VALUES(symbols_total), symbols_total),
         symbols_processed = IF(VALUES(updated_at) >= updated_at, VALUES(symbols_processed), symbols_processed),
         prices_imported = IF(VALUES(updated_at) >= updated_at, VALUES(prices_imported), prices_imported),
         snapshots_created = IF(VALUES(updated_at) >= updated_at, VALUES(snapshots_created), snapshots_created),
         reconciled_symbols = IF(VALUES(updated_at) >= updated_at, VALUES(reconciled_symbols), reconciled_symbols),
         discrepancy_symbols = IF(VALUES(updated_at) >= updated_at, VALUES(discrepancy_symbols), discrepancy_symbols),
         failed_symbols = IF(VALUES(updated_at) >= updated_at, VALUES(failed_symbols), failed_symbols),
         message = IF(VALUES(updated_at) >= updated_at, VALUES(message), message),
         updated_at = GREATEST(updated_at, VALUES(updated_at))`,
      );
      await batchUpsertMySql(
        database,
        "portfolio_cash_ledger",
        [
          "account_id", "entry_id", "transaction_date", "transaction_time", "occurred_at", "title",
          "category", "kind", "currency", "amount", "balance", "instrument_name", "quantity", "source",
          "imported_at",
        ],
        cashLedger,
        `transaction_date = IF(VALUES(imported_at) >= imported_at, VALUES(transaction_date), transaction_date),
         transaction_time = IF(VALUES(imported_at) >= imported_at, VALUES(transaction_time), transaction_time),
         occurred_at = IF(VALUES(imported_at) >= imported_at, VALUES(occurred_at), occurred_at),
         title = IF(VALUES(imported_at) >= imported_at, VALUES(title), title),
         category = IF(VALUES(imported_at) >= imported_at, VALUES(category), category),
         kind = IF(VALUES(imported_at) >= imported_at, VALUES(kind), kind),
         currency = IF(VALUES(imported_at) >= imported_at, VALUES(currency), currency),
         amount = IF(VALUES(imported_at) >= imported_at, VALUES(amount), amount),
         balance = IF(VALUES(imported_at) >= imported_at, VALUES(balance), balance),
         instrument_name = IF(VALUES(imported_at) >= imported_at, VALUES(instrument_name), instrument_name),
         quantity = IF(VALUES(imported_at) >= imported_at, VALUES(quantity), quantity),
         source = IF(VALUES(imported_at) >= imported_at, VALUES(source), source),
         imported_at = GREATEST(imported_at, VALUES(imported_at))`,
      );
      await batchUpsertMySql(
        database,
        "portfolio_market_candles",
        [
          "source_kind", "symbol", "candle_interval", "adjusted", "price_date", "timestamp", "currency",
          "open_price", "high_price", "low_price", "close_price", "updated_at",
        ],
        marketCandles,
        `price_date = IF(VALUES(updated_at) >= updated_at, VALUES(price_date), price_date),
         currency = IF(VALUES(updated_at) >= updated_at, VALUES(currency), currency),
         open_price = IF(VALUES(updated_at) >= updated_at, VALUES(open_price), open_price),
         high_price = IF(VALUES(updated_at) >= updated_at, VALUES(high_price), high_price),
         low_price = IF(VALUES(updated_at) >= updated_at, VALUES(low_price), low_price),
         close_price = IF(VALUES(updated_at) >= updated_at, VALUES(close_price), close_price),
         updated_at = GREATEST(updated_at, VALUES(updated_at))`,
      );
      await batchUpsertMySql(
        database,
        "portfolio_candle_responses",
        [
          "request_key", "feature", "request_path", "source_kind", "symbol", "candle_interval", "adjusted",
          "payload_json", "fetched_at", "expires_at",
        ],
        candleResponses,
        `feature = IF(VALUES(fetched_at) >= fetched_at, VALUES(feature), feature),
         request_path = IF(VALUES(fetched_at) >= fetched_at, VALUES(request_path), request_path),
         source_kind = IF(VALUES(fetched_at) >= fetched_at, VALUES(source_kind), source_kind),
         symbol = IF(VALUES(fetched_at) >= fetched_at, VALUES(symbol), symbol),
         candle_interval = IF(VALUES(fetched_at) >= fetched_at, VALUES(candle_interval), candle_interval),
         adjusted = IF(VALUES(fetched_at) >= fetched_at, VALUES(adjusted), adjusted),
         payload_json = IF(VALUES(fetched_at) >= fetched_at, VALUES(payload_json), payload_json),
         expires_at = IF(VALUES(fetched_at) >= fetched_at, VALUES(expires_at), expires_at),
         fetched_at = GREATEST(fetched_at, VALUES(fetched_at))`,
      );
      await database.run(`
        INSERT INTO portfolio_storage_meta (meta_key, meta_value, updated_at)
        VALUES ('sqlite_migration_fingerprint_v2', ?, ?)
        ON DUPLICATE KEY UPDATE meta_value = VALUES(meta_value), updated_at = VALUES(updated_at)
      `, [fingerprint, new Date().toISOString()]);
    });

    return { skipped: false, fingerprint, rows };
  }

  private async initialize(): Promise<void> {
    const sqliteSchema = [
      `CREATE TABLE IF NOT EXISTS portfolio_snapshots (
        id INTEGER PRIMARY KEY,
        account_id TEXT NOT NULL,
        snapshot_date TEXT NOT NULL,
        captured_at INTEGER NOT NULL,
        origin TEXT NOT NULL DEFAULT 'LIVE' CHECK(origin IN ('LIVE', 'HISTORICAL')),
        UNIQUE(account_id, snapshot_date)
      )`,
      `CREATE TABLE IF NOT EXISTS portfolio_snapshot_items (
        snapshot_id INTEGER NOT NULL REFERENCES portfolio_snapshots(id) ON DELETE CASCADE,
        symbol TEXT NOT NULL,
        name TEXT NOT NULL,
        market TEXT NOT NULL,
        currency TEXT NOT NULL CHECK(currency IN ('KRW', 'USD')),
        evaluation_amount REAL NOT NULL,
        weight_percent REAL NOT NULL,
        PRIMARY KEY(snapshot_id, market, symbol, currency)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_snapshots_account_date
        ON portfolio_snapshots(account_id, snapshot_date)`,
      `CREATE TABLE IF NOT EXISTS portfolio_orders (
        account_id TEXT NOT NULL,
        order_id TEXT NOT NULL,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL,
        currency TEXT NOT NULL,
        status TEXT NOT NULL,
        ordered_at TEXT NOT NULL,
        filled_at TEXT NOT NULL,
        filled_quantity REAL NOT NULL,
        average_filled_price REAL NOT NULL,
        filled_amount REAL NOT NULL,
        commission REAL NOT NULL,
        tax REAL NOT NULL,
        fetched_at INTEGER NOT NULL,
        PRIMARY KEY(account_id, order_id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_orders_account_filled_at
        ON portfolio_orders(account_id, filled_at)`,
      `CREATE TABLE IF NOT EXISTS portfolio_instruments (
        instrument_key TEXT PRIMARY KEY,
        symbol TEXT NOT NULL,
        name TEXT NOT NULL,
        market TEXT NOT NULL,
        currency TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS portfolio_daily_prices (
        instrument_key TEXT NOT NULL REFERENCES portfolio_instruments(instrument_key) ON DELETE CASCADE,
        price_date TEXT NOT NULL,
        open_price REAL,
        high_price REAL,
        low_price REAL,
        close_price REAL NOT NULL,
        currency TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(instrument_key, price_date)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_daily_prices_key_date
        ON portfolio_daily_prices(instrument_key, price_date)`,
      `CREATE TABLE IF NOT EXISTS portfolio_backtest_prices (
        instrument_key TEXT NOT NULL,
        price_date TEXT NOT NULL,
        close_price REAL NOT NULL,
        currency TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(instrument_key, price_date)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_backtest_prices_key_date
        ON portfolio_backtest_prices(instrument_key, price_date)`,
      `CREATE TABLE IF NOT EXISTS portfolio_benchmark_prices (
        benchmark_key TEXT NOT NULL,
        price_date TEXT NOT NULL,
        close_price REAL NOT NULL,
        timestamp TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(benchmark_key, price_date)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_benchmark_prices_key_date
        ON portfolio_benchmark_prices(benchmark_key, price_date)`,
      `CREATE TABLE IF NOT EXISTS portfolio_exchange_rates (
        rate_date TEXT NOT NULL,
        base_currency TEXT NOT NULL,
        quote_currency TEXT NOT NULL,
        rate REAL NOT NULL,
        timestamp TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(rate_date, base_currency, quote_currency)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_exchange_rates_pair_date
        ON portfolio_exchange_rates(base_currency, quote_currency, rate_date)`,
      `CREATE TABLE IF NOT EXISTS portfolio_backfill_state (
        account_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        phase TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        updated_at TEXT NOT NULL,
        first_trade_date TEXT,
        last_backfilled_date TEXT,
        orders_imported INTEGER NOT NULL DEFAULT 0,
        symbols_total INTEGER NOT NULL DEFAULT 0,
        symbols_processed INTEGER NOT NULL DEFAULT 0,
        prices_imported INTEGER NOT NULL DEFAULT 0,
        snapshots_created INTEGER NOT NULL DEFAULT 0,
        reconciled_symbols INTEGER NOT NULL DEFAULT 0,
        discrepancy_symbols INTEGER NOT NULL DEFAULT 0,
        failed_symbols INTEGER NOT NULL DEFAULT 0,
        message TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS portfolio_cash_ledger (
        account_id TEXT NOT NULL,
        entry_id TEXT NOT NULL,
        transaction_date TEXT NOT NULL,
        transaction_time TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        title TEXT NOT NULL,
        category TEXT NOT NULL,
        kind TEXT NOT NULL,
        currency TEXT NOT NULL,
        amount REAL NOT NULL,
        balance REAL NOT NULL,
        instrument_name TEXT,
        quantity REAL,
        source TEXT NOT NULL DEFAULT 'WTS_PASTE',
        imported_at INTEGER NOT NULL,
        PRIMARY KEY(account_id, entry_id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_cash_ledger_account_date
        ON portfolio_cash_ledger(account_id, transaction_date, transaction_time)`,
      `CREATE TABLE IF NOT EXISTS portfolio_market_candles (
        source_kind TEXT NOT NULL,
        symbol TEXT NOT NULL,
        candle_interval TEXT NOT NULL,
        adjusted INTEGER NOT NULL,
        price_date TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        currency TEXT NOT NULL,
        open_price REAL NOT NULL,
        high_price REAL NOT NULL,
        low_price REAL NOT NULL,
        close_price REAL NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(source_kind, symbol, candle_interval, adjusted, timestamp)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_market_candles_lookup
        ON portfolio_market_candles(source_kind, symbol, candle_interval, adjusted, price_date)`,
      `CREATE TABLE IF NOT EXISTS portfolio_candle_responses (
        request_key TEXT PRIMARY KEY,
        feature TEXT NOT NULL,
        request_path TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        symbol TEXT NOT NULL,
        candle_interval TEXT NOT NULL,
        adjusted INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        fetched_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS portfolio_storage_meta (
        meta_key TEXT PRIMARY KEY,
        meta_value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
    ];
    const mysqlSchema = [
      `CREATE TABLE IF NOT EXISTS portfolio_snapshots (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        account_id VARCHAR(128) NOT NULL,
        snapshot_date CHAR(10) NOT NULL,
        captured_at BIGINT NOT NULL,
        origin VARCHAR(16) NOT NULL DEFAULT 'LIVE',
        UNIQUE KEY uq_snapshots_account_date (account_id, snapshot_date),
        KEY idx_snapshots_account_date (account_id, snapshot_date)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      `CREATE TABLE IF NOT EXISTS portfolio_snapshot_items (
        snapshot_id BIGINT UNSIGNED NOT NULL,
        symbol VARCHAR(64) NOT NULL,
        name VARCHAR(255) NOT NULL,
        market VARCHAR(64) NOT NULL,
        currency VARCHAR(8) NOT NULL,
        evaluation_amount DOUBLE NOT NULL,
        weight_percent DOUBLE NOT NULL,
        PRIMARY KEY(snapshot_id, market, symbol, currency),
        CONSTRAINT fk_snapshot_items_snapshot FOREIGN KEY(snapshot_id)
          REFERENCES portfolio_snapshots(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      `CREATE TABLE IF NOT EXISTS portfolio_orders (
        account_id VARCHAR(128) NOT NULL,
        order_id VARCHAR(128) NOT NULL,
        symbol VARCHAR(64) NOT NULL,
        side VARCHAR(16) NOT NULL,
        currency VARCHAR(8) NOT NULL,
        status VARCHAR(32) NOT NULL,
        ordered_at VARCHAR(64) NOT NULL,
        filled_at VARCHAR(64) NOT NULL,
        filled_quantity DOUBLE NOT NULL,
        average_filled_price DOUBLE NOT NULL,
        filled_amount DOUBLE NOT NULL,
        commission DOUBLE NOT NULL,
        tax DOUBLE NOT NULL,
        fetched_at BIGINT NOT NULL,
        PRIMARY KEY(account_id, order_id),
        KEY idx_orders_account_filled_at (account_id, filled_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      `CREATE TABLE IF NOT EXISTS portfolio_instruments (
        instrument_key VARCHAR(96) NOT NULL PRIMARY KEY,
        symbol VARCHAR(64) NOT NULL,
        name VARCHAR(255) NOT NULL,
        market VARCHAR(64) NOT NULL,
        currency VARCHAR(8) NOT NULL,
        updated_at BIGINT NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      `CREATE TABLE IF NOT EXISTS portfolio_daily_prices (
        instrument_key VARCHAR(96) NOT NULL,
        price_date CHAR(10) NOT NULL,
        open_price DOUBLE NULL,
        high_price DOUBLE NULL,
        low_price DOUBLE NULL,
        close_price DOUBLE NOT NULL,
        currency VARCHAR(8) NOT NULL,
        timestamp VARCHAR(64) NOT NULL,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY(instrument_key, price_date),
        KEY idx_daily_prices_key_date (instrument_key, price_date),
        CONSTRAINT fk_daily_prices_instrument FOREIGN KEY(instrument_key)
          REFERENCES portfolio_instruments(instrument_key) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      `CREATE TABLE IF NOT EXISTS portfolio_backtest_prices (
        instrument_key VARCHAR(96) NOT NULL,
        price_date CHAR(10) NOT NULL,
        close_price DOUBLE NOT NULL,
        currency VARCHAR(8) NOT NULL,
        timestamp VARCHAR(64) NOT NULL,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY(instrument_key, price_date),
        KEY idx_backtest_prices_key_date (instrument_key, price_date)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      `CREATE TABLE IF NOT EXISTS portfolio_benchmark_prices (
        benchmark_key VARCHAR(32) NOT NULL,
        price_date CHAR(10) NOT NULL,
        close_price DOUBLE NOT NULL,
        timestamp VARCHAR(64) NOT NULL,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY(benchmark_key, price_date),
        KEY idx_benchmark_prices_key_date (benchmark_key, price_date)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      `CREATE TABLE IF NOT EXISTS portfolio_exchange_rates (
        rate_date CHAR(10) NOT NULL,
        base_currency VARCHAR(8) NOT NULL,
        quote_currency VARCHAR(8) NOT NULL,
        rate DOUBLE NOT NULL,
        timestamp VARCHAR(64) NOT NULL,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY(rate_date, base_currency, quote_currency),
        KEY idx_exchange_rates_pair_date (base_currency, quote_currency, rate_date)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      `CREATE TABLE IF NOT EXISTS portfolio_backfill_state (
        account_id VARCHAR(128) NOT NULL PRIMARY KEY,
        status VARCHAR(16) NOT NULL,
        phase VARCHAR(24) NOT NULL,
        started_at VARCHAR(64) NULL,
        completed_at VARCHAR(64) NULL,
        updated_at VARCHAR(64) NOT NULL,
        first_trade_date CHAR(10) NULL,
        last_backfilled_date CHAR(10) NULL,
        orders_imported BIGINT NOT NULL DEFAULT 0,
        symbols_total BIGINT NOT NULL DEFAULT 0,
        symbols_processed BIGINT NOT NULL DEFAULT 0,
        prices_imported BIGINT NOT NULL DEFAULT 0,
        snapshots_created BIGINT NOT NULL DEFAULT 0,
        reconciled_symbols BIGINT NOT NULL DEFAULT 0,
        discrepancy_symbols BIGINT NOT NULL DEFAULT 0,
        failed_symbols BIGINT NOT NULL DEFAULT 0,
        message TEXT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      `CREATE TABLE IF NOT EXISTS portfolio_cash_ledger (
        account_id VARCHAR(128) NOT NULL,
        entry_id VARCHAR(128) NOT NULL,
        transaction_date CHAR(10) NOT NULL,
        transaction_time CHAR(5) NOT NULL,
        occurred_at VARCHAR(64) NOT NULL,
        title VARCHAR(255) NOT NULL,
        category VARCHAR(64) NOT NULL,
        kind VARCHAR(64) NOT NULL,
        currency VARCHAR(8) NOT NULL,
        amount DOUBLE NOT NULL,
        balance DOUBLE NOT NULL,
        instrument_name VARCHAR(255) NULL,
        quantity DOUBLE NULL,
        source VARCHAR(32) NOT NULL DEFAULT 'WTS_PASTE',
        imported_at BIGINT NOT NULL,
        PRIMARY KEY(account_id, entry_id),
        KEY idx_cash_ledger_account_date (account_id, transaction_date, transaction_time)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      `CREATE TABLE IF NOT EXISTS portfolio_market_candles (
        source_kind VARCHAR(16) NOT NULL,
        symbol VARCHAR(64) NOT NULL,
        candle_interval VARCHAR(8) NOT NULL,
        adjusted TINYINT UNSIGNED NOT NULL,
        price_date CHAR(10) NOT NULL,
        timestamp VARCHAR(64) NOT NULL,
        currency VARCHAR(8) NOT NULL,
        open_price DOUBLE NOT NULL,
        high_price DOUBLE NOT NULL,
        low_price DOUBLE NOT NULL,
        close_price DOUBLE NOT NULL,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY(source_kind, symbol, candle_interval, adjusted, timestamp),
        KEY idx_market_candles_lookup (source_kind, symbol, candle_interval, adjusted, price_date)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      `CREATE TABLE IF NOT EXISTS portfolio_candle_responses (
        request_key CHAR(64) NOT NULL PRIMARY KEY,
        feature VARCHAR(32) NOT NULL,
        request_path VARCHAR(512) NOT NULL,
        source_kind VARCHAR(16) NOT NULL,
        symbol VARCHAR(64) NOT NULL,
        candle_interval VARCHAR(8) NOT NULL,
        adjusted TINYINT UNSIGNED NOT NULL,
        payload_json LONGTEXT NOT NULL,
        fetched_at BIGINT NOT NULL,
        expires_at BIGINT NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      `CREATE TABLE IF NOT EXISTS portfolio_storage_meta (
        meta_key VARCHAR(191) NOT NULL PRIMARY KEY,
        meta_value TEXT NOT NULL,
        updated_at VARCHAR(64) NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    ];
    const postgresSchema = [
      `CREATE TABLE IF NOT EXISTS portfolio_snapshots (
        id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
        account_id VARCHAR(128) NOT NULL,
        snapshot_date CHAR(10) NOT NULL,
        captured_at BIGINT NOT NULL,
        origin VARCHAR(16) NOT NULL DEFAULT 'LIVE',
        UNIQUE(account_id, snapshot_date)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_snapshots_account_date
        ON portfolio_snapshots(account_id, snapshot_date)`,
      `CREATE TABLE IF NOT EXISTS portfolio_snapshot_items (
        snapshot_id BIGINT NOT NULL REFERENCES portfolio_snapshots(id) ON DELETE CASCADE,
        symbol VARCHAR(64) NOT NULL,
        name VARCHAR(255) NOT NULL,
        market VARCHAR(64) NOT NULL,
        currency VARCHAR(8) NOT NULL,
        evaluation_amount DOUBLE PRECISION NOT NULL,
        weight_percent DOUBLE PRECISION NOT NULL,
        PRIMARY KEY(snapshot_id, market, symbol, currency)
      )`,
      `CREATE TABLE IF NOT EXISTS portfolio_orders (
        account_id VARCHAR(128) NOT NULL,
        order_id VARCHAR(128) NOT NULL,
        symbol VARCHAR(64) NOT NULL,
        side VARCHAR(16) NOT NULL,
        currency VARCHAR(8) NOT NULL,
        status VARCHAR(32) NOT NULL,
        ordered_at VARCHAR(64) NOT NULL,
        filled_at VARCHAR(64) NOT NULL,
        filled_quantity DOUBLE PRECISION NOT NULL,
        average_filled_price DOUBLE PRECISION NOT NULL,
        filled_amount DOUBLE PRECISION NOT NULL,
        commission DOUBLE PRECISION NOT NULL,
        tax DOUBLE PRECISION NOT NULL,
        fetched_at BIGINT NOT NULL,
        PRIMARY KEY(account_id, order_id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_orders_account_filled_at
        ON portfolio_orders(account_id, filled_at)`,
      `CREATE TABLE IF NOT EXISTS portfolio_instruments (
        instrument_key VARCHAR(96) PRIMARY KEY,
        symbol VARCHAR(64) NOT NULL,
        name VARCHAR(255) NOT NULL,
        market VARCHAR(64) NOT NULL,
        currency VARCHAR(8) NOT NULL,
        updated_at BIGINT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS portfolio_daily_prices (
        instrument_key VARCHAR(96) NOT NULL REFERENCES portfolio_instruments(instrument_key) ON DELETE CASCADE,
        price_date CHAR(10) NOT NULL,
        open_price DOUBLE PRECISION,
        high_price DOUBLE PRECISION,
        low_price DOUBLE PRECISION,
        close_price DOUBLE PRECISION NOT NULL,
        currency VARCHAR(8) NOT NULL,
        timestamp VARCHAR(64) NOT NULL,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY(instrument_key, price_date)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_daily_prices_key_date
        ON portfolio_daily_prices(instrument_key, price_date)`,
      `CREATE TABLE IF NOT EXISTS portfolio_backtest_prices (
        instrument_key VARCHAR(96) NOT NULL,
        price_date CHAR(10) NOT NULL,
        close_price DOUBLE PRECISION NOT NULL,
        currency VARCHAR(8) NOT NULL,
        timestamp VARCHAR(64) NOT NULL,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY(instrument_key, price_date)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_backtest_prices_key_date
        ON portfolio_backtest_prices(instrument_key, price_date)`,
      `CREATE TABLE IF NOT EXISTS portfolio_benchmark_prices (
        benchmark_key VARCHAR(32) NOT NULL,
        price_date CHAR(10) NOT NULL,
        close_price DOUBLE PRECISION NOT NULL,
        timestamp VARCHAR(64) NOT NULL,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY(benchmark_key, price_date)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_benchmark_prices_key_date
        ON portfolio_benchmark_prices(benchmark_key, price_date)`,
      `CREATE TABLE IF NOT EXISTS portfolio_exchange_rates (
        rate_date CHAR(10) NOT NULL,
        base_currency VARCHAR(8) NOT NULL,
        quote_currency VARCHAR(8) NOT NULL,
        rate DOUBLE PRECISION NOT NULL,
        timestamp VARCHAR(64) NOT NULL,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY(rate_date, base_currency, quote_currency)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_exchange_rates_pair_date
        ON portfolio_exchange_rates(base_currency, quote_currency, rate_date)`,
      `CREATE TABLE IF NOT EXISTS portfolio_backfill_state (
        account_id VARCHAR(128) PRIMARY KEY,
        status VARCHAR(16) NOT NULL,
        phase VARCHAR(24) NOT NULL,
        started_at VARCHAR(64),
        completed_at VARCHAR(64),
        updated_at VARCHAR(64) NOT NULL,
        first_trade_date CHAR(10),
        last_backfilled_date CHAR(10),
        orders_imported BIGINT NOT NULL DEFAULT 0,
        symbols_total BIGINT NOT NULL DEFAULT 0,
        symbols_processed BIGINT NOT NULL DEFAULT 0,
        prices_imported BIGINT NOT NULL DEFAULT 0,
        snapshots_created BIGINT NOT NULL DEFAULT 0,
        reconciled_symbols BIGINT NOT NULL DEFAULT 0,
        discrepancy_symbols BIGINT NOT NULL DEFAULT 0,
        failed_symbols BIGINT NOT NULL DEFAULT 0,
        message TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS portfolio_cash_ledger (
        account_id VARCHAR(128) NOT NULL,
        entry_id VARCHAR(128) NOT NULL,
        transaction_date CHAR(10) NOT NULL,
        transaction_time CHAR(5) NOT NULL,
        occurred_at VARCHAR(64) NOT NULL,
        title VARCHAR(255) NOT NULL,
        category VARCHAR(64) NOT NULL,
        kind VARCHAR(64) NOT NULL,
        currency VARCHAR(8) NOT NULL,
        amount DOUBLE PRECISION NOT NULL,
        balance DOUBLE PRECISION NOT NULL,
        instrument_name VARCHAR(255),
        quantity DOUBLE PRECISION,
        source VARCHAR(32) NOT NULL DEFAULT 'WTS_PASTE',
        imported_at BIGINT NOT NULL,
        PRIMARY KEY(account_id, entry_id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_cash_ledger_account_date
        ON portfolio_cash_ledger(account_id, transaction_date, transaction_time)`,
      `CREATE TABLE IF NOT EXISTS portfolio_market_candles (
        source_kind VARCHAR(16) NOT NULL,
        symbol VARCHAR(64) NOT NULL,
        candle_interval VARCHAR(8) NOT NULL,
        adjusted SMALLINT NOT NULL,
        price_date CHAR(10) NOT NULL,
        timestamp VARCHAR(64) NOT NULL,
        currency VARCHAR(8) NOT NULL,
        open_price DOUBLE PRECISION NOT NULL,
        high_price DOUBLE PRECISION NOT NULL,
        low_price DOUBLE PRECISION NOT NULL,
        close_price DOUBLE PRECISION NOT NULL,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY(source_kind, symbol, candle_interval, adjusted, timestamp)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_market_candles_lookup
        ON portfolio_market_candles(source_kind, symbol, candle_interval, adjusted, price_date)`,
      `CREATE TABLE IF NOT EXISTS portfolio_candle_responses (
        request_key CHAR(64) PRIMARY KEY,
        feature VARCHAR(32) NOT NULL,
        request_path VARCHAR(512) NOT NULL,
        source_kind VARCHAR(16) NOT NULL,
        symbol VARCHAR(64) NOT NULL,
        candle_interval VARCHAR(8) NOT NULL,
        adjusted SMALLINT NOT NULL,
        payload_json TEXT NOT NULL,
        fetched_at BIGINT NOT NULL,
        expires_at BIGINT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS portfolio_storage_meta (
        meta_key VARCHAR(191) PRIMARY KEY,
        meta_value TEXT NOT NULL,
        updated_at VARCHAR(64) NOT NULL
      )`,
    ];

    const schema = this.db.dialect === "mysql"
      ? mysqlSchema
      : this.db.dialect === "postgres"
        ? postgresSchema
        : sqliteSchema;
    for (const statement of schema) {
      await this.db.run(statement);
    }
    if (this.db.dialect === "sqlite") {
      const snapshotColumns = await this.db.query<{ name: string }>("PRAGMA table_info(portfolio_snapshots)");
      if (!snapshotColumns.some((column) => column.name === "origin")) {
        await this.db.run("ALTER TABLE portfolio_snapshots ADD COLUMN origin TEXT NOT NULL DEFAULT 'LIVE'");
      }
      const priceColumns = await this.db.query<{ name: string }>("PRAGMA table_info(portfolio_daily_prices)");
      for (const column of ["open_price", "high_price", "low_price"]) {
        if (!priceColumns.some((candidate) => candidate.name === column)) {
          await this.db.run(`ALTER TABLE portfolio_daily_prices ADD COLUMN ${column} REAL`);
        }
      }
    }
    await this.backfillCommonCandles();
  }

  private async backfillCommonCandles(): Promise<void> {
    const conflict = this.db.dialect === "mysql" ? "INSERT IGNORE" : "INSERT";
    const suffix = this.db.dialect === "mysql" ? "" : " ON CONFLICT DO NOTHING";
    await this.db.run(`
      ${conflict} INTO portfolio_market_candles (
        source_kind, symbol, candle_interval, adjusted, price_date, timestamp, currency,
        open_price, high_price, low_price, close_price, updated_at
      )
      SELECT 'stock', instruments.symbol, '1d', 0, prices.price_date, prices.timestamp, prices.currency,
             COALESCE(prices.open_price, prices.close_price),
             COALESCE(prices.high_price, prices.close_price),
             COALESCE(prices.low_price, prices.close_price),
             prices.close_price, prices.updated_at
      FROM portfolio_daily_prices AS prices
      JOIN portfolio_instruments AS instruments ON instruments.instrument_key = prices.instrument_key
      WHERE 1 = 1${suffix}
    `);

    const backtestSymbol = this.db.dialect === "mysql"
      ? "SUBSTRING_INDEX(prices.instrument_key, ':', -1)"
      : this.db.dialect === "postgres"
        ? "SPLIT_PART(prices.instrument_key, ':', 2)"
        : "CASE WHEN INSTR(prices.instrument_key, ':') > 0 THEN SUBSTR(prices.instrument_key, INSTR(prices.instrument_key, ':') + 1) ELSE prices.instrument_key END";
    await this.db.run(`
      ${conflict} INTO portfolio_market_candles (
        source_kind, symbol, candle_interval, adjusted, price_date, timestamp, currency,
        open_price, high_price, low_price, close_price, updated_at
      )
      SELECT 'stock', ${backtestSymbol}, '1d', 1, prices.price_date, prices.timestamp, prices.currency,
             prices.close_price, prices.close_price, prices.close_price, prices.close_price, prices.updated_at
      FROM portfolio_backtest_prices AS prices
      WHERE 1 = 1${suffix}
    `);

    await this.db.run(`
      ${conflict} INTO portfolio_market_candles (
        source_kind, symbol, candle_interval, adjusted, price_date, timestamp, currency,
        open_price, high_price, low_price, close_price, updated_at
      )
      SELECT CASE WHEN benchmark_key IN ('KOSPI', 'KOSDAQ') THEN 'indicator' ELSE 'stock' END,
             CASE benchmark_key WHEN 'NASDAQ100' THEN 'QQQ' WHEN 'SP500' THEN 'SPY' ELSE benchmark_key END,
             '1d', CASE WHEN benchmark_key IN ('KOSPI', 'KOSDAQ') THEN 0 ELSE 1 END,
             price_date, timestamp, '', close_price, close_price, close_price, close_price, updated_at
      FROM portfolio_benchmark_prices
      WHERE 1 = 1${suffix}
    `);
  }

  close(): Promise<void> {
    return this.db.close();
  }

  private sql(sqlite: string, mysql: string): string {
    return this.db.dialect === "mysql" ? mysql : sqlite;
  }

  private async hasTable(table: string): Promise<boolean> {
    const rows = this.db.dialect === "mysql"
      ? await this.db.query<DatabaseRow>(`
          SELECT 1 AS present FROM information_schema.tables
          WHERE table_schema = DATABASE() AND table_name = ? LIMIT 1
        `, [table])
      : this.db.dialect === "postgres"
        ? await this.db.query<DatabaseRow>(`
          SELECT 1 AS present FROM information_schema.tables
          WHERE table_schema = current_schema() AND table_name = ? LIMIT 1
        `, [table])
        : await this.db.query<DatabaseRow>(`
          SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1
        `, [table]);
    return rows.length > 0;
  }

  async migrationFingerprint(): Promise<string> {
    const signatures = await Promise.all([
      this.db.query<DatabaseRow>("SELECT COUNT(*) AS count, COALESCE(MAX(updated_at), 0) AS max_value FROM portfolio_instruments"),
      this.db.query<DatabaseRow>("SELECT COUNT(*) AS count, COALESCE(MAX(fetched_at), 0) AS max_value, COALESCE(SUM(filled_amount), 0) AS sum_value FROM portfolio_orders"),
      this.db.query<DatabaseRow>("SELECT COUNT(*) AS count, COALESCE(MAX(captured_at), 0) AS max_value FROM portfolio_snapshots"),
      this.db.query<DatabaseRow>("SELECT COUNT(*) AS count, COALESCE(SUM(evaluation_amount), 0) AS sum_value, COALESCE(SUM(weight_percent), 0) AS sum_weight FROM portfolio_snapshot_items"),
      this.db.query<DatabaseRow>("SELECT COUNT(*) AS count, COALESCE(MAX(updated_at), 0) AS max_value, COALESCE(SUM(close_price), 0) AS sum_value FROM portfolio_daily_prices"),
      this.db.query<DatabaseRow>("SELECT COUNT(*) AS count, COALESCE(MAX(updated_at), 0) AS max_value, COALESCE(SUM(close_price), 0) AS sum_value FROM portfolio_backtest_prices"),
      this.db.query<DatabaseRow>("SELECT COUNT(*) AS count, COALESCE(MAX(updated_at), 0) AS max_value, COALESCE(SUM(close_price), 0) AS sum_value FROM portfolio_benchmark_prices"),
      this.db.query<DatabaseRow>("SELECT COUNT(*) AS count, COALESCE(MAX(updated_at), 0) AS max_value, COALESCE(SUM(rate), 0) AS sum_value FROM portfolio_exchange_rates"),
      this.db.query<DatabaseRow>("SELECT COUNT(*) AS count, COALESCE(MAX(updated_at), '') AS max_value FROM portfolio_backfill_state"),
      this.db.query<DatabaseRow>("SELECT COUNT(*) AS count, COALESCE(MAX(updated_at), 0) AS max_value, COALESCE(SUM(close_price), 0) AS sum_value FROM portfolio_market_candles"),
      this.db.query<DatabaseRow>("SELECT COUNT(*) AS count, COALESCE(MAX(fetched_at), 0) AS max_value FROM portfolio_candle_responses"),
    ]);
    if (await this.hasTable("portfolio_cash_ledger")) {
      signatures.push(await this.db.query<DatabaseRow>(
        "SELECT COUNT(*) AS count, COALESCE(MAX(imported_at), 0) AS max_value, COALESCE(SUM(amount), 0) AS sum_value FROM portfolio_cash_ledger",
      ));
    }
    return createHash("sha256").update(JSON.stringify(signatures.map(([row]) => row ?? {}))).digest("hex");
  }

  private marketCandleStatement(): string {
    return this.sql(`
      INSERT INTO portfolio_market_candles (
        source_kind, symbol, candle_interval, adjusted, price_date, timestamp, currency,
        open_price, high_price, low_price, close_price, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_kind, symbol, candle_interval, adjusted, timestamp) DO UPDATE SET
        price_date = excluded.price_date,
        currency = excluded.currency,
        open_price = excluded.open_price,
        high_price = excluded.high_price,
        low_price = excluded.low_price,
        close_price = excluded.close_price,
        updated_at = excluded.updated_at
    `, `
      INSERT INTO portfolio_market_candles (
        source_kind, symbol, candle_interval, adjusted, price_date, timestamp, currency,
        open_price, high_price, low_price, close_price, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        price_date = VALUES(price_date), currency = VALUES(currency), open_price = VALUES(open_price),
        high_price = VALUES(high_price), low_price = VALUES(low_price), close_price = VALUES(close_price),
        updated_at = VALUES(updated_at)
    `);
  }

  private async writeMarketCandles(
    database: RelationalDatabase,
    source: MarketCandleSource,
    symbol: string,
    interval: "1m" | "1d",
    adjusted: boolean,
    candles: DailyCandle[],
    updatedAt: number,
  ): Promise<void> {
    const statement = this.marketCandleStatement();
    for (const candle of candles) {
      await database.run(statement, [
        source,
        symbol,
        interval,
        adjusted ? 1 : 0,
        candle.date,
        candle.timestamp,
        candle.currency,
        candle.openPrice,
        candle.highPrice,
        candle.lowPrice,
        candle.closePrice,
        updatedAt,
      ]);
    }
  }

  async upsertMarketCandles(
    source: MarketCandleSource,
    symbol: string,
    interval: "1m" | "1d",
    adjusted: boolean,
    candles: DailyCandle[],
    updatedAt = Date.now(),
  ): Promise<number> {
    await this.db.transaction((database) => (
      this.writeMarketCandles(database, source, symbol, interval, adjusted, candles, updatedAt)
    ));
    return candles.length;
  }

  async getCachedCandleResponse(requestKey: string, now = Date.now()): Promise<unknown | undefined> {
    const [row] = await this.db.query<{ payload_json: string; expires_at: number }>(`
      SELECT payload_json, expires_at
      FROM portfolio_candle_responses
      WHERE request_key = ? AND (expires_at = 0 OR expires_at > ?)
    `, [requestKey, now]);
    if (!row) return undefined;
    try {
      return JSON.parse(row.payload_json);
    } catch {
      return undefined;
    }
  }

  async cacheCandleResponse(input: MarketCandleCacheInput): Promise<void> {
    const responseStatement = this.sql(`
      INSERT INTO portfolio_candle_responses (
        request_key, feature, request_path, source_kind, symbol, candle_interval, adjusted,
        payload_json, fetched_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(request_key) DO UPDATE SET
        feature = excluded.feature,
        request_path = excluded.request_path,
        source_kind = excluded.source_kind,
        symbol = excluded.symbol,
        candle_interval = excluded.candle_interval,
        adjusted = excluded.adjusted,
        payload_json = excluded.payload_json,
        fetched_at = excluded.fetched_at,
        expires_at = excluded.expires_at
    `, `
      INSERT INTO portfolio_candle_responses (
        request_key, feature, request_path, source_kind, symbol, candle_interval, adjusted,
        payload_json, fetched_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        feature = VALUES(feature), request_path = VALUES(request_path), source_kind = VALUES(source_kind),
        symbol = VALUES(symbol), candle_interval = VALUES(candle_interval), adjusted = VALUES(adjusted),
        payload_json = VALUES(payload_json), fetched_at = VALUES(fetched_at), expires_at = VALUES(expires_at)
    `);
    await this.db.transaction(async (database) => {
      await this.writeMarketCandles(
        database,
        input.source,
        input.symbol,
        input.interval,
        input.adjusted,
        input.candles,
        input.fetchedAt,
      );
      await database.run(responseStatement, [
        input.requestKey,
        input.feature,
        input.requestPath,
        input.source,
        input.symbol,
        input.interval,
        input.adjusted ? 1 : 0,
        JSON.stringify(input.payload),
        input.fetchedAt,
        input.expiresAt,
      ]);
    });
  }

  async getMarketCandleCount(): Promise<number> {
    const [row] = await this.db.query<{ count: number }>("SELECT COUNT(*) AS count FROM portfolio_market_candles");
    return Number(row?.count ?? 0);
  }

  async recordPortfolio(portfolio: Portfolio, capturedAt = new Date()): Promise<void> {
    const snapshotDate = kstDateString(capturedAt);
    const capturedAtMs = capturedAt.getTime();
    const eligible = portfolio.holdings.filter(
      (holding) => (holding.currency === "KRW" || holding.currency === "USD") && holding.evaluationAmount > 0,
    );
    const totals = eligible.reduce<Record<HistoryCurrency, number>>(
      (result, holding) => {
        result[holding.currency as HistoryCurrency] += holding.evaluationAmount;
        return result;
      },
      { KRW: 0, USD: 0 },
    );

    await this.db.transaction(async (database) => {
      await database.run(this.sql(`
        INSERT INTO portfolio_snapshots (account_id, snapshot_date, captured_at, origin)
        VALUES (?, ?, ?, 'LIVE')
        ON CONFLICT(account_id, snapshot_date)
        DO UPDATE SET captured_at = excluded.captured_at, origin = 'LIVE'
      `, `
        INSERT INTO portfolio_snapshots (account_id, snapshot_date, captured_at, origin)
        VALUES (?, ?, ?, 'LIVE')
        ON DUPLICATE KEY UPDATE captured_at = VALUES(captured_at), origin = 'LIVE'
      `), [portfolio.selectedAccountId, snapshotDate, capturedAtMs]);

      const [snapshot] = await database.query<SnapshotRow & DatabaseRow>(`
        SELECT id, snapshot_date, captured_at
        FROM portfolio_snapshots
        WHERE account_id = ? AND snapshot_date = ?
      `, [portfolio.selectedAccountId, snapshotDate]);
      if (!snapshot) throw new Error("일별 포트폴리오 스냅샷을 생성하지 못했습니다.");

      await database.run("DELETE FROM portfolio_snapshot_items WHERE snapshot_id = ?", [snapshot.id]);
      const insert = `
        INSERT INTO portfolio_snapshot_items (
          snapshot_id, symbol, name, market, currency, evaluation_amount, weight_percent
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `;
      for (const holding of eligible) {
        const currency = holding.currency as HistoryCurrency;
        await database.run(insert, [
          snapshot.id,
          holding.symbol,
          holding.name,
          holding.market,
          currency,
          holding.evaluationAmount,
          round((holding.evaluationAmount / totals[currency]) * 100),
        ]);
      }
    });
  }

  async upsertOrders(accountId: string, orders: HistoricalOrder[], fetchedAt = Date.now()): Promise<number> {
    const statement = this.sql(`
      INSERT INTO portfolio_orders (
        account_id, order_id, symbol, side, currency, status, ordered_at, filled_at,
        filled_quantity, average_filled_price, filled_amount, commission, tax, fetched_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, order_id) DO UPDATE SET
        symbol = excluded.symbol,
        side = excluded.side,
        currency = excluded.currency,
        status = excluded.status,
        ordered_at = excluded.ordered_at,
        filled_at = excluded.filled_at,
        filled_quantity = excluded.filled_quantity,
        average_filled_price = excluded.average_filled_price,
        filled_amount = excluded.filled_amount,
        commission = excluded.commission,
        tax = excluded.tax,
        fetched_at = excluded.fetched_at
    `, `
      INSERT INTO portfolio_orders (
        account_id, order_id, symbol, side, currency, status, ordered_at, filled_at,
        filled_quantity, average_filled_price, filled_amount, commission, tax, fetched_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        symbol = VALUES(symbol), side = VALUES(side), currency = VALUES(currency), status = VALUES(status),
        ordered_at = VALUES(ordered_at), filled_at = VALUES(filled_at),
        filled_quantity = VALUES(filled_quantity), average_filled_price = VALUES(average_filled_price),
        filled_amount = VALUES(filled_amount), commission = VALUES(commission), tax = VALUES(tax),
        fetched_at = VALUES(fetched_at)
    `);
    await this.db.transaction(async (database) => {
      for (const order of orders) {
        await database.run(statement, [
          accountId,
          order.orderId,
          order.symbol,
          order.side,
          order.currency,
          order.status,
          order.orderedAt,
          order.filledAt,
          order.filledQuantity,
          order.averageFilledPrice,
          order.filledAmount,
          order.commission,
          order.tax,
          fetchedAt,
        ]);
      }
    });
    return orders.length;
  }

  async getOrders(accountId: string): Promise<HistoricalOrder[]> {
    const rows = await this.db.query<Record<string, string | number>>(`
      SELECT order_id, symbol, side, currency, status, ordered_at, filled_at,
             filled_quantity, average_filled_price, filled_amount, commission, tax
      FROM portfolio_orders
      WHERE account_id = ?
      ORDER BY COALESCE(NULLIF(filled_at, ''), ordered_at) ASC, order_id ASC
    `, [accountId]);
    return rows.map((row) => ({
      orderId: String(row.order_id),
      symbol: String(row.symbol),
      side: String(row.side),
      currency: String(row.currency),
      status: String(row.status),
      orderedAt: String(row.ordered_at),
      filledAt: String(row.filled_at),
      filledQuantity: Number(row.filled_quantity),
      averageFilledPrice: Number(row.average_filled_price),
      filledAmount: Number(row.filled_amount),
      commission: Number(row.commission),
      tax: Number(row.tax),
    }));
  }

  async upsertInstruments(instruments: InstrumentInfo[], updatedAt = Date.now()): Promise<number> {
    const statement = this.sql(`
      INSERT INTO portfolio_instruments (instrument_key, symbol, name, market, currency, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(instrument_key) DO UPDATE SET
        name = excluded.name,
        market = excluded.market,
        updated_at = excluded.updated_at
    `, `
      INSERT INTO portfolio_instruments (instrument_key, symbol, name, market, currency, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        name = VALUES(name), market = VALUES(market), currency = VALUES(currency), updated_at = VALUES(updated_at)
    `);
    await this.db.transaction(async (database) => {
      for (const instrument of instruments) {
        await database.run(statement, [
          `${instrument.currency}:${instrument.symbol}`,
          instrument.symbol,
          instrument.name || instrument.symbol,
          instrument.market || (instrument.currency === "USD" ? "미국" : "KRX"),
          instrument.currency,
          updatedAt,
        ]);
      }
    });
    return instruments.length;
  }

  async upsertDailyPrices(instrumentKey: string, candles: DailyCandle[], updatedAt = Date.now()): Promise<number> {
    const statement = this.sql(`
      INSERT INTO portfolio_daily_prices (
        instrument_key, price_date, open_price, high_price, low_price, close_price, currency, timestamp, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(instrument_key, price_date) DO UPDATE SET
        open_price = excluded.open_price,
        high_price = excluded.high_price,
        low_price = excluded.low_price,
        close_price = excluded.close_price,
        currency = excluded.currency,
        timestamp = excluded.timestamp,
        updated_at = excluded.updated_at
    `, `
      INSERT INTO portfolio_daily_prices (
        instrument_key, price_date, open_price, high_price, low_price, close_price, currency, timestamp, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        open_price = VALUES(open_price), high_price = VALUES(high_price), low_price = VALUES(low_price),
        close_price = VALUES(close_price), currency = VALUES(currency), timestamp = VALUES(timestamp),
        updated_at = VALUES(updated_at)
    `);
    await this.db.transaction(async (database) => {
      for (const candle of candles) {
        await database.run(statement, [
          instrumentKey,
          candle.date,
          candle.openPrice,
          candle.highPrice,
          candle.lowPrice,
          candle.closePrice,
          candle.currency || instrumentKey.split(":", 1)[0],
          candle.timestamp,
          updatedAt,
        ]);
      }
    });
    await this.upsertMarketCandles(
      "stock",
      instrumentKey.includes(":") ? instrumentKey.slice(instrumentKey.indexOf(":") + 1) : instrumentKey,
      "1d",
      false,
      candles,
      updatedAt,
    );
    return candles.length;
  }

  async getLatestDailyPriceDate(instrumentKey: string): Promise<string | undefined> {
    const [row] = await this.db.query<{ latest: string | null }>(`
      SELECT MAX(price_date) AS latest FROM portfolio_daily_prices WHERE instrument_key = ?
    `, [instrumentKey]);
    return row?.latest ?? undefined;
  }

  async getEarliestDailyPriceDate(instrumentKey: string): Promise<string | undefined> {
    const [row] = await this.db.query<{ earliest: string | null }>(`
      SELECT MIN(price_date) AS earliest FROM portfolio_daily_prices WHERE instrument_key = ?
    `, [instrumentKey]);
    return row?.earliest ?? undefined;
  }

  async hasIncompleteDailyOhlc(instrumentKey?: string): Promise<boolean> {
    const [row] = instrumentKey
      ? await this.db.query<{ count: number }>(`
          SELECT COUNT(*) AS count
          FROM portfolio_daily_prices
          WHERE instrument_key = ? AND (open_price IS NULL OR high_price IS NULL OR low_price IS NULL)
        `, [instrumentKey])
      : await this.db.query<{ count: number }>(`
          SELECT COUNT(*) AS count
          FROM portfolio_daily_prices
          WHERE open_price IS NULL OR high_price IS NULL OR low_price IS NULL
        `);
    return Number(row?.count ?? 0) > 0;
  }

  async getDailyPrices(
    instrumentKeys: string[],
    fromDate: string,
    toDate: string,
  ): Promise<Map<string, Map<string, number>>> {
    const result = new Map<string, Map<string, number>>();
    if (!instrumentKeys.length) return result;
    const placeholders = instrumentKeys.map(() => "?").join(", ");
    const rows = await this.db.query<{
      instrument_key: string;
      price_date: string;
      close_price: number;
    }>(`
      SELECT instrument_key, price_date, close_price
      FROM portfolio_daily_prices
      WHERE instrument_key IN (${placeholders}) AND price_date BETWEEN ? AND ?
      ORDER BY instrument_key ASC, price_date ASC
    `, [...instrumentKeys, fromDate, toDate]);
    for (const row of rows) {
      const prices = result.get(row.instrument_key) ?? new Map<string, number>();
      prices.set(row.price_date, row.close_price);
      result.set(row.instrument_key, prices);
    }
    return result;
  }

  async upsertBacktestPrices(
    instrumentKey: string,
    candles: DailyCandle[],
    updatedAt = Date.now(),
  ): Promise<number> {
    const statement = this.sql(`
      INSERT INTO portfolio_backtest_prices (
        instrument_key, price_date, close_price, currency, timestamp, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(instrument_key, price_date) DO UPDATE SET
        close_price = excluded.close_price,
        currency = excluded.currency,
        timestamp = excluded.timestamp,
        updated_at = excluded.updated_at
    `, `
      INSERT INTO portfolio_backtest_prices (
        instrument_key, price_date, close_price, currency, timestamp, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        close_price = VALUES(close_price), currency = VALUES(currency),
        timestamp = VALUES(timestamp), updated_at = VALUES(updated_at)
    `);
    await this.db.transaction(async (database) => {
      for (const candle of candles) {
        await database.run(statement, [
          instrumentKey,
          candle.date,
          candle.closePrice,
          candle.currency || instrumentKey.split(":", 1)[0],
          candle.timestamp,
          updatedAt,
        ]);
      }
    });
    await this.upsertMarketCandles(
      "stock",
      instrumentKey.includes(":") ? instrumentKey.slice(instrumentKey.indexOf(":") + 1) : instrumentKey,
      "1d",
      true,
      candles,
      updatedAt,
    );
    return candles.length;
  }

  async getBacktestPriceBounds(instrumentKey: string): Promise<{ earliest?: string; latest?: string }> {
    const [row] = await this.db.query<{ earliest: string | null; latest: string | null }>(`
      SELECT MIN(price_date) AS earliest, MAX(price_date) AS latest
      FROM portfolio_backtest_prices
      WHERE instrument_key = ?
    `, [instrumentKey]);
    return {
      ...(row?.earliest ? { earliest: row.earliest } : {}),
      ...(row?.latest ? { latest: row.latest } : {}),
    };
  }

  async getBacktestPrices(
    instrumentKeys: string[],
    fromDate: string,
    toDate: string,
  ): Promise<Map<string, Array<{ date: string; close: number }>>> {
    const result = new Map<string, Array<{ date: string; close: number }>>();
    if (!instrumentKeys.length) return result;
    const placeholders = instrumentKeys.map(() => "?").join(", ");
    const rows = await this.db.query<{
      instrument_key: string;
      price_date: string;
      close_price: number;
    }>(`
      SELECT instrument_key, price_date, close_price
      FROM portfolio_backtest_prices
      WHERE instrument_key IN (${placeholders}) AND price_date BETWEEN ? AND ?
      ORDER BY instrument_key ASC, price_date ASC
    `, [...instrumentKeys, fromDate, toDate]);
    for (const row of rows) {
      const points = result.get(row.instrument_key) ?? [];
      points.push({ date: row.price_date, close: Number(row.close_price) });
      result.set(row.instrument_key, points);
    }
    return result;
  }

  async getPortfolioAnalysisCandles(
    accountId: string,
    currency: HistoryCurrency,
    fromDate: string,
    toDate: string,
  ): Promise<PortfolioAnalysisCandle[]> {
    const instrumentExpression = this.db.dialect === "mysql"
      ? "CONCAT(items.currency, ':', items.symbol)"
      : "items.currency || ':' || items.symbol";
    const rows = await this.db.query<{
      snapshot_date: string;
      evaluation_amount: number;
      price_date: string | null;
      open_price: number | null;
      high_price: number | null;
      low_price: number | null;
      close_price: number | null;
    }>(`
      SELECT
        snapshots.snapshot_date,
        items.evaluation_amount,
        prices.price_date,
        prices.open_price,
        prices.high_price,
        prices.low_price,
        prices.close_price
      FROM portfolio_snapshots AS snapshots
      JOIN portfolio_snapshot_items AS items ON items.snapshot_id = snapshots.id
      LEFT JOIN portfolio_daily_prices AS prices
        ON prices.instrument_key = ${instrumentExpression}
       AND prices.price_date = snapshots.snapshot_date
      WHERE snapshots.account_id = ?
        AND items.currency = ?
        AND snapshots.snapshot_date BETWEEN ? AND ?
      ORDER BY snapshots.snapshot_date ASC, items.symbol ASC
    `, [accountId, currency, fromDate, toDate]);

    const byDate = new Map<string, PortfolioAnalysisCandle & { hasMarketData: boolean }>();
    for (const row of rows) {
      const current = byDate.get(row.snapshot_date) ?? {
        date: row.snapshot_date,
        open: 0,
        high: 0,
        low: 0,
        close: 0,
        hasMarketData: false,
      };
      const evaluationAmount = Number(row.evaluation_amount);
      const dailyClose = Number(row.close_price ?? 0);
      if (row.price_date && dailyClose > 0) {
        const quantity = evaluationAmount / dailyClose;
        const openPrice = Number(row.open_price ?? dailyClose);
        const highPrice = Number(row.high_price ?? Math.max(openPrice, dailyClose));
        const lowPrice = Number(row.low_price ?? Math.min(openPrice, dailyClose));
        current.open += quantity * openPrice;
        current.high += quantity * Math.max(highPrice, openPrice, dailyClose);
        current.low += quantity * Math.min(lowPrice, openPrice, dailyClose);
        current.close += evaluationAmount;
        current.hasMarketData = true;
      } else {
        current.open += evaluationAmount;
        current.high += evaluationAmount;
        current.low += evaluationAmount;
        current.close += evaluationAmount;
      }
      byDate.set(row.snapshot_date, current);
    }

    return Array.from(byDate.values())
      .filter((candle) => candle.hasMarketData && candle.close > 0)
      .map(({ hasMarketData: _hasMarketData, ...candle }) => ({
        date: candle.date,
        open: round(candle.open, 4),
        high: round(Math.max(candle.high, candle.open, candle.close), 4),
        low: round(Math.min(candle.low, candle.open, candle.close), 4),
        close: round(candle.close, 4),
      }));
  }

  async upsertBenchmarkPrices(
    benchmarkKey: string,
    candles: DailyCandle[],
    updatedAt = Date.now(),
  ): Promise<number> {
    const statement = this.sql(`
      INSERT INTO portfolio_benchmark_prices (
        benchmark_key, price_date, close_price, timestamp, updated_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(benchmark_key, price_date) DO UPDATE SET
        close_price = excluded.close_price,
        timestamp = excluded.timestamp,
        updated_at = excluded.updated_at
    `, `
      INSERT INTO portfolio_benchmark_prices (
        benchmark_key, price_date, close_price, timestamp, updated_at
      ) VALUES (?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        close_price = VALUES(close_price), timestamp = VALUES(timestamp), updated_at = VALUES(updated_at)
    `);
    await this.db.transaction(async (database) => {
      for (const candle of candles) {
        await database.run(statement, [benchmarkKey, candle.date, candle.closePrice, candle.timestamp, updatedAt]);
      }
    });
    const indicator = benchmarkKey === "KOSPI" || benchmarkKey === "KOSDAQ";
    const symbol = benchmarkKey === "NASDAQ100" ? "QQQ" : benchmarkKey === "SP500" ? "SPY" : benchmarkKey;
    await this.upsertMarketCandles(
      indicator ? "indicator" : "stock",
      symbol,
      "1d",
      !indicator,
      candles,
      updatedAt,
    );
    return candles.length;
  }

  upsertExchangeRate(
    rateDate: string,
    rate: number,
    timestamp: string,
    updatedAt = Date.now(),
  ): Promise<void> {
    return this.db.run(this.sql(`
      INSERT INTO portfolio_exchange_rates (
        rate_date, base_currency, quote_currency, rate, timestamp, updated_at
      ) VALUES (?, 'USD', 'KRW', ?, ?, ?)
      ON CONFLICT(rate_date, base_currency, quote_currency) DO UPDATE SET
        rate = excluded.rate,
        timestamp = excluded.timestamp,
        updated_at = excluded.updated_at
    `, `
      INSERT INTO portfolio_exchange_rates (
        rate_date, base_currency, quote_currency, rate, timestamp, updated_at
      ) VALUES (?, 'USD', 'KRW', ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        rate = VALUES(rate), timestamp = VALUES(timestamp), updated_at = VALUES(updated_at)
    `), [rateDate, rate, timestamp, updatedAt]).then(() => undefined);
  }

  async getExchangeRates(fromDate: string, toDate: string): Promise<Map<string, number>> {
    const rows = await this.db.query<{ rate_date: string; rate: number }>(`
      SELECT rate_date, rate
      FROM portfolio_exchange_rates
      WHERE base_currency = 'USD' AND quote_currency = 'KRW'
        AND rate_date BETWEEN ? AND ?
      ORDER BY rate_date ASC
    `, [fromDate, toDate]);
    return new Map(rows.map((row) => [row.rate_date, Number(row.rate)]));
  }

  async getRequiredExchangeRateDates(accountId: string, fromDate: string, toDate: string): Promise<string[]> {
    const snapshotRows = await this.db.query<{ rate_date: string }>(`
      SELECT DISTINCT snapshots.snapshot_date AS rate_date
      FROM portfolio_snapshots AS snapshots
      JOIN portfolio_snapshot_items AS items ON items.snapshot_id = snapshots.id
      WHERE snapshots.account_id = ?
        AND items.currency = 'USD'
        AND items.evaluation_amount > 0
        AND snapshots.snapshot_date BETWEEN ? AND ?
      ORDER BY snapshots.snapshot_date ASC
    `, [accountId, fromDate, toDate]);
    const dates = new Set(snapshotRows.map((row) => row.rate_date));
    for (const order of await this.getOrders(accountId)) {
      if (order.currency !== "USD") continue;
      const timestamp = order.filledAt || order.orderedAt;
      if (!timestamp) continue;
      const parsed = new Date(timestamp);
      const date = !Number.isNaN(parsed.getTime()) && /(?:Z|[+-]\d{2}:?\d{2})$/i.test(timestamp)
        ? kstDateString(parsed)
        : timestamp.match(/^(\d{4}-\d{2}-\d{2})/)?.[1] ?? "";
      if (date >= fromDate && date <= toDate) dates.add(date);
    }
    return Array.from(dates).sort();
  }

  async getBenchmarkPriceBounds(benchmarkKey: string): Promise<{ earliest?: string; latest?: string }> {
    const [row] = await this.db.query<{ earliest: string | null; latest: string | null }>(`
      SELECT MIN(price_date) AS earliest, MAX(price_date) AS latest
      FROM portfolio_benchmark_prices
      WHERE benchmark_key = ?
    `, [benchmarkKey]);
    return {
      ...(row?.earliest ? { earliest: row.earliest } : {}),
      ...(row?.latest ? { latest: row.latest } : {}),
    };
  }

  async getBenchmarkPrices(
    benchmarkKey: string,
    fromDate: string,
    toDate: string,
  ): Promise<BenchmarkPricePoint[]> {
    const rows = await this.db.query<{ price_date: string; close_price: number }>(`
      SELECT price_date, close_price
      FROM portfolio_benchmark_prices
      WHERE benchmark_key = ? AND price_date BETWEEN ? AND ?
      ORDER BY price_date ASC
    `, [benchmarkKey, fromDate, toDate]);
    return rows.map((row) => ({
      date: row.price_date,
      close: round(Number(row.close_price), 6),
    }));
  }

  async replaceHistoricalSnapshots(
    accountId: string,
    snapshots: HistoricalSnapshot[],
    beforeDate: string,
  ): Promise<number> {
    const insertSnapshot = this.sql(`
      INSERT INTO portfolio_snapshots (account_id, snapshot_date, captured_at, origin)
      VALUES (?, ?, ?, 'HISTORICAL')
      ON CONFLICT(account_id, snapshot_date) DO UPDATE SET
        captured_at = excluded.captured_at,
        origin = 'HISTORICAL'
      WHERE portfolio_snapshots.origin = 'HISTORICAL'
    `, `
      INSERT INTO portfolio_snapshots (account_id, snapshot_date, captured_at, origin)
      VALUES (?, ?, ?, 'HISTORICAL')
      ON DUPLICATE KEY UPDATE
        captured_at = IF(origin = 'HISTORICAL', VALUES(captured_at), captured_at),
        origin = IF(origin = 'HISTORICAL', 'HISTORICAL', origin)
    `);
    const selectSnapshot = `
      SELECT id, snapshot_date, captured_at, origin
      FROM portfolio_snapshots
      WHERE account_id = ? AND snapshot_date = ?
    `;
    const insertItem = `
      INSERT INTO portfolio_snapshot_items (
        snapshot_id, symbol, name, market, currency, evaluation_amount, weight_percent
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `;

    return this.db.transaction(async (database) => {
      await database.run(`
        DELETE FROM portfolio_snapshots
        WHERE account_id = ? AND snapshot_date < ? AND origin = 'HISTORICAL'
      `, [accountId, beforeDate]);
      let written = 0;
      for (const snapshot of snapshots) {
        if (snapshot.date >= beforeDate) continue;
        await database.run(insertSnapshot, [accountId, snapshot.date, snapshot.capturedAt]);
        const [row] = await database.query<SnapshotRow & DatabaseRow>(
          selectSnapshot,
          [accountId, snapshot.date],
        );
        if (!row || row.origin !== "HISTORICAL") continue;
        await database.run("DELETE FROM portfolio_snapshot_items WHERE snapshot_id = ?", [row.id]);
        const totals = snapshot.items.reduce<Record<HistoryCurrency, number>>(
          (sum, item) => {
            sum[item.currency] += item.evaluationAmount;
            return sum;
          },
          { KRW: 0, USD: 0 },
        );
        for (const item of snapshot.items) {
          const total = totals[item.currency];
          if (item.evaluationAmount <= 0 || total <= 0) continue;
          await database.run(insertItem, [
            row.id,
            item.symbol,
            item.name,
            item.market,
            item.currency,
            item.evaluationAmount,
            round((item.evaluationAmount / total) * 100),
          ]);
        }
        written += 1;
      }
      return written;
    });
  }

  async getBackfillStatus(accountId: string, now = new Date()): Promise<BackfillStatus> {
    const [row] = await this.db.query<Record<string, string | number | null>>(
      "SELECT * FROM portfolio_backfill_state WHERE account_id = ?",
      [accountId],
    );
    if (!row) {
      return {
        accountId,
        status: "idle",
        phase: "waiting",
        updatedAt: now.toISOString(),
        ordersImported: 0,
        symbolsTotal: 0,
        symbolsProcessed: 0,
        pricesImported: 0,
        snapshotsCreated: 0,
        reconciledSymbols: 0,
        discrepancySymbols: 0,
        failedSymbols: 0,
      };
    }
    const optional = (key: string): string | undefined => row[key] ? String(row[key]) : undefined;
    return {
      accountId,
      status: String(row.status) as BackfillStatusValue,
      phase: String(row.phase) as BackfillPhase,
      startedAt: optional("started_at"),
      completedAt: optional("completed_at"),
      updatedAt: String(row.updated_at),
      firstTradeDate: optional("first_trade_date"),
      lastBackfilledDate: optional("last_backfilled_date"),
      ordersImported: Number(row.orders_imported),
      symbolsTotal: Number(row.symbols_total),
      symbolsProcessed: Number(row.symbols_processed),
      pricesImported: Number(row.prices_imported),
      snapshotsCreated: Number(row.snapshots_created),
      reconciledSymbols: Number(row.reconciled_symbols),
      discrepancySymbols: Number(row.discrepancy_symbols),
      failedSymbols: Number(row.failed_symbols),
      message: optional("message"),
    };
  }

  async updateBackfillStatus(
    accountId: string,
    patch: Partial<Omit<BackfillStatus, "accountId">>,
  ): Promise<BackfillStatus> {
    const current = await this.getBackfillStatus(accountId);
    const next: BackfillStatus = {
      ...current,
      ...patch,
      accountId,
      updatedAt: patch.updatedAt ?? new Date().toISOString(),
    };
    await this.db.run(this.sql(`
      INSERT INTO portfolio_backfill_state (
        account_id, status, phase, started_at, completed_at, updated_at,
        first_trade_date, last_backfilled_date, orders_imported, symbols_total,
        symbols_processed, prices_imported, snapshots_created, reconciled_symbols,
        discrepancy_symbols, failed_symbols, message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id) DO UPDATE SET
        status = excluded.status,
        phase = excluded.phase,
        started_at = excluded.started_at,
        completed_at = excluded.completed_at,
        updated_at = excluded.updated_at,
        first_trade_date = excluded.first_trade_date,
        last_backfilled_date = excluded.last_backfilled_date,
        orders_imported = excluded.orders_imported,
        symbols_total = excluded.symbols_total,
        symbols_processed = excluded.symbols_processed,
        prices_imported = excluded.prices_imported,
        snapshots_created = excluded.snapshots_created,
        reconciled_symbols = excluded.reconciled_symbols,
        discrepancy_symbols = excluded.discrepancy_symbols,
        failed_symbols = excluded.failed_symbols,
        message = excluded.message
    `, `
      INSERT INTO portfolio_backfill_state (
        account_id, status, phase, started_at, completed_at, updated_at,
        first_trade_date, last_backfilled_date, orders_imported, symbols_total,
        symbols_processed, prices_imported, snapshots_created, reconciled_symbols,
        discrepancy_symbols, failed_symbols, message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        status = VALUES(status), phase = VALUES(phase), started_at = VALUES(started_at),
        completed_at = VALUES(completed_at), updated_at = VALUES(updated_at),
        first_trade_date = VALUES(first_trade_date), last_backfilled_date = VALUES(last_backfilled_date),
        orders_imported = VALUES(orders_imported), symbols_total = VALUES(symbols_total),
        symbols_processed = VALUES(symbols_processed), prices_imported = VALUES(prices_imported),
        snapshots_created = VALUES(snapshots_created), reconciled_symbols = VALUES(reconciled_symbols),
        discrepancy_symbols = VALUES(discrepancy_symbols), failed_symbols = VALUES(failed_symbols),
        message = VALUES(message)
    `), [
      accountId,
      next.status,
      next.phase,
      next.startedAt ?? null,
      next.completedAt ?? null,
      next.updatedAt,
      next.firstTradeDate ?? null,
      next.lastBackfilledDate ?? null,
      next.ordersImported,
      next.symbolsTotal,
      next.symbolsProcessed,
      next.pricesImported,
      next.snapshotsCreated,
      next.reconciledSymbols,
      next.discrepancySymbols,
      next.failedSymbols,
      next.message ?? null,
    ]);
    return next;
  }

  async getHistory(
    accountId: string,
    currency: HistoryCurrency,
    range: HistoryRange,
    now = new Date(),
    dateRange?: HistoryDateRange,
  ): Promise<PortfolioHistory> {
    const startDate = dateRange?.from ?? startDateForRange(range, now);
    const endDate = dateRange?.to;
    const clauses = ["account_id = ?"];
    const parameters = [accountId];
    if (startDate) {
      clauses.push("snapshot_date >= ?");
      parameters.push(startDate);
    }
    if (endDate) {
      clauses.push("snapshot_date <= ?");
      parameters.push(endDate);
    }
    const snapshotRows = await this.db.query<SnapshotRow & DatabaseRow>(`
      SELECT id, snapshot_date, captured_at, origin
      FROM portfolio_snapshots
      WHERE ${clauses.join(" AND ")}
      ORDER BY snapshot_date ASC
    `, parameters);

    if (!snapshotRows.length) {
      return {
        accountId,
        currency,
        range,
        generatedAt: now.toISOString(),
        ...(dateRange ? { fromDate: dateRange.from, toDate: dateRange.to } : {}),
        series: [],
        points: [],
      };
    }
    const snapshots = snapshotRows.map((snapshot) => ({
      ...snapshot,
      id: Number(snapshot.id),
      captured_at: Number(snapshot.captured_at),
    }));

    const placeholders = snapshots.map(() => "?").join(", ");
    const itemRows = await this.db.query<ItemRow & DatabaseRow>(`
      SELECT snapshot_id, symbol, name, market, evaluation_amount, weight_percent
      FROM portfolio_snapshot_items
      WHERE currency = ? AND snapshot_id IN (${placeholders})
      ORDER BY snapshot_id ASC, weight_percent DESC
    `, [currency, ...snapshots.map((snapshot) => snapshot.id)]);
    const items = itemRows.map((item) => ({
      ...item,
      snapshot_id: Number(item.snapshot_id),
      evaluation_amount: Number(item.evaluation_amount),
      weight_percent: Number(item.weight_percent),
    }));

    const itemsBySnapshot = new Map<number, ItemRow[]>();
    const seriesMap = new Map<string, {
      key: string;
      symbol: string;
      name: string;
      market: string;
      currency: HistoryCurrency;
      weightSum: number;
    }>();
    for (const item of items) {
      const snapshotItems = itemsBySnapshot.get(item.snapshot_id) ?? [];
      snapshotItems.push(item);
      itemsBySnapshot.set(item.snapshot_id, snapshotItems);
      const key = seriesKey(item.market, item.symbol);
      const existing = seriesMap.get(key);
      if (existing) existing.weightSum += item.weight_percent;
      else {
        seriesMap.set(key, {
          key,
          symbol: item.symbol,
          name: item.name,
          market: item.market,
          currency,
          weightSum: item.weight_percent,
        });
      }
    }

    const series = Array.from(seriesMap.values())
      .map(({ weightSum, ...item }) => ({
        ...item,
        averageWeight: round(weightSum / snapshots.length, 3),
      }))
      .sort((a, b) => b.averageWeight - a.averageWeight || a.name.localeCompare(b.name, "ko"));

    const points = snapshots.map((snapshot) => {
      const snapshotItems = itemsBySnapshot.get(snapshot.id) ?? [];
      const values = Object.fromEntries(series.map((item) => [item.key, 0])) as Record<string, number>;
      let totalValue = 0;
      for (const item of snapshotItems) {
        values[seriesKey(item.market, item.symbol)] = item.weight_percent;
        totalValue += item.evaluation_amount;
      }
      return {
        date: snapshot.snapshot_date,
        capturedAt: new Date(snapshot.captured_at).toISOString(),
        ...(snapshot.origin ? { origin: snapshot.origin } : {}),
        totalValue: round(totalValue, 4),
        values,
      };
    });

    return {
      accountId,
      currency,
      range,
      generatedAt: now.toISOString(),
      firstSnapshotDate: snapshots[0].snapshot_date,
      ...(dateRange ? { fromDate: dateRange.from, toDate: dateRange.to } : {}),
      series,
      points,
    };
  }
}
