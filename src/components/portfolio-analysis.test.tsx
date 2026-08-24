import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Portfolio } from "@/types";
import {
  PortfolioAnalysisView,
  shouldPollPortfolioAnalysisBackfill,
} from "./portfolio-analysis";

const portfolio: Portfolio = {
  asOf: "2026-08-24T00:00:00.000Z",
  accounts: [{ id: "account-1", name: "기본 계좌", label: "기본 계좌", type: "stock" }],
  selectedAccountId: "account-1",
  account: { id: "account-1", name: "기본 계좌", label: "기본 계좌", type: "stock" },
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

describe("PortfolioAnalysisView", () => {
  it("백필 재조회는 화면이 보이는 동안에만 수행한다", () => {
    expect(shouldPollPortfolioAnalysisBackfill(false, "visible")).toBe(true);
    expect(shouldPollPortfolioAnalysisBackfill(false, "hidden")).toBe(false);
    expect(shouldPollPortfolioAnalysisBackfill(true, "visible")).toBe(false);
    expect(shouldPollPortfolioAnalysisBackfill(undefined, "visible")).toBe(false);
  });

  it("announces the initial analysis loading state and exposes busy state", () => {
    const markup = renderToStaticMarkup(
      <PortfolioAnalysisView
        portfolio={portfolio}
        theme="dark"
        onUnauthorized={() => undefined}
      />,
    );

    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('role="status"');
    expect(markup).toContain("평가금과 비교 지수 일봉을 불러오는 중");
  });
});
