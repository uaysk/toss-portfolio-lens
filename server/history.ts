import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
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

type SnapshotRow = {
  id: number;
  snapshot_date: string;
  captured_at: number;
  origin?: string;
};

type ItemRow = {
  snapshot_id: number;
  symbol: string;
  name: string;
  market: string;
  evaluation_amount: number;
  weight_percent: number;
};

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
  private readonly db: DatabaseSync;

  constructor(databasePath: string) {
    if (databasePath !== ":memory:") {
      mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
    }
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS portfolio_snapshots (
        id INTEGER PRIMARY KEY,
        account_id TEXT NOT NULL,
        snapshot_date TEXT NOT NULL,
        captured_at INTEGER NOT NULL,
        origin TEXT NOT NULL DEFAULT 'LIVE' CHECK(origin IN ('LIVE', 'HISTORICAL')),
        UNIQUE(account_id, snapshot_date)
      );

      CREATE TABLE IF NOT EXISTS portfolio_snapshot_items (
        snapshot_id INTEGER NOT NULL REFERENCES portfolio_snapshots(id) ON DELETE CASCADE,
        symbol TEXT NOT NULL,
        name TEXT NOT NULL,
        market TEXT NOT NULL,
        currency TEXT NOT NULL CHECK(currency IN ('KRW', 'USD')),
        evaluation_amount REAL NOT NULL,
        weight_percent REAL NOT NULL,
        PRIMARY KEY(snapshot_id, market, symbol, currency)
      );

      CREATE INDEX IF NOT EXISTS idx_snapshots_account_date
        ON portfolio_snapshots(account_id, snapshot_date);

      CREATE TABLE IF NOT EXISTS portfolio_orders (
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
      );

      CREATE INDEX IF NOT EXISTS idx_orders_account_filled_at
        ON portfolio_orders(account_id, filled_at);

      CREATE TABLE IF NOT EXISTS portfolio_instruments (
        instrument_key TEXT PRIMARY KEY,
        symbol TEXT NOT NULL,
        name TEXT NOT NULL,
        market TEXT NOT NULL,
        currency TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS portfolio_daily_prices (
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
      );

      CREATE INDEX IF NOT EXISTS idx_daily_prices_key_date
        ON portfolio_daily_prices(instrument_key, price_date);

      CREATE TABLE IF NOT EXISTS portfolio_benchmark_prices (
        benchmark_key TEXT NOT NULL,
        price_date TEXT NOT NULL,
        close_price REAL NOT NULL,
        timestamp TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(benchmark_key, price_date)
      );

      CREATE INDEX IF NOT EXISTS idx_benchmark_prices_key_date
        ON portfolio_benchmark_prices(benchmark_key, price_date);

      CREATE TABLE IF NOT EXISTS portfolio_exchange_rates (
        rate_date TEXT NOT NULL,
        base_currency TEXT NOT NULL,
        quote_currency TEXT NOT NULL,
        rate REAL NOT NULL,
        timestamp TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(rate_date, base_currency, quote_currency)
      );

      CREATE INDEX IF NOT EXISTS idx_exchange_rates_pair_date
        ON portfolio_exchange_rates(base_currency, quote_currency, rate_date);

      CREATE TABLE IF NOT EXISTS portfolio_backfill_state (
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
      );
    `);
    const snapshotColumns = this.db.prepare("PRAGMA table_info(portfolio_snapshots)").all() as Array<{ name: string }>;
    if (!snapshotColumns.some((column) => column.name === "origin")) {
      this.db.exec("ALTER TABLE portfolio_snapshots ADD COLUMN origin TEXT NOT NULL DEFAULT 'LIVE'");
    }
    const priceColumns = this.db.prepare("PRAGMA table_info(portfolio_daily_prices)").all() as Array<{ name: string }>;
    for (const column of ["open_price", "high_price", "low_price"]) {
      if (!priceColumns.some((candidate) => candidate.name === column)) {
        this.db.exec(`ALTER TABLE portfolio_daily_prices ADD COLUMN ${column} REAL`);
      }
    }
  }

  close(): void {
    this.db.close();
  }

  recordPortfolio(portfolio: Portfolio, capturedAt = new Date()): void {
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

    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`
        INSERT INTO portfolio_snapshots (account_id, snapshot_date, captured_at, origin)
        VALUES (?, ?, ?, 'LIVE')
        ON CONFLICT(account_id, snapshot_date)
        DO UPDATE SET captured_at = excluded.captured_at, origin = 'LIVE'
      `).run(portfolio.selectedAccountId, snapshotDate, capturedAtMs);

      const snapshot = this.db.prepare(`
        SELECT id, snapshot_date, captured_at
        FROM portfolio_snapshots
        WHERE account_id = ? AND snapshot_date = ?
      `).get(portfolio.selectedAccountId, snapshotDate) as SnapshotRow | undefined;
      if (!snapshot) throw new Error("일별 포트폴리오 스냅샷을 생성하지 못했습니다.");

      this.db.prepare("DELETE FROM portfolio_snapshot_items WHERE snapshot_id = ?").run(snapshot.id);
      const insert = this.db.prepare(`
        INSERT INTO portfolio_snapshot_items (
          snapshot_id, symbol, name, market, currency, evaluation_amount, weight_percent
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const holding of eligible) {
        const currency = holding.currency as HistoryCurrency;
        insert.run(
          snapshot.id,
          holding.symbol,
          holding.name,
          holding.market,
          currency,
          holding.evaluationAmount,
          round((holding.evaluationAmount / totals[currency]) * 100),
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  upsertOrders(accountId: string, orders: HistoricalOrder[], fetchedAt = Date.now()): number {
    const statement = this.db.prepare(`
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
    `);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const order of orders) {
        statement.run(
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
        );
      }
      this.db.exec("COMMIT");
      return orders.length;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getOrders(accountId: string): HistoricalOrder[] {
    const rows = this.db.prepare(`
      SELECT order_id, symbol, side, currency, status, ordered_at, filled_at,
             filled_quantity, average_filled_price, filled_amount, commission, tax
      FROM portfolio_orders
      WHERE account_id = ?
      ORDER BY COALESCE(NULLIF(filled_at, ''), ordered_at) ASC, order_id ASC
    `).all(accountId) as Array<Record<string, string | number>>;
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

  upsertInstruments(instruments: InstrumentInfo[], updatedAt = Date.now()): number {
    const statement = this.db.prepare(`
      INSERT INTO portfolio_instruments (instrument_key, symbol, name, market, currency, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(instrument_key) DO UPDATE SET
        name = excluded.name,
        market = excluded.market,
        updated_at = excluded.updated_at
    `);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const instrument of instruments) {
        statement.run(
          `${instrument.currency}:${instrument.symbol}`,
          instrument.symbol,
          instrument.name || instrument.symbol,
          instrument.market || (instrument.currency === "USD" ? "미국" : "KRX"),
          instrument.currency,
          updatedAt,
        );
      }
      this.db.exec("COMMIT");
      return instruments.length;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  upsertDailyPrices(instrumentKey: string, candles: DailyCandle[], updatedAt = Date.now()): number {
    const statement = this.db.prepare(`
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
    `);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const candle of candles) {
        statement.run(
          instrumentKey,
          candle.date,
          candle.openPrice,
          candle.highPrice,
          candle.lowPrice,
          candle.closePrice,
          candle.currency || instrumentKey.split(":", 1)[0],
          candle.timestamp,
          updatedAt,
        );
      }
      this.db.exec("COMMIT");
      return candles.length;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getLatestDailyPriceDate(instrumentKey: string): string | undefined {
    const row = this.db.prepare(`
      SELECT MAX(price_date) AS latest FROM portfolio_daily_prices WHERE instrument_key = ?
    `).get(instrumentKey) as { latest: string | null } | undefined;
    return row?.latest ?? undefined;
  }

  getEarliestDailyPriceDate(instrumentKey: string): string | undefined {
    const row = this.db.prepare(`
      SELECT MIN(price_date) AS earliest FROM portfolio_daily_prices WHERE instrument_key = ?
    `).get(instrumentKey) as { earliest: string | null } | undefined;
    return row?.earliest ?? undefined;
  }

  hasIncompleteDailyOhlc(instrumentKey?: string): boolean {
    const row = instrumentKey
      ? this.db.prepare(`
          SELECT COUNT(*) AS count
          FROM portfolio_daily_prices
          WHERE instrument_key = ? AND (open_price IS NULL OR high_price IS NULL OR low_price IS NULL)
        `).get(instrumentKey) as { count: number }
      : this.db.prepare(`
          SELECT COUNT(*) AS count
          FROM portfolio_daily_prices
          WHERE open_price IS NULL OR high_price IS NULL OR low_price IS NULL
        `).get() as { count: number };
    return Number(row.count) > 0;
  }

  getDailyPrices(instrumentKeys: string[], fromDate: string, toDate: string): Map<string, Map<string, number>> {
    const result = new Map<string, Map<string, number>>();
    if (!instrumentKeys.length) return result;
    const placeholders = instrumentKeys.map(() => "?").join(", ");
    const rows = this.db.prepare(`
      SELECT instrument_key, price_date, close_price
      FROM portfolio_daily_prices
      WHERE instrument_key IN (${placeholders}) AND price_date BETWEEN ? AND ?
      ORDER BY instrument_key ASC, price_date ASC
    `).all(...instrumentKeys, fromDate, toDate) as Array<{
      instrument_key: string;
      price_date: string;
      close_price: number;
    }>;
    for (const row of rows) {
      const prices = result.get(row.instrument_key) ?? new Map<string, number>();
      prices.set(row.price_date, row.close_price);
      result.set(row.instrument_key, prices);
    }
    return result;
  }

  getPortfolioAnalysisCandles(
    accountId: string,
    currency: HistoryCurrency,
    fromDate: string,
    toDate: string,
  ): PortfolioAnalysisCandle[] {
    const rows = this.db.prepare(`
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
        ON prices.instrument_key = items.currency || ':' || items.symbol
       AND prices.price_date = snapshots.snapshot_date
      WHERE snapshots.account_id = ?
        AND items.currency = ?
        AND snapshots.snapshot_date BETWEEN ? AND ?
      ORDER BY snapshots.snapshot_date ASC, items.symbol ASC
    `).all(accountId, currency, fromDate, toDate) as Array<{
      snapshot_date: string;
      evaluation_amount: number;
      price_date: string | null;
      open_price: number | null;
      high_price: number | null;
      low_price: number | null;
      close_price: number | null;
    }>;

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

  upsertBenchmarkPrices(benchmarkKey: string, candles: DailyCandle[], updatedAt = Date.now()): number {
    const statement = this.db.prepare(`
      INSERT INTO portfolio_benchmark_prices (
        benchmark_key, price_date, close_price, timestamp, updated_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(benchmark_key, price_date) DO UPDATE SET
        close_price = excluded.close_price,
        timestamp = excluded.timestamp,
        updated_at = excluded.updated_at
    `);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const candle of candles) {
        statement.run(benchmarkKey, candle.date, candle.closePrice, candle.timestamp, updatedAt);
      }
      this.db.exec("COMMIT");
      return candles.length;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  upsertExchangeRate(
    rateDate: string,
    rate: number,
    timestamp: string,
    updatedAt = Date.now(),
  ): void {
    this.db.prepare(`
      INSERT INTO portfolio_exchange_rates (
        rate_date, base_currency, quote_currency, rate, timestamp, updated_at
      ) VALUES (?, 'USD', 'KRW', ?, ?, ?)
      ON CONFLICT(rate_date, base_currency, quote_currency) DO UPDATE SET
        rate = excluded.rate,
        timestamp = excluded.timestamp,
        updated_at = excluded.updated_at
    `).run(rateDate, rate, timestamp, updatedAt);
  }

  getExchangeRates(fromDate: string, toDate: string): Map<string, number> {
    const rows = this.db.prepare(`
      SELECT rate_date, rate
      FROM portfolio_exchange_rates
      WHERE base_currency = 'USD' AND quote_currency = 'KRW'
        AND rate_date BETWEEN ? AND ?
      ORDER BY rate_date ASC
    `).all(fromDate, toDate) as Array<{ rate_date: string; rate: number }>;
    return new Map(rows.map((row) => [row.rate_date, Number(row.rate)]));
  }

  getRequiredExchangeRateDates(accountId: string, fromDate: string, toDate: string): string[] {
    const snapshotRows = this.db.prepare(`
      SELECT DISTINCT snapshots.snapshot_date AS rate_date
      FROM portfolio_snapshots AS snapshots
      JOIN portfolio_snapshot_items AS items ON items.snapshot_id = snapshots.id
      WHERE snapshots.account_id = ?
        AND items.currency = 'USD'
        AND items.evaluation_amount > 0
        AND snapshots.snapshot_date BETWEEN ? AND ?
      ORDER BY snapshots.snapshot_date ASC
    `).all(accountId, fromDate, toDate) as Array<{ rate_date: string }>;
    const dates = new Set(snapshotRows.map((row) => row.rate_date));
    for (const order of this.getOrders(accountId)) {
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

  getBenchmarkPriceBounds(benchmarkKey: string): { earliest?: string; latest?: string } {
    const row = this.db.prepare(`
      SELECT MIN(price_date) AS earliest, MAX(price_date) AS latest
      FROM portfolio_benchmark_prices
      WHERE benchmark_key = ?
    `).get(benchmarkKey) as { earliest: string | null; latest: string | null };
    return {
      ...(row.earliest ? { earliest: row.earliest } : {}),
      ...(row.latest ? { latest: row.latest } : {}),
    };
  }

  getBenchmarkPrices(benchmarkKey: string, fromDate: string, toDate: string): BenchmarkPricePoint[] {
    return (this.db.prepare(`
      SELECT price_date, close_price
      FROM portfolio_benchmark_prices
      WHERE benchmark_key = ? AND price_date BETWEEN ? AND ?
      ORDER BY price_date ASC
    `).all(benchmarkKey, fromDate, toDate) as Array<{ price_date: string; close_price: number }>).map((row) => ({
      date: row.price_date,
      close: round(Number(row.close_price), 6),
    }));
  }

  replaceHistoricalSnapshots(accountId: string, snapshots: HistoricalSnapshot[], beforeDate: string): number {
    const insertSnapshot = this.db.prepare(`
      INSERT INTO portfolio_snapshots (account_id, snapshot_date, captured_at, origin)
      VALUES (?, ?, ?, 'HISTORICAL')
      ON CONFLICT(account_id, snapshot_date) DO UPDATE SET
        captured_at = excluded.captured_at,
        origin = 'HISTORICAL'
      WHERE portfolio_snapshots.origin = 'HISTORICAL'
    `);
    const selectSnapshot = this.db.prepare(`
      SELECT id, snapshot_date, captured_at, origin
      FROM portfolio_snapshots
      WHERE account_id = ? AND snapshot_date = ?
    `);
    const deleteItems = this.db.prepare("DELETE FROM portfolio_snapshot_items WHERE snapshot_id = ?");
    const insertItem = this.db.prepare(`
      INSERT INTO portfolio_snapshot_items (
        snapshot_id, symbol, name, market, currency, evaluation_amount, weight_percent
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`
        DELETE FROM portfolio_snapshots
        WHERE account_id = ? AND snapshot_date < ? AND origin = 'HISTORICAL'
      `).run(accountId, beforeDate);
      let written = 0;
      for (const snapshot of snapshots) {
        if (snapshot.date >= beforeDate) continue;
        insertSnapshot.run(accountId, snapshot.date, snapshot.capturedAt);
        const row = selectSnapshot.get(accountId, snapshot.date) as SnapshotRow | undefined;
        if (!row || row.origin !== "HISTORICAL") continue;
        deleteItems.run(row.id);
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
          insertItem.run(
            row.id,
            item.symbol,
            item.name,
            item.market,
            item.currency,
            item.evaluationAmount,
            round((item.evaluationAmount / total) * 100),
          );
        }
        written += 1;
      }
      this.db.exec("COMMIT");
      return written;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getBackfillStatus(accountId: string, now = new Date()): BackfillStatus {
    const row = this.db.prepare(`SELECT * FROM portfolio_backfill_state WHERE account_id = ?`).get(accountId) as
      | Record<string, string | number | null>
      | undefined;
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

  updateBackfillStatus(accountId: string, patch: Partial<Omit<BackfillStatus, "accountId">>): BackfillStatus {
    const current = this.getBackfillStatus(accountId);
    const next: BackfillStatus = {
      ...current,
      ...patch,
      accountId,
      updatedAt: patch.updatedAt ?? new Date().toISOString(),
    };
    this.db.prepare(`
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
    `).run(
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
    );
    return next;
  }

  getHistory(
    accountId: string,
    currency: HistoryCurrency,
    range: HistoryRange,
    now = new Date(),
    dateRange?: HistoryDateRange,
  ): PortfolioHistory {
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
    const snapshots = this.db.prepare(`
      SELECT id, snapshot_date, captured_at
      FROM portfolio_snapshots
      WHERE ${clauses.join(" AND ")}
      ORDER BY snapshot_date ASC
    `).all(...parameters) as SnapshotRow[];

    if (!snapshots.length) {
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

    const placeholders = snapshots.map(() => "?").join(", ");
    const items = this.db.prepare(`
      SELECT snapshot_id, symbol, name, market, evaluation_amount, weight_percent
      FROM portfolio_snapshot_items
      WHERE currency = ? AND snapshot_id IN (${placeholders})
      ORDER BY snapshot_id ASC, weight_percent DESC
    `).all(currency, ...snapshots.map((snapshot) => snapshot.id)) as ItemRow[];

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
