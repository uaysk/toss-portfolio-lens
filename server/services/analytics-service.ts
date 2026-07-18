import {
  analyzePairedReturnSeries,
  analyzeReturnSeries,
  alignReturnSeries,
  buildCorrelationMatrix,
  buildRollingCorrelation,
} from "./quant-math.js";
import { analyzeRelationships } from "./relationship-analysis-service.js";
import type { ReturnSeriesService } from "./return-series-service.js";
import type { CurrencyMode, MarketDataService } from "./market-data-service.js";
import { envelope } from "./service-envelope.js";

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function standardDeviation(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1));
}

export class AnalyticsService {
  constructor(
    private readonly returns: ReturnSeriesService,
    private readonly marketData: MarketDataService,
  ) {}

  async analyzeInstrument(input: {
    symbol: string;
    benchmark?: string;
    fromDate: string;
    toDate: string;
    currencyMode?: CurrencyMode;
    riskFreeRatePercent?: number;
    rollingWindow?: number;
  }) {
    const symbols = [input.symbol, ...(input.benchmark ? [input.benchmark] : [])];
    const loaded = await this.returns.load({ ...input, symbols, adjusted: true });
    const primary = analyzeReturnSeries(loaded.returns[0], {
      riskFreeRatePercent: input.riskFreeRatePercent,
      minimumObservations: 2,
    });
    const benchmark = loaded.returns[1]
      ? analyzePairedReturnSeries(loaded.returns[0], loaded.returns[1], {
          riskFreeRatePercent: input.riskFreeRatePercent,
          minimumObservations: 2,
        })
      : undefined;
    return envelope({
      request: input,
      dataRevision: loaded.dataRevision,
      requestedPeriod: loaded.requestedPeriod,
      effectivePeriod: loaded.effectivePeriod,
      assumptions: ["수정주가 수익률을 사용합니다.", "상관·상대성과는 실제 공통 관측일 inner join으로 계산합니다."],
      warnings: [...loaded.warnings, ...primary.warnings, ...(benchmark?.warnings ?? [])],
      dataQuality: loaded.dataQuality,
      result: {
        instrument: primary,
        ...(benchmark ? {
          benchmark,
          rolling_correlation: buildRollingCorrelation(
            loaded.returns[0],
            loaded.returns[1],
            input.rollingWindow ?? 60,
          ),
        } : {}),
      },
    });
  }

  async relationships(input: {
    base: string;
    comparisons: string[];
    fromDate: string;
    toDate: string;
    currencyMode?: CurrencyMode;
    method?: "pearson" | "spearman";
    rollingWindow?: number;
    riskFreeRatePercent?: number;
  }) {
    const symbols = [input.base, ...input.comparisons];
    const loaded = await this.returns.load({ ...input, symbols, adjusted: true });
    const result = analyzeRelationships(
      loaded.prices[0],
      loaded.prices.slice(1),
      {
        maxComparisons: 19,
        minimumObservations: 2,
        method: input.method,
        rollingWindow: input.rollingWindow,
        riskFreeRatePercent: input.riskFreeRatePercent,
      },
    );
    return envelope({
      request: input,
      dataRevision: loaded.dataRevision,
      requestedPeriod: loaded.requestedPeriod,
      effectivePeriod: loaded.effectivePeriod,
      assumptions: ["수정주가 수익률을 실제 공통 관측일 inner join으로 정렬했습니다."],
      warnings: [...loaded.warnings, ...result.warnings],
      dataQuality: { ...loaded.dataQuality, ...result.dataQuality },
      result,
    });
  }

  async correlationMatrix(input: {
    symbols: string[];
    fromDate: string;
    toDate: string;
    currencyMode?: CurrencyMode;
    method?: "pearson" | "spearman";
  }) {
    const loaded = await this.returns.load({ ...input, adjusted: true });
    const matrix = buildCorrelationMatrix(loaded.returns, { method: input.method });
    const pairs: Array<{ left: string; right: string; correlation: number }> = [];
    for (let left = 0; left < matrix.keys.length; left += 1) {
      for (let right = left + 1; right < matrix.keys.length; right += 1) {
        const correlation = matrix.correlation[left][right];
        if (correlation !== null) pairs.push({ left: matrix.keys[left], right: matrix.keys[right], correlation });
      }
    }
    pairs.sort((a, b) => a.correlation - b.correlation);
    return envelope({
      request: input,
      dataRevision: loaded.dataRevision,
      requestedPeriod: loaded.requestedPeriod,
      effectivePeriod: loaded.effectivePeriod,
      assumptions: ["모든 자산에 동시에 존재하는 수정주가 수익률 관측일만 사용했습니다."],
      warnings: loaded.warnings,
      dataQuality: { ...loaded.dataQuality, common_observations: matrix.observations[0]?.[0] ?? 0 },
      result: {
        ...matrix,
        average_correlation: pairs.length ? pairs.reduce((sum, pair) => sum + pair.correlation, 0) / pairs.length : null,
        lowest_pair: pairs[0] ?? null,
        highest_pair: pairs.at(-1) ?? null,
      },
    });
  }

  async marketRegimes(input: {
    benchmark: string;
    fromDate: string;
    toDate: string;
    currencyMode?: CurrencyMode;
    volatilityWindow?: number;
  }) {
    const loaded = await this.returns.load({ ...input, symbols: [input.benchmark], adjusted: true });
    const points = loaded.returns[0].points;
    const window = Math.max(5, Math.min(252, Math.floor(input.volatilityWindow ?? 20)));
    const rolling = points.map((point, index) => ({
      date: point.date,
      return: point.value,
      volatility: standardDeviation(points.slice(Math.max(0, index + 1 - window), index + 1).map((item) => item.value)) * Math.sqrt(252),
    }));
    const volatilityMedian = median(rolling.map((point) => point.volatility));
    const returnMedian = median(rolling.map((point) => point.return));
    const classified = rolling.map((point) => ({
      ...point,
      regime: `${point.return >= returnMedian ? "up" : "down"}_${point.volatility >= volatilityMedian ? "high_vol" : "low_vol"}`,
    }));
    const regimes = Array.from(new Set(classified.map((point) => point.regime))).map((regime) => {
      const values = classified.filter((point) => point.regime === regime);
      return {
        regime,
        observations: values.length,
        average_return: values.reduce((sum, point) => sum + point.return, 0) / Math.max(1, values.length),
        annualized_volatility: standardDeviation(values.map((point) => point.return)) * Math.sqrt(252),
      };
    });
    return envelope({
      request: input,
      dataRevision: loaded.dataRevision,
      requestedPeriod: loaded.requestedPeriod,
      effectivePeriod: loaded.effectivePeriod,
      assumptions: [
        `상승·하락은 표본 일수익률 중앙값(${returnMedian}) 기준입니다.`,
        `고·저변동은 ${window}일 rolling 변동성 중앙값(${volatilityMedian}) 기준입니다.`,
        "거시경제 사건은 별도 데이터 없이 추정하지 않습니다.",
      ],
      warnings: loaded.warnings,
      dataQuality: loaded.dataQuality,
      result: { thresholds: { return_median: returnMedian, volatility_median: volatilityMedian }, regimes, observations: classified },
    });
  }

  async dataQuality(input: { symbols: string[]; benchmark?: string; fromDate: string; toDate: string; adjusted?: boolean; currencyMode?: CurrencyMode }) {
    const symbols = Array.from(new Set([...input.symbols, ...(input.benchmark ? [input.benchmark] : [])]));
    const availability = await this.marketData.getDataAvailability(symbols, input.adjusted ?? true);
    const loaded = await this.returns.load({
      symbols,
      fromDate: input.fromDate,
      toDate: input.toDate,
      adjusted: input.adjusted ?? true,
      currencyMode: input.currencyMode ?? "KRW",
    });
    const aligned = alignReturnSeries(loaded.returns);
    const assetQuality = (loaded.dataQuality.assets ?? []) as Array<{ symbol: string; observations: number; missing_fx: number; carried_fx: number }>;
    const missingFx = assetQuality.reduce((sum, item) => sum + Number(item.missing_fx ?? 0), 0);
    const carriedFx = assetQuality.reduce((sum, item) => sum + Number(item.carried_fx ?? 0), 0);
    const confidence = aligned.dates.length >= 252 ? "high" : aligned.dates.length >= 60 ? "medium" : "limited";
    return envelope({
      request: input,
      dataRevision: loaded.dataRevision,
      requestedPeriod: loaded.requestedPeriod,
      effectivePeriod: loaded.effectivePeriod,
      assumptions: [
        "가격 수익률 계산에는 carry-forward를 사용하지 않고 실제 공통 관측일만 사용합니다.",
        "환율 carry-forward는 가격 시계열의 직전 유효 USD/KRW 관측을 사용한 횟수입니다.",
      ],
      warnings: [...loaded.warnings, ...(!availability.commonPeriod ? ["모든 종목에 공통된 cache 기간을 확인할 수 없습니다."] : [])],
      dataQuality: { confidence, common_return_observations: aligned.dates.length },
      result: {
        price_availability: availability,
        common_trading_days: {
          return_observations: aligned.dates.length,
          from: aligned.dates[0] ?? null,
          to: aligned.dates.at(-1) ?? null,
          policy: "inner_join",
        },
        fx_quality: {
          mode: input.currencyMode ?? "KRW",
          missing_observations: missingFx,
          carried_observations: carriedFx,
        },
        benchmark_quality: input.benchmark
          ? assetQuality.find((item) => item.symbol === input.benchmark) ?? null
          : { requested: false },
        carry_forward: { price_returns: 0, fx: carriedFx },
        cache_revision: loaded.dataRevision,
        confidence,
      },
    });
  }
}
