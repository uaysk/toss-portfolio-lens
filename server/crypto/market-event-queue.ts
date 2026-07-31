import type {
  BinanceKline,
  BinanceMarketEvent,
  BinancePublicStreamConnectionState,
} from "./binance-market-data.js";

export const MAX_MARKET_EVENT_QUEUE_DEPTH = 256;

export type MarketEventQueueClock = {
  sleep(milliseconds: number, signal: AbortSignal): Promise<void>;
};

export type QueuedMarketEvent =
  | BinanceMarketEvent
  | { kind: "model_bar"; bar: BinanceKline }
  | { kind: "disconnect"; error?: unknown }
  | { kind: "connection_state"; state: BinancePublicStreamConnectionState }
  | { kind: "inference_complete" }
  | {
    kind: "expiry_boundary";
    scheduling: "expiry_boundary_event" | "expiry_timeout";
    eligibleAfterIngressSequence: number;
    boundaryEvent?: {
      event: BinanceMarketEvent;
      ingressSequence: number;
    };
  };

type CoalescedMarketEventKind = "book_ticker" | "mark_price" | "forming_kline";
type CoalescedMarketEvent = BinanceMarketEvent;
type MarketEventQueueToken =
  | { kind: "direct_event"; event: QueuedMarketEvent; queueSequence: number }
  | {
    kind: "coalesced_event";
    eventKind: CoalescedMarketEventKind;
    segment: number;
    queueSequence: number;
  }
  | {
    kind: "agg_event";
    event: Extract<BinanceMarketEvent, { kind: "agg_trade" }>;
    ingressSequence: number;
    fillCandidate: boolean;
    segment: number;
    queueSequence: number;
  };

export type MarketEventQueueStats = {
  currentDepth: number;
  maximumDepth: number;
  maximumAllowedDepth: number;
  droppedNonFinalKlines: number;
  coalescedBookTickers: number;
  coalescedMarkPrices: number;
  preservedCriticalMarkPrices: number;
  droppedAggTrades: number;
  maximumBufferedAggTrades: number;
  overflowCount: number;
};

export class AsyncMarketEventQueue {
  private readonly events: MarketEventQueueToken[] = [];
  private readonly coalesced = new Map<string, CoalescedMarketEvent>();
  private readonly waiters = new Set<(event: QueuedMarketEvent) => void>();
  private maximumDepth = 0;
  private droppedNonFinalKlines = 0;
  private coalescedBookTickers = 0;
  private coalescedMarkPrices = 0;
  private preservedCriticalMarkPrices = 0;
  private droppedAggTrades = 0;
  private maximumBufferedAggTrades = 0;
  private overflowCount = 0;
  private queueSequence = 0;
  private coalescingSegment = 0;
  private activeFillBarrierKey: string | undefined;
  private readonly preservedMarkRiskBarrierKeys = new Set<string>();

  push(
    event: QueuedMarketEvent,
    metadata?: {
      ingressSequence?: number;
      fillCandidate?: boolean;
      fillBarrierKey?: string;
      markRiskBarrierKey?: string;
    },
  ): boolean {
    if (event.kind === "kline" && !event.final) {
      const queueSequence = ++this.queueSequence;
      const segment = this.coalescingSegment;
      const coalescedKey = this.coalescedKey("forming_kline", segment);
      const existing = this.coalesced.get(coalescedKey);
      if (existing && event.receivedAt < eventAt(existing)) {
        this.droppedNonFinalKlines += 1;
        return true;
      }
      this.coalesced.set(coalescedKey, event);
      if (existing) {
        this.droppedNonFinalKlines += 1;
        const tokenIndex = this.events.findIndex((queued) => (
          queued.kind === "coalesced_event"
          && queued.eventKind === "forming_kline"
          && queued.segment === segment
        ));
        if (tokenIndex >= 0) {
          this.events[tokenIndex] = {
            kind: "coalesced_event",
            eventKind: "forming_kline",
            segment,
            queueSequence,
          };
          this.sortByIngress();
        }
        return true;
      }
      return this.enqueue({
        kind: "coalesced_event",
        eventKind: "forming_kline",
        segment,
        queueSequence,
      });
    }
    if (
      event.kind === "mark_price"
      && metadata?.markRiskBarrierKey
      && !this.preservedMarkRiskBarrierKeys.has(metadata.markRiskBarrierKey)
    ) {
      this.preservedMarkRiskBarrierKeys.add(metadata.markRiskBarrierKey);
      this.preservedCriticalMarkPrices += 1;
      this.coalescingSegment += 1;
      return this.enqueue({
        kind: "direct_event",
        event,
        queueSequence: ++this.queueSequence,
      });
    }
    if (event.kind === "book_ticker" || event.kind === "mark_price") {
      const queueSequence = ++this.queueSequence;
      const segment = this.coalescingSegment;
      const coalescedKey = this.coalescedKey(event.kind, segment);
      const existingEvent = this.coalesced.get(coalescedKey);
      const existing = existingEvent !== undefined;
      // Exchange event time orders distinct observations. Exact ties follow
      // callback/queue order because the local receivedAt clock may roll back.
      if (existingEvent && event.eventTime < eventAt(existingEvent)) {
        if (event.kind === "book_ticker") this.coalescedBookTickers += 1;
        else this.coalescedMarkPrices += 1;
        return true;
      }
      this.coalesced.set(coalescedKey, event);
      if (existing) {
        if (event.kind === "book_ticker") this.coalescedBookTickers += 1;
        else this.coalescedMarkPrices += 1;
        const tokenIndex = this.events.findIndex((queued) => (
          queued.kind === "coalesced_event"
          && queued.eventKind === event.kind
          && queued.segment === segment
        ));
        if (tokenIndex >= 0) {
          this.events[tokenIndex] = {
            kind: "coalesced_event",
            eventKind: event.kind,
            segment,
            queueSequence,
          };
          this.sortByIngress();
        }
        return true;
      }
      return this.enqueue({
        kind: "coalesced_event",
        eventKind: event.kind,
        segment,
        queueSequence,
      });
    }
    // Preserve the first eligible aggregate trade. It is the causal fill
    // barrier. Also retain the adverse minimum and maximum while the event
    // loop is busy so a transient protective-stop crossing cannot disappear.
    // The selected set is fixed-size even under an arbitrarily large burst.
    if (event.kind === "agg_trade") {
      const ingressSequence = metadata?.ingressSequence;
      if (ingressSequence === undefined) {
        throw new Error("aggTrade ingress sequence is required.");
      }
      if (
        metadata?.fillCandidate
        && metadata.fillBarrierKey
        && metadata.fillBarrierKey !== this.activeFillBarrierKey
      ) {
        // The first eligible fill for a pending decision is a causal barrier:
        // risk observations before it and recovery observations after it must
        // never coalesce into one movable token.
        this.coalescingSegment += 1;
        this.activeFillBarrierKey = metadata.fillBarrierKey;
      }
      const token: Extract<MarketEventQueueToken, { kind: "agg_event" }> = {
        kind: "agg_event",
        event,
        ingressSequence,
        fillCandidate: metadata?.fillCandidate === true,
        segment: this.coalescingSegment,
        queueSequence: ++this.queueSequence,
      };
      const waiter = this.waiters.values().next().value as
        | ((value: QueuedMarketEvent) => void)
        | undefined;
      const buffered = this.events.filter(
        (queued): queued is Extract<MarketEventQueueToken, { kind: "agg_event" }> => (
          queued.kind === "agg_event" && queued.segment === token.segment
        ),
      );
      if (waiter && buffered.length === 0) {
        this.maximumBufferedAggTrades = Math.max(this.maximumBufferedAggTrades, 1);
        return this.enqueue(token);
      }
      const candidates = [...buffered, token];
      const selected = new Map<number, (typeof candidates)[number]>();
      const select = (candidate: (typeof candidates)[number] | undefined) => {
        if (candidate) selected.set(candidate.ingressSequence, candidate);
      };
      select(candidates.reduce(
        (earliest, candidate) => (
          !earliest || candidate.ingressSequence < earliest.ingressSequence
            ? candidate
            : earliest
        ),
        undefined as (typeof candidates)[number] | undefined,
      ));
      select(candidates
        .filter((candidate) => candidate.fillCandidate)
        .reduce(
          (earliest, candidate) => (
            !earliest || candidate.ingressSequence < earliest.ingressSequence
              ? candidate
              : earliest
          ),
          undefined as (typeof candidates)[number] | undefined,
        ));
      select(candidates.reduce(
        (minimum, candidate) => (
          !minimum || candidate.event.price < minimum.event.price ? candidate : minimum
        ),
        undefined as (typeof candidates)[number] | undefined,
      ));
      select(candidates.reduce(
        (maximum, candidate) => (
          !maximum || candidate.event.price > maximum.event.price ? candidate : maximum
        ),
        undefined as (typeof candidates)[number] | undefined,
      ));
      select(candidates.reduce(
        (latest, candidate) => (
          !latest || candidate.ingressSequence > latest.ingressSequence ? candidate : latest
        ),
        undefined as (typeof candidates)[number] | undefined,
      ));
      const selectedTokens = Array.from(selected.values())
        .sort((left, right) => left.ingressSequence - right.ingressSequence);
      this.droppedAggTrades += Math.max(0, candidates.length - selectedTokens.length);
      this.maximumBufferedAggTrades = Math.max(
        this.maximumBufferedAggTrades,
        selectedTokens.length,
      );
      for (let index = this.events.length - 1; index >= 0; index -= 1) {
        const queued = this.events[index]!;
        if (queued.kind === "agg_event" && queued.segment === token.segment) {
          this.events.splice(index, 1);
        }
      }
      if (this.events.length + selectedTokens.length > MAX_MARKET_EVENT_QUEUE_DEPTH) {
        this.overflowCount += 1;
        return false;
      }
      this.events.push(...selectedTokens);
      this.sortByIngress();
      this.maximumDepth = Math.max(this.maximumDepth, this.events.length);
      return true;
    }
    this.coalescingSegment += 1;
    return this.enqueue({
      kind: "direct_event",
      event,
      queueSequence: ++this.queueSequence,
    });
  }

  fail(error: unknown): void {
    this.events.length = 0;
    this.coalesced.clear();
    const event: QueuedMarketEvent = { kind: "disconnect", error };
    const waiter = this.waiters.values().next().value as
      | ((value: QueuedMarketEvent) => void)
      | undefined;
    if (waiter) {
      this.waiters.delete(waiter);
      waiter(event);
      return;
    }
    this.events.push({
      kind: "direct_event",
      event,
      queueSequence: ++this.queueSequence,
    });
    this.maximumDepth = Math.max(this.maximumDepth, this.events.length);
  }

  noteIgnoredAggTrade(): void {
    this.droppedAggTrades += 1;
  }

  stats(): MarketEventQueueStats {
    return {
      currentDepth: this.events.length,
      maximumDepth: this.maximumDepth,
      maximumAllowedDepth: MAX_MARKET_EVENT_QUEUE_DEPTH,
      droppedNonFinalKlines: this.droppedNonFinalKlines,
      coalescedBookTickers: this.coalescedBookTickers,
      coalescedMarkPrices: this.coalescedMarkPrices,
      preservedCriticalMarkPrices: this.preservedCriticalMarkPrices,
      droppedAggTrades: this.droppedAggTrades,
      maximumBufferedAggTrades: this.maximumBufferedAggTrades,
      overflowCount: this.overflowCount,
    };
  }

  async next(
    maximumWaitMs: number,
    clock: MarketEventQueueClock,
    signal: AbortSignal,
  ): Promise<QueuedMarketEvent | undefined> {
    const immediate = this.shift();
    if (immediate) return immediate;
    if (maximumWaitMs <= 0) return undefined;

    const localAbort = new AbortController();
    const onExternalAbort = () => localAbort.abort(signal.reason);
    signal.addEventListener("abort", onExternalAbort, { once: true });
    let waiter: ((event: QueuedMarketEvent) => void) | undefined;
    const eventPromise = new Promise<QueuedMarketEvent>((resolve) => {
      waiter = resolve;
      this.waiters.add(resolve);
    });
    const sleepPromise = clock.sleep(maximumWaitMs, localAbort.signal)
      .then(() => undefined)
      .catch((error: unknown) => {
        if (localAbort.signal.aborted && !signal.aborted) return undefined;
        throw error;
      });
    try {
      const result = await Promise.race([eventPromise, sleepPromise]);
      localAbort.abort(new Error("Market event arrived before the poll timeout."));
      return result;
    } finally {
      if (waiter) this.waiters.delete(waiter);
      signal.removeEventListener("abort", onExternalAbort);
    }
  }

  private enqueue(event: MarketEventQueueToken): boolean {
    if (this.events.length >= MAX_MARKET_EVENT_QUEUE_DEPTH) {
      this.overflowCount += 1;
      if (event.kind === "coalesced_event") {
        this.coalesced.delete(this.coalescedKey(event.eventKind, event.segment));
      }
      return false;
    }
    const waiter = this.waiters.values().next().value as
      | ((value: QueuedMarketEvent) => void)
      | undefined;
    if (waiter) {
      const resolved = this.resolveToken(event);
      if (!resolved) return true;
      this.waiters.delete(waiter);
      waiter(resolved);
      return true;
    }
    this.events.push(event);
    this.sortByIngress();
    this.maximumDepth = Math.max(this.maximumDepth, this.events.length);
    return true;
  }

  private shift(): QueuedMarketEvent | undefined {
    while (this.events.length) {
      const resolved = this.resolveToken(this.events.shift()!);
      if (resolved) return resolved;
    }
    return undefined;
  }

  private resolveToken(event: MarketEventQueueToken): QueuedMarketEvent | undefined {
    if (event.kind === "direct_event" || event.kind === "agg_event") return event.event;
    const key = this.coalescedKey(event.eventKind, event.segment);
    const resolved = this.coalesced.get(key);
    this.coalesced.delete(key);
    return resolved;
  }

  private coalescedKey(kind: CoalescedMarketEventKind, segment: number): string {
    return `${segment}:${kind}`;
  }

  private sortByIngress(): void {
    this.events.sort((left, right) => left.queueSequence - right.queueSequence);
  }
}

function eventAt(event: BinanceMarketEvent): number {
  if (event.kind === "agg_trade") return event.executedAt;
  if (event.kind === "kline") return event.receivedAt;
  return event.eventTime;
}
