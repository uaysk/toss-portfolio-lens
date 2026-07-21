import {
  DataQualitySchema,
  InstrumentStateSchema,
  NormalizedOrderbookSchema,
  NormalizedPriceSchema,
  NormalizedRankingSchema,
  NormalizedWarningSchema,
  VolatilityInputsSchema,
  createScannerRequestSchema,
  type DataQuality,
  type InstrumentState,
  type NormalizedOrderbook,
  type NormalizedPrice,
  type NormalizedRanking,
  type NormalizedWarning,
  type ScannerCandidate,
  type ScannerCriterion,
  type VolatilityInputs,
} from "./contracts.js";

export type VolatilityComponent = keyof Required<VolatilityInputs>;

export type ScannerConfig = {
  minimumTopCount: number;
  maximumTopCount: number;
  minimumVolume: number;
  minimumTradingAmount: number;
  maximumSpreadBps: number;
  filterLowLiquidity: boolean;
  filterWideSpread: boolean;
  blockingWarningCodes: readonly string[];
  cautionWarningCodes: readonly string[];
  minimumVolatilityComponents: number;
  volatilityWeights: Record<VolatilityComponent, number>;
  providerPrecedence: readonly ("toss" | "kis")[];
  staleAfterMs: number;
  now?: () => number;
};

export type ScannerSnapshot = {
  rankings: NormalizedRanking[];
  prices: NormalizedPrice[];
  orderbooks: NormalizedOrderbook[];
  warnings: NormalizedWarning[];
  instrumentStates: InstrumentState[];
  volatilityInputs: Readonly<Record<string, VolatilityInputs | undefined>>;
  sourceErrors?: Partial<Record<"toss" | "kis", string>>;
};

export type ScannerResult = {
  generatedAt: string;
  criterion: ScannerCriterion;
  requestedTopCount: number;
  candidates: ScannerCandidate[];
  excluded: ScannerCandidate[];
  quality: DataQuality;
};

type WorkingCandidate = ScannerCandidate & {
  rankedAt: string;
  volatilityInputs: VolatilityInputs;
  sourceSet: Set<"toss" | "kis">;
};

const COMPONENTS: VolatilityComponent[] = [
  "realizedVolatility",
  "normalizedAtr",
  "dayRangeRatio",
  "bollingerWidthExpansion",
  "relativeVolume",
  "tradingAmount",
  "spreadBps",
];

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function validateConfig(config: ScannerConfig): void {
  createScannerRequestSchema({ minimumTopCount: config.minimumTopCount, maximumTopCount: config.maximumTopCount });
  for (const [name, value] of [
    ["minimumVolume", config.minimumVolume],
    ["minimumTradingAmount", config.minimumTradingAmount],
    ["maximumSpreadBps", config.maximumSpreadBps],
    ["staleAfterMs", config.staleAfterMs],
  ] as const) {
    if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative finite number.`);
  }
  if (!Number.isInteger(config.minimumVolatilityComponents)
    || config.minimumVolatilityComponents <= 0
    || config.minimumVolatilityComponents > COMPONENTS.length) {
    throw new Error("minimumVolatilityComponents is invalid.");
  }
  let totalWeight = 0;
  for (const component of COMPONENTS) {
    const weight = config.volatilityWeights[component];
    if (!Number.isFinite(weight) || weight < 0) throw new Error(`Weight for ${component} is invalid.`);
    totalWeight += weight;
  }
  if (totalWeight <= 0) throw new Error("At least one volatility weight must be positive.");
  if (config.providerPrecedence.length !== 2 || new Set(config.providerPrecedence).size !== 2
    || !config.providerPrecedence.includes("toss") || !config.providerPrecedence.includes("kis")) {
    throw new Error("providerPrecedence must contain toss and kis exactly once.");
  }
}

function spreadBps(book: NormalizedOrderbook | undefined): number | undefined {
  const ask = book?.asks[0]?.price;
  const bid = book?.bids[0]?.price;
  if (!finite(ask) || !finite(bid) || ask <= 0 || bid <= 0 || ask < bid) return undefined;
  return ((ask - bid) / ((ask + bid) / 2)) * 10_000;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function normalizedComponentValues(
  candidates: WorkingCandidate[],
  component: VolatilityComponent,
): Map<string, number> {
  const values = candidates.flatMap((candidate) => {
    const value = candidate.volatilityInputs[component];
    return finite(value) ? [{ symbol: candidate.symbol, value }] : [];
  });
  if (!values.length) return new Map();
  const minimum = Math.min(...values.map(({ value }) => value));
  const maximum = Math.max(...values.map(({ value }) => value));
  return new Map(values.map(({ symbol, value }) => {
    const normalized = maximum === minimum ? 0.5 : (value - minimum) / (maximum - minimum);
    return [symbol, component === "spreadBps" ? 1 - normalized : normalized];
  }));
}

function latestBySymbol<T extends { symbol: string; observedAt: string }>(values: T[]): Map<string, T> {
  const result = new Map<string, T>();
  for (const value of values) {
    const current = result.get(value.symbol);
    if (!current || current.observedAt < value.observedAt) result.set(value.symbol, value);
  }
  return result;
}

export class ScalpingScanner {
  private readonly now: () => number;
  private readonly requestSchema: ReturnType<typeof createScannerRequestSchema>;
  private readonly blockingWarningCodes: Set<string>;
  private readonly cautionWarningCodes: Set<string>;

  constructor(private readonly config: ScannerConfig) {
    validateConfig(config);
    this.now = config.now ?? Date.now;
    this.requestSchema = createScannerRequestSchema({
      minimumTopCount: config.minimumTopCount,
      maximumTopCount: config.maximumTopCount,
    });
    this.blockingWarningCodes = new Set(config.blockingWarningCodes.map((value) => value.trim().toUpperCase()).filter(Boolean));
    this.cautionWarningCodes = new Set(config.cautionWarningCodes.map((value) => value.trim().toUpperCase()).filter(Boolean));
  }

  scan(request: { criterion: ScannerCriterion; topCount: number }, snapshot: ScannerSnapshot): ScannerResult {
    const parsedRequest = this.requestSchema.parse(request);
    const generatedAtMs = this.now();
    const generatedAt = new Date(generatedAtMs).toISOString();
    const parsedRankings = snapshot.rankings.map((ranking) => NormalizedRankingSchema.parse(ranking));
    const parsedPrices = snapshot.prices.map((price) => NormalizedPriceSchema.parse(price));
    const parsedBooks = snapshot.orderbooks.map((book) => NormalizedOrderbookSchema.parse(book));
    const parsedWarnings = snapshot.warnings.map((warning) => NormalizedWarningSchema.parse(warning));
    const parsedVolatility = new Map<string, VolatilityInputs>();
    for (const [symbol, inputs] of Object.entries(snapshot.volatilityInputs)) {
      if (inputs !== undefined) parsedVolatility.set(symbol, VolatilityInputsSchema.parse(inputs));
    }
    const prices = latestBySymbol(parsedPrices);
    const books = latestBySymbol(parsedBooks);
    const states = new Map(snapshot.instrumentStates.map((state) => [state.symbol, InstrumentStateSchema.parse(state)]));
    const warnings = new Map<string, NormalizedWarning[]>();
    for (const warning of parsedWarnings) warnings.set(warning.symbol, [...(warnings.get(warning.symbol) ?? []), warning]);

    const bySymbol = new Map<string, WorkingCandidate>();
    const orderedRankings = [...parsedRankings].sort((left, right) => {
      const providerOrder = this.config.providerPrecedence.indexOf(left.provider)
        - this.config.providerPrecedence.indexOf(right.provider);
      return providerOrder || left.rank - right.rank;
    });
    for (const ranking of orderedRankings) {
      const current = bySymbol.get(ranking.symbol);
      if (!current) {
        bySymbol.set(ranking.symbol, {
          symbol: ranking.symbol,
          ...(ranking.name ? { name: ranking.name } : {}),
          currency: ranking.currency,
          price: ranking.price,
          ...(ranking.changeRateRatio === undefined ? {} : { changeRateRatio: ranking.changeRateRatio }),
          ...(ranking.volume === undefined ? {} : { volume: ranking.volume }),
          ...(ranking.tradingAmount === undefined ? {} : { tradingAmount: ranking.tradingAmount }),
          providerRanks: { [ranking.provider]: ranking.rank },
          warnings: [],
          filtered: false,
          filterReasons: [],
          quality: {
            status: "available",
            missing: [],
            reasons: [],
            sources: [ranking.provider],
            observedAt: ranking.rankedAt,
          },
          rankedAt: ranking.rankedAt,
          volatilityInputs: {},
          sourceSet: new Set([ranking.provider]),
        });
        continue;
      }
      current.sourceSet.add(ranking.provider);
      current.providerRanks[ranking.provider] = Math.min(current.providerRanks[ranking.provider] ?? Number.POSITIVE_INFINITY, ranking.rank);
      if (ranking.rankedAt > current.rankedAt) current.rankedAt = ranking.rankedAt;
      if (current.volume === undefined && ranking.volume !== undefined) current.volume = ranking.volume;
      if (current.tradingAmount === undefined && ranking.tradingAmount !== undefined) current.tradingAmount = ranking.tradingAmount;
    }

    const candidates = Array.from(bySymbol.values());
    for (const candidate of candidates) {
      const quote = prices.get(candidate.symbol);
      if (quote) {
        candidate.sourceSet.add(quote.provider);
        candidate.price = quote.price;
        candidate.currency = quote.currency;
        if (quote.changeRateRatio !== undefined) candidate.changeRateRatio = quote.changeRateRatio;
        if (quote.volume !== undefined) candidate.volume = quote.volume;
        if (quote.tradingAmount !== undefined) candidate.tradingAmount = quote.tradingAmount;
        if (quote.observedAt > candidate.rankedAt) candidate.rankedAt = quote.observedAt;
      }
      candidate.warnings = warnings.get(candidate.symbol) ?? [];
      const book = books.get(candidate.symbol);
      candidate.spreadBps = spreadBps(book);
      if (book) {
        candidate.sourceSet.add(book.provider);
        if (book.observedAt > candidate.rankedAt) candidate.rankedAt = book.observedAt;
      }
      candidate.volatilityInputs = {
        ...(parsedVolatility.get(candidate.symbol) ?? {}),
        ...(candidate.tradingAmount === undefined ? {} : { tradingAmount: candidate.tradingAmount }),
        ...(candidate.spreadBps === undefined ? {} : { spreadBps: candidate.spreadBps }),
      };
      this.applyFiltersAndQuality(candidate, states.get(candidate.symbol), parsedRequest.criterion, generatedAtMs);
    }

    const scoringUniverse = candidates.filter((candidate) => !candidate.filtered);
    const normalized = new Map<VolatilityComponent, Map<string, number>>(
      COMPONENTS.map((component) => [component, normalizedComponentValues(scoringUniverse, component)]),
    );
    for (const candidate of candidates) {
      let weighted = 0;
      let totalWeight = 0;
      let count = 0;
      for (const component of COMPONENTS) {
        const value = normalized.get(component)?.get(candidate.symbol);
        const weight = this.config.volatilityWeights[component];
        if (value === undefined || weight <= 0) continue;
        weighted += value * weight;
        totalWeight += weight;
        count += 1;
      }
      if (count >= this.config.minimumVolatilityComponents && totalWeight > 0) {
        candidate.volatilityScore = weighted / totalWeight;
      } else if (parsedRequest.criterion === "volatility") {
        candidate.quality.status = "insufficient_history";
        candidate.quality.reasons = unique([
          ...candidate.quality.reasons,
          `volatility components ${count}/${this.config.minimumVolatilityComponents}`,
        ]);
      }
    }

    const eligible = candidates.filter((candidate) => !candidate.filtered).sort((left, right) => this.compare(left, right, parsedRequest.criterion));
    const excluded = candidates.filter((candidate) => candidate.filtered).sort((left, right) => this.compare(left, right, parsedRequest.criterion));
    const selected = eligible.slice(0, parsedRequest.topCount).map((candidate) => this.publicCandidate(candidate));
    const missingSources = Object.keys(snapshot.sourceErrors ?? {});
    const resultQuality = DataQualitySchema.parse({
      status: selected.length === 0 && missingSources.length ? "source_unavailable"
        : missingSources.length || selected.length < parsedRequest.topCount ? "partial" : "available",
      missing: missingSources.map((source) => `${source}_source`),
      reasons: [
        ...Object.keys(snapshot.sourceErrors ?? {}).map((source) => `${source}_source_unavailable`),
        ...(selected.length < parsedRequest.topCount ? [`only ${selected.length}/${parsedRequest.topCount} eligible candidates`] : []),
      ],
      sources: Array.from(new Set(parsedRankings.map(({ provider }) => provider))).length
        ? Array.from(new Set(parsedRankings.map(({ provider }) => provider)))
        : ["derived"],
      observedAt: generatedAt,
    });
    return {
      generatedAt,
      criterion: parsedRequest.criterion,
      requestedTopCount: parsedRequest.topCount,
      candidates: selected,
      excluded: excluded.map((candidate) => this.publicCandidate(candidate)),
      quality: resultQuality,
    };
  }

  private applyFiltersAndQuality(
    candidate: WorkingCandidate,
    state: InstrumentState | undefined,
    criterion: ScannerCriterion,
    generatedAtMs: number,
  ): void {
    const reasons: string[] = [];
    const missing: string[] = [];
    if (state?.suspended) reasons.push("trading_suspended");
    if (state?.managed) reasons.push("managed_instrument");
    if (state?.liquidationTrading) reasons.push("liquidation_trading");
    if (state?.investmentCaution) reasons.push("investment_caution");
    if (state?.unsupported) reasons.push("unsupported_instrument");
    reasons.push(...(state?.reasons ?? []));
    for (const warning of candidate.warnings) {
      const code = warning.code.toUpperCase();
      if (warning.severity === "blocking" || this.blockingWarningCodes.has(code)) reasons.push(`warning:${warning.code}`);
      else if (warning.severity === "warning" || this.cautionWarningCodes.has(code)) {
        candidate.quality.reasons.push(`caution:${warning.code}`);
      }
    }
    if (candidate.volume === undefined) missing.push("volume");
    else if (candidate.volume < this.config.minimumVolume) {
      candidate.quality.reasons.push("low_volume");
      if (this.config.filterLowLiquidity) reasons.push("low_volume");
    }
    if (candidate.tradingAmount === undefined) missing.push("trading_amount");
    else if (candidate.tradingAmount < this.config.minimumTradingAmount) {
      candidate.quality.reasons.push("low_trading_amount");
      if (this.config.filterLowLiquidity) reasons.push("low_trading_amount");
    }
    if (candidate.spreadBps === undefined) missing.push("spread");
    else if (candidate.spreadBps > this.config.maximumSpreadBps) {
      candidate.quality.reasons.push("wide_spread");
      if (this.config.filterWideSpread) reasons.push("wide_spread");
    }
    if (criterion === "volume" && candidate.volume === undefined) missing.push("ranking_metric_volume");
    if (criterion === "trading_amount" && candidate.tradingAmount === undefined) missing.push("ranking_metric_trading_amount");
    if (criterion === "volatility") {
      for (const component of COMPONENTS) {
        if (this.config.volatilityWeights[component] > 0 && !finite(candidate.volatilityInputs[component])) {
          missing.push(`volatility:${component}`);
        }
      }
    }
    const stale = generatedAtMs - Date.parse(candidate.rankedAt) > this.config.staleAfterMs;
    candidate.filtered = reasons.length > 0;
    candidate.filterReasons = unique(reasons);
    candidate.quality = DataQualitySchema.parse({
      status: stale ? "stale" : missing.length ? "partial" : "available",
      missing: unique(missing),
      reasons: unique(candidate.quality.reasons),
      sources: Array.from(candidate.sourceSet),
      observedAt: candidate.rankedAt,
    });
  }

  private compare(left: WorkingCandidate, right: WorkingCandidate, criterion: ScannerCriterion): number {
    const metric = criterion === "volume" ? "volume" : criterion === "trading_amount" ? "tradingAmount" : "volatilityScore";
    const leftValue = left[metric];
    const rightValue = right[metric];
    if (leftValue === undefined && rightValue !== undefined) return 1;
    if (leftValue !== undefined && rightValue === undefined) return -1;
    if (leftValue !== rightValue) return (rightValue ?? 0) - (leftValue ?? 0);
    const leftRank = Math.min(...Object.values(left.providerRanks).filter(finite));
    const rightRank = Math.min(...Object.values(right.providerRanks).filter(finite));
    return leftRank - rightRank || left.symbol.localeCompare(right.symbol);
  }

  private publicCandidate(candidate: WorkingCandidate): ScannerCandidate {
    const { rankedAt: _rankedAt, volatilityInputs: _volatilityInputs, sourceSet: _sourceSet, ...result } = candidate;
    return result;
  }
}
