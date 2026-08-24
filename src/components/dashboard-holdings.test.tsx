import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Portfolio } from "@/types";
import { HoldingsCard } from "./dashboard";

const portfolio: Portfolio = {
  asOf: "2026-08-24T00:00:00.000Z",
  accounts: [{ id: "account-1", name: "주식", label: "주식 계좌", type: "stock" }],
  selectedAccountId: "account-1",
  account: { id: "account-1", name: "주식", label: "주식 계좌", type: "stock" },
  summary: {
    evaluationAmount: { KRW: 10_000, USD: 0 },
    purchaseAmount: { KRW: 9_000, USD: 0 },
    profitLoss: { KRW: 1_000, USD: 0 },
    dailyProfitLoss: { KRW: 100, USD: 0 },
    profitRate: 11.11,
    dailyProfitRate: 1,
    positionCount: 1,
  },
  holdings: [{
    symbol: "UNIQUE-1",
    name: "고유 종목",
    market: "KRX",
    currency: "KRW",
    quantity: 1,
    availableQuantity: 1,
    averagePrice: 9_000,
    currentPrice: 10_000,
    purchaseAmount: 9_000,
    evaluationAmount: 10_000,
    profitLoss: 1_000,
    profitRate: 11.11,
    dailyProfitLoss: 100,
    dailyProfitRate: 1,
  }],
};

describe("HoldingsCard", () => {
  it("renders each holding once instead of duplicating desktop and mobile DOM", () => {
    const markup = renderToStaticMarkup(
      <HoldingsCard portfolio={portfolio} theme="dark" hiddenCount={0} />,
    );

    expect(markup.match(/UNIQUE-1/g)).toHaveLength(1);
    expect(markup.match(/고유 종목/g)).toHaveLength(1);
  });
});
