import { createHash } from "node:crypto";
import {
  PORTFOLIO_EVENT_SCHEMA_VERSION,
  type PortfolioEventV1,
} from "../contracts/portfolio-events.js";
import type { Portfolio } from "../toss.js";

const DEFAULT_REFRESH_INTERVAL_MS = 1_000;
const DEFAULT_IDLE_TTL_MS = 30_000;
const DEFAULT_MAX_HUBS = 128;
const DEFAULT_MAX_LISTENERS_PER_HUB = 32;

type PortfolioEventListener = (event: PortfolioEventV1) => void;

type PortfolioStream = {
  key: string;
  ownerSubject: string;
  accountId: string;
  revision: number;
  checksum?: string;
  latest?: PortfolioEventV1;
  listeners: Set<PortfolioEventListener>;
  refreshTask?: Promise<PortfolioEventV1>;
  refreshTimer?: ReturnType<typeof setTimeout>;
  evictionTimer?: ReturnType<typeof setTimeout>;
  lastAccessAt: number;
};

export type PortfolioLiveHubTelemetry = {
  capacity: number;
  hubs: number;
  activeHubs: number;
  subscribers: number;
  refreshesTotal: number;
  changedTotal: number;
  unchangedTotal: number;
  rejectedTotal: number;
  errorsTotal: number;
};

export type PortfolioLiveHubOptions = {
  getPortfolio: (
    ownerSubject: string,
    accountId: string,
  ) => Promise<Portfolio>;
  refreshIntervalMs?: number;
  idleTtlMs?: number;
  maxHubs?: number;
  maxListenersPerHub?: number;
  now?: () => number;
  logError?: (error: unknown) => void;
};

export type PortfolioLiveSubscription = {
  ready: Promise<PortfolioEventV1>;
  release: () => void;
};

export class PortfolioLiveBusyError extends Error {
  readonly code = "PORTFOLIO_LIVE_BUSY";
  readonly retryable = true;

  constructor(message = "Portfolio live stream capacity is full.") {
    super(message);
    this.name = "PortfolioLiveBusyError";
  }
}

function streamKey(ownerSubject: string, accountId: string): string {
  return `${ownerSubject}\u0000${accountId}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

export function portfolioContentChecksum(portfolio: Portfolio): string {
  const stableContent = {
    accounts: portfolio.accounts,
    selectedAccountId: portfolio.selectedAccountId,
    account: portfolio.account,
    summary: portfolio.summary,
    holdings: portfolio.holdings,
  };
  return createHash("sha256").update(canonicalJson(stableContent)).digest("hex");
}

function positiveInteger(value: number, name: string, minimum = 1): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer greater than or equal to ${minimum}.`);
  }
  return value;
}

export class PortfolioLiveHub {
  private readonly getPortfolio: PortfolioLiveHubOptions["getPortfolio"];
  private readonly refreshIntervalMs: number;
  private readonly idleTtlMs: number;
  private readonly maxHubs: number;
  private readonly maxListenersPerHub: number;
  private readonly now: () => number;
  private readonly logError: (error: unknown) => void;
  private readonly streams = new Map<string, PortfolioStream>();
  private readonly activeRefreshes = new Set<Promise<PortfolioEventV1>>();
  private closed = false;
  private refreshesTotal = 0;
  private changedTotal = 0;
  private unchangedTotal = 0;
  private rejectedTotal = 0;
  private errorsTotal = 0;

  constructor(options: PortfolioLiveHubOptions) {
    this.getPortfolio = options.getPortfolio;
    this.refreshIntervalMs = positiveInteger(
      options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS,
      "Portfolio refresh interval",
      250,
    );
    this.idleTtlMs = positiveInteger(
      options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS,
      "Portfolio idle TTL",
    );
    this.maxHubs = positiveInteger(options.maxHubs ?? DEFAULT_MAX_HUBS, "Portfolio hub capacity");
    this.maxListenersPerHub = positiveInteger(
      options.maxListenersPerHub ?? DEFAULT_MAX_LISTENERS_PER_HUB,
      "Portfolio listeners per hub",
    );
    this.now = options.now ?? Date.now;
    this.logError = options.logError ?? ((error) => {
      console.warn(
        "[portfolio-live] refresh failed:",
        error instanceof Error ? error.message : "unknown error",
      );
    });
  }

  subscribe(
    ownerSubject: string,
    accountId: string,
    listener: PortfolioEventListener,
  ): PortfolioLiveSubscription {
    if (this.closed) throw new PortfolioLiveBusyError("Portfolio live hub is closed.");
    const owner = ownerSubject.trim();
    const account = accountId.trim();
    if (!owner || owner.length > 128 || !account || account.length > 128) {
      throw new Error("Portfolio live owner and account must be 1..=128 characters.");
    }

    const stream = this.getOrCreateStream(owner, account);
    if (stream.listeners.size >= this.maxListenersPerHub) {
      this.rejectedTotal += 1;
      throw new PortfolioLiveBusyError();
    }

    const wasInactive = stream.listeners.size === 0;
    if (stream.evictionTimer) {
      clearTimeout(stream.evictionTimer);
      stream.evictionTimer = undefined;
    }
    stream.lastAccessAt = this.now();
    stream.listeners.add(listener);

    const ready = !wasInactive && stream.latest
      ? Promise.resolve(stream.latest)
      : this.refresh(stream);
    this.scheduleRefresh(stream);

    let active = true;
    return {
      ready,
      release: () => {
        if (!active) return;
        active = false;
        stream.listeners.delete(listener);
        stream.lastAccessAt = this.now();
        if (stream.listeners.size === 0) this.deactivate(stream);
      },
    };
  }

  snapshotAfter(
    ownerSubject: string,
    accountId: string,
    requestedRevision?: number,
  ): PortfolioEventV1 | undefined {
    const stream = this.streams.get(streamKey(ownerSubject, accountId));
    if (!stream?.latest) return undefined;
    stream.lastAccessAt = this.now();

    if (requestedRevision === stream.revision) return undefined;
    return {
      ...stream.latest,
      type: "snapshot",
      emittedAt: new Date(this.now()).toISOString(),
    };
  }

  get telemetry(): PortfolioLiveHubTelemetry {
    let activeHubs = 0;
    let subscribers = 0;
    for (const stream of this.streams.values()) {
      if (stream.listeners.size > 0) activeHubs += 1;
      subscribers += stream.listeners.size;
    }
    return {
      capacity: this.maxHubs,
      hubs: this.streams.size,
      activeHubs,
      subscribers,
      refreshesTotal: this.refreshesTotal,
      changedTotal: this.changedTotal,
      unchangedTotal: this.unchangedTotal,
      rejectedTotal: this.rejectedTotal,
      errorsTotal: this.errorsTotal,
    };
  }

  async close(): Promise<void> {
    if (this.closed) {
      await Promise.allSettled([...this.activeRefreshes]);
      return;
    }
    this.closed = true;
    for (const stream of this.streams.values()) {
      if (stream.refreshTimer) clearTimeout(stream.refreshTimer);
      if (stream.evictionTimer) clearTimeout(stream.evictionTimer);
      stream.refreshTimer = undefined;
      stream.evictionTimer = undefined;
      stream.listeners.clear();
    }
    await Promise.allSettled([...this.activeRefreshes]);
    this.streams.clear();
  }

  private getOrCreateStream(ownerSubject: string, accountId: string): PortfolioStream {
    const key = streamKey(ownerSubject, accountId);
    const existing = this.streams.get(key);
    if (existing) return existing;

    if (this.streams.size >= this.maxHubs) this.evictOldestIdleStream();
    if (this.streams.size >= this.maxHubs) {
      this.rejectedTotal += 1;
      throw new PortfolioLiveBusyError();
    }

    const stream: PortfolioStream = {
      key,
      ownerSubject,
      accountId,
      revision: 0,
      listeners: new Set(),
      lastAccessAt: this.now(),
    };
    this.streams.set(key, stream);
    return stream;
  }

  private evictOldestIdleStream(): void {
    let candidate: PortfolioStream | undefined;
    for (const stream of this.streams.values()) {
      if (stream.listeners.size > 0 || stream.refreshTask) continue;
      if (!candidate || stream.lastAccessAt < candidate.lastAccessAt) candidate = stream;
    }
    if (candidate) this.removeStream(candidate);
  }

  private removeStream(stream: PortfolioStream): void {
    if (stream.refreshTimer) clearTimeout(stream.refreshTimer);
    if (stream.evictionTimer) clearTimeout(stream.evictionTimer);
    this.streams.delete(stream.key);
  }

  private deactivate(stream: PortfolioStream): void {
    if (stream.refreshTimer) clearTimeout(stream.refreshTimer);
    stream.refreshTimer = undefined;
    if (stream.evictionTimer) clearTimeout(stream.evictionTimer);
    stream.evictionTimer = setTimeout(() => {
      stream.evictionTimer = undefined;
      if (stream.listeners.size === 0 && !stream.refreshTask) this.removeStream(stream);
    }, this.idleTtlMs);
    stream.evictionTimer.unref?.();
  }

  private scheduleRefresh(stream: PortfolioStream): void {
    if (this.closed || stream.listeners.size === 0 || stream.refreshTimer || stream.refreshTask) return;
    stream.refreshTimer = setTimeout(() => {
      stream.refreshTimer = undefined;
      void this.refresh(stream).catch(() => undefined);
    }, this.refreshIntervalMs);
    stream.refreshTimer.unref?.();
  }

  private refresh(stream: PortfolioStream): Promise<PortfolioEventV1> {
    if (stream.refreshTask) return stream.refreshTask;
    const task = this.runRefresh(stream);
    stream.refreshTask = task;
    this.activeRefreshes.add(task);
    void task.finally(() => {
      this.activeRefreshes.delete(task);
      if (stream.refreshTask === task) stream.refreshTask = undefined;
      if (stream.listeners.size === 0 && !stream.evictionTimer && !this.closed) {
        this.deactivate(stream);
      } else {
        this.scheduleRefresh(stream);
      }
    }).catch(() => undefined);
    return task;
  }

  private async runRefresh(stream: PortfolioStream): Promise<PortfolioEventV1> {
    try {
      const portfolio = await this.getPortfolio(stream.ownerSubject, stream.accountId);
      this.refreshesTotal += 1;
      const checksum = portfolioContentChecksum(portfolio);
      if (stream.latest && stream.checksum === checksum) {
        this.unchangedTotal += 1;
        stream.latest = {
          ...stream.latest,
          type: "snapshot",
          emittedAt: new Date(this.now()).toISOString(),
          payload: portfolio,
        };
        return stream.latest;
      }

      const type = stream.latest ? "changed" : "snapshot";
      stream.revision += 1;
      stream.checksum = checksum;
      stream.latest = this.createEvent(stream, type, portfolio);
      this.changedTotal += 1;
      this.emit(stream, stream.latest);
      return stream.latest;
    } catch (error) {
      this.errorsTotal += 1;
      this.logError(error);
      throw error;
    }
  }

  private createEvent(
    stream: PortfolioStream,
    type: "snapshot" | "changed",
    payload: Portfolio,
  ): PortfolioEventV1 {
    return {
      schemaVersion: PORTFOLIO_EVENT_SCHEMA_VERSION,
      accountId: stream.accountId,
      revision: stream.revision,
      emittedAt: new Date(this.now()).toISOString(),
      type,
      payload,
    };
  }

  private emit(stream: PortfolioStream, event: PortfolioEventV1): void {
    for (const listener of [...stream.listeners]) {
      try {
        listener(event);
      } catch (error) {
        this.logError(error);
      }
    }
  }
}
