import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  SimulationRunHistoryList,
  SimulationRunReportView,
} from "./ai-simulation-history";
import type {
  AiSimulationHistoryItem,
  AiSimulationRunReport,
} from "@/lib/ai-simulation";

describe("AI simulation history", () => {
  it("keeps complete run summaries in a bounded, keyboard-scrollable archive", () => {
    const items: AiSimulationHistoryItem[] = Array.from({ length: 24 }, (_, index) => ({
      runId: `run-${index + 1}`,
      status: "completed",
      startedAt: new Date(Date.UTC(2026, 6, 24, 0, index)).toISOString(),
      marketCountry: index % 2 ? "US" : "KR",
      currency: index % 2 ? "USD" : "KRW",
      preset: "breakout",
      riskTolerance: 90,
      selection: { mode: "auto", criterion: "volatility", symbolCount: 2 },
      selected: [{ symbol: `SIM${index + 1}`, name: `기록 ${index + 1}` }],
      finalEquity: 10_000 + index,
      returnRatio: index / 10_000,
      tradeCount: index,
      decisionCount: index + 2,
      warnings: [],
    }));
    const markup = renderToStaticMarkup(
      <SimulationRunHistoryList
        items={items}
        selectedRunId="run-24"
        onSelect={() => undefined}
      />,
    );

    expect(markup).toContain('data-simulation-history-scroll="true"');
    expect(markup).toContain("max-h-[36rem]");
    expect(markup).toContain('tabindex="0"');
    expect(markup).toContain('data-simulation-history-item="run-1"');
    expect(markup).toContain('data-simulation-history-item="run-24"');
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain("변동성 자동 선정 · 2종목");
  });

  it("renders the selected run configuration, result, provenance, ledger, and evidence", () => {
    const report: AiSimulationRunReport = {
      runId: "report-1",
      status: "completed",
      startedAt: "2026-07-24T01:00:00.000Z",
      finishedAt: "2026-07-24T01:30:00.000Z",
      configuration: {
        marketCountry: "US",
        initialCash: 10_000,
        durationMinutes: 30,
        preset: "breakout",
        riskTolerance: 95,
        selection: { mode: "auto", criterion: "volatility", symbolCount: 2 },
        costs: { commissionBpsPerSide: 1 },
      },
      selected: [{
        symbol: "NVDA",
        name: "NVIDIA",
        upProbability: 0.67,
        predictedMedianReturn: 0.005,
        model: "chronos · pinned · CUDA",
      }],
      performance: {
        currency: "USD",
        initialCash: 10_000,
        finalEquity: 10_100,
        cash: 10_100,
        pnl: 100,
        returnRatio: 0.01,
        realizedPnl: 102,
        unrealizedPnl: 0,
        totalCosts: 2,
        tradeCount: 2,
        decisionCount: 3,
      },
      decisionCadence: {
        trigger: "finalized_one_minute_bar",
        triggeredEvents: 3,
        lastFinishedAt: "2026-07-24T01:29:01.000Z",
      },
      decisions: [{
        symbol: "NVDA",
        action: "buy",
        decidedAt: "2026-07-24T01:02:00.000Z",
        reason: "forecast_and_signal_aligned",
        chartPatterns: ["bullish_engulfing"],
      }],
      trades: [{
        symbol: "NVDA",
        side: "buy",
        executedAt: "2026-07-24T01:03:00.000Z",
        price: 170,
        quantity: 2,
        amount: 340,
        cost: 1,
      }],
      positions: [],
      equity: [{
        timestamp: "2026-07-24T01:30:00.000Z",
        equity: 10_100,
        cash: 10_100,
      }],
      charts: [],
      modelProvenance: ["chronos · pinned · CUDA"],
      evidence: [{ label: "chart_pattern", value: "bullish_engulfing" }],
      warnings: ["가상 체결만 생성합니다."],
      limits: ["실주문 없음"],
    };
    const markup = renderToStaticMarkup(<SimulationRunReportView report={report} />);

    expect(markup).toContain('data-simulation-report="report-1"');
    expect(markup).toContain("실행 설정");
    expect(markup).toContain("돌파 가속");
    expect(markup).toContain("변동성 자동 선정 · 2종목");
    expect(markup).toContain("NVIDIA");
    expect(markup).toContain("chronos · pinned · CUDA");
    expect(markup).toContain("AI 판단");
    expect(markup).toContain("가상 체결");
    expect(markup).toContain("자산 추이");
    expect(markup).toContain("chart_pattern");
    expect(markup).toContain("실주문 없음");
  });
});
