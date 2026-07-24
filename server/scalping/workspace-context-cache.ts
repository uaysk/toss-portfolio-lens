import type { MarketCountry } from "./contracts.js";

type WorkspaceContextIdentity = {
  accountId?: string;
  marketCountry: MarketCountry;
  symbols: readonly string[];
};

export type WorkspaceContextWrite<T> = WorkspaceContextIdentity & {
  resolvedAccountId?: string;
  revision: string;
  value: T;
};

export type WorkspaceContextRead = WorkspaceContextIdentity & {
  revision?: string;
};

export type WorkspaceContextSnapshot<T> = {
  value: T;
  revision: string;
  resolvedAccountId?: string;
  expiresAt: number;
};

export type WorkspaceContextCacheOptions = {
  maximumEntries: number;
  ttlMs: number;
  now?: () => number;
};

type StoredWorkspaceContext<T> = WorkspaceContextSnapshot<T> & {
  accountId?: string;
  marketCountry: MarketCountry;
  symbols: readonly string[];
};

function canonicalSymbols(symbols: readonly string[]): string[] {
  return Array.from(new Set(symbols.map((symbol) => symbol.trim().toUpperCase()))).sort();
}

function cacheKey(identity: WorkspaceContextIdentity): string {
  return JSON.stringify([
    identity.accountId ?? null,
    identity.marketCountry,
    canonicalSymbols(identity.symbols),
  ]);
}

export class WorkspaceContextCache<T> {
  private readonly entries = new Map<string, StoredWorkspaceContext<T>>();
  private readonly now: () => number;

  constructor(private readonly options: WorkspaceContextCacheOptions) {
    if (!Number.isInteger(options.maximumEntries) || options.maximumEntries < 1) {
      throw new TypeError("maximumEntries must be a positive integer.");
    }
    if (!Number.isFinite(options.ttlMs) || options.ttlMs <= 0) {
      throw new TypeError("ttlMs must be positive.");
    }
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    this.removeExpired(this.now());
    return this.entries.size;
  }

  set(input: WorkspaceContextWrite<T>): void {
    const now = this.now();
    this.removeExpired(now);
    const symbols = canonicalSymbols(input.symbols);
    if (!symbols.length) return;
    if (!input.revision.trim()) throw new TypeError("revision must not be empty.");

    if (input.accountId === undefined) {
      for (const [key, entry] of this.entries) {
        if (entry.accountId === undefined
          && entry.marketCountry === input.marketCountry
          && entry.resolvedAccountId !== input.resolvedAccountId) {
          this.entries.delete(key);
        }
      }
    }

    const key = cacheKey({ ...input, symbols });
    this.entries.delete(key);
    this.entries.set(key, {
      ...(input.accountId === undefined ? {} : { accountId: input.accountId }),
      ...(input.resolvedAccountId === undefined ? {} : { resolvedAccountId: input.resolvedAccountId }),
      marketCountry: input.marketCountry,
      symbols,
      revision: input.revision,
      value: input.value,
      expiresAt: now + this.options.ttlMs,
    });
    this.enforceBound();
  }

  get(input: WorkspaceContextRead): WorkspaceContextSnapshot<T> | undefined {
    const now = this.now();
    this.removeExpired(now);
    const key = cacheKey(input);
    const entry = this.entries.get(key);
    if (!entry || (input.revision !== undefined && entry.revision !== input.revision)) return undefined;

    this.entries.delete(key);
    this.entries.set(key, entry);
    return {
      value: entry.value,
      revision: entry.revision,
      ...(entry.resolvedAccountId === undefined ? {} : { resolvedAccountId: entry.resolvedAccountId }),
      expiresAt: entry.expiresAt,
    };
  }

  private removeExpired(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }

  private enforceBound(): void {
    while (this.entries.size > this.options.maximumEntries) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (oldestKey === undefined) return;
      this.entries.delete(oldestKey);
    }
  }
}
