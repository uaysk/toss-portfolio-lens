import { describe, expect, it } from "vitest";
import {
  parsePortfolioEvent,
  parsePortfolioEventMessage,
  portfolioEventsUrl,
} from "./portfolio-events";
import type { Portfolio } from "@/types";

function portfolio(): Portfolio {
  const account = { id: "account-1", name: "계좌", label: "계좌", type: "STOCK" };
  return {
    asOf: "2026-07-30T00:00:00.000Z",
    accounts: [account],
    selectedAccountId: account.id,
    account,
    summary: {
      evaluationAmount: { KRW: 0, USD: 0 },
      purchaseAmount: { KRW: 0, USD: 0 },
      profitLoss: { KRW: 0, USD: 0 },
      dailyProfitLoss: { KRW: 0, USD: 0 },
      profitRate: 0,
      dailyProfitRate: 0,
      positionCount: 0,
    },
    holdings: [],
  };
}

describe("portfolio live events", () => {
  it("parses snapshot/heartbeat and rejects mismatched accounts", () => {
    const snapshot = {
      schemaVersion: 1,
      accountId: "account-1",
      revision: 2,
      emittedAt: "2026-07-30T00:00:00.000Z",
      type: "snapshot",
      payload: portfolio(),
    };
    expect(parsePortfolioEvent(snapshot)).toEqual(snapshot);
    expect(parsePortfolioEvent({ ...snapshot, accountId: "other" })).toBeUndefined();
    expect(parsePortfolioEventMessage(JSON.stringify({
      ...snapshot,
      type: "heartbeat",
      payload: null,
    }))).toMatchObject({ revision: 2, type: "heartbeat" });
    expect(parsePortfolioEventMessage("{")).toBeUndefined();
  });

  it("carries the last accepted revision in reconnect URLs", () => {
    expect(portfolioEventsUrl("account 1")).toBe(
      "/api/portfolio/events?account=account+1",
    );
    expect(portfolioEventsUrl("account-1", 12)).toBe(
      "/api/portfolio/events?account=account-1&lastEventId=12",
    );
  });
});
