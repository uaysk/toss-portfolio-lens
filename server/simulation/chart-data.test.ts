import { describe, expect, it } from "vitest";
import {
  detectSimulationChartPatterns,
  latestSimulationPatternObservation,
  mergeSimulationFinalBar,
  mergeSimulationFormingBar,
  simulationChartsFromWorkspace,
  type SimulationChartBar,
  type SimulationChartView,
} from "./chart-data.js";

function bar(
  timestamp: string,
  open: number,
  high: number,
  low: number,
  close: number,
): SimulationChartBar {
  return {
    timestamp,
    open,
    high,
    low,
    close,
    status: "final",
    indicatorValues: {},
  };
}

describe("simulation chart patterns", () => {
  it("detects bullish and bearish engulfing patterns causally", () => {
    const first = bar("2026-07-24T00:01:00.000Z", 101, 102, 98, 99);
    const bullish = bar("2026-07-24T00:02:00.000Z", 98, 103, 97, 102);
    const bearish = bar("2026-07-24T00:03:00.000Z", 103, 104, 96, 97);
    expect(detectSimulationChartPatterns([first, bullish])).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "bullish_engulfing", bias: "bullish", detectedAt: bullish.timestamp }),
    ]));
    expect(detectSimulationChartPatterns([first, bullish, bearish])).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "bearish_engulfing", bias: "bearish", detectedAt: bearish.timestamp }),
    ]));
    expect(detectSimulationChartPatterns([first])).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ detectedAt: bullish.timestamp }),
    ]));
  });

  it("uses patterns only when they occur on the latest finalized bar", () => {
    const bars = [
      bar("2026-07-24T00:01:00.000Z", 101, 102, 98, 99),
      bar("2026-07-24T00:02:00.000Z", 98, 103, 97, 102),
    ];
    const chart: SimulationChartView = {
      symbol: "AAA",
      currency: "KRW",
      bars,
      indicators: [],
      patterns: detectSimulationChartPatterns(bars),
    };
    expect(latestSimulationPatternObservation(chart)).toMatchObject({
      chartPatternBias: "bullish",
      chartPatterns: expect.arrayContaining(["bullish_engulfing"]),
      patternObservedAt: "2026-07-24T00:02:00.000Z",
    });
    chart.bars.push(bar("2026-07-24T00:03:00.000Z", 102, 103.5, 97.5, 102.5));
    expect(latestSimulationPatternObservation(chart)).toEqual({
      chartPatternBias: "neutral",
      chartPatterns: [],
    });
  });

  it("deduplicates final one-minute bars and retains existing overlays", () => {
    const chart: SimulationChartView = {
      symbol: "AAA",
      currency: "KRW",
      bars: [{
        ...bar("2026-07-24T00:01:00.000Z", 100, 102, 99, 101),
        indicatorValues: { "trend-ema:value": 100.5 },
      }],
      indicators: [],
      patterns: [],
    };
    expect(mergeSimulationFinalBar(chart, {
      intervalMinutes: 1,
      closeTime: "2026-07-24T00:01:00.000Z",
      state: "final",
      open: 100,
      high: 103,
      low: 99,
      close: 102,
      volume: 25,
    })).toBe(true);
    expect(chart.bars).toHaveLength(1);
    expect(chart.bars[0]).toMatchObject({
      high: 103,
      close: 102,
      indicatorValues: { "trend-ema:value": 100.5 },
    });
  });

  it("updates a forming one-minute candle immediately without pattern refresh or final downgrade", () => {
    const finalized = bar("2026-07-24T00:01:00.000Z", 100, 102, 99, 101);
    const chart: SimulationChartView = {
      symbol: "AAPL",
      currency: "USD",
      bars: [finalized],
      indicators: [],
      patterns: detectSimulationChartPatterns([finalized]),
    };
    expect(mergeSimulationFormingBar(chart, {
      intervalMinutes: 1,
      closeTime: "2026-07-24T00:02:00.000Z",
      state: "forming",
      open: 101,
      high: 103,
      low: 100.5,
      close: 102.5,
      volume: 10,
    }, "2026-07-24T00:01:12.345Z")).toBe(true);
    expect(chart.bars.at(-1)).toMatchObject({
      timestamp: "2026-07-24T00:02:00.000Z",
      status: "forming",
      close: 102.5,
    });
    expect(chart.updatedAt).toBe("2026-07-24T00:01:12.345Z");
    const patternsBeforeLateUpdate = [...chart.patterns];
    expect(mergeSimulationFinalBar(chart, {
      intervalMinutes: 1,
      closeTime: "2026-07-24T00:02:00.000Z",
      state: "final",
      open: 101,
      high: 103,
      low: 100.5,
      close: 102,
      volume: 20,
    })).toBe(true);
    expect(chart.bars.at(-1)?.status).toBe("final");
    expect(mergeSimulationFormingBar(chart, {
      intervalMinutes: 1,
      closeTime: "2026-07-24T00:02:00.000Z",
      state: "forming",
      open: 101,
      high: 104,
      low: 100,
      close: 103,
      volume: 30,
    })).toBe(false);
    expect(chart.bars.at(-1)).toMatchObject({ status: "final", close: 102 });
    expect(patternsBeforeLateUpdate).toEqual([]);
  });

  it("keeps a selected-symbol chart slot ready when initial bars are unavailable", () => {
    const workspace = {
      workspace: {
        generatedAt: "2026-07-24T00:00:00.000Z",
        candidates: [{ symbol: "AAA", name: "Alpha", currency: "KRW" }],
        instruments: [],
      },
    } as unknown as Parameters<typeof simulationChartsFromWorkspace>[0];
    expect(simulationChartsFromWorkspace(workspace, ["AAA"])).toEqual([{
      symbol: "AAA",
      name: "Alpha",
      currency: "KRW",
      bars: [],
      indicators: [],
      patterns: [],
      updatedAt: "2026-07-24T00:00:00.000Z",
    }]);
  });
});
