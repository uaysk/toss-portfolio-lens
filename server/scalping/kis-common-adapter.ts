import {
  DataQualitySchema,
  NormalizedMinuteCandleSchema,
  NormalizedOrderbookSchema,
  NormalizedRankingSchema,
  NormalizedTradeSchema,
  type DataQuality,
  type NormalizedMinuteCandle,
  type NormalizedOrderbook,
  type NormalizedRanking,
  type NormalizedTrade,
} from "./contracts.js";
import type {
  KisFluctuationRankItem,
  KisMinuteBar,
  KisOverseasRankItem,
  KisRestResult,
  KisVolumeRankItem,
} from "./kis-rest-client.js";
import type { KisExecutionEvent, KisOrderbookEvent } from "./kis-websocket-client.js";

export type KisCommonResult<T> = {
  items: T[];
  quality: DataQuality;
};

function expandedDate(compact: string): string {
  return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
}

function quality<T>(result: KisRestResult<T>): DataQuality {
  const missing = Array.from(new Set(result.diagnostics.flatMap(({ fields }) => fields.map((field) => `row:${field}`))))
    .slice(0, 64);
  const reasons = Array.from(new Set(result.diagnostics.map(({ code }) => `kis:${code}`))).slice(0, 64);
  return DataQualitySchema.parse({
    status: result.quality === "available" ? "available"
      : result.quality === "partial" ? "partial" : "source_unavailable",
    missing,
    reasons,
    sources: ["kis"],
    observedAt: result.providerTimestamp,
  });
}

export function adaptKisVolumeRankings(result: KisRestResult<KisVolumeRankItem>): KisCommonResult<NormalizedRanking> {
  return {
    items: result.items.map((item) => NormalizedRankingSchema.parse({
      provider: "kis",
      symbol: item.symbol,
      name: item.name,
      marketCountry: "KR",
      currency: "KRW",
      rank: item.rank,
      rankedAt: result.providerTimestamp,
      price: item.price,
      changeRateRatio: item.changeRate / 100,
      volume: item.accumulatedVolume,
      tradingAmount: item.accumulatedTradingAmount,
    })),
    quality: quality(result),
  };
}

export function adaptKisFluctuationRankings(
  result: KisRestResult<KisFluctuationRankItem>,
): KisCommonResult<NormalizedRanking> {
  return {
    items: result.items.map((item) => NormalizedRankingSchema.parse({
      provider: "kis",
      symbol: item.symbol,
      name: item.name,
      marketCountry: "KR",
      currency: "KRW",
      rank: item.rank,
      rankedAt: result.providerTimestamp,
      price: item.price,
      changeRateRatio: item.changeRate / 100,
      volume: item.accumulatedVolume,
      ...(item.accumulatedTradingAmount === undefined ? {} : { tradingAmount: item.accumulatedTradingAmount }),
    })),
    quality: quality(result),
  };
}

export function adaptKisOverseasRankings(
  result: KisRestResult<KisOverseasRankItem>,
): KisCommonResult<NormalizedRanking> {
  return {
    items: result.items.map((item) => NormalizedRankingSchema.parse({
      provider: "kis",
      symbol: item.symbol,
      name: item.name,
      marketCountry: "US",
      exchange: item.exchange,
      currency: "USD",
      rank: item.rank,
      rankedAt: result.providerTimestamp,
      price: item.price,
      changeRateRatio: item.changeRate / 100,
      volume: item.accumulatedVolume,
      tradingAmount: item.accumulatedTradingAmount,
    })),
    quality: quality(result),
  };
}

export function adaptKisMinuteBars(result: KisRestResult<KisMinuteBar>): KisCommonResult<NormalizedMinuteCandle> {
  return {
    items: result.items.map((bar) => NormalizedMinuteCandleSchema.parse({
      provider: "kis",
      symbol: bar.symbol,
      timestamp: bar.timestamp,
      sessionDate: expandedDate(bar.sessionDate),
      interval: "1m",
      status: bar.status,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: bar.volume,
      ...(bar.tradingAmount === undefined ? {} : { tradingAmount: bar.tradingAmount }),
    })),
    quality: quality(result),
  };
}

export function adaptKisExecution(event: KisExecutionEvent): NormalizedTrade {
  return NormalizedTradeSchema.parse({
    provider: "kis",
    symbol: event.symbol,
    eventId: event.eventId,
    eventIdSource: "provider",
    executedAt: event.providerTimestamp,
    price: event.price,
    quantity: event.executionVolume,
    tradingAmount: event.price * event.executionVolume,
    side: "unknown",
    cumulativeVolume: event.accumulatedVolume,
    ...(event.executionStrength === undefined ? {} : { executionStrength: event.executionStrength }),
  });
}

export function adaptKisOrderbook(event: KisOrderbookEvent): NormalizedOrderbook {
  return NormalizedOrderbookSchema.parse({
    provider: "kis",
    symbol: event.symbol,
    observedAt: event.providerTimestamp,
    depth: event.depth,
    asks: event.asks.map(({ price, quantity }) => ({ price, quantity })).sort((left, right) => left.price - right.price),
    bids: event.bids.map(({ price, quantity }) => ({ price, quantity })).sort((left, right) => right.price - left.price),
    totalAskQuantity: event.totalAskQuantity,
    totalBidQuantity: event.totalBidQuantity,
  });
}
