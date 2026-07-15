import {
  kstDateString,
  type PortfolioAnalysisCandle,
  type PortfolioHistory,
  PortfolioHistoryStore,
} from "./history.js";
import {
  calculatePortfolioAnalytics,
  type PortfolioDailyReturn,
  type PortfolioAnalyticsMetrics,
  type PortfolioContribution,
} from "./metrics.js";
import type { TossClient } from "./toss.js";

const API_PACING_MS = 230;
const BENCHMARK_REFRESH_MS = 15 * 60 * 1000;

export const BENCHMARK_CATALOG = {
  KOSPI: { name: "KOSPI", source: "indicator", symbol: "KOSPI", proxy: false },
  KOSDAQ: { name: "KOSDAQ", source: "indicator", symbol: "KOSDAQ", proxy: false },
  NASDAQ100: { name: "나스닥 100", source: "stock", symbol: "QQQ", proxy: true },
  SP500: { name: "S&P 500", source: "stock", symbol: "SPY", proxy: true },
} as const;

export type BenchmarkKey = keyof typeof BENCHMARK_CATALOG;
export type AnalysisRange = "30d" | "90d" | "1y" | "all";

export type PortfolioAnalysis = {
  accountId: string;
  currency: "KRW";
  baseCurrency: "KRW";
  includesCurrencies: ["KRW", "USD"];
  range: AnalysisRange;
  generatedAt: string;
  fromDate: string;
  toDate: string;
  estimatedOhlc: true;
  ohlcBackfillComplete: boolean;
  fxBackfillComplete: boolean;
  candles: PortfolioAnalysisCandle[];
  benchmarks: Array<{
    key: BenchmarkKey;
    name: string;
    proxySymbol?: string;
    points: ReturnType<PortfolioHistoryStore["getBenchmarkPrices"]>;
  }>;
  benchmarkErrors: Array<{ key: BenchmarkKey; message: string }>;
  metrics: PortfolioAnalyticsMetrics;
  contributions: PortfolioContribution[];
};

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function addDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

export function analysisStartDate(
  range: AnalysisRange,
  today: string,
  firstTradeDate?: string,
): string {
  if (range === "all") return firstTradeDate || addDays(today, -365);
  const days = range === "30d" ? 30 : range === "90d" ? 90 : 365;
  const from = addDays(today, -(days - 1));
  return firstTradeDate && firstTradeDate > from ? firstTradeDate : from;
}

export function parseBenchmarkKeys(value: unknown): BenchmarkKey[] {
  const input = typeof value === "string" && value.trim()
    ? value.split(",").map((item) => item.trim().toUpperCase())
    : Object.keys(BENCHMARK_CATALOG);
  const unique = Array.from(new Set(input));
  if (!unique.length || unique.some((key) => !(key in BENCHMARK_CATALOG))) {
    throw new Error("지원하는 비교 지수는 KOSPI, KOSDAQ, NASDAQ100, SP500입니다.");
  }
  return unique as BenchmarkKey[];
}

function round(value: number, digits = 6): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function usdRate(date: string, usdValue: number, exchangeRates: ReadonlyMap<string, number>): number {
  if (usdValue <= 0) return 0;
  const rate = exchangeRates.get(date);
  if (!rate || rate <= 0) throw new Error(`${date} USD/KRW 환율이 없습니다.`);
  return rate;
}

export function combinePortfolioHistories(
  krw: PortfolioHistory,
  usd: PortfolioHistory,
  exchangeRates: ReadonlyMap<string, number>,
): PortfolioHistory {
  const series = [...krw.series, ...usd.series];
  const krwPoints = new Map(krw.points.map((point) => [point.date, point]));
  const usdPoints = new Map(usd.points.map((point) => [point.date, point]));
  const dates = Array.from(new Set([...krwPoints.keys(), ...usdPoints.keys()])).sort();
  const weightSums = new Map(series.map((item) => [item.key, 0]));
  const points = dates.map((date) => {
    const krwPoint = krwPoints.get(date);
    const usdPoint = usdPoints.get(date);
    const rate = usdRate(date, usdPoint?.totalValue ?? 0, exchangeRates);
    const totalValue = (krwPoint?.totalValue ?? 0) + (usdPoint?.totalValue ?? 0) * rate;
    const values: Record<string, number> = {};
    for (const item of series) {
      const source = item.currency === "USD" ? usdPoint : krwPoint;
      const nativeAmount = (source?.totalValue ?? 0) * ((source?.values[item.key] ?? 0) / 100);
      const amount = item.currency === "USD" ? nativeAmount * rate : nativeAmount;
      const weight = totalValue > 0 ? (amount / totalValue) * 100 : 0;
      values[item.key] = round(weight);
      weightSums.set(item.key, (weightSums.get(item.key) ?? 0) + weight);
    }
    return {
      date,
      capturedAt: krwPoint?.capturedAt ?? usdPoint?.capturedAt ?? new Date(`${date}T15:00:00+09:00`).toISOString(),
      totalValue: round(totalValue, 4),
      values,
    };
  });
  const pointCount = Math.max(points.length, 1);
  const combinedSeries = series.map((item) => ({
    ...item,
    averageWeight: round((weightSums.get(item.key) ?? 0) / pointCount, 3),
  })).sort((left, right) => right.averageWeight - left.averageWeight || left.name.localeCompare(right.name, "ko"));
  return {
    accountId: krw.accountId,
    currency: "KRW",
    includesCurrencies: ["KRW", "USD"],
    range: krw.range,
    generatedAt: krw.generatedAt,
    firstSnapshotDate: dates[0],
    fromDate: krw.fromDate,
    toDate: krw.toDate,
    series: combinedSeries,
    points,
  };
}

export function combinePortfolioCandles(
  krwCandles: PortfolioAnalysisCandle[],
  usdCandles: PortfolioAnalysisCandle[],
  history: PortfolioHistory,
  krwHistory: PortfolioHistory,
  usdHistory: PortfolioHistory,
  exchangeRates: ReadonlyMap<string, number>,
): PortfolioAnalysisCandle[] {
  const krwByDate = new Map(krwCandles.map((candle) => [candle.date, candle]));
  const usdByDate = new Map(usdCandles.map((candle) => [candle.date, candle]));
  const krwTotals = new Map(krwHistory.points.map((point) => [point.date, point.totalValue]));
  const usdTotals = new Map(usdHistory.points.map((point) => [point.date, point.totalValue]));
  const availableDates = new Set(history.points.map((point) => point.date));
  const dates = Array.from(new Set([...krwByDate.keys(), ...usdByDate.keys()]))
    .filter((date) => availableDates.has(date))
    .sort();
  return dates.map((date) => {
    const krwTotal = krwTotals.get(date) ?? 0;
    const usdTotal = usdTotals.get(date) ?? 0;
    const rate = usdRate(date, usdTotal, exchangeRates);
    const krw = krwByDate.get(date) ?? { date, open: krwTotal, high: krwTotal, low: krwTotal, close: krwTotal };
    const usd = usdByDate.get(date) ?? { date, open: usdTotal, high: usdTotal, low: usdTotal, close: usdTotal };
    const open = krw.open + usd.open * rate;
    const high = krw.high + usd.high * rate;
    const low = krw.low + usd.low * rate;
    const close = krw.close + usd.close * rate;
    return {
      date,
      open: round(open, 4),
      high: round(Math.max(high, open, close), 4),
      low: round(Math.min(low, open, close), 4),
      close: round(close, 4),
    };
  }).filter((candle) => candle.close > 0);
}

export function buildPositionWeightedReturns(
  history: PortfolioHistory,
  store: PortfolioHistoryStore,
  exchangeRates: ReadonlyMap<string, number>,
): PortfolioDailyReturn[] {
  if (history.points.length < 2 || !history.series.length) return [];
  const fromDate = history.points[0].date;
  const toDate = history.points.at(-1)!.date;
  const instrumentKeys = history.series.map((series) => `${series.currency}:${series.symbol}`);
  const dailyPrices = store.getDailyPrices(instrumentKeys, fromDate, toDate);
  const latestPrices = new Map<string, number>();
  let previousPrices = new Map<string, number>();
  const returns: PortfolioDailyReturn[] = [];

  for (let pointIndex = 0; pointIndex < history.points.length; pointIndex += 1) {
    const point = history.points[pointIndex];
    for (const series of history.series) {
      const key = `${series.currency}:${series.symbol}`;
      const exactPrice = dailyPrices.get(key)?.get(point.date);
      if (exactPrice && exactPrice > 0) latestPrices.set(key, exactPrice);
    }
    if (pointIndex > 0) {
      const previousPoint = history.points[pointIndex - 1];
      let weightedReturn = 0;
      let hasMarketMove = false;
      for (const series of history.series) {
        const weight = Math.max(0, previousPoint.values[series.key] ?? 0) / 100;
        if (weight <= 0) continue;
        const key = `${series.currency}:${series.symbol}`;
        const previousPrice = previousPrices.get(key);
        const currentPrice = latestPrices.get(key);
        if (!previousPrice || !currentPrice) continue;
        const previousRate = series.currency === "USD" ? exchangeRates.get(previousPoint.date) ?? 0 : 1;
        const currentRate = series.currency === "USD" ? exchangeRates.get(point.date) ?? previousRate : 1;
        if (previousRate <= 0 || currentRate <= 0) continue;
        const assetReturn = ((currentPrice * currentRate) / (previousPrice * previousRate)) - 1;
        weightedReturn += weight * assetReturn;
        if (dailyPrices.get(key)?.has(point.date) || currentRate !== previousRate) hasMarketMove = true;
      }
      if (hasMarketMove && Number.isFinite(weightedReturn) && weightedReturn > -1) {
        returns.push({ date: point.date, value: weightedReturn });
      }
    }
    previousPrices = new Map(latestPrices);
  }
  return returns;
}

export class PortfolioAnalysisService {
  private readonly refreshedAt = new Map<BenchmarkKey, number>();
  private readonly inFlight = new Map<BenchmarkKey, Promise<void>>();
  private readonly fxInFlight = new Map<string, Promise<void>>();

  constructor(
    private readonly toss: TossClient,
    private readonly store: PortfolioHistoryStore,
  ) {}

  private async refreshExchangeRate(date: string): Promise<void> {
    const existing = this.fxInFlight.get(date);
    if (existing) return existing;
    const task = this.toss.getUsdKrwExchangeRate(date)
      .then((result) => this.store.upsertExchangeRate(result.date, result.rate, result.timestamp))
      .finally(() => this.fxInFlight.delete(date));
    this.fxInFlight.set(date, task);
    return task;
  }

  private async ensureExchangeRates(accountId: string, fromDate: string, toDate: string): Promise<Map<string, number>> {
    const requiredDates = this.store.getRequiredExchangeRateDates(accountId, fromDate, toDate);
    const cached = this.store.getExchangeRates(fromDate, toDate);
    const missing = requiredDates.filter((date) => !cached.has(date));
    const workerCount = Math.min(2, missing.length);
    let cursor = 0;
    await Promise.all(Array.from({ length: workerCount }, async () => {
      while (cursor < missing.length) {
        const date = missing[cursor];
        cursor += 1;
        await this.refreshExchangeRate(date);
        if (cursor < missing.length) await sleep(API_PACING_MS);
      }
    }));
    return this.store.getExchangeRates(fromDate, toDate);
  }

  async getCombinedHistory({
    accountId,
    range,
    fromDate,
    toDate,
  }: {
    accountId: string;
    range: "7d" | "30d" | "90d" | "all";
    fromDate?: string;
    toDate?: string;
  }): Promise<PortfolioHistory> {
    const now = new Date();
    const dateRange = fromDate && toDate ? { from: fromDate, to: toDate } : undefined;
    const krw = this.store.getHistory(accountId, "KRW", range, now, dateRange);
    const usd = this.store.getHistory(accountId, "USD", range, now, dateRange);
    const effectiveFrom = fromDate ?? krw.points[0]?.date ?? usd.points[0]?.date ?? analysisToday(now);
    const effectiveTo = toDate ?? krw.points.at(-1)?.date ?? usd.points.at(-1)?.date ?? analysisToday(now);
    const exchangeRates = await this.ensureExchangeRates(accountId, effectiveFrom, effectiveTo);
    return combinePortfolioHistories(krw, usd, exchangeRates);
  }

  private async refreshBenchmark(key: BenchmarkKey, fromDate: string): Promise<void> {
    const recentRefresh = this.refreshedAt.get(key) ?? 0;
    const bounds = this.store.getBenchmarkPriceBounds(key);
    if (
      bounds.earliest
      && bounds.earliest <= fromDate
      && bounds.latest
      && Date.now() - recentRefresh < BENCHMARK_REFRESH_MS
    ) return;

    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const task = (async () => {
      const catalog = BENCHMARK_CATALOG[key];
      const needsOlderHistory = !bounds.earliest || bounds.earliest > fromDate;
      const seenBefore = new Set<string>();
      let before: string | undefined;

      for (let pageIndex = 0; pageIndex < 20; pageIndex += 1) {
        if (pageIndex > 0) await sleep(API_PACING_MS);
        const page = catalog.source === "indicator"
          ? await this.toss.getMarketIndicatorDailyCandles(catalog.symbol as "KOSPI" | "KOSDAQ", before)
          : await this.toss.getDailyCandles(catalog.symbol, before, true);
        this.store.upsertBenchmarkPrices(key, page.candles);
        const dates = page.candles.map((candle) => candle.date).sort();
        const oldestDate = dates[0];
        const overlapsCache = Boolean(
          bounds.latest && page.candles.some((candle) => candle.date <= bounds.latest!),
        );
        if (
          !page.nextBefore
          || !page.candles.length
          || (oldestDate && oldestDate <= fromDate)
          || (!needsOlderHistory && overlapsCache)
        ) break;
        if (seenBefore.has(page.nextBefore)) throw new Error(`${catalog.name} 일봉 커서가 반복되었습니다.`);
        seenBefore.add(page.nextBefore);
        before = page.nextBefore;
        if (pageIndex === 19) throw new Error(`${catalog.name} 일봉 조회 범위가 안전 한도를 초과했습니다.`);
      }
      this.refreshedAt.set(key, Date.now());
    })().finally(() => this.inFlight.delete(key));

    this.inFlight.set(key, task);
    return task;
  }

  async getAnalysis({
    accountId,
    range,
    fromDate,
    toDate,
    benchmarkKeys,
  }: {
    accountId: string;
    range: AnalysisRange;
    fromDate: string;
    toDate: string;
    benchmarkKeys: BenchmarkKey[];
  }): Promise<PortfolioAnalysis> {
    const benchmarkErrors: PortfolioAnalysis["benchmarkErrors"] = [];
    for (const key of benchmarkKeys) {
      try {
        await this.refreshBenchmark(key, fromDate);
      } catch (error) {
        benchmarkErrors.push({
          key,
          message: error instanceof Error ? error.message : `${BENCHMARK_CATALOG[key].name} 일봉을 불러오지 못했습니다.`,
        });
      }
    }

    const exchangeRates = await this.ensureExchangeRates(accountId, fromDate, toDate);
    const krwHistory = this.store.getHistory(accountId, "KRW", "all", new Date(), { from: fromDate, to: toDate });
    const usdHistory = this.store.getHistory(accountId, "USD", "all", new Date(), { from: fromDate, to: toDate });
    const history = combinePortfolioHistories(krwHistory, usdHistory, exchangeRates);
    const candles = combinePortfolioCandles(
      this.store.getPortfolioAnalysisCandles(accountId, "KRW", fromDate, toDate),
      this.store.getPortfolioAnalysisCandles(accountId, "USD", fromDate, toDate),
      history,
      krwHistory,
      usdHistory,
      exchangeRates,
    );
    const benchmarkData = benchmarkKeys.map((key) => {
      const catalog = BENCHMARK_CATALOG[key];
      return {
        key,
        name: catalog.name,
        ...(catalog.proxy ? { proxySymbol: catalog.symbol } : {}),
        points: this.store.getBenchmarkPrices(key, fromDate, toDate),
      };
    });
    const analytics = calculatePortfolioAnalytics({
      candles,
      history,
      orders: this.store.getOrders(accountId),
      exchangeRates,
      benchmarks: benchmarkData,
      returnSeries: buildPositionWeightedReturns(history, this.store, exchangeRates),
    });

    return {
      accountId,
      currency: "KRW",
      baseCurrency: "KRW",
      includesCurrencies: ["KRW", "USD"],
      range,
      generatedAt: new Date().toISOString(),
      fromDate,
      toDate,
      estimatedOhlc: true,
      ohlcBackfillComplete: !this.store.hasIncompleteDailyOhlc(),
      fxBackfillComplete: true,
      candles,
      benchmarks: benchmarkData,
      benchmarkErrors,
      ...analytics,
    };
  }
}

export function analysisToday(now = new Date()): string {
  return kstDateString(now);
}
