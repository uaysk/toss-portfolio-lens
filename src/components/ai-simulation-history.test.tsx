import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  SimulationRunHistoryList,
  SimulationRunReportView,
} from "./ai-simulation-history";
import type {
  AiSimulationHistoryItem,
  AiSimulationRunReport,
  AiSimulationStrategyComparison,
} from "@/lib/ai-simulation";

const strategyComparison: AiSimulationStrategyComparison = {
  conditionId: "history-ui-condition",
  pairId: "qqq-tqqq-sqqq",
  sameOrigin: true,
  sameCosts: true,
  sameExecutionPolicy: true,
  incompleteCount: 1,
  lanes: [
    {
      id: "kronos",
      status: "unavailable",
      analyticalOnly: true,
      unavailableReason: "model unavailable",
      cumulativeReturn: 0.01,
      bullCount: 2,
      bearCount: 1,
      cashCount: 4,
      decisionReasons: [{
        reason: "forecast_up",
        reasons: ["forecast_up", "costs_passed"],
        signalSymbol: "QQQ",
        executionSymbol: "TQQQ",
      }],
    },
    { id: "rust", status: "completed", analyticalOnly: true, cumulativeReturn: 0.004, decisionReasons: [] },
    { id: "ensemble", status: "completed", analyticalOnly: true, cumulativeReturn: 0.008, decisionReasons: [] },
  ],
};

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
      ...(index === 23 ? { strategyComparison } : {}),
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
    expect(markup).toContain("동일 조건 3전략 비교");
    expect(markup).toContain("Kronos-base");
    expect(markup).toContain("Rust 기술 지표");
    expect(markup).toContain("최종 전략");
    expect(markup).toContain("forward 실행 정책");
    expect(markup).toContain("모든 lane의 비교 성과는 분석·검증용");
    expect(markup).toContain("bull 2 · bear 1 · cash 4");
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
        riskTolerance: 100,
        selection: { mode: "auto", criterion: "volatility", symbolCount: 2 },
        costs: { commissionBpsPerSide: 1 },
      },
      selected: [{
        symbol: "NVDA",
        name: "NVIDIA",
        upProbability: 0.67,
        predictedMedianReturn: 0.005,
        model: "NeoQuasar/Kronos-base · pinned · CUDA",
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
      modelProvenance: ["NeoQuasar/Kronos-base · pinned · CUDA"],
      kronosForecasts: [],
      decisionProvenance: [{
        decisionId: "pair-decision-1",
        pairId: "tsla-tsll-tslq",
        signalSymbol: "TSLA",
        executionSymbol: "TSLL",
        direction: "bull",
        origin: "2026-07-24T01:01:00.000Z",
        decisionAt: "2026-07-24T01:01:01.000Z",
        degraded: true,
        models: [
          {
            component: "kronos",
            status: "degraded",
            modelId: "NeoQuasar/Kronos-base",
            modelRevision: "kronos-revision",
            origin: "2026-07-24T01:01:00.000Z",
            generatedAt: "2026-07-24T01:01:00.400Z",
            device: "cuda:0",
            deviceName: "Tesla P40",
            latencyMs: 456,
            degraded: true,
          },
        ],
      }],
      evidence: [{ label: "chart_pattern", value: "bullish_engulfing" }],
      warnings: ["가상 체결만 생성합니다."],
      limits: ["실주문 없음"],
      strategyComparison,
    };
    const markup = renderToStaticMarkup(<SimulationRunReportView report={report} />);

    expect(markup).toContain('data-simulation-report="report-1"');
    expect(markup).toContain("실행 설정");
    expect(markup).toContain("돌파 가속");
    expect(markup).toContain("변동성 자동 선정 · 2종목");
    expect(markup).toContain("NVIDIA");
    expect(markup).toContain("NeoQuasar/Kronos-base · pinned · CUDA");
    expect(markup).toContain('data-simulation-report-decision-provenance="true"');
    expect(markup).toContain('data-simulation-model-provenance="kronos"');
    expect(markup).toContain("판단 provenance 1건");
    expect(markup).toContain("NeoQuasar/Kronos-base");
    expect(markup).toContain("kronos-revision");
    expect(markup).toContain("Tesla P40");
    expect(markup).toContain("456ms");
    expect(markup).toContain("최대 공격 · 100");
    expect(markup).toContain("전략 판단");
    expect(markup).toContain("가상 체결");
    expect(markup).toContain("자산 추이");
    expect(markup).toContain("chart_pattern");
    expect(markup).toContain("실주문 없음");
    expect(markup).toContain('data-simulation-strategy-comparison="history-ui-condition"');
    expect(markup).toContain("동일 원천");
    expect(markup).toContain("model unavailable");
    expect(markup).toContain("costs_passed");
    expect(markup).not.toContain("Chronos");
    expect(markup).not.toContain("Kronos-small");

    const cryptoMarkup = renderToStaticMarkup(
      <SimulationRunReportView
        report={{
          ...report,
          performance: { ...report.performance, currency: "USDT" },
        }}
      />,
    );
    expect(cryptoMarkup).toContain("2계약");
    expect(cryptoMarkup).not.toContain("2주");

    const fincastOnlyMarkup = renderToStaticMarkup(
      <SimulationRunReportView
        report={{
          ...report,
          configuration: {
            ...report.configuration,
            marketCountry: undefined,
            market: {
              kind: "crypto_futures",
              venue: "BINANCE_USDM",
              quoteAsset: "USDT",
              contractType: "PERPETUAL",
            },
            modelLanes: ["fincast"],
          },
          selected: [{
            symbol: "ETHUSDT",
            model: "Vincent05R/FinCast · fincast-revision · CUDA:0",
          }],
          performance: { ...report.performance, currency: "USDT" },
          modelProvenance: ["Vincent05R/FinCast · fincast-revision · CUDA:0"],
          decisionProvenance: [{
            decisionId: "fincast-decision",
            signalSymbol: "ETHUSDT",
            direction: "short",
            origin: "2026-07-24T01:01:00.000Z",
            decisionAt: "2026-07-24T01:01:01.000Z",
            degraded: false,
            models: [{
              component: "fincast",
              status: "available",
              modelId: "Vincent05R/FinCast",
              modelRevision: "fincast-revision",
              degraded: false,
            }],
          }],
          modelComparison: undefined,
          strategyComparison: undefined,
        }}
      />,
    );
    expect(fincastOnlyMarkup).toContain("FinCast · Main lane·판단 주기");
    expect(fincastOnlyMarkup).toContain("판단 provenance 1건 · FinCast · Main");
    expect(fincastOnlyMarkup).toContain('data-simulation-model-provenance="fincast"');
    expect(fincastOnlyMarkup).not.toContain("Kronos-base · FinCast lane");
  });
});
