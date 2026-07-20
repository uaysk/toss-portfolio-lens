import {
  TECHNICAL_INDICATOR_BY_KIND,
  type TechnicalAnalysisRequest,
  type TechnicalIndicatorDefinition,
  type TechnicalIndicatorPrimitive,
} from "@/lib/technical-analysis";
import type { BacktestResult, BacktestRunConfiguration } from "@/types";

export const TECHNICAL_STRATEGY_SCHEMA_VERSION = "technical-strategy/v1" as const;
export const TECHNICAL_STRATEGY_PRESET_TYPE = "technical_signal_strategy" as const;
export const MAX_TECHNICAL_STRATEGY_SYMBOLS = 20;
export const MAX_TECHNICAL_CONDITION_DEPTH = 8;
export const MAX_TECHNICAL_CONDITION_NODES = 128;

export type TechnicalStrategyState = "active" | "inactive";
export type TechnicalBarField = "open" | "high" | "low" | "close" | "volume";

export type TechnicalIndicatorOperand = {
  type: "indicator";
  instrumentKey: string;
  indicatorId: string;
  field: string;
};

export type TechnicalBarOperand = {
  type: "bar";
  instrumentKey: string;
  field: TechnicalBarField;
};

export type TechnicalConstantOperand = {
  type: "constant";
  value: number;
};

export type TechnicalConditionOperand = TechnicalIndicatorOperand | TechnicalBarOperand | TechnicalConstantOperand;

export type TechnicalComparisonCondition = {
  operator: "greater_than" | "less_than" | "crosses_above" | "crosses_below";
  left: TechnicalConditionOperand;
  right: TechnicalConditionOperand;
};

export type TechnicalBetweenCondition = {
  operator: "between";
  value: TechnicalConditionOperand;
  lower: TechnicalConditionOperand;
  upper: TechnicalConditionOperand;
};

export type TechnicalLogicalCondition = {
  operator: "all" | "any";
  conditions: TechnicalCondition[];
};

export type TechnicalNotCondition = {
  operator: "not";
  condition: TechnicalCondition;
};

export type TechnicalCondition = TechnicalComparisonCondition | TechnicalBetweenCondition | TechnicalLogicalCondition | TechnicalNotCondition;

export type TechnicalStrategyAllocation = {
  weights: Record<string, number>;
  cashPercent: number;
};

export type TechnicalStrategy = {
  schemaVersion: typeof TECHNICAL_STRATEGY_SCHEMA_VERSION;
  id: string;
  entryCondition: TechnicalCondition;
  exitCondition: TechnicalCondition;
  minimumHoldingPeriod: number;
  cooldownPeriod: number;
  initialState: TechnicalStrategyState;
  allocations: {
    active: TechnicalStrategyAllocation;
    inactive: TechnicalStrategyAllocation;
  };
};

export type TechnicalStrategyAnalysis = Omit<TechnicalAnalysisRequest, "responseMode"> & {
  responseMode: "full_series";
};

export type TechnicalStrategyHandoff = {
  accountId: string;
  analysis: TechnicalStrategyAnalysis;
  strategy: TechnicalStrategy;
};

export type TechnicalStrategyPresetConfig = {
  schemaVersion: 1;
  presetType: typeof TECHNICAL_STRATEGY_PRESET_TYPE;
  analysis: TechnicalStrategyAnalysis;
  strategy: TechnicalStrategy;
};

export type TechnicalStrategyValidationResult = {
  valid: boolean;
  errors: Array<string | { path?: string; message?: string }>;
  warnings?: string[];
  availability?: unknown;
};

export type TechnicalStrategySignal = {
  signal_id: string;
  calculation_date: string;
  signal_date: string;
  planned_trade_date: string | null;
  actual_application_date: string | null;
  transition?: string;
  from_state: TechnicalStrategyState;
  to_state: TechnicalStrategyState;
  target_weights: Record<string, number>;
  cash_target_percent: number;
  status: "planned" | "applied" | "no_safe_trade_date" | string;
};

export type TechnicalStrategyRunPayload = {
  run_id?: string;
  reused?: boolean;
  technical_analysis?: unknown;
  technical_strategy: {
    signals: TechnicalStrategySignal[];
    target_weight_schedule?: unknown[];
    [key: string]: unknown;
  };
  backtest?: BacktestResult;
  artifact_index?: Array<Record<string, unknown>>;
};

export function technicalSignalStatusLabel(status: TechnicalStrategySignal["status"]): string {
  switch (status) {
    case "planned": return "거래 예정";
    case "applied": return "ledger 적용";
    case "no_safe_trade_date": return "안전 거래일 없음";
    default: return status;
  }
}

export type TechnicalStrategyEndpointRequest = {
  analysis: TechnicalStrategyAnalysis;
  strategy: TechnicalStrategy;
  backtest: BacktestRunConfiguration;
};

export type TechnicalIndicatorReferenceOption = {
  instrumentKey: string;
  indicatorId: string;
  kind: TechnicalIndicatorDefinition["kind"];
  field: string;
  label: string;
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function date(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function symbol(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z0-9.-]{1,32}$/.test(value);
}

function primitive(value: unknown): value is TechnicalIndicatorPrimitive {
  return value === null || typeof value === "string" || typeof value === "boolean" || finite(value);
}

function normalizeIndicatorDefinition(value: unknown, symbols: ReadonlySet<string>): TechnicalIndicatorDefinition | undefined {
  const item = record(value);
  if (!item || typeof item.id !== "string" || !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(item.id)) return undefined;
  if (typeof item.kind !== "string" || item.kind === "volume_profile" || !TECHNICAL_INDICATOR_BY_KIND.has(item.kind as TechnicalIndicatorDefinition["kind"])) return undefined;
  const parameters = item.parameters === undefined ? undefined : record(item.parameters);
  if (item.parameters !== undefined && (!parameters || Object.keys(parameters).length > 32 || Object.values(parameters).some((entry) => !primitive(entry)))) return undefined;
  const rawInstrumentKeys = Array.isArray(item.instrumentKeys) ? item.instrumentKeys : undefined;
  const instrumentKeys = item.instrumentKeys === undefined ? undefined : rawInstrumentKeys
    ? rawInstrumentKeys.filter(symbol)
    : undefined;
  if (item.instrumentKeys !== undefined && (!instrumentKeys?.length || instrumentKeys.length !== rawInstrumentKeys?.length
    || new Set(instrumentKeys).size !== instrumentKeys.length || instrumentKeys.some((key) => !symbols.has(key)))) return undefined;
  return {
    id: item.id,
    kind: item.kind as TechnicalIndicatorDefinition["kind"],
    ...(parameters ? { parameters: parameters as Record<string, TechnicalIndicatorPrimitive> } : {}),
    ...(instrumentKeys ? { instrumentKeys } : {}),
  };
}

export function normalizeTechnicalStrategyAnalysis(value: unknown): TechnicalStrategyAnalysis | undefined {
  const item = record(value);
  if (!item || !Array.isArray(item.symbols) || item.symbols.length < 1 || item.symbols.length > MAX_TECHNICAL_STRATEGY_SYMBOLS) return undefined;
  const symbols = item.symbols.filter(symbol);
  if (symbols.length !== item.symbols.length || new Set(symbols).size !== symbols.length) return undefined;
  if (!date(item.fromDate) || !date(item.toDate) || item.fromDate > item.toDate) return undefined;
  if (item.interval !== "1d" && item.interval !== "1w") return undefined;
  if (typeof item.adjusted !== "boolean" || (item.currencyMode !== "local" && item.currencyMode !== "KRW")) return undefined;
  if (item.responseMode !== "full_series" || !Array.isArray(item.indicators) || item.indicators.length < 1 || item.indicators.length > 64) return undefined;
  const symbolSet = new Set(symbols);
  const indicators = item.indicators.map((definition) => normalizeIndicatorDefinition(definition, symbolSet));
  if (indicators.some((definition) => definition === undefined)) return undefined;
  const typedIndicators = indicators as TechnicalIndicatorDefinition[];
  if (new Set(typedIndicators.map((definition) => definition.id)).size !== typedIndicators.length) return undefined;
  return {
    symbols,
    fromDate: item.fromDate,
    toDate: item.toDate,
    interval: item.interval,
    adjusted: item.adjusted,
    currencyMode: item.currencyMode,
    responseMode: "full_series",
    indicators: typedIndicators,
  };
}

export function technicalIndicatorReferenceOptions(analysis: TechnicalStrategyAnalysis): TechnicalIndicatorReferenceOption[] {
  return analysis.indicators.flatMap((definition) => {
    const option = TECHNICAL_INDICATOR_BY_KIND.get(definition.kind);
    if (!option || definition.kind === "volume_profile") return [];
    const targets = definition.instrumentKeys ?? analysis.symbols;
    return targets.flatMap((instrumentKey) => option.outputFields.map((field) => ({
      instrumentKey,
      indicatorId: definition.id,
      kind: definition.kind,
      field,
      label: `${instrumentKey} · ${option.shortLabel} · ${field}`,
    })));
  });
}

export function technicalConditionNodeCount(condition: TechnicalCondition): number {
  if (condition.operator === "all" || condition.operator === "any") {
    return 1 + condition.conditions.reduce((sum, child) => sum + technicalConditionNodeCount(child), 0);
  }
  if (condition.operator === "not") return 1 + technicalConditionNodeCount(condition.condition);
  return 1;
}

export function technicalConditionDepth(condition: TechnicalCondition): number {
  if (condition.operator === "all" || condition.operator === "any") {
    return 1 + Math.max(0, ...condition.conditions.map(technicalConditionDepth));
  }
  if (condition.operator === "not") return 1 + technicalConditionDepth(condition.condition);
  return 1;
}

function normalizeOperand(value: unknown): TechnicalConditionOperand | undefined {
  const item = record(value);
  if (!item || typeof item.type !== "string") return undefined;
  if (item.type === "constant") return finite(item.value) ? { type: "constant", value: item.value } : undefined;
  if (item.type === "bar") {
    return symbol(item.instrumentKey) && ["open", "high", "low", "close", "volume"].includes(String(item.field))
      ? { type: "bar", instrumentKey: item.instrumentKey, field: item.field as TechnicalBarField }
      : undefined;
  }
  if (item.type === "indicator") {
    return symbol(item.instrumentKey) && typeof item.indicatorId === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(item.indicatorId)
      && typeof item.field === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(item.field)
      ? { type: "indicator", instrumentKey: item.instrumentKey, indicatorId: item.indicatorId, field: item.field }
      : undefined;
  }
  return undefined;
}

function normalizeCondition(value: unknown, depth = 1, count = { value: 0 }): TechnicalCondition | undefined {
  if (depth > MAX_TECHNICAL_CONDITION_DEPTH || count.value >= MAX_TECHNICAL_CONDITION_NODES) return undefined;
  const item = record(value);
  if (!item || typeof item.operator !== "string") return undefined;
  count.value += 1;
  if (["greater_than", "less_than", "crosses_above", "crosses_below"].includes(item.operator)) {
    const left = normalizeOperand(item.left);
    const right = normalizeOperand(item.right);
    return left && right ? { operator: item.operator as TechnicalComparisonCondition["operator"], left, right } : undefined;
  }
  if (item.operator === "between") {
    const target = normalizeOperand(item.value);
    const lower = normalizeOperand(item.lower);
    const upper = normalizeOperand(item.upper);
    return target && lower && upper ? { operator: "between", value: target, lower, upper } : undefined;
  }
  if (item.operator === "all" || item.operator === "any") {
    if (!Array.isArray(item.conditions) || item.conditions.length < 1 || item.conditions.length > 32) return undefined;
    const conditions = item.conditions.map((condition) => normalizeCondition(condition, depth + 1, count));
    return conditions.some((condition) => condition === undefined)
      ? undefined
      : { operator: item.operator, conditions: conditions as TechnicalCondition[] };
  }
  if (item.operator === "not") {
    const condition = normalizeCondition(item.condition, depth + 1, count);
    return condition ? { operator: "not", condition } : undefined;
  }
  return undefined;
}

function normalizeAllocation(value: unknown, symbols: readonly string[]): TechnicalStrategyAllocation | undefined {
  const item = record(value);
  const weights = record(item?.weights);
  if (!item || !weights || !finite(item.cashPercent) || item.cashPercent < 0 || item.cashPercent > 100) return undefined;
  if (Object.keys(weights).length !== symbols.length || symbols.some((key) => !finite(weights[key]) || Number(weights[key]) < 0 || Number(weights[key]) > 100)) return undefined;
  if (Object.keys(weights).some((key) => !symbols.includes(key))) return undefined;
  const normalizedWeights = Object.fromEntries(symbols.map((key) => [key, Number(weights[key])]));
  const total = Object.values(normalizedWeights).reduce((sum, weight) => sum + weight, 0) + item.cashPercent;
  return Math.abs(total - 100) <= 0.01 ? { weights: normalizedWeights, cashPercent: item.cashPercent } : undefined;
}

export function normalizeTechnicalStrategy(value: unknown, symbols: readonly string[]): TechnicalStrategy | undefined {
  const item = record(value);
  if (!item || item.schemaVersion !== TECHNICAL_STRATEGY_SCHEMA_VERSION || typeof item.id !== "string" || !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(item.id)) return undefined;
  const entryCondition = normalizeCondition(item.entryCondition);
  const exitCondition = normalizeCondition(item.exitCondition);
  if (!entryCondition || !exitCondition) return undefined;
  if (!Number.isSafeInteger(item.minimumHoldingPeriod) || Number(item.minimumHoldingPeriod) < 0 || Number(item.minimumHoldingPeriod) > 10_000) return undefined;
  if (!Number.isSafeInteger(item.cooldownPeriod) || Number(item.cooldownPeriod) < 0 || Number(item.cooldownPeriod) > 10_000) return undefined;
  if (item.initialState !== "active" && item.initialState !== "inactive") return undefined;
  const allocations = record(item.allocations);
  const active = normalizeAllocation(allocations?.active, symbols);
  const inactive = normalizeAllocation(allocations?.inactive, symbols);
  if (!active || !inactive) return undefined;
  return {
    schemaVersion: TECHNICAL_STRATEGY_SCHEMA_VERSION,
    id: item.id,
    entryCondition,
    exitCondition,
    minimumHoldingPeriod: Number(item.minimumHoldingPeriod),
    cooldownPeriod: Number(item.cooldownPeriod),
    initialState: item.initialState,
    allocations: { active, inactive },
  };
}

export function normalizeTechnicalStrategyPresetConfig(value: unknown): TechnicalStrategyPresetConfig | undefined {
  const item = record(value);
  if (!item || item.schemaVersion !== 1 || item.presetType !== TECHNICAL_STRATEGY_PRESET_TYPE) return undefined;
  const analysis = normalizeTechnicalStrategyAnalysis(item.analysis);
  if (!analysis) return undefined;
  const strategy = normalizeTechnicalStrategy(item.strategy, analysis.symbols);
  return strategy ? { schemaVersion: 1, presetType: TECHNICAL_STRATEGY_PRESET_TYPE, analysis, strategy } : undefined;
}

function operandErrors(
  operand: TechnicalConditionOperand,
  analysis: TechnicalStrategyAnalysis,
  references: ReadonlySet<string>,
  path: string,
): string[] {
  if (operand.type === "constant") return finite(operand.value) ? [] : [`${path}: 상수는 유한한 숫자여야 합니다.`];
  if (!analysis.symbols.includes(operand.instrumentKey)) return [`${path}: 전략 종목에 없는 instrumentKey입니다.`];
  if (operand.type === "bar") return ["open", "high", "low", "close", "volume"].includes(operand.field) ? [] : [`${path}: 지원하지 않는 bar field입니다.`];
  return references.has(`${operand.instrumentKey}\u0000${operand.indicatorId}\u0000${operand.field}`)
    ? []
    : [`${path}: 선택한 종목·지표에 없는 출력 참조입니다.`];
}

function conditionErrors(
  condition: TechnicalCondition,
  analysis: TechnicalStrategyAnalysis,
  references: ReadonlySet<string>,
  path: string,
): string[] {
  if (condition.operator === "all" || condition.operator === "any") {
    if (!condition.conditions.length) return [`${path}: ${condition.operator}에는 한 개 이상의 하위 조건이 필요합니다.`];
    return condition.conditions.flatMap((child, index) => conditionErrors(child, analysis, references, `${path}.conditions[${index}]`));
  }
  if (condition.operator === "not") return conditionErrors(condition.condition, analysis, references, `${path}.condition`);
  if (condition.operator === "between") {
    const errors = [
      ...operandErrors(condition.value, analysis, references, `${path}.value`),
      ...operandErrors(condition.lower, analysis, references, `${path}.lower`),
      ...operandErrors(condition.upper, analysis, references, `${path}.upper`),
    ];
    if (condition.lower.type === "constant" && condition.upper.type === "constant" && condition.lower.value >= condition.upper.value) {
      errors.push(`${path}: between 하한은 상한보다 작아야 합니다.`);
    }
    return errors;
  }
  if ("left" in condition) {
    return [
      ...operandErrors(condition.left, analysis, references, `${path}.left`),
      ...operandErrors(condition.right, analysis, references, `${path}.right`),
    ];
  }
  return [`${path}: 지원하지 않는 조건입니다.`];
}

export function validateTechnicalStrategyDraft(analysis: TechnicalStrategyAnalysis, strategy: TechnicalStrategy): string[] {
  const errors: string[] = [];
  if (analysis.symbols.length > MAX_TECHNICAL_STRATEGY_SYMBOLS) errors.push(`기술 신호 백테스트는 최대 ${MAX_TECHNICAL_STRATEGY_SYMBOLS}개 종목을 지원합니다.`);
  if (!analysis.indicators.length) errors.push("한 개 이상의 지표 정의가 필요합니다.");
  if (analysis.indicators.some((indicator) => indicator.kind === "volume_profile")) errors.push("Volume Profile은 시계열 조건 지표로 사용할 수 없습니다.");
  const referenceSet = new Set(technicalIndicatorReferenceOptions(analysis).map((option) => `${option.instrumentKey}\u0000${option.indicatorId}\u0000${option.field}`));
  errors.push(...conditionErrors(strategy.entryCondition, analysis, referenceSet, "entryCondition"));
  errors.push(...conditionErrors(strategy.exitCondition, analysis, referenceSet, "exitCondition"));
  for (const [name, condition] of [["entryCondition", strategy.entryCondition], ["exitCondition", strategy.exitCondition]] as const) {
    if (technicalConditionDepth(condition) > MAX_TECHNICAL_CONDITION_DEPTH) errors.push(`${name}: 조건 깊이는 ${MAX_TECHNICAL_CONDITION_DEPTH} 이하여야 합니다.`);
    if (technicalConditionNodeCount(condition) > MAX_TECHNICAL_CONDITION_NODES) errors.push(`${name}: 조건 노드는 ${MAX_TECHNICAL_CONDITION_NODES}개 이하여야 합니다.`);
  }
  if (!Number.isSafeInteger(strategy.minimumHoldingPeriod) || strategy.minimumHoldingPeriod < 0 || strategy.minimumHoldingPeriod > 10_000) errors.push("최소 보유 기간은 0~10,000의 정수여야 합니다.");
  if (!Number.isSafeInteger(strategy.cooldownPeriod) || strategy.cooldownPeriod < 0 || strategy.cooldownPeriod > 10_000) errors.push("cooldown은 0~10,000의 정수여야 합니다.");
  for (const state of ["active", "inactive"] as const) {
    const allocation = strategy.allocations[state];
    const keys = Object.keys(allocation.weights);
    if (keys.length !== analysis.symbols.length || keys.some((key) => !analysis.symbols.includes(key)) || analysis.symbols.some((key) => !Object.hasOwn(allocation.weights, key))) {
      errors.push(`${state} allocation은 전략 종목을 빠짐없이 정확히 포함해야 합니다.`);
      continue;
    }
    const values = Object.values(allocation.weights);
    if (values.some((weight) => !finite(weight) || weight < 0 || weight > 100) || !finite(allocation.cashPercent) || allocation.cashPercent < 0 || allocation.cashPercent > 100) {
      errors.push(`${state} allocation 비중은 0~100의 유한한 값이어야 합니다.`);
      continue;
    }
    const total = values.reduce((sum, weight) => sum + weight, 0) + allocation.cashPercent;
    if (Math.abs(total - 100) > 0.01) errors.push(`${state} 종목 비중과 현금 비중 합계는 100%여야 합니다.`);
  }
  return Array.from(new Set(errors));
}

export function defaultTechnicalCondition(analysis: TechnicalStrategyAnalysis, operator: TechnicalComparisonCondition["operator"] = "greater_than"): TechnicalComparisonCondition {
  const reference = technicalIndicatorReferenceOptions(analysis)[0];
  const left: TechnicalConditionOperand = reference
    ? { type: "indicator", instrumentKey: reference.instrumentKey, indicatorId: reference.indicatorId, field: reference.field }
    : { type: "bar", instrumentKey: analysis.symbols[0] ?? "UNKNOWN", field: "close" };
  return { operator, left, right: { type: "constant", value: 0 } };
}

export function createDefaultTechnicalStrategy(
  analysis: TechnicalStrategyAnalysis,
  activeWeights?: Readonly<Record<string, number | undefined>>,
): TechnicalStrategy {
  const provided = analysis.symbols.map((key) => finite(activeWeights?.[key]) && Number(activeWeights?.[key]) >= 0 ? Number(activeWeights?.[key]) : 0);
  const providedTotal = provided.reduce((sum, weight) => sum + weight, 0);
  const useProvided = providedTotal > 0 && providedTotal <= 100.01;
  const equal = analysis.symbols.length ? 100 / analysis.symbols.length : 0;
  const active = Object.fromEntries(analysis.symbols.map((key, index) => [key, useProvided ? provided[index] : equal]));
  const activeTotal = Object.values(active).reduce((sum, weight) => sum + weight, 0);
  return {
    schemaVersion: TECHNICAL_STRATEGY_SCHEMA_VERSION,
    id: "technical-signal-primary",
    entryCondition: defaultTechnicalCondition(analysis, "greater_than"),
    exitCondition: defaultTechnicalCondition(analysis, "less_than"),
    minimumHoldingPeriod: 0,
    cooldownPeriod: 0,
    initialState: "active",
    allocations: {
      active: { weights: active, cashPercent: Math.max(0, 100 - activeTotal) },
      inactive: { weights: Object.fromEntries(analysis.symbols.map((key) => [key, 0])), cashPercent: 100 },
    },
  };
}

export function subsetTechnicalStrategyAnalysis(
  analysis: TechnicalStrategyAnalysis,
  selectedSymbols: readonly string[],
): TechnicalStrategyAnalysis | undefined {
  if (selectedSymbols.length > MAX_TECHNICAL_STRATEGY_SYMBOLS) return undefined;
  const symbols = reconcileTechnicalStrategySelection(selectedSymbols, analysis.symbols);
  if (technicalStrategySubsetIssue(analysis, symbols)) return undefined;
  const selected = new Set(symbols);
  const indicators = analysis.indicators.flatMap((definition): TechnicalIndicatorDefinition[] => {
    const targets = definition.instrumentKeys?.filter((key) => selected.has(key));
    if (definition.instrumentKeys && !targets?.length) return [];
    return [{ ...definition, ...(targets && targets.length < symbols.length ? { instrumentKeys: targets } : { instrumentKeys: undefined }) }];
  }).map((definition) => {
    if (definition.instrumentKeys === undefined) {
      const { instrumentKeys: _instrumentKeys, ...rest } = definition;
      return rest;
    }
    return definition;
  });
  if (!indicators.length) return undefined;
  return { ...analysis, symbols, indicators };
}

export function reconcileTechnicalStrategySelection(
  selectedSymbols: readonly string[],
  availableSymbols: readonly string[],
): string[] {
  const available = new Set(availableSymbols.map((symbol) => symbol.trim().toUpperCase()).filter(Boolean));
  return Array.from(new Set(selectedSymbols
    .map((symbol) => symbol.trim().toUpperCase())
    .filter((symbol) => available.has(symbol))))
    .slice(0, MAX_TECHNICAL_STRATEGY_SYMBOLS);
}

export function technicalStrategySubsetIssue(
  analysis: TechnicalStrategyAnalysis,
  selectedSymbols: readonly string[],
): string | undefined {
  const symbols = reconcileTechnicalStrategySelection(selectedSymbols, analysis.symbols);
  if (!symbols.length) return "한 개 이상의 전략 종목을 선택해 주세요.";
  if (selectedSymbols.length > MAX_TECHNICAL_STRATEGY_SYMBOLS) return `기술 신호 백테스트는 최대 ${MAX_TECHNICAL_STRATEGY_SYMBOLS}개 종목을 지원합니다.`;
  const selected = new Set(symbols);
  const missingBenchmarks = Array.from(new Set(analysis.indicators.flatMap((indicator) => {
    if (indicator.kind !== "benchmark_relative_strength") return [];
    const benchmarkKey = indicator.parameters?.benchmark_key;
    return typeof benchmarkKey === "string" && benchmarkKey && !selected.has(benchmarkKey) ? [benchmarkKey] : [];
  })));
  if (missingBenchmarks.length) {
    return `벤치마크 상대강도 계산에 필요한 ${missingBenchmarks.join(", ")} 종목을 전략 선택에 포함해 주세요.`;
  }
  return undefined;
}

export function defaultTechnicalStrategyAnalysisSubset(
  analysis: TechnicalStrategyAnalysis,
): TechnicalStrategyAnalysis | undefined {
  const required = Array.from(new Set(analysis.indicators.flatMap((indicator) => {
    const benchmarkKey = indicator.kind === "benchmark_relative_strength" ? indicator.parameters?.benchmark_key : undefined;
    return typeof benchmarkKey === "string" && analysis.symbols.includes(benchmarkKey) ? [benchmarkKey] : [];
  })));
  const symbols = [...required, ...analysis.symbols.filter((symbol) => !required.includes(symbol))]
    .slice(0, MAX_TECHNICAL_STRATEGY_SYMBOLS);
  return subsetTechnicalStrategyAnalysis(analysis, symbols);
}

export function technicalStrategySourceMatchesBacktest(
  analysis: TechnicalStrategyAnalysis | undefined,
  input: { symbols: readonly string[]; startDate: string; endDate: string; currencyMode: "local" | "KRW" },
): boolean {
  return Boolean(analysis
    && analysis.fromDate <= input.startDate
    && analysis.toDate === input.endDate
    && analysis.currencyMode === input.currencyMode
    && analysis.symbols.length === input.symbols.length
    && analysis.symbols.every((symbol) => input.symbols.includes(symbol)));
}

export function buildTechnicalStrategyEndpointRequest(input: TechnicalStrategyEndpointRequest): TechnicalStrategyEndpointRequest {
  return {
    analysis: { ...input.analysis, responseMode: "full_series" },
    strategy: input.strategy,
    backtest: {
      ...input.backtest,
      rebalanceFrequency: "none",
      targetWeightSchedule: [],
    },
  };
}

export function technicalStrategyFingerprint(analysis: TechnicalStrategyAnalysis, strategy: TechnicalStrategy): string {
  return JSON.stringify({ analysis, strategy });
}

export function unwrapTechnicalStrategyValidation(value: unknown): TechnicalStrategyValidationResult | undefined {
  const outer = record(value);
  const candidate = record(outer?.result) ?? outer;
  return candidate && typeof candidate.valid === "boolean" && Array.isArray(candidate.errors)
    ? candidate as unknown as TechnicalStrategyValidationResult
    : undefined;
}

export function unwrapTechnicalStrategyRun(value: unknown): TechnicalStrategyRunPayload | undefined {
  const outer = record(value);
  const candidate = record(outer?.result) ?? outer;
  return candidate && record(candidate.technical_strategy) && Array.isArray(record(candidate.technical_strategy)?.signals)
    ? candidate as unknown as TechnicalStrategyRunPayload
    : undefined;
}
