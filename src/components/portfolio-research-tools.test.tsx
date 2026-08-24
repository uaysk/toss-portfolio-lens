import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { BacktestRunConfiguration } from "@/types";
import {
  PortfolioResearchParetoResult,
  PortfolioResearchTools,
} from "./portfolio-research-tools";

const baseConfig: BacktestRunConfiguration = {
  assets: [
    { symbol: "AAA", weight: 60 },
    { symbol: "BBB", weight: 40 },
  ],
  startDate: "2021-01-01",
  endDate: "2025-12-31",
  initialAmount: 100_000_000,
  monthlyCashFlow: 0,
  cashFlowFrequency: "monthly",
  cashFlowTiming: "period_start",
  rebalanceFrequency: "quarterly",
  riskFreeRatePercent: 2,
  transactionCostBps: 8,
  currencyMode: "KRW",
  baseCurrency: "KRW",
  cashFlows: [],
  execution: {
    cashTargetPercent: 0,
    quantityMode: "fractional",
    cashFlowRebalanceMode: "target_weights",
    tradeDatePolicy: "next_common_observation",
    cashAnnualYieldPercent: 2,
  },
  benchmark: "NONE",
};

function paretoCandidates(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `candidate-${index + 1}`,
    rank: index + 1,
    score: 1 - index / Math.max(count, 1),
    metrics: {
      cagr: 0.12,
      volatility: 0.08,
      maxDrawdown: -0.09,
    },
    weights: { AAA: 0.2, BBB: 0.8 },
  }));
}

describe("PortfolioResearchTools", () => {
  it("exposes mutually exclusive research modes as one keyboard radio group", () => {
    const markup = renderToStaticMarkup(
      <PortfolioResearchTools
        baseConfig={baseConfig}
        backtestRuns={[]}
        optimizationRuns={[]}
        theme="dark"
        onUnauthorized={() => undefined}
      />,
    );

    expect(markup).toContain('role="radiogroup"');
    expect(markup).toContain('aria-label="연구 도구 선택"');
    expect(markup.match(/role="radio"/g)).toHaveLength(6);
    expect(markup.match(/aria-checked="true"/g)).toHaveLength(1);
    expect(markup.match(/tabindex="0"/g)).toHaveLength(1);
    expect(markup.match(/tabindex="-1"/g)).toHaveLength(5);
    expect(markup).not.toContain("aria-pressed");
  });

  it("bounds the initial Pareto DOM and keeps the result table keyboard-scrollable", () => {
    const markup = renderToStaticMarkup(
      <PortfolioResearchParetoResult
        result={{ candidates: paretoCandidates(150) }}
        theme="dark"
      />,
    );

    expect(markup.match(/data-research-pareto-row="true"/g)).toHaveLength(100);
    expect(markup).toContain("100 / 150개 표시");
    expect(markup).toContain("후보 50개 더 보기");
    expect(markup).toContain('role="region"');
    expect(markup).toContain('aria-label="Pareto 후보 결과 표"');
    expect(markup).toContain('tabindex="0"');

    const firstRow = markup.slice(
      markup.indexOf('data-research-pareto-row="true"'),
      markup.indexOf("</tr>", markup.indexOf('data-research-pareto-row="true"')),
    );
    expect(firstRow.indexOf("BBB")).toBeLessThan(firstRow.indexOf("AAA"));
  });

  it("does not show a progressive-render control for a small Pareto result", () => {
    const markup = renderToStaticMarkup(
      <PortfolioResearchParetoResult
        result={{ candidates: paretoCandidates(12) }}
        theme="light"
      />,
    );

    expect(markup.match(/data-research-pareto-row="true"/g)).toHaveLength(12);
    expect(markup).toContain("12 / 12개 표시");
    expect(markup).not.toContain("개 더 보기");
  });
});
