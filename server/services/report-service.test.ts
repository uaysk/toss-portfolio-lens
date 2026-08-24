import { describe, expect, it, vi } from "vitest";
import { ReportService } from "./report-service.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

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

  it("서로 다른 보고서 생성은 상한에서 거절하지만 동일 요청 공유와 완료 후 슬롯 재사용은 허용한다", async () => {
    const firstReport = deferred<{ id: string; createdAt: string }>();
    const createBacktest = vi.fn()
      .mockImplementationOnce(() => firstReport.promise)
      .mockResolvedValue({
        id: "00000000-0000-4000-8000-000000000012",
        createdAt: "2026-07-17T00:02:00.000Z",
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
    const service = new ReportService(reports as never, repository as never, "mock-model", 1);
    const input = {
      runId: "00000000-0000-4000-8000-000000000001",
      ownerSubject: "owner",
      backtestRequestHash: "request-hash-1",
      dataRevision: "revision-1",
      engineVersion: "engine-1",
      result: { metrics: {} } as never,
    };

    const first = service.generateBacktest(input);
    await vi.waitFor(() => expect(createBacktest).toHaveBeenCalledOnce());
    const duplicate = service.generateBacktest(input);
    await expect(service.generateBacktest({
      ...input,
      runId: "00000000-0000-4000-8000-000000000002",
      backtestRequestHash: "request-hash-2",
    })).rejects.toMatchObject({
      name: "ReportGenerationError",
      retryable: true,
    });

    firstReport.resolve({
      id: "00000000-0000-4000-8000-000000000011",
      createdAt: "2026-07-17T00:01:00.000Z",
    });
    const [firstResult, duplicateResult] = await Promise.all([first, duplicate]);
    expect(firstResult.id).toBe(duplicateResult.id);
    expect([firstResult.reused, duplicateResult.reused].sort()).toEqual([false, true]);

    await expect(service.generateBacktest({
      ...input,
      runId: "00000000-0000-4000-8000-000000000002",
      backtestRequestHash: "request-hash-2",
    })).resolves.toMatchObject({
      id: "00000000-0000-4000-8000-000000000012",
      reused: false,
    });
  });

  it("저장소에서 사라진 기존 링크를 새 보고서로 조건부 복구한다", async () => {
    const stale = {
      reportId: "00000000-0000-4000-8000-000000000020",
      runId: "00000000-0000-4000-8000-000000000001",
      ownerSubject: "owner",
      requestHash: "request-hash",
      dataRevision: "revision-1",
      engineVersion: "engine-1",
      reportSchemaVersion: "portfolio-report-v1",
      reportConfigHash: "44136fa355b3678a",
      createdAt: "2026-07-17T00:00:00.000Z",
    };
    const created = {
      id: "00000000-0000-4000-8000-000000000021",
      createdAt: "2026-07-17T00:01:00.000Z",
    };
    const reports = {
      generationConfigured: true,
      get: vi.fn().mockResolvedValue(undefined),
      createBacktest: vi.fn().mockResolvedValue(created),
      publicUrl: (id: string) => `https://portfolio.example/reports/${id}`,
    };
    const repository = {
      findReusable: vi.fn().mockResolvedValue(stale),
      put: vi.fn().mockImplementation(async (value) => value),
    };
    const service = new ReportService(reports as never, repository as never);

    await expect(service.generateBacktest({
      runId: stale.runId,
      ownerSubject: stale.ownerSubject,
      backtestRequestHash: stale.requestHash,
      dataRevision: stale.dataRevision,
      engineVersion: stale.engineVersion,
      result: { metrics: {} } as never,
    })).resolves.toMatchObject({ id: created.id, reused: false });

    expect(reports.createBacktest).toHaveBeenCalledOnce();
    expect(repository.put).toHaveBeenCalledWith(
      expect.objectContaining({ reportId: created.id }),
      { replaceMissingReportId: stale.reportId },
    );
  });

  it("다른 프로세스가 링크 경쟁에서 이기면 패자가 만든 보고서 객체만 정리한다", async () => {
    const created = {
      id: "00000000-0000-4000-8000-000000000041",
      createdAt: "2026-07-17T00:01:00.000Z",
    };
    const winner = {
      reportId: "00000000-0000-4000-8000-000000000042",
      runId: "00000000-0000-4000-8000-000000000001",
      ownerSubject: "owner",
      requestHash: "request-hash",
      dataRevision: "revision-1",
      engineVersion: "engine-1",
      reportSchemaVersion: "portfolio-report-v1",
      reportConfigHash: "44136fa355b3678a",
      createdAt: "2026-07-17T00:00:00.000Z",
    };
    const reports = {
      generationConfigured: true,
      get: vi.fn().mockResolvedValue(undefined),
      createBacktest: vi.fn().mockResolvedValue(created),
      delete: vi.fn().mockResolvedValue(undefined),
      publicUrl: (id: string) => `https://portfolio.example/reports/${id}`,
    };
    const repository = {
      findReusable: vi.fn().mockResolvedValue(undefined),
      put: vi.fn().mockResolvedValue(winner),
    };
    const service = new ReportService(reports as never, repository as never);

    await expect(service.generateBacktest({
      runId: winner.runId,
      ownerSubject: winner.ownerSubject,
      backtestRequestHash: winner.requestHash,
      dataRevision: winner.dataRevision,
      engineVersion: winner.engineVersion,
      result: { metrics: {} } as never,
    })).resolves.toMatchObject({ id: winner.reportId, reused: true });

    expect(reports.delete).toHaveBeenCalledExactlyOnceWith(created.id);
  });
});
