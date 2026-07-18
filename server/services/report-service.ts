import type { PortfolioReportService, BacktestResult } from "../reports.js";
import { REPORT_TEMPLATE_VERSION } from "../reports.js";
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
  ) {}

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
    const task = (async () => {
      const existing = await this.repository.findReusable(reuseKey);
      if (existing && await this.reports.get(existing.reportId)) {
        return this.publicMetadata(existing, true);
      }
      const report = await this.reports.createBacktest(input.result);
      const stored = await this.repository.put({
        ...reuseKey,
        reportId: report.id,
        runId: input.runId,
        ...(this.model ? { model: this.model } : {}),
        createdAt: report.createdAt,
      });
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
