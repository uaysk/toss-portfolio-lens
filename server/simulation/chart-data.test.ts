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

function indexedBar(
  index: number,
  open: number,
  high: number,
  low: number,
  close: number,
  status: SimulationChartBar["status"] = "final",
): SimulationChartBar {
  return {
    ...bar(new Date(Date.UTC(2026, 6, 24, 0, index)).toISOString(), open, high, low, close),
    status,
    volume: 100 + index,
  };
}

function boundaryBars(
  count: number,
  upperStart: number,
  upperEnd: number,
  lowerStart: number,
  lowerEnd: number,
  offset = 0,
): SimulationChartBar[] {
  return Array.from({ length: count }, (_, position) => {
    const progress = count === 1 ? 0 : position / (count - 1);
    const upper = upperStart + (upperEnd - upperStart) * progress;
    const lower = lowerStart + (lowerEnd - lowerStart) * progress;
    const middle = (upper + lower) / 2;
    const close = position % 2 === 0 ? upper - 0.2 : lower + 0.2;
    return indexedBar(offset + position, middle, upper, lower, close);
  });
}

function withBreakout(
  formation: readonly SimulationChartBar[],
  close: number,
  high = close + 0.4,
  low = close - 0.4,
  status: SimulationChartBar["status"] = "final",
): SimulationChartBar[] {
  return [
    ...formation,
    indexedBar(
      formation.length,
      formation.at(-1)!.close,
      Math.max(high, close),
      Math.min(low, close),
      close,
      status,
    ),
  ];
}

function names(bars: readonly SimulationChartBar[]): string[] {
  return detectSimulationChartPatterns(bars).map((pattern) => pattern.name);
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
      chartPatternStrength: 0,
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

  it.each([
    {
      name: "ascending_triangle",
      formation: boundaryBars(12, 110, 110, 100, 107),
      breakoutClose: 111.2,
    },
    {
      name: "descending_triangle",
      formation: boundaryBars(12, 110, 103, 100, 100),
      breakoutClose: 98.8,
    },
    {
      name: "symmetric_triangle",
      formation: boundaryBars(12, 112, 107, 98, 103),
      breakoutClose: 108.5,
    },
    {
      name: "rising_wedge",
      formation: boundaryBars(12, 105, 111, 100, 108),
      breakoutClose: 106.2,
    },
    {
      name: "falling_wedge",
      formation: boundaryBars(12, 110, 102, 105, 99),
      breakoutClose: 103.8,
    },
  ])("confirms $name only on a finalized breakout", ({ name, formation, breakoutClose }) => {
    expect(names(formation)).not.toContain(name);
    expect(names(withBreakout(formation, breakoutClose, undefined, undefined, "forming")))
      .not.toContain(name);
    const completed = withBreakout(formation, breakoutClose);
    expect(detectSimulationChartPatterns(completed)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name,
        detectedAt: completed.at(-1)!.timestamp,
        strength: expect.any(Number),
      }),
    ]));
    const later = [...completed, indexedBar(completed.length, breakoutClose, breakoutClose + 0.5, breakoutClose - 0.5, breakoutClose)];
    expect(detectSimulationChartPatterns(later)).toEqual(expect.arrayContaining([
      expect.objectContaining({ name, detectedAt: completed.at(-1)!.timestamp }),
    ]));
  });

  it.each([
    {
      name: "bullish_flag",
      pole: [
        indexedBar(0, 100, 102.8, 99.7, 102.5),
        indexedBar(1, 102.5, 105.3, 102.2, 105),
        indexedBar(2, 105, 107.8, 104.7, 107.5),
        indexedBar(3, 107.5, 110.3, 107.2, 110),
      ],
      consolidation: boundaryBars(10, 110.4, 108.4, 107.5, 105.5, 4),
      breakoutClose: 111.2,
    },
    {
      name: "bearish_flag",
      pole: [
        indexedBar(0, 110, 110.3, 107.2, 107.5),
        indexedBar(1, 107.5, 107.8, 104.7, 105),
        indexedBar(2, 105, 105.3, 102.2, 102.5),
        indexedBar(3, 102.5, 102.8, 99.7, 100),
      ],
      consolidation: boundaryBars(10, 102.8, 104.8, 99.6, 101.6, 4),
      breakoutClose: 98.8,
    },
    {
      name: "bullish_pennant",
      pole: [
        indexedBar(0, 100, 102.8, 99.7, 102.5),
        indexedBar(1, 102.5, 105.3, 102.2, 105),
        indexedBar(2, 105, 107.8, 104.7, 107.5),
        indexedBar(3, 107.5, 110.3, 107.2, 110),
      ],
      consolidation: boundaryBars(10, 110.5, 108.5, 105, 107.6, 4),
      breakoutClose: 111.3,
    },
    {
      name: "bearish_pennant",
      pole: [
        indexedBar(0, 110, 110.3, 107.2, 107.5),
        indexedBar(1, 107.5, 107.8, 104.7, 105),
        indexedBar(2, 105, 105.3, 102.2, 102.5),
        indexedBar(3, 102.5, 102.8, 99.7, 100),
      ],
      consolidation: boundaryBars(10, 105, 102.4, 99.5, 101.5, 4),
      breakoutClose: 98.7,
    },
  ])("detects a confirmed $name continuation without using the breakout early", ({
    name,
    pole,
    consolidation,
    breakoutClose,
  }) => {
    const formation = [...pole, ...consolidation];
    expect(names(formation)).not.toContain(name);
    const completed = withBreakout(formation, breakoutClose);
    expect(detectSimulationChartPatterns(completed)).toEqual(expect.arrayContaining([
      expect.objectContaining({ name, detectedAt: completed.at(-1)!.timestamp }),
    ]));
  });

  it.each([
    {
      name: "bullish_flag",
      consolidation: boundaryBars(6, 110.4, 109.2, 107.5, 106.3, 4),
      breakoutClose: 111.2,
    },
    {
      name: "bullish_pennant",
      consolidation: boundaryBars(8, 110.5, 108.8, 105, 107.4, 4),
      breakoutClose: 111.3,
    },
  ])("supports the advertised short consolidation window for $name", ({
    name,
    consolidation,
    breakoutClose,
  }) => {
    const pole = [
      indexedBar(0, 100, 102.8, 99.7, 102.5),
      indexedBar(1, 102.5, 105.3, 102.2, 105),
      indexedBar(2, 105, 107.8, 104.7, 107.5),
      indexedBar(3, 107.5, 110.3, 107.2, 110),
    ];
    const completed = withBreakout([...pole, ...consolidation], breakoutClose);
    expect(detectSimulationChartPatterns(completed)).toEqual(expect.arrayContaining([
      expect.objectContaining({ name, detectedAt: completed.at(-1)!.timestamp }),
    ]));
  });

  it.each([
    {
      name: "double_top",
      bias: "bearish",
      values: [
        [100, 101, 99, 100],
        [100, 110, 101, 108],
        [108, 108.5, 102.5, 104],
        [104, 105, 98, 100],
        [100, 106, 99.5, 105],
        [105, 109.8, 104, 108],
        [108, 108.3, 102, 104],
        [104, 104.5, 98.5, 99],
        [99, 99.2, 95.5, 96],
      ],
    },
    {
      name: "double_bottom",
      bias: "bullish",
      values: [
        [100, 101, 99, 100],
        [100, 101, 90, 92],
        [92, 97.5, 91.5, 96],
        [96, 102, 95, 100],
        [100, 100.5, 94, 95],
        [95, 96, 90.2, 92],
        [92, 98, 91.8, 96],
        [96, 101.5, 95.5, 101],
        [101, 104.5, 100.8, 104],
      ],
    },
    {
      name: "head_and_shoulders",
      bias: "bearish",
      values: [
        [100, 101, 99, 100],
        [103, 108, 102, 107],
        [103, 104, 100.5, 102],
        [103, 113, 102, 112],
        [103, 104, 100, 102],
        [102, 108.5, 101.5, 107],
        [104, 105, 101.5, 103],
        [102, 103, 100.7, 101.5],
        [101.5, 101.8, 95.5, 96.5],
      ],
    },
    {
      name: "inverse_head_and_shoulders",
      bias: "bullish",
      values: [
        [100, 101, 99, 100],
        [97, 97.5, 92, 93],
        [97, 99.5, 96, 98],
        [97, 97.5, 87, 88],
        [97, 99, 96, 98],
        [97, 97.5, 91.5, 93],
        [96, 98.5, 95, 97],
        [97, 99, 96.5, 98],
        [98, 103, 97.8, 102],
      ],
    },
  ])("confirms $name at the neckline break", ({ name, bias, values }) => {
    const sequence = values.map(([open, high, low, close], index) => (
      indexedBar(index, open!, high!, low!, close!)
    ));
    expect(names(sequence.slice(0, -1))).not.toContain(name);
    expect(detectSimulationChartPatterns(sequence)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name,
        bias,
        detectedAt: sequence.at(-1)!.timestamp,
      }),
    ]));
  });

  it("detects both channel breakout directions and remains deterministic and bounded", () => {
    const channel = boundaryBars(12, 101, 101, 99, 99);
    const bullish = withBreakout(channel, 102);
    expect(names(bullish)).toContain("bullish_channel_breakout");

    const bearishChannel = boundaryBars(12, 111, 111, 109, 109);
    expect(names(withBreakout(bearishChannel, 108))).toContain("bearish_channel_breakout");

    const longSeries = Array.from({ length: 220 }, (_, index) => {
      const level = 100 + Math.floor(index / 13) * 3;
      return indexedBar(index, level, level + 1, level - 1, level + (index % 13 === 12 ? 2 : 0));
    });
    const first = detectSimulationChartPatterns(longSeries);
    expect(first.length).toBeLessThanOrEqual(120);
    expect(detectSimulationChartPatterns(longSeries)).toEqual(first);
  });

  it("requires fitted parallel boundaries with distributed touches for a channel breakout", () => {
    const malformed = boundaryBars(12, 101, 101, 99, 99).map((item, index) => (
      index === 5 ? { ...item, high: 110 } : item
    ));
    expect(names(withBreakout(malformed, 111))).not.toContain("bullish_channel_breakout");
  });

  it.each([
    ["missing minute", 60_000],
    ["overnight boundary", 24 * 60 * 60_000],
  ])("does not form structures across a %s", (_label, gapMs) => {
    const formation = boundaryBars(12, 101, 101, 99, 99).map((item, index) => (
      index < 6
        ? item
        : { ...item, timestamp: new Date(Date.parse(item.timestamp) + gapMs).toISOString() }
    ));
    const last = formation.at(-1)!;
    const breakout = {
      ...indexedBar(formation.length, last.close, 102.4, 101.6, 102),
      timestamp: new Date(Date.parse(last.timestamp) + 60_000).toISOString(),
    };
    expect(names([...formation, breakout])).not.toContain("bullish_channel_breakout");
  });
});
