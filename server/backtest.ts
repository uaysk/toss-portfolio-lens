import {
  BacktestValidationError,
  simulateBacktest,
  type BacktestAssetDefinition,
  type BacktestPricePoint,
  type BacktestRebalanceFrequency,
  type BacktestCashFlowFrequency,
  type BacktestCashFlowTiming,
  type BacktestSimulationInput,
  type BacktestSimulationResult,
  type BacktestRealismPolicy,
  type BacktestTargetWeightScheduleEntry,
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
  lotSize?: number;
  delistDate?: string;
  universeMemberFrom?: string;
  universeMemberTo?: string;
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
  cashFlows?: Array<{ date: string; amount: number; memo?: string }>;
  targetWeightSchedule?: BacktestTargetWeightScheduleEntry[];
  execution?: {
    cashTargetPercent?: number;
    quantityMode?: "fractional" | "whole";
    cashFlowRebalanceMode?: "target_weights" | "drift_reduction" | "full";
    tradeDatePolicy?: "next_common_observation";
    cashAnnualYieldPercent?: number;
  };
  realism?: BacktestRealismPolicy;
  benchmark: BacktestBenchmarkKey;
  benchmarkSymbol?: string;
};

export type BacktestWorkerResponseContext = {
  effective_requested_start: string;
  currency_method: "KRW_FX_CONVERTED" | "LOCAL_RETURN";
  config: BacktestRunRequest & {
    riskFreeRatePercent: number;
    transactionCostBps: number;
    currencyMode: CurrencyMode;
    baseCurrency: "KRW";
    requestedStartDate: string;
    latestMetadataListDate: string;
  };
  assets: BacktestAssetDefinition[];
  instrument_date_consistency: Array<{
    symbol: string;
    firstObservationDate?: string;
    metadataListDate: string;
    status: "consistent" | "price_precedes_metadata" | "unavailable";
  }>;
  benchmark?: { key: BacktestBenchmarkKey; name: string; symbol: string };
  warnings: string[];
};

export type PreparedBacktestRun = {
  simulation: BacktestSimulationInput;
  responseContext: BacktestWorkerResponseContext;
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
      defaultStartDate: (() => {
        const value = new Date(`${today}T00:00:00Z`);
        value.setUTCFullYear(value.getUTCFullYear() - 5);
        return value.toISOString().slice(0, 10);
      })(),
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

  async prepare(request: BacktestRunRequest): Promise<PreparedBacktestRun> {
    const today = kstDateString(new Date());
    const riskFreeRatePercent = request.riskFreeRatePercent ?? 0;
    const transactionCostBps = request.transactionCostBps ?? 0;
    const currencyMode = request.currencyMode ?? "KRW";
    const rebalanceThresholdPercent = request.rebalanceThresholdPercent ?? 5;
    const execution = {
      cashTargetPercent: request.execution?.cashTargetPercent ?? 0,
      quantityMode: request.execution?.quantityMode ?? "fractional" as const,
      cashFlowRebalanceMode: request.execution?.cashFlowRebalanceMode ?? "target_weights" as const,
      tradeDatePolicy: request.execution?.tradeDatePolicy ?? "next_common_observation" as const,
      cashAnnualYieldPercent: request.execution?.cashAnnualYieldPercent ?? 0,
    };
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
    const realismCosts = request.realism?.costs;
    const boundedRealismValues: Array<[number | undefined, number, number]> = [
      [realismCosts?.commissionBps, 0, 5_000],
      [realismCosts?.sellTaxBps, 0, 5_000],
      [realismCosts?.fixedSlippageBps, 0, 5_000],
      [realismCosts?.marketImpactCoefficient, 0, 1],
      [realismCosts?.marketImpactExponent, 0.1, 2],
      [realismCosts?.maxParticipationRatePercent, 0, 100],
      [realismCosts?.minimumFee, 0, 1_000_000_000],
      [realismCosts?.dividendTaxBps, 0, 10_000],
    ];
    if (boundedRealismValues.some(([value, minimum, maximum]) => (
      value !== undefined && (!Number.isFinite(value) || value < minimum || value > maximum)
    ))) {
      throw new BacktestValidationError("수수료·세금·슬리피지·시장충격 비용 모형의 입력 범위를 확인해 주세요.");
    }
    if (!Number.isFinite(execution.cashTargetPercent) || execution.cashTargetPercent < 0 || execution.cashTargetPercent > 100) {
      throw new BacktestValidationError("현금 목표 비중은 0% 이상 100% 이하여야 합니다.");
    }
    if (!Number.isFinite(execution.cashAnnualYieldPercent) || execution.cashAnnualYieldPercent < -100 || execution.cashAnnualYieldPercent > 100) {
      throw new BacktestValidationError("현금 연수익률은 -100% 이상 100% 이하여야 합니다.");
    }
    const weightTotal = request.assets.reduce((sum, asset) => sum + Number(asset.weight), 0);
    if (!request.assets.length || request.assets.length > 20
      || request.assets.some((asset) => !Number.isFinite(asset.weight) || asset.weight <= 0
        || (asset.lotSize !== undefined && (!Number.isFinite(asset.lotSize) || asset.lotSize <= 0))
        || (asset.delistDate !== undefined && !isHistoryDate(asset.delistDate))
        || (asset.universeMemberFrom !== undefined && !isHistoryDate(asset.universeMemberFrom))
        || (asset.universeMemberTo !== undefined && !isHistoryDate(asset.universeMemberTo))
        || (asset.universeMemberFrom !== undefined && asset.universeMemberTo !== undefined
          && asset.universeMemberFrom > asset.universeMemberTo))
      || Math.abs(weightTotal + execution.cashTargetPercent - 100) > 0.01) {
      throw new BacktestValidationError("종목 비중·lot size·PIT 기간과 현금 목표 비중의 합계를 확인해 주세요.");
    }
    if (request.realism?.enforcePointInTimeUniverse && request.assets.some((asset) => (
      !asset.universeMemberFrom || !asset.universeMemberTo
      || asset.universeMemberFrom >= asset.universeMemberTo
      || asset.universeMemberFrom > request.endDate
      || asset.universeMemberTo <= request.startDate
      || (asset.delistDate !== undefined && asset.delistDate <= asset.universeMemberFrom)
    ))) {
      throw new BacktestValidationError("PIT universe를 강제하려면 모든 종목에 분석 기간과 겹치는 [편입일, 제외일) 구간이 필요합니다.");
    }
    if ((request.cashFlows?.length ?? 0) > 1_000 || request.cashFlows?.some((flow) => (
      !isHistoryDate(flow.date) || !Number.isFinite(flow.amount) || Math.abs(flow.amount) > 1_000_000_000_000
    ))) {
      throw new BacktestValidationError("사용자 지정 현금흐름의 날짜·금액·개수를 확인해 주세요.");
    }
    const assetSymbols = new Set(request.assets.map((asset) => normalizeSymbol(asset.symbol)));
    const targetSchedule = request.targetWeightSchedule ?? [];
    if (targetSchedule.length > 10_000) {
      throw new BacktestValidationError("목표비중 정책은 최대 10,000개까지 지정할 수 있습니다.");
    }
    const scheduledDates = new Set<string>();
    for (const entry of targetSchedule) {
      const scheduleSymbols = Object.keys(entry.weights).map(normalizeSymbol);
      const cashTarget = entry.cashTargetPercent ?? 0;
      const total = Object.values(entry.weights).reduce((sum, value) => sum + value, 0) + cashTarget;
      if (!isHistoryDate(entry.date) || entry.date < request.startDate || entry.date > request.endDate
        || scheduledDates.has(entry.date)
        || scheduleSymbols.length !== assetSymbols.size
        || scheduleSymbols.some((symbol) => !assetSymbols.has(symbol))
        || new Set(scheduleSymbols).size !== scheduleSymbols.length
        || Object.values(entry.weights).some((value) => !Number.isFinite(value) || value < 0 || value > 100)
        || !Number.isFinite(cashTarget) || cashTarget < 0 || cashTarget > 100
        || Math.abs(total - 100) > 0.01) {
        throw new BacktestValidationError("시점별 목표비중 정책의 날짜·종목·비중 합계를 확인해 주세요.");
      }
      scheduledDates.add(entry.date);
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
    const assetBySymbol = new Map(request.assets.map((asset) => [normalizeSymbol(asset.symbol), asset]));
    const latestMetadataListDate = instruments.map((instrument) => instrument.listDate).sort().at(-1)!;
    // The provider's listDate can describe the current venue listing (for example,
    // after an exchange transfer), so it is not a safe historical price boundary.
    // The simulation starts from the requested range and lets the common observed
    // price matrix determine the effective period.
    const effectiveRequestedStart = request.startDate;
    if (request.cashFlows?.some((flow) => flow.date < effectiveRequestedStart || flow.date > request.endDate)) {
      throw new BacktestValidationError(`사용자 지정 현금흐름은 ${effectiveRequestedStart}부터 ${request.endDate} 사이여야 합니다.`);
    }
    if (targetSchedule.some((entry) => entry.date < effectiveRequestedStart || entry.date > request.endDate)) {
      throw new BacktestValidationError(`목표비중 정책은 ${effectiveRequestedStart}부터 ${request.endDate} 사이여야 합니다.`);
    }
    const definitions: BacktestAssetDefinition[] = instruments.map((instrument) => {
      const configured = assetBySymbol.get(instrument.symbol);
      return {
        symbol: instrument.symbol,
        name: instrument.name,
        market: instrument.market,
        currency: instrument.currency,
        listDate: instrument.listDate,
        weight: weightBySymbol.get(instrument.symbol) ?? 0,
        lotSize: configured?.lotSize ?? 1,
        ...(configured?.delistDate ? { delistDate: configured.delistDate } : {}),
        ...(configured?.universeMemberFrom ? { universeMemberFrom: configured.universeMemberFrom } : {}),
        ...(configured?.universeMemberTo ? { universeMemberTo: configured.universeMemberTo } : {}),
      };
    });
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
    const instrumentDateConsistency = instruments.map((instrument) => {
      const firstObservationDate = localPrices.get(instrumentKey(instrument))?.[0]?.date;
      return {
        symbol: instrument.symbol,
        ...(firstObservationDate ? { firstObservationDate } : {}),
        metadataListDate: instrument.listDate,
        status: !firstObservationDate
          ? "unavailable" as const
          : firstObservationDate < instrument.listDate
            ? "price_precedes_metadata" as const
            : "consistent" as const,
      };
    });
    const listingDateConflicts = instrumentDateConsistency.filter((item) => item.status === "price_precedes_metadata");
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

    const firstRequiredObservationDates: string[] = [];
    for (const instrument of instruments) {
      const firstObservationDate = localPrices.get(instrumentKey(instrument))?.[0]?.date;
      if (!firstObservationDate) {
        throw new BacktestValidationError(`${instrument.name}의 선택 기간 일봉이 없습니다.`);
      }
      firstRequiredObservationDates.push(firstObservationDate);
    }
    if (benchmark) {
      const firstBenchmarkObservationDate = benchmark.prices[0]?.date;
      if (!firstBenchmarkObservationDate) {
        throw new BacktestValidationError(`${benchmark.name}의 선택 기간 일봉이 없습니다.`);
      }
      firstRequiredObservationDates.push(firstBenchmarkObservationDate);
    }
    const firstAlignedEvaluationDate = firstRequiredObservationDates.sort().at(-1)!;

    const hasUsdSeries = instruments.some((instrument) => instrument.currency === "USD")
      || customBenchmark?.currency === "USD"
      || Boolean(builtInBenchmark && BENCHMARKS[builtInBenchmark].source === "stock");
    const valuationDates = Array.from(new Set([
      ...Array.from(localPrices.values()).flatMap((series) => series.map((point) => point.date)),
      ...(benchmark?.prices ?? []).map((point) => point.date),
    ])).filter((date) => date >= firstAlignedEvaluationDate && date <= request.endDate).sort();
    const exchangeRates = currencyMode === "KRW" && hasUsdSeries
      ? await this.marketData.ensureExchangeRates(valuationDates)
      : new Map<string, number>();
    const rateEntries = Array.from(exchangeRates.entries())
      .filter((entry) => Number.isFinite(entry[1]) && entry[1] > 0)
      .sort((left, right) => left[0].localeCompare(right[0]));
    const valuationTimeline = Array.from(new Set([
      ...valuationDates,
      ...rateEntries.map(([date]) => date),
    ])).filter((date) => date >= firstAlignedEvaluationDate && date <= request.endDate).sort();
    const observedDates = new Map<string, string[]>();
    for (const instrument of instruments) {
      const key = instrumentKey(instrument);
      observedDates.set(key, (localPrices.get(key) ?? []).map((point) => point.date));
    }
    if (benchmark) observedDates.set(benchmark.key, benchmark.prices.map((point) => point.date));
    let carriedFxObservations = 0;
    let missingFxObservations = 0;
    const convertSeries = (series: BacktestPricePoint[], currency: "KRW" | "USD"): BacktestPricePoint[] => {
      if (currencyMode !== "KRW" || currency === "KRW") {
        return series.map((point) => ({ ...point, localClose: point.close, fxRate: 1 }));
      }
      const localSeries = [...series].sort((left, right) => left.date.localeCompare(right.date));
      let localIndex = 0;
      let latestLocal: BacktestPricePoint | undefined;
      let rateIndex = 0;
      let lastRate = 0;
      let lastRateDate = "";
      return valuationTimeline.flatMap((date): BacktestPricePoint[] => {
        while (localIndex < localSeries.length && localSeries[localIndex].date <= date) {
          latestLocal = localSeries[localIndex];
          localIndex += 1;
        }
        while (rateIndex < rateEntries.length && rateEntries[rateIndex][0] <= date) {
          lastRateDate = rateEntries[rateIndex][0];
          lastRate = rateEntries[rateIndex][1];
          rateIndex += 1;
        }
        if (!latestLocal) return [];
        if (!(lastRate > 0)) {
          missingFxObservations += 1;
          return [];
        }
        if (lastRateDate !== date) carriedFxObservations += 1;
        return [{
          date,
          close: latestLocal.close * lastRate,
          localClose: latestLocal.close,
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

    const simulation: BacktestSimulationInput = {
      assets: definitions,
      prices,
      observedDates,
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
      cashFlows: request.cashFlows ?? [],
      targetWeightSchedule: targetSchedule.map((entry) => ({
        ...entry,
        weights: Object.fromEntries(Object.entries(entry.weights).map(([symbol, weight]) => [normalizeSymbol(symbol), weight])),
      })),
      execution,
      realism: request.realism,
      benchmark,
    };
    const warnings = [
      currencyMode === "KRW"
        ? "국내·해외 종목의 수정주가를 전체 기간 USD/KRW 환율로 원화 환산해 동일 기준통화로 계산했습니다."
        : "local 모드는 각 종목의 현지통화 수익률을 합성하므로 국내·해외 혼합 결과는 단일 통화 성과로 해석할 수 없습니다.",
      transactionCostBps > 0
        ? `거래비용은 매 체결금액의 ${transactionCostBps}bp를 현금에서 즉시 차감해 실제 성과 경로에 반영했습니다.`
        : "거래비용 가정이 0bp이므로 비용 차감 전 성과와 비용 차감 후 추정 성과가 같습니다.",
      execution.quantityMode === "whole"
        ? "정수 수량은 수정주가 기준 단위이며 기업행동 원시 split 이력이 없으면 실제 과거 주문 수량과 다를 수 있습니다."
        : "소수 수량 체결을 허용합니다.",
      request.realism?.dividendMode === "cash"
        ? "현금배당 모드를 요청했습니다. 공급자 배당 관측이 없으면 엔진은 배당을 추정하지 않고 unavailable 품질 상태를 반환합니다."
        : "배당은 공급자 수정주가 정책을 따릅니다. 현금배당을 중복 계상하지 않습니다.",
      request.realism?.costs?.marketImpactCoefficient
        ? "시장충격은 공급자 거래량이 있는 체결에만 적용하며, 거래량이 없으면 추정하지 않고 품질 경고를 반환합니다."
        : "시장충격 모형은 요청되지 않았습니다.",
      request.realism?.enforcePointInTimeUniverse
        ? "요청에 명시된 point-in-time universe membership 범위를 강제합니다. 누락되었거나 기간을 포함하지 않으면 실행을 거부하며 공급자 값으로 가장하지 않습니다."
        : "공급자가 과거 universe 편입·상장폐지 이력을 제공하지 않아 생존편향 보정은 보장되지 않습니다.",
      ...(request.assets.some((asset) => asset.delistDate || asset.universeMemberFrom || asset.universeMemberTo)
        ? ["상장폐지·universe 이력은 사용자 제공 입력이며 시장데이터 공급자가 검증한 값이 아닙니다."]
        : []),
      ...(targetSchedule.length
        ? [`시점별 목표비중 정책 ${targetSchedule.length}개를 공통 관측일의 실제 ledger 리밸런싱으로 검증합니다.`]
        : []),
      ...(carriedFxObservations ? [`환율 ${carriedFxObservations}개 관측은 직전 이용 가능 값을 사용했습니다.`] : []),
      ...(missingFxObservations ? [`환율 ${missingFxObservations}개 관측이 없어 계산에서 제외했습니다.`] : []),
      ...listingDateConflicts.map((item) => (
        `${item.symbol} 가격 첫 관측일 ${item.firstObservationDate}이 공급자 listDate ${item.metadataListDate}보다 빠릅니다. `
        + "listDate로 기간을 자르지 않고 실제 공통 가격 관측일을 사용했습니다."
      )),
    ];
    return {
      simulation,
      responseContext: {
        effective_requested_start: effectiveRequestedStart,
        currency_method: currencyMode === "KRW" ? "KRW_FX_CONVERTED" : "LOCAL_RETURN",
        config: {
          ...request,
          riskFreeRatePercent,
          transactionCostBps,
          currencyMode,
          baseCurrency: "KRW",
          ...(request.rebalanceFrequency === "threshold" ? { rebalanceThresholdPercent } : {}),
          ...(customBenchmark ? { benchmarkSymbol: customBenchmark.symbol } : {}),
          requestedStartDate: request.startDate,
          latestMetadataListDate,
        },
        assets: definitions,
        instrument_date_consistency: instrumentDateConsistency,
        ...(request.benchmark === "NONE" ? {} : {
          benchmark: {
            key: request.benchmark,
            name: customBenchmark?.name ?? BENCHMARKS[builtInBenchmark!].name,
            symbol: customBenchmark?.symbol ?? BENCHMARKS[builtInBenchmark!].symbol,
          },
        }),
        warnings,
      },
    };
  }

  simulatePrepared(prepared: PreparedBacktestRun): BacktestSimulationResult {
    return simulateBacktest(prepared.simulation);
  }

  finalizePrepared(
    prepared: PreparedBacktestRun,
    result: BacktestSimulationResult,
    generatedAt = new Date().toISOString(),
  ) {
    const context = prepared.responseContext;
    const warnings = [...context.warnings];
    if (result.effectiveStartDate > context.effective_requested_start) {
      warnings.unshift(`모든 종목과 비교 지수의 공통 일봉이 시작되는 ${result.effectiveStartDate}부터 계산했습니다.`);
    }
    return {
      generatedAt,
      baseCurrency: "KRW" as const,
      currencyMethod: context.currency_method,
      config: {
        ...context.config,
        effectiveStartDate: result.effectiveStartDate,
        effectiveEndDate: result.endDate,
      },
      assets: context.assets,
      ...(context.benchmark ? { benchmark: context.benchmark } : {}),
      warnings,
      ...result,
      dataQuality: {
        ...result.dataQuality,
        instrumentDateConsistency: context.instrument_date_consistency,
      },
    };
  }

  async run(request: BacktestRunRequest) {
    const prepared = await this.prepare(request);
    return this.finalizePrepared(prepared, this.simulatePrepared(prepared));
  }
}
