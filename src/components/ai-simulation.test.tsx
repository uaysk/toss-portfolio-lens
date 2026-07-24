import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  AiSimulation,
  AiSimulationStrategySettings,
  SimulationDisclosure,
  TradesAndDecisions,
  aiSimulationRequestWithStrategy,
  simulationDecisionCadenceLabel,
} from "./ai-simulation";
import { AiSimulationComparisonPanel } from "./ai-simulation-comparison-panel";
import {
  AI_SIMULATION_PAIR_CATALOG,
  DEFAULT_AI_SIMULATION_REQUEST,
  type AiSimulationSnapshot,
  type AiSimulationStrategyComparison,
} from "@/lib/ai-simulation";

describe("AI simulation disclosure", () => {
  it("states the virtual-only and next-valid-fill boundary verbatim", () => {
    const markup = renderToStaticMarkup(<SimulationDisclosure />);
    expect(markup).toContain("실주문 없음, 투자 지시 아님, 다음 유효 체결만.");
    expect(markup).toContain("가상 원장에만 반영");
  });
});

describe("AiSimulation", () => {
  it("describes finalized-bar event cadence without inventing a fixed interval", () => {
    expect(simulationDecisionCadenceLabel(undefined)).toBe("확정봉 이벤트 즉시");
    expect(simulationDecisionCadenceLabel("finalized_one_minute_bar")).toBe("새 확정 1분봉 즉시");
  });

  it("renders cash-only setup, selection mode, preset, and risk controls", () => {
    const markup = renderToStaticMarkup(<AiSimulation onUnauthorized={() => undefined} />);
    expect(markup).toContain('data-ai-simulation="true"');
    expect(markup).toContain('aria-label="시작 예수금"');
    expect(markup).toContain('aria-label="테스트 기간"');
    expect(markup).toContain('aria-label="시뮬레이션 종목 선택 방식"');
    expect(markup).toContain('aria-label="시뮬레이션 전략 실행 방식"');
    expect(markup).toContain("페어 비교");
    expect(markup).toContain("페어 전략 capability를 확인하고 있습니다.");
    expect(markup).toContain('aria-label="AI 선정 종목 수"');
    expect(markup).toContain('aria-label="공격 방어 성향"');
    expect(markup).toContain("Kronos-base 예측");
    expect(markup).toContain("Kronos-base · Rust · 패턴");
    expect(markup).toContain("최대 공격 · 최대 배분");
    expect(markup).toContain("현금 100% · 0주");
    expect(markup).toContain("확정봉 이벤트 즉시");
    expect(markup).toContain("AI 시뮬레이션 시작");
    expect(markup).toContain("시작 버튼을 눌러야만 후보 스캔과 AI 판단이 시작됩니다.");
    expect(markup).toContain('data-simulation-empty="true"');
    expect(markup).toContain("시뮬레이션 기록·결과 보고서");
    expect(markup).toContain('data-simulation-history="true"');
  });

  it("keeps the complete decision history inside a bounded scroll region", () => {
    const decisions = Array.from({ length: 25 }, (_, index) => ({
      symbol: "005930",
      action: "watch",
      decidedAt: new Date(Date.UTC(2026, 6, 24, 0, index)).toISOString(),
      reason: `decision-${index + 1}`,
      chartPatterns: [],
    }));
    const snapshot: AiSimulationSnapshot = {
      phase: "running",
      currency: "KRW",
      initialCash: 10_000_000,
      cash: 10_000_000,
      equity: 10_000_000,
      progress: 0.5,
      selected: [],
      positions: [],
      charts: [],
      trades: [],
      decisions,
      kronosForecasts: [],
      warnings: [],
      capabilities: {},
    };
    const markup = renderToStaticMarkup(<TradesAndDecisions snapshot={snapshot} />);
    expect(markup).toContain('data-simulation-decisions-scroll="true"');
    expect(markup).toContain("max-h-[28rem]");
    expect(markup).toContain("decision-1");
    expect(markup).toContain("decision-25");
  });

  it("renders the US pair catalog with a fixed fail-closed policy", () => {
    const markup = renderToStaticMarkup(
      <AiSimulationStrategySettings
        request={{
          ...DEFAULT_AI_SIMULATION_REQUEST,
          marketCountry: "US",
          strategy: {
            mode: "pair",
            pairId: "tsla-tsll-tslq",
            allowDegradedMode: false,
          },
        }}
        catalog={AI_SIMULATION_PAIR_CATALOG}
        pairEnabled
        disabled={false}
        onModeChange={() => undefined}
        onPairIdChange={() => undefined}
      />,
    );
    expect(markup).toContain('data-simulation-pair-settings="true"');
    expect(markup).toContain('aria-label="미국 페어 카탈로그"');
    expect(markup).toContain("시장은 미국으로 고정");
    expect(markup).toContain("Kronos-base, Rust 기술 지표");
    expect(markup).toContain("거래하지 않고 cash로 닫습니다.");
    expect(markup).not.toContain('type="checkbox"');
    expect(markup).not.toContain("degraded 실행 허용");
  });

  it("switches pair requests to US defaults without retaining manual symbols", () => {
    expect(aiSimulationRequestWithStrategy({
      ...DEFAULT_AI_SIMULATION_REQUEST,
      selection: { mode: "manual", symbols: ["005930"] },
    }, {
      mode: "pair",
      pairId: "qqq-tqqq-sqqq",
    })).toMatchObject({
      marketCountry: "US",
      initialCash: 100_000,
      selection: { mode: "auto", criterion: "trading_amount", symbolCount: 1 },
      strategy: {
        mode: "pair",
        pairId: "qqq-tqqq-sqqq",
        allowDegradedMode: false,
      },
      costs: { commissionBpsPerSide: 10, taxBpsOnExit: 0 },
    });
  });

  it("renders mobile one-column and desktop three-column Kronos-base/Rust/final comparisons", () => {
    const comparison: AiSimulationStrategyComparison = {
      conditionId: "ui-condition-1",
      pairId: "tsla-tsll-tslq",
      sameOrigin: true,
      sameCosts: true,
      sameExecutionPolicy: true,
      incompleteCount: 0,
      lanes: [
        {
          id: "kronos",
          status: "completed",
          analyticalOnly: true,
          cumulativeReturn: 0.012,
          netReturn: 0.01,
          maxDrawdown: 0.004,
          bullCount: 3,
          bearCount: 1,
          cashCount: 5,
          decisionReasons: [{
            reason: "forecast_up",
            reasons: ["forecast_up", "technical_confirmed"],
            signalSymbol: "TSLA",
            executionSymbol: "TSLL",
            action: "bull",
          }],
        },
        { id: "rust", status: "completed", analyticalOnly: true, cumulativeReturn: 0.004, decisionReasons: [] },
        { id: "ensemble", status: "completed", analyticalOnly: true, cumulativeReturn: 0.011, decisionReasons: [] },
      ],
    };
    const markup = renderToStaticMarkup(
      <AiSimulationComparisonPanel comparison={comparison} currency="USD" />,
    );
    expect(markup).toContain('data-simulation-strategy-comparison="ui-condition-1"');
    expect(markup).toContain("grid-cols-1");
    expect(markup).toContain("sm:grid-cols-3");
    expect(markup).toContain('data-simulation-comparison-lane="kronos"');
    expect(markup).toContain('data-simulation-comparison-lane="ensemble"');
    expect(markup).toContain("Kronos-base");
    expect(markup).toContain("Rust 기술 지표");
    expect(markup).toContain("최종 전략");
    expect(markup).toContain("forward 실행 정책");
    expect(markup.match(/비교 성과 분석용/g)).toHaveLength(3);
    expect(markup).toContain("모든 lane의 비교 성과는 분석·검증용");
    expect(markup).toContain("bull 3 · bear 1 · cash 5");
    expect(markup.match(/data-simulation-comparison-analytical-only="true"/g)).toHaveLength(3);
    expect(markup).toContain("technical_confirmed");
    expect(markup).not.toContain("Chronos");
    expect(markup).not.toContain("Kronos-small");
  });
});
