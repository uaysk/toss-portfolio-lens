import { type DatabaseRow, type RelationalDatabase } from "./database.js";
import { applyPortfolioMigrations } from "./migrations.js";
import {
  postgresUnnestParameters,
  postgresWriteBatches,
} from "./postgres-batch.js";
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

const KST_DATE_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function round(value: number, digits = 6): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

export function kstDateString(date: Date): string {
  const parts = KST_DATE_FORMATTER.formatToParts(date);
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
  private constructor(private readonly db: RelationalDatabase) {}

  /** Shared repositories use the same connection pool and transaction semantics. */
  get relationalDatabase(): RelationalDatabase {
    return this.db;
  }

  static async open(database: RelationalDatabase): Promise<PortfolioHistoryStore> {
    const store = new PortfolioHistoryStore(database);
    await store.initialize();
    return store;
  }

  private async initialize(): Promise<void> {
    await applyPortfolioMigrations(this.db);
  }

  close(): Promise<void> {
    return this.db.close();
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
    const rows = candles.map((candle) => [
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
        candle.volume ?? null,
        updatedAt,
      ] as const);
    for (const batch of postgresWriteBatches(
      rows,
      (row) => `${row[0]}\0${row[1]}\0${row[2]}\0${row[3]}\0${row[5]}`,
    )) {
      await database.run(`
        INSERT INTO portfolio_market_candles (
          source_kind, symbol, candle_interval, adjusted, price_date, timestamp, currency,
          open_price, high_price, low_price, close_price, volume, updated_at
        )
        SELECT * FROM UNNEST(
          ?::text[], ?::text[], ?::text[], ?::smallint[], ?::text[], ?::text[], ?::text[],
          ?::float8[], ?::float8[], ?::float8[], ?::float8[], ?::float8[], ?::bigint[]
        ) AS input(
          source_kind, symbol, candle_interval, adjusted, price_date, timestamp, currency,
          open_price, high_price, low_price, close_price, volume, updated_at
        )
        ON CONFLICT(source_kind, symbol, candle_interval, adjusted, timestamp) DO UPDATE SET
          price_date = excluded.price_date,
          currency = excluded.currency,
          open_price = excluded.open_price,
          high_price = excluded.high_price,
          low_price = excluded.low_price,
          close_price = excluded.close_price,
          volume = excluded.volume,
          updated_at = excluded.updated_at
      `, postgresUnnestParameters(batch, 13));
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
    if (!candles.length) return 0;
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
    const responseStatement = `
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
    `;
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
      const [snapshot] = await database.query<SnapshotRow & DatabaseRow>(`
        INSERT INTO portfolio_snapshots (account_id, snapshot_date, captured_at, origin)
        VALUES (?, ?, ?, 'LIVE')
        ON CONFLICT(account_id, snapshot_date)
        DO UPDATE SET captured_at = excluded.captured_at, origin = 'LIVE'
        RETURNING id, snapshot_date, captured_at
      `, [portfolio.selectedAccountId, snapshotDate, capturedAtMs]);
      if (!snapshot) throw new Error("일별 포트폴리오 스냅샷을 생성하지 못했습니다.");

      await database.run("DELETE FROM portfolio_snapshot_items WHERE snapshot_id = ?", [snapshot.id]);
      const rows = eligible.map((holding) => {
        const currency = holding.currency as HistoryCurrency;
        return [
          snapshot.id,
          holding.symbol,
          holding.name,
          holding.market,
          currency,
          holding.evaluationAmount,
          round((holding.evaluationAmount / totals[currency]) * 100),
        ] as const;
      });
      for (const batch of postgresWriteBatches(rows)) {
        await database.run(`
          INSERT INTO portfolio_snapshot_items (
            snapshot_id, symbol, name, market, currency, evaluation_amount, weight_percent
          )
          SELECT * FROM UNNEST(
            ?::bigint[], ?::text[], ?::text[], ?::text[], ?::text[], ?::float8[], ?::float8[]
          ) AS input(
            snapshot_id, symbol, name, market, currency, evaluation_amount, weight_percent
          )
        `, postgresUnnestParameters(batch, 7));
      }
    });
  }

  async upsertOrders(accountId: string, orders: HistoricalOrder[], fetchedAt = Date.now()): Promise<number> {
    if (!orders.length) return 0;
    const rows = orders.map((order) => [
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
    ] as const);
    await this.db.transaction(async (database) => {
      for (const batch of postgresWriteBatches(rows, (row) => `${row[0]}\0${row[1]}`)) {
        await database.run(`
          INSERT INTO portfolio_orders (
            account_id, order_id, symbol, side, currency, status, ordered_at, filled_at,
            filled_quantity, average_filled_price, filled_amount, commission, tax, fetched_at
          )
          SELECT * FROM UNNEST(
            ?::text[], ?::text[], ?::text[], ?::text[], ?::text[], ?::text[], ?::text[],
            ?::text[], ?::float8[], ?::float8[], ?::float8[], ?::float8[], ?::float8[], ?::bigint[]
          ) AS input(
            account_id, order_id, symbol, side, currency, status, ordered_at, filled_at,
            filled_quantity, average_filled_price, filled_amount, commission, tax, fetched_at
          )
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
        `, postgresUnnestParameters(batch, 14));
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
    if (!instruments.length) return 0;
    const rows = instruments.map((instrument) => [
      `${instrument.currency}:${instrument.symbol}`,
      instrument.symbol,
      instrument.name || instrument.symbol,
      instrument.market || (instrument.currency === "USD" ? "미국" : "KRX"),
      instrument.currency,
      updatedAt,
    ] as const);
    await this.db.transaction(async (database) => {
      for (const batch of postgresWriteBatches(rows, (row) => row[0])) {
        await database.run(`
          INSERT INTO portfolio_instruments (
            instrument_key, symbol, name, market, currency, updated_at
          )
          SELECT * FROM UNNEST(
            ?::text[], ?::text[], ?::text[], ?::text[], ?::text[], ?::bigint[]
          ) AS input(instrument_key, symbol, name, market, currency, updated_at)
          ON CONFLICT(instrument_key) DO UPDATE SET
            symbol = excluded.symbol,
            name = excluded.name,
            market = excluded.market,
            currency = excluded.currency,
            updated_at = excluded.updated_at
        `, postgresUnnestParameters(batch, 6));
      }
    });
    return instruments.length;
  }

  async upsertDailyPrices(instrumentKey: string, candles: DailyCandle[], updatedAt = Date.now()): Promise<number> {
    if (!candles.length) return 0;
    const rows = candles.map((candle) => [
      instrumentKey,
      candle.date,
      candle.openPrice,
      candle.highPrice,
      candle.lowPrice,
      candle.closePrice,
      candle.currency || instrumentKey.split(":", 1)[0],
      candle.timestamp,
      updatedAt,
    ] as const);
    await this.db.transaction(async (database) => {
      for (const batch of postgresWriteBatches(rows, (row) => `${row[0]}\0${row[1]}`)) {
        await database.run(`
          INSERT INTO portfolio_daily_prices (
            instrument_key, price_date, open_price, high_price, low_price, close_price,
            currency, timestamp, updated_at
          )
          SELECT * FROM UNNEST(
            ?::text[], ?::text[], ?::float8[], ?::float8[], ?::float8[], ?::float8[],
            ?::text[], ?::text[], ?::bigint[]
          ) AS input(
            instrument_key, price_date, open_price, high_price, low_price, close_price,
            currency, timestamp, updated_at
          )
          ON CONFLICT(instrument_key, price_date) DO UPDATE SET
            open_price = excluded.open_price,
            high_price = excluded.high_price,
            low_price = excluded.low_price,
            close_price = excluded.close_price,
            currency = excluded.currency,
            timestamp = excluded.timestamp,
            updated_at = excluded.updated_at
        `, postgresUnnestParameters(batch, 9));
      }
      await this.writeMarketCandles(
        database,
        "stock",
        instrumentKey.includes(":") ? instrumentKey.slice(instrumentKey.indexOf(":") + 1) : instrumentKey,
        "1d",
        false,
        candles,
        updatedAt,
      );
    });
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

  async getDailyPriceCoverage(instrumentKeys: readonly string[]): Promise<Map<string, {
    earliest?: string;
    latest?: string;
    incompleteOhlc: boolean;
  }>> {
    const keys = Array.from(new Set(instrumentKeys));
    if (!keys.length) return new Map();
    const rows = await this.db.query<{
      instrument_key: string;
      earliest: string | null;
      latest: string | null;
      incomplete_ohlc: boolean | number;
    }>(`
      SELECT instrument_key,
             MIN(price_date) AS earliest,
             MAX(price_date) AS latest,
             BOOL_OR(open_price IS NULL OR high_price IS NULL OR low_price IS NULL) AS incomplete_ohlc
      FROM portfolio_daily_prices
      WHERE instrument_key = ANY(?::text[])
      GROUP BY instrument_key
    `, [keys]);
    return new Map(rows.map((row) => [row.instrument_key, {
      ...(row.earliest ? { earliest: row.earliest } : {}),
      ...(row.latest ? { latest: row.latest } : {}),
      incompleteOhlc: Boolean(row.incomplete_ohlc),
    }]));
  }

  async hasIncompleteDailyOhlc(instrumentKey?: string): Promise<boolean> {
    const [row] = instrumentKey
      ? await this.db.query<{ found: number }>(`
          SELECT 1 AS found
          FROM portfolio_daily_prices
          WHERE instrument_key = ? AND (open_price IS NULL OR high_price IS NULL OR low_price IS NULL)
          LIMIT 1
        `, [instrumentKey])
      : await this.db.query<{ found: number }>(`
          SELECT 1 AS found
          FROM portfolio_daily_prices
          WHERE open_price IS NULL OR high_price IS NULL OR low_price IS NULL
          LIMIT 1
        `);
    return row !== undefined;
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
    if (!candles.length) return 0;
    const rows = candles.map((candle) => [
      instrumentKey,
      candle.date,
      candle.closePrice,
      candle.currency || instrumentKey.split(":", 1)[0],
      candle.timestamp,
      updatedAt,
    ] as const);
    await this.db.transaction(async (database) => {
      for (const batch of postgresWriteBatches(rows, (row) => `${row[0]}\0${row[1]}`)) {
        await database.run(`
          INSERT INTO portfolio_backtest_prices (
            instrument_key, price_date, close_price, currency, timestamp, updated_at
          )
          SELECT * FROM UNNEST(
            ?::text[], ?::text[], ?::float8[], ?::text[], ?::text[], ?::bigint[]
          ) AS input(instrument_key, price_date, close_price, currency, timestamp, updated_at)
          ON CONFLICT(instrument_key, price_date) DO UPDATE SET
            close_price = excluded.close_price,
            currency = excluded.currency,
            timestamp = excluded.timestamp,
            updated_at = excluded.updated_at
        `, postgresUnnestParameters(batch, 6));
      }
      await this.writeMarketCandles(
        database,
        "stock",
        instrumentKey.includes(":") ? instrumentKey.slice(instrumentKey.indexOf(":") + 1) : instrumentKey,
        "1d",
        true,
        candles,
        updatedAt,
      );
    });
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
        ON prices.instrument_key = items.currency || ':' || items.symbol
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
    if (!candles.length) return 0;
    const rows = candles.map((candle) => [
      benchmarkKey,
      candle.date,
      candle.closePrice,
      candle.timestamp,
      updatedAt,
    ] as const);
    await this.db.transaction(async (database) => {
      for (const batch of postgresWriteBatches(rows, (row) => `${row[0]}\0${row[1]}`)) {
        await database.run(`
          INSERT INTO portfolio_benchmark_prices (
            benchmark_key, price_date, close_price, timestamp, updated_at
          )
          SELECT * FROM UNNEST(
            ?::text[], ?::text[], ?::float8[], ?::text[], ?::bigint[]
          ) AS input(benchmark_key, price_date, close_price, timestamp, updated_at)
          ON CONFLICT(benchmark_key, price_date) DO UPDATE SET
            close_price = excluded.close_price,
            timestamp = excluded.timestamp,
            updated_at = excluded.updated_at
        `, postgresUnnestParameters(batch, 5));
      }
      const indicator = benchmarkKey === "KOSPI" || benchmarkKey === "KOSDAQ";
      const symbol = benchmarkKey === "NASDAQ100" ? "QQQ" : benchmarkKey === "SP500" ? "SPY" : benchmarkKey;
      await this.writeMarketCandles(
        database,
        indicator ? "indicator" : "stock",
        symbol,
        "1d",
        !indicator,
        candles,
        updatedAt,
      );
    });
    return candles.length;
  }

  async upsertExchangeRates(
    rates: readonly { date: string; rate: number; timestamp: string }[],
    updatedAt = Date.now(),
  ): Promise<number> {
    const rows = rates.map((item) => [
      item.date,
      item.rate,
      item.timestamp,
      updatedAt,
    ] as const);
    for (const batch of postgresWriteBatches(rows, (row) => row[0])) {
      await this.db.run(`
        INSERT INTO portfolio_exchange_rates (
          rate_date, base_currency, quote_currency, rate, timestamp, updated_at
        )
        SELECT rate_date, 'USD', 'KRW', rate, timestamp, updated_at
        FROM UNNEST(
          ?::text[], ?::float8[], ?::text[], ?::bigint[]
        ) AS input(rate_date, rate, timestamp, updated_at)
        ON CONFLICT(rate_date, base_currency, quote_currency) DO UPDATE SET
          rate = excluded.rate,
          timestamp = excluded.timestamp,
          updated_at = excluded.updated_at
      `, postgresUnnestParameters(batch, 4));
    }
    return rates.length;
  }

  upsertExchangeRate(
    rateDate: string,
    rate: number,
    timestamp: string,
    updatedAt = Date.now(),
  ): Promise<void> {
    return this.upsertExchangeRates([{ date: rateDate, rate, timestamp }], updatedAt)
      .then(() => undefined);
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
    const eligible = snapshots.filter((snapshot) => snapshot.date < beforeDate);

    return this.db.transaction(async (database) => {
      await database.run(`
        DELETE FROM portfolio_snapshots
        WHERE account_id = ? AND snapshot_date < ? AND origin = 'HISTORICAL'
      `, [accountId, beforeDate]);
      let written = 0;
      for (const snapshotBatch of postgresWriteBatches(
        eligible,
        (snapshot) => `${accountId}\0${snapshot.date}`,
      )) {
        const batch = snapshotBatch.map((snapshot) => [
          accountId,
          snapshot.date,
          snapshot.capturedAt,
        ] as const);
        const stored = await database.query<SnapshotRow & DatabaseRow>(`
          INSERT INTO portfolio_snapshots (account_id, snapshot_date, captured_at, origin)
          SELECT account_id, snapshot_date, captured_at, 'HISTORICAL'
          FROM UNNEST(
            ?::text[], ?::text[], ?::bigint[]
          ) AS input(account_id, snapshot_date, captured_at)
          ON CONFLICT(account_id, snapshot_date) DO UPDATE SET
            captured_at = excluded.captured_at,
            origin = 'HISTORICAL'
          WHERE portfolio_snapshots.origin = 'HISTORICAL'
          RETURNING id, snapshot_date, captured_at, origin
        `, postgresUnnestParameters(batch, 3));
        if (!stored.length) continue;
        const snapshotIds = stored.map((row) => Number(row.id));
        await database.run(
          "DELETE FROM portfolio_snapshot_items WHERE snapshot_id = ANY(?::bigint[])",
          [snapshotIds],
        );
        const snapshotByDate = new Map(
          snapshotBatch.map((snapshot) => [snapshot.date, snapshot]),
        );
        const itemRows = stored.flatMap((row) => {
          const snapshot = snapshotByDate.get(row.snapshot_date);
          if (!snapshot || row.origin !== "HISTORICAL") return [];
          const totals = snapshot.items.reduce<Record<HistoryCurrency, number>>(
            (sum, item) => {
              sum[item.currency] += item.evaluationAmount;
              return sum;
            },
            { KRW: 0, USD: 0 },
          );
          return snapshot.items.flatMap((item) => {
            const total = totals[item.currency];
            if (item.evaluationAmount <= 0 || total <= 0) return [];
            return [[
              Number(row.id),
              item.symbol,
              item.name,
              item.market,
              item.currency,
              item.evaluationAmount,
              round((item.evaluationAmount / total) * 100),
            ] as const];
          });
        });
        for (const itemBatch of postgresWriteBatches(itemRows)) {
          await database.run(`
            INSERT INTO portfolio_snapshot_items (
              snapshot_id, symbol, name, market, currency, evaluation_amount, weight_percent
            )
            SELECT * FROM UNNEST(
              ?::bigint[], ?::text[], ?::text[], ?::text[], ?::text[], ?::float8[], ?::float8[]
            ) AS input(
              snapshot_id, symbol, name, market, currency, evaluation_amount, weight_percent
            )
          `, postgresUnnestParameters(itemBatch, 7));
        }
        written += stored.length;
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
    await this.db.run(`
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
    `, [
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
