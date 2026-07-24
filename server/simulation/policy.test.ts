import { describe, expect, it } from "vitest";
import {
  AI_PAPER_POLICY_VERSION,
  createPaperLedger,
  decidePaperActions,
  fillPaperAction,
  resolvePaperPolicyProfile,
  selectAiForecastSeries,
  type AiPaperSelection,
  type PaperPolicyAction,
  type ResolvedPaperPolicyProfile,
} from "./policy.js";
import type { SimulationPreset } from "./contracts.js";

const generatedAt = "2026-07-24T00:05:02.000Z";
const inputEndAt = "2026-07-24T00:05:00.000Z";
const presets: readonly SimulationPreset[] = [
  "trend",
  "breakout",
  "mean_reversion",
  "risk_management",
];

function model(loaded = true) {
  return {
    model_id: "amazon/chronos-bolt-small",
    model_revision: "revision-a",
    tokenizer_id: null,
    tokenizer_revision: null,
    source_revision: "chronos-forecasting-2.1.0",
    loader_version: "chronos-forecasting-2.1.0",
    license: "Apache-2.0",
    device: loaded ? "cuda" : "unavailable",
    dtype: "float32",
    attention_backend: loaded ? "math" : "unavailable",
    loaded,
  };
}

function series(
  symbol: string,
  median: number,
  upProbability = 0.7,
  q10 = median - 0.01,
  q90 = median + 0.01,
) {
  return {
    instrument_key: symbol,
    status: "available",
    input_end_at: inputEndAt,
    horizons: [
      {
        horizon_minutes: 5,
        target_timestamp: "2026-07-24T00:10:00.000Z",
        return_quantiles: [
          { quantile: 0.05, value: q10 - 0.005 },
          { quantile: 0.1, value: q10 },
          { quantile: 0.25, value: (q10 + median) / 2 },
          { quantile: 0.5, value: median },
          { quantile: 0.75, value: (median + q90) / 2 },
          { quantile: 0.9, value: q90 },
          { quantile: 0.95, value: q90 + 0.005 },
        ],
        up_probability: upProbability,
        actual_return: 99,
      },
      {
        horizon_minutes: 60,
        return_quantiles: [
          { quantile: 0.1, value: -10 },
          { quantile: 0.5, value: 100 },
          { quantile: 0.9, value: 200 },
        ],
        up_probability: 1,
      },
    ],
    actual_return: 999,
    execution_return: 999,
  };
}

function response(values: unknown[], loaded = true) {
  return {
    schema_version: "scalping-ai/v1",
    request_id: "forecast-1",
    mode: "forecast",
    status: loaded ? "available" : "unavailable",
    model: model(loaded),
    generated_at: generatedAt,
    series: values,
    retrospective_future_outcome: { winner: "MALICIOUS" },
  };
}

const aggressiveProfile = resolvePaperPolicyProfile("trend", 100);

function availableSelection(
  median = 0.02,
  upProbability = 0.7,
  profile: ResolvedPaperPolicyProfile = aggressiveProfile,
): AiPaperSelection {
  return selectAiForecastSeries(response([series("AAA", median, upProbability)]), {
    symbolCount: 1,
    roundTripCostRate: 0.001,
    riskPenalty: profile.riskPenalty,
  });
}

function decide(
  profile: ResolvedPaperPolicyProfile,
  options: {
    median?: number;
    upProbability?: number;
    held?: boolean;
    technical?: unknown;
  } = {},
) {
  return decidePaperActions({
    selection: availableSelection(
      options.median ?? 0.02,
      options.upProbability ?? 0.7,
      profile,
    ),
    profile,
    heldSymbols: options.held ? ["AAA"] : [],
    technicalStates: {
      AAA: options.technical ?? {
        status: "entry_candidate",
        chartPatternBias: "bullish",
        chartPatterns: ["bullish_engulfing"],
      },
    },
  })[0]!;
}

function action(kind: PaperPolicyAction["action"]): PaperPolicyAction {
  const base = decide(aggressiveProfile, {
    held: kind === "sell" || kind === "hold",
    technical: kind === "sell"
      ? { status: "exit_candidate", chartPatternBias: "bearish" }
      : { status: "watch", chartPatternBias: "neutral" },
  });
  return { ...base, action: kind };
}

const costs = {
  commissionBpsPerSide: 10,
  exitTaxBps: 20,
  spreadBpsRoundTrip: 20,
  slippageBpsPerSide: 10,
};

const noCosts = {
  commissionBpsPerSide: 0,
  exitTaxBps: 0,
  spreadBpsRoundTrip: 0,
  slippageBpsPerSide: 0,
};

describe("resolved paper policy profiles", () => {
  it("resolves every preserved preset deterministically into bounded policy v2 values", () => {
    for (const preset of presets) {
      const profile = resolvePaperPolicyProfile(preset, 50);
      expect(profile).toEqual(resolvePaperPolicyProfile(preset, 50));
      expect(profile).toMatchObject({
        policyVersion: AI_PAPER_POLICY_VERSION,
        preset,
        riskTolerance: 50,
      });
      expect(profile.entryUpProbability).toBeGreaterThan(profile.exitUpProbability);
      expect(profile.riskPenalty).toBeGreaterThanOrEqual(0);
      expect(profile.targetAllocationRate).toBeGreaterThan(0);
      expect(profile.targetAllocationRate).toBeLessThanOrEqual(1);
      expect(profile.targetAllocationRate + profile.cashReserveRate).toBeCloseTo(1);
    }
  });

  it("moves thresholds, uncertainty penalty, confirmations, allocation, and reserve by risk", () => {
    const defensive = resolvePaperPolicyProfile("risk_management", 0);
    const aggressive = resolvePaperPolicyProfile("risk_management", 100);
    expect(defensive.entryUpProbability).toBeGreaterThan(aggressive.entryUpProbability);
    expect(defensive.exitUpProbability).toBeGreaterThan(aggressive.exitUpProbability);
    expect(defensive.riskPenalty).toBeGreaterThan(aggressive.riskPenalty);
    expect(defensive.technicalConfirmation).toBe("entry_candidate");
    expect(defensive.patternConfirmation).toBe("bullish");
    expect(aggressive.technicalConfirmation).toBe("non_exit");
    expect(aggressive.patternConfirmation).toBe("non_bearish");
    expect(defensive.targetAllocationRate).toBeLessThan(aggressive.targetAllocationRate);
    expect(defensive.cashReserveRate).toBeGreaterThan(aggressive.cashReserveRate);
  });

  it("rejects fractional and out-of-range risk tolerance", () => {
    expect(() => resolvePaperPolicyProfile("trend", -1)).toThrow(RangeError);
    expect(() => resolvePaperPolicyProfile("trend", 50.5)).toThrow(RangeError);
    expect(() => resolvePaperPolicyProfile("trend", 101)).toThrow(RangeError);
  });
});

describe("AI paper policy selection", () => {
  it("uses the supplied uncertainty penalty to select exactly one or two 5-minute forecasts", () => {
    const input = response([
      series("AAA", 0.03, 0.7, 0.01, 0.05),
      series("BBB", 0.025, 0.7, 0.02, 0.03),
      series("CCC", 0.01),
    ]);
    const config = {
      symbolCount: 1 as const,
      roundTripCostRate: 0.001,
      riskPenalty: 0.25,
    };
    const one = selectAiForecastSeries(input, config);
    const two = selectAiForecastSeries(input, { ...config, symbolCount: 2 });
    expect(one.selected.map(({ symbol }) => symbol)).toEqual(["BBB"]);
    expect(two.selected.map(({ symbol }) => symbol)).toEqual(["BBB", "AAA"]);
    expect(one.selected[0]).toMatchObject({
      inputEndAt,
      generatedAt,
      targetTimestamp: "2026-07-24T00:10:00.000Z",
      horizonMinutes: 5,
      medianReturn: 0.025,
      q10Return: 0.02,
      q90Return: 0.03,
      upProbability: 0.7,
      riskPenalty: 0.25,
      model: {
        modelId: "amazon/chronos-bolt-small",
        modelRevision: "revision-a",
        device: "cuda",
      },
    });
    expect(one.selected[0]?.score).toBeCloseTo(0.0215);
    expect(one.policyVersion).toBe(AI_PAPER_POLICY_VERSION);
  });

  it("makes defensive uncertainty reduce score more than aggressive uncertainty", () => {
    const defensive = resolvePaperPolicyProfile("trend", 0);
    const aggressive = resolvePaperPolicyProfile("trend", 100);
    const uncertain = response([series("AAA", 0.03, 0.8, -0.02, 0.08)]);
    const baseConfig = { symbolCount: 1 as const, roundTripCostRate: 0 };
    const defensiveSelection = selectAiForecastSeries(uncertain, {
      ...baseConfig,
      riskPenalty: defensive.riskPenalty,
    });
    const aggressiveSelection = selectAiForecastSeries(uncertain, {
      ...baseConfig,
      riskPenalty: aggressive.riskPenalty,
    });
    expect(defensiveSelection.selected[0]!.score)
      .toBeLessThan(aggressiveSelection.selected[0]!.score);
  });

  it("breaks score ties by raw symbol order rather than response order", () => {
    const config = {
      symbolCount: 2 as const,
      roundTripCostRate: 0.001,
      riskPenalty: 0.25,
    };
    const first = selectAiForecastSeries(response([
      series("CCC", 0.02), series("AAA", 0.02), series("BBB", 0.02),
    ]), config);
    const second = selectAiForecastSeries(response([
      series("BBB", 0.02), series("CCC", 0.02), series("AAA", 0.02),
    ]), config);
    expect(first.selected.map(({ symbol }) => symbol)).toEqual(["AAA", "BBB"]);
    expect(second.selected.map(({ symbol }) => symbol)).toEqual(["AAA", "BBB"]);
  });

  it("omits unavailable or invalid forecasts and never invents a missing candidate", () => {
    const unavailable = {
      ...series("BAD", 0.5),
      status: "unavailable",
      horizons: [],
      unavailable: { code: "MODEL_UNAVAILABLE", message: "missing" },
    };
    const selected = selectAiForecastSeries(response([
      unavailable,
      series("NAN", Number.NaN),
      series("ONLY", 0.02),
    ]), { symbolCount: 2, roundTripCostRate: 0.001, riskPenalty: 0.25 });
    expect(selected).toMatchObject({
      status: "unavailable",
      reason: "insufficient_available_forecasts",
      availableCandidateCount: 1,
      selected: [],
    });
    expect(selectAiForecastSeries(response([series("AAA", 0.02)], false), {
      symbolCount: 1,
      roundTripCostRate: 0,
      riskPenalty: 0.25,
    })).toMatchObject({ status: "unavailable", reason: "model_unavailable", selected: [] });
    expect(selectAiForecastSeries({ forged: true }, {
      symbolCount: 1,
      roundTripCostRate: 0,
      riskPenalty: 0.25,
    })).toMatchObject({ status: "unavailable", reason: "invalid_forecast_response", selected: [] });
  });

  it("ignores future outcome fields and horizons other than five minutes", () => {
    const clean = response([series("AAA", 0.02)]);
    const forged = structuredClone(clean);
    const item = forged.series[0] as ReturnType<typeof series>;
    item.actual_return = -999;
    item.execution_return = 999;
    item.horizons[0]!.actual_return = -1_000_000;
    item.horizons[1]!.up_probability = 0;
    const config = {
      symbolCount: 1 as const,
      roundTripCostRate: 0.001,
      riskPenalty: 0.25,
    };
    expect(selectAiForecastSeries(forged, config)).toEqual(selectAiForecastSeries(clean, config));
  });

  it("rejects stale horizons and invalid scoring configuration", () => {
    const expiredAtGeneration = response([series("AAA", 0.02)]);
    expiredAtGeneration.generated_at = "2026-07-24T00:10:00.000Z";
    expect(selectAiForecastSeries(expiredAtGeneration, {
      symbolCount: 1,
      roundTripCostRate: 0.001,
      riskPenalty: 0.25,
    })).toMatchObject({
      status: "unavailable",
      reason: "stale_forecast_horizon",
      selected: [],
    });
    expect(selectAiForecastSeries(response([series("AAA", 0.02)]), {
      symbolCount: 1,
      roundTripCostRate: 0.001,
      riskPenalty: 0.25,
      notBeforeMs: Date.parse("2026-07-24T00:10:00.000Z"),
    })).toMatchObject({
      status: "unavailable",
      reason: "stale_forecast_horizon",
      selected: [],
    });
    expect(() => selectAiForecastSeries(response([series("AAA", 0.02)]), {
      symbolCount: 1,
      roundTripCostRate: 0,
      riskPenalty: -0.01,
    })).toThrow(RangeError);
    expect(() => selectAiForecastSeries(response([series("AAA", 0.02)]), {
      symbolCount: 1,
      roundTripCostRate: 0,
      riskPenalty: 1.01,
    })).toThrow(RangeError);
  });
});

describe("AI paper policy actions", () => {
  it("allows every preset to enter from an empty ledger when its confirmations pass", () => {
    for (const preset of presets) {
      const profile = resolvePaperPolicyProfile(preset, 50);
      expect(decide(profile, {
        median: 0.05,
        upProbability: 0.9,
        technical: {
          status: "entry_candidate",
          chartPatternBias: "bullish",
          chartPatterns: ["breakout", "breakout"],
        },
      })).toMatchObject({
        action: "buy",
        chartPatternBias: "bullish",
        chartPatterns: ["breakout"],
      });
    }
  });

  it("applies defensive versus aggressive thresholds and technical confirmation", () => {
    const defensive = resolvePaperPolicyProfile("risk_management", 0);
    const aggressive = resolvePaperPolicyProfile("risk_management", 100);
    expect(decide(defensive, {
      median: 0.05,
      upProbability: 0.6,
      technical: { status: "watch", chartPatternBias: "bullish" },
    })).toMatchObject({
      action: "watch",
      reasons: expect.arrayContaining([
        "entry_probability_threshold_not_met",
        "technical_entry_confirmation_required",
      ]),
    });
    expect(decide(aggressive, {
      median: 0.05,
      upProbability: 0.6,
      technical: { status: "watch", chartPatternBias: "neutral" },
    })).toMatchObject({ action: "buy" });
  });

  it("requires bullish patterns defensively, gates bearish entries, and exits bearish holdings", () => {
    const defensive = resolvePaperPolicyProfile("risk_management", 0);
    const aggressive = resolvePaperPolicyProfile("risk_management", 100);
    expect(decide(defensive, {
      median: 0.05,
      upProbability: 0.9,
      technical: { status: "entry_candidate", chartPatternBias: "neutral" },
    })).toMatchObject({
      action: "watch",
      reasons: expect.arrayContaining(["bullish_chart_pattern_required"]),
    });
    expect(decide(aggressive, {
      median: 0.05,
      upProbability: 0.9,
      technical: {
        status: "entry_candidate",
        chart_pattern_bias: "bearish",
        chart_patterns: ["double_top"],
      },
    })).toMatchObject({
      action: "watch",
      chartPatternBias: "bearish",
      chartPatterns: ["double_top"],
      reasons: expect.arrayContaining(["bearish_chart_pattern"]),
    });
    expect(decide(aggressive, {
      median: 0.05,
      upProbability: 0.9,
      held: true,
      technical: {
        status: "hold",
        chartPatternBias: "bearish",
        chartPatterns: ["head_and_shoulders"],
      },
    })).toMatchObject({
      action: "sell",
      chartPatternBias: "bearish",
      chartPatterns: ["head_and_shoulders"],
      reasons: ["bearish_chart_pattern"],
    });
  });

  it("keeps long-only entry and exit thresholds separate", () => {
    const profile = resolvePaperPolicyProfile("trend", 100);
    expect(decide(profile, {
      median: -0.01,
      upProbability: 0.8,
      technical: { status: "watch", chartPatternBias: "neutral" },
    })).toMatchObject({
      action: "watch",
      reasons: expect.arrayContaining(["entry_score_threshold_not_met"]),
    });
    expect(decide(profile, {
      upProbability: 0.35,
      held: true,
      technical: { status: "hold", chartPatternBias: "neutral" },
    })).toMatchObject({ action: "sell", reasons: ["low_up_probability"] });
    expect(decide(profile, {
      upProbability: 0.8,
      held: true,
      technical: { status: "exit_candidate", chartPatternBias: "neutral" },
    })).toMatchObject({ action: "sell", reasons: ["technical_exit_candidate"] });
    expect(decide(profile, {
      upProbability: 0.8,
      held: true,
      technical: { status: "hold", chartPatternBias: "neutral" },
    })).toMatchObject({ action: "hold" });
  });

  it("waits until both the forecast and generic technical observation are causal", () => {
    const technicalObservedAt = "2026-07-24T00:05:07.000Z";
    expect(decidePaperActions({
      selection: availableSelection(0.02, 0.7, aggressiveProfile),
      profile: aggressiveProfile,
      technicalStates: {
        AAA: {
          technicalState: "entry_candidate",
          observed_at: technicalObservedAt,
          chartPatternBias: "neutral",
        },
      },
    })[0]).toMatchObject({
      action: "buy",
      eligibleAfter: technicalObservedAt,
      technicalObservedAt,
      technicalState: "entry_candidate",
    });
  });
});

describe("whole-share paper ledger", () => {
  it("rejects same-time execution and applies only a later whole-share buy", () => {
    const ledger = createPaperLedger(1_000);
    const buy = action("buy");
    const sameTime = fillPaperAction(ledger, buy, {
      timestamp: buy.eligibleAfter,
      price: 100,
    }, { symbolCount: 1, targetAllocationRate: 1, costs });
    expect(sameTime).toMatchObject({
      status: "rejected",
      reason: "execution_not_after_eligible",
      ledger: { cash: 1_000, positions: {} },
    });
    const filled = fillPaperAction(ledger, buy, {
      timestamp: "2026-07-24T00:06:00.000Z",
      price: 100,
    }, { symbolCount: 1, targetAllocationRate: 1, costs });
    expect(filled.status).toBe("filled");
    expect(filled.trade).toMatchObject({
      side: "buy",
      quantity: 9,
      grossAmount: 900,
      commission: 0.9,
      spreadCost: 0.9,
      slippageCost: 0.9,
      exitTax: 0,
    });
    expect(filled.ledger.cash).toBeCloseTo(97.3);
    expect(filled.ledger.cash).toBeGreaterThanOrEqual(0);
    expect(filled.ledger.positions.AAA?.quantity).toBe(9);
    expect(ledger).toEqual(createPaperLedger(1_000));
  });

  it("sells the full position and deducts commission, exit tax, spread, and slippage", () => {
    const bought = fillPaperAction(createPaperLedger(1_000), action("buy"), {
      timestamp: "2026-07-24T00:06:00.000Z",
      price: 100,
    }, { symbolCount: 1, targetAllocationRate: 1, costs });
    const sell = action("sell");
    const sold = fillPaperAction(bought.ledger, sell, {
      timestamp: "2026-07-24T00:07:00.000Z",
      price: 110,
    }, { symbolCount: 1, targetAllocationRate: 1, costs });
    expect(sold.trade).toMatchObject({
      side: "sell",
      quantity: 9,
      grossAmount: 990,
      commission: 0.99,
      exitTax: 1.98,
      spreadCost: 0.99,
      slippageCost: 0.99,
      positionQuantityAfter: 0,
    });
    expect(sold.ledger.positions).toEqual({});
    expect(sold.ledger.cash).toBeCloseTo(1_082.35);
    expect(sold.ledger.totalCosts).toBeCloseTo(7.65);
    expect(sold.ledger.realizedPnl).toBeCloseTo(82.35);
    expect(sold.ledger.cash).toBeGreaterThanOrEqual(0);
  });

  it("applies total target allocation across symbols without shorting or negative cash", () => {
    const first = fillPaperAction(createPaperLedger(1_000), action("buy"), {
      timestamp: "2026-07-24T00:06:00.000Z",
      price: 100,
    }, { symbolCount: 2, targetAllocationRate: 1, allocationEquity: 1_000, costs });
    expect(first.trade?.quantity).toBe(5);
    const secondAction = { ...action("buy"), symbol: "BBB" };
    const second = fillPaperAction(first.ledger, secondAction, {
      timestamp: "2026-07-24T00:06:01.000Z",
      price: 100,
    }, {
      symbolCount: 2,
      targetAllocationRate: 1,
      allocationEquity: 1_000,
      costs,
      markPrices: { AAA: 100 },
    });
    expect(second.trade?.quantity).toBe(4);
    expect(second.ledger.cash).toBeGreaterThanOrEqual(0);
    expect(second.ledger.positions.AAA?.quantity).toBe(5);
    expect(second.ledger.positions.BBB?.quantity).toBe(4);
    const noShort = fillPaperAction(createPaperLedger(1_000), action("sell"), {
      timestamp: "2026-07-24T00:07:00.000Z",
      price: 100,
    }, { symbolCount: 1, targetAllocationRate: 1, costs });
    expect(noShort).toMatchObject({
      status: "skipped",
      reason: "position_not_held",
      ledger: { cash: 1_000, positions: {} },
    });
  });

  it("turns the resolved defensive and aggressive allocation into whole-share targets", () => {
    const defensive = resolvePaperPolicyProfile("risk_management", 0);
    const aggressive = resolvePaperPolicyProfile("risk_management", 100);
    const execution = { timestamp: "2026-07-24T00:06:00.000Z", price: 100 };
    const defensiveFill = fillPaperAction(
      createPaperLedger(1_000),
      action("buy"),
      execution,
      {
        symbolCount: 1,
        targetAllocationRate: defensive.targetAllocationRate,
        costs: noCosts,
      },
    );
    const aggressiveFill = fillPaperAction(
      createPaperLedger(1_000),
      action("buy"),
      execution,
      {
        symbolCount: 1,
        targetAllocationRate: aggressive.targetAllocationRate,
        costs: noCosts,
      },
    );
    expect(defensiveFill.trade?.quantity).toBe(2);
    expect(aggressiveFill.trade?.quantity).toBe(8);
    expect(defensiveFill.ledger.cash).toBe(800);
    expect(aggressiveFill.ledger.cash).toBe(200);
  });

  it("rejects invalid target allocation rates", () => {
    const ledger = createPaperLedger(1_000);
    const buy = action("buy");
    const execution = { timestamp: "2026-07-24T00:06:00.000Z", price: 100 };
    expect(() => fillPaperAction(ledger, buy, execution, {
      symbolCount: 1,
      targetAllocationRate: 0,
      costs: noCosts,
    })).toThrow(RangeError);
    expect(() => fillPaperAction(ledger, buy, execution, {
      symbolCount: 1,
      targetAllocationRate: 1.01,
      costs: noCosts,
    })).toThrow(RangeError);
  });
});
