import { createHash } from "node:crypto";
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

export function combineDataRevisions(revisions: readonly string[]): string {
  const canonical = [...revisions].sort().join("\n");
  return createHash("sha256").update(canonical).digest("hex");
}

export function priceSeriesContentRevision(series: readonly PriceSeriesInput[]): string {
  const canonical = series
    .map((item) => [
      item.key,
      item.label,
      [...item.points]
        .sort((left, right) => left.date.localeCompare(right.date))
        .map((point) => [point.date, point.value]),
    ] as const)
    .sort((left, right) => left[0].localeCompare(right[0]) || left[1].localeCompare(right[1]));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

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
    // The repository snapshot is diagnostic only. Deduplication follows the
    // exact converted price content returned to this computation, so an
    // unrelated ingestion cannot change the run identity and an in-flight
    // content change cannot hide behind one global snapshot value.
    const marketSnapshotRevision = await this.marketData.repository.dataRevision();
    const dataRevision = priceSeriesContentRevision(prices);
    return {
      prices,
      returns: prices.map(convertPricesToReturns),
      dataRevision,
      requestedPeriod: { from: input.fromDate, to: input.toDate },
      ...(from && to && from <= to ? { effectivePeriod: { from, to } } : {}),
      warnings: Array.from(new Set(results.flatMap((series) => series.warnings))),
      dataQuality: {
        adjusted: input.adjusted ?? true,
        currency_mode: input.currencyMode ?? "KRW",
        market_snapshot_revision: marketSnapshotRevision,
        data_revision_basis: {
          algorithm: "sha256",
          content: "loaded_converted_price_series",
          fields: ["instrument_id", "label", "date", "converted_close"],
          market_snapshot_revision_included: false,
        },
        assets: results.map((series) => ({
          symbol: series.instrument.symbol,
          observations: series.dataQuality.observations,
          missing_fx: series.dataQuality.missingFxObservations,
          carried_fx: series.dataQuality.carriedFxObservations,
          first_observation_date: series.dataQuality.firstObservationDate,
          metadata_list_date: series.dataQuality.metadataListDate,
          metadata_list_date_role: series.dataQuality.metadataListDateRole,
          listing_date_consistency: series.dataQuality.listingDateConsistency,
        })),
      },
    };
  }
}
