import { z } from "zod";
import {
  MarketCountrySchema,
  isoTimestampSchema,
  marketSymbolSchema,
  sessionDateSchema,
  type MarketCountry,
  type MinuteInterval,
} from "./contracts.js";

const MINUTE_MS = 60_000;

export const IntradayTradeTickSchema = z.object({
  symbol: marketSymbolSchema,
  eventId: z.string().trim().min(1).max(240),
  marketCountry: MarketCountrySchema.optional(),
  executedAt: isoTimestampSchema,
  sessionDate: sessionDateSchema,
  sessionStartAt: isoTimestampSchema.optional(),
  price: z.number().finite().positive(),
  quantity: z.number().finite().positive(),
  tradingAmount: z.number().finite().positive().optional(),
}).strict();

export type IntradayTradeTick = z.infer<typeof IntradayTradeTickSchema>;

export type AggregatedIntradayBar = {
  symbol: string;
  marketCountry?: MarketCountry;
  interval: MinuteInterval;
  startAt: string;
  endAt: string;
  sessionDate: string;
  status: "forming" | "final";
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  tradingAmount: number;
  tradeCount: number;
  componentMinuteCount: number;
  quality: "available" | "partial";
  missingMinuteCount: number;
};

export type BarUpdate = {
  kind: "upsert";
  bar: AggregatedIntradayBar;
};

export type TickIngestResult = {
  accepted: boolean;
  reason?: "duplicate" | "too_late";
  updates: BarUpdate[];
};

export type IntradayBarAggregatorConfig = {
  allowedLatenessMs: number;
  maximumSeenEventIdsPerSymbol: number;
  maximumOpenMinuteBucketsPerSymbol: number;
  finalizedBarRetentionPerInterval: number;
  higherIntervalsMinutes: readonly (5 | 15 | 30 | 60)[];
};

type MutableBar = {
  symbol: string;
  marketCountry: MarketCountry;
  intervalMinutes: 1 | 5 | 15 | 30 | 60;
  startMs: number;
  endMs: number;
  sessionDate: string;
  sessionStartMs?: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  tradingAmount: number;
  tradeCount: number;
  componentMinuteCount: number;
  sourcePartial: boolean;
  firstOrderKey: string;
  lastOrderKey: string;
};

type SymbolState = {
  maximumEventMs: number;
  seenEventIds: Map<string, number>;
  openMinutes: Map<string, MutableBar>;
  higher: Map<number, Map<string, MutableBar>>;
  finalized: Map<number, AggregatedIntradayBar[]>;
  pendingPartialMinuteStartMs?: number;
};

function assertConfig(config: IntradayBarAggregatorConfig): void {
  if (!Number.isFinite(config.allowedLatenessMs) || config.allowedLatenessMs < 0) {
    throw new Error("allowedLatenessMs must be a non-negative finite number.");
  }
  for (const [name, value] of [
    ["maximumSeenEventIdsPerSymbol", config.maximumSeenEventIdsPerSymbol],
    ["maximumOpenMinuteBucketsPerSymbol", config.maximumOpenMinuteBucketsPerSymbol],
    ["finalizedBarRetentionPerInterval", config.finalizedBarRetentionPerInterval],
  ] as const) {
    if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
  }
  if (!config.higherIntervalsMinutes.length || new Set(config.higherIntervalsMinutes).size !== config.higherIntervalsMinutes.length) {
    throw new Error("higherIntervalsMinutes must contain unique supported intervals.");
  }
}

function stateKey(symbol: string, marketCountry: MarketCountry): string {
  return `${marketCountry}:${symbol}`;
}

function stateFor(states: Map<string, SymbolState>, symbol: string, marketCountry: MarketCountry): SymbolState {
  const key = stateKey(symbol, marketCountry);
  const existing = states.get(key);
  if (existing) return existing;
  const created: SymbolState = {
    maximumEventMs: Number.NEGATIVE_INFINITY,
    seenEventIds: new Map(),
    openMinutes: new Map(),
    higher: new Map(),
    finalized: new Map(),
  };
  states.set(key, created);
  return created;
}

function bucketKey(sessionDate: string, startMs: number): string {
  return `${sessionDate}:${startMs}`;
}

function toInterval(intervalMinutes: number): MinuteInterval {
  return `${intervalMinutes}m` as MinuteInterval;
}

function snapshot(bar: MutableBar, status: "forming" | "final"): AggregatedIntradayBar {
  const missingMinuteCount = Math.max(0, bar.intervalMinutes - bar.componentMinuteCount);
  return {
    symbol: bar.symbol,
    marketCountry: bar.marketCountry,
    interval: toInterval(bar.intervalMinutes),
    startAt: new Date(bar.startMs).toISOString(),
    endAt: new Date(bar.endMs).toISOString(),
    sessionDate: bar.sessionDate,
    status,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
    tradingAmount: bar.tradingAmount,
    tradeCount: bar.tradeCount,
    componentMinuteCount: bar.componentMinuteCount,
    quality: missingMinuteCount === 0 && !bar.sourcePartial ? "available" : "partial",
    missingMinuteCount,
  };
}

function rememberFinal(state: SymbolState, bar: AggregatedIntradayBar, maximum: number): void {
  const interval = Number.parseInt(bar.interval, 10);
  const values = state.finalized.get(interval) ?? [];
  values.push(bar);
  if (values.length > maximum) values.splice(0, values.length - maximum);
  state.finalized.set(interval, values);
}

function intervalStart(startMs: number, intervalMs: number, sessionStartMs?: number): number {
  if (sessionStartMs === undefined) return Math.floor(startMs / intervalMs) * intervalMs;
  return sessionStartMs + Math.floor((startMs - sessionStartMs) / intervalMs) * intervalMs;
}

function higherMutable(oneMinute: MutableBar, intervalMinutes: 5 | 15 | 30 | 60): MutableBar {
  const intervalMs = intervalMinutes * MINUTE_MS;
  const startMs = intervalStart(oneMinute.startMs, intervalMs, oneMinute.sessionStartMs);
  return {
    symbol: oneMinute.symbol,
    marketCountry: oneMinute.marketCountry,
    intervalMinutes,
    startMs,
    endMs: startMs + intervalMs,
    sessionDate: oneMinute.sessionDate,
    ...(oneMinute.sessionStartMs === undefined ? {} : { sessionStartMs: oneMinute.sessionStartMs }),
    open: oneMinute.open,
    high: oneMinute.high,
    low: oneMinute.low,
    close: oneMinute.close,
    volume: oneMinute.volume,
    tradingAmount: oneMinute.tradingAmount,
    tradeCount: oneMinute.tradeCount,
    componentMinuteCount: 1,
    sourcePartial: oneMinute.sourcePartial,
    firstOrderKey: `${oneMinute.startMs}`,
    lastOrderKey: `${oneMinute.startMs}`,
  };
}

function mergeFinalMinute(target: MutableBar, oneMinute: MutableBar): void {
  const orderKey = `${oneMinute.startMs}`;
  if (orderKey < target.firstOrderKey) {
    target.firstOrderKey = orderKey;
    target.open = oneMinute.open;
  }
  if (orderKey > target.lastOrderKey) {
    target.lastOrderKey = orderKey;
    target.close = oneMinute.close;
  }
  target.high = Math.max(target.high, oneMinute.high);
  target.low = Math.min(target.low, oneMinute.low);
  target.volume += oneMinute.volume;
  target.tradingAmount += oneMinute.tradingAmount;
  target.tradeCount += oneMinute.tradeCount;
  target.componentMinuteCount += 1;
  target.sourcePartial ||= oneMinute.sourcePartial;
}

export class IntradayBarAggregator {
  private readonly states = new Map<string, SymbolState>();

  constructor(private readonly config: IntradayBarAggregatorConfig) {
    assertConfig(config);
  }

  markDiscontinuity(
    symbol: string,
    observedAt: string,
    marketCountry: MarketCountry = "KR",
  ): void {
    const normalizedSymbol = marketSymbolSchema.parse(symbol);
    const normalizedMarket = MarketCountrySchema.parse(marketCountry);
    const observedMs = Date.parse(isoTimestampSchema.parse(observedAt));
    const state = stateFor(this.states, normalizedSymbol, normalizedMarket);
    const active = Array.from(state.openMinutes.values())
      .find((bar) => bar.startMs <= observedMs && observedMs < bar.endMs);
    if (active) {
      active.sourcePartial = true;
      state.pendingPartialMinuteStartMs = undefined;
      return;
    }
    state.pendingPartialMinuteStartMs = Math.floor(observedMs / MINUTE_MS) * MINUTE_MS;
  }

  ingest(input: IntradayTradeTick): TickIngestResult {
    const tick = IntradayTradeTickSchema.parse(input);
    const marketCountry = tick.marketCountry ?? "KR";
    const eventMs = Date.parse(tick.executedAt);
    const state = stateFor(this.states, tick.symbol, marketCountry);
    if (state.seenEventIds.has(tick.eventId)) return { accepted: false, reason: "duplicate", updates: [] };
    const currentWatermark = state.maximumEventMs - this.config.allowedLatenessMs;
    if (eventMs < currentWatermark) return { accepted: false, reason: "too_late", updates: [] };
    const startMs = Math.floor(eventMs / MINUTE_MS) * MINUTE_MS;
    const key = bucketKey(tick.sessionDate, startMs);
    let bar = state.openMinutes.get(key);
    if (!bar && state.openMinutes.size >= this.config.maximumOpenMinuteBucketsPerSymbol) {
      throw new Error(`Open minute bucket capacity exceeded for ${tick.symbol}.`);
    }
    const prospectiveWatermark = Math.max(state.maximumEventMs, eventMs) - this.config.allowedLatenessMs;
    this.pruneSeenEventIds(state, prospectiveWatermark);
    if (state.seenEventIds.size >= this.config.maximumSeenEventIdsPerSymbol) {
      throw new Error(`Active event identifier capacity exceeded for ${tick.symbol}.`);
    }
    state.seenEventIds.set(tick.eventId, eventMs);

    const orderKey = `${String(eventMs).padStart(16, "0")}:${tick.eventId}`;
    const amount = tick.tradingAmount ?? tick.price * tick.quantity;
    if (!bar) {
      bar = {
        symbol: tick.symbol,
        marketCountry,
        intervalMinutes: 1,
        startMs,
        endMs: startMs + MINUTE_MS,
        sessionDate: tick.sessionDate,
        ...(tick.sessionStartAt === undefined ? {} : { sessionStartMs: Date.parse(tick.sessionStartAt) }),
        open: tick.price,
        high: tick.price,
        low: tick.price,
        close: tick.price,
        volume: tick.quantity,
        tradingAmount: amount,
        tradeCount: 1,
        componentMinuteCount: 1,
        sourcePartial: state.pendingPartialMinuteStartMs === startMs,
        firstOrderKey: orderKey,
        lastOrderKey: orderKey,
      };
      if (state.pendingPartialMinuteStartMs !== undefined && startMs >= state.pendingPartialMinuteStartMs) {
        state.pendingPartialMinuteStartMs = undefined;
      }
      state.openMinutes.set(key, bar);
    } else {
      if (orderKey < bar.firstOrderKey) {
        bar.firstOrderKey = orderKey;
        bar.open = tick.price;
      }
      if (orderKey > bar.lastOrderKey) {
        bar.lastOrderKey = orderKey;
        bar.close = tick.price;
      }
      bar.high = Math.max(bar.high, tick.price);
      bar.low = Math.min(bar.low, tick.price);
      bar.volume += tick.quantity;
      bar.tradingAmount += amount;
      bar.tradeCount += 1;
    }
    state.maximumEventMs = Math.max(state.maximumEventMs, eventMs);
    const updates: BarUpdate[] = [{ kind: "upsert", bar: snapshot(bar, "forming") }];
    const watermark = state.maximumEventMs - this.config.allowedLatenessMs;
    updates.push(...this.finalizeThrough(state, watermark));
    this.pruneSeenEventIds(state, watermark);
    return { accepted: true, updates: this.sortUpdates(updates) };
  }

  advanceWatermark(symbol: string, observedAt: string, marketCountry: MarketCountry = "KR"): BarUpdate[] {
    const parsed = isoTimestampSchema.parse(observedAt);
    const state = stateFor(
      this.states,
      marketSymbolSchema.parse(symbol),
      MarketCountrySchema.parse(marketCountry),
    );
    state.maximumEventMs = Math.max(state.maximumEventMs, Date.parse(parsed));
    const watermark = state.maximumEventMs - this.config.allowedLatenessMs;
    const updates = this.finalizeThrough(state, watermark);
    this.pruneSeenEventIds(state, watermark);
    return this.sortUpdates(updates);
  }

  recentFinalBars(
    symbol: string,
    interval: MinuteInterval,
    marketCountry: MarketCountry = "KR",
  ): AggregatedIntradayBar[] {
    const parsedSymbol = marketSymbolSchema.parse(symbol);
    const state = this.states.get(stateKey(parsedSymbol, MarketCountrySchema.parse(marketCountry)));
    if (!state) return [];
    const minutes = Number.parseInt(interval, 10);
    return [...(state.finalized.get(minutes) ?? [])];
  }

  private finalizeThrough(state: SymbolState, watermarkMs: number): BarUpdate[] {
    const updates: BarUpdate[] = [];
    const eligibleMinutes = Array.from(state.openMinutes.entries())
      .filter(([, bar]) => bar.endMs <= watermarkMs)
      .sort(([, left], [, right]) => left.startMs - right.startMs);
    for (const [key, minute] of eligibleMinutes) {
      state.openMinutes.delete(key);
      const finalBar = snapshot(minute, "final");
      rememberFinal(state, finalBar, this.config.finalizedBarRetentionPerInterval);
      updates.push({ kind: "upsert", bar: finalBar });
      for (const interval of this.config.higherIntervalsMinutes) {
        const groups = state.higher.get(interval) ?? new Map<string, MutableBar>();
        state.higher.set(interval, groups);
        const startMs = intervalStart(minute.startMs, interval * MINUTE_MS, minute.sessionStartMs);
        const higherKey = bucketKey(minute.sessionDate, startMs);
        const existing = groups.get(higherKey);
        if (existing) mergeFinalMinute(existing, minute);
        else groups.set(higherKey, higherMutable(minute, interval));
        const current = groups.get(higherKey)!;
        updates.push({ kind: "upsert", bar: snapshot(current, "forming") });
      }
    }

    for (const interval of this.config.higherIntervalsMinutes) {
      const groups = state.higher.get(interval);
      if (!groups) continue;
      const eligible = Array.from(groups.entries())
        .filter(([, bar]) => bar.endMs <= watermarkMs)
        .sort(([, left], [, right]) => left.startMs - right.startMs);
      for (const [key, bar] of eligible) {
        groups.delete(key);
        const finalBar = snapshot(bar, "final");
        rememberFinal(state, finalBar, this.config.finalizedBarRetentionPerInterval);
        updates.push({ kind: "upsert", bar: finalBar });
      }
    }
    return updates;
  }

  private sortUpdates(updates: BarUpdate[]): BarUpdate[] {
    return updates.sort((left, right) => {
      const time = left.bar.startAt.localeCompare(right.bar.startAt);
      if (time) return time;
      const interval = Number.parseInt(left.bar.interval, 10) - Number.parseInt(right.bar.interval, 10);
      if (interval) return interval;
      return left.bar.status === right.bar.status ? 0 : left.bar.status === "final" ? -1 : 1;
    });
  }

  private pruneSeenEventIds(state: SymbolState, watermarkMs: number): void {
    for (const [eventId, eventMs] of state.seenEventIds) {
      if (eventMs < watermarkMs) state.seenEventIds.delete(eventId);
    }
  }
}
