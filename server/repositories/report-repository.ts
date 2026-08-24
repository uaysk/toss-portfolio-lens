import type { RelationalDatabase } from "../database.js";

export type ReportMetadataRecord = {
  reportId: string;
  runId: string;
  ownerSubject: string;
  requestHash: string;
  dataRevision: string;
  engineVersion: string;
  reportSchemaVersion: string;
  reportConfigHash: string;
  model?: string;
  createdAt: string;
};

type ReportPutOptions = {
  // The caller has already verified that this exact linked report is absent
  // from durable storage. The conditional update prevents replacing a newer
  // link won by another process while recovery was running.
  replaceMissingReportId?: string;
};

type ReportRow = {
  report_id: string;
  run_id: string;
  owner_subject: string;
  request_hash: string;
  data_revision: string;
  engine_version: string;
  report_schema_version: string;
  report_config_hash: string;
  model_name: string | null;
  created_at: string;
};

function mapRow(row: ReportRow): ReportMetadataRecord {
  return {
    reportId: row.report_id,
    runId: row.run_id,
    ownerSubject: row.owner_subject,
    requestHash: row.request_hash,
    dataRevision: row.data_revision,
    engineVersion: row.engine_version,
    reportSchemaVersion: row.report_schema_version,
    reportConfigHash: row.report_config_hash,
    ...(row.model_name ? { model: row.model_name } : {}),
    createdAt: row.created_at,
  };
}

export class ReportRepository {
  constructor(private readonly database: RelationalDatabase) {}

  async initialize(): Promise<void> {
    await this.database.run(`
      CREATE TABLE IF NOT EXISTS portfolio_report_links (
        report_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES portfolio_backtest_runs(run_id) ON DELETE CASCADE,
        owner_subject TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        data_revision TEXT NOT NULL,
        engine_version TEXT NOT NULL,
        report_schema_version TEXT NOT NULL,
        report_config_hash TEXT NOT NULL,
        model_name TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(
          owner_subject, request_hash, data_revision, engine_version,
          report_schema_version, report_config_hash
        )
      )
    `);
    await this.database.run(`
      CREATE INDEX IF NOT EXISTS idx_portfolio_report_run ON portfolio_report_links(run_id)
    `);
  }

  async findReusable(input: Omit<ReportMetadataRecord, "reportId" | "runId" | "model" | "createdAt">): Promise<ReportMetadataRecord | undefined> {
    const [row] = await this.database.query<ReportRow>(`
      SELECT * FROM portfolio_report_links
      WHERE owner_subject = ? AND request_hash = ? AND data_revision = ?
        AND engine_version = ? AND report_schema_version = ? AND report_config_hash = ?
      LIMIT 1
    `, [
      input.ownerSubject,
      input.requestHash,
      input.dataRevision,
      input.engineVersion,
      input.reportSchemaVersion,
      input.reportConfigHash,
    ]);
    return row ? mapRow(row) : undefined;
  }

  async put(input: ReportMetadataRecord, options: ReportPutOptions = {}): Promise<ReportMetadataRecord> {
    const replaceMissingReportId = options.replaceMissingReportId;
    const values = [
      input.reportId,
      input.runId,
      input.ownerSubject,
      input.requestHash,
      input.dataRevision,
      input.engineVersion,
      input.reportSchemaVersion,
      input.reportConfigHash,
      input.model,
      input.createdAt,
      ...(replaceMissingReportId ? [replaceMissingReportId] : []),
    ];
    const [stored] = await this.database.query<ReportRow>(`
      INSERT INTO portfolio_report_links (
        report_id, run_id, owner_subject, request_hash, data_revision, engine_version,
        report_schema_version, report_config_hash, model_name, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (
        owner_subject, request_hash, data_revision, engine_version,
        report_schema_version, report_config_hash
      ) DO UPDATE SET
        ${replaceMissingReportId ? `
          report_id = excluded.report_id,
          run_id = excluded.run_id,
          model_name = excluded.model_name,
          created_at = excluded.created_at
        WHERE portfolio_report_links.report_id = ?
        ` : "report_id = portfolio_report_links.report_id"}
      RETURNING *
    `, values);
    if (stored) return mapRow(stored);

    // A concurrent process replaced the stale link first. Return its winner
    // instead of overwriting it or failing a request whose report is reusable.
    if (replaceMissingReportId) {
      const concurrent = await this.findReusable(input);
      if (concurrent) return concurrent;
    }
    throw new Error("보고서 메타데이터를 저장하지 못했습니다.");
  }

  async get(reportId: string, ownerSubject?: string): Promise<ReportMetadataRecord | undefined> {
    const [row] = ownerSubject
      ? await this.database.query<ReportRow>(
          "SELECT * FROM portfolio_report_links WHERE report_id = ? AND owner_subject = ?",
          [reportId, ownerSubject],
        )
      : await this.database.query<ReportRow>("SELECT * FROM portfolio_report_links WHERE report_id = ?", [reportId]);
    return row ? mapRow(row) : undefined;
  }
}
