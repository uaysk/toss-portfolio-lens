import { describe, expect, it } from "vitest";
import { ResearchReportService, renderResearchReportMarkdown } from "./research-report-service.js";

describe("ResearchReportService", () => {
  it("저장된 artifact 근거와 누락 데이터 품질을 숨기지 않고 보고한다", () => {
    const service = new ResearchReportService();
    const document = service.build({
      generatedAt: "2026-07-18T00:00:00.000Z",
      run: {
        id: "run-1",
        kind: "outlook",
        ownerSubject: "owner",
        requestHash: "hash",
        dataRevision: "revision",
        engineVersion: "engine",
        status: "completed",
        progress: 1,
        completedCandidates: 10,
        totalCandidates: 10,
        input: { seed: 7 },
        summary: { confidence: 0.5 },
        warnings: ["거래량 자료 없음"],
        tags: [],
        createdAt: 1,
        finishedAt: 2,
        updatedAt: 2,
      },
      artifacts: [{
        descriptor: {
          id: "artifact-1",
          runId: "run-1",
          type: "outlook-summary",
          uri: "portfolio://runs/run-1/artifacts/outlook-summary",
          format: "application/json",
          rowCount: 1,
          byteCount: 100,
          checksum: "a".repeat(64),
          generatedAt: "2026-07-18T00:00:00.000Z",
          schemaVersion: "1",
          dataRevision: "revision",
        },
        content: { confidence: { score: 0.5 }, data_quality: { volume: "unavailable" } },
      }],
    });

    expect(document.data_quality.status).toBe("partial");
    expect(document.data_quality.warnings).toContain("거래량 자료 없음");
    expect(document.data_quality.warnings.join(" ")).toContain("outlook-summary artifact");
    expect(document.data_quality.missing_expected_artifacts).toContain("outlook-oos-equity");
    expect(document.limitations.join(" ")).toContain("추정해 채우지 않습니다");
    expect(renderResearchReportMarkdown(document)).toContain("## 증거 artifact");
  });
});
