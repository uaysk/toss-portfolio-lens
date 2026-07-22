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
import {
  marketLocalParts,
  marketSessionAnchor,
  marketTimeZone,
  zonedTimestamp,
} from "./market-time.js";
import {
  DEFAULT_KR_INTEGRATED_SESSION_WINDOWS,
  marketMinuteOfDay,
  marketSessionWindowAnchor,
  marketSessionWindows,
  marketTradingSessionDate,
  sessionWindowForBarClose,
  sessionWindowForTrade,
  validateSessionWindows,
  type MarketSessionWindow,
} from "./market-session.js";

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
  snapshotStaleAfterMs?: number;
  krSessionWindows?: readonly MarketSessionWindow[];
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

function sessionWindowClose(
  sessionDate: string,
  marketCountry: MarketCountry,
  window: MarketSessionWindow,
): { keySuffix: string; timestamp: number } | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(sessionDate)) return undefined;
  const dateEpoch = Date.UTC(
    Number(sessionDate.slice(0, 4)),
    Number(sessionDate.slice(5, 7)) - 1,
    Number(sessionDate.slice(8, 10)),
  );
  const dayOffset = (window.localDateOffset ?? 0) + Math.floor(window.closeMinute / (24 * 60));
  const minuteOfDay = window.closeMinute % (24 * 60);
  const targetDate = new Date(dateEpoch + dayOffset * 24 * 60 * MINUTE_MS)
    .toISOString().slice(0, 10).replaceAll("-", "");
  const time = `${String(Math.floor(minuteOfDay / 60)).padStart(2, "0")}`
    + `${String(minuteOfDay % 60).padStart(2, "0")}00`;
  const resolved = zonedTimestamp(targetDate, time, marketTimeZone(marketCountry));
  if (!resolved) return undefined;
  return {
    keySuffix: `${sessionDate}:${window.kind}:${window.localDateOffset ?? 0}:${window.openMinute}-${window.closeMinute}`,
    timestamp: Date.parse(resolved),
  };
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

function isCanonicalSessionRange(
  openTime: string,
  closeTime: string,
  sessionDate: string,
  marketCountry: MarketCountry,
  sessionWindows: readonly MarketSessionWindow[],
): boolean {
  const openWindow = sessionWindowForTrade(openTime, marketCountry, sessionWindows, sessionDate);
  const closeWindow = sessionWindowForBarClose(closeTime, marketCountry, sessionWindows, sessionDate);
  return Boolean(openWindow && closeWindow && openWindow === closeWindow);
}

function isCanonicalSessionBar(
  bar: AggregatedIntradayBar,
  marketCountry: MarketCountry,
  sessionWindows: readonly MarketSessionWindow[],
): boolean {
  return isCanonicalSessionRange(
    bar.startAt,
    bar.endAt,
    bar.sessionDate,
    marketCountry,
    sessionWindows,
  );
}

export function scheduledSessionIntervalClose(
  openTime: string,
  sessionDate: string,
  intervalMinutes: ScalpingInterval,
  marketCountry: MarketCountry,
  sessionWindows: readonly MarketSessionWindow[],
): { closeTime: string; truncated: boolean } | undefined {
  const window = sessionWindowForTrade(openTime, marketCountry, sessionWindows, sessionDate);
  if (!window) return undefined;
  const openMs = Date.parse(openTime);
  const anchorMs = Date.parse(marketSessionWindowAnchor(
    sessionDate,
    openTime,
    marketCountry,
    sessionWindows,
  ));
  const intervalMs = intervalMinutes * MINUTE_MS;
  if (!Number.isFinite(openMs) || !Number.isFinite(anchorMs)
    || openMs < anchorMs || (openMs - anchorMs) % intervalMs !== 0) return undefined;
  const windowCloseMs = anchorMs + (window.closeMinute - window.openMinute) * MINUTE_MS;
  const nominalCloseMs = openMs + intervalMs;
  const closeMs = Math.min(nominalCloseMs, windowCloseMs);
  if (closeMs <= openMs) return undefined;
  return {
    closeTime: new Date(closeMs).toISOString(),
    truncated: closeMs < nominalCloseMs,
  };
}

function canonicalSessionAggregatedBar(
  bar: AggregatedIntradayBar,
  marketCountry: MarketCountry,
  sessionWindows: readonly MarketSessionWindow[],
): AggregatedIntradayBar | undefined {
  const intervalMinutes = intervalNumber(bar.interval);
  const scheduled = scheduledSessionIntervalClose(
    bar.startAt,
    bar.sessionDate,
    intervalMinutes,
    marketCountry,
    sessionWindows,
  );
  if (!scheduled) return undefined;
  const nominalCloseTime = new Date(Date.parse(bar.startAt) + intervalMinutes * MINUTE_MS).toISOString();
  if (bar.endAt !== scheduled.closeTime && bar.endAt !== nominalCloseTime) return undefined;
  const normalized = scheduled.truncated ? {
    ...bar,
    endAt: scheduled.closeTime,
    quality: "partial" as const,
    missingMinuteCount: Math.max(
      bar.missingMinuteCount,
      intervalMinutes - Math.round((Date.parse(scheduled.closeTime) - Date.parse(bar.startAt)) / MINUTE_MS),
    ),
  } : bar;
  return isCanonicalSessionBar(normalized, marketCountry, sessionWindows) ? normalized : undefined;
}

export function mergeRecoveredSessionCloseRows(
  recovered: readonly IntradayBarRecord[],
  existing: readonly IntradayBarRecord[],
  marketCountry: MarketCountry,
  sessionWindows: readonly MarketSessionWindow[],
): IntradayBarRecord[] {
  const priorByOpenTime = new Map(existing
    .filter((bar) => bar.intervalMinutes === 1)
    .map((bar) => [bar.openTime, bar]));
  const output = new Map<string, IntradayBarRecord>();
  const boundaries: IntradayBarRecord[] = [];
  for (const bar of [...recovered].sort((left, right) => left.openTime.localeCompare(right.openTime))) {
    const closeWindow = sessionWindowForBarClose(bar.openTime, marketCountry, sessionWindows, bar.sessionDate);
    const exactSessionClose = closeWindow !== undefined
      && closeWindow.closeMinute % (24 * 60) === marketMinuteOfDay(bar.openTime, marketCountry)
      && sessionWindowForTrade(bar.openTime, marketCountry, sessionWindows, bar.sessionDate) === undefined;
    if (exactSessionClose) {
      boundaries.push(bar);
      continue;
    }
    if (!isCanonicalSessionRange(
      bar.openTime,
      bar.closeTime,
      bar.sessionDate,
      marketCountry,
      sessionWindows,
    )) continue;
    const existingPrior = priorByOpenTime.get(bar.openTime);
    // A REST minute is the authoritative reconstruction for that complete
    // minute. Replacing a possibly partial WS bucket before folding the
    // separate close-auction row avoids both missing executions and adding the
    // auction twice to a WS bucket that may already contain part of it.
    const preferred = bar.source === "kis_rest"
      ? bar
      : existingPrior && existingPrior.source !== "kis_rest" ? existingPrior : bar;
    priorByOpenTime.set(bar.openTime, preferred);
    output.set(bar.openTime, preferred);
  }
  for (const boundary of boundaries) {
    const priorOpenTime = new Date(Date.parse(boundary.openTime) - MINUTE_MS).toISOString();
    const prior = priorByOpenTime.get(priorOpenTime);
    if (!prior || prior.sessionDate !== boundary.sessionDate) {
      const shifted: IntradayBarRecord = {
        ...boundary,
        source: "recovered",
        openTime: priorOpenTime,
        closeTime: boundary.openTime,
        state: "final",
        quality: "partial",
      };
      output.set(priorOpenTime, shifted);
      priorByOpenTime.set(priorOpenTime, shifted);
      continue;
    }
    if (prior.source !== "kis_rest") {
      const covered: IntradayBarRecord = {
        ...prior,
        closeTime: boundary.openTime,
        state: "final",
        quality: "partial",
        updatedAt: Math.max(prior.updatedAt, boundary.updatedAt),
      };
      output.set(priorOpenTime, covered);
      priorByOpenTime.set(priorOpenTime, covered);
      continue;
    }
    const {
      volume: priorVolume,
      turnover: priorTurnover,
      tradeCount: priorTradeCount,
      ...priorBase
    } = prior;
    const merged: IntradayBarRecord = {
      ...priorBase,
      source: "recovered",
      closeTime: boundary.openTime,
      state: "final",
      high: Math.max(prior.high, boundary.high),
      low: Math.min(prior.low, boundary.low),
      close: boundary.close,
      ...(priorVolume !== undefined && boundary.volume !== undefined
        ? { volume: priorVolume + boundary.volume }
        : {}),
      ...(priorTurnover !== undefined && boundary.turnover !== undefined
        ? { turnover: priorTurnover + boundary.turnover }
        : {}),
      ...(priorTradeCount !== undefined && boundary.tradeCount !== undefined
        ? { tradeCount: priorTradeCount + boundary.tradeCount }
        : {}),
      quality: prior.quality === "partial" || prior.quality === "stale" ? "partial" : "recovered",
      updatedAt: Math.max(prior.updatedAt, boundary.updatedAt),
    };
    output.set(priorOpenTime, merged);
    priorByOpenTime.set(priorOpenTime, merged);
  }
  return [...output.values()].sort((left, right) => left.openTime.localeCompare(right.openTime));
}

function adjacentStoredSessionMinutes(
  previous: IntradayBarRecord,
  current: IntradayBarRecord,
  marketCountry: MarketCountry,
  sessionWindows: readonly MarketSessionWindow[],
): boolean {
  if (previous.sessionDate !== current.sessionDate) return false;
  const previousWindow = sessionWindowForTrade(previous.openTime, marketCountry, sessionWindows, previous.sessionDate);
  const currentWindow = sessionWindowForTrade(current.openTime, marketCountry, sessionWindows, current.sessionDate);
  if (!previousWindow || !currentWindow) return false;
  if (previousWindow === currentWindow) {
    return Date.parse(current.openTime) - Date.parse(previous.openTime) === MINUTE_MS;
  }
  const previousIndex = sessionWindows.indexOf(previousWindow);
  const currentIndex = sessionWindows.indexOf(currentWindow);
  return previousIndex >= 0
    && currentIndex === previousIndex + 1
    && marketMinuteOfDay(previous.closeTime, marketCountry) === previousWindow.closeMinute % (24 * 60)
    && marketMinuteOfDay(current.closeTime, marketCountry) === currentWindow.openMinute + 1;
}

function recoveryKnownBoundary(
  existing: readonly IntradayBarRecord[],
  sessionDate: string,
  marketCountry: MarketCountry,
  sessionWindows: readonly MarketSessionWindow[],
): number | undefined {
  const canonical = [...new Map(existing.flatMap((bar) => (
    bar.intervalMinutes === 1
      && bar.sessionDate === sessionDate
      && isCanonicalSessionRange(
        bar.openTime,
        bar.closeTime,
        bar.sessionDate,
        marketCountry,
        sessionWindows,
      )
      ? [[bar.openTime, bar] as const]
      : []
  ))).values()].sort((left, right) => left.openTime.localeCompare(right.openTime));
  if (!canonical.length) return undefined;
  for (let index = 1; index < canonical.length; index += 1) {
    if (!adjacentStoredSessionMinutes(canonical[index - 1]!, canonical[index]!, marketCountry, sessionWindows)) {
      return Date.parse(canonical[index - 1]!.openTime);
    }
  }
  return Date.parse(canonical.at(-1)!.openTime);
}

export function aggregateRecoveredBars(
  bars: readonly IntradayBarRecord[],
  intervalMinutes: ScalpingInterval,
  options: {
    sessionStartAt?: string;
    sessionWindows?: readonly MarketSessionWindow[];
    krSessionWindows?: readonly MarketSessionWindow[];
  } = {},
): IntradayBarRecord[] {
  if (intervalMinutes === 1) return [...bars];
  const intervalMs = intervalMinutes * MINUTE_MS;
  const anchorMs = options.sessionStartAt === undefined ? undefined : Date.parse(options.sessionStartAt);
  if (anchorMs !== undefined && !Number.isFinite(anchorMs)) throw new Error("Recovery session anchor is invalid.");
  const configuredWindows = options.sessionWindows ?? options.krSessionWindows;
  const groups = new Map<string, IntradayBarRecord[]>();
  const windowAnchors = new Map<string, number>();
  const configuredWindowAnchor = (
    bar: IntradayBarRecord,
    window = sessionWindowForTrade(bar.openTime, bar.marketCountry ?? "KR", configuredWindows!, bar.sessionDate),
  ): number => {
    if (!window) throw new Error("Recovery bar is outside the configured session windows.");
    const key = `${bar.marketCountry ?? "KR"}:${bar.sessionDate}:${window.kind}:${window.localDateOffset ?? 0}:${window.openMinute}`;
    const cached = windowAnchors.get(key);
    if (cached !== undefined) return cached;
    const value = Date.parse(marketSessionWindowAnchor(
      bar.sessionDate,
      bar.openTime,
      bar.marketCountry ?? "KR",
      configuredWindows!,
    ));
    windowAnchors.set(key, value);
    return value;
  };
  for (const bar of [...bars].sort((left, right) => left.openTime.localeCompare(right.openTime))) {
    if (bar.intervalMinutes !== 1) throw new Error("Recovery aggregation requires one-minute bars.");
    const marketCountry = bar.marketCountry ?? "KR";
    let openWindow: MarketSessionWindow | undefined;
    if (configuredWindows) {
      openWindow = sessionWindowForTrade(bar.openTime, marketCountry, configuredWindows, bar.sessionDate);
      const closeWindow = sessionWindowForBarClose(bar.closeTime, marketCountry, configuredWindows, bar.sessionDate);
      if (!openWindow || closeWindow !== openWindow) continue;
    }
    const openMs = Date.parse(bar.openTime);
    const barAnchorMs = configuredWindows
      ? configuredWindowAnchor(bar, openWindow)
      : anchorMs;
    const start = barAnchorMs === undefined
      ? Math.floor(openMs / intervalMs) * intervalMs
      : barAnchorMs + Math.floor((openMs - barAnchorMs) / intervalMs) * intervalMs;
    const key = `${bar.marketCountry ?? "KR"}:${bar.symbol}:${bar.sessionDate}:${start}`;
    const group = groups.get(key);
    if (group) group.push(bar);
    else groups.set(key, [bar]);
  }
  return Array.from(groups.values()).flatMap((items) => {
    const first = items[0]!;
    const last = items.at(-1)!;
    const firstMs = Date.parse(first.openTime);
    const groupAnchorMs = configuredWindows
      ? configuredWindowAnchor(first)
      : anchorMs;
    const start = groupAnchorMs === undefined
      ? Math.floor(firstMs / intervalMs) * intervalMs
      : groupAnchorMs + Math.floor((firstMs - groupAnchorMs) / intervalMs) * intervalMs;
    const completeComponents = new Set(items.map((item) => Math.floor(Date.parse(item.openTime) / MINUTE_MS))).size;
    const scheduled = configuredWindows
      ? scheduledSessionIntervalClose(
        new Date(start).toISOString(),
        first.sessionDate,
        intervalMinutes,
        first.marketCountry ?? "KR",
        configuredWindows,
      )
      : undefined;
    if (configuredWindows && !scheduled) return [];
    const closeTime = scheduled?.closeTime ?? new Date(start + intervalMs).toISOString();
    const expectedComponents = Math.round((Date.parse(closeTime) - start) / MINUTE_MS);
    const result: IntradayBarRecord = {
      marketCountry: first.marketCountry ?? "KR",
      symbol: first.symbol,
      intervalMinutes,
      openTime: new Date(start).toISOString(),
      closeTime,
      sessionDate: first.sessionDate,
      source: "recovered",
      state: items.every((item) => item.state === "final") && completeComponents === expectedComponents ? "final" : "forming",
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
      quality: !scheduled?.truncated && completeComponents === intervalMinutes
        && items.every((item) => item.quality === "complete" || item.quality === "recovered")
        ? "recovered"
        : "partial",
      updatedAt: Math.max(...items.map((item) => item.updatedAt)),
    };
    return configuredWindows && !isCanonicalSessionRange(
      result.openTime,
      result.closeTime,
      result.sessionDate,
      result.marketCountry ?? "KR",
      configuredWindows,
    ) ? [] : [result];
  });
}

type LiveReference = {
  symbol: string;
  marketCountry: MarketCountry;
  exchange?: KisUsExchangeCode;
  subscriptions: KisSubscription[];
  count: number;
  closeCursorAt: number;
};

export class ScalpingLiveRuntime {
  private readonly listeners = new Set<(event: ScalpingLiveEvent) => void>();
  private readonly replay: ScalpingLiveEvent[] = [];
  private readonly references = new Map<string, LiveReference>();
  private readonly latestBooks = new Map<string, NormalizedOrderbook>();
  private readonly latestTrades = new Map<string, NormalizedTrade>();
  private readonly tradingHalted = new Map<string, boolean>();
  private readonly recoveryInFlight = new Map<string, Promise<void>>();
  private readonly sessionCloseRecoveryInFlight = new Map<string, Promise<void>>();
  private readonly observedSessionCloses = new Map<string, number>();
  private readonly now: () => number;
  private readonly snapshotStaleAfterMs: number;
  private readonly krSessionWindows: readonly MarketSessionWindow[];
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
    if (!Number.isInteger(config.recoveryBarLimit) || config.recoveryBarLimit < 60 || config.recoveryBarLimit > 50_000) {
      throw new Error("recoveryBarLimit must be in 60..=50000.");
    }
    this.snapshotStaleAfterMs = config.snapshotStaleAfterMs ?? 120_000;
    if (!Number.isInteger(this.snapshotStaleAfterMs)
      || this.snapshotStaleAfterMs < 1_000 || this.snapshotStaleAfterMs > 3_600_000) {
      throw new Error("snapshotStaleAfterMs must be in 1000..=3600000.");
    }
    this.krSessionWindows = config.krSessionWindows ?? DEFAULT_KR_INTEGRATED_SESSION_WINDOWS;
    validateSessionWindows(this.krSessionWindows);
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
      usMarketData: {
        executionFeeds: ["standard", "day"] as const,
        standardOrderbookDepth: "top_of_book" as const,
        dayMarketOrderbook: "unavailable" as const,
      },
    };
  }

  snapshot(
    symbol: string,
    marketCountry: MarketCountry = "KR",
  ): { orderbook?: NormalizedOrderbook; trade?: NormalizedTrade; tradingHalted?: boolean } {
    const normalized = normalizedSymbol(symbol);
    const key = marketSymbolKey(normalized, marketCountry);
    const observedAt = new Date(this.now()).toISOString();
    const sessionWindows = marketSessionWindows(marketCountry, this.krSessionWindows);
    const sessionDate = marketTradingSessionDate(observedAt, marketCountry, sessionWindows);
    const activeWindow = sessionDate
      ? sessionWindowForTrade(observedAt, marketCountry, sessionWindows, sessionDate)
      : undefined;
    const fresh = (timestamp: string | undefined) => {
      const parsed = timestamp ? Date.parse(timestamp) : Number.NaN;
      return Number.isFinite(parsed) && Math.abs(this.now() - parsed) <= this.snapshotStaleAfterMs;
    };
    const book = this.latestBooks.get(key);
    const trade = this.latestTrades.get(key);
    const bookAvailable = book !== undefined
      && fresh(book.observedAt)
      && activeWindow !== undefined
      && !(marketCountry === "US" && activeWindow.kind === "day_market");
    const tradeAvailable = trade !== undefined && fresh(trade.executedAt) && activeWindow !== undefined;
    return {
      ...(bookAvailable ? { orderbook: book } : {}),
      ...(tradeAvailable ? { trade } : {}),
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
      const subscriptions: KisSubscription[] = marketCountry === "US" ? [
        { trId: "HDFSCNT0", symbol, exchange, usFeed: "standard" },
        { trId: "HDFSCNT0", symbol, exchange, usFeed: "day" },
        { trId: "HDFSASP0", symbol, exchange, usFeed: "standard" },
      ] : [
        { trId: "H0UNCNT0", symbol },
        { trId: "H0UNASP0", symbol },
      ];
      const subscribed: KisSubscription[] = [];
      const failed: Array<{ subscription: KisSubscription; error: unknown }> = [];
      for (const subscription of subscriptions) {
        try {
          this.socket.subscribe(subscription);
          subscribed.push(subscription);
        } catch (error) {
          failed.push({ subscription, error });
        }
      }
      const hasExecution = subscribed.some(({ trId }) => trId.endsWith("CNT0"));
      if (!hasExecution) {
        for (const subscription of subscribed) this.socket.unsubscribe(subscription);
        this.emit("diagnostic", symbol, marketCountry, {
          code: "subscription-unavailable",
          status: "source_unavailable",
          message: failed.map(({ error }) => error instanceof Error ? error.message : "KIS subscription failed.").join("; "),
        });
        continue;
      }
      for (const { subscription, error } of failed) {
        this.emit("diagnostic", symbol, marketCountry, {
          code: subscription.usFeed === "day" ? "us-day-feed-unavailable" : "subscription-partial",
          status: "partial",
          trId: subscription.trId,
          usFeed: subscription.usFeed,
          message: error instanceof Error ? error.message : "KIS subscription failed.",
        });
      }
      const reference = {
        symbol,
        marketCountry,
        ...(exchange ? { exchange } : {}),
        subscriptions: subscribed,
        count: 1,
        closeCursorAt: this.now(),
      };
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
          for (const closeKey of this.observedSessionCloses.keys()) {
            if (closeKey.startsWith(`${key}:`)) this.observedSessionCloses.delete(closeKey);
          }
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

  private recoverAtSessionClose(
    symbol: string,
    marketCountry: MarketCountry,
    sessionDate: string,
    sessionWindow: MarketSessionWindow,
    exchange?: KisUsExchangeCode,
  ): Promise<void> {
    const normalized = normalizedSymbol(symbol);
    if (marketCountry === "US" && !exchange) {
      return Promise.reject(new Error("US recovery requires an explicit exchange."));
    }
    const key = marketSymbolKey(normalized, marketCountry);
    const close = sessionWindowClose(sessionDate, marketCountry, sessionWindow);
    if (!close) return Promise.reject(new Error("Market session close could not be resolved."));
    const closeKey = `${key}:${close.keySuffix}`;
    const queued = this.sessionCloseRecoveryInFlight.get(closeKey);
    if (queued) return queued;
    if (this.observedSessionCloses.has(closeKey)) return this.recoveryInFlight.get(key) ?? Promise.resolve();
    this.observedSessionCloses.set(closeKey, close.timestamp);

    const current = this.recoveryInFlight.get(key);
    let task: Promise<void>;
    const refresh = () => this.performRecovery(normalized, marketCountry, exchange);
    task = (current ? current.then(refresh, refresh)
      : this.performRecovery(normalized, marketCountry, exchange)).finally(() => {
      if (this.recoveryInFlight.get(key) === task) this.recoveryInFlight.delete(key);
      if (this.sessionCloseRecoveryInFlight.get(closeKey) === task) this.sessionCloseRecoveryInFlight.delete(closeKey);
    });
    // Replacing the generic in-flight entry with the whole chain makes every
    // caller, including waitForIdle(), observe the trailing close refresh. The
    // original task's cleanup is identity-guarded and therefore cannot remove
    // this queued task prematurely.
    this.recoveryInFlight.set(key, task);
    this.sessionCloseRecoveryInFlight.set(closeKey, task);
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
    this.sessionCloseRecoveryInFlight.clear();
    this.observedSessionCloses.clear();
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
      const rejectedIndex = reference.subscriptions.findIndex((subscription) => (
        subscription.trId === event.trId
        && (subscription.usFeed ?? "standard") === (event.usFeed ?? "standard")
      ));
      if (rejectedIndex >= 0) {
        const [rejected] = reference.subscriptions.splice(rejectedIndex, 1);
        if (rejected) this.socket.unsubscribe(rejected);
      }
      const hasExecution = reference.subscriptions.some(({ trId }) => trId.endsWith("CNT0"));
      if (!hasExecution) {
        this.references.delete(key);
        this.unsubscribeReference(reference);
      }
      this.emit("diagnostic", event.symbol, event.marketCountry, {
        code: event.usFeed === "day" ? "us-day-feed-rejected" : "subscription-rejected",
        status: hasExecution ? "partial" : "source_unavailable",
        trId: event.trId,
        usFeed: event.usFeed,
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
        const configuredWindows = marketSessionWindows(event.marketCountry, this.krSessionWindows);
        const sessionWindows = event.marketCountry === "US"
          ? configuredWindows.filter(({ kind }) => event.usFeed === "day" ? kind === "day_market" : kind !== "day_market")
          : configuredWindows;
        const sessionDate = marketTradingSessionDate(
          event.providerTimestamp,
          event.marketCountry,
          sessionWindows,
        ) ?? expandedSessionDate(event.sessionDate);
        let aggregationTimestamp = event.providerTimestamp;
        let closesActiveWindow = false;
        if (!sessionWindowForTrade(aggregationTimestamp, event.marketCountry, sessionWindows, sessionDate)) {
          const local = marketLocalParts(Date.parse(event.providerTimestamp), event.marketCountry);
          closesActiveWindow = local.time.slice(4, 6) === "00"
            && sessionWindowForBarClose(event.providerTimestamp, event.marketCountry, sessionWindows, sessionDate) !== undefined;
          if (!closesActiveWindow) return;
          aggregationTimestamp = new Date(Date.parse(event.providerTimestamp) - 1).toISOString();
        }
        const sessionWindow = sessionWindowForTrade(
          aggregationTimestamp,
          event.marketCountry,
          sessionWindows,
          sessionDate,
        );
        if (!sessionWindow) return;
        const sessionStartAt = marketSessionWindowAnchor(
          sessionDate,
          aggregationTimestamp,
          event.marketCountry,
          sessionWindows,
        );
        const sessionEndAt = new Date(
          Date.parse(sessionStartAt)
          + (sessionWindow.closeMinute - sessionWindow.openMinute) * MINUTE_MS,
        ).toISOString();
        const result = this.aggregator.ingest({
          symbol: event.symbol,
          eventId: event.eventId,
          marketCountry: event.marketCountry,
          executedAt: aggregationTimestamp,
          sessionDate,
          sessionStartAt,
          sessionEndAt,
          price: event.price,
          quantity: event.executionVolume,
          tradingAmount: event.price * event.executionVolume,
        });
        if (result.accepted) this.persistUpdates(result.updates, event.marketCountry);
        if (closesActiveWindow) {
          const reference = this.references.get(key);
          if (event.marketCountry === "KR" || reference?.exchange) {
            void this.recoverAtSessionClose(
              event.symbol,
              event.marketCountry,
              sessionDate,
              sessionWindow,
              reference?.exchange,
            );
          }
        }
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
    const observedAtMs = this.now();
    const observedAt = new Date(observedAtMs).toISOString();
    const pruneBefore = observedAtMs - 3 * 24 * 60 * MINUTE_MS;
    for (const [key, timestamp] of this.observedSessionCloses) {
      if (timestamp < pruneBefore) this.observedSessionCloses.delete(key);
    }
    for (const reference of this.references.values()) {
      const previousAtMs = reference.closeCursorAt;
      reference.closeCursorAt = observedAtMs;
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
      const dates = new Set([
        marketLocalParts(previousAtMs, reference.marketCountry).date,
        marketLocalParts(observedAtMs, reference.marketCountry).date,
      ]);
      const windows = marketSessionWindows(reference.marketCountry, this.krSessionWindows);
      for (const compactDate of dates) {
        const sessionDate = expandedSessionDate(compactDate);
        for (const window of windows) {
          const close = sessionWindowClose(sessionDate, reference.marketCountry, window);
          if (!close || close.timestamp <= previousAtMs || close.timestamp > observedAtMs) continue;
          void this.recoverAtSessionClose(
            reference.symbol,
            reference.marketCountry,
            sessionDate,
            window,
            reference.exchange,
          );
        }
      }
    }
  }

  private persistUpdates(updates: readonly BarUpdate[], marketCountry: MarketCountry): void {
    if (!updates.length) return;
    const updatedAt = this.now();
    const sessionWindows = marketSessionWindows(marketCountry, this.krSessionWindows);
    const candidates = updates
      .flatMap(({ bar }) => {
        const canonical = canonicalSessionAggregatedBar(bar, marketCountry, sessionWindows);
        return canonical ? [recordFromAggregated(canonical, updatedAt, marketCountry)] : [];
      });
    const byBar = new Map<string, IntradayBarRecord>();
    for (const record of candidates) {
      const key = `${record.marketCountry ?? marketCountry}:${record.symbol}:${record.intervalMinutes}:${record.openTime}`;
      const existing = byBar.get(key);
      if (existing?.state === "final" && record.state === "forming") continue;
      byBar.set(key, record);
    }
    const records = [...byBar.values()];
    if (!records.length) return;
    for (const record of records) this.emit("bar", record.symbol, marketCountry, record);
    this.persistenceTail = this.persistenceTail.then(() => this.bars.putBars(records)).catch((error) => {
      this.emit("diagnostic", undefined, marketCountry, {
        code: "bar-persistence-failed",
        message: error instanceof Error ? error.message : "unknown bar persistence error",
      });
    });
  }

  private unsubscribeReference(reference: LiveReference): void {
    for (const subscription of reference.subscriptions.splice(0)) this.socket.unsubscribe(subscription);
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
      const providerSessionDate = localNow.date;
      const providerExpandedDate = expandedSessionDate(providerSessionDate);
      const sessionWindows = marketSessionWindows(marketCountry, this.krSessionWindows);
      const expandedDate = marketTradingSessionDate(
        new Date(now).toISOString(),
        marketCountry,
        sessionWindows,
      ) ?? providerExpandedDate;
      const existing = await Promise.resolve(this.bars.listBars({
        marketCountry,
        symbol,
        intervalMinutes: 1,
        includeForming: true,
        limit: this.config.recoveryBarLimit,
      })).catch(() => []);
      const knownBoundary = recoveryKnownBoundary(
        existing ?? [],
        expandedDate,
        marketCountry,
        sessionWindows,
      );
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
            sessionDate: providerSessionDate,
            ...(overseasCursor ? { cursor: overseasCursor } : {}),
            recordCount: Math.min(120, this.config.recoveryBarLimit),
          })
          : await this.rest.getCurrentDayMinutes({
            symbol,
            sessionDate: providerSessionDate,
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
        if (nextLocal.date !== providerSessionDate) break;
        previousOldest = oldest;
        inputTime = nextLocal.time;
        overseasCursor = `${nextLocal.date}${nextLocal.time}`;
        if (requestCount >= this.config.recoveryMaximumRequests) stoppedByConfiguredLimit = true;
      }
      const adaptedItems = Array.from(recovered.values())
        .sort((left, right) => left.timestamp.localeCompare(right.timestamp))
        .slice(-this.config.recoveryBarLimit);
      const updatedAt = this.now();
      const rawOneMinute: IntradayBarRecord[] = adaptedItems.map((bar) => {
        const openTime = new Date(Date.parse(bar.timestamp)).toISOString();
        const canonicalSessionDate = marketTradingSessionDate(
          openTime,
          marketCountry,
          sessionWindows,
        ) ?? bar.sessionDate;
        return {
          marketCountry,
          symbol: bar.symbol,
          intervalMinutes: 1,
          openTime,
          closeTime: new Date(Date.parse(openTime) + MINUTE_MS).toISOString(),
          sessionDate: canonicalSessionDate,
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
        };
      });
      const oneMinute = mergeRecoveredSessionCloseRows(
        rawOneMinute,
        existing ?? [],
        marketCountry,
        sessionWindows,
      );
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
        .flatMap((interval) => aggregateRecoveredBars(sessionBars, interval, {
          sessionStartAt,
          sessionWindows,
        }));
      if (higher.length) await this.bars.putBars(higher);
      const latestRecoveredByInterval = new Map<ScalpingInterval, IntradayBarRecord>();
      for (const bar of [...oneMinute, ...higher]) {
        const current = latestRecoveredByInterval.get(bar.intervalMinutes);
        if (!current || Date.parse(bar.openTime) > Date.parse(current.openTime)) {
          latestRecoveredByInterval.set(bar.intervalMinutes, bar);
        }
      }
      for (const bar of latestRecoveredByInterval.values()) {
        this.emit("bar", symbol, marketCountry, bar);
      }
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
        ...(marketCountry === "US" ? {
          orderbookDepth: "top_of_book",
          dayMarketOrderbook: { status: "unavailable", reason: "kis_day_market_orderbook_not_documented" },
        } : {}),
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
