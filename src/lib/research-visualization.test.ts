import { describe, expect, it } from "vitest";
import {
  buildOosEquitySeries,
  buildQuantileSeries,
  candidateMetric,
  chartCandidates,
  downsampleRows,
  normalizeOptimizationCandidates,
  parseFactorDraft,
} from "./research-visualization";

describe("research visualization normalization", () => {
  it("merges screening and ledger candidates by deterministic weights", () => {
    const candidates = normalizeOptimizationCandidates({
      candidates: [{
        weights: { B: 0.4, A: 0.6 },
        metrics: { cagr: 0.1, totalReturn: 0.12, robustScore: 0.3 },
        screeningRank: 3,
        robustScoreDetail: { inSampleScore: 0.4, coverage: 0.5 },
      }],
      ledgerCandidates: [{
        weights: { A: 0.6, B: 0.4 },
        screeningMetrics: { cagr: 0.1, totalReturn: 0.12 },
        ledgerMetrics: { cagr: 0.08, totalReturn: 0.09, robustScore: 0.25 },
        ledgerRank: 1,
        validationStatus: "completed",
      }],
      paretoCandidates: [{ weights: { A: 0.6, B: 0.4 } }],
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ pareto: true, screeningRank: 3, ledgerRank: 1, validationStatus: "completed" });
    expect(candidateMetric(candidates[0].ledgerMetrics, "cagr")).toBe(0.08);
    expect(candidateMetric(candidates[0].ledgerMetrics, "totalReturn")).toBe(0.09);
  });

  it("bounds scatter work while retaining Pareto points", () => {
    const candidates = normalizeOptimizationCandidates({
      candidates: Array.from({ length: 20 }, (_, index) => ({ weights: { A: index / 100 + 0.01, B: 0.99 - index / 100 } })),
      paretoCandidates: [{ weights: { A: 0.01, B: 0.99 } }],
    });
    const chart = chartCandidates(candidates, 5);
    expect(chart).toHaveLength(5);
    expect(chart.some((candidate) => candidate.pareto)).toBe(true);
  });

  it("joins and downsamples percentile paths and OOS equity", () => {
    const paths = buildQuantileSeries([
      { quantile: 0.05, points: [{ step: 0, balance: 100 }, { step: 1, balance: 90 }] },
      { quantile: 0.5, points: [{ step: 0, balance: 100 }, { step: 1, balance: 110 }] },
    ]);
    expect(paths.keys).toEqual([{ key: "q500", quantile: 0.05 }, { key: "q5000", quantile: 0.5 }]);
    expect(paths.points[1]).toMatchObject({ q500: 90, q5000: 110 });
    expect(buildOosEquitySeries([{ date: "a", equity: 1 }, { date: "b", equity: 1.1 }], 2)).toHaveLength(2);
  });

  it("bounds long chart paths while retaining both endpoints", () => {
    const rows = Array.from({ length: 25_200 }, (_, step) => ({ step }));
    const sampled = downsampleRows(rows, 500);

    expect(sampled).toHaveLength(500);
    expect(sampled[0]).toEqual({ step: 0 });
    expect(sampled.at(-1)).toEqual({ step: 25_199 });
    expect(() => downsampleRows(rows, 0)).toThrow(/positive safe integer/u);
  });

  it("parses only finite factor metadata supplied by the user", () => {
    expect(parseFactorDraft("value=0.4, momentum=-0.2, broken=x")).toEqual({ value: 0.4, momentum: -0.2 });
  });
});
