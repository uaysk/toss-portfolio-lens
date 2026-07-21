import {
  adaptKisExecution,
  adaptKisMinuteBars,
  adaptKisOrderbook,
} from "./kis-common-adapter.js";
import type {
  AggregatedIntradayBar,
  IntradayBarAggregator,
  BarUpdate,
} from "./intraday-bar-aggregator.js";
import type { KisRestClient, KisUsExchangeCode } from "./kis-rest-client.js";
import type {
  KisWebSocketClient,
  KisWebSocketEvent,
  KisSubscription,
} from "./kis-websocket-client.js";
import type {
  IntradayBarRecord,
  ScalpingInterval,
  ScalpingRepository,
} from "../repositories/scalping-repository.js";
import type { MarketCountry, NormalizedOrderbook, NormalizedTrade } from "./contracts.js";
import { marketLocalParts, marketSessionAnchor } from "./market-time.js";

export const SCALPING_LIVE_EVENT_VERSION = "scalping-live-event/v1" as const;

const MINUTE_MS = 60_000;
const SUPPORTED_INTERVALS = [1, 5, 15, 30, 60] as const;

export type ScalpingLiveEvent = {
  schemaVersion: typeof SCALPING_LIVE_EVENT_VERSION;
  id: number;
  emittedAt: string;
  type: "connection" | "bar" | "trade" | "orderbook" | "recovery" | "diagnostic";
  symbol?: string;
  marketCountry?: MarketCountry;
  payload: unknown;
};

export type ScalpingLiveRuntimeConfig = {
  replayEventLimit: number;
  disconnectWhenIdle: boolean;
  watermarkAdvanceMs: number;
  recoveryMaximumRequests: number;
  recoveryBarLimit: number;
  now?: () => number;
};

type SocketClient = Pick<
  KisWebSocketClient,
  "onEvent" | "subscribe" | "unsubscribe" | "connect" | "disconnect" | "connectionState" | "subscriptionCount"
>;
type RestClient = Pick<KisRestClient, "getCurrentDayMinutes" | "getOverseasMinutes">;
type BarAggregator = Pick<IntradayBarAggregator, "ingest" | "advanceWatermark" | "recentFinalBars">
  & Partial<Pick<IntradayBarAggregator, "markDiscontinuity">>;
type BarStore = Pick<ScalpingRepository, "putBars" | "listBars">;

function expandedSessionDate(compact: string): string {
  if (!/^\d{8}$/.test(compact)) throw new Error("KIS session date must be YYYYMMDD.");
  return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
}

function marketSymbolKey(symbol: string, marketCountry: MarketCountry): string {
  return `${marketCountry}:${symbol}`;
}

function normalizedSymbol(value: string): string {
  const symbol = value.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9._-]{0,31}$/.test(symbol)) throw new Error("Invalid scalping symbol.");
  return symbol;
}

function intervalNumber(value: string): ScalpingInterval {
  const parsed = Number.parseInt(value, 10);
  if (!(SUPPORTED_INTERVALS as readonly number[]).includes(parsed)) throw new Error("Unsupported intraday interval.");
  return parsed as ScalpingInterval;
}

function recordFromAggregated(
  bar: AggregatedIntradayBar,
  updatedAt: number,
  marketCountry: MarketCountry,
): IntradayBarRecord {
  return {
    marketCountry,
    symbol: bar.symbol,
    intervalMinutes: intervalNumber(bar.interval),
    openTime: bar.startAt,
    closeTime: bar.endAt,
    sessionDate: bar.sessionDate,
    source: "kis_ws",
    state: bar.status,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
    turnover: bar.tradingAmount,
    tradeCount: bar.tradeCount,
    quality: bar.quality === "available" ? "complete" : "partial",
    updatedAt,
  };
}

export function aggregateRecoveredBars(
  bars: readonly IntradayBarRecord[],
  intervalMinutes: ScalpingInterval,
  options: { sessionStartAt?: string } = {},
): IntradayBarRecord[] {
  if (intervalMinutes === 1) return [...bars];
  const intervalMs = intervalMinutes * MINUTE_MS;
  const anchorMs = options.sessionStartAt === undefined ? undefined : Date.parse(options.sessionStartAt);
  if (anchorMs !== undefined && !Number.isFinite(anchorMs)) throw new Error("Recovery session anchor is invalid.");
  const groups = new Map<string, IntradayBarRecord[]>();
  for (const bar of [...bars].sort((left, right) => left.openTime.localeCompare(right.openTime))) {
    if (bar.intervalMinutes !== 1) throw new Error("Recovery aggregation requires one-minute bars.");
    const openMs = Date.parse(bar.openTime);
    const start = anchorMs === undefined
      ? Math.floor(openMs / intervalMs) * intervalMs
      : anchorMs + Math.floor((openMs - anchorMs) / intervalMs) * intervalMs;
    const key = `${bar.marketCountry ?? "KR"}:${bar.symbol}:${bar.sessionDate}:${start}`;
    groups.set(key, [...(groups.get(key) ?? []), bar]);
  }
  return Array.from(groups.values()).map((items) => {
    const first = items[0]!;
    const last = items.at(-1)!;
    const firstMs = Date.parse(first.openTime);
    const start = anchorMs === undefined
      ? Math.floor(firstMs / intervalMs) * intervalMs
      : anchorMs + Math.floor((firstMs - anchorMs) / intervalMs) * intervalMs;
    const completeComponents = new Set(items.map((item) => Math.floor(Date.parse(item.openTime) / MINUTE_MS))).size;
    return {
      marketCountry: first.marketCountry ?? "KR",
      symbol: first.symbol,
      intervalMinutes,
      openTime: new Date(start).toISOString(),
      closeTime: new Date(start + intervalMs).toISOString(),
      sessionDate: first.sessionDate,
      source: "recovered",
      state: items.every((item) => item.state === "final") && completeComponents === intervalMinutes ? "final" : "forming",
      open: first.open,
      high: Math.max(...items.map((item) => item.high)),
      low: Math.min(...items.map((item) => item.low)),
      close: last.close,
      ...(items.every((item) => item.volume !== undefined)
        ? { volume: items.reduce((sum, item) => sum + item.volume!, 0) }
        : {}),
      ...(items.every((item) => item.turnover !== undefined)
        ? { turnover: items.reduce((sum, item) => sum + item.turnover!, 0) }
        : {}),
      ...(items.every((item) => item.tradeCount !== undefined)
        ? { tradeCount: items.reduce((sum, item) => sum + item.tradeCount!, 0) }
        : {}),
      quality: completeComponents === intervalMinutes
        && items.every((item) => item.quality === "complete" || item.quality === "recovered")
        ? "recovered"
        : "partial",
      updatedAt: Math.max(...items.map((item) => item.updatedAt)),
    };
  });
}

type LiveReference = {
  symbol: string;
  marketCountry: MarketCountry;
  exchange?: KisUsExchangeCode;
  count: number;
};

export class ScalpingLiveRuntime {
  private readonly listeners = new Set<(event: ScalpingLiveEvent) => void>();
  private readonly replay: ScalpingLiveEvent[] = [];
  private readonly references = new Map<string, LiveReference>();
  private readonly latestBooks = new Map<string, NormalizedOrderbook>();
  private readonly latestTrades = new Map<string, NormalizedTrade>();
  private readonly tradingHalted = new Map<string, boolean>();
  private readonly recoveryInFlight = new Map<string, Promise<void>>();
  private readonly now: () => number;
  private readonly removeSocketListener: () => void;
  private readonly watermarkTimer: NodeJS.Timeout;
  private persistenceTail: Promise<void> = Promise.resolve();
  private nextEventId = 1;
  private previouslyConnected = false;
  private closed = false;

  constructor(
    private readonly socket: SocketClient,
    private readonly rest: RestClient,
    private readonly aggregator: BarAggregator,
    private readonly bars: BarStore,
    private readonly config: ScalpingLiveRuntimeConfig,
  ) {
    if (!Number.isInteger(config.replayEventLimit) || config.replayEventLimit < 1) {
      throw new Error("replayEventLimit must be a positive integer.");
    }
    if (!Number.isInteger(config.watermarkAdvanceMs) || config.watermarkAdvanceMs < 250 || config.watermarkAdvanceMs > 60_000) {
      throw new Error("watermarkAdvanceMs must be in 250..=60000.");
    }
    if (!Number.isInteger(config.recoveryMaximumRequests) || config.recoveryMaximumRequests < 1
      || config.recoveryMaximumRequests > 1_000) {
      throw new Error("recoveryMaximumRequests must be in 1..=1000.");
    }
    if (!Number.isInteger(config.recoveryBarLimit) || config.recoveryBarLimit < 60 || config.recoveryBarLimit > 2_000) {
      throw new Error("recoveryBarLimit must be in 60..=2000.");
    }
    this.now = config.now ?? Date.now;
    this.removeSocketListener = socket.onEvent((event) => this.onSocketEvent(event));
    this.watermarkTimer = setInterval(() => this.advanceWallClock(), config.watermarkAdvanceMs);
    this.watermarkTimer.unref();
  }

  get state() {
    return {
      connection: this.socket.connectionState,
      subscriptions: this.socket.subscriptionCount,
      symbols: Array.from(this.references.values())
        .map(({ symbol, marketCountry, exchange }) => ({ symbol, marketCountry, ...(exchange ? { exchange } : {}) }))
        .sort((left, right) => `${left.marketCountry}:${left.symbol}`.localeCompare(`${right.marketCountry}:${right.symbol}`)),
      historicalOrderbookAvailable: false as const,
    };
  }

  snapshot(
    symbol: string,
    marketCountry: MarketCountry = "KR",
  ): { orderbook?: NormalizedOrderbook; trade?: NormalizedTrade; tradingHalted?: boolean } {
    const normalized = normalizedSymbol(symbol);
    const key = marketSymbolKey(normalized, marketCountry);
    return {
      ...(this.latestBooks.get(key) ? { orderbook: this.latestBooks.get(key) } : {}),
      ...(this.latestTrades.get(key) ? { trade: this.latestTrades.get(key) } : {}),
      ...(this.tradingHalted.has(key) ? { tradingHalted: this.tradingHalted.get(key) } : {}),
    };
  }

  eventsAfter(lastEventId?: number): ScalpingLiveEvent[] {
    if (lastEventId === undefined || !Number.isSafeInteger(lastEventId) || lastEventId < 0) return [];
    return this.replay.filter((event) => event.id > lastEventId);
  }

  onEvent(listener: (event: ScalpingLiveEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async retain(
    symbols: readonly string[],
    marketCountry: MarketCountry = "KR",
    usExchanges?: Readonly<Record<string, KisUsExchangeCode>>,
  ): Promise<() => void> {
    if (this.closed) throw new Error("Scalping live runtime is closed.");
    const normalized = Array.from(new Set(symbols.map(normalizedSymbol)));
    if (marketCountry !== "KR" && marketCountry !== "US") throw new Error("Unsupported scalping market country.");
    const newlyAdded: LiveReference[] = [];
    const retainedKeys: string[] = [];
    const newlyAddedKeys = new Set<string>();
    for (const symbol of normalized) {
      const key = marketSymbolKey(symbol, marketCountry);
      const exchange = marketCountry === "US" ? usExchanges?.[symbol] : undefined;
      if (marketCountry === "US" && !exchange) {
        this.emit("diagnostic", symbol, marketCountry, {
          code: "us-exchange-unavailable",
          status: "source_unavailable",
          message: "KIS US WebSocket subscription requires an explicit NAS, NYS, or AMS exchange.",
        });
        continue;
      }
      const current = this.references.get(key);
      if (current) {
        if (current.exchange !== exchange) {
          this.emit("diagnostic", symbol, marketCountry, {
            code: "us-exchange-conflict",
            status: "source_unavailable",
            message: "The requested US exchange does not match the active subscription.",
          });
          continue;
        }
        current.count += 1;
        retainedKeys.push(key);
        continue;
      }
      const execution: KisSubscription = marketCountry === "US"
        ? { trId: "HDFSCNT0", symbol, exchange }
        : { trId: "H0UNCNT0", symbol };
      const orderbook: KisSubscription = marketCountry === "US"
        ? { trId: "HDFSASP0", symbol, exchange }
        : { trId: "H0UNASP0", symbol };
      try {
        this.socket.subscribe(execution);
        try {
          this.socket.subscribe(orderbook);
        } catch (error) {
          this.socket.unsubscribe(execution);
          throw error;
        }
      } catch (error) {
        this.emit("diagnostic", symbol, marketCountry, {
          code: "subscription-unavailable",
          status: "source_unavailable",
          message: error instanceof Error ? error.message : "KIS subscription failed.",
        });
        continue;
      }
      const reference = { symbol, marketCountry, ...(exchange ? { exchange } : {}), count: 1 };
      newlyAdded.push(reference);
      newlyAddedKeys.add(key);
      retainedKeys.push(key);
      this.references.set(key, reference);
    }
    if (retainedKeys.length === 0) return () => {};
    try {
      const retainedAt = new Date(this.now()).toISOString();
      for (const reference of newlyAdded) {
        this.aggregator.markDiscontinuity?.(reference.symbol, retainedAt, reference.marketCountry);
      }
      await this.socket.connect();
      for (const reference of newlyAdded) {
        void this.recover(reference.symbol, reference.marketCountry, reference.exchange);
      }
    } catch (error) {
      for (const reference of newlyAdded) {
        this.unsubscribeReference(reference);
        this.references.delete(marketSymbolKey(reference.symbol, reference.marketCountry));
      }
      for (const key of retainedKeys) {
        if (newlyAddedKeys.has(key)) continue;
        const reference = this.references.get(key);
        if (reference) reference.count -= 1;
      }
      throw error;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const key of retainedKeys) {
        const reference = this.references.get(key);
        if (!reference) continue;
        if (reference.count <= 1) {
          this.references.delete(key);
          this.unsubscribeReference(reference);
        } else {
          reference.count -= 1;
        }
      }
      if (this.config.disconnectWhenIdle && this.references.size === 0) this.socket.disconnect();
    };
  }

  async recover(
    symbol: string,
    marketCountry: MarketCountry = "KR",
    exchange?: KisUsExchangeCode,
  ): Promise<void> {
    const normalized = normalizedSymbol(symbol);
    if (marketCountry === "US" && !exchange) throw new Error("US recovery requires an explicit exchange.");
    const key = marketSymbolKey(normalized, marketCountry);
    const existing = this.recoveryInFlight.get(key);
    if (existing) return existing;
    const task = this.performRecovery(normalized, marketCountry, exchange).finally(() => {
      if (this.recoveryInFlight.get(key) === task) this.recoveryInFlight.delete(key);
    });
    this.recoveryInFlight.set(key, task);
    return task;
  }

  async waitForIdle(): Promise<void> {
    await Promise.allSettled([...this.recoveryInFlight.values(), this.persistenceTail]);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.watermarkTimer);
    this.removeSocketListener();
    this.socket.disconnect();
    this.listeners.clear();
    this.references.clear();
  }

  private onSocketEvent(event: KisWebSocketEvent): void {
    if (event.type === "connection") {
      const connected = event.state === "connected";
      this.emit("connection", undefined, undefined, event);
      if (!connected && this.previouslyConnected) {
        for (const reference of this.references.values()) {
          this.aggregator.markDiscontinuity?.(reference.symbol, event.providerTimestamp, reference.marketCountry);
        }
      }
      if (connected && !this.previouslyConnected) {
        for (const reference of this.references.values()) {
          this.aggregator.markDiscontinuity?.(reference.symbol, event.providerTimestamp, reference.marketCountry);
          void this.recover(reference.symbol, reference.marketCountry, reference.exchange);
        }
      }
      this.previouslyConnected = connected;
      return;
    }
    if (event.type === "subscription") {
      if (event.action !== "subscribe" || event.accepted) return;
      const key = marketSymbolKey(event.symbol, event.marketCountry);
      const reference = this.references.get(key);
      if (!reference || reference.exchange !== event.exchange) return;
      this.references.delete(key);
      this.unsubscribeReference(reference);
      this.emit("diagnostic", event.symbol, event.marketCountry, {
        code: "subscription-rejected",
        status: "source_unavailable",
        trId: event.trId,
        providerCode: event.code,
        message: event.message || "KIS rejected the market-data subscription.",
      });
      if (this.config.disconnectWhenIdle && this.references.size === 0) this.socket.disconnect();
      return;
    }
    if (event.type === "execution") {
      const trade = adaptKisExecution(event);
      const key = marketSymbolKey(trade.symbol, event.marketCountry);
      this.latestTrades.set(key, trade);
      if (event.tradingHalted !== undefined) this.tradingHalted.set(key, event.tradingHalted);
      this.emit("trade", trade.symbol, event.marketCountry, trade);
      try {
        const sessionDate = expandedSessionDate(event.sessionDate);
        const result = this.aggregator.ingest({
          symbol: event.symbol,
          eventId: event.eventId,
          marketCountry: event.marketCountry,
          executedAt: event.providerTimestamp,
          sessionDate,
          sessionStartAt: marketSessionAnchor(sessionDate, event.marketCountry),
          price: event.price,
          quantity: event.executionVolume,
          tradingAmount: event.price * event.executionVolume,
        });
        if (result.accepted) this.persistUpdates(result.updates, event.marketCountry);
      } catch (error) {
        this.emit("diagnostic", event.symbol, event.marketCountry, {
          code: "bar-ingest-failed",
          message: error instanceof Error ? error.message : "unknown bar ingest error",
        });
      }
      return;
    }
    if (event.type === "orderbook") {
      const book = adaptKisOrderbook(event);
      this.latestBooks.set(marketSymbolKey(book.symbol, event.marketCountry), book);
      this.emit("orderbook", book.symbol, event.marketCountry, book);
      return;
    }
    if (event.type === "parse_error") {
      this.emit("diagnostic", event.symbol, event.market === "US" ? "US" : event.market ? "KR" : undefined, event);
    }
  }

  private advanceWallClock(): void {
    if (this.closed || this.socket.connectionState !== "connected") return;
    const observedAt = new Date(this.now()).toISOString();
    for (const reference of this.references.values()) {
      try {
        this.persistUpdates(
          this.aggregator.advanceWatermark(reference.symbol, observedAt, reference.marketCountry),
          reference.marketCountry,
        );
      } catch (error) {
        this.emit("diagnostic", reference.symbol, reference.marketCountry, {
          code: "bar-watermark-failed",
          message: error instanceof Error ? error.message : "unknown bar watermark error",
        });
      }
    }
  }

  private persistUpdates(updates: readonly BarUpdate[], marketCountry: MarketCountry): void {
    if (!updates.length) return;
    const updatedAt = this.now();
    const records = updates.map(({ bar }) => recordFromAggregated(bar, updatedAt, marketCountry));
    for (const record of records) this.emit("bar", record.symbol, marketCountry, record);
    this.persistenceTail = this.persistenceTail.then(() => this.bars.putBars(records)).catch((error) => {
      this.emit("diagnostic", undefined, marketCountry, {
        code: "bar-persistence-failed",
        message: error instanceof Error ? error.message : "unknown bar persistence error",
      });
    });
  }

  private unsubscribeReference(reference: LiveReference): void {
    if (reference.marketCountry === "US") {
      this.socket.unsubscribe({ trId: "HDFSCNT0", symbol: reference.symbol, exchange: reference.exchange });
      this.socket.unsubscribe({ trId: "HDFSASP0", symbol: reference.symbol, exchange: reference.exchange });
      return;
    }
    this.socket.unsubscribe({ trId: "H0UNCNT0", symbol: reference.symbol });
    this.socket.unsubscribe({ trId: "H0UNASP0", symbol: reference.symbol });
  }

  private async performRecovery(
    symbol: string,
    marketCountry: MarketCountry,
    exchange?: KisUsExchangeCode,
  ): Promise<void> {
    const now = this.now();
    try {
      if (marketCountry === "US" && !exchange) throw new Error("US recovery requires an explicit exchange.");
      const localNow = marketLocalParts(now, marketCountry);
      const sessionDate = localNow.date;
      const expandedDate = expandedSessionDate(sessionDate);
      const existing = await Promise.resolve(this.bars.listBars({
        marketCountry,
        symbol,
        intervalMinutes: 1,
        includeForming: true,
        limit: this.config.recoveryBarLimit,
      })).catch(() => []);
      const knownBoundary = (existing ?? [])
        .filter((bar) => bar.sessionDate === expandedDate)
        .map((bar) => Date.parse(bar.openTime))
        .filter(Number.isFinite)
        .sort((left, right) => right - left)[0];
      const recovered = new Map<string, ReturnType<typeof adaptKisMinuteBars>["items"][number]>();
      const sourceQualities: Array<ReturnType<typeof adaptKisMinuteBars>["quality"]["status"]> = [];
      let inputTime = localNow.time;
      let overseasCursor: string | undefined;
      let previousOldest = Number.POSITIVE_INFINITY;
      let requestCount = 0;
      let stoppedByConfiguredLimit = false;
      while (requestCount < this.config.recoveryMaximumRequests) {
        const result = marketCountry === "US"
          ? await this.rest.getOverseasMinutes({
            symbol,
            exchange: exchange!,
            sessionDate,
            ...(overseasCursor ? { cursor: overseasCursor } : {}),
            recordCount: Math.min(120, this.config.recoveryBarLimit),
          })
          : await this.rest.getCurrentDayMinutes({
            symbol,
            sessionDate,
            inputTime,
            market: "UN",
            includePrevious: false,
          });
        requestCount += 1;
        const adapted = adaptKisMinuteBars(result);
        sourceQualities.push(adapted.quality.status);
        if (!adapted.items.length) break;
        let added = 0;
        for (const item of adapted.items) {
          if (!recovered.has(item.timestamp)) added += 1;
          recovered.set(item.timestamp, item);
        }
        const oldest = Math.min(...adapted.items.map((item) => Date.parse(item.timestamp)));
        if (!Number.isFinite(oldest) || oldest >= previousOldest || added === 0) break;
        if (knownBoundary !== undefined && oldest <= knownBoundary) break;
        if (recovered.size >= this.config.recoveryBarLimit) {
          stoppedByConfiguredLimit = true;
          break;
        }
        const nextCursor = oldest - 1;
        const nextLocal = marketLocalParts(nextCursor, marketCountry);
        if (nextLocal.date !== sessionDate) break;
        previousOldest = oldest;
        inputTime = nextLocal.time;
        overseasCursor = `${nextLocal.date}${nextLocal.time}`;
        if (requestCount >= this.config.recoveryMaximumRequests) stoppedByConfiguredLimit = true;
      }
      const adaptedItems = Array.from(recovered.values())
        .sort((left, right) => left.timestamp.localeCompare(right.timestamp))
        .slice(-this.config.recoveryBarLimit);
      const updatedAt = this.now();
      const oneMinute: IntradayBarRecord[] = adaptedItems.map((bar) => ({
        marketCountry,
        symbol: bar.symbol,
        intervalMinutes: 1,
        openTime: bar.timestamp,
        closeTime: new Date(Date.parse(bar.timestamp) + MINUTE_MS).toISOString(),
        sessionDate: bar.sessionDate,
        source: "kis_rest",
        state: bar.status === "final" ? "final" : "forming",
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        ...(bar.volume === undefined ? {} : { volume: bar.volume }),
        ...(bar.tradingAmount === undefined ? {} : { turnover: bar.tradingAmount }),
        quality: bar.status === "final" ? "recovered" : "partial",
        updatedAt,
      }));
      if (oneMinute.length) await this.bars.putBars(oneMinute);
      const persisted = oneMinute.length
        ? await Promise.resolve(this.bars.listBars({
          marketCountry,
          symbol,
          intervalMinutes: 1,
          includeForming: true,
          limit: this.config.recoveryBarLimit,
        })).catch(() => oneMinute)
        : [];
      const sessionBars = (persisted ?? oneMinute).filter((bar) => bar.sessionDate === expandedDate);
      const sessionStartAt = marketSessionAnchor(expandedDate, marketCountry);
      const higher = SUPPORTED_INTERVALS.filter((interval) => interval !== 1)
        .flatMap((interval) => aggregateRecoveredBars(sessionBars, interval, { sessionStartAt }));
      if (higher.length) await this.bars.putBars(higher);
      const recoveryStatus = oneMinute.length === 0 && sourceQualities.some((status) => status === "source_unavailable")
        ? "source_unavailable"
        : stoppedByConfiguredLimit || sourceQualities.some((status) => status !== "available") ? "partial" : "available";
      this.emit("recovery", symbol, marketCountry, {
        status: recoveryStatus,
        recoveredBars: oneMinute.length + higher.length,
        recoveredOneMinuteBars: oneMinute.length,
        requestCount,
        stoppedByConfiguredLimit,
        oldestTimestamp: oneMinute[0]?.openTime,
        newestTimestamp: oneMinute.at(-1)?.openTime,
        turnover: marketCountry === "US"
          ? { status: oneMinute.some((bar) => bar.turnover !== undefined) ? "available" : "unavailable", reason: "kis_overseas_eamt_per_bar" }
          : { status: "unavailable", reason: "kis_rest_exposes_cumulative_not_per_bar_turnover" },
        historicalOrderbook: { status: "unavailable", reason: "historical_orderbook_not_supplied" },
        ...(marketCountry === "US" ? { orderbookDepth: "top_of_book" } : {}),
      });
    } catch (error) {
      this.emit("recovery", symbol, marketCountry, {
        status: "source_unavailable",
        recoveredBars: 0,
        error: error instanceof Error ? error.message : "unknown recovery error",
      });
    }
  }

  private emit(
    type: ScalpingLiveEvent["type"],
    symbol: string | undefined,
    marketCountry: MarketCountry | undefined,
    payload: unknown,
  ): void {
    const event: ScalpingLiveEvent = {
      schemaVersion: SCALPING_LIVE_EVENT_VERSION,
      id: this.nextEventId++,
      emittedAt: new Date(this.now()).toISOString(),
      type,
      ...(symbol ? { symbol } : {}),
      ...(marketCountry ? { marketCountry } : {}),
      payload,
    };
    this.replay.push(event);
    if (this.replay.length > this.config.replayEventLimit) {
      this.replay.splice(0, this.replay.length - this.config.replayEventLimit);
    }
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // One SSE consumer must never interrupt provider event processing.
      }
    }
  }
}
