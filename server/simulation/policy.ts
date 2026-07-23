export const AI_PAPER_POLICY_VERSION = "ai-paper-policy/v1" as const;

export const AI_PAPER_ENTRY_UP_PROBABILITY = 0.55;
export const AI_PAPER_EXIT_UP_PROBABILITY = 0.45;
export const AI_PAPER_RISK_PENALTY = 0.25;
export const AI_PAPER_FORECAST_HORIZON_MINUTES = 5 as const;

export type AiPaperModelProvenance = {
  modelId: string;
  modelRevision: string;
  tokenizerId?: string;
  tokenizerRevision?: string;
  sourceRevision: string;
  loaderVersion: string;
  license: string;
  device: "cuda" | "cpu" | "unavailable";
  dtype: "float32";
  attentionBackend: "math" | "unavailable";
  loaded: boolean;
  fallbackFrom?: string;
  fallbackReason?: string;
};

export type AiPaperForecastCandidate = {
  symbol: string;
  inputEndAt: string;
  generatedAt: string;
  targetTimestamp: string;
  horizonMinutes: typeof AI_PAPER_FORECAST_HORIZON_MINUTES;
  medianReturn: number;
  q10Return: number;
  q90Return: number;
  upProbability: number;
  score: number;
  roundTripCostRate: number;
  model: AiPaperModelProvenance;
};

export type AiPaperSelection = {
  policyVersion: typeof AI_PAPER_POLICY_VERSION;
  status: "available" | "unavailable";
  requestedSymbolCount: 1 | 2;
  availableCandidateCount: number;
  generatedAt?: string;
  model?: AiPaperModelProvenance;
  selected: AiPaperForecastCandidate[];
  reason?:
    | "invalid_forecast_response"
    | "model_unavailable"
    | "insufficient_available_forecasts"
    | "stale_forecast_horizon";
};

export type PaperTechnicalState = "watch" | "entry_candidate" | "hold" | "exit_candidate";
export type PaperPolicyActionKind = "buy" | "sell" | "hold" | "watch";

export type PaperPolicyAction = {
  policyVersion: typeof AI_PAPER_POLICY_VERSION;
  symbol: string;
  action: PaperPolicyActionKind;
  eligibleAfter: string;
  inputEndAt: string;
  forecastGeneratedAt: string;
  score: number;
  medianReturn: number;
  q10Return: number;
  q90Return: number;
  upProbability: number;
  technicalState: PaperTechnicalState | null;
  technicalObservedAt?: string;
  reasons: string[];
  model: AiPaperModelProvenance;
};

export type PaperPosition = {
  symbol: string;
  quantity: number;
  averagePrice: number;
  costBasis: number;
};

export type PaperLedger = {
  policyVersion: typeof AI_PAPER_POLICY_VERSION;
  initialCash: number;
  cash: number;
  positions: Record<string, PaperPosition>;
  realizedPnl: number;
  totalCosts: number;
};

export type PaperTradingCosts = {
  commissionBpsPerSide: number;
  exitTaxBps: number;
  spreadBpsRoundTrip: number;
  slippageBpsPerSide: number;
};

export type PaperExecution = {
  timestamp: string;
  price: number;
};

export type PaperFillConfig = {
  symbolCount: 1 | 2;
  costs: PaperTradingCosts;
  markPrices?: Readonly<Record<string, number>>;
  allocationEquity?: number;
};

export type PaperTrade = {
  policyVersion: typeof AI_PAPER_POLICY_VERSION;
  symbol: string;
  side: "buy" | "sell";
  signalEligibleAfter: string;
  executedAt: string;
  price: number;
  quantity: number;
  grossAmount: number;
  commission: number;
  exitTax: number;
  spreadCost: number;
  slippageCost: number;
  totalCosts: number;
  cashAfter: number;
  positionQuantityAfter: number;
};

export type PaperFillResult = {
  status: "filled" | "skipped" | "rejected";
  reason:
    | "filled"
    | "non_executable_action"
    | "invalid_execution"
    | "execution_not_after_eligible"
    | "position_not_held"
    | "target_already_met"
    | "insufficient_cash"
    | "mark_price_unavailable"
    | "invalid_ledger";
  ledger: PaperLedger;
  trade?: PaperTrade;
};

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : undefined;
}

function nonemptyString(value: unknown, maximum = 256): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= maximum ? normalized : undefined;
}

function optionalString(value: unknown, maximum = 256): string | undefined | null {
  if (value === undefined || value === null) return undefined;
  return nonemptyString(value, maximum) ?? null;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isoTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 64) return undefined;
  const instant = Date.parse(value);
  return Number.isFinite(instant) ? new Date(instant).toISOString() : undefined;
}

function rawKeyCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validatedRoundTripCostRate(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value >= 1) {
    throw new RangeError("roundTripCostRate must be a finite decimal rate in [0, 1).");
  }
  return value;
}

function parseModel(value: unknown): AiPaperModelProvenance | undefined {
  const source = record(value);
  if (!source) return undefined;
  const modelId = nonemptyString(source.model_id);
  const modelRevision = nonemptyString(source.model_revision);
  const sourceRevision = nonemptyString(source.source_revision);
  const loaderVersion = nonemptyString(source.loader_version, 128);
  const license = nonemptyString(source.license, 64);
  const tokenizerId = optionalString(source.tokenizer_id);
  const tokenizerRevision = optionalString(source.tokenizer_revision);
  const fallbackFrom = optionalString(source.fallback_from);
  const fallbackReason = optionalString(source.fallback_reason, 500);
  const device = source.device;
  const attentionBackend = source.attention_backend;
  const loaded = source.loaded;
  if (!modelId || !modelRevision || !sourceRevision || !loaderVersion || !license
    || tokenizerId === null || tokenizerRevision === null || fallbackFrom === null || fallbackReason === null
    || !["cuda", "cpu", "unavailable"].includes(String(device))
    || source.dtype !== "float32"
    || !["math", "unavailable"].includes(String(attentionBackend))
    || typeof loaded !== "boolean") {
    return undefined;
  }
  if ((loaded && (device === "unavailable" || attentionBackend !== "math"))
    || (!loaded && (device !== "unavailable" || attentionBackend !== "unavailable"))) {
    return undefined;
  }
  return {
    modelId,
    modelRevision,
    ...(tokenizerId ? { tokenizerId } : {}),
    ...(tokenizerRevision ? { tokenizerRevision } : {}),
    sourceRevision,
    loaderVersion,
    license,
    device: device as AiPaperModelProvenance["device"],
    dtype: "float32",
    attentionBackend: attentionBackend as AiPaperModelProvenance["attentionBackend"],
    loaded,
    ...(fallbackFrom ? { fallbackFrom } : {}),
    ...(fallbackReason ? { fallbackReason } : {}),
  };
}

function parseQuantiles(value: unknown): { q10: number; median: number; q90: number } | undefined {
  if (!Array.isArray(value)) return undefined;
  const wanted = new Map<number, number>();
  for (const item of value) {
    const quantile = finite(record(item)?.quantile);
    const amount = finite(record(item)?.value);
    if (quantile === undefined || amount === undefined || ![0.1, 0.5, 0.9].includes(quantile)) continue;
    if (wanted.has(quantile)) return undefined;
    wanted.set(quantile, amount);
  }
  const q10 = wanted.get(0.1);
  const median = wanted.get(0.5);
  const q90 = wanted.get(0.9);
  if (q10 === undefined || median === undefined || q90 === undefined
    || q10 > median || median > q90) return undefined;
  return { q10, median, q90 };
}

function parseCandidate(
  value: unknown,
  generatedAt: string,
  model: AiPaperModelProvenance,
  roundTripCostRate: number,
  notBeforeMs: number,
): AiPaperForecastCandidate | undefined {
  const source = record(value);
  const symbol = nonemptyString(source?.instrument_key, 128);
  const inputEndAt = isoTimestamp(source?.input_end_at);
  if (!source || source.status !== "available" || source.unavailable !== undefined && source.unavailable !== null
    || !symbol || !inputEndAt || !Array.isArray(source.horizons)) return undefined;
  const fiveMinute = source.horizons.filter((item) => record(item)?.horizon_minutes === 5);
  if (fiveMinute.length !== 1) return undefined;
  const horizon = record(fiveMinute[0]);
  const targetTimestamp = isoTimestamp(horizon?.target_timestamp);
  const quantiles = parseQuantiles(horizon?.return_quantiles);
  const upProbability = finite(horizon?.up_probability);
  if (!targetTimestamp
    || Date.parse(targetTimestamp) <= Math.max(Date.parse(generatedAt), notBeforeMs)
    || !quantiles
    || upProbability === undefined
    || upProbability < 0
    || upProbability > 1) return undefined;
  const score = quantiles.median
    - AI_PAPER_RISK_PENALTY * (quantiles.q90 - quantiles.q10)
    - roundTripCostRate;
  if (!Number.isFinite(score)) return undefined;
  return {
    symbol,
    inputEndAt,
    generatedAt,
    targetTimestamp,
    horizonMinutes: AI_PAPER_FORECAST_HORIZON_MINUTES,
    medianReturn: quantiles.median,
    q10Return: quantiles.q10,
    q90Return: quantiles.q90,
    upProbability,
    score,
    roundTripCostRate,
    model,
  };
}

export function selectAiForecastSeries(
  input: unknown,
  config: { symbolCount: 1 | 2; roundTripCostRate: number; notBeforeMs?: number },
): AiPaperSelection {
  if (config.symbolCount !== 1 && config.symbolCount !== 2) {
    throw new RangeError("symbolCount must be exactly 1 or 2.");
  }
  const roundTripCostRate = validatedRoundTripCostRate(config.roundTripCostRate);
  if (config.notBeforeMs !== undefined && !Number.isFinite(config.notBeforeMs)) {
    throw new RangeError("notBeforeMs must be a finite epoch timestamp.");
  }
  const response = record(input);
  const model = parseModel(response?.model);
  const generatedAt = isoTimestamp(response?.generated_at);
  const base = {
    policyVersion: AI_PAPER_POLICY_VERSION,
    requestedSymbolCount: config.symbolCount,
    availableCandidateCount: 0,
    selected: [] as AiPaperForecastCandidate[],
  } as const;
  if (!response || response.schema_version !== "scalping-ai/v1" || response.mode !== "forecast"
    || !model || !generatedAt || !Array.isArray(response.series)) {
    return { ...base, status: "unavailable", reason: "invalid_forecast_response" };
  }
  if (!model.loaded) {
    return {
      ...base,
      status: "unavailable",
      generatedAt,
      model,
      reason: "model_unavailable",
    };
  }
  const notBeforeMs = config.notBeforeMs ?? Date.parse(generatedAt);
  const freshnessCutoff = Math.max(Date.parse(generatedAt), notBeforeMs);
  let staleForecastCount = 0;
  const parsed = response.series
    .map((series) => {
      const source = record(series);
      const horizon = Array.isArray(source?.horizons)
        ? source.horizons.find((item) => record(item)?.horizon_minutes === 5)
        : undefined;
      const targetTimestamp = isoTimestamp(record(horizon)?.target_timestamp);
      if (source?.status === "available"
        && targetTimestamp
        && Date.parse(targetTimestamp) <= freshnessCutoff) {
        staleForecastCount += 1;
      }
      return parseCandidate(series, generatedAt, model, roundTripCostRate, notBeforeMs);
    })
    .filter((candidate): candidate is AiPaperForecastCandidate => candidate !== undefined);
  const duplicateSymbols = new Set<string>();
  const seen = new Set<string>();
  for (const candidate of parsed) {
    if (seen.has(candidate.symbol)) duplicateSymbols.add(candidate.symbol);
    seen.add(candidate.symbol);
  }
  const candidates = parsed
    .filter((candidate) => !duplicateSymbols.has(candidate.symbol))
    .sort((left, right) => right.score - left.score || rawKeyCompare(left.symbol, right.symbol));
  if (candidates.length < config.symbolCount) {
    return {
      ...base,
      status: "unavailable",
      availableCandidateCount: candidates.length,
      generatedAt,
      model,
      reason: staleForecastCount > 0
        ? "stale_forecast_horizon"
        : "insufficient_available_forecasts",
    };
  }
  return {
    policyVersion: AI_PAPER_POLICY_VERSION,
    status: "available",
    requestedSymbolCount: config.symbolCount,
    availableCandidateCount: candidates.length,
    generatedAt,
    model,
    selected: candidates.slice(0, config.symbolCount),
  };
}

function maxTimestamp(left: string, right: string): string {
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

function technicalObservation(value: unknown): {
  state: PaperTechnicalState | null;
  observedAt?: string;
} {
  const source = record(value);
  const rawState = source?.status ?? value;
  const state = rawState === "watch" || rawState === "entry_candidate"
    || rawState === "hold" || rawState === "exit_candidate"
    ? rawState
    : null;
  const observedAt = isoTimestamp(source?.observedAt ?? source?.observed_at);
  return {
    state,
    ...(observedAt ? { observedAt } : {}),
  };
}

export function decidePaperActions(input: {
  selection: AiPaperSelection;
  technicalStates?: Readonly<Record<string, unknown>>;
  heldSymbols?: readonly string[];
}): PaperPolicyAction[] {
  if (input.selection.status !== "available") return [];
  const held = new Set(input.heldSymbols ?? []);
  return input.selection.selected.map((candidate) => {
    const observation = technicalObservation(input.technicalStates?.[candidate.symbol]);
    const state = observation.state;
    const isHeld = held.has(candidate.symbol);
    const exitReasons = [
      ...(candidate.score < 0 ? ["negative_risk_adjusted_score"] : []),
      ...(candidate.upProbability <= AI_PAPER_EXIT_UP_PROBABILITY ? ["low_up_probability"] : []),
      ...(state === "exit_candidate" ? ["technical_exit_candidate"] : []),
    ];
    const canEnter = candidate.score > 0
      && candidate.upProbability >= AI_PAPER_ENTRY_UP_PROBABILITY
      && state !== "exit_candidate";
    const action: PaperPolicyActionKind = isHeld
      ? exitReasons.length ? "sell" : "hold"
      : canEnter ? "buy" : "watch";
    const reasons = action === "buy"
      ? ["positive_risk_adjusted_score", "entry_probability_threshold", "technical_exit_absent"]
      : action === "sell" ? exitReasons
        : action === "hold" ? ["exit_conditions_absent"]
          : [
              ...(candidate.score <= 0 ? ["entry_score_threshold_not_met"] : []),
              ...(candidate.upProbability < AI_PAPER_ENTRY_UP_PROBABILITY
                ? ["entry_probability_threshold_not_met"] : []),
              ...(state === "exit_candidate" ? ["technical_exit_candidate"] : []),
            ];
    const aiEligibleAfter = maxTimestamp(candidate.inputEndAt, candidate.generatedAt);
    const eligibleAfter = observation.observedAt
      ? maxTimestamp(aiEligibleAfter, observation.observedAt)
      : aiEligibleAfter;
    return {
      policyVersion: AI_PAPER_POLICY_VERSION,
      symbol: candidate.symbol,
      action,
      eligibleAfter,
      inputEndAt: candidate.inputEndAt,
      forecastGeneratedAt: candidate.generatedAt,
      score: candidate.score,
      medianReturn: candidate.medianReturn,
      q10Return: candidate.q10Return,
      q90Return: candidate.q90Return,
      upProbability: candidate.upProbability,
      technicalState: state,
      ...(observation.observedAt ? { technicalObservedAt: observation.observedAt } : {}),
      reasons,
      model: candidate.model,
    };
  });
}

function validMoney(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function cloneLedger(ledger: PaperLedger): PaperLedger {
  return {
    ...ledger,
    positions: Object.fromEntries(
      Object.entries(ledger.positions).map(([symbol, position]) => [symbol, { ...position }]),
    ),
  };
}

function ledgerIsValid(ledger: PaperLedger): boolean {
  return ledger.policyVersion === AI_PAPER_POLICY_VERSION
    && Number.isFinite(ledger.initialCash) && ledger.initialCash > 0
    && validMoney(ledger.cash)
    && Number.isFinite(ledger.realizedPnl)
    && validMoney(ledger.totalCosts)
    && Object.entries(ledger.positions).every(([symbol, position]) => (
      symbol === position.symbol
      && Number.isSafeInteger(position.quantity) && position.quantity > 0
      && Number.isFinite(position.averagePrice) && position.averagePrice > 0
      && Number.isFinite(position.costBasis) && position.costBasis > 0
    ));
}

function validateCosts(costs: PaperTradingCosts): {
  commissionRate: number;
  exitTaxRate: number;
  halfSpreadRate: number;
  slippageRate: number;
} {
  const fields = [
    costs.commissionBpsPerSide,
    costs.exitTaxBps,
    costs.spreadBpsRoundTrip,
    costs.slippageBpsPerSide,
  ];
  if (fields.some((value) => !Number.isFinite(value) || value < 0 || value > 5_000)) {
    throw new RangeError("Paper trading cost assumptions must be finite basis points in [0, 5000].");
  }
  const output = {
    commissionRate: costs.commissionBpsPerSide / 10_000,
    exitTaxRate: costs.exitTaxBps / 10_000,
    halfSpreadRate: costs.spreadBpsRoundTrip / 20_000,
    slippageRate: costs.slippageBpsPerSide / 10_000,
  };
  if (output.commissionRate + output.exitTaxRate + output.halfSpreadRate + output.slippageRate >= 1) {
    throw new RangeError("Paper trading sell costs must remain below the gross proceeds.");
  }
  return output;
}

function rejected(ledger: PaperLedger, reason: PaperFillResult["reason"]): PaperFillResult {
  return { status: "rejected", reason, ledger: cloneLedger(ledger) };
}

function skipped(ledger: PaperLedger, reason: PaperFillResult["reason"]): PaperFillResult {
  return { status: "skipped", reason, ledger: cloneLedger(ledger) };
}

export function createPaperLedger(initialCash: number): PaperLedger {
  if (!Number.isFinite(initialCash) || initialCash <= 0) {
    throw new RangeError("initialCash must be a positive finite amount.");
  }
  return {
    policyVersion: AI_PAPER_POLICY_VERSION,
    initialCash,
    cash: initialCash,
    positions: {},
    realizedPnl: 0,
    totalCosts: 0,
  };
}

function currentEquity(
  ledger: PaperLedger,
  actionSymbol: string,
  actionPrice: number,
  marks: Readonly<Record<string, number>> | undefined,
): number | undefined {
  let equity = ledger.cash;
  for (const [symbol, position] of Object.entries(ledger.positions)) {
    const price = symbol === actionSymbol ? actionPrice : marks?.[symbol];
    if (price === undefined || !Number.isFinite(price) || price <= 0) return undefined;
    equity += position.quantity * price;
  }
  return Number.isFinite(equity) && equity > 0 ? equity : undefined;
}

export function fillPaperAction(
  ledgerInput: PaperLedger,
  action: PaperPolicyAction,
  execution: PaperExecution,
  config: PaperFillConfig,
): PaperFillResult {
  const ledger = cloneLedger(ledgerInput);
  if (!ledgerIsValid(ledger)) return rejected(ledger, "invalid_ledger");
  if (action.action !== "buy" && action.action !== "sell") {
    return skipped(ledger, "non_executable_action");
  }
  if (config.symbolCount !== 1 && config.symbolCount !== 2) {
    throw new RangeError("symbolCount must be exactly 1 or 2.");
  }
  const rates = validateCosts(config.costs);
  const executedAt = isoTimestamp(execution.timestamp);
  const eligibleAfter = isoTimestamp(action.eligibleAfter);
  if (!executedAt || !eligibleAfter || !Number.isFinite(execution.price) || execution.price <= 0) {
    return rejected(ledger, "invalid_execution");
  }
  if (Date.parse(executedAt) <= Date.parse(eligibleAfter)) {
    return rejected(ledger, "execution_not_after_eligible");
  }

  if (action.action === "sell") {
    const position = ledger.positions[action.symbol];
    if (!position) return skipped(ledger, "position_not_held");
    const quantity = position.quantity;
    const grossAmount = quantity * execution.price;
    const commission = grossAmount * rates.commissionRate;
    const exitTax = grossAmount * rates.exitTaxRate;
    const spreadCost = grossAmount * rates.halfSpreadRate;
    const slippageCost = grossAmount * rates.slippageRate;
    const totalCosts = commission + exitTax + spreadCost + slippageCost;
    const proceeds = grossAmount - totalCosts;
    if (!validMoney(proceeds)) return rejected(ledger, "invalid_execution");
    ledger.cash += proceeds;
    ledger.realizedPnl += proceeds - position.costBasis;
    ledger.totalCosts += totalCosts;
    delete ledger.positions[action.symbol];
    const trade: PaperTrade = {
      policyVersion: AI_PAPER_POLICY_VERSION,
      symbol: action.symbol,
      side: "sell",
      signalEligibleAfter: eligibleAfter,
      executedAt,
      price: execution.price,
      quantity,
      grossAmount,
      commission,
      exitTax,
      spreadCost,
      slippageCost,
      totalCosts,
      cashAfter: ledger.cash,
      positionQuantityAfter: 0,
    };
    return { status: "filled", reason: "filled", ledger, trade };
  }

  const equity = config.allocationEquity === undefined
    ? currentEquity(ledger, action.symbol, execution.price, config.markPrices)
    : Number.isFinite(config.allocationEquity) && config.allocationEquity > 0
      ? config.allocationEquity
      : undefined;
  if (equity === undefined) return rejected(ledger, "mark_price_unavailable");
  const current = ledger.positions[action.symbol];
  const currentGross = (current?.quantity ?? 0) * execution.price;
  const targetGross = equity / config.symbolCount;
  const desiredQuantity = Math.floor(Math.max(0, targetGross - currentGross) / execution.price);
  if (desiredQuantity <= 0) return skipped(ledger, "target_already_met");
  const unitDebit = execution.price * (
    1 + rates.commissionRate + rates.halfSpreadRate + rates.slippageRate
  );
  const affordableQuantity = Math.floor((ledger.cash + Number.EPSILON) / unitDebit);
  const quantity = Math.min(desiredQuantity, affordableQuantity);
  if (quantity <= 0) return skipped(ledger, "insufficient_cash");
  const grossAmount = quantity * execution.price;
  const commission = grossAmount * rates.commissionRate;
  const spreadCost = grossAmount * rates.halfSpreadRate;
  const slippageCost = grossAmount * rates.slippageRate;
  const totalCosts = commission + spreadCost + slippageCost;
  const debit = grossAmount + totalCosts;
  if (debit > ledger.cash + 1e-9) return skipped(ledger, "insufficient_cash");
  ledger.cash = Math.max(0, ledger.cash - debit);
  ledger.totalCosts += totalCosts;
  const priorQuantity = current?.quantity ?? 0;
  const newQuantity = priorQuantity + quantity;
  const costBasis = (current?.costBasis ?? 0) + debit;
  ledger.positions[action.symbol] = {
    symbol: action.symbol,
    quantity: newQuantity,
    averagePrice: costBasis / newQuantity,
    costBasis,
  };
  const trade: PaperTrade = {
    policyVersion: AI_PAPER_POLICY_VERSION,
    symbol: action.symbol,
    side: "buy",
    signalEligibleAfter: eligibleAfter,
    executedAt,
    price: execution.price,
    quantity,
    grossAmount,
    commission,
    exitTax: 0,
    spreadCost,
    slippageCost,
    totalCosts,
    cashAfter: ledger.cash,
    positionQuantityAfter: newQuantity,
  };
  return { status: "filled", reason: "filled", ledger, trade };
}
