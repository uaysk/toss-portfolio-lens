use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet, HashSet};

use anyhow::{Context, Result, bail};
use serde_json::{Value, json};

use crate::backtest;
use crate::control::{ComputeControl, checkpoint};
use crate::model::BacktestSimulationInput;

use super::{OptimizerV2Config, candidate_signature, robust_score_detail};

pub(super) fn template_asset_index(template: &BacktestSimulationInput, id: &str) -> Result<usize> {
    let exact = template
        .assets
        .iter()
        .enumerate()
        .filter(|(_, asset)| {
            asset.symbol == id
                || format!("{}:{}", asset.market, asset.symbol) == id
                || format!("{}:{}", asset.currency, asset.symbol) == id
        })
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    match exact.as_slice() {
        [index] => Ok(*index),
        [] => bail!("ledger template does not contain candidate asset {id}"),
        _ => bail!("ledger template asset id {id} is ambiguous"),
    }
}

pub(super) fn ledger_input_for_candidate(
    template: &Value,
    candidate: &Value,
) -> Result<BacktestSimulationInput> {
    let mut input: BacktestSimulationInput = serde_json::from_value(template.clone())
        .context("invalid ledgerTemplate backtest simulation input")?;
    let weights = candidate
        .get("weights")
        .and_then(Value::as_object)
        .context("candidate weights are missing")?;
    for asset in &mut input.assets {
        asset.weight = 0.0;
    }
    let mut assigned = 0.0;
    let mut used = BTreeSet::new();
    let mut mapped = Vec::new();
    for (id, weight) in weights {
        let weight = weight
            .as_f64()
            .filter(|value| value.is_finite() && *value >= 0.0)
            .context("candidate weight is invalid")?;
        if weight <= 1e-14 {
            continue;
        }
        let index = template_asset_index(&input, id)?;
        if !used.insert(index) {
            bail!("multiple candidate ids map to the same ledger asset");
        }
        mapped.push((index, weight));
        assigned += weight;
    }
    if assigned <= 0.0 || assigned > 1.0 + 1e-8 {
        bail!("candidate weights cannot be applied to ledger template");
    }
    let configured_cash = (input.execution.cash_target_percent / 100.0).clamp(0.0, 0.99);
    let cash_weight = if configured_cash > 0.0 {
        configured_cash
    } else {
        (1.0 - assigned).max(0.0)
    };
    let invested_weight = 1.0 - cash_weight;
    for (index, weight) in mapped {
        input.assets[index].weight = weight / assigned * invested_weight * 100.0;
    }
    input.execution.cash_target_percent = cash_weight * 100.0;
    Ok(input)
}

pub(super) fn ledger_metrics(
    result: &crate::model::BacktestSimulationResult,
    robust_weights: &BTreeMap<String, f64>,
) -> (Value, Value) {
    let comparable = &result.metrics.comparable;
    let cagr = comparable.cagr_percent.map(|value| value / 100.0);
    let total_return = Some(comparable.total_return_percent / 100.0);
    let volatility = comparable
        .annualized_volatility_percent
        .map(|value| value / 100.0);
    let max_drawdown = Some(comparable.max_drawdown_percent / 100.0);
    let cvar = result
        .advanced
        .pointer("/tailRisk/expectedShortfall95Percent")
        .and_then(Value::as_f64)
        .map(|value| value / 100.0);
    let information_ratio = result
        .advanced
        .pointer("/benchmarkComparison/informationRatio")
        .and_then(Value::as_f64);
    let turnover = result
        .advanced
        .pointer("/costEfficiency/turnoverPercent")
        .and_then(Value::as_f64)
        .map(|value| value / 100.0);
    let transaction_cost = (result.metrics.total_transaction_costs
        / result.metrics.total_contributions.max(1.0))
    .max(0.0);
    let values = [
        ("sharpe", "in_sample", comparable.sharpe_ratio),
        ("sortino", "in_sample", comparable.sortino_ratio),
        ("calmar", "in_sample", comparable.calmar_ratio),
        ("volatility", "in_sample", volatility),
        ("cvar", "in_sample", cvar),
        ("informationRatio", "in_sample", information_ratio),
        ("oosAverageSharpe", "oos", None),
        ("oosWorstSharpe", "oos", None),
        ("oosAverageCvar", "oos", None),
    ];
    let (robust_score, detail) = robust_score_detail(robust_weights, &values, 0.0);
    (
        json!({
            "cagr": cagr,
            "totalReturn": total_return,
            "return": cagr,
            "sharpe": comparable.sharpe_ratio,
            "sortino": comparable.sortino_ratio,
            "calmar": comparable.calmar_ratio,
            "volatility": volatility,
            "maxDrawdown": max_drawdown,
            "cvar": cvar,
            "informationRatio": information_ratio,
            "turnover": turnover,
            "transactionCost": transaction_cost,
            "robustScore": robust_score,
            "inSampleRobustScore": detail.get("inSampleScore").cloned().unwrap_or(Value::Null),
            "oosRobustScore": detail.get("outOfSampleScore").cloned().unwrap_or(Value::Null),
            "finalBalance": result.metrics.final_balance,
            "totalTransactionCosts": result.metrics.total_transaction_costs,
            "tradeCount": result.trades.len(),
            "period": {
                "from": result.effective_start_date,
                "to": result.end_date,
                "observationCount": result.points.len().saturating_sub(1),
                "role": "ledger_full",
            },
        }),
        detail,
    )
}

fn metric_delta(screening: &Value, ledger: &Value) -> Value {
    let keys = [
        "cagr",
        "totalReturn",
        "return",
        "sharpe",
        "sortino",
        "calmar",
        "volatility",
        "maxDrawdown",
        "cvar",
        "informationRatio",
        "turnover",
        "transactionCost",
        "robustScore",
    ];
    Value::Object(
        keys.into_iter()
            .map(|key| {
                let delta = screening
                    .get(key)
                    .and_then(Value::as_f64)
                    .zip(ledger.get(key).and_then(Value::as_f64))
                    .map(|(screening, ledger)| ledger - screening);
                (
                    key.to_owned(),
                    delta.map_or(Value::Null, |value| json!(value)),
                )
            })
            .collect(),
    )
}

pub(super) fn validate_with_ledger(
    candidates: &mut [Value],
    frontier_signatures: &HashSet<String>,
    config: &OptimizerV2Config,
    control: Option<&dyn ComputeControl>,
) -> Result<(Vec<Value>, usize, usize)> {
    for (index, candidate) in candidates.iter_mut().enumerate() {
        let screening_metrics = candidate.get("metrics").cloned().unwrap_or(Value::Null);
        if let Some(object) = candidate.as_object_mut() {
            object.insert("screeningRank".to_owned(), json!(index + 1));
            object.insert("screeningMetrics".to_owned(), screening_metrics);
            object.insert(
                "ledgerValidationStatus".to_owned(),
                json!(if config.ledger_template.is_some() {
                    "not_selected"
                } else {
                    "not_requested"
                }),
            );
        }
    }
    let Some(template) = config.ledger_template.as_ref() else {
        return Ok((Vec::new(), 0, 0));
    };

    let mut selected = candidates
        .iter()
        .enumerate()
        .filter(|(_, candidate)| frontier_signatures.contains(&candidate_signature(candidate)))
        .map(|(index, _)| index)
        .take(config.ledger_validation_budget)
        .collect::<Vec<_>>();
    for index in 0..candidates.len() {
        if selected.len() >= config.ledger_validation_budget {
            break;
        }
        if !selected.contains(&index) {
            selected.push(index);
        }
    }
    selected.sort_unstable();

    let mut successful = Vec::<usize>::new();
    let mut failed = 0usize;
    for (position, index) in selected.iter().copied().enumerate() {
        if position.is_multiple_of(4) {
            checkpoint(control)?;
        }
        let result = ledger_input_for_candidate(template, &candidates[index]).and_then(|input| {
            backtest::simulate_with_control(&input, control)
                .context("ledger validation backtest failed")
        });
        match result {
            Ok(result) => {
                let screening_metrics = candidates[index]
                    .get("screeningMetrics")
                    .cloned()
                    .unwrap_or(Value::Null);
                let (ledger_metrics, robust_detail) =
                    ledger_metrics(&result, &config.robust_weights);
                let delta = metric_delta(&screening_metrics, &ledger_metrics);
                if let Some(object) = candidates[index].as_object_mut() {
                    object.insert("ledgerValidationStatus".to_owned(), json!("completed"));
                    object.insert("ledgerMetrics".to_owned(), ledger_metrics);
                    object.insert("ledgerRobustScoreDetail".to_owned(), robust_detail);
                    object.insert("metricDelta".to_owned(), delta);
                    object.insert(
                        "ledgerDataQuality".to_owned(),
                        serde_json::to_value(&result.data_quality)?,
                    );
                }
                successful.push(index);
            }
            Err(error) => {
                failed += 1;
                if let Some(object) = candidates[index].as_object_mut() {
                    object.insert("ledgerValidationStatus".to_owned(), json!("failed"));
                    object.insert("validationError".to_owned(), json!(error.to_string()));
                }
            }
        }
    }
    successful.sort_by(|left, right| {
        let score = |index: usize| {
            candidates[index]
                .pointer("/ledgerMetrics/robustScore")
                .and_then(Value::as_f64)
        };
        match (score(*left), score(*right)) {
            (Some(left), Some(right)) => right.total_cmp(&left),
            (Some(_), None) => Ordering::Less,
            (None, Some(_)) => Ordering::Greater,
            (None, None) => left.cmp(right),
        }
    });
    for (rank, index) in successful.iter().copied().enumerate() {
        let screening_rank = candidates[index]
            .get("screeningRank")
            .and_then(Value::as_u64)
            .unwrap_or((index + 1) as u64);
        if let Some(object) = candidates[index].as_object_mut() {
            object.insert("ledgerRank".to_owned(), json!(rank + 1));
            object.insert(
                "rankChange".to_owned(),
                json!(screening_rank as i64 - (rank + 1) as i64),
            );
        }
    }
    Ok((
        successful
            .into_iter()
            .map(|index| candidates[index].clone())
            .collect(),
        selected.len(),
        failed,
    ))
}
