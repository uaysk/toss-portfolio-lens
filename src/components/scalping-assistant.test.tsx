import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ScalpingVirtualizedCandidateCard } from "./scalping-assistant";
import type { ScalpingCandidate } from "@/lib/scalping-assistant";

const candidate: ScalpingCandidate = {
  symbol: "005930",
  name: "삼성전자",
  currency: "KRW",
  providerRanks: { toss: 1 },
  quality: { status: "available", reasons: [], missing: [], sources: ["toss"] },
  warnings: [],
  bars: [{ timestamp: "2026-07-21T09:00:00+09:00", open: 70000, high: 70100, low: 69900, close: 70050, status: "final", indicatorValues: {} }],
  tradeMarkers: [],
  indicators: [],
};

describe("ScalpingVirtualizedCandidateCard", () => {
  it("starts with only the stable placeholder and leaves the expensive chart unmounted", () => {
    const markup = renderToStaticMarkup(<ScalpingVirtualizedCandidateCard candidate={candidate} theme="dark" />);
    expect(markup).toContain('data-scalping-card-state="placeholder"');
    expect(markup).toContain("화면에 가까워지면 차트를 렌더링합니다.");
    expect(markup).not.toContain("data-scalping-price-chart");
  });
});
