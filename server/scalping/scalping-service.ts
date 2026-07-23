import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Portfolio, InstrumentInfo } from "../toss.js";
import type { RustComputeClient } from "../worker/rust-client.js";
import {
  SCALPING_AI_HORIZONS,
  SCALPING_AI_QUANTILES,
  SCALPING_AI_SCHEMA_VERSION,
  type AiEvaluateRequest,
  type AiForecastRequest,
  type AiPriceBar,
  type AiTargetStopSchema,
} from "../worker/ai-contract.js";
import type { ScalpingAiService } from "../services/scalping-ai-service.js";
import type { TechnicalTradeMarkerService } from "../services/technical-trade-marker-service.js";
import type {
  IntradayBarRecord,
  ScalpingInterval,
  ScalpingPredictionRecord,
  ScalpingRepository,
} from "../repositories/scalping-repository.js";
import {
  DataQualitySchema,
  MarketCountrySchema,
  MinuteIntervalSchema,
  ScannerCriterionSchema,
  createScannerRequestSchema,
  normalizeUsExchange,
  type DataQuality,
  type MarketCountry,
  type NormalizedMinuteCandle,
  type NormalizedOrderbook,
  type NormalizedPrice,
  type NormalizedRanking,
  type NormalizedTrade,
  type NormalizedWarning,
  type ScannerCandidate,
  type ScannerCriterion,
  type VolatilityInputs,
} from "./contracts.js";
import {
  adaptKisFluctuationRankings,
  adaptKisOverseasRankings,
  adaptKisVolumeRankings,
} from "./kis-common-adapter.js";
import type { KisRestClient, KisUsExchangeCode } from "./kis-rest-client.js";
import {
  aggregateRecoveredBars,
  scheduledSessionIntervalClose,
  type ScalpingLiveRuntime,
} from "./live-runtime.js";
import type { ScalpingScanner, ScannerResult } from "./scanner-service.js";
import type { TossMarketCalendarDay, TossScalpingProvider } from "./toss-provider.js";
import { marketLocalParts, marketSessionAnchor, marketTimeZone } from "./market-time.js";
import {
  krIntegratedSessionWindows,
  marketLocalTimestamp,
  marketSessionEffectiveMinute,
  marketSessionWindows,
  marketTradingSessionDate,
  sessionWindowForBarClose,
  sessionWindowForTrade,
  validateSessionWindows,
  type MarketSessionWindow,
} from "./market-session.js";

export const SCALPING_WORKSPACE_SCHEMA_VERSION = "scalping-workspace/v1" as const;
export const SCALPING_REALTIME_ANALYSIS_SCHEMA_VERSION = "scalping-realtime-analysis/v1" as const;

const WorkspacePresetSchema = z.enum(["trend", "breakout", "mean_reversion", "risk_management"]);
export type WorkspacePreset = z.infer<typeof WorkspacePresetSchema>;

const SYMBOL = /^[A-Z0-9][A-Z0-9._-]{0,31}$/;
const MINUTE_MS = 60_000;
const MARKET_CALENDAR_LOOKAHEAD_DAYS = 14;

export type ScalpingServiceConfig = {
  minimumTopCount: number;
  maximumTopCount: number;
  maximumSubscriptions: number;
  workspaceBarLimit: number;
  usWorkspaceBarLimit: number;
  workspaceChartBarLimit: number;
  candlePageSize: number;
  minimumAnalysisBars: number;
  barRefreshAfterMs: number;
  volumeProfileBucketCount: number;
  volumeProfileInstrumentLimit: number;
  relativeVolumeLookbackSessions: number;
  tradeFetchCount: number;
  forecastMinimumBars: number;
  forecastMaximumBars: number;
  evaluationMaximumOrigins: number;
  evaluationOriginStrideBars: number;
  preMarketOpenMinuteKst: number;
  preMarketCloseMinuteKst: number;
  sessionOpenMinuteKst: number;
  sessionCloseMinuteKst: number;
  afterMarketOpenMinuteKst: number;
  afterMarketCloseMinuteKst: number;
  now?: () => number;
};

type Repository = Pick<ScalpingRepository, "listBars" | "putBars" | "latestPredictions">;
type TossMarket = Pick<
  TossScalpingProvider,
  | "getRankings"
  | "getPrices"
  | "getMinuteCandles"
  | "getOrderbook"
  | "getTrades"
  | "getWarnings"
  | "getMarketCalendar"
  | "rateLimitSnapshot"
>;
type KisMarket = Pick<
  KisRestClient,
  | "getVolumeRanking"
  | "getFluctuationRanking"
  | "getOverseasVolumeRanking"
  | "getOverseasTradingAmountRanking"
>;
type RustCompute = Pick<RustComputeClient, "compute">;
type AiService = Pick<ScalpingAiService, "forecast" | "evaluate">;
type PortfolioSource = {
  getPortfolio(accountId?: string, force?: boolean, refreshAccounts?: boolean): Promise<Portfolio>;
  getInstruments(symbols: string[]): Promise<InstrumentInfo[]>;
};
type TradeMarkerSource = Pick<TechnicalTradeMarkerService, "getMarkers">;
type CausalPosition = Portfolio["holdings"][number] & { asOf: string };

export type ScalpingWorkspaceRequest = {
  marketCountry?: MarketCountry;
  criterion: ScannerCriterion;
  topCount: number;
  interval: "1m" | "5m" | "15m" | "30m" | "60m";
  layoutColumns: 1 | 2 | 3 | 4;
  preset: WorkspacePreset;
  symbols?: string[];
  scanOnly?: boolean;
  analysisSymbol?: string;
  accountId?: string;
  includePortfolioContext?: boolean;
};

export type ScalpingForecastRequest = {
  marketCountry?: MarketCountry;
  symbols: string[];
  interval: "1m" | "5m" | "15m" | "30m" | "60m";
};

export type ScalpingRealtimeAnalysisRequest = {
  marketCountry?: MarketCountry;
  symbols: string[];
  interval: "1m" | "5m" | "15m" | "30m" | "60m";
  preset: WorkspacePreset;
  accountId?: string;
  positionContext?: {
    mode: "isolated";
    positions: Array<{
      symbol: string;
      quantity: number;
      averagePrice: number;
      asOf: string;
    }>;
  };
};

export type ScalpingEvaluationRequest = ScalpingForecastRequest & {
  preset?: WorkspacePreset;
  evaluation: {
    walkForward: true;
    retrospective: true;
    commissionBpsPerSide: number;
    taxBpsOnExit: number;
    spreadBpsRoundTrip: number;
    slippageBpsPerSide: number;
  };
};

type UnknownRecord = Record<string, unknown>;
type AnalysisPosition = Pick<CausalPosition, "symbol" | "quantity" | "averagePrice" | "asOf">;

function record(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function normalizedSymbols(values: readonly string[], maximum: number): string[] {
  if (!Array.isArray(values) || values.length < 1 || values.length > maximum) throw new Error(`종목은 1~${maximum}개여야 합니다.`);
  const output = values.map((value) => value.trim().toUpperCase());
  if (output.some((value) => !SYMBOL.test(value))) throw new Error("종목 코드 형식이 올바르지 않습니다.");
  if (new Set(output).size !== output.length) throw new Error("중복 종목을 제거해 주세요.");
  return output;
}

function intervalMinutes(interval: ScalpingWorkspaceRequest["interval"]): ScalpingInterval {
  return Number.parseInt(interval, 10) as ScalpingInterval;
}

function quality(status: DataQuality["status"], reasons: string[], sources: DataQuality["sources"]): DataQuality {
  return DataQualitySchema.parse({ status, missing: [], reasons, sources, observedAt: new Date().toISOString() });
}

function degradedWorkspaceQuality(base: DataQuality, diagnosticCodes: readonly string[]): DataQuality {
  if (!diagnosticCodes.length) return base;
  return DataQualitySchema.parse({
    ...base,
    status: base.status === "source_unavailable" ? "source_unavailable" : "partial",
    missing: Array.from(new Set([...base.missing, ...diagnosticCodes.map((code) => `diagnostic:${code}`)])).slice(0, 64),
    reasons: Array.from(new Set([...base.reasons, ...diagnosticCodes])).slice(0, 64),
  });
}

function unavailableScannerResult(
  criterion: ScannerCriterion,
  requestedTopCount: number,
  generatedAt: string,
): ScannerResult {
  return {
    generatedAt,
    criterion,
    requestedTopCount,
    candidates: [],
    excluded: [],
    quality: DataQualitySchema.parse({
      status: "source_unavailable",
      missing: ["scanner_contract"],
      reasons: ["scanner_contract_unavailable"],
      sources: ["derived"],
      observedAt: generatedAt,
    }),
  };
}

function presetIndicators(preset: WorkspacePreset): Array<{ id: string; kind: string; parameters?: Record<string, unknown> }> {
  const scanner = [
    { id: "scanner-realized-volatility", kind: "historical_volatility", parameters: { period: 20, annualization: 1, return_type: "log" } },
    { id: "scanner-natr", kind: "normalized_atr", parameters: { period: 14 } },
    { id: "scanner-bollinger-width", kind: "bollinger_band_width_percent_b", parameters: { period: 20, stddev_multiplier: 2 } },
    { id: "scanner-rvol", kind: "relative_volume", parameters: { period: 20 } },
  ];
  const selected = preset === "trend" ? [
    { id: "trend-ema-fast", kind: "ema", parameters: { period: 20 } },
    { id: "trend-ema-slow", kind: "ema", parameters: { period: 50 } },
    { id: "trend-macd", kind: "macd", parameters: { fast_period: 12, slow_period: 26, signal_period: 9 } },
    { id: "trend-adx", kind: "adx_dmi", parameters: { period: 14 } },
    { id: "trend-supertrend", kind: "supertrend", parameters: { atr_period: 10, multiplier: 3 } },
  ] : preset === "breakout" ? [
    { id: "breakout-donchian", kind: "donchian_channel", parameters: { period: 20 } },
    { id: "breakout-bollinger", kind: "bollinger_bands", parameters: { period: 20, stddev_multiplier: 2 } },
    { id: "breakout-roc", kind: "roc", parameters: { period: 10 } },
  ] : preset === "mean_reversion" ? [
    { id: "mean-rsi", kind: "rsi", parameters: { period: 14 } },
    { id: "mean-bollinger", kind: "bollinger_bands", parameters: { period: 20, stddev_multiplier: 2 } },
    { id: "mean-stochastic", kind: "stochastic_oscillator", parameters: { lookback_period: 14, smooth_k: 3, smooth_d: 3 } },
    { id: "mean-cci", kind: "cci", parameters: { period: 20 } },
  ] : [
    { id: "risk-atr", kind: "atr", parameters: { period: 14 } },
    { id: "risk-natr", kind: "normalized_atr", parameters: { period: 14 } },
    { id: "risk-choppiness", kind: "choppiness_index", parameters: { period: 14 } },
    { id: "risk-parabolic-sar", kind: "parabolic_sar", parameters: { step: 0.02, max_step: 0.2 } },
  ];
  return [...scanner, ...selected.filter((candidate) => !scanner.some(({ kind }) => kind === candidate.kind))];
}

function instrumentType(item: InstrumentInfo | undefined): "stock" | "etf" | "fund" | "index" | "other" {
  const type = item?.securityType?.toLowerCase() ?? "";
  if (type.includes("etf")) return "etf";
  if (type.includes("fund")) return "fund";
  if (type.includes("index")) return "index";
  return type && !type.includes("stock") && !type.includes("equity") ? "other" : "stock";
}

function storeRecord(
  candle: NormalizedMinuteCandle,
  now: number,
  marketCountry: MarketCountry = "KR",
): IntradayBarRecord {
  const openMs = Date.parse(candle.timestamp);
  const currentMinute = Math.floor(now / MINUTE_MS) * MINUTE_MS;
  return {
    marketCountry,
    symbol: candle.symbol,
    intervalMinutes: 1,
    openTime: new Date(openMs).toISOString(),
    closeTime: new Date(openMs + MINUTE_MS).toISOString(),
    sessionDate: candle.sessionDate,
    source: "toss_rest",
    state: candle.status === "final" || openMs < currentMinute ? "final" : "forming",
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    ...(candle.volume === undefined ? {} : { volume: candle.volume }),
    ...(candle.tradingAmount === undefined ? {} : { turnover: candle.tradingAmount }),
    quality: "complete",
    updatedAt: now,
  };
}

function isCanonicalOneMinuteRecord(
  bar: IntradayBarRecord,
  marketCountry: MarketCountry,
  sessionWindows: readonly MarketSessionWindow[],
): boolean {
  if (bar.intervalMinutes !== 1) return false;
  const openMs = Date.parse(bar.openTime);
  const closeMs = Date.parse(bar.closeTime);
  if (!Number.isFinite(openMs) || !Number.isFinite(closeMs)
    || openMs % MINUTE_MS !== 0 || closeMs - openMs !== MINUTE_MS) return false;
  const openWindow = sessionWindowForTrade(bar.openTime, marketCountry, sessionWindows, bar.sessionDate);
  const closeWindow = sessionWindowForBarClose(bar.closeTime, marketCountry, sessionWindows, bar.sessionDate);
  return openWindow !== undefined
    && closeWindow === openWindow;
}

function groupBarsBySession(
  bars: readonly IntradayBarRecord[],
): Map<string, IntradayBarRecord[]> {
  const sessions = new Map<string, IntradayBarRecord[]>();
  for (const bar of bars) {
    const session = sessions.get(bar.sessionDate);
    if (session) session.push(bar);
    else sessions.set(bar.sessionDate, [bar]);
  }
  return sessions;
}

function targetStopFromAnalysis(analysis: unknown, symbol: string): z.infer<typeof AiTargetStopSchema> | undefined {
  const instruments = record(analysis)?.instruments;
  if (!Array.isArray(instruments)) return undefined;
  const instrument = instruments.find((value) => record(value)?.instrument_key === symbol);
  const signals = record(record(instrument)?.signals);
  const latest = record(signals?.latest) ?? (Array.isArray(signals?.points) ? record(signals.points.at(-1)) : undefined);
  const stop = finite(latest?.stop_candidate_price);
  const targetRange = record(latest?.target_price_range);
  const targetLow = finite(targetRange?.low);
  const targetHigh = finite(targetRange?.high);
  const basis = finite(latest?.basis_price);
  if (stop === undefined || targetLow === undefined || targetHigh === undefined || basis === undefined) return undefined;
  const target = (targetLow + targetHigh) / 2;
  if (stop < basis && basis < target) return { side: "long", target_price: target, stop_price: stop };
  if (target < basis && basis < stop) return { side: "short", target_price: target, stop_price: stop };
  return undefined;
}

function timestampKey(value: string): string | undefined {
  const instant = Date.parse(value);
  return Number.isFinite(instant) ? new Date(instant).toISOString() : undefined;
}

function evaluationSignalPoints(instrument: UnknownRecord | undefined): unknown[] {
  const snapshots = instrument?.signal_snapshots;
  if (Array.isArray(snapshots) && snapshots.length) return snapshots;
  const points = record(instrument?.signals)?.points;
  return Array.isArray(points) ? points : [];
}

function targetStopsByTimestamp(
  analysis: unknown,
  symbol: string,
): Map<string, z.infer<typeof AiTargetStopSchema>> {
  const output = new Map<string, z.infer<typeof AiTargetStopSchema>>();
  const instruments = record(analysis)?.instruments;
  if (!Array.isArray(instruments)) return output;
  const instrument = instruments.find((value) => record(value)?.instrument_key === symbol);
  for (const value of evaluationSignalPoints(record(instrument))) {
    const point = record(value);
    const timestamp = string(point?.calculation_timestamp);
    const stop = finite(point?.stop_candidate_price);
    const basis = finite(point?.basis_price);
    const targetCandidate = finite(point?.target_candidate_price);
    const targetRange = record(point?.target_price_range);
    const targetLow = targetCandidate ?? finite(targetRange?.low);
    const targetHigh = targetCandidate ?? finite(targetRange?.high);
    const key = timestamp ? timestampKey(timestamp) : undefined;
    if (!key || stop === undefined || basis === undefined || targetLow === undefined || targetHigh === undefined) continue;
    const target = (targetLow + targetHigh) / 2;
    if (stop < basis && basis < target) output.set(key, { side: "long", target_price: target, stop_price: stop });
    else if (target < basis && basis < stop) output.set(key, { side: "short", target_price: target, stop_price: stop });
  }
  return output;
}

function signalByTimestamp(analysis: unknown, symbol: string): Map<string, -1 | 0 | 1> {
  const output = new Map<string, -1 | 0 | 1>();
  const instruments = record(analysis)?.instruments;
  if (!Array.isArray(instruments)) return output;
  const instrument = instruments.find((value) => record(value)?.instrument_key === symbol);
  for (const value of evaluationSignalPoints(record(instrument))) {
    const point = record(value);
    const timestamp = string(point?.calculation_timestamp);
    const status = string(point?.status);
    const compact = finite(point?.technical_signal);
    const key = timestamp ? timestampKey(timestamp) : undefined;
    if (!key) continue;
    output.set(key, compact === 1 ? 1 : compact === -1 ? -1 : status === "entry_candidate" ? 1 : status === "exit_candidate" ? -1 : 0);
  }
  return output;
}

function regimeByTimestamp(analysis: unknown, symbol: string): Map<string, string> {
  const output = new Map<string, string>();
  const instruments = record(analysis)?.instruments;
  if (!Array.isArray(instruments)) return output;
  const instrument = instruments.find((value) => record(value)?.instrument_key === symbol);
  for (const value of evaluationSignalPoints(record(instrument))) {
    const point = record(value);
    const timestamp = string(point?.calculation_timestamp);
    const agreement = string(point?.multi_timeframe_agreement)?.trim();
    const key = timestamp ? timestampKey(timestamp) : undefined;
    if (key && agreement && agreement.length <= 64) output.set(key, agreement);
  }
  return output;
}

function scannerMetrics(analysis: unknown): Record<string, VolatilityInputs> {
  const output: Record<string, VolatilityInputs> = {};
  const instruments = record(analysis)?.instruments;
  if (!Array.isArray(instruments)) return output;
  for (const value of instruments) {
    const item = record(value);
    const key = string(item?.instrument_key);
    const metrics = record(item?.scanner_metrics);
    if (!key || !metrics) continue;
    const metric = (name: string) => {
      const entry = record(metrics[name]);
      return finite(entry?.value ?? record(entry?.values)?.value);
    };
    output[key] = {
      ...(metric("realized_volatility") === undefined ? {} : { realizedVolatility: metric("realized_volatility") }),
      ...(metric("normalized_atr") === undefined ? {} : { normalizedAtr: metric("normalized_atr") }),
      ...(metric("day_range_ratio") === undefined ? {} : { dayRangeRatio: metric("day_range_ratio") }),
      ...(metric("bollinger_width_expansion") === undefined ? {} : { bollingerWidthExpansion: metric("bollinger_width_expansion") }),
      ...(metric("relative_volume") === undefined ? {} : { relativeVolume: metric("relative_volume") }),
      ...(metric("trading_amount") === undefined ? {} : { tradingAmount: metric("trading_amount") }),
      ...(metric("spread_bps") === undefined ? {} : { spreadBps: metric("spread_bps") }),
    };
  }
  return output;
}

function rerankUsKisRankings(
  values: readonly NormalizedRanking[],
  criterion: ScannerCriterion,
): NormalizedRanking[] {
  const bySymbol = new Map<string, NormalizedRanking>();
  for (const value of values) {
    const current = bySymbol.get(value.symbol);
    if (!current) {
      bySymbol.set(value.symbol, { ...value });
      continue;
    }
    const exchange = current.exchange === value.exchange
      ? current.exchange
      : current.exchange === undefined ? value.exchange
        : value.exchange === undefined ? current.exchange : undefined;
    const merged: NormalizedRanking = {
      ...current,
      rankedAt: current.rankedAt > value.rankedAt ? current.rankedAt : value.rankedAt,
      volume: current.volume === undefined ? value.volume
        : value.volume === undefined ? current.volume : Math.max(current.volume, value.volume),
      tradingAmount: current.tradingAmount === undefined ? value.tradingAmount
        : value.tradingAmount === undefined ? current.tradingAmount : Math.max(current.tradingAmount, value.tradingAmount),
    };
    if (exchange) merged.exchange = exchange;
    else delete merged.exchange;
    bySymbol.set(value.symbol, merged);
  }
  const items = [...bySymbol.values()];
  const descendingRanks = (field: "volume" | "tradingAmount") => new Map(
    [...items]
      .sort((left, right) => (right[field] ?? -1) - (left[field] ?? -1) || left.symbol.localeCompare(right.symbol))
      .map((item, index) => [item.symbol, index + 1]),
  );
  const volumeRanks = descendingRanks("volume");
  const amountRanks = descendingRanks("tradingAmount");
  const score = (item: NormalizedRanking) => criterion === "volume"
    ? volumeRanks.get(item.symbol)!
    : criterion === "trading_amount" ? amountRanks.get(item.symbol)!
      : Math.min(volumeRanks.get(item.symbol)!, amountRanks.get(item.symbol)!);
  return items
    .sort((left, right) => score(left) - score(right)
      || (right.tradingAmount ?? -1) - (left.tradingAmount ?? -1)
      || (right.volume ?? -1) - (left.volume ?? -1)
      || left.symbol.localeCompare(right.symbol))
    .map((item, index) => ({ ...item, rank: index + 1 }));
}

type DomesticKisRanking = {
  venue: "KRX" | "NXT";
  ranking: NormalizedRanking;
};

export function rerankDomesticKisRankings(
  values: readonly DomesticKisRanking[],
  criterion: ScannerCriterion,
): NormalizedRanking[] {
  const bySymbolAndVenue = new Map<string, Map<DomesticKisRanking["venue"], NormalizedRanking>>();
  for (const { venue, ranking } of values) {
    const byVenue = bySymbolAndVenue.get(ranking.symbol) ?? new Map();
    const current = byVenue.get(venue);
    if (!current) {
      byVenue.set(venue, { ...ranking });
    } else {
      const representative = current.rank < ranking.rank
        || (current.rank === ranking.rank && current.rankedAt >= ranking.rankedAt) ? current : ranking;
      byVenue.set(venue, {
        ...representative,
        rank: Math.min(current.rank, ranking.rank),
        rankedAt: current.rankedAt > ranking.rankedAt ? current.rankedAt : ranking.rankedAt,
        volume: current.volume === undefined ? ranking.volume
          : ranking.volume === undefined ? current.volume : Math.max(current.volume, ranking.volume),
        tradingAmount: current.tradingAmount === undefined ? ranking.tradingAmount
          : ranking.tradingAmount === undefined ? current.tradingAmount : Math.max(current.tradingAmount, ranking.tradingAmount),
      });
    }
    bySymbolAndVenue.set(ranking.symbol, byVenue);
  }

  const items = [...bySymbolAndVenue.entries()].map(([symbol, byVenue]) => {
    const venueItems = [...byVenue.entries()]
      .sort(([leftVenue, left], [rightVenue, right]) => right.rankedAt.localeCompare(left.rankedAt)
        || (leftVenue === "NXT" ? -1 : rightVenue === "NXT" ? 1 : 0)
        || left.rank - right.rank);
    const representative = venueItems[0]![1];
    const sum = (field: "volume" | "tradingAmount") => {
      const present = venueItems.flatMap(([, item]) => item[field] === undefined ? [] : [item[field]]);
      return present.length ? present.reduce((total, value) => total + value, 0) : undefined;
    };
    return {
      ...representative,
      symbol,
      volume: sum("volume"),
      tradingAmount: sum("tradingAmount"),
    };
  });
  const descendingRanks = (field: "volume" | "tradingAmount") => new Map(
    [...items]
      .sort((left, right) => (right[field] ?? -1) - (left[field] ?? -1) || left.symbol.localeCompare(right.symbol))
      .map((item, index) => [item.symbol, index + 1]),
  );
  const volumeRanks = descendingRanks("volume");
  const amountRanks = descendingRanks("tradingAmount");
  const score = (item: NormalizedRanking) => criterion === "volume"
    ? volumeRanks.get(item.symbol)!
    : criterion === "trading_amount" ? amountRanks.get(item.symbol)!
      : Math.min(volumeRanks.get(item.symbol)!, amountRanks.get(item.symbol)!);
  return items
    .sort((left, right) => score(left) - score(right)
      || (right.tradingAmount ?? -1) - (left.tradingAmount ?? -1)
      || (right.volume ?? -1) - (left.volume ?? -1)
      || left.symbol.localeCompare(right.symbol))
    .map((item, index) => ({ ...item, rank: index + 1 }));
}

function marketMinute(timestamp: string, marketCountry: MarketCountry): { date: string; minute: number } {
  const parts = marketLocalParts(Date.parse(timestamp), marketCountry);
  return {
    date: `${parts.date.slice(0, 4)}-${parts.date.slice(4, 6)}-${parts.date.slice(6, 8)}`,
    minute: Number(parts.time.slice(0, 2)) * 60 + Number(parts.time.slice(2, 4)),
  };
}

function adjacentActiveMinuteBars(
  previous: IntradayBarRecord,
  current: IntradayBarRecord,
  marketCountry: MarketCountry,
  sessionWindows: readonly MarketSessionWindow[],
): boolean {
  if (previous.sessionDate !== current.sessionDate) return false;
  const previousMinute = marketSessionEffectiveMinute(previous.closeTime, previous.sessionDate, marketCountry);
  const currentMinute = marketSessionEffectiveMinute(current.closeTime, current.sessionDate, marketCountry);
  const previousWindow = sessionWindowForBarClose(previous.closeTime, marketCountry, sessionWindows, previous.sessionDate);
  const currentWindow = sessionWindowForBarClose(current.closeTime, marketCountry, sessionWindows, current.sessionDate);
  if (!previousWindow || !currentWindow) return false;
  if (previousWindow === currentWindow) {
    return Date.parse(current.closeTime) - Date.parse(previous.closeTime) === MINUTE_MS;
  }
  const previousIndex = sessionWindows.indexOf(previousWindow);
  const currentIndex = sessionWindows.indexOf(currentWindow);
  return previousIndex >= 0
    && currentIndex === previousIndex + 1
    && previousMinute === (previousWindow.localDateOffset ?? 0) * 24 * 60 + previousWindow.closeMinute
    && currentMinute === (currentWindow.localDateOffset ?? 0) * 24 * 60 + currentWindow.openMinute + 1;
}

type ConfirmedUsSessionSchedule = {
  windows: readonly MarketSessionWindow[];
  periods: readonly {
    kind: MarketSessionWindow["kind"];
    startAt: string;
    endAt: string;
  }[];
};

type ConfirmedUsCalendarSession =
  | { status: "closed" }
  | { status: "open"; schedule: ConfirmedUsSessionSchedule };

type ConfirmedKrCalendarSession =
  | { status: "closed" }
  | { status: "open"; minuteCloses: string[] };

type FutureTimestampUnavailableCode =
  | "future_market_schedule_unavailable"
  | "stale_final_bar";

type FutureTimestampResult =
  | {
      status: "available";
      timestamps: AiForecastRequest["series"][number]["future_timestamps"];
    }
  | {
      status: "unavailable";
      code: FutureTimestampUnavailableCode;
    };

type BarLoadOptions = {
  maximumBars?: number;
  forceLatestRefresh?: boolean;
  skipAutomaticRefresh?: boolean;
};

function calendarDateAfter(sessionDate: string, days: number): string | undefined {
  const epoch = Date.parse(`${sessionDate}T00:00:00.000Z`);
  if (!Number.isFinite(epoch) || !Number.isInteger(days) || days < 1) return undefined;
  return new Date(epoch + days * 24 * 60 * MINUTE_MS).toISOString().slice(0, 10);
}

function confirmedKrCalendarSession(
  calendar: TossMarketCalendarDay | undefined,
  sessionDate: string,
): ConfirmedKrCalendarSession | undefined {
  if (calendar?.marketCountry !== "KR" || calendar.sessionDate !== sessionDate) return undefined;
  const regular = calendar.regularMarket;
  if (!regular) return { status: "closed" };
  const startEpoch = Date.parse(regular.startAt);
  const endEpoch = Date.parse(regular.endAt);
  if (!Number.isFinite(startEpoch) || !Number.isFinite(endEpoch)
    || startEpoch % MINUTE_MS !== 0 || endEpoch % MINUTE_MS !== 0 || startEpoch >= endEpoch) return undefined;
  const start = marketMinute(regular.startAt, "KR");
  const end = marketMinute(regular.endAt, "KR");
  if (start.date !== sessionDate || end.date !== sessionDate) return undefined;
  const minuteCloses: string[] = [];
  for (let timestamp = startEpoch + MINUTE_MS; timestamp <= endEpoch; timestamp += MINUTE_MS) {
    minuteCloses.push(new Date(timestamp).toISOString());
  }
  return minuteCloses.length ? { status: "open", minuteCloses } : undefined;
}

function confirmedUsSessionSchedule(
  calendar: TossMarketCalendarDay | undefined,
  sessionDate: string,
): ConfirmedUsSessionSchedule | undefined {
  if (calendar?.marketCountry !== "US" || calendar.sessionDate !== sessionDate) return undefined;
  const periods = [
    ["day_market", calendar.dayMarket],
    ["pre_market", calendar.preMarket],
    ["regular_market", calendar.regularMarket],
    ["after_market", calendar.afterMarket],
  ] as const;
  const available = periods.flatMap(([kind, period]) => period ? [{ kind, ...period }] : []);
  if (!available.length) return undefined;
  const windows: MarketSessionWindow[] = [];
  for (const period of available) {
    const startEpoch = Date.parse(period.startAt);
    const endEpoch = Date.parse(period.endAt);
    if (!Number.isFinite(startEpoch) || !Number.isFinite(endEpoch)
      || startEpoch % MINUTE_MS !== 0 || endEpoch % MINUTE_MS !== 0 || startEpoch >= endEpoch) return undefined;
    const start = marketSessionEffectiveMinute(period.startAt, sessionDate, "US");
    const end = marketSessionEffectiveMinute(period.endAt, sessionDate, "US");
    if (start === undefined || end === undefined || start >= end || start < -24 * 60 || end > 24 * 60) return undefined;
    let cursor = start;
    while (cursor < end) {
      const localDateOffset = Math.floor(cursor / (24 * 60)) as -1 | 0;
      if (localDateOffset !== -1 && localDateOffset !== 0) return undefined;
      const nextMidnight = (localDateOffset + 1) * 24 * 60;
      const segmentEnd = Math.min(end, nextMidnight);
      const openMinute = cursor - localDateOffset * 24 * 60;
      const closeMinute = segmentEnd - localDateOffset * 24 * 60;
      if (openMinute < closeMinute) windows.push({
        kind: period.kind,
        openMinute,
        closeMinute,
        localDateOffset,
      });
      cursor = segmentEnd;
    }
  }
  try {
    validateSessionWindows(windows);
  } catch {
    return undefined;
  }
  return { windows, periods: available };
}

function confirmedUsCalendarSession(
  calendar: TossMarketCalendarDay | undefined,
  sessionDate: string,
): ConfirmedUsCalendarSession | undefined {
  if (calendar?.marketCountry !== "US" || calendar.sessionDate !== sessionDate) return undefined;
  const periods = [
    calendar.dayMarket,
    calendar.preMarket,
    calendar.regularMarket,
    calendar.afterMarket,
  ];
  if (periods.every((period) => period === null)) return { status: "closed" };
  const schedule = confirmedUsSessionSchedule(calendar, sessionDate);
  return schedule ? { status: "open", schedule } : undefined;
}

function configuredKrSessionWindows(config: ScalpingServiceConfig): readonly MarketSessionWindow[] {
  return krIntegratedSessionWindows({
    preMarketOpenMinuteKst: config.preMarketOpenMinuteKst,
    preMarketCloseMinuteKst: config.preMarketCloseMinuteKst,
    regularMarketOpenMinuteKst: config.sessionOpenMinuteKst,
    regularMarketCloseMinuteKst: config.sessionCloseMinuteKst,
    afterMarketOpenMinuteKst: config.afterMarketOpenMinuteKst,
    afterMarketCloseMinuteKst: config.afterMarketCloseMinuteKst,
  });
}

export class ScalpingService {
  private readonly now: () => number;
  private readonly workspaceSchema: z.ZodType<ScalpingWorkspaceRequest>;
  private readonly realtimeAnalysisInFlight = new Map<string, Promise<unknown>>();
  private latestWorkspaceContext?: {
    accountId?: string;
    marketCountry: MarketCountry;
    metadata: Map<string, InstrumentInfo>;
    holdings: Map<string, CausalPosition>;
  };

  constructor(
    private readonly toss: TossMarket,
    private readonly kis: KisMarket,
    private readonly scanner: Pick<ScalpingScanner, "scan">,
    private readonly live: Pick<ScalpingLiveRuntime, "snapshot" | "recover" | "state">,
    private readonly repository: Repository,
    private readonly rust: RustCompute | undefined,
    private readonly ai: AiService | undefined,
    private readonly portfolio: PortfolioSource | undefined,
    private readonly tradeMarkers: TradeMarkerSource | undefined,
    private readonly config: ScalpingServiceConfig,
  ) {
    if (!Number.isInteger(config.maximumSubscriptions)
      || config.maximumSubscriptions < config.maximumTopCount * 3) {
      throw new Error("maximumSubscriptions must cover standard execution, US day execution, and orderbook feeds for every visible symbol.");
    }
    if (!Number.isInteger(config.workspaceBarLimit) || config.workspaceBarLimit < 60 || config.workspaceBarLimit > 50_000) {
      throw new Error("workspaceBarLimit must be in 60..=50000.");
    }
    if (!Number.isInteger(config.usWorkspaceBarLimit) || config.usWorkspaceBarLimit < 60 || config.usWorkspaceBarLimit > 50_000) {
      throw new Error("usWorkspaceBarLimit must be in 60..=50000.");
    }
    if (!Number.isInteger(config.workspaceChartBarLimit) || config.workspaceChartBarLimit < 60
      || config.workspaceChartBarLimit > Math.max(config.workspaceBarLimit, config.usWorkspaceBarLimit)) {
      throw new Error("workspaceChartBarLimit is invalid.");
    }
    if (!Number.isInteger(config.candlePageSize) || config.candlePageSize < 1
      || config.candlePageSize > Math.min(config.workspaceBarLimit, config.usWorkspaceBarLimit)) {
      throw new Error("candlePageSize is invalid.");
    }
    if (config.minimumAnalysisBars < 1
      || config.minimumAnalysisBars > Math.min(config.workspaceBarLimit, config.usWorkspaceBarLimit)) {
      throw new Error("minimumAnalysisBars is invalid.");
    }
    if (config.forecastMinimumBars < 1 || config.forecastMaximumBars < config.forecastMinimumBars) throw new Error("forecast bar limits are invalid.");
    validateSessionWindows(configuredKrSessionWindows(config));
    this.now = config.now ?? Date.now;
    this.workspaceSchema = createScannerRequestSchema(config).extend({
      interval: MinuteIntervalSchema,
      layoutColumns: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
      preset: WorkspacePresetSchema,
      symbols: z.array(z.string()).max(config.maximumTopCount).optional(),
      scanOnly: z.boolean().optional(),
      analysisSymbol: z.string().optional(),
      accountId: z.string().trim().min(1).max(128).optional(),
      includePortfolioContext: z.boolean().optional(),
    }).superRefine((request, context) => {
      if ((request.symbols?.length ?? 0) > request.topCount) {
        context.addIssue({
          code: "custom",
          path: ["symbols"],
          message: "사용자 지정 종목 수는 표시 종목 수를 넘을 수 없습니다.",
        });
      }
      if (request.scanOnly && request.analysisSymbol) {
        context.addIssue({
          code: "custom",
          path: ["analysisSymbol"],
          message: "목록 스캔과 상세 분석 종목은 한 요청에서 함께 지정할 수 없습니다.",
        });
      }
    }) as z.ZodType<ScalpingWorkspaceRequest>;
  }

  status(enabled = true) {
    return {
      schemaVersion: SCALPING_WORKSPACE_SCHEMA_VERSION,
      enabled,
      limits: {
        topCount: { minimum: this.config.minimumTopCount, maximum: this.config.maximumTopCount },
        maximumSubscriptions: this.config.maximumSubscriptions,
        intervals: [1, 5, 15, 30, 60],
        layoutColumns: [1, 2, 3, 4],
        workspaceBarLimit: this.config.workspaceBarLimit,
        workspaceBarLimits: { KR: this.config.workspaceBarLimit, US: this.config.usWorkspaceBarLimit },
        workspaceChartBarLimit: this.config.workspaceChartBarLimit,
        evaluationMaximumOrigins: this.config.evaluationMaximumOrigins,
      },
      providers: {
        toss: { status: "configured", configured: true, rateLimits: {
          ranking: this.toss.rateLimitSnapshot("ranking"),
          marketData: this.toss.rateLimitSnapshot("market_data"),
          chart: this.toss.rateLimitSnapshot("chart"),
          marketInfo: this.toss.rateLimitSnapshot("market_info"),
        } },
        kis: { status: this.live.state.connection, configured: true, websocket: this.live.state },
        ai: { status: this.ai ? "configured" : "unavailable", configured: Boolean(this.ai) },
        rust: { status: this.rust ? "configured" : "unavailable", configured: Boolean(this.rust) },
      },
      capabilities: {
        autoOrder: false,
        mcp: false,
        historicalOrderbook: false,
        retrospectiveEvaluation: Boolean(this.ai),
        scannerMarkets: ["KR", "US"],
      },
      sessions: {
        KR: {
          timezone: "Asia/Seoul",
          policy: "KRX_NXT_evidence_based",
          eligibility: "per_instrument_latest_session_bar_evidence",
          windows: configuredKrSessionWindows(this.config),
        },
        US: {
          timezone: "America/New_York",
          policy: "toss_calendar_confirmed_extended_hours",
          eligibility: "date_specific_day_pre_regular_after_periods",
          windows: marketSessionWindows("US", configuredKrSessionWindows(this.config)),
        },
      },
      limitations: [
        "과거 호가 이력은 공급자가 제공하지 않아 unavailable입니다.",
        "저유동성 거래대금 필터 단위는 국내 KRW, 미국 USD입니다.",
        "현재 KIS 권한에서는 NXT 등락률 랭킹을 사용할 수 없어 NXT 거래량 후보와 Rust 변동성 지표로 보완합니다.",
        "미국 KIS 실시간 호가는 최우선 매수·매도 1호가만 제공하며 데이마켓 호가는 제공하지 않습니다.",
        "미국 데이마켓은 KIS 체결 피드와 Toss 캘린더·분봉으로 지원하며 호가 기반 지표는 unavailable 또는 partial일 수 있습니다.",
        "신호는 주문 지시나 수익 보장이 아니며 실제 주문을 실행하지 않습니다.",
      ],
    };
  }

  async workspace(input: ScalpingWorkspaceRequest) {
    const request = this.workspaceSchema.parse(input);
    const marketCountry = request.marketCountry ?? "KR";
    const analysisSymbol = request.analysisSymbol
      ? normalizedSymbols([request.analysisSymbol], 1)[0]
      : undefined;
    const configuredSymbols = request.symbols ? normalizedSymbols(request.symbols, this.config.maximumTopCount) : [];
    const requestedSymbols = analysisSymbol && !configuredSymbols.includes(analysisSymbol)
      ? [analysisSymbol, ...configuredSymbols].slice(0, request.topCount)
      : configuredSymbols;
    const rankingsAttempt = await this.safe(
      () => this.collectRankings(request.criterion, request.topCount, marketCountry),
      "ranking_collection_unavailable",
    );
    const rankingsResult = rankingsAttempt.value ?? {
      rankings: [],
      errors: { toss: "ranking_collection_unavailable", kis: "ranking_collection_unavailable" },
      diagnostics: ["ranking_collection_unavailable"],
    };
    const universe = this.universe(
      rankingsResult.rankings,
      requestedSymbols,
      request.topCount,
      request.criterion,
    );
    const calculationSymbols = request.scanOnly
      ? (request.criterion === "volatility" ? universe : [])
      : analysisSymbol ? [analysisSymbol] : universe;
    const [pricesResult, instrumentsResult, portfolioResult, barsResult, enrichmentResult] = await Promise.all([
      this.safe(() => this.toss.getPrices(universe), "toss_prices"),
      this.portfolio
        ? this.safe(() => this.portfolio!.getInstruments(universe), "toss_instruments")
        : Promise.resolve<{ value?: InstrumentInfo[]; error?: string }>({ value: [] }),
      request.includePortfolioContext !== false && this.portfolio
        ? this.safe(() => this.portfolio!.getPortfolio(request.accountId, false, false), "portfolio")
        : Promise.resolve<{ value?: Portfolio; error?: string }>({}),
      calculationSymbols.length
        ? this.loadBarsWithDiagnostics(calculationSymbols, intervalMinutes(request.interval), marketCountry)
        : Promise.resolve({ barsBySymbol: new Map<string, IntradayBarRecord[]>(), errors: [] as string[] }),
      this.safe(() => this.enrich(universe, marketCountry), "quote_enrichment_unavailable"),
    ]);
    const barsBySymbol = barsResult.barsBySymbol;
    const bookAndWarnings = enrichmentResult.value ?? {
      books: new Map<string, NormalizedOrderbook>(),
      warnings: [] as NormalizedWarning[],
      trades: new Map<string, NormalizedTrade[]>(),
      warningUnavailable: new Set(universe),
      errors: ["quote_enrichment_unavailable"],
    };
    const priceBySymbol = new Map((pricesResult.value ?? []).map((value) => [value.symbol, value]));
    const metadata = new Map((instrumentsResult.value ?? []).map((item) => [item.symbol, item]));
    const portfolioValue = portfolioResult.value;
    const holdings = new Map<string, CausalPosition>((portfolioValue?.holdings ?? [])
      .filter((item) => !item.currency || item.currency === (marketCountry === "US" ? "USD" : "KRW"))
      .map((item): [string, CausalPosition] => [
        item.symbol.toUpperCase(),
        { ...item, asOf: portfolioValue!.asOf },
      ]));
    if (request.includePortfolioContext !== false) {
      this.latestWorkspaceContext = {
        ...(request.accountId ? { accountId: request.accountId } : {}),
        marketCountry,
        metadata: new Map(metadata),
        holdings: new Map(holdings),
      };
    }
    const analysisResult = calculationSymbols.length
      ? await this.safe(() => this.computeAnalysis({
        symbols: calculationSymbols,
        interval: intervalMinutes(request.interval),
        preset: request.preset,
        barsBySymbol,
        metadata,
        holdings,
        books: bookAndWarnings.books,
        trades: bookAndWarnings.trades,
        marketCountry,
        responseMode: "full_series",
        includeVolumeProfile: !request.scanOnly,
      }), "rust_analysis_unavailable")
      : { value: undefined, error: undefined };
    const analysis = analysisResult.value;
    let scanError: string | undefined;
    let scan: ScannerResult;
    try {
      scan = this.scanner.scan({ marketCountry, criterion: request.criterion, topCount: request.topCount }, {
        rankings: rankingsResult.rankings,
        prices: pricesResult.value ?? [],
        orderbooks: [...bookAndWarnings.books.values()],
        warnings: bookAndWarnings.warnings,
        instrumentStates: universe.map((symbol) => {
          const suspended = this.liveSnapshot(symbol, marketCountry).tradingHalted === true;
          const warningUnavailable = bookAndWarnings.warningUnavailable.has(symbol);
          return {
          symbol,
          suspended,
          managed: false,
          liquidationTrading: false,
          investmentCaution: false,
          unsupported: false,
          reasons: [
            ...(suspended ? ["kis_realtime_trading_halted"] : []),
            ...(warningUnavailable ? ["investment_warning_status_unavailable"] : []),
          ],
        };
        }),
        volatilityInputs: scannerMetrics(analysis),
        sourceErrors: {
          ...rankingsResult.errors,
          ...(pricesResult.error ? { toss: pricesResult.error } : {}),
        },
      });
    } catch {
      scanError = "scanner_contract_unavailable";
      scan = unavailableScannerResult(request.criterion, request.topCount, new Date(this.now()).toISOString());
    }
    const candidates = this.withRequestedCandidates(
      scan,
      requestedSymbols,
      request.topCount,
      priceBySymbol,
      marketCountry,
      metadata,
    );
    const candidateSymbols = candidates.map(({ symbol }) => symbol);
    const selectedSymbols = request.scanOnly
      ? []
      : analysisSymbol ? candidateSymbols.filter((symbol) => symbol === analysisSymbol) : candidateSymbols;
    const predictions = selectedSymbols.length
      ? await this.repository.latestPredictions(selectedSymbols, false, marketCountry).catch(() => [])
      : [];
    const predictionBySymbol = new Map(predictions.map((prediction) => [prediction.symbol, prediction]));
    const markerFromDate = Array.from(barsBySymbol.values()).flat().map((bar) => bar.sessionDate).sort()[0];
    const markerResult = selectedSymbols.length && portfolioValue && this.tradeMarkers
      ? await this.safe(() => this.tradeMarkers!.getMarkers({
        accountId: portfolioValue.selectedAccountId,
        symbols: selectedSymbols,
        ...(markerFromDate ? { fromDate: markerFromDate } : {}),
      }), "trade_markers")
      : { value: undefined };
    const analysisBySymbol = new Map<string, unknown>();
    const analysisInstruments = record(analysis)?.instruments;
    if (Array.isArray(analysisInstruments)) {
      for (const item of analysisInstruments) {
        const key = string(record(item)?.instrument_key);
        if (key) analysisBySymbol.set(key, item);
      }
    }
    const markerBySymbol = new Map<string, unknown[]>();
    const markers = record(markerResult.value)?.markers;
    if (Array.isArray(markers)) {
      for (const marker of markers) {
        const symbol = string(record(marker)?.symbol);
        if (symbol) markerBySymbol.set(symbol, [...(markerBySymbol.get(symbol) ?? []), marker]);
      }
    }
    const diagnosticCodes = Array.from(new Set([
      ...Object.values(rankingsResult.errors),
      ...rankingsResult.diagnostics,
      pricesResult.error,
      instrumentsResult.error,
      portfolioResult.error,
      markerResult.error,
      ...barsResult.errors,
      analysisResult.error,
      scanError,
      ...bookAndWarnings.errors,
    ].filter((value): value is string => Boolean(value))));
    return {
      workspace: {
        schemaVersion: SCALPING_WORKSPACE_SCHEMA_VERSION,
        generatedAt: new Date(this.now()).toISOString(),
        marketCountry,
        criterion: request.criterion,
        requestedTopCount: request.topCount,
        interval: request.interval,
        layoutColumns: request.layoutColumns,
        preset: request.preset,
        analysisSymbol,
        candidates,
        excluded: scan.excluded,
        instruments: selectedSymbols.map((symbol) => ({
          symbol,
          metadata: metadata.get(symbol),
          bars: (barsBySymbol.get(symbol) ?? []).slice(-this.config.workspaceChartBarLimit),
          orderbook: bookAndWarnings.books.get(symbol),
          orderbookStatus: bookAndWarnings.books.has(symbol)
            ? {
                status: "available",
                source: marketCountry === "US" ? "kis_ws" : "kis_ws_or_toss_rest",
                ...(marketCountry === "US" ? { depth: "top_of_book" } : {}),
              }
            : {
                status: "unavailable",
                code: marketCountry === "US" ? "kis_us_orderbook_unavailable" : "realtime_orderbook_unavailable",
                reason: marketCountry === "US"
                  ? "현재 세션의 신선한 KIS 미국 1호가가 없습니다. 데이마켓 호가는 제공되지 않으며 Toss 미국 호가를 대체 근거로 사용하지 않습니다."
                  : "현재 사용할 수 있는 실시간 호가가 없습니다.",
              },
          technical: analysisBySymbol.get(symbol) ?? {
            status: "unavailable",
            reason: analysisResult.error ?? (this.rust ? "insufficient_final_bars" : "rust_worker_unavailable"),
          },
          realtime: {
            ...this.liveSnapshot(symbol, marketCountry),
            historicalOrderbook: { status: "unavailable", reason: "historical_orderbook_not_supplied" },
          },
          position: holdings.get(symbol) ?? { status: "unavailable", reason: "not_held_or_portfolio_unavailable" },
          tradeMarkers: markerBySymbol.get(symbol) ?? [],
          prediction: predictionBySymbol.get(symbol) ?? {
            status: "unavailable", reason: this.ai ? "prediction_not_generated" : "ai_worker_unavailable",
          },
        })),
        quality: degradedWorkspaceQuality(scan.quality, diagnosticCodes),
        diagnostics: {
          providerErrors: diagnosticCodes,
          analysisBatchInstrumentCount: calculationSymbols.length,
          analysisBatchRequestCount: this.rust && analysis ? 1 : 0,
          browserIndicatorCalculation: false,
          tradingAmountUnit: marketCountry === "US" ? "USD" : "KRW",
          ...(marketCountry === "US" ? {
            orderbookPolicy: "fresh_kis_standard_feed_top_of_book_only; day_market_unavailable; no_toss_fallback",
          } : {}),
        },
      },
    };
  }

  async forecast(input: ScalpingForecastRequest) {
    const request = this.forecastSchema(input);
    if (!this.ai || !this.rust) {
      return { forecast: { status: "unavailable", code: !this.ai ? "ai_worker_unavailable" : "rust_worker_unavailable" }, predictions: [] };
    }
    const forecastHistoryLimit = this.forecastHistoryBarLimit(request.marketCountry);
    let barsBySymbol = await this.loadBars(request.symbols, 1, request.marketCountry, {
      maximumBars: forecastHistoryLimit,
      skipAutomaticRefresh: true,
    });
    const refreshCutoff = this.now();
    const refreshSymbols = request.symbols.filter((symbol) => {
      const latestFinal = this.instrumentSessionBars(
        barsBySymbol.get(symbol) ?? [],
        request.marketCountry,
      ).bars.at(-1);
      const nextMinute = latestFinal ? Date.parse(latestFinal.closeTime) + MINUTE_MS : Number.NaN;
      return !Number.isFinite(nextMinute) || nextMinute <= refreshCutoff;
    });
    if (refreshSymbols.length) {
      const refreshed = await this.loadBars(refreshSymbols, 1, request.marketCountry, {
        maximumBars: forecastHistoryLimit,
        forceLatestRefresh: true,
      });
      barsBySymbol = new Map(barsBySymbol);
      for (const symbol of refreshSymbols) {
        barsBySymbol.set(symbol, refreshed.get(symbol) ?? []);
      }
    }
    // A provider's "final" flag alone does not prove that a candle has closed.
    // Freeze one batch-wide cutoff and exclude future closes from both Rust
    // technical analysis and the AI request.
    const dataCutoff = this.now();
    barsBySymbol = new Map([...barsBySymbol].map(([symbol, values]) => [
      symbol,
      values.filter((bar) => Date.parse(bar.closeTime) <= dataCutoff),
    ]));
    const metadata = await this.instrumentMetadata(request.symbols);
    const analysis = await this.computeAnalysis({
      symbols: request.symbols, interval: 1, preset: "risk_management", barsBySymbol, metadata,
      holdings: new Map(), books: new Map(), trades: new Map(), responseMode: "latest_summary", includeVolumeProfile: false,
      marketCountry: request.marketCountry,
    });
    // Capture a new cutoff after Rust. A final dispatch-wide check below also
    // covers slow calendar calls and a minute boundary crossed while building
    // a multi-symbol request.
    const forecastCutoff = this.now();
    const unavailable: Array<{ symbol: string; code: string }> = [];
    const series: AiForecastRequest["series"] = [];
    const calendarByMarketDate = new Map<string, Promise<TossMarketCalendarDay | undefined>>();
    const loadMarketCalendar = (marketCountry: MarketCountry, sessionDate: string) => {
      const key = `${marketCountry}:${sessionDate}`;
      const existing = calendarByMarketDate.get(key);
      if (existing) return existing;
      const pending = this.safe(
        () => this.toss.getMarketCalendar(marketCountry, sessionDate),
        "toss_market_calendar",
      ).then(({ value }) => value);
      calendarByMarketDate.set(key, pending);
      return pending;
    };
    for (const symbol of request.symbols) {
      const session = this.instrumentSessionBars(barsBySymbol.get(symbol) ?? [], request.marketCountry);
      const finalBars = session.bars.slice(-this.config.forecastMaximumBars);
      if (finalBars.length < this.config.forecastMinimumBars) {
        unavailable.push({ symbol, code: "insufficient_history" });
        continue;
      }
      let usSchedule: ConfirmedUsSessionSchedule | undefined;
      if (request.marketCountry === "US") {
        const calendar = await loadMarketCalendar("US", finalBars.at(-1)!.sessionDate);
        const confirmed = confirmedUsCalendarSession(calendar, finalBars.at(-1)!.sessionDate);
        if (confirmed?.status !== "open") {
          unavailable.push({ symbol, code: "future_market_schedule_unavailable" });
          continue;
        }
        usSchedule = confirmed.schedule;
      }
      const future = await this.liveFutureTimestamps(
        finalBars.at(-1)!,
        request.marketCountry,
        usSchedule,
        session.windows,
        (sessionDate) => loadMarketCalendar(request.marketCountry, sessionDate),
        forecastCutoff,
      );
      if (future.status === "unavailable") {
        unavailable.push({ symbol, code: future.code });
        continue;
      }
      series.push({
        instrument_key: symbol,
        timezone: marketTimeZone(request.marketCountry),
        input_end_at: finalBars.at(-1)!.closeTime,
        future_timestamps: future.timestamps,
        bars: finalBars.map((bar) => this.aiBar(bar)),
        target_stop: targetStopFromAnalysis(analysis, symbol) ?? null,
      });
    }
    const dispatchCutoff = this.now();
    const freshSeries = series.filter((item) => {
      if (Date.parse(item.future_timestamps[0]!) > dispatchCutoff) return true;
      unavailable.push({ symbol: item.instrument_key, code: "stale_final_bar" });
      return false;
    });
    if (!freshSeries.length) return {
      forecast: { status: "unavailable", series: unavailable },
      predictions: unavailable.map(({ symbol, code }) => ({
        symbol,
        status: "unavailable",
        unavailable: { code, message: code },
      })),
    };
    const output = await this.ai.forecast({
      schema_version: SCALPING_AI_SCHEMA_VERSION,
      request_id: `forecast:${randomUUID()}`,
      mode: "forecast",
      horizons_minutes: [...SCALPING_AI_HORIZONS],
      quantiles: [...SCALPING_AI_QUANTILES],
      seed: 0,
      series: freshSeries,
    }, undefined, request.marketCountry);
    return {
      forecast: output.response,
      predictions: [
        ...output.predictions,
        ...unavailable.map(({ symbol, code }) => ({
          symbol,
          status: "unavailable" as const,
          unavailable: { code, message: code },
        })),
      ],
      unavailable,
    };
  }

  async realtimeAnalysis(input: ScalpingRealtimeAnalysisRequest): Promise<unknown> {
    const parsed = z.object({
      marketCountry: MarketCountrySchema.default("KR"),
      symbols: z.array(z.string()),
      interval: MinuteIntervalSchema,
      preset: WorkspacePresetSchema,
      accountId: z.string().trim().min(1).max(128).optional(),
      positionContext: z.object({
        mode: z.literal("isolated"),
        positions: z.array(z.object({
          symbol: z.string(),
          quantity: z.number().finite().positive(),
          averagePrice: z.number().finite().positive(),
          asOf: z.string().datetime({ offset: true }),
        }).strict()).max(this.config.maximumTopCount),
      }).strict().optional(),
    }).strict().superRefine((request, context) => {
      if (!request.positionContext) return;
      const requested = new Set(request.symbols.map((symbol) => symbol.trim().toUpperCase()));
      const seen = new Set<string>();
      for (const [index, position] of request.positionContext.positions.entries()) {
        const symbol = position.symbol.trim().toUpperCase();
        if (!requested.has(symbol)) {
          context.addIssue({
            code: "custom",
            path: ["positionContext", "positions", index, "symbol"],
            message: "격리 포지션은 분석 요청 종목에 포함되어야 합니다.",
          });
        }
        if (seen.has(symbol)) {
          context.addIssue({
            code: "custom",
            path: ["positionContext", "positions", index, "symbol"],
            message: "격리 포지션 종목은 중복될 수 없습니다.",
          });
        }
        seen.add(symbol);
      }
    }).parse(input);
    const symbols = normalizedSymbols(parsed.symbols, this.config.maximumTopCount);
    const interval = intervalMinutes(parsed.interval);
    const barsBySymbol = new Map<string, IntradayBarRecord[]>();
    await Promise.all(symbols.map(async (symbol) => {
      const loaded = await this.loadBarsForSymbol(symbol, interval, parsed.marketCountry);
      barsBySymbol.set(symbol, loaded.bars);
    }));
    const revision = symbols.map((symbol) => {
      const latest = this.instrumentSessionBars(barsBySymbol.get(symbol) ?? [], parsed.marketCountry).bars.at(-1);
      return `${symbol}:${latest?.closeTime ?? "unavailable"}:${latest?.updatedAt ?? 0}`;
    }).join("|");
    const isolatedHoldings = parsed.positionContext
      ? new Map<string, AnalysisPosition>(parsed.positionContext.positions.map((position) => {
          const symbol = position.symbol.trim().toUpperCase();
          return [symbol, { ...position, symbol, asOf: new Date(position.asOf).toISOString() }];
        }))
      : undefined;
    const positionRevision = isolatedHoldings
      ? [...isolatedHoldings.values()]
          .sort((left, right) => left.symbol.localeCompare(right.symbol))
          .map((position) => `${position.symbol}:${position.quantity}:${position.averagePrice}:${position.asOf}`)
          .join("|") || "empty"
      : `workspace:${parsed.accountId ?? "default"}`;
    const key = `${parsed.marketCountry}:${parsed.interval}:${parsed.preset}:${positionRevision}:${revision}`;
    const existing = this.realtimeAnalysisInFlight.get(key);
    if (existing) return existing;
    const task = (async () => {
      const context = this.latestWorkspaceContext
        && this.latestWorkspaceContext.accountId === parsed.accountId
        && this.latestWorkspaceContext.marketCountry === parsed.marketCountry
        ? this.latestWorkspaceContext
        : undefined;
      const books = new Map<string, NormalizedOrderbook>();
      const trades = new Map<string, NormalizedTrade[]>();
      for (const symbol of symbols) {
        const snapshot = this.liveSnapshot(symbol, parsed.marketCountry);
        if (snapshot.orderbook) books.set(symbol, snapshot.orderbook);
        if (snapshot.trade) trades.set(symbol, [snapshot.trade]);
      }
      const technical = await this.computeAnalysis({
        symbols,
        interval,
        preset: parsed.preset,
        barsBySymbol,
        metadata: context?.metadata ?? new Map(),
        holdings: isolatedHoldings ?? context?.holdings ?? new Map(),
        books,
        trades,
        marketCountry: parsed.marketCountry,
        responseMode: "latest_summary",
        includeVolumeProfile: false,
      });
      return {
        schemaVersion: SCALPING_REALTIME_ANALYSIS_SCHEMA_VERSION,
        generatedAt: new Date(this.now()).toISOString(),
        marketCountry: parsed.marketCountry,
        interval: parsed.interval,
        preset: parsed.preset,
        barRevision: revision,
        technical: technical ?? {
          status: "unavailable",
          reason: this.rust ? "insufficient_final_bars" : "rust_worker_unavailable",
        },
        diagnostics: {
          analysisBatchRequestCount: this.rust && technical ? 1 : 0,
          analysisBatchInstrumentCount: symbols.length,
          finalizedBarsOnly: true,
          providerRescan: false,
          positionContext: isolatedHoldings
            ? "isolated_request"
            : context ? "latest_workspace_snapshot" : "unavailable",
        },
      };
    })();
    this.realtimeAnalysisInFlight.set(key, task);
    try {
      return await task;
    } finally {
      if (this.realtimeAnalysisInFlight.get(key) === task) this.realtimeAnalysisInFlight.delete(key);
    }
  }

  async evaluate(input: ScalpingEvaluationRequest, ownerSubject = "owner") {
    const request = this.evaluationSchema(input);
    if (!this.ai || !this.rust) throw new Error(!this.ai ? "AI worker is unavailable." : "Rust worker is unavailable.");
    const barsBySymbol = await this.loadBars(request.symbols, 1, request.marketCountry);
    const metadata = await this.instrumentMetadata(request.symbols);
    const baseOriginQuota = Math.floor(this.config.evaluationMaximumOrigins / request.symbols.length);
    const originRemainder = this.config.evaluationMaximumOrigins % request.symbols.length;
    const originIndexesBySymbol = new Map<string, number[]>();
    const signalSnapshotTimestamps = new Map<string, string[]>();
    for (const [symbolIndex, symbol] of request.symbols.entries()) {
      const session = this.instrumentSessionBars(barsBySymbol.get(symbol) ?? [], request.marketCountry);
      const finalBars = session.bars;
      const candidateIndexes: number[] = [];
      for (let index = this.config.forecastMinimumBars - 1; index + 60 < finalBars.length; index += this.config.evaluationOriginStrideBars) {
        const window = finalBars.slice(index, index + 61);
        if (window.length === 61 && window.every((bar, offset) => (
          bar.sessionDate === window[0]!.sessionDate
          && (offset === 0 || adjacentActiveMinuteBars(
            window[offset - 1]!,
            bar,
            request.marketCountry,
            session.windows,
          ))
        ))) candidateIndexes.push(index);
      }
      const quota = baseOriginQuota + (symbolIndex < originRemainder ? 1 : 0);
      const indexes = quota > 0 ? candidateIndexes.slice(-quota) : [];
      originIndexesBySymbol.set(symbol, indexes);
      if (indexes.length) {
        signalSnapshotTimestamps.set(
          symbol,
          indexes.map((index) => marketLocalTimestamp(finalBars[index]!.closeTime, request.marketCountry)),
        );
      }
    }
    const analysis = await this.computeAnalysis({
      symbols: request.symbols, interval: 1, preset: request.preset, barsBySymbol, metadata,
      holdings: new Map(), books: new Map(), trades: new Map(), responseMode: "full_series", includeVolumeProfile: false,
      marketCountry: request.marketCountry,
      signalSnapshotTimestamps,
    });
    const technicalInstruments = new Map<string, UnknownRecord>();
    const rawTechnicalInstruments = record(analysis)?.instruments;
    if (Array.isArray(rawTechnicalInstruments)) {
      for (const value of rawTechnicalInstruments) {
        const instrument = record(value);
        const key = string(instrument?.instrument_key);
        if (instrument && key) technicalInstruments.set(key, instrument);
      }
    }
    const excluded: Array<{
      symbol: string;
      status: "unavailable";
      code: string;
      reason: string;
    }> = [];
    const series: AiEvaluateRequest["series"] = [];
    for (const symbol of request.symbols) {
      const technicalInstrument = technicalInstruments.get(symbol);
      const technicalAvailability = record(technicalInstrument?.availability);
      const technicalSignals = record(technicalInstrument?.signals);
      const technicalPoints = technicalSignals?.points;
      const technicalSnapshots = technicalInstrument?.signal_snapshots;
      const explicitUnavailable = string(technicalInstrument?.status) === "unavailable"
        || string(technicalAvailability?.status) === "unavailable";
      if (!technicalInstrument || explicitUnavailable || (
        (!Array.isArray(technicalSnapshots) || !technicalSnapshots.length)
        && (!Array.isArray(technicalPoints) || !technicalPoints.length)
      )) {
        excluded.push({
          symbol,
          status: "unavailable",
          code: string(technicalInstrument?.reason) ?? "technical_analysis_unavailable",
          reason: string(technicalAvailability?.reason) ?? "full_series_technical_signals_required",
        });
        continue;
      }
      const session = this.instrumentSessionBars(
        barsBySymbol.get(symbol) ?? [],
        request.marketCountry,
      );
      const finalBars = session.bars;
      const signals = signalByTimestamp(analysis, symbol);
      const regimes = regimeByTimestamp(analysis, symbol);
      const targetStops = targetStopsByTimestamp(analysis, symbol);
      const indexes = originIndexesBySymbol.get(symbol) ?? [];
      if (!indexes.length) continue;
      series.push({
        instrument_key: symbol,
        timezone: marketTimeZone(request.marketCountry),
        bars: finalBars.map((bar) => this.aiBar(bar)),
        origins: indexes.map((index) => ({
          origin: finalBars[index]!.closeTime,
          future_timestamps: finalBars.slice(index + 1, index + 61).map((bar) => bar.closeTime) as AiEvaluateRequest["series"][number]["origins"][number]["future_timestamps"],
          technical_signal: signals.get(timestampKey(finalBars[index]!.closeTime)!) ?? 0,
          regime: regimes.get(timestampKey(finalBars[index]!.closeTime)!) ?? null,
          target_stop: targetStops.get(timestampKey(finalBars[index]!.closeTime)!) ?? null,
        })),
      });
    }
    if (!series.length) {
      if (excluded.length) return {
        status: "unavailable" as const,
        code: "technical_analysis_unavailable",
        excluded,
        retrospective: true as const,
        walkForward: true as const,
        randomSplit: false as const,
      };
      throw new Error("시간 순서 평가에 필요한 과거 분봉이 부족합니다.");
    }
    const queued = await this.ai.evaluate({
      schema_version: SCALPING_AI_SCHEMA_VERSION,
      request_id: `evaluation:${randomUUID()}`,
      mode: "evaluate",
      horizons_minutes: [...SCALPING_AI_HORIZONS],
      quantiles: [...SCALPING_AI_QUANTILES],
      seed: 0,
      series,
      cost_assumptions: {
        commission_bps_per_side: request.evaluation.commissionBpsPerSide,
        tax_bps_on_exit: request.evaluation.taxBpsOnExit,
        spread_bps_round_trip: request.evaluation.spreadBpsRoundTrip,
        slippage_bps_per_side: request.evaluation.slippageBpsPerSide,
      },
    }, ownerSubject, request.marketCountry);
    return {
      ...queued,
      ...(excluded.length ? { excluded } : {}),
      retrospective: true,
      walkForward: true,
      randomSplit: false,
    };
  }

  private forecastSchema(
    input: ScalpingForecastRequest,
  ): ScalpingForecastRequest & { marketCountry: MarketCountry } {
    const parsed = z.object({
      marketCountry: MarketCountrySchema.default("KR"),
      symbols: z.array(z.string()),
      interval: MinuteIntervalSchema,
    }).strict().parse(input);
    return {
      marketCountry: parsed.marketCountry,
      symbols: normalizedSymbols(parsed.symbols, this.config.maximumTopCount),
      interval: parsed.interval,
    };
  }

  private evaluationSchema(
    input: ScalpingEvaluationRequest,
  ): ScalpingEvaluationRequest & { marketCountry: MarketCountry; preset: WorkspacePreset } {
    const parsed = z.object({
      marketCountry: MarketCountrySchema.default("KR"),
      symbols: z.array(z.string()),
      interval: MinuteIntervalSchema,
      preset: WorkspacePresetSchema.default("risk_management"),
      evaluation: z.object({
        walkForward: z.literal(true), retrospective: z.literal(true),
        commissionBpsPerSide: z.number().finite().min(0).max(1_000),
        taxBpsOnExit: z.number().finite().min(0).max(1_000),
        spreadBpsRoundTrip: z.number().finite().min(0).max(5_000),
        slippageBpsPerSide: z.number().finite().min(0).max(5_000),
      }).strict(),
    }).strict().parse(input);
    return { ...parsed, symbols: normalizedSymbols(parsed.symbols, this.config.maximumTopCount) };
  }

  private async collectRankings(
    criterion: ScannerCriterion,
    count: number,
    marketCountry: MarketCountry,
  ): Promise<{
    rankings: NormalizedRanking[];
    errors: Partial<Record<"toss" | "kis", string>>;
    diagnostics: string[];
  }> {
    const errors: Partial<Record<"toss" | "kis", string>> = {};
    const diagnostics: string[] = [];
    const tossCriteria: Array<"trading_amount" | "volume" | "change_rate"> = criterion === "volatility"
      ? ["trading_amount", "volume", "change_rate"] : [criterion];
    const tossSettled = await Promise.allSettled(
      tossCriteria.map((value) => this.toss.getRankings(value, count, marketCountry)),
    );
    const rankings: NormalizedRanking[] = [];
    let tossRankingCount = 0;
    tossSettled.forEach((result, index) => {
      if (result.status === "fulfilled") rankings.push(...result.value);
      else diagnostics.push(`toss_${tossCriteria[index]}_ranking_unavailable`);
      if (result.status === "fulfilled") tossRankingCount += result.value.length;
    });
    if (diagnostics.some((code) => code.startsWith("toss_"))) {
      errors.toss = tossRankingCount > 0 ? "toss_ranking_partial" : "toss_ranking_unavailable";
    }
    if (marketCountry === "US") {
      const exchanges: readonly KisUsExchangeCode[] = ["NAS", "NYS", "AMS"];
      const overseasRequests = exchanges.flatMap((exchange) => [
        ...(criterion === "volume" || criterion === "volatility"
          ? [{ code: `kis_${exchange.toLowerCase()}_volume_ranking`, task: this.kis.getOverseasVolumeRanking({ exchange }) }] : []),
        ...(criterion === "trading_amount" || criterion === "volatility"
          ? [{ code: `kis_${exchange.toLowerCase()}_trading_amount_ranking`, task: this.kis.getOverseasTradingAmountRanking({ exchange }) }] : []),
      ]);
      const overseasSettled = await Promise.allSettled(overseasRequests.map(({ task }) => task));
      const kisRankings: NormalizedRanking[] = [];
      overseasSettled.forEach((result, index) => {
        const code = overseasRequests[index]!.code;
        if (result.status === "fulfilled") {
          try {
            kisRankings.push(...adaptKisOverseasRankings(result.value).items);
            if (result.value.quality !== "available") diagnostics.push(`${code}_${result.value.quality}`);
          } catch {
            diagnostics.push(`${code}_invalid_response`);
          }
        } else {
          diagnostics.push(`${code}_unavailable`);
        }
      });
      const globallyRanked = rerankUsKisRankings(kisRankings, criterion);
      rankings.push(...globallyRanked);
      const kisRankingCount = globallyRanked.length;
      if (diagnostics.some((code) => code.startsWith("kis_"))) {
        errors.kis = kisRankingCount > 0 ? "kis_ranking_partial" : "kis_ranking_unavailable";
      }
      return { rankings, errors, diagnostics };
    }
    // KIS rejects the integrated `UN` code for ranking (OPSQ2001). KRX and NXT
    // expose disjoint venue accumulations, so fetch both and sum duplicate-symbol
    // volume/amount exactly once per venue before cross-venue reranking.
    const domesticRequests = ([
      { venue: "KRX" as const, code: "kis_krx_volume_ranking", task: this.kis.getVolumeRanking({ basisCode: "0", market: "J" }) },
      { venue: "NXT" as const, code: "kis_nxt_volume_ranking", task: this.kis.getVolumeRanking({ basisCode: "0", market: "NX" }) },
      ...(criterion === "volatility" ? [
        { venue: "KRX" as const, code: "kis_krx_fluctuation_ranking", task: this.kis.getFluctuationRanking({ sortCode: "0", market: "J" }) },
      ] : []),
    ]);
    const domesticSettled = await Promise.allSettled(domesticRequests.map(({ task }) => task));
    const kisRankings: DomesticKisRanking[] = [];
    domesticSettled.forEach((result, index) => {
      const request = domesticRequests[index]!;
      if (result.status === "rejected") {
        diagnostics.push(`${request.code}_unavailable`);
        return;
      }
      try {
        const adapted = request.code.includes("fluctuation")
          ? adaptKisFluctuationRankings(result.value as Awaited<ReturnType<KisMarket["getFluctuationRanking"]>>)
          : adaptKisVolumeRankings(result.value as Awaited<ReturnType<KisMarket["getVolumeRanking"]>>);
        kisRankings.push(...adapted.items.map((ranking) => ({ venue: request.venue, ranking })));
        if (result.value.quality !== "available") diagnostics.push(`${request.code}_${result.value.quality}`);
      } catch {
        diagnostics.push(`${request.code}_invalid_response`);
      }
    });
    const globallyRanked = rerankDomesticKisRankings(kisRankings, criterion);
    rankings.push(...globallyRanked);
    if (diagnostics.some((code) => code.startsWith("kis_"))) {
      errors.kis = globallyRanked.length > 0 ? "kis_ranking_partial" : "kis_ranking_unavailable";
    }
    return { rankings, errors, diagnostics };
  }

  private universe(
    rankings: readonly NormalizedRanking[],
    requested: readonly string[],
    desiredCount: number,
    criterion: ScannerCriterion,
  ): string[] {
    const ranked = [...rankings].sort((left, right) => left.rank - right.rank || left.symbol.localeCompare(right.symbol));
    // Keep filter headroom without fetching minute bars and quote enrichment for
    // an unrelated full provider ranking page on every smaller workspace request.
    const multiplier = criterion === "volatility" ? 4 : 2;
    const minimumPool = criterion === "volatility" ? 20 : 10;
    const rankedLimit = Math.min(
      this.config.maximumTopCount,
      Math.max(minimumPool, desiredCount * multiplier),
    );
    const universeLimit = Math.min(
      this.config.maximumTopCount,
      Math.max(requested.length, rankedLimit),
    );
    return Array.from(new Set([...requested, ...ranked.map(({ symbol }) => symbol)]))
      .slice(0, universeLimit);
  }

  private async enrich(symbols: readonly string[], marketCountry: MarketCountry) {
    const books = new Map<string, NormalizedOrderbook>();
    const warnings: NormalizedWarning[] = [];
    const trades = new Map<string, NormalizedTrade[]>();
    const warningUnavailable = new Set<string>();
    const errors: string[] = [];
    await Promise.all(symbols.map(async (symbol) => {
      const liveBook = this.liveSnapshot(symbol, marketCountry).orderbook;
      const orderbookRequest = liveBook
        ? Promise.resolve(liveBook)
        : marketCountry === "US"
          ? Promise.reject(new Error("KIS US real-time top-of-book is unavailable for the current session."))
          : this.toss.getOrderbook(symbol);
      const [book, warning, trade] = await Promise.allSettled([
        orderbookRequest,
        this.toss.getWarnings(symbol),
        this.toss.getTrades(symbol, this.config.tradeFetchCount),
      ]);
      if (book.status === "fulfilled") books.set(symbol, book.value);
      else errors.push(`${marketCountry === "US" ? "kis_us_orderbook_unavailable" : "toss_orderbook_unavailable"}:${symbol}`);
      if (warning.status === "fulfilled") warnings.push(...warning.value);
      else {
        warningUnavailable.add(symbol);
        errors.push(`toss_warning_status_unavailable:${symbol}`);
      }
      if (trade.status === "fulfilled") trades.set(symbol, trade.value);
      else errors.push(`toss_trades_unavailable:${symbol}`);
    }));
    return { books, warnings, trades, warningUnavailable, errors };
  }

  private async loadBars(
    symbols: readonly string[],
    interval: ScalpingInterval,
    marketCountry: MarketCountry = "KR",
    options: BarLoadOptions = {},
  ): Promise<Map<string, IntradayBarRecord[]>> {
    return (await this.loadBarsWithDiagnostics(symbols, interval, marketCountry, options)).barsBySymbol;
  }

  private historyBarLimit(marketCountry: MarketCountry, maximumBars?: number): number {
    const configured = marketCountry === "US" ? this.config.usWorkspaceBarLimit : this.config.workspaceBarLimit;
    return maximumBars === undefined ? configured : Math.max(1, Math.min(configured, maximumBars));
  }

  private forecastHistoryBarLimit(marketCountry: MarketCountry): number {
    if (marketCountry === "US") return this.config.forecastMaximumBars;
    const sessionEvidenceBars = configuredKrSessionWindows(this.config)
      .reduce((sum, window) => sum + Math.max(0, window.closeMinute - window.openMinute), 0);
    return Math.max(this.config.forecastMaximumBars, sessionEvidenceBars);
  }

  private async loadBarsWithDiagnostics(
    symbols: readonly string[],
    interval: ScalpingInterval,
    marketCountry: MarketCountry = "KR",
    options: BarLoadOptions = {},
  ): Promise<{ barsBySymbol: Map<string, IntradayBarRecord[]>; errors: string[] }> {
    const barsBySymbol = new Map<string, IntradayBarRecord[]>();
    const errors: string[] = [];
    await Promise.all(symbols.map(async (symbol) => {
      try {
        const loaded = await this.loadBarsForSymbol(symbol, interval, marketCountry, options);
        barsBySymbol.set(symbol, loaded.bars);
        errors.push(...loaded.errors);
      } catch {
        barsBySymbol.set(symbol, []);
        errors.push(`intraday_bar_store_unavailable:${symbol}`);
      }
    }));
    return { barsBySymbol, errors: Array.from(new Set(errors)).sort() };
  }

  private async loadBarsForSymbol(
    symbol: string,
    interval: ScalpingInterval,
    marketCountry: MarketCountry,
    options: BarLoadOptions = {},
  ): Promise<{ bars: IntradayBarRecord[]; errors: string[] }> {
    const errors: string[] = [];
    const historyBarLimit = this.historyBarLimit(marketCountry, options.maximumBars);
    const queryLimit = options.maximumBars === undefined
      ? historyBarLimit
      : Math.min(50_000, historyBarLimit + Math.min(32, historyBarLimit));
    const sessionWindows = marketSessionWindows(
      marketCountry,
      configuredKrSessionWindows(this.config),
    );
    let oneMinute = await this.repository.listBars({
      marketCountry, symbol, intervalMinutes: 1, includeForming: true, limit: queryLimit,
    });
    const latestFinal = [...oneMinute].reverse().find((bar) => (
      bar.state === "final" && bar.quality !== "partial" && bar.quality !== "stale"
    ));
    if (options.forceLatestRefresh
      || (!options.skipAutomaticRefresh && (
        !latestFinal
        || this.now() - Date.parse(latestFinal.closeTime) > this.config.barRefreshAfterMs
      ))) {
      const history = await this.fetchMinuteHistoryWithDiagnostics(
        symbol,
        oneMinute,
        marketCountry,
        historyBarLimit,
        options.forceLatestRefresh === true,
      );
      errors.push(...history.errors);
      if (history.bars.length) {
        const sessions = groupBarsBySession(history.bars);
        const aggregated = [
          ...history.bars,
          ...([5, 15, 30, 60] as const).flatMap((minutes) => [...sessions.entries()].flatMap(
            ([sessionDate, sessionBars]) => aggregateRecoveredBars(sessionBars, minutes, {
              sessionStartAt: marketSessionAnchor(sessionDate, marketCountry),
              sessionWindows,
            }).map((bar) => ({
              ...bar,
              source: "toss_rest" as const,
              quality: bar.quality === "recovered" ? "complete" as const : bar.quality,
            })),
          )),
        ];
        await this.repository.putBars(aggregated);
        oneMinute = await this.repository.listBars({
          marketCountry, symbol, intervalMinutes: 1, includeForming: true, limit: queryLimit,
        });
      }
    }
    const configuredOneMinute = oneMinute.filter((bar) => (
      isCanonicalOneMinuteRecord(bar, marketCountry, sessionWindows)
    ));
    if (interval === 1) return { bars: configuredOneMinute, errors };
    const canonicalOneMinute = configuredOneMinute;
    const sessions = groupBarsBySession(canonicalOneMinute);
    const canonical = [...sessions.entries()].flatMap(([sessionDate, sessionBars]) => (
      aggregateRecoveredBars(sessionBars, interval, {
        sessionStartAt: marketSessionAnchor(sessionDate, marketCountry),
        sessionWindows,
      })
    )).sort((left, right) => left.openTime.localeCompare(right.openTime))
      .slice(-historyBarLimit);
    if (canonical.length) await this.repository.putBars(canonical);
    const stored = await this.repository.listBars({
      marketCountry, symbol, intervalMinutes: interval, includeForming: true, limit: historyBarLimit,
    });
    const canonicalStored = stored.filter((bar) => {
      const window = sessionWindowForTrade(bar.openTime, marketCountry, sessionWindows, bar.sessionDate);
      const scheduled = scheduledSessionIntervalClose(
        bar.openTime,
        bar.sessionDate,
        interval,
        marketCountry,
        sessionWindows,
      );
      if (!window || !scheduled || bar.closeTime !== scheduled.closeTime) return false;
      const openMinute = marketSessionEffectiveMinute(bar.openTime, bar.sessionDate, marketCountry);
      const windowOpen = (window.localDateOffset ?? 0) * 24 * 60 + window.openMinute;
      if (openMinute === undefined || (openMinute - windowOpen) % interval !== 0) return false;
      const closeWindow = sessionWindowForBarClose(bar.closeTime, marketCountry, sessionWindows, bar.sessionDate);
      return closeWindow === window
        && (!scheduled.truncated || bar.quality === "partial");
    });
    const merged = new Map(canonicalStored.map((bar) => [bar.openTime, bar]));
    for (const bar of canonical) merged.set(bar.openTime, bar);
    return {
      bars: [...merged.values()]
        .sort((left, right) => left.openTime.localeCompare(right.openTime))
        .slice(-historyBarLimit),
      errors,
    };
  }

  private async fetchMinuteHistory(
    symbol: string,
    existing: readonly IntradayBarRecord[],
    marketCountry: MarketCountry = "KR",
    maximumBars?: number,
  ): Promise<IntradayBarRecord[]> {
    return (await this.fetchMinuteHistoryWithDiagnostics(
      symbol,
      existing,
      marketCountry,
      maximumBars,
    )).bars;
  }

  private minuteCoverageIsSufficient(
    bars: readonly IntradayBarRecord[],
    marketCountry: MarketCountry,
    maximumBars?: number,
  ): boolean {
    // Before the raw window reaches the target it cannot possibly contain the
    // required number of canonical one-minute bars. Avoid repeatedly sorting
    // and timezone-normalizing the growing history after every provider page.
    const historyBarLimit = this.historyBarLimit(marketCountry, maximumBars);
    if (bars.length < historyBarLimit) return false;
    const sessionWindows = marketSessionWindows(
      marketCountry,
      configuredKrSessionWindows(this.config),
    );
    const canonical = [...new Map(bars.flatMap((bar) => {
      if (bar.intervalMinutes !== 1) return [];
      return isCanonicalOneMinuteRecord(bar, marketCountry, sessionWindows)
        ? [[bar.openTime, bar] as const]
        : [];
    })).values()].sort((left, right) => left.openTime.localeCompare(right.openTime));
    if (canonical.length < historyBarLimit) return false;
    const sessions = groupBarsBySession(canonical);
    for (const sessionBars of sessions.values()) {
      for (let index = 1; index < sessionBars.length; index += 1) {
        const previous = sessionBars[index - 1]!;
        const current = sessionBars[index]!;
        const previousWindow = sessionWindowForTrade(previous.openTime, marketCountry, sessionWindows, previous.sessionDate);
        const currentWindow = sessionWindowForTrade(current.openTime, marketCountry, sessionWindows, current.sessionDate);
        if (previousWindow !== undefined && previousWindow === currentWindow
          && Date.parse(current.openTime) - Date.parse(previous.openTime) !== MINUTE_MS) return false;
      }
    }
    return true;
  }

  private async fetchMinuteHistoryWithDiagnostics(
    symbol: string,
    existing: readonly IntradayBarRecord[],
    marketCountry: MarketCountry = "KR",
    maximumBars?: number,
    bypassLatestCache = false,
  ): Promise<{ bars: IntradayBarRecord[]; errors: string[] }> {
    const historyBarLimit = this.historyBarLimit(marketCountry, maximumBars);
    const sessionWindows = marketSessionWindows(
      marketCountry,
      configuredKrSessionWindows(this.config),
    );
    // A full workspace already contains the long history needed by indicators.
    // Its ordinary stale refresh only needs the provider's configured newest
    // page: revisiting every old page makes permanent zero-trade minutes look
    // like repairable holes on every request. Cold/partial workspaces retain the
    // exhaustive cursor walk below so their initial backfill and gap repair are
    // unchanged. The amount refreshed here is controlled by candlePageSize.
    const isSeededWorkspace = existing.length >= historyBarLimit;
    const known = new Map(existing.map((bar) => [bar.openTime, bar]));
    const fetched = new Map<string, IntradayBarRecord>();
    const seenProviderTimestamps = new Set<number>();
    const errors: string[] = [];
    let before: string | undefined;
    const pageSize = Math.min(this.config.candlePageSize, historyBarLimit);
    while (fetched.size < historyBarLimit) {
      const page = await this.safe(
        () => bypassLatestCache && before === undefined
          ? this.toss.getMinuteCandles(
              symbol,
              pageSize,
              before,
              marketCountry,
              { bypassCache: true },
            )
          : this.toss.getMinuteCandles(symbol, pageSize, before, marketCountry),
        `toss_candles_unavailable:${symbol}`,
      );
      if (page.error) errors.push(page.error);
      if (!page.value?.length) break;
      let providerTimestampsAdded = 0;
      for (const candle of page.value) {
        const providerTimestamp = Date.parse(candle.timestamp);
        if (!Number.isFinite(providerTimestamp)) continue;
        if (!seenProviderTimestamps.has(providerTimestamp)) providerTimestampsAdded += 1;
        seenProviderTimestamps.add(providerTimestamp);
        const normalized = storeRecord(candle, this.now(), marketCountry);
        if (!isCanonicalOneMinuteRecord(normalized, marketCountry, sessionWindows)) continue;
        known.set(normalized.openTime, normalized);
        fetched.set(normalized.openTime, normalized);
      }
      const oldest = page.value[0]?.timestamp;
      if (!oldest || providerTimestampsAdded === 0) break;
      before = new Date(Date.parse(oldest) - 1).toISOString();
      if (isSeededWorkspace) break;
      if (this.minuteCoverageIsSufficient([...known.values()], marketCountry, historyBarLimit)) break;
      if (fetched.size >= historyBarLimit) break;
    }
    return {
      bars: [...fetched.values()]
        .sort((left, right) => left.openTime.localeCompare(right.openTime))
        .slice(-historyBarLimit),
      errors,
    };
  }

  private async computeAnalysis(input: {
    symbols: readonly string[];
    interval: ScalpingInterval;
    preset: WorkspacePreset;
    barsBySymbol: ReadonlyMap<string, IntradayBarRecord[]>;
    metadata: ReadonlyMap<string, InstrumentInfo>;
    holdings: ReadonlyMap<string, AnalysisPosition>;
    books: ReadonlyMap<string, NormalizedOrderbook>;
    trades: ReadonlyMap<string, NormalizedTrade[]>;
    marketCountry: MarketCountry;
    responseMode: "full_series" | "latest_summary";
    includeVolumeProfile: boolean;
    signalSnapshotTimestamps?: ReadonlyMap<string, readonly string[]>;
  }): Promise<unknown> {
    if (!this.rust) return undefined;
    const prepared = input.symbols.map((symbol) => ({
      symbol,
      session: this.instrumentSessionBars(input.barsBySymbol.get(symbol) ?? [], input.marketCountry),
    }));
    const usCalendarByDate = new Map<string, ConfirmedUsSessionSchedule | undefined>();
    if (input.marketCountry === "US") {
      const dates = Array.from(new Set(prepared.flatMap(({ session }) => {
        return session.bars.map(({ sessionDate }) => sessionDate);
      })));
      await Promise.all(dates.map(async (sessionDate) => {
        const calendar = await this.safe(
          () => this.toss.getMarketCalendar("US", sessionDate),
          "toss_market_calendar",
        );
        usCalendarByDate.set(
          sessionDate,
          confirmedUsSessionSchedule(calendar.value, sessionDate),
        );
      }));
    }
    const unavailableTechnical: UnknownRecord[] = [];
    const instruments = prepared.flatMap(({ symbol, session }) => {
      let bars = session.bars;
      let sessionWindows = session.windows;
      let sessionWindowsByDate = new Map<string, readonly MarketSessionWindow[]>();
      if (input.marketCountry === "US" && bars.length) {
        const latestSessionDate = bars.at(-1)!.sessionDate;
        const confirmedSession = usCalendarByDate.get(latestSessionDate);
        if (!confirmedSession) {
          unavailableTechnical.push({
            instrument_key: symbol,
            symbol,
            status: "unavailable",
            reason: "us_market_calendar_unavailable_or_invalid",
            availability: {
              status: "unavailable",
              reason: "confirmed_us_session_schedule_required",
            },
          });
          return [];
        }
        sessionWindows = confirmedSession.windows;
        sessionWindowsByDate = new Map([...usCalendarByDate].flatMap(([date, schedule]) => (
          schedule ? [[date, schedule.windows] as const] : []
        )));
        bars = bars.filter((bar) => {
          const confirmedWindows = sessionWindowsByDate.get(bar.sessionDate);
          return confirmedWindows !== undefined && sessionWindowForBarClose(
            bar.closeTime,
            "US",
            confirmedWindows,
            bar.sessionDate,
          ) !== undefined;
        });
      }
      if (bars.length < this.config.minimumAnalysisBars) return [];
      const last = bars.at(-1)!;
      const item = input.metadata.get(symbol);
      const book = input.books.get(symbol);
      const trades = input.trades.get(symbol) ?? [];
      const buyVolume = trades.filter(({ side }) => side === "buy").reduce((sum, trade) => sum + trade.quantity, 0);
      const sellVolume = trades.filter(({ side }) => side === "sell").reduce((sum, trade) => sum + trade.quantity, 0);
      const holding = input.holdings.get(symbol);
      const quoteWindows = sessionWindowsByDate.get(last.sessionDate) ?? sessionWindows;
      const quoteInsideSelectedSession = !book || sessionWindowForTrade(
        book.observedAt,
        input.marketCountry,
        quoteWindows,
        last.sessionDate,
      ) !== undefined;
      const nextQuote = book && quoteInsideSelectedSession
        && Date.parse(book.observedAt) > Date.parse(last.closeTime)
        ? book.observedAt
        : undefined;
      const confirmed = this.confirmedSessionDates(
        bars,
        input.interval,
        input.marketCountry,
        sessionWindows,
        sessionWindowsByDate,
      );
      return [{
        key: symbol,
        symbol,
        market: item?.market ?? input.marketCountry,
        currency: item?.currency ?? (input.marketCountry === "US" ? "USD" : "KRW"),
        instrument_type: instrumentType(item),
        bars: bars.map((bar) => ({
          timestamp: marketLocalTimestamp(bar.closeTime, input.marketCountry),
          session_date: bar.sessionDate,
          open: bar.open,
          high: bar.high,
          low: bar.low,
          close: bar.close,
          ...(bar.volume === undefined ? {} : { volume: bar.volume }),
          ...(bar.turnover === undefined ? {} : { amount: bar.turnover }),
          complete: true,
        })),
        session_start_confirmed_dates: confirmed.started,
        complete_session_dates: confirmed.complete,
        session_windows: sessionWindows.map((window) => ({
          kind: window.kind,
          open_minute: window.openMinute,
          close_minute: window.closeMinute,
          local_date_offset: window.localDateOffset ?? 0,
        })),
        session_window_overrides: [...sessionWindowsByDate].map(([session_date, windows]) => ({
          session_date,
          windows: windows.map((window) => ({
            kind: window.kind,
            open_minute: window.openMinute,
            close_minute: window.closeMinute,
            local_date_offset: window.localDateOffset ?? 0,
          })),
        })),
        anchored_vwap_timestamp: marketLocalTimestamp(
          bars.find((bar) => bar.sessionDate === last.sessionDate)?.closeTime ?? last.closeTime,
          input.marketCountry,
        ),
        ...(nextQuote ? { next_valid_quote_timestamp: nextQuote } : {}),
        ...(book ? {
          orderbook: {
            timestamp: book.observedAt,
            bid_volume: book.totalBidQuantity ?? book.bids.reduce((sum, level) => sum + level.quantity, 0),
            ask_volume: book.totalAskQuantity ?? book.asks.reduce((sum, level) => sum + level.quantity, 0),
            best_bid: book.bids[0]?.price,
            best_ask: book.asks[0]?.price,
          },
        } : {}),
        ...(trades.length ? {
          trade_stats: {
            timestamp: trades.at(-1)!.executedAt,
            buy_volume: buyVolume,
            sell_volume: sellVolume,
          },
        } : {}),
        ...(holding && Date.parse(holding.asOf) <= Date.parse(nextQuote ?? last.closeTime) ? {
          position: { as_of_timestamp: holding.asOf, quantity: holding.quantity, average_price: holding.averagePrice },
        } : {}),
      }];
    });
    if (!instruments.length) {
      return unavailableTechnical.length ? { instruments: unavailableTechnical } : undefined;
    }
    const profileKeys = input.includeVolumeProfile
      ? instruments.slice(0, this.config.volumeProfileInstrumentLimit).map(({ key }) => key)
      : [];
    const output = await this.rust.compute<unknown>("scalping_analysis", {
      scalping_analysis: {
        schema_version: "scalping-analysis-request/v3",
        response_mode: input.responseMode,
        adjustment_policy: "unadjusted",
        interval_minutes: input.interval,
        instruments,
        indicators: presetIndicators(input.preset),
        relative_volume_lookback_sessions: this.config.relativeVolumeLookbackSessions,
        ...(profileKeys.length ? {
          volume_profile: {
            instrument_keys: profileKeys,
            bucket_count: this.config.volumeProfileBucketCount,
            value_area_percent: 70,
            price_source: "typical_price",
          },
        } : {}),
        signal: { enabled: true, preset: input.preset },
        output_projection: {
          series_tail_points: 180,
          signal_snapshots: [...(input.signalSnapshotTimestamps ?? new Map())]
            .filter(([, timestamps]) => timestamps.length > 0)
            .map(([instrument_key, timestamps]) => ({
              instrument_key,
              timestamps: [...timestamps],
            })),
        },
      },
    }, { includeArtifacts: false });
    if (!unavailableTechnical.length) return output.result;
    const result = record(output.result);
    const resultInstruments = Array.isArray(result?.instruments) ? result.instruments : [];
    return {
      ...(result ?? {}),
      instruments: [...resultInstruments, ...unavailableTechnical],
    };
  }

  private withRequestedCandidates(
    scan: ScannerResult,
    requested: readonly string[],
    visibleCount: number,
    prices: ReadonlyMap<string, NormalizedPrice>,
    marketCountry: MarketCountry,
    metadata: ReadonlyMap<string, InstrumentInfo>,
  ): ScannerCandidate[] {
    const scanned = new Map(
      [...scan.candidates, ...scan.excluded].map((candidate) => [candidate.symbol, candidate]),
    );
    const output: ScannerCandidate[] = [];
    for (const symbol of requested) {
      const existing = scanned.get(symbol);
      if (existing) {
        output.push(existing);
        continue;
      }
      const price = prices.get(symbol);
      const exchange = marketCountry === "US" ? normalizeUsExchange(metadata.get(symbol)?.market) : undefined;
      output.push({
        symbol,
        ...(exchange ? { exchange } : {}),
        currency: price?.currency ?? (marketCountry === "US" ? "USD" : "KRW"),
        ...(price?.price === undefined ? {} : { price: price.price }),
        ...(price?.volume === undefined ? {} : { volume: price.volume }),
        ...(price?.tradingAmount === undefined ? {} : { tradingAmount: price.tradingAmount }),
        providerRanks: {}, warnings: [], filtered: false, filterReasons: [],
        quality: quality(price ? "partial" : "source_unavailable", ["user_requested_symbol_not_in_ranking"], price ? [price.provider] : ["derived"]),
      });
    }
    for (const candidate of scan.candidates) {
      if (output.some(({ symbol }) => symbol === candidate.symbol)) continue;
      output.push(candidate);
      if (output.length >= visibleCount) break;
    }
    return output.slice(0, visibleCount);
  }

  private async instrumentMetadata(symbols: readonly string[]): Promise<Map<string, InstrumentInfo>> {
    if (!this.portfolio) return new Map();
    const result = await this.safe(() => this.portfolio!.getInstruments([...symbols]), "toss_instruments");
    return new Map((result.value ?? []).map((item) => [item.symbol, item]));
  }

  private aiBar(bar: IntradayBarRecord): AiPriceBar {
    return {
      timestamp: bar.closeTime,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      ...(bar.volume === undefined ? {} : { volume: bar.volume }),
      amount: bar.turnover ?? null,
      complete: true,
    };
  }

  private configuredSessionBars(
    bars: readonly IntradayBarRecord[],
    marketCountry: MarketCountry = "KR",
    sessionWindows: readonly MarketSessionWindow[] = marketSessionWindows(
      marketCountry,
      configuredKrSessionWindows(this.config),
    ),
  ): IntradayBarRecord[] {
    return bars.filter((bar) => {
      if (bar.state !== "final") return false;
      if (bar.quality === "partial" || bar.quality === "stale") return false;
      return sessionWindowForBarClose(bar.closeTime, marketCountry, sessionWindows, bar.sessionDate) !== undefined;
    });
  }

  private evidenceBasedSessionWindows(
    bars: readonly IntradayBarRecord[],
    marketCountry: MarketCountry,
  ): readonly MarketSessionWindow[] {
    const configured = marketSessionWindows(marketCountry, configuredKrSessionWindows(this.config));
    if (marketCountry === "US") return configured;
    const latest = [...bars].sort((left, right) => left.closeTime.localeCompare(right.closeTime)).at(-1);
    const latestSessionBars = latest ? bars.filter((bar) => bar.sessionDate === latest.sessionDate) : [];
    const observedKinds = new Set(latestSessionBars.flatMap((bar) => {
      const window = sessionWindowForBarClose(bar.closeTime, marketCountry, configured, bar.sessionDate);
      return window ? [window.kind] : [];
    }));
    if (observedKinds.has("pre_market")) return configured;
    if (observedKinds.has("after_market")) {
      return configured.filter(({ kind }) => kind === "regular_market" || kind === "after_market");
    }
    return configured.filter(({ kind }) => kind === "regular_market");
  }

  private instrumentSessionBars(
    bars: readonly IntradayBarRecord[],
    marketCountry: MarketCountry,
  ): { bars: IntradayBarRecord[]; windows: readonly MarketSessionWindow[] } {
    const candidates = this.configuredSessionBars(bars, marketCountry);
    const windows = this.evidenceBasedSessionWindows(candidates, marketCountry);
    return {
      bars: this.configuredSessionBars(candidates, marketCountry, windows),
      windows,
    };
  }

  private confirmedSessionDates(
    bars: readonly IntradayBarRecord[],
    interval: ScalpingInterval,
    marketCountry: MarketCountry = "KR",
    sessionWindows?: readonly MarketSessionWindow[],
    sessionWindowsByDate: ReadonlyMap<string, readonly MarketSessionWindow[]> = new Map(),
  ): { started: string[]; complete: string[] } {
    const fallbackWindows = sessionWindows ?? this.evidenceBasedSessionWindows(bars, marketCountry);
    if (!fallbackWindows.length) return { started: [], complete: [] };
    const sessions = groupBarsBySession(bars);
    const started: string[] = [];
    const complete: string[] = [];
    for (const [date, sessionBars] of sessions) {
      const windows = sessionWindowsByDate.get(date) ?? fallbackWindows;
      const firstWindow = windows[0];
      if (!firstWindow) continue;
      const sorted = [...sessionBars].sort((left, right) => left.closeTime.localeCompare(right.closeTime));
      const first = marketSessionEffectiveMinute(sorted[0]!.closeTime, date, marketCountry);
      const firstExpected = (firstWindow.localDateOffset ?? 0) * 24 * 60 + firstWindow.openMinute + interval;
      if (first !== firstExpected) continue;
      started.push(date);
      const expectedMinutes = windows.flatMap((window) => {
        const output: number[] = [];
        const offset = (window.localDateOffset ?? 0) * 24 * 60;
        for (let minute = window.openMinute + interval; minute <= window.closeMinute; minute += interval) {
          output.push(offset + minute);
        }
        return output;
      });
      const hasPartialTail = windows.some((window) => (window.closeMinute - window.openMinute) % interval !== 0);
      if (!hasPartialTail && sorted.length === expectedMinutes.length
        && sorted.every((bar, index) => (
          marketSessionEffectiveMinute(bar.closeTime, date, marketCountry) === expectedMinutes[index]
        ))) {
        complete.push(date);
      }
    }
    return { started, complete };
  }

  private async liveFutureTimestamps(
    last: IntradayBarRecord,
    marketCountry: MarketCountry = "KR",
    confirmedUsSchedule?: ConfirmedUsSessionSchedule,
    sessionWindows?: readonly MarketSessionWindow[],
    loadMarketCalendar?: (sessionDate: string) => Promise<TossMarketCalendarDay | undefined>,
    notBefore: number = this.now(),
  ): Promise<FutureTimestampResult> {
    const scheduleUnavailable = (): FutureTimestampResult => ({
      status: "unavailable",
      code: "future_market_schedule_unavailable",
    });
    const staleFinalBar = (): FutureTimestampResult => ({
      status: "unavailable",
      code: "stale_final_bar",
    });
    if (marketCountry === "US") {
      if (!confirmedUsSchedule || !loadMarketCalendar) return scheduleUnavailable();
      if (!sessionWindowForBarClose(
        last.closeTime,
        "US",
        confirmedUsSchedule.windows,
        last.sessionDate,
      )) return scheduleUnavailable();
      const output: string[] = [];
      const appendSchedule = (schedule: ConfirmedUsSessionSchedule, after: number) => {
        for (const period of schedule.periods) {
          const start = Date.parse(period.startAt);
          const end = Date.parse(period.endAt);
          for (let timestamp = Math.max(start + MINUTE_MS, after + MINUTE_MS);
            timestamp <= end && output.length < 60;
            timestamp += MINUTE_MS) {
            output.push(new Date(timestamp).toISOString());
          }
          if (output.length >= 60) break;
        }
      };
      const inputEnd = Date.parse(last.closeTime);
      if (!Number.isFinite(inputEnd)) return scheduleUnavailable();
      appendSchedule(confirmedUsSchedule, inputEnd);
      for (let days = 1; output.length < 60 && days <= MARKET_CALENDAR_LOOKAHEAD_DAYS; days += 1) {
        const sessionDate = calendarDateAfter(last.sessionDate, days);
        if (!sessionDate) return scheduleUnavailable();
        const confirmed = confirmedUsCalendarSession(await loadMarketCalendar(sessionDate), sessionDate);
        if (!confirmed) return scheduleUnavailable();
        if (confirmed.status === "closed") continue;
        appendSchedule(confirmed.schedule, inputEnd);
      }
      if (output.length !== 60) return scheduleUnavailable();
      if (Date.parse(output[0]!) <= notBefore) return staleFinalBar();
      return {
        status: "available",
        timestamps: output as AiForecastRequest["series"][number]["future_timestamps"],
      };
    }
    const windows = sessionWindows ?? this.evidenceBasedSessionWindows([last], marketCountry);
    const local = marketMinute(last.closeTime, marketCountry);
    const currentWindowIndex = windows.findIndex((window) => (
      local.minute > window.openMinute && local.minute <= window.closeMinute
    ));
    if (local.date !== last.sessionDate || currentWindowIndex < 0) return scheduleUnavailable();
    const output: string[] = [];
    let windowIndex = currentWindowIndex;
    let minute = local.minute;
    while (output.length < 60 && windowIndex < windows.length) {
      const window = windows[windowIndex]!;
      if (minute < window.closeMinute) {
        minute += 1;
      } else {
        windowIndex += 1;
        const next = windows[windowIndex];
        if (!next) break;
        minute = next.openMinute + 1;
      }
      const deltaMinutes = minute - local.minute;
      output.push(new Date(Date.parse(last.closeTime) + deltaMinutes * MINUTE_MS).toISOString());
    }
    if (output[0] && Date.parse(output[0]) <= notBefore) return staleFinalBar();
    if (output.length < 60 && !loadMarketCalendar) return scheduleUnavailable();
    for (let days = 1; output.length < 60 && days <= MARKET_CALENDAR_LOOKAHEAD_DAYS; days += 1) {
      const sessionDate = calendarDateAfter(last.sessionDate, days);
      if (!sessionDate) return scheduleUnavailable();
      const confirmed = confirmedKrCalendarSession(await loadMarketCalendar!(sessionDate), sessionDate);
      if (!confirmed) return scheduleUnavailable();
      if (confirmed.status === "closed") continue;
      output.push(...confirmed.minuteCloses.slice(0, 60 - output.length));
    }
    if (output.length !== 60) return scheduleUnavailable();
    if (Date.parse(output[0]!) <= notBefore) return staleFinalBar();
    return {
      status: "available",
      timestamps: output as AiForecastRequest["series"][number]["future_timestamps"],
    };
  }

  private async safe<T>(task: () => Promise<T>, code: string): Promise<{ value?: T; error?: string }> {
    try {
      return { value: await task() };
    } catch {
      return { error: code };
    }
  }

  private liveSnapshot(
    symbol: string,
    marketCountry: MarketCountry,
  ): ReturnType<ScalpingLiveRuntime["snapshot"]> {
    try {
      return this.live.snapshot(symbol, marketCountry);
    } catch {
      return {};
    }
  }
}
