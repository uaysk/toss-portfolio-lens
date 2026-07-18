export type ExposureAsset = {
  symbol: string;
  weight: number;
  currency: string;
  sector?: string;
  industry?: string;
  country?: string;
  assetType?: string;
  hedged?: boolean;
  factors?: Record<string, number>;
  constituents?: Array<{
    symbol: string;
    weight: number;
    sector?: string;
    industry?: string;
    country?: string;
    currency?: string;
    assetType?: string;
    hedged?: boolean;
    factors?: Record<string, number>;
  }>;
};

type Dimension = "sector" | "industry" | "country" | "currency" | "assetType";

function add(target: Record<string, number>, key: string | undefined, weight: number): void {
  target[key?.trim() || "UNKNOWN"] = (target[key?.trim() || "UNKNOWN"] ?? 0) + weight;
}

function sorted(values: Record<string, number>): Array<{ name: string; weight: number }> {
  return Object.entries(values)
    .map(([name, weight]) => ({ name, weight }))
    .sort((left, right) => right.weight - left.weight || left.name.localeCompare(right.name));
}

const WEIGHT_EPSILON = 1e-12;

function metadataStatus(coveredWeight: number, totalWeight: number): "available" | "partial" | "unavailable" {
  if (coveredWeight <= WEIGHT_EPSILON) return "unavailable";
  return coveredWeight >= totalWeight - WEIGHT_EPSILON ? "available" : "partial";
}

export function analyzePortfolioExposures(assets: ExposureAsset[], lookThrough = true) {
  const totals: Record<Dimension, Record<string, number>> = {
    sector: {}, industry: {}, country: {}, currency: {}, assetType: {},
  };
  const coverage: Record<Dimension, number> = {
    sector: 0, industry: 0, country: 0, currency: 0, assetType: 0,
  };
  const factorTotals: Record<string, number> = {};
  const factorCoverage: Record<string, number> = {};
  const warnings: string[] = [];
  const qualityByAsset: Array<Record<string, unknown>> = [];
  let lookThroughCoverage = 0;
  let hedgedWeight = 0;
  let unhedgedWeight = 0;
  let unknownHedgeWeight = 0;

  for (const asset of assets) {
    const suppliedConstituentSum = asset.constituents?.reduce((sum, item) => sum + item.weight, 0) ?? 0;
    if (suppliedConstituentSum > 1 + WEIGHT_EPSILON) {
      throw new RangeError(`${asset.symbol} 구성종목 비중 합계는 1을 초과할 수 없습니다.`);
    }
    const constituents = lookThrough && asset.constituents?.length ? asset.constituents : undefined;
    const constituentSum = constituents ? suppliedConstituentSum : 0;
    const effectiveMetadataCoverage: Record<Dimension, number> = {
      sector: 0, industry: 0, country: 0, currency: 0, assetType: 0,
    };
    let effectiveFactorCoverage = 0;
    let effectiveHedgeCoverage = 0;
    if (constituents) {
      lookThroughCoverage += asset.weight * constituentSum;
      for (const constituent of constituents) {
        const weight = asset.weight * constituent.weight;
        for (const dimension of ["sector", "industry", "country", "currency", "assetType"] as const) {
          const value = constituent[dimension];
          add(totals[dimension], value, weight);
          if (value) {
            coverage[dimension] += weight;
            effectiveMetadataCoverage[dimension] += weight;
          }
        }
        for (const [factor, value] of Object.entries(constituent.factors ?? {})) {
          factorTotals[factor] = (factorTotals[factor] ?? 0) + weight * value;
          factorCoverage[factor] = (factorCoverage[factor] ?? 0) + weight;
        }
        if (Object.keys(constituent.factors ?? {}).length) effectiveFactorCoverage += weight;
        if (constituent.hedged === true) {
          hedgedWeight += weight;
          effectiveHedgeCoverage += weight;
        } else if (constituent.hedged === false) {
          unhedgedWeight += weight;
          effectiveHedgeCoverage += weight;
        } else {
          unknownHedgeWeight += weight;
        }
      }
      const residual = asset.weight * Math.max(0, 1 - constituentSum);
      if (residual > 1e-9) {
        for (const dimension of Object.keys(totals) as Dimension[]) add(totals[dimension], undefined, residual);
        unknownHedgeWeight += residual;
        warnings.push(`${asset.symbol} 구성종목 비중 ${Math.round(constituentSum * 10_000) / 100}%만 제공되어 나머지는 UNKNOWN입니다.`);
      }
    } else {
      for (const dimension of ["sector", "industry", "country", "assetType"] as const) {
        add(totals[dimension], asset[dimension], asset.weight);
        if (asset[dimension]) {
          coverage[dimension] += asset.weight;
          effectiveMetadataCoverage[dimension] += asset.weight;
        }
      }
      add(totals.currency, asset.currency, asset.weight);
      coverage.currency += asset.weight;
      effectiveMetadataCoverage.currency += asset.weight;
      for (const [factor, value] of Object.entries(asset.factors ?? {})) {
        factorTotals[factor] = (factorTotals[factor] ?? 0) + asset.weight * value;
        factorCoverage[factor] = (factorCoverage[factor] ?? 0) + asset.weight;
      }
      if (Object.keys(asset.factors ?? {}).length) effectiveFactorCoverage += asset.weight;
      if (asset.hedged === true) {
        hedgedWeight += asset.weight;
        effectiveHedgeCoverage += asset.weight;
      } else if (asset.hedged === false) {
        unhedgedWeight += asset.weight;
        effectiveHedgeCoverage += asset.weight;
      } else {
        unknownHedgeWeight += asset.weight;
      }
      if (lookThrough && asset.assetType?.toUpperCase().includes("ETF")) {
        warnings.push(`${asset.symbol} ETF 구성종목 snapshot이 없어 look-through를 적용하지 못했습니다.`);
      }
    }

    qualityByAsset.push({
      symbol: asset.symbol,
      metadata: {
        sector: metadataStatus(effectiveMetadataCoverage.sector, asset.weight),
        industry: metadataStatus(effectiveMetadataCoverage.industry, asset.weight),
        country: metadataStatus(effectiveMetadataCoverage.country, asset.weight),
        currency: metadataStatus(effectiveMetadataCoverage.currency, asset.weight),
        asset_type: metadataStatus(effectiveMetadataCoverage.assetType, asset.weight),
        factors: metadataStatus(effectiveFactorCoverage, asset.weight),
        hedge: metadataStatus(effectiveHedgeCoverage, asset.weight),
        etf_constituents: asset.constituents?.length
          ? metadataStatus(asset.weight * suppliedConstituentSum, asset.weight)
          : "unavailable",
      },
    });
  }

  return {
    exposures: Object.fromEntries((Object.keys(totals) as Dimension[]).map((dimension) => [dimension, sorted(totals[dimension])])),
    factorExposures: Object.entries(factorTotals).sort(([left], [right]) => left.localeCompare(right)).map(([factor, value]) => ({
      factor,
      value,
      coverage: factorCoverage[factor] ?? 0,
    })),
    currencyHedge: { hedgedWeight, unhedgedWeight, unknownWeight: unknownHedgeWeight },
    coverage: { ...coverage, lookThrough: lookThroughCoverage },
    dataQuality: {
      status: warnings.length ? "partial" : "available",
      byAsset: qualityByAsset,
      providerEstimatedFields: [],
    },
    warnings: Array.from(new Set(warnings)),
  };
}
