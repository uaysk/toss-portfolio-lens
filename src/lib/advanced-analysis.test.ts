import { afterEach, describe, expect, it, vi } from "vitest";
import { runAdvancedAnalysis } from "./advanced-analysis";

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("runAdvancedAnalysis externalized results", () => {
  it("Monte Carlo percentile/sample path artifact는 사용자 요청 전까지 가져오지 않는다", async () => {
    const runId = "00000000-0000-4000-8000-000000000001";
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "/api/portfolio/advanced/monte-carlo") {
        return json({ result: { run_id: runId, kind: "monte_carlo", status: "completed" } });
      }
      if (url === `/api/portfolio/advanced/runs/${runId}/result`) {
        return json({
          runId,
          kind: "monte_carlo",
          status: "completed",
          progress: 1,
          completedCandidates: 100,
          totalCandidates: 100,
          summary: { probabilities: { terminalLossProbabilityPercent: 1 } },
          resultExternalized: true,
          warnings: [],
          artifacts: [
            { type: "monte-carlo-distribution", rowCount: 1, byteCount: 10 },
            { type: "monte-carlo-percentile-paths", rowCount: 5, byteCount: 500_000 },
            { type: "monte-carlo-sample-paths", rowCount: 10, byteCount: 500_000 },
          ],
        });
      }
      if (url.endsWith("/artifacts/monte-carlo-distribution")) {
        return json({ content: { terminalBalance: { mean: 1_000_000 } } });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const completed = await runAdvancedAnalysis({ operation: "monte-carlo", body: {} });

    expect(completed.result).toMatchObject({
      percentilePaths: [],
      percentilePathsExternalized: true,
      samplePaths: [],
      samplePathsExternalized: true,
      distributions: { terminalBalance: { mean: 1_000_000 } },
    });
    expect(fetchMock.mock.calls.map(([input]) => String(input))).not.toEqual(expect.arrayContaining([
      expect.stringContaining("monte-carlo-percentile-paths"),
      expect.stringContaining("monte-carlo-sample-paths"),
    ]));
  });

  it("이전 inline stress 배열 artifact도 Web 결과 계약으로 정규화한다", async () => {
    const runId = "00000000-0000-4000-8000-000000000002";
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "/api/portfolio/advanced/stress-test") {
        return json({ result: { run_id: runId, kind: "stress_test", status: "completed" } });
      }
      if (url === `/api/portfolio/advanced/runs/${runId}/result`) {
        return json({
          runId,
          kind: "stress_test",
          status: "completed",
          progress: 1,
          completedCandidates: 1,
          totalCandidates: 1,
          resultExternalized: true,
          warnings: [],
          artifacts: [{ type: "result", rowCount: 1, byteCount: 300_000 }],
        });
      }
      if (url.endsWith("/artifacts/result")) return json({ content: [{ name: "비용 충격", summary: { cagrPercent: 5 } }] });
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const completed = await runAdvancedAnalysis({ operation: "stress-test", body: {} });

    expect(completed.result).toEqual({ scenarios: [{ name: "비용 충격", summary: { cagrPercent: 5 } }] });
  });

  it("대용량 optimization과 Walk-forward artifact를 자동 전량 조회하지 않는다", async () => {
    const optimizationRunId = "00000000-0000-4000-8000-000000000003";
    const walkRunId = "00000000-0000-4000-8000-000000000004";
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "/api/portfolio/advanced/optimization") return json({ result: { run_id: optimizationRunId, kind: "optimization", status: "completed" } });
      if (url === `/api/portfolio/advanced/runs/${optimizationRunId}/result`) return json({
        runId: optimizationRunId,
        kind: "optimization",
        status: "completed",
        progress: 1,
        completedCandidates: 10_000,
        totalCandidates: 10_000,
        summary: { best: { weights: { AAA: 1 }, metrics: { sharpe: 1 } }, candidate_count: 10_000, pareto_count: 900 },
        resultExternalized: true,
        warnings: [],
        artifacts: [{ type: "candidates", rowCount: 10_000, byteCount: 2_000_000 }, { type: "worker-pareto-frontier", rowCount: 900, byteCount: 500_000 }],
      });
      if (url === "/api/portfolio/advanced/walk-forward") return json({ result: { run_id: walkRunId, kind: "walk_forward", status: "completed" } });
      if (url === `/api/portfolio/advanced/runs/${walkRunId}/result`) return json({
        runId: walkRunId,
        kind: "walk_forward",
        status: "completed",
        progress: 1,
        completedCandidates: 2_000,
        totalCandidates: 2_000,
        summary: { fold_count: 2_000 },
        resultExternalized: true,
        warnings: [],
        artifacts: [{ type: "walk-forward", rowCount: 1, byteCount: 2_000_000 }],
      });
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const optimization = await runAdvancedAnalysis({ operation: "optimization", body: {} });
    const walkForward = await runAdvancedAnalysis({ operation: "walk-forward", body: {} });

    expect(optimization.result).toMatchObject({ candidateCount: 10_000, paretoCount: 900, candidatesExternalized: true });
    expect(walkForward.result).toMatchObject({ folds: [], foldsExternalized: true, summary: { fold_count: 2_000 } });
    expect(fetchMock.mock.calls.map(([input]) => String(input)).filter((url) => url.includes("/artifacts/"))).toEqual([]);
  });

  it("outlook은 확률 요약만 즉시 반환하고 장기 경로 artifact를 lazy 상태로 유지한다", async () => {
    const runId = "00000000-0000-4000-8000-000000000005";
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "/api/portfolio/advanced/outlook") return json({ result: { run_id: runId, kind: "outlook", status: "completed" } });
      if (url === `/api/portfolio/advanced/runs/${runId}/result`) return json({
        runId,
        kind: "outlook",
        status: "completed",
        progress: 1,
        completedCandidates: 10_000,
        totalCandidates: 10_000,
        summary: {
          confidence: { score: 0.72, label: "medium" },
          probabilities: { loss: 18, goal: 64, depletion: 3 },
          oos: { coverage: 0.6, foldCount: 8 },
          worst_scenario: { name: "유동성 충격" },
        },
        resultExternalized: true,
        warnings: [],
        artifacts: [
          { type: "outlook-summary", rowCount: 1, byteCount: 800_000 },
          { type: "outlook-quantile-paths", rowCount: 5, byteCount: 400_000 },
          { type: "outlook-oos-equity", rowCount: 8, byteCount: 4_000 },
        ],
      });
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const outlook = await runAdvancedAnalysis({ operation: "outlook", body: {} });

    expect(outlook.result).toMatchObject({
      confidence: { score: 0.72 },
      future: { terminalLossProbabilityPercent: 18, percentilePathsExternalized: true },
      oos: { coverage: 0.6 },
      outlookSummaryExternalized: true,
    });
    expect(fetchMock.mock.calls.map(([input]) => String(input)).filter((url) => url.includes("/artifacts/"))).toEqual([]);
  });
});
