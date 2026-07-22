import { randomUUID } from "node:crypto";
import type { RelationalDatabase } from "../database.js";
import { applyPortfolioMigrations } from "../migrations.js";
import { canonicalJson } from "../worker/contracts.js";
import type { MarketCountry } from "../scalping/contracts.js";

export const SCALPING_INTERVALS = [1, 5, 15, 30, 60] as const;
const INTRADAY_BAR_COLUMNS = 18;
// Keep every statement comfortably below PostgreSQL's 65,535 bind parameter
// ceiling as well as the lower limits used by some SQLite builds/proxies.
const INTRADAY_BAR_UPSERT_BATCH_SIZE = 500;
export type ScalpingInterval = typeof SCALPING_INTERVALS[number];
export type IntradayBarState = "forming" | "final";
export type IntradayBarSource = "kis_ws" | "kis_rest" | "toss_rest" | "recovered";
export type IntradayQuality = "complete" | "partial" | "recovered" | "stale";

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
  marketCountry?: MarketCountry;
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
  market_country: MarketCountry;
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
  market_country: MarketCountry;
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

function symbol(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9._-]{0,31}$/.test(normalized)) {
    throw new Error("단타 종목 코드는 영문 대문자, 숫자, '.', '_', '-' 조합의 1~32자여야 합니다.");
  }
  return normalized;
}

function marketCountry(value: MarketCountry | undefined): MarketCountry {
  const normalized = value ?? "KR";
  if (normalized !== "KR" && normalized !== "US") throw new Error("단타 시장은 KR 또는 US여야 합니다.");
  return normalized;
}

function isoTimestamp(value: string, field: string): string {
  if (value.length > 40 || !/^\d{4}-\d{2}-\d{2}T/.test(value)) {
    throw new Error(`${field}는 RFC3339 시각이어야 합니다.`);
  }
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) throw new Error(`${field}는 RFC3339 시각이어야 합니다.`);
  return timestamp.toISOString();
}

function date(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)
    || Number.isNaN(new Date(`${value}T00:00:00.000Z`).getTime())) {
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

function barFromRow(row: IntradayBarRow): IntradayBarRecord {
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

  async putBars(input: readonly IntradayBarRecord[]): Promise<void> {
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
        WHEN 'kis_ws' THEN 4 WHEN 'kis_rest' THEN 3 WHEN 'recovered' THEN 2 ELSE 1 END
        > CASE source_kind WHEN 'kis_ws' THEN 4 WHEN 'kis_rest' THEN 3 WHEN 'recovered' THEN 2 ELSE 1 END)
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
        WHEN 'kis_ws' THEN 4 WHEN 'kis_rest' THEN 3 WHEN 'recovered' THEN 2 ELSE 1 END
        > CASE portfolio_intraday_bars.source_kind
          WHEN 'kis_ws' THEN 4 WHEN 'kis_rest' THEN 3 WHEN 'recovered' THEN 2 ELSE 1 END)
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
        normalizedMarketCountry, normalizedSymbol, item.intervalMinutes, openTime, closeTime, date(item.sessionDate), item.source, item.state,
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
  }): Promise<IntradayBarRecord[]> {
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
    requestedMarketCountry: MarketCountry = "KR",
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
