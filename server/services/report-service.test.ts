import { describe, expect, it, vi } from "vitest";
import { ReportService } from "./report-service.js";

describe("ReportService", () => {
  it("동일한 보고서 요청을 동시에 받아도 writer를 한 번만 호출하고 결과를 재사용한다", async () => {
    const createBacktest = vi.fn().mockImplementation(async () => {
      await Promise.resolve();
      return {
        id: "00000000-0000-4000-8000-000000000010",
        createdAt: "2026-07-17T00:00:00.000Z",
      };
    });
    const reports = {
      generationConfigured: true,
      get: vi.fn().mockResolvedValue(undefined),
      createBacktest,
      publicUrl: (id: string) => `https://portfolio.example/reports/${id}`,
    };
    const repository = {
      findReusable: vi.fn().mockResolvedValue(undefined),
      put: vi.fn().mockImplementation(async (value) => value),
    };
    const service = new ReportService(reports as never, repository as never, "mock-model");
    const input = {
      runId: "00000000-0000-4000-8000-000000000001",
      ownerSubject: "owner",
      backtestRequestHash: "request-hash",
      dataRevision: "revision-1",
      engineVersion: "engine-1",
      reportConfig: { locale: "ko" },
      result: { metrics: {} } as never,
    };

    const [first, second] = await Promise.all([
      service.generateBacktest(input),
      service.generateBacktest(input),
    ]);

    expect(createBacktest).toHaveBeenCalledOnce();
    expect(repository.put).toHaveBeenCalledOnce();
    expect(first.id).toBe(second.id);
    expect([first.reused, second.reused].sort()).toEqual([false, true]);
  });
});
