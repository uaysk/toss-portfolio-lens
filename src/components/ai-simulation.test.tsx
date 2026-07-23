import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  AiSimulation,
  SimulationDisclosure,
  simulationDecisionIntervalLabel,
} from "./ai-simulation";

describe("AI simulation disclosure", () => {
  it("states the virtual-only and next-valid-fill boundary verbatim", () => {
    const markup = renderToStaticMarkup(<SimulationDisclosure />);
    expect(markup).toContain("실주문 없음, 투자 지시 아님, 다음 유효 체결만.");
    expect(markup).toContain("가상 원장에만 반영");
  });
});

describe("AiSimulation", () => {
  it("does not relabel a legacy run with an unknown cadence as 20 seconds", () => {
    expect(simulationDecisionIntervalLabel(undefined)).toBe("기록 없음");
    expect(simulationDecisionIntervalLabel(20)).toBe("20초");
  });

  it("renders a manual start flow with cash, duration, and a one-or-two symbol choice", () => {
    const markup = renderToStaticMarkup(<AiSimulation onUnauthorized={() => undefined} />);
    expect(markup).toContain('data-ai-simulation="true"');
    expect(markup).toContain('aria-label="시작 예수금"');
    expect(markup).toContain('aria-label="테스트 기간"');
    expect(markup).toContain('aria-label="AI 선정 종목 수"');
    expect(markup).toContain("1종목");
    expect(markup).toContain("2종목");
    expect(markup).toContain("AI 시뮬레이션 시작");
    expect(markup).toContain("20초 판단");
    expect(markup).toContain("시작 버튼을 눌러야만 후보 스캔과 AI 판단이 시작됩니다.");
    expect(markup).toContain('data-simulation-empty="true"');
  });
});
