import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  AiSimulationChart,
  aiSimulationPriceLayers,
  aiSimulationChartTradePoints,
  aiSimulationChartCoordinateRows,
  aiSimulationCombinedChartRows,
  aiSimulationCurrentModelForecasts,
  aiSimulationNearestChartRow,
  aiSimulationTradeMarkerColor,
  type AiSimulationChartBar,
} from "./ai-simulation-chart";
import type { AiSimulationModelForecast } from "@/lib/ai-simulation-forecast";

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

const modelForecasts: AiSimulationModelForecast[] = [{
  lane: "chronos2",
  signalSymbol: "SOXL",
  status: "available",
  projectionPolicy: "native_input_origin",
  origin: "2026-07-24T09:02:00+09:00",
  generatedAt: "2026-07-24T00:02:00.250Z",
  modelId: "amazon/chronos-2",
  points: [{
    horizonMinutes: 5,
    targetTimestamp: "2026-07-24T09:07:00+09:00",
    q10Price: 99,
    medianPrice: 103,
    q90Price: 106,
  }],
}, {
  lane: "fincast",
  signalSymbol: "SOXL",
  status: "available",
  projectionPolicy: "native_input_origin",
  origin: "2026-07-24T09:02:00+09:00",
  generatedAt: "2026-07-24T00:02:00.300Z",
  modelId: "Vincent05R/FinCast",
  points: [{
    horizonMinutes: 15,
    targetTimestamp: "2026-07-24T09:17:00+09:00",
    q10Price: 98,
    medianPrice: 104,
    q90Price: 108,
  }],
}];

describe("AiSimulationChart", () => {
  it("groups Bollinger upper and lower values into one range plus a middle line", () => {
    const layers = aiSimulationPriceLayers([{
      indicatorValues: {
        "bb:upper": 110,
        "bb:middle": 100,
        "bb:lower": 90,
        "bb-width:upper": 110,
        "bb-width:middle": 100,
        "bb-width:lower": 90,
        "donchian:upper": 112,
        "donchian:middle": 101,
        "donchian:lower": 88,
      },
    }], [{ id: "bb", kind: "bollinger_bands", status: "available", values: {} }, {
      id: "bb-width",
      kind: "bollinger_band_width_percent_b",
      status: "available",
      values: {},
    }, {
      id: "donchian",
      kind: "donchian_channel",
      status: "available",
      values: {},
    }]);

    expect(layers.bands).toEqual([expect.objectContaining({
      key: "bb:range",
      lowerKey: "bb:lower",
      upperKey: "bb:upper",
    })]);
    expect(layers.lines.map((line) => line.key)).toEqual([
      "bb:middle",
      "donchian:upper",
      "donchian:middle",
      "donchian:lower",
    ]);
    expect(layers.lines.find((line) => line.key === "bb:middle")?.bollingerMiddle).toBe(true);
    expect(layers.lines.some((line) => line.key === "bb-width:middle")).toBe(false);
  });

  it("does not create an empty Bollinger range from disjoint bounds", () => {
    const layers = aiSimulationPriceLayers([{
      indicatorValues: { "bb:lower": 90, "bb:middle": 100 },
    }, {
      indicatorValues: { "bb:upper": 110, "bb:middle": 101 },
    }], [{ id: "bb", kind: "bollinger_bands", status: "available", values: {} }]);

    expect(layers.bands).toEqual([]);
    expect(layers.lines.map((line) => line.key)).toEqual(["bb:middle"]);
  });

  it("assigns different colors to distinct Bollinger ranges", () => {
    const layers = aiSimulationPriceLayers([{
      indicatorValues: {
        "bb-fast:lower": 92,
        "bb-fast:middle": 100,
        "bb-fast:upper": 108,
        "bb-slow:lower": 88,
        "bb-slow:middle": 99,
        "bb-slow:upper": 112,
      },
    }], [{ id: "bb-fast", kind: "bollinger_bands", status: "available", values: {} }, {
      id: "bb-slow",
      kind: "bollinger_bands",
      status: "available",
      values: {},
    }]);

    expect(layers.bands.map((band) => band.colorIndex)).toEqual([0, 1]);
    expect(layers.lines.map((line) => line.bandColorIndex)).toEqual([0, 1]);
  });

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

  it("renders a localized structural-pattern label and its directional evidence", () => {
    const markup = renderToStaticMarkup(
      <AiSimulationChart
        symbol="BTCUSDT"
        currency="USDT"
        bars={bars}
        trades={[]}
        indicators={[]}
        patterns={[{
          detectedAt: "2026-07-24T09:02:00+09:00",
          name: "ascending_triangle",
          bias: "bullish",
          strength: 0.72,
        }]}
      />,
    );

    expect(markup).toContain('data-ai-simulation-pattern="bullish"');
    expect(markup).toContain("상승 삼각형");
    expect(markup).toContain("강도 72%");
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

  it("colors buys red and sells blue from order side even for opposite position sides", () => {
    const futuresTrades = [
      { side: "buy" as const, positionSide: "short" as const },
      { side: "sell" as const, positionSide: "long" as const },
    ];

    expect(futuresTrades.map((trade) => aiSimulationTradeMarkerColor(trade.side))).toEqual([
      "var(--candle-rise)",
      "var(--candle-fall)",
    ]);
    expect(aiSimulationTradeMarkerColor("buy")).toBe("var(--candle-rise)");
    expect(aiSimulationTradeMarkerColor("sell")).toBe("var(--candle-fall)");
  });

  it("appends independent Chronos-2 and FinCast targets on the numeric candle timeline", () => {
    const rows = aiSimulationCombinedChartRows(bars, modelForecasts);
    const originTime = Date.parse("2026-07-24T09:02:00+09:00");
    const chronos2TargetTime = Date.parse("2026-07-24T09:07:00+09:00");
    const fincastTargetTime = Date.parse("2026-07-24T09:17:00+09:00");
    const origin = rows.find((row) => row.time === originTime);
    const chronos2Target = rows.find((row) => row.time === chronos2TargetTime);
    const fincastTarget = rows.find((row) => row.time === fincastTargetTime);

    expect(rows.map((row) => row.time)).toEqual([
      Date.parse("2026-07-24T09:01:00+09:00"),
      originTime,
      Date.parse("2026-07-24T09:03:00+09:00"),
      chronos2TargetTime,
      fincastTargetTime,
    ]);
    expect(rows.every((row) => Number.isFinite(row.time))).toBe(true);
    expect(origin).toMatchObject({
      close: 101,
      "forecast:chronos2:range": [101, 101],
      "forecast:chronos2:median": 101,
      "forecast:fincast:range": [101, 101],
      "forecast:fincast:median": 101,
    });
    expect(chronos2Target).toMatchObject({
      timestamp: "2026-07-24T00:07:00.000Z",
      "forecast:chronos2:range": [99, 106],
      "forecast:chronos2:median": 103,
    });
    expect(chronos2Target).not.toHaveProperty("candleRange");
    expect(fincastTarget).toMatchObject({
      timestamp: "2026-07-24T00:17:00.000Z",
      "forecast:fincast:range": [98, 108],
      "forecast:fincast:median": 104,
    });
    expect(rows.some((row) => (
      row.time > originTime
      && row.time < chronos2TargetTime
      && row.time !== Date.parse("2026-07-24T09:03:00+09:00")
    ))).toBe(false);
  });

  it("anchors a sub-minute FinCast origin by its observed price while keeping minute horizons", () => {
    const forecast: AiSimulationModelForecast = {
      lane: "fincast",
      signalSymbol: "BTCUSDT",
      status: "available",
      projectionPolicy: "live_price_rebase/v1",
      origin: "2026-07-24T09:02:29.999+09:00",
      inputOrigin: "2026-07-24T09:02:00+09:00",
      originPrice: 101.5,
      points: [{
        horizonMinutes: 5,
        targetTimestamp: "2026-07-24T09:07:29.999+09:00",
        q10Price: 99,
        medianPrice: 103,
        q90Price: 106,
      }],
    };
    const current = aiSimulationCurrentModelForecasts(bars, [forecast]);
    const rows = aiSimulationCombinedChartRows(bars, current);
    const origin = rows.find((row) => row.time === Date.parse(forecast.origin!));

    expect(current).toEqual([forecast]);
    expect(origin).toMatchObject({
      "forecast:fincast:range": [101.5, 101.5],
      "forecast:fincast:median": 101.5,
    });
    expect(forecast.points[0]!.horizonMinutes).toBe(5);
    expect(Date.parse(forecast.points[0]!.targetTimestamp) - Date.parse(forecast.origin!))
      .toBe(5 * 60_000);
  });

  it("selects the nearest cursor row for the fixed metrics panel", () => {
    const rows = aiSimulationChartCoordinateRows(
      aiSimulationCombinedChartRows(bars),
      true,
    );
    const wanted = rows[1]!;

    expect(aiSimulationNearestChartRow(rows, (wanted.chartTime ?? wanted.time) + 1)?.time)
      .toBe(wanted.time);
  });

  it("uses ordered timestamp lookup with stable boundary and tie behavior", () => {
    const rows = Array.from({ length: 10_000 }, (_, index) => ({
      timestamp: new Date(index * 1_000).toISOString(),
      time: index * 1_000,
      chartTime: index * 1_000,
      indicatorValues: {},
    }));

    expect(aiSimulationNearestChartRow(rows, -1)?.time).toBe(0);
    expect(aiSimulationNearestChartRow(rows, 10_000_000)?.time).toBe(9_999_000);
    expect(aiSimulationNearestChartRow(rows, 5_000_500)?.time).toBe(5_000_000);
    expect(aiSimulationNearestChartRow(rows, 5_000_501)?.time).toBe(5_001_000);
  });

  it("renders an outside cursor metrics panel and an accessible fullscreen control", () => {
    const markup = renderToStaticMarkup(
      <AiSimulationChart
        symbol="BTCUSDT"
        currency="USDT"
        bars={bars.map((bar) => ({
          ...bar,
          indicatorValues: { rsi: 55.5 },
        }))}
        trades={[]}
        indicators={[]}
        patterns={[]}
      />,
    );

    expect(markup).toContain("data-ai-simulation-hover-metrics");
    expect(markup).toContain("rsi 55.5");
    expect(markup).toContain('aria-label="BTCUSDT 차트 전체화면 확대"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-haspopup="dialog"');
    expect(markup).toMatch(/aria-controls="[^"]+"/);
    expect(markup).toContain('data-ai-simulation-chart-expanded="false"');
  });

  it("compresses stock session gaps but preserves the future horizon scale", () => {
    const stockRows = aiSimulationCombinedChartRows([
      ...bars.slice(0, 2),
      {
        ...bars[2]!,
        timestamp: "2026-07-27T09:01:00+09:00",
        status: "final",
      },
    ], [{
      ...modelForecasts[0]!,
      origin: "2026-07-27T09:01:00+09:00",
      points: [{
        ...modelForecasts[0]!.points[0]!,
        targetTimestamp: "2026-07-27T09:06:00+09:00",
      }],
    }]);
    const compressed = aiSimulationChartCoordinateRows(stockRows, false);
    const continuous = aiSimulationChartCoordinateRows(stockRows, true);
    const first = compressed[0]!;
    const lastCandle = compressed.find(
      (row) => row.time === Date.parse("2026-07-27T09:01:00+09:00"),
    )!;
    const target = compressed.at(-1)!;

    expect((lastCandle.chartTime ?? 0) - (first.chartTime ?? 0)).toBe(2 * 60_000);
    expect((target.chartTime ?? 0) - (lastCandle.chartTime ?? 0)).toBe(5 * 60_000);
    expect(continuous.every((row) => row.chartTime === row.time)).toBe(true);
  });

  it("uses trading-horizon minutes instead of a weekend wall-clock gap for stock forecasts", () => {
    const fridayBars: AiSimulationChartBar[] = [{
      ...bars[0]!,
      timestamp: "2026-07-24T15:59:00+09:00",
    }, {
      ...bars[1]!,
      timestamp: "2026-07-24T16:00:00+09:00",
    }];
    const originTime = Date.parse("2026-07-24T16:00:00+09:00");
    const targetTime = Date.parse("2026-07-27T09:05:00+09:00");
    const rows = aiSimulationCombinedChartRows(fridayBars, [{
      ...modelForecasts[0]!,
      origin: new Date(originTime).toISOString(),
      points: [{
        ...modelForecasts[0]!.points[0]!,
        horizonMinutes: 5,
        targetTimestamp: new Date(targetTime).toISOString(),
      }],
    }]);
    const stock = aiSimulationChartCoordinateRows(rows, false);
    const crypto = aiSimulationChartCoordinateRows(rows, true);
    const stockOrigin = stock.find((row) => row.time === originTime)!;
    const stockTarget = stock.find((row) => row.time === targetTime)!;
    const cryptoOrigin = crypto.find((row) => row.time === originTime)!;
    const cryptoTarget = crypto.find((row) => row.time === targetTime)!;

    expect((stockTarget.chartTime ?? 0) - (stockOrigin.chartTime ?? 0)).toBe(5 * 60_000);
    expect((cryptoTarget.chartTime ?? 0) - (cryptoOrigin.chartTime ?? 0))
      .toBe(targetTime - originTime);
  });

  it("never anchors a forecast to a forming or prior candle and does not interpolate it", () => {
    const formingOriginForecast: AiSimulationModelForecast = {
      ...modelForecasts[0]!,
      origin: "2026-07-24T09:03:00+09:00",
      points: [{
        horizonMinutes: 5,
        targetTimestamp: "2026-07-24T09:08:00+09:00",
        q10Price: 100,
        medianPrice: 105,
        q90Price: 109,
      }],
    };
    const rows = aiSimulationCombinedChartRows(bars, [formingOriginForecast]);
    const formingOrigin = rows.find(
      (row) => row.time === Date.parse("2026-07-24T09:03:00+09:00"),
    );
    const target = rows.find(
      (row) => row.time === Date.parse("2026-07-24T09:08:00+09:00"),
    );

    expect(formingOrigin).not.toHaveProperty("forecast:chronos2:range");
    expect(formingOrigin).not.toHaveProperty("forecast:chronos2:median");
    expect(target).toMatchObject({
      "forecast:chronos2:range": [100, 109],
      "forecast:chronos2:median": 105,
    });
    expect(rows).toHaveLength(bars.length + 1);
  });

  it("anchors a five-second live projection to its observed price and keeps one-bar grace", () => {
    const liveForecast: AiSimulationModelForecast = {
      ...modelForecasts[1]!,
      origin: "2026-07-24T09:02:55+09:00",
      inputOrigin: "2026-07-24T09:02:00+09:00",
      originPrice: 101.75,
      projectionPolicy: "live_price_rebase/v1",
      generatedAt: "2026-07-24T00:02:55.500Z",
    };
    const rows = aiSimulationCombinedChartRows(bars, [liveForecast]);
    const origin = rows.find(
      (row) => row.time === Date.parse(liveForecast.origin!),
    );

    expect(origin).toMatchObject({
      "forecast:fincast:range": [101.75, 101.75],
      "forecast:fincast:median": 101.75,
    });
    expect(aiSimulationCurrentModelForecasts(bars, [liveForecast]))
      .toEqual([liveForecast]);

    const nextMinuteBars: AiSimulationChartBar[] = [
      ...bars.slice(0, -1),
      { ...bars.at(-1)!, status: "final" },
      {
        ...bars.at(-1)!,
        timestamp: "2026-07-24T09:04:00+09:00",
        status: "forming",
      },
    ];
    expect(aiSimulationCurrentModelForecasts(nextMinuteBars, [liveForecast]))
      .toEqual([liveForecast]);

    const delayedBoundaryForecast: AiSimulationModelForecast = {
      ...liveForecast,
      origin: "2026-07-24T09:03:00.500+09:00",
      generatedAt: "2026-07-24T00:03:01.000Z",
    };
    expect(
      Date.parse(delayedBoundaryForecast.origin!)
        - Date.parse(delayedBoundaryForecast.inputOrigin!),
    ).toBeGreaterThan(60_000);
    expect(aiSimulationCurrentModelForecasts(nextMinuteBars, [delayedBoundaryForecast]))
      .toEqual([delayedBoundaryForecast]);

    const twoMinutesLater = nextMinuteBars.map((bar, index) => (
      index === nextMinuteBars.length - 1
        ? { ...bar, status: "final" as const }
        : bar
    ));
    expect(aiSimulationCurrentModelForecasts(twoMinutesLater, [liveForecast]))
      .toEqual([]);
  });

  it("fails stale forecasts closed once a newer finalized candle exists", () => {
    const stale = [{
      ...modelForecasts[0]!,
      origin: "2026-07-24T09:01:00+09:00",
    }];
    expect(aiSimulationCurrentModelForecasts(bars, stale)).toEqual([]);
    expect(aiSimulationCurrentModelForecasts(bars, [modelForecasts[0]!]))
      .toEqual([modelForecasts[0]]);

    const markup = renderToStaticMarkup(
      <AiSimulationChart
        symbol="SOXL"
        currency="USD"
        bars={bars}
        trades={[]}
        indicators={[]}
        patterns={[]}
        forecasts={stale}
      />,
    );
    expect(markup).toContain('data-ai-simulation-model-forecast-status="stale"');
    expect(markup).toContain("최신 확정봉보다 오래된 예측은 미래 경로로 표시하지 않습니다.");
    expect(markup).not.toContain('data-ai-simulation-model-forecast-horizon=');
  });

  it("labels the latest forming candle as a live price with its observed time", () => {
    const markup = renderToStaticMarkup(
      <AiSimulationChart
        symbol="SOXL"
        currency="USD"
        bars={bars}
        trades={[]}
        indicators={[]}
        patterns={[]}
        updatedAt="2026-07-24T00:02:12.345Z"
      />,
    );

    expect(markup).toContain("현재가");
    expect(markup).toContain("실시간 진행봉");
    expect(markup).toContain('data-ai-simulation-latest-bar-status="forming"');
    expect(markup).toContain("갱신");
  });

  it("renders both model paths as overlays inside the candle chart card", () => {
    const markup = renderToStaticMarkup(
      <AiSimulationChart
        symbol="SOXL"
        currency="USD"
        bars={bars}
        trades={[]}
        indicators={[]}
        patterns={[]}
        forecasts={modelForecasts}
      />,
    );

    expect(markup).toContain('data-ai-simulation-price-chart="true"');
    expect(markup).toContain('data-ai-simulation-model-forecast-overlay="true"');
    expect(markup).toContain('data-ai-simulation-model-forecast="chronos2"');
    expect(markup).toContain('data-ai-simulation-model-forecast="chronos2"');
    expect(markup).toContain('data-ai-simulation-model-forecast="fincast"');
    expect(markup).toContain('data-ai-simulation-model-forecast-origin="exact-final"');
    expect(markup).toContain("분봉 뒤에 이어진 모델 예측");
    expect(markup).toContain("<details");
    expect(markup).toContain("중앙");
    expect(markup).toContain("Q10");
    expect(markup).toContain("Q90");
  });
});
