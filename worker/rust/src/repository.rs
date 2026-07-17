use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, bail, ensure};
use native_tls::{Certificate, TlsConnector};
use postgres::{Client, NoTls, Transaction};
use postgres_native_tls::MakeTlsConnector;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::contracts::{
    ARTIFACT_ENCODING, ARTIFACT_FORMAT, JobKind, WorkerInput, WorkerOutput, decode_input,
    encode_artifact, job_kind,
};
use crate::{ENGINE_VERSION, WORKER_SCHEMA_VERSION};

#[derive(Debug, Clone)]
pub struct JobClaim {
    pub run_id: String,
    pub job_kind: JobKind,
    pub lease_owner: String,
    pub lease_expires_at: i64,
    pub deadline_at: i64,
    pub attempt_count: i32,
    pub max_attempts: i32,
    pub input_artifact_id: String,
    pub data_revision: String,
    pub engine_version: String,
    pub request_hash: String,
}

pub fn epoch_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

pub struct WorkerRepository {
    conninfo: String,
    client: Client,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RecoveryAction {
    DeadlineFailed,
    LeaseRequeued,
    LeaseFailed,
}

fn recovery_action(
    deadline_at: i64,
    current: i64,
    attempts: i32,
    max_attempts: i32,
) -> RecoveryAction {
    if deadline_at <= current {
        RecoveryAction::DeadlineFailed
    } else if attempts < max_attempts {
        RecoveryAction::LeaseRequeued
    } else {
        RecoveryAction::LeaseFailed
    }
}

impl WorkerRepository {
    pub fn connect(conninfo: &str) -> Result<Self> {
        let mut client = if env_flag("POSTGRES_SSL", false) {
            let mut builder = TlsConnector::builder();
            if let Ok(path) = std::env::var("POSTGRES_SSL_CA_PATH")
                && !path.trim().is_empty()
            {
                let source = std::fs::read(path).context("read POSTGRES_SSL_CA_PATH")?;
                builder.add_root_certificate(
                    Certificate::from_pem(&source).context("parse PostgreSQL CA PEM")?,
                );
            }
            if !env_flag("POSTGRES_SSL_REJECT_UNAUTHORIZED", true) {
                builder.danger_accept_invalid_certs(true);
                builder.danger_accept_invalid_hostnames(true);
            }
            let connector =
                MakeTlsConnector::new(builder.build().context("build PostgreSQL TLS connector")?);
            Client::connect(conninfo, connector).context("connect TLS PostgreSQL worker queue")?
        } else {
            Client::connect(conninfo, NoTls).context("connect PostgreSQL worker queue")?
        };
        let row = client.query_one(
            "SELECT to_regclass('public.portfolio_run_jobs')::text, to_regclass('public.portfolio_worker_artifacts')::text",
            &[],
        )?;
        let jobs: Option<String> = row.get(0);
        let artifacts: Option<String> = row.get(1);
        ensure!(
            jobs.is_some() && artifacts.is_some(),
            "worker queue schema is not initialized"
        );
        Ok(Self {
            conninfo: conninfo.to_owned(),
            client,
        })
    }

    pub fn reconnect(&self) -> Result<Self> {
        Self::connect(&self.conninfo)
    }

    pub fn claim(&mut self, worker_id: &str, lease_ms: i64) -> Result<Option<JobClaim>> {
        ensure!(!worker_id.trim().is_empty(), "worker id is required");
        let current = epoch_ms();
        let safe_lease = lease_ms.clamp(1_000, 600_000);
        let owner = format!(
            "{}:{}",
            worker_id.chars().take(96).collect::<String>(),
            Uuid::new_v4()
        );
        let expires = current + safe_lease;
        let mut transaction = self.client.transaction()?;
        let selected = transaction.query_opt(
            "SELECT job.run_id, job.job_kind, job.attempt_count, job.max_attempts, \
                    job.input_artifact_id, job.deadline_at, run.data_revision, \
                    run.engine_version, run.request_hash \
             FROM portfolio_run_jobs job \
             JOIN portfolio_backtest_runs run ON run.run_id = job.run_id \
             WHERE job.state = 'queued' AND job.available_at <= $1 \
               AND job.deadline_at > $1 AND job.attempt_count < job.max_attempts \
               AND run.status = 'queued' AND job.job_kind = run.run_kind \
               AND job.payload_schema_version = $2 AND run.engine_version = $3 \
             ORDER BY job.priority ASC, job.available_at ASC, job.created_at ASC \
             FOR UPDATE OF job, run SKIP LOCKED LIMIT 1",
            &[&current, &WORKER_SCHEMA_VERSION, &ENGINE_VERSION],
        )?;
        let Some(selected) = selected else {
            transaction.commit()?;
            return Ok(None);
        };
        let run_id: String = selected.get("run_id");
        let job_update = transaction.execute(
            "UPDATE portfolio_run_jobs SET state='running', lease_owner=$1, lease_expires_at=$2, \
                    heartbeat_at=$3, attempt_count=attempt_count+1, updated_at=$3 \
             WHERE run_id=$4 AND state='queued'",
            &[&owner, &expires, &current, &run_id],
        )?;
        let run_update = transaction.execute(
            "UPDATE portfolio_backtest_runs SET status='running', started_at=COALESCE(started_at,$1), updated_at=$1 \
             WHERE run_id=$2 AND status='queued'",
            &[&current, &run_id],
        )?;
        ensure!(
            job_update == 1 && run_update == 1,
            "job claim state transition conflict"
        );
        add_event(
            &mut transaction,
            &run_id,
            "worker_claimed",
            &json!({
                "worker_id": worker_id.chars().take(96).collect::<String>(),
                "lease_expires_at": expires,
                "engine": ENGINE_VERSION,
            }),
            current,
        )?;
        let claim = JobClaim {
            run_id,
            job_kind: job_kind(selected.get::<_, String>("job_kind").as_str())?,
            lease_owner: owner,
            lease_expires_at: expires,
            deadline_at: selected.get("deadline_at"),
            attempt_count: selected.get::<_, i32>("attempt_count") + 1,
            max_attempts: selected.get("max_attempts"),
            input_artifact_id: selected.get("input_artifact_id"),
            data_revision: selected.get("data_revision"),
            engine_version: selected.get("engine_version"),
            request_hash: selected.get("request_hash"),
        };
        transaction.commit()?;
        Ok(Some(claim))
    }

    pub fn load_input(&mut self, claim: &JobClaim) -> Result<WorkerInput> {
        let row = self
            .client
            .query_opt(
                "SELECT artifact.content, artifact.byte_count, artifact.uncompressed_byte_count, \
                    artifact.checksum, artifact.schema_version, artifact.data_revision, \
                    artifact.artifact_role, artifact.format, artifact.content_encoding \
             FROM portfolio_worker_artifacts artifact \
             JOIN portfolio_run_jobs job ON job.input_artifact_id=artifact.artifact_id \
             WHERE job.run_id=$1 AND artifact.artifact_id=$2",
                &[&claim.run_id, &claim.input_artifact_id],
            )?
            .context("worker input artifact not found")?;
        let role: String = row.get("artifact_role");
        let format: String = row.get("format");
        let encoding: String = row.get("content_encoding");
        let schema: String = row.get("schema_version");
        let revision: String = row.get("data_revision");
        ensure!(
            role == "input" && format == ARTIFACT_FORMAT && encoding == ARTIFACT_ENCODING,
            "worker input artifact metadata mismatch"
        );
        ensure!(
            schema == WORKER_SCHEMA_VERSION && revision == claim.data_revision,
            "worker input artifact identity mismatch"
        );
        let content: Vec<u8> = row.get("content");
        let byte_count: i64 = row.get("byte_count");
        let uncompressed_byte_count: i64 = row.get("uncompressed_byte_count");
        ensure!(
            byte_count >= 0 && byte_count as usize == content.len(),
            "worker input compressed size metadata mismatch"
        );
        ensure!(
            uncompressed_byte_count >= 0,
            "worker input uncompressed size metadata is invalid"
        );
        let checksum: String = row.get("checksum");
        let input = decode_input(&content, &checksum, uncompressed_byte_count as usize)?;
        ensure!(
            input.run_id == claim.run_id && input.job_kind == claim.job_kind,
            "worker input job identity mismatch"
        );
        ensure!(
            input.data_revision == claim.data_revision
                && input.engine_version == claim.engine_version,
            "worker input data/engine identity mismatch"
        );
        ensure!(
            input.request_hash == claim.request_hash,
            "worker input request identity mismatch"
        );
        Ok(input)
    }

    pub fn heartbeat(&mut self, claim: &JobClaim, lease_ms: i64) -> Result<(bool, bool)> {
        let current = epoch_ms();
        let expires = current + lease_ms.clamp(1_000, 600_000);
        let mut transaction = self.client.transaction()?;
        let updated = transaction.execute(
            "UPDATE portfolio_run_jobs SET heartbeat_at=$1, lease_expires_at=$2, updated_at=$1 \
             WHERE run_id=$3 AND state='running' AND lease_owner=$4 \
               AND lease_expires_at>$1 AND deadline_at>$1",
            &[&current, &expires, &claim.run_id, &claim.lease_owner],
        )?;
        if updated != 1 {
            transaction.commit()?;
            return Ok((false, false));
        }
        let status: String = transaction
            .query_one(
                "SELECT status FROM portfolio_backtest_runs WHERE run_id=$1",
                &[&claim.run_id],
            )?
            .get(0);
        transaction.commit()?;
        Ok((true, status == "cancel_requested"))
    }

    pub fn complete(
        &mut self,
        claim: &JobClaim,
        input: &WorkerInput,
        output: &WorkerOutput,
    ) -> Result<&'static str> {
        output.validate_for(input)?;
        ensure!(
            input.run_id == claim.run_id,
            "completion claim/input mismatch"
        );
        let (content, checksum, uncompressed_size) = encode_artifact(output)?;
        let summary = serde_json::to_string(output.summary.as_ref().unwrap_or(&Value::Null))?;
        let result = serde_json::to_string(output.result.as_ref().unwrap_or(&Value::Null))?;
        let warnings = serde_json::to_string(&output.warnings)?;
        let current = epoch_ms();
        let artifact_id = Uuid::new_v4().to_string();
        let mut transaction = self.client.transaction()?;
        let row = transaction.query_opt(
            "SELECT job.state, job.lease_owner, job.lease_expires_at, job.deadline_at, run.status AS run_status \
             FROM portfolio_run_jobs job JOIN portfolio_backtest_runs run ON run.run_id=job.run_id \
             WHERE job.run_id=$1 FOR UPDATE OF job, run",
            &[&claim.run_id],
        )?;
        let Some(row) = row else {
            transaction.rollback()?;
            return Ok("lost");
        };
        let state: String = row.get("state");
        let owner: Option<String> = row.get("lease_owner");
        let lease_expires: Option<i64> = row.get("lease_expires_at");
        let deadline: i64 = row.get("deadline_at");
        let run_status: String = row.get("run_status");
        if state != "running"
            || owner.as_deref() != Some(&claim.lease_owner)
            || lease_expires.unwrap_or(0) <= current
            || deadline <= current
        {
            transaction.rollback()?;
            return Ok("lost");
        }
        if run_status == "cancel_requested" {
            cancel_locked(
                &mut transaction,
                &claim.run_id,
                current,
                "worker_observed_cancellation",
            )?;
            transaction.commit()?;
            return Ok("cancelled");
        }
        if run_status != "running" {
            transaction.rollback()?;
            return Ok("lost");
        }
        let inserted = transaction.execute(
            "INSERT INTO portfolio_worker_artifacts (artifact_id, run_id, artifact_role, format, content_encoding, \
                    content, byte_count, uncompressed_byte_count, checksum, schema_version, data_revision, created_at) \
             VALUES ($1,$2,'output',$3,$4,$5,$6,$7,$8,$9,$10,$11) \
             ON CONFLICT(run_id,artifact_role) DO NOTHING",
            &[&artifact_id, &claim.run_id, &ARTIFACT_FORMAT, &ARTIFACT_ENCODING, &content,
              &(content.len() as i64), &(uncompressed_size as i64), &checksum,
              &WORKER_SCHEMA_VERSION, &claim.data_revision, &current],
        )?;
        let result_artifact_id = if inserted == 1 {
            artifact_id
        } else {
            let existing = transaction.query_one(
                "SELECT artifact_id, checksum, data_revision FROM portfolio_worker_artifacts \
                 WHERE run_id=$1 AND artifact_role='output'",
                &[&claim.run_id],
            )?;
            let existing_checksum: String = existing.get("checksum");
            let existing_revision: String = existing.get("data_revision");
            ensure!(
                existing_checksum == checksum && existing_revision == claim.data_revision,
                "immutable worker output artifact conflict"
            );
            existing.get("artifact_id")
        };
        let run_update = transaction.execute(
            "UPDATE portfolio_backtest_runs SET status='completed', progress=1, summary_json=$1, result_json=$2, \
                    warnings_json=$3, error_json=NULL, finished_at=$4, updated_at=$4 \
             WHERE run_id=$5 AND status='running'",
            &[&summary, &result, &warnings, &current, &claim.run_id],
        )?;
        let job_update = transaction.execute(
            "UPDATE portfolio_run_jobs SET state='completed', result_artifact_id=$1, lease_owner=NULL, \
                    lease_expires_at=NULL, heartbeat_at=$2, finished_at=$2, updated_at=$2 \
             WHERE run_id=$3 AND state='running' AND lease_owner=$4 \
               AND lease_expires_at>$2 AND deadline_at>$2",
            &[&result_artifact_id, &current, &claim.run_id, &claim.lease_owner],
        )?;
        ensure!(
            run_update == 1 && job_update == 1,
            "worker completion state transition conflict"
        );
        add_event(
            &mut transaction,
            &claim.run_id,
            "worker_completed",
            &json!({
                "result_artifact_id": result_artifact_id,
                "checksum": checksum,
                "engine": ENGINE_VERSION,
            }),
            current,
        )?;
        transaction.commit()?;
        Ok("completed")
    }

    pub fn fail(
        &mut self,
        claim: &JobClaim,
        error: &Value,
        retryable: bool,
        retry_delay_ms: i64,
    ) -> Result<&'static str> {
        let current = epoch_ms();
        let mut transaction = self.client.transaction()?;
        let row = transaction.query_opt(
            "SELECT job.state, job.lease_owner, job.lease_expires_at, job.deadline_at, \
                    job.attempt_count, job.max_attempts, run.status AS run_status \
             FROM portfolio_run_jobs job JOIN portfolio_backtest_runs run ON run.run_id=job.run_id \
             WHERE job.run_id=$1 FOR UPDATE OF job, run",
            &[&claim.run_id],
        )?;
        let Some(row) = row else {
            transaction.rollback()?;
            return Ok("lost");
        };
        let state: String = row.get("state");
        let owner: Option<String> = row.get("lease_owner");
        let expires: Option<i64> = row.get("lease_expires_at");
        let deadline: i64 = row.get("deadline_at");
        let run_status: String = row.get("run_status");
        if state != "running"
            || owner.as_deref() != Some(&claim.lease_owner)
            || expires.unwrap_or(0) <= current
        {
            transaction.rollback()?;
            return Ok("lost");
        }
        if run_status == "cancel_requested" {
            cancel_locked(
                &mut transaction,
                &claim.run_id,
                current,
                "worker_observed_cancellation",
            )?;
            transaction.commit()?;
            return Ok("cancelled");
        }
        if deadline <= current {
            fail_locked(
                &mut transaction,
                &claim.run_id,
                &json!({
                    "code": "RUN_DEADLINE_EXCEEDED",
                    "message": "Rust worker absolute deadline exceeded",
                    "retryable": false,
                }),
                current,
                "worker_deadline_failed",
            )?;
            transaction.commit()?;
            return Ok("failed");
        }
        let attempts: i32 = row.get("attempt_count");
        let max_attempts: i32 = row.get("max_attempts");
        let error_text = serde_json::to_string(error)?;
        if retryable && attempts < max_attempts {
            transaction.execute(
                "UPDATE portfolio_run_jobs SET state='queued', available_at=$1, lease_owner=NULL, lease_expires_at=NULL, \
                        heartbeat_at=NULL, last_error_json=$2, updated_at=$3 \
                 WHERE run_id=$4 AND state='running' AND lease_owner=$5",
                &[&(current + retry_delay_ms.max(0)), &error_text, &current, &claim.run_id, &claim.lease_owner],
            )?;
            transaction.execute(
                "UPDATE portfolio_backtest_runs SET status='queued', progress=0, completed_candidates=0, \
                        current_validation_window=NULL, error_json=$1, updated_at=$2 \
                 WHERE run_id=$3 AND status='running'",
                &[&error_text, &current, &claim.run_id],
            )?;
            add_event(
                &mut transaction,
                &claim.run_id,
                "worker_requeued",
                &json!({"error": error}),
                current,
            )?;
            transaction.commit()?;
            return Ok("requeued");
        }
        fail_locked(
            &mut transaction,
            &claim.run_id,
            error,
            current,
            "worker_failed",
        )?;
        transaction.commit()?;
        Ok("failed")
    }

    pub fn recover_expired(&mut self, limit: i64) -> Result<(usize, usize, usize)> {
        let current = epoch_ms();
        let safe_limit = limit.clamp(1, 1_000);
        let mut transaction = self.client.transaction()?;
        let rows = transaction.query(
            "SELECT job.run_id, job.state, job.deadline_at, job.attempt_count, job.max_attempts, run.status AS run_status \
             FROM portfolio_run_jobs job JOIN portfolio_backtest_runs run ON run.run_id=job.run_id \
             WHERE (job.state IN ('queued','running') AND job.deadline_at <= $1) \
                OR (job.state='running' AND job.lease_expires_at <= $1) \
             ORDER BY job.updated_at ASC FOR UPDATE OF job, run SKIP LOCKED LIMIT $2",
            &[&current, &safe_limit],
        )?;
        let mut requeued = 0;
        let mut failed = 0;
        let mut cancelled = 0;
        for row in rows {
            let run_id: String = row.get("run_id");
            let status: String = row.get("run_status");
            if status == "cancel_requested" {
                cancel_locked(
                    &mut transaction,
                    &run_id,
                    current,
                    "expired_worker_cancellation",
                )?;
                cancelled += 1;
                continue;
            }
            let deadline_at: i64 = row.get("deadline_at");
            let attempts: i32 = row.get("attempt_count");
            let max_attempts: i32 = row.get("max_attempts");
            match recovery_action(deadline_at, current, attempts, max_attempts) {
                RecoveryAction::DeadlineFailed => {
                    fail_locked(
                        &mut transaction,
                        &run_id,
                        &json!({
                            "code": "RUN_DEADLINE_EXCEEDED",
                            "message": "Rust worker absolute deadline exceeded",
                            "retryable": false,
                        }),
                        current,
                        "expired_deadline_failed",
                    )?;
                    failed += 1;
                }
                RecoveryAction::LeaseRequeued => {
                    transaction.execute(
                        "UPDATE portfolio_run_jobs SET state='queued', available_at=$1, lease_owner=NULL, lease_expires_at=NULL, heartbeat_at=NULL, updated_at=$1 \
                         WHERE run_id=$2 AND state='running'",
                        &[&current, &run_id],
                    )?;
                    transaction.execute(
                        "UPDATE portfolio_backtest_runs SET status='queued', progress=0, updated_at=$1 WHERE run_id=$2 AND status='running'",
                        &[&current, &run_id],
                    )?;
                    add_event(
                        &mut transaction,
                        &run_id,
                        "expired_worker_requeued",
                        &json!({}),
                        current,
                    )?;
                    requeued += 1;
                }
                RecoveryAction::LeaseFailed => {
                    fail_locked(
                        &mut transaction,
                        &run_id,
                        &json!({
                            "code": "WORKER_LEASE_EXPIRED",
                            "message": "Rust worker lease expired",
                            "retryable": true,
                        }),
                        current,
                        "expired_worker_failed",
                    )?;
                    failed += 1;
                }
            }
        }
        transaction.commit()?;
        Ok((requeued, failed, cancelled))
    }
}

fn add_event(
    transaction: &mut Transaction<'_>,
    run_id: &str,
    event_type: &str,
    event: &Value,
    now: i64,
) -> Result<()> {
    transaction.execute(
        "INSERT INTO portfolio_run_events(event_id,run_id,event_type,event_json,created_at) VALUES($1,$2,$3,$4,$5)",
        &[&Uuid::new_v4().to_string(), &run_id, &event_type, &serde_json::to_string(event)?, &now],
    )?;
    Ok(())
}

fn cancel_locked(
    transaction: &mut Transaction<'_>,
    run_id: &str,
    now: i64,
    event_type: &str,
) -> Result<()> {
    transaction.execute(
        "UPDATE portfolio_run_jobs SET state='cancelled', lease_owner=NULL, lease_expires_at=NULL, heartbeat_at=NULL, finished_at=$1, updated_at=$1 \
         WHERE run_id=$2 AND state IN ('queued','running')",
        &[&now, &run_id],
    )?;
    transaction.execute(
        "UPDATE portfolio_backtest_runs SET status='cancelled', summary_json=$1, warnings_json=$2, finished_at=$3, updated_at=$3 \
         WHERE run_id=$4 AND status IN ('queued','running','cancel_requested')",
        &[&"{\"cancelled\":true}", &"[\"사용자 요청으로 실행을 취소했습니다.\"]", &now, &run_id],
    )?;
    add_event(transaction, run_id, event_type, &json!({}), now)
}

fn fail_locked(
    transaction: &mut Transaction<'_>,
    run_id: &str,
    error: &Value,
    now: i64,
    event_type: &str,
) -> Result<()> {
    let error_text = serde_json::to_string(error)?;
    transaction.execute(
        "UPDATE portfolio_run_jobs SET state='failed', lease_owner=NULL, lease_expires_at=NULL, heartbeat_at=NULL, \
                last_error_json=$1, finished_at=$2, updated_at=$2 WHERE run_id=$3 AND state IN ('queued','running')",
        &[&error_text, &now, &run_id],
    )?;
    transaction.execute(
        "UPDATE portfolio_backtest_runs SET status='failed', error_json=$1, warnings_json=$2, finished_at=$3, updated_at=$3 \
         WHERE run_id=$4 AND status IN ('queued','running','cancel_requested')",
        &[&error_text, &"[\"중단 전 저장된 artifact는 보존되었습니다.\"]", &now, &run_id],
    )?;
    add_event(
        transaction,
        run_id,
        event_type,
        &json!({"error": error}),
        now,
    )
}

pub fn worker_error(code: &str, message: &str, retryable: bool) -> Value {
    json!({"code": code, "message": message.chars().take(500).collect::<String>(), "retryable": retryable})
}

pub fn require_database_url() -> Result<String> {
    std::env::var("DATABASE_URL")
        .or_else(|_| std::env::var("WORKER_DATABASE_URL"))
        .or_else(|_| std::env::var("POSTGRES_URL"))
        .or_else(|_| postgres_conninfo_from_parts())
        .context("DATABASE_URL, WORKER_DATABASE_URL, POSTGRES_URL, or complete POSTGRES_* values are required")
}

fn postgres_conninfo_from_parts() -> std::result::Result<String, std::env::VarError> {
    let host = std::env::var("POSTGRES_HOST")?;
    let port = std::env::var("POSTGRES_PORT").unwrap_or_else(|_| "5432".into());
    let user = std::env::var("POSTGRES_USER")?;
    let password = std::env::var("POSTGRES_PASSWORD")?;
    let database = std::env::var("POSTGRES_DATABASE")?;
    let quote = |value: &str| value.replace('\\', "\\\\").replace('\'', "\\'");
    Ok(format!(
        "host='{}' port='{}' user='{}' password='{}' dbname='{}' connect_timeout='{}'",
        quote(&host),
        quote(&port),
        quote(&user),
        quote(&password),
        quote(&database),
        std::env::var("POSTGRES_CONNECT_TIMEOUT_SECONDS").unwrap_or_else(|_| "5".into()),
    ))
}

fn env_flag(name: &str, fallback: bool) -> bool {
    std::env::var(name)
        .ok()
        .map(|value| {
            matches!(
                value.to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on" | "required"
            )
        })
        .unwrap_or(fallback)
}

pub fn require_valid_worker_engine(claim: &JobClaim) -> Result<()> {
    if claim.engine_version != ENGINE_VERSION {
        bail!(
            "claimed unsupported engine version: {}",
            claim.engine_version
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absolute_deadline_is_terminal_even_with_attempts_remaining() {
        assert_eq!(
            recovery_action(1_000, 1_000, 0, 3),
            RecoveryAction::DeadlineFailed
        );
        assert_eq!(
            recovery_action(999, 1_000, 1, 3),
            RecoveryAction::DeadlineFailed
        );
    }

    #[test]
    fn only_unexpired_lease_failures_are_requeued() {
        assert_eq!(
            recovery_action(2_000, 1_000, 1, 3),
            RecoveryAction::LeaseRequeued
        );
        assert_eq!(
            recovery_action(2_000, 1_000, 3, 3),
            RecoveryAction::LeaseFailed
        );
    }
}
