import { afterEach, describe, expect, it } from "vitest";
import { SqliteDatabase } from "../../database.js";
import { ArtifactRepository } from "../../repositories/artifact-repository.js";
import { OptimizationRepository } from "../../repositories/optimization-repository.js";
import { PresetRepository } from "../../repositories/preset-repository.js";
import { RunRepository } from "../../repositories/run-repository.js";
import { ArtifactService } from "../../services/artifact-service.js";
import { PresetService } from "../../services/preset-service.js";
import { ResearchReportService } from "../../services/research-report-service.js";
import { RunService } from "../../services/run-service.js";
import { createToolHandlers, type McpToolDependencies } from "./handlers.js";

function result(value: unknown): Record<string, unknown> {
  return (value as { result: Record<string, unknown> }).result;
}

describe("management MCP handlers", () => {
  let database: SqliteDatabase | undefined;

  afterEach(async () => {
    await database?.close();
    database = undefined;
  });

  async function setup() {
    database = new SqliteDatabase(":memory:");
    const runs = new RunRepository(database);
    const artifactRepository = new ArtifactRepository(database);
    const presets = new PresetService(new PresetRepository(database));
    const optimization = new OptimizationRepository(database);
    await runs.initialize();
    await artifactRepository.initialize();
    await presets.initialize();
    await optimization.initialize();
    const artifacts = new ArtifactService(artifactRepository, 10, 10_000);
    const runService = new RunService(runs, artifacts, 1, 10, { optimizationRepository: optimization });
    const handlers = createToolHandlers({
      runRepository: runs,
      presets,
      researchReports: new ResearchReportService(),
      optimizationRepository: optimization,
      artifacts,
      runs: runService,
    } as unknown as McpToolDependencies);
    return { runs, artifacts, optimization, runService, handlers };
  }

  async function terminal(runService: RunService, runId: string, owner = "owner-a") {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const run = await runService.get(runId, owner);
      if (run && ["completed", "cancelled", "failed"].includes(run.status)) return run;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    throw new Error(`run이 종료되지 않았습니다: ${runId}`);
  }

  it("owner별 run 관리, artifact 복제, soft delete와 연구 보고서를 제공한다", async () => {
    const { runs, artifacts, handlers } = await setup();
    const created = await runs.create({
      kind: "backtest",
      ownerSubject: "owner-a",
      requestHash: "a".repeat(64),
      dataRevision: "revision-a",
      engineVersion: "engine-a",
      config: { assets: [{ symbol: "AAA", weight: 100 }], seed: 7 },
      now: 100,
    });
    await runs.complete(created.id, { cagrPercent: 8 }, { metrics: { cagrPercent: 8 } }, ["거래량 자료 없음"], 110);
    await artifacts.put({ runId: created.id, type: "equity", content: [{ date: "2024-01-01", balance: 100 }], dataRevision: "revision-a" });

    const updated = result(await handlers.update_run({ runId: created.id, name: "장기 백테스트", tags: ["saved"], archived: true }, "owner-a"));
    expect(updated.run).toMatchObject({ name: "장기 백테스트", tags: ["saved"], archivedAt: expect.any(Number) });
    expect(result(await handlers.list_runs({ kinds: [], statuses: [], tags: [], archived: "archived", limit: 25 }, "owner-a")).items)
      .toEqual([expect.objectContaining({ id: created.id })]);
    expect(result(await handlers.list_runs({ kinds: [], statuses: [], tags: [], archived: "all", limit: 25 }, "owner-b")).items)
      .toEqual([]);

    const firstManifest = result(await handlers.export_run_manifest({ runId: created.id }, "owner-a")).manifest;
    const secondManifest = result(await handlers.export_run_manifest({ runId: created.id }, "owner-a")).manifest;
    expect(firstManifest).toEqual(secondManifest);
    expect(firstManifest).toMatchObject({
      schema_version: "portfolio-lens-run-manifest/v1",
      run: { id: created.id, data_revision: "revision-a" },
      build: { mcpToolCount: 50, mcpSchemaHash: expect.stringMatching(/^[a-f0-9]{64}$/) },
    });

    const report = result(await handlers.generate_research_report({ runId: created.id, format: "markdown" }, "owner-a"));
    expect(report.report).toContain("데이터 품질");
    expect(await artifacts.get(created.id, "research-report")).toBeTruthy();

    const duplicated = result(await handlers.duplicate_run({ runId: created.id }, "owner-a"));
    const clone = (duplicated.run as { id: string });
    expect(clone.id).not.toBe(created.id);
    expect(await artifacts.get(clone.id, "equity")).toBeTruthy();
    expect(result(await handlers.delete_run({ runId: clone.id }, "owner-a"))).toMatchObject({ deleted: true });
    expect(await runs.get(clone.id, "owner-a")).toBeUndefined();
  });

  it("preset revision/history/export/import/duplicate를 동일 owner 계약으로 관리한다", async () => {
    const { handlers } = await setup();
    const created = result(await handlers.create_portfolio_preset({
      name: "균형형",
      description: "기본 구성",
      tags: ["saved"],
      symbols: ["AAA", "BBB"],
      config: { weights: { AAA: 0.5, BBB: 0.5 } },
      source: { type: "manual" },
    }, "owner-a")).preset as { id: string; revision: number };

    const updated = result(await handlers.update_portfolio_preset({
      presetId: created.id,
      revision: created.revision,
      description: "수정 구성",
    }, "owner-a")).preset as { revision: number };
    expect(updated.revision).toBe(2);
    const stored = result(await handlers.get_portfolio_preset({ presetId: created.id, includeHistory: true }, "owner-a"));
    expect(stored.history).toHaveLength(2);

    const exported = result(await handlers.export_portfolio_preset({ presetId: created.id }, "owner-a"));
    expect((exported.document as { schema_version: string }).schema_version).toBe("portfolio-lens-preset/v1");
    const imported = result(await handlers.import_portfolio_presets({ document: exported.document, conflictMode: "rename" }, "owner-a"));
    expect(imported.preset).toMatchObject({ name: "균형형 가져오기" });
    expect(result(await handlers.list_portfolio_presets({ tags: [], limit: 25 }, "owner-b")).items).toEqual([]);

    const duplicate = result(await handlers.duplicate_portfolio_preset({ presetId: created.id }, "owner-a"));
    expect(duplicate.preset).toMatchObject({ source: { type: "preset", presetId: created.id } });
    expect(result(await handlers.delete_portfolio_preset({ presetId: created.id }, "owner-a"))).toMatchObject({ deleted: true });

    const current = result(await handlers.create_portfolio_preset({
      name: "현재 포트폴리오",
      symbols: ["AAA", "BBB"],
      source: {
        type: "current_portfolio",
        holdings: [
          { symbol: "AAA", currency: "KRW", evaluationAmount: 600 },
          { symbol: "BBB", currency: "KRW", evaluationAmount: 400 },
        ],
      },
    }, "owner-a")).preset as { config: Record<string, unknown> };
    expect(current.config).toMatchObject({
      defaultWeights: { AAA: 0.6, BBB: 0.4 },
      dataQuality: { defaultWeights: "available", cashWeight: "unavailable" },
    });
  });

  it("노출·Pareto·연구 보고서를 취소 가능한 파생 run과 lazy artifact로 실행한다", async () => {
    const { runs, artifacts, optimization, runService, handlers } = await setup();
    const source = await runs.create({
      kind: "optimization",
      ownerSubject: "owner-a",
      requestHash: "f".repeat(64),
      dataRevision: "revision-derived",
      engineVersion: "engine-a",
      config: { symbols: ["AAA", "BBB"] },
    });
    await optimization.createRun({
      runId: source.id,
      objective: "robust_score",
      seed: 7,
      candidateBudget: 1,
      objectiveVersion: "engine-a",
      settings: {},
    });
    await optimization.putCandidates([{
      runId: source.id,
      rank: 1,
      weights: { AAA: 0.5, BBB: 0.5 },
      metrics: { robustScore: 1 },
      score: 1,
      pareto: true,
    }]);
    await runs.complete(source.id, { candidate_count: 1 }, { best: 0 }, []);
    await artifacts.put({ runId: source.id, type: "candidates", content: [{ rank: 1 }], dataRevision: "revision-derived" });

    const exposureId = String(result(await handlers.analyze_portfolio_exposures({
      assets: [{ symbol: "AAA", weight: 1, currency: "USD" }],
      lookThrough: true,
      executionMode: "async",
    }, "owner-a")).run_id);
    expect(await terminal(runService, exposureId)).toMatchObject({ kind: "exposure_analysis", status: "completed" });
    expect(await artifacts.get(exposureId, "portfolio-exposures")).toBeTruthy();

    const paretoId = String(result(await handlers.build_pareto_frontier({
      runId: source.id,
      limit: 10,
      executionMode: "async",
    }, "owner-a")).run_id);
    expect(await terminal(runService, paretoId)).toMatchObject({ kind: "pareto_frontier", status: "completed" });
    expect(await artifacts.get(paretoId, "pareto-frontier")).toMatchObject({
      content: { candidates: [expect.objectContaining({ rank: 1, pareto: true })] },
    });

    const reportId = String(result(await handlers.generate_research_report({
      runId: source.id,
      format: "json",
      executionMode: "async",
    }, "owner-a")).run_id);
    expect(await terminal(runService, reportId)).toMatchObject({ kind: "research_report", status: "completed" });
    expect(await artifacts.get(reportId, "research-report")).toBeTruthy();
  });

  it("대기 중인 파생 분석은 공통 cancel_run 계약으로 취소되고 artifact를 만들지 않는다", async () => {
    const { artifacts, runService, handlers } = await setup();
    let release!: () => void;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    await runService.enqueue({
      ownerSubject: "owner-a",
      kind: "stress_test",
      config: { blocker: true },
      dataRevision: "revision-derived",
      allowInlineInExternal: true,
      task: async () => {
        started();
        await releasePromise;
        return { summary: {}, result: {} };
      },
    });
    await startedPromise;
    const derivedId = String(result(await handlers.analyze_portfolio_exposures({
      assets: [{ symbol: "AAA", weight: 1, currency: "USD" }],
      lookThrough: true,
      executionMode: "async",
    }, "owner-a")).run_id);
    expect(result(await handlers.cancel_run({ runId: derivedId }, "owner-a"))).toMatchObject({
      run_id: derivedId,
      cancel_requested: true,
    });
    release();
    expect(await terminal(runService, derivedId)).toMatchObject({ status: "cancelled" });
    expect(await artifacts.get(derivedId, "portfolio-exposures")).toBeUndefined();
  });
});
