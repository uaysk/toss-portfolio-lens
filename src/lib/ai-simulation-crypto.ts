export const AI_SIMULATION_MODEL_LANES = ["kronos_base", "fincast"] as const;
export const AI_SIMULATION_EXECUTION_MODES = ["paper", "testnet", "live"] as const;

export type AiSimulationModelLane = (typeof AI_SIMULATION_MODEL_LANES)[number];
export type AiSimulationExecutionMode = (typeof AI_SIMULATION_EXECUTION_MODES)[number];
export type AiSimulationCriterion = "trading_amount" | "volume" | "volatility";

export type AiSimulationMarket =
  | { kind: "stock"; country: "KR" | "US" }
  | {
      kind: "crypto_futures";
      venue: "BINANCE_USDM";
      quoteAsset: "USDT";
      contractType: "PERPETUAL";
    };

export const AI_SIMULATION_CRYPTO_FUTURES_MARKET: Readonly<
  Extract<AiSimulationMarket, { kind: "crypto_futures" }>
> = Object.freeze({
  kind: "crypto_futures",
  venue: "BINANCE_USDM",
  quoteAsset: "USDT",
  contractType: "PERPETUAL",
});

export type AiSimulationCryptoRequest = {
  market: Extract<AiSimulationMarket, { kind: "crypto_futures" }>;
  initialCash: number;
  durationMinutes: number;
  preset: "risk_management";
  riskTolerance: number;
  selection: {
    mode: "auto";
    criterion: AiSimulationCriterion;
    symbolCount: 1;
  };
  strategy: { mode: "single" };
  costs: {
    commissionBpsPerSide: number;
    taxBpsOnExit: number;
    spreadBpsRoundTrip: number;
    slippageBpsPerSide: number;
  };
  modelLanes: [AiSimulationModelLane] | [AiSimulationModelLane, AiSimulationModelLane];
  execution: { mode: "paper" };
};

export const DEFAULT_AI_SIMULATION_CRYPTO_REQUEST: AiSimulationCryptoRequest = {
  market: { ...AI_SIMULATION_CRYPTO_FUTURES_MARKET },
  initialCash: 10_000,
  durationMinutes: 120,
  preset: "risk_management",
  riskTolerance: 25,
  selection: {
    mode: "auto",
    criterion: "volatility",
    symbolCount: 1,
  },
  strategy: { mode: "single" },
  costs: {
    commissionBpsPerSide: 4,
    taxBpsOnExit: 0,
    spreadBpsRoundTrip: 2,
    slippageBpsPerSide: 1,
  },
  modelLanes: ["kronos_base"],
  execution: { mode: "paper" },
};

export type AiSimulationCandidateQuality = {
  status: string;
  reasons: string[];
  missing: string[];
  sources: string[];
  observedAt?: string;
  finalBars?: number;
};

export type AiSimulationCryptoCandidate = {
  symbol: string;
  name?: string;
  rank?: number;
  score?: number;
  scoreComponents: Record<string, number>;
  currentPrice?: number;
  markPrice?: number;
  tradingAmount?: number;
  volume?: number;
  relativeVolume?: number;
  realizedVolatility60m?: number;
  volatility24h?: number;
  atrPercent?: number;
  spreadBps?: number;
  eligible: boolean;
  filterReasons: string[];
  quality: AiSimulationCandidateQuality;
};

export type AiSimulationCandidateSnapshot = {
  schemaVersion?: string;
  snapshotId?: string;
  generatedAt?: string;
  expiresAt?: string;
  criterion: AiSimulationCriterion;
  candidates: AiSimulationCryptoCandidate[];
  rankings: Partial<Record<AiSimulationCriterion, AiSimulationCryptoCandidate[]>>;
  warnings: string[];
};

export type AiSimulationWorkerStatus = {
  lane: AiSimulationModelLane;
  status: string;
  available: boolean;
  modelId?: string;
  modelRevision?: string;
  precision: "fp16" | "fp32" | "unknown";
  device?: string;
  latencyMs?: number;
  peakVramMb?: number;
  reason?: string;
};

export type AiSimulationCryptoStatus = {
  credentialsConfigured: boolean;
  signedReadSucceeded: boolean;
  executionGates: {
    paper: boolean;
    testnet: boolean;
    live: boolean;
  };
  workers: Partial<Record<AiSimulationModelLane, AiSimulationWorkerStatus>>;
};

export type AiSimulationFuturesPosition = {
  symbol: string;
  side: "long" | "short";
  marginMode: "isolated";
  quantity: number;
  leverage: number;
  entryPrice: number;
  markPrice?: number;
  notional?: number;
  initialMargin?: number;
  maintenanceMargin?: number;
  liquidationPrice?: number;
  liquidationBufferRatio?: number;
  protectiveStopPrice?: number;
  realizedPnl?: number;
  unrealizedPnl?: number;
  funding?: number;
  fees?: number;
  slippage?: number;
};

export type AiSimulationFuturesRisk = {
  dailyLossRatio?: number;
  dailyLossLimitRatio?: number;
  newEntriesBlocked: boolean;
  blockReason?: string;
  grossExposureRatio?: number;
  marginUsageRatio?: number;
  riskPerTradeRatio?: number;
};

export type AiSimulationModelMetrics = {
  pinballLoss?: number;
  medianReturnMae?: number;
  directionAccuracy?: number;
  quantileCoverage?: number;
  calibrationError?: number;
  netPnl?: number;
  profitFactor?: number;
  winRate?: number;
  maxDrawdown?: number;
  turnover?: number;
  funding?: number;
  fees?: number;
  latencyMs?: number;
  availabilityRatio?: number;
  timeoutCount?: number;
  peakVramMb?: number;
};

export type AiSimulationModelComparisonLane = {
  id: AiSimulationModelLane;
  status: string;
  precision: "fp16" | "fp32" | "unknown";
  unavailableReason?: string;
  metrics: AiSimulationModelMetrics;
};

export type AiSimulationModelComparison = {
  comparisonId?: string;
  outcome: "pending" | "inconclusive" | "review_required";
  sameOrigin: boolean;
  sameContext: boolean;
  sameCosts: boolean;
  sameFillBarrier: boolean;
  symbol?: string;
  lanes: AiSimulationModelComparisonLane[];
};

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function first(source: JsonRecord, ...keys: string[]): unknown {
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null) return source[key];
  }
  return undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function number(value: unknown): number | undefined {
  const candidate = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim()
      ? Number(value)
      : Number.NaN;
  return Number.isFinite(candidate) ? candidate : undefined;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.flatMap((item) => {
        const candidate = text(item);
        return candidate ? [candidate] : [];
      })
    : [];
}

function values(value: unknown): unknown[] {
  return Array.isArray(value) ? value : Object.values(record(value));
}

function criterion(value: unknown): AiSimulationCriterion | undefined {
  return value === "trading_amount" || value === "volume" || value === "volatility"
    ? value
    : undefined;
}

function modelLane(value: unknown): AiSimulationModelLane | undefined {
  const candidate = text(value)?.toLowerCase().replaceAll("-", "_");
  if (candidate === "kronos" || candidate === "kronosbase") return "kronos_base";
  return AI_SIMULATION_MODEL_LANES.includes(candidate as AiSimulationModelLane)
    ? candidate as AiSimulationModelLane
    : undefined;
}

function precision(value: unknown): AiSimulationWorkerStatus["precision"] {
  const candidate = text(value)?.toLowerCase();
  return candidate === "fp16"
    || candidate === "float16"
    || candidate === "mixed_float16"
    || candidate === "half"
    ? "fp16"
    : candidate === "fp32" || candidate === "float32"
      ? "fp32"
      : "unknown";
}

function numberRecord(value: unknown): Record<string, number> {
  return Object.fromEntries(Object.entries(record(value)).flatMap(([key, item]) => {
    const candidate = number(item);
    return candidate === undefined ? [] : [[key, candidate]];
  }));
}

export function normalizeAiSimulationMarket(
  value: unknown,
  legacyMarketCountry?: unknown,
): AiSimulationMarket | undefined {
  const market = record(value);
  const kind = text(market.kind)?.toLowerCase();
  if (kind === "crypto_futures") {
    const venue = text(first(market, "venue", "provider"));
    const quoteAsset = text(first(market, "quoteAsset", "quote_asset"));
    const contractType = text(first(market, "contractType", "contract_type"));
    if ((!venue || venue === "BINANCE_USDM")
      && (!quoteAsset || quoteAsset === "USDT")
      && (!contractType || contractType === "PERPETUAL")) {
      return { ...AI_SIMULATION_CRYPTO_FUTURES_MARKET };
    }
    return undefined;
  }
  const country = text(first(market, "country", "marketCountry", "market_country"))
    ?? text(legacyMarketCountry);
  if (kind === "stock" || !kind) {
    return country === "KR" || country === "US" ? { kind: "stock", country } : undefined;
  }
  return undefined;
}

function normalizeQuality(value: unknown): AiSimulationCandidateQuality {
  const quality = record(value);
  return {
    status: text(first(quality, "status", "state")) ?? "unavailable",
    reasons: strings(quality.reasons),
    missing: strings(first(quality, "missing", "missingFields", "missing_fields")),
    sources: strings(quality.sources),
    observedAt: text(first(quality, "observedAt", "observed_at", "updatedAt", "updated_at")),
    finalBars: number(first(quality, "finalBars", "final_bars")),
  };
}

function normalizeCandidate(value: unknown): AiSimulationCryptoCandidate | undefined {
  const candidate = record(value);
  const symbol = text(first(candidate, "symbol", "instrument", "instrumentKey", "instrument_key"))
    ?.toUpperCase();
  if (!symbol) return undefined;
  const filtered = bool(candidate.filtered);
  const filterReasons = strings(first(candidate, "filterReasons", "filter_reasons", "exclusionReasons"));
  const normalizedVolatility24h = number(first(candidate, "volatility24h", "volatility_24h", "change24h"));
  const binancePriceChangePercent24h = number(first(
    candidate,
    "priceChangePercent24h",
    "price_change_percent_24h",
  ));
  const quality = normalizeQuality(first(candidate, "quality", "dataQuality", "data_quality"));
  return {
    symbol,
    name: text(candidate.name),
    rank: number(candidate.rank),
    score: number(first(candidate, "score", "volatilityScore", "volatility_score")),
    scoreComponents: numberRecord(first(
      candidate,
      "scoreComponents",
      "score_components",
      "components",
    )),
    currentPrice: number(first(candidate, "currentPrice", "current_price", "price")),
    markPrice: number(first(candidate, "markPrice", "mark_price")),
    tradingAmount: number(first(candidate, "tradingAmount", "trading_amount", "quoteVolume", "quote_volume")),
    volume: number(candidate.volume),
    relativeVolume: number(first(candidate, "relativeVolume", "relative_volume")),
    realizedVolatility60m: number(first(
      candidate,
      "realizedVolatility60m",
      "realized_volatility_60m",
      "realizedVolatility",
    )),
    volatility24h: normalizedVolatility24h
      ?? (binancePriceChangePercent24h === undefined ? undefined : binancePriceChangePercent24h / 100),
    atrPercent: number(first(
      candidate,
      "atrPercent",
      "atr_percent",
      "atrPercent14",
      "atr_percent_14",
      "normalizedAtr",
    )),
    spreadBps: number(first(candidate, "spreadBps", "spread_bps")),
    eligible: bool(candidate.eligible)
      ?? (!(filtered ?? filterReasons.length > 0) && quality.status === "available"),
    filterReasons,
    quality,
  };
}

function normalizedCandidates(value: unknown): AiSimulationCryptoCandidate[] {
  return values(value)
    .map(normalizeCandidate)
    .filter((item): item is AiSimulationCryptoCandidate => Boolean(item))
    .filter((item, index, all) => all.findIndex(({ symbol }) => symbol === item.symbol) === index);
}

export function normalizeAiSimulationCandidates(
  payload: unknown,
  requestedCriterion: AiSimulationCriterion = "volatility",
): AiSimulationCandidateSnapshot {
  const root = record(payload);
  const nested = record(first(root, "snapshot", "scannerSnapshot", "scanner_snapshot", "data"));
  const source = Object.keys(nested).length ? { ...root, ...nested } : root;
  const rankingSource = record(first(source, "rankings", "candidateRankings", "candidate_rankings"));
  const rankings: AiSimulationCandidateSnapshot["rankings"] = {};
  for (const key of ["trading_amount", "volume", "volatility"] as const) {
    const items = normalizedCandidates(first(rankingSource, key) ?? source[key]);
    if (items.length) rankings[key] = items;
  }
  const selectedCriterion = criterion(first(source, "criterion", "rankingCriterion", "ranking_criterion"))
    ?? requestedCriterion;
  const directCandidates = normalizedCandidates(first(
    source,
    "candidates",
    "items",
    "results",
    "selected",
  ));
  const candidates = directCandidates.length
    ? directCandidates
    : rankings[selectedCriterion] ?? [];
  if (candidates.length && !rankings[selectedCriterion]) rankings[selectedCriterion] = candidates;
  return {
    schemaVersion: text(first(source, "schemaVersion", "schema_version")),
    snapshotId: text(first(
      source,
      "snapshotId",
      "snapshot_id",
      "scannerSnapshotId",
      "scanner_snapshot_id",
      "id",
    )),
    generatedAt: text(first(source, "generatedAt", "generated_at", "observedAt", "observed_at")),
    expiresAt: text(first(source, "expiresAt", "expires_at")),
    criterion: selectedCriterion,
    candidates,
    rankings,
    warnings: [
      ...strings(first(source, "warnings", "limitations")),
      ...values(source.evidence).flatMap((item) => {
        if (typeof item === "string") return item.trim() ? [item.trim()] : [];
        const evidence = record(item);
        const message = text(first(evidence, "message", "reason", "summary"));
        return message ? [message] : [];
      }),
    ].filter((item, index, all) => all.indexOf(item) === index),
  };
}

function normalizeWorker(value: unknown, fallbackLane?: AiSimulationModelLane): AiSimulationWorkerStatus | undefined {
  const worker = record(value);
  const lane = modelLane(first(worker, "lane", "id", "role", "modelLane", "model_lane")) ?? fallbackLane;
  if (!lane) return undefined;
  const status = text(first(worker, "status", "state", "health")) ?? "unavailable";
  return {
    lane,
    status,
    available: bool(first(worker, "available", "ready", "healthy"))
      ?? ["available", "ready", "healthy", "running", "connected"].includes(status.toLowerCase()),
    modelId: text(first(worker, "modelId", "model_id", "model")),
    modelRevision: text(first(worker, "modelRevision", "model_revision", "revision")),
    precision: precision(first(worker, "precision", "dtype")),
    device: text(first(worker, "device", "deviceName", "device_name")),
    latencyMs: number(first(worker, "latencyMs", "latency_ms")),
    peakVramMb: number(first(worker, "peakVramMb", "peak_vram_mb", "vramMb", "vram_mb")),
    reason: text(first(worker, "reason", "message", "error")),
  };
}

export function normalizeAiSimulationCryptoStatus(payload: unknown): AiSimulationCryptoStatus {
  const root = record(payload);
  const crypto = record(first(root, "cryptoFutures", "crypto_futures", "binance", "crypto"));
  const source = Object.keys(crypto).length ? { ...root, ...crypto } : root;
  const credentials = record(first(source, "credentials", "credentialStatus", "credential_status"));
  const gates = record(first(source, "executionGates", "execution_gates", "gates"));
  const workersSource = record(first(source, "workers", "modelWorkers", "model_workers"));
  const workers: AiSimulationCryptoStatus["workers"] = {};
  for (const lane of AI_SIMULATION_MODEL_LANES) {
    const worker = normalizeWorker(first(
      workersSource,
      lane,
      lane.replaceAll("_", "-"),
      lane === "kronos_base" ? "kronos" : lane,
    ), lane);
    if (worker) workers[lane] = worker;
  }
  return {
    credentialsConfigured: bool(first(
      credentials,
      "configured",
      "credentialsConfigured",
      "credentials_configured",
    )) ?? bool(first(source, "credentialsConfigured", "credentials_configured", "binanceCredentialsConfigured")) ?? false,
    signedReadSucceeded: bool(first(
      credentials,
      "signedReadSucceeded",
      "signed_read_succeeded",
      "signedRead",
    )) ?? bool(first(source, "signedReadSucceeded", "signed_read_succeeded")) ?? false,
    executionGates: {
      paper: bool(first(gates, "paper", "paperEnabled", "paper_enabled"))
        ?? bool(first(source, "paperEnabled", "paper_enabled"))
        ?? true,
      testnet: bool(first(gates, "testnet", "testnetEnabled", "testnet_enabled"))
        ?? bool(first(source, "testnetEnabled", "testnet_enabled"))
        ?? false,
      live: bool(first(gates, "live", "liveEnabled", "live_enabled", "realOrder"))
        ?? bool(first(source, "liveEnabled", "live_enabled", "realOrder"))
        ?? false,
    },
    workers,
  };
}

export function normalizeAiSimulationFuturesPositions(
  value: unknown,
): AiSimulationFuturesPosition[] {
  return values(value).flatMap((item) => {
    const position = record(item);
    const symbol = text(position.symbol)?.toUpperCase();
    const rawSide = text(first(position, "side", "direction", "positionSide", "position_side"))?.toLowerCase();
    const side = rawSide === "long" || rawSide === "buy"
      ? "long"
      : rawSide === "short" || rawSide === "sell"
        ? "short"
        : undefined;
    const quantity = number(first(position, "quantity", "positionAmount", "position_amount"));
    const entryPrice = number(first(position, "entryPrice", "entry_price", "averagePrice", "average_price"));
    const leverage = number(position.leverage);
    if (!symbol || !side || quantity === undefined || entryPrice === undefined || leverage === undefined) return [];
    return [{
      symbol,
      side,
      marginMode: "isolated" as const,
      quantity,
      leverage,
      entryPrice,
      markPrice: number(first(position, "markPrice", "mark_price", "marketPrice", "market_price")),
      notional: number(first(position, "notional", "notionalValue", "notional_value")),
      initialMargin: number(first(position, "initialMargin", "initial_margin", "margin")),
      maintenanceMargin: number(first(position, "maintenanceMargin", "maintenance_margin")),
      liquidationPrice: number(first(position, "liquidationPrice", "liquidation_price")),
      liquidationBufferRatio: number(first(
        position,
        "liquidationBufferRatio",
        "liquidation_buffer_ratio",
        "liquidationBuffer",
      )),
      protectiveStopPrice: number(first(position, "protectiveStopPrice", "protective_stop_price", "stopPrice")),
      realizedPnl: number(first(position, "realizedPnl", "realized_pnl")),
      unrealizedPnl: number(first(position, "unrealizedPnl", "unrealized_pnl")),
      funding: number(first(position, "funding", "fundingCost", "funding_cost")),
      fees: number(first(position, "fees", "fee", "commission")),
      slippage: number(first(position, "slippage", "slippageCost", "slippage_cost")),
    }];
  });
}

export function normalizeAiSimulationFuturesRisk(value: unknown): AiSimulationFuturesRisk | undefined {
  const risk = record(value);
  if (!Object.keys(risk).length) return undefined;
  return {
    dailyLossRatio: number(first(risk, "dailyLossRatio", "daily_loss_ratio")),
    dailyLossLimitRatio: number(first(risk, "dailyLossLimitRatio", "daily_loss_limit_ratio")) ?? 0.03,
    newEntriesBlocked: bool(first(risk, "newEntriesBlocked", "new_entries_blocked", "blocked")) ?? false,
    blockReason: text(first(risk, "blockReason", "block_reason", "reason")),
    grossExposureRatio: number(first(risk, "grossExposureRatio", "gross_exposure_ratio")),
    marginUsageRatio: number(first(risk, "marginUsageRatio", "margin_usage_ratio")),
    riskPerTradeRatio: number(first(risk, "riskPerTradeRatio", "risk_per_trade_ratio")) ?? 0.005,
  };
}

function normalizeMetrics(value: unknown): AiSimulationModelMetrics {
  const metrics = record(value);
  return {
    pinballLoss: number(first(metrics, "pinballLoss", "pinball_loss")),
    medianReturnMae: number(first(metrics, "medianReturnMae", "median_return_mae", "mae")),
    directionAccuracy: number(first(metrics, "directionAccuracy", "direction_accuracy")),
    quantileCoverage: number(first(metrics, "quantileCoverage", "quantile_coverage", "coverage")),
    calibrationError: number(first(metrics, "calibrationError", "calibration_error", "calibration")),
    netPnl: number(first(metrics, "netPnl", "net_pnl", "pnl")),
    profitFactor: number(first(metrics, "profitFactor", "profit_factor")),
    winRate: number(first(metrics, "winRate", "win_rate")),
    maxDrawdown: number(first(metrics, "maxDrawdown", "max_drawdown")),
    turnover: number(metrics.turnover),
    funding: number(first(metrics, "funding", "fundingCost", "funding_cost")),
    fees: number(first(metrics, "fees", "commission")),
    latencyMs: number(first(metrics, "latencyMs", "latency_ms")),
    availabilityRatio: number(first(metrics, "availabilityRatio", "availability_ratio", "availability")),
    timeoutCount: number(first(metrics, "timeoutCount", "timeout_count")),
    peakVramMb: number(first(metrics, "peakVramMb", "peak_vram_mb")),
  };
}

export function normalizeAiSimulationModelComparison(
  value: unknown,
): AiSimulationModelComparison | undefined {
  const comparison = record(value);
  if (!Object.keys(comparison).length) return undefined;
  const lanesSource = first(comparison, "lanes", "models", "results");
  const laneEntries = Array.isArray(lanesSource)
    ? lanesSource.map((item) => [undefined, item] as const)
    : Object.entries(record(lanesSource));
  const lanes = laneEntries.flatMap(([key, item]) => {
    const source = record(item);
    const id = modelLane(first(source, "id", "lane", "modelLane", "model_lane") ?? key);
    if (!id) return [];
    return [{
      id,
      status: text(first(source, "status", "state")) ?? "unavailable",
      precision: precision(first(source, "precision", "dtype")),
      unavailableReason: text(first(source, "unavailableReason", "unavailable_reason", "reason")),
      metrics: normalizeMetrics(first(source, "metrics", "performance") ?? source),
    }];
  }).filter((lane, index, all) => all.findIndex(({ id }) => id === lane.id) === index);
  if (!lanes.length) return undefined;
  const rawOutcome = text(first(comparison, "outcome", "result"))?.toLowerCase();
  const outcome = rawOutcome === "inconclusive" || rawOutcome === "review_required"
    ? rawOutcome
    : "pending";
  return {
    comparisonId: text(first(comparison, "comparisonId", "comparison_id", "id")),
    outcome,
    sameOrigin: bool(first(comparison, "sameOrigin", "same_origin")) ?? false,
    sameContext: bool(first(comparison, "sameContext", "same_context")) ?? false,
    sameCosts: bool(first(comparison, "sameCosts", "same_costs")) ?? false,
    sameFillBarrier: bool(first(comparison, "sameFillBarrier", "same_fill_barrier", "sameExecutionPolicy")) ?? false,
    symbol: text(comparison.symbol),
    lanes,
  };
}

export function validateAiSimulationCryptoRequest(
  request: AiSimulationCryptoRequest,
  limits: {
    minimumInitialCash?: number;
    maximumInitialCash?: number;
    minimumDurationMinutes?: number;
    maximumDurationMinutes?: number;
  } = {},
): string[] {
  const issues: string[] = [];
  if (request.market.kind !== "crypto_futures"
    || request.market.venue !== "BINANCE_USDM"
    || request.market.quoteAsset !== "USDT"
    || request.market.contractType !== "PERPETUAL") {
    issues.push("Binance USDⓈ-M USDT 무기한 계약만 지원합니다.");
  }
  if (!Number.isFinite(request.initialCash) || request.initialCash <= 0) {
    issues.push("시작 USDT는 0보다 커야 합니다.");
  } else {
    if (limits.minimumInitialCash !== undefined && request.initialCash < limits.minimumInitialCash) {
      issues.push(`시작 USDT는 ${limits.minimumInitialCash} 이상이어야 합니다.`);
    }
    if (limits.maximumInitialCash !== undefined && request.initialCash > limits.maximumInitialCash) {
      issues.push(`시작 USDT는 ${limits.maximumInitialCash} 이하여야 합니다.`);
    }
  }
  if (!Number.isSafeInteger(request.durationMinutes) || request.durationMinutes < 1) {
    issues.push("테스트 기간은 1분 이상의 정수여야 합니다.");
  } else {
    if (limits.minimumDurationMinutes !== undefined && request.durationMinutes < limits.minimumDurationMinutes) {
      issues.push(`테스트 기간은 ${limits.minimumDurationMinutes}분 이상이어야 합니다.`);
    }
    if (limits.maximumDurationMinutes !== undefined && request.durationMinutes > limits.maximumDurationMinutes) {
      issues.push(`테스트 기간은 ${limits.maximumDurationMinutes}분 이하여야 합니다.`);
    }
  }
  if (!AI_SIMULATION_MODEL_LANES.includes(request.modelLanes[0])
    || request.modelLanes.length > 2
    || new Set(request.modelLanes).size !== request.modelLanes.length) {
    issues.push("모델 lane을 하나 이상 중복 없이 선택해 주세요.");
  }
  if (request.execution.mode !== "paper") issues.push("현재 운영에서는 paper 실행만 허용됩니다.");
  if (request.selection.mode !== "auto" || request.selection.symbolCount !== 1) {
    issues.push("암호화폐 선물은 scanner 자동 선정 1종목만 지원합니다.");
  }
  for (const [key, value] of Object.entries(request.costs)) {
    if (!Number.isFinite(value) || value < 0) issues.push(`${key} 비용은 0 이상의 숫자여야 합니다.`);
  }
  return issues;
}
