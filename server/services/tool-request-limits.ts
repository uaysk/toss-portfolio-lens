import { ServiceError } from "./service-envelope.js";

export type ToolRequestLimits = {
  maxAssets: number;
  maxDateRangeYears: number;
};

function dateRangeDays(from: unknown, to: unknown): number | undefined {
  if (typeof from !== "string" || typeof to !== "string") return undefined;
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  return Number.isFinite(start) && Number.isFinite(end) ? Math.floor((end - start) / 86_400_000) : undefined;
}

function shiftedDate(value: unknown, offsetDays: unknown): string | undefined {
  if (typeof value !== "string" || typeof offsetDays !== "number" || !Number.isFinite(offsetDays)) return undefined;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed)) return undefined;
  return new Date(parsed + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

function assertDateRange(from: unknown, to: unknown, limits: ToolRequestLimits, field: string): void {
  const days = dateRangeDays(from, to);
  if (days !== undefined && days > limits.maxDateRangeYears * 366) {
    throw new ServiceError({
      code: "DATE_RANGE_LIMIT",
      message: `요청 기간은 최대 ${limits.maxDateRangeYears}년입니다.`,
      retryable: false,
      field,
    });
  }
}

export function enforceToolRequestLimits(value: unknown, limits: ToolRequestLimits): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const input = value as Record<string, unknown>;
  const nested = input.baseConfig && typeof input.baseConfig === "object"
    ? input.baseConfig as Record<string, unknown>
    : undefined;
  const rootFrom = input.fromDate ?? input.startDate;
  const rootTo = input.toDate ?? input.endDate;
  if (rootFrom !== undefined || rootTo !== undefined) assertDateRange(rootFrom, rootTo, limits, "fromDate");
  if (nested) assertDateRange(nested.startDate, nested.endDate, limits, "baseConfig.startDate");

  if (nested && Array.isArray(input.scenarios)) {
    for (const [index, scenarioValue] of input.scenarios.entries()) {
      if (!scenarioValue || typeof scenarioValue !== "object" || Array.isArray(scenarioValue)) continue;
      const scenario = scenarioValue as Record<string, unknown>;
      assertDateRange(
        scenario.startDate ?? nested.startDate,
        scenario.endDate ?? nested.endDate,
        limits,
        `scenarios.${index}.startDate`,
      );
    }
  }

  if (nested && Array.isArray(input.offsetsDays)) {
    for (const [index, offset] of input.offsetsDays.entries()) {
      assertDateRange(
        shiftedDate(nested.startDate, offset),
        nested.endDate,
        limits,
        `offsetsDays.${index}`,
      );
    }
  }
  const weightedSymbols = [input.currentWeights, input.targetWeights]
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    .flatMap((item) => Object.keys(item));
  const researchSymbols = [input.baseSymbols, input.candidateSymbols]
    .filter((item): item is unknown[] => Array.isArray(item))
    .flat();
  const assets = Array.isArray(input.assets) ? input.assets
    : nested && Array.isArray(nested.assets) ? nested.assets
      : Array.isArray(input.symbols) ? input.symbols
        : researchSymbols.length ? Array.from(new Set(researchSymbols))
          : weightedSymbols.length ? Array.from(new Set(weightedSymbols)) : undefined;
  if (assets && assets.length > limits.maxAssets) {
    throw new ServiceError({
      code: "ASSET_LIMIT",
      message: `종목은 최대 ${limits.maxAssets}개까지 사용할 수 있습니다.`,
      retryable: false,
      field: "assets",
    });
  }
}
