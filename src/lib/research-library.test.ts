import { describe, expect, it, vi } from "vitest";
import {
  buildRunLibraryUrl,
  createLibraryPreset,
  deleteLibraryPreset,
  deleteLibraryRun,
  duplicateLibraryPreset,
  exportLibraryPreset,
  generateLibraryResearchReport,
  executeLibraryPreset,
  getLibraryPreset,
  getLibraryPresetHistory,
  getLibraryRunEvents,
  getLibraryRunManifest,
  importLibraryPreset,
  listLibraryPresets,
  listLibraryRuns,
  normalizePresetPage,
  normalizePresetDetails,
  normalizeRunPage,
  normalizeTags,
  runLibraryAction,
  specializedPresetPresentation,
  updateLibraryPreset,
  updateLibraryRun,
} from "./research-library";

function json(value: unknown, status = 200): Response {
  return new Response(status === 204 ? undefined : JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("research library normalization", () => {
  it("direct와 result envelope run 목록을 같은 camelCase 모델로 정규화한다", () => {
    expect(normalizeRunPage({ result: {
      items: [{ run_id: "run-1", run_kind: "optimization", status: "completed", tags: "core, oos", is_archived: 1, created_at: 10 }],
      next_cursor: "next-1",
    } })).toEqual({
      items: [{ id: "run-1", kind: "optimization", status: "completed", tags: ["core", "oos"], archived: true, createdAt: 10 }],
      nextCursor: "next-1",
    });
    expect(normalizeRunPage([{ id: "run-2", kind: "backtest", status: "failed", tags: [], archivedAt: 123 }]).items[0]).toMatchObject({
      id: "run-2",
      archived: true,
    });
  });

  it("단일 mutation 응답의 run/preset wrapper도 정규화한다", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/runs/")) return json({ result: { run: { id: "run-3", kind: "outlook", status: "queued" } } });
      return json({ result: { preset: { id: "preset-3", name: "wrapped", revision: 2 } } });
    });
    expect((await runLibraryAction("run-1", "duplicate", { fetcher }))?.id).toBe("run-3");
    expect((await createLibraryPreset({ name: "wrapped" }, { fetcher }))?.historyCount).toBe(1);
  });

  it("preset의 snake_case 이력과 config symbols를 보존한다", () => {
    expect(normalizePresetPage({ presets: [{
      preset_id: "preset-1",
      name: "균형형",
      tags: ["core", "core"],
      config: { symbols: ["spy", "GLD"] },
      revision_count: 3,
      last_used_at: "2026-07-18T00:00:00.000Z",
    }] }).items[0]).toEqual({
      id: "preset-1",
      name: "균형형",
      tags: ["core"],
      symbols: ["SPY", "GLD"],
      config: { symbols: ["spy", "GLD"] },
      historyCount: 3,
      lastUsedAt: "2026-07-18T00:00:00.000Z",
    });
    expect(normalizeTags(" long-term, core, long-term ")).toEqual(["long-term", "core"]);
    expect(normalizePresetDetails({ result: { preset: { id: "preset-1", name: "균형형" }, history: [{ revision: 1 }] } })).toMatchObject({
      preset: { id: "preset-1", name: "균형형" },
      history: [{ revision: 1 }],
    });
  });

  it("run 검색 query와 상한이 안정적인 URL을 만든다", () => {
    expect(buildRunLibraryUrl({ query: "  alpha  ", kind: "backtest", status: "completed", archived: false, tag: "core", cursor: "c 1", limit: 500 }))
      .toBe("/api/portfolio/runs?query=alpha&kind=backtest&status=completed&archived=false&tag=core&cursor=c+1&limit=100");
  });

  it("전용 기술 프리셋은 소유 화면 복원 안내로 분류한다", () => {
    expect(specializedPresetPresentation({ config: { presetType: "technical_signal_strategy" } })).toEqual({
      label: "기술 신호 전략",
      restoreHint: "기술적 분석/백테스트 화면에서 복원",
    });
    expect(specializedPresetPresentation({ config: { preset_type: "technical_chart_config" } })?.restoreHint)
      .toBe("기술적 분석 화면에서 복원");
    expect(specializedPresetPresentation({ config: { presetType: "portfolio_allocation" } })).toBeUndefined();
  });
});

describe("research library fetch contracts", () => {
  it("목록·patch·action이 지정 REST 경로와 body를 사용한다", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/portfolio/runs?")) return json({ result: { runs: [{ id: "run-1", kind: "backtest", status: "completed" }] } });
      if (url === "/api/portfolio/runs/run-1" && init?.method === "PATCH") return json({ result: { id: "run-1", kind: "backtest", status: "completed", name: "새 이름", tags: ["core"] } });
      if (url === "/api/portfolio/runs/run-1/rerun") return json({ id: "run-2", kind: "backtest", status: "queued" });
      throw new Error(`unexpected fetch: ${url}`);
    });

    expect((await listLibraryRuns({ limit: 10 }, { fetcher })).items).toHaveLength(1);
    await updateLibraryRun("run-1", { name: "새 이름", tags: ["core"] }, { fetcher });
    await runLibraryAction("run-1", "rerun", { fetcher });

    expect(fetcher.mock.calls[1][1]).toMatchObject({
      method: "PATCH",
      body: JSON.stringify({ name: "새 이름", tags: ["core"] }),
    });
    expect(fetcher.mock.calls[2][1]).toMatchObject({ method: "POST" });
  });

  it("preset direct/envelope 응답과 strict create payload를 처리한다", async () => {
    const input = { name: "직접 입력", description: "설명", tags: ["core"], source: { type: "manual" }, symbols: ["SPY"], config: { cashWeight: 0.1 } };
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url) === "/api/portfolio/presets" && init?.method === "GET") return json({ result: { items: [{ id: "preset-1", name: "기존" }] } });
      return json({ result: { id: "preset-2", ...input } });
    });

    expect((await listLibraryPresets({ fetcher })).items[0]?.name).toBe("기존");
    expect((await createLibraryPreset(input, { fetcher }))?.name).toBe("직접 입력");
    expect(fetcher.mock.calls[1][1]).toMatchObject({ method: "POST", body: JSON.stringify(input) });
  });

  it("run detail과 삭제 계약을 지정된 경로로 호출한다", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/events")) return json({ result: { items: [{ type: "queued" }] } });
      if (url.endsWith("/manifest")) return json({ result: { seed: 42 } });
      return json(undefined, 204);
    });
    expect(await getLibraryRunEvents("run /1", { fetcher })).toEqual({ items: [{ type: "queued" }] });
    expect(await getLibraryRunManifest("run /1", { fetcher })).toEqual({ seed: 42 });
    await deleteLibraryRun("run /1", { fetcher });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      "/api/portfolio/runs/run%20%2F1/events",
      "/api/portfolio/runs/run%20%2F1/manifest",
      "/api/portfolio/runs/run%20%2F1",
    ]);
    expect(fetcher.mock.calls[2][1]).toMatchObject({ method: "DELETE" });
  });

  it("완료 run의 연구 보고서를 공통 tool HTTP 계약으로 생성한다", async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => json({ result: {
      run_id: "run-1",
      format: "markdown",
      report: "# Outlook 연구 보고서",
    } }));
    expect(await generateLibraryResearchReport("run-1", "markdown", { fetcher, title: "Outlook 감사" })).toMatchObject({
      run_id: "run-1",
      format: "markdown",
    });
    expect(fetcher).toHaveBeenCalledWith("/api/portfolio/tools/generate_research_report", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ runId: "run-1", format: "markdown", title: "Outlook 감사" }),
    }));
  });

  it("연구 보고서 async 파생 run을 UI에서 완료까지 polling한다", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/result")) return json({ status: "completed", result: { source_run_id: "run-1", report: "# 완료" } });
      if (url.includes("/api/portfolio/advanced/runs/")) return json({ runId: "report-run", status: "completed" });
      return json({ result: { run_id: "report-run", status: "queued" } });
    });
    await expect(generateLibraryResearchReport("run-1", "markdown", {
      fetcher,
      executionMode: "async",
      pollIntervalMs: 0,
    })).resolves.toEqual({ source_run_id: "run-1", report: "# 완료" });
    expect(fetcher).toHaveBeenNthCalledWith(1, "/api/portfolio/tools/generate_research_report", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ runId: "run-1", format: "markdown", executionMode: "async" }),
    }));
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      "/api/portfolio/tools/generate_research_report",
      "/api/portfolio/advanced/runs/report-run",
      "/api/portfolio/advanced/runs/report-run/result",
    ]);
  });

  it("대용량 async 연구 보고서는 lazy artifact에서 읽는다", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/artifacts/research-report")) return json({ content: { format: "markdown", document: "# 대용량" } });
      if (url.endsWith("/result")) return json({ status: "completed", resultExternalized: true });
      if (url.includes("/api/portfolio/advanced/runs/")) return json({ runId: "report-run", status: "completed" });
      return json({ result: { run_id: "report-run", status: "queued" } });
    });
    await expect(generateLibraryResearchReport("run-1", "markdown", {
      fetcher,
      executionMode: "async",
      pollIntervalMs: 0,
    })).resolves.toEqual({ format: "markdown", document: "# 대용량" });
    expect(fetcher).toHaveBeenLastCalledWith(
      "/api/portfolio/advanced/runs/report-run/artifacts/research-report",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("preset을 백테스트·최적화 공통 tool 입력으로 실행한다", async () => {
    const fetcher = vi.fn(async () => json({ result: { run_id: "run-preset", status: "queued" } }));
    expect(await executeLibraryPreset("preset-1", "optimize_portfolio", { fetcher }))
      .toMatchObject({ run_id: "run-preset" });
    expect(fetcher).toHaveBeenCalledWith("/api/portfolio/tools/optimize_portfolio", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ presetId: "preset-1" }),
    }));
  });

  it("preset 수정·복제·삭제·내보내기·가져오기 계약을 보존한다", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "DELETE") return json(undefined, 204);
      if (url.endsWith("/export")) return json({ result: { schema_version: "portfolio-lens-preset/v1" } });
      return json({ result: { preset: { id: "preset-2", name: "저장됨", revision: 2 } } });
    });
    const patch = { name: "수정", revision: 1 };
    expect((await updateLibraryPreset("preset /1", patch, { fetcher }))?.version).toBe(2);
    expect((await duplicateLibraryPreset("preset /1", { fetcher }))?.id).toBe("preset-2");
    await deleteLibraryPreset("preset /1", { fetcher });
    expect(await exportLibraryPreset("preset /1", { fetcher })).toEqual({ schema_version: "portfolio-lens-preset/v1" });
    expect((await importLibraryPreset({ schema_version: "portfolio-lens-preset/v1" }, { fetcher }))?.id).toBe("preset-2");
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      "/api/portfolio/presets/preset%20%2F1",
      "/api/portfolio/presets/preset%20%2F1/duplicate",
      "/api/portfolio/presets/preset%20%2F1",
      "/api/portfolio/presets/preset%20%2F1/export",
      "/api/portfolio/presets/import",
    ]);
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: "PATCH", body: JSON.stringify(patch) });
    expect(fetcher.mock.calls[4][1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ document: { schema_version: "portfolio-lens-preset/v1" }, conflictMode: "rename" }),
    });
  });

  it("preset 단건과 변경 이력을 별도 REST 계약으로 조회한다", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => json({ result: {
      preset: { id: "preset-1", name: "균형형" },
      history: [{ revision: 1 }],
      requested: String(input),
    } }));
    expect((await getLibraryPreset("preset /1", true, { fetcher })).preset?.id).toBe("preset-1");
    expect((await getLibraryPresetHistory("preset /1", { fetcher })).history).toEqual([{ revision: 1 }]);
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      "/api/portfolio/presets/preset%20%2F1?includeHistory=true",
      "/api/portfolio/presets/preset%20%2F1/history",
    ]);
  });

  it("401에서 callback과 구조화된 오류를 함께 제공한다", async () => {
    const onUnauthorized = vi.fn();
    const fetcher = vi.fn(async () => json({ error: { message: "로그인이 필요합니다." } }, 401));
    await expect(listLibraryRuns({}, { fetcher, onUnauthorized })).rejects.toMatchObject({ status: 401, message: "로그인이 필요합니다." });
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });
});
