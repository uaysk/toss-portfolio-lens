import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  AiSimulation,
  SimulationDisclosure,
  TradesAndDecisions,
  simulationDecisionCadenceLabel,
} from "./ai-simulation";
import type { AiSimulationSnapshot } from "@/lib/ai-simulation";

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
    expect(markup).toContain('aria-label="AI 선정 종목 수"');
    expect(markup).toContain('aria-label="공격 방어 성향"');
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
      warnings: [],
      capabilities: {},
    };
    const markup = renderToStaticMarkup(<TradesAndDecisions snapshot={snapshot} />);
    expect(markup).toContain('data-simulation-decisions-scroll="true"');
    expect(markup).toContain("max-h-[28rem]");
    expect(markup).toContain("decision-1");
    expect(markup).toContain("decision-25");
  });
});
