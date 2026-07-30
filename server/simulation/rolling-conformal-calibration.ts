import type { CalibrationStatus } from "./model-evidence.js";

export const CONFORMAL_CALIBRATION_VERSION = "rolling-conformal/v1" as const;

export type ConformalResidual = {
  modelLane: string;
  symbol: string;
  horizonMinutes: number;
  volatilityRegime?: string;
  originAt: string;
  resolvedAt: string;
  predictedQ10: number;
  predictedQ90: number;
  actualReturn: number;
};

export type RollingConformalOptions = {
  coverage?: number;
  minimumSamples?: number;
  maximumSamples?: number;
  maximumAgeMinutes?: number;
  volatilityRegime?: string;
};

export type ConformalCalibration = {
  version: typeof CONFORMAL_CALIBRATION_VERSION;
  calibrationId: string;
  status: CalibrationStatus;
  scale: number;
  sampleCount: number;
  ageMinutes: number;
  cutoffAt: string;
  lastResolvedAt: string | null;
  usedResidualOrigins: string[];
};

function timestamp(value: string, name: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be an ISO timestamp.`);
  return parsed;
}

function empiricalQuantile(values: readonly number[], probability: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(probability * (sorted.length + 1)) - 1),
  );
  return sorted[index]!;
}

export function fitRollingConformalCalibration(
  residuals: readonly ConformalResidual[],
  input: {
    modelLane: string;
    symbol: string;
    horizonMinutes: number;
    originAt: string;
  },
  options: RollingConformalOptions = {},
): ConformalCalibration {
  const cutoffMs = timestamp(input.originAt, "originAt");
  const minimumSamples = options.minimumSamples ?? 30;
  const maximumSamples = options.maximumSamples ?? 500;
  const maximumAgeMinutes = options.maximumAgeMinutes ?? 24 * 60;
  const coverage = options.coverage ?? 0.8;
  if (!Number.isInteger(minimumSamples) || minimumSamples < 1) {
    throw new Error("minimumSamples must be a positive integer.");
  }
  if (!Number.isInteger(maximumSamples) || maximumSamples < minimumSamples) {
    throw new Error("maximumSamples must be an integer >= minimumSamples.");
  }
  if (!(coverage > 0 && coverage < 1)) throw new Error("coverage must be between 0 and 1.");

  const eligible = residuals
    .filter((residual) => (
      residual.modelLane === input.modelLane
      && residual.symbol.toUpperCase() === input.symbol.toUpperCase()
      && residual.horizonMinutes === input.horizonMinutes
      && (
        options.volatilityRegime === undefined
        || residual.volatilityRegime === options.volatilityRegime
      )
      && timestamp(residual.originAt, "residual.originAt") < cutoffMs
      && timestamp(residual.resolvedAt, "residual.resolvedAt") < cutoffMs
      && Number.isFinite(residual.predictedQ10)
      && Number.isFinite(residual.predictedQ90)
      && Number.isFinite(residual.actualReturn)
    ))
    .sort((left, right) => (
      timestamp(left.resolvedAt, "left.resolvedAt")
      - timestamp(right.resolvedAt, "right.resolvedAt")
    ))
    .slice(-maximumSamples);
  const last = eligible.at(-1);
  const ageMinutes = last
    ? Math.max(0, Math.floor((cutoffMs - timestamp(last.resolvedAt, "last.resolvedAt")) / 60_000))
    : 0;
  const status: CalibrationStatus = eligible.length < minimumSamples
    ? "warming_up"
    : ageMinutes > maximumAgeMinutes
      ? "stale"
      : "ready";
  const nonconformity = eligible.map((residual) => Math.max(
    0,
    residual.predictedQ10 - residual.actualReturn,
    residual.actualReturn - residual.predictedQ90,
  ));
  const scale = status === "ready" ? empiricalQuantile(nonconformity, coverage) : 0;
  const regimeId = options.volatilityRegime ?? "all";
  return {
    version: CONFORMAL_CALIBRATION_VERSION,
    calibrationId: [
      CONFORMAL_CALIBRATION_VERSION,
      input.modelLane,
      input.symbol.toUpperCase(),
      input.horizonMinutes,
      regimeId,
      eligible.length,
    ].join(":"),
    status,
    scale,
    sampleCount: eligible.length,
    ageMinutes,
    cutoffAt: new Date(cutoffMs).toISOString(),
    lastResolvedAt: last?.resolvedAt ?? null,
    usedResidualOrigins: eligible.map((residual) => residual.originAt),
  };
}

export function applyConformalScale(
  quantiles: Readonly<Record<number, number>>,
  calibration: ConformalCalibration,
): Record<number, number> {
  const output = { ...quantiles };
  if (calibration.status !== "ready" || calibration.scale <= 0) return output;
  for (const [probabilityText, value] of Object.entries(output)) {
    const probability = Number(probabilityText);
    if (!Number.isFinite(probability) || !Number.isFinite(value)) continue;
    if (probability < 0.5) {
      output[probability] = value - calibration.scale;
    } else if (probability > 0.5) {
      output[probability] = value + calibration.scale;
    }
  }
  return output;
}
