import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AiSimulationKronosForecastSection } from "./ai-simulation-kronos-forecast-chart";
import type { AiSimulationKronosForecast } from "@/lib/ai-simulation-forecast";

const forecast: AiSimulationKronosForecast = {
  signalSymbol: "TSLA",
  status: "available",
  origin: "2026-07-24T17:02:00.000Z",
  generatedAt: "2026-07-24T17:02:00.300Z",
  modelId: "NeoQuasar/Kronos-base",
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

describe("AiSimulationKronosForecastSection", () => {
  it("separates an exact finalized actual mark from raw Kronos quantile targets", () => {
    const markup = renderToStaticMarkup(
      <AiSimulationKronosForecastSection
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

    expect(markup).toContain('data-ai-simulation-kronos-forecast-section="true"');
    expect(markup).toContain('data-ai-simulation-kronos-forecast="TSLA"');
    expect(markup).toContain('data-ai-simulation-kronos-forecast-chart="true"');
    expect(markup).toContain('data-ai-simulation-kronos-origin-mark="exact-final"');
    expect(markup).toContain('data-ai-simulation-kronos-horizon="5"');
    expect(markup).toContain("실제 확정 종가");
    expect(markup).toContain("Kronos Q10–Q90 예측");
    expect(markup).toContain("Q10");
    expect(markup).toContain("중앙");
    expect(markup).toContain("Q90");
    expect(markup).toContain("보간하거나 임의 가격을 생성하지 않습니다.");
  });

  it("shows explicit empty states for missing raw output and a missing exact origin mark", () => {
    const missingOutput = renderToStaticMarkup(
      <AiSimulationKronosForecastSection forecasts={[]} charts={[]} currency="USD" />,
    );
    expect(missingOutput).toContain('data-ai-simulation-kronos-forecast-empty="true"');
    expect(missingOutput).toContain("첫 모델 판단이 완료되면 표시됩니다.");

    const missingMark = renderToStaticMarkup(
      <AiSimulationKronosForecastSection
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
    expect(missingMark).toContain('data-ai-simulation-kronos-origin-mark="unavailable"');
    expect(missingMark).toContain("이전 가격으로");
  });
});
