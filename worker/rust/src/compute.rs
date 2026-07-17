use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, bail};
use serde_json::{Map, Value, json};

use crate::backtest;
use crate::contracts::{JobKind, OutputArtifact, WorkerInput, WorkerOutput};
use crate::control::{ComputeControl, checkpoint};
use crate::date::civil_from_days;
use crate::model::BacktestSimulationInput;

fn iso_now() -> String {
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let seconds = elapsed.as_secs();
    let days = (seconds / 86_400) as i64;
    let remaining = seconds % 86_400;
    format!(
        "{}T{:02}:{:02}:{:02}.{:03}Z",
        civil_from_days(days),
        remaining / 3_600,
        (remaining % 3_600) / 60,
        remaining % 60,
        elapsed.subsec_millis(),
    )
}

fn array_artifact(artifact_type: &str, content: Value) -> OutputArtifact {
    let row_count = content.as_array().map(Vec::len).or(Some(1));
    OutputArtifact {
        artifact_type: artifact_type.into(),
        content,
        row_count,
    }
}

fn backtest_artifacts(result: &Value) -> Vec<OutputArtifact> {
    let points = result.get("points").cloned().unwrap_or_else(|| json!([]));
    let drawdown = points
        .as_array()
        .map(|values| {
            values.iter().map(|point| json!({
        "date": point.get("date").cloned().unwrap_or(Value::Null),
        "drawdownPercent": point.get("drawdownPercent").cloned().unwrap_or(Value::Null),
    })).collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let final_balance = result
        .pointer("/metrics/finalBalance")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    let end_date = result.get("endDate").cloned().unwrap_or(Value::Null);
    let holdings = result
        .get("contributions")
        .and_then(Value::as_array)
        .map(|values| {
            values.iter().map(|item| {
        let ending_value = item.get("endingValue").and_then(Value::as_f64).unwrap_or(0.0);
        json!({
            "date": end_date,
            "symbol": item.get("symbol").cloned().unwrap_or(Value::Null),
            "name": item.get("name").cloned().unwrap_or(Value::Null),
            "currency": item.get("currency").cloned().unwrap_or(Value::Null),
            "ending_value": ending_value,
            "ending_weight": if final_balance > 0.0 { ending_value / final_balance } else { 0.0 },
        })
    }).collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let cash_ledger = points
        .as_array()
        .map(|values| {
            values.iter().map(|point| json!({
        "date": point.get("date").cloned().unwrap_or(Value::Null),
        "balance": point.get("balance").cloned().unwrap_or(Value::Null),
        "investedBalance": point.get("investedBalance").cloned().unwrap_or(Value::Null),
        "cashBalance": point.get("cashBalance").cloned().unwrap_or(Value::Null),
        "unitPrice": point.get("unitPrice").cloned().unwrap_or(Value::Null),
    })).collect::<Vec<_>>()
        })
        .unwrap_or_default();
    vec![
        array_artifact("equity", points),
        array_artifact("drawdown", json!(drawdown)),
        array_artifact("holdings", json!(holdings)),
        array_artifact(
            "trades",
            result.get("trades").cloned().unwrap_or_else(|| json!([])),
        ),
        array_artifact("cash-ledger", json!(cash_ledger)),
        array_artifact(
            "cash-flows",
            result
                .get("cashFlows")
                .cloned()
                .unwrap_or_else(|| json!([])),
        ),
        array_artifact(
            "rolling",
            result
                .pointer("/advanced/rolling")
                .cloned()
                .unwrap_or_else(|| json!([])),
        ),
        array_artifact(
            "correlation",
            result
                .get("correlations")
                .cloned()
                .unwrap_or_else(|| json!({})),
        ),
        array_artifact(
            "risk-contribution",
            result
                .pointer("/advanced/riskContributions")
                .cloned()
                .unwrap_or_else(|| json!([])),
        ),
        array_artifact(
            "monthly-returns",
            result
                .pointer("/advanced/monthlyReturns")
                .cloned()
                .unwrap_or_else(|| json!([])),
        ),
    ]
}

fn finalize_backtest(
    simulation: Value,
    context: Option<&Map<String, Value>>,
) -> (Value, Vec<String>) {
    let Some(context) = context else {
        return (simulation, vec![]);
    };
    let mut warnings = context
        .get("warnings")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let effective_start = simulation
        .get("effectiveStartDate")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let requested = context
        .get("effective_requested_start")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !requested.is_empty() && effective_start > requested {
        warnings.insert(
            0,
            format!(
                "모든 종목과 비교 지수의 공통 일봉이 시작되는 {effective_start}부터 계산했습니다."
            ),
        );
    }
    let mut result = Map::new();
    result.insert("generatedAt".into(), json!(iso_now()));
    result.insert("baseCurrency".into(), json!("KRW"));
    result.insert(
        "currencyMethod".into(),
        context
            .get("currency_method")
            .cloned()
            .unwrap_or_else(|| json!("historical_fx")),
    );
    let mut config = context
        .get("config")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    config.insert("effectiveStartDate".into(), json!(effective_start));
    config.insert(
        "effectiveEndDate".into(),
        simulation.get("endDate").cloned().unwrap_or(Value::Null),
    );
    result.insert("config".into(), Value::Object(config));
    result.insert(
        "assets".into(),
        context.get("assets").cloned().unwrap_or_else(|| json!([])),
    );
    if let Some(benchmark) = context.get("benchmark").filter(|value| !value.is_null()) {
        result.insert("benchmark".into(), benchmark.clone());
    }
    result.insert("warnings".into(), json!(warnings));
    if let Value::Object(simulation) = simulation {
        result.extend(simulation);
    }
    (Value::Object(result), warnings)
}

fn compute_backtest(
    input: &WorkerInput,
    include_artifacts: bool,
    control: Option<&dyn ComputeControl>,
) -> Result<WorkerOutput> {
    let simulation_value = input
        .payload
        .get("simulation")
        .context("backtest payload.simulation must be an object")?;
    let simulation_input: BacktestSimulationInput =
        serde_json::from_value(simulation_value.clone())
            .context("invalid backtest simulation input")?;
    let simulation =
        serde_json::to_value(backtest::simulate_with_control(&simulation_input, control)?)?;
    checkpoint(control)?;
    let context = input
        .payload
        .get("response_context")
        .and_then(Value::as_object);
    let (result, warnings) = finalize_backtest(simulation, context);
    let summary = result.get("metrics").cloned().unwrap_or(Value::Null);
    let artifacts = if include_artifacts {
        backtest_artifacts(&result)
    } else {
        vec![]
    };
    WorkerOutput::completed(input, summary, result, warnings, artifacts)
}

fn compute_optimization(
    input: &WorkerInput,
    include_artifacts: bool,
    control: Option<&dyn ComputeControl>,
) -> Result<WorkerOutput> {
    let optimization_input = input.payload.get("optimization").unwrap_or(&input.payload);
    let output = crate::optimization::optimize_with_control(optimization_input, control)?;
    checkpoint(control)?;
    let objective = input
        .payload
        .get("objective")
        .and_then(Value::as_str)
        .unwrap_or("robust_score");
    let best = output
        .pointer(&format!("/bestByObjective/{objective}"))
        .cloned()
        .unwrap_or(Value::Null);
    if !output
        .get("bestByObjective")
        .and_then(Value::as_object)
        .is_some_and(|value| value.contains_key(objective))
    {
        bail!("optimization objective is invalid: {objective}");
    }
    let mut warnings = input
        .payload
        .get("market_warnings")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    warnings.extend(
        output
            .get("warnings")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_owned),
    );
    let candidates = output
        .get("candidates")
        .cloned()
        .unwrap_or_else(|| json!([]));
    let frontier = output
        .get("paretoFrontier")
        .cloned()
        .unwrap_or_else(|| json!([]));
    let mut result = output.clone();
    if let Some(object) = result.as_object_mut() {
        if let Some(values) = object.get_mut("candidates").and_then(Value::as_array_mut) {
            values.truncate(20);
        }
        if let Some(values) = object
            .get_mut("paretoFrontier")
            .and_then(Value::as_array_mut)
        {
            values.truncate(100);
        }
    }
    let summary = json!({
        "best": best,
        "candidate_count": output.get("candidateCount").cloned().unwrap_or_else(|| json!(0)),
        "pareto_count": frontier.as_array().map(Vec::len).unwrap_or(0),
    });
    WorkerOutput::completed(
        input,
        summary,
        result,
        warnings,
        if include_artifacts {
            vec![
                array_artifact("candidates", candidates),
                array_artifact("worker-pareto-frontier", frontier),
            ]
        } else {
            vec![]
        },
    )
}

fn compute_monte_carlo(
    input: &WorkerInput,
    include_artifacts: bool,
    control: Option<&dyn ComputeControl>,
) -> Result<WorkerOutput> {
    let request = input.payload.get("monte_carlo").unwrap_or(&input.payload);
    let result = crate::monte_carlo::simulate_with_control(request, control)?;
    checkpoint(control)?;
    let mut warnings = input
        .payload
        .get("market_warnings")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    warnings.extend(
        result
            .get("warnings")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_owned),
    );
    let summary = json!({
        "distributions": result.get("distributions").cloned().unwrap_or(Value::Null),
        "probabilities": result.get("probabilities").cloned().unwrap_or(Value::Null),
        "path_count": result.get("pathCount").cloned().unwrap_or_else(|| json!(0)),
    });
    WorkerOutput::completed(
        input,
        summary,
        result.clone(),
        warnings,
        if include_artifacts {
            vec![
                array_artifact(
                    "monte-carlo-distribution",
                    result.get("distributions").cloned().unwrap_or(Value::Null),
                ),
                array_artifact(
                    "monte-carlo-percentile-paths",
                    result
                        .get("percentilePaths")
                        .cloned()
                        .unwrap_or_else(|| json!([])),
                ),
                array_artifact(
                    "monte-carlo-sample-paths",
                    result
                        .get("samplePaths")
                        .cloned()
                        .unwrap_or_else(|| json!([])),
                ),
            ]
        } else {
            vec![]
        },
    )
}

fn compute_batch(
    input: &WorkerInput,
    include_artifacts: bool,
    control: Option<&dyn ComputeControl>,
) -> Result<WorkerOutput> {
    let result = crate::batch::compute_with_control(input.job_kind, &input.payload, control)?;
    checkpoint(control)?;
    let warnings = result
        .get("warnings")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    let summary = result.get("summary").cloned().unwrap_or_else(|| json!({
        "scenario_count": result.get("scenarios").and_then(Value::as_array).map(Vec::len).unwrap_or(0),
        "fold_count": result.get("folds").and_then(Value::as_array).map(Vec::len).unwrap_or(0),
    }));
    let artifact_type = if input.job_kind == JobKind::WalkForward {
        "walk-forward"
    } else {
        "scenario-comparison"
    };
    WorkerOutput::completed(
        input,
        summary,
        result.clone(),
        warnings,
        if include_artifacts {
            vec![array_artifact(artifact_type, result)]
        } else {
            vec![]
        },
    )
}

pub fn compute(input: &WorkerInput) -> Result<WorkerOutput> {
    compute_with_artifacts(input, true)
}

pub fn compute_with_artifacts(
    input: &WorkerInput,
    include_artifacts: bool,
) -> Result<WorkerOutput> {
    compute_with_control(input, include_artifacts, None)
}

pub fn compute_with_control(
    input: &WorkerInput,
    include_artifacts: bool,
    control: Option<&dyn ComputeControl>,
) -> Result<WorkerOutput> {
    input.validate()?;
    checkpoint(control)?;
    let output = match input.job_kind {
        JobKind::Backtest => compute_backtest(input, include_artifacts, control),
        JobKind::Optimization => compute_optimization(input, include_artifacts, control),
        JobKind::MonteCarlo => compute_monte_carlo(input, include_artifacts, control),
        JobKind::WalkForward
        | JobKind::StressTest
        | JobKind::WeightSensitivity
        | JobKind::StartDateSensitivity
        | JobKind::RebalanceSensitivity
        | JobKind::CashFlowSensitivity => compute_batch(input, include_artifacts, control),
    }?;
    checkpoint(control)?;
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timestamp_is_rfc3339_utc() {
        let value = iso_now();
        assert_eq!(value.len(), 24);
        assert!(value.ends_with('Z'));
        assert_eq!(&value[4..5], "-");
    }
}
