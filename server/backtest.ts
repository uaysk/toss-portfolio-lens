import {
  BacktestValidationError,
  simulateBacktest,
  type BacktestAssetDefinition,
  type BacktestPricePoint,
  type BacktestRebalanceFrequency,
} from "./backtest-engine.js";
import { isHistoryDate, kstDateString, type PortfolioHistoryStore } from "./history.js";
import type { InstrumentInfo, TossClient } from "./toss.js";

const API_PACING_MS = 230;
const MAX_PRICE_PAGES = 100;

export type BacktestBenchmarkKey = "NONE" | "KOSPI" | "KOSDAQ" | "NASDAQ100" | "SP500";

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
  rebalanceFrequency: BacktestRebalanceFrequency;
  benchmark: BacktestBenchmarkKey;
};

const BENCHMARKS: Record<Exclude<BacktestBenchmarkKey, "NONE">, {
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
  constructor(
    private readonly toss: TossClient,
    private readonly store: PortfolioHistoryStore,
  ) {}

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
    key: Exclude<BacktestBenchmarkKey, "NONE">,
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
    if (!isHistoryDate(request.startDate) || !isHistoryDate(request.endDate) || request.startDate > request.endDate || request.endDate > today) {
      throw new BacktestValidationError("백테스트 시작일과 종료일을 확인해 주세요.");
    }
    if (!Number.isFinite(request.initialAmount) || request.initialAmount < 10_000 || request.initialAmount > 10_000_000_000_000) {
      throw new BacktestValidationError("초기 투자금은 1만원 이상 10조원 이하로 입력해 주세요.");
    }
    if (!Number.isFinite(request.monthlyCashFlow) || Math.abs(request.monthlyCashFlow) > 1_000_000_000_000) {
      throw new BacktestValidationError("월 정기 현금흐름은 절댓값 1조원 이하로 입력해 주세요.");
    }
    if (!["none", "monthly", "quarterly", "annually"].includes(request.rebalanceFrequency)) {
      throw new BacktestValidationError("리밸런싱 주기를 확인해 주세요.");
    }
    if (!["NONE", "KOSPI", "KOSDAQ", "NASDAQ100", "SP500"].includes(request.benchmark)) {
      throw new BacktestValidationError("비교 지수를 확인해 주세요.");
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

    for (const instrument of instruments) {
      await this.ensureAssetPrices(instrument, effectiveRequestedStart, request.endDate);
    }
    if (request.benchmark !== "NONE") {
      await this.ensureBenchmarkPrices(request.benchmark, effectiveRequestedStart, request.endDate);
    }
    const keys = instruments.map(instrumentKey);
    const prices = await this.store.getBacktestPrices(keys, effectiveRequestedStart, request.endDate);
    let benchmark: { key: string; name: string; prices: BacktestPricePoint[] } | undefined;
    if (request.benchmark !== "NONE") {
      const catalog = BENCHMARKS[request.benchmark];
      benchmark = {
        key: request.benchmark,
        name: catalog.name,
        prices: await this.store.getBenchmarkPrices(request.benchmark, effectiveRequestedStart, request.endDate),
      };
    }

    const result = simulateBacktest({
      assets: definitions,
      prices,
      requestedStartDate: effectiveRequestedStart,
      endDate: request.endDate,
      initialAmount: request.initialAmount,
      monthlyCashFlow: request.monthlyCashFlow,
      rebalanceFrequency: request.rebalanceFrequency,
      benchmark,
    });
    const warnings = [
      "국내·해외 종목을 함께 비교할 때 각 종목의 현지 통화 수정주가 수익률을 사용하며 과거 환율 변동은 반영하지 않습니다.",
      "배당금·세금·거래비용과 실제 체결 슬리피지는 백테스트에 포함되지 않습니다.",
    ];
    if (request.startDate < latestListDate) warnings.unshift(`가장 늦게 상장된 종목의 상장일 ${latestListDate}부터 계산했습니다.`);
    if (result.effectiveStartDate > effectiveRequestedStart) {
      warnings.unshift(`모든 종목과 비교 지수의 공통 일봉이 시작되는 ${result.effectiveStartDate}부터 계산했습니다.`);
    }
    return {
      generatedAt: new Date().toISOString(),
      baseCurrency: "KRW" as const,
      currencyMethod: "LOCAL_RETURN" as const,
      config: {
        ...request,
        requestedStartDate: request.startDate,
        latestListDate,
        effectiveStartDate: result.effectiveStartDate,
        effectiveEndDate: result.endDate,
      },
      assets: definitions,
      benchmark: request.benchmark === "NONE" ? undefined : {
        key: request.benchmark,
        name: BENCHMARKS[request.benchmark].name,
      },
      warnings,
      ...result,
    };
  }
}
