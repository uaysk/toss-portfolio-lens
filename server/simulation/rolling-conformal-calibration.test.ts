import { describe, expect, it } from "vitest";
import {
  applyConformalScale,
  fitRollingConformalCalibration,
  type ConformalResidual,
} from "./rolling-conformal-calibration.js";

describe("rolling conformal calibration", () => {
  it("uses only residuals fully resolved before the decision origin", () => {
    const residuals: ConformalResidual[] = [
      {
        modelLane: "chronos2",
        symbol: "BTCUSDT",
        horizonMinutes: 30,
        originAt: "2026-07-27T23:00:00.000Z",
        resolvedAt: "2026-07-27T23:30:00.000Z",
        predictedQ10: -0.01,
        predictedQ90: 0.01,
        actualReturn: 0.03,
      },
      {
        modelLane: "chronos2",
        symbol: "BTCUSDT",
        horizonMinutes: 30,
        originAt: "2026-07-28T00:00:00.000Z",
        resolvedAt: "2026-07-28T00:30:00.000Z",
        predictedQ10: -0.01,
        predictedQ90: 0.01,
        actualReturn: 0.5,
      },
    ];
    const result = fitRollingConformalCalibration(residuals, {
      modelLane: "chronos2",
      symbol: "BTCUSDT",
      horizonMinutes: 30,
      originAt: "2026-07-28T00:00:00.000Z",
    }, {
      minimumSamples: 1,
      maximumSamples: 10,
    });
    expect(result.status).toBe("ready");
    expect(result.sampleCount).toBe(1);
    expect(result.usedResidualOrigins).toEqual(["2026-07-27T23:00:00.000Z"]);
    expect(applyConformalScale(
      { 0.1: -0.01, 0.5: 0, 0.9: 0.01 },
      result,
    )).toEqual({ 0.1: -0.03, 0.5: 0, 0.9: 0.03 });
  });
});
