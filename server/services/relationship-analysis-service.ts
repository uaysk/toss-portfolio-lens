import {
  analyzePairedReturnSeries,
  analyzeReturnSeries,
  buildCorrelationMatrix,
  buildRollingCorrelation,
  convertPricesToReturns,
  type CorrelationMatrix,
  type PairedReturnAnalysis,
  type ReturnSeriesAnalysis,
  type ReturnSeriesInput,
  type PriceSeriesInput,
} from "./quant-math.js";

export type RelationshipSeriesInput = {
  key: string;
  label: string;
  points: readonly { date: string; value: number }[];
};

export type RelationshipAnalysisOptions = {
  maxComparisons?: number;
  minimumObservations?: number;
  lowCorrelationThreshold?: number;
  duplicateCorrelationThreshold?: number;
  riskFreeRatePercent?: number;
  annualization?: number;
  confidence?: number;
  method?: "pearson" | "spearman";
  rollingWindow?: number;
};

export type RelationshipPairResult = {
  key: string;
  label: string;
  commonPeriod: {
    startDate: string | null;
    endDate: string | null;
  };
  observations: number;
  singleAssetSummary: ReturnSeriesAnalysis;
  pairedSummary: PairedReturnAnalysis;
  rollingCorrelation: Array<{ date: string; value: number | null }>;
  warnings: string[];
};

export type RelationshipServiceResult = {
  baseSummary: ReturnSeriesAnalysis;
  pairs: RelationshipPairResult[];
  correlationMatrix: CorrelationMatrix;
  lowCorrelationCandidates: Array<{ left: string; right: string; correlation: number; observations: number }>;
  duplicateCandidates: Array<{ left: string; right: string; correlation: number; observations: number }>;
  dataQuality: {
    baseKey: string;
    inputComparisonCount: number;
    analyzedComparisonCount: number;
    minimumObservationFilter: number;
    warnings: string[];
  };
  warnings: string[];
};

function normalizeCorrelationThreshold(value: unknown, fallback: number): number {
  if (!Number.isFinite(Number(value))) return fallback;
  return Math.min(1, Math.max(0, Number(value)));
}

function normalizePositiveInt(value: unknown, fallback: number, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  const asInt = Number.isFinite(Number(value)) ? Math.floor(Number(value)) : NaN;
  if (!Number.isFinite(asInt)) return fallback;
  return Math.min(max, Math.max(min, asInt));
};

export function analyzeRelationships(
  base: RelationshipSeriesInput,
  comparisons: RelationshipSeriesInput[],
  options: RelationshipAnalysisOptions = {},
): RelationshipServiceResult {
  const normalized: RelationshipAnalysisOptions = {
    maxComparisons: normalizePositiveInt(options.maxComparisons, 19, 1, 19),
    minimumObservations: normalizePositiveInt(options.minimumObservations, 2, 1, 365),
    lowCorrelationThreshold: normalizeCorrelationThreshold(options.lowCorrelationThreshold, 0.35),
    duplicateCorrelationThreshold: normalizeCorrelationThreshold(options.duplicateCorrelationThreshold, 0.98),
    riskFreeRatePercent: Number.isFinite(options.riskFreeRatePercent ?? NaN) ? options.riskFreeRatePercent : 0,
    annualization: Number.isFinite(options.annualization ?? NaN) && (options.annualization ?? 0) > 0
      ? options.annualization
      : undefined,
    confidence: Number.isFinite(options.confidence ?? NaN) ? options.confidence : undefined,
  };

  const warnings: string[] = [];
  const baseReturn = convertPricesToReturns(base as PriceSeriesInput);
  const baseSummary = analyzeReturnSeries(baseReturn, {
    annualization: normalized.annualization,
    confidence: normalized.confidence,
    riskFreeRatePercent: normalized.riskFreeRatePercent,
    minimumObservations: normalized.minimumObservations,
  });

  const trimmed = comparisons.slice(0, normalized.maxComparisons ?? 19);
  if (comparisons.length > (normalized.maxComparisons ?? 19)) {
    warnings.push(`비교 자산이 ${normalized.maxComparisons ?? 19}개로 제한되었습니다.`);
  }
  if (!trimmed.length) {
    warnings.push("비교 자산이 없습니다.");
  }

  const pairs: RelationshipPairResult[] = [];
  const compareReturns: ReturnSeriesInput[] = [baseReturn];
  const minObs = normalized.minimumObservations ?? 2;

  for (const comparison of trimmed) {
    const comparisonReturn = convertPricesToReturns(comparison as PriceSeriesInput);
    compareReturns.push(comparisonReturn);
    const pairSummary = analyzePairedReturnSeries(baseReturn, comparisonReturn, {
      annualization: normalized.annualization,
      confidence: normalized.confidence,
      minimumObservations: minObs,
      riskFreeRatePercent: normalized.riskFreeRatePercent,
    });
    const singleSummary = analyzeReturnSeries(comparisonReturn, {
      annualization: normalized.annualization,
      confidence: normalized.confidence,
      minimumObservations: minObs,
      riskFreeRatePercent: normalized.riskFreeRatePercent,
    });
    const pairResult: RelationshipPairResult = {
      key: comparisonReturn.key,
      label: comparisonReturn.label,
      commonPeriod: {
        startDate: pairSummary.sampleStart,
        endDate: pairSummary.sampleEnd,
      },
      observations: pairSummary.observations,
      singleAssetSummary: singleSummary,
      pairedSummary: pairSummary,
      rollingCorrelation: buildRollingCorrelation(
        baseReturn,
        comparisonReturn,
        normalizePositiveInt(options.rollingWindow, 60, 2, 1_000),
        options.method ?? "pearson",
      ),
      warnings: [...pairSummary.warnings],
    };
    if (pairResult.observations < minObs) {
      pairResult.warnings.push(`소표본 경고: ${pairResult.observations}개`);
    }
    pairs.push(pairResult);
  }

  const matrix = buildCorrelationMatrix(compareReturns, {
    annualization: normalized.annualization,
    confidence: normalized.confidence,
    minimumObservations: minObs,
    method: options.method ?? "pearson",
  });
  const lowCorrelationCandidates: Array<{ left: string; right: string; correlation: number; observations: number }> = [];
  const duplicateCandidates: Array<{ left: string; right: string; correlation: number; observations: number }> = [];
  const lowThreshold = normalized.lowCorrelationThreshold ?? 0.35;
  const dupThreshold = normalized.duplicateCorrelationThreshold ?? 0.98;

  for (let i = 0; i < matrix.keys.length; i += 1) {
    for (let j = i + 1; j < matrix.keys.length; j += 1) {
      const correlation = matrix.correlation[i]?.[j];
      if (correlation === null) continue;
      const observations = matrix.observations[i]?.[j] ?? 0;
      if (observations < minObs) continue;
      if (Math.abs(correlation) <= lowThreshold) {
        lowCorrelationCandidates.push({
          left: matrix.keys[i]!,
          right: matrix.keys[j]!,
          correlation: correlation,
          observations,
        });
      }
      if (Math.abs(correlation) >= dupThreshold) {
        duplicateCandidates.push({
          left: matrix.keys[i]!,
          right: matrix.keys[j]!,
          correlation: correlation,
          observations,
        });
      }
    }
  }

  return {
    baseSummary,
    pairs,
    correlationMatrix: matrix,
    lowCorrelationCandidates,
    duplicateCandidates,
    dataQuality: {
      baseKey: base.key,
      inputComparisonCount: comparisons.length,
      analyzedComparisonCount: trimmed.length,
      minimumObservationFilter: minObs,
      warnings,
    },
    warnings,
  };
}
