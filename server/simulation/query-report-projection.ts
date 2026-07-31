import type {
  ArtifactDescriptor,
  ArtifactType,
} from "../repositories/artifact-repository.js";
import type { PortfolioRunRecord } from "../repositories/run-repository.js";
import {
  AI_SIMULATION_CONTRACT_VERSION,
  type SimulationMarket,
  type StockSimulationMarket,
} from "./contracts.js";

type UnknownRecord = Record<string, unknown>;

export const SIMULATION_REPORT_LIMITS = {
  decisions: 500,
  trades: 500,
  equityPoints: 1_000,
  charts: 3,
  barsPerChart: 180,
  patternsPerChart: 120,
  indicatorsPerChart: 50,
  modelProvenance: 16,
} as const;

function record(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonempty(value: unknown, maximum = 256): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= maximum ? normalized : undefined;
}

function timestamp(value: unknown): string | undefined {
  const normalized = nonempty(value, 64);
  return normalized && Number.isFinite(Date.parse(normalized)) ? normalized : undefined;
}

function uniqueWarnings(values: readonly string[]): string[] {
  return Array.from(new Set(values.filter(Boolean))).slice(-200);
}

function values(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function firstDefined(source: UnknownRecord | undefined, ...keys: string[]): unknown {
  if (!source) return undefined;
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null) return source[key];
  }
  return undefined;
}

export function stringValues(value: unknown): string[] {
  return values(value).flatMap((item) => {
    const text = nonempty(item, 1_000);
    return text ? [text] : [];
  });
}

function simulationMarket(value: unknown): SimulationMarket | undefined {
  const source = record(value);
  const kind = nonempty(source?.kind, 32);
  if (kind === "stock") {
    const country = nonempty(source?.country, 8);
    if (country === "KR" || country === "US") {
      return { kind, country };
    }
    return undefined;
  }
  if (kind === "crypto_futures"
    && source?.venue === "BINANCE_USDM"
    && source.quoteAsset === "USDT"
    && source.contractType === "PERPETUAL") {
    return {
      kind,
      venue: "BINANCE_USDM",
      quoteAsset: "USDT",
      contractType: "PERPETUAL",
    };
  }
  return undefined;
}

function normalizedStockMarket(
  ...sources: readonly unknown[]
): StockSimulationMarket {
  for (const value of sources) {
    const direct = simulationMarket(firstDefined(record(value), "market"));
    if (direct?.kind === "stock") return direct;
  }
  throw new Error(
    "Simulation run is not canonical ai-paper-simulation/v9: market is required.",
  );
}

export function runSnapshot(run: PortfolioRunRecord): UnknownRecord | undefined {
  return record(record(run.result)?.snapshot) ?? record(record(run.summary)?.snapshot);
}

export function runStockMarket(
  run: PortfolioRunRecord,
  snapshot?: UnknownRecord,
): StockSimulationMarket {
  return normalizedStockMarket(
    snapshot,
    record(run.result),
    record(run.summary),
    record(run.input),
  );
}

export function normalizeStockSnapshot(
  value: unknown,
  market: StockSimulationMarket,
): UnknownRecord | undefined {
  const source = record(value);
  return source ? { ...source, market } : undefined;
}

export function runView(run: PortfolioRunRecord) {
  const market = runStockMarket(run, runSnapshot(run));
  return {
    schemaVersion: AI_SIMULATION_CONTRACT_VERSION,
    runId: run.id,
    kind: run.kind,
    market,
    status: run.status,
    progress: run.progress,
    ...(run.error !== undefined ? { error: run.error } : {}),
    warnings: run.warnings,
    createdAt: new Date(run.createdAt).toISOString(),
    ...(run.startedAt ? { startedAt: new Date(run.startedAt).toISOString() } : {}),
    ...(run.finishedAt ? { finishedAt: new Date(run.finishedAt).toISOString() } : {}),
  };
}

export function simulationConfiguration(
  run: PortfolioRunRecord,
  snapshot: UnknownRecord | undefined,
) {
  const input = record(run.input);
  const market = runStockMarket(run, snapshot);
  const schemaVersion = nonempty(
    firstDefined(input, "schemaVersion", "schema_version")
      ?? firstDefined(snapshot, "schemaVersion", "schema_version"),
    128,
  );
  const policyVersion = nonempty(
    firstDefined(input, "policyVersion", "policy_version")
      ?? firstDefined(snapshot, "policyVersion", "policy_version"),
    128,
  );
  const marketCountry = market.country;
  const initialCash = finite(
    firstDefined(snapshot, "initialCash", "initial_cash")
      ?? firstDefined(input, "initialCash", "initial_cash"),
  );
  const durationMinutes = finite(firstDefined(input, "durationMinutes", "duration_minutes"));
  const preset = nonempty(
    firstDefined(snapshot, "preset") ?? firstDefined(input, "preset"),
    64,
  );
  const riskTolerance = finite(
    firstDefined(snapshot, "riskTolerance", "risk_tolerance")
      ?? firstDefined(input, "riskTolerance", "risk_tolerance"),
  );
  const selection = firstDefined(snapshot, "selection") ?? firstDefined(input, "selection");
  const strategy = firstDefined(snapshot, "strategy") ?? firstDefined(input, "strategy");
  const costs = firstDefined(input, "costs");
  const policyProfile = firstDefined(snapshot, "policyProfile", "policy_profile")
    ?? firstDefined(input, "resolvedPolicyProfile", "resolved_policy_profile");
  const decisionCadence = firstDefined(input, "decisionCadence", "decision_cadence");
  return {
    ...(schemaVersion ? { schemaVersion } : {}),
    ...(policyVersion ? { policyVersion } : {}),
    market,
    marketCountry,
    ...(initialCash !== undefined ? { initialCash } : {}),
    ...(durationMinutes !== undefined ? { durationMinutes } : {}),
    ...(selection !== undefined ? { selection } : {}),
    ...(strategy !== undefined ? { strategy } : {}),
    ...(preset ? { preset } : {}),
    ...(riskTolerance !== undefined ? { riskTolerance } : {}),
    ...(costs !== undefined ? { costs } : {}),
    ...(policyProfile !== undefined ? { policyProfile } : {}),
    ...(decisionCadence !== undefined ? { decisionCadence } : {}),
  };
}

function modelView(value: unknown): UnknownRecord | undefined {
  const source = record(value);
  const direct = nonempty(value, 256);
  if (!source && !direct) return undefined;
  const modelId = direct ?? nonempty(firstDefined(source, "modelId", "model_id", "id", "name"), 256);
  const modelRevision = nonempty(
    firstDefined(source, "modelRevision", "model_revision", "revision"),
    256,
  );
  const tokenizerId = nonempty(firstDefined(source, "tokenizerId", "tokenizer_id"), 256);
  const tokenizerRevision = nonempty(
    firstDefined(source, "tokenizerRevision", "tokenizer_revision"),
    256,
  );
  const sourceRevision = nonempty(
    firstDefined(source, "sourceRevision", "source_revision"),
    256,
  );
  const loaderVersion = nonempty(
    firstDefined(source, "loaderVersion", "loader_version"),
    256,
  );
  const license = nonempty(firstDefined(source, "license"), 128);
  const device = nonempty(firstDefined(source, "device"), 64);
  const dtype = nonempty(firstDefined(source, "dtype"), 64);
  const attentionBackend = nonempty(
    firstDefined(source, "attentionBackend", "attention_backend"),
    64,
  );
  const loaded = firstDefined(source, "loaded");
  if (!modelId && !modelRevision && !device && typeof loaded !== "boolean") return undefined;
  return {
    ...(modelId ? { modelId } : {}),
    ...(modelRevision ? { modelRevision } : {}),
    ...(tokenizerId ? { tokenizerId } : {}),
    ...(tokenizerRevision ? { tokenizerRevision } : {}),
    ...(sourceRevision ? { sourceRevision } : {}),
    ...(loaderVersion ? { loaderVersion } : {}),
    ...(license ? { license } : {}),
    ...(device ? { device } : {}),
    ...(dtype ? { dtype } : {}),
    ...(attentionBackend ? { attentionBackend } : {}),
    ...(typeof loaded === "boolean" ? { loaded } : {}),
  };
}

export function modelProvenance(
  selected: readonly unknown[],
  decisions: readonly unknown[],
): UnknownRecord[] {
  const models = new Map<string, UnknownRecord & { symbols: string[] }>();
  for (const entry of [...selected, ...decisions]) {
    const item = record(entry);
    const model = modelView(item?.model);
    if (!model) continue;
    const key = JSON.stringify(model);
    const symbol = nonempty(item?.symbol, 32);
    const previous = models.get(key);
    if (previous) {
      if (symbol && !previous.symbols.includes(symbol)) previous.symbols.push(symbol);
      continue;
    }
    models.set(key, {
      ...model,
      symbols: symbol ? [symbol] : [],
    });
    if (models.size >= SIMULATION_REPORT_LIMITS.modelProvenance) break;
  }
  return [...models.values()];
}

function boundedChart(value: unknown): UnknownRecord | undefined {
  const source = record(value);
  const symbol = nonempty(source?.symbol, 32);
  if (!source || !symbol) return undefined;
  return {
    symbol,
    ...(nonempty(source.name, 256) ? { name: nonempty(source.name, 256) } : {}),
    ...(nonempty(source.currency, 8) ? { currency: nonempty(source.currency, 8) } : {}),
    bars: values(source.bars).slice(-SIMULATION_REPORT_LIMITS.barsPerChart),
    indicators: values(source.indicators).slice(
      -SIMULATION_REPORT_LIMITS.indicatorsPerChart,
    ),
    patterns: values(source.patterns).slice(-SIMULATION_REPORT_LIMITS.patternsPerChart),
    ...(timestamp(source.updatedAt) ? { updatedAt: timestamp(source.updatedAt) } : {}),
  };
}

export function boundedCharts(value: unknown): UnknownRecord[] {
  return values(value)
    .slice(0, SIMULATION_REPORT_LIMITS.charts)
    .map(boundedChart)
    .filter((item): item is UnknownRecord => item !== undefined);
}

export function boundedSnapshot(input: {
  source: UnknownRecord;
  selected: unknown[];
  positions: unknown[];
  charts: UnknownRecord[];
  trades: unknown[];
  decisions: unknown[];
  warnings: string[];
}) {
  const source = input.source;
  return {
    ...(firstDefined(source, "schemaVersion", "schema_version") !== undefined
      ? { schemaVersion: firstDefined(source, "schemaVersion", "schema_version") } : {}),
    ...(firstDefined(source, "policyVersion", "policy_version") !== undefined
      ? { policyVersion: firstDefined(source, "policyVersion", "policy_version") } : {}),
    ...(source.phase !== undefined ? { phase: source.phase } : {}),
    ...(source.createdAt !== undefined ? { createdAt: source.createdAt } : {}),
    ...(source.startedAt !== undefined ? { startedAt: source.startedAt } : {}),
    ...(source.expiresAt !== undefined ? { expiresAt: source.expiresAt } : {}),
    ...(source.market !== undefined ? { market: source.market } : {}),
    ...(source.marketCountry !== undefined ? { marketCountry: source.marketCountry } : {}),
    ...(source.currency !== undefined ? { currency: source.currency } : {}),
    ...(source.selection !== undefined ? { selection: source.selection } : {}),
    ...(source.strategy !== undefined ? { strategy: source.strategy } : {}),
    ...(source.pairStrategy !== undefined ? { pairStrategy: source.pairStrategy } : {}),
    ...(source.pairState !== undefined ? { pairState: source.pairState } : {}),
    ...(source.strategyComparison !== undefined
      ? { strategyComparison: source.strategyComparison } : {}),
    ...(source.criterion !== undefined ? { criterion: source.criterion } : {}),
    ...(source.preset !== undefined ? { preset: source.preset } : {}),
    ...(source.riskTolerance !== undefined ? { riskTolerance: source.riskTolerance } : {}),
    ...(source.policyProfile !== undefined ? { policyProfile: source.policyProfile } : {}),
    ...(source.initialCash !== undefined ? { initialCash: source.initialCash } : {}),
    ...(source.cash !== undefined ? { cash: source.cash } : {}),
    ...(source.equity !== undefined ? { equity: source.equity } : {}),
    ...(source.invested !== undefined ? { invested: source.invested } : {}),
    ...(source.realizedPnl !== undefined ? { realizedPnl: source.realizedPnl } : {}),
    ...(source.totalCosts !== undefined ? { totalCosts: source.totalCosts } : {}),
    ...(source.progress !== undefined ? { progress: source.progress } : {}),
    ...(source.decisionCadence !== undefined ? { decisionCadence: source.decisionCadence } : {}),
    selected: input.selected,
    positions: input.positions,
    pendingActions: values(source.pendingActions).slice(-10),
    charts: input.charts,
    trades: input.trades,
    decisions: input.decisions,
    warnings: input.warnings,
    ...(source.capabilities !== undefined ? { capabilities: source.capabilities } : {}),
  };
}

export function countFromArtifact(
  artifacts: ReadonlyMap<ArtifactType, ArtifactDescriptor>,
  type: ArtifactType,
  fallback: number,
): number {
  const value = artifacts.get(type)?.rowCount;
  return Number.isSafeInteger(value) && Number(value) >= 0
    ? Math.max(Number(value), fallback)
    : fallback;
}

export function reportLimit(total: number, returned: number, maximum: number) {
  return {
    total,
    returned,
    maximum,
    truncated: total > returned,
    window: "latest" as const,
  };
}

export function performanceView(input: {
  run: PortfolioRunRecord;
  snapshot: UnknownRecord;
  positions: readonly unknown[];
  tradeCount: number;
  decisionCount: number;
}) {
  const summary = record(input.run.summary);
  const configuration = simulationConfiguration(input.run, input.snapshot);
  const initialCash = finite(
    firstDefined(input.snapshot, "initialCash", "initial_cash")
      ?? firstDefined(summary, "initialCash", "initial_cash")
      ?? configuration.initialCash,
  );
  const finalEquity = finite(
    firstDefined(input.snapshot, "equity", "finalEquity", "final_equity")
      ?? firstDefined(summary, "finalEquity", "final_equity"),
  );
  const cash = finite(firstDefined(input.snapshot, "cash"));
  const realizedPnl = finite(
    firstDefined(input.snapshot, "realizedPnl", "realized_pnl"),
  ) ?? 0;
  const unrealizedPnl = input.positions.reduce<number>((total, value) => (
    total + (finite(firstDefined(record(value), "unrealizedPnl", "unrealized_pnl")) ?? 0)
  ), 0);
  const totalCosts = finite(
    firstDefined(input.snapshot, "totalCosts", "total_costs")
      ?? firstDefined(summary, "totalCosts", "total_costs"),
  ) ?? 0;
  const returnRatio = finite(
    firstDefined(summary, "returnRatio", "return_ratio"),
  ) ?? (
    initialCash !== undefined && initialCash > 0 && finalEquity !== undefined
      ? finalEquity / initialCash - 1
      : undefined
  );
  const netProfitLoss = finite(
    firstDefined(summary, "netProfitLoss", "net_profit_loss"),
  ) ?? (
    initialCash !== undefined && finalEquity !== undefined
      ? finalEquity - initialCash
      : undefined
  );
  return {
    ...(initialCash !== undefined ? { initialCash } : {}),
    ...(finalEquity !== undefined ? { finalEquity } : {}),
    ...(cash !== undefined ? { cash } : {}),
    ...(netProfitLoss !== undefined ? { netProfitLoss } : {}),
    ...(returnRatio !== undefined ? { returnRatio } : {}),
    realizedPnl,
    unrealizedPnl,
    totalCosts,
    tradeCount: input.tradeCount,
    decisionCount: input.decisionCount,
    positionCount: input.positions.length,
  };
}

export function historyItem(run: PortfolioRunRecord) {
  const snapshot = runSnapshot(run) ?? {};
  const summary = record(run.summary);
  const configuration = simulationConfiguration(run, snapshot);
  const selected = values(snapshot.selected).slice(0, 2);
  const positions = values(snapshot.positions).slice(0, 2);
  const trades = values(snapshot.trades);
  const decisions = values(snapshot.decisions);
  const tradeCount = finite(firstDefined(summary, "tradeCount", "trade_count")) ?? trades.length;
  const decisionCount = finite(firstDefined(summary, "decisionCount", "decision_count"))
    ?? decisions.length;
  const performance = performanceView({
    run,
    snapshot,
    positions,
    tradeCount,
    decisionCount,
  });
  const firstModel = modelView(record(selected[0])?.model);
  return {
    schemaVersion: AI_SIMULATION_CONTRACT_VERSION,
    runId: run.id,
    status: run.status,
    progress: run.progress,
    createdAt: new Date(run.createdAt).toISOString(),
    ...(run.startedAt !== undefined ? { startedAt: new Date(run.startedAt).toISOString() } : {}),
    ...(run.finishedAt !== undefined ? { finishedAt: new Date(run.finishedAt).toISOString() } : {}),
    market: configuration.market,
    marketCountry: configuration.marketCountry,
    ...(configuration.preset ? { preset: configuration.preset } : {}),
    ...(configuration.riskTolerance !== undefined
      ? { riskTolerance: configuration.riskTolerance } : {}),
    ...(configuration.selection !== undefined ? { selection: configuration.selection } : {}),
    ...(configuration.strategy !== undefined ? { strategy: configuration.strategy } : {}),
    selected,
    ...(nonempty(snapshot.currency, 8) ? { currency: nonempty(snapshot.currency, 8) } : {}),
    ...performance,
    ...(firstModel ? { model: firstModel } : {}),
    decisionCadence: firstDefined(snapshot, "decisionCadence", "decision_cadence") ?? null,
    ...(snapshot.strategyComparison !== undefined
      ? { strategyComparison: snapshot.strategyComparison } : {}),
    warnings: uniqueWarnings([...run.warnings, ...stringValues(snapshot.warnings)]).slice(-20),
    ...(run.error !== undefined ? { error: run.error } : {}),
  };
}
