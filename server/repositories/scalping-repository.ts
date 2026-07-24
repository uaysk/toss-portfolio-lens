import { randomUUID } from "node:crypto";
import type { RelationalDatabase } from "../database.js";
import { applyPortfolioMigrations } from "../migrations.js";
import { canonicalJson } from "../worker/contracts.js";
import type {
  MarketCountry,
  MarketProvider,
  MarketStorageKey,
  MarketVenue,
  OrderbookLevel,
  UsExchange,
} from "../scalping/contracts.js";

export const SCALPING_INTERVALS = [1, 5, 15, 30, 60] as const;
const INTRADAY_BAR_COLUMNS = 18;
const SCALPING_TRADE_COLUMNS = 21;
const SCALPING_ORDERBOOK_COLUMNS = 20;
const SCALPING_RECORDING_EVENT_COLUMNS = 8;
// Keep every statement comfortably below PostgreSQL's 65,535 bind parameter
// ceiling as well as the lower limits used by some SQLite builds/proxies.
const INTRADAY_BAR_UPSERT_BATCH_SIZE = 500;
const RAW_MARKET_DATA_INSERT_BATCH_SIZE = 500;
const RAW_MARKET_DATA_INPUT_LIMIT = 100_000;
const RECORDING_EVENT_DETAILS_MAX_BYTES = 64 * 1_024;
export type ScalpingInterval = typeof SCALPING_INTERVALS[number];
export type IntradayBarState = "forming" | "final";
export type IntradayBarSource =
  | "kis_ws"
  | "kis_rest"
  | "toss_rest"
  | "binance_ws"
  | "binance_rest"
  | "recovered";
export type IntradayQuality = "complete" | "partial" | "recovered" | "stale";
export type ScalpingSessionFeed = "standard" | "day";
export type ScalpingTradeSide = "buy" | "sell" | "unknown";
export type ScalpingOrderbookDepth = "top_of_book" | "ten_level";
export const SCALPING_RECORDING_EVENT_TYPES = [
  "recorder_started",
  "recorder_stopped",
  "connection_state",
  "subscription_state",
  "data_gap",
  "queue_overflow",
  "persistence_error",
  "diagnostic",
] as const;
export type ScalpingRecordingEventType = typeof SCALPING_RECORDING_EVENT_TYPES[number];

export type IntradayBarRecord = {
  marketCountry?: MarketCountry;
  symbol: string;
  intervalMinutes: ScalpingInterval;
  openTime: string;
  closeTime: string;
  sessionDate: string;
  source: IntradayBarSource;
  state: IntradayBarState;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
  turnover?: number;
  tradeCount?: number;
  quality: IntradayQuality;
  updatedAt: number;
};
export type StoredIntradayBarRecord = Omit<IntradayBarRecord, "marketCountry"> & {
  marketCountry?: MarketStorageKey;
};

export type ScalpingTradeRecord = {
  marketCountry?: MarketStorageKey;
  symbol: string;
  eventId: string;
  provider: MarketProvider;
  venue: MarketVenue;
  exchange?: UsExchange;
  sessionFeed?: ScalpingSessionFeed;
  sessionDate: string;
  executedAt: string;
  receivedAt: string;
  price: number;
  quantity: number;
  tradingAmount?: number;
  side: ScalpingTradeSide;
  cumulativeVolume?: number;
  cumulativeAmount?: number;
  executionStrength?: number;
  executionClass?: string;
  bestBidPrice?: number;
  bestAskPrice?: number;
  recordedAt: number;
};

export type ScalpingOrderbookRecord = {
  snapshotId: string;
  marketCountry?: MarketStorageKey;
  symbol: string;
  provider: MarketProvider;
  venue: MarketVenue;
  exchange?: UsExchange;
  sessionFeed?: ScalpingSessionFeed;
  sessionDate: string;
  observedAt: string;
  receivedAt: string;
  depth: ScalpingOrderbookDepth;
  asks: readonly OrderbookLevel[];
  bids: readonly OrderbookLevel[];
  totalAskQuantity?: number;
  totalBidQuantity?: number;
  bestAskPrice: number;
  bestAskQuantity: number;
  bestBidPrice: number;
  bestBidQuantity: number;
  recordedAt: number;
};

export type ScalpingRecordingEventRecord = {
  eventId: string;
  marketCountry: MarketStorageKey;
  symbol?: string;
  eventType: ScalpingRecordingEventType;
  occurredAt: string;
  code?: string;
  details?: unknown;
  recordedAt: number;
};

export type ScalpingPredictionStatus = "available" | "unavailable" | "failed";
export type ScalpingPredictionQuality =
  | "complete"
  | "partial"
  | "stale"
  | "insufficient_history"
  | "model_unavailable"
  | "out_of_distribution";

export type ScalpingPredictionRecord = {
  id: string;
  marketCountry?: MarketStorageKey;
  symbol: string;
  modelName: string;
  modelVersion: string;
  inputEndedAt: string;
  generatedAt: string;
  status: ScalpingPredictionStatus;
  dataQuality: ScalpingPredictionQuality;
  retrospective: boolean;
  payload: unknown;
  createdAt: number;
};

type IntradayBarRow = {
  market_country: MarketStorageKey;
  symbol: string;
  interval_minutes: number | string;
  open_time: string;
  close_time: string;
  session_date: string;
  source_kind: IntradayBarSource;
  bar_state: IntradayBarState;
  open_price: number | string;
  high_price: number | string;
  low_price: number | string;
  close_price: number | string;
  volume: number | string;
  volume_available: boolean | number | string;
  turnover: number | string | null;
  trade_count: number | string | null;
  quality_status: IntradayQuality;
  updated_at: number | string;
};

type PredictionRow = {
  prediction_id: string;
  market_country: MarketStorageKey;
  symbol: string;
  model_name: string;
  model_version: string;
  input_ended_at: string;
  generated_at: string;
  status: ScalpingPredictionStatus;
  data_quality: ScalpingPredictionQuality;
  retrospective: boolean | number | string;
  payload_json: string;
  created_at: number | string;
};

type ScalpingTradeRow = {
  market_country: MarketStorageKey;
  symbol: string;
  event_id: string;
  provider: MarketProvider;
  venue: MarketVenue;
  exchange_code: UsExchange | null;
  session_feed: ScalpingSessionFeed | null;
  session_date: string;
  executed_at: string;
  received_at: string;
  price: number | string;
  quantity: number | string;
  trading_amount: number | string | null;
  side: ScalpingTradeSide;
  cumulative_volume: number | string | null;
  cumulative_amount: number | string | null;
  execution_strength: number | string | null;
  execution_class: string | null;
  best_bid_price: number | string | null;
  best_ask_price: number | string | null;
  recorded_at: number | string;
};

type ScalpingOrderbookRow = {
  snapshot_id: string;
  market_country: MarketStorageKey;
  symbol: string;
  provider: MarketProvider;
  venue: MarketVenue;
  exchange_code: UsExchange | null;
  session_feed: ScalpingSessionFeed | null;
  session_date: string;
  observed_at: string;
  received_at: string;
  depth: ScalpingOrderbookDepth;
  asks_json: string;
  bids_json: string;
  total_ask_quantity: number | string | null;
  total_bid_quantity: number | string | null;
  best_ask_price: number | string;
  best_ask_quantity: number | string;
  best_bid_price: number | string;
  best_bid_quantity: number | string;
  recorded_at: number | string;
};

type ScalpingRecordingEventRow = {
  event_id: string;
  market_country: MarketStorageKey;
  symbol: string | null;
  event_type: ScalpingRecordingEventType;
  occurred_at: string;
  code: string | null;
  details_json: string | null;
  recorded_at: number | string;
};

function symbol(value: string): string {
  if (typeof value !== "string") {
    throw new Error("단타 종목 코드는 영문 대문자, 숫자, '.', '_', '-' 조합의 1~32자여야 합니다.");
  }
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9._-]{0,31}$/.test(normalized)) {
    throw new Error("단타 종목 코드는 영문 대문자, 숫자, '.', '_', '-' 조합의 1~32자여야 합니다.");
  }
  return normalized;
}

function marketCountry(value: MarketStorageKey | undefined): MarketStorageKey {
  const normalized = value ?? "KR";
  if (normalized !== "KR" && normalized !== "US" && normalized !== "BINANCE_USDM") {
    throw new Error("단타 시장은 KR, US 또는 BINANCE_USDM이어야 합니다.");
  }
  return normalized;
}

function isoTimestamp(value: string, field: string): string {
  if (typeof value !== "string"
    || value.length > 40
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new Error(`${field}는 RFC3339 시각이어야 합니다.`);
  }
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) throw new Error(`${field}는 RFC3339 시각이어야 합니다.`);
  return timestamp.toISOString();
}

function date(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)
    || Number.isNaN(new Date(`${value}T00:00:00.000Z`).getTime())
    || new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) {
    throw new Error("sessionDate는 YYYY-MM-DD 형식이어야 합니다.");
  }
  return value;
}

function finite(value: number, field: string, minimum: number, inclusive = true): number {
  if (!Number.isFinite(value) || (inclusive ? value < minimum : value <= minimum)) {
    throw new Error(`${field} 값이 올바르지 않습니다.`);
  }
  return value;
}

function identifier(value: unknown, field: string, maximumLength: number): string {
  if (typeof value !== "string") throw new Error(`${field} 식별자가 올바르지 않습니다.`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximumLength || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${field} 식별자가 올바르지 않습니다.`);
  }
  return normalized;
}

function eventId(value: string): string {
  const normalized = identifier(value, "eventId", 240);
  if (/\s/.test(normalized)) throw new Error("eventId 식별자가 올바르지 않습니다.");
  return normalized;
}

function uuid(value: string, field: string): string {
  const normalized = identifier(value, field, 36).toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(normalized)) {
    throw new Error(`${field}는 UUID 형식이어야 합니다.`);
  }
  return normalized;
}

function snapshotId(value: string): string {
  return uuid(value, "snapshotId");
}

function provider(value: MarketProvider): MarketProvider {
  const normalized = identifier(value, "provider", 32).toLowerCase();
  if (normalized !== "toss" && normalized !== "kis"
    && normalized !== "derived" && normalized !== "binance") {
    throw new Error("provider 식별자가 올바르지 않습니다.");
  }
  return normalized;
}

function barSource(value: IntradayBarSource, market: MarketStorageKey): IntradayBarSource {
  const normalized = identifier(value, "source", 32).toLowerCase() as IntradayBarSource;
  const supported: readonly IntradayBarSource[] = [
    "kis_ws",
    "kis_rest",
    "toss_rest",
    "binance_ws",
    "binance_rest",
    "recovered",
  ];
  if (!supported.includes(normalized)) throw new Error("source 식별자가 올바르지 않습니다.");
  const binance = normalized === "binance_ws" || normalized === "binance_rest";
  if ((market === "BINANCE_USDM") !== binance && normalized !== "recovered") {
    throw new Error("Binance bar source와 marketCountry가 같은 시장을 가리켜야 합니다.");
  }
  return normalized;
}

function venue(value: MarketVenue): MarketVenue {
  const normalized = identifier(value, "venue", 32).toUpperCase();
  if (normalized !== "KRX" && normalized !== "NXT" && normalized !== "INTEGRATED"
    && normalized !== "US" && normalized !== "BINANCE_USDM") {
    throw new Error("venue 식별자가 올바르지 않습니다.");
  }
  return normalized;
}

function validateMarketSource(
  market: MarketStorageKey,
  normalizedProvider: MarketProvider,
  normalizedVenue: MarketVenue,
): void {
  if (market === "BINANCE_USDM") {
    if (normalizedProvider !== "binance" || normalizedVenue !== "BINANCE_USDM") {
      throw new Error("BINANCE_USDM 시장은 binance provider와 BINANCE_USDM venue가 필요합니다.");
    }
    return;
  }
  if (normalizedProvider === "binance" || normalizedVenue === "BINANCE_USDM") {
    throw new Error("Binance provider와 venue는 BINANCE_USDM 시장에서만 사용할 수 있습니다.");
  }
  if ((market === "US") !== (normalizedVenue === "US")) {
    throw new Error("marketCountry와 venue가 같은 시장을 가리켜야 합니다.");
  }
}

function exchange(value: UsExchange | undefined): UsExchange | undefined {
  if (value === undefined) return undefined;
  const normalized = identifier(value, "exchange", 8).toUpperCase();
  if (normalized !== "NAS" && normalized !== "NYS" && normalized !== "AMS") {
    throw new Error("exchange 식별자가 올바르지 않습니다.");
  }
  return normalized;
}

function sessionFeed(value: ScalpingSessionFeed | undefined): ScalpingSessionFeed | undefined {
  if (value === undefined) return undefined;
  const normalized = identifier(value, "sessionFeed", 16).toLowerCase();
  if (normalized !== "standard" && normalized !== "day") {
    throw new Error("sessionFeed 식별자가 올바르지 않습니다.");
  }
  return normalized;
}

function tradeSide(value: ScalpingTradeSide): ScalpingTradeSide {
  const normalized = identifier(value, "side", 16).toLowerCase();
  if (normalized !== "buy" && normalized !== "sell" && normalized !== "unknown") {
    throw new Error("side 식별자가 올바르지 않습니다.");
  }
  return normalized;
}

function executionClass(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = identifier(value, "executionClass", 32);
  if (!/^[A-Za-z0-9._:-]+$/.test(normalized)) {
    throw new Error("executionClass 식별자가 올바르지 않습니다.");
  }
  return normalized;
}

function recordingEventType(value: ScalpingRecordingEventType): ScalpingRecordingEventType {
  const normalized = identifier(value, "eventType", 64).toLowerCase();
  if (!(SCALPING_RECORDING_EVENT_TYPES as readonly string[]).includes(normalized)) {
    throw new Error("eventType 식별자가 올바르지 않습니다.");
  }
  return normalized as ScalpingRecordingEventType;
}

function recordingEventCode(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = identifier(value, "code", 120);
  if (!/^[A-Za-z0-9._:-]+$/.test(normalized)) {
    throw new Error("code 식별자가 올바르지 않습니다.");
  }
  return normalized;
}

function recordingEventDetails(value: unknown): string {
  const json = canonicalJson(value);
  if (Buffer.byteLength(json, "utf8") > RECORDING_EVENT_DETAILS_MAX_BYTES) {
    throw new Error("recording event details는 64KiB 이하여야 합니다.");
  }
  return json;
}

function recordedAt(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("recordedAt 값이 올바르지 않습니다.");
  return value;
}

function orderbookLevels(value: unknown, side: "asks" | "bids"): OrderbookLevel[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 50) {
    throw new Error(`${side} 호가 단계는 1~50개여야 합니다.`);
  }
  const levels = value.map((item, index) => {
    if (typeof item !== "object" || item === null) {
      throw new Error(`${side}[${index}] 호가 단계가 올바르지 않습니다.`);
    }
    const candidate = item as Record<string, unknown>;
    if (typeof candidate.price !== "number" || typeof candidate.quantity !== "number") {
      throw new Error(`${side}[${index}] 호가 단계가 올바르지 않습니다.`);
    }
    return {
      price: finite(candidate.price, `${side}[${index}].price`, 0, false),
      quantity: finite(candidate.quantity, `${side}[${index}].quantity`, 0),
    };
  });
  for (let index = 1; index < levels.length; index += 1) {
    const prior = levels[index - 1]!;
    const current = levels[index]!;
    if ((side === "asks" && current.price < prior.price)
      || (side === "bids" && current.price > prior.price)) {
      throw new Error(`${side} 호가는 최우선 호가부터 가격 순서대로 정렬되어야 합니다.`);
    }
  }
  return levels;
}

function levelsFromJson(value: string, side: "asks" | "bids"): OrderbookLevel[] {
  try {
    return orderbookLevels(JSON.parse(value) as unknown, side);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`저장된 ${side} 호가 JSON이 손상되었습니다.`);
    throw error;
  }
}

function detailsFromJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error("저장된 recording event details JSON이 손상되었습니다.");
  }
}

function queryLimit(value: number | undefined): number {
  if (value !== undefined && !Number.isFinite(value)) throw new Error("limit 값이 올바르지 않습니다.");
  return Math.max(1, Math.min(50_000, Math.trunc(value ?? 1_000)));
}

async function insertAppendOnlyRows(
  database: RelationalDatabase,
  input: {
    table:
      | "portfolio_scalping_trades"
      | "portfolio_scalping_orderbooks"
      | "portfolio_scalping_recording_events";
    columns: readonly string[];
    conflictColumns: readonly string[];
    columnCount: number;
    rows: readonly unknown[][];
  },
): Promise<void> {
  if (input.columns.length !== input.columnCount
    || input.rows.some((row) => row.length !== input.columnCount)) {
    throw new Error(`${input.table} insert column count가 일치하지 않습니다.`);
  }
  const batches: unknown[][][] = [];
  for (let index = 0; index < input.rows.length; index += RAW_MARKET_DATA_INSERT_BATCH_SIZE) {
    batches.push(input.rows.slice(index, index + RAW_MARKET_DATA_INSERT_BATCH_SIZE));
  }
  const write = async (target: RelationalDatabase): Promise<void> => {
    for (const rows of batches) {
      const placeholders = rows
        .map(() => `(${Array.from({ length: input.columnCount }, () => "?").join(", ")})`)
        .join(", ");
      const insert = target.dialect === "mysql" ? "INSERT IGNORE" : "INSERT";
      const conflict = target.dialect === "mysql"
        ? ""
        : `ON CONFLICT(${input.conflictColumns.join(", ")}) DO NOTHING`;
      await target.run(`
        ${insert} INTO ${input.table} (${input.columns.join(", ")})
        VALUES ${placeholders}
        ${conflict}
      `, rows.flat());
    }
  };
  if (batches.length === 1) {
    await write(database);
    return;
  }
  await database.transaction(write);
}

function barFromRow(row: IntradayBarRow): StoredIntradayBarRecord {
  return {
    marketCountry: marketCountry(row.market_country),
    symbol: row.symbol,
    intervalMinutes: Number(row.interval_minutes) as ScalpingInterval,
    openTime: row.open_time,
    closeTime: row.close_time,
    sessionDate: row.session_date,
    source: row.source_kind,
    state: row.bar_state,
    open: Number(row.open_price),
    high: Number(row.high_price),
    low: Number(row.low_price),
    close: Number(row.close_price),
    ...(row.volume_available === true || Number(row.volume_available) === 1
      ? { volume: Number(row.volume) }
      : {}),
    ...(row.turnover !== null ? { turnover: Number(row.turnover) } : {}),
    ...(row.trade_count !== null ? { tradeCount: Number(row.trade_count) } : {}),
    quality: row.quality_status,
    updatedAt: Number(row.updated_at),
  };
}

function tradeFromRow(row: ScalpingTradeRow): ScalpingTradeRecord {
  return {
    marketCountry: row.market_country,
    symbol: row.symbol,
    eventId: row.event_id,
    provider: row.provider,
    venue: row.venue,
    ...(row.exchange_code === null ? {} : { exchange: row.exchange_code }),
    ...(row.session_feed === null ? {} : { sessionFeed: row.session_feed }),
    sessionDate: row.session_date,
    executedAt: row.executed_at,
    receivedAt: row.received_at,
    price: Number(row.price),
    quantity: Number(row.quantity),
    ...(row.trading_amount === null ? {} : { tradingAmount: Number(row.trading_amount) }),
    side: row.side,
    ...(row.cumulative_volume === null ? {} : { cumulativeVolume: Number(row.cumulative_volume) }),
    ...(row.cumulative_amount === null ? {} : { cumulativeAmount: Number(row.cumulative_amount) }),
    ...(row.execution_strength === null ? {} : { executionStrength: Number(row.execution_strength) }),
    ...(row.execution_class === null ? {} : { executionClass: row.execution_class }),
    ...(row.best_bid_price === null ? {} : { bestBidPrice: Number(row.best_bid_price) }),
    ...(row.best_ask_price === null ? {} : { bestAskPrice: Number(row.best_ask_price) }),
    recordedAt: Number(row.recorded_at),
  };
}

function orderbookFromRow(row: ScalpingOrderbookRow): ScalpingOrderbookRecord {
  return {
    snapshotId: row.snapshot_id,
    marketCountry: row.market_country,
    symbol: row.symbol,
    provider: row.provider,
    venue: row.venue,
    ...(row.exchange_code === null ? {} : { exchange: row.exchange_code }),
    ...(row.session_feed === null ? {} : { sessionFeed: row.session_feed }),
    sessionDate: row.session_date,
    observedAt: row.observed_at,
    receivedAt: row.received_at,
    depth: row.depth,
    asks: levelsFromJson(row.asks_json, "asks"),
    bids: levelsFromJson(row.bids_json, "bids"),
    ...(row.total_ask_quantity === null ? {} : { totalAskQuantity: Number(row.total_ask_quantity) }),
    ...(row.total_bid_quantity === null ? {} : { totalBidQuantity: Number(row.total_bid_quantity) }),
    bestAskPrice: Number(row.best_ask_price),
    bestAskQuantity: Number(row.best_ask_quantity),
    bestBidPrice: Number(row.best_bid_price),
    bestBidQuantity: Number(row.best_bid_quantity),
    recordedAt: Number(row.recorded_at),
  };
}

function recordingEventFromRow(row: ScalpingRecordingEventRow): ScalpingRecordingEventRecord {
  return {
    eventId: row.event_id,
    marketCountry: row.market_country,
    ...(row.symbol === null ? {} : { symbol: row.symbol }),
    eventType: row.event_type,
    occurredAt: row.occurred_at,
    ...(row.code === null ? {} : { code: row.code }),
    ...(row.details_json === null ? {} : { details: detailsFromJson(row.details_json) }),
    recordedAt: Number(row.recorded_at),
  };
}

function predictionFromRow(row: PredictionRow): ScalpingPredictionRecord {
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload_json) as unknown;
  } catch {
    throw new Error("저장된 단타 예측 JSON이 손상되었습니다.");
  }
  return {
    id: row.prediction_id,
    marketCountry: marketCountry(row.market_country),
    symbol: row.symbol,
    modelName: row.model_name,
    modelVersion: row.model_version,
    inputEndedAt: row.input_ended_at,
    generatedAt: row.generated_at,
    status: row.status,
    dataQuality: row.data_quality,
    retrospective: row.retrospective === true || Number(row.retrospective) === 1,
    payload,
    createdAt: Number(row.created_at),
  };
}

export class ScalpingRepository {
  constructor(private readonly database: RelationalDatabase) {}

  initialize(): Promise<unknown> {
    return applyPortfolioMigrations(this.database);
  }

  async putBars(input: readonly StoredIntradayBarRecord[]): Promise<void> {
    if (input.length > 100_000) throw new Error("한 번에 저장할 분봉은 100,000개 이하여야 합니다.");
    if (!input.length) return;
    const mysqlPreferred = `(
      CASE VALUES(bar_state) WHEN 'final' THEN 1 ELSE 0 END > CASE bar_state WHEN 'final' THEN 1 ELSE 0 END
      OR (VALUES(bar_state) = bar_state AND CASE VALUES(quality_status)
        WHEN 'recovered' THEN 3 WHEN 'complete' THEN 2 WHEN 'partial' THEN 1 ELSE 0 END
        > CASE quality_status WHEN 'recovered' THEN 3 WHEN 'complete' THEN 2 WHEN 'partial' THEN 1 ELSE 0 END)
      OR (VALUES(bar_state) = bar_state AND CASE VALUES(quality_status)
        WHEN 'recovered' THEN 3 WHEN 'complete' THEN 2 WHEN 'partial' THEN 1 ELSE 0 END
        = CASE quality_status WHEN 'recovered' THEN 3 WHEN 'complete' THEN 2 WHEN 'partial' THEN 1 ELSE 0 END
        AND CASE VALUES(source_kind)
        WHEN 'binance_ws' THEN 5 WHEN 'kis_ws' THEN 4
        WHEN 'binance_rest' THEN 3 WHEN 'kis_rest' THEN 3
        WHEN 'recovered' THEN 2 ELSE 1 END
        > CASE source_kind WHEN 'binance_ws' THEN 5 WHEN 'kis_ws' THEN 4
          WHEN 'binance_rest' THEN 3 WHEN 'kis_rest' THEN 3
          WHEN 'recovered' THEN 2 ELSE 1 END)
      OR (VALUES(bar_state) = bar_state AND CASE VALUES(quality_status)
        WHEN 'recovered' THEN 3 WHEN 'complete' THEN 2 WHEN 'partial' THEN 1 ELSE 0 END
        = CASE quality_status WHEN 'recovered' THEN 3 WHEN 'complete' THEN 2 WHEN 'partial' THEN 1 ELSE 0 END
        AND VALUES(source_kind) = source_kind AND VALUES(updated_at) >= updated_at)
    )`;
    const conflictPreferred = `(
      CASE EXCLUDED.bar_state WHEN 'final' THEN 1 ELSE 0 END
        > CASE portfolio_intraday_bars.bar_state WHEN 'final' THEN 1 ELSE 0 END
      OR (EXCLUDED.bar_state = portfolio_intraday_bars.bar_state AND CASE EXCLUDED.quality_status
        WHEN 'recovered' THEN 3 WHEN 'complete' THEN 2 WHEN 'partial' THEN 1 ELSE 0 END
        > CASE portfolio_intraday_bars.quality_status
          WHEN 'recovered' THEN 3 WHEN 'complete' THEN 2 WHEN 'partial' THEN 1 ELSE 0 END)
      OR (EXCLUDED.bar_state = portfolio_intraday_bars.bar_state AND CASE EXCLUDED.quality_status
        WHEN 'recovered' THEN 3 WHEN 'complete' THEN 2 WHEN 'partial' THEN 1 ELSE 0 END
        = CASE portfolio_intraday_bars.quality_status
          WHEN 'recovered' THEN 3 WHEN 'complete' THEN 2 WHEN 'partial' THEN 1 ELSE 0 END
        AND CASE EXCLUDED.source_kind
        WHEN 'binance_ws' THEN 5 WHEN 'kis_ws' THEN 4
        WHEN 'binance_rest' THEN 3 WHEN 'kis_rest' THEN 3
        WHEN 'recovered' THEN 2 ELSE 1 END
        > CASE portfolio_intraday_bars.source_kind
          WHEN 'binance_ws' THEN 5 WHEN 'kis_ws' THEN 4
          WHEN 'binance_rest' THEN 3 WHEN 'kis_rest' THEN 3
          WHEN 'recovered' THEN 2 ELSE 1 END)
      OR (EXCLUDED.bar_state = portfolio_intraday_bars.bar_state
        AND CASE EXCLUDED.quality_status
          WHEN 'recovered' THEN 3 WHEN 'complete' THEN 2 WHEN 'partial' THEN 1 ELSE 0 END
          = CASE portfolio_intraday_bars.quality_status
            WHEN 'recovered' THEN 3 WHEN 'complete' THEN 2 WHEN 'partial' THEN 1 ELSE 0 END
        AND EXCLUDED.source_kind = portfolio_intraday_bars.source_kind
        AND EXCLUDED.updated_at >= portfolio_intraday_bars.updated_at)
    )`;
    const normalized = input.map((item) => {
      const normalizedMarketCountry = marketCountry(item.marketCountry);
      const normalizedSymbol = symbol(item.symbol);
      const normalizedSource = barSource(item.source, normalizedMarketCountry);
      if (!(SCALPING_INTERVALS as readonly number[]).includes(item.intervalMinutes)) {
        throw new Error("지원하지 않는 분봉 간격입니다.");
      }
      const openTime = isoTimestamp(item.openTime, "openTime");
      const closeTime = isoTimestamp(item.closeTime, "closeTime");
      if (openTime >= closeTime) throw new Error("분봉 closeTime은 openTime보다 뒤여야 합니다.");
      const open = finite(item.open, "open", 0, false);
      const high = finite(item.high, "high", 0, false);
      const low = finite(item.low, "low", 0, false);
      const close = finite(item.close, "close", 0, false);
      if (high < Math.max(open, close) || low > Math.min(open, close) || low > high) {
        throw new Error("분봉 OHLC 범위가 올바르지 않습니다.");
      }
      if (item.volume !== undefined) finite(item.volume, "volume", 0);
      if (item.turnover !== undefined) finite(item.turnover, "turnover", 0);
      if (item.tradeCount !== undefined && (!Number.isSafeInteger(item.tradeCount) || item.tradeCount < 0)) {
        throw new Error("tradeCount 값이 올바르지 않습니다.");
      }
      if (!Number.isSafeInteger(item.updatedAt) || item.updatedAt < 0) throw new Error("updatedAt 값이 올바르지 않습니다.");
      return [
        normalizedMarketCountry, normalizedSymbol, item.intervalMinutes, openTime, closeTime,
        date(item.sessionDate), normalizedSource, item.state,
        open, high, low, close, item.volume ?? 0,
        this.database.dialect === "postgres" ? item.volume !== undefined : item.volume === undefined ? 0 : 1,
        item.turnover, item.tradeCount, item.quality, item.updatedAt,
      ];
    });
    const batches: unknown[][][] = [];
    let batch: unknown[][] = [];
    let keys = new Set<string>();
    for (const values of normalized) {
      // PostgreSQL rejects an INSERT that affects the same conflict key twice.
      // Flush before a repeated revision so database priority semantics and the
      // original input order remain identical on every supported dialect.
      const key = `${values[0]}\0${values[1]}\0${values[2]}\0${values[3]}`;
      if (batch.length >= INTRADAY_BAR_UPSERT_BATCH_SIZE || keys.has(key)) {
        batches.push(batch);
        batch = [];
        keys = new Set();
      }
      batch.push(values);
      keys.add(key);
    }
    if (batch.length) batches.push(batch);

    const writeBatches = async (database: RelationalDatabase): Promise<void> => {
      for (const values of batches) {
        const placeholders = values
          .map(() => `(${Array.from({ length: INTRADAY_BAR_COLUMNS }, () => "?").join(", ")})`)
          .join(", ");
        const parameters = values.flat();
        if (database.dialect === "mysql") {
        // MySQL evaluates assignments left-to-right. Keep the fields used by the
        // priority predicate until last so every accepted value changes together.
          await database.run(`
          INSERT INTO portfolio_intraday_bars (
            market_country, symbol, interval_minutes, open_time, close_time, session_date, source_kind, bar_state,
            open_price, high_price, low_price, close_price, volume, volume_available, turnover, trade_count,
            quality_status, updated_at
          ) VALUES ${placeholders}
          ON DUPLICATE KEY UPDATE
            close_time = IF(${mysqlPreferred}, VALUES(close_time), close_time),
            session_date = IF(${mysqlPreferred}, VALUES(session_date), session_date),
            open_price = IF(${mysqlPreferred}, VALUES(open_price), open_price),
            high_price = IF(${mysqlPreferred}, VALUES(high_price), high_price),
            low_price = IF(${mysqlPreferred}, VALUES(low_price), low_price),
            close_price = IF(${mysqlPreferred}, VALUES(close_price), close_price),
            volume = IF(${mysqlPreferred}, IF(VALUES(volume_available), VALUES(volume), volume), volume),
            volume_available = IF(${mysqlPreferred}, GREATEST(VALUES(volume_available), volume_available), volume_available),
            turnover = IF(${mysqlPreferred}, COALESCE(VALUES(turnover), turnover), turnover),
            trade_count = IF(${mysqlPreferred}, COALESCE(VALUES(trade_count), trade_count), trade_count),
            updated_at = IF(${mysqlPreferred}, VALUES(updated_at), updated_at),
            source_kind = IF(${mysqlPreferred}, VALUES(source_kind), source_kind),
            quality_status = IF(${mysqlPreferred}, VALUES(quality_status), quality_status),
            bar_state = IF(${mysqlPreferred}, VALUES(bar_state), bar_state)
          `, parameters);
        } else {
          await database.run(`
          INSERT INTO portfolio_intraday_bars (
            market_country, symbol, interval_minutes, open_time, close_time, session_date, source_kind, bar_state,
            open_price, high_price, low_price, close_price, volume, volume_available, turnover, trade_count,
            quality_status, updated_at
          ) VALUES ${placeholders}
          ON CONFLICT(market_country, symbol, interval_minutes, open_time) DO UPDATE SET
            close_time = EXCLUDED.close_time,
            session_date = EXCLUDED.session_date,
            source_kind = EXCLUDED.source_kind,
            bar_state = EXCLUDED.bar_state,
            open_price = EXCLUDED.open_price,
            high_price = EXCLUDED.high_price,
            low_price = EXCLUDED.low_price,
            close_price = EXCLUDED.close_price,
            volume = CASE WHEN EXCLUDED.volume_available THEN EXCLUDED.volume ELSE portfolio_intraday_bars.volume END,
            volume_available = CASE WHEN EXCLUDED.volume_available THEN EXCLUDED.volume_available
              ELSE portfolio_intraday_bars.volume_available END,
            turnover = COALESCE(EXCLUDED.turnover, portfolio_intraday_bars.turnover),
            trade_count = COALESCE(EXCLUDED.trade_count, portfolio_intraday_bars.trade_count),
            quality_status = EXCLUDED.quality_status,
            updated_at = EXCLUDED.updated_at
          WHERE ${conflictPreferred}
          `, parameters);
        }
      }
    };
    if (batches.length === 1) {
      await writeBatches(this.database);
      return;
    }
    await this.database.transaction(writeBatches);
  }

  async listBars(input: {
    marketCountry?: MarketCountry;
    symbol: string;
    intervalMinutes: ScalpingInterval;
    from?: string;
    to?: string;
    includeForming?: boolean;
    limit?: number;
  }): Promise<IntradayBarRecord[]>;
  async listBars(input: {
    marketCountry: "BINANCE_USDM";
    symbol: string;
    intervalMinutes: ScalpingInterval;
    from?: string;
    to?: string;
    includeForming?: boolean;
    limit?: number;
  }): Promise<StoredIntradayBarRecord[]>;
  async listBars(input: {
    marketCountry?: MarketStorageKey;
    symbol: string;
    intervalMinutes: ScalpingInterval;
    from?: string;
    to?: string;
    includeForming?: boolean;
    limit?: number;
  }): Promise<StoredIntradayBarRecord[]> {
    const conditions = ["market_country = ?", "symbol = ?", "interval_minutes = ?"];
    const parameters: unknown[] = [marketCountry(input.marketCountry), symbol(input.symbol), input.intervalMinutes];
    if (input.from) {
      conditions.push("open_time >= ?");
      parameters.push(isoTimestamp(input.from, "from"));
    }
    if (input.to) {
      conditions.push("open_time <= ?");
      parameters.push(isoTimestamp(input.to, "to"));
    }
    if (!input.includeForming) conditions.push("bar_state = 'final'");
    const limit = Math.max(1, Math.min(50_000, Math.trunc(input.limit ?? 500)));
    const rows = await this.database.query<IntradayBarRow>(`
      SELECT * FROM portfolio_intraday_bars
      WHERE ${conditions.join(" AND ")}
      ORDER BY open_time DESC
      LIMIT ${limit}
    `, parameters);
    return rows.reverse().map(barFromRow);
  }

  async putTrades(input: readonly ScalpingTradeRecord[]): Promise<void> {
    if (input.length > RAW_MARKET_DATA_INPUT_LIMIT) {
      throw new Error("한 번에 저장할 체결은 100,000개 이하여야 합니다.");
    }
    if (!input.length) return;
    const rows = input.map((item) => {
      const normalizedMarketCountry = marketCountry(item.marketCountry);
      const normalizedVenue = venue(item.venue);
      const normalizedProvider = provider(item.provider);
      const normalizedExchange = exchange(item.exchange);
      const normalizedSessionFeed = sessionFeed(item.sessionFeed);
      validateMarketSource(normalizedMarketCountry, normalizedProvider, normalizedVenue);
      if (normalizedMarketCountry !== "US" && (normalizedExchange || normalizedSessionFeed)) {
        throw new Error("exchange와 sessionFeed는 미국 시장 체결에만 사용할 수 있습니다.");
      }
      const price = finite(item.price, "price", 0, false);
      const quantity = finite(item.quantity, "quantity", 0, false);
      const tradingAmount = item.tradingAmount === undefined
        ? null
        : finite(item.tradingAmount, "tradingAmount", 0);
      const cumulativeVolume = item.cumulativeVolume === undefined
        ? null
        : finite(item.cumulativeVolume, "cumulativeVolume", 0);
      const cumulativeAmount = item.cumulativeAmount === undefined
        ? null
        : finite(item.cumulativeAmount, "cumulativeAmount", 0);
      const strength = item.executionStrength === undefined
        ? null
        : finite(item.executionStrength, "executionStrength", 0);
      const bestBidPrice = item.bestBidPrice === undefined
        ? null
        : finite(item.bestBidPrice, "bestBidPrice", 0);
      const bestAskPrice = item.bestAskPrice === undefined
        ? null
        : finite(item.bestAskPrice, "bestAskPrice", 0);
      return [
        normalizedMarketCountry,
        symbol(item.symbol),
        eventId(item.eventId),
        normalizedProvider,
        normalizedVenue,
        normalizedExchange ?? null,
        normalizedSessionFeed ?? null,
        date(item.sessionDate),
        isoTimestamp(item.executedAt, "executedAt"),
        isoTimestamp(item.receivedAt, "receivedAt"),
        price,
        quantity,
        tradingAmount,
        tradeSide(item.side),
        cumulativeVolume,
        cumulativeAmount,
        strength,
        executionClass(item.executionClass) ?? null,
        bestBidPrice,
        bestAskPrice,
        recordedAt(item.recordedAt),
      ];
    });
    await insertAppendOnlyRows(this.database, {
      table: "portfolio_scalping_trades",
      columns: [
        "market_country", "symbol", "event_id", "provider", "venue", "exchange_code",
        "session_feed", "session_date", "executed_at", "received_at", "price", "quantity",
        "trading_amount", "side", "cumulative_volume", "cumulative_amount", "execution_strength",
        "execution_class", "best_bid_price", "best_ask_price", "recorded_at",
      ],
      conflictColumns: ["market_country", "symbol", "event_id"],
      columnCount: SCALPING_TRADE_COLUMNS,
      rows,
    });
  }

  async listTrades(input: {
    marketCountry?: MarketStorageKey;
    symbol: string;
    sessionDate?: string;
    from?: string;
    to?: string;
    limit?: number;
  }): Promise<ScalpingTradeRecord[]> {
    const conditions = ["market_country = ?", "symbol = ?"];
    const parameters: unknown[] = [marketCountry(input.marketCountry), symbol(input.symbol)];
    if (input.sessionDate) {
      conditions.push("session_date = ?");
      parameters.push(date(input.sessionDate));
    }
    const from = input.from ? isoTimestamp(input.from, "from") : undefined;
    const to = input.to ? isoTimestamp(input.to, "to") : undefined;
    if (from && to && from > to) throw new Error("to는 from보다 빠를 수 없습니다.");
    if (from) {
      conditions.push("executed_at >= ?");
      parameters.push(from);
    }
    if (to) {
      conditions.push("executed_at <= ?");
      parameters.push(to);
    }
    const limit = queryLimit(input.limit);
    const rows = await this.database.query<ScalpingTradeRow>(`
      SELECT * FROM portfolio_scalping_trades
      WHERE ${conditions.join(" AND ")}
      ORDER BY executed_at DESC, received_at DESC, recorded_at DESC, event_id DESC
      LIMIT ${limit}
    `, parameters);
    return rows.reverse().map(tradeFromRow);
  }

  async putOrderbooks(input: readonly ScalpingOrderbookRecord[]): Promise<void> {
    if (input.length > RAW_MARKET_DATA_INPUT_LIMIT) {
      throw new Error("한 번에 저장할 호가 스냅샷은 100,000개 이하여야 합니다.");
    }
    if (!input.length) return;
    const rows = input.map((item) => {
      const normalizedMarketCountry = marketCountry(item.marketCountry);
      const normalizedVenue = venue(item.venue);
      const normalizedProvider = provider(item.provider);
      const normalizedExchange = exchange(item.exchange);
      const normalizedSessionFeed = sessionFeed(item.sessionFeed);
      validateMarketSource(normalizedMarketCountry, normalizedProvider, normalizedVenue);
      if (normalizedMarketCountry !== "US" && (normalizedExchange || normalizedSessionFeed)) {
        throw new Error("exchange와 sessionFeed는 미국 시장 호가에만 사용할 수 있습니다.");
      }
      if (item.depth !== "top_of_book" && item.depth !== "ten_level") {
        throw new Error("depth 식별자가 올바르지 않습니다.");
      }
      const asks = orderbookLevels(item.asks, "asks");
      const bids = orderbookLevels(item.bids, "bids");
      const bestAskPrice = finite(item.bestAskPrice, "bestAskPrice", 0, false);
      const bestAskQuantity = finite(item.bestAskQuantity, "bestAskQuantity", 0);
      const bestBidPrice = finite(item.bestBidPrice, "bestBidPrice", 0, false);
      const bestBidQuantity = finite(item.bestBidQuantity, "bestBidQuantity", 0);
      if (bestAskPrice !== asks[0]!.price || bestAskQuantity !== asks[0]!.quantity
        || bestBidPrice !== bids[0]!.price || bestBidQuantity !== bids[0]!.quantity) {
        throw new Error("최우선 호가 컬럼은 asks/bids의 첫 단계와 일치해야 합니다.");
      }
      const totalAskQuantity = item.totalAskQuantity === undefined
        ? null
        : finite(item.totalAskQuantity, "totalAskQuantity", 0);
      const totalBidQuantity = item.totalBidQuantity === undefined
        ? null
        : finite(item.totalBidQuantity, "totalBidQuantity", 0);
      return [
        snapshotId(item.snapshotId),
        normalizedMarketCountry,
        symbol(item.symbol),
        normalizedProvider,
        normalizedVenue,
        normalizedExchange ?? null,
        normalizedSessionFeed ?? null,
        date(item.sessionDate),
        isoTimestamp(item.observedAt, "observedAt"),
        isoTimestamp(item.receivedAt, "receivedAt"),
        item.depth,
        canonicalJson(asks),
        canonicalJson(bids),
        totalAskQuantity,
        totalBidQuantity,
        bestAskPrice,
        bestAskQuantity,
        bestBidPrice,
        bestBidQuantity,
        recordedAt(item.recordedAt),
      ];
    });
    await insertAppendOnlyRows(this.database, {
      table: "portfolio_scalping_orderbooks",
      columns: [
        "snapshot_id", "market_country", "symbol", "provider", "venue", "exchange_code",
        "session_feed", "session_date", "observed_at", "received_at", "depth", "asks_json",
        "bids_json", "total_ask_quantity", "total_bid_quantity", "best_ask_price",
        "best_ask_quantity", "best_bid_price", "best_bid_quantity", "recorded_at",
      ],
      conflictColumns: ["snapshot_id"],
      columnCount: SCALPING_ORDERBOOK_COLUMNS,
      rows,
    });
  }

  async listOrderbooks(input: {
    marketCountry?: MarketStorageKey;
    symbol: string;
    sessionDate?: string;
    from?: string;
    to?: string;
    limit?: number;
  }): Promise<ScalpingOrderbookRecord[]> {
    const conditions = ["market_country = ?", "symbol = ?"];
    const parameters: unknown[] = [marketCountry(input.marketCountry), symbol(input.symbol)];
    if (input.sessionDate) {
      conditions.push("session_date = ?");
      parameters.push(date(input.sessionDate));
    }
    const from = input.from ? isoTimestamp(input.from, "from") : undefined;
    const to = input.to ? isoTimestamp(input.to, "to") : undefined;
    if (from && to && from > to) throw new Error("to는 from보다 빠를 수 없습니다.");
    if (from) {
      conditions.push("observed_at >= ?");
      parameters.push(from);
    }
    if (to) {
      conditions.push("observed_at <= ?");
      parameters.push(to);
    }
    const limit = queryLimit(input.limit);
    const rows = await this.database.query<ScalpingOrderbookRow>(`
      SELECT * FROM portfolio_scalping_orderbooks
      WHERE ${conditions.join(" AND ")}
      ORDER BY observed_at DESC, received_at DESC, recorded_at DESC, snapshot_id DESC
      LIMIT ${limit}
    `, parameters);
    return rows.reverse().map(orderbookFromRow);
  }

  async putRecordingEvents(input: readonly ScalpingRecordingEventRecord[]): Promise<void> {
    if (input.length > RAW_MARKET_DATA_INPUT_LIMIT) {
      throw new Error("한 번에 저장할 recording event는 100,000개 이하여야 합니다.");
    }
    if (!input.length) return;
    const rows = input.map((item) => [
      uuid(item.eventId, "eventId"),
      marketCountry(item.marketCountry),
      item.symbol === undefined ? null : symbol(item.symbol),
      recordingEventType(item.eventType),
      isoTimestamp(item.occurredAt, "occurredAt"),
      recordingEventCode(item.code) ?? null,
      item.details === undefined ? null : recordingEventDetails(item.details),
      recordedAt(item.recordedAt),
    ]);
    await insertAppendOnlyRows(this.database, {
      table: "portfolio_scalping_recording_events",
      columns: [
        "event_id", "market_country", "symbol", "event_type",
        "occurred_at", "code", "details_json", "recorded_at",
      ],
      conflictColumns: ["event_id"],
      columnCount: SCALPING_RECORDING_EVENT_COLUMNS,
      rows,
    });
  }

  async listRecordingEvents(input: {
    marketCountry?: MarketStorageKey;
    symbol?: string | null;
    eventTypes?: readonly ScalpingRecordingEventType[];
    from?: string;
    to?: string;
    limit?: number;
  }): Promise<ScalpingRecordingEventRecord[]> {
    const conditions = ["market_country = ?"];
    const parameters: unknown[] = [marketCountry(input.marketCountry)];
    if (input.symbol === null) {
      conditions.push("symbol IS NULL");
    } else if (input.symbol !== undefined) {
      conditions.push("symbol = ?");
      parameters.push(symbol(input.symbol));
    }
    if (input.eventTypes) {
      const types = Array.from(new Set(input.eventTypes.map(recordingEventType)));
      if (!types.length) return [];
      if (types.length > SCALPING_RECORDING_EVENT_TYPES.length) {
        throw new Error("조회할 recording event type이 너무 많습니다.");
      }
      conditions.push(`event_type IN (${types.map(() => "?").join(", ")})`);
      parameters.push(...types);
    }
    const from = input.from ? isoTimestamp(input.from, "from") : undefined;
    const to = input.to ? isoTimestamp(input.to, "to") : undefined;
    if (from && to && from > to) throw new Error("to는 from보다 빠를 수 없습니다.");
    if (from) {
      conditions.push("occurred_at >= ?");
      parameters.push(from);
    }
    if (to) {
      conditions.push("occurred_at <= ?");
      parameters.push(to);
    }
    const limit = queryLimit(input.limit);
    const rows = await this.database.query<ScalpingRecordingEventRow>(`
      SELECT * FROM portfolio_scalping_recording_events
      WHERE ${conditions.join(" AND ")}
      ORDER BY occurred_at DESC, recorded_at DESC, event_id DESC
      LIMIT ${limit}
    `, parameters);
    return rows.reverse().map(recordingEventFromRow);
  }

  async putPrediction(input: Omit<ScalpingPredictionRecord, "id" | "createdAt"> & {
    id?: string;
    createdAt?: number;
  }): Promise<ScalpingPredictionRecord> {
    const id = input.id ?? randomUUID();
    if (!/^[A-Za-z0-9-]{1,64}$/.test(id)) throw new Error("prediction id 형식이 올바르지 않습니다.");
    const normalizedSymbol = symbol(input.symbol);
    const normalizedMarketCountry = marketCountry(input.marketCountry);
    const modelName = input.modelName.trim();
    const modelVersion = input.modelVersion.trim();
    if (!modelName || modelName.length > 128 || !modelVersion || modelVersion.length > 128) {
      throw new Error("예측 모델 이름과 버전은 각각 1~128자여야 합니다.");
    }
    const inputEndedAt = isoTimestamp(input.inputEndedAt, "inputEndedAt");
    const generatedAt = isoTimestamp(input.generatedAt, "generatedAt");
    if (inputEndedAt > generatedAt) throw new Error("예측 생성 시각은 입력 종료 시각보다 빠를 수 없습니다.");
    const createdAt = input.createdAt ?? Date.now();
    if (!Number.isSafeInteger(createdAt) || createdAt < 0) throw new Error("createdAt 값이 올바르지 않습니다.");
    const payload = canonicalJson(input.payload);
    await this.database.run(`
      INSERT INTO portfolio_scalping_predictions (
        prediction_id, market_country, symbol, model_name, model_version, input_ended_at, generated_at,
        status, data_quality, retrospective, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      id, normalizedMarketCountry, normalizedSymbol, modelName, modelVersion, inputEndedAt, generatedAt,
      input.status, input.dataQuality,
      this.database.dialect === "postgres" ? input.retrospective : input.retrospective ? 1 : 0,
      payload, createdAt,
    ]);
    const stored = await this.getPrediction(id);
    if (!stored) throw new Error("단타 예측을 저장하지 못했습니다.");
    return stored;
  }

  async getPrediction(id: string): Promise<ScalpingPredictionRecord | undefined> {
    const [row] = await this.database.query<PredictionRow>(
      "SELECT * FROM portfolio_scalping_predictions WHERE prediction_id = ?",
      [id],
    );
    return row ? predictionFromRow(row) : undefined;
  }

  async latestPredictions(
    symbols: readonly string[],
    retrospective = false,
    requestedMarketCountry: MarketStorageKey = "KR",
  ): Promise<ScalpingPredictionRecord[]> {
    const normalized = Array.from(new Set(symbols.map(symbol)));
    const normalizedMarketCountry = marketCountry(requestedMarketCountry);
    if (!normalized.length) return [];
    if (normalized.length > 50) throw new Error("예측 조회 종목은 50개 이하여야 합니다.");
    const rows = await this.database.query<PredictionRow>(`
      SELECT prediction.* FROM portfolio_scalping_predictions prediction
      WHERE prediction.market_country = ?
        AND prediction.symbol IN (${normalized.map(() => "?").join(", ")})
        AND prediction.retrospective = ?
        AND prediction.generated_at = (
          SELECT MAX(latest.generated_at)
          FROM portfolio_scalping_predictions latest
          WHERE latest.market_country = prediction.market_country
            AND latest.symbol = prediction.symbol AND latest.retrospective = prediction.retrospective
        )
      ORDER BY prediction.symbol ASC
    `, [
      normalizedMarketCountry,
      ...normalized,
      this.database.dialect === "postgres" ? retrospective : retrospective ? 1 : 0,
    ]);
    return rows.map(predictionFromRow);
  }
}
