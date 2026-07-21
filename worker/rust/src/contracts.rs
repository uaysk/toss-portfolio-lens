use std::io::{Read, Write};

use anyhow::{Context, Result, bail, ensure};
use flate2::{Compression, GzBuilder, read::GzDecoder};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::{ENGINE_VERSION, WORKER_SCHEMA_VERSION};

pub const ARTIFACT_FORMAT: &str = "application/json";
pub const ARTIFACT_ENCODING: &str = "gzip";
pub const MAX_ARTIFACT_BYTES: usize = 128 * 1024 * 1024;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum JobKind {
    Backtest,
    Optimization,
    WalkForward,
    StressTest,
    WeightSensitivity,
    StartDateSensitivity,
    RebalanceSensitivity,
    CashFlowSensitivity,
    MonteCarlo,
    Outlook,
    TechnicalAnalysis,
    TechnicalStrategy,
    ScalpingAnalysis,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkerInput {
    pub schema_version: String,
    pub engine_version: String,
    pub run_id: String,
    pub job_kind: JobKind,
    pub data_revision: String,
    pub request_hash: String,
    pub payload: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutputArtifact {
    #[serde(rename = "type")]
    pub artifact_type: String,
    pub content: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub row_count: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkerOutput {
    pub schema_version: String,
    pub engine_version: String,
    pub run_id: String,
    pub job_kind: JobKind,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<Value>,
    pub warnings: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artifacts: Option<Vec<OutputArtifact>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data_revision: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload_hash: Option<String>,
}

impl WorkerInput {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            self.schema_version == WORKER_SCHEMA_VERSION,
            "unsupported worker schema version: {}",
            self.schema_version
        );
        ensure!(
            self.engine_version == ENGINE_VERSION,
            "unsupported engine version: {}",
            self.engine_version
        );
        ensure!(
            !self.run_id.is_empty() && self.run_id.len() <= 64,
            "invalid run_id"
        );
        ensure!(
            !self.data_revision.is_empty() && self.data_revision.len() <= 128,
            "invalid data_revision"
        );
        ensure!(is_sha256(&self.request_hash), "invalid request_hash");
        ensure!(self.payload.is_object(), "payload must be an object");
        ensure_finite_json(&self.payload, "$.payload")
    }

    pub fn payload_hash(&self) -> Result<String> {
        checksum_json(&self.payload)
    }
}

impl WorkerOutput {
    pub fn completed(
        input: &WorkerInput,
        summary: Value,
        result: Value,
        warnings: Vec<String>,
        artifacts: Vec<OutputArtifact>,
    ) -> Result<Self> {
        let mut deduplicated = Vec::new();
        for warning in warnings {
            if !deduplicated.contains(&warning) {
                deduplicated.push(warning);
            }
        }
        Ok(Self {
            schema_version: WORKER_SCHEMA_VERSION.into(),
            engine_version: ENGINE_VERSION.into(),
            run_id: input.run_id.clone(),
            job_kind: input.job_kind,
            status: "completed".into(),
            summary: Some(summary),
            result: Some(result),
            error: None,
            warnings: deduplicated,
            artifacts: Some(artifacts),
            data_revision: Some(input.data_revision.clone()),
            request_hash: Some(input.request_hash.clone()),
            payload_hash: Some(input.payload_hash()?),
        })
    }

    pub fn validate_for(&self, input: &WorkerInput) -> Result<()> {
        ensure!(
            self.schema_version == input.schema_version,
            "output schema identity mismatch"
        );
        ensure!(
            self.engine_version == input.engine_version,
            "output engine identity mismatch"
        );
        ensure!(self.run_id == input.run_id, "output run identity mismatch");
        ensure!(
            self.job_kind == input.job_kind,
            "output job identity mismatch"
        );
        ensure!(
            self.status == "completed",
            "worker completion output must be completed"
        );
        ensure!(
            self.data_revision.as_deref() == Some(input.data_revision.as_str()),
            "output data revision mismatch"
        );
        ensure!(
            self.request_hash.as_deref() == Some(input.request_hash.as_str()),
            "output request hash mismatch"
        );
        ensure!(
            self.payload_hash.as_deref() == Some(input.payload_hash()?.as_str()),
            "output payload hash mismatch"
        );
        ensure_finite_json(&serde_json::to_value(self)?, "$")
    }
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn ensure_finite_json(value: &Value, path: &str) -> Result<()> {
    match value {
        Value::Null | Value::Bool(_) | Value::String(_) => Ok(()),
        Value::Number(number) => {
            let numeric = number
                .as_f64()
                .context("JSON number is outside f64 range")?;
            ensure!(numeric.is_finite(), "non-finite number at {path}");
            Ok(())
        }
        Value::Array(values) => {
            for (index, item) in values.iter().enumerate() {
                ensure_finite_json(item, &format!("{path}[{index}]"))?;
            }
            Ok(())
        }
        Value::Object(values) => {
            for (key, item) in values {
                ensure_finite_json(item, &format!("{path}.{key}"))?;
            }
            Ok(())
        }
    }
}

pub fn canonical_json(value: &impl Serialize) -> Result<Vec<u8>> {
    let parsed = serde_json::to_value(value)?;
    ensure_finite_json(&parsed, "$")?;
    Ok(serde_json::to_vec(&parsed)?)
}

pub fn checksum_json(value: &impl Serialize) -> Result<String> {
    let source = canonical_json(value)?;
    Ok(hex::encode(Sha256::digest(source)))
}

pub fn encode_artifact(value: &impl Serialize) -> Result<(Vec<u8>, String, usize)> {
    let source = canonical_json(value)?;
    ensure!(
        source.len() <= MAX_ARTIFACT_BYTES,
        "worker artifact exceeds 128 MiB before compression"
    );
    let checksum = hex::encode(Sha256::digest(&source));
    let mut encoder = GzBuilder::new()
        .mtime(0)
        .write(Vec::new(), Compression::new(6));
    encoder.write_all(&source)?;
    let compressed = encoder.finish()?;
    ensure!(
        compressed.len() <= MAX_ARTIFACT_BYTES,
        "worker artifact exceeds 128 MiB after compression"
    );
    Ok((compressed, checksum, source.len()))
}

pub fn decode_input(
    content: &[u8],
    expected_checksum: &str,
    expected_uncompressed_size: usize,
) -> Result<WorkerInput> {
    ensure!(
        content.len() <= MAX_ARTIFACT_BYTES,
        "compressed worker input exceeds 128 MiB"
    );
    ensure!(
        expected_uncompressed_size <= MAX_ARTIFACT_BYTES,
        "worker input metadata exceeds 128 MiB"
    );
    let decoder = GzDecoder::new(content);
    let mut limited = decoder.take((MAX_ARTIFACT_BYTES + 1) as u64);
    let mut source = Vec::with_capacity(expected_uncompressed_size);
    limited
        .read_to_end(&mut source)
        .context("worker input gzip decode failed")?;
    ensure!(
        source.len() <= MAX_ARTIFACT_BYTES,
        "worker input exceeds 128 MiB after decompression"
    );
    ensure!(
        source.len() == expected_uncompressed_size,
        "worker input uncompressed size metadata mismatch"
    );
    let checksum = hex::encode(Sha256::digest(&source));
    ensure!(
        constant_time_equal(checksum.as_bytes(), expected_checksum.as_bytes()),
        "worker input artifact checksum mismatch"
    );
    let input: WorkerInput =
        serde_json::from_slice(&source).context("worker input JSON decode failed")?;
    input.validate()?;
    Ok(input)
}

fn constant_time_equal(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut difference = 0_u8;
    for (left, right) in left.iter().zip(right) {
        difference |= left ^ right;
    }
    difference == 0
}

pub fn parse_request(source: &[u8]) -> Result<WorkerInput> {
    let input: WorkerInput =
        serde_json::from_slice(source).context("worker request JSON decode failed")?;
    input.validate()?;
    Ok(input)
}

pub fn parse_raw_job(kind: JobKind, payload: Value) -> Result<WorkerInput> {
    ensure!(payload.is_object(), "raw compute payload must be an object");
    let request_hash = checksum_json(&payload)?;
    let input = WorkerInput {
        schema_version: WORKER_SCHEMA_VERSION.into(),
        engine_version: ENGINE_VERSION.into(),
        run_id: "direct".into(),
        job_kind: kind,
        data_revision: "direct".into(),
        request_hash,
        payload,
    };
    input.validate()?;
    Ok(input)
}

pub fn job_kind(value: &str) -> Result<JobKind> {
    match value {
        "backtest" => Ok(JobKind::Backtest),
        "optimization" => Ok(JobKind::Optimization),
        "walk_forward" => Ok(JobKind::WalkForward),
        "stress_test" => Ok(JobKind::StressTest),
        "weight_sensitivity" => Ok(JobKind::WeightSensitivity),
        "start_date_sensitivity" => Ok(JobKind::StartDateSensitivity),
        "rebalance_sensitivity" => Ok(JobKind::RebalanceSensitivity),
        "cash_flow_sensitivity" => Ok(JobKind::CashFlowSensitivity),
        "monte_carlo" => Ok(JobKind::MonteCarlo),
        "outlook" => Ok(JobKind::Outlook),
        "technical_analysis" => Ok(JobKind::TechnicalAnalysis),
        "technical_strategy" => Ok(JobKind::TechnicalStrategy),
        "scalping_analysis" => Ok(JobKind::ScalpingAnalysis),
        _ => bail!("unsupported job kind: {value}"),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn artifact_round_trip_is_deterministic() {
        let input =
            parse_raw_job(JobKind::Backtest, json!({"simulation": {"b": 2, "a": 1}})).unwrap();
        let (first, checksum, uncompressed_size) = encode_artifact(&input).unwrap();
        let (second, second_checksum, _) = encode_artifact(&input).unwrap();
        assert_eq!(first, second);
        assert_eq!(checksum, second_checksum);
        let decoded = decode_input(&first, &checksum, uncompressed_size).unwrap();
        assert_eq!(decoded.request_hash, input.request_hash);
        assert!(decode_input(&first, &checksum, uncompressed_size + 1).is_err());
    }

    #[test]
    fn outlook_job_kind_round_trips_as_snake_case() {
        assert_eq!(job_kind("outlook").unwrap(), JobKind::Outlook);
        assert_eq!(serde_json::to_value(JobKind::Outlook).unwrap(), "outlook");
    }

    #[test]
    fn technical_analysis_job_kind_round_trips_as_snake_case() {
        assert_eq!(
            job_kind("technical_analysis").unwrap(),
            JobKind::TechnicalAnalysis
        );
        assert_eq!(
            serde_json::to_value(JobKind::TechnicalAnalysis).unwrap(),
            "technical_analysis"
        );
    }

    #[test]
    fn technical_strategy_job_kind_round_trips_as_snake_case() {
        assert_eq!(
            job_kind("technical_strategy").unwrap(),
            JobKind::TechnicalStrategy
        );
        assert_eq!(
            serde_json::to_value(JobKind::TechnicalStrategy).unwrap(),
            "technical_strategy"
        );
    }

    #[test]
    fn scalping_analysis_job_kind_round_trips_as_snake_case() {
        assert_eq!(
            job_kind("scalping_analysis").unwrap(),
            JobKind::ScalpingAnalysis
        );
        assert_eq!(
            serde_json::to_value(JobKind::ScalpingAnalysis).unwrap(),
            "scalping_analysis"
        );
    }
}
