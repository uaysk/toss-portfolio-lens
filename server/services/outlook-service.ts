type Json = Record<string, unknown>;

function record(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function path(value: unknown, ...keys: string[]): unknown {
  let current: unknown = value;
  for (const key of keys) current = record(current)[key];
  return current;
}

function metric(value: unknown, ...keys: string[]): number | null {
  return number(path(value, ...keys));
}

function terminalQuantiles(monteCarlo: unknown): Array<{ quantile: number; balance: number }> {
  return array(path(monteCarlo, "distributions", "terminalBalance", "percentiles"))
    .flatMap((item) => {
      const quantile = metric(item, "quantile");
      const balance = metric(item, "value");
      return quantile === null || balance === null ? [] : [{ quantile, balance }];
    });
}

function stitchedOos(foldsValue: unknown): Array<{ fold: number; date: string; equity: number }> {
  let equity = 1;
  return array(foldsValue).flatMap((fold, index) => {
    const portfolioReturn = metric(fold, "oos", "return");
    if (portfolioReturn === null || portfolioReturn <= -1) return [];
    equity *= 1 + portfolioReturn;
    const row = record(fold);
    return [{
      fold: index,
      date: String(row.testEnd ?? row.test_end ?? `fold-${index + 1}`),
      equity,
    }];
  });
}

function worstScenarios(stress: unknown): unknown[] {
  return array(record(stress).scenarios)
    .map((scenario) => ({
      ...record(scenario),
      _return: metric(scenario, "metrics", "totalReturnPercent") ?? Number.POSITIVE_INFINITY,
    }))
    .sort((left, right) => Number(left._return) - Number(right._return))
    .slice(0, 5)
    .map(({ _return: _, ...scenario }) => scenario);
}

export function combinePortfolioOutlook(input: {
  optimization?: unknown;
  walkForward: unknown;
  monteCarlo: unknown;
  stress: unknown;
  marketWarnings?: string[];
  confidenceWeights: { oos: number; monteCarloCalibration: number; dataQuality: number };
}) {
  const folds = array(record(input.walkForward).folds);
  const stitched = stitchedOos(folds);
  const oosCoverage = number(path(input.walkForward, "oosSummary", "coverage"))
    ?? number(path(input.walkForward, "oos_summary", "coverage"))
    ?? (folds.length ? Math.min(1,
      folds.reduce((sum: number, fold: unknown) => sum + (metric(fold, "oos", "sampleCount") ?? 0), 0)
      / Math.max(1, folds.reduce((sum: number, fold: unknown) => (
        sum + (metric(fold, "trainCount") ?? 0) + (metric(fold, "oos", "sampleCount") ?? 0)
      ), 0)),
    ) : null);
  const calibration = record(record(input.monteCarlo).calibration);
  const calibrationScore = number(calibration.score)
    ?? number(calibration.intervalCoverageScore)
    ?? number(calibration.coverageScore);
  const warnings = Array.from(new Set(input.marketWarnings ?? []));
  const dataQualityScore = Math.max(0, Math.min(1, 1 - warnings.length * 0.08));
  const components = [
    { name: "oos", raw: oosCoverage, weight: input.confidenceWeights.oos },
    { name: "monte_carlo_calibration", raw: calibrationScore, weight: input.confidenceWeights.monteCarloCalibration },
    { name: "data_quality", raw: dataQualityScore, weight: input.confidenceWeights.dataQuality },
  ].map((item) => ({ ...item, available: item.raw !== null }));
  const availableWeight = components.filter((item) => item.available).reduce((sum, item) => sum + item.weight, 0);
  const confidenceScore = availableWeight > 0
    ? components.reduce((sum, item) => sum + (item.raw ?? 0) * item.weight, 0) / availableWeight
    : 0;
  const quantiles = terminalQuantiles(input.monteCarlo);
  const missingWarnings = [
    ...(calibrationScore === null ? ["Monte Carlo calibration 결과가 없어 신뢰도 계산에서 해당 구성요소를 제외했습니다."] : []),
    ...(!stitched.length ? ["유효한 fold별 OOS 수익률이 없어 stitched OOS equity를 만들지 못했습니다."] : []),
  ];
  const worst = worstScenarios(input.stress);

  return {
    future: {
      terminalBalanceQuantiles: quantiles,
      terminalLossProbabilityPercent: metric(input.monteCarlo, "probabilities", "terminalLossProbabilityPercent"),
      goalProbabilityPercent: metric(input.monteCarlo, "probabilities", "terminalGoalProbabilityPercent"),
      depletionProbabilityPercent: metric(input.monteCarlo, "probabilities", "everDepletedProbabilityPercent"),
      percentilePaths: array(record(input.monteCarlo).percentilePaths),
    },
    oos: {
      foldCount: folds.length,
      coverage: oosCoverage,
      cagr: metric(input.walkForward, "oosSummary", "cagr"),
      maxDrawdown: metric(input.walkForward, "oosSummary", "maxDrawdown"),
      sharpe: metric(input.walkForward, "oosSummary", "sharpe"),
      informationRatio: metric(input.walkForward, "oosSummary", "informationRatio"),
      benchmarkWinRate: metric(input.walkForward, "oosSummary", "benchmarkWinRate"),
      seedStability: path(input.walkForward, "seedStability") ?? null,
      stitchedEquity: stitched,
    },
    optimization: input.optimization ?? null,
    stress: {
      worstScenarios: worst,
      worstScenario: worst[0] ?? null,
      distributions: record(input.stress).distributions ?? null,
    },
    calibration: Object.keys(calibration).length ? calibration : null,
    confidence: {
      score: confidenceScore,
      label: confidenceScore >= 0.75 ? "high" : confidenceScore >= 0.5 ? "medium" : "low",
      availableWeight,
      components,
    },
    dataQuality: {
      status: warnings.length || missingWarnings.length ? "partial" : "available",
      warnings,
      coverage: { oos: oosCoverage, monteCarloCalibration: calibrationScore },
    },
    warnings: [...warnings, ...missingWarnings],
  };
}
