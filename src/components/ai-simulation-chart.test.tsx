import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  AiSimulationChart,
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
  lane: "kronos_base",
  signalSymbol: "SOXL",
  status: "available",
  origin: "2026-07-24T09:02:00+09:00",
  generatedAt: "2026-07-24T00:02:00.250Z",
  modelId: "NeoQuasar/Kronos-base",
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

  it("appends independent Kronos and FinCast targets on the numeric candle timeline", () => {
    const rows = aiSimulationCombinedChartRows(bars, modelForecasts);
    const originTime = Date.parse("2026-07-24T09:02:00+09:00");
    const kronosTargetTime = Date.parse("2026-07-24T09:07:00+09:00");
    const fincastTargetTime = Date.parse("2026-07-24T09:17:00+09:00");
    const origin = rows.find((row) => row.time === originTime);
    const kronosTarget = rows.find((row) => row.time === kronosTargetTime);
    const fincastTarget = rows.find((row) => row.time === fincastTargetTime);

    expect(rows.map((row) => row.time)).toEqual([
      Date.parse("2026-07-24T09:01:00+09:00"),
      originTime,
      Date.parse("2026-07-24T09:03:00+09:00"),
      kronosTargetTime,
      fincastTargetTime,
    ]);
    expect(rows.every((row) => Number.isFinite(row.time))).toBe(true);
    expect(origin).toMatchObject({
      close: 101,
      "forecast:kronos_base:range": [101, 101],
      "forecast:kronos_base:median": 101,
      "forecast:fincast:range": [101, 101],
      "forecast:fincast:median": 101,
    });
    expect(kronosTarget).toMatchObject({
      timestamp: "2026-07-24T00:07:00.000Z",
      "forecast:kronos_base:range": [99, 106],
      "forecast:kronos_base:median": 103,
    });
    expect(kronosTarget).not.toHaveProperty("candleRange");
    expect(fincastTarget).toMatchObject({
      timestamp: "2026-07-24T00:17:00.000Z",
      "forecast:fincast:range": [98, 108],
      "forecast:fincast:median": 104,
    });
    expect(rows.some((row) => (
      row.time > originTime
      && row.time < kronosTargetTime
      && row.time !== Date.parse("2026-07-24T09:03:00+09:00")
    ))).toBe(false);
  });

  it("anchors a sub-minute FinCast origin by its observed price while keeping minute horizons", () => {
    const forecast: AiSimulationModelForecast = {
      lane: "fincast",
      signalSymbol: "BTCUSDT",
      status: "available",
      origin: "2026-07-24T09:02:29.999+09:00",
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

    expect(formingOrigin).not.toHaveProperty("forecast:kronos_base:range");
    expect(formingOrigin).not.toHaveProperty("forecast:kronos_base:median");
    expect(target).toMatchObject({
      "forecast:kronos_base:range": [100, 109],
      "forecast:kronos_base:median": 105,
    });
    expect(rows).toHaveLength(bars.length + 1);
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
    expect(markup).toContain('data-ai-simulation-model-forecast="kronos_base"');
    expect(markup).toContain('data-ai-simulation-model-forecast="fincast"');
    expect(markup).toContain('data-ai-simulation-model-forecast-origin="exact-final"');
    expect(markup).toContain("분봉 뒤에 이어진 모델 예측");
    expect(markup).toContain("<details");
    expect(markup).toContain("중앙");
    expect(markup).toContain("Q10");
    expect(markup).toContain("Q90");
  });
});
