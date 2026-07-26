import { describe, expect, it } from "vitest";
import {
  normalizeRustIndicators,
  projectRustScannerEvidence,
  scoreRustIndicatorEvidence,
  type RustScannerEvidenceInput,
} from "./technical-indicator-evidence.js";

function scannerEvidence(
  relativeVolume: number,
  tradingAmount = 1_000_000,
): RustScannerEvidenceInput {
  return {
    schemaVersion: "rust-scanner-evidence/v1" as const,
    tradingAmount: {
      availability: { status: "available" },
      value: tradingAmount,
    },
    relativeVolume: {
      availability: { status: "available" },
      value: relativeVolume,
    },
    provenance: {
      source: "rust_scalping_scanner_metrics" as const,
    },
    components: {
      availableMetricCount: 2,
      tradingAmount,
      relativeVolume,
    },
  };
}

describe("Rust indicator evidence", () => {
  it("normalizes latest and previous finite Rust points", () => {
    const normalized = normalizeRustIndicators([{
      indicator_id: "trend-macd",
      kind: "macd",
      availability: { status: "available" },
      points: [
        { state: "available", values: { histogram: -1, ignored: Number.NaN } },
        { state: "available", values: { histogram: 2 } },
      ],
    }]);
    expect(normalized).toEqual([{
      id: "trend-macd",
      kind: "macd",
      values: { histogram: 2 },
      previousValues: { histogram: -1 },
    }]);
  });

  it("uses directional families while volatility can only reduce exposure", () => {
    const evidence = scoreRustIndicatorEvidence({
      preset: "trend",
      currentPrice: 110,
      indicators: [
        { id: "fast", kind: "ema", latestValues: { value: 108 } },
        { id: "slow", kind: "ema", latestValues: { value: 100 } },
        { id: "macd", kind: "macd", latestValues: { histogram: 1 } },
        { id: "adx", kind: "adx_dmi", latestValues: { adx: 30, plus_di: 35, minus_di: 10 } },
        { id: "natr", kind: "normalized_atr", latestValues: { value: 7 } },
        { id: "chop", kind: "choppiness_index", latestValues: { value: 70 } },
      ],
    });
    expect(evidence.directionalScore).toBeGreaterThan(0);
    expect(evidence.riskScale).toBeLessThan(1);
    expect(evidence.availableIndicatorCount).toBe(6);
    expect(evidence.usedDirectionalIndicatorCount).toBeGreaterThan(0);
    expect(evidence.usedRiskIndicatorCount).toBe(2);
  });

  it("inverts bounded oscillator evidence for mean reversion", () => {
    const trend = scoreRustIndicatorEvidence({
      preset: "trend",
      currentPrice: 100,
      indicators: [{ id: "rsi", kind: "rsi", latestValues: { value: 75 } }],
    });
    const mean = scoreRustIndicatorEvidence({
      preset: "mean_reversion",
      currentPrice: 100,
      indicators: [{ id: "rsi", kind: "rsi", latestValues: { value: 75 } }],
    });
    expect(trend.directionalScore).toBeGreaterThan(0);
    expect(mean.directionalScore).toBeLessThan(0);
  });

  it("preserves direction while scanner liquidity can only attenuate risk", () => {
    const indicators = [
      { id: "fast", kind: "ema", latestValues: { value: 108 } },
      { id: "slow", kind: "ema", latestValues: { value: 100 } },
      { id: "adx", kind: "adx_dmi", latestValues: { adx: 30, plus_di: 35, minus_di: 10 } },
    ];
    const baseline = scoreRustIndicatorEvidence({
      indicators,
      preset: "trend",
      currentPrice: 110,
    });
    const confirmed = scoreRustIndicatorEvidence({
      indicators,
      preset: "trend",
      currentPrice: 110,
      scannerEvidence: scannerEvidence(2),
    });
    const attenuated = scoreRustIndicatorEvidence({
      indicators,
      preset: "trend",
      currentPrice: 110,
      scannerEvidence: scannerEvidence(0.2),
    });
    const scannerOnly = scoreRustIndicatorEvidence({
      indicators: [],
      preset: "trend",
      currentPrice: 110,
      scannerEvidence: scannerEvidence(3),
    });
    const zeroAmount = scoreRustIndicatorEvidence({
      indicators,
      preset: "trend",
      currentPrice: 110,
      scannerEvidence: scannerEvidence(3, 0),
    });

    expect(confirmed.directionalScore).toBe(baseline.directionalScore);
    expect(confirmed.riskScale).toBeLessThanOrEqual(baseline.riskScale);
    expect(attenuated.directionalScore).toBe(baseline.directionalScore);
    expect(attenuated.riskScale).toBeLessThan(1);
    expect(attenuated.components).toMatchObject({
      "scanner:available_metric_count": 2,
      "scanner:confirmation_scale": 0.6,
      "scanner:relative_volume": 0.2,
      "scanner:trading_amount": 1_000_000,
    });
    expect(scannerOnly.directionalScore).toBe(0);
    expect(scannerOnly.usedDirectionalIndicatorCount).toBe(0);
    expect(scannerOnly.riskScale).toBe(1);
    expect(zeroAmount.directionalScore).toBe(baseline.directionalScore);
    expect(zeroAmount.riskScale).toBe(0.5);
  });

  it("projects stock scanner liquidity into the shared bounded contract", () => {
    const evidence = projectRustScannerEvidence({
      relative_volume: {
        availability: { status: "available", reason: "calculated" },
        value: 0.4,
        metadata: { baseline: "same_local_minute_prior_sessions" },
      },
      trading_amount: {
        availability: { status: "available", reason: "calculated" },
        value: 2_500_000,
        metadata: { currency: "KRW" },
      },
      spread_bps: {
        availability: { status: "unavailable", reason: "not_supplied" },
        value: null,
        metadata: {},
      },
    }, { originAt: "2026-07-25T01:02:00.000Z" });

    expect(evidence).toEqual({
      schemaVersion: "rust-scanner-evidence/v1",
      originAt: "2026-07-25T01:02:00.000Z",
      provenance: { source: "rust_scalping_scanner_metrics" },
      components: {
        availableMetricCount: 2,
        tradingAmount: 2_500_000,
        relativeVolume: 0.4,
      },
      tradingAmount: {
        availability: { status: "available", reason: "calculated" },
        value: 2_500_000,
      },
      relativeVolume: {
        availability: { status: "available", reason: "calculated" },
        value: 0.4,
      },
    });
    expect(scoreRustIndicatorEvidence({
      indicators: [{ id: "ema", kind: "ema", latestValues: { value: 99 } }],
      preset: "trend",
      currentPrice: 100,
      scannerEvidence: evidence,
    }).riskScale).toBe(0.7);
  });

  it("fails malformed scanner metrics closed without fabricating evidence", () => {
    expect(projectRustScannerEvidence({
      relative_volume: {
        availability: { status: "available", reason: "calculated" },
        value: -1,
      },
      trading_amount: {
        availability: { status: "available", reason: "calculated" },
        value: 1_000,
      },
    })).toBeUndefined();
    expect(projectRustScannerEvidence({
      relative_volume: {
        availability: { status: "unavailable", reason: "missing" },
        value: 2,
      },
      trading_amount: {
        availability: { status: "available", reason: "calculated" },
        value: 1_000,
      },
    })).toBeUndefined();
  });

  it("deduplicates ATR and liquidity risk families conservatively", () => {
    const evidence = scoreRustIndicatorEvidence({
      preset: "trend",
      currentPrice: 100,
      currentVolume: 20,
      scannerEvidence: scannerEvidence(0.8),
      indicators: [
        { id: "ema", kind: "ema", latestValues: { value: 99 } },
        { id: "natr", kind: "normalized_atr", latestValues: { value: 2 } },
        { id: "raw-atr", kind: "atr", latestValues: { atr: 10 } },
        { id: "rvol", kind: "relative_volume", latestValues: { value: 0.6 } },
        { id: "volume-sma", kind: "volume_sma", latestValues: { value: 100 } },
      ],
    });

    expect(evidence.directionalScore).toBeGreaterThan(0);
    expect(evidence.usedRiskIndicatorCount).toBe(2);
    expect(evidence.riskScale).toBe(0.35);
    expect(evidence.components).toMatchObject({
      "risk:atr": 0.35,
      "risk:liquidity": 0.6,
      "risk_source:raw-atr:price_normalized_atr": 0.35,
      "risk_source:rvol:relative_volume": 0.8,
      "risk_source:volume-sma:current_volume_to_sma": 0.6,
      "risk_source:scanner:liquidity_confirmation": 0.9,
    });
  });

  it("never increases exposure when liquidity confirmation is strong", () => {
    const baseline = scoreRustIndicatorEvidence({
      preset: "trend",
      currentPrice: 100,
      indicators: [{ id: "ema", kind: "ema", latestValues: { value: 99 } }],
    });
    const confirmed = scoreRustIndicatorEvidence({
      preset: "trend",
      currentPrice: 100,
      currentVolume: 500,
      scannerEvidence: scannerEvidence(4),
      indicators: [
        { id: "ema", kind: "ema", latestValues: { value: 99 } },
        { id: "rvol", kind: "relative_volume", latestValues: { value: 3 } },
        { id: "volume-sma", kind: "volume_sma", latestValues: { value: 100 } },
      ],
    });

    expect(confirmed.directionalScore).toBe(baseline.directionalScore);
    expect(confirmed.riskScale).toBeLessThanOrEqual(baseline.riskScale);
  });
});
