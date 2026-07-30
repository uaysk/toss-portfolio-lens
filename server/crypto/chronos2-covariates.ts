import { createHash } from "node:crypto";
import type {
  BinanceKline,
  BinanceRestFundingRateRequest,
  BinanceRestMarketData,
  BinanceRestReferenceKlineRequest,
} from "./binance-market-data.js";

const MINUTE_MS = 60_000;
const FUNDING_SEED_LOOKBACK_MS = 24 * 60 * MINUTE_MS;
const REFERENCE_PAGE_LIMIT = 1_000;
const MAXIMUM_BARS = 60_000;

type ReferenceMethodName = "markPriceKlines" | "indexPriceKlines" | "premiumIndexKlines";

export type Chronos2DerivativeBar = BinanceKline & {
  markPrice: number;
  indexPrice: number;
  premiumIndex: number;
  fundingRate: number;
};

export type Chronos2DerivativeCoverage = {
  schemaVersion: "chronos2-derivative-covariates/v1";
  symbol: string;
  startAt: string;
  endExclusiveAt: string;
  rowCount: number;
  fundingObservationCount: number;
  causalFundingPolicy: "latest_funding_time_lte_bar_close_v1";
  digest: string;
  bars: readonly Chronos2DerivativeBar[];
};

export type Chronos2DerivativeRestMarketData = Required<Pick<
  BinanceRestMarketData,
  "markPriceKlines" | "indexPriceKlines" | "premiumIndexKlines" | "fundingRateHistory"
>>;

export type Chronos2DerivativeRequestPacing = {
  minimumSpacingMs: number;
  rateLimitBackoffMs: number;
  maximumRateLimitRetries: number;
  signal?: AbortSignal;
  clock?: () => number;
  delay?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
};

type ReferencePoint = {
  openTime: number;
  closeTime: number;
  close: number;
};

type FundingPoint = {
  fundingTime: number;
  fundingRate: number;
};

function finite(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "string" && typeof value !== "bigint") {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function nonnegativeInteger(value: unknown): number | undefined {
  const parsed = finite(value);
  return parsed !== undefined && parsed >= 0 && Number.isSafeInteger(parsed)
    ? parsed
    : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function referencePoint(value: unknown, requirePositive: boolean): ReferencePoint | undefined {
  const object = record(value);
  const openTime = nonnegativeInteger(Array.isArray(value) ? value[0] : object?.openTime);
  const closeTime = nonnegativeInteger(Array.isArray(value) ? value[6] : object?.closeTime);
  const close = finite(Array.isArray(value) ? value[4] : object?.close);
  if (
    openTime === undefined
    || closeTime === undefined
    || close === undefined
    || (requirePositive ? close <= 0 : false)
  ) {
    return undefined;
  }
  return { openTime, closeTime, close };
}

export function normalizeChronos2ReferenceKlines(
  payload: unknown,
  options: { requirePositive: boolean },
): ReferencePoint[] {
  if (!Array.isArray(payload)) return [];
  return payload
    .map((value) => referencePoint(value, options.requirePositive))
    .filter((value): value is ReferencePoint => value !== undefined)
    .sort((left, right) => left.openTime - right.openTime);
}

export function normalizeChronos2FundingHistory(payload: unknown): FundingPoint[] {
  if (!Array.isArray(payload)) return [];
  const values = payload.flatMap((value): FundingPoint[] => {
    const item = record(value);
    const fundingTime = nonnegativeInteger(item?.fundingTime);
    const fundingRate = finite(item?.fundingRate);
    return fundingTime === undefined || fundingRate === undefined
      ? []
      : [{ fundingTime, fundingRate }];
  });
  return values.sort((left, right) => left.fundingTime - right.fundingTime);
}

export function hasChronos2DerivativeMarketData(
  rest: BinanceRestMarketData,
): rest is BinanceRestMarketData & Chronos2DerivativeRestMarketData {
  return typeof rest.markPriceKlines === "function"
    && typeof rest.indexPriceKlines === "function"
    && typeof rest.premiumIndexKlines === "function"
    && typeof rest.fundingRateHistory === "function";
}

function abortIfRequested(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error("Chronos-2 derivative covariate acquisition was cancelled.");
}

async function delayWithAbort(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  abortIfRequested(signal);
  if (milliseconds <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      try {
        abortIfRequested(signal);
      } catch (error) {
        reject(error);
      }
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isBinanceRateLimitError(error: unknown): boolean {
  const value = record(error);
  const code = finite(value?.code);
  const name = typeof value?.name === "string" ? value.name : "";
  const message = typeof value?.message === "string" ? value.message : "";
  return code === -1003
    || /TooManyRequests/i.test(name)
    || /too many requests|request weight|requests per minute/i.test(message);
}

export function paceChronos2DerivativeMarketData(
  rest: Chronos2DerivativeRestMarketData,
  options: Chronos2DerivativeRequestPacing,
): Chronos2DerivativeRestMarketData {
  const {
    minimumSpacingMs,
    rateLimitBackoffMs,
    maximumRateLimitRetries,
    signal,
  } = options;
  if (
    !Number.isSafeInteger(minimumSpacingMs)
    || minimumSpacingMs < 0
    || minimumSpacingMs > 60_000
    || !Number.isSafeInteger(rateLimitBackoffMs)
    || rateLimitBackoffMs < 1_000
    || rateLimitBackoffMs > 300_000
    || !Number.isSafeInteger(maximumRateLimitRetries)
    || maximumRateLimitRetries < 0
    || maximumRateLimitRetries > 5
  ) {
    throw new Error("Chronos-2 derivative request pacing is invalid.");
  }
  const clock = options.clock ?? Date.now;
  const delay = options.delay ?? delayWithAbort;
  let nextRequestAt = 0;

  const execute = async (request: () => Promise<unknown>): Promise<unknown> => {
    for (let attempt = 0; ; attempt += 1) {
      abortIfRequested(signal);
      const now = clock();
      const scheduledAt = Math.max(now, nextRequestAt);
      nextRequestAt = scheduledAt + minimumSpacingMs;
      await delay(Math.max(0, scheduledAt - now), signal);
      try {
        return await request();
      } catch (error) {
        if (
          !isBinanceRateLimitError(error)
          || attempt >= maximumRateLimitRetries
        ) {
          throw error;
        }
        nextRequestAt = Math.max(nextRequestAt, clock() + rateLimitBackoffMs);
        await delay(rateLimitBackoffMs, signal);
      }
    }
  };

  return {
    markPriceKlines: (input) => execute(() => rest.markPriceKlines(input)),
    indexPriceKlines: (input) => execute(() => rest.indexPriceKlines(input)),
    premiumIndexKlines: (input) => execute(() => rest.premiumIndexKlines(input)),
    fundingRateHistory: (input) => execute(() => rest.fundingRateHistory(input)),
  };
}

async function loadReference(
  rest: Chronos2DerivativeRestMarketData,
  method: ReferenceMethodName,
  input: {
    symbol: string;
    startTime: number;
    endExclusive: number;
    requirePositive: boolean;
    expectedRows: number;
    signal?: AbortSignal;
  },
): Promise<Map<number, ReferencePoint>> {
  const values = new Map<number, ReferencePoint>();
  const maximumPages = Math.ceil(input.expectedRows / REFERENCE_PAGE_LIMIT) + 2;
  let cursor = input.startTime;
  for (let page = 0; cursor < input.endExclusive; page += 1) {
    abortIfRequested(input.signal);
    if (page >= maximumPages) {
      throw new Error(`${method} pagination exceeded its bounded page count.`);
    }
    const request: BinanceRestReferenceKlineRequest = {
      symbol: input.symbol,
      startTime: cursor,
      endTime: input.endExclusive - 1,
      limit: REFERENCE_PAGE_LIMIT,
    };
    const normalized = normalizeChronos2ReferenceKlines(
      await rest[method](request),
      { requirePositive: input.requirePositive },
    ).filter((point) => (
      point.openTime >= input.startTime && point.openTime < input.endExclusive
    ));
    if (!normalized.length) {
      throw new Error(`${method} returned no usable 1m observations at ${new Date(cursor).toISOString()}.`);
    }
    let maximumOpenTime = Number.NEGATIVE_INFINITY;
    for (const point of normalized) {
      maximumOpenTime = Math.max(maximumOpenTime, point.openTime);
      const previous = values.get(point.openTime);
      if (
        previous
        && (previous.close !== point.close || previous.closeTime !== point.closeTime)
      ) {
        throw new Error(`${method} returned a conflicting duplicate at ${new Date(point.openTime).toISOString()}.`);
      }
      values.set(point.openTime, previous ?? point);
    }
    const next = maximumOpenTime + MINUTE_MS;
    if (!Number.isFinite(maximumOpenTime) || next <= cursor) {
      throw new Error(`${method} pagination did not advance.`);
    }
    cursor = next;
  }
  if (values.size !== input.expectedRows) {
    throw new Error(`${method} coverage is incomplete (${values.size}/${input.expectedRows}).`);
  }
  return values;
}

async function loadFunding(
  rest: Chronos2DerivativeRestMarketData,
  input: {
    symbol: string;
    firstBarOpen: number;
    finalBarClose: number;
    signal?: AbortSignal;
  },
): Promise<FundingPoint[]> {
  const startTime = Math.max(0, input.firstBarOpen - FUNDING_SEED_LOOKBACK_MS);
  const byTime = new Map<number, FundingPoint>();
  let cursor = startTime;
  for (let page = 0; cursor <= input.finalBarClose; page += 1) {
    abortIfRequested(input.signal);
    if (page >= 64) throw new Error("funding-rate pagination exceeded its bounded page count.");
    const request: BinanceRestFundingRateRequest = {
      symbol: input.symbol,
      startTime: cursor,
      endTime: input.finalBarClose,
      limit: REFERENCE_PAGE_LIMIT,
    };
    const normalized = normalizeChronos2FundingHistory(
      await rest.fundingRateHistory(request),
    ).filter((point) => point.fundingTime >= startTime && point.fundingTime <= input.finalBarClose);
    if (!normalized.length) break;
    let maximumFundingTime = Number.NEGATIVE_INFINITY;
    for (const point of normalized) {
      maximumFundingTime = Math.max(maximumFundingTime, point.fundingTime);
      const previous = byTime.get(point.fundingTime);
      if (previous && previous.fundingRate !== point.fundingRate) {
        throw new Error(
          `Funding history returned a conflicting duplicate at ${new Date(point.fundingTime).toISOString()}.`,
        );
      }
      byTime.set(point.fundingTime, previous ?? point);
    }
    const next = maximumFundingTime + 1;
    if (!Number.isFinite(maximumFundingTime) || next <= cursor) {
      throw new Error("funding-rate pagination did not advance.");
    }
    cursor = next;
    if (normalized.length < REFERENCE_PAGE_LIMIT) break;
  }
  const values = [...byTime.values()].sort((left, right) => left.fundingTime - right.fundingTime);
  if (!values.some((point) => point.fundingTime <= input.firstBarOpen + MINUTE_MS - 1)) {
    throw new Error("Funding history has no causal seed at the first Chronos-2 context bar.");
  }
  return values;
}

function validateBars(bars: readonly BinanceKline[]): {
  symbol: string;
  startTime: number;
  endExclusive: number;
} {
  if (!bars.length || bars.length > MAXIMUM_BARS) {
    throw new Error(`Chronos-2 derivative acquisition requires 1~${MAXIMUM_BARS} bars.`);
  }
  const symbol = bars[0]!.symbol;
  const startTime = bars[0]!.openTime;
  for (let index = 0; index < bars.length; index += 1) {
    const bar = bars[index]!;
    const expectedOpenTime = startTime + index * MINUTE_MS;
    if (
      bar.symbol !== symbol
      || bar.interval !== "1m"
      || !bar.final
      || bar.openTime !== expectedOpenTime
      || bar.closeTime !== expectedOpenTime + MINUTE_MS - 1
    ) {
      throw new Error(`Chronos-2 derivative acquisition requires continuous finalized 1m bars at row ${index}.`);
    }
  }
  return {
    symbol,
    startTime,
    endExclusive: startTime + bars.length * MINUTE_MS,
  };
}

export async function loadChronos2DerivativeCovariates(
  rest: Chronos2DerivativeRestMarketData,
  bars: readonly BinanceKline[],
  signal?: AbortSignal,
): Promise<Chronos2DerivativeCoverage> {
  const range = validateBars(bars);
  const common = {
    symbol: range.symbol,
    startTime: range.startTime,
    endExclusive: range.endExclusive,
    expectedRows: bars.length,
    signal,
  };
  const [marks, indexes, premiums, funding] = await Promise.all([
    loadReference(rest, "markPriceKlines", { ...common, requirePositive: true }),
    loadReference(rest, "indexPriceKlines", { ...common, requirePositive: true }),
    loadReference(rest, "premiumIndexKlines", { ...common, requirePositive: false }),
    loadFunding(rest, {
      symbol: range.symbol,
      firstBarOpen: range.startTime,
      finalBarClose: range.endExclusive - 1,
      signal,
    }),
  ]);
  let fundingIndex = -1;
  const enriched = bars.map((bar): Chronos2DerivativeBar => {
    while (
      fundingIndex + 1 < funding.length
      && funding[fundingIndex + 1]!.fundingTime <= bar.closeTime
    ) {
      fundingIndex += 1;
    }
    const mark = marks.get(bar.openTime);
    const index = indexes.get(bar.openTime);
    const premium = premiums.get(bar.openTime);
    const fundingPoint = funding[fundingIndex];
    if (!mark || !index || !premium || !fundingPoint) {
      throw new Error(`Chronos-2 derivative coverage is incomplete at ${new Date(bar.openTime).toISOString()}.`);
    }
    return {
      ...bar,
      markPrice: mark.close,
      indexPrice: index.close,
      premiumIndex: premium.close,
      fundingRate: fundingPoint.fundingRate,
    };
  });
  const digest = createHash("sha256");
  for (const bar of enriched) {
    digest.update(JSON.stringify([
      bar.openTime,
      bar.markPrice,
      bar.indexPrice,
      bar.premiumIndex,
      bar.fundingRate,
    ]));
    digest.update("\n");
  }
  return {
    schemaVersion: "chronos2-derivative-covariates/v1",
    symbol: range.symbol,
    startAt: new Date(range.startTime).toISOString(),
    endExclusiveAt: new Date(range.endExclusive).toISOString(),
    rowCount: enriched.length,
    fundingObservationCount: funding.length,
    causalFundingPolicy: "latest_funding_time_lte_bar_close_v1",
    digest: digest.digest("hex"),
    bars: enriched,
  };
}
