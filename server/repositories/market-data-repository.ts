import { createHash } from "node:crypto";
import type { RelationalDatabase } from "../database.js";
import type { MarketCandleSource } from "../history.js";

export type CachedInstrument = {
  symbol: string;
  name: string;
  market: string;
  currency: "KRW" | "USD";
  updatedAt: number;
};

export type CachedMarketCandle = {
  date: string;
  timestamp: string;
  currency: "KRW" | "USD";
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  updatedAt: number;
};

export class MarketDataRepository {
  constructor(private readonly database: RelationalDatabase) {}

  async searchInstruments(query: string, limit = 20): Promise<CachedInstrument[]> {
    const normalized = query.trim().toLowerCase();
    const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const rows = await this.database.query<{
      symbol: string;
      name: string;
      market: string;
      currency: string;
      updated_at: number;
    }>(`
      SELECT symbol, name, market, currency, updated_at
      FROM portfolio_instruments
      WHERE LOWER(symbol) LIKE ? OR LOWER(name) LIKE ? OR LOWER(market) LIKE ?
      ORDER BY CASE WHEN LOWER(symbol) = ? THEN 0 ELSE 1 END, symbol ASC
      LIMIT ${safeLimit}
    `, [`%${normalized}%`, `%${normalized}%`, `%${normalized}%`, normalized]);
    return rows.flatMap((row) => (
      row.currency === "KRW" || row.currency === "USD"
        ? [{
            symbol: row.symbol,
            name: row.name,
            market: row.market,
            currency: row.currency,
            updatedAt: Number(row.updated_at),
          }]
        : []
    ));
  }

  async listUniverse(limit = 500): Promise<CachedInstrument[]> {
    const safeLimit = Math.max(1, Math.min(5_000, Math.floor(limit)));
    const rows = await this.database.query<{
      symbol: string;
      name: string;
      market: string;
      currency: string;
      updated_at: number;
    }>(`
      SELECT symbol, name, market, currency, updated_at
      FROM portfolio_instruments ORDER BY updated_at DESC, symbol ASC LIMIT ${safeLimit}
    `);
    return rows.flatMap((row) => (
      row.currency === "KRW" || row.currency === "USD"
        ? [{ ...row, updatedAt: Number(row.updated_at) } as CachedInstrument]
        : []
    ));
  }

  async getCandles(input: {
    source?: MarketCandleSource;
    symbol: string;
    adjusted: boolean;
    fromDate: string;
    toDate: string;
  }): Promise<CachedMarketCandle[]> {
    const source = input.source ?? "stock";
    const rows = await this.database.query<{
      price_date: string;
      timestamp: string;
      currency: string;
      open_price: number;
      high_price: number;
      low_price: number;
      close_price: number;
      volume: number | null;
      updated_at: number;
    }>(`
      SELECT price_date, timestamp, currency, open_price, high_price, low_price, close_price, volume, updated_at
      FROM portfolio_market_candles
      WHERE source_kind = ? AND symbol = ? AND candle_interval = '1d' AND adjusted = ?
        AND price_date BETWEEN ? AND ?
      ORDER BY price_date ASC
    `, [source, input.symbol, input.adjusted ? 1 : 0, input.fromDate, input.toDate]);
    return rows.flatMap((row) => (
      row.currency === "KRW" || row.currency === "USD"
        ? [{
            date: row.price_date,
            timestamp: row.timestamp,
            currency: row.currency,
            open: Number(row.open_price),
            high: Number(row.high_price),
            low: Number(row.low_price),
            close: Number(row.close_price),
            volume: row.volume === null || !Number.isFinite(Number(row.volume)) || Number(row.volume) < 0
              ? null
              : Number(row.volume),
            updatedAt: Number(row.updated_at),
          }]
        : []
    ));
  }

  async availability(input: {
    source?: MarketCandleSource;
    symbol: string;
    adjusted: boolean;
  }): Promise<{ firstDate?: string; lastDate?: string; observations: number; volumeObservations: number; revision: number }> {
    const [row] = await this.database.query<{
      first_date: string | null;
      last_date: string | null;
      observations: number;
      volume_observations: number;
      revision: number;
    }>(`
      SELECT MIN(price_date) AS first_date, MAX(price_date) AS last_date,
             COUNT(*) AS observations, COUNT(volume) AS volume_observations,
             COALESCE(MAX(updated_at), 0) AS revision
      FROM portfolio_market_candles
      WHERE source_kind = ? AND symbol = ? AND candle_interval = '1d' AND adjusted = ?
    `, [input.source ?? "stock", input.symbol, input.adjusted ? 1 : 0]);
    return {
      ...(row?.first_date ? { firstDate: row.first_date } : {}),
      ...(row?.last_date ? { lastDate: row.last_date } : {}),
      observations: Number(row?.observations ?? 0),
      volumeObservations: Number(row?.volume_observations ?? 0),
      revision: Number(row?.revision ?? 0),
    };
  }

  async volumeCoverage(input: {
    source?: MarketCandleSource;
    symbol: string;
    adjusted: boolean;
    fromDate: string;
    toDate: string;
  }): Promise<{ observations: number; volumeObservations: number }> {
    const [row] = await this.database.query<{
      observations: number;
      volume_observations: number;
    }>(`
      SELECT COUNT(*) AS observations, COUNT(volume) AS volume_observations
      FROM portfolio_market_candles
      WHERE source_kind = ? AND symbol = ? AND candle_interval = '1d' AND adjusted = ?
        AND price_date BETWEEN ? AND ?
    `, [
      input.source ?? "stock",
      input.symbol,
      input.adjusted ? 1 : 0,
      input.fromDate,
      input.toDate,
    ]);
    return {
      observations: Number(row?.observations ?? 0),
      volumeObservations: Number(row?.volume_observations ?? 0),
    };
  }

  async dataRevision(): Promise<string> {
    const [candle] = await this.database.query<{ count: number; revision: number; volume_sum: number }>(`
      SELECT COUNT(*) AS count, COALESCE(MAX(updated_at), 0) AS revision,
             COALESCE(SUM(volume), 0) AS volume_sum
      FROM portfolio_market_candles
    `);
    const [fx] = await this.database.query<{ count: number; revision: number }>(`
      SELECT COUNT(*) AS count, COALESCE(MAX(updated_at), 0) AS revision FROM portfolio_exchange_rates
    `);
    return createHash("sha256")
      .update(`${Number(candle?.count ?? 0)}:${Number(candle?.revision ?? 0)}:${Number(candle?.volume_sum ?? 0)}:${Number(fx?.count ?? 0)}:${Number(fx?.revision ?? 0)}`)
      .digest("hex");
  }
}
