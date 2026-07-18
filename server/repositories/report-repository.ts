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
    if (this.database.dialect === "mysql") {
      await this.database.run(`
        CREATE TABLE IF NOT EXISTS portfolio_report_links (
          report_id VARCHAR(64) PRIMARY KEY,
          run_id VARCHAR(64) NOT NULL,
          owner_subject VARCHAR(128) NOT NULL,
          request_hash VARCHAR(128) NOT NULL,
          data_revision VARCHAR(128) NOT NULL,
          engine_version VARCHAR(64) NOT NULL,
          report_schema_version VARCHAR(64) NOT NULL,
          report_config_hash VARCHAR(128) NOT NULL,
          model_name VARCHAR(255) NULL,
          created_at VARCHAR(40) NOT NULL,
          UNIQUE KEY uq_portfolio_report_reuse (
            owner_subject, request_hash, data_revision, engine_version,
            report_schema_version, report_config_hash
          ),
          KEY idx_portfolio_report_run (run_id),
          CONSTRAINT fk_portfolio_report_run FOREIGN KEY (run_id)
            REFERENCES portfolio_backtest_runs(run_id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
      return;
    }
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

  async put(input: ReportMetadataRecord): Promise<ReportMetadataRecord> {
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
    ];
    if (this.database.dialect === "mysql") {
      await this.database.run(`
        INSERT INTO portfolio_report_links (
          report_id, run_id, owner_subject, request_hash, data_revision, engine_version,
          report_schema_version, report_config_hash, model_name, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE report_id = report_id
      `, values);
    } else {
      await this.database.run(`
        INSERT INTO portfolio_report_links (
          report_id, run_id, owner_subject, request_hash, data_revision, engine_version,
          report_schema_version, report_config_hash, model_name, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT DO NOTHING
      `, values);
    }
    return (await this.findReusable(input)) ?? input;
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
