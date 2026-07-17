import { MarketDataService, type MarketInstrument } from "./market-data-service.js";

export class InstrumentService {
  constructor(private readonly marketData: MarketDataService) {}

  search(input: {
    query: string;
    limit?: number;
    market?: string;
    assetType?: string;
  }): Promise<MarketInstrument[]> {
    const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 20)));
    return this.marketData.searchInstruments(input.query, 100).then((items) => items
      .filter((item) => !input.market || item.market.toLowerCase() === input.market.toLowerCase())
      .filter((item) => !input.assetType || item.assetType.toLowerCase() === input.assetType.toLowerCase())
      .slice(0, limit));
  }

  resolve(symbols: string[]): Promise<MarketInstrument[]> {
    return this.marketData.resolveInstruments(symbols);
  }
}
