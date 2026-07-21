type UnknownRecord = Record<string, unknown>;

export type KisEnvironment = "real" | "demo";
export type KisMarketSource = "KRX" | "NXT" | "INTEGRATED";
export type KisMarketDivisionCode = "J" | "NX" | "UN";
export type KisDataQuality = "available" | "partial" | "unavailable";

export type KisRestClientConfig = {
  appKey: string;
  appSecret: string;
  environment: KisEnvironment;
  requestIntervalMs: number;
  timeoutMs: number;
  maxAttempts: number;
  retryBaseMs: number;
  retryMaxMs: number;
};

export type KisRestDiagnostic = {
  index: number;
  code: "malformed-row" | "duplicate-row";
  fields: string[];
  message: string;
};

export type KisRestResult<T> = {
  items: T[];
  quality: KisDataQuality;
  diagnostics: KisRestDiagnostic[];
  providerTimestamp: string;
};

export type KisVolumeRankRequest = {
  market?: KisMarketDivisionCode;
  marketCode?: string;
  basisCode: "0" | "1" | "2" | "3" | "4";
  divisionCode?: string;
  targetClassCode?: string;
  exclusionCode?: string;
  minPrice?: number;
  maxPrice?: number;
  minVolume?: number;
  inputDate?: string;
};

export type KisVolumeRankItem = {
  symbol: string;
  name: string;
  rank: number;
  price: number;
  changeAmount: number;
  changeRate: number;
  accumulatedVolume: number;
  accumulatedTradingAmount: number;
  averageVolume?: number;
  volumeIncreaseRate?: number;
  volumeTurnoverRate?: number;
  tradingAmountTurnoverRate?: number;
};

export type KisFluctuationRankRequest = {
  market?: KisMarketDivisionCode;
  marketCode?: string;
  sortCode: string;
  priceClassCode?: string;
  divisionCode?: string;
  targetClassCode?: string;
  exclusionCode?: string;
  minPrice?: number;
  maxPrice?: number;
  minVolume?: number;
  minChangeRate?: number;
  maxChangeRate?: number;
};

export type KisFluctuationRankItem = {
  symbol: string;
  name: string;
  rank: number;
  price: number;
  changeAmount: number;
  changeRate: number;
  accumulatedVolume: number;
  accumulatedTradingAmount?: number;
  openPrice?: number;
  highPrice?: number;
  lowPrice?: number;
};

export type KisMinuteRequest = {
  symbol: string;
  sessionDate: string;
  inputTime: string;
  market?: KisMarketDivisionCode;
  includePrevious?: boolean;
};

export type KisMinuteBar = {
  symbol: string;
  sessionDate: string;
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  accumulatedVolume?: number;
  accumulatedTradingAmount?: number;
  status: "forming" | "final";
  source: "kis_rest_recovery";
};

export class KisRestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
    public readonly retryable: boolean,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "KisRestError";
  }
}

export class KisRestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KisRestValidationError";
  }
}

export type KisRestClientOptions = {
  fetchImpl?: typeof fetch;
  sleepImpl?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
};

const BASE_URLS: Record<KisEnvironment, string> = {
  real: "https://openapi.koreainvestment.com:9443",
  demo: "https://openapivts.koreainvestment.com:29443",
};
const TOKEN_PATH = "/oauth2/tokenP";
const VOLUME_RANK_PATH = "/uapi/domestic-stock/v1/quotations/volume-rank";
const FLUCTUATION_RANK_PATH = "/uapi/domestic-stock/v1/ranking/fluctuation";
const MINUTE_PATH = "/uapi/domestic-stock/v1/quotations/inquire-time-itemchartprice";
const VOLUME_RANK_TR_ID = "FHPST01710000";
const FLUCTUATION_RANK_TR_ID = "FHPST01700000";
const MINUTE_TR_ID = "FHKST03010200";
const MARKET_CODES = new Set<KisMarketDivisionCode>(["J", "NX", "UN"]);
const VOLUME_BASIS_CODES = new Set(["0", "1", "2", "3", "4"]);

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return "";
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const normalized = value.replace(/[,%\s]/g, "");
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized)) return undefined;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function optionalFiniteNumber(value: unknown): number | undefined {
  return stringValue(value) === "" ? undefined : finiteNumber(value);
}

function invalidOptionalNumber(value: unknown, parsed: number | undefined): boolean {
  return stringValue(value) !== "" && parsed === undefined;
}

function assertPositiveNumber(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new KisRestValidationError(`${name} must be a positive finite number.`);
  }
}

function assertNonEmpty(value: string, name: string): void {
  if (!value.trim()) throw new KisRestValidationError(`${name} must not be empty.`);
}

function isCompactDate(value: string): boolean {
  if (!/^\d{8}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

function isCompactTime(value: string): boolean {
  if (!/^\d{6}$/.test(value)) return false;
  const hour = Number(value.slice(0, 2));
  const minute = Number(value.slice(2, 4));
  const second = Number(value.slice(4, 6));
  return hour <= 23 && minute <= 59 && second <= 59;
}

function seoulCompactDate(timestamp: number): string {
  return new Date(timestamp + 9 * 60 * 60 * 1_000).toISOString().slice(0, 10).replaceAll("-", "");
}

function minuteTimestamp(date: string, time: string): string {
  return `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${time.slice(0, 2)}:${time.slice(2, 4)}:00+09:00`;
}

function marketSource(code: KisMarketDivisionCode): KisMarketSource {
  if (code === "NX") return "NXT";
  if (code === "UN") return "INTEGRATED";
  return "KRX";
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function resultQuality(itemCount: number, diagnostics: KisRestDiagnostic[]): KisDataQuality {
  if (diagnostics.length === 0) return "available";
  return itemCount > 0 ? "partial" : "unavailable";
}

function diagnostic(index: number, fields: string[], message: string): KisRestDiagnostic {
  return { index, code: "malformed-row", fields, message };
}

function retryAfterMilliseconds(response: Response, now: number): number | undefined {
  const raw = response.headers.get("retry-after")?.trim();
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const target = Date.parse(raw);
  if (!Number.isFinite(target)) return undefined;
  return Math.max(0, target - now);
}

export class KisRestClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (milliseconds: number) => Promise<void>;
  private readonly now: () => number;
  private readonly setTimeoutImpl: typeof setTimeout;
  private readonly clearTimeoutImpl: typeof clearTimeout;
  private token?: { value: string; expiresAt: number };
  private tokenInFlight?: Promise<string>;
  private nextRequestAt = 0;
  private pacingTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly config: KisRestClientConfig,
    options: KisRestClientOptions = {},
  ) {
    if (config.environment !== "real" && config.environment !== "demo") {
      throw new KisRestValidationError("environment must be real or demo.");
    }
    assertNonEmpty(config.appKey, "appKey");
    assertNonEmpty(config.appSecret, "appSecret");
    assertPositiveNumber(config.requestIntervalMs, "requestIntervalMs");
    assertPositiveNumber(config.timeoutMs, "timeoutMs");
    if (!Number.isInteger(config.maxAttempts) || config.maxAttempts < 1) {
      throw new KisRestValidationError("maxAttempts must be an integer greater than or equal to 1.");
    }
    assertPositiveNumber(config.retryBaseMs, "retryBaseMs");
    assertPositiveNumber(config.retryMaxMs, "retryMaxMs");
    if (config.retryMaxMs < config.retryBaseMs) {
      throw new KisRestValidationError("retryMaxMs must be greater than or equal to retryBaseMs.");
    }
    this.baseUrl = BASE_URLS[config.environment];
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleepImpl = options.sleepImpl ?? defaultSleep;
    this.now = options.now ?? Date.now;
    this.setTimeoutImpl = options.setTimeoutImpl ?? setTimeout;
    this.clearTimeoutImpl = options.clearTimeoutImpl ?? clearTimeout;
  }

  private async parseResponse(response: Response): Promise<UnknownRecord> {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new KisRestError(
        "KIS returned invalid JSON.",
        response.status,
        "invalid-response",
        response.status === 429 || response.status >= 500,
        retryAfterMilliseconds(response, this.now()),
      );
    }
    if (!isRecord(body)) {
      throw new KisRestError("KIS returned an invalid response object.", response.status, "invalid-response", false);
    }
    const code = stringValue(body.msg_cd) || stringValue(body.error_code) || `http-${response.status}`;
    const failed = !response.ok || (body.rt_cd !== undefined && stringValue(body.rt_cd) !== "0");
    if (failed) {
      const message = this.redact(stringValue(body.msg1) || stringValue(body.error_description) || "KIS request failed.");
      throw new KisRestError(
        message,
        response.status,
        code,
        response.status === 401 || response.status === 429 || response.status >= 500 || code === "EGW00201",
        retryAfterMilliseconds(response, this.now()),
      );
    }
    return body;
  }

  private async fetchWithTimeout(url: string | URL, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = this.setTimeoutImpl(() => controller.abort(), this.config.timeoutMs);
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "AbortError";
      throw new KisRestError(
        timedOut ? "KIS request timed out." : "KIS network request failed.",
        0,
        timedOut ? "timeout" : "network-error",
        true,
      );
    } finally {
      this.clearTimeoutImpl(timeout);
    }
  }

  private retryDelay(error: KisRestError, attemptIndex: number): number {
    if (error.retryAfterMs !== undefined) return Math.min(this.config.retryMaxMs, error.retryAfterMs);
    return Math.min(this.config.retryMaxMs, this.config.retryBaseMs * 2 ** attemptIndex);
  }

  private async issueAccessToken(): Promise<string> {
    for (let attempt = 0; attempt < this.config.maxAttempts; attempt += 1) {
      try {
        await this.pace();
        const response = await this.fetchWithTimeout(`${this.baseUrl}${TOKEN_PATH}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            grant_type: "client_credentials",
            appkey: this.config.appKey,
            appsecret: this.config.appSecret,
          }),
        });
        const body = await this.parseResponse(response);
        const value = stringValue(body.access_token);
        if (!value) throw new KisRestError("KIS access token is empty.", response.status, "invalid-token", false);
        const expiresInSeconds = finiteNumber(body.expires_in);
        const lifetimeMs = expiresInSeconds !== undefined && expiresInSeconds > 0
          ? expiresInSeconds * 1_000
          : 23 * 60 * 60 * 1_000;
        const marginMs = Math.min(60_000, lifetimeMs / 10);
        this.token = {
          value,
          expiresAt: this.now() + Math.max(1_000, lifetimeMs - marginMs),
        };
        return value;
      } catch (error) {
        const normalized = error instanceof KisRestError
          ? error
          : new KisRestError("KIS token request failed.", 0, "network-error", true);
        if (!normalized.retryable || attempt + 1 >= this.config.maxAttempts) throw normalized;
        await this.sleepImpl(this.retryDelay(normalized, attempt));
      }
    }
    throw new KisRestError("KIS token request failed.", 0, "token-failed", false);
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > this.now()) return this.token.value;
    if (this.tokenInFlight) return this.tokenInFlight;
    const task = this.issueAccessToken();
    this.tokenInFlight = task;
    try {
      return await task;
    } finally {
      if (this.tokenInFlight === task) this.tokenInFlight = undefined;
    }
  }

  private async pace(): Promise<void> {
    const previous = this.pacingTail;
    let release!: () => void;
    this.pacingTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const waitMs = this.nextRequestAt - this.now();
      if (waitMs > 0) await this.sleepImpl(waitMs);
      this.nextRequestAt = this.now() + this.config.requestIntervalMs;
    } finally {
      release();
    }
  }

  private async request(path: string, trId: string, params: URLSearchParams): Promise<UnknownRecord> {
    for (let attempt = 0; attempt < this.config.maxAttempts; attempt += 1) {
      try {
        const token = await this.accessToken();
        await this.pace();
        const url = new URL(`${this.baseUrl}${path}`);
        url.search = params.toString();
        const response = await this.fetchWithTimeout(url, {
          headers: {
            authorization: `Bearer ${token}`,
            appkey: this.config.appKey,
            appsecret: this.config.appSecret,
            tr_id: trId,
            custtype: "P",
          },
        });
        return await this.parseResponse(response);
      } catch (error) {
        const normalized = error instanceof KisRestError
          ? error
          : new KisRestError("KIS request failed.", 0, "network-error", true);
        if (normalized.status === 401) this.token = undefined;
        if (!normalized.retryable || attempt + 1 >= this.config.maxAttempts) throw normalized;
        await this.sleepImpl(this.retryDelay(normalized, attempt));
      }
    }
    throw new KisRestError("KIS request failed.", 0, "request-failed", false);
  }

  private outputRows(body: UnknownRecord, field = "output"): unknown[] {
    const output = body[field];
    if (!Array.isArray(output)) {
      throw new KisRestError(`KIS response field ${field} is not an array.`, 200, "invalid-response", false);
    }
    return output;
  }

  async getVolumeRanking(request: KisVolumeRankRequest): Promise<KisRestResult<KisVolumeRankItem>> {
    this.validateRankRequest(request.market, request.marketCode, request.minPrice, request.maxPrice, request.minVolume);
    if (!VOLUME_BASIS_CODES.has(request.basisCode)) {
      throw new KisRestValidationError("basisCode must be one of 0, 1, 2, 3, or 4.");
    }
    if (request.inputDate !== undefined && !isCompactDate(request.inputDate)) {
      throw new KisRestValidationError("inputDate must be a valid YYYYMMDD date.");
    }
    const params = new URLSearchParams({
      FID_COND_MRKT_DIV_CODE: request.market ?? "J",
      FID_COND_SCR_DIV_CODE: "20171",
      FID_INPUT_ISCD: request.marketCode ?? "0000",
      FID_DIV_CLS_CODE: request.divisionCode ?? "0",
      FID_BLNG_CLS_CODE: request.basisCode,
      FID_TRGT_CLS_CODE: request.targetClassCode ?? "111111111",
      FID_TRGT_EXLS_CLS_CODE: request.exclusionCode ?? "0000000000",
      FID_INPUT_PRICE_1: request.minPrice === undefined ? "" : String(request.minPrice),
      FID_INPUT_PRICE_2: request.maxPrice === undefined ? "" : String(request.maxPrice),
      FID_VOL_CNT: request.minVolume === undefined ? "" : String(request.minVolume),
      FID_INPUT_DATE_1: request.inputDate ?? "",
    });
    const body = await this.request(VOLUME_RANK_PATH, VOLUME_RANK_TR_ID, params);
    const diagnostics: KisRestDiagnostic[] = [];
    const items: KisVolumeRankItem[] = [];
    this.outputRows(body).forEach((value, index) => {
      if (!isRecord(value)) {
        diagnostics.push(diagnostic(index, ["row"], "KIS volume ranking row was not an object."));
        return;
      }
      const row = value;
      const symbol = stringValue(row.mksc_shrn_iscd) || stringValue(row.stck_shrn_iscd);
      const name = stringValue(row.hts_kor_isnm);
      const rank = finiteNumber(row.data_rank);
      const price = finiteNumber(row.stck_prpr);
      const changeAmount = finiteNumber(row.prdy_vrss);
      const changeRate = finiteNumber(row.prdy_ctrt);
      const accumulatedVolume = finiteNumber(row.acml_vol);
      const accumulatedTradingAmount = finiteNumber(row.acml_tr_pbmn);
      const invalid = [
        !symbol ? "symbol" : "",
        !name ? "name" : "",
        rank === undefined || !Number.isInteger(rank) || rank < 1 ? "rank" : "",
        price === undefined || price <= 0 ? "price" : "",
        changeAmount === undefined ? "changeAmount" : "",
        changeRate === undefined ? "changeRate" : "",
        accumulatedVolume === undefined || accumulatedVolume < 0 ? "accumulatedVolume" : "",
        accumulatedTradingAmount === undefined || accumulatedTradingAmount < 0 ? "accumulatedTradingAmount" : "",
      ].filter(Boolean);
      if (invalid.length > 0 || rank === undefined || price === undefined || changeAmount === undefined
        || changeRate === undefined || accumulatedVolume === undefined || accumulatedTradingAmount === undefined) {
        diagnostics.push(diagnostic(index, invalid, "KIS volume ranking row was excluded because required fields are invalid."));
        return;
      }
      const averageVolume = optionalFiniteNumber(row.avrg_vol);
      const volumeIncreaseRate = optionalFiniteNumber(row.vol_inrt);
      const volumeTurnoverRate = optionalFiniteNumber(row.vol_tnrt);
      const tradingAmountTurnoverRate = optionalFiniteNumber(row.tr_pbmn_tnrt);
      const invalidOptional = [
        invalidOptionalNumber(row.avrg_vol, averageVolume) || (averageVolume !== undefined && averageVolume < 0)
          ? "averageVolume" : "",
        invalidOptionalNumber(row.vol_inrt, volumeIncreaseRate) ? "volumeIncreaseRate" : "",
        invalidOptionalNumber(row.vol_tnrt, volumeTurnoverRate)
          || (volumeTurnoverRate !== undefined && volumeTurnoverRate < 0) ? "volumeTurnoverRate" : "",
        invalidOptionalNumber(row.tr_pbmn_tnrt, tradingAmountTurnoverRate)
          || (tradingAmountTurnoverRate !== undefined && tradingAmountTurnoverRate < 0)
          ? "tradingAmountTurnoverRate" : "",
      ].filter(Boolean);
      if (invalidOptional.length > 0) {
        diagnostics.push(diagnostic(index, invalidOptional, "KIS volume ranking row was excluded because optional fields are invalid."));
        return;
      }
      items.push({
        symbol,
        name,
        rank,
        price,
        changeAmount,
        changeRate,
        accumulatedVolume,
        accumulatedTradingAmount,
        ...(averageVolume === undefined ? {} : { averageVolume }),
        ...(volumeIncreaseRate === undefined ? {} : { volumeIncreaseRate }),
        ...(volumeTurnoverRate === undefined ? {} : { volumeTurnoverRate }),
        ...(tradingAmountTurnoverRate === undefined ? {} : { tradingAmountTurnoverRate }),
      });
    });
    return {
      items,
      quality: resultQuality(items.length, diagnostics),
      diagnostics,
      providerTimestamp: new Date(this.now()).toISOString(),
    };
  }

  async getFluctuationRanking(request: KisFluctuationRankRequest): Promise<KisRestResult<KisFluctuationRankItem>> {
    this.validateRankRequest(request.market, request.marketCode, request.minPrice, request.maxPrice, request.minVolume);
    if (!/^\d{1,4}$/.test(request.sortCode)) {
      throw new KisRestValidationError("sortCode must be a numeric provider code.");
    }
    for (const [name, value] of [["minChangeRate", request.minChangeRate], ["maxChangeRate", request.maxChangeRate]] as const) {
      if (value !== undefined && !Number.isFinite(value)) throw new KisRestValidationError(`${name} must be finite.`);
    }
    if (request.minChangeRate !== undefined && request.maxChangeRate !== undefined
      && request.minChangeRate > request.maxChangeRate) {
      throw new KisRestValidationError("minChangeRate must not exceed maxChangeRate.");
    }
    const params = new URLSearchParams({
      FID_COND_MRKT_DIV_CODE: request.market ?? "J",
      FID_COND_SCR_DIV_CODE: "20170",
      FID_INPUT_ISCD: request.marketCode ?? "0000",
      FID_RANK_SORT_CLS_CODE: request.sortCode,
      FID_INPUT_CNT_1: "0",
      FID_PRC_CLS_CODE: request.priceClassCode ?? "0",
      FID_INPUT_PRICE_1: request.minPrice === undefined ? "" : String(request.minPrice),
      FID_INPUT_PRICE_2: request.maxPrice === undefined ? "" : String(request.maxPrice),
      FID_VOL_CNT: request.minVolume === undefined ? "" : String(request.minVolume),
      FID_TRGT_CLS_CODE: request.targetClassCode ?? "0",
      FID_TRGT_EXLS_CLS_CODE: request.exclusionCode ?? "0",
      FID_DIV_CLS_CODE: request.divisionCode ?? "0",
      FID_RSFL_RATE1: request.minChangeRate === undefined ? "" : String(request.minChangeRate),
      FID_RSFL_RATE2: request.maxChangeRate === undefined ? "" : String(request.maxChangeRate),
    });
    const body = await this.request(FLUCTUATION_RANK_PATH, FLUCTUATION_RANK_TR_ID, params);
    const diagnostics: KisRestDiagnostic[] = [];
    const items: KisFluctuationRankItem[] = [];
    this.outputRows(body).forEach((value, index) => {
      if (!isRecord(value)) {
        diagnostics.push(diagnostic(index, ["row"], "KIS fluctuation ranking row was not an object."));
        return;
      }
      const row = value;
      const symbol = stringValue(row.stck_shrn_iscd) || stringValue(row.mksc_shrn_iscd);
      const name = stringValue(row.hts_kor_isnm);
      const rank = finiteNumber(row.data_rank);
      const price = finiteNumber(row.stck_prpr);
      const changeAmount = finiteNumber(row.prdy_vrss);
      const changeRate = finiteNumber(row.prdy_ctrt);
      const accumulatedVolume = finiteNumber(row.acml_vol);
      const accumulatedTradingAmount = optionalFiniteNumber(row.acml_tr_pbmn);
      const invalid = [
        !symbol ? "symbol" : "",
        !name ? "name" : "",
        rank === undefined || !Number.isInteger(rank) || rank < 1 ? "rank" : "",
        price === undefined || price <= 0 ? "price" : "",
        changeAmount === undefined ? "changeAmount" : "",
        changeRate === undefined ? "changeRate" : "",
        accumulatedVolume === undefined || accumulatedVolume < 0 ? "accumulatedVolume" : "",
        accumulatedTradingAmount !== undefined && accumulatedTradingAmount < 0 ? "accumulatedTradingAmount" : "",
      ].filter(Boolean);
      if (invalid.length > 0 || rank === undefined || price === undefined || changeAmount === undefined
        || changeRate === undefined || accumulatedVolume === undefined) {
        diagnostics.push(diagnostic(index, invalid, "KIS fluctuation ranking row was excluded because required fields are invalid."));
        return;
      }
      const openPrice = optionalFiniteNumber(row.stck_oprc);
      const highPrice = optionalFiniteNumber(row.stck_hgpr);
      const lowPrice = optionalFiniteNumber(row.stck_lwpr);
      const invalidOptional = [
        invalidOptionalNumber(row.acml_tr_pbmn, accumulatedTradingAmount) ? "accumulatedTradingAmount" : "",
        invalidOptionalNumber(row.stck_oprc, openPrice) || (openPrice !== undefined && openPrice <= 0) ? "openPrice" : "",
        invalidOptionalNumber(row.stck_hgpr, highPrice) || (highPrice !== undefined && highPrice <= 0) ? "highPrice" : "",
        invalidOptionalNumber(row.stck_lwpr, lowPrice) || (lowPrice !== undefined && lowPrice <= 0) ? "lowPrice" : "",
      ].filter(Boolean);
      if (invalidOptional.length > 0) {
        diagnostics.push(diagnostic(index, invalidOptional, "KIS fluctuation ranking row was excluded because optional fields are invalid."));
        return;
      }
      items.push({
        symbol,
        name,
        rank,
        price,
        changeAmount,
        changeRate,
        accumulatedVolume,
        ...(accumulatedTradingAmount === undefined ? {} : { accumulatedTradingAmount }),
        ...(openPrice === undefined ? {} : { openPrice }),
        ...(highPrice === undefined ? {} : { highPrice }),
        ...(lowPrice === undefined ? {} : { lowPrice }),
      });
    });
    return {
      items,
      quality: resultQuality(items.length, diagnostics),
      diagnostics,
      providerTimestamp: new Date(this.now()).toISOString(),
    };
  }

  async getCurrentDayMinutes(request: KisMinuteRequest): Promise<KisRestResult<KisMinuteBar>> {
    if (!/^[A-Za-z0-9]{1,12}$/.test(request.symbol)) {
      throw new KisRestValidationError("symbol must contain 1 to 12 ASCII letters or digits.");
    }
    if (!isCompactDate(request.sessionDate)) {
      throw new KisRestValidationError("sessionDate must be a valid YYYYMMDD date.");
    }
    if (!isCompactTime(request.inputTime)) {
      throw new KisRestValidationError("inputTime must be a valid HHMMSS time.");
    }
    if (request.market !== undefined && !MARKET_CODES.has(request.market)) {
      throw new KisRestValidationError("market must be J, NX, or UN.");
    }
    if (request.sessionDate !== seoulCompactDate(this.now())) {
      throw new KisRestValidationError("KIS minute recovery only supports the current Seoul trading date.");
    }
    const market = request.market ?? "J";
    const params = new URLSearchParams({
      FID_ETC_CLS_CODE: "",
      FID_COND_MRKT_DIV_CODE: market,
      FID_INPUT_ISCD: request.symbol,
      FID_INPUT_HOUR_1: request.inputTime,
      FID_PW_DATA_INCU_YN: request.includePrevious ? "Y" : "N",
    });
    const body = await this.request(MINUTE_PATH, MINUTE_TR_ID, params);
    const diagnostics: KisRestDiagnostic[] = [];
    const byTimestamp = new Map<string, KisMinuteBar>();
    const nowMinute = Math.floor(this.now() / 60_000) * 60_000;
    this.outputRows(body, "output2").forEach((value, index) => {
      if (!isRecord(value)) {
        diagnostics.push(diagnostic(index, ["row"], "KIS minute row was not an object."));
        return;
      }
      const row = value;
      const date = stringValue(row.stck_bsop_date);
      const time = stringValue(row.stck_cntg_hour);
      const close = finiteNumber(row.stck_prpr);
      const open = finiteNumber(row.stck_oprc);
      const high = finiteNumber(row.stck_hgpr);
      const low = finiteNumber(row.stck_lwpr);
      const volume = finiteNumber(row.cntg_vol);
      const accumulatedVolume = optionalFiniteNumber(row.acml_vol);
      const accumulatedTradingAmount = optionalFiniteNumber(row.acml_tr_pbmn);
      const timestamp = isCompactDate(date) && isCompactTime(time) ? minuteTimestamp(date, time) : "";
      const timestampMs = timestamp ? Date.parse(timestamp) : Number.NaN;
      const invalid = [
        date !== request.sessionDate ? "sessionDate" : "",
        !isCompactTime(time) ? "time" : "",
        close === undefined || close <= 0 ? "close" : "",
        open === undefined || open <= 0 ? "open" : "",
        high === undefined || high <= 0 ? "high" : "",
        low === undefined || low <= 0 ? "low" : "",
        high !== undefined && open !== undefined && close !== undefined && low !== undefined
          && (high < Math.max(open, close, low) || low > Math.min(open, close, high)) ? "ohlc" : "",
        volume === undefined || volume < 0 ? "volume" : "",
        invalidOptionalNumber(row.acml_vol, accumulatedVolume)
          || (accumulatedVolume !== undefined && accumulatedVolume < 0) ? "accumulatedVolume" : "",
        invalidOptionalNumber(row.acml_tr_pbmn, accumulatedTradingAmount)
          || (accumulatedTradingAmount !== undefined && accumulatedTradingAmount < 0) ? "accumulatedTradingAmount" : "",
        !Number.isFinite(timestampMs) || timestampMs > this.now() + 60_000 ? "timestamp" : "",
      ].filter(Boolean);
      if (invalid.length > 0 || close === undefined || open === undefined || high === undefined
        || low === undefined || volume === undefined || !timestamp) {
        diagnostics.push(diagnostic(index, invalid, "KIS minute row was excluded because required fields are invalid."));
        return;
      }
      if (byTimestamp.has(timestamp)) {
        diagnostics.push({
          index,
          code: "duplicate-row",
          fields: ["timestamp"],
          message: "Duplicate KIS minute row was excluded.",
        });
        return;
      }
      byTimestamp.set(timestamp, {
        symbol: request.symbol,
        sessionDate: request.sessionDate,
        timestamp,
        open,
        high,
        low,
        close,
        volume,
        ...(accumulatedVolume === undefined ? {} : { accumulatedVolume }),
        ...(accumulatedTradingAmount === undefined ? {} : { accumulatedTradingAmount }),
        status: timestampMs >= nowMinute ? "forming" : "final",
        source: "kis_rest_recovery",
      });
    });
    const items = Array.from(byTimestamp.values()).sort((left, right) => left.timestamp.localeCompare(right.timestamp));
    return {
      items,
      quality: resultQuality(items.length, diagnostics),
      diagnostics,
      providerTimestamp: new Date(this.now()).toISOString(),
    };
  }

  private validateRankRequest(
    market: KisMarketDivisionCode | undefined,
    marketCode: string | undefined,
    minPrice: number | undefined,
    maxPrice: number | undefined,
    minVolume: number | undefined,
  ): void {
    if (market !== undefined && !MARKET_CODES.has(market)) {
      throw new KisRestValidationError("market must be J, NX, or UN.");
    }
    if (marketCode !== undefined && !/^[A-Za-z0-9]{1,12}$/.test(marketCode)) {
      throw new KisRestValidationError("marketCode must contain 1 to 12 ASCII letters or digits.");
    }
    for (const [name, value] of [["minPrice", minPrice], ["maxPrice", maxPrice], ["minVolume", minVolume]] as const) {
      if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
        throw new KisRestValidationError(`${name} must be a non-negative finite number.`);
      }
    }
    if (minPrice !== undefined && maxPrice !== undefined && minPrice > maxPrice) {
      throw new KisRestValidationError("minPrice must not exceed maxPrice.");
    }
  }

  private redact(message: string): string {
    return message
      .replaceAll(this.config.appKey, "[redacted]")
      .replaceAll(this.config.appSecret, "[redacted]");
  }
}

export const KIS_REST_MARKET_SOURCE_BY_CODE: Readonly<Record<KisMarketDivisionCode, KisMarketSource>> = {
  J: marketSource("J"),
  NX: marketSource("NX"),
  UN: marketSource("UN"),
};
