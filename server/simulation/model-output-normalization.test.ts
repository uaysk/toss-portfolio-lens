import { describe, expect, it } from "vitest";
import {
  normalizePairModelOutputs,
  type PairModelNormalizationOptions,
} from "./model-output-normalization.js";

const ORIGIN = "2026-07-24T14:30:00.000Z";
const TARGET = "2026-07-24T14:35:00.000Z";
const GENERATED = "2026-07-24T14:30:02.000Z";
const MODEL_ID = "NeoQuasar/Kronos-base";

function run(overrides: Record<string, unknown> = {}) {
  return {
    role: "kronos_base",
    expected_model_id: MODEL_ID,
    fallback_used: false,
    degraded: false,
    generated_at: GENERATED,
    latency_ms: 185,
    input_origins: [{
      instrument_key: "TSLA",
      input_end_at: ORIGIN,
      context_start_at: "2026-07-24T12:30:00.000Z",
      bar_count: 121,
      input_digest: "a".repeat(64),
    }],
    model: {
      model_id: MODEL_ID,
      model_revision: "2b554741eca47781b64468546e77fef3e85130e6",
      tokenizer_id: "NeoQuasar/Kronos-Tokenizer-base",
      tokenizer_revision: "0e0117387f39004a9016484a186a908917e22426",
      source_revision: "kronos-pinned",
      loader_version: "kronos-loader-v1",
      license: "Apache-2.0",
      device: "cuda",
      device_name: "Tesla P40",
      cuda_capability: "6.1",
      dtype: "float32",
      attention_backend: "math",
      loaded: true,
    },
    raw_series: [{
      instrument_key: "TSLA",
      status: "available",
      input_end_at: ORIGIN,
      input_quality: { status: "good", warnings: [] },
      calibration: { status: "good", brier_score: 0.18 },
      horizons: [{
        horizon_minutes: 5,
        target_timestamp: TARGET,
        return_quantiles: [
          { quantile: 0.1, value: -0.01 },
          { quantile: 0.5, value: 0.01 },
          { quantile: 0.9, value: 0.03 },
        ],
        up_probability: 0.7,
        down_probability: 0.25,
        flat_probability: 0.05,
        expected_volatility: 0.02,
      }],
    }],
    ...overrides,
  };
}

function normalize(
  modelRun: unknown,
  options: Partial<PairModelNormalizationOptions> = {},
) {
  return normalizePairModelOutputs(
    { model_runs: [modelRun] },
    {
      signalSymbol: "TSLA",
      expectedOrigin: ORIGIN,
      now: "2026-07-24T14:30:10.000Z",
      requiredDeviceName: "Tesla P40",
      ...options,
    },
  );
}

describe("pair Kronos-base output normalization", () => {
  it("normalizes the pinned Kronos-base run and preserves exact-origin provenance", () => {
    const input = run();
    const output = normalize(input);

    expect(output).toMatchObject({
      alignmentStatus: "aligned",
      alignedOrigin: ORIGIN,
      kronos: {
        component: "kronos",
        status: "available",
        medianReturn: 0.01,
        q10Return: -0.01,
        q90Return: 0.03,
        uncertaintyWidth: 0.04,
        upProbability: 0.7,
        downProbability: 0.25,
        calibration: { status: "good", brierScore: 0.18 },
        provenance: {
          modelId: MODEL_ID,
          modelRevision: "2b554741eca47781b64468546e77fef3e85130e6",
          deviceName: "Tesla P40",
          latencyMs: 185,
          inputOriginAt: ORIGIN,
          inputDigest: "a".repeat(64),
        },
      },
    });
    expect(output.kronos.rawOutput).toEqual(input);
    expect(output).not.toHaveProperty("chronos2");
  });

  it("accepts a single top-level Kronos-base response without fabricating another model", () => {
    const modelRun = run();
    const output = normalizePairModelOutputs(modelRun, {
      signalSymbol: "TSLA",
      expectedOrigin: ORIGIN,
    });
    expect(output.kronos.status).toBe("available");
    expect(output).not.toHaveProperty("chronos2");
  });

  it("fails origin alignment when the base model does not use the captured finalized bar", () => {
    const shifted = run({
      raw_series: [{
        ...(run().raw_series[0] as object),
        input_end_at: "2026-07-24T14:29:00.000Z",
      }],
    });
    const output = normalize(shifted);
    expect(output.alignmentStatus).toBe("misaligned");
    expect(output.reasonCodes).toContain("model_origin_mismatch");
    expect(output.kronos.reasonCodes).toContain("origin_mismatch");
  });

  it("rejects Kronos-small and any fallback provenance instead of relabeling it base", () => {
    const small = run({
      expected_model_id: MODEL_ID,
      model: {
        ...(run().model as object),
        model_id: "NeoQuasar/Kronos-small",
      },
    });
    expect(normalize(small).kronos).toMatchObject({
      status: "unavailable",
      reasonCodes: expect.arrayContaining(["unexpected_model_id"]),
    });

    const fallback = run({
      fallback_used: true,
      degraded: true,
      fallback_reason: "base missing",
      model: {
        ...(run().model as object),
        fallback_from: MODEL_ID,
        fallback_reason: "base missing",
      },
    });
    expect(normalize(fallback).kronos).toMatchObject({
      status: "unavailable",
      reasonCodes: expect.arrayContaining(["model_run_provenance_inconsistent"]),
    });

    const extraModel = normalizePairModelOutputs({
      model_runs: [
        run(),
        {
          role: "chronos2",
          model: { model_id: "amazon/chronos-2", loaded: true },
        },
      ],
    }, { signalSymbol: "TSLA", expectedOrigin: ORIGIN });
    expect(extraModel.kronos).toMatchObject({
      status: "unavailable",
      reasonCodes: ["unexpected_model_run"],
    });
  });

  it("marks partial input degraded but fails closed on poor calibration and CPU", () => {
    const partial = run({
      raw_series: [{
        ...(run().raw_series[0] as object),
        input_quality: { status: "partial", warnings: ["one auxiliary series missing"] },
      }],
    });
    expect(normalize(partial).kronos).toMatchObject({
      status: "degraded",
      reasonCodes: expect.arrayContaining(["input_quality_partial"]),
    });

    const invalid = run({
      model: { ...(run().model as object), device: "cpu" },
      raw_series: [{
        ...(run().raw_series[0] as object),
        calibration: { status: "poor" },
      }],
    });
    expect(normalize(invalid).kronos).toMatchObject({
      status: "unavailable",
      reasonCodes: expect.arrayContaining(["calibration_poor", "cuda_required"]),
    });
  });

  it("rejects duplicate base runs and a non-P40 CUDA device", () => {
    const duplicate = normalizePairModelOutputs(
      { model_runs: [run(), run()] },
      { signalSymbol: "TSLA", expectedOrigin: ORIGIN },
    );
    expect(duplicate.kronos).toMatchObject({
      status: "unavailable",
      reasonCodes: ["duplicate_model_runs"],
    });

    const otherGpu = run({
      model: { ...(run().model as object), device_name: "NVIDIA A100" },
    });
    expect(normalize(otherGpu).kronos).toMatchObject({
      status: "unavailable",
      reasonCodes: expect.arrayContaining(["required_accelerator_mismatch"]),
    });
  });
});
