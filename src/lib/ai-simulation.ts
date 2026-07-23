export const AI_SIMULATION_MARKETS = ["KR", "US"] as const;
export const AI_SIMULATION_CRITERIA = ["trading_amount", "volume", "volatility"] as const;
export const AI_SIMULATION_PRESETS = ["trend", "breakout", "mean_reversion", "risk_management"] as const;

export type AiSimulationMarketCountry = (typeof AI_SIMULATION_MARKETS)[number];
export type AiSimulationCriterion = (typeof AI_SIMULATION_CRITERIA)[number];
export type AiSimulationPreset = (typeof AI_SIMULATION_PRESETS)[number];

export type AiSimulationCosts = {
  commissionBpsPerSide: number;
  taxBpsOnExit: number;
  spreadBpsRoundTrip: number;
  slippageBpsPerSide: number;
};

export type AiSimulationRequest = {
  marketCountry: AiSimulationMarketCountry;
  criterion: AiSimulationCriterion;
  initialCash: number;
  durationMinutes: number;
  symbolCount: 1 | 2;
  preset: AiSimulationPreset;
  costs: AiSimulationCosts;
};

export type AiSimulationLimits = {
  minimumInitialCash?: number;
  maximumInitialCash?: number;
  minimumDurationMinutes?: number;
  maximumDurationMinutes?: number;
};

export type AiSimulationStatus = {
  enabled: boolean;
  message?: string;
  decisionIntervalSeconds?: number;
  limits: AiSimulationLimits;
  capabilities: Record<string, boolean | number | string>;
  limitations: string[];
};

export type AiSimulationSelection = {
  symbol: string;
  name?: string;
  score?: number;
  upProbability?: number;
  predictedMedianReturn?: number;
  model?: string;
};

export type AiSimulationPosition = {
  symbol: string;
  quantity: number;
  averagePrice: number;
  marketPrice?: number;
  unrealizedPnl?: number;
};

export type AiSimulationTrade = {
  symbol: string;
  side: "buy" | "sell" | string;
  executedAt: string;
  price: number;
  quantity: number;
  amount: number;
  cost: number;
  source?: string;
};

export type AiSimulationDecision = {
  symbol: string;
  action: string;
  decidedAt: string;
  eligibleAfter?: string;
  reason: string;
  score?: number;
  upProbability?: number;
  model?: string;
};

export type AiSimulationSnapshot = {
  phase: string;
  startedAt?: string;
  expiresAt?: string;
  marketCountry?: AiSimulationMarketCountry;
  currency: "KRW" | "USD";
  initialCash: number;
  cash: number;
  equity: number;
  progress: number;
  decisionIntervalSeconds?: number;
  selected: AiSimulationSelection[];
  positions: AiSimulationPosition[];
  trades: AiSimulationTrade[];
  decisions: AiSimulationDecision[];
  warnings: string[];
  capabilities: Record<string, boolean | number | string>;
};

export type AiSimulationRunResponse = {
  runId?: string;
  status: string;
  snapshot?: AiSimulationSnapshot;
  error?: string;
};

export const DEFAULT_AI_SIMULATION_REQUEST: AiSimulationRequest = {
  marketCountry: "KR",
  criterion: "trading_amount",
  initialCash: 10_000_000,
  durationMinutes: 60,
  symbolCount: 1,
  preset: "risk_management",
  costs: {
    commissionBpsPerSide: 1.5,
    taxBpsOnExit: 18,
    spreadBpsRoundTrip: 5,
    slippageBpsPerSide: 2,
  },
};

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function first(record: JsonRecord, ...keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) return record[key];
  }
  return undefined;
}

function finiteNumber(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(number) ? number : undefined;
}

function textValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(textValue).filter((item): item is string => Boolean(item))
    : [];
}

function capabilityRecord(value: unknown): Record<string, boolean | number | string> {
  return Object.fromEntries(
    Object.entries(asRecord(value)).filter((entry): entry is [string, boolean | number | string] => {
      const candidate = entry[1];
      return typeof candidate === "boolean"
        || typeof candidate === "string"
        || (typeof candidate === "number" && Number.isFinite(candidate));
    }),
  );
}

function modelLabel(value: unknown): string | undefined {
  const direct = textValue(value);
  if (direct) return direct;
  const model = asRecord(value);
  const id = textValue(first(model, "id", "name", "modelId", "model_id"));
  const version = textValue(first(
    model,
    "version",
    "revision",
    "modelVersion",
    "modelRevision",
    "model_version",
    "model_revision",
  ));
  if (!id) return version;
  return version ? `${id} · ${version}` : id;
}

export function normalizeAiSimulationStatus(payload: unknown): AiSimulationStatus {
  const root = asRecord(payload);
  const nested = asRecord(root.status);
  const source = Object.keys(nested).length ? { ...root, ...nested } : root;
  const limits = asRecord(source.limits);
  const initialCash = asRecord(first(limits, "initialCash", "initial_cash"));
  const duration = asRecord(first(limits, "durationMinutes", "duration_minutes", "duration"));
  const policy = asRecord(source.policy);
  const decisionIntervalSeconds = finiteNumber(first(
    policy,
    "decisionIntervalSeconds",
    "decision_interval_seconds",
  )) ?? finiteNumber(first(
    limits,
    "decisionIntervalSeconds",
    "decision_interval_seconds",
  ));
  const enabled = typeof source.enabled === "boolean" ? source.enabled : true;

  return {
    enabled,
    message: textValue(first(source, "message", "reason")),
    ...(decisionIntervalSeconds !== undefined ? { decisionIntervalSeconds } : {}),
    limits: {
      minimumInitialCash: finiteNumber(first(
        limits,
        "minimumInitialCash",
        "minimum_initial_cash",
        "minInitialCash",
        "min_initial_cash",
      )) ?? finiteNumber(first(initialCash, "minimum", "min")),
      maximumInitialCash: finiteNumber(first(
        limits,
        "maximumInitialCash",
        "maximum_initial_cash",
        "maxInitialCash",
        "max_initial_cash",
      )) ?? finiteNumber(first(initialCash, "maximum", "max")),
      minimumDurationMinutes: finiteNumber(first(
        limits,
        "minimumDurationMinutes",
        "minimum_duration_minutes",
        "minDurationMinutes",
        "min_duration_minutes",
      )) ?? finiteNumber(first(duration, "minimum", "min")),
      maximumDurationMinutes: finiteNumber(first(
        limits,
        "maximumDurationMinutes",
        "maximum_duration_minutes",
        "maxDurationMinutes",
        "max_duration_minutes",
      )) ?? finiteNumber(first(duration, "maximum", "max")),
    },
    capabilities: capabilityRecord(source.capabilities),
    limitations: stringList(first(source, "limitations", "warnings")),
  };
}

function normalizeSelection(value: unknown): AiSimulationSelection | undefined {
  const item = asRecord(value);
  const symbol = textValue(item.symbol);
  if (!symbol) return undefined;
  return {
    symbol,
    name: textValue(item.name),
    score: finiteNumber(item.score),
    upProbability: finiteNumber(first(item, "upProbability", "up_probability")),
    predictedMedianReturn: finiteNumber(first(
      item,
      "predictedMedianReturn",
      "predicted_median_return",
      "medianReturn",
      "median_return",
    )),
    model: modelLabel(item.model),
  };
}

function normalizePosition(value: unknown): AiSimulationPosition | undefined {
  const item = asRecord(value);
  const symbol = textValue(item.symbol);
  const quantity = finiteNumber(item.quantity);
  const averagePrice = finiteNumber(first(item, "averagePrice", "average_price"));
  if (!symbol || quantity === undefined || averagePrice === undefined) return undefined;
  return {
    symbol,
    quantity,
    averagePrice,
    marketPrice: finiteNumber(first(item, "marketPrice", "market_price")),
    unrealizedPnl: finiteNumber(first(item, "unrealizedPnl", "unrealized_pnl")),
  };
}

function normalizeTrade(value: unknown): AiSimulationTrade | undefined {
  const item = asRecord(value);
  const symbol = textValue(item.symbol);
  const side = textValue(item.side);
  const executedAt = textValue(first(item, "executedAt", "executed_at"));
  const price = finiteNumber(item.price);
  const quantity = finiteNumber(item.quantity);
  const amount = finiteNumber(first(item, "amount", "grossAmount", "gross_amount"));
  const cost = finiteNumber(first(item, "cost", "totalCosts", "total_costs"));
  if (!symbol || !side || !executedAt || price === undefined || quantity === undefined || amount === undefined || cost === undefined) {
    return undefined;
  }
  return {
    symbol,
    side,
    executedAt,
    price,
    quantity,
    amount,
    cost,
    source: textValue(item.source),
  };
}

function normalizeDecision(value: unknown): AiSimulationDecision | undefined {
  const item = asRecord(value);
  const symbol = textValue(item.symbol);
  const action = textValue(item.action);
  const decidedAt = textValue(first(
    item,
    "decidedAt",
    "decided_at",
    "forecastGeneratedAt",
    "forecast_generated_at",
    "inputEndAt",
    "input_end_at",
  ));
  const listedReason = stringList(item.reasons).join(" · ");
  const reason = textValue(item.reason) ?? (listedReason || undefined);
  if (!symbol || !action || !decidedAt || !reason) return undefined;
  return {
    symbol,
    action,
    decidedAt,
    eligibleAfter: textValue(first(item, "eligibleAfter", "eligible_after")),
    reason,
    score: finiteNumber(item.score),
    upProbability: finiteNumber(first(item, "upProbability", "up_probability")),
    model: modelLabel(item.model),
  };
}

function mapValid<T>(value: unknown, normalizer: (item: unknown) => T | undefined): T[] {
  const values = Array.isArray(value)
    ? value
    : Object.values(asRecord(value));
  return values.map(normalizer).filter((item): item is T => item !== undefined);
}

export function normalizeAiSimulationSnapshot(payload: unknown): AiSimulationSnapshot {
  const outer = asRecord(payload);
  const source = Object.keys(asRecord(outer.snapshot)).length ? asRecord(outer.snapshot) : outer;
  const market = textValue(first(source, "marketCountry", "market_country"));
  const currency = textValue(source.currency);
  const rawProgress = finiteNumber(source.progress) ?? 0;
  const decisionIntervalSeconds = finiteNumber(first(
    source,
    "decisionIntervalSeconds",
    "decision_interval_seconds",
  ));

  return {
    phase: textValue(source.phase) ?? "queued",
    startedAt: textValue(first(source, "startedAt", "started_at")),
    expiresAt: textValue(first(source, "expiresAt", "expires_at")),
    marketCountry: market === "KR" || market === "US" ? market : undefined,
    currency: currency === "USD" ? "USD" : "KRW",
    initialCash: finiteNumber(first(source, "initialCash", "initial_cash")) ?? 0,
    cash: finiteNumber(source.cash) ?? 0,
    equity: finiteNumber(source.equity) ?? 0,
    progress: Math.max(0, Math.min(1, rawProgress)),
    ...(decisionIntervalSeconds !== undefined ? { decisionIntervalSeconds } : {}),
    selected: mapValid(source.selected, normalizeSelection),
    positions: mapValid(source.positions, normalizePosition),
    trades: mapValid(source.trades, normalizeTrade),
    decisions: mapValid(source.decisions, normalizeDecision),
    warnings: stringList(source.warnings),
    capabilities: capabilityRecord(source.capabilities),
  };
}

export function normalizeAiSimulationRun(payload: unknown): AiSimulationRunResponse {
  const root = asRecord(payload);
  const run = asRecord(root.run);
  const snapshotValue = root.snapshot;
  const hasSnapshot = Object.keys(asRecord(snapshotValue)).length > 0;
  const error = asRecord(root.error ?? run.error);
  return {
    runId: textValue(first(root, "runId", "run_id"))
      ?? textValue(first(run, "id", "runId", "run_id")),
    status: textValue(root.status)
      ?? textValue(run.status)
      ?? (hasSnapshot ? normalizeAiSimulationSnapshot(snapshotValue).phase : "queued"),
    snapshot: hasSnapshot ? normalizeAiSimulationSnapshot(snapshotValue) : undefined,
    error: textValue(first(error, "message", "reason"))
      ?? textValue(root.error)
      ?? textValue(run.error)
      ?? textValue(first(root, "errorMessage", "error_message")),
  };
}

export function aiSimulationErrorMessage(payload: unknown, fallback: string): string {
  const root = asRecord(payload);
  const error = asRecord(root.error);
  return textValue(first(error, "message", "detail", "reason"))
    ?? textValue(first(root, "message", "reason"))
    ?? fallback;
}

export function validateAiSimulationRequest(
  request: AiSimulationRequest,
  limits: AiSimulationLimits = {},
): string[] {
  const issues: string[] = [];
  if (!AI_SIMULATION_MARKETS.includes(request.marketCountry)) issues.push("시장 선택이 올바르지 않습니다.");
  if (!AI_SIMULATION_CRITERIA.includes(request.criterion)) issues.push("종목 선정 기준이 올바르지 않습니다.");
  if (!AI_SIMULATION_PRESETS.includes(request.preset)) issues.push("AI 전략 프리셋이 올바르지 않습니다.");

  if (!Number.isFinite(request.initialCash) || request.initialCash <= 0) {
    issues.push("예수금은 0보다 큰 숫자여야 합니다.");
  } else {
    if (limits.minimumInitialCash !== undefined && request.initialCash < limits.minimumInitialCash) {
      issues.push(`예수금은 ${limits.minimumInitialCash} 이상이어야 합니다.`);
    }
    if (limits.maximumInitialCash !== undefined && request.initialCash > limits.maximumInitialCash) {
      issues.push(`예수금은 ${limits.maximumInitialCash} 이하여야 합니다.`);
    }
  }

  if (!Number.isInteger(request.durationMinutes) || request.durationMinutes <= 0) {
    issues.push("테스트 기간은 1분 이상의 정수여야 합니다.");
  } else {
    if (limits.minimumDurationMinutes !== undefined && request.durationMinutes < limits.minimumDurationMinutes) {
      issues.push(`테스트 기간은 ${limits.minimumDurationMinutes}분 이상이어야 합니다.`);
    }
    if (limits.maximumDurationMinutes !== undefined && request.durationMinutes > limits.maximumDurationMinutes) {
      issues.push(`테스트 기간은 ${limits.maximumDurationMinutes}분 이하여야 합니다.`);
    }
  }

  if (request.symbolCount !== 1 && request.symbolCount !== 2) {
    issues.push("AI 선정 종목 수는 1개 또는 2개여야 합니다.");
  }

  const costLabels: Array<[keyof AiSimulationCosts, string]> = [
    ["commissionBpsPerSide", "편도 수수료"],
    ["taxBpsOnExit", "청산 세금"],
    ["spreadBpsRoundTrip", "왕복 스프레드"],
    ["slippageBpsPerSide", "편도 슬리피지"],
  ];
  for (const [key, label] of costLabels) {
    if (!Number.isFinite(request.costs[key]) || request.costs[key] < 0) {
      issues.push(`${label} bps는 0 이상의 숫자여야 합니다.`);
    }
  }
  return issues;
}
