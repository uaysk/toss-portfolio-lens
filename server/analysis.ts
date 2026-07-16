import {
  kstDateString,
  type PortfolioAnalysisCandle,
  type PortfolioHistory,
  PortfolioHistoryStore,
} from "./history.js";
import {
  calculatePortfolioAnalytics,
  type AdvancedAnalytics,
  type PortfolioDailyReturn,
  type PortfolioAnalyticsMetrics,
  type PortfolioContribution,
  type PortfolioReturnDetail,
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
    baseCurrency: "KRW";
    currencyAdjusted: boolean;
    points: Awaited<ReturnType<PortfolioHistoryStore["getBenchmarkPrices"]>>;
  }>;
  benchmarkErrors: Array<{ key: BenchmarkKey; message: string }>;
  metrics: PortfolioAnalyticsMetrics;
  contributions: PortfolioContribution[];
  dataQuality: {
    confidence: "high" | "medium" | "limited";
    historyDays: number;
    returnObservationDays: number;
    expectedReturnObservationDays: number;
    returnCoveragePercent: number;
    requiredPriceObservations: number;
    missingPriceObservations: number;
    priceCoveragePercent: number;
    requiredFxObservations: number;
    missingFxObservations: number;
    fxCoveragePercent: number;
    liveSnapshotDays: number;
    reconstructedSnapshotDays: number;
    backfillStatus: "idle" | "running" | "complete" | "partial" | "error";
    failedSymbols: number;
    notes: string[];
  };
} & AdvancedAnalytics;

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
      origin: krwPoint?.origin === "LIVE" || usdPoint?.origin === "LIVE" ? "LIVE" as const : "HISTORICAL" as const,
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

export function convertUsdBenchmarkToKrw(
  rawPoints: Array<{ date: string; close: number }>,
  comparisonDates: string[],
  exchangeRates: ReadonlyMap<string, number>,
): Array<{ date: string; close: number }> {
  let cursor = 0;
  let latestPrice = 0;
  const sortedPrices = [...rawPoints].filter((point) => point.close > 0).sort((left, right) => left.date.localeCompare(right.date));
  return [...comparisonDates].sort().flatMap((date) => {
    while (cursor < sortedPrices.length && sortedPrices[cursor].date <= date) {
      latestPrice = sortedPrices[cursor].close;
      cursor += 1;
    }
    const rate = exchangeRates.get(date) ?? 0;
    return latestPrice > 0 && rate > 0 ? [{ date, close: round(latestPrice * rate, 4) }] : [];
  });
}

export async function buildPositionReturnDetail(
  history: PortfolioHistory,
  store: PortfolioHistoryStore,
  exchangeRates: ReadonlyMap<string, number>,
): Promise<PortfolioReturnDetail> {
  const empty: PortfolioReturnDetail = {
    returns: [],
    daily: [],
    expectedReturnObservations: 0,
    requiredPriceObservations: 0,
    missingPriceObservations: 0,
    requiredFxObservations: 0,
    missingFxObservations: 0,
  };
  if (history.points.length < 2 || !history.series.length) return empty;
  const fromDate = history.points[0].date;
  const toDate = history.points.at(-1)!.date;
  const instrumentKeys = history.series.map((series) => `${series.currency}:${series.symbol}`);
  const dailyPrices = await store.getDailyPrices(instrumentKeys, fromDate, toDate);
  const latestPrices = new Map<string, number>();
  let previousPrices = new Map<string, number>();
  const detail: PortfolioReturnDetail = { ...empty, returns: [], daily: [] };

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
      const assets: PortfolioReturnDetail["daily"][number]["assets"] = [];
      for (const series of history.series) {
        const weight = Math.max(0, previousPoint.values[series.key] ?? 0) / 100;
        if (weight <= 0) continue;
        detail.requiredPriceObservations += 1;
        const key = `${series.currency}:${series.symbol}`;
        if (dailyPrices.get(key)?.has(point.date)) hasMarketMove = true;
        const previousPrice = previousPrices.get(key);
        const currentPrice = latestPrices.get(key);
        if (!previousPrice || !currentPrice) {
          detail.missingPriceObservations += 1;
          continue;
        }
        const previousRate = series.currency === "USD" ? exchangeRates.get(previousPoint.date) ?? 0 : 1;
        const currentRate = series.currency === "USD" ? exchangeRates.get(point.date) ?? previousRate : 1;
        if (series.currency === "USD" && currentRate > 0 && previousRate > 0 && currentRate !== previousRate) hasMarketMove = true;
        if (series.currency === "USD") detail.requiredFxObservations += 1;
        if (previousRate <= 0 || currentRate <= 0) {
          if (series.currency === "USD") detail.missingFxObservations += 1;
          continue;
        }
        const localReturn = currentPrice / previousPrice - 1;
        const fxReturn = currentRate / previousRate - 1;
        const assetReturn = (1 + localReturn) * (1 + fxReturn) - 1;
        const localContribution = weight * localReturn;
        const fxContribution = weight * (1 + localReturn) * fxReturn;
        weightedReturn += weight * assetReturn;
        assets.push({
          key: series.key,
          totalReturn: assetReturn,
          localReturn,
          fxReturn,
          contribution: weight * assetReturn,
          localContribution,
          fxContribution,
        });
      }
      if (hasMarketMove) detail.expectedReturnObservations += 1;
      if (hasMarketMove && Number.isFinite(weightedReturn) && weightedReturn > -1) {
        const returnPoint = { date: point.date, value: weightedReturn };
        detail.returns.push(returnPoint);
        detail.daily.push({ ...returnPoint, assets });
      }
    }
    previousPrices = new Map(latestPrices);
  }
  return detail;
}

export async function buildPositionWeightedReturns(
  history: PortfolioHistory,
  store: PortfolioHistoryStore,
  exchangeRates: ReadonlyMap<string, number>,
): Promise<PortfolioDailyReturn[]> {
  return (await buildPositionReturnDetail(history, store, exchangeRates)).returns;
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

  private async ensureExchangeRates(
    accountId: string,
    fromDate: string,
    toDate: string,
    additionalDates: string[] = [],
  ): Promise<Map<string, number>> {
    const requiredDates = Array.from(new Set([
      ...await this.store.getRequiredExchangeRateDates(accountId, fromDate, toDate),
      ...additionalDates.filter((date) => date >= fromDate && date <= toDate),
    ])).sort();
    const cached = await this.store.getExchangeRates(fromDate, toDate);
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
    const [krw, usd] = await Promise.all([
      this.store.getHistory(accountId, "KRW", range, now, dateRange),
      this.store.getHistory(accountId, "USD", range, now, dateRange),
    ]);
    const effectiveFrom = fromDate ?? krw.points[0]?.date ?? usd.points[0]?.date ?? analysisToday(now);
    const effectiveTo = toDate ?? krw.points.at(-1)?.date ?? usd.points.at(-1)?.date ?? analysisToday(now);
    const exchangeRates = await this.ensureExchangeRates(accountId, effectiveFrom, effectiveTo);
    return combinePortfolioHistories(krw, usd, exchangeRates);
  }

  private async refreshBenchmark(key: BenchmarkKey, fromDate: string): Promise<void> {
    const recentRefresh = this.refreshedAt.get(key) ?? 0;
    const bounds = await this.store.getBenchmarkPriceBounds(key);
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
        await this.store.upsertBenchmarkPrices(key, page.candles);
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
    riskFreeRatePercent = 0,
  }: {
    accountId: string;
    range: AnalysisRange;
    fromDate: string;
    toDate: string;
    benchmarkKeys: BenchmarkKey[];
    riskFreeRatePercent?: number;
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

    const [krwHistory, usdHistory] = await Promise.all([
      this.store.getHistory(accountId, "KRW", "all", new Date(), { from: fromDate, to: toDate }),
      this.store.getHistory(accountId, "USD", "all", new Date(), { from: fromDate, to: toDate }),
    ]);
    const historyDates = Array.from(new Set([...krwHistory.points, ...usdHistory.points].map((point) => point.date))).sort();
    const needsKrwBenchmarks = benchmarkKeys.some((key) => key === "NASDAQ100" || key === "SP500");
    const exchangeRates = await this.ensureExchangeRates(
      accountId,
      fromDate,
      toDate,
      needsKrwBenchmarks ? historyDates : [],
    );
    const history = combinePortfolioHistories(krwHistory, usdHistory, exchangeRates);
    const [krwCandles, usdCandles] = await Promise.all([
      this.store.getPortfolioAnalysisCandles(accountId, "KRW", fromDate, toDate),
      this.store.getPortfolioAnalysisCandles(accountId, "USD", fromDate, toDate),
    ]);
    const candles = combinePortfolioCandles(
      krwCandles,
      usdCandles,
      history,
      krwHistory,
      usdHistory,
      exchangeRates,
    );
    const benchmarkData = await Promise.all(benchmarkKeys.map(async (key) => {
      const catalog = BENCHMARK_CATALOG[key];
      const rawPoints = await this.store.getBenchmarkPrices(key, fromDate, toDate);
      let points = rawPoints;
      if (catalog.proxy) {
        points = convertUsdBenchmarkToKrw(rawPoints, history.points.map((point) => point.date), exchangeRates);
      }
      return {
        key,
        name: catalog.name,
        ...(catalog.proxy ? { proxySymbol: catalog.symbol } : {}),
        baseCurrency: "KRW" as const,
        currencyAdjusted: catalog.proxy,
        points,
      };
    }));
    const [orders, returnDetail, ohlcIncomplete, backfillStatus] = await Promise.all([
      this.store.getOrders(accountId),
      buildPositionReturnDetail(history, this.store, exchangeRates),
      this.store.hasIncompleteDailyOhlc(),
      this.store.getBackfillStatus(accountId),
    ]);
    const analytics = calculatePortfolioAnalytics({
      candles,
      history,
      orders,
      exchangeRates,
      benchmarks: benchmarkData,
      returnDetail,
      riskFreeRatePercent,
    });
    const returnCoveragePercent = returnDetail.expectedReturnObservations > 0
      ? round((returnDetail.returns.length / returnDetail.expectedReturnObservations) * 100, 2)
      : 0;
    const priceCoveragePercent = returnDetail.requiredPriceObservations > 0
      ? round(((returnDetail.requiredPriceObservations - returnDetail.missingPriceObservations) / returnDetail.requiredPriceObservations) * 100, 2)
      : 100;
    const fxCoveragePercent = returnDetail.requiredFxObservations > 0
      ? round(((returnDetail.requiredFxObservations - returnDetail.missingFxObservations) / returnDetail.requiredFxObservations) * 100, 2)
      : 100;
    const liveSnapshotDays = history.points.filter((point) => point.origin === "LIVE").length;
    const reconstructedSnapshotDays = history.points.filter((point) => point.origin === "HISTORICAL").length;
    const confidence = returnCoveragePercent >= 95 && priceCoveragePercent >= 98 && fxCoveragePercent >= 98
      && backfillStatus.failedSymbols === 0 && backfillStatus.status === "complete"
      ? "high"
      : returnCoveragePercent >= 75 && priceCoveragePercent >= 85 && fxCoveragePercent >= 85
        ? "medium"
        : "limited";
    const notes = [
      ...(returnDetail.missingPriceObservations ? [`가격 누락 ${returnDetail.missingPriceObservations}건`] : []),
      ...(returnDetail.missingFxObservations ? [`환율 누락 ${returnDetail.missingFxObservations}건`] : []),
      ...(backfillStatus.failedSymbols ? [`과거 일봉 수집 실패 종목 ${backfillStatus.failedSymbols}개`] : []),
      ...(returnDetail.returns.length < 60 ? ["60거래일 미만이라 일부 롤링·분포 지표가 제한됩니다."] : []),
    ];

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
      ohlcBackfillComplete: !ohlcIncomplete,
      fxBackfillComplete: returnDetail.missingFxObservations === 0,
      candles,
      benchmarks: benchmarkData,
      benchmarkErrors,
      dataQuality: {
        confidence,
        historyDays: history.points.length,
        returnObservationDays: returnDetail.returns.length,
        expectedReturnObservationDays: returnDetail.expectedReturnObservations,
        returnCoveragePercent,
        requiredPriceObservations: returnDetail.requiredPriceObservations,
        missingPriceObservations: returnDetail.missingPriceObservations,
        priceCoveragePercent,
        requiredFxObservations: returnDetail.requiredFxObservations,
        missingFxObservations: returnDetail.missingFxObservations,
        fxCoveragePercent,
        liveSnapshotDays,
        reconstructedSnapshotDays,
        backfillStatus: backfillStatus.status,
        failedSymbols: backfillStatus.failedSymbols,
        notes,
      },
      ...analytics,
    };
  }
}

export function analysisToday(now = new Date()): string {
  return kstDateString(now);
}
