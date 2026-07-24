use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet, HashSet};

use anyhow::{Context, Result, bail};
use rayon::prelude::*;
use serde_json::{Map, Value, json};

use crate::control::{ComputeControl, checkpoint};
#[cfg(test)]
use crate::portfolio_math;
use crate::portfolio_math::{
    CovarianceEstimator, covariance_matrix, mean_returns, portfolio_variance,
};

mod algorithms;
mod baseline;
mod config;
mod constraints;
mod frame;
mod input;
mod ledger;
mod pareto;
mod regime_policy;
mod rng;

use algorithms::advanced_candidates;
#[cfg(test)]
use algorithms::{
    cma_es_candidates, differential_evolution_candidates, training_objective_fitness,
};
use baseline::baseline_candidates;
#[cfg(test)]
use baseline::{
    covariance_submatrix, herc_cluster_covariance, herc_partition,
    hierarchical_equal_risk_contribution,
};
#[cfg(test)]
use config::{default_robust_weights, parse_asset_groups, parse_group_constraints};
use config::{parse_regime_policy_config, parse_v2_config};
use constraints::{
    candidate_weights, group_constraints_valid, normalize_constraints, repair_dense_weights,
};
pub use frame::build_walk_forward_windows;
use frame::{aligned_frame, sanitize_points, training_frame, walk_forward_config};
use input::{decimal, numeric, positive_int};
#[cfg(test)]
use ledger::ledger_input_for_candidate;
use ledger::validate_with_ledger;
pub use pareto::pareto;
use pareto::pareto_with_control;
#[cfg(test)]
use pareto::{ParetoPoint, typed_dominates};
use regime_policy::run_regime_policy_search;
use rng::Mulberry32;

const DEFAULT_SEED: u64 = 0xC0FFEE;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const DEFAULT_BATCH_SIZE: usize = 512;
const DEFAULT_LEDGER_VALIDATION_BUDGET: usize = 32;
const BASELINE_NAMES: [&str; 7] = [
    "equal_weight",
    "current_weight",
    "inverse_volatility",
    "minimum_variance",
    "risk_parity",
    "hrp",
    "herc",
];
const OBJECTIVES: [&str; 9] = [
    "max_cagr",
    "max_total_return",
    "max_sharpe",
    "max_sortino",
    "max_calmar",
    "min_volatility",
    "min_cvar",
    "max_information_ratio",
    "robust_score",
];

#[derive(Debug, Clone)]
struct Constraints {
    min_weight: f64,
    max_weight: f64,
    required_assets: Vec<String>,
    excluded_assets: Vec<String>,
    max_assets: usize,
    min_weights: BTreeMap<String, f64>,
    max_weights: BTreeMap<String, f64>,
    max_drawdown: f64,
    target_return: f64,
    max_turnover: f64,
    current_weights: BTreeMap<String, f64>,
}

#[derive(Debug, Clone)]
struct GroupConstraint {
    dimension: String,
    group: String,
    min_weight: f64,
    max_weight: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Algorithm {
    RandomSearch,
    DifferentialEvolution,
    CmaEs,
    NsgaIi,
    DirectCvar,
}

impl Algorithm {
    fn parse(value: Option<&Value>) -> Result<Self> {
        match value.and_then(Value::as_str).unwrap_or("random_search") {
            "random_search" => Ok(Self::RandomSearch),
            "differential_evolution" => Ok(Self::DifferentialEvolution),
            "cma_es" => Ok(Self::CmaEs),
            "nsga_ii" => Ok(Self::NsgaIi),
            "direct_cvar" => Ok(Self::DirectCvar),
            value => bail!("unsupported optimization algorithm: {value}"),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::RandomSearch => "random_search",
            Self::DifferentialEvolution => "differential_evolution",
            Self::CmaEs => "cma_es",
            Self::NsgaIi => "nsga_ii",
            Self::DirectCvar => "direct_cvar",
        }
    }
}

#[derive(Debug, Clone)]
struct OptimizerV2Config {
    algorithm: Algorithm,
    covariance_estimator: CovarianceEstimator,
    baseline_names: Vec<String>,
    asset_groups: BTreeMap<String, BTreeMap<String, String>>,
    group_constraints: Vec<GroupConstraint>,
    robust_weights: BTreeMap<String, f64>,
    ledger_template: Option<Value>,
    ledger_validation_budget: usize,
}

#[derive(Debug, Clone)]
struct Frame {
    ids: Vec<String>,
    dates: Vec<String>,
    /// Date-major matrix: `returns[date_index][asset_index]`.
    returns: Vec<Vec<f64>>,
}

#[derive(Debug, Clone)]
struct Weights(Vec<(String, f64)>);

impl Weights {
    fn get(&self, key: &str) -> f64 {
        self.0
            .iter()
            .find_map(|(candidate, value)| (candidate == key).then_some(*value))
            .unwrap_or(0.0)
    }

    fn to_json(&self) -> Value {
        let mut values = Map::new();
        for (key, value) in &self.0 {
            values.insert(key.clone(), json!(value));
        }
        Value::Object(values)
    }

    fn dense(&self, ids: &[String]) -> Vec<f64> {
        ids.iter().map(|id| self.get(id)).collect()
    }

    fn from_dense(ids: &[String], values: &[f64]) -> Self {
        Self(
            ids.iter()
                .zip(values)
                .filter(|(_, value)| **value > 1e-14)
                .map(|(id, value)| (id.clone(), *value))
                .collect(),
        )
    }
}

#[derive(Debug, Clone, Copy)]
struct WalkForwardWindow {
    test_start: usize,
    test_end: usize,
}

#[derive(Debug, Clone)]
struct EvaluationOptions<'a> {
    benchmark: Option<&'a Value>,
    oos_frame: Option<&'a Frame>,
    annualization: f64,
    confidence: f64,
    minimum_samples: usize,
    risk_free_percent: f64,
    windows: &'a [Value],
    validation_config: Option<&'a Value>,
    constraints: &'a Constraints,
    transaction_cost_bps: f64,
    robust_weights: &'a BTreeMap<String, f64>,
}

fn signature(weights: &Weights) -> String {
    let mut entries = weights.0.clone();
    entries.sort_by(|left, right| left.0.cmp(&right.0));
    entries
        .into_iter()
        .map(|(key, value)| format!("{key}:{value:.12}"))
        .collect::<Vec<_>>()
        .join("|")
}

fn mean(values: &[f64]) -> f64 {
    if values.is_empty() {
        0.0
    } else {
        values.iter().sum::<f64>() / values.len() as f64
    }
}

fn sample_std(values: &[f64]) -> f64 {
    if values.len() < 2 {
        return 0.0;
    }
    let average = mean(values);
    (values
        .iter()
        .map(|value| (value - average).powi(2))
        .sum::<f64>()
        / (values.len() - 1) as f64)
        .sqrt()
}

fn quantile_linear(values: &[f64], probability: f64) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    let position = probability.clamp(0.0, 1.0) * (sorted.len() - 1) as f64;
    let lower = position.floor() as usize;
    let upper = position.ceil() as usize;
    let fraction = position - lower as f64;
    Some(sorted[lower] * (1.0 - fraction) + sorted[upper] * fraction)
}

fn portfolio_returns(frame: &Frame, weights: &[f64]) -> Vec<f64> {
    frame
        .returns
        .iter()
        .map(|row| {
            row.iter()
                .zip(weights)
                .map(|(value, weight)| value * weight)
                .sum()
        })
        .collect()
}

#[derive(Debug, Clone, Copy)]
struct ProxyMetrics {
    portfolio_return: f64,
    volatility: f64,
    cvar: f64,
}

fn proxy_metrics(frame: &Frame, covariance: &[Vec<f64>], weights: &[f64]) -> ProxyMetrics {
    let means = mean_returns(&frame.returns, frame.ids.len());
    let portfolio_return = means
        .iter()
        .zip(weights)
        .map(|(mean, weight)| mean * weight)
        .sum::<f64>();
    let volatility = portfolio_variance(weights, covariance).sqrt();
    let returns = portfolio_returns(frame, weights);
    let cvar = quantile_linear(&returns, 0.05)
        .map(|threshold| {
            let tail = returns
                .iter()
                .copied()
                .filter(|value| *value <= threshold)
                .collect::<Vec<_>>();
            mean(&tail)
        })
        .unwrap_or(0.0);
    ProxyMetrics {
        portfolio_return,
        volatility,
        cvar,
    }
}

fn nullable(value: f64) -> Value {
    if value.is_finite() {
        json!(value)
    } else {
        Value::Null
    }
}

fn as_metric(candidate: &Value, key: &str) -> Option<f64> {
    candidate
        .get("metrics")
        .and_then(|metrics| metrics.get(key))
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
}

fn parsed_windows(values: &[Value], observations: usize) -> Vec<WalkForwardWindow> {
    values
        .iter()
        .filter_map(|window| {
            let start = window.get("testStartIndex")?.as_u64()? as usize;
            let end = window.get("testEndIndex")?.as_u64()? as usize;
            (start <= end && start < observations).then_some(WalkForwardWindow {
                test_start: start,
                test_end: end.min(observations.saturating_sub(1)),
            })
        })
        .collect()
}

fn normalized_robust_component(key: &str, value: f64) -> f64 {
    match key {
        "sharpe" | "sortino" | "informationRatio" | "oosAverageSharpe" | "oosWorstSharpe" => {
            (value / 2.0).tanh()
        }
        "calmar" => value.tanh(),
        "volatility" => 1.0 / (1.0 + value.max(0.0)),
        "cvar" | "oosAverageCvar" => 1.0 / (1.0 + value.abs()),
        _ => 0.0,
    }
}

fn robust_score_detail(
    weights: &BTreeMap<String, f64>,
    values: &[(&str, &str, Option<f64>)],
    coverage: f64,
) -> (Option<f64>, Value) {
    let available_weight = values
        .iter()
        .filter_map(|(key, _, value)| {
            value
                .filter(|value| value.is_finite())
                .map(|_| weights.get(*key).copied().unwrap_or(0.0))
        })
        .sum::<f64>();
    let mut total = 0.0;
    let mut in_sample_contribution = 0.0;
    let mut out_of_sample_contribution = 0.0;
    let mut in_sample_available_weight = 0.0;
    let mut out_of_sample_available_weight = 0.0;
    let components = values
        .iter()
        .map(|(key, source, raw)| {
            let weight = weights.get(*key).copied().unwrap_or(0.0);
            let normalized = raw
                .filter(|value| value.is_finite())
                .map(|value| normalized_robust_component(key, value));
            let contribution = normalized.unwrap_or(0.0) * weight;
            total += contribution;
            if normalized.is_some() {
                if *source == "oos" {
                    out_of_sample_available_weight += weight;
                    out_of_sample_contribution += contribution;
                } else {
                    in_sample_available_weight += weight;
                    in_sample_contribution += contribution;
                }
            }
            json!({
                "name": key,
                "source": source,
                "raw": raw,
                "normalized": normalized,
                "weight": weight,
                "normalizedWeight": if available_weight > 0.0 {
                    weight / available_weight
                } else {
                    0.0
                },
                "available": normalized.is_some(),
                "contribution": contribution,
            })
        })
        .collect::<Vec<_>>();
    let score = (available_weight > 0.0 && total.is_finite()).then_some(total);
    (
        score,
        json!({
            "score": score,
            "inSampleScore": (in_sample_available_weight > 0.0)
                .then_some(in_sample_contribution / in_sample_available_weight),
            "outOfSampleScore": (out_of_sample_available_weight > 0.0)
                .then_some(out_of_sample_contribution / out_of_sample_available_weight),
            "inSampleContribution": in_sample_contribution,
            "outOfSampleContribution": out_of_sample_contribution,
            "configuredWeight": weights.values().sum::<f64>(),
            "availableWeight": available_weight,
            "coverage": coverage.clamp(0.0, 1.0),
            "weights": weights,
            "components": components,
        }),
    )
}

fn evaluate_candidate(frame: &Frame, weights: &Weights, options: &EvaluationOptions<'_>) -> Value {
    let dense_weights: Vec<f64> = frame.ids.iter().map(|id| weights.get(id)).collect();
    let gross_portfolio: Vec<f64> = frame
        .returns
        .iter()
        .map(|row| {
            dense_weights
                .iter()
                .zip(row)
                .map(|(weight, value)| weight * value)
                .sum()
        })
        .collect();
    let target_sum = dense_weights.iter().sum::<f64>();
    let current_sum = frame
        .ids
        .iter()
        .map(|id| {
            options
                .constraints
                .current_weights
                .get(id)
                .copied()
                .unwrap_or(0.0)
        })
        .sum::<f64>();
    let asset_turnover = frame
        .ids
        .iter()
        .zip(&dense_weights)
        .map(|(id, weight)| {
            (*weight
                - options
                    .constraints
                    .current_weights
                    .get(id)
                    .copied()
                    .unwrap_or(0.0))
            .abs()
        })
        .sum::<f64>();
    let cash_turnover = ((1.0 - target_sum) - (1.0 - current_sum)).abs();
    let turnover = 0.5 * (asset_turnover + cash_turnover);
    let transaction_cost = turnover * options.transaction_cost_bps / 10_000.0;
    let mut portfolio = gross_portfolio;
    if let Some(first) = portfolio.first_mut() {
        *first = (1.0 - transaction_cost) * (1.0 + *first) - 1.0;
    }
    let observations = portfolio.len();
    let risk_free_period =
        (1.0 + options.risk_free_percent / 100.0).powf(1.0 / options.annualization) - 1.0;
    let cumulative = if observations == 0 {
        f64::NAN
    } else {
        portfolio
            .iter()
            .fold(1.0, |growth, value| growth * (1.0 + value))
            - 1.0
    };
    let elapsed_years = if observations == 0 {
        0.0
    } else {
        let days = crate::date::days_between(&frame.dates[0], &frame.dates[observations - 1]);
        (1.0 / options.annualization).max((days as f64 + 365.25 / options.annualization) / 365.25)
    };
    let cagr = if 1.0 + cumulative > 0.0 && elapsed_years > 0.0 {
        (1.0 + cumulative).powf(1.0 / elapsed_years) - 1.0
    } else {
        f64::NAN
    };
    let deviation = sample_std(&portfolio);
    let volatility = if observations >= 2 {
        deviation * options.annualization.sqrt()
    } else {
        f64::NAN
    };
    let excess_mean = if observations == 0 {
        0.0
    } else {
        portfolio
            .iter()
            .map(|value| value - risk_free_period)
            .sum::<f64>()
            / observations as f64
    };
    let sharpe = if deviation > 0.0 {
        excess_mean * options.annualization.sqrt() / deviation
    } else {
        f64::NAN
    };
    let downside = if observations == 0 {
        0.0
    } else {
        (portfolio
            .iter()
            .map(|value| (value - risk_free_period).min(0.0).powi(2))
            .sum::<f64>()
            / observations as f64)
            .sqrt()
    };
    let sortino = if downside > 0.0 {
        excess_mean * options.annualization.sqrt() / downside
    } else {
        f64::NAN
    };

    let mut growth = 1.0;
    let mut peak = f64::NEG_INFINITY;
    let mut max_drawdown = f64::INFINITY;
    for value in &portfolio {
        growth *= 1.0 + value;
        peak = peak.max(growth);
        max_drawdown = max_drawdown.min(growth / peak - 1.0);
    }
    if observations == 0 {
        max_drawdown = f64::NAN;
    }
    let calmar = if max_drawdown < 0.0 {
        cagr / max_drawdown.abs()
    } else {
        f64::NAN
    };
    let value_at_risk = quantile_linear(&portfolio, 1.0 - options.confidence);
    let cvar = value_at_risk
        .map(|threshold| {
            let tail: Vec<f64> = portfolio
                .iter()
                .copied()
                .filter(|value| *value <= threshold)
                .collect();
            mean(&tail)
        })
        .unwrap_or(f64::NAN);

    let information_ratio = options
        .benchmark
        .map(|benchmark| {
            let points = sanitize_points(benchmark.get("points"), false);
            let differences: Vec<f64> = frame
                .dates
                .iter()
                .enumerate()
                .filter_map(|(index, date)| {
                    points
                        .get(date)
                        .map(|benchmark_value| portfolio[index] - benchmark_value)
                })
                .collect();
            let tracking = sample_std(&differences) * options.annualization.sqrt();
            if tracking > 0.0 {
                mean(&differences) * options.annualization / tracking
            } else {
                f64::NAN
            }
        })
        .unwrap_or(f64::NAN);

    let oos_frame = options.oos_frame.unwrap_or(frame);
    let oos_portfolio = oos_frame
        .returns
        .iter()
        .map(|row| {
            dense_weights
                .iter()
                .zip(row)
                .map(|(weight, value)| weight * value)
                .sum::<f64>()
        })
        .collect::<Vec<_>>();
    let windows = parsed_windows(options.windows, oos_portfolio.len());
    let mut unique_test_observations = BTreeSet::new();
    let mut window_sharpes = Vec::new();
    let mut window_cvars = Vec::new();
    for window in &windows {
        let mut test = oos_portfolio[window.test_start..=window.test_end].to_vec();
        if test.is_empty() {
            continue;
        }
        if let Some(first) = test.first_mut() {
            *first = (1.0 - transaction_cost) * (1.0 + *first) - 1.0;
        }
        unique_test_observations.extend(window.test_start..=window.test_end);
        if test.len() >= options.minimum_samples {
            let test_deviation = sample_std(&test);
            if test_deviation > 0.0 {
                let test_excess = test
                    .iter()
                    .map(|value| value - risk_free_period)
                    .sum::<f64>()
                    / test.len() as f64;
                let value = test_excess * options.annualization.sqrt() / test_deviation;
                if value.is_finite() {
                    window_sharpes.push(value);
                }
            }
            if let Some(threshold) = quantile_linear(&test, 1.0 - options.confidence) {
                let tail: Vec<f64> = test
                    .iter()
                    .copied()
                    .filter(|value| *value <= threshold)
                    .collect();
                let value = mean(&tail);
                if value.is_finite() {
                    window_cvars.push(value);
                }
            }
        }
    }
    let average_sharpe = (!window_sharpes.is_empty()).then(|| mean(&window_sharpes));
    let worst_sharpe = window_sharpes.iter().copied().reduce(f64::min);
    let average_cvar = (!window_cvars.is_empty()).then(|| mean(&window_cvars));
    let coverage =
        (unique_test_observations.len() as f64 / oos_portfolio.len().max(1) as f64).min(1.0);
    let validation_mode = options
        .validation_config
        .and_then(|value| value.get("mode"))
        .and_then(Value::as_str)
        .unwrap_or(if windows.len() > 1 {
            "walk_forward"
        } else {
            "holdout"
        });
    let window_mode = options
        .validation_config
        .and_then(|value| value.get("windowMode"))
        .and_then(Value::as_str)
        .unwrap_or("rolling");
    let gap = options
        .validation_config
        .and_then(|value| value.get("gap"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let embargo = options
        .validation_config
        .and_then(|value| value.get("embargo"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let fold_count = windows.len();
    let validation_requested = options.validation_config.is_some();
    let validation_enabled = options
        .validation_config
        .and_then(Value::as_object)
        .is_some_and(|value| value.get("enabled").and_then(Value::as_bool) != Some(false));
    let validation_status = if !validation_requested {
        "not_requested"
    } else if !validation_enabled {
        "disabled"
    } else if fold_count == 0 {
        "not_evaluated"
    } else {
        "completed"
    };
    let validation_reason = match validation_status {
        "disabled" => Some("validation_disabled"),
        "not_evaluated" => Some("no_valid_folds"),
        _ => None,
    };
    let component_coverage = |count: usize| {
        if fold_count == 0 {
            0.0
        } else {
            count as f64 / fold_count as f64
        }
    };

    let mut metrics = Map::new();
    metrics.insert("sharpe".to_owned(), nullable(sharpe));
    metrics.insert("sortino".to_owned(), nullable(sortino));
    metrics.insert("calmar".to_owned(), nullable(calmar));
    metrics.insert("volatility".to_owned(), nullable(volatility));
    metrics.insert("cvar".to_owned(), nullable(cvar));
    metrics.insert("informationRatio".to_owned(), nullable(information_ratio));
    metrics.insert("robustScore".to_owned(), Value::Null);
    metrics.insert("cagr".to_owned(), nullable(cagr));
    metrics.insert("totalReturn".to_owned(), nullable(cumulative));
    metrics.insert("return".to_owned(), nullable(cagr));
    metrics.insert("maxDrawdown".to_owned(), nullable(max_drawdown));
    metrics.insert("turnover".to_owned(), json!(turnover));
    metrics.insert("transactionCost".to_owned(), json!(transaction_cost));
    metrics.insert(
        "period".to_owned(),
        json!({
            "from": frame.dates.first(),
            "to": frame.dates.last(),
            "observationCount": observations,
            "role": if windows.is_empty() { "screening_full" } else { "screening_train" },
        }),
    );

    let metric = |key: &str| metrics.get(key).and_then(Value::as_f64);
    let robust_values = [
        ("sharpe", "in_sample", metric("sharpe")),
        ("sortino", "in_sample", metric("sortino")),
        ("calmar", "in_sample", metric("calmar")),
        ("volatility", "in_sample", metric("volatility")),
        ("cvar", "in_sample", metric("cvar")),
        ("informationRatio", "in_sample", metric("informationRatio")),
        ("oosAverageSharpe", "oos", average_sharpe),
        ("oosWorstSharpe", "oos", worst_sharpe),
        ("oosAverageCvar", "oos", average_cvar),
    ];
    let (robust_score, mut robust_detail) =
        robust_score_detail(options.robust_weights, &robust_values, coverage);
    robust_detail
        .as_object_mut()
        .expect("robust score detail is an object")
        .insert(
            "validation".to_owned(),
            json!({
                "status": validation_status,
                "reason": validation_reason,
                "mode": validation_mode,
                "windowMode": window_mode,
                "foldCount": fold_count,
                "scoredFoldCount": window_sharpes.len().max(window_cvars.len()),
                "scoredSharpeFoldCount": window_sharpes.len(),
                "scoredCvarFoldCount": window_cvars.len(),
                "coverage": coverage,
                "gap": gap,
                "embargo": embargo,
                "componentCoverage": {
                    "oosAverageSharpe": component_coverage(window_sharpes.len()),
                    "oosWorstSharpe": component_coverage(window_sharpes.len()),
                    "oosAverageCvar": component_coverage(window_cvars.len()),
                },
                "leakageControl": "candidate_weights_fit_on_first_fold_train_only",
            }),
        );
    metrics.insert(
        "robustScore".to_owned(),
        robust_score.map_or(Value::Null, |value| json!(value)),
    );
    metrics.insert(
        "inSampleRobustScore".to_owned(),
        robust_detail
            .get("inSampleScore")
            .cloned()
            .unwrap_or(Value::Null),
    );
    metrics.insert(
        "oosRobustScore".to_owned(),
        robust_detail
            .get("outOfSampleScore")
            .cloned()
            .unwrap_or(Value::Null),
    );

    let mut candidate = json!({
        "weights": weights.to_json(),
        "sampleCount": observations,
        "validationStatus": validation_status,
        "validationReason": validation_reason,
        "metrics": metrics,
        "walkForwardTestCoverage": coverage,
        "walkForwardSignal": {
            "status": validation_status,
            "reason": validation_reason,
            "mode": validation_mode,
            "windowMode": window_mode,
            "foldCount": fold_count,
            "scoredFoldCount": window_sharpes.len().max(window_cvars.len()),
            "scoredSharpeFoldCount": window_sharpes.len(),
            "scoredCvarFoldCount": window_cvars.len(),
            "averageSharpe": average_sharpe,
            "worstSharpe": worst_sharpe,
            "averageCvar": average_cvar,
        },
        "robustScoreDetail": robust_detail,
    });
    if validation_reason.is_none() {
        candidate
            .as_object_mut()
            .expect("optimization candidate is an object")
            .remove("validationReason");
        candidate["walkForwardSignal"]
            .as_object_mut()
            .expect("walk-forward signal is an object")
            .remove("reason");
        candidate["robustScoreDetail"]["validation"]
            .as_object_mut()
            .expect("robust validation is an object")
            .remove("reason");
    }
    candidate
}

fn better(left: &Value, right: &Value, objective: &str) -> bool {
    let key = match objective {
        "max_cagr" => "cagr",
        "max_total_return" => "totalReturn",
        "max_sharpe" => "sharpe",
        "max_sortino" => "sortino",
        "max_calmar" => "calmar",
        "min_volatility" => "volatility",
        "min_cvar" => "cvar",
        "max_information_ratio" => "informationRatio",
        "robust_score" => "robustScore",
        _ => return false,
    };
    let (Some(left), Some(right)) = (as_metric(left, key), as_metric(right, key)) else {
        return false;
    };
    match objective {
        "min_volatility" => left < right,
        "min_cvar" => left.abs() < right.abs(),
        _ => left > right,
    }
}

fn candidate_is_valid(
    candidate: &Value,
    constraints: &Constraints,
    group_constraints: &[GroupConstraint],
    asset_groups: &BTreeMap<String, BTreeMap<String, String>>,
) -> bool {
    let Some(weights) = candidate.get("weights").and_then(Value::as_object) else {
        return false;
    };
    let selected_count = weights
        .values()
        .filter_map(Value::as_f64)
        .filter(|weight| *weight > 1e-14)
        .count();
    let total_weight = weights.values().filter_map(Value::as_f64).sum::<f64>();
    if selected_count > constraints.max_assets
        || (total_weight - 1.0).abs() > 1e-8
        || constraints.excluded_assets.iter().any(|id| {
            weights
                .get(id)
                .and_then(Value::as_f64)
                .is_some_and(|weight| weight > 1e-14)
        })
        || constraints.required_assets.iter().any(|id| {
            weights
                .get(id)
                .and_then(Value::as_f64)
                .is_none_or(|weight| weight <= 1e-14)
        })
    {
        return false;
    }
    let per_asset = weights.iter().all(|(id, value)| {
        let Some(weight) = value.as_f64() else {
            return false;
        };
        let minimum = constraints
            .min_weights
            .get(id)
            .copied()
            .unwrap_or(constraints.min_weight);
        let maximum = constraints
            .max_weights
            .get(id)
            .copied()
            .unwrap_or(constraints.max_weight);
        weight >= minimum && weight <= maximum
    }) && constraints
        .min_weights
        .iter()
        .all(|(id, minimum)| weights.get(id).and_then(Value::as_f64).unwrap_or(0.0) >= *minimum);
    if !per_asset {
        return false;
    }
    let candidate_weights = Weights(
        weights
            .iter()
            .filter_map(|(id, value)| value.as_f64().map(|weight| (id.clone(), weight)))
            .collect(),
    );
    if !group_constraints_valid(&candidate_weights, group_constraints, asset_groups) {
        return false;
    }
    if as_metric(candidate, "maxDrawdown")
        .is_some_and(|value| value.abs() > constraints.max_drawdown)
    {
        return false;
    }
    if as_metric(candidate, "return").is_some_and(|value| value < constraints.target_return) {
        return false;
    }
    !as_metric(candidate, "turnover").is_some_and(|value| value > constraints.max_turnover)
}

fn candidate_signature(candidate: &Value) -> String {
    let Some(weights) = candidate.get("weights").and_then(Value::as_object) else {
        return String::new();
    };
    let weights = Weights(
        weights
            .iter()
            .filter_map(|(id, value)| value.as_f64().map(|weight| (id.clone(), weight)))
            .collect(),
    );
    signature(&weights)
}

fn candidate_identity(candidate: &Value) -> String {
    format!(
        "{}|{}",
        candidate_signature(candidate),
        candidate
            .get("candidateSource")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
    )
}

fn register_candidate(
    candidate: Value,
    constraints: &Constraints,
    config: &OptimizerV2Config,
    best: &mut BTreeMap<&'static str, Option<Value>>,
    candidates: &mut Vec<Value>,
) -> bool {
    if !candidate_is_valid(
        &candidate,
        constraints,
        &config.group_constraints,
        &config.asset_groups,
    ) {
        return false;
    }
    for objective in OBJECTIVES {
        let replace = best[objective]
            .as_ref()
            .is_none_or(|current| better(&candidate, current, objective));
        if replace {
            best.insert(objective, Some(candidate.clone()));
        }
    }
    candidates.push(candidate);
    true
}

pub fn optimize(input: &Value) -> Result<Value> {
    optimize_with_control(input, None)
}

pub fn optimize_with_control(input: &Value, control: Option<&dyn ComputeControl>) -> Result<Value> {
    checkpoint(control)?;
    let input = input
        .as_object()
        .context("optimization input must be a JSON object")?;
    let get = |key| input.get(key);
    let config = parse_v2_config(input)?;
    let objective = get("objective")
        .and_then(Value::as_str)
        .unwrap_or("robust_score");
    if !OBJECTIVES.contains(&objective) {
        bail!("unsupported optimization objective: {objective}");
    }
    let mut warnings = Vec::<String>::new();
    let seed = positive_int(get("seed"), DEFAULT_SEED, 0, MAX_SAFE_INTEGER);
    let mut rng = Mulberry32::new(seed);
    let minimum_samples = positive_int(get("minimumSamples"), 2, 2, 3650) as usize;
    let annualization = numeric(get("annualization"))
        .filter(|value| *value > 0.0)
        .unwrap_or(252.0);
    let confidence = decimal(get("confidence"), 0.95, 0.8, 0.999);
    let risk_free = decimal(get("riskFreeRatePercent"), 0.0, -100.0, 100.0);
    let price_series = get("priceSeries").and_then(Value::as_array);
    if price_series.is_none_or(|value| value.len() < 2) {
        warnings.push("최소 2개 이상의 자산이 필요합니다.".to_owned());
    }
    let price_series = price_series.map(Vec::as_slice).unwrap_or_default();
    let validation_enabled = get("walkForwardConfig")
        .filter(|value| !value.is_null())
        .and_then(Value::as_object)
        .is_some_and(|value| value.get("enabled").and_then(Value::as_bool) != Some(false));
    let future_warning = (!validation_enabled).then_some(if get("walkForwardConfig").is_some() {
        "robustValidation.enabled=false이므로 OOS 검증을 수행하지 않았습니다. 전 구간 최적화에는 미래 누수(look-ahead) 위험이 존재합니다."
    } else {
        "walk-forward 설정이 없어 전 구간 최적화입니다. 미래 누수(look-ahead) 위험이 존재합니다."
    });
    let full_frame = aligned_frame(price_series);
    checkpoint(control)?;
    let windows = get("walkForwardConfig")
        .filter(|_| validation_enabled)
        .map(|config| build_walk_forward_windows(full_frame.dates.len(), Some(config)))
        .unwrap_or_default();
    let frame = training_frame(&full_frame, &windows);
    let covariance =
        covariance_matrix(&frame.returns, frame.ids.len(), config.covariance_estimator);
    if full_frame.dates.is_empty() {
        warnings.push("공통 기간 교집합 데이터가 없습니다.".to_owned());
    } else if validation_enabled && windows.is_empty() {
        warnings.push(
            "inner OOS 검증에 필요한 train/test 표본이 부족해 전 구간 screening으로 대체했습니다."
                .to_owned(),
        );
    }
    let (constraints, constraint_warnings) =
        normalize_constraints(get("constraints"), frame.ids.len());
    warnings.extend(constraint_warnings);
    let available: Vec<String> = frame
        .ids
        .iter()
        .filter(|id| !constraints.excluded_assets.iter().any(|value| value == *id))
        .cloned()
        .collect();
    let mut required = constraints.required_assets.clone();
    for (id, minimum) in &constraints.min_weights {
        if *minimum > 0.0 && !required.iter().any(|value| value == id) {
            required.push(id.clone());
        }
    }
    let required_in_scope: Vec<String> = required
        .iter()
        .filter(|id| available.iter().any(|value| value == *id))
        .cloned()
        .collect();
    if required_in_scope.len() != required.len() {
        bail!("필수 자산이 후보군에 없거나 제외 자산과 충돌합니다.");
    }
    if constraints.max_assets > available.len() {
        warnings.push("maxAssets가 사용 가능한 자산 수보다 커서 조정했습니다.".to_owned());
    }

    let candidate_budget = positive_int(get("candidateBudget"), 500, 1, 10_000) as usize;
    let screening_budget = candidate_budget.max(config.baseline_names.len());
    let max_attempts = screening_budget * 40;
    let transaction_cost_bps = numeric(get("transactionCostBps"))
        .unwrap_or(0.0)
        .clamp(0.0, 500.0);
    let regime_policy_config =
        parse_regime_policy_config(input, &config.baseline_names, transaction_cost_bps)?;
    let benchmark = get("benchmark").filter(|value| value.is_object());
    let mut seen = HashSet::new();
    let mut candidates = Vec::new();
    let mut best: BTreeMap<&'static str, Option<Value>> = OBJECTIVES
        .into_iter()
        .map(|objective| (objective, None))
        .collect();
    let mut attempts = 0usize;
    let options = EvaluationOptions {
        benchmark,
        oos_frame: (!windows.is_empty()).then_some(&full_frame),
        annualization,
        confidence,
        minimum_samples,
        risk_free_percent: risk_free,
        windows: &windows,
        validation_config: get("walkForwardConfig"),
        constraints: &constraints,
        transaction_cost_bps,
        robust_weights: &config.robust_weights,
    };

    let baseline_generated = baseline_candidates(&frame, &covariance, &config, &constraints)
        .into_iter()
        .take(screening_budget)
        .collect::<Vec<_>>();
    let baseline_evaluated = baseline_generated
        .par_iter()
        .map(|(weights, source)| -> Result<Value> {
            checkpoint(control)?;
            let mut candidate = evaluate_candidate(&frame, weights, &options);
            candidate
                .as_object_mut()
                .expect("candidate is an object")
                .insert("candidateSource".to_owned(), json!(source));
            if let Some(name) = source.strip_prefix("baseline:") {
                let object = candidate.as_object_mut().expect("candidate is an object");
                object.insert("baseline".to_owned(), json!(name));
                object.insert("algorithm".to_owned(), json!("baseline"));
            }
            Ok(candidate)
        })
        .collect::<Result<Vec<_>>>()?;
    let mut baseline_candidate_count = 0usize;
    for ((weights, _), candidate) in baseline_generated.iter().zip(baseline_evaluated) {
        // Baseline identities remain visible even when two policies yield identical weights.
        seen.insert(signature(weights));
        if register_candidate(candidate, &constraints, &config, &mut best, &mut candidates) {
            baseline_candidate_count += 1;
        }
    }

    while config.algorithm == Algorithm::RandomSearch
        && attempts < max_attempts
        && candidates.len() < screening_budget
    {
        checkpoint(control)?;
        let mut generated = Vec::with_capacity(DEFAULT_BATCH_SIZE);
        while attempts < max_attempts && generated.len() < DEFAULT_BATCH_SIZE {
            attempts += 1;
            if attempts.is_multiple_of(256) {
                checkpoint(control)?;
            }
            let Some(mut weights) =
                candidate_weights(&mut rng, &available, &required_in_scope, &constraints)
            else {
                continue;
            };
            if !config.group_constraints.is_empty() {
                let Some(repaired) = repair_dense_weights(
                    &weights.dense(&frame.ids),
                    &frame.ids,
                    &constraints,
                    &config.group_constraints,
                    &config.asset_groups,
                ) else {
                    continue;
                };
                weights = repaired;
            }
            let signature = signature(&weights);
            if !seen.insert(signature) {
                continue;
            }
            generated.push(weights);
        }
        if generated.is_empty() {
            break;
        }
        let evaluated = generated
            .par_iter()
            .map(|weights| -> Result<Value> {
                checkpoint(control)?;
                let mut candidate = evaluate_candidate(&frame, weights, &options);
                candidate
                    .as_object_mut()
                    .expect("candidate is an object")
                    .insert("candidateSource".to_owned(), json!("random_search"));
                candidate
                    .as_object_mut()
                    .expect("candidate is an object")
                    .insert("algorithm".to_owned(), json!("random_search"));
                Ok(candidate)
            })
            .collect::<Result<Vec<_>>>()?;
        for candidate in evaluated {
            checkpoint(control)?;
            if !register_candidate(candidate, &constraints, &config, &mut best, &mut candidates) {
                continue;
            }
            if windows.is_empty()
                && candidates
                    .last()
                    .expect("registered candidate")
                    .get("sampleCount")
                    .and_then(Value::as_u64)
                    .is_some_and(|count| count < minimum_samples as u64)
            {
                warnings.push(format!(
                    "샘플수가 부족한 조합이 생성되었습니다. ({}개) 경고 반영.",
                    candidates.last().expect("registered candidate")["sampleCount"]
                ));
            }
            if candidates.len() >= screening_budget {
                break;
            }
        }
    }

    if config.algorithm != Algorithm::RandomSearch && candidates.len() < screening_budget {
        let remaining = screening_budget - candidates.len();
        let generated = advanced_candidates(
            &mut rng,
            &frame,
            &covariance,
            &constraints,
            &config,
            (objective, &options),
            remaining.saturating_mul(2).min(10_000),
        );
        let generated = generated
            .into_iter()
            .filter(|(weights, _)| seen.insert(signature(weights)))
            .take(remaining)
            .collect::<Vec<_>>();
        let evaluated = generated
            .par_iter()
            .map(|(weights, source)| -> Result<Value> {
                checkpoint(control)?;
                let mut candidate = evaluate_candidate(&frame, weights, &options);
                candidate
                    .as_object_mut()
                    .expect("candidate is an object")
                    .insert("candidateSource".to_owned(), json!(source));
                candidate
                    .as_object_mut()
                    .expect("candidate is an object")
                    .insert("algorithm".to_owned(), json!(source));
                Ok(candidate)
            })
            .collect::<Result<Vec<_>>>()?;
        for candidate in evaluated {
            if candidates.len() >= screening_budget {
                break;
            }
            register_candidate(candidate, &constraints, &config, &mut best, &mut candidates);
        }
    }

    if candidates.is_empty() {
        warnings
            .push("조건을 만족하는 후보가 없습니다. 제약값/샘플수/예산을 완화하세요.".to_owned());
    }
    let screening_frontier = pareto_with_control(&candidates, control)?;
    let frontier_signatures = screening_frontier
        .iter()
        .map(candidate_signature)
        .collect::<HashSet<_>>();
    let mut sorted_candidates = candidates;
    sorted_candidates.sort_by(|left, right| {
        match (
            as_metric(left, "robustScore"),
            as_metric(right, "robustScore"),
        ) {
            (Some(left), Some(right)) => right.total_cmp(&left),
            (Some(_), None) => Ordering::Less,
            (None, Some(_)) => Ordering::Greater,
            (None, None) => Ordering::Equal,
        }
    });
    let (
        ledger_validated_candidates,
        ledger_validation_selected_count,
        ledger_validation_failed_count,
    ) = validate_with_ledger(
        &mut sorted_candidates,
        &frontier_signatures,
        &config,
        control,
    )?;
    if config.ledger_template.is_some() && ledger_validation_failed_count > 0 {
        warnings.push(format!(
            "ledger 재검증 후보 {ledger_validation_failed_count}개가 실패했습니다. 후보별 validationError를 확인하세요."
        ));
    }
    let annotated_by_identity = sorted_candidates
        .iter()
        .map(|candidate| (candidate_identity(candidate), candidate.clone()))
        .collect::<BTreeMap<_, _>>();
    let frontier = screening_frontier
        .iter()
        .filter_map(|candidate| {
            annotated_by_identity
                .get(&candidate_identity(candidate))
                .cloned()
        })
        .collect::<Vec<_>>();
    if windows.is_empty() {
        let (_, _, _, minimum_train, _) = walk_forward_config(get("walkForwardConfig"));
        if !frame.dates.is_empty() && frame.dates.len() < minimum_train {
            warnings.push("walk-forward가 없고 표본 수가 작아 신뢰도가 낮습니다.".to_owned());
        }
    }
    let best_by_objective: Map<String, Value> = best
        .into_iter()
        .map(|(key, value)| {
            let value = value
                .and_then(|candidate| {
                    annotated_by_identity
                        .get(&candidate_identity(&candidate))
                        .cloned()
                })
                .unwrap_or(Value::Null);
            (key.to_owned(), value)
        })
        .collect();
    let covariance_estimator = match config.covariance_estimator {
        CovarianceEstimator::Sample => "sample",
        CovarianceEstimator::LedoitWolf => "ledoit_wolf",
    };
    let algorithm_implementation = match config.algorithm {
        Algorithm::RandomSearch => "seeded_bounded_random_search",
        Algorithm::DifferentialEvolution => "de_rand_1_bin",
        Algorithm::CmaEs => "separable_cma_es_with_evolution_paths",
        Algorithm::NsgaIi => "nondominated_sort_crowding_tournament",
        Algorithm::DirectCvar => "projected_empirical_tail_gradient",
    };
    let search_proxy = match config.algorithm {
        Algorithm::RandomSearch => "none".to_owned(),
        Algorithm::DifferentialEvolution | Algorithm::CmaEs => {
            format!("training_only_{objective}")
        }
        Algorithm::NsgaIi => "return_volatility_cvar".to_owned(),
        Algorithm::DirectCvar => "empirical_cvar_95".to_owned(),
    };
    let validation_test_observations = parsed_windows(&windows, full_frame.dates.len())
        .into_iter()
        .flat_map(|window| window.test_start..=window.test_end)
        .collect::<BTreeSet<_>>()
        .len();
    let validation_status = if !validation_enabled {
        if get("walkForwardConfig").is_some() {
            "disabled"
        } else {
            "not_requested"
        }
    } else if windows.is_empty() {
        "not_evaluated"
    } else {
        "completed"
    };
    let validation_reason = match validation_status {
        "disabled" => Some("validation_disabled"),
        "not_evaluated" => Some("no_valid_folds"),
        _ => None,
    };
    let validation_config = get("walkForwardConfig").and_then(Value::as_object);
    let validation_mode = validation_config
        .and_then(|value| value.get("mode"))
        .and_then(Value::as_str)
        .unwrap_or("not_requested");
    let validation_window_mode = validation_config
        .and_then(|value| value.get("windowMode"))
        .and_then(Value::as_str)
        .unwrap_or(if validation_mode == "holdout" {
            "holdout"
        } else {
            "rolling"
        });
    let validation_gap = validation_config
        .and_then(|value| value.get("gap"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let validation_embargo = validation_config
        .and_then(|value| value.get("embargo"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let requested_validation_folds = if validation_mode == "holdout" {
        1
    } else {
        validation_config
            .and_then(|value| value.get("foldCount"))
            .and_then(Value::as_u64)
            .unwrap_or(5)
    };
    let (
        validation_train_window,
        validation_test_window,
        validation_step,
        minimum_train,
        minimum_test,
    ) = walk_forward_config(get("walkForwardConfig"));
    let first_fold_failure_reason = if validation_enabled && windows.is_empty() {
        Some(if full_frame.dates.is_empty() {
            "no_common_observations"
        } else if validation_mode == "holdout" {
            "insufficient_observations_for_holdout"
        } else {
            "insufficient_observations_for_first_fold"
        })
    } else {
        None
    };
    let ledger_validation_status = if config.ledger_template.is_none() {
        "not_requested"
    } else if ledger_validation_selected_count > 0
        && ledger_validation_failed_count == ledger_validation_selected_count
    {
        "failed"
    } else if ledger_validation_failed_count > 0 {
        "partial"
    } else {
        "completed"
    };
    let mut regime_policy_search = None;
    let mut regime_policy_artifact = None;
    if let Some(policy_config) = regime_policy_config.as_ref() {
        match run_regime_policy_search(
            &frame,
            policy_config,
            &config,
            &constraints,
            annualization,
            risk_free,
            transaction_cost_bps,
            seed,
            control,
        ) {
            Ok((policy_result, artifact, policy_warnings)) => {
                for warning in policy_warnings {
                    if !warnings.contains(&warning) {
                        warnings.push(warning);
                    }
                }
                regime_policy_search = Some(policy_result);
                regime_policy_artifact = Some(artifact);
            }
            Err(error) => {
                let warning = format!("국면 정책 탐색을 완료하지 못했습니다: {error}");
                warnings.push(warning.clone());
                regime_policy_search = Some(json!({
                    "enabled": true,
                    "status": "failed",
                    "requestedMethod": policy_config.requested_method.as_str(),
                    "warnings": [warning],
                }));
                regime_policy_artifact = Some(json!([]));
            }
        }
    }
    let mut result = json!({
        "warnings": warnings,
        "seed": seed,
        "algorithm": config.algorithm.as_str(),
        "algorithmDetails": {
            "implementation": algorithm_implementation,
            "deterministic": true,
            "seed": seed,
            "searchObjective": objective,
            "searchProxy": search_proxy,
            "paretoObjectiveSpace": ["return", "volatility", "maxDrawdown", "cvar", "turnover", "transactionCost"],
            "objectiveFormulaVersion": "optimization-objectives/v2",
            "returnCompatibilityAlias": "cagr",
        },
        "covarianceEstimator": covariance_estimator,
        "baselines": config.baseline_names,
        "robustScoreWeights": config.robust_weights,
        "robustValidation": {
            "status": validation_status,
            "reason": validation_reason,
            "leakageControl": "candidates_fit_on_inner_train_only",
            "foldLeakageControl": "candidate_weights_fit_on_first_fold_train_only_and_tests_are_chronological",
            "mode": validation_mode,
            "windowMode": validation_window_mode,
            "requestedFoldCount": requested_validation_folds,
            "foldCount": windows.len(),
            "windowCount": windows.len(),
            "inSampleObservations": frame.dates.len(),
            "outOfSampleObservations": validation_test_observations,
            "coverage": validation_test_observations as f64 / full_frame.dates.len().max(1) as f64,
            "gap": validation_gap,
            "embargo": validation_embargo,
            "diagnostics": {
                "totalObservationCount": full_frame.dates.len(),
                "trainWindow": validation_train_window,
                "testWindow": validation_test_window,
                "step": validation_step,
                "requestedFoldCount": requested_validation_folds,
                "gap": validation_gap,
                "embargo": validation_embargo,
                "minimumTrainObservations": minimum_train,
                "minimumTestObservations": minimum_test,
                "firstFoldFailureReason": first_fold_failure_reason,
                "excludedFolds": [],
            },
            "folds": windows,
        },
        "sampledAssets": available,
        "requestedCandidateBudget": candidate_budget,
        "effectiveScreeningBudget": screening_budget,
        "candidateCount": sorted_candidates.len(),
        "screeningCandidateCount": sorted_candidates.len(),
        "baselineCandidateCount": baseline_candidate_count,
        "candidates": sorted_candidates,
        "paretoFrontier": frontier,
        "ledgerValidatedCandidates": ledger_validated_candidates,
        "ledgerValidation": {
            "status": ledger_validation_status,
            "budget": config.ledger_validation_budget,
            "selectedCount": ledger_validation_selected_count,
            "completedCount": ledger_validation_selected_count.saturating_sub(ledger_validation_failed_count),
            "failedCount": ledger_validation_failed_count,
            "selectionPolicy": "pareto_then_screening_rank",
            "rankingMetric": "ledger_robust_score",
        },
        "paretoComputation": "typed_incremental_with_exact_missing_metric_fallback",
        "bestByObjective": best_by_objective,
    });
    if let Some(policy_search) = regime_policy_search {
        let object = result.as_object_mut().expect("result is an object");
        object.insert("regimePolicySearch".to_owned(), policy_search);
        object.insert(
            "regimePolicyArtifact".to_owned(),
            regime_policy_artifact.unwrap_or_else(|| json!([])),
        );
    }
    if let Some(future_warning) = future_warning {
        result
            .as_object_mut()
            .expect("result is an object")
            .insert("futureLeakageWarning".to_owned(), json!(future_warning));
    }
    checkpoint(control)?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;
    use rayon::ThreadPoolBuilder;

    struct StopAfter {
        remaining: AtomicUsize,
    }

    impl ComputeControl for StopAfter {
        fn checkpoint(&self) -> Result<()> {
            if self
                .remaining
                .fetch_update(Ordering::AcqRel, Ordering::Acquire, |value| {
                    value.checked_sub(1)
                })
                .is_err()
            {
                anyhow::bail!("TEST_OPTIMIZATION_CANCELLED");
            }
            Ok(())
        }
    }

    struct NeverStop;

    impl ComputeControl for NeverStop {
        fn checkpoint(&self) -> Result<()> {
            Ok(())
        }
    }

    fn synthetic_series(key: &str, drift: f64, phase: f64) -> Value {
        let mut value = 100.0;
        let mut points = Vec::new();
        for index in 0..90 {
            value *= 1.0 + drift + ((index as f64) / 5.0 + phase).sin() * 0.004;
            points.push(json!({
                "date": crate::date::add_days("2024-01-01", index).unwrap(),
                "value": value,
            }));
        }
        json!({ "key": key, "label": key, "points": points })
    }

    fn optimization_input() -> Value {
        json!({
            "priceSeries": [
                synthetic_series("A", 0.001, 0.0),
                synthetic_series("B", 0.0005, 1.0),
                synthetic_series("C", 0.0008, 2.0),
            ],
            "constraints": {
                "minWeights": {"A": 0.2},
                "maxWeights": {"A": 0.4},
                "maxAssets": 3,
            },
            "seed": 7,
            "candidateBudget": 25,
            "minimumSamples": 20,
        })
    }

    fn objective_tradeoff_frame() -> (Frame, Value) {
        let mut dates = Vec::new();
        let mut returns = Vec::new();
        let mut benchmark_points = Vec::new();
        for index in 0..160 {
            let date = crate::date::add_days("2024-01-01", index).unwrap();
            let high_sharpe_high_risk = 0.003 + if index % 2 == 0 { 0.02 } else { -0.02 };
            let low_risk_low_sharpe = 0.000_01 + if index % 4 < 2 { 0.000_2 } else { -0.000_2 };
            let diversifier = -0.000_2 + ((index as f64) / 3.0).sin() * 0.008;
            dates.push(date.clone());
            returns.push(vec![
                high_sharpe_high_risk,
                low_risk_low_sharpe,
                diversifier,
            ]);
            benchmark_points.push(json!({
                "date": date,
                "value": 0.000_15 + ((index as f64) / 7.0).cos() * 0.001,
            }));
        }
        (
            Frame {
                ids: vec![
                    "HIGH".to_owned(),
                    "LOW".to_owned(),
                    "DIVERSIFIER".to_owned(),
                ],
                dates,
                returns,
            },
            json!({"points": benchmark_points}),
        )
    }

    fn ledger_template() -> Value {
        let series = [
            synthetic_series("A", 0.001, 0.0),
            synthetic_series("B", 0.0005, 1.0),
            synthetic_series("C", 0.0008, 2.0),
        ];
        let prices = series
            .iter()
            .map(|series| {
                let key = series["key"].as_str().unwrap().to_owned();
                let points = series["points"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|point| {
                        json!({
                            "date": point["date"],
                            "close": point["value"],
                        })
                    })
                    .collect::<Vec<_>>();
                (format!("USD:{key}"), json!(points))
            })
            .collect::<Map<_, _>>();
        json!({
            "assets": [
                {"symbol": "A", "name": "A", "market": "TEST", "currency": "USD", "listDate": "2020-01-01", "weight": 34.0},
                {"symbol": "B", "name": "B", "market": "TEST", "currency": "USD", "listDate": "2020-01-01", "weight": 33.0},
                {"symbol": "C", "name": "C", "market": "TEST", "currency": "USD", "listDate": "2020-01-01", "weight": 33.0}
            ],
            "prices": prices,
            "requestedStartDate": "2024-01-01",
            "endDate": crate::date::add_days("2024-01-01", 89).unwrap(),
            "initialAmount": 100000.0,
            "rebalanceFrequency": "quarterly",
            "transactionCostBps": 5.0,
        })
    }

    fn clustered_covariance() -> Vec<Vec<f64>> {
        let volatility = [0.10, 0.16, 0.23, 0.08, 0.14, 0.20];
        let correlation = [
            [1.00, 0.88, 0.76, 0.12, -0.08, 0.04],
            [0.88, 1.00, 0.81, -0.03, 0.17, 0.08],
            [0.76, 0.81, 1.00, 0.09, 0.02, -0.11],
            [0.12, -0.03, 0.09, 1.00, 0.84, 0.70],
            [-0.08, 0.17, 0.02, 0.84, 1.00, 0.78],
            [0.04, 0.08, -0.11, 0.70, 0.78, 1.00],
        ];
        (0..volatility.len())
            .map(|left| {
                (0..volatility.len())
                    .map(|right| correlation[left][right] * volatility[left] * volatility[right])
                    .collect()
            })
            .collect()
    }

    fn normalized_risk_contributions(weights: &[f64], covariance: &[Vec<f64>]) -> Vec<f64> {
        let variance = portfolio_variance(weights, covariance).max(1e-18);
        weights
            .iter()
            .enumerate()
            .map(|(index, weight)| {
                let marginal = weights
                    .iter()
                    .enumerate()
                    .map(|(other, other_weight)| other_weight * covariance[index][other])
                    .sum::<f64>();
                weight * marginal / variance
            })
            .collect()
    }

    #[test]
    fn mulberry32_matches_cross_language_golden_values() {
        let mut rng = Mulberry32::new(12_345);
        let actual = [rng.next(), rng.next(), rng.next()];
        let expected = [
            0.979_728_267_760_947_3,
            0.306_752_264_499_664_3,
            0.484_205_421_525_985,
        ];
        assert_eq!(actual, expected);
    }

    #[test]
    fn walk_forward_windows_match_reference_boundaries() {
        let config = json!({
            "trainWindow": 15,
            "testWindow": 5,
            "step": 5,
            "minimumTrainObservations": 10,
            "minimumTestObservations": 5,
        });
        let windows = build_walk_forward_windows(30, Some(&config));
        assert_eq!(windows.len(), 3);
        assert!(windows.iter().all(|window| {
            window["trainEndIndex"].as_u64().unwrap() < window["testStartIndex"].as_u64().unwrap()
        }));
    }

    #[test]
    fn default_walk_forward_settings_produce_folds_for_1319_observations() {
        let windows = build_walk_forward_windows(
            1_319,
            Some(&json!({
                "enabled": true,
                "mode": "walk_forward",
                "windowMode": "rolling",
            })),
        );

        assert_eq!(windows.len(), 5);
        assert!(windows.iter().all(|fold| {
            fold["trainCount"].as_u64() == Some(126) && fold["testCount"].as_u64() == Some(21)
        }));
    }

    #[test]
    fn zero_fold_validation_is_not_reported_as_completed() {
        let mut input = optimization_input();
        input["walkForwardConfig"] = json!({
            "enabled": true,
            "mode": "walk_forward",
            "windowMode": "rolling",
            "trainWindow": 126,
            "testWindow": 21,
            "step": 21,
            "foldCount": 5,
        });

        let result = optimize(&input).unwrap();
        assert_eq!(result["robustValidation"]["status"], "not_evaluated");
        assert_eq!(result["robustValidation"]["reason"], "no_valid_folds");
        assert_eq!(result["robustValidation"]["foldCount"], 0);
        assert_eq!(
            result["robustValidation"]["diagnostics"]["firstFoldFailureReason"],
            "insufficient_observations_for_first_fold"
        );
        for candidate in result["candidates"].as_array().unwrap() {
            assert_eq!(candidate["validationStatus"], "not_evaluated");
            assert_eq!(candidate["validationReason"], "no_valid_folds");
            assert_eq!(candidate["walkForwardSignal"]["reason"], "no_valid_folds");
            assert_eq!(
                candidate["robustScoreDetail"]["validation"]["reason"],
                "no_valid_folds"
            );
        }
    }

    #[test]
    fn optional_candidate_validation_reasons_are_omitted_when_not_applicable() {
        let result = optimize(&optimization_input()).unwrap();
        let candidates = result["candidates"].as_array().unwrap();
        assert!(!candidates.is_empty());

        for candidate in candidates {
            assert_eq!(candidate["validationStatus"], "not_requested");
            assert!(
                !candidate
                    .as_object()
                    .unwrap()
                    .contains_key("validationReason")
            );
            assert!(
                !candidate["walkForwardSignal"]
                    .as_object()
                    .unwrap()
                    .contains_key("reason")
            );
            assert!(
                !candidate["robustScoreDetail"]["validation"]
                    .as_object()
                    .unwrap()
                    .contains_key("reason")
            );
        }
    }

    #[test]
    fn robust_walk_forward_windows_apply_gap_embargo_fold_cap_and_window_mode() {
        let rolling = build_walk_forward_windows(
            240,
            Some(&json!({
                "mode": "walk_forward",
                "windowMode": "rolling",
                "trainWindow": 60,
                "testWindow": 20,
                "step": 10,
                "foldCount": 4,
                "gap": 3,
                "embargo": 5,
                "minimumTrainObservations": 40,
                "minimumTestObservations": 10,
            })),
        );
        assert_eq!(rolling.len(), 4);
        assert_eq!(rolling[0]["trainStartIndex"], 0);
        assert_eq!(rolling[1]["trainStartIndex"], 25);
        assert!(rolling.iter().all(|fold| {
            fold["testStartIndex"].as_u64().unwrap()
                == fold["trainEndIndex"].as_u64().unwrap() + 1 + 3
        }));
        for pair in rolling.windows(2) {
            assert!(
                pair[1]["testStartIndex"].as_u64().unwrap()
                    >= pair[0]["testEndIndex"].as_u64().unwrap() + 1 + 5
            );
        }

        let anchored = build_walk_forward_windows(
            240,
            Some(&json!({
                "mode": "walk_forward",
                "windowMode": "anchored",
                "trainWindow": 60,
                "testWindow": 20,
                "step": 10,
                "foldCount": 4,
                "gap": 3,
                "embargo": 5,
            })),
        );
        assert_eq!(anchored.len(), 4);
        assert!(
            anchored
                .iter()
                .all(|fold| fold["trainStartIndex"].as_u64() == Some(0))
        );
        assert!(
            anchored[1]["trainCount"].as_u64().unwrap()
                > anchored[0]["trainCount"].as_u64().unwrap()
        );
    }

    #[test]
    fn holdout_validation_trains_before_oos_and_does_not_leak_future_prices() {
        let mut first_input = optimization_input();
        first_input["minimumSamples"] = json!(5);
        first_input["walkForwardConfig"] = json!({
            "enabled": true,
            "mode": "holdout",
            "trainFraction": 0.8,
            "testFraction": 0.2,
            "gap": 0,
            "minimumTrainObservations": 20,
            "minimumTestObservations": 5,
        });
        let first = optimize(&first_input).unwrap();
        assert_eq!(first["robustValidation"]["status"], "completed");
        assert_eq!(
            first["robustValidation"]["leakageControl"],
            "candidates_fit_on_inner_train_only"
        );
        assert_eq!(first["robustValidation"]["inSampleObservations"], 71);
        assert_eq!(first["robustValidation"]["outOfSampleObservations"], 18);

        let mut shocked_input = first_input.clone();
        for (asset_index, series) in shocked_input["priceSeries"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .enumerate()
        {
            for (index, point) in series["points"]
                .as_array_mut()
                .unwrap()
                .iter_mut()
                .enumerate()
                .skip(72)
            {
                let old = point["value"].as_f64().unwrap();
                let direction = if asset_index == 0 { 1.0 } else { -1.0 };
                point["value"] = json!(old * (1.0 + direction * (index - 71) as f64 * 0.03));
            }
        }
        let shocked = optimize(&shocked_input).unwrap();

        let weight_set = |result: &Value| {
            result["candidates"]
                .as_array()
                .unwrap()
                .iter()
                .map(|candidate| serde_json::to_string(&candidate["weights"]).unwrap())
                .collect::<BTreeSet<_>>()
        };
        assert_eq!(weight_set(&first), weight_set(&shocked));
        assert!(
            first["candidates"]
                .as_array()
                .unwrap()
                .iter()
                .all(|candidate| {
                    candidate["sampleCount"].as_u64().unwrap() == 71
                        && candidate["robustScoreDetail"]["outOfSampleScore"].is_number()
                        && candidate["walkForwardTestCoverage"].as_f64().unwrap() > 0.0
                })
        );
        let first_oos = first["candidates"]
            .as_array()
            .unwrap()
            .iter()
            .map(|candidate| candidate["robustScoreDetail"]["outOfSampleScore"].clone())
            .collect::<Vec<_>>();
        let shocked_oos = shocked["candidates"]
            .as_array()
            .unwrap()
            .iter()
            .map(|candidate| candidate["robustScoreDetail"]["outOfSampleScore"].clone())
            .collect::<Vec<_>>();
        assert_ne!(first_oos, shocked_oos);
    }

    #[test]
    fn candidate_robust_score_aggregates_multiple_oos_folds_without_future_leakage() {
        let mut input = optimization_input();
        input["minimumSamples"] = json!(5);
        input["walkForwardConfig"] = json!({
            "enabled": true,
            "mode": "walk_forward",
            "windowMode": "anchored",
            "trainWindow": 30,
            "testWindow": 10,
            "step": 10,
            "foldCount": 4,
            "gap": 2,
            "embargo": 3,
            "minimumTrainObservations": 20,
            "minimumTestObservations": 5,
        });
        let baseline = optimize(&input).unwrap();
        assert_eq!(baseline["robustValidation"]["mode"], "walk_forward");
        assert_eq!(baseline["robustValidation"]["windowMode"], "anchored");
        assert_eq!(baseline["robustValidation"]["foldCount"], 4);
        assert_eq!(baseline["robustValidation"]["inSampleObservations"], 30);
        assert_eq!(baseline["robustValidation"]["outOfSampleObservations"], 40);
        for candidate in baseline["candidates"].as_array().unwrap() {
            assert_eq!(candidate["sampleCount"], 30);
            assert_eq!(candidate["walkForwardSignal"]["foldCount"], 4);
            assert!(
                candidate["walkForwardSignal"]["scoredFoldCount"]
                    .as_u64()
                    .is_some_and(|value| value > 0 && value <= 4)
            );
            assert_eq!(
                candidate["robustScoreDetail"]["validation"]["mode"],
                "walk_forward"
            );
            assert_eq!(candidate["robustScoreDetail"]["validation"]["foldCount"], 4);
            assert!(
                candidate["robustScoreDetail"]["validation"]["scoredFoldCount"]
                    .as_u64()
                    .is_some_and(|value| value > 0 && value <= 4)
            );
            assert!(candidate["robustScoreDetail"]["validation"]["componentCoverage"]
                ["oosAverageSharpe"]
                .as_f64()
                .is_some_and(|value| value > 0.0));
            let components = candidate["robustScoreDetail"]["components"]
                .as_array()
                .unwrap();
            assert_eq!(
                components
                    .iter()
                    .filter(|component| component["source"] == "oos")
                    .count(),
                3
            );
        }

        let mut shocked_input = input.clone();
        for (asset_index, series) in shocked_input["priceSeries"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .enumerate()
        {
            for (index, point) in series["points"]
                .as_array_mut()
                .unwrap()
                .iter_mut()
                .enumerate()
                .skip(31)
            {
                let old = point["value"].as_f64().unwrap();
                let direction = if asset_index == 0 { 1.0 } else { -1.0 };
                point["value"] = json!(old * (1.0 + direction * (index - 30) as f64 * 0.02));
            }
        }
        let shocked = optimize(&shocked_input).unwrap();
        let weight_set = |result: &Value| {
            result["candidates"]
                .as_array()
                .unwrap()
                .iter()
                .map(|candidate| serde_json::to_string(&candidate["weights"]).unwrap())
                .collect::<BTreeSet<_>>()
        };
        assert_eq!(weight_set(&baseline), weight_set(&shocked));
        let oos_scores = |result: &Value| {
            result["candidates"]
                .as_array()
                .unwrap()
                .iter()
                .map(|candidate| candidate["robustScoreDetail"]["outOfSampleScore"].clone())
                .collect::<Vec<_>>()
        };
        assert_ne!(oos_scores(&baseline), oos_scores(&shocked));
    }

    #[test]
    fn constraints_are_respected() {
        let result = optimize(&optimization_input()).unwrap();
        assert!(result["candidateCount"].as_u64().unwrap() > 0);
        for candidate in result["candidates"].as_array().unwrap() {
            let weight = candidate["weights"]["A"].as_f64().unwrap_or(0.0);
            assert!((0.2..=0.4).contains(&weight));
        }
    }

    #[test]
    fn all_requested_baselines_are_screened_and_explain_robust_score() {
        let result = optimize(&optimization_input()).unwrap();
        let sources = result["candidates"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|candidate| candidate["candidateSource"].as_str())
            .collect::<BTreeSet<_>>();
        for baseline in BASELINE_NAMES {
            assert!(sources.contains(format!("baseline:{baseline}").as_str()));
        }
        assert_eq!(result["baselineCandidateCount"], 7);
        let detail = &result["candidates"][0]["robustScoreDetail"];
        assert!(detail["inSampleScore"].is_number());
        assert_eq!(detail["components"].as_array().unwrap().len(), 9);
        assert!(detail["coverage"].as_f64().unwrap() <= 1.0);
    }

    #[test]
    fn herc_clusters_then_balances_risk_inside_and_between_clusters() {
        let covariance = clustered_covariance();
        let clusters = herc_partition(&covariance).unwrap();
        assert_eq!(clusters, vec![vec![0, 1, 2], vec![3, 4, 5]]);

        let first = hierarchical_equal_risk_contribution(&covariance).unwrap();
        let second = hierarchical_equal_risk_contribution(&covariance).unwrap();
        assert_eq!(first, second);
        assert!(
            first
                .iter()
                .all(|weight| weight.is_finite() && *weight >= 0.0)
        );
        assert!((first.iter().sum::<f64>() - 1.0).abs() < 1e-12);

        let within_weights = clusters
            .iter()
            .map(|cluster| {
                let total = cluster.iter().map(|asset| first[*asset]).sum::<f64>();
                cluster
                    .iter()
                    .map(|asset| first[*asset] / total)
                    .collect::<Vec<_>>()
            })
            .collect::<Vec<_>>();
        for (cluster, weights) in clusters.iter().zip(&within_weights) {
            let contributions =
                normalized_risk_contributions(weights, &covariance_submatrix(&covariance, cluster));
            let minimum = contributions.iter().copied().fold(f64::INFINITY, f64::min);
            let maximum = contributions
                .iter()
                .copied()
                .fold(f64::NEG_INFINITY, f64::max);
            assert!(
                maximum - minimum < 1e-7,
                "within-cluster ERC: {contributions:?}"
            );
        }

        let cluster_covariance = herc_cluster_covariance(&covariance, &clusters, &within_weights);
        let cluster_weights = clusters
            .iter()
            .map(|cluster| cluster.iter().map(|asset| first[*asset]).sum::<f64>())
            .collect::<Vec<_>>();
        let cluster_contributions =
            normalized_risk_contributions(&cluster_weights, &cluster_covariance);
        assert!(
            (cluster_contributions[0] - cluster_contributions[1]).abs() < 1e-7,
            "cluster-level ERC: {cluster_contributions:?}"
        );
    }

    #[test]
    fn herc_is_not_an_hrp_or_global_erc_alias_on_clustered_risk() {
        let covariance = clustered_covariance();
        let herc = hierarchical_equal_risk_contribution(&covariance).unwrap();
        let hrp = portfolio_math::hrp(&covariance).unwrap();
        let erc = portfolio_math::risk_parity(&covariance).unwrap();
        let l1_distance = |left: &[f64], right: &[f64]| {
            left.iter()
                .zip(right)
                .map(|(left, right)| (left - right).abs())
                .sum::<f64>()
        };
        assert!(l1_distance(&herc, &hrp) > 1e-3);
        assert!(l1_distance(&herc, &erc) > 1e-3);
    }

    #[test]
    fn every_advanced_algorithm_is_seed_deterministic_and_generates_candidates() {
        for algorithm in ["differential_evolution", "cma_es", "nsga_ii", "direct_cvar"] {
            let mut input = optimization_input();
            input["algorithm"] = json!(algorithm);
            input["baselines"] = json!([]);
            input["candidateBudget"] = json!(24);
            let first = optimize(&input).unwrap();
            let second = optimize(&input).unwrap();
            assert_eq!(first, second, "algorithm {algorithm} must be deterministic");
            assert!(first["candidateCount"].as_u64().unwrap() > 0);
            assert!(
                first["candidates"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(|candidate| { candidate["candidateSource"].as_str() == Some(algorithm) })
            );
        }
    }

    #[test]
    fn de_and_cma_es_selection_honor_the_requested_training_objective() {
        let (frame, benchmark) = objective_tradeoff_frame();
        let covariance =
            covariance_matrix(&frame.returns, frame.ids.len(), CovarianceEstimator::Sample);
        let (constraints, _) = normalize_constraints(None, frame.ids.len());
        let config_value = json!({"algorithm": "differential_evolution", "baselines": []});
        let config = parse_v2_config(config_value.as_object().unwrap()).unwrap();
        let robust_weights = default_robust_weights();
        let options = EvaluationOptions {
            benchmark: Some(&benchmark),
            oos_frame: None,
            annualization: 252.0,
            confidence: 0.95,
            minimum_samples: 20,
            risk_free_percent: 0.0,
            windows: &[],
            validation_config: None,
            constraints: &constraints,
            transaction_cost_bps: 0.0,
            robust_weights: &robust_weights,
        };

        let high_risk = Weights::from_dense(&frame.ids, &[1.0, 0.0, 0.0]);
        let low_risk = Weights::from_dense(&frame.ids, &[0.0, 1.0, 0.0]);
        assert!(
            training_objective_fitness(&frame, &high_risk, "max_sharpe", &options)
                > training_objective_fitness(&frame, &low_risk, "max_sharpe", &options)
        );
        assert!(
            training_objective_fitness(&frame, &low_risk, "min_volatility", &options)
                > training_objective_fitness(&frame, &high_risk, "min_volatility", &options)
        );
        for objective in OBJECTIVES {
            assert!(
                training_objective_fitness(&frame, &high_risk, objective, &options).is_finite(),
                "training fitness must support {objective}"
            );
        }

        for algorithm in [Algorithm::DifferentialEvolution, Algorithm::CmaEs] {
            let generate = |objective: &str| {
                let mut rng = Mulberry32::new(41_337);
                let candidates = match algorithm {
                    Algorithm::DifferentialEvolution => differential_evolution_candidates(
                        &mut rng,
                        &frame,
                        &constraints,
                        &config,
                        (objective, &options),
                        180,
                    ),
                    Algorithm::CmaEs => cma_es_candidates(
                        &mut rng,
                        &frame,
                        &covariance,
                        &constraints,
                        &config,
                        (objective, &options),
                        180,
                    ),
                    _ => unreachable!(),
                };
                candidates
                    .into_iter()
                    .map(|(weights, _)| signature(&weights))
                    .collect::<Vec<_>>()
            };
            let sharpe_candidates = generate("max_sharpe");
            let volatility_candidates = generate("min_volatility");
            assert_ne!(
                sharpe_candidates,
                volatility_candidates,
                "{} selection path must change with the requested objective",
                algorithm.as_str()
            );
        }

        let mut input = optimization_input();
        input["algorithm"] = json!("cma_es");
        input["baselines"] = json!([]);
        input["objective"] = json!("min_volatility");
        input["candidateBudget"] = json!(24);
        let result = optimize(&input).unwrap();
        assert_eq!(
            result["algorithmDetails"]["searchObjective"],
            "min_volatility"
        );
        assert_eq!(
            result["algorithmDetails"]["searchProxy"],
            "training_only_min_volatility"
        );
    }

    #[test]
    fn advanced_search_rejects_an_unknown_objective() {
        let mut input = optimization_input();
        input["algorithm"] = json!("differential_evolution");
        input["objective"] = json!("not_an_objective");
        assert!(
            optimize(&input)
                .unwrap_err()
                .to_string()
                .contains("objective")
        );
    }

    #[test]
    fn ledoit_wolf_and_group_constraints_are_applied_deterministically() {
        let mut input = optimization_input();
        input["covarianceEstimator"] = json!("ledoit_wolf");
        input["assetGroups"] = json!({
            "A": {"sector": "growth"},
            "B": {"sector": "growth"},
            "C": {"sector": "defensive"},
        });
        input["groupConstraints"] = json!([
            {"dimension": "sector", "group": "growth", "minWeight": 0.4, "maxWeight": 0.6},
            {"dimension": "sector", "group": "defensive", "minWeight": 0.4, "maxWeight": 0.6},
        ]);
        let first = optimize(&input).unwrap();
        let second = optimize(&input).unwrap();
        assert_eq!(first, second);
        assert_eq!(first["covarianceEstimator"], "ledoit_wolf");
        for candidate in first["candidates"].as_array().unwrap() {
            let growth = candidate["weights"]["A"].as_f64().unwrap_or(0.0)
                + candidate["weights"]["B"].as_f64().unwrap_or(0.0);
            let defensive = candidate["weights"]["C"].as_f64().unwrap_or(0.0);
            assert!((0.4 - 1e-8..=0.6 + 1e-8).contains(&growth));
            assert!((0.4 - 1e-8..=0.6 + 1e-8).contains(&defensive));
        }
    }

    #[test]
    fn group_repair_reserves_required_capacity_under_max_assets() {
        let ids = vec!["A".to_owned(), "B".to_owned(), "C".to_owned()];
        let constraints_value = json!({"maxAssets": 2, "maxWeight": 0.6});
        let (constraints, _) = normalize_constraints(Some(&constraints_value), ids.len());
        let groups = parse_asset_groups(Some(&json!({
            "A": {"sector": "growth"},
            "B": {"sector": "growth"},
            "C": {"sector": "defensive"},
        })));
        let group_constraints = parse_group_constraints(Some(&json!([
            {"dimension": "sector", "group": "defensive", "minWeight": 0.4, "maxWeight": 0.6}
        ])))
        .unwrap();
        let weights = repair_dense_weights(
            &[10.0, 9.0, 0.01],
            &ids,
            &constraints,
            &group_constraints,
            &groups,
        )
        .unwrap();
        assert!(weights.get("C") >= 0.4 - 1e-9);
        assert!(weights.0.len() <= 2);
    }

    #[test]
    fn overlapping_walk_forward_windows_have_unique_capped_coverage() {
        let mut input = optimization_input();
        input["walkForwardConfig"] = json!({
            "trainWindow": 10,
            "testWindow": 20,
            "step": 1,
            "minimumTrainObservations": 10,
            "minimumTestObservations": 20,
        });
        let result = optimize(&input).unwrap();
        for candidate in result["candidates"].as_array().unwrap() {
            assert!(candidate["walkForwardTestCoverage"].as_f64().unwrap() <= 1.0);
        }
        assert!(result["candidates"][0]["robustScoreDetail"]["outOfSampleScore"].is_number());
    }

    #[test]
    fn ledger_validation_exposes_screening_deltas_and_rank_changes() {
        let mut input = optimization_input();
        input["candidateBudget"] = json!(10);
        input["ledgerValidationBudget"] = json!(3);
        input["ledgerTemplate"] = ledger_template();
        let result = optimize(&input).unwrap();
        assert_eq!(result["ledgerValidation"]["selectedCount"], 3);
        assert_eq!(result["ledgerValidation"]["failedCount"], 0);
        let validated = result["ledgerValidatedCandidates"].as_array().unwrap();
        assert_eq!(validated.len(), 3);
        for candidate in validated {
            assert_eq!(candidate["validationStatus"], "not_requested");
            assert_eq!(candidate["ledgerValidationStatus"], "completed");
            assert!(candidate["screeningRank"].is_number());
            assert!(candidate["ledgerRank"].is_number());
            assert!(candidate["rankChange"].is_number());
            assert!(candidate["screeningMetrics"].is_object());
            assert!(candidate["ledgerMetrics"].is_object());
            assert!(candidate["metricDelta"].is_object());
        }
    }

    #[test]
    fn ledger_candidate_weights_preserve_template_cash_target() {
        let mut template = ledger_template();
        template["execution"] = json!({"cashTargetPercent": 12.5});
        let candidate = json!({"weights": {"A": 0.5, "B": 0.3, "C": 0.2}});
        let input = ledger_input_for_candidate(&template, &candidate).unwrap();
        assert!((input.execution.cash_target_percent - 12.5).abs() < 1e-12);
        assert!((input.assets.iter().map(|asset| asset.weight).sum::<f64>() - 87.5).abs() < 1e-9);
    }

    fn adaptive_policy(result: &Value) -> &Value {
        result["regimePolicySearch"]["policies"]
            .as_array()
            .unwrap()
            .iter()
            .find(|policy| {
                policy["id"]
                    .as_str()
                    .is_some_and(|id| id.starts_with("adaptive:"))
            })
            .unwrap()
    }

    #[test]
    fn regime_policy_dp_is_past_only_deterministic_and_ledger_validated() {
        let mut input = optimization_input();
        input["candidateBudget"] = json!(10);
        input["ledgerTemplate"] = ledger_template();
        input["regimePolicySearch"] = json!({
            "enabled": true,
            "method": "dynamic_programming",
            "states": 3,
            "lookback": 10,
            "rebalanceEvery": 10,
            "trainFraction": 0.5,
            "minimumTrainingDecisions": 4,
            "maxDepth": 6,
            "switchingCostBps": 5.0,
            "ledgerValidationBudget": 2
        });
        let first = optimize(&input).unwrap();
        let second = optimize(&input).unwrap();
        assert_eq!(first, second);
        let search = &first["regimePolicySearch"];
        assert_eq!(search["status"], "completed");
        assert_eq!(search["effectiveMethod"], "dynamic_programming");
        assert_eq!(search["noLookahead"]["policyFrozenForOos"], true);
        assert_eq!(search["ledgerValidation"]["selectedCount"], 2);
        assert_eq!(search["ledgerValidation"]["completedCount"], 2);
        assert!(adaptive_policy(&first)["ledgerMetrics"]["finalBalance"].is_number());
        let artifacts = first["regimePolicyArtifact"].as_array().unwrap();
        assert_eq!(artifacts.len(), 8);
        for decision in artifacts[0]["oosDecisionTrace"].as_array().unwrap() {
            assert!(
                decision["signalCutoffDate"].as_str().unwrap() < decision["date"].as_str().unwrap()
            );
        }
    }

    #[test]
    fn regime_policy_fit_does_not_change_when_only_late_oos_prices_change() {
        let mut input = optimization_input();
        input["candidateBudget"] = json!(8);
        input["regimePolicySearch"] = json!({
            "enabled": true,
            "method": "dynamic_programming",
            "states": 3,
            "lookback": 10,
            "rebalanceEvery": 10,
            "trainFraction": 0.5,
            "minimumTrainingDecisions": 4,
            "maxDepth": 6
        });
        let original = optimize(&input).unwrap();
        let mut changed = input;
        for series in changed["priceSeries"].as_array_mut().unwrap() {
            for point in &mut series["points"].as_array_mut().unwrap()[60..] {
                let value = point["value"].as_f64().unwrap();
                point["value"] = json!(value * 1.0_f64.max(1.0 + (value / 7.0).sin() * 0.2));
            }
        }
        let changed = optimize(&changed).unwrap();
        let original_policy = adaptive_policy(&original);
        let changed_policy = adaptive_policy(&changed);
        assert_eq!(
            original_policy["statePreviousActionMap"],
            changed_policy["statePreviousActionMap"]
        );
        assert_eq!(
            original_policy["trainingMetrics"],
            changed_policy["trainingMetrics"]
        );
    }

    #[test]
    fn regime_policy_mcts_is_seed_deterministic() {
        let mut input = optimization_input();
        input["candidateBudget"] = json!(8);
        input["regimePolicySearch"] = json!({
            "enabled": true,
            "method": "mcts",
            "states": ["risk_off", "neutral", "risk_on"],
            "lookback": 10,
            "rebalanceEvery": 10,
            "trainFraction": 0.5,
            "minimumTrainingDecisions": 4,
            "maxDepth": 4,
            "rollouts": 64,
            "explorationConstant": std::f64::consts::SQRT_2
        });
        let first = optimize(&input).unwrap();
        let second = optimize(&input).unwrap();
        assert_eq!(first, second);
        assert_eq!(first["regimePolicySearch"]["effectiveMethod"], "mcts");
        assert_eq!(
            first["regimePolicySearch"]["implementation"],
            "uct_tree_search_empirical_markov_model"
        );
    }

    #[test]
    fn metric_evaluation_is_independent_of_rayon_thread_count() {
        let input = optimization_input();
        let single = ThreadPoolBuilder::new()
            .num_threads(1)
            .build()
            .unwrap()
            .install(|| optimize(&input).unwrap());
        let parallel = ThreadPoolBuilder::new()
            .num_threads(4)
            .build()
            .unwrap()
            .install(|| optimize(&input).unwrap());
        assert_eq!(single, parallel);
    }

    #[test]
    fn transaction_cost_is_deducted_before_candidate_objectives_are_ranked() {
        let mut zero_cost = optimization_input();
        zero_cost["constraints"]["currentWeights"] = json!({"A": 1.0, "B": 0.0, "C": 0.0});
        zero_cost["transactionCostBps"] = json!(0.0);
        let mut high_cost = zero_cost.clone();
        high_cost["transactionCostBps"] = json!(500.0);

        let zero = optimize(&zero_cost).unwrap();
        let costly = optimize(&high_cost).unwrap();
        let costly_by_weights = costly["candidates"]
            .as_array()
            .unwrap()
            .iter()
            .map(|candidate| (candidate["weights"].to_string(), candidate))
            .collect::<BTreeMap<_, _>>();
        let zero_candidate = zero["candidates"]
            .as_array()
            .unwrap()
            .iter()
            .find(|candidate| candidate["metrics"]["turnover"].as_f64().unwrap_or(0.0) > 0.0)
            .unwrap();
        let costly_candidate = costly_by_weights[&zero_candidate["weights"].to_string()];

        assert_eq!(zero_candidate["metrics"]["transactionCost"], 0.0);
        assert!(
            costly_candidate["metrics"]["transactionCost"]
                .as_f64()
                .unwrap()
                > 0.0
        );
        assert!(
            costly_candidate["metrics"]["return"].as_f64().unwrap()
                < zero_candidate["metrics"]["return"].as_f64().unwrap()
        );
    }

    fn pareto_candidate(
        portfolio_return: Option<f64>,
        volatility: Option<f64>,
        turnover: f64,
    ) -> Value {
        json!({
            "metrics": {
                "return": portfolio_return,
                "volatility": volatility,
                "maxDrawdown": null,
                "cvar": null,
                "turnover": turnover,
                "transactionCost": 0.0,
            },
        })
    }

    #[test]
    fn pareto_preserves_input_order_and_ignores_null_dimensions() {
        let best = pareto_candidate(Some(0.2), Some(0.1), 0.1);
        let dominated = pareto_candidate(Some(0.1), Some(0.2), 0.2);
        let incomparable = pareto_candidate(None, Some(0.05), 0.3);
        let frontier = pareto(&[best.clone(), dominated, incomparable.clone()]);
        assert_eq!(frontier, vec![best, incomparable]);
    }

    #[test]
    fn typed_incremental_pareto_matches_brute_force_for_complete_metrics() {
        let candidates = (0..80)
            .map(|index| {
                let index = index as f64;
                json!({"metrics": {
                    "return": index.sin() * 0.1,
                    "volatility": 0.05 + (index * 1.7).cos().abs() * 0.2,
                    "maxDrawdown": -0.02 - (index * 0.3).sin().abs() * 0.3,
                    "cvar": -0.01 - (index * 0.11).cos().abs() * 0.08,
                    "turnover": (index % 13.0) / 13.0,
                    "transactionCost": (index % 7.0) / 1000.0,
                }})
            })
            .collect::<Vec<_>>();
        let points = candidates
            .iter()
            .map(ParetoPoint::from_candidate)
            .collect::<Vec<_>>();
        let brute_force =
            candidates
                .iter()
                .enumerate()
                .filter(|(index, _)| {
                    !points.iter().copied().enumerate().any(|(other, point)| {
                        other != *index && typed_dominates(point, points[*index])
                    })
                })
                .map(|(_, candidate)| candidate.clone())
                .collect::<Vec<_>>();
        assert_eq!(pareto(&candidates), brute_force);
    }

    #[test]
    fn typed_pareto_handles_large_dominated_chains_without_quadratic_json_work() {
        let candidates = (0..2_000)
            .map(|index| {
                let value = index as f64;
                json!({"metrics": {
                    "return": value,
                    "volatility": 2_000.0 - value,
                    "maxDrawdown": -(2_000.0 - value),
                    "cvar": -(2_000.0 - value),
                    "turnover": 2_000.0 - value,
                    "transactionCost": 2_000.0 - value,
                }})
            })
            .collect::<Vec<_>>();
        let frontier = pareto(&candidates);
        assert_eq!(frontier, vec![candidates.last().unwrap().clone()]);
    }

    #[test]
    fn excluded_required_asset_is_rejected() {
        let mut input = optimization_input();
        input["constraints"] = json!({
            "requiredAssets": ["A"],
            "excludedAssets": ["A"],
        });
        assert!(optimize(&input).is_err());
    }

    #[test]
    fn cooperative_control_preserves_results_and_stops_impossible_generation() {
        let input = optimization_input();
        assert_eq!(
            optimize_with_control(&input, Some(&NeverStop)).unwrap(),
            optimize(&input).unwrap()
        );

        let mut impossible = input;
        impossible["candidateBudget"] = json!(10_000);
        impossible["constraints"] = json!({"maxAssets": 1, "maxWeight": 0.5});
        let control = StopAfter {
            remaining: AtomicUsize::new(3),
        };
        assert!(
            optimize_with_control(&impossible, Some(&control))
                .unwrap_err()
                .to_string()
                .contains("TEST_OPTIMIZATION_CANCELLED")
        );
    }
}
