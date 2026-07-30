import {
  mergeLatestModelForecasts,
  mergeLatestKronosForecasts,
  normalizeAiSimulationModelForecasts,
  selectLatestKronosForecasts,
  type AiSimulationKronosForecast,
  type AiSimulationModelForecast,
} from "./ai-simulation-forecast";
import {
  AI_SIMULATION_MAIN_MODEL_LANE,
  AI_SIMULATION_MODEL_LANES,
  normalizeAiSimulationCryptoStatus,
  normalizeAiSimulationFuturesPositions,
  normalizeAiSimulationFuturesRisk,
  normalizeAiSimulationMarket,
  normalizeAiSimulationModelComparison,
  type AiSimulationCryptoStatus,
  type AiSimulationExecutionMode,
  type AiSimulationFuturesPosition,
  type AiSimulationFuturesRisk,
  type AiSimulationMarket,
  type AiSimulationCase,
  type AiSimulationHighVolatilityScannerSettings,
  type AiSimulationModelPlanEntry,
  type AiSimulationModelRole,
  type AiSimulationModelComparison,
  type AiSimulationModelLane,
} from "./ai-simulation-crypto";

export {
  AI_SIMULATION_FINCAST_CANDLE_SECONDS,
  AI_SIMULATION_CRYPTO_MAXIMUM_INITIAL_CASH,
  AI_SIMULATION_CRYPTO_MINIMUM_INITIAL_CASH,
  AI_SIMULATION_CRYPTO_FUTURES_MARKET,
  AI_SIMULATION_EXECUTION_MODES,
  AI_SIMULATION_LEGACY_MODEL_LANE,
  AI_SIMULATION_MAIN_MODEL_LANE,
  AI_SIMULATION_MODEL_LANES,
  DEFAULT_AI_SIMULATION_CRYPTO_RISK_LIMITS,
  DEFAULT_AI_SIMULATION_CRYPTO_REQUEST,
  normalizeAiSimulationCandidates,
  normalizeAiSimulationCryptoStatus,
  normalizeAiSimulationFuturesPositions,
  normalizeAiSimulationFuturesRisk,
  normalizeAiSimulationMarket,
  normalizeAiSimulationModelComparison,
  validateAiSimulationCryptoRequest,
} from "./ai-simulation-crypto";
export type {
  AiSimulationCandidateQuality,
  AiSimulationCandidateSnapshot,
  AiSimulationCryptoCandidate,
  AiSimulationCryptoRequest,
  AiSimulationCryptoRiskLimits,
  AiSimulationCryptoStatus,
  AiSimulationExecutionMode,
  AiSimulationFuturesPosition,
  AiSimulationFuturesRisk,
  AiSimulationMarket,
  AiSimulationCase,
  AiSimulationHighVolatilityScannerSettings,
  AiSimulationModelPlanEntry,
  AiSimulationModelRole,
  AiSimulationModelComparison,
  AiSimulationModelComparisonLane,
  AiSimulationModelLaneProvenance,
  AiSimulationModelLane,
  AiSimulationModelMetrics,
  AiSimulationWorkerStatus,
} from "./ai-simulation-crypto";

export const AI_SIMULATION_MARKETS = ["KR", "US"] as const;
export const AI_SIMULATION_CRITERIA = ["trading_amount", "volume", "volatility"] as const;
export const AI_SIMULATION_PRESETS = ["trend", "breakout", "mean_reversion", "risk_management"] as const;
export const AI_SIMULATION_SELECTION_MODES = ["auto", "manual"] as const;
export const AI_SIMULATION_PAIR_IDS = [
  "semiconductor-soxl-soxs",
  "spy-spxl-spxs",
  "soxx-soxl-soxs",
  "smh-soxl-soxs",
  "sndk-snxx-sndq",
  "tsla-tsll-tsls",
  "tsla-tsll-tslq",
  "qqq-tqqq-sqqq",
] as const;
export const AI_SIMULATION_COMPARISON_LANES = ["kronos", "rust", "ensemble"] as const;

export type AiSimulationMarketCountry = (typeof AI_SIMULATION_MARKETS)[number];
export type AiSimulationCriterion = (typeof AI_SIMULATION_CRITERIA)[number];
export type AiSimulationPreset = (typeof AI_SIMULATION_PRESETS)[number];
export type AiSimulationSelectionMode = (typeof AI_SIMULATION_SELECTION_MODES)[number];
export type AiSimulationPairId = (typeof AI_SIMULATION_PAIR_IDS)[number];
export type AiSimulationComparisonLaneId = (typeof AI_SIMULATION_COMPARISON_LANES)[number];
export type AiSimulationCurrency = "KRW" | "USD" | "USDT";

export type AiSimulationPairCatalogItem = {
  id: AiSimulationPairId;
  label: string;
  symbols: string[];
  displaySignalSymbol?: string;
  modelTargetSymbol?: string;
  auxiliarySymbols?: string[];
};

export const AI_SIMULATION_PAIR_CATALOG: readonly AiSimulationPairCatalogItem[] = [
  {
    id: "qqq-tqqq-sqqq",
    label: "QQQ → TQQQ / SQQQ",
    symbols: ["QQQ", "TQQQ", "SQQQ"],
    displaySignalSymbol: "QQQ",
    modelTargetSymbol: "QQQ",
    auxiliarySymbols: [],
  },
  {
    id: "semiconductor-soxl-soxs",
    label: "SMH/반도체 · SOXX → SOXL / SOXS",
    symbols: ["SOXX", "SMH", "QQQ", "SOXL", "SOXS"],
    displaySignalSymbol: "SMH",
    modelTargetSymbol: "SOXX",
    auxiliarySymbols: ["SMH", "QQQ"],
  },
  {
    id: "spy-spxl-spxs",
    label: "SPY → SPXL / SPXS",
    symbols: ["SPY", "SPXL", "SPXS"],
    displaySignalSymbol: "SPY",
    modelTargetSymbol: "SPY",
    auxiliarySymbols: [],
  },
  {
    id: "sndk-snxx-sndq",
    label: "샌디스크 SNDK · SNXX (+2x) · SNDQ (-2x)",
    symbols: ["SNDK", "SNXX", "SNDQ"],
  },
  { id: "soxx-soxl-soxs", label: "SOXX · SOXL · SOXS", symbols: ["SOXX", "SOXL", "SOXS"] },
  { id: "smh-soxl-soxs", label: "SMH · SOXL · SOXS", symbols: ["SMH", "SOXL", "SOXS"] },
  { id: "tsla-tsll-tsls", label: "TSLA · TSLL · TSLS", symbols: ["TSLA", "TSLL", "TSLS"] },
  { id: "tsla-tsll-tslq", label: "TSLA · TSLL · TSLQ", symbols: ["TSLA", "TSLL", "TSLQ"] },
] as const;

export type AiSimulationStrategyRequest =
  | { mode: "single" }
  | {
      mode: "pair";
      pairId: AiSimulationPairId;
      allowDegradedMode: false;
    };

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

export type AiSimulationCostSource = {
  label: string;
  url: string;
};

export type AiSimulationCostProfile = {
  profileVersion: string;
  profileId: string;
  broker: string;
  marketCountry: AiSimulationMarketCountry;
  currency: "KRW" | "USD";
  venue: string;
  effectiveFrom?: string;
  verifiedAt?: string;
  commissionBpsPerSide: number;
  commissionFreeGrossAmountMaximum?: number;
  sellTaxBps: number;
  sellRegulatoryBps: number;
  sellRegulatoryFeePerShare: number;
  sellRegulatoryFeeMaximum?: number;
  spreadBpsRoundTrip: number;
  slippageBpsPerSide: number;
  fxConversionIncluded: boolean;
  alternativeVenues: Array<{
    venue: string;
    commissionBpsPerSide: number;
  }>;
  scopeNotes: string[];
  sources: AiSimulationCostSource[];
};

export const AI_SIMULATION_MARKET_COST_DEFAULTS: Readonly<
  Record<AiSimulationMarketCountry, Readonly<AiSimulationCosts>>
> = Object.freeze({
  KR: Object.freeze({
    commissionBpsPerSide: 1.5,
    taxBpsOnExit: 20,
    spreadBpsRoundTrip: 5,
    slippageBpsPerSide: 2,
  }),
  US: Object.freeze({
    commissionBpsPerSide: 10,
    taxBpsOnExit: 0,
    spreadBpsRoundTrip: 5,
    slippageBpsPerSide: 2,
  }),
});

export function defaultAiSimulationCosts(
  marketCountry: AiSimulationMarketCountry,
): AiSimulationCosts {
  return { ...AI_SIMULATION_MARKET_COST_DEFAULTS[marketCountry] };
}

export function usesDefaultAiSimulationCosts(
  costs: AiSimulationCosts,
  marketCountry: AiSimulationMarketCountry,
): boolean {
  const defaults = AI_SIMULATION_MARKET_COST_DEFAULTS[marketCountry];
  return (Object.keys(defaults) as Array<keyof AiSimulationCosts>)
    .every((key) => costs[key] === defaults[key]);
}

export type AiSimulationRequest = {
  contractVersion?: "ai-paper-simulation/v8";
  simulationCase?: AiSimulationCase;
  marketCountry: AiSimulationMarketCountry;
  initialCash: number;
  durationMinutes: number;
  preset: AiSimulationPreset;
  riskTolerance: number;
  selection: AiSimulationSelectionRequest;
  strategy: AiSimulationStrategyRequest;
  costs: AiSimulationCosts;
  modelLanes:
    | [AiSimulationModelLane]
    | [AiSimulationModelLane, AiSimulationModelLane]
    | [AiSimulationModelLane, AiSimulationModelLane, AiSimulationModelLane];
  modelPlan?: AiSimulationModelPlanEntry[];
  fincastCandleSeconds: 60;
  execution: { mode: "paper" };
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
  pairStrategy?: {
    enabled: boolean;
    message?: string;
    catalog: AiSimulationPairCatalogItem[];
  };
  costProfiles?: Partial<Record<AiSimulationMarketCountry, AiSimulationCostProfile>>;
  cryptoFutures?: AiSimulationCryptoStatus;
};

export type AiSimulationSelection = {
  symbol: string;
  name?: string;
  score?: number;
  upProbability?: number;
  predictedMedianReturn?: number;
  currentPrice?: number;
  priceObservedAt?: string;
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
  positionSide?: "long" | "short";
  reduceOnly?: boolean;
  funding?: number;
  realizedPnl?: number;
};

export type AiSimulationDecision = {
  symbol: string;
  action: string;
  decidedAt: string;
  eligibleAfter?: string;
  reason: string;
  reasons?: string[];
  score?: number;
  upProbability?: number;
  q10Return?: number;
  predictedMedianReturn?: number;
  q90Return?: number;
  technicalState?: string;
  technicalScore?: number;
  technicalDirection?: string;
  technicalOriginAt?: string;
  exposureScale?: number;
  modelEvidenceScale?: number;
  fusionPolicyVersion?: string;
  signalSymbol?: string;
  executionSymbol?: string;
  direction?: string;
  degraded?: boolean;
  components?: Record<string, number>;
  weights?: Record<string, number>;
  finalScores?: Record<string, number>;
  provenance?: string[];
  chartPatternBias?: "bullish" | "bearish" | "neutral";
  chartPatternStrength?: number;
  chartPatterns: string[];
  model?: string;
};

export type AiSimulationComparisonDecisionReason = {
  reason: string;
  reasons: string[];
  symbol?: string;
  signalSymbol?: string;
  executionSymbol?: string;
  action?: string;
  decidedAt?: string;
};

export type AiSimulationStrategyComparisonLane = {
  id: AiSimulationComparisonLaneId;
  status: string;
  analyticalOnly?: boolean;
  unavailableReason?: string;
  cumulativeReturn?: number;
  netReturn?: number;
  netProfit?: number;
  maxDrawdown?: number;
  riskAdjustedReturn?: number;
  trades?: number;
  costs?: number;
  switches?: number;
  directionAccuracy?: number;
  executionAccuracy?: number;
  calibration?: number;
  calibrationUnavailableRatio?: number;
  unavailableRatio?: number;
  latencyMs?: number;
  bullCount?: number;
  bearCount?: number;
  cashCount?: number;
  decisionReasons: AiSimulationComparisonDecisionReason[];
};

export type AiSimulationStrategyComparison = {
  conditionId: string;
  pairId?: AiSimulationPairId;
  sameOrigin: boolean;
  sameCosts: boolean;
  sameExecutionPolicy: boolean;
  incompleteCount: number;
  lanes: AiSimulationStrategyComparisonLane[];
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
  currency: AiSimulationCurrency;
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
  market?: AiSimulationMarket;
  marketCountry?: AiSimulationMarketCountry;
  simulationCase?: AiSimulationCase;
  modelPlan?: AiSimulationModelPlanEntry[];
  currency: AiSimulationCurrency;
  initialCash: number;
  cash: number;
  equity: number;
  progress: number;
  selection?: AiSimulationSelectionRequest;
  strategy?: AiSimulationStrategyRequest;
  criterion?: AiSimulationCriterion;
  preset?: AiSimulationPreset;
  riskTolerance?: number;
  policyProfile?: AiSimulationPolicyProfile;
  decisionCadence?: {
    trigger?: string;
    inferenceIntervalSeconds?: number;
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
  modelForecasts?: AiSimulationModelForecast[];
  kronosForecasts: AiSimulationKronosForecast[];
  warnings: string[];
  capabilities: Record<string, boolean | number | string>;
  strategyComparison?: AiSimulationStrategyComparison;
  futuresPositions?: AiSimulationFuturesPosition[];
  futuresRisk?: AiSimulationFuturesRisk;
  modelLanes?: AiSimulationModelLane[];
  executionMode?: AiSimulationExecutionMode;
  modelComparison?: AiSimulationModelComparison;
  modelEvidence?: unknown[];
  unifiedPolicyDecisions?: unknown[];
  pairMapping?: unknown;
  etfSessionGate?: unknown;
  highVolatilityScanner?: unknown;
};

export type AiSimulationRunResponse = {
  runId?: string;
  status: string;
  snapshot?: AiSimulationSnapshot;
  error?: string;
};

export type AiSimulationHistoryItem = {
  runId: string;
  status: string;
  startedAt?: string;
  finishedAt?: string;
  market?: AiSimulationMarket;
  marketCountry?: AiSimulationMarketCountry;
  currency: AiSimulationCurrency;
  preset?: AiSimulationPreset;
  riskTolerance?: number;
  selection?: AiSimulationSelectionRequest;
  strategy?: AiSimulationStrategyRequest;
  selected: AiSimulationSelection[];
  initialCash?: number;
  finalEquity?: number;
  returnRatio?: number;
  realizedPnl?: number;
  totalCosts?: number;
  tradeCount?: number;
  decisionCount?: number;
  model?: string;
  warnings: string[];
  strategyComparison?: AiSimulationStrategyComparison;
  modelComparison?: AiSimulationModelComparison;
};

export type AiSimulationHistoryPage = {
  items: AiSimulationHistoryItem[];
  nextCursor?: string;
};

export type AiSimulationReportConfiguration = {
  market?: AiSimulationMarket;
  marketCountry?: AiSimulationMarketCountry;
  initialCash?: number;
  durationMinutes?: number;
  preset?: AiSimulationPreset;
  riskTolerance?: number;
  selection?: AiSimulationSelectionRequest;
  strategy?: AiSimulationStrategyRequest;
  costs?: Partial<AiSimulationCosts>;
  modelLanes?: AiSimulationModelLane[];
  executionMode?: AiSimulationExecutionMode;
};

export type AiSimulationReportPerformance = {
  currency: AiSimulationCurrency;
  initialCash?: number;
  finalEquity?: number;
  cash?: number;
  pnl?: number;
  returnRatio?: number;
  realizedPnl?: number;
  unrealizedPnl?: number;
  totalCosts?: number;
  tradeCount?: number;
  decisionCount?: number;
};

export type AiSimulationEquityPoint = {
  timestamp: string;
  equity: number;
  cash?: number;
};

export type AiSimulationReportEvidence = {
  label: string;
  value?: string;
};

export type AiSimulationDecisionModelProvenance = {
  component: "kronos" | AiSimulationModelLane;
  status: string;
  modelId?: string;
  modelRevision?: string;
  origin?: string;
  generatedAt?: string;
  device?: string;
  deviceName?: string;
  latencyMs?: number;
  degraded: boolean;
};

export type AiSimulationDecisionProvenance = {
  decisionId?: string;
  pairId?: string;
  signalSymbol?: string;
  executionSymbol?: string;
  direction?: string;
  origin?: string;
  decisionAt?: string;
  degraded: boolean;
  models: AiSimulationDecisionModelProvenance[];
};

export type AiSimulationRunReport = {
  runId: string;
  status: string;
  startedAt?: string;
  finishedAt?: string;
  configuration: AiSimulationReportConfiguration;
  selected: AiSimulationSelection[];
  performance: AiSimulationReportPerformance;
  decisionCadence?: AiSimulationSnapshot["decisionCadence"];
  decisions: AiSimulationDecision[];
  trades: AiSimulationTrade[];
  positions: AiSimulationPosition[];
  equity: AiSimulationEquityPoint[];
  charts: AiSimulationChartView[];
  modelProvenance: string[];
  decisionProvenance: AiSimulationDecisionProvenance[];
  modelForecasts?: AiSimulationModelForecast[];
  kronosForecasts: AiSimulationKronosForecast[];
  evidence: AiSimulationReportEvidence[];
  warnings: string[];
  limits: string[];
  strategyComparison?: AiSimulationStrategyComparison;
  futuresPositions?: AiSimulationFuturesPosition[];
  futuresRisk?: AiSimulationFuturesRisk;
  modelComparison?: AiSimulationModelComparison;
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
  strategy: { mode: "single" },
  costs: defaultAiSimulationCosts("KR"),
  modelLanes: [AI_SIMULATION_MAIN_MODEL_LANE],
  fincastCandleSeconds: 60,
  execution: { mode: "paper" },
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

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function simulationCaseValue(value: unknown): AiSimulationCase | undefined {
  const candidate = textValue(value);
  return candidate === "btc_eth"
    || candidate === "high_vol_crypto"
    || candidate === "us_etf_pair"
    ? candidate
    : undefined;
}

function normalizeModelPlan(value: unknown): AiSimulationModelPlanEntry[] {
  return mapValid(value, (entry): AiSimulationModelPlanEntry | undefined => {
    const source = asRecord(entry);
    const symbol = textValue(source.symbol)?.toUpperCase();
    const modelLane = textValue(first(source, "modelLane", "model_lane"));
    const role = textValue(source.role);
    const required = booleanValue(source.required);
    const rawHorizons = first(
      source,
      "preferredHorizonsMinutes",
      "preferred_horizons_minutes",
    );
    const horizons = (Array.isArray(rawHorizons) ? rawHorizons : [])
      .map(finiteNumber)
      .filter((item): item is 5 | 15 | 30 | 60 => (
        item === 5 || item === 15 || item === 30 || item === 60
      ));
    if (
      !symbol
      || !AI_SIMULATION_MODEL_LANES.includes(modelLane as AiSimulationModelLane)
      || !["primary", "veto", "shadow"].includes(role ?? "")
      || required === undefined
      || horizons.length === 0
    ) return undefined;
    return {
      symbol,
      modelLane: modelLane as AiSimulationModelLane,
      role: role as AiSimulationModelRole,
      required,
      preferredHorizonsMinutes: horizons,
    };
  });
}

function nonNegativeInteger(value: unknown): number | undefined {
  const number = finiteNumber(value);
  return number !== undefined && Number.isInteger(number) && number >= 0 ? number : undefined;
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

function finiteCosts(value: unknown): Partial<AiSimulationCosts> | undefined {
  const source = asRecord(value);
  const result: Partial<AiSimulationCosts> = {};
  const fields: Array<[keyof AiSimulationCosts, string[]]> = [
    ["commissionBpsPerSide", ["commissionBpsPerSide", "commission_bps_per_side"]],
    ["taxBpsOnExit", ["taxBpsOnExit", "tax_bps_on_exit"]],
    ["spreadBpsRoundTrip", ["spreadBpsRoundTrip", "spread_bps_round_trip"]],
    ["slippageBpsPerSide", ["slippageBpsPerSide", "slippage_bps_per_side"]],
  ];
  for (const [key, aliases] of fields) {
    const number = finiteNumber(first(source, ...aliases));
    if (number !== undefined) result[key] = number;
  }
  return Object.keys(result).length ? result : undefined;
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

function pairIdValue(value: unknown): AiSimulationPairId | undefined {
  const candidate = textValue(value);
  return AI_SIMULATION_PAIR_IDS.includes(candidate as AiSimulationPairId)
    ? candidate as AiSimulationPairId
    : undefined;
}

function staticPairCatalogItem(id: AiSimulationPairId): AiSimulationPairCatalogItem {
  return AI_SIMULATION_PAIR_CATALOG.find((item) => item.id === id)
    ?? { id, label: id, symbols: id.split("-").map((symbol) => symbol.toUpperCase()) };
}

function normalizePairCatalogItem(value: unknown): AiSimulationPairCatalogItem | undefined {
  const directId = pairIdValue(value);
  if (directId) return staticPairCatalogItem(directId);
  const item = asRecord(value);
  const id = pairIdValue(first(item, "id", "pairId", "pair_id", "value"));
  if (!id) return undefined;
  const fallback = staticPairCatalogItem(id);
  const bull = asRecord(item.bull);
  const bear = asRecord(item.bear);
  const symbols = [
    ...stringList(first(item, "symbols", "instruments", "legs")),
    textValue(first(item, "signalSymbol", "signal_symbol")),
    textValue(first(item, "displaySignalSymbol", "display_signal_symbol")),
    textValue(first(item, "modelTargetSymbol", "model_target_symbol")),
    ...stringList(first(item, "auxiliarySymbols", "auxiliary_symbols")),
    textValue(first(bull, "executionSymbol", "execution_symbol", "symbol")),
    textValue(first(bear, "executionSymbol", "execution_symbol", "symbol")),
  ].filter((symbol): symbol is string => Boolean(symbol))
    .map((symbol) => symbol.toUpperCase())
    .filter((symbol, index, all) => all.indexOf(symbol) === index);
  return {
    id,
    label: textValue(first(item, "label", "name", "title")) ?? fallback.label,
    symbols: symbols.length ? symbols : fallback.symbols,
    displaySignalSymbol: textValue(first(
      item,
      "displaySignalSymbol",
      "display_signal_symbol",
    )) ?? fallback.displaySignalSymbol,
    modelTargetSymbol: textValue(first(
      item,
      "modelTargetSymbol",
      "model_target_symbol",
      "signalSymbol",
      "signal_symbol",
    )) ?? fallback.modelTargetSymbol,
    auxiliarySymbols: stringList(first(
      item,
      "auxiliarySymbols",
      "auxiliary_symbols",
    )),
  };
}

function normalizePairCatalog(value: unknown): AiSimulationPairCatalogItem[] {
  const catalog = mapValid(value, normalizePairCatalogItem);
  return catalog.filter((item, index, all) => all.findIndex(({ id }) => id === item.id) === index);
}

function normalizeStrategyRequest(value: unknown): AiSimulationStrategyRequest | undefined {
  const strategy = asRecord(value);
  const mode = textValue(strategy.mode);
  if (mode === "single") return { mode };
  if (mode !== "pair") return undefined;
  const pairId = pairIdValue(first(strategy, "pairId", "pair_id"));
  const allowDegradedMode = booleanValue(first(
    strategy,
    "allowDegradedMode",
    "allow_degraded_mode",
  ));
  return pairId && allowDegradedMode !== undefined
    ? { mode, pairId, allowDegradedMode: false }
    : undefined;
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

function knownAiSimulationModelLabel(value: unknown): string | undefined {
  const label = modelLabel(value);
  if (!label) return undefined;
  const normalized = label.toLowerCase();
  const knownIds = [
    "neoquasar/kronos-base",
    "vincent05r/fincast",
  ].filter((modelId) => normalized.includes(modelId));
  return knownIds.length === 1 ? label : undefined;
}

function normalizeCostSource(value: unknown): AiSimulationCostSource | undefined {
  const source = asRecord(value);
  const label = textValue(source.label);
  const url = textValue(source.url);
  return label && url ? { label, url } : undefined;
}

function normalizeCostProfile(
  value: unknown,
  expectedMarket: AiSimulationMarketCountry,
): AiSimulationCostProfile | undefined {
  const profile = asRecord(value);
  const marketCountry = textValue(first(profile, "marketCountry", "market_country"));
  const currency = textValue(profile.currency);
  const requiredNumbers = {
    commissionBpsPerSide: finiteNumber(first(
      profile,
      "commissionBpsPerSide",
      "commission_bps_per_side",
    )),
    sellTaxBps: finiteNumber(first(profile, "sellTaxBps", "sell_tax_bps")),
    sellRegulatoryBps: finiteNumber(first(
      profile,
      "sellRegulatoryBps",
      "sell_regulatory_bps",
    )),
    sellRegulatoryFeePerShare: finiteNumber(first(
      profile,
      "sellRegulatoryFeePerShare",
      "sell_regulatory_fee_per_share",
    )),
    spreadBpsRoundTrip: finiteNumber(first(
      profile,
      "spreadBpsRoundTrip",
      "spread_bps_round_trip",
    )),
    slippageBpsPerSide: finiteNumber(first(
      profile,
      "slippageBpsPerSide",
      "slippage_bps_per_side",
    )),
  };
  if (marketCountry !== expectedMarket
    || (currency !== "KRW" && currency !== "USD")
    || Object.values(requiredNumbers).some((number) => number === undefined)) {
    return undefined;
  }
  const alternativeVenues = mapValid(
    first(profile, "alternativeVenues", "alternative_venues"),
    (entry): AiSimulationCostProfile["alternativeVenues"][number] | undefined => {
      const item = asRecord(entry);
      const venue = textValue(item.venue);
      const commissionBpsPerSide = finiteNumber(first(
        item,
        "commissionBpsPerSide",
        "commission_bps_per_side",
      ));
      return venue && commissionBpsPerSide !== undefined
        ? { venue, commissionBpsPerSide }
        : undefined;
    },
  );
  return {
    profileVersion: textValue(first(profile, "profileVersion", "profile_version")) ?? "unknown",
    profileId: textValue(first(profile, "profileId", "profile_id")) ?? "unknown",
    broker: textValue(profile.broker) ?? "Toss Securities",
    marketCountry: expectedMarket,
    currency,
    venue: textValue(profile.venue) ?? expectedMarket,
    effectiveFrom: textValue(first(profile, "effectiveFrom", "effective_from")),
    verifiedAt: textValue(first(profile, "verifiedAt", "verified_at")),
    commissionBpsPerSide: requiredNumbers.commissionBpsPerSide!,
    commissionFreeGrossAmountMaximum: finiteNumber(first(
      profile,
      "commissionFreeGrossAmountMaximum",
      "commission_free_gross_amount_maximum",
    )),
    sellTaxBps: requiredNumbers.sellTaxBps!,
    sellRegulatoryBps: requiredNumbers.sellRegulatoryBps!,
    sellRegulatoryFeePerShare: requiredNumbers.sellRegulatoryFeePerShare!,
    sellRegulatoryFeeMaximum: finiteNumber(first(
      profile,
      "sellRegulatoryFeeMaximum",
      "sell_regulatory_fee_maximum",
    )),
    spreadBpsRoundTrip: requiredNumbers.spreadBpsRoundTrip!,
    slippageBpsPerSide: requiredNumbers.slippageBpsPerSide!,
    fxConversionIncluded: booleanValue(first(
      profile,
      "fxConversionIncluded",
      "fx_conversion_included",
    )) ?? false,
    alternativeVenues,
    scopeNotes: stringList(first(profile, "scopeNotes", "scope_notes")),
    sources: mapValid(profile.sources, normalizeCostSource),
  };
}

export function normalizeAiSimulationStatus(payload: unknown): AiSimulationStatus {
  const root = asRecord(payload);
  const nested = asRecord(root.status);
  const source = Object.keys(nested).length ? { ...root, ...nested } : root;
  const limits = asRecord(source.limits);
  const initialCash = asRecord(first(limits, "initialCash", "initial_cash"));
  const duration = asRecord(first(limits, "durationMinutes", "duration_minutes", "duration"));
  const enabled = typeof source.enabled === "boolean" ? source.enabled : true;
  const capabilities = capabilityRecord(source.capabilities);
  const pairStrategyValue = first(source, "pairStrategy", "pair_strategy");
  const pairStrategy = asRecord(pairStrategyValue);
  const pairCatalog = normalizePairCatalog(
    first(pairStrategy, "catalog", "pairs", "strategies")
      ?? first(source, "pairCatalog", "pair_catalog", "pairStrategyCatalog", "pair_strategy_catalog"),
  );
  const capabilityGate = [
    "pairStrategy",
    "pair_strategy",
    "pairMode",
    "pair_mode",
    "strategyPair",
    "strategy_pair",
  ].some((key) => capabilities[key] === true);
  const pairEnabled = booleanValue(first(pairStrategy, "enabled", "available", "supported"))
    ?? booleanValue(pairStrategyValue)
    ?? (capabilityGate ? true : undefined);
  const hasPairStrategy = pairEnabled !== undefined
    || Object.keys(pairStrategy).length > 0
    || pairCatalog.length > 0;
  const rawCostProfiles = asRecord(first(source, "costProfiles", "cost_profiles"));
  const costProfiles = Object.fromEntries((["KR", "US"] as const).flatMap((market) => {
    const profile = normalizeCostProfile(
      first(rawCostProfiles, market, market.toLowerCase()),
      market,
    );
    return profile ? [[market, profile] as const] : [];
  })) as Partial<Record<AiSimulationMarketCountry, AiSimulationCostProfile>>;
  const cryptoStatusValue = first(
    source,
    "cryptoFutures",
    "crypto_futures",
    "binance",
    "crypto",
  );
  const hasCryptoStatus = cryptoStatusValue !== undefined
    || [
      "credentialsConfigured",
      "credentials_configured",
      "signedReadSucceeded",
      "signed_read_succeeded",
      "workers",
      "modelWorkers",
      "model_workers",
    ].some((key) => source[key] !== undefined)
    || capabilities.cryptoFutures === true
    || capabilities.crypto_futures === true;

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
    capabilities,
    limitations: stringList(first(source, "limitations", "warnings")),
    ...(Object.keys(costProfiles).length ? { costProfiles } : {}),
    ...(hasCryptoStatus
      ? { cryptoFutures: normalizeAiSimulationCryptoStatus(source) }
      : {}),
    ...(hasPairStrategy ? {
      pairStrategy: {
        enabled: pairEnabled ?? false,
        message: textValue(first(pairStrategy, "message", "reason", "limitation")),
        catalog: pairCatalog,
      },
    } : {}),
  };
}

export function aiSimulationPairStrategyEnabled(status?: AiSimulationStatus): boolean {
  if (!status) return false;
  if (status.pairStrategy) return status.pairStrategy.enabled;
  return [
    "pairStrategy",
    "pair_strategy",
    "pairMode",
    "pair_mode",
    "strategyPair",
    "strategy_pair",
  ].some((key) => status.capabilities[key] === true);
}

export function aiSimulationPairCatalog(
  status?: AiSimulationStatus,
): readonly AiSimulationPairCatalogItem[] {
  return status?.pairStrategy?.catalog.length
    ? status.pairStrategy.catalog
    : AI_SIMULATION_PAIR_CATALOG;
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
    currentPrice: finiteNumber(first(
      item,
      "currentPrice",
      "current_price",
      "marketPrice",
      "market_price",
      "price",
    )),
    priceObservedAt: textValue(first(
      item,
      "priceObservedAt",
      "price_observed_at",
      "observedAt",
      "observed_at",
      "updatedAt",
      "updated_at",
    )),
    model: knownAiSimulationModelLabel(item.model),
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
    positionSide: (
      ["long", "short"] as const
    ).find((candidate) => candidate === textValue(first(item, "positionSide", "position_side", "direction"))?.toLowerCase()),
    reduceOnly: booleanValue(first(item, "reduceOnly", "reduce_only")),
    funding: finiteNumber(first(item, "funding", "fundingCost", "funding_cost")),
    realizedPnl: finiteNumber(first(item, "realizedPnl", "realized_pnl")),
  };
}

function normalizeDecision(value: unknown): AiSimulationDecision | undefined {
  const item = asRecord(value);
  const signalSymbol = textValue(first(item, "signalSymbol", "signal_symbol"));
  const executionSymbol = textValue(first(item, "executionSymbol", "execution_symbol"));
  const symbol = textValue(item.symbol) ?? executionSymbol ?? signalSymbol;
  const action = textValue(item.action);
  const decidedAt = textValue(first(
    item,
    "decidedAt",
    "decided_at",
    "decisionAt",
    "decision_at",
    "forecastGeneratedAt",
    "forecast_generated_at",
    "generatedAt",
    "generated_at",
    "inputEndAt",
    "input_end_at",
    "originAt",
    "origin_at",
  ));
  const listedReasons = stringList(item.reasons);
  const listedReason = listedReasons.join(" · ");
  const reason = textValue(item.reason) ?? (listedReason || undefined);
  if (!symbol || !action || !decidedAt || !reason) return undefined;
  const components = finiteNumberRecord(item.components);
  const weights = finiteNumberRecord(item.weights);
  const finalScores = finiteNumberRecord(first(item, "finalScores", "final_scores"));
  const provenance = normalizeModelProvenance(first(
    item,
    "provenance",
    "modelProvenance",
    "model_provenance",
  ));
  return {
    symbol,
    action,
    decidedAt,
    eligibleAfter: textValue(first(
      item,
      "eligibleAfter",
      "eligible_after",
      "fillEligibleAfter",
      "fill_eligible_after",
    )),
    reason,
    reasons: listedReasons.length ? listedReasons : [reason],
    score: finiteNumber(first(item, "score", "confidence")),
    upProbability: finiteNumber(first(
      item,
      "upProbability",
      "up_probability",
      "probabilityAboveCost",
      "probability_above_cost",
    )),
    q10Return: finiteNumber(first(
      item,
      "q10Return",
      "q10_return",
      "predictedQ10Return",
      "predicted_q10_return",
    )),
    predictedMedianReturn: finiteNumber(first(
      item,
      "predictedMedianReturn",
      "predicted_median_return",
      "medianReturn",
      "median_return",
    )),
    q90Return: finiteNumber(first(
      item,
      "q90Return",
      "q90_return",
      "predictedQ90Return",
      "predicted_q90_return",
    )),
    technicalState: textValue(first(item, "technicalState", "technical_state")),
    technicalScore: finiteNumber(first(item, "technicalScore", "technical_score")),
    technicalDirection: textValue(first(
      item,
      "technicalDirection",
      "technical_direction",
    )),
    technicalOriginAt: textValue(first(item, "technicalOriginAt", "technical_origin_at")),
    exposureScale: finiteNumber(first(item, "exposureScale", "exposure_scale")),
    modelEvidenceScale: finiteNumber(first(
      item,
      "modelEvidenceScale",
      "model_evidence_scale",
    )),
    fusionPolicyVersion: textValue(first(
      item,
      "fusionPolicyVersion",
      "fusion_policy_version",
    )),
    signalSymbol,
    executionSymbol,
    direction: textValue(item.direction),
    degraded: booleanValue(item.degraded),
    ...(Object.keys(components).length ? { components } : {}),
    ...(Object.keys(weights).length ? { weights } : {}),
    ...(Object.keys(finalScores).length ? { finalScores } : {}),
    ...(provenance.length ? { provenance } : {}),
    chartPatternBias: (
      ["bullish", "bearish", "neutral"] as const
    ).find((candidate) => candidate === first(item, "chartPatternBias", "chart_pattern_bias")),
    chartPatternStrength: finiteNumber(first(
      item,
      "chartPatternStrength",
      "chart_pattern_strength",
    )),
    chartPatterns: stringList(first(item, "chartPatterns", "chart_patterns")),
    model: knownAiSimulationModelLabel(item.model),
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
    currency: item.currency === "USDT" ? "USDT" : item.currency === "USD" ? "USD" : "KRW",
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

function comparisonLaneId(value: unknown): AiSimulationComparisonLaneId | undefined {
  const raw = textValue(value)?.toLowerCase().replaceAll("_", "-");
  const candidate = raw === "kronos-base" || raw === "kronosbase"
    ? "kronos"
    : raw;
  return AI_SIMULATION_COMPARISON_LANES.includes(candidate as AiSimulationComparisonLaneId)
    ? candidate as AiSimulationComparisonLaneId
    : undefined;
}

function normalizeComparisonDecisionReason(
  value: unknown,
): AiSimulationComparisonDecisionReason | undefined {
  const direct = textValue(value);
  if (direct) return { reason: direct, reasons: [direct] };
  const item = asRecord(value);
  const reasons = stringList(item.reasons);
  const reason = textValue(first(item, "reason", "summary", "detail"))
    ?? (reasons.length ? reasons.join(" · ") : undefined);
  if (!reason) return undefined;
  return {
    reason,
    reasons: reasons.length ? reasons : [reason],
    symbol: textValue(item.symbol),
    signalSymbol: textValue(first(item, "signalSymbol", "signal_symbol")),
    executionSymbol: textValue(first(item, "executionSymbol", "execution_symbol")),
    action: textValue(item.action),
    decidedAt: textValue(first(
      item,
      "decidedAt",
      "decided_at",
      "timestamp",
      "at",
    )),
  };
}

function comparisonReasonList(value: unknown): AiSimulationComparisonDecisionReason[] {
  if (Array.isArray(value)) return mapValid(value, normalizeComparisonDecisionReason);
  const direct = normalizeComparisonDecisionReason(value);
  return direct ? [direct] : [];
}

function normalizeStrategyComparisonLane(value: unknown): AiSimulationStrategyComparisonLane | undefined {
  const lane = asRecord(value);
  const id = comparisonLaneId(first(lane, "id", "strategy", "lane", "model", "name"));
  const status = textValue(first(lane, "status", "state", "availability"));
  if (!id || !status) return undefined;
  return {
    id,
    status,
    analyticalOnly: booleanValue(first(lane, "analyticalOnly", "analytical_only")),
    unavailableReason: textValue(first(
      lane,
      "unavailableReason",
      "unavailable_reason",
      "error",
    )),
    cumulativeReturn: finiteNumber(first(lane, "cumulativeReturn", "cumulative_return")),
    netReturn: finiteNumber(first(lane, "netReturn", "net_return")),
    netProfit: finiteNumber(first(lane, "netProfit", "net_profit")),
    maxDrawdown: finiteNumber(first(lane, "maxDrawdown", "max_drawdown")),
    riskAdjustedReturn: finiteNumber(first(
      lane,
      "riskAdjustedReturn",
      "risk_adjusted_return",
    )),
    trades: nonNegativeInteger(first(lane, "trades", "tradeCount", "trade_count")),
    costs: finiteNumber(first(lane, "costs", "totalCosts", "total_costs")),
    switches: nonNegativeInteger(first(
      lane,
      "switches",
      "switchCount",
      "switch_count",
      "transitionCount",
      "transition_count",
    )),
    directionAccuracy: finiteNumber(first(
      lane,
      "directionAccuracy",
      "direction_accuracy",
    )),
    executionAccuracy: finiteNumber(first(
      lane,
      "executionAccuracy",
      "execution_accuracy",
      "executionSelectionAccuracy",
      "execution_selection_accuracy",
    )),
    calibration: finiteNumber(first(
      lane,
      "calibration",
      "calibrationScore",
      "calibration_score",
    )),
    calibrationUnavailableRatio: finiteNumber(first(
      lane,
      "calibrationUnavailableRatio",
      "calibration_unavailable_ratio",
      "calibrationUnavailableRate",
      "calibration_unavailable_rate",
    )),
    unavailableRatio: finiteNumber(first(
      lane,
      "unavailableRatio",
      "unavailable_ratio",
      "unavailableRate",
      "unavailable_rate",
    )),
    latencyMs: finiteNumber(first(
      lane,
      "latencyMs",
      "latency_ms",
      "averageLatencyMs",
      "average_latency_ms",
      "latency",
    )),
    bullCount: nonNegativeInteger(first(lane, "bullCount", "bull_count")),
    bearCount: nonNegativeInteger(first(lane, "bearCount", "bear_count")),
    cashCount: nonNegativeInteger(first(lane, "cashCount", "cash_count")),
    decisionReasons: comparisonReasonList(first(
      lane,
      "decisionReasons",
      "decision_reasons",
      "reasons",
      "decisions",
    )),
  };
}

function normalizeStrategyComparison(value: unknown): AiSimulationStrategyComparison | undefined {
  const comparison = asRecord(value);
  if (!Object.keys(comparison).length) return undefined;
  const common = asRecord(comparison.common);
  const conditionId = textValue(first(comparison, "conditionId", "condition_id"))
    ?? textValue(first(common, "conditionId", "condition_id"));
  const originCount = nonNegativeInteger(first(common, "originCount", "origin_count"));
  const commonCosts = first(common, "costs", "costModel", "cost_model");
  const commonExecutionPolicy = first(common, "executionPolicy", "execution_policy");
  const sameOrigin = booleanValue(first(comparison, "sameOrigin", "same_origin"))
    ?? booleanValue(first(common, "sameOrigin", "same_origin"))
    ?? (originCount !== undefined ? originCount === 1 : undefined);
  const sameCosts = booleanValue(first(comparison, "sameCosts", "same_costs"))
    ?? booleanValue(first(common, "sameCosts", "same_costs"))
    ?? (commonCosts !== undefined ? true : undefined);
  const sameExecutionPolicy = booleanValue(first(
    comparison,
    "sameExecutionPolicy",
    "same_execution_policy",
  )) ?? booleanValue(first(common, "sameExecutionPolicy", "same_execution_policy"))
    ?? (commonExecutionPolicy !== undefined ? true : undefined);
  const rawLanes = first(comparison, "lanes", "strategies", "variants");
  const lanes = Array.isArray(rawLanes)
    ? mapValid(rawLanes, normalizeStrategyComparisonLane)
    : Object.entries(asRecord(rawLanes)).flatMap(([id, rawLane]) => {
      const lane = asRecord(rawLane);
      return normalizeStrategyComparisonLane({
        ...lane,
        id: first(lane, "id", "strategy", "lane", "model", "name") ?? id,
      }) ?? [];
    });
  const uniqueLanes = lanes.filter(
    (lane, index, all) => all.findIndex((candidate) => candidate.id === lane.id) === index,
  );
  if (!conditionId
    || sameOrigin === undefined
    || sameCosts === undefined
    || sameExecutionPolicy === undefined
    || uniqueLanes.length !== AI_SIMULATION_COMPARISON_LANES.length
    || AI_SIMULATION_COMPARISON_LANES.some((id) => !uniqueLanes.some((lane) => lane.id === id))) {
    return undefined;
  }
  const completedStatuses = new Set(["available", "complete", "completed", "ready", "running"]);
  const calculatedIncomplete = uniqueLanes.filter(
    ({ status }) => !completedStatuses.has(status.toLowerCase()),
  ).length;
  const reportedIncomplete = nonNegativeInteger(first(
    comparison,
    "incompleteCount",
    "incomplete_count",
    "incompleteLaneCount",
    "incomplete_lane_count",
  ));
  const pairId = pairIdValue(first(comparison, "pairId", "pair_id"));
  return {
    conditionId,
    ...(pairId ? { pairId } : {}),
    sameOrigin,
    sameCosts,
    sameExecutionPolicy,
    incompleteCount: reportedIncomplete !== undefined && reportedIncomplete <= uniqueLanes.length
      ? reportedIncomplete
      : calculatedIncomplete,
    lanes: AI_SIMULATION_COMPARISON_LANES.map(
      (id) => uniqueLanes.find((lane) => lane.id === id)!,
    ),
  };
}

function normalizedCadence(value: unknown): AiSimulationSnapshot["decisionCadence"] | undefined {
  const cadence = asRecord(value);
  if (!Object.keys(cadence).length) return undefined;
  return {
    trigger: textValue(cadence.trigger),
    inferenceIntervalSeconds: finiteNumber(first(
      cadence,
      "inferenceIntervalSeconds",
      "inference_interval_seconds",
    )),
    triggeredEvents: finiteNumber(first(cadence, "triggeredEvents", "triggered_events")),
    coalescedEvents: finiteNumber(first(cadence, "coalescedEvents", "coalesced_events")),
    duplicateEvents: finiteNumber(first(cadence, "duplicateEvents", "duplicate_events")),
    inFlight: typeof first(cadence, "inFlight", "in_flight") === "boolean"
      ? first(cadence, "inFlight", "in_flight") as boolean
      : undefined,
    lastTriggeredAt: textValue(first(cadence, "lastTriggeredAt", "last_triggered_at")),
    lastStartedAt: textValue(first(cadence, "lastStartedAt", "last_started_at")),
    lastFinishedAt: textValue(first(cadence, "lastFinishedAt", "last_finished_at")),
  };
}

export function normalizeAiSimulationSnapshot(payload: unknown): AiSimulationSnapshot {
  const outer = asRecord(payload);
  const source = Object.keys(asRecord(outer.snapshot)).length ? asRecord(outer.snapshot) : outer;
  const legacyMarket = textValue(first(source, "marketCountry", "market_country"));
  const market = normalizeAiSimulationMarket(source.market, legacyMarket);
  const currency = textValue(source.currency);
  const rawProgress = finiteNumber(source.progress) ?? 0;
  const rawPreset = textValue(source.preset);
  const rawCriterion = textValue(source.criterion);
  const rawSelection = normalizeSelectionRequest(source.selection);
  const strategy = normalizeStrategyRequest(source.strategy);
  const strategyComparison = normalizeStrategyComparison(first(
    source,
    "strategyComparison",
    "strategy_comparison",
  ) ?? first(outer, "strategyComparison", "strategy_comparison"));
  const cadence = asRecord(first(source, "decisionCadence", "decision_cadence"));
  const profile = asRecord(first(source, "policyProfile", "policy_profile"));
  const modelLanes = stringList(first(source, "modelLanes", "model_lanes"))
    .map((lane) => lane.toLowerCase().replaceAll("-", "_"))
    .filter((lane): lane is AiSimulationModelLane => (
      AI_SIMULATION_MODEL_LANES.includes(lane as AiSimulationModelLane)
    ))
    .filter((lane, index, all) => all.indexOf(lane) === index);
  const execution = asRecord(source.execution);
  const executionModeValue = textValue(first(
    execution,
    "mode",
    "executionMode",
    "execution_mode",
  )) ?? textValue(first(source, "executionMode", "execution_mode"));
  const executionMode = (
    ["paper", "testnet", "live"] as const
  ).find((candidate) => candidate === executionModeValue);
  const futuresPositions = market?.kind === "crypto_futures"
    ? normalizeAiSimulationFuturesPositions(
        first(source, "futuresPositions", "futures_positions") ?? source.positions,
      )
    : [];
  const futuresRisk = normalizeAiSimulationFuturesRisk(first(
    source,
    "futuresRisk",
    "futures_risk",
    "riskState",
    "risk_state",
  ));
  const modelComparison = normalizeAiSimulationModelComparison(first(
    source,
    "modelComparison",
    "model_comparison",
  ) ?? first(outer, "modelComparison", "model_comparison"));
  const explicitSimulationCase = simulationCaseValue(first(
    source,
    "simulationCase",
    "simulation_case",
  ));
  const simulationCase = explicitSimulationCase
    ?? (market?.kind === "crypto_futures"
      ? rawSelection?.mode === "manual"
        && rawSelection.symbols.every(
          (symbol) => symbol === "BTCUSDT" || symbol === "ETHUSDT",
        )
        ? "btc_eth"
        : "high_vol_crypto"
      : market?.kind === "stock"
        && market.country === "US"
        && strategy?.mode === "pair"
        ? "us_etf_pair"
        : undefined);
  const modelPlan = normalizeModelPlan(first(source, "modelPlan", "model_plan"));
  const legacyKronosForecasts = selectLatestKronosForecasts(source.decisions);
  const modelForecasts = mergeLatestModelForecasts(
    normalizeAiSimulationModelForecasts(first(
      source,
      "modelForecasts",
      "model_forecasts",
    )),
    legacyKronosForecasts.map((forecast) => ({
      ...forecast,
      lane: "kronos_base" as const,
    })),
  );

  return {
    phase: textValue(source.phase) ?? "queued",
    startedAt: textValue(first(source, "startedAt", "started_at")),
    expiresAt: textValue(first(source, "expiresAt", "expires_at")),
    market,
    marketCountry: market?.kind === "stock" ? market.country : undefined,
    ...(simulationCase ? { simulationCase } : {}),
    ...(modelPlan.length ? { modelPlan } : {}),
    currency: market?.kind === "crypto_futures" || currency === "USDT"
      ? "USDT"
      : currency === "USD"
        ? "USD"
        : "KRW",
    initialCash: finiteNumber(first(source, "initialCash", "initial_cash")) ?? 0,
    cash: finiteNumber(source.cash) ?? 0,
    equity: finiteNumber(source.equity) ?? 0,
    progress: Math.max(0, Math.min(1, rawProgress)),
    selection: rawSelection,
    ...(strategy ? { strategy } : {}),
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
    decisionCadence: normalizedCadence(cadence),
    selected: mapValid(source.selected, normalizeSelection),
    positions: mapValid(source.positions, normalizePosition),
    charts: mapValid(source.charts, normalizeChartView),
    trades: mapValid(source.trades, normalizeTrade),
    decisions: mapValid(source.decisions, normalizeDecision),
    modelForecasts,
    kronosForecasts: modelForecasts
      .filter((forecast) => forecast.lane === "kronos_base")
      .map(({ lane: _lane, ...forecast }) => forecast),
    warnings: stringList(source.warnings),
    capabilities: capabilityRecord(source.capabilities),
    ...(strategyComparison ? { strategyComparison } : {}),
    futuresPositions,
    ...(futuresRisk ? { futuresRisk } : {}),
    modelLanes,
    ...(executionMode ? { executionMode } : {}),
    ...(modelComparison ? { modelComparison } : {}),
    modelEvidence: Array.isArray(first(source, "modelEvidence", "model_evidence"))
      ? first(source, "modelEvidence", "model_evidence") as unknown[]
      : [],
    unifiedPolicyDecisions: Array.isArray(first(
      source,
      "unifiedPolicyDecisions",
      "unified_policy_decisions",
    ))
      ? first(source, "unifiedPolicyDecisions", "unified_policy_decisions") as unknown[]
      : [],
    pairMapping: first(source, "pairMapping", "pair_mapping"),
    etfSessionGate: first(source, "etfSessionGate", "etf_session_gate"),
    highVolatilityScanner: first(
      source,
      "highVolatilityScanner",
      "high_volatility_scanner",
    ),
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

function runIdentity(value: unknown): {
  runId?: string;
  status?: string;
  startedAt?: string;
  finishedAt?: string;
} {
  const run = asRecord(value);
  return {
    runId: textValue(first(run, "id", "runId", "run_id")),
    status: textValue(first(run, "status", "phase")),
    startedAt: textValue(first(
      run,
      "startedAt",
      "started_at",
      "createdAt",
      "created_at",
    )),
    finishedAt: textValue(first(
      run,
      "finishedAt",
      "finished_at",
      "completedAt",
      "completed_at",
      "endedAt",
      "ended_at",
      "updatedAt",
      "updated_at",
    )),
  };
}

function normalizeHistoryItem(value: unknown): AiSimulationHistoryItem | undefined {
  const item = asRecord(value);
  const run = runIdentity(item.run);
  const configuration = asRecord(first(item, "configuration", "config", "request"));
  const selectionBlock = asRecord(item.selection);
  const performance = asRecord(first(item, "performance", "result", "summary"));
  const market = textValue(first(
    configuration,
    "marketCountry",
    "market_country",
  )) ?? textValue(first(item, "marketCountry", "market_country"));
  const normalizedMarket = normalizeAiSimulationMarket(
    first(configuration, "market") ?? item.market,
    market,
  );
  const preset = textValue(configuration.preset) ?? textValue(item.preset);
  const selection = normalizeSelectionRequest(configuration.selection)
    ?? normalizeSelectionRequest(first(selectionBlock, "request", "configuration"))
    ?? normalizeSelectionRequest(item.selection);
  const strategy = normalizeStrategyRequest(configuration.strategy)
    ?? normalizeStrategyRequest(item.strategy);
  const strategyComparison = normalizeStrategyComparison(first(
    item,
    "strategyComparison",
    "strategy_comparison",
  ) ?? first(performance, "strategyComparison", "strategy_comparison"));
  const modelComparison = normalizeAiSimulationModelComparison(first(
    item,
    "modelComparison",
    "model_comparison",
  ) ?? first(performance, "modelComparison", "model_comparison"));
  const selected = mapValid(
    first(item, "selected", "symbols")
      ?? first(selectionBlock, "selected", "symbols", "instruments"),
    normalizeSelection,
  );
  const runId = run.runId
    ?? textValue(first(item, "runId", "run_id", "id"));
  if (!runId) return undefined;
  const initialCash = finiteNumber(first(
    performance,
    "initialCash",
    "initial_cash",
  )) ?? finiteNumber(first(configuration, "initialCash", "initial_cash"))
    ?? finiteNumber(first(item, "initialCash", "initial_cash"));
  const finalEquity = finiteNumber(first(
    performance,
    "finalEquity",
    "final_equity",
    "equity",
  )) ?? finiteNumber(first(item, "finalEquity", "final_equity", "equity"));
  const pnl = finiteNumber(first(performance, "pnl", "totalPnl", "total_pnl"))
    ?? finiteNumber(first(item, "netProfitLoss", "net_profit_loss", "pnl"))
    ?? (initialCash !== undefined && finalEquity !== undefined
      ? finalEquity - initialCash
      : undefined);
  const explicitReturn = finiteNumber(first(
    performance,
    "returnRatio",
    "return_ratio",
    "returnRate",
    "return_rate",
  )) ?? finiteNumber(first(item, "returnRatio", "return_ratio", "returnRate", "return_rate"));
  const model = knownAiSimulationModelLabel(first(
    item,
    "model",
    "modelProvenance",
    "model_provenance",
  ))
    ?? selected.map((entry) => entry.model).find((entry): entry is string => Boolean(entry));

  return {
    runId,
    status: run.status ?? textValue(first(item, "status", "phase")) ?? "unknown",
    startedAt: run.startedAt ?? textValue(first(
      item,
      "startedAt",
      "started_at",
      "createdAt",
      "created_at",
    )),
    finishedAt: run.finishedAt ?? textValue(first(
      item,
      "finishedAt",
      "finished_at",
      "completedAt",
      "completed_at",
      "endedAt",
      "ended_at",
    )),
    market: normalizedMarket,
    marketCountry: normalizedMarket?.kind === "stock" ? normalizedMarket.country : undefined,
    currency: first(performance, "currency") === "USDT"
      || configuration.currency === "USDT"
      || item.currency === "USDT"
      || normalizedMarket?.kind === "crypto_futures"
      ? "USDT"
      : first(performance, "currency") === "USD"
      || configuration.currency === "USD"
      || item.currency === "USD"
      || market === "US"
      ? "USD"
      : "KRW",
    preset: AI_SIMULATION_PRESETS.includes(preset as AiSimulationPreset)
      ? preset as AiSimulationPreset
      : undefined,
    riskTolerance: finiteNumber(first(configuration, "riskTolerance", "risk_tolerance"))
      ?? finiteNumber(first(item, "riskTolerance", "risk_tolerance")),
    selection,
    ...(strategy ? { strategy } : {}),
    selected,
    initialCash,
    finalEquity,
    returnRatio: explicitReturn
      ?? (initialCash !== undefined && initialCash > 0 && pnl !== undefined
        ? pnl / initialCash
        : undefined),
    realizedPnl: finiteNumber(first(performance, "realizedPnl", "realized_pnl"))
      ?? finiteNumber(first(item, "realizedPnl", "realized_pnl")),
    totalCosts: finiteNumber(first(performance, "totalCosts", "total_costs", "costs"))
      ?? finiteNumber(first(item, "totalCosts", "total_costs")),
    tradeCount: finiteNumber(first(performance, "tradeCount", "trade_count"))
      ?? finiteNumber(first(item, "tradeCount", "trade_count")),
    decisionCount: finiteNumber(first(performance, "decisionCount", "decision_count"))
      ?? finiteNumber(first(item, "decisionCount", "decision_count")),
    model,
    warnings: stringList(first(item, "warnings", "limitations")),
    ...(strategyComparison ? { strategyComparison } : {}),
    ...(modelComparison ? { modelComparison } : {}),
  };
}

export function normalizeAiSimulationHistory(payload: unknown): AiSimulationHistoryPage {
  const root = asRecord(payload);
  const nested = asRecord(first(root, "data", "history"));
  const source = Object.keys(nested).length ? nested : root;
  return {
    items: mapValid(first(source, "items", "runs", "results"), normalizeHistoryItem),
    nextCursor: textValue(first(source, "nextCursor", "next_cursor", "cursor")),
  };
}

function normalizeEquityPoint(value: unknown): AiSimulationEquityPoint | undefined {
  const item = asRecord(value);
  const timestamp = textValue(first(item, "timestamp", "at", "recordedAt", "recorded_at"));
  const equity = finiteNumber(first(item, "equity", "value"));
  if (!timestamp || !Number.isFinite(Date.parse(timestamp)) || equity === undefined) return undefined;
  return {
    timestamp,
    equity,
    cash: finiteNumber(item.cash),
  };
}

function normalizeEvidence(value: unknown): AiSimulationReportEvidence | undefined {
  const direct = textValue(value);
  if (direct) return { label: direct };
  const item = asRecord(value);
  const label = textValue(first(item, "label", "title", "name", "type", "kind", "key"));
  if (!label) return undefined;
  const directValue = first(item, "value", "detail", "summary", "reason", "description");
  return {
    label,
    value: textValue(directValue)
      ?? (finiteNumber(directValue) !== undefined ? String(finiteNumber(directValue)) : undefined),
  };
}

function normalizeModelProvenance(value: unknown): string[] {
  const direct = knownAiSimulationModelLabel(value);
  if (direct && (typeof value === "string" || !Array.isArray(value))) return [direct];
  const values = Array.isArray(value) ? value : Object.values(asRecord(value));
  return values
    .map(knownAiSimulationModelLabel)
    .filter((item): item is string => Boolean(item))
    .filter((item, index, all) => all.indexOf(item) === index);
}

function decisionModelValue(
  modelsValue: unknown,
  aliases: readonly string[],
): unknown {
  if (Array.isArray(modelsValue)) {
    return modelsValue.find((value) => {
      const model = asRecord(value);
      const candidate = textValue(first(model, "component", "id", "name"))
        ?.toLowerCase()
        .replaceAll("_", "-");
      return aliases.some(
        (alias) => alias.toLowerCase().replaceAll("_", "-") === candidate,
      );
    });
  }
  return first(asRecord(modelsValue), ...aliases);
}

function normalizeDecisionModelProvenance(
  value: unknown,
  parentOrigin: string | undefined,
  component: "kronos" | AiSimulationModelLane,
): AiSimulationDecisionModelProvenance | undefined {
  const model = asRecord(value);
  if (!Object.keys(model).length) return undefined;
  const provenance = asRecord(first(
    model,
    "provenance",
    "modelProvenance",
    "model_provenance",
  ));
  const status = textValue(first(model, "status", "state", "availability"));
  const fallbackFrom = textValue(first(
    provenance,
    "fallbackFrom",
    "fallback_from",
  )) ?? textValue(first(model, "fallbackFrom", "fallback_from"));
  const fallbackReason = textValue(first(
    provenance,
    "fallbackReason",
    "fallback_reason",
  )) ?? textValue(first(model, "fallbackReason", "fallback_reason"));
  const explicitFallback = booleanValue(first(
    provenance,
    "fallbackUsed",
    "fallback_used",
  )) ?? booleanValue(first(model, "fallbackUsed", "fallback_used"));
  const fallbackUsed = explicitFallback ?? Boolean(fallbackFrom || fallbackReason);
  const modelId = textValue(first(
    provenance,
    "modelId",
    "model_id",
  )) ?? textValue(first(model, "modelId", "model_id", "model"));
  const normalizedModelId = modelId?.toLowerCase();
  const expectedModel = component === "fincast"
    ? normalizedModelId?.includes("fincast") !== false
    : normalizedModelId === undefined || normalizedModelId === "neoquasar/kronos-base";
  if (fallbackUsed || !expectedModel) {
    return undefined;
  }
  const explicitDegraded = booleanValue(provenance.degraded)
    ?? booleanValue(model.degraded);
  const degraded = explicitDegraded === true
    || status?.toLowerCase() === "degraded";
  return {
    component,
    status: status ?? (degraded ? "degraded" : "unknown"),
    modelId,
    modelRevision: textValue(first(
      provenance,
      "modelRevision",
      "model_revision",
      "revision",
    )) ?? textValue(first(model, "modelRevision", "model_revision", "revision")),
    origin: textValue(first(
      model,
      "inputEndAt",
      "input_end_at",
      "origin",
    )) ?? textValue(first(
      provenance,
      "inputOriginAt",
      "input_origin_at",
      "origin",
    )) ?? parentOrigin,
    generatedAt: textValue(first(
      model,
      "generatedAt",
      "generated_at",
    )) ?? textValue(first(provenance, "generatedAt", "generated_at")),
    device: textValue(first(provenance, "device"))
      ?? textValue(first(model, "device")),
    deviceName: textValue(first(
      provenance,
      "deviceName",
      "device_name",
    )) ?? textValue(first(model, "deviceName", "device_name")),
    latencyMs: finiteNumber(first(
      provenance,
      "latencyMs",
      "latency_ms",
    )) ?? finiteNumber(first(model, "latencyMs", "latency_ms", "latency")),
    degraded,
  };
}

function normalizeDecisionProvenance(
  value: unknown,
): AiSimulationDecisionProvenance | undefined {
  const provenance = asRecord(value);
  if (!Object.keys(provenance).length) return undefined;
  const replayInput = asRecord(first(provenance, "replayInput", "replay_input"));
  const modelsValue = first(
    replayInput,
    "models",
    "modelOutputs",
    "model_outputs",
  ) ?? first(provenance, "models", "modelOutputs", "model_outputs");
  const origin = textValue(first(
    provenance,
    "origin",
    "inputEndAt",
    "input_end_at",
  )) ?? textValue(first(replayInput, "origin", "inputEndAt", "input_end_at"));
  const parentDegraded = booleanValue(provenance.degraded) ?? false;
  const kronos = normalizeDecisionModelProvenance(
    decisionModelValue(modelsValue, ["kronos", "kronosBase", "kronos_base", "kronos-base"]),
    origin,
    "kronos",
  );
  const fincast = normalizeDecisionModelProvenance(
    decisionModelValue(modelsValue, ["fincast", "finCast", "fin_cast", "fin-cast"]),
    origin,
    "fincast",
  );
  const models = [kronos, fincast].filter(
    (model): model is AiSimulationDecisionModelProvenance => Boolean(model),
  );
  if (!models.length) return undefined;
  const decision = asRecord(provenance.decision);
  return {
    decisionId: textValue(first(provenance, "decisionId", "decision_id")),
    pairId: textValue(first(provenance, "pairId", "pair_id")),
    signalSymbol: textValue(first(provenance, "signalSymbol", "signal_symbol")),
    executionSymbol: textValue(first(
      provenance,
      "executionSymbol",
      "execution_symbol",
    )),
    direction: textValue(first(provenance, "direction"))
      ?? textValue(first(decision, "direction", "action")),
    origin,
    decisionAt: textValue(first(provenance, "decisionAt", "decision_at")),
    degraded: parentDegraded || models.some((model) => model.degraded),
    models,
  };
}

function normalizeLimit(value: unknown): string | undefined {
  const direct = textValue(value);
  if (direct) return direct;
  const item = asRecord(value);
  const label = textValue(first(item, "label", "name", "key", "type"));
  const detail = textValue(first(item, "value", "detail", "description", "reason"));
  if (label && detail) return `${label} · ${detail}`;
  return label ?? detail;
}

function normalizeReportEvidence(value: unknown): AiSimulationReportEvidence[] {
  if (Array.isArray(value)) return mapValid(value, normalizeEvidence);
  const source = asRecord(value);
  if (!Object.keys(source).length) {
    const direct = normalizeEvidence(value);
    return direct ? [direct] : [];
  }
  const evidence: AiSimulationReportEvidence[] = [];
  const patternCount = finiteNumber(first(source, "chartPatternCount", "chart_pattern_count"));
  if (patternCount !== undefined) {
    evidence.push({ label: "감지 차트 패턴", value: `${patternCount}건` });
  }
  const selection = asRecord(source.selection);
  if (Object.keys(selection).length) {
    const candidates = Array.isArray(selection.candidates)
      ? selection.candidates.length
      : Array.isArray(selection.selected)
        ? selection.selected.length
        : undefined;
    evidence.push({
      label: "종목 선정 근거",
      value: candidates === undefined ? "저장됨" : `${candidates}개 후보·선정 기록`,
    });
  }
  const artifacts = Array.isArray(source.artifacts) ? source.artifacts : [];
  for (const value of artifacts) {
    const artifact = asRecord(value);
    const type = textValue(first(artifact, "type", "artifactType", "artifact_type"));
    if (!type) continue;
    const rows = finiteNumber(first(artifact, "rowCount", "row_count"));
    evidence.push({
      label: `저장 근거 · ${type}`,
      value: rows === undefined ? "artifact 저장됨" : `${rows}행`,
    });
  }
  return evidence;
}

function normalizeReportLimits(value: unknown): string[] {
  if (Array.isArray(value)) return mapValid(value, normalizeLimit);
  const source = asRecord(value);
  const labels: Record<string, string> = {
    decisions: "판단 기록",
    trades: "가상 체결",
    equity: "자산 추이",
    charts: "차트",
    modelProvenance: "모델 provenance",
    model_provenance: "모델 provenance",
  };
  return Object.entries(source).flatMap(([key, raw]) => {
    const item = asRecord(raw);
    if (!Object.keys(item).length) {
      const detail = normalizeLimit(raw);
      return detail ? [`${labels[key] ?? key} · ${detail}`] : [];
    }
    const total = finiteNumber(item.total);
    const returned = finiteNumber(item.returned);
    const maximum = finiteNumber(item.maximum);
    const truncated = item.truncated === true;
    if (total !== undefined || returned !== undefined || maximum !== undefined) {
      const count = total !== undefined && returned !== undefined
        ? `${returned}/${total}건 표시`
        : returned !== undefined
          ? `${returned}건 표시`
          : `최대 ${maximum}건`;
      return [`${labels[key] ?? key} · ${count}${truncated ? " · 최근 기록만 포함" : ""}`];
    }
    const chartParts = [
      finiteNumber(first(item, "barsPerChart", "bars_per_chart")) !== undefined
        ? `종목당 봉 ${finiteNumber(first(item, "barsPerChart", "bars_per_chart"))}개`
        : undefined,
      finiteNumber(first(item, "patternsPerChart", "patterns_per_chart")) !== undefined
        ? `패턴 ${finiteNumber(first(item, "patternsPerChart", "patterns_per_chart"))}개`
        : undefined,
      finiteNumber(first(item, "indicatorsPerChart", "indicators_per_chart")) !== undefined
        ? `지표 ${finiteNumber(first(item, "indicatorsPerChart", "indicators_per_chart"))}개`
        : undefined,
    ].filter((part): part is string => Boolean(part));
    return chartParts.length ? [`${labels[key] ?? key} · ${chartParts.join(" · ")}`] : [];
  });
}

export function normalizeAiSimulationReport(payload: unknown): AiSimulationRunReport | undefined {
  const root = asRecord(payload);
  const report = Object.keys(asRecord(root.report)).length ? asRecord(root.report) : root;
  const run = runIdentity(root.run);
  const reportRun = runIdentity(report.run);
  const snapshotSource = first(report, "snapshot", "latestSnapshot", "latest_snapshot")
    ?? root.snapshot;
  const snapshot = Object.keys(asRecord(snapshotSource)).length
    ? normalizeAiSimulationSnapshot(snapshotSource)
    : undefined;
  const configuration = asRecord(first(report, "configuration", "config", "request"));
  const selectionBlock = asRecord(report.selection);
  const performance = asRecord(first(report, "performance", "result", "summary"));
  const runId = reportRun.runId
    ?? run.runId
    ?? textValue(first(report, "runId", "run_id"))
    ?? textValue(first(root, "runId", "run_id"));
  if (!runId) return undefined;
  const market = textValue(first(configuration, "marketCountry", "market_country"))
    ?? snapshot?.marketCountry;
  const normalizedMarket = normalizeAiSimulationMarket(
    configuration.market ?? snapshot?.market,
    market,
  );
  const preset = textValue(configuration.preset) ?? snapshot?.preset;
  const selected = mapValid(
    first(report, "selected", "symbols")
      ?? first(selectionBlock, "selected", "symbols", "instruments")
      ?? snapshot?.selected,
    normalizeSelection,
  );
  const decisions = mapValid(report.decisions ?? snapshot?.decisions, normalizeDecision);
  const trades = mapValid(report.trades ?? snapshot?.trades, normalizeTrade);
  const positions = mapValid(report.positions ?? snapshot?.positions, normalizePosition);
  const charts = mapValid(report.charts ?? snapshot?.charts, normalizeChartView);
  const initialCash = finiteNumber(first(performance, "initialCash", "initial_cash"))
    ?? finiteNumber(first(configuration, "initialCash", "initial_cash"))
    ?? snapshot?.initialCash;
  const finalEquity = finiteNumber(first(
    performance,
    "finalEquity",
    "final_equity",
    "equity",
  )) ?? snapshot?.equity;
  const pnl = finiteNumber(first(performance, "pnl", "totalPnl", "total_pnl"))
    ?? (initialCash !== undefined && finalEquity !== undefined
      ? finalEquity - initialCash
      : undefined);
  const explicitReturn = finiteNumber(first(
    performance,
    "returnRatio",
    "return_ratio",
    "returnRate",
    "return_rate",
  ));
  const currency = first(performance, "currency") === "USDT"
    || configuration.currency === "USDT"
    || snapshot?.currency === "USDT"
    || normalizedMarket?.kind === "crypto_futures"
    ? "USDT"
    : first(performance, "currency") === "USD"
    || configuration.currency === "USD"
    || snapshot?.currency === "USD"
    || market === "US"
    ? "USD"
    : "KRW";
  const reportModels = normalizeModelProvenance(first(
    report,
    "modelProvenance",
    "model_provenance",
    "models",
    "model",
  ));
  const decisionProvenance = mapValid(
    first(report, "decisionProvenance", "decision_provenance")
      ?? first(root, "decisionProvenance", "decision_provenance"),
    normalizeDecisionProvenance,
  );
  const rawDecisionProvenance = first(report, "decisionProvenance", "decision_provenance")
    ?? first(root, "decisionProvenance", "decision_provenance");
  const legacyKronosForecasts = mergeLatestKronosForecasts(
    snapshot?.kronosForecasts ?? [],
    selectLatestKronosForecasts([
      report.decisions,
      rawDecisionProvenance,
    ]),
  );
  const modelForecasts = mergeLatestModelForecasts(
    snapshot?.modelForecasts ?? [],
    normalizeAiSimulationModelForecasts(first(
      report,
      "modelForecasts",
      "model_forecasts",
    ) ?? first(root, "modelForecasts", "model_forecasts")),
    legacyKronosForecasts.map((forecast) => ({
      ...forecast,
      lane: "kronos_base" as const,
    })),
  );
  const kronosForecasts = modelForecasts
    .filter((forecast) => forecast.lane === "kronos_base")
    .map(({ lane: _lane, ...forecast }) => forecast);
  const inferredModels = [
    ...selected.map((item) => item.model),
    ...decisions.map((item) => item.model),
  ].filter((item): item is string => Boolean(item));
  const strategy = normalizeStrategyRequest(configuration.strategy)
    ?? snapshot?.strategy;
  const strategyComparison = normalizeStrategyComparison(
    first(report, "strategyComparison", "strategy_comparison")
      ?? first(performance, "strategyComparison", "strategy_comparison")
      ?? first(root, "strategyComparison", "strategy_comparison"),
  ) ?? snapshot?.strategyComparison;
  const modelComparison = normalizeAiSimulationModelComparison(
    first(report, "modelComparison", "model_comparison")
      ?? first(performance, "modelComparison", "model_comparison")
      ?? first(root, "modelComparison", "model_comparison"),
  ) ?? snapshot?.modelComparison;
  const rawModelLanes = stringList(first(configuration, "modelLanes", "model_lanes"))
    .map((lane) => lane.toLowerCase().replaceAll("-", "_"))
    .filter((lane): lane is AiSimulationModelLane => (
      AI_SIMULATION_MODEL_LANES.includes(lane as AiSimulationModelLane)
    ));
  const executionConfiguration = asRecord(configuration.execution);
  const rawExecutionMode = textValue(first(
    executionConfiguration,
    "mode",
    "executionMode",
    "execution_mode",
  )) ?? textValue(first(configuration, "executionMode", "execution_mode"));
  const executionMode = (
    ["paper", "testnet", "live"] as const
  ).find((candidate) => candidate === rawExecutionMode) ?? snapshot?.executionMode;
  const futuresPositions = normalizedMarket?.kind === "crypto_futures"
    ? normalizeAiSimulationFuturesPositions(
        first(report, "futuresPositions", "futures_positions")
          ?? report.positions
          ?? snapshot?.futuresPositions,
      )
    : [];
  const futuresRisk = normalizeAiSimulationFuturesRisk(first(
    report,
    "futuresRisk",
    "futures_risk",
    "riskState",
    "risk_state",
  )) ?? snapshot?.futuresRisk;

  return {
    runId,
    status: reportRun.status
      ?? run.status
      ?? textValue(first(report, "status", "phase"))
      ?? snapshot?.phase
      ?? "unknown",
    startedAt: reportRun.startedAt
      ?? run.startedAt
      ?? snapshot?.startedAt
      ?? textValue(first(report, "startedAt", "started_at")),
    finishedAt: reportRun.finishedAt
      ?? run.finishedAt
      ?? textValue(first(report, "finishedAt", "finished_at", "completedAt", "completed_at"))
      ?? snapshot?.expiresAt,
    configuration: {
      market: normalizedMarket,
      marketCountry: normalizedMarket?.kind === "stock" ? normalizedMarket.country : undefined,
      initialCash,
      durationMinutes: finiteNumber(first(configuration, "durationMinutes", "duration_minutes")),
      preset: AI_SIMULATION_PRESETS.includes(preset as AiSimulationPreset)
        ? preset as AiSimulationPreset
        : undefined,
      riskTolerance: finiteNumber(first(configuration, "riskTolerance", "risk_tolerance"))
        ?? snapshot?.riskTolerance,
      selection: normalizeSelectionRequest(configuration.selection)
        ?? normalizeSelectionRequest(first(selectionBlock, "request", "configuration"))
        ?? snapshot?.selection,
      ...(strategy ? { strategy } : {}),
      costs: finiteCosts(configuration.costs),
      modelLanes: rawModelLanes.length ? rawModelLanes : snapshot?.modelLanes,
      ...(executionMode ? { executionMode } : {}),
    },
    selected,
    performance: {
      currency,
      initialCash,
      finalEquity,
      cash: finiteNumber(performance.cash) ?? snapshot?.cash,
      pnl,
      returnRatio: explicitReturn
        ?? (initialCash !== undefined && initialCash > 0 && pnl !== undefined
          ? pnl / initialCash
          : undefined),
      realizedPnl: finiteNumber(first(performance, "realizedPnl", "realized_pnl")),
      unrealizedPnl: finiteNumber(first(performance, "unrealizedPnl", "unrealized_pnl")),
      totalCosts: finiteNumber(first(performance, "totalCosts", "total_costs", "costs"))
        ?? trades.reduce((total, trade) => total + trade.cost, 0),
      tradeCount: finiteNumber(first(performance, "tradeCount", "trade_count"))
        ?? trades.length,
      decisionCount: finiteNumber(first(performance, "decisionCount", "decision_count"))
        ?? decisions.length,
    },
    decisionCadence: normalizedCadence(
      first(report, "cadence", "decisionCadence", "decision_cadence")
        ?? snapshot?.decisionCadence,
    ),
    decisions,
    trades,
    positions,
    equity: mapValid(first(report, "equity", "equityCurve", "equity_curve"), normalizeEquityPoint),
    charts,
    modelProvenance: [...new Set([...reportModels, ...inferredModels])],
    decisionProvenance,
    modelForecasts,
    kronosForecasts,
    evidence: normalizeReportEvidence(report.evidence),
    warnings: stringList(first(report, "warnings", "limitations"))
      .concat(snapshot?.warnings ?? [])
      .filter((item, index, all) => all.indexOf(item) === index),
    limits: normalizeReportLimits(first(report, "limits", "limitations")),
    ...(strategyComparison ? { strategyComparison } : {}),
    futuresPositions,
    ...(futuresRisk ? { futuresRisk } : {}),
    ...(modelComparison ? { modelComparison } : {}),
  };
}

export function aiSimulationErrorMessage(payload: unknown, fallback: string): string {
  const root = asRecord(payload);
  const error = asRecord(root.error);
  const message = textValue(first(error, "message", "detail", "reason"))
    ?? textValue(first(root, "message", "reason"))
    ?? fallback;
  const issues = Array.isArray(error.issues) ? error.issues : [];
  const issue = issues
    .map((value) => textValue(first(asRecord(value), "message", "detail", "reason")))
    .find((value): value is string => Boolean(value));
  return issue && issue !== message ? `${message} · ${issue}` : message;
}

export function validateAiSimulationRequest(
  request: AiSimulationRequest,
  limits: AiSimulationLimits = {},
): string[] {
  const issues: string[] = [];
  if (!AI_SIMULATION_MARKETS.includes(request.marketCountry)) issues.push("시장 선택이 올바르지 않습니다.");
  const strategy = asRecord(request.strategy);
  const strategyMode = textValue(strategy.mode);
  if (strategyMode === "pair") {
    if (request.marketCountry !== "US") issues.push("페어 전략은 미국 시장에서만 실행할 수 있습니다.");
    if (!pairIdValue(first(strategy, "pairId", "pair_id"))) {
      issues.push("페어 전략 카탈로그를 확인해 주세요.");
    }
    if (booleanValue(first(strategy, "allowDegradedMode", "allow_degraded_mode")) !== false) {
      issues.push("페어 전략은 degraded 실행을 허용하지 않습니다.");
    }
  } else if (strategyMode !== "single") {
    issues.push("전략 실행 방식이 올바르지 않습니다.");
  }
  if (!AI_SIMULATION_PRESETS.includes(request.preset)) issues.push("AI 전략 프리셋이 올바르지 않습니다.");
  if (request.simulationCase === "us_etf_pair") {
    if (
      request.marketCountry !== "US"
      || strategyMode !== "pair"
      || request.modelLanes.join(",") !== "chronos2,fincast"
    ) {
      issues.push("미국 ETF 페어는 Chronos-2 primary·FinCast shadow 역할 정책을 사용해야 합니다.");
    }
    const pairId = pairIdValue(first(strategy, "pairId", "pair_id"));
    if (
      pairId !== "qqq-tqqq-sqqq"
      && pairId !== "semiconductor-soxl-soxs"
      && pairId !== "spy-spxl-spxs"
    ) {
      issues.push("새 ETF 메뉴는 QQQ·반도체·SPY 페어 중 하나를 선택해야 합니다.");
    }
  } else {
    if (request.modelLanes.length !== 1
      || !AI_SIMULATION_MODEL_LANES.includes(request.modelLanes[0])) {
      issues.push("주식 시뮬레이션 모델은 Kronos-base 또는 FinCast 중 하나여야 합니다.");
    }
    if (strategyMode === "pair" && request.modelLanes[0] !== "kronos_base") {
      issues.push("페어 전략은 현재 Kronos-base와 Rust 결합만 지원합니다.");
    }
  }
  if (request.fincastCandleSeconds !== 60) {
    issues.push("주식 FinCast 입력 주기는 1분봉만 지원합니다.");
  }
  if (request.execution.mode !== "paper") {
    issues.push("현재 주식 시뮬레이션은 paper 실행만 지원합니다.");
  }
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
    ["commissionBpsPerSide", "토스 편도 수수료"],
    ["taxBpsOnExit", "매도 거래세"],
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
