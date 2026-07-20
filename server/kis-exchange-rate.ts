import { isHistoryDate } from "./history.js";

type UnknownRecord = Record<string, unknown>;

export type KisApiEnvironment = "real" | "demo";

export type KisExchangeRateConfig = {
  appKey: string;
  appSecret: string;
  environment: KisApiEnvironment;
  requestIntervalMs: number;
  timeoutMs: number;
};

export type KisExchangeRate = {
  date: string;
  rate: number;
  timestamp: string;
};

export type KisExchangeRateProvider = {
  getUsdKrwExchangeRates(fromDate: string, toDate: string): Promise<KisExchangeRate[]>;
};

export class KisApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "KisApiError";
  }
}

type KisExchangeRateClientOptions = {
  fetchImpl?: typeof fetch;
  sleepImpl?: (milliseconds: number) => Promise<void>;
  now?: () => number;
};

const BASE_URLS: Record<KisApiEnvironment, string> = {
  real: "https://openapi.koreainvestment.com:9443",
  demo: "https://openapivts.koreainvestment.com:29443",
};
const DAILY_CHART_PATH = "/uapi/overseas-price/v1/quotations/inquire-daily-chartprice";
const TOKEN_PATH = "/oauth2/tokenP";
const TR_ID = "FHKST03030100";
const MAX_CHUNK_CALENDAR_DAYS = 30;
const MAX_RATE_LIMIT_RETRIES = 3;

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return "";
}

function numberValue(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : Number.NaN;
  if (typeof value === "string") {
    const parsed = Number(value.replace(/[,%\s]/g, ""));
    return Number.isFinite(parsed) ? parsed : Number.NaN;
  }
  return Number.NaN;
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function compactDate(date: string): string {
  return date.replaceAll("-", "");
}

function expandedDate(date: string): string {
  return `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class KisExchangeRateClient implements KisExchangeRateProvider {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (milliseconds: number) => Promise<void>;
  private readonly now: () => number;
  private token?: { value: string; expiresAt: number };
  private tokenInFlight?: Promise<string>;
  private nextRequestAt = 0;

  constructor(
    private readonly config: KisExchangeRateConfig,
    options: KisExchangeRateClientOptions = {},
  ) {
    this.baseUrl = BASE_URLS[config.environment];
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleepImpl = options.sleepImpl ?? defaultSleep;
    this.now = options.now ?? Date.now;
  }

  private async parseResponse(response: Response): Promise<UnknownRecord> {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new KisApiError(
        "한국투자증권 API가 올바른 JSON을 반환하지 않았습니다.",
        response.status,
        "invalid-response",
        response.status === 429 || response.status >= 500,
      );
    }
    if (!isRecord(body)) {
      throw new KisApiError("한국투자증권 API 응답 형식이 올바르지 않습니다.", response.status, "invalid-response", false);
    }
    const code = stringValue(body.msg_cd) || stringValue(body.error_code) || `http-${response.status}`;
    if (!response.ok || (body.rt_cd !== undefined && stringValue(body.rt_cd) !== "0")) {
      const message = stringValue(body.msg1) || stringValue(body.error_description) || "한국투자증권 API 요청에 실패했습니다.";
      throw new KisApiError(
        message,
        response.status,
        code,
        response.status === 429 || response.status >= 500 || code === "EGW00201",
      );
    }
    return body;
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > this.now()) return this.token.value;
    if (this.tokenInFlight) return this.tokenInFlight;
    const task = (async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
      try {
        const response = await this.fetchImpl(`${this.baseUrl}${TOKEN_PATH}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            grant_type: "client_credentials",
            appkey: this.config.appKey,
            appsecret: this.config.appSecret,
          }),
          signal: controller.signal,
        });
        const body = await this.parseResponse(response);
        const value = stringValue(body.access_token);
        if (!value) throw new KisApiError("한국투자증권 액세스 토큰이 비어 있습니다.", response.status, "invalid-token", false);
        const expiresInSeconds = numberValue(body.expires_in);
        const lifetimeMs = Number.isFinite(expiresInSeconds) && expiresInSeconds > 0
          ? expiresInSeconds * 1_000
          : 23 * 60 * 60 * 1_000;
        this.token = {
          value,
          expiresAt: this.now() + Math.max(60_000, lifetimeMs - 60_000),
        };
        return value;
      } catch (error) {
        if (error instanceof KisApiError) throw error;
        const timedOut = error instanceof Error && error.name === "AbortError";
        throw new KisApiError(
          timedOut ? "한국투자증권 인증 요청 시간이 초과되었습니다." : "한국투자증권 인증 요청에 실패했습니다.",
          0,
          timedOut ? "timeout" : "network-error",
          true,
        );
      } finally {
        clearTimeout(timeout);
      }
    })();
    this.tokenInFlight = task;
    try {
      return await task;
    } finally {
      this.tokenInFlight = undefined;
    }
  }

  private async pace(): Promise<void> {
    const waitMs = this.nextRequestAt - this.now();
    if (waitMs > 0) await this.sleepImpl(waitMs);
    this.nextRequestAt = this.now() + this.config.requestIntervalMs;
  }

  private async fetchChunk(fromDate: string, toDate: string): Promise<KisExchangeRate[]> {
    for (let attempt = 0; ; attempt += 1) {
      await this.pace();
      const token = await this.accessToken();
      const url = new URL(`${this.baseUrl}${DAILY_CHART_PATH}`);
      url.searchParams.set("FID_COND_MRKT_DIV_CODE", "X");
      url.searchParams.set("FID_INPUT_ISCD", "FX@KRW");
      url.searchParams.set("FID_INPUT_DATE_1", compactDate(fromDate));
      url.searchParams.set("FID_INPUT_DATE_2", compactDate(toDate));
      url.searchParams.set("FID_PERIOD_DIV_CODE", "D");
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
      try {
        const response = await this.fetchImpl(url, {
          headers: {
            authorization: `Bearer ${token}`,
            appkey: this.config.appKey,
            appsecret: this.config.appSecret,
            tr_id: TR_ID,
            custtype: "P",
          },
          signal: controller.signal,
        });
        const body = await this.parseResponse(response);
        const rows = Array.isArray(body.output2) ? body.output2.filter(isRecord) : [];
        return rows.flatMap((row): KisExchangeRate[] => {
          const compact = stringValue(row.stck_bsop_date);
          const date = compact.length === 8 ? expandedDate(compact) : "";
          const rate = numberValue(row.ovrs_nmix_prpr);
          if (!isHistoryDate(date) || date < fromDate || date > toDate || !Number.isFinite(rate) || rate <= 0) return [];
          return [{ date, rate, timestamp: `${date}T15:30:00+09:00` }];
        });
      } catch (error) {
        const normalized = error instanceof KisApiError
          ? error
          : new KisApiError(
            error instanceof Error && error.name === "AbortError"
              ? "한국투자증권 환율 요청 시간이 초과되었습니다."
              : "한국투자증권 환율 요청에 실패했습니다.",
            0,
            error instanceof Error && error.name === "AbortError" ? "timeout" : "network-error",
            true,
          );
        if (!normalized.retryable || attempt >= MAX_RATE_LIMIT_RETRIES) throw normalized;
        await this.sleepImpl(1_000 * 2 ** attempt);
      } finally {
        clearTimeout(timeout);
      }
    }
  }

  async getUsdKrwExchangeRates(fromDate: string, toDate: string): Promise<KisExchangeRate[]> {
    if (!isHistoryDate(fromDate) || !isHistoryDate(toDate) || fromDate > toDate) {
      throw new Error("KIS 환율 조회 기간이 올바르지 않습니다.");
    }
    const byDate = new Map<string, KisExchangeRate>();
    let chunkFrom = fromDate;
    while (chunkFrom <= toDate) {
      const chunkTo = [addDays(chunkFrom, MAX_CHUNK_CALENDAR_DAYS - 1), toDate].sort()[0]!;
      for (const rate of await this.fetchChunk(chunkFrom, chunkTo)) byDate.set(rate.date, rate);
      chunkFrom = addDays(chunkTo, 1);
    }
    return Array.from(byDate.values()).sort((left, right) => left.date.localeCompare(right.date));
  }
}
