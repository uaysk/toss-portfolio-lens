import { describe, expect, expectTypeOf, it } from "vitest";
import type { ScalpingService } from "./scalping-service.js";
import {
  ScalpingAnalysisResultSchema,
  createScalpingEvaluationRequestSchema,
  createScalpingForecastRequestSchema,
  createScalpingRealtimeAnalysisRequestSchema,
  createScalpingWorkspaceRequestSchema,
  type ScalpingForecastResult,
  type ScalpingRealtimeAnalysisResult,
  type ScalpingWorkspaceResult,
} from "./api-contracts.js";

describe("scalping API request contracts", () => {
  it("normalizes symbols and applies public defaults once at the workspace boundary", () => {
    const parsed = createScalpingWorkspaceRequestSchema({
      minimumTopCount: 1,
      maximumTopCount: 10,
    }).parse({
      criterion: "volume",
      topCount: 2,
      interval: "1m",
      layoutColumns: 2,
      preset: "trend",
      symbols: [" 005930 ", "aapl"],
    });

    expect(parsed.marketCountry).toBe("KR");
    expect(parsed.symbols).toEqual(["005930", "AAPL"]);
  });

  it("rejects duplicate or excess workspace symbols after normalization", () => {
    const schema = createScalpingWorkspaceRequestSchema({
      minimumTopCount: 1,
      maximumTopCount: 10,
    });
    expect(schema.safeParse({
      criterion: "volume",
      topCount: 2,
      interval: "1m",
      layoutColumns: 2,
      preset: "trend",
      symbols: ["aapl", " AAPL "],
    }).success).toBe(false);
    expect(schema.safeParse({
      criterion: "volume",
      topCount: 1,
      interval: "1m",
      layoutColumns: 2,
      preset: "trend",
      symbols: ["005930", "000660"],
    }).success).toBe(false);
  });

  it("uses one normalized symbol-list contract for forecast and evaluation", () => {
    const forecast = createScalpingForecastRequestSchema(3).parse({
      symbols: [" aapl "],
      interval: "5m",
    });
    const evaluation = createScalpingEvaluationRequestSchema(3).parse({
      symbols: [" msft "],
      interval: "1m",
      evaluation: {
        walkForward: true,
        retrospective: true,
        commissionBpsPerSide: 1,
        taxBpsOnExit: 0,
        spreadBpsRoundTrip: 2,
        slippageBpsPerSide: 1,
      },
    });

    expect(forecast).toMatchObject({ marketCountry: "KR", symbols: ["AAPL"] });
    expect(evaluation).toMatchObject({
      marketCountry: "KR",
      symbols: ["MSFT"],
      preset: "risk_management",
    });
  });

  it("validates isolated positions against the normalized request symbols", () => {
    const schema = createScalpingRealtimeAnalysisRequestSchema(3);
    expect(schema.parse({
      symbols: [" aapl "],
      interval: "1m",
      preset: "risk_management",
      positionContext: {
        mode: "isolated",
        positions: [{
          symbol: "AAPL",
          quantity: 1,
          averagePrice: 100,
          asOf: "2026-07-24T09:00:00+09:00",
        }],
      },
    }).positionContext?.positions[0]?.symbol).toBe("AAPL");
    expect(schema.safeParse({
      symbols: ["AAPL"],
      interval: "1m",
      preset: "risk_management",
      positionContext: {
        mode: "isolated",
        positions: [{
          symbol: "MSFT",
          quantity: 1,
          averagePrice: 100,
          asOf: "2026-07-24T09:00:00+09:00",
        }],
      },
    }).success).toBe(false);
  });
});

describe("scalping result contracts", () => {
  it("validates the Rust analysis boundary and preserves typed signal fields", () => {
    const parsed = ScalpingAnalysisResultSchema.parse({
      schema_version: "scalping-analysis-result/v3",
      response_mode: "latest_summary",
      interval_minutes: 1,
      instruments: [{
        instrument_key: "005930",
        signals: {
          latest: {
            status: "entry_candidate",
            calculation_timestamp: "2026-07-24T09:01:00+09:00",
            signal_timestamp: "2026-07-24T09:01:00+09:00",
          },
        },
      }],
      diagnostics: {},
    });

    expect(parsed.instruments[0]?.signals?.latest?.status).toBe("entry_candidate");
    expect(ScalpingAnalysisResultSchema.safeParse({
      schema_version: "scalping-analysis-result/v2",
      instruments: [],
    }).success).toBe(false);
    expect(ScalpingAnalysisResultSchema.safeParse({
      instruments: [],
    }).success).toBe(false);
  });

  it("keeps service result methods tied to their explicit contracts", () => {
    expectTypeOf<Awaited<ReturnType<ScalpingService["workspace"]>>>()
      .toEqualTypeOf<ScalpingWorkspaceResult>();
    expectTypeOf<Awaited<ReturnType<ScalpingService["forecast"]>>>()
      .toEqualTypeOf<ScalpingForecastResult>();
    expectTypeOf<Awaited<ReturnType<ScalpingService["realtimeAnalysis"]>>>()
      .toEqualTypeOf<ScalpingRealtimeAnalysisResult>();
  });
});
