import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AiSimulationModelForecastSection } from "./ai-simulation-model-forecast-chart";
import type { AiSimulationModelForecast } from "@/lib/ai-simulation-forecast";

const forecast: AiSimulationModelForecast = {
  lane: "chronos2",
  signalSymbol: "TSLA",
  status: "available",
  projectionPolicy: "native_input_origin",
  origin: "2026-07-24T17:02:00.000Z",
  generatedAt: "2026-07-24T17:02:00.300Z",
  modelId: "amazon/chronos-2",
  modelRevision: "pinned",
  points: [{
    horizonMinutes: 5,
    targetTimestamp: "2026-07-24T17:07:00.000Z",
    q10Price: 248,
    medianPrice: 250,
    q90Price: 252,
    upProbability: 0.64,
  }, {
    horizonMinutes: 15,
    targetTimestamp: "2026-07-24T17:17:00.000Z",
    q10Price: 247,
    medianPrice: 251,
    q90Price: 255,
    upProbability: 0.66,
  }],
};

describe("AiSimulationModelForecastSection", () => {
  it("separates an exact finalized actual mark from model quantile targets", () => {
    const markup = renderToStaticMarkup(
      <AiSimulationModelForecastSection
        forecasts={[forecast]}
        charts={[{
          symbol: "TSLA",
          currency: "USD",
          bars: [{
            timestamp: forecast.origin!,
            open: 249,
            high: 251,
            low: 248,
            close: 250,
            status: "final",
            indicatorValues: {},
          }],
          indicators: [],
          patterns: [],
        }]}
        currency="USD"
      />,
    );

    expect(markup).toContain('data-ai-simulation-model-forecast-section="true"');
    expect(markup).toContain('data-ai-simulation-model-forecast="TSLA"');
    expect(markup).toContain('data-ai-simulation-model-forecast-chart="true"');
    expect(markup).toContain('data-ai-simulation-model-origin-mark="exact-final"');
    expect(markup).toContain('data-ai-simulation-model-horizon="5"');
    expect(markup).toContain("실제 확정 종가");
    expect(markup).toContain("모델 Q10–Q90 예측");
    expect(markup).toContain("보간하거나 임의 가격을 생성하지 않습니다.");
  });

  it("shows explicit empty states for missing output and exact origin marks", () => {
    const missingOutput = renderToStaticMarkup(
      <AiSimulationModelForecastSection forecasts={[]} charts={[]} currency="USD" />,
    );
    expect(missingOutput).toContain('data-ai-simulation-model-forecast-empty="true"');

    const missingMark = renderToStaticMarkup(
      <AiSimulationModelForecastSection
        forecasts={[forecast]}
        charts={[{
          symbol: "TSLA",
          currency: "USD",
          bars: [{
            timestamp: forecast.origin!,
            open: 249,
            high: 251,
            low: 248,
            close: 250,
            status: "forming",
            indicatorValues: {},
          }],
          indicators: [],
          patterns: [],
        }]}
        currency="USD"
      />,
    );
    expect(missingMark).toContain('data-ai-simulation-model-origin-mark="unavailable"');
    expect(missingMark).toContain("이전 가격으로");
  });
});
