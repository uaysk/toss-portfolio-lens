import type { PortfolioReportService, BacktestResult } from "../reports.js";
import { REPORT_TEMPLATE_VERSION } from "../reports.js";
import { ReportGenerationError } from "../report-ai.js";
import type { ReportRepository, ReportMetadataRecord } from "../repositories/report-repository.js";
import { requestHash } from "./service-envelope.js";

export type GeneratedReportMetadata = {
  id: string;
  run_id: string;
  type: "backtest";
  created_at: string;
  model?: string;
  url: string;
  data_revision: string;
  reused: boolean;
};

export class ReportService {
  private readonly inFlight = new Map<string, Promise<GeneratedReportMetadata>>();

  constructor(
    private readonly reports: PortfolioReportService,
    private readonly repository: ReportRepository,
    private readonly model?: string,
    private readonly maximumInFlight = 8,
  ) {
    if (!Number.isInteger(maximumInFlight) || maximumInFlight < 1) {
      throw new Error("동시 보고서 생성 상한은 1 이상의 정수여야 합니다.");
    }
  }

  get configured(): boolean {
    return this.reports.generationConfigured;
  }

  async generateBacktest(input: {
    runId: string;
    ownerSubject: string;
    backtestRequestHash: string;
    dataRevision: string;
    engineVersion: string;
    reportConfig?: unknown;
    result: BacktestResult;
  }): Promise<GeneratedReportMetadata> {
    const reuseKey = {
      ownerSubject: input.ownerSubject,
      requestHash: input.backtestRequestHash,
      dataRevision: input.dataRevision,
      engineVersion: input.engineVersion,
      reportSchemaVersion: REPORT_TEMPLATE_VERSION,
      reportConfigHash: requestHash(input.reportConfig ?? {}),
    };
    const reuseHash = requestHash(reuseKey);
    const pending = this.inFlight.get(reuseHash);
    if (pending) return { ...await pending, reused: true };
    if (this.inFlight.size >= this.maximumInFlight) {
      throw new ReportGenerationError(
        "AI 보고서 생성 요청이 많습니다. 진행 중인 요청이 끝난 뒤 다시 시도해 주세요.",
        true,
      );
    }
    const task = (async () => {
      const existing = await this.repository.findReusable(reuseKey);
      if (existing && await this.reports.get(existing.reportId)) {
        return this.publicMetadata(existing, true);
      }
      const missingReportId = existing?.reportId;
      const report = await this.reports.createBacktest(input.result);
      const metadata = {
        ...reuseKey,
        reportId: report.id,
        runId: input.runId,
        ...(this.model ? { model: this.model } : {}),
        createdAt: report.createdAt,
      };
      const stored = missingReportId
        ? await this.repository.put(metadata, { replaceMissingReportId: missingReportId })
        : await this.repository.put(metadata);
      if (stored.reportId !== report.id) {
        try {
          await this.reports.delete(report.id);
        } catch (error) {
          console.warn(
            `[reports] 경쟁에서 제외된 보고서 객체 정리 실패 (${report.id}):`,
            error instanceof Error ? error.message : error,
          );
        }
      }
      return this.publicMetadata(stored, stored.reportId !== report.id);
    })();
    this.inFlight.set(reuseHash, task);
    try {
      return await task;
    } finally {
      if (this.inFlight.get(reuseHash) === task) this.inFlight.delete(reuseHash);
    }
  }

  async get(reportId: string, ownerSubject?: string): Promise<GeneratedReportMetadata | undefined> {
    const metadata = await this.repository.get(reportId, ownerSubject);
    if (!metadata || !await this.reports.get(reportId)) return undefined;
    return this.publicMetadata(metadata, false);
  }

  private publicMetadata(value: ReportMetadataRecord, reused: boolean): GeneratedReportMetadata {
    return {
      id: value.reportId,
      run_id: value.runId,
      type: "backtest",
      created_at: value.createdAt,
      ...(value.model ? { model: value.model } : {}),
      url: this.reports.publicUrl(value.reportId),
      data_revision: value.dataRevision,
      reused,
    };
  }
}
