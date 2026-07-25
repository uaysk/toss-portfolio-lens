import { describe, expect, it } from "vitest";
import {
  kronosForecastChartRows,
  normalizeAiSimulationModelForecasts,
  selectExactKronosForecastActualMark,
  selectLatestKronosForecasts,
} from "./ai-simulation-forecast";
import { normalizeAiSimulationSnapshot } from "./ai-simulation";

const ORIGIN = "2026-07-24T17:02:00.000Z";

function quantiles(base: number) {
  return [
    { quantile: 0.05, value: base - 3 },
    { quantile: 0.1, value: base - 2 },
    { quantile: 0.25, value: base - 1 },
    { quantile: 0.5, value: base },
    { quantile: 0.75, value: base + 1 },
    { quantile: 0.9, value: base + 2 },
    { quantile: 0.95, value: base + 3 },
  ];
}

function decision({
  origin = ORIGIN,
  modelId = "NeoQuasar/Kronos-base",
  omitMedian = false,
}: {
  origin?: string;
  modelId?: string;
  omitMedian?: boolean;
} = {}) {
  return {
    signalSymbol: "TSLA",
    decidedAt: new Date(Date.parse(origin) + 500).toISOString(),
    modelOutputs: {
      kronos: {
        status: "available",
        signalSymbol: "TSLA",
        inputEndAt: origin,
        generatedAt: new Date(Date.parse(origin) + 250).toISOString(),
        provenance: {
          modelId,
          modelRevision: "base-revision",
        },
        rawOutput: {
          role: "kronos_base",
          expected_model_id: "NeoQuasar/Kronos-base",
          status: "available",
          model: {
            model_id: modelId,
            model_revision: "base-revision",
          },
          raw_series: [{
            instrument_key: "TSLA",
            status: "available",
            input_end_at: origin,
            horizons: [5, 15, 30, 60].map((minutes, index) => ({
              horizon_minutes: minutes,
              target_timestamp: new Date(Date.parse(origin) + minutes * 60_000).toISOString(),
              price_quantiles: quantiles(250 + index).filter(
                (point) => !omitMedian || point.quantile !== 0.5,
              ),
              up_probability: 0.64 + index / 100,
            })),
          }],
        },
      },
    },
  };
}

function directForecast(
  lane: "kronos_base" | "fincast",
  {
    origin = ORIGIN,
    generatedOffsetMs = lane === "kronos_base" ? 250 : 300,
  }: {
    origin?: string;
    generatedOffsetMs?: number;
  } = {},
) {
  const modelId = lane === "kronos_base"
    ? "NeoQuasar/Kronos-base"
    : "Vincent05R/FinCast";
  const base = lane === "kronos_base" ? 250 : 252;
  return {
    lane,
    signalSymbol: "TSLA",
    status: "available",
    origin,
    generatedAt: new Date(Date.parse(origin) + generatedOffsetMs).toISOString(),
    modelId,
    modelRevision: `${lane}-revision`,
    points: [5, 15].map((minutes, index) => ({
      horizonMinutes: minutes,
      targetTimestamp: new Date(Date.parse(origin) + minutes * 60_000).toISOString(),
      q10Price: base + index - 2,
      medianPrice: base + index,
      q90Price: base + index + 2,
      upProbability: 0.6 + index / 100,
    })),
  };
}

describe("Kronos-base simulation forecast normalization", () => {
  it("uses only direct raw price quantiles and preserves origin and target timestamps", () => {
    const forecasts = selectLatestKronosForecasts([decision()]);

    expect(forecasts).toEqual([{
      signalSymbol: "TSLA",
      status: "available",
      origin: ORIGIN,
      generatedAt: "2026-07-24T17:02:00.250Z",
      modelId: "NeoQuasar/Kronos-base",
      modelRevision: "base-revision",
      points: [
        {
          horizonMinutes: 5,
          targetTimestamp: "2026-07-24T17:07:00.000Z",
          q10Price: 248,
          medianPrice: 250,
          q90Price: 252,
          upProbability: 0.64,
        },
        expect.objectContaining({
          horizonMinutes: 15,
          targetTimestamp: "2026-07-24T17:17:00.000Z",
          q10Price: 249,
          medianPrice: 251,
          q90Price: 253,
        }),
        expect.objectContaining({ horizonMinutes: 30 }),
        expect.objectContaining({ horizonMinutes: 60 }),
      ],
    }]);
  });

  it("does not interpolate a missing median or accept another model identity", () => {
    expect(selectLatestKronosForecasts([decision({ omitMedian: true })])).toEqual([
      expect.objectContaining({
        signalSymbol: "TSLA",
        status: "unavailable",
        points: [],
      }),
    ]);
    expect(selectLatestKronosForecasts([
      decision({ modelId: "NeoQuasar/Kronos-small" }),
    ])).toEqual([]);
  });

  it("selects the newest origin even when it is unavailable instead of showing stale output", () => {
    const newer = new Date(Date.parse(ORIGIN) + 60_000).toISOString();
    const forecasts = selectLatestKronosForecasts([
      decision(),
      decision({ origin: newer, omitMedian: true }),
    ]);
    expect(forecasts).toEqual([
      expect.objectContaining({
        origin: newer,
        status: "unavailable",
        points: [],
      }),
    ]);
  });

  it("uses only the exact finalized origin close as the actual marker", () => {
    const forecast = selectLatestKronosForecasts([decision()])[0]!;
    const exact = selectExactKronosForecastActualMark(forecast, [{
      symbol: "TSLA",
      bars: [
        { timestamp: "2026-07-24T17:01:00.000Z", close: 249, status: "final" },
        { timestamp: ORIGIN, close: 250, status: "final" },
        { timestamp: "2026-07-24T17:03:00.000Z", close: 251, status: "forming" },
      ],
    }]);
    expect(exact).toEqual({ timestamp: ORIGIN, close: 250 });
    expect(kronosForecastChartRows(forecast, exact)).toEqual([
      { timestamp: ORIGIN, actualPrice: 250 },
      expect.objectContaining({
        timestamp: "2026-07-24T17:07:00.000Z",
        predictionRange: [248, 252],
      }),
      expect.any(Object),
      expect.any(Object),
      expect.any(Object),
    ]);

    expect(selectExactKronosForecastActualMark(forecast, [{
      symbol: "TSLA",
      bars: [
        { timestamp: "2026-07-24T17:01:00.000Z", close: 249, status: "final" },
        { timestamp: ORIGIN, close: 250, status: "forming" },
      ],
    }])).toBeUndefined();
  });

  it("reads the same raw output from persisted provenance replay input", () => {
    const modelOutput = decision().modelOutputs.kronos;
    const forecasts = selectLatestKronosForecasts([{
      rawInputs: { kronos: modelOutput.rawOutput },
      replayInput: {
        models: {
          kronos: modelOutput,
        },
      },
    }]);
    expect(forecasts).toEqual([
      expect.objectContaining({
        signalSymbol: "TSLA",
        status: "available",
        origin: ORIGIN,
        points: expect.arrayContaining([
          expect.objectContaining({ horizonMinutes: 60, medianPrice: 253 }),
        ]),
      }),
    ]);
  });

  it("preserves direct Kronos and FinCast projections as independent lanes", () => {
    const forecasts = normalizeAiSimulationModelForecasts([
      directForecast("kronos_base"),
      directForecast("fincast"),
    ]);

    expect(forecasts).toEqual([
      expect.objectContaining({
        lane: "fincast",
        signalSymbol: "TSLA",
        modelId: "Vincent05R/FinCast",
        points: [
          expect.objectContaining({
            horizonMinutes: 5,
            targetTimestamp: "2026-07-24T17:07:00.000Z",
            medianPrice: 252,
          }),
          expect.objectContaining({ horizonMinutes: 15, medianPrice: 253 }),
        ],
      }),
      expect.objectContaining({
        lane: "kronos_base",
        signalSymbol: "TSLA",
        modelId: "NeoQuasar/Kronos-base",
        points: [
          expect.objectContaining({
            horizonMinutes: 5,
            targetTimestamp: "2026-07-24T17:07:00.000Z",
            medianPrice: 250,
          }),
          expect.objectContaining({ horizonMinutes: 15, medianPrice: 251 }),
        ],
      }),
    ]);
  });

  it("rejects a direct forecast whose known model identity contradicts its lane", () => {
    expect(normalizeAiSimulationModelForecasts([{
      ...directForecast("fincast"),
      modelId: "NeoQuasar/Kronos-base",
    }])).toEqual([]);
    expect(normalizeAiSimulationModelForecasts([{
      ...directForecast("kronos_base"),
      modelId: "Vincent05R/FinCast",
    }])).toEqual([]);
  });

  it("merges direct lane forecasts with legacy decision-derived Kronos output", () => {
    const snapshot = normalizeAiSimulationSnapshot({
      phase: "running",
      market: { kind: "stock", country: "US" },
      currency: "USD",
      initialCash: 10_000,
      cash: 10_000,
      equity: 10_000,
      progress: 0.5,
      modelForecasts: [directForecast("fincast")],
      decisions: [decision()],
      charts: [],
      trades: [],
      selected: [],
      positions: [],
      warnings: [],
      capabilities: { realOrder: false },
    });

    expect(snapshot.modelForecasts).toEqual([
      expect.objectContaining({
        lane: "fincast",
        signalSymbol: "TSLA",
        modelId: "Vincent05R/FinCast",
      }),
      expect.objectContaining({
        lane: "kronos_base",
        signalSymbol: "TSLA",
        modelId: "NeoQuasar/Kronos-base",
      }),
    ]);
    expect(snapshot.kronosForecasts).toEqual([
      expect.objectContaining({
        signalSymbol: "TSLA",
        modelId: "NeoQuasar/Kronos-base",
        status: "available",
      }),
    ]);
    expect(snapshot.kronosForecasts[0]).not.toHaveProperty("lane");
  });
});
