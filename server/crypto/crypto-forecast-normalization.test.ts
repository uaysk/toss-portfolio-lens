import { describe, expect, it } from "vitest";
import type { AiForecastRequest } from "../worker/ai-contract.js";
import {
  CHRONOS2_CONTEXT_BARS,
  DEFAULT_CONTEXT_BARS,
  canonicalCryptoModelInputDigest,
  normalizeLaneForecast,
} from "./crypto-forecast-normalization.js";

describe("crypto forecast normalization boundary", () => {
  it("keeps the worker-compatible input digest deterministic", () => {
    expect(canonicalCryptoModelInputDigest([
      {
        timestamp: "2026-07-25T00:00:59.999Z",
        open: 100,
        high: 100.5,
        low: 99.25,
        close: 100.125,
        volume: 12.5,
        amount: 1_251.5625,
        complete: true,
      },
      {
        timestamp: "2026-07-25T00:01:59.999Z",
        open: 0.1,
        high: 0.3,
        low: 0.05,
        close: 0.2,
        volume: 0,
        amount: null,
        complete: true,
      },
    ])).toBe("8671be00a0ba96f14ca05146e4cbe0c929ec5cc3fd308b20d4e140b0b2036971");
  });

  it("owns the lane-specific causal context bounds", () => {
    expect(DEFAULT_CONTEXT_BARS).toBe(512);
    expect(CHRONOS2_CONTEXT_BARS).toBe(1_024);
  });

  it("rejects response wrappers at the normalization boundary", () => {
    const request = { request_id: "request-1" } as AiForecastRequest;
    expect(() => normalizeLaneForecast("chronos2", {
      response: {
        request_id: request.request_id,
        mode: "forecast",
      },
    }, request)).toThrow("model_request_id_mismatch");
  });
});
