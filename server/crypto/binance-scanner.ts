import { createHash } from "node:crypto";
import type { ScannerCriterion } from "../scalping/contracts.js";
import { canonicalJson } from "../worker/contracts.js";
import {
  normalizeBinanceUniverse,
  normalizeBookTickers,
  normalizeRestKlines,
  normalizeTicker24h,
  type BinanceBookTicker,
  type BinanceKline,
  type BinanceRestMarketData,
  type BinanceTicker24h,
} from "./binance-market-data.js";
import {
  BINANCE_SCANNER_LIQUIDITY_POOL_SIZE,
  BINANCE_SCANNER_MAX_AGE_MS,
  BINANCE_SCANNER_SPREAD_LIMIT_BPS,
  BinanceScannerSnapshotSchema,
  cryptoFuturesMarket,
  type BinanceInstrumentRules,
  type BinanceScannerCandidate,
  type BinanceScannerSnapshot,
} from "./contracts.js";

type CandidateInputs = {
  rules: BinanceInstrumentRules;
  ticker: BinanceTicker24h;
  book: BinanceBookTicker;
  bars: BinanceKline[];
  spreadBps: number;
  realizedVolatility60m: number;
  atrPercent14: number;
  relativeVolume: number;
  missingFields: string[];
  qualityReasons: string[];
};

function ratioSpreadBps(book: BinanceBookTicker): number {
  const midpoint = (book.askPrice + book.bidPrice) / 2;
  return midpoint > 0 ? ((book.askPrice - book.bidPrice) / midpoint) * 10_000 : Infinity;
}

function realizedVolatility(bars: readonly BinanceKline[]): number {
  const returns: number[] = [];
  const window = bars.slice(-61);
  for (let index = 1; index < window.length; index += 1) {
    const previous = window[index - 1]!.close;
    const current = window[index]!.close;
    if (previous > 0 && current > 0) returns.push(Math.log(current / previous));
  }
  if (returns.length < 2) return 0;
  const mean = returns.reduce((sum, item) => sum + item, 0) / returns.length;
  const variance = returns.reduce((sum, item) => sum + (item - mean) ** 2, 0)
    / (returns.length - 1);
  return Math.sqrt(Math.max(0, variance));
}

function atrPercent(bars: readonly BinanceKline[]): number {
  const window = bars.slice(-15);
  if (window.length < 2) return 0;
  const ranges: number[] = [];
  for (let index = 1; index < window.length; index += 1) {
    const bar = window[index]!;
    const previousClose = window[index - 1]!.close;
    ranges.push(Math.max(
      bar.high - bar.low,
      Math.abs(bar.high - previousClose),
      Math.abs(bar.low - previousClose),
    ));
  }
  const close = window.at(-1)!.close;
  return close > 0
    ? (ranges.reduce((sum, item) => sum + item, 0) / ranges.length) / close
    : 0;
}

function relativeVolume(bars: readonly BinanceKline[]): number {
  const window = bars.slice(-61);
  if (window.length < 2) return 0;
  const latest = window.at(-1)!.volume;
  const baseline = window.slice(0, -1);
  const average = baseline.reduce((sum, item) => sum + item.volume, 0) / baseline.length;
  return average > 0 ? latest / average : 0;
}

function analyzeKlines(
  symbol: string,
  payload: unknown,
  authoritativeNow: number,
): {
  bars: BinanceKline[];
  realizedReady: boolean;
  atrReady: boolean;
  missingFields: string[];
  reasons: string[];
} {
  const normalizedBars = normalizeRestKlines(symbol, payload, authoritativeNow);
  const rawCount = Array.isArray(payload) ? payload.length : 0;
  const reasons: string[] = [];
  const missingFields: string[] = [];
  if (!Array.isArray(payload)) reasons.push("REST kline payload is not an array");
  const malformed = Math.max(0, rawCount - normalizedBars.length);
  if (malformed > 0) reasons.push(`${malformed} malformed REST kline row(s) dropped`);
  const byOpenTime = new Map<number, BinanceKline>();
  let duplicates = 0;
  for (const bar of normalizedBars) {
    if (byOpenTime.has(bar.openTime)) duplicates += 1;
    byOpenTime.set(bar.openTime, bar);
  }
  if (duplicates > 0) reasons.push(`${duplicates} duplicate kline openTime value(s)`);
  const bars = Array.from(byOpenTime.values())
    .filter((bar) => bar.final)
    .sort((left, right) => left.openTime - right.openTime);
  const last = bars.at(-1);
  const stale = !last || authoritativeNow - last.closeTime > 120_000;
  if (stale) reasons.push("latest final kline is stale");
  const continuity = (windowSize: number): boolean => {
    const window = bars.slice(-windowSize);
    if (window.length < windowSize) return false;
    for (let index = 1; index < window.length; index += 1) {
      if (window[index]!.openTime - window[index - 1]!.openTime !== 60_000) {
        return false;
      }
    }
    return true;
  };
  const realizedReady = !stale && duplicates === 0 && malformed === 0 && continuity(61);
  const atrReady = !stale && duplicates === 0 && malformed === 0 && continuity(15);
  if (!realizedReady) {
    missingFields.push("60m_realized_volatility");
    if (bars.length >= 61 && !continuity(61)) {
      reasons.push("60m realized-volatility window has a one-minute gap");
    }
  }
  if (!atrReady) {
    missingFields.push("atr14");
    if (bars.length >= 15 && !continuity(15)) {
      reasons.push("ATR14 window has a one-minute gap");
    }
  }
  return {
    bars,
    realizedReady,
    atrReady,
    missingFields,
    reasons: Array.from(new Set(reasons)),
  };
}

function normalized(values: readonly number[], value: number): number {
  if (!values.length || !Number.isFinite(value)) return 0;
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  if (maximum <= minimum) return maximum > 0 ? 1 : 0;
  return Math.max(0, Math.min(1, (value - minimum) / (maximum - minimum)));
}

async function mapConcurrent<T, U>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<U>,
): Promise<U[]> {
  const output = new Array<U>(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= values.length) return;
      output[index] = await mapper(values[index]!);
    }
  }));
  return output;
}

export type BinanceScannerOptions = {
  rest: BinanceRestMarketData;
  now?: () => number;
  klineConcurrency?: number;
};

export class BinanceUsdmScanner {
  private readonly rest: BinanceRestMarketData;
  private readonly now: () => number;
  private readonly klineConcurrency: number;
  private readonly cache = new Map<ScannerCriterion, BinanceScannerSnapshot>();
  private readonly inflight = new Map<ScannerCriterion, Promise<BinanceScannerSnapshot>>();

  constructor(options: BinanceScannerOptions) {
    this.rest = options.rest;
    this.now = options.now ?? Date.now;
    this.klineConcurrency = Math.max(1, Math.min(10, Math.trunc(options.klineConcurrency ?? 5)));
  }

  async candidates(
    criterion: ScannerCriterion = "volatility",
    force = false,
  ): Promise<BinanceScannerSnapshot> {
    const now = this.now();
    // A caller forcing authoritative refresh has explicitly invalidated the
    // prior evidence. Do not resurrect that snapshot if Binance rejects the
    // refresh (notably HTTP 429); automatic selection must fail closed.
    if (force) this.cache.delete(criterion);
    const cached = this.cache.get(criterion);
    if (!force && cached && Date.parse(cached.expiresAt) > now
      && now - Date.parse(cached.generatedAt) <= BINANCE_SCANNER_MAX_AGE_MS) {
      return cached;
    }
    const active = this.inflight.get(criterion);
    if (active) return active;
    const scan = this.scan(criterion, now).finally(() => {
      this.inflight.delete(criterion);
    });
    this.inflight.set(criterion, scan);
    const snapshot = await scan;
    this.cache.set(criterion, snapshot);
    return snapshot;
  }

  async selectionSnapshot(
    criterion: ScannerCriterion,
  ): Promise<{ snapshot: BinanceScannerSnapshot; selected: BinanceScannerCandidate }> {
    let snapshot = await this.candidates(criterion);
    if (this.now() - Date.parse(snapshot.generatedAt) > BINANCE_SCANNER_MAX_AGE_MS) {
      snapshot = await this.candidates(criterion, true);
    }
    const selected = snapshot.candidates.find(
      (candidate) => candidate.dataQuality.status === "available",
    );
    if (!selected) throw new Error("No Binance USDⓈ-M candidate satisfies liquidity requirements.");
    return { snapshot, selected };
  }

  private async scan(
    criterion: ScannerCriterion,
    requestedAt: number,
  ): Promise<BinanceScannerSnapshot> {
    const [exchangeInformation, tickerPayload, bookPayload] = await Promise.all([
      this.rest.exchangeInformation(),
      this.rest.tickers24h(),
      this.rest.bookTickers(),
    ]);
    const observedAt = this.now();
    const universe = normalizeBinanceUniverse(exchangeInformation, observedAt);
    const eligible = new Set(universe.map((item) => item.symbol));
    const tickers = normalizeTicker24h(tickerPayload)
      .filter((item) => eligible.has(item.symbol))
      .sort((left, right) => right.quoteVolume - left.quoteVolume);
    const liquidityPool = tickers.slice(0, BINANCE_SCANNER_LIQUIDITY_POOL_SIZE);
    const tickerBySymbol = new Map(liquidityPool.map((item) => [item.symbol, item]));
    const bookBySymbol = new Map(
      normalizeBookTickers(bookPayload, observedAt).map((item) => [item.symbol, item]),
    );
    const rulesBySymbol = new Map(universe.map((item) => [item.symbol, item]));
    const qualifiedSymbols = liquidityPool
      .map((item) => item.symbol)
      .filter((symbol) => {
        const book = bookBySymbol.get(symbol);
        return book !== undefined && ratioSpreadBps(book) <= BINANCE_SCANNER_SPREAD_LIMIT_BPS;
      });
    const inputs = await mapConcurrent(
      qualifiedSymbols,
      this.klineConcurrency,
      async (symbol): Promise<CandidateInputs> => {
        const payload = await this.rest.klines({
          symbol,
          limit: 1_024,
        });
        const quality = analyzeKlines(symbol, payload, observedAt);
        const bars = quality.bars;
        const ticker = tickerBySymbol.get(symbol)!;
        const book = bookBySymbol.get(symbol)!;
        return {
          rules: rulesBySymbol.get(symbol)!,
          ticker,
          book,
          bars,
          spreadBps: ratioSpreadBps(book),
          realizedVolatility60m: quality.realizedReady ? realizedVolatility(bars) : 0,
          atrPercent14: quality.atrReady ? atrPercent(bars) : 0,
          relativeVolume: relativeVolume(bars),
          missingFields: quality.missingFields,
          qualityReasons: quality.reasons,
        };
      },
    );
    const quoteVolumes = inputs.map((item) => item.ticker.quoteVolume);
    const volumes = inputs.map((item) => item.ticker.volume);
    const relativeVolumes = inputs.map((item) => item.relativeVolume);
    const realized = inputs.map((item) => item.realizedVolatility60m);
    const changes = inputs.map((item) => Math.abs(item.ticker.priceChangePercent));
    const atrs = inputs.map((item) => item.atrPercent14);
    const candidates = inputs.map((item) => {
      const components = {
        tradingAmount: normalized(quoteVolumes, item.ticker.quoteVolume),
        volume: normalized(volumes, item.ticker.volume),
        relativeVolume: normalized(relativeVolumes, item.relativeVolume),
        realizedVolatility60m: normalized(realized, item.realizedVolatility60m),
        priceChange24h: normalized(changes, Math.abs(item.ticker.priceChangePercent)),
        atrPercent14: normalized(atrs, item.atrPercent14),
      };
      const volatilityScore = (
        components.realizedVolatility60m * 0.5
        + components.priceChange24h * 0.3
        + components.atrPercent14 * 0.2
      );
      const score = criterion === "trading_amount"
        ? components.tradingAmount
        : criterion === "volume"
          // For derivatives, raw base-asset volume is not comparable across
          // contracts. The public "volume" selector therefore ranks the
          // explicitly reported relative-volume signal.
          ? components.relativeVolume
          : volatilityScore;
      const missingFields = item.missingFields;
      return {
        rank: 0,
        symbol: item.rules.symbol,
        price: item.ticker.lastPrice,
        volume: item.ticker.volume,
        quoteVolume: item.ticker.quoteVolume,
        relativeVolume: item.relativeVolume,
        spreadBps: item.spreadBps,
        realizedVolatility60m: item.realizedVolatility60m,
        priceChangePercent24h: item.ticker.priceChangePercent,
        atrPercent14: item.atrPercent14,
        volatilityScore,
        score,
        scoreComponents: components,
        dataQuality: {
          status: missingFields.length ? "partial" as const : "available" as const,
          finalBars: item.bars.length,
          missingFields,
          reasons: item.qualityReasons,
          observedAt: new Date(observedAt).toISOString(),
        },
      };
    }).sort((left, right) => (
      right.score - left.score
      || right.quoteVolume - left.quoteVolume
      || left.symbol.localeCompare(right.symbol)
    )).map((candidate, index) => ({ ...candidate, rank: index + 1 }));
    const generatedAtMs = Math.max(requestedAt, this.now());
    const generatedAt = new Date(generatedAtMs).toISOString();
    const expiresAt = new Date(generatedAtMs + BINANCE_SCANNER_MAX_AGE_MS).toISOString();
    const snapshotPayload = {
      generatedAt,
      criterion,
      universe: universe.map((item) => item.symbol),
      candidates,
    };
    const scannerSnapshotId = createHash("sha256")
      .update(canonicalJson(snapshotPayload))
      .digest("hex");
    return BinanceScannerSnapshotSchema.parse({
      schemaVersion: "binance-usdm-scanner/v1",
      market: cryptoFuturesMarket(),
      scannerSnapshotId,
      snapshotId: scannerSnapshotId,
      generatedAt,
      expiresAt,
      criterion,
      candidates,
      evidence: {
        exchangeInfoObservedAt: new Date(observedAt).toISOString(),
        universeSize: universe.length,
        liquidityPoolSize: liquidityPool.length,
        spreadQualifiedSize: qualifiedSymbols.length,
        requirements: {
          status: "TRADING",
          contractType: "PERPETUAL",
          quoteAsset: "USDT",
          marginAsset: "USDT",
          minimumListingAgeDays: 7,
          liquidityPoolSize: 50,
          maximumSpreadBps: 10,
        },
        volatilityWeights: {
          realized60m: 0.5,
          change24h: 0.3,
          atr14: 0.2,
        },
      },
    });
  }
}
