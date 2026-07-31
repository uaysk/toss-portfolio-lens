import { describe, expect, it } from "vitest";
import {
  mergeLatestModelForecasts,
  modelForecastChartRows,
  normalizeAiSimulationModelForecasts,
  selectExactModelForecastActualMark,
  type AiSimulationModelForecast,
} from "./ai-simulation-forecast";

const ORIGIN = "2026-07-24T17:02:00.000Z";

function forecast(
  lane: "chronos2" | "fincast" = "chronos2",
  overrides: Partial<AiSimulationModelForecast> = {},
): AiSimulationModelForecast {
  return {
    lane,
    signalSymbol: "TSLA",
    status: "available",
    projectionPolicy: "native_input_origin",
    origin: ORIGIN,
    generatedAt: "2026-07-24T17:02:00.500Z",
    modelId: lane === "chronos2" ? "amazon/chronos-2" : "Vincent05R/FinCast",
    modelRevision: "pinned",
    points: [{
      horizonMinutes: 5,
      targetTimestamp: "2026-07-24T17:07:00.000Z",
      q10Price: 98,
      medianPrice: 100,
      q90Price: 102,
      upProbability: 0.6,
    }],
    ...overrides,
  };
}

describe("AI simulation model forecasts", () => {
  it("accepts only canonical FinCast and Chronos-2 lane identities", () => {
    expect(normalizeAiSimulationModelForecasts([
      forecast("chronos2"),
      forecast("fincast", { signalSymbol: "AAPL" }),
    ])).toHaveLength(2);

    expect(normalizeAiSimulationModelForecasts([{
      ...forecast("chronos2"),
      lane: "removed_lane",
    }])).toEqual([]);
    expect(normalizeAiSimulationModelForecasts([{
      ...forecast("chronos2"),
      modelId: "unexpected/model",
    }])).toEqual([]);
  });

  it("rejects invalid horizons and unavailable projections fail closed", () => {
    const normalized = normalizeAiSimulationModelForecasts([{
      ...forecast(),
      points: [{
        horizonMinutes: 7,
        targetTimestamp: "2026-07-24T17:09:00.000Z",
        q10Price: 102,
        medianPrice: 100,
        q90Price: 98,
      }],
    }]);
    expect(normalized).toEqual([expect.objectContaining({
      lane: "chronos2",
      status: "unavailable",
      points: [],
    })]);
  });

  it("keeps the newest forecast independently for each symbol and lane", () => {
    const older = forecast("chronos2", {
      generatedAt: "2026-07-24T17:02:00.100Z",
      modelRevision: "older",
    });
    const newer = forecast("chronos2", {
      generatedAt: "2026-07-24T17:02:00.900Z",
      modelRevision: "newer",
    });
    const fincast = forecast("fincast");
    const merged = mergeLatestModelForecasts([older], [fincast, newer]);
    expect(merged).toHaveLength(2);
    expect(merged.find(({ lane }) => lane === "chronos2")?.modelRevision).toBe("newer");
    expect(merged.find(({ lane }) => lane === "fincast")).toBeDefined();
  });

  it("marks only a finalized close at the exact model origin", () => {
    const actual = selectExactModelForecastActualMark(forecast(), [{
      symbol: "TSLA",
      bars: [{
        timestamp: ORIGIN,
        close: 100,
        status: "final",
      }, {
        timestamp: "2026-07-24T17:01:00.000Z",
        close: 99,
        status: "final",
      }],
    }]);
    expect(actual).toEqual({ timestamp: ORIGIN, close: 100 });
    expect(selectExactModelForecastActualMark(forecast(), [{
      symbol: "TSLA",
      bars: [{ timestamp: ORIGIN, close: 100, status: "forming" }],
    }])).toBeUndefined();
  });

  it("builds a chart with an origin mark and raw quantile rows", () => {
    expect(modelForecastChartRows(
      forecast(),
      { timestamp: ORIGIN, close: 100 },
    )).toEqual([
      { timestamp: ORIGIN, actualPrice: 100 },
      {
        timestamp: "2026-07-24T17:07:00.000Z",
        q10Price: 98,
        medianPrice: 100,
        q90Price: 102,
        predictionRange: [98, 102],
        horizonMinutes: 5,
        upProbability: 0.6,
      },
    ]);
  });
});
