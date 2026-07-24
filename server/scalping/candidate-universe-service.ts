import type {
  MarketCountry,
  NormalizedRanking,
  ScannerCriterion,
} from "./contracts.js";

export type CandidateUniverseRequest = {
  marketCountry: MarketCountry;
  rankings: readonly NormalizedRanking[];
  requestedSymbols: readonly string[];
  desiredCount: number;
  criterion: ScannerCriterion;
};

export type CandidateUniverseSelector = {
  select(request: CandidateUniverseRequest): string[];
};

export type CandidateUniverseConfig = {
  maximumCandidates: number;
};

export class CandidateUniverseService implements CandidateUniverseSelector {
  constructor(private readonly config: CandidateUniverseConfig) {
    if (!Number.isInteger(config.maximumCandidates) || config.maximumCandidates < 1) {
      throw new Error("maximumCandidates must be a positive integer.");
    }
  }

  select(request: CandidateUniverseRequest): string[] {
    const rankedSymbols = request.rankings
      .filter(({ marketCountry }) => marketCountry === request.marketCountry)
      .sort((left, right) => left.rank - right.rank || left.symbol.localeCompare(right.symbol))
      .map(({ symbol }) => symbol);
    const multiplier = request.criterion === "volatility" ? 4 : 2;
    const minimumPool = request.criterion === "volatility" ? 20 : 10;
    const rankedLimit = Math.min(
      this.config.maximumCandidates,
      Math.max(minimumPool, request.desiredCount * multiplier),
    );
    const universeLimit = Math.min(
      this.config.maximumCandidates,
      Math.max(request.requestedSymbols.length, rankedLimit),
    );
    return Array.from(new Set([...request.requestedSymbols, ...rankedSymbols]))
      .slice(0, universeLimit);
  }
}
