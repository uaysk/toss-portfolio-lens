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
import type { KisRestClient } from "./kis-rest-client.js";
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
import type { NormalizedOrderbook, NormalizedTrade } from "./contracts.js";

export const SCALPING_LIVE_EVENT_VERSION = "scalping-live-event/v1" as const;

const MINUTE_MS = 60_000;
const SUPPORTED_INTERVALS = [1, 5, 15, 30, 60] as const;

export type ScalpingLiveEvent = {
  schemaVersion: typeof SCALPING_LIVE_EVENT_VERSION;
  id: number;
  emittedAt: string;
  type: "connection" | "bar" | "trade" | "orderbook" | "recovery" | "diagnostic";
  symbol?: string;
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
type RestClient = Pick<KisRestClient, "getCurrentDayMinutes">;
type BarAggregator = Pick<IntradayBarAggregator, "ingest" | "advanceWatermark" | "recentFinalBars">;
type BarStore = Pick<ScalpingRepository, "putBars" | "listBars">;

function expandedSessionDate(compact: string): string {
  if (!/^\d{8}$/.test(compact)) throw new Error("KIS session date must be YYYYMMDD.");
  return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
}

function compactSeoulDate(timestamp: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(timestamp)).replaceAll("-", "");
}

function compactSeoulTime(timestamp: number): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Seoul",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.hour}${values.minute}${values.second}`;
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

function recordFromAggregated(bar: AggregatedIntradayBar, updatedAt: number): IntradayBarRecord {
  return {
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
): IntradayBarRecord[] {
  if (intervalMinutes === 1) return [...bars];
  const intervalMs = intervalMinutes * MINUTE_MS;
  const groups = new Map<string, IntradayBarRecord[]>();
  for (const bar of [...bars].sort((left, right) => left.openTime.localeCompare(right.openTime))) {
    if (bar.intervalMinutes !== 1) throw new Error("Recovery aggregation requires one-minute bars.");
    const start = Math.floor(Date.parse(bar.openTime) / intervalMs) * intervalMs;
    const key = `${bar.symbol}:${bar.sessionDate}:${start}`;
    groups.set(key, [...(groups.get(key) ?? []), bar]);
  }
  return Array.from(groups.values()).map((items) => {
    const first = items[0]!;
    const last = items.at(-1)!;
    const start = Math.floor(Date.parse(first.openTime) / intervalMs) * intervalMs;
    const completeComponents = new Set(items.map((item) => Math.floor(Date.parse(item.openTime) / MINUTE_MS))).size;
    return {
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
      quality: completeComponents === intervalMinutes && items.every((item) => item.quality !== "partial")
        ? "recovered"
        : "partial",
      updatedAt: Math.max(...items.map((item) => item.updatedAt)),
    };
  });
}

export class ScalpingLiveRuntime {
  private readonly listeners = new Set<(event: ScalpingLiveEvent) => void>();
  private readonly replay: ScalpingLiveEvent[] = [];
  private readonly references = new Map<string, number>();
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
      symbols: Array.from(this.references.keys()).sort(),
      historicalOrderbookAvailable: false as const,
    };
  }

  snapshot(symbol: string): { orderbook?: NormalizedOrderbook; trade?: NormalizedTrade; tradingHalted?: boolean } {
    const normalized = normalizedSymbol(symbol);
    return {
      ...(this.latestBooks.get(normalized) ? { orderbook: this.latestBooks.get(normalized) } : {}),
      ...(this.latestTrades.get(normalized) ? { trade: this.latestTrades.get(normalized) } : {}),
      ...(this.tradingHalted.has(normalized) ? { tradingHalted: this.tradingHalted.get(normalized) } : {}),
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

  async retain(symbols: readonly string[]): Promise<() => void> {
    if (this.closed) throw new Error("Scalping live runtime is closed.");
    const normalized = Array.from(new Set(symbols.map(normalizedSymbol)));
    const newlyAdded: string[] = [];
    try {
      for (const symbol of normalized) {
        const count = this.references.get(symbol) ?? 0;
        if (count === 0) {
          this.socket.subscribe({ trId: "H0UNCNT0", symbol });
          try {
            this.socket.subscribe({ trId: "H0UNASP0", symbol });
          } catch (error) {
            this.socket.unsubscribe({ trId: "H0UNCNT0", symbol });
            throw error;
          }
          newlyAdded.push(symbol);
        }
        this.references.set(symbol, count + 1);
      }
      await this.socket.connect();
      for (const symbol of newlyAdded) void this.recover(symbol);
    } catch (error) {
      for (const symbol of newlyAdded) {
        this.socket.unsubscribe({ trId: "H0UNCNT0", symbol });
        this.socket.unsubscribe({ trId: "H0UNASP0", symbol });
        this.references.delete(symbol);
      }
      throw error;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const symbol of normalized) {
        const count = this.references.get(symbol) ?? 0;
        if (count <= 1) {
          this.references.delete(symbol);
          this.socket.unsubscribe({ trId: "H0UNCNT0", symbol });
          this.socket.unsubscribe({ trId: "H0UNASP0", symbol });
        } else {
          this.references.set(symbol, count - 1);
        }
      }
      if (this.config.disconnectWhenIdle && this.references.size === 0) this.socket.disconnect();
    };
  }

  async recover(symbol: string): Promise<void> {
    const normalized = normalizedSymbol(symbol);
    const existing = this.recoveryInFlight.get(normalized);
    if (existing) return existing;
    const task = this.performRecovery(normalized).finally(() => {
      if (this.recoveryInFlight.get(normalized) === task) this.recoveryInFlight.delete(normalized);
    });
    this.recoveryInFlight.set(normalized, task);
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
      this.emit("connection", undefined, event);
      if (connected && !this.previouslyConnected) {
        for (const symbol of this.references.keys()) void this.recover(symbol);
      }
      this.previouslyConnected = connected;
      return;
    }
    if (event.type === "execution") {
      const trade = adaptKisExecution(event);
      this.latestTrades.set(trade.symbol, trade);
      this.tradingHalted.set(trade.symbol, event.tradingHalted);
      this.emit("trade", trade.symbol, trade);
      try {
        const result = this.aggregator.ingest({
          symbol: event.symbol,
          eventId: event.eventId,
          executedAt: event.providerTimestamp,
          sessionDate: expandedSessionDate(event.sessionDate),
          price: event.price,
          quantity: event.executionVolume,
          tradingAmount: event.price * event.executionVolume,
        });
        if (result.accepted) this.persistUpdates(result.updates);
      } catch (error) {
        this.emit("diagnostic", event.symbol, {
          code: "bar-ingest-failed",
          message: error instanceof Error ? error.message : "unknown bar ingest error",
        });
      }
      return;
    }
    if (event.type === "orderbook") {
      const book = adaptKisOrderbook(event);
      this.latestBooks.set(book.symbol, book);
      this.emit("orderbook", book.symbol, book);
      return;
    }
    if (event.type === "parse_error") this.emit("diagnostic", event.symbol, event);
  }

  private advanceWallClock(): void {
    if (this.closed || this.socket.connectionState !== "connected") return;
    const observedAt = new Date(this.now()).toISOString();
    for (const symbol of this.references.keys()) {
      try {
        this.persistUpdates(this.aggregator.advanceWatermark(symbol, observedAt));
      } catch (error) {
        this.emit("diagnostic", symbol, {
          code: "bar-watermark-failed",
          message: error instanceof Error ? error.message : "unknown bar watermark error",
        });
      }
    }
  }

  private persistUpdates(updates: readonly BarUpdate[]): void {
    if (!updates.length) return;
    const updatedAt = this.now();
    const records = updates.map(({ bar }) => recordFromAggregated(bar, updatedAt));
    for (const record of records) this.emit("bar", record.symbol, record);
    this.persistenceTail = this.persistenceTail.then(() => this.bars.putBars(records)).catch((error) => {
      this.emit("diagnostic", undefined, {
        code: "bar-persistence-failed",
        message: error instanceof Error ? error.message : "unknown bar persistence error",
      });
    });
  }

  private async performRecovery(symbol: string): Promise<void> {
    const now = this.now();
    try {
      const sessionDate = compactSeoulDate(now);
      const expandedDate = expandedSessionDate(sessionDate);
      const existing = await Promise.resolve(this.bars.listBars({
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
      let inputTime = compactSeoulTime(now);
      let previousOldest = Number.POSITIVE_INFINITY;
      let requestCount = 0;
      let stoppedByConfiguredLimit = false;
      while (requestCount < this.config.recoveryMaximumRequests) {
        const result = await this.rest.getCurrentDayMinutes({
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
        if (compactSeoulDate(nextCursor) !== sessionDate) break;
        previousOldest = oldest;
        inputTime = compactSeoulTime(nextCursor);
        if (requestCount >= this.config.recoveryMaximumRequests) stoppedByConfiguredLimit = true;
      }
      const adaptedItems = Array.from(recovered.values())
        .sort((left, right) => left.timestamp.localeCompare(right.timestamp))
        .slice(-this.config.recoveryBarLimit);
      const updatedAt = this.now();
      const oneMinute: IntradayBarRecord[] = adaptedItems.map((bar) => ({
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
        quality: sourceQualities.every((status) => status === "available") && bar.volume !== undefined ? "recovered" : "partial",
        updatedAt,
      }));
      if (oneMinute.length) await this.bars.putBars(oneMinute);
      const persisted = oneMinute.length
        ? await Promise.resolve(this.bars.listBars({
          symbol,
          intervalMinutes: 1,
          includeForming: true,
          limit: this.config.recoveryBarLimit,
        })).catch(() => oneMinute)
        : [];
      const sessionBars = (persisted ?? oneMinute).filter((bar) => bar.sessionDate === expandedDate);
      const higher = SUPPORTED_INTERVALS.filter((interval) => interval !== 1)
        .flatMap((interval) => aggregateRecoveredBars(sessionBars, interval));
      if (higher.length) await this.bars.putBars(higher);
      const recoveryStatus = oneMinute.length === 0 && sourceQualities.some((status) => status === "source_unavailable")
        ? "source_unavailable"
        : stoppedByConfiguredLimit || sourceQualities.some((status) => status !== "available") ? "partial" : "available";
      this.emit("recovery", symbol, {
        status: recoveryStatus,
        recoveredBars: oneMinute.length + higher.length,
        recoveredOneMinuteBars: oneMinute.length,
        requestCount,
        stoppedByConfiguredLimit,
        oldestTimestamp: oneMinute[0]?.openTime,
        newestTimestamp: oneMinute.at(-1)?.openTime,
        turnover: { status: "unavailable", reason: "kis_rest_exposes_cumulative_not_per_bar_turnover" },
        historicalOrderbook: { status: "unavailable", reason: "historical_orderbook_not_supplied" },
      });
    } catch (error) {
      this.emit("recovery", symbol, {
        status: "source_unavailable",
        recoveredBars: 0,
        error: error instanceof Error ? error.message : "unknown recovery error",
      });
    }
  }

  private emit(type: ScalpingLiveEvent["type"], symbol: string | undefined, payload: unknown): void {
    const event: ScalpingLiveEvent = {
      schemaVersion: SCALPING_LIVE_EVENT_VERSION,
      id: this.nextEventId++,
      emittedAt: new Date(this.now()).toISOString(),
      type,
      ...(symbol ? { symbol } : {}),
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
