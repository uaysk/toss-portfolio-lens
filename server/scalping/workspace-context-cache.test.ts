import { describe, expect, it } from "vitest";
import { WorkspaceContextCache } from "./workspace-context-cache.js";

type Context = { name: string };

function write(
  cache: WorkspaceContextCache<Context>,
  input: {
    name: string;
    accountId?: string;
    resolvedAccountId?: string;
    marketCountry?: "KR" | "US";
    symbols?: string[];
    revision?: string;
  },
) {
  cache.set({
    ...(input.accountId === undefined ? {} : { accountId: input.accountId }),
    ...(input.resolvedAccountId === undefined ? {} : { resolvedAccountId: input.resolvedAccountId }),
    marketCountry: input.marketCountry ?? "KR",
    symbols: input.symbols ?? ["005930"],
    revision: input.revision ?? `revision:${input.name}`,
    value: { name: input.name },
  });
}

describe("WorkspaceContextCache", () => {
  it("isolates exact account, market, and sorted symbol sets", () => {
    const cache = new WorkspaceContextCache<Context>({ maximumEntries: 8, ttlMs: 1_000 });
    write(cache, { name: "target", accountId: "account-a", symbols: ["000660", "005930"] });

    expect(cache.get({
      accountId: "account-a",
      marketCountry: "KR",
      symbols: ["005930", "000660"],
    })?.value.name).toBe("target");
    expect(cache.get({ accountId: "account-b", marketCountry: "KR", symbols: ["000660", "005930"] })).toBeUndefined();
    expect(cache.get({ accountId: "account-a", marketCountry: "US", symbols: ["000660", "005930"] })).toBeUndefined();
    expect(cache.get({ accountId: "account-a", marketCountry: "KR", symbols: ["005930"] })).toBeUndefined();
  });

  it("supports exact revision reads", () => {
    const cache = new WorkspaceContextCache<Context>({ maximumEntries: 8, ttlMs: 1_000 });
    write(cache, { name: "target", revision: "portfolio:42" });
    expect(cache.get({
      marketCountry: "KR",
      symbols: ["005930"],
      revision: "portfolio:41",
    })).toBeUndefined();
    expect(cache.get({
      marketCountry: "KR",
      symbols: ["005930"],
      revision: "portfolio:42",
    })?.value.name).toBe("target");
  });

  it("invalidates all implicit-account entries when the resolved default changes", () => {
    const cache = new WorkspaceContextCache<Context>({ maximumEntries: 8, ttlMs: 1_000 });
    write(cache, { name: "old-a", resolvedAccountId: "account-a", symbols: ["005930"] });
    write(cache, { name: "old-b", resolvedAccountId: "account-a", symbols: ["000660"] });
    write(cache, { name: "new", resolvedAccountId: "account-b", symbols: ["035420"] });

    expect(cache.get({ marketCountry: "KR", symbols: ["005930"] })).toBeUndefined();
    expect(cache.get({ marketCountry: "KR", symbols: ["000660"] })).toBeUndefined();
    expect(cache.get({ marketCountry: "KR", symbols: ["035420"] })?.value.name).toBe("new");
  });

  it("expires entries using an injected clock", () => {
    let now = 1_000;
    const cache = new WorkspaceContextCache<Context>({
      maximumEntries: 8,
      ttlMs: 50,
      now: () => now,
    });
    write(cache, { name: "target" });
    now = 1_049;
    expect(cache.get({ marketCountry: "KR", symbols: ["005930"] })?.value.name).toBe("target");
    now = 1_050;
    expect(cache.get({ marketCountry: "KR", symbols: ["005930"] })).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("never exceeds its bound and evicts the least recently used entry", () => {
    const cache = new WorkspaceContextCache<Context>({ maximumEntries: 2, ttlMs: 1_000 });
    write(cache, { name: "first", symbols: ["A"] });
    write(cache, { name: "second", symbols: ["B"] });
    expect(cache.get({ marketCountry: "KR", symbols: ["A"] })?.value.name).toBe("first");
    write(cache, { name: "third", symbols: ["C"] });

    expect(cache.size).toBe(2);
    expect(cache.get({ marketCountry: "KR", symbols: ["B"] })).toBeUndefined();
    expect(cache.get({ marketCountry: "KR", symbols: ["A"] })?.value.name).toBe("first");
    expect(cache.get({ marketCountry: "KR", symbols: ["C"] })?.value.name).toBe("third");
  });
});
