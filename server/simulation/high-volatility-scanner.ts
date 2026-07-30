import type { HighVolatilityScannerSettings } from "./contracts.js";

export const HIGH_VOLATILITY_SCANNER_VERSION = "high-vol-scanner/v1" as const;

export type HighVolatilityCandidateObservation = {
  symbol: string;
  observedAt: string;
  listingAt: string;
  delistingAt?: string;
  quoteAsset: string;
  contractType: string;
  stablecoinLike?: boolean;
  missingRate: number;
  tradingAmountUsd: number;
  tradeCount: number;
  medianSpreadBps: number;
  p95SpreadBps: number;
  depthUsd: number;
  staleQuote: boolean;
  abnormalGap: boolean;
  halted: boolean;
  fundingRate: number | null;
  basisRate: number | null;
  realizedVolatility: number;
  normalizedAtr: number;
  rollingRange: number;
  bollingerWidthExpansion: number;
  relativeVolume: number;
  liquidityQuality: number;
  featureAvailability?: Record<string, boolean>;
};

export type HighVolatilityCandidateResult = {
  symbol: string;
  eligible: boolean;
  score: number | null;
  rank: number | null;
  exclusionReasons: string[];
  observedAt: string;
  freshnessMs: number;
  metrics: {
    realizedVolatility: number;
    normalizedAtr: number;
    rollingRange: number;
    bollingerWidthExpansion: number;
    relativeVolume: number;
    tradingAmountUsd: number;
    tradeCount: number;
    medianSpreadBps: number;
    p95SpreadBps: number;
    depthUsd: number;
    liquidityQuality: number;
    fundingRate: number | null;
    basisRate: number | null;
  };
  featureAvailability: Record<string, boolean>;
};

export type HighVolatilityScannerSnapshot = {
  schemaVersion: typeof HIGH_VOLATILITY_SCANNER_VERSION;
  scannedAt: string;
  originAt: string;
  settings: HighVolatilityScannerSettings;
  totalCandidateCount: number;
  eligibleCandidateCount: number;
  selectedSymbols: string[];
  candidates: HighVolatilityCandidateResult[];
  dataFreshnessMs: number | null;
};

const STABLE_BASE_ASSETS = new Set([
  "BUSD",
  "DAI",
  "FDUSD",
  "FRAX",
  "PYUSD",
  "TUSD",
  "USDC",
  "USDD",
  "USDP",
  "USDS",
  "USD1",
  "USTC",
]);

function parseTimestamp(value: string, name: string): number {
  const result = Date.parse(value);
  if (!Number.isFinite(result)) throw new Error(`${name} must be an ISO timestamp.`);
  return result;
}

function finite(value: number, name: string): number {
  if (!Number.isFinite(value)) throw new Error(`${name} must be finite.`);
  return value;
}

function baseAsset(symbol: string): string {
  return symbol.toUpperCase().replace(/USDT$/, "");
}

export function isStablecoinLikePerpetual(
  observation: Pick<HighVolatilityCandidateObservation, "symbol" | "stablecoinLike">,
): boolean {
  const base = baseAsset(observation.symbol);
  return observation.stablecoinLike === true
    || STABLE_BASE_ASSETS.has(base)
    || /(?:USD|EUR|GBP|JPY)$/.test(base);
}

export type AsOfObservation = {
  observedAt: string;
};

/**
 * Selects the last observation no newer than the decision origin. Input order
 * is deliberately irrelevant so backtests cannot accidentally use a future
 * row merely because it was appended first.
 */
export function asOfObservation<T extends AsOfObservation>(
  observations: readonly T[],
  originAt: string,
): T | undefined {
  const originMs = parseTimestamp(originAt, "originAt");
  return observations
    .filter((observation) => parseTimestamp(observation.observedAt, "observedAt") <= originMs)
    .sort((left, right) => (
      parseTimestamp(right.observedAt, "right.observedAt")
      - parseTimestamp(left.observedAt, "left.observedAt")
    ))[0];
}

export function asOfJoinByKey<T extends AsOfObservation>(
  observations: ReadonlyMap<string, readonly T[]>,
  originAt: string,
): Map<string, T> {
  const joined = new Map<string, T>();
  for (const [key, values] of observations) {
    const selected = asOfObservation(values, originAt);
    if (selected) joined.set(key, selected);
  }
  return joined;
}

function hardGateReasons(
  observation: HighVolatilityCandidateObservation,
  originMs: number,
  settings: HighVolatilityScannerSettings,
): string[] {
  const reasons: string[] = [];
  const symbol = observation.symbol.toUpperCase();
  const observedMs = parseTimestamp(observation.observedAt, "observedAt");
  const listingMs = parseTimestamp(observation.listingAt, "listingAt");
  const delistingMs = observation.delistingAt
    ? parseTimestamp(observation.delistingAt, "delistingAt")
    : undefined;
  if (observedMs > originMs) reasons.push("FUTURE_OBSERVATION");
  if (observation.quoteAsset.toUpperCase() !== "USDT") reasons.push("NOT_USDT_QUOTED");
  if (observation.contractType.toUpperCase() !== "PERPETUAL") reasons.push("NOT_PERPETUAL");
  if (symbol === "BTCUSDT" || symbol === "ETHUSDT") reasons.push("CORE_ASSET_EXCLUDED");
  if (isStablecoinLikePerpetual(observation)) reasons.push("STABLECOIN_LIKE");
  if (listingMs > originMs) reasons.push("NOT_YET_LISTED");
  if (delistingMs !== undefined && delistingMs <= originMs) reasons.push("DELISTED");
  if ((originMs - listingMs) / 86_400_000 < settings.minimumListingDays) {
    reasons.push("LISTING_AGE_TOO_SHORT");
  }
  if (observation.missingRate > settings.maximumMissingRate) reasons.push("MISSING_DATA");
  if (observation.tradingAmountUsd < settings.minimumTradingAmountUsd) {
    reasons.push("TRADING_AMOUNT_TOO_LOW");
  }
  if (observation.featureAvailability?.spread === false) {
    reasons.push("SPREAD_UNAVAILABLE");
  }
  if (observation.featureAvailability?.orderbookDepth === false) {
    reasons.push("DEPTH_UNAVAILABLE");
  }
  if (
    observation.medianSpreadBps > settings.maximumSpreadBps
    || observation.p95SpreadBps > settings.maximumSpreadBps * 2
  ) reasons.push("SPREAD_TOO_WIDE");
  if (observation.depthUsd < settings.minimumDepthUsd) reasons.push("DEPTH_TOO_LOW");
  if (observation.staleQuote) reasons.push("STALE_QUOTE");
  if (observation.abnormalGap) reasons.push("ABNORMAL_GAP");
  if (observation.halted) reasons.push("TRADING_HALTED");
  const fundingLimit = settings.riskAppetite === "aggressive" ? 0.002 : 0.001;
  const basisLimit = settings.riskAppetite === "aggressive" ? 0.03 : 0.02;
  if (observation.fundingRate !== null && Math.abs(observation.fundingRate) > fundingLimit) {
    reasons.push("EXTREME_FUNDING");
  }
  if (observation.basisRate !== null && Math.abs(observation.basisRate) > basisLimit) {
    reasons.push("EXTREME_BASIS");
  }
  const numericEntries = Object.entries(observation).filter(([, value]) => typeof value === "number");
  if (numericEntries.some(([, value]) => !Number.isFinite(value))) reasons.push("NON_FINITE_DATA");
  return [...new Set(reasons)];
}

function scaleMetric(
  values: readonly number[],
  value: number,
  inverted = false,
): number {
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const scaled = maximum === minimum ? 0.5 : (value - minimum) / (maximum - minimum);
  return inverted ? 1 - scaled : scaled;
}

function scoreEligible(
  eligible: readonly HighVolatilityCandidateObservation[],
  candidate: HighVolatilityCandidateObservation,
  settings: HighVolatilityScannerSettings,
): number {
  const metric = (
    extractor: (item: HighVolatilityCandidateObservation) => number,
    inverted = false,
  ) => scaleMetric(eligible.map(extractor), extractor(candidate), inverted);
  const depthPenalty = 1 - Math.min(1, candidate.depthUsd / Math.max(settings.minimumDepthUsd, 1));
  return (
    metric((item) => item.realizedVolatility) * 0.16
    + metric((item) => item.normalizedAtr) * 0.14
    + metric((item) => item.rollingRange) * 0.1
    + metric((item) => item.bollingerWidthExpansion) * 0.1
    + metric((item) => item.relativeVolume) * 0.12
    + metric((item) => Math.log1p(item.tradingAmountUsd)) * 0.1
    + metric((item) => Math.log1p(item.tradeCount)) * 0.06
    + metric((item) => item.liquidityQuality) * 0.14
    + metric((item) => item.medianSpreadBps, true) * 0.08
    - depthPenalty * 0.08
  );
}

export function scanHighVolatilityUniverse(
  observations: readonly HighVolatilityCandidateObservation[],
  originAt: string,
  settings: HighVolatilityScannerSettings,
): HighVolatilityScannerSnapshot {
  const originMs = parseTimestamp(originAt, "originAt");
  const latestBySymbol = new Map<string, HighVolatilityCandidateObservation>();
  for (const observation of observations) {
    const symbol = observation.symbol.toUpperCase();
    const observedMs = parseTimestamp(observation.observedAt, "observedAt");
    if (observedMs > originMs) continue;
    const existing = latestBySymbol.get(symbol);
    if (
      !existing
      || parseTimestamp(existing.observedAt, "existing.observedAt") < observedMs
    ) {
      latestBySymbol.set(symbol, { ...observation, symbol });
    }
  }
  const current = [...latestBySymbol.values()];
  const reasons = new Map(
    current.map((observation) => [
      observation.symbol,
      hardGateReasons(observation, originMs, settings),
    ]),
  );
  const eligible = current.filter((observation) => reasons.get(observation.symbol)!.length === 0);
  const scores = new Map(
    eligible.map((observation) => [
      observation.symbol,
      scoreEligible(eligible, observation, settings),
    ]),
  );
  const ranked = [...eligible].sort((left, right) => (
    scores.get(right.symbol)! - scores.get(left.symbol)!
    || right.tradingAmountUsd - left.tradingAmountUsd
    || left.symbol.localeCompare(right.symbol)
  ));
  const ranks = new Map(ranked.map((observation, index) => [observation.symbol, index + 1]));
  const candidates = current
    .map((observation): HighVolatilityCandidateResult => {
      const freshnessMs = originMs - parseTimestamp(observation.observedAt, "observedAt");
      return {
        symbol: observation.symbol,
        eligible: reasons.get(observation.symbol)!.length === 0,
        score: scores.get(observation.symbol) ?? null,
        rank: ranks.get(observation.symbol) ?? null,
        exclusionReasons: reasons.get(observation.symbol)!,
        observedAt: observation.observedAt,
        freshnessMs,
        metrics: {
          realizedVolatility: finite(observation.realizedVolatility, "realizedVolatility"),
          normalizedAtr: finite(observation.normalizedAtr, "normalizedAtr"),
          rollingRange: finite(observation.rollingRange, "rollingRange"),
          bollingerWidthExpansion: finite(
            observation.bollingerWidthExpansion,
            "bollingerWidthExpansion",
          ),
          relativeVolume: finite(observation.relativeVolume, "relativeVolume"),
          tradingAmountUsd: finite(observation.tradingAmountUsd, "tradingAmountUsd"),
          tradeCount: finite(observation.tradeCount, "tradeCount"),
          medianSpreadBps: finite(observation.medianSpreadBps, "medianSpreadBps"),
          p95SpreadBps: finite(observation.p95SpreadBps, "p95SpreadBps"),
          depthUsd: finite(observation.depthUsd, "depthUsd"),
          liquidityQuality: finite(observation.liquidityQuality, "liquidityQuality"),
          fundingRate: observation.fundingRate,
          basisRate: observation.basisRate,
        },
        featureAvailability: { ...observation.featureAvailability },
      };
    })
    .sort((left, right) => (
      Number(right.eligible) - Number(left.eligible)
      || (left.rank ?? Number.MAX_SAFE_INTEGER) - (right.rank ?? Number.MAX_SAFE_INTEGER)
      || left.symbol.localeCompare(right.symbol)
    ));
  const selectedSymbols = ranked
    .slice(0, settings.symbolCount)
    .map((observation) => observation.symbol);
  const freshnessValues = candidates.map((candidate) => candidate.freshnessMs);
  return {
    schemaVersion: HIGH_VOLATILITY_SCANNER_VERSION,
    scannedAt: originAt,
    originAt,
    settings: { ...settings },
    totalCandidateCount: current.length,
    eligibleCandidateCount: eligible.length,
    selectedSymbols,
    candidates,
    dataFreshnessMs: freshnessValues.length === 0 ? null : Math.max(...freshnessValues),
  };
}
