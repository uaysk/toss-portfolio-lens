import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  AiSimulationChart,
  aiSimulationChartTradePoints,
  type AiSimulationChartBar,
} from "./ai-simulation-chart";

const bars: AiSimulationChartBar[] = [
  {
    timestamp: "2026-07-24T09:01:00+09:00",
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    status: "final",
    indicatorValues: {},
  },
  {
    timestamp: "2026-07-24T09:02:00+09:00",
    open: 100,
    high: 102,
    low: 99,
    close: 101,
    status: "final",
    indicatorValues: {},
  },
  {
    timestamp: "2026-07-24T09:03:00+09:00",
    open: 101,
    high: 103,
    low: 100,
    close: 102,
    status: "forming",
    indicatorValues: {},
  },
];

describe("AiSimulationChart", () => {
  it("keeps the empty chart stable while still exposing indicator and pattern evidence", () => {
    const markup = renderToStaticMarkup(
      <AiSimulationChart
        symbol="005930"
        name="삼성전자"
        currency="KRW"
        bars={[]}
        trades={[]}
        indicators={[{
          id: "momentum-rsi",
          kind: "rsi",
          status: "available",
          values: { value: 61.25 },
        }]}
        patterns={[{
          detectedAt: "2026-07-24T09:03:00+09:00",
          name: "bullish_engulfing",
          bias: "bullish",
          strength: 0.8,
        }]}
      />,
    );

    expect(markup).toContain('data-ai-simulation-chart="005930"');
    expect(markup).toContain("삼성전자 · 005930");
    expect(markup).toContain('data-ai-simulation-chart-empty="true"');
    expect(markup).toContain('data-ai-simulation-indicator-badge="rsi"');
    expect(markup).toContain("value 61.25");
    expect(markup).toContain('data-ai-simulation-pattern="bullish"');
    expect(markup).toContain("상승 장악형");
    expect(markup).toContain("강도 80%");
  });

  it("places a fill on its first causal candle and omits out-of-window fills", () => {
    const points = aiSimulationChartTradePoints(bars, [
      {
        executedAt: "2026-07-24T08:59:59+09:00",
        price: 99,
        side: "buy",
        quantity: 1,
      },
      {
        executedAt: "2026-07-24T09:01:20+09:00",
        price: 100.5,
        side: "buy",
        quantity: 2,
      },
      {
        executedAt: "2026-07-24T09:03:01+09:00",
        price: 103,
        side: "sell",
        quantity: 1,
      },
    ]);

    expect(points).toEqual([
      expect.objectContaining({
        timestamp: "2026-07-24T09:02:00+09:00",
        price: 100.5,
        trade: expect.objectContaining({ side: "buy", quantity: 2 }),
      }),
    ]);
  });
});
