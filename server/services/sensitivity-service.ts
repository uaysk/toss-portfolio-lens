import { createDeterministicRng } from "./quant-math.js";

export type CashFlowPoint = {
  date: string;
  amount: number;
  memo?: string;
};

export type RebalanceMode = "none" | "monthly" | "quarterly" | "semiannual" | "annual" | "threshold" | "custom";

export type RebalancePlan = {
  mode: RebalanceMode;
  frequencyMonths: number;
  tolerancePercent: number;
  dates: string[];
};

export type SensitivityScenario = {
  id: string;
  startDate: string;
  baseWeights: Record<string, number>;
  rebalancePlan: RebalancePlan;
  cashFlows: CashFlowPoint[];
  label: string;
  metadata: {
    weightScaleIndex: number;
    dateShiftIndex: number;
    rebalanceIndex: number;
    cashFlowIndex: number;
  };
};

export type SensitivityEvaluator<T> = (scenario: SensitivityScenario) => Promise<T> | T;

export type SensitivityAnalyzeInput = {
  baseWeights: Record<string, number>;
  baseStartDate: string;
  endDate: string;
  seed?: number;
  scenarioLimit?: number;
  weightScenarioCount?: number;
  weightShiftPercent?: number;
  startDateOffsets?: number[];
  rebalanceModes?: RebalanceMode[];
  cashFlowStressMultipliers?: number[];
  baseCashFlows?: CashFlowPoint[];
  metricName?: string;
  metricSelector?: (result: unknown) => number;
  higherIsBetter?: boolean;
  targetAsset?: string;
  targetWeights?: number[];
  isCancelled?: () => Promise<boolean> | boolean;
};

export type SensitivityScenarioResult<T> = {
  scenario: SensitivityScenario;
  result: T;
  score: number | null;
  rank: number;
};

export type SensitivityAnalysisResult<T> = {
  baselineScenarioId: string;
  scenarios: Array<SensitivityScenarioResult<T>>;
  warnings: string[];
};

const MAX_SCENARIOS = 500;
const DEFAULT_WEIGHT_SCENARIOS = 6;
const MAX_WEIGHT_SCENARIOS = 30;
const DEFAULT_SHIFT_PERCENT = 8;
const DAY_MS = 86_400_000;

function isValidDateLike(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function normalizeWeights(weights: Record<string, number>): Record<string, number> {
  const positive: Record<string, number> = {};
  let total = 0;
  for (const [key, value] of Object.entries(weights)) {
    if (!Number.isFinite(value) || value < 0) continue;
    positive[key] = value;
    total += value;
  }
  if (!total) return {};
  for (const key of Object.keys(positive)) {
    positive[key] = positive[key]! / total;
  }
  return positive;
}

function addDays(date: string, days: number): string {
  const parsed = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(parsed)) return date;
  const shifted = new Date(parsed + days * DAY_MS);
  return shifted.toISOString().slice(0, 10);
}

function addMonths(base: string, months: number): string {
  const parsed = new Date(`${base}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return base;
  const next = new Date(Date.UTC(
    parsed.getUTCFullYear(),
    parsed.getUTCMonth() + months,
    Math.min(28, parsed.getUTCDate()),
  ));
  return next.toISOString().slice(0, 10);
}

function buildWeightsSignature(weights: Record<string, number>): string {
  return Object.entries(weights)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}:${value.toFixed(8)}`)
    .join("|");
}

export function buildRebalancePlan(
  startDate: string,
  endDate: string,
  mode: RebalanceMode,
  frequencyMonths = 1,
  tolerancePercent = 5,
  customDates: string[] = [],
): RebalancePlan {
  const safeStart = isValidDateLike(startDate) ? startDate : "";
  const safeEnd = isValidDateLike(endDate) ? endDate : "";
  const safeTolerance = Math.max(0, Math.min(100, tolerancePercent));
  if (mode === "none" || mode === "threshold" || !safeStart || !safeEnd || safeStart > safeEnd) {
    return { mode, frequencyMonths, tolerancePercent: safeTolerance, dates: safeStart ? [safeStart] : [] };
  }
  if (mode === "custom") {
    const dates = Array.from(new Set(customDates.filter(isValidDateLike)))
      .filter((date) => date >= safeStart && date <= safeEnd)
      .sort();
    return {
      mode,
      frequencyMonths,
      tolerancePercent: safeTolerance,
      dates: dates.length ? dates : [safeStart],
    };
  }

  const step = mode === "monthly" ? 1 : mode === "quarterly" ? 3 : mode === "semiannual" ? 6 : 12;
  const safeFrequency = frequencyMonths > 0 ? frequencyMonths : step;
  const dates = [safeStart];
  let cursor = safeStart;
  while (cursor < safeEnd) {
    cursor = addMonths(cursor, safeFrequency);
    if (cursor <= safeEnd) dates.push(cursor);
  }
  return {
    mode,
    frequencyMonths: safeFrequency,
    tolerancePercent: safeTolerance,
    dates,
  };
}

export function buildStressCashFlowScenarios(
  baseCashFlows: CashFlowPoint[] = [],
  multipliers: number[] = [1],
): Array<{ key: string; label: string; cashFlows: CashFlowPoint[] }> {
  const normalized = baseCashFlows.filter((item) => isValidDateLike(item.date) && Number.isFinite(item.amount));
  if (!normalized.length) return [{ key: "base", label: "base", cashFlows: [] }];
  const factors = multipliers.length ? multipliers : [1];
  return factors.map((factor, index) => {
    const validFactor = Number.isFinite(factor) ? factor : 1;
    return {
      key: `multiplier-${index + 1}`,
      label: `cashflow-${index + 1}`,
      cashFlows: normalized.map((item) => ({ ...item, amount: item.amount * validFactor })),
    };
  });
}

function buildWeightScenarios(
  baseWeights: Record<string, number>,
  count: number,
  shiftPercent: number,
  rng: ReturnType<typeof createDeterministicRng>,
): Array<{ key: string; label: string; weights: Record<string, number> }> {
  const normalized = normalizeWeights(baseWeights);
  const keys = Object.keys(normalized).sort();
  if (!keys.length) return [];
  if (keys.length === 1) {
    return [{ key: "base", label: "base", weights: normalized }];
  }
  const maxShift = Math.max(0, Math.min(1, shiftPercent / 100));

  const results = [{ key: "base", label: "base", weights: normalized }];
  if (count <= 1) return results;
  const signatures = new Set([buildWeightsSignature(normalized)]);
  for (let attempt = 0; attempt < 5_000 && results.length < count; attempt += 1) {
    const candidate = { ...normalized };
    const donorIndex = rng.nextInt(keys.length);
    const receiverIndex = rng.nextInt(keys.length - 1);
    const donor = keys[donorIndex];
    const receiver = keys[receiverIndex < donorIndex ? receiverIndex : receiverIndex + 1];
    const donorWeight = candidate[donor] ?? 0;
    const receiverWeight = candidate[receiver!]!;
    const shiftBase = maxShift * (0.5 + rng.next() / 2);
    const direction = rng.next() < 0.5 ? -1 : 1;
    const maxShiftByDirection = direction === 1
      ? Math.min(1 - donorWeight, receiverWeight)
      : Math.min(donorWeight, 1 - receiverWeight);
    const moved = shiftBase * maxShiftByDirection;
    if (!Number.isFinite(moved) || moved <= 0) continue;

    candidate[donor] = clamp(donorWeight + direction * moved, 0, 1);
    candidate[receiver!] = clamp(receiverWeight - direction * moved, 0, 1);
    const normalizedCandidate = normalizeWeights(candidate);
    const signature = buildWeightsSignature(normalizedCandidate);
    if (signatures.has(signature)) continue;
    signatures.add(signature);
    results.push({
      key: `w-${results.length}`,
      label: `weight-${results.length}`,
      weights: normalizedCandidate,
    });
  }
  return results;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

export async function runSensitivityAnalysis<T>(
  input: SensitivityAnalyzeInput,
  evaluate: SensitivityEvaluator<T>,
): Promise<SensitivityAnalysisResult<T>> {
  const warnings: string[] = [];
  const limit = Math.max(1, Math.min(MAX_SCENARIOS, Math.floor(input.scenarioLimit ?? 120)));
  const resolvedShiftPercent = Number.isFinite(input.weightShiftPercent as number | undefined) ? input.weightShiftPercent : DEFAULT_SHIFT_PERCENT;
  const shiftPercent = Math.max(0, Math.min(90, resolvedShiftPercent!));
  const baseWeights = normalizeWeights(input.baseWeights);
  if (!Object.keys(baseWeights).length) {
    throw new Error("기본 비중이 유효하지 않습니다.");
  }
  if (!isValidDateLike(input.baseStartDate) || !isValidDateLike(input.endDate)) {
    warnings.push("날짜 형식이 YYYY-MM-DD가 아닙니다.");
  }
  if (input.baseStartDate > input.endDate) {
    warnings.push("기준 시작일이 종료일보다 큽니다.");
  }

  const rng = createDeterministicRng(input.seed ?? 9919);
  const weightCount = Math.max(
    1,
    Math.min(MAX_WEIGHT_SCENARIOS, Math.floor(input.weightScenarioCount ?? DEFAULT_WEIGHT_SCENARIOS)),
  );
  const weightScenarios = buildWeightScenarios(baseWeights, weightCount, shiftPercent, rng);
  if (input.targetAsset && input.targetWeights?.length) {
    const targetAsset = input.targetAsset;
    if (!(targetAsset in baseWeights)) throw new Error("민감도 대상 종목이 기본 비중에 없습니다.");
    const otherKeys = Object.keys(baseWeights).filter((key) => key !== targetAsset);
    const otherTotal = otherKeys.reduce((sum, key) => sum + baseWeights[key], 0);
    weightScenarios.splice(0, weightScenarios.length, ...input.targetWeights.slice(0, MAX_WEIGHT_SCENARIOS).map((raw, index) => {
      const target = Math.max(0, Math.min(1, raw));
      const weights: Record<string, number> = { [targetAsset]: target };
      for (const key of otherKeys) weights[key] = otherTotal > 0 ? (1 - target) * baseWeights[key] / otherTotal : 0;
      return { key: `target-${index}`, label: `${targetAsset}-${target}`, weights };
    }));
  }

  const startOffsets = Array.isArray(input.startDateOffsets) && input.startDateOffsets.length
    ? input.startDateOffsets.slice(0, 60)
      .filter((value) => Number.isFinite(value))
      .map((value) => Math.trunc(value))
      .sort((left, right) => left - right)
    : [0];
  const startDateCandidates = Array.from(new Set(startOffsets.map((offset) => addDays(input.baseStartDate, offset))));

  const rebalanceModes: RebalanceMode[] = input.rebalanceModes?.length
    ? input.rebalanceModes.slice(0, 12)
    : ["none", "monthly", "quarterly", "annual"];
  const cashFlowPlans = buildStressCashFlowScenarios(
    input.baseCashFlows ?? [],
    input.cashFlowStressMultipliers ?? [1],
  );

  const candidates: SensitivityScenario[] = [];
  for (const [weightIndex, weightItem] of weightScenarios.entries()) {
    for (const [startIndex, startDate] of startDateCandidates.entries()) {
      for (const [rebIndex, mode] of rebalanceModes.entries()) {
        const frequency = mode === "monthly" ? 1 : mode === "quarterly" ? 3 : mode === "semiannual" ? 6 : 12;
        const rebalance = buildRebalancePlan(startDate, input.endDate, mode, frequency);
        for (const [cashIndex, cash] of cashFlowPlans.entries()) {
          if (candidates.length >= limit) break;
          candidates.push({
            id: `s-${String(candidates.length + 1).padStart(4, "0")}`,
            startDate,
            baseWeights: weightItem.weights,
            rebalancePlan: rebalance,
            cashFlows: cash.cashFlows,
            label: `${weightItem.key}::${startDate}::${mode}::${cash.key}`,
            metadata: {
              weightScaleIndex: weightIndex,
              dateShiftIndex: startIndex,
              rebalanceIndex: rebIndex,
              cashFlowIndex: cashIndex,
            },
          });
        }
        if (candidates.length >= limit) break;
      }
      if (candidates.length >= limit) break;
    }
    if (candidates.length >= limit) break;
  }

  if (candidates.length === 0) {
    warnings.push("시나리오 조합이 생성되지 않아 기본값 단일 시나리오를 사용합니다.");
    const basePlan = buildRebalancePlan(input.baseStartDate, input.endDate, "none", 1, 5);
    candidates.push({
      id: "s-0001",
      startDate: input.baseStartDate,
      baseWeights,
      rebalancePlan: basePlan,
      cashFlows: (input.baseCashFlows ?? [])
        .filter((item) => isValidDateLike(item.date) && Number.isFinite(item.amount)),
      label: "base",
      metadata: {
        weightScaleIndex: 0,
        dateShiftIndex: 0,
        rebalanceIndex: 0,
        cashFlowIndex: 0,
      },
    });
  }

  const selectedScenarios = candidates.slice(0, limit);
  const outputs: SensitivityScenarioResult<T>[] = [];
  for (const scenario of selectedScenarios) {
    if (await input.isCancelled?.()) throw new Error("실행이 취소되었습니다.");
    const result = await evaluate(scenario);
    const score = input.metricSelector ? input.metricSelector(result as unknown) : null;
    outputs.push({ scenario, result, score, rank: 0 });
  }

  if (input.metricSelector) {
    const higherIsBetter = input.higherIsBetter ?? true;
    outputs.sort((left, right) => {
      const leftScore = left.score;
      const rightScore = right.score;
      if (leftScore === rightScore) return left.scenario.id.localeCompare(right.scenario.id);
      if (leftScore === null) return higherIsBetter ? 1 : -1;
      if (rightScore === null) return higherIsBetter ? -1 : 1;
      return higherIsBetter ? rightScore - leftScore : leftScore - rightScore;
    });
  }

  outputs.forEach((item, index) => {
    item.rank = index + 1;
  });

  return {
    baselineScenarioId: selectedScenarios[0]!.id,
    scenarios: outputs,
    warnings,
  };
}
