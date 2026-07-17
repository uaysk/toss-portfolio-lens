import type { CurrencyMode, MarketDataService } from "./market-data-service.js";
import { convertPricesToReturns, type PriceSeriesInput, type ReturnSeriesInput } from "./quant-math.js";

export type LoadedReturnSeries = {
  prices: PriceSeriesInput[];
  returns: ReturnSeriesInput[];
  dataRevision: string;
  requestedPeriod: { from: string; to: string };
  effectivePeriod?: { from: string; to: string };
  warnings: string[];
  dataQuality: Record<string, unknown>;
};

export class ReturnSeriesService {
  constructor(private readonly marketData: MarketDataService) {}

  async load(input: {
    symbols: string[];
    fromDate: string;
    toDate: string;
    currencyMode?: CurrencyMode;
    adjusted?: boolean;
  }): Promise<LoadedReturnSeries> {
    const results = await Promise.all(input.symbols.map((symbol) => this.marketData.getPriceSeries({
      symbol,
      fromDate: input.fromDate,
      toDate: input.toDate,
      interval: "1d",
      adjusted: input.adjusted ?? true,
      currencyMode: input.currencyMode ?? "KRW",
    })));
    const prices = results.map((series): PriceSeriesInput => ({
      key: series.instrument.symbol,
      label: series.instrument.name,
      points: series.points.map((point) => ({ date: point.date, value: point.close })),
    }));
    const starts = results.flatMap((series) => series.effectivePeriod ? [series.effectivePeriod.from] : []);
    const ends = results.flatMap((series) => series.effectivePeriod ? [series.effectivePeriod.to] : []);
    const from = starts.sort().at(-1);
    const to = ends.sort()[0];
    return {
      prices,
      returns: prices.map(convertPricesToReturns),
      dataRevision: results.map((series) => series.dataRevision).sort().join(":"),
      requestedPeriod: { from: input.fromDate, to: input.toDate },
      ...(from && to && from <= to ? { effectivePeriod: { from, to } } : {}),
      warnings: Array.from(new Set(results.flatMap((series) => series.warnings))),
      dataQuality: {
        adjusted: input.adjusted ?? true,
        currency_mode: input.currencyMode ?? "KRW",
        assets: results.map((series) => ({
          symbol: series.instrument.symbol,
          observations: series.dataQuality.observations,
          missing_fx: series.dataQuality.missingFxObservations,
          carried_fx: series.dataQuality.carriedFxObservations,
        })),
      },
    };
  }
}
