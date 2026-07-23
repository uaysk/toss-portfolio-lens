import { describe, expect, it } from "vitest";
import {
  AI_PAPER_POLICY_VERSION,
  createPaperLedger,
  decidePaperActions,
  fillPaperAction,
  selectAiForecastSeries,
  type AiPaperSelection,
  type PaperPolicyAction,
} from "./policy.js";

const generatedAt = "2026-07-24T00:05:02.000Z";
const inputEndAt = "2026-07-24T00:05:00.000Z";

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

function availableSelection(
  median = 0.02,
  upProbability = 0.7,
): AiPaperSelection {
  return selectAiForecastSeries(response([series("AAA", median, upProbability)]), {
    symbolCount: 1,
    roundTripCostRate: 0.001,
  });
}

function action(kind: PaperPolicyAction["action"]): PaperPolicyAction {
  const selected = availableSelection();
  const base = decidePaperActions({
    selection: selected,
    heldSymbols: kind === "sell" || kind === "hold" ? ["AAA"] : [],
    technicalStates: {
      AAA: kind === "sell" ? "exit_candidate" : "watch",
    },
  })[0]!;
  return { ...base, action: kind };
}

const costs = {
  commissionBpsPerSide: 10,
  exitTaxBps: 20,
  spreadBpsRoundTrip: 20,
  slippageBpsPerSide: 10,
};

describe("AI paper policy selection", () => {
  it("고정 5분 score로 정확히 1개 또는 2개를 선택하고 provenance를 보존한다", () => {
    const input = response([
      series("AAA", 0.03, 0.7, 0.01, 0.05),
      series("BBB", 0.025, 0.7, 0.02, 0.03),
      series("CCC", 0.01),
    ]);
    const one = selectAiForecastSeries(input, { symbolCount: 1, roundTripCostRate: 0.001 });
    const two = selectAiForecastSeries(input, { symbolCount: 2, roundTripCostRate: 0.001 });
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
      model: {
        modelId: "amazon/chronos-bolt-small",
        modelRevision: "revision-a",
        device: "cuda",
      },
    });
    expect(one.selected[0]?.score).toBeCloseTo(0.0215);
    expect(one.policyVersion).toBe(AI_PAPER_POLICY_VERSION);
  });

  it("동점은 symbol raw order로 결정하며 응답 배열 순서에 의존하지 않는다", () => {
    const config = { symbolCount: 2 as const, roundTripCostRate: 0.001 };
    const first = selectAiForecastSeries(response([
      series("CCC", 0.02), series("AAA", 0.02), series("BBB", 0.02),
    ]), config);
    const second = selectAiForecastSeries(response([
      series("BBB", 0.02), series("CCC", 0.02), series("AAA", 0.02),
    ]), config);
    expect(first.selected.map(({ symbol }) => symbol)).toEqual(["AAA", "BBB"]);
    expect(second.selected.map(({ symbol }) => symbol)).toEqual(["AAA", "BBB"]);
  });

  it("unavailable·잘못된 예측은 생략하고 요청 개수를 채우지 못하면 값을 만들지 않는다", () => {
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
    ]), { symbolCount: 2, roundTripCostRate: 0.001 });
    expect(selected).toMatchObject({
      status: "unavailable",
      reason: "insufficient_available_forecasts",
      availableCandidateCount: 1,
      selected: [],
    });
    expect(selectAiForecastSeries(response([series("AAA", 0.02)], false), {
      symbolCount: 1,
      roundTripCostRate: 0,
    })).toMatchObject({ status: "unavailable", reason: "model_unavailable", selected: [] });
    expect(selectAiForecastSeries({ forged: true }, {
      symbolCount: 1,
      roundTripCostRate: 0,
    })).toMatchObject({ status: "unavailable", reason: "invalid_forecast_response", selected: [] });
  });

  it("미래 실현 필드와 다른 horizon을 정책 입력에서 무시한다", () => {
    const clean = response([series("AAA", 0.02)]);
    const forged = structuredClone(clean);
    const item = forged.series[0] as ReturnType<typeof series>;
    item.actual_return = -999;
    item.execution_return = 999;
    item.horizons[0]!.actual_return = -1_000_000;
    item.horizons[1]!.up_probability = 0;
    const config = { symbolCount: 1 as const, roundTripCostRate: 0.001 };
    expect(selectAiForecastSeries(forged, config)).toEqual(selectAiForecastSeries(clean, config));
  });

  it("5분 목표 시각이 생성·판단 시각을 지나면 오래된 예측을 거래 후보로 사용하지 않는다", () => {
    const expiredAtGeneration = response([series("AAA", 0.02)]);
    expiredAtGeneration.generated_at = "2026-07-24T00:10:00.000Z";
    expect(selectAiForecastSeries(expiredAtGeneration, {
      symbolCount: 1,
      roundTripCostRate: 0.001,
    })).toMatchObject({
      status: "unavailable",
      reason: "stale_forecast_horizon",
      selected: [],
    });

    expect(selectAiForecastSeries(response([series("AAA", 0.02)]), {
      symbolCount: 1,
      roundTripCostRate: 0.001,
      notBeforeMs: Date.parse("2026-07-24T00:10:00.000Z"),
    })).toMatchObject({
      status: "unavailable",
      reason: "stale_forecast_horizon",
      selected: [],
    });
  });
});

describe("AI paper policy actions", () => {
  it("진입·청산 threshold와 technical exit를 long-only 상태로 적용한다", () => {
    expect(decidePaperActions({
      selection: availableSelection(0.02, 0.55),
      technicalStates: { AAA: "watch" },
    })[0]).toMatchObject({ action: "buy", eligibleAfter: generatedAt });
    expect(decidePaperActions({
      selection: availableSelection(0.004, 0.54),
      technicalStates: { AAA: "entry_candidate" },
    })[0]).toMatchObject({ action: "watch" });
    expect(decidePaperActions({
      selection: availableSelection(0.02, 0.8),
      technicalStates: { AAA: "exit_candidate" },
    })[0]).toMatchObject({ action: "watch", reasons: ["technical_exit_candidate"] });
    expect(decidePaperActions({
      selection: availableSelection(0.02, 0.45),
      heldSymbols: ["AAA"],
      technicalStates: { AAA: "hold" },
    })[0]).toMatchObject({ action: "sell", reasons: ["low_up_probability"] });
    expect(decidePaperActions({
      selection: availableSelection(0.02, 0.8),
      heldSymbols: ["AAA"],
      technicalStates: { AAA: "exit_candidate" },
    })[0]).toMatchObject({ action: "sell", reasons: ["technical_exit_candidate"] });
    expect(decidePaperActions({
      selection: availableSelection(0.02, 0.8),
      heldSymbols: ["AAA"],
      technicalStates: { AAA: "hold" },
    })[0]).toMatchObject({ action: "hold" });
  });

  it("Rust 기술 분석 관측 시각까지 지난 뒤에만 체결 가능하게 한다", () => {
    const technicalObservedAt = "2026-07-24T00:05:07.000Z";
    expect(decidePaperActions({
      selection: availableSelection(0.02, 0.7),
      technicalStates: {
        AAA: { status: "entry_candidate", observedAt: technicalObservedAt },
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
  it("같은 시각 체결을 거부하고 다음 시각의 whole-share 매수만 적용한다", () => {
    const ledger = createPaperLedger(1_000);
    const buy = action("buy");
    const sameTime = fillPaperAction(ledger, buy, {
      timestamp: buy.eligibleAfter,
      price: 100,
    }, { symbolCount: 1, costs });
    expect(sameTime).toMatchObject({
      status: "rejected",
      reason: "execution_not_after_eligible",
      ledger: { cash: 1_000, positions: {} },
    });
    const filled = fillPaperAction(ledger, buy, {
      timestamp: "2026-07-24T00:06:00.000Z",
      price: 100,
    }, { symbolCount: 1, costs });
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

  it("매도는 전량 처리하고 commission·exit tax·half spread·slippage를 차감한다", () => {
    const bought = fillPaperAction(createPaperLedger(1_000), action("buy"), {
      timestamp: "2026-07-24T00:06:00.000Z",
      price: 100,
    }, { symbolCount: 1, costs });
    const sell = action("sell");
    const sold = fillPaperAction(bought.ledger, sell, {
      timestamp: "2026-07-24T00:07:00.000Z",
      price: 110,
    }, { symbolCount: 1, costs });
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

  it("균등 allocation과 cash 상한을 적용하고 short·음수 잔고를 만들지 않는다", () => {
    const first = fillPaperAction(createPaperLedger(1_000), action("buy"), {
      timestamp: "2026-07-24T00:06:00.000Z",
      price: 100,
    }, { symbolCount: 2, allocationEquity: 1_000, costs });
    expect(first.trade?.quantity).toBe(5);
    const secondAction = { ...action("buy"), symbol: "BBB" };
    const second = fillPaperAction(first.ledger, secondAction, {
      timestamp: "2026-07-24T00:06:01.000Z",
      price: 100,
    }, { symbolCount: 2, allocationEquity: 1_000, costs, markPrices: { AAA: 100 } });
    expect(second.trade?.quantity).toBe(4);
    expect(second.ledger.cash).toBeGreaterThanOrEqual(0);
    expect(second.ledger.positions.AAA?.quantity).toBe(5);
    expect(second.ledger.positions.BBB?.quantity).toBe(4);
    const noShort = fillPaperAction(createPaperLedger(1_000), action("sell"), {
      timestamp: "2026-07-24T00:07:00.000Z",
      price: 100,
    }, { symbolCount: 1, costs });
    expect(noShort).toMatchObject({
      status: "skipped",
      reason: "position_not_held",
      ledger: { cash: 1_000, positions: {} },
    });
  });
});
