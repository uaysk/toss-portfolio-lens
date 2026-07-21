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
import { aggregateRecoveredBars, type ScalpingLiveRuntime } from "./live-runtime.js";
import type { ScalpingScanner, ScannerResult } from "./scanner-service.js";
import type { TossMarketCalendarDay, TossScalpingProvider } from "./toss-provider.js";
import { marketSessionAnchor, marketTimeZone } from "./market-time.js";

export const SCALPING_WORKSPACE_SCHEMA_VERSION = "scalping-workspace/v1" as const;
export const SCALPING_REALTIME_ANALYSIS_SCHEMA_VERSION = "scalping-realtime-analysis/v1" as const;

const WorkspacePresetSchema = z.enum(["trend", "breakout", "mean_reversion", "risk_management"]);
export type WorkspacePreset = z.infer<typeof WorkspacePresetSchema>;

const SYMBOL = /^[A-Z0-9][A-Z0-9._-]{0,31}$/;
const MINUTE_MS = 60_000;

export type ScalpingServiceConfig = {
  minimumTopCount: number;
  maximumTopCount: number;
  workspaceBarLimit: number;
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
  sessionOpenMinuteKst: number;
  sessionCloseMinuteKst: number;
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
  accountId?: string;
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
};

export type ScalpingEvaluationRequest = ScalpingForecastRequest & {
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

function targetStopsByTimestamp(
  analysis: unknown,
  symbol: string,
): Map<string, z.infer<typeof AiTargetStopSchema>> {
  const output = new Map<string, z.infer<typeof AiTargetStopSchema>>();
  const instruments = record(analysis)?.instruments;
  if (!Array.isArray(instruments)) return output;
  const instrument = instruments.find((value) => record(value)?.instrument_key === symbol);
  const points = record(record(instrument)?.signals)?.points;
  if (!Array.isArray(points)) return output;
  for (const value of points) {
    const point = record(value);
    const timestamp = string(point?.calculation_timestamp);
    const stop = finite(point?.stop_candidate_price);
    const basis = finite(point?.basis_price);
    const targetRange = record(point?.target_price_range);
    const targetLow = finite(targetRange?.low);
    const targetHigh = finite(targetRange?.high);
    if (!timestamp || stop === undefined || basis === undefined || targetLow === undefined || targetHigh === undefined) continue;
    const target = (targetLow + targetHigh) / 2;
    if (stop < basis && basis < target) output.set(timestamp, { side: "long", target_price: target, stop_price: stop });
    else if (target < basis && basis < stop) output.set(timestamp, { side: "short", target_price: target, stop_price: stop });
  }
  return output;
}

function signalByTimestamp(analysis: unknown, symbol: string): Map<string, -1 | 0 | 1> {
  const output = new Map<string, -1 | 0 | 1>();
  const instruments = record(analysis)?.instruments;
  if (!Array.isArray(instruments)) return output;
  const instrument = instruments.find((value) => record(value)?.instrument_key === symbol);
  const points = record(record(instrument)?.signals)?.points;
  if (!Array.isArray(points)) return output;
  for (const value of points) {
    const point = record(value);
    const timestamp = string(point?.calculation_timestamp);
    const status = string(point?.status);
    if (!timestamp) continue;
    output.set(timestamp, status === "entry_candidate" ? 1 : status === "exit_candidate" ? -1 : 0);
  }
  return output;
}

function regimeByTimestamp(analysis: unknown, symbol: string): Map<string, string> {
  const output = new Map<string, string>();
  const instruments = record(analysis)?.instruments;
  if (!Array.isArray(instruments)) return output;
  const instrument = instruments.find((value) => record(value)?.instrument_key === symbol);
  const points = record(record(instrument)?.signals)?.points;
  if (!Array.isArray(points)) return output;
  for (const value of points) {
    const point = record(value);
    const timestamp = string(point?.calculation_timestamp);
    const agreement = string(point?.multi_timeframe_agreement)?.trim();
    if (timestamp && agreement && agreement.length <= 64) output.set(timestamp, agreement);
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

function marketMinute(timestamp: string, marketCountry: MarketCountry): { date: string; minute: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: marketCountry === "US" ? "America/New_York" : "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    minute: Number(values.hour) * 60 + Number(values.minute),
  };
}

function regularSessionMinutes(
  marketCountry: MarketCountry,
  config: Pick<ScalpingServiceConfig, "sessionOpenMinuteKst" | "sessionCloseMinuteKst">,
): { open: number; close: number } {
  return marketCountry === "US"
    ? { open: 9 * 60 + 30, close: 16 * 60 }
    : { open: config.sessionOpenMinuteKst, close: config.sessionCloseMinuteKst };
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
    if (config.workspaceBarLimit < 60 || config.workspaceBarLimit > 2_000) throw new Error("workspaceBarLimit must be in 60..=2000.");
    if (!Number.isInteger(config.candlePageSize) || config.candlePageSize < 1 || config.candlePageSize > config.workspaceBarLimit) {
      throw new Error("candlePageSize is invalid.");
    }
    if (config.minimumAnalysisBars < 1 || config.minimumAnalysisBars > config.workspaceBarLimit) throw new Error("minimumAnalysisBars is invalid.");
    if (config.forecastMinimumBars < 1 || config.forecastMaximumBars < config.forecastMinimumBars) throw new Error("forecast bar limits are invalid.");
    if (config.sessionOpenMinuteKst < 0 || config.sessionCloseMinuteKst > 24 * 60
      || config.sessionOpenMinuteKst >= config.sessionCloseMinuteKst) throw new Error("session minute range is invalid.");
    this.now = config.now ?? Date.now;
    this.workspaceSchema = createScannerRequestSchema(config).extend({
      interval: MinuteIntervalSchema,
      layoutColumns: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
      preset: WorkspacePresetSchema,
      symbols: z.array(z.string()).max(config.maximumTopCount).optional(),
      accountId: z.string().trim().min(1).max(128).optional(),
    }) as z.ZodType<ScalpingWorkspaceRequest>;
  }

  status(enabled = true) {
    return {
      schemaVersion: SCALPING_WORKSPACE_SCHEMA_VERSION,
      enabled,
      limits: {
        topCount: { minimum: this.config.minimumTopCount, maximum: this.config.maximumTopCount },
        intervals: [1, 5, 15, 30, 60],
        layoutColumns: [1, 2, 3, 4],
        workspaceBarLimit: this.config.workspaceBarLimit,
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
      limitations: [
        "과거 호가 이력은 공급자가 제공하지 않아 unavailable입니다.",
        "저유동성 거래대금 필터 단위는 국내 KRW, 미국 USD입니다.",
        "신호는 주문 지시나 수익 보장이 아니며 실제 주문을 실행하지 않습니다.",
      ],
    };
  }

  async workspace(input: ScalpingWorkspaceRequest) {
    const request = this.workspaceSchema.parse(input);
    const marketCountry = request.marketCountry ?? "KR";
    const requestedSymbols = request.symbols ? normalizedSymbols(request.symbols, this.config.maximumTopCount) : [];
    const rankingsResult = await this.collectRankings(request.criterion, request.topCount, marketCountry);
    const universe = this.universe(
      rankingsResult.rankings,
      requestedSymbols,
      request.topCount,
      request.criterion,
    );
    const [pricesResult, instrumentsResult, portfolioResult, barsBySymbol, bookAndWarnings] = await Promise.all([
      this.safe(() => this.toss.getPrices(universe), "toss_prices"),
      this.portfolio
        ? this.safe(() => this.portfolio!.getInstruments(universe), "toss_instruments")
        : Promise.resolve<{ value?: InstrumentInfo[]; error?: string }>({ value: [] }),
      this.portfolio
        ? this.safe(() => this.portfolio!.getPortfolio(request.accountId, false, false), "portfolio")
        : Promise.resolve<{ value?: Portfolio; error?: string }>({}),
      this.loadBars(universe, intervalMinutes(request.interval), marketCountry),
      this.enrich(universe, marketCountry),
    ]);
    const priceBySymbol = new Map((pricesResult.value ?? []).map((value) => [value.symbol, value]));
    const metadata = new Map((instrumentsResult.value ?? []).map((item) => [item.symbol, item]));
    const portfolioValue = portfolioResult.value;
    const holdings = new Map<string, CausalPosition>((portfolioValue?.holdings ?? [])
      .filter((item) => !item.currency || item.currency === (marketCountry === "US" ? "USD" : "KRW"))
      .map((item): [string, CausalPosition] => [
        item.symbol.toUpperCase(),
        { ...item, asOf: portfolioValue!.asOf },
      ]));
    this.latestWorkspaceContext = {
      ...(request.accountId ? { accountId: request.accountId } : {}),
      marketCountry,
      metadata: new Map(metadata),
      holdings: new Map(holdings),
    };
    const analysis = await this.computeAnalysis({
      symbols: universe,
      interval: intervalMinutes(request.interval),
      preset: request.preset,
      barsBySymbol,
      metadata,
      holdings,
      books: bookAndWarnings.books,
      trades: bookAndWarnings.trades,
      marketCountry,
      responseMode: "full_series",
      includeVolumeProfile: true,
    });
    const scan = this.scanner.scan({ marketCountry, criterion: request.criterion, topCount: request.topCount }, {
      rankings: rankingsResult.rankings,
      prices: pricesResult.value ?? [],
      orderbooks: [...bookAndWarnings.books.values()],
      warnings: bookAndWarnings.warnings,
      instrumentStates: universe.map((symbol) => {
        const suspended = this.live.snapshot(symbol, marketCountry).tradingHalted === true;
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
    const selectedSymbols = Array.from(new Set([
      ...scan.candidates.map(({ symbol }) => symbol),
      ...requestedSymbols,
    ])).slice(0, this.config.maximumTopCount);
    const candidates = this.withRequestedCandidates(
      scan,
      requestedSymbols,
      priceBySymbol,
      marketCountry,
      metadata,
    );
    const predictions = await this.repository.latestPredictions(selectedSymbols, false, marketCountry).catch(() => []);
    const predictionBySymbol = new Map(predictions.map((prediction) => [prediction.symbol, prediction]));
    const markerFromDate = Array.from(barsBySymbol.values()).flat().map((bar) => bar.sessionDate).sort()[0];
    const markerResult = portfolioValue && this.tradeMarkers
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
        candidates: candidates.filter(({ symbol }) => selectedSymbols.includes(symbol)),
        excluded: scan.excluded,
        instruments: selectedSymbols.map((symbol) => ({
          symbol,
          metadata: metadata.get(symbol),
          bars: barsBySymbol.get(symbol) ?? [],
          technical: analysisBySymbol.get(symbol) ?? {
            status: "unavailable", reason: this.rust ? "insufficient_final_bars" : "rust_worker_unavailable",
          },
          realtime: {
            ...this.live.snapshot(symbol, marketCountry),
            historicalOrderbook: { status: "unavailable", reason: "historical_orderbook_not_supplied" },
          },
          position: holdings.get(symbol) ?? { status: "unavailable", reason: "not_held_or_portfolio_unavailable" },
          tradeMarkers: markerBySymbol.get(symbol) ?? [],
          prediction: predictionBySymbol.get(symbol) ?? {
            status: "unavailable", reason: this.ai ? "prediction_not_generated" : "ai_worker_unavailable",
          },
        })),
        quality: scan.quality,
        diagnostics: {
          providerErrors: Array.from(new Set([
            ...Object.values(rankingsResult.errors),
            pricesResult.error,
            instrumentsResult.error,
            portfolioResult.error,
            markerResult.error,
            ...bookAndWarnings.errors,
          ].filter((value): value is string => Boolean(value)))),
          analysisBatchInstrumentCount: universe.length,
          analysisBatchRequestCount: this.rust && analysis ? 1 : 0,
          browserIndicatorCalculation: false,
          tradingAmountUnit: marketCountry === "US" ? "USD" : "KRW",
        },
      },
    };
  }

  async forecast(input: ScalpingForecastRequest) {
    const request = this.forecastSchema(input);
    if (!this.ai || !this.rust) {
      return { forecast: { status: "unavailable", code: !this.ai ? "ai_worker_unavailable" : "rust_worker_unavailable" }, predictions: [] };
    }
    const barsBySymbol = await this.loadBars(request.symbols, 1, request.marketCountry);
    const metadata = await this.instrumentMetadata(request.symbols);
    const analysis = await this.computeAnalysis({
      symbols: request.symbols, interval: 1, preset: "risk_management", barsBySymbol, metadata,
      holdings: new Map(), books: new Map(), trades: new Map(), responseMode: "latest_summary", includeVolumeProfile: false,
      marketCountry: request.marketCountry,
    });
    const unavailable: Array<{ symbol: string; code: string }> = [];
    const series: AiForecastRequest["series"] = [];
    for (const symbol of request.symbols) {
      const finalBars = this.configuredSessionBars(barsBySymbol.get(symbol) ?? [], request.marketCountry)
        .slice(-this.config.forecastMaximumBars);
      if (finalBars.length < this.config.forecastMinimumBars) {
        unavailable.push({ symbol, code: "insufficient_history" });
        continue;
      }
      let regularMarket: NonNullable<TossMarketCalendarDay["regularMarket"]> | undefined;
      if (request.marketCountry === "US") {
        const calendar = await this.safe(
          () => this.toss.getMarketCalendar("US", finalBars.at(-1)!.sessionDate),
          "toss_market_calendar",
        );
        regularMarket = calendar.value?.regularMarket ?? undefined;
        if (!regularMarket) {
          unavailable.push({ symbol, code: "future_market_schedule_unavailable" });
          continue;
        }
      }
      const future = this.liveFutureTimestamps(finalBars.at(-1)!, request.marketCountry, regularMarket);
      if (!future) {
        unavailable.push({ symbol, code: "future_market_schedule_unavailable" });
        continue;
      }
      series.push({
        instrument_key: symbol,
        timezone: marketTimeZone(request.marketCountry),
        input_end_at: finalBars.at(-1)!.closeTime,
        future_timestamps: future,
        bars: finalBars.map((bar) => this.aiBar(bar)),
        target_stop: targetStopFromAnalysis(analysis, symbol) ?? null,
      });
    }
    if (!series.length) return {
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
      series,
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
    }).strict().parse(input);
    const symbols = normalizedSymbols(parsed.symbols, this.config.maximumTopCount);
    const interval = intervalMinutes(parsed.interval);
    const barsBySymbol = new Map<string, IntradayBarRecord[]>();
    await Promise.all(symbols.map(async (symbol) => {
      barsBySymbol.set(symbol, await this.repository.listBars({
        marketCountry: parsed.marketCountry,
        symbol,
        intervalMinutes: interval,
        includeForming: true,
        limit: this.config.workspaceBarLimit,
      }));
    }));
    const revision = symbols.map((symbol) => {
      const latest = this.configuredSessionBars(barsBySymbol.get(symbol) ?? [], parsed.marketCountry).at(-1);
      return `${symbol}:${latest?.closeTime ?? "unavailable"}:${latest?.updatedAt ?? 0}`;
    }).join("|");
    const key = `${parsed.marketCountry}:${parsed.interval}:${parsed.preset}:${parsed.accountId ?? "default"}:${revision}`;
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
        const snapshot = this.live.snapshot(symbol, parsed.marketCountry);
        if (snapshot.orderbook) books.set(symbol, snapshot.orderbook);
        if (snapshot.trade) trades.set(symbol, [snapshot.trade]);
      }
      const technical = await this.computeAnalysis({
        symbols,
        interval,
        preset: parsed.preset,
        barsBySymbol,
        metadata: context?.metadata ?? new Map(),
        holdings: context?.holdings ?? new Map(),
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
          positionContext: context ? "latest_workspace_snapshot" : "unavailable",
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
    const analysis = await this.computeAnalysis({
      symbols: request.symbols, interval: 1, preset: "risk_management", barsBySymbol, metadata,
      holdings: new Map(), books: new Map(), trades: new Map(), responseMode: "full_series", includeVolumeProfile: false,
      marketCountry: request.marketCountry,
    });
    const series: AiEvaluateRequest["series"] = [];
    const baseOriginQuota = Math.floor(this.config.evaluationMaximumOrigins / request.symbols.length);
    const originRemainder = this.config.evaluationMaximumOrigins % request.symbols.length;
    for (const [symbolIndex, symbol] of request.symbols.entries()) {
      const finalBars = this.configuredSessionBars(barsBySymbol.get(symbol) ?? [], request.marketCountry);
      const signals = signalByTimestamp(analysis, symbol);
      const regimes = regimeByTimestamp(analysis, symbol);
      const targetStops = targetStopsByTimestamp(analysis, symbol);
      const candidateIndexes: number[] = [];
      for (let index = this.config.forecastMinimumBars - 1; index + 60 < finalBars.length; index += this.config.evaluationOriginStrideBars) {
        const window = finalBars.slice(index, index + 61);
        if (window.length === 61 && window.every((bar, offset) => (
          bar.sessionDate === window[0]!.sessionDate
          && (offset === 0 || Date.parse(bar.closeTime) - Date.parse(window[offset - 1]!.closeTime) === MINUTE_MS)
        ))) candidateIndexes.push(index);
      }
      const quota = baseOriginQuota + (symbolIndex < originRemainder ? 1 : 0);
      const indexes = quota > 0 ? candidateIndexes.slice(-quota) : [];
      if (!indexes.length) continue;
      series.push({
        instrument_key: symbol,
        timezone: marketTimeZone(request.marketCountry),
        bars: finalBars.map((bar) => this.aiBar(bar)),
        origins: indexes.map((index) => ({
          origin: finalBars[index]!.closeTime,
          future_timestamps: finalBars.slice(index + 1, index + 61).map((bar) => bar.closeTime) as AiEvaluateRequest["series"][number]["origins"][number]["future_timestamps"],
          technical_signal: signals.get(finalBars[index]!.closeTime) ?? 0,
          regime: regimes.get(finalBars[index]!.closeTime) ?? null,
          target_stop: targetStops.get(finalBars[index]!.closeTime) ?? null,
        })),
      });
    }
    if (!series.length) throw new Error("시간 순서 평가에 필요한 과거 분봉이 부족합니다.");
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
    return { ...queued, retrospective: true, walkForward: true, randomSplit: false };
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
  ): ScalpingEvaluationRequest & { marketCountry: MarketCountry } {
    const parsed = z.object({
      marketCountry: MarketCountrySchema.default("KR"),
      symbols: z.array(z.string()),
      interval: MinuteIntervalSchema,
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
  }> {
    const errors: Partial<Record<"toss" | "kis", string>> = {};
    const tossCriteria: Array<"trading_amount" | "volume" | "change_rate"> = criterion === "volatility"
      ? ["trading_amount", "volume", "change_rate"] : [criterion];
    const tossSettled = await Promise.allSettled(
      tossCriteria.map((value) => this.toss.getRankings(value, count, marketCountry)),
    );
    const rankings: NormalizedRanking[] = [];
    for (const result of tossSettled) {
      if (result.status === "fulfilled") rankings.push(...result.value);
      else errors.toss = "toss_ranking_unavailable";
    }
    if (marketCountry === "US") {
      const exchanges: readonly KisUsExchangeCode[] = ["NAS", "NYS", "AMS"];
      const overseasRequests = exchanges.flatMap((exchange) => [
        ...(criterion === "volume" || criterion === "volatility"
          ? [this.kis.getOverseasVolumeRanking({ exchange })] : []),
        ...(criterion === "trading_amount" || criterion === "volatility"
          ? [this.kis.getOverseasTradingAmountRanking({ exchange })] : []),
      ]);
      const overseasSettled = await Promise.allSettled(overseasRequests);
      const kisRankings: NormalizedRanking[] = [];
      let rejected = 0;
      let partial = 0;
      for (const result of overseasSettled) {
        if (result.status === "fulfilled") {
          kisRankings.push(...adaptKisOverseasRankings(result.value).items);
          if (result.value.quality !== "available") partial += 1;
        } else {
          rejected += 1;
        }
      }
      const globallyRanked = rerankUsKisRankings(kisRankings, criterion);
      rankings.push(...globallyRanked);
      const kisRankingCount = globallyRanked.length;
      if (rejected > 0 || partial > 0) {
        errors.kis = kisRankingCount > 0 ? "kis_ranking_partial" : "kis_ranking_unavailable";
      }
      return { rankings, errors };
    }
    const [volumeResult, fluctuationResult] = await Promise.allSettled([
      // Domestic ranking rejects the integrated quote code `UN` (OPSQ2001).
      // Use the supported KRX universe here; unified KRX/NXT live quotes enrich
      // the selected candidates after discovery.
      this.kis.getVolumeRanking({ basisCode: "0", market: "J" }),
      criterion === "volatility"
        ? this.kis.getFluctuationRanking({ sortCode: "0", market: "J" })
        : Promise.resolve(undefined),
    ]);
    if (volumeResult?.status === "fulfilled") {
      rankings.push(...adaptKisVolumeRankings(volumeResult.value).items);
    } else {
      errors.kis = "kis_ranking_unavailable";
    }
    if (fluctuationResult.status === "fulfilled" && fluctuationResult.value) {
        rankings.push(...adaptKisFluctuationRankings(fluctuationResult.value).items);
    } else if (fluctuationResult.status === "rejected") {
      errors.kis = "kis_ranking_unavailable";
    }
    return { rankings, errors };
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
      const liveBook = this.live.snapshot(symbol, marketCountry).orderbook;
      const [book, warning, trade] = await Promise.allSettled([
        liveBook ? Promise.resolve(liveBook) : this.toss.getOrderbook(symbol),
        this.toss.getWarnings(symbol),
        this.toss.getTrades(symbol, this.config.tradeFetchCount),
      ]);
      if (book.status === "fulfilled") books.set(symbol, book.value);
      else errors.push(`toss_orderbook_unavailable:${symbol}`);
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
  ): Promise<Map<string, IntradayBarRecord[]>> {
    const output = new Map<string, IntradayBarRecord[]>();
    await Promise.all(symbols.map(async (symbol) => {
      let oneMinute = await this.repository.listBars({
        marketCountry, symbol, intervalMinutes: 1, includeForming: true, limit: this.config.workspaceBarLimit,
      });
      const latest = oneMinute.at(-1);
      if (!latest || this.now() - Date.parse(latest.openTime) > this.config.barRefreshAfterMs) {
        const normalized = await this.fetchMinuteHistory(symbol, oneMinute, marketCountry);
        if (normalized.length) {
          const sessions = new Map<string, IntradayBarRecord[]>();
          for (const bar of normalized) {
            sessions.set(bar.sessionDate, [...(sessions.get(bar.sessionDate) ?? []), bar]);
          }
          const aggregated = [
            ...normalized,
            ...([5, 15, 30, 60] as const).flatMap((minutes) => [...sessions.entries()].flatMap(
              ([sessionDate, sessionBars]) => aggregateRecoveredBars(sessionBars, minutes, {
                sessionStartAt: marketSessionAnchor(sessionDate, marketCountry),
              }).map((bar) => ({
                ...bar,
                source: "toss_rest" as const,
                quality: bar.quality === "recovered" ? "complete" as const : bar.quality,
              })),
            )),
          ];
          await this.repository.putBars(aggregated);
          oneMinute = await this.repository.listBars({
            marketCountry, symbol, intervalMinutes: 1, includeForming: true, limit: this.config.workspaceBarLimit,
          });
        }
      }
      if (interval === 1) output.set(symbol, oneMinute);
      else output.set(symbol, await this.repository.listBars({
        marketCountry, symbol, intervalMinutes: interval, includeForming: true, limit: this.config.workspaceBarLimit,
      }));
    }));
    return output;
  }

  private async fetchMinuteHistory(
    symbol: string,
    existing: readonly IntradayBarRecord[],
    marketCountry: MarketCountry = "KR",
  ): Promise<IntradayBarRecord[]> {
    const known = new Map(existing.map((bar) => [bar.openTime, bar]));
    const fetched = new Map<string, IntradayBarRecord>();
    let before: string | undefined;
    while (known.size < this.config.workspaceBarLimit || before === undefined) {
      const page = await this.safe(
        () => this.toss.getMinuteCandles(symbol, this.config.candlePageSize, before, marketCountry),
        "toss_candles",
      );
      if (!page.value?.length) break;
      let added = 0;
      for (const candle of page.value) {
        const normalized = storeRecord(candle, this.now(), marketCountry);
        if (!known.has(normalized.openTime)) added += 1;
        known.set(normalized.openTime, normalized);
        fetched.set(normalized.openTime, normalized);
      }
      const oldest = page.value[0]?.timestamp;
      if (!oldest || page.value.length < this.config.candlePageSize || added === 0) break;
      before = new Date(Date.parse(oldest) - 1).toISOString();
      if (known.size >= this.config.workspaceBarLimit) break;
    }
    return [...fetched.values()]
      .sort((left, right) => left.openTime.localeCompare(right.openTime))
      .slice(-this.config.workspaceBarLimit);
  }

  private async computeAnalysis(input: {
    symbols: readonly string[];
    interval: ScalpingInterval;
    preset: WorkspacePreset;
    barsBySymbol: ReadonlyMap<string, IntradayBarRecord[]>;
    metadata: ReadonlyMap<string, InstrumentInfo>;
    holdings: ReadonlyMap<string, CausalPosition>;
    books: ReadonlyMap<string, NormalizedOrderbook>;
    trades: ReadonlyMap<string, NormalizedTrade[]>;
    marketCountry: MarketCountry;
    responseMode: "full_series" | "latest_summary";
    includeVolumeProfile: boolean;
  }): Promise<unknown> {
    if (!this.rust) return undefined;
    const instruments = input.symbols.flatMap((symbol) => {
      const bars = this.configuredSessionBars(input.barsBySymbol.get(symbol) ?? [], input.marketCountry);
      if (bars.length < this.config.minimumAnalysisBars) return [];
      const last = bars.at(-1)!;
      const item = input.metadata.get(symbol);
      const book = input.books.get(symbol);
      const trades = input.trades.get(symbol) ?? [];
      const buyVolume = trades.filter(({ side }) => side === "buy").reduce((sum, trade) => sum + trade.quantity, 0);
      const sellVolume = trades.filter(({ side }) => side === "sell").reduce((sum, trade) => sum + trade.quantity, 0);
      const holding = input.holdings.get(symbol);
      const nextQuote = book && Date.parse(book.observedAt) > Date.parse(last.closeTime) ? book.observedAt : undefined;
      return [{
        key: symbol,
        symbol,
        market: item?.market ?? input.marketCountry,
        currency: item?.currency ?? (input.marketCountry === "US" ? "USD" : "KRW"),
        instrument_type: instrumentType(item),
        bars: bars.map((bar) => ({
          timestamp: bar.closeTime,
          session_date: bar.sessionDate,
          open: bar.open,
          high: bar.high,
          low: bar.low,
          close: bar.close,
          ...(bar.volume === undefined ? {} : { volume: bar.volume }),
          ...(bar.turnover === undefined ? {} : { amount: bar.turnover }),
          complete: true,
        })),
        session_start_confirmed_dates: this.confirmedSessionDates(bars, input.interval, input.marketCountry).started,
        complete_session_dates: this.confirmedSessionDates(bars, input.interval, input.marketCountry).complete,
        anchored_vwap_timestamp: bars.find((bar) => bar.sessionDate === last.sessionDate)?.closeTime,
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
    if (!instruments.length) return undefined;
    const profileKeys = input.includeVolumeProfile
      ? instruments.slice(0, this.config.volumeProfileInstrumentLimit).map(({ key }) => key)
      : [];
    const output = await this.rust.compute<unknown>("scalping_analysis", {
      scalping_analysis: {
        schema_version: "scalping-analysis-request/v1",
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
      },
    }, { includeArtifacts: false });
    return output.result;
  }

  private withRequestedCandidates(
    scan: ScannerResult,
    requested: readonly string[],
    prices: ReadonlyMap<string, NormalizedPrice>,
    marketCountry: MarketCountry,
    metadata: ReadonlyMap<string, InstrumentInfo>,
  ): ScannerCandidate[] {
    const output = [...scan.candidates];
    for (const symbol of requested) {
      if (output.some((candidate) => candidate.symbol === symbol)) continue;
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
    return output;
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
  ): IntradayBarRecord[] {
    const session = regularSessionMinutes(marketCountry, this.config);
    return bars.filter((bar) => {
      if (bar.state !== "final") return false;
      if (bar.quality === "partial" || bar.quality === "stale") return false;
      const local = marketMinute(bar.closeTime, marketCountry);
      return local.date === bar.sessionDate
        && local.minute > session.open
        && local.minute <= session.close;
    });
  }

  private confirmedSessionDates(
    bars: readonly IntradayBarRecord[],
    interval: ScalpingInterval,
    marketCountry: MarketCountry = "KR",
  ): { started: string[]; complete: string[] } {
    const session = regularSessionMinutes(marketCountry, this.config);
    const sessions = new Map<string, IntradayBarRecord[]>();
    for (const bar of bars) sessions.set(bar.sessionDate, [...(sessions.get(bar.sessionDate) ?? []), bar]);
    const started: string[] = [];
    const complete: string[] = [];
    for (const [date, sessionBars] of sessions) {
      const sorted = [...sessionBars].sort((left, right) => left.closeTime.localeCompare(right.closeTime));
      const first = marketMinute(sorted[0]!.closeTime, marketCountry);
      const last = marketMinute(sorted.at(-1)!.closeTime, marketCountry);
      if (first.date !== date || first.minute !== session.open + interval) continue;
      started.push(date);
      const expectedCount = (session.close - session.open) / interval;
      if (last.date === date && last.minute === session.close
        && Number.isInteger(expectedCount) && sorted.length === expectedCount
        && sorted.every((bar, index) => (
          marketMinute(bar.closeTime, marketCountry).minute === session.open + interval * (index + 1)
        ))) {
        complete.push(date);
      }
    }
    return { started, complete };
  }

  private liveFutureTimestamps(
    last: IntradayBarRecord,
    marketCountry: MarketCountry = "KR",
    confirmedRegularMarket?: NonNullable<TossMarketCalendarDay["regularMarket"]>,
  ): AiForecastRequest["series"][number]["future_timestamps"] | undefined {
    const output = Array.from({ length: 60 }, (_, index) => new Date(Date.parse(last.closeTime) + (index + 1) * MINUTE_MS).toISOString());
    if (Date.parse(output[0]!) <= this.now()) return undefined;
    if (marketCountry === "US") {
      if (!confirmedRegularMarket) return undefined;
      const inputEnd = Date.parse(last.closeTime);
      const sessionStart = Date.parse(confirmedRegularMarket.startAt);
      const sessionEnd = Date.parse(confirmedRegularMarket.endAt);
      if (inputEnd < sessionStart || Date.parse(output.at(-1)!) > sessionEnd) return undefined;
      return output as AiForecastRequest["series"][number]["future_timestamps"];
    }
    const session = regularSessionMinutes(marketCountry, this.config);
    const local = marketMinute(last.closeTime, marketCountry);
    const final = marketMinute(output.at(-1)!, marketCountry);
    if (local.date !== last.sessionDate || local.date !== final.date || local.minute < session.open
      || final.minute > session.close) return undefined;
    return output as AiForecastRequest["series"][number]["future_timestamps"];
  }

  private async safe<T>(task: () => Promise<T>, code: string): Promise<{ value?: T; error?: string }> {
    try {
      return { value: await task() };
    } catch {
      return { error: code };
    }
  }
}
