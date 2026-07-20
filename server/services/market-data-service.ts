import { createHash } from "node:crypto";
import { BacktestValidationError } from "../backtest-engine.js";
import { isHistoryDate, kstDateString, type PortfolioHistoryStore } from "../history.js";
import {
  MarketDataRepository,
  type CachedMarketCandle,
} from "../repositories/market-data-repository.js";
import { TossApiError, type InstrumentInfo, type TossClient } from "../toss.js";
import {
  KisApiError,
  type KisExchangeRateProvider,
} from "../kis-exchange-rate.js";
import { ServiceError } from "./service-envelope.js";

const API_PACING_MS = 230;
const MAX_PRICE_PAGES = 100;
const FX_SEED_LOOKBACK_DAYS = 7;
const MAX_FX_CARRY_FORWARD_DAYS = 7;

export type MarketInterval = "1d" | "1w" | "1mo";
export type CurrencyMode = "local" | "KRW";
export type MarketVolumeStatus = "available" | "partial" | "volume_unavailable";

export type MarketInstrument = {
  symbol: string;
  name: string;
  market: string;
  currency: "KRW" | "USD";
  assetType: string;
  listDate?: string;
  status?: string;
};

export type MarketSeriesPoint = {
  date: string;
  periodStart: string;
  periodEnd: string;
  observations: number;
  open: number;
  high: number;
  low: number;
  close: number;
  localOpen: number;
  localHigh: number;
  localLow: number;
  localClose: number;
  fxRate: number;
  volume: number | null;
};

export type MarketSeriesResult = {
  instrument: MarketInstrument;
  interval: MarketInterval;
  adjusted: boolean;
  currencyMode: CurrencyMode;
  currency: "KRW" | "USD";
  points: MarketSeriesPoint[];
  requestedPeriod: { from: string; to: string };
  effectivePeriod?: { from: string; to: string };
  dataRevision: string;
  assumptions: string[];
  warnings: string[];
  dataQuality: {
    observations: number;
    outputObservations: number;
    volumeObservations: number;
    missingVolumeObservations: number;
    volumeCoverage: number;
    volumeStatus: MarketVolumeStatus;
    sourceDailyVolumeObservations: number;
    sourceDailyMissingVolumeObservations: number;
    sourceDailyVolumeCoverage: number;
    sourceDailyVolumeStatus: MarketVolumeStatus;
    missingFxObservations: number;
    carriedFxObservations: number;
    firstObservationDate?: string;
    metadataListDate?: string;
    metadataListDateRole: "provider_listing_metadata_not_verified_inception";
    listingDateConsistency: "consistent" | "price_precedes_metadata" | "unavailable";
  };
};

function listingDateConsistency(
  firstObservationDate: string | undefined,
  metadataListDate: string | undefined,
): "consistent" | "price_precedes_metadata" | "unavailable" {
  if (!firstObservationDate || !metadataListDate) return "unavailable";
  return firstObservationDate < metadataListDate ? "price_precedes_metadata" : "consistent";
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function normalizeSymbol(value: string): string {
  const symbol = value.trim().toUpperCase();
  if (!/^[A-Z0-9.-]{1,32}$/.test(symbol)) {
    throw new BacktestValidationError("종목 코드는 영문, 숫자, 마침표와 하이픈만 사용할 수 있습니다.");
  }
  return symbol;
}

function asInstrument(value: InstrumentInfo): MarketInstrument {
  if (value.currency !== "KRW" && value.currency !== "USD") {
    throw new BacktestValidationError(`${value.symbol}의 통화를 지원하지 않습니다.`);
  }
  return {
    symbol: value.symbol.toUpperCase(),
    name: value.name || value.symbol,
    market: value.market,
    currency: value.currency,
    assetType: value.securityType || "STOCK",
    ...(value.listDate && isHistoryDate(value.listDate) ? { listDate: value.listDate } : {}),
    ...(value.status ? { status: value.status } : {}),
  };
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function calendarDaysBetween(fromDate: string, toDate: string): number {
  return Math.round((Date.parse(`${toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`)) / 86_400_000);
}

function isMissingExchangeRate(error: unknown): error is TossApiError {
  return error instanceof TossApiError
    && error.status === 404
    && error.code === "exchange-rate-not-found";
}

function upstreamErrorDetails(error: unknown): Record<string, unknown> {
  if (error instanceof TossApiError) {
    return {
      provider: "toss",
      status: error.status,
      code: error.code,
      ...(error.requestId ? { request_id: error.requestId } : {}),
    };
  }
  if (error instanceof KisApiError) {
    return {
      provider: "kis",
      status: error.status,
      code: error.code,
    };
  }
  return {
    type: error instanceof Error ? error.name : "UnknownError",
  };
}

function weekKey(date: string): string {
  const value = new Date(`${date}T00:00:00Z`);
  const day = value.getUTCDay() || 7;
  value.setUTCDate(value.getUTCDate() - day + 1);
  return value.toISOString().slice(0, 10);
}

function round(value: number, digits = 6): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function aggregate(points: MarketSeriesPoint[], interval: MarketInterval): MarketSeriesPoint[] {
  if (interval === "1d") return points;
  const groups = new Map<string, MarketSeriesPoint[]>();
  for (const point of points) {
    const key = interval === "1mo" ? point.date.slice(0, 7) : weekKey(point.date);
    const values = groups.get(key) ?? [];
    values.push(point);
    groups.set(key, values);
  }
  return Array.from(groups.values()).map((values) => {
    const first = values[0];
    const last = values.at(-1)!;
    return {
      date: last.date,
      periodStart: first.date,
      periodEnd: last.date,
      observations: values.length,
      open: first.open,
      high: Math.max(...values.map((item) => item.high)),
      low: Math.min(...values.map((item) => item.low)),
      close: last.close,
      localOpen: first.localOpen,
      localHigh: Math.max(...values.map((item) => item.localHigh)),
      localLow: Math.min(...values.map((item) => item.localLow)),
      localClose: last.localClose,
      fxRate: last.fxRate,
      volume: values.every((item) => item.volume !== null)
        ? values.reduce((sum, item) => sum + item.volume!, 0)
        : null,
    };
  });
}

export class MarketDataService {
  readonly repository: MarketDataRepository;
  private readonly fxInFlight = new Map<string, Promise<void>>();
  private readonly fxFallbackInFlight = new Map<string, Promise<number>>();

  constructor(
    private readonly toss: TossClient,
    private readonly store: PortfolioHistoryStore,
    private readonly exchangeRateFallback?: KisExchangeRateProvider,
  ) {
    this.repository = new MarketDataRepository(store.relationalDatabase);
  }

  async resolveInstruments(symbols: string[]): Promise<MarketInstrument[]> {
    const normalized = Array.from(new Set(symbols.map(normalizeSymbol)));
    if (!normalized.length || normalized.length > 20) {
      throw new BacktestValidationError("조회할 종목은 1~20개까지 입력할 수 있습니다.");
    }
    const instruments = (await this.toss.getInstruments(normalized)).map(asInstrument);
    const bySymbol = new Map(instruments.map((instrument) => [instrument.symbol, instrument]));
    const missing = normalized.filter((symbol) => !bySymbol.has(symbol));
    if (missing.length) throw new BacktestValidationError(`종목 정보를 찾을 수 없습니다: ${missing.join(", ")}`);
    await this.store.upsertInstruments(instruments.map((instrument) => ({
      symbol: instrument.symbol,
      name: instrument.name,
      market: instrument.market,
      currency: instrument.currency,
      listDate: instrument.listDate,
      securityType: instrument.assetType,
      status: instrument.status,
    })));
    return normalized.map((symbol) => bySymbol.get(symbol)!);
  }

  async searchInstruments(query: string, limit = 20): Promise<MarketInstrument[]> {
    const text = query.trim();
    if (!text || text.length > 80) throw new BacktestValidationError("검색어는 1~80자로 입력해 주세요.");
    const results = await this.repository.searchInstruments(text, limit);
    let exact: MarketInstrument | undefined;
    if (/^[A-Za-z0-9.-]{1,32}$/.test(text)) {
      try {
        exact = (await this.resolveInstruments([text]))[0];
      } catch {
        // A name fragment can also match the symbol grammar; cached name results remain useful.
      }
    }
    const ordered = [
      ...(exact ? [exact] : []),
      ...results.filter((item) => item.symbol !== exact?.symbol).map((item) => ({ ...item, assetType: "UNKNOWN" })),
    ].slice(0, limit);
    const cachedSymbols = ordered.filter((item) => item.assetType === "UNKNOWN").map((item) => item.symbol);
    if (!cachedSymbols.length) return ordered;
    try {
      const enriched = (await this.toss.getInstruments(cachedSymbols)).map(asInstrument);
      const bySymbol = new Map(enriched.map((item) => [item.symbol, item]));
      await this.store.upsertInstruments(enriched.map((item) => ({
        symbol: item.symbol,
        name: item.name,
        market: item.market,
        currency: item.currency,
        listDate: item.listDate,
        securityType: item.assetType,
        status: item.status,
      })));
      return ordered.map((item) => bySymbol.get(item.symbol) ?? item);
    } catch {
      return ordered;
    }
  }

  private async ensureDailyCandles(
    instrument: MarketInstrument,
    fromDate: string,
    toDate: string,
    adjusted: boolean,
    requireVolume: boolean,
  ): Promise<void> {
    const available = await this.repository.availability({ symbol: instrument.symbol, adjusted });
    const historicalEnd = toDate < addDays(kstDateString(new Date()), -7);
    const hasEnd = historicalEnd
      ? Boolean(available.lastDate && available.lastDate >= toDate)
      : Boolean(available.lastDate && available.lastDate >= addDays(toDate, -7));
    const cachedVolume = requireVolume
      ? await this.repository.volumeCoverage({
          symbol: instrument.symbol,
          adjusted,
          fromDate,
          toDate,
        })
      : undefined;
    const hasProviderVolume = !requireVolume
      || cachedVolume?.observations === 0
      || (cachedVolume?.volumeObservations ?? 0) > 0;
    if (available.firstDate && available.firstDate <= fromDate && hasEnd && hasProviderVolume) return;

    const seenBefore = new Set<string>();
    let before: string | undefined;
    for (let pageIndex = 0; pageIndex < MAX_PRICE_PAGES; pageIndex += 1) {
      if (pageIndex > 0) await sleep(API_PACING_MS);
      const page = await this.toss.getDailyCandles(instrument.symbol, before, adjusted);
      if (adjusted) {
        await this.store.upsertBacktestPrices(`${instrument.currency}:${instrument.symbol}`, page.candles);
      } else {
        await this.store.upsertMarketCandles("stock", instrument.symbol, "1d", false, page.candles);
      }
      const oldest = [...page.candles].map((candle) => candle.date).sort()[0];
      if (!page.nextBefore || !page.candles.length || (oldest && oldest <= fromDate)) return;
      if (seenBefore.has(page.nextBefore)) {
        throw new BacktestValidationError(`${instrument.name} 일봉 커서가 반복되었습니다.`);
      }
      seenBefore.add(page.nextBefore);
      before = page.nextBefore;
    }
    throw new BacktestValidationError(`${instrument.name}의 일봉 조회 범위가 안전 한도를 초과했습니다.`);
  }

  private async refreshExchangeRate(date: string): Promise<void> {
    const existing = this.fxInFlight.get(date);
    if (existing) return existing;
    const task = this.toss.getUsdKrwExchangeRate(date)
      .then((rate) => this.store.upsertExchangeRate(rate.date, rate.rate, rate.timestamp))
      .finally(() => this.fxInFlight.delete(date));
    this.fxInFlight.set(date, task);
    return task;
  }

  private async refreshExchangeRatesFromFallback(fromDate: string, toDate: string): Promise<number> {
    if (!this.exchangeRateFallback || fromDate > toDate) return 0;
    const key = `${fromDate}:${toDate}`;
    const existing = this.fxFallbackInFlight.get(key);
    if (existing) return existing;
    const task = (async () => {
      const rates = await this.exchangeRateFallback!.getUsdKrwExchangeRates(fromDate, toDate);
      if (!rates.length) {
        throw new KisApiError(
          "한국투자증권에도 요청 기간의 USD/KRW 환율이 없습니다.",
          404,
          "exchange-rate-not-found",
          false,
        );
      }
      for (const rate of rates) {
        await this.store.upsertExchangeRate(rate.date, rate.rate, rate.timestamp);
      }
      console.info(`[fx] KIS 폴백으로 USD/KRW ${rates.length}개 관측을 채웠습니다.`);
      return rates.length;
    })().finally(() => this.fxFallbackInFlight.delete(key));
    this.fxFallbackInFlight.set(key, task);
    return task;
  }

  async ensureExchangeRates(dates: string[]): Promise<Map<string, number>> {
    const sorted = Array.from(new Set(dates.filter(isHistoryDate))).sort();
    if (!sorted.length) return new Map();
    const firstRequestedDate = sorted[0];
    const lastRequestedDate = sorted.at(-1)!;
    const seedFromDate = addDays(firstRequestedDate, -FX_SEED_LOOKBACK_DAYS);
    let cached = await this.store.getExchangeRates(seedFromDate, lastRequestedDate);
    const hasStartingRate = () => Array.from(cached.entries()).some(
      ([date, rate]) => date <= firstRequestedDate && Number.isFinite(rate) && rate > 0,
    );
    let lastSeedError: unknown;

    // A preceding close is a legitimate carry-forward seed for a market/FX
    // holiday mismatch. Never use a later rate to backfill an older period.
    if (!hasStartingRate()) {
      for (let offset = 0; offset >= -FX_SEED_LOOKBACK_DAYS; offset -= 1) {
        const date = addDays(firstRequestedDate, offset);
        try {
          await this.refreshExchangeRate(date);
          cached = await this.store.getExchangeRates(seedFromDate, lastRequestedDate);
          if (hasStartingRate()) break;
        } catch (error) {
          if (!isMissingExchangeRate(error)) {
            throw new ServiceError({
              code: "FX_RATE_FETCH_FAILED",
              message: "USD/KRW 환율 공급자 조회에 실패했습니다.",
              retryable: error instanceof TossApiError ? error.status >= 500 || error.status === 429 : true,
              details: {
                fx_pair: "USD/KRW",
                requested_period: { from: firstRequestedDate, to: lastRequestedDate },
                attempted_date: date,
                upstream: upstreamErrorDetails(error),
              },
            });
          }
          lastSeedError = error;
        }
      }
    }

    if (!hasStartingRate() && this.exchangeRateFallback) {
      const firstCachedDate = Array.from(cached.entries())
        .filter(([, rate]) => Number.isFinite(rate) && rate > 0)
        .map(([date]) => date)
        .sort()[0];
      const fallbackToDate = firstCachedDate ? addDays(firstCachedDate, -1) : lastRequestedDate;
      if (seedFromDate <= fallbackToDate) {
        try {
          await this.refreshExchangeRatesFromFallback(seedFromDate, fallbackToDate);
          cached = await this.store.getExchangeRates(seedFromDate, lastRequestedDate);
        } catch (error) {
          lastSeedError = error;
          if (!(error instanceof KisApiError) || error.code !== "exchange-rate-not-found") {
            throw new ServiceError({
              code: "FX_RATE_FETCH_FAILED",
              message: "USD/KRW 환율 폴백 공급자 조회에 실패했습니다.",
              retryable: error instanceof KisApiError ? error.retryable : true,
              details: {
                fx_pair: "USD/KRW",
                requested_period: { from: firstRequestedDate, to: lastRequestedDate },
                attempted_period: { from: seedFromDate, to: fallbackToDate },
                upstream: upstreamErrorDetails(error),
              },
            });
          }
        }
      }
    }

    if (!hasStartingRate()) {
      const availableDates = Array.from(cached.entries())
        .filter(([, rate]) => Number.isFinite(rate) && rate > 0)
        .map(([date]) => date)
        .sort();
      throw new ServiceError({
        code: "FX_HISTORY_UNAVAILABLE",
        message: `USD/KRW 환율이 ${firstRequestedDate}부터 제공되지 않아 원화 가격을 계산할 수 없습니다.`,
        retryable: false,
        details: {
          fx_pair: "USD/KRW",
          requested_period: { from: firstRequestedDate, to: lastRequestedDate },
          fx_available_period: availableDates.length
            ? { from: availableDates[0], to: availableDates.at(-1)! }
            : null,
          missing_observation_count: sorted.filter((date) => !cached.has(date)).length,
          attempted_seed_period: { from: seedFromDate, to: firstRequestedDate },
          upstream: upstreamErrorDetails(lastSeedError),
        },
      });
    }

    const missing = sorted.filter((date) => !cached.has(date));
    let cursor = 0;
    const workers = Math.min(2, missing.length);
    await Promise.all(Array.from({ length: workers }, async () => {
      while (cursor < missing.length) {
        const date = missing[cursor++];
        try {
          await this.refreshExchangeRate(date);
        } catch (error) {
          // Once a valid preceding rate exists, an isolated holiday miss is
          // represented by carry-forward metadata instead of a generic 500.
          if (!isMissingExchangeRate(error)) {
            throw new ServiceError({
              code: "FX_RATE_FETCH_FAILED",
              message: "USD/KRW 환율 공급자 조회에 실패했습니다.",
              retryable: error instanceof TossApiError ? error.status >= 500 || error.status === 429 : true,
              details: {
                fx_pair: "USD/KRW",
                requested_period: { from: firstRequestedDate, to: lastRequestedDate },
                attempted_date: date,
                missing_observation_count: missing.length,
                upstream: upstreamErrorDetails(error),
              },
            });
          }
        }
        if (cursor < missing.length) await sleep(API_PACING_MS);
      }
    }));
    const resolved = await this.store.getExchangeRates(seedFromDate, lastRequestedDate);
    const validRates = Array.from(resolved.entries())
      .filter(([, rate]) => Number.isFinite(rate) && rate > 0)
      .sort(([left], [right]) => left.localeCompare(right));
    let rateIndex = 0;
    let lastValidFxDate: string | undefined;
    for (const date of sorted) {
      while (rateIndex < validRates.length && validRates[rateIndex]![0] <= date) {
        lastValidFxDate = validRates[rateIndex]![0];
        rateIndex += 1;
      }
      if (!lastValidFxDate) continue;
      const carryForwardDays = calendarDaysBetween(lastValidFxDate, date);
      if (carryForwardDays <= MAX_FX_CARRY_FORWARD_DAYS) continue;
      throw new ServiceError({
        code: "FX_HISTORY_UNAVAILABLE",
        message: `USD/KRW 환율을 ${MAX_FX_CARRY_FORWARD_DAYS}일 넘게 이월해야 하므로 ${date} 원화 가격을 계산할 수 없습니다.`,
        retryable: false,
        details: {
          fx_pair: "USD/KRW",
          requested_period: { from: firstRequestedDate, to: lastRequestedDate },
          fx_available_period: validRates.length
            ? { from: validRates[0]![0], to: validRates.at(-1)![0] }
            : null,
          missing_observation_count: sorted.filter((requiredDate) => !resolved.has(requiredDate)).length,
          last_valid_fx_date: lastValidFxDate,
          first_uncovered_date: date,
          carry_forward_days: carryForwardDays,
          carry_forward_limit_days: MAX_FX_CARRY_FORWARD_DAYS,
        },
      });
    }
    return resolved;
  }

  async getCachedExchangeRateAvailability(fromDate: string, toDate: string): Promise<{
    firstDate?: string;
    lastDate?: string;
    observations: number;
  }> {
    const rates = await this.store.getExchangeRates(fromDate, toDate);
    const dates = Array.from(rates.keys()).sort();
    return {
      ...(dates[0] ? { firstDate: dates[0] } : {}),
      ...(dates.at(-1) ? { lastDate: dates.at(-1)! } : {}),
      observations: dates.length,
    };
  }

  async getPriceSeries(input: {
    symbol: string;
    fromDate: string;
    toDate: string;
    interval?: MarketInterval;
    adjusted?: boolean;
    currencyMode?: CurrencyMode;
    requireVolume?: boolean;
  }): Promise<MarketSeriesResult> {
    if (!isHistoryDate(input.fromDate) || !isHistoryDate(input.toDate) || input.fromDate > input.toDate) {
      throw new BacktestValidationError("가격 조회 시작일과 종료일을 확인해 주세요.");
    }
    const interval = input.interval ?? "1d";
    const adjusted = input.adjusted ?? true;
    const currencyMode = input.currencyMode ?? "KRW";
    if (!["1d", "1w", "1mo"].includes(interval) || !["local", "KRW"].includes(currencyMode)) {
      throw new BacktestValidationError("가격 interval 또는 통화 기준을 확인해 주세요.");
    }
    const instrument = (await this.resolveInstruments([input.symbol]))[0];
    await this.ensureDailyCandles(instrument, input.fromDate, input.toDate, adjusted, input.requireVolume ?? false);
    const candles = await this.repository.getCandles({
      symbol: instrument.symbol,
      adjusted,
      fromDate: input.fromDate,
      toDate: input.toDate,
    });
    const needsFx = currencyMode === "KRW" && instrument.currency === "USD";
    let exchangeRates = new Map<string, number>();
    if (needsFx) {
      try {
        exchangeRates = await this.ensureExchangeRates(candles.map((item) => item.date));
      } catch (error) {
        if (error instanceof ServiceError) {
          throw new ServiceError({
            ...error.detail,
            details: {
              ...error.detail.details,
              symbol: instrument.symbol,
              requested_period: { from: input.fromDate, to: input.toDate },
            },
          });
        }
        throw error;
      }
    }
    const firstCandleDate = candles[0]?.date;
    const startingRate = needsFx && firstCandleDate
      ? Array.from(exchangeRates.entries())
        .filter(([date, rate]) => date <= firstCandleDate && Number.isFinite(rate) && rate > 0)
        .sort(([left], [right]) => left.localeCompare(right))
        .at(-1)?.[1]
      : undefined;
    let latestRate = needsFx
      ? startingRate ?? 0
      : instrument.currency === "USD" && currencyMode === "local" ? 1 : 0;
    let missingFxObservations = 0;
    let carriedFxObservations = 0;
    const points = candles.flatMap((candle): MarketSeriesPoint[] => {
      const exactRate = needsFx ? exchangeRates.get(candle.date) : 1;
      if (exactRate && exactRate > 0) latestRate = exactRate;
      else if (needsFx && latestRate > 0) carriedFxObservations += 1;
      else if (needsFx) missingFxObservations += 1;
      const rate = needsFx ? latestRate : 1;
      if (!(rate > 0)) return [];
      return [{
        date: candle.date,
        periodStart: candle.date,
        periodEnd: candle.date,
        observations: 1,
        open: round(candle.open * rate),
        high: round(candle.high * rate),
        low: round(candle.low * rate),
        close: round(candle.close * rate),
        localOpen: candle.open,
        localHigh: candle.high,
        localLow: candle.low,
        localClose: candle.close,
        fxRate: rate,
        volume: candle.volume,
      }];
    });
    const aggregated = aggregate(points, interval);
    const sourceDailyVolumeObservations = points.filter((point) => point.volume !== null).length;
    const sourceDailyMissingVolumeObservations = points.length - sourceDailyVolumeObservations;
    const sourceDailyVolumeCoverage = points.length ? sourceDailyVolumeObservations / points.length : 0;
    const sourceDailyVolumeStatus: MarketVolumeStatus = sourceDailyVolumeObservations === 0
      ? "volume_unavailable"
      : sourceDailyMissingVolumeObservations > 0 ? "partial" : "available";
    const volumeObservations = aggregated.filter((point) => point.volume !== null).length;
    const missingVolumeObservations = aggregated.length - volumeObservations;
    const volumeCoverage = aggregated.length ? volumeObservations / aggregated.length : 0;
    const volumeStatus: MarketVolumeStatus = volumeObservations === 0
      ? "volume_unavailable"
      : missingVolumeObservations > 0 ? "partial" : "available";
    const firstObservationDate = candles[0]?.date;
    const dateConsistency = listingDateConsistency(firstObservationDate, instrument.listDate);
    const dataRevision = createHash("sha256")
      .update(JSON.stringify({
        schema_version: "market-series-data/v2",
        repository_revision: await this.repository.dataRevision(),
        symbol: instrument.symbol,
        adjusted,
        from_date: input.fromDate,
        to_date: input.toDate,
        candles: candles.map((candle) => ({
          date: candle.date,
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
          volume: candle.volume,
        })),
      }))
      .digest("hex");
    return {
      instrument,
      interval,
      adjusted,
      currencyMode,
      currency: currencyMode === "KRW" ? "KRW" : instrument.currency,
      points: aggregated,
      requestedPeriod: { from: input.fromDate, to: input.toDate },
      ...(aggregated.length ? {
        effectivePeriod: { from: aggregated[0].periodStart, to: aggregated.at(-1)!.periodEnd },
      } : {}),
      dataRevision,
      assumptions: [
        adjusted
          ? "투자 성과 계산에는 데이터 공급자가 제공하는 수정주가를 사용합니다."
          : "계좌 과거 평가 복원용 비수정 가격입니다. 투자 성과 비교에 사용하지 마세요.",
        "수정주가에 포함된 기업행위 범위는 공급자 정의를 따릅니다.",
        "별도 현금배당, 세금, 거래비용과 슬리피지는 가격 시계열에 추가하지 않습니다.",
        "거래량은 공급자 원값이며 통화 환산하지 않습니다. 주·월봉은 구성 일봉 거래량이 모두 있을 때만 합계를 제공합니다.",
        "거래량 지표 요청에서 기존 cache의 거래량이 전부 null이면 공급자를 다시 조회하고, 일부 관측만 있는 cache는 공급자의 partial coverage로 보존합니다.",
      ],
      warnings: [
        ...(dateConsistency === "price_precedes_metadata" ? [
          `${instrument.symbol} 가격 첫 관측일 ${firstObservationDate}이 공급자 listDate ${instrument.listDate}보다 빠릅니다. listDate를 역사 시계열 시작일로 사용하지 않습니다.`,
        ] : []),
        ...(carriedFxObservations ? [`환율 ${carriedFxObservations}개 관측은 직전 값을 사용했습니다.`] : []),
        ...(missingFxObservations ? [`환율 ${missingFxObservations}개 관측이 없어 제외했습니다.`] : []),
        ...(input.requireVolume && volumeStatus === "partial" ? [
          `${instrument.symbol} 거래량 ${missingVolumeObservations}개 관측이 누락되어 일부 집계봉은 unavailable입니다.`,
        ] : []),
        ...(input.requireVolume && volumeStatus === "volume_unavailable" ? [
          `${instrument.symbol} 공급자 일봉 거래량을 확인할 수 없어 거래량 지표는 unavailable입니다.`,
        ] : []),
        "모든 결과는 역사적 관측이며 미래 성과를 보장하지 않습니다.",
      ],
      dataQuality: {
        observations: aggregated.reduce((sum, item) => sum + item.observations, 0),
        outputObservations: aggregated.length,
        volumeObservations,
        missingVolumeObservations,
        volumeCoverage,
        volumeStatus,
        sourceDailyVolumeObservations,
        sourceDailyMissingVolumeObservations,
        sourceDailyVolumeCoverage,
        sourceDailyVolumeStatus,
        missingFxObservations,
        carriedFxObservations,
        ...(firstObservationDate ? { firstObservationDate } : {}),
        ...(instrument.listDate ? { metadataListDate: instrument.listDate } : {}),
        metadataListDateRole: "provider_listing_metadata_not_verified_inception",
        listingDateConsistency: dateConsistency,
      },
    };
  }

  async getDataAvailability(symbols: string[], adjusted = true): Promise<{
    assets: Array<MarketInstrument & {
      firstDate?: string;
      lastDate?: string;
      metadataListDate?: string;
      metadataListDateRole: "provider_listing_metadata_not_verified_inception";
      listingDateConsistency: "consistent" | "price_precedes_metadata" | "unavailable";
      observations: number;
      volumeObservations: number;
      missingVolumeObservations: number;
      volumeCoverage: number;
      volumeStatus: MarketVolumeStatus;
      commonObservations: number;
      missingObservations: number;
      observationRate: number;
      adjustedSupported: boolean;
    }>;
    commonPeriod?: { from: string; to: string };
    commonObservations: number;
    unionObservations: number;
    dataRevision: string;
  }> {
    const instruments = await this.resolveInstruments(symbols);
    const available = await Promise.all(instruments.map(async (instrument) => ({
      ...instrument,
      ...await this.repository.availability({ symbol: instrument.symbol, adjusted }),
      adjustedSupported: true,
    })));
    const starts = available.flatMap((item) => item.firstDate ? [item.firstDate] : []);
    const ends = available.flatMap((item) => item.lastDate ? [item.lastDate] : []);
    const from = starts.sort().at(-1);
    const to = ends.sort()[0];
    const commonPeriod = from && to && from <= to ? { from, to } : undefined;
    const observedDates = commonPeriod
      ? await Promise.all(instruments.map(async (instrument) => new Set((await this.repository.getCandles({
          symbol: instrument.symbol,
          adjusted,
          fromDate: commonPeriod.from,
          toDate: commonPeriod.to,
        })).map((item) => item.date))))
      : instruments.map(() => new Set<string>());
    const union = new Set(observedDates.flatMap((dates) => Array.from(dates)));
    const common = observedDates.length
      ? new Set(Array.from(observedDates[0]).filter((date) => observedDates.every((dates) => dates.has(date))))
      : new Set<string>();
    const assets = available.map((item, index) => {
      const missingVolumeObservations = Math.max(0, item.observations - item.volumeObservations);
      const volumeStatus: MarketVolumeStatus = item.volumeObservations === 0
        ? "volume_unavailable"
        : missingVolumeObservations > 0 ? "partial" : "available";
      return {
        ...item,
        ...(item.listDate ? { metadataListDate: item.listDate } : {}),
        metadataListDateRole: "provider_listing_metadata_not_verified_inception" as const,
        listingDateConsistency: listingDateConsistency(item.firstDate, item.listDate),
        volumeObservations: item.volumeObservations,
        missingVolumeObservations,
        volumeCoverage: item.observations ? item.volumeObservations / item.observations : 0,
        volumeStatus,
        commonObservations: observedDates[index].size,
        missingObservations: Math.max(0, union.size - observedDates[index].size),
        observationRate: union.size ? observedDates[index].size / union.size : 0,
      };
    });
    return {
      assets: assets.map(({ revision: _revision, ...item }) => item),
      ...(commonPeriod ? { commonPeriod } : {}),
      commonObservations: common.size,
      unionObservations: union.size,
      dataRevision: await this.repository.dataRevision(),
    };
  }
}

export function cachedCandlesToPrices(candles: CachedMarketCandle[]): Array<{ date: string; close: number }> {
  return candles.map((candle) => ({ date: candle.date, close: candle.close }));
}
