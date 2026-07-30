import { z } from "zod";
import {
  SimulationModelLaneSchema,
  SimulationModelRoleSchema,
} from "./contracts.js";

export const MODEL_EVIDENCE_SCHEMA_VERSION = "simulation-model-evidence/v1" as const;

export const CalibrationStatusSchema = z.enum([
  "ready",
  "warming_up",
  "stale",
  "unavailable",
]);
export type CalibrationStatus = z.infer<typeof CalibrationStatusSchema>;

export const ModelDataQualitySchema = z.object({
  status: z.enum(["ok", "degraded", "unavailable"]),
  finalizedOnly: z.boolean(),
  stale: z.boolean(),
  missingRate: z.number().finite().min(0).max(1),
  unavailableFeatures: z.array(z.string().trim().min(1).max(128)).max(128),
  warnings: z.array(z.string().trim().min(1).max(500)).max(128),
}).strict();
export type ModelDataQuality = z.infer<typeof ModelDataQualitySchema>;

export const ModelEvidenceSchema = z.object({
  schemaVersion: z.literal(MODEL_EVIDENCE_SCHEMA_VERSION),
  modelLane: SimulationModelLaneSchema,
  modelId: z.string().trim().min(1).max(256),
  modelRevision: z.string().trim().min(1).max(256),
  role: SimulationModelRoleSchema,
  symbol: z.string().trim().min(1).max(32),
  originAt: z.string().datetime({ offset: true }),
  horizonMinutes: z.union([
    z.literal(5),
    z.literal(15),
    z.literal(30),
    z.literal(60),
  ]),
  q01Return: z.number().finite().optional(),
  q05Return: z.number().finite().optional(),
  q10Return: z.number().finite(),
  q50Return: z.number().finite(),
  q90Return: z.number().finite(),
  q95Return: z.number().finite().optional(),
  q99Return: z.number().finite().optional(),
  expectedReturn: z.number().finite(),
  expectedNetReturn: z.number().finite(),
  pNetLong: z.number().finite().min(0).max(1),
  pNetShort: z.number().finite().min(0).max(1),
  intervalWidth: z.number().finite().nonnegative(),
  expectedShortfall: z.number().finite().nonnegative(),
  calibrationId: z.string().trim().min(1).max(256),
  calibrationStatus: CalibrationStatusSchema,
  calibrationAge: z.number().int().nonnegative(),
  featureProfile: z.string().trim().min(1).max(128),
  dataQuality: ModelDataQualitySchema,
  generatedAt: z.string().datetime({ offset: true }),
  latencyMs: z.number().finite().nonnegative(),
  inputOrigin: z.enum(["live", "historical", "prediction_cache", "deterministic_test"]),
  quantileCrossingCorrected: z.boolean(),
  rawQuantiles: z.record(z.string(), z.number().finite()),
}).strict().superRefine((evidence, context) => {
  const ordered = [
    evidence.q01Return,
    evidence.q05Return,
    evidence.q10Return,
    evidence.q50Return,
    evidence.q90Return,
    evidence.q95Return,
    evidence.q99Return,
  ].filter((value): value is number => value !== undefined);
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index]! < ordered[index - 1]!) {
      context.addIssue({
        code: "custom",
        path: ["q50Return"],
        message: "model evidence quantiles must be monotonic",
      });
      break;
    }
  }
  if (Date.parse(evidence.generatedAt) < Date.parse(evidence.originAt)) {
    context.addIssue({
      code: "custom",
      path: ["generatedAt"],
      message: "generatedAt must not precede originAt",
    });
  }
});
export type ModelEvidence = z.infer<typeof ModelEvidenceSchema>;

export type EvidenceCostBreakdown = {
  commissionBps: number;
  spreadBps: number;
  slippageBps: number;
  fundingBps: number;
  safetyMarginBps: number;
};

export type ModelEvidenceInput = {
  modelLane: ModelEvidence["modelLane"];
  modelId: string;
  modelRevision: string;
  role: ModelEvidence["role"];
  symbol: string;
  originAt: string;
  horizonMinutes: ModelEvidence["horizonMinutes"];
  quantiles: Readonly<Record<number, number>>;
  expectedReturn?: number;
  calibrationId: string;
  calibrationStatus: CalibrationStatus;
  calibrationAge: number;
  featureProfile: string;
  dataQuality: ModelDataQuality;
  generatedAt: string;
  latencyMs: number;
  inputOrigin: ModelEvidence["inputOrigin"];
  costs: EvidenceCostBreakdown;
};

type QuantilePoint = {
  probability: number;
  value: number;
};

function assertFiniteNonNegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a finite non-negative number.`);
  }
  return value;
}

export function totalDirectionalCostRate(costs: EvidenceCostBreakdown): {
  long: number;
  short: number;
} {
  const commission = assertFiniteNonNegative(costs.commissionBps, "commissionBps");
  const spread = assertFiniteNonNegative(costs.spreadBps, "spreadBps");
  const slippage = assertFiniteNonNegative(costs.slippageBps, "slippageBps");
  const safety = assertFiniteNonNegative(costs.safetyMarginBps, "safetyMarginBps");
  if (!Number.isFinite(costs.fundingBps)) {
    throw new Error("fundingBps must be finite.");
  }
  const base = commission + spread + slippage + safety;
  return {
    long: Math.max(0, base + costs.fundingBps) / 10_000,
    short: Math.max(0, base - costs.fundingBps) / 10_000,
  };
}

function normalizeQuantiles(
  quantiles: Readonly<Record<number, number>>,
): { points: QuantilePoint[]; crossingCorrected: boolean; raw: Record<string, number> } {
  const points = Object.entries(quantiles)
    .map(([key, value]) => ({ probability: Number(key), value }))
    .filter(({ probability, value }) => (
      Number.isFinite(probability)
      && probability > 0
      && probability < 1
      && Number.isFinite(value)
    ))
    .sort((left, right) => left.probability - right.probability);
  if (points.length < 3) {
    throw new Error("At least three finite model quantiles are required.");
  }
  const raw = Object.fromEntries(
    points.map(({ probability, value }) => [probability.toFixed(4), value]),
  );
  let crossingCorrected = false;
  let previous = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    if (point.value < previous) {
      point.value = previous;
      crossingCorrected = true;
    }
    previous = point.value;
  }
  return { points, crossingCorrected, raw };
}

function valueAtProbability(points: readonly QuantilePoint[], probability: number): number {
  if (probability <= points[0]!.probability) return points[0]!.value;
  if (probability >= points.at(-1)!.probability) return points.at(-1)!.value;
  const rightIndex = points.findIndex((point) => point.probability >= probability);
  const right = points[rightIndex]!;
  const left = points[rightIndex - 1]!;
  const weight = (probability - left.probability) / (right.probability - left.probability);
  return left.value + (right.value - left.value) * weight;
}

/**
 * A deterministic piecewise-linear CDF derived from native model quantiles.
 * Tail mass is conservatively clamped to the outer native probabilities.
 */
export function probabilityAtOrBelow(
  quantiles: Readonly<Record<number, number>>,
  threshold: number,
): number {
  const { points } = normalizeQuantiles(quantiles);
  if (threshold < points[0]!.value) return 0;
  if (threshold >= points.at(-1)!.value) return 1;
  const rightIndex = points.findIndex((point) => point.value >= threshold);
  const right = points[rightIndex]!;
  const left = points[Math.max(0, rightIndex - 1)]!;
  if (right.value === left.value) return right.probability;
  const weight = (threshold - left.value) / (right.value - left.value);
  return Math.max(
    0,
    Math.min(1, left.probability + (right.probability - left.probability) * weight),
  );
}

export function normalizeModelEvidence(input: ModelEvidenceInput): ModelEvidence {
  const normalized = normalizeQuantiles(input.quantiles);
  const monotonicQuantiles = Object.fromEntries(
    normalized.points.map(({ probability, value }) => [probability, value]),
  );
  const q01Return = normalized.points.some((point) => point.probability === 0.01)
    ? valueAtProbability(normalized.points, 0.01)
    : undefined;
  const q05Return = normalized.points.some((point) => point.probability <= 0.05)
    ? valueAtProbability(normalized.points, 0.05)
    : undefined;
  const q10Return = valueAtProbability(normalized.points, 0.1);
  const q50Return = valueAtProbability(normalized.points, 0.5);
  const q90Return = valueAtProbability(normalized.points, 0.9);
  const q95Return = normalized.points.some((point) => point.probability >= 0.95)
    ? valueAtProbability(normalized.points, 0.95)
    : undefined;
  const q99Return = normalized.points.some((point) => point.probability === 0.99)
    ? valueAtProbability(normalized.points, 0.99)
    : undefined;
  const expectedReturn = input.expectedReturn ?? q50Return;
  const directionalCosts = totalDirectionalCostRate(input.costs);
  const expectedNetReturn = expectedReturn >= 0
    ? expectedReturn - directionalCosts.long
    : expectedReturn + directionalCosts.short;
  const pNetLong = 1 - probabilityAtOrBelow(monotonicQuantiles, directionalCosts.long);
  const pNetShort = probabilityAtOrBelow(monotonicQuantiles, -directionalCosts.short);
  const tailValues = [q01Return, q05Return, q10Return]
    .filter((value): value is number => value !== undefined);
  const expectedShortfall = Math.max(
    0,
    -(tailValues.reduce((sum, value) => sum + value, 0) / tailValues.length),
  );
  return ModelEvidenceSchema.parse({
    schemaVersion: MODEL_EVIDENCE_SCHEMA_VERSION,
    modelLane: input.modelLane,
    modelId: input.modelId,
    modelRevision: input.modelRevision,
    role: input.role,
    symbol: input.symbol.toUpperCase(),
    originAt: input.originAt,
    horizonMinutes: input.horizonMinutes,
    ...(q01Return === undefined ? {} : { q01Return }),
    ...(q05Return === undefined ? {} : { q05Return }),
    q10Return,
    q50Return,
    q90Return,
    ...(q95Return === undefined ? {} : { q95Return }),
    ...(q99Return === undefined ? {} : { q99Return }),
    expectedReturn,
    expectedNetReturn,
    pNetLong,
    pNetShort,
    intervalWidth: q90Return - q10Return,
    expectedShortfall,
    calibrationId: input.calibrationId,
    calibrationStatus: input.calibrationStatus,
    calibrationAge: input.calibrationAge,
    featureProfile: input.featureProfile,
    dataQuality: input.dataQuality,
    generatedAt: input.generatedAt,
    latencyMs: input.latencyMs,
    inputOrigin: input.inputOrigin,
    quantileCrossingCorrected: normalized.crossingCorrected,
    rawQuantiles: normalized.raw,
  });
}
