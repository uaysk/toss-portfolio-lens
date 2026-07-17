import {
  BacktestValidationError,
  simulateBacktest,
  type BacktestAssetDefinition,
  type BacktestPricePoint,
  type BacktestRebalanceFrequency,
  type BacktestCashFlowFrequency,
  type BacktestCashFlowTiming,
} from "./backtest-engine.js";
import { isHistoryDate, kstDateString, type PortfolioHistoryStore } from "./history.js";
import type { InstrumentInfo, TossClient } from "./toss.js";
import { MarketDataService, type CurrencyMode } from "./services/market-data-service.js";

const API_PACING_MS = 230;
const MAX_PRICE_PAGES = 100;

export type BacktestBenchmarkKey = "NONE" | "KOSPI" | "KOSDAQ" | "NASDAQ100" | "SP500" | "CUSTOM";

export type BacktestInstrument = {
  symbol: string;
  name: string;
  market: string;
  currency: "KRW" | "USD";
  listDate: string;
  securityType: string;
  status: string;
};

export type BacktestAssetInput = {
  symbol: string;
  weight: number;
};

export type BacktestRunRequest = {
  assets: BacktestAssetInput[];
  startDate: string;
  endDate: string;
  initialAmount: number;
  monthlyCashFlow: number;
  cashFlowFrequency?: BacktestCashFlowFrequency;
  cashFlowTiming?: BacktestCashFlowTiming;
  rebalanceFrequency: BacktestRebalanceFrequency;
  riskFreeRatePercent?: number;
  transactionCostBps?: number;
  currencyMode?: CurrencyMode;
  baseCurrency?: "KRW";
  rebalanceThresholdPercent?: number;
  benchmark: BacktestBenchmarkKey;
  benchmarkSymbol?: string;
};

const BENCHMARKS: Record<Exclude<BacktestBenchmarkKey, "NONE" | "CUSTOM">, {
  name: string;
  symbol: string;
  source: "indicator" | "stock";
}> = {
  KOSPI: { name: "KOSPI", symbol: "KOSPI", source: "indicator" },
  KOSDAQ: { name: "KOSDAQ", symbol: "KOSDAQ", source: "indicator" },
  NASDAQ100: { name: "나스닥 100", symbol: "QQQ", source: "stock" },
  SP500: { name: "S&P 500", symbol: "SPY", source: "stock" },
};

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

function instrumentKey(instrument: Pick<BacktestInstrument, "currency" | "symbol">): string {
  return `${instrument.currency}:${instrument.symbol}`;
}

function normalizeSymbol(value: string): string {
  const symbol = value.trim().toUpperCase();
  if (!/^[A-Z0-9.-]{1,32}$/.test(symbol)) {
    throw new BacktestValidationError("종목 코드는 영문, 숫자, 마침표와 하이픈만 사용할 수 있습니다.");
  }
  return symbol;
}

function asBacktestInstrument(instrument: InstrumentInfo): BacktestInstrument {
  if ((instrument.currency !== "KRW" && instrument.currency !== "USD") || !instrument.listDate || !isHistoryDate(instrument.listDate)) {
    throw new BacktestValidationError(`${instrument.name || instrument.symbol}의 통화 또는 상장일 정보를 확인할 수 없습니다.`);
  }
  return {
    symbol: instrument.symbol.toUpperCase(),
    name: instrument.name || instrument.symbol,
    market: instrument.market,
    currency: instrument.currency,
    listDate: instrument.listDate,
    securityType: instrument.securityType || "STOCK",
    status: instrument.status || "UNKNOWN",
  };
}

function exactWeights(values: number[]): number[] {
  if (!values.length) return [];
  const total = values.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return values.map(() => 0);
  const weights = values.map((value) => Math.round((value / total) * 10_000) / 100);
  const difference = Math.round((100 - weights.reduce((sum, value) => sum + value, 0)) * 100) / 100;
  let largestIndex = 0;
  for (let index = 1; index < values.length; index += 1) {
    if (values[index] > values[largestIndex]) largestIndex = index;
  }
  weights[largestIndex] = Math.round((weights[largestIndex] + difference) * 100) / 100;
  return weights;
}

export class PortfolioBacktestService {
  private readonly marketData: MarketDataService;

  constructor(
    private readonly toss: TossClient,
    private readonly store: PortfolioHistoryStore,
    marketData?: MarketDataService,
  ) {
    this.marketData = marketData ?? new MarketDataService(toss, store);
  }

  async resolveInstruments(symbols: string[]): Promise<BacktestInstrument[]> {
    const normalized = Array.from(new Set(symbols.map(normalizeSymbol)));
    if (!normalized.length || normalized.length > 20) {
      throw new BacktestValidationError("조회할 종목은 1~20개까지 입력할 수 있습니다.");
    }
    const instruments = (await this.toss.getInstruments(normalized)).map(asBacktestInstrument);
    const bySymbol = new Map(instruments.map((instrument) => [instrument.symbol, instrument]));
    const missing = normalized.filter((symbol) => !bySymbol.has(symbol));
    if (missing.length) throw new BacktestValidationError(`종목 정보를 찾을 수 없습니다: ${missing.join(", ")}`);
    return normalized.map((symbol) => bySymbol.get(symbol)!);
  }

  async currentPortfolio(accountId: string): Promise<{
    accountId: string;
    assets: Array<BacktestInstrument & { weight: number; currentValueKrw: number }>;
    defaultStartDate: string;
    defaultEndDate: string;
    initialAmount: number;
  }> {
    const portfolio = await this.toss.getPortfolio(accountId, false, false);
    const holdings = portfolio.holdings.filter((holding) => (
      holding.evaluationAmount > 0 && (holding.currency === "KRW" || holding.currency === "USD")
    ));
    if (!holdings.length) throw new BacktestValidationError("현재 포트폴리오에 백테스트할 보유 종목이 없습니다.");
    const instruments = await this.resolveInstruments(holdings.map((holding) => holding.symbol));
    const today = kstDateString(new Date());
    const hasUsd = holdings.some((holding) => holding.currency === "USD");
    const usdKrw = hasUsd ? (await this.toss.getUsdKrwExchangeRate(today)).rate : 1;
    const instrumentBySymbol = new Map(instruments.map((instrument) => [instrument.symbol, instrument]));
    const values = holdings.map((holding) => holding.evaluationAmount * (holding.currency === "USD" ? usdKrw : 1));
    const weights = exactWeights(values);
    const assets = holdings.map((holding, index) => {
      const instrument = instrumentBySymbol.get(holding.symbol.toUpperCase());
      if (!instrument) throw new BacktestValidationError(`${holding.name}의 종목 정보를 찾을 수 없습니다.`);
      return { ...instrument, weight: weights[index], currentValueKrw: Math.round(values[index] * 100) / 100 };
    });
    return {
      accountId,
      assets,
      defaultStartDate: assets.map((asset) => asset.listDate).sort().at(-1)!,
      defaultEndDate: today,
      initialAmount: Math.round(values.reduce((sum, value) => sum + value, 0)),
    };
  }

  async getCachedBenchmarkAvailability(
    key: Exclude<BacktestBenchmarkKey, "NONE" | "CUSTOM">,
    startDate: string,
    endDate: string,
  ): Promise<{ key: string; name: string; firstDate?: string; lastDate?: string; observations: number }> {
    const bounds = await this.store.getBenchmarkPriceBounds(key);
    const observations = await this.store.getBenchmarkPrices(key, startDate, endDate);
    return {
      key,
      name: BENCHMARKS[key].name,
      ...(bounds.earliest ? { firstDate: bounds.earliest } : {}),
      ...(bounds.latest ? { lastDate: bounds.latest } : {}),
      observations: observations.length,
    };
  }

  private async ensureAssetPrices(instrument: BacktestInstrument, startDate: string, endDate: string): Promise<void> {
    const key = instrumentKey(instrument);
    const bounds = await this.store.getBacktestPriceBounds(key);
    const recentEnough = Boolean(bounds.latest && bounds.latest >= addDays(endDate, -7));
    if (bounds.earliest && bounds.earliest <= startDate && recentEnough) return;

    const seenBefore = new Set<string>();
    let before: string | undefined;
    for (let pageIndex = 0; pageIndex < MAX_PRICE_PAGES; pageIndex += 1) {
      if (pageIndex > 0) await sleep(API_PACING_MS);
      const page = await this.toss.getDailyCandles(instrument.symbol, before, true);
      await this.store.upsertBacktestPrices(key, page.candles);
      const dates = page.candles.map((candle) => candle.date).sort();
      const oldestDate = dates[0];
      const overlapsCached = Boolean(bounds.latest && page.candles.some((candle) => candle.date <= bounds.latest!));
      if (!page.nextBefore || !page.candles.length || (oldestDate && oldestDate <= startDate)) return;
      if (bounds.earliest && bounds.earliest <= startDate && overlapsCached) return;
      if (seenBefore.has(page.nextBefore)) throw new BacktestValidationError(`${instrument.name} 일봉 커서가 반복되었습니다.`);
      seenBefore.add(page.nextBefore);
      before = page.nextBefore;
    }
    throw new BacktestValidationError(`${instrument.name}의 일봉 조회 범위가 안전 한도를 초과했습니다.`);
  }

  private async ensureBenchmarkPrices(
    key: Exclude<BacktestBenchmarkKey, "NONE" | "CUSTOM">,
    startDate: string,
    endDate: string,
  ): Promise<void> {
    const catalog = BENCHMARKS[key];
    const bounds = await this.store.getBenchmarkPriceBounds(key);
    const recentEnough = Boolean(bounds.latest && bounds.latest >= addDays(endDate, -7));
    if (bounds.earliest && bounds.earliest <= startDate && recentEnough) return;
    const seenBefore = new Set<string>();
    let before: string | undefined;
    for (let pageIndex = 0; pageIndex < MAX_PRICE_PAGES; pageIndex += 1) {
      if (pageIndex > 0) await sleep(API_PACING_MS);
      const page = catalog.source === "indicator"
        ? await this.toss.getMarketIndicatorDailyCandles(catalog.symbol as "KOSPI" | "KOSDAQ", before)
        : await this.toss.getDailyCandles(catalog.symbol, before, true);
      await this.store.upsertBenchmarkPrices(key, page.candles);
      const dates = page.candles.map((candle) => candle.date).sort();
      const oldestDate = dates[0];
      const overlapsCached = Boolean(bounds.latest && page.candles.some((candle) => candle.date <= bounds.latest!));
      if (!page.nextBefore || !page.candles.length || (oldestDate && oldestDate <= startDate)) return;
      if (bounds.earliest && bounds.earliest <= startDate && overlapsCached) return;
      if (seenBefore.has(page.nextBefore)) throw new BacktestValidationError(`${catalog.name} 일봉 커서가 반복되었습니다.`);
      seenBefore.add(page.nextBefore);
      before = page.nextBefore;
    }
    throw new BacktestValidationError(`${catalog.name} 일봉 조회 범위가 안전 한도를 초과했습니다.`);
  }

  async run(request: BacktestRunRequest) {
    const today = kstDateString(new Date());
    const riskFreeRatePercent = request.riskFreeRatePercent ?? 0;
    const transactionCostBps = request.transactionCostBps ?? 0;
    const currencyMode = request.currencyMode ?? "KRW";
    const rebalanceThresholdPercent = request.rebalanceThresholdPercent ?? 5;
    if (!isHistoryDate(request.startDate) || !isHistoryDate(request.endDate) || request.startDate > request.endDate || request.endDate > today) {
      throw new BacktestValidationError("백테스트 시작일과 종료일을 확인해 주세요.");
    }
    if (!Number.isFinite(request.initialAmount) || request.initialAmount < 10_000 || request.initialAmount > 10_000_000_000_000) {
      throw new BacktestValidationError("초기 투자금은 1만원 이상 10조원 이하로 입력해 주세요.");
    }
    if (!Number.isFinite(request.monthlyCashFlow) || Math.abs(request.monthlyCashFlow) > 1_000_000_000_000) {
      throw new BacktestValidationError("월 정기 현금흐름은 절댓값 1조원 이하로 입력해 주세요.");
    }
    if (request.cashFlowFrequency !== undefined && !["monthly", "quarterly", "annually"].includes(request.cashFlowFrequency)) {
      throw new BacktestValidationError("현금흐름 주기는 monthly, quarterly, annually 중 하나여야 합니다.");
    }
    if (request.cashFlowTiming !== undefined && !["period_start", "period_end"].includes(request.cashFlowTiming)) {
      throw new BacktestValidationError("현금흐름 시점은 period_start 또는 period_end여야 합니다.");
    }
    if (!Number.isFinite(riskFreeRatePercent) || riskFreeRatePercent < -10 || riskFreeRatePercent > 50) {
      throw new BacktestValidationError("무위험수익률은 -10% 이상 50% 이하로 입력해 주세요.");
    }
    if (!Number.isFinite(transactionCostBps) || transactionCostBps < 0 || transactionCostBps > 500) {
      throw new BacktestValidationError("거래비용은 0bp 이상 500bp 이하로 입력해 주세요.");
    }
    if (!["none", "monthly", "quarterly", "annually", "threshold"].includes(request.rebalanceFrequency)) {
      throw new BacktestValidationError("리밸런싱 주기를 확인해 주세요.");
    }
    if (currencyMode !== "local" && currencyMode !== "KRW") {
      throw new BacktestValidationError("통화 기준은 local 또는 KRW여야 합니다.");
    }
    if (request.baseCurrency !== undefined && request.baseCurrency !== "KRW") {
      throw new BacktestValidationError("기준통화는 KRW만 지원합니다.");
    }
    if (request.rebalanceFrequency === "threshold"
      && (!Number.isFinite(rebalanceThresholdPercent) || rebalanceThresholdPercent < 0.1 || rebalanceThresholdPercent > 50)) {
      throw new BacktestValidationError("threshold 리밸런싱 기준은 0.1% 이상 50% 이하로 입력해 주세요.");
    }
    if (!["NONE", "KOSPI", "KOSDAQ", "NASDAQ100", "SP500", "CUSTOM"].includes(request.benchmark)) {
      throw new BacktestValidationError("벤치마크를 확인해 주세요.");
    }
    const instruments = await this.resolveInstruments(request.assets.map((asset) => asset.symbol));
    const weightBySymbol = new Map(request.assets.map((asset) => [normalizeSymbol(asset.symbol), Number(asset.weight)]));
    const latestListDate = instruments.map((instrument) => instrument.listDate).sort().at(-1)!;
    const effectiveRequestedStart = request.startDate < latestListDate ? latestListDate : request.startDate;
    const definitions: BacktestAssetDefinition[] = instruments.map((instrument) => ({
      symbol: instrument.symbol,
      name: instrument.name,
      market: instrument.market,
      currency: instrument.currency,
      listDate: instrument.listDate,
      weight: weightBySymbol.get(instrument.symbol) ?? 0,
    }));
    const customBenchmark = request.benchmark === "CUSTOM"
      ? (await this.resolveInstruments([request.benchmarkSymbol || ""]))[0]
      : undefined;
    const builtInBenchmark = request.benchmark !== "NONE" && request.benchmark !== "CUSTOM"
      ? request.benchmark
      : undefined;

    for (const instrument of instruments) {
      await this.ensureAssetPrices(instrument, effectiveRequestedStart, request.endDate);
    }
    if (customBenchmark) {
      await this.ensureAssetPrices(customBenchmark, effectiveRequestedStart, request.endDate);
    } else if (builtInBenchmark) {
      await this.ensureBenchmarkPrices(builtInBenchmark, effectiveRequestedStart, request.endDate);
    }
    const keys = Array.from(new Set([
      ...instruments.map(instrumentKey),
      ...(customBenchmark ? [instrumentKey(customBenchmark)] : []),
    ]));
    const localPrices = await this.store.getBacktestPrices(keys, effectiveRequestedStart, request.endDate);
    let benchmark: { key: string; name: string; prices: BacktestPricePoint[] } | undefined;
    if (customBenchmark) {
      benchmark = {
        key: `CUSTOM:${instrumentKey(customBenchmark)}`,
        name: customBenchmark.name,
        prices: localPrices.get(instrumentKey(customBenchmark)) ?? [],
      };
    } else if (builtInBenchmark) {
      const catalog = BENCHMARKS[builtInBenchmark];
      benchmark = {
        key: builtInBenchmark,
        name: catalog.name,
        prices: await this.store.getBenchmarkPrices(builtInBenchmark, effectiveRequestedStart, request.endDate),
      };
    }

    const usdSeries = [
      ...instruments.filter((instrument) => instrument.currency === "USD")
        .map((instrument) => localPrices.get(instrumentKey(instrument)) ?? []),
      ...(customBenchmark?.currency === "USD" ? [benchmark?.prices ?? []] : []),
      ...(builtInBenchmark && BENCHMARKS[builtInBenchmark].source === "stock" ? [benchmark?.prices ?? []] : []),
    ];
    const exchangeRates = currencyMode === "KRW" && usdSeries.length
      ? await this.marketData.ensureExchangeRates(usdSeries.flatMap((series) => series.map((point) => point.date)))
      : new Map<string, number>();
    const rateEntries = Array.from(exchangeRates.entries())
      .filter((entry) => Number.isFinite(entry[1]) && entry[1] > 0)
      .sort((left, right) => left[0].localeCompare(right[0]));
    let carriedFxObservations = 0;
    let missingFxObservations = 0;
    const convertSeries = (series: BacktestPricePoint[], currency: "KRW" | "USD"): BacktestPricePoint[] => {
      if (currencyMode !== "KRW" || currency === "KRW") {
        return series.map((point) => ({ ...point, localClose: point.close, fxRate: 1 }));
      }
      let rateIndex = 0;
      let lastRate = 0;
      let lastRateDate = "";
      return series.flatMap((point): BacktestPricePoint[] => {
        while (rateIndex < rateEntries.length && rateEntries[rateIndex][0] <= point.date) {
          lastRateDate = rateEntries[rateIndex][0];
          lastRate = rateEntries[rateIndex][1];
          rateIndex += 1;
        }
        if (!(lastRate > 0)) {
          missingFxObservations += 1;
          return [];
        }
        if (lastRateDate !== point.date) carriedFxObservations += 1;
        return [{
          date: point.date,
          close: point.close * lastRate,
          localClose: point.close,
          fxRate: lastRate,
        }];
      });
    };
    const prices = new Map<string, BacktestPricePoint[]>();
    for (const instrument of instruments) {
      const key = instrumentKey(instrument);
      prices.set(key, convertSeries(localPrices.get(key) ?? [], instrument.currency));
    }
    if (benchmark) {
      const benchmarkCurrency: "KRW" | "USD" = customBenchmark?.currency
        ?? (builtInBenchmark && BENCHMARKS[builtInBenchmark].source === "stock" ? "USD" : "KRW");
      benchmark = { ...benchmark, prices: convertSeries(benchmark.prices, benchmarkCurrency) };
    }

    const result = simulateBacktest({
      assets: definitions,
      prices,
      requestedStartDate: effectiveRequestedStart,
      endDate: request.endDate,
      initialAmount: request.initialAmount,
      monthlyCashFlow: request.monthlyCashFlow,
      cashFlowFrequency: request.cashFlowFrequency,
      cashFlowTiming: request.cashFlowTiming,
      rebalanceFrequency: request.rebalanceFrequency,
      riskFreeRatePercent,
      transactionCostBps,
      rebalanceThresholdPercent,
      benchmark,
    });
    const warnings = [
      currencyMode === "KRW"
        ? "국내·해외 종목의 수정주가를 전체 기간 USD/KRW 환율로 원화 환산해 동일 기준통화로 계산했습니다."
        : "local 모드는 각 종목의 현지통화 수익률을 합성하므로 국내·해외 혼합 결과는 단일 통화 성과로 해석할 수 없습니다.",
      transactionCostBps > 0
        ? `거래비용은 체결금액의 ${transactionCostBps}bp로 추정하며 성과 경로에는 차감하지 않고 비용 차감 후 추정 수익률로 별도 표시합니다.`
        : "거래비용 가정이 0bp이므로 비용 차감 전 성과와 비용 차감 후 추정 성과가 같습니다.",
      "수정주가에 반영되지 않은 현금배당·세금·실제 체결 슬리피지는 별도로 반영하지 않습니다.",
      ...(carriedFxObservations ? [`환율 ${carriedFxObservations}개 관측은 직전 이용 가능 값을 사용했습니다.`] : []),
      ...(missingFxObservations ? [`환율 ${missingFxObservations}개 관측이 없어 계산에서 제외했습니다.`] : []),
    ];
    if (request.startDate < latestListDate) warnings.unshift(`가장 늦게 상장된 종목의 상장일 ${latestListDate}부터 계산했습니다.`);
    if (result.effectiveStartDate > effectiveRequestedStart) {
      warnings.unshift(`모든 종목과 비교 지수의 공통 일봉이 시작되는 ${result.effectiveStartDate}부터 계산했습니다.`);
    }
    return {
      generatedAt: new Date().toISOString(),
      baseCurrency: "KRW" as const,
      currencyMethod: currencyMode === "KRW" ? "KRW_FX_CONVERTED" as const : "LOCAL_RETURN" as const,
      config: {
        ...request,
        riskFreeRatePercent,
        transactionCostBps,
        currencyMode,
        baseCurrency: "KRW" as const,
        ...(request.rebalanceFrequency === "threshold" ? { rebalanceThresholdPercent } : {}),
        ...(customBenchmark ? { benchmarkSymbol: customBenchmark.symbol } : {}),
        requestedStartDate: request.startDate,
        latestListDate,
        effectiveStartDate: result.effectiveStartDate,
        effectiveEndDate: result.endDate,
      },
      assets: definitions,
      benchmark: request.benchmark === "NONE" ? undefined : {
        key: request.benchmark,
        name: customBenchmark?.name ?? BENCHMARKS[builtInBenchmark!].name,
        symbol: customBenchmark?.symbol ?? BENCHMARKS[builtInBenchmark!].symbol,
      },
      warnings,
      ...result,
    };
  }
}
