import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PGliteDatabase } from "../../test-support/pglite-database.js";
import { RunRepository } from "./run-repository.js";
import { ReportRepository, type ReportMetadataRecord } from "./report-repository.js";

describe("ReportRepository", () => {
  let database: PGliteDatabase;
  let runs: RunRepository;
  let reports: ReportRepository;

  beforeAll(async () => {
    database = await PGliteDatabase.create();
    runs = new RunRepository(database);
    reports = new ReportRepository(database);
    await runs.initialize();
    await reports.initialize();
  });

  afterAll(async () => {
    await database.close();
  });

  it("한 statement로 메타데이터를 저장하고 동시 reuse key 충돌 시 기존 링크를 반환한다", async () => {
    const run = await runs.create({
      kind: "backtest",
      ownerSubject: "owner",
      requestHash: "run-request-hash",
      dataRevision: "revision-1",
      engineVersion: "engine-1",
      config: {},
    });
    const input: ReportMetadataRecord = {
      reportId: "00000000-0000-4000-8000-000000000021",
      runId: run.id,
      ownerSubject: "owner",
      requestHash: "backtest-request-hash",
      dataRevision: "revision-1",
      engineVersion: "engine-1",
      reportSchemaVersion: "portfolio-report-v1",
      reportConfigHash: "report-config-hash",
      model: "mock-model",
      createdAt: "2026-07-17T00:00:00.000Z",
    };
    const query = vi.spyOn(database, "query");
    const runStatement = vi.spyOn(database, "run");

    await expect(reports.put(input)).resolves.toEqual(input);
    await expect(reports.put({
      ...input,
      reportId: "00000000-0000-4000-8000-000000000022",
      createdAt: "2026-07-17T00:01:00.000Z",
    })).resolves.toEqual(input);

    expect(query).toHaveBeenCalledTimes(2);
    expect(runStatement).not.toHaveBeenCalled();
    expect(query.mock.calls.every(([sql]) => (
      String(sql).includes("ON CONFLICT") && String(sql).includes("RETURNING *")
    ))).toBe(true);
    await expect(database.query<{ count: number }>(
      "SELECT COUNT(*) AS count FROM portfolio_report_links",
    )).resolves.toEqual([{ count: 1 }]);
  });

  it("저장소에서 사라진 링크만 compare-and-swap으로 교체한다", async () => {
    const run = await runs.create({
      kind: "backtest",
      ownerSubject: "owner",
      requestHash: "stale-run-request-hash",
      dataRevision: "revision-stale",
      engineVersion: "engine-1",
      config: {},
    });
    const stale: ReportMetadataRecord = {
      reportId: "00000000-0000-4000-8000-000000000031",
      runId: run.id,
      ownerSubject: "owner",
      requestHash: "stale-backtest-request-hash",
      dataRevision: "revision-stale",
      engineVersion: "engine-1",
      reportSchemaVersion: "portfolio-report-v1",
      reportConfigHash: "stale-report-config-hash",
      createdAt: "2026-07-17T00:00:00.000Z",
    };
    const recovered: ReportMetadataRecord = {
      ...stale,
      reportId: "00000000-0000-4000-8000-000000000032",
      createdAt: "2026-07-17T00:01:00.000Z",
    };
    const late: ReportMetadataRecord = {
      ...stale,
      reportId: "00000000-0000-4000-8000-000000000033",
      createdAt: "2026-07-17T00:02:00.000Z",
    };

    await expect(reports.put(stale)).resolves.toEqual(stale);
    await expect(reports.put(recovered, {
      replaceMissingReportId: stale.reportId,
    })).resolves.toEqual(recovered);
    await expect(reports.put(late, {
      replaceMissingReportId: stale.reportId,
    })).resolves.toEqual(recovered);
    await expect(reports.findReusable(recovered)).resolves.toEqual(recovered);
  });
});
