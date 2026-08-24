import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PortfolioEventV1Schema,
  type PortfolioEventV1,
} from "../contracts/portfolio-events.js";
import {
  PortfolioLiveBusyError,
  PortfolioLiveHub,
  portfolioContentChecksum,
} from "./live-hub.js";
import type { Holding, Portfolio } from "../toss.js";

function portfolio(
  accountId = "account-1",
  evaluationAmount = 1_000,
  asOf = "2026-07-30T00:00:00.000Z",
): Portfolio {
  const account = { id: accountId, name: accountId, label: accountId, type: "STOCK" };
  return {
    asOf,
    accounts: [account],
    selectedAccountId: accountId,
    account,
    summary: {
      evaluationAmount: { KRW: evaluationAmount, USD: 0 },
      purchaseAmount: { KRW: 900, USD: 0 },
      profitLoss: { KRW: evaluationAmount - 900, USD: 0 },
      dailyProfitLoss: { KRW: 0, USD: 0 },
      profitRate: 0,
      dailyProfitRate: 0,
      positionCount: 0,
    },
    holdings: [],
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("PortfolioLiveHub", () => {
  it("shares one upstream refresh and only publishes stable content changes", async () => {
    vi.useFakeTimers();
    let current = portfolio();
    const getPortfolio = vi.fn(async () => current);
    const hub = new PortfolioLiveHub({
      getPortfolio,
      refreshIntervalMs: 1_000,
      idleTtlMs: 5_000,
    });
    const firstEvents: unknown[] = [];
    const secondEvents: unknown[] = [];

    const first = hub.subscribe("owner", "account-1", (event) => firstEvents.push(event));
    const second = hub.subscribe("owner", "account-1", (event) => secondEvents.push(event));
    await Promise.all([first.ready, second.ready]);

    expect(getPortfolio).toHaveBeenCalledTimes(1);
    expect(firstEvents).toHaveLength(1);
    expect(secondEvents).toHaveLength(1);
    expect(PortfolioEventV1Schema.safeParse(firstEvents[0]).success).toBe(true);
    expect(firstEvents[0]).toMatchObject({ revision: 1, type: "snapshot" });

    current = portfolio("account-1", 1_000, "2026-07-30T00:00:01.000Z");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(getPortfolio).toHaveBeenCalledTimes(2);
    expect(firstEvents).toHaveLength(1);

    current = portfolio("account-1", 1_100, "2026-07-30T00:00:02.000Z");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(firstEvents).toHaveLength(2);
    expect(secondEvents).toHaveLength(2);
    expect(firstEvents[1]).toMatchObject({ revision: 2, type: "changed" });

    first.release();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(getPortfolio).toHaveBeenCalledTimes(4);
    second.release();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(getPortfolio).toHaveBeenCalledTimes(4);
    expect(hub.telemetry).toMatchObject({
      hubs: 1,
      activeHubs: 0,
      subscribers: 0,
      refreshesTotal: 4,
      changedTotal: 2,
      unchangedTotal: 2,
    });
    expect(JSON.stringify(hub.telemetry)).not.toContain("account-1");
    await hub.close();
  });

  it("bounds active hubs/listeners and resets future cursors without mutating the stream", async () => {
    const events: PortfolioEventV1[] = [];
    const hub = new PortfolioLiveHub({
      getPortfolio: async (_owner, accountId) => portfolio(accountId),
      maxHubs: 1,
      maxListenersPerHub: 1,
    });
    const first = hub.subscribe("owner", "account-1", (event) => events.push(event));
    await first.ready;

    expect(() => hub.subscribe("owner", "account-1", () => undefined))
      .toThrow(PortfolioLiveBusyError);
    expect(() => hub.subscribe("owner", "account-2", () => undefined))
      .toThrow(PortfolioLiveBusyError);

    const resnapshot = hub.snapshotAfter(
      "owner",
      "account-1",
      Number.MAX_SAFE_INTEGER,
    );
    expect(resnapshot).toMatchObject({
      accountId: "account-1",
      revision: 1,
      type: "snapshot",
    });
    expect(events).toHaveLength(1);
    expect(hub.snapshotAfter("owner", "account-1", 1)).toBeUndefined();
    expect(hub.telemetry.rejectedTotal).toBe(2);
    first.release();
    await hub.close();
  });

  it("returns a current snapshot for stale cursors without emitting it globally", async () => {
    vi.useFakeTimers();
    const events: PortfolioEventV1[] = [];
    let current = portfolio();
    const hub = new PortfolioLiveHub({
      getPortfolio: async () => current,
      refreshIntervalMs: 1_000,
    });
    const subscription = hub.subscribe("owner", "account-1", (event) => events.push(event));
    await subscription.ready;
    current = portfolio("account-1", 1_100);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(events).toHaveLength(2);

    expect(hub.snapshotAfter("owner", "account-1", 1)).toMatchObject({
      revision: 2,
      type: "snapshot",
    });
    expect(events).toHaveLength(2);
    subscription.release();
    await hub.close();
  });

  it("evicts only idle hubs when bounded capacity is reused", async () => {
    const hub = new PortfolioLiveHub({
      getPortfolio: async (_owner, accountId) => portfolio(accountId),
      maxHubs: 1,
      idleTtlMs: 60_000,
    });
    const first = hub.subscribe("owner", "account-1", () => undefined);
    await first.ready;
    first.release();
    await Promise.resolve();

    const second = hub.subscribe("owner", "account-2", () => undefined);
    await second.ready;
    expect(hub.snapshotAfter("owner", "account-1")).toBeUndefined();
    expect(hub.telemetry).toMatchObject({ hubs: 1, activeHubs: 1, subscribers: 1 });
    second.release();
    await hub.close();
  });

  it("ignores timestamp-only differences in the canonical content checksum", () => {
    const first = portfolio("account-1", 1_000, "2026-07-30T00:00:00.000Z");
    const second = portfolio("account-1", 1_000, "2026-07-30T00:00:10.000Z");
    expect(portfolioContentChecksum(first)).toBe(
      "ce0c3d9a84e401243e444c99becdef4aff4d15e7bfc092fa1fb6c4ad6737420f",
    );
    expect(portfolioContentChecksum(first)).toBe(portfolioContentChecksum(second));
    expect(portfolioContentChecksum(first)).not.toBe(
      portfolioContentChecksum(portfolio("account-1", 2_000)),
    );
  });

  it("keeps nested object key order out of the content checksum", () => {
    const holding: Holding = {
      symbol: "005930",
      name: "삼성전자",
      market: "KRX",
      currency: "KRW",
      quantity: 10,
      availableQuantity: 8,
      averagePrice: 72_000,
      currentPrice: 75_000,
      purchaseAmount: 720_000,
      evaluationAmount: 750_000,
      profitLoss: 30_000,
      profitRate: 4.1667,
      dailyProfitLoss: 5_000,
      dailyProfitRate: 0.6711,
    };
    const reorderedHolding = Object.fromEntries(
      Object.entries(holding).reverse(),
    ) as Holding;
    const first = portfolio();
    const second = portfolio();
    first.holdings = [holding];
    second.holdings = [reorderedHolding];

    expect(portfolioContentChecksum(first)).toBe(portfolioContentChecksum(second));
  });
});
