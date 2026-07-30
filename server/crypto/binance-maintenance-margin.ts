import {
  DERIVATIVES_TRADING_USDS_FUTURES_REST_API_PROD_URL,
  DERIVATIVES_TRADING_USDS_FUTURES_REST_API_TESTNET_URL,
  DerivativesTradingUsdsFutures,
} from "@binance/derivatives-trading-usds-futures";
import type { BinanceServerCredentials } from "./binance-credentials.js";
import {
  BINANCE_USDM_MAX_INITIAL_LEVERAGE,
  BinanceInstrumentRulesSchema,
  type BinanceInstrumentRules,
} from "./contracts.js";

type UnknownRecord = Record<string, unknown>;
type SignedReadResponse = { data(): unknown | Promise<unknown> };

export type BinanceMaintenanceMarginRestApi = {
  notionalAndLeverageBrackets(input: {
    symbol: string;
  }): Promise<SignedReadResponse>;
};

export type BinanceMaintenanceMarginBracket = {
  readonly bracket: number;
  readonly initialLeverage: number;
  readonly notionalFloor: number;
  readonly notionalCap: number;
  readonly conservativeNotionalFloor: number;
  readonly maintMarginRatio: number;
  readonly cum: number;
};

export type BinanceMaintenanceMarginSchedule = {
  readonly schemaVersion: "binance-usdm-maintenance-margin/v1";
  readonly symbol: string;
  readonly source: "binance_user_data_brackets";
  readonly notionalCoef: number;
  readonly notionalCoefPresent: boolean;
  readonly maximumCoveredNotional: number;
  readonly brackets: readonly BinanceMaintenanceMarginBracket[];
  readonly provenance: {
    readonly endpoint: "notional_and_leverage_brackets_user_data";
    readonly exchangeInfoMaintenanceIgnored: true;
    readonly notionalCoefficientPolicy: "earliest_of_reported_or_scaled_floor";
    readonly maximumNotionalPolicy: "highest_applicable_maintenance_margin_ratio";
    readonly cumulativePolicy: "assume_zero_conservative";
    readonly rawPayloadRetained: false;
  };
};

export type BinanceMaintenanceMarginResolution = {
  readonly symbol: string;
  readonly maximumNotional: number;
  readonly maintenanceMarginRate: number;
  readonly maximumInitialLeverage: number;
  readonly maintenanceMarginAtMaximumNotional: number;
  readonly source: "binance_user_data_brackets";
  readonly provenance: BinanceMaintenanceMarginSchedule["provenance"];
};

export type BinanceMaintenanceMarginProviderState =
  | "unconfigured"
  | "not_ready"
  | "ready"
  | "unauthorized"
  | "rate_limited"
  | "invalid_response"
  | "unavailable";

export type BinanceMaintenanceMarginProviderStatus = {
  configured: boolean;
  ready: boolean;
  state: BinanceMaintenanceMarginProviderState;
};

export class BinanceMaintenanceMarginUnavailableError extends Error {
  readonly state: Exclude<BinanceMaintenanceMarginProviderState, "ready">;

  constructor(state: Exclude<BinanceMaintenanceMarginProviderState, "ready">) {
    super(`Binance maintenance-margin brackets are ${state}.`);
    this.name = "BinanceMaintenanceMarginUnavailableError";
    this.state = state;
  }
}

function record(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : undefined;
}

function upperSymbol(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toUpperCase();
  return /^[A-Z0-9]{2,32}$/.test(normalized) ? normalized : undefined;
}

function finite(value: unknown): number | undefined {
  if (typeof value === "bigint") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  if (typeof value === "string" && value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function finiteInteger(value: unknown, minimum: number): number | undefined {
  const parsed = finite(value);
  return parsed !== undefined && Number.isSafeInteger(parsed) && parsed >= minimum
    ? parsed
    : undefined;
}

function sameBracket(
  left: BinanceMaintenanceMarginBracket,
  right: BinanceMaintenanceMarginBracket,
): boolean {
  return left.bracket === right.bracket
    && left.initialLeverage === right.initialLeverage
    && left.notionalFloor === right.notionalFloor
    && left.notionalCap === right.notionalCap
    && left.maintMarginRatio === right.maintMarginRatio
    && left.cum === right.cum;
}

function approximatelyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= Number.EPSILON
    * Math.max(1, Math.abs(left), Math.abs(right)) * 8;
}

function invalidResponse(): never {
  throw new BinanceMaintenanceMarginUnavailableError("invalid_response");
}

/**
 * Projects a symbol-scoped USER_DATA response into a strict, credential-free
 * schedule. Any malformed or ambiguous field invalidates the whole response.
 */
export function normalizeBinanceMaintenanceMarginSchedule(
  payload: unknown,
  expectedSymbol: string,
): BinanceMaintenanceMarginSchedule {
  const normalizedExpectedSymbol = upperSymbol(expectedSymbol);
  if (!normalizedExpectedSymbol) invalidResponse();
  const rawEntries = Array.isArray(payload) ? payload : [payload];
  if (rawEntries.length !== 1) invalidResponse();
  const entry = record(rawEntries[0]);
  if (!entry || upperSymbol(entry.symbol) !== normalizedExpectedSymbol) invalidResponse();

  const notionalCoefPresent = entry.notionalCoef !== undefined;
  const notionalCoef = notionalCoefPresent ? finite(entry.notionalCoef) : 1;
  if (notionalCoef === undefined || notionalCoef <= 0) invalidResponse();
  const coefficientFloorFactor = Math.min(1, notionalCoef);

  if (!Array.isArray(entry.brackets) || entry.brackets.length === 0) invalidResponse();
  const byBracket = new Map<number, BinanceMaintenanceMarginBracket>();
  const floorOwners = new Map<number, number>();
  for (const rawBracket of entry.brackets) {
    const value = record(rawBracket);
    if (!value) invalidResponse();
    const bracket = finiteInteger(value.bracket, 1);
    const initialLeverage = finiteInteger(value.initialLeverage, 1);
    const notionalFloor = finite(value.notionalFloor);
    const notionalCap = finite(value.notionalCap);
    const maintMarginRatio = finite(value.maintMarginRatio);
    const cum = finite(value.cum);
    if (bracket === undefined || initialLeverage === undefined
      || initialLeverage > BINANCE_USDM_MAX_INITIAL_LEVERAGE
      || notionalFloor === undefined || notionalFloor < 0
      || notionalCap === undefined || notionalCap <= notionalFloor
      || maintMarginRatio === undefined || maintMarginRatio <= 0 || maintMarginRatio >= 1
      || cum === undefined || cum < 0) {
      invalidResponse();
    }
    const normalized: BinanceMaintenanceMarginBracket = {
      bracket,
      initialLeverage,
      notionalFloor,
      notionalCap,
      // Binance's optional user multiplier is not explicit about whether a
      // returned boundary is pre- or post-adjustment. Starting a higher tier
      // at the earlier interpretation is conservative in either direction.
      conservativeNotionalFloor: notionalFloor * coefficientFloorFactor,
      maintMarginRatio,
      cum,
    };
    const duplicate = byBracket.get(bracket);
    if (duplicate) {
      if (!sameBracket(duplicate, normalized)) invalidResponse();
      continue;
    }
    const floorOwner = floorOwners.get(notionalFloor);
    if (floorOwner !== undefined && floorOwner !== bracket) invalidResponse();
    floorOwners.set(notionalFloor, bracket);
    byBracket.set(bracket, normalized);
  }

  const brackets = Array.from(byBracket.values()).sort(
    (left, right) => left.notionalFloor - right.notionalFloor
      || left.bracket - right.bracket,
  );
  if (brackets[0]?.notionalFloor !== 0) invalidResponse();
  for (let index = 1; index < brackets.length; index += 1) {
    const previous = brackets[index - 1]!;
    const current = brackets[index]!;
    if (!approximatelyEqual(previous.notionalCap, current.notionalFloor)
      || current.maintMarginRatio < previous.maintMarginRatio
      || current.initialLeverage > previous.initialLeverage) {
      invalidResponse();
    }
  }

  const reportedMaximum = brackets.at(-1)!.notionalCap;
  const scaledMaximum = reportedMaximum * notionalCoef;
  const maximumCoveredNotional = Math.min(reportedMaximum, scaledMaximum);
  if (!Number.isFinite(maximumCoveredNotional) || maximumCoveredNotional <= 0) {
    invalidResponse();
  }
  const provenance = Object.freeze({
    endpoint: "notional_and_leverage_brackets_user_data" as const,
    exchangeInfoMaintenanceIgnored: true as const,
    notionalCoefficientPolicy: "earliest_of_reported_or_scaled_floor" as const,
    maximumNotionalPolicy: "highest_applicable_maintenance_margin_ratio" as const,
    cumulativePolicy: "assume_zero_conservative" as const,
    rawPayloadRetained: false as const,
  });
  return Object.freeze({
    schemaVersion: "binance-usdm-maintenance-margin/v1",
    symbol: normalizedExpectedSymbol!,
    source: "binance_user_data_brackets",
    notionalCoef,
    notionalCoefPresent,
    maximumCoveredNotional,
    brackets: Object.freeze(brackets.map((bracket) => Object.freeze(bracket))),
    // Binance's cum is a deduction in the maintenance-amount formula.
    // Ignoring that deduction (cum=0) overstates required maintenance.
    provenance,
  });
}

/**
 * Resolves one scalar rate that remains conservative for every possible
 * position notional from zero through maximumNotional.
 */
export function resolveConservativeMaintenanceMargin(
  schedule: BinanceMaintenanceMarginSchedule,
  maximumNotional: number,
): BinanceMaintenanceMarginResolution {
  if (!Number.isFinite(maximumNotional) || maximumNotional <= 0
    || maximumNotional > schedule.maximumCoveredNotional) {
    throw new BinanceMaintenanceMarginUnavailableError("invalid_response");
  }
  const applicable = schedule.brackets.filter(
    (bracket) => bracket.conservativeNotionalFloor <= maximumNotional,
  );
  if (applicable.length === 0) {
    throw new BinanceMaintenanceMarginUnavailableError("invalid_response");
  }
  const maintenanceMarginRate = Math.max(
    ...applicable.map((bracket) => bracket.maintMarginRatio),
  );
  const maximumInitialLeverage = Math.min(
    ...applicable.map((bracket) => bracket.initialLeverage),
  );
  return {
    symbol: schedule.symbol,
    maximumNotional,
    maintenanceMarginRate,
    maximumInitialLeverage,
    // cum=0 is intentionally used instead of Binance's positive deduction.
    maintenanceMarginAtMaximumNotional: maximumNotional * maintenanceMarginRate,
    source: "binance_user_data_brackets",
    provenance: schedule.provenance,
  };
}

function failureState(
  error: unknown,
): Exclude<BinanceMaintenanceMarginProviderState, "ready" | "not_ready" | "unconfigured"> {
  if (error instanceof BinanceMaintenanceMarginUnavailableError) {
    return error.state === "invalid_response" ? "invalid_response" : "unavailable";
  }
  if (!error || typeof error !== "object") return "unavailable";
  try {
    const value = error as {
      status?: unknown;
      statusCode?: unknown;
      code?: unknown;
      response?: { status?: unknown };
    };
    const status = Number(value.status ?? value.statusCode ?? value.response?.status);
    if (status === 401 || status === 403 || Number(value.code) === -2015) return "unauthorized";
    if (status === 418 || status === 429) return "rate_limited";
  } catch {
    return "unavailable";
  }
  return "unavailable";
}

export class BinanceMaintenanceMarginProvider {
  private readonly rest?: BinanceMaintenanceMarginRestApi;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly cache = new Map<string, {
    schedule: BinanceMaintenanceMarginSchedule;
    expiresAt: number;
  }>();
  private readonly inflight = new Map<string, Promise<BinanceMaintenanceMarginSchedule>>();
  private state: BinanceMaintenanceMarginProviderState;

  constructor(input: {
    credentials?: BinanceServerCredentials;
    environment?: "testnet" | "live";
    timeoutMs?: number;
    ttlMs?: number;
    now?: () => number;
    rest?: BinanceMaintenanceMarginRestApi;
  }) {
    const timeoutMs = input.timeoutMs ?? 5_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) {
      throw new Error("Binance bracket timeout must be between 100 and 30000ms.");
    }
    this.ttlMs = input.ttlMs ?? 300_000;
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs < 1 || this.ttlMs > 86_400_000) {
      throw new Error("Binance bracket cache TTL must be between 1 and 86400000ms.");
    }
    this.now = input.now ?? Date.now;
    this.state = input.credentials ? "not_ready" : "unconfigured";
    if (!input.credentials) return;
    if (input.rest) {
      this.rest = input.rest;
      return;
    }
    this.rest = input.credentials.use((apiKey, apiSecret) => {
      const client = new DerivativesTradingUsdsFutures({
        configurationRestAPI: {
          apiKey,
          apiSecret,
          basePath: input.environment === "testnet"
            ? DERIVATIVES_TRADING_USDS_FUTURES_REST_API_TESTNET_URL
            : DERIVATIVES_TRADING_USDS_FUTURES_REST_API_PROD_URL,
          timeout: timeoutMs,
          // A signed account read is never retried opaquely. Callers may make
          // a fresh, explicit refresh after inspecting the fail-closed state.
          retries: 0,
        },
      });
      return client.restAPI;
    });
  }

  status(): BinanceMaintenanceMarginProviderStatus {
    return {
      configured: this.rest !== undefined,
      ready: this.state === "ready",
      state: this.state,
    };
  }

  async schedule(
    symbol: string,
    options: { forceRefresh?: boolean } = {},
  ): Promise<BinanceMaintenanceMarginSchedule> {
    const normalizedSymbol = upperSymbol(symbol);
    if (!normalizedSymbol) {
      this.fail("invalid_response");
    }
    if (!this.rest) this.fail("unconfigured");
    const now = this.now();
    const cached = this.cache.get(normalizedSymbol!);
    if (!options.forceRefresh && cached && cached.expiresAt > now) {
      return cached.schedule;
    }
    const active = this.inflight.get(normalizedSymbol!);
    if (active) return active;
    const refresh = this.refresh(normalizedSymbol!).finally(() => {
      this.inflight.delete(normalizedSymbol!);
    });
    this.inflight.set(normalizedSymbol!, refresh);
    return refresh;
  }

  async resolveInstrumentRules(
    rules: BinanceInstrumentRules,
    maximumNotional: number,
    options: { forceRefresh?: boolean } = {},
  ): Promise<{
    rules: BinanceInstrumentRules;
    resolution: BinanceMaintenanceMarginResolution;
  }> {
    const schedule = await this.schedule(rules.symbol, options);
    let resolution: BinanceMaintenanceMarginResolution;
    try {
      resolution = resolveConservativeMaintenanceMargin(schedule, maximumNotional);
    } catch {
      this.fail("invalid_response");
    }
    return {
      rules: BinanceInstrumentRulesSchema.parse({
        ...rules,
        maintenanceMarginRate: resolution!.maintenanceMarginRate,
        maximumInitialLeverage: resolution!.maximumInitialLeverage,
        maintenanceMarginMaximumNotional: resolution!.maximumNotional,
        maintenanceMarginSource: "binance_user_data_brackets",
      }),
      resolution: resolution!,
    };
  }

  private async refresh(symbol: string): Promise<BinanceMaintenanceMarginSchedule> {
    try {
      const response = await this.rest!.notionalAndLeverageBrackets({ symbol });
      const payload = await response.data();
      const schedule = normalizeBinanceMaintenanceMarginSchedule(payload, symbol);
      // Retain only the normalized bracket projection, never the raw USER_DATA
      // response or response wrapper.
      this.cache.set(symbol, {
        schedule,
        expiresAt: this.now() + this.ttlMs,
      });
      this.state = "ready";
      return schedule;
    } catch (error) {
      this.fail(failureState(error));
    }
  }

  private fail(
    state: Exclude<BinanceMaintenanceMarginProviderState, "ready" | "not_ready">,
  ): never {
    // A refresh failure invalidates every cached account-specific schedule.
    // Stale bracket data must never remain available for risk decisions.
    this.cache.clear();
    this.state = state;
    throw new BinanceMaintenanceMarginUnavailableError(state);
  }
}
