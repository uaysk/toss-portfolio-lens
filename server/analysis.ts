import { kstDateString, type HistoryCurrency, PortfolioHistoryStore } from "./history.js";
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
  currency: HistoryCurrency;
  range: AnalysisRange;
  generatedAt: string;
  fromDate: string;
  toDate: string;
  estimatedOhlc: true;
  ohlcBackfillComplete: boolean;
  candles: ReturnType<PortfolioHistoryStore["getPortfolioAnalysisCandles"]>;
  benchmarks: Array<{
    key: BenchmarkKey;
    name: string;
    proxySymbol?: string;
    points: ReturnType<PortfolioHistoryStore["getBenchmarkPrices"]>;
  }>;
  benchmarkErrors: Array<{ key: BenchmarkKey; message: string }>;
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

export class PortfolioAnalysisService {
  private readonly refreshedAt = new Map<BenchmarkKey, number>();
  private readonly inFlight = new Map<BenchmarkKey, Promise<void>>();

  constructor(
    private readonly toss: TossClient,
    private readonly store: PortfolioHistoryStore,
  ) {}

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
    currency,
    range,
    fromDate,
    toDate,
    benchmarkKeys,
  }: {
    accountId: string;
    currency: HistoryCurrency;
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

    return {
      accountId,
      currency,
      range,
      generatedAt: new Date().toISOString(),
      fromDate,
      toDate,
      estimatedOhlc: true,
      ohlcBackfillComplete: !this.store.hasIncompleteDailyOhlc(),
      candles: this.store.getPortfolioAnalysisCandles(accountId, currency, fromDate, toDate),
      benchmarks: benchmarkKeys.map((key) => {
        const catalog = BENCHMARK_CATALOG[key];
        return {
          key,
          name: catalog.name,
          ...(catalog.proxy ? { proxySymbol: catalog.symbol } : {}),
          points: this.store.getBenchmarkPrices(key, fromDate, toDate),
        };
      }),
      benchmarkErrors,
    };
  }
}

export function analysisToday(now = new Date()): string {
  return kstDateString(now);
}
