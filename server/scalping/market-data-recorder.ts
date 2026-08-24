import { randomUUID } from "node:crypto";
import type {
  ScalpingOrderbookRecord,
  ScalpingRecordingEventRecord,
  ScalpingRecordingEventType,
  ScalpingRepository,
  ScalpingTradeRecord,
} from "../repositories/scalping-repository.js";
import {
  MARKET_DATA_RECORDER_SCHEMA_VERSION,
  NormalizedOrderbookSchema,
  NormalizedTradeSchema,
  type UsExchange,
} from "./contracts.js";
import type { ScalpingLiveEvent, ScalpingLiveRuntime } from "./live-runtime.js";
import { marketLocalParts } from "./market-time.js";

export { MARKET_DATA_RECORDER_SCHEMA_VERSION };
const MAXIMUM_RECORDING_EVENT_QUEUE_SIZE = 10_000;
const BATCH_QUEUE_CHUNK_SIZE = 1_024;
const BATCH_QUEUE_CHUNK_COMPACTION_HEAD = 64;

/** FIFO whose prefix is committed only after a durable batch succeeds. */
class RetriableBatchQueue<T> {
  private chunks: T[][] = [];
  private chunkHead = 0;
  private itemHead = 0;
  private queuedLength = 0;

  get length(): number {
    return this.queuedLength;
  }

  push(value: T): void {
    let tail = this.chunks.at(-1);
    if (!tail || tail.length >= BATCH_QUEUE_CHUNK_SIZE) {
      tail = [];
      this.chunks.push(tail);
    }
    tail.push(value);
    this.queuedLength += 1;
  }

  peek(count: number): T[] {
    if (!Number.isSafeInteger(count) || count < 0 || count > this.queuedLength) {
      throw new Error("Recorder batch peek exceeds the queued prefix.");
    }
    const result = new Array<T>(count);
    let chunkIndex = this.chunkHead;
    let itemIndex = this.itemHead;
    let written = 0;
    while (written < count) {
      const chunk = this.chunks[chunkIndex]!;
      const copied = Math.min(count - written, chunk.length - itemIndex);
      for (let offset = 0; offset < copied; offset += 1) {
        result[written + offset] = chunk[itemIndex + offset]!;
      }
      written += copied;
      chunkIndex += 1;
      itemIndex = 0;
    }
    return result;
  }

  commit(count: number): void {
    if (!Number.isSafeInteger(count) || count < 0 || count > this.queuedLength) {
      throw new Error("Recorder batch commit exceeds the queued prefix.");
    }
    let remaining = count;
    this.queuedLength -= count;
    while (remaining > 0) {
      const chunk = this.chunks[this.chunkHead]!;
      const available = chunk.length - this.itemHead;
      if (remaining < available) {
        this.itemHead += remaining;
        remaining = 0;
        break;
      }
      remaining -= available;
      chunk.length = 0;
      this.chunkHead += 1;
      this.itemHead = 0;
    }
    if (this.queuedLength === 0) {
      this.chunks.length = 0;
      this.chunkHead = 0;
      this.itemHead = 0;
      return;
    }
    if (
      this.chunkHead >= BATCH_QUEUE_CHUNK_COMPACTION_HEAD
      && this.chunkHead * 2 >= this.chunks.length
    ) {
      this.chunks = this.chunks.slice(this.chunkHead);
      this.chunkHead = 0;
    }
  }
}

export type MarketDataRecorderConfig = {
  instruments: Array<{
    symbol: string;
    exchange: UsExchange;
  }>;
  feedProfile: "standard" | "all";
  flushIntervalMs: number;
  batchSize: number;
  maximumQueueSize: number;
  retryBaseMs: number;
  retryMaxMs: number;
  closeTimeoutMs?: number;
  now?: () => number;
};

type RecorderLiveSource = Pick<ScalpingLiveRuntime, "onEvent" | "retain"> & {
  readonly state?: {
    connection: string;
    subscriptions: number;
  };
};
type RecorderStore = Pick<
  ScalpingRepository,
  "putTrades" | "putOrderbooks" | "putRecordingEvents"
>;
type RecorderPhase = "idle" | "starting" | "running" | "failed" | "stopping" | "stopped";

function expandedDate(timestamp: string): string {
  const compact = marketLocalParts(Date.parse(timestamp), "US").date;
  return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

export class MarketDataRecorder {
  private readonly now: () => number;
  private readonly closeTimeoutMs: number;
  private readonly symbols: Set<string>;
  private readonly exchanges: Readonly<Record<string, UsExchange>>;
  private readonly trades = new RetriableBatchQueue<ScalpingTradeRecord>();
  private readonly orderbooks = new RetriableBatchQueue<ScalpingOrderbookRecord>();
  private readonly recordingEvents = new RetriableBatchQueue<ScalpingRecordingEventRecord>();
  private readonly lastTradeAtBySymbol = new Map<string, string>();
  private readonly lastOrderbookAtBySymbol = new Map<string, string>();
  private phase: RecorderPhase = "idle";
  private startTask?: Promise<void>;
  private closeTask?: Promise<void>;
  private activeFlush?: Promise<void>;
  private removeListener?: () => void;
  private release?: () => void;
  private flushTimer?: NodeJS.Timeout;
  private retryAttempt = 0;
  private startedAt?: string;
  private stoppedAt?: string;
  private lastEventAt?: string;
  private lastPersistedAt?: string;
  private lastError?: {
    at: string;
    code: "start_failed" | "persistence_failed" | "release_failed";
  };
  private receivedTrades = 0;
  private receivedOrderbooks = 0;
  private persistedTrades = 0;
  private persistedOrderbooks = 0;
  private persistedRecordingEvents = 0;
  private droppedEvents = 0;
  private droppedRecordingEvents = 0;
  private rejectedEvents = 0;
  private filteredDayEvents = 0;
  private batchCursor = 0;
  private rawQueueOverflowOpen = false;
  private providerGapOpen = false;
  private providerPreviouslyConnected = false;
  private closed = false;

  constructor(
    private readonly live: RecorderLiveSource,
    private readonly store: RecorderStore,
    private readonly config: MarketDataRecorderConfig,
  ) {
    if (!config.instruments.length || config.instruments.length > 20) {
      throw new Error("Market-data recorder instruments must contain 1..20 items.");
    }
    if (!Number.isInteger(config.flushIntervalMs) || config.flushIntervalMs < 50) {
      throw new Error("Market-data recorder flush interval must be at least 50ms.");
    }
    if (!Number.isInteger(config.batchSize) || config.batchSize < 1 || config.batchSize > 5_000) {
      throw new Error("Market-data recorder batch size must be in 1..=5000.");
    }
    if (!Number.isInteger(config.maximumQueueSize) || config.maximumQueueSize < config.batchSize) {
      throw new Error("Market-data recorder queue must be at least one batch.");
    }
    if (!Number.isInteger(config.retryBaseMs) || !Number.isInteger(config.retryMaxMs)
      || config.retryBaseMs < 1 || config.retryMaxMs < config.retryBaseMs) {
      throw new Error("Market-data recorder retry bounds are invalid.");
    }
    const closeTimeoutMs = config.closeTimeoutMs ?? 25_000;
    if (!Number.isInteger(closeTimeoutMs) || closeTimeoutMs < 1) {
      throw new Error("Market-data recorder close timeout must be positive.");
    }
    const exchanges: Record<string, UsExchange> = {};
    for (const item of config.instruments) {
      const symbol = item.symbol.trim().toUpperCase();
      if (!/^[A-Z0-9][A-Z0-9._-]{0,31}$/.test(symbol)) {
        throw new Error("Market-data recorder symbol is invalid.");
      }
      if (exchanges[symbol] && exchanges[symbol] !== item.exchange) {
        throw new Error(`Market-data recorder exchange conflicts for ${symbol}.`);
      }
      exchanges[symbol] = item.exchange;
    }
    this.symbols = new Set(Object.keys(exchanges));
    this.exchanges = exchanges;
    this.now = config.now ?? Date.now;
    this.closeTimeoutMs = closeTimeoutMs;
  }

  get status() {
    const liveState = this.live.state;
    return {
      schemaVersion: MARKET_DATA_RECORDER_SCHEMA_VERSION,
      enabled: true as const,
      state: this.phase,
      marketCountry: "US" as const,
      feedProfile: this.config.feedProfile,
      instruments: [...this.symbols].map((symbol) => ({
        symbol,
        exchange: this.exchanges[symbol]!,
        ...(this.lastTradeAtBySymbol.get(symbol)
          ? { lastTradeAt: this.lastTradeAtBySymbol.get(symbol)! }
          : {}),
        ...(this.lastOrderbookAtBySymbol.get(symbol)
          ? { lastOrderbookAt: this.lastOrderbookAtBySymbol.get(symbol)! }
          : {}),
      })),
      ...(liveState ? {
        provider: {
          connection: liveState.connection,
          subscriptions: liveState.subscriptions,
        },
      } : {}),
      ...(this.startedAt ? { startedAt: this.startedAt } : {}),
      ...(this.stoppedAt ? { stoppedAt: this.stoppedAt } : {}),
      ...(this.lastEventAt ? { lastEventAt: this.lastEventAt } : {}),
      ...(this.lastPersistedAt ? { lastPersistedAt: this.lastPersistedAt } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
      counters: {
        receivedTrades: this.receivedTrades,
        receivedOrderbooks: this.receivedOrderbooks,
        persistedTrades: this.persistedTrades,
        persistedOrderbooks: this.persistedOrderbooks,
        persistedRecordingEvents: this.persistedRecordingEvents,
        droppedEvents: this.droppedEvents,
        droppedRecordingEvents: this.droppedRecordingEvents,
        rejectedEvents: this.rejectedEvents,
        filteredDayEvents: this.filteredDayEvents,
        pendingTrades: this.trades.length,
        pendingOrderbooks: this.orderbooks.length,
        pendingRecordingEvents: this.recordingEvents.length,
      },
    };
  }

  start(): Promise<void> {
    if (this.closed) return Promise.reject(new Error("Market-data recorder is closed."));
    if (this.startTask) return this.startTask;
    this.phase = "starting";
    this.removeListener = this.live.onEvent((event) => this.onEvent(event));
    const task = this.live.retain(
      [...this.symbols],
      "US",
      this.exchanges,
      { usFeedProfile: this.config.feedProfile },
    ).then((release) => {
      if (this.closed) {
        release();
        return;
      }
      this.release = release;
      this.phase = "running";
      this.startedAt = new Date(this.now()).toISOString();
      this.enqueueRecordingEvent("recorder_started", this.startedAt, {
        code: this.config.feedProfile,
        details: {
          feedProfile: this.config.feedProfile,
          instruments: [...this.symbols].map((symbol) => ({
            symbol,
            exchange: this.exchanges[symbol]!,
          })),
        },
      });
      this.scheduleFlush(this.config.flushIntervalMs);
    }).catch((error) => {
      this.phase = "failed";
      this.lastError = {
        at: new Date(this.now()).toISOString(),
        code: "start_failed",
      };
      this.enqueueRecordingEvent("diagnostic", this.lastError.at, {
        code: "start_failed",
        details: { message: errorMessage(error) },
      });
      this.removeListener?.();
      this.removeListener = undefined;
      throw error;
    });
    this.startTask = task;
    return task;
  }

  flushNow(): Promise<void> {
    if (this.activeFlush) return this.activeFlush;
    if (this.pendingCount === 0) return Promise.resolve();
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    const task = this.flushQueued().finally(() => {
      if (this.activeFlush === task) this.activeFlush = undefined;
    });
    this.activeFlush = task;
    return task;
  }

  async waitForIdle(): Promise<void> {
    while (this.activeFlush || this.pendingCount > 0) {
      if (this.activeFlush) {
        await this.activeFlush;
      } else {
        await this.flushNow();
      }
    }
  }

  close(): Promise<void> {
    if (!this.closeTask) this.closeTask = this.performClose();
    return this.closeTask;
  }

  private async performClose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.phase = "stopping";
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    this.removeListener?.();
    this.removeListener = undefined;
    const errors: unknown[] = [];
    try {
      await this.startTask;
    } catch (error) {
      errors.push(error);
    }
    try {
      this.release?.();
    } catch (error) {
      this.lastError = {
        at: new Date(this.now()).toISOString(),
        code: "release_failed",
      };
      errors.push(error);
    }
    this.release = undefined;
    const drainStartedAt = Date.now();
    const drainUntilDeadline = async () => {
      let lastPersistenceError: unknown;
      while (this.pendingCount > 0) {
        try {
          await this.flushNow();
          lastPersistenceError = undefined;
        } catch (error) {
          lastPersistenceError = error;
        }
        if (this.pendingCount === 0) return;
        const remainingMs = this.closeTimeoutMs - (Date.now() - drainStartedAt);
        if (remainingMs <= 0) {
          errors.push(lastPersistenceError ?? new Error("Market-data recorder close deadline exceeded."));
          return;
        }
        const retryMs = Math.min(
          remainingMs,
          this.config.retryMaxMs,
          this.config.retryBaseMs * 2 ** Math.min(Math.max(0, this.retryAttempt - 1), 20),
        );
        await new Promise<void>((resolve) => setTimeout(resolve, retryMs));
      }
    };
    await drainUntilDeadline();
    this.stoppedAt = new Date(this.now()).toISOString();
    if (this.startedAt && errors.length === 0) {
      this.enqueueRecordingEvent("recorder_stopped", this.stoppedAt, {
        code: "clean_shutdown",
        details: {
          persistedTrades: this.persistedTrades,
          persistedOrderbooks: this.persistedOrderbooks,
          droppedEvents: this.droppedEvents,
          rejectedEvents: this.rejectedEvents,
        },
      });
      await drainUntilDeadline();
    }
    this.phase = errors.length ? "failed" : "stopped";
    if (errors.length) throw new AggregateError(errors, "Market-data recorder did not close cleanly.");
  }

  private onEvent(event: ScalpingLiveEvent): void {
    if (this.closed) return;
    if (event.type === "connection") {
      this.onConnectionEvent(event);
      return;
    }
    if (event.marketCountry !== "US") return;
    if (event.symbol && !this.symbols.has(event.symbol)) return;
    if (event.type === "diagnostic" || event.type === "recovery") {
      this.onOperationalEvent(event);
      return;
    }
    if (!event.symbol || !this.symbols.has(event.symbol)) return;
    if (event.type === "trade") {
      const parsed = NormalizedTradeSchema.safeParse(event.payload);
      if (!parsed.success) return;
      const trade = parsed.data;
      const configuredExchange = this.exchanges[event.symbol]!;
      if (trade.symbol !== event.symbol
        || (trade.exchange !== undefined && trade.exchange !== configuredExchange)) {
        this.rejectedEvents += 1;
        return;
      }
      if (this.config.feedProfile === "standard" && trade.sessionFeed === "day") {
        this.filteredDayEvents += 1;
        return;
      }
      const receivedAt = trade.receivedAt ?? event.emittedAt;
      this.receivedTrades += 1;
      this.lastEventAt = receivedAt;
      this.lastTradeAtBySymbol.set(trade.symbol, receivedAt);
      this.enqueueTrade({
        marketCountry: "US",
        symbol: trade.symbol,
        eventId: trade.eventId,
        provider: trade.provider,
        venue: trade.market ?? "US",
        exchange: trade.exchange ?? configuredExchange,
        sessionFeed: trade.sessionFeed ?? "standard",
        sessionDate: trade.sessionDate ?? expandedDate(trade.executedAt),
        executedAt: trade.executedAt,
        receivedAt,
        price: trade.price,
        quantity: trade.quantity,
        ...(trade.tradingAmount === undefined ? {} : { tradingAmount: trade.tradingAmount }),
        side: trade.side,
        ...(trade.cumulativeVolume === undefined ? {} : { cumulativeVolume: trade.cumulativeVolume }),
        ...(trade.cumulativeTradingAmount === undefined
          ? {}
          : { cumulativeAmount: trade.cumulativeTradingAmount }),
        ...(trade.executionStrength === undefined ? {} : { executionStrength: trade.executionStrength }),
        ...(trade.executionClassCode === undefined ? {} : { executionClass: trade.executionClassCode }),
        ...(trade.bestBidPrice === undefined ? {} : { bestBidPrice: trade.bestBidPrice }),
        ...(trade.bestAskPrice === undefined ? {} : { bestAskPrice: trade.bestAskPrice }),
        recordedAt: this.now(),
      });
      return;
    }
    if (event.type === "orderbook") {
      const parsed = NormalizedOrderbookSchema.safeParse(event.payload);
      if (!parsed.success) return;
      const book = parsed.data;
      const configuredExchange = this.exchanges[event.symbol]!;
      if (book.symbol !== event.symbol
        || (book.exchange !== undefined && book.exchange !== configuredExchange)) {
        this.rejectedEvents += 1;
        return;
      }
      if (this.config.feedProfile === "standard" && book.sessionFeed === "day") {
        this.filteredDayEvents += 1;
        return;
      }
      const bestAsk = book.asks[0]!;
      const bestBid = book.bids[0]!;
      const receivedAt = book.receivedAt ?? event.emittedAt;
      this.receivedOrderbooks += 1;
      this.lastEventAt = receivedAt;
      this.lastOrderbookAtBySymbol.set(book.symbol, receivedAt);
      this.enqueueOrderbook({
        snapshotId: randomUUID(),
        marketCountry: "US",
        symbol: book.symbol,
        provider: book.provider,
        venue: book.market ?? "US",
        exchange: book.exchange ?? configuredExchange,
        sessionFeed: book.sessionFeed ?? "standard",
        sessionDate: book.sessionDate ?? expandedDate(book.observedAt),
        observedAt: book.observedAt,
        receivedAt,
        depth: book.depth ?? "top_of_book",
        asks: book.asks,
        bids: book.bids,
        ...(book.totalAskQuantity === undefined ? {} : { totalAskQuantity: book.totalAskQuantity }),
        ...(book.totalBidQuantity === undefined ? {} : { totalBidQuantity: book.totalBidQuantity }),
        bestAskPrice: bestAsk.price,
        bestAskQuantity: bestAsk.quantity,
        bestBidPrice: bestBid.price,
        bestBidQuantity: bestBid.quantity,
        recordedAt: this.now(),
      });
    }
  }

  private onConnectionEvent(event: ScalpingLiveEvent): void {
    const payload = event.payload && typeof event.payload === "object"
      ? event.payload as Record<string, unknown>
      : {};
    const state = typeof payload.state === "string" ? payload.state : "unknown";
    const code = /^[A-Za-z0-9._:-]+$/.test(state) ? state : undefined;
    this.enqueueRecordingEvent("connection_state", event.emittedAt, {
      ...(code ? { code } : {}),
      details: payload,
    });
    if (state === "connected") {
      this.providerPreviouslyConnected = true;
      this.providerGapOpen = false;
      return;
    }
    if (!this.providerPreviouslyConnected
      || this.providerGapOpen
      || !["reconnecting", "error", "closed"].includes(state)) return;
    this.providerGapOpen = true;
    for (const symbol of this.symbols) {
      this.enqueueRecordingEvent("data_gap", event.emittedAt, {
        symbol,
        code: `connection_${state}`,
        details: payload,
      });
    }
  }

  private onOperationalEvent(event: ScalpingLiveEvent): void {
    const payload = event.payload && typeof event.payload === "object"
      ? event.payload as Record<string, unknown>
      : {};
    const rawCode = typeof payload.code === "string" ? payload.code : undefined;
    const code = rawCode && /^[A-Za-z0-9._:-]+$/.test(rawCode) ? rawCode : undefined;
    if (event.type === "recovery") {
      const status = typeof payload.status === "string" ? payload.status : "unknown";
      const recoveryCode = `recovery_${status}`;
      this.enqueueRecordingEvent(status === "available" ? "diagnostic" : "data_gap", event.emittedAt, {
        ...(event.symbol ? { symbol: event.symbol } : {}),
        ...(status && /^[A-Za-z0-9._:-]+$/.test(recoveryCode) ? { code: recoveryCode } : {}),
        details: payload,
      });
      return;
    }
    const eventType: ScalpingRecordingEventType = code && (
      code.includes("subscription")
      || code.includes("day-feed")
      || code.includes("exchange-unavailable")
      || code.includes("exchange-conflict")
    )
      ? "subscription_state"
      : code && (code.includes("bar-") || code.includes("watermark-")) && code.endsWith("failed")
        ? "data_gap"
        : "diagnostic";
    this.enqueueRecordingEvent(eventType, event.emittedAt, {
      ...(event.symbol ? { symbol: event.symbol } : {}),
      ...(code ? { code } : {}),
      details: payload,
    });
  }

  private enqueueTrade(record: ScalpingTradeRecord): void {
    if (!this.hasQueueCapacity()) {
      this.droppedEvents += 1;
      this.noteQueueOverflow();
      return;
    }
    this.trades.push(record);
    this.afterEnqueue();
  }

  private enqueueOrderbook(record: ScalpingOrderbookRecord): void {
    if (!this.hasQueueCapacity()) {
      this.droppedEvents += 1;
      this.noteQueueOverflow();
      return;
    }
    this.orderbooks.push(record);
    this.afterEnqueue();
  }

  private enqueueRecordingEvent(
    eventType: ScalpingRecordingEventType,
    occurredAt: string,
    input: {
      symbol?: string;
      code?: string;
      details?: unknown;
    } = {},
    schedule = true,
  ): void {
    if (this.recordingEvents.length >= MAXIMUM_RECORDING_EVENT_QUEUE_SIZE) {
      this.droppedRecordingEvents += 1;
      return;
    }
    this.recordingEvents.push({
      eventId: randomUUID(),
      marketCountry: "US",
      ...(input.symbol ? { symbol: input.symbol } : {}),
      eventType,
      occurredAt,
      ...(input.code ? { code: input.code } : {}),
      ...(input.details === undefined ? {} : { details: input.details }),
      recordedAt: this.now(),
    });
    if (schedule) this.afterEnqueue();
  }

  private noteQueueOverflow(): void {
    if (this.rawQueueOverflowOpen) return;
    this.rawQueueOverflowOpen = true;
    this.enqueueRecordingEvent("queue_overflow", new Date(this.now()).toISOString(), {
      code: "raw_queue_full",
      details: {
        maximumQueueSize: this.config.maximumQueueSize,
        pendingTrades: this.trades.length,
        pendingOrderbooks: this.orderbooks.length,
      },
    });
  }

  private hasQueueCapacity(): boolean {
    return this.rawPendingCount < this.config.maximumQueueSize;
  }

  private get rawPendingCount(): number {
    return this.trades.length + this.orderbooks.length;
  }

  private get pendingCount(): number {
    return this.rawPendingCount + this.recordingEvents.length;
  }

  private afterEnqueue(): void {
    if (this.activeFlush) return;
    if (this.pendingCount >= this.config.batchSize) {
      if (this.flushTimer) {
        clearTimeout(this.flushTimer);
        this.flushTimer = undefined;
      }
      this.scheduleFlush(0);
    } else if (!this.flushTimer && !this.activeFlush) {
      this.scheduleFlush(this.config.flushIntervalMs);
    }
  }

  private scheduleFlush(delayMs: number): void {
    if (this.closed || this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.flushNow().catch((error) => {
        console.warn("[scalping-recorder] 시세 저장 실패:", errorMessage(error));
      });
    }, delayMs);
    this.flushTimer.unref();
  }

  private async flushQueued(): Promise<void> {
    while (this.pendingCount > 0) {
      const lengths = [this.trades.length, this.orderbooks.length, this.recordingEvents.length];
      const counts = [0, 0, 0];
      let remaining = this.config.batchSize;
      while (remaining > 0) {
        let advanced = false;
        for (let offset = 0; offset < lengths.length && remaining > 0; offset += 1) {
          const index = (this.batchCursor + offset) % lengths.length;
          if (counts[index]! >= lengths[index]!) continue;
          counts[index]! += 1;
          remaining -= 1;
          advanced = true;
        }
        if (!advanced) break;
      }
      this.batchCursor = (this.batchCursor + 1) % lengths.length;
      const [tradeCount, orderbookCount, recordingEventCount] = counts;
      const trades = this.trades.peek(tradeCount);
      const orderbooks = this.orderbooks.peek(orderbookCount);
      const recordingEvents = this.recordingEvents.peek(recordingEventCount);
      try {
        if (trades.length) await this.store.putTrades(trades);
        if (orderbooks.length) await this.store.putOrderbooks(orderbooks);
        if (recordingEvents.length) await this.store.putRecordingEvents(recordingEvents);
      } catch (error) {
        const firstFailure = this.retryAttempt === 0;
        this.retryAttempt += 1;
        this.lastError = {
          at: new Date(this.now()).toISOString(),
          code: "persistence_failed",
        };
        if (firstFailure) {
          this.enqueueRecordingEvent("persistence_error", this.lastError.at, {
            code: "write_failed",
            details: { message: errorMessage(error) },
          }, false);
        }
        if (!this.closed) {
          const retryMs = Math.min(
            this.config.retryMaxMs,
            this.config.retryBaseMs * 2 ** Math.min(this.retryAttempt - 1, 20),
          );
          this.scheduleFlush(retryMs);
        }
        throw error;
      }
      this.trades.commit(trades.length);
      this.orderbooks.commit(orderbooks.length);
      this.recordingEvents.commit(recordingEvents.length);
      this.persistedTrades += trades.length;
      this.persistedOrderbooks += orderbooks.length;
      this.persistedRecordingEvents += recordingEvents.length;
      if (this.rawPendingCount < this.config.maximumQueueSize) {
        this.rawQueueOverflowOpen = false;
      }
      if (this.retryAttempt > 0) {
        this.enqueueRecordingEvent("diagnostic", new Date(this.now()).toISOString(), {
          code: "persistence_recovered",
          details: { retryAttempts: this.retryAttempt },
        }, false);
      }
      this.retryAttempt = 0;
      this.lastPersistedAt = new Date(this.now()).toISOString();
    }
    if (!this.closed) this.scheduleFlush(this.config.flushIntervalMs);
  }
}
