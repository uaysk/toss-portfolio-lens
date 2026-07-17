use std::cmp::Ordering;
use std::collections::{BTreeMap, HashSet};

use anyhow::{Context, Result, bail};
use rayon::prelude::*;
use serde_json::{Map, Value, json};

use crate::control::{ComputeControl, checkpoint};

const DEFAULT_SEED: u64 = 0xC0FFEE;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const DEFAULT_BATCH_SIZE: usize = 512;
const OBJECTIVES: [&str; 7] = [
    "max_sharpe",
    "max_sortino",
    "max_calmar",
    "min_volatility",
    "min_cvar",
    "max_information_ratio",
    "robust_score",
];

#[derive(Debug, Clone)]
struct Mulberry32 {
    state: u32,
}

impl Mulberry32 {
    fn new(seed: u64) -> Self {
        let mut state = seed as u32;
        if state == 0 {
            state = 0x6D2B79F5;
        }
        Self { state }
    }

    fn next(&mut self) -> f64 {
        self.state = self.state.wrapping_add(0x6D2B79F5);
        let mut value = self.state;
        value = (value ^ (value >> 15)).wrapping_mul(value | 1);
        value ^= value.wrapping_add((value ^ (value >> 7)).wrapping_mul(value | 61));
        ((value ^ (value >> 14)) as f64) / 4_294_967_296.0
    }

    fn next_int(&mut self, maximum: usize) -> usize {
        if maximum == 0 {
            0
        } else {
            (self.next() * maximum as f64).floor() as usize
        }
    }
}

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
}

#[derive(Debug, Clone, Copy)]
struct WalkForwardWindow {
    test_start: usize,
    test_end: usize,
    test_count: usize,
}

#[derive(Debug, Clone)]
struct EvaluationOptions<'a> {
    benchmark: Option<&'a Value>,
    annualization: f64,
    confidence: f64,
    minimum_samples: usize,
    risk_free_percent: f64,
    windows: &'a [Value],
    constraints: &'a Constraints,
    transaction_cost_bps: f64,
}

fn numeric(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Number(number) => number.as_f64().filter(|value| value.is_finite()),
        Value::String(value) => value.parse::<f64>().ok().filter(|value| value.is_finite()),
        Value::Bool(value) => Some(if *value { 1.0 } else { 0.0 }),
        _ => None,
    }
}

fn positive_int(value: Option<&Value>, fallback: u64, minimum: u64, maximum: u64) -> u64 {
    let Some(value) = numeric(value) else {
        return fallback;
    };
    (value.floor().max(minimum as f64).min(maximum as f64)) as u64
}

fn decimal(value: Option<&Value>, fallback: f64, minimum: f64, maximum: f64) -> f64 {
    numeric(value).unwrap_or(fallback).clamp(minimum, maximum)
}

fn object_number_map(value: Option<&Value>, fallback: f64) -> BTreeMap<String, f64> {
    value
        .and_then(Value::as_object)
        .map(|values| {
            values
                .iter()
                .map(|(key, value)| {
                    (
                        key.clone(),
                        numeric(Some(value)).unwrap_or(fallback).clamp(0.0, 1.0),
                    )
                })
                .collect()
        })
        .unwrap_or_default()
}

fn current_weight_map(value: Option<&Value>) -> BTreeMap<String, f64> {
    value
        .and_then(Value::as_object)
        .map(|values| {
            values
                .iter()
                .filter_map(|(key, value)| numeric(Some(value)).map(|number| (key.clone(), number)))
                .collect()
        })
        .unwrap_or_default()
}

fn unique_strings(value: Option<&Value>) -> Vec<String> {
    let mut seen = HashSet::new();
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter(|item| !item.trim().is_empty())
        .filter(|item| seen.insert((*item).to_owned()))
        .map(str::to_owned)
        .collect()
}

fn walk_forward_config(config: Option<&Value>) -> (usize, usize, usize, usize, usize) {
    let config = config.and_then(Value::as_object);
    let get = |key| config.and_then(|value| value.get(key));
    let train = positive_int(get("trainWindow"), 126, 2, 10_000) as usize;
    let test = positive_int(get("testWindow"), 42, 1, 10_000) as usize;
    let step = positive_int(get("step"), test.max(1) as u64, 1, 10_000) as usize;
    let minimum_train = positive_int(
        get("minimumTrainObservations"),
        (train / 2).max(2) as u64,
        1,
        train as u64,
    ) as usize;
    let minimum_test = positive_int(
        get("minimumTestObservations"),
        (test / 2).max(1) as u64,
        1,
        test as u64,
    ) as usize;
    (train, test, step.max(1), minimum_train, minimum_test)
}

pub fn build_walk_forward_windows(total_length: usize, config: Option<&Value>) -> Vec<Value> {
    let safe_length = total_length.min(10_000_000);
    let (train, test, step, minimum_train, minimum_test) = walk_forward_config(config);
    let mut windows = Vec::new();
    if safe_length == 0 {
        return windows;
    }

    let mut train_start = 0usize;
    while train_start
        .checked_add(train)
        .and_then(|value| value.checked_add(test))
        .is_some_and(|value| value <= safe_length)
    {
        let train_end = train_start + train - 1;
        let test_start = train_end + 1;
        let test_end = test_start + test - 1;
        if test_end >= safe_length {
            break;
        }
        let train_count = train_end - train_start + 1;
        let test_count = test_end - test_start + 1;
        if train_count >= minimum_train && test_count >= minimum_test {
            windows.push(json!({
                "trainStartIndex": train_start,
                "trainEndIndex": train_end,
                "testStartIndex": test_start,
                "testEndIndex": test_end,
                "trainStart": format!("index-{train_start}"),
                "trainEnd": format!("index-{train_end}"),
                "testStart": format!("index-{test_start}"),
                "testEnd": format!("index-{test_end}"),
                "trainCount": train_count,
                "testCount": test_count,
            }));
        }
        train_start += step;
    }
    windows
}

fn valid_date(value: &str) -> bool {
    crate::date::parse_iso_date(value).is_ok()
}

fn sanitize_points(value: Option<&Value>, positive_only: bool) -> BTreeMap<String, f64> {
    let mut by_date = BTreeMap::new();
    for point in value.and_then(Value::as_array).into_iter().flatten() {
        let Some(point) = point.as_object() else {
            continue;
        };
        let Some(date) = point.get("date").and_then(Value::as_str) else {
            continue;
        };
        let Some(number) = numeric(point.get("value")) else {
            continue;
        };
        if !valid_date(date) || (positive_only && number <= 0.0) {
            continue;
        }
        by_date.insert(date.to_owned(), number);
    }
    by_date
}

fn aligned_frame(price_series: &[Value]) -> Frame {
    let mut returns_by_id: Vec<(String, BTreeMap<String, f64>)> = Vec::new();
    for series in price_series {
        let object = series.as_object();
        let id = object
            .and_then(|value| value.get("key"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let points = sanitize_points(object.and_then(|value| value.get("points")), true);
        let entries: Vec<_> = points.into_iter().collect();
        let mut returns = BTreeMap::new();
        for pair in entries.windows(2) {
            let value = pair[1].1 / pair[0].1 - 1.0;
            if value.is_finite() {
                returns.insert(pair[1].0.clone(), value);
            }
        }
        returns_by_id.push((id, returns));
    }

    let dates = returns_by_id
        .first()
        .map(|(_, first)| {
            first
                .keys()
                .filter(|date| {
                    returns_by_id
                        .iter()
                        .all(|(_, values)| values.contains_key(*date))
                })
                .cloned()
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let returns = dates
        .iter()
        .map(|date| {
            returns_by_id
                .iter()
                .map(|(_, values)| values[date])
                .collect()
        })
        .collect();
    Frame {
        ids: returns_by_id.into_iter().map(|(id, _)| id).collect(),
        dates,
        returns,
    }
}

fn normalize_constraints(raw: Option<&Value>, asset_count: usize) -> (Constraints, Vec<String>) {
    let raw = raw.and_then(Value::as_object);
    let get = |key| raw.and_then(|value| value.get(key));
    let mut warnings = Vec::new();
    let min_weight = decimal(get("minWeight"), 0.0, 0.0, 1.0);
    let mut max_weight = decimal(get("maxWeight"), 1.0, 0.0, 1.0);
    let mut max_assets = positive_int(
        get("maxAssets"),
        asset_count as u64,
        1,
        asset_count.max(1) as u64,
    ) as usize;
    if max_weight < min_weight {
        warnings
            .push("최대 비중이 최소 비중보다 작아 최소 비중을 최대 비중에 맞춥니다.".to_owned());
        max_weight = min_weight;
    }
    if max_assets > asset_count {
        max_assets = asset_count.max(1);
        warnings.push("최대 자산 수가 전체 후보 수보다 커서 전체 수로 보정했습니다.".to_owned());
    }

    let max_drawdown = numeric(get("maxDrawdown")).map(f64::abs).unwrap_or(1.0);
    let target_return = numeric(get("targetReturn")).unwrap_or(f64::NEG_INFINITY);
    let max_turnover = numeric(get("maxTurnover"))
        .map(|value| value.max(0.0))
        .unwrap_or(1.0);
    (
        Constraints {
            min_weight,
            max_weight,
            required_assets: unique_strings(get("requiredAssets")),
            excluded_assets: unique_strings(get("excludedAssets")),
            max_assets,
            min_weights: object_number_map(get("minWeights"), min_weight),
            max_weights: object_number_map(get("maxWeights"), max_weight),
            max_drawdown,
            target_return,
            max_turnover,
            current_weights: current_weight_map(get("currentWeights")),
        },
        warnings,
    )
}

fn candidate_weights(
    rng: &mut Mulberry32,
    eligible: &[String],
    required: &[String],
    constraints: &Constraints,
) -> Option<Weights> {
    let mut required_set: HashSet<&str> = required.iter().map(String::as_str).collect();
    required_set.extend(
        constraints
            .min_weights
            .iter()
            .filter_map(|(key, minimum)| (*minimum > 0.0).then_some(key.as_str())),
    );
    let available: Vec<&String> = eligible
        .iter()
        .filter(|item| {
            !item.is_empty()
                && !constraints
                    .excluded_assets
                    .iter()
                    .any(|value| value == *item)
        })
        .collect();
    if available.is_empty() {
        return None;
    }
    let mandatory: Vec<&String> = available
        .iter()
        .copied()
        .filter(|item| required_set.contains(item.as_str()))
        .collect();
    if mandatory.len() > constraints.max_assets {
        return None;
    }
    let max_count = constraints.max_assets.min(available.len());
    let min_count = mandatory.len().max(1);
    let chosen_count = min_count + rng.next_int(max_count - min_count + 1);
    let mut candidate_ids = mandatory;
    let mut shuffled = available;
    for index in (1..shuffled.len()).rev() {
        let swap = rng.next_int(index + 1);
        shuffled.swap(index, swap);
    }
    for item in shuffled {
        if candidate_ids.contains(&item) {
            continue;
        }
        if candidate_ids.len() >= chosen_count {
            break;
        }
        candidate_ids.push(item);
    }
    if candidate_ids.is_empty() {
        return None;
    }

    let minimums: Vec<f64> = candidate_ids
        .iter()
        .map(|item| {
            constraints
                .min_weight
                .max(*constraints.min_weights.get(item.as_str()).unwrap_or(&0.0))
        })
        .collect();
    let maximums: Vec<f64> = candidate_ids
        .iter()
        .map(|item| {
            constraints
                .max_weight
                .min(*constraints.max_weights.get(item.as_str()).unwrap_or(&1.0))
        })
        .collect();
    if minimums
        .iter()
        .zip(&maximums)
        .any(|(minimum, maximum)| minimum > maximum)
    {
        return None;
    }
    let minimum_total: f64 = minimums.iter().sum();
    let maximum_total: f64 = maximums.iter().sum();
    if minimum_total > 1.0 + 1e-12 || maximum_total < 1.0 - 1e-12 {
        return None;
    }

    let mut values = minimums;
    let mut residual = 1.0 - minimum_total;
    for _ in 0..100 {
        if residual <= 1e-12 {
            break;
        }
        let active: Vec<usize> = (0..candidate_ids.len())
            .filter(|index| maximums[*index] - values[*index] > 1e-12)
            .collect();
        if active.is_empty() {
            return None;
        }
        let raw: Vec<f64> = active.iter().map(|_| 1.0 + rng.next()).collect();
        let raw_total: f64 = raw.iter().sum();
        let mut distributed = 0.0;
        for (raw_index, candidate_index) in active.into_iter().enumerate() {
            let capacity = maximums[candidate_index] - values[candidate_index];
            let addition = capacity.min(residual * raw[raw_index] / raw_total);
            values[candidate_index] += addition;
            distributed += addition;
        }
        if distributed <= 1e-14 {
            return None;
        }
        residual -= distributed;
    }
    if residual > 1e-9 {
        return None;
    }
    Some(Weights(
        candidate_ids
            .into_iter()
            .zip(values)
            .map(|(id, value)| (id.clone(), value))
            .collect(),
    ))
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
            let count = window.get("testCount")?.as_u64()? as usize;
            (start <= end && start < observations).then_some(WalkForwardWindow {
                test_start: start,
                test_end: end.min(observations.saturating_sub(1)),
                test_count: count,
            })
        })
        .collect()
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

    let windows = parsed_windows(options.windows, observations);
    let mut total_test = 0usize;
    let mut window_sharpes = Vec::new();
    let mut window_cvars = Vec::new();
    for window in &windows {
        let test = &portfolio[window.test_start..=window.test_end];
        if test.is_empty() {
            continue;
        }
        total_test += window.test_count;
        if test.len() >= options.minimum_samples {
            let test_deviation = sample_std(test);
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
            if let Some(threshold) = quantile_linear(test, 1.0 - options.confidence) {
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
    let coverage = total_test as f64 / observations.max(1) as f64;

    let mut metrics = Map::new();
    metrics.insert("sharpe".to_owned(), nullable(sharpe));
    metrics.insert("sortino".to_owned(), nullable(sortino));
    metrics.insert("calmar".to_owned(), nullable(calmar));
    metrics.insert("volatility".to_owned(), nullable(volatility));
    metrics.insert("cvar".to_owned(), nullable(cvar));
    metrics.insert("informationRatio".to_owned(), nullable(information_ratio));
    metrics.insert("robustScore".to_owned(), Value::Null);
    metrics.insert("return".to_owned(), nullable(cagr));
    metrics.insert("maxDrawdown".to_owned(), nullable(max_drawdown));
    metrics.insert("turnover".to_owned(), json!(turnover));
    metrics.insert("transactionCost".to_owned(), json!(transaction_cost));

    let metric = |key: &str| metrics.get(key).and_then(Value::as_f64);
    let robust_values = [
        metric("sharpe"),
        metric("sortino"),
        metric("calmar"),
        metric("volatility"),
        metric("cvar"),
        metric("informationRatio"),
        average_sharpe,
        worst_sharpe,
        average_cvar,
    ];
    if robust_values
        .iter()
        .flatten()
        .any(|value| value.is_finite())
    {
        let score = 0.16 * metric("sharpe").map_or(0.0, |value| (value / 2.0).tanh())
            + 0.14 * metric("sortino").map_or(0.0, |value| (value / 2.0).tanh())
            + 0.12 * metric("calmar").map_or(0.0, f64::tanh)
            + 0.12 * metric("volatility").map_or(0.0, |value| 1.0 / (1.0 + value))
            + 0.12 * metric("cvar").map_or(0.0, |value| 1.0 / (1.0 + value.abs()))
            + 0.08 * metric("informationRatio").map_or(0.0, |value| (value / 2.0).tanh())
            + 0.10 * average_sharpe.map_or(0.0, |value| (value / 2.0).tanh())
            + 0.10 * worst_sharpe.map_or(0.0, |value| (value / 2.0).tanh())
            + 0.06 * average_cvar.map_or(0.0, |value| 1.0 / (1.0 + value.abs()));
        if score.is_finite() {
            metrics.insert("robustScore".to_owned(), json!(score));
        }
    }

    json!({
        "weights": weights.to_json(),
        "sampleCount": observations,
        "metrics": metrics,
        "walkForwardTestCoverage": coverage,
        "walkForwardSignal": {
            "averageSharpe": average_sharpe,
            "worstSharpe": worst_sharpe,
            "averageCvar": average_cvar,
        },
    })
}

fn better(left: &Value, right: &Value, objective: &str) -> bool {
    let key = match objective {
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

fn dominates(left: &Value, right: &Value) -> bool {
    let dimensions = [
        (
            as_metric(left, "return"),
            as_metric(right, "return"),
            true,
            false,
        ),
        (
            as_metric(left, "volatility"),
            as_metric(right, "volatility"),
            false,
            false,
        ),
        (
            as_metric(left, "maxDrawdown"),
            as_metric(right, "maxDrawdown"),
            false,
            true,
        ),
        (
            as_metric(left, "cvar"),
            as_metric(right, "cvar"),
            false,
            true,
        ),
        (
            as_metric(left, "turnover"),
            as_metric(right, "turnover"),
            false,
            false,
        ),
        (
            as_metric(left, "transactionCost"),
            as_metric(right, "transactionCost"),
            false,
            false,
        ),
    ];
    let mut comparable = 0usize;
    let mut strictly_better = false;
    for (left, right, maximize, absolute) in dimensions {
        let (Some(mut left), Some(mut right)) = (left, right) else {
            continue;
        };
        if absolute {
            left = left.abs();
            right = right.abs();
        }
        comparable += 1;
        if maximize {
            if left < right {
                return false;
            }
            strictly_better |= left > right;
        } else {
            if left > right {
                return false;
            }
            strictly_better |= left < right;
        }
    }
    comparable > 0 && strictly_better
}

pub fn pareto(candidates: &[Value]) -> Vec<Value> {
    let dominated: Vec<bool> = candidates
        .par_iter()
        .enumerate()
        .map(|(index, candidate)| {
            candidates
                .iter()
                .enumerate()
                .any(|(test, other)| test != index && dominates(other, candidate))
        })
        .collect();
    candidates
        .iter()
        .zip(dominated)
        .filter(|(_, dominated)| !dominated)
        .map(|(candidate, _)| candidate.clone())
        .collect()
}

fn pareto_with_control(
    candidates: &[Value],
    control: Option<&dyn ComputeControl>,
) -> Result<Vec<Value>> {
    if control.is_none() {
        return Ok(pareto(candidates));
    }
    let dominated = candidates
        .par_iter()
        .enumerate()
        .map(|(index, candidate)| -> Result<bool> {
            checkpoint(control)?;
            for (test, other) in candidates.iter().enumerate() {
                if test % 256 == 0 {
                    checkpoint(control)?;
                }
                if test != index && dominates(other, candidate) {
                    return Ok(true);
                }
            }
            Ok(false)
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(candidates
        .iter()
        .zip(dominated)
        .filter(|(_, dominated)| !dominated)
        .map(|(candidate, _)| candidate.clone())
        .collect())
}

fn candidate_is_valid(candidate: &Value, constraints: &Constraints) -> bool {
    let Some(weights) = candidate.get("weights").and_then(Value::as_object) else {
        return false;
    };
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

pub fn optimize(input: &Value) -> Result<Value> {
    optimize_with_control(input, None)
}

pub fn optimize_with_control(input: &Value, control: Option<&dyn ComputeControl>) -> Result<Value> {
    checkpoint(control)?;
    let input = input
        .as_object()
        .context("optimization input must be a JSON object")?;
    let get = |key| input.get(key);
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
    let future_warning = get("walkForwardConfig")
        .filter(|value| !value.is_null())
        .map(|_| None)
        .unwrap_or_else(|| {
            Some("walk-forward 설정이 없어 전 구간 최적화입니다. 미래 누수(look-ahead) 위험이 존재합니다.")
        });
    let frame = aligned_frame(price_series);
    checkpoint(control)?;
    let windows = get("walkForwardConfig")
        .filter(|value| !value.is_null())
        .map(|config| build_walk_forward_windows(frame.dates.len(), Some(config)))
        .unwrap_or_default();
    if frame.dates.is_empty() {
        warnings.push("공통 기간 교집합 데이터가 없습니다.".to_owned());
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
    let max_attempts = candidate_budget * 40;
    let transaction_cost_bps = numeric(get("transactionCostBps"))
        .unwrap_or(0.0)
        .clamp(0.0, 500.0);
    let benchmark = get("benchmark").filter(|value| value.is_object());
    let mut seen = HashSet::new();
    let mut candidates = Vec::new();
    let mut best: BTreeMap<&str, Option<Value>> = OBJECTIVES
        .into_iter()
        .map(|objective| (objective, None))
        .collect();
    let mut attempts = 0usize;
    let options = EvaluationOptions {
        benchmark,
        annualization,
        confidence,
        minimum_samples,
        risk_free_percent: risk_free,
        windows: &windows,
        constraints: &constraints,
        transaction_cost_bps,
    };

    while attempts < max_attempts && candidates.len() < candidate_budget {
        checkpoint(control)?;
        let mut generated = Vec::with_capacity(DEFAULT_BATCH_SIZE);
        while attempts < max_attempts && generated.len() < DEFAULT_BATCH_SIZE {
            attempts += 1;
            if attempts.is_multiple_of(256) {
                checkpoint(control)?;
            }
            let Some(weights) =
                candidate_weights(&mut rng, &available, &required_in_scope, &constraints)
            else {
                continue;
            };
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
                Ok(evaluate_candidate(&frame, weights, &options))
            })
            .collect::<Result<Vec<_>>>()?;
        for candidate in evaluated {
            checkpoint(control)?;
            if !candidate_is_valid(&candidate, &constraints) {
                continue;
            }
            for objective in OBJECTIVES {
                let replace = best[objective]
                    .as_ref()
                    .is_none_or(|current| better(&candidate, current, objective));
                if replace {
                    best.insert(objective, Some(candidate.clone()));
                }
            }
            if windows.is_empty()
                && candidate
                    .get("sampleCount")
                    .and_then(Value::as_u64)
                    .is_some_and(|count| count < minimum_samples as u64)
            {
                warnings.push(format!(
                    "샘플수가 부족한 조합이 생성되었습니다. ({}개) 경고 반영.",
                    candidate["sampleCount"]
                ));
            }
            candidates.push(candidate);
            if candidates.len() >= candidate_budget {
                break;
            }
        }
    }

    if candidates.is_empty() {
        warnings
            .push("조건을 만족하는 후보가 없습니다. 제약값/샘플수/예산을 완화하세요.".to_owned());
    }
    let frontier = pareto_with_control(&candidates, control)?;
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
    if windows.is_empty() {
        let (_, _, _, minimum_train, _) = walk_forward_config(get("walkForwardConfig"));
        if !frame.dates.is_empty() && frame.dates.len() < minimum_train {
            warnings.push("walk-forward가 없고 표본 수가 작아 신뢰도가 낮습니다.".to_owned());
        }
    }
    let best_by_objective: Map<String, Value> = best
        .into_iter()
        .map(|(key, value)| (key.to_owned(), value.unwrap_or(Value::Null)))
        .collect();
    let mut result = json!({
        "warnings": warnings,
        "seed": seed,
        "sampledAssets": available,
        "candidateCount": sorted_candidates.len(),
        "candidates": sorted_candidates,
        "paretoFrontier": frontier,
        "bestByObjective": best_by_objective,
    });
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
    fn constraints_are_respected() {
        let result = optimize(&optimization_input()).unwrap();
        assert!(result["candidateCount"].as_u64().unwrap() > 0);
        for candidate in result["candidates"].as_array().unwrap() {
            let weight = candidate["weights"]["A"].as_f64().unwrap_or(0.0);
            assert!((0.2..=0.4).contains(&weight));
        }
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
