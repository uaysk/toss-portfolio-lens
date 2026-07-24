export const AI_SIMULATION_MARKETS = ["KR", "US"] as const;
export const AI_SIMULATION_CRITERIA = ["trading_amount", "volume", "volatility"] as const;
export const AI_SIMULATION_PRESETS = ["trend", "breakout", "mean_reversion", "risk_management"] as const;
export const AI_SIMULATION_SELECTION_MODES = ["auto", "manual"] as const;

export type AiSimulationMarketCountry = (typeof AI_SIMULATION_MARKETS)[number];
export type AiSimulationCriterion = (typeof AI_SIMULATION_CRITERIA)[number];
export type AiSimulationPreset = (typeof AI_SIMULATION_PRESETS)[number];
export type AiSimulationSelectionMode = (typeof AI_SIMULATION_SELECTION_MODES)[number];

export type AiSimulationSelectionRequest =
  | {
      mode: "auto";
      criterion: AiSimulationCriterion;
      symbolCount: 1 | 2;
    }
  | {
      mode: "manual";
      symbols: string[];
    };

export type AiSimulationCosts = {
  commissionBpsPerSide: number;
  taxBpsOnExit: number;
  spreadBpsRoundTrip: number;
  slippageBpsPerSide: number;
};

export type AiSimulationRequest = {
  marketCountry: AiSimulationMarketCountry;
  initialCash: number;
  durationMinutes: number;
  preset: AiSimulationPreset;
  riskTolerance: number;
  selection: AiSimulationSelectionRequest;
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
  chartPatternBias?: "bullish" | "bearish" | "neutral";
  chartPatterns: string[];
  model?: string;
};

export type AiSimulationChartBar = {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
  status: "forming" | "final" | "unknown";
  indicatorValues: Record<string, number>;
};

export type AiSimulationChartIndicator = {
  id: string;
  kind: string;
  status: string;
  values: Record<string, number>;
};

export type AiSimulationChartPattern = {
  name: string;
  bias: "bullish" | "bearish" | "neutral";
  strength?: number;
  detectedAt: string;
};

export type AiSimulationChartView = {
  symbol: string;
  name?: string;
  currency: "KRW" | "USD";
  bars: AiSimulationChartBar[];
  indicators: AiSimulationChartIndicator[];
  patterns: AiSimulationChartPattern[];
  updatedAt?: string;
};

export type AiSimulationPolicyProfile = {
  riskPenalty?: number;
  entryUpProbability?: number;
  exitUpProbability?: number;
  targetAllocationRate?: number;
  cashReserveRate?: number;
  technicalConfirmation?: "entry_candidate" | "non_exit" | string;
  patternConfirmation?: "bullish" | "non_bearish" | string;
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
  selection?: AiSimulationSelectionRequest;
  criterion?: AiSimulationCriterion;
  preset?: AiSimulationPreset;
  riskTolerance?: number;
  policyProfile?: AiSimulationPolicyProfile;
  decisionCadence?: {
    trigger?: string;
    triggeredEvents?: number;
    coalescedEvents?: number;
    duplicateEvents?: number;
    inFlight?: boolean;
    lastTriggeredAt?: string;
    lastStartedAt?: string;
    lastFinishedAt?: string;
  };
  selected: AiSimulationSelection[];
  positions: AiSimulationPosition[];
  charts: AiSimulationChartView[];
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
  initialCash: 10_000_000,
  durationMinutes: 60,
  preset: "risk_management",
  riskTolerance: 25,
  selection: {
    mode: "auto",
    criterion: "trading_amount",
    symbolCount: 1,
  },
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

function finiteNumberRecord(value: unknown): Record<string, number> {
  return Object.fromEntries(
    Object.entries(asRecord(value)).flatMap(([key, candidate]) => {
      const number = finiteNumber(candidate);
      return number === undefined ? [] : [[key, number]];
    }),
  );
}

function normalizeSelectionRequest(value: unknown): AiSimulationSelectionRequest | undefined {
  const source = asRecord(value);
  const mode = textValue(source.mode);
  if (mode === "manual") {
    const symbols = stringList(source.symbols)
      .map((symbol) => symbol.toUpperCase())
      .filter((symbol, index, values) => values.indexOf(symbol) === index)
      .slice(0, 2);
    return symbols.length ? { mode, symbols } : undefined;
  }
  if (mode === "auto") {
    const criterion = textValue(source.criterion);
    const symbolCount = finiteNumber(first(source, "symbolCount", "symbol_count"));
    if (criterion && AI_SIMULATION_CRITERIA.includes(criterion as AiSimulationCriterion)
      && (symbolCount === 1 || symbolCount === 2)) {
      return {
        mode,
        criterion: criterion as AiSimulationCriterion,
        symbolCount,
      };
    }
  }
  return undefined;
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
  const device = textValue(first(model, "device"));
  const parts = [
    id,
    version,
    device ? device.toUpperCase() : undefined,
  ].filter((part): part is string => Boolean(part));
  return parts.length ? parts.join(" · ") : undefined;
}

export function normalizeAiSimulationStatus(payload: unknown): AiSimulationStatus {
  const root = asRecord(payload);
  const nested = asRecord(root.status);
  const source = Object.keys(nested).length ? { ...root, ...nested } : root;
  const limits = asRecord(source.limits);
  const initialCash = asRecord(first(limits, "initialCash", "initial_cash"));
  const duration = asRecord(first(limits, "durationMinutes", "duration_minutes", "duration"));
  const enabled = typeof source.enabled === "boolean" ? source.enabled : true;

  return {
    enabled,
    message: textValue(first(source, "message", "reason")),
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
    chartPatternBias: (
      ["bullish", "bearish", "neutral"] as const
    ).find((candidate) => candidate === first(item, "chartPatternBias", "chart_pattern_bias")),
    chartPatterns: stringList(first(item, "chartPatterns", "chart_patterns")),
    model: modelLabel(item.model),
  };
}

function normalizeChartBar(value: unknown): AiSimulationChartBar | undefined {
  const item = asRecord(value);
  const timestamp = textValue(item.timestamp);
  const open = finiteNumber(item.open);
  const high = finiteNumber(item.high);
  const low = finiteNumber(item.low);
  const close = finiteNumber(item.close);
  const rawStatus = textValue(item.status);
  if (!timestamp || !Number.isFinite(Date.parse(timestamp))
    || open === undefined || high === undefined || low === undefined || close === undefined
    || open <= 0 || high < Math.max(open, close, low) || low > Math.min(open, close, high)) {
    return undefined;
  }
  return {
    timestamp,
    open,
    high,
    low,
    close,
    volume: finiteNumber(item.volume),
    status: rawStatus === "forming" || rawStatus === "final" || rawStatus === "unknown"
      ? rawStatus
      : "unknown",
    indicatorValues: finiteNumberRecord(first(item, "indicatorValues", "indicator_values")),
  };
}

function normalizeChartIndicator(value: unknown): AiSimulationChartIndicator | undefined {
  const item = asRecord(value);
  const id = textValue(item.id);
  const kind = textValue(item.kind);
  if (!id || !kind) return undefined;
  return {
    id,
    kind,
    status: textValue(item.status) ?? "unavailable",
    values: finiteNumberRecord(item.values),
  };
}

function normalizeChartPattern(value: unknown): AiSimulationChartPattern | undefined {
  const item = asRecord(value);
  const name = textValue(item.name);
  const detectedAt = textValue(first(item, "detectedAt", "detected_at"));
  const bias = textValue(item.bias);
  if (!name || !detectedAt || !Number.isFinite(Date.parse(detectedAt))
    || (bias !== "bullish" && bias !== "bearish" && bias !== "neutral")) {
    return undefined;
  }
  return {
    name,
    bias,
    strength: finiteNumber(item.strength),
    detectedAt,
  };
}

function normalizeChartView(value: unknown): AiSimulationChartView | undefined {
  const item = asRecord(value);
  const symbol = textValue(item.symbol);
  if (!symbol) return undefined;
  return {
    symbol,
    name: textValue(item.name),
    currency: item.currency === "USD" ? "USD" : "KRW",
    bars: mapValid(item.bars, normalizeChartBar),
    indicators: mapValid(item.indicators, normalizeChartIndicator),
    patterns: mapValid(item.patterns, normalizeChartPattern),
    updatedAt: textValue(first(item, "updatedAt", "updated_at")),
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
  const rawPreset = textValue(source.preset);
  const rawCriterion = textValue(source.criterion);
  const rawSelection = normalizeSelectionRequest(source.selection);
  const cadence = asRecord(first(source, "decisionCadence", "decision_cadence"));
  const profile = asRecord(first(source, "policyProfile", "policy_profile"));

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
    selection: rawSelection,
    criterion: AI_SIMULATION_CRITERIA.includes(rawCriterion as AiSimulationCriterion)
      ? rawCriterion as AiSimulationCriterion
      : rawSelection?.mode === "auto" ? rawSelection.criterion : undefined,
    preset: AI_SIMULATION_PRESETS.includes(rawPreset as AiSimulationPreset)
      ? rawPreset as AiSimulationPreset
      : undefined,
    riskTolerance: finiteNumber(first(source, "riskTolerance", "risk_tolerance")),
    policyProfile: Object.keys(profile).length ? {
      riskPenalty: finiteNumber(first(profile, "riskPenalty", "risk_penalty")),
      entryUpProbability: finiteNumber(first(profile, "entryUpProbability", "entry_up_probability")),
      exitUpProbability: finiteNumber(first(profile, "exitUpProbability", "exit_up_probability")),
      targetAllocationRate: finiteNumber(first(profile, "targetAllocationRate", "target_allocation_rate")),
      cashReserveRate: finiteNumber(first(profile, "cashReserveRate", "cash_reserve_rate")),
      technicalConfirmation: textValue(first(
        profile,
        "technicalConfirmation",
        "technical_confirmation",
      )),
      patternConfirmation: textValue(first(
        profile,
        "patternConfirmation",
        "pattern_confirmation",
      )),
    } : undefined,
    decisionCadence: Object.keys(cadence).length ? {
      trigger: textValue(cadence.trigger),
      triggeredEvents: finiteNumber(first(cadence, "triggeredEvents", "triggered_events")),
      coalescedEvents: finiteNumber(first(cadence, "coalescedEvents", "coalesced_events")),
      duplicateEvents: finiteNumber(first(cadence, "duplicateEvents", "duplicate_events")),
      inFlight: typeof first(cadence, "inFlight", "in_flight") === "boolean"
        ? first(cadence, "inFlight", "in_flight") as boolean
        : undefined,
      lastTriggeredAt: textValue(first(cadence, "lastTriggeredAt", "last_triggered_at")),
      lastStartedAt: textValue(first(cadence, "lastStartedAt", "last_started_at")),
      lastFinishedAt: textValue(first(cadence, "lastFinishedAt", "last_finished_at")),
    } : undefined,
    selected: mapValid(source.selected, normalizeSelection),
    positions: mapValid(source.positions, normalizePosition),
    charts: mapValid(source.charts, normalizeChartView),
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
  if (!AI_SIMULATION_PRESETS.includes(request.preset)) issues.push("AI 전략 프리셋이 올바르지 않습니다.");
  if (!Number.isInteger(request.riskTolerance)
    || request.riskTolerance < 0
    || request.riskTolerance > 100) {
    issues.push("공격·방어 성향은 0부터 100 사이의 정수여야 합니다.");
  }

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

  if (request.selection.mode === "auto") {
    if (!AI_SIMULATION_CRITERIA.includes(request.selection.criterion)) {
      issues.push("종목 선정 기준이 올바르지 않습니다.");
    }
    if (request.selection.symbolCount !== 1 && request.selection.symbolCount !== 2) {
      issues.push("AI 선정 종목 수는 1개 또는 2개여야 합니다.");
    }
  } else if (request.selection.mode === "manual") {
    const symbols = request.selection.symbols.map((symbol) => symbol.trim().toUpperCase());
    if (symbols.length < 1 || symbols.length > 2) {
      issues.push("직접 선택 종목은 1개 또는 2개여야 합니다.");
    }
    if (symbols.some((symbol) => !/^[A-Z0-9][A-Z0-9._-]{0,31}$/.test(symbol))) {
      issues.push("직접 선택 종목 코드를 확인해 주세요.");
    }
    if (new Set(symbols).size !== symbols.length) {
      issues.push("직접 선택 종목은 중복될 수 없습니다.");
    }
  } else {
    issues.push("종목 선택 방식이 올바르지 않습니다.");
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
